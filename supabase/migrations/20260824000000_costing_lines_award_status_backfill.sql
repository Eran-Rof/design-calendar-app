-- Corrective: undo any rows that were wrongly set to 'awarded' by the
-- migration-20260819 backfill based on selected_vendor_quote_id.
--
-- Vendor selection (select-quote action) is NOT the formal award decision;
-- it only tracks the intended vendor for RFQ generation.  Only the RFQ award
-- handler (rfqs/[id]/award/[vendor_id]) produces a real 'awarded' status, and
-- that flow writes a history row with note='rfq_awarded'.
--
-- Reset any 'awarded' line that has NO rfq_awarded history entry:
--   → 'sent'  if the line is on a published RFQ
--   → 'draft' otherwise

WITH real_awarded AS (
  -- Lines whose 'awarded' status came from the real RFQ award flow.
  SELECT DISTINCT costing_line_id
  FROM costing_line_status_history
  WHERE status = 'awarded'
    AND note = 'rfq_awarded'
),
published_lines AS (
  SELECT DISTINCT rli.costing_line_id
  FROM rfq_line_items rli
  JOIN rfq_invitations inv ON inv.rfq_id = rli.rfq_id
  WHERE rli.costing_line_id IS NOT NULL
),
corrected AS (
  UPDATE costing_lines
  SET status = CASE
    WHEN id IN (SELECT costing_line_id FROM published_lines) THEN 'sent'
    ELSE 'draft'
  END,
  updated_at = now()
  WHERE status = 'awarded'
    AND id NOT IN (SELECT costing_line_id FROM real_awarded)
  RETURNING id, status
)
INSERT INTO costing_line_status_history (costing_line_id, status, changed_by, note)
SELECT id, status, 'system', 'corrective_backfill'
FROM corrected;
