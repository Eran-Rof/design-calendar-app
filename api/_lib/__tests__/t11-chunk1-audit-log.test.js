// Static-shape tests for T11-1 migration: Universal audit log schema +
// trigger function + 16-entity trigger attaches.
//
// Reads the migration SQL and asserts the right shapes are present without
// requiring a live DB.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = readFileSync(
  resolve(here, "../../../supabase/migrations/20260629900000_t11_chunk1_audit_log.sql"),
  "utf8",
);

const COVERED_TABLES = [
  "ar_invoices",
  "ar_invoice_lines",
  "invoices",
  "invoice_line_items",
  "journal_entries",
  "journal_entry_lines",
  "gl_accounts",
  "gl_periods",
  "customers",
  "vendors",
  "employees",
  "cases",
  "sales_reps",
  "commission_payouts",
  "bank_accounts",
  "virtual_cards",
];

const OPERATIONS = ["INSERT", "UPDATE", "DELETE", "VOID", "POST", "REVERSE"];

const T10_SOURCES = [
  "manual",
  "xoro_mirror",
  "shopify",
  "fba",
  "walmart",
  "faire",
  "edi_3pl",
  "plaid_sync",
  "api",
  "system",
];

describe("T11-1 — Universal audit log migration", () => {
  describe("row_changes master ledger table", () => {
    it("CREATE TABLE IF NOT EXISTS row_changes", () => {
      expect(MIG).toMatch(/CREATE TABLE IF NOT EXISTS row_changes/);
    });

    it("has uuid PK with gen_random_uuid() default", () => {
      expect(MIG).toMatch(/id\s+uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    });

    it("entity_id FK references entities(id) ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/entity_id\s+uuid REFERENCES entities\(id\) ON DELETE SET NULL/);
    });

    it("source_table column is text NOT NULL", () => {
      expect(MIG).toMatch(/source_table\s+text NOT NULL/);
    });

    it("source_id column is text NOT NULL", () => {
      expect(MIG).toMatch(/source_id\s+text NOT NULL/);
    });

    it("operation column is text NOT NULL with CHECK enum", () => {
      expect(MIG).toMatch(/operation\s+text NOT NULL CHECK \(operation IN \(/);
    });

    for (const op of OPERATIONS) {
      it(`operation CHECK includes '${op}'`, () => {
        expect(MIG).toMatch(new RegExp(`'${op}'`));
      });
    }

    it("before_jsonb column is jsonb", () => {
      expect(MIG).toMatch(/before_jsonb\s+jsonb/);
    });

    it("after_jsonb column is jsonb", () => {
      expect(MIG).toMatch(/after_jsonb\s+jsonb/);
    });

    it("changed_columns column is text[]", () => {
      expect(MIG).toMatch(/changed_columns\s+text\[\]/);
    });

    it("actor_auth_id column is uuid", () => {
      expect(MIG).toMatch(/actor_auth_id\s+uuid/);
    });

    it("actor_employee_id FK references employees(id) ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/actor_employee_id\s+uuid REFERENCES employees\(id\) ON DELETE SET NULL/);
    });

    it("actor_display_name column is text", () => {
      expect(MIG).toMatch(/actor_display_name\s+text/);
    });

    it("source column has CHECK including T10 enum values", () => {
      expect(MIG).toMatch(/source\s+text CHECK \(source IS NULL OR source IN \(/);
    });

    for (const s of T10_SOURCES) {
      it(`source CHECK references T10 enum value '${s}'`, () => {
        expect(MIG).toMatch(new RegExp(`'${s}'`));
      });
    }

    it("reason column is text", () => {
      expect(MIG).toMatch(/reason\s+text/);
    });

    it("correlation_id column is text", () => {
      expect(MIG).toMatch(/correlation_id\s+text/);
    });

    it("user_agent column is text", () => {
      expect(MIG).toMatch(/user_agent\s+text/);
    });

    it("ip_address column is inet", () => {
      expect(MIG).toMatch(/ip_address\s+inet/);
    });

    it("changed_at column is timestamptz NOT NULL DEFAULT now()", () => {
      expect(MIG).toMatch(/changed_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
    });
  });

  describe("row_changes indexes", () => {
    it("row_changes_source_idx on (source_table, source_id, changed_at DESC)", () => {
      expect(MIG).toMatch(
        /CREATE INDEX IF NOT EXISTS row_changes_source_idx[\s\S]*?\(source_table, source_id, changed_at DESC\)/,
      );
    });

    it("row_changes_entity_idx on (entity_id, changed_at DESC)", () => {
      expect(MIG).toMatch(
        /CREATE INDEX IF NOT EXISTS row_changes_entity_idx[\s\S]*?\(entity_id, changed_at DESC\)/,
      );
    });

    it("row_changes_actor_idx on (actor_employee_id, changed_at DESC)", () => {
      expect(MIG).toMatch(
        /CREATE INDEX IF NOT EXISTS row_changes_actor_idx[\s\S]*?\(actor_employee_id, changed_at DESC\)/,
      );
    });

    it("row_changes_operation_idx on (operation, changed_at DESC)", () => {
      expect(MIG).toMatch(
        /CREATE INDEX IF NOT EXISTS row_changes_operation_idx[\s\S]*?\(operation, changed_at DESC\)/,
      );
    });
  });

  describe("audit_row_changes_trigger() function", () => {
    it("CREATE OR REPLACE FUNCTION audit_row_changes_trigger()", () => {
      expect(MIG).toMatch(/CREATE OR REPLACE FUNCTION audit_row_changes_trigger\(\)/);
    });

    it("RETURNS TRIGGER", () => {
      expect(MIG).toMatch(/RETURNS TRIGGER/);
    });

    it("LANGUAGE plpgsql", () => {
      expect(MIG).toMatch(/LANGUAGE plpgsql/);
    });

    it("declared SECURITY DEFINER", () => {
      expect(MIG).toMatch(/SECURITY DEFINER/);
    });

    it("hardened search_path = public, pg_temp", () => {
      expect(MIG).toMatch(/SET search_path = public, pg_temp/);
    });

    it("is NOT declared STABLE (must be VOLATILE — it INSERTs)", () => {
      // Default volatility for plpgsql is VOLATILE; explicit STABLE/IMMUTABLE
      // markers would be wrong here. Assert neither marker is present.
      const fnBlock = MIG.split(/CREATE OR REPLACE FUNCTION audit_row_changes_trigger/)[1] || "";
      expect(fnBlock).not.toMatch(/\bSTABLE\b/);
      expect(fnBlock).not.toMatch(/\bIMMUTABLE\b/);
    });

    it("handles INSERT branch (to_jsonb(NEW))", () => {
      expect(MIG).toMatch(/TG_OP = 'INSERT'[\s\S]*?to_jsonb\(NEW\)/);
    });

    it("handles UPDATE branch with NEW IS DISTINCT FROM OLD guard", () => {
      expect(MIG).toMatch(/TG_OP = 'UPDATE'[\s\S]*?NEW IS DISTINCT FROM OLD/);
    });

    it("handles DELETE branch (to_jsonb(OLD))", () => {
      expect(MIG).toMatch(/TG_OP = 'DELETE'[\s\S]*?to_jsonb\(OLD\)/);
    });

    it("detects VOID via gl_status transition on ar_invoices/invoices", () => {
      expect(MIG).toMatch(/TG_TABLE_NAME IN \('ar_invoices','invoices'\)[\s\S]*?gl_status.*?'void'/);
    });

    it("detects POST via status transition on journal_entries", () => {
      expect(MIG).toMatch(/TG_TABLE_NAME = 'journal_entries'[\s\S]*?status.*?'posted'/);
    });

    it("detects REVERSE via status transition on journal_entries", () => {
      expect(MIG).toMatch(/TG_TABLE_NAME = 'journal_entries'[\s\S]*?status.*?'reversed'/);
    });

    it("computes changed_columns via jsonb_each diff", () => {
      expect(MIG).toMatch(/array_agg\(key\)[\s\S]*?jsonb_each\(v_after\)[\s\S]*?IS DISTINCT FROM/);
    });

    it("excludes updated_at/synced_at/search_doc noise columns from diff", () => {
      expect(MIG).toMatch(/key NOT IN \('updated_at','synced_at','search_doc'\)/);
    });

    it("no-op update returns NEW without inserting row_changes row", () => {
      expect(MIG).toMatch(/-- No-op update; skip[\s\S]*?RETURN NEW/);
    });

    it("reads app.actor_auth_id session var", () => {
      expect(MIG).toMatch(/current_setting\('app\.actor_auth_id', true\)/);
    });

    it("reads app.actor_employee_id session var", () => {
      expect(MIG).toMatch(/current_setting\('app\.actor_employee_id', true\)/);
    });

    it("reads app.actor_display_name session var", () => {
      expect(MIG).toMatch(/current_setting\('app\.actor_display_name', true\)/);
    });

    it("reads app.audit_source session var", () => {
      expect(MIG).toMatch(/current_setting\('app\.audit_source', true\)/);
    });

    it("reads app.audit_reason session var", () => {
      expect(MIG).toMatch(/current_setting\('app\.audit_reason', true\)/);
    });

    it("reads app.audit_correlation_id session var", () => {
      expect(MIG).toMatch(/current_setting\('app\.audit_correlation_id', true\)/);
    });
  });

  describe("D3 — reason REQUIRED on VOID/POST/REVERSE", () => {
    it("RAISE EXCEPTION when reason missing on VOID/POST/REVERSE", () => {
      expect(MIG).toMatch(
        /v_operation IN \('VOID','POST','REVERSE'\)[\s\S]*?v_reason IS NULL OR v_reason = ''/,
      );
    });

    it("error message identifies T11 audit + the operation + table", () => {
      expect(MIG).toMatch(/T11 audit: reason is required for % operations on %/);
    });

    it("USING ERRCODE = 'check_violation'", () => {
      expect(MIG).toMatch(/USING ERRCODE = 'check_violation'/);
    });

    it("HINT mentions withAuditContext", () => {
      expect(MIG).toMatch(/HINT = 'Call withAuditContext\(\{reason\}\)/);
    });

    it("exception handler re-raises the reason-required check", () => {
      expect(MIG).toMatch(/SQLERRM LIKE 'T11 audit: reason is required%'[\s\S]*?RAISE;/);
    });
  });

  describe("Trigger error swallow (never block parent writes)", () => {
    it("EXCEPTION WHEN OTHERS handler is present", () => {
      expect(MIG).toMatch(/EXCEPTION WHEN OTHERS THEN/);
    });

    it("logs audit_trigger_failure into row_changes on swallow", () => {
      expect(MIG).toMatch(/'audit_trigger_failure'/);
    });

    it("last-ditch swallow nests EXCEPTION inside the handler", () => {
      // Make sure parent writes never crash even if the failure-log INSERT itself fails.
      expect(MIG).toMatch(/EXCEPTION WHEN OTHERS THEN[\s\S]*?NULL;/);
    });
  });

  describe("Trigger attached to 16 v1 entities", () => {
    it("DO $$ block iterates over a tables array", () => {
      expect(MIG).toMatch(/DO \$\$[\s\S]*?tables text\[\] := ARRAY\[/);
    });

    it("guards each attach with information_schema.tables existence check", () => {
      expect(MIG).toMatch(/information_schema\.tables[\s\S]*?table_schema = 'public'/);
    });

    it("DROP TRIGGER IF EXISTS audit_row_changes before each CREATE", () => {
      expect(MIG).toMatch(/DROP TRIGGER IF EXISTS audit_row_changes ON %I/);
    });

    it("CREATE TRIGGER fires AFTER INSERT OR UPDATE OR DELETE", () => {
      expect(MIG).toMatch(/AFTER INSERT OR UPDATE OR DELETE ON %I/);
    });

    it("trigger executes audit_row_changes_trigger() FOR EACH ROW", () => {
      expect(MIG).toMatch(/FOR EACH ROW EXECUTE FUNCTION audit_row_changes_trigger\(\)/);
    });

    for (const t of COVERED_TABLES) {
      it(`covered table list includes '${t}'`, () => {
        expect(MIG).toMatch(new RegExp(`'${t}'`));
      });
    }

    it("covers exactly 16 tables", () => {
      // Extract the ARRAY[...] literal and count quoted entries
      const m = MIG.match(/tables text\[\] := ARRAY\[([\s\S]*?)\]/);
      expect(m).toBeTruthy();
      const quoted = (m?.[1] || "").match(/'[a-z_]+'/g) || [];
      expect(quoted.length).toBe(16);
    });
  });

  describe("RLS on row_changes", () => {
    it("ENABLE ROW LEVEL SECURITY on row_changes", () => {
      expect(MIG).toMatch(/ALTER TABLE row_changes ENABLE ROW LEVEL SECURITY/);
    });

    it("anon_all_row_changes policy created via DO $$ guard", () => {
      expect(MIG).toMatch(/anon_all_row_changes[\s\S]*?FOR ALL TO anon/);
    });

    it("auth_internal_row_changes policy created via DO $$ guard", () => {
      expect(MIG).toMatch(/auth_internal_row_changes[\s\S]*?FOR ALL TO authenticated/);
    });
  });

  describe("Idempotency primitives", () => {
    it("CREATE TABLE IF NOT EXISTS (not bare CREATE TABLE)", () => {
      const bareCreate = MIG.match(/CREATE TABLE(?! IF NOT EXISTS)\s+\w+/gi) || [];
      expect(bareCreate.length).toBe(0);
    });

    it("CREATE INDEX IF NOT EXISTS on every index", () => {
      const bareIdx = MIG.match(/CREATE INDEX(?! IF NOT EXISTS)/gi) || [];
      expect(bareIdx.length).toBe(0);
    });

    it("CREATE OR REPLACE FUNCTION (not bare CREATE FUNCTION)", () => {
      expect(MIG).toMatch(/CREATE OR REPLACE FUNCTION audit_row_changes_trigger/);
    });

    it("policy attaches wrapped in pg_policies existence guards", () => {
      const guards = MIG.match(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_policies/g) || [];
      expect(guards.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("PostgREST cache reload footer", () => {
    it("ends with NOTIFY pgrst, 'reload schema'", () => {
      expect(MIG).toMatch(/NOTIFY pgrst, 'reload schema';/);
    });
  });

  describe("No COMMENT-concat lint", () => {
    it("no || string concatenation inside COMMENT statements", () => {
      // COMMENT ON ... IS '...' || '...' is banned.
      const concatComments = MIG.match(/COMMENT ON[^;]*\|\|/g) || [];
      expect(concatComments.length).toBe(0);
    });
  });
});
