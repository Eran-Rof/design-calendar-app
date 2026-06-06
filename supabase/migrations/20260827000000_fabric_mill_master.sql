-- Fabric Mill Master: tracks fabric mills (manufacturers/suppliers of fabric).
CREATE TABLE IF NOT EXISTS fabric_mill_master (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL DEFAULT rof_entity_id(),
  code text NOT NULL,
  name text NOT NULL,
  country_code text,
  contact_name text,
  contact_email text,
  website text,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fabric_mill_master_entity_code_unique UNIQUE (entity_id, code)
);
CREATE INDEX IF NOT EXISTS fabric_mill_master_entity_id_idx ON fabric_mill_master(entity_id);
