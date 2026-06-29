// ─────────────────────────────────────────────────────────────────────────────
// auth.js — Shopify OAuth (offline) install + callback.
//
// Routes:
//   GET /auth?shop=<store>.myshopify.com   → start OAuth (redirects to Shopify)
//   GET /auth/callback                     → finish OAuth, persist offline token,
//                                            register Shopify webhooks, subscribe
//                                            to Telenow result webhooks.
//
// After install we send the merchant to /app (the settings page).
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';

import { shopify, HOST } from './shopify.js';
import { saveShop } from './store.js';
import { mintSessionToken } from './session.js';
import { getSettings } from './settings.js';
import { ensureTelenowHook } from './webhooks/telenow.js';
import { WEBHOOK_TOPICS } from './webhooks/shopify.js';

export const authRouter = express.Router();

const CALLBACK_PATH = '/auth/callback';

/** Basic shop-domain validation to avoid open-redirect / SSRF via ?shop=. */
function isValidShop(shop) {
  return typeof shop === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}

// ── Begin OAuth ───────────────────────────────────────────────────────────────
authRouter.get('/auth', async (req, res) => {
  const shop = shopify.utils.sanitizeShop(req.query.shop, true);
  if (!shop || !isValidShop(shop)) {
    res.status(400).send('Missing or invalid ?shop=<store>.myshopify.com');
    return;
  }
  // shopify.auth.begin writes the redirect to the raw response itself.
  await shopify.auth.begin({
    shop,
    callbackPath: CALLBACK_PATH,
    isOnline: false, // offline token (long-lived, server-to-server)
    rawRequest: req,
    rawResponse: res,
  });
});

// ── OAuth callback ────────────────────────────────────────────────────────────
authRouter.get(CALLBACK_PATH, async (req, res) => {
  try {
    const { session } = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    // Persist the offline session (access token) for Admin API calls.
    saveShop(session.shop, {
      accessToken: session.accessToken,
      scope: session.scope,
      sessionId: session.id,
    });

    // Register Shopify webhooks for this shop (idempotent).
    await registerShopifyWebhooks(session);

    // Subscribe to Telenow call-result webhooks if the merchant already set an
    // API key (they may set it later in /app — ensureTelenowHook is also called
    // from the settings save path).
    try {
      const settings = getSettings(session.shop);
      if (settings.telenowApiKey) {
        await ensureTelenowHook(session.shop);
      }
    } catch (err) {
      console.error(`[auth] Telenow hook setup skipped for ${session.shop}:`, err.message);
    }

    console.log(`[auth] installed for ${session.shop}`);

    // Send the merchant to the settings page. Mint a signed session token and
    // pass it via the URL FRAGMENT (not query/logs) — the UI reads it from
    // location.hash and sends it as a Bearer token on every /api/* call.
    const token = mintSessionToken(session.shop);
    res.redirect(`/app?shop=${encodeURIComponent(session.shop)}#t=${encodeURIComponent(token)}`);
  } catch (err) {
    console.error('[auth] OAuth callback failed:', err);
    res.status(500).send(`OAuth failed: ${err.message}`);
  }
});

/**
 * Register all Shopify webhook topics for a freshly-installed (or re-auth'd)
 * shop. The handlers themselves are registered once at boot via addHandlers()
 * in webhooks/shopify.js; here we just tell Shopify to start delivering.
 * @param {import('@shopify/shopify-api').Session} session
 */
async function registerShopifyWebhooks(session) {
  try {
    const result = await shopify.webhooks.register({ session });
    // result is a map of topic → [{ success, ... }]; log failures only.
    for (const [topic, outcomes] of Object.entries(result)) {
      for (const o of outcomes) {
        if (!o.success) {
          console.error(`[auth] webhook register failed: ${topic}`, o.result || o);
        }
      }
    }
    console.log(`[auth] registered ${WEBHOOK_TOPICS.length} webhook topics for ${session.shop}`);
  } catch (err) {
    console.error(`[auth] webhook registration error for ${session.shop}:`, err.message);
  }
}

/**
 * Tiny landing helper: if someone hits "/" with ?shop=, kick off install;
 * otherwise show a one-line hint. Mounted by server.js.
 */
export function rootHandler(req, res) {
  const shop = req.query.shop;
  if (shop && isValidShop(String(shop))) {
    res.redirect(`/auth?shop=${encodeURIComponent(String(shop))}`);
    return;
  }
  res
    .status(200)
    .type('html')
    .send(
      `<h1>Telenow for Shopify</h1>
       <p>Install by visiting <code>${HOST}/auth?shop=YOUR-STORE.myshopify.com</code></p>
       <p>Already installed? Open the <a href="/app">settings page</a> (add <code>?shop=</code>).</p>`,
    );
}
