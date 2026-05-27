-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P3 / Chunk 5 — M37 Inventory Adjustments
--
-- Tables:
--   inventory_adjustments — one row per damage / shrinkage / found / correction
--                           / write_off / return_to_vendor event. Positive
--                           qty_delta carries unit_cost_cents (new layer);
--                           negative qty_delta is NULL on cost (drawn from FIFO).
--
-- FK additions (P3-3 left these as forward-compat plain uuids):
--   inventory_layers.source_adjustment_id      → inventory_adjustments(id) ON DELETE SET NULL
--   inventory_consumption.consumer_adjustment_id → inventory_adjustments(id) ON DELETE SET NULL
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + DO $$ guarded constraint adds.
--
-- Architecture: docs/tangerine/P3-acc-core-architecture.md §5.2 / §5.3.
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- inventory_adjustments
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_adjustments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  item_id                  uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  adjustment_type          text NOT NULL,
  qty_delta                numeric(18,4) NOT NULL,
  unit_cost_cents          bigint,           -- required when qty_delta > 0, NULL when qty_delta < 0
  reason                   text NOT NULL,
  gl_account_id            uuid NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  posted_je_id             uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  posted_at                timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT inventory_adjustments_type_check
    CHECK (adjustment_type IN (
      'damage','shrinkage','found','correction','write_off','return_to_vendor'
    )),
  -- Either qty_delta > 0 with non-null non-negative unit_cost_cents (new layer
  -- creation), OR qty_delta < 0 with NULL unit_cost_cents (FIFO-drawn). The
  -- zero-delta case is rejected so we never have a no-op posting.
  CONSTRAINT inventory_adjustments_qty_cost_check
    CHECK (
      (qty_delta > 0 AND unit_cost_cents IS NOT NULL AND unit_cost_cents >= 0)
      OR
      (qty_delta < 0 AND unit_cost_cents IS NULL)
    ),
  CONSTRAINT inventory_adjustments_reason_nonempty
    CHECK (length(btrim(reason)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_entity_item_created
  ON inventory_adjustments (entity_id, item_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_posted
  ON inventory_adjustments (entity_id, posted_je_id)
  WHERE posted_je_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_unposted
  ON inventory_adjustments (entity_id, created_at DESC)
  WHERE posted_je_id IS NULL;

COMMENT ON TABLE  inventory_adjustments IS 'M37 inventory adjustments (damage / shrinkage / found / correction / write_off / return_to_vendor). Positive qty_delta requires unit_cost_cents and creates an inventory_layers row at posting. Negative qty_delta calls inventory_fifo_consume() at posting. Arch §5.2.';
COMMENT ON COLUMN inventory_adjustments.qty_delta       IS 'Signed quantity delta. Positive = layer creation. Negative = FIFO consume. Zero rejected by CHECK.';
COMMENT ON COLUMN inventory_adjustments.unit_cost_cents IS 'Per-unit cost in cents (USD). Required when qty_delta > 0; MUST be NULL when qty_delta < 0 (cost is FIFO-derived at post time).';
COMMENT ON COLUMN inventory_adjustments.gl_account_id   IS 'Counter account for the JE. Typically a shrinkage / damage / write-off expense for negative adjustments, or contra-revenue / inventory-found income for positives.';
COMMENT ON COLUMN inventory_adjustments.posted_je_id    IS 'Set after post-event flow; presence indicates posted (vs draft).';

-- ────────────────────────────────────────────────────────────────────────────
-- Touch trigger
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION inventory_adjustments_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inventory_adjustments_touch_trg ON inventory_adjustments;
CREATE TRIGGER inventory_adjustments_touch_trg
  BEFORE UPDATE ON inventory_adjustments
  FOR EACH ROW EXECUTE FUNCTION inventory_adjustments_touch();

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — P1 anon_all + auth_internal_* template
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE inventory_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_inventory_adjustments" ON inventory_adjustments;
CREATE POLICY "anon_all_inventory_adjustments" ON inventory_adjustments
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_inventory_adjustments" ON inventory_adjustments;
CREATE POLICY "auth_internal_inventory_adjustments" ON inventory_adjustments
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- ════════════════════════════════════════════════════════════════════════════
-- Forward-FK back-fill on the P3-3 placeholder columns.
--
-- The P3-3 migration deliberately left `source_adjustment_id` /
-- `consumer_adjustment_id` as FK-less uuids because this table did not exist
-- yet. Now that it does, add the constraints. Guarded so re-runs no-op.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'inventory_layers_source_adjustment_fk'
  ) THEN
    ALTER TABLE inventory_layers
      ADD CONSTRAINT inventory_layers_source_adjustment_fk
      FOREIGN KEY (source_adjustment_id)
      REFERENCES inventory_adjustments(id)
      ON DELETE SET NULL;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'inventory_consumption_consumer_adjustment_fk'
  ) THEN
    ALTER TABLE inventory_consumption
      ADD CONSTRAINT inventory_consumption_consumer_adjustment_fk
      FOREIGN KEY (consumer_adjustment_id)
      REFERENCES inventory_adjustments(id)
      ON DELETE SET NULL;
  END IF;
END;
$$;
