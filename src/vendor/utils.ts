// Vendor portal utility functions. Kept framework-agnostic so they're easy
// to unit-test.

/**
 * Parse a date string as **local midnight** when it has no time component,
 * otherwise as the Date constructor normally would.
 *
 * Why: `new Date("2026-05-15")` is spec'd to parse as UTC midnight. In
 * negative-offset timezones (US), that becomes the previous local day —
 * so `toLocaleDateString()` shows the wrong day, and day-diff math
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

export function fmtDate(d?: string | null): string {
  if (!d) return "—";
  const dt = parseLocalDate(d);
  if (!dt) return d;
  return dt.toLocaleDateString();
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
