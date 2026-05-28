// Static-shape sanity checks on the P5-6 migration file.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(
  __dirname,
  "../../../supabase/migrations/20260605000000_p5_chunk6_year_end_close.sql",
);
const SQL = readFileSync(MIGRATION_PATH, "utf8");

describe("P5-6 migration — static shape", () => {
  it("adds entities.default_retained_earnings_account_id FK", () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS default_retained_earnings_account_id uuid/);
    expect(SQL).toMatch(/REFERENCES gl_accounts\(id\) ON DELETE SET NULL/);
  });
  it("indexes the new FK column partial NOT NULL", () => {
    expect(SQL).toMatch(/idx_entities_default_retained_earnings/);
    expect(SQL).toMatch(/WHERE default_retained_earnings_account_id IS NOT NULL/);
  });
  it("auto-wires ROF to code='3500' if present", () => {
    expect(SQL).toMatch(/code = '3500'/);
    expect(SQL).toMatch(/account_type = 'equity'/);
    expect(SQL).toMatch(/UPDATE entities/);
    expect(SQL).toMatch(/default_retained_earnings_account_id IS NULL/);
  });

  it("defines gl_post_year_end_close RPC with correct signature", () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION gl_post_year_end_close/);
    expect(SQL).toMatch(/p_entity_id\s+uuid/);
    expect(SQL).toMatch(/p_fiscal_year smallint/);
    expect(SQL).toMatch(/p_dry_run\s+boolean DEFAULT true/);
    expect(SQL).toMatch(/RETURNS jsonb/);
  });

  it("RPC errors when default_retained_earnings_account_id is NULL", () => {
    expect(SQL).toMatch(/has no default_retained_earnings_account_id/);
  });
  it("RPC blocks re-run via closed_with_closing_jes status check", () => {
    expect(SQL).toMatch(/status = 'closed_with_closing_jes'/);
    expect(SQL).toMatch(/cannot re-run year-end close/);
  });

  it("RPC aggregates posted JEs for revenue + contra_revenue + expense", () => {
    expect(SQL).toMatch(/account_type IN \('revenue','contra_revenue','expense'\)/);
    expect(SQL).toMatch(/je\.status = 'posted'/);
  });

  it("RPC iterates both ACCRUAL and CASH bases", () => {
    expect(SQL).toMatch(/ARRAY\['ACCRUAL','CASH'\]/);
  });

  it("RPC builds closing JE flipping each side correctly", () => {
    // revenue (CR-positive normal) closes with a DR
    expect(SQL).toMatch(/IF v_account\.account_type = 'revenue' THEN/);
    // expense closes with a CR
    expect(SQL).toMatch(/ELSE\s+--\s*expense/);
    // retained earnings plug uses the FK
    expect(SQL).toMatch(/v_re_account_id/);
  });

  it("RPC converts cents to dollars when passing to gl_post_journal_entry", () => {
    expect(SQL).toMatch(/::numeric \/ 100/);
  });

  it("RPC flips all 12 periods to closed_with_closing_jes on live run", () => {
    expect(SQL).toMatch(/SET status = 'closed_with_closing_jes'/);
    expect(SQL).toMatch(/IF NOT p_dry_run THEN/);
  });

  it("RPC sibling-links accrual + cash JEs via gl_link_sibling_je", () => {
    expect(SQL).toMatch(/gl_link_sibling_je\(v_accrual_je_id, v_cash_je_id\)/);
  });

  it("RPC returns the projected breakdown for both bases", () => {
    expect(SQL).toMatch(/basis_breakdown/);
    expect(SQL).toMatch(/projected_lines/);
  });

  it("ends with NOTIFY pgrst reload schema", () => {
    expect(SQL).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
  });
});
