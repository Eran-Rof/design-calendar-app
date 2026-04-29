-- 20260422070000_po_phase_notes.sql
--
-- Notes on PO phases. Each entry is its own row (instead of one
-- textarea-per-phase) so vendors can add, edit, and delete individual
-- notes with full attribution + timestamps. Notes are not part of the
-- status/date approval workflow — they show up immediately.
--
-- A note attaches to either:
--   • the phase master (po_line_key IS NULL), or
--   • a specific PO line (po_line_key = po_line_items.id)
-- The phase-master popover aggregates line notes so the vendor sees
-- everything in one place.

CREATE TABLE IF NOT EXISTS po_phase_notes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id        uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  po_id            uuid NOT NULL REFERENCES tanda_pos(uuid_id) ON DELETE CASCADE,
  phase_name       text NOT NULL,
  po_line_key      text, -- null = phase-master note, non-null = per-line note
  body             text NOT NULL CHECK (char_length(body) > 0),
  author_auth_id   uuid, -- vendor_users.auth_id (null when authored internally)
  author_name      text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz  -- soft delete so audit history survives
);

CREATE INDEX IF NOT EXISTS idx_ppn_po_phase
  ON po_phase_notes (po_id, phase_name, po_line_key)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ppn_vendor
  ON po_phase_notes (vendor_id)
  WHERE deleted_at IS NULL;

ALTER TABLE po_phase_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_ppn" ON po_phase_notes;
CREATE POLICY "anon_all_ppn" ON po_phase_notes
  FOR ALL TO anon
  USING (true) WITH CHECK (true);

-- Vendors can read every note on their POs (including ROF-authored ones).
DROP POLICY IF EXISTS "vendor_read_own_ppn" ON po_phase_notes;
CREATE POLICY "vendor_read_own_ppn" ON po_phase_notes
  FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- Vendors can only insert notes for their own vendor_id, attributed to themselves.
DROP POLICY IF EXISTS "vendor_insert_own_ppn" ON po_phase_notes;
CREATE POLICY "vendor_insert_own_ppn" ON po_phase_notes
  FOR INSERT TO authenticated
  WITH CHECK (
    vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid())
    AND author_auth_id = auth.uid()
  );

-- Vendors can only edit / soft-delete notes they authored themselves.
DROP POLICY IF EXISTS "vendor_update_own_ppn" ON po_phase_notes;
CREATE POLICY "vendor_update_own_ppn" ON po_phase_notes
  FOR UPDATE TO authenticated
  USING (author_auth_id = auth.uid())
  WITH CHECK (author_auth_id = auth.uid());
