-- Corrective: rows were wrongly set to 'awarded' by two prior migration
-- backfills (20260819 + 20260824) because those backfills equated
-- selected_vendor_quote_id IS NOT NULL with a formal award decision.
--
-- Vendor selection (the select-quote action / VendorGridCell) is NOT an award.
-- It tracks the intended vendor for RFQ generation only.  Only the RFQ award
-- handler (rfqs/[id]/award/[vendor_id]) produces a real 'awarded' status, and
-- that flow writes a history row with note='rfq_awarded'.
--
-- Reset any 'awarded' line that has NO rfq_awarded history entry:
--   → 'sent'  if the line is referenced by rfq_line_items with an invitation
--   → 'draft' otherwise

WITH real_awarded AS (
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
SELECT id, status, 'system', 'corrective_vendor_select_not_award'
FROM corrected;
