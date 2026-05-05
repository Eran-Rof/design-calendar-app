-- 20260513000000_phase3_planned_buys_supply.sql
--
-- Phase 3 enhancement: feed Phase 1 planned_buy_qty into the
-- reconciliation engine as opt-in supply.
--
-- Two columns added:
--   • ip_planning_runs.recon_include_planned_buys (bool, default false)
--       — toggled on the new-recon-run modal. When true, the
--         orchestrator buckets planned_buy_qty by (sku, period_start)
--         and adds it to total_available_supply_qty.
--   • ip_projected_inventory.inbound_planned_buy_qty (numeric, default 0)
--       — always populated for visibility (so the planner can see
--         what would change if they flipped the toggle), summed into
--         total only when the run flag is true. Same shape as the
--         existing supply component columns
--         (beginning_on_hand_qty / inbound_receipts_qty / inbound_po_qty / wip_qty)
--         so the audit drawer's supply-breakdown layout extends with
--         no special case.
--
-- Default values keep existing runs/rows behavior identical: the flag
-- is off by default; existing rows have 0 in the new column.

ALTER TABLE ip_planning_runs
  ADD COLUMN IF NOT EXISTS recon_include_planned_buys boolean NOT NULL DEFAULT false;

ALTER TABLE ip_projected_inventory
  ADD COLUMN IF NOT EXISTS inbound_planned_buy_qty numeric(14, 3) NOT NULL DEFAULT 0;

COMMENT ON COLUMN ip_planning_runs.recon_include_planned_buys IS
  'Phase 3: when true, runReconciliationPass adds planned_buy_qty (from the linked wholesale source run''s ip_wholesale_forecast) to total_available_supply_qty.';
COMMENT ON COLUMN ip_projected_inventory.inbound_planned_buy_qty IS
  'Phase 3: bucket-summed planned_buy_qty for (sku, period). Always populated; only counted toward total_available_supply_qty when ip_planning_runs.recon_include_planned_buys is true.';
