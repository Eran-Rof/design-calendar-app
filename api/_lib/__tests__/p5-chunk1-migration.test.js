// Static-shape sanity checks on the P5-1 migration file.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(
  __dirname,
  "../../../supabase/migrations/20260602000000_p5_chunk1_period_close_mechanics.sql",
);
const SQL = readFileSync(MIGRATION_PATH, "utf8");

describe("P5-1 migration — static shape", () => {
  it("extends gl_periods.status CHECK with closed_with_closing_jes", () => {
    expect(SQL).toMatch(/DROP CONSTRAINT IF EXISTS gl_periods_status_check/);
    expect(SQL).toMatch(/closed_with_closing_jes/);
    expect(SQL).toMatch(/CHECK \(status IN \('open', 'soft_close', 'closed', 'closed_with_closing_jes'\)\)/);
  });

  it("creates gl_period_status_log with required columns + FK + CHECK", () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS gl_period_status_log/);
    expect(SQL).toMatch(/period_id\s+uuid NOT NULL REFERENCES gl_periods\(id\) ON DELETE CASCADE/);
    expect(SQL).toMatch(/from_status\s+text/);
    expect(SQL).toMatch(/to_status\s+text NOT NULL/);
    expect(SQL).toMatch(/CONSTRAINT gl_period_status_log_transition_check/);
    expect(SQL).toMatch(/CHECK \(from_status IS DISTINCT FROM to_status\)/);
  });

  it("creates audit-trigger function reading session vars", () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION gl_period_status_log_audit/);
    expect(SQL).toMatch(/current_setting\('tangerine\.period_close_actor'/);
    expect(SQL).toMatch(/current_setting\('tangerine\.period_close_reason'/);
  });

  it("attaches the AFTER UPDATE trigger on gl_periods", () => {
    expect(SQL).toMatch(/CREATE TRIGGER gl_period_status_log_audit_trg/);
    expect(SQL).toMatch(/AFTER UPDATE OF status ON gl_periods/);
  });

  it("enables RLS on the audit table with P1 template", () => {
    expect(SQL).toMatch(/ALTER TABLE gl_period_status_log ENABLE ROW LEVEL SECURITY/);
    expect(SQL).toMatch(/"anon_all_gl_period_status_log"/);
    expect(SQL).toMatch(/"auth_internal_gl_period_status_log"/);
  });

  it("defines the gl_period_transition_status RPC", () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION gl_period_transition_status/);
    expect(SQL).toMatch(/p_target_status text/);
    expect(SQL).toMatch(/PERFORM set_config\('tangerine\.period_close_actor'/);
    expect(SQL).toMatch(/RETURNING \* INTO v_row/);
  });

  it("RPC updates soft_closed_at / closed_at / closed_by_user_id conditionally", () => {
    expect(SQL).toMatch(/soft_closed_at\s+=\s+CASE WHEN p_target_status = 'soft_close'/);
    expect(SQL).toMatch(/closed_at\s+=\s+CASE WHEN p_target_status = 'closed'/);
    expect(SQL).toMatch(/closed_by_user_id\s+=\s+CASE WHEN p_target_status = 'closed'/);
  });

  it("ends with NOTIFY pgrst reload schema", () => {
    expect(SQL).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
  });

  it("is idempotent (CREATE ... IF NOT EXISTS + CREATE OR REPLACE + DO $$ guards)", () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS gl_period_status_log/);
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION gl_period_status_log_audit/);
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION gl_period_transition_status/);
    expect(SQL).toMatch(/DROP TRIGGER IF EXISTS gl_period_status_log_audit_trg/);
    expect(SQL).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL; END \$\$/);
  });
});
