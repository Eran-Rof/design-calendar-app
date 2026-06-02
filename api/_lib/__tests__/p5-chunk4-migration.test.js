// Static-shape tests for the P5-4 Balance Sheet migration.
//
// Pure-text grep over the SQL file. Per arch §6.
//
// We are NOT running the migration in CI; we validate the bundle's shape so
// reviewers can confirm the required pieces landed (view, parameterized RPC,
// STABLE marker, CASE block on normal_balance, NOTIFY pgrst).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../supabase/migrations/20260603200000_p5_chunk4_balance_sheet.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");

describe("P5-4 Balance Sheet migration", () => {
  it("file exists and is non-trivial", () => {
    expect(sql.length).toBeGreaterThan(1500);
  });

  describe("v_balance_sheet view", () => {
    it("CREATE OR REPLACE VIEW v_balance_sheet exists", () => {
      expect(sql).toMatch(/CREATE OR REPLACE VIEW v_balance_sheet\b/);
    });

    it("filters to status='posted'", () => {
      const block = sql.split(/CREATE OR REPLACE VIEW v_balance_sheet/)[1].split(/CREATE OR REPLACE FUNCTION/)[0];
      expect(block).toMatch(/je\.status\s*=\s*'posted'/);
    });

    it("restricts account_type to asset / liability / equity / contra_asset", () => {
      const block = sql.split(/CREATE OR REPLACE VIEW v_balance_sheet/)[1].split(/CREATE OR REPLACE FUNCTION/)[0];
      expect(block).toMatch(/account_type IN \('asset'\s*,\s*'liability'\s*,\s*'equity'\s*,\s*'contra_asset'\)/);
    });

    it("CASE block branches on normal_balance DEBIT vs CREDIT", () => {
      const block = sql.split(/CREATE OR REPLACE VIEW v_balance_sheet/)[1].split(/CREATE OR REPLACE FUNCTION/)[0];
      expect(block).toMatch(/WHEN ga\.normal_balance\s*=\s*'DEBIT'\s+THEN jel\.debit\s*-\s*jel\.credit/);
      expect(block).toMatch(/WHEN ga\.normal_balance\s*=\s*'CREDIT'\s+THEN jel\.credit\s*-\s*jel\.debit/);
    });

    it("groups by entity_id, basis, account_type, code, name", () => {
      const block = sql.split(/CREATE OR REPLACE VIEW v_balance_sheet/)[1].split(/CREATE OR REPLACE FUNCTION/)[0];
      expect(block).toMatch(/GROUP BY je\.entity_id, je\.basis, ga\.account_type, ga\.code, ga\.name/);
    });

    it("joins journal_entries → journal_entry_lines → gl_accounts", () => {
      const block = sql.split(/CREATE OR REPLACE VIEW v_balance_sheet/)[1].split(/CREATE OR REPLACE FUNCTION/)[0];
      expect(block).toMatch(/FROM journal_entries je/);
      expect(block).toMatch(/JOIN journal_entry_lines jel/);
      expect(block).toMatch(/JOIN gl_accounts ga/);
    });
  });

  describe("balance_sheet_as_of function", () => {
    it("declares (p_entity_id uuid, p_basis text, p_as_of_date date)", () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION balance_sheet_as_of\(\s*p_entity_id\s+uuid\s*,\s*p_basis\s+text\s*,\s*p_as_of_date\s+date\s*\)/,
      );
    });

    it("is STABLE", () => {
      expect(sql).toMatch(/LANGUAGE sql STABLE/);
    });

    it("filters je.posting_date <= p_as_of_date", () => {
      expect(sql).toMatch(/je\.posting_date\s*<=\s*p_as_of_date/);
    });

    it("filters je.entity_id = p_entity_id + je.basis = p_basis", () => {
      expect(sql).toMatch(/je\.entity_id\s*=\s*p_entity_id/);
      expect(sql).toMatch(/je\.basis\s*=\s*p_basis/);
    });

    it("validates basis enum (ACCRUAL / CASH)", () => {
      expect(sql).toMatch(/p_basis IN \('ACCRUAL'\s*,\s*'CASH'\)/);
    });

    it("returns same row shape as the view", () => {
      const sig = sql.match(/RETURNS TABLE \(([\s\S]*?)\)/);
      expect(sig).not.toBeNull();
      const cols = sig[1];
      for (const c of ["entity_id", "basis", "account_type", "code", "name", "balance_cents"]) {
        expect(cols).toMatch(new RegExp(`\\b${c}\\b`));
      }
    });
  });

  describe("schema reload", () => {
    it("notifies PostgREST to reload the schema cache", () => {
      expect(sql).toMatch(/NOTIFY pgrst,\s*'reload schema'/);
    });
  });

  describe("migration tracking", () => {
    it("inserts version 20260603200000 into schema_migrations", () => {
      expect(sql).toMatch(/'20260603200000',\s*'p5_chunk4_balance_sheet'/);
    });
  });
});
