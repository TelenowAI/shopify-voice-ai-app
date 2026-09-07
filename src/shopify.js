// ─────────────────────────────────────────────────────────────────────────────
// shopify.js — @shopify/shopify-api configuration + Admin REST helpers.
//
// Builds the singleton `shopify` instance used for OAuth and Shopify-webhook
// HMAC verification, and exposes thin helpers to write call outcomes back onto
// orders (tags + notes) via the Admin REST API.
//
// We use OFFLINE sessions (long-lived token, no online user) because all our
// work is server-to-server reacting to webhooks/cron — there is no logged-in
// merchant in the request.
//
// NOTE on API versions: two separate versions are in play here.
//
//   1. The library version below (apiVersion in shopifyApi). This is what every
//      webhook subscription created at install is stamped with, so it must be a
//      version Shopify still supports — subscriptions cannot be re-stamped in
//      place later without deleting and recreating them.
//   2. SHOPIFY_API_VERSION, used only for the direct Admin REST write-back calls
//      further down (order tags/notes/metafields).
//
// Keep them in sync where you can. They are separate constants only because the
// REST version is env-overridable for a merchant on an older contract.
// (An earlier note here claimed the v13 enum had dropped 2025-10 — it has not;
// the enum runs October24 through July26.)
// ─────────────────────────────────────────────────────────────────────────────

import '@shopify/shopify-api/adapters/node'; // MUST be imported before shopifyApi
import { shopifyApi, ApiVersion, LogSeverity } from '@shopify/shopify-api';

import { getShop } from './store.js';
import { getSettings, updateSettings } from './settings.js';
import { billingConfig } from './plans.js';

// ── Config from env ──────────────────────────────────────────────────────────

// The app's public origin. An explicit HOST always wins.
//
// RENDER_EXTERNAL_URL is injected automatically into every Render web service,
// so a Render deploy needs no extra configuration. It is always the
// *.onrender.com URL and never a custom domain — put a custom domain in front
// and you must set HOST explicitly.
//
// NOTE: SHOPIFY_APP_URL is deliberately NOT consulted here. It is set by the
// Shopify CLI during `shopify app dev` and is read only by scripts/dev-cli.js.
// Setting it in production looks right and does nothing.
const HOST = (
  process.env.HOST || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'
).replace(/\/$/, '');
const hostName = HOST.replace(/^https?:\/\//, '');
const isHttps = HOST.startsWith('https://');

/**
 * Fail the boot if HOST is unset, still a placeholder, or not HTTPS.
 *
 * HOST is the single value that the OAuth redirect_uri, the Shopify webhook
 * target and the Telenow webhook target are all built from — and the Telenow
 * one is registered REMOTELY and persists. Booting with the localhost fallback
 * above therefore does not just serve wrong links: it writes
 * "http://localhost:3000/telenow/webhook" into Telenow as a permanent delivery
 * address, and nothing about the running process looks unhealthy afterwards
 * (/healthz still returns 200).
 *
 * Deliberately NOT run at import: scripts/seed-demo.js and test/roundtrip.mjs
 * load this module without a public host, and the warn-don't-throw stance below
 * exists for the same reason. server.js calls this immediately before listen().
 */
export function assertHostConfig() {
  const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(hostName);

  if (!process.env.HOST && !process.env.RENDER_EXTERNAL_URL) {
    throw new Error(
      '[shopify] HOST is not set. Set it to this app\'s public origin with no trailing ' +
        'slash, e.g. https://your-app.onrender.com. (SHOPIFY_APP_URL is a Shopify-CLI ' +
        'dev variable and is never read by this server — setting it has no effect.)',
    );
  }
  // The shipped templates carry example.com; catching it here is what stops a
  // half-edited .env.production from reaching Shopify and Telenow.
  if (/(^|\.)example\.com$/.test(hostName) || hostName.startsWith('your-tunnel')) {
    throw new Error(`[shopify] HOST is still a placeholder (${HOST}) — set your real domain.`);
  }
  if (!isHttps && !isLocal) {
    throw new Error(`[shopify] HOST must be https:// in production (got ${HOST}).`);
  }
}

export const SCOPES = (
  process.env.SHOPIFY_SCOPES ||
  'read_orders,write_orders,read_customers,read_checkouts,read_fulfillments'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** REST Admin API version used for write-backs (independent of the lib version). */
export const REST_API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-10';

if (!process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_SECRET) {
  // Don't throw at import time (lets tooling/lindex load the module), but warn loudly.
  console.warn(
    '[shopify] SHOPIFY_API_KEY / SHOPIFY_API_SECRET are not set — OAuth will fail until they are.',
  );
}

// ── The singleton library instance ───────────────────────────────────────────

export const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY || 'missing-api-key',
  apiSecretKey: process.env.SHOPIFY_API_SECRET || 'missing-api-secret',
  scopes: SCOPES,
  hostName,
  hostScheme: isHttps ? 'https' : 'http',
  // Library version for OAuth + webhook HMAC, and the version every webhook
  // subscription is stamped with at install. July26 (2026-07) is the newest the
  // installed v13 enum offers and the current Shopify stable; the previous
  // January25 (2025-01) is past Shopify's 12-month support window.
  apiVersion: ApiVersion.July26,
  // Embedded: the settings page renders inside the Shopify admin through App
  // Bridge, which is what gives the app its entry in the admin nav. Requires the
  // page to send App Bridge session tokens - see verifyAnySessionToken in session.js.
  isEmbeddedApp: true,
  // The plan catalogue, keyed by the merchant-visible subscription name. This is
  // not decoration: shopify.billing.check(), .request() and .cancel() all read
  // config.billing and throw BillingError when it is absent, so leaving it unset
  // does not disable billing — it makes every entitlement read fail. billing.js
  // swallows that failure and serves the cached-or-Starter entitlement, so the
  // symptom of forgetting this line is not a crash but every paying merchant
  // silently dropping to the free tier. plans.js owns the shape; see the note
  // above billingConfig() for why starter is deliberately absent from it.
  billing: billingConfig(),
  logger: { level: LogSeverity.Warning },
});

export { HOST };

// ─────────────────────────────────────────────────────────────────────────────
// Admin REST write-back helpers
//
// We call the Admin REST API directly with fetch + the offline access token so
// we don't have to bundle the library's generated REST resources. These are the
// only writes the app performs.
// ─────────────────────────────────────────────────────────────────────────────

/** Build the Admin REST base for a shop, e.g. https://x.myshopify.com/admin/api/2025-10 */
function adminBase(shop) {
  return `https://${shop}/admin/api/${REST_API_VERSION}`;
}

/** Authenticated Admin REST request. Returns parsed JSON (or null). */
async function adminRequest(shop, method, path, body) {
  const session = getShop(shop);
  if (!session?.accessToken) {
    throw new Error(`No offline session for ${shop} — is the app installed?`);
  }
  const res = await fetch(`${adminBase(shop)}${path}`, {
    method,
    headers: {
      'X-Shopify-Access-Token': session.accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = data?.errors || data?.error || `Shopify ${method} ${path} → ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

/** Fetch a single order (used to read existing tags before appending). */
export async function getOrder(shop, orderId, fields = 'id,tags,note') {
  const data = await adminRequest(
    shop,
    'GET',
    `/orders/${orderId}.json?fields=${encodeURIComponent(fields)}`,
  );
  return data?.order;
}

/**
 * Append one or more tags to an order without clobbering existing tags.
 * Shopify stores tags as a single comma-separated string.
 * @param {string} shop
 * @param {string|number} orderId
 * @param {string|string[]} tags
 */
export async function addOrderTags(shop, orderId, tags) {
  const wanted = (Array.isArray(tags) ? tags : [tags]).map((t) => t.trim()).filter(Boolean);
  if (wanted.length === 0) return;

  const order = await getOrder(shop, orderId, 'id,tags');
  const existing = (order?.tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const merged = Array.from(new Set([...existing, ...wanted]));
  // No change → skip the write.
  if (merged.length === existing.length) return;

  return adminRequest(shop, 'PUT', `/orders/${orderId}.json`, {
    order: { id: Number(orderId) || orderId, tags: merged.join(', ') },
  });
}

/**
 * Append a line to the order note (preserving any existing note).
 * @param {string} shop @param {string|number} orderId @param {string} line
 */
export async function appendOrderNote(shop, orderId, line) {
  if (!line) return;
  const order = await getOrder(shop, orderId, 'id,note');
  const existing = order?.note ? `${order.note}\n` : '';
  const note = `${existing}${line}`.slice(0, 5000); // Shopify note cap safety
  return adminRequest(shop, 'PUT', `/orders/${orderId}.json`, {
    order: { id: Number(orderId) || orderId, note },
  });
}

/**
 * Write a metafield onto an order (namespace "telenow"). Useful for storing
 * structured call outcome (session id, disposition) for theme/app access.
 * @param {string} shop
 * @param {string|number} orderId
 * @param {string} key
 * @param {string} value
 * @param {string} [type='single_line_text_field']
 */
export async function setOrderMetafield(shop, orderId, key, value, type = 'single_line_text_field') {
  return adminRequest(shop, 'POST', `/orders/${orderId}/metafields.json`, {
    metafield: { namespace: 'telenow', key, type, value: String(value) },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin GraphQL
//
// One authenticated GraphQL call, raw fetch, same offline token as the REST
// helpers above. It is raw fetch rather than the library's GraphqlClient for the
// same reason adminRequest() is: the client wants a Session object, and every
// caller here has only a shop domain and the stored offline token.
//
// The subtlety worth keeping in one place: GraphQL answers HTTP 200 with an
// `errors` array. A caller that only checks res.ok reads `undefined` off a
// failed query and treats it as an empty result — which for the billing paths is
// the difference between "this shop has no subscription" and "we could not ask".
// Both failure modes throw here so no caller can quietly get that wrong.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a GraphQL query/mutation against a shop's Admin API.
 *
 * Returns the UNWRAPPED `data` payload (so `res.orders`, not `res.data.orders`).
 *
 * @param {string} shop
 * @param {string} query   GraphQL document
 * @param {object} [variables]
 * @returns {Promise<object>} the `data` object from the response
 * @throws on a missing session, a non-2xx response, unparseable JSON, or a
 *         populated `errors` array.
 */
export async function adminGraphQL(shop, query, variables = {}) {
  const session = getShop(shop);
  if (!session?.accessToken) {
    throw new Error(`No offline session for ${shop} — is the app installed?`);
  }

  const res = await fetch(`https://${shop}/admin/api/${REST_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': session.accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // 401/403 here almost always means the offline token was revoked without an
    // app/uninstalled webhook reaching us; surfacing the status keeps that
    // diagnosable. Never echo the body — it can carry request context we do not
    // want in logs.
    throw new Error(`Shopify GraphQL → ${res.status}`);
  }
  if (data?.errors?.length) {
    throw new Error(data.errors[0]?.message || 'Shopify GraphQL error');
  }
  if (!data || typeof data !== 'object') {
    throw new Error('Shopify GraphQL returned a non-JSON body');
  }
  return data.data ?? {};
}

/**
 * Orders this app's agents have flagged, newest first.
 *
 * GraphQL rather than REST because REST cannot filter by tag at all — it would
 * mean pulling every order and filtering in memory. `tag:telenow-*` matches the
 * tags the automations write (telenow-cod-cancelled, telenow-rto-refused, ...).
 *
 * @param {string} shop
 * @param {number} [limit=50]
 * @returns {Promise<Array<object>>}
 */
export async function findFlaggedOrders(shop, limit = 50) {
  const query = `query FlaggedOrders($n: Int!) {
    orders(first: $n, reverse: true, query: "tag:telenow-*") {
      edges { node {
        id name createdAt tags note displayFulfillmentStatus displayFinancialStatus
        totalPriceSet { shopMoney { amount currencyCode } }
        customer { firstName lastName phone }
      } }
    }
  }`;
  // Shopify rejects `first` above 250 and below 1; clamping to 100 keeps the
  // response inside the default query-cost budget on shops with fat orders.
  const data = await adminGraphQL(shop, query, { n: Math.min(Math.max(limit, 1), 100) });
  return (data?.orders?.edges || []).map((e) => e.node).filter(Boolean);
}

/**
 * Fetch the merchant shop profile for display in the embedded UI (name, owner,
 * contact email, plan, currency, timezone). Uses the offline token stored at
 * install, so it works without a logged-in user.
 * @param {string} shop
 * @returns {Promise<object>} the Admin API `shop` object
 */
export async function getShopProfile(shop) {
  const fields = [
    "id", "name", "email", "domain", "myshopify_domain", "shop_owner",
    "plan_display_name", "currency", "iana_timezone", "country_name",
    "phone", "primary_locale", "created_at",
  ].join(",");
  const data = await adminRequest(shop, "GET", "/shop.json?fields=" + encodeURIComponent(fields));
  return data?.shop ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shop country
//
// The store's own country decides which digits we dial. Every phone number this
// app touches arrives from a Shopify payload in whatever format that merchant's
// shoppers type, and turning "9876543210" into an E.164 number requires knowing
// the country to prefix. The app used to answer that question with a module-level
// 'IN' constant, which is correct for exactly one market and silently dials the
// wrong country for every other — including the North-American reviewer whose
// test call decides whether this app stays listed.
//
// So: ask Shopify, once, and cache it. `billingAddress.countryCodeV2` is the
// right field rather than `shop.country_name` (which getShopProfile already
// reads for display): it is a CountryCode enum, so it comes back as a stable
// ISO-3166-1 alpha-2 token we can key a dial-code table on, whereas the REST
// profile's `country_name` is a localised display string ("United States") that
// no lookup table should ever be keyed on.
//
// The cache lives on the settings row rather than in a module Map because the
// dialling paths that need it are cron sweeps and webhook handlers — processes
// that may have booted seconds ago and have no warm memory — and because a
// process-wide Map is exactly the multi-tenant bug (one server, one assumed
// country) this change exists to remove.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a shop's ISO-3166-1 alpha-2 country, cached on settings.shopCountry.
 *
 * NEVER THROWS. A country lookup is an enrichment, not a precondition: an
 * uninstalled shop, a revoked offline token, a GraphQL error and a Shopify
 * outage all return null, and the caller falls through the shared resolver
 * (explicit argument → shopCountry → DEFAULT_PHONE_COUNTRY → 'US'). A throw here
 * would take down the call path it was meant to improve.
 *
 * @param {string} shop myshopify domain
 * @returns {Promise<string|null>} 'US' | 'IN' | … or null when unresolvable
 */
export async function getShopCountry(shop) {
  const domain = String(shop || '').trim();
  if (!domain) return null;

  try {
    // Cached value wins with no network round trip. Only a well-formed ISO-2
    // token counts as cached — anything else (a legacy blob, a hand-edited
    // store.json, a country name that leaked in from somewhere) is treated as
    // unresolved and re-fetched, rather than being handed to a dial-code lookup
    // that would quietly return null and drop the call.
    const cached = normalizeCountryIso(getSettings(domain).shopCountry);
    if (cached) return cached;

    const data = await adminGraphQL(
      domain,
      `query ShopCountry { shop { billingAddress { countryCodeV2 } } }`,
    );
    const iso = normalizeCountryIso(data?.shop?.billingAddress?.countryCodeV2);
    if (!iso) return null;

    // Write-through, best effort. A persistence failure must not turn a
    // successful lookup into a null — the value we just fetched is still
    // correct for this request, we simply pay for the query again next time.
    try {
      updateSettings(domain, { shopCountry: iso });
    } catch (err) {
      console.warn(`[shopify] could not cache shopCountry for ${domain}: ${err.message}`);
    }
    return iso;
  } catch (err) {
    console.warn(`[shopify] shop country lookup failed for ${domain}: ${err.message}`);
    return null;
  }
}

/**
 * Accept only a real ISO-3166-1 alpha-2 code.
 *
 * 'ZZ' is rejected on purpose: it is a real member of Shopify's CountryCode enum
 * meaning "Unknown Region", so it arrives looking like a valid two-letter answer
 * while carrying no dialling information at all. Caching it would pin the shop
 * to a country that can never resolve to a dial code, and — because a cached
 * value short-circuits the fetch — would do so permanently.
 */
function normalizeCountryIso(value) {
  const iso = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(iso) || iso === 'ZZ') return null;
  return iso;
}
