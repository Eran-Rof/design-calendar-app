-- ════════════════════════════════════════════════════════════════════════════
-- Backfill ip_item_master.size from the sku_code tail (operator: Xoro import
-- left size in the sku_code, size field null → styles can't auto-match a scale).
--
-- For NON-PL SKUs whose size IS NULL and whose LAST '-' segment of sku_code is a
-- recognized size token, set size = that token. The logical-unique index keys on
-- canonical_size(size) (S/SML/SMALL collapse), so we (a) dedup candidates to one
-- per (style,color,inseam,canonical-size) cell and (b) skip any cell that
-- already has a NON-NULL-size sibling of the same canonical size — avoiding
-- uq_ip_item_master_logical_sku violations. ~867 SKUs / 172 styles (11 carry
-- stock). PL excluded (tail is a print, size sits mid-code). Backs up first.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS _ip_size_backfill_bk_20260613 AS
  SELECT id, size, sku_code FROM ip_item_master
  WHERE size IS NULL AND style_code NOT ILIKE '%PL';

WITH cand AS (
  SELECT i.id, i.style_id, i.color, i.inseam,
         split_part(i.sku_code, '-', array_length(string_to_array(i.sku_code,'-'),1)) AS tail,
         row_number() OVER (
           PARTITION BY i.style_id, COALESCE(i.color,''), COALESCE(i.inseam,''),
             canonical_size(split_part(i.sku_code, '-', array_length(string_to_array(i.sku_code,'-'),1)))
           ORDER BY i.id) AS rn
  FROM ip_item_master i
  WHERE i.size IS NULL AND i.style_code NOT ILIKE '%PL' AND i.sku_code IS NOT NULL
    AND upper(split_part(i.sku_code, '-', array_length(string_to_array(i.sku_code,'-'),1)))
        ~ '^(XX?S|S|M|L|XL|XXL|[2-5]XL|[2-5]X|XSMALL|SMALL|MEDIUM|LARGE|XLARGE|[2-3]XLARGE|[2-6]T|OS|[0-9]{1,2}|[0-9]{1,2}MO|[0-9]{1,2}M|[0-9]{1,2}Y|[SMLX]+/[0-9]{1,2})$'
)
UPDATE ip_item_master t
SET size = c.tail
FROM cand c
WHERE t.id = c.id AND c.rn = 1
  AND NOT EXISTS (
    SELECT 1 FROM ip_item_master x
    WHERE x.style_id = c.style_id
      AND x.color IS NOT DISTINCT FROM c.color
      AND COALESCE(x.inseam,'') = COALESCE(c.inseam,'')
      AND x.size IS NOT NULL
      AND canonical_size(x.size) = canonical_size(c.tail)
      AND x.id <> t.id
  );
