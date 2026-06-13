-- Style Master — logistics attributes for PO roll-ups.
--
-- A purchase order rolls up total weight / cartons / CBM from the styles it
-- buys, so the per-style logistics live on style_master:
--   unit_weight_kg   — weight of ONE unit, in kilograms
--   units_per_carton — how many units pack into one carton (master/shipping carton)
--   carton_cbm_m3    — volume of ONE packed carton, in cubic metres
--
-- PO roll-up math (surfaced read-only on the PO):
--   total cartons = ceil(total_units / units_per_carton)
--   total weight  = total_units * unit_weight_kg
--   total CBM     = total_cartons * carton_cbm_m3
--
-- All nullable — legacy styles keep working; the PO shows "—" until they're set.

ALTER TABLE style_master
  ADD COLUMN IF NOT EXISTS unit_weight_kg   numeric(12,4),
  ADD COLUMN IF NOT EXISTS units_per_carton integer,
  ADD COLUMN IF NOT EXISTS carton_cbm_m3    numeric(12,5);

-- Idempotent: the columns were applied to prod out-of-band (Management API),
-- so `supabase db push` re-runs this file; guard the constraint add.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'style_master_units_per_carton_pos' AND conrelid = 'style_master'::regclass) THEN
    ALTER TABLE style_master
      ADD CONSTRAINT style_master_units_per_carton_pos
        CHECK (units_per_carton IS NULL OR units_per_carton > 0);
  END IF;
END $$;

COMMENT ON COLUMN style_master.unit_weight_kg   IS 'Weight of one unit, in kilograms (rolls up to PO total weight).';
COMMENT ON COLUMN style_master.units_per_carton IS 'Units per master/shipping carton (rolls up to PO total cartons).';
COMMENT ON COLUMN style_master.carton_cbm_m3    IS 'Volume of one packed carton, in cubic metres (rolls up to PO total CBM).';
