-- 0004_rls_policies.sql
--
-- Enables RLS on tanda_pos, vendors, and vendor_users using the
-- anon-permissive + authenticated-filtered pattern:
--
--   • anon role (internal four sub-apps) gets FOR ALL USING (true) —
--     behavior is unchanged from today.
--   • authenticated role (external vendor logins via Supabase Auth) gets
--     SELECT-only policies scoped via vendor_users.
--
-- This preserves internal-app behavior while allowing the future vendor
-- portal (Phase 1) to safely expose only a vendor's own data.

-- ── tanda_pos ────────────────────────────────────────────────────────────────
ALTER TABLE tanda_pos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_tanda_pos" ON tanda_pos;
CREATE POLICY "anon_all_tanda_pos" ON tanda_pos
  FOR ALL TO anon
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "vendor_own_tanda_pos" ON tanda_pos;
CREATE POLICY "vendor_own_tanda_pos" ON tanda_pos
  FOR SELECT TO authenticated
  USING (
    vendor_id IN (
      SELECT vu.vendor_id FROM vendor_users vu
       WHERE vu.auth_id = auth.uid()
    )
  );

-- ── vendors ──────────────────────────────────────────────────────────────────
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_vendors" ON vendors;
CREATE POLICY "anon_all_vendors" ON vendors
  FOR ALL TO anon
  USING (true)
  WITH CHECK (true);

-- Vendor logins can read only their own vendor row.
DROP POLICY IF EXISTS "vendor_own_vendor_row" ON vendors;
CREATE POLICY "vendor_own_vendor_row" ON vendors
  FOR SELECT TO authenticated
  USING (
    id IN (
      SELECT vu.vendor_id FROM vendor_users vu
       WHERE vu.auth_id = auth.uid()
    )
  );

-- ── vendor_users ─────────────────────────────────────────────────────────────
ALTER TABLE vendor_users ENABLE ROW LEVEL SECURITY;

-- Anon (internal admin UI via service role or the anon-key admin tools the
-- internal apps use today) can manage vendor_users rows. Invite flow also
-- inserts here via a serverless function using service_role, which bypasses
-- RLS anyway — this policy just keeps the anon-app symmetry intact.
DROP POLICY IF EXISTS "anon_all_vendor_users" ON vendor_users;
CREATE POLICY "anon_all_vendor_users" ON vendor_users
  FOR ALL TO anon
  USING (true)
  WITH CHECK (true);

-- A vendor login can only see their own vendor_users row (to render their
-- own display name / role, etc.).
DROP POLICY IF EXISTS "vendor_own_vendor_user_row" ON vendor_users;
CREATE POLICY "vendor_own_vendor_user_row" ON vendor_users
  FOR SELECT TO authenticated
  USING (auth_id = auth.uid());

-- ── app_data (keep anon access unchanged) ────────────────────────────────────
-- If RLS is ever enabled on app_data, internal apps must keep working. We do
-- not enable it here; only document the required policy pattern should it be
-- turned on later:
--
--   ALTER TABLE app_data ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY "anon_all_app_data" ON app_data
--     FOR ALL TO anon USING (true) WITH CHECK (true);
--
-- Vendor logins have NO read access to app_data by design (contains internal
-- users, templates, settings).
