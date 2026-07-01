-- Manufacturing Phase A — per-SIZE build outputs.
--
-- Until now a build produced a single finished_item_id and mfgBuildComplete
-- landed ONE finished-goods FIFO layer at that item. Apparel builds run a
-- color x size matrix in one go, and inventory depletes at SIZE grain (each
-- inventory_layers row keys ip_item_master (style-color-size)). This table
-- records what a build actually produced per (item, color, size); at
-- completion each row becomes one finished-goods FIFO layer and one
-- finished-inventory GL debit (subledger=item), so on-hand and COGS are
-- correct per size. Cost is allocated uniformly (accumulated / total units).
CREATE TABLE IF NOT EXISTS mfg_build_outputs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  build_order_id  uuid NOT NULL REFERENCES mfg_build_orders(id) ON DELETE CASCADE,
  item_id         uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  color           text,
  size            text,
  qty             numeric(18,4) NOT NULL CHECK (qty > 0),
  unit_cost_cents bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mfg_build_outputs_build_idx ON mfg_build_outputs(build_order_id);
CREATE INDEX IF NOT EXISTS mfg_build_outputs_item_idx  ON mfg_build_outputs(item_id);

-- RLS — anon_all + auth_internal (mirrors mfg_build_components).
ALTER TABLE mfg_build_outputs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_mfg_build_outputs" ON mfg_build_outputs;
CREATE POLICY "anon_all_mfg_build_outputs" ON mfg_build_outputs FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "auth_internal_mfg_build_outputs" ON mfg_build_outputs;
CREATE POLICY "auth_internal_mfg_build_outputs" ON mfg_build_outputs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
