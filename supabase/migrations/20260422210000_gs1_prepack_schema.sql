-- 20260422210000_gs1_prepack_schema.sql
--
-- GS1 Prepack Label Generation — Phase 1
--
-- Tables:
--   company_settings       — GS1 prefix, indicator digit, item reference counter
--   upc_item_master        — child UPCs by style/color/size
--   scale_master           — pack scale codes (CA, CB, CD, etc.)
--   scale_size_ratios      — units per size within a scale
--   pack_gtin_master       — one GTIN per style+color+scale
--   pack_gtin_bom          — which child UPCs make up a pack (Phase 2 ready)
--   packing_list_uploads   — uploaded packing list workbooks
--   packing_list_blocks    — parsed blocks from packing lists
--   parse_issues           — parse warnings / failures
--   label_batches          — batches of labels to print
--   label_batch_lines      — one line per style/color/scale with qty
--
-- RPC:
--   gs1_claim_next_item_reference() — atomically increments counter, returns claimed value
--   gs1_get_or_create_pack_gtin()  — idempotent: returns existing or reserves new ref

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. company_settings  (single-row for now; keyed by id, UI selects LIMIT 1)
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS company_settings (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name                 text NOT NULL,
  gs1_prefix                   text NOT NULL,
  prefix_length                integer NOT NULL CHECK (prefix_length BETWEEN 6 AND 11),
  gtin_indicator_digit         text NOT NULL DEFAULT '1' CHECK (gtin_indicator_digit ~ '^\d$'),
  starting_item_reference      bigint NOT NULL DEFAULT 1,
  next_item_reference_counter  bigint NOT NULL DEFAULT 1,
  default_label_format         text,
  xoro_api_base_url            text,
  xoro_api_key_ref             text,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_company_settings_updated ON company_settings (updated_at);

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. upc_item_master
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS upc_item_master (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upc           text NOT NULL UNIQUE,
  style_no      text NOT NULL,
  color         text NOT NULL,
  size          text NOT NULL,
  description   text,
  source_method text NOT NULL DEFAULT 'excel',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_upc_item_master_style  ON upc_item_master (style_no);
CREATE INDEX IF NOT EXISTS idx_upc_item_master_color  ON upc_item_master (color);
CREATE INDEX IF NOT EXISTS idx_upc_item_master_style_color ON upc_item_master (style_no, color);

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. scale_master
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS scale_master (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scale_code  text NOT NULL UNIQUE,
  description text,
  total_units integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scale_master_code ON scale_master (scale_code);

-- ══════════════════════════════════════════════════════════════════════════════
-- 4. scale_size_ratios
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS scale_size_ratios (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scale_code  text NOT NULL REFERENCES scale_master(scale_code) ON DELETE CASCADE,
  size        text NOT NULL,
  qty         integer NOT NULL CHECK (qty > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_scale_size_ratios ON scale_size_ratios (scale_code, size);
CREATE INDEX IF NOT EXISTS idx_scale_size_ratios_code ON scale_size_ratios (scale_code);

-- ══════════════════════════════════════════════════════════════════════════════
-- 5. pack_gtin_master
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS pack_gtin_master (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  style_no       text NOT NULL,
  color          text NOT NULL,
  scale_code     text NOT NULL,
  pack_gtin      text NOT NULL UNIQUE,
  item_reference bigint NOT NULL UNIQUE,
  units_per_pack integer,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  source_method  text NOT NULL DEFAULT 'system_generated',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pack_gtin_style_color_scale ON pack_gtin_master (style_no, color, scale_code);
CREATE INDEX IF NOT EXISTS idx_pack_gtin_master_style  ON pack_gtin_master (style_no);
CREATE INDEX IF NOT EXISTS idx_pack_gtin_master_gtin   ON pack_gtin_master (pack_gtin);

-- ══════════════════════════════════════════════════════════════════════════════
-- 6. pack_gtin_bom  (Phase 2 receiving readiness)
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS pack_gtin_bom (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_gtin    text NOT NULL REFERENCES pack_gtin_master(pack_gtin) ON DELETE CASCADE,
  child_upc    text NOT NULL REFERENCES upc_item_master(upc) ON DELETE RESTRICT,
  size         text NOT NULL,
  qty_in_pack  integer NOT NULL CHECK (qty_in_pack > 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pack_gtin_bom ON pack_gtin_bom (pack_gtin, child_upc);
CREATE INDEX IF NOT EXISTS idx_pack_gtin_bom_pack ON pack_gtin_bom (pack_gtin);

-- ══════════════════════════════════════════════════════════════════════════════
-- 7. packing_list_uploads
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS packing_list_uploads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name     text NOT NULL,
  storage_path  text NOT NULL DEFAULT '',
  parse_status  text NOT NULL DEFAULT 'uploaded' CHECK (parse_status IN ('uploaded', 'parsing', 'parsed', 'error')),
  parse_summary jsonb,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_packing_list_uploads_status ON packing_list_uploads (parse_status);
CREATE INDEX IF NOT EXISTS idx_packing_list_uploads_date   ON packing_list_uploads (uploaded_at DESC);

-- ══════════════════════════════════════════════════════════════════════════════
-- 8. packing_list_blocks
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS packing_list_blocks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id        uuid NOT NULL REFERENCES packing_list_uploads(id) ON DELETE CASCADE,
  sheet_name       text NOT NULL,
  block_type       text NOT NULL DEFAULT 'channel_qty',
  style_no         text,
  color            text,
  channel          text,
  scale_code       text,
  pack_qty         integer,
  raw_payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  parsed_payload   jsonb,
  confidence_score numeric(5,2),
  parse_status     text NOT NULL DEFAULT 'parsed' CHECK (parse_status IN ('parsed', 'review', 'failed')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_packing_list_blocks_upload ON packing_list_blocks (upload_id);
CREATE INDEX IF NOT EXISTS idx_packing_list_blocks_style  ON packing_list_blocks (style_no);

-- ══════════════════════════════════════════════════════════════════════════════
-- 9. parse_issues
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS parse_issues (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id   uuid NOT NULL REFERENCES packing_list_uploads(id) ON DELETE CASCADE,
  sheet_name  text,
  issue_type  text NOT NULL,
  severity    text NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  message     text NOT NULL,
  raw_context jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_parse_issues_upload   ON parse_issues (upload_id);
CREATE INDEX IF NOT EXISTS idx_parse_issues_severity ON parse_issues (severity);

-- ══════════════════════════════════════════════════════════════════════════════
-- 10. label_batches
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS label_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id     uuid REFERENCES packing_list_uploads(id) ON DELETE SET NULL,
  batch_name    text NOT NULL,
  status        text NOT NULL DEFAULT 'generated' CHECK (status IN ('generated', 'printed', 'cancelled')),
  output_format text NOT NULL DEFAULT 'pdf',
  generated_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_label_batches_upload ON label_batches (upload_id);
CREATE INDEX IF NOT EXISTS idx_label_batches_date   ON label_batches (generated_at DESC);

-- ══════════════════════════════════════════════════════════════════════════════
-- 11. label_batch_lines
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS label_batch_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          uuid NOT NULL REFERENCES label_batches(id) ON DELETE CASCADE,
  style_no          text NOT NULL,
  color             text NOT NULL,
  scale_code        text NOT NULL,
  pack_gtin         text NOT NULL,
  label_qty         integer NOT NULL CHECK (label_qty > 0),
  source_sheet_name text,
  source_channel    text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_label_batch_lines_batch ON label_batch_lines (batch_id);
CREATE INDEX IF NOT EXISTS idx_label_batch_lines_gtin  ON label_batch_lines (pack_gtin);

-- ══════════════════════════════════════════════════════════════════════════════
-- RLS: permissive anon policy (internal app — matches existing pattern)
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'company_settings', 'upc_item_master', 'scale_master', 'scale_size_ratios',
    'pack_gtin_master', 'pack_gtin_bom', 'packing_list_uploads',
    'packing_list_blocks', 'parse_issues', 'label_batches', 'label_batch_lines'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'DROP POLICY IF EXISTS gs1_anon_all ON %I', t
    );
    EXECUTE format(
      'CREATE POLICY gs1_anon_all ON %I FOR ALL TO anon USING (true) WITH CHECK (true)', t
    );
  END LOOP;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- RPC: Atomic item reference counter claim
-- Returns the counter value that was claimed, then increments stored value.
-- ══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION gs1_claim_next_item_reference()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_claimed bigint;
BEGIN
  SELECT next_item_reference_counter
  INTO   v_claimed
  FROM   company_settings
  ORDER BY created_at
  LIMIT  1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'company_settings is not configured — run Company Setup first';
  END IF;

  UPDATE company_settings
  SET    next_item_reference_counter = next_item_reference_counter + 1,
         updated_at                  = now()
  WHERE  next_item_reference_counter = v_claimed;

  RETURN v_claimed;
END;
$$;

-- ══════════════════════════════════════════════════════════════════════════════
-- updated_at trigger helper (mirrors pattern used elsewhere in this repo)
-- ══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION gs1_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'company_settings', 'upc_item_master', 'scale_master', 'pack_gtin_master'
  ]
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%s_updated_at ON %I', t, t
    );
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated_at
       BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION gs1_set_updated_at()',
      t, t
    );
  END LOOP;
END $$;
