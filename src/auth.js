// ─────────────────────────────────────────────────────────────────────────────
// auth.js — Shopify OAuth (offline) install + callback.
//
// Routes:
//   GET /auth?shop=<store>.myshopify.com   → start OAuth (redirects to Shopify)
//   GET /auth/callback                     → finish OAuth, persist offline token,
//                                            register Shopify webhooks, lease the
//                                            shop's calling workspace.
//
// After install we send the merchant to /app (the settings page).
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';

import { shopify, HOST } from './shopify.js';
import { saveShop, getShop } from './store.js';
import { mintSessionToken } from './session.js';
import { ensureWorkspace } from './provisioning.js';
import { WEBHOOK_TOPICS } from './webhooks/shopify.js';

export const authRouter = express.Router();

const CALLBACK_PATH = '/auth/callback';

/** Basic shop-domain validation to avoid open-redirect / SSRF via ?shop=. */
function isValidShop(shop) {
  return typeof shop === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}

// ── Begin OAuth ───────────────────────────────────────────────────────────────
authRouter.get('/auth', async (req, res) => {
  // sanitizeShop(_, false) returns null instead of throwing, so bad input hits
  // our 400 below rather than escaping as an unhandled rejection (Express 4
  // does not forward async throws to the error middleware — the request would
  // just hang).
  const shop = shopify.utils.sanitizeShop(String(req.query.shop || ''), false);
  if (!shop || !isValidShop(shop)) {
    res.status(400).send('Missing or invalid ?shop=<store>.myshopify.com');
    return;
  }
  try {
    // shopify.auth.begin writes the redirect to the raw response itself.
    await shopify.auth.begin({
      shop,
      callbackPath: CALLBACK_PATH,
      isOnline: false, // offline token (long-lived, server-to-server)
      rawRequest: req,
      rawResponse: res,
    });
  } catch (err) {
    console.error('[auth] OAuth begin failed:', err);
    if (!res.headersSent) res.status(500).send(`OAuth failed: ${err.message}`);
  }
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

    // Lease this shop a calling workspace so the app is usable the moment the
    // merchant lands on /app — there is no key field for them to fill in any
    // more. ensureWorkspace registers the call-result webhook itself, which is
    // why the old ensureTelenowHook call is gone from here.
    //
    // Provisioning is deliberately NOT allowed to block or fail the redirect.
    // The install is already complete and durable at this point (the offline
    // token is saved); a pool that is momentarily empty, or a Telenow blip, must
    // not strand the merchant on an OAuth error page they cannot retry from
    // without reinstalling. ensureWorkspace is idempotent and every /api/* route
    // re-runs it, so a deferred lease heals on the merchant's first real request
    // — which shows the 503 "setting up your workspace" state instead, a screen
    // they can simply reload.
    //
    // Catching the rejection is not enough to honour that: a lease that SUCCEEDS
    // slowly holds the install open just as badly as one that fails. The path
    // behind this call is ensureWorkspace → leaseFromPool → wireUpWorkspace →
    // ensureTelenowHook, which issues up to three sequential Telenow requests at
    // the client's 20s default timeout, so an unbounded await can sit on the
    // OAuth redirect for the better part of a minute while Shopify's install
    // flow, the merchant, and the browser all wait on a third party. Racing a 4s
    // timer bounds that; the lease keeps running in the background and the next
    // request picks up whatever it finished. Same pattern, same reason, as the
    // billing callback in server.js.
    await Promise.race([
      ensureWorkspace(session.shop).catch((err) => {
        console.error('[auth] workspace lease deferred:', err.message);
        return null;
      }),
      new Promise((resolve) => setTimeout(resolve, 4000).unref?.()),
    ]);

    // Note what we intentionally do NOT do here: create a billing charge. Every
    // shop installs onto the free Starter plan, which needs no subscription, and
    // a charge started inside the OAuth callback would redirect the merchant to
    // Shopify's approval screen mid-install — where declining or closing the tab
    // leaves an installed app whose first impression is a payment demand, and
    // where the return trip lands outside our callback's state. Plan selection
    // happens later, from inside the app, on the merchant's own initiative.

    console.log(`[auth] installed for ${session.shop}`);

    // Send the merchant to the settings page. Mint a signed session token and
    // pass it via the URL FRAGMENT (not query/logs) — the UI reads it from
    // location.hash and sends it as a Bearer token on every /api/* call.
    // An embedded app has to hand the merchant back INTO the admin, not to its
    // own origin. Outside the admin frame App Bridge never initialises, so no
    // session token is ever issued — which is why both "immediately redirects to
    // app UI after authentication" and the embedded session-token check fail on
    // a self-hosted redirect.
    let embedded = null;
    try {
      // getEmbeddedAppUrl is async — redirecting the bare call sends the merchant
      // to the literal URL "/auth/[object Promise]".
      embedded = await shopify.auth.getEmbeddedAppUrl({ rawRequest: req, rawResponse: res });
    } catch (err) {
      // No ?host= on the callback: a direct hit, or a local run outside admin.
      console.warn('[auth] no embedded host on callback:', err.message);
    }
    if (embedded) {
      res.redirect(embedded);
      return;
    }

    // Standalone fallback: the token rides in the URL FRAGMENT, not the query,
    // so it stays out of server logs and Referer headers.
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
    // Already installed: go straight to the settings UI. Forward the WHOLE
    // query string (host, embedded, ...) — App Bridge cannot initialize
    // without ?host= on the page URL, and without App Bridge there is no
    // session token, so every /api call would 401 in the embedded admin.
    if (getShop(String(shop))) {
      const qs = new URLSearchParams(req.query).toString();
      res.redirect(`/app?${qs}`);
      return;
    }
    // Not installed. Embedded apps are loaded at "/" inside the admin iframe,
    // and OAuth cannot run there: Shopify's consent screen refuses to be
    // framed, and the state cookie (SameSite=Lax) never flows on iframe
    // navigations. Serve a tiny page that escapes to the top-level window and
    // restarts the install there. Outside an iframe, plain redirect is fine.
    const authUrl = `${HOST}/auth?shop=${encodeURIComponent(String(shop))}`;
    if (String(req.query.embedded) === '1') {
      res
        .status(200)
        .type('html')
        .send(
          `<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key="${process.env.SHOPIFY_API_KEY || ''}"></script>
           <p>Redirecting to app installation…
             <a href="${authUrl}" target="_top">Continue</a></p>
           <script>window.open(${JSON.stringify(authUrl)}, '_top');</script>`,
        );
      return;
    }
    res.redirect(authUrl);
    return;
  }
  res
    .status(200)
    .type('html')
    .send(
      `<h1>Telenow for Shopify</h1>
       <p>Install by visiting <code>${HOST}/auth?shop=telenow.myshopify.com</code></p>
       <p>Already installed? Open the <a href="/app">settings page</a> (add <code>?shop=</code>).</p>`,
    );
}
