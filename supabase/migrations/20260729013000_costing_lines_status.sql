-- Costing — per-line status (replaces project-level status as the source of truth).
--
-- A costing project can have lines in different states at once (one awarded,
-- others still on RFQ or draft). Status is now PER LINE. This column holds only
-- the MANUAL part — 'draft' (default) or 'closed'. The two automatic states are
-- DERIVED, not stored:
--   awarded  — costing_lines.selected_vendor_quote_id IS NOT NULL
--   on_rfq   — the line has an rfq_line_items row (an RFQ was generated for it)
-- Effective status precedence (computed in the app / lines handler):
--   closed (manual) > awarded (auto) > on_rfq (auto) > draft (default)

ALTER TABLE costing_lines
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'costing_lines_status_check'
  ) THEN
    ALTER TABLE costing_lines
      ADD CONSTRAINT costing_lines_status_check CHECK (status IN ('draft', 'closed'));
  END IF;
END $$;

COMMENT ON COLUMN costing_lines.status IS 'Manual per-line status: draft (default) or closed. The on_rfq + awarded states are DERIVED (rfq_line_items / selected_vendor_quote_id) and not stored here. Effective precedence: closed > awarded > on_rfq > draft.';
