-- 20260899000000_lot_numbers_phase1.sql
--
-- Lot numbers — Phase 1 (foundation + Scenario 1).
--
-- A "lot" ties a quantity of a style/color to a source batch (a PO today;
-- eventually a customer PO). Grain = per style+color line: one lot covers the
-- full size run of a style/color on an order line. The PO/SO line tables are
-- SKU-level (one row per inventory_item_id), so the lot is stored per SKU row
-- but the UI manages it at the style+color block level (all SKUs in a block
-- share one lot).
--
-- Phase 1 adds the column in the three places lots must live:
--   purchase_order_lines  — lot stamped at PO issue (= PO number; Scenario 1),
--                           editable per line.
--   sales_order_lines     — foundation column; populated by later phases
--                           (Scenario 3 = customer PO, Scenario 5 = picked lots).
--   inventory_layers      — receiving carries the PO line's lot onto the layer
--                           so on-hand stock is lot-identified (enables the
--                           lot-aware ATS allocation in Scenario 5).
--
-- All nullable + additive — no backfill, no behavior change until the handlers
-- and UI populate them.

ALTER TABLE purchase_order_lines ADD COLUMN IF NOT EXISTS lot_number text;
ALTER TABLE sales_order_lines    ADD COLUMN IF NOT EXISTS lot_number text;
ALTER TABLE inventory_layers     ADD COLUMN IF NOT EXISTS lot_number text;

COMMENT ON COLUMN purchase_order_lines.lot_number IS
  'Lot identifier for this line (grain: style+color). Auto-stamped to the PO '
  'number at issue when empty (Scenario 1); editable per line. Carried onto '
  'inventory_layers at receipt.';
COMMENT ON COLUMN sales_order_lines.lot_number IS
  'Lot identifier for this line (grain: style+color). Set by customer PO '
  '(Scenario 3) or by lot-aware ATS allocation (Scenario 5).';
COMMENT ON COLUMN inventory_layers.lot_number IS
  'Lot the on-hand stock in this layer belongs to (from the originating PO '
  'line at receipt). Enables lot-aware available-to-sell allocation.';

-- Supports lot-scoped on-hand lookups for the Scenario 5 allocation rule.
CREATE INDEX IF NOT EXISTS idx_inventory_layers_entity_item_lot
  ON inventory_layers (entity_id, item_id, lot_number)
  WHERE lot_number IS NOT NULL;
