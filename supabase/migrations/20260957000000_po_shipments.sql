-- PO shipments (ASN / in-transit overlay).
--
-- 'in transit' is NOT an order-lifecycle status — a PO's lifecycle is
-- draft → issued → partially_received → received/cancelled. In-transit is a
-- SEPARATE dimension: goods physically on the water/air. A PO can therefore be
-- "issued · in transit" or "partially received · in transit" at the same time.
-- That overlay is modelled as one-or-more shipment records (buyer-entered in
-- Tangerine, or later a vendor ASN), each carrying carrier/tracking/ETA and the
-- per-line quantities on the way. A PO is "in transit" whenever it has ≥1
-- shipment still in status 'in_transit'.
CREATE TABLE IF NOT EXISTS po_shipments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL DEFAULT rof_entity_id(),
  purchase_order_id  uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  status             text NOT NULL DEFAULT 'in_transit' CHECK (status IN ('in_transit','arrived','cancelled')),
  source             text NOT NULL DEFAULT 'buyer'      CHECK (source IN ('buyer','vendor_asn')),
  ship_method        text CHECK (ship_method IS NULL OR ship_method IN ('sea','air','ground')),
  carrier            text,
  tracking_number    text,
  asn_ref            text,
  shipped_date       date,
  eta                date,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid
);
CREATE INDEX IF NOT EXISTS idx_po_shipments_po ON po_shipments(purchase_order_id);
-- Fast "is this PO in transit?" lookup for the grid overlay.
CREATE INDEX IF NOT EXISTS idx_po_shipments_active ON po_shipments(purchase_order_id) WHERE status = 'in_transit';

CREATE TABLE IF NOT EXISTS po_shipment_lines (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id             uuid NOT NULL REFERENCES po_shipments(id) ON DELETE CASCADE,
  purchase_order_line_id  uuid NOT NULL REFERENCES purchase_order_lines(id) ON DELETE CASCADE,
  qty_in_transit          numeric NOT NULL DEFAULT 0 CHECK (qty_in_transit >= 0)
);
CREATE INDEX IF NOT EXISTS idx_po_shipment_lines_shipment ON po_shipment_lines(shipment_id);

-- Anon-read RLS to match the other PO tables (writes go through service-role).
ALTER TABLE po_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE po_shipment_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS po_shipments_read ON po_shipments;
CREATE POLICY po_shipments_read ON po_shipments FOR SELECT USING (true);
DROP POLICY IF EXISTS po_shipment_lines_read ON po_shipment_lines;
CREATE POLICY po_shipment_lines_read ON po_shipment_lines FOR SELECT USING (true);
