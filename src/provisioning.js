// ─────────────────────────────────────────────────────────────────────────────
// provisioning.js — the calling workspace that sits behind every shop.
//
// Shopify paused this app under requirement 1.2.1 because using it meant
// creating an account on telenow.ai and pasting a `vai_live_…` key: a second,
// off-platform paywall. That wall is gone. The server owns the Telenow
// credential for every shop now, and the merchant never sees, holds, supplies
// or is even told about one.
//
// ONE code path for every shop — reviewer, free Starter merchant and paying
// merchant alike. There is deliberately no `if (subscription.test)` branch and
// no reviewer-only sandbox pool: a reviewer who discovered that a test store
// gets a pre-baked workspace while a live store goes somewhere else would stop
// asking about billing and start asking whether the demonstrated functionality
// was real.
//
// The v1 mechanism is a pre-minted pool. An operator signs up N Telenow
// workspaces by hand, attaches one caller-ID number and a hard monthly spend
// ceiling to each (that ceiling is the containment for the unauthenticated
// carrier NDR endpoint), and seeds them through TELENOW_KEY_POOL or
// ${DATA_DIR}/keypool.json. The partner API that would mint workspaces
// server-to-server does not exist yet — src/telenow.js exposes only per-merchant
// CRUD — so it lives here as a documented seam rather than as a dependency on
// another team's release date. See tryPartnerProvision().
//
// PRIVACY RULE THAT OVERRIDES THE OBVIOUS OPTIMISATION: a released workspace is
// never handed to the next merchant. It still holds the previous merchant's call
// recordings, transcripts, customer phone numbers and agents, so leasing it on
// would hand one merchant's protected customer data to another. releaseWorkspace()
// therefore QUARANTINES the entry; only an operator who has actually purged the
// workspace on the Telenow side may return it to the free pool, via
// `scripts/keypool.js wipe <ref> --wiped`. poolStatus() reports `quarantined`
// separately so the cost of that rule is visible in ops rather than silent.
//
// Exhaustion is a retry state, never a paywall: ensureWorkspace() returns null,
// the caller answers 503, and nothing merchant-visible mentions Telenow, a
// third-party account, or an API key.
//
// GEOGRAPHY IS PART OF THE LEASE. A pool entry carries a caller-ID number that
// lives in one country, and a number that cannot reach the merchant's shoppers
// is functionally a broken install: an Indian DID dialling a North-American
// mobile is routinely blocked or spam-filtered, and "send a test call" is the
// most prominent button in the app. So the lease resolves the shop's own country
// from Shopify first and asks the pool to prefer a matching entry. It is a
// PREFERENCE and never a precondition — a working foreign number beats a 503,
// and refusing to lease would turn a degraded call into no app at all. The two
// outcomes need different operator actions, so they log differently: "mint a
// number in XX" (preference unmet, free inventory exists) versus "mint anything
// at all" (true exhaustion). See leaseFromPool() and reportExhaustion().
//
// …AND THE COUNTRY OUTLIVES THE LEASE, so it has to be backfilled. The lease is
// the only moment geography can influence WHICH workspace a shop gets, but the
// resolved country is written to `settings.shopCountry`, and that row is what
// every dialling path reads afterwards — extractPhone()/toE164() completing a
// shopper's local number, the test-call example, the wizard hints. A shop that
// was already holding a workspace when this shipped never leases again, and a
// fresh install whose 4s lookup timed out never leases again either, so for both
// of them `shopCountry` would stay null FOREVER and every automated call would
// fall through to DEFAULT_PHONE_COUNTRY — the process-wide constant this whole
// change exists to stop trusting. The existing-key path therefore backfills it.
// Fire-and-forget, because nothing on that path consumes the value in the same
// tick (placeCall() reads its settings row before it awaits ensureWorkspace, so
// even an awaited backfill would land one call late) and blocking a page load on
// an enrichment is the trade this file already refuses to make at lease time.
// See backfillShopCountry().
//
// METERING IS PART OF PROVISIONING, NOT A FOLLOW-UP CHORE. Minutes are counted
// in exactly one place — usage.addMinutes(), reached only from a Telenow
// `call.ended` delivery — and the only thing that makes those deliveries happen
// is the result hook this file registers. A workspace handed out without one
// places calls that are never counted: checkAccess()'s Starter ceiling never
// fires because usedMinutes stays 0 forever, and on a paid plan reportUsage() is
// never reached, so overage is never billed. Nothing reconciles it afterwards.
// A key is therefore only returned once metering is wired, and the wiring is
// re-attempted on every request until it is. See ensureMetering().
//
// SECURITY: never log a `vai_live_…` key. Log the workspace ref instead — that
// is what the operator needs to find the entry, and it is not a credential.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getSettings, updateSettings } from './settings.js';
import { leaseKey, releaseKey, markKeyDead, keypoolStatus, getHook, deleteHook } from './store.js';
import { TelenowClient } from './telenow.js';
import { ensureTelenowHook } from './webhooks/telenow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * How long a leased key is trusted before we re-check it with `me()`.
 *
 * The re-check is what self-heals a `store.json` whose uninstall webhook was
 * lost: the workspace was revoked on the Telenow side, the shop still holds the
 * key, and the next validation swaps it. Once a day is enough for that and keeps
 * `me()` off the hot path — ensureWorkspace() runs on effectively every /api/*
 * request.
 */
const VALIDATE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Revalidation runs inside a merchant-facing request, so it gets a much shorter
 * timeout than the client's 20s default. A slow Telenow must cost the admin UI a
 * few seconds, not twenty.
 */
const VALIDATE_TIMEOUT_MS = 8_000;

/**
 * How long to wait before re-attempting a hook registration that just failed.
 *
 * Without this, a shop stuck in the unmetered state would fire a full
 * listHooks/deleteHook/createHook sequence on every /api/* request — five or six
 * per page load — and turn one Telenow hiccup into a self-inflicted flood
 * against the very endpoint that has to recover. Short enough that a merchant
 * who reloads after reading "reload to retry" gets a genuine attempt.
 */
const METERING_RETRY_COOLDOWN_MS = 30_000;

/**
 * How long the shop-country lookup may hold up a lease.
 *
 * The lease happens inside a merchant-facing request on the very first page load
 * of a fresh install, and the country is an OPTIMISATION — it picks a better
 * entry out of the pool, it does not decide whether the shop gets one. Waiting
 * on a slow Admin API for the app's whole default timeout would trade a working
 * install for a nicer caller ID. Four seconds is generous for a single GraphQL
 * field; past that we lease uncountried and the next install for that shop reads
 * the value from settings anyway.
 */
const SHOP_COUNTRY_TIMEOUT_MS = 4_000;

/**
 * How long before a shop-country BACKFILL that came back empty is attempted again.
 *
 * getShopCountry() write-through caches a success and deliberately does not cache
 * a failure — a revoked token or a Shopify 5xx must not pin a shop to "unknown"
 * forever. That is right for the value and wrong for the retry: with no cooldown,
 * every shop whose lookup cannot succeed would fire one Admin GraphQL query per
 * /api/* request, five or six per page load, for as long as it stays broken. The
 * two real failure modes want opposite things — an outage clears in minutes, a
 * revoked offline session never clears until the merchant reinstalls — so the
 * interval is short enough that a store installed during a blip is corrected
 * within the hour, and long enough that a permanently unresolvable shop costs
 * four queries a day rather than thousands.
 */
const SHOP_COUNTRY_BACKFILL_COOLDOWN_MS = 15 * 60 * 1000;

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '..', 'data');

const POOL_FILE = path.join(DATA_DIR, 'keypool.json');

// ─────────────────────────────────────────────────────────────────────────────
// Module state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-flight leases, keyed by shop.
 *
 * The embedded app fires five or six /api/* calls the moment it boots, and each
 * one calls ensureWorkspace(). Without this map a fresh install burns five pool
 * entries in the same tick — the pool is 30 wide, so that is the difference
 * between six installs and thirty. Everyone awaits the first promise; the entry
 * is dropped in a `finally` so a failed lease is retried on the next request
 * rather than being cached as a permanent failure.
 *
 * @type {Map<string, Promise<string|null>>}
 */
const inFlight = new Map();

/** The partner seam logs once per process, not once per request (see below). */
let partnerSeamLogged = false;

/**
 * The shop-country seam logs once per process too.
 *
 * It covers only the failures resolveShopCountry() sees as a THROW: the dynamic
 * import not resolving, getShopCountry() not being exported, or the lookup losing
 * the SHOP_COUNTRY_TIMEOUT_MS race. All three are instance-wide conditions, so a
 * line per shop would say the same thing hundreds of times over. A lookup that
 * merely comes back empty is not routed here at all — getShopCountry() never
 * throws and logs its own per-shop warning, which is the right granularity for a
 * problem that is usually one store's revoked token.
 */
let shopCountrySeamLogged = false;

/**
 * Shops whose last hook registration failed, and when. Read by ensureMetering()
 * to space out retries; cleared the moment one succeeds. In-memory on purpose —
 * a restart should retry immediately, since a restart is the most likely thing
 * an operator does after noticing the outage.
 *
 * @type {Map<string, number>}
 */
const meteringFailedAt = new Map();

/**
 * Shops whose last country BACKFILL attempt did not produce an answer, and when.
 * Read by backfillShopCountry() to space out retries; the entry is dropped the
 * moment one resolves, and again on release so a reinstall is tried immediately.
 *
 * In-memory rather than on the settings row on purpose. This is a rate limiter,
 * not a fact about the store: persisting it would survive the deploy that fixed
 * whatever was broken, and a restart is the most likely thing an operator does
 * after noticing that no shop is resolving a country.
 *
 * @type {Map<string, number>}
 */
const shopCountryAttemptedAt = new Map();

/** Memoised result of readPoolSource(); see that function for why it is a diagnostic. */
let poolSourceCache = null;

// ─────────────────────────────────────────────────────────────────────────────
// Pool source
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the operator-seeded pool definition: TELENOW_KEY_POOL (a JSON array), or
 * ${DATA_DIR}/keypool.json when the env var is unset.
 *
 * This is a DIAGNOSTIC, not a second leasing path. Leasing belongs to
 * store.js/leaseKey(), which owns the persisted lease state in `db.keypool`;
 * popping an entry here as well would hand the same workspace to two shops. What
 * this buys is the ability to say *why* a lease failed — "the env var holds
 * malformed JSON", "the file has 30 entries but the store sees 0 free" — which
 * is otherwise a silent 503 that an operator cannot diagnose from the logs.
 *
 * Parsing is deliberately total: a malformed pool logs and reads as empty. A
 * typo in an env var must never crash the boot of an app that is already paused.
 *
 * @returns {{ source: 'env'|'file'|'none', count: number, refs: string[], error: string|null }}
 */
function readPoolSource() {
  if (poolSourceCache) return poolSourceCache;

  let source = 'none';
  let raw = null;
  try {
    if (process.env.TELENOW_KEY_POOL) {
      source = 'env';
      raw = process.env.TELENOW_KEY_POOL;
    } else if (fs.existsSync(POOL_FILE)) {
      source = 'file';
      raw = fs.readFileSync(POOL_FILE, 'utf8');
    }
  } catch (err) {
    poolSourceCache = { source, count: 0, refs: [], error: `unreadable: ${err.message}` };
    console.error(`[provisioning] key pool ${source} unreadable: ${err.message}`);
    return poolSourceCache;
  }

  if (!raw) {
    poolSourceCache = { source: 'none', count: 0, refs: [], error: null };
    return poolSourceCache;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Never echo `raw` — it is a list of live credentials.
    poolSourceCache = { source, count: 0, refs: [], error: `invalid JSON: ${err.message}` };
    console.error(`[provisioning] key pool (${source}) is not valid JSON: ${err.message}`);
    console.error('[provisioning] treating the pool as EMPTY — every shop will get 503 until fixed.');
    return poolSourceCache;
  }

  if (!Array.isArray(parsed)) {
    poolSourceCache = { source, count: 0, refs: [], error: 'not an array' };
    console.error(`[provisioning] key pool (${source}) is not a JSON array — treating as EMPTY.`);
    return poolSourceCache;
  }

  const refs = [];
  let malformed = 0;
  for (const entry of parsed) {
    const ref = entry && typeof entry.ref === 'string' ? entry.ref.trim() : '';
    const apiKey = entry && typeof entry.apiKey === 'string' ? entry.apiKey.trim() : '';
    if (ref && apiKey) refs.push(ref);
    else malformed++;
  }
  if (malformed) {
    console.error(`[provisioning] key pool (${source}): ${malformed} entr${malformed === 1 ? 'y' : 'ies'} ` +
      'missing ref or apiKey — those are ignored.');
  }

  poolSourceCache = { source, count: refs.length, refs, error: null };
  return poolSourceCache;
}

// ─────────────────────────────────────────────────────────────────────────────
// ensureWorkspace
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one call every route makes before it needs Telenow.
 *
 * Idempotent and cheap on the happy path: a shop with a key validated in the
 * last 24h gets it back with no network call at all. Safe to call per request.
 *
 * @param {string} shop
 * @returns {Promise<string|null>} the shop's `vai_live_…` key, or null when the
 *   pool is exhausted or the workspace is not yet metered. Null means 503
 *   (retry), never a paywall — the merchant has not failed to pay, we have
 *   failed to finish provisioning.
 */
export async function ensureWorkspace(shop) {
  if (!shop) return null;

  const pending = inFlight.get(shop);
  if (pending) return pending;

  const promise = provisionOnce(shop).finally(() => inFlight.delete(shop));
  inFlight.set(shop, promise);
  return promise;
}

/**
 * The body of ensureWorkspace, serialised per shop by the in-flight map above.
 *
 * Two steps, and the second one can veto the first: find the shop's key, then
 * refuse to hand it out until call results are being delivered back to us. The
 * veto lives here rather than at each of the three places a key is produced so
 * that no future path can acquire a key and skip the gate.
 *
 * @param {string} shop
 * @returns {Promise<string|null>}
 */
async function provisionOnce(shop) {
  const { key, verify } = await resolveKey(shop);
  if (!key) return null;

  if (!(await ensureMetering(shop, verify))) {
    // The shop keeps its lease — the key is good, it is our result hook that is
    // missing — so this costs no pool inventory and the next request retries.
    // Answering 503 here is the honest reading of the state: we have not
    // finished setting the workspace up. The alternative, returning the key
    // anyway, is a shop placing calls that are never counted and never billed.
    return null;
  }
  return key;
}

/**
 * Find the key this shop should be calling with, leasing or minting one if it
 * has none.
 *
 * `verify` asks ensureMetering() to re-confirm the hook against Telenow rather
 * than trusting the stored record. It is set only on the daily revalidation,
 * where we are already paying for a round-trip and can afford to notice that
 * the subscription was deleted upstream.
 *
 * @param {string} shop
 * @returns {Promise<{ key: string|null, verify: boolean }>}
 */
async function resolveKey(shop) {
  const settings = getSettings(shop);
  const existing = String(settings.telenowApiKey || '');
  // Captured before revalidation, because discarding a dead key clears the ref
  // from settings and leaseFromPool() needs it to refuse the same entry back.
  const priorRef = settings.telenowWorkspaceRef || null;

  // A key this shop pasted under the OLD build is not ours to keep using.
  //
  // Before the Shopify Billing work, merchants signed up on telenow.ai and
  // pasted their own vai_live_ key; those rows have telenowApiKey set and no
  // telenowKeySource (getSettings merges defaults UNDER stored values, so it
  // reads back 'none'). Left alone, the branch below would revalidate that key,
  // get 'ok', and hand it back forever — the shop would keep paying telenow.ai
  // directly AND carry a Shopify subscription on top. That is a live 1.2.1
  // violation on a Shopify-origin merchant, and it is exactly what a reviewer
  // would hit if they installed on a store that had used the old build.
  //
  // Dropping the key here is safe and reversible: the merchant's own workspace
  // is untouched upstream, and they fall through to a pool lease like any new
  // install. Their old agents stop appearing, which is the correct signal that
  // the tenancy moved — silently billing them twice is not.
  if (existing && (settings.telenowKeySource || 'none') === 'none') {
    console.warn(
      `[provisioning] shop=${shop} carries a merchant-supplied key from the pre-billing ` +
        'build; dropping it and leasing an app-owned workspace instead.',
    );
    updateSettings(shop, {
      telenowApiKey: '',
      telenowWorkspaceRef: null,
      telenowLeasedAt: null,
      telenowKeySource: 'none',
    });
    return { key: await leaseFromPool(shop, null), verify: false };
  }

  if (existing) {
    // Every path below that KEEPS the key is a path that will never lease again,
    // and leasing is the only other place a shop's country is ever resolved. So
    // this is the one hook the existing install base has; see
    // backfillShopCountry() for why it is fired rather than awaited. It is
    // skipped on the 'dead' verdict alone, where the fall-through leases and
    // resolveShopCountry() runs for real — firing here as well would put two
    // Admin queries in flight for the same shop in the same tick.
    const fresh = validatedWithinTtl(settings);
    if (fresh) {
      backfillShopCountry(shop);
      return { key: existing, verify: false };
    }

    const verdict = await revalidate(shop, existing);
    if (verdict !== 'dead') backfillShopCountry(shop);
    if (verdict === 'ok') return { key: existing, verify: true };
    if (verdict === 'unknown') {
      // A timeout or a 500 from Telenow says nothing about this key. Burning a
      // fresh pool entry on every request during an upstream outage would drain
      // 30 workspaces in minutes and leave the shops that had working keys with
      // nothing. Keep the key, skip the stamp, re-check on the next request —
      // and do not spend that same broken round-trip re-verifying the hook.
      return { key: existing, verify: false };
    }
    // 'dead' — the key was rejected. discardDeadKey() has already marked the
    // pool entry and cleared the shop's settings; fall through and lease a new
    // one so a lost uninstall webhook heals itself instead of stranding a store.
  }

  const partnerKey = await tryPartnerProvision(shop);
  if (partnerKey) return { key: partnerKey, verify: false };

  return { key: await leaseFromPool(shop, priorRef), verify: false };
}

/** True when `me()` confirmed this key inside VALIDATE_TTL_MS. */
function validatedWithinTtl(settings) {
  // telenowLeasedAt covers the moment right after a lease, when the key has been
  // proven by ensureTelenowHook()'s own round-trip but no validation stamp has
  // been written yet.
  const stamp = settings.telenowValidatedAt || settings.telenowLeasedAt;
  if (!stamp) return false;
  const at = new Date(stamp).getTime();
  if (!Number.isFinite(at)) return false;
  return Date.now() - at < VALIDATE_TTL_MS;
}

/**
 * Re-check a held key against Telenow.
 * @returns {Promise<'ok'|'dead'|'unknown'>} — 'dead' only for an explicit
 *   authentication rejection, so that transient upstream failures cannot
 *   de-provision the whole tenant base.
 */
async function revalidate(shop, key) {
  try {
    const client = new TelenowClient(key, { timeoutMs: VALIDATE_TIMEOUT_MS });
    await client.me();
    updateSettings(shop, { telenowValidatedAt: new Date().toISOString() });
    return 'ok';
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) {
      discardDeadKey(shop, err.status);
      return 'dead';
    }
    console.error(`[provisioning] could not validate workspace for ${shop} (keeping it): ${err.message}`);
    return 'unknown';
  }
}

/**
 * Retire a key Telenow no longer accepts: mark the pool entry dead so no future
 * lease hands it out, and clear it from the shop so nothing tries to call with
 * it while we lease a replacement.
 */
function discardDeadKey(shop, status) {
  const settings = getSettings(shop);
  const ref = settings.telenowWorkspaceRef || null;
  if (ref) {
    try {
      markKeyDead(ref);
    } catch (err) {
      console.error(`[provisioning] markKeyDead(${ref}) failed: ${err.message}`);
    }
  }
  console.error(`[provisioning] workspace ${ref || '(no ref)'} for ${shop} rejected with ${status} — ` +
    'retiring it and leasing a replacement.');
  // The hook lived inside the workspace that just rejected us, so its record is
  // now a lie about being metered. See forgetHook().
  forgetHook(shop);
  updateSettings(shop, {
    telenowApiKey: '',
    telenowKeySource: 'none',
    telenowWorkspaceRef: null,
    telenowLeasedAt: null,
    telenowValidatedAt: null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Partner provisioning — the v1.1 seam
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mint a workspace through Telenow's partner API instead of leasing one.
 *
 * NOT IMPLEMENTED IN v1, on purpose. The API below does not exist yet, and
 * waiting for it would put the resubmission date under another team's control
 * while the app sits paused. The branch is written so that v1.1 is a change to
 * `src/telenow.js` alone — the stubs there start throwing real requests instead
 * of NotImplemented — with no change to any caller of ensureWorkspace().
 *
 * THE CONTRACT `telenow.provisionWorkspace()` MUST SATISFY, from the spec.
 * Base `${TELENOW_API_BASE}` (default https://api.telenow.ai); auth on every
 * call is the header `X-Partner-Key: tnp_live_…`, a credential class distinct
 * from `vai_live_` and scoped to workspace lifecycle only, never to placing
 * calls. Idempotent on `externalId`:
 *
 *   POST /api/v1/partner/workspaces
 *   { externalId: "acme.myshopify.com", name: "Acme Store (Shopify)",
 *     plan: "growth", monthlySpendCapUsd: 220, countryHint: "IN",
 *     metadata: { platform: "shopify", shopifySubscriptionId: "gid://…" } }
 *
 *   201 { workspaceId, apiKey, number: { id, e164, country } }
 *   409 { error: "already_exists", workspaceId, apiKey }   ← apiKey REQUIRED here,
 *        or a retry after a lost response strands the shop with no credential.
 *   422 { error: "no_numbers_available", workspaceId, apiKey }  ← still usable
 *        for web calls; the number is claimed later.
 *
 * The counterpart teardown is DELETE /api/v1/partner/workspaces/{workspaceId},
 * called from releaseWorkspace() below; 404 counts as success.
 *
 * The import is dynamic because those stubs land in src/telenow.js on a
 * different schedule than this file, and a static named import of an export that
 * does not exist yet is a link-time failure that takes the whole server down —
 * an unacceptable trade for a branch that is inert in v1.
 *
 * @returns {Promise<string|null>} the minted key, or null to fall through to the pool.
 */
async function tryPartnerProvision(shop) {
  if (!process.env.TELENOW_PARTNER_KEY) return null;

  try {
    const telenow = await import('./telenow.js');
    if (typeof telenow.provisionWorkspace !== 'function') {
      throw new Error('NotImplemented: telenow.provisionWorkspace');
    }

    const settings = getSettings(shop);
    const billing = settings.billing || {};
    // countryHint is part of the contract above and was missing: without it every
    // minted workspace gets a number in whatever the upstream default country is,
    // which is the same reviewer-geography defect the pool path just fixed —
    // except minting is irreversible, so it would ship a wrong number per install.
    // Omitted (rather than guessed) when the shop's country is unknown.
    const countryHint = await resolveShopCountry(shop);
    const result = await telenow.provisionWorkspace({
      externalId: shop,
      name: `${shop.replace('.myshopify.com', '')} (Shopify)`,
      plan: billing.plan || 'starter',
      monthlySpendCapUsd: Number(billing.capUsd) || 0,
      ...(countryHint ? { countryHint } : {}),
      metadata: { platform: 'shopify', shopifySubscriptionId: billing.subscriptionId || null },
    });

    const apiKey = result?.apiKey ? String(result.apiKey) : '';
    if (!apiKey) throw new Error('partner provisioning returned no apiKey');

    const provider = normaliseProvider(result?.number?.provider);
    const country = normaliseCountry(result?.number?.country);

    updateSettings(shop, {
      telenowApiKey: apiKey,
      telenowKeySource: 'partner',
      telenowWorkspaceRef: result.workspaceId || null,
      telenowLeasedAt: new Date().toISOString(),
      telenowValidatedAt: new Date().toISOString(),
      telenowNumberE164: result?.number?.e164 || null,
      telenowNumberId: result?.number?.id || null,
      telenowNumberProvider: provider,
      telenowNumberCountry: country,
    });
    forgetHook(shop);
    console.log(`[provisioning] ${shop} provisioned workspace ${result.workspaceId || '(unknown ref)'} ` +
      `via partner API — number ${result?.number?.e164 || '(none attached)'} ` +
      `provider=${provider || 'unknown'} country=${country || 'unknown'}; ` +
      `shop country=${countryHint || 'unknown'}`);
    if (countryHint && country && country !== countryHint) {
      console.warn(`[provisioning] COUNTRY PREFERENCE UNMET for ${shop}: asked the partner API for ` +
        `${countryHint}, got ${country}.`);
    }
    return apiKey;
  } catch (err) {
    // Expected in v1 — the stubs throw NotImplemented. Log it once per process:
    // this runs on every request for every shop, and a per-request line would
    // bury the failures that matter.
    if (!partnerSeamLogged) {
      partnerSeamLogged = true;
      console.warn(`[provisioning] TELENOW_PARTNER_KEY is set but partner provisioning is unavailable ` +
        `(${err.message}) — falling back to the key pool for all shops.`);
    }
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shop country
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ISO-3166-1 alpha-2, uppercase, or null for anything that is not one.
 *
 * The platform's own `country_iso` column is VARCHAR(64) and Plivo writes a full
 * country NAME into it ("United States"), so a value arriving from a pool seed or
 * from upstream is not guaranteed to be a code. Anything that is not exactly two
 * letters is treated as UNKNOWN rather than half-parsed: an unknown country makes
 * the lease fall back to any free entry, while a wrong one would confidently pick
 * the wrong continent.
 */
function normaliseCountry(value) {
  const iso = String(value ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(iso) ? iso : null;
}

/** Platform provider ids are lowercase ('plivo', 'twilio', 'sip', …). */
function normaliseProvider(value) {
  const id = String(value ?? '').trim().toLowerCase();
  return id || null;
}

/**
 * Resolve a promise, or give up on it after `ms`.
 *
 * Deliberately does NOT cancel the underlying work — there is nothing to cancel a
 * fetch with here, and the point is only that the LEASE stops waiting. A late
 * answer is simply discarded; the next install re-reads it from settings.
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * The shop's own country, for picking a caller ID that can actually reach its
 * shoppers.
 *
 * Cached on the settings row (`settings.shopCountry`) because it is a property of
 * the store, not of the request: it changes approximately never, and a lease is
 * already the slowest thing on a first page load. NEVER GUESSED — a wrong country
 * is worse than no country, because "no country" degrades to today's behaviour
 * (first free entry) while a wrong one actively steers the merchant onto the
 * wrong continent's number and looks deliberate in the logs.
 *
 * Total by construction. Every failure — no offline session, a 5xx from Shopify,
 * a slow Admin API, or src/shopify.js not exporting getShopCountry() yet — returns
 * null and lets the lease proceed uncountried. The import is dynamic for the same
 * reason tryPartnerProvision()'s is: a static named import of an export that has
 * not landed yet is a link-time failure that takes the whole server down, which is
 * an absurd price for a preference.
 *
 * @param {string} shop
 * @returns {Promise<string|null>} ISO-2 uppercase, or null when unknown
 */
async function resolveShopCountry(shop) {
  if (!shop) return null;

  let cached = null;
  try {
    cached = normaliseCountry(getSettings(shop).shopCountry);
  } catch (err) {
    console.error(`[provisioning] could not read settings for ${shop}: ${err.message}`);
  }
  if (cached) return cached;

  let iso = null;
  try {
    const shopifyModule = await import('./shopify.js');
    if (typeof shopifyModule.getShopCountry !== 'function') {
      throw new Error('NotImplemented: shopify.getShopCountry');
    }
    iso = normaliseCountry(await withTimeout(shopifyModule.getShopCountry(shop), SHOP_COUNTRY_TIMEOUT_MS));
  } catch (err) {
    if (!shopCountrySeamLogged) {
      shopCountrySeamLogged = true;
      console.warn(`[provisioning] could not resolve a shop country (${err.message}) — leases will fall ` +
        'back to any free pool entry, which may put a merchant on a foreign caller ID.');
    }
    return null;
  }

  if (iso) {
    try {
      updateSettings(shop, { shopCountry: iso });
    } catch (err) {
      // Not fatal: we still have the value for THIS lease, we just pay for the
      // lookup again on the next one.
      console.error(`[provisioning] could not cache shopCountry for ${shop}: ${err.message}`);
    }
  }
  return iso;
}

/**
 * Fill in `settings.shopCountry` for a shop that already holds a workspace.
 *
 * THE LEASE IS NOT ENOUGH, and this is the whole reason this function exists.
 * resolveShopCountry() is reached from exactly two places — leaseFromPool() and
 * the partner seam — and neither runs again once a shop has a key: resolveKey()
 * short-circuits on the existing key and returns. So the country is resolved on
 * the one request in a shop's entire lifetime that leases, and if that request
 * does not resolve it, nothing else ever will. Two ordinary situations land
 * there permanently:
 *
 *   - every store that installed BEFORE this change shipped. It already holds a
 *     workspace, so it never leases again, so it never resolves a country;
 *   - any fresh install whose lookup lost the 4s race at lease time, which is a
 *     race we deliberately set up to lose in favour of finishing the install.
 *
 * For those shops `shopCountry` stays null forever, and every automated call
 * falls through resolveCountry() to DEFAULT_PHONE_COUNTRY — the single
 * process-wide constant that is wrong for all but one of the merchants on this
 * server, and whose historical value is 'IN'. A Toronto shopper's local number
 * completed to +91 is still well-formed E.164, so it reaches the carrier and
 * simply never connects, with no error anywhere. That is the exact defect the
 * per-shop country was introduced to remove, arriving by the back door for the
 * entire existing install base.
 *
 * DELIBERATELY NOT AWAITED. Two reasons, and the second is the load-bearing one:
 *  - resolveKey() sits on the hot path (ensureWorkspace() runs on effectively
 *    every /api/* request), and this is an enrichment. Blocking a merchant's
 *    page load for up to SHOP_COUNTRY_TIMEOUT_MS to improve the NEXT call is the
 *    same trade leaseFromPool() already caps for the install itself.
 *  - awaiting would not help any current reader anyway. placeCall() in
 *    automations/_base.js reads its settings row BEFORE it awaits
 *    ensureWorkspace(), so it holds a snapshot taken earlier in the tick and
 *    would not observe the write even if we finished it first; server.js's
 *    dialCountryFor() does its own lookup. The value is for the next call, and
 *    the next call is where it lands either way.
 *
 * Total by construction — it is called for its side effect and returns nothing.
 * resolveShopCountry() already swallows every failure, and the `.catch()` below
 * is the belt to that braces: an unhandled rejection escaping a background
 * promise on the request path would be a process-level crash risk in exchange
 * for a caller-ID nicety.
 *
 * @param {string} shop
 * @returns {void}
 */
function backfillShopCountry(shop) {
  if (!shop) return;

  // The cheap read first: a shop that already has a country costs nothing beyond
  // a settings lookup that resolveKey() has just done anyway, which matters
  // because this runs on every request of every shop that is working normally.
  try {
    if (normaliseCountry(getSettings(shop).shopCountry)) return;
  } catch {
    // A settings row we cannot read is not a shop we can backfill. resolveKey()
    // will have logged the real problem.
    return;
  }

  const attemptedAt = shopCountryAttemptedAt.get(shop) || 0;
  if (Date.now() - attemptedAt < SHOP_COUNTRY_BACKFILL_COOLDOWN_MS) return;
  // Stamped BEFORE the await, not after it. The stamp is what stops the five or
  // six parallel /api/* calls of one page load from each starting their own
  // Admin query; setting it in the continuation would let all of them through.
  shopCountryAttemptedAt.set(shop, Date.now());

  Promise.resolve()
    .then(() => resolveShopCountry(shop))
    .then((iso) => {
      if (!iso) return;
      shopCountryAttemptedAt.delete(shop);
      // Once per shop, ever — the write means the next attempt short-circuits on
      // the cached value. Worth a line: it is how an operator watching a deploy
      // sees the existing install base being corrected, shop by shop.
      console.log(`[provisioning] backfilled shop country for ${shop}: ${iso} — its workspace was ` +
        'leased before the country was recorded, so calls were being dialled against the ' +
        'instance-wide default until now.');
    })
    .catch((err) => {
      console.error(`[provisioning] shop-country backfill for ${shop} failed: ${err.message}`);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pool leasing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Take the next free workspace from the pool and bind it to this shop.
 *
 * The country is resolved BEFORE the lease and passed as a preference, because
 * the choice of entry is the only moment we can influence which country the
 * merchant's caller ID lives in — after the lease the number is whatever the
 * operator attached to that workspace, and swapping it means releasing the
 * workspace, which quarantines it and costs a merchant their data.
 *
 * `preferCountry` is advisory all the way down: leaseKey() prefers a match and
 * falls back to any free entry, and this function never refuses a lease over a
 * mismatch. A US merchant on an Indian number can still take browser calls,
 * publish agents and be billed; a US merchant with no workspace at all sees a
 * 503 on every screen.
 *
 * @param {string} shop
 * @param {string|null} avoidRef  a ref this shop just retired, if any
 * @returns {Promise<string|null>}
 */
async function leaseFromPool(shop, avoidRef = null) {
  const preferCountry = await resolveShopCountry(shop);

  let entry = null;
  try {
    // The options object is additive: a leaseKey() that does not read it still
    // returns the first free entry, which is exactly today's behaviour.
    entry = leaseKey(shop, { preferCountry });
  } catch (err) {
    console.error(`[provisioning] leaseKey failed for ${shop}: ${err.message}`);
    return null;
  }

  if (!entry?.apiKey) {
    reportExhaustion(shop, preferCountry);
    return null;
  }

  // Guard against handing back the very entry we just retired. If the store ever
  // returns a dead lease (a stale db.keypool row for this shop), treating it as a
  // fresh lease would spin: validate → 401 → retire → lease the same one again.
  if (avoidRef && entry.ref === avoidRef) {
    console.error(`[provisioning] pool returned the retired entry ${entry.ref} for ${shop} — ` +
      'refusing it; treating the pool as exhausted for this request.');
    return null;
  }

  // Both spellings are accepted from the seed (`provider`/`country` and
  // `numberProvider`/`numberCountry`) so an operator's existing keypool.json does
  // not have to be rewritten to gain the fields; store.js normalises, and this is
  // the belt to that braces.
  const provider = normaliseProvider(entry.provider ?? entry.numberProvider);
  const country = normaliseCountry(entry.country ?? entry.numberCountry);

  updateSettings(shop, {
    telenowApiKey: String(entry.apiKey),
    telenowKeySource: 'pool',
    telenowWorkspaceRef: entry.ref || null,
    telenowLeasedAt: new Date().toISOString(),
    telenowValidatedAt: null,
    telenowNumberE164: entry.numberE164 || null,
    telenowNumberId: entry.numberId || null,
    // Not secrets, unlike the key beside them: these are what the UI renders next
    // to the number and what support reads when a merchant says calls are not
    // connecting. Persisted rather than re-derived, because /api/v1/numbers lists
    // the whole leased workspace and cannot say which row is THIS shop's lease.
    telenowNumberProvider: provider,
    telenowNumberCountry: country,
  });
  forgetHook(shop);
  console.log(`[provisioning] leased workspace ${entry.ref || '(no ref)'} to ${shop} — number ` +
    `${entry.numberE164 || '(none attached)'} provider=${provider || 'unknown'} ` +
    `country=${country || 'unknown'}; shop country=${preferCountry || 'unknown'}`);

  // Distinct from exhaustion ON PURPOSE. Exhaustion means "mint more workspaces";
  // this means "there IS free inventory, it is just in the wrong country" — a
  // different purchase and a different urgency. During a Shopify review this is
  // the line that says, before any merchant complains, that the North-American
  // reviewer was handed a number that cannot reliably ring their own mobile.
  if (preferCountry && country !== preferCountry) {
    console.warn(`[provisioning] COUNTRY PREFERENCE UNMET for ${shop}: wanted ${preferCountry}, leased ` +
      `${entry.ref || '(no ref)'} which is ${country || 'of unknown country'}. The shop is working, but ` +
      `outbound calls to ${preferCountry} may be blocked or spam-filtered — seed pool entries whose ` +
      `number is in ${preferCountry}. (This is NOT pool exhaustion.)`);
  }

  return String(entry.apiKey);
}

/**
 * Drop the stored hook record because the workspace behind it just changed.
 *
 * The record is (id, signing secret) for a subscription that lives inside one
 * Telenow workspace. Once this shop is pointed at a different workspace the
 * record describes something that can no longer deliver to us, and leaving it in
 * place is worse than useless: hasMeteringRecord() below would read it as proof
 * that metering is wired and skip the registration the new workspace needs.
 * ensureTelenowHook() would then never run again, and the shop would call
 * unmetered forever with a green light in the store.
 *
 * The retry cooldown goes with it. It was earned by a different workspace, and
 * making a shop that has just been handed a brand-new one sit out the remainder
 * of it would add 30s of 503 to a request that could have succeeded immediately.
 */
function forgetHook(shop) {
  meteringFailedAt.delete(shop);
  try {
    deleteHook(shop);
  } catch (err) {
    console.error(`[provisioning] could not clear the stale hook record for ${shop}: ${err.message}`);
  }
}

/** True when we hold a usable hook record — an id we created and a secret we can verify with. */
function hasMeteringRecord(shop) {
  try {
    const hook = getHook(shop);
    return Boolean(hook?.id && hook?.secret);
  } catch (err) {
    console.error(`[provisioning] could not read the hook record for ${shop}: ${err.message}`);
    return false;
  }
}

/**
 * Guarantee that this shop's call results come back to us, because that is the
 * only thing that makes its minutes countable.
 *
 * The old version of this was best-effort and swallowed the failure, on the
 * reasoning that a hook problem should not cost a shop with a good key its
 * dashboard. That reasoning missed where the hook sits in the billing chain:
 * `call.ended` is the sole trigger for usage.addMinutes(), so a shop with no
 * hook accrues zero recorded minutes no matter how much it calls. The Starter
 * ceiling in checkAccess() (usedMinutes >= includedMinutes) then never trips —
 * unlimited free calls at our cost — and a paid shop never reaches reportUsage()
 * so its overage is never charged. Nothing downstream reconciles it: no sweep
 * pages listCalls() to recover unmetered sessions. One 500 from Telenow at lease
 * time was enough, and the only trace was a single console line.
 *
 * So it is a precondition now, with two deliberate limits on how hard it bites:
 *
 *  - It is retried on EVERY request until it succeeds, which is the half of this
 *    the old code was actually missing. The comment claimed "the next request
 *    retries it", but validatedWithinTtl() short-circuits before any of this
 *    runs, and revalidate() only calls me() — so the hook was in truth attempted
 *    exactly once per lease, ever, and provisioning.js is the only caller of
 *    ensureTelenowHook() left in the codebase. Nothing else would have fixed it.
 *  - When we already hold a hook record and are merely re-verifying it on the
 *    daily cycle, a failure is tolerated. The record means the subscription was
 *    created and deliveries are presumably arriving; taking working shops
 *    offline because Telenow's hook API is briefly unreachable would be the same
 *    mistake revalidate() already refuses to make with keys.
 *
 * @param {string} shop
 * @param {boolean} verify  re-confirm against Telenow instead of trusting the record
 * @returns {Promise<boolean>} false means "not wired" — the caller must withhold
 *   the key and let the request become a 503, never a paywall.
 */
async function ensureMetering(shop, verify = false) {
  const known = hasMeteringRecord(shop);
  if (known && !verify) return true;

  // A failure while a record exists is a re-verification failure: keep serving.
  // A failure with no record at all means this shop genuinely cannot be metered.
  const tolerant = known;

  if (!tolerant) {
    const failedAt = meteringFailedAt.get(shop) || 0;
    if (Date.now() - failedAt < METERING_RETRY_COOLDOWN_MS) return false;
  }

  try {
    await ensureTelenowHook(shop);
    meteringFailedAt.delete(shop);
  } catch (err) {
    meteringFailedAt.set(shop, Date.now());
    if (tolerant) {
      console.error(`[provisioning] could not re-verify the result hook for ${shop} ` +
        `(keeping the existing one): ${err.message}`);
      return true;
    }
    console.error(`[provisioning] NO RESULT HOOK for ${shop}: ${err.message} — withholding the ` +
      'workspace (503) rather than letting this shop place calls that are never counted or billed.');
    return false;
  }

  // TODO(server.js): also call connectShopifyIntegration(shop, client) here —
  // it wires this shop's Admin API token into the leased Telenow workspace so an
  // agent can look orders up mid-call. It is a module-private function in
  // src/server.js (~line 440), and server.js imports THIS file, so importing it
  // back would close an import cycle. Export it from a neutral module (or move
  // it into src/telenow.js) and call it from here; until then the connector is
  // wired by the existing paths in server.js, and a shop whose connector is
  // missing still places calls, it just cannot look the store up mid-call.
  return true;
}

/**
 * The pool ran dry (or was never seeded). Say so loudly and precisely enough
 * that the operator knows which of the two it is — the merchant only ever sees
 * "setting up your calling workspace, reload to retry".
 *
 * This is TRUE exhaustion: not one free entry, in any country. The country the
 * shop wanted is reported as context only, so that a refill can be aimed, but it
 * is never the cause here — a country preference that could not be met still
 * produces a lease, and logs its own separate line in leaseFromPool().
 *
 * @param {string} shop
 * @param {string|null} [preferCountry]  the ISO-2 the lease asked for, if known
 */
function reportExhaustion(shop, preferCountry = null) {
  const src = readPoolSource();
  const status = poolStatus();
  console.error(`[provisioning] NO FREE WORKSPACE for ${shop} — this shop is answering 503 until the pool is refilled.`);
  if (preferCountry) {
    console.error(`[provisioning] this shop is in ${preferCountry}; a ${preferCountry} number is the one ` +
      'to mint first, but ANY free workspace unblocks it.');
  }
  console.error(`[provisioning] pool: total=${status.total} free=${status.free} leased=${status.leased} ` +
    `quarantined=${status.quarantined} dead=${status.dead}`);
  if (src.error) {
    console.error(`[provisioning] seed source (${src.source}) is unusable: ${src.error}`);
  } else if (src.source === 'none') {
    console.error('[provisioning] no seed source found — set TELENOW_KEY_POOL or write ' +
      `${POOL_FILE}, then restart.`);
  } else if (src.count > 0 && status.total === 0) {
    console.error(`[provisioning] seed source (${src.source}) lists ${src.count} entries but the store ` +
      'sees none — the pool was never imported.');
  } else if (status.quarantined > 0) {
    console.error(`[provisioning] ${status.quarantined} workspace(s) are quarantined pending an operator wipe: ` +
      'run `node scripts/keypool.js wipe <ref> --wiped` once the Telenow workspace is purged.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Release
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hand a shop's workspace back on uninstall. Called from APP_UNINSTALLED BEFORE
 * deleteShop(), which wipes settings and with them the workspace ref.
 *
 * The entry goes to QUARANTINED, not free. See the header: that workspace still
 * holds the departing merchant's recordings, transcripts and customer phone
 * numbers, and leasing it to the next merchant would disclose them. Reclaiming
 * it is a deliberate operator act after a real purge (`scripts/keypool.js wipe
 * <ref> --wiped`), not an automatic consequence of an uninstall.
 *
 * Never throws. It runs on the purge path, where a thrown error would abandon
 * the rest of the cleanup and leave the merchant's data on disk after they asked
 * us to leave.
 */
export async function releaseWorkspace(shop) {
  if (!shop) return;

  // Nothing keyed on a departing shop should outlive it in memory, and a
  // reinstall must get an immediate hook attempt — and an immediate country
  // lookup — rather than inheriting the cooldown from whatever failed before the
  // uninstall. The country one matters most on the reinstall-after-revoked-token
  // path: the token that made the lookup fail is exactly the thing a reinstall
  // replaces, so the retry that would have been throttled is the one that works.
  meteringFailedAt.delete(shop);
  shopCountryAttemptedAt.delete(shop);

  // Read the ref BEFORE anything mutates settings — it is the only handle the
  // partner teardown below has.
  let ref = null;
  let source = 'none';
  try {
    const settings = getSettings(shop);
    ref = settings.telenowWorkspaceRef || null;
    source = settings.telenowKeySource || 'none';
  } catch {
    // A shop with no settings has nothing to release; the pool release below is
    // still worth attempting, since db.keypool is keyed independently.
  }

  try {
    const released = releaseKey(shop);
    if (released) {
      console.log(`[provisioning] quarantined workspace ${released} released by ${shop} — ` +
        'wipe it on the Telenow side before returning it to the pool.');
    }
  } catch (err) {
    console.error(`[provisioning] releaseKey failed for ${shop}: ${err.message}`);
  }

  // v1.1 seam: a partner-minted workspace is torn down upstream rather than
  // quarantined, because we own its whole lifecycle.
  //   DELETE /api/v1/partner/workspaces/{workspaceId} → 204, or 404 = already gone.
  if (source === 'partner' && ref && process.env.TELENOW_PARTNER_KEY) {
    try {
      const telenow = await import('./telenow.js');
      if (typeof telenow.releaseWorkspace === 'function') await telenow.releaseWorkspace(ref);
    } catch (err) {
      console.error(`[provisioning] partner release of ${ref} failed: ${err.message}`);
    }
  }

  // Deliberately NOT clearing settings.telenowApiKey here: removeTelenowHook()
  // runs alongside this on the uninstall path and needs the key to delete the
  // subscription upstream. deleteShop() wipes the whole settings row moments
  // later anyway.
}

// ─────────────────────────────────────────────────────────────────────────────
// Monitoring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pool census for /healthz and ops alerting. Alarm below 5 free.
 *
 * `quarantined` is reported separately from `dead` and `free` on purpose: it is
 * the count of workspaces that are recoverable but only by an operator who
 * purges them first. Folding it into `free` would hide a privacy obligation
 * behind a healthy-looking number, and folding it into `dead` would quietly
 * write off inventory that is worth reclaiming.
 *
 * `byCountry`/`byProvider` are carried through rather than field-picked away, and
 * they are the half of this census that actually catches the failure we care
 * about. `free` is a single number and cannot distinguish "forty workspaces ready
 * for anyone" from "forty Indian numbers and nothing that can ring a North
 * American mobile" — the second reads perfectly healthy right up to the install
 * that gets a test call marked broken in review. keypoolStatus() counts FREE
 * entries only for the same reason, so these are stock levels, not purchases, and
 * an alert should watch the country buckets rather than the total.
 *
 * Never throws — /healthz answering 500 because the census failed would take the
 * app out of rotation over a monitoring detail. That extends to the maps: they
 * are rebuilt field by field with non-numeric counts coerced to 0, because this
 * value is serialised straight into a health response and a malformed census must
 * degrade to a boring one rather than to an exception.
 *
 * @returns {{ total: number, leased: number, free: number, quarantined: number, dead: number,
 *             byCountry: Record<string, number>, byProvider: Record<string, number> }}
 */
export function poolStatus() {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const buckets = (v) => {
    if (!v || typeof v !== 'object') return {};
    const out = {};
    for (const [label, count] of Object.entries(v)) out[label] = n(count);
    return out;
  };
  try {
    const raw = keypoolStatus() || {};
    return {
      total: n(raw.total),
      leased: n(raw.leased),
      free: n(raw.free),
      quarantined: n(raw.quarantined),
      dead: n(raw.dead),
      byCountry: buckets(raw.byCountry),
      byProvider: buckets(raw.byProvider),
    };
  } catch (err) {
    console.error(`[provisioning] keypoolStatus failed: ${err.message}`);
    // Empty maps, not absent ones: a monitor that reads keypool.byCountry.US must
    // see 0-free-in-every-country here, not crash on an undefined.
    return {
      total: readPoolSource().count,
      leased: 0,
      free: 0,
      quarantined: 0,
      dead: 0,
      byCountry: {},
      byProvider: {},
    };
  }
}
