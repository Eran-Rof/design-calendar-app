-- 20260707010000_p14_chunk3_rbac_grant_rls_lockdown.sql
-- ════════════════════════════════════════════════════════════════════════════
-- P14 RBAC — Chunk 3b hardening: make the RBAC tables ANON-READ-ONLY.
--
-- P14-1 shipped these 5 tables with the canonical `anon FOR ALL USING(true)`
-- policy (matching every other internal table) so nothing broke on day 1. But
-- these tables ARE the permission system — a browser holding the shared anon
-- key must not be able to rewrite its own role/permissions directly via
-- PostgREST. So we narrow anon to SELECT (the admin UI + middleware read them)
-- and remove anon write. All writes now flow ONLY through the service-role
-- admin handler (api/_handlers/internal/users-access/*), which is gated by the
-- rbacEnforce middleware on users_access:write. The service-role key bypasses
-- RLS, so handler writes are unaffected; direct anon writes are blocked.
--
-- This is the achievable, correct hardening for the current anon-key data
-- layer. (The deeper best-in-class move — retire the browser anon key for the
-- internal apps in favour of per-user JWT + permission-aware RLS — is a
-- separate future security phase.)
--
-- Idempotent: drop-and-recreate policies under fixed names.
-- ════════════════════════════════════════════════════════════════════════════

-- module_keys
DROP POLICY IF EXISTS "anon_all_module_keys" ON module_keys;
DROP POLICY IF EXISTS "anon_read_module_keys" ON module_keys;
CREATE POLICY "anon_read_module_keys" ON module_keys FOR SELECT TO anon USING (true);

-- roles
DROP POLICY IF EXISTS "anon_all_roles" ON roles;
DROP POLICY IF EXISTS "anon_read_roles" ON roles;
CREATE POLICY "anon_read_roles" ON roles FOR SELECT TO anon USING (true);

-- role_permissions
DROP POLICY IF EXISTS "anon_all_role_permissions" ON role_permissions;
DROP POLICY IF EXISTS "anon_read_role_permissions" ON role_permissions;
CREATE POLICY "anon_read_role_permissions" ON role_permissions FOR SELECT TO anon USING (true);

-- entity_user_roles  (the per-user role assignment — the sensitive one)
DROP POLICY IF EXISTS "anon_all_entity_user_roles" ON entity_user_roles;
DROP POLICY IF EXISTS "anon_read_entity_user_roles" ON entity_user_roles;
CREATE POLICY "anon_read_entity_user_roles" ON entity_user_roles FOR SELECT TO anon USING (true);

-- entity_user_role_overrides
DROP POLICY IF EXISTS "anon_all_eur_overrides" ON entity_user_role_overrides;
DROP POLICY IF EXISTS "anon_read_eur_overrides" ON entity_user_role_overrides;
CREATE POLICY "anon_read_eur_overrides" ON entity_user_role_overrides FOR SELECT TO anon USING (true);

NOTIFY pgrst, 'reload schema';
