-- Tier 2 of the ip_item_master dup cleanup — merge the entangled dup groups
-- (those still duplicated after Tier 1, i.e. 2+ referenced members) into one
-- survivor each, via merge_item_master_dups (collision-aware). Survivor = the
-- referenced row, then has-cost, then oldest. Per-group savepoint: a group that
-- errors is skipped (counted), the rest still commit. Run:
--   supabase db query --linked -f scripts/sql/dedup-tier2-merge.sql
DO $$
DECLARE g record; merged int := 0; losers_total int := 0; failed int := 0; errs text := '';
BEGIN
  CREATE TEMP TABLE _ref(id uuid PRIMARY KEY) ON COMMIT DROP;
  DECLARE r record;
  BEGIN
    FOR r IN SELECT tbl, col FROM item_master_fk_columns() LOOP
      EXECUTE format('INSERT INTO _ref(id) SELECT DISTINCT %I FROM %s WHERE %I IS NOT NULL ON CONFLICT DO NOTHING', r.col, r.tbl, r.col);
    END LOOP;
  END;

  FOR g IN
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
    grp AS (
      SELECT id, style_id, color, csize, inseam,
        count(*) OVER w AS gsize,
        row_number() OVER (PARTITION BY style_id, color, csize, inseam
          ORDER BY referenced DESC, (unit_cost IS NOT NULL) DESC, created_at, id) AS rnk
      FROM canon WINDOW w AS (PARTITION BY style_id, color, csize, inseam)
    )
    SELECT (array_agg(id ORDER BY rnk))[1] AS survivor,
           array_remove(array_agg(CASE WHEN rnk > 1 THEN id END ORDER BY rnk), NULL) AS losers
    FROM grp WHERE gsize > 1
    GROUP BY style_id, color, csize, inseam
  LOOP
    BEGIN
      PERFORM merge_item_master_dups(g.survivor, g.losers);
      merged := merged + 1;
      losers_total := losers_total + array_length(g.losers, 1);
    EXCEPTION WHEN OTHERS THEN
      failed := failed + 1;
      IF length(errs) < 4000 THEN errs := errs || g.survivor::text || ': ' || SQLERRM || E'\n'; END IF;
    END;
  END LOOP;

  RAISE NOTICE 'Tier2 done: merged % groups (% losers removed), failed % groups', merged, losers_total, failed;
  IF failed > 0 THEN RAISE NOTICE 'failures:%', E'\n' || errs; END IF;
END $$;
