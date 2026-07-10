import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  resolve(__dirname, "../../../supabase/migrations/20260970000000_gl_reports_true_cents.sql"),
  "utf8",
);

describe("gl_reports_true_cents migration", () => {
  it("recreates every affected GL report object", () => {
    expect(SQL).toMatch(/CREATE OR REPLACE VIEW v_trial_balance\b/);
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION trial_balance\(/);
    expect(SQL).toMatch(/CREATE OR REPLACE VIEW v_income_statement\b/);
    expect(SQL).toMatch(/CREATE FUNCTION income_statement\(/);
    expect(SQL).toMatch(/CREATE OR REPLACE VIEW v_balance_sheet\b/);
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION balance_sheet_as_of\(/);
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION cash_flow_indirect\(/);
  });

  it("scales trial-balance debit/credit columns to TRUE cents (× 100)", () => {
    expect(SQL).toMatch(/ROUND\(SUM\(jel\.debit\)\s*\*\s*100\)::bigint\s+AS debit_cents/);
    expect(SQL).toMatch(/ROUND\(SUM\(jel\.credit\)\s*\*\s*100\)::bigint\s+AS credit_cents/);
    expect(SQL).toMatch(/net_debit_cents/);
    expect(SQL).toMatch(/net_credit_cents/);
  });

  it("scales income-statement amount_cents to TRUE cents (× 100)", () => {
    // Two occurrences: the view and the RPC.
    const matches = SQL.match(/\)\s*\*\s*100\)::bigint AS amount_cents/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves the income-statement sign convention", () => {
    expect(SQL).toMatch(/WHEN ga\.account_type = 'revenue'\s+THEN jel\.credit - jel\.debit/);
    expect(SQL).toMatch(/WHEN ga\.account_type = 'contra_revenue'\s+THEN jel\.debit\s+- jel\.credit/);
    expect(SQL).toMatch(/WHEN ga\.account_type = 'expense'\s+THEN jel\.debit\s+- jel\.credit/);
  });

  it("keeps account_subtype on the income statement (p16)", () => {
    expect(SQL).toMatch(/account_subtype text/);
    expect(SQL).toMatch(/ga\.account_subtype/);
  });

  it("scales balance_sheet balance_cents to TRUE cents (× 100)", () => {
    const matches = SQL.match(/\)\s*\*\s*100\)::bigint AS balance_cents/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2); // view + RPC
  });

  it("income_statement guards basis without a constant divide-by-zero", () => {
    expect(SQL).not.toMatch(/1\s*\/\s*0/);
    expect(SQL).toMatch(/upper\(p_basis\) IN \('ACCRUAL','CASH'\)/);
  });

  it("registers itself in schema_migrations", () => {
    expect(SQL).toMatch(/'20260970000000', 'gl_reports_true_cents'/);
  });
});
