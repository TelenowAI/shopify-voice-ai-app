// ─────────────────────────────────────────────────────────────────────────────
// automations/codConfirmation.js — Use case 2: COD confirmation / RTO reduction.
//
// Trigger: Shopify webhook `orders/create`.
// If the order is Cash-on-Delivery (and therefore at risk of return-to-origin),
// call the customer to confirm BEFORE fulfillment.
//
// The *result* of the call comes back on the Telenow webhook and is handled in
// src/webhooks/telenow.js, which tags the order:
//   confirmed  → "telenow-cod-confirmed"  + order note
//   cancelled  → "telenow-cod-cancelled"  + order note   (does NOT auto-cancel)
// ─────────────────────────────────────────────────────────────────────────────

import { getAutomation } from '../settings.js';
import { placeCall, formatMoney, summarizeLineItems, firstName } from './_base.js';

/**
 * Heuristic COD detection across the many ways Shopify can express it.
 * Merchants can add extra gateway substrings via filters.codGatewaysExtra.
 * @param {object} order
 * @param {string[]} [extraGateways]
 * @returns {boolean}
 */
export function isCodOrder(order, extraGateways = []) {
  if (!order) return false;

  const needles = ['cash on delivery', 'cod', 'cash_on_delivery', ...extraGateways]
    .map((s) => String(s).toLowerCase())
    .filter(Boolean);

  const haystacks = [
    order.gateway,
    order.payment_gateway_names?.join(' '),
    order.processing_method,
    ...(order.payment_gateway_names || []),
  ]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());

  const gatewayMatch = haystacks.some((h) => needles.some((n) => h.includes(n)));

  // COD orders are typically unpaid at creation. financial_status "pending" with
  // a manual/COD gateway is the strongest combined signal.
  const pending = ['pending', 'unpaid'].includes(String(order.financial_status || '').toLowerCase());

  return gatewayMatch || (pending && hasManualGateway(haystacks));
}

function hasManualGateway(haystacks) {
  return haystacks.some((h) => h.includes('manual') || h.includes('cod') || h.includes('cash'));
}

/**
 * Handle an orders/create webhook for COD confirmation.
 * @param {string} shop
 * @param {object} order  Shopify order payload.
 */
export async function handleCodConfirmation(shop, order) {
  const cfg = getAutomation(shop, 'codConfirmation');
  const extraGateways = cfg?.filters?.codGatewaysExtra || [];

  if (!isCodOrder(order, extraGateways)) {
    return { placed: false, reason: 'not a COD order' };
  }

  // Optional minimum-order-value filter (skip tiny COD orders if configured).
  const minValue = Number(cfg?.filters?.minOrderValue) || 0;
  if (minValue > 0 && Number(order.total_price) < minValue) {
    return { placed: false, reason: `below minOrderValue ${minValue}` };
  }

  const variables = {
    customer_name: firstName(order),
    order_number: String(order.name || order.order_number || order.id),
    order_items: summarizeLineItems(order.line_items),
    order_total: formatMoney(order.total_price, order.currency),
    currency: order.currency || '',
    payment_method: 'Cash on Delivery',
    shipping_city: order.shipping_address?.city || '',
    store_name: (shop || '').replace('.myshopify.com', ''),
  };

  return placeCall({
    shop,
    automation: 'codConfirmation',
    entity: order,
    variables,
    identifier: `order:${order.id}`,
    mapExtra: { orderId: order.id, orderName: order.name },
  });
}
