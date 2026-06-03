-- Custom vendor-portal invite tokens with a 72h lifetime.
--
-- Supabase hard-caps the email OTP / action-link expiry at 86400s (24h), so the
-- built-in invite link can't stay valid for 72h. This table backs a custom
-- invite flow: the invite handler mints a random token (only its sha256 hash is
-- stored), emails a /vendor/setup?invite=<token> link via Resend, and the
-- accept-invite handler sets the user's password when they click it.
--
-- Service-role only — the browser never reads/writes this table (RLS on, no
-- policies → all anon/authenticated access denied; service role bypasses RLS).

CREATE TABLE IF NOT EXISTS vendor_invite_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id    uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  auth_id      uuid,                      -- auth.users id, resolved at invite time
  email        text NOT NULL,
  display_name text,
  token_hash   text NOT NULL UNIQUE,      -- sha256(raw token); raw token only in the email link
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_invite_tokens_hash ON vendor_invite_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_vendor_invite_tokens_email ON vendor_invite_tokens (lower(email));

ALTER TABLE vendor_invite_tokens ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE vendor_invite_tokens IS 'Custom 72h vendor-portal invite tokens (Supabase email-link expiry caps at 24h). Service-role only; RLS on with no policies.';
