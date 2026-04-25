-- 20260427000000_xoro_sync.sql
--
-- Phase 4: Xoro UPC sync foundation
--
-- Changes:
--   company_settings    + xoro_item_endpoint, xoro_enabled
--   xoro_sync_logs      new — one row per sync run

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. Xoro config columns on company_settings
-- ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS xoro_item_endpoint text,
  ADD COLUMN IF NOT EXISTS xoro_enabled       boolean NOT NULL DEFAULT false;

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. Sync log table
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS xoro_sync_logs (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_type           text        NOT NULL,
  status              text        NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'complete', 'error')),
  started_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  records_processed   integer     NOT NULL DEFAULT 0,
  records_inserted    integer     NOT NULL DEFAULT 0,
  records_updated     integer     NOT NULL DEFAULT 0,
  error_message       text,
  raw_summary         jsonb
);

CREATE INDEX IF NOT EXISTS idx_xoro_sync_logs_type       ON xoro_sync_logs (sync_type);
CREATE INDEX IF NOT EXISTS idx_xoro_sync_logs_started_at ON xoro_sync_logs (started_at DESC);

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. RLS — same permissive anon pattern as other GS1 tables
-- ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE xoro_sync_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gs1_anon_all ON xoro_sync_logs;
CREATE POLICY gs1_anon_all ON xoro_sync_logs
  FOR ALL TO anon USING (true) WITH CHECK (true);
