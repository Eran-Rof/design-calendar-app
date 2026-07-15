import { describe, it, expect } from "vitest";
import {
  pivotTrialBalance,
  pivotIncomeStatement,
  pivotBalanceSheet,
  trialBalanceResidualCents,
  incomeStatementNetIncome,
  lineColumnValue,
  CONSOLIDATED_KEY,
  ELIM_KEY,
  type ConsolTbRow,
  type ConsolIsRow,
  type ConsolBsRow,
} from "./consolidation";

// ── Trial balance ────────────────────────────────────────────────────────────
describe("pivotTrialBalance", () => {
  it("sums entities per account and computes consolidated = Σ entities + elim", () => {
    const rows: ConsolTbRow[] = [
      // ROF: cash 1000 DR, revenue 1000 CR (balanced)
      tb("ENTITY", "ROF", "1000", "Cash", "asset", "DEBIT", 100_00, 0),
      tb("ENTITY", "ROF", "4000", "Revenue", "revenue", "CREDIT", -100_00, 100_00),
      // SAG: cash 500 DR, revenue 500 CR (balanced)
      tb("ENTITY", "SAG", "1000", "Cash", "asset", "DEBIT", 50_00, 0),
      tb("ENTITY", "SAG", "4000", "Revenue", "revenue", "CREDIT", -50_00, 50_00),
    ];
    const p = pivotTrialBalance(rows, ["ROF", "SAG"]);
    const cash = p.lines.find((l) => l.code === "1000")!;
    expect(cash.byEntity.ROF).toBe(100_00);
    expect(cash.byEntity.SAG).toBe(50_00);
    expect(cash.elim).toBe(0);
    expect(cash.consolidated).toBe(150_00);
    // No eliminations → consolidated column nets to zero (balanced).
    expect(trialBalanceResidualCents(p)).toBe(0);
  });

  it("applies a balanced elimination pair and stays balanced", () => {
    // ROF intercompany receivable 1452 (DR 200) and payable 2504 (CR 200);
    // SAG mirror 1500 payable (CR 200) + 1600 receivable (DR 200).
    const rows: ConsolTbRow[] = [
      tb("ENTITY", "ROF", "1452", "Loan Recv - SAG", "asset", "DEBIT", 200_00, 0),
      tb("ENTITY", "ROF", "3000", "Equity", "equity", "CREDIT", -200_00, 200_00),
      tb("ENTITY", "SAG", "1500", "Loan Pay - ROF", "liability", "CREDIT", -200_00, 200_00),
      tb("ENTITY", "SAG", "3000", "Equity", "equity", "DEBIT", 200_00, 0),
      // Elimination: DR the SAG payable (1500) and CR the ROF receivable (1452), $200.
      tb("ELIM", "SAG", "1500", "Loan Pay - ROF", "liability", "CREDIT", 200_00, -200_00),
      tb("ELIM", "ROF", "1452", "Loan Recv - SAG", "asset", "DEBIT", -200_00, 200_00),
    ];
    const p = pivotTrialBalance(rows, ["ROF", "SAG"]);
    const recv = p.lines.find((l) => l.code === "1452")!;
    // ROF receivable 200 DR is fully eliminated → consolidated 0.
    expect(recv.byEntity.ROF).toBe(200_00);
    expect(recv.elim).toBe(-200_00);
    expect(recv.consolidated).toBe(0);
    const pay = p.lines.find((l) => l.code === "1500")!;
    // SAG payable -200 (net credit) + 200 elim → 0.
    expect(pay.consolidated).toBe(0);
    // Whole consolidated TB still balances.
    expect(trialBalanceResidualCents(p)).toBe(0);
  });

  it("renders every requested entity column even when an entity is dormant", () => {
    const rows: ConsolTbRow[] = [tb("ENTITY", "ROF", "1000", "Cash", "asset", "DEBIT", 10_00, 0)];
    const p = pivotTrialBalance(rows, ["ROF", "SAG"]);
    expect(p.entityCodes).toEqual(["ROF", "SAG"]);
    expect(p.lines[0].byEntity.SAG).toBe(0); // dormant column present, zeroed
    expect(p.totals.byEntity.SAG).toBe(0);
  });
});

// ── Income statement ─────────────────────────────────────────────────────────
describe("pivotIncomeStatement + net income", () => {
  it("nets income across entities and eliminates intercompany P&L at cost", () => {
    const rows: ConsolIsRow[] = [
      is("ENTITY", "ROF", "revenue", "4000", "Sales", 1000_00),
      is("ENTITY", "ROF", "expense", "6112", "Payroll to SAG", 300_00),
      is("ENTITY", "SAG", "expense", "6000", "Payroll reimb", 300_00),
      // Eliminate the intercompany recharge on both sides (−300 each).
      is("ELIM", "ROF", "expense", "6112", "Payroll to SAG", -300_00),
      is("ELIM", "SAG", "expense", "6000", "Payroll reimb", -300_00),
    ];
    const p = pivotIncomeStatement(rows, ["ROF", "SAG"]);
    // Standalone NI: ROF 1000 − 300 = 700; SAG −300. Sum = 400.
    expect(incomeStatementNetIncome(p, "ROF")).toBe(700_00);
    expect(incomeStatementNetIncome(p, "SAG")).toBe(-300_00);
    // Elimination removes 600 of expense (both legs) → NI impact +600.
    expect(incomeStatementNetIncome(p, ELIM_KEY)).toBe(600_00);
    // Consolidated NI = 400 + 600 = 1000 (only external revenue survives).
    expect(incomeStatementNetIncome(p, CONSOLIDATED_KEY)).toBe(1000_00);
  });
});

// ── Balance sheet ────────────────────────────────────────────────────────────
describe("pivotBalanceSheet", () => {
  it("keeps the accounting equation after eliminating a matched IC balance", () => {
    const rows: ConsolBsRow[] = [
      bs("ENTITY", "ROF", "asset", "1452", "Loan Recv - SAG", 200_00),
      bs("ENTITY", "SAG", "liability", "1500", "Loan Pay - ROF", 200_00),
      bs("ELIM", "ROF", "asset", "1452", "Loan Recv - SAG", -200_00),
      bs("ELIM", "SAG", "liability", "1500", "Loan Pay - ROF", -200_00),
    ];
    const p = pivotBalanceSheet(rows, ["ROF", "SAG"]);
    const assets = p.lines
      .filter((l) => l.account_type === "asset")
      .reduce((s, l) => s + lineColumnValue(l, CONSOLIDATED_KEY), 0);
    const liabs = p.lines
      .filter((l) => l.account_type === "liability")
      .reduce((s, l) => s + lineColumnValue(l, CONSOLIDATED_KEY), 0);
    // Both the receivable and payable eliminate to 0 → assets = liabilities = 0.
    expect(assets).toBe(0);
    expect(liabs).toBe(0);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────
function tb(
  bucket: "ENTITY" | "ELIM",
  entity_code: string,
  code: string,
  name: string,
  account_type: string,
  normal_balance: string,
  net_debit_cents: number,
  net_credit_cents: number,
): ConsolTbRow {
  return { bucket, entity_code, code, name, account_type, normal_balance, net_debit_cents, net_credit_cents, debit_cents: 0, credit_cents: 0 };
}
function is(
  bucket: "ENTITY" | "ELIM",
  entity_code: string,
  account_type: string,
  code: string,
  name: string,
  amount_cents: number,
): ConsolIsRow {
  return { bucket, entity_code, account_type, account_subtype: null, code, name, amount_cents };
}
function bs(
  bucket: "ENTITY" | "ELIM",
  entity_code: string,
  account_type: string,
  code: string,
  name: string,
  balance_cents: number,
): ConsolBsRow {
  return { bucket, entity_code, account_type, code, name, balance_cents };
}
