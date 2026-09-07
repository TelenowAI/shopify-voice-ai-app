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
    key: 'rtoRecovery',
    label: 'Failed delivery / RTO recovery',
    // Shopify emits nothing for a failed delivery, so this one is driven by the
    // courier or 3PL posting to /webhooks/ndr/:token rather than a store event.
    triggers: ['carrier NDR webhook'],
    defaultDelayMinutes: 0,
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
    key: 'postPurchase',
    label: 'Post-purchase check-in',
    // Same fulfilment sweep as reviews, a few days later, and suppressed when
    // the feedback call already reached that customer.
    triggers: ['scheduled (X days after fulfillment)'],
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
    // Set by the setup wizard. Overrides delayMinutes when not null.
    delaySeconds: null,
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
    // Which ready-made templates have been set up, and the agent each made:
    //   { cod: { agentId, at }, support: { … } }
    installedTemplates: {},
    // Secret path segment for the carrier NDR endpoint. Minted on demand so a
    // shop that never uses RTO never gets one.
    ndrToken: null,
    // Set the first time the merchant finishes (or skips) the welcome flow.
    // Null means the embedded UI should show onboarding on open.
    onboardedAt: null,
    // ISO-3166-1 alpha-2, UPPERCASE ('US', 'IN', 'GB', …). The store's own
    // country, resolved ONCE from the Shopify Admin API and cached here.
    //
    // Cached rather than fetched per use because it cannot change for an
    // installed store: it comes off the shop's billing address, and a merchant
    // who moves countries re-registers the store. Every dialling path
    // (toE164/extractPhone), the leased-number country preference and the
    // test-call placeholder need it on paths where an Admin API round trip is
    // either too slow (page load) or unavailable (a cron sweep, a Telenow
    // call-ended webhook), so a cheap local read is the only workable shape.
    //
    // null means "NOT RESOLVED YET" — never "India", and never a licence to
    // fall back to 'IN'. Readers must go through the shared country resolver
    // (explicit argument → shopCountry → DEFAULT_PHONE_COUNTRY → 'US'), because
    // guessing India here is exactly the defect that makes a North-American
    // reviewer's test call fail.
    shopCountry: null,
    automations,
    // The cached Shopify entitlement. Shopify — not this file — is the
    // authority on what the merchant is paying for; this is a local copy so
    // that gating a call-ended webhook or a page load does not have to make an
    // Admin API round trip. billing.js refreshes it and writes it back whole.
    // A brand-new install is on Starter with no subscription, which is why
    // every field here is the "never bought anything" value rather than null:
    // a partially-populated entitlement must not read as "no plan" for a
    // merchant who is in fact paying.
    billing: {
      plan: 'starter',
      planName: null,
      status: 'NONE',
      subscriptionId: null,
      usageLineItemId: null,
      test: false,
      trialEndsAt: null,
      currentPeriodEnd: null,
      balanceUsedUsd: 0,
      capUsd: 0,
      checkedAt: null,
      lastWebhookAt: null,
      // CSRF nonce for the billing approval round trip, and the plan handle it
      // was minted for. Both are cleared by /billing/callback once matched.
      pendingState: null,
      pendingPlan: null,
    },
    // The AI-voice-minute ledger for the current billing period. periodStart
    // and periodEnd are deliberately null rather than a timestamp computed
    // here: defaultSettings() runs on every getSettings() call, so a `new
    // Date()` in this object would hand a different window to every read of a
    // shop that has never been metered. usage.js anchors the window the first
    // time it rolls, and owns every write to this key thereafter.
    usage: {
      periodStart: null,
      periodEnd: null,
      usedMinutes: 0,
      billedMinutes: 0,
      billedSessions: [],
      warnedAt80: false,
    },
    // Where telenowApiKey above came from. 'none' until the shop is
    // provisioned, then 'pool' (a workspace leased from the pre-provisioned
    // key pool) or 'partner' (minted through the Telenow partner API). This
    // matters on uninstall: only a leased workspace gets quarantined.
    telenowKeySource: 'none',
    // Opaque pool/workspace identifier for the leased workspace. Operator-side
    // only — it is the handle `scripts/keypool.js` uses to wipe and re-release
    // an entry, and it is never sent to the browser.
    telenowWorkspaceRef: null,
    telenowLeasedAt: null,
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
  // The top-level spread already covers the plain new keys — a store.json
  // written before billing shipped simply has no `billing`, `usage` or
  // `telenowKeySource` property, so the defaults from `base` survive and an old
  // shop reads back as an un-provisioned Starter with no migration step.
  //
  // The two object-valued keys need the same treatment `automations` gets a few
  // lines down, and for the same reason: a spread replaces them wholesale, so a
  // blob persisted against an earlier shape would come back missing whichever
  // fields that shape lacked, and a reader asking for `settings.billing.capUsd`
  // would get undefined rather than 0. billing.js and usage.js both normalize
  // defensively on their own read paths, but every other caller in the app
  // touches these through getSettings() and should not have to.
  merged.billing = { ...base.billing, ...(stored.billing || {}) };
  merged.usage = { ...base.usage, ...(stored.usage || {}) };
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
 *
 * On the calling key: a workspace leased from the key pool is written into the
 * SAME `telenowApiKey` field a merchant-pasted key used to occupy. That is the
 * whole point of the field's placement — it means the leased key inherits the
 * masking below for free, and every existing reader (telenowFor, placeCall, the
 * hook installer) keeps finding the key exactly where it always looked, with no
 * edit and no second code path to keep in sync. `telenowKeySource` is what tells
 * the UI which of the two it is looking at.
 *
 * Two fields are held back rather than passed through:
 *   - telenowWorkspaceRef is an operator-side pool handle. It has no use in the
 *     merchant UI and naming another tenant's storage bucket to a browser is a
 *     gift to anyone reading the page.
 *   - billing.pendingState is the CSRF nonce for the subscription approval round
 *     trip. /billing/callback trusts it to prove the redirect belongs to a flow
 *     this shop actually started, so shipping it to the page — where any script
 *     embedded in the admin frame can read it — would defeat the check it exists
 *     to perform. Everything else on `billing` and all of `usage` is merchant-
 *     facing plan and minute state and goes out untouched.
 *
 * `shopCountry` DOES go out, deliberately, and must keep going out. It is not a
 * secret — it is the shop's own country, which the merchant can read off their
 * own Shopify settings page — and the UI needs it to build a test-call example
 * in the merchant's own dialling format instead of the hardcoded +91 that made
 * this app look India-only. It is a plain key on `s`, so the `...safe` spread
 * carries it; if you ever convert that spread to an explicit allow-list, keep
 * this field in it or the placeholder silently regresses to a generic example.
 */
export function getRedactedSettings(shop) {
  const { telenowWorkspaceRef, ...s } = getSettings(shop);
  const { pendingState, ...billing } = s.billing || {};
  // The browser is told WHETHER calling is ready, never HOW it is credentialed.
  //
  // This used to return telenowApiKey (masked), telenowApiKeySet and
  // telenowKeySource. All three are gone on purpose. The app was paused under
  // requirement 1.2.1 for making merchants paste a vai_live_ key, so a reviewer
  // opening the network tab on an app that answers /api/settings with a field
  // literally named `telenowApiKey` — even masked to "vai_live_a…wxyz" — is
  // reading evidence that the thing they paused us for is still there. There is
  // also nothing the UI can legitimately do with it: the merchant does not own
  // this credential, cannot change it, and is never told it exists.
  //
  // `ndrToken` is stripped for a different reason: it authenticates the public
  // carrier endpoint by secrecy alone, and /api/ndr-endpoint already serves it
  // on demand to the one screen that shows it. Broadcasting it on every settings
  // load widened its exposure for nothing.
  const { telenowApiKey, ndrToken, ...safe } = s;
  return {
    ...safe,
    callingReady: Boolean(telenowApiKey),
    billing,
    usage: s.usage,
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