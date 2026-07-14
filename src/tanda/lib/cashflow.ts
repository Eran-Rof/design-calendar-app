// src/tanda/lib/cashflow.ts
//
// Pure helpers for the Cash Flow Statement panel.
//
//  1. classifyCashflowSection — the TS twin of the deterministic COA→section
//     mapping encoded in migration 20260993000000 (gl_accounts.cashflow_section).
//     It is the single source of truth ON THE CLIENT for "which section does a
//     balance-sheet account belong to", and is unit-tested against representative
//     ROF codes so the ranges cannot silently drift from the migration.
//
//  2. reconcileCashFlow — given the rows the RPC emits, derives the three section
//     subtotals, the net change, and whether the statement FOOTS
//     (beginning + net change = ending cash, within a cent). The RPC guarantees
//     this by construction; the helper lets the panel prove it to the operator
//     and lets tests assert it on fixtures.

export type CashflowSection = "operating" | "investing" | "financing" | "cash";

// Balance-sheet account → cash-flow section. Returns null for P&L accounts
// (revenue / contra_revenue / expense — they flow through Net Income) and for
// any balance-sheet account that falls outside the mapped ranges (surfaced as an
// explicit "unclassified" residual by the RPC, never hidden).
//
// Ranges MUST stay in lock-step with migration 20260993000000.
export function classifyCashflowSection(accountType: string, code: string): CashflowSection | null {
  const c = String(code || "");
  const between = (lo: string, hi: string) => c >= lo && c <= hi; // 4-digit codes, equal length
  const t = accountType;

  // P&L → Net Income (not a balance-sheet flow).
  if (t === "revenue" || t === "contra_revenue" || t === "expense") return null;

  // Cash & cash equivalents (Cash & Bank group).
  if (t === "asset" && between("1000", "1030")) return "cash";

  // ── Operating — working-capital assets ──
  if ((t === "asset" || t === "contra_asset") && between("1100", "1113")) return "operating"; // A/R
  if (t === "asset" && between("1050", "1051")) return "operating";                             // factor advances
  if (t === "asset" && between("1200", "1210")) return "operating";                             // inventory
  if (t === "asset" && (between("1300", "1303") || c === "1308" || between("1400", "1409"))) return "operating"; // prepaid + other current

  // ── Investing — long-term assets ──
  if ((t === "asset" || t === "contra_asset") && between("1500", "1599")) return "investing";   // PP&E (+ accum deprec)
  if (t === "asset" && (between("1304", "1307") || between("1600", "1699"))) return "investing"; // deposits + intangibles
  if (t === "asset" && between("1450", "1455")) return "investing";                              // loans/notes receivable

  // ── Operating — working-capital liabilities ──
  if (t === "liability" && between("2000", "2001")) return "operating";                          // A/P
  if (t === "liability" && (between("2010", "2021") || c === "2160" || c === "2450")) return "operating"; // accrued
  if (t === "liability" && between("2100", "2108")) return "operating";                          // credit cards
  if (t === "liability" && between("2200", "2201")) return "operating";                          // customer deposits / unearned
  if (t === "liability" && between("2300", "2315")) return "operating";                          // taxes payable
  if (t === "liability" && between("2400", "2412")) return "operating";                          // payroll liabilities

  // ── Financing — debt ──
  if (t === "liability" && (between("2250", "2251") || between("2451", "2452") || between("2500", "2599") || between("2700", "2703"))) return "financing";
  if (t === "liability" && c === "2460") return "financing";                                     // factor loan
  if (t === "liability" && between("2800", "2805")) return "financing";                          // SBA / government loans

  // ── Financing — equity (contributions / distributions / retained earnings) ──
  if (t === "equity") return "financing";

  return null; // unmapped balance-sheet account → residual
}

export type CashflowRow = { section: string; line_item: string; amount_cents: number };

export type CashflowReconciliation = {
  operating: number;
  investing: number;
  financing: number;
  netChange: number;
  beginningCash: number;
  endingCash: number;
  computedEnding: number;
  gap: number;       // computedEnding − endingCash (cents)
  foots: boolean;    // |gap| < 1 cent
};

// Section subtotal = the "Net cash from <section> activities" row (defensive
// prefix match so extra detail lines never change the total).
function sectionSubtotal(rows: CashflowRow[], section: string): number {
  const r = rows.find(
    (x) => x.section === section && x.line_item.toLowerCase().startsWith("net cash from"),
  );
  return r ? Number(r.amount_cents || 0) : 0;
}

function cashRef(rows: CashflowRow[], lineItem: string): number {
  const r = rows.find((x) => x.section === "_cash_reference" && x.line_item === lineItem);
  return r ? Number(r.amount_cents || 0) : 0;
}

export function reconcileCashFlow(rows: CashflowRow[]): CashflowReconciliation {
  const operating = sectionSubtotal(rows, "operating");
  const investing = sectionSubtotal(rows, "investing");
  const financing = sectionSubtotal(rows, "financing");
  const netChange = operating + investing + financing;
  const beginningCash = cashRef(rows, "Beginning Cash");
  const endingCash = cashRef(rows, "Ending Cash");
  const computedEnding = beginningCash + netChange;
  const gap = computedEnding - endingCash;
  return {
    operating, investing, financing, netChange,
    beginningCash, endingCash, computedEnding, gap,
    foots: Math.abs(gap) < 1,
  };
}
