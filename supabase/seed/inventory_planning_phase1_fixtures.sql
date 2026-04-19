-- Phase 1 fixture data for the wholesale planning workbench.
--
-- Safe to run multiple times — all inserts guard on a stable text code.
-- Customers, categories, items here do NOT collide with production data
-- because the codes are prefixed with 'DEMO-'.
--
-- What you get after running:
--   • 3 demo customers, 2 categories, 5 items
--   • ~14 months of wholesale sales history spanning dense / sparse /
--     no-history patterns
--   • an open-PO row and a latest inventory snapshot per item
--   • 2 open future demand requests
--   • a 'draft' planning run named "Demo — YYYY-MM" with a 3-month
--     horizon ready for "Build forecast"
--
-- To clean up: DELETE FROM ip_* WHERE customer_code LIKE 'DEMO-%' ...
-- (or simpler: work against a non-prod Supabase project).

-- ── Masters ─────────────────────────────────────────────────────────────────
INSERT INTO ip_category_master (category_code, name, segment) VALUES
  ('DEMO-TOPS', 'Demo — Tops', 'wholesale'),
  ('DEMO-BTMS', 'Demo — Bottoms', 'wholesale')
ON CONFLICT (category_code) DO NOTHING;

INSERT INTO ip_customer_master (customer_code, name, customer_tier) VALUES
  ('DEMO-MAJOR',   'Demo Major Dept Store', 'major'),
  ('DEMO-BOUTIQUE','Demo Boutique Chain',   'boutique'),
  ('DEMO-SPECIAL', 'Demo Specialty Retailer','specialty')
ON CONFLICT (customer_code) DO NOTHING;

-- Items: sku_code uses DEMO- prefix so they're easy to spot and remove.
WITH cats AS (
  SELECT id, category_code FROM ip_category_master WHERE category_code LIKE 'DEMO-%'
)
INSERT INTO ip_item_master (sku_code, style_code, description, category_id, uom, unit_price, lead_time_days)
SELECT v.sku_code, v.style_code, v.description, c.id, 'each', v.price, 45
FROM (VALUES
  ('DEMO-TEE-BLK-M',  'DEMO-TEE',  'Demo Tee — Black M',   'DEMO-TOPS',  19.99),
  ('DEMO-TEE-BLK-L',  'DEMO-TEE',  'Demo Tee — Black L',   'DEMO-TOPS',  19.99),
  ('DEMO-HOOD-BLK-M', 'DEMO-HOOD', 'Demo Hoodie — Black M','DEMO-TOPS',  49.99),
  ('DEMO-JEAN-28',    'DEMO-JEAN', 'Demo Jean — 28',       'DEMO-BTMS',  59.99),
  ('DEMO-JEAN-30',    'DEMO-JEAN', 'Demo Jean — 30',       'DEMO-BTMS',  59.99)
) AS v(sku_code, style_code, description, cat_code, price)
JOIN cats c ON c.category_code = v.cat_code
ON CONFLICT (sku_code) DO NOTHING;

-- ── Sales history (wholesale) ───────────────────────────────────────────────
-- Pattern 1: DEMO-TEE-BLK-M sold to MAJOR every month for 12 months (dense).
-- Pattern 2: DEMO-HOOD-BLK-M sold sparsely every ~3 months (cadence).
-- Pattern 3: DEMO-JEAN-28 sold only to BOUTIQUE in the last 2 months (recent ramp).
-- Pattern 4: DEMO-JEAN-30 has NO history — should fall to category/customer fallback.
-- Pattern 5: DEMO-TEE-BLK-L has ecom-only history (not in ip_sales_history_wholesale).

-- Helper: generate_series for month starts from 2025-05 to 2026-04.
WITH months AS (
  SELECT gs::date AS month_start
  FROM generate_series('2025-05-01'::date, '2026-04-01'::date, interval '1 month') gs
),
major AS (SELECT id FROM ip_customer_master WHERE customer_code = 'DEMO-MAJOR'),
boutique AS (SELECT id FROM ip_customer_master WHERE customer_code = 'DEMO-BOUTIQUE'),
tee_m AS (SELECT id FROM ip_item_master WHERE sku_code = 'DEMO-TEE-BLK-M'),
hood_m AS (SELECT id FROM ip_item_master WHERE sku_code = 'DEMO-HOOD-BLK-M'),
jean28 AS (SELECT id FROM ip_item_master WHERE sku_code = 'DEMO-JEAN-28'),
cat_tops AS (SELECT id FROM ip_category_master WHERE category_code = 'DEMO-TOPS'),
cat_btms AS (SELECT id FROM ip_category_master WHERE category_code = 'DEMO-BTMS')
INSERT INTO ip_sales_history_wholesale
  (sku_id, customer_id, category_id, order_number, invoice_number, txn_type, txn_date, qty, unit_price, net_amount, currency, source, source_line_key)
-- Pattern 1: MAJOR × TEE_M every month, 100 units (slight month-to-month ramp)
SELECT tee_m.id, major.id, cat_tops.id,
       'DEMO-SO-TEE-' || to_char(months.month_start, 'YYYYMM'),
       'DEMO-INV-TEE-' || to_char(months.month_start, 'YYYYMM'),
       'invoice', months.month_start + 14, 100 + EXTRACT(MONTH FROM months.month_start)::int * 2,
       19.99,
       (100 + EXTRACT(MONTH FROM months.month_start)::int * 2) * 19.99,
       'USD', 'demo',
       'demo:tee:major:' || to_char(months.month_start, 'YYYY-MM')
FROM months, major, tee_m, cat_tops
UNION ALL
-- Pattern 2: MAJOR × HOOD_M in 2025-07, 2025-10, 2026-01, 2026-04 (cadence)
SELECT hood_m.id, major.id, cat_tops.id,
       'DEMO-SO-HOOD-' || to_char(d::date, 'YYYYMM'),
       'DEMO-INV-HOOD-' || to_char(d::date, 'YYYYMM'),
       'invoice', d::date + 10, 60,
       49.99, 60 * 49.99, 'USD', 'demo',
       'demo:hood:major:' || to_char(d::date, 'YYYY-MM')
FROM (VALUES ('2025-07-01'), ('2025-10-01'), ('2026-01-01'), ('2026-04-01')) AS t(d),
     major, hood_m, cat_tops
UNION ALL
-- Pattern 3: BOUTIQUE × JEAN-28 only in 2026-03 and 2026-04 (recent ramp)
SELECT jean28.id, boutique.id, cat_btms.id,
       'DEMO-SO-JEAN-' || to_char(d::date, 'YYYYMM'),
       'DEMO-INV-JEAN-' || to_char(d::date, 'YYYYMM'),
       'invoice', d::date + 5, 200,
       59.99, 200 * 59.99, 'USD', 'demo',
       'demo:jean28:boutique:' || to_char(d::date, 'YYYY-MM')
FROM (VALUES ('2026-03-01'), ('2026-04-01')) AS t(d),
     boutique, jean28, cat_btms
ON CONFLICT (source, source_line_key) DO NOTHING;

-- ── Inventory snapshot (one row per item as of today) ───────────────────────
INSERT INTO ip_inventory_snapshot (sku_id, warehouse_code, snapshot_date, qty_on_hand, qty_available, source)
SELECT i.id, 'DEMO-WH', CURRENT_DATE, v.qty, v.qty, 'manual'
FROM (VALUES
  ('DEMO-TEE-BLK-M',  80),
  ('DEMO-TEE-BLK-L',  50),
  ('DEMO-HOOD-BLK-M', 20),
  ('DEMO-JEAN-28',    5),
  ('DEMO-JEAN-30',    0)
) AS v(sku_code, qty)
JOIN ip_item_master i ON i.sku_code = v.sku_code
ON CONFLICT (sku_id, warehouse_code, snapshot_date, source) DO NOTHING;

-- ── One open PO landing inside the default horizon ──────────────────────────
INSERT INTO ip_open_purchase_orders
  (sku_id, po_number, po_line_number, order_date, expected_date, qty_ordered, qty_received, qty_open, unit_cost, currency, status, source, source_line_key)
SELECT i.id, v.po_number, v.line, '2026-03-01', v.expected, v.qty, 0, v.qty, v.cost, 'USD', 'Open', 'demo', v.key
FROM (VALUES
  ('DEMO-TEE-BLK-M',  'DEMO-PO-101', '1', DATE '2026-05-20', 300, 7.50, 'demo:po:DEMO-PO-101:1'),
  ('DEMO-HOOD-BLK-M', 'DEMO-PO-102', '1', DATE '2026-06-10', 120, 18.00, 'demo:po:DEMO-PO-102:1'),
  ('DEMO-JEAN-28',    'DEMO-PO-103', '1', DATE '2026-07-15', 200, 22.00, 'demo:po:DEMO-PO-103:1')
) AS v(sku_code, po_number, line, expected, qty, cost, key)
JOIN ip_item_master i ON i.sku_code = v.sku_code
ON CONFLICT (source, source_line_key) DO NOTHING;

-- ── Two open future demand requests ─────────────────────────────────────────
WITH major AS (SELECT id FROM ip_customer_master WHERE customer_code = 'DEMO-MAJOR'),
     special AS (SELECT id FROM ip_customer_master WHERE customer_code = 'DEMO-SPECIAL'),
     hood AS (SELECT id FROM ip_item_master WHERE sku_code = 'DEMO-HOOD-BLK-M'),
     jean30 AS (SELECT id FROM ip_item_master WHERE sku_code = 'DEMO-JEAN-30'),
     cat_tops AS (SELECT id FROM ip_category_master WHERE category_code = 'DEMO-TOPS'),
     cat_btms AS (SELECT id FROM ip_category_master WHERE category_code = 'DEMO-BTMS')
INSERT INTO ip_future_demand_requests
  (customer_id, category_id, sku_id, target_period_start, target_period_end, requested_qty, confidence_level, request_type, note)
SELECT major.id, cat_tops.id, hood.id, DATE '2026-06-01', DATE '2026-06-30', 80, 'committed', 'buyer_request',
       'Demo — confirmed reorder for Q2 refresh'
FROM major, hood, cat_tops
UNION ALL
SELECT special.id, cat_btms.id, jean30.id, DATE '2026-07-01', DATE '2026-07-31', 150, 'probable', 'customer_expansion',
       'Demo — SKU_30 launch window, no history yet'
FROM special, jean30, cat_btms
ON CONFLICT DO NOTHING;

-- ── A draft wholesale planning run ready for "Build forecast" ───────────────
INSERT INTO ip_planning_runs (name, planning_scope, status, source_snapshot_date, horizon_start, horizon_end, note)
SELECT
  'Demo — ' || to_char(CURRENT_DATE, 'YYYY-MM'),
  'wholesale', 'draft', CURRENT_DATE,
  date_trunc('month', CURRENT_DATE + interval '1 month')::date,
  (date_trunc('month', CURRENT_DATE + interval '4 month') - interval '1 day')::date,
  'Phase 1 demo run — built from inventory_planning_phase1_fixtures.sql'
WHERE NOT EXISTS (
  SELECT 1 FROM ip_planning_runs WHERE name = 'Demo — ' || to_char(CURRENT_DATE, 'YYYY-MM')
);
