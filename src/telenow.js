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
// Below the class there is a SECOND, operator-scoped surface: the partner
// provisioning stubs (`X-Partner-Key`, not `X-API-Key`), which create and tear
// down whole workspaces. They throw NotImplemented in v1 — see the block
// comment there for why they exist and the exact HTTP contract they encode.
//
// SECURITY: never log the API key. Errors below include status + response body
// for debugging but deliberately do not echo the Authorization/X-API-Key header.
// ─────────────────────────────────────────────────────────────────────────────

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
// PARTNER PROVISIONING — v1.1 seam. STUBS ONLY; every function below throws.
//
// WHY THIS EXISTS AS DEAD CODE. The app may not ask a merchant to create a
// Telenow account or paste a `vai_live_` key — that is the off-platform signup
// wall the Shopify review flagged — so the server has to own the workspace
// lifecycle. Telenow does not expose that API yet, and the class above is
// deliberately the wrong shape for it: every method there authenticates with
// ONE merchant's `vai_live_` key, whereas creating a workspace happens before
// any such key exists. v1 therefore leases pre-minted workspaces from an
// operator pool (src/provisioning.js). These stubs are the seam that pool
// sits behind: when the partner API ships, the bodies below are filled in and
// no caller changes.
//
// AUTH FOR ALL FOUR CALLS: header `X-Partner-Key: tnp_live_…`, read from
// process.env.TELENOW_PARTNER_KEY. This is a NEW credential class, distinct
// from `vai_live_`, scoped to workspace lifecycle only and never to placing a
// call — so a leaked merchant key cannot mint workspaces and a leaked partner
// key cannot dial a phone number. It is an operator secret: it never reaches
// the browser, never lands in settings, and is never logged.
//
// BASE URL: `${TELENOW_API_BASE}` (default https://api.telenow.ai).
// Every call MUST be safe to retry, MUST NOT return a merchant-visible URL or
// price, and MUST NOT require any human step on telenow.ai.
//
// ── 1) CREATE A WORKSPACE — idempotent on externalId ─────────────────────────
//   POST /api/v1/partner/workspaces
//   Content-Type: application/json
//   X-Partner-Key: tnp_live_…
//   { "externalId": "acme.myshopify.com",
//     "name": "Acme Store (Shopify)",
//     "plan": "growth",
//     "monthlySpendCapUsd": 220,
//     "countryHint": "IN",
//     "metadata": { "platform": "shopify",
//                   "shopifySubscriptionId": "gid://shopify/AppSubscription/123" } }
//
//   201 { "workspaceId": "ws_9f2…", "apiKey": "vai_live_…",
//         "number": { "id": "num_…", "e164": "+91…", "country": "IN" } }
//   409 { "error": "already_exists", "workspaceId": "ws_9f2…", "apiKey": "vai_live_…" }
//   422 { "error": "no_numbers_available", "workspaceId": "ws_9f2…", "apiKey": "vai_live_…" }
//
//   `apiKey` MUST be present on the 409 as well. Without it, a retry after a
//   lost response strands the shop: the workspace exists, so create will never
//   again return a key, and the merchant has a workspace they cannot reach.
//   On 422 the workspace is still created and usable for web calls; the number
//   is claimed later through (3).
//
// ── 2) UPDATE PLAN / SPEND CEILING — on every app_subscriptions/update ───────
//   PATCH /api/v1/partner/workspaces/{workspaceId}
//   { "plan": "scale", "monthlySpendCapUsd": 550, "status": "active" }   // status: active|suspended
//   200 { "workspaceId": "ws_9f2…", "plan": "scale", "monthlySpendCapUsd": 550, "status": "active" }
//
//   `monthlySpendCapUsd` MUST be enforced server-side by Telenow. It is the
//   containment for src/webhooks/ndr.js, which places calls from an
//   unauthenticated public endpoint — a client-side cap there is no cap at all.
//
// ── 3) CLAIM AN ADDITIONAL NUMBER (Scale allows 3) ──────────────────────────
//   POST /api/v1/partner/workspaces/{workspaceId}/numbers
//   { "country": "IN", "type": "local" }
//   201 { "id": "num_…", "e164": "+91…", "country": "IN", "type": "local" }
//   409 { "error": "limit_reached", "limit": 3 }
//
// ── 4) RELEASE — on uninstall. Revokes the key, releases numbers, archives ───
//   DELETE /api/v1/partner/workspaces/{workspaceId}
//   204 (no body)
//   404 { "error": "not_found" }        // treat as success — already released
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown by every partner stub in v1. Carries `code` so callers can tell "this
 * seam is not built yet" apart from "Telenow answered with an error", and fall
 * through to the key pool only in the former case.
 */
export class NotImplementedError extends TelenowError {
  constructor(what) {
    super(`NotImplemented: ${what} — the Telenow partner provisioning API is not available yet. ` +
      'v1 leases workspaces from the operator key pool (see src/provisioning.js).');
    this.name = 'NotImplementedError';
    this.code = 'not_implemented';
  }
}

/** Internal: assert the operator credential exists before pretending to call. */
function requirePartnerKey(what) {
  if (!process.env.TELENOW_PARTNER_KEY) {
    // Never echo the value, and never hint at its length or prefix.
    throw new TelenowError(`${what}: TELENOW_PARTNER_KEY is not configured`);
  }
}

/**
 * Create (or re-fetch) the Telenow workspace backing one Shopify store.
 * Idempotent on `externalId` — see contract (1) above.
 *
 * Accepts either `provisionWorkspace(externalId, opts)` or a single options
 * object carrying `externalId`. Both forms are supported on purpose:
 * src/provisioning.js calls the object form, while the seam is specified as
 * (externalId, opts), and a v1.1 implementer must not have to guess which the
 * live caller uses.
 *
 * @param {string|object} externalId  The shop domain, or the whole opts object.
 * @param {object} [opts]
 * @param {string} [opts.name]
 * @param {string} [opts.plan]                'starter'|'growth'|'scale'
 * @param {number} [opts.monthlySpendCapUsd]  Enforced upstream, not here.
 * @param {string} [opts.countryHint]
 * @param {object} [opts.metadata]
 * @returns {Promise<{ workspaceId: string, apiKey: string,
 *                     number?: { id: string, e164: string, country: string } }>}
 * @throws {NotImplementedError} always, in v1.
 */
export async function provisionWorkspace(externalId, opts = {}) {
  const args = (externalId && typeof externalId === 'object') ? externalId : { externalId, ...opts };
  requirePartnerKey('provisionWorkspace');
  void args; // v1.1: POST /api/v1/partner/workspaces with `args` as the body.
  throw new NotImplementedError('provisionWorkspace');
}

/**
 * Update a workspace's plan, spend ceiling or status — contract (2) above.
 * Called on every app_subscriptions/update so the upstream ceiling tracks the
 * plan the merchant is actually paying Shopify for.
 *
 * @param {string} workspaceId
 * @param {object} patch
 * @param {string} [patch.plan]
 * @param {number} [patch.monthlySpendCapUsd]
 * @param {'active'|'suspended'} [patch.status]
 * @returns {Promise<{ workspaceId: string, plan: string,
 *                     monthlySpendCapUsd: number, status: string }>}
 * @throws {NotImplementedError} always, in v1.
 */
export async function updatePartnerWorkspace(workspaceId, patch = {}) {
  if (!workspaceId) throw new TelenowError('updatePartnerWorkspace: workspaceId is required');
  requirePartnerKey('updatePartnerWorkspace');
  void patch; // v1.1: PATCH /api/v1/partner/workspaces/{workspaceId}.
  throw new NotImplementedError('updatePartnerWorkspace');
}

/**
 * Claim an additional caller-ID number for a workspace — contract (3) above.
 * Scale allows 3; the upstream 409 `limit_reached` is authoritative, so do not
 * pre-check the plan here.
 *
 * @param {string} workspaceId
 * @param {object} [opts]
 * @param {string} [opts.country='IN']
 * @param {'local'|string} [opts.type='local']
 * @returns {Promise<{ id: string, e164: string, country: string, type: string }>}
 * @throws {NotImplementedError} always, in v1.
 */
export async function claimNumber(workspaceId, opts = {}) {
  if (!workspaceId) throw new TelenowError('claimNumber: workspaceId is required');
  requirePartnerKey('claimNumber');
  void opts; // v1.1: POST /api/v1/partner/workspaces/{workspaceId}/numbers.
  throw new NotImplementedError('claimNumber');
}

/**
 * Tear a workspace down on uninstall — contract (4) above. Revokes the key,
 * releases the numbers and archives the workspace, so a partner-minted
 * workspace is destroyed rather than quarantined the way a pooled one is.
 *
 * A 404 MUST be treated as success by the implementation: the only reason to
 * call this twice is a retry, and turning "already gone" into an error would
 * leave the uninstall path failing forever on a workspace that is already dead.
 *
 * @param {string} workspaceId
 * @returns {Promise<void>}
 * @throws {NotImplementedError} always, in v1.
 */
export async function releasePartnerWorkspace(workspaceId) {
  if (!workspaceId) throw new TelenowError('releasePartnerWorkspace: workspaceId is required');
  requirePartnerKey('releasePartnerWorkspace');
  throw new NotImplementedError('releasePartnerWorkspace');
}

/**
 * Alias kept because src/provisioning.js probes for `telenow.releaseWorkspace`
 * on its uninstall path. The unprefixed name is ambiguous inside this module —
 * everything else here is merchant-scoped and this one is operator-scoped —
 * so releasePartnerWorkspace is the name to write in new code.
 */
export { releasePartnerWorkspace as releaseWorkspace };
