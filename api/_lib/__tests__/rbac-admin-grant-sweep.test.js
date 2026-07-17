// @vitest-environment node
//
// P14 RBAC — admin-grant-sweep migration shape test (mig 20262340000000).
//
// Static assertions over the migration SQL (the repo applies migrations via
// supabase-db-push, not in CI, so — like the other pNN-chunk*-schema tests —
// this locks the STRUCTURE in place). Its job is to guarantee the "admin can
// never be locked out of a registered module" invariant survives future edits:
//   1. the data backfill grants all three seed roles from the LIVE module_keys
//      registry (not a hand-listed subset), and
//   2. v_effective_permissions derives admin coverage dynamically from
//      module_keys, so a newly-registered module is admin-covered with no seed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(__dirname, "../../../supabase/migrations/20262340000000_rbac_admin_grant_sweep.sql"),
  "utf8",
);

describe("P14 RBAC — admin grant sweep", () => {
  it("backfills admin from the whole module_keys registry, idempotently", () => {
    expect(SQL).toMatch(
      /INSERT INTO role_permissions[\s\S]*?CROSS JOIN module_keys[\s\S]*?unnest\(mk\.available_actions\)[\s\S]*?r\.name = 'admin'[\s\S]*?ON CONFLICT \(role_id, module_key, action\) DO NOTHING/,
    );
  });

  it("backfills the viewer read + accountant read/export bands too", () => {
    expect(SQL).toMatch(/r\.name = 'viewer' AND 'read' = ANY \(mk\.available_actions\)/);
    expect(SQL).toMatch(/VALUES \('read'\), \('export'\)[\s\S]*?r\.name = 'accountant'/);
  });

  it("makes admin coverage STRUCTURAL — derived from module_keys in the view", () => {
    // The recurrence-proofing: v_effective_permissions must contain an admin
    // branch that CROSS JOINs module_keys, so admin never depends on a seed.
    expect(SQL).toMatch(/CREATE OR REPLACE VIEW v_effective_permissions/);
    expect(SQL).toMatch(
      /admin_grants AS \([\s\S]*?JOIN roles r ON r\.id = eur\.role_id AND r\.name = 'admin'[\s\S]*?CROSS JOIN module_keys mk[\s\S]*?unnest\(mk\.available_actions\)/,
    );
    // admin_grants must be unioned into the effective set…
    expect(SQL).toMatch(/UNION[\s\S]*?FROM admin_grants/);
    // …and per-user deny overrides must still apply on top (revocable).
    expect(SQL).toMatch(/WHERE NOT EXISTS[\s\S]*?entity_user_role_overrides r[\s\S]*?r\.allowed = false/);
  });
});
