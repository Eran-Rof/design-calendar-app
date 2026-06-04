-- P16 / M18 — Product Allocations.
--
-- Allocating a confirmed sales order RESERVES on-hand inventory against its
-- lines (a soft reservation tracked by sales_order_lines.qty_allocated) — it
-- does NOT consume FIFO layers; that still happens at invoice/ship via
-- inventory_fifo_consume(). Available-to-allocate per item =
--   on-hand (Σ inventory_layers.remaining_qty)
--   − open reservations (Σ qty_allocated − qty_shipped on live SO lines).
--
-- Idempotent: CREATE OR REPLACE throughout. No partition scoping in this MVP
-- (BRAND_SCOPE_MODE is off in prod); a partition-aware refinement can net by
-- inventory_partition later.

-- ─── 1. v_inventory_available — on-hand minus open reservations, per item ─────
CREATE OR REPLACE VIEW v_inventory_available AS
WITH oh AS (
  SELECT entity_id, item_id, COALESCE(SUM(remaining_qty), 0)::numeric AS on_hand_qty
  FROM inventory_layers
  WHERE remaining_qty > 0
  GROUP BY entity_id, item_id
),
reserved AS (
  SELECT so.entity_id, sol.inventory_item_id AS item_id,
         COALESCE(SUM(GREATEST(sol.qty_allocated - sol.qty_shipped, 0)), 0)::numeric AS reserved_qty
  FROM sales_order_lines sol
  JOIN sales_orders so ON so.id = sol.sales_order_id
  WHERE sol.inventory_item_id IS NOT NULL
    AND sol.status <> 'cancelled'
    AND so.status NOT IN ('cancelled', 'closed')
  GROUP BY so.entity_id, sol.inventory_item_id
)
SELECT
  oh.entity_id,
  oh.item_id,
  oh.on_hand_qty,
  COALESCE(r.reserved_qty, 0) AS reserved_qty,
  (oh.on_hand_qty - COALESCE(r.reserved_qty, 0)) AS available_qty
FROM oh
LEFT JOIN reserved r ON r.entity_id = oh.entity_id AND r.item_id = oh.item_id;

COMMENT ON VIEW v_inventory_available IS 'P16/M18 — per-(entity,item) on-hand, open SO reservations, and available-to-allocate (on_hand − reserved). Reservation = Σ(qty_allocated − qty_shipped) on live SO lines.';

-- ─── 2. allocate_sales_order() — reserve available stock to a SO's lines ──────
CREATE OR REPLACE FUNCTION allocate_sales_order(p_so_id uuid, p_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_status   text;
  v_entity   uuid;
  v_line     record;
  v_avail    numeric;
  v_need     numeric;
  v_grant    numeric;
  v_lines    jsonb := '[]'::jsonb;
  v_all_full boolean := true;
BEGIN
  SELECT status, entity_id INTO v_status, v_entity FROM sales_orders WHERE id = p_so_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Sales order % not found', p_so_id;
  END IF;
  IF v_status NOT IN ('confirmed', 'allocated') THEN
    RAISE EXCEPTION 'Can only allocate a confirmed sales order (status is %)', v_status;
  END IF;

  -- Walk the lines that still need stock, allocating live-available qty to each.
  FOR v_line IN
    SELECT id, inventory_item_id, qty_ordered, qty_allocated, qty_shipped
    FROM sales_order_lines
    WHERE sales_order_id = p_so_id AND status <> 'cancelled'
    ORDER BY line_number
  LOOP
    v_need := v_line.qty_ordered - v_line.qty_allocated;
    IF v_line.inventory_item_id IS NULL OR v_need <= 0 THEN
      IF v_need > 0 THEN v_all_full := false; END IF;
      CONTINUE;
    END IF;

    SELECT GREATEST(COALESCE(available_qty, 0), 0) INTO v_avail
    FROM v_inventory_available
    WHERE entity_id = v_entity AND item_id = v_line.inventory_item_id;
    v_avail := COALESCE(v_avail, 0);

    v_grant := LEAST(v_need, v_avail);
    IF v_grant > 0 THEN
      UPDATE sales_order_lines
      SET qty_allocated = qty_allocated + v_grant,
          status = CASE WHEN (qty_allocated + v_grant) >= qty_ordered THEN 'allocated' ELSE status END,
          updated_at = now()
      WHERE id = v_line.id;
    END IF;

    IF (v_line.qty_allocated + v_grant) < v_line.qty_ordered THEN
      v_all_full := false;
    END IF;

    v_lines := v_lines || jsonb_build_object(
      'line_id', v_line.id,
      'item_id', v_line.inventory_item_id,
      'needed', v_need,
      'available', v_avail,
      'allocated', v_grant,
      'shortfall', GREATEST(v_need - v_grant, 0)
    );
  END LOOP;

  -- Header: 'allocated' only when every line is fully allocated; else stays 'confirmed'.
  UPDATE sales_orders
  SET status = CASE WHEN v_all_full THEN 'allocated' ELSE 'confirmed' END,
      updated_at = now()
  WHERE id = p_so_id;

  RETURN jsonb_build_object('sales_order_id', p_so_id, 'fully_allocated', v_all_full, 'lines', v_lines);
END;
$$;

COMMENT ON FUNCTION allocate_sales_order(uuid, uuid) IS 'P16/M18 — reserve available on-hand to a confirmed SO''s lines (soft reservation via qty_allocated). Header → allocated when all lines fully allocated, else stays confirmed (partial). Does not consume FIFO.';

NOTIFY pgrst, 'reload schema';
