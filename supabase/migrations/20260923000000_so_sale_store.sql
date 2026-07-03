-- Item 5 — add a "store" (Xoro SaleStoreName) dimension to native sales orders so
-- the Sales Order grid can filter by selling store (ROF Main / ROF - ECOM /
-- Psycho Tuna / Prebook - Psycho Tuna), mirroring the Inventory Matrix store
-- filter. Backfills existing imported SOs from the tanda_sos mirror payload
-- (data->>'SaleStoreName'). Nullable for app-created SOs.

ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS sale_store text;

COMMENT ON COLUMN sales_orders.sale_store IS 'Selling store (Xoro SaleStoreName) driving the SO grid store filter; nullable for app-created orders.';

CREATE INDEX IF NOT EXISTS idx_sales_orders_entity_sale_store
  ON sales_orders (entity_id, sale_store);

-- One-time backfill of already-imported native SOs from the Xoro SO mirror.
UPDATE sales_orders so
   SET sale_store = ts.data->>'SaleStoreName'
  FROM tanda_sos ts
 WHERE ts.so_number = so.so_number
   AND so.sale_store IS NULL
   AND NULLIF(ts.data->>'SaleStoreName', '') IS NOT NULL;

-- Distinct store list for the grid filter dropdown (avoids the PostgREST
-- 1000-row cap that a plain column select would hit on the full SO table).
CREATE OR REPLACE FUNCTION distinct_so_sale_stores(p_entity_id uuid)
RETURNS TABLE(sale_store text)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT s.sale_store
    FROM sales_orders s
   WHERE s.entity_id = p_entity_id
     AND s.sale_store IS NOT NULL
     AND s.sale_store <> ''
   ORDER BY 1
$$;
