-- 20261090000000_inventory_aging.sql
-- ════════════════════════════════════════════════════════════════════════════
-- Inventory Aging — best-in-class, FIFO-layer-level aged-inventory reporting.
--
-- CEO ask: "add a best-in-class inventory aging report, multiple filters
-- including aged date. The ATS aging report is good but Tangerine needs to be
-- richer."
--
-- What the ATS report does (src/ats/agedInvenMath.ts) — KEPT here 1:1:
--   • Carrying-cost economics: interest (9%/yr, daily = val*rate/360, monthly,
--     annual) + storage ($20/pallet/month, 864 pcs/pallet), plus %-cost and
--     $-cost-per-unit — "what it costs to hold aged stock".
--   • Weighted-average age, value at avg cost, oldest age.
-- Where Tangerine is RICHER (this migration):
--   • ATS ages off a SINGLE "last received date" per SKU (missing → 2024-09-30)
--     and always ages to TODAY. Tangerine ages off TRUE FIFO LAYERS
--     (inventory_layers.received_at) as of ANY chosen p_as_of date — each layer
--     carries its own age, so on-hand splits across age buckets correctly.
--   • Configurable grain (style / style+color / SKU / category / warehouse /
--     vendor), configurable bucket cut-offs, a full filter set, and velocity
--     (last-sold, days-since-sale, units-sold-90, weeks-of-supply).
--
-- ⚠ AS-OF CAVEAT (documented, intentional): inventory_layers.remaining_qty is
--    the CURRENT on-hand per layer — historical layer consumption is not
--    reconstructable from this table. So p_as_of ages the RECEIPT date
--    (received_at ≤ p_as_of) but the on-hand quantity is the CURRENT
--    remaining_qty. Picking an older as-of date therefore re-computes AGES from
--    that date's perspective against today's on-hand, not a full point-in-time
--    inventory restatement. This matches the ATS report's on-hand semantics
--    while adding true per-layer ages.
--
-- Objects (all idempotent — CREATE OR REPLACE / DROP IF EXISTS / IF NOT EXISTS):
--   • inventory_aging_report(...)  — per-grain aggregate: on-hand qty, cost
--       value, weighted-avg age, oldest age, qty+$ per age bucket (6 buckets,
--       configurable cut-offs), carrying costs (ATS constants), velocity.
--   • inventory_aging_kpis(...)    — headline totals + per-bucket qty/$ + dead
--       stock ($ aged past the last cut-off). Same filter set.
--   • indexes to keep both cheap.
--
-- No data change — read-model only.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Indexes — keep as-of aging + item join + velocity cheap ─────────────────
CREATE INDEX IF NOT EXISTS idx_inventory_layers_entity_item_open
  ON inventory_layers (entity_id, item_id)
  WHERE remaining_qty > 0;

CREATE INDEX IF NOT EXISTS idx_inventory_layers_received_at
  ON inventory_layers (entity_id, received_at);

CREATE INDEX IF NOT EXISTS idx_ar_invoice_lines_item
  ON ar_invoice_lines (inventory_item_id);

-- ════════════════════════════════════════════════════════════════════════════
-- inventory_aging_report — the parameterized grain aggregate.
--
-- p_group_by ∈ style | style_color | sku | category | warehouse | vendor
-- p_bucket_days — 5 ascending day cut-offs → 6 buckets:
--     b1 ≤ d1, b2 ≤ d2, b3 ≤ d3, b4 ≤ d4, b5 ≤ d5, b6 > d5
--   default ARRAY[30,60,90,180,365] → 0-30 / 31-60 / 61-90 / 91-180 / 181-365 / 365+
-- Optional filters (NULL / 0 = no filter):
--   p_category_id, p_gender, p_style_code, p_color, p_size, p_brand_id,
--   p_vendor_id, p_location_id, p_min_age_days (LAYER-level: only layers ≥ N
--   days old), p_bucket (LAYER-level: only layers in bucket 1..6),
--   p_min_value_cents / p_min_qty (GROUP-level HAVING), p_slow_days (GROUP-level:
--   no sale in ≥ N days, incl. never-sold), p_include_zero (default false =
--   exclude zero-on-hand layers).
-- ════════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS inventory_aging_report(
  uuid, date, text, integer[], uuid, text, text, text, text, uuid, uuid, uuid,
  integer, integer, bigint, numeric, integer, boolean);

CREATE OR REPLACE FUNCTION inventory_aging_report(
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
  weeks_of_supply      numeric
) AS $$
  WITH enriched AS (
    SELECT
      il.item_id,
      il.remaining_qty                                   AS qty,
      il.unit_cost_cents,
      (p_as_of - il.received_at::date)                   AS age_days,
      il.received_at::date                               AS recv_date,
      CASE
        WHEN (p_as_of - il.received_at::date) <= p_bucket_days[1] THEN 1
        WHEN (p_as_of - il.received_at::date) <= p_bucket_days[2] THEN 2
        WHEN (p_as_of - il.received_at::date) <= p_bucket_days[3] THEN 3
        WHEN (p_as_of - il.received_at::date) <= p_bucket_days[4] THEN 4
        WHEN (p_as_of - il.received_at::date) <= p_bucket_days[5] THEN 5
        ELSE 6
      END                                                AS bkt,
      im.style_code, im.color, im.size, im.gender_code,
      im.sku_code, im.description,
      cat.name  AS cat_name,
      br.name   AS brand_name,
      ven.name  AS vendor_name,
      loc.name  AS loc_name,
      CASE p_group_by
        WHEN 'style'       THEN COALESCE(im.style_code, '(unknown)')
        WHEN 'style_color' THEN COALESCE(im.style_code, '(unknown)') || '|' || COALESCE(im.color, '')
        WHEN 'sku'         THEN il.item_id::text
        WHEN 'category'    THEN COALESCE(im.category_id::text, '(uncategorized)')
        WHEN 'warehouse'   THEN COALESCE(il.location_id::text, '(no-location)')
        WHEN 'vendor'      THEN COALESCE(im.vendor_id::text, '(no-vendor)')
        ELSE COALESCE(im.style_code, '(unknown)')
      END                                                AS grain_key,
      CASE p_group_by
        WHEN 'style'       THEN COALESCE(im.style_code, '(unknown)')
        WHEN 'style_color' THEN COALESCE(im.style_code, '(unknown)') || ' - ' || COALESCE(im.color, '(no color)')
        WHEN 'sku'         THEN COALESCE(im.sku_code, il.item_id::text)
        WHEN 'category'    THEN COALESCE(cat.name, '(uncategorized)')
        WHEN 'warehouse'   THEN COALESCE(loc.name, '(no location)')
        WHEN 'vendor'      THEN COALESCE(ven.name, '(no vendor)')
        ELSE COALESCE(im.style_code, '(unknown)')
      END                                                AS grain_label
    FROM inventory_layers il
    JOIN ip_item_master im ON im.id = il.item_id
    LEFT JOIN ip_category_master cat ON cat.id = im.category_id
    LEFT JOIN ip_vendor_master   ven ON ven.id = im.vendor_id
    LEFT JOIN brand_master        br ON br.id  = im.brand_id
    LEFT JOIN inventory_locations loc ON loc.id = il.location_id
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
      AND (COALESCE(p_min_age_days, 0) <= 0
           OR (p_as_of - il.received_at::date) >= p_min_age_days)
  ),
  filt AS (
    SELECT * FROM enriched
    WHERE (p_bucket IS NULL OR bkt = p_bucket)
  ),
  -- velocity per item, evaluated as-of p_as_of; posted AR only (kind-agnostic:
  -- credit-memo negatives net against sales, which is the correct sell-through).
  sales AS (
    SELECT ail.inventory_item_id AS item_id,
           MAX(ai.invoice_date) AS last_sold,
           SUM(CASE WHEN ai.invoice_date > (p_as_of - 90) AND ai.invoice_date <= p_as_of
                    THEN ail.quantity ELSE 0 END) AS units_90
    FROM ar_invoice_lines ail
    JOIN ar_invoices ai ON ai.id = ail.ar_invoice_id
    WHERE ai.entity_id = p_entity_id
      AND ai.gl_status IN ('posted','posted_historical','partial_paid','sent')
      AND ai.invoice_date <= p_as_of
      AND ail.inventory_item_id IN (SELECT DISTINCT item_id FROM filt)
    GROUP BY ail.inventory_item_id
  ),
  -- stage A: per (grain, item) so each item's velocity is counted ONCE per grain
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
      SUM(f.qty)                                  AS qty,
      SUM(f.qty * f.unit_cost_cents)              AS value_cents,
      SUM(f.qty * f.age_days)                     AS age_num,
      MAX(f.age_days)                             AS oldest,
      MAX(f.recv_date)                            AS last_recv,
      SUM(f.qty) FILTER (WHERE f.bkt = 1)                     AS b1q,
      SUM(f.qty * f.unit_cost_cents) FILTER (WHERE f.bkt = 1) AS b1v,
      SUM(f.qty) FILTER (WHERE f.bkt = 2)                     AS b2q,
      SUM(f.qty * f.unit_cost_cents) FILTER (WHERE f.bkt = 2) AS b2v,
      SUM(f.qty) FILTER (WHERE f.bkt = 3)                     AS b3q,
      SUM(f.qty * f.unit_cost_cents) FILTER (WHERE f.bkt = 3) AS b3v,
      SUM(f.qty) FILTER (WHERE f.bkt = 4)                     AS b4q,
      SUM(f.qty * f.unit_cost_cents) FILTER (WHERE f.bkt = 4) AS b4v,
      SUM(f.qty) FILTER (WHERE f.bkt = 5)                     AS b5q,
      SUM(f.qty * f.unit_cost_cents) FILTER (WHERE f.bkt = 5) AS b5v,
      SUM(f.qty) FILTER (WHERE f.bkt = 6)                     AS b6q,
      SUM(f.qty * f.unit_cost_cents) FILTER (WHERE f.bkt = 6) AS b6v,
      MAX(s.last_sold)              AS last_sold,
      COALESCE(MAX(s.units_90), 0)  AS units_90
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
      SUM(bi.units_90)    AS units_90
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
    -- carrying costs (ATS constants: interest 9%/yr on 360-day year; storage
    -- $20/pallet/month, 864 pcs/pallet). Value is in cents; storage $→cents ×100.
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
         ELSE NULL END                                           AS weeks_of_supply
  FROM agg a
  WHERE (COALESCE(p_min_value_cents, 0) <= 0 OR a.cost_value_cents >= p_min_value_cents)
    AND (COALESCE(p_min_qty, 0) <= 0        OR a.on_hand_qty      >= p_min_qty)
    AND (p_slow_days IS NULL
         OR a.last_sold IS NULL
         OR (p_as_of - a.last_sold) >= p_slow_days)
  ORDER BY a.cost_value_cents DESC;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION inventory_aging_report(uuid, date, text, integer[], uuid, text, text, text, text, uuid, uuid, uuid, integer, integer, bigint, numeric, integer, boolean)
IS 'Best-in-class inventory aging over inventory_layers (TRUE FIFO layer ages) as of p_as_of. Per-grain (style|style_color|sku|category|warehouse|vendor) on-hand qty/value, weighted-avg + oldest age, qty+$ per configurable age bucket, ATS carrying costs (9%% interest / $20 pallet-mo, 864 pcs), and velocity. AS-OF ages receipt dates; on-hand = current remaining_qty (historical consumption not reconstructable).';

-- ════════════════════════════════════════════════════════════════════════════
-- inventory_aging_kpis — headline totals for the panel header + the final
-- report. Same filter set (grain-independent). p_dead_days = the "dead stock"
-- threshold (default 365) — value/qty aged past it.
-- ════════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS inventory_aging_kpis(
  uuid, date, integer[], uuid, text, text, text, text, uuid, uuid, uuid,
  integer, integer, boolean);

CREATE OR REPLACE FUNCTION inventory_aging_kpis(
  p_entity_id     uuid,
  p_as_of         date        DEFAULT CURRENT_DATE,
  p_bucket_days   integer[]   DEFAULT ARRAY[30,60,90,180,365],
  p_category_id   uuid        DEFAULT NULL,
  p_gender        text        DEFAULT NULL,
  p_style_code    text        DEFAULT NULL,
  p_color         text        DEFAULT NULL,
  p_size          text        DEFAULT NULL,
  p_brand_id      uuid        DEFAULT NULL,
  p_vendor_id     uuid        DEFAULT NULL,
  p_location_id   uuid        DEFAULT NULL,
  p_min_age_days  integer     DEFAULT 0,
  p_dead_days     integer     DEFAULT 365,
  p_include_zero  boolean     DEFAULT false
)
RETURNS TABLE (
  total_qty          numeric,
  total_value_cents  numeric,
  wavg_age_days      numeric,
  oldest_age_days    integer,
  distinct_skus      integer,
  distinct_styles    integer,
  b1_qty numeric, b1_value_cents numeric,
  b2_qty numeric, b2_value_cents numeric,
  b3_qty numeric, b3_value_cents numeric,
  b4_qty numeric, b4_value_cents numeric,
  b5_qty numeric, b5_value_cents numeric,
  b6_qty numeric, b6_value_cents numeric,
  dead_qty numeric, dead_value_cents numeric,
  carry_annual_cents numeric
) AS $$
  WITH e AS (
    SELECT
      il.item_id, im.style_code,
      il.remaining_qty AS qty,
      il.unit_cost_cents,
      (p_as_of - il.received_at::date) AS age_days,
      CASE
        WHEN (p_as_of - il.received_at::date) <= p_bucket_days[1] THEN 1
        WHEN (p_as_of - il.received_at::date) <= p_bucket_days[2] THEN 2
        WHEN (p_as_of - il.received_at::date) <= p_bucket_days[3] THEN 3
        WHEN (p_as_of - il.received_at::date) <= p_bucket_days[4] THEN 4
        WHEN (p_as_of - il.received_at::date) <= p_bucket_days[5] THEN 5
        ELSE 6
      END AS bkt
    FROM inventory_layers il
    JOIN ip_item_master im ON im.id = il.item_id
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
      AND (COALESCE(p_min_age_days, 0) <= 0
           OR (p_as_of - il.received_at::date) >= p_min_age_days)
  )
  SELECT
    COALESCE(SUM(qty),0)                                                          AS total_qty,
    COALESCE(SUM(qty * unit_cost_cents),0)                                        AS total_value_cents,
    CASE WHEN SUM(qty) > 0 THEN SUM(qty * age_days) / SUM(qty) ELSE 0 END         AS wavg_age_days,
    COALESCE(MAX(age_days),0)::int                                               AS oldest_age_days,
    COUNT(DISTINCT item_id)::int                                                  AS distinct_skus,
    COUNT(DISTINCT style_code)::int                                              AS distinct_styles,
    COALESCE(SUM(qty) FILTER (WHERE bkt=1),0)                     AS b1_qty,
    COALESCE(SUM(qty*unit_cost_cents) FILTER (WHERE bkt=1),0)     AS b1_value_cents,
    COALESCE(SUM(qty) FILTER (WHERE bkt=2),0)                     AS b2_qty,
    COALESCE(SUM(qty*unit_cost_cents) FILTER (WHERE bkt=2),0)     AS b2_value_cents,
    COALESCE(SUM(qty) FILTER (WHERE bkt=3),0)                     AS b3_qty,
    COALESCE(SUM(qty*unit_cost_cents) FILTER (WHERE bkt=3),0)     AS b3_value_cents,
    COALESCE(SUM(qty) FILTER (WHERE bkt=4),0)                     AS b4_qty,
    COALESCE(SUM(qty*unit_cost_cents) FILTER (WHERE bkt=4),0)     AS b4_value_cents,
    COALESCE(SUM(qty) FILTER (WHERE bkt=5),0)                     AS b5_qty,
    COALESCE(SUM(qty*unit_cost_cents) FILTER (WHERE bkt=5),0)     AS b5_value_cents,
    COALESCE(SUM(qty) FILTER (WHERE bkt=6),0)                     AS b6_qty,
    COALESCE(SUM(qty*unit_cost_cents) FILTER (WHERE bkt=6),0)     AS b6_value_cents,
    COALESCE(SUM(qty) FILTER (WHERE age_days >= p_dead_days),0)                   AS dead_qty,
    COALESCE(SUM(qty*unit_cost_cents) FILTER (WHERE age_days >= p_dead_days),0)   AS dead_value_cents,
    COALESCE(SUM(qty * unit_cost_cents),0) * 0.09
      + COALESCE(SUM(qty),0) / 864.0 * 20.0 * 100.0 * 12.0                        AS carry_annual_cents
  FROM e;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION inventory_aging_kpis(uuid, date, integer[], uuid, text, text, text, text, uuid, uuid, uuid, integer, integer, boolean)
IS 'Headline inventory-aging KPIs as of p_as_of: total on-hand qty/$, weighted-avg + oldest age, per-bucket qty/$, dead stock (aged ≥ p_dead_days), annual carrying cost. Same filters as inventory_aging_report.';
