// ─────────────────────────────────────────────────────────────────────────────
// test/billing.mjs — offline regression harness for Shopify billing + the
// workspace pool. Sibling of test/roundtrip.mjs and built the same way: a
// throwaway DATA_DIR, no network, no real Shopify store, no real Telenow, plain
// assertions, `node test/billing.mjs`, non-zero exit on any FAIL.
//
// Shopify paused this app under requirement 1.2.1. Everything asserted here is
// load-bearing for the resubmission, so the checks are written against the REAL
// modules and, where the rule is an HTTP contract, against the REAL routes over
// a real socket — not against reimplementations of them.
//
// WHAT IS STUBBED, AND WHY ONLY THIS MUCH:
//
//   • `shopify.billing.check` is replaced with a table of subscriptions this
//     file controls. It is the one function whose answer comes from Shopify's
//     servers and cannot be produced locally, and every entitlement in the app
//     is derived from it — so controlling it is enough to drive Starter, ACTIVE
//     Growth, FROZEN and "cancelled mid-flight" through the same code paths a
//     merchant would.
//
//   • `globalThis.fetch` is intercepted FOR ADMIN GRAPHQL ONLY (requests to
//     https://<shop>.myshopify.com/admin/api/…). That is where
//     appUsageRecordCreate goes, and counting those calls is the only way to
//     prove the "exactly one usage record per Telenow session, even on
//     redelivery" rule. Every other request — the mock Telenow, this file's own
//     HTTP calls — goes through the real fetch untouched.
//
// Nothing else is faked. The Express app, the session-token auth, the billing
// gate, the usage ledger, the Telenow webhook receiver, the automation base and
// the workspace pool are the shipping code.
//
// THE CHECKS:
//   a) no subscription        → Starter; reads pass; spend passes until 25
//                               minutes, then 402 minutes_exhausted
//   b) ACTIVE Growth          → spend passes; minutes past 300 produce EXACTLY
//                               ONE appUsageRecordCreate per Telenow session id,
//                               including when the webhook is redelivered
//   c) FROZEN                 → reads still pass, spend 402 billing_frozen
//   d) 2nd automation on
//      Starter                → 402 plan_limit
//   e) REGRESSION: a subscription cancelled DURING a delayed placeCall does not
//      fire the call. This was a live bug — the deferred setTimeout branch in
//      src/automations/_base.js re-checked only `enabled` and quiet hours, so a
//      merchant who cancelled inside a 30-minute abandoned-checkout delay was
//      still charged for the call. It is regression-tested with a positive
//      control on either side, because a test that only asserts "no call
//      happened" passes just as well when the harness is broken.
//   f) releaseWorkspace() QUARANTINES the pool entry: the next shop gets a
//      different workspace, never the one the departing merchant used. A
//      released workspace still holds that merchant's call recordings,
//      transcripts and customers' phone numbers, so recycling it would hand one
//      shop's protected customer data to another.
//   g) THE LEASE IS COUNTRY-AWARE AND NEVER COUNTRY-BLOCKED. A shop whose
//      Shopify country resolves to US is leased a US number while one is free;
//      a shop in a country the pool does not stock is still leased SOMETHING
//      rather than refused; and the 48h same-shop reclaim after a reinstall
//      outranks both. The first rule is what makes a North-American reviewer's
//      test call connect — a foreign DID ringing a US mobile is routinely
//      blocked, and "Send a test call" is the most prominent button in the app.
//      The second is why it is a preference and not a filter: a working foreign
//      number beats a 503, which is an app that does nothing at all. The third
//      protects the merchant's data, which lives in the workspace they had.
//      It RUNS BEFORE (f) in the code, because (f) ends by draining the pool to
//      exhaustion on purpose and nothing after it can lease anything at all.
//   h) EVERY PLAN CARRIES A NON-ZERO COST CEILING, AND IT REACHES THE WIRE.
//      The shipped code sent `monthlySpendCapUsd: Number(billing.capUsd) || 0`
//      on provision, and every shop is on Starter at install time — whose capUsd
//      is 0. Upstream a non-positive requested cap is not "spend nothing", it is
//      "no ceiling of my own", so the workspace inherits the PARTNER's whole
//      budget; and nothing corrected it later either, because
//      updatePartnerWorkspace() had no call site anywhere in this repo. Every
//      workspace this app ever provisioned was therefore effectively uncapped —
//      which is also the containment the UNAUTHENTICATED carrier NDR endpoint in
//      src/webhooks/ndr.js is supposed to sit behind. It runs AFTER (f) because
//      the partner plane mints rather than leases and needs no pool inventory.
//   i) THE MODEL STACK IS PINNED AND A MERCHANT CANNOT MOVE IT. The app sells
//      minutes at a flat price but used to let the wizard pick the LLM, the STT
//      and the TTS inside that minute, so cost per minute varied 2.9x from two
//      dropdowns against a fixed $0.12 of overage revenue. buildAgentPayload()
//      must now return the shipped STACK no matter what the caller passes, and
//      the check carries a positive control (name/opener DO still apply) so a
//      harness that has stopped passing overrides at all cannot pass it.
//
// Run:  node test/billing.mjs        (or npm run test:billing)
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { startMockTelenow, httpPost } from './mock-telenow.mjs';

// ── Test config ──────────────────────────────────────────────────────────────
const TEST_PORT = 4013;
const HOST = `http://127.0.0.1:${TEST_PORT}`;
const SHOPIFY_API_SECRET = 'shpss_test_secret_billing';

const SHOP_STARTER = 'starter-shop.myshopify.com';
const SHOP_GROWTH = 'growth-shop.myshopify.com';
const SHOP_LIMIT = 'limit-shop.myshopify.com';
const SHOP_DEFERRED = 'deferred-shop.myshopify.com';
const SHOP_Q1 = 'quarantine-one.myshopify.com';
const SHOP_Q2 = 'quarantine-two.myshopify.com';
const SHOP_PARTNER = 'partner-shop.myshopify.com';

const TEST_NUMBER = '+919876543210';

/**
 * The workspace the faked partner plane mints, and the credential it hands back.
 *
 * The ref is asserted on (the PATCH has to target the workspace that create
 * returned, or the ceiling lands on somebody else's org); the key is never
 * printed, compared against a log, or included in any `detail` string — same
 * rule as the pool's vai_live_ values.
 */
const PARTNER_WORKSPACE_ID = 'pw-test-0001';
const PARTNER_MINTED_KEY = 'vai_live_partnermint_0001';

/**
 * The usage line item gid Shopify hands back. The query string is not
 * decoration: `?v=1&index=1` is part of the id, and truncating it at the '?' —
 * which every URL-handling instinct wants to do — yields an id Shopify accepts
 * syntactically and then cannot resolve, so overage silently never bills. The
 * checks below assert it survives whole all the way into the mutation.
 */
const USAGE_LINE_ITEM_ID = 'gid://shopify/AppSubscriptionLineItem/22?v=1&index=1';

/**
 * Twelve pre-minted workspaces, shaped exactly like the operator's seed —
 * including `provider` and `country`, the two fields that decide whether a
 * merchant's caller ID can actually ring their shoppers.
 *
 * THE MIX IS THE FIXTURE. Both carriers appear because Twilio and Plivo are both
 * first class and neither is the app's assumption; three countries appear so a
 * preference can be met, missed, and out-stocked in the same run; and `ws-12`
 * carries NO provider and NO country, because that is exactly what every entry
 * an operator seeded before these fields existed looks like. An unlabelled entry
 * must still lease — it is a real, working number — and must never be read as
 * Indian, since assuming +91 in the absence of information is the whole defect
 * this suite now guards.
 */
const POOL = [
  { ref: 'ws-01', numberE164: '+919876500001', provider: 'plivo', country: 'IN' },
  { ref: 'ws-02', numberE164: '+919876500002', provider: 'plivo', country: 'IN' },
  { ref: 'ws-03', numberE164: '+919876500003', provider: 'plivo', country: 'IN' },
  { ref: 'ws-04', numberE164: '+919876500004', provider: 'exotel', country: 'IN' },
  { ref: 'ws-05', numberE164: '+14155550005', provider: 'twilio', country: 'US' },
  { ref: 'ws-06', numberE164: '+14155550006', provider: 'twilio', country: 'US' },
  { ref: 'ws-07', numberE164: '+14155550007', provider: 'plivo', country: 'US' },
  { ref: 'ws-08', numberE164: '+16475550008', provider: 'twilio', country: 'CA' },
  { ref: 'ws-09', numberE164: '+16475550009', provider: 'twilio', country: 'CA' },
  { ref: 'ws-10', numberE164: '+442055550010', provider: 'twilio', country: 'GB' },
  { ref: 'ws-11', numberE164: '+61255550011', provider: 'vonage', country: 'AU' },
  { ref: 'ws-12', numberE164: '+919876500012' }, // seeded before the labels existed
].map((entry) => ({
  apiKey: `vai_live_pooltest_${entry.ref.slice(-2)}`,
  numberId: `num_${entry.ref.slice(-2)}`,
  ...entry,
}));

/**
 * ref → the country of the number behind it, for asserting WHICH entry a lease
 * picked. store.js keeps the labels in memory and deliberately never writes them
 * into store.json, so the test has to hold its own copy of the seed's join.
 * Entries registered mid-run (see registerFixtureEntries) add themselves here.
 */
const refCountry = new Map(POOL.map((e) => [e.ref, e.country || null]));
const countryOfRef = (ref) => (ref && refCountry.has(ref) ? refCountry.get(ref) : null);

/**
 * What Shopify reports as each shop's own country, keyed by shop domain.
 *
 * Absent means "Shopify did not tell us", which is the honest default for the
 * fixture shops in (a)–(f): they must keep exercising today's uncountried
 * first-fit lease, not silently acquire a preference and reorder the pool under
 * the assertions that came before this feature existed.
 */
const shopCountries = new Map();

// ── Assertions ───────────────────────────────────────────────────────────────
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Poll a predicate until true or timeout (handlers and timers run async). */
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal JSON request helper against the app under test. */
function request(method, pathname, { token, body } = {}) {
  const u = new URL(HOST + pathname);
  const raw = body === undefined ? null : JSON.stringify(body);
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (raw !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(raw);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not JSON — `text` is still on the result */
          }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', reject);
    if (raw !== null) req.write(raw);
    req.end();
  });
}

// ── Subscription fixtures ────────────────────────────────────────────────────

/**
 * What `shopify.billing.check` returns for a shop, keyed by shop domain.
 *
 * The fixture OBJECTS are built once per shop and mutated in place rather than
 * rebuilt, because `currentPeriodEnd` anchors the usage window: handing back a
 * subscription with a later period end makes rollIfNeeded() roll, which zeroes
 * usedMinutes. Rebuilding a fixture between two assertions would therefore wipe
 * the very minutes the second assertion is about.
 *
 * @type {Map<string, object[]>}
 */
const subscriptions = new Map();

function setSubscriptions(shop, subs) {
  subscriptions.set(shop, subs);
}

/**
 * A paid AppSubscription in the shape check() returns: a recurring line item
 * plus the capped USAGE line item, which is the one billing.js has to identify
 * by its `balanceUsed` field (the library's own fragment never asks for
 * __typename, so a __typename-only test would match nothing).
 */
function paidSubscription(name, { status = 'ACTIVE', capUsd = 200, balanceUsedUsd = 0 } = {}) {
  return {
    id: 'gid://shopify/AppSubscription/11',
    name,
    status,
    test: false,
    trialDays: 7,
    createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    currentPeriodEnd: new Date(Date.now() + 28 * 86400000).toISOString(),
    lineItems: [
      {
        id: 'gid://shopify/AppSubscriptionLineItem/21?v=1&index=0',
        plan: {
          pricingDetails: {
            price: { amount: 39, currencyCode: 'USD' },
            interval: 'EVERY_30_DAYS',
          },
        },
      },
      {
        id: USAGE_LINE_ITEM_ID,
        plan: {
          pricingDetails: {
            balanceUsed: { amount: balanceUsedUsd, currencyCode: 'USD' },
            cappedAmount: { amount: capUsd, currencyCode: 'USD' },
            terms: 'usage terms',
          },
        },
      },
    ],
  };
}

// ── Admin GraphQL and partner-plane interception ─────────────────────────────

/** Every appUsageRecordCreate the app sent, in order. THE money assertion. */
const usageRecords = [];

/**
 * Every request the app sent to the Telenow PARTNER plane (`/api/partner/v1/…`),
 * in order, as `{ method, path, body }`. THE spend-ceiling assertion.
 *
 * Faked here rather than in test/mock-telenow.mjs on purpose. The point of
 * section (h) is what src/telenow.js actually PUTS ON THE WIRE — a cap of 0 is
 * omitted from a create body rather than sent, so "the app asked for a ceiling"
 * and "the app asked for nothing and inherited the partner's whole budget" are
 * distinguishable only by reading the serialised body. Recording it at the fetch
 * boundary means the real partner client, its real omit-at-zero rule and the
 * real provisioning caller are all under test; only the server is imaginary.
 */
const partnerRequests = [];

/** The partner requests of one method whose path ends in `suffix`. */
const partnerCalls = (method, suffix) =>
  partnerRequests.filter((r) => r.method === method && r.path.endsWith(suffix));

function installFetchStubs() {
  const realFetch = globalThis.fetch.bind(globalThis);
  const jsonAt = (status, payload) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  const json = (payload) => jsonAt(200, payload);

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url || '');
    const method = String(init?.method || 'GET').toUpperCase();
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      /* a relative or malformed url is not one of ours — fall through */
    }

    // ── The Telenow partner plane ────────────────────────────────────────────
    // It lives on the same origin as the mock Telenow (TELENOW_API_BASE), so it
    // is matched on the path, not the host: `/api/partner/v1`, which is where
    // src/telenow.js mounts it — NOT `/api/v1/partner`.
    if (parsed && parsed.pathname.startsWith('/api/partner/v1')) {
      let body = null;
      try {
        body = init?.body ? JSON.parse(init.body) : null;
      } catch {
        // Kept as the raw string: an unparseable body is itself a failure, and
        // the assertions below read `body?.monthlySpendCapUsd` off it as
        // undefined, which is exactly the "no ceiling was asked for" verdict.
        body = String(init?.body || '');
      }
      partnerRequests.push({ method, path: parsed.pathname, body });

      if (method === 'POST' && parsed.pathname.endsWith('/workspaces')) {
        // A 201, the ordinary create outcome. `monthlySpendCapUsd` is echoed
        // back exactly as asked rather than clamped, so a wrong number in the
        // request cannot be laundered into a right one by the fake server.
        return jsonAt(201, {
          workspaceId: PARTNER_WORKSPACE_ID,
          orgId: 'org-test-partner',
          externalId: body?.externalId ?? null,
          apiKey: PARTNER_MINTED_KEY,
          plan: body?.plan ?? null,
          monthlySpendCapUsd: body?.monthlySpendCapUsd ?? null,
          spendCapClamped: false,
          status: 'active',
          number: { id: 'num-partner-1', e164: '+14155559900', country: 'US', provider: 'twilio' },
        });
      }

      // PATCH /workspaces/{id} — the ceiling correction on a plan change.
      return jsonAt(200, {
        success: true,
        workspaceId: decodeURIComponent(parsed.pathname.split('/').pop() || ''),
        orgId: 'org-test-partner',
        plan: body?.plan ?? null,
        monthlySpendCapUsd: body?.monthlySpendCapUsd ?? null,
        spendCapClamped: false,
        status: 'active',
      });
    }

    // Beyond that, only the Shopify Admin API is faked. The mock Telenow server
    // is a real socket on localhost and must keep going through the real fetch,
    // or this harness stops testing the Telenow client at all.
    if (!/^https:\/\/[^/]+\.myshopify\.com\/admin\/api\//.test(url)) {
      return realFetch(input, init);
    }

    let body = {};
    try {
      body = JSON.parse(init?.body || '{}');
    } catch {
      /* fall through with {} — an unparseable body is itself a failure below */
    }
    const query = String(body.query || '');
    const shop = new URL(url).hostname;

    if (query.includes('appUsageRecordCreate')) {
      usageRecords.push({ shop, variables: body.variables || {} });
      return json({
        data: {
          appUsageRecordCreate: {
            userErrors: [],
            appUsageRecord: {
              id: `gid://shopify/AppUsageRecord/${usageRecords.length}`,
              price: body.variables?.price || null,
            },
          },
        },
      });
    }

    // The shop's own country, which is what makes the lease pick a caller ID the
    // merchant's shoppers can actually receive a call from. Unknown shops answer
    // with a null billingAddress rather than a guess — a wrong country is worse
    // than no country, because "none" degrades to first-fit while a wrong one
    // steers the merchant onto the wrong continent and looks deliberate.
    if (query.includes('countryCodeV2')) {
      const iso = shopCountries.get(shop) || null;
      return json({ data: { shop: { billingAddress: iso ? { countryCodeV2: iso } : null } } });
    }

    if (query.includes('partnerDevelopment')) {
      return json({ data: { shop: { plan: { partnerDevelopment: true } } } });
    }

    return json({ data: {} });
  };
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenow-shopify-billing-'));
  const mock = await startMockTelenow();

  // Env MUST be set before importing any app module: store.js loads the DB at
  // import time and server.js reads HOST/PORT/TELENOW_KEY_POOL at module scope.
  process.env.DATA_DIR = dataDir;
  process.env.TELENOW_API_BASE = mock.base;
  process.env.HOST = HOST;
  process.env.PORT = String(TEST_PORT);
  process.env.SHOPIFY_API_KEY = 'test-api-key';
  process.env.SHOPIFY_API_SECRET = SHOPIFY_API_SECRET;
  process.env.DEFAULT_PHONE_COUNTRY = 'IN';
  process.env.TELENOW_KEY_POOL = JSON.stringify(POOL);
  // The v1.1 partner branch must stay inert: v1 leases from the pool for every
  // shop, reviewer and paying merchant alike.
  delete process.env.TELENOW_PARTNER_KEY;

  installFetchStubs();

  // Capture the http.Server server.js creates so we can close it afterwards.
  const origListen = http.Server.prototype.listen;
  let appServer = null;
  http.Server.prototype.listen = function patched(...args) {
    appServer = this;
    return origListen.apply(this, args);
  };

  const store = await import('../src/store.js');
  const settingsMod = await import('../src/settings.js');
  const sessionMod = await import('../src/session.js');
  const plans = await import('../src/plans.js');
  const usage = await import('../src/usage.js');
  const billing = await import('../src/billing.js');
  const provisioning = await import('../src/provisioning.js');
  const templates = await import('../src/templates.js');
  const { placeCall } = await import('../src/automations/_base.js');
  const { shopify } = await import('../src/shopify.js');
  await import('../src/server.js'); // starts the real app on TEST_PORT
  http.Server.prototype.listen = origListen;

  // The one call whose answer only Shopify's servers can produce.
  shopify.billing.check = async ({ session }) => {
    const subs = subscriptions.get(session?.shop) || [];
    return {
      hasActivePayment: subs.some((s) => s.status === 'ACTIVE'),
      oneTimePurchases: [],
      appSubscriptions: subs,
    };
  };

  await waitFor(() => appServer && appServer.listening, { timeoutMs: 5000 });

  /** Install a shop the way OAuth would, bypassing OAuth. */
  function install(shop) {
    store.saveShop(shop, {
      accessToken: 'shpat_test_token',
      scope: 'read_orders,write_orders,read_customers',
      sessionId: `offline_${shop}`,
    });
    store.saveHook(shop, { id: `hook_${shop}`, secret: `whsec_${shop}` });
    setSubscriptions(shop, []);
  }

  /**
   * Give every installed shop a DISTINCT webhook secret.
   *
   * The Telenow receiver authenticates a delivery by trying each installed
   * shop's stored secret until one verifies, so two shops sharing a secret would
   * let a delivery be attributed to whichever came first — and a usage
   * assertion would then be metering the wrong shop. ensureWorkspace() calls
   * ensureTelenowHook(), which can overwrite a secret with the mock's shared
   * one, so this is re-pinned immediately before any webhook is fired.
   */
  function pinHookSecrets() {
    for (const { shop } of store.listShops()) {
      store.saveHook(shop, { id: `hook_${shop}`, secret: `whsec_${shop}` });
    }
  }

  const token = (shop) => sessionMod.mintSessionToken(shop);
  const testCall = (shop) =>
    request('POST', '/api/test-call', {
      token: token(shop),
      body: { agentId: 'agent-uuid-test', mobileNumber: TEST_NUMBER },
    });

  try {
    // ═══ a) No subscription → Starter ════════════════════════════════════════
    install(SHOP_STARTER);
    const starterEnt = await billing.refreshEntitlement(SHOP_STARTER);

    check('starter: no subscription maps to the free Starter plan',
      starterEnt.plan === 'starter' && starterEnt.status === 'NONE',
      `plan=${starterEnt.plan} status=${starterEnt.status}`);
    check('starter: Starter is an ACTIVE entitlement, not a locked app',
      starterEnt.active === true);
    check('starter: reads are allowed',
      (await billing.checkAccess(SHOP_STARTER, 'read')).ok === true);

    const settingsRead = await request('GET', '/api/settings', { token: token(SHOP_STARTER) });
    check('starter: GET /api/settings → 200', settingsRead.status === 200,
      `status=${settingsRead.status}`);

    const spendBefore = await testCall(SHOP_STARTER);
    check('starter: POST /api/test-call inside the free allowance → 200',
      spendBefore.status === 200,
      `status=${spendBefore.status} body=${spendBefore.text.slice(0, 160)}`);
    check('starter: a workspace was leased server-side (no merchant key anywhere)',
      Boolean(settingsMod.getSettings(SHOP_STARTER).telenowApiKey) &&
        settingsMod.getSettings(SHOP_STARTER).telenowKeySource === 'pool',
      `source=${settingsMod.getSettings(SHOP_STARTER).telenowKeySource}`);
    check('starter: the leased key is never sent to the browser in the clear',
      !String(settingsRead.text).includes('vai_live_pooltest'));

    // Burn the whole free allowance through the real ledger.
    const starterIncluded = plans.PLANS.starter.includedMinutes;
    for (let i = 0; i < starterIncluded; i += 1) {
      usage.addMinutes(SHOP_STARTER, `starter-seed-${i}`, 60, starterEnt);
    }
    check(`starter: ledger records the ${starterIncluded} free minutes`,
      usage.usedMinutes(SHOP_STARTER) === starterIncluded,
      `used=${usage.usedMinutes(SHOP_STARTER)}`);

    const spendAfter = await testCall(SHOP_STARTER);
    check('starter: spending past the free allowance → 402',
      spendAfter.status === 402, `status=${spendAfter.status}`);
    check('starter: the block is minutes_exhausted with a choose_plan action',
      spendAfter.json?.error === 'minutes_exhausted' && spendAfter.json?.action === 'choose_plan',
      `error=${spendAfter.json?.error} action=${spendAfter.json?.action}`);
    check('starter: an exhausted free tier still reads (no data lockout)',
      (await request('GET', '/api/settings', { token: token(SHOP_STARTER) })).status === 200);
    check('starter: no Starter shop is ever billed through Shopify',
      usageRecords.filter((r) => r.shop === SHOP_STARTER).length === 0,
      `records=${usageRecords.filter((r) => r.shop === SHOP_STARTER).length}`);

    // ═══ b) ACTIVE Growth → overage bills exactly once per session ════════════
    install(SHOP_GROWTH);
    const growthSub = paidSubscription('Telenow Growth');
    setSubscriptions(SHOP_GROWTH, [growthSub]);
    const growthEnt = await billing.refreshEntitlement(SHOP_GROWTH);

    check('growth: ACTIVE Telenow Growth maps to the growth plan',
      growthEnt.plan === 'growth' && growthEnt.status === 'ACTIVE',
      `plan=${growthEnt.plan} status=${growthEnt.status}`);
    check('growth: the usage line item gid is kept WHOLE, query string intact',
      growthEnt.usageLineItemId === USAGE_LINE_ITEM_ID,
      `id=${growthEnt.usageLineItemId}`);
    check('growth: the merchant-approved cap is read back from Shopify',
      growthEnt.capUsd === 200, `capUsd=${growthEnt.capUsd}`);

    const growthSpend = await testCall(SHOP_GROWTH);
    check('growth: POST /api/test-call → 200', growthSpend.status === 200,
      `status=${growthSpend.status} body=${growthSpend.text.slice(0, 160)}`);

    // Fill the included allowance exactly, so the next call is the first minute
    // of overage — the boundary the billing rule is written about.
    const growthIncluded = plans.PLANS.growth.includedMinutes;
    for (let i = 0; i < growthIncluded; i += 1) {
      usage.addMinutes(SHOP_GROWTH, `growth-seed-${i}`, 60, growthEnt);
    }
    check(`growth: ledger sits exactly on the ${growthIncluded}-minute allowance`,
      usage.usedMinutes(SHOP_GROWTH) === growthIncluded,
      `used=${usage.usedMinutes(SHOP_GROWTH)}`);
    check('growth: nothing was reported to Shopify inside the allowance',
      usageRecords.filter((r) => r.shop === SHOP_GROWTH).length === 0);

    pinHookSecrets();
    const overageSession = 'sess-overage-1';
    const endedBody = {
      event_type: 'call.ended',
      session_id: overageSession,
      status: 'completed',
      duration: 120, // two whole minutes, both past the allowance
    };

    const firstDelivery = await mock.fireResultWebhook(`${HOST}/telenow/webhook`, {
      eventType: 'call.ended',
      secret: `whsec_${SHOP_GROWTH}`,
      bodyOverride: endedBody,
    });
    check('growth: call.ended webhook accepted', firstDelivery.status === 200,
      `status=${firstDelivery.status}`);

    await waitFor(() => usageRecords.filter((r) => r.shop === SHOP_GROWTH).length >= 1);
    const growthRecords = () => usageRecords.filter((r) => r.shop === SHOP_GROWTH);
    check('growth: the first overage minutes produced a usage record',
      growthRecords().length === 1, `records=${growthRecords().length}`);
    check('growth: the usage record carries the per-session idempotency key',
      growthRecords()[0]?.variables?.idempotencyKey === `tn-usage-${overageSession}`,
      `key=${growthRecords()[0]?.variables?.idempotencyKey}`);
    check('growth: the mutation sends the UNTRUNCATED line item gid',
      growthRecords()[0]?.variables?.subscriptionLineItemId === USAGE_LINE_ITEM_ID,
      `id=${growthRecords()[0]?.variables?.subscriptionLineItemId}`);
    check('growth: 2 overage minutes are priced at 2 × $0.12',
      Number(growthRecords()[0]?.variables?.price?.amount) === 0.24,
      `amount=${growthRecords()[0]?.variables?.price?.amount}`);

    // Redelivery. Telenow retries, Shopify retries, everything retries; a second
    // delivery of the same session must not become a second charge.
    const redelivery = await mock.fireResultWebhook(`${HOST}/telenow/webhook`, {
      eventType: 'call.ended',
      secret: `whsec_${SHOP_GROWTH}`,
      bodyOverride: endedBody,
    });
    check('growth: redelivered call.ended webhook also ACKed', redelivery.status === 200,
      `status=${redelivery.status}`);
    await sleep(400);
    check('growth: a redelivered session does NOT bill a second time',
      growthRecords().length === 1, `records=${growthRecords().length}`);
    check('growth: the redelivered minutes were not double-counted either',
      usage.usedMinutes(SHOP_GROWTH) === growthIncluded + 2,
      `used=${usage.usedMinutes(SHOP_GROWTH)}`);

    // ═══ c) FROZEN → reads live, spend blocked ═══════════════════════════════
    growthSub.status = 'FROZEN';
    const frozenEnt = await billing.refreshEntitlement(SHOP_GROWTH);
    check('frozen: the entitlement reports FROZEN', frozenEnt.status === 'FROZEN',
      `status=${frozenEnt.status}`);
    check('frozen: FROZEN is the one state that is not active',
      frozenEnt.active === false);
    check('frozen: reads are still allowed at the gate',
      (await billing.checkAccess(SHOP_GROWTH, 'read')).ok === true);

    const frozenRead = await request('GET', '/api/settings', { token: token(SHOP_GROWTH) });
    check('frozen: GET /api/settings → 200 (no data lockout over a card decline)',
      frozenRead.status === 200, `status=${frozenRead.status}`);
    const frozenAgents = await request('GET', '/api/agents', { token: token(SHOP_GROWTH) });
    check('frozen: a read route through the gate is not paywalled',
      frozenAgents.status !== 402, `status=${frozenAgents.status}`);

    const frozenSpend = await testCall(SHOP_GROWTH);
    check('frozen: spending → 402', frozenSpend.status === 402, `status=${frozenSpend.status}`);
    check('frozen: the block is billing_frozen with a fix_payment action',
      frozenSpend.json?.error === 'billing_frozen' && frozenSpend.json?.action === 'fix_payment',
      `error=${frozenSpend.json?.error} action=${frozenSpend.json?.action}`);

    // ═══ d) A second automation on Starter → plan_limit ══════════════════════
    // POST /api/settings can arm recurring spend without ever constructing a
    // Telenow client, so the route gate is structurally blind to it — this is
    // the assertion that the separate check in front of updateSettings exists.
    install(SHOP_LIMIT);
    await billing.refreshEntitlement(SHOP_LIMIT);
    check('plan limit: Starter allows exactly one active automation',
      plans.PLANS.starter.maxActiveAutomations === 1);

    const firstAutomation = await request('POST', '/api/settings', {
      token: token(SHOP_LIMIT),
      body: { automations: { leadCallback: { enabled: true, agentId: 'agent-uuid-test' } } },
    });
    check('plan limit: the first automation saves → 200', firstAutomation.status === 200,
      `status=${firstAutomation.status} body=${firstAutomation.text.slice(0, 160)}`);

    const secondAutomation = await request('POST', '/api/settings', {
      token: token(SHOP_LIMIT),
      body: { automations: { orderConfirmation: { enabled: true, agentId: 'agent-uuid-test' } } },
    });
    check('plan limit: enabling a second automation on Starter → 402',
      secondAutomation.status === 402, `status=${secondAutomation.status}`);
    check('plan limit: the block is plan_limit with a choose_plan action',
      secondAutomation.json?.error === 'plan_limit' &&
        secondAutomation.json?.action === 'choose_plan',
      `error=${secondAutomation.json?.error} action=${secondAutomation.json?.action}`);
    check('plan limit: the refused automation was NOT persisted',
      settingsMod.getAutomation(SHOP_LIMIT, 'orderConfirmation').enabled === false);

    // ═══ e) REGRESSION: cancelled during a delayed placeCall ═════════════════
    install(SHOP_DEFERRED);
    const deferredSub = paidSubscription('Telenow Growth');
    setSubscriptions(SHOP_DEFERRED, [deferredSub]);
    const deferredEnt = await billing.refreshEntitlement(SHOP_DEFERRED);

    settingsMod.updateSettings(SHOP_DEFERRED, {
      automations: {
        leadCallback: { enabled: true, agentId: 'agent-uuid-test', delaySeconds: 1 },
      },
    });

    // Thirty minutes of usage: comfortably inside Growth's 300, and comfortably
    // past Starter's 25. That is what makes the cancellation below bite — a
    // merchant who cancels mid-delay drops to Starter with their allowance
    // already spent, which is precisely the shop that must not be charged for a
    // call that fires afterwards.
    for (let i = 0; i < 30; i += 1) {
      usage.addMinutes(SHOP_DEFERRED, `deferred-seed-${i}`, 60, deferredEnt);
    }

    // POSITIVE CONTROL. Without this, "no call was placed" would also pass if
    // the delay never fired, the phone number were rejected, or the mock were
    // unreachable — the test would be green for the wrong reason.
    const beforeControl = mock.initiateCalls.length;
    const controlScheduled = await placeCall({
      shop: SHOP_DEFERRED,
      automation: 'leadCallback',
      entity: { phone: TEST_NUMBER },
      variables: {},
      identifier: 'deferred-control',
      phoneOverride: TEST_NUMBER,
    });
    check('deferred control: the call was scheduled, not placed immediately',
      controlScheduled.placed === false && /scheduled/.test(controlScheduled.reason || ''),
      `reason=${controlScheduled.reason}`);
    const controlFired = await waitFor(
      () => mock.initiateCalls.length > beforeControl,
      { timeoutMs: 4000 },
    );
    check('deferred control: an entitled shop DOES place the delayed call',
      controlFired, `calls=${mock.initiateCalls.length - beforeControl}`);

    // THE REGRESSION ITSELF.
    const beforeRegression = mock.initiateCalls.length;
    const regressionScheduled = await placeCall({
      shop: SHOP_DEFERRED,
      automation: 'leadCallback',
      entity: { phone: TEST_NUMBER },
      variables: {},
      identifier: 'deferred-regression',
      phoneOverride: TEST_NUMBER,
    });
    check('deferred regression: the call was scheduled',
      regressionScheduled.placed === false,
      `reason=${regressionScheduled.reason}`);

    // The subscription is cancelled while the timer is pending. Shopify stops
    // reporting it, exactly as app_subscriptions/update would drive through
    // refreshEntitlement.
    setSubscriptions(SHOP_DEFERRED, []);
    const cancelledEnt = await billing.refreshEntitlement(SHOP_DEFERRED);
    check('deferred regression: cancelling drops the shop to Starter',
      cancelledEnt.plan === 'starter', `plan=${cancelledEnt.plan}`);
    check('deferred regression: with the free allowance already spent, spend is blocked',
      (await billing.checkAccess(SHOP_DEFERRED, 'spend')).body?.error === 'minutes_exhausted',
      `error=${(await billing.checkAccess(SHOP_DEFERRED, 'spend')).body?.error}`);

    await sleep(2000);
    check('deferred regression: a subscription cancelled during the delay does NOT fire the call',
      mock.initiateCalls.length === beforeRegression,
      `unexpected calls=${mock.initiateCalls.length - beforeRegression}`);

    // The skip must RELEASE the dedupe mark, or the automation is dead for that
    // entity for the next 24h even after the merchant resubscribes.
    setSubscriptions(SHOP_DEFERRED, [deferredSub]);
    await billing.refreshEntitlement(SHOP_DEFERRED);
    const beforeRetry = mock.initiateCalls.length;
    await placeCall({
      shop: SHOP_DEFERRED,
      automation: 'leadCallback',
      entity: { phone: TEST_NUMBER },
      variables: {},
      identifier: 'deferred-regression',
      phoneOverride: TEST_NUMBER,
    });
    const retryFired = await waitFor(
      () => mock.initiateCalls.length > beforeRetry,
      { timeoutMs: 4000 },
    );
    check('deferred regression: the billing skip released the dedupe mark for a genuine retry',
      retryFired, `calls=${mock.initiateCalls.length - beforeRetry}`);

    // ═══ g) the lease prefers the shop's country, and is never blocked by it ═
    //
    // Runs before (f), which drains the pool to exhaustion and would leave these
    // three checks with nothing to choose between.

    /**
     * Add workspaces mid-run, the way an operator appending to the seed does.
     *
     * The country checks must not depend on how many entries the earlier
     * sections happened to consume — that count is an implementation detail of
     * billing tests, and tying geography assertions to it would make them fail
     * for reasons that have nothing to do with geography. Registering the exact
     * stock each check needs is deterministic instead. Newly registered refs are
     * appended, so the country-match pass has to SKIP earlier free entries to
     * reach them, which is precisely the behaviour under test.
     */
    function registerFixtureEntries(entries) {
      for (const e of entries) refCountry.set(e.ref, e.country || null);
      store.registerPoolEntries(entries);
    }

    registerFixtureEntries([
      { ref: 'ws-us-a', apiKey: 'vai_live_pooltest_us_a', numberE164: '+14155551111', numberId: 'num_us_a', provider: 'twilio', country: 'US' },
      { ref: 'ws-us-b', apiKey: 'vai_live_pooltest_us_b', numberE164: '+14155552222', numberId: 'num_us_b', provider: 'plivo', country: 'US' },
      { ref: 'ws-nz-a', apiKey: 'vai_live_pooltest_nz_a', numberE164: '+64955553333', numberId: 'num_nz_a', provider: 'twilio', country: 'NZ' },
    ]);

    // ── (a) a US shop is leased a US number while one is free ────────────────
    const SHOP_US = 'us-shop.myshopify.com';
    install(SHOP_US);
    shopCountries.set(SHOP_US, 'US');

    const keyUS = await provisioning.ensureWorkspace(SHOP_US);
    const refUS = settingsMod.getSettings(SHOP_US).telenowWorkspaceRef;
    check('country: the shop country is read from Shopify and cached on the settings row',
      settingsMod.getSettings(SHOP_US).shopCountry === 'US',
      `shopCountry=${settingsMod.getSettings(SHOP_US).shopCountry}`);
    check('country: a US shop is leased a US number, not merely the first free entry',
      Boolean(keyUS) && countryOfRef(refUS) === 'US',
      `ref=${refUS} country=${countryOfRef(refUS)}`);

    // ── (b) an unstocked country still gets a workspace, never a refusal ─────
    // The pool holds no DE number and never will in this run. A filter-shaped
    // implementation returns null here and the merchant's whole app answers 503
    // — strictly worse than a working call from a foreign caller ID.
    const SHOP_DE = 'de-shop.myshopify.com';
    install(SHOP_DE);
    // Pre-seeded on the settings row rather than answered by the Admin stub, so
    // the cached-country path is exercised too: it is the one that runs on every
    // lease after the first and must not re-query Shopify.
    settingsMod.updateSettings(SHOP_DE, { shopCountry: 'DE' });

    const keyDE = await provisioning.ensureWorkspace(SHOP_DE);
    const refDE = settingsMod.getSettings(SHOP_DE).telenowWorkspaceRef;
    check('country: a shop in an unstocked country is STILL leased a workspace',
      Boolean(keyDE) && Boolean(refDE), `ref=${refDE}`);
    check('country: … and it is a real entry from another country, not a DE placeholder',
      Boolean(refDE) && countryOfRef(refDE) !== 'DE',
      `ref=${refDE} country=${countryOfRef(refDE) || 'unknown'}`);

    // ── (c) the 48h same-shop reclaim outranks a country match ───────────────
    // A reinstalling merchant's data lives in the workspace they had. Moving
    // them to a better-matched number would strand it, so reclaim wins even when
    // a perfect country match is sitting free.
    const SHOP_REINSTALL = 'reinstall-shop.myshopify.com';
    install(SHOP_REINSTALL);
    shopCountries.set(SHOP_REINSTALL, 'NZ');

    const keyR1 = await provisioning.ensureWorkspace(SHOP_REINSTALL);
    const refR1 = settingsMod.getSettings(SHOP_REINSTALL).telenowWorkspaceRef;
    check('country: the reinstall fixture starts on the one NZ entry',
      Boolean(keyR1) && countryOfRef(refR1) === 'NZ',
      `ref=${refR1} country=${countryOfRef(refR1)}`);

    // Uninstall exactly as the APP_UNINSTALLED handler does: release first
    // (quarantines the entry), then deleteShop (wipes the settings row that
    // holds the ref and the cached country).
    await provisioning.releaseWorkspace(SHOP_REINSTALL);
    store.deleteShop(SHOP_REINSTALL);

    install(SHOP_REINSTALL);
    shopCountries.set(SHOP_REINSTALL, 'US');
    const freeUSAtReinstall = store.keypoolStatus().byCountry?.US || 0;
    check('country: a free US number really is available at the moment of the reinstall',
      freeUSAtReinstall > 0, `free US=${freeUSAtReinstall}`);

    const keyR2 = await provisioning.ensureWorkspace(SHOP_REINSTALL);
    const refR2 = settingsMod.getSettings(SHOP_REINSTALL).telenowWorkspaceRef;
    check('country: the 48h same-shop reclaim still beats an available country match',
      refR2 === refR1, `before=${refR1} after=${refR2} (US free=${freeUSAtReinstall})`);
    check('country: … and the merchant gets the same credential, so their data is still there',
      Boolean(keyR2) && keyR2 === keyR1);

    // ═══ f) releaseWorkspace() quarantines, never recycles ═══════════════════
    const poolBefore = provisioning.poolStatus();

    install(SHOP_Q1);
    const keyQ1 = await provisioning.ensureWorkspace(SHOP_Q1);
    const refQ1 = settingsMod.getSettings(SHOP_Q1).telenowWorkspaceRef;
    check('quarantine: a fresh shop leases a workspace from the pool',
      Boolean(keyQ1) && Boolean(refQ1), `ref=${refQ1}`);

    await provisioning.releaseWorkspace(SHOP_Q1);
    const poolAfterRelease = provisioning.poolStatus();
    check('quarantine: releasing on uninstall moves the entry to quarantined',
      poolAfterRelease.quarantined === poolBefore.quarantined + 1,
      `before=${poolBefore.quarantined} after=${poolAfterRelease.quarantined}`);
    check('quarantine: the released workspace does NOT go back to free',
      poolAfterRelease.free === poolBefore.free - 1,
      `before=${poolBefore.free} after=${poolAfterRelease.free}`);

    install(SHOP_Q2);
    const keyQ2 = await provisioning.ensureWorkspace(SHOP_Q2);
    const refQ2 = settingsMod.getSettings(SHOP_Q2).telenowWorkspaceRef;
    check('quarantine: the next shop gets a DIFFERENT workspace',
      Boolean(refQ2) && refQ2 !== refQ1, `refQ1=${refQ1} refQ2=${refQ2}`);
    check('quarantine: and a different credential with it',
      Boolean(keyQ2) && keyQ2 !== keyQ1);

    // Drain the pool. The quarantined ref must never surface again, and running
    // out has to be a null (which callers turn into 503 provisioning), not a
    // throw and not a silent reuse.
    const drainedRefs = [];
    let exhausted = false;
    for (let i = 0; i < POOL.length + 4; i += 1) {
      const shop = `drain-${i}.myshopify.com`;
      install(shop);
      // eslint-disable-next-line no-await-in-loop
      const key = await provisioning.ensureWorkspace(shop);
      if (!key) {
        exhausted = true;
        break;
      }
      drainedRefs.push(settingsMod.getSettings(shop).telenowWorkspaceRef);
    }
    check('quarantine: an exhausted pool returns null rather than throwing',
      exhausted, `leased ${drainedRefs.length} before stopping`);
    check('quarantine: the quarantined workspace was never handed to another shop',
      !drainedRefs.includes(refQ1), `refQ1=${refQ1} drained=${drainedRefs.join(',')}`);
    check('quarantine: no workspace was leased to two shops at once',
      new Set(drainedRefs).size === drainedRefs.length);

    // ═══ h) EVERY PLAN CARRIES A COST CEILING, AND IT REACHES THE WIRE ═══════
    //
    // Runs after (f) on purpose: the partner plane MINTS a workspace rather than
    // leasing one, so it is the one provisioning path that still works with the
    // pool drained to nothing.
    //
    // The distinction this whole section turns on: `capUsd` is what the MERCHANT
    // approved Shopify to charge them, and `costCeilingUsd` is what Telenow is
    // allowed to SPEND on their behalf. Sending the first as the second is the
    // shipped bug — on Starter it is 0, and a non-positive requested cap means
    // "no ceiling of my own" upstream, i.e. the partner's entire budget.

    const hasCostCeilingFor = typeof plans.costCeilingFor === 'function';
    check('ceiling: src/plans.js exports costCeilingFor()', hasCostCeilingFor);
    const costCeilingFor = hasCostCeilingFor ? plans.costCeilingFor : () => 0;

    const ceilings = Object.keys(plans.PLANS).map((handle) => [handle, costCeilingFor(handle)]);
    check('ceiling: every plan carries a non-zero cost ceiling',
      ceilings.length === 3 && ceilings.every(([, v]) => Number.isFinite(v) && v > 0),
      ceilings.map(([h, v]) => `${h}=${v}`).join(' '));
    check('ceiling: costCeilingFor() agrees with the PLANS entry it reads from',
      ceilings.every(([h, v]) => plans.PLANS[h].costCeilingUsd === v),
      ceilings.map(([h]) => `${h}=${plans.PLANS[h].costCeilingUsd}`).join(' '));

    // The frozen cross-file contract's literal numbers. Deliberately asserted by
    // VALUE rather than recomputed from round(0.45 * (priceUsd + capUsd)): a test
    // that re-derives the formula would agree with a plans.js that had the same
    // arithmetic slip, and these three numbers are what the provisioning and
    // webhook agents code against. If a founder decision moves them, this line is
    // meant to be the thing that notices.
    check('ceiling: the contract values are Starter 10 / Growth 135 / Scale 360',
      costCeilingFor('starter') === 10 && costCeilingFor('growth') === 135 &&
        costCeilingFor('scale') === 360,
      `starter=${costCeilingFor('starter')} growth=${costCeilingFor('growth')} ` +
      `scale=${costCeilingFor('scale')}`);

    // Starter's price and cap are BOTH zero, so anything derived purely from them
    // is zero — which is the exact value that reads as "uncapped" upstream. Its
    // ceiling therefore has to be a floor applied after the derivation, not the
    // derivation's output.
    check('ceiling: Starter\'s ceiling is a FLOOR, not the 0 its own price and cap imply',
      plans.PLANS.starter.priceUsd === 0 && plans.PLANS.starter.capUsd === 0 &&
        costCeilingFor('starter') > 0,
      `price=${plans.PLANS.starter.priceUsd} cap=${plans.PLANS.starter.capUsd} ` +
      `ceiling=${costCeilingFor('starter')}`);
    check('ceiling: an unknown plan handle falls back to Starter\'s floor, never to 0',
      costCeilingFor('enterprise-2027') === costCeilingFor('starter') &&
        costCeilingFor('enterprise-2027') > 0 && costCeilingFor(undefined) > 0 &&
        costCeilingFor(null) > 0 && costCeilingFor('') > 0,
      `unknown=${costCeilingFor('enterprise-2027')} undefined=${costCeilingFor(undefined)}`);
    check('ceiling: a bigger plan may spend more, so the ladder is monotonic',
      costCeilingFor('starter') < costCeilingFor('growth') &&
        costCeilingFor('growth') < costCeilingFor('scale'));

    // ── THE REGRESSION: a Starter install must not ask for a cap of zero ──────
    process.env.TELENOW_PARTNER_KEY = 'tnp_live_billing_harness';
    install(SHOP_PARTNER);
    const partnerEnt = await billing.refreshEntitlement(SHOP_PARTNER);
    check('ceiling: the partner fixture is on Starter with an approved cap of $0 — the shipped bug\'s input',
      partnerEnt.plan === 'starter' && Number(partnerEnt.capUsd || 0) === 0,
      `plan=${partnerEnt.plan} capUsd=${partnerEnt.capUsd}`);

    const partnerKey = await provisioning.ensureWorkspace(SHOP_PARTNER);
    const partnerSettings = settingsMod.getSettings(SHOP_PARTNER);
    check('ceiling: with TELENOW_PARTNER_KEY set the shop is MINTED, not leased',
      Boolean(partnerKey) && partnerSettings.telenowKeySource === 'partner' &&
        partnerSettings.telenowWorkspaceRef === PARTNER_WORKSPACE_ID,
      `source=${partnerSettings.telenowKeySource} ref=${partnerSettings.telenowWorkspaceRef}`);

    const createCalls = partnerCalls('POST', '/workspaces');
    const createBody = createCalls[0]?.body || {};
    check('ceiling: exactly one workspace was created for the fixture shop',
      createCalls.length === 1, `creates=${createCalls.length}`);
    // ★ THE ASSERTION THIS SECTION EXISTS FOR. src/telenow.js OMITS the field
    // when the caller asks for 0 or less, so a caller that still sends
    // `Number(billing.capUsd) || 0` produces a body with no monthlySpendCapUsd in
    // it at all — undefined, which fails this the same way an explicit 0 would.
    check('ceiling: the create asks for a NON-ZERO monthlySpendCapUsd on a Starter install',
      Number(createBody.monthlySpendCapUsd) > 0,
      `sent=${JSON.stringify(createBody.monthlySpendCapUsd)}`);
    check('ceiling: … and the number asked for is exactly Starter\'s cost ceiling',
      Number(createBody.monthlySpendCapUsd) === costCeilingFor('starter'),
      `sent=${createBody.monthlySpendCapUsd} expected=${costCeilingFor('starter')}`);
    check('ceiling: the create still names the plan it is provisioning',
      createBody.plan === 'starter', `plan=${createBody.plan}`);

    // ── The ceiling is RE-SENT when the plan changes ─────────────────────────
    // Without this the shop is capped at Starter's $10 forever, which is the
    // mirror-image failure: a paying Growth merchant whose calls stop connecting.
    check('ceiling: src/provisioning.js exports syncWorkspaceSpendCap()',
      typeof provisioning.syncWorkspaceSpendCap === 'function');

    /**
     * Call it and report rather than propagate. The contract says it NEVER
     * throws — it runs on webhook and boot paths where a failure must not break
     * the caller — so "did it throw" is itself one of the things under test, and
     * an escaping error must become a FAIL line, not a dead harness.
     */
    async function callSync(shop) {
      if (typeof provisioning.syncWorkspaceSpendCap !== 'function') {
        return { threw: new Error('syncWorkspaceSpendCap is not exported') };
      }
      try {
        await provisioning.syncWorkspaceSpendCap(shop);
        return { threw: null };
      } catch (err) {
        return { threw: err };
      }
    }

    setSubscriptions(SHOP_PARTNER, [paidSubscription('Telenow Growth')]);
    const upgradedEnt = await billing.refreshEntitlement(SHOP_PARTNER);
    check('ceiling: the fixture shop really did upgrade to Growth',
      upgradedEnt.plan === 'growth', `plan=${upgradedEnt.plan}`);

    const patchesBefore = partnerCalls('PATCH', PARTNER_WORKSPACE_ID).length;
    const syncUpgrade = await callSync(SHOP_PARTNER);
    const patches = partnerCalls('PATCH', PARTNER_WORKSPACE_ID);
    const patchBody = patches[patches.length - 1]?.body || {};
    check('ceiling: an upgrade RE-SENDS the ceiling to the workspace that was minted',
      !syncUpgrade.threw && patches.length === patchesBefore + 1,
      `patches=${patches.length} threw=${syncUpgrade.threw?.message || 'no'}`);
    check('ceiling: the re-sent ceiling is Growth\'s, not the Starter one from install',
      Number(patchBody.monthlySpendCapUsd) === costCeilingFor('growth') &&
        Number(patchBody.monthlySpendCapUsd) > costCeilingFor('starter'),
      `sent=${patchBody.monthlySpendCapUsd} expected=${costCeilingFor('growth')}`);
    check('ceiling: the plan handle rides along with it, so upstream agrees on both',
      patchBody.plan === 'growth', `plan=${patchBody.plan}`);

    // ── The quiet no-ops ─────────────────────────────────────────────────────
    // Both of these run on the SAME webhook path as the case above, for shops
    // that path cannot know are different in advance. A throw here would abort an
    // app_subscriptions/update handler mid-flight; a stray PATCH would aim a
    // ceiling at a workspace ref this app does not own.
    const beforePoolSync = partnerRequests.length;
    const poolSync = await callSync(SHOP_STARTER);
    check('ceiling: syncWorkspaceSpendCap is a silent no-op for a POOL-provisioned shop',
      !poolSync.threw && partnerRequests.length === beforePoolSync &&
        settingsMod.getSettings(SHOP_STARTER).telenowKeySource === 'pool',
      `requests=${partnerRequests.length - beforePoolSync} threw=${poolSync.threw?.message || 'no'}`);

    delete process.env.TELENOW_PARTNER_KEY;
    const beforeUnkeyedSync = partnerRequests.length;
    const unkeyedSync = await callSync(SHOP_PARTNER);
    check('ceiling: … and a silent no-op with TELENOW_PARTNER_KEY unset, on a partner shop',
      !unkeyedSync.threw && partnerRequests.length === beforeUnkeyedSync,
      `requests=${partnerRequests.length - beforeUnkeyedSync} threw=${unkeyedSync.threw?.message || 'no'}`);

    const strangerSync = await callSync('never-installed.myshopify.com');
    const emptySync = await callSync('');
    check('ceiling: it never throws for a shop it has never heard of, or for no shop at all',
      !strangerSync.threw && !emptySync.threw,
      `stranger=${strangerSync.threw?.message || 'no'} empty=${emptySync.threw?.message || 'no'}`);

    // ═══ i) THE MODEL STACK IS PINNED ════════════════════════════════════════
    //
    // Pure — no server, no network, no store. The app sells a minute at one
    // price and used to let the merchant choose what runs inside it, so two
    // dropdowns moved cost per minute 2.9x against $0.12 of overage revenue. The
    // fix is that `o.*` no longer wins over STACK, and this is the check that
    // stops it being reinstated in six months by someone restoring a picker.
    const tpl = templates.getTemplate('cod');
    const stackOf = (p) => ({
      llmProvider: p.llmProvider,
      llmModel: p.llmModel,
      llmConfig: p.llmConfig,
      sttProvider: p.sttProvider,
      sttConfig: p.sttConfig,
      ttsProvider: p.ttsProvider,
      ttsVoice: p.ttsVoice,
      ttsConfig: p.ttsConfig,
    });

    const shippedAgent = templates.buildAgentPayload(tpl, SHOP_GROWTH, 'Acme Store', 'conn-1');
    // Every field the wizard's provider/model/voice pickers used to write, set to
    // the expensive end of what the platform can produce — the ~$0.55/min stack
    // that loses $0.43 on a $0.12 minute.
    const overriddenAgent = templates.buildAgentPayload(tpl, SHOP_GROWTH, 'Acme Store', 'conn-1', {
      llmProvider: 'openai',
      llmModel: 'gpt-4o',
      llmConfig: { temperature: 1 },
      sttProvider: 'assemblyai',
      sttModel: 'best',
      ttsProvider: 'elevenlabs',
      ttsVoice: 'rachel',
      ttsModel: 'eleven_multilingual_v2',
    });

    check('stack: a merchant-supplied LLM provider and model are ignored',
      overriddenAgent.llmProvider === shippedAgent.llmProvider &&
        overriddenAgent.llmModel === shippedAgent.llmModel,
      `provider=${overriddenAgent.llmProvider} model=${overriddenAgent.llmModel}`);
    check('stack: a merchant-supplied STT provider and model are ignored',
      overriddenAgent.sttProvider === shippedAgent.sttProvider &&
        overriddenAgent.sttConfig?.model === shippedAgent.sttConfig?.model,
      `provider=${overriddenAgent.sttProvider} model=${overriddenAgent.sttConfig?.model}`);
    check('stack: a merchant-supplied TTS provider, voice and model are ignored',
      overriddenAgent.ttsProvider === shippedAgent.ttsProvider &&
        overriddenAgent.ttsVoice === shippedAgent.ttsVoice &&
        overriddenAgent.ttsConfig?.model === shippedAgent.ttsConfig?.model,
      `provider=${overriddenAgent.ttsProvider} voice=${overriddenAgent.ttsVoice} ` +
      `model=${overriddenAgent.ttsConfig?.model}`);
    check('stack: the WHOLE stack block is identical with and without overrides',
      JSON.stringify(stackOf(overriddenAgent)) === JSON.stringify(stackOf(shippedAgent)),
      JSON.stringify(stackOf(overriddenAgent)));

    // Pinned by value as well as by equality: without this, a change that made
    // buildAgentPayload ignore overrides AND silently move the default stack
    // would still pass every check above.
    check('stack: and it is the stack the app ships — xai / deepgram / smallest',
      shippedAgent.llmProvider === 'xai' &&
        shippedAgent.llmModel === 'grok-4-fast-non-reasoning' &&
        shippedAgent.sttProvider === 'deepgram' &&
        shippedAgent.sttConfig?.model === 'nova-3' &&
        shippedAgent.ttsProvider === 'smallest' &&
        shippedAgent.ttsVoice === 'meher' &&
        shippedAgent.ttsConfig?.model === 'lightning_v3.1_pro',
      `${shippedAgent.llmProvider}/${shippedAgent.llmModel} ${shippedAgent.sttProvider}/` +
      `${shippedAgent.sttConfig?.model} ${shippedAgent.ttsProvider}/${shippedAgent.ttsVoice}`);

    // POSITIVE CONTROL. "The overrides were ignored" also passes when overrides
    // stopped being read at all, or when this harness is calling a function that
    // no longer takes them — and the wizard genuinely does still own the agent's
    // name, its opener and its prompt. Those must keep working; only the priced
    // parts of the payload are pinned.
    const customisedAgent = templates.buildAgentPayload(tpl, SHOP_GROWTH, 'Acme Store', 'conn-1', {
      name: 'My COD agent',
      opener: 'Hello from {store_name}, quick question.',
      systemPrompt: 'You are a very specific agent for {store_name}.',
    });
    check('stack control: the merchant still owns the name, the opener and the prompt',
      customisedAgent.name === 'My COD agent' &&
        customisedAgent.telephonyConfig?.agentMsg === 'Hello from Acme Store, quick question.' &&
        customisedAgent.systemPrompt.startsWith('You are a very specific agent for Acme Store.'),
      `name=${customisedAgent.name}`);
    check('stack control: … and pinning the stack did not empty the payload out',
      Array.isArray(customisedAgent.metadata?.tools) &&
        customisedAgent.metadata.tools.length > 0 &&
        customisedAgent.sessionConfig?.maxDuration === 300,
      `tools=${customisedAgent.metadata?.tools?.length}`);

    // ═══ Leak check on the browser-facing entitlement ════════════════════════
    // pendingState is the CSRF nonce for /billing/callback. It lives on the same
    // object as the fields the UI needs, so the whitelist in entitlementForClient
    // is the only thing keeping it off the page.
    const clientEnt = billing.entitlementForClient({
      ...(await billing.getEntitlement(SHOP_GROWTH)),
      pendingState: 'super-secret-nonce',
      devStore: true,
    });
    check('client entitlement: the billing CSRF nonce never reaches the browser',
      !('pendingState' in clientEnt) && !JSON.stringify(clientEnt).includes('super-secret-nonce'));
    check('client entitlement: internal flags are stripped too',
      !('devStore' in clientEnt) && !('usageLineItemId' in clientEnt));
  } finally {
    if (appServer) await new Promise((resolve) => appServer.close(() => resolve()));
    await mock.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length ? 'FAIL' : 'PASS'}: ${results.length - failed.length}/${results.length} checks passed`,
  );
  if (failed.length) {
    console.log('Failed checks:', failed.map((f) => f.name).join('; '));
  }
  // server.js starts a sweep interval that is never unref'd, so the event loop
  // stays alive after the socket closes. Exit explicitly rather than hang.
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('billing harness crashed:', err);
  process.exit(1);
});
