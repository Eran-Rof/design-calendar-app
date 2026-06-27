-- 20260912000000_so_bulk_order_flag.sql (renumbered up from 20260902000000 to clear
-- dup-version collisions with main's closeout_commission + date_preset_master)
--
-- Lot numbers — Scenario 4 (4.2): bulk ↔ distro matching. A "bulk" order is one
-- large customer PO (e.g. an MMG bulk) whose quantity is later subdivided across
-- several "distro" customer POs. This flag marks the bulk SO so an incoming
-- distro (a later customer-PO SO for the same customer) can be matched against it
-- by style/color, with a % match and a prompt to cancel the now-superseded bulk.
--
-- Additive boolean; no backfill. The match itself is computed on demand.

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS is_bulk_order boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN sales_orders.is_bulk_order IS
  'True for a bulk customer order whose quantity is later split across distro '
  'customer POs (Scenario 4.2). Incoming distros are matched against open bulk '
  'SOs by style/color; the operator may cancel the bulk once distros cover it.';

CREATE INDEX IF NOT EXISTS idx_sales_orders_bulk_open
  ON sales_orders (entity_id, customer_id)
  WHERE is_bulk_order = true;
