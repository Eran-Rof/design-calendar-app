-- 20260424000000_sscc_carton_fields.sql
--
-- Extends cartons and carton_contents with fields required for:
--   - Manual standalone carton creation (PO#, carton#, channel)
--   - Upload linkage (upload_id)
--   - Receiving foundation (style/color/scale per content line, exploded unit qty)
--
-- All changes use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so this migration is
-- safe to re-run against a DB that already has some of these columns.

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. Extend cartons with standalone / manual creation fields
-- ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE cartons
  ADD COLUMN IF NOT EXISTS upload_id   uuid    REFERENCES packing_list_uploads(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS po_number   text,
  ADD COLUMN IF NOT EXISTS carton_no   text,
  ADD COLUMN IF NOT EXISTS total_packs integer,
  ADD COLUMN IF NOT EXISTS total_units integer;

CREATE INDEX IF NOT EXISTS idx_cartons_upload    ON cartons (upload_id);
CREATE INDEX IF NOT EXISTS idx_cartons_po_number ON cartons (po_number);

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. Extend carton_contents with style/color/scale + receiving fields
--    pack_qty  = how many packs of this GTIN are in the carton
--    exploded_unit_qty = pack_qty × scale.total_units (populated at creation)
-- ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE carton_contents
  ADD COLUMN IF NOT EXISTS style_no          text,
  ADD COLUMN IF NOT EXISTS color             text,
  ADD COLUMN IF NOT EXISTS scale_code        text,
  ADD COLUMN IF NOT EXISTS pack_qty          integer,
  ADD COLUMN IF NOT EXISTS exploded_unit_qty integer;

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. RPC: create a single SSCC carton atomically
--    Claims 1 serial reference and returns it so the caller can build the SSCC.
-- ══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION sscc_claim_one_serial()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_start bigint;
BEGIN
  SELECT sscc_next_serial_reference_counter
  INTO   v_start
  FROM   company_settings
  ORDER BY created_at
  LIMIT  1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'company_settings is not configured — run Company Setup first';
  END IF;

  UPDATE company_settings
  SET    sscc_next_serial_reference_counter = v_start + 1,
         updated_at = now()
  WHERE  sscc_next_serial_reference_counter = v_start;

  RETURN v_start;
END;
$$;
