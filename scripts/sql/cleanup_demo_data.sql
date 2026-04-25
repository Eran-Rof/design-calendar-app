-- cleanup_demo_data.sql
--
-- Removes the DEMO seed data from inventory_planning_phase1/2/3 fixtures.
-- All seed rows use a DEMO- prefix on sku_code and customer_code, so we
-- can match them precisely and leave anything ingested from Xoro intact.
--
-- Order matters — delete dependents first, then the masters they reference.

BEGIN;

-- 1. Forecast & recommendation rows for DEMO SKUs/customers.
DELETE FROM ip_wholesale_recommendations
 WHERE sku_id IN (SELECT id FROM ip_item_master WHERE sku_code LIKE 'DEMO-%')
    OR customer_id IN (SELECT id FROM ip_customer_master WHERE customer_code LIKE 'DEMO-%');

DELETE FROM ip_wholesale_forecast
 WHERE sku_id IN (SELECT id FROM ip_item_master WHERE sku_code LIKE 'DEMO-%')
    OR customer_id IN (SELECT id FROM ip_customer_master WHERE customer_code LIKE 'DEMO-%');

-- 2. Planner-side history tables.
DELETE FROM ip_planner_overrides
 WHERE sku_id IN (SELECT id FROM ip_item_master WHERE sku_code LIKE 'DEMO-%')
    OR customer_id IN (SELECT id FROM ip_customer_master WHERE customer_code LIKE 'DEMO-%');

DELETE FROM ip_future_demand_requests
 WHERE sku_id IN (SELECT id FROM ip_item_master WHERE sku_code LIKE 'DEMO-%')
    OR customer_id IN (SELECT id FROM ip_customer_master WHERE customer_code LIKE 'DEMO-%');

-- 3. Fact rows that reference DEMO masters.
DELETE FROM ip_sales_history_wholesale
 WHERE sku_id IN (SELECT id FROM ip_item_master WHERE sku_code LIKE 'DEMO-%')
    OR customer_id IN (SELECT id FROM ip_customer_master WHERE customer_code LIKE 'DEMO-%');

DELETE FROM ip_inventory_snapshot
 WHERE sku_id IN (SELECT id FROM ip_item_master WHERE sku_code LIKE 'DEMO-%');

DELETE FROM ip_open_purchase_orders
 WHERE sku_id IN (SELECT id FROM ip_item_master WHERE sku_code LIKE 'DEMO-%');

DELETE FROM ip_receipts_history
 WHERE sku_id IN (SELECT id FROM ip_item_master WHERE sku_code LIKE 'DEMO-%');

-- 4. Avg cost lookup (sku_code is the PK, no FK lookup needed).
DELETE FROM ip_item_avg_cost
 WHERE sku_code LIKE 'DEMO-%';

-- 5. Master rows.
DELETE FROM ip_item_master      WHERE sku_code      LIKE 'DEMO-%';
DELETE FROM ip_customer_master  WHERE customer_code LIKE 'DEMO-%';

COMMIT;

-- Sanity check (run separately afterwards):
--   SELECT count(*) FROM ip_item_master      WHERE sku_code      LIKE 'DEMO-%'; -- expect 0
--   SELECT count(*) FROM ip_customer_master  WHERE customer_code LIKE 'DEMO-%'; -- expect 0
