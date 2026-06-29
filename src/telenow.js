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
  async #request(method, path, body) {
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
  async initiateCall({ agentId, mobileNumber, variables = {}, identifier, machineDetection = 'hangup' }) {
    if (!agentId) throw new TelenowError('initiateCall: agentId is required');
    if (!mobileNumber) throw new TelenowError('initiateCall: mobileNumber (E.164) is required');
    const res = await this.#request('POST', '/api/sessions/initiate-call', {
      agentId,
      mobileNumber,
      variables,
      identifier,
      machineDetection,
    });
    // The initiate-call response is ENVELOPED: { success, data: { sessionId, ... } }.
    // Some failures arrive as 2xx with success:false, so guard on that too. We
    // return the inner `data` so callers can read result.sessionId directly.
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
}

/** Convenience factory. */
export function telenow(apiKey, opts) {
  return new TelenowClient(apiKey, opts);
}
