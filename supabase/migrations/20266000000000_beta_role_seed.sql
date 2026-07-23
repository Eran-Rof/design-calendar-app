-- 20266000000000_beta_role_seed.sql
-- ════════════════════════════════════════════════════════════════════════════
-- Beta guardrails — Chunk B: the `beta` P14 RBAC role.
--
-- INTENT. Beta testers work on PRODUCTION. They must be able to create and
-- edit DRAFTS everywhere (drafts delete cleanly) but must NEVER post or void
-- accounting documents (posting is irreversible). The dispatcher's rbacEnforce
-- (RBAC_MODE=enforce, api/_lib/rbac/routePermissions.js) maps every posting
-- route — /post, /pay, /approve, /fund, /settle, /void, month-end close/reopen
-- — to action 'post' or 'void', so a role that holds read/write/export but NO
-- post/void rows is automatically 403'd from all of them. Under
-- v_effective_permissions ABSENCE of a (module,action) row = DENY; that is the
-- convention this seed relies on (no allowed=false rows are ever seeded for
-- roles — deny-overrides live in entity_user_role_overrides only).
--
-- WHAT THIS SEEDS
--   • roles: `beta` (is_seed, normal stored-grant role — NOT view-derived like
--     admin's structural coverage in 20262340000000; beta grants come solely
--     from its role_permissions rows, exactly like accountant/viewer).
--   • role_permissions: for EVERY module currently in module_keys, actions
--     read / write / export INTERSECTED with that module's available_actions
--     (mirrors the accountant/viewer seed pattern in 20260707000000). No
--     'post' rows. No 'void' rows. Ever.
--   • Defensive DELETE of any post/void rows for beta — self-healing on
--     re-apply and a guard against a future accidental grant sweep.
--
-- ⚠ FAIL-CLOSED BY DESIGN: module_keys rows added AFTER this migration runs
-- (scripts/seed-module-keys.mjs upserts new nav modules) will NOT auto-grant
-- to beta. A beta tester simply cannot see a brand-new module until an
-- operator grants it (User Access matrix or a follow-up seed). That is
-- intentional — new surface area defaults to invisible for beta, never to
-- writable.
--
-- Idempotent (ON CONFLICT DO NOTHING / targeted DELETE) — safe to re-apply
-- under supabase-db-push.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. The beta role ────────────────────────────────────────────────────────
INSERT INTO roles (name, description, is_seed) VALUES
  ('beta', 'Beta tester — can create and edit drafts everywhere; cannot post or void accounting documents.', true)
ON CONFLICT (name) DO NOTHING;

-- ─── 2. Grants: read/write/export ∩ each module's available_actions ──────────
--        (same INSERT…SELECT shape as the accountant/viewer seeds — the
--        available_actions filter means read-only modules stay read-only for
--        beta, report modules stay read/export, etc. Explicitly NO 'post',
--        NO 'void' — absence = deny under v_effective_permissions.)
INSERT INTO role_permissions (role_id, module_key, action, allowed)
SELECT r.id, mk.key, a.action, true
FROM roles r
CROSS JOIN module_keys mk
CROSS JOIN LATERAL (VALUES ('read'), ('write'), ('export')) AS a(action)
WHERE r.name = 'beta'
  AND a.action = ANY (mk.available_actions)
ON CONFLICT (role_id, module_key, action) DO NOTHING;

-- ─── 3. Defensive cleanup — beta must NEVER hold post/void ───────────────────
--        Self-healing on re-apply: if any future sweep / manual edit ever
--        attaches a post or void grant to beta, re-running this migration
--        strips it again.
DELETE FROM role_permissions
WHERE role_id = (SELECT id FROM roles WHERE name = 'beta')
  AND action IN ('post', 'void');

NOTIFY pgrst, 'reload schema';
