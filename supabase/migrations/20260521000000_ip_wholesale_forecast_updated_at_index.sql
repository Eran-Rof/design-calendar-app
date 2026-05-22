-- Index on ip_wholesale_forecast.updated_at to fix Disk IO budget pressure.
--
-- Symptom: Supabase IO-budget warning on 2026-05-21. pg_stat_statements
-- showed `SELECT updated_at FROM ip_wholesale_forecast ORDER BY updated_at
-- DESC LIMIT N` at 1372 ms mean across 32 calls (43.9 sec total — the
-- second-largest single-query time consumer on the project, after the
-- ip_item_master pagination path).
--
-- The query is the planning panel's "freshest forecast" probe, run on
-- every WholesalePlanningWorkbench mount. Without an index on updated_at,
-- the planner full-scans the 44 MB ip_wholesale_forecast table and sorts
-- in memory just to return the top N rows. With the index, the planner
-- streams from the B-tree in DESC order and stops at the LIMIT — flat
-- time regardless of table growth.
--
-- The existing indexes on this table all lead with planning_run_id, which
-- doesn't help a SELECT with no WHERE filter.
--
-- This migration is idempotent (IF NOT EXISTS). The index was already
-- applied live on 2026-05-21 via the Supabase Management API using
-- CONCURRENTLY (safe under writes). Including the migration file keeps
-- staging/local environments and future restores in sync.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_ip_wholesale_forecast_updated_at
  ON ip_wholesale_forecast (updated_at DESC);

COMMIT;

-- Refresh planner stats so the new index is picked up immediately.
ANALYZE ip_wholesale_forecast;
