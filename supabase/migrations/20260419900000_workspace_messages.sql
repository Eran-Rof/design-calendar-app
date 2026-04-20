-- 20260419900000_workspace_messages.sql
--
-- Phase 9.4 — Collaboration Workspaces.
--
-- Lets po_messages serve either a PO thread or a workspace thread.
-- Uses the existing Message model (sender_type/sender_name/body/read flags);
-- swaps exactly one of (po_id, workspace_id) per row via a CHECK.
--
-- SAFETY NOTES:
--   • po_id NOT NULL constraint is dropped; historical rows still have it set.
--   • Existing PO-scoped code paths (api/internal/pos/[id]/messages.js, etc.)
--     continue to work unchanged — they always filter by po_id.
--   • Backfill is trivial (no existing rows should have workspace_id set).

ALTER TABLE po_messages
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES collaboration_workspaces(id) ON DELETE CASCADE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'po_messages' AND column_name = 'po_id' AND is_nullable = 'NO'
  ) THEN
    EXECUTE 'ALTER TABLE po_messages ALTER COLUMN po_id DROP NOT NULL';
  END IF;
END $$;

ALTER TABLE po_messages DROP CONSTRAINT IF EXISTS chk_po_messages_parent;
ALTER TABLE po_messages ADD CONSTRAINT chk_po_messages_parent CHECK (
  (po_id IS NOT NULL AND workspace_id IS NULL)
  OR (po_id IS NULL AND workspace_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_po_messages_workspace_id
  ON po_messages (workspace_id, created_at DESC)
  WHERE workspace_id IS NOT NULL;

-- RLS: vendor-authenticated reads scoped to workspace_id match
DROP POLICY IF EXISTS "vendor_own_workspace_messages" ON po_messages;
CREATE POLICY "vendor_own_workspace_messages" ON po_messages
  FOR ALL TO authenticated
  USING (
    workspace_id IS NULL
    OR workspace_id IN (
      SELECT w.id FROM collaboration_workspaces w
      JOIN vendor_users vu ON vu.vendor_id = w.vendor_id
      WHERE vu.auth_id = auth.uid()
    )
  );
