// Static-shape tests for the P5-2 Trial Balance migration.
//
// Pure-text grep over the SQL file. We are NOT running the migration in CI;
// we just validate the bundle's shape so reviewers know the required pieces
// landed per arch §4.
//
// Per docs/tangerine/P5-close-core-financials-architecture.md §4.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../supabase/migrations/20260603000000_p5_chunk2_trial_balance.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");

describe("P5-2 Trial Balance migration", () => {
  it("file exists and is non-trivial", () => {
    expect(sql.length).toBeGreaterThan(800);
  });

  describe("v_trial_balance view", () => {
    it("declared as CREATE OR REPLACE VIEW", () => {
      expect(sql).toMatch(/CREATE OR REPLACE VIEW v_trial_balance\b/);
    });

    it("joins journal_entries, journal_entry_lines, gl_accounts", () => {
      expect(sql).toMatch(/FROM journal_entries je/);
      expect(sql).toMatch(/JOIN journal_entry_lines jel ON jel\.journal_entry_id = je\.id/);
      expect(sql).toMatch(/JOIN gl_accounts ga\s+ON ga\.id = jel\.account_id/);
    });

    it("filters je.status = 'posted'", () => {
      const m = sql.match(/CREATE OR REPLACE VIEW v_trial_balance[\s\S]*?GROUP BY/);
      expect(m).not.toBeNull();
      expect(m[0]).toMatch(/WHERE je\.status = 'posted'/);
    });

    it("groups by entity_id, basis, account_id, code, name, account_type, normal_balance", () => {
      expect(sql).toMatch(/GROUP BY je\.entity_id, je\.basis, jel\.account_id, ga\.code, ga\.name, ga\.account_type, ga\.normal_balance/);
    });

    it("returns SUM(debit) and SUM(credit)", () => {
      expect(sql).toMatch(/SUM\(jel\.debit\)\s+AS debit_cents/);
      expect(sql).toMatch(/SUM\(jel\.credit\)\s+AS credit_cents/);
    });

    it("returns both net_debit_cents and net_credit_cents", () => {
      expect(sql).toMatch(/SUM\(jel\.debit\) - SUM\(jel\.credit\)\s+AS net_debit_cents/);
      expect(sql).toMatch(/SUM\(jel\.credit\) - SUM\(jel\.debit\)\s+AS net_credit_cents/);
    });

    it("has COMMENT documenting the view", () => {
      expect(sql).toMatch(/COMMENT ON VIEW v_trial_balance IS/);
    });
  });

  describe("trial_balance() function", () => {
    it("declared as CREATE OR REPLACE FUNCTION with full signature", () => {
      expect(sql).toMatch(/CREATE OR REPLACE FUNCTION trial_balance\(/);
      expect(sql).toMatch(/p_entity_id\s+uuid/);
      expect(sql).toMatch(/p_basis\s+text/);
      expect(sql).toMatch(/p_from_date\s+date/);
      expect(sql).toMatch(/p_to_date\s+date/);
    });

    it("returns TABLE with the same columns as the view", () => {
      // Spot-check each column appears in the RETURNS TABLE clause.
      const m = sql.match(/RETURNS TABLE \(([\s\S]*?)\) AS \$\$/);
      expect(m).not.toBeNull();
      const cols = m[1];
      for (const c of [
        "entity_id",
        "basis",
        "account_id",
        "code",
        "name",
        "account_type",
        "normal_balance",
        "debit_cents",
        "credit_cents",
        "net_debit_cents",
        "net_credit_cents",
      ]) {
        expect(cols).toMatch(new RegExp(`\\b${c}\\b`));
      }
    });

    it("is marked STABLE", () => {
      expect(sql).toMatch(/LANGUAGE plpgsql STABLE/);
    });

    it("validates p_basis against ACCRUAL/CASH and raises 22023 on mismatch", () => {
      expect(sql).toMatch(/IF p_basis NOT IN \('ACCRUAL', 'CASH'\) THEN/);
      expect(sql).toMatch(/RAISE EXCEPTION 'trial_balance: p_basis must be one of/);
      expect(sql).toMatch(/ERRCODE = '22023'/);
    });

    it("filters by posting_date BETWEEN p_from_date AND p_to_date", () => {
      expect(sql).toMatch(/je\.posting_date BETWEEN p_from_date AND p_to_date/);
    });

    it("filters by entity_id and basis params", () => {
      expect(sql).toMatch(/AND je\.entity_id = p_entity_id/);
      expect(sql).toMatch(/AND je\.basis = p_basis/);
    });

    it("has COMMENT documenting the function", () => {
      expect(sql).toMatch(/COMMENT ON FUNCTION trial_balance\(uuid, text, date, date\) IS/);
    });
  });

  describe("schema reload", () => {
    it("issues NOTIFY pgrst 'reload schema' so PostgREST picks up the new view + RPC", () => {
      expect(sql).toMatch(/NOTIFY pgrst, 'reload schema'/);
    });
  });

  describe("migration tracking", () => {
    it("inserts version 20260603000000 into schema_migrations (defensive guard)", () => {
      expect(sql).toMatch(/'20260603000000', 'p5_chunk2_trial_balance'/);
      expect(sql).toMatch(/ON CONFLICT \(version\) DO NOTHING/);
    });
  });
});
