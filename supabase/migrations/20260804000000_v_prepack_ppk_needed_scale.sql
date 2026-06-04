-- Extend v_prepack_ppk_needed with the base style's SIZE SCALE so the
-- "Download all PPK" template can group every style sharing a scale onto ONE
-- sheet (using the scale's canonical ordered sizes as the columns) instead of
-- one sheet per distinct raw size-set. Scale comes from style_master.size_scale_id
-- (base style first, then the PPK style) → size_scales (code / name / ordered sizes).
-- Styles with no assigned scale keep the previous size-set grouping (the panel
-- falls back to the `sizes` column).
--
-- CREATE OR REPLACE only appends columns at the end of the SELECT list, so the
-- four new columns (size_scale_id, scale_code, scale_name, scale_sizes) are added
-- after the existing ones — safe, idempotent.

CREATE OR REPLACE VIEW v_prepack_ppk_needed AS
WITH ppk AS (
  SELECT DISTINCT style_code AS ppk_style_code,
         regexp_replace(style_code, '-?PPK[0-9]*', '', 'gi') AS base_code
  FROM ip_item_master
  WHERE style_code ~* 'PPK'
)
SELECT
  p.ppk_style_code,
  p.base_code,
  (SELECT s.size FROM ip_item_master s
     WHERE s.style_code = p.ppk_style_code AND s.size ~* 'PPK' LIMIT 1) AS pack_token,
  COALESCE(
    (SELECT sm.style_name FROM style_master sm WHERE sm.style_code = p.ppk_style_code AND COALESCE(sm.style_name,'') <> '' LIMIT 1),
    (SELECT sm.style_name FROM style_master sm WHERE sm.style_code = p.base_code      AND COALESCE(sm.style_name,'') <> '' LIMIT 1),
    (SELECT i.description  FROM ip_item_master i WHERE i.style_code = p.base_code      AND COALESCE(i.description,'') <> '' LIMIT 1)
  ) AS style_name,
  (SELECT array_agg(DISTINCT s.size) FROM ip_item_master s
     WHERE s.style_code = p.base_code AND s.size !~* 'PPK') AS sizes,
  scale.size_scale_id,
  ssc.code  AS scale_code,
  ssc.name  AS scale_name,
  ssc.sizes AS scale_sizes
FROM ppk p
LEFT JOIN LATERAL (
  SELECT COALESCE(
    (SELECT sm.size_scale_id FROM style_master sm WHERE sm.style_code = p.base_code      AND sm.size_scale_id IS NOT NULL LIMIT 1),
    (SELECT sm.size_scale_id FROM style_master sm WHERE sm.style_code = p.ppk_style_code AND sm.size_scale_id IS NOT NULL LIMIT 1)
  ) AS size_scale_id
) scale ON true
LEFT JOIN size_scales ssc ON ssc.id = scale.size_scale_id
WHERE NOT EXISTS (SELECT 1 FROM prepack_matrices m WHERE m.ppk_style_code = p.ppk_style_code);

COMMENT ON VIEW v_prepack_ppk_needed IS 'PPK styles lacking a prepack_matrices row, with master style name + pack token + sized-sibling sizes + the base style''s assigned size scale (code/name/ordered sizes). Backs the Prepack Matrices "Download all PPK" template (grouped one sheet per size scale).';

NOTIFY pgrst, 'reload schema';
