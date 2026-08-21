// ─────────────────────────────────────────────────────────────────────────────
// automations/reviews.js — Use case 5: reviews / NPS (scheduled, STUB).
//
// Goal: X days after an order is fulfilled, call the customer to ask for a
// review / NPS score. The agent can capture a 0–10 score + verbatim, which comes
// back on the Telenow analysis webhook and can be written to an order metafield.
//
// This is intentionally a STUB because it needs a durable record of "fulfilled
// at" per order to schedule against. The clean way to wire it:
//   1) On orders/fulfilled (see webhooks/shopify.js), persist { orderId,
//      fulfilledAt, phone, name } to your DB.
//   2) A daily job selects orders fulfilled exactly N days ago and calls
//      placeCall({ automation: 'reviews', ... }).
//
// Below we provide runReviewsSweep() wired to the scheduler, plus the
// variable-building + placeCall path so finishing it is a small change.
// ─────────────────────────────────────────────────────────────────────────────

import { listShops, dueForCall, markCalled, pruneFulfillments } from '../store.js';
import { getAutomation } from '../settings.js';
import { placeCall } from './_base.js';

/**
 * Scheduler entrypoint: call customers whose order was fulfilled N days ago.
 *
 * Reads the fulfillment index written on orders/fulfilled. Each order is called
 * at most once — marked the moment placeCall is asked, not when it succeeds, so
 * a failure does not put the customer in a retry loop on every sweep.
 */
export async function runReviewsSweep() {
  for (const row of listShops()) {
    const shop = typeof row === 'string' ? row : row?.shop;
    if (!shop) continue;
    const cfg = getAutomation(shop, 'reviews');
    if (!cfg?.enabled || !cfg.agentId) continue;

    const days = Number(cfg.filters?.daysAfterFulfillment) || 5;
    const maxAge = Number(cfg.filters?.maxAgeDays) || 30;
    const minTotal = Number(cfg.filters?.minOrderValue) || 0;
    const perSweep = Math.max(1, Number(cfg.filters?.maxPerSweep) || 25);

    // Suppressed when the post-purchase call already reached this customer.
    const suppressDays = Number(cfg.filters?.suppressDays ?? 14);
    let due = dueForCall(shop, 'feedback', { days, maxAgeDays: maxAge, suppressIfCalledWithinDays: suppressDays });
    // Low-value orders are not worth a call: the call can cost more than the
    // margin on the order it is asking about.
    if (minTotal > 0) due = due.filter((f) => (Number(f.total) || 0) >= minTotal);
    // Cap per sweep so enabling this on a busy store does not dial hundreds at once.
    due = due.slice(0, perSweep);
    if (!due.length) continue;

    console.log(`[reviews] ${shop}: ${due.length} order(s) due for feedback`);
    for (const f of due) {
      // Mark BEFORE calling. If placeCall throws, this customer is skipped
      // rather than retried on every sweep for the rest of the window.
      markCalled(shop, f.orderId, 'feedback');
      try {
        await placeCall({
          shop,
          automation: 'reviews',
          entity: { phone: f.phone, name: f.name },
          phoneOverride: f.phone,
          identifier: `feedback:${f.orderId}`,
          variables: {
            customer_name: f.name || 'there',
            order_number: f.orderName || '',
            items: f.items || '',
            delivered_days_ago: String(Math.max(1, Math.round(
              (Date.now() - new Date(f.fulfilledAt).getTime()) / 86400000))),
          },
          mapExtra: { orderId: f.orderId, orderName: f.orderName, purpose: 'feedback' },
        });
      } catch (err) {
        console.error(`[reviews] ${shop} order=${f.orderName}:`, err.message);
      }
    }
    pruneFulfillments(shop, 90);
  }
}

/**
 * Place a single review/NPS call for an order. Ready to use once a scheduler
 * feeds it orders at the right time.
 * @param {string} shop @param {object} order  (must include customer/phone fields)
 */
export async function requestReview(shop, order) {
  const variables = {
    customer_name:
      order?.customer?.first_name || order?.billing_address?.first_name || 'there',
    order_number: String(order.name || order.order_number || order.id),
    store_name: (shop || '').replace('.myshopify.com', ''),
  };

  return placeCall({
    shop,
    automation: 'reviews',
    entity: order,
    variables,
    identifier: `order:${order.id}`,
    mapExtra: { orderId: order.id, orderName: order.name, purpose: 'review' },
  });
}
