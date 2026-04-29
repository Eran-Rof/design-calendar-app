-- 20260424000000_attachments.sql
--
-- Generic attachments table — one row per file attached to any entity.
-- Replaces the single-slot file_url columns on invoices, shipments,
-- po_messages, disputes, etc. by letting every record own many files.
--
-- Entity_type is an enum'd text so we don't add a FK per target; RLS
-- scopes rows to the caller's vendor_id for authenticated users.

CREATE TABLE IF NOT EXISTS attachments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type          text NOT NULL CHECK (entity_type IN (
                         'invoice','shipment','po','po_message','dispute',
                         'contract','compliance_document','rfq_quote','bulk_operation'
                       )),
  entity_id            uuid NOT NULL,
  vendor_id            uuid REFERENCES vendors(id) ON DELETE CASCADE,
  file_url             text NOT NULL,            -- Supabase Storage path
  file_description     text,                     -- user-supplied label
  filename             text,                     -- display name
  uploaded_by_auth_id  uuid,
  uploaded_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);

CREATE INDEX IF NOT EXISTS idx_attachments_entity
  ON attachments (entity_type, entity_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_attachments_vendor
  ON attachments (vendor_id)
  WHERE deleted_at IS NULL;

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;

-- anon (internal apps / service role) — full access
DROP POLICY IF EXISTS "anon_all_attachments" ON attachments;
CREATE POLICY "anon_all_attachments" ON attachments
  FOR ALL TO anon USING (true) WITH CHECK (true);

-- authenticated (vendor JWT) — only own vendor's rows
DROP POLICY IF EXISTS "vendor_rw_own_attachments" ON attachments;
CREATE POLICY "vendor_rw_own_attachments" ON attachments
  FOR ALL TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()))
  WITH CHECK (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));
