-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine — Non-factor Sales-Order credit ship-gates
--
-- Adds TWO new SO ship-gates for NON-factored customers (the existing factored-
-- customer factor_approval_status gate is UNCHANGED and owns factored customers):
--
--   1. House-account gate (customer on net/credit terms, NOT factored): activates
--      when the customer has ANY open AR invoice past its due_date (outstanding
--      balance > 0 AND due_date < today). Capture-but-hold: the SO still saves but
--      its credit_approval_status flips to 'on_hold' and it cannot allocate/ship
--      until the overdue AR is cleared OR an operator manually approves/overrides.
--
--   2. Credit-card gate (SO payment_terms.code = 'CREDIT_CARD'): the order cannot
--      ship until payment in full is recorded (amount_paid_cents >= total_cents).
--
-- Processor integration (Stripe/etc.) is DEFERRED — the credit-card gate is
-- satisfied today by an operator MANUALLY recording a payment (the record-payment
-- endpoint increments amount_paid_cents). The columns below leave a clean seam for
-- a future hosted-payment/webhook flow (paid_in_full_at, credit_approval_source).
--
-- Idempotent throughout: ADD COLUMN IF NOT EXISTS, guarded constraints via DO $$,
-- ON CONFLICT DO NOTHING seed. Ends with a PostgREST schema reload.
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1. sales_orders — credit-gate columns
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS credit_approval_status      text NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS credit_hold_reason          text,
  ADD COLUMN IF NOT EXISTS credit_checked_at           timestamptz,
  ADD COLUMN IF NOT EXISTS credit_approval_source      text,
  ADD COLUMN IF NOT EXISTS credit_approved_by_user_id  uuid,
  ADD COLUMN IF NOT EXISTS amount_paid_cents           bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_in_full_at             timestamptz;

-- CHECK on credit_approval_status (drop-then-create for idempotent re-runs).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'sales_orders'
      AND constraint_name = 'sales_orders_credit_approval_status_check'
  ) THEN
    ALTER TABLE sales_orders DROP CONSTRAINT sales_orders_credit_approval_status_check;
  END IF;
  ALTER TABLE sales_orders
    ADD CONSTRAINT sales_orders_credit_approval_status_check
      CHECK (credit_approval_status IN ('not_required','pending','on_hold','approved','declined'));
END $$;

-- CHECK on credit_approval_source (nullable; constrained when set).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'sales_orders'
      AND constraint_name = 'sales_orders_credit_approval_source_check'
  ) THEN
    ALTER TABLE sales_orders DROP CONSTRAINT sales_orders_credit_approval_source_check;
  END IF;
  ALTER TABLE sales_orders
    ADD CONSTRAINT sales_orders_credit_approval_source_check
      CHECK (credit_approval_source IS NULL OR credit_approval_source IN ('manual','auto','payment'));
END $$;

-- Guard amount_paid_cents non-negative (defensive; the record-payment endpoint
-- only ever increments by a positive amount).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'sales_orders'
      AND constraint_name = 'sales_orders_amount_paid_cents_nonneg'
  ) THEN
    ALTER TABLE sales_orders DROP CONSTRAINT sales_orders_amount_paid_cents_nonneg;
  END IF;
  ALTER TABLE sales_orders
    ADD CONSTRAINT sales_orders_amount_paid_cents_nonneg
      CHECK (amount_paid_cents >= 0);
END $$;

COMMENT ON COLUMN sales_orders.credit_approval_status     IS 'Non-factor credit ship-gate state. not_required = no gate applies (cash/COD or no overdue AR). pending = CREDIT_CARD term, not yet paid in full. on_hold = house-account customer with overdue AR; blocked from allocate/ship. approved = operator override or auto-cleared (paid in full). declined = operator hard-stop. The factored-customer gate uses the separate factor_approval_status column and is unaffected.';
COMMENT ON COLUMN sales_orders.credit_hold_reason         IS 'Human-readable reason the SO is on_hold/pending (e.g. "2 overdue AR invoice(s), oldest due 2026-03-01" or "credit-card payment not recorded").';
COMMENT ON COLUMN sales_orders.credit_checked_at          IS 'When the credit gate was last evaluated (set at confirm and on ship attempts).';
COMMENT ON COLUMN sales_orders.credit_approval_source     IS 'How credit_approval_status reached approved: manual (operator override), auto (system), or payment (paid in full on a CREDIT_CARD-term SO).';
COMMENT ON COLUMN sales_orders.credit_approved_by_user_id IS 'auth.users id of the operator who manually overrode/approved the credit hold. NULL for auto/payment sources.';
COMMENT ON COLUMN sales_orders.amount_paid_cents          IS 'Total payment recorded against this SO in cents (manual record-payment now; hosted-payment/webhook later). Drives the CREDIT_CARD paid-in-full ship-gate. NOT the same as AR receipts (which clear the downstream AR invoice).';
COMMENT ON COLUMN sales_orders.paid_in_full_at            IS 'Set when amount_paid_cents first reaches total_cents.';

-- Partial index to find SOs parked on a credit hold quickly.
CREATE INDEX IF NOT EXISTS idx_sales_orders_credit_hold
  ON sales_orders (entity_id, credit_approval_status)
  WHERE credit_approval_status IN ('on_hold','pending');

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Seed the CREDIT_CARD payment term for the ROF entity.
--    Mirrors the 20260527100000 payment_terms seed pattern (per-entity, code
--    UNIQUE). due_days = 0 (payment is due immediately / pre-ship).
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_entity_id uuid;
BEGIN
  SELECT id INTO v_entity_id FROM entities WHERE code = 'ROF' LIMIT 1;
  IF v_entity_id IS NULL THEN
    RAISE NOTICE 'CREDIT_CARD payment_terms seed: ROF entity not found; skipping.';
    RETURN;
  END IF;

  INSERT INTO payment_terms (entity_id, code, name, due_days, discount_pct, discount_days)
  VALUES (v_entity_id, 'CREDIT_CARD', 'Credit Card', 0, 0, 0)
  ON CONFLICT (entity_id, code) DO NOTHING;

  RAISE NOTICE 'CREDIT_CARD payment_terms seed: ensured for ROF entity (%)', v_entity_id;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Migration-tracking record-keeping (defensive DO $$ guard).
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'supabase_migrations'
      AND table_name   = 'schema_migrations'
  ) THEN
    INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
    VALUES ('20260901000000', 'so_credit_gates', ARRAY[]::text[])
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
