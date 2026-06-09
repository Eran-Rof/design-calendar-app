-- Password-reset / first-time-set-password tokens for the two PASSWORD-BASED
-- logins in this app:
--   * 'plm'    — homegrown PLM launcher auth (users live in app_data['users'];
--                each user has an sha256 password hash). subject_id = the user
--                id from that JSON blob.
--   * 'vendor' — vendor portal (Supabase Auth). subject_id = auth.users id.
--
-- A "Forgot password?" request mints a cryptographically-random raw token; only
-- its sha256 hash is stored here. The raw token rides the emailed reset link
-- (?reset_token=<token>). The confirm handler verifies the hash exists, is
-- unused, and is unexpired, sets the new password, and marks the token used.
-- This same flow also covers "account has a login but no password yet" (first
-- password set) — for PLM the user simply had an empty password string; for
-- vendor the auth user existed without a password.
--
-- Service-role only — the browser never reads/writes this table (RLS on, no
-- policies → all anon/authenticated access denied; the service role bypasses
-- RLS). Mirrors the vendor_invite_tokens design.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('plm', 'vendor')),
  subject_id   text NOT NULL,            -- PLM: app_data user id; vendor: auth.users id
  email        text NOT NULL,            -- destination address (lower-cased)
  token_hash   text NOT NULL UNIQUE,     -- sha256(raw token); raw token only in the email link
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash    ON password_reset_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_subject ON password_reset_tokens (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_created ON password_reset_tokens (subject_type, subject_id, created_at);

ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE password_reset_tokens IS 'Single-use, time-limited password-reset / first-set tokens for PLM and vendor-portal logins. Only the sha256 hash is stored; raw token rides the emailed link. Service-role only; RLS on with no policies.';

NOTIFY pgrst, 'reload schema';
