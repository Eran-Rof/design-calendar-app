-- cleanup_demo_data.sql
--
-- Removes the DEMO seed data from inventory_planning_phase1/2/3 fixtures.
-- All seed rows use a DEMO- prefix on sku_code and customer_code, so we
-- can match them precisely and leave anything ingested from Xoro intact.
--
-- Order matters — delete every dependent that FKs item/customer master
-- (whether ON DELETE RESTRICT or NO ACTION) before dropping the masters.

BEGIN;

-- Capture the IDs we're about to wipe so every dependent delete can
-- reuse the same set without re-querying the master table.
CREATE TEMP TABLE _demo_sku_ids AS
  SELECT id FROM ip_item_master WHERE sku_code LIKE 'DEMO-%';
CREATE TEMP TABLE _demo_customer_ids AS
  SELECT id FROM ip_customer_master WHERE customer_code LIKE 'DEMO-%';

-- 1. Forecast/recommendation/projection layer.
DELETE FROM ip_wholesale_recommendations WHERE sku_id IN (SELECT id FROM _demo_sku_ids) OR customer_id IN (SELECT id FROM _demo_customer_ids);
DELETE FROM ip_wholesale_forecast        WHERE sku_id IN (SELECT id FROM _demo_sku_ids) OR customer_id IN (SELECT id FROM _demo_customer_ids);
DELETE FROM ip_inventory_recommendations WHERE sku_id IN (SELECT id FROM _demo_sku_ids);
DELETE FROM ip_projected_inventory       WHERE sku_id IN (SELECT id FROM _demo_sku_ids);
DELETE FROM ip_forecast_accuracy         WHERE sku_id IN (SELECT id FROM _demo_sku_ids) OR customer_id IN (SELECT id FROM _demo_customer_ids);
DELETE FROM ip_forecast_actuals          WHERE sku_id IN (SELECT id FROM _demo_sku_ids) OR customer_id IN (SELECT id FROM _demo_customer_ids);
DELETE FROM ip_override_effectiveness    WHERE sku_id IN (SELECT id FROM _demo_sku_ids) OR customer_id IN (SELECT id FROM _demo_customer_ids);

-- 2. Planner-side history.
DELETE FROM ip_planner_overrides         WHERE sku_id IN (SELECT id FROM _demo_sku_ids) OR customer_id IN (SELECT id FROM _demo_customer_ids);
DELETE FROM ip_future_demand_requests    WHERE sku_id IN (SELECT id FROM _demo_sku_ids) OR customer_id IN (SELECT id FROM _demo_customer_ids);
DELETE FROM ip_ecom_forecast             WHERE sku_id IN (SELECT id FROM _demo_sku_ids);
DELETE FROM ip_ecom_override_events      WHERE sku_id IN (SELECT id FROM _demo_sku_ids);
DELETE FROM ip_scenario_assumptions      WHERE sku_id IN (SELECT id FROM _demo_sku_ids);

-- 3. Fact rows.
DELETE FROM ip_sales_history_wholesale   WHERE sku_id IN (SELECT id FROM _demo_sku_ids) OR customer_id IN (SELECT id FROM _demo_customer_ids);
DELETE FROM ip_sales_history_ecom        WHERE sku_id IN (SELECT id FROM _demo_sku_ids) OR customer_id IN (SELECT id FROM _demo_customer_ids);
DELETE FROM ip_inventory_snapshot        WHERE sku_id IN (SELECT id FROM _demo_sku_ids);
DELETE FROM ip_open_purchase_orders      WHERE sku_id IN (SELECT id FROM _demo_sku_ids);
DELETE FROM ip_receipts_history          WHERE sku_id IN (SELECT id FROM _demo_sku_ids);

-- 4. Misc dependents.
DELETE FROM ip_allocation_rules          WHERE sku_id IN (SELECT id FROM _demo_sku_ids);
DELETE FROM ip_ai_suggestions            WHERE sku_id IN (SELECT id FROM _demo_sku_ids) OR customer_id IN (SELECT id FROM _demo_customer_ids);
DELETE FROM ip_planning_anomalies        WHERE sku_id IN (SELECT id FROM _demo_sku_ids);
DELETE FROM ip_product_channel_status    WHERE sku_id IN (SELECT id FROM _demo_sku_ids);
DELETE FROM ip_supply_exceptions         WHERE sku_id IN (SELECT id FROM _demo_sku_ids);
DELETE FROM ip_vendor_timing_signals     WHERE sku_id IN (SELECT id FROM _demo_sku_ids);
DELETE FROM ip_execution_actions         WHERE sku_id IN (SELECT id FROM _demo_sku_ids);
DELETE FROM ip_item_avg_cost             WHERE sku_code LIKE 'DEMO-%';

-- 5. Masters.
DELETE FROM ip_item_master      WHERE sku_code      LIKE 'DEMO-%';
DELETE FROM ip_customer_master  WHERE customer_code LIKE 'DEMO-%';

DROP TABLE _demo_sku_ids;
DROP TABLE _demo_customer_ids;

COMMIT;

-- Sanity check (run separately afterwards):
--   SELECT count(*) FROM ip_item_master      WHERE sku_code      LIKE 'DEMO-%'; -- expect 0
--   SELECT count(*) FROM ip_customer_master  WHERE customer_code LIKE 'DEMO-%'; -- expect 0
