-- 20260419830000_inventory_planning_phase2.sql
--
-- Demand & Inventory Planning — Phase 2 (Ecom MVP).
--
-- Builds on Phase 0 + Phase 1.
--
-- Scope:
--   • ALTER existing Phase 0 tables rather than duplicate — the Phase 0
--     `ip_sales_history_ecom` is the right home for normalized Shopify
--     order rows; it just needs a customer_id column to match the Phase
--     2 spec. Same for `ip_product_channel_status` — we add the
--     merchandising-planning fields (launch_date, markdown_flag,
--     inventory_policy, is_active) that Phase 2 forecast compute reads.
--   • CREATE ip_ecom_forecast — weekly grain per (run, channel, sku).
--   • CREATE ip_ecom_override_events — append-only override audit, mirror
--     of Phase 1's ip_planner_overrides.
--
-- Decisions flagged for review:
--   • Grain is WEEKLY (ISO 8601 week, Monday-start). period_code = "YYYY-Www"
--     (e.g. "2026-W17"). Compute uses UTC to avoid TZ drift.
--   • Ecom final formula: `final = max(0, system + override)`. No
--     buyer_request column here — ecom doesn't have a wholesale-style
--     committed-buyer concept; planner overrides carry any adjustment.
--   • `protected_ecom_qty` is persisted on the forecast row so Phase 3
--     allocation can read it directly. Phase 2 populates it with the
--     conservative default (= final_forecast_qty, i.e. full ecom
--     protection).

-- ── ip_sales_history_ecom: add customer_id ──────────────────────────────────
-- Shopify orders do carry a customer id, but Phase 0 didn't wire it through.
-- The Phase 2 ingest pass fills it on new rows; old rows stay NULL.
ALTER TABLE ip_sales_history_ecom
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES ip_customer_master(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ip_sales_ecom_customer ON ip_sales_history_ecom (customer_id) WHERE customer_id IS NOT NULL;

-- ── ip_product_channel_status: add planning fields ──────────────────────────
ALTER TABLE ip_product_channel_status
  ADD COLUMN IF NOT EXISTS is_active boolean,
  ADD COLUMN IF NOT EXISTS launch_date date,
  ADD COLUMN IF NOT EXISTS markdown_flag boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inventory_policy text;

-- Backfill is_active from the Phase 0 `listed` + `status` text.
UPDATE ip_product_channel_status
SET is_active = CASE
  WHEN listed IS TRUE AND (status IS NULL OR status IN ('active', 'published', 'live')) THEN true
  WHEN status IN ('archived', 'unpublished', 'draft', 'inactive') THEN false
  ELSE listed
END
WHERE is_active IS NULL;

CREATE INDEX IF NOT EXISTS idx_ip_pcs_active   ON ip_product_channel_status (is_active) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_ip_pcs_launch   ON ip_product_channel_status (launch_date) WHERE launch_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ip_pcs_markdown ON ip_product_channel_status (markdown_flag) WHERE markdown_flag;

-- ── ip_ecom_forecast ─────────────────────────────────────────────────────────
-- One row per (run, channel, sku, week_start). Category is denormalized
-- from the item for fast grid filtering but not part of the uniqueness
-- contract.
CREATE TABLE IF NOT EXISTS ip_ecom_forecast (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_run_id       uuid NOT NULL REFERENCES ip_planning_runs(id) ON DELETE CASCADE,
  channel_id            uuid NOT NULL REFERENCES ip_channel_master(id) ON DELETE RESTRICT,
  category_id           uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  sku_id                uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  week_start            date NOT NULL,   -- Monday of the ISO week
  week_end              date NOT NULL,   -- Sunday of the ISO week
  period_code           text NOT NULL,   -- "YYYY-Www"
  system_forecast_qty   numeric(14, 3) NOT NULL DEFAULT 0,
  override_qty          numeric(14, 3) NOT NULL DEFAULT 0,
  final_forecast_qty    numeric(14, 3) NOT NULL DEFAULT 0,
  -- Phase 3 allocation input: how much of final is reserved for ecom
  -- before wholesale pulls from shared inventory. MVP sets this to
  -- final_forecast_qty (full protection). Phase 3 introduces policy.
  protected_ecom_qty    numeric(14, 3) NOT NULL DEFAULT 0,
  -- Flags that steer both the forecast math and the UI badges.
  promo_flag            boolean NOT NULL DEFAULT false,
  launch_flag           boolean NOT NULL DEFAULT false,
  markdown_flag         boolean NOT NULL DEFAULT false,
  -- 'trailing_4w' | 'trailing_13w' | 'weighted_recent' | 'seasonality' |
  -- 'launch_curve' | 'category_fallback' | 'zero_floor'. Method reflects
  -- the dominant branch used to produce system_forecast_qty.
  forecast_method       text NOT NULL DEFAULT 'zero_floor',
  -- Diagnostic fields — planners see these in the chart tooltip.
  return_rate           numeric(6, 4),           -- 0.0–1.0
  seasonality_factor    numeric(6, 3),           -- multiplier applied (1.0 = neutral)
  promo_factor          numeric(6, 3),           -- 1.0 when no promo
  launch_factor         numeric(6, 3),           -- 1.0 when not on launch curve
  markdown_factor       numeric(6, 3),           -- 1.0 when no markdown
  trailing_4w_qty       numeric(14, 3),
  trailing_13w_qty      numeric(14, 3),
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_ecom_forecast_grain
  ON ip_ecom_forecast (planning_run_id, channel_id, sku_id, week_start);

CREATE INDEX IF NOT EXISTS idx_ip_ecf_run       ON ip_ecom_forecast (planning_run_id);
CREATE INDEX IF NOT EXISTS idx_ip_ecf_channel   ON ip_ecom_forecast (channel_id);
CREATE INDEX IF NOT EXISTS idx_ip_ecf_category  ON ip_ecom_forecast (category_id);
CREATE INDEX IF NOT EXISTS idx_ip_ecf_sku       ON ip_ecom_forecast (sku_id);
CREATE INDEX IF NOT EXISTS idx_ip_ecf_period    ON ip_ecom_forecast (period_code);
CREATE INDEX IF NOT EXISTS idx_ip_ecf_launch    ON ip_ecom_forecast (launch_flag) WHERE launch_flag;
CREATE INDEX IF NOT EXISTS idx_ip_ecf_promo     ON ip_ecom_forecast (promo_flag) WHERE promo_flag;

DROP TRIGGER IF EXISTS trg_ip_ecom_forecast_updated ON ip_ecom_forecast;
CREATE TRIGGER trg_ip_ecom_forecast_updated BEFORE UPDATE ON ip_ecom_forecast
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ── ip_ecom_override_events ──────────────────────────────────────────────────
-- Append-only override audit. One row per planner edit, most recent wins
-- when the compute reads back.
CREATE TABLE IF NOT EXISTS ip_ecom_override_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_run_id   uuid NOT NULL REFERENCES ip_planning_runs(id) ON DELETE CASCADE,
  channel_id        uuid NOT NULL REFERENCES ip_channel_master(id) ON DELETE RESTRICT,
  category_id       uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  sku_id            uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  week_start        date NOT NULL,
  week_end          date NOT NULL,
  override_qty      numeric(14, 3) NOT NULL,
  -- 'promotion' | 'campaign' | 'content_push' | 'influencer' |
  -- 'launch_expectation' | 'markdown_strategy' | 'planner_estimate'
  reason_code       text NOT NULL
                      CHECK (reason_code IN (
                        'promotion', 'campaign', 'content_push', 'influencer',
                        'launch_expectation', 'markdown_strategy', 'planner_estimate'
                      )),
  note              text,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ip_ecom_ov_run        ON ip_ecom_override_events (planning_run_id);
CREATE INDEX IF NOT EXISTS idx_ip_ecom_ov_grain      ON ip_ecom_override_events (planning_run_id, channel_id, sku_id, week_start);
CREATE INDEX IF NOT EXISTS idx_ip_ecom_ov_created_at ON ip_ecom_override_events (created_at DESC);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE ip_ecom_forecast        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_ecom_override_events ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'ip_ecom_forecast',
    'ip_ecom_override_events'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "anon_all_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "anon_all_%1$s" ON %1$I FOR ALL TO anon USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
