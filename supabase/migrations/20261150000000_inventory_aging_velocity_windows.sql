-- 20261150000000_inventory_aging_velocity_windows.sql
-- ════════════════════════════════════════════════════════════════════════════
-- Inventory Aging — add trailing-window velocity: units sold T9 (270d) + T12
-- (365d) alongside the existing T3 (90d).
--
-- CEO ask: "avrg cost, last sold and units sold T3 (90 days) — add those columns
-- to the grid… for T3 add T9 and T12 as well." Avg cost / last sold / units_90
-- already exist as report outputs; this migration adds the two NEW trailing
-- windows so the grid can show sold-in-270d and sold-in-365d columns.
--
-- Re-creates inventory_aging_report copying 20261110000000 EXACTLY, with:
--   • sales CTE also computes units_270 (>as_of-270) and units_365 (>as_of-365),
--     same CASE pattern as units_90;
--   • by_item + agg thread them through exactly like units_90;
--   • two NEW output columns appended at the END of RETURNS TABLE
--     (units_sold_270, units_sold_365) so existing positional consumers are safe.
-- weeks_of_supply stays computed off units_90 (unchanged). inventory_aging_kpis
-- and inventory_aging_layers are untouched.
-- ════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS inventory_aging_report(
  uuid, date, text, integer[], uuid, text, text, text, text, uuid, uuid, uuid,
  integer, integer, bigint, numeric, integer, boolean);

CREATE FUNCTION inventory_aging_report(
  p_entity_id       uuid,
  p_as_of           date        DEFAULT CURRENT_DATE,
  p_group_by        text        DEFAULT 'style',
  p_bucket_days     integer[]   DEFAULT ARRAY[30,60,90,180,365],
  p_category_id     uuid        DEFAULT NULL,
  p_gender          text        DEFAULT NULL,
  p_style_code      text        DEFAULT NULL,
  p_color           text        DEFAULT NULL,
  p_size            text        DEFAULT NULL,
  p_brand_id        uuid        DEFAULT NULL,
  p_vendor_id       uuid        DEFAULT NULL,
  p_location_id     uuid        DEFAULT NULL,
  p_min_age_days    integer     DEFAULT 0,
  p_bucket          integer     DEFAULT NULL,
  p_min_value_cents bigint      DEFAULT 0,
  p_min_qty         numeric     DEFAULT 0,
  p_slow_days       integer     DEFAULT NULL,
  p_include_zero    boolean     DEFAULT false
)
RETURNS TABLE (
  grain_key            text,
  grain_label          text,
  style_code           text,
  color                text,
  size                 text,
  gender               text,
  category_name        text,
  brand_name           text,
  vendor_name          text,
  location_name        text,
  on_hand_qty          numeric,
  cost_value_cents     numeric,
  avg_unit_cost_cents  numeric,
  wavg_age_days        numeric,
  oldest_age_days      integer,
  last_received        date,
  b1_qty numeric, b1_value_cents numeric,
  b2_qty numeric, b2_value_cents numeric,
  b3_qty numeric, b3_value_cents numeric,
  b4_qty numeric, b4_value_cents numeric,
  b5_qty numeric, b5_value_cents numeric,
  b6_qty numeric, b6_value_cents numeric,
  int_daily_cents      numeric,
  int_monthly_cents    numeric,
  int_annual_cents     numeric,
  sto_daily_cents      numeric,
  sto_monthly_cents    numeric,
  sto_annual_cents     numeric,
  carry_pct            numeric,
  carry_per_unit_cents numeric,
  last_sold            date,
  days_since_last_sale integer,
  units_sold_90        numeric,
  weeks_of_supply      numeric,
  uncosted_qty         numeric,
  units_sold_270       numeric,
  units_sold_365       numeric
) AS $$
  WITH
  -- per-SKU Tangerine receipt-history last-receipt (size grain, by item_id)
  rh_lrd AS (
    SELECT sku_id, MAX(received_date) AS lrd
    FROM ip_receipts_history
    GROUP BY sku_id
  ),
  -- layers scoped + effective received date (mirrored only) + effective cost
  lc AS (
    SELECT
      il.item_id,
      il.location_id,
      il.remaining_qty AS qty,
      im.style_code, im.color, im.size, im.gender_code, im.sku_code,
      im.category_id, im.vendor_id, im.brand_id,
      CASE WHEN il.source_kind = 'xoro_rest_size'
           THEN COALESCE(alr.last_receipt_date, rlr.lrd, il.received_at::date)
           ELSE il.received_at::date
      END AS eff_recv,
      COALESCE(
        NULLIF(il.unit_cost_cents, 0),
        NULLIF(round(ac.avg_cost * 100), 0),
        NULLIF(round(im.unit_cost * 100), 0),
        0
      )::numeric AS eff_cost_cents,
      (COALESCE(
        NULLIF(il.unit_cost_cents, 0),
        NULLIF(round(ac.avg_cost * 100), 0),
        NULLIF(round(im.unit_cost * 100), 0),
        0
      ) = 0) AS is_uncosted
    FROM inventory_layers il
    JOIN ip_item_master im ON im.id = il.item_id
    LEFT JOIN ip_item_avg_cost ac ON ac.sku_code = im.sku_code
    LEFT JOIN ats_last_receipt alr ON alr.sku_code = im.sku_code
    LEFT JOIN rh_lrd  rlr ON rlr.sku_id = il.item_id
    WHERE il.entity_id = p_entity_id
      AND il.received_at::date <= p_as_of
      AND (p_include_zero OR il.remaining_qty > 0)
      AND (p_location_id IS NULL OR il.location_id = p_location_id)
      AND (p_category_id IS NULL OR im.category_id = p_category_id)
      AND (p_gender      IS NULL OR im.gender_code = p_gender)
      AND (p_style_code  IS NULL OR im.style_code  = p_style_code)
      AND (p_color       IS NULL OR im.color       = p_color)
      AND (p_size        IS NULL OR im.size        = p_size)
      AND (p_brand_id    IS NULL OR im.brand_id    = p_brand_id)
      AND (p_vendor_id   IS NULL OR im.vendor_id   = p_vendor_id)
  ),
  enriched AS (
    SELECT
      lc.item_id, lc.qty, lc.eff_cost_cents, lc.is_uncosted,
      lc.style_code, lc.color, lc.size, lc.gender_code, lc.sku_code,
      GREATEST(0, p_as_of - LEAST(lc.eff_recv, p_as_of))::int AS age_days,
      lc.eff_recv AS recv_date,
      CASE
        WHEN GREATEST(0, p_as_of - LEAST(lc.eff_recv, p_as_of)) <= p_bucket_days[1] THEN 1
        WHEN GREATEST(0, p_as_of - LEAST(lc.eff_recv, p_as_of)) <= p_bucket_days[2] THEN 2
        WHEN GREATEST(0, p_as_of - LEAST(lc.eff_recv, p_as_of)) <= p_bucket_days[3] THEN 3
        WHEN GREATEST(0, p_as_of - LEAST(lc.eff_recv, p_as_of)) <= p_bucket_days[4] THEN 4
        WHEN GREATEST(0, p_as_of - LEAST(lc.eff_recv, p_as_of)) <= p_bucket_days[5] THEN 5
        ELSE 6
      END AS bkt,
      cat.name AS cat_name,
      br.name  AS brand_name,
      ven.name AS vendor_name,
      loc.name AS loc_name,
      CASE p_group_by
        WHEN 'style'       THEN COALESCE(lc.style_code, '(unknown)')
        WHEN 'style_color' THEN COALESCE(lc.style_code, '(unknown)') || '|' || COALESCE(lc.color, '')
        WHEN 'sku'         THEN lc.item_id::text
        WHEN 'category'    THEN COALESCE(lc.category_id::text, '(uncategorized)')
        WHEN 'warehouse'   THEN COALESCE(lc.location_id::text, '(no-location)')
        WHEN 'vendor'      THEN COALESCE(lc.vendor_id::text, '(no-vendor)')
        ELSE COALESCE(lc.style_code, '(unknown)')
      END AS grain_key,
      CASE p_group_by
        WHEN 'style'       THEN COALESCE(lc.style_code, '(unknown)')
        WHEN 'style_color' THEN COALESCE(lc.style_code, '(unknown)') || ' - ' || COALESCE(lc.color, '(no color)')
        WHEN 'sku'         THEN COALESCE(lc.sku_code, lc.item_id::text)
        WHEN 'category'    THEN COALESCE(cat.name, '(uncategorized)')
        WHEN 'warehouse'   THEN COALESCE(loc.name, '(no location)')
        WHEN 'vendor'      THEN COALESCE(ven.name, '(no vendor)')
        ELSE COALESCE(lc.style_code, '(unknown)')
      END AS grain_label
    FROM lc
    LEFT JOIN ip_category_master cat ON cat.id = lc.category_id
    LEFT JOIN ip_vendor_master   ven ON ven.id = lc.vendor_id
    LEFT JOIN brand_master        br ON br.id  = lc.brand_id
    LEFT JOIN inventory_locations loc ON loc.id = lc.location_id
  ),
  filt AS (
    SELECT * FROM enriched
    WHERE (p_bucket IS NULL OR bkt = p_bucket)
      AND (COALESCE(p_min_age_days, 0) <= 0 OR age_days >= p_min_age_days)
  ),
  sales AS (
    SELECT ail.inventory_item_id AS item_id,
           MAX(ai.invoice_date) AS last_sold,
           SUM(CASE WHEN ai.invoice_date > (p_as_of - 90) AND ai.invoice_date <= p_as_of
                    THEN ail.quantity ELSE 0 END) AS units_90,
           SUM(CASE WHEN ai.invoice_date > (p_as_of - 270) AND ai.invoice_date <= p_as_of
                    THEN ail.quantity ELSE 0 END) AS units_270,
           SUM(CASE WHEN ai.invoice_date > (p_as_of - 365) AND ai.invoice_date <= p_as_of
                    THEN ail.quantity ELSE 0 END) AS units_365
    FROM ar_invoice_lines ail
    JOIN ar_invoices ai ON ai.id = ail.ar_invoice_id
    WHERE ai.entity_id = p_entity_id
      AND ai.gl_status IN ('posted','posted_historical','partial_paid','sent')
      AND ai.invoice_date <= p_as_of
      AND ail.inventory_item_id IN (SELECT DISTINCT item_id FROM filt)
    GROUP BY ail.inventory_item_id
  ),
  by_item AS (
    SELECT
      f.grain_key, f.grain_label, f.item_id,
      MAX(f.style_code)  AS style_code,
      MAX(f.color)       AS color,
      MAX(f.size)        AS size,
      MAX(f.gender_code) AS gender,
      MAX(f.cat_name)    AS cat_name,
      MAX(f.brand_name)  AS brand_name,
      MAX(f.vendor_name) AS vendor_name,
      MAX(f.loc_name)    AS loc_name,
      SUM(f.qty)                                     AS qty,
      SUM(f.qty * f.eff_cost_cents)                  AS value_cents,
      SUM(f.qty) FILTER (WHERE f.is_uncosted)        AS uncosted_qty,
      SUM(f.qty * f.age_days)                        AS age_num,
      MAX(f.age_days)                                AS oldest,
      MAX(f.recv_date)                               AS last_recv,
      SUM(f.qty) FILTER (WHERE f.bkt = 1)                      AS b1q,
      SUM(f.qty * f.eff_cost_cents) FILTER (WHERE f.bkt = 1)   AS b1v,
      SUM(f.qty) FILTER (WHERE f.bkt = 2)                      AS b2q,
      SUM(f.qty * f.eff_cost_cents) FILTER (WHERE f.bkt = 2)   AS b2v,
      SUM(f.qty) FILTER (WHERE f.bkt = 3)                      AS b3q,
      SUM(f.qty * f.eff_cost_cents) FILTER (WHERE f.bkt = 3)   AS b3v,
      SUM(f.qty) FILTER (WHERE f.bkt = 4)                      AS b4q,
      SUM(f.qty * f.eff_cost_cents) FILTER (WHERE f.bkt = 4)   AS b4v,
      SUM(f.qty) FILTER (WHERE f.bkt = 5)                      AS b5q,
      SUM(f.qty * f.eff_cost_cents) FILTER (WHERE f.bkt = 5)   AS b5v,
      SUM(f.qty) FILTER (WHERE f.bkt = 6)                      AS b6q,
      SUM(f.qty * f.eff_cost_cents) FILTER (WHERE f.bkt = 6)   AS b6v,
      MAX(s.last_sold)              AS last_sold,
      COALESCE(MAX(s.units_90), 0)  AS units_90,
      COALESCE(MAX(s.units_270), 0) AS units_270,
      COALESCE(MAX(s.units_365), 0) AS units_365
    FROM filt f
    LEFT JOIN sales s ON s.item_id = f.item_id
    GROUP BY f.grain_key, f.grain_label, f.item_id
  ),
  agg AS (
    SELECT
      bi.grain_key, bi.grain_label,
      MAX(bi.style_code)  AS style_code,
      MAX(bi.color)       AS color,
      MAX(bi.size)        AS size,
      MAX(bi.gender)      AS gender,
      MAX(bi.cat_name)    AS category_name,
      MAX(bi.brand_name)  AS brand_name,
      MAX(bi.vendor_name) AS vendor_name,
      MAX(bi.loc_name)    AS location_name,
      SUM(bi.qty)                                  AS on_hand_qty,
      SUM(bi.value_cents)                          AS cost_value_cents,
      COALESCE(SUM(bi.uncosted_qty),0)             AS uncosted_qty,
      SUM(bi.age_num)                              AS age_num,
      MAX(bi.oldest)                               AS oldest_age_days,
      MAX(bi.last_recv)                            AS last_received,
      COALESCE(SUM(bi.b1q),0) AS b1q, COALESCE(SUM(bi.b1v),0) AS b1v,
      COALESCE(SUM(bi.b2q),0) AS b2q, COALESCE(SUM(bi.b2v),0) AS b2v,
      COALESCE(SUM(bi.b3q),0) AS b3q, COALESCE(SUM(bi.b3v),0) AS b3v,
      COALESCE(SUM(bi.b4q),0) AS b4q, COALESCE(SUM(bi.b4v),0) AS b4v,
      COALESCE(SUM(bi.b5q),0) AS b5q, COALESCE(SUM(bi.b5v),0) AS b5v,
      COALESCE(SUM(bi.b6q),0) AS b6q, COALESCE(SUM(bi.b6v),0) AS b6v,
      MAX(bi.last_sold)   AS last_sold,
      SUM(bi.units_90)    AS units_90,
      SUM(bi.units_270)   AS units_270,
      SUM(bi.units_365)   AS units_365
    FROM by_item bi
    GROUP BY bi.grain_key, bi.grain_label
  )
  SELECT
    a.grain_key,
    a.grain_label,
    a.style_code, a.color, a.size, a.gender,
    a.category_name, a.brand_name, a.vendor_name, a.location_name,
    a.on_hand_qty,
    a.cost_value_cents,
    CASE WHEN a.on_hand_qty > 0 THEN a.cost_value_cents / a.on_hand_qty ELSE 0 END AS avg_unit_cost_cents,
    CASE WHEN a.on_hand_qty > 0 THEN a.age_num / a.on_hand_qty ELSE 0 END          AS wavg_age_days,
    a.oldest_age_days::int,
    a.last_received,
    a.b1q, a.b1v, a.b2q, a.b2v, a.b3q, a.b3v, a.b4q, a.b4v, a.b5q, a.b5v, a.b6q, a.b6v,
    (a.cost_value_cents * 0.09 / 360.0)                          AS int_daily_cents,
    (a.cost_value_cents * 0.09 / 12.0)                           AS int_monthly_cents,
    (a.cost_value_cents * 0.09)                                  AS int_annual_cents,
    (a.on_hand_qty / 864.0 * 20.0 * 100.0 / 30.0)               AS sto_daily_cents,
    (a.on_hand_qty / 864.0 * 20.0 * 100.0)                      AS sto_monthly_cents,
    (a.on_hand_qty / 864.0 * 20.0 * 100.0 * 12.0)               AS sto_annual_cents,
    CASE WHEN a.cost_value_cents > 0
         THEN ((a.cost_value_cents * 0.09) + (a.on_hand_qty / 864.0 * 20.0 * 100.0 * 12.0)) / a.cost_value_cents
         ELSE 0 END                                              AS carry_pct,
    CASE WHEN a.on_hand_qty > 0
         THEN ((a.cost_value_cents * 0.09) + (a.on_hand_qty / 864.0 * 20.0 * 100.0 * 12.0)) / a.on_hand_qty
         ELSE 0 END                                              AS carry_per_unit_cents,
    a.last_sold,
    CASE WHEN a.last_sold IS NULL THEN NULL ELSE (p_as_of - a.last_sold) END AS days_since_last_sale,
    a.units_90,
    CASE WHEN a.units_90 > 0
         THEN a.on_hand_qty / (a.units_90 / (90.0 / 7.0))
         ELSE NULL END                                           AS weeks_of_supply,
    a.uncosted_qty,
    a.units_270,
    a.units_365
  FROM agg a
  WHERE (COALESCE(p_min_value_cents, 0) <= 0 OR a.cost_value_cents >= p_min_value_cents)
    AND (COALESCE(p_min_qty, 0) <= 0        OR a.on_hand_qty      >= p_min_qty)
    AND (p_slow_days IS NULL
         OR a.last_sold IS NULL
         OR (p_as_of - a.last_sold) >= p_slow_days)
  ORDER BY a.cost_value_cents DESC, a.on_hand_qty DESC;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION inventory_aging_report(uuid, date, text, integer[], uuid, text, text, text, text, uuid, uuid, uuid, integer, integer, bigint, numeric, integer, boolean)
IS 'Inventory aging over inventory_layers as of p_as_of. Mirrored (xoro_rest_size) layers age off an EFFECTIVE last-received date (ATS last_receipt_date > receipts_history > snapshot date); native receipt layers keep their true received_at. Cost is COALESCEd layer>avg_cost>item unit_cost; still-$0 units are reported in uncosted_qty. Per configurable grain + buckets, ATS carrying costs, and velocity: units sold in trailing 90 (T3, units_sold_90), 270 (T9, units_sold_270) and 365 (T12, units_sold_365) days from the aged date; weeks_of_supply stays off the trailing-90 sell-through.';
