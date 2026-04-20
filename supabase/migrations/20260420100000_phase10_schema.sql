-- 20260420100000_phase10_schema.sql
--
-- Phase 10 — Payments, Dynamic Discounting, Supply Chain Finance,
-- Multi-Currency/FX, Virtual Cards, Tax Compliance, and Early Payment
-- Analytics.
--
-- Conventions (consistent with prior phases):
--   • snake_case table names
--   • internal user references stored as text (app_data['users'])
--   • RLS: anon-permissive + authenticated vendor-filtered where vendors
--     should see their own rows
--   • Additive only — no ALTER/DROP on existing tables
--
-- Security notes:
--   • virtual_cards encrypts PAN + CVV at the application layer; columns
--     are bytea to discourage plaintext writes. The DB NEVER sees the
--     plaintext; encryption uses api/_lib/crypto.js (existing helper).
--   • currency_rates are a time series — always read the latest per
--     (from, to) unless you need a historical snapshot.

-- ══════════════════════════════════════════════════════════════════════════
-- 0. payments (prerequisite — referenced by international_payments)
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  invoice_id      uuid REFERENCES invoices(id) ON DELETE SET NULL,
  vendor_id       uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  amount          numeric(14,2) NOT NULL,
  currency        text NOT NULL DEFAULT 'USD',
  method          text NOT NULL DEFAULT 'ach'
                    CHECK (method IN ('ach', 'wire', 'virtual_card', 'check', 'paypal', 'wise', 'manual')),
  status          text NOT NULL DEFAULT 'initiated'
                    CHECK (status IN ('initiated', 'processing', 'completed', 'failed', 'cancelled')),
  reference       text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  initiated_at    timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_entity  ON payments (entity_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_vendor  ON payments (vendor_id);
CREATE INDEX IF NOT EXISTS idx_payments_status  ON payments (status);

-- ══════════════════════════════════════════════════════════════════════════
-- 1. dynamic_discount_offers
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS dynamic_discount_offers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id             uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  invoice_id            uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  vendor_id             uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  original_due_date     date NOT NULL,
  early_payment_date    date NOT NULL,
  discount_pct          numeric(6,3) NOT NULL CHECK (discount_pct >= 0 AND discount_pct <= 100),
  discount_amount       numeric(14,2) NOT NULL,
  net_payment_amount    numeric(14,2) NOT NULL,
  status                text NOT NULL DEFAULT 'offered'
                          CHECK (status IN ('offered', 'accepted', 'rejected', 'expired', 'paid')),
  offered_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  accepted_at           timestamptz,
  rejected_at           timestamptz,
  paid_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_discount_dates CHECK (early_payment_date <= original_due_date)
);

CREATE INDEX IF NOT EXISTS idx_discount_offers_invoice ON dynamic_discount_offers (invoice_id);
CREATE INDEX IF NOT EXISTS idx_discount_offers_vendor  ON dynamic_discount_offers (vendor_id);
CREATE INDEX IF NOT EXISTS idx_discount_offers_status  ON dynamic_discount_offers (status);
CREATE INDEX IF NOT EXISTS idx_discount_offers_expires ON dynamic_discount_offers (expires_at) WHERE status = 'offered';

-- ══════════════════════════════════════════════════════════════════════════
-- 2. supply_chain_finance_programs + finance_requests
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS supply_chain_finance_programs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id              uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  name                   text NOT NULL,
  funder_name            text NOT NULL,
  max_facility_amount    numeric(14,2) NOT NULL CHECK (max_facility_amount >= 0),
  current_utilization    numeric(14,2) NOT NULL DEFAULT 0 CHECK (current_utilization >= 0),
  base_rate_pct          numeric(6,3) NOT NULL CHECK (base_rate_pct >= 0),
  status                 text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'paused', 'terminated')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scf_programs_entity ON supply_chain_finance_programs (entity_id);
CREATE INDEX IF NOT EXISTS idx_scf_programs_status ON supply_chain_finance_programs (status);

CREATE TABLE IF NOT EXISTS finance_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id           uuid NOT NULL REFERENCES supply_chain_finance_programs(id) ON DELETE RESTRICT,
  invoice_id           uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  vendor_id            uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  requested_amount     numeric(14,2) NOT NULL CHECK (requested_amount > 0),
  approved_amount      numeric(14,2),
  fee_pct              numeric(6,3),
  fee_amount           numeric(14,2),
  net_disbursement     numeric(14,2),
  status               text NOT NULL DEFAULT 'requested'
                         CHECK (status IN ('requested', 'approved', 'funded', 'repaid', 'rejected')),
  rejection_reason     text,
  requested_at         timestamptz NOT NULL DEFAULT now(),
  approved_at          timestamptz,
  funded_at            timestamptz,
  repayment_due_date   date,
  repaid_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finance_requests_program ON finance_requests (program_id);
CREATE INDEX IF NOT EXISTS idx_finance_requests_invoice ON finance_requests (invoice_id);
CREATE INDEX IF NOT EXISTS idx_finance_requests_vendor  ON finance_requests (vendor_id);
CREATE INDEX IF NOT EXISTS idx_finance_requests_status  ON finance_requests (status);
CREATE INDEX IF NOT EXISTS idx_finance_requests_due     ON finance_requests (repayment_due_date) WHERE status IN ('funded');

-- ══════════════════════════════════════════════════════════════════════════
-- 3. currency_rates + vendor_payment_preferences + international_payments
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS currency_rates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_currency    text NOT NULL CHECK (char_length(from_currency) = 3),
  to_currency      text NOT NULL CHECK (char_length(to_currency) = 3),
  rate             numeric(18,8) NOT NULL CHECK (rate > 0),
  source           text NOT NULL CHECK (source IN ('openexchangerates', 'ecb', 'manual')),
  snapshotted_at   timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_currency_pair_distinct CHECK (from_currency <> to_currency)
);

CREATE INDEX IF NOT EXISTS idx_currency_rates_pair     ON currency_rates (from_currency, to_currency, snapshotted_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_currency_rates_pair_ts
  ON currency_rates (from_currency, to_currency, snapshotted_at, source);

CREATE TABLE IF NOT EXISTS vendor_payment_preferences (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id                  uuid NOT NULL UNIQUE REFERENCES vendors(id) ON DELETE CASCADE,
  preferred_currency         text NOT NULL DEFAULT 'USD' CHECK (char_length(preferred_currency) = 3),
  preferred_payment_method   text NOT NULL DEFAULT 'ach'
                               CHECK (preferred_payment_method IN ('ach', 'wire', 'virtual_card', 'check', 'paypal', 'wise')),
  fx_handling                text NOT NULL DEFAULT 'pay_in_usd_vendor_absorbs'
                               CHECK (fx_handling IN ('pay_in_vendor_currency', 'pay_in_usd_vendor_absorbs', 'pay_in_usd_we_absorb')),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS international_payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id       uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  from_currency    text NOT NULL CHECK (char_length(from_currency) = 3),
  to_currency      text NOT NULL CHECK (char_length(to_currency) = 3),
  from_amount      numeric(14,2) NOT NULL CHECK (from_amount > 0),
  to_amount        numeric(14,2) NOT NULL CHECK (to_amount > 0),
  fx_rate          numeric(18,8) NOT NULL CHECK (fx_rate > 0),
  fx_fee_amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (fx_fee_amount >= 0),
  fx_provider      text CHECK (fx_provider IS NULL OR fx_provider IN ('wise', 'currencycloud', 'manual')),
  fx_reference     text,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'converted', 'sent', 'failed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intl_payments_payment ON international_payments (payment_id);
CREATE INDEX IF NOT EXISTS idx_intl_payments_status  ON international_payments (status);

-- ══════════════════════════════════════════════════════════════════════════
-- 4. virtual_cards
-- ══════════════════════════════════════════════════════════════════════════
-- card_number_encrypted / cvv_encrypted are bytea payloads produced by
-- api/_lib/crypto.js. DB never sees plaintext.
CREATE TABLE IF NOT EXISTS virtual_cards (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id              uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  invoice_id             uuid REFERENCES invoices(id) ON DELETE SET NULL,
  vendor_id              uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  card_number_last4      text NOT NULL CHECK (char_length(card_number_last4) = 4),
  card_number_encrypted  bytea NOT NULL,
  cvv_encrypted          bytea NOT NULL,
  expiry_month           integer NOT NULL CHECK (expiry_month BETWEEN 1 AND 12),
  expiry_year            integer NOT NULL CHECK (expiry_year BETWEEN 2026 AND 2099),
  credit_limit           numeric(14,2) NOT NULL CHECK (credit_limit > 0),
  amount_authorized      numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount_authorized >= 0),
  amount_spent           numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount_spent >= 0),
  status                 text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'spent', 'cancelled', 'expired')),
  provider               text NOT NULL CHECK (provider IN ('stripe', 'marqeta', 'railsbank')),
  provider_card_id       text,
  issued_at              timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,
  spent_at               timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_virtual_cards_entity  ON virtual_cards (entity_id);
CREATE INDEX IF NOT EXISTS idx_virtual_cards_invoice ON virtual_cards (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_virtual_cards_vendor  ON virtual_cards (vendor_id);
CREATE INDEX IF NOT EXISTS idx_virtual_cards_status  ON virtual_cards (status);
CREATE INDEX IF NOT EXISTS idx_virtual_cards_expiry  ON virtual_cards (expires_at) WHERE status = 'active';

-- ══════════════════════════════════════════════════════════════════════════
-- 5. tax_rules + tax_calculations + tax_remittances
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tax_rules (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                  uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  jurisdiction               text NOT NULL,
  tax_type                   text NOT NULL CHECK (tax_type IN ('vat', 'gst', 'sales_tax', 'withholding')),
  rate_pct                   numeric(6,3) NOT NULL CHECK (rate_pct >= 0 AND rate_pct <= 100),
  applies_to                 text NOT NULL DEFAULT 'all'
                               CHECK (applies_to IN ('goods', 'services', 'all')),
  threshold_amount           numeric(14,2),
  vendor_type_exemptions     text[] NOT NULL DEFAULT '{}',
  is_active                  boolean NOT NULL DEFAULT true,
  effective_from             date NOT NULL,
  effective_to               date,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_tax_effective_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_tax_rules_entity      ON tax_rules (entity_id);
CREATE INDEX IF NOT EXISTS idx_tax_rules_jurisdiction ON tax_rules (jurisdiction);
CREATE INDEX IF NOT EXISTS idx_tax_rules_active     ON tax_rules (is_active);
CREATE INDEX IF NOT EXISTS idx_tax_rules_effective  ON tax_rules (effective_from, effective_to);

CREATE TABLE IF NOT EXISTS tax_calculations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  jurisdiction      text NOT NULL,
  tax_type          text NOT NULL CHECK (tax_type IN ('vat', 'gst', 'sales_tax', 'withholding')),
  taxable_amount    numeric(14,2) NOT NULL CHECK (taxable_amount >= 0),
  tax_rate_pct      numeric(6,3) NOT NULL CHECK (tax_rate_pct >= 0 AND tax_rate_pct <= 100),
  tax_amount        numeric(14,2) NOT NULL CHECK (tax_amount >= 0),
  rule_id           uuid REFERENCES tax_rules(id) ON DELETE SET NULL,
  calculated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tax_calc_invoice      ON tax_calculations (invoice_id);
CREATE INDEX IF NOT EXISTS idx_tax_calc_jurisdiction ON tax_calculations (jurisdiction);
CREATE INDEX IF NOT EXISTS idx_tax_calc_rule        ON tax_calculations (rule_id) WHERE rule_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tax_remittances (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  jurisdiction             text NOT NULL,
  tax_type                 text NOT NULL CHECK (tax_type IN ('vat', 'gst', 'sales_tax', 'withholding')),
  period_start             date NOT NULL,
  period_end               date NOT NULL,
  total_taxable_amount     numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_taxable_amount >= 0),
  total_tax_amount         numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_tax_amount >= 0),
  status                   text NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'filed', 'paid')),
  filed_at                 timestamptz,
  payment_reference        text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_remit_period CHECK (period_end >= period_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_remit_entity_jurisdiction_period
  ON tax_remittances (entity_id, jurisdiction, tax_type, period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_tax_remit_status ON tax_remittances (status);

-- ══════════════════════════════════════════════════════════════════════════
-- 6. early_payment_analytics
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS early_payment_analytics (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                     uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  period_start                  date NOT NULL,
  period_end                    date NOT NULL,
  total_offers_made             integer NOT NULL DEFAULT 0 CHECK (total_offers_made >= 0),
  total_offers_accepted         integer NOT NULL DEFAULT 0 CHECK (total_offers_accepted >= 0),
  total_discount_captured       numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_discount_captured >= 0),
  total_early_payment_amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_early_payment_amount >= 0),
  avg_discount_pct              numeric(6,3),
  annualized_return_pct         numeric(8,3),
  generated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_epa_period CHECK (period_end >= period_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_epa_entity_period
  ON early_payment_analytics (entity_id, period_start, period_end);

-- ══════════════════════════════════════════════════════════════════════════
-- 7. RLS
-- ══════════════════════════════════════════════════════════════════════════
ALTER TABLE payments                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE dynamic_discount_offers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE supply_chain_finance_programs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_requests                ENABLE ROW LEVEL SECURITY;
ALTER TABLE currency_rates                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_payment_preferences      ENABLE ROW LEVEL SECURITY;
ALTER TABLE international_payments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE virtual_cards                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_rules                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_calculations                ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_remittances                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE early_payment_analytics         ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'payments', 'dynamic_discount_offers', 'supply_chain_finance_programs',
    'finance_requests', 'currency_rates', 'vendor_payment_preferences',
    'international_payments', 'virtual_cards', 'tax_rules', 'tax_calculations',
    'tax_remittances', 'early_payment_analytics'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS "anon_all_%1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "anon_all_%1$s" ON %1$I FOR ALL TO anon USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- Vendor-authenticated reads scoped to own rows
DROP POLICY IF EXISTS "vendor_own_discount_offers" ON dynamic_discount_offers;
CREATE POLICY "vendor_own_discount_offers" ON dynamic_discount_offers
  FOR ALL TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()))
  WITH CHECK (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "vendor_own_finance_requests" ON finance_requests;
CREATE POLICY "vendor_own_finance_requests" ON finance_requests
  FOR ALL TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()))
  WITH CHECK (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "vendor_own_payment_prefs" ON vendor_payment_preferences;
CREATE POLICY "vendor_own_payment_prefs" ON vendor_payment_preferences
  FOR ALL TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()))
  WITH CHECK (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "vendor_own_payments" ON payments;
CREATE POLICY "vendor_own_payments" ON payments
  FOR SELECT TO authenticated
  USING (vendor_id IN (SELECT vu.vendor_id FROM vendor_users vu WHERE vu.auth_id = auth.uid()));

-- currency_rates: any authenticated user may read (public reference data)
DROP POLICY IF EXISTS "currency_rates_read_all" ON currency_rates;
CREATE POLICY "currency_rates_read_all" ON currency_rates
  FOR SELECT TO authenticated USING (true);

-- virtual_cards, tax_rules, tax_calculations, tax_remittances, international_payments,
-- supply_chain_finance_programs, early_payment_analytics: internal-only; no vendor policy.
