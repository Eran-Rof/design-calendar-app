-- ════════════════════════════════════════════════════════════════════════════
-- P11-10 Chunk 1: dropbox_backfill_failures quarantine table
--
-- One-shot bookkeeping for the Wave E backfill script
-- (scripts/backfill-dropbox-to-pim.mjs). When fetch/re-encode/upload fails
-- for any Dropbox-hosted image during the migration, the failure lands
-- here for operator triage instead of being silently dropped.
--
-- See docs/tangerine/P11-10-shopify-product-mirror-and-image-unification.md §3.4
-- and D22 — operator triages via the InternalDropboxBackfillTriage panel.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dropbox_backfill_failures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  original_url    text NOT NULL,
  source_entity_type text NOT NULL,
  source_entity_id   text NOT NULL,
  source_json_path   text,
  error_class     text NOT NULL,
  error_detail    text,
  bytes           bigint,
  mime_type       text,
  attempted_at    timestamptz NOT NULL DEFAULT now(),
  resolution      text CHECK (resolution IN ('reuploaded','skipped','lost')),
  resolved_at     timestamptz,
  resolved_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_dbf_unresolved
  ON dropbox_backfill_failures (attempted_at)
  WHERE resolution IS NULL;

ALTER TABLE dropbox_backfill_failures ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE policyname = 'anon_all_dropbox_backfill_failures'
       AND tablename = 'dropbox_backfill_failures'
  ) THEN
    CREATE POLICY anon_all_dropbox_backfill_failures ON dropbox_backfill_failures
      FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMENT ON TABLE dropbox_backfill_failures IS
  'P11-10 D22: quarantine for Dropbox→pim-images backfill failures (404, too_large, bad_mime, sharp_error, network). Operator triages via admin panel.';

NOTIFY pgrst, 'reload schema';
