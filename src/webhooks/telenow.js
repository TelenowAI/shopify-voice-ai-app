// ─────────────────────────────────────────────────────────────────────────────
// webhooks/telenow.js — receive Telenow call-result webhooks + write back to Shopify.
//
// Inbound from Telenow → this app:
//   headers: X-VoiceAI-Signature: sha256=<hex HMAC-SHA256 of raw body>
//            X-VoiceAI-Event:     call.ended | call.analyzed
//            X-VoiceAI-Delivery:  <uuid>
//   body (call.ended / call.analyzed):
//     { event_type, session_id, agent_id, status, duration, from_number,
//       to_number, ended_at, transcript?, analysis? }
//
// We verify the HMAC over the RAW body using the signing secret returned when we
// created the hook (persisted per-shop in the store). We try the secret of the
// shop that owns the originating call (looked up via session_id→order map); if
// the call isn't found, we fall back to trying all known shop secrets.
//
// Write-back:
//   - COD confirmation result → tag telenow-cod-confirmed / telenow-cod-cancelled
//   - any call → append a note + a "telenow_last_call" metafield with outcome
//
// Also exports ensureTelenowHook()/removeTelenowHook() used at install + settings.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import express from 'express';

import { HOST, addOrderTags, appendOrderNote, setOrderMetafield } from '../shopify.js';
import { getSettings } from '../settings.js';
import {
  getHook,
  saveHook,
  deleteHook,
  getCall,
  deleteCall,
  listShops,
  updateLead,
} from '../store.js';
import { TelenowClient } from '../telenow.js';

export const telenowWebhookRouter = express.Router();

const WEBHOOK_PATH = '/telenow/webhook';

/** Absolute URL Telenow should POST results to (used when creating the hook). */
export const TELENOW_WEBHOOK_URL = `${HOST}${WEBHOOK_PATH}`;

// ─────────────────────────────────────────────────────────────────────────────
// Hook lifecycle (subscribe / unsubscribe to Telenow result webhooks)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure this shop has exactly one Telenow webhook subscription pointing at us,
 * and persist its signing secret. Idempotent: reuses an existing matching hook.
 * Call this after the merchant saves their API key.
 * @param {string} shop
 */
export async function ensureTelenowHook(shop) {
  const settings = getSettings(shop);
  if (!settings.telenowApiKey) throw new Error('No Telenow API key set for shop');

  const client = new TelenowClient(settings.telenowApiKey);

  // If we already have a stored hook whose targetUrl still matches, keep it.
  const existingLocal = getHook(shop);

  // Check Telenow's side for a shopify-source hook pointing at our URL.
  let remote = [];
  try {
    remote = await client.listHooks('shopify');
  } catch (err) {
    console.error(`[telenow] listHooks failed for ${shop}:`, err.message);
  }
  // Hook fields from the list endpoint are snake_case (target_url).
  const match = (remote || []).find((h) => h.target_url === TELENOW_WEBHOOK_URL);

  if (match && existingLocal?.id === match.id && existingLocal?.secret) {
    return existingLocal; // already wired and we have the secret
  }

  // If there's a remote match but we lost the secret, we must recreate it (the
  // secret is only returned at creation time). Delete the stale one first.
  if (match) {
    try {
      await client.deleteHook(match.id);
    } catch (err) {
      console.error(`[telenow] could not delete stale hook ${match.id}:`, err.message);
    }
  }

  const created = await client.createHook({
    targetUrl: TELENOW_WEBHOOK_URL,
    events: ['call.ended', 'call.analyzed'],
    source: 'shopify',
    includeTranscript: true,
  });
  // The signing secret is only returned at creation. Prefer signing_secret;
  // the backend also returns it as `secret` for backward compatibility.
  const signingSecret = created?.signing_secret ?? created?.secret;
  if (!signingSecret) {
    throw new Error('Telenow createHook did not return a signing secret');
  }
  saveHook(shop, { id: created.id, secret: signingSecret });
  console.log(`[telenow] hook created for ${shop} (id=${created.id})`);
  return getHook(shop);
}

/** Remove this shop's Telenow webhook subscription (on uninstall / key change). */
export async function removeTelenowHook(shop) {
  const local = getHook(shop);
  const settings = getSettings(shop);
  if (local?.id && settings.telenowApiKey) {
    try {
      const client = new TelenowClient(settings.telenowApiKey);
      await client.deleteHook(local.id);
    } catch (err) {
      console.error(`[telenow] deleteHook failed for ${shop}:`, err.message);
    }
  }
  deleteHook(shop);
}

// ─────────────────────────────────────────────────────────────────────────────
// Signature verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify X-VoiceAI-Signature ("sha256=<hex>") over the raw body with a secret.
 * Telenow emits HMAC-SHA256 hex-encoded (backend webhook_worker.rs uses
 * hex::encode; the server-node SDK verifies hex). We compare against hex and,
 * defensively, base64 — using a constant-time comparison for each candidate.
 * @param {string} rawBody  exact bytes received
 * @param {string} header   value of X-VoiceAI-Signature
 * @param {string} secret   hook signing secret
 * @returns {boolean}
 */
export function verifyTelenowSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const provided = header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
  const mac = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  // Canonical is hex; base64 kept as a belt-and-braces fallback.
  return [mac.toString('hex'), mac.toString('base64')].some((expected) => {
    try {
      const a = Buffer.from(provided);
      const b = Buffer.from(expected);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  });
}

/**
 * Resolve which shop/secret a delivery belongs to and verify it.
 * Strategy: if we can match the call by session_id, use that shop's secret;
 * otherwise brute-force across all stored secrets (small N) so we still verify.
 * @param {string} rawBody
 * @param {string} sigHeader
 * @param {object} payload  parsed body (for session_id)
 * @returns {{ shop: string, call?: object } | null}
 */
function authenticateDelivery(rawBody, sigHeader, payload) {
  // 1) Preferred: locate by the call we placed.
  const call = payload?.session_id ? getCall(payload.session_id) : undefined;
  if (call?.shop) {
    const hook = getHook(call.shop);
    if (hook?.secret && verifyTelenowSignature(rawBody, sigHeader, hook.secret)) {
      return { shop: call.shop, call };
    }
  }
  // 2) Fallback: try every stored secret (handles calls not in the map, e.g.
  //    after a restart dropped the in-memory map). Returns the first shop whose
  //    secret validates. N = installed shops, so this stays small.
  for (const { shop } of listShops()) {
    const hook = getHook(shop);
    if (hook?.secret && verifyTelenowSignature(rawBody, sigHeader, hook.secret)) {
      // Defense: never write one tenant's session under another. If the
      // session-matched call belongs to a different shop, drop it.
      return { shop, call: call?.shop === shop ? call : undefined };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The receiver endpoint
// ─────────────────────────────────────────────────────────────────────────────
// Mounted at WEBHOOK_PATH in server.js, so the inner route is '/'. server.js also
// applies express.text({ type: '*/*' }) for this path so req.body is the raw
// string we must HMAC. Always ACK 2xx once authenticated so Telenow doesn't
// retry; do the Shopify write-back asynchronously.

telenowWebhookRouter.post('/', async (req, res) => {
  const rawBody = typeof req.body === 'string' ? req.body : req.body?.toString('utf8') ?? '';
  const sig = req.get('X-VoiceAI-Signature');
  const eventHeader = req.get('X-VoiceAI-Event');

  let payload;
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch {
    res.status(400).send('invalid JSON');
    return;
  }

  const auth = authenticateDelivery(rawBody, sig, payload);
  if (!auth) {
    // Either no matching secret or bad signature → reject.
    console.warn(`[telenow] signature verification failed (event=${eventHeader})`);
    res.status(401).send('invalid signature');
    return;
  }

  // ACK immediately; process write-back in the background.
  res.status(200).json({ ok: true });

  handleResult(auth.shop, auth.call, payload).catch((err) =>
    console.error(`[telenow] write-back failed for ${auth.shop}:`, err.message),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Outcome → Shopify write-back
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply the call outcome to the originating Shopify order.
 * @param {string} shop
 * @param {object|undefined} call  the persisted callMap entry (has orderId/automation)
 * @param {object} payload         the Telenow webhook body
 */
async function handleResult(shop, call, payload) {
  const eventType = payload.event_type || '';
  const sessionId = payload.session_id;

  // ── Lead callback: write back to the lead row, not an order ──────────────────
  // Resolve a leadId from the persisted callMap entry, or by parsing the
  // "lead:<id>" identifier we sent. Lead sessions never have an order to tag.
  let leadId = call?.leadId;
  if (!leadId) {
    const id = parseIdentifier(payload.identifier);
    if (id?.type === 'lead') leadId = id.value;
  }
  if (leadId) {
    updateLead(shop, leadId, {
      status: 'completed',
      disposition: readDisposition(payload),
      summary: payload.analysis?.summary || '',
      duration: payload.duration ?? null,
      sessionId: payload.session_id || null,
    });
    console.log(`[telenow] wrote back lead=${leadId} shop=${shop}`);
    cleanupIfFinal(eventType, sessionId);
    return;
  }

  // Resolve the order id. Prefer the persisted map; fall back to parsing the
  // identifier we sent (e.g. "order:12345").
  let orderId = call?.orderId;
  const automation = call?.automation;
  if (!orderId) {
    const id = parseIdentifier(payload.identifier);
    if (id?.type === 'order') orderId = id.value;
  }

  // We only write back when we know the order. Checkout-based automations
  // (abandoned cart) usually have no order yet, so we just log those.
  if (!orderId) {
    console.log(
      `[telenow] result for session=${sessionId} automation=${automation || '?'} ` +
        `has no order to write back (likely a checkout/customer call) — logged only`,
    );
    cleanupIfFinal(eventType, sessionId);
    return;
  }

  const disposition = readDisposition(payload);
  const summary = payload.analysis?.summary || '';
  const durationLine = payload.duration ? ` (${payload.duration}s)` : '';

  // ── COD-specific tagging ────────────────────────────────────────────────────
  if (automation === 'codConfirmation') {
    if (disposition === 'confirmed') {
      await addOrderTags(shop, orderId, 'telenow-cod-confirmed');
      await appendOrderNote(
        shop,
        orderId,
        `Telenow: COD CONFIRMED by customer${durationLine}.${summary ? ' ' + summary : ''}`,
      );
    } else if (disposition === 'cancelled') {
      await addOrderTags(shop, orderId, 'telenow-cod-cancelled');
      await appendOrderNote(
        shop,
        orderId,
        `Telenow: COD CANCELLED/refused by customer${durationLine}.${summary ? ' ' + summary : ''}`,
      );
      // TODO (optional): auto-cancel the order here via POST /orders/{id}/cancel.json
      // We deliberately DO NOT auto-cancel — merchant reviews the tag first.
    } else {
      await addOrderTags(shop, orderId, 'telenow-cod-no-response');
      await appendOrderNote(
        shop,
        orderId,
        `Telenow: COD call completed, no clear confirmation${durationLine}.${
          summary ? ' ' + summary : ''
        }`,
      );
    }
  } else {
    // ── Generic outcome note for non-COD automations ──────────────────────────
    const label = automation ? `[${automation}] ` : '';
    await appendOrderNote(
      shop,
      orderId,
      `Telenow ${label}call ${payload.status || 'completed'}${durationLine}.${
        summary ? ' ' + summary : ''
      }`,
    );
  }

  // ── Structured metafield for theme/app access (best-effort) ──────────────────
  try {
    await setOrderMetafield(
      shop,
      orderId,
      'last_call',
      JSON.stringify({
        session_id: sessionId,
        status: payload.status,
        disposition,
        duration: payload.duration,
        ended_at: payload.ended_at,
      }),
      'json',
    );
  } catch (err) {
    // Metafield write is non-critical; log and continue.
    console.error(`[telenow] metafield write failed for order ${orderId}:`, err.message);
  }

  console.log(
    `[telenow] wrote back order=${orderId} automation=${automation || '?'} disposition=${disposition}`,
  );

  cleanupIfFinal(eventType, sessionId);
}

/** Drop the session→order mapping once we've seen a terminal event. */
function cleanupIfFinal(eventType, sessionId) {
  // call.analyzed is the richest/last event; clean up after it. If only
  // call.ended arrives (no analysis configured), the entry will be GC'd by a
  // future store cleanup — acceptable for the file stub.
  if (eventType === 'call.analyzed' && sessionId) deleteCall(sessionId);
}

/**
 * Map Telenow's analysis to a COD decision. Telenow's `analysis` may carry a
 * disposition/summary; we look at a few likely fields and keyword-match the
 * summary as a fallback.
 * @param {object} payload
 * @returns {'confirmed'|'cancelled'|'unknown'}
 */
function readDisposition(payload) {
  const a = payload.analysis || {};
  const raw = String(
    a.disposition || a.outcome || a.result || a.label || '',
  ).toLowerCase();

  if (/(confirm|accept|yes|approved|will take|keep)/.test(raw)) return 'confirmed';
  if (/(cancel|refus|reject|decline|no longer|don'?t want|return)/.test(raw)) return 'cancelled';

  // Fallback: scan the summary text.
  const summary = String(a.summary || payload.transcript || '').toLowerCase();
  if (summary) {
    if (/(confirmed the order|wants to keep|will accept|happy to pay)/.test(summary)) {
      return 'confirmed';
    }
    if (/(cancel|does not want|refused|won'?t accept|return it)/.test(summary)) {
      return 'cancelled';
    }
  }
  return 'unknown';
}

/** Parse identifiers like "order:12345" / "checkout:abc" / "customer:99". */
function parseIdentifier(identifier) {
  if (!identifier || typeof identifier !== 'string') return null;
  const [type, value] = identifier.split(':');
  if (!type || !value) return null;
  return { type, value };
}
