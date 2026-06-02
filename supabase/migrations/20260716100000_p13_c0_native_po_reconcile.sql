-- P13 / C0 — Reconcile the two PO systems (operator decision 2026-06-02).
--
-- Two PO models exist: `tanda_pos` (Xoro-mirrored, nightly-owned, drives PO WIP)
-- and `purchase_orders` (M11 native, app-owned, clean). Rather than write native
-- POs into the mirror (no source guard → nightly clobber risk), keep BOTH and let
-- the P13 operational layer (receiving, commitments) attach to EITHER:
--   • a native PO  → purchase_orders / purchase_order_lines
--   • a mirrored PO → tanda_pos / po_line_items  (parallel-run tracking)
--
-- This adds the nullable native FKs + an exactly-one CHECK to the receipt +
-- commitment tables. All three tables are empty in prod, so the new CHECKs
-- validate against zero rows. Idempotent.

-- ─── tanda_po_receipts: accept a native purchase_orders ref ───────────────────
ALTER TABLE tanda_po_receipts
  ADD COLUMN IF NOT EXISTS purchase_order_id uuid REFERENCES purchase_orders(id) ON DELETE RESTRICT;
ALTER TABLE tanda_po_receipts ALTER COLUMN tanda_po_id DROP NOT NULL;
ALTER TABLE tanda_po_receipts DROP CONSTRAINT IF EXISTS tanda_po_receipts_one_po_ref;
ALTER TABLE tanda_po_receipts ADD CONSTRAINT tanda_po_receipts_one_po_ref
  CHECK ((tanda_po_id IS NOT NULL)::int + (purchase_order_id IS NOT NULL)::int = 1);
CREATE INDEX IF NOT EXISTS idx_tanda_po_receipts_purchase_order ON tanda_po_receipts (purchase_order_id) WHERE purchase_order_id IS NOT NULL;
COMMENT ON COLUMN tanda_po_receipts.purchase_order_id IS 'P13/C0 — native PO ref (purchase_orders). Exactly one of (tanda_po_id, purchase_order_id) is set.';

-- ─── tanda_po_receipt_lines: accept a native purchase_order_lines ref ─────────
ALTER TABLE tanda_po_receipt_lines
  ADD COLUMN IF NOT EXISTS purchase_order_line_id uuid REFERENCES purchase_order_lines(id) ON DELETE RESTRICT;
ALTER TABLE tanda_po_receipt_lines ALTER COLUMN po_line_item_id DROP NOT NULL;
ALTER TABLE tanda_po_receipt_lines DROP CONSTRAINT IF EXISTS tanda_po_receipt_lines_one_po_ref;
ALTER TABLE tanda_po_receipt_lines ADD CONSTRAINT tanda_po_receipt_lines_one_po_ref
  CHECK ((po_line_item_id IS NOT NULL)::int + (purchase_order_line_id IS NOT NULL)::int = 1);
CREATE INDEX IF NOT EXISTS idx_tanda_po_receipt_lines_native ON tanda_po_receipt_lines (purchase_order_line_id) WHERE purchase_order_line_id IS NOT NULL;

-- ─── po_commitments: open-PO tracking for native POs too ──────────────────────
ALTER TABLE po_commitments
  ADD COLUMN IF NOT EXISTS purchase_order_id uuid REFERENCES purchase_orders(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS purchase_order_line_id uuid REFERENCES purchase_order_lines(id) ON DELETE CASCADE;
ALTER TABLE po_commitments ALTER COLUMN po_id DROP NOT NULL;
ALTER TABLE po_commitments DROP CONSTRAINT IF EXISTS po_commitments_one_po_ref;
ALTER TABLE po_commitments ADD CONSTRAINT po_commitments_one_po_ref
  CHECK ((po_id IS NOT NULL)::int + (purchase_order_id IS NOT NULL)::int = 1);
CREATE INDEX IF NOT EXISTS idx_po_commitments_native ON po_commitments (purchase_order_id) WHERE purchase_order_id IS NOT NULL;
COMMENT ON COLUMN po_commitments.purchase_order_id IS 'P13/C0 — native PO ref. Exactly one of (po_id [legacy tanda_pos], purchase_order_id [native]) is set.';

NOTIFY pgrst, 'reload schema';
