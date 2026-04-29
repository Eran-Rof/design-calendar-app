-- 20260507000000_ip_planner_bucket_buys.sql
--
-- Bucket-level Buy quantities for the wholesale planning grid's
-- collapse modes. When the planner collapses by "All styles per
-- customer" (or any other rollup) and types a Buy qty into the
-- aggregate row, that quantity is recorded against the bucket
-- dimensions, NOT distributed across the underlying per-SKU rows.
--
-- The bucket_key is a deterministic stringification of the active
-- collapse mode + current grid filters + the row's dimensions, so a
-- buy entered under one view (e.g. "customerAllStyles + sub-cat
-- filter Tech Joggers") only surfaces in that same view. Different
-- views produce different keys.
--
-- Structural columns mirror the dimension parts so we can query /
-- report bucket buys later without parsing the key string.

CREATE TABLE IF NOT EXISTS ip_planner_bucket_buys (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_run_id   uuid NOT NULL REFERENCES ip_planning_runs(id) ON DELETE CASCADE,
  bucket_key        text NOT NULL,
  qty               numeric(14, 3) NOT NULL,
  -- Mirror columns for analytics. May be null when a dimension isn't
  -- part of the active key (e.g. customer_id is null when the bucket
  -- spans all customers).
  collapse_mode     text NOT NULL,
  customer_id       uuid REFERENCES ip_customer_master(id) ON DELETE SET NULL,
  group_name        text,
  sub_category_name text,
  gender            text,
  period_code       text NOT NULL,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_planner_bucket_buys_run_key
  ON ip_planner_bucket_buys (planning_run_id, bucket_key);
CREATE INDEX IF NOT EXISTS idx_ip_planner_bucket_buys_run
  ON ip_planner_bucket_buys (planning_run_id);

-- Anon-permissive RLS — same policy used by every other browser-side-
-- written planning table.
ALTER TABLE ip_planner_bucket_buys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_ip_planner_bucket_buys" ON ip_planner_bucket_buys;
CREATE POLICY "anon_all_ip_planner_bucket_buys" ON ip_planner_bucket_buys
  FOR ALL TO anon
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ip_planner_bucket_buys TO anon;

DROP TRIGGER IF EXISTS trg_ip_planner_bucket_buys_updated ON ip_planner_bucket_buys;
CREATE TRIGGER trg_ip_planner_bucket_buys_updated BEFORE UPDATE ON ip_planner_bucket_buys
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();
