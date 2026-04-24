-- Add planned_buy_qty to ecom forecast (mirrors wholesale column).
-- Apply in Supabase dashboard if automated migration is unavailable.
ALTER TABLE ip_ecom_forecast
  ADD COLUMN IF NOT EXISTS planned_buy_qty integer null;
