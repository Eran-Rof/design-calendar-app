-- 20260518000000_ip_phase5_scenario_id_indexes.sql
--
-- Adds the missing scenario_id indexes on the four Phase 5 tables.
-- The FK constraints (ON DELETE SET NULL) were wired in
-- 20260419861000_ip_scenario_fks.sql, but no index ever covered the
-- column — so DELETE on ip_scenarios triggered a seq scan on each of
-- these tables for the SET NULL update, and timed out (57014) once
-- the tables grew.
--
-- Partial WHERE clause keeps the index small; only rows that ever
-- referenced a scenario need to be locatable by scenario_id.

CREATE INDEX IF NOT EXISTS idx_ip_acc_scenario
  ON ip_forecast_accuracy (scenario_id)
  WHERE scenario_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ip_overeff_scenario
  ON ip_override_effectiveness (scenario_id)
  WHERE scenario_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ip_anom_scenario
  ON ip_planning_anomalies (scenario_id)
  WHERE scenario_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ip_ais_scenario
  ON ip_ai_suggestions (scenario_id)
  WHERE scenario_id IS NOT NULL;
