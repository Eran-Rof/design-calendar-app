-- M31 / P17 direction B — let a planning run CHOOSE its supply data source.
--
-- The supply reconciliation reads on-hand from `ip_inventory_snapshot` and
-- open POs from `ip_open_purchase_orders`. Both already carry a `source`
-- column. This adds a per-run preference so the planner can reconcile against
-- either the legacy Xoro/ATS mirror (default, unchanged) OR native Tangerine
-- ERP supply (on-hand from inventory_layers, open POs from purchase_orders),
-- which the sync writes tagged `source='tangerine'`.
--
-- The reader filters by source from this preference, so the two sources never
-- sum together (the pre-existing reader summed ALL sources — that would
-- double-count once Tangerine rows land). Existing runs default to 'xoro' ⇒
-- byte-identical behavior.

ALTER TABLE ip_planning_runs
  ADD COLUMN IF NOT EXISTS supply_source text NOT NULL DEFAULT 'xoro';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ip_planning_runs_supply_source_check') THEN
    ALTER TABLE ip_planning_runs
      ADD CONSTRAINT ip_planning_runs_supply_source_check CHECK (supply_source IN ('xoro', 'tangerine'));
  END IF;
END $$;

-- Allow source='tangerine' in the on-hand snapshot table (was xoro/shopify/manual).
ALTER TABLE ip_inventory_snapshot DROP CONSTRAINT IF EXISTS ip_inventory_snapshot_source_check;
ALTER TABLE ip_inventory_snapshot
  ADD CONSTRAINT ip_inventory_snapshot_source_check CHECK (source IN ('xoro', 'shopify', 'manual', 'tangerine'));

-- ip_open_purchase_orders.source is free text (default 'xoro', no CHECK) — no change needed.
