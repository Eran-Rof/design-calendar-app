-- Phase 2 ecom fixtures.
--
-- Designed to light up each branch of the ecom forecast stack once the
-- Phase 2 migration is applied and "Build ecom forecast" is clicked.
-- All rows are prefixed DEMO-ECOM- so cleanup is a simple DELETE.
--
-- After apply, the /planning/ecom workbench should show:
--   • DEMO-ECOM-ACTIVE        → dense history, landing `weighted_recent` or `trailing_13w`
--   • DEMO-ECOM-LAUNCH        → no history, launch_date today → rides the curve
--   • DEMO-ECOM-PROMO         → dense history + promo flagged via forecast row
--   • DEMO-ECOM-MARKDOWN      → markdown_flag on product_channel_status
--   • DEMO-ECOM-HI-RETURNS    → ~30% return rate → visibly deflated system forecast
--   • DEMO-ECOM-NEW-NOHISTORY → zero-floor path (no history, no launch)
-- Channel: "DEMO-SHOPIFY-US" ecom channel.

-- ── Channel ─────────────────────────────────────────────────────────────────
INSERT INTO ip_channel_master (channel_code, name, channel_type, storefront_key, currency, timezone)
VALUES ('DEMO-SHOPIFY-US', 'Demo Shopify — US', 'ecom', 'rof-us.myshopify.com', 'USD', 'America/Los_Angeles')
ON CONFLICT (channel_code) DO NOTHING;

-- ── Categories (reuse DEMO- wholesale ones if present) ─────────────────────
INSERT INTO ip_category_master (category_code, name, segment) VALUES
  ('DEMO-ECOM-TOPS', 'Demo Ecom — Tops', 'ecom'),
  ('DEMO-ECOM-BTMS', 'Demo Ecom — Bottoms', 'ecom')
ON CONFLICT (category_code) DO NOTHING;

-- ── Items ──────────────────────────────────────────────────────────────────
WITH cats AS (
  SELECT id, category_code FROM ip_category_master WHERE category_code LIKE 'DEMO-ECOM-%'
)
INSERT INTO ip_item_master (sku_code, style_code, description, category_id, uom, unit_price, lead_time_days)
SELECT v.sku, v.style, v.descr, c.id, 'each', v.price, 30
FROM (VALUES
  ('DEMO-ECOM-ACTIVE',        'DEMO-ECOM-TEE',    'Demo Ecom — Active',         'DEMO-ECOM-TOPS', 24.99),
  ('DEMO-ECOM-LAUNCH',        'DEMO-ECOM-LAUNCH', 'Demo Ecom — Launch',         'DEMO-ECOM-TOPS', 49.99),
  ('DEMO-ECOM-PROMO',         'DEMO-ECOM-TEE',    'Demo Ecom — Promo Hero',     'DEMO-ECOM-TOPS', 29.99),
  ('DEMO-ECOM-MARKDOWN',      'DEMO-ECOM-OLD',    'Demo Ecom — Markdown',       'DEMO-ECOM-BTMS', 14.99),
  ('DEMO-ECOM-HI-RETURNS',    'DEMO-ECOM-FIT',    'Demo Ecom — High Returns',   'DEMO-ECOM-BTMS', 59.99),
  ('DEMO-ECOM-NEW-NOHISTORY', 'DEMO-ECOM-NEW',    'Demo Ecom — No History',     'DEMO-ECOM-TOPS', 34.99)
) AS v(sku, style, descr, cat, price)
JOIN cats c ON c.category_code = v.cat
ON CONFLICT (sku_code) DO NOTHING;

-- ── Product × channel status ───────────────────────────────────────────────
-- LAUNCH row: launch_date = today so the curve fires for the first week
-- of any horizon that starts today or later.
-- MARKDOWN row: markdown_flag=true.
-- Others: is_active=true, no launch, no markdown.
WITH ch AS (SELECT id FROM ip_channel_master WHERE channel_code = 'DEMO-SHOPIFY-US')
INSERT INTO ip_product_channel_status
  (sku_id, channel_id, status, listed, is_active, launch_date, markdown_flag, source, observed_at)
SELECT i.id, ch.id, 'active', true, true,
       CASE WHEN i.sku_code = 'DEMO-ECOM-LAUNCH' THEN CURRENT_DATE ELSE NULL END,
       i.sku_code = 'DEMO-ECOM-MARKDOWN',
       'demo', now()
FROM ip_item_master i, ch
WHERE i.sku_code LIKE 'DEMO-ECOM-%'
ON CONFLICT (sku_id, channel_id) DO UPDATE
  SET launch_date = EXCLUDED.launch_date,
      markdown_flag = EXCLUDED.markdown_flag,
      is_active = EXCLUDED.is_active;

-- ── Ecom sales history ─────────────────────────────────────────────────────
-- 26 weeks of history ending last Sunday. Patterns:
--   ACTIVE / PROMO / MARKDOWN: ~40 units/wk, 2% returns
--   HI-RETURNS:                ~50 units/wk, ~30% returns
--   LAUNCH / NEW-NOHISTORY:    no rows at all
WITH
  ch AS (SELECT id FROM ip_channel_master WHERE channel_code = 'DEMO-SHOPIFY-US'),
  weeks AS (
    SELECT generate_series(0, 25)::int AS n
  ),
  base_dates AS (
    SELECT (date_trunc('week', CURRENT_DATE)::date - interval '1 day' - (n * interval '7 day'))::date AS order_date, n
    FROM weeks
  ),
  items AS (
    SELECT id, sku_code, (SELECT id FROM ip_category_master c WHERE c.category_code = (CASE WHEN i.sku_code IN ('DEMO-ECOM-MARKDOWN','DEMO-ECOM-HI-RETURNS') THEN 'DEMO-ECOM-BTMS' ELSE 'DEMO-ECOM-TOPS' END)) AS cat_id
    FROM ip_item_master i
    WHERE i.sku_code IN ('DEMO-ECOM-ACTIVE','DEMO-ECOM-PROMO','DEMO-ECOM-MARKDOWN','DEMO-ECOM-HI-RETURNS')
  )
INSERT INTO ip_sales_history_ecom
  (sku_id, channel_id, category_id, order_number, order_date, qty, returned_qty, net_qty, gross_amount, discount_amount, refund_amount, net_amount, currency, source, source_line_key)
SELECT
  items.id,
  ch.id,
  items.cat_id,
  'DEMO-ECOM-ORD-' || items.sku_code || '-' || to_char(base_dates.order_date, 'YYYYMMDD'),
  base_dates.order_date,
  CASE
    WHEN items.sku_code = 'DEMO-ECOM-HI-RETURNS' THEN 50 + (base_dates.n % 5)
    ELSE 40 + (base_dates.n % 4)
  END AS qty,
  CASE
    WHEN items.sku_code = 'DEMO-ECOM-HI-RETURNS' THEN (50 + (base_dates.n % 5)) * 0.30
    ELSE ((40 + (base_dates.n % 4)) * 0.02)::numeric
  END AS returned_qty,
  -- net_qty = qty - returned_qty; keep it consistent
  (CASE
    WHEN items.sku_code = 'DEMO-ECOM-HI-RETURNS' THEN (50 + (base_dates.n % 5)) - (50 + (base_dates.n % 5)) * 0.30
    ELSE ((40 + (base_dates.n % 4)) - ((40 + (base_dates.n % 4)) * 0.02))
  END)::numeric,
  (CASE
    WHEN items.sku_code = 'DEMO-ECOM-HI-RETURNS' THEN (50 + (base_dates.n % 5)) * 59.99
    ELSE (40 + (base_dates.n % 4)) * 24.99
  END)::numeric,
  0, 0,
  (CASE
    WHEN items.sku_code = 'DEMO-ECOM-HI-RETURNS' THEN (50 + (base_dates.n % 5)) * 59.99 * 0.70
    ELSE (40 + (base_dates.n % 4)) * 24.99
  END)::numeric,
  'USD', 'demo',
  'demo:ecom:' || items.sku_code || ':' || to_char(base_dates.order_date, 'YYYY-MM-DD')
FROM items, ch, base_dates
ON CONFLICT (source, source_line_key) DO NOTHING;

-- ── Draft ecom planning run ready for "Build ecom forecast" ────────────────
INSERT INTO ip_planning_runs (name, planning_scope, status, source_snapshot_date, horizon_start, horizon_end, note)
SELECT
  'Demo Ecom — ' || to_char(CURRENT_DATE, 'YYYY-MM'),
  'ecom', 'draft', CURRENT_DATE,
  date_trunc('week', CURRENT_DATE + interval '7 day')::date,
  (date_trunc('week', CURRENT_DATE + interval '56 day'))::date,
  'Phase 2 demo run — built from inventory_planning_phase2_fixtures.sql'
WHERE NOT EXISTS (
  SELECT 1 FROM ip_planning_runs WHERE planning_scope = 'ecom' AND name = 'Demo Ecom — ' || to_char(CURRENT_DATE, 'YYYY-MM')
);
