-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P4-6 — Overdue notification dedup log
--
-- Stores one row per (entity_id, customer_id, bucket, sent_on) so the daily
-- overdue cron is idempotent across same-day re-runs. The cron does an UPSERT
-- against the unique key and skips the notification enqueue if the row already
-- existed prior to that day.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS notifications_overdue_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  bucket      text NOT NULL,
  sent_on     date NOT NULL DEFAULT current_date,
  open_cents  bigint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_overdue_log_bucket_check
    CHECK (bucket IN ('30d','60d','90d','120d_plus'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_overdue_log
  ON notifications_overdue_log (entity_id, customer_id, bucket, sent_on);

CREATE INDEX IF NOT EXISTS idx_notifications_overdue_log_lookup
  ON notifications_overdue_log (entity_id, sent_on DESC);

ALTER TABLE notifications_overdue_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_notifications_overdue_log" ON notifications_overdue_log
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_internal_notifications_overdue_log" ON notifications_overdue_log
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

COMMENT ON TABLE notifications_overdue_log IS
  'P4-6 dedup log for the daily AR-aging overdue cron. One row per (entity, customer, bucket, day) — UNIQUE prevents same-day re-fires.';

NOTIFY pgrst, 'reload schema';
