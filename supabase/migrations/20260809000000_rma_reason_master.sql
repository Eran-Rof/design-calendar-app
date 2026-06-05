-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine — RMA Reason Master (rma_reason_master)
-- A simple auto-coded master listing the standard customer-return / RMA reasons
-- a sales return (and its lines) can be tagged with (e.g. Defective, Wrong Item,
-- Damaged in Transit, Customer Remorse). Mirrors the season_master master shape
-- (operator item 14 auto-code pattern): a named code with a sort order and an
-- active flag.
--
-- sales_returns.reason and sales_return_lines.reason stay free TEXT storing the
-- chosen reason NAME (NOT an FK), so this master is purely additive /
-- backward-compatible: the Returns panel sources its reason dropdown from here
-- but still writes the plain name string.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rma_reason_master (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  code               text NOT NULL,
  name               text NOT NULL,
  sort_order         smallint NOT NULL DEFAULT 0,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT uq_rma_reason_master_entity_code UNIQUE (entity_id, code)
);

CREATE INDEX IF NOT EXISTS idx_rma_reason_master_entity_active
  ON rma_reason_master (entity_id, is_active);

-- Touched timestamp
CREATE OR REPLACE FUNCTION rma_reason_master_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rma_reason_master_touch_trg ON rma_reason_master;
CREATE TRIGGER rma_reason_master_touch_trg
  BEFORE UPDATE ON rma_reason_master
  FOR EACH ROW EXECUTE FUNCTION rma_reason_master_touch();

ALTER TABLE rma_reason_master ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_rma_reason_master" ON rma_reason_master;
CREATE POLICY "anon_all_rma_reason_master" ON rma_reason_master
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_rma_reason_master" ON rma_reason_master;
CREATE POLICY "auth_internal_rma_reason_master" ON rma_reason_master
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

COMMENT ON TABLE  rma_reason_master IS 'Tangerine customer-return / RMA reason master. One row per reason per entity. sales_returns.reason and sales_return_lines.reason store the chosen reason NAME as free text (no FK).';
COMMENT ON COLUMN rma_reason_master.code IS 'Server-generated read-only code RMAR-NNNNN. Unique per entity.';
COMMENT ON COLUMN rma_reason_master.name IS 'Human reason label stored on sales_returns.reason / sales_return_lines.reason as free text, e.g. Defective.';
