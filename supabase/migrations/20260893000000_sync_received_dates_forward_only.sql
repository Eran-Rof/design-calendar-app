-- sync_received_dates — only ADVANCE a layer's received_at, never move it back.
--
-- The nightly Xoro snapshot reports a single "Last Receipt Date" per
-- (style, colour). The original RPC (20260879) updated any eligible layer whose
-- date merely DIFFERED from the snapshot (`received_at::date <> m.d`), so a
-- snapshot reporting an OLDER receipt than what's already stored would move the
-- date BACKWARD — "last received" could regress and FIFO age could shift the
-- wrong way. Guard so the update only fires when the snapshot date is strictly
-- newer (or the layer has no date yet).
--
-- Known limitation (unchanged): the snapshot has no per-layer / per-warehouse
-- grain, so when a SKU has several eligible (xoro_rest_size/opening_balance)
-- layers they all receive the same max date. The displayed value
-- (styleMatrix max per cell) stays correct; only native PO-receipt layers are
-- always left untouched. Idempotent: a repeated identical snapshot is a no-op.

CREATE OR REPLACE FUNCTION sync_received_dates(p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $func$
DECLARE n integer;
BEGIN
  WITH rows AS (
    SELECT upper(btrim(e->>'s')) AS style, lower(btrim(e->>'c')) AS rawc, (e->>'d')::date AS d
    FROM jsonb_array_elements(p_rows) e
    WHERE (e->>'s') IS NOT NULL AND (e->>'c') IS NOT NULL AND (e->>'d') ~ '^\d{4}-\d{2}-\d{2}$'
  ),
  resolved AS (
    SELECT r.style, lower(COALESCE(ca.canonical_name, r.rawc)) AS canon_l, r.d
    FROM rows r
    LEFT JOIN color_aliases ca ON ca.raw_lower = r.rawc
  ),
  maxd AS (
    SELECT style, canon_l, max(d) AS d FROM resolved GROUP BY style, canon_l
  )
  UPDATE inventory_layers l
  SET received_at = m.d::timestamptz
  FROM maxd m
  JOIN ip_item_master i ON upper(i.style_code) = m.style AND lower(btrim(i.color)) = m.canon_l
  WHERE l.item_id = i.id
    AND l.source_kind IN ('xoro_rest_size','opening_balance')
    AND (l.received_at IS NULL OR l.received_at::date < m.d);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $func$;
