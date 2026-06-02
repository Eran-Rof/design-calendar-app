-- Drop the On-Hand by Pool report view.
--
-- The "Inventory On-Hand by Pool" report (panel + /api/internal/inventory-on-hand
-- handler + nav entry) has been removed. The backing view
-- v_inventory_on_hand_by_partition was used EXCLUSIVELY by that handler — a
-- full-codebase grep finds no other consumer (app code, RPCs, or other views) —
-- so it is safe to drop here.
--
-- Idempotent — DROP VIEW IF EXISTS.

DROP VIEW IF EXISTS v_inventory_on_hand_by_partition;

NOTIFY pgrst, 'reload schema';
