// ─────────────────────────────────────────────────────────────────────────────
// session.js — signed session token for the embedded app's /api/* data routes.
//
// The data routes used to authenticate on the non-secret ?shop= query param, so
// anyone who knew/guessed another tenant's shop could read its leads (PII) and
// overwrite its Telenow API key / agent ids / automations (IDOR). We instead mint
// a short-lived signed token at the VERIFIED OAuth callback and require it (in the
// Authorization header) on every /api/* request, deriving the shop FROM the token.
//
// Scheme mirrors the proven Magento RecoveryUrl HMAC token:
//   token = base64url("<shop>.<exp>.<hmac>")
//   hmac  = HMAC-SHA256("<shop>.<exp>", APP_SECRET)
//   exp   = now + 8h
// Verify: base64url-decode → split into exactly 3 → constant-time compare on the
// hmac → reject if expired → return shop. APP_SECRET is the app's existing secret
// (SHOPIFY_API_SECRET). If it's unset the token can't be minted/verified — degrade
// safely (mint returns '', verify returns null → 401).
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';

import { shopify } from './shopify.js';

const TTL_SECONDS = 8 * 60 * 60; // 8h

function appSecret() {
  return process.env.SHOPIFY_API_SECRET || '';
}

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  const padded = pad ? b64 + '='.repeat(4 - pad) : b64;
  try {
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Mint a signed session token bound to `shop` and an 8h expiry.
 * @param {string} shop
 * @returns {string} base64url token, or '' if no APP_SECRET (can't sign).
 */
export function mintSessionToken(shop) {
  const key = appSecret();
  if (!key || !shop) return '';
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const data = `${shop}.${exp}`;
  const hmac = crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');
  return base64UrlEncode(`${data}.${hmac}`);
}

/**
 * Verify a session token and return the bound shop, or null when the token is
 * missing, malformed, tampered, or expired.
 * @param {string} token
 * @returns {string|null}
 */
export function verifySessionToken(token) {
  const key = appSecret();
  if (!key || !token) return null;

  const decoded = base64UrlDecode(token);
  if (!decoded) return null;

  // "<shop>.<exp>.<hmac>" — the shop itself contains dots (foo.myshopify.com),
  // so split off the LAST two segments (exp, hmac) and treat the rest as shop.
  const parts = decoded.split('.');
  if (parts.length < 3) return null;
  const providedHmac = parts.pop();
  const expPart = parts.pop();
  const shop = parts.join('.');
  if (!shop || !/^\d+$/.test(expPart) || !providedHmac) return null;

  const data = `${shop}.${expPart}`;
  const expectedHmac = crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');

  let equal = false;
  try {
    const a = Buffer.from(providedHmac);
    const b = Buffer.from(expectedHmac);
    equal = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    equal = false;
  }
  if (!equal) return null;

  if (Number(expPart) < Math.floor(Date.now() / 1000)) return null; // expired

  return shop;
}

/**
 * Verify either credential the settings page can present, and return the shop:
 *
 *   1. Our own minted token (above) - used by the standalone/new-tab flow, where
 *      /auth/callback hands it over in the URL fragment.
 *   2. Shopify App Bridge session token - used when the app runs embedded in the
 *      admin. It is an HS256 JWT signed with the same app secret, so the library
 *      validates it for us; the `dest` claim carries the shop domain.
 *
 * Returns null when neither validates. Async because the library JWT check is.
 * @param {string} token
 * @returns {Promise<string|null>}
 */
export async function verifyAnySessionToken(token) {
  if (!token) return null;

  const own = verifySessionToken(token);
  if (own) return own;

  try {
    const payload = await shopify.session.decodeSessionToken(token);
    // `dest` looks like "https://shop.myshopify.com" - strip the scheme.
    const dest = String(payload?.dest || "");
    const shop = dest.startsWith("https://") ? dest.slice(8) : dest;
    // [.] instead of an escaped dot so the pattern survives any quoting.
    const valid = new RegExp("^[a-zA-Z0-9][a-zA-Z0-9-]*[.]myshopify[.]com$");
    return valid.test(shop) ? shop : null;
  } catch {
    return null;
  }
}
