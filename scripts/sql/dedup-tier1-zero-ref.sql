-- Tier 1 of the ip_item_master dup cleanup — delete ONLY zero-reference loser
-- SKUs (rows nothing points at), after backfilling the survivor's missing
-- cost/desc. Transactional: any surprise in the verify block rolls the whole
-- thing back. Entangled (referenced) dups are LEFT for Tier 2. Run:
--   supabase db query --linked -f scripts/sql/dedup-tier1-zero-ref.sql
-- Reverse = restore from the pre-run manifest dump (driver) or a DB snapshot.
DO $$
DECLARE referenced bigint; zero_ref_losers bigint; deleted bigint; before_total bigint; after_total bigint;
BEGIN
  before_total := (SELECT count(*) FROM ip_item_master);

  -- All ids referenced by ANY FK column (complete, from the catalog).
  CREATE TEMP TABLE _ref(id uuid PRIMARY KEY) ON COMMIT DROP;
  DECLARE r record;
  BEGIN
    FOR r IN SELECT tbl, col FROM item_master_fk_columns() LOOP
      EXECUTE format('INSERT INTO _ref(id) SELECT DISTINCT %I FROM %s WHERE %I IS NOT NULL ON CONFLICT DO NOTHING', r.col, r.tbl, r.col);
    END LOOP;
  END;
  referenced := (SELECT count(*) FROM _ref);

  -- Dup groups by canonical logical SKU + survivor (keep a REFERENCED row if any,
  -- else has-cost, else oldest) so Tier 2 can later merge entangled members into it.
  CREATE TEMP TABLE _plan ON COMMIT DROP AS
  WITH canon AS (
    SELECT m.id, m.style_id, m.color, m.inseam, m.unit_cost, m.created_at,
      CASE upper(trim(m.size))
        WHEN 'XS' THEN 'XSMALL' WHEN 'XSM' THEN 'XSMALL'
        WHEN 'S' THEN 'SMALL' WHEN 'SM' THEN 'SMALL' WHEN 'SML' THEN 'SMALL'
        WHEN 'M' THEN 'MEDIUM' WHEN 'MD' THEN 'MEDIUM' WHEN 'MED' THEN 'MEDIUM'
        WHEN 'L' THEN 'LARGE' WHEN 'LG' THEN 'LARGE' WHEN 'LRG' THEN 'LARGE'
        WHEN 'XL' THEN 'XLARGE' WHEN 'XLG' THEN 'XLARGE'
        WHEN 'XXL' THEN '2XLARGE' WHEN '2X' THEN '2XLARGE' WHEN '2XL' THEN '2XLARGE'
        WHEN '3X' THEN '3XLARGE' WHEN '3XL' THEN '3XLARGE' WHEN 'XXXL' THEN '3XLARGE'
        ELSE upper(trim(m.size)) END AS csize,
      (EXISTS (SELECT 1 FROM _ref x WHERE x.id = m.id)) AS referenced
    FROM ip_item_master m WHERE m.style_id IS NOT NULL
  ),
  g AS (
    SELECT *, count(*) OVER w AS gsize,
      row_number() OVER (PARTITION BY style_id,color,csize,inseam
        ORDER BY referenced DESC, (unit_cost IS NOT NULL) DESC, created_at, id) AS rnk
    FROM canon WINDOW w AS (PARTITION BY style_id,color,csize,inseam)
  )
  SELECT id, style_id, color, csize, inseam, referenced, (rnk = 1) AS is_survivor
  FROM g WHERE gsize > 1;

  zero_ref_losers := (SELECT count(*) FROM _plan WHERE NOT is_survivor AND NOT referenced);

  -- Backfill each survivor's missing cost/desc from any loser in its group.
  UPDATE ip_item_master sv SET
    unit_cost   = COALESCE(sv.unit_cost,   bf.unit_cost),
    description = COALESCE(sv.description,  bf.description),
    updated_at  = now()
  FROM (
    SELECT s.id AS survivor_id,
      (array_remove(array_agg(l.unit_cost   ORDER BY l.created_at) FILTER (WHERE l.unit_cost   IS NOT NULL), NULL))[1] AS unit_cost,
      (array_remove(array_agg(l.description ORDER BY l.created_at) FILTER (WHERE l.description IS NOT NULL), NULL))[1] AS description
    FROM _plan s
    JOIN _plan o ON o.style_id=s.style_id AND o.color IS NOT DISTINCT FROM s.color AND o.csize=s.csize AND o.inseam IS NOT DISTINCT FROM s.inseam AND NOT o.is_survivor
    JOIN ip_item_master l ON l.id = o.id
    WHERE s.is_survivor
    GROUP BY s.id
  ) bf
  WHERE sv.id = bf.survivor_id AND (sv.unit_cost IS NULL OR sv.description IS NULL);

  -- Delete the zero-ref losers (safe — nothing references them).
  DELETE FROM ip_item_master WHERE id IN (SELECT id FROM _plan WHERE NOT is_survivor AND NOT referenced);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  after_total := (SELECT count(*) FROM ip_item_master);

  IF deleted <> zero_ref_losers THEN
    RAISE EXCEPTION 'Tier1 mismatch: planned % zero-ref losers, deleted % — rolling back', zero_ref_losers, deleted;
  END IF;
  IF (before_total - after_total) <> deleted THEN
    RAISE EXCEPTION 'Tier1 row-count drift: before % after % delta <> deleted % — rolling back', before_total, after_total, deleted;
  END IF;
  RAISE NOTICE 'Tier1 OK: referenced ids=%, deleted zero-ref losers=%, rows % -> %', referenced, deleted, before_total, after_total;
END $$;
