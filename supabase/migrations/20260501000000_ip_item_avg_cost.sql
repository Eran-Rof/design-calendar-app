-- 20260501000000_ip_item_avg_cost.sql
--
-- All-SKU avg unit cost lookup for the planning module.
--
-- ATS only carries avgCost for SKUs currently in inventory; the planning
-- grid needs avg cost for every SKU we forecast (including SKUs we have
-- not yet received). This table is the canonical source, fed by either:
--   - Xoro API ingest (preferred, scheduled or on-demand)
--   - Excel upload from the planning admin UI
--
-- Keyed by sku_code (matches ip_item_master.sku_code). One row per SKU;
-- writes upsert on conflict.

CREATE TABLE IF NOT EXISTS ip_item_avg_cost (
  sku_code     text PRIMARY KEY,
  avg_cost     numeric NOT NULL CHECK (avg_cost >= 0),
  source       text NOT NULL DEFAULT 'manual'
                 CHECK (source IN ('xoro', 'excel', 'manual')),
  source_ref   text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ip_item_avg_cost_updated_at_idx
  ON ip_item_avg_cost (updated_at DESC);
