-- 20260422210000_forecast_accuracy_method.sql
--
-- Adds forecast_method to ip_forecast_accuracy so accuracy can be sliced
-- by which method the engine used (ly_sales, trailing_avg_sku, cadence_sku,
-- etc.). Nullable because rows written before this migration have no value.
--
-- Also adds a partial index to support efficient GROUP BY method queries.

ALTER TABLE ip_forecast_accuracy
  ADD COLUMN IF NOT EXISTS forecast_method text;

CREATE INDEX IF NOT EXISTS idx_ip_acc_method
  ON ip_forecast_accuracy (forecast_method)
  WHERE forecast_method IS NOT NULL;
