-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P10 — RLS audit probe (operator-runnable diagnostic).
--
-- Reports every auth_internal_* RLS policy on a public table and flags any
-- whose USING / WITH CHECK expression does NOT reference entity_id. The
-- output is meant to be eyeballed by the operator — green rows = OK,
-- non-OK rows are candidates for the P10-3/P10-4 entity-scoping pass.
--
-- Run as service_role (or as a Supabase admin user via the SQL editor)
-- so pg_policies is readable.
--
-- Categories:
--   OK    — policy expression references both entity_id AND entity_users
--           (the canonical "tenant filter via membership" shape).
--   WARN  — references entity_id but no entity_users join (likely a
--           service-only deny rule; verify manually).
--   FAIL  — no entity_id reference at all → the policy is tenant-blind.
--
-- The `||` text concatenation inside the WITH clause is a runtime
-- expression (NOT a DDL constant) so it is unaffected by the
-- migrations-comment-concat lint that bans `COMMENT ON … IS 'a' || 'b'`.
-- ════════════════════════════════════════════════════════════════════════════

WITH suspect_policies AS (
  SELECT
    schemaname,
    tablename,
    policyname,
    cmd,
    coalesce(qual::text, '') || ' ' || coalesce(with_check::text, '') AS expr_text
  FROM pg_policies
  WHERE policyname LIKE 'auth_internal_%'
    AND schemaname = 'public'
)
SELECT
  schemaname,
  tablename,
  policyname,
  cmd,
  CASE
    WHEN expr_text LIKE '%entity_id%' THEN 'OK'
    ELSE 'MISSING entity_id'
  END AS audit_status,
  CASE
    WHEN expr_text LIKE '%entity_id%' AND expr_text LIKE '%entity_users%' THEN 'OK'
    WHEN expr_text LIKE '%entity_id%' THEN 'WARN: entity_id check but no entity_users join'
    ELSE 'FAIL: no entity_id reference at all'
  END AS detail
FROM suspect_policies
ORDER BY audit_status DESC, tablename, policyname;
