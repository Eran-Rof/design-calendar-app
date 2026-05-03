-- 20260511000000_ip_wholesale_forecast_tbd_partial_grain.sql
--
-- Allow multiple planner-added TBD rows per (style, color, customer,
-- period) grain. The previous unique index on
--   (planning_run_id, style_code, color, customer_id, period_start)
-- meant that aggregate-edit routing (which auto-creates a TBD row at
-- e.g. style=TBD/color=TBD/customer=(Supply Only)/period=Apr 2026)
-- collided with a planner pressing "+ Add row" on the same combo —
-- the upsert merged into the auto row instead of inserting a new
-- line, so the planner saw "saved" but no visible new row.
--
-- Resolution: keep the uniqueness contract for AUTO-synthesized
-- rows (is_user_added = false) so the build pipeline can still
-- upsert idempotently, but lift it for planner-added rows so the
-- planner can press "+ Add row" any number of times under the same
-- grain. A partial unique index does both: WHERE is_user_added =
-- false, the grain is unique; WHERE is_user_added = true, no
-- constraint, multiple rows allowed.

DROP INDEX IF EXISTS uq_ip_wf_tbd_grain;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_wf_tbd_grain
  ON ip_wholesale_forecast_tbd (planning_run_id, style_code, color, customer_id, period_start)
  WHERE is_user_added = false;
