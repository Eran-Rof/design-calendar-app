-- 20260915000000_so_placeholder_customer_po.sql (renumbered up to clear dup-version collisions with main migrations)
-- to clear dup-version collisions with main's so_credit_gates + date_preset_master)
--
-- Lot numbers — Scenario 2 (upfront customer PO from a buy sheet, before the
-- real PO exists). Fulfillment opens a "placeholder" SO with an auto-generated
-- placeholder customer PO; production makes a PO from it (lot = placeholder PO,
-- via Scenario 3). When the real customer PO arrives, it replaces the
-- placeholder and the new lot propagates to all not-yet-received POs on the SO.
--
-- This flag marks an SO whose customer_po is a system-generated placeholder
-- (vs a real buyer PO), so the UI can prompt to replace it. The replacement
-- (and lot propagation) is handled in the SO PATCH handler — no schema needed
-- beyond this flag.

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS customer_po_is_placeholder boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN sales_orders.customer_po_is_placeholder IS
  'True when customer_po is a system-generated placeholder (Scenario 2), awaiting '
  'the real customer PO. Cleared when the real PO replaces it; the new PO then '
  'propagates as the lot to all not-yet-received POs linked to this SO.';
