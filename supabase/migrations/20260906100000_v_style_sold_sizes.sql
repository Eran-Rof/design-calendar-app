-- v_style_sold_sizes — per-style distinct sizes actually SOLD, for the
-- "assign size scale from sales history" backfill (operator: Style #3).
--
-- Mirrors v_style_scale_candidates (same columns: style_code, gender_code,
-- size_scale_id, variants) so the existing auto-assign-scales handler + the
-- apply_size_scale_assignments RPC work unchanged — it just sources the size
-- set from sales order lines + AR invoice lines (joined to ip_item_master for
-- the SKU's style_code + size) instead of the full SKU catalog. Sizes are
-- ordered by sold quantity DESC so the matcher weighs best-sellers first.

CREATE OR REPLACE VIEW v_style_sold_sizes AS
WITH sold AS (
  SELECT i.style_code, i.size, COALESCE(sol.qty_ordered, 0)::numeric AS qty
  FROM sales_order_lines sol
  JOIN ip_item_master i ON i.id = sol.inventory_item_id
  WHERE i.size IS NOT NULL AND COALESCE(i.size, '') <> '' AND i.size !~* 'PPK'
  UNION ALL
  SELECT i.style_code, i.size, COALESCE(ail.quantity, 0)::numeric AS qty
  FROM ar_invoice_lines ail
  JOIN ip_item_master i ON i.id = ail.inventory_item_id
  WHERE i.size IS NOT NULL AND COALESCE(i.size, '') <> '' AND i.size !~* 'PPK'
),
agg AS (
  SELECT style_code, size, SUM(qty) AS qty
  FROM sold
  GROUP BY style_code, size
)
SELECT
  sm.id,
  sm.style_code,
  sm.gender_code,
  sm.size_scale_id,
  (SELECT array_agg(a.size ORDER BY a.qty DESC NULLS LAST)
     FROM agg a WHERE a.style_code = sm.style_code) AS variants
FROM style_master sm;

COMMENT ON VIEW v_style_sold_sizes IS 'Per-style distinct sizes sold (sales_order_lines + ar_invoice_lines via ip_item_master), ordered by sold qty. Backs auto-assign-size-scales ?source=sales (Style #3).';
