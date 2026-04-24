-- 20260425000000_receiving_schema.sql
--
-- Phase 2: one-scan carton receiving foundation
--
-- Changes:
--   cartons                  + channel column (was in ManualCartonInput but never saved)
--   receiving_sessions       new — one row per scan event
--   receiving_session_lines  new — one row per expected child-UPC line

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. Add channel to cartons (was in the form but not persisted)
-- ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE cartons
  ADD COLUMN IF NOT EXISTS channel text;

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. receiving_sessions — one per scan / receive event
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS receiving_sessions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sscc        text        NOT NULL,
  carton_id   uuid        REFERENCES cartons(id) ON DELETE SET NULL,
  status      text        NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'received', 'variance', 'override')),
  received_at timestamptz,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recv_sessions_sscc      ON receiving_sessions (sscc);
CREATE INDEX IF NOT EXISTS idx_recv_sessions_carton    ON receiving_sessions (carton_id);
CREATE INDEX IF NOT EXISTS idx_recv_sessions_status    ON receiving_sessions (status);

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. receiving_session_lines — one per expected child UPC
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS receiving_session_lines (
  id           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid    NOT NULL REFERENCES receiving_sessions(id) ON DELETE CASCADE,
  child_upc    text    NOT NULL,
  style_no     text    NOT NULL,
  color        text    NOT NULL,
  size         text    NOT NULL,
  expected_qty integer NOT NULL CHECK (expected_qty > 0),
  received_qty integer,
  variance_qty integer,
  status       text    NOT NULL DEFAULT 'expected'
                 CHECK (status IN ('expected', 'matched', 'variance')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recv_lines_session ON receiving_session_lines (session_id);
CREATE INDEX IF NOT EXISTS idx_recv_lines_upc     ON receiving_session_lines (child_upc);

-- ══════════════════════════════════════════════════════════════════════════════
-- 4. RLS — same permissive anon policy pattern as other GS1 tables
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['receiving_sessions','receiving_session_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS gs1_anon_all ON %I', t);
    EXECUTE format(
      'CREATE POLICY gs1_anon_all ON %I FOR ALL TO anon USING (true) WITH CHECK (true)', t
    );
  END LOOP;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 5. updated_at trigger for receiving_sessions
-- ══════════════════════════════════════════════════════════════════════════════
DROP TRIGGER IF EXISTS trg_recv_sessions_updated_at ON receiving_sessions;
CREATE TRIGGER trg_recv_sessions_updated_at
  BEFORE UPDATE ON receiving_sessions
  FOR EACH ROW EXECUTE FUNCTION gs1_set_updated_at();
