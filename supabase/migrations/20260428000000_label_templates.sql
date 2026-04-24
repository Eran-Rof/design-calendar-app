-- 20260428000000_label_templates.sql
--
-- Phase 5: Label templates, barcode quality, and print/reprint controls
--
-- Changes:
--   label_templates     new — one row per label layout (pack_gtin or sscc)
--   label_print_logs    new — one row per print/reprint event

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. Label templates
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS label_templates (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  label_type            text        NOT NULL
                          CHECK (label_type IN ('pack_gtin', 'sscc')),
  template_name         text        NOT NULL,
  label_width           text,                       -- e.g. "4" (inches)
  label_height          text,                       -- e.g. "6" (inches)
  printer_type          text        NOT NULL DEFAULT 'pdf'
                          CHECK (printer_type IN ('pdf', 'zebra_zpl', 'csv')),
  barcode_format        text        NOT NULL DEFAULT 'gtin14',
                                                     -- gtin14 | sscc18 | code128
  human_readable_fields jsonb,                       -- {"show_style":true,...}
  is_default            boolean     NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_label_templates_type    ON label_templates (label_type);
CREATE INDEX IF NOT EXISTS idx_label_templates_default ON label_templates (label_type, is_default);

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. Print log — one row per print / reprint event
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS label_print_logs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  label_batch_id   uuid        REFERENCES label_batches(id) ON DELETE SET NULL,
  label_type       text        NOT NULL,
  printed_by       text,
  print_method     text,                            -- pdf | zebra_zpl | csv
  labels_printed   integer     NOT NULL DEFAULT 0,
  output_file_path text,
  status           text        NOT NULL DEFAULT 'printed'
                     CHECK (status IN ('printed', 'reprint', 'failed')),
  reprint_reason   text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_label_print_logs_batch    ON label_print_logs (label_batch_id);
CREATE INDEX IF NOT EXISTS idx_label_print_logs_created  ON label_print_logs (created_at DESC);

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. RLS — same permissive anon pattern as all GS1 tables
-- ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE label_templates  ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gs1_anon_all ON label_templates;
CREATE POLICY gs1_anon_all ON label_templates
  FOR ALL TO anon USING (true) WITH CHECK (true);

ALTER TABLE label_print_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gs1_anon_all ON label_print_logs;
CREATE POLICY gs1_anon_all ON label_print_logs
  FOR ALL TO anon USING (true) WITH CHECK (true);
