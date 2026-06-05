-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine — Transfer Reason Master (transfer_reason_master)
-- A configurable, auto-coded master listing the inventory-TRANSFER reasons a
-- location-to-location move can be tagged with (e.g. Replenishment, Rebalance,
-- Damage Move, Return to Warehouse, Cycle-Count Correction). Mirrors the
-- adjustment_type_master / rma_reason_master master shape (operator item 14
-- auto-code pattern): a named code with a sort order and an active flag.
--
-- IMPORTANT: this master is a REASON/category only — it is informational and
-- used for grouping/reporting. It does NOT drive any accounting. The Inventory
-- Transfers panel sources its reason picker from here, but the chosen reason
-- NAME is stored as free text on inventory_transfers.notes (no FK), so this
-- master is purely additive / backward-compatible.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS transfer_reason_master (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  code               text NOT NULL,
  name               text NOT NULL,
  sort_order         smallint NOT NULL DEFAULT 0,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT uq_transfer_reason_master_entity_code UNIQUE (entity_id, code)
);

CREATE INDEX IF NOT EXISTS idx_transfer_reason_master_entity_active
  ON transfer_reason_master (entity_id, is_active);

-- Touched timestamp
CREATE OR REPLACE FUNCTION transfer_reason_master_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS transfer_reason_master_touch_trg ON transfer_reason_master;
CREATE TRIGGER transfer_reason_master_touch_trg
  BEFORE UPDATE ON transfer_reason_master
  FOR EACH ROW EXECUTE FUNCTION transfer_reason_master_touch();

ALTER TABLE transfer_reason_master ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_transfer_reason_master" ON transfer_reason_master;
CREATE POLICY "anon_all_transfer_reason_master" ON transfer_reason_master
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_transfer_reason_master" ON transfer_reason_master;
CREATE POLICY "auth_internal_transfer_reason_master" ON transfer_reason_master
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

COMMENT ON TABLE  transfer_reason_master IS 'Tangerine inventory-transfer reason / category master. One row per reason per entity. Informational category only; does NOT drive accounting. The chosen reason NAME is stored on inventory_transfers.notes as free text (no FK).';
COMMENT ON COLUMN transfer_reason_master.code IS 'Server-generated read-only code XFRR-NNNNN. Unique per entity.';
COMMENT ON COLUMN transfer_reason_master.name IS 'Human transfer-reason label captured on inventory_transfers.notes as free text, e.g. Replenishment.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed a few sensible default reasons so the picklist starts populated.
-- Idempotent: only inserts a name that is not already present for the ROF
-- entity. Codes are intentionally NOT pre-assigned here (the handler auto-codes
-- new rows); these seeds reserve their own XFRR-NNNNN sequence positions so the
-- names exist on day one.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_entity_id uuid;
  v_seed      text;
  v_seq       int;
  v_names     text[] := ARRAY['Replenishment','Rebalance','Damage Move','Return to Warehouse','Cycle-Count Correction'];
BEGIN
  SELECT id INTO v_entity_id FROM entities WHERE code = 'ROF' LIMIT 1;
  IF v_entity_id IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(MAX((substring(code FROM 'XFRR-([0-9]+)'))::int), 0)
    INTO v_seq
    FROM transfer_reason_master
   WHERE entity_id = v_entity_id;

  FOREACH v_seed IN ARRAY v_names LOOP
    IF NOT EXISTS (
      SELECT 1 FROM transfer_reason_master
       WHERE entity_id = v_entity_id AND lower(name) = lower(v_seed)
    ) THEN
      v_seq := v_seq + 1;
      INSERT INTO transfer_reason_master (entity_id, code, name, sort_order, is_active)
      VALUES (v_entity_id, 'XFRR-' || lpad(v_seq::text, 5, '0'), v_seed, v_seq, true);
    END IF;
  END LOOP;
END $$;
