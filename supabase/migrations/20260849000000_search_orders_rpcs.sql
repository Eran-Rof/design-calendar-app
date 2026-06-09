-- All-field SO/PO list search, including line-level style / SKU / line
-- description — done entirely in SQL so the API never has to ship a large
-- id.in.(…thousands of uuids…) URL on every keystroke.
--
-- Each function returns the matching header rows for the default entity,
-- newest first, capped. p_q matches (case-insensitive substring):
--   • the order number and notes,
--   • the customer / vendor name + code, and
--   • any line's description or its SKU's sku_code / style_code / description.
-- NULL/empty p_q returns all rows for the entity (subject to the other filters).
-- p_brand_id / p_channel_id are NULL ("all") unless BRAND_SCOPE_MODE=enforce —
-- mirroring applyBrandScope/applyChannelScope in api/_lib/brandContext.js.
--
-- SECURITY INVOKER (default): RLS still applies to any direct caller; the API
-- calls these as the service role (its only intended caller). EXECUTE is locked
-- to service_role — anon/authenticated never call these directly.

CREATE OR REPLACE FUNCTION search_sales_orders(
  p_entity_id  uuid,
  p_q          text,
  p_status     text DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL,
  p_brand_id   uuid DEFAULT NULL,
  p_channel_id uuid DEFAULT NULL,
  p_limit      integer DEFAULT 200
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
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 500));
$$;

CREATE OR REPLACE FUNCTION search_purchase_orders(
  p_entity_id uuid,
  p_q         text,
  p_status    text DEFAULT NULL,
  p_vendor_id uuid DEFAULT NULL,
  p_brand_id  uuid DEFAULT NULL,
  p_limit     integer DEFAULT 200
)
RETURNS SETOF purchase_orders
LANGUAGE sql
STABLE
AS $$
  SELECT po.*
  FROM purchase_orders po
  WHERE po.entity_id = p_entity_id
    AND (p_status IS NULL OR po.status = p_status)
    AND (p_vendor_id IS NULL OR po.vendor_id = p_vendor_id)
    AND (p_brand_id IS NULL OR po.brand_id = p_brand_id)
    AND (
      p_q IS NULL OR p_q = ''
      OR po.po_number ILIKE '%' || p_q || '%'
      OR po.notes ILIKE '%' || p_q || '%'
      OR EXISTS (
        SELECT 1 FROM vendors v
        WHERE v.id = po.vendor_id
          AND (v.name ILIKE '%' || p_q || '%' OR v.code ILIKE '%' || p_q || '%')
      )
      OR EXISTS (
        SELECT 1 FROM purchase_order_lines l
        LEFT JOIN ip_item_master im ON im.id = l.inventory_item_id
        WHERE l.purchase_order_id = po.id
          AND (
            l.description ILIKE '%' || p_q || '%'
            OR im.sku_code ILIKE '%' || p_q || '%'
            OR im.style_code ILIKE '%' || p_q || '%'
            OR im.description ILIKE '%' || p_q || '%'
          )
      )
    )
  ORDER BY po.order_date DESC, po.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 500));
$$;

REVOKE ALL ON FUNCTION search_sales_orders(uuid, text, text, uuid, uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION search_purchase_orders(uuid, text, text, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_sales_orders(uuid, text, text, uuid, uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION search_purchase_orders(uuid, text, text, uuid, uuid, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
