// src/lib/consolidation.ts
//
// Pure consolidation math for the multi-entity Consolidation panel (#NNNN).
//
// The server RPCs (consolidated_trial_balance / _income_statement /
// _balance_sheet) return LONG rows tagged with a `bucket` ('ENTITY' | 'ELIM')
// and an `entity_code`. This module pivots those long rows into a by-entity
// table — one line per account with a column per member entity, an Eliminations
// column, and a Consolidated column (= Σ entities + eliminations).
//
// No I/O here — all functions are pure so they can be unit-tested (see
// consolidation.test.ts). The GL itself is never mutated: eliminations are a
// reporting overlay, not journal entries.

export type ConsolBucket = "ENTITY" | "ELIM";

export const ELIM_KEY = "ELIM";
export const CONSOLIDATED_KEY = "CONSOLIDATED";

// ── Row shapes (mirror the RPC return columns) ──────────────────────────────
export interface ConsolTbRow {
  bucket: ConsolBucket;
  entity_code: string | null;
  entity_id?: string | null;
  account_id?: string | null;
  code: string;
  name: string;
  account_type: string;
  normal_balance: string;
  net_debit_cents: number | string;
  net_credit_cents: number | string;
  debit_cents: number | string;
  credit_cents: number | string;
}

export interface ConsolIsRow {
  bucket: ConsolBucket;
  entity_code: string | null;
  entity_id?: string | null;
  account_type: string;
  account_subtype: string | null;
  account_id?: string | null;
  code: string;
  name: string;
  amount_cents: number | string;
}

export interface ConsolBsRow {
  bucket: ConsolBucket;
  entity_code: string | null;
  entity_id?: string | null;
  account_type: string;
  account_id?: string | null;
  code: string;
  name: string;
  balance_cents: number | string;
}

// ── Pivoted output ──────────────────────────────────────────────────────────
// value = the signed cents for the statement in question:
//   TB → net_debit_cents (net debit positive / net credit negative)
//   IS → amount_cents (revenue & expense both positive contributions)
//   BS → balance_cents (positive normal balance)
export interface PivotLine {
  code: string;
  name: string;
  account_type: string;
  normal_balance?: string;
  /** entity_code → summed value (cents). Only member entities appear. */
  byEntity: Record<string, number>;
  /** eliminations column (cents). */
  elim: number;
  /** consolidated = Σ byEntity + elim (cents). */
  consolidated: number;
}

export interface PivotTotals {
  byEntity: Record<string, number>;
  elim: number;
  consolidated: number;
}

export interface PivotResult {
  lines: PivotLine[];
  totals: PivotTotals;
  /** entity codes seen, preserving the provided order. */
  entityCodes: string[];
}

const num = (v: number | string | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Generic long→wide pivot. Groups long rows by a composite key, distributing
 * each row's value into a member-entity column (bucket ENTITY) or the
 * eliminations column (bucket ELIM). Consolidated = Σ entity columns + elim.
 *
 * @param rows       long rows from a consolidated RPC
 * @param entityCodes ordered member entity codes (columns to render, even if $0)
 * @param keyOf      composite grouping key (e.g. account code)
 * @param valueOf    signed cents contributed by a row
 * @param metaOf     line metadata (name / type) taken from the first row seen
 */
export function pivotConsolidated<R extends { bucket: ConsolBucket; entity_code: string | null }>(
  rows: R[],
  entityCodes: string[],
  keyOf: (r: R) => string,
  valueOf: (r: R) => number,
  metaOf: (r: R) => Omit<PivotLine, "byEntity" | "elim" | "consolidated">,
): PivotResult {
  const byKey = new Map<string, PivotLine>();
  const order: string[] = [];

  for (const r of rows) {
    const key = keyOf(r);
    let line = byKey.get(key);
    if (!line) {
      const meta = metaOf(r);
      line = { ...meta, byEntity: {}, elim: 0, consolidated: 0 };
      for (const ec of entityCodes) line.byEntity[ec] = 0;
      byKey.set(key, line);
      order.push(key);
    }
    const v = valueOf(r);
    if (r.bucket === "ELIM") {
      line.elim += v;
    } else {
      const ec = r.entity_code ?? "";
      // Ensure the column exists even if it wasn't in entityCodes (defensive).
      if (!(ec in line.byEntity)) line.byEntity[ec] = 0;
      line.byEntity[ec] += v;
    }
  }

  // Consolidated per line + totals.
  const totals: PivotTotals = { byEntity: {}, elim: 0, consolidated: 0 };
  for (const ec of entityCodes) totals.byEntity[ec] = 0;

  const lines: PivotLine[] = [];
  for (const key of order) {
    const line = byKey.get(key)!;
    let consol = line.elim;
    for (const ec of Object.keys(line.byEntity)) {
      consol += line.byEntity[ec];
      totals.byEntity[ec] = (totals.byEntity[ec] ?? 0) + line.byEntity[ec];
    }
    line.consolidated = consol;
    totals.elim += line.elim;
    totals.consolidated += consol;
    lines.push(line);
  }

  lines.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return { lines, totals, entityCodes: [...entityCodes] };
}

/** Consolidated trial balance pivot (value = net_debit_cents). */
export function pivotTrialBalance(rows: ConsolTbRow[], entityCodes: string[]): PivotResult {
  return pivotConsolidated(
    rows,
    entityCodes,
    (r) => r.code,
    (r) => num(r.net_debit_cents),
    (r) => ({ code: r.code, name: r.name, account_type: r.account_type, normal_balance: r.normal_balance }),
  );
}

/** Consolidated income statement pivot (value = amount_cents). */
export function pivotIncomeStatement(rows: ConsolIsRow[], entityCodes: string[]): PivotResult {
  return pivotConsolidated(
    rows,
    entityCodes,
    (r) => `${r.account_type}|${r.code}`,
    (r) => num(r.amount_cents),
    (r) => ({ code: r.code, name: r.name, account_type: r.account_type }),
  );
}

/** Consolidated balance sheet pivot (value = balance_cents). */
export function pivotBalanceSheet(rows: ConsolBsRow[], entityCodes: string[]): PivotResult {
  return pivotConsolidated(
    rows,
    entityCodes,
    (r) => `${r.account_type}|${r.code}`,
    (r) => num(r.balance_cents),
    (r) => ({ code: r.code, name: r.name, account_type: r.account_type }),
  );
}

/**
 * Trial-balance balancing proof: the consolidated column must net to zero
 * (Σ net_debit − Σ net_credit = 0). Returns the residual cents (0 = balanced).
 */
export function trialBalanceResidualCents(pivot: PivotResult): number {
  return pivot.totals.consolidated;
}

/**
 * Net income (cents) for a given column of a consolidated income statement
 * pivot: Σ revenue − Σ contra_revenue − Σ expense. `col` is an entity code,
 * ELIM_KEY, or CONSOLIDATED_KEY.
 */
export function incomeStatementNetIncome(pivot: PivotResult, col: string): number {
  let ni = 0;
  for (const line of pivot.lines) {
    const v =
      col === CONSOLIDATED_KEY ? line.consolidated : col === ELIM_KEY ? line.elim : (line.byEntity[col] ?? 0);
    if (line.account_type === "revenue") ni += v;
    else if (line.account_type === "contra_revenue") ni -= v;
    else if (line.account_type === "expense") ni -= v;
  }
  return ni;
}

/** Column value for a line (entity code, ELIM_KEY, or CONSOLIDATED_KEY). */
export function lineColumnValue(line: PivotLine, col: string): number {
  if (col === CONSOLIDATED_KEY) return line.consolidated;
  if (col === ELIM_KEY) return line.elim;
  return line.byEntity[col] ?? 0;
}
