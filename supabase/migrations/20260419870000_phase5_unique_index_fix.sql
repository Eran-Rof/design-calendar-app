-- 20260419870000_phase5_unique_index_fix.sql
--
-- Fix for a Phase 5 oversight: the Phase 5 migration created unique
-- indexes on `ip_forecast_actuals` and `ip_forecast_accuracy` using
-- COALESCE expressions (to treat NULL customer_id / channel_id as
-- equivalent for the purpose of dedupe). That works for uniqueness,
-- but PostgREST's `on_conflict=...` parameter only resolves against
-- unique constraints built on PLAIN columns.
--
-- The accuracy pass upsert:
--   POST /ip_forecast_actuals?on_conflict=forecast_type,sku_id,period_start,customer_id,channel_id
-- returns 42P10 "there is no unique or exclusion constraint matching
-- the ON CONFLICT specification" because the matching index is the
-- COALESCE one.
--
-- Fix: replace the expression-based unique indexes with plain-column
-- ones using `NULLS NOT DISTINCT` (PG 15+). That preserves the
-- "two rows with NULL customer_id both collide" dedupe semantics the
-- upsert relies on, AND lets PostgREST target the index via
-- on_conflict.

-- ── ip_forecast_actuals ────────────────────────────────────────────────────
DROP INDEX IF EXISTS uq_ip_forecast_actuals_grain;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_forecast_actuals_grain
  ON ip_forecast_actuals
  (forecast_type, sku_id, period_start, customer_id, channel_id)
  NULLS NOT DISTINCT;

-- ── ip_forecast_accuracy ──────────────────────────────────────────────────
DROP INDEX IF EXISTS uq_ip_accuracy_grain;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_accuracy_grain
  ON ip_forecast_accuracy
  (forecast_type, sku_id, period_start, customer_id, channel_id, planning_run_id)
  NULLS NOT DISTINCT;
