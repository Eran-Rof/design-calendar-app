// @vitest-environment node
//
// P14 RBAC — Chunk 1 schema migration shape test.
// Static assertions over the migration SQL (the repo applies migrations via
// supabase-db-push, not in CI, so this guards the structure the way the other
// pNN-chunk*-schema tests do).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(__dirname, "../../../supabase/migrations/20260707000000_p14_chunk1_rbac_schema.sql"),
  "utf8",
);

describe("P14-1 — RBAC schema migration", () => {
  it("creates the 5 new tables", () => {
    for (const t of ["module_keys", "roles", "role_permissions", "entity_user_roles", "entity_user_role_overrides"]) {
      expect(SQL).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`));
    }
  });

  it("entity_user_roles is keyed per (entity, user) and FKs role + auth.users + entities", () => {
    expect(SQL).toMatch(/role_id\s+uuid NOT NULL REFERENCES roles\(id\) ON DELETE RESTRICT/);
    expect(SQL).toMatch(/user_id\s+uuid NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/);
    expect(SQL).toMatch(/entity_id\s+uuid NOT NULL REFERENCES entities\(id\) ON DELETE CASCADE/);
    expect(SQL).toMatch(/PRIMARY KEY \(entity_id, user_id\)/);
  });

  it("role_permissions + overrides constrain action to the 5 verbs", () => {
    const m = SQL.match(/action\s+text NOT NULL CHECK \(action IN \('read','write','post','void','export'\)\)/g);
    expect(m && m.length).toBeGreaterThanOrEqual(2); // role_permissions + overrides
  });

  it("hooks both grant tables into the T11 universal audit trigger", () => {
    expect(SQL).toMatch(/CREATE TRIGGER trg_entity_user_roles_audit[\s\S]*?EXECUTE FUNCTION audit_row_changes_trigger\(\)/);
    expect(SQL).toMatch(/CREATE TRIGGER trg_eur_overrides_audit[\s\S]*?EXECUTE FUNCTION audit_row_changes_trigger\(\)/);
  });

  it("ships the effective-permissions view + has_permission() SECURITY DEFINER helper", () => {
    expect(SQL).toMatch(/CREATE OR REPLACE VIEW v_effective_permissions/);
    // role grants ∪ allow-overrides, minus deny-overrides
    expect(SQL).toMatch(/UNION/);
    expect(SQL).toMatch(/allowed = false/); // deny-override subtraction (aliased as r.allowed)
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION has_permission\(/);
    expect(SQL).toMatch(/SECURITY DEFINER/);
  });

  it("enables RLS + anon-permissive policy on all 5 tables (no behavior change)", () => {
    for (const t of ["module_keys", "roles", "role_permissions", "entity_user_roles", "entity_user_role_overrides"]) {
      expect(SQL).toMatch(new RegExp(`ALTER TABLE ${t}\\s+ENABLE ROW LEVEL SECURITY|ALTER TABLE ${t} +ENABLE ROW LEVEL SECURITY`));
    }
    const policies = SQL.match(/CREATE POLICY "anon_all_[a-z_]+" ON \w+ FOR ALL TO anon USING \(true\) WITH CHECK \(true\)/g);
    expect(policies && policies.length).toBe(5);
  });

  it("seeds the 3 roles + module_keys + generates the matrix + backfills", () => {
    expect(SQL).toMatch(/INSERT INTO roles \(name, description, is_seed\)[\s\S]*?'admin'[\s\S]*?'accountant'[\s\S]*?'viewer'/);
    expect(SQL).toMatch(/INSERT INTO module_keys/);
    // admin matrix generated from module_keys (not hand-listed)
    expect(SQL).toMatch(/INSERT INTO role_permissions[\s\S]*?CROSS JOIN module_keys[\s\S]*?r\.name = 'admin'/);
    // backfill from entity_users, readonly→viewer, default admin, idempotent
    expect(SQL).toMatch(/INSERT INTO entity_user_roles[\s\S]*?FROM entity_users eu[\s\S]*?ON CONFLICT \(entity_id, user_id\) DO NOTHING/);
    expect(SQL).toMatch(/WHEN 'readonly' THEN 'viewer'/);
  });

  it("is idempotent + self-documents zero enforcement", () => {
    expect(SQL).toMatch(/ZERO ENFORCEMENT/);
    expect(SQL).toMatch(/NOTIFY pgrst/);
  });
});
