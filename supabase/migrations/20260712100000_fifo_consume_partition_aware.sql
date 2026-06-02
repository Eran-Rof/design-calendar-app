-- P15 stock-pool — partition-aware FIFO consumption.
--
-- A sale (or other consume) can now draw from a specific brand pool. Adds an
-- optional p_partition_id to inventory_fifo_consume: when NULL (the default, and
-- what every caller passes today) behavior is IDENTICAL to before — draws across
-- all of an item's open layers. When a partition is supplied (only when
-- BRAND_SCOPE_MODE=enforce, set by the caller), the scan is limited to layers in
-- that pool PLUS legacy unpartitioned layers (partition_id IS NULL), so existing
-- forward-only stock stays consumable.
--
-- Also records which pool each draw came from on inventory_consumption.
-- Idempotent. INERT by default (callers pass NULL until enforcement).

ALTER TABLE inventory_consumption
  ADD COLUMN IF NOT EXISTS partition_id uuid REFERENCES inventory_partition(id);

-- Adding a parameter changes the signature → drop the old 6-arg function first.
DROP FUNCTION IF EXISTS inventory_fifo_consume(uuid, uuid, numeric, text, uuid, uuid);

CREATE OR REPLACE FUNCTION inventory_fifo_consume(
  p_entity_id        uuid,
  p_item_id          uuid,
  p_qty              numeric,
  p_consumer_kind    text,
  p_consumer_ref_id  uuid,
  p_user_id          uuid,
  p_partition_id     uuid DEFAULT NULL
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

  IF p_consumer_kind = 'ar_invoice' THEN
    v_consumer_inv_id := p_consumer_ref_id;
  ELSIF p_consumer_kind IN ('adjustment_decrease','transfer_out','write_off') THEN
    v_consumer_adj_id := p_consumer_ref_id;
  END IF;

  -- FIFO scan with row-lock. When a partition is supplied, restrict to that pool
  -- plus legacy unpartitioned stock; otherwise (NULL) draw across all layers.
  FOR v_layer IN
    SELECT *
      FROM inventory_layers
     WHERE entity_id = p_entity_id
       AND item_id   = p_item_id
       AND remaining_qty > 0
       AND (p_partition_id IS NULL
            OR partition_id = p_partition_id
            OR partition_id IS NULL)
     ORDER BY received_at ASC, id ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;

    v_draw := LEAST(v_layer.remaining_qty, v_remaining);

    INSERT INTO inventory_consumption (
      entity_id, layer_id, consumed_at, qty_consumed, cogs_cents,
      consumer_kind, consumer_invoice_id, consumer_adjustment_id,
      partition_id, created_by_user_id
    ) VALUES (
      p_entity_id, v_layer.id, now(), v_draw,
      (v_draw * v_layer.unit_cost_cents)::bigint,
      p_consumer_kind, v_consumer_inv_id, v_consumer_adj_id,
      v_layer.partition_id, p_user_id
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

COMMENT ON FUNCTION inventory_fifo_consume(uuid, uuid, numeric, text, uuid, uuid, uuid) IS
  'Atomic FIFO consume for (entity_id, item_id). Optional p_partition_id (P15) limits the draw to that brand pool + unpartitioned layers; NULL = all layers (default, pre-P15 behavior). Logs to inventory_consumption (incl. the layer pool), returns total cogs_cents.';

NOTIFY pgrst, 'reload schema';
