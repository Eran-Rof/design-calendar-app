-- 20260418100000_po_ack_use_po_number.sql
--
-- Fix: po_acknowledgments.po_id was declared uuid, but tanda_pos.id is integer
-- (the table predates our migrations; po_number is its stable identifier).
-- Switch the reference to po_number (text) — this also survives Xoro-driven
-- row churn since po_number is preserved across re-syncs.

-- Safe: po_acknowledgments has no rows yet (Phase 1 just went live today).
DROP TABLE IF EXISTS po_acknowledgments;

CREATE TABLE po_acknowledgments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number        text NOT NULL,
  vendor_user_id   uuid NOT NULL
                     REFERENCES vendor_users(id) ON DELETE CASCADE,
  acknowledged_at  timestamptz NOT NULL DEFAULT now(),
  note             text
);

CREATE INDEX idx_po_ack_po_number
  ON po_acknowledgments (po_number);

CREATE INDEX idx_po_ack_vendor_user_id
  ON po_acknowledgments (vendor_user_id);

-- One acknowledgement per (po_number, vendor_user); second click = no-op.
CREATE UNIQUE INDEX uq_po_ack_po_vu
  ON po_acknowledgments (po_number, vendor_user_id);

ALTER TABLE po_acknowledgments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_po_ack" ON po_acknowledgments
  FOR ALL TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "vendor_own_po_ack_select" ON po_acknowledgments
  FOR SELECT TO authenticated
  USING (
    vendor_user_id IN (
      SELECT vu.id FROM vendor_users vu WHERE vu.auth_id = auth.uid()
    )
  );

CREATE POLICY "vendor_own_po_ack_insert" ON po_acknowledgments
  FOR INSERT TO authenticated
  WITH CHECK (
    vendor_user_id IN (
      SELECT vu.id FROM vendor_users vu WHERE vu.auth_id = auth.uid()
    )
  );
