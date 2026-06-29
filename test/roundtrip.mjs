// ─────────────────────────────────────────────────────────────────────────────
// test/roundtrip.mjs — local end-to-end round-trip harness for the Shopify app.
//
// Proves the FULL integration chain works locally with NO real Shopify store, NO
// real Telenow backend, and NO hosting. It drives the plugin's REAL modules:
//
//   Shopify customers/create webhook  (HMAC-signed for real, verified by the
//                                       @shopify/shopify-api library)
//        → handleLeadCallback → placeCall → TelenowClient.initiateCall
//        → MOCK Telenow records the call + returns a sessionId
//        → MOCK Telenow fires a call.analyzed result webhook (HEX HMAC, the
//          plugin's verifier accepts it)
//        → telenow webhook receiver writes back to the LEAD store
//
// The lead-callback path is used on purpose: its write-back target is the
// plugin's OWN lead store, so no real store Admin API is needed — the entire
// chain runs in-process.
//
// Run:  npm run roundtrip      (exits 0 with all PASS, non-zero on any FAIL)
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { startMockTelenow, httpPost } from './mock-telenow.mjs';

// ── Test config ────────────────────────────────────────────────────────────────
const SHOP = 'roundtrip-test.myshopify.com';
const SHOPIFY_API_SECRET = 'shpss_test_secret_roundtrip';
const TEST_PORT = 4011;
const HOST = `http://127.0.0.1:${TEST_PORT}`;
const PHONE_LOCAL = '9876543210'; // IN local → +919876543210
const EXPECTED_E164 = '+919876543210';

// Track assertions for a single PASS/FAIL summary + exit code.
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Poll a synchronous predicate until true or timeout (handlers run async). */
async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-await-in-loop
  while (Date.now() < deadline) {
    if (predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** Minimal GET helper (mock-telenow only exports httpPost). */
function httpGet(targetUrl, headers = {}) {
  const u = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  // 1) Fresh temp DATA_DIR + dummy env. MUST be set before importing any plugin
  //    module (store.js loads the DB at import time, server.js reads HOST/PORT).
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenow-shopify-rt-'));
  const mock = await startMockTelenow();

  process.env.DATA_DIR = dataDir;
  process.env.TELENOW_API_BASE = mock.base;
  process.env.HOST = HOST;
  process.env.PORT = String(TEST_PORT);
  process.env.SHOPIFY_API_KEY = 'test-api-key';
  process.env.SHOPIFY_API_SECRET = SHOPIFY_API_SECRET;
  process.env.DEFAULT_PHONE_COUNTRY = 'IN';

  // Capture the http.Server the plugin's server.js creates so we can close it.
  const origListen = http.Server.prototype.listen;
  let appServer = null;
  http.Server.prototype.listen = function patched(...args) {
    appServer = this;
    return origListen.apply(this, args);
  };

  // 2) Import the REAL plugin modules + its wired Express app (auto-listens).
  const store = await import('../src/store.js');
  const settings = await import('../src/settings.js');
  await import('../src/server.js'); // starts the real app on TEST_PORT
  http.Server.prototype.listen = origListen;

  // Wait for the app to actually be listening.
  await waitFor(() => appServer && appServer.listening, { timeoutMs: 4000 });

  try {
    // 3) Seed install + settings directly via the plugin's store/settings
    //    (bypassing OAuth entirely).
    store.saveShop(SHOP, {
      accessToken: 'shpat_test_token',
      scope: 'read_orders,write_orders,read_customers',
      sessionId: 'offline_session_test',
    });
    store.saveHook(SHOP, { id: 'hook_test', secret: mock.createdHooks[0]?.secret || 'whsec_test_123' });
    settings.updateSettings(SHOP, {
      telenowApiKey: 'vai_live_testkey_roundtrip',
      automations: {
        leadCallback: { enabled: true, agentId: 'agent-uuid-test', delayMinutes: 0 },
      },
    });
    check('seed: shop + hook + settings persisted',
      store.getShop(SHOP) && store.getHook(SHOP)?.secret === 'whsec_test_123' &&
      settings.getAutomation(SHOP, 'leadCallback').enabled);

    // 4) Simulate Shopify's customers/create webhook, signed for THIS platform so
    //    the plugin's own @shopify/shopify-api verifier passes.
    const customer = {
      id: 778899,
      first_name: 'Asha',
      last_name: 'Rao',
      email: 'asha@example.com',
      phone: PHONE_LOCAL,
      accepts_marketing: true,
      orders_count: 0,
      default_address: { city: 'Bengaluru', phone: PHONE_LOCAL },
    };
    const rawBody = JSON.stringify(customer);
    const hmac = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(rawBody, 'utf8').digest('base64');
    const webhookRes = await httpPost(`${HOST}/webhooks/shopify`, rawBody, {
      'Content-Type': 'application/json',
      'X-Shopify-Topic': 'customers/create',
      'X-Shopify-Shop-Domain': SHOP,
      'X-Shopify-Hmac-Sha256': hmac,
      'X-Shopify-API-Version': '2025-01',
      'X-Shopify-Webhook-Id': crypto.randomUUID(),
    });
    check('shopify webhook accepted (HMAC verified, 200)', webhookRes.status === 200,
      `status=${webhookRes.status}`);

    // 5) The handler runs async (process() ACKs immediately). Wait for the call.
    await waitFor(() => mock.initiateCalls.length >= 1);
    const call = mock.initiateCalls[0];
    check('mock Telenow received an initiate-call', Boolean(call));
    check('initiate-call has expected E.164 phone',
      call?.mobileNumber === EXPECTED_E164, `mobileNumber=${call?.mobileNumber}`);
    check('initiate-call identifier starts "lead:"',
      typeof call?.identifier === 'string' && call.identifier.startsWith('lead:'),
      `identifier=${call?.identifier}`);
    check('initiate-call carries the configured agentId',
      call?.agentId === 'agent-uuid-test', `agentId=${call?.agentId}`);

    // 6) A lead row was stored, in "placed" state, with a sessionId.
    await waitFor(() => {
      const ls = store.listLeads(SHOP, 10);
      return ls.length >= 1 && ls[0].status === 'placed';
    });
    const leads = store.listLeads(SHOP, 10);
    const lead = leads[0];
    check('a lead row was stored', Boolean(lead) && leads.length === 1);
    check('lead captured the phone (E.164)', lead?.phone === EXPECTED_E164, `phone=${lead?.phone}`);
    check('lead moved to status "placed"', lead?.status === 'placed', `status=${lead?.status}`);
    const sessionId = lead?.sessionId;
    check('lead has the Telenow sessionId', Boolean(sessionId), `sessionId=${sessionId}`);

    // 7) Fire the result webhook (correct HEX signature) → 200 + lead → completed.
    const goodRes = await mock.fireResultWebhook(`${HOST}/telenow/webhook`, { sessionId });
    check('result webhook (valid signature) → 200', goodRes.status === 200, `status=${goodRes.status}`);
    await waitFor(() => store.getLead(SHOP, lead.id)?.status === 'completed');
    const completed = store.getLead(SHOP, lead.id);
    check('lead updated to "completed"', completed?.status === 'completed', `status=${completed?.status}`);
    check('lead disposition is "confirmed"', completed?.disposition === 'confirmed',
      `disposition=${completed?.disposition}`);
    check('lead recorded duration from result', completed?.duration === 42, `duration=${completed?.duration}`);

    // 8) Negative test: a WRONG signature → 401 and NO further lead change.
    const before = JSON.stringify(store.getLead(SHOP, lead.id));
    const badRes = await mock.fireResultWebhook(`${HOST}/telenow/webhook`, {
      sessionId,
      signature: 'sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      bodyOverride: {
        event_type: 'call.analyzed',
        session_id: sessionId,
        status: 'completed',
        duration: 999,
        analysis: { disposition: 'cancelled', summary: 'should not be applied' },
      },
    });
    check('result webhook (wrong signature) → 401', badRes.status === 401, `status=${badRes.status}`);
    // Give any (incorrect) async write-back a chance to NOT happen.
    await new Promise((r) => setTimeout(r, 150));
    const after = JSON.stringify(store.getLead(SHOP, lead.id));
    check('lead unchanged after bad-signature webhook', before === after);

    // 10) IDOR guard: /api/leads requires a signed Bearer session token (NOT the
    //     ?shop= query). No header → 401; a freshly minted valid token → 200.
    const session = await import('../src/session.js');
    const noAuth = await httpGet(`${HOST}/api/leads?shop=${encodeURIComponent(SHOP)}`);
    check('GET /api/leads with no Authorization → 401', noAuth.status === 401,
      `status=${noAuth.status}`);
    const token = session.mintSessionToken(SHOP);
    const withAuth = await httpGet(`${HOST}/api/leads?shop=${encodeURIComponent(SHOP)}`, {
      Authorization: `Bearer ${token}`,
    });
    check('GET /api/leads with valid token → 200', withAuth.status === 200,
      `status=${withAuth.status}`);
  } finally {
    // 9) Clean up: stop both servers + remove the temp DATA_DIR.
    if (appServer) await new Promise((resolve) => appServer.close(() => resolve()));
    await mock.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? 'FAIL' : 'PASS'}: ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('Failed checks:', failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('roundtrip harness crashed:', err);
  process.exitCode = 1;
});
