-- 20261700000000_margins_capability_permission.sql
-- ════════════════════════════════════════════════════════════════════════════
-- Margin visibility as a P14 RBAC capability.
--
-- CEO ask: "Any margin% / margin$ column ANYWHERE in the app must be part of
-- user permissions." Margin (GM%, margin $, cost-derived profitability) becomes
-- a grant-gated capability: users WITHOUT it see grids/reports with margin
-- columns ABSENT; users WITH it see them exactly as today.
--
-- Modeled as a NON-NAV capability module_key `margins` with two actions:
--   • margins:read   — may VIEW margin columns / KPIs / report fields
--   • margins:export — may EXPORT margin data (CSV/Excel)
-- It is not a menu destination, so it is intentionally absent from the nav
-- module mirror (src/erp/modules.ts → api/_lib/tangerineModules.js). The User
-- Access admin grid surfaces it via the hand-curated capability list in
-- api/_lib/capabilityModules.js (unioned into the grid by the users-access
-- handler), so the CEO can grant/revoke it per user like any other cell.
--
-- DEFAULT GRANTS — so nothing disappears for finance/admin on deploy:
--   • admin      → read + export  (the CEO's role; MUST keep margin visibility)
--   • accountant → read + export  (finance legitimately needs margin)
--   • viewer     → NOT granted    (the restricted role; margin hidden by design)
-- Per-user allow/revoke overrides ride entity_user_role_overrides as usual.
--
-- Enforcement is inert until RBAC_MODE=enforce (frontend useCanSeeMargins() and
-- the API helper both fail OPEN otherwise), so this migration is a no-op for
-- visibility until enforcement is on — exactly like every other P14 grant.
--
-- Idempotent (ON CONFLICT DO NOTHING) — safe to re-apply under db-push.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Register the capability module_key ──────────────────────────────────
INSERT INTO module_keys (key, display_name, group_name, sort_order, description, available_actions)
VALUES (
  'margins',
  'Margin Visibility',
  'Data Visibility',
  900,
  'Gates visibility + export of margin% / margin$ (gross margin) columns app-wide.',
  ARRAY['read','export']::text[]
)
ON CONFLICT (key) DO NOTHING;

-- ─── 2. Default role grants (admin + accountant get read + export) ───────────
INSERT INTO role_permissions (role_id, module_key, action, allowed)
SELECT r.id, 'margins', a.action, true
FROM roles r
CROSS JOIN (VALUES ('read'), ('export')) AS a(action)
WHERE r.name IN ('admin', 'accountant')
ON CONFLICT (role_id, module_key, action) DO NOTHING;

NOTIFY pgrst, 'reload schema';
