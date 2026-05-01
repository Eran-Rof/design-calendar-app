-- prune_orphan_forecast_rows.sql
--
-- Deletes wholesale forecast + recommendation rows for (customer, sku)
-- pairs that have no demand signal AND no inventory presence — the
-- same "dead pair" definition runForecastPass uses to skip pairs at
-- build time.
--
-- Why we need this script: the in-build prune in runForecastPass only
-- runs on UNFILTERED builds. Planners running many filtered builds
-- accumulate orphan rows from prior unfiltered builds whose pairs have
-- since gone dead. This script catches up.
--
-- Definition of "dead pair" (must satisfy ALL of the below):
--   1. No wholesale sales row for (customer, sku) in the last 12 months
--   2. No on-hand qty > 0 on the latest inventory snapshot for the sku
--   3. No open PO with qty_open > 0 for the sku
--   4. No open SO with qty_open > 0 for the (customer, sku)
--
-- A dry-run query is included at the bottom — uncomment instead of the
-- DELETEs to inspect the candidate set without committing.
--
-- Scope: by default acts on all planning_runs. To restrict to a single
-- run, replace the `TRUE` predicate in the WHERE clauses below with
-- `f.planning_run_id = '<uuid>'`.

BEGIN;

CREATE TEMP TABLE _dead_pairs AS
WITH
  recent_sales AS (
    SELECT DISTINCT customer_id, sku_id
      FROM ip_sales_history_wholesale
     WHERE txn_date >= (now()::date - INTERVAL '12 months')
       AND customer_id IS NOT NULL
       AND sku_id IS NOT NULL
  ),
  latest_snapshot AS (
    SELECT MAX(snapshot_date) AS d FROM ip_inventory_snapshot
  ),
  on_hand_skus AS (
    SELECT DISTINCT s.sku_id
      FROM ip_inventory_snapshot s, latest_snapshot l
     WHERE s.snapshot_date = l.d
       AND COALESCE(s.qty_on_hand, 0) > 0
  ),
  on_so_skus AS (
    SELECT DISTINCT s.sku_id
      FROM ip_inventory_snapshot s, latest_snapshot l
     WHERE s.snapshot_date = l.d
       AND COALESCE(s.qty_committed, 0) > 0
  ),
  open_po_skus AS (
    SELECT DISTINCT sku_id
      FROM ip_open_purchase_orders
     WHERE COALESCE(qty_open, 0) > 0
  ),
  open_so_pairs AS (
    SELECT DISTINCT customer_id, sku_id
      FROM ip_open_sales_orders
     WHERE COALESCE(qty_open, 0) > 0
       AND customer_id IS NOT NULL
  )
SELECT DISTINCT f.planning_run_id, f.customer_id, f.sku_id
  FROM ip_wholesale_forecast f
 WHERE TRUE
   AND NOT EXISTS (SELECT 1 FROM recent_sales rs   WHERE rs.customer_id = f.customer_id AND rs.sku_id = f.sku_id)
   AND NOT EXISTS (SELECT 1 FROM on_hand_skus oh   WHERE oh.sku_id = f.sku_id)
   AND NOT EXISTS (SELECT 1 FROM on_so_skus os     WHERE os.sku_id = f.sku_id)
   AND NOT EXISTS (SELECT 1 FROM open_po_skus po   WHERE po.sku_id = f.sku_id)
   AND NOT EXISTS (SELECT 1 FROM open_so_pairs sop WHERE sop.customer_id = f.customer_id AND sop.sku_id = f.sku_id);

CREATE INDEX ON _dead_pairs (planning_run_id, customer_id, sku_id);

-- Dry-run: count what we would prune. Comment out the DELETEs below
-- and run just this SELECT first to sanity-check before committing.
SELECT 'dead_pairs_count' AS metric, COUNT(*) AS value FROM _dead_pairs
UNION ALL
SELECT 'forecast_rows_to_delete',
       COUNT(*)
  FROM ip_wholesale_forecast f
  JOIN _dead_pairs d
    ON d.planning_run_id = f.planning_run_id
   AND d.customer_id = f.customer_id
   AND d.sku_id = f.sku_id
UNION ALL
SELECT 'rec_rows_to_delete',
       COUNT(*)
  FROM ip_wholesale_recommendations r
  JOIN _dead_pairs d
    ON d.planning_run_id = r.planning_run_id
   AND d.customer_id = r.customer_id
   AND d.sku_id = r.sku_id;

-- ── DELETE pass. Comment out the block below for a pure dry run. ────────

DELETE FROM ip_wholesale_recommendations r
 USING _dead_pairs d
 WHERE d.planning_run_id = r.planning_run_id
   AND d.customer_id     = r.customer_id
   AND d.sku_id          = r.sku_id;

DELETE FROM ip_wholesale_forecast f
 USING _dead_pairs d
 WHERE d.planning_run_id = f.planning_run_id
   AND d.customer_id     = f.customer_id
   AND d.sku_id          = f.sku_id;

COMMIT;

-- After commit, ANALYZE so the planner picks up the new row counts.
ANALYZE ip_wholesale_forecast;
ANALYZE ip_wholesale_recommendations;
