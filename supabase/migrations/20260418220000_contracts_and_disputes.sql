-- 20260418220000_contracts_and_disputes.sql
--
-- Phase 5 part A — contracts, contract_versions, disputes, dispute_messages.
-- Plus Storage bucket 'vendor-contracts' for signed/unsigned PDFs.
--
-- Design notes:
--   • 'internal user' references are text (not FK) because internal users
--     live in app_data['users'], not auth.users — same pattern as
--     compliance_documents.reviewed_by.
--   • Contracts are internal-owned: vendors see and can counter-sign (add
--     a new version with uploaded_by_type='vendor'), but cannot modify the
--     contract header.
--   • Disputes can be raised by either side; dispute_messages mirrors the
--     po_messages sender split.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. contracts
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS contracts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id         uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  title             text NOT NULL,
  description       text,
  status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'sent', 'under_review', 'signed', 'expired', 'terminated')),
  contract_type     text NOT NULL
                      CHECK (contract_type IN ('master_services', 'nda', 'sow', 'amendment')),
  start_date        date,
  end_date          date,
  value             numeric,
  currency          text NOT NULL DEFAULT 'USD',
  file_url          text,
  signed_file_url   text,
  signed_at         timestamptz,
  signed_by_vendor  uuid REFERENCES vendor_users(id) ON DELETE SET NULL,
  internal_owner    text,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contracts_vendor_id  ON contracts (vendor_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status     ON contracts (status);
CREATE INDEX IF NOT EXISTS idx_contracts_end_date   ON contracts (end_date) WHERE end_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contracts_type       ON contracts (contract_type);

-- ══════════════════════════════════════════════════════════════════════════
-- 2. contract_versions
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS contract_versions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id                uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  version_number             integer NOT NULL,
  file_url                   text NOT NULL,
  notes                      text,
  uploaded_by_type           text NOT NULL CHECK (uploaded_by_type IN ('vendor', 'internal')),
  uploaded_by_vendor_user_id uuid REFERENCES vendor_users(id) ON DELETE SET NULL,
  uploaded_by_internal_id    text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_contract_version_uploader CHECK (
    (uploaded_by_type = 'vendor'   AND uploaded_by_vendor_user_id IS NOT NULL AND uploaded_by_internal_id IS NULL)
 OR (uploaded_by_type = 'internal' AND uploaded_by_internal_id    IS NOT NULL AND uploaded_by_vendor_user_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_versions_contract_version ON contract_versions (contract_id, version_number);
CREATE INDEX IF NOT EXISTS idx_contract_versions_contract_id ON contract_versions (contract_id, created_at DESC);

-- ══════════════════════════════════════════════════════════════════════════
-- 3. disputes
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS disputes (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id                 uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  invoice_id                uuid REFERENCES invoices(id) ON DELETE SET NULL,
  po_id                     uuid REFERENCES tanda_pos(uuid_id) ON DELETE SET NULL,
  type                      text NOT NULL CHECK (type IN ('invoice_discrepancy', 'payment_delay', 'damaged_goods', 'other')),
  status                    text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'under_review', 'resolved', 'closed')),
  priority                  text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  subject                   text NOT NULL,
  resolution                text,
  resolved_at               timestamptz,
  resolved_by               text,
  raised_by_type            text NOT NULL DEFAULT 'vendor' CHECK (raised_by_type IN ('vendor', 'internal')),
  raised_by_vendor_user_id  uuid REFERENCES vendor_users(id) ON DELETE SET NULL,
  raised_by_internal_id     text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_disputes_vendor_id  ON disputes (vendor_id);
CREATE INDEX IF NOT EXISTS idx_disputes_invoice_id ON disputes (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_disputes_po_id      ON disputes (po_id) WHERE po_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_disputes_status     ON disputes (status);
CREATE INDEX IF NOT EXISTS idx_disputes_priority   ON disputes (priority);

-- ══════════════════════════════════════════════════════════════════════════
-- 4. dispute_messages
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS dispute_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id          uuid NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  sender_type         text NOT NULL CHECK (sender_type IN ('vendor', 'internal')),
  sender_auth_id      uuid,
  sender_internal_id  text,
  sender_name         text NOT NULL,
  body                text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_dispute_messages_sender CHECK (
    (sender_type = 'vendor'   AND sender_auth_id IS NOT NULL AND sender_internal_id IS NULL)
 OR (sender_type = 'internal' AND sender_internal_id IS NOT NULL AND sender_auth_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_dispute_messages_dispute_id ON dispute_messages (dispute_id, created_at DESC);

-- ══════════════════════════════════════════════════════════════════════════
-- 5. RLS
-- ══════════════════════════════════════════════════════════════════════════
ALTER TABLE contracts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE disputes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispute_messages   ENABLE ROW LEVEL SECURITY;

-- contracts: internal writes, vendor reads own
DROP POLICY IF EXISTS "anon_all_contracts" ON contracts;
CREATE POLICY "anon_all_contracts" ON contracts FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_contracts_select" ON contracts;
CREATE POLICY "vendor_own_contracts_select" ON contracts FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- contract_versions: vendor can read + insert versions for their contracts
DROP POLICY IF EXISTS "anon_all_contract_versions" ON contract_versions;
CREATE POLICY "anon_all_contract_versions" ON contract_versions FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_contract_versions_select" ON contract_versions;
CREATE POLICY "vendor_own_contract_versions_select" ON contract_versions FOR SELECT TO authenticated
  USING (contract_id IN (SELECT c.id FROM contracts c
    WHERE c.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())));
DROP POLICY IF EXISTS "vendor_own_contract_versions_insert" ON contract_versions;
CREATE POLICY "vendor_own_contract_versions_insert" ON contract_versions FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by_type = 'vendor'
    AND contract_id IN (SELECT c.id FROM contracts c
      WHERE c.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()))
  );

-- disputes: vendor can read + create their own; update only while open (can't self-resolve)
DROP POLICY IF EXISTS "anon_all_disputes" ON disputes;
CREATE POLICY "anon_all_disputes" ON disputes FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_disputes_select" ON disputes;
CREATE POLICY "vendor_own_disputes_select" ON disputes FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));
DROP POLICY IF EXISTS "vendor_own_disputes_insert" ON disputes;
CREATE POLICY "vendor_own_disputes_insert" ON disputes FOR INSERT TO authenticated
  WITH CHECK (
    raised_by_type = 'vendor'
    AND vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
  );
DROP POLICY IF EXISTS "vendor_own_disputes_update_while_open" ON disputes;
CREATE POLICY "vendor_own_disputes_update_while_open" ON disputes FOR UPDATE TO authenticated
  USING (
    status = 'open'
    AND vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
  );

-- dispute_messages: both sides post; vendors read own disputes' messages
DROP POLICY IF EXISTS "anon_all_dispute_messages" ON dispute_messages;
CREATE POLICY "anon_all_dispute_messages" ON dispute_messages FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "vendor_own_dispute_messages_select" ON dispute_messages;
CREATE POLICY "vendor_own_dispute_messages_select" ON dispute_messages FOR SELECT TO authenticated
  USING (dispute_id IN (SELECT d.id FROM disputes d
    WHERE d.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())));
DROP POLICY IF EXISTS "vendor_own_dispute_messages_insert" ON dispute_messages;
CREATE POLICY "vendor_own_dispute_messages_insert" ON dispute_messages FOR INSERT TO authenticated
  WITH CHECK (
    sender_type = 'vendor'
    AND sender_auth_id = auth.uid()
    AND dispute_id IN (SELECT d.id FROM disputes d
      WHERE d.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()))
  );

-- ══════════════════════════════════════════════════════════════════════════
-- 6. Storage bucket for contract PDFs
-- ══════════════════════════════════════════════════════════════════════════
INSERT INTO storage.buckets (id, name, public) VALUES ('vendor-contracts', 'vendor-contracts', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "anon_all_vendor_contracts_objects" ON storage.objects;
CREATE POLICY "anon_all_vendor_contracts_objects" ON storage.objects FOR ALL TO anon
  USING (bucket_id = 'vendor-contracts') WITH CHECK (bucket_id = 'vendor-contracts');

DROP POLICY IF EXISTS "vendor_own_vendor_contracts_select" ON storage.objects;
CREATE POLICY "vendor_own_vendor_contracts_select" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'vendor-contracts'
    AND (storage.foldername(name))[1] IN (SELECT vu.vendor_id::text FROM vendor_users vu WHERE vu.auth_id = auth.uid())
  );

DROP POLICY IF EXISTS "vendor_own_vendor_contracts_insert" ON storage.objects;
CREATE POLICY "vendor_own_vendor_contracts_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'vendor-contracts'
    AND (storage.foldername(name))[1] IN (SELECT vu.vendor_id::text FROM vendor_users vu WHERE vu.auth_id = auth.uid())
  );
