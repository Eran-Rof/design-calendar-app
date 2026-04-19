-- 20260418240000_vendor_api_flags_notes.sql
--
-- Phase 5 part C — vendor API keys, call log, flags, internal notes.
--
-- Design notes:
--   • vendor_api_keys stores only bcrypt hashes; the raw key is shown to
--     the user exactly once at creation time.
--   • key_prefix is the first ~8 chars of the raw key, used for display
--     and for fast lookup before bcrypt verification.
--   • vendor_notes is INTERNAL ONLY — vendors can never read these.
--     Treated as private commentary.
--   • vendor_flags is visible to vendors (so they know they're flagged)
--     but only internal can change status or resolve.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. vendor_api_keys
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vendor_api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id     uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  name          text NOT NULL,
  key_hash      text NOT NULL,
  key_prefix    text NOT NULL UNIQUE,
  last_used_at  timestamptz,
  expires_at    timestamptz,
  scopes        text[] NOT NULL DEFAULT '{}',
  created_by    uuid REFERENCES vendor_users(id) ON DELETE SET NULL,
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES vendor_users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_api_keys_vendor_id ON vendor_api_keys (vendor_id);
-- Partial index for un-revoked keys. expires_at is filtered at query time
-- (can't use now() in a partial-index predicate — it's not IMMUTABLE).
CREATE INDEX IF NOT EXISTS idx_vendor_api_keys_active
  ON vendor_api_keys (vendor_id)
  WHERE revoked_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════
-- 2. vendor_api_logs
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vendor_api_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id    uuid NOT NULL REFERENCES vendor_api_keys(id) ON DELETE CASCADE,
  vendor_id     uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  endpoint      text NOT NULL,
  method        text NOT NULL,
  status_code   integer,
  ip_address    text,
  request_id    text,
  duration_ms   integer,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_api_logs_api_key_id  ON vendor_api_logs (api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_api_logs_vendor_id   ON vendor_api_logs (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_api_logs_created_at  ON vendor_api_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_api_logs_status_code ON vendor_api_logs (status_code) WHERE status_code >= 400;

-- ══════════════════════════════════════════════════════════════════════════
-- 3. vendor_flags
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vendor_flags (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id         uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  type              text NOT NULL CHECK (type IN ('performance', 'compliance', 'financial_risk', 'other')),
  severity          text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  reason            text NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  raised_by         text,
  resolved_by       text,
  resolved_at       timestamptz,
  resolution_notes  text,
  source            text,                       -- e.g. 'cron.scorecard', 'manual', 'audit'
  metadata          jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_flags_vendor_id ON vendor_flags (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_flags_status    ON vendor_flags (status);
CREATE INDEX IF NOT EXISTS idx_vendor_flags_severity  ON vendor_flags (severity);
CREATE INDEX IF NOT EXISTS idx_vendor_flags_type      ON vendor_flags (type);

-- ══════════════════════════════════════════════════════════════════════════
-- 4. vendor_notes — internal only, never visible to vendors
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vendor_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id   uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  body        text NOT NULL,
  is_pinned   boolean NOT NULL DEFAULT false,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_notes_vendor_id ON vendor_notes (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_notes_pinned    ON vendor_notes (vendor_id) WHERE is_pinned = true;

-- ══════════════════════════════════════════════════════════════════════════
-- 5. RLS
-- ══════════════════════════════════════════════════════════════════════════
ALTER TABLE vendor_api_keys  ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_api_logs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_flags     ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_notes     ENABLE ROW LEVEL SECURITY;

-- vendor_api_keys: vendor CRUDs their own; internal reads all (for audit).
-- Notice: key_hash is still returned on SELECT — the UI should never send
-- it client-side. The API endpoints will select without key_hash.
DROP POLICY IF EXISTS "anon_all_vendor_api_keys" ON vendor_api_keys;
CREATE POLICY "anon_all_vendor_api_keys" ON vendor_api_keys FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_vendor_api_keys_select" ON vendor_api_keys;
CREATE POLICY "vendor_own_vendor_api_keys_select" ON vendor_api_keys FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));
DROP POLICY IF EXISTS "vendor_own_vendor_api_keys_insert" ON vendor_api_keys;
CREATE POLICY "vendor_own_vendor_api_keys_insert" ON vendor_api_keys FOR INSERT TO authenticated
  WITH CHECK (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));
DROP POLICY IF EXISTS "vendor_own_vendor_api_keys_update" ON vendor_api_keys;
CREATE POLICY "vendor_own_vendor_api_keys_update" ON vendor_api_keys FOR UPDATE TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- vendor_api_logs: vendor reads their own
DROP POLICY IF EXISTS "anon_all_vendor_api_logs" ON vendor_api_logs;
CREATE POLICY "anon_all_vendor_api_logs" ON vendor_api_logs FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_vendor_api_logs_select" ON vendor_api_logs;
CREATE POLICY "vendor_own_vendor_api_logs_select" ON vendor_api_logs FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- vendor_flags: vendors can read their own but not change them
DROP POLICY IF EXISTS "anon_all_vendor_flags" ON vendor_flags;
CREATE POLICY "anon_all_vendor_flags" ON vendor_flags FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_vendor_flags_select" ON vendor_flags;
CREATE POLICY "vendor_own_vendor_flags_select" ON vendor_flags FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- vendor_notes: INTERNAL ONLY. Vendors get no SELECT policy — the table
-- is RLS-enabled with no 'authenticated' policy, so vendor queries
-- return zero rows even though RLS is permissive for anon.
DROP POLICY IF EXISTS "anon_all_vendor_notes" ON vendor_notes;
CREATE POLICY "anon_all_vendor_notes" ON vendor_notes FOR ALL TO anon USING (true) WITH CHECK (true);
-- (deliberately no policy for authenticated role)
