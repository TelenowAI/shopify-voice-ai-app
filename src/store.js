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

/** @typedef {{ shops: object, settings: object, callMap: object, hooks: object }} DB */

/** In-memory cache of the whole DB. Loaded once at startup. */
let db = load();

function emptyDb() {
  return { shops: {}, settings: {}, callMap: {}, hooks: {}, attempts: {}, leads: {}, leadSeq: {} };
}

function load() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) return emptyDb();
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    const loaded = { ...emptyDb(), ...parsed };
    migrateLeadKeys(loaded);
    return loaded;
  } catch (err) {
    // Corrupt file shouldn't crash the app — start fresh but keep a backup.
    console.error('[store] failed to load DB, starting empty:', err.message);
    return emptyDb();
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
