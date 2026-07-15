-- v_style_scale_needed — the styles that GENUINELY still need a size scale.
--
-- The Today "Styles missing a size scale" tile (api/_lib/assistant/packs/
-- master_data.js) was counting v_style_scale_candidates raw. That view
-- INTENTIONALLY returns EVERY style (it's the data source for the bulk
-- auto-assign tool, whose overwrite mode needs scaled styles too), so the tile
-- reported all ~2,119 styles regardless of scale — it never reflected progress.
--
-- This view is the real candidate set: no scale, at least one non-PPK sized
-- variant, and NOT flagged size_scale_not_required. The flag
-- (style_master.attributes.size_scale_not_required = true) lets the operator
-- accept a legacy style as-is without a scale so it drops off the needs list.
-- v_style_scale_candidates is left UNCHANGED so the auto-assign tool keeps working.

CREATE OR REPLACE VIEW v_style_scale_needed AS
SELECT
  sm.id,
  sm.style_code,
  sm.gender_code,
  (SELECT array_agg(DISTINCT i.size)
     FROM ip_item_master i
    WHERE i.style_code = sm.style_code
      AND i.size IS NOT NULL
      AND COALESCE(i.size, '') <> ''
      AND i.size !~* 'PPK') AS variants
FROM style_master sm
WHERE sm.deleted_at IS NULL
  AND sm.size_scale_id IS NULL
  AND NOT COALESCE((sm.attributes->>'size_scale_not_required')::boolean, false)
  AND EXISTS (
    SELECT 1 FROM ip_item_master i
     WHERE i.style_code = sm.style_code
       AND i.size IS NOT NULL
       AND COALESCE(i.size, '') <> ''
       AND i.size !~* 'PPK');

COMMENT ON VIEW v_style_scale_needed IS
  'Styles that still need a size scale: no size_scale_id, >=1 non-PPK sized variant, and NOT attributes.size_scale_not_required. Backs the Today "Styles missing a size scale" tile. Distinct from v_style_scale_candidates, which returns ALL styles for the auto-assign tool.';

GRANT SELECT ON v_style_scale_needed TO anon, authenticated, service_role;
