-- P15 Inventory On-Hand by Brand Pool — read report view.
--
-- Creates v_inventory_on_hand_by_partition which aggregates inventory_layers
-- (remaining_qty > 0) by entity / partition / item, joining:
--   • inventory_partition  — for partition code/name and brand FK
--   • brand_master         — for brand code/name
--   • ip_item_master       — for sku_code and description
--
-- NULL partition_id (legacy/unpartitioned layers pre-P15) are shown with
-- partition_code '(unpartitioned)' and partition_name 'Unpartitioned' via
-- COALESCE, so they don't vanish from the report.
--
-- on_hand_value_cents = SUM(remaining_qty * unit_cost_cents) — FIFO weighted
-- value of the remaining units. Both remaining_qty and unit_cost_cents are
-- stored as exact numerics/bigints so integer arithmetic is safe.
--
-- Idempotent — CREATE OR REPLACE VIEW.

CREATE OR REPLACE VIEW v_inventory_on_hand_by_partition AS
SELECT
  il.entity_id,
  il.partition_id,
  COALESCE(ip.code, '(unpartitioned)')              AS partition_code,
  COALESCE(ip.name, 'Unpartitioned')                AS partition_name,
  bm.id                                             AS brand_id,
  bm.code                                           AS brand_code,
  bm.name                                           AS brand_name,
  il.item_id,
  im.sku_code,
  im.description,
  SUM(il.remaining_qty)                             AS on_hand_qty,
  SUM(il.remaining_qty * il.unit_cost_cents)        AS on_hand_value_cents
FROM inventory_layers il
JOIN ip_item_master im
  ON im.id = il.item_id
LEFT JOIN inventory_partition ip
  ON ip.id = il.partition_id
LEFT JOIN brand_master bm
  ON bm.id = ip.brand_id
WHERE il.remaining_qty > 0
GROUP BY
  il.entity_id,
  il.partition_id,
  ip.code,
  ip.name,
  bm.id,
  bm.code,
  bm.name,
  il.item_id,
  im.sku_code,
  im.description;

COMMENT ON VIEW v_inventory_on_hand_by_partition IS
  'P15 On-Hand by Brand Pool — aggregates positive FIFO inventory_layers by entity/partition/item. NULL partition_id = legacy/unpartitioned stock (pre-P15). Join to brand_master is through inventory_partition.brand_id.';

NOTIFY pgrst, 'reload schema';
