-- Manufacturing module (M2) — Part adjustments (opening balance + corrections).
--
-- The parts analogue of inventory_adjustments. Each row records a signed change
-- to a part's on-hand: positive creates a FIFO layer (opening balance / found /
-- correction-up), negative FIFO-consumes (damage / shrinkage / write-off). The
-- posting rule `part_adjustment` capitalizes positives to 1360 Inventory-Parts
-- and expenses/recognizes negatives against the chosen counter (gl_account_id).
CREATE TABLE IF NOT EXISTS part_adjustments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  part_id            uuid NOT NULL REFERENCES part_master(id) ON DELETE RESTRICT,
  location_id        uuid REFERENCES inventory_locations(id) ON DELETE SET NULL,
  adjustment_type    text NOT NULL
    CHECK (adjustment_type IN ('opening_balance','found','correction','damage','shrinkage','write_off')),
  qty_delta          numeric(18,4) NOT NULL,
  unit_cost_cents    bigint,
  reason             text NOT NULL,
  gl_account_id      uuid NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  posted_je_id       uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  posted_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT part_adjustments_qty_delta_nonzero CHECK (qty_delta <> 0),
  -- Positive needs a unit cost (to author the layer); negative must omit it
  -- (FIFO derives the cost).
  CONSTRAINT part_adjustments_cost_sign_check CHECK (
    (qty_delta > 0 AND unit_cost_cents IS NOT NULL AND unit_cost_cents >= 0)
    OR (qty_delta < 0 AND unit_cost_cents IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS part_adjustments_entity_part_idx ON part_adjustments(entity_id, part_id);

ALTER TABLE part_adjustments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_part_adjustments" ON part_adjustments;
CREATE POLICY "anon_all_part_adjustments" ON part_adjustments
  FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "auth_internal_part_adjustments" ON part_adjustments;
CREATE POLICY "auth_internal_part_adjustments" ON part_adjustments
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
