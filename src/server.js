// ─────────────────────────────────────────────────────────────────────────────
// server.js — Express app entrypoint.
//
// Wiring order matters because of body parsers:
//   - Webhook routes (Shopify + Telenow) need the RAW body for HMAC, so they get
//     express.text({ type: '*/*' }) and are mounted BEFORE the global JSON parser.
//   - The settings API gets express.json().
//   - /app serves the static settings page.
//
// Run with: `npm start` (needs env from .env — see .env.example).
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';
import express from 'express';

// Import order: shopify.js (which imports the node adapter) before anything that
// touches the library. The webhook module also calls addHandlers() at import.
import {
  shopify, HOST, getShopProfile, getShopCountry, findFlaggedOrders, assertHostConfig,
} from './shopify.js';
import { authRouter, rootHandler } from './auth.js';
import { shopifyWebhookRouter } from './webhooks/shopify.js';
import { telenowWebhookRouter } from './webhooks/telenow.js';
import { ndrWebhookRouter } from './webhooks/ndr.js';
import { eventsRouter } from './webhooks/events.js';
import {
  getSettings, getRedactedSettings, updateSettings, AUTOMATIONS,
  getAutomation, getSavedAgents, addSavedAgent, removeSavedAgent,
} from './settings.js';
import { getShop, listShops, listLeads } from './store.js';
import { listTemplates, getTemplate, buildAgentPayload } from './templates.js';
import { verifyAnySessionToken } from './session.js';
import { toE164, resolveCountry, exampleNumberFor } from './util/phone.js';
import { TelenowClient } from './telenow.js';
import {
  getEntitlement, checkAccess, refreshEntitlement,
  requestSubscription, raiseCap, cancelSubscription, entitlementForClient,
} from './billing.js';
import { ensureWorkspace, poolStatus } from './provisioning.js';
import { publicPlans, PLANS, planByHandle } from './plans.js';
import { rollIfNeeded, usedMinutes } from './usage.js';
import { runWinBackSweep } from './automations/winBack.js';
import { runReviewsSweep } from './automations/reviews.js';
import { runPostPurchaseSweep } from './automations/postPurchase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.disable('x-powered-by');
// Exactly one reverse proxy (Caddy) sits in front in production — see
// docker-compose.yml. One hop, never `true`: trusting the whole chain would let
// a client spoof its own X-Forwarded-For. Nothing reads req.ip today; this is
// here so that when something does (a per-IP rate limiter), it sees the real
// client address rather than the proxy's.
app.set('trust proxy', 1);

// ── Health check ──────────────────────────────────────────────────────────────
// The key pool is reported here because it is the one resource that silently
// runs out: every install leases an entry and every uninstall quarantines one,
// so `free` only ever falls. A monitor that alerts on it gives an operator days
// of warning; without it the first symptom is a merchant seeing 503 provisioning
// on a fresh install, which looks like an outage rather than an inventory
// problem. `quarantined` is surfaced separately so it is obvious how much of
// the shortfall is recoverable by wiping and re-seeding used workspaces.
//
// The census is emitted WHOLE rather than field-picked, which is what makes the
// per-country and per-provider breakdowns (`byCountry` / `byProvider`, added by
// keypoolStatus() and passed through poolStatus()) visible here for free. They
// matter more than the total does: a pool holding forty free Indian numbers and
// zero North-American ones reads as perfectly healthy on `free` alone, while
// every US install is quietly leased a number that cannot reliably ring a US
// mobile — which is the exact failure that gets a test call marked broken in
// review. Alert on the country buckets, not just the total.
app.get('/healthz', (_req, res) =>
  res.json({ ok: true, service: 'telenow-shopify', keypool: poolStatus() }));

// ── Webhook receivers (RAW body — must come before express.json) ──────────────
// Shopify HMAC and Telenow X-VoiceAI-Signature both verify over raw bytes.
app.use('/webhooks/shopify', express.text({ type: '*/*', limit: '2mb' }), shopifyWebhookRouter);
app.use('/telenow/webhook', express.text({ type: '*/*', limit: '2mb' }), telenowWebhookRouter);
// Carrier NDR (failed delivery). Same raw-body treatment as the others so it
// sits with them, though it authenticates by secret path rather than HMAC.
app.use('/webhooks/ndr', express.text({ type: '*/*', limit: '1mb' }), ndrWebhookRouter);
// Shopify Events (new webhooks successor) — ACK-only for now, HMAC-verified.
// Matches the [[events.subscription]] uri in shopify.app.toml.
app.use('/events', express.text({ type: '*/*', limit: '2mb' }), eventsRouter);

// ── Everything else can use JSON ──────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// ── OAuth (install + callback) ────────────────────────────────────────────────
app.use(authRouter);

// ── Landing ───────────────────────────────────────────────────────────────────
app.get('/', rootHandler);

// ── Billing return ────────────────────────────────────────────────────────────
// Shopify sends the merchant here after they approve (or decline) a charge on
// Shopify's own screen. This is a TOP-LEVEL browser navigation, not a fetch from
// the embedded page, so there is no App Bridge session token to authenticate
// with — every other /api route's authority is unavailable here.
//
// What stands in for it is the one-shot `state` nonce that requestSubscription()
// minted and stored on settings.billing.pendingState. Without that check the URL
// is a bare GET that anyone could replay for any shop; with it, an attacker
// would have to guess 128 bits. It is compared with timingSafeEqual because a
// byte-at-a-time `===` on a secret is measurable over enough requests, and the
// nonce is cleared immediately afterwards so a replay of the same link fails.
//
// Note what this route deliberately does NOT do: trust the query string about
// what was bought. `refreshEntitlement` re-reads the subscription from the Admin
// API, so a merchant who edits the URL, or one whose approval silently failed,
// gets whatever Shopify actually says they have.
const SHOP_RE = new RegExp("^[a-zA-Z0-9][a-zA-Z0-9-]*[.]myshopify[.]com$");

app.get('/billing/callback', async (req, res) => {
  const shop = String(req.query.shop || '');
  if (!SHOP_RE.test(shop) || !getShop(shop)) {
    res.status(400).send('This billing link is not valid for an installed store.');
    return;
  }

  const expected = String(getSettings(shop).billing?.pendingState || '');
  const given = String(req.query.state || '');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  // timingSafeEqual throws on a length mismatch, so the length check has to come
  // first — it leaks only the length of a random hex nonce, which is a constant.
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    // A bad state must NOT redirect. Bouncing an unverified request into the
    // admin would make a forged link look like it worked.
    res.status(400).send('This billing link has expired. Reopen the app and choose a plan again.');
    return;
  }

  const billing = { ...(getSettings(shop).billing || {}), pendingState: null, pendingPlan: null };
  updateSettings(shop, { billing });

  try {
    await refreshEntitlement(shop);
  } catch (err) {
    // The merchant has already paid at this point; a read failure here must not
    // leave them staring at an error page. The scheduler and the next /api call
    // both re-read the entitlement, so this self-heals within minutes.
    console.error('[billing] callback refresh failed for', shop + ':', err.message);
  }

  // A brand-new paid shop usually has no workspace yet, and leasing one takes a
  // round-trip to Telenow. Racing it against a short timer means the merchant
  // lands on a working app when the lease is quick, and is never held on a blank
  // page when it is slow — the lease continues in the background either way and
  // is retried on the next request.
  await Promise.race([
    ensureWorkspace(shop).catch((err) => {
      console.error('[billing] callback lease deferred for', shop + ':', err.message);
      return null;
    }),
    new Promise((resolve) => setTimeout(resolve, 4000).unref?.()),
  ]);

  // The merchant has just approved a plan or a higher ceiling, so this is the
  // moment any inbound line parked for billing comes back. Awaited, unlike the
  // plan screen's call: landing back in the admin to find the number still dead
  // is exactly the confusion an approval is supposed to end.
  await enforceInboundAccess(shop).catch((err) =>
    console.error('[inbound] callback reconcile failed for', shop + ':', err.message));

  // Back into the admin, framed, on the app's own page. `host` is the base64
  // admin origin App Bridge handed the page; it is validated rather than trusted
  // so a crafted ?host= cannot turn this into an open redirect. The fallback
  // derives the same URL from the shop domain, which is why this design needs no
  // hand-typed app handle anywhere.
  let decoded = null;
  try {
    decoded = req.query.host ? Buffer.from(String(req.query.host), 'base64').toString('utf8') : null;
  } catch { decoded = null; }
  const base = decoded && /^admin\.shopify\.com\/store\/[a-z0-9-]+$/.test(decoded)
    ? decoded
    : `admin.shopify.com/store/${shop.replace('.myshopify.com', '')}`;
  res.redirect(`https://${base}/apps/${process.env.SHOPIFY_API_KEY || ''}`);
});

// ── Embedded settings UI ──────────────────────────────────────────────────────
app.get('/app', async (req, res) => {
  // App Bridge needs the client ID at script-load time, so the page is rendered
  // here rather than served statically. This is the app's public client ID (not
  // the secret) - every embedded Shopify app exposes it in the page.
  try {
    // Embedded apps must allow the admin to frame them, and must NOT allow anyone
    // else. The shop is validated before it goes into the header so a crafted
    // ?shop= cannot inject directives.
    const raw = String(req.query.shop || '');
    const shopOk = new RegExp("^[a-zA-Z0-9][a-zA-Z0-9-]*[.]myshopify[.]com$").test(raw);
    const frameAncestors = shopOk
      ? 'https://' + raw + ' https://admin.shopify.com'
      : 'https://admin.shopify.com';
    res.setHeader('Content-Security-Policy', 'frame-ancestors ' + frameAncestors);

    const html = await readFile(path.join(__dirname, 'public', 'app.html'), 'utf8');
    const key = process.env.SHOPIFY_API_KEY || '';
    res.type('html').send(html.split('{{SHOPIFY_API_KEY}}').join(key));
  } catch (err) {
    console.error('[app] could not render settings page:', err.message);
    res.status(500).send('Could not load the settings page.');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings API (consumed by /app)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve + validate the shop from the signed session token (Authorization:
 * Bearer <t>) — NOT the non-secret ?shop= query (that allowed IDOR: any tenant
 * could read another's leads/PII and overwrite its API key by guessing the shop).
 * Returns the shop derived from the token, or null after writing 401/404.
 */
async function requireInstalledShop(req, res) {
  const auth = req.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  const shop = await verifyAnySessionToken(token);
  if (!shop) {
    res.status(401).json({ error: 'missing or invalid session token' });
    return null;
  }
  if (!getShop(shop)) {
    res.status(404).json({ error: 'shop not installed — complete OAuth first' });
    return null;
  }
  return shop;
}

// GET current settings (redacted key) + the automation catalog for the UI.
//
// The entitlement rides along because the page cannot render its first frame
// without it — every gated control keys off it — and a second round-trip would
// mean the UI briefly draws itself as if the merchant had no plan. getEntitlement
// never throws and is cached for five minutes, so this costs nothing in the
// common case.
app.get('/api/settings', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  res.json({
    settings: getRedactedSettings(shop),
    entitlement: entitlementForClient(await getEntitlement(shop)),
    catalog: AUTOMATIONS.map(({ key, label, triggers }) => ({ key, label, triggers })),
  });
});

// ── Billing API (consumed by the plan screen) ─────────────────────────────────

// GET /api/billing — everything the plan screen needs in one call: what the shop
// is entitled to, how much of the allowance is spent, and what is on offer.
// `?refresh=1` bypasses the five-minute entitlement cache, which the UI uses on
// return from Shopify's approval screen so the new plan shows immediately rather
// than after the cache expires.
app.get('/api/billing', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;

  const ent = req.query.refresh === '1'
    ? await refreshEntitlement(shop)
    : await getEntitlement(shop);

  // Rolling here as well as inside checkAccess keeps the number the merchant
  // reads honest: a shop that has not made a request since its period ended
  // would otherwise be shown last period's total.
  rollIfNeeded(shop, ent);
  const included = planByHandle(ent.plan).includedMinutes;
  const used = usedMinutes(shop);
  const remaining = Math.max(0, included - used);

  const plans = publicPlans();
  for (const p of plans) p.current = p.handle === ent.plan;

  // Reconcile the inbound lines while we are here. Not awaited: the plan screen
  // must not wait on a Telenow round trip, and the reconciliation is a no-op on
  // every load where nothing changed. This is the enforcement point the merchant
  // reaches most often — the screen they open the moment minutes run out.
  enforceInboundAccess(shop).catch((err) =>
    console.error('[inbound] reconcile failed for', shop + ':', err.message));

  res.json({
    entitlement: entitlementForClient(ent),
    usage: {
      usedMinutes: used,
      includedMinutes: included,
      remaining,
      pctUsed: included > 0 ? Math.min(100, Math.round((used / included) * 100)) : 0,
    },
    plans,
  });
});

// POST /api/billing/subscribe — start (or change) a paid subscription.
//
// Nothing is charged here. Shopify returns a confirmationUrl and the merchant
// approves the amount on Shopify's own screen; this app never sees a card and
// never quotes a price outside Shopify's checkout.
app.post('/api/billing/subscribe', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;

  const plan = String(req.body?.plan || '').trim();
  const host = String(req.body?.host || '').trim();
  // Rejected here as well as inside requestSubscription so a typo answers 400
  // rather than surfacing as a 500 from the billing layer.
  if (!Object.prototype.hasOwnProperty.call(PLANS, plan) || plan === 'starter') {
    res.status(400).json({ error: 'bad_plan', message: 'Choose one of the available plans.' });
    return;
  }

  // Re-subscribing to the plan the shop is ALREADY on is refused, and not for
  // tidiness. Every appSubscriptionCreate moves currentPeriodEnd forward, and a
  // period boundary is what tells usage.js to zero usedMinutes — so without this
  // guard "subscribe to Growth" is a button that resets the 300-minute allowance.
  // replacementBehavior STANDARD prorates a credit for the unused part of the
  // period the merchant is replacing, so the same-plan round trip costs a
  // fraction of the fee and hands back a full fresh allowance each time: buy
  // minutes at a discount, repeatedly, for as long as anyone cares to click.
  //
  // A genuine plan CHANGE (growth <-> scale) is untouched — it is the same route
  // with a different handle, which is how requirement 1.2.3 is satisfied.
  //
  // Forced read rather than the five-minute cache: a merchant who cancelled a
  // minute ago must not be told they still hold the plan they are re-buying.
  // getEntitlement never throws, so the force cannot turn a cache miss into a 500.
  const ent = await getEntitlement(shop, { force: true });
  if (ent.status === 'ACTIVE' && ent.plan === plan) {
    res.status(400).json({
      error: 'already_on_plan',
      plan: ent.plan,
      message: `You are already on ${ent.planName || 'this plan'}. Pick a different plan to change.`,
    });
    return;
  }

  try {
    res.json(await requestSubscription(shop, plan, { host }));
  } catch (err) {
    console.error('[billing] subscribe failed for', shop + ':', err.message);
    res.status(502).json({ error: 'subscribe_failed', message: err.message });
  }
});

// POST /api/billing/raise-cap — lift the monthly usage ceiling.
//
// raiseCap throws with a merchant-safe message for every rejection it makes
// (non-positive amount, no usage line item on this plan, a new cap at or below
// what has already been spent), so those become 400s the UI can show verbatim.
app.post('/api/billing/raise-cap', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;

  const capUsd = Number(req.body?.capUsd);
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    res.status(400).json({ error: 'bad_request', message: 'Enter a monthly maximum in dollars.' });
    return;
  }
  try {
    res.json(await raiseCap(shop, capUsd));
  } catch (err) {
    res.status(400).json({ error: 'raise_cap_failed', message: err.message });
  }
});

// POST /api/billing/cancel — leave the paid plan and fall back to Starter.
//
// This route exists for requirement 1.2.3: the merchant must be able to stop
// paying from inside the app, without emailing anyone. The plan screen's "Move
// to Starter" button (public/app.html) has always POSTed here; until this route
// landed it hit the catch-all 404 and the merchant had no in-app way out — in
// the exact compliance area the app was paused for.
//
// NOTE: cancelSubscription()'s own docblock still says "Ops CLI only — the UI
// never offers this". That is now out of date; it is the source of the drift
// that left this route unwritten, and billing.js is owned elsewhere so it is
// corrected there rather than here. The reasoning in it is still sound —
// downgrading is a proration, not a cliff — which is why the UI frames this as
// "move to Starter" rather than "cancel", and why nothing else is torn down:
// agents, automations and call history survive, the shop simply drops to the
// free allowance.
//
// Deliberately NOT gated on checkAccess: a merchant whose subscription is
// FROZEN for a failed payment is exactly the merchant most likely to want out,
// and a paywall in front of the exit is not a paywall we can defend.
app.post('/api/billing/cancel', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;

  try {
    const result = await cancelSubscription(shop);
    // cancelSubscription refreshes the entitlement itself once it has actually
    // cancelled something, so that branch reads back the value it just wrote.
    // The "there was nothing to cancel" branch does not refresh, so force one:
    // a subscription that lapsed on Shopify's side would otherwise keep telling
    // this shop it is on a paid plan for the rest of the cache window.
    const ent = result.cancelled ? await getEntitlement(shop) : await refreshEntitlement(shop);
    res.json({ cancelled: Boolean(result.cancelled), entitlement: entitlementForClient(ent) });
  } catch (err) {
    // err.message here comes from the Admin API, not from a merchant-safe
    // rejection the way raiseCap's does, so it is logged and not echoed.
    console.error('[billing] cancel failed for', shop + ':', err.message);
    res.status(502).json({
      error: 'cancel_failed',
      message: 'Could not change the plan. Try again in a moment.',
    });
  }
});

// ── Telenow read-through routes ───────────────────────────────────────────────
// The merchant never supplies, sees or manages a calling credential: the server
// leases a workspace for the shop on first use and these routes use it. Every
// route below therefore has exactly two ways to be turned away — the merchant's
// plan does not cover what they asked for (402), or the workspace is not leased
// yet (503, a retry state).

/** Like telenowFor, but returns null instead of answering — for routes that
  * still have something useful to render without a workspace. */
async function telenowForOrNull(shop) {
  const key = await ensureWorkspace(shop);
  return key ? new TelenowClient(key) : null;
}

/**
 * checkAccess, with the one correction `provision` needs.
 *
 * checkAccess answers 'provision' from the same branch as 'spend', so a shop
 * that has used its 25 free minutes is refused `minutes_exhausted` when it tries
 * to CREATE an agent, write a returns-policy knowledge base or publish a
 * template. None of those place a call or consume a minute; they are the work a
 * merchant does in order to spend the NEXT minutes, and refusing them is the
 * wrong shape of block in both directions. It bricks free configuration screens,
 * and it lands hardest on a reviewer, who evaluates in the natural order — make
 * a test call first, configure second — and so meets the paywall on the screens
 * that never bill.
 *
 * So the two ALLOWANCE refusals are downgraded to a pass for 'provision' alone.
 * Nothing else is forgiven: FROZEN still blocks (a shop whose payment failed
 * should not be building more automation on credit), and this whitelists the two
 * codes it waives rather than listing the ones it honours, so any refusal code
 * added later is refused by default instead of silently let through.
 *
 * The one act reached through 'provision' that genuinely commits to future
 * spend — arming an automation — asks for 'spend' at its own call site rather
 * than being carved back out of here.
 *
 * @param {string} shop
 * @param {'read'|'spend'|'provision'} need
 */
async function gateFor(shop, need) {
  const gate = await checkAccess(shop, need);
  if (gate.ok || need !== 'provision') return gate;
  const code = gate.body?.error;
  if (code === 'minutes_exhausted' || code === 'usage_cap_reached') {
    return { ok: true, ent: gate.ent };
  }
  return gate;
}

/**
 * Build a Telenow client for the shop, or answer and return null.
 *
 * Gate 1 of five. The entitlement check comes BEFORE provisioning on purpose:
 * a shop that has run out of minutes should be told so, not made to wait on a
 * workspace lease it is not allowed to use.
 *
 * @param {string} shop
 * @param {import('express').Response} res
 * @param {'read'|'spend'|'provision'} need
 */
async function telenowFor(shop, res, need = 'read') {
  const gate = await gateFor(shop, need);
  if (!gate.ok) { res.status(402).json(gate.body); return null; }

  const key = await ensureWorkspace(shop);
  if (!key) {
    // "No workspace" is not a MERCHANT problem any more — it is a transient
    // SERVER state, and it says so. This 503 replaces the old 409 "connect your
    // API key first" response, which told every merchant, and every reviewer
    // reading a network log, that the app depended on an off-platform signup.
    // That error code is deliberately gone from the codebase entirely, so a
    // grep for it is a clean release check rather than a judgement call.
    res.status(503).json({
      error: 'provisioning',
      message: 'Setting up your calling workspace - this takes a few seconds. Reload to retry.',
    });
    return null;
  }
  return new TelenowClient(key);
}

// ── Inbound containment ───────────────────────────────────────────────────────
//
// Gate 6, and the only one that does not sit in front of a request.
//
// Every other gate works because the app is in the path: the merchant asks, we
// check, we refuse. An INBOUND call has no such moment. A customer dials the
// number bound to a published agent, Telenow answers, and the first this app
// hears of it is a call.ended webhook that meters minutes already spent. Left
// alone that is not a leak at the edges — it is an uncapped one: a Starter shop
// runs arbitrarily far past its 25 free minutes, and a FROZEN shop keeps taking
// calls while the plan screen tells the merchant calling is paused. The bill for
// both lands on us, because Starter is by design never invoiced.
//
// Since we cannot refuse the call, we take away the number. `inboundBindings`
// records what each published agent's line SHOULD be, and enforceInboundAccess
// reconciles that intent against the entitlement in both directions: unassign
// when the shop may not spend, re-assign when it may again. It is idempotent and
// state-compared, so the common case — desired state already matches — costs one
// cached checkAccess and no Telenow round trip at all, which is what makes it
// safe to call from a hot path.
//
// KNOWN GAP, stated rather than papered over: the enforcement points reachable
// from THIS file are the plan screen, the billing callback and the six-hourly
// sweep. The tight one — re-checking immediately after each call is metered —
// belongs in recordCallUsage (src/webhooks/telenow.js), which is owned
// elsewhere; until it calls this too, a shop that exhausts its allowance mid-
// period keeps its inbound line for at most one sweep interval. The per-
// workspace spend ceiling the operator sets on the pool entry is the backstop
// under that window, and it is the only containment for it.

/**
 * Record what a published agent's inbound line is meant to be.
 *
 * `parked: true` means "the merchant asked for this number to be live and we are
 * holding it down for billing reasons" — which is why a parked binding is kept
 * rather than forgotten. Forgetting it would make the block permanent, and the
 * merchant would have to republish the agent to get their number back after
 * paying.
 */
function rememberInboundBinding(shop, numberId, agentId, parked) {
  const bindings = { ...(getSettings(shop).inboundBindings || {}) };
  bindings[numberId] = { agentId, parked: Boolean(parked), at: new Date().toISOString() };
  updateSettings(shop, { inboundBindings: bindings });
}

/**
 * Bring the shop's inbound lines into line with what it is entitled to.
 *
 * Never throws and never blocks a response on a Telenow failure: a number that
 * could not be parked is logged and retried on the next call, because the
 * alternative — a 500 on the plan screen — helps nobody and fixes nothing.
 *
 * @param {string} shop
 * @returns {Promise<{changed:number, parked?:boolean}>}
 */
async function enforceInboundAccess(shop) {
  const bindings = getSettings(shop).inboundBindings || {};
  const ids = Object.keys(bindings);
  if (!ids.length) return { changed: 0 };

  const gate = await checkAccess(shop, 'spend');
  const park = !gate.ok;
  const stale = ids.filter((id) => bindings[id]?.agentId && Boolean(bindings[id].parked) !== park);
  if (!stale.length) return { changed: 0 };

  // Only now is a workspace needed. Ordering it after the state comparison is
  // what keeps the no-op path free of a lease attempt.
  const client = await telenowForOrNull(shop);
  if (!client) return { changed: 0 };

  const next = { ...bindings };
  let changed = 0;
  for (const id of stale) {
    try {
      if (park) await client.unassignNumber(id);
      else await client.assignNumberToAgent(id, next[id].agentId);
      next[id] = { ...next[id], parked: park, at: new Date().toISOString() };
      changed += 1;
    } catch (err) {
      console.error(`[inbound] ${park ? 'park' : 'restore'} failed for ${shop} number=${id}:`,
        err.message);
    }
  }
  if (changed) {
    updateSettings(shop, { inboundBindings: next });
    console.log(`[inbound] shop=${shop} ${park ? 'parked' : 'restored'} ${changed} number(s)` +
      (park ? ` (${gate.body?.error})` : ''));
  }
  return { changed, parked: park };
}

/** Map a TelenowError onto a sensible HTTP response. */
function telenowFail(res, err, what) {
  const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 502;
  console.error('[api] ' + what + ' failed:', err.message);
  res.status(status).json({ error: what + "_failed", message: err.message });
}

// GET /api/agents — the org's voice agents, for the Agents page and the
// agent pickers on each automation.
// A Telenow agent id is a UUID. Validating here keeps junk out of the store and
// bounds what a caller can persist.
const UUID_RE = new RegExp('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$');
const MAX_SAVED_AGENTS = 200;

// GET /api/agents — only the agents this store has added, in the order added.
//
// Ids that no longer resolve in Telenow (the agent was deleted there) are
// returned as tombstones rather than dropped: filtering them out silently makes
// them invisible AND unremovable, since the picker only lists live agents.
app.get('/api/agents', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const saved = getSavedAgents(shop);
  const client = await telenowFor(shop, res);
  if (!client) return;
  // Nothing added yet — skip the Telenow round-trip entirely.
  if (!saved.length) {
    res.json({ agents: [], total: 0, saved: [], missing: [] });
    return;
  }
  try {
    const { agents } = await client.listAllAgents();
    const byId = new Map(agents.map((a) => [a.id, a]));
    const mine = [];
    const missing = [];
    for (const id of saved) {
      const a = byId.get(id);
      if (a) mine.push(a); else missing.push(id);
    }
    res.json({ agents: mine, total: mine.length, saved, missing });
  } catch (err) {
    telenowFail(res, err, 'agents');
  }
});

// GET /api/agents/available — every agent in the org, flagged with whether it is
// already added. Declared BEFORE /api/agents/:id so "available" is not read as an id.
app.get('/api/agents/available', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = await telenowFor(shop, res);
  if (!client) return;
  try {
    const { agents, total, truncated } = await client.listAllAgents();
    const saved = new Set(getSavedAgents(shop));
    res.json({
      agents: agents.map((a) => ({ ...a, added: saved.has(a.id) })),
      total: agents.length,
      // Tell the UI when the org is larger than we are willing to page through,
      // rather than quietly showing a partial list as if it were everything.
      truncated: Boolean(truncated),
      orgTotal: total,
    });
  } catch (err) {
    telenowFail(res, err, 'agents');
  }
});

// POST /api/agents/saved — add one agent to this store's list.
app.post('/api/agents/saved', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const agentId = String(req.body?.agentId || '').trim();
  if (!UUID_RE.test(agentId)) {
    res.status(400).json({ error: 'bad_request', message: 'A valid agent id is required.' });
    return;
  }
  if (getSavedAgents(shop).length >= MAX_SAVED_AGENTS && !getSavedAgents(shop).includes(agentId)) {
    res.status(409).json({ error: 'too_many', message: `You can add up to ${MAX_SAVED_AGENTS} agents.` });
    return;
  }
  res.json({ saved: addSavedAgent(shop, agentId) });
});

// DELETE /api/agents/saved/:id — unlink from this store. The agent itself is
// untouched in Telenow, so it can be added back at any time from the picker.
// Accepts an id that no longer resolves upstream, so a tombstoned entry can
// still be cleared.
app.delete('/api/agents/saved/:id', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const id = req.params.id;
  const saved = removeSavedAgent(shop, id);

  // If this agent came from a template, forget that too — otherwise the
  // Templates page keeps claiming it is set up while the agent is gone from
  // the store, and there is no way to make it again.
  const installed = getSettings(shop).installedTemplates || {};
  const freed = Object.entries(installed).filter(([, v]) => v?.agentId === id).map(([k]) => k);
  if (freed.length) {
    const next = { ...installed };
    for (const k of freed) delete next[k];
    updateSettings(shop, { installedTemplates: next });
  }

  res.json({ saved, freedTemplates: freed });
});

// GET /api/agents/:id — one agent with its FULL configuration, for the agent
// detail view. Uses the Dashboard surface; the /v1 list omits prompt+config.
app.get('/api/agents/:id', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = await telenowFor(shop, res);
  if (!client) return;
  try {
    // Stats are a nice-to-have: a new agent with no calls can 404 here, and
    // that must not take down the whole detail view.
    const [agent, stats] = await Promise.all([
      client.getAgent(req.params.id),
      client.getAgentStats(req.params.id).catch(() => null),
    ]);
    res.json({ agent, stats });
  } catch (err) {
    telenowFail(res, err, 'agent');
  }
});

// GET /api/catalog — provider catalog, used to turn raw ids ("xai",
// "lightning_v3.1_pro") into human labels. Cached per shop for the process
// lifetime: it is a large, near-static payload and the detail view hits it
// on every open.
const catalogCache = new Map();
app.get('/api/catalog', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  if (catalogCache.has(shop)) {
    res.json(catalogCache.get(shop));
    return;
  }
  const client = await telenowFor(shop, res);
  if (!client) return;
  try {
    const catalog = stripRateCard(await client.getCatalog());
    catalogCache.set(shop, catalog);
    res.json(catalog);
  } catch (err) {
    telenowFail(res, err, 'catalog');
  }
});

/**
 * Remove the upstream rate card from a provider catalog.
 *
 * The catalog Telenow returns carries a per-provider `perMinuteUsd` and a
 * top-level `platformFee`. Nothing in this app renders them, but they are a
 * third-party price list, and a price list that reaches the Shopify admin iframe
 * is an off-platform pricing artifact no matter who reads it — exactly what
 * requirement 1.2.1 is about. The merchant's price is the plan they approved on
 * Shopify's own screen, and it is the only one this app knows.
 *
 * This is deliberately the SECOND place the strip happens: TelenowClient.getCatalog()
 * strips at the client boundary so no future caller can leak it, and this strips
 * again at the response boundary so a change to the client — or a new upstream
 * field arriving through a code path that bypasses it — cannot quietly put the
 * rate card back on the wire. Two cheap object walks are worth more than trusting
 * one of them to stay correct.
 */
function stripRateCard(catalog) {
  if (!catalog || typeof catalog !== 'object') return catalog;
  const out = { ...catalog };
  delete out.platformFee;
  for (const group of ['llm', 'stt', 'tts', 'telephony']) {
    if (!Array.isArray(out[group])) continue;
    out[group] = out[group].map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const e = { ...entry };
      delete e.perMinuteUsd;
      return e;
    });
  }
  return out;
}

// POST /api/web-call — start a browser call so the merchant can TALK to the
// agent through their microphone, the way the Telenow dashboard does.
//
// Returns the session id and the WebSocket URL; the audio itself is handled by
// the standalone /web-call page (see below), never by this server.
app.post('/api/web-call', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = await telenowFor(shop, res, 'spend');
  if (!client) return;

  const agentId = String(req.body?.agentId || '').trim();
  if (!agentId) {
    res.status(400).json({ error: 'bad_request', message: 'agentId is required' });
    return;
  }
  const variables = {};
  const rawVars = req.body?.variables;
  if (rawVars && typeof rawVars === 'object' && !Array.isArray(rawVars)) {
    for (const [k, v] of Object.entries(rawVars)) {
      if (typeof v === 'string' && v.trim()) variables[k] = v.trim().slice(0, 500);
    }
  }

  try {
    const out = await client.initWebCall({
      agentId,
      variables,
      identifier: 'shopify-web:' + shop,
    });
    console.log(`[web-call] shop=${shop} agent=${agentId} session=${out.sessionId || '?'}`);
    res.json(out);
  } catch (err) {
    telenowFail(res, err, 'web call');
  }
});

// GET /web-call — the browser-call page, opened in its OWN WINDOW rather than
// rendered inside the app.
//
// Why a separate window: microphone access inside an iframe requires the
// EMBEDDING page to grant it via allow="microphone", and the Shopify admin
// controls that iframe, not us. A top-level window always has mic access, so
// the call works regardless of what Shopify sets. It carries no session token:
// the sessionId minted above is the only credential the WebSocket needs, and it
// arrives in the URL fragment (never sent to a server, never logged).
app.get('/web-call', async (req, res) => {
  try {
    const html = await readFile(path.join(__dirname, 'public', 'webcall.html'), 'utf8');
    res.type('html').send(html);
  } catch (err) {
    console.error('[web-call] could not render page:', err.message);
    res.status(500).send('Could not load the call page.');
  }
});

// The org id is needed for the org-scoped recording routes. It comes from
// /api/v1/me and never changes for a given key, so resolve it once per shop.
const orgIdCache = new Map();
async function orgIdFor(shop, client) {
  if (orgIdCache.has(shop)) return orgIdCache.get(shop);
  const me = await client.me();
  const orgId = me?.org_id || null;
  if (orgId) orgIdCache.set(shop, orgId);
  return orgId;
}

// GET /api/calls/:id/recording — a short-lived signed URL the browser can drop
// straight into an <audio> element, plus the metadata needed to label it.
//
// The audio bytes never pass through this server: the signed URL points at
// object storage and carries its own credential in the query string, which is
// the only way to play it from an <audio src> (that element cannot send an
// Authorization header). The URL expires, so it is fetched per play, not stored.
app.get('/api/calls/:id/recording', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = await telenowFor(shop, res);
  if (!client) return;
  try {
    const call = await client.getCallDetail(req.params.id);
    const recordingId = call?.recording_id;
    if (!recordingId) {
      res.status(404).json({ error: 'no_recording', message: 'This call has no recording.' });
      return;
    }
    const orgId = await orgIdFor(shop, client);
    if (!orgId) {
      res.status(502).json({ error: 'no_org', message: 'Could not resolve the Telenow organization.' });
      return;
    }
    // Metadata is a nice-to-have label; a failure there must not block playback.
    const [signed, meta] = await Promise.all([
      client.getRecordingUrl(orgId, recordingId),
      client.getRecording(orgId, recordingId).catch(() => null),
    ]);
    res.json({
      url: signed.url,
      expiresAt: signed.expiresAt,
      mime: meta?.mime || 'audio/wav',
      durationSec: meta?.duration_sec ?? null,
      sizeBytes: meta?.size_bytes ?? null,
      sampleRate: meta?.sample_rate ?? null,
    });
  } catch (err) {
    telenowFail(res, err, 'recording');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Shopify → Telenow native integration
//
// Telenow ships a Shopify connector that lets an agent read the store MID-CALL
// (order.lookup, customer.lookup, product.search, checkout.create_link,
// order.update). It needs exactly two things: the Admin API token and the store
// domain — both of which this app already holds from its own OAuth install.
//
// So the merchant never pastes a Shopify token into Telenow: the moment they
// save a valid Telenow API key here, we connect the store on their behalf.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Connect (or repair) this shop's Shopify connector in Telenow.
 *
 * Idempotent by design, three ways: a stable Idempotency-Key derived from the
 * shop replays the original create; an existing connection for the same store
 * domain is PATCHed rather than duplicated; and a 409 (already connected) is
 * resolved by looking the connection up and updating it.
 *
 * @returns {Promise<{connected: boolean, connectionId?: string, status?: string,
 *                    verified?: boolean, error?: string}>}
 */
async function connectShopifyIntegration(shop, client) {
  const session = getShop(shop);
  const accessToken = session?.accessToken;
  if (!accessToken) return { connected: false, error: 'No Shopify access token for this shop.' };
  // The preview/demo seed uses a dummy token; connecting it would just store a
  // credential that fails every verification.
  if (String(accessToken).includes('dummy')) {
    return { connected: false, error: 'This shop has a placeholder token (preview mode).' };
  }

  const settings = { store_domain: shop };
  const credentials = { api_token: accessToken };

  try {
    // Reuse an existing connection for this store rather than making a second.
    const existing = (await client.listConnections('shopify'))
      .find((c) => c?.settings?.store_domain === shop);
    if (existing) {
      const updated = await client.updateConnection(existing.id, { credentials, settings });
      const conn = updated?.connection ?? updated;
      return {
        connected: true, connectionId: conn?.id || existing.id,
        status: conn?.status, verified: updated?.verification?.ok !== false,
        error: updated?.verification?.error || conn?.lastError,
      };
    }

    const created = await client.createConnection({
      providerId: 'shopify',
      label: shop,
      credentials,
      settings,
      // A stable key per shop: a retry replays the original 201 instead of
      // connecting twice.
      idempotencyKey: 'shopify-connect-' + shop,
    });
    const conn = created?.connection ?? created;
    return {
      connected: true, connectionId: conn?.id,
      status: conn?.status,
      // A failed verification still returns 201 — the connection exists, the
      // credential just did not work. Surface it rather than claiming success.
      verified: created?.verification?.ok !== false,
      error: created?.verification?.error || conn?.lastError,
    };
  } catch (err) {
    // 409 = this workspace already connects that store. Find it and update.
    if (err?.status === 409) {
      try {
        const mine = (await client.listConnections('shopify'))
          .find((c) => c?.settings?.store_domain === shop);
        if (mine) {
          const updated = await client.updateConnection(mine.id, { credentials, settings });
          const conn = updated?.connection ?? updated;
          return { connected: true, connectionId: conn?.id || mine.id, status: conn?.status,
            verified: updated?.verification?.ok !== false };
        }
      } catch (e) { /* fall through to the error below */ }
    }
    return { connected: false, error: err.message };
  }
}

// GET /api/integrations/shopify — current connection status for this store.
app.get('/api/integrations/shopify', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = await telenowFor(shop, res);
  if (!client) return;
  try {
    const conn = (await client.listConnections('shopify'))
      .find((c) => c?.settings?.store_domain === shop) || null;
    res.json({
      connected: Boolean(conn),
      connectionId: conn?.id || null,
      status: conn?.status || null,
      account: conn?.settings?.account || null,
      capabilities: conn?.capabilities || [],
      lastError: conn?.lastError || null,
    });
  } catch (err) {
    telenowFail(res, err, 'integration');
  }
});

// POST /api/integrations/shopify/connect — connect or repair on demand. The
// same routine runs automatically when the API key is saved; this is the retry.
app.post('/api/integrations/shopify/connect', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = await telenowFor(shop, res);
  if (!client) return;
  res.json(await connectShopifyIntegration(shop, client));
});

// GET /api/templates — the ready-made agent catalog, plus whether each is
// already set up for this store and whether the Shopify connector is live.
app.get('/api/templates', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const installed = getSettings(shop).installedTemplates || {};
  let connection = null;
  const client = await telenowForOrNull(shop);
  if (client) {
    try {
      connection = (await client.listConnections('shopify'))
        .find((c) => c?.settings?.store_domain === shop) || null;
    } catch (e) { /* the catalog still renders without it */ }
  }
  res.json({
    templates: listTemplates().map((t) => ({ ...t, installed: installed[t.key] || null })),
    // Tools need the connector. Without it the agents still get created, but
    // they cannot read the store mid-call — so the UI warns rather than
    // silently producing a weaker agent.
    connected: Boolean(connection && connection.status === 'active'),
    connectionId: connection?.id || null,
  });
});

// POST /api/templates/:key/setup — create this agent in Telenow, wired to the
// store's Shopify connector, and add it to the store's agent list.
app.post('/api/templates/:key/setup', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const tpl = getTemplate(req.params.key);
  if (!tpl) {
    res.status(404).json({ error: 'unknown_template', message: 'No such template.' });
    return;
  }
  const client = await telenowFor(shop, res, 'provision');
  if (!client) return;

  try {
    // Connect the store first if it is not already — the tools are the point.
    let conn = (await client.listConnections('shopify'))
      .find((c) => c?.settings?.store_domain === shop) || null;
    if (!conn) {
      const r = await connectShopifyIntegration(shop, client);
      if (r.connected) {
        conn = (await client.listConnections('shopify'))
          .find((c) => c?.settings?.store_domain === shop) || null;
      }
    }

    const profile = await getShopProfile(shop).catch(() => null);
    const payload = buildAgentPayload(tpl, shop, profile?.name, conn?.id || null);
    const agent = await client.createAgent(payload);
    if (!agent?.id) throw new Error('Telenow did not return an agent id.');

    // Show up on the Agents page without a second step.
    addSavedAgent(shop, agent.id);
    const installed = { ...(getSettings(shop).installedTemplates || {}) };
    installed[tpl.key] = { agentId: agent.id, at: new Date().toISOString() };
    updateSettings(shop, { installedTemplates: installed });

    console.log(`[template] shop=${shop} ${tpl.key} -> agent=${agent.id} tools=${payload.metadata.tools.length}`);
    res.json({
      agentId: agent.id,
      name: agent.name,
      tools: payload.metadata.tools.length,
      // False means the agent exists but has no store tools — worth saying.
      wired: Boolean(conn?.id),
    });
  } catch (err) {
    telenowFail(res, err, 'template setup');
  }
});

// POST /api/knowledge-bases — create one, optionally with its first document,
// so the merchant can write their returns/COD policy without leaving the wizard.
app.post('/api/knowledge-bases', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = await telenowFor(shop, res, 'provision');
  if (!client) return;
  const name = String(req.body?.name || '').trim();
  if (!name) {
    res.status(400).json({ error: 'bad_request', message: 'A name is required.' });
    return;
  }
  try {
    const orgId = await orgIdFor(shop, client);
    if (!orgId) throw new Error('Could not resolve the Telenow organization.');
    const kb = await client.createKnowledgeBase(orgId, {
      name,
      description: String(req.body?.description || '').trim() || undefined,
    });
    if (!kb?.id) throw new Error('Telenow did not return a knowledge base id.');

    // The first document is optional — a base with no content is still valid,
    // and failing here must not lose the base that was just created.
    let document = null;
    const body = String(req.body?.body || '').trim();
    if (body) {
      try {
        const doc = await client.createKnowledgeDocument(orgId, kb.id, {
          title: String(req.body?.title || '').trim() || name,
          body,
        });
        document = doc?.id || true;
      } catch (err) {
        console.error(`[kb] document add failed for ${kb.id}:`, err.message);
      }
    }
    console.log(`[kb] shop=${shop} created ${kb.id} doc=${document ? 'yes' : 'no'}`);
    res.json({ id: kb.id, name: kb.name, document });
  } catch (err) {
    telenowFail(res, err, 'knowledge base');
  }
});

// GET /api/ndr-endpoint — the URL the merchant gives their courier, minting the
// secret on first request so a shop that never sets up RTO never holds one.
app.get('/api/ndr-endpoint', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  let token = getSettings(shop).ndrToken;
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    updateSettings(shop, { ndrToken: token });
    console.log(`[ndr] minted endpoint token for ${shop}`);
  }
  res.json({ url: `${HOST}/webhooks/ndr/${token}` });
});

// POST /api/ndr-endpoint/rotate — replace the secret if it leaks.
app.post('/api/ndr-endpoint/rotate', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const token = crypto.randomBytes(32).toString('hex');
  updateSettings(shop, { ndrToken: token });
  console.log(`[ndr] rotated endpoint token for ${shop}`);
  res.json({ url: `${HOST}/webhooks/ndr/${token}` });
});

// POST /api/voice-preview — synthesise a sample of one voice and stream the
// audio back, so the wizard's play buttons work without the browser ever
// holding the Telenow key.
//
// The upstream endpoint currently accepts a user JWT only, so an org API key
// gets 401. That is translated into a 501 with an explanation rather than
// passed through as a bare auth error, because it is not the merchant's
// credentials that are wrong — the capability simply is not exposed to keys yet.
app.post('/api/voice-preview', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = await telenowFor(shop, res, 'spend');
  if (!client) return;

  const provider = String(req.body?.provider || '').trim();
  const voice = String(req.body?.voice || '').trim();
  if (!provider) {
    res.status(400).json({ error: 'bad_request', message: 'provider is required' });
    return;
  }
  // Short and capped: a preview costs real TTS characters on every press.
  const text = String(req.body?.text || '').trim().slice(0, 180)
    || 'Hello, this is a quick call from your store about the order you just placed.';

  try {
    const { bytes, contentType } = await client.previewVoice({
      provider, voice, text,
      config: req.body?.model ? { model: String(req.body.model) } : undefined,
    });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(bytes));
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) {
      res.status(501).json({
        error: 'preview_unavailable',
        message: 'Voice preview is not available to API keys yet. '
          + 'Open the agent in Telenow to hear voices.',
      });
      return;
    }
    telenowFail(res, err, 'voice preview');
  }
});

// GET /api/escalations — issues raised by the agents, from the two sources that
// are actually readable.
//
// Deliberately NOT here: Freshdesk tickets. The connector exposes ticket.create
// and nothing else, so a ticket can be raised but never listed back. Nor are
// per-call tool invocations available (/api/sessions/{id}/tool-invocations is
// JWT-only, and /api/v1/calls/{id} carries no tool data), so "which calls raised
// a ticket" cannot be derived either. The UI says so rather than showing a
// half-empty list that looks broken.
app.get('/api/escalations', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;

  // Orders the agents tagged. Independent of Telenow, so it still works when
  // no API key is set.
  let orders = [];
  let ordersError = null;
  try {
    orders = (await findFlaggedOrders(shop, 50)).map((o) => ({
      id: o.id,
      name: o.name,
      createdAt: o.createdAt,
      tags: (o.tags || []).filter((t) => String(t).startsWith('telenow-')),
      note: o.note || '',
      fulfillment: o.displayFulfillmentStatus || null,
      financial: o.displayFinancialStatus || null,
      total: o.totalPriceSet?.shopMoney
        ? `${o.totalPriceSet.shopMoney.amount} ${o.totalPriceSet.shopMoney.currencyCode}` : null,
      customer: [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' ') || null,
      phone: o.customer?.phone || null,
    }));
  } catch (err) {
    ordersError = err.message;
    console.error(`[escalations] order search failed for ${shop}:`, err.message);
  }

  // Calls that ended without a clean outcome, from this store's own agents.
  let calls = [];
  let callsError = null;
  const saved = getSavedAgents(shop);
  const client = await telenowForOrNull(shop);
  if (client && saved.length) {
    try {
      const pages = await Promise.all(saved.slice(0, 10).map((id) =>
        client.listCalls({ limit: 50, agentId: id, sort: 'newest' }).catch(() => ({ calls: [] }))));
      const UNRESOLVED = new Set(['no-answer', 'failed', 'busy', 'cancelled']);
      calls = pages.flatMap((p) => p.calls || [])
        .filter((c) => UNRESOLVED.has(String(c.disposition || c.wrapup_disposition || '').toLowerCase()))
        .sort((a, b) => new Date(b.start_time || 0) - new Date(a.start_time || 0))
        .slice(0, 50)
        .map((c) => ({
          id: c.id, agent: c.agent_name, when: c.start_time,
          to: c.to_number || c.phone_number,
          disposition: c.disposition || c.wrapup_disposition,
          duration: c.duration_sec,
        }));
    } catch (err) {
      callsError = err.message;
    }
  }

  res.json({ orders, calls, ordersError, callsError, hasAgents: saved.length > 0 });
});

// GET /api/integrations — every connector this workspace has connected, so the
// wizard can tell whether a helpdesk is already available for ticket.create.
// Credentials are never included: they come back masked upstream anyway.
app.get('/api/integrations', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = await telenowFor(shop, res);
  if (!client) return;
  try {
    const conns = await client.listConnections();
    res.json({
      connections: conns.map((c) => ({
        id: c.id, providerId: c.providerId, label: c.label,
        status: c.status, capabilities: c.capabilities || [],
      })),
    });
  } catch (err) {
    telenowFail(res, err, 'integrations');
  }
});

// POST /api/integrations/connect — connect a non-Shopify provider from inside
// the wizard, so a merchant can wire up Freshdesk without leaving the setup.
//
// Shopify is excluded on purpose: it connects itself from the OAuth token this
// app already holds, and accepting a pasted one here would let a merchant point
// their Telenow workspace at a different store.
app.post('/api/integrations/connect', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = await telenowFor(shop, res);
  if (!client) return;
  const providerId = String(req.body?.providerId || '').trim();
  if (!providerId || providerId === 'shopify') {
    res.status(400).json({ error: 'bad_request', message: 'A non-Shopify providerId is required.' });
    return;
  }
  const credentials = req.body?.credentials && typeof req.body.credentials === 'object'
    ? req.body.credentials : {};
  const settings = req.body?.settings && typeof req.body.settings === 'object'
    ? req.body.settings : {};
  try {
    const created = await client.createConnection({
      providerId, label: providerId + ' — ' + shop, credentials, settings,
      idempotencyKey: providerId + '-connect-' + shop,
    });
    const conn = created?.connection ?? created;
    console.log(`[integration] shop=${shop} connected ${providerId} status=${conn?.status}`);
    res.json({
      id: conn?.id || null, status: conn?.status || null,
      capabilities: conn?.capabilities || [],
      // A failed verification still returns 201 upstream, so report it apart
      // from whether the connection exists.
      verified: created?.verification?.ok !== false,
      error: created?.verification?.error || conn?.lastError || null,
    });
  } catch (err) {
    telenowFail(res, err, 'integration connect');
  }
});

// GET /api/knowledge-bases — the org's knowledge bases, for the setup wizard.
app.get('/api/knowledge-bases', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = await telenowFor(shop, res);
  if (!client) return;
  try {
    const orgId = await orgIdFor(shop, client);
    const list = orgId ? await client.listKnowledgeBases(orgId) : [];
    res.json({ knowledgeBases: list.map((k) => ({
      id: k.id, name: k.name, description: k.description, documents: k.document_count,
    })) });
  } catch (err) {
    telenowFail(res, err, 'knowledge bases');
  }
});

// POST /api/templates/:key/publish — the setup wizard's final step.
//
// Creates the agent with the merchant's chosen stack, voice, prompt and opener,
// attaches a knowledge base if they picked one, and switches on the matching
// automation so new orders actually trigger the call.
app.post('/api/templates/:key/publish', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const tpl = getTemplate(req.params.key);
  if (!tpl) {
    res.status(404).json({ error: 'unknown_template', message: 'No such template.' });
    return;
  }
  const client = await telenowFor(shop, res, 'provision');
  if (!client) return;
  const b = req.body || {};

  try {
    // The tools are the point, so make sure the store is connected first.
    let conn = (await client.listConnections('shopify'))
      .find((c) => c?.settings?.store_domain === shop) || null;
    if (!conn) {
      const r = await connectShopifyIntegration(shop, client);
      if (r.connected) {
        conn = (await client.listConnections('shopify'))
          .find((c) => c?.settings?.store_domain === shop) || null;
      }
    }

    const profile = await getShopProfile(shop).catch(() => null);
    // Boundaries chosen in the Access step become prompt rules. They are
    // appended rather than merged into the body so an edited prompt keeps them.
    const scope = req.body?.scope || {};
    const rules = [
      scope.noRefund && '- Never promise a refund, or state a refund amount. Say the team will confirm it.',
      scope.noDiscount && '- Never offer a discount, a free replacement or any goodwill gesture.',
      scope.noDate && '- Never promise a delivery date that the order data does not show.',
      scope.hours && `- Your team is available ${String(scope.hours).slice(0, 120)}. Mention that when something needs a person.`,
      b.orderConfirm && b.orderConfirm.checkItems === false
        && '- Do NOT read the items or quantity back. Confirm the order exists and move on.',
      b.orderConfirm && b.orderConfirm.checkAddress === false
        && '- Do NOT read the delivery address back.',
      b.orderConfirm?.checkPhone
        && '- Before ending, ask whether this number is the right one for delivery updates.',
      b.postPurchase && b.postPurchase.crossSell === false
        && '- Do NOT recommend or sell anything on this call. Check in, answer questions, and end.',
      b.postPurchase?.crossSell && !b.postPurchase?.waConnectionId
        && '- You cannot send a link. If they want the product, tell them you will have the team message them.',
      b.feedback?.tagOrder && '- After they give a score, use update_order to tag the order telenow-feedback-<score> and add their exact words as a note.',
      b.feedback?.flagLow && '- If the score is 3 or below, also tag it telenow-feedback-low so a person follows up. Tell them someone from the team will call.',
    ].filter(Boolean);
    const NL = String.fromCharCode(10);
    const promptOverride = rules.length
      ? [String(b.systemPrompt || tpl.prompt), '', '## Limits set by the store', ...rules].join(NL)
      : b.systemPrompt;

    // With cross-sell off, the checkout tool is removed outright — a prompt rule
    // alone still leaves the model holding a way to spend the customer's money.
    const tplForBuild = (b.postPurchase && b.postPurchase.crossSell === false)
      ? { ...tpl, capabilities: tpl.capabilities.filter((c) => c !== 'checkout.create_link') }
      : tpl;

    const payload = buildAgentPayload(tplForBuild, shop, profile?.name, conn?.id || null, {
      llmProvider: b.llmProvider, llmModel: b.llmModel,
      sttProvider: b.sttProvider, sttModel: b.sttModel,
      ttsProvider: b.ttsProvider, ttsVoice: b.ttsVoice, ttsModel: b.ttsModel,
      systemPrompt: promptOverride, opener: b.opener, speakOpener: b.speakOpener,
      transferDestinations: b.transferDestinations, transferMessage: b.transferMessage,
      // Off unless the wizard explicitly asked for it — it is billed per call.
      postCallAnalysis: b.postCallAnalysis === true,
      // Escalation tools, each bound to the connection that provides it.
      extraTools: [
        // Feedback writes the score back as a tag + note, so it needs the write
        // capability its template does not carry by default.
        // The link is created by the Shopify connector but delivered by the
        // WhatsApp one, so the two tools carry different connection ids.
        b.postPurchase?.crossSell && b.postPurchase?.waConnectionId
          ? { capability: 'whatsapp.send', connectionId: b.postPurchase.waConnectionId } : null,
        (b.feedback?.tagOrder || b.feedback?.flagLow) && conn?.id
          ? { capability: 'order.update', connectionId: conn.id } : null,
        b.escalation?.logOnOrder && conn?.id
          ? { capability: 'order.update', connectionId: conn.id } : null,
        b.escalation?.freshdeskConnectionId
          ? { capability: 'ticket.create', connectionId: b.escalation.freshdeskConnectionId } : null,
      ].filter(Boolean),
    });
    const agent = await client.createAgent(payload);
    if (!agent?.id) throw new Error('Telenow did not return an agent id.');

    // Inbound: bind the number so customers can actually reach the agent. Done
    // after creation because it needs the agent id, and reported separately so
    // a 409 does not throw away an otherwise-good agent.
    //
    // This is the ONE spending act in an otherwise free route (see gateFor), and
    // it is the point where the gate changes shape: publishing costs nothing,
    // but a bound number is a standing invitation for strangers to dial in and
    // burn minutes with no request of ours in the path to refuse. So the binding
    // asks for 'spend' on its own, and a shop that cannot spend gets the agent
    // it published with the line parked rather than live.
    //
    // The intent is recorded either way, in settings.inboundBindings, so
    // enforceInboundAccess() can put the line back the moment the shop can pay
    // for it — and take it down again when it cannot.
    let inbound = null;
    if (b.inboundNumberId) {
      const numberId = String(b.inboundNumberId);
      const spend = await checkAccess(shop, 'spend');
      if (!spend.ok) {
        rememberInboundBinding(shop, numberId, agent.id, true);
        inbound = {
          assigned: false,
          parked: true,
          billing: spend.body?.error || 'blocked',
          error: spend.body?.message
            || 'Calling is paused on this plan, so the number is not live yet.',
        };
        console.log(`[inbound] shop=${shop} publish parked number=${numberId} (${spend.body?.error})`);
      } else {
        try {
          await client.assignNumberToAgent(numberId, agent.id);
          rememberInboundBinding(shop, numberId, agent.id, false);
          inbound = { assigned: true };
        } catch (err) {
          inbound = { assigned: false, error: err.message, conflict: err?.status === 409 };
          console.error(`[publish] number assign failed for ${agent.id}:`, err.message);
        }
      }
    }

    // Knowledge base is optional and must never sink a successful publish.
    let knowledgeBase = null;
    if (b.knowledgeBaseId) {
      try {
        const orgId = await orgIdFor(shop, client);
        await client.attachKnowledgeBase(orgId, agent.id, b.knowledgeBaseId);
        knowledgeBase = b.knowledgeBaseId;
      } catch (err) {
        console.error(`[publish] KB attach failed for ${agent.id}:`, err.message);
      }
    }

    // Switch the automation on, so an order actually triggers a call.
    const delaySeconds = Math.max(0, Number(b.delaySeconds) || 0);
    let automation = null;
    if (AUTOMATIONS.some((a) => a.key === tpl.automationKey)) {
      updateSettings(shop, { automations: { [tpl.automationKey]: {
        enabled: b.enableAutomation !== false,
        agentId: agent.id,
        delaySeconds,
        fromNumberId: String(b.fromNumberId || '') || undefined,
        // RTO only: the courier fires one NDR per attempt, and maxAttempts
        // decides how many of those become calls.
        // Per-template filters the sweeps and receivers read back.
        filters: (b.maxAttempts || b.feedback || b.postPurchase || b.orderConfirm)
          ? {
              ...(getAutomation(shop, tpl.automationKey)?.filters || {}),
              ...(b.maxAttempts ? { maxAttempts: Math.max(1, Number(b.maxAttempts) || 1) } : {}),
              ...(b.orderConfirm ? {
                skipCod: b.orderConfirm.skipCod !== false,
                minOrderValue: Math.max(0, Number(b.orderConfirm.minOrderValue) || 0),
              } : {}),
              ...(b.postPurchase ? {
                daysAfterFulfillment: Math.max(1, Number(b.postPurchase.daysAfterFulfillment) || 10),
                maxAgeDays: Math.max(7, Number(b.postPurchase.maxAgeDays) || 30),
                minOrderValue: Math.max(0, Number(b.postPurchase.minOrderValue) || 0),
                maxPerSweep: Math.max(1, Number(b.postPurchase.maxPerSweep) || 25),
                suppressDays: Math.max(0, Number(b.postPurchase.suppressDays ?? 14)),
              } : {}),
              ...(b.feedback ? {
                daysAfterFulfillment: Math.max(1, Number(b.feedback.daysAfterFulfillment) || 7),
                maxAgeDays: Math.max(7, Number(b.feedback.maxAgeDays) || 30),
                minOrderValue: Math.max(0, Number(b.feedback.minOrderValue) || 0),
                maxPerSweep: Math.max(1, Number(b.feedback.maxPerSweep) || 25),
              } : {}),
            }
          : undefined,
        quietHours: b.quietHours && typeof b.quietHours === 'object'
          ? {
              enabled: Boolean(b.quietHours.enabled),
              start: String(b.quietHours.start || '21:00'),
              end: String(b.quietHours.end || '09:00'),
              timezone: String(b.quietHours.timezone || 'Asia/Kolkata'),
            }
          : undefined,
      } } });
      automation = tpl.automationKey;
    }

    addSavedAgent(shop, agent.id);
    const installed = { ...(getSettings(shop).installedTemplates || {}) };
    installed[tpl.key] = { agentId: agent.id, at: new Date().toISOString() };
    updateSettings(shop, { installedTemplates: installed });

    console.log(`[publish] shop=${shop} ${tpl.key} -> agent=${agent.id} ` +
      `tools=${payload.metadata.tools.length} kb=${knowledgeBase || 'none'} delay=${delaySeconds}s`);
    res.json({
      agentId: agent.id, name: agent.name,
      tools: payload.metadata.tools.length,
      wired: Boolean(conn?.id),
      knowledgeBase, automation, delaySeconds, inbound,
    });
  } catch (err) {
    telenowFail(res, err, 'publish');
  }
});

// GET /api/numbers — the calling numbers on this shop's leased workspace, for
// the "call from" and inbound pickers.
//
// An empty list is a NORMAL state, not an error, and the UI must keep saying so:
// the number is still being set up, and the browser call needs no number at all.
// There is deliberately no "no numbers? go buy one" branch anywhere downstream of
// this route — sending a merchant off Shopify to a carrier or to telenow.ai to
// obtain the thing they are already paying for is the off-platform purchase this
// app was paused for under requirement 1.2.1. Numbers arrive with the plan.
//
// PROJECTION, NOT PASS-THROUGH. The six fields below are exactly what the
// platform's GET /api/v1/numbers returns, and the shape is pinned here so that a
// field the upstream adds later (a wholesale carrier account id, a rent figure,
// an internal org id) cannot silently start appearing in a merchant's browser
// just because it appeared upstream.
//
// `provider` and `country` are carried through because the pool is genuinely
// mixed — Twilio and Plivo, and numbers in whatever countries the operator has
// stocked — so "which number is this and will it reach my shoppers" is a real
// question a merchant can only answer if the picker tells them. Both are
// nullable upstream (`country` maps to a nullable column, and an entry may
// simply predate the label), so the UI renders them when present and says
// nothing when absent. Absent means UNKNOWN; it never means India.
app.get('/api/numbers', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = await telenowFor(shop, res);
  if (!client) return;
  try {
    const numbers = await client.listNumbers();
    res.json({
      numbers: numbers
        // Only live numbers can place a call, so do not offer the others.
        .filter((n) => n && n.is_active !== false)
        .map((n) => ({
          id: n.id,
          phone_number: n.phone_number,
          provider: n.provider || null,
          country: n.country || null,
          agent_id: n.agent_id || null,
          is_active: n.is_active !== false,
        })),
    });
  } catch (err) {
    telenowFail(res, err, 'numbers');
  }
});

/**
 * The ISO-2 country this shop's unqualified local numbers belong to.
 *
 * Ordinary reads come off settings.shopCountry, which provisioning fills in when
 * the workspace is leased. The Admin API call behind getShopCountry() is only
 * reached when that cache is cold — a store installed before shopCountry
 * existed, or one whose lookup failed at install time — and it is awaited rather
 * than skipped because the alternative is showing a North-American merchant an
 * Indian example on the single most visible field in the app. It never throws
 * and it write-through caches, so this is at most one query per shop, ever.
 *
 * The PRECEDENCE (explicit → shop country → env → 'US') is not re-implemented
 * here; resolveCountry() owns it. This function only decides how hard to work
 * for the shopCountry candidate before handing it over.
 */
async function dialCountryFor(shop) {
  let shopCountry = getSettings(shop).shopCountry || null;
  if (!shopCountry) shopCountry = await getShopCountry(shop).catch(() => null);
  return resolveCountry({ shopCountry, envDefault: process.env.DEFAULT_PHONE_COUNTRY });
}

// POST /api/test-call — ring the merchant's own phone so they can talk to an
// agent. Telephony rather than a browser web call: this UI runs in an iframe
// inside admin.shopify.com, where a web call would need mic permission and a
// WebRTC stack. This is one server-side POST and the merchant answers a phone.
//
// This SPENDS the merchant's Telenow balance, so the number is validated here
// as well as in the UI — never trust the client for something that costs money.
//
// THIS IS THE BUTTON A SHOPIFY REVIEWER PRESSES, and it used to be an India-only
// door in two ways. It demanded a fully-qualified E.164 string, so a reviewer
// typing their own number the way North Americans write it — (415) 555-0123 —
// was rejected outright; and the rejection then taught them the format with an
// Indian example. Both are fixed below: the number is normalised against the
// SHOP's country first and only then held to the strict E.164 shape, and the
// hint is built from that same country. The strict check still runs, on the
// normalised value, because this route spends money.
app.post('/api/test-call', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = await telenowFor(shop, res, 'spend');
  if (!client) return;

  const agentId = String(req.body?.agentId || '').trim();
  if (!agentId) {
    res.status(400).json({ error: 'bad_request', message: 'agentId is required' });
    return;
  }

  const country = await dialCountryFor(shop);
  // toE164 passes an already-international number (leading + or 00) straight
  // through, so a merchant who dials a country other than their own still gets
  // exactly the number they typed. The shop country only fills in the code that
  // a bare local number is missing.
  const typed = String(req.body?.mobileNumber || '').trim();
  const mobileNumber = toE164(typed, country) || typed;
  // E.164: leading +, no leading zero, 7-15 digits total.
  if (!new RegExp("^[+][1-9][0-9]{6,14}$").test(mobileNumber)) {
    res.status(400).json({
      error: 'bad_number',
      message: `Enter a number in E.164 form, e.g. ${exampleNumberFor(country)}.`,
    });
    return;
  }

  // Only string values, and only for keys the caller actually sent — the agent
  // substitutes these into its prompt.
  const variables = {};
  const raw = req.body?.variables;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v.trim()) variables[k] = v.trim().slice(0, 500);
    }
  }

  try {
    const result = await client.initiateCall({
      agentId,
      mobileNumber,
      variables,
      identifier: 'shopify-test:' + shop,
      // Optional. Blank means "let the agent decide" for both.
      fromNumberId: String(req.body?.fromNumberId || '').trim() || undefined,
      machineDetection: String(req.body?.machineDetection || 'agent').trim(),
    });
    console.log(`[test-call] shop=${shop} agent=${agentId} session=${result?.sessionId || '?'}`);
    res.json({ sessionId: result?.sessionId || null });
  } catch (err) {
    telenowFail(res, err, 'test call');
  }
});

// How deep merged pagination can go. Serving rows [offset, offset+limit) of a
// merged stream means pulling offset+limit rows from EVERY agent, so the fetch
// grows with page depth — this caps that rather than letting page 40 fan out
// into a huge multi-agent read.
const MERGE_DEPTH_CAP = 400;

// GET /api/calls — call history, restricted to the agents this store added.
//
// The org's Telenow account may run agents unrelated to this shop, so showing
// every call would leak other conversations into the merchant's list. Scope is
// savedAgents, not the org.
//
// One saved agent uses the upstream agent_id filter directly (exact total, one
// request, real offset). Several are fetched in parallel and merged, because
// that filter takes a single id.
app.get('/api/calls', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = await telenowFor(shop, res);
  if (!client) return;

  const saved = getSavedAgents(shop);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const empty = { calls: [], total: 0, limit, offset: 0, hasMore: false, scopedToAgents: saved.length };
  if (!saved.length) { res.json({ ...empty, scopedToAgents: 0 }); return; }

  const status = req.query.status || undefined;
  const sort = req.query.sort || undefined;
  // An explicit ?agentId= narrows further, but only within the saved set.
  const only = String(req.query.agentId || '').trim();
  const ids = only ? saved.filter((id) => id === only) : saved;
  if (!ids.length) { res.json(empty); return; }

  try {
    if (ids.length === 1) {
      const r = await client.listCalls({ limit, offset, status, sort, agentId: ids[0] });
      res.json({
        calls: r.calls, total: r.total, limit, offset,
        hasMore: offset + (r.calls?.length || 0) < (r.total || 0),
        scopedToAgents: saved.length,
      });
      return;
    }

    // Pull enough from each agent that the merged stream reaches this page.
    const need = Math.min(offset + limit, MERGE_DEPTH_CAP);
    const pages = await Promise.all(
      ids.map((id) => client.listCalls({ limit: Math.min(need, 200), offset: 0, status, sort, agentId: id })
        .catch(() => ({ calls: [], total: 0 }))),
    );
    const merged = pages.flatMap((p) => p.calls || []);
    const total = pages.reduce((n, p) => n + (p.total || 0), 0);
    // Each page was sorted on its own, so the concatenation is not sorted.
    const time = (c) => new Date(c.start_time || c.created_at || 0).getTime() || 0;
    const dur = (c) => Number(c.duration_sec) || 0;
    const cmp = {
      oldest: (a, b) => time(a) - time(b),
      longest: (a, b) => dur(b) - dur(a),
      shortest: (a, b) => dur(a) - dur(b),
    }[sort] || ((a, b) => time(b) - time(a));
    merged.sort(cmp);

    res.json({
      calls: merged.slice(offset, offset + limit),
      total, limit, offset,
      hasMore: merged.length > offset + limit,
      // True when the cap, not the data, ended the list — so the UI can say so
      // instead of implying there is nothing further.
      depthCapped: need >= MERGE_DEPTH_CAP && total > MERGE_DEPTH_CAP,
      scopedToAgents: saved.length,
    });
  } catch (err) {
    telenowFail(res, err, 'calls');
  }
});

// GET /api/calls/:id — one call, for the detail drawer.
app.get('/api/calls/:id', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = await telenowFor(shop, res);
  if (!client) return;
  try {
    res.json(await client.getCallDetail(req.params.id));
  } catch (err) {
    telenowFail(res, err, 'call');
  }
});

// GET /api/shop — merchant profile synced from Shopify, shown in the UI header
// and the welcome flow. Cached per request; the Admin call is cheap and rare.
app.get('/api/shop', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  try {
    const profile = await getShopProfile(shop);
    res.json({ shop: profile });
  } catch (err) {
    console.error('[api] shop profile failed:', err.message);
    // Non-fatal: the UI still works without it, so degrade instead of erroring.
    res.json({ shop: null, error: err.message });
  }
});

// POST /api/onboarding/complete — records that the welcome flow was seen, so
// it only ever shows once per shop.
app.post('/api/onboarding/complete', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const saved = updateSettings(shop, { onboardedAt: new Date().toISOString() });
  res.json({ onboardedAt: saved.onboardedAt });
});

// GET captured leads (newest first) for the Leads view in the embedded app.
app.get('/api/leads', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  res.json({ leads: listLeads(shop, 100) });
});

// POST settings update.
//
// Gate 3 of five, and the reason there is more than one gate at all: switching an
// automation on is an act of SPENDING — it arms a trigger that will place paid
// calls for months — but it reaches the store through sanitizeSettingsPatch and
// never constructs a Telenow client, so Gate 1 cannot see it. Without the check
// below, a shop with no plan and no minutes could arm every automation it liked
// and only discover the block later, from inside a webhook, where the merchant
// is not there to be told.
app.post('/api/settings', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;

  const patch = sanitizeSettingsPatch(req.body);

  const enabling = Object.values(patch.automations || {}).some((a) => a && a.enabled);
  if (enabling) {
    // 'spend', not 'provision', and that is the whole distinction gateFor()
    // draws. Creating an agent is free; arming the trigger that will call
    // customers on that agent for months is a commitment to spend, and a shop
    // with nothing left to spend must be told at the switch rather than in a
    // webhook an hour later where nobody is listening. This asks for the strict
    // answer explicitly so it keeps blocking on an exhausted allowance even
    // after 'provision' stops doing so.
    const gate = await checkAccess(shop, 'spend');
    if (!gate.ok) {
      res.status(402).json(gate.body);
      return;
    }
    // Counted after the merge, not on the patch alone: the browser sends only
    // the automation it touched, so counting the patch would let a merchant arm
    // them one request at a time and never exceed the limit.
    const after = countEnabledAfterMerge(shop, patch);
    const max = (PLANS[gate.ent.plan] || PLANS.starter).maxActiveAutomations;
    if (after > max) {
      res.status(402).json({
        error: 'plan_limit',
        plan: gate.ent.plan,
        limit: 'maxActiveAutomations',
        allowed: max,
        message: `Starter includes ${max} active automation. Choose a plan to run more.`,
        action: 'choose_plan',
        suggestPlan: 'growth',
      });
      return;
    }
  }

  updateSettings(shop, patch);
  res.json({ settings: getRedactedSettings(shop), hookStatus: '' });
});

/**
 * How many automations would be enabled once this patch is merged?
 *
 * updateSettings deep-merges per automation key, so the answer is the stored
 * state with the patch's keys overridden — not the patch, and not the stored
 * state. Keys the patch does not mention keep whatever they had.
 *
 * @param {string} shop
 * @param {{automations?: object}} patch
 */
function countEnabledAfterMerge(shop, patch) {
  const current = getSettings(shop).automations || {};
  const incoming = patch.automations || {};
  let n = 0;
  for (const def of AUTOMATIONS) {
    const proposed = Object.prototype.hasOwnProperty.call(incoming, def.key)
      ? incoming[def.key]
      : current[def.key];
    if (proposed && proposed.enabled) n += 1;
  }
  return n;
}

/**
 * Whitelist + coerce the settings patch coming from the browser so we never
 * persist arbitrary fields. Mirrors the shape settings.js understands.
 *
 * `telenowApiKey` is absent from this whitelist on purpose. The calling
 * workspace is leased by the server and lives in the same field, so accepting it
 * from the browser would let a merchant point their store at an arbitrary
 * workspace — and would keep alive the one input that made this app look like it
 * billed off-platform. There is no path from the page to that field any more.
 */
function sanitizeSettingsPatch(body = {}) {
  const out = {};
  if (body.winBackDays != null) out.winBackDays = Number(body.winBackDays) || 60;

  if (body.automations && typeof body.automations === 'object') {
    out.automations = {};
    for (const def of AUTOMATIONS) {
      const a = body.automations[def.key];
      if (!a) continue;
      out.automations[def.key] = {
        enabled: Boolean(a.enabled),
        agentId: typeof a.agentId === 'string' ? a.agentId.trim() : '',
        delayMinutes: Math.max(0, Number(a.delayMinutes) || 0),
        delaySeconds: a.delaySeconds == null || a.delaySeconds === ''
          ? undefined
          : Math.max(0, Number(a.delaySeconds) || 0),
        filters: a.filters && typeof a.filters === 'object' ? a.filters : undefined,
        quietHours: a.quietHours
          ? {
              enabled: Boolean(a.quietHours.enabled),
              start: String(a.quietHours.start || '21:00'),
              end: String(a.quietHours.end || '09:00'),
              timezone: String(a.quietHours.timezone || 'Asia/Kolkata'),
            }
          : undefined,
      };
      // Drop undefined keys so updateSettings' deep-merge keeps existing values.
      if (out.automations[def.key].delaySeconds === undefined) delete out.automations[def.key].delaySeconds;
      if (out.automations[def.key].filters === undefined) delete out.automations[def.key].filters;
      if (out.automations[def.key].quietHours === undefined) {
        delete out.automations[def.key].quietHours;
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled jobs (win-back + reviews)
//
// Simple setInterval scheduler. TODO: swap for node-cron or a real job runner in
// production; also guard against overlapping runs across multiple instances.
// ─────────────────────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS) || 6 * 60 * 60 * 1000; // 6h

function startSchedulers() {
  const tick = async () => {
    try {
      await runWinBackSweep();
    } catch (err) {
      console.error('[scheduler] win-back sweep error:', err.message);
    }
    try {
      await runReviewsSweep();
    } catch (err) {
      console.error('[scheduler] reviews sweep error:', err.message);
    }
    try {
      await runPostPurchaseSweep();
    } catch (err) {
      console.error('[scheduler] post-purchase sweep error:', err.message);
    }
    // Reconciliation backstop for the app_subscriptions/update webhook.
    //
    // Webhooks get lost — a deploy mid-delivery, a 500 from a cold start, a
    // topic that silently failed to register. When the lost one says "this
    // merchant's card was declined", the app keeps serving a plan nobody is
    // paying for; when it says "they upgraded", the app keeps blocking a
    // merchant who has paid, which is the worse of the two. Re-reading every
    // shop from the Admin API on the sweep makes the webhook an optimisation
    // rather than a dependency. Each shop is caught on its own so one revoked
    // token cannot stop the others being reconciled.
    for (const row of listShops()) {
      try {
        await refreshEntitlement(row.shop);
      } catch (err) {
        console.error('[scheduler] entitlement refresh failed for', row.shop + ':', err.message);
      }
      // Reconciling inbound straight after the entitlement read is what makes
      // this loop the backstop for the one gate nothing else can reach: a shop
      // that ran out of minutes on inbound calls alone never touches a route,
      // so this sweep is the only thing that will take its number down. It is
      // also the path that restores a number after a webhook we never received.
      try {
        await enforceInboundAccess(row.shop);
      } catch (err) {
        console.error('[scheduler] inbound reconcile failed for', row.shop + ':', err.message);
      }
    }
  };
  // Don't run immediately at boot (let the process settle); first run after one
  // interval. Set SWEEP_RUN_ON_BOOT=1 to run once at startup for testing.
  if (process.env.SWEEP_RUN_ON_BOOT === '1') tick();
  const t = setInterval(tick, SWEEP_INTERVAL_MS);
  t.unref?.(); // don't keep the process alive solely for the timer
  console.log(`[scheduler] sweeps every ${Math.round(SWEEP_INTERVAL_MS / 3600000)}h`);
}

// ── 404 + error handlers ──────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[server] unhandled error:', err);
  if (!res.headersSent) res.status(500).json({ error: 'internal error' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
// Refuse to start on a misconfigured public origin rather than come up looking
// healthy and then hand localhost URLs to Shopify and Telenow. See the comment
// on assertHostConfig — the Telenow registration is not self-healing.
assertHostConfig();

const server = app.listen(PORT, () => {
  console.log(`\nTelenow Shopify app listening on :${PORT}`);
  console.log(`  Public HOST:        ${HOST}`);
  console.log(`  Install URL:        ${HOST}/auth?shop=telenow.myshopify.com`);
  console.log(`  Settings UI:        ${HOST}/app?shop=telenow.myshopify.com`);
  console.log(`  Shopify webhooks →  ${HOST}/webhooks/shopify`);
  console.log(`  Telenow webhooks →  ${HOST}/telenow/webhook`);
  console.log(`  Telenow API base:   ${process.env.TELENOW_API_BASE || 'https://api.telenow.ai'}\n`);
  startSchedulers();
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Container platforms send SIGTERM on every redeploy and wait a grace period
// before SIGKILL. Without a handler, Node exits immediately and in-flight
// requests are dropped — a webhook Shopify considers delivered never finishes
// its write-back, and Shopify won't retry a connection it saw accepted.
//
// The store itself is safe either way: persist() is writeFileSync to a tmp file
// followed by renameSync, both synchronous, so a signal cannot land mid-write
// and the rename is atomic. This is about the HTTP layer, not the data.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received — finishing in-flight requests…`);

  // Stop accepting new connections; the callback fires once existing ones drain.
  server.close(() => {
    console.log('[server] closed cleanly');
    process.exit(0);
  });

  // Backstop: a hung keep-alive connection must not outlast the platform's
  // grace period, or we get SIGKILLed anyway with a worse exit code.
  setTimeout(() => {
    console.error('[server] drain timed out — forcing exit');
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app };
