// ─────────────────────────────────────────────────────────────────────────────
// automations/winBack.js — Use case 4: win-back / re-engagement (scheduled).
//
// A periodic job finds customers whose most recent order is older than
// `settings.winBackDays` and calls them with an optional win-back discount.
//
// Scheduling: src/server.js starts this on an interval (a setInterval stub; swap
// for node-cron or a real scheduler in production). We dedupe with a per-customer
// "lastWinBackAt" marker stored in the callMap-style map to avoid re-calling the
// same person every tick.
//
// SCALE NOTE: this implementation pages the Admin REST customers endpoint and is
// fine for small/medium stores. For large catalogs, drive this from a Shopify
// segment / bulk operation, or maintain a "last_order_at" index in your DB.
// ─────────────────────────────────────────────────────────────────────────────

import { getShop, listShops, getCall, mapCall } from '../store.js';
import { getSettings, getAutomation } from '../settings.js';
import { REST_API_VERSION } from '../shopify.js';
import { placeCall, formatMoney } from './_base.js';

/** Run a win-back sweep across all installed shops. Called by the scheduler. */
export async function runWinBackSweep() {
  for (const { shop } of listShops()) {
    try {
      const cfg = getAutomation(shop, 'winBack');
      if (!cfg?.enabled || !cfg.agentId) continue;
      await sweepShop(shop);
    } catch (err) {
      console.error(`[winBack] sweep failed for ${shop}:`, err.message);
    }
  }
}

/** Sweep a single shop for lapsed customers and place win-back calls. */
async function sweepShop(shop) {
  const settings = getSettings(shop);
  const days = Number(settings.winBackDays) || 60;
  const cfg = settings.automations.winBack;

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const customers = await lapsedCustomers(shop, cutoff);

  for (const c of customers) {
    // Dedupe: don't win-back the same customer more than once per `days` window.
    const dedupeKey = `winback:${shop}:${c.id}`;
    const prev = getCall(dedupeKey);
    if (prev && new Date(prev.createdAt).getTime() > Date.now() - days * 24 * 60 * 60 * 1000) {
      continue;
    }

    const variables = {
      customer_name: c.first_name || 'there',
      days_since_last_order: String(daysSince(c.last_order_at)),
      store_name: (shop || '').replace('.myshopify.com', ''),
      discount_code: cfg?.filters?.discountCode || '',
      last_order_total: formatMoney(c.last_order_total, c.currency),
    };

    const res = await placeCall({
      shop,
      automation: 'winBack',
      entity: c, // extractPhone() reads c.phone / default_address.phone
      variables,
      identifier: `customer:${c.id}`,
      mapExtra: { customerId: c.id },
    });

    // Mark as attempted (even if scheduled/skipped for quiet hours) to avoid
    // hammering the same customer every tick.
    if (res.placed || res.reason === 'within quiet hours') {
      mapCall(dedupeKey, { shop, automation: 'winBack', customerId: c.id });
    }
  }
}

/**
 * Fetch customers whose last order predates `cutoff`. Best-effort via the REST
 * customers endpoint (last_order_id present + ordered before cutoff). Returns a
 * normalized array with the fields the caller needs.
 *
 * TODO: REST `customers.json` doesn't directly filter by last-order date; we page
 * and filter client-side. For large stores use a Customer Segment query or keep
 * your own last_order_at index updated from the orders/create webhook.
 * @param {string} shop @param {Date} cutoff
 */
async function lapsedCustomers(shop, cutoff) {
  const session = getShop(shop);
  if (!session?.accessToken) return [];

  const out = [];
  // Single page is plenty for a demo; production should follow Link pagination.
  const url =
    `https://${shop}/admin/api/${REST_API_VERSION}/customers.json` +
    `?limit=50&fields=id,first_name,phone,last_order_id,last_order_name,default_address,orders_count,updated_at`;

  let data;
  try {
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': session.accessToken, Accept: 'application/json' },
    });
    if (!res.ok) return [];
    data = await res.json();
  } catch (err) {
    console.error(`[winBack] customers fetch failed for ${shop}:`, err.message);
    return [];
  }

  for (const c of data?.customers || []) {
    if (!c.last_order_id || !c.orders_count) continue; // never ordered
    // We don't have last_order_at directly; `updated_at` is a rough proxy. For
    // accuracy, fetch the last order or maintain last_order_at in your DB.
    const lastOrderAt = c.updated_at; // TODO: replace with true last order date
    if (new Date(lastOrderAt) > cutoff) continue; // ordered recently → skip
    out.push({
      id: c.id,
      first_name: c.first_name,
      phone: c.phone,
      default_address: c.default_address,
      last_order_at: lastOrderAt,
      last_order_total: null, // TODO: fetch from the order if you want it in the script
      currency: null,
    });
  }
  return out;
}

function daysSince(iso) {
  if (!iso) return '';
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000)));
}
