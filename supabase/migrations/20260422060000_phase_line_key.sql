-- 20260422060000_phase_line_key.sql
--
-- Expand tanda_milestone_change_requests so a single change-request row
-- can target either the PO-level phase (po_line_key NULL) or a specific
-- line's variant of that phase (po_line_key = po_line_items.id). The
-- cascade rule is enforced at render time:
--   • NULL entry = master status for this (po, phase)
--   • non-NULL   = override for that one line
-- The line override wins when both exist; missing line rows inherit the
-- master.

ALTER TABLE tanda_milestone_change_requests
  ADD COLUMN IF NOT EXISTS po_line_key text;

CREATE INDEX IF NOT EXISTS idx_mcr_po_phase_line
  ON tanda_milestone_change_requests (po_id, phase_name, po_line_key, field_name);
