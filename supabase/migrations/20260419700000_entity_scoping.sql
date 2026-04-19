-- 20260419700000_entity_scoping.sql
--
-- Multi-tenant scoping: add entity_id FK to PurchaseOrder (tanda_pos),
-- Invoice (invoices), and Contract (contracts). RFQ and WorkflowRule
-- already got entity_id in the Phase 8 schema.
--
-- Backfill: existing rows are pointed at the default 'ring-of-fire'
-- entity seeded in Phase 8. Column stays NULLABLE at the DB layer so
-- legacy data that hasn't been associated yet won't break; the API
-- layer enforces NOT NULL for new rows.

DO $$
DECLARE
  v_default_entity uuid;
BEGIN
  SELECT id INTO v_default_entity FROM entities ORDER BY created_at ASC LIMIT 1;
  IF v_default_entity IS NULL THEN
    INSERT INTO entities (name, slug, status) VALUES ('Ring of Fire', 'ring-of-fire', 'active')
      RETURNING id INTO v_default_entity;
  END IF;

  -- tanda_pos
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'tanda_pos' AND column_name = 'entity_id') THEN
    EXECUTE 'ALTER TABLE tanda_pos ADD COLUMN entity_id uuid REFERENCES entities(id) ON DELETE RESTRICT';
    EXECUTE format('UPDATE tanda_pos SET entity_id = %L WHERE entity_id IS NULL', v_default_entity);
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_tanda_pos_entity ON tanda_pos (entity_id)';
  END IF;

  -- invoices
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'invoices' AND column_name = 'entity_id') THEN
    EXECUTE 'ALTER TABLE invoices ADD COLUMN entity_id uuid REFERENCES entities(id) ON DELETE RESTRICT';
    EXECUTE format('UPDATE invoices SET entity_id = %L WHERE entity_id IS NULL', v_default_entity);
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_invoices_entity ON invoices (entity_id)';
  END IF;

  -- contracts
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'contracts' AND column_name = 'entity_id') THEN
    EXECUTE 'ALTER TABLE contracts ADD COLUMN entity_id uuid REFERENCES entities(id) ON DELETE RESTRICT';
    EXECUTE format('UPDATE contracts SET entity_id = %L WHERE entity_id IS NULL', v_default_entity);
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_contracts_entity ON contracts (entity_id)';
  END IF;

  -- entity_vendors: seed one junction row per active vendor against the
  -- default entity so the vendor portal continues to surface entities
  -- for the existing fleet.
  INSERT INTO entity_vendors (entity_id, vendor_id, relationship_status)
  SELECT v_default_entity, v.id, 'active'
  FROM vendors v
  WHERE v.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM entity_vendors ev
      WHERE ev.entity_id = v_default_entity AND ev.vendor_id = v.id
    );
END $$;
