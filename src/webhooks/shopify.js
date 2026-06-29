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
import { DeliveryMethod } from '@shopify/shopify-api';

import { shopify, HOST } from '../shopify.js';
import { deleteShop, collectCustomerData, redactCustomer } from '../store.js';
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

  // ── App lifecycle ───────────────────────────────────────────────────────────
  APP_UNINSTALLED: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: CALLBACK_URL,
    callback: (_topic, shop) => {
      console.log(`[webhook] app uninstalled by ${shop} — cleaning up`);
      // Best-effort: remove our Telenow hook for this shop, then purge local data.
      runHandler('app/uninstalled→telenow-cleanup', () => removeTelenowHook(shop));
      deleteShop(shop);
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
      runHandler('shop/redact→telenow-cleanup', () => removeTelenowHook(shop));
      deleteShop(shop);
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
  try {
    await shopify.webhooks.process({
      rawBody: typeof req.body === 'string' ? req.body : req.body?.toString('utf8') ?? '',
      rawRequest: req,
      rawResponse: res,
    });
  } catch (err) {
    // process() normally writes the response; if it threw before that, respond.
    console.error('[webhook] process error:', err.message);
    if (!res.headersSent) res.status(500).send(err.message);
  }
});

/** Exposed so other modules / docs can reference the absolute callback URL. */
export const SHOPIFY_WEBHOOK_URL = `${HOST}${CALLBACK_URL}`;
