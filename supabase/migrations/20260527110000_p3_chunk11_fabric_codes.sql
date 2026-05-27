-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P3 / Chunk 11 / Migration 1
-- M42-precursor — Fabric Code Master + style_fabric_codes junction.
--
-- Operator flagged the gap on 2026-05-27: M34 Style Master (Chunk 4 / P1)
-- shipped without structured fabric data, and M42 PIM is months away in P8,
-- but textile-specific fabric reference is needed NOW for tech packs, GS1
-- care labels, and upcoming customs work (M48). Currently fabric info lives
-- in ip_item_master.attributes JSONB or unstructured tech pack PDFs.
--
-- Architecture: docs/tangerine/P3-acc-core-architecture.md §10 (P3-11 row).
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- fabric_codes — one row per canonical fabric per entity.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fabric_codes (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  code                     text NOT NULL,
  name                     text NOT NULL,
  composition_text         text NOT NULL,
  composition_json         jsonb,
  fabric_weight_gsm        numeric(8,2),
  country_of_origin_iso2   char(2),
  hts_code                 text,
  care_instructions        text,
  default_vendor_id        uuid REFERENCES vendors(id) ON DELETE SET NULL,
  is_active                boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT fabric_codes_country_iso2_check
    CHECK (country_of_origin_iso2 IS NULL OR country_of_origin_iso2 ~ '^[A-Z]{2}$'),
  CONSTRAINT fabric_codes_weight_check
    CHECK (fabric_weight_gsm IS NULL OR fabric_weight_gsm >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fabric_codes_entity_code
  ON fabric_codes (entity_id, code);
CREATE INDEX IF NOT EXISTS idx_fabric_codes_entity_active
  ON fabric_codes (entity_id, is_active);

COMMENT ON TABLE  fabric_codes IS 'Canonical fabric reference data per entity. Drives tech pack content, GS1 care labels, and customs (HTS/COO).';
COMMENT ON COLUMN fabric_codes.code             IS 'Short identifier (CTN100, DEN14, POLY60_CTN40, etc.). Unique per entity. Locked once created.';
COMMENT ON COLUMN fabric_codes.composition_text IS 'Free-form composition string for label/tech-pack display (e.g. "60% Polyester / 40% Cotton").';
COMMENT ON COLUMN fabric_codes.composition_json IS 'Optional structured composition: [{"fiber":"cotton","pct":100}] — feeds analytics + auto-label generation.';
COMMENT ON COLUMN fabric_codes.country_of_origin_iso2 IS 'ISO 3166-1 alpha-2 (uppercased). NULL = unspecified (operator fills via UI).';
COMMENT ON COLUMN fabric_codes.hts_code         IS 'HTS / HSN code for customs filings (M48). Free-form text — validation is operator-supervised.';

-- Touch trigger
CREATE OR REPLACE FUNCTION fabric_codes_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fabric_codes_touch_trg ON fabric_codes;
CREATE TRIGGER fabric_codes_touch_trg
  BEFORE UPDATE ON fabric_codes
  FOR EACH ROW EXECUTE FUNCTION fabric_codes_touch();

ALTER TABLE fabric_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_fabric_codes" ON fabric_codes
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_internal_fabric_codes" ON fabric_codes
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- ────────────────────────────────────────────────────────────────────────────
-- style_fabric_codes — M:N junction between style_master and fabric_codes.
-- Same fabric can appear in different roles on the same style (e.g. primary
-- cotton AND trim cotton), but not duplicated within a role.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS style_fabric_codes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  style_id            uuid NOT NULL REFERENCES style_master(id) ON DELETE CASCADE,
  fabric_code_id      uuid NOT NULL REFERENCES fabric_codes(id) ON DELETE RESTRICT,
  role                text NOT NULL,
  yardage_per_unit    numeric(10,4),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT style_fabric_codes_role_check
    CHECK (role IN ('primary','lining','trim','interlining','accent','other')),
  CONSTRAINT style_fabric_codes_yardage_check
    CHECK (yardage_per_unit IS NULL OR yardage_per_unit >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_style_fabric_codes_style_fab_role
  ON style_fabric_codes (style_id, fabric_code_id, role);
CREATE INDEX IF NOT EXISTS idx_style_fabric_codes_style ON style_fabric_codes (style_id);
CREATE INDEX IF NOT EXISTS idx_style_fabric_codes_fab   ON style_fabric_codes (fabric_code_id);

COMMENT ON TABLE  style_fabric_codes IS 'M:N junction: which fabrics make up which style, by role + yardage. Cascade-delete with style_master; RESTRICT on fabric_codes (can''t delete a fabric in use).';
COMMENT ON COLUMN style_fabric_codes.role             IS 'primary | lining | trim | interlining | accent | other';
COMMENT ON COLUMN style_fabric_codes.yardage_per_unit IS 'Quantity of this fabric per finished unit. Units assumed yards; tune if metric becomes default.';

CREATE OR REPLACE FUNCTION style_fabric_codes_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS style_fabric_codes_touch_trg ON style_fabric_codes;
CREATE TRIGGER style_fabric_codes_touch_trg
  BEFORE UPDATE ON style_fabric_codes
  FOR EACH ROW EXECUTE FUNCTION style_fabric_codes_touch();

ALTER TABLE style_fabric_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_style_fabric_codes" ON style_fabric_codes
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_internal_style_fabric_codes" ON style_fabric_codes
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- ────────────────────────────────────────────────────────────────────────────
-- Defensive seed: common apparel fabrics for ROF entity. Skips if any
-- fabric_codes row already exists for ROF.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  rof_id uuid;
BEGIN
  SELECT id INTO rof_id FROM entities WHERE code = 'ROF';
  IF rof_id IS NULL THEN
    RAISE NOTICE 'fabric_codes seed skipped: ROF entity not found';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM fabric_codes WHERE entity_id = rof_id) THEN
    RAISE NOTICE 'fabric_codes seed skipped: rows already exist for ROF';
    RETURN;
  END IF;

  INSERT INTO fabric_codes (entity_id, code, name, composition_text, composition_json, fabric_weight_gsm, is_active) VALUES
    (rof_id, 'CTN100',        '100% Cotton',                    '100% Cotton',                          '[{"fiber":"cotton","pct":100}]'::jsonb,                                 180.00, true),
    (rof_id, 'DEN14',          '14oz Denim',                     '100% Cotton, 14oz denim weave',        '[{"fiber":"cotton","pct":100}]'::jsonb,                                 410.00, true),
    (rof_id, 'DEN12',          '12oz Denim',                     '100% Cotton, 12oz denim weave',        '[{"fiber":"cotton","pct":100}]'::jsonb,                                 350.00, true),
    (rof_id, 'POLY100',        '100% Polyester',                 '100% Polyester',                       '[{"fiber":"polyester","pct":100}]'::jsonb,                              150.00, true),
    (rof_id, 'POLY60_CTN40',   '60/40 Polyester-Cotton',         '60% Polyester / 40% Cotton',           '[{"fiber":"polyester","pct":60},{"fiber":"cotton","pct":40}]'::jsonb,   200.00, true),
    (rof_id, 'VIS100',         '100% Viscose',                   '100% Viscose',                         '[{"fiber":"viscose","pct":100}]'::jsonb,                                130.00, true),
    (rof_id, 'WOOL100',        '100% Wool',                      '100% Wool',                            '[{"fiber":"wool","pct":100}]'::jsonb,                                   280.00, true),
    (rof_id, 'LINEN100',       '100% Linen',                     '100% Linen',                           '[{"fiber":"linen","pct":100}]'::jsonb,                                  200.00, true),
    (rof_id, 'SPANDEX_BLEND',  'Cotton-Spandex blend (typical)', '95% Cotton / 5% Spandex (typical)',    '[{"fiber":"cotton","pct":95},{"fiber":"spandex","pct":5}]'::jsonb,      220.00, true);
END $$;
