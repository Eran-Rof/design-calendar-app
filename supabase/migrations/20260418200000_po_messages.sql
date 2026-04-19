-- 20260418200000_po_messages.sql
--
-- Phase 3.2 — PO-linked messaging. All messages are scoped to a PO and
-- are visible to both the vendor (via vendor_users) and internal team.
-- Attachments live in Supabase Storage bucket 'po-messages' at path
-- '<po_id>/<message_id>/<filename>'.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. po_messages
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS po_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id               uuid NOT NULL REFERENCES tanda_pos(uuid_id) ON DELETE CASCADE,

  sender_type         text NOT NULL CHECK (sender_type IN ('vendor', 'internal')),
  sender_auth_id      uuid,                -- vendor_users.auth_id (when sender_type='vendor')
  sender_internal_id  text,                -- internal user id from app_data['users'] (when sender_type='internal')
  sender_name         text NOT NULL,       -- denormalised for display

  body                text NOT NULL,

  read_by_vendor      boolean NOT NULL DEFAULT false,
  read_by_internal    boolean NOT NULL DEFAULT false,

  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_po_messages_sender CHECK (
    (sender_type = 'vendor'   AND sender_auth_id     IS NOT NULL AND sender_internal_id IS NULL)
 OR (sender_type = 'internal' AND sender_internal_id IS NOT NULL AND sender_auth_id     IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_po_messages_po_id           ON po_messages (po_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_po_messages_sender_auth_id  ON po_messages (sender_auth_id) WHERE sender_auth_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_po_messages_unread_vendor   ON po_messages (po_id) WHERE read_by_vendor = false;
CREATE INDEX IF NOT EXISTS idx_po_messages_unread_internal ON po_messages (po_id) WHERE read_by_internal = false;

-- ══════════════════════════════════════════════════════════════════════════
-- 2. po_message_attachments
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS po_message_attachments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id        uuid NOT NULL REFERENCES po_messages(id) ON DELETE CASCADE,
  file_url          text NOT NULL,    -- Supabase Storage path
  file_name         text NOT NULL,
  file_size_bytes   bigint,
  file_mime_type    text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_message_attachments_message_id ON po_message_attachments (message_id);

-- ══════════════════════════════════════════════════════════════════════════
-- 3. RLS
-- ══════════════════════════════════════════════════════════════════════════
ALTER TABLE po_messages             ENABLE ROW LEVEL SECURITY;
ALTER TABLE po_message_attachments  ENABLE ROW LEVEL SECURITY;

-- po_messages: internal (anon) full; vendors SELECT/INSERT/UPDATE on their own POs.
DROP POLICY IF EXISTS "anon_all_po_messages" ON po_messages;
CREATE POLICY "anon_all_po_messages" ON po_messages
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "vendor_own_po_messages_select" ON po_messages;
CREATE POLICY "vendor_own_po_messages_select" ON po_messages
  FOR SELECT TO authenticated
  USING (
    po_id IN (
      SELECT tp.uuid_id FROM tanda_pos tp
      WHERE tp.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "vendor_own_po_messages_insert" ON po_messages;
CREATE POLICY "vendor_own_po_messages_insert" ON po_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    sender_type = 'vendor'
    AND sender_auth_id = auth.uid()
    AND po_id IN (
      SELECT tp.uuid_id FROM tanda_pos tp
      WHERE tp.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
    )
  );

-- Vendors can only update read_by_vendor on their own side; prevents tampering
-- with body/sender fields. Enforced by the application (only update read flag).
DROP POLICY IF EXISTS "vendor_own_po_messages_update" ON po_messages;
CREATE POLICY "vendor_own_po_messages_update" ON po_messages
  FOR UPDATE TO authenticated
  USING (
    po_id IN (
      SELECT tp.uuid_id FROM tanda_pos tp
      WHERE tp.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
    )
  )
  WITH CHECK (
    po_id IN (
      SELECT tp.uuid_id FROM tanda_pos tp
      WHERE tp.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
    )
  );

-- Attachments inherit via message_id -> po_id
DROP POLICY IF EXISTS "anon_all_po_message_attachments" ON po_message_attachments;
CREATE POLICY "anon_all_po_message_attachments" ON po_message_attachments
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "vendor_own_po_message_attachments_select" ON po_message_attachments;
CREATE POLICY "vendor_own_po_message_attachments_select" ON po_message_attachments
  FOR SELECT TO authenticated
  USING (
    message_id IN (
      SELECT m.id FROM po_messages m
      WHERE m.po_id IN (
        SELECT tp.uuid_id FROM tanda_pos tp
        WHERE tp.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
      )
    )
  );

DROP POLICY IF EXISTS "vendor_own_po_message_attachments_insert" ON po_message_attachments;
CREATE POLICY "vendor_own_po_message_attachments_insert" ON po_message_attachments
  FOR INSERT TO authenticated
  WITH CHECK (
    message_id IN (
      SELECT m.id FROM po_messages m
      WHERE m.sender_auth_id = auth.uid()
    )
  );

-- ══════════════════════════════════════════════════════════════════════════
-- 4. Storage bucket + policies for message attachments
-- ══════════════════════════════════════════════════════════════════════════
INSERT INTO storage.buckets (id, name, public)
VALUES ('po-messages', 'po-messages', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "anon_all_po_messages_objects" ON storage.objects;
CREATE POLICY "anon_all_po_messages_objects" ON storage.objects
  FOR ALL TO anon
  USING (bucket_id = 'po-messages')
  WITH CHECK (bucket_id = 'po-messages');

-- Vendors can read/upload attachments for messages on their own POs. The
-- first path segment is the po_id; we validate it against tanda_pos + vendor_users.
DROP POLICY IF EXISTS "vendor_own_po_messages_objects_select" ON storage.objects;
CREATE POLICY "vendor_own_po_messages_objects_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'po-messages'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT tp.uuid_id::uuid FROM tanda_pos tp
      WHERE tp.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "vendor_own_po_messages_objects_insert" ON storage.objects;
CREATE POLICY "vendor_own_po_messages_objects_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'po-messages'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT tp.uuid_id::uuid FROM tanda_pos tp
      WHERE tp.vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
    )
  );
