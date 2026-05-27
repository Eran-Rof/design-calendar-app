-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P3 / Chunk 6 — M37 Inventory Cycle Counts
--
-- Tables:
--   inventory_cycle_counts        — one row per cycle count session (snapshot
--                                   of system_qty per item taken at start).
--   inventory_cycle_count_lines   — one row per (cycle_count, item). counted_qty
--                                   is NULL until operator enters it; variance
--                                   is a GENERATED column (counted - system).
--                                   adjustment_id links to the
--                                   inventory_adjustments row generated at
--                                   finalize time.
--
-- The adjustment_id column is declared as a plain uuid (no FK) until the
-- inventory_adjustments table lands in P3-5. A separate ALTER ADD CONSTRAINT
-- step inside a DO $$ block back-fills the FK iff the inventory_adjustments
-- table exists in the target database. This keeps the migration order-
-- independent across P3-5 and P3-6.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE OR REPLACE + DO $$ guard
-- on the conditional FK.
--
-- Architecture: docs/tangerine/P3-acc-core-architecture.md §5.2 / §5.3.
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- inventory_cycle_counts
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_cycle_counts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  count_date               date NOT NULL DEFAULT current_date,
  location                 text NOT NULL DEFAULT 'main',
  status                   text NOT NULL DEFAULT 'in_progress',
  counted_by_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT inventory_cycle_counts_status_check
    CHECK (status IN ('in_progress','completed','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_inventory_cycle_counts_entity_date
  ON inventory_cycle_counts (entity_id, count_date DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_cycle_counts_entity_status
  ON inventory_cycle_counts (entity_id, status);

COMMENT ON TABLE  inventory_cycle_counts IS 'M37 Cycle Count session header. Snapshot of system_qty taken at start (per-line). Finalize generates one inventory_adjustments row per non-zero variance. See docs/tangerine/P3-acc-core-architecture.md §5.2.';
COMMENT ON COLUMN inventory_cycle_counts.location IS 'Single-location launch defaults to ''main''. Multi-warehouse expands this to a real location reference.';
COMMENT ON COLUMN inventory_cycle_counts.status   IS 'in_progress (operator entering counts) | completed (finalize done, variances flushed to adjustments) | cancelled (abandoned).';

-- Touch trigger
CREATE OR REPLACE FUNCTION inventory_cycle_counts_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inventory_cycle_counts_touch_trg ON inventory_cycle_counts;
CREATE TRIGGER inventory_cycle_counts_touch_trg
  BEFORE UPDATE ON inventory_cycle_counts
  FOR EACH ROW EXECUTE FUNCTION inventory_cycle_counts_touch();

ALTER TABLE inventory_cycle_counts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_inventory_cycle_counts" ON inventory_cycle_counts;
CREATE POLICY "anon_all_inventory_cycle_counts" ON inventory_cycle_counts
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_inventory_cycle_counts" ON inventory_cycle_counts;
CREATE POLICY "auth_internal_inventory_cycle_counts" ON inventory_cycle_counts
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- ────────────────────────────────────────────────────────────────────────────
-- inventory_cycle_count_lines
--   variance_qty is GENERATED ALWAYS AS (counted_qty - system_qty) STORED.
--   With counted_qty nullable the result is NULL until the operator enters
--   a count, which is the desired UX (don't show a fake "0" variance).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_cycle_count_lines (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_count_id           uuid NOT NULL REFERENCES inventory_cycle_counts(id) ON DELETE CASCADE,
  item_id                  uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  system_qty               numeric(18,4) NOT NULL,
  counted_qty              numeric(18,4),
  variance_qty             numeric(18,4) GENERATED ALWAYS AS (counted_qty - system_qty) STORED,
  -- adjustment_id stays FK-less until P3-5's inventory_adjustments exists.
  -- A conditional ALTER ADD CONSTRAINT below back-fills the FK whenever the
  -- target table is present, so this works in any migration order.
  adjustment_id            uuid,
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT inventory_cycle_count_lines_system_qty_nonneg
    CHECK (system_qty >= 0),
  CONSTRAINT inventory_cycle_count_lines_counted_qty_nonneg
    CHECK (counted_qty IS NULL OR counted_qty >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_cycle_count_lines_count_item
  ON inventory_cycle_count_lines (cycle_count_id, item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_cycle_count_lines_cycle
  ON inventory_cycle_count_lines (cycle_count_id);
CREATE INDEX IF NOT EXISTS idx_inventory_cycle_count_lines_item
  ON inventory_cycle_count_lines (item_id);

COMMENT ON TABLE  inventory_cycle_count_lines IS 'One row per (cycle_count, item). system_qty is snapshot at start. variance_qty is GENERATED (counted - system, NULL until counted). adjustment_id linked when variance flushed via finalize.';
COMMENT ON COLUMN inventory_cycle_count_lines.system_qty   IS 'Snapshot of SUM(inventory_layers.remaining_qty) at the moment the cycle count was started. Frozen for the duration of the count.';
COMMENT ON COLUMN inventory_cycle_count_lines.counted_qty  IS 'Operator-entered physical count. NULL until entered. Once non-NULL, variance_qty is computed.';
COMMENT ON COLUMN inventory_cycle_count_lines.variance_qty IS 'GENERATED counted - system. NULL while counted_qty is NULL. Drives the finalize → inventory_adjustments fan-out.';

CREATE OR REPLACE FUNCTION inventory_cycle_count_lines_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inventory_cycle_count_lines_touch_trg ON inventory_cycle_count_lines;
CREATE TRIGGER inventory_cycle_count_lines_touch_trg
  BEFORE UPDATE ON inventory_cycle_count_lines
  FOR EACH ROW EXECUTE FUNCTION inventory_cycle_count_lines_touch();

ALTER TABLE inventory_cycle_count_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_inventory_cycle_count_lines" ON inventory_cycle_count_lines;
CREATE POLICY "anon_all_inventory_cycle_count_lines" ON inventory_cycle_count_lines
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_inventory_cycle_count_lines" ON inventory_cycle_count_lines;
CREATE POLICY "auth_internal_inventory_cycle_count_lines" ON inventory_cycle_count_lines
  FOR ALL TO authenticated
  USING      (
    cycle_count_id IN (
      SELECT cc.id FROM inventory_cycle_counts cc
      WHERE cc.entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())
    )
  )
  WITH CHECK (
    cycle_count_id IN (
      SELECT cc.id FROM inventory_cycle_counts cc
      WHERE cc.entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())
    )
  );

-- ────────────────────────────────────────────────────────────────────────────
-- Conditional FK back-fill: if inventory_adjustments table exists (P3-5
-- shipped), wire adjustment_id → inventory_adjustments(id) ON DELETE SET NULL.
-- Wrapped in DO $$ + IF EXISTS to keep this migration robust to either
-- chunk-merge order.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'inventory_adjustments'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'inventory_cycle_count_lines'
      AND constraint_name = 'inventory_cycle_count_lines_adjustment_id_fkey'
  ) THEN
    ALTER TABLE inventory_cycle_count_lines
      ADD CONSTRAINT inventory_cycle_count_lines_adjustment_id_fkey
      FOREIGN KEY (adjustment_id)
      REFERENCES inventory_adjustments(id)
      ON DELETE SET NULL;
  END IF;
END $$;
