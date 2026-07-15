-- ════════════════════════════════════════════════════════════════════════════
-- P28-4-4 — grant the `cases` module to its roles (scoped RBAC backfill)
-- (#p28-4-4-ap-case, 2026-07-14)
--
-- WHY. The P14 role_permissions seed (mig 20260707000000) grants the admin role
-- "every action on every module" via a ONE-TIME `CROSS JOIN module_keys`. The
-- `cases` module_key was added to module_keys AFTER that seed ran (as the app
-- grew), so no role ever received a `cases` grant — v_effective_permissions has
-- ZERO cases rows for any user. Under RBAC_MODE=enforce (LIVE) any endpoint that
-- explicitly checks `isAllowed(perms,'cases',<action>)` therefore denies everyone.
-- This blocks the P28-4-4 assistant `draft_case` action AND the already-shipped
-- P28-3 `cases_inbox` Today-page to-dos (which need `cases:read`).
--
-- SCOPE. This migration grants ONLY the `cases` module, to mirror the original
-- seed's role bands: admin → all of cases' available_actions (read/write/export);
-- viewer → read; accountant → read + export. Idempotent (ON CONFLICT DO NOTHING)
-- so it only fills the gap, never overwrites an operator's tuned matrix.
--
-- NOTE (flagged separately to the CEO, NOT fixed here): ~70 OTHER module_keys
-- added after the P14 seed are likewise missing their admin grant. Restoring the
-- admin "full access" invariant across all of them is a broader, deliberate RBAC
-- decision and is intentionally out of scope for this feature PR.
-- ════════════════════════════════════════════════════════════════════════════

-- admin → every available action on `cases`.
INSERT INTO role_permissions (role_id, module_key, action, allowed)
SELECT r.id, 'cases', a, true
FROM roles r
CROSS JOIN LATERAL unnest((SELECT available_actions FROM module_keys WHERE key = 'cases')) a
WHERE r.name = 'admin'
ON CONFLICT (role_id, module_key, action) DO NOTHING;

-- viewer → read on `cases`.
INSERT INTO role_permissions (role_id, module_key, action, allowed)
SELECT r.id, 'cases', 'read', true
FROM roles r
WHERE r.name = 'viewer'
ON CONFLICT (role_id, module_key, action) DO NOTHING;

-- accountant → read + export on `cases` (matches its "read/export everywhere" band).
INSERT INTO role_permissions (role_id, module_key, action, allowed)
SELECT r.id, 'cases', a.action, true
FROM roles r
CROSS JOIN LATERAL (VALUES ('read'), ('export')) AS a(action)
WHERE r.name = 'accountant'
ON CONFLICT (role_id, module_key, action) DO NOTHING;
