-- 20260430000000_ip_forecast_unit_cost_override.sql
--
-- Per-row planner-editable unit cost on wholesale forecast rows.
-- Default (null) means "use the auto-derived cost" — the all-SKU avg cost
-- from ip_item_avg_cost (loaded via Xoro / Excel ingest), falling back to
-- the ATS in-stock avgCost and finally ip_item_master.unit_cost.
--
-- numeric, not float — money math.

ALTER TABLE ip_wholesale_forecast
  ADD COLUMN IF NOT EXISTS unit_cost_override numeric;
