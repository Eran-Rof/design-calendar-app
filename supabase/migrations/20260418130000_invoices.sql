-- 20260418130000_invoices.sql
--
-- Phase 2.2 — invoice tables + line items + wire up shipments.invoice_id FK.
--
-- Design choices:
--   • invoices.po_id references tanda_pos.uuid_id (same pattern as shipments).
--   • invoice_line_items.po_line_item_id references po_line_items.id — this
--     is what makes the 3-way match engine (Phase 2.5) possible: join
--     po_line_items + shipment_lines + invoice_line_items on po_line_item_id
--     and you can compute ordered-vs-received-vs-invoiced quantity drift.
--   • approved_by is plain text (not a FK) — internal users live in a JSON
--     blob in app_data['users'], not auth.users.
--   • xoro_ap_id / xoro_last_synced_at reserve space for the Phase 2.7
--     Xoro AP sync so we can write a single 'paid' signal back to the invoice.
--
-- Vendors can INSERT invoices (status='submitted') and UPDATE only while
-- still in 'submitted' status (to fix typos before internal review). Once
-- moved to 'under_review' or later, only internal (anon) can modify.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. invoices
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS invoices (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id               uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  po_id                   uuid REFERENCES tanda_pos(uuid_id) ON DELETE SET NULL,
  invoice_number          text NOT NULL,
  invoice_date            date,
  due_date                date,
  subtotal                numeric,
  tax                     numeric,
  total                   numeric,
  currency                text NOT NULL DEFAULT 'USD',
  status                  text NOT NULL DEFAULT 'submitted'
                            CHECK (status IN ('submitted', 'under_review', 'approved', 'paid', 'rejected', 'disputed')),
  file_url                text,
  submitted_by            uuid REFERENCES vendor_users(id) ON DELETE SET NULL,
  submitted_at            timestamptz NOT NULL DEFAULT now(),
  approved_at             timestamptz,
  approved_by             text,
  paid_at                 timestamptz,
  payment_reference       text,
  payment_method          text,
  rejection_reason        text,
  notes                   text,
  xoro_ap_id              text,
  xoro_last_synced_at     timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_vendor_number ON invoices (vendor_id, invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_vendor_id ON invoices (vendor_id);
CREATE INDEX IF NOT EXISTS idx_invoices_po_id     ON invoices (po_id) WHERE po_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_status    ON invoices (status);
CREATE INDEX IF NOT EXISTS idx_invoices_xoro_ap_id ON invoices (xoro_ap_id) WHERE xoro_ap_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════
-- 2. invoice_line_items
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS invoice_line_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id            uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  po_line_item_id       uuid REFERENCES po_line_items(id) ON DELETE SET NULL,
  line_index            integer NOT NULL,
  description           text,
  quantity_invoiced     numeric,
  unit_price            numeric,
  line_total            numeric,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_line_items_line
  ON invoice_line_items (invoice_id, line_index);
CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice_id     ON invoice_line_items (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_line_items_po_line_item_id ON invoice_line_items (po_line_item_id);

-- ══════════════════════════════════════════════════════════════════════════
-- 3. Deferred FK on shipments.invoice_id (Phase 2.1 left it as bare uuid)
-- ══════════════════════════════════════════════════════════════════════════
ALTER TABLE shipments DROP CONSTRAINT IF EXISTS shipments_invoice_id_fkey;
ALTER TABLE shipments ADD CONSTRAINT shipments_invoice_id_fkey
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;

-- ══════════════════════════════════════════════════════════════════════════
-- 4. RLS
-- ══════════════════════════════════════════════════════════════════════════
ALTER TABLE invoices           ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items ENABLE ROW LEVEL SECURITY;

-- invoices
DROP POLICY IF EXISTS "anon_all_invoices" ON invoices;
CREATE POLICY "anon_all_invoices" ON invoices
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "vendor_own_invoices_select" ON invoices;
CREATE POLICY "vendor_own_invoices_select" ON invoices
  FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "vendor_own_invoices_insert" ON invoices;
CREATE POLICY "vendor_own_invoices_insert" ON invoices
  FOR INSERT TO authenticated
  WITH CHECK (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- Vendors can update their own invoices only while status='submitted'.
DROP POLICY IF EXISTS "vendor_own_invoices_update_while_submitted" ON invoices;
CREATE POLICY "vendor_own_invoices_update_while_submitted" ON invoices
  FOR UPDATE TO authenticated
  USING (
    status = 'submitted'
    AND vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
  )
  WITH CHECK (
    status = 'submitted'
    AND vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
  );

-- invoice_line_items
DROP POLICY IF EXISTS "anon_all_invoice_line_items" ON invoice_line_items;
CREATE POLICY "anon_all_invoice_line_items" ON invoice_line_items
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "vendor_own_invoice_line_items_select" ON invoice_line_items;
CREATE POLICY "vendor_own_invoice_line_items_select" ON invoice_line_items
  FOR SELECT TO authenticated
  USING (
    invoice_id IN (
      SELECT i.id FROM invoices i
      WHERE i.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "vendor_own_invoice_line_items_insert" ON invoice_line_items;
CREATE POLICY "vendor_own_invoice_line_items_insert" ON invoice_line_items
  FOR INSERT TO authenticated
  WITH CHECK (
    invoice_id IN (
      SELECT i.id FROM invoices i
      WHERE i.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
        AND i.status = 'submitted'
    )
  );

DROP POLICY IF EXISTS "vendor_own_invoice_line_items_update" ON invoice_line_items;
CREATE POLICY "vendor_own_invoice_line_items_update" ON invoice_line_items
  FOR UPDATE TO authenticated
  USING (
    invoice_id IN (
      SELECT i.id FROM invoices i
      WHERE i.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
        AND i.status = 'submitted'
    )
  );
