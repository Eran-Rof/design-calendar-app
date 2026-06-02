// Regression guard for the income_statement() division-by-zero fix.
//
// The P5-3 RPC guarded p_basis with a SQL CASE whose ELSE was `(1/0)::text`.
// PostgreSQL folds that constant subexpression at plan time, so it threw
// "division by zero" on EVERY call (valid ACCRUAL/CASH included). The fix
// migration rewrites the function in plpgsql with an explicit RAISE.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, "../../../supabase/migrations/20260712000000_fix_income_statement_basis_divzero.sql"),
  "utf8",
);

describe("income_statement div-by-zero fix migration", () => {
  it("redefines the function with the same signature", () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION income_statement\s*\(\s*p_entity_id\s+uuid\s*,\s*p_basis\s+text\s*,\s*p_from_date\s+date\s*,\s*p_to_date\s+date\s*\)/,
    );
  });

  it("removes the constant (1/0) basis guard", () => {
    expect(sql).not.toMatch(/1\s*\/\s*0/);
  });

  it("validates basis with an explicit RAISE instead", () => {
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/NOT IN \('ACCRUAL', 'CASH'\)/);
  });

  it("is plpgsql + STABLE and preserves the sign conventions", () => {
    expect(sql).toMatch(/LANGUAGE plpgsql STABLE/);
    expect(sql).toMatch(/WHEN ga\.account_type = 'revenue'\s+THEN jel\.credit - jel\.debit/);
    expect(sql).toMatch(/je\.basis\s+=\s+v_basis/);
  });
});
