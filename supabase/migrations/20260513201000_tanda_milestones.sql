-- 20260513201000_tanda_milestones.sql
--
-- Captures the `tanda_milestones` table used by the PO WIP app (TandA).
-- Same situation as tasks/collections: exists in prod via out-of-band SQL
-- editor creation, but never captured as a migration. IF NOT EXISTS so this
-- is a no-op in prod and only creates rows in environments missing it.
--
-- One row per milestone. `id` is a client-generated string (ms_<rand>_<ts>
-- per src/utils/tandaTypes.ts milestoneUid()). `data` is the full Milestone
-- object (po_number, phase, category, sort_order, expected_date, status,
-- variant_statuses, etc.). Index on po_number for fast per-PO grid loads.

CREATE TABLE IF NOT EXISTS tanda_milestones (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tanda_milestones_po_number
  ON tanda_milestones ((data->>'po_number'));
CREATE INDEX IF NOT EXISTS idx_tanda_milestones_status
  ON tanda_milestones ((data->>'status'));
CREATE INDEX IF NOT EXISTS idx_tanda_milestones_expected
  ON tanda_milestones ((data->>'expected_date'));
