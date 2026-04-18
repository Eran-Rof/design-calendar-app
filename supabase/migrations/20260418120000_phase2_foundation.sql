-- 20260418120000_phase2_foundation.sql
--
-- Phase 2.1 — foundation for shipment/ASN submission + 3-way match engine.
--
-- Key design choices:
--   • We do NOT create a separate `purchase_orders` table. Xoro is the source
--     of truth and we already mirror into `tanda_pos`. Instead, we add a
--     `uuid_id` column to tanda_pos as a stable UUID FK target.
--   • `po_line_items` IS materialized because tanda_pos stores lines as JSON
--     inside `data.Items` / `data.PoLineArr`. For FKs and joins (ASN ->
--     shipment_lines -> po_line_items -> PO; 3-way match by line) you need
--     real rows. A trigger keeps them in sync with the JSON.
--   • `shipments` gains invoice_id (nullable, FK added when invoices table
--     lands), po_id (uuid), and the workflow status enum from the plan.
--   • `shipment_lines` is new; keyed by po_line_item_id.
--
-- Internal apps are unaffected: adding a column to tanda_pos doesn't change
-- how TandA reads it; the trigger writes to a new table that no internal
-- code queries yet.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. tanda_pos.uuid_id — stable UUID target for new FKs
-- ══════════════════════════════════════════════════════════════════════════
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS uuid_id uuid DEFAULT gen_random_uuid();
UPDATE tanda_pos SET uuid_id = gen_random_uuid() WHERE uuid_id IS NULL;
ALTER TABLE tanda_pos ALTER COLUMN uuid_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tanda_pos_uuid_id ON tanda_pos (uuid_id);

-- ══════════════════════════════════════════════════════════════════════════
-- 2. po_line_items — materialized PO line rows
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS po_line_items (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id                    uuid NOT NULL REFERENCES tanda_pos(uuid_id) ON DELETE CASCADE,
  line_index               integer NOT NULL,
  item_number              text,
  description              text,
  qty_ordered              numeric,
  qty_received             numeric,
  qty_remaining            numeric,
  unit_price               numeric,
  line_total               numeric,
  date_expected_delivery   text,
  raw_json                 jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_po_line_items_po_line
  ON po_line_items (po_id, line_index);
CREATE INDEX IF NOT EXISTS idx_po_line_items_po_id       ON po_line_items (po_id);
CREATE INDEX IF NOT EXISTS idx_po_line_items_item_number ON po_line_items (item_number);

-- Rebuild function: idempotent; deletes + re-inserts line rows for one PO.
-- Called by trigger on INSERT/UPDATE of tanda_pos.data, and can be called
-- manually to backfill or repair drift.
CREATE OR REPLACE FUNCTION rebuild_po_line_items(p_po_id uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  po_data   jsonb;
  items     jsonb;
  item      jsonb;
  idx       integer := 0;
  inserted  integer := 0;
BEGIN
  SELECT data INTO po_data FROM tanda_pos WHERE uuid_id = p_po_id;
  IF po_data IS NULL THEN RETURN 0; END IF;

  items := COALESCE(po_data->'Items', po_data->'PoLineArr', '[]'::jsonb);

  DELETE FROM po_line_items WHERE po_id = p_po_id;

  FOR item IN SELECT * FROM jsonb_array_elements(items) LOOP
    idx := idx + 1;
    INSERT INTO po_line_items (
      po_id, line_index, item_number, description,
      qty_ordered, qty_received, qty_remaining, unit_price, line_total,
      date_expected_delivery, raw_json
    ) VALUES (
      p_po_id, idx,
      NULLIF(item->>'ItemNumber', ''),
      NULLIF(item->>'Description', ''),
      NULLIF(item->>'QtyOrder', '')::numeric,
      NULLIF(item->>'QtyReceived', '')::numeric,
      NULLIF(item->>'QtyRemaining', '')::numeric,
      NULLIF(item->>'UnitPrice', '')::numeric,
      CASE
        WHEN NULLIF(item->>'QtyOrder', '') IS NOT NULL
         AND NULLIF(item->>'UnitPrice', '') IS NOT NULL
        THEN (item->>'QtyOrder')::numeric * (item->>'UnitPrice')::numeric
        ELSE NULL
      END,
      NULLIF(item->>'DateExpectedDelivery', ''),
      item
    );
    inserted := inserted + 1;
  END LOOP;

  RETURN inserted;
END; $$;

CREATE OR REPLACE FUNCTION rebuild_po_line_items_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.uuid_id IS NOT NULL AND NEW.data IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.data IS DISTINCT FROM NEW.data) THEN
    PERFORM rebuild_po_line_items(NEW.uuid_id);
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS tanda_pos_line_items_mirror ON tanda_pos;
CREATE TRIGGER tanda_pos_line_items_mirror
  AFTER INSERT OR UPDATE OF data ON tanda_pos
  FOR EACH ROW EXECUTE FUNCTION rebuild_po_line_items_trigger();

-- Backfill from existing POs. Runs once at migration time.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT uuid_id FROM tanda_pos WHERE data IS NOT NULL LOOP
    PERFORM rebuild_po_line_items(r.uuid_id);
  END LOOP;
END; $$;

-- ══════════════════════════════════════════════════════════════════════════
-- 3. shipments — expand with Phase 2 fields
-- ══════════════════════════════════════════════════════════════════════════
ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS po_id              uuid REFERENCES tanda_pos(uuid_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS invoice_id         uuid,  -- FK added in Phase 2.2 invoice migration
  ADD COLUMN IF NOT EXISTS carrier            text,
  ADD COLUMN IF NOT EXISTS ship_date          timestamptz,
  ADD COLUMN IF NOT EXISTS estimated_delivery timestamptz,
  ADD COLUMN IF NOT EXISTS actual_delivery    timestamptz,
  ADD COLUMN IF NOT EXISTS workflow_status    text,
  ADD COLUMN IF NOT EXISTS notes              text;

-- Workflow status enum check (allow NULL for Searates-only rows that pre-date
-- Phase 2). Drop+re-add to make idempotent.
ALTER TABLE shipments DROP CONSTRAINT IF EXISTS shipments_workflow_status_check;
ALTER TABLE shipments ADD CONSTRAINT shipments_workflow_status_check
  CHECK (workflow_status IS NULL OR workflow_status IN
    ('created', 'submitted', 'in_transit', 'delivered', 'exception'));

CREATE INDEX IF NOT EXISTS idx_shipments_po_id             ON shipments (po_id) WHERE po_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shipments_invoice_id        ON shipments (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shipments_workflow_status   ON shipments (workflow_status);

-- Backfill po_id from po_number -> tanda_pos.po_number -> tanda_pos.uuid_id
UPDATE shipments s
SET    po_id = tp.uuid_id
FROM   tanda_pos tp
WHERE  s.po_number IS NOT NULL
  AND  s.po_number = tp.po_number
  AND  s.po_id IS NULL;

-- ══════════════════════════════════════════════════════════════════════════
-- 4. shipment_lines
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS shipment_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id       uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  po_line_item_id   uuid REFERENCES po_line_items(id) ON DELETE SET NULL,
  quantity_shipped  numeric NOT NULL CHECK (quantity_shipped > 0),
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shipment_lines_shipment_id     ON shipment_lines (shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_lines_po_line_item_id ON shipment_lines (po_line_item_id);

-- ══════════════════════════════════════════════════════════════════════════
-- 5. RLS for the new tables (Phase 0 pattern)
-- ══════════════════════════════════════════════════════════════════════════
ALTER TABLE po_line_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_lines ENABLE ROW LEVEL SECURITY;

-- po_line_items
DROP POLICY IF EXISTS "anon_all_po_line_items" ON po_line_items;
CREATE POLICY "anon_all_po_line_items" ON po_line_items
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "vendor_own_po_line_items_select" ON po_line_items;
CREATE POLICY "vendor_own_po_line_items_select" ON po_line_items
  FOR SELECT TO authenticated
  USING (
    po_id IN (
      SELECT tp.uuid_id FROM tanda_pos tp
      WHERE tp.vendor_id IN (
        SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()
      )
    )
  );

-- shipment_lines
DROP POLICY IF EXISTS "anon_all_shipment_lines" ON shipment_lines;
CREATE POLICY "anon_all_shipment_lines" ON shipment_lines
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "vendor_own_shipment_lines_select" ON shipment_lines;
CREATE POLICY "vendor_own_shipment_lines_select" ON shipment_lines
  FOR SELECT TO authenticated
  USING (
    shipment_id IN (
      SELECT s.id FROM shipments s
      WHERE s.vendor_id IN (
        SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "vendor_own_shipment_lines_insert" ON shipment_lines;
CREATE POLICY "vendor_own_shipment_lines_insert" ON shipment_lines
  FOR INSERT TO authenticated
  WITH CHECK (
    shipment_id IN (
      SELECT s.id FROM shipments s
      WHERE s.vendor_id IN (
        SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "vendor_own_shipment_lines_update" ON shipment_lines;
CREATE POLICY "vendor_own_shipment_lines_update" ON shipment_lines
  FOR UPDATE TO authenticated
  USING (
    shipment_id IN (
      SELECT s.id FROM shipments s
      WHERE s.vendor_id IN (
        SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()
      )
    )
  );
