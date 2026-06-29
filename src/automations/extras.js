// ─────────────────────────────────────────────────────────────────────────────
// automations/extras.js — extension points for additional use cases (STUBS).
//
// Each function below is a ready-to-fill handler. To activate one:
//   1) Add a config entry to AUTOMATIONS in settings.js (key, label, triggers).
//   2) Wire its Shopify webhook topic (or scheduled job) in webhooks/shopify.js
//      or server.js.
//   3) Build the `variables` object and call placeCall({...}) — copy the pattern
//      from codConfirmation.js / orderUpdates.js.
//
// They all return a "not implemented" result today so nothing fires by accident.
// When you fill one in, import `placeCall` from './_base.js' and call it like the
// other automation modules do.
// ─────────────────────────────────────────────────────────────────────────────

const notImplemented = (name) => ({
  placed: false,
  reason: `${name} is a stub — see automations/extras.js`,
});

/**
 * STUB: Back-in-stock callback.
 * Trigger: a "notify me" signup + an inventory-level webhook (inventory_levels/update)
 * crossing 0→positive. Call shoppers who asked to be notified.
 * TODO: persist back-in-stock requests (product/variant → phone) and match here.
 */
export async function handleBackInStock(shop, payload) {
  // TODO: build variables { customer_name, product_title, product_url } + placeCall.
  return notImplemented('back-in-stock');
}

/**
 * STUB: Payment-failed retry (recover failed/declined payments).
 * Trigger: orders/create with financial_status "voided"/"declined", or an
 * order_transactions failure, or a Shopify Payments dispute/charge webhook.
 * TODO: call the customer to retry payment with a secure pay link.
 */
export async function handlePaymentFailed(shop, payload) {
  // TODO: build variables { customer_name, order_number, retry_payment_url } + placeCall.
  return notImplemented('payment-failed');
}

/**
 * STUB: Subscription renewal reminder.
 * Trigger: a subscription app webhook (e.g. Shopify Subscriptions / Recharge /
 * Bold) N days before the next billing date.
 * TODO: call to remind / confirm the upcoming renewal, offer skip/swap.
 */
export async function handleSubscriptionRenewal(shop, payload) {
  // TODO: build variables { customer_name, product_title, renewal_date } + placeCall.
  return notImplemented('subscription-renewal');
}

/**
 * STUB: Upsell / cross-sell.
 * Trigger: orders/fulfilled or a scheduled post-purchase window; recommend a
 * complementary product.
 * TODO: build a recommendation (rule-based or via your recs engine) + placeCall.
 */
export async function handleUpsell(shop, payload) {
  // TODO: build variables { customer_name, recommended_product, offer_url } + placeCall.
  return notImplemented('upsell');
}

/**
 * STUB: Replenishment reminder (consumables).
 * Trigger: scheduled job estimating run-out date from last purchase of a
 * consumable product.
 * TODO: compute due date per customer/product and placeCall to reorder.
 */
export async function handleReplenishment(shop, payload) {
  // TODO: build variables { customer_name, product_title, reorder_url } + placeCall.
  return notImplemented('replenishment');
}

/**
 * STUB: High-value-order fraud check.
 * Trigger: orders/create above a value threshold or with a high Shopify fraud
 * risk recommendation. Call to verify the order with the customer before
 * fulfilling.
 * TODO: gate on order total / risk; build variables + placeCall; on the result
 * webhook, tag "telenow-verified" / "telenow-fraud-suspected".
 */
export async function handleFraudCheck(shop, payload) {
  // TODO: build variables { customer_name, order_number, order_total } + placeCall.
  return notImplemented('fraud-check');
}
