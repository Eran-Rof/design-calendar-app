-- 20260418140000_receipts.sql
--
-- Phase 2.3 — receipts + receipt_line_items. Rows are populated by a sync
-- from Xoro (not manual entry) — the 3PL sends EDI → Xoro records the
-- receipt → we pull it in. No direct vendor write path here.
--
-- Receipt → PO → line joins power the 3-way match engine: PO line qty
-- (tanda_pos) vs. shipment line qty (vendor ASN) vs. receipt line qty
-- (warehouse EDI) vs. invoice line qty (vendor invoice).
--
-- Xoro is the source of truth. `xoro_receipt_id` is the unique external
-- reference we dedupe on.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. receipts
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS receipts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id             uuid REFERENCES vendors(id) ON DELETE RESTRICT,
  po_id                 uuid REFERENCES tanda_pos(uuid_id) ON DELETE SET NULL,
  shipment_id           uuid REFERENCES shipments(id) ON DELETE SET NULL,
  receipt_number        text,
  xoro_receipt_id       text UNIQUE,
  received_date         timestamptz,
  received_by           text,           -- 3PL reference (warehouse code / user)
  warehouse_locode      text,
  carrier_tracking_ref  text,
  status                text NOT NULL DEFAULT 'received'
                          CHECK (status IN ('received', 'partial', 'exception', 'voided')),
  notes                 text,
  raw_payload           jsonb,          -- full Xoro payload for audit / replay
  xoro_synced_at        timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_receipts_vendor_id       ON receipts (vendor_id);
CREATE INDEX IF NOT EXISTS idx_receipts_po_id           ON receipts (po_id);
CREATE INDEX IF NOT EXISTS idx_receipts_shipment_id     ON receipts (shipment_id);
CREATE INDEX IF NOT EXISTS idx_receipts_received_date   ON receipts (received_date DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_status          ON receipts (status);

-- ══════════════════════════════════════════════════════════════════════════
-- 2. receipt_line_items
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS receipt_line_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id           uuid NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  po_line_item_id      uuid REFERENCES po_line_items(id) ON DELETE SET NULL,
  line_index           integer NOT NULL,
  item_number          text,
  description          text,
  quantity_received    numeric NOT NULL,
  condition            text CHECK (condition IN ('good', 'damaged', 'short', 'over') OR condition IS NULL),
  notes                text,
  raw_json             jsonb,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_receipt_line_items_line
  ON receipt_line_items (receipt_id, line_index);
CREATE INDEX IF NOT EXISTS idx_receipt_line_items_receipt_id     ON receipt_line_items (receipt_id);
CREATE INDEX IF NOT EXISTS idx_receipt_line_items_po_line_item_id ON receipt_line_items (po_line_item_id);
CREATE INDEX IF NOT EXISTS idx_receipt_line_items_item_number     ON receipt_line_items (item_number);

-- ══════════════════════════════════════════════════════════════════════════
-- 3. RLS
-- ══════════════════════════════════════════════════════════════════════════
ALTER TABLE receipts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipt_line_items  ENABLE ROW LEVEL SECURITY;

-- Internal (anon) has full access — sync writes here, TandA UI reads.
DROP POLICY IF EXISTS "anon_all_receipts" ON receipts;
CREATE POLICY "anon_all_receipts" ON receipts
  FOR ALL TO anon USING (true) WITH CHECK (true);

-- Vendors SELECT only receipts for their own POs (read-only; they never
-- insert — receipts come from Xoro).
DROP POLICY IF EXISTS "vendor_own_receipts_select" ON receipts;
CREATE POLICY "vendor_own_receipts_select" ON receipts
  FOR SELECT TO authenticated
  USING (
    vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
  );

DROP POLICY IF EXISTS "anon_all_receipt_line_items" ON receipt_line_items;
CREATE POLICY "anon_all_receipt_line_items" ON receipt_line_items
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "vendor_own_receipt_line_items_select" ON receipt_line_items;
CREATE POLICY "vendor_own_receipt_line_items_select" ON receipt_line_items
  FOR SELECT TO authenticated
  USING (
    receipt_id IN (
      SELECT r.id FROM receipts r
      WHERE r.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
    )
  );
