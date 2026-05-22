-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 1 / Migration 3
-- Propagate entity_id across all 13 transactional + master tables.
-- Pattern per table: ADD nullable → backfill to ROF → SET NOT NULL → index.
-- Architecture: docs/tangerine/P1-foundation-architecture.md §3.2
--
-- Backfill uses subquery (SELECT id FROM entities WHERE code='ROF') which
-- works because migration 20260521010000 set the seed row's code to 'ROF'.
-- Safe to re-run: ADD COLUMN IF NOT EXISTS + COALESCE on UPDATE.
-- ════════════════════════════════════════════════════════════════════════════

-- Helper: stash the ROF entity uuid in a temp var via DO block.
-- Inline subqueries kept everywhere so this migration can replay against
-- partial state without needing the DO block to have committed.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. tanda_pos
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE tanda_pos SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE tanda_pos ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE tanda_pos
  ADD CONSTRAINT tanda_pos_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_tanda_pos_entity_id ON tanda_pos (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. po_line_items
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE po_line_items SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE po_line_items ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE po_line_items
  ADD CONSTRAINT po_line_items_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_po_line_items_entity_id ON po_line_items (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. invoices
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE invoices SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE invoices ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_invoices_entity_id ON invoices (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. invoice_line_items
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE invoice_line_items SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE invoice_line_items ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE invoice_line_items
  ADD CONSTRAINT invoice_line_items_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_invoice_line_items_entity_id ON invoice_line_items (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. shipments
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE shipments SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE shipments ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE shipments
  ADD CONSTRAINT shipments_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_shipments_entity_id ON shipments (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 6. shipment_lines
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE shipment_lines ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE shipment_lines SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE shipment_lines ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE shipment_lines
  ADD CONSTRAINT shipment_lines_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_shipment_lines_entity_id ON shipment_lines (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 7. shipment_events
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE shipment_events ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE shipment_events SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE shipment_events ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE shipment_events
  ADD CONSTRAINT shipment_events_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_shipment_events_entity_id ON shipment_events (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 8. receipts
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE receipts SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE receipts ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE receipts
  ADD CONSTRAINT receipts_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_receipts_entity_id ON receipts (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 9. receipt_line_items
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE receipt_line_items SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE receipt_line_items ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE receipt_line_items
  ADD CONSTRAINT receipt_line_items_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_receipt_line_items_entity_id ON receipt_line_items (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 10. ip_item_master
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE ip_item_master ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE ip_item_master SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE ip_item_master ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE ip_item_master
  ADD CONSTRAINT ip_item_master_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_ip_item_master_entity_id ON ip_item_master (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 11. ip_category_master
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE ip_category_master ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE ip_category_master SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE ip_category_master ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE ip_category_master
  ADD CONSTRAINT ip_category_master_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_ip_category_master_entity_id ON ip_category_master (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 12. ip_vendor_master
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE ip_vendor_master ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE ip_vendor_master SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE ip_vendor_master ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE ip_vendor_master
  ADD CONSTRAINT ip_vendor_master_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_ip_vendor_master_entity_id ON ip_vendor_master (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 13. ip_customer_master
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE ip_customer_master ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE ip_customer_master SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE ip_customer_master ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE ip_customer_master
  ADD CONSTRAINT ip_customer_master_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_ip_customer_master_entity_id ON ip_customer_master (entity_id);

-- ════════════════════════════════════════════════════════════════════════════
-- Sanity check: fail loudly if any table still has NULL entity_id (shouldn't
-- be possible at this point, but a single bad row would break later passes).
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  bad_table text;
BEGIN
  FOR bad_table IN
    SELECT table_name
    FROM (VALUES
      ('tanda_pos'),('po_line_items'),('invoices'),('invoice_line_items'),
      ('shipments'),('shipment_lines'),('shipment_events'),
      ('receipts'),('receipt_line_items'),
      ('ip_item_master'),('ip_category_master'),('ip_vendor_master'),('ip_customer_master')
    ) AS t(table_name)
  LOOP
    EXECUTE format('SELECT 1 FROM %I WHERE entity_id IS NULL LIMIT 1', bad_table);
    IF FOUND THEN
      RAISE EXCEPTION 'Tangerine P1 mig 3: % still has NULL entity_id rows', bad_table;
    END IF;
  END LOOP;
END $$;
