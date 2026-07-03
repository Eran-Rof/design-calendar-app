-- Manufacturing — the finished good of a BOM / build is a STYLE (not one
-- size-level SKU). Inventory still depletes per size (via the per-size outputs,
-- mig 20260932), but selection, the BOM, and the build now key on the base
-- style, and a planned color x size matrix can be entered at build creation.
--
-- finished_item_id stays on the build as a REPRESENTATIVE SKU (a handle for the
-- single-item fallback / labels); the real per-size stock is created from
-- mfg_build_outputs at completion.
ALTER TABLE mfg_build_orders
  ADD COLUMN IF NOT EXISTS finished_style_id uuid REFERENCES style_master(id) ON DELETE SET NULL;
ALTER TABLE mfg_bom
  ADD COLUMN IF NOT EXISTS finished_style_id uuid REFERENCES style_master(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS mfg_build_orders_finished_style_idx ON mfg_build_orders(finished_style_id);
CREATE INDEX IF NOT EXISTS mfg_bom_finished_style_idx          ON mfg_bom(finished_style_id);

-- Backfill the style from each row's existing finished_item_id (its SKU's style).
UPDATE mfg_build_orders b
   SET finished_style_id = i.style_id
  FROM ip_item_master i
 WHERE b.finished_item_id = i.id
   AND b.finished_style_id IS NULL
   AND i.style_id IS NOT NULL;

UPDATE mfg_bom m
   SET finished_style_id = i.style_id
  FROM ip_item_master i
 WHERE m.finished_item_id = i.id
   AND m.finished_style_id IS NULL
   AND i.style_id IS NOT NULL;
