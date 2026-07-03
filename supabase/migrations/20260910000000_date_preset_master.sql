-- Date Presets master — user-extendable quick date-range presets (operator).
--
-- The built-in presets (MTD, YTD, Last 30d, …) live in code
-- (src/tanda/components/dateRangeMath.ts DEFAULT_PRESETS). This table holds
-- ADDITIONAL presets the operator defines; the date-range presets selector
-- merges built-ins + these active rows. Each row is a relative expression
-- (a `kind`, plus `n` for the last-N-days family) so it recomputes against
-- "today" every time — never a stored absolute range.

CREATE TABLE IF NOT EXISTS date_preset_master (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id),
  label              text NOT NULL,
  -- Relative expression. One of:
  --   last_n_days | last_n_months | mtd | ytd | this_year | last_year |
  --   this_month | last_month | this_quarter | last_quarter | ty_to_last_month | today | yesterday
  kind               text NOT NULL,
  -- N for the last_n_days / last_n_months families (else NULL).
  n                  integer,
  sort_order         smallint NOT NULL DEFAULT 0,
  is_active          boolean NOT NULL DEFAULT true,
  created_by_user_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_date_preset_master_entity_active
  ON date_preset_master (entity_id, is_active, sort_order);

ALTER TABLE date_preset_master ENABLE ROW LEVEL SECURITY;
-- Anon read (the presets selector loads them client-side via /api/internal);
-- writes go through the service-role internal endpoint. Mirrors other masters.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'date_preset_master' AND policyname = 'date_preset_master_anon_read') THEN
    CREATE POLICY date_preset_master_anon_read ON date_preset_master FOR SELECT USING (true);
  END IF;
END $$;

COMMENT ON TABLE date_preset_master IS 'Operator-defined additional date-range presets (relative expressions). Merged with code DEFAULT_PRESETS by the date-range presets selector.';
COMMENT ON COLUMN date_preset_master.kind IS 'Relative expression: last_n_days|last_n_months|mtd|ytd|this_year|last_year|this_month|last_month|this_quarter|last_quarter|ty_to_last_month|today|yesterday.';
COMMENT ON COLUMN date_preset_master.n IS 'N for last_n_days / last_n_months (else NULL).';
