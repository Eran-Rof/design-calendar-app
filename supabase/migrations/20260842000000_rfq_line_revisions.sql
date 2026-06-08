-- ROF-side RFQ revision HISTORY.
--
-- rfq_line_items.revised_at + revised_fields (migration 20260841000000) record
-- only the LATEST buyer revision. The vendor quote side has full history
-- (rfq_quote_revisions, 20260813000000); the buyer/ROF side had none. This adds
-- an append-only snapshot — one row per buyer revision of an rfq_line_item — so
-- the internal RFQ detail can show "what ROF changed, when, old → new", mirroring
-- the vendor revision history.
--
-- Written by the costing-line PUT handler whenever it re-syncs vendor-visible
-- fields onto a sent RFQ line. Best-effort: a failed snapshot never blocks the
-- costing save or the vendor notification.

CREATE TABLE IF NOT EXISTS rfq_line_revisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_line_item_id uuid NOT NULL REFERENCES rfq_line_items(id) ON DELETE CASCADE,
  rfq_id           uuid NOT NULL,
  costing_line_id  uuid,
  revised_at       timestamptz NOT NULL DEFAULT now(),
  changed_fields   text[] NOT NULL DEFAULT '{}'::text[],
  old_values       jsonb  NOT NULL DEFAULT '{}'::jsonb,
  new_values       jsonb  NOT NULL DEFAULT '{}'::jsonb,
  revised_by       text,
  entity_id        uuid
);

CREATE INDEX IF NOT EXISTS idx_rfq_line_revisions_rfq  ON rfq_line_revisions (rfq_id, revised_at DESC);
CREATE INDEX IF NOT EXISTS idx_rfq_line_revisions_item ON rfq_line_revisions (rfq_line_item_id, revised_at DESC);

COMMENT ON TABLE  rfq_line_revisions IS 'Append-only history of buyer (ROF) revisions to vendor-visible RFQ line fields. One row per costing-line edit that re-synced onto a sent RFQ line. Mirrors rfq_quote_revisions (vendor side).';
COMMENT ON COLUMN rfq_line_revisions.changed_fields IS 'Vendor-visible fields changed in this revision (e.g. {target_price,quantity,fabric_code}).';
COMMENT ON COLUMN rfq_line_revisions.old_values IS 'JSON {field: prior value} for the changed fields, captured before the update.';
COMMENT ON COLUMN rfq_line_revisions.new_values IS 'JSON {field: new value} for the changed fields.';

-- Permissive RLS to match the rest of the costing/RFQ surface (SaaS isolation is
-- deferred until a 2nd tenant; see project_saas_isolation memory).
ALTER TABLE rfq_line_revisions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'rfq_line_revisions' AND policyname = 'rfq_line_revisions_all') THEN
    CREATE POLICY rfq_line_revisions_all ON rfq_line_revisions FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
