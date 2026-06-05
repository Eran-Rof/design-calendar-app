-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine — Adjustment Type Master (adjustment_type_master)
-- A configurable, auto-coded master listing the inventory-adjustment CATEGORIES
-- / reasons an inventory adjustment can be tagged with (e.g. Shrinkage, Damage,
-- Found, Cycle Count, Write-off, Return to Vendor). Mirrors the rma_reason_master
-- / season_master master shape (operator item 14 auto-code pattern): a named
-- code with a sort order and an active flag.
--
-- IMPORTANT: this master is a CATEGORY/reason only — it is informational and used
-- for grouping/reporting. It does NOT drive the increase/decrease FIFO accounting,
-- which is governed purely by the adjustment qty sign + unit cost. The previous
-- fixed enum (damage/shrinkage/found/correction/write_off/return_to_vendor) is
-- replaced by this CRUD list. inventory_adjustments.adjustment_type stays a plain
-- TEXT column storing the chosen type NAME (NOT an FK), so this master is purely
-- additive / backward-compatible: the Adjustments panel sources its type dropdown
-- from here but still writes the plain name string.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS adjustment_type_master (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  code               text NOT NULL,
  name               text NOT NULL,
  sort_order         smallint NOT NULL DEFAULT 0,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT uq_adjustment_type_master_entity_code UNIQUE (entity_id, code)
);

CREATE INDEX IF NOT EXISTS idx_adjustment_type_master_entity_active
  ON adjustment_type_master (entity_id, is_active);

-- Touched timestamp
CREATE OR REPLACE FUNCTION adjustment_type_master_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS adjustment_type_master_touch_trg ON adjustment_type_master;
CREATE TRIGGER adjustment_type_master_touch_trg
  BEFORE UPDATE ON adjustment_type_master
  FOR EACH ROW EXECUTE FUNCTION adjustment_type_master_touch();

ALTER TABLE adjustment_type_master ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_adjustment_type_master" ON adjustment_type_master;
CREATE POLICY "anon_all_adjustment_type_master" ON adjustment_type_master
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_adjustment_type_master" ON adjustment_type_master;
CREATE POLICY "auth_internal_adjustment_type_master" ON adjustment_type_master
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

COMMENT ON TABLE  adjustment_type_master IS 'Tangerine inventory-adjustment type / category master. One row per type per entity. Informational category only; does NOT drive FIFO accounting. inventory_adjustments.adjustment_type stores the chosen type NAME as free text (no FK).';
COMMENT ON COLUMN adjustment_type_master.code IS 'Server-generated read-only code ADJT-NNNNN. Unique per entity.';
COMMENT ON COLUMN adjustment_type_master.name IS 'Human adjustment-type label stored on inventory_adjustments.adjustment_type as free text, e.g. Shrinkage.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed the legacy fixed enum values so existing adjustments keep a matching
-- master row + the picklist starts populated. Idempotent: only inserts a name
-- that is not already present for the ROF entity. Codes are intentionally NOT
-- pre-assigned here (the handler auto-codes new rows); these seeds reserve their
-- own ADJT-NNNNN sequence positions so the names exist on day one.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_entity_id uuid;
  v_seed      text;
  v_seq       int;
  v_names     text[] := ARRAY['Shrinkage','Damage','Found','Correction','Write-off','Return to Vendor','Cycle Count'];
BEGIN
  SELECT id INTO v_entity_id FROM entities WHERE code = 'ROF' LIMIT 1;
  IF v_entity_id IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(MAX((substring(code FROM 'ADJT-([0-9]+)'))::int), 0)
    INTO v_seq
    FROM adjustment_type_master
   WHERE entity_id = v_entity_id;

  FOREACH v_seed IN ARRAY v_names LOOP
    IF NOT EXISTS (
      SELECT 1 FROM adjustment_type_master
       WHERE entity_id = v_entity_id AND lower(name) = lower(v_seed)
    ) THEN
      v_seq := v_seq + 1;
      INSERT INTO adjustment_type_master (entity_id, code, name, sort_order, is_active)
      VALUES (v_entity_id, 'ADJT-' || lpad(v_seq::text, 5, '0'), v_seed, v_seq, true);
    END IF;
  END LOOP;
END $$;
