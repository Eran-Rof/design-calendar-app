-- Costing Module — mirror style_code + color onto rfq_line_items
--
-- Operator ask: warn when creating an RFQ that duplicates an existing
-- RFQ for the same style + color + vendor.
--
-- The duplicate check needs a robust match key. Today style_code / color
-- live only on the source costing_lines row and get hand-mashed into
-- rfq_line_items.description text at generate-rfqs time — too fragile to
-- match on reliably. Promote them to first-class columns (same pattern as
-- the 20260708000000 fabric/fit/closure mirror) so the dup-RFQ check in
-- api/_handlers/internal/costing/projects/[id]/generate-rfqs.js can match on
-- (rfq_invitations.vendor_id, rfq_line_items.style_code, rfq_line_items.color).
--
-- generate-rfqs writes these at creation time. Existing rows stay valid
-- (NULLs in the new columns); no backfill — historical RFQs simply won't
-- trigger the dup warning, which is the desired conservative behavior.

ALTER TABLE rfq_line_items
  ADD COLUMN IF NOT EXISTS style_code text,
  ADD COLUMN IF NOT EXISTS color      text;

COMMENT ON COLUMN rfq_line_items.style_code IS 'Mirrors costing_lines.style_code at generate-rfqs time. Used (with color + the RFQ vendor) for the duplicate-RFQ confirmation prompt. NULL on RFQs created before this field shipped.';
COMMENT ON COLUMN rfq_line_items.color IS 'Mirrors costing_lines.color at generate-rfqs time. Part of the style + color + vendor duplicate-RFQ match key.';

-- Helps the dup-check lookup (filter by style_code/color within a small set
-- of rfq_ids). Partial index keeps it cheap — only populated rows matter.
CREATE INDEX IF NOT EXISTS idx_rfq_line_items_style_color
  ON rfq_line_items (style_code, color)
  WHERE style_code IS NOT NULL;

NOTIFY pgrst, 'reload schema';
