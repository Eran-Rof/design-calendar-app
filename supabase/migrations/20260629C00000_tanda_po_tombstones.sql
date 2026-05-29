-- 20260629C00000_tanda_po_tombstones.sql
--
-- Tombstone table for permanently-deleted PO WIP rows.
--
-- Why: the nightly Xoro → tanda_pos sync (api/_handlers/tanda/sync-from-xoro.js)
-- upserts every PO that Xoro still reports as active (Open / Released /
-- Partial). If a user permanently-deletes a PO from PO WIP, that row is
-- gone from tanda_pos but the next sync rebuilds it from Xoro, so the PO
-- silently reappears in the ATS app's "Open Purchase Orders" popover.
--
-- The sync reads this table at the top of each run and skips any po_number
-- that has a tombstone. Restoring a tombstoned PO means deleting the
-- tombstone row (no UI yet; do it from the Supabase SQL editor).

CREATE TABLE IF NOT EXISTS tanda_po_tombstones (
  po_number       text PRIMARY KEY,
  tombstoned_at   timestamptz NOT NULL DEFAULT now(),
  tombstoned_by   text
);
