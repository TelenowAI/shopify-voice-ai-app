// ─────────────────────────────────────────────────────────────────────────────
// util/phone.js — E.164 normalization and country resolution.
//
// Telenow's initiate-call API requires E.164 numbers (e.g. +14155550123).
// Shopify gives us phone numbers in wildly inconsistent shapes: local format,
// with spaces/dashes/parens, "00" international prefix, etc. This helper does a
// best-effort normalization WITHOUT pulling in a heavy lib (libphonenumber).
//
// For correctness across all countries, swap this for `libphonenumber-js` in
// production. We keep it dependency-free and good enough for the common cases,
// with a configurable default country dialing code.
//
// This module is also the single place that answers "which country do we assume
// when a number has no country code?" — see resolveCountry(). Nothing else in
// the app may hardcode that answer; a per-process constant is wrong on a
// multi-tenant server where each shop sells into a different market.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// COUNTRY_DIAL_CODES
//
// THIS IS A DIAL-CODE MAP, NOT A VALIDATOR. It answers exactly one question —
// "what digits go in front of a local number from country X?" — and nothing
// else. It does not know national number lengths, valid mobile prefixes, area
// codes, or whether the result is a number that can actually be rung.
// libphonenumber-js remains the real answer for validation; if this file ever
// needs to *reject* a number rather than shape one, take the dependency instead
// of growing this table into a half-parser.
//
// Why it is large: a country missing from this map makes toE164() return null,
// which makes extractPhone() return null, which makes the automation skip the
// call with "no valid phone number on payload". Seven entries meant a German,
// Brazilian or Mexican merchant's local-format numbers were silently undialable.
// The coverage below is the set of markets Shopify merchants actually sell from:
// all of North America, Western/Northern/Central Europe, the Gulf and Levant,
// South and South-East Asia, East Asia, ANZ, and the larger Latin American and
// African markets. NANP territories (+1) are listed individually because a
// merchant's shop country is 'JM' or 'DO', never 'NANP'.
// ─────────────────────────────────────────────────────────────────────────────
const COUNTRY_DIAL_CODES = Object.freeze({
  // ── North America / NANP ──────────────────────────────────────────────────
  US: '1',
  CA: '1',
  MX: '52',
  PR: '1',
  DO: '1',
  JM: '1',
  TT: '1',
  BS: '1',
  BB: '1',

  // ── Latin America ─────────────────────────────────────────────────────────
  BR: '55',
  AR: '54',
  CL: '56',
  CO: '57',
  PE: '51',
  EC: '593',
  UY: '598',
  PY: '595',
  BO: '591',
  VE: '58',
  CR: '506',
  PA: '507',
  GT: '502',
  SV: '503',
  HN: '504',
  NI: '505',

  // ── Western / Northern / Southern Europe ──────────────────────────────────
  GB: '44',
  IE: '353',
  FR: '33',
  DE: '49',
  ES: '34',
  PT: '351',
  IT: '39',
  NL: '31',
  BE: '32',
  LU: '352',
  CH: '41',
  AT: '43',
  DK: '45',
  SE: '46',
  NO: '47',
  FI: '358',
  IS: '354',
  GR: '30',
  MT: '356',
  CY: '357',

  // ── Central / Eastern Europe ──────────────────────────────────────────────
  PL: '48',
  CZ: '420',
  SK: '421',
  HU: '36',
  RO: '40',
  BG: '359',
  HR: '385',
  SI: '386',
  RS: '381',
  BA: '387',
  MK: '389',
  AL: '355',
  EE: '372',
  LV: '371',
  LT: '370',
  UA: '380',
  MD: '373',
  BY: '375',
  RU: '7',
  KZ: '7',
  GE: '995',
  AM: '374',
  AZ: '994',
  UZ: '998',
  TR: '90',

  // ── Gulf / Middle East ────────────────────────────────────────────────────
  AE: '971',
  SA: '966',
  QA: '974',
  KW: '965',
  BH: '973',
  OM: '968',
  JO: '962',
  LB: '961',
  IL: '972',
  IQ: '964',

  // ── South Asia ────────────────────────────────────────────────────────────
  IN: '91',
  PK: '92',
  BD: '880',
  LK: '94',
  NP: '977',
  MV: '960',
  BT: '975',
  AF: '93',

  // ── South-East Asia ───────────────────────────────────────────────────────
  SG: '65',
  MY: '60',
  ID: '62',
  TH: '66',
  VN: '84',
  PH: '63',
  KH: '855',
  LA: '856',
  MM: '95',
  BN: '673',

  // ── East Asia ─────────────────────────────────────────────────────────────
  CN: '86',
  HK: '852',
  MO: '853',
  TW: '886',
  JP: '81',
  KR: '82',
  MN: '976',

  // ── Oceania ───────────────────────────────────────────────────────────────
  AU: '61',
  NZ: '64',
  FJ: '679',
  PG: '675',

  // ── Africa ────────────────────────────────────────────────────────────────
  ZA: '27',
  NG: '234',
  KE: '254',
  GH: '233',
  EG: '20',
  MA: '212',
  TN: '216',
  DZ: '213',
  TZ: '255',
  UG: '256',
  RW: '250',
  ET: '251',
  SN: '221',
  CI: '225',
  CM: '237',
  ZM: '260',
  ZW: '263',
  BW: '267',
  NA: '264',
  MZ: '258',
  AO: '244',
  MU: '230',
});

// A handful of countries write local numbers behind a trunk prefix that is not
// "0" — Russia, Kazakhstan, Belarus, Uzbekistan and Lithuania all use "8". The
// generic leading-zero strip below never touched those, so "8 916 123 45 67"
// would have become +78916123456 7 — a real-looking but wrong number. Keyed by
// country so it can never affect a market whose local numbers legitimately
// begin with 8 (Indian mobiles, for one).
const TRUNK_PREFIX_8 = new Set(['RU', 'KZ', 'BY', 'UZ', 'LT']);

// The mirror-image case: countries whose local numbers begin with a "0" that is
// NOT a trunk prefix but part of the subscriber number, and must therefore
// survive into E.164.
//
//   IT  Italy kept the leading 0 on landlines when it closed its numbering plan
//       in 1998. Rome is +39 06 …, Milan +39 02 … — the zero is dialled from
//       abroad. (Italian mobiles have no leading zero: +39 3xx …, so the rule
//       here is "never strip", not "always add".)
//   CI  Côte d'Ivoire migrated to a closed 10-digit plan in 2021 with no trunk
//       prefix; every number begins 01/05/07/25/27 and is written that way
//       internationally: +225 07 …
//
// Stripping the zero for these two produces a well-formed, plausible, entirely
// unroutable number — the silent-failure mode this module exists to avoid. Note
// this matters only for LOCAL input: a number already written with "+" or "00"
// never reaches the trunk rules at all.
const TRUNK_ZERO_IS_SIGNIFICANT = new Set(['IT', 'CI']);

// ─────────────────────────────────────────────────────────────────────────────
// EXAMPLE_NUMBERS
//
// Purely for merchant-facing hints and placeholders ("Enter a number in E.164
// form, e.g. …"). Never dialled, never validated against.
//
// Where a regulator reserves a range for fiction/documentation we use it, so an
// example can never be a real person's phone ringing because a merchant typed
// the placeholder instead of their own number:
//   US/CA  555-0100…555-0199   (NANP fictitious range)
//   GB     07700 900xxx        (Ofcom drama range)
//   AU     0491 570 xxx        (ACMA fictitious range)
//   DE     (0)30 23125 xxx     (BNetzA documentation block)
//   FR     06 39 98 xx xx      (ARCEP fictional range)
// Most countries reserve nothing. For those we use an obviously-patterned
// number that is well-formed for the country but not a plausible allocation —
// it teaches the shape (+cc then national digits) without pretending to be real.
// ─────────────────────────────────────────────────────────────────────────────
const EXAMPLE_NUMBERS = Object.freeze({
  US: '+14155550123',
  CA: '+16045550123',
  MX: '+525500000000',
  BR: '+5511900000000',
  AR: '+5491100000000',
  CL: '+56900000000',
  CO: '+573000000000',
  GB: '+447700900123',
  IE: '+353850000000',
  FR: '+33639980123',
  DE: '+493023125100',
  ES: '+34600000000',
  PT: '+351900000000',
  IT: '+393000000000',
  NL: '+31600000000',
  BE: '+32470000000',
  CH: '+41760000000',
  AT: '+436600000000',
  DK: '+4520000000',
  SE: '+46700000000',
  NO: '+4740000000',
  FI: '+358400000000',
  PL: '+48500000000',
  RO: '+40700000000',
  GR: '+306900000000',
  TR: '+905000000000',
  AE: '+971500000000',
  SA: '+966500000000',
  QA: '+97430000000',
  KW: '+96550000000',
  IL: '+972500000000',
  IN: '+919876543210',
  PK: '+923000000000',
  BD: '+8801700000000',
  LK: '+94700000000',
  SG: '+6580000000',
  MY: '+60120000000',
  ID: '+6281000000000',
  TH: '+66800000000',
  VN: '+84900000000',
  PH: '+639000000000',
  CN: '+8613000000000',
  HK: '+85250000000',
  JP: '+818000000000',
  KR: '+821000000000',
  AU: '+61491570156',
  NZ: '+64210000000',
  ZA: '+27600000000',
  NG: '+2348000000000',
  KE: '+254700000000',
  EG: '+201000000000',
  MA: '+212600000000',
});

/**
 * Normalize an ISO-3166-1 alpha-2 country code, or return null.
 * Anything that is not exactly two letters we KNOW the dial code for is
 * rejected — a country we cannot prefix is no better than no country at all.
 *
 * @param {unknown} value
 * @returns {string|null} Upper-case ISO-2, or null.
 */
function normalizeCountry(value) {
  if (typeof value !== 'string') return null;
  const iso = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(iso)) return null;
  return COUNTRY_DIAL_CODES[iso] ? iso : null;
}

/**
 * THE single place in this app that decides which country an unqualified local
 * number belongs to. Every caller of toE164()/extractPhone() inside the app
 * resolves through here and passes the answer down; nothing re-implements the
 * order, and no module-level constant is allowed to stand in for it.
 *
 * Order: explicit argument → the shop's own country (from Shopify) →
 * DEFAULT_PHONE_COUNTRY from the environment → 'US'.
 *
 * A candidate we do not recognise is treated as absent and the next one is
 * tried, so a typo'd env var cannot override a country we actually know.
 *
 * WHY 'US' AND NOT 'IN' AS THE LAST RESORT. The old default was India, and it
 * was the worst possible guess for two reasons. First, distribution: the
 * Shopify merchant base skews heavily North American, so an unqualified local
 * number is far likelier to be a NANP number than an Indian one. Second, and
 * more important, the two guesses fail differently. A wrong '+1' on a 10-digit
 * Indian number produces a number that is obviously wrong and usually fails
 * loudly; a wrong '+91' on a 10-digit US number produces a well-formed,
 * plausible-looking Indian number that is simply unroutable — the call is
 * placed, nobody answers, and nothing in any log says why. Prefer the guess
 * that breaks visibly over the guess that breaks silently.
 *
 * @param {object} [opts]
 * @param {string} [opts.explicit]      Caller-supplied country, wins outright.
 * @param {string} [opts.shopCountry]   settings.shopCountry, resolved from Shopify.
 * @param {string} [opts.envDefault]    process.env.DEFAULT_PHONE_COUNTRY.
 * @returns {string} Upper-case ISO-2 country we hold a dial code for.
 */
export function resolveCountry({ explicit, shopCountry, envDefault } = {}) {
  return (
    normalizeCountry(explicit) ||
    normalizeCountry(shopCountry) ||
    normalizeCountry(envDefault) ||
    'US'
  );
}

/**
 * A realistic-looking E.164 example for a country, for placeholders and error
 * hints. Falls back to the US example for anything we have no entry for, which
 * matches resolveCountry()'s last resort — a merchant should never be shown
 * "+91…" unless their own market is India.
 *
 * @param {string} [country]  ISO-2, any case.
 * @returns {string} E.164 example, never null.
 */
export function exampleNumberFor(country) {
  const iso = normalizeCountry(country);
  return (iso && EXAMPLE_NUMBERS[iso]) || EXAMPLE_NUMBERS.US;
}

/**
 * Normalize a phone number to E.164 (`+<digits>`).
 *
 * @param {string} raw            The phone number from Shopify (any format).
 * @param {string} [defaultCountry='IN']  ISO-2 country to assume when the number
 *                                 has no country code (local format).
 *                                 THE 'IN' DEFAULT IS A LAST RESORT KEPT ONLY
 *                                 FOR EXISTING CALLERS OUTSIDE THIS APP — every
 *                                 caller inside this app MUST pass a country
 *                                 resolved through resolveCountry() rather than
 *                                 relying on it. An unrecognised country makes
 *                                 this return null instead of guessing.
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

  // No "+": this is (probably) a local number — with one exception first.
  //
  // A "00" international prefix can survive to here when the raw string did not
  // *begin* with it, e.g. "(0044) 20 7946 0958" or "tel:0039 06 …", because the
  // check above ran against the untrimmed-of-punctuation string. No numbering
  // plan writes a local number behind two zeros, so a leading "00" in the digit
  // run is always the international prefix. Handle it before the trunk rules,
  // which would otherwise mistake those zeros for trunk digits and prefix a
  // country code on top of one that is already there.
  if (digits.startsWith('00')) {
    return sanityCheck(`+${digits.replace(/^0+/, '')}`);
  }

  const iso = (defaultCountry || 'IN').toUpperCase();
  const cc = COUNTRY_DIAL_CODES[iso];
  if (!cc) return null; // unknown default country — can't safely prefix

  // Many countries write local numbers behind a trunk "0" (UK, IN, DE, AU …).
  // Drop exactly ONE zero — never a run of them. A greedy `/^0+/` strip turns
  // Rome's "06 1234 5678" into +39612345678 rather than +390612345678: a
  // well-formed, plausible, unroutable number that nothing logs a reason for,
  // and one that disagrees with what the *same* number typed as "0039 06 …"
  // produces. Countries whose leading zero is part of the subscriber number
  // keep it (see TRUNK_ZERO_IS_SIGNIFICANT).
  if (digits.startsWith('0') && !TRUNK_ZERO_IS_SIGNIFICANT.has(iso)) {
    digits = digits.slice(1);
    if (!digits) return null;
  }

  // Trunk-"8" countries (RU/KZ/BY/UZ/LT). Only drop it when what remains is not
  // already an international-length number that begins with the country code,
  // so a number written as "7 916 …" is left alone.
  if (TRUNK_PREFIX_8.has(iso) && digits.length > 1 && digits.startsWith('8')) {
    const stripped = digits.slice(1);
    if (!(stripped.startsWith(cc) && stripped.length >= cc.length + 9)) {
      digits = stripped;
    }
  }

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
 * @param {string} [defaultCountry='IN']  Same last-resort caveat as toE164():
 *                         callers inside this app must pass a country resolved
 *                         through resolveCountry(), not lean on the default.
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

/**
 * The countries this module can prefix a local number for. Exported read-only
 * so a caller can offer a country picker without duplicating the table.
 */
export { COUNTRY_DIAL_CODES };
