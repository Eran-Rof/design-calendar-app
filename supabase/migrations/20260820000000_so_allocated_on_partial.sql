-- PR #1005 / M18 — flip a sales order to `allocated` as soon as it has ANY
-- allocated quantity (partial allocation is still "allocated"/in-progress).
--
-- The original apply_allocations (#725 / 20260714010000) only promoted an SO to
-- `allocated` when EVERY live line was fully allocated, and otherwise reverted
-- it back to `confirmed`. The operator wants the header to reflect that work has
-- started: any allocated qty > 0 on a confirmed SO → `allocated`. Releasing all
-- allocation (back to 0) reverts `allocated` → `confirmed`. Orders already at
-- `fulfilling`/`shipped`/`invoiced`/`closed`/`cancelled` are never touched.
--
-- This re-CREATE OR REPLACEs the whole function; only the per-touched-SO header
-- recompute block at the bottom changed (the allocate/validate body is byte-for
-- -byte the same as 20260714010000). Idempotent.

CREATE OR REPLACE FUNCTION apply_allocations(p_allocations jsonb, p_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_el        jsonb;
  v_line_id   uuid;
  v_so_id     uuid;
  v_qty       numeric;
  v_line      record;
  v_avail     numeric;
  v_running   numeric;
  v_delta     numeric;
  v_new       numeric;
  v_so_cents  numeric;
  v_applied   jsonb := '[]'::jsonb;
  v_skipped   jsonb := '[]'::jsonb;
  v_pool      jsonb := '{}'::jsonb;     -- item_id::text -> remaining available
  v_touched   uuid[] := '{}';
BEGIN
  FOR v_el IN SELECT * FROM jsonb_array_elements(COALESCE(p_allocations, '[]'::jsonb))
  LOOP
    v_line_id := NULLIF(v_el->>'line_id', '')::uuid;
    v_qty     := COALESCE((v_el->>'qty')::numeric, 0);
    IF v_line_id IS NULL THEN
      v_skipped := v_skipped || jsonb_build_object('line_id', NULL, 'reason', 'missing line_id');
      CONTINUE;
    END IF;

    SELECT sol.id, sol.sales_order_id, sol.inventory_item_id, sol.qty_ordered,
           sol.qty_allocated, sol.qty_shipped, sol.status AS line_status,
           so.entity_id, so.customer_id,
           so.factor_approval_status, so.factor_reference, so.factor_approved_cents,
           COALESCE(c.is_factored, false) AS is_factored
      INTO v_line
      FROM sales_order_lines sol
      JOIN sales_orders so ON so.id = sol.sales_order_id
      LEFT JOIN customers c ON c.id = so.customer_id
     WHERE sol.id = v_line_id;

    IF NOT FOUND THEN
      v_skipped := v_skipped || jsonb_build_object('line_id', v_line_id, 'reason', 'line not found');
      CONTINUE;
    END IF;
    IF v_line.inventory_item_id IS NULL THEN
      v_skipped := v_skipped || jsonb_build_object('line_id', v_line_id, 'reason', 'no item on line');
      CONTINUE;
    END IF;
    IF v_line.line_status IN ('shipped', 'invoiced', 'cancelled') THEN
      v_skipped := v_skipped || jsonb_build_object('line_id', v_line_id, 'reason', 'line ' || v_line.line_status);
      CONTINUE;
    END IF;

    -- Clamp target into [qty_shipped, qty_ordered].
    v_qty := GREATEST(LEAST(v_qty, v_line.qty_ordered), v_line.qty_shipped);

    -- Seed the running available pool for this item from v_inventory_available.
    IF NOT (v_pool ? v_line.inventory_item_id::text) THEN
      SELECT GREATEST(COALESCE(available_qty, 0), 0) INTO v_avail
        FROM v_inventory_available
       WHERE entity_id = v_line.entity_id AND item_id = v_line.inventory_item_id;
      v_pool := jsonb_set(v_pool, ARRAY[v_line.inventory_item_id::text], to_jsonb(COALESCE(v_avail, 0)));
    END IF;
    v_running := (v_pool->>v_line.inventory_item_id::text)::numeric;

    -- Incremental reservation delta; cap an INCREASE by what's available.
    v_delta := v_qty - v_line.qty_allocated;
    IF v_delta > v_running THEN
      v_qty   := v_line.qty_allocated + GREATEST(v_running, 0);
      v_delta := v_qty - v_line.qty_allocated;
    END IF;
    v_new := v_qty;

    -- Hard factor-credit gate (only blocks INCREASES on factored customers).
    IF v_line.is_factored AND v_delta > 0 THEN
      IF COALESCE(v_line.factor_approval_status, '') <> 'approved' THEN
        v_skipped := v_skipped || jsonb_build_object('line_id', v_line_id, 'reason', 'factor not approved');
        CONTINUE;
      END IF;
      IF COALESCE(NULLIF(TRIM(v_line.factor_reference), ''), NULL) IS NULL THEN
        v_skipped := v_skipped || jsonb_build_object('line_id', v_line_id, 'reason', 'factor reference missing');
        CONTINUE;
      END IF;
      -- Resulting SO allocated $ across live lines (this line at its new alloc).
      SELECT COALESCE(SUM(
               (CASE WHEN id = v_line.id THEN v_new ELSE qty_allocated END)
               * COALESCE(unit_price_cents, 0)), 0)
        INTO v_so_cents
        FROM sales_order_lines
       WHERE sales_order_id = v_line.sales_order_id AND status <> 'cancelled';
      IF v_so_cents > COALESCE(v_line.factor_approved_cents, 0) THEN
        v_skipped := v_skipped || jsonb_build_object(
          'line_id', v_line_id,
          'reason', format('factor approved $%s < allocated $%s',
            round(COALESCE(v_line.factor_approved_cents, 0) / 100.0, 2),
            round(v_so_cents / 100.0, 2)));
        CONTINUE;
      END IF;
    END IF;

    -- Write. Line status: 'allocated' when full; revert 'allocated'→'open' on
    -- release; otherwise leave as-is (open).
    UPDATE sales_order_lines
       SET qty_allocated = v_new,
           status = CASE
                      WHEN v_new >= qty_ordered THEN 'allocated'
                      WHEN status = 'allocated'  THEN 'open'
                      ELSE status END,
           updated_at = now()
     WHERE id = v_line.id;

    -- Decrement the running pool (release adds back via negative delta).
    v_pool := jsonb_set(v_pool, ARRAY[v_line.inventory_item_id::text], to_jsonb(v_running - v_delta));

    IF NOT (v_line.sales_order_id = ANY(v_touched)) THEN
      v_touched := array_append(v_touched, v_line.sales_order_id);
    END IF;
    v_applied := v_applied || jsonb_build_object(
      'line_id', v_line_id, 'qty_allocated', v_new, 'delta', v_delta);
  END LOOP;

  -- Recompute header status for each touched SO. PARTIAL allocation rule
  -- (PR #1005): any live line carrying allocated qty > 0 makes the SO
  -- `allocated`; zero allocation across all live lines reverts to `confirmed`.
  -- Only confirmed↔allocated flip; fulfilling/shipped/invoiced/closed untouched.
  FOREACH v_so_id IN ARRAY v_touched LOOP
    UPDATE sales_orders so
       SET status = CASE
              WHEN so.status IN ('confirmed', 'allocated') THEN
                CASE WHEN EXISTS (
                  SELECT 1 FROM sales_order_lines l
                   WHERE l.sales_order_id = so.id
                     AND l.status <> 'cancelled'
                     AND l.qty_allocated > 0
                ) THEN 'allocated' ELSE 'confirmed' END
              ELSE so.status END,
           updated_at = now()
     WHERE so.id = v_so_id;
  END LOOP;

  RETURN jsonb_build_object('applied', v_applied, 'skipped', v_skipped);
END;
$$;

COMMENT ON FUNCTION apply_allocations(jsonb, uuid) IS 'P16/M18 — authoritative allocation write for the Allocations Workbench. Absolute SET of qty_allocated per line (0 releases), validated against v_inventory_available with a running per-item pool, gated by the hard factor-credit rule. Recomputes line status; SO header flips confirmed->allocated on ANY allocated qty (partial counts), reverts allocated->confirmed only when fully released. Returns {applied, skipped:[{line_id,reason}]}.';

NOTIFY pgrst, 'reload schema';
