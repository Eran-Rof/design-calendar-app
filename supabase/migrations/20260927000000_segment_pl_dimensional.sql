-- 20260927000000_segment_pl_dimensional.sql
-- ════════════════════════════════════════════════════════════════════════════
-- P26 Segment / Dimensional P&L — Phase 1a (reporting layer over the sub-ledgers).
--
-- WHY: The Tangerine GL has ZERO posted sales (journal_entry_lines has no 4xxx/
-- 5xxx activity); the real sales history lives in ip_sales_history_wholesale
-- ($41.6M, 50k rows) and (forthcoming) ip_sales_history_ecom. The CEO wants
-- Revenue + COGS + margin sliced by Brand × Channel × Store/Warehouse × Gender
-- as configurable columns, with GL accounts SHARED (the split is a reporting
-- pivot, not new accounts). So we build a dimensional VIEW over the sub-ledgers
-- + a small grouped RPC the API pivots into operator-defined columns.
--
-- Brand is derived from style_master BY style_code (the canonical brand source;
-- ip_item_master.brand_id is known-unreliable — see ATS brand note). Gender is
-- ip_item_master.gender_code, normalized legacy 'WMS' → 'W'. Channel + store are
-- coarse today (wholesale → WHOLESALE / Main Warehouse; ecom → DTC / brand ecom
-- store) and refine once the Xoro ecom import lands. ecom COGS is unknown in the
-- source (no cogs column) → NULL.
--
-- Idempotent: CREATE OR REPLACE only. No data writes. NOTIFY pgrst at the end.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW v_sales_dimensional AS
SELECT
  'wholesale'::text                                                  AS source,
  im.entity_id                                                       AS entity_id,
  h.txn_date                                                         AS txn_date,
  sm.brand_id                                                        AS brand_id,
  'WHOLESALE'::text                                                  AS channel_code,
  'Main Warehouse'::text                                             AS store_key,
  CASE WHEN im.gender_code = 'WMS' THEN 'W' ELSE im.gender_code END   AS gender_code,
  h.sku_id                                                           AS sku_id,
  im.style_code                                                      AS style_code,
  h.qty                                                              AS qty,
  COALESCE(h.net_amount, 0)::numeric                                 AS net_sales,
  h.cogs_amount::numeric                                             AS cogs
FROM ip_sales_history_wholesale h
JOIN ip_item_master im ON im.id = h.sku_id
LEFT JOIN style_master sm
       ON sm.style_code = im.style_code AND sm.entity_id = im.entity_id

UNION ALL

SELECT
  'ecom'::text,
  im.entity_id,
  e.order_date,
  sm.brand_id,
  'DTC'::text,
  CASE WHEN bm.code = 'PT' THEN 'PT Ecom' ELSE 'ROF Ecom' END,
  CASE WHEN im.gender_code = 'WMS' THEN 'W' ELSE im.gender_code END,
  e.sku_id,
  im.style_code,
  e.net_qty,
  COALESCE(e.net_amount, 0)::numeric,
  NULL::numeric   -- ecom source has no COGS column
FROM ip_sales_history_ecom e
JOIN ip_item_master im ON im.id = e.sku_id
LEFT JOIN style_master sm
       ON sm.style_code = im.style_code AND sm.entity_id = im.entity_id
LEFT JOIN brand_master bm ON bm.id = sm.brand_id;

COMMENT ON VIEW v_sales_dimensional IS 'P26 dimensional sales fact over the sub-ledgers (wholesale + ecom). Brand via style_master by style_code; gender normalized WMS->W; ecom cogs NULL. Source of the Segment P&L.';

-- Grouped breakdown the API pivots into configurable columns. Result is small
-- (brands × channels × stores × genders) so column composition is pure app code.
CREATE OR REPLACE FUNCTION segment_pl_breakdown(
  p_entity_id uuid,
  p_from_date date,
  p_to_date   date
) RETURNS TABLE (
  brand_id     uuid,
  brand_code   text,
  brand_name   text,
  channel_code text,
  store_key    text,
  gender_code  text,
  lines        bigint,
  qty          numeric,
  net_sales    numeric,
  cogs         numeric
) LANGUAGE sql STABLE AS $$
  SELECT
    v.brand_id,
    bm.code,
    bm.name,
    v.channel_code,
    v.store_key,
    v.gender_code,
    count(*)::bigint                  AS lines,
    sum(v.qty)                        AS qty,
    round(sum(v.net_sales), 2)        AS net_sales,
    round(sum(v.cogs), 2)             AS cogs
  FROM v_sales_dimensional v
  LEFT JOIN brand_master bm ON bm.id = v.brand_id
  WHERE v.entity_id = p_entity_id
    AND v.txn_date >= p_from_date
    AND v.txn_date <= p_to_date
  GROUP BY v.brand_id, bm.code, bm.name, v.channel_code, v.store_key, v.gender_code;
$$;

COMMENT ON FUNCTION segment_pl_breakdown(uuid, date, date) IS 'P26 Segment P&L: net sales + cogs + qty grouped by brand/channel/store/gender over a date range. The API composes operator-defined columns from these rows.';

NOTIFY pgrst, 'reload schema';
