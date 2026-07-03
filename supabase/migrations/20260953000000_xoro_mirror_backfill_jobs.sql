-- ════════════════════════════════════════════════════════════════════════════
-- xoro_mirror_backfill_jobs — durable queue for UNATTENDED range backfills.
--
-- The Shadow Mirror range backfill mirrors every date in [from, to], one per
-- date, into that date's own period. A large span is more than one serverless
-- invocation can do, so instead of holding the operator's browser open we
-- enqueue a job here and a worker cron (api/cron/xoro-mirror-backfill-worker)
-- drains it a chunk at a time, advancing `cursor_date` after each committed
-- chunk. The operator can kick it off and close the tab.
--
-- Resumable + idempotent: `cursor_date` is the next unprocessed date, so a crash
-- resumes there; the underlying per-date mirror + summary JEs are idempotent
-- (already-posted JEs skip, mirror rows upsert). A 'running' job whose heartbeat
-- (updated_at) is stale can be reclaimed by the next worker tick.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS xoro_mirror_backfill_jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  from_date          date NOT NULL,
  to_date            date NOT NULL,
  cursor_date        date NOT NULL,          -- next date to process (starts = from_date)
  chunk_days         int  NOT NULL DEFAULT 45 CHECK (chunk_days > 0),
  status             text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','complete','failed','cancelled')),
  days_total         int  NOT NULL DEFAULT 0,
  days_done          int  NOT NULL DEFAULT 0,
  -- Rolling aggregates across processed chunks.
  totals             jsonb NOT NULL DEFAULT '{"ar_upserted":0,"ap_upserted":0,"inventory_upserted":0,"summary_jes_posted":0}'::jsonb,
  je_count           int  NOT NULL DEFAULT 0,
  errors             jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_error         text,
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),   -- worker heartbeat
  started_at         timestamptz,
  completed_at       timestamptz,
  CONSTRAINT xoro_mirror_backfill_jobs_range_ok CHECK (from_date <= to_date),
  CONSTRAINT xoro_mirror_backfill_jobs_cursor_ok CHECK (cursor_date >= from_date)
);

-- Worker claims the oldest actionable job; index the claim predicate.
CREATE INDEX IF NOT EXISTS xoro_mirror_backfill_jobs_claim_idx
  ON xoro_mirror_backfill_jobs (status, updated_at)
  WHERE status IN ('pending','running');
CREATE INDEX IF NOT EXISTS xoro_mirror_backfill_jobs_entity_idx
  ON xoro_mirror_backfill_jobs (entity_id, created_at DESC);

-- RLS — P1 anon_all + auth_internal template (service role bypasses; the worker
-- + endpoints run as service role).
ALTER TABLE xoro_mirror_backfill_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_xoro_mirror_backfill_jobs" ON xoro_mirror_backfill_jobs;
CREATE POLICY "anon_all_xoro_mirror_backfill_jobs" ON xoro_mirror_backfill_jobs FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "auth_internal_xoro_mirror_backfill_jobs" ON xoro_mirror_backfill_jobs;
CREATE POLICY "auth_internal_xoro_mirror_backfill_jobs" ON xoro_mirror_backfill_jobs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
