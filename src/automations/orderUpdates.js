// ─────────────────────────────────────────────────────────────────────────────
// automations/orderUpdates.js — Use case 3: order confirmation & delivery updates.
//
// Triggers:
//   - orders/create     → "orderConfirmation" call (thank-you / confirm details)
//   - orders/fulfilled  → "orderShipped" call (read out tracking number/URL)
//   - delivered / failed-delivery → STUBS (Shopify has no native webhook for the
//     final delivery state; wire these to your carrier/3PL or a fulfillment-event
//     poller — see TODOs).
// ─────────────────────────────────────────────────────────────────────────────

import { placeCall, formatMoney, summarizeLineItems, firstName } from './_base.js';

const storeName = (shop) => (shop || '').replace('.myshopify.com', '');

/**
 * orders/create → plain order confirmation call (separate from COD confirmation).
 * Note: COD confirmation is its own automation; enable only one for orders/create
 * if you don't want two calls. Both are independently toggleable in settings.
 * @param {string} shop @param {object} order
 */
export async function handleOrderConfirmation(shop, order) {
  const variables = {
    customer_name: firstName(order),
    order_number: String(order.name || order.order_number || order.id),
    order_items: summarizeLineItems(order.line_items),
    order_total: formatMoney(order.total_price, order.currency),
    currency: order.currency || '',
    store_name: storeName(shop),
  };

  return placeCall({
    shop,
    automation: 'orderConfirmation',
    entity: order,
    variables,
    identifier: `order:${order.id}`,
    mapExtra: { orderId: order.id, orderName: order.name },
  });
}

/**
 * orders/fulfilled → shipped notification with tracking info.
 * Shopify's orders/fulfilled payload is an order with `fulfillments[]`; we read
 * tracking details from the most recent fulfillment.
 * @param {string} shop @param {object} order
 */
export async function handleOrderShipped(shop, order) {
  const fulfillment = latestFulfillment(order);
  const trackingNumber =
    fulfillment?.tracking_number ||
    (Array.isArray(fulfillment?.tracking_numbers) ? fulfillment.tracking_numbers[0] : '') ||
    '';
  const trackingUrl =
    fulfillment?.tracking_url ||
    (Array.isArray(fulfillment?.tracking_urls) ? fulfillment.tracking_urls[0] : '') ||
    '';

  const variables = {
    customer_name: firstName(order),
    order_number: String(order.name || order.order_number || order.id),
    tracking_number: trackingNumber,
    tracking_url: trackingUrl,
    carrier: fulfillment?.tracking_company || '',
    store_name: storeName(shop),
  };

  return placeCall({
    shop,
    automation: 'orderShipped',
    entity: order,
    variables,
    identifier: `order:${order.id}`,
    mapExtra: { orderId: order.id, orderName: order.name },
  });
}

/** Most recent fulfillment off an order payload, if any. */
function latestFulfillment(order) {
  const fs = order?.fulfillments;
  if (!Array.isArray(fs) || fs.length === 0) return null;
  return [...fs].sort(
    (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0),
  )[0];
}

// ── Delivery state stubs ──────────────────────────────────────────────────────

/**
 * STUB: delivered confirmation / review nudge trigger.
 * TODO: Shopify has no first-class "delivered" webhook. Options to wire this:
 *   1) Poll FulfillmentEvent (GraphQL) for status DELIVERED on shipped orders.
 *   2) Receive a carrier/3PL webhook (Shippo, AfterShip, Delhivery, Shiprocket…)
 *      and map it to the order, then call placeCall(...) with automation
 *      "orderShipped" variables or a dedicated "delivered" automation.
 * @param {string} shop @param {object} order
 */
export async function handleOrderDelivered(shop, order) {
  // TODO: build delivered variables + placeCall with a "delivered" automation key.
  return { placed: false, reason: 'delivered handler is a stub (wire a carrier webhook)' };
}

/**
 * STUB: failed-delivery / RTO-in-progress recovery call.
 * TODO: Same wiring as delivered — trigger off a carrier "exception"/"failed"
 * event and call the customer to re-attempt / re-confirm the address.
 * @param {string} shop @param {object} order
 */
export async function handleFailedDelivery(shop, order) {
  // TODO: build failed-delivery variables + placeCall.
  return { placed: false, reason: 'failed-delivery handler is a stub (wire a carrier webhook)' };
}
