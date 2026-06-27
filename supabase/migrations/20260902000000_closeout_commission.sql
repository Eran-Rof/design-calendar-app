-- Closeout-order commission (operator request).
--
-- Sales reps earn a different (usually lower) commission rate on closeout
-- orders. We model this as:
--   • customers.closeout_commission_pct — the rep commission % to use for this
--     customer's CLOSEOUT orders (in place of the normal sales_rep_1 + _2 rates).
--   • sales_orders.is_closeout — a per-order flag the operator ticks on SO entry;
--     when true, the Customer Scorecard's commission math uses the customer's
--     closeout rate for that order's sales instead of the normal combined rate.
--
-- Both additive + idempotent (CI re-runs manually-applied migrations).

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS closeout_commission_pct numeric(6,3);

COMMENT ON COLUMN customers.closeout_commission_pct IS
  'Sales-rep commission % applied to this customer''s CLOSEOUT orders (sales_orders.is_closeout = true), in place of the normal sales_rep_1/2 combined rate. NULL = fall back to the normal rate.';

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS is_closeout boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN sales_orders.is_closeout IS
  'Operator-set on SO entry: true when this is a closeout order, so commission uses the customer''s closeout_commission_pct.';

CREATE INDEX IF NOT EXISTS idx_sales_orders_closeout
  ON sales_orders (is_closeout) WHERE is_closeout = true;
