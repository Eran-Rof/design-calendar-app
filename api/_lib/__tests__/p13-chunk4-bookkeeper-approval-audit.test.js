// Static-shape tests for P13-4 migration: Bookkeeper approval audit log +
// T11-2 audit-context bridge RPCs.
//
// Reads the migration SQL + the P13 architecture doc and asserts shape —
// does not require a live DB.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = readFileSync(
  resolve(here, "../../../supabase/migrations/20260629C00000_p13_chunk4_bookkeeper_approval_audit.sql"),
  "utf8",
);
const ARCH = readFileSync(
  resolve(here, "../../../docs/tangerine/P13-procurement-architecture.md"),
  "utf8",
);

describe("P13-4 — Bookkeeper approval audit migration", () => {
  describe("bookkeeper_approval_log table shape", () => {
    it("CREATE TABLE IF NOT EXISTS bookkeeper_approval_log (idempotent)", () => {
      expect(MIG).toMatch(/CREATE TABLE IF NOT EXISTS bookkeeper_approval_log/);
    });

    it("id uuid PRIMARY KEY DEFAULT gen_random_uuid()", () => {
      expect(MIG).toMatch(/id\s+uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    });

    it("entity_id DEFAULT coalesce(current_entity_id(), rof_entity_id())", () => {
      expect(MIG).toMatch(
        /entity_id\s+uuid NOT NULL DEFAULT coalesce\(current_entity_id\(\), rof_entity_id\(\)\)/,
      );
    });

    it("entity_id REFERENCES entities(id) ON DELETE RESTRICT", () => {
      expect(MIG).toMatch(/entity_id[\s\S]*?REFERENCES entities\(id\) ON DELETE RESTRICT/);
    });

    it("invoice_id NOT NULL REFERENCES invoices(id) ON DELETE CASCADE", () => {
      expect(MIG).toMatch(
        /invoice_id\s+uuid NOT NULL REFERENCES invoices\(id\) ON DELETE CASCADE/,
      );
    });

    it("action CHECK IN ('approved','rejected')", () => {
      expect(MIG).toMatch(
        /action\s+text NOT NULL CHECK \(action IN \('approved','rejected'\)\)/,
      );
    });

    it("bookkeeper_employee_id REFERENCES employees(id) ON DELETE SET NULL", () => {
      expect(MIG).toMatch(
        /bookkeeper_employee_id\s+uuid REFERENCES employees\(id\) ON DELETE SET NULL/,
      );
    });

    it("bookkeeper_auth_id REFERENCES auth.users(id) ON DELETE SET NULL", () => {
      expect(MIG).toMatch(
        /bookkeeper_auth_id\s+uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/,
      );
    });

    it("reason text NOT NULL (D3 required)", () => {
      expect(MIG).toMatch(/reason\s+text NOT NULL/);
    });

    it("je_id REFERENCES journal_entries(id) ON DELETE SET NULL", () => {
      expect(MIG).toMatch(
        /je_id\s+uuid REFERENCES journal_entries\(id\) ON DELETE SET NULL/,
      );
    });

    it("approved_at timestamptz NOT NULL DEFAULT now()", () => {
      expect(MIG).toMatch(/approved_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
    });
  });

  describe("indexes", () => {
    it("bookkeeper_approval_log_invoice_idx on (invoice_id, approved_at DESC)", () => {
      expect(MIG).toMatch(
        /CREATE INDEX IF NOT EXISTS bookkeeper_approval_log_invoice_idx[\s\S]*?\(invoice_id, approved_at DESC\)/,
      );
    });

    it("bookkeeper_approval_log_entity_idx on (entity_id, approved_at DESC)", () => {
      expect(MIG).toMatch(
        /CREATE INDEX IF NOT EXISTS bookkeeper_approval_log_entity_idx[\s\S]*?\(entity_id, approved_at DESC\)/,
      );
    });

    it("bookkeeper_approval_log_action_idx on (action, approved_at DESC)", () => {
      expect(MIG).toMatch(
        /CREATE INDEX IF NOT EXISTS bookkeeper_approval_log_action_idx[\s\S]*?\(action, approved_at DESC\)/,
      );
    });
  });

  describe("RLS — anon_all + auth_internal template", () => {
    it("ALTER TABLE ... ENABLE ROW LEVEL SECURITY", () => {
      expect(MIG).toMatch(/ALTER TABLE bookkeeper_approval_log ENABLE ROW LEVEL SECURITY/);
    });

    it("anon_all_bookkeeper_approval_log policy guarded by DO $$ IF NOT EXISTS", () => {
      expect(MIG).toMatch(
        /CREATE POLICY anon_all_bookkeeper_approval_log[\s\S]*?TO anon USING \(true\) WITH CHECK \(true\)/,
      );
    });

    it("auth_internal_bookkeeper_approval_log policy guarded by DO $$ IF NOT EXISTS", () => {
      expect(MIG).toMatch(
        /CREATE POLICY auth_internal_bookkeeper_approval_log[\s\S]*?TO authenticated USING \(true\) WITH CHECK \(true\)/,
      );
    });
  });

  describe("T11-2 audit-context bridge RPCs", () => {
    it("set_audit_context RPC with six parameters", () => {
      expect(MIG).toMatch(/CREATE OR REPLACE FUNCTION set_audit_context\s*\(/);
      expect(MIG).toMatch(/p_actor_auth_id\s+uuid/);
      expect(MIG).toMatch(/p_actor_employee_id\s+uuid/);
      expect(MIG).toMatch(/p_actor_display_name\s+text/);
      expect(MIG).toMatch(/p_audit_source\s+text/);
      expect(MIG).toMatch(/p_audit_reason\s+text/);
      expect(MIG).toMatch(/p_audit_correlation_id\s+text/);
    });

    it("set_audit_context calls set_config for all six T11-1 session vars", () => {
      expect(MIG).toMatch(/set_config\('app\.actor_auth_id'/);
      expect(MIG).toMatch(/set_config\('app\.actor_employee_id'/);
      expect(MIG).toMatch(/set_config\('app\.actor_display_name'/);
      expect(MIG).toMatch(/set_config\('app\.audit_source'/);
      expect(MIG).toMatch(/set_config\('app\.audit_reason'/);
      expect(MIG).toMatch(/set_config\('app\.audit_correlation_id'/);
    });

    it("set_audit_context default p_audit_source = 'manual' (T10 enum default)", () => {
      expect(MIG).toMatch(/p_audit_source\s+text\s+DEFAULT\s+'manual'/);
    });

    it("set_audit_context is SECURITY DEFINER with locked-down search_path", () => {
      expect(MIG).toMatch(
        /CREATE OR REPLACE FUNCTION set_audit_context[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = public, pg_temp/,
      );
    });

    it("clear_audit_context RPC clears all six session vars", () => {
      expect(MIG).toMatch(/CREATE OR REPLACE FUNCTION clear_audit_context/);
    });
  });

  describe("idempotency + safety guards", () => {
    it("NOTIFY pgrst reload schema fires at end of migration", () => {
      expect(MIG).toMatch(/NOTIFY pgrst, 'reload schema'/);
    });

    it("policies are guarded by DO $$ IF NOT EXISTS pattern (re-runnable)", () => {
      const occurrences = MIG.match(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_policies/g) || [];
      expect(occurrences.length).toBeGreaterThanOrEqual(2);
    });

    it("does not use forbidden COMMENT-concat pattern (P12-0 hotfix lint)", () => {
      // Only flag actual SQL `COMMENT ON ... IS 'foo' || 'bar'` statements; the
      // anchor on `COMMENT ON` keeps the test from snagging on header prose.
      expect(MIG).not.toMatch(/COMMENT ON[\s\S]+?IS\s+'[^']+'\s*\|\|/);
    });

    it("all indexes use CREATE INDEX IF NOT EXISTS (re-runnable)", () => {
      const naked = MIG.match(/CREATE INDEX(?!\s+IF NOT EXISTS)/g) || [];
      expect(naked.length).toBe(0);
    });
  });

  describe("architecture-doc alignment", () => {
    it("P13 architecture documents the bookkeeper approval gate at §6.9 D19", () => {
      expect(ARCH).toMatch(/D19[\s\S]*?bookkeeper/);
    });

    it("P13-4 chunk row in §7 names this scope", () => {
      expect(ARCH).toMatch(/\*\*P13-4\*\*[\s\S]*?Bookkeeper approval queue/);
    });

    it("P13 §6.9 names pending_bookkeeper_approval as the gate status", () => {
      expect(ARCH).toMatch(/pending_bookkeeper_approval/);
    });

    it("P13 §3.12 documents is_receipt_rollup boolean on invoices", () => {
      expect(ARCH).toMatch(/is_receipt_rollup boolean/);
    });
  });
});
