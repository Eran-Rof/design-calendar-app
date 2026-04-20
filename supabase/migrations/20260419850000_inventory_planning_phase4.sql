-- 20260419850000_inventory_planning_phase4.sql
--
-- Demand & Inventory Planning — Phase 4 (Scenarios, Approvals, Exports).
--
-- Fills the gap between Phase 3 (supply reconciliation) and Phase 5
-- (accuracy + AI co-pilot — already shipped). Phase 5 pre-allocated
-- nullable `scenario_id` columns without FKs; this migration creates
-- ip_scenarios and wires those FKs up.
--
-- Design decisions flagged for review:
--   • A scenario is a thin wrapper around its OWN planning_run. The
--     scenario row has `planning_run_id` (its own) + `base_run_reference_id`
--     (what it was cloned from). That way every existing Phase 1/2/3/5
--     table (all of which key on `planning_run_id`) stays intact — we
--     never retro-fit new composite keys.
--   • Assumptions are stored per scenario in ip_scenario_assumptions.
--     Apply is pure and rebuilds the scenario's own forecast/reconciliation
--     output on demand (see scenarioService.ts).
--   • Approval workflow is a state machine: draft → in_review →
--     (approved | rejected) → archived. Approved runs are still
--     readable but the UI marks them read-only.
--   • The audit log is a flat table — any service can insert a row;
--     the UI drawer reads by entity_type + entity_id.
--   • Export jobs are a queue of "I asked the app to emit this CSV/xlsx"
--     so planners can see a history even before an attachment store lands.
--
-- RLS follows the anon-permissive convention established in Phase 0.

-- ── ip_scenarios ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ip_scenarios (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The planning run that IS this scenario. Cloning creates a new
  -- ip_planning_runs row with planning_scope='all' (or whatever the
  -- base was) and points here.
  planning_run_id        uuid NOT NULL REFERENCES ip_planning_runs(id) ON DELETE CASCADE,
  scenario_name          text NOT NULL,
  -- 'what_if' | 'stretch' | 'conservative' | 'promo' | 'supply_delay' |
  -- 'override_review' — free text in the DB, enforced taxonomy in TS.
  scenario_type          text NOT NULL DEFAULT 'what_if',
  -- Mirrors planning_approvals.approval_status but denormalized here so
  -- the grid can sort/filter without a join.
  status                 text NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'in_review', 'approved', 'rejected', 'archived')),
  base_run_reference_id  uuid REFERENCES ip_planning_runs(id) ON DELETE SET NULL,
  note                   text,
  created_by             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_scenarios_run ON ip_scenarios (planning_run_id);
CREATE INDEX IF NOT EXISTS idx_ip_scenarios_base   ON ip_scenarios (base_run_reference_id);
CREATE INDEX IF NOT EXISTS idx_ip_scenarios_status ON ip_scenarios (status);

DROP TRIGGER IF EXISTS trg_ip_scenarios_updated ON ip_scenarios;
CREATE TRIGGER trg_ip_scenarios_updated BEFORE UPDATE ON ip_scenarios
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── ip_scenario_assumptions ────────────────────────────────────────────────
-- Priority-ranked, per-scope (customer/channel/category/sku) + optional
-- period. Numeric value + free-form unit so the compute layer can
-- interpret each assumption_type without a separate "ladder" table.
CREATE TABLE IF NOT EXISTS ip_scenario_assumptions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id            uuid NOT NULL REFERENCES ip_scenarios(id) ON DELETE CASCADE,
  -- 'demand_uplift_percent' | 'lead_time_days_override' |
  -- 'receipt_delay_days' | 'protection_percent' | 'reserve_qty_override' |
  -- 'override_qty' | 'markdown_flag' | 'promo_flag'
  assumption_type        text NOT NULL,
  applies_to_customer_id uuid REFERENCES ip_customer_master(id) ON DELETE CASCADE,
  applies_to_channel_id  uuid REFERENCES ip_channel_master(id)  ON DELETE CASCADE,
  applies_to_category_id uuid REFERENCES ip_category_master(id) ON DELETE CASCADE,
  applies_to_sku_id      uuid REFERENCES ip_item_master(id)     ON DELETE CASCADE,
  period_start           date,     -- optional: only when the assumption targets one period
  assumption_value       numeric(14, 4),
  -- 'percent' | 'days' | 'qty' | 'flag' — helps the UI format/validate.
  assumption_unit        text,
  note                   text,
  created_by             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_scen_assum_scenario ON ip_scenario_assumptions (scenario_id);
CREATE INDEX IF NOT EXISTS idx_ip_scen_assum_type     ON ip_scenario_assumptions (assumption_type);
CREATE INDEX IF NOT EXISTS idx_ip_scen_assum_sku      ON ip_scenario_assumptions (applies_to_sku_id);

DROP TRIGGER IF EXISTS trg_ip_scen_assum_updated ON ip_scenario_assumptions;
CREATE TRIGGER trg_ip_scen_assum_updated BEFORE UPDATE ON ip_scenario_assumptions
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── ip_planning_approvals ──────────────────────────────────────────────────
-- One row per approval event. The most-recent row's status is the
-- current state (ip_scenarios.status / ip_planning_runs-derived).
CREATE TABLE IF NOT EXISTS ip_planning_approvals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_run_id    uuid REFERENCES ip_planning_runs(id) ON DELETE CASCADE,
  scenario_id        uuid REFERENCES ip_scenarios(id)     ON DELETE CASCADE,
  approval_status    text NOT NULL
                       CHECK (approval_status IN ('draft', 'in_review', 'approved', 'rejected', 'archived')),
  approved_by        text,
  approved_at        timestamptz,
  note               text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- At least one target (run OR scenario) must be set.
ALTER TABLE ip_planning_approvals
  DROP CONSTRAINT IF EXISTS ip_planning_approvals_target_ck;
ALTER TABLE ip_planning_approvals
  ADD CONSTRAINT ip_planning_approvals_target_ck
    CHECK (planning_run_id IS NOT NULL OR scenario_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_ip_approvals_run      ON ip_planning_approvals (planning_run_id);
CREATE INDEX IF NOT EXISTS idx_ip_approvals_scenario ON ip_planning_approvals (scenario_id);
CREATE INDEX IF NOT EXISTS idx_ip_approvals_status   ON ip_planning_approvals (approval_status);
CREATE INDEX IF NOT EXISTS idx_ip_approvals_created  ON ip_planning_approvals (created_at DESC);

DROP TRIGGER IF EXISTS trg_ip_approvals_updated ON ip_planning_approvals;
CREATE TRIGGER trg_ip_approvals_updated BEFORE UPDATE ON ip_planning_approvals
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── ip_change_audit_log ────────────────────────────────────────────────────
-- Deliberately schema-light: any service can write a row. The entity
-- pointer (entity_type + entity_id) lets the UI filter "this scenario"
-- or "this override" without a type-specific relation.
CREATE TABLE IF NOT EXISTS ip_change_audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'scenario' | 'assumption' | 'approval' | 'override' | 'buyer_request'
  -- | 'allocation_rule' | 'recommendation' | 'planning_run' | 'other'
  entity_type     text NOT NULL,
  entity_id       uuid,
  -- Field-level granularity: e.g. "final_forecast_qty", "approval_status",
  -- "reserve_qty", etc. Free text so new auditables don't need a migration.
  changed_field   text,
  old_value       text,
  new_value       text,
  changed_by      text,
  change_reason   text,
  -- Optional pointer to the run / scenario for fast filtering.
  planning_run_id uuid REFERENCES ip_planning_runs(id) ON DELETE SET NULL,
  scenario_id     uuid REFERENCES ip_scenarios(id)     ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_audit_entity       ON ip_change_audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_ip_audit_run          ON ip_change_audit_log (planning_run_id);
CREATE INDEX IF NOT EXISTS idx_ip_audit_scenario     ON ip_change_audit_log (scenario_id);
CREATE INDEX IF NOT EXISTS idx_ip_audit_created      ON ip_change_audit_log (created_at DESC);

-- ── ip_export_jobs ─────────────────────────────────────────────────────────
-- Queue of export actions a planner kicked off. MVP just records them;
-- the actual file generation happens in the browser. Later phases can
-- move the work to a worker + attach the resulting file URL.
CREATE TABLE IF NOT EXISTS ip_export_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_run_id  uuid REFERENCES ip_planning_runs(id) ON DELETE CASCADE,
  scenario_id      uuid REFERENCES ip_scenarios(id)     ON DELETE CASCADE,
  -- 'wholesale_buy_plan' | 'ecom_buy_plan' | 'shortage_report' |
  -- 'excess_report' | 'recommendations_report' | 'scenario_comparison'
  export_type      text NOT NULL,
  -- 'queued' | 'completed' | 'failed'. MVP writes 'completed' immediately
  -- since the work happens client-side; left open so a Phase 5+ mover to
  -- server-side doesn't need another migration.
  export_status    text NOT NULL DEFAULT 'completed'
                     CHECK (export_status IN ('queued', 'completed', 'failed')),
  file_name        text,
  row_count        integer,
  note             text,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_export_run      ON ip_export_jobs (planning_run_id);
CREATE INDEX IF NOT EXISTS idx_ip_export_scenario ON ip_export_jobs (scenario_id);
CREATE INDEX IF NOT EXISTS idx_ip_export_type     ON ip_export_jobs (export_type);

-- ── Wire Phase 5 scenario_id FKs now that ip_scenarios exists ─────────────
-- The Phase 5 migration left these as nullable uuids with no constraint;
-- add the constraints here. DROP IF EXISTS first so this migration is
-- idempotent even if a future patch re-runs it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ip_forecast_accuracy_scenario_fk') THEN
    ALTER TABLE ip_forecast_accuracy
      ADD CONSTRAINT ip_forecast_accuracy_scenario_fk
        FOREIGN KEY (scenario_id) REFERENCES ip_scenarios(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ip_override_effectiveness_scenario_fk') THEN
    ALTER TABLE ip_override_effectiveness
      ADD CONSTRAINT ip_override_effectiveness_scenario_fk
        FOREIGN KEY (scenario_id) REFERENCES ip_scenarios(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ip_planning_anomalies_scenario_fk') THEN
    ALTER TABLE ip_planning_anomalies
      ADD CONSTRAINT ip_planning_anomalies_scenario_fk
        FOREIGN KEY (scenario_id) REFERENCES ip_scenarios(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ip_ai_suggestions_scenario_fk') THEN
    ALTER TABLE ip_ai_suggestions
      ADD CONSTRAINT ip_ai_suggestions_scenario_fk
        FOREIGN KEY (scenario_id) REFERENCES ip_scenarios(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE ip_scenarios              ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_scenario_assumptions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_planning_approvals     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_change_audit_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_export_jobs            ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'ip_scenarios',
    'ip_scenario_assumptions',
    'ip_planning_approvals',
    'ip_change_audit_log',
    'ip_export_jobs'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "anon_all_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "anon_all_%1$s" ON %1$I FOR ALL TO anon USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
