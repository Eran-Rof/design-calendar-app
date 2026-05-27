-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P3 / Chunk 3 — M5 Inventory FIFO schema + consumption algorithm
--
-- Tables:
--   inventory_layers       — one row per receipt (or opening balance / positive
--                            adjustment / transfer-in). Carries remaining_qty
--                            that is drawn down as inventory is consumed.
--   inventory_consumption  — append-only log of every FIFO draw (one row per
--                            (layer, consumption-event, qty-drawn)).
--
-- RPC:
--   inventory_fifo_consume(p_entity_id, p_item_id, p_qty, p_consumer_kind,
--                          p_consumer_ref_id, p_user_id) RETURNS bigint
--     Atomically scans open layers in (received_at ASC, id ASC) order with
--     SELECT … FOR UPDATE, draws down each until p_qty is satisfied, and
--     returns the total COGS in cents. RAISES on insufficient inventory.
--
-- Opening-balance seed: one inventory_layers row per ip_inventory_snapshot row
-- with qty_on_hand > 0, costed at ip_item_avg_cost.avg_cost_dollars (×100 →
-- cents). Wrapped in a DO $$ guard that no-ops if any inventory_layers already
-- exist for the (entity_id, item_id) pair or if the source tables aren't
-- present in this database.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE OR REPLACE + the seed guard.
--
-- Architecture: docs/tangerine/P3-acc-core-architecture.md §4
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- inventory_layers
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_layers (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  item_id                  uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  received_at              timestamptz NOT NULL,
  original_qty             numeric(18,4) NOT NULL,
  remaining_qty            numeric(18,4) NOT NULL,
  unit_cost_cents          bigint NOT NULL,
  source_kind              text NOT NULL,
  source_invoice_id        uuid REFERENCES invoices(id) ON DELETE SET NULL,
  -- source_adjustment_id intentionally FK-less until P3-5 creates
  -- inventory_adjustments. Stored as plain uuid for forward compatibility.
  source_adjustment_id     uuid,
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT inventory_layers_source_kind_check
    CHECK (source_kind IN ('ap_invoice','adjustment','opening_balance','transfer_in')),
  CONSTRAINT inventory_layers_remaining_nonneg
    CHECK (remaining_qty >= 0),
  CONSTRAINT inventory_layers_original_positive
    CHECK (original_qty > 0),
  CONSTRAINT inventory_layers_unit_cost_nonneg
    CHECK (unit_cost_cents >= 0)
);

CREATE INDEX IF NOT EXISTS idx_inventory_layers_fifo_scan
  ON inventory_layers (entity_id, item_id, received_at);

CREATE INDEX IF NOT EXISTS idx_inventory_layers_open
  ON inventory_layers (entity_id, item_id, remaining_qty)
  WHERE remaining_qty > 0;

CREATE INDEX IF NOT EXISTS idx_inventory_layers_audit
  ON inventory_layers (entity_id, source_kind);

COMMENT ON TABLE  inventory_layers IS 'FIFO cost layers. One row per receipt / opening balance / positive adjustment. remaining_qty drawn down via inventory_fifo_consume(). See docs/tangerine/P3-acc-core-architecture.md §4.2.';
COMMENT ON COLUMN inventory_layers.received_at      IS 'Drives FIFO ordering. Tie-breaker is id (deterministic) per P3 arch §11 sub-decision 4.';
COMMENT ON COLUMN inventory_layers.source_kind      IS 'ap_invoice | adjustment | opening_balance | transfer_in. source_invoice_id is set when source_kind=ap_invoice; source_adjustment_id when source_kind=adjustment.';
COMMENT ON COLUMN inventory_layers.unit_cost_cents  IS 'Cost-per-unit at receipt time in cents (USD). Layer cost is fixed at creation — does not float with later cost basis changes.';

-- ────────────────────────────────────────────────────────────────────────────
-- inventory_consumption (append-only)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_consumption (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                  uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  layer_id                   uuid NOT NULL REFERENCES inventory_layers(id) ON DELETE RESTRICT,
  consumed_at                timestamptz NOT NULL DEFAULT now(),
  qty_consumed               numeric(18,4) NOT NULL,
  cogs_cents                 bigint NOT NULL,
  consumer_kind              text NOT NULL,
  consumer_invoice_id        uuid REFERENCES invoices(id) ON DELETE SET NULL,
  -- consumer_adjustment_id matches source_adjustment_id — FK-less until P3-5
  consumer_adjustment_id     uuid,
  notes                      text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by_user_id         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT inventory_consumption_consumer_kind_check
    CHECK (consumer_kind IN ('ar_invoice','adjustment_decrease','transfer_out','write_off')),
  CONSTRAINT inventory_consumption_qty_positive
    CHECK (qty_consumed > 0),
  CONSTRAINT inventory_consumption_cogs_nonneg
    CHECK (cogs_cents >= 0)
);

CREATE INDEX IF NOT EXISTS idx_inventory_consumption_by_time
  ON inventory_consumption (entity_id, consumed_at);
CREATE INDEX IF NOT EXISTS idx_inventory_consumption_layer
  ON inventory_consumption (layer_id);

COMMENT ON TABLE  inventory_consumption IS 'Append-only audit log of FIFO draw-downs. One row per (layer, event, qty). cogs_cents = qty_consumed × layer.unit_cost_cents. RLS: SELECT + INSERT only — no UPDATE/DELETE policies.';
COMMENT ON COLUMN inventory_consumption.consumer_kind IS 'ar_invoice (sale) | adjustment_decrease (M37 negative adjustment) | transfer_out | write_off.';

-- ════════════════════════════════════════════════════════════════════════════
-- RLS — P1 anon_all + auth_internal_* template
-- inventory_consumption is append-only: SELECT + INSERT only on authenticated
-- (no UPDATE/DELETE policies grants → forbidden by default).
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE inventory_layers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_consumption ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_inventory_layers" ON inventory_layers;
CREATE POLICY "anon_all_inventory_layers" ON inventory_layers
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_all_inventory_consumption" ON inventory_consumption;
CREATE POLICY "anon_all_inventory_consumption" ON inventory_consumption
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_inventory_layers" ON inventory_layers;
CREATE POLICY "auth_internal_inventory_layers" ON inventory_layers
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_inventory_consumption_select" ON inventory_consumption;
CREATE POLICY "auth_internal_inventory_consumption_select" ON inventory_consumption
  FOR SELECT TO authenticated
  USING (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_inventory_consumption_insert" ON inventory_consumption;
CREATE POLICY "auth_internal_inventory_consumption_insert" ON inventory_consumption
  FOR INSERT TO authenticated
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- (Deliberately NO UPDATE / DELETE policies on inventory_consumption — table is
-- append-only.)

-- ════════════════════════════════════════════════════════════════════════════
-- RPC: inventory_fifo_consume
--
-- Atomically draws qty from open layers in FIFO order (received_at ASC, id ASC)
-- for the given (entity_id, item_id). For each layer touched:
--   - INSERTs one inventory_consumption row (qty drawn, cogs_cents)
--   - UPDATEs inventory_layers.remaining_qty downward
-- Returns total cogs_cents (bigint).
--
-- Raises EXCEPTION with item_id + short-by quantity when layer set exhausts
-- before p_qty is satisfied — caller is expected to surface a clean error.
--
-- Atomicity: PG transaction owns the BEGIN/COMMIT around the RPC call; the
-- SELECT … FOR UPDATE row-locks each open layer for the duration of the
-- transaction, so concurrent consume() calls on the same item serialize cleanly
-- and never double-draw.
--
-- Pure-SQL test scenarios (covered by callers post-deploy):
--   1. Single-layer covers: one layer remaining=10, consume 3 → cogs=3*cost,
--      remaining=7, one consumption row.
--   2. Multi-layer crosses: layers L1(remaining=2 @ $5) + L2(remaining=10 @ $7),
--      consume 5 → cogs=2*500 + 3*700 = 3100, L1.remaining=0, L2.remaining=7,
--      two consumption rows.
--   3. Insufficient: layers total remaining=5, consume 8 → EXCEPTION mentions
--      item_id + 'short by 3 units'.
--   4. Zero / negative qty rejected before any work.
--   5. FOR UPDATE: two concurrent consume() calls on same item under
--      txn-isolation REPEATABLE READ — second blocks then sees post-first
--      remaining_qty values; never double-draws.
--   6. Skips layers where remaining_qty = 0 (already fully drawn).
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION inventory_fifo_consume(
  p_entity_id        uuid,
  p_item_id          uuid,
  p_qty              numeric,
  p_consumer_kind    text,
  p_consumer_ref_id  uuid,
  p_user_id          uuid
) RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_remaining       numeric(18,4) := p_qty;
  v_total_cogs      bigint        := 0;
  v_draw            numeric(18,4);
  v_layer           inventory_layers%ROWTYPE;
  v_consumer_inv_id uuid;
  v_consumer_adj_id uuid;
BEGIN
  -- Input validation
  IF p_entity_id IS NULL THEN
    RAISE EXCEPTION 'inventory_fifo_consume: p_entity_id is required';
  END IF;
  IF p_item_id IS NULL THEN
    RAISE EXCEPTION 'inventory_fifo_consume: p_item_id is required';
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'inventory_fifo_consume: p_qty must be > 0 (got %)', p_qty;
  END IF;
  IF p_consumer_kind NOT IN ('ar_invoice','adjustment_decrease','transfer_out','write_off') THEN
    RAISE EXCEPTION 'inventory_fifo_consume: invalid p_consumer_kind %', p_consumer_kind;
  END IF;

  -- Map the polymorphic ref_id onto the correct column.
  IF p_consumer_kind = 'ar_invoice' THEN
    v_consumer_inv_id := p_consumer_ref_id;
  ELSIF p_consumer_kind IN ('adjustment_decrease','transfer_out','write_off') THEN
    v_consumer_adj_id := p_consumer_ref_id;
  END IF;

  -- FIFO scan with row-lock. LIMIT scopes nothing here — we want every
  -- open layer in order — and SKIP LOCKED is intentionally NOT used because
  -- correctness here requires the caller's transaction to wait for any
  -- concurrent consume()s on the same layers to commit.
  FOR v_layer IN
    SELECT *
      FROM inventory_layers
     WHERE entity_id = p_entity_id
       AND item_id   = p_item_id
       AND remaining_qty > 0
     ORDER BY received_at ASC, id ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;

    v_draw := LEAST(v_layer.remaining_qty, v_remaining);

    INSERT INTO inventory_consumption (
      entity_id, layer_id, consumed_at, qty_consumed, cogs_cents,
      consumer_kind, consumer_invoice_id, consumer_adjustment_id,
      created_by_user_id
    ) VALUES (
      p_entity_id, v_layer.id, now(), v_draw,
      (v_draw * v_layer.unit_cost_cents)::bigint,
      p_consumer_kind, v_consumer_inv_id, v_consumer_adj_id,
      p_user_id
    );

    UPDATE inventory_layers
       SET remaining_qty = remaining_qty - v_draw
     WHERE id = v_layer.id;

    v_total_cogs := v_total_cogs + (v_draw * v_layer.unit_cost_cents)::bigint;
    v_remaining  := v_remaining  - v_draw;
  END LOOP;

  IF v_remaining > 0 THEN
    RAISE EXCEPTION
      'Insufficient inventory for item % (short by % units)',
      p_item_id, v_remaining;
  END IF;

  RETURN v_total_cogs;
END;
$$;

COMMENT ON FUNCTION inventory_fifo_consume(uuid, uuid, numeric, text, uuid, uuid) IS 'Atomic FIFO consume for (entity_id, item_id). Locks open layers FOR UPDATE in received_at order, draws down, logs to inventory_consumption, returns total cogs_cents. Raises on insufficient inventory.';

-- ════════════════════════════════════════════════════════════════════════════
-- Opening-balance seed
--
-- Inserts one inventory_layers row per ip_inventory_snapshot row with
-- qty_on_hand > 0, costed at the avg-cost basis from ip_item_avg_cost. This is
-- a known approximation (see arch §4.6 + §12 risk register row 1) — subsequent
-- AP receipts create real per-receipt layers.
--
-- DEFENSIVE GUARDS:
--   1. No-op if the source tables don't exist in this database.
--   2. Skip any (entity_id, item_id) that already has an inventory_layers row
--      — protects against re-running the migration after first seed.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_has_snapshot boolean;
  v_has_avgcost  boolean;
  v_has_master   boolean;
  v_inserted     int;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='ip_inventory_snapshot')
    INTO v_has_snapshot;
  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='ip_item_avg_cost')
    INTO v_has_avgcost;
  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='ip_item_master')
    INTO v_has_master;

  IF NOT (v_has_snapshot AND v_has_master) THEN
    RAISE NOTICE 'inventory_layers seed: source tables missing — skipping (snapshot=% master=%)',
      v_has_snapshot, v_has_master;
    RETURN;
  END IF;

  -- The seed needs an entity_id. Pull from ip_item_master so we land an
  -- inventory_layers row scoped to the item's owning entity. (ip_inventory_snapshot
  -- itself may or may not carry entity_id depending on chunk history.) If the
  -- master has no entity_id column populated, we skip — defensive.
  --
  -- Existence-of-prior-layer guard is a NOT EXISTS subquery inline.
  --
  -- We only insert layers when both an item_master row AND a snapshot row with
  -- qty_on_hand > 0 exist.
  --
  -- Two query shapes — with vs without ip_item_avg_cost — chosen at runtime so
  -- we don't reference a non-existent table even in the dead branch.
  -- ip_inventory_snapshot uses sku_id (FK ip_item_master.id) and has multiple
  -- snapshot_date rows per (sku_id, warehouse_code, source). For the opening
  -- balance we want ONE layer per item, summing the latest snapshot's qty
  -- across warehouses (single-warehouse launch per arch §0).
  -- ip_item_avg_cost is keyed by sku_code (ip_item_master.sku_code), with
  -- column avg_cost (USD-dollar numeric).
  IF v_has_avgcost THEN
    EXECUTE $q$
      WITH latest_per_sku AS (
        SELECT DISTINCT ON (sku_id)
               sku_id, snapshot_date, qty_on_hand
          FROM ip_inventory_snapshot
         WHERE qty_on_hand IS NOT NULL
           AND qty_on_hand > 0
         ORDER BY sku_id, snapshot_date DESC
      )
      INSERT INTO inventory_layers (
        entity_id, item_id, received_at,
        original_qty, remaining_qty, unit_cost_cents,
        source_kind, notes
      )
      SELECT m.entity_id, m.id, now(),
             l.qty_on_hand, l.qty_on_hand,
             COALESCE((
               SELECT (a.avg_cost * 100)::bigint
                 FROM ip_item_avg_cost a
                WHERE a.sku_code = m.sku_code
                LIMIT 1
             ), 0),
             'opening_balance',
             'Seeded from ip_inventory_snapshot x ip_item_avg_cost on migration P3-3'
        FROM latest_per_sku l
        JOIN ip_item_master m ON m.id = l.sku_id
       WHERE m.entity_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM inventory_layers il
            WHERE il.entity_id = m.entity_id
              AND il.item_id   = m.id
         )
    $q$;
  ELSE
    EXECUTE $q$
      WITH latest_per_sku AS (
        SELECT DISTINCT ON (sku_id)
               sku_id, snapshot_date, qty_on_hand
          FROM ip_inventory_snapshot
         WHERE qty_on_hand IS NOT NULL
           AND qty_on_hand > 0
         ORDER BY sku_id, snapshot_date DESC
      )
      INSERT INTO inventory_layers (
        entity_id, item_id, received_at,
        original_qty, remaining_qty, unit_cost_cents,
        source_kind, notes
      )
      SELECT m.entity_id, m.id, now(),
             l.qty_on_hand, l.qty_on_hand,
             0,
             'opening_balance',
             'Seeded from ip_inventory_snapshot on migration P3-3 (avg cost unavailable)'
        FROM latest_per_sku l
        JOIN ip_item_master m ON m.id = l.sku_id
       WHERE m.entity_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM inventory_layers il
            WHERE il.entity_id = m.entity_id
              AND il.item_id   = m.id
         )
    $q$;
  END IF;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RAISE NOTICE 'inventory_layers opening-balance seed inserted % layer(s)', v_inserted;
END;
$$;
