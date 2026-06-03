-- merge_item_master_dups — collision-aware repoint.
--
-- 12 of the FK tables (planning grain tables + tangerine_size_onhand) carry a
-- UNIQUE INDEX that includes the FK column, so a blind loser→survivor repoint
-- ABORTS when the survivor already holds a row at the same grain. This version
-- handles that generically: for every FK column whose table has a unique index
-- including it, FIRST delete the loser rows that would collide (the survivor's
-- row wins), THEN repoint the rest. tangerine_size_onhand additionally FOLDS
-- (sums) the colliding loser qty into the survivor first, because that is real
-- inventory on-hand (the planning grain tables are test data — colliding loser
-- rows are simply dropped). See memory project_ip_item_master_dup_skus.
CREATE OR REPLACE FUNCTION merge_item_master_dups(p_survivor uuid, p_losers uuid[])
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record; n bigint; fk_repointed bigint := 0; onhand_repointed bigint := 0;
  surv_sku text; uix_keys int2vector; fkattnum smallint; match_expr text; dropped bigint;
BEGIN
  IF p_survivor IS NULL OR p_losers IS NULL OR array_length(p_losers, 1) IS NULL THEN
    RAISE EXCEPTION 'survivor and a non-empty losers[] are required';
  END IF;
  IF p_survivor = ANY (p_losers) THEN RAISE EXCEPTION 'survivor must not be in losers[]'; END IF;
  PERFORM 1 FROM ip_item_master WHERE id = p_survivor;
  IF NOT FOUND THEN RAISE EXCEPTION 'survivor % not found', p_survivor; END IF;

  -- 1. tangerine_size_onhand — FOLD colliding loser qty into survivor (real
  --    inventory), delete the folded loser rows, then repoint the rest.
  UPDATE tangerine_size_onhand sv SET qty_on_hand = sv.qty_on_hand + agg.q, updated_at = now()
  FROM (SELECT entity_id, warehouse_code, snapshot_date, source, sum(qty_on_hand) q
        FROM tangerine_size_onhand WHERE item_id = ANY (p_losers)
        GROUP BY entity_id, warehouse_code, snapshot_date, source) agg
  WHERE sv.item_id = p_survivor AND sv.entity_id = agg.entity_id AND sv.warehouse_code = agg.warehouse_code
    AND sv.snapshot_date = agg.snapshot_date AND sv.source = agg.source;
  DELETE FROM tangerine_size_onhand l WHERE l.item_id = ANY (p_losers) AND EXISTS (
    SELECT 1 FROM tangerine_size_onhand sv WHERE sv.item_id = p_survivor AND sv.entity_id = l.entity_id
      AND sv.warehouse_code = l.warehouse_code AND sv.snapshot_date = l.snapshot_date AND sv.source = l.source);
  UPDATE tangerine_size_onhand SET item_id = p_survivor, updated_at = now() WHERE item_id = ANY (p_losers);
  GET DIAGNOSTICS onhand_repointed = ROW_COUNT;

  -- 2. Every other FK column — collision-aware repoint.
  FOR r IN SELECT tbl, col FROM item_master_fk_columns()
           WHERE NOT (tbl = 'tangerine_size_onhand' AND col = 'item_id')
  LOOP
    fkattnum := (SELECT attnum FROM pg_attribute WHERE attrelid = (r.tbl)::regclass AND attname = r.col AND NOT attisdropped);
    -- a unique index on this table that includes the FK column?
    SELECT ix.indkey INTO uix_keys
    FROM pg_index ix
    WHERE ix.indrelid = (r.tbl)::regclass AND ix.indisunique AND NOT ix.indisprimary
      AND fkattnum = ANY (ix.indkey)
    LIMIT 1;
    IF uix_keys IS NOT NULL THEN
      -- build the "same grain" match on the OTHER unique-index columns, then
      -- drop loser rows that collide with an existing survivor row.
      SELECT string_agg(format('o.%I IS NOT DISTINCT FROM t.%I', a.attname, a.attname), ' AND ')
      INTO match_expr
      FROM unnest(string_to_array(uix_keys::text, ' ')::smallint[]) k
      JOIN pg_attribute a ON a.attrelid = (r.tbl)::regclass AND a.attnum = k
      WHERE a.attname <> r.col;
      IF match_expr IS NOT NULL THEN
        -- Drop loser rows whose grain already exists on a row we KEEP: the
        -- survivor's row, OR an earlier loser row (ctid tiebreak) — so 2+
        -- losers sharing a grain collapse to one before the repoint (else the
        -- simultaneous repoint of both would violate the unique index).
        EXECUTE format('DELETE FROM %s t WHERE t.%I = ANY($1) AND EXISTS (SELECT 1 FROM %s o WHERE %s AND (o.%I = $2 OR (o.%I = ANY($1) AND o.ctid < t.ctid)))',
                       r.tbl, r.col, r.tbl, match_expr, r.col, r.col) USING p_losers, p_survivor;
      ELSE  -- unique is ONLY the FK col → any loser row collides; drop all loser rows
        EXECUTE format('DELETE FROM %s WHERE %I = ANY($1)', r.tbl, r.col) USING p_losers;
      END IF;
    END IF;
    -- repoint whatever remains
    EXECUTE format('UPDATE %s SET %I = $2 WHERE %I = ANY($1)', r.tbl, r.col, r.col) USING p_losers, p_survivor;
    GET DIAGNOSTICS n = ROW_COUNT;
    fk_repointed := fk_repointed + n;
    uix_keys := NULL;
  END LOOP;

  -- 3a. Backfill survivor columns it lacks.
  UPDATE ip_item_master sv SET
    unit_cost   = COALESCE(sv.unit_cost,   (SELECT l.unit_cost   FROM ip_item_master l WHERE l.id = ANY(p_losers) AND l.unit_cost   IS NOT NULL ORDER BY l.created_at LIMIT 1)),
    unit_price  = COALESCE(sv.unit_price,  (SELECT l.unit_price  FROM ip_item_master l WHERE l.id = ANY(p_losers) AND l.unit_price  IS NOT NULL ORDER BY l.created_at LIMIT 1)),
    description = COALESCE(sv.description,  (SELECT l.description FROM ip_item_master l WHERE l.id = ANY(p_losers) AND l.description IS NOT NULL ORDER BY l.created_at LIMIT 1)),
    updated_at  = now()
  WHERE sv.id = p_survivor;

  -- 3b. ip_item_avg_cost (keyed by sku_code).
  SELECT sku_code INTO surv_sku FROM ip_item_master WHERE id = p_survivor;
  IF surv_sku IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ip_item_avg_cost WHERE sku_code = surv_sku) THEN
    INSERT INTO ip_item_avg_cost (sku_code, avg_cost)
    SELECT surv_sku, a.avg_cost FROM ip_item_avg_cost a
    JOIN ip_item_master l ON l.sku_code = a.sku_code
    WHERE l.id = ANY (p_losers) AND a.avg_cost IS NOT NULL ORDER BY l.created_at LIMIT 1
    ON CONFLICT (sku_code) DO NOTHING;
  END IF;

  DELETE FROM ip_item_master WHERE id = ANY (p_losers);
  RETURN jsonb_build_object('survivor', p_survivor, 'losers', array_length(p_losers, 1),
    'onhand_repointed', onhand_repointed, 'fk_repointed', fk_repointed);
END $$;
