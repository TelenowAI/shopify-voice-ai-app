// ─────────────────────────────────────────────────────────────────────────────
// util/phone.js — E.164 normalization.
//
// Telenow's initiate-call API requires E.164 numbers (e.g. +919876543210).
// Shopify gives us phone numbers in wildly inconsistent shapes: local format,
// with spaces/dashes/parens, "00" international prefix, etc. This helper does a
// best-effort normalization WITHOUT pulling in a heavy lib (libphonenumber).
//
// For correctness across all countries, swap this for `libphonenumber-js` in
// production. We keep it dependency-free and good enough for the common cases,
// with a configurable default country dialing code.
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal map of ISO country → dialing code for the default-country fallback. */
const COUNTRY_DIAL_CODES = {
  IN: '91',
  US: '1',
  CA: '1',
  GB: '44',
  AU: '61',
  AE: '971',
  SG: '65',
  // Extend as needed; or replace this whole module with libphonenumber-js.
};

/**
 * Normalize a phone number to E.164 (`+<digits>`).
 *
 * @param {string} raw            The phone number from Shopify (any format).
 * @param {string} [defaultCountry='IN']  ISO-2 country to assume when the number
 *                                 has no country code (local format).
 * @returns {string|null}         E.164 string, or null if it can't be normalized.
 */
export function toE164(raw, defaultCountry = 'IN') {
  if (!raw || typeof raw !== 'string') return null;

  let s = raw.trim();
  if (!s) return null;

  const hadPlus = s.startsWith('+');

  // Convert a leading "00" international prefix to "+".
  if (!hadPlus && s.startsWith('00')) {
    s = `+${s.slice(2)}`;
  }

  const plus = hadPlus || s.startsWith('+');

  // Strip everything that isn't a digit.
  let digits = s.replace(/\D/g, '');
  if (!digits) return null;

  if (plus) {
    // Already international: trust the country code as given.
    return sanityCheck(`+${digits}`);
  }

  // No "+": this is (probably) a local number. Many countries write local
  // numbers with a trunk "0" prefix (e.g. UK/IN) — drop a single leading 0.
  if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');

  const cc = COUNTRY_DIAL_CODES[(defaultCountry || 'IN').toUpperCase()];
  if (!cc) return null; // unknown default country — can't safely prefix

  // Guard: if the local number already starts with the country code AND is long
  // enough to be a full international number, don't double-prefix it.
  if (digits.startsWith(cc) && digits.length >= cc.length + 10) {
    return sanityCheck(`+${digits}`);
  }

  return sanityCheck(`+${cc}${digits}`);
}

/** Basic E.164 length sanity (max 15 digits). Returns the value or null. */
function sanityCheck(e164) {
  const digits = e164.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

/**
 * Pick the best phone number off a Shopify order/checkout/customer object,
 * checking the usual locations in priority order, and normalize it.
 *
 * @param {object} entity  Shopify order, checkout, or customer payload.
 * @param {string} [defaultCountry]
 * @returns {string|null}  E.164 or null.
 */
export function extractPhone(entity, defaultCountry = 'IN') {
  if (!entity) return null;
  const candidates = [
    entity.phone,
    entity.shipping_address?.phone,
    entity.billing_address?.phone,
    entity.customer?.phone,
    entity.customer?.default_address?.phone,
  ];
  for (const c of candidates) {
    const e164 = toE164(c, defaultCountry);
    if (e164) return e164;
  }
  return null;
}
