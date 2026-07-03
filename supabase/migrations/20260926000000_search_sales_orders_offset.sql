-- Add p_offset to search_sales_orders so the SO list "Export all" can paginate
-- the text-search path past the first 500 rows (operator item 17). The page size
-- stays capped at 500; the caller walks offset 0, 500, 1000, … to cover the whole
-- filtered set. Drop the old 7-arg signature first (a CREATE OR REPLACE can't
-- change the argument list — it would leave an ambiguous overload).

DROP FUNCTION IF EXISTS search_sales_orders(uuid, text, text, uuid, uuid, uuid, integer);

CREATE FUNCTION search_sales_orders(
  p_entity_id  uuid,
  p_q          text,
  p_status     text DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL,
  p_brand_id   uuid DEFAULT NULL,
  p_channel_id uuid DEFAULT NULL,
  p_limit      integer DEFAULT 200,
  p_offset     integer DEFAULT 0
)
RETURNS SETOF sales_orders
LANGUAGE sql
STABLE
AS $$
  SELECT so.*
  FROM sales_orders so
  WHERE so.entity_id = p_entity_id
    AND (p_status IS NULL OR so.status = p_status)
    AND (p_customer_id IS NULL OR so.customer_id = p_customer_id)
    AND (p_brand_id IS NULL OR so.brand_id = p_brand_id)
    AND (p_channel_id IS NULL OR so.channel_id = p_channel_id)
    AND (
      p_q IS NULL OR p_q = ''
      OR so.so_number ILIKE '%' || p_q || '%'
      OR so.notes ILIKE '%' || p_q || '%'
      OR EXISTS (
        SELECT 1 FROM customers c
        WHERE c.id = so.customer_id
          AND (c.name ILIKE '%' || p_q || '%' OR c.customer_code ILIKE '%' || p_q || '%')
      )
      OR EXISTS (
        SELECT 1 FROM sales_order_lines l
        LEFT JOIN ip_item_master im ON im.id = l.inventory_item_id
        WHERE l.sales_order_id = so.id
          AND (
            l.description ILIKE '%' || p_q || '%'
            OR im.sku_code ILIKE '%' || p_q || '%'
            OR im.style_code ILIKE '%' || p_q || '%'
            OR im.description ILIKE '%' || p_q || '%'
          )
      )
    )
  ORDER BY so.order_date DESC, so.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 500))
  OFFSET GREATEST(0, COALESCE(p_offset, 0));
$$;

REVOKE ALL ON FUNCTION search_sales_orders(uuid, text, text, uuid, uuid, uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_sales_orders(uuid, text, text, uuid, uuid, uuid, integer, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
