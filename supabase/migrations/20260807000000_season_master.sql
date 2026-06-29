-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine — Season Master (season_master)
-- A simple auto-coded master listing the merchandising seasons a style can be
-- assigned to (e.g. FW26, SS27, HOLIDAY26). Mirrors the size_scales master
-- shape (operator item 14 auto-code pattern) minus the ordered `sizes` array —
-- a season is just a named code with a sort order and an active flag.
--
-- Style Master keeps its `season` column as free TEXT storing the chosen season
-- NAME (NOT a FK) so this master is purely additive / backward-compatible: the
-- Style edit modal sources its season dropdown from here but still writes the
-- plain name string.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS season_master (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  code               text NOT NULL,
  name               text NOT NULL,
  sort_order         smallint NOT NULL DEFAULT 0,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT uq_season_master_entity_code UNIQUE (entity_id, code)
);

CREATE INDEX IF NOT EXISTS idx_season_master_entity_active
  ON season_master (entity_id, is_active);

-- Touched timestamp
CREATE OR REPLACE FUNCTION season_master_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS season_master_touch_trg ON season_master;
CREATE TRIGGER season_master_touch_trg
  BEFORE UPDATE ON season_master
  FOR EACH ROW EXECUTE FUNCTION season_master_touch();

ALTER TABLE season_master ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_season_master" ON season_master;
CREATE POLICY "anon_all_season_master" ON season_master
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_season_master" ON season_master;
CREATE POLICY "auth_internal_season_master" ON season_master
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

COMMENT ON TABLE  season_master IS 'Tangerine merchandising season master. One row per season per entity. Style Master stores the chosen season NAME as free text (no FK).';
COMMENT ON COLUMN season_master.code IS 'Server-generated read-only code SEASON-NNNNN. Unique per entity.';
COMMENT ON COLUMN season_master.name IS 'Human season label stored on style_master.season as free text, e.g. FW26.';
