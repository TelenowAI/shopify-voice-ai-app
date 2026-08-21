// ─────────────────────────────────────────────────────────────────────────────
// automations/postPurchase.js — check in a few days after delivery.
//
// Reads the same fulfilment index as the feedback sweep, because Shopify tells
// you when an order SHIPS and never when it arrives — "N days after dispatch"
// is the closest honest proxy either of them has.
//
// The two sweeps overlap by design, so this one runs LATER and is suppressed
// when the feedback call already reached that customer. Nobody wants a rating
// call on Monday and an upsell call on Tuesday.
// ─────────────────────────────────────────────────────────────────────────────

import { listShops, dueForCall, markCalled, pruneFulfillments } from '../store.js';
import { getAutomation } from '../settings.js';
import { placeCall } from './_base.js';

/**
 * Scheduler entrypoint.
 *
 * Each order is marked BEFORE the call is attempted: a failure means this
 * customer is skipped, not retried on every sweep for the rest of the window.
 */
export async function runPostPurchaseSweep() {
  for (const row of listShops()) {
    const shop = typeof row === 'string' ? row : row?.shop;
    if (!shop) continue;
    const cfg = getAutomation(shop, 'postPurchase');
    if (!cfg?.enabled || !cfg.agentId) continue;

    const f = cfg.filters || {};
    const days = Number(f.daysAfterFulfillment) || 10;
    const maxAgeDays = Number(f.maxAgeDays) || 30;
    const minTotal = Number(f.minOrderValue) || 0;
    const perSweep = Math.max(1, Number(f.maxPerSweep) || 25);
    // 0 disables suppression, which is a real choice for a store that only runs
    // one of the two sweeps.
    const suppressIfCalledWithinDays = Number(f.suppressDays ?? 14);

    let due = dueForCall(shop, 'postPurchase', { days, maxAgeDays, suppressIfCalledWithinDays });
    // An upsell only makes sense where there is margin to protect.
    if (minTotal > 0) due = due.filter((r) => (Number(r.total) || 0) >= minTotal);
    due = due.slice(0, perSweep);
    if (!due.length) continue;

    console.log(`[postPurchase] ${shop}: ${due.length} order(s) due for a check-in`);
    for (const rec of due) {
      markCalled(shop, rec.orderId, 'postPurchase');
      try {
        await placeCall({
          shop,
          automation: 'postPurchase',
          entity: { phone: rec.phone, name: rec.name },
          phoneOverride: rec.phone,
          identifier: `postpurchase:${rec.orderId}`,
          variables: {
            customer_name: rec.name || 'there',
            order_number: rec.orderName || '',
            items: rec.items || '',
          },
          mapExtra: { orderId: rec.orderId, orderName: rec.orderName, purpose: 'postPurchase' },
        });
      } catch (err) {
        console.error(`[postPurchase] ${shop} order=${rec.orderName}:`, err.message);
      }
    }
    pruneFulfillments(shop, 90);
  }
}
