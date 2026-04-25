-- 20260430000000_ip_forecast_unit_cost_override.sql
--
-- Per-row planner-editable unit cost on wholesale forecast rows.
-- Default (null) means "use the auto-derived cost" — currently the ATS
-- avgCost from app_data['ats_excel_data'], falling back to
-- ip_item_master.unit_cost. When set, this column overrides that value
-- for the planning grid's Buy $ extension.
--
-- numeric, not float — money math.

ALTER TABLE ip_wholesale_forecast
  ADD COLUMN IF NOT EXISTS unit_cost_override numeric;
