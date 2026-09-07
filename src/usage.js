// ─────────────────────────────────────────────────────────────────────────────
// usage.js — the per-shop AI-voice-minute ledger.
//
// Consumption (`usedMinutes`) is a monotonic counter: minutes go in, they never
// come back out, and no reconciliation pass tries to unwind a call that turned
// out to be free. The ledger is not the real ceiling anyway — on paid plans
// Shopify's merchant-approved `cappedAmount` is, and on starter the hard stop at
// 25 minutes costs the merchant nothing when it fires a minute late.
//
// Money is the exception. `billedMinutes` is advanced optimistically the moment
// minutes are offered for billing, and settleBilled() is the compensating half
// that gives them back when Shopify definitively refuses them; without it a
// rejected usage record silently forfeits the revenue it represented. Two
// invariants hold the money side together and are worth stating once here:
// minutes already consumed can never be re-priced as billable by a later plan
// change (the allowance is anchored to the window, not read live off the
// entitlement), and no single call.ended can ever emit an unbounded usage
// record (MAX_CARRY_MINUTES).
//
// State lives at `settings.usage`, so it rides the existing store.js
// persistence and is purged with the rest of the shop by deleteShop().
//
// Everything here is pure and synchronous: no network, no Shopify, no Telenow.
// The entitlement is always passed in by the caller (billing.js owns fetching
// and caching it) so that metering a webhook can never turn into an API call on
// the hot path of a call-ended notification.
// ─────────────────────────────────────────────────────────────────────────────

import { getSettings, updateSettings } from './settings.js';
import { planByHandle } from './plans.js';

/**
 * Starter has no Shopify subscription and therefore no billing period to anchor
 * to, so its allowance rolls on a fixed 30-day window of our own — the same
 * length as the EVERY_30_DAYS interval the paid plans use, so the merchant sees
 * one consistent "per 30 days" allowance across an upgrade.
 */
const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How many session ids we keep as the local double-count guard.
 *
 * The tradeoff, stated plainly: this list is persisted inside store.json, which
 * is rewritten whole on every settings write, so an unbounded set would make
 * every write of every shop's settings slower forever. Capping at the most
 * recent 500 ids means that if a shop burns through more than 500 calls in one
 * billing period AND Telenow then redelivers a webhook for one of the oldest of
 * them, that call's minutes are counted twice locally. We accept that because
 * it cannot produce a duplicate *charge*: appUsageRecordCreate is sent with
 * `idempotencyKey = "tn-usage-" + sessionId`, and Shopify rejects the repeat.
 * The worst case is therefore a slightly pessimistic local minute count, not
 * money moved twice.
 */
const MAX_BILLED_SESSIONS = 500;

/**
 * The circuit breaker on a single call.ended.
 *
 * Overage is derived — `used - included - alreadyOffered` — and every input to
 * that subtraction is a persisted number that a bug, a corrupted store.json or
 * a plan the entitlement disagrees with can put out of step. A derived number
 * that turns into a Shopify invoice needs a ceiling that is not itself derived:
 * one call.ended must never be able to emit a thousand-minute usage record,
 * whatever the arithmetic says, because that record is real money and it lands
 * before any human sees the log line.
 *
 * Nothing is forfeited by clamping. billedMinutes only ever advances by what we
 * actually return, so minutes held back here are still in the gap between
 * `used` and `billed` and are offered again by the next call in the period. The
 * clamp spreads a suspicious backlog over several calls instead of firing it in
 * one shot — which also gives the operator a chance to see it in the log before
 * the whole of it has been charged.
 */
const MAX_CARRY_MINUTES = 60;

/**
 * The ceiling on what one call.ended may claim to have consumed.
 *
 * `duration` arrives on a webhook body from outside this process and is
 * converted, unexamined, into minutes and then into money. A day is already an
 * order of magnitude past any real AI voice call, so a payload above it is a
 * bug, a unit mix-up (milliseconds arriving where seconds were expected costs
 * exactly 1000x) or a hostile POST — never a merchant who talked that long.
 * Capping costs us nothing we would ever legitimately bill and stops a single
 * malformed delivery from writing a four-figure usage record.
 */
const MAX_CALL_MINUTES = 24 * 60;

/** Parse an ISO string to epoch ms, or null for anything unusable. */
function ts(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** A whole, well-formed usage object, whatever shape (if any) was persisted. */
function normalize(raw) {
  const u = raw && typeof raw === 'object' ? raw : {};
  return {
    periodStart: typeof u.periodStart === 'string' ? u.periodStart : null,
    periodEnd: typeof u.periodEnd === 'string' ? u.periodEnd : null,
    usedMinutes: Number.isFinite(u.usedMinutes) && u.usedMinutes > 0 ? u.usedMinutes : 0,
    billedMinutes: Number.isFinite(u.billedMinutes) && u.billedMinutes > 0 ? u.billedMinutes : 0,
    billedSessions: Array.isArray(u.billedSessions)
      ? u.billedSessions.filter((id) => typeof id === 'string' && id)
      : [],
    warnedAt80: u.warnedAt80 === true,
    // The allowance this window's minutes were consumed under. null means the
    // window predates this field — written by the shape that read the allowance
    // live off the entitlement — and is treated as "whatever the plan says now",
    // which reproduces the old behaviour exactly for already-open windows rather
    // than inventing a history we cannot reconstruct. It is stamped on the first
    // write and is a number from then on.
    includedMinutesAtAnchor:
      Number.isFinite(u.includedMinutesAtAnchor) && u.includedMinutesAtAnchor >= 0
        ? u.includedMinutesAtAnchor
        : null,
    // Minutes counted into billedMinutes that Shopify has not confirmed. See
    // settleBilled().
    pendingBillMinutes:
      Number.isFinite(u.pendingBillMinutes) && u.pendingBillMinutes > 0 ? u.pendingBillMinutes : 0,
  };
}

/**
 * Read the ledger without touching it. Every entry point starts here rather
 * than trusting `settings.usage` to exist: shops installed before billing
 * shipped have no `usage` key at all, and a half-written one from an older
 * shape must not throw on the call-ended webhook path.
 */
function read(shop) {
  return normalize(getSettings(shop).usage);
}

/**
 * Persist a complete usage object. updateSettings shallow-merges the patch, so
 * `usage` is replaced wholesale — which is why every writer in this file builds
 * the full object rather than a partial one.
 */
function write(shop, usage) {
  updateSettings(shop, { usage });
  return usage;
}

/**
 * A fresh, zeroed window, anchored to the allowance in force when it opens.
 *
 * `includedMinutes` may be null when the caller has no entitlement in hand (a
 * render path that rolls the window before billing.js has ever spoken to
 * Shopify); the first metering write fills it in.
 */
function freshWindow(startMs, endMs, includedMinutes) {
  return {
    periodStart: new Date(startMs).toISOString(),
    periodEnd: new Date(endMs).toISOString(),
    usedMinutes: 0,
    billedMinutes: 0,
    billedSessions: [],
    warnedAt80: false,
    includedMinutesAtAnchor: Number.isFinite(includedMinutes) ? includedMinutes : null,
    pendingBillMinutes: 0,
  };
}

/**
 * Roll the allowance window forward when the billing period has moved on.
 *
 * On a paid plan the window is anchored to Shopify: `ent.currentPeriodEnd` is
 * the authority, and we roll the moment it moves past the end we last stored.
 * We take the *old* end as the new start where we can, so successive periods
 * are contiguous and a call landing in the seam is attributed to exactly one of
 * them; on an upgrade mid-window the old end is in the future and meaningless
 * as a start, so the new period starts now.
 *
 * On starter there is no Shopify period, so we advance a rolling 30-day window
 * in whole steps from the stored start. Whole steps rather than "now + 30 days"
 * so that a shop which places no calls for four months does not get its renewal
 * date silently dragged forward every time someone opens the app.
 *
 * Writes only when something actually changed — checkAccess() calls this on
 * every request, and rewriting store.json on every page view would be a real
 * cost for a file-backed store.
 *
 * @param {string} shop
 * @param {object} ent  the entitlement from billing.js (may be partial)
 * @returns {object} the current usage object
 */
export function rollIfNeeded(shop, ent) {
  const cur = read(shop);
  const now = Date.now();
  const prevEnd = ts(cur.periodEnd);
  const shopifyEnd = ts(ent && ent.currentPeriodEnd);
  // Only stamp an anchor when the caller actually knows the plan. A render path
  // that rolls the window before billing.js has ever resolved an entitlement
  // would otherwise anchor a paid shop at starter's 25 minutes; leaving it null
  // defers the decision to the first metering write, which always has one.
  const included = ent && ent.plan ? planByHandle(ent.plan).includedMinutes : null;

  if (shopifyEnd) {
    if (prevEnd && shopifyEnd <= prevEnd) return cur;
    const start = prevEnd && prevEnd <= now ? prevEnd : now;
    return write(shop, freshWindow(start, shopifyEnd, included));
  }

  if (!prevEnd) return write(shop, freshWindow(now, now + PERIOD_MS, included));
  if (now < prevEnd) return cur;

  const steps = Math.floor((now - prevEnd) / PERIOD_MS);
  const start = prevEnd + steps * PERIOD_MS;
  return write(shop, freshWindow(start, start + PERIOD_MS, included));
}

/**
 * Minutes consumed in the current period.
 * @param {string} shop
 * @returns {number}
 */
export function usedMinutes(shop) {
  return read(shop).usedMinutes;
}

/**
 * Minutes of the plan's included allowance still unspent this period. Never
 * negative: past the allowance a paid plan is into overage and starter is
 * stopped, and both of those are the caller's decision to make, not a negative
 * number to render.
 *
 * @param {string} shop
 * @param {object} ent
 * @returns {number}
 */
export function remainingIncluded(shop, ent) {
  const plan = planByHandle(ent && ent.plan);
  return Math.max(0, plan.includedMinutes - usedMinutes(shop));
}

/**
 * Record a completed call and report what of it is billable.
 *
 * IDEMPOTENT ON sessionId. Telenow retries a webhook it did not see a 200 for,
 * and `call.ended` is exactly the delivery we cannot afford to process twice —
 * a redelivery would both over-count the merchant's allowance and, without the
 * guard, try to create a second usage record for one call.
 *
 * Duration is billed in whole minutes, rounded up, with a floor of one minute
 * for any call that actually connected: a nine-second call still cost us a
 * carrier leg, an STT stream and a TTS render, and per-second billing on a
 * $0.12 unit is precision we would only use to under-charge ourselves.
 *
 * `billableMinutes` is the count above the window's included allowance that has
 * not already been reported to Shopify, so the caller can hand it straight to
 * appUsageRecordCreate. It is always 0 on starter — the free tier is never
 * billed, it is stopped by the spend gate instead. A caller that reports it
 * should tell settleBilled() how that went; see the note there for why the
 * counter moves before Shopify has answered.
 *
 * @param {string} shop
 * @param {string} sessionId  Telenow session id; the idempotency key
 * @param {number} seconds    real call duration from the call.ended payload
 * @param {object} ent
 * @returns {{billableMinutes:number, usedMinutes:number}}
 */
export function addMinutes(shop, sessionId, seconds, ent) {
  // Defensive, not redundant: metering runs from a webhook that reaches us
  // outside any request that would already have rolled the window, and adding a
  // minute to a stale period would charge it against the wrong allowance.
  const cur = rollIfNeeded(shop, ent);

  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (id && cur.billedSessions.includes(id)) {
    return { billableMinutes: 0, usedMinutes: cur.usedMinutes };
  }

  const secs = Number(seconds);
  const minutes =
    Number.isFinite(secs) && secs > 0
      ? Math.min(MAX_CALL_MINUTES, Math.max(1, Math.ceil(secs / 60)))
      : 0;

  // Nothing to record and nothing to dedupe against: leave the store alone.
  if (!minutes && !id) return { billableMinutes: 0, usedMinutes: cur.usedMinutes };

  const plan = planByHandle(ent && ent.plan);
  const used = cur.usedMinutes + minutes;

  // ── The allowance belongs to the WINDOW, not to the current entitlement ──
  //
  // Overage is `used - included`, and `used` is a running total for a window
  // that may have been open for weeks. Reading `included` live off the plan on
  // the entitlement therefore re-prices every minute already in that total
  // every time the plan changes. On a downgrade whose window did not roll — and
  // rollIfNeeded() deliberately does not roll when Shopify's currentPeriodEnd is
  // not later than the end we stored — 1,400 minutes consumed inside Scale's
  // 1,500 allowance become 1,100 minutes of Growth overage the instant the next
  // call lands, and the whole of it goes to Shopify as one usage record for a
  // merchant who did nothing but pick a cheaper plan.
  //
  // So the allowance is persisted with the window and only ever ratchets up:
  // an upgrade takes effect immediately for the rest of the period, a downgrade
  // takes effect at the next roll. That asymmetry is the point — it is the only
  // arrangement in which a minute that was free when it was spent cannot become
  // billable later. Being a little generous for the tail of one period is the
  // cheap side of this trade.
  const anchored = Number.isFinite(cur.includedMinutesAtAnchor)
    ? cur.includedMinutesAtAnchor
    : plan.includedMinutes;
  const included = Math.max(anchored, plan.includedMinutes);

  let billableMinutes = 0;
  if (plan.handle !== 'starter') {
    const overage = Math.max(0, used - included);
    billableMinutes = Math.max(0, overage - cur.billedMinutes);
    // Held-back minutes are not lost — see MAX_CARRY_MINUTES.
    billableMinutes = Math.min(billableMinutes, minutes + MAX_CARRY_MINUTES);
  }

  const billedSessions = cur.billedSessions.slice();
  // One list guards both the counter and the usage record. It is named for the
  // billing guard it was specified as, but it holds every session we counted —
  // a superset — because a redelivery must not move the local counter either,
  // and a shop on starter has no billed sessions to remember at all.
  if (id) {
    billedSessions.push(id);
    if (billedSessions.length > MAX_BILLED_SESSIONS) {
      billedSessions.splice(0, billedSessions.length - MAX_BILLED_SESSIONS);
    }
  }

  write(shop, {
    ...cur,
    usedMinutes: used,
    includedMinutesAtAnchor: included,
    billedMinutes: cur.billedMinutes + billableMinutes,
    // Counted as offered AND as unconfirmed. Both, deliberately: billedMinutes
    // must move now so that a second call arriving while the first usage record
    // is still in flight does not offer the same minutes again, and
    // pendingBillMinutes records that nothing has actually accepted them yet.
    pendingBillMinutes: cur.pendingBillMinutes + billableMinutes,
    billedSessions,
  });

  return { billableMinutes, usedMinutes: used };
}

/**
 * Close the loop on minutes that addMinutes() handed out.
 *
 * addMinutes() advances billedMinutes optimistically, because the alternative —
 * advancing it only after Shopify answers — leaves a window in which a second
 * call.ended offers the same minutes again under a different session id, and
 * the idempotency key is per session, so Shopify would take both. Optimistic is
 * the right default. What it costs is that a reportUsage() which never
 * succeeded still consumed the minutes: appUsageRecordCreate returns userErrors
 * when the record would breach the merchant-approved cappedAmount, the offline
 * token can be revoked, the plan can have flipped under billing.js's five
 * minute entitlement cache. Today the only trace of any of those is a
 * console.error, and the minutes are never offered again.
 *
 * This is the compensating half. Call it once for every non-zero
 * `billableMinutes`:
 *
 *   accepted === false → the minutes go back into the gap between `used` and
 *     `billed` and the next call in this period offers them again. Use it only
 *     for a DEFINITIVE rejection (userErrors, `reported:false`). A network
 *     timeout is not definitive: the record may well have landed, and re-offering
 *     it under a different session id would bill the merchant twice for one
 *     call. Settle those as accepted and under-charge ourselves — that is the
 *     side of the trade a merchant never has to write in to complain about.
 *   accepted !== false → the minutes are confirmed and simply leave the
 *     unconfirmed count.
 *
 * The amount is clamped to what is actually outstanding, so a duplicate or
 * over-large rejection cannot drive billedMinutes below the minutes Shopify
 * really did accept.
 *
 * Not calling this at all leaves behaviour exactly as it was before it existed
 * — billedMinutes has already moved, and pendingBillMinutes is inert bookkeeping
 * that a period roll clears.
 *
 * @param {string} shop
 * @param {number} minutes    the billableMinutes addMinutes() returned
 * @param {boolean} accepted  false only for a definitive rejection
 * @returns {{billedMinutes:number, pendingBillMinutes:number}}
 */
export function settleBilled(shop, minutes, accepted) {
  const cur = read(shop);
  const asked = Math.max(0, Math.ceil(Number(minutes) || 0));
  const settled = Math.min(asked, cur.pendingBillMinutes);
  if (!settled) {
    return { billedMinutes: cur.billedMinutes, pendingBillMinutes: cur.pendingBillMinutes };
  }

  const next = {
    ...cur,
    pendingBillMinutes: cur.pendingBillMinutes - settled,
    billedMinutes:
      accepted === false ? Math.max(0, cur.billedMinutes - settled) : cur.billedMinutes,
  };
  write(shop, next);
  return { billedMinutes: next.billedMinutes, pendingBillMinutes: next.pendingBillMinutes };
}

/**
 * One-shot "you have used 80% of your minutes" trigger for the UI banner.
 *
 * Returns true exactly once per period, on the first call after the threshold
 * is crossed, and latches so that reopening the app does not re-fire the
 * warning every few seconds. The latch is cleared by rollIfNeeded() along with
 * the counters, so the next period warns again.
 *
 * The plan comes from the persisted entitlement rather than a parameter because
 * the contract for this one is warn80(shop) — callers reach it from render
 * paths that have settings in hand but not necessarily an entitlement.
 *
 * @param {string} shop
 * @returns {boolean}
 */
export function warn80(shop) {
  const settings = getSettings(shop);
  const cur = normalize(settings.usage);
  if (cur.warnedAt80) return false;

  const plan = planByHandle(settings.billing && settings.billing.plan);
  if (!(plan.includedMinutes > 0)) return false;
  if (cur.usedMinutes < plan.includedMinutes * 0.8) return false;

  write(shop, { ...cur, warnedAt80: true });
  return true;
}
