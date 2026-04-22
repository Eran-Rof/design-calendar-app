-- 20260422000000_app_data_rls.sql
--
-- Enable RLS on public.app_data with the same anon-permissive pattern
-- used on tanda_pos and the other legacy-shared tables (see
-- 20260415100004_rls_policies.sql).
--
-- Why: app_data was created ad-hoc before the migration system existed
-- and never got RLS, which Supabase's security advisor flags as
-- "fully exposed to anon". The internal apps rely on reading/writing
-- app_data with the anon key (users, vendors, wip_templates, etc.),
-- so enabling RLS without a permissive policy would break them.
-- This migration enables RLS *and* adds the same permissive policy,
-- closing the advisor warning without changing application behaviour.

ALTER TABLE IF EXISTS public.app_data ENABLE ROW LEVEL SECURITY;

-- Drop-if-exists keeps this re-runnable against a DB that may already
-- have a hand-added policy of the same name.
DROP POLICY IF EXISTS "anon_all_app_data" ON public.app_data;

CREATE POLICY "anon_all_app_data" ON public.app_data
  FOR ALL TO anon
  USING (true)
  WITH CHECK (true);
