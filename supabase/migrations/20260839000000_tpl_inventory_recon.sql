-- 20260839000000_tpl_inventory_recon.sql
-- 3PL nightly inventory reconciliation: ingest a provider's on-hand snapshot
-- (EDI 846 Inventory Advice, or CSV/JSON), then compute the difference vs
-- Tangerine's authoritative on-hand (inventory_layers) so the operator gets a
-- daily 3PL-vs-Tangerine differences report.
--
--   tpl_inventory_snapshots       — one row per ingested file (per provider/date)
--   tpl_inventory_snapshot_lines  — the 3PL's reported on-hand per SKU
--   tpl_inventory_differences     — computed variance per SKU at recon time
--
-- Differences store BOTH Tangerine bases (on-hand at the provider's location and
-- total across all locations) because, until 945 receiving relocates FIFO layers
-- to the 3PL location, the location bucket may be empty — the panel lets the
-- operator compare against either.

CREATE TABLE IF NOT EXISTS tpl_inventory_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id),
  tpl_provider_id    uuid NOT NULL REFERENCES tpl_providers(id) ON DELETE CASCADE,
  snapshot_date      date NOT NULL DEFAULT current_date,
  source             text NOT NULL DEFAULT 'manual' CHECK (source IN ('edi846','csv','json','manual')),
  line_count         int  NOT NULL DEFAULT 0,
  matched_count      int  NOT NULL DEFAULT 0,   -- lines whose sku_code resolved to an item
  raw_content        text,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid
);
CREATE INDEX IF NOT EXISTS idx_tpl_inv_snap_provider_date
  ON tpl_inventory_snapshots (tpl_provider_id, snapshot_date DESC);

CREATE TABLE IF NOT EXISTS tpl_inventory_snapshot_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id  uuid NOT NULL REFERENCES tpl_inventory_snapshots(id) ON DELETE CASCADE,
  sku_code     text NOT NULL,
  item_id      uuid REFERENCES ip_item_master(id),
  qty_on_hand  numeric(18,4) NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tpl_inv_snap_lines_snapshot
  ON tpl_inventory_snapshot_lines (snapshot_id);

CREATE TABLE IF NOT EXISTS tpl_inventory_differences (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id              uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id),
  snapshot_id            uuid NOT NULL REFERENCES tpl_inventory_snapshots(id) ON DELETE CASCADE,
  tpl_provider_id        uuid NOT NULL REFERENCES tpl_providers(id) ON DELETE CASCADE,
  snapshot_date          date NOT NULL,
  sku_code               text NOT NULL,
  item_id                uuid REFERENCES ip_item_master(id),
  qty_3pl                numeric(18,4) NOT NULL DEFAULT 0,  -- 3PL-reported on-hand
  qty_tangerine_location numeric(18,4) NOT NULL DEFAULT 0,  -- on-hand at the provider's location
  qty_tangerine_total    numeric(18,4) NOT NULL DEFAULT 0,  -- on-hand across all locations
  direction              text NOT NULL DEFAULT 'both' CHECK (direction IN ('both','only_3pl','only_tangerine')),
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tpl_inv_diff_snapshot
  ON tpl_inventory_differences (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_tpl_inv_diff_provider_date
  ON tpl_inventory_differences (tpl_provider_id, snapshot_date DESC);

-- RLS: enable + permissive (writes are service-role via the handler; reads come
-- through the handler too). Mirrors the deferred-SaaS posture of the other tpl tables.
ALTER TABLE tpl_inventory_snapshots      ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpl_inventory_snapshot_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpl_inventory_differences    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tpl_inv_snap_all  ON tpl_inventory_snapshots;
DROP POLICY IF EXISTS tpl_inv_lines_all ON tpl_inventory_snapshot_lines;
DROP POLICY IF EXISTS tpl_inv_diff_all  ON tpl_inventory_differences;
CREATE POLICY tpl_inv_snap_all  ON tpl_inventory_snapshots      FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY tpl_inv_lines_all ON tpl_inventory_snapshot_lines FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY tpl_inv_diff_all  ON tpl_inventory_differences    FOR ALL USING (true) WITH CHECK (true);
