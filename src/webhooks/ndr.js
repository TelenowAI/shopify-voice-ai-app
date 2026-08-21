// ─────────────────────────────────────────────────────────────────────────────
// webhooks/ndr.js — carrier "failed delivery" (NDR) receiver.
//
// Shopify has no webhook for a failed delivery. The event only exists at the
// courier — Delhivery, Shiprocket, Blue Dart, Xpressbees, Ekart — so the
// merchant points their courier's webhook at this endpoint and we turn it into
// a recovery call.
//
// AUTH is a secret path segment (/webhooks/ndr/:token) rather than an HMAC,
// because couriers differ wildly in what signing they support and several offer
// none at all. The token is 32 bytes of CSPRNG, per shop, revocable, and never
// travels in a query string (where it would land in access logs and Referer
// headers). It is compared in constant time.
//
// The body shape is not standardised either, so field names are matched
// generously across the common Indian aggregators rather than demanding one
// schema.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import express from 'express';

import { listShops } from '../store.js';
import { getSettings, getAutomation } from '../settings.js';
import { placeCall } from '../automations/_base.js';

export const ndrWebhookRouter = express.Router();

/** First present, non-empty value among several candidate keys. */
function pick(body, keys) {
  for (const k of keys) {
    const v = body?.[k];
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return '';
}

/** Constant-time compare that cannot throw on a length mismatch. */
function tokenMatches(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

/** Resolve the shop whose NDR token this is. */
function shopForToken(token) {
  if (!token) return null;
  // listShops() yields session OBJECTS, not domain strings — take .shop, or
  // getSettings() receives an object and silently returns defaults.
  for (const row of listShops()) {
    const shop = typeof row === 'string' ? row : row?.shop;
    if (!shop) continue;
    if (tokenMatches(getSettings(shop).ndrToken, token)) return shop;
  }
  return null;
}

/**
 * POST /webhooks/ndr/:token
 *
 * Always answers 200 once the token is valid, even when no call is placed.
 * A courier that gets a 4xx will usually retry the same event for hours, and
 * "we saw it and chose not to call" is not a delivery failure on their side.
 * The reason is in the body so it is still debuggable.
 */
ndrWebhookRouter.post('/:token', async (req, res) => {
  const shop = shopForToken(req.params.token);
  if (!shop) {
    // Deliberately vague: this endpoint is public, and naming what was wrong
    // would let someone probe for valid tokens.
    res.status(404).json({ error: 'not found' });
    return;
  }

  // Body arrives as raw text (the router is mounted with express.text so the
  // Shopify/Telenow HMAC receivers can see raw bytes); parse it here.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body && typeof body === 'object' ? body : {};

  const orderNumber = pick(body, [
    'order_number', 'orderNumber', 'order_id', 'orderId',
    'reference_number', 'referenceNumber', 'client_order_id', 'awb', 'waybill',
  ]);
  const phone = pick(body, [
    'phone', 'mobile', 'customer_phone', 'customerPhone', 'contact_number', 'consignee_phone',
  ]);
  const reason = pick(body, [
    'reason', 'ndr_reason', 'remarks', 'status_remarks', 'failure_reason', 'status',
  ]) || 'Delivery attempt failed';
  const courier = pick(body, ['courier', 'courier_name', 'carrier', 'courier_partner']) || 'the courier';
  const address = pick(body, ['address', 'delivery_address', 'shipping_address', 'consignee_address']);
  const customerName = pick(body, ['customer_name', 'customerName', 'consignee_name', 'name']);

  if (!phone) {
    console.warn(`[ndr] shop=${shop} order=${orderNumber || '?'} — no phone in payload, ignoring`);
    res.json({ ok: true, placed: false, reason: 'no phone number in payload' });
    return;
  }

  const cfg = getAutomation(shop, 'rtoRecovery') || {};
  const maxAttempts = Math.max(1, Number(cfg.filters?.maxAttempts) || 1);

  // The courier fires an NDR per failed attempt, so the same parcel arrives
  // more than once. placeCall dedupes on identifier, and the attempt number is
  // deliberately part of it so attempt 2 is allowed through while a repeat of
  // attempt 1 is not.
  const attempt = Math.max(1, Number(pick(body, ['attempt', 'attempt_number', 'ndr_attempt'])) || 1);
  if (attempt > maxAttempts) {
    console.log(`[ndr] shop=${shop} order=${orderNumber} attempt ${attempt} > max ${maxAttempts}, skipping`);
    res.json({ ok: true, placed: false, reason: `attempt ${attempt} exceeds the ${maxAttempts}-attempt limit` });
    return;
  }

  try {
    const result = await placeCall({
      shop,
      automation: 'rtoRecovery',
      // placeCall extracts a phone from the entity; we already have one, so it
      // is passed explicitly and the entity only carries display fields.
      entity: { name: customerName, phone },
      phoneOverride: phone,
      identifier: `ndr:${orderNumber || phone}:${attempt}`,
      variables: {
        customer_name: customerName || 'there',
        order_number: orderNumber || '',
        courier_name: courier,
        delivery_address: address || '',
        failure_reason: reason,
      },
      mapExtra: { orderNumber, attempt, reason },
    });
    console.log(`[ndr] shop=${shop} order=${orderNumber || '?'} attempt=${attempt} placed=${result?.placed !== false}`);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(`[ndr] shop=${shop} failed:`, err.message);
    // Still 200 — see the note above about courier retry storms.
    res.json({ ok: true, placed: false, reason: err.message });
  }
});
