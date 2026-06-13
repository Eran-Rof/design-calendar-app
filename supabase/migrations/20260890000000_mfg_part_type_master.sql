-- Manufacturing — Part Type Master.
--
-- Promotes part_master.part_type from a hardcoded enum to an operator-managed
-- master, so new part types can be added without a code change. part_master
-- still stores the type's CODE (text); the CHECK that limited it to the 6
-- original values is dropped so master-driven types are accepted.
CREATE TABLE IF NOT EXISTS part_type_master (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL DEFAULT rof_entity_id(),
  code text NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT part_type_master_entity_code_unique UNIQUE (entity_id, code)
);
CREATE INDEX IF NOT EXISTS part_type_master_entity_id_idx ON part_type_master(entity_id);

-- Seed the 6 original types (codes match existing part_master.part_type values).
DO $$
DECLARE v_rof uuid;
BEGIN
  SELECT id INTO v_rof FROM entities WHERE code = 'ROF';
  IF v_rof IS NULL THEN
    RAISE NOTICE 'part_type_master seed: ROF entity not found — skipping';
    RETURN;
  END IF;
  INSERT INTO part_type_master (entity_id, code, name, sort_order) VALUES
    (v_rof, 'blank_garment', 'Blank garment', 1),
    (v_rof, 'label',         'Label',         2),
    (v_rof, 'trim',          'Trim',          3),
    (v_rof, 'packaging',     'Packaging',     4),
    (v_rof, 'fabric',        'Fabric',        5),
    (v_rof, 'generic',       'Generic',       6)
  ON CONFLICT (entity_id, code) DO NOTHING;
END;
$$;

-- Relax part_master.part_type so master-driven types are accepted (was an
-- inline CHECK limiting it to the 6 seed values).
ALTER TABLE part_master DROP CONSTRAINT IF EXISTS part_master_part_type_check;
