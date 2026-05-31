// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(__dirname, "../../../supabase/migrations/20260710060000_m50_chunk_a_gl_brand_allocation_schema.sql"),
  "utf8",
);

describe("M50-A — GL brand allocation schema", () => {
  it("adds brand markers to gl_accounts (brand_id FK + brand_rollup)", () => {
    expect(SQL).toMatch(/ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES brand_master\(id\)/);
    expect(SQL).toMatch(/ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS brand_rollup boolean NOT NULL DEFAULT false/);
  });

  it("creates brand_account_allocations keyed (account, brand) with a 0-100 pct", () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS brand_account_allocations/);
    expect(SQL).toMatch(/pct\s+numeric\(7,4\) NOT NULL CHECK \(pct >= 0 AND pct <= 100\)/);
    expect(SQL).toMatch(/PRIMARY KEY \(account_id, brand_id\)/);
  });

  it("enforces one default brand per account + a deferred SUM(pct)=100 check", () => {
    expect(SQL).toMatch(/uq_brand_acct_alloc_default[\s\S]*WHERE is_default/);
    expect(SQL).toMatch(/CREATE CONSTRAINT TRIGGER trg_brand_acct_alloc_sum[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
    expect(SQL).toMatch(/must total 100/);
  });

  it("audits the rule table + is anon read-only (writes via service-role)", () => {
    expect(SQL).toMatch(/trg_brand_acct_alloc_audit[\s\S]*audit_row_changes_trigger\(\)/);
    expect(SQL).toMatch(/CREATE POLICY "anon_read_brand_acct_alloc" ON brand_account_allocations FOR SELECT TO anon USING \(true\)/);
    expect(SQL).not.toMatch(/FOR ALL TO anon/);
  });

  it("does not change posting behavior (no JE/posting writes here) + reloads PostgREST", () => {
    expect(SQL).not.toMatch(/INSERT INTO journal_entr/);
    expect(SQL).toMatch(/NOTIFY pgrst/);
  });
});
