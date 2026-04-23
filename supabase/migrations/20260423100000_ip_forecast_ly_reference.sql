-- Add ly_reference_qty to ip_wholesale_forecast.
-- Stores the raw LY source sum (total of non-zero units across the three
-- same-period LY months) so the grid and drawer can show it alongside
-- the system forecast. Null for all non-ly_sales methods.

ALTER TABLE ip_wholesale_forecast
  ADD COLUMN IF NOT EXISTS ly_reference_qty integer null;
