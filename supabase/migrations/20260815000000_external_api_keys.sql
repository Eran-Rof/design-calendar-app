-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine M15 — External / Partner API keys (external_api_keys)
--
-- Backs the documented, API-key-authenticated, READ-ONLY external REST API
-- (/api/external/v1/*) and the Admin -> API Keys panel that manages the keys.
--
-- A key is issued in the shape "prefix.secret". We store ONLY:
--   key_prefix — the public lookup token (first segment, before the dot)
--   key_hash   — sha-256 hex of the FULL raw key
-- The plaintext secret is shown to the operator exactly once at create time and
-- is never persisted, logged, or returned again. Verification re-hashes the
-- presented Bearer key and timing-safe compares against key_hash.
--
-- Scopes default to {read}; writes are out of scope for this build. Every key is
-- entity-scoped (entity_id) so the external API only ever returns one tenant's
-- data. Writes to this table happen service-role from the internal handlers; RLS
-- stays anon-permissive for read, consistent with the other Tangerine masters.
--
-- Idempotent: CREATE ... IF NOT EXISTS, CREATE OR REPLACE, DROP/CREATE.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS external_api_keys (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  label              text NOT NULL,
  key_prefix         text NOT NULL,
  key_hash           text NOT NULL,
  scopes             text[] NOT NULL DEFAULT '{read}',
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT uq_external_api_keys_prefix UNIQUE (key_prefix)
);

CREATE INDEX IF NOT EXISTS idx_external_api_keys_entity_active
  ON external_api_keys (entity_id, is_active);

ALTER TABLE external_api_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_external_api_keys" ON external_api_keys;
CREATE POLICY "anon_all_external_api_keys" ON external_api_keys
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_external_api_keys" ON external_api_keys;
CREATE POLICY "auth_internal_external_api_keys" ON external_api_keys
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

COMMENT ON TABLE  external_api_keys IS 'Tangerine M15 external/partner API keys. One row per issued key per entity. Stores only key_prefix plus the sha-256 hash of the full raw key; the plaintext secret is shown once at create time and never persisted.';
COMMENT ON COLUMN external_api_keys.label IS 'Operator-facing name for the integration this key belongs to.';
COMMENT ON COLUMN external_api_keys.key_prefix IS 'Public lookup token (first segment of the raw key, before the dot). Unique. Safe to display.';
COMMENT ON COLUMN external_api_keys.key_hash IS 'sha-256 hex of the full raw key prefix.secret. Verified by timing-safe compare; the plaintext is never stored.';
COMMENT ON COLUMN external_api_keys.scopes IS 'Granted scopes. Defaults to read; the external API is read-only in this build.';
COMMENT ON COLUMN external_api_keys.last_used_at IS 'Best-effort timestamp of the last successful authenticated request with this key.';
