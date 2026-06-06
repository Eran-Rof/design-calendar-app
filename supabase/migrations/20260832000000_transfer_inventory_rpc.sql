-- Multi-warehouse: location-scoped FIFO (M52, part 2 — the stock-moving engine).
--
-- transfer_inventory_between_locations() actually MOVES on-hand between two
-- warehouses for one item, FIFO (oldest cost layers first), preserving cost
-- basis (an internal move has no GL/COGS impact). It decrements the source
-- layers and creates matching destination layers at the same unit cost. The
-- destination layer keeps the source's received_at so FIFO age is preserved,
-- and copies partition_id (P15 brand pool) so brand scoping is unaffected.
--
-- Conservation: every unit removed from the source is re-created at the
-- destination — total on-hand is invariant. Raises (rolls back) if the source
-- lacks enough on-hand.

CREATE OR REPLACE FUNCTION transfer_inventory_between_locations(
  p_item_id          uuid,
  p_qty              numeric,
  p_from_location_id uuid,
  p_to_location_id   uuid,
  p_user_id          uuid DEFAULT NULL,
  p_notes            text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_remaining numeric := p_qty;
  v_avail     numeric;
  v_layer     inventory_layers%ROWTYPE;
  v_take      numeric;
  v_dest_name text;
  v_moved     numeric := 0;
BEGIN
  IF p_item_id IS NULL OR p_from_location_id IS NULL OR p_to_location_id IS NULL THEN
    RAISE EXCEPTION 'item_id, from_location_id and to_location_id are required';
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'qty must be positive';
  END IF;
  IF p_from_location_id = p_to_location_id THEN
    RAISE EXCEPTION 'from and to locations must differ';
  END IF;

  -- On-hand available at the source for this item.
  SELECT COALESCE(sum(remaining_qty), 0) INTO v_avail
    FROM inventory_layers
   WHERE item_id = p_item_id AND location_id = p_from_location_id AND remaining_qty > 0;

  IF v_avail < p_qty THEN
    RAISE EXCEPTION 'Insufficient on-hand at source location (have %, need %)', v_avail, p_qty;
  END IF;

  SELECT name INTO v_dest_name FROM inventory_locations WHERE id = p_to_location_id;

  -- FIFO: drain the oldest source layers first.
  FOR v_layer IN
    SELECT * FROM inventory_layers
     WHERE item_id = p_item_id AND location_id = p_from_location_id AND remaining_qty > 0
     ORDER BY received_at ASC NULLS FIRST, created_at ASC
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_layer.remaining_qty, v_remaining);

    -- Decrement the source layer.
    UPDATE inventory_layers
       SET remaining_qty = remaining_qty - v_take
     WHERE id = v_layer.id;

    -- Re-create the moved quantity at the destination, same cost basis.
    INSERT INTO inventory_layers (
      entity_id, item_id, received_at, original_qty, remaining_qty,
      unit_cost_cents, source_kind, location_id, partition_id, notes, created_by_user_id
    ) VALUES (
      v_layer.entity_id, p_item_id, v_layer.received_at, v_take, v_take,
      v_layer.unit_cost_cents, 'transfer_in', p_to_location_id, v_layer.partition_id,
      'wh=' || COALESCE(v_dest_name, '')
        || CASE WHEN p_notes IS NOT NULL AND btrim(p_notes) <> '' THEN ' | ' || p_notes ELSE '' END,
      p_user_id
    );

    v_remaining := v_remaining - v_take;
    v_moved     := v_moved + v_take;
  END LOOP;

  RETURN jsonb_build_object(
    'moved', v_moved,
    'item_id', p_item_id,
    'from_location_id', p_from_location_id,
    'to_location_id', p_to_location_id
  );
END
$$;
