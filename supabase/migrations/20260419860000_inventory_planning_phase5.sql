-- 20260419860000_inventory_planning_phase5.sql
--
-- Demand & Inventory Planning — Phase 5 (Forecast Accuracy + AI Augmentation).
--
-- Builds on Phases 0–3. (Phase 4 — scenarios/approvals/exports — is not
-- yet in place; `scenario_id` columns below are nullable uuid without
-- a FK constraint so this migration is safe to apply ahead of Phase 4.
-- When Phase 4 introduces an `ip_scenarios` table, add:
--     ALTER TABLE ip_forecast_accuracy
--       ADD CONSTRAINT ip_forecast_accuracy_scenario_fk
--       FOREIGN KEY (scenario_id) REFERENCES ip_scenarios(id) ON DELETE SET NULL;
--   …and the equivalent for ip_override_effectiveness / ip_planning_anomalies /
--   ip_ai_suggestions.)
--
-- Scope:
--   • ip_forecast_actuals        — normalized actual demand rolled up
--     to a grain (sku × period × optional customer/channel/category)
--   • ip_forecast_accuracy       — per-grain error metrics comparing
--     system vs final vs actual
--   • ip_override_effectiveness  — one row per (run, grain) where an
--     override was applied — did it help vs system alone?
--   • ip_planning_anomalies      — rule-based anomaly log
--   • ip_ai_suggestions          — explainable co-pilot suggestions
--     with rationale + accept/ignore audit
--
-- Design decisions flagged for review:
--   • Actuals live at the same grain the forecasts were produced at.
--     For wholesale: (sku, period_start='YYYY-MM-01', customer). For
--     ecom: (sku, period_start=Monday of ISO week, channel).
--     `forecast_type` on the accuracy/effectiveness/suggestion rows
--     distinguishes lanes.
--   • Numeric error columns are persisted instead of recomputed on
--     read. Cheap to write, fast to filter/sort, and the formula is
--     small enough to audit (see accuracyMetrics.ts).
--   • Anon-permissive RLS matches Phase 0–3 convention — planning data
--     is internal-only.

-- ── ip_forecast_actuals ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ip_forecast_actuals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'wholesale' | 'ecom' — matches the forecast lane this actual feeds.
  forecast_type      text NOT NULL CHECK (forecast_type IN ('wholesale', 'ecom')),
  sku_id             uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  customer_id        uuid REFERENCES ip_customer_master(id) ON DELETE SET NULL,
  channel_id         uuid REFERENCES ip_channel_master(id)  ON DELETE SET NULL,
  category_id        uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  period_code        text NOT NULL,
  actual_qty         numeric(14, 3) NOT NULL DEFAULT 0,
  actual_net_sales   numeric(14, 4),
  -- Idempotency: one actual per grain per lane. On re-compute we
  -- overwrite via ON CONFLICT.
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_forecast_actuals_grain
  ON ip_forecast_actuals
    (forecast_type, sku_id, period_start,
     COALESCE(customer_id, '00000000-0000-0000-0000-000000000000'::uuid),
     COALESCE(channel_id,  '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX IF NOT EXISTS idx_ip_fa_sku      ON ip_forecast_actuals (sku_id);
CREATE INDEX IF NOT EXISTS idx_ip_fa_period   ON ip_forecast_actuals (period_start);
CREATE INDEX IF NOT EXISTS idx_ip_fa_type     ON ip_forecast_actuals (forecast_type);

-- ── ip_forecast_accuracy ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ip_forecast_accuracy (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_run_id        uuid REFERENCES ip_planning_runs(id) ON DELETE CASCADE,
  scenario_id            uuid,                                 -- see header comment
  forecast_type          text NOT NULL CHECK (forecast_type IN ('wholesale', 'ecom')),
  sku_id                 uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  customer_id            uuid REFERENCES ip_customer_master(id) ON DELETE SET NULL,
  channel_id             uuid REFERENCES ip_channel_master(id)  ON DELETE SET NULL,
  category_id            uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  period_start           date NOT NULL,
  period_end             date NOT NULL,
  period_code            text NOT NULL,
  system_forecast_qty    numeric(14, 3) NOT NULL DEFAULT 0,
  final_forecast_qty     numeric(14, 3) NOT NULL DEFAULT 0,
  actual_qty             numeric(14, 3) NOT NULL DEFAULT 0,
  -- Unsigned absolute errors.
  abs_error_system       numeric(14, 3) NOT NULL DEFAULT 0,
  abs_error_final        numeric(14, 3) NOT NULL DEFAULT 0,
  -- Signed percent errors (forecast − actual) / actual. NULL when actual=0.
  pct_error_system       numeric(8, 4),
  pct_error_final        numeric(8, 4),
  -- Signed bias (forecast − actual). Positive = overforecast.
  bias_system            numeric(14, 3) NOT NULL DEFAULT 0,
  bias_final             numeric(14, 3) NOT NULL DEFAULT 0,
  -- Weighted error: abs_error × actual. Used for WAPE-style rollups.
  weighted_error_system  numeric(14, 3) NOT NULL DEFAULT 0,
  weighted_error_final   numeric(14, 3) NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_accuracy_grain
  ON ip_forecast_accuracy
    (forecast_type, sku_id, period_start,
     COALESCE(customer_id, '00000000-0000-0000-0000-000000000000'::uuid),
     COALESCE(channel_id,  '00000000-0000-0000-0000-000000000000'::uuid),
     COALESCE(planning_run_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX IF NOT EXISTS idx_ip_acc_run    ON ip_forecast_accuracy (planning_run_id);
CREATE INDEX IF NOT EXISTS idx_ip_acc_sku    ON ip_forecast_accuracy (sku_id);
CREATE INDEX IF NOT EXISTS idx_ip_acc_period ON ip_forecast_accuracy (period_start);
CREATE INDEX IF NOT EXISTS idx_ip_acc_type   ON ip_forecast_accuracy (forecast_type);

-- ── ip_override_effectiveness ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ip_override_effectiveness (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_run_id       uuid REFERENCES ip_planning_runs(id) ON DELETE CASCADE,
  scenario_id           uuid,
  forecast_type         text NOT NULL CHECK (forecast_type IN ('wholesale', 'ecom')),
  sku_id                uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  customer_id           uuid REFERENCES ip_customer_master(id) ON DELETE SET NULL,
  channel_id            uuid REFERENCES ip_channel_master(id)  ON DELETE SET NULL,
  category_id           uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  period_code           text NOT NULL,
  -- From the override trail (Phase 1/2). Canonical values:
  --   wholesale: buyer_request | planner_estimate | management_input |
  --              launch_expectation | customer_expansion | supply_adjustment
  --   ecom:      promotion | campaign | content_push | influencer |
  --              launch_expectation | markdown_strategy | planner_estimate
  override_reason       text,
  system_forecast_qty   numeric(14, 3) NOT NULL DEFAULT 0,
  final_forecast_qty    numeric(14, 3) NOT NULL DEFAULT 0,
  actual_qty            numeric(14, 3) NOT NULL DEFAULT 0,
  -- true when |final − actual| < |system − actual| by more than a
  -- tie-break epsilon; false when the override hurt; null when there
  -- was no override or no actual yet.
  override_helped_flag  boolean,
  -- error_delta = abs_error_system − abs_error_final.
  -- Positive = override helped; negative = override hurt.
  error_delta           numeric(14, 3),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_overeff_run       ON ip_override_effectiveness (planning_run_id);
CREATE INDEX IF NOT EXISTS idx_ip_overeff_sku       ON ip_override_effectiveness (sku_id);
CREATE INDEX IF NOT EXISTS idx_ip_overeff_period    ON ip_override_effectiveness (period_start);
CREATE INDEX IF NOT EXISTS idx_ip_overeff_reason    ON ip_override_effectiveness (override_reason);
CREATE INDEX IF NOT EXISTS idx_ip_overeff_helped    ON ip_override_effectiveness (override_helped_flag);

-- ── ip_planning_anomalies ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ip_planning_anomalies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_run_id     uuid REFERENCES ip_planning_runs(id) ON DELETE CASCADE,
  scenario_id         uuid,
  forecast_type       text CHECK (forecast_type IN ('wholesale', 'ecom')),
  sku_id              uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  customer_id         uuid REFERENCES ip_customer_master(id) ON DELETE SET NULL,
  channel_id          uuid REFERENCES ip_channel_master(id)  ON DELETE SET NULL,
  category_id         uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  period_code         text NOT NULL,
  -- 'demand_spike' | 'demand_collapse' | 'repeated_forecast_miss' |
  -- 'chronic_overbuy' | 'chronic_stockout' | 'return_rate_spike' |
  -- 'protected_repeatedly_uncovered' | 'buyer_request_conversion_miss' |
  -- 'forecast_volatility'
  anomaly_type        text NOT NULL
                        CHECK (anomaly_type IN (
                          'demand_spike', 'demand_collapse',
                          'repeated_forecast_miss', 'chronic_overbuy',
                          'chronic_stockout', 'return_rate_spike',
                          'protected_repeatedly_uncovered',
                          'buyer_request_conversion_miss',
                          'forecast_volatility'
                        )),
  severity            text NOT NULL DEFAULT 'medium'
                        CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  confidence_score    numeric(4, 3), -- 0.000 – 1.000 (nullable for pure rule-based)
  message             text NOT NULL,
  details_json        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_anom_run      ON ip_planning_anomalies (planning_run_id);
CREATE INDEX IF NOT EXISTS idx_ip_anom_sku      ON ip_planning_anomalies (sku_id);
CREATE INDEX IF NOT EXISTS idx_ip_anom_type     ON ip_planning_anomalies (anomaly_type);
CREATE INDEX IF NOT EXISTS idx_ip_anom_severity ON ip_planning_anomalies (severity);

-- ── ip_ai_suggestions ──────────────────────────────────────────────────────
-- Explainable co-pilot suggestions. Every row carries a rationale and
-- an input_summary_json documenting exactly what the heuristic saw.
CREATE TABLE IF NOT EXISTS ip_ai_suggestions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_run_id       uuid REFERENCES ip_planning_runs(id) ON DELETE CASCADE,
  scenario_id           uuid,
  forecast_type         text CHECK (forecast_type IN ('wholesale', 'ecom')),
  sku_id                uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  customer_id           uuid REFERENCES ip_customer_master(id) ON DELETE SET NULL,
  channel_id            uuid REFERENCES ip_channel_master(id)  ON DELETE SET NULL,
  category_id           uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  period_code           text NOT NULL,
  -- 'increase_forecast' | 'decrease_forecast' | 'increase_confidence' |
  -- 'lower_confidence' | 'protect_more_inventory' | 'reduce_buy_recommendation' |
  -- 'review_buyer_request' | 'inspect_return_rate'
  suggestion_type       text NOT NULL
                          CHECK (suggestion_type IN (
                            'increase_forecast', 'decrease_forecast',
                            'increase_confidence', 'lower_confidence',
                            'protect_more_inventory', 'reduce_buy_recommendation',
                            'review_buyer_request', 'inspect_return_rate'
                          )),
  suggested_qty_delta   numeric(14, 3),
  suggested_final_qty   numeric(14, 3),
  confidence_score      numeric(4, 3), -- 0.000 – 1.000
  rationale             text NOT NULL,
  input_summary_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  accepted_flag         boolean,      -- null = untouched; true = accepted; false = ignored/rejected
  accepted_by           text,
  accepted_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_ais_run      ON ip_ai_suggestions (planning_run_id);
CREATE INDEX IF NOT EXISTS idx_ip_ais_sku      ON ip_ai_suggestions (sku_id);
CREATE INDEX IF NOT EXISTS idx_ip_ais_period   ON ip_ai_suggestions (period_start);
CREATE INDEX IF NOT EXISTS idx_ip_ais_type     ON ip_ai_suggestions (suggestion_type);
CREATE INDEX IF NOT EXISTS idx_ip_ais_accepted ON ip_ai_suggestions (accepted_flag);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE ip_forecast_actuals        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_forecast_accuracy       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_override_effectiveness  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_planning_anomalies      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_ai_suggestions          ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'ip_forecast_actuals',
    'ip_forecast_accuracy',
    'ip_override_effectiveness',
    'ip_planning_anomalies',
    'ip_ai_suggestions'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "anon_all_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "anon_all_%1$s" ON %1$I FOR ALL TO anon USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
