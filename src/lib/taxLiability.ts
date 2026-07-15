// src/lib/taxLiability.ts
//
// Pure sales-tax / VAT liability helpers (no I/O, no GL, no React). The Tangerine
// tax module READS the GL tax-payable accounts (Xoro is the system of record) and
// reports filing-ready liability per jurisdiction. Nothing here posts or computes
// tax rates — rate calculation happens upstream in the sales channel / Xoro.
//
// Conventions:
//   • All money is INTEGER CENTS.
//   • COLLECTED = credits to the tax-payable account (tax charged to customers).
//   • REMITTED  = debits to the tax-payable account (tax paid to the authority).
//   • NET DUE (liability) = collected − remitted. Positive = owed to the authority;
//     negative = over-remitted / refund position.
//   • Periods are half-open by month and identified by their FIRST and LAST day
//     (YYYY-MM-DD, inclusive) so they map cleanly to GL posting-date ranges.

export type FilingFrequency = "monthly" | "quarterly" | "annual";

export const FILING_FREQUENCIES: readonly FilingFrequency[] = [
  "monthly",
  "quarterly",
  "annual",
] as const;

/** Net liability for a jurisdiction/period: collected − remitted (may be negative). */
export function netDueCents(collectedCents: number, remittedCents: number): number {
  return (Math.round(Number(collectedCents) || 0)) - (Math.round(Number(remittedCents) || 0));
}

/** Format integer cents as USD-style string, e.g. 1949139 → "$19,491.39" (−ve → "-$…"). */
export function formatCents(cents: number): string {
  const n = Math.round(Number(cents) || 0);
  const neg = n < 0;
  const abs = Math.abs(n);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const rem = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}$${dollars}.${rem}`;
}

interface YMD { y: number; m0: number; d: number }

function parseYMD(s: string | null | undefined): YMD | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const m0 = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (!Number.isFinite(y) || m0 < 0 || m0 > 11 || d < 1 || d > 31) return null;
  return { y, m0, d };
}

function iso(y: number, m0: number, d: number): string {
  return new Date(Date.UTC(y, m0, d)).toISOString().slice(0, 10);
}

/** Last calendar day of (year, monthIdx0), YYYY-MM-DD. */
function monthEndISO(y: number, m0: number): string {
  return new Date(Date.UTC(y, m0 + 1, 0)).toISOString().slice(0, 10);
}

/** Add `days` to an ISO date, returning ISO. */
export function addDaysISO(dateISO: string, days: number): string {
  const p = parseYMD(dateISO);
  if (!p) return dateISO;
  return new Date(Date.UTC(p.y, p.m0, p.d + days)).toISOString().slice(0, 10);
}

export interface Period {
  /** First day of the period, YYYY-MM-DD (inclusive). */
  start: string;
  /** Last day of the period, YYYY-MM-DD (inclusive). */
  end: string;
  /** Human label, e.g. "Jan 2026", "Q1 2026", "2026". */
  label: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The filing period (start/end/label) that CONTAINS the given reference date. */
export function periodBounds(frequency: FilingFrequency, refDateISO: string): Period {
  const p = parseYMD(refDateISO);
  const y = p ? p.y : new Date().getUTCFullYear();
  const m0 = p ? p.m0 : 0;
  if (frequency === "annual") {
    return { start: iso(y, 0, 1), end: iso(y, 11, 31), label: String(y) };
  }
  if (frequency === "quarterly") {
    const q = Math.floor(m0 / 3); // 0..3
    const startM = q * 3;
    return {
      start: iso(y, startM, 1),
      end: monthEndISO(y, startM + 2),
      label: `Q${q + 1} ${y}`,
    };
  }
  // monthly
  return { start: iso(y, m0, 1), end: monthEndISO(y, m0), label: `${MONTHS[m0]} ${y}` };
}

/**
 * All filing periods (chronological) whose span intersects [fromISO, toISO].
 * Periods are aligned to the frequency's natural calendar (month / calendar
 * quarter / calendar year), not to the from-date.
 */
export function enumeratePeriods(
  frequency: FilingFrequency,
  fromISO: string,
  toISO: string,
): Period[] {
  const from = parseYMD(fromISO);
  const to = parseYMD(toISO);
  if (!from || !to) return [];
  void to;
  const out: Period[] = [];
  // Walk from the period containing `from` until the period start passes `to`.
  let cursor = periodBounds(frequency, fromISO);
  let guard = 0;
  while (cursor.start <= toISO && guard < 2000) {
    out.push(cursor);
    // Advance one day past the current period end into the next period.
    cursor = periodBounds(frequency, addDaysISO(cursor.end, 1));
    guard++;
  }
  return out;
}

/**
 * Statutory due date for a period: period end + `graceDays`. Real authorities
 * differ (US states commonly the 20th of the following month; EU/UK VAT ~1 month
 * + a week after quarter end); the grace window is configured per jurisdiction so
 * this stays a pure, deterministic function.
 */
export function filingDueDateISO(periodEndISO: string, graceDays: number): string {
  return addDaysISO(periodEndISO, Math.max(0, Math.round(Number(graceDays) || 0)));
}

export type FilingStatus = "draft" | "filed" | "paid" | "upcoming" | "due" | "overdue";

/**
 * Effective status of a filing obligation. A recorded status (filed/paid) always
 * wins. Otherwise it is derived from the due date vs today:
 *   • today before period end            → "upcoming"
 *   • period ended, on/ before due date   → "due"
 *   • past due date                       → "overdue"
 */
export function filingStatus(
  periodEndISO: string,
  dueDateISO: string,
  todayISO: string,
  recordedStatus?: string | null,
): FilingStatus {
  const rec = String(recordedStatus || "").toLowerCase();
  if (rec === "filed") return "filed";
  if (rec === "paid") return "paid";
  if (todayISO <= periodEndISO) return "upcoming";
  if (todayISO <= dueDateISO) return "due";
  return "overdue";
}

export interface GLActivityRow {
  jurisdiction_code: string;
  credit_cents: number;
  debit_cents: number;
}

export interface JurisdictionLiability {
  jurisdiction_code: string;
  collected_cents: number;
  remitted_cents: number;
  net_due_cents: number;
}

/** Roll GL tax-account activity rows up to one liability row per jurisdiction. */
export function rollupByJurisdiction(rows: GLActivityRow[]): JurisdictionLiability[] {
  const map = new Map<string, JurisdictionLiability>();
  for (const r of rows || []) {
    const code = String(r.jurisdiction_code || "");
    if (!code) continue;
    const cur = map.get(code) || {
      jurisdiction_code: code,
      collected_cents: 0,
      remitted_cents: 0,
      net_due_cents: 0,
    };
    cur.collected_cents += Math.round(Number(r.credit_cents) || 0);
    cur.remitted_cents += Math.round(Number(r.debit_cents) || 0);
    cur.net_due_cents = netDueCents(cur.collected_cents, cur.remitted_cents);
    map.set(code, cur);
  }
  return Array.from(map.values()).sort((a, b) =>
    a.jurisdiction_code.localeCompare(b.jurisdiction_code),
  );
}

export interface LiabilitySummary {
  collected_cents: number;
  remitted_cents: number;
  net_due_cents: number;
  jurisdiction_count: number;
}

/** Totals across a set of jurisdiction liabilities. */
export function summarizeLiability(rows: JurisdictionLiability[]): LiabilitySummary {
  let collected = 0;
  let remitted = 0;
  for (const r of rows || []) {
    collected += Math.round(Number(r.collected_cents) || 0);
    remitted += Math.round(Number(r.remitted_cents) || 0);
  }
  return {
    collected_cents: collected,
    remitted_cents: remitted,
    net_due_cents: collected - remitted,
    jurisdiction_count: (rows || []).length,
  };
}
