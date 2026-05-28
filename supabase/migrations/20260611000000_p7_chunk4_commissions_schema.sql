-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P7-4 — Sales Reps & Commissions schema (arch §4)
--
-- Five new tables:
--   1. sales_reps                         — rep master (default %, payout terms, M30 link)
--   2. sales_rep_commission_tiers         — optional bracket overrides per rep
--   3. customer_sales_rep_assignments     — many-to-many: customer × rep × share %
--   4. commission_accruals                — per (invoice, rep) snapshot at invoice-post
--   5. commission_payouts                 — operator-driven batch settlements (per rep × period)
--
-- New GL accounts seeded (only if missing):
--   2300  Commissions Payable             (liability, CREDIT-normal)
--   6210  Sales Commissions Expense       (expense,   DEBIT-normal)
--
-- Operator decisions confirmed (PR #415 §2):
--   D2 ✅ commission base = net revenue (post-discount, pre-tax) at invoice-post
--   D3 ✅ accrue at invoice-post, settle at rep payout
--
-- See docs/tangerine/P7-revenue-ops-architecture.md §4.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. sales_reps ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_reps (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  employee_id              uuid REFERENCES employees(id) ON DELETE SET NULL,
  display_name             text NOT NULL,
  email                    text,
  default_commission_pct   numeric(5,2) NOT NULL DEFAULT 0
                           CHECK (default_commission_pct >= 0 AND default_commission_pct <= 100),
  payout_terms_days        int  NOT NULL DEFAULT 30 CHECK (payout_terms_days >= 0),
  is_active                boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT sales_reps_name_per_entity_unique UNIQUE (entity_id, display_name)
);

CREATE INDEX IF NOT EXISTS idx_sales_reps_entity_active
  ON sales_reps (entity_id, is_active);
CREATE INDEX IF NOT EXISTS idx_sales_reps_employee
  ON sales_reps (employee_id) WHERE employee_id IS NOT NULL;

COMMENT ON TABLE sales_reps IS 'P7 M17: sales reps master. employee_id is nullable for 1099 reps not in employees master.';
COMMENT ON COLUMN sales_reps.default_commission_pct IS 'Default % applied to all commissionable sales when no tier table entry matches. 8.00 = 8%.';
COMMENT ON COLUMN sales_reps.payout_terms_days IS 'Default lag (days) from accrual date to expected payout. Operator can override per payout.';

-- ─── 2. sales_rep_commission_tiers ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_rep_commission_tiers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_rep_id       uuid NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  threshold_cents    bigint NOT NULL CHECK (threshold_cents >= 0),
  rate_pct           numeric(5,2) NOT NULL CHECK (rate_pct >= 0 AND rate_pct <= 100),
  effective_from     date NOT NULL DEFAULT current_date,
  effective_to       date,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tier_threshold_unique UNIQUE (sales_rep_id, threshold_cents, effective_from),
  CONSTRAINT tier_dates_ordered CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_commission_tiers_rep
  ON sales_rep_commission_tiers (sales_rep_id, effective_from);

COMMENT ON TABLE sales_rep_commission_tiers IS 'P7 M17: optional bracket overrides per rep. Empty = sales_reps.default_commission_pct applies to all sales.';
COMMENT ON COLUMN sales_rep_commission_tiers.threshold_cents IS 'Cumulative invoiced amount (per period, post-discount, pre-tax) at which this rate takes effect.';

-- ─── 3. customer_sales_rep_assignments ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_sales_rep_assignments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  sales_rep_id       uuid NOT NULL REFERENCES sales_reps(id) ON DELETE RESTRICT,
  share_pct          numeric(5,2) NOT NULL DEFAULT 100
                     CHECK (share_pct > 0 AND share_pct <= 100),
  effective_from     date NOT NULL DEFAULT current_date,
  effective_to       date,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT assignment_unique UNIQUE (customer_id, sales_rep_id, effective_from),
  CONSTRAINT assignment_dates_ordered CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_csra_customer ON customer_sales_rep_assignments (customer_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_csra_rep      ON customer_sales_rep_assignments (sales_rep_id);

COMMENT ON TABLE customer_sales_rep_assignments IS 'P7 M17: many-to-many customer↔rep with split commission shares. Splits MUST sum to 100% for a given (customer, effective date) — enforced at app layer + by accrual RPC (arch §4.5 edge cases).';

-- ─── 4. commission_accruals ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commission_accruals (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  ar_invoice_id            uuid NOT NULL REFERENCES ar_invoices(id) ON DELETE RESTRICT,
  sales_rep_id             uuid NOT NULL REFERENCES sales_reps(id) ON DELETE RESTRICT,
  commissionable_cents     bigint NOT NULL CHECK (commissionable_cents >= 0),
  rate_pct                 numeric(5,2) NOT NULL CHECK (rate_pct >= 0 AND rate_pct <= 100),
  commission_cents         bigint NOT NULL CHECK (commission_cents >= 0),
  status                   text NOT NULL DEFAULT 'accrued'
                           CHECK (status IN ('accrued','reversed','paid')),
  accrual_je_id            uuid REFERENCES journal_entries(id),
  payout_je_id             uuid REFERENCES journal_entries(id),
  reversal_je_id           uuid REFERENCES journal_entries(id),
  paid_at                  timestamptz,
  reversed_at              timestamptz,
  reversal_reason          text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_accruals_invoice_rep_unique UNIQUE (ar_invoice_id, sales_rep_id)
);

CREATE INDEX IF NOT EXISTS idx_commission_accruals_rep_status
  ON commission_accruals (sales_rep_id, status);
CREATE INDEX IF NOT EXISTS idx_commission_accruals_invoice
  ON commission_accruals (ar_invoice_id);
CREATE INDEX IF NOT EXISTS idx_commission_accruals_unpaid
  ON commission_accruals (entity_id, sales_rep_id) WHERE status = 'accrued';

COMMENT ON TABLE commission_accruals IS 'P7 M17: per (invoice × rep) accrual snapshot. status accrued→paid on settle; accrued→reversed on AR void/credit memo.';
COMMENT ON COLUMN commission_accruals.commissionable_cents IS 'Net invoice amount post-discount, pre-tax (D2 confirmed). For split assignments, this is share_pct × invoice net.';

-- ─── 5. commission_payouts ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commission_payouts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  sales_rep_id        uuid NOT NULL REFERENCES sales_reps(id) ON DELETE RESTRICT,
  period_id           uuid NOT NULL REFERENCES gl_periods(id) ON DELETE RESTRICT,
  total_cents         bigint NOT NULL CHECK (total_cents >= 0),
  payment_method      text NOT NULL CHECK (payment_method IN ('check','wire','ach','cash','other')),
  paid_at             date NOT NULL,
  payout_je_id        uuid REFERENCES journal_entries(id),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT commission_payouts_rep_period_unique UNIQUE (sales_rep_id, period_id)
);

CREATE INDEX IF NOT EXISTS idx_commission_payouts_period
  ON commission_payouts (entity_id, period_id);

COMMENT ON TABLE commission_payouts IS 'P7 M17: settlement batch per (rep, period). Posts DR 2300 / CR Cash JE on insert via P7-5 RPC.';

-- ─── 6. RLS template (anon read filtered by entity / auth write) ───────────
ALTER TABLE sales_reps                         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_rep_commission_tiers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_sales_rep_assignments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_accruals                ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_payouts                 ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_all_sales_reps' AND tablename = 'sales_reps') THEN
    CREATE POLICY anon_all_sales_reps                     ON sales_reps                     FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_all_commission_tiers' AND tablename = 'sales_rep_commission_tiers') THEN
    CREATE POLICY anon_all_commission_tiers               ON sales_rep_commission_tiers     FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_all_csra' AND tablename = 'customer_sales_rep_assignments') THEN
    CREATE POLICY anon_all_csra                           ON customer_sales_rep_assignments FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_all_commission_accruals' AND tablename = 'commission_accruals') THEN
    CREATE POLICY anon_all_commission_accruals            ON commission_accruals            FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_all_commission_payouts' AND tablename = 'commission_payouts') THEN
    CREATE POLICY anon_all_commission_payouts             ON commission_payouts             FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ─── 7. Seed new GL accounts (idempotent — only if missing) ───────────────
DO $$
DECLARE
  v_rof uuid;
BEGIN
  SELECT id INTO v_rof FROM entities WHERE code = 'ROF';
  IF v_rof IS NULL THEN
    RAISE NOTICE 'ROF entity not found — skipping P7-4 GL account seed; rerun once entity exists';
    RETURN;
  END IF;

  -- 2300 Commissions Payable (liability, CREDIT-normal)
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, is_active)
    VALUES (v_rof, '2300', 'Commissions Payable', 'liability', 'CREDIT', true, true)
    ON CONFLICT (entity_id, code) DO NOTHING;

  -- 6210 Sales Commissions Expense (expense, DEBIT-normal)
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, is_active)
    VALUES (v_rof, '6210', 'Sales Commissions Expense', 'expense', 'DEBIT', true, true)
    ON CONFLICT (entity_id, code) DO NOTHING;
END $$;

-- ─── 8. PostgREST schema cache reload ─────────────────────────────────────
NOTIFY pgrst, 'reload schema';
