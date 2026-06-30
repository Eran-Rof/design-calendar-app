-- 20260928000000_segment_pl_view_channel_fix.sql
-- ════════════════════════════════════════════════════════════════════════════
-- P26 Segment P&L — corrective follow-up to 20260927000000.
--
-- The first cut of v_sales_dimensional HARDCODED channel='WHOLESALE' / store=
-- 'Main Warehouse' and unioned the (empty) ip_sales_history_ecom table. But
-- ip_sales_history_wholesale ALREADY holds BOTH wholesale and ecom (DTC) rows,
-- distinguished by the linked ip_channel_master.channel_type ('wholesale'|'ecom')
-- and channel_code (ROF / PT / ROF ECOM / PT ECOM). The /api/sales/sync-invoices
-- ingest classifies the Xoro "Sale Store" into those channels. So this redefines
-- the view to DERIVE channel + store from the channel master (lighting up the
-- ROF DTC / PT DTC columns from EXISTING data — ROF Ecom ~$530k, PT Ecom ~$171k),
-- and DROPS the ip_sales_history_ecom union (empty today; unioning it would
-- double-count once it is ever populated).
--
-- CREATE OR REPLACE VIEW with the SAME column list/types as 20260927000000, so
-- the dependent segment_pl_breakdown() function is unaffected. Idempotent.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW v_sales_dimensional AS
SELECT
  cm.channel_type                                                    AS source,
  im.entity_id                                                       AS entity_id,
  h.txn_date                                                         AS txn_date,
  sm.brand_id                                                        AS brand_id,
  CASE WHEN cm.channel_type = 'ecom' THEN 'DTC' ELSE 'WHOLESALE' END  AS channel_code,
  CASE cm.channel_code
    WHEN 'ROF ECOM' THEN 'ROF Ecom'
    WHEN 'PT ECOM'  THEN 'PT Ecom'
    WHEN 'PT'       THEN 'Psycho Tuna'
    WHEN 'ROF'      THEN 'Main Warehouse'
    ELSE COALESCE(cm.name, 'Main Warehouse')
  END                                                                AS store_key,
  CASE WHEN im.gender_code = 'WMS' THEN 'W' ELSE im.gender_code END   AS gender_code,
  h.sku_id                                                           AS sku_id,
  im.style_code                                                      AS style_code,
  h.qty                                                              AS qty,
  COALESCE(h.net_amount, 0)::numeric                                 AS net_sales,
  h.cogs_amount::numeric                                             AS cogs
FROM ip_sales_history_wholesale h
JOIN ip_item_master im ON im.id = h.sku_id
LEFT JOIN ip_channel_master cm ON cm.id = h.channel_id
LEFT JOIN style_master sm
       ON sm.style_code = im.style_code AND sm.entity_id = im.entity_id;

COMMENT ON VIEW v_sales_dimensional IS 'P26 dimensional sales fact over ip_sales_history_wholesale (Xoro invoice sales, both wholesale + ecom). Channel/store derived from ip_channel_master.channel_type/channel_code; brand via style_master by style_code; gender normalized WMS->W. Source of the Segment P&L.';

NOTIFY pgrst, 'reload schema';
