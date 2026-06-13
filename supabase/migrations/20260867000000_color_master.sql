-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine — Color Master (color_master)
-- A simple master listing the colors a style can be offered in. Mirrors the
-- season_master shape (entity-scoped, active flag, touched timestamp, RLS) but
-- keyed on a human color NAME (no auto-code).
--
-- Style Master stores a style's chosen colors as an array of color_master ids in
-- style_master.attributes.color_ids (JSON), so this master is purely additive:
-- no FK column is added to style_master and no existing flow changes. The size
-- matrix (api/_lib/styleMatrix.js) resolves those ids back to color NAMES and
-- merges them with the colors derived from existing SKUs, so a brand-new style
-- renders its declared color rows even before any SKU exists.
--
-- Seeded from every distinct color already present on ip_item_master so the
-- picker starts fully populated with the catalog's real colors.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS color_master (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  name               text NOT NULL,
  code               text,
  hex                text,
  sort_order         smallint NOT NULL DEFAULT 0,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Case-insensitive uniqueness per entity so "Black" and "black" don't fork.
-- This functional index is the guard the seed + POST upsert target via
-- ON CONFLICT (entity_id, lower(name)).
CREATE UNIQUE INDEX IF NOT EXISTS uq_color_master_entity_lower_name
  ON color_master (entity_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_color_master_entity_active
  ON color_master (entity_id, is_active);

-- Touched timestamp
CREATE OR REPLACE FUNCTION color_master_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS color_master_touch_trg ON color_master;
CREATE TRIGGER color_master_touch_trg
  BEFORE UPDATE ON color_master
  FOR EACH ROW EXECUTE FUNCTION color_master_touch();

ALTER TABLE color_master ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_color_master" ON color_master;
CREATE POLICY "anon_all_color_master" ON color_master
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_color_master" ON color_master;
CREATE POLICY "auth_internal_color_master" ON color_master
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

COMMENT ON TABLE  color_master IS 'Tangerine color master. One row per color per entity. Style Master stores chosen colors as color_master ids in attributes.color_ids (JSON, no FK).';
COMMENT ON COLUMN color_master.name IS 'Human color label rendered as a matrix row, e.g. Black, Charcoal Hthr.';
COMMENT ON COLUMN color_master.code IS 'Optional short color code (nullable).';
COMMENT ON COLUMN color_master.hex IS 'Optional #RRGGBB swatch (nullable).';

-- ── Seed from every distinct existing color on ip_item_master (ROF entity) ────
-- Trimmed, non-empty distinct colors become master rows. ON CONFLICT keeps the
-- migration idempotent and skips any color already present.
INSERT INTO color_master (entity_id, name)
SELECT im.entity_id, btrim(im.color) AS name
FROM ip_item_master im
WHERE im.color IS NOT NULL
  AND btrim(im.color) <> ''
GROUP BY im.entity_id, btrim(im.color)
ON CONFLICT (entity_id, lower(name)) DO NOTHING;
