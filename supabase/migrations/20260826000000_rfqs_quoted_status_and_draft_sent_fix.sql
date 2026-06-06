-- 1. Add 'quoted' to the rfqs.status check constraint.
--    Vendor quote submission now advances rfqs.status → 'quoted'.
ALTER TABLE rfqs
  DROP CONSTRAINT IF EXISTS rfqs_status_check;

ALTER TABLE rfqs
  ADD CONSTRAINT rfqs_status_check
  CHECK (status IN ('draft', 'published', 'quoted', 'closed', 'awarded'));

-- Backfill existing RFQs in 'published' that have at least one 'submitted'
-- rfq_invitations row → they're already effectively 'quoted'.
UPDATE rfqs r
SET status = 'quoted', updated_at = now()
WHERE r.status = 'published'
  AND EXISTS (
    SELECT 1 FROM rfq_invitations inv
    WHERE inv.rfq_id = r.id AND inv.status = 'submitted'
  );

-- 2. Fix costing lines that are still 'draft' but belong to a published /
--    quoted / awarded RFQ.  These were missed by the earlier backfill because
--    the line had status='awarded' (wrong) when publish.js ran; the corrective
--    migration reset them to 'draft' but didn't re-advance to 'sent'.
UPDATE costing_lines cl
SET status = 'sent', updated_at = now()
WHERE cl.status = 'draft'
  AND cl.id IN (
    SELECT DISTINCT rli.costing_line_id
    FROM rfq_line_items rli
    JOIN rfqs r ON r.id = rli.rfq_id
    WHERE rli.costing_line_id IS NOT NULL
      AND r.status IN ('published', 'quoted', 'awarded', 'closed')
  );

-- Seed history for the newly-advanced lines.
INSERT INTO costing_line_status_history (costing_line_id, status, changed_by, note)
SELECT cl.id, 'sent', 'system', 'backfill_draft_to_sent'
FROM costing_lines cl
WHERE cl.status = 'sent'
  AND NOT EXISTS (
    SELECT 1 FROM costing_line_status_history h
    WHERE h.costing_line_id = cl.id AND h.note = 'backfill_draft_to_sent'
  );

NOTIFY pgrst, 'reload schema';
