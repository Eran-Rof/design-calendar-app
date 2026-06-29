-- ════════════════════════════════════════════════════════════════════════════
-- Manufacturing module (M2) — Part inventory FIFO (parallel to inventory_layers)
--
-- Parts (part_master) are kept SEPARATE from finished-style inventory. They get
-- their OWN FIFO cost layers + consumption ledger + consume RPC, mirroring the
-- M5 inventory_layers / inventory_consumption / inventory_fifo_consume design
-- but bound to part_master (NOT ip_item_master). This keeps parts entirely out
-- of the style FIFO engine, ATS, and sales/PO pickers.
--
-- Tables:
--   part_inventory_layers       — one row per receipt / opening balance /
--                                 positive adjustment / transfer-in. remaining_qty
--                                 drawn down via part_fifo_consume().
--   part_inventory_consumption  — append-only log of every FIFO draw.
-- RPC:
--   part_fifo_consume(p_entity_id, p_part_id, p_qty, p_consumer_kind,
--                     p_consumer_ref_id, p_user_id, p_location_id) RETURNS bigint
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS part_inventory_layers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  part_id              uuid NOT NULL REFERENCES part_master(id) ON DELETE RESTRICT,
  location_id          uuid REFERENCES inventory_locations(id) ON DELETE SET NULL,
  received_at          timestamptz NOT NULL,
  original_qty         numeric(18,4) NOT NULL,
  remaining_qty        numeric(18,4) NOT NULL,
  unit_cost_cents      bigint NOT NULL,
  source_kind          text NOT NULL,
  source_invoice_id    uuid REFERENCES invoices(id) ON DELETE SET NULL,
  -- FK-less (forward-compat with part_adjustments / build orders, like
  -- inventory_layers.source_adjustment_id did before P3-5).
  source_adjustment_id uuid,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT part_inventory_layers_source_kind_check
    CHECK (source_kind IN ('ap_invoice','adjustment','opening_balance','transfer_in','po_receipt')),
  CONSTRAINT part_inventory_layers_remaining_nonneg CHECK (remaining_qty >= 0),
  CONSTRAINT part_inventory_layers_original_positive CHECK (original_qty > 0),
  CONSTRAINT part_inventory_layers_unit_cost_nonneg CHECK (unit_cost_cents >= 0)
);
CREATE INDEX IF NOT EXISTS idx_part_inventory_layers_fifo_scan
  ON part_inventory_layers (entity_id, part_id, received_at);
CREATE INDEX IF NOT EXISTS idx_part_inventory_layers_open
  ON part_inventory_layers (entity_id, part_id, remaining_qty)
  WHERE remaining_qty > 0;

CREATE TABLE IF NOT EXISTS part_inventory_consumption (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id               uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  layer_id                uuid NOT NULL REFERENCES part_inventory_layers(id) ON DELETE RESTRICT,
  consumed_at             timestamptz NOT NULL DEFAULT now(),
  qty_consumed            numeric(18,4) NOT NULL,
  cogs_cents              bigint NOT NULL,
  consumer_kind           text NOT NULL,
  -- Set when consumer_kind='build_issue' (mfg_build_orders, M4) or for
  -- adjustment_decrease (part_adjustments). FK-less for forward-compat.
  consumer_build_order_id uuid,
  consumer_adjustment_id  uuid,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by_user_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT part_inventory_consumption_consumer_kind_check
    CHECK (consumer_kind IN ('build_issue','adjustment_decrease','transfer_out','write_off')),
  CONSTRAINT part_inventory_consumption_qty_positive CHECK (qty_consumed > 0),
  CONSTRAINT part_inventory_consumption_cogs_nonneg CHECK (cogs_cents >= 0)
);
CREATE INDEX IF NOT EXISTS idx_part_inventory_consumption_by_time
  ON part_inventory_consumption (entity_id, consumed_at);
CREATE INDEX IF NOT EXISTS idx_part_inventory_consumption_layer
  ON part_inventory_consumption (layer_id);

-- ════════════════════════════════════════════════════════════════════════════
-- RLS — anon_all + auth_internal (mirrors inventory_layers/_consumption).
-- part_inventory_consumption is append-only (SELECT + INSERT only).
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE part_inventory_layers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE part_inventory_consumption ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_part_inventory_layers" ON part_inventory_layers;
CREATE POLICY "anon_all_part_inventory_layers" ON part_inventory_layers
  FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_all_part_inventory_consumption" ON part_inventory_consumption;
CREATE POLICY "anon_all_part_inventory_consumption" ON part_inventory_consumption
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_part_inventory_layers" ON part_inventory_layers;
CREATE POLICY "auth_internal_part_inventory_layers" ON part_inventory_layers
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_part_inventory_consumption_select" ON part_inventory_consumption;
CREATE POLICY "auth_internal_part_inventory_consumption_select" ON part_inventory_consumption
  FOR SELECT TO authenticated
  USING (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
DROP POLICY IF EXISTS "auth_internal_part_inventory_consumption_insert" ON part_inventory_consumption;
CREATE POLICY "auth_internal_part_inventory_consumption_insert" ON part_inventory_consumption
  FOR INSERT TO authenticated
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- ════════════════════════════════════════════════════════════════════════════
-- RPC: part_fifo_consume — atomic FIFO draw bound to part_inventory_layers.
-- Mirrors inventory_fifo_consume; optional p_location_id scopes the draw to a
-- single location when supplied (NULL = draw across all locations).
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION part_fifo_consume(
  p_entity_id        uuid,
  p_part_id          uuid,
  p_qty              numeric,
  p_consumer_kind    text,
  p_consumer_ref_id  uuid,
  p_user_id          uuid,
  p_location_id      uuid DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_remaining       numeric(18,4) := p_qty;
  v_total_cogs      bigint        := 0;
  v_draw            numeric(18,4);
  v_layer           part_inventory_layers%ROWTYPE;
  v_consumer_bo_id  uuid;
  v_consumer_adj_id uuid;
BEGIN
  IF p_entity_id IS NULL THEN
    RAISE EXCEPTION 'part_fifo_consume: p_entity_id is required';
  END IF;
  IF p_part_id IS NULL THEN
    RAISE EXCEPTION 'part_fifo_consume: p_part_id is required';
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'part_fifo_consume: p_qty must be > 0 (got %)', p_qty;
  END IF;
  IF p_consumer_kind NOT IN ('build_issue','adjustment_decrease','transfer_out','write_off') THEN
    RAISE EXCEPTION 'part_fifo_consume: invalid p_consumer_kind %', p_consumer_kind;
  END IF;

  IF p_consumer_kind = 'build_issue' THEN
    v_consumer_bo_id := p_consumer_ref_id;
  ELSE
    v_consumer_adj_id := p_consumer_ref_id;
  END IF;

  FOR v_layer IN
    SELECT *
      FROM part_inventory_layers
     WHERE entity_id = p_entity_id
       AND part_id   = p_part_id
       AND remaining_qty > 0
       AND (p_location_id IS NULL OR location_id = p_location_id)
     ORDER BY received_at ASC, id ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_draw := LEAST(v_layer.remaining_qty, v_remaining);

    INSERT INTO part_inventory_consumption (
      entity_id, layer_id, consumed_at, qty_consumed, cogs_cents,
      consumer_kind, consumer_build_order_id, consumer_adjustment_id,
      created_by_user_id
    ) VALUES (
      p_entity_id, v_layer.id, now(), v_draw,
      (v_draw * v_layer.unit_cost_cents)::bigint,
      p_consumer_kind, v_consumer_bo_id, v_consumer_adj_id,
      p_user_id
    );

    UPDATE part_inventory_layers
       SET remaining_qty = remaining_qty - v_draw
     WHERE id = v_layer.id;

    v_total_cogs := v_total_cogs + (v_draw * v_layer.unit_cost_cents)::bigint;
    v_remaining  := v_remaining  - v_draw;
  END LOOP;

  IF v_remaining > 0 THEN
    RAISE EXCEPTION
      'Insufficient part inventory for part % (short by % units)',
      p_part_id, v_remaining;
  END IF;

  RETURN v_total_cogs;
END;
$$;

COMMENT ON FUNCTION part_fifo_consume(uuid, uuid, numeric, text, uuid, uuid, uuid) IS 'Atomic FIFO consume for (entity_id, part_id) against part_inventory_layers. Locks open layers FOR UPDATE in received_at order, draws down, logs to part_inventory_consumption, returns total cogs_cents. Raises on insufficient inventory. p_location_id optional.';
