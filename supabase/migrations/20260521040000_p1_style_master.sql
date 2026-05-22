-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 4 / Migration 10
-- style_master: style-level attributes shared by every SKU variant of a
-- design. Today `ip_item_master.style_code` is denormalized text — promote
-- it to a proper master table with an FK from item_master (added in mig 11).
-- Architecture: docs/tangerine/P1-foundation-architecture.md §6.1
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS style_master (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  style_code         text NOT NULL,
  description        text NOT NULL,
  category_id        uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  gender_code        text,
  season             text,
  design_year        smallint,
  is_apparel         boolean NOT NULL DEFAULT true,
  launch_date        date,
  lifecycle_status   text NOT NULL DEFAULT 'active',
  planning_class     text,
  base_fabric        text,
  attributes         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at         timestamptz,
  CONSTRAINT style_master_gender_check
    CHECK (gender_code IS NULL OR gender_code IN ('M', 'WMS', 'B', 'C', 'G', 'U')),
  CONSTRAINT style_master_lifecycle_check
    CHECK (lifecycle_status IN ('active', 'phased_out', 'discontinued', 'core')),
  CONSTRAINT style_master_planning_class_check
    CHECK (planning_class IS NULL OR planning_class IN ('core', 'seasonal', 'fashion')),
  CONSTRAINT style_master_design_year_check
    CHECK (design_year IS NULL OR design_year BETWEEN 1990 AND 2100)
);

-- Active style codes must be unique per entity. Soft-deleted rows are excluded
-- so a code can be reissued after a row is tombstoned.
CREATE UNIQUE INDEX IF NOT EXISTS uq_style_master_code
  ON style_master (entity_id, style_code)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_style_master_entity_gender    ON style_master (entity_id, gender_code);
CREATE INDEX IF NOT EXISTS idx_style_master_entity_lifecycle ON style_master (entity_id, lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_style_master_category         ON style_master (category_id);

-- Touched timestamp
CREATE OR REPLACE FUNCTION style_master_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS style_master_touch_trg ON style_master;
CREATE TRIGGER style_master_touch_trg
  BEFORE UPDATE ON style_master
  FOR EACH ROW EXECUTE FUNCTION style_master_touch();

ALTER TABLE style_master ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_style_master" ON style_master
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_internal_style_master" ON style_master
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

COMMENT ON TABLE  style_master IS 'Style-level master. One row per design (Style × season etc.) per entity. Variant attributes (color/size/inseam/length/fit) live on ip_item_master rows that FK in via style_id.';
COMMENT ON COLUMN style_master.style_code   IS 'Human style code (e.g. RY1234). Unique per entity among non-tombstoned rows.';
COMMENT ON COLUMN style_master.is_apparel   IS 'True forces matrix dim NOT NULL on item rows that FK in (enforced by item_master CHECK in mig 11).';
COMMENT ON COLUMN style_master.gender_code  IS 'M | WMS | B | C | G | U — matches rof_xoro daily_check conformance set.';
COMMENT ON COLUMN style_master.deleted_at   IS 'Soft delete; row is excluded from the active-code unique index.';

-- ════════════════════════════════════════════════════════════════════════════
-- Backfill: one row per distinct (entity_id, TRIM(UPPER(style_code))) from
-- ip_item_master. Picks the most-recently-updated source row for description
-- + category + lifecycle attributes.
--
-- We use DISTINCT ON because there are typically many SKU variants per style.
-- Pre-trim/upper handles whitespace + case drift that may have crept into
-- legacy data. Merchandiser will reconcile any unexpected dedupe outcomes
-- via the admin UI in a later chunk.
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO style_master (
  entity_id, style_code, description, category_id,
  lifecycle_status, planning_class, is_apparel
)
SELECT DISTINCT ON (im.entity_id, TRIM(UPPER(im.style_code)))
  im.entity_id,
  TRIM(UPPER(im.style_code)) AS style_code,
  COALESCE(NULLIF(im.description, ''), TRIM(UPPER(im.style_code))) AS description,
  im.category_id,
  CASE
    WHEN im.lifecycle_status IN ('active','phased_out','discontinued','core')
      THEN im.lifecycle_status
    ELSE 'active'
  END AS lifecycle_status,
  CASE
    WHEN im.planning_class IN ('core','seasonal','fashion') THEN im.planning_class
    ELSE NULL
  END AS planning_class,
  true AS is_apparel  -- default; mig 4.5 (data prep) will flip non-apparel rows
FROM ip_item_master im
WHERE im.style_code IS NOT NULL
  AND TRIM(im.style_code) <> ''
ORDER BY im.entity_id, TRIM(UPPER(im.style_code)), im.updated_at DESC
ON CONFLICT DO NOTHING;
