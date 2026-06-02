// Static-shape sanity checks on the P10-1 tenancy-schema migration.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(
  __dirname,
  "../../../supabase/migrations/20260629000000_p10_chunk1_tenancy_schema.sql",
);
const SQL = readFileSync(MIGRATION_PATH, "utf8");

describe("P10-1 migration — static shape", () => {
  describe("filename convention", () => {
    it("matches the dated _p10_chunk1_*.sql naming convention", () => {
      expect(basename(MIGRATION_PATH)).toMatch(
        /^20260629000000_p10_chunk1_tenancy_schema\.sql$/,
      );
    });
  });

  describe("SANDBOX entity seed (D1)", () => {
    it("inserts a row into entities with code 'SANDBOX'", () => {
      expect(SQL).toMatch(/INSERT INTO entities\s*\(/);
      expect(SQL).toMatch(/'SANDBOX'/);
    });
    it("uses ON CONFLICT (code) DO NOTHING for idempotency", () => {
      expect(SQL).toMatch(/ON CONFLICT \(code\) DO NOTHING/);
    });
    it("supplies the required NOT NULL columns (name, slug)", () => {
      expect(SQL).toMatch(/'Sandbox Negative Test Bed'/);
      expect(SQL).toMatch(/'sandbox'/);
    });
  });

  describe("entity_users.is_default flag (D6)", () => {
    it("ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false", () => {
      expect(SQL).toMatch(/ALTER TABLE entity_users/);
      expect(SQL).toMatch(
        /ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false/,
      );
    });
    it("creates a partial unique index so each user has at most one default", () => {
      expect(SQL).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS entity_users_one_default_per_user/,
      );
      expect(SQL).toMatch(/ON entity_users \(auth_id\)/);
      expect(SQL).toMatch(/WHERE is_default = true/);
    });
  });

  describe("entity_access_audit table (D5)", () => {
    it("CREATE TABLE IF NOT EXISTS entity_access_audit", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS entity_access_audit/);
    });
    it("has id uuid PRIMARY KEY DEFAULT gen_random_uuid()", () => {
      expect(SQL).toMatch(/id\s+uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    });
    it("has auth_user_id FK to auth.users with ON DELETE SET NULL", () => {
      expect(SQL).toMatch(
        /auth_user_id\s+uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/,
      );
    });
    it("has attempted_entity_id FK to entities with ON DELETE SET NULL", () => {
      expect(SQL).toMatch(
        /attempted_entity_id\s+uuid REFERENCES entities\(id\) ON DELETE SET NULL/,
      );
    });
    it("has attempted_table text NOT NULL", () => {
      expect(SQL).toMatch(/attempted_table\s+text NOT NULL/);
    });
    it("has attempted_action text NOT NULL with CHECK constraint", () => {
      expect(SQL).toMatch(/attempted_action\s+text NOT NULL CHECK/);
      expect(SQL).toMatch(/'select'/);
      expect(SQL).toMatch(/'insert'/);
      expect(SQL).toMatch(/'update'/);
      expect(SQL).toMatch(/'delete'/);
    });
    it("has attempted_pk text (nullable)", () => {
      expect(SQL).toMatch(/attempted_pk\s+text/);
    });
    it("has denied_at timestamptz NOT NULL DEFAULT now()", () => {
      expect(SQL).toMatch(/denied_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
    });
    it("has request_id text + user_agent text", () => {
      expect(SQL).toMatch(/request_id\s+text/);
      expect(SQL).toMatch(/user_agent\s+text/);
    });
    it("does NOT enable RLS on the audit table (admin/service-role only)", () => {
      expect(SQL).not.toMatch(
        /ALTER TABLE entity_access_audit ENABLE ROW LEVEL SECURITY/,
      );
    });
    it("indexes (auth_user_id, denied_at DESC) for admin lookups", () => {
      expect(SQL).toMatch(
        /CREATE INDEX IF NOT EXISTS idx_entity_access_audit_user_time/,
      );
      expect(SQL).toMatch(
        /ON entity_access_audit \(auth_user_id, denied_at DESC\)/,
      );
    });
  });

  describe("entities.multi_entity_enabled feature flag (D10)", () => {
    it("ADD COLUMN IF NOT EXISTS multi_entity_enabled boolean NOT NULL DEFAULT false", () => {
      expect(SQL).toMatch(/ALTER TABLE entities/);
      expect(SQL).toMatch(
        /ADD COLUMN IF NOT EXISTS multi_entity_enabled boolean NOT NULL DEFAULT false/,
      );
    });
  });

  describe("is_default backfill for existing entity_users rows", () => {
    it("UPDATE entity_users SET is_default = true", () => {
      expect(SQL).toMatch(/UPDATE entity_users/);
      expect(SQL).toMatch(/SET is_default = true/);
    });
    it("guards backfill against violating the one-default-per-user index", () => {
      // The UPDATE filters to auth_ids that have exactly one row so the
      // partial unique index can never be violated.
      expect(SQL).toMatch(/GROUP BY auth_id/);
      expect(SQL).toMatch(/HAVING count\(\*\) = 1/);
    });
  });

  describe("footer + idempotency", () => {
    it("ends with NOTIFY pgrst reload schema", () => {
      expect(SQL).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
    });
    it("is idempotent (IF NOT EXISTS / ON CONFLICT guards)", () => {
      expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS is_default/);
      expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS multi_entity_enabled/);
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS entity_access_audit/);
      expect(SQL).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS entity_users_one_default_per_user/,
      );
      expect(SQL).toMatch(
        /CREATE INDEX IF NOT EXISTS idx_entity_access_audit_user_time/,
      );
      expect(SQL).toMatch(/ON CONFLICT \(code\) DO NOTHING/);
    });
  });

  describe("documentation", () => {
    it("comments the new entity_access_audit table", () => {
      expect(SQL).toMatch(/COMMENT ON TABLE entity_access_audit/);
    });
    it("comments the new columns (is_default, multi_entity_enabled)", () => {
      expect(SQL).toMatch(/COMMENT ON COLUMN entity_users\.is_default/);
      expect(SQL).toMatch(/COMMENT ON COLUMN entities\.multi_entity_enabled/);
    });
  });
});
