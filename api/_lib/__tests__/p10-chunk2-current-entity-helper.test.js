// Static-shape sanity checks on the P10-2 current_entity_id() helper migration.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(
  __dirname,
  "../../../supabase/migrations/20260629010000_p10_chunk2_current_entity_helper.sql",
);
const SQL = readFileSync(MIGRATION_PATH, "utf8");

describe("P10-2 migration — current_entity_id() helper static shape", () => {
  describe("filename convention", () => {
    it("matches the dated _p10_chunk2_*.sql naming convention", () => {
      expect(basename(MIGRATION_PATH)).toMatch(
        /^20260629010000_p10_chunk2_current_entity_helper\.sql$/,
      );
    });
  });

  describe("current_entity_id() function definition", () => {
    it("uses CREATE OR REPLACE FUNCTION current_entity_id()", () => {
      expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION current_entity_id\(\)/);
    });
    it("declares RETURNS uuid", () => {
      expect(SQL).toMatch(/RETURNS uuid/);
    });
    it("declares LANGUAGE plpgsql", () => {
      expect(SQL).toMatch(/LANGUAGE plpgsql/);
    });
    it("is STABLE so the planner can cache within a statement", () => {
      expect(SQL).toMatch(/\nSTABLE\n|\bSTABLE\b/);
    });
    it("is SECURITY DEFINER so RLS policies on other tables can call it", () => {
      expect(SQL).toMatch(/SECURITY DEFINER/);
    });
    it("pins search_path = public, pg_temp (SECURITY DEFINER best practice)", () => {
      expect(SQL).toMatch(/SET search_path = public, pg_temp/);
    });
  });

  describe("priority resolution order", () => {
    it("reads session GUC app.current_entity_id first", () => {
      expect(SQL).toMatch(/current_setting\('app\.current_entity_id'/);
    });
    it("passes the missing_ok=true second arg to current_setting", () => {
      expect(SQL).toMatch(/current_setting\('app\.current_entity_id',\s*true\)/);
    });
    it("wraps the GUC read in a NULLIF so '' coalesces to NULL", () => {
      expect(SQL).toMatch(/NULLIF\(current_setting\('app\.current_entity_id'/);
    });
    it("guards the ::uuid cast inside an EXCEPTION block", () => {
      expect(SQL).toMatch(/EXCEPTION WHEN OTHERS THEN/);
    });
    it("falls back to entity_users.is_default = true via auth.uid()", () => {
      expect(SQL).toMatch(/auth\.uid\(\)/);
      expect(SQL).toMatch(/FROM entity_users/);
      expect(SQL).toMatch(/WHERE auth_id = uid/);
      expect(SQL).toMatch(/AND is_default = true/);
    });
    it("returns NULL as the final fallback (RLS denies by default)", () => {
      expect(SQL).toMatch(/RETURN NULL;/);
    });
  });

  describe("grants", () => {
    it("GRANT EXECUTE to anon, authenticated, service_role", () => {
      expect(SQL).toMatch(
        /GRANT EXECUTE ON FUNCTION current_entity_id\(\) TO anon, authenticated, service_role/,
      );
    });
  });

  describe("documentation + cache reload", () => {
    it("attaches a COMMENT ON FUNCTION explaining the priority order", () => {
      expect(SQL).toMatch(/COMMENT ON FUNCTION current_entity_id\(\) IS/);
    });
    it("ends with NOTIFY pgrst 'reload schema'", () => {
      expect(SQL).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
    });
  });

  describe("scope boundary — does NOT swap DEFAULT rof_entity_id() in this chunk", () => {
    it("does NOT contain any 'ALTER COLUMN.*SET DEFAULT current_entity_id' statements (deferred to P10-3)", () => {
      expect(SQL).not.toMatch(/SET DEFAULT current_entity_id\(\)/i);
    });
  });
});
