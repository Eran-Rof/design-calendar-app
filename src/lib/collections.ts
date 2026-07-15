// src/lib/collections.ts
//
// Pure helpers for the AR Collections workflow — aging buckets, promise-to-pay
// classification, and KPI roll-ups. No I/O, no React: unit-tested in
// collections.test.ts and shared by InternalCollections.tsx. The server view
// (v_ar_collections_worklist / _promises) computes the same classifications in
// SQL; these mirror that logic exactly so client and server agree.

export type BucketKey = "current" | "1-30" | "31-60" | "61-90" | "91-120" | "120+";

export const BUCKET_ORDER: BucketKey[] = ["current", "1-30", "31-60", "61-90", "91-120", "120+"];

export const BUCKET_LABEL: Record<BucketKey, string> = {
  current: "Current",
  "1-30": "1-30",
  "31-60": "31-60",
  "61-90": "61-90",
  "91-120": "91-120",
  "120+": "120+",
};

// Deepening red as the debt ages (mirrors InternalARAging palette).
export const BUCKET_COLOR: Record<BucketKey, string> = {
  current: "#CBD5E1",
  "1-30": "#FACC15",
  "31-60": "#FB923C",
  "61-90": "#F87171",
  "91-120": "#EF4444",
  "120+": "#DC2626",
};

export type PromiseState = "upcoming" | "due_today" | "broken";

function toDate(iso: string): Date {
  return new Date(iso + "T00:00:00Z");
}

// Whole days between two YYYY-MM-DD dates (asOf - ref). Positive = ref is in the
// past (past due). Matches Postgres `CURRENT_DATE - date`.
export function daysBetween(refISO: string, asOfISO: string): number {
  const ms = toDate(asOfISO).getTime() - toDate(refISO).getTime();
  return Math.round(ms / 86_400_000);
}

// Days past due relative to a reference date (due_date, else invoice_date).
export function daysPastDue(dueOrInvoiceISO: string, asOfISO: string): number {
  return daysBetween(dueOrInvoiceISO, asOfISO);
}

export function ageBucket(daysPastDueVal: number): BucketKey {
  if (daysPastDueVal <= 0) return "current";
  if (daysPastDueVal <= 30) return "1-30";
  if (daysPastDueVal <= 60) return "31-60";
  if (daysPastDueVal <= 90) return "61-90";
  if (daysPastDueVal <= 120) return "91-120";
  return "120+";
}

// A promise is broken once its date is in the past; due_today the day of; else
// upcoming. (The server additionally gates on is_latest — see summarizePromises.)
export function promiseState(promiseDateISO: string, asOfISO: string): PromiseState {
  const dpd = daysBetween(promiseDateISO, asOfISO);
  if (dpd < 0) return "upcoming";
  if (dpd === 0) return "due_today";
  return "broken";
}

export function isPromiseBroken(promiseDateISO: string, asOfISO: string): boolean {
  return promiseState(promiseDateISO, asOfISO) === "broken";
}

export type PromiseRow = {
  promise_amount_cents?: number | string | null;
  promise_date?: string | null;
  is_latest?: boolean;
  promise_state?: PromiseState | null;
};

export type PromiseSummary = {
  promisedCents: number;   // upcoming + due_today (money we still expect)
  promisedCount: number;
  brokenCents: number;     // promises whose date has passed
  brokenCount: number;
};

// Roll up a promise pipeline into KPI figures. Only the LATEST promise per
// invoice/customer counts, so an old broken promise superseded by a new one
// does not double-count (is_latest is set by the server view).
export function summarizePromises(rows: PromiseRow[], asOfISO?: string): PromiseSummary {
  const out: PromiseSummary = { promisedCents: 0, promisedCount: 0, brokenCents: 0, brokenCount: 0 };
  for (const r of rows) {
    if (r.is_latest === false) continue;
    const amt = Number(r.promise_amount_cents ?? 0) || 0;
    let state = r.promise_state ?? null;
    if (!state && r.promise_date && asOfISO) state = promiseState(r.promise_date, asOfISO);
    if (state === "broken") {
      out.brokenCents += amt;
      out.brokenCount += 1;
    } else if (state === "upcoming" || state === "due_today") {
      out.promisedCents += amt;
      out.promisedCount += 1;
    }
  }
  return out;
}

export type BucketRow = { age_bucket?: string | null; open_cents?: number | string | null };

// Sum open balance per aging bucket over a set of invoice rows (used for the
// KPI header / customer aging summary). Always returns all six buckets.
export function rollupBuckets(rows: BucketRow[]): Record<BucketKey, number> {
  const acc: Record<BucketKey, number> = {
    current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "91-120": 0, "120+": 0,
  };
  for (const r of rows) {
    const b = (r.age_bucket || "") as BucketKey;
    if (b in acc) acc[b] += Number(r.open_cents ?? 0) || 0;
  }
  return acc;
}

export function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0);
  if (!Number.isFinite(n) || n === 0) return "—";
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}

// MM/DD/YYYY (house date format) from a YYYY-MM-DD string. "—" when empty.
export function fmtDateUS(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1]}`;
}
