-- P25 — Finance batch: Fixed Assets (M21) + Budgets (M22).
-- (1099 = M20 is a report only, no schema. Sales Tax M19 + Public API M15 deferred.)

-- ── M21 Fixed Assets ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fixed_assets (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  asset_code                  text,                        -- FA-NNNN (operator or auto)
  name                        text NOT NULL,
  category                    text,
  acquisition_date            date NOT NULL,
  acquisition_cost_cents      bigint NOT NULL CHECK (acquisition_cost_cents >= 0),
  salvage_value_cents         bigint NOT NULL DEFAULT 0 CHECK (salvage_value_cents >= 0),
  useful_life_months          int  NOT NULL CHECK (useful_life_months > 0),
  method                      text NOT NULL DEFAULT 'straight_line' CHECK (method IN ('straight_line')),
  depreciation_start          date,                        -- defaults to acquisition_date
  accumulated_depreciation_cents bigint NOT NULL DEFAULT 0,
  status                      text NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active','fully_depreciated','disposed')),
  disposed_date               date,
  disposal_proceeds_cents     bigint,
  asset_account_id            uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  accum_deprec_account_id     uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  deprec_expense_account_id   uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  notes                       text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  created_by_user_id          uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fixed_assets_code ON fixed_assets(entity_id, asset_code) WHERE asset_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_fixed_assets_status ON fixed_assets(entity_id, status);

-- One row per posted/recorded depreciation period (the schedule as it's run).
CREATE TABLE IF NOT EXISTS fixed_asset_depreciation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixed_asset_id   uuid NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
  period_date      date NOT NULL,                         -- the period this depreciation belongs to (month-end)
  amount_cents     bigint NOT NULL CHECK (amount_cents >= 0),
  posted_je_id     uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fa_deprec_period ON fixed_asset_depreciation(fixed_asset_id, period_date);

-- ── M22 Budgets ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gl_budgets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  gl_account_id   uuid NOT NULL REFERENCES gl_accounts(id) ON DELETE CASCADE,
  fiscal_year     int  NOT NULL,
  period_number   int  NOT NULL DEFAULT 0 CHECK (period_number BETWEEN 0 AND 12),  -- 0 = full-year
  amount_cents    bigint NOT NULL DEFAULT 0,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gl_budgets ON gl_budgets(entity_id, gl_account_id, fiscal_year, period_number);

-- RLS — anon read-only, like other tables.
DO $$ BEGIN
  ALTER TABLE fixed_assets ENABLE ROW LEVEL SECURITY;
  ALTER TABLE fixed_asset_depreciation ENABLE ROW LEVEL SECURITY;
  ALTER TABLE gl_budgets ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='fixed_assets' AND policyname='anon_read_fixed_assets') THEN
    CREATE POLICY "anon_read_fixed_assets" ON fixed_assets FOR SELECT TO anon USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='fixed_asset_depreciation' AND policyname='anon_read_fa_deprec') THEN
    CREATE POLICY "anon_read_fa_deprec" ON fixed_asset_depreciation FOR SELECT TO anon USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='gl_budgets' AND policyname='anon_read_gl_budgets') THEN
    CREATE POLICY "anon_read_gl_budgets" ON gl_budgets FOR SELECT TO anon USING (true); END IF;
END $$;

NOTIFY pgrst, 'reload schema';
