-- Manufacturing Phase B — build FOR a customer.
--
-- A build can be made for a specific customer (private-label / made-to-order).
-- Recording the customer lets the completion flow auto-mint that customer's
-- own style number into style_customer_numbers (one base style ⇄ per-customer
-- number). Nullable — most builds are for stock and leave it null.
ALTER TABLE mfg_build_orders
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS mfg_build_orders_customer_idx ON mfg_build_orders(customer_id);
