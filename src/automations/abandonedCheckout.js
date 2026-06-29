// ─────────────────────────────────────────────────────────────────────────────
// automations/abandonedCheckout.js — Use case 1: Abandoned checkout recovery.
//
// Trigger: Shopify webhook `checkouts/create` or `checkouts/update`.
// After a configurable delay, if the checkout has NOT turned into an order, call
// the shopper to recover the cart. We pass cart context + the recovery URL so the
// agent can read it out / SMS it.
//
// Conversion check: at fire time we re-check whether the checkout converted. The
// most reliable signal Shopify gives on the checkout object is `completed_at`
// (set when the checkout becomes an order). We also expose a TODO to cross-check
// against orders via the Admin API for extra safety.
// ─────────────────────────────────────────────────────────────────────────────

import { getShop } from '../store.js';
import { getAutomation } from '../settings.js';
import { REST_API_VERSION } from '../shopify.js';
import { placeCall, formatMoney, summarizeLineItems, firstName } from './_base.js';

/**
 * Handle a checkouts/create|update webhook.
 * @param {string} shop
 * @param {object} checkout  Shopify abandoned-checkout payload.
 */
export async function handleAbandonedCheckout(shop, checkout) {
  // Already completed → nothing to recover.
  if (checkout?.completed_at) {
    return { placed: false, reason: 'checkout already completed' };
  }
  // No recovery URL means Shopify won't let us send them back to the cart.
  const recoveryUrl = checkout?.abandoned_checkout_url;
  if (!recoveryUrl) {
    return { placed: false, reason: 'no abandoned_checkout_url (needs marketing consent)' };
  }

  const variables = {
    customer_name: firstName(checkout),
    cart_items: summarizeLineItems(checkout.line_items),
    cart_total: formatMoney(checkout.total_price, checkout.currency),
    currency: checkout.currency || '',
    recovery_url: recoveryUrl,
    store_name: storeName(shop),
    // Optional discount code — merchant can configure one per automation in filters.
    discount_code: '', // filled below from settings filters if present
  };

  // Pull an optional discount code from the automation filters.
  const discount = discountFromFilters(shop);
  if (discount) variables.discount_code = discount;

  const checkoutId = checkout.id || checkout.token;

  return placeCall({
    shop,
    automation: 'abandonedCheckout',
    entity: checkout,
    variables,
    identifier: `checkout:${checkoutId}`,
    mapExtra: {
      checkoutId,
      // Re-check conversion right before the (delayed) call fires.
      shouldStillCall: () => notYetConverted(shop, checkout),
    },
  });
}

/** Resolve a discount code from the automation's filters, if configured. */
function discountFromFilters(shop) {
  return getAutomation(shop, 'abandonedCheckout')?.filters?.discountCode || '';
}

/**
 * Best-effort "did this checkout convert yet?" check, run just before a delayed
 * call. Returns true if we should still place the call (i.e. NOT converted).
 *
 * Primary signal: the checkout payload's completed_at (cheap, no API call). For
 * stronger guarantees, cross-check the Admin API for an order created from this
 * checkout.
 */
async function notYetConverted(shop, checkout) {
  if (checkout?.completed_at) return false;

  // Stronger check: look for an order with this checkout_id / checkout_token.
  // TODO: This uses the REST orders endpoint filtered by created_at_min; for high
  // volume, prefer the `orders/create` webhook to mark conversion in the store
  // and read that flag here instead of polling the API.
  try {
    const session = getShop(shop);
    if (!session?.accessToken) return true; // can't verify → err on the side of calling? See note.
    const token = checkout.token || checkout.cart_token;
    if (!token) return true;
    const url =
      `https://${shop}/admin/api/${REST_API_VERSION}/orders.json` +
      `?status=any&fields=id,checkout_token&limit=50`;
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': session.accessToken, Accept: 'application/json' },
    });
    if (!res.ok) return true; // verification failed → fall back to calling
    const data = await res.json();
    const converted = (data?.orders || []).some((o) => o.checkout_token === token);
    return !converted;
  } catch {
    return true; // network error → fall back to the cheap completed_at signal
  }
}

/** Pretty store name from the shop domain (e.g. "my-store"). */
function storeName(shop) {
  return (shop || '').replace('.myshopify.com', '');
}
