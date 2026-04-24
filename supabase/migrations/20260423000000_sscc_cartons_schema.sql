-- 20260423000000_sscc_cartons_schema.sql
--
-- SSCC-18 carton label generation — extends gs1_prepack_schema
--
-- Changes:
--   company_settings  + sscc_extension_digit, sscc_starting_serial_reference,
--                       sscc_next_serial_reference_counter
--   label_batches     + label_mode
--   label_batch_lines + label_type, sscc_first, sscc_last, carton_count
--   cartons           new table — one row per physical carton (unique SSCC)
--   carton_contents   new table — BOM explosion for one-scan receiving (Phase 2)
--
-- New RPCs:
--   sscc_claim_serial_range(count) — atomically reserves a contiguous serial range

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. Extend company_settings with SSCC fields
-- ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS sscc_extension_digit              text    NOT NULL DEFAULT '0'
    CHECK (sscc_extension_digit ~ '^\d$'),
  ADD COLUMN IF NOT EXISTS sscc_starting_serial_reference    bigint  NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS sscc_next_serial_reference_counter bigint NOT NULL DEFAULT 1;

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. Extend label_batches with label_mode
-- ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE label_batches
  ADD COLUMN IF NOT EXISTS label_mode text NOT NULL DEFAULT 'pack_gtin'
    CHECK (label_mode IN ('pack_gtin', 'sscc', 'both'));

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. Extend label_batch_lines with SSCC summary fields
-- ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE label_batch_lines
  ADD COLUMN IF NOT EXISTS label_type   text DEFAULT 'pack_gtin'
    CHECK (label_type IN ('pack_gtin', 'sscc', 'both')),
  ADD COLUMN IF NOT EXISTS sscc_first   text,   -- first SSCC in the range for this line
  ADD COLUMN IF NOT EXISTS sscc_last    text,   -- last  SSCC in the range for this line
  ADD COLUMN IF NOT EXISTS carton_count integer; -- = label_qty when SSCCs generated

-- ══════════════════════════════════════════════════════════════════════════════
-- 4. cartons — one row per physical prepack carton
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cartons (
  id               uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  sscc             text    NOT NULL UNIQUE,
  serial_reference bigint  NOT NULL UNIQUE,
  batch_id         uuid    REFERENCES label_batches(id)     ON DELETE SET NULL,
  batch_line_id    uuid    REFERENCES label_batch_lines(id) ON DELETE SET NULL,
  pack_gtin        text    REFERENCES pack_gtin_master(pack_gtin) ON DELETE RESTRICT,
  style_no         text,
  color            text,
  scale_code       text,
  carton_seq       integer NOT NULL DEFAULT 1,  -- 1-of-N within the batch line
  status           text    NOT NULL DEFAULT 'generated'
    CHECK (status IN ('generated', 'shipped', 'received', 'cancelled')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cartons_batch         ON cartons (batch_id);
CREATE INDEX IF NOT EXISTS idx_cartons_batch_line    ON cartons (batch_line_id);
CREATE INDEX IF NOT EXISTS idx_cartons_sscc          ON cartons (sscc);
CREATE INDEX IF NOT EXISTS idx_cartons_pack_gtin     ON cartons (pack_gtin);
CREATE INDEX IF NOT EXISTS idx_cartons_status        ON cartons (status);

-- ══════════════════════════════════════════════════════════════════════════════
-- 5. carton_contents — BOM explosion for one-scan receiving (Phase 2)
--    Populated when UPC master + pack BOM is set up; left empty in Phase 1.
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS carton_contents (
  id           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  carton_id    uuid    NOT NULL REFERENCES cartons(id) ON DELETE CASCADE,
  pack_gtin    text    NOT NULL,
  child_upc    text,             -- nullable: filled from upc_item_master when available
  size         text,
  qty_per_pack integer NOT NULL CHECK (qty_per_pack > 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_carton_contents_carton ON carton_contents (carton_id);
CREATE INDEX IF NOT EXISTS idx_carton_contents_upc    ON carton_contents (child_upc);

-- ══════════════════════════════════════════════════════════════════════════════
-- 6. RLS — same permissive anon policy pattern as other GS1 tables
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cartons','carton_contents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS gs1_anon_all ON %I', t);
    EXECUTE format(
      'CREATE POLICY gs1_anon_all ON %I FOR ALL TO anon USING (true) WITH CHECK (true)', t
    );
  END LOOP;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 7. RPC: claim a contiguous range of SSCC serial references atomically
--    Returns the inclusive range [serial_start, serial_end].
--    Caller generates SSCCs locally for each integer in the range.
-- ══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION sscc_claim_serial_range(p_count bigint)
RETURNS TABLE(serial_start bigint, serial_end bigint)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_start bigint;
BEGIN
  IF p_count < 1 THEN
    RAISE EXCEPTION 'sscc_claim_serial_range: p_count must be >= 1, got %', p_count;
  END IF;

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
  SET    sscc_next_serial_reference_counter = v_start + p_count,
         updated_at = now()
  WHERE  sscc_next_serial_reference_counter = v_start;

  RETURN QUERY SELECT v_start, v_start + p_count - 1;
END;
$$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 8. updated_at trigger for cartons
-- ══════════════════════════════════════════════════════════════════════════════
DROP TRIGGER IF EXISTS trg_cartons_updated_at ON cartons;
CREATE TRIGGER trg_cartons_updated_at
  BEFORE UPDATE ON cartons
  FOR EACH ROW EXECUTE FUNCTION gs1_set_updated_at();
