-- Costing Module — RFQ award → costing write-back back-pointer
--
-- When costing generates an RFQ (api/.../costing/projects/[id]/generate-rfqs.js)
-- it builds each rfq_line_items row from a source costing_lines row, but kept
-- no link back to it. The award handler now needs to flow the winning quoted
-- unit_price back into the originating costing line (upsert costing_line_vendors
-- + stamp costing_lines.selected_vendor_quote_id), and to do that reliably it
-- needs a robust rfq_line_item -> costing_line mapping rather than re-matching
-- on style/color text.
--
-- Promote the link to a first-class FK column (same conservative pattern as the
-- 20260713060000 style_code/color mirror): generate-rfqs stamps it at creation
-- time; existing rows stay valid with NULL (legacy RFQs simply skip the costing
-- write-back on award, which is the desired safe behavior). ON DELETE SET NULL
-- so deleting a costing line never cascades into RFQ history.

ALTER TABLE rfq_line_items
  ADD COLUMN IF NOT EXISTS costing_line_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rfq_line_items_costing_line_id_fkey'
  ) THEN
    ALTER TABLE rfq_line_items
      ADD CONSTRAINT rfq_line_items_costing_line_id_fkey
      FOREIGN KEY (costing_line_id) REFERENCES costing_lines(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN rfq_line_items.costing_line_id IS 'Back-pointer to the costing_lines row this RFQ line was generated from. Stamped by generate-rfqs; drives the award write-back that upserts costing_line_vendors and stamps costing_lines.selected_vendor_quote_id. NULL on RFQs created before this field shipped or on RFQs not originated from costing.';

CREATE INDEX IF NOT EXISTS idx_rfq_line_items_costing_line
  ON rfq_line_items (costing_line_id)
  WHERE costing_line_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
