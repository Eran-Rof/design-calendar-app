-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P3 / Chunk 8 / Migration 1
-- M39 Mobile Scanner - schema for scanner_sessions + scanner_events.
--
-- Per docs/tangerine/P3-acc-core-architecture.md §6.
--
-- This is the BACK-END CONTRACT ONLY. The native iOS/Android shell ships in
-- the M39 mobile-app implementation chunk; that's a separate work stream.
--
-- Tables:
--   scanner_sessions  — one row per operator scan flow (receive/pick/...).
--   scanner_events    — append-only log of every scan, with offline-replay
--                       idempotency keyed by (session_id, client_event_id).
--
-- Triggers:
--   scanner_sessions_touch          — std updated_at bump on UPDATE
--   scanner_event_session_touch     — bumps session.scanned_at on event INSERT
--
-- RLS:
--   - sessions: P1 template + auth_own_scanner_sessions
--     (device_user_id = auth.uid() — devices only see their own sessions)
--   - events:   append-only (SELECT + INSERT only, no UPDATE/DELETE policies)
-- ════════════════════════════════════════════════════════════════════════════

-- ─── scanner_sessions ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scanner_sessions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id              uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  device_user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  mode                   text NOT NULL,
  target_kind            text NOT NULL,
  target_id              uuid NULL,
  status                 text NOT NULL DEFAULT 'open',
  scanned_at             timestamptz,
  submitted_at           timestamptz,
  client_meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  created_by_user_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT scanner_sessions_mode_check
    CHECK (mode IN ('receive','pick','transfer','count')),
  CONSTRAINT scanner_sessions_target_kind_check
    CHECK (target_kind IN ('po','so','cycle_count','adhoc')),
  CONSTRAINT scanner_sessions_status_check
    CHECK (status IN ('open','submitted','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_scanner_sessions_entity_status
  ON scanner_sessions (entity_id, status);
CREATE INDEX IF NOT EXISTS idx_scanner_sessions_user_status
  ON scanner_sessions (device_user_id, status);
CREATE INDEX IF NOT EXISTS idx_scanner_sessions_target
  ON scanner_sessions (target_kind, target_id)
  WHERE target_id IS NOT NULL;

COMMENT ON TABLE scanner_sessions IS 'M39 mobile scanner — one row per operator scan flow against a single target (PO / SO / cycle count / adhoc). status=open while scanning, submitted after operator submits the session, cancelled if abandoned.';
COMMENT ON COLUMN scanner_sessions.device_user_id IS 'auth.users id of the device operator. RLS auth_own_scanner_sessions clamps SELECTs so each device only sees its own sessions.';
COMMENT ON COLUMN scanner_sessions.target_kind IS 'Discriminator for target_id semantics. po → purchase_orders; so → sales_orders; cycle_count → inventory_cycle_counts; adhoc → no target.';
COMMENT ON COLUMN scanner_sessions.scanned_at IS 'Last scan activity touch, bumped by trigger when scanner_events insert.';
COMMENT ON COLUMN scanner_sessions.client_meta IS 'Device id, app version, network flags. Free-form jsonb so the mobile apps can evolve without schema migrations.';

-- ─── scanner_events ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scanner_events (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id              uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  session_id             uuid NOT NULL REFERENCES scanner_sessions(id) ON DELETE CASCADE,
  client_event_id        uuid NOT NULL,
  scanned_barcode        text NOT NULL,
  resolved_item_id       uuid REFERENCES ip_item_master(id) ON DELETE SET NULL,
  qty                    numeric(18,4) NOT NULL DEFAULT 1,
  client_timestamp       timestamptz NOT NULL,
  server_received_at     timestamptz NOT NULL DEFAULT now(),
  notes                  text,
  CONSTRAINT uq_scanner_events_session_client
    UNIQUE (session_id, client_event_id)
);

CREATE INDEX IF NOT EXISTS idx_scanner_events_session_log
  ON scanner_events (session_id, server_received_at);

COMMENT ON TABLE scanner_events IS 'M39 mobile scanner — append-only log of every scan. Sessions are reconstructed by replaying this table. UNIQUE(session_id, client_event_id) gives idempotent offline replays.';
COMMENT ON COLUMN scanner_events.client_event_id IS 'Idempotency key — device generates this UUID at scan time so offline queue replays are dedup-safe at the DB level via ON CONFLICT.';
COMMENT ON COLUMN scanner_events.resolved_item_id IS 'NULL when the device could not resolve the barcode to ip_item_master at scan time. Server will retry resolution at submit.';

-- ════════════════════════════════════════════════════════════════════════════
-- RLS
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE scanner_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scanner_events   ENABLE ROW LEVEL SECURITY;

-- scanner_sessions: P1 template + own-session clamp for devices
DROP POLICY IF EXISTS "anon_all_scanner_sessions" ON scanner_sessions;
CREATE POLICY "anon_all_scanner_sessions" ON scanner_sessions
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_scanner_sessions" ON scanner_sessions;
CREATE POLICY "auth_internal_scanner_sessions" ON scanner_sessions
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- Additional clamp: device operators only see their own sessions. Admin paths
-- continue to use service_role / anon which bypass RLS.
DROP POLICY IF EXISTS "auth_own_scanner_sessions" ON scanner_sessions;
CREATE POLICY "auth_own_scanner_sessions" ON scanner_sessions
  FOR SELECT TO authenticated
  USING (device_user_id = auth.uid());

-- scanner_events: append-only. SELECT + INSERT only. No UPDATE/DELETE policies
-- means authenticated users cannot mutate history (service_role still can,
-- but that's the operator escape hatch, not the device path).
DROP POLICY IF EXISTS "anon_select_scanner_events" ON scanner_events;
CREATE POLICY "anon_select_scanner_events" ON scanner_events
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon_insert_scanner_events" ON scanner_events;
CREATE POLICY "anon_insert_scanner_events" ON scanner_events
  FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS "auth_select_scanner_events" ON scanner_events;
CREATE POLICY "auth_select_scanner_events" ON scanner_events
  FOR SELECT TO authenticated
  USING (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_insert_scanner_events" ON scanner_events;
CREATE POLICY "auth_insert_scanner_events" ON scanner_events
  FOR INSERT TO authenticated
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- ════════════════════════════════════════════════════════════════════════════
-- Triggers
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION scanner_sessions_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS scanner_sessions_touch_trg ON scanner_sessions;
CREATE TRIGGER scanner_sessions_touch_trg
  BEFORE UPDATE ON scanner_sessions
  FOR EACH ROW EXECUTE FUNCTION scanner_sessions_touch();

-- Bump scanned_at on session whenever a new event lands
CREATE OR REPLACE FUNCTION scanner_event_session_touch() RETURNS trigger AS $$
BEGIN
  UPDATE scanner_sessions
     SET scanned_at = NEW.server_received_at
   WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS scanner_event_session_touch_trg ON scanner_events;
CREATE TRIGGER scanner_event_session_touch_trg
  AFTER INSERT ON scanner_events
  FOR EACH ROW EXECUTE FUNCTION scanner_event_session_touch();
