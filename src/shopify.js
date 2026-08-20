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
// NOTE on API versions: the library's `ApiVersion` enum (v13) no longer includes
// older versions like 2025-10, so we configure the library with a current,
// supported version for OAuth/webhooks, and use a *separate* configurable REST
// version (SHOPIFY_API_VERSION, default 2025-10 per the Telenow app spec) for
// the direct Admin REST write-back calls below.
// ─────────────────────────────────────────────────────────────────────────────

import '@shopify/shopify-api/adapters/node'; // MUST be imported before shopifyApi
import { shopifyApi, ApiVersion, LogSeverity } from '@shopify/shopify-api';

import { getShop } from './store.js';

// ── Config from env ──────────────────────────────────────────────────────────

const HOST = (process.env.HOST || 'http://localhost:3000').replace(/\/$/, '');
const hostName = HOST.replace(/^https?:\/\//, '');
const isHttps = HOST.startsWith('https://');

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
  // Library version for OAuth + webhook HMAC. Use a current supported version.
  apiVersion: ApiVersion.January25,
  // Embedded: the settings page renders inside the Shopify admin through App
  // Bridge, which is what gives the app its entry in the admin nav. Requires the
  // page to send App Bridge session tokens - see verifyAnySessionToken in session.js.
  isEmbeddedApp: true,
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
