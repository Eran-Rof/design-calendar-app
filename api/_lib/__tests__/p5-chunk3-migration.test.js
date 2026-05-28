// Static-shape tests for the P5-3 Income Statement migration.
//
// Pure-text grep over the SQL file. We are NOT running the migration in CI;
// we just validate the bundle's shape so reviewers know the required pieces
// landed (view + RPC, sign convention, STABLE, basis validation).
//
// Per docs/tangerine/P5-close-core-financials-architecture.md §5.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../supabase/migrations/20260603100000_p5_chunk3_income_statement.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");

describe("P5-3 Income Statement migration", () => {
  it("file exists and is non-trivial", () => {
    expect(sql.length).toBeGreaterThan(1000);
  });

  // ── View ─────────────────────────────────────────────────────────────────
  describe("v_income_statement view", () => {
    it("uses CREATE OR REPLACE VIEW for idempotency", () => {
      expect(sql).toMatch(/CREATE OR REPLACE VIEW v_income_statement\b/);
    });

    it("filters to posted JEs only", () => {
      expect(sql).toMatch(/je\.status\s*=\s*'posted'/);
    });

    it("restricts to revenue / contra_revenue / expense account types", () => {
      expect(sql).toMatch(/account_type IN \(\s*'revenue'\s*,\s*'contra_revenue'\s*,\s*'expense'\s*\)/);
    });

    it("revenue sign convention is credit - debit", () => {
      // Per arch §5.1: revenue accounts are CR-positive.
      expect(sql).toMatch(/WHEN ga\.account_type = 'revenue'\s+THEN jel\.credit\s*-\s*jel\.debit/);
    });

    it("contra_revenue sign convention is debit - credit", () => {
      expect(sql).toMatch(/WHEN ga\.account_type = 'contra_revenue'\s+THEN jel\.debit\s*-\s*jel\.credit/);
    });

    it("expense sign convention is debit - credit", () => {
      expect(sql).toMatch(/WHEN ga\.account_type = 'expense'\s+THEN jel\.debit\s*-\s*jel\.credit/);
    });

    it("groups by entity_id, basis, year, month, account_type, code, name", () => {
      // Grouping must align with the SELECT projection per arch §5.1.
      expect(sql).toMatch(/GROUP BY[\s\S]*?je\.entity_id[\s\S]*?je\.basis[\s\S]*?account_type[\s\S]*?ga\.code[\s\S]*?ga\.name/);
    });

    it("projects an amount_cents column", () => {
      expect(sql).toMatch(/AS amount_cents/);
    });
  });

  // ── RPC ──────────────────────────────────────────────────────────────────
  describe("income_statement() RPC", () => {
    it("creates the function with the required signature", () => {
      expect(sql).toMatch(/CREATE OR REPLACE FUNCTION income_statement\s*\(\s*p_entity_id\s+uuid\s*,\s*p_basis\s+text\s*,\s*p_from_date\s+date\s*,\s*p_to_date\s+date\s*\)/);
    });

    it("is marked STABLE", () => {
      expect(sql).toMatch(/LANGUAGE sql STABLE/);
    });

    it("validates basis to be ACCRUAL or CASH", () => {
      // The migration enforces this by uppercasing and matching against
      // {ACCRUAL, CASH}; anything else triggers a div-by-zero failure.
      expect(sql).toMatch(/upper\(p_basis\) IN \(\s*'ACCRUAL'\s*,\s*'CASH'\s*\)/);
    });

    it("filters by posting_date range using p_from_date and p_to_date", () => {
      expect(sql).toMatch(/je\.posting_date BETWEEN p_from_date AND p_to_date/);
    });

    it("only includes posted entries for the target entity", () => {
      expect(sql).toMatch(/je\.entity_id\s*=\s*p_entity_id/);
      expect(sql).toMatch(/je\.status\s*=\s*'posted'/);
    });
  });

  // ── PostgREST reload ─────────────────────────────────────────────────────
  it("ends with a NOTIFY pgrst, 'reload schema' so the API picks up the RPC", () => {
    expect(sql).toMatch(/NOTIFY pgrst,\s*'reload schema'/);
  });
});
