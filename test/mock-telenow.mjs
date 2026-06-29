// ─────────────────────────────────────────────────────────────────────────────
// test/mock-telenow.mjs — in-process mock of the Telenow public API.
//
// Stands up a tiny Node http server that implements just enough of Telenow for
// the local round-trip harness (see test/roundtrip.mjs). NO real network, NO
// real credentials. Point the plugin at it with TELENOW_API_BASE=<base>.
//
// Endpoints:
//   GET  /api/v1/me                  → 200 org info (key validation)
//   POST /api/v1/hooks               → 201 { id, signing_secret, secret, ... }
//   GET  /api/v1/hooks               → 200 { hooks: [...] }  (so ensureTelenowHook
//                                       can reuse our hook instead of recreating)
//   DELETE /api/v1/hooks/:id         → 200 (no-op)
//   POST /api/sessions/initiate-call → 200 { success:true, data:{ sessionId, status } }
//                                       and RECORDS the request body for asserts.
//
// It also exposes fireResultWebhook() — the inbound side — which POSTs a
// `call.analyzed` result to the plugin's /telenow/webhook signed with the SAME
// signing secret the mock handed out (HEX HMAC-SHA256, matching the plugin's
// verifier).
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import http from 'node:http';

/** The signing secret the mock returns from POST /api/v1/hooks. */
export const SIGNING_SECRET = 'whsec_test_123';

/**
 * Start the mock Telenow server on an ephemeral port.
 * @returns {Promise<{
 *   base: string,
 *   port: number,
 *   initiateCalls: Array<object>,
 *   createdHooks: Array<object>,
 *   fireResultWebhook: (targetUrl: string, opts?: object) => Promise<{ status: number, body: string }>,
 *   close: () => Promise<void>,
 * }>}
 */
export async function startMockTelenow() {
  /** Every body received at POST /api/sessions/initiate-call (assert on these). */
  const initiateCalls = [];
  /** Every hook created via POST /api/v1/hooks. */
  const createdHooks = [];
  let sessionSeq = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      const url = new URL(req.url, 'http://localhost');
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      // ── Key validation ──────────────────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/v1/me') {
        return send(200, { org_id: 'org_test', org_name: 'Test Org', key_role: 'owner' });
      }

      // ── Hook subscribe ────────────────────────────────────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/v1/hooks') {
        const hook = {
          id: 'hook_test',
          target_url: body.targetUrl,
          events: body.events || ['call.ended', 'call.analyzed'],
          source: body.source,
          signing_secret: SIGNING_SECRET,
          secret: SIGNING_SECRET,
        };
        createdHooks.push(hook);
        return send(201, hook);
      }

      // ── Hook list (so ensureTelenowHook's reuse path can run) ─────────────────
      if (req.method === 'GET' && url.pathname === '/api/v1/hooks') {
        return send(200, { hooks: createdHooks, total: createdHooks.length });
      }

      // ── Hook delete (no-op) ───────────────────────────────────────────────────
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/v1/hooks/')) {
        return send(200, { ok: true });
      }

      // ── Place a call ──────────────────────────────────────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/sessions/initiate-call') {
        initiateCalls.push(body);
        sessionSeq += 1;
        return send(200, {
          success: true,
          data: { sessionId: `sess_${sessionSeq}`, status: 'queued' },
        });
      }

      return send(404, { error: 'mock: not found', path: url.pathname });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  /**
   * Fire a Telenow result webhook at the plugin, correctly signed with the
   * signing secret this mock handed out (HEX HMAC-SHA256 over the raw body).
   * @param {string} targetUrl  the plugin's /telenow/webhook absolute URL
   * @param {object} [opts]
   * @param {string} [opts.sessionId='sess_1']
   * @param {string} [opts.eventType='call.analyzed']
   * @param {object} [opts.bodyOverride]  merge/replace fields on the result body
   * @param {string} [opts.signature]     force a (possibly wrong) signature value
   * @param {string} [opts.secret=SIGNING_SECRET]  secret used to sign
   * @returns {Promise<{ status: number, body: string }>}
   */
  async function fireResultWebhook(targetUrl, opts = {}) {
    const {
      sessionId = 'sess_1',
      eventType = 'call.analyzed',
      bodyOverride,
      signature,
      secret = SIGNING_SECRET,
    } = opts;

    const payload = bodyOverride || {
      event_type: eventType,
      session_id: sessionId,
      status: 'completed',
      duration: 42,
      analysis: { disposition: 'confirmed', summary: 'Customer confirmed.' },
    };
    const rawBody = JSON.stringify(payload);
    const sig =
      signature ??
      `sha256=${crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;

    return httpPost(targetUrl, rawBody, {
      'Content-Type': 'application/json',
      'X-VoiceAI-Signature': sig,
      'X-VoiceAI-Event': eventType,
      'X-VoiceAI-Delivery': crypto.randomUUID(),
    });
  }

  return {
    base,
    port,
    initiateCalls,
    createdHooks,
    fireResultWebhook,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Minimal POST helper used to deliver the result webhook (raw string body). */
export function httpPost(targetUrl, rawBody, headers = {}) {
  const u = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(rawBody) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}
