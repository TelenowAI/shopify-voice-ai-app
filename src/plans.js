// ─────────────────────────────────────────────────────────────────────────────
// plans.js — the single source of truth for what this app costs.
//
// Three things must agree, character for character, or the app gets rejected:
//
//   1. the `billing` config handed to shopifyApi(), which is what Shopify renders
//      on the merchant's approval screen and what appSubscriptionCreate charges;
//   2. the plan cards drawn inside the embedded app (GET /api/billing/plans);
//   3. the pricing section of the Partner Dashboard listing.
//
// When those three live in three places they drift, and a listing that advertises
// a price the app does not charge is App Store requirement 4.2.1 — a documented
// second rejection for apps that fixed 1.2.1 and shipped anyway. So all three are
// derived from the PLANS map below: (1) via billingConfig(), (2) via publicPlans(),
// and (3) by a human copying publicPlans() into the dashboard (see the block above
// publicPlans() for the exact procedure).
//
// CHANGING A PRICE HERE IS NOT A CODE CHANGE, IT IS A BILLING EVENT. The Billing
// API pins the amount to the AppSubscription the merchant approved, so an existing
// subscriber keeps paying the old price until they are sent through a fresh
// approval screen and accept it — and any merchant who declines is downgraded.
// Re-read the margin note in the blueprint's PRICING section before touching
// priceUsd, includedMinutes or overagePerMinuteUsd on a live app.
//
// Everything here is USD. INR must never appear anywhere a Shopify-origin merchant
// can reach it.
// ─────────────────────────────────────────────────────────────────────────────

import { BillingInterval, BillingReplacementBehavior } from '@shopify/shopify-api';

// The `terms` string is not a code comment — the merchant reads it on Shopify's
// own approval screen, and so does the reviewer, verbatim. It has to state the
// included allowance, the exact per-minute overage price and the exact monthly
// ceiling in plain words, because "usage-based charges may apply" is precisely
// the vagueness that gets a usage line item questioned.
const GROWTH_TERMS =
  '300 AI voice minutes are included every 30 days. Additional minutes are billed through Shopify at $0.12 per minute, up to the $200.00 monthly maximum you approve here.';
const SCALE_TERMS =
  '1,500 AI voice minutes are included every 30 days. Additional minutes are billed through Shopify at $0.10 per minute, up to the $500.00 monthly maximum you approve here.';

// Feature bullets, one sentence each. Joining a plan's bullets with '. ' and
// appending a final '.' reproduces the listing's plan-card description exactly —
// that is the whole point, and it is what makes the 4.2.1 diff in the release
// checklist a mechanical comparison instead of a judgement call.
//
// THE RULE FOR ADDING A BULLET: it may only describe behaviour that some line of
// code in this repo actually delivers or enforces. A bullet is not marketing copy
// here, it is the listing, and 4.2.1 rejects a listing that promises what the app
// does not do. The tiers therefore differ on exactly the three axes the code
// really gates — included minutes (usage.js), overage price and cap (billing.js),
// and active automations (server.js's maxActiveAutomations check) — and on the
// trial, which Shopify itself honours. Nothing else.
//
// PHONE NUMBERS ARE DELIBERATELY NOT A DIFFERENTIATOR, hence one shared constant
// rather than three per-tier strings. provisioning.js leases every shop exactly
// one pool workspace carrying exactly one caller-ID number, on every plan, and a
// leased workspace is never shared between two live shops — so a per-tier claim
// in either direction is false in both directions: a Starter shop's number is not
// shared with anyone, and no plan can deliver a second or third number because
// nothing in the pool, the lease or the settings can hold one. Earlier copy here
// said "One shared caller ID" / "Your own caller ID" / "Up to 3 numbers", which
// invented a ladder the code has never had. If number tiering is ever genuinely
// built (a per-plan lease count in store.js plus a maxNumbers gate), split this
// constant then — and republish the listing in the same deploy, not after it.
const NUMBER_BULLET = 'Your own dedicated calling number';

const FEATURES = {
  starter: [
    '25 AI voice minutes each month',
    '1 active automation',
    NUMBER_BULLET,
    'Call outcomes written back to your orders',
  ],
  growth: [
    '7-day free trial',
    '300 AI voice minutes each month, then $0.12 per minute up to a $200 monthly maximum you approve',
    'Unlimited automations',
    NUMBER_BULLET,
  ],
  scale: [
    '7-day free trial',
    '1,500 AI voice minutes each month, then $0.10 per minute up to a $500 monthly maximum you approve',
    'Unlimited automations',
    NUMBER_BULLET,
  ],
};

/**
 * The plans, keyed by internal handle.
 *
 * `name` is the merchant-visible AppSubscription name AND the key in the object
 * shopifyApi({ billing }) expects, which is why the two can never be out of step:
 * billingConfig() keys off this field and planByName() reverses it when reading a
 * subscription back off the Admin API.
 *
 * STARTER HAS name === null ON PURPOSE. Starter is not a $0 charge, it is the
 * absence of a subscription: a shop with no active payment is entitled to it. That
 * sidesteps the question of whether appSubscriptionCreate accepts amount: 0, gives
 * a reviewer a fully working app even if they decline every charge, and makes
 * DECLINED / EXPIRED / CANCELLED a soft reversible state rather than a dead end —
 * which is exactly what requirement 1.2.2 is tested against. A null name is also
 * what keeps starter out of billingConfig() and out of PAID_PLAN_NAMES.
 *
 * `rank` exists so upgrade/downgrade comparisons are an integer compare rather
 * than a hand-maintained list of allowed transitions.
 *
 * `maxActiveAutomations: Infinity` is deliberate rather than a large sentinel:
 * the gate is a plain `count >= max` and Infinity makes that read correctly with
 * no special case. It never reaches JSON — publicPlans() does not expose it.
 */
export const PLANS = Object.freeze({
  starter: Object.freeze({
    handle: 'starter',
    name: null,
    priceUsd: 0,
    trialDays: 0,
    includedMinutes: 25,
    maxActiveAutomations: 1,
    rank: 0,
    overagePerMinuteUsd: 0,
    capUsd: 0,
  }),
  growth: Object.freeze({
    handle: 'growth',
    name: 'Telenow Growth',
    priceUsd: 39,
    trialDays: 7,
    includedMinutes: 300,
    maxActiveAutomations: Infinity,
    rank: 1,
    overagePerMinuteUsd: 0.12,
    capUsd: 200,
  }),
  scale: Object.freeze({
    handle: 'scale',
    name: 'Telenow Scale',
    priceUsd: 149,
    trialDays: 7,
    includedMinutes: 1500,
    maxActiveAutomations: Infinity,
    rank: 2,
    overagePerMinuteUsd: 0.10,
    capUsd: 500,
  }),
});

/**
 * The subscription names billing.check({ plans }) is asked about. Derived rather
 * than typed out a second time, so adding a paid plan to PLANS cannot leave the
 * entitlement read silently blind to it.
 */
export const PAID_PLAN_NAMES = Object.freeze(
  Object.values(PLANS).filter((p) => p.name !== null).map((p) => p.name),
);

/**
 * Merchant-visible AppSubscription name → plan. Anything unrecognised resolves to
 * starter rather than throwing: an entitlement read that hits a subscription this
 * build has never heard of (an old plan name still active on a shop, a rename
 * mid-deploy) must degrade to the free tier, not 500 the merchant's app shell.
 */
export function planByName(name) {
  for (const plan of Object.values(PLANS)) {
    if (plan.name !== null && plan.name === name) return plan;
  }
  return PLANS.starter;
}

/** Internal handle → plan; unknown handles resolve to starter, same reasoning. */
export function planByHandle(handle) {
  return Object.prototype.hasOwnProperty.call(PLANS, handle) ? PLANS[handle] : PLANS.starter;
}

/**
 * The object passed to shopifyApi({ billing }).
 *
 * Each paid plan carries TWO line items on one AppSubscription:
 *   - a recurring one at priceUsd every 30 days, which is the plan fee;
 *   - a usage one whose `amount` is the CAPPED amount (not a price per unit) —
 *     the ceiling the merchant approves, against which appUsageRecordCreate draws
 *     down. Overage is therefore never silently uncapped: once balanceUsed reaches
 *     it, the spend gate answers 402 usage_cap_reached and the merchant is offered
 *     a fresh approval screen to raise it.
 *
 * Starter is absent by construction (it is filtered on `name === null`, not by a
 * hardcoded skip) because there is no charge object to create for it.
 *
 * replacementBehavior Standard is Shopify's default proration handling on an
 * upgrade/downgrade; we do not want ApplyImmediately, which would bill the new
 * plan in full on the spot.
 *
 * Built fresh on every call rather than cached, so a caller that mutates the
 * returned config cannot poison the next reader. Shape verified against
 * @shopify/shopify-api dist/ts/lib/billing/types.d.ts (BillingConfigUsageLineItem
 * requires interval: BillingInterval.Usage, `amount`, and `terms`).
 */
export function billingConfig() {
  const terms = { growth: GROWTH_TERMS, scale: SCALE_TERMS };
  const config = {};

  for (const plan of Object.values(PLANS)) {
    if (plan.name === null) continue;
    config[plan.name] = {
      replacementBehavior: BillingReplacementBehavior.Standard,
      trialDays: plan.trialDays,
      lineItems: [
        {
          amount: plan.priceUsd,
          currencyCode: 'USD',
          interval: BillingInterval.Every30Days,
        },
        {
          amount: plan.capUsd,
          currencyCode: 'USD',
          interval: BillingInterval.Usage,
          terms: terms[plan.handle],
        },
      ],
    };
  }

  return config;
}

/**
 * The plan cards the browser renders, starter included.
 *
 * THIS IS ALSO THE COPY THAT MUST BE PUBLISHED IN THE PARTNER DASHBOARD LISTING
 * (Distribution → Manage listing → Pricing content), in this order, in USD, with
 * no "starting from" and no "contact us". App Store requirement 4.2.1 requires the
 * listing price and the in-app price to match; a mismatch is a rejection on its own
 * clause even after 1.2.1 is fixed. To publish a card: the heading is
 * `name ?? 'Starter'` with priceUsd ("Free" at 0), and the description is this
 * plan's `features` joined with '. ' plus a trailing '.', so the release checklist
 * can diff the listing against this output literally rather than by eye.
 * If you change a bullet here, change the dashboard in the same deploy.
 *
 * ACTION OUTSTANDING AT THE TIME OF WRITING: the published listing still carries
 * the pre-correction caller-ID bullets ("One shared caller ID" / "Your own caller
 * ID" / "Up to 3 numbers"), which described number tiering this app has never
 * implemented. All three plan-card descriptions must be re-published from this
 * function's current output before the resubmission — shipping the code fix while
 * the listing still advertises three numbers leaves 4.2.1 unanswered, which is the
 * precise failure mode the header of this file warns about.
 *
 * `current` is always false: which plan is current is entitlement state, not
 * pricing, and belongs to billing.js — it stamps the flag on the plan matching the
 * shop's entitlement before serving these. Objects and arrays are new on every call
 * precisely so that stamping cannot write through to the frozen PLANS map.
 *
 * Deliberately omitted: maxActiveAutomations and rank (internal gate mechanics,
 * not a price) and anything derived from Telenow's own per-minute cost catalog,
 * which is a margin input and must never reach the browser.
 */
export function publicPlans() {
  return Object.values(PLANS).map((plan) => ({
    handle: plan.handle,
    name: plan.name,
    priceUsd: plan.priceUsd,
    trialDays: plan.trialDays,
    includedMinutes: plan.includedMinutes,
    overagePerMinuteUsd: plan.overagePerMinuteUsd,
    capUsd: plan.capUsd,
    current: false,
    features: [...FEATURES[plan.handle]],
  }));
}
