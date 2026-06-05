-- Corrective backfill for the costing-line status lifecycle.
--
-- Lines where a vendor was selected DIRECTLY on the line (selected_vendor_quote_id
-- set via the grid's select-quote action, not the RFQ award flow) were never
-- promoted to 'awarded' — the select-quote handler didn't touch costing_lines.status,
-- so those lines stayed 'draft'. (Going forward, select-quote now sets the status.)
-- Promote any such still-'draft' lines to 'awarded' and log the transition.

WITH moved AS (
  UPDATE costing_lines
  SET status = 'awarded', updated_at = now()
  WHERE selected_vendor_quote_id IS NOT NULL
    AND status = 'draft'
  RETURNING id
)
INSERT INTO costing_line_status_history (costing_line_id, status, changed_by, note)
SELECT id, 'awarded', 'system', 'backfill_select_quote' FROM moved;
