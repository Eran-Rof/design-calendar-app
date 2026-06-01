-- Tangerine-only SIZE-GRAIN on-hand source for the Inventory Matrix.
--
-- WHY: planning (ATS) deliberately collapses Xoro REST on-hand to color grain
-- in scripts/rest_to_ats_inventory.py + api/_lib/planning-sync.js, writing
-- ip_inventory_snapshot at COLOR grain. The Tangerine Inventory Matrix needs
-- per-SIZE on-hand. Per operator decision (2026-06-01) other apps stay color
-- grain; Tangerine gets its OWN size-grain source so nothing about the
-- planning snapshot changes.
--
-- This table is the size-grain mirror input. It is keyed on the per-SIZE
-- ip_item_master SKU (item_id), so the existing FIFO/layer machinery and
-- styleMatrix.js read it with no schema change downstream. It is populated by
-- scripts/ingest-size-onhand.mjs from the nightly Xoro REST CSV
-- (postAD_invrest_*.csv) — per (BasePartNumber, Color, Size, StoreName).
--
-- NO-OP GUARANTEE: creating this (empty) table changes nothing the matrix
-- shows. api/_lib/xoro-mirror/inventory.js only routes a style to the
-- size-grain source when that style HAS rows here; every other style keeps
-- the color-grain ip_inventory_snapshot path. The "replace per style" cutover
-- happens one style at a time as size-grain rows are landed for it.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.tangerine_size_onhand (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       uuid NOT NULL DEFAULT rof_entity_id() REFERENCES public.entities(id) ON DELETE CASCADE,
  item_id         uuid NOT NULL REFERENCES public.ip_item_master(id) ON DELETE CASCADE,
  warehouse_code  text NOT NULL DEFAULT 'DEFAULT',
  snapshot_date   date NOT NULL,
  qty_on_hand     numeric NOT NULL DEFAULT 0,
  source          text NOT NULL DEFAULT 'xoro_rest',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One row per (sku, warehouse, date, source) — matches the planning snapshot's
-- conflict key so the ingest can upsert idempotently.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tangerine_size_onhand_key
  ON public.tangerine_size_onhand (entity_id, item_id, warehouse_code, snapshot_date, source);

-- The mirror needs: "does this STYLE have any size-grain rows on/before D?"
-- and then "give me the latest per (item, warehouse)". Both are served by a
-- join from ip_item_master.style_id; index the snapshot_date + item for the
-- per-style scan.
CREATE INDEX IF NOT EXISTS idx_tangerine_size_onhand_item_date
  ON public.tangerine_size_onhand (entity_id, item_id, snapshot_date DESC);

COMMENT ON TABLE public.tangerine_size_onhand IS 'Tangerine-only size-grain on-hand mirror input (per-size SKU). Separate from planning color-grain ip_inventory_snapshot. Drives inventory_layers rebuild per style only when populated; empty = no-op.';
COMMENT ON COLUMN public.tangerine_size_onhand.item_id IS 'Per-SIZE ip_item_master SKU (style,color,size) resolved via resolveOrCreateSku.';
COMMENT ON COLUMN public.tangerine_size_onhand.warehouse_code IS 'Xoro StoreName, mirrored into inventory_layers.notes for later P21 re-bucketing.';

-- RLS: mirror the inventory_layers posture — service-role writes, anon read.
ALTER TABLE public.tangerine_size_onhand ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'tangerine_size_onhand'
      AND policyname = 'tangerine_size_onhand_read'
  ) THEN
    CREATE POLICY tangerine_size_onhand_read ON public.tangerine_size_onhand
      FOR SELECT USING (true);
  END IF;
END $$;

-- ── Correct RYB0412's size scale: it is a PANT on the even-numbered waist
--    run {28,30,32,34,36,38,40,42}, NOT the DENIM-WAIST scale (which includes
--    the odd 31). The EVEN-NUM-WAIST scale already exists; just re-point.
--    Idempotent + guarded so it only fires when both rows exist and is a no-op
--    once corrected.
UPDATE public.style_master sm
SET size_scale_id = ss.id, updated_at = now()
FROM public.size_scales ss
WHERE ss.code = 'EVEN-NUM-WAIST'
  AND ss.entity_id = sm.entity_id
  AND sm.style_code = 'RYB0412'
  AND sm.size_scale_id IS DISTINCT FROM ss.id;

NOTIFY pgrst, 'reload schema';
