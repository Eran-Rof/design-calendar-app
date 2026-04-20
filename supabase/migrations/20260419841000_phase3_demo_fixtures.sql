-- Phase 3 fixtures — exercise the supply reconciliation engine.
--
-- Adds:
--   • Two allocation rules (one strategic_customer reserve, one protect_ecom)
--   • Vendor timing signals for the DEMO-ECOM SKUs
--   • A draft reconciliation run ('all' scope) that references the
--     existing Demo wholesale run and Demo Ecom run. If either source
--     run doesn't exist yet this seed will simply not link that side;
--     the reconciliation pass tolerates it.
--
-- Prefixed DEMO-RECON- so cleanup is:
--   DELETE FROM ip_allocation_rules       WHERE rule_name LIKE 'DEMO-RECON-%';
--   DELETE FROM ip_supply_exceptions      WHERE planning_run_id IN (SELECT id FROM ip_planning_runs WHERE name LIKE 'Demo Recon%');
--   DELETE FROM ip_inventory_recommendations WHERE planning_run_id IN (...);
--   DELETE FROM ip_projected_inventory    WHERE planning_run_id IN (...);
--   DELETE FROM ip_planning_runs          WHERE name LIKE 'Demo Recon%';
--   DELETE FROM ip_vendor_timing_signals  WHERE notes = 'DEMO-RECON seed';

-- ── Allocation rules ────────────────────────────────────────────────────────
-- A strategic_customer reserve of 40 units/period for DEMO-MAJOR on all DEMO- items.
WITH major AS (SELECT id FROM ip_customer_master WHERE customer_code = 'DEMO-MAJOR')
INSERT INTO ip_allocation_rules
  (rule_name, rule_type, priority_rank, applies_to_customer_id,
   reserve_qty, note, active)
SELECT 'DEMO-RECON-strategic-MAJOR', 'strategic_customer', 10, major.id,
       40, 'DEMO seed — strategic reserve for MAJOR dept store', true
FROM major
WHERE NOT EXISTS (SELECT 1 FROM ip_allocation_rules WHERE rule_name = 'DEMO-RECON-strategic-MAJOR');

-- A protect_ecom rule adding +10 units of ecom protection for the ACTIVE SKU.
WITH active AS (SELECT id FROM ip_item_master WHERE sku_code = 'DEMO-ECOM-ACTIVE')
INSERT INTO ip_allocation_rules
  (rule_name, rule_type, priority_rank, applies_to_sku_id,
   reserve_qty, note, active)
SELECT 'DEMO-RECON-protect-ACTIVE', 'protect_ecom', 20, active.id,
       10, 'DEMO seed — belt-and-suspenders protection on our hero ecom SKU', true
FROM active
WHERE NOT EXISTS (SELECT 1 FROM ip_allocation_rules WHERE rule_name = 'DEMO-RECON-protect-ACTIVE');

-- ── Vendor timing signals (used by the late_po exception heuristic) ────────
INSERT INTO ip_vendor_timing_signals (sku_id, vendor_id, avg_lead_time_days, receipt_variability_days, delay_risk_score, notes)
SELECT i.id, NULL, 60, 15, 0.35, 'DEMO-RECON seed'
FROM ip_item_master i
WHERE i.sku_code LIKE 'DEMO-ECOM-%'
ON CONFLICT (sku_id, COALESCE(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO NOTHING;

-- ── Reconciliation planning run ────────────────────────────────────────────
-- Links the most-recent Demo wholesale + Demo Ecom runs (by created_at).
-- The reconciliation service tolerates either being NULL (e.g. before
-- wholesale fixtures are loaded).
WITH
  ws AS (SELECT id FROM ip_planning_runs WHERE planning_scope = 'wholesale' AND name LIKE 'Demo%' ORDER BY created_at DESC LIMIT 1),
  es AS (SELECT id FROM ip_planning_runs WHERE planning_scope = 'ecom'      AND name LIKE 'Demo Ecom%' ORDER BY created_at DESC LIMIT 1)
INSERT INTO ip_planning_runs
  (name, planning_scope, status, source_snapshot_date, horizon_start, horizon_end,
   wholesale_source_run_id, ecom_source_run_id, note)
SELECT
  'Demo Recon — ' || to_char(CURRENT_DATE, 'YYYY-MM'),
  'all', 'draft', CURRENT_DATE,
  date_trunc('month', CURRENT_DATE + interval '1 month')::date,
  (date_trunc('month', CURRENT_DATE + interval '4 month') - interval '1 day')::date,
  (SELECT id FROM ws),
  (SELECT id FROM es),
  'Phase 3 demo reconciliation run — links DEMO wholesale + ecom source runs'
WHERE NOT EXISTS (
  SELECT 1 FROM ip_planning_runs WHERE planning_scope = 'all' AND name = 'Demo Recon — ' || to_char(CURRENT_DATE, 'YYYY-MM')
);
