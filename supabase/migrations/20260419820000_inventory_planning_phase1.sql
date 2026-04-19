-- 20260419820000_inventory_planning_phase1.sql
--
-- Demand & Inventory Planning — Phase 1 (Wholesale MVP).
--
-- Builds on the Phase 0 foundation (ip_item_master, ip_customer_master,
-- ip_category_master, ip_sales_history_wholesale, ip_inventory_snapshot,
-- ip_open_purchase_orders, ip_receipts_history).
--
-- Adds:
--   • ip_planning_runs           — a named snapshot of a forecast build
--   • ip_wholesale_forecast      — row per (run, customer, category, sku, period)
--   • ip_future_demand_requests  — buyer/planner requests for future demand
--   • ip_planner_overrides       — audit trail for override edits
--   • ip_wholesale_recommendations — derived from supply vs final forecast
--
-- Design choices flagged here so reviewers can push back:
--   • Period grain is monthly for MVP. `period_start` is the first of the
--     month; `period_end` is the last calendar day. A weekly grain is
--     easy to introduce later — the compute layer takes a period key, not
--     a hardcoded month.
--   • The forecast table carries the three quantities (system / buyer /
--     override) as separate columns. Final is persisted too, computed as
--     system + buyer + override and floored at zero. Persisting final
--     keeps the grid fast; the three sources stay auditable.
--   • Overrides go in two places on purpose: the forecast row gets the
--     current override value (easy to read at grid scan), and
--     ip_planner_overrides keeps every edit as a new row (audit log).
--     A trigger on the forecast row updated_at/override_qty is NOT
--     installed — the service layer is the single writer and manages both.
--   • RLS: anon-permissive, same convention as Phase 0. Planning screens
--     are internal-only.

-- ── ip_planning_runs ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ip_planning_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  -- 'wholesale' | 'ecom' | 'all' — Phase 1 only writes 'wholesale'.
  planning_scope        text NOT NULL DEFAULT 'wholesale'
                          CHECK (planning_scope IN ('wholesale', 'ecom', 'all')),
  -- 'draft' | 'active' | 'archived'. 'active' is the one the grid reads
  -- by default; we don't enforce a single-active constraint so planners
  -- can work two runs in parallel.
  status                text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'active', 'archived')),
  -- Snapshot date used as the "as of" anchor for history windows and
  -- supply context. Defaults to the day the run was created.
  source_snapshot_date  date NOT NULL DEFAULT CURRENT_DATE,
  -- Inclusive horizon the run covers. Nullable so quick "open-ended"
  -- draft runs are possible.
  horizon_start         date,
  horizon_end           date,
  note                  text,
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_planning_runs_status ON ip_planning_runs (status);
CREATE INDEX IF NOT EXISTS idx_ip_planning_runs_scope  ON ip_planning_runs (planning_scope);

DROP TRIGGER IF EXISTS trg_ip_planning_runs_updated ON ip_planning_runs;
CREATE TRIGGER trg_ip_planning_runs_updated BEFORE UPDATE ON ip_planning_runs
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── ip_wholesale_forecast ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ip_wholesale_forecast (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_run_id       uuid NOT NULL REFERENCES ip_planning_runs(id) ON DELETE CASCADE,
  customer_id           uuid NOT NULL REFERENCES ip_customer_master(id) ON DELETE RESTRICT,
  category_id           uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  sku_id                uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  -- Human-readable bucket key: 'YYYY-MM' for monthly. Denormalized from
  -- period_start so filters don't need a to_char every render.
  period_code           text NOT NULL,
  system_forecast_qty   numeric(14, 3) NOT NULL DEFAULT 0,
  buyer_request_qty     numeric(14, 3) NOT NULL DEFAULT 0,
  override_qty          numeric(14, 3) NOT NULL DEFAULT 0,
  final_forecast_qty    numeric(14, 3) NOT NULL DEFAULT 0,
  -- 'committed' | 'probable' | 'possible' | 'estimate'
  confidence_level      text NOT NULL DEFAULT 'estimate'
                          CHECK (confidence_level IN ('committed', 'probable', 'possible', 'estimate')),
  -- 'trailing_avg_sku' | 'weighted_recent_sku' | 'cadence_sku' |
  -- 'category_fallback' | 'customer_category_fallback' | 'zero_floor'.
  -- Surfaced in the drawer so planners can see why the number is what it is.
  forecast_method       text NOT NULL DEFAULT 'zero_floor',
  -- History window the baseline consumed (months), for drawer display.
  history_months_used   integer,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- A given (run, customer, sku, period) must be unique — a forecast has
-- one number per grain. category_id is derived from the sku and kept on
-- the row for fast filter but not part of the uniqueness contract.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_wholesale_forecast_grain
  ON ip_wholesale_forecast (planning_run_id, customer_id, sku_id, period_start);

CREATE INDEX IF NOT EXISTS idx_ip_wf_run            ON ip_wholesale_forecast (planning_run_id);
CREATE INDEX IF NOT EXISTS idx_ip_wf_customer       ON ip_wholesale_forecast (customer_id);
CREATE INDEX IF NOT EXISTS idx_ip_wf_category       ON ip_wholesale_forecast (category_id);
CREATE INDEX IF NOT EXISTS idx_ip_wf_sku            ON ip_wholesale_forecast (sku_id);
CREATE INDEX IF NOT EXISTS idx_ip_wf_period         ON ip_wholesale_forecast (period_code);

DROP TRIGGER IF EXISTS trg_ip_wholesale_forecast_updated ON ip_wholesale_forecast;
CREATE TRIGGER trg_ip_wholesale_forecast_updated BEFORE UPDATE ON ip_wholesale_forecast
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── ip_future_demand_requests ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ip_future_demand_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           uuid NOT NULL REFERENCES ip_customer_master(id) ON DELETE RESTRICT,
  category_id           uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  sku_id                uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  target_period_start   date NOT NULL,
  target_period_end     date NOT NULL,
  requested_qty         numeric(14, 3) NOT NULL,
  -- 'committed' | 'probable' | 'possible' | 'estimate'
  confidence_level      text NOT NULL DEFAULT 'estimate'
                          CHECK (confidence_level IN ('committed', 'probable', 'possible', 'estimate')),
  -- 'buyer_request' | 'expected_reorder' | 'program_fill_in' |
  -- 'seasonal_estimate' | 'planner_estimate' | 'customer_expansion'
  request_type          text NOT NULL DEFAULT 'planner_estimate'
                          CHECK (request_type IN (
                            'buyer_request', 'expected_reorder', 'program_fill_in',
                            'seasonal_estimate', 'planner_estimate', 'customer_expansion'
                          )),
  -- 'open' | 'applied' | 'archived'. Only 'open' requests feed future runs.
  request_status        text NOT NULL DEFAULT 'open'
                          CHECK (request_status IN ('open', 'applied', 'archived')),
  note                  text,
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_fdr_customer  ON ip_future_demand_requests (customer_id);
CREATE INDEX IF NOT EXISTS idx_ip_fdr_sku       ON ip_future_demand_requests (sku_id);
CREATE INDEX IF NOT EXISTS idx_ip_fdr_status    ON ip_future_demand_requests (request_status);
CREATE INDEX IF NOT EXISTS idx_ip_fdr_period    ON ip_future_demand_requests (target_period_start, target_period_end);

DROP TRIGGER IF EXISTS trg_ip_fdr_updated ON ip_future_demand_requests;
CREATE TRIGGER trg_ip_fdr_updated BEFORE UPDATE ON ip_future_demand_requests
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── ip_planner_overrides ─────────────────────────────────────────────────────
-- Append-only audit log. The most recent row per grain reflects the
-- planner's current intent; older rows are kept for review.
CREATE TABLE IF NOT EXISTS ip_planner_overrides (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_run_id   uuid NOT NULL REFERENCES ip_planning_runs(id) ON DELETE CASCADE,
  customer_id       uuid NOT NULL REFERENCES ip_customer_master(id) ON DELETE RESTRICT,
  category_id       uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  sku_id            uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  override_qty      numeric(14, 3) NOT NULL,
  -- 'buyer_request' | 'planner_estimate' | 'management_input' |
  -- 'launch_expectation' | 'customer_expansion' | 'supply_adjustment'
  reason_code       text NOT NULL
                      CHECK (reason_code IN (
                        'buyer_request', 'planner_estimate', 'management_input',
                        'launch_expectation', 'customer_expansion', 'supply_adjustment'
                      )),
  note              text,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_po_run         ON ip_planner_overrides (planning_run_id);
CREATE INDEX IF NOT EXISTS idx_ip_po_grain       ON ip_planner_overrides (planning_run_id, customer_id, sku_id, period_start);
CREATE INDEX IF NOT EXISTS idx_ip_po_created_at  ON ip_planner_overrides (created_at DESC);

DROP TRIGGER IF EXISTS trg_ip_planner_overrides_updated ON ip_planner_overrides;
CREATE TRIGGER trg_ip_planner_overrides_updated BEFORE UPDATE ON ip_planner_overrides
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── ip_wholesale_recommendations ─────────────────────────────────────────────
-- Derived view of "so what". One row per (run, customer, sku, period).
-- Regenerated every time the recommendation pass runs.
CREATE TABLE IF NOT EXISTS ip_wholesale_recommendations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_run_id        uuid NOT NULL REFERENCES ip_planning_runs(id) ON DELETE CASCADE,
  customer_id            uuid NOT NULL REFERENCES ip_customer_master(id) ON DELETE RESTRICT,
  category_id            uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  sku_id                 uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  period_start           date NOT NULL,
  period_end             date NOT NULL,
  final_forecast_qty     numeric(14, 3) NOT NULL DEFAULT 0,
  available_supply_qty   numeric(14, 3) NOT NULL DEFAULT 0,
  projected_shortage_qty numeric(14, 3) NOT NULL DEFAULT 0,
  projected_excess_qty   numeric(14, 3) NOT NULL DEFAULT 0,
  -- 'buy' | 'hold' | 'monitor' | 'reduce' | 'expedite'
  recommended_action     text NOT NULL
                          CHECK (recommended_action IN ('buy', 'hold', 'monitor', 'reduce', 'expedite')),
  recommended_qty        numeric(14, 3),
  action_reason          text,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_wrec_grain
  ON ip_wholesale_recommendations (planning_run_id, customer_id, sku_id, period_start);

CREATE INDEX IF NOT EXISTS idx_ip_wrec_run       ON ip_wholesale_recommendations (planning_run_id);
CREATE INDEX IF NOT EXISTS idx_ip_wrec_action    ON ip_wholesale_recommendations (recommended_action);
CREATE INDEX IF NOT EXISTS idx_ip_wrec_customer  ON ip_wholesale_recommendations (customer_id);
CREATE INDEX IF NOT EXISTS idx_ip_wrec_sku       ON ip_wholesale_recommendations (sku_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE ip_planning_runs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_wholesale_forecast        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_future_demand_requests    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_planner_overrides         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_wholesale_recommendations ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'ip_planning_runs',
    'ip_wholesale_forecast',
    'ip_future_demand_requests',
    'ip_planner_overrides',
    'ip_wholesale_recommendations'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "anon_all_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "anon_all_%1$s" ON %1$I FOR ALL TO anon USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
