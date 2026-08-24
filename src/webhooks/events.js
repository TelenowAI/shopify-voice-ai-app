// ─────────────────────────────────────────────────────────────────────────────
// webhooks/events.js — Shopify *Events* receiver (the webhooks successor).
//
// Our org's app spec requires at least one [[events.subscription]] in
// shopify.app.toml, so `order-created` deliveries land here (uri
// /events/orders). Unlike classic webhooks, Events deliveries are NOT handled
// by shopify.webhooks.process() — we verify the HMAC ourselves:
// HMAC-SHA256 over the raw body, keyed with the app client secret
// (SHOPIFY_API_SECRET), base64-encoded in the Shopify-Hmac-Sha256 header.
//
// IMPORTANT: this is an ACK-only endpoint for now. The real order-created work
// (confirmation/COD calls) already runs off the classic ORDERS_CREATE webhook
// in webhooks/shopify.js — acting here too would double-call customers. We
// verify, log, and 200 fast so Shopify keeps the subscription healthy.
//
// Like the other receivers, server.js mounts this with express.text() so we
// see the raw bytes — do NOT JSON-parse before verifying or HMAC will fail.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import express from 'express';

export const eventsRouter = express.Router();

/**
 * Verify Shopify-Hmac-Sha256 (base64) over the raw body with the app secret.
 * Constant-time comparison, same belt-and-braces style as the Telenow verifier.
 * @param {string} rawBody  exact bytes received
 * @param {string} header   value of Shopify-Hmac-Sha256
 * @returns {boolean}
 */
function verifyEventSignature(rawBody, header) {
  const secret = process.env.SHOPIFY_API_SECRET || '';
  if (!header || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  try {
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// POST /events/orders — `order-created` subscription (see shopify.app.toml).
eventsRouter.post('/orders', (req, res) => {
  const rawBody = typeof req.body === 'string' ? req.body : '';
  // Events docs name the header without the X- prefix; accept both to be safe.
  const sig = req.get('Shopify-Hmac-Sha256') || req.get('X-Shopify-Hmac-Sha256') || '';

  if (!verifyEventSignature(rawBody, sig)) {
    console.warn('[events:orders] rejected delivery: bad or missing HMAC');
    return res.status(401).send('Unauthorized');
  }

  // Shopify-Webhook-Id dedupes retries; Shopify-Event-Id groups related
  // deliveries. Logged for traceability — no processing here (see header note).
  console.log(
    `[events:orders] ack shop=${req.get('X-Shopify-Shop-Domain') || 'unknown'}` +
      ` webhookId=${req.get('Shopify-Webhook-Id') || '-'}` +
      ` eventId=${req.get('Shopify-Event-Id') || '-'}`,
  );
  res.status(200).send('ok');
});
