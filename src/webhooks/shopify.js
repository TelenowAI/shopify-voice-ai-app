// ─────────────────────────────────────────────────────────────────────────────
// webhooks/shopify.js — Shopify webhook receiver (HMAC-verified by the library).
//
// We register handler callbacks for every topic we care about via
// shopify.webhooks.addHandlers() at boot. The single Express endpoint below
// hands the RAW request body to shopify.webhooks.process(), which:
//   1) verifies the X-Shopify-Hmac-Sha256 signature against SHOPIFY_API_SECRET,
//   2) routes to the matching topic handler's callback,
//   3) writes the HTTP response (200/401/404) itself.
//
// IMPORTANT: this route must receive the raw body (string), so server.js mounts
// `express.text({ type: '*/*' })` for this path — do NOT JSON-parse first or HMAC
// verification will fail.
//
// Includes the three MANDATORY GDPR/compliance webhooks
// (customers/data_request, customers/redact, shop/redact) as required for app
// review — wired as stubs that you must complete before going public.
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';
import { DeliveryMethod, InvalidWebhookError } from '@shopify/shopify-api';

import { shopify, HOST } from '../shopify.js';
import { deleteShop, collectCustomerData, redactCustomer } from '../store.js';
import { refreshEntitlement } from '../billing.js';
import { releaseWorkspace, syncWorkspaceSpendCap } from '../provisioning.js';
import { removeTelenowHook } from './telenow.js';

import { handleAbandonedCheckout } from '../automations/abandonedCheckout.js';
import { handleCodConfirmation } from '../automations/codConfirmation.js';
import { handleLeadCallback } from '../automations/leadCallback.js';
import {
  handleOrderConfirmation,
  handleOrderShipped,
} from '../automations/orderUpdates.js';

export const shopifyWebhookRouter = express.Router();

const CALLBACK_URL = '/webhooks/shopify';

/** Topics we subscribe to. Kept in one place so auth.js can report the count. */
export const WEBHOOK_TOPICS = [
  'CHECKOUTS_CREATE',
  'CHECKOUTS_UPDATE',
  'ORDERS_CREATE',
  'ORDERS_FULFILLED',
  'CUSTOMERS_CREATE',
  'APP_UNINSTALLED',
  // Billing lifecycle: fires whenever a subscription is approved, declined,
  // frozen for a failed payment, cancelled or expired.
  'APP_SUBSCRIPTIONS_UPDATE',
  // Mandatory compliance topics (required for public app review):
  'CUSTOMERS_DATA_REQUEST',
  'CUSTOMERS_REDACT',
  'SHOP_REDACT',
];

/**
 * Safely run an automation handler in the background. We log errors but never
 * let a handler failure turn into a non-200 to Shopify (Shopify retries 4xx/5xx
 * aggressively; our work is async/best-effort, so we ACK fast and self-heal).
 */
function runHandler(name, fn) {
  Promise.resolve()
    .then(fn)
    .then((res) => {
      if (res && res.placed === false && res.reason) {
        console.log(`[webhook:${name}] skipped: ${res.reason}`);
      }
    })
    .catch((err) => console.error(`[webhook:${name}] error:`, err.message));
}

// ── Register handlers (once, at import time) ──────────────────────────────────
// Each callback receives (topic, shop, body, webhookId, apiVersion). `body` is
// the raw JSON string; we parse it ourselves.

shopify.webhooks.addHandlers({
  CHECKOUTS_CREATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: CALLBACK_URL,
    callback: (_topic, shop, body) =>
      runHandler('checkouts/create', () => handleAbandonedCheckout(shop, JSON.parse(body))),
  },
  CHECKOUTS_UPDATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: CALLBACK_URL,
    callback: (_topic, shop, body) =>
      runHandler('checkouts/update', () => handleAbandonedCheckout(shop, JSON.parse(body))),
  },
  ORDERS_CREATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: CALLBACK_URL,
    callback: (_topic, shop, body) => {
      const order = JSON.parse(body);
      // Two independent automations key off orders/create. Each is individually
      // gated by its own enabled flag in settings, so both can run or neither.
      runHandler('orders/create→cod', () => handleCodConfirmation(shop, order));
      runHandler('orders/create→confirm', () => handleOrderConfirmation(shop, order));
    },
  },
  ORDERS_FULFILLED: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: CALLBACK_URL,
    callback: (_topic, shop, body) =>
      runHandler('orders/fulfilled', () => handleOrderShipped(shop, JSON.parse(body))),
  },
  CUSTOMERS_CREATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: CALLBACK_URL,
    callback: (_topic, shop, body) =>
      runHandler('customers/create→lead', () => handleLeadCallback(shop, JSON.parse(body))),
  },

  // ── Billing lifecycle ───────────────────────────────────────────────────────
  // The payload carries the new subscription state, and we deliberately throw it
  // away: refreshEntitlement() re-reads the subscription from the Admin API and
  // writes settings.billing through the same mapping every other billing path
  // uses. One authoritative code path means the webhook, the /billing/callback
  // return and the reconciliation sweep can never disagree about what a shop is
  // entitled to — and a truncated or reordered delivery self-heals instead of
  // persisting a wrong plan until someone notices.
  //
  // THE SECOND STEP IS THE ONE THAT WAS MISSING, and its absence is why every
  // upgraded shop sat on its install-time spend ceiling forever.
  //
  // The ceiling is a COST limit — what Telenow is allowed to spend on this
  // shop's behalf — and it is derived from the plan. At install every shop is on
  // Starter, so the ceiling written at provision time is Starter's. Nothing then
  // re-sent it: this callback refreshed the entitlement and stopped, and
  // updatePartnerWorkspace had no caller anywhere in the app. A merchant who
  // upgraded to Scale therefore kept a Starter-shaped ceiling upstream, and —
  // because a non-positive requested cap is read upstream as "no ceiling of my
  // own" — a shop provisioned with Starter's zero inherited the partner's WHOLE
  // budget instead. Either way the number upstream stopped describing the
  // merchant the moment their plan changed.
  //
  // So the ceiling is re-sent here, on every subscription transition Shopify
  // tells us about: upgrade, downgrade, freeze for a failed payment, cancel,
  // expiry. It runs AFTER the refresh and not in parallel with it, because
  // syncWorkspaceSpendCap reads the entitlement back out of the store — racing
  // the two would push the ceiling for the plan the shop just LEFT.
  //
  // syncWorkspaceSpendCap never throws by contract (it no-ops for shops with no
  // partner-provisioned workspace, which is most of them), so a failure upstream
  // cannot turn this delivery into a non-200 and start a Shopify retry storm.
  // The awaited chain inside one runHandler is belt-and-braces on top of that:
  // if the contract is ever broken, the rejection lands in runHandler's catch
  // and is logged, exactly like every other handler failure here.
  APP_SUBSCRIPTIONS_UPDATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: CALLBACK_URL,
    callback: (_topic, shop) =>
      runHandler('app_subscriptions/update', async () => {
        await refreshEntitlement(shop);
        await syncWorkspaceSpendCap(shop);
      }),
  },

  // ── App lifecycle ───────────────────────────────────────────────────────────
  APP_UNINSTALLED: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: CALLBACK_URL,
    callback: (_topic, shop) => {
      console.log(`[webhook] app uninstalled by ${shop} — cleaning up`);
      // ORDERING IS LOAD-BEARING, and this used to be a race.
      //
      // deleteShop() wipes db.settings[shop], and the two steps before it both
      // read from there: removeTelenowHook() needs settings.telenowApiKey to
      // authenticate the upstream delete, and releaseWorkspace() needs
      // settings.telenowWorkspaceRef to know which pool entry to reclaim. Firing
      // them through separate fire-and-forget runHandler() calls and then
      // deleting synchronously meant deleteShop usually won the race, so the
      // hook leaked upstream and — once workspaces come from a finite pool — the
      // entry was stranded as leased forever, with no ref left anywhere to
      // reclaim it by. One awaited chain instead, and only then the purge.
      //
      // removeTelenowHook's failure is swallowed rather than allowed to abort
      // the chain: a stale upstream hook is untidy, but skipping the release and
      // the data purge because of it is worse on both counts.
      runHandler('app/uninstalled', async () => {
        await removeTelenowHook(shop).catch(() => {});
        await releaseWorkspace(shop);
        deleteShop(shop);
      });
    },
  },

  // ── Mandatory GDPR / privacy compliance webhooks ──────────────────────────────
  // Shopify requires all three for public app approval. They are HMAC-verified by
  // the same process() path (a bad signature never reaches these callbacks).
  //
  // What this app holds at rest: call METADATA only (sessionId → { shop, orderId,
  // automation }) + per-shop settings/OAuth token/hook secret — NOT the shopper's
  // phone or transcript. The voice recording/transcript lives in Telenow, so for
  // full erasure the merchant/app must also redact on the Telenow side (TODOs).
  CUSTOMERS_DATA_REQUEST: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: CALLBACK_URL,
    callback: (_topic, shop, body) => {
      const payload = safeParse(body) || {};
      const data = collectCustomerData(shop, payload.orders_requested, payload?.customer?.id);
      // Shopify requires the data be delivered to the MERCHANT (out of band)
      // within 30 days — not in this HTTP response. We surface what we hold here.
      console.log(
        `[gdpr] customers/data_request shop=${shop} customer=${payload?.customer?.id}: ` +
          `${data.calls.length} local call record(s) held. Voice recordings/transcripts ` +
          `are held by Telenow — direct the customer to Telenow's data-subject process.`,
      );
      // TODO(production): deliver `data` to the merchant (email/dashboard) within
      // 30 days, and forward the request to Telenow for recordings/transcripts.
    },
  },
  CUSTOMERS_REDACT: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: CALLBACK_URL,
    callback: (_topic, shop, body) => {
      const payload = safeParse(body) || {};
      const removed = redactCustomer(shop, payload.orders_to_redact, payload?.customer?.id);
      console.log(
        `[gdpr] customers/redact shop=${shop} customer=${payload?.customer?.id}: ` +
          `erased ${removed} local call record(s).`,
      );
      // TODO(production): also call Telenow to redact any voice recordings /
      // transcripts for this customer's sessions.
    },
  },
  SHOP_REDACT: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: CALLBACK_URL,
    callback: (_topic, shop) => {
      // Fired 48h after a shop uninstalls: erase ALL data for the shop. deleteShop
      // purges shops/settings/hooks/callMap/attempts; we also drop the Telenow hook.
      console.log(`[gdpr] shop/redact shop=${shop} — purging all shop data`);
      // Same awaited chain, same reason, as APP_UNINSTALLED above: every step
      // before deleteShop() reads the settings row deleteShop() destroys.
      //
      // releaseWorkspace() is a backstop here, not a duplicate. Normally the
      // uninstall 48 hours earlier already quarantined the entry and this is a
      // no-op, but shop/redact is the one delivery Shopify guarantees for a
      // departing shop — if the uninstall webhook was never delivered or failed
      // outright, this is the last moment a leased pool entry can still be
      // reclaimed by ref before the settings row is gone.
      runHandler('shop/redact', async () => {
        await removeTelenowHook(shop).catch(() => {});
        await releaseWorkspace(shop);
        deleteShop(shop);
      });
      // TODO(production): also request Telenow delete this shop's call data.
    },
  },
});

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ── The receiver endpoint ─────────────────────────────────────────────────────
// Mounted at CALLBACK_URL in server.js, so the inner route is '/'. server.js also
// applies express.text({ type: '*/*' }) for this path so req.body is the raw
// string. shopify.webhooks.process() does HMAC + routing + the HTTP response.
shopifyWebhookRouter.post('/', async (req, res) => {
  // A request with no signature is unauthenticated, not malformed. process()
  // answers 400 when the header is absent, and Shopify's "verifies webhooks
  // with HMAC signatures" check posts exactly that and requires a 401.
  if (!req.get('X-Shopify-Hmac-Sha256')) {
    res.status(401).send('Unauthorized: missing HMAC signature');
    return;
  }
  try {
    await shopify.webhooks.process({
      rawBody: typeof req.body === 'string' ? req.body : req.body?.toString('utf8') ?? '',
      rawRequest: req,
      rawResponse: res,
    });
  } catch (err) {
    // process() normally writes the response; if it threw before that, respond.
    // An HMAC failure is a rejected request, so it must not surface as a 500.
    console.error('[webhook] process error:', err.message);
    if (res.headersSent) return;
    const unauthorized = err instanceof InvalidWebhookError
      || /hmac|signature|unauthoriz/i.test(err.message || '');
    res.status(unauthorized ? 401 : 500).send(unauthorized ? 'Unauthorized' : err.message);
  }
});

/** Exposed so other modules / docs can reference the absolute callback URL. */
export const SHOPIFY_WEBHOOK_URL = `${HOST}${CALLBACK_URL}`;
