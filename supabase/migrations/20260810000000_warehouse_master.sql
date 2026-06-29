-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine — Warehouse Master
--
-- Reuses the EXISTING `inventory_locations` table (created P12-0,
-- 20260629200000_p12_chunk0_marketplaces_shared.sql) rather than creating a
-- duplicate `warehouse_master` table. The Warehouse Master admin panel curates
-- the operator-owned warehouse rows (kind='warehouse'); the marketplace/3pl
-- kinds (fba/wfs/3pl/dropship/virtual) are managed elsewhere by their channel
-- integrations.
--
-- This migration is purely ADDITIVE — it adds the master-pattern columns the
-- existing table lacked (address, sort_order, updated_at) plus a touch trigger,
-- so the CRUD panel matches the just-shipped masters (Season #948, RMA #957).
-- Fully idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, DROP/CREATE.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE inventory_locations
  ADD COLUMN IF NOT EXISTS address    text;
ALTER TABLE inventory_locations
  ADD COLUMN IF NOT EXISTS sort_order smallint NOT NULL DEFAULT 0;
ALTER TABLE inventory_locations
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_inventory_locations_entity_active
  ON inventory_locations (entity_id, is_active);

-- Touched timestamp — keeps updated_at fresh on every PATCH from the panel.
CREATE OR REPLACE FUNCTION inventory_locations_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inventory_locations_touch_trg ON inventory_locations;
CREATE TRIGGER inventory_locations_touch_trg
  BEFORE UPDATE ON inventory_locations
  FOR EACH ROW EXECUTE FUNCTION inventory_locations_touch();

COMMENT ON COLUMN inventory_locations.address    IS 'Optional free-text warehouse address surfaced by the Warehouse Master panel.';
COMMENT ON COLUMN inventory_locations.sort_order IS 'Display ordering for the Warehouse Master picklist. Lower sorts first.';
COMMENT ON COLUMN inventory_locations.updated_at IS 'Touched by inventory_locations_touch_trg on every update.';
