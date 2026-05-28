// Static-shape sanity checks on the P5-7 migration.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(
  __dirname,
  "../../../supabase/migrations/20260606000000_p5_chunk7_close_preflight.sql",
);
const SQL = readFileSync(MIGRATION_PATH, "utf8");

describe("P5-7 migration — static shape", () => {
  it("defines gl_period_close_preflight RPC", () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION gl_period_close_preflight/);
    expect(SQL).toMatch(/p_entity_id uuid/);
    expect(SQL).toMatch(/p_period_id uuid/);
    expect(SQL).toMatch(/RETURNS TABLE/);
  });

  it("RPC returns check_name + status + detail + blocking", () => {
    expect(SQL).toMatch(/check_name\s+text/);
    expect(SQL).toMatch(/status\s+text/);
    expect(SQL).toMatch(/detail\s+text/);
    expect(SQL).toMatch(/blocking\s+boolean/);
  });

  it("emits a row when the period is closed_with_closing_jes (blocking)", () => {
    expect(SQL).toMatch(/terminal status; cannot transition/);
  });

  it("checks accrual + cash trial balance", () => {
    expect(SQL).toMatch(/accrual_trial_balanced/);
    expect(SQL).toMatch(/cash_trial_balanced/);
    expect(SQL).toMatch(/je\.basis = 'ACCRUAL'/);
    expect(SQL).toMatch(/je\.basis = 'CASH'/);
  });

  it("checks no_draft_jes (blocking)", () => {
    expect(SQL).toMatch(/no_draft_jes/);
    expect(SQL).toMatch(/status IN \('draft','pending_approval','unposted'\)/);
  });

  it("checks no_unposted_ar_invoices (warning, undefined_table guarded)", () => {
    expect(SQL).toMatch(/no_unposted_ar_invoices/);
    expect(SQL).toMatch(/FROM ar_invoices/);
    expect(SQL).toMatch(/EXCEPTION WHEN undefined_table/);
  });

  it("checks no_unposted_ap_invoices (warning)", () => {
    expect(SQL).toMatch(/no_unposted_ap_invoices/);
    expect(SQL).toMatch(/FROM invoices/);
  });

  it("checks no_unposted_inventory_adjustments (warning)", () => {
    expect(SQL).toMatch(/no_unposted_inventory_adjustments/);
    expect(SQL).toMatch(/FROM inventory_adjustments/);
    expect(SQL).toMatch(/posted_at IS NULL/);
  });

  it("checks no_unapplied_receipts via v_ar_unapplied_receipts", () => {
    expect(SQL).toMatch(/no_unapplied_receipts/);
    expect(SQL).toMatch(/FROM v_ar_unapplied_receipts/);
  });

  it("checks fifo_negative_layers (blocking)", () => {
    expect(SQL).toMatch(/fifo_negative_layers/);
    expect(SQL).toMatch(/remaining_qty < 0/);
  });

  it("is STABLE", () => {
    expect(SQL).toMatch(/LANGUAGE plpgsql STABLE/);
  });

  it("ends with NOTIFY pgrst reload schema", () => {
    expect(SQL).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
  });
});
