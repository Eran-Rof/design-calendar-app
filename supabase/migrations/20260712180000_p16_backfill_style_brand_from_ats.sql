-- P16 (batch 3) — backfill style_master.brand_id from the ATS app's brand signal.
--
-- The ATS app records each style's selling brand as the open-sales-order `store`
-- (ROF = Ring of Fire, PT = Psycho Tuna), which maps 1:1 to brand_master.code.
-- All styles currently carry the default ROF brand (P15 default); this assigns
-- the real brand by the style's most-common SO store. Only styles whose SOs are
-- predominantly a non-ROF store (e.g. PT) change.
--
-- Path: ip_open_sales_orders.sku_id → ip_item_master.style_id → style_master.id;
--       ip_open_sales_orders.store  → brand_master.code.
-- Idempotent (re-running yields the same assignment).

UPDATE style_master sm
SET brand_id = b.brand_id, updated_at = now()
FROM (
  SELECT
    iim.style_id,
    bm.id AS brand_id,
    row_number() OVER (PARTITION BY iim.style_id ORDER BY count(*) DESC) AS rn
  FROM ip_open_sales_orders so
  JOIN ip_item_master iim ON iim.id = so.sku_id
  JOIN brand_master    bm  ON bm.code = upper(btrim(so.store))
  WHERE iim.style_id IS NOT NULL
    AND so.store IS NOT NULL AND btrim(so.store) <> ''
  GROUP BY iim.style_id, bm.id
) b
WHERE sm.id = b.style_id
  AND b.rn = 1
  AND sm.brand_id IS DISTINCT FROM b.brand_id;
