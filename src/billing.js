// ─────────────────────────────────────────────────────────────────────────────
// billing.js — the ONLY module that knows Shopify billing exists.
//
// Everything about money lives behind these exports: reading what a shop is
// entitled to, deciding whether a request may spend, sending the merchant to
// Shopify's own approval screen, and reporting overage minutes. Nothing else in
// the app constructs a charge, a confirmation URL or a usage record, so there is
// exactly one place to audit against requirement 1.2.1.
//
// TWO INVARIANTS THIS FILE EXISTS TO HOLD:
//
//   1. getEntitlement() NEVER THROWS. It is on the read path of every gated
//      route and every automation. An Admin API blip, an expired token, a
//      GraphQL schema change — none of those may lock a paying merchant out of
//      their own call history. On any failure we serve the last known-good
//      entitlement (or the free Starter default) and log.
//
//   2. The free Starter tier is the ABSENCE of a subscription, not a $0 charge.
//      A shop with no AppSubscription is entitled to `starter` and is fully
//      functional. That is what makes the app testable with no payment method,
//      and it is why DECLINED / CANCELLED / EXPIRED are soft, reversible states
//      here rather than dead ends.
//
// Entitlement is cached on `settings.billing` and refreshed at most every five
// minutes, plus immediately on the billing callback and on the
// app_subscriptions/update webhook. The scheduler's periodic refresh is the
// backstop for a lost webhook — this cache is a convenience, never the truth.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';

import { Session } from '@shopify/shopify-api';

import { shopify, adminGraphQL, HOST } from './shopify.js';
import { PLANS, PAID_PLAN_NAMES, planByName } from './plans.js';
import { getShop } from './store.js';
import { getSettings, updateSettings } from './settings.js';
import { rollIfNeeded, usedMinutes } from './usage.js';

/** How long a cached entitlement is served before we re-ask Shopify. */
const ENTITLEMENT_TTL_MS = 5 * 60 * 1000;

/** The entitlement every installed shop has before it buys anything. */
function starterEntitlement() {
  return {
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
    pendingState: null,
    pendingPlan: null,
  };
}

/**
 * Read the persisted entitlement, filling in anything a shop installed before
 * this feature shipped is missing. Older `store.json` blobs have no `billing`
 * key at all, and a half-populated one must not read as "no plan" for a
 * merchant who is actually paying.
 */
function storedEntitlement(shop) {
  const stored = getSettings(shop)?.billing;
  return { ...starterEntitlement(), ...(stored && typeof stored === 'object' ? stored : {}) };
}

/**
 * Merge a patch into `settings.billing` without disturbing the rest of the
 * settings blob. updateSettings() shallow-merges, so handing it a partial
 * `billing` object would silently drop every field we did not name.
 */
function patchBilling(shop, patch) {
  const next = { ...storedEntitlement(shop), ...patch };
  updateSettings(shop, { billing: next });
  return next;
}

/**
 * Attach the derived `active` flag. It is deliberately NOT persisted: it is a
 * function of `status`, and a stored copy is one more thing that can go stale
 * and disagree with the field it was derived from.
 *
 * FROZEN is the only state that is not active. Starter is active (it is a real
 * plan), and so is a shop that declined, cancelled or let a charge expire —
 * each of those falls back to Starter rather than to a locked app.
 */
function withDerived(ent) {
  return { ...ent, active: ent.status !== 'FROZEN' };
}

/**
 * A usage line item is the one carrying `AppUsagePricing`. The library's own
 * APP_SUBSCRIPTION_FRAGMENT does not request `__typename`, so in practice the
 * discriminator is the presence of `balanceUsed` — which is exactly how the
 * library identifies it internally (create-usage-record.js: `'balanceUsed' in
 * pricingDetails`). We test both so this keeps working if the fragment ever
 * starts asking for `__typename`.
 */
function isUsageLineItem(lineItem) {
  const details = lineItem?.plan?.pricingDetails;
  if (!details || typeof details !== 'object') return false;
  return details.__typename === 'AppUsagePricing' || 'balanceUsed' in details;
}

/** Money off the Admin API arrives as a string on some paths and a number on others. */
function moneyAmount(money) {
  const n = Number(money?.amount);
  return Number.isFinite(n) ? n : 0;
}

/**
 * `adminGraphQL` is owned by shopify.js and may hand back either the raw
 * GraphQL envelope (`{ data: … }`) or the already-unwrapped payload. Pick
 * whichever one actually carries the root field we asked for so this module
 * cannot break on that distinction.
 */
function rootField(response, field) {
  if (!response || typeof response !== 'object') return undefined;
  if (response[field] !== undefined) return response[field];
  if (response.data && response.data[field] !== undefined) return response.data[field];
  return undefined;
}

// ── Session ──────────────────────────────────────────────────────────────────

/**
 * Build a library Session from the offline token stored at install.
 *
 * Every billing call is server-to-server (a webhook, a scheduler tick, a gated
 * API route), so there is no logged-in user and no online session to borrow.
 * The Session object is a thin carrier the GraphQL client reads `shop` and
 * `accessToken` off — it is not persisted anywhere.
 *
 * @param {string} shop
 * @returns {Promise<Session>}
 */
export async function sessionFor(shop) {
  const row = getShop(shop);
  if (!row?.accessToken) {
    throw new Error(`[billing] no offline session for ${shop} — is the app installed?`);
  }
  return new Session({
    id: `offline_${shop}`,
    shop,
    state: '',
    isOnline: false,
    accessToken: row.accessToken,
    scope: row.scope,
  });
}

// ── Entitlement ──────────────────────────────────────────────────────────────

/**
 * Turn a billing.check() response into the persisted entitlement shape.
 *
 * `previous` supplies the fields Shopify does not know about — the
 * development-store flag, the last webhook timestamp — so a refresh never
 * erases them.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY: `pendingState` and `pendingPlan`.
 * Those belong to requestSubscription()/raiseCap(), not to Shopify, and a
 * refresh is a read-only round trip that routinely overlaps a purchase the
 * merchant is in the middle of. getEntitlement() snapshots the stored row
 * BEFORE the GraphQL call; if that snapshot's copy of the nonce were written
 * back afterwards, a refresh that started before requestSubscription() minted
 * the nonce would null it out a second later — and the merchant would be
 * charged and then handed "this billing link has expired". Leaving both fields
 * out of the mapped object lets patchBilling()'s fresh read of the row win, so
 * a concurrent refresh is invisible to an in-flight approval.
 */
function mapPayments(previous, payments) {
  const subs = Array.isArray(payments?.appSubscriptions) ? payments.appSubscriptions : [];
  // check() filters on plan name and test-ness only — it applies NO status
  // filter of its own (check.js: subscriptionMeetsCriteria), so whatever
  // `currentAppInstallation.activeSubscriptions` returns arrives here verbatim.
  // ACTIVE is what we want; FROZEN we also adopt, because FROZEN is a state the
  // merchant must be TOLD about rather than one we quietly downgrade, and
  // checkAccess() turns it into a billing_frozen block.
  //
  // Anything else — PENDING, DECLINED, CANCELLED, EXPIRED — must NOT be adopted
  // as a paid plan. Shopify will refuse to charge a usage record against it, so
  // adopting it would hand out unlimited overage minutes that can never be
  // billed, while `plan` and `status` disagreed about whether the shop is
  // paying. We keep the status (and the subscription id) for the UI and for
  // support, and let the entitlement fall through to Starter.
  const adoptable =
    subs.find((s) => s?.status === 'ACTIVE') || subs.find((s) => s?.status === 'FROZEN') || null;
  const sub = adoptable || subs[0] || null;

  const { pendingState: _pendingState, pendingPlan: _pendingPlan, ...carried } = previous || {};
  const base = {
    ...carried,
    checkedAt: new Date().toISOString(),
  };

  if (!adoptable) {
    // No charge object at all, or only a charge Shopify will not honour — both
    // ARE the free Starter tier, not an error.
    return {
      ...base,
      plan: 'starter',
      planName: null,
      status: sub?.status || 'NONE',
      subscriptionId: sub?.id || null,
      usageLineItemId: null,
      test: Boolean(sub?.test),
      trialEndsAt: null,
      currentPeriodEnd: null,
      balanceUsedUsd: 0,
      capUsd: 0,
    };
  }

  const plan = planByName(sub.name);
  const usageLine = (Array.isArray(sub.lineItems) ? sub.lineItems : []).find(isUsageLineItem);
  const usageDetails = usageLine?.plan?.pricingDetails;

  return {
    ...base,
    plan: plan.handle,
    planName: sub.name ?? plan.name ?? null,
    status: sub.status || 'NONE',
    subscriptionId: sub.id || null,
    // The subscription line item gid carries a query string —
    // "gid://shopify/AppSubscriptionLineItem/123?v=1&index=1". Store it WHOLE.
    // Truncating at the '?' produces an id Shopify accepts syntactically and
    // then fails to resolve, which is the classic silent usage-billing bug.
    usageLineItemId: usageLine?.id || null,
    test: Boolean(sub.test),
    trialEndsAt: trialEnd(sub),
    currentPeriodEnd: sub.currentPeriodEnd || null,
    balanceUsedUsd: moneyAmount(usageDetails?.balanceUsed),
    // Fall back to the plan's configured cap only when Shopify returned no
    // usage line item; otherwise the merchant-approved figure always wins,
    // because that is the number they actually consented to.
    capUsd: usageDetails ? moneyAmount(usageDetails.cappedAmount) : plan.capUsd || 0,
  };
}

/** Shopify reports trialDays + createdAt, not an end date. Derive it once, here. */
function trialEnd(sub) {
  const days = Number(sub?.trialDays);
  const created = Date.parse(sub?.createdAt || '');
  if (!Number.isFinite(days) || days <= 0 || !Number.isFinite(created)) return null;
  return new Date(created + days * 86400000).toISOString();
}

/**
 * What this shop is entitled to, right now.
 *
 * Served from `settings.billing` while it is under five minutes old unless
 * `force` is set. NEVER THROWS — see the invariant at the top of the file.
 *
 * @param {string} shop
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<object>} the entitlement, plus the derived `active` flag
 */
export async function getEntitlement(shop, opts = {}) {
  const cached = storedEntitlement(shop);
  const age = cached.checkedAt ? Date.now() - Date.parse(cached.checkedAt) : Infinity;
  if (!opts.force && Number.isFinite(age) && age >= 0 && age < ENTITLEMENT_TTL_MS) {
    return withDerived(cached);
  }

  try {
    const session = await sessionFor(shop);
    const payments = await shopify.billing.check({
      session,
      plans: PAID_PLAN_NAMES,
      // isTest:true IS MANDATORY HERE AND IS NOT A REVIEWER SPECIAL CASE.
      // DO NOT "FIX" THIS TO false.
      //
      // The library gates every subscription on `(isTest || !subscription.test)`
      // (check.js, subscriptionMeetsCriteria). With isTest:false it therefore
      // REFUSES TO SEE test subscriptions — so a reviewer who approved the test
      // charge Shopify creates on a development store would still be locked out
      // of everything they just paid for. isTest:true accepts live and test
      // alike, which is the only correct polarity for an entitlement READ.
      // (It has no effect on what we charge: `test` on the charge itself is set
      // in requestSubscription from isDevelopmentStore().)
      isTest: true,
      returnObject: true,
    });
    // Return what was actually PERSISTED, not the mapped object: patchBilling
    // re-reads the row at write time, so its result is the only view that has
    // the current nonce merged back in. Returning `next` would hand callers an
    // entitlement with pendingState/pendingPlan missing entirely.
    const persisted = patchBilling(shop, mapPayments(cached, payments));
    return withDerived(persisted);
  } catch (err) {
    // Degrade to the last known-good answer. A shop that was paying five
    // minutes ago is still paying now; the Admin API being briefly unreachable
    // is our problem, not the merchant's.
    console.error(`[billing] entitlement check failed for ${shop}: ${err.message}`);
    return withDerived(cached);
  }
}

/**
 * Force a re-read from Shopify. Used by /billing/callback, the
 * app_subscriptions/update webhook and the reconciliation sweep — every path
 * where we know the answer just changed.
 *
 * `lastWebhookAt` is stamped here rather than in the webhook handler because
 * this is the only function all of those paths share; it answers "when did we
 * last take Shopify's word for this shop", which is what it is read for when a
 * merchant's plan looks wrong.
 *
 * @param {string} shop
 */
export async function refreshEntitlement(shop) {
  const ent = await getEntitlement(shop, { force: true });
  const lastWebhookAt = new Date().toISOString();
  patchBilling(shop, { lastWebhookAt });
  return { ...ent, lastWebhookAt };
}

// ── The gate ─────────────────────────────────────────────────────────────────

/**
 * May this shop do `need` right now?
 *
 * The single decision function behind all five enforcement points (HTTP routes,
 * automations, the deferred setTimeout branch, arming an automation, the UI).
 * Blocked answers are always HTTP 402 with one of five machine-readable error
 * codes and an `action` telling the UI what to offer, so no caller ever has to
 * infer the remedy.
 *
 * @param {string} shop
 * @param {'read'|'spend'|'provision'} need
 * @returns {Promise<{ok:boolean, ent:object, body?:object}>}
 */
export async function checkAccess(shop, need = 'read') {
  const ent = await getEntitlement(shop); // cached 5 min, never throws
  rollIfNeeded(shop, ent);

  // FROZEN is deliberately SOFT: reads keep working. Hard-locking a merchant out
  // of their own call history because a card expired is hostile and reads badly
  // to a reviewer poking at edge cases.
  if (ent.status === 'FROZEN' && need !== 'read') {
    return {
      ok: false,
      ent,
      body: {
        error: 'billing_frozen',
        plan: ent.plan,
        status: 'FROZEN',
        soft: true,
        message:
          'Your subscription is on hold pending payment. Calls are paused; your data is intact.',
        action: 'fix_payment',
      },
    };
  }
  if (need === 'read') return { ok: true, ent };

  // A paid HANDLE is not a paid ENTITLEMENT. mapPayments no longer adopts a
  // non-ACTIVE/non-FROZEN subscription, but a row persisted by an older build
  // can still say plan:'growth', status:'CANCELLED' — and Shopify would refuse
  // every usage record written against it. Anything that is not an ACTIVE paid
  // subscription is metered against the Starter allowance, which is the same
  // fallback the file header promises for DECLINED / CANCELLED / EXPIRED.
  const onPaidPlan = ent.plan !== 'starter' && ent.status === 'ACTIVE';
  const plan = onPaidPlan ? PLANS[ent.plan] || PLANS.starter : PLANS.starter;
  const used = usedMinutes(shop);

  // Free tier: hard stop, never billed. No Starter merchant can ever receive a
  // Shopify invoice, so the allowance has to be a wall rather than an overage.
  if (!onPaidPlan) {
    if (used >= plan.includedMinutes) {
      return {
        ok: false,
        ent,
        body: {
          error: 'minutes_exhausted',
          plan: plan.handle,
          status: ent.status,
          usedMinutes: used,
          includedMinutes: plan.includedMinutes,
          message: `You have used all ${plan.includedMinutes} free minutes for this period. Choose a plan to keep calling.`,
          action: 'choose_plan',
          suggestPlan: 'growth',
        },
      };
    }
    return { ok: true, ent };
  }

  // ── Paid tier ──────────────────────────────────────────────────────────────
  //
  // Everything below fails CLOSED, and the reason is asymmetric: an overage
  // minute we let through without a chargeable ceiling is revenue we can never
  // recover and a merchant we can never invoice, whereas a minute we wrongly
  // block is one reload away from being fixed. But "closed" is scoped to the
  // OVERAGE, not to the plan: a merchant who is still inside the allowance they
  // already paid for keeps calling no matter how confused our billing state is.
  const overageMinutes = Math.max(0, used - plan.includedMinutes);

  // Local projection of what this period has cost so far, in dollars.
  //
  // `balanceUsedUsd` is Shopify's figure and it is up to five minutes stale
  // (ENTITLEMENT_TTL_MS) and lags again behind reportUsage, so a burst of calls
  // can spend straight through a cap that the cached number still shows room
  // under. Metering the minutes we have counted locally closes that window. We
  // take the LARGER of the two rather than replacing one with the other: the
  // projection can trail Shopify when the usage window and the billing period
  // have drifted apart, and max() can never double-count.
  const projectedUsd = Math.round(overageMinutes * plan.overagePerMinuteUsd * 100) / 100;
  const spentUsd = Math.max(Number(ent.balanceUsedUsd) || 0, projectedUsd);
  const capUsd = Number(ent.capUsd) || 0;

  // No usage line item on a paid subscription means appUsageRecordCreate has
  // nothing to bill against — reportUsage() self-skips forever and every
  // overage minute is delivered free. That is a broken subscription, not a
  // merchant problem, so it is logged as an operator alarm; re-subscribing is
  // the only thing that rebuilds the line item, hence 'choose_plan'.
  if (!ent.usageLineItemId) {
    console.error(
      `[billing] ALARM: ${shop} is on ${ent.plan} (${ent.subscriptionId || 'no subscription id'}) ` +
        'with no usage line item — overage cannot be billed. Overage is blocked until this is fixed.',
    );
    if (overageMinutes > 0) {
      return {
        ok: false,
        ent,
        body: {
          error: 'minutes_exhausted',
          plan: ent.plan,
          usedMinutes: used,
          includedMinutes: plan.includedMinutes,
          message: `You have used all ${plan.includedMinutes} minutes included in your plan and this subscription cannot meter extra minutes. Reselect your plan to continue.`,
          action: 'choose_plan',
        },
      };
    }
    return { ok: true, ent };
  }

  // The cappedAmount the merchant approved on Shopify's own screen is the
  // ceiling. A cap of zero is not "no ceiling" — Shopify always stores a
  // cappedAmount on a usage line item, so a zero here means we failed to read
  // one, and treating an unreadable ceiling as an infinite one is precisely the
  // fail-open the paragraph above rules out. Overage is never silently uncapped
  // and never silently dropped: we stop and offer to raise it.
  if (capUsd <= 0) {
    console.error(
      `[billing] ALARM: ${shop} is on ${ent.plan} with an unreadable monthly maximum ` +
        '(capUsd 0 on a usage line item) — treating it as reached.',
    );
  }
  if (capUsd <= 0 ? overageMinutes > 0 : spentUsd >= capUsd) {
    return {
      ok: false,
      ent,
      body: {
        error: 'usage_cap_reached',
        plan: ent.plan,
        balanceUsedUsd: spentUsd,
        capUsd,
        message:
          capUsd > 0
            ? `You have reached the $${capUsd} monthly maximum you approved. Raise it to keep calling.`
            : 'We could not confirm the monthly maximum you approved. Set a new one to keep calling.',
        action: 'raise_cap',
      },
    };
  }
  return { ok: true, ent };
}

/**
 * The entitlement as the browser is allowed to see it.
 *
 * Whitelist, not blacklist: `pendingState` is a CSRF token for the billing
 * callback and must never reach the page, and any field added to the persisted
 * shape later is excluded by default rather than leaked by default.
 *
 * @param {object} ent
 */
export function entitlementForClient(ent) {
  const e = { ...starterEntitlement(), ...(ent && typeof ent === 'object' ? ent : {}) };
  return {
    plan: e.plan,
    planName: e.planName,
    status: e.status,
    test: Boolean(e.test),
    trialEndsAt: e.trialEndsAt,
    currentPeriodEnd: e.currentPeriodEnd,
    balanceUsedUsd: e.balanceUsedUsd,
    capUsd: e.capUsd,
    active: e.status !== 'FROZEN',
  };
}

// ── Buying a plan ────────────────────────────────────────────────────────────

/**
 * Is this a Shopify development store?
 *
 * Drives `test` on the charge. Development stores cannot be charged, so a
 * reviewer installing on their own dev store gets a TEST charge: Shopify's
 * approval screen renders normally, no payment method is requested, and no
 * money moves. This is the standard documented pattern every Shopify app uses
 * — it keys off a property of the STORE, not off who is looking, and there is
 * no reviewer-differential behaviour anywhere in this codebase.
 *
 * Cached on `settings.billing.devStore` for the lifetime of the install: a
 * store's partnerDevelopment flag cannot change under an existing install.
 *
 * @param {string} shop
 * @returns {Promise<boolean>}
 */
export async function isDevelopmentStore(shop) {
  const cached = storedEntitlement(shop).devStore;
  if (typeof cached === 'boolean') return cached;

  try {
    const res = await adminGraphQL(shop, 'query DevStore { shop { plan { partnerDevelopment } } }');
    const isDev = Boolean(rootField(res, 'shop')?.plan?.partnerDevelopment);
    patchBilling(shop, { devStore: isDev });
    return isDev;
  } catch (err) {
    // Fail to `false`, and do NOT cache the failure.
    //
    // A wrong `true` would create a test charge on a real merchant's store —
    // unbillable revenue that nobody notices for a month. A wrong `false`
    // surfaces immediately: Shopify refuses a live charge on a development
    // store, and the next attempt re-queries because we cached nothing.
    console.error(`[billing] partnerDevelopment lookup failed for ${shop}: ${err.message}`);
    return false;
  }
}

/**
 * Start a subscription. Returns the confirmationUrl SHOPIFY generated — the app
 * never builds a purchase URL by hand, which is what makes it impossible for a
 * mistyped app handle to dead-end the merchant on a 404.
 *
 * The `state` nonce is the CSRF guard for /billing/callback, which is a
 * top-level browser navigation with no App Bridge session token to verify.
 *
 * @param {string} shop
 * @param {'growth'|'scale'} planHandle
 * @param {{host?: string}} [opts] `host` is the App Bridge host param, so the
 *   callback can return the merchant to the right admin.
 * @returns {Promise<{confirmationUrl: string}>}
 */
export async function requestSubscription(shop, planHandle, opts = {}) {
  const handle = String(planHandle || '').trim();
  const plan = PLANS[handle];
  if (!plan) throw new Error(`[billing] unknown plan: ${planHandle}`);
  // Starter is the absence of a subscription. There is nothing to buy, and
  // asking Shopify to create a charge for it would be a $0 charge — exactly the
  // ambiguity this design exists to avoid.
  if (handle === 'starter' || !plan.name) {
    throw new Error('[billing] Starter is free — there is no subscription to create.');
  }

  const session = await sessionFor(shop);
  const isTest = await isDevelopmentStore(shop);
  const state = crypto.randomBytes(16).toString('hex');
  patchBilling(shop, { pendingState: state, pendingPlan: handle });

  const returnUrl =
    `${HOST}/billing/callback?shop=${encodeURIComponent(shop)}&state=${state}` +
    (opts.host ? `&host=${encodeURIComponent(opts.host)}` : '');

  const confirmationUrl = await shopify.billing.request({
    session,
    plan: plan.name,
    isTest,
    returnUrl,
  });

  return { confirmationUrl };
}

/**
 * Recover the /billing/callback nonce that is baked into a subscription's own
 * returnUrl.
 *
 * appSubscriptionLineItemUpdate takes NO returnUrl of its own (verified in
 * lib/billing/update-usage-subscription-capped-amount.js — the mutation's only
 * variables are $cappedAmount and $id). After the merchant approves a cap
 * raise, Shopify therefore sends them to the returnUrl stored on the
 * AppSubscription, which requestSubscription() built at SUBSCRIBE time and
 * which carries the SUBSCRIBE-time state. That nonce was cleared by the
 * subscribe callback, so unless it is re-armed here every cap raise lands on
 * "this billing link has expired" — after the money side already succeeded.
 *
 * Re-arming the same value rather than minting a new one is not a shortcut, it
 * is the only thing that can work: the URL Shopify will redirect to is already
 * fixed, and there is no way to change it per confirmation.
 *
 * The returnUrl always came from our own requestSubscription (check() and this
 * mutation both read `currentAppInstallation`, i.e. THIS app's subscriptions
 * only), but it is validated anyway — right path, right shop, right shape —
 * so that a malformed or foreign value can never be armed as a nonce. The
 * origin deliberately is NOT compared against HOST: after a domain move the old
 * host would not match, and a redirect to a host we no longer serve is a broken
 * landing either way, so rejecting it would only lose the diagnostics.
 */
function callbackStateFromReturnUrl(returnUrl, shop) {
  try {
    const url = new URL(String(returnUrl || ''));
    if (url.pathname !== '/billing/callback') return null;
    if (url.searchParams.get('shop') !== shop) return null;
    const state = url.searchParams.get('state') || '';
    return /^[0-9a-f]{16,128}$/i.test(state) ? state : null;
  } catch {
    return null;
  }
}

/**
 * Raise the monthly usage ceiling. Shopify hands back a confirmationUrl because
 * the merchant has to approve the new maximum on Shopify's own screen — we do
 * not persist the new cap here, since it is not real until they approve and the
 * callback refreshes the entitlement from the Admin API.
 *
 * @param {string} shop
 * @param {number} newCapUsd
 * @returns {Promise<{confirmationUrl: string}>}
 */
export async function raiseCap(shop, newCapUsd) {
  const amount = Number(newCapUsd);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('[billing] a monthly maximum must be a positive dollar amount.');
  }

  const ent = await getEntitlement(shop);
  if (!ent.usageLineItemId) {
    throw new Error('[billing] this plan has no usage line item — choose a paid plan first.');
  }
  if (amount <= ent.balanceUsedUsd) {
    throw new Error(
      `[billing] $${amount} is at or below the $${ent.balanceUsedUsd} already used this period — calls would stay paused.`,
    );
  }

  const session = await sessionFor(shop);
  // v13.1.0 exposes this helper (lib/billing/update-usage-subscription-capped-amount.js)
  // and its mutation is correct, so there is no reason to hand-roll it the way
  // reportUsage below has to. It sends the WHOLE line item gid, query string
  // included.
  const res = await shopify.billing.updateUsageCappedAmount({
    session,
    subscriptionLineItemId: ent.usageLineItemId,
    cappedAmount: { amount, currencyCode: 'USD' },
  });

  const confirmationUrl = res?.confirmationUrl;
  if (!confirmationUrl) throw new Error('[billing] Shopify returned no confirmation URL.');

  // Arm the callback BEFORE handing the merchant the approval URL. The library
  // asks for `returnUrl` in APP_SUBSCRIPTION_FRAGMENT, so the mutation's own
  // response carries the address the approval will bounce back to — no extra
  // round trip, and no second copy of the nonce persisted anywhere.
  const state = callbackStateFromReturnUrl(res?.appSubscription?.returnUrl, shop);
  if (state) {
    patchBilling(shop, { pendingState: state, pendingPlan: ent.plan });
  } else {
    // The cap raise itself still succeeds on Shopify's side; only the landing
    // page will reject the redirect, and the next entitlement refresh picks the
    // new ceiling up regardless. Worth a line in the log, not an exception.
    console.error(
      `[billing] cap raise for ${shop}: could not recover the callback state from the ` +
        'subscription returnUrl — the merchant will land on an expired-link page.',
    );
  }
  return { confirmationUrl };
}

/**
 * Cancel the active subscription, dropping the shop to the free Starter plan.
 *
 * This is what "Move to Starter" on the Plans screen calls, through
 * POST /api/billing/cancel. Requirement 1.2.3 wants a merchant to be able to
 * leave a paid plan from inside the app without contacting support, and there
 * is no downgrade-to-free mutation in the Billing API — Starter is the absence
 * of a subscription, so cancelling IS the downgrade. Uninstalling would also
 * cancel it on Shopify's side, but making that the only exit is exactly the
 * dead end 1.2.3 exists to prevent.
 *
 * @param {string} shop
 */
export async function cancelSubscription(shop) {
  const ent = await getEntitlement(shop, { force: true });
  if (!ent.subscriptionId) return { cancelled: false, reason: 'no active subscription' };

  const session = await sessionFor(shop);
  await shopify.billing.cancel({
    session,
    subscriptionId: ent.subscriptionId,
    prorate: true,
    isTest: Boolean(ent.test),
  });
  await refreshEntitlement(shop);
  return { cancelled: true, subscriptionId: ent.subscriptionId };
}

// ── Usage ────────────────────────────────────────────────────────────────────

// WHY THIS IS A HAND-WRITTEN MUTATION AND NOT shopify.billing.createUsageRecord:
//
// The library's mutation (lib/billing/create-usage-record.js) is declared as
//   mutation appUsageRecordCreate($description: String!, $price: MoneyInput!,
//                                 $subscriptionLineItemId: ID!)
// — $idempotencyKey is NEVER DECLARED. It puts the caller's idempotencyKey into
// the variables map, GraphQL discards the undeclared variable, and the charge
// goes through with no idempotency at all. A redelivered Telenow webhook then
// bills the merchant twice for the same call, and Shopify has no record that
// would let us tell the difference. Declaring it here is the entire point.
const USAGE_RECORD_MUTATION = `
  mutation TelenowUsage($description: String!, $price: MoneyInput!,
                        $subscriptionLineItemId: ID!, $idempotencyKey: String) {
    appUsageRecordCreate(description: $description, price: $price,
      subscriptionLineItemId: $subscriptionLineItemId, idempotencyKey: $idempotencyKey) {
      userErrors { field message }
      appUsageRecord { id price { amount currencyCode } }
    }
  }
`;

/**
 * Bill overage minutes through Shopify.
 *
 * Only ever called for minutes ALREADY past the plan's included allowance —
 * the allowance is delivered by simply not reporting it. Starter never reaches
 * here at all: its ceiling is a hard stop in checkAccess(), so no free-tier
 * merchant can receive a Shopify invoice.
 *
 * Idempotency is doubled up on purpose: `settings.usage.billedSessions` guards
 * on our side (usage.js) and `idempotencyKey` guards on Shopify's, because
 * webhook redelivery is routine and a duplicate here is real money.
 *
 * @param {string} shop
 * @param {{sessionId: string, minutes: number, periodLabel?: string}} opts
 * @returns {Promise<{reported: boolean, reason?: string, id?: string, amountUsd?: number}>}
 */
export async function reportUsage(shop, opts = {}) {
  const sessionId = String(opts.sessionId || '').trim();
  const minutes = Math.max(0, Math.ceil(Number(opts.minutes) || 0));
  if (!sessionId) throw new Error('[billing] reportUsage needs a sessionId to be idempotent.');
  if (minutes <= 0) return { reported: false, reason: 'nothing billable' };

  const ent = await getEntitlement(shop);
  if (ent.plan === 'starter') return { reported: false, reason: 'starter is never billed' };
  if (!ent.usageLineItemId) {
    return { reported: false, reason: 'no usage line item on this subscription' };
  }

  const plan = PLANS[ent.plan] || PLANS.starter;
  const amount = Math.round(minutes * plan.overagePerMinuteUsd * 100) / 100;
  if (amount <= 0) return { reported: false, reason: 'zero-value usage record' };

  const period = opts.periodLabel || new Date().toISOString().slice(0, 10);
  const description = `${minutes} AI voice minutes beyond the plan allowance (period starting ${period})`;

  const res = await adminGraphQL(shop, USAGE_RECORD_MUTATION, {
    description,
    price: { amount, currencyCode: 'USD' },
    // WHOLE gid, query string intact. It looks like
    // "gid://shopify/AppSubscriptionLineItem/123?v=1&index=1"; splitting it at
    // the '?' — which every URL-handling instinct wants to do — yields an id
    // Shopify cannot resolve, and the overage silently never bills.
    subscriptionLineItemId: ent.usageLineItemId,
    idempotencyKey: `tn-usage-${sessionId}`,
  });

  const payload = rootField(res, 'appUsageRecordCreate');
  const userErrors = payload?.userErrors || [];
  if (userErrors.length) {
    const detail = userErrors.map((e) => e?.message).filter(Boolean).join('; ');
    throw new Error(`[billing] appUsageRecordCreate rejected: ${detail || 'unknown error'}`);
  }

  return {
    reported: true,
    id: payload?.appUsageRecord?.id || null,
    amountUsd: amount,
    minutes,
  };
}
