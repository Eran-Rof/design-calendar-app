-- inventory_cost_backfill_tier1_native_po.sql
-- ════════════════════════════════════════════════════════════════════════════
-- Inventory Aging cost back-fill — TIER 1: native purchase-order lines.
--
-- Fills a report-fallback average cost for items that are UNCOSTED today (their
-- FIFO layer cost is 0, and there is no ip_item_avg_cost and no item unit_cost),
-- using the weighted-average unit cost from native purchase_order_lines
-- (inventory_item_id, unit_cost_cents). Writes ONLY ip_item_avg_cost — the same
-- table the Inventory Aging report already reads as a cost fallback — so there
-- is NO GL, on-hand, or inventory-layer mutation. Idempotent + re-runnable, and
-- it NEVER overwrites an item that already has a real cost.
--
-- Coverage: ~1,832 of 3,692 uncosted items carry a native PO cost (50%).
-- The Xoro-PO half (tanda_pos.data Items) is Tier 2 (parse-matched, reviewed
-- separately before applying).
-- ════════════════════════════════════════════════════════════════════════════

WITH ent AS (SELECT id FROM entities WHERE code = 'ROF'),
uncosted AS (
  -- items with on-hand whose effective cost is 0 (no layer cost, no avg_cost, no item cost)
  SELECT DISTINCT il.item_id, im.sku_code
  FROM inventory_layers il
  JOIN ip_item_master im ON im.id = il.item_id
  WHERE il.entity_id = (SELECT id FROM ent)
    AND il.remaining_qty > 0
    AND il.unit_cost_cents = 0
    AND (im.unit_cost IS NULL OR im.unit_cost = 0)
    AND NOT EXISTS (SELECT 1 FROM ip_item_avg_cost ac WHERE ac.sku_code = im.sku_code AND ac.avg_cost > 0)
),
po_cost AS (
  -- weighted-average unit cost per item across its native PO lines (weight by
  -- received qty, else ordered qty, floored at 1)
  SELECT
    u.sku_code,
    SUM(pol.unit_cost_cents * GREATEST(COALESCE(NULLIF(pol.qty_received, 0), pol.qty_ordered, 1), 1))
      / NULLIF(SUM(GREATEST(COALESCE(NULLIF(pol.qty_received, 0), pol.qty_ordered, 1), 1)), 0) AS wavg_cents,
    'native:' || MIN(pol.purchase_order_id::text) AS ref
  FROM uncosted u
  JOIN purchase_order_lines pol ON pol.inventory_item_id = u.item_id AND pol.unit_cost_cents > 0
  GROUP BY u.sku_code
)
INSERT INTO ip_item_avg_cost (sku_code, avg_cost, source, source_ref, updated_at)
SELECT sku_code, round(wavg_cents) / 100.0, 'po_backfill', ref, now()
FROM po_cost
WHERE wavg_cents > 0
ON CONFLICT (sku_code) DO UPDATE
  SET avg_cost = EXCLUDED.avg_cost,
      source = EXCLUDED.source,
      source_ref = EXCLUDED.source_ref,
      updated_at = now()
  WHERE ip_item_avg_cost.avg_cost IS NULL OR ip_item_avg_cost.avg_cost = 0;
