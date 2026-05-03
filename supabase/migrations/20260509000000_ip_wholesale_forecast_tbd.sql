-- 20260509000000_ip_wholesale_forecast_tbd.sql
--
-- Stock-buy "TBD" rows for the wholesale planning grid. One row per
-- (planning_run, style, period) by default. The (Supply Only)
-- customer carries any aggregate Buyer / Override / Buy the planner
-- types at any rollup grain — instead of distributing across real
-- customer demand rows, the entire typed total lands on the TBD row
-- for that style+period.
--
-- The color starts as the literal string "TBD" but can be edited to
-- (a) any existing color of the style in ip_item_master, or (b) a
-- new color the master doesn't yet know about. In case (b) the row
-- carries is_new_color = true until a future build sees the same
-- color string in any item_master variant of the style, at which
-- point the flag clears automatically.
--
-- Why a separate table rather than ip_wholesale_forecast: the
-- forecast unique key is (run, customer, sku_id, period). TBD rows
-- have no real sku_id (no item_master entry has color "TBD"), so
-- forcing them into the forecast table would require either
-- polluting the master with synthetic items or relaxing the FK.
-- A dedicated table keeps both schemas clean.

CREATE TABLE IF NOT EXISTS ip_wholesale_forecast_tbd (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  planning_run_id     uuid NOT NULL REFERENCES ip_planning_runs(id) ON DELETE CASCADE,
  -- Style identity. Free text rather than a FK because the master
  -- stores style as a column on items (style_code), not as a
  -- separate table. The (run, style_code, period_start) tuple is
  -- the natural key for the default "one TBD per style per period".
  style_code          text NOT NULL,
  -- Initial value is the literal "TBD". Planner can rename via the
  -- color cell in the grid. is_new_color marks a value the master
  -- doesn't yet recognize.
  color               text NOT NULL DEFAULT 'TBD',
  is_new_color        boolean NOT NULL DEFAULT false,
  -- Customer the stock buy is currently assigned to. Defaults to
  -- the (Supply Only) placeholder customer; planner can reassign
  -- via the customer cell to convert this from stock-buy to a real
  -- customer's committed demand.
  customer_id         uuid NOT NULL REFERENCES ip_customer_master(id) ON DELETE RESTRICT,
  -- Optional category metadata for "Add row" feature. Group / sub
  -- cat are stored as plain text since item_master keeps them in
  -- attributes JSONB, not normalized columns.
  group_name          text,
  sub_category_name   text,
  -- Forecast-style period grain matches ip_wholesale_forecast.
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  period_code         text NOT NULL,
  buyer_request_qty   numeric(14, 3) NOT NULL DEFAULT 0,
  override_qty        numeric(14, 3) NOT NULL DEFAULT 0,
  final_forecast_qty  numeric(14, 3) NOT NULL DEFAULT 0,
  planned_buy_qty     numeric(14, 3),
  unit_cost           numeric(12, 4),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_wf_tbd_grain
  ON ip_wholesale_forecast_tbd (planning_run_id, style_code, color, customer_id, period_start);
CREATE INDEX IF NOT EXISTS idx_ip_wf_tbd_run
  ON ip_wholesale_forecast_tbd (planning_run_id);
CREATE INDEX IF NOT EXISTS idx_ip_wf_tbd_style
  ON ip_wholesale_forecast_tbd (style_code);

-- Anon-permissive RLS — same policy used by every other browser-side-
-- written planning table.
ALTER TABLE ip_wholesale_forecast_tbd ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_ip_wf_tbd" ON ip_wholesale_forecast_tbd;
CREATE POLICY "anon_all_ip_wf_tbd" ON ip_wholesale_forecast_tbd
  FOR ALL TO anon
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ip_wholesale_forecast_tbd TO anon;

DROP TRIGGER IF EXISTS trg_ip_wf_tbd_updated ON ip_wholesale_forecast_tbd;
CREATE TRIGGER trg_ip_wf_tbd_updated BEFORE UPDATE ON ip_wholesale_forecast_tbd
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();
