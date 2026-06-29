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

import { listShops } from '../store.js';
import { getAutomation } from '../settings.js';
import { placeCall } from './_base.js';

/**
 * Scheduler entrypoint. Currently a no-op sweep because we don't persist
 * fulfillment dates in the file stub. Returns immediately after logging once.
 */
export async function runReviewsSweep() {
  for (const { shop } of listShops()) {
    const cfg = getAutomation(shop, 'reviews');
    if (!cfg?.enabled || !cfg.agentId) continue;
    // TODO: select orders fulfilled `cfg.filters.daysAfterFulfillment || 5` days
    // ago from your DB and call requestReview(shop, order) for each.
    console.log(
      `[reviews] sweep for ${shop}: enabled but no fulfillment index yet (stub). ` +
        `Persist fulfilledAt on orders/fulfilled to activate.`,
    );
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
