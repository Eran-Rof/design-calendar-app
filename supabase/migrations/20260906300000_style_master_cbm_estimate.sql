-- style_master: AI master-carton CBM estimate (operator: CBM estimator).
--
-- The carton dimensions are an AI ESTIMATE for freight planning. The canonical
-- effective volume stays in carton_cbm_m3 (already present, feeds the PO CBM
-- rollup) — these columns hold the estimate's dims/weight/confidence plus the
-- inputs used (cache key) and a manual-override flag. When carton_cbm_override
-- is true, an operator entered a forwarder-measured carton and the AI estimate
-- must not overwrite it.

ALTER TABLE style_master
  ADD COLUMN IF NOT EXISTS carton_length_in    numeric,
  ADD COLUMN IF NOT EXISTS carton_width_in     numeric,
  ADD COLUMN IF NOT EXISTS carton_height_in    numeric,
  ADD COLUMN IF NOT EXISTS gross_weight_lb     numeric,
  ADD COLUMN IF NOT EXISTS cbm_confidence      text,
  ADD COLUMN IF NOT EXISTS cbm_note            text,
  ADD COLUMN IF NOT EXISTS cbm_inputs          jsonb,
  ADD COLUMN IF NOT EXISTS carton_cbm_override boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN style_master.carton_length_in    IS 'Master carton length (inches) — AI estimate or measured override.';
COMMENT ON COLUMN style_master.carton_width_in     IS 'Master carton width (inches) — AI estimate or measured override.';
COMMENT ON COLUMN style_master.carton_height_in    IS 'Master carton height (inches) — AI estimate or measured override.';
COMMENT ON COLUMN style_master.gross_weight_lb     IS 'Estimated gross weight of a packed master carton (lb).';
COMMENT ON COLUMN style_master.cbm_confidence      IS 'AI estimate confidence: low | medium | high.';
COMMENT ON COLUMN style_master.cbm_note            IS 'One-line AI note on the main packing assumption.';
COMMENT ON COLUMN style_master.cbm_inputs          IS 'Inputs used for the last estimate {product_type, fold_type, pack_qty, unit_weight_lb} — cache key.';
COMMENT ON COLUMN style_master.carton_cbm_override IS 'TRUE = carton dims/cbm were entered by hand (forwarder-measured) and override the AI estimate.';
