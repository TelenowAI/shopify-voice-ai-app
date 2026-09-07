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
/*
 * TWO KINDS OF MONEY LIVE IN THE OBJECTS BELOW, AND THEY POINT IN OPPOSITE
 * DIRECTIONS. Read this before touching any number in this map.
 *
 *   priceUsd, overagePerMinuteUsd, capUsd  — money the MERCHANT pays US. These are
 *     revenue, they are merchant-visible, they appear on Shopify's approval screen
 *     and in the Partner Dashboard listing, and changing one is a billing event
 *     (see the header of this file).
 *
 *   costCeilingUsd — money WE let TELENOW SPEND on that shop's behalf in a billing
 *     period. This is cost, not revenue. It is never shown to the merchant, never
 *     charged to anyone, and never leaves the server except as the
 *     `monthlySpendCapUsd` we hand the partner API when a workspace is provisioned
 *     or its plan changes. It exists so that a shop cannot burn unbounded LLM, STT,
 *     TTS and carrier spend against a bounded amount of revenue.
 *
 * CONFUSING THE TWO IS HOW A PLAN SILENTLY BECOMES LOSS-MAKING. Nothing in the
 * billing path errors when the ceiling is wrong; the shop keeps working, calls keep
 * connecting, and the only symptom is an invoice from upstream that is larger than
 * the invoice we sent the merchant. That is why the ceiling lives here, next to the
 * price it is derived from, rather than in provisioning.js next to the code that
 * sends it — if the price ever moves, the ceiling is in the same diff.
 *
 * WHERE 0.45 COMES FROM. Our worst realistic delivered cost — the most expensive
 * stack this app can produce, on the longest prompts, over the priciest carrier —
 * is about 35% of the revenue that stack earns. The ceiling is set at 0.45 of what
 * the merchant is contractually able to pay us in a full billing period (the plan
 * fee plus the whole usage cap they approved), so the rule of thumb is
 *
 *     costCeilingUsd ≈ round(0.45 * (priceUsd + capUsd))
 *
 * The extra ten points over 35% are deliberate headroom: a ceiling that bites in a
 * normal busy month is an outage, not a safeguard. What it can never do is exceed
 * what the merchant is able to pay, which is the property that actually matters —
 * at 0.45 the worst case is a thin month, never an unbounded loss.
 *
 * The shipped figures are the founder-approved points on that ladder: Growth 135
 * and Scale 360 sit above the raw arithmetic (107.55 and 292.05 respectively) so
 * that a shop running hot at the top of its approved cap is not throttled mid-call,
 * while still landing well under the $239 and $649 those merchants can be billed.
 *
 * WHY STARTER'S 10 IS A HARD FLOOR AND NOT A COMPUTED VALUE. Starter has priceUsd 0
 * and capUsd 0, so the formula gives 0 — and 0 is the single most dangerous number
 * this field can carry. Upstream, a non-positive requested cap does not mean "spend
 * nothing", it means "I am not asking for a ceiling of my own", and the workspace
 * silently inherits the partner account's entire budget. A free shop would then be
 * the least constrained shop on the platform, which is exactly backwards, and it is
 * the containment the unauthenticated NDR webhook is supposed to sit behind. So
 * Starter is pinned at $10: enough to deliver its 25 included minutes with room to
 * spare, small enough that an abused free install cannot cost real money, and above
 * zero so the request is always read upstream as a real ceiling. Any future plan
 * whose formula result rounds to 0 must be pinned the same way — costCeilingFor()
 * enforces that as a last line of defence, but the value in this map should already
 * be positive on its own.
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
    costCeilingUsd: 10,
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
    costCeilingUsd: 135,
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
    costCeilingUsd: 360,
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
 * Internal handle → the USD amount we allow Telenow to spend on that shop in a
 * billing period. This is the ONLY way the ceiling should ever be read; callers
 * must not reach into PLANS[handle].costCeilingUsd themselves, because the whole
 * value of this function is the guarantee below.
 *
 * IT NEVER RETURNS 0, null, undefined or NaN. That guarantee is the point, not a
 * convenience. Upstream treats a non-positive `monthlySpendCapUsd` as "no ceiling
 * of my own" and falls back to the partner account's entire budget, so every way
 * this function could fail softly — an unknown handle from a stale entitlement, a
 * handle read off a webhook body, a plan row that somehow lost the field — must
 * still produce a real, positive number. A thrown error would be no better: the
 * callers are webhook and boot paths that must not break, so they would end up
 * sending nothing at all, which upstream reads as the same unbounded budget.
 *
 * Unknown or malformed input therefore lands on Starter's floor. That is the
 * deliberately conservative direction: the worst outcome of guessing low is a shop
 * that hits its ceiling and gets looked at, while the worst outcome of guessing
 * high is the uncapped workspace this field exists to prevent.
 */
export function costCeilingFor(planHandle) {
  const floor = PLANS.starter.costCeilingUsd;
  const plan = planByHandle(planHandle);
  const ceiling = Number(plan?.costCeilingUsd);
  return Number.isFinite(ceiling) && ceiling > 0 ? ceiling : floor;
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
