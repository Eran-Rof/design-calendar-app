-- 20260419861000_ip_scenario_fks.sql
--
-- Adds the scenario_id FK constraints on the four Phase 5 tables that
-- created scenario_id as a bare uuid column. Originally the constraints
-- were in migration 20260419850000 (Phase 4), but that migration runs
-- before the tables are created on a fresh DB, so the DO block there
-- no-ops on first apply. This migration wires them in the correct
-- order. Idempotent — safe to re-run.

DO $$
BEGIN
  IF to_regclass('public.ip_scenarios') IS NULL THEN
    RETURN;
  END IF;
  IF to_regclass('public.ip_forecast_accuracy') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ip_forecast_accuracy_scenario_fk') THEN
    ALTER TABLE ip_forecast_accuracy
      ADD CONSTRAINT ip_forecast_accuracy_scenario_fk
        FOREIGN KEY (scenario_id) REFERENCES ip_scenarios(id) ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.ip_override_effectiveness') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ip_override_effectiveness_scenario_fk') THEN
    ALTER TABLE ip_override_effectiveness
      ADD CONSTRAINT ip_override_effectiveness_scenario_fk
        FOREIGN KEY (scenario_id) REFERENCES ip_scenarios(id) ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.ip_planning_anomalies') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ip_planning_anomalies_scenario_fk') THEN
    ALTER TABLE ip_planning_anomalies
      ADD CONSTRAINT ip_planning_anomalies_scenario_fk
        FOREIGN KEY (scenario_id) REFERENCES ip_scenarios(id) ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.ip_ai_suggestions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ip_ai_suggestions_scenario_fk') THEN
    ALTER TABLE ip_ai_suggestions
      ADD CONSTRAINT ip_ai_suggestions_scenario_fk
        FOREIGN KEY (scenario_id) REFERENCES ip_scenarios(id) ON DELETE SET NULL;
  END IF;
END $$;
