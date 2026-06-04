// @vitest-environment node
//
// P14 RBAC — Chunk 3b grant-table RLS lockdown shape test.
// Guards that the 5 RBAC tables become anon-READ-ONLY (the prior
// `anon FOR ALL` policies are dropped and replaced with SELECT-only), so the
// browser anon key can no longer rewrite roles/permissions directly — writes
// flow only through the service-role admin handler.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(__dirname, "../../../supabase/migrations/20260707010000_p14_chunk3_rbac_grant_rls_lockdown.sql"),
  "utf8",
);

const TABLES = ["module_keys", "roles", "role_permissions", "entity_user_roles", "entity_user_role_overrides"];

describe("P14-3b — RBAC grant-table RLS lockdown", () => {
  it("drops the old anon FOR ALL write policies on every table", () => {
    const drops = SQL.match(/DROP POLICY IF EXISTS "anon_all_[a-z_]+"/g) || [];
    expect(drops.length).toBe(5);
  });

  it("creates an anon SELECT-only (read) policy on every table", () => {
    const reads = SQL.match(/CREATE POLICY "anon_read_[a-z_]+" ON \w+ FOR SELECT TO anon USING \(true\)/g) || [];
    expect(reads.length).toBe(5);
  });

  it("does NOT grant anon any write (no FOR ALL / INSERT / UPDATE / DELETE to anon)", () => {
    expect(SQL).not.toMatch(/FOR ALL TO anon/);
    expect(SQL).not.toMatch(/FOR (INSERT|UPDATE|DELETE) TO anon/);
    expect(SQL).not.toMatch(/WITH CHECK/); // SELECT policies carry no WITH CHECK
  });

  it("covers all 5 RBAC tables by name", () => {
    for (const t of TABLES) expect(SQL).toMatch(new RegExp(`ON ${t}\\b`));
  });

  it("reloads the PostgREST schema cache", () => {
    expect(SQL).toMatch(/NOTIFY pgrst/);
  });
});
