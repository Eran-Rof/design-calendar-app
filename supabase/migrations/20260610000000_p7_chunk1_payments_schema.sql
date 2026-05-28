-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P7-1 — Credit-card capture schema (provider-abstracted)
--
-- Implements arch §3 (M16) generic schema. No 'stripe_*'-prefixed columns —
-- every processor (Stripe, Square, Authorize.net, ...) stores token IDs
-- in the same processor-agnostic columns. Per-entity processor selection
-- via entities.default_payment_processor. Per-customer override via
-- customers.payment_processor.
--
-- New GL accounts seeded (only if missing):
--   1110  Payment Processor Clearing  (asset, DEBIT-normal)
--   6510  Merchant Fees               (expense, DEBIT-normal)
--   6610  Chargeback Expense          (expense, DEBIT-normal)
--
-- AR receipts payment_method enum extended with 'credit_card'.
--
-- Provider interface skeleton (api/_lib/payments/provider.js + index.js)
-- ships alongside this migration in the same PR — no DB side to it.
--
-- See docs/tangerine/P7-revenue-ops-architecture.md §3.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. entities default_payment_processor ────────────────────────────────
ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS default_payment_processor text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'entities_default_payment_processor_check'
  ) THEN
    ALTER TABLE entities
      ADD CONSTRAINT entities_default_payment_processor_check
        CHECK (default_payment_processor IS NULL OR default_payment_processor IN ('stripe','square','authnet'));
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN entities.default_payment_processor IS 'P7 M16: per-entity card processor. Customers without their own payment_processor inherit this. Null = no card capture available.';

-- ─── 2. customers payment tokens (processor-agnostic) ─────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS payment_processor             text,
  ADD COLUMN IF NOT EXISTS processor_customer_id         text,
  ADD COLUMN IF NOT EXISTS processor_payment_method_id   text,
  ADD COLUMN IF NOT EXISTS processor_card_brand          text,
  ADD COLUMN IF NOT EXISTS processor_card_last4          text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customers_payment_processor_check'
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT customers_payment_processor_check
        CHECK (payment_processor IS NULL OR payment_processor IN ('stripe','square','authnet'));
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_processor_customer
  ON customers (payment_processor, processor_customer_id)
  WHERE processor_customer_id IS NOT NULL;

COMMENT ON COLUMN customers.payment_processor IS 'P7 M16: card processor for this customer. Null = use entities.default_payment_processor.';
COMMENT ON COLUMN customers.processor_customer_id IS 'P7 M16: opaque customer ID at the processor (Stripe cus_xxx / Square customer_id / Auth.net customerProfileId).';
COMMENT ON COLUMN customers.processor_payment_method_id IS 'P7 M16: opaque saved-card token (Stripe pm_xxx / Square card_id / Auth.net customerPaymentProfileId). The SAQ-A boundary — never store raw PAN.';

-- ─── 3. ar_receipts processor columns + payment_method enum extension ─────
ALTER TABLE ar_receipts
  ADD COLUMN IF NOT EXISTS payment_processor      text,
  ADD COLUMN IF NOT EXISTS processor_intent_id    text,
  ADD COLUMN IF NOT EXISTS processor_charge_id    text,
  ADD COLUMN IF NOT EXISTS processor_fee_cents    bigint,
  ADD COLUMN IF NOT EXISTS processor_status       text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ar_receipts_payment_processor_check'
  ) THEN
    ALTER TABLE ar_receipts
      ADD CONSTRAINT ar_receipts_payment_processor_check
        CHECK (payment_processor IS NULL OR payment_processor IN ('stripe','square','authnet'));
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ar_receipts_processor_status_check'
  ) THEN
    ALTER TABLE ar_receipts
      ADD CONSTRAINT ar_receipts_processor_status_check
        CHECK (processor_status IS NULL OR processor_status IN
          ('requires_action','succeeded','failed','refunded','partial_refunded','chargeback'));
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Extend payment_method enum to include 'credit_card'. The CHECK is
-- recreated additively — existing rows in the legacy set still pass.
ALTER TABLE ar_receipts
  DROP CONSTRAINT IF EXISTS ar_receipts_payment_method_check;

ALTER TABLE ar_receipts
  ADD CONSTRAINT ar_receipts_payment_method_check
    CHECK (payment_method IN ('check','wire','ach','cash','credit_card','other'));

CREATE INDEX IF NOT EXISTS idx_ar_receipts_processor_charge
  ON ar_receipts (processor_charge_id)
  WHERE processor_charge_id IS NOT NULL;

COMMENT ON COLUMN ar_receipts.processor_charge_id IS 'P7 M16: opaque charge ID at the processor. Used by P6 bank-recon match engine to reconcile processor-clearing → bank-account when the payout lands.';

-- ─── 4. Seed new GL accounts (idempotent — only if missing) ───────────────
--
-- 1110  Payment Processor Clearing  (asset, DEBIT-normal)
-- 6510  Merchant Fees               (expense, DEBIT-normal)
-- 6610  Chargeback Expense          (expense, DEBIT-normal)
--
-- We resolve entity_id via the canonical ROF entity (code='ROF') for the
-- initial single-tenant seed. Future tenants seed their own via the
-- standard COA-bootstrap path (P3).

DO $$
DECLARE
  v_rof uuid;
BEGIN
  SELECT id INTO v_rof FROM entities WHERE code = 'ROF';
  IF v_rof IS NULL THEN
    RAISE NOTICE 'ROF entity not found — skipping P7-1 GL account seed; rerun once entity exists';
    RETURN;
  END IF;

  -- 1110 Payment Processor Clearing
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, is_active)
    VALUES (v_rof, '1110', 'Payment Processor Clearing', 'asset', 'DEBIT', true, true)
    ON CONFLICT (entity_id, code) DO NOTHING;

  -- 6510 Merchant Fees
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, is_active)
    VALUES (v_rof, '6510', 'Merchant Fees', 'expense', 'DEBIT', true, true)
    ON CONFLICT (entity_id, code) DO NOTHING;

  -- 6610 Chargeback Expense
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, is_active)
    VALUES (v_rof, '6610', 'Chargeback Expense', 'expense', 'DEBIT', true, true)
    ON CONFLICT (entity_id, code) DO NOTHING;
END $$;

-- ─── 5. PostgREST schema cache reload ─────────────────────────────────────
NOTIFY pgrst, 'reload schema';
