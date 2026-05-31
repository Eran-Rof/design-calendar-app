-- Costing Module — push richer costing-line attributes onto rfq_line_items
--
-- Operator ask: the RFQ detail grid should surface the same Fabric / Fit /
-- Closure / Scale / Waist / Target-price columns we capture on each
-- costing_lines row. They were getting hand-mashed into the description /
-- specifications text fields; promote them to first-class columns so the
-- vendor view (and any downstream export) can render them properly.
--
-- generate-rfqs in api/_handlers/internal/costing/projects/[id]/ writes a
-- row per costing_line. Existing rows stay valid (NULLs in the new
-- columns). No data backfill — historical RFQs continue to render the
-- prior description/specifications text as before.

ALTER TABLE rfq_line_items
  ADD COLUMN IF NOT EXISTS fabric_code      text,
  ADD COLUMN IF NOT EXISTS fit              text,
  ADD COLUMN IF NOT EXISTS bottom_closure   text,
  ADD COLUMN IF NOT EXISTS size_scale_label text,
  ADD COLUMN IF NOT EXISTS waist_type       text,
  ADD COLUMN IF NOT EXISTS target_price     numeric(12,4);

COMMENT ON COLUMN rfq_line_items.fabric_code      IS 'Mirrors costing_lines.fabric_code at generate-rfqs time. NULL on RFQs created before this field shipped.';
COMMENT ON COLUMN rfq_line_items.fit              IS 'Mirrors costing_lines.fit.';
COMMENT ON COLUMN rfq_line_items.bottom_closure   IS 'Mirrors costing_lines.bottom_closure.';
COMMENT ON COLUMN rfq_line_items.size_scale_label IS 'Mirrors costing_lines.size_scale_label (denormalized snapshot, not an FK).';
COMMENT ON COLUMN rfq_line_items.waist_type       IS 'Mirrors costing_lines.waist_type.';
COMMENT ON COLUMN rfq_line_items.target_price     IS 'Mirrors costing_lines.target_cost — the per-unit cost target the vendor is being asked to quote against. numeric(12,4) matches the source column precision.';

NOTIFY pgrst, 'reload schema';
