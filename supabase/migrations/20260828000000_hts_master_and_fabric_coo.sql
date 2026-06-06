-- HTS (Harmonized Tariff Schedule) master + COO on fabric_codes.

-- 1. Add country_of_origin and hts_code to fabric_codes.
--    country_of_origin_iso2 (char 2) already exists from the P3-11 migration.
--    hts_code (text) already exists from the P3-11 migration.
--    Adding country_of_origin (free-text full name, separate from the ISO-2 field)
--    so operators can store a human-readable COO string alongside the ISO-2 code.
ALTER TABLE fabric_codes
  ADD COLUMN IF NOT EXISTS country_of_origin text;

-- 2. HTS master: operator-managed reference table for HTS codes.
CREATE TABLE IF NOT EXISTS hts_master (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL DEFAULT rof_entity_id(),
  code text NOT NULL,                  -- e.g. "6110.20.2090"
  description text NOT NULL,
  chapter text,                        -- e.g. "61" (Knitted or crocheted clothing)
  heading text,                        -- e.g. "6110"
  duty_rate_pct numeric(6,3),          -- e.g. 16.500
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hts_master_entity_code_unique UNIQUE (entity_id, code)
);
CREATE INDEX IF NOT EXISTS hts_master_entity_id_idx ON hts_master(entity_id);

COMMENT ON TABLE  hts_master IS 'Operator-managed HTS (Harmonized Tariff Schedule) code reference. Used for import classification and duty rate lookup.';
COMMENT ON COLUMN hts_master.code           IS 'HTS code string, e.g. "6110.20.2090". Unique per entity.';
COMMENT ON COLUMN hts_master.description    IS 'Official or operator description of the tariff category.';
COMMENT ON COLUMN hts_master.chapter        IS 'Two-digit chapter, e.g. "61" (Knitted/crocheted clothing articles).';
COMMENT ON COLUMN hts_master.heading        IS 'Four-digit heading, e.g. "6110".';
COMMENT ON COLUMN hts_master.duty_rate_pct  IS 'General duty rate as a percentage (e.g. 16.500 = 16.5%).';

-- Touch trigger
CREATE OR REPLACE FUNCTION hts_master_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hts_master_touch_trg ON hts_master;
CREATE TRIGGER hts_master_touch_trg
  BEFORE UPDATE ON hts_master
  FOR EACH ROW EXECUTE FUNCTION hts_master_touch();

ALTER TABLE hts_master ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_hts_master" ON hts_master
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_internal_hts_master" ON hts_master
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
