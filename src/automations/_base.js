// ─────────────────────────────────────────────────────────────────────────────
// automations/_base.js — shared plumbing for all automations.
//
// Each automation module builds a `variables` object from a Shopify payload and
// calls `placeCall(...)`, which centralizes the cross-cutting concerns:
//   - load per-shop settings + the automation's config
//   - skip if disabled / not entitled to spend / no calling workspace / no agent
//   - normalize the phone number to E.164
//   - enforce quiet hours
//   - apply a delay (scheduled via setTimeout — see note)
//   - call Telenow and persist sessionId → order for the result webhook
//
// DELAY NOTE: we implement "delay" with an in-process setTimeout for simplicity.
// This is fine for a demo but does NOT survive a restart and won't scale across
// instances. TODO: replace with a durable job queue (BullMQ/Redis, SQS, or a
// DB-backed scheduler) in production.
// ─────────────────────────────────────────────────────────────────────────────

import { checkAccess } from '../billing.js';
import { ensureWorkspace } from '../provisioning.js';
import { getSettings } from '../settings.js';
import { mapCall, markAttempt, clearAttempt } from '../store.js';
import { TelenowClient } from '../telenow.js';
import { extractPhone, resolveCountry } from '../util/phone.js';
import { isQuietNow } from '../util/quietHours.js';

/**
 * @typedef {Object} PlaceCallArgs
 * @property {string} shop            Shopify shop domain.
 * @property {string} automation      Automation key (matches settings.automations).
 * @property {object} entity          The Shopify payload (order/checkout) to pull a phone from.
 * @property {object} variables       Context strings passed to the Telenow agent.
 * @property {string} identifier      Correlation id (order/customer id) echoed back by Telenow.
 * @property {object} [mapExtra]      Extra fields to persist on the callMap entry (e.g. orderId).
 * @property {string} [phoneOverride] Explicit E.164 to call instead of extracting from `entity`.
 */

/**
 * Place a call for an automation, applying all gating rules.
 * @param {PlaceCallArgs} args
 * @returns {Promise<{ placed: boolean, reason?: string, sessionId?: string }>}
 */
export async function placeCall(args) {
  const { shop, automation, entity, variables, identifier, mapExtra = {}, phoneOverride } = args;

  const settings = getSettings(shop);
  const cfg = settings.automations[automation];

  if (!cfg) return skip(`unknown automation "${automation}"`);
  if (!cfg.enabled) return skip(`automation "${automation}" disabled`);

  // Every automated call in the app converges here — the five webhook
  // automations, the three scheduled sweeps, and the unauthenticated carrier
  // NDR endpoint — so this is the one place that can guarantee no automation
  // ever spends past what the merchant approved on Shopify's own billing
  // screen. The merchant no longer supplies an API key; entitlement decides
  // whether we may spend, and the workspace is provisioned server-side.
  //
  // A blocked answer is a skip, not a throw: the callers are webhook handlers
  // and cron sweeps, and Shopify must still get its fast 200. `gate.body.error`
  // is one of the five machine-readable codes, which runHandler already logs.
  const gate = await checkAccess(shop, 'spend');
  if (!gate.ok) return skip(`billing: ${gate.body.error}`);

  // Null means the pool is exhausted or Telenow is unreachable — a transient
  // operational state, never a billing verdict, so it must not read as a
  // paywall anywhere downstream.
  const key = await ensureWorkspace(shop);
  if (!key) return skip('calling workspace not ready');

  if (!cfg.agentId) return skip(`no agentId configured for "${automation}"`);

  // Resolve + normalize the phone number.
  //
  // The country used to complete a local number is resolved PER SHOP, at call
  // time. It used to be a module-level constant read once from
  // DEFAULT_PHONE_COUNTRY, and that is wrong for the shape of this server: one
  // process serves every installed store, so an Indian store and a Canadian
  // store share the constant and one of them is always wrong. The failure is
  // silent, which is what makes it expensive — a Toronto shopper's "416 555
  // 0134" prefixed with +91 is still a well-formed E.164 string, so it sails
  // through validation, reaches the carrier, and simply never connects. There
  // is no error to see anywhere: the merchant reads it as "the AI didn't call".
  //
  // resolveCountry() owns the precedence rule (explicit → the shop's own
  // country from Shopify → DEFAULT_PHONE_COUNTRY as an instance-wide hint →
  // 'US'). `settings` is the row already loaded at the top of this function;
  // re-reading it here would only race with itself. A null shopCountry means
  // "not resolved yet", never India — the resolver decides what that falls back
  // to, and no caller may second-guess it.
  //
  // It takes a NAMED-OPTIONS object, and every field must be passed by name.
  // Handing it the bare ISO-2 string is not a near-miss that degrades to a
  // reasonable answer: destructuring a string yields undefined for every field,
  // so the shop's real country is discarded and every call silently falls
  // through to 'US'; destructuring the null this row holds before Shopify has
  // been queried throws outright, and because this line sits above the try
  // below, the throw escapes placeCall into runHandler, which turns it into a
  // console.error while Shopify still gets its 200. That is the same invisible
  // failure the per-shop resolution was introduced to kill, only with the
  // polarity reversed — so pass the object, and keep passing it here.
  const country = resolveCountry({
    shopCountry: settings?.shopCountry,
    envDefault: process.env.DEFAULT_PHONE_COUNTRY,
  });
  const mobileNumber = phoneOverride || extractPhone(entity, country);
  if (!mobileNumber) return skip('no valid phone number on payload');

  // Quiet-hours guard.
  if (isQuietNow(cfg.quietHours)) {
    // TODO: instead of skipping, enqueue for nextWindowEnd() with a durable queue.
    return skip('within quiet hours');
  }

  // Dedupe guard: Shopify redelivers webhooks (and checkouts/update fires many
  // times per cart), so refuse to place a second call for the same entity+
  // automation within the TTL. Atomic check-and-set in the store. We clear the
  // mark if the placement itself fails, so a genuine retry can still go through.
  const dedupeKey = identifier ? `${automation}:${shop}:${identifier}` : null;
  if (dedupeKey && !markAttempt(dedupeKey)) {
    return skip('duplicate — already attempted for this entity');
  }

  // delaySeconds wins when set, so a template can schedule a confirmation call
  // a minute after the order rather than being stuck on whole minutes.
  // delayMinutes stays the fallback so existing settings keep working.
  const delayMs = cfg.delaySeconds != null
    ? Math.max(0, Number(cfg.delaySeconds) || 0) * 1000
    : Math.max(0, Number(cfg.delayMinutes) || 0) * 60 * 1000;

  // The actual call-placing closure (run now or after the delay). The workspace
  // key is a parameter rather than a captured constant because the deferred
  // branch re-resolves it at fire time — see the comment on deferredFire.
  const fire = async (apiKey) => {
    try {
      const client = new TelenowClient(apiKey);
      const result = await client.initiateCall({
        agentId: cfg.agentId,
        mobileNumber,
        variables,
        identifier,
        machineDetection: 'hangup',
      });
      if (result?.sessionId) {
        // Persist so the result webhook can find the order. Carry the automation
        // so the webhook knows which write-back behavior to apply.
        mapCall(result.sessionId, { shop, automation, identifier, ...mapExtra });
      }
      console.log(
        `[${automation}] call placed shop=${shop} session=${result?.sessionId} → ${redactPhone(
          mobileNumber,
        )}`,
      );
      return result;
    } catch (err) {
      // Placement failed → release the dedupe mark so a genuine retry (Shopify
      // redelivery or a later sweep) can attempt again instead of being blocked.
      if (dedupeKey) clearAttempt(dedupeKey);
      console.error(`[${automation}] call failed shop=${shop}:`, err.message);
      throw err;
    }
  };

  if (delayMs > 0) {
    // The async half of the deferred path, extracted so the timer callback has
    // exactly one promise to attach a catch to.
    //
    // Entitlement is re-checked HERE and not only at schedule time because the
    // delay is long enough for the answer to change: an abandoned-checkout call
    // waits thirty minutes, and inside that window the merchant can cancel the
    // subscription, exhaust the free allowance on a parallel call, or hit the
    // usage cap they approved. Firing anyway spends money the merchant is no
    // longer agreeing to — precisely what the billing rules forbid, and what
    // this code did before the gate existed.
    //
    // The workspace key is re-resolved for the same reason: the lease is
    // revalidated on a 24h cycle and can be retired while this timer pends, so
    // the key captured at schedule time may already be dead.
    const deferredFire = async () => {
      const gate2 = await checkAccess(shop, 'spend');
      if (!gate2.ok) {
        console.log(`[${automation}] skipped at fire time: billing: ${gate2.body.error}`);
        if (dedupeKey) clearAttempt(dedupeKey);
        return;
      }
      const freshKey = await ensureWorkspace(shop);
      if (!freshKey) {
        console.log(`[${automation}] skipped at fire time: calling workspace not ready`);
        if (dedupeKey) clearAttempt(dedupeKey);
        return;
      }
      // For abandoned checkout, the caller passes a `shouldStillCall` predicate
      // via mapExtra to re-check conversion right before firing. A predicate
      // that throws is inconclusive, not a "yes" — we stay silent rather than
      // call a customer who may already have converted.
      if (typeof mapExtra.shouldStillCall === 'function') {
        let stillCall;
        try {
          stillCall = await mapExtra.shouldStillCall();
        } catch (e) {
          console.error(`[${automation}] precheck error:`, e.message);
          return;
        }
        if (!stillCall) {
          console.log(`[${automation}] skipped: condition no longer holds`);
          return;
        }
      }
      await fire(freshKey);
    };

    // Fire-and-forget after the delay. We return immediately with placed:false-
    // but-scheduled so the webhook handler can ACK Shopify fast.
    setTimeout(() => {
      // Re-check enabled + quiet hours at fire time (config may have changed).
      const fresh = getSettings(shop).automations[automation];
      if (!fresh?.enabled) {
        console.log(`[${automation}] skipped at fire time: disabled`);
        if (dedupeKey) clearAttempt(dedupeKey);
        return;
      }
      if (isQuietNow(fresh.quietHours)) {
        console.log(`[${automation}] skipped at fire time: quiet hours`);
        if (dedupeKey) clearAttempt(dedupeKey);
        return;
      }
      // Nothing is awaiting this timer, so the rejection has to be swallowed
      // here or it becomes an unhandled rejection that can take the process
      // down. fire() has already logged and released the dedupe mark by then.
      deferredFire().catch((e) => {
        console.error(`[${automation}] deferred fire error:`, e?.message || e);
      });
    }, delayMs);
    return { placed: false, reason: `scheduled in ${Math.round(delayMs / 1000)}s` };
  }

  const result = await fire(key);
  return { placed: true, sessionId: result?.sessionId };
}

function skip(reason) {
  return { placed: false, reason };
}

/** Mask the middle of a phone number for logs (never log full PII). */
function redactPhone(e164) {
  if (!e164 || e164.length < 6) return '***';
  return `${e164.slice(0, 3)}***${e164.slice(-3)}`;
}

// ── Small formatting helpers shared by automations ───────────────────────────

// The grouping locale is pinned rather than left to the host. Passing `undefined`
// resolves to whatever locale the server process happens to run under, so the
// same order would be spoken as "$1,234.56" from one box and "$1,23,456.78" from
// another — a deploy-environment detail leaking into what a shopper hears. The
// currency code carries the identity of the money; the locale only decides the
// grouping, so a fixed, currency-neutral English locale is the honest default.
const MONEY_LOCALE = 'en-US';

/**
 * Human-readable money like "$1,299.00" or "1299.00 USD" (best-effort).
 *
 * Returns an EMPTY STRING when there is no amount or no currency, and that is
 * the point of the function. This value is handed to the voice agent as a call
 * variable and read aloud to the shopper, and it is what the merchant sees in
 * the transcript. A caller with nothing to say (winBack has no last-order total
 * for a lapsed customer) must produce silence — the earlier behaviour defaulted
 * the currency to rupees and Number(null) to zero, so it spoke a confident
 * formatted zero, in the wrong currency, at every one of them.
 *
 * There is no fallback currency for the same reason: the store's own currency is
 * the only correct one, so a missing code renders nothing rather than guessing.
 *
 * @param {number|string|null|undefined} amount
 * @param {string|null|undefined} currency ISO 4217 code from the Shopify payload.
 * @returns {string}
 */
export function formatMoney(amount, currency) {
  if (amount == null || amount === '') return '';
  const code = String(currency ?? '').trim();
  if (!code) return '';

  const num = Number(amount);
  if (!Number.isFinite(num)) return '';

  try {
    return new Intl.NumberFormat(MONEY_LOCALE, { style: 'currency', currency: code }).format(num);
  } catch {
    // Intl rejects a currency code it does not recognise. The amount is still
    // real, so say it plainly with the code appended rather than dropping it.
    return `${num.toFixed(2)} ${code}`;
  }
}

/** Compact "2× Blue Tee, 1× Mug" summary from Shopify line_items. */
export function summarizeLineItems(lineItems = [], max = 5) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return '';
  const parts = lineItems
    .slice(0, max)
    .map((li) => `${li.quantity || 1}× ${li.title || li.name || 'item'}`);
  const extra = lineItems.length - max;
  return extra > 0 ? `${parts.join(', ')} and ${extra} more` : parts.join(', ');
}

/**
 * The delivery address as a person would read it aloud.
 *
 * Shopify splits it across six fields and any of them can be blank, so the
 * empties are dropped rather than read as pauses. The pincode is kept last and
 * always included when present — it is the part that actually decides whether
 * the parcel arrives.
 * @param {object} order
 * @returns {string}
 */
export function formatAddress(order) {
  const a = order?.shipping_address || order?.billing_address || order?.customer?.default_address;
  if (!a) return '';
  return [a.address1, a.address2, a.city, a.province, a.zip, a.country]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(', ');
}

/** Total units across the order — what "is that two of them?" checks against. */
export function totalQuantity(order) {
  const items = Array.isArray(order?.line_items) ? order.line_items : [];
  return items.reduce((n, li) => n + (Number(li?.quantity) || 0), 0);
}

/**
 * Line items with their quantities spelled out, e.g. "2 x Blue Kurta, 1 x Scarf".
 * summarizeLineItems collapses quantity, which is the one thing this agent has
 * to read back.
 */
export function itemsWithQuantity(order, max = 5) {
  const items = Array.isArray(order?.line_items) ? order.line_items : [];
  const parts = items.slice(0, max).map((li) => {
    const q = Number(li?.quantity) || 1;
    const title = String(li?.title || li?.name || 'item').trim();
    return q > 1 ? `${q} x ${title}` : title;
  });
  if (items.length > max) parts.push(`and ${items.length - max} more`);
  return parts.join(', ');
}

/** First name from a Shopify customer/billing/shipping object. */
export function firstName(entity) {
  return (
    entity?.customer?.first_name ||
    entity?.billing_address?.first_name ||
    entity?.shipping_address?.first_name ||
    entity?.first_name ||
    'there'
  );
}
