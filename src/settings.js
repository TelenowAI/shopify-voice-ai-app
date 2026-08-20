// ─────────────────────────────────────────────────────────────────────────────
// settings.js — per-shop settings model.
//
// Each shop has one settings object:
//   - telenowApiKey: the merchant's `vai_live_...` key (SECRET — never log it)
//   - automations:   per-use-case config { enabled, agentId, delayMinutes,
//                     quietHours, filters, ... }
//   - winBackDays:   threshold for the win-back scheduled job
//
// Persistence is delegated to store.js (file stub today, DB tomorrow).
// ─────────────────────────────────────────────────────────────────────────────

import { getSettingsRaw, setSettingsRaw } from './store.js';

/**
 * The canonical list of automations the app ships with. Each has a stable key
 * used in the settings UI and the webhook dispatcher. `triggers` is purely
 * documentation of which Shopify topics/cron drive it.
 */
export const AUTOMATIONS = [
  {
    key: 'abandonedCheckout',
    label: 'Abandoned checkout recovery',
    triggers: ['checkouts/create', 'checkouts/update'],
    defaultDelayMinutes: 30,
  },
  {
    key: 'codConfirmation',
    label: 'COD order confirmation / RTO reduction',
    triggers: ['orders/create'],
    defaultDelayMinutes: 5,
  },
  {
    key: 'leadCallback',
    label: 'Lead callback (new customer)',
    triggers: ['customers/create'],
    defaultDelayMinutes: 0,
  },
  {
    key: 'orderConfirmation',
    label: 'Order confirmation call',
    triggers: ['orders/create'],
    defaultDelayMinutes: 0,
  },
  {
    key: 'orderShipped',
    label: 'Shipped / delivery update',
    triggers: ['orders/fulfilled'],
    defaultDelayMinutes: 0,
  },
  {
    key: 'winBack',
    label: 'Win-back / re-engagement',
    triggers: ['scheduled'],
    defaultDelayMinutes: 0,
  },
  {
    key: 'reviews',
    label: 'Reviews / NPS',
    triggers: ['scheduled (X days after fulfillment)'],
    defaultDelayMinutes: 0,
  },
];

/** Build the default config for a single automation. */
function defaultAutomation(def) {
  return {
    enabled: false,
    agentId: '', // Telenow agent UUID — required when enabled
    delayMinutes: def.defaultDelayMinutes ?? 0,
    // Quiet hours: don't place calls within this local window. 24h "HH:MM".
    quietHours: { enabled: false, start: '21:00', end: '09:00', timezone: 'Asia/Kolkata' },
    // Free-form filters per automation (see each automation module for usage).
    filters: {
      // e.g. minOrderValue, allowedCountries: ['IN'], codGatewaysExtra: []
    },
  };
}

/** Build a fresh default settings object for a newly-installed shop. */
export function defaultSettings(shop) {
  const automations = {};
  for (const def of AUTOMATIONS) automations[def.key] = defaultAutomation(def);
  return {
    shop,
    telenowApiKey: '',
    winBackDays: 60, // call customers whose last order is older than N days
    // Telenow agent ids the merchant has explicitly added to this store.
    // Empty by design: the Agents page starts blank and the merchant pulls in
    // only the agents they actually want, rather than every agent in the org.
    savedAgents: [],
    // Set the first time the merchant finishes (or skips) the welcome flow.
    // Null means the embedded UI should show onboarding on open.
    onboardedAt: null,
    automations,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Get a shop's settings, filling in any missing automations with defaults so
 * older persisted blobs stay forward-compatible as we add use cases.
 * @param {string} shop
 */
export function getSettings(shop) {
  const stored = getSettingsRaw(shop);
  const base = defaultSettings(shop);
  if (!stored) return base;
  // Merge: stored wins, but ensure every known automation key exists.
  const merged = { ...base, ...stored };
  merged.automations = { ...base.automations, ...(stored.automations || {}) };
  for (const def of AUTOMATIONS) {
    merged.automations[def.key] = {
      ...defaultAutomation(def),
      ...(merged.automations[def.key] || {}),
    };
  }
  return merged;
}

/** Convenience: config for one automation. */
export function getAutomation(shop, key) {
  return getSettings(shop).automations[key];
}

/**
 * Persist a settings update (shallow-merged onto current). Pass only the fields
 * you want to change. Returns the full, merged settings.
 * @param {string} shop
 * @param {Partial<ReturnType<typeof defaultSettings>>} patch
 */
export function updateSettings(shop, patch = {}) {
  const current = getSettings(shop);
  const next = {
    ...current,
    ...patch,
    automations: { ...current.automations },
    updatedAt: new Date().toISOString(),
  };
  // Deep-merge automations if provided.
  if (patch.automations) {
    for (const [key, cfg] of Object.entries(patch.automations)) {
      next.automations[key] = { ...current.automations[key], ...cfg };
    }
  }
  setSettingsRaw(shop, next);
  return next;
}

/**
 * Settings safe to send to the browser settings UI: the API key is masked so we
 * never ship the raw secret to the client.
 */
export function getRedactedSettings(shop) {
  const s = getSettings(shop);
  return {
    ...s,
    telenowApiKey: maskKey(s.telenowApiKey),
    telenowApiKeySet: Boolean(s.telenowApiKey),
  };
}

/** "vai_live_abcd…wxyz" → show only a hint, never the full secret. */
export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 12) return '••••';
  return `${key.slice(0, 9)}…${key.slice(-4)}`;
}


/** Agent ids this shop has added. Always an array. */
export function getSavedAgents(shop) {
  const v = getSettings(shop).savedAgents;
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : [];
}

/**
 * Add an agent id. Idempotent — adding twice is a no-op rather than an error,
 * so a double-click cannot create a duplicate row in the list.
 * @returns {string[]} the updated list
 */
export function addSavedAgent(shop, agentId) {
  const id = String(agentId || '').trim();
  if (!id) return getSavedAgents(shop);
  const list = getSavedAgents(shop);
  if (list.includes(id)) return list;
  const next = [...list, id];
  updateSettings(shop, { savedAgents: next });
  return next;
}

/** Remove an agent id. Idempotent. @returns {string[]} the updated list */
export function removeSavedAgent(shop, agentId) {
  const id = String(agentId || '').trim();
  const list = getSavedAgents(shop);
  if (!id || !list.includes(id)) return list;
  const next = list.filter((x) => x !== id);
  updateSettings(shop, { savedAgents: next });
  return next;
}