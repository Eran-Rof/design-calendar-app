-- ════════════════════════════════════════════════════════════════════════════
-- Manufacturing module (M3) — Bill of Materials (BOM).
--
-- A BOM is the recipe for assembling a finished style (ip_item_master) out of
-- components. A component is one of:
--   part            — a purchased part_master row (consumed from part inventory)
--   service         — an outsourced service_item_master charge (CMT/print/sew/pack)
--   finished_style  — an existing ip_item_master finished style consumed into the
--                     build (e.g. a base jean → a "PL" labeled/packed variant)
--
-- One ACTIVE version per finished item; older versions stay as archived history.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS mfg_bom (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                     uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  finished_item_id              uuid NOT NULL REFERENCES ip_item_master(id) ON DELETE CASCADE,
  bom_kind                      text NOT NULL DEFAULT 'style' CHECK (bom_kind IN ('style', 'sku')),
  version                       int  NOT NULL DEFAULT 1,
  status                        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  default_conversion_vendor_id  uuid REFERENCES vendors(id) ON DELETE SET NULL,
  notes                         text,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  created_by_user_id            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT mfg_bom_entity_item_version_unique UNIQUE (entity_id, finished_item_id, version)
);
-- At most one ACTIVE BOM per finished item.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mfg_bom_active
  ON mfg_bom (entity_id, finished_item_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS mfg_bom_entity_idx ON mfg_bom(entity_id);

CREATE TABLE IF NOT EXISTS mfg_bom_components (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bom_id            uuid NOT NULL REFERENCES mfg_bom(id) ON DELETE CASCADE,
  component_kind    text NOT NULL CHECK (component_kind IN ('part','service','finished_style')),
  part_id           uuid REFERENCES part_master(id) ON DELETE RESTRICT,
  service_item_id   uuid REFERENCES service_item_master(id) ON DELETE RESTRICT,
  component_item_id uuid REFERENCES ip_item_master(id) ON DELETE RESTRICT,
  qty_per_unit      numeric(18,6) NOT NULL DEFAULT 1 CHECK (qty_per_unit > 0),
  scrap_pct         numeric(7,4)  NOT NULL DEFAULT 0 CHECK (scrap_pct >= 0 AND scrap_pct < 100),
  cost_source       text NOT NULL DEFAULT 'fifo' CHECK (cost_source IN ('fifo','default')),
  line_number       int  NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Exactly one of (part_id, service_item_id, component_item_id), matching kind.
  CONSTRAINT mfg_bom_components_one_of CHECK (
    (component_kind = 'part'           AND part_id IS NOT NULL AND service_item_id IS NULL AND component_item_id IS NULL)
    OR (component_kind = 'service'        AND service_item_id IS NOT NULL AND part_id IS NULL AND component_item_id IS NULL)
    OR (component_kind = 'finished_style' AND component_item_id IS NOT NULL AND part_id IS NULL AND service_item_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS mfg_bom_components_bom_idx ON mfg_bom_components(bom_id);

-- RLS — anon_all + auth_internal.
ALTER TABLE mfg_bom            ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfg_bom_components ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_mfg_bom" ON mfg_bom;
CREATE POLICY "anon_all_mfg_bom" ON mfg_bom FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_all_mfg_bom_components" ON mfg_bom_components;
CREATE POLICY "anon_all_mfg_bom_components" ON mfg_bom_components FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_mfg_bom" ON mfg_bom;
CREATE POLICY "auth_internal_mfg_bom" ON mfg_bom
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
-- Components inherit scoping via their parent bom (no entity_id column); allow
-- authenticated full access (service-role handlers do the real work).
DROP POLICY IF EXISTS "auth_internal_mfg_bom_components" ON mfg_bom_components;
CREATE POLICY "auth_internal_mfg_bom_components" ON mfg_bom_components
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
