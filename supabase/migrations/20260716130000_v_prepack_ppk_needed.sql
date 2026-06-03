-- Read-only view: PPK styles that still need a prepack matrix.
-- Drives the panel's "Download all PPK" bulk template. Name comes from the style
-- MASTER (style_master.style_name, falling back to the sibling, then the
-- ip_item_master description) — never a guessed "<code> Pack of N".
-- pack_token = the PPK SKU's size value (e.g. PPK24); sizes = the sized sibling's
-- garment sizes (PPK token excluded).

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
     WHERE s.style_code = p.base_code AND s.size !~* 'PPK') AS sizes
FROM ppk p
WHERE NOT EXISTS (SELECT 1 FROM prepack_matrices m WHERE m.ppk_style_code = p.ppk_style_code);

COMMENT ON VIEW v_prepack_ppk_needed IS 'PPK styles lacking a prepack_matrices row, with master style name + pack token + sized-sibling sizes. Backs the Prepack Matrices "Download all PPK" template.';

NOTIFY pgrst, 'reload schema';
