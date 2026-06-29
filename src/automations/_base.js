// ─────────────────────────────────────────────────────────────────────────────
// automations/_base.js — shared plumbing for all automations.
//
// Each automation module builds a `variables` object from a Shopify payload and
// calls `placeCall(...)`, which centralizes the cross-cutting concerns:
//   - load per-shop settings + the automation's config
//   - skip if disabled / no agent / no API key
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

import { getSettings } from '../settings.js';
import { mapCall, markAttempt, clearAttempt } from '../store.js';
import { TelenowClient } from '../telenow.js';
import { extractPhone } from '../util/phone.js';
import { isQuietNow } from '../util/quietHours.js';

/** Default country used for E.164 normalization when a number has no country code. */
const DEFAULT_COUNTRY = process.env.DEFAULT_PHONE_COUNTRY || 'IN';

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
  if (!settings.telenowApiKey) return skip('no Telenow API key configured');
  if (!cfg.agentId) return skip(`no agentId configured for "${automation}"`);

  // Resolve + normalize the phone number.
  const mobileNumber = phoneOverride || extractPhone(entity, DEFAULT_COUNTRY);
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

  const delayMs = Math.max(0, Number(cfg.delayMinutes) || 0) * 60 * 1000;

  // The actual call-placing closure (run now or after the delay).
  const fire = async () => {
    try {
      const client = new TelenowClient(settings.telenowApiKey);
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
      // For abandoned checkout, the caller passes a `shouldStillCall` predicate
      // via mapExtra to re-check conversion right before firing.
      if (typeof mapExtra.shouldStillCall === 'function') {
        Promise.resolve(mapExtra.shouldStillCall())
          .then((ok) => (ok ? fire() : console.log(`[${automation}] skipped: condition no longer holds`)))
          .catch((e) => console.error(`[${automation}] precheck error:`, e.message));
        return;
      }
      fire().catch(() => {});
    }, delayMs);
    return { placed: false, reason: `scheduled in ${cfg.delayMinutes}m` };
  }

  const result = await fire();
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

/** Human-readable money like "₹1,299.00" or "1299.00 USD" (best-effort). */
export function formatMoney(amount, currency) {
  const num = Number(amount);
  if (Number.isNaN(num)) return `${amount ?? ''} ${currency ?? ''}`.trim();
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR' }).format(
      num,
    );
  } catch {
    return `${num.toFixed(2)} ${currency || ''}`.trim();
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
