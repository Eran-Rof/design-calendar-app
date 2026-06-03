-- Sales Order fulfillment source: how the order is filled.
--   production — make it; the Production Manager is notified (email + in-app).
--   ats        — ship from available stock; the SO grid shows ATS by size.
-- Null = unspecified. No default so existing rows stay null.

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS fulfillment_source text
  CHECK (fulfillment_source IN ('production', 'ats'));

NOTIFY pgrst, 'reload schema';
