-- PR #996 / M18 — expose cancel_date on the allocation demand view.
--
-- The Allocations Workbench now groups demand rows under a per-SO sub-header
-- showing Customer · Start Ship · Cancel. start-ship (requested_ship_date) was
-- already on the view; cancel_date was not. Add it (CREATE OR REPLACE preserves
-- all existing columns/consumers).

CREATE OR REPLACE VIEW v_allocation_demand AS
SELECT
  sol.id                                         AS line_id,
  so.id                                          AS so_id,
  so.so_number,
  so.entity_id,
  so.order_date,
  so.requested_ship_date,
  so.cancel_date,
  so.status                                      AS so_status,
  so.customer_id,
  c.name                                         AS customer_name,
  COALESCE(c.is_factored, false)                 AS is_factored,
  so.factor_approval_status,
  so.factor_reference,
  so.factor_approved_cents,
  (c.payment_processor IS NOT NULL
     OR c.processor_payment_method_id IS NOT NULL
     OR c.processor_card_last4 IS NOT NULL)      AS has_card,
  sol.inventory_item_id                          AS item_id,
  im.sku_code,
  im.color,
  im.size,
  im.description,
  sol.qty_ordered,
  sol.qty_allocated,
  sol.qty_shipped,
  (sol.qty_ordered - sol.qty_allocated)          AS open_qty,
  sol.unit_price_cents,
  so.brand_id,
  so.channel_id
FROM sales_order_lines sol
JOIN sales_orders so ON so.id = sol.sales_order_id
LEFT JOIN customers c       ON c.id  = so.customer_id
LEFT JOIN ip_item_master im ON im.id = sol.inventory_item_id
WHERE so.status IN ('confirmed', 'allocated', 'fulfilling')
  AND COALESCE(so.is_split_parent, false) = false
  AND sol.status NOT IN ('cancelled', 'shipped', 'invoiced')
  AND sol.inventory_item_id IS NOT NULL
  AND (sol.qty_ordered - sol.qty_shipped) > 0;   -- still room to (re)allocate
