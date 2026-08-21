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

  /**
   * Provider catalog — turns raw ids into human labels. Sections: llm, stt,
   * tts, telephony (arrays of { id, name, blurb, latency:{ms,tier},
   * perMinuteUsd, configFields:[{key,label,options:[{label,value}]}] }), plus
   * platformFee:{perMinUsd,percent}. Stable enough to cache per process.
   * @returns {Promise<object>}
   */
  async getCatalog() {
    const res = await this.#request('GET', '/api/catalog');
    return res?.data ?? res;
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
