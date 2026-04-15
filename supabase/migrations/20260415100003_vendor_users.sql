-- 0003_vendor_users.sql
--
-- Links Supabase Auth users (external vendor logins, separate from the
-- internal custom auth in app_data['users']) to rows in the vendors table.
-- RLS policies on tanda_pos and other tables join through this to scope
-- a vendor login to only their own data.

CREATE TABLE IF NOT EXISTS vendor_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_id       uuid UNIQUE NOT NULL
                  REFERENCES auth.users(id) ON DELETE CASCADE,
  vendor_id     uuid NOT NULL
                  REFERENCES vendors(id) ON DELETE RESTRICT,
  display_name  text,
  role          text NOT NULL DEFAULT 'primary',
  last_login    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_users_auth_id   ON vendor_users (auth_id);
CREATE INDEX IF NOT EXISTS idx_vendor_users_vendor_id ON vendor_users (vendor_id);
