-- ip_item_master dup-SKU cleanup — server-side primitives (INERT until called).
--
-- The catalog has ~7,047 duplicate SKU rows (memory project_ip_item_master_dup
-- _skus): successive ingests created a row for the SAME logical SKU
-- (style,color,size,inseam) with a DIFFERENT sku_code; uniqueness is only on
-- sku_code. These functions are the building blocks the driver
-- (scripts/dedup-item-master.mjs) uses for the staged cleanup. Creating them
-- changes no data.

-- ── Every (table, column) with a FK to ip_item_master.id ─────────────────────
-- Single source of truth so the merge repoints EVERY referencing column and
-- never silently misses one. (46 FK constraints across ~45 tables as of build.)
CREATE OR REPLACE FUNCTION item_master_fk_columns()
RETURNS TABLE(tbl text, col text)
LANGUAGE sql STABLE AS $$
  SELECT c.conrelid::regclass::text AS tbl, a.attname::text AS col
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
  WHERE c.contype = 'f' AND c.confrelid = 'public.ip_item_master'::regclass
  ORDER BY 1, 2;
$$;

-- ── Merge LOSER SKUs into a SURVIVOR, atomically ─────────────────────────────
-- The driver decides survivor + losers and which groups are safe to merge (it
-- FENCES OFF the ~170 groups whose planning history sits on 2+ members, because
-- the planning tables have no UNIQUE on (sku_id,period) and a blind repoint
-- there would silently DOUBLE-COUNT). For the groups it does pass:
--   1. tangerine_size_onhand has UNIQUE(entity,item,warehouse,snapshot,source):
--      fold colliding loser rows into the survivor's, delete them, repoint rest.
--   2. Repoint every other FK column (item_master_fk_columns) loser→survivor.
--   3. Backfill survivor unit_cost / unit_price / description it lacks, and copy
--      ip_item_avg_cost (keyed by sku_code, not item_id) onto the survivor.
--   4. Delete the losers.
-- One transaction → a group is never left half-merged.
CREATE OR REPLACE FUNCTION merge_item_master_dups(p_survivor uuid, p_losers uuid[])
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record; n bigint; sql text;
  fk_repointed bigint := 0; onhand_repointed bigint := 0; surv_sku text;
BEGIN
  IF p_survivor IS NULL OR p_losers IS NULL OR array_length(p_losers, 1) IS NULL THEN
    RAISE EXCEPTION 'survivor and a non-empty losers[] are required';
  END IF;
  IF p_survivor = ANY (p_losers) THEN RAISE EXCEPTION 'survivor must not be in losers[]'; END IF;
  PERFORM 1 FROM ip_item_master WHERE id = p_survivor;
  IF NOT FOUND THEN RAISE EXCEPTION 'survivor % not found', p_survivor; END IF;

  -- 1. tangerine_size_onhand — fold colliding loser rows, delete them, repoint rest.
  UPDATE tangerine_size_onhand sv
     SET qty_on_hand = sv.qty_on_hand + agg.q, updated_at = now()
  FROM (
    SELECT entity_id, warehouse_code, snapshot_date, source, sum(qty_on_hand) AS q
    FROM tangerine_size_onhand WHERE item_id = ANY (p_losers)
    GROUP BY entity_id, warehouse_code, snapshot_date, source
  ) agg
  WHERE sv.item_id = p_survivor AND sv.entity_id = agg.entity_id
    AND sv.warehouse_code = agg.warehouse_code AND sv.snapshot_date = agg.snapshot_date AND sv.source = agg.source;

  DELETE FROM tangerine_size_onhand l
  WHERE l.item_id = ANY (p_losers) AND EXISTS (
    SELECT 1 FROM tangerine_size_onhand sv
    WHERE sv.item_id = p_survivor AND sv.entity_id = l.entity_id
      AND sv.warehouse_code = l.warehouse_code AND sv.snapshot_date = l.snapshot_date AND sv.source = l.source);

  UPDATE tangerine_size_onhand SET item_id = p_survivor, updated_at = now() WHERE item_id = ANY (p_losers);
  GET DIAGNOSTICS onhand_repointed = ROW_COUNT;

  -- 2. Repoint every other FK column (dynamic = complete).
  FOR r IN SELECT tbl, col FROM item_master_fk_columns()
           WHERE NOT (tbl = 'tangerine_size_onhand' AND col = 'item_id')
  LOOP
    sql := format('UPDATE %s SET %I = %L WHERE %I = ANY(%L::uuid[])', r.tbl, r.col, p_survivor, r.col, p_losers);
    EXECUTE sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    fk_repointed := fk_repointed + n;
  END LOOP;

  -- 3a. Backfill survivor columns it lacks, from the oldest loser that has them.
  UPDATE ip_item_master sv SET
    unit_cost   = COALESCE(sv.unit_cost,   (SELECT l.unit_cost   FROM ip_item_master l WHERE l.id = ANY(p_losers) AND l.unit_cost   IS NOT NULL ORDER BY l.created_at LIMIT 1)),
    unit_price  = COALESCE(sv.unit_price,  (SELECT l.unit_price  FROM ip_item_master l WHERE l.id = ANY(p_losers) AND l.unit_price  IS NOT NULL ORDER BY l.created_at LIMIT 1)),
    description = COALESCE(sv.description,  (SELECT l.description FROM ip_item_master l WHERE l.id = ANY(p_losers) AND l.description IS NOT NULL ORDER BY l.created_at LIMIT 1)),
    updated_at  = now()
  WHERE sv.id = p_survivor;

  -- 3b. ip_item_avg_cost is keyed by sku_code (not item_id). Copy onto survivor's sku_code if missing.
  SELECT sku_code INTO surv_sku FROM ip_item_master WHERE id = p_survivor;
  IF surv_sku IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ip_item_avg_cost WHERE sku_code = surv_sku) THEN
    INSERT INTO ip_item_avg_cost (sku_code, avg_cost)
    SELECT surv_sku, a.avg_cost FROM ip_item_avg_cost a
    JOIN ip_item_master l ON l.sku_code = a.sku_code
    WHERE l.id = ANY (p_losers) AND a.avg_cost IS NOT NULL
    ORDER BY l.created_at LIMIT 1
    ON CONFLICT (sku_code) DO NOTHING;
  END IF;

  -- 4. Remove the losers.
  DELETE FROM ip_item_master WHERE id = ANY (p_losers);

  RETURN jsonb_build_object('survivor', p_survivor, 'losers', array_length(p_losers, 1),
    'onhand_repointed', onhand_repointed, 'fk_repointed', fk_repointed);
END $$;

-- ── Delete a batch of ZERO-REFERENCE loser SKUs (Tier 1) ─────────────────────
-- Safety-checked DELETE: refuses any id still referenced by ANY FK column, so a
-- driver bug can't delete a row something points at. Returns the count deleted.
CREATE OR REPLACE FUNCTION delete_zero_ref_skus(p_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; n bigint; bad bigint := 0; deleted bigint := 0;
BEGIN
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN RETURN jsonb_build_object('deleted', 0); END IF;
  FOR r IN SELECT tbl, col FROM item_master_fk_columns() LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE %I = ANY($1)', r.tbl, r.col) INTO n USING p_ids;
    bad := bad + n;
  END LOOP;
  IF bad > 0 THEN RAISE EXCEPTION 'refusing delete: % of the ids are still referenced', bad; END IF;
  DELETE FROM ip_item_master WHERE id = ANY (p_ids);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN jsonb_build_object('deleted', deleted);
END $$;

REVOKE ALL ON FUNCTION item_master_fk_columns() FROM PUBLIC;
REVOKE ALL ON FUNCTION merge_item_master_dups(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION delete_zero_ref_skus(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION item_master_fk_columns() TO service_role;
GRANT EXECUTE ON FUNCTION merge_item_master_dups(uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION delete_zero_ref_skus(uuid[]) TO service_role;
