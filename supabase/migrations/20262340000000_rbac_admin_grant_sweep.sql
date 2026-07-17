-- 20262340000000_rbac_admin_grant_sweep.sql
-- ════════════════════════════════════════════════════════════════════════════
-- P14 RBAC — close the "admin missing grant" gap across ALL module_keys, and
-- make the gap structurally impossible going forward.
--
-- ROOT CAUSE. The P14 seed (20260707000000) granted the `admin` role "every
-- action on every module" via a ONE-TIME `CROSS JOIN module_keys` over the ~33
-- modules that existed then. Every nav module added since is upserted into
-- module_keys by scripts/seed-module-keys.mjs (which mirrors src/erp/modules.ts
-- → api/_lib/tangerineModules.js) — but that script NEVER attached role grants.
-- Result on live PROD: module_keys has 144 rows, but the admin role is missing a
-- grant for 111 of them (439 (module,action) pairs). Under RBAC_MODE=enforce any
-- endpoint that checks one of those modules 403s even the CEO (whose role IS
-- `admin`). #1810 fixed `cases` in isolation; this closes the whole gap.
--
-- WHAT THIS DOES
--   1. DATA BACKFILL (idempotent, ON CONFLICT DO NOTHING) — restore the three
--      seed roles' original coverage bands across EVERY current module_key:
--        • admin      → every available action on every module
--        • viewer     → read on every module (role = "read-only everywhere")
--        • accountant → read + export on every module (its "read/export
--          everywhere" band). Its write / post / void bands are a CURATED list
--          of accounting+procurement keys (see the P14 seed); those are NOT
--          auto-extended to new modules here — deciding a brand-new module is
--          "accounting-writable" is a policy call, not a gap fix.
--
--   2. STRUCTURAL FIX (recurrence-proof) — redefine v_effective_permissions so
--      the `admin` role's grants are DERIVED FROM THE LIVE module_keys REGISTRY
--      rather than from stored role_permissions rows. "admin = full access to
--      every module and action" is the role's literal definition (roles.
--      description), so encoding it in the view means a newly-registered module
--      can NEVER be admin-forbidden again — no seed step to forget. Per-user
--      deny overrides still apply on top (an admin cell remains revocable).
--      The admin role_permissions rows seeded in step 1 are kept as belt-and-
--      suspenders (they also keep the User Access grid's admin column truthful).
--
-- Idempotent (CREATE OR REPLACE / ON CONFLICT DO NOTHING) — safe to re-apply
-- under supabase-db-push.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1a. admin → every available action on every module ──────────────────────
INSERT INTO role_permissions (role_id, module_key, action, allowed)
SELECT r.id, mk.key, a, true
FROM roles r
CROSS JOIN module_keys mk
CROSS JOIN LATERAL unnest(mk.available_actions) a
WHERE r.name = 'admin'
ON CONFLICT (role_id, module_key, action) DO NOTHING;

-- ─── 1b. viewer → read on every module that exposes read (all do) ────────────
INSERT INTO role_permissions (role_id, module_key, action, allowed)
SELECT r.id, mk.key, 'read', true
FROM roles r
CROSS JOIN module_keys mk
WHERE r.name = 'viewer' AND 'read' = ANY (mk.available_actions)
ON CONFLICT (role_id, module_key, action) DO NOTHING;

-- ─── 1c. accountant → read + export on every module (its "everywhere" band) ──
INSERT INTO role_permissions (role_id, module_key, action, allowed)
SELECT r.id, mk.key, a.action, true
FROM roles r
CROSS JOIN module_keys mk
CROSS JOIN LATERAL (VALUES ('read'), ('export')) AS a(action)
WHERE r.name = 'accountant' AND a.action = ANY (mk.available_actions)
ON CONFLICT (role_id, module_key, action) DO NOTHING;

-- ─── 2. Structural admin coverage — derive admin grants from module_keys ─────
CREATE OR REPLACE VIEW v_effective_permissions AS
WITH role_grants AS (
  SELECT eur.entity_id, eur.user_id, rp.module_key, rp.action
  FROM entity_user_roles eur
  JOIN role_permissions rp ON rp.role_id = eur.role_id AND rp.allowed = true
),
-- The `admin` role is "full access to every module and action" by definition.
-- Derive it from the LIVE module_keys registry so a newly-registered module is
-- admin-covered automatically — no role_permissions seed to forget.
admin_grants AS (
  SELECT eur.entity_id, eur.user_id, mk.key AS module_key, a AS action
  FROM entity_user_roles eur
  JOIN roles r ON r.id = eur.role_id AND r.name = 'admin'
  CROSS JOIN module_keys mk
  CROSS JOIN LATERAL unnest(mk.available_actions) a
),
grants_plus AS (
  SELECT entity_id, user_id, module_key, action FROM role_grants
  UNION
  SELECT entity_id, user_id, module_key, action FROM admin_grants
  UNION
  SELECT entity_id, user_id, module_key, action
  FROM entity_user_role_overrides WHERE allowed = true
)
SELECT g.entity_id, g.user_id, g.module_key, g.action, true AS allowed
FROM grants_plus g
WHERE NOT EXISTS (
  SELECT 1 FROM entity_user_role_overrides r
  WHERE r.allowed = false
    AND r.entity_id  = g.entity_id
    AND r.user_id    = g.user_id
    AND r.module_key = g.module_key
    AND r.action     = g.action
);

NOTIFY pgrst, 'reload schema';
