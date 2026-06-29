// ─────────────────────────────────────────────────────────────────────────────
// automations/leadCallback.js — Lead callback (speed-to-lead).
//
// Trigger: Shopify webhook `customers/create`.
// Shopify has no form-plugin ecosystem (unlike WooCommerce's "Lead Forms"), so a
// newly-created customer — signup, a lead/contact app, a contact form that creates
// a customer — IS the lead signal. The moment one appears we:
//   1) store the lead row (so it shows in the dashboard even if we don't call),
//   2) place an instant Telenow AI callback (delay defaults to 0 — speed-to-lead),
//   3) patch the row with the placement result.
//
// The *result* of the call comes back on the Telenow webhook and is handled in
// src/webhooks/telenow.js, which resolves the lead via the callMap entry's leadId
// (or by parsing the "lead:<id>" identifier) and marks it completed.
// ─────────────────────────────────────────────────────────────────────────────

import { placeCall } from './_base.js';
import { insertLead, updateLead, markAttempt, clearAttempt } from '../store.js';
import { toE164 } from '../util/phone.js';

/** Default country used for E.164 normalization when a number has no country code. */
const DEFAULT_COUNTRY = process.env.DEFAULT_PHONE_COUNTRY || 'IN';

/**
 * Handle a customers/create webhook: capture the lead and call them back.
 * @param {string} shop
 * @param {object} customer  Shopify customer payload.
 * @returns {Promise<{ placed: boolean, reason?: string, leadId: number }>}
 */
export async function handleLeadCallback(shop, customer) {
  customer = customer || {};

  // Phone can live on the customer or their default/first address.
  const rawPhone =
    customer.phone || customer.default_address?.phone || customer.addresses?.[0]?.phone || '';
  const phone = toE164(rawPhone, DEFAULT_COUNTRY);

  const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ');
  const email = customer.email || '';
  const addr = customer.default_address || {};

  // Context strings for the agent. All values are strings (Telenow variables).
  const acceptsMarketing =
    customer.accepts_marketing ?? customer.email_marketing_consent?.state === 'subscribed';
  const variables = {
    customer_name: name || 'there',
    email,
    source: 'shopify_customer',
    store_name: (shop || '').replace('.myshopify.com', ''),
    tags: String(customer.tags || ''),
    accepts_marketing: String(Boolean(acceptsMarketing)),
    orders_count: String(customer.orders_count ?? 0),
    city: String(addr.city || ''),
  };

  // Shopify redelivers customers/create on timeout/retry. Each delivery would
  // otherwise mint a fresh leadId, so placeCall's per-identifier dedupe can't
  // catch it → a duplicate lead row AND a duplicate callback. Dedupe on the
  // STABLE customer id here, before we store or call. (redactCustomer's
  // `:customer:<id>` sweep cleans this key on GDPR erasure.)
  const customerId = customer.id != null ? String(customer.id) : '';
  const dedupeKey = customerId ? `leadCallback:${shop}:customer:${customerId}` : '';
  if (dedupeKey && !markAttempt(dedupeKey)) {
    return { placed: false, reason: 'duplicate customers/create — already handled', leadId: 0 };
  }

  // Always store the lead FIRST so it lands in the dashboard regardless of whether
  // the call is placed (no phone, disabled, quiet hours, etc.).
  const leadId = insertLead(shop, {
    source: 'shopify_customer',
    shopifyCustomerId: customer.id ?? null,
    name,
    email,
    phone: phone || '',
    fields: variables,
    status: 'queued',
  });

  // No usable phone → nothing to call. Record and bail.
  if (!phone) {
    updateLead(shop, leadId, { status: 'skipped', disposition: 'no phone' });
    return { placed: false, reason: 'no phone', leadId };
  }

  try {
    // placeCall extracts a phone from `entity` OR uses `phoneOverride`; we already
    // normalized one, so pass it explicitly. mapExtra.leadId is persisted on the
    // callMap entry so the result webhook can find this lead.
    const result = await placeCall({
      shop,
      automation: 'leadCallback',
      entity: customer,
      variables,
      identifier: `lead:${leadId}`,
      mapExtra: { leadId },
      phoneOverride: phone,
    });

    if (result?.placed) {
      updateLead(shop, leadId, { status: 'placed', sessionId: result.sessionId || null });
    } else {
      // Skipped/scheduled/disabled/quiet-hours/dedupe — keep the reason for the UI.
      updateLead(shop, leadId, { status: 'skipped', disposition: result?.reason || 'skipped' });
    }
    return { ...result, leadId };
  } catch (err) {
    // Telenow placement threw (network/4xx). Release the dedupe mark so a genuine
    // redelivery can retry, and record the failure on the lead.
    if (dedupeKey) clearAttempt(dedupeKey);
    updateLead(shop, leadId, { status: 'failed', disposition: err.message });
    throw err;
  }
}
