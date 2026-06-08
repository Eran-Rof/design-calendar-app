-- RFQ line revision flags — when Ring of Fire edits a costing line that has
-- already been sent to a vendor (RFQ generated), the vendor-visible fields on
-- the linked rfq_line_items are re-synced and stamped so the vendor sees what
-- changed and is notified.
--
--   revised_at      — when the line was last revised by the buyer (NULL = never)
--   revised_fields  — names of the vendor-visible fields changed in that revision
--                     (e.g. {target_price,quantity,fabric_code}) so the portal
--                     can green-highlight exactly those cells.

ALTER TABLE rfq_line_items ADD COLUMN IF NOT EXISTS revised_at     timestamptz;
ALTER TABLE rfq_line_items ADD COLUMN IF NOT EXISTS revised_fields text[] NOT NULL DEFAULT '{}'::text[];
