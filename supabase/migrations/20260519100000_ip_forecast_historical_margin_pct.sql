-- Add historical_margin_pct to ip_wholesale_forecast.
--
-- Stores a per-(customer, sku) average gross margin from the trailing
-- sales window the forecast service already computes (3-month T3,
-- weighted by net_amount). The grid renders it as a sort/filter aid
-- so the planner can spot high-margin SKUs whose forecast looks light
-- (raise it) or low-margin SKUs whose forecast looks heavy (cut it).
--
-- Stored as a decimal fraction (0.25 = 25%), matching the per-row
-- margin_pct shape on ip_sales_history_wholesale that this is
-- aggregated from. Nullable — null when the trailing window had no
-- sales with usable cost+revenue.

ALTER TABLE ip_wholesale_forecast
  ADD COLUMN IF NOT EXISTS historical_margin_pct numeric(6, 4) NULL;

COMMENT ON COLUMN ip_wholesale_forecast.historical_margin_pct IS
  'Weighted-average gross margin % over the trailing T3 window for '
  'this (customer, sku) pair. Fraction (0.25 = 25%). NULL when no '
  'usable margin data in window.';
