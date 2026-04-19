// Monthly period helpers. Kept in a tiny module so swapping to weekly
// later is a one-file change. Periods are expressed as (period_code,
// period_start, period_end) triples; code is "YYYY-MM" for months.
//
// All functions operate on ISO date strings ("YYYY-MM-DD"), never Date
// objects with a local TZ — month boundaries in local TZ are a common
// foot-gun. We construct dates with UTC and read/write the slice(0, 10).

import type { IpIsoDate } from "../types/entities";

export interface IpMonthPeriod {
  period_code: string;     // "2026-04"
  period_start: IpIsoDate; // "2026-04-01"
  period_end: IpIsoDate;   // "2026-04-30"
}

function padMonth(n: number): string { return n < 10 ? `0${n}` : String(n); }

export function monthOf(iso: IpIsoDate): IpMonthPeriod {
  const [y, m] = iso.split("-").map(Number);
  const start = `${y}-${padMonth(m)}-01`;
  // Day 0 of next month = last day of this month, in UTC.
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    period_code: `${y}-${padMonth(m)}`,
    period_start: start,
    period_end: `${y}-${padMonth(m)}-${padMonth(lastDay)}`,
  };
}

export function monthOfCode(code: string): IpMonthPeriod {
  return monthOf(`${code}-01`);
}

// Enumerate months in [startIso, endIso] inclusive. Returns empty if
// endIso < startIso. Iteration is month-by-month, never day-by-day.
export function monthsBetween(startIso: IpIsoDate, endIso: IpIsoDate): IpMonthPeriod[] {
  const [sy, sm] = startIso.split("-").map(Number);
  const [ey, em] = endIso.split("-").map(Number);
  const out: IpMonthPeriod[] = [];
  let y = sy; let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    out.push(monthOf(`${y}-${padMonth(m)}-01`));
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

// Return the month n months before the given iso date (for rolling
// windows). n=0 returns the same month, n=1 the previous month.
export function monthOffset(iso: IpIsoDate, offset: number): IpMonthPeriod {
  const [y, m] = iso.split("-").map(Number);
  const totalMonths = y * 12 + (m - 1) - offset;
  const ny = Math.floor(totalMonths / 12);
  const nm = (totalMonths % 12 + 12) % 12 + 1;
  return monthOf(`${ny}-${padMonth(nm)}-01`);
}

// Count months strictly between two iso dates. Useful for cadence.
export function monthsDiff(fromIso: IpIsoDate, toIso: IpIsoDate): number {
  const [fy, fm] = fromIso.split("-").map(Number);
  const [ty, tm] = toIso.split("-").map(Number);
  return (ty * 12 + tm) - (fy * 12 + fm);
}
