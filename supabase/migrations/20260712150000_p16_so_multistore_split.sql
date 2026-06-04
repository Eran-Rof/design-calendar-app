-- P16 item 15 — multi-store sales orders.
--
-- A wholesale SO destined for several of a customer's stores/DCs is split into
-- one CHILD sales order per ship-to location. Mostly driven by incoming EDI,
-- with a manual "ship to multiple stores" path in the SO panel.
--
--   parent_sales_order_id — set on each child; points at the umbrella SO.
--   is_split_parent       — true on the umbrella SO (not itself fulfilled;
--                           its quantities live on the children).
--
-- Additive + idempotent.

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS parent_sales_order_id uuid REFERENCES sales_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_split_parent       boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_sales_orders_parent ON sales_orders (parent_sales_order_id) WHERE parent_sales_order_id IS NOT NULL;

COMMENT ON COLUMN sales_orders.parent_sales_order_id IS 'P16 item 15 — child SO points at its umbrella SO when a multi-store order was split per ship-to location.';
COMMENT ON COLUMN sales_orders.is_split_parent       IS 'P16 item 15 — true on the umbrella SO whose quantities live on its per-store children.';

NOTIFY pgrst, 'reload schema';
