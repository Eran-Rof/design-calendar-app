// Static-shape sanity checks on the Month-End Close migration — same pattern
// as p5-chunk6-migration.test.js. Guards the two things that must never
// regress: (1) the close checklist schema + read-only checks RPC, and (2) the
// gl_post_year_end_close 100x scaling fix (journal_entry_lines.debit/credit
// are numeric DOLLARS; the original P5-6 function labeled raw dollar sums
// "amount_cents" and divided by 100, so every closing JE would have posted at
// 1/100 of the true amount).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(
  __dirname,
  "../../../supabase/migrations/20260972000000_month_end_close.sql",
);
const SQL = readFileSync(MIGRATION_PATH, "utf8");

describe("Month-End Close migration — static shape", () => {
  it("creates close_periods with entity default + status state machine", () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS close_periods/);
    expect(SQL).toMatch(/DEFAULT coalesce\(current_entity_id\(\), rof_entity_id\(\)\)/);
    expect(SQL).toMatch(/CHECK \(status IN \('open','in_close','closed'\)\)/);
    expect(SQL).toMatch(/UNIQUE \(entity_id, period_id\)/);
  });

  it("creates close_checklist_items with kind/status checks + per-period key uniqueness", () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS close_checklist_items/);
    expect(SQL).toMatch(/CHECK \(kind IN \('auto','manual'\)\)/);
    expect(SQL).toMatch(/CHECK \(status IN \('pending','pass','fail','signed_off'\)\)/);
    expect(SQL).toMatch(/UNIQUE \(close_period_id, item_key\)/);
    expect(SQL).toMatch(/detail\s+jsonb NOT NULL DEFAULT/);
    expect(SQL).toMatch(/signed_off_by\s+uuid REFERENCES auth\.users\(id\)/);
  });

  it("attaches the T11 audit trigger to both tables and enables auth-only RLS", () => {
    const auditAttaches = SQL.match(/EXECUTE FUNCTION audit_row_changes_trigger\(\)/g) || [];
    expect(auditAttaches.length).toBe(2);
    expect(SQL).toMatch(/ALTER TABLE close_periods\s+ENABLE ROW LEVEL SECURITY/);
    expect(SQL).toMatch(/ALTER TABLE close_checklist_items ENABLE ROW LEVEL SECURITY/);
    expect(SQL).not.toMatch(/TO anon/);
  });

  it("defines the read-only close_run_auto_checks RPC covering all 8 checks", () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION close_run_auto_checks/);
    expect(SQL).toMatch(/LANGUAGE plpgsql STABLE/);
    for (const key of [
      "gl_balanced", "ar_subledger_tie", "ap_subledger_tie", "bank_recon",
      "no_draft_jes", "uncategorized_8007", "factor_recon", "revenue_posted",
    ]) {
      expect(SQL).toContain(`'${key}'`);
    }
    // #1665 conventions: AR control codes, AP pending_payments waiver.
    expect(SQL).toMatch(/'1105','1107','1108'/);
    expect(SQL).toMatch(/pending_payments/);
  });

  it("converts JE-line dollars to TRUE cents in every checks aggregation", () => {
    // Every SUM over journal_entry_lines dollars must be ROUND(SUM(...) * 100).
    expect(SQL).toMatch(/ROUND\(SUM\(jel\.debit - jel\.credit\) \* 100\)/);
    expect(SQL).toMatch(/ROUND\(SUM\(jel\.credit - jel\.debit\) \* 100\)/);
  });

  it("fixes the gl_post_year_end_close 100x bug (dollars aggregated, then one ROUND*100)", () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION gl_post_year_end_close/);
    expect(SQL).toMatch(/ROUND\(SUM\(amount_dollars\) \* 100\)::bigint AS amount_cents/);
    expect(SQL).toMatch(/HAVING ROUND\(SUM\(amount_dollars\) \* 100\) <> 0/);
    // The buggy shape — raw dollar CASE aliased straight to amount_cents —
    // must be gone (the CASE now feeds amount_dollars).
    expect(SQL).not.toMatch(/END AS amount_cents/);
    expect(SQL).toMatch(/END AS amount_dollars/);
  });

  it("year-end close still converts cents to dollars for the JE payload and keeps one-shot guard", () => {
    expect(SQL).toMatch(/::numeric \/ 100/);
    expect(SQL).toMatch(/cannot re-run year-end close/);
    // T11: the posting payload must carry an audit_reason.
    expect(SQL).toMatch(/'audit_reason',\s*format\('Year-end close FY%s', p_fiscal_year\)/);
  });

  it("ends with NOTIFY pgrst reload schema", () => {
    expect(SQL).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
  });
});
