// ─────────────────────────────────────────────────────────────────────────────
// telenow.js — thin Telenow public-API client.
//
// Every request authenticates with the merchant's API key via the
// `X-API-Key: vai_live_...` header. Construct one client per shop with that
// shop's key (see settings.js / store.js for where the key lives).
//
// API surface used by this app:
//   GET    /api/v1/me                  → validate key, get org info
//   POST   /api/sessions/initiate-call → place an outbound AI voice call
//   POST   /api/v1/hooks               → subscribe to call-result webhooks
//   GET    /api/v1/hooks?source=...    → list subscriptions
//   DELETE /api/v1/hooks/:id           → remove a subscription
//   GET    /api/v1/agents             → list agents (slim: no system prompt)
//   GET    /api/v1/calls               → list call sessions
//   GET    /api/v1/calls/:id           → one call session
//   GET    /api/v1/numbers             → list phone numbers
//
// Below the class there is a SECOND, operator-scoped surface: partner
// provisioning (`X-Partner-Key`, not `X-API-Key`), which creates and tears down
// whole workspaces under /api/partner/v1. It is live, not a stub — see the
// block comment there for the exact HTTP contract, including the two places
// where that contract is NOT what this file's earlier drafts claimed.
//
// SECURITY: never log the API key, the partner key, or any minted `vai_live_`
// key. Errors below include status + response body for debugging but
// deliberately do not echo the Authorization/X-API-Key/X-Partner-Key header.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomUUID } from 'node:crypto';

const DEFAULT_BASE = 'https://api.telenow.ai';

export class TelenowError extends Error {
  /** @param {string} message @param {number} [status] @param {any} [body] */
  constructor(message, status, body) {
    super(message);
    this.name = 'TelenowError';
    this.status = status;
    this.body = body;
  }
}

export class TelenowClient {
  /**
   * @param {string} apiKey  The merchant's `vai_live_...` key.
   * @param {object} [opts]
   * @param {string} [opts.base]  Override the API base URL.
   * @param {number} [opts.timeoutMs]  Per-request timeout (default 20s).
   */
  constructor(apiKey, opts = {}) {
    if (!apiKey) throw new TelenowError('Telenow API key is required');
    this.apiKey = apiKey;
    this.base = (opts.base || process.env.TELENOW_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  /** Internal: perform an authenticated JSON request. */
  async #request(method, path, body, extraHeaders) {
    const url = `${this.base}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'X-API-Key': this.apiKey, // ← auth; never log this value
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(extraHeaders || {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === 'AbortError') {
        throw new TelenowError(`Telenow request timed out: ${method} ${path}`);
      }
      throw new TelenowError(`Telenow request failed: ${err.message}`);
    }
    clearTimeout(timer);

    // Parse body defensively (some endpoints may return empty body on 204).
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!res.ok) {
      const msg = data?.error || data?.message || `Telenow ${method} ${path} → ${res.status}`;
      throw new TelenowError(msg, res.status, data);
    }
    return data;
  }

  /**
   * Validate the API key and return org info.
   * @returns {Promise<{ org_id: string, org_name: string, key_id: string,
   *                      key_name: string, key_role: string }>}
   */
  me() {
    return this.#request('GET', '/api/v1/me');
  }

  /**
   * Place an outbound AI voice call.
   * @param {object} args
   * @param {string} args.agentId         Telenow agent UUID.
   * @param {string} args.mobileNumber    E.164, e.g. "+919876543210".
   * @param {object} [args.variables]     Context strings interpolated by the agent.
   * @param {string} [args.identifier]    Your correlation id (Shopify order/customer id).
   * @param {'hangup'|'none'|string} [args.machineDetection='hangup']
   * @returns {Promise<{ sessionId: string, status: string, startTime?: string }>}
   */
  async initiateCall({
    agentId,
    mobileNumber,
    variables = {},
    identifier,
    machineDetection = 'hangup',
    fromNumberId,
  }) {
    if (!agentId) throw new TelenowError('initiateCall: agentId is required');
    if (!mobileNumber) throw new TelenowError('initiateCall: mobileNumber (E.164) is required');
    const body = { agentId, mobileNumber, variables, identifier };
    // 'agent' (or empty) means "use whatever the agent has configured" — the
    // field is optional upstream, so omit it rather than sending a value.
    if (machineDetection && machineDetection !== 'agent') body.machineDetection = machineDetection;
    // Caller id. Upstream rejects fromNumberId AND fromNumber together, so only
    // ever send the id; omitting it falls back to the agent's default number.
    if (fromNumberId) body.fromNumberId = fromNumberId;
    const res = await this.#request('POST', '/api/sessions/initiate-call', body);
    // Enveloped: { success, data: { sessionId, ... } }. Some failures arrive as
    // 2xx with success:false, so guard on that too.
    if (res && res.success === false) {
      throw new TelenowError(res.error || 'Telenow initiate-call failed', undefined, res);
    }
    return res?.data ?? res;
  }

  /**
   * Subscribe to call-result webhooks. Returns the created hook including the
   * signing secret used to verify inbound X-VoiceAI-Signature — persist it.
   * @param {object} args
   * @param {string} args.targetUrl   This app's public /telenow/webhook URL.
   * @param {string[]} [args.events]  Defaults to ["call.ended","call.analyzed"].
   * @param {string} [args.source='shopify']
   * @param {boolean} [args.includeTranscript=true]
   * @returns {Promise<{ id: string, signing_secret?: string, secret?: string,
   *                      events: string[], target_url: string }>}
   *   The signing secret is returned ONLY here at creation — read it as
   *   `created.signing_secret ?? created.secret` and persist it.
   */
  createHook({
    targetUrl,
    events = ['call.ended', 'call.analyzed'],
    source = 'shopify',
    includeTranscript = true,
  }) {
    if (!targetUrl) throw new TelenowError('createHook: targetUrl is required');
    return this.#request('POST', '/api/v1/hooks', {
      events,
      targetUrl,
      source,
      includeTranscript,
    });
  }

  /**
   * List webhook subscriptions, optionally filtered by source. The backend
   * returns an envelope `{ hooks: [...], total }` with snake_case hook fields
   * (`target_url`, `agent_id`, ...); we unwrap and return just the array.
   * @param {string} [source='shopify']
   * @returns {Promise<Array<{ id: string, target_url: string, events: string[], agent_id?: string }>>}
   */
  async listHooks(source = 'shopify') {
    const q = source ? `?source=${encodeURIComponent(source)}` : '';
    const res = await this.#request('GET', `/api/v1/hooks${q}`);
    return res?.hooks ?? (Array.isArray(res) ? res : []);
  }

  /** Remove a webhook subscription by id. */
  deleteHook(id) {
    if (!id) throw new TelenowError('deleteHook: id is required');
    return this.#request('DELETE', `/api/v1/hooks/${encodeURIComponent(id)}`);
  }

  // ── Read surface used by the embedded UI ──────────────────────────────────
  // Paths and shapes taken from the backend router (routes/public_api.rs).

  /**
   * List the org voice agents. The API returns a slim projection only (never
   * the system prompt), so this is safe to render inside a third-party app.
   * @param {object} [opts]
   * @param {number} [opts.limit=100]   1..200
   * @param {number} [opts.offset=0]
   * @param {boolean} [opts.isActive]   Filter by active state.
   * @returns {Promise<{ agents: Array<object>, total: number }>}
   */
  async listAgents({ limit = 100, offset = 0, isActive } = {}) {
    const q = new URLSearchParams();
    q.set("limit", String(Math.min(Math.max(Number(limit) || 100, 1), 200)));
    q.set("offset", String(Math.max(Number(offset) || 0, 0)));
    if (typeof isActive === "boolean") q.set("is_active", String(isActive));
    const res = await this.#request("GET", "/api/v1/agents?" + q.toString());
    return { agents: res?.agents ?? [], total: res?.total ?? 0 };
  }

  /**
   * List call sessions for the org, newest first by default.
   * @param {object} [opts]
   * @param {number} [opts.limit=50]    1..200
   * @param {number} [opts.offset=0]
   * @param {string} [opts.status]      Raw session status ("active" | "ended" | ...).
   * @param {string} [opts.agentId]     Restrict to one agent.
   * @param {string} [opts.sort]        newest | oldest | longest | shortest
   * @returns {Promise<{ calls: Array<object>, total: number }>}
   */
  async listCalls({ limit = 50, offset = 0, status, agentId, sort } = {}) {
    const q = new URLSearchParams();
    q.set("limit", String(Math.min(Math.max(Number(limit) || 50, 1), 200)));
    q.set("offset", String(Math.max(Number(offset) || 0, 0)));
    if (status) q.set("status", String(status));
    if (agentId) q.set("agent_id", String(agentId));
    if (sort) q.set("sort", String(sort));
    const res = await this.#request("GET", "/api/v1/calls?" + q.toString());
    return { calls: res?.calls ?? [], total: res?.total ?? 0 };
  }

  /** Fetch one call session by id (full detail). */
  getCallDetail(id) {
    if (!id) throw new TelenowError("getCallDetail: id is required");
    return this.#request("GET", "/api/v1/calls/" + encodeURIComponent(id));
  }

  /**
   * Fetch ONE agent with its full configuration (providers, prompt, session
   * config, metadata). This is the Dashboard surface (/api/agents/:id), not
   * /api/v1 — the v1 list is a slim projection that deliberately omits the
   * system prompt and provider config. Reads work with any valid key role.
   *
   * NOTE the wire casing: Dashboard RESPONSES are snake_case (llm_provider,
   * tts_voice, system_prompt) even though CREATE/UPDATE bodies are camelCase.
   * Nested config objects mix both (session_config.bargeInSensitivity but
   * stt_config.smart_format), so bind to the exact keys - do not normalise.
   * @param {string} id
   * @returns {Promise<object>} the agent object
   */
  async getAgent(id) {
    if (!id) throw new TelenowError('getAgent: id is required');
    const res = await this.#request('GET', '/api/agents/' + encodeURIComponent(id));
    // Dashboard surface wraps results in { success, data }.
    return res?.data ?? res;
  }

  /**
   * Per-agent aggregates and the latency breakdown behind the "expected
   * latency" strip: totalSessions, totalMessages, totalDuration,
   * avgSessionDuration, avgMessagesPerSession, avgSttMs, avgLlmMs, avgTtsMs,
   * avgFlowMs, avgServerMs, avgNetRttMs, latencySamples. All camelCase here.
   * @param {string} id
   * @returns {Promise<object>}
   */
  async getAgentStats(id) {
    if (!id) throw new TelenowError('getAgentStats: id is required');
    const res = await this.#request('GET', '/api/agents/' + encodeURIComponent(id) + '/stats');
    return res?.data ?? res;
  }

  /** The catalog sections that carry a per-provider rate card. */
  static #CATALOG_PRICED_SECTIONS = ['llm', 'stt', 'tts', 'telephony'];

  /**
   * Provider catalog, RAW — including the third-party rate card. Server-side
   * callers only.
   *
   * This is the input to the margin model: whether a plan's included minutes
   * are profitable depends on the fully-loaded per-minute cost of carrier +
   * STT + LLM + TTS, and these are the only figures we have for it. It exists
   * as a separate method rather than an option flag so that the pricing data
   * can never reach a browser by someone forgetting to pass `false` — the
   * public path is a different function with a different name, and a reviewer
   * (or a grep) can see at a glance which callers touch money.
   *
   * NEVER return this payload, or any field of it, from an Express route.
   * @returns {Promise<object>}
   */
  async getCatalogInternal() {
    const res = await this.#request('GET', '/api/catalog');
    return res?.data ?? res;
  }

  /**
   * Provider catalog for the embedded UI — turns raw ids into human labels.
   * Sections: llm, stt, tts, telephony (arrays of { id, name, blurb,
   * latency:{ms,tier}, configFields:[{key,label,options:[{label,value}]}] }).
   * Stable enough to cache per process.
   *
   * PRICING IS DELIBERATELY STRIPPED HERE. The upstream payload carries a
   * `perMinuteUsd` on every provider plus a `platformFee:{perMinUsd,percent}`
   * block — a third-party vendor's rate card. Shipping that into the Shopify
   * admin iframe is a requirement-1.2.1 artifact even though nothing in the UI
   * renders it: the merchant pays Shopify, and a payload describing what some
   * other company charges per minute is evidence of an off-platform commercial
   * relationship sitting one devtools tab away from the reviewer. The whole
   * point of the billing rework is that this app looks, from inside the admin,
   * like it has no vendor behind it.
   *
   * Server-side cost modelling must read the figures through
   * getCatalogInternal() instead — see the margin note in the billing spec.
   * @returns {Promise<object>}
   */
  async getCatalog() {
    const raw = await this.getCatalogInternal();
    if (!raw || typeof raw !== 'object') return raw;

    // Copy rather than delete in place. The caller holds no other reference
    // today, but an in-client catalog cache added later would otherwise be
    // poisoned for getCatalogInternal() by whichever call happened to be first.
    const out = { ...raw };
    delete out.platformFee;

    for (const section of TelenowClient.#CATALOG_PRICED_SECTIONS) {
      const list = out[section];
      if (!Array.isArray(list)) continue; // section absent or reshaped upstream
      out[section] = list.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        const copy = { ...entry };
        delete copy.perMinuteUsd;
        return copy;
      });
    }
    return out;
  }

  /**
   * Start a BROWSER call: the merchant talks to the agent through their mic
   * instead of over the phone. Returns the session id plus the WebSocket the
   * browser then streams audio over.
   *
   * Handshake (mirrors the Telenow dashboard's own widget):
   *   1. POST /api/sessions/init-web-call  -> { sessionId, websocketUrl }
   *   2. browser opens wss://<api-host>/ws/web-agent
   *   3. browser sends { event: 'start', sessionId }
   *   4. both sides exchange { event: 'media', data: <base64> }
   *
   * @param {object} opts
   * @param {string} opts.agentId
   * @param {object} [opts.variables]   {placeholder} values for the prompt.
   * @param {string} [opts.identifier]  Free-form attribution string.
   * @returns {Promise<{ sessionId: string, websocketUrl: string }>}
   */
  async initWebCall({ agentId, variables = {}, identifier }) {
    if (!agentId) throw new TelenowError('initWebCall: agentId is required');
    const res = await this.#request('POST', '/api/sessions/init-web-call', {
      agentId,
      variables,
      identifier,
    });
    // Dashboard surface: { success, data: { sessionId, websocketUrl } }. Some
    // failures arrive as 2xx with success:false, so check that explicitly.
    if (res && res.success === false) {
      throw new TelenowError(res.error || 'Telenow init-web-call failed', undefined, res);
    }
    const data = res?.data ?? res;
    return {
      sessionId: data?.sessionId || null,
      // The backend may omit websocketUrl (the dashboard derives it same-origin);
      // fall back to the API base with the ws scheme swapped in.
      websocketUrl: data?.websocketUrl || this.base.replace(/^http/, 'ws') + '/ws/web-agent',
    };
  }

  /**
   * Recording metadata: { id, session_id, mime, duration_sec, size_bytes,
   * sample_rate, channel, storage_kind, created_at }.
   *
   * Recordings live on the ORG-scoped Dashboard surface, so the org id is
   * required; an API key is pinned to its own org and any other id gives 403.
   * @param {string} orgId @param {string} recordingId
   */
  async getRecording(orgId, recordingId) {
    if (!orgId || !recordingId) throw new TelenowError('getRecording: orgId and recordingId are required');
    const res = await this.#request('GET',
      '/api/orgs/' + encodeURIComponent(orgId) + '/recordings/' + encodeURIComponent(recordingId));
    return res?.data ?? res;
  }

  /**
   * Short-lived signed URL for the audio: { url, expiresAt }. The URL points
   * straight at object storage and needs NO credential, so it can go into an
   * <audio src> - which cannot send an Authorization header anyway.
   *
   * Deliberately the /call-audio/ alias rather than /recordings/: identical
   * handler and auth, but the word "recordings" trips ad-blocker filter lists
   * and the request never leaves the browser. See docs/api-recordings.
   * @param {string} orgId @param {string} recordingId
   */
  async getRecordingUrl(orgId, recordingId) {
    if (!orgId || !recordingId) throw new TelenowError('getRecordingUrl: orgId and recordingId are required');
    const res = await this.#request('GET',
      '/api/orgs/' + encodeURIComponent(orgId) + '/call-audio/' + encodeURIComponent(recordingId) + '/signed-url');
    const d = res?.data ?? res;
    return { url: d?.url || null, expiresAt: d?.expiresAt || null };
  }

  /**
   * Every agent in the org, paging past the 200-per-request cap.
   *
   * listAgents() clamps limit to 200. An org with more agents than that would
   * silently lose the tail — and because the saved-agent list is hydrated by
   * filtering this array, a saved agent sitting past position 200 would vanish
   * from the merchant's own page with no error. So page until exhausted.
   * @param {number} [max=2000] Hard stop, so a bad `total` cannot spin forever.
   * @returns {Promise<{ agents: Array<object>, total: number, truncated: boolean }>}
   */
  async listAllAgents(max = 2000) {
    const out = [];
    let offset = 0;
    let total = 0;
    for (;;) {
      const page = await this.listAgents({ limit: 200, offset });
      total = page.total || out.length + page.agents.length;
      out.push(...page.agents);
      if (page.agents.length < 200 || out.length >= total || out.length >= max) break;
      offset += 200;
    }
    return { agents: out, total: total || out.length, truncated: out.length < total };
  }

  // ── Integration connectors ─────────────────────────────────────────────────
  // Lets this app connect the merchant's Shopify store to their Telenow
  // workspace on their behalf, using the Admin token it already holds from the
  // Shopify OAuth install — so the merchant never pastes a token into Telenow.
  // Key-authed under /api/v1; writes need an owner/admin/developer key.

  /** Connector catalog: what each provider needs to connect. */
  async listIntegrationProviders() {
    const res = await this.#request('GET', '/api/v1/integrations/providers');
    return res?.providers ?? [];
  }

  /** One provider's connect spec (credential + setting field keys). */
  getIntegrationProvider(providerId) {
    if (!providerId) throw new TelenowError('getIntegrationProvider: providerId is required');
    return this.#request('GET', '/api/v1/integrations/providers/' + encodeURIComponent(providerId));
  }

  /** Existing connections, optionally for one provider. */
  async listConnections(providerId) {
    const q = providerId ? '?providerId=' + encodeURIComponent(providerId) : '';
    const res = await this.#request('GET', '/api/v1/integrations/connections' + q);
    return res?.connections ?? [];
  }

  /**
   * Create a connection. Verifies against the vendor before answering.
   *
   * A failed verification still returns 201 with status "error" — the
   * connection exists and holds the credentials, so re-posting would only leave
   * a second broken one behind. Fix with updateConnection instead.
   *
   * The Idempotency-Key matters here: a retry with the same key and body
   * replays the original 201 rather than creating a duplicate. Honoured 24h.
   */
  createConnection({ providerId, label, credentials = {}, settings = {}, verify = true, idempotencyKey }) {
    if (!providerId) throw new TelenowError('createConnection: providerId is required');
    const headers = idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey) } : undefined;
    return this.#request('POST', '/api/v1/integrations/connections',
      { providerId, label, credentials, settings, verify }, headers);
  }

  /**
   * Rotate credentials or repoint settings. Partial: an omitted field keeps its
   * stored value, and sending the mask back means "keep the stored secret".
   */
  updateConnection(id, patch = {}) {
    if (!id) throw new TelenowError('updateConnection: id is required');
    return this.#request('PATCH', '/api/v1/integrations/connections/' + encodeURIComponent(id), patch);
  }

  /** Re-run the connector's own check. Always 200 — the answer is in `ok`. */
  testConnection(id) {
    if (!id) throw new TelenowError('testConnection: id is required');
    return this.#request('POST', '/api/v1/integrations/connections/' + encodeURIComponent(id) + '/test');
  }

  /**
   * Create an agent. Dashboard surface — writes need an owner/admin/developer key.
   *
   * Request fields are camelCase (llmProvider, systemPrompt, sessionConfig);
   * the response comes back snake_case. Returns the created agent.
   */
  async createAgent(payload) {
    if (!payload?.name) throw new TelenowError('createAgent: name is required');
    const res = await this.#request('POST', '/api/agents', payload);
    return res?.data ?? res;
  }

  /** Soft-delete an agent. */
  deleteAgent(id) {
    if (!id) throw new TelenowError('deleteAgent: id is required');
    return this.#request('DELETE', '/api/agents/' + encodeURIComponent(id));
  }

  /** Knowledge bases in the org: { id, name, description, document_count }. */
  async listKnowledgeBases(orgId) {
    if (!orgId) throw new TelenowError('listKnowledgeBases: orgId is required');
    const res = await this.#request('GET', '/api/orgs/' + encodeURIComponent(orgId) + '/knowledge-bases');
    return (res?.data ?? res)?.knowledgeBases ?? [];
  }

  /**
   * Attach a knowledge base to an agent. The kb id goes in the PATH — a body
   * with the id in it answers 405, because POST is only mounted on /:kbId.
   */
  attachKnowledgeBase(orgId, agentId, kbId) {
    if (!orgId || !agentId || !kbId) throw new TelenowError('attachKnowledgeBase: orgId, agentId and kbId are required');
    return this.#request('POST', '/api/orgs/' + encodeURIComponent(orgId)
      + '/agents/' + encodeURIComponent(agentId)
      + '/knowledge-bases/' + encodeURIComponent(kbId));
  }

  /** Create an empty knowledge base. Returns the new row (incl. its id). */
  async createKnowledgeBase(orgId, { name, description }) {
    if (!orgId || !name) throw new TelenowError('createKnowledgeBase: orgId and name are required');
    const res = await this.#request('POST', '/api/orgs/' + encodeURIComponent(orgId) + '/knowledge-bases',
      { name, description });
    return res?.data ?? res;
  }

  /**
   * Add a text document to a knowledge base. Embedding runs asynchronously
   * upstream, so a fresh document is not searchable the instant this returns.
   */
  async createKnowledgeDocument(orgId, kbId, { title, body }) {
    if (!orgId || !kbId || !title) throw new TelenowError('createKnowledgeDocument: orgId, kbId and title are required');
    const res = await this.#request('POST',
      '/api/orgs/' + encodeURIComponent(orgId) + '/knowledge-bases/' + encodeURIComponent(kbId) + '/documents',
      { title, body: body || '' });
    return res?.data ?? res;
  }

  /**
   * Synthesise a short sample of one voice. Returns raw audio bytes plus the
   * content type, NOT JSON — so it bypasses #request, which parses JSON.
   *
   * Upstream this is POST /api/providers/tts/{provider}/preview. It currently
   * demands a user JWT (the handler takes an `Authed` extractor rather than the
   * `jwt_or_api_key_auth` layer that /api/catalog uses), so an org API key gets
   * 401. That is surfaced as a typed error rather than a generic failure, so
   * the UI can explain it instead of just going quiet.
   *
   * @returns {Promise<{ bytes: Uint8Array, contentType: string }>}
   */
  async previewVoice({ provider, voice, text, config }) {
    if (!provider) throw new TelenowError('previewVoice: provider is required');
    const url = `${this.base}/api/providers/tts/${encodeURIComponent(provider)}/preview`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'X-API-Key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, config }),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new TelenowError(`Telenow voice preview failed: ${err.message}`);
    }
    clearTimeout(timer);

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let msg = `Telenow voice preview → ${res.status}`;
      try { msg = JSON.parse(detail)?.error || msg; } catch { /* keep the status */ }
      throw new TelenowError(msg, res.status, detail);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, contentType: res.headers.get('content-type') || 'audio/mpeg' };
  }

  /**
   * Bind a number to an agent so the agent answers calls to it.
   *
   * Side effect worth knowing: the update also clears is_default_outbound and
   * inbound_action on that number, so making the number the agent's outbound
   * caller id has to happen AFTER this, not before.
   *
   * Throws 409 when a team member already receives inbound on the number —
   * inbound is exclusive, and the upstream message names the fix.
   * @param {string} numberId  voice_phone_numbers.id (not the E.164)
   * @param {string} agentId
   */
  assignNumberToAgent(numberId, agentId) {
    if (!numberId || !agentId) throw new TelenowError('assignNumberToAgent: numberId and agentId are required');
    return this.#request('POST', '/api/voice/numbers/' + encodeURIComponent(numberId) + '/assign-agent',
      { agentId });
  }

  /** Release a number from whatever agent answers it. */
  unassignNumber(numberId) {
    if (!numberId) throw new TelenowError('unassignNumber: numberId is required');
    return this.#request('DELETE', '/api/voice/numbers/' + encodeURIComponent(numberId) + '/agent');
  }

  /** List the org phone numbers. */
  async listNumbers() {
    const res = await this.#request("GET", "/api/v1/numbers");
    return res?.numbers ?? (Array.isArray(res) ? res : []);
  }
}

/** Convenience factory. */
export function telenow(apiKey, opts) {
  return new TelenowClient(apiKey, opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// PARTNER PROVISIONING — the operator-scoped workspace lifecycle.
//
// WHY THIS EXISTS. The app may not ask a merchant to create a Telenow account
// or paste a `vai_live_` key — that is the off-platform signup wall the Shopify
// review flagged — so the server owns the workspace lifecycle. The class above
// is deliberately the wrong shape for it: every method there authenticates with
// ONE merchant's `vai_live_` key, whereas creating a workspace happens before
// any such key exists. src/provisioning.js still falls back to the pre-minted
// operator pool whenever anything here fails, so a bad day upstream degrades to
// v1 behaviour rather than to a broken install.
//
// AUTH FOR EVERY CALL: header `X-Partner-Key: tnp_live_…`, read from
// process.env.TELENOW_PARTNER_KEY. This is a separate credential class from
// `vai_live_`, scoped to workspace lifecycle only and never to placing a call —
// so a leaked merchant key cannot mint workspaces and a leaked partner key
// cannot dial a phone number. It is an operator secret: it never reaches the
// browser, never lands in settings, and is never logged. Neither is any minted
// `vai_live_` key: errors below carry the server's status and machine `code`,
// and log lines carry the workspace ref, which is not a credential.
//
// ── THE MOUNT POINT IS `/api/partner/v1`, NOT `/api/v1/partner` ──────────────
// Every path in this file's earlier drafts said `/api/v1/partner` and every one
// of them was wrong. main.rs nests the partner router at its own top-level
// prefix INSIDE `/api`:
//
//     .nest("/api", api)                    // api = …
//         .nest("/v1",         public_api::router(…))
//         .nest("/partner/v1", partner_provisioning::routes::router(…))
//
// i.e. the full path is `/api/partner/v1/workspaces`. It is not nested under
// `/v1` because `.nest("/v1", …)` expands to a catch-all and two overlapping
// axum nests are an insert conflict that PANICS AT STARTUP — a failure no
// `cargo check` and no unit test would have caught. Do not "tidy" these paths
// back to the shape the old comment described; that URL answers 404.
//
// ── 1) CREATE A WORKSPACE — idempotent on externalId ─────────────────────────
//   POST /api/partner/v1/workspaces      (NO Idempotency-Key — see below)
//
//   ★ THIS ROUTE TAKES NO `Idempotency-Key`, AND SENDING ONE IS A BUG. The
//     header is opt-in platform-wide and partner_app_auth.rs sets
//     `requires_idempotency: false` here on purpose: create is idempotent
//     STRUCTURALLY, on the total unique index
//     `uq_provisioned_workspaces_(partner_id, external_id)`. Sending one costs
//     two things. (a) The cache keys on SHA256(method||path||BODY) and answers
//     a same-key/different-body request with a text/plain 422 carrying no
//     `code` — and this app's create body legitimately changes between attempts
//     for one shop (plan, spend cap, countryHint, shopifySubscriptionId all
//     arrive late). (b) A replay is served from Redis WITHOUT running the
//     handler, so an uninstall → reinstall inside the 1h redacted-entry TTL
//     never reaches the restore path and the merchant loses their call history.
//     Route 5 (rotate) and route 4 (numbers) DO require the header; this one
//     must not have it.
//   { "externalId": "acme.myshopify.com",
//     "name": "Acme Store (Shopify)",
//     "plan": "growth",
//     "monthlySpendCapUsd": 220,
//     "countryHint": "IN",
//     "metadata": { "platform": "shopify",
//                   "shopifySubscriptionId": "gid://shopify/AppSubscription/123" } }
//
//   201 { success, workspaceId:"ws_<32hex>", orgId, externalId, apiKey,
//         apiKeyLastFour, plan, monthlySpendCapUsd, spendCapClamped, status,
//         number: { id, e164, country, type, provider, agentAssigned } | null,
//         numberStatus, createdAt }
//   200 …the same body plus `restored: true` — a released workspace inside its
//       retention window was UN-deleted, so the merchant keeps their call
//       history across an uninstall → reinstall. A fresh key is minted because
//       release revoked the old one.
//   409 { success:false, error:"already_exists", code:"already_exists",
//         workspaceId, orgId, externalId, apiKeyLastFour, plan,
//         monthlySpendCapUsd, status, hint }
//   422 { success:false, code:"no_numbers_available", workspaceId, orgId,
//         apiKey, apiKeyLastFour, number:null, numberStatus:"unavailable" }
//
//   ★ THE 409 DOES NOT CARRY A STORED KEY, AND THE OLD COMMENT HERE — "apiKey
//     MUST be present on the 409" — DESCRIBED AN API THAT WAS NEVER BUILT.
//     Only the SHA-256 and last four of a `vai_live_` key are stored, so there
//     is no plaintext left to hand back to anybody, ourselves included. What
//     the shipped handler does instead is MINT a fresh one on the conflict and
//     return it as `apiKey` + `apiKeyRotated:true` + `previousRevoked` —
//     gated on the partner holding `workspaces.rotate_key`, which is exactly
//     the capability the rotate route needs, so the conflict grants no power a
//     second call would not already have. A partner WITHOUT that capability
//     gets identifiers plus `hint` and no key at all.
//
//     So the client must not depend on either behaviour: provisionWorkspace()
//     below uses the minted key when it is there and OTHERWISE TRIES ROTATE
//     ITSELF (route 5). Both paths end in the same success shape, because the
//     caller — provisioning.js's tryPartnerProvision() — treats a throw as "this
//     seam is not built yet" and leases a POOL workspace instead, which strands
//     the org we just provisioned: `telenowKeySource` becomes 'pool', so our
//     DELETE is never sent, so nothing ever releases it or starts its retention
//     clock. A recovery this file does not walk is not a recovery.
//
//     ★ BUT THE SELF-ROTATE IS A LONG SHOT, NOT A SECOND GUARANTEE, AND EARLIER
//     COMMENTS HERE OVERSOLD IT. The inline mint happens exactly when the
//     partner holds `workspaces.rotate_key`; route 5 REQUIRES the same
//     capability. So the deterministic reading of "409 with no apiKey" is "this
//     partner may not mint credentials", and the follow-up rotate is refused 403
//     `capability_denied` for the same reason. The rotate is still attempted —
//     the transient sub-case is real (routes.rs swallows a rotate error inside
//     the conflict arm and falls back to identifiers) — but when it 403s the
//     client throws `already_exists_no_credential` and logs the server's `hint`,
//     so an operator sees a missing grant rather than a phantom outage. Note
//     also that rotations are capped at 3 per workspace per 24h and the inline
//     mint spends one of them.
//
//   ★ THE 422 DOES CARRY `apiKey`, and that is not an inconsistency: THIS
//     request created the org, so the key is a first mint rather than a
//     re-disclosure. The workspace is real, committed and fully usable for
//     browser calls with no number attached, so this resolves normally with
//     `number: null` — provisioning.js already persists a null number and the
//     DID is claimed later through route 4.
//
//     In practice the shipped caller rarely sees it: `claimNumber` is omitted
//     below, and an omitted `claimNumber` means "try, best effort" upstream —
//     a miss then answers 201 with `number:null` and `numberStatus:
//     "unavailable"`. Only an explicit `claimNumber: true` turns a missing DID
//     into a 422. Every partner starts at `max_numbers_per_workspace = 0`, so
//     "created without a number" is the ORDINARY outcome until an operator
//     funds the partner — which is precisely why it must not be an error here.
//
// ── 2) READ ─────────────────────────────────────────────────────────────────
//   GET /api/partner/v1/workspaces/{workspaceId}
//   GET /api/partner/v1/workspaces/by-external-id/{externalId}
//   200 { success, workspaceId, orgId, externalId, name, plan,
//         monthlySpendCapUsd, status, apiKeyLastFour, numbers:[…],
//         numberStatus, createdAt, updatedAt, releasedAt, purgeableAfter }
//   ★ NEVER an apiKey — a read that could hand back a live credential would
//     make every other property of this plane negotiable. A released row is
//     returned with its timestamps set rather than 404'd, so "uninstalled" is
//     distinguishable from "never existed".
//
// ── 3) UPDATE PLAN / SPEND CEILING — on every app_subscriptions/update ───────
//   PATCH /api/partner/v1/workspaces/{workspaceId}
//   { "plan": "scale", "monthlySpendCapUsd": 550, "status": "active" }
//   200 { success, workspaceId, orgId, plan, monthlySpendCapUsd,
//         spendCapClamped, status }
//
//   `monthlySpendCapUsd` is enforced server-side — it is the containment for
//   src/webhooks/ndr.js, which places calls from an unauthenticated public
//   endpoint, and a client-side cap there is no cap at all. A cap above the
//   partner's own ceiling is CLAMPED and still answers 200, with
//   `spendCapClamped: true`; refusing would leave the org running on its old,
//   possibly higher cap, which is the wrong failure direction for a money gate.
//
// ── 4) CLAIM AN ADDITIONAL NUMBER ───────────────────────────────────────────
//   POST /api/partner/v1/workspaces/{workspaceId}/numbers   (Idempotency-Key REQUIRED)
//   { "country": "GB", "type": "local", "provider": …, "pattern": … }
//   201 { success, id, e164, country, type, provider, status, assigned }
//   409 { code:"limit_reached", limit }
//   422 { code:"no_numbers_available", reason }
//   503 { code:"telephony_not_configured" }
//
//   ★ NO DEFAULT COUNTRY. The old JSDoc defaulted to 'IN', which is the exact
//     India-only assumption the rest of this app just removed: the caller
//     resolves the shop's own country now, and a client-side default would
//     quietly re-introduce a wrong continent's caller ID one install at a time.
//     Omitted here, `country` is required by the server and answers a readable
//     400 `invalid_country` rather than a carrier 502.
//
// ── 5) ROTATE THE MERCHANT KEY ──────────────────────────────────────────────
//   POST /api/partner/v1/workspaces/{workspaceId}/key       (Idempotency-Key REQUIRED)
//   { "revokePrevious": true }
//   200 { success, workspaceId, orgId, apiKey, apiKeyLastFour, rotatedAt,
//         previousRevoked }
//   409 { code:"workspace_released" }
//   This is the server's answer to a lost create response, and it is why the
//   409 above can afford to be identifiers-only.
//
// ── 6) RELEASE — on uninstall. SOFT: revokes keys, archives, retention clock ─
//   DELETE /api/partner/v1/workspaces/{workspaceId}
//   204 (no body) — answered whether or not it was already released
//   404 { error:"no such workspace" }   // treat as success — already gone, or
//                                       // never ours; either way nothing to do
//
// ERROR BODIES: { success:false, error:<prose>, code:<machine_snake_case>, … }.
// The generic axum errors (404 / 401 / plain 409) carry `error` but no `code`,
// so partnerError() synthesises `http_<status>` rather than leaving it
// undefined — a caller branching on `err.code` must never get `undefined` for
// a failure that did happen.
// ─────────────────────────────────────────────────────────────────────────────

/** The mount point, verified against main.rs. See the block comment above. */
const PARTNER_BASE_PATH = '/api/partner/v1';

/** Matches TelenowClient's own default; these calls sit on an install path. */
const PARTNER_TIMEOUT_MS = 20_000;

/**
 * Thrown by the partner functions for anything the server refused. Carries the
 * machine-readable `code` from the response body so callers can branch on
 * `already_exists` / `limit_reached` / `workspace_released` / … instead of
 * pattern-matching prose, plus `status` and the parsed `body`.
 *
 * NEVER carries a credential: the message is built from the server's own
 * `error` string, and no header — least of all X-Partner-Key — is ever
 * interpolated into it.
 */
export class PartnerApiError extends TelenowError {
  constructor(message, status, body, code) {
    super(message, status, body);
    this.name = 'PartnerApiError';
    this.code = code;
  }
}

/**
 * Kept exported although nothing throws it any more: the partner API shipped
 * and the four functions below speak to it for real. src/provisioning.js and
 * any operator script may still `instanceof` it, and deleting an export to
 * tidy up is how a dynamic `import()` on another release cadence breaks.
 */
export class NotImplementedError extends TelenowError {
  constructor(what) {
    super(`NotImplemented: ${what} — the Telenow partner provisioning API is not available yet. ` +
      'v1 leases workspaces from the operator key pool (see src/provisioning.js).');
    this.name = 'NotImplementedError';
    this.code = 'not_implemented';
  }
}

/** Internal: assert the operator credential exists before calling. */
function requirePartnerKey(what) {
  if (!process.env.TELENOW_PARTNER_KEY) {
    // Never echo the value, and never hint at its length or prefix.
    throw new TelenowError(`${what}: TELENOW_PARTNER_KEY is not configured`);
  }
}

/**
 * Internal: one authenticated partner request.
 *
 * The sibling of TelenowClient#request and deliberately not a method on it:
 * that class is constructed per merchant around a `vai_live_` key, and this
 * plane has no merchant and no such key. Returns the outcome rather than
 * throwing on a non-2xx, because 409 and 422 are outcomes the callers below
 * have to handle rather than failures — see partnerError() for the throw.
 *
 * @returns {Promise<{ ok: boolean, status: number, data: any }>}
 */
async function partnerFetch(what, method, path, { body, idempotencyKey } = {}) {
  const key = process.env.TELENOW_PARTNER_KEY;
  if (!key) throw new TelenowError(`${what}: TELENOW_PARTNER_KEY is not configured`);

  const base = (process.env.TELENOW_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
  const url = `${base}${PARTNER_BASE_PATH}${path}`;
  const headers = {
    'X-Partner-Key': key, // ← auth; never logged, never put in an error
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PARTNER_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      throw new TelenowError(`${what}: partner request timed out (${method} ${PARTNER_BASE_PATH}${path})`);
    }
    throw new TelenowError(`${what}: partner request failed: ${err.message}`);
  }
  clearTimeout(timer);

  // Defensive parse, exactly as #request does: DELETE answers 204 with no body
  // at all, and an upstream proxy can put HTML in front of any of these.
  const text = await res.text().catch(() => '');
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Internal: turn a refused partner response into a throwable carrying the
 * server's own machine code.
 *
 * The code falls back to `http_<status>` because the platform's generic errors
 * (`AppError::NotFound`, `Unauthorized`, plain `Conflict`) render
 * `{ success, error }` with NO `code` field — only ForbiddenCode /
 * BadRequestCode / this plane's own hand-written bodies carry one.
 */
function partnerError(what, method, path, res) {
  const data = res.data && typeof res.data === 'object' ? res.data : null;
  const code = (data?.code && String(data.code)) || `http_${res.status}`;
  const detail =
    (data?.error && String(data.error)) ||
    (typeof res.data === 'string' && res.data ? res.data.slice(0, 200) : '') ||
    `${method} ${PARTNER_BASE_PATH}${path} → ${res.status}`;
  return new PartnerApiError(`${what}: ${detail}`, res.status, res.data, code);
}

/**
 * Internal: a DETERMINISTIC Idempotency-Key, derived from values that identify
 * the operation rather than the attempt.
 *
 * ★ THE INPUT MUST COVER THE WHOLE REQUEST BODY, NOT A SUBSET OF IT. The server
 * caches on `req_hash = SHA256(method || path || body)` and answers a
 * same-key/different-body request with a text/plain 422 that carries no `code`.
 * So any field that is in the body and not in this digest is a way for two
 * genuinely different requests to collide under one key and get an error the
 * caller cannot classify. Callers below therefore hash the serialised body
 * itself, which cannot drift out of step with what is actually sent.
 *
 * ★ USED ONLY WHERE THE BODY IS STABLE AND A REPLAY IS THE SAFE OUTCOME —
 * today that is claimNumber(), which spends carrier money. It is NOT used on
 * create: create is idempotent on the server's unique index, its body moves
 * between attempts for one shop, and a replay would skip the handler and with
 * it the uninstall→reinstall restore. See provisionWorkspace().
 *
 * ★ WHAT A REPLAY DOES TO A MINTED CREDENTIAL, since it explains
 * recoverCredential(). A cached response is replayed out of Redis BEFORE the
 * partner credential is authenticated, and the reservation key is global with
 * no tenant in it — so if the stored body were verbatim, anyone who could guess
 * method + path + body + a key derived from a public shop domain would have
 * replayed a live `vai_live_…` with no X-Partner-Key at all. That hole is closed
 * on the server: the idempotency layer strips credential-shaped values and
 * credential-named fields out of every body before storing it and marks the
 * entry `credentialRedacted: true`. A replay is therefore always credential-free.
 *
 * 64 hex characters plus a short scope: inside the server's 16..255 length rule
 * and its [A-Za-z0-9_.:-] character rule.
 */
function deterministicIdempotencyKey(scope, ...parts) {
  const digest = createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
  return `${scope}-${digest}`;
}

/**
 * Internal: a FRESH Idempotency-Key, for operations where replaying the first
 * answer is the dangerous outcome. See rotatePartnerKey() for the argument.
 */
function freshIdempotencyKey(scope) {
  return `${scope}-${randomUUID()}`;
}

/** Internal: shop domains are normalised `lower(btrim(…))` on both sides. */
function normaliseExternalId(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Internal: one wire number → the shape src/provisioning.js reads.
 *
 * It persists `result.number.e164 / .id / .provider / .country` straight onto
 * the settings row, so this is the only place the upstream spelling (`type`,
 * `agentAssigned`) is allowed to matter.
 */
function normaliseNumber(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const e164 = raw.e164 ? String(raw.e164) : null;
  const id = raw.id ? String(raw.id) : null;
  if (!e164 && !id) return null;
  return {
    id,
    e164,
    country: raw.country ? String(raw.country) : null,
    provider: raw.provider ? String(raw.provider) : null,
    type: raw.type ? String(raw.type) : null,
  };
}

/** Internal: `number` on a create body, `numbers[]` on a read body. */
function pickNumber(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.number) return normaliseNumber(data.number);
  if (Array.isArray(data.numbers)) {
    for (const n of data.numbers) {
      const shaped = normaliseNumber(n);
      if (shaped) return shaped;
    }
  }
  return null;
}

/** Internal: JSON numbers only; anything else is "the server did not say". */
function numberOrNull(value) {
  return Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null;
}

/**
 * Internal: the ONE success shape provisionWorkspace() resolves with, whichever
 * of the four upstream outcomes produced it (201, 200 restored, 422 with a
 * first-mint key, or a 409 recovered by rotating). Keeping them identical is
 * what lets tryPartnerProvision() stay a straight-line function.
 */
function shapeWorkspace(data, extra = {}) {
  const number = pickNumber(data);
  return {
    workspaceId: data?.workspaceId ? String(data.workspaceId) : null,
    orgId: data?.orgId ? String(data.orgId) : null,
    externalId: data?.externalId ? String(data.externalId) : null,
    apiKey: data?.apiKey ? String(data.apiKey) : null,
    apiKeyLastFour: data?.apiKeyLastFour ? String(data.apiKeyLastFour) : null,
    plan: data?.plan ?? null,
    monthlySpendCapUsd: numberOrNull(data?.monthlySpendCapUsd),
    spendCapClamped: data?.spendCapClamped === true,
    status: data?.status ? String(data.status) : null,
    number,
    // The server says `claimed` / `live` / `unclaimed` / `unavailable`; if it
    // said nothing, report what we can actually see.
    numberStatus: data?.numberStatus ? String(data.numberStatus) : (number ? 'claimed' : 'unavailable'),
    numberReason: data?.numberReason || data?.reason || null,
    restored: false,
    recovered: false,
    ...extra,
  };
}

/**
 * Create (or recover) the Telenow workspace backing one Shopify store.
 * Idempotent on `externalId` — see contract (1) above.
 *
 * Accepts either `provisionWorkspace(externalId, opts)` or a single options
 * object carrying `externalId`. Both forms are supported on purpose:
 * src/provisioning.js calls the object form, while the seam was specified as
 * (externalId, opts), and neither caller should have to guess.
 *
 * ★ THIS FUNCTION EITHER RESOLVES WITH A USABLE `apiKey` OR THROWS. There is no
 * third outcome, because tryPartnerProvision() throws on a missing key and
 * falls back to the pool — and a fallback that happens AFTER a real org was
 * committed upstream orphans that org with no retention clock and no DELETE
 * ever sent. So the three ways the server can answer without minting a key on
 * this very request — a 409 with identifiers only, a 409 whose minted key we
 * were not entitled to, and an idempotent REPLAY whose credential the cache
 * stripped — all funnel into recoverCredential(), which rotates.
 *
 * @param {string|object} externalId  The shop domain, or the whole opts object.
 * @param {object} [opts]
 * @param {string} [opts.name]
 * @param {string} [opts.plan]                'starter'|'growth'|'scale'
 * @param {number} [opts.monthlySpendCapUsd]  Clamped and enforced upstream.
 * @param {string} [opts.countryHint]         ISO-3166 alpha-2.
 * @param {string} [opts.timezone]
 * @param {boolean} [opts.claimNumber]        Omit for best-effort (recommended);
 *   `true` turns a missing DID into a 422, `false` skips the attempt entirely.
 * @param {object} [opts.metadata]            ≤ 8KB encoded.
 * @returns {Promise<{ workspaceId: string, orgId: string, apiKey: string,
 *                     apiKeyLastFour: string|null, plan: string|null,
 *                     monthlySpendCapUsd: number|null, status: string|null,
 *                     number: { id, e164, country, provider, type }|null,
 *                     numberStatus: string, restored: boolean,
 *                     recovered: boolean }>}
 * @throws {PartnerApiError} carrying the server's `code` and `status`.
 */
export async function provisionWorkspace(externalId, opts = {}) {
  const args = (externalId && typeof externalId === 'object') ? externalId : { externalId, ...opts };
  requirePartnerKey('provisionWorkspace');

  const shop = normaliseExternalId(args.externalId);
  if (!shop) throw new TelenowError('provisionWorkspace: externalId is required');

  // Only fields the caller actually gave. Unknown fields are ignored upstream
  // rather than rejected, but sending `undefined`/`null` for an optional field
  // is not the same as omitting it — `claimNumber: null` would deserialise as
  // "absent" here and as an explicit choice in a future server version.
  const body = { externalId: shop, name: String(args.name || shop) };
  if (args.plan) body.plan = String(args.plan);
  // ★ A CAP OF ZERO IS OMITTED, NOT SENT, AND ONLY ON CREATE. The shipped
  // caller computes it as `Number(billing.capUsd) || 0`, so a shop with no
  // billing row yet — every free install, and every install before its
  // subscription webhook lands — would ask for a ceiling of $0. Upstream that
  // is not "unset", it is a real cap of nothing: `clamp_spend_cap` passes 0
  // through unchanged and `check_spend` then refuses every call the merchant
  // makes, on a workspace that reports `status: "active"`. Omitting the field
  // instead means the org inherits the PARTNER's own operator-configured
  // ceiling — `clamp_spend_cap` returns `(partner ceiling, false)` for a `None`
  // — which is the most this org could ever have been granted anyway, so the
  // install works and nothing is over-provisioned relative to the partner.
  //
  // ★ BUT DO NOT READ THAT AS PER-SHOP CONTAINMENT: TODAY IT IS NOT. An earlier
  // version of this comment claimed "a real ceiling arrives moments later
  // through updatePartnerWorkspace()". It does not. Nothing in this repo calls
  // updatePartnerWorkspace — the app_subscriptions/update webhook
  // (src/webhooks/shopify.js) calls refreshEntitlement(shop) and stops there —
  // so a free or Starter install keeps the WHOLE partner budget as its ceiling
  // indefinitely. The partner-level cap still bounds total damage, but the
  // per-shop bound that src/webhooks/ndr.js's unauthenticated endpoint is
  // supposed to sit behind does not exist until one of two things lands: the
  // subscription handler pushes { plan, monthlySpendCapUsd } upstream through
  // updatePartnerWorkspace(), or create sends a non-zero floor instead of
  // omitting. Both live outside this file. The omit-vs-send-0 choice itself is
  // still right — 0 is a real cap of nothing, not "unset" — so what is missing
  // is the follow-up, not this branch.
  //
  // updatePartnerWorkspace() does send a 0 verbatim, because there it is an
  // explicit instruction rather than a missing value.
  const cap = numberOrNull(args.monthlySpendCapUsd);
  if (cap !== null && cap > 0) body.monthlySpendCapUsd = cap;
  if (args.countryHint) body.countryHint = String(args.countryHint).trim().toUpperCase();
  if (args.timezone) body.timezone = String(args.timezone);
  // Deliberately only when the caller was explicit. Omitted means "attach a DID
  // best-effort", which is what every shop wants and what keeps a partner with
  // no number budget (the default: max_numbers_per_workspace = 0) on the 201
  // path instead of the 422 one.
  if (typeof args.claimNumber === 'boolean') body.claimNumber = args.claimNumber;
  if (args.metadata && typeof args.metadata === 'object') body.metadata = args.metadata;

  // ★ NO `Idempotency-Key` ON CREATE, AND THAT IS A DECISION, NOT AN OVERSIGHT.
  // The header is opt-in on this plane (partner_app_auth.rs sets
  // `requires_idempotency: false` for POST /workspaces) and sending one is
  // actively harmful here, for two reasons that both bite the shipped caller:
  //
  //   1. THE CACHE KEYS ON THE BODY, AND OUR BODY MOVES. middleware/idempotency
  //      .rs computes `req_hash = SHA256(method || path || body)` and answers a
  //      same-key/different-body request with 422 and a text/plain
  //      "Idempotency-Key reuse with different body" — no JSON, no `code`, so
  //      partnerError() can only synthesise `http_422` and the whole install
  //      falls through to the pool. And the body genuinely does move between
  //      attempts for ONE shop: provisioning.js builds `plan` from the billing
  //      row, `metadata.shopifySubscriptionId` from a webhook that has usually
  //      not landed yet, `countryHint` from an async lookup that can time out,
  //      and `monthlySpendCapUsd` is omitted at 0 and present once billing
  //      arrives. A key derived from the shop domain alone would therefore
  //      cover several different requests.
  //
  //   2. A REPLAY NEVER REACHES THE HANDLER, SO IT NEVER RESTORES. A cached
  //      entry is served straight out of Redis without running create at all.
  //      Uninstall → reinstall inside the redacted entry's 1h TTL is exactly
  //      the case the 200 `restored: true` path exists for, and a replay would
  //      hide it behind a 2xx with the credential stripped — after which the
  //      only recovery left, rotate, answers 409 `workspace_released` on the
  //      workspace the DELETE just released. The merchant loses their call
  //      history to a header that bought nothing.
  //
  // Create does not need it: it is idempotent STRUCTURALLY, on the total unique
  // index `uq_provisioned_workspaces_(partner_id, external_id)`. A retry, or a
  // concurrent double-create losing on 23505, finds the existing row and takes
  // the 409 `already_exists` path below — which heals a lost response in ONE
  // call, because that arm mints a replacement key inline. The deterministic-key
  // helper is kept for claimNumber(), where the body IS stable and a replay is
  // the outcome that saves money.
  const res = await partnerFetch('provisionWorkspace', 'POST', '/workspaces', { body });

  // 201 created, or 200 restored-from-release.
  if (res.ok) {
    const shaped = shapeWorkspace(res.data, { restored: res.data?.restored === true });
    if (shaped.apiKey) return shaped;
    // Should not happen now that no Idempotency-Key is sent — every 2xx here
    // comes from the handler, and both `Created` and `Restored` mint a key. It
    // stays handled because the alternative is resolving with `apiKey: null`,
    // which tryPartnerProvision() turns into a pool lease AFTER a real org was
    // committed upstream: no DELETE is ever sent for it and no retention clock
    // ever starts. If it does fire, something replayed us (a proxy, or a caller
    // that reintroduced the header), so rotate to get a credential we can use.
    return recoverCredential(shop, shaped, res.data?.credentialRedacted === true
      ? 'the create response was an idempotent replay with its credential redacted'
      : 'the create response carried no apiKey');
  }

  // ── 409 already_exists ────────────────────────────────────────────────────
  // The workspace is ours and live. The server mints a replacement key inline
  // on this arm when — and only when — the partner holds `workspaces.rotate_key`
  // (routes.rs `CreateOutcome::AlreadyExists`), which is the ordinary case and
  // the one-call heal for a lost create response. When the key is absent we try
  // the rotate route ourselves; see recoverCredential() for why that is a long
  // shot rather than a guarantee, and what it reports when it fails.
  //
  // The body test is deliberately loose at the end: `already_exists` is the only
  // 409 this route produces from the handler, and a 409 that still carries a
  // workspaceId is that outcome whatever the prose says.
  if (res.status === 409 && (res.data?.code === 'already_exists'
    || res.data?.error === 'already_exists'
    || (res.data && typeof res.data === 'object' && res.data.workspaceId))) {
    const shaped = shapeWorkspace(res.data);
    return recoverCredential(
      shop,
      shaped,
      res.data?.apiKey
        ? 'the workspace already existed and the server minted a replacement credential'
        : 'the workspace already existed and the 409 carried no credential',
      res,
    );
  }

  // ── 422 no_numbers_available ──────────────────────────────────────────────
  // NOT a failure. The org was created by THIS request and the key in this body
  // is a first mint; only the DID could not be had. Resolving normally with
  // number:null is the difference between a working workspace with no caller ID
  // and a pool lease that strands the one we just paid for.
  if (res.status === 422 && res.data?.code === 'no_numbers_available') {
    const shaped = shapeWorkspace(res.data, { number: null, numberStatus: 'unavailable' });
    if (shaped.apiKey) {
      console.warn(`[telenow] provisionWorkspace: ${shop} → workspace ${shaped.workspaceId || '(no ref)'} ` +
        `created without a phone number (${shaped.numberReason || 'no_numbers_available'}); ` +
        'it is usable for browser calls and a number can be claimed later.');
      return shaped;
    }
    return recoverCredential(shop, shaped, 'the 422 carried no credential', res);
  }

  throw partnerError('provisionWorkspace', 'POST', '/workspaces', res);
}

/**
 * Internal: get this shop a WORKING credential when the create response did not
 * carry one, and resolve with the ordinary success shape.
 *
 * Steps, each tolerant of the last:
 *   1. fill in the identifiers, by GET /workspaces/by-external-id/{shop} when
 *      the 409/replay body did not carry them — and always, when it can, to
 *      recover the number the workspace already holds, since a conflict body
 *      says nothing about numbers and provisioning.js would otherwise blank the
 *      merchant's stored caller ID;
 *   2. rotate, if we do not already hold a freshly-minted key — a genuine last
 *      resort rather than the reliable heal an earlier draft here claimed, for
 *      the capability reason spelled out at step 2 below.
 *
 * Throws with the ORIGINAL failure's code when it cannot finish (except for the
 * capability refusal, which gets `already_exists_no_credential`), so
 * tryPartnerProvision() falls back to the pool rather than half-succeeding with
 * a workspace nobody can authenticate against.
 *
 * NEVER logs a key — the workspace ref is what an operator needs, and it is not
 * a credential.
 */
async function recoverCredential(shop, shaped, why, originalRes) {
  let out = { ...shaped, recovered: true };

  // 1. Hydrate. Best-effort unless we have no workspace id at all, in which
  //    case there is nothing to rotate and the lookup is load-bearing.
  const needIdentifiers = !out.workspaceId;
  try {
    const look = await partnerFetch('provisionWorkspace', 'GET',
      `/workspaces/by-external-id/${encodeURIComponent(shop)}`);
    if (look.ok) {
      const detail = shapeWorkspace(look.data);
      out = {
        ...out,
        workspaceId: out.workspaceId || detail.workspaceId,
        orgId: out.orgId || detail.orgId,
        externalId: out.externalId || detail.externalId,
        plan: out.plan ?? detail.plan,
        monthlySpendCapUsd: out.monthlySpendCapUsd ?? detail.monthlySpendCapUsd,
        status: out.status || detail.status,
        number: out.number || detail.number,
        numberStatus: detail.numberStatus || out.numberStatus,
      };
    } else if (needIdentifiers) {
      throw partnerError('provisionWorkspace', 'GET', '/workspaces/by-external-id', look);
    }
  } catch (err) {
    if (needIdentifiers) throw recoveryFailure(shop, why, err, originalRes);
    // Otherwise the lookup was an enrichment; a workspace with an unknown
    // number is still a workspace.
    console.error(`[telenow] provisionWorkspace: could not read back ${shop} during recovery ` +
      `(${err.message}) — continuing with what the create answered.`);
  }

  // 2. Mint, unless the server already did it for us on the 409.
  //
  // ★ THIS IS A LAST RESORT, NOT A GUARANTEE, AND THE ARITHMETIC SAYS SO. The
  // 409 arm upstream mints its inline key precisely when the partner holds
  // `workspaces.rotate_key` (routes.rs `CreateOutcome::AlreadyExists`). So a 409
  // that arrived WITHOUT a key means, in the deterministic case, that the
  // partner row lacks that exact capability — and POST /workspaces/{id}/key
  // demands the same capability (partner_app_auth.rs `requires_idempotency` /
  // `capability` table) and is refused 403 `capability_denied`. Rotating after
  // an inline mint did not happen therefore only succeeds in the TRANSIENT
  // sub-case: the partner does hold the capability but the rotate inside the
  // conflict arm errored (`_ => None` there swallows it) or the workspace was
  // released between the two calls. Even that is bounded — the server allows 3
  // rotations per workspace per 24h, and the inline mint spends one of them.
  //
  // It is still worth attempting, because the transient case is real and the
  // alternative is a pool lease that orphans a live org. What must not happen is
  // reporting a capability misconfiguration as a flaky network: see the 403
  // branch below.
  if (!out.apiKey) {
    if (!out.workspaceId) throw recoveryFailure(shop, why, new TelenowError('no workspaceId'), originalRes);
    try {
      const rotated = await rotatePartnerKey(out.workspaceId);
      out.apiKey = rotated.apiKey;
      out.apiKeyLastFour = rotated.apiKeyLastFour || out.apiKeyLastFour;
    } catch (err) {
      // A 403 here is not transient and no retry will fix it: this partner key
      // is not permitted to mint merchant credentials at all. Say that, with
      // the server's own `hint`, and give it a code of its own so an operator
      // reading logs knows to grant `workspaces.rotate_key` on the partner row
      // rather than to go looking for an outage.
      if (err?.status === 403 || err?.code === 'capability_denied') {
        throw capabilityFailure(shop, why, err, originalRes);
      }
      throw recoveryFailure(shop, why, err, originalRes);
    }
  }

  console.warn(`[telenow] provisionWorkspace: recovered ${shop} → workspace ` +
    `${out.workspaceId || '(no ref)'} — ${why}. It now holds a freshly minted credential ` +
    `(…${out.apiKeyLastFour || '????'}); any previous one was revoked. No key is logged.`);
  return out;
}

/**
 * Internal: the throw for the ONE recovery failure that is a configuration
 * error rather than a bad day upstream — the partner is not allowed to mint
 * merchant credentials.
 *
 * It gets its own code, `already_exists_no_credential`, instead of reusing the
 * original `already_exists`, because the two need opposite responses: the
 * ordinary conflict is self-healing and worth retrying on the next request,
 * while this one repeats identically forever until somebody grants
 * `workspaces.rotate_key` on the partner row. Callers that branch on `code`
 * (and operators reading the log line) can tell them apart; everything else
 * still sees a PartnerApiError and still falls back to the pool.
 *
 * The server's `hint` is logged verbatim — it names the exact route to call —
 * and no credential appears anywhere in it.
 */
function capabilityFailure(shop, why, err, originalRes) {
  const hint = originalRes?.data?.hint ? String(originalRes.data.hint) : null;
  console.error(`[telenow] provisionWorkspace: ${shop} — ${why}, and the fallback rotate was REFUSED ` +
    `(${err?.code || 'capability_denied'}). This partner key does not hold \`workspaces.rotate_key\`, ` +
    'so the server could neither mint a replacement inline on the 409 nor honour POST ' +
    '/workspaces/{id}/key. Grant that capability on the partner row; no retry will help until then.' +
    (hint ? ` Server hint: ${hint}` : ''));
  return new PartnerApiError(
    `provisionWorkspace: ${shop} already has a workspace, but this partner key may not mint a ` +
      'credential for it (workspaces.rotate_key is not granted)',
    originalRes?.status ?? err?.status,
    originalRes?.data ?? null,
    'already_exists_no_credential',
  );
}

/**
 * Internal: the throw that ends a failed recovery.
 *
 * Carries the ORIGINAL server code (`already_exists`, …) rather than the
 * rotate's, because that is the fact a caller branches on: what it needs to
 * know is "this shop already has a workspace we could not get into", not
 * "a POST to /key answered 503".
 */
function recoveryFailure(shop, why, err, originalRes) {
  const code = originalRes?.data?.code ? String(originalRes.data.code) : (err?.code || 'partner_recovery_failed');
  const status = originalRes?.status ?? err?.status;
  console.error(`[telenow] provisionWorkspace: ${shop} could not be recovered — ${why}; ` +
    `the follow-up failed with: ${err?.message || 'unknown error'}`);
  return new PartnerApiError(
    `provisionWorkspace: ${shop} already has a workspace but no usable credential could be minted ` +
      `(${err?.message || 'unknown error'})`,
    status,
    originalRes?.data ?? null,
    code,
  );
}

/**
 * Rotate a workspace's merchant credential — contract (5) above. Returns the
 * new plaintext key, which is emitted exactly once and is unrecoverable
 * afterwards.
 *
 * ★ THE IDEMPOTENCY-KEY IS FRESH ON EVERY CALL, AND THAT IS THE WHOLE DECISION.
 * The route REQUIRES the header (16-255 chars), so there are only two options
 * and each has a failure mode:
 *
 *   - Deterministic per workspace. A retry after a lost response replays the
 *     first answer, which the cache stores with the credential STRIPPED — so
 *     the retry hands back no key at all, and the caller is no better off than
 *     it was. Worse, the shape of that failure changes with time: a genuine
 *     SECOND rotation later (a `discardDeadKey()` after a 401, an operator
 *     forcing a rekey) reuses the same key value, and inside the cache window
 *     it replays instead of rotating — telling the caller "rotated" while the
 *     live credential is unchanged, or handing back an entry for a key that has
 *     since been revoked. A rotation that silently does not rotate is the one
 *     outcome a security operation must never have.
 *
 *   - Fresh per call. A lost response leaves a key nobody ever saw, and it is a
 *     LIVE key on the merchant's org. That is the cost, and it is bounded: the
 *     very next attempt rotates again under another new key, `revokePrevious`
 *     defaults to true so the unseen one is revoked on the way, and the whole
 *     thing is audited. The server's own doc prescribes exactly this — "a
 *     caller that lost the first response and needs a usable key must rotate
 *     again under a NEW key, which revokes the one it never saw. Rotation is
 *     cheap and audited precisely so this is affordable."
 *
 * So: prefer a wasted credential that is immediately revoked over a rotation
 * that reports success without rotating. Pass `opts.idempotencyKey` to override
 * when a caller genuinely wants replay semantics for a retry it is driving.
 *
 * @param {string} workspaceId
 * @param {object} [opts]
 * @param {boolean} [opts.revokePrevious=true]  false leaves an overlap window.
 * @param {string} [opts.idempotencyKey]
 * @returns {Promise<{ workspaceId: string, orgId: string, apiKey: string,
 *                     apiKeyLastFour: string, rotatedAt: string,
 *                     previousRevoked: boolean }>}
 */
export async function rotatePartnerKey(workspaceId, opts = {}) {
  if (!workspaceId) throw new TelenowError('rotatePartnerKey: workspaceId is required');
  requirePartnerKey('rotatePartnerKey');

  const path = `/workspaces/${encodeURIComponent(workspaceId)}/key`;
  const body = { revokePrevious: opts.revokePrevious !== false };
  const res = await partnerFetch('rotatePartnerKey', 'POST', path, {
    body,
    idempotencyKey: opts.idempotencyKey || freshIdempotencyKey('shopify-rotate'),
  });
  if (!res.ok) throw partnerError('rotatePartnerKey', 'POST', path, res);

  const apiKey = res.data?.apiKey ? String(res.data.apiKey) : '';
  if (!apiKey) {
    // Only reachable when a caller supplied its own key and hit the replay.
    throw new PartnerApiError(
      'rotatePartnerKey: the rotate response carried no apiKey — this is an idempotent replay of an ' +
        'earlier rotation, whose credential the cache stripped. Retry under a new Idempotency-Key.',
      res.status,
      res.data,
      'credential_redacted',
    );
  }
  return {
    workspaceId: res.data?.workspaceId ? String(res.data.workspaceId) : String(workspaceId),
    orgId: res.data?.orgId ? String(res.data.orgId) : null,
    apiKey,
    apiKeyLastFour: res.data?.apiKeyLastFour ? String(res.data.apiKeyLastFour) : null,
    rotatedAt: res.data?.rotatedAt || null,
    previousRevoked: res.data?.previousRevoked === true,
  };
}

/**
 * Read one workspace back by the shop domain — contract (2) above. No state
 * change, no write, and NEVER a credential; this is how a caller that lost a
 * create response learns the identifiers before rotating.
 *
 * @param {string} externalId  the shop domain
 * @returns {Promise<object>} the server's detail shape
 */
export async function getPartnerWorkspaceByExternalId(externalId) {
  const shop = normaliseExternalId(externalId);
  if (!shop) throw new TelenowError('getPartnerWorkspaceByExternalId: externalId is required');
  requirePartnerKey('getPartnerWorkspaceByExternalId');

  const path = `/workspaces/by-external-id/${encodeURIComponent(shop)}`;
  const res = await partnerFetch('getPartnerWorkspaceByExternalId', 'GET', path);
  if (!res.ok) throw partnerError('getPartnerWorkspaceByExternalId', 'GET', path, res);
  return res.data;
}

/**
 * Update a workspace's plan, spend ceiling or status — contract (3) above.
 *
 * ★ NOTHING IN THIS REPO CALLS THIS YET, and that is a live gap rather than a
 * spare part. It is meant to run on every app_subscriptions/update so the
 * upstream ceiling tracks the plan the merchant is actually paying Shopify for;
 * the webhook handler in src/webhooks/shopify.js currently stops at
 * refreshEntitlement(shop). Until it does, every workspace keeps whatever
 * ceiling create left it with — see the spend-cap note in provisionWorkspace().
 *
 * ONLY THE FIELDS GIVEN ARE SENT. Every one of them is an absolute value rather
 * than a delta (which is why this route needs no Idempotency-Key: replaying it
 * lands in the same place), so an omitted field keeps its stored value and a
 * `null` would be a different, wrong request.
 *
 * A cap above the partner's ceiling is CLAMPED, not refused: the answer is 200
 * with `spendCapClamped: true` and the effective number in
 * `monthlySpendCapUsd`. Read that field rather than assuming the request went
 * through verbatim.
 *
 * @param {string} workspaceId
 * @param {object} patch
 * @param {string} [patch.plan]
 * @param {number} [patch.monthlySpendCapUsd]
 * @param {'active'|'suspended'} [patch.status]  'released' is not settable —
 *   release is a lifecycle transition with side effects and has its own verb.
 * @returns {Promise<{ success: boolean, workspaceId: string, orgId: string,
 *                     plan: string|null, monthlySpendCapUsd: number,
 *                     spendCapClamped: boolean, status: string }>}
 */
export async function updatePartnerWorkspace(workspaceId, patch = {}) {
  if (!workspaceId) throw new TelenowError('updatePartnerWorkspace: workspaceId is required');
  requirePartnerKey('updatePartnerWorkspace');

  const body = {};
  if (patch.plan !== undefined && patch.plan !== null) body.plan = String(patch.plan);
  const cap = numberOrNull(patch.monthlySpendCapUsd);
  if (cap !== null) body.monthlySpendCapUsd = cap;
  if (patch.status !== undefined && patch.status !== null) body.status = String(patch.status);

  // Refused here rather than upstream: the server answers 400 `no_fields` for
  // an empty PATCH, and paying a round trip to be told that we sent nothing is
  // a round trip on a billing webhook's critical path.
  if (Object.keys(body).length === 0) {
    throw new TelenowError(
      'updatePartnerWorkspace: at least one of plan, monthlySpendCapUsd or status is required');
  }

  const path = `/workspaces/${encodeURIComponent(workspaceId)}`;
  const res = await partnerFetch('updatePartnerWorkspace', 'PATCH', path, { body });
  if (!res.ok) throw partnerError('updatePartnerWorkspace', 'PATCH', path, res);
  return res.data;
}

/**
 * Claim an additional caller-ID number for a workspace — contract (4) above.
 * The per-workspace ceiling is the partner's
 * `max_numbers_per_workspace` (0 until an operator funds it), and the upstream
 * 409 `limit_reached` is authoritative, so do not pre-check the plan here.
 *
 * ★ NO DEFAULT COUNTRY, deliberately. This JSDoc used to say `country='IN'`,
 * and that is the exact India-only assumption the app has just removed
 * everywhere else — the caller resolves the shop's own country now. Omitted, the
 * server answers 400 `invalid_country`, which is a readable error; guessed, it
 * buys a real number on the wrong continent, which is money spent on a caller ID
 * that gets spam-filtered.
 *
 * ★ THE IDEMPOTENCY-KEY IS DETERMINISTIC HERE, unlike rotate, and for the
 * opposite reason: this route spends real carrier money, so replaying the first
 * answer is the SAFE outcome and buying a second DID is the unsafe one. It is
 * derived from the path and the EXACT body being sent, so a retry of "give this
 * shop a GB local number" replays, while a deliberate second claim (Scale allows
 * more than one) should pass its own `opts.idempotencyKey`. This route is also
 * the one place the header is genuinely mandatory — partner_app_auth.rs sets
 * `requires_idempotency: true` for POST /workspaces/{id}/numbers — so unlike on
 * create it cannot simply be dropped.
 *
 * @param {string} workspaceId
 * @param {object} [opts]
 * @param {string} [opts.country]   ISO-3166 alpha-2. Required by the server.
 * @param {'local'|'mobile'|'tollfree'|string} [opts.type]
 * @param {string} [opts.provider]  Omit to let the provider registry decide.
 * @param {string} [opts.pattern]   Digit pattern / area-code hint.
 * @param {string} [opts.idempotencyKey]
 * @returns {Promise<{ id: string, e164: string, country: string|null,
 *                     provider: string|null, type: string|null,
 *                     status: string, assigned: boolean }>}
 */
export async function claimNumber(workspaceId, opts = {}) {
  if (!workspaceId) throw new TelenowError('claimNumber: workspaceId is required');
  requirePartnerKey('claimNumber');

  const body = {};
  if (opts.country) body.country = String(opts.country).trim().toUpperCase();
  if (opts.type) body.type = String(opts.type);
  if (opts.provider) body.provider = String(opts.provider);
  if (opts.pattern) body.pattern = String(opts.pattern);

  const path = `/workspaces/${encodeURIComponent(workspaceId)}/numbers`;
  // ★ THE DIGEST IS OVER THE SERIALISED BODY, not a hand-picked tuple of fields.
  // An earlier draft hashed (workspaceId, country, type, pattern) and left
  // `provider` out, which is a real field on this body — so two claims that
  // differed only in provider shared one key with two different bodies, and the
  // server answered 422 text/plain "Idempotency-Key reuse with different body"
  // (no JSON, no `code`, so it surfaces as the uninformative `http_422`) instead
  // of either replaying or claiming. Hashing what is actually sent makes that
  // class of bug unrepresentable: add a field to `body` above and the key
  // follows it. The path is in the digest too, so two workspaces never collide.
  const res = await partnerFetch('claimNumber', 'POST', path, {
    body,
    idempotencyKey: opts.idempotencyKey
      || deterministicIdempotencyKey('shopify-number', path, JSON.stringify(body)),
  });
  if (!res.ok) throw partnerError('claimNumber', 'POST', path, res);

  const number = normaliseNumber(res.data) || {};
  return {
    ...number,
    status: res.data?.status ? String(res.data.status) : 'claimed',
    // A claimed number with no agent bound reaches the org's missed-call
    // action, not the merchant's AI — so this reports what was bought, never
    // that it is answering.
    assigned: res.data?.assigned === true,
  };
}

/**
 * Tear a workspace down on uninstall — contract (6) above. The release is SOFT:
 * upstream it revokes the merchant's keys, deactivates the shadow owner,
 * suspends billing, archives the org and starts a retention clock, so a
 * reinstall inside that window is restored with its call history intact (the
 * 200 `restored: true` on create). Nothing here is irreversible.
 *
 * ★ 404 RESOLVES AS SUCCESS. The only reason to call this twice is a retry, and
 * turning "already gone" into an error would leave the uninstall path failing
 * forever on a workspace that is already dead — and releaseWorkspace() in
 * provisioning.js runs on the purge path, where a throw abandons the rest of a
 * departing merchant's cleanup. (The server is friendlier still: releasing an
 * already-released workspace answers 204, and only an unknown workspace — or
 * one belonging to another partner — is a 404.)
 *
 * @param {string} workspaceId
 * @returns {Promise<{ released: boolean, alreadyGone: boolean }>}
 */
export async function releasePartnerWorkspace(workspaceId) {
  if (!workspaceId) throw new TelenowError('releasePartnerWorkspace: workspaceId is required');
  requirePartnerKey('releasePartnerWorkspace');

  const path = `/workspaces/${encodeURIComponent(workspaceId)}`;
  const res = await partnerFetch('releasePartnerWorkspace', 'DELETE', path);
  if (res.status === 404) {
    console.log(`[telenow] releasePartnerWorkspace: ${workspaceId} was already gone (404) — treating as released.`);
    return { released: true, alreadyGone: true };
  }
  if (!res.ok) throw partnerError('releasePartnerWorkspace', 'DELETE', path, res);
  return { released: true, alreadyGone: false };
}

/**
 * Alias kept because src/provisioning.js probes for `telenow.releaseWorkspace`
 * on its uninstall path. The unprefixed name is ambiguous inside this module —
 * everything else here is merchant-scoped and this one is operator-scoped —
 * so releasePartnerWorkspace is the name to write in new code.
 */
export { releasePartnerWorkspace as releaseWorkspace };
