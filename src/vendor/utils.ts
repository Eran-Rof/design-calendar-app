// Vendor portal utility functions. Kept framework-agnostic so they're easy
// to unit-test.

/**
 * Extract a human-readable message from a thrown value. Supabase/PostgREST
 * rejections are plain objects with a `.message` (and often `.details`/`.hint`),
 * NOT Error instances — so `String(e)` renders the useless "[object Object]".
 * This pulls the real message out so the UI shows what actually failed.
 */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; details?: unknown; hint?: unknown };
    const parts = [o.message, o.details, o.hint].filter((x) => typeof x === "string" && x.length > 0);
    if (parts.length > 0) return parts.join(" — ");
    try { return JSON.stringify(e); } catch { /* fall through */ }
  }
  return String(e);
}

/**
 * Parse a date string as **local midnight** when it has no time component,
 * otherwise as the Date constructor normally would.
 *
 * Why: `new Date("2026-05-15")` is spec'd to parse as UTC midnight. In
 * negative-offset timezones (US), that becomes the previous local day —
 * so `toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })` shows the wrong day, and day-diff math
 * computes the wrong "overdue" flag. Splitting the string and constructing
 * with `new Date(y, m-1, d)` anchors to local midnight and fixes both.
 */
export function parseLocalDate(input?: string | null): Date | null {
  if (!input) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const dt = new Date(Number(y), Number(m) - 1, Number(d));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const dt = new Date(input);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * Local "today" formatted as YYYY-MM-DD. Use this for any default-value
 * date input — `new Date().toISOString().slice(0, 10)` returns UTC, which
 * jumps a day for users in negative-offset zones once UTC midnight passes
 * (vendors in Asia/Australia hit the same issue at the other end).
 */
export function todayLocalIso(now: Date = new Date()): string {
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${mm}-${dd}`;
}

/**
 * Format a Date object's local components as YYYY-MM-DD. Intended for
 * date pickers where the user picks a calendar day in their local zone
 * and we want to round-trip that same calendar day back into the input.
 */
export function dateToLocalIso(d: Date): string {
  return todayLocalIso(d);
}

export function fmtDate(d?: string | null): string {
  if (!d) return "—";
  const dt = parseLocalDate(d);
  if (!dt) return d;
  return dt.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
}

export function fmtMoney(n?: number | null): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/**
 * Whole-day difference from *today's local midnight* to the given date's
 * local midnight. Negative = in the past (overdue). Null for invalid input.
 *
 * Anchoring both sides to local midnight removes the time-of-day drift you
 * get from `(target.getTime() - Date.now()) / 86_400_000`, which would flip
 * sign as the day progresses.
 */
export function daysUntil(d?: string | null, now: Date = new Date()): number | null {
  const target = parseLocalDate(d);
  if (!target) return null;
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetMidnight = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  return Math.round((targetMidnight.getTime() - todayMidnight.getTime()) / 86_400_000);
}
