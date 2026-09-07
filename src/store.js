// ─────────────────────────────────────────────────────────────────────────────
// store.js — persistence stub (file-based JSON).
//
// !!! REPLACE WITH A REAL DATABASE IN PRODUCTION !!!
// This module keeps everything in a single JSON file under DATA_DIR plus an
// in-memory cache. It is fine for local development and a single-process demo,
// but it is NOT safe for multi-instance/concurrent production deployments
// (no locking, last-write-wins, whole-file rewrites). Swap the four logical
// stores below for tables in Postgres/MySQL/DynamoDB/etc.:
//
//   1. shops        — offline OAuth sessions keyed by shop domain
//   2. settings     — per-shop automation settings (see settings.js)
//   3. callMap      — sessionId → { shop, orderId, automation } (for write-back)
//   4. hooks        — per-shop Telenow webhook subscription { id, secret }
//
// Telenow API keys live inside `settings` (per shop). They are secrets — see the
// security note in README.md. Never log them.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '..', 'data');

const DB_FILE = path.join(DATA_DIR, 'store.json');

/** @typedef {{ shops: object, settings: object, callMap: object, hooks: object,
 *              keypool: object }} DB */

/** In-memory cache of the whole DB. Loaded once at startup. */
let db = load();

function emptyDb() {
  return { shops: {}, settings: {}, callMap: {}, hooks: {}, attempts: {}, leads: {}, leadSeq: {},
    fulfillments: {}, keypool: {} };
}

function load() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) return emptyDb();
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    // No `|| '{}'` fallback: a truncated or empty file must reach the catch
    // below, not parse to {} and boot as a healthy-looking empty database.
    const parsed = JSON.parse(raw);
    const loaded = { ...emptyDb(), ...parsed };
    migrateLeadKeys(loaded);
    return loaded;
  } catch (err) {
    // Do NOT start empty. Every shop's offline Shopify access token and Telenow
    // API key live in this file, and the very next write persists the whole
    // in-memory db — so booting empty turns one bad parse into a permanent,
    // silent wipe of every merchant's install while /healthz still returns 200.
    //
    // Rename rather than copy, so that next write cannot clobber the evidence.
    const quarantine = `${DB_FILE}.corrupt.${Date.now()}`;
    try {
      fs.renameSync(DB_FILE, quarantine);
    } catch {
      // Nothing more we can do — the message below still names the problem.
    }
    console.error(`[store] DB unreadable, quarantined to ${quarantine}: ${err.message}`);
    console.error('[store] refusing to start empty — restore from backup before restarting.');
    // load() runs at module scope, so this is a boot failure by design. The
    // container restart policy will surface it as a crash loop.
    process.exit(1);
  }
}

/**
 * One-time migration: leads used to be keyed by the BARE per-tenant numeric id,
 * which collided across tenants (two shops' first leads both at db.leads[1]). We
 * now key by a composite `${shop}:${id}`. Rekey any legacy bare-id entries so
 * existing store.json data isn't orphaned. No-op once everything is composite.
 */
function migrateLeadKeys(d) {
  if (!d || !d.leads) return;
  for (const [key, lead] of Object.entries(d.leads)) {
    if (!lead || typeof lead !== 'object') continue;
    const composite = `${lead.shop}:${lead.id}`;
    if (key !== composite && lead.shop != null && lead.id != null) {
      d.leads[composite] = lead;
      delete d.leads[key];
    }
  }
}

/** Atomically-ish persist the in-memory DB to disk (write tmp + rename). */
function persist() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    console.error('[store] failed to persist DB:', err.message);
  }
}

// ── Shops (offline OAuth sessions) ───────────────────────────────────────────

/**
 * Persist an offline Shopify session. We store the minimal fields we need to
 * make Admin API calls later (the offline access token never expires until the
 * merchant uninstalls).
 * @param {string} shop  e.g. "my-store.myshopify.com"
 * @param {{ accessToken: string, scope?: string, sessionId?: string }} session
 */
export function saveShop(shop, session) {
  db.shops[shop] = {
    shop,
    accessToken: session.accessToken,
    scope: session.scope,
    sessionId: session.sessionId,
    installedAt: db.shops[shop]?.installedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  persist();
  return db.shops[shop];
}

/** @returns {{ shop: string, accessToken: string, scope?: string } | undefined} */
export function getShop(shop) {
  return db.shops[shop];
}

export function listShops() {
  return Object.values(db.shops);
}

/** Remove a shop and all of its associated data (used on app/shop uninstall). */
export function deleteShop(shop) {
  delete db.shops[shop];
  delete db.settings[shop];
  delete db.hooks[shop];
  // The shop's KEYPOOL ROW IS DELIBERATELY NOT DELETED. It is the only surviving
  // record that the workspace behind that ref still holds this merchant's call
  // recordings, transcripts and customer phone numbers; drop the row and the
  // next boot sees an unknown ref in the pool source, registers it as `free`,
  // and hands the departing merchant's data to whoever installs next. So the
  // quarantine record must outlive the shop it came from — that is the whole
  // point of it. It is purged only by scripts/keypool.js after a real wipe.
  //
  // Instead we make the row terminal: releaseWorkspace() normally quarantines
  // before we get here, but deleteShop is also reached from shop/redact (48h
  // post-uninstall) and from paths where the release never ran, so an entry
  // still marked `leased` is quarantined now rather than left looking live.
  quarantineShopEntry(shop);
  // Drop any callMap entries belonging to this shop.
  for (const [sid, entry] of Object.entries(db.callMap)) {
    if (entry?.shop === shop) delete db.callMap[sid];
  }
  // Drop any dedupe attempts belonging to this shop. Keys are
  // "<automation>:<shop>:<identifier>" (see _base.js), so match on ":<shop>:".
  for (const k of Object.keys(db.attempts)) {
    if (k.includes(`:${shop}:`)) delete db.attempts[k];
  }
  // Drop this shop's leads (PII) and reset its lead id counter. Delete by the
  // ACTUAL map key (composite `${shop}:${id}`), never the inner lead.id.
  for (const [mapKey, lead] of Object.entries(db.leads)) {
    if (lead?.shop === shop) delete db.leads[mapKey];
  }
  delete db.leadSeq[shop];
  persist();
}

// ── GDPR / privacy helpers (Shopify mandatory compliance webhooks) ───────────
// We hold only call METADATA at rest (sessionId → { shop, orderId, automation }),
// never the shopper's phone/transcript — those live in Telenow. These helpers
// satisfy customers/data_request (export) and customers/redact (erase) for the
// data we do hold; recordings/transcripts are redacted on the Telenow side.

/**
 * Collect everything we hold for a customer, identified by their order ids
 * and/or customer id. Used by the customers/data_request webhook.
 * @returns {{ shop: string, calls: Array<object> }}
 */
export function collectCustomerData(shop, orderIds = [], customerId = null) {
  const ids = new Set((orderIds || []).map(String));
  const custKey = customerId != null ? `customer:${customerId}` : null;
  const calls = [];
  for (const [sid, e] of Object.entries(db.callMap)) {
    if (e?.shop !== shop) continue;
    const byOrder = e.orderId != null && ids.has(String(e.orderId));
    const byCustomer = custKey && e.identifier === custKey;
    if (byOrder || byCustomer) calls.push({ sessionId: sid, ...e });
  }
  // Lead rows hold PII (name/email/phone) — include any tied to this customer.
  const leads = [];
  if (customerId != null) {
    for (const lead of Object.values(db.leads)) {
      if (lead?.shop === shop && String(lead.shopifyCustomerId) === String(customerId)) {
        leads.push(lead);
      }
    }
  }
  return { shop, calls, leads };
}

/**
 * Erase any data we hold tied to a customer's orders / customer id. Used by the
 * customers/redact webhook. Returns the number of call records removed.
 */
export function redactCustomer(shop, orderIds = [], customerId = null) {
  const ids = new Set((orderIds || []).map(String));
  const custKey = customerId != null ? `customer:${customerId}` : null;
  let removed = 0;
  for (const [sid, e] of Object.entries(db.callMap)) {
    if (e?.shop !== shop) continue;
    const byOrder = e.orderId != null && ids.has(String(e.orderId));
    const byCustomer = custKey && e.identifier === custKey;
    if (byOrder || byCustomer) {
      delete db.callMap[sid];
      removed++;
    }
  }
  // Erase lead rows (PII) for this customer, and defensively drop their dedupe
  // attempts (keyed "leadCallback:<shop>:lead:<leadId>").
  if (customerId != null) {
    for (const [mapKey, lead] of Object.entries(db.leads)) {
      if (lead?.shop === shop && String(lead.shopifyCustomerId) === String(customerId)) {
        delete db.leads[mapKey];
        // Dedupe attempts are keyed by the bare per-tenant lead id, not map key.
        delete db.attempts[`leadCallback:${shop}:lead:${lead.id}`];
        removed++;
      }
    }
  }
  for (const k of Object.keys(db.attempts)) {
    if (!k.includes(`:${shop}:`)) continue;
    const byOrder = [...ids].some((id) => k.endsWith(`:order:${id}`));
    const byCustomer = custKey && k.endsWith(`:${custKey}`);
    if (byOrder || byCustomer) delete db.attempts[k];
  }
  persist();
  return removed;
}

// ── Settings (per shop) ──────────────────────────────────────────────────────
// Raw get/set — the typed model + defaults live in settings.js.

export function getSettingsRaw(shop) {
  return db.settings[shop];
}

export function setSettingsRaw(shop, settings) {
  db.settings[shop] = settings;
  persist();
  return settings;
}

// ── Call map (sessionId → order) ─────────────────────────────────────────────
// Persisted so the Telenow result webhook can find the originating order.

/**
 * @param {string} sessionId  Telenow sessionId returned by initiate-call
 * @param {{ shop: string, orderId?: string|number, checkoutId?: string|number,
 *           automation: string, identifier?: string }} entry
 */
export function mapCall(sessionId, entry) {
  db.callMap[sessionId] = { ...entry, createdAt: new Date().toISOString() };
  persist();
}

export function getCall(sessionId) {
  return db.callMap[sessionId];
}

export function deleteCall(sessionId) {
  delete db.callMap[sessionId];
  persist();
}

// ── Per-entity attempt dedupe ────────────────────────────────────────────────
// Shopify redelivers webhooks (on timeout/retry, and checkouts/update fires many
// times for one cart), so we record an attempt per (shop+automation+entity) and
// refuse to place a second call for the same key within a TTL. Atomic check-and-set
// so two near-simultaneous deliveries can't both pass the guard.

/**
 * Record an attempt for `key` IF one isn't already live. Returns true if this
 * caller "won" (should proceed to place the call), false if a live attempt
 * already exists (skip — duplicate).
 * @param {string} key   stable key, e.g. "codConfirmation:shop.myshopify.com:order:123"
 * @param {number} ttlMs how long the attempt blocks re-attempts (default 24h)
 */
export function markAttempt(key, ttlMs = 24 * 60 * 60 * 1000) {
  if (!key) return true;
  const now = Date.now();
  const prev = db.attempts[key];
  if (prev && now - prev.at < (prev.ttlMs ?? ttlMs)) {
    return false; // a live attempt already exists → caller should skip
  }
  db.attempts[key] = { at: now, ttlMs };
  // Opportunistically GC expired entries so the map doesn't grow unbounded.
  for (const [k, v] of Object.entries(db.attempts)) {
    if (now - v.at >= (v.ttlMs ?? ttlMs)) delete db.attempts[k];
  }
  persist();
  return true;
}

/** Forget an attempt (e.g. to allow a retry after a failed placement). */
export function clearAttempt(key) {
  if (db.attempts[key]) {
    delete db.attempts[key];
    persist();
  }
}

// ── Telenow hook subscription (per shop) ─────────────────────────────────────
// We store the hook id + signing secret returned by POST /api/v1/hooks so we
// can verify inbound X-VoiceAI-Signature and clean up on uninstall.

/** @param {string} shop @param {{ id: string, secret: string }} hook */
export function saveHook(shop, hook) {
  db.hooks[shop] = { ...hook, savedAt: new Date().toISOString() };
  persist();
}

export function getHook(shop) {
  return db.hooks[shop];
}

/**
 * Find the shop that owns a Telenow hook by its signing secret. Used by the
 * Telenow webhook receiver to verify the signature when the payload doesn't
 * carry the shop. Returns { shop, hook } or undefined.
 */
export function findShopByHookSecret(secret) {
  for (const [shop, hook] of Object.entries(db.hooks)) {
    if (hook?.secret === secret) return { shop, hook };
  }
  return undefined;
}

export function deleteHook(shop) {
  delete db.hooks[shop];
  persist();
}

// ── Leads (per shop) ─────────────────────────────────────────────────────────
// A lead is captured when Shopify creates a customer (signup / lead app / contact
// form). We store it FIRST (so it appears in the dashboard even if the call is
// skipped), then place a speed-to-lead callback and patch the row with the result.
// These rows hold PII (name/email/phone) — the GDPR helpers above cover them.
//
// File-stub caveat (same as the rest of this module): swap for a DB table in
// production. We cap the collection to the most recent ~1000 rows per shop so the
// JSON file doesn't grow without bound.

const MAX_LEADS_PER_SHOP = 1000;

/**
 * Insert a new lead row and return its auto-increment id (per-shop counter).
 * @param {string} shop
 * @param {object} data  { source, shopifyCustomerId, name, email, phone, fields,
 *                         sessionId, agentId, status, disposition, summary, duration }
 * @returns {number} the new lead id
 */
export function insertLead(shop, data = {}) {
  const id = (db.leadSeq[shop] = (db.leadSeq[shop] || 0) + 1);
  // Key by a COMPOSITE `${shop}:${id}` so two tenants' first leads (both id=1)
  // don't clobber each other. The RETURNED/display id stays the bare number.
  db.leads[`${shop}:${id}`] = {
    id,
    shop,
    createdAt: new Date().toISOString(),
    source: data.source ?? '',
    shopifyCustomerId: data.shopifyCustomerId ?? null,
    name: data.name ?? '',
    email: data.email ?? '',
    phone: data.phone ?? '',
    fields: data.fields ?? {},
    sessionId: data.sessionId ?? null,
    agentId: data.agentId ?? null,
    status: data.status ?? 'queued',
    disposition: data.disposition ?? '',
    summary: data.summary ?? '',
    duration: data.duration ?? null,
  };
  pruneLeads(shop);
  persist();
  return id;
}

/** Patch an existing lead row (shallow merge). No-op if it doesn't exist. */
export function updateLead(shop, id, patch = {}) {
  const key = `${shop}:${id}`;
  const lead = db.leads[key];
  if (!lead || lead.shop !== shop) return undefined;
  db.leads[key] = { ...lead, ...patch, updatedAt: new Date().toISOString() };
  persist();
  return db.leads[key];
}

/** @returns {object|undefined} the lead row, or undefined. */
export function getLead(shop, id) {
  const lead = db.leads[`${shop}:${id}`];
  return lead && lead.shop === shop ? lead : undefined;
}

/** List a shop's leads, newest first, capped to `limit`. */
export function listLeads(shop, limit = 100) {
  return Object.values(db.leads)
    .filter((l) => l?.shop === shop)
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, limit);
}

/** Keep only the most recent MAX_LEADS_PER_SHOP rows for a shop (file-stub bound). */
function pruneLeads(shop) {
  // Sort this shop's [mapKey, lead] entries newest-first and drop everything
  // past the cap, deleting by the ACTUAL map key (composite), not lead.id.
  const stale = Object.entries(db.leads)
    .filter(([, l]) => l?.shop === shop)
    .sort(([, a], [, b]) => Number(b.id) - Number(a.id))
    .slice(MAX_LEADS_PER_SHOP);
  for (const [mapKey] of stale) delete db.leads[mapKey];
}


// ─────────────────────────────────────────────────────────────────────────────
// Fulfillment index
//
// The feedback sweep asks "which orders were fulfilled N days ago", and there
// is nowhere else to get that: Shopify will not answer it cheaply, and the
// webhook only fires once, at the moment of fulfillment. So each orders/fulfilled
// is recorded here and the sweep reads back from it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record that an order was fulfilled. Idempotent — Shopify retries webhooks,
 * and the first fulfilledAt is the true one, so a repeat does not move it.
 * @param {string} shop
 * @param {object} rec { orderId, orderName, fulfilledAt, phone, name, total, items }
 */
export function recordFulfillment(shop, rec) {
  if (!shop || !rec?.orderId) return null;
  db.fulfillments[shop] ||= {};
  const key = String(rec.orderId);
  const existing = db.fulfillments[shop][key];
  if (existing) return existing;
  db.fulfillments[shop][key] = {
    ...rec,
    orderId: key,
    fulfilledAt: rec.fulfilledAt || new Date().toISOString(),
    calledAt: null,
  };
  persist();
  return db.fulfillments[shop][key];
}

/**
 * Orders fulfilled long enough ago to be worth calling about, for ONE purpose.
 *
 * Two sweeps read this index — feedback and post-purchase — and they must not
 * both ring the same customer. So "called" is tracked per purpose, and
 * `suppressIfCalledWithinDays` additionally hides orders another purpose called
 * recently. Without that, a customer who rated the product on Monday gets an
 * upsell call on Tuesday.
 *
 * The age window is a range, not a floor: `maxAgeDays` stops a newly-enabled
 * sweep dredging up months of old orders, while still catching anything missed
 * while it was paused.
 *
 * @param {string} shop
 * @param {string} purpose  "feedback" | "postPurchase"
 * @param {object} opts { days, maxAgeDays, suppressIfCalledWithinDays }
 * @returns {Array<object>}
 */
export function dueForCall(shop, purpose, opts = {}) {
  const all = db.fulfillments[shop] || {};
  const now = Date.now();
  const minAge = Math.max(0, Number(opts.days) || 0) * 86400000;
  const maxAge = Math.max(minAge, Number(opts.maxAgeDays ?? 30) * 86400000);
  const suppressMs = Math.max(0, Number(opts.suppressIfCalledWithinDays) || 0) * 86400000;

  return Object.values(all).filter((f) => {
    const calls = f.calls || {};
    if (calls[purpose]) return false; // already done for this purpose

    if (suppressMs > 0) {
      for (const [p, ts] of Object.entries(calls)) {
        if (p === purpose || !ts) continue;
        if (now - new Date(ts).getTime() < suppressMs) return false;
      }
    }

    const age = now - new Date(f.fulfilledAt).getTime();
    return Number.isFinite(age) && age >= minAge && age <= maxAge;
  });
}

/** Mark one order as called for a purpose so neither sweep repeats it. */
export function markCalled(shop, orderId, purpose) {
  const rec = db.fulfillments[shop]?.[String(orderId)];
  if (!rec) return null;
  rec.calls = { ...(rec.calls || {}), [purpose]: new Date().toISOString() };
  persist();
  return rec;
}

/** @deprecated thin wrappers kept so existing callers do not break. */
export function dueForFeedback(shop, days, maxAgeDays = 30) {
  return dueForCall(shop, 'feedback', { days, maxAgeDays });
}
export function markFeedbackCalled(shop, orderId) {
  return markCalled(shop, orderId, 'feedback');
}

/** Drop records older than `days` so the file store does not grow forever. */
export function pruneFulfillments(shop, days = 90) {
  const all = db.fulfillments[shop];
  if (!all) return 0;
  const cutoff = Date.now() - Math.max(1, Number(days)) * 86400000;
  let n = 0;
  for (const [k, f] of Object.entries(all)) {
    if (new Date(f.fulfilledAt).getTime() < cutoff) { delete all[k]; n++; }
  }
  if (n) persist();
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Key pool — leased Telenow calling workspaces
//
// The merchant never supplies a Telenow API key any more (that off-platform
// signup is what got the app paused). An operator mints a batch of workspaces
// ahead of time and seeds them via TELENOW_KEY_POOL or ${DATA_DIR}/keypool.json;
// this module hands one to each shop and remembers who holds what.
//
// SPLIT OF RESPONSIBILITY — credentials vs. bookkeeping. The seed material
// (apiKey, numberE164, numberId, plus the optional provider/country labels on
// the number) is held in memory only and is NEVER copied into
// store.json. Two reasons: store.json is already the most sensitive file on the
// box and duplicating a second live secret into it buys nothing, and an operator
// must be able to rotate a workspace's key by editing the seed alone, with no
// migration. What IS persisted is the lease — which ref belongs to which shop,
// and what state that ref is in.
//
// STATES.  free → leased → quarantined, with dead as a terminal branch.
//   free         never handed out (or wiped and returned by an operator)
//   leased       bound to exactly one shop
//   quarantined  the shop is gone, but the workspace still holds their data
//   dead         the credential no longer authenticates (Telenow answered 401)
// NOTHING in this process ever moves an entry back to `free`. See releaseKey().
//
// src/provisioning.js also parses the same seed, but only to report *why* a
// lease failed. Leasing happens here and nowhere else: two code paths popping
// from one pool would eventually hand a single workspace to two merchants.
// ─────────────────────────────────────────────────────────────────────────────

const POOL_FILE = path.join(DATA_DIR, 'keypool.json');

/**
 * ref → { ref, apiKey, numberE164, numberId, provider, country }.
 * In-memory only; see above.
 */
let poolSource = null;

// PROVIDER AND COUNTRY ARE OPTIONAL, AND ABSENT MEANS UNKNOWN — NEVER 'IN'.
//
// The seed shipped before these two fields existed, so every entry an operator
// has already written lacks them. Defaulting the country to India (which is what
// the rest of the app used to do implicitly) would silently mark that whole
// legacy pool as Indian and let leaseKey() hand an Indian DID to a US merchant
// while logging a confident country match. `null` is the honest value: it never
// matches a preferred country, so an unknown entry is only ever used as the
// last-resort fallback — which is exactly what it is.
//
// Both spellings are accepted because the operator-facing pool seed and the
// platform's own number rows disagree: /api/v1/numbers calls them `provider` and
// `country`, while a hand-written seed that already carries `numberE164` /
// `numberId` naturally reads `numberProvider` / `numberCountry`. Taking both
// costs one `??` and removes a silent-drop failure mode from a config file that
// nothing validates.

/** Lowercase platform provider id ('plivo', 'twilio', …), or null if unusable. */
function normalizeProvider(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

/** ISO-3166-1 alpha-2, uppercased ('US', 'IN', …), or null if unusable. */
function normalizeCountry(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null;
}

/**
 * Read the operator-seeded pool: TELENOW_KEY_POOL (a JSON array), else
 * ${DATA_DIR}/keypool.json.
 *
 * Unlike load() above this NEVER exits the process on bad input. The database is
 * irreplaceable, so a corrupt one must stop the boot; the seed is a config value
 * an operator can retype in a minute, and crash-looping over a typo in an env
 * var would take down every already-provisioned shop, none of which needs the
 * pool to keep serving. A malformed seed reads as empty and says so.
 *
 * @returns {Array<object>} raw seed entries (validated in registerPoolEntries)
 */
function readPoolSeed() {
  let raw = null;
  let where = 'none';
  try {
    if (process.env.TELENOW_KEY_POOL) {
      where = 'TELENOW_KEY_POOL';
      raw = process.env.TELENOW_KEY_POOL;
    } else if (fs.existsSync(POOL_FILE)) {
      where = POOL_FILE;
      raw = fs.readFileSync(POOL_FILE, 'utf8');
    }
  } catch (err) {
    console.error(`[store] key pool seed (${where}) unreadable: ${err.message}`);
    return [];
  }
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error(`[store] key pool seed (${where}) is not a JSON array — treating the pool as empty.`);
      return [];
    }
    return parsed;
  } catch (err) {
    // Never echo `raw` in the message — it is a list of live API keys.
    console.error(`[store] key pool seed (${where}) is not valid JSON: ${err.message}`);
    console.error('[store] treating the pool as EMPTY — new shops cannot be provisioned until fixed.');
    return [];
  }
}

/** Load the seed once, on the first keypool call. */
function ensurePoolLoaded() {
  if (poolSource !== null) return;
  poolSource = new Map();
  registerPoolEntries(readPoolSeed());
}

/**
 * Register seed entries with the store: an unknown ref is inserted as `free`,
 * and a ref already on the books is left EXACTLY as it is.
 *
 * That second half is the load-bearing one. The same array is re-supplied on
 * every boot, so if registration reset state, one restart would flip every
 * quarantined workspace back to free and re-issue the previous merchants' call
 * recordings to whoever installs next. Registration therefore only ever adds.
 *
 * Credentials ARE refreshed for known refs — that is how a key rotation reaches
 * a shop already leasing the ref. It is the lease STATE that is immutable here,
 * not the secret behind it.
 *
 * `provider` and `country` are OPTIONAL and additive: an entry seeded before they
 * existed still registers, still leases, and is simply treated as unknown-origin.
 * Only `ref` and `apiKey` are load-bearing, and that has not changed — a bad or
 * missing provider/country degrades one entry to "unknown", never to rejected,
 * because a number that dials is worth more than a number that is labelled.
 *
 * @param {Array<{ref: string, apiKey: string, numberE164?: string, numberId?: string,
 *                provider?: string, numberProvider?: string,
 *                country?: string, numberCountry?: string}>} entries
 * @returns {number} how many previously-unknown refs were added
 */
export function registerPoolEntries(entries) {
  if (poolSource === null) poolSource = new Map();
  if (!Array.isArray(entries)) return 0;

  let added = 0;
  let malformed = 0;
  for (const raw of entries) {
    const ref = typeof raw?.ref === 'string' ? raw.ref.trim() : '';
    const apiKey = typeof raw?.apiKey === 'string' ? raw.apiKey.trim() : '';
    if (!ref || !apiKey) { malformed++; continue; }

    poolSource.set(ref, {
      ref,
      apiKey,
      numberE164: raw.numberE164 ?? null,
      numberId: raw.numberId ?? null,
      provider: normalizeProvider(raw.provider ?? raw.numberProvider),
      country: normalizeCountry(raw.country ?? raw.numberCountry),
    });

    if (!db.keypool[ref]) {
      db.keypool[ref] = { ref, shop: null, state: 'free', leasedAt: null, releasedAt: null };
      added++;
    }
  }
  if (malformed) {
    console.error(`[store] key pool: ${malformed} entries missing ref or apiKey — ignored.`);
  }
  if (added) persist();
  return added;
}

/**
 * Merge the persisted lease row with the in-memory secret for its ref.
 * @param {{ref: string}} entry  the persisted lease row
 * @param {{apiKey: string, numberE164?: string|null, numberId?: string|null,
 *          provider?: string|null, country?: string|null}} creds
 * @returns {{ ref: string, apiKey: string, numberE164: string|null, numberId: string|null,
 *            provider: string|null, country: string|null }}
 */
function mergePoolEntry(entry, creds) {
  return {
    ref: entry.ref,
    apiKey: creds.apiKey,
    numberE164: creds.numberE164 ?? null,
    numberId: creds.numberId ?? null,
    provider: creds.provider ?? null,
    country: creds.country ?? null,
  };
}

/**
 * Bind a workspace to a shop, or return the one it already holds.
 *
 * Idempotent per shop by design: provisioning.js calls this on a self-heal path
 * and again behind an in-flight map at boot, and an implementation that popped a
 * fresh entry each time would burn a workspace per restart while stranding the
 * merchant's data in the ones it abandoned.
 *
 * COUNTRY IS A PREFERENCE, NEVER A REQUIREMENT. A merchant whose shoppers are in
 * the US is far better served by a US caller ID — a foreign DID dialling a North
 * American mobile is routinely blocked or spam-filtered, which is the same defect
 * that would fail a Shopify reviewer's test call. But an unmatched country must
 * never turn into a refusal: a working foreign number still connects, while a
 * null lease means the install answers 503 and the merchant has no app at all.
 * So the country only reorders the scan; it never shortens it.
 *
 * @param {string} shop
 * @param {{ preferCountry?: string|null }} [opts]  ISO-3166-1 alpha-2, case-insensitive
 * @returns {{ ref: string, apiKey: string, numberE164: string|null, numberId: string|null,
 *             provider: string|null, country: string|null }|null}
 */
export function leaseKey(shop, opts = {}) {
  if (!shop) return null;
  ensurePoolLoaded();

  const preferCountry = normalizeCountry(opts?.preferCountry);

  const held = Object.values(db.keypool).find((e) => e?.state === 'leased' && e.shop === shop);
  if (held) {
    const creds = poolSource.get(held.ref);
    if (creds) return mergePoolEntry(held, creds);
    // Leased, but no longer in the seed: the operator pulled it while the shop
    // was using it. There is no credential to return and there never will be for
    // this ref, so retire it and lease a different one. `dead` rather than
    // `free`, because the workspace may still hold that shop's data.
    held.state = 'dead';
    held.releasedAt = new Date().toISOString();
    console.error(`[store] keypool ref ${held.ref} is leased but missing from the seed — marking it dead.`);
    persist();
  }

  // A shop reclaiming its OWN quarantined workspace is the one reuse that is
  // privacy-safe, and skipping it is expensive twice over.
  //
  // Uninstall quarantines the entry and deleteShop wipes the settings row. A
  // reinstall minutes later would otherwise scan past that entry, burn a second
  // pool workspace, and leave the merchant's agents stranded in the first one —
  // they would come back as tombstones in a store that looks freshly broken.
  // Install → uninstall → reinstall is also exactly how a Shopify reviewer tests
  // requirement 1.2.2, so three cycles could drain a small pool to exhaustion
  // and answer a fresh install with 503.
  //
  // Bounded to 48h so a workspace does not sit unusable indefinitely waiting for
  // a merchant who is not coming back; after that an operator wipes it through
  // scripts/keypool.js and it returns to the pool clean. The shop match is what
  // makes this safe — a quarantined entry is NEVER handed to a different shop.
  const RECLAIM_WINDOW_MS = 48 * 60 * 60 * 1000;
  for (const entry of Object.values(db.keypool)) {
    if (entry?.state !== 'quarantined' || entry.shop !== shop) continue;
    const released = Date.parse(entry.releasedAt || '');
    if (!Number.isFinite(released) || Date.now() - released > RECLAIM_WINDOW_MS) continue;
    const creds = poolSource.get(entry.ref);
    if (!creds) continue;
    entry.state = 'leased';
    entry.leasedAt = new Date().toISOString();
    entry.releasedAt = null;
    persist();
    console.log(`[store] keypool: rule=reclaim — ref ${entry.ref} reclaimed by ${shop} after reinstall.`);
    return mergePoolEntry(entry, creds);
  }

  // Two passes over the same `free` set, not one pass with a filter, because the
  // second pass MUST still run when the first finds nothing. Written as a filter
  // it becomes one `continue` away from returning null on a full pool simply
  // because the merchant's country is not stocked.
  const takeFree = (wantCountry) => {
    for (const entry of Object.values(db.keypool)) {
      if (entry?.state !== 'free') continue;
      const creds = poolSource.get(entry.ref);
      if (!creds) continue; // registered once, since removed from the seed
      // A null country is unknown, not a wildcard — see normalizeCountry above.
      if (wantCountry && creds.country !== wantCountry) continue;
      entry.shop = shop;
      entry.state = 'leased';
      entry.leasedAt = new Date().toISOString();
      entry.releasedAt = null;
      persist();
      return { entry, creds };
    }
    return null;
  };

  if (preferCountry) {
    const match = takeFree(preferCountry);
    if (match) {
      console.log(`[store] keypool: rule=country-match — ref ${match.entry.ref} (${preferCountry}) leased to ${shop}.`);
      return mergePoolEntry(match.entry, match.creds);
    }
  }

  const any = takeFree(null);
  if (any) {
    if (preferCountry) {
      // Not a warning for the merchant — they still get a working number — but it
      // is the ONLY signal an operator gets that a country is out of stock, and
      // it has to fire before the pool empties rather than after.
      console.warn(
        `[store] keypool: rule=any-free — no free ${preferCountry} number available; `
        + `ref ${any.entry.ref} (${any.creds.country || 'country unknown'}) leased to ${shop}. `
        + `Mint ${preferCountry} numbers into the pool.`,
      );
    } else {
      console.log(`[store] keypool: rule=any-free — ref ${any.entry.ref} leased to ${shop}.`);
    }
    return mergePoolEntry(any.entry, any.creds);
  }

  return null; // exhausted — the caller answers 503, never a paywall
}

/**
 * Move a shop's entry out of service. Returns the ref, or null if it held none.
 *
 * THE ENTRY GOES TO `quarantined`, NEVER BACK TO `free`, AND NOTHING IN THIS
 * PROCESS MAY CHANGE THAT. A released workspace still contains the departing
 * merchant's call recordings, transcripts, agent configuration and their
 * customers' phone numbers. Handing it to the next merchant who installs would
 * disclose one merchant's protected customer data to another — a GDPR breach and
 * a Shopify protected-customer-data violation, produced by an optimisation that
 * reads like harmless inventory reuse.
 *
 * Reclaiming inventory is therefore an explicit operator act after an actual
 * purge: `node scripts/keypool.js wipe <ref> --wiped`. Until then the entry is
 * counted separately by keypoolStatus(), so the obligation stays visible instead
 * of hiding inside a healthy-looking free count.
 *
 * @param {string} shop
 * @returns {string|null} the quarantined ref
 */
export function releaseKey(shop) {
  const ref = quarantineShopEntry(shop);
  if (ref) persist();
  return ref;
}

/**
 * The state move behind releaseKey(), without the write — deleteShop() calls it
 * too and persists once for the whole teardown. Only one entry per shop can be
 * `leased`, so the first match is the only match.
 */
function quarantineShopEntry(shop) {
  if (!shop) return null;
  for (const entry of Object.values(db.keypool)) {
    if (entry?.shop !== shop || entry.state !== 'leased') continue;
    entry.state = 'quarantined';
    entry.releasedAt = new Date().toISOString();
    // entry.shop is left SET on purpose. It names the merchant whose data is
    // still sitting in that workspace, which is exactly what an operator needs
    // to know before wiping it. Nulling it here would leave a quarantined ref
    // with no record of what has to be purged.
    return entry.ref;
  }
  return null;
}

/**
 * Retire a ref whose credential no longer authenticates (Telenow answered 401).
 * Safe with an unknown or already-dead ref — provisioning.js calls it from an
 * error path, where guessing wrong must not cascade.
 *
 * @param {string} ref
 * @returns {boolean} whether this call changed anything
 */
export function markKeyDead(ref) {
  if (!ref) return false;
  const entry = db.keypool[ref];
  if (!entry || entry.state === 'dead') return false;
  entry.state = 'dead';
  entry.releasedAt = new Date().toISOString();
  persist();
  return true;
}

/**
 * Pool census for /healthz and ops alerting.
 *
 * byCountry/byProvider count FREE ENTRIES ONLY, deliberately. The question these
 * answer is not "what have we bought" but "what can the next install actually
 * get" — a pool of forty numbers is still out of stock for a US merchant if all
 * forty are leased. Counting everything would show `US: 12` right up to the
 * moment a US merchant is handed an Indian DID, which is the exact failure this
 * census exists to catch.
 *
 * Entries seeded without the fields are bucketed under `unknown` rather than
 * dropped, so the totals of each map always reconcile with `free`; an operator
 * seeing a large `unknown` knows the labels are missing, not the numbers.
 *
 * @returns {{ total: number, leased: number, free: number, quarantined: number, dead: number,
 *             byCountry: Record<string, number>, byProvider: Record<string, number> }}
 */
export function keypoolStatus() {
  ensurePoolLoaded();
  const status = {
    total: 0, leased: 0, free: 0, quarantined: 0, dead: 0,
    byCountry: {}, byProvider: {},
  };
  for (const entry of Object.values(db.keypool)) {
    if (!entry) continue;
    status.total++;
    if (entry.state === 'leased') status.leased++;
    else if (entry.state === 'free') {
      status.free++;
      // Labels live in the in-memory seed, never in store.json (see the split of
      // responsibility above), so they are read back through poolSource here.
      const creds = poolSource.get(entry.ref);
      const country = creds?.country || 'unknown';
      const provider = creds?.provider || 'unknown';
      status.byCountry[country] = (status.byCountry[country] || 0) + 1;
      status.byProvider[provider] = (status.byProvider[provider] || 0) + 1;
    } else if (entry.state === 'quarantined') status.quarantined++;
    else if (entry.state === 'dead') status.dead++;
  }
  return status;
}
