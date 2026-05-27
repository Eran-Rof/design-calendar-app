-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P2 / Chunk 5 / Migration 1
-- M29 Document Management - schema for documents + document_versions.
--
-- Per docs/tangerine/P2-cross-cutters-architecture.md §6.
--
-- Generic reusable attachment system: any (context_table, context_id) can
-- have any number of documents linked. A document has versions; the latest
-- is the canonical one. Bytes live in Supabase Storage; this schema only
-- stores metadata + storage paths.
--
-- The Supabase Storage bucket itself ('tangerine-documents') is provisioned
-- via the Supabase Dashboard (the SQL admin role here does not own
-- storage.buckets). A follow-up note in MIGRATIONS.md documents the
-- one-time bucket creation + policies.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS documents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  context_table        text NOT NULL,
  context_id           uuid NOT NULL,
  kind                 text NOT NULL,
  title                text NOT NULL,
  current_version_id   uuid,
  is_archived          boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_entity_context
  ON documents (entity_id, context_table, context_id);
CREATE INDEX IF NOT EXISTS idx_documents_kind
  ON documents (kind);
CREATE INDEX IF NOT EXISTS idx_documents_active
  ON documents (entity_id, is_archived);

COMMENT ON TABLE  documents IS 'Reusable attachment metadata. Any (context_table, context_id) can have any number of documents. Bytes are in Supabase Storage bucket "tangerine-documents". current_version_id is the canonical version.';
COMMENT ON COLUMN documents.kind IS 'Free-form (contract, w9, packing_list, signed_po, ...). Open vocabulary - no enum.';

CREATE TABLE IF NOT EXISTS document_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id          uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_number       int NOT NULL,
  storage_path         text NOT NULL,
  mime_type            text NOT NULL,
  byte_size            bigint NOT NULL,
  sha256_hex           text NOT NULL,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT document_versions_unique UNIQUE (document_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_document_versions_doc
  ON document_versions (document_id);

-- Now that document_versions exists, add the FK back to documents.current_version_id.
ALTER TABLE documents
  ADD CONSTRAINT documents_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES document_versions(id) ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

COMMENT ON TABLE document_versions IS 'Versions of a document. Each upload creates a new row; documents.current_version_id is updated atomically. storage_path points at the file in Supabase Storage bucket "tangerine-documents".';

-- ════════════════════════════════════════════════════════════════════════════
-- RLS - P1 template (anon_all + auth_internal_*)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE documents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_documents" ON documents
  FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_document_versions" ON document_versions
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_internal_documents" ON documents
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

CREATE POLICY "auth_internal_document_versions" ON document_versions
  FOR ALL TO authenticated
  USING (document_id IN (
    SELECT d.id FROM documents d
    JOIN entity_users eu ON eu.entity_id = d.entity_id
    WHERE eu.auth_id = auth.uid()
  ))
  WITH CHECK (document_id IN (
    SELECT d.id FROM documents d
    JOIN entity_users eu ON eu.entity_id = d.entity_id
    WHERE eu.auth_id = auth.uid()
  ));

-- Touch trigger on documents
CREATE OR REPLACE FUNCTION documents_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS documents_touch_trg ON documents;
CREATE TRIGGER documents_touch_trg
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_touch();
