-- P16 — backfill style group/category/sub from the ATS source + add Rise +
-- relabel alpha size scales.
--
-- SOURCE of group/category/sub: ip_item_master.attributes (the ATS item master).
-- ATS hierarchy (confirmed by data):
--   attributes.product_category  (BOTTOMS/TOPS …)  → style_master.group_name
--   attributes.group_name        (DENIM/PANTS/TEE) → style_master.category_name
--   attributes.category_name     (STRAIGHT/…)      → style_master.sub_category_name
-- Backfilled per style as the most-common value across its SKUs, only filling
-- empty style_master fields. Then style_classifications is re-seeded from the
-- now-populated values. Idempotent.

-- ── 1. group_name ← mode(product_category) per style ─────────────────────────
WITH counts AS (
  SELECT style_id, attributes->>'product_category' AS v, count(*) AS n
  FROM ip_item_master
  WHERE style_id IS NOT NULL AND coalesce(attributes->>'product_category','') <> ''
  GROUP BY style_id, attributes->>'product_category'
), mode AS (
  SELECT DISTINCT ON (style_id) style_id, v FROM counts ORDER BY style_id, n DESC, v
)
UPDATE style_master sm SET group_name = mode.v, updated_at = now()
FROM mode WHERE sm.id = mode.style_id AND coalesce(sm.group_name,'') = '';

-- ── 2. category_name ← mode(group_name) per style ────────────────────────────
WITH counts AS (
  SELECT style_id, attributes->>'group_name' AS v, count(*) AS n
  FROM ip_item_master
  WHERE style_id IS NOT NULL AND coalesce(attributes->>'group_name','') <> ''
  GROUP BY style_id, attributes->>'group_name'
), mode AS (
  SELECT DISTINCT ON (style_id) style_id, v FROM counts ORDER BY style_id, n DESC, v
)
UPDATE style_master sm SET category_name = mode.v, updated_at = now()
FROM mode WHERE sm.id = mode.style_id AND coalesce(sm.category_name,'') = '';

-- ── 3. sub_category_name ← mode(category_name) per style ─────────────────────
WITH counts AS (
  SELECT style_id, attributes->>'category_name' AS v, count(*) AS n
  FROM ip_item_master
  WHERE style_id IS NOT NULL AND coalesce(attributes->>'category_name','') <> ''
  GROUP BY style_id, attributes->>'category_name'
), mode AS (
  SELECT DISTINCT ON (style_id) style_id, v FROM counts ORDER BY style_id, n DESC, v
)
UPDATE style_master sm SET sub_category_name = mode.v, updated_at = now()
FROM mode WHERE sm.id = mode.style_id AND coalesce(sm.sub_category_name,'') = '';

-- ── 4. re-seed style_classifications from the now-populated style values ──────
INSERT INTO style_classifications (entity_id, kind, name)
SELECT DISTINCT entity_id, 'group', group_name FROM style_master
  WHERE group_name IS NOT NULL AND btrim(group_name) <> ''
ON CONFLICT (entity_id, kind, name) DO NOTHING;
INSERT INTO style_classifications (entity_id, kind, name)
SELECT DISTINCT entity_id, 'category', category_name FROM style_master
  WHERE category_name IS NOT NULL AND btrim(category_name) <> ''
ON CONFLICT (entity_id, kind, name) DO NOTHING;
INSERT INTO style_classifications (entity_id, kind, name)
SELECT DISTINCT entity_id, 'sub_category', sub_category_name FROM style_master
  WHERE sub_category_name IS NOT NULL AND btrim(sub_category_name) <> ''
ON CONFLICT (entity_id, kind, name) DO NOTHING;

-- ── 5. Rise dimension (denim high/mid/low). SKU-level + style default. ───────
ALTER TABLE ip_item_master ADD COLUMN IF NOT EXISTS rise text;
ALTER TABLE style_master    ADD COLUMN IF NOT EXISTS rise text;
COMMENT ON COLUMN style_master.rise IS 'P16 — default rise for the style (e.g. HIGH/MID/LOW); SKU-level rise on ip_item_master.rise drives the matrix.';

-- ── 6. Relabel alpha size scales to full words; drop 3XL (operator request) ──
UPDATE size_scales SET sizes = ARRAY['XSMALL','SMALL','MEDIUM','LARGE','XLARGE','2XLARGE'], updated_at = now()
  WHERE code = 'ALPHA-XS-3XL';
UPDATE size_scales SET sizes = ARRAY['SMALL','MEDIUM','LARGE','XLARGE','2XLARGE'], updated_at = now()
  WHERE code = 'MENS-S-2XL';
UPDATE size_scales SET sizes = ARRAY['XSMALL','SMALL','MEDIUM','LARGE','XLARGE'], updated_at = now()
  WHERE code = 'KIDS';

NOTIFY pgrst, 'reload schema';
