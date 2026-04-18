-- 20260417100000_po_acknowledgments.sql
--
-- Phase 1.5 — vendor-facing PO acknowledgement log.
--
-- tanda_pos rows are synced from Xoro and keyed by po_number; there is no
-- stable uuid FK we can trust against Xoro churn. So po_id here is a soft
-- pointer (uuid matching tanda_pos.id at insert-time). vendor_user_id is a
-- hard FK so we can always identify who acknowledged what.
--
-- RLS mirrors the Phase 0 pattern: anon-permissive so the internal TandA
-- Shipments tab can read across vendors, authenticated-scoped so vendor
-- logins only see/insert rows tied to their own vendor_users row.

CREATE TABLE IF NOT EXISTS po_acknowledgments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id            uuid NOT NULL,
  vendor_user_id   uuid NOT NULL
                     REFERENCES vendor_users(id) ON DELETE CASCADE,
  acknowledged_at  timestamptz NOT NULL DEFAULT now(),
  note             text
);

CREATE INDEX IF NOT EXISTS idx_po_ack_po_id
  ON po_acknowledgments (po_id);

CREATE INDEX IF NOT EXISTS idx_po_ack_vendor_user_id
  ON po_acknowledgments (vendor_user_id);

-- One acknowledgement per (po, vendor_user); a second click is a no-op upsert.
CREATE UNIQUE INDEX IF NOT EXISTS uq_po_ack_po_vu
  ON po_acknowledgments (po_id, vendor_user_id);

ALTER TABLE po_acknowledgments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_po_ack" ON po_acknowledgments;
CREATE POLICY "anon_all_po_ack" ON po_acknowledgments
  FOR ALL TO anon
  USING (true)
  WITH CHECK (true);

-- Vendor logins can read their own acknowledgement rows.
DROP POLICY IF EXISTS "vendor_own_po_ack_select" ON po_acknowledgments;
CREATE POLICY "vendor_own_po_ack_select" ON po_acknowledgments
  FOR SELECT TO authenticated
  USING (
    vendor_user_id IN (
      SELECT vu.id FROM vendor_users vu WHERE vu.auth_id = auth.uid()
    )
  );

-- Vendor logins can insert only rows owned by their own vendor_users row.
DROP POLICY IF EXISTS "vendor_own_po_ack_insert" ON po_acknowledgments;
CREATE POLICY "vendor_own_po_ack_insert" ON po_acknowledgments
  FOR INSERT TO authenticated
  WITH CHECK (
    vendor_user_id IN (
      SELECT vu.id FROM vendor_users vu WHERE vu.auth_id = auth.uid()
    )
  );
