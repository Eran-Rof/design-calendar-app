-- One-off backfill: customers.default_brand_id = the brand the customer bought
-- the MOST $ of (from wholesale sales history), else Ring of Fire.
--   • Brand resolves via ip_item_master.style_code -> style_master.brand_id
--     (the reliable path; ip_item_master.brand_id is a ROF-default placeholder).
--   • Revenue = COALESCE(net_amount, gross_amount, qty*unit_price).
-- Only fills NULLs, so it never overwrites an operator's manual pick. Editable
-- afterward on the Customer Master Reps tab.
WITH cbr AS (
  SELECT shw.customer_id, sm.brand_id,
         SUM(COALESCE(shw.net_amount, shw.gross_amount, shw.qty*shw.unit_price))::numeric AS rev
  FROM ip_sales_history_wholesale shw
  JOIN ip_item_master im ON shw.sku_id = im.id
  JOIN style_master sm ON im.style_code = sm.style_code
  WHERE shw.customer_id IS NOT NULL AND sm.brand_id IS NOT NULL
  GROUP BY shw.customer_id, sm.brand_id
), top AS (
  SELECT customer_id, brand_id,
         ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY rev DESC) AS rn
  FROM cbr
)
UPDATE customers c
   SET default_brand_id = t.brand_id
  FROM top t
 WHERE c.id = t.customer_id AND t.rn = 1
   AND c.default_brand_id IS NULL AND c.deleted_at IS NULL;

-- Fallback: anything still unset -> Ring of Fire.
UPDATE customers c
   SET default_brand_id = (SELECT id FROM brand_master WHERE code='ROF' ORDER BY is_default DESC NULLS LAST LIMIT 1)
 WHERE c.default_brand_id IS NULL AND c.deleted_at IS NULL;
