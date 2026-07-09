-- AP bill-history backfill: staging table for the Xoro Bills register export
-- (Bills_07082026.csv — 3,680 bills, ALL bills paid+open, 2023-10 → 2026-07).
--
-- Flow (scripts/import-bills-register.mjs + scripts/post-bills-register.mjs):
--   CSV → this staging table → vendors resolved → invoices upserted
--   (source 'xoro_bills_register', frozen from the nightly Xoro sync) →
--   per-bill accrual JE (DR 1201 / vendor-default expense / 8007, CR 2000
--   vendor-subledgered) → relief JE (discounts+vendor credits → 5005,
--   prepayments applied → 1308) → payment JEs from ap_payment_import →
--   per-vendor residual adjustments (8002) → AP 2000 ties to the register.
--
-- RLS posture matches the other financial tables (migration 20260964000000):
-- RLS enabled, NO anon policies — service-role/internal handlers only.

CREATE TABLE IF NOT EXISTS ap_bill_register_import (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_number           text NOT NULL UNIQUE,
  vendor_bill_number    text,
  receipt_date          date,
  bill_date             date NOT NULL,
  due_date              date,
  discount_date         date,
  payment_term          text,
  vendor_name           text NOT NULL,
  vendor_type           text,
  store                 text,
  status                text NOT NULL,          -- Paid | Open | Partially Paid
  total_cents           bigint NOT NULL DEFAULT 0,
  paid_cents            bigint NOT NULL DEFAULT 0,
  discounts_cents       bigint NOT NULL DEFAULT 0,
  due_cents             bigint NOT NULL DEFAULT 0,
  credits_cents         bigint NOT NULL DEFAULT 0,  -- Total Credits Applied = vendor credits + prepayments
  vendor_credits_cents  bigint NOT NULL DEFAULT 0,
  prepayments_cents     bigint NOT NULL DEFAULT 0,
  payment_amount_cents  bigint NOT NULL DEFAULT 0,
  total_qty             numeric,
  created_datetime      timestamptz,
  created_by            text,
  modified_date         date,
  modified_by           text,
  buyer_name            text,
  -- resolution / posting state (filled by the scripts; JE idempotency is the
  -- (source_table, source_id, basis) unique index on journal_entries)
  vendor_id             uuid REFERENCES vendors(id),
  invoice_id            uuid REFERENCES invoices(id),
  accrual_je_id         uuid REFERENCES journal_entries(id),
  relief_je_id          uuid REFERENCES journal_entries(id),
  skip_reason           text,                   -- e.g. 'zero_total', 'already_posted_1662'
  imported_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_apbri_vendor ON ap_bill_register_import(vendor_id);
CREATE INDEX IF NOT EXISTS idx_apbri_status ON ap_bill_register_import(status);

ALTER TABLE ap_bill_register_import ENABLE ROW LEVEL SECURITY;
-- no policies: service-role only, like the other financial tables.

COMMENT ON TABLE ap_bill_register_import IS
  'Staging for the Xoro Bills register export (AP history backfill). One row per bill; accrual/relief JE ids recorded here. Identity: total = paid + discounts + credits + due, credits = vendor_credits + prepayments.';

-- invoices.source gains 'xoro_bills_register': register-backfilled bills are
-- FROZEN from the nightly Xoro AP sync (sync-bills skips rows whose source is
-- neither xoro_mirror nor xoro_ap), so the AP subledger stays exactly what the
-- register said as of the export — which is what the posted GL history ties to.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_source_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_source_check CHECK ((source = ANY (ARRAY[
  'manual'::text, 'xoro_mirror'::text, 'xoro_ap'::text, 'xoro_bills_register'::text,
  'shopify'::text, 'fba'::text, 'walmart'::text, 'faire'::text,
  'edi_3pl'::text, 'plaid_sync'::text, 'api'::text, 'system'::text])));

-- 1308 Vendor Prepayments & Deposits: asset that carries supplier deposits /
-- prepayments made before a bill exists. Payment JEs debit it for the
-- unapplied slice (Amount − Paid Amount); bill relief JEs credit it when the
-- register shows Prepayments Applied. Child of 1300 Deposits & Prepaid
-- Expenses (the COA has TWO code-1300 headers — parent is the Deposits one).
INSERT INTO gl_accounts (code, name, account_type, normal_balance, is_postable, status, parent_account_id, description)
SELECT '1308', 'Vendor Prepayments & Deposits', 'asset', 'DEBIT', true, 'active',
       (SELECT id FROM gl_accounts WHERE code = '1300' AND name ILIKE 'Deposits%' LIMIT 1),
       'Supplier deposits/prepayments not yet applied to bills (AP history backfill, Bills register 2026-07-08)'
WHERE NOT EXISTS (SELECT 1 FROM gl_accounts WHERE code = '1308');
