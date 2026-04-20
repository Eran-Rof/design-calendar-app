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

// ── Weekly (ISO 8601) helpers ──────────────────────────────────────────────
// Ecom planning uses ISO weeks (Monday-start, week 1 = the week containing
// the first Thursday of the year). period_code is "YYYY-Www" — same token
// git/GitHub/most ERPs use.
//
// All computation runs in UTC. Converting the local date is a foot-gun we
// already had to fix once in monthOf; keep the whole family UTC.

export interface IpWeekPeriod {
  period_code: string;     // "2026-W17"
  week_start: IpIsoDate;   // Monday, "2026-04-20"
  week_end: IpIsoDate;     // Sunday, "2026-04-26"
}

function padWeek(n: number): string { return n < 10 ? `0${n}` : String(n); }

function toUtc(iso: IpIsoDate): Date {
  return new Date(iso + "T00:00:00Z");
}

// Monday of the ISO week containing iso.
function mondayOf(iso: IpIsoDate): Date {
  const d = toUtc(iso);
  // getUTCDay: Sun=0 … Sat=6. Convert to Mon=0 … Sun=6.
  const dowMon = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dowMon);
  return d;
}

// ISO week number for a date, per ISO 8601.
function isoWeekNumber(d: Date): { year: number; week: number } {
  // Copy, because we're going to mutate.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (target.getUTCDay() + 6) % 7; // Mon=0
  target.setUTCDate(target.getUTCDate() - dow + 3);                 // Thursday of this week
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDow = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDow + 3);
  const diff = target.getTime() - firstThursday.getTime();
  const week = 1 + Math.round(diff / (7 * 86_400_000));
  return { year: target.getUTCFullYear(), week };
}

function toIso(d: Date): IpIsoDate {
  return d.toISOString().slice(0, 10);
}

export function weekOf(iso: IpIsoDate): IpWeekPeriod {
  const mon = mondayOf(iso);
  const sun = new Date(mon);
  sun.setUTCDate(sun.getUTCDate() + 6);
  const { year, week } = isoWeekNumber(mon);
  return {
    period_code: `${year}-W${padWeek(week)}`,
    week_start: toIso(mon),
    week_end: toIso(sun),
  };
}

// Enumerate weeks in [startIso, endIso] inclusive on the week they land in.
export function weeksBetween(startIso: IpIsoDate, endIso: IpIsoDate): IpWeekPeriod[] {
  const start = mondayOf(startIso);
  const endMonday = mondayOf(endIso);
  if (endMonday.getTime() < start.getTime()) return [];
  const out: IpWeekPeriod[] = [];
  const cur = new Date(start);
  while (cur.getTime() <= endMonday.getTime()) {
    out.push(weekOf(toIso(cur)));
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return out;
}

// Nth week before the week-of iso (n=0 returns the same week, n=1 previous).
export function weekOffset(iso: IpIsoDate, offset: number): IpWeekPeriod {
  const mon = mondayOf(iso);
  mon.setUTCDate(mon.getUTCDate() - 7 * offset);
  return weekOf(toIso(mon));
}

// Inclusive count of weeks between two mondays.
export function weeksDiff(fromIso: IpIsoDate, toIso: IpIsoDate): number {
  const a = mondayOf(fromIso).getTime();
  const b = mondayOf(toIso).getTime();
  return Math.round((b - a) / (7 * 86_400_000));
}
