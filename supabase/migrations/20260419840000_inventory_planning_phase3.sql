-- 20260419840000_inventory_planning_phase3.sql
--
-- Demand & Inventory Planning — Phase 3 (Supply Reconciliation + Allocation).
--
-- Builds on Phases 0–2. This phase is where planning becomes
-- operational: final wholesale forecasts (Phase 1) and final ecom
-- forecasts (Phase 2) compete against real supply for actionable
-- buy / hold / expedite / reduce decisions.
--
-- Scope:
--   • ALTER ip_planning_runs to let an 'all' scope run reference the
--     two source runs it reconciles from (wholesale_source_run_id,
--     ecom_source_run_id). Keeps the reconciliation deterministic —
--     planners see exactly which demand runs were consulted.
--   • CREATE ip_projected_inventory    — one row per (run, sku, period)
--   • CREATE ip_inventory_recommendations — cross-lane recs (buy /
--     expedite / reduce / hold / monitor / reallocate / push_receipt /
--     cancel_receipt / protect_inventory)
--   • CREATE ip_allocation_rules       — rule definitions (reserve /
--     protect / strategic_customer)
--   • CREATE ip_supply_exceptions      — exception log
--   • CREATE ip_vendor_timing_signals  — optional timing metadata for
--     late-receipt detection
--
-- Design decisions, flagged for review:
--   • Reconciliation grain is MONTHLY (first-of-month period_start).
--     Ecom's weekly forecasts are rolled up into the month by the
--     reconciliation service.
--   • `total_available_supply_qty = beginning_on_hand + inbound_receipts
--     + inbound_po + wip`. ATS is stored alongside for the UI but NOT
--     added into the total — it overlaps with on_hand in most ERPs.
--     Documented in the Phase 3 README.
--   • Allocation waterfall (deterministic):
--        1. reserved_wholesale_qty (sum of reserve rules, capped at
--           wholesale_demand)
--        2. protected_ecom_qty (from ip_ecom_forecast, capped at
--           ecom_demand)
--        3. remaining wholesale (non-reserved)
--        4. remaining ecom (non-protected)
--     ending_inventory = total_supply − allocated_total
--     shortage = max(0, total_demand − total_supply)
--   • RLS: anon-permissive, matches Phase 0/1/2.

-- ── ip_planning_runs: link source demand runs ──────────────────────────────
ALTER TABLE ip_planning_runs
  ADD COLUMN IF NOT EXISTS wholesale_source_run_id uuid REFERENCES ip_planning_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ecom_source_run_id      uuid REFERENCES ip_planning_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ip_planning_runs_wholesale_src ON ip_planning_runs (wholesale_source_run_id) WHERE wholesale_source_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ip_planning_runs_ecom_src      ON ip_planning_runs (ecom_source_run_id)      WHERE ecom_source_run_id IS NOT NULL;

-- ── ip_projected_inventory ──────────────────────────────────────────────────
-- The core reconciliation output. One row per (run, sku, period).
-- Everything the workbench grid shows comes from here.
CREATE TABLE IF NOT EXISTS ip_projected_inventory (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_run_id            uuid NOT NULL REFERENCES ip_planning_runs(id) ON DELETE CASCADE,
  sku_id                     uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  category_id                uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  period_start               date NOT NULL,
  period_end                 date NOT NULL,
  period_code                text NOT NULL,        -- "YYYY-MM"
  -- ── Supply components ───────────────────────────────────────────────
  beginning_on_hand_qty      numeric(14, 3) NOT NULL DEFAULT 0,
  ats_qty                    numeric(14, 3) NOT NULL DEFAULT 0, -- reference only
  inbound_receipts_qty       numeric(14, 3) NOT NULL DEFAULT 0, -- historical receipts landed in-period
  inbound_po_qty             numeric(14, 3) NOT NULL DEFAULT 0, -- open POs expected in-period
  wip_qty                    numeric(14, 3) NOT NULL DEFAULT 0,
  total_available_supply_qty numeric(14, 3) NOT NULL DEFAULT 0, -- beginning + receipts + po + wip (ATS excluded)
  -- ── Demand components ───────────────────────────────────────────────
  wholesale_demand_qty       numeric(14, 3) NOT NULL DEFAULT 0, -- sum from ip_wholesale_forecast
  ecom_demand_qty            numeric(14, 3) NOT NULL DEFAULT 0, -- sum from ip_ecom_forecast
  protected_ecom_qty         numeric(14, 3) NOT NULL DEFAULT 0,
  reserved_wholesale_qty     numeric(14, 3) NOT NULL DEFAULT 0,
  allocated_total_qty        numeric(14, 3) NOT NULL DEFAULT 0, -- min(total_supply, total_demand)
  allocated_wholesale_qty    numeric(14, 3) NOT NULL DEFAULT 0,
  allocated_ecom_qty         numeric(14, 3) NOT NULL DEFAULT 0,
  ending_inventory_qty       numeric(14, 3) NOT NULL DEFAULT 0, -- total_supply − allocated_total
  shortage_qty               numeric(14, 3) NOT NULL DEFAULT 0,
  excess_qty                 numeric(14, 3) NOT NULL DEFAULT 0,
  projected_stockout_flag    boolean NOT NULL DEFAULT false,
  created_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_projected_inventory_grain
  ON ip_projected_inventory (planning_run_id, sku_id, period_start);
CREATE INDEX IF NOT EXISTS idx_ip_proj_inv_run    ON ip_projected_inventory (planning_run_id);
CREATE INDEX IF NOT EXISTS idx_ip_proj_inv_sku    ON ip_projected_inventory (sku_id);
CREATE INDEX IF NOT EXISTS idx_ip_proj_inv_period ON ip_projected_inventory (period_code);
CREATE INDEX IF NOT EXISTS idx_ip_proj_inv_stockout ON ip_projected_inventory (projected_stockout_flag) WHERE projected_stockout_flag;

-- ── ip_inventory_recommendations ────────────────────────────────────────────
-- Cross-lane recommendations. Kept separate from Phase 1's
-- ip_wholesale_recommendations so wholesale and reconciliation
-- outputs don't step on each other.
CREATE TABLE IF NOT EXISTS ip_inventory_recommendations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_run_id    uuid NOT NULL REFERENCES ip_planning_runs(id) ON DELETE CASCADE,
  sku_id             uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  category_id        uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  period_code        text NOT NULL,
  -- 'buy' | 'expedite' | 'hold' | 'reduce' | 'monitor' | 'reallocate'
  -- | 'cancel_receipt' | 'push_receipt' | 'protect_inventory'
  recommendation_type text NOT NULL
                        CHECK (recommendation_type IN (
                          'buy', 'expedite', 'hold', 'reduce', 'monitor',
                          'reallocate', 'cancel_receipt', 'push_receipt',
                          'protect_inventory'
                        )),
  recommendation_qty numeric(14, 3),
  action_reason      text,
  -- 'critical' | 'high' | 'medium' | 'low'
  priority_level     text NOT NULL DEFAULT 'low'
                        CHECK (priority_level IN ('critical', 'high', 'medium', 'low')),
  shortage_qty       numeric(14, 3),
  excess_qty         numeric(14, 3),
  service_risk_flag  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_inventory_recs_grain
  ON ip_inventory_recommendations (planning_run_id, sku_id, period_start, recommendation_type);
CREATE INDEX IF NOT EXISTS idx_ip_inv_recs_run       ON ip_inventory_recommendations (planning_run_id);
CREATE INDEX IF NOT EXISTS idx_ip_inv_recs_priority  ON ip_inventory_recommendations (priority_level);
CREATE INDEX IF NOT EXISTS idx_ip_inv_recs_type      ON ip_inventory_recommendations (recommendation_type);
CREATE INDEX IF NOT EXISTS idx_ip_inv_recs_svc_risk  ON ip_inventory_recommendations (service_risk_flag) WHERE service_risk_flag;

-- ── ip_allocation_rules ─────────────────────────────────────────────────────
-- Reserves / protections. Applied in priority_rank order (lower number
-- first). A NULL target means "applies to all". Only `active` rules
-- are consulted.
CREATE TABLE IF NOT EXISTS ip_allocation_rules (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_name                text NOT NULL,
  -- 'reserve_wholesale' | 'protect_ecom' | 'strategic_customer' | 'cap_ecom'
  rule_type                text NOT NULL
                             CHECK (rule_type IN (
                               'reserve_wholesale', 'protect_ecom',
                               'strategic_customer', 'cap_ecom'
                             )),
  priority_rank            integer NOT NULL DEFAULT 100,
  applies_to_customer_id   uuid REFERENCES ip_customer_master(id) ON DELETE CASCADE,
  applies_to_channel_id    uuid REFERENCES ip_channel_master(id)  ON DELETE CASCADE,
  applies_to_category_id   uuid REFERENCES ip_category_master(id) ON DELETE CASCADE,
  applies_to_sku_id        uuid REFERENCES ip_item_master(id)     ON DELETE CASCADE,
  -- Either a fixed qty or a percent of demand. If both set, qty wins.
  reserve_qty              numeric(14, 3),
  reserve_percent          numeric(5, 4), -- 0.0000 – 1.0000
  protection_flag          boolean NOT NULL DEFAULT true,
  note                     text,
  active                   boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_alloc_rules_type     ON ip_allocation_rules (rule_type);
CREATE INDEX IF NOT EXISTS idx_ip_alloc_rules_active   ON ip_allocation_rules (active) WHERE active;
CREATE INDEX IF NOT EXISTS idx_ip_alloc_rules_priority ON ip_allocation_rules (priority_rank);

DROP TRIGGER IF EXISTS trg_ip_alloc_rules_updated ON ip_allocation_rules;
CREATE TRIGGER trg_ip_alloc_rules_updated BEFORE UPDATE ON ip_allocation_rules
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── ip_supply_exceptions ────────────────────────────────────────────────────
-- Append-only exception log. The reconciliation pass rebuilds these
-- per run so we clear+insert on each refresh.
CREATE TABLE IF NOT EXISTS ip_supply_exceptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_run_id    uuid NOT NULL REFERENCES ip_planning_runs(id) ON DELETE CASCADE,
  sku_id             uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  category_id        uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  period_code        text NOT NULL,
  -- Exception taxonomy — stable set, keep in sync with exceptionEngine.ts
  exception_type     text NOT NULL
                       CHECK (exception_type IN (
                         'projected_stockout',
                         'negative_ats',
                         'late_po',
                         'excess_inventory',
                         'supply_demand_mismatch',
                         'missing_supply_inputs',
                         'protected_not_covered',
                         'reserved_not_covered'
                       )),
  severity           text NOT NULL DEFAULT 'medium'
                       CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  details            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_supply_exc_run       ON ip_supply_exceptions (planning_run_id);
CREATE INDEX IF NOT EXISTS idx_ip_supply_exc_type      ON ip_supply_exceptions (exception_type);
CREATE INDEX IF NOT EXISTS idx_ip_supply_exc_severity  ON ip_supply_exceptions (severity);

-- ── ip_vendor_timing_signals ────────────────────────────────────────────────
-- Optional but useful — surfaces vendor/SKU reliability so the
-- exception engine can flag late-PO risk.
CREATE TABLE IF NOT EXISTS ip_vendor_timing_signals (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id                  uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE CASCADE,
  vendor_id               uuid REFERENCES ip_vendor_master(id) ON DELETE SET NULL,
  avg_lead_time_days      integer,
  receipt_variability_days integer,
  -- 0.0–1.0 — higher = more risk. MVP heuristic; Phase 4 may learn this.
  delay_risk_score        numeric(4, 3),
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_vendor_timing_grain
  ON ip_vendor_timing_signals (sku_id, COALESCE(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS idx_ip_vendor_timing_risk ON ip_vendor_timing_signals (delay_risk_score DESC) WHERE delay_risk_score IS NOT NULL;

DROP TRIGGER IF EXISTS trg_ip_vendor_timing_updated ON ip_vendor_timing_signals;
CREATE TRIGGER trg_ip_vendor_timing_updated BEFORE UPDATE ON ip_vendor_timing_signals
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE ip_projected_inventory        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_inventory_recommendations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_allocation_rules           ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_supply_exceptions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_vendor_timing_signals      ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'ip_projected_inventory',
    'ip_inventory_recommendations',
    'ip_allocation_rules',
    'ip_supply_exceptions',
    'ip_vendor_timing_signals'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "anon_all_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "anon_all_%1$s" ON %1$I FOR ALL TO anon USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
