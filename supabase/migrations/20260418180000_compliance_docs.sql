-- 20260418180000_compliance_docs.sql
--
-- Phase 3.1 — compliance document management.
--
-- Aligned to the spec's field naming (document_type_id, file_url,
-- expiry_date, expiry_required, required, reminder_days_before) while
-- keeping a few operationally-useful columns (file_size_bytes,
-- file_mime_type, issued_at, rejection_reason, uploaded_by, extra
-- status values 'expired'/'superseded').
--
-- Files live in Supabase Storage bucket 'vendor-docs' at path
-- '<vendor_id>/<doc_id>/<filename>'; file_url holds that path and is
-- resolved to a signed URL on read.
--
-- reviewed_by is text (not a uuid FK) because internal users live in
-- app_data['users'] (custom auth), not auth.users.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. compliance_document_types
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS compliance_document_types (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  text UNIQUE NOT NULL,
  name                  text NOT NULL,
  description           text,
  required              boolean NOT NULL DEFAULT true,   -- is this doc required for an active vendor
  expiry_required       boolean NOT NULL DEFAULT true,   -- does expiry_date apply
  reminder_days_before  integer NOT NULL DEFAULT 30,     -- days before expiry to remind
  sort_order            integer NOT NULL DEFAULT 100,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);

INSERT INTO compliance_document_types (code, name, description, required, expiry_required, reminder_days_before, sort_order) VALUES
  ('insurance_coi',  'Certificate of Insurance (COI)',     'General liability, usually renewed annually.',       true,  true,  30,  10),
  ('w9',             'W-9 / Tax ID form',                   'US vendor tax identification. No expiry.',           true,  false, 30,  20),
  ('iso_9001',       'ISO 9001 certification',              'Quality management system.',                          false, true,  30,  30),
  ('iso_14001',      'ISO 14001 certification',             'Environmental management.',                           false, true,  30,  40),
  ('social_audit',   'Social compliance audit',             'SA8000, SMETA, BSCI, or equivalent.',                 true,  true,  60,  50),
  ('factory_audit',  'Factory audit report',                'WRAP, Sedex, or buyer-specific audit.',               true,  true,  60,  60),
  ('coo_master',     'Country-of-origin master certificate','Blanket COO declaration for the program.',            true,  true,  30,  70),
  ('fiber_content',  'Fiber content affidavit',             'Textile labeling compliance.',                        false, false, 30,  80),
  ('prop65',         'Proposition 65 compliance',           'California chemical warnings.',                       false, false, 30,  90),
  ('cpsia',          'CPSIA / children''s product cert.',   'Consumer product safety, required for kids items.',   false, true,  30,  100),
  ('carb',           'CARB compliance',                     'California Air Resources Board for wood products.',   false, true,  30,  110),
  ('bank_info',      'Banking / payment details',           'ACH/wire instructions for payment.',                  true,  false, 30,  120),
  ('diversity',      'Diversity certification',             'Minority/women/veteran-owned business certification.',false, true,  30,  125),
  ('nda',            'NDA / confidentiality agreement',     'Signed NDA between ROF and vendor.',                  true,  false, 30,  130)
ON CONFLICT (code) DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════
-- 2. compliance_documents
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS compliance_documents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id            uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  document_type_id     uuid NOT NULL REFERENCES compliance_document_types(id) ON DELETE RESTRICT,

  file_url             text NOT NULL,
  file_name            text,
  file_size_bytes      bigint,
  file_mime_type       text,

  issued_at            date,
  expiry_date          date,

  status               text NOT NULL DEFAULT 'pending_review'
                         CHECK (status IN ('pending_review', 'approved', 'rejected', 'expired', 'superseded')),
  rejection_reason     text,
  reviewed_by          text,
  reviewed_at          timestamptz,

  uploaded_by          uuid REFERENCES vendor_users(id) ON DELETE SET NULL,
  uploaded_at          timestamptz NOT NULL DEFAULT now(),
  notes                text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compliance_documents_vendor_id        ON compliance_documents (vendor_id);
CREATE INDEX IF NOT EXISTS idx_compliance_documents_document_type_id ON compliance_documents (document_type_id);
CREATE INDEX IF NOT EXISTS idx_compliance_documents_status           ON compliance_documents (status);
CREATE INDEX IF NOT EXISTS idx_compliance_documents_expiry           ON compliance_documents (expiry_date) WHERE expiry_date IS NOT NULL;

CREATE OR REPLACE FUNCTION mark_expired_compliance_docs() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  UPDATE compliance_documents
  SET    status = 'expired', updated_at = now()
  WHERE  status IN ('pending_review', 'approved')
    AND  expiry_date IS NOT NULL
    AND  expiry_date < CURRENT_DATE;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END; $$;

-- ══════════════════════════════════════════════════════════════════════════
-- 3. RLS
-- ══════════════════════════════════════════════════════════════════════════
ALTER TABLE compliance_document_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_documents      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "all_read_compliance_types" ON compliance_document_types;
CREATE POLICY "all_read_compliance_types" ON compliance_document_types
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_all_compliance_types" ON compliance_document_types;
CREATE POLICY "anon_all_compliance_types" ON compliance_document_types
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_all_compliance_documents" ON compliance_documents;
CREATE POLICY "anon_all_compliance_documents" ON compliance_documents
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "vendor_own_compliance_documents_select" ON compliance_documents;
CREATE POLICY "vendor_own_compliance_documents_select" ON compliance_documents
  FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "vendor_own_compliance_documents_insert" ON compliance_documents;
CREATE POLICY "vendor_own_compliance_documents_insert" ON compliance_documents
  FOR INSERT TO authenticated
  WITH CHECK (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "vendor_own_compliance_documents_update" ON compliance_documents;
CREATE POLICY "vendor_own_compliance_documents_update" ON compliance_documents
  FOR UPDATE TO authenticated
  USING (
    vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
    AND status IN ('pending_review', 'rejected')
  )
  WITH CHECK (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- ══════════════════════════════════════════════════════════════════════════
-- 4. Storage bucket + policies
-- ══════════════════════════════════════════════════════════════════════════
INSERT INTO storage.buckets (id, name, public)
VALUES ('vendor-docs', 'vendor-docs', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "anon_all_vendor_docs_objects" ON storage.objects;
CREATE POLICY "anon_all_vendor_docs_objects" ON storage.objects
  FOR ALL TO anon
  USING (bucket_id = 'vendor-docs')
  WITH CHECK (bucket_id = 'vendor-docs');

DROP POLICY IF EXISTS "vendor_own_vendor_docs_select" ON storage.objects;
CREATE POLICY "vendor_own_vendor_docs_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'vendor-docs'
    AND (storage.foldername(name))[1] IN (SELECT vu.vendor_id::text FROM vendor_users vu WHERE vu.auth_id = auth.uid())
  );

DROP POLICY IF EXISTS "vendor_own_vendor_docs_insert" ON storage.objects;
CREATE POLICY "vendor_own_vendor_docs_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'vendor-docs'
    AND (storage.foldername(name))[1] IN (SELECT vu.vendor_id::text FROM vendor_users vu WHERE vu.auth_id = auth.uid())
  );

DROP POLICY IF EXISTS "vendor_own_vendor_docs_update" ON storage.objects;
CREATE POLICY "vendor_own_vendor_docs_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'vendor-docs'
    AND (storage.foldername(name))[1] IN (SELECT vu.vendor_id::text FROM vendor_users vu WHERE vu.auth_id = auth.uid())
  );
