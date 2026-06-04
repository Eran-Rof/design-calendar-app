-- vendor_users.status was referenced by api/_lib/auth.js (login gate) and the
-- vendor-access admin panel, but the column was never created -- causing
-- "column vendor_users.status does not exist". Add it, default 'active' so all
-- existing vendor logins remain enabled.
-- The CHECK matches exactly the values the code writes: 'active' (login gate +
-- enable action + insert default), 'disabled' (disable action), 'removed'
-- (remove action soft-fallback).
ALTER TABLE vendor_users
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'disabled', 'removed'));
CREATE INDEX IF NOT EXISTS idx_vendor_users_status ON vendor_users (status);
