// ─────────────────────────────────────────────────────────────────────────────
// util/quietHours.js — "don't call during quiet hours" check.
//
// Merchants set a local window (e.g. 21:00–09:00 Asia/Kolkata) during which the
// app must not place calls. We evaluate the *current* wall-clock time in the
// configured IANA timezone and decide whether we're inside the window.
//
// Uses Intl.DateTimeFormat (built into Node) for timezone math — no deps.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ enabled?: boolean, start?: string, end?: string, timezone?: string }} QuietHours
 *   start/end are 24h "HH:MM" in the given IANA timezone. A window where start >
 *   end wraps midnight (e.g. 21:00→09:00 means 9pm tonight to 9am tomorrow).
 */

/** Parse "HH:MM" into minutes-since-midnight, or null if malformed. */
function parseHHMM(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Get the current minutes-since-midnight in a given IANA timezone.
 * @param {string} timeZone
 * @param {Date} [now]
 */
export function nowMinutesInTz(timeZone, now = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    return h * 60 + m;
  } catch {
    // Invalid timezone — fall back to server-local time.
    return now.getHours() * 60 + now.getMinutes();
  }
}

/**
 * Is "now" inside the quiet-hours window?
 * @param {QuietHours} quietHours
 * @param {Date} [now]
 * @returns {boolean}  true if calls should be suppressed right now.
 */
export function isQuietNow(quietHours, now = new Date()) {
  if (!quietHours || !quietHours.enabled) return false;
  const start = parseHHMM(quietHours.start);
  const end = parseHHMM(quietHours.end);
  if (start == null || end == null) return false;
  if (start === end) return false; // zero-width window → never quiet

  const tz = quietHours.timezone || 'Asia/Kolkata';
  const cur = nowMinutesInTz(tz, now);

  if (start < end) {
    // Same-day window, e.g. 13:00–14:00.
    return cur >= start && cur < end;
  }
  // Wraps midnight, e.g. 21:00–09:00.
  return cur >= start || cur < end;
}

/**
 * Compute the next time (Date) the quiet window ends, so a caller could schedule
 * a delayed call instead of dropping it. Best-effort; returns null if not quiet.
 *
 * NOTE: This is approximate (minute precision, assumes the window end is in the
 * same tz). Good enough to decide "retry after". For exact scheduling in
 * production, compute against the merchant's tz with a proper date lib.
 * @param {QuietHours} quietHours
 * @param {Date} [now]
 * @returns {Date|null}
 */
export function nextWindowEnd(quietHours, now = new Date()) {
  if (!isQuietNow(quietHours, now)) return null;
  const end = parseHHMM(quietHours.end);
  if (end == null) return null;
  const tz = quietHours.timezone || 'Asia/Kolkata';
  const cur = nowMinutesInTz(tz, now);
  // Minutes until the window end (handles wrap past midnight).
  const delta = cur < end ? end - cur : 24 * 60 - cur + end;
  return new Date(now.getTime() + delta * 60 * 1000);
}
