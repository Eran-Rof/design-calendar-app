-- Phase 1 extension: planner's intended buy quantity per forecast grain.
-- Separate from override_qty (which adjusts demand forecast) — this records
-- the procurement decision so it can flow to PO WIP in Phase 2.
ALTER TABLE ip_wholesale_forecast
  ADD COLUMN IF NOT EXISTS planned_buy_qty integer null;
