-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P4 / Chunk 1 / Migration
-- M4 Accounts Receivable — schema foundation (sibling tables, NOT polymorphic
-- reuse of `invoices`).
--
-- Per docs/tangerine/P4-ar-architecture.md §3 + §6 + §10.
--
-- Scope:
--   1. ar_invoices             — customer invoices (mirror of AP shape, DR/CR flipped)
--   2. ar_invoice_lines        — invoice line items + FIFO COGS hooks
--   3. ar_receipts             — customer payment events
--   4. ar_receipt_applications — junction (one receipt → many invoices)
--   5. customers extensions    — credit_limit_cents + credit_limit_currency
--                                + default_ar_account_id + default_revenue_account_id
--   6. entities extensions     — default_ar/revenue/cogs/inventory account FKs
--   7. inventory_layers.source_kind expanded with 'customer_return'
--   8. Views/funcs:
--        - v_cash_receipts_journal       (cash journal view)
--        - v_ar_unapplied_receipts       (unapplied receipt balances)
--        - v_ar_aging                    (foundation aging view — paid<total)
--        - ar_aging_as_of(uuid, date)    (parameterized aging function)
--   9. journal_entry_post_guards extension — bypass period 'closed' check when
--      journal_type IN ('ar_invoice_historical','ar_receipt_historical',
--                       'ap_invoice_historical'). TRIGGER-side locked; no UI
--      path can set those journal_types — backfill RPC only.
--  10. ar_invoices total/paid/status maintainer + over-application guard
--      triggers.
--
-- Idempotent throughout (CREATE ... IF NOT EXISTS, DO $$ guards, drop-then-
-- create on CHECK constraints).
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1. entities extensions — default AR / revenue / COGS / inventory accounts
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS default_ar_account_id        uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_revenue_account_id   uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_cogs_account_id      uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_inventory_account_id uuid REFERENCES gl_accounts(id) ON DELETE SET NULL;

COMMENT ON COLUMN entities.default_ar_account_id        IS 'Soft default for AR control account (debit at AR invoice send). Looked up by code 1200. Per-invoice overridable.';
COMMENT ON COLUMN entities.default_revenue_account_id   IS 'Soft default for revenue account (credit at AR invoice send). Looked up by code 4000. Per-invoice and per-line overridable.';
COMMENT ON COLUMN entities.default_cogs_account_id      IS 'Soft default for COGS account (debit when FIFO consume runs at AR send). Looked up by code 5000.';
COMMENT ON COLUMN entities.default_inventory_account_id IS 'Soft default for inventory asset account (credit at FIFO consume). Looked up by code 1300.';

-- Best-effort wire-up if the GL code rows already exist. Safe if missing —
-- columns stay NULL until COA seed runs.
UPDATE entities e SET
  default_ar_account_id = COALESCE(
    e.default_ar_account_id,
    (SELECT id FROM gl_accounts ga WHERE ga.entity_id = e.id AND ga.code = '1200' LIMIT 1)
  ),
  default_revenue_account_id = COALESCE(
    e.default_revenue_account_id,
    (SELECT id FROM gl_accounts ga WHERE ga.entity_id = e.id AND ga.code = '4000' LIMIT 1)
  ),
  default_cogs_account_id = COALESCE(
    e.default_cogs_account_id,
    (SELECT id FROM gl_accounts ga WHERE ga.entity_id = e.id AND ga.code = '5000' LIMIT 1)
  ),
  default_inventory_account_id = COALESCE(
    e.default_inventory_account_id,
    (SELECT id FROM gl_accounts ga WHERE ga.entity_id = e.id AND ga.code = '1300' LIMIT 1)
  );

-- ────────────────────────────────────────────────────────────────────────────
-- 2. customers extensions — credit limit + per-customer account overrides
-- ────────────────────────────────────────────────────────────────────────────
-- Note: customers.credit_limit (numeric(14,2)) already exists from
-- ip_customer_master legacy schema. We add credit_limit_cents (bigint) as the
-- canonical column going forward — the legacy numeric col is retained for
-- backward-compat reads.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS credit_limit_cents          bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credit_limit_currency       char(3) NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS default_ar_account_id       uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_revenue_account_id  uuid REFERENCES gl_accounts(id) ON DELETE SET NULL;

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_credit_limit_cents_nonneg;
ALTER TABLE customers
  ADD CONSTRAINT customers_credit_limit_cents_nonneg
    CHECK (credit_limit_cents >= 0);

COMMENT ON COLUMN customers.credit_limit_cents         IS 'Customer credit limit in cents. 0 = no explicit limit set (behaves as 0; operator must set explicitly). Drives the customer_credit_extension approval rule (M27, P2). New writes use this column; the legacy numeric credit_limit is retained for backward-compat display only.';
COMMENT ON COLUMN customers.credit_limit_currency      IS 'Forward-compat only — locked to USD at launch per roadmap §1.';
COMMENT ON COLUMN customers.default_ar_account_id      IS 'Per-customer override of entities.default_ar_account_id. Rare; defaults to entity default at AR invoice insert.';
COMMENT ON COLUMN customers.default_revenue_account_id IS 'Per-customer revenue account routing (e.g. wholesale vs ecom split). Per-invoice overridable.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. inventory_layers.source_kind — add 'customer_return'
--    Needed by P4-2 arCreditMemo rule (return-to-stock lines re-layer at
--    source_kind='customer_return').
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'inventory_layers'
      AND constraint_name = 'inventory_layers_source_kind_check'
  ) THEN
    ALTER TABLE inventory_layers DROP CONSTRAINT inventory_layers_source_kind_check;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'inventory_layers'
  ) THEN
    ALTER TABLE inventory_layers
      ADD CONSTRAINT inventory_layers_source_kind_check
        CHECK (source_kind IN ('ap_invoice','adjustment','opening_balance','transfer_in','customer_return'));
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. ar_invoices — customer invoice header
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ar_invoices (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  customer_id                 uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  invoice_number              text NOT NULL,
  invoice_kind                text NOT NULL DEFAULT 'customer_invoice',
  gl_status                   text NOT NULL DEFAULT 'unposted',
  invoice_date                date NOT NULL,                                   -- legacy parity (= posting_date for new entries)
  posting_date                date NOT NULL,
  due_date                    date,
  payment_terms_id            uuid REFERENCES payment_terms(id) ON DELETE SET NULL,
  revenue_account_id          uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  ar_account_id               uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  cogs_account_id             uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  inventory_asset_account_id  uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  accrual_je_id               uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  cash_je_id                  uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  total_amount_cents          bigint NOT NULL DEFAULT 0,
  paid_amount_cents           bigint NOT NULL DEFAULT 0,
  reverses_invoice_id         uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,
  reversed_by_invoice_id      uuid REFERENCES ar_invoices(id) ON DELETE SET NULL,
  shipment_id                 uuid,                                            -- soft FK to future shipments (P15)
  description                 text,
  notes                       text,
  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  created_by_user_id          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT ar_invoices_entity_number_unique UNIQUE (entity_id, invoice_number)
);

-- CHECK constraints (drop-then-create for idempotent re-runs)
ALTER TABLE ar_invoices DROP CONSTRAINT IF EXISTS ar_invoices_invoice_kind_check;
ALTER TABLE ar_invoices
  ADD CONSTRAINT ar_invoices_invoice_kind_check
    CHECK (invoice_kind IN ('customer_invoice','customer_credit_memo','customer_invoice_historical'));

ALTER TABLE ar_invoices DROP CONSTRAINT IF EXISTS ar_invoices_gl_status_check;
ALTER TABLE ar_invoices
  ADD CONSTRAINT ar_invoices_gl_status_check
    CHECK (gl_status IN ('unposted','draft','pending_approval','sent','posted','posted_historical',
                         'paid','partial_paid','reversed','void'));

ALTER TABLE ar_invoices DROP CONSTRAINT IF EXISTS ar_invoices_amounts_nonneg;
ALTER TABLE ar_invoices
  ADD CONSTRAINT ar_invoices_amounts_nonneg
    CHECK (total_amount_cents >= 0 AND paid_amount_cents >= 0);

COMMENT ON TABLE  ar_invoices                            IS 'Customer invoices (sibling to legacy `invoices` which is vendor-only). Per docs/tangerine/P4-ar-architecture.md §3.1 — sibling tables NOT polymorphic reuse.';
COMMENT ON COLUMN ar_invoices.invoice_kind               IS 'customer_invoice / customer_credit_memo / customer_invoice_historical (5-year backfill).';
COMMENT ON COLUMN ar_invoices.gl_status                  IS 'GL posting lifecycle. posted_historical is a P4-8 backfill-only terminal state; only the backfill RPC writes it (operator UI cannot).';
COMMENT ON COLUMN ar_invoices.revenue_account_id         IS 'Default revenue account to credit at send. Overridable per ar_invoice_lines.revenue_account_id.';
COMMENT ON COLUMN ar_invoices.ar_account_id              IS 'AR control account to debit at send. Defaults to entities.default_ar_account_id at insert.';
COMMENT ON COLUMN ar_invoices.cogs_account_id            IS 'COGS account to debit when FIFO consume runs (per inventory_item_id line). Defaults to entities.default_cogs_account_id.';
COMMENT ON COLUMN ar_invoices.inventory_asset_account_id IS 'Inventory asset account to credit on FIFO consume (offset of cogs debit). Defaults to entities.default_inventory_account_id.';
COMMENT ON COLUMN ar_invoices.accrual_je_id              IS 'Accrual-basis JE pointer, set at send.';
COMMENT ON COLUMN ar_invoices.cash_je_id                 IS 'Cash-basis JE pointer, set on receipt (deferred cash basis).';
COMMENT ON COLUMN ar_invoices.total_amount_cents         IS 'SUM of ar_invoice_lines.line_total_cents. Trigger-maintained.';
COMMENT ON COLUMN ar_invoices.paid_amount_cents          IS 'SUM of ar_receipt_applications.amount_applied_cents pointing at this invoice. Trigger-maintained.';
COMMENT ON COLUMN ar_invoices.shipment_id                IS 'Soft FK to future shipments table (P15). NULL until SO entry lands.';

-- Indexes per arch §3.2
CREATE INDEX IF NOT EXISTS idx_ar_invoices_entity_pending_approval
  ON ar_invoices (entity_id, gl_status)
  WHERE gl_status = 'pending_approval';

CREATE INDEX IF NOT EXISTS idx_ar_invoices_due_date_unpaid
  ON ar_invoices (due_date)
  WHERE paid_amount_cents < total_amount_cents;

CREATE INDEX IF NOT EXISTS idx_ar_invoices_entity_posting_date
  ON ar_invoices (entity_id, posting_date DESC);

CREATE INDEX IF NOT EXISTS idx_ar_invoices_customer
  ON ar_invoices (customer_id);

CREATE INDEX IF NOT EXISTS idx_ar_invoices_entity_gl_status
  ON ar_invoices (entity_id, gl_status);

CREATE INDEX IF NOT EXISTS idx_ar_invoices_historical
  ON ar_invoices (invoice_kind)
  WHERE invoice_kind = 'customer_invoice_historical';

-- ────────────────────────────────────────────────────────────────────────────
-- 5. ar_invoice_lines — invoice line items
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ar_invoice_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ar_invoice_id       uuid NOT NULL REFERENCES ar_invoices(id) ON DELETE CASCADE,
  line_number         integer NOT NULL,
  description         text,
  revenue_account_id  uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  inventory_item_id   uuid REFERENCES ip_item_master(id) ON DELETE SET NULL,
  quantity            numeric(18,4),
  unit_price_cents    bigint,
  line_total_cents    bigint NOT NULL DEFAULT 0,
  tax_amount_cents    bigint NOT NULL DEFAULT 0,
  cogs_cents          bigint,                                  -- populated by FIFO consume at send
  cogs_resolved_at    timestamptz,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT ar_invoice_lines_invoice_linenum_unique UNIQUE (ar_invoice_id, line_number)
);

ALTER TABLE ar_invoice_lines DROP CONSTRAINT IF EXISTS ar_invoice_lines_amounts_nonneg;
ALTER TABLE ar_invoice_lines
  ADD CONSTRAINT ar_invoice_lines_amounts_nonneg
    CHECK (line_total_cents >= 0 AND tax_amount_cents >= 0);

COMMENT ON TABLE  ar_invoice_lines                  IS 'Lines of an ar_invoices header. line_total_cents is maintained by trigger from quantity * unit_price_cents when both are set; otherwise an explicit value is permitted (used by historical backfill).';
COMMENT ON COLUMN ar_invoice_lines.revenue_account_id IS 'Per-line override of parent ar_invoices.revenue_account_id.';
COMMENT ON COLUMN ar_invoice_lines.inventory_item_id IS 'Drives FIFO consume at send time. NULL for service / non-inventory lines.';
COMMENT ON COLUMN ar_invoice_lines.line_total_cents IS 'Explicit line total in cents. Trigger computes quantity*unit_price_cents when both set; otherwise the value provided at insert is preserved (historical backfill carries raw amount when qty/unit_price are missing).';
COMMENT ON COLUMN ar_invoice_lines.cogs_cents       IS 'COGS amount returned by inventory_fifo_consume() at send time. NULL until sent. Set per line by the posting service (P4-3).';
COMMENT ON COLUMN ar_invoice_lines.tax_amount_cents IS 'Reserved for P25 sales-tax module. Always 0 until tax ships.';

CREATE INDEX IF NOT EXISTS idx_ar_invoice_lines_invoice
  ON ar_invoice_lines (ar_invoice_id);

CREATE INDEX IF NOT EXISTS idx_ar_invoice_lines_inventory_item
  ON ar_invoice_lines (inventory_item_id)
  WHERE inventory_item_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. ar_receipts — customer payment events
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ar_receipts (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  customer_id                 uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  receipt_date                date NOT NULL,
  amount_cents                bigint NOT NULL,
  bank_account_id             uuid NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  customer_payment_method     text NOT NULL,
  reference                   text,
  notes                       text,
  accrual_je_id               uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  cash_je_id                  uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  is_void                     boolean NOT NULL DEFAULT false,
  voided_at                   timestamptz,
  voided_by_user_id           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  void_reason                 text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  created_by_user_id          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT ar_receipts_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT ar_receipts_method_check
    CHECK (customer_payment_method IN ('ach','wire','check','credit_card','cash','paypal','stripe','other'))
);

COMMENT ON TABLE  ar_receipts                          IS 'Customer payment receipts (AR-side analogue of invoice_payments). One receipt may apply to multiple ar_invoices via ar_receipt_applications.';
COMMENT ON COLUMN ar_receipts.bank_account_id          IS 'Destination GL bank/asset account for the cash hit. Defaults to entities.default_bank_account_id in the handler.';
COMMENT ON COLUMN ar_receipts.customer_payment_method  IS 'How the customer paid. paypal/stripe added to the AP-side enum for ecom-side payment channels.';
COMMENT ON COLUMN ar_receipts.accrual_je_id            IS 'Set when the receipt posts (clears AR — DR bank / CR ar_account).';
COMMENT ON COLUMN ar_receipts.cash_je_id               IS 'Set when the cash-basis revenue JE posts. Each receipt posts its own cash JE.';
COMMENT ON COLUMN ar_receipts.is_void                  IS 'Soft-delete flag. Set true by the receipt void handler; original JEs are reversed (not deleted).';

CREATE INDEX IF NOT EXISTS idx_ar_receipts_entity_date
  ON ar_receipts (entity_id, receipt_date DESC);

CREATE INDEX IF NOT EXISTS idx_ar_receipts_customer
  ON ar_receipts (customer_id);

CREATE INDEX IF NOT EXISTS idx_ar_receipts_bank
  ON ar_receipts (bank_account_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 7. ar_receipt_applications — junction (receipt → invoices)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ar_receipt_applications (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ar_receipt_id            uuid NOT NULL REFERENCES ar_receipts(id) ON DELETE CASCADE,
  ar_invoice_id            uuid NOT NULL REFERENCES ar_invoices(id) ON DELETE RESTRICT,
  amount_applied_cents     bigint NOT NULL,
  applied_at               timestamptz NOT NULL DEFAULT now(),
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT ar_receipt_applications_amount_positive CHECK (amount_applied_cents > 0),
  CONSTRAINT ar_receipt_applications_unique_pair UNIQUE (ar_receipt_id, ar_invoice_id)
);

COMMENT ON TABLE  ar_receipt_applications                       IS 'Maps an ar_receipt to one or more ar_invoices it applies to. SUM(amount_applied_cents) per receipt is constrained ≤ receipt.amount_cents by trigger.';
COMMENT ON COLUMN ar_receipt_applications.amount_applied_cents  IS 'Cents applied from this receipt to this invoice. Always > 0.';

CREATE INDEX IF NOT EXISTS idx_ar_receipt_applications_invoice
  ON ar_receipt_applications (ar_invoice_id);

CREATE INDEX IF NOT EXISTS idx_ar_receipt_applications_receipt
  ON ar_receipt_applications (ar_receipt_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 8. RLS — P1 template (anon_all + auth_internal_*)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE ar_invoices              ENABLE ROW LEVEL SECURITY;
ALTER TABLE ar_invoice_lines         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ar_receipts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE ar_receipt_applications  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_ar_invoices" ON ar_invoices;
CREATE POLICY "anon_all_ar_invoices" ON ar_invoices
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_ar_invoices" ON ar_invoices;
CREATE POLICY "auth_internal_ar_invoices" ON ar_invoices
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "anon_all_ar_invoice_lines" ON ar_invoice_lines;
CREATE POLICY "anon_all_ar_invoice_lines" ON ar_invoice_lines
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_ar_invoice_lines" ON ar_invoice_lines;
CREATE POLICY "auth_internal_ar_invoice_lines" ON ar_invoice_lines
  FOR ALL TO authenticated
  USING      (ar_invoice_id IN (SELECT id FROM ar_invoices ai WHERE ai.entity_id IN
                                  (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())))
  WITH CHECK (ar_invoice_id IN (SELECT id FROM ar_invoices ai WHERE ai.entity_id IN
                                  (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())));

DROP POLICY IF EXISTS "anon_all_ar_receipts" ON ar_receipts;
CREATE POLICY "anon_all_ar_receipts" ON ar_receipts
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_ar_receipts" ON ar_receipts;
CREATE POLICY "auth_internal_ar_receipts" ON ar_receipts
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "anon_all_ar_receipt_applications" ON ar_receipt_applications;
CREATE POLICY "anon_all_ar_receipt_applications" ON ar_receipt_applications
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_ar_receipt_applications" ON ar_receipt_applications;
CREATE POLICY "auth_internal_ar_receipt_applications" ON ar_receipt_applications
  FOR ALL TO authenticated
  USING      (ar_receipt_id IN (SELECT id FROM ar_receipts r WHERE r.entity_id IN
                                  (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())))
  WITH CHECK (ar_receipt_id IN (SELECT id FROM ar_receipts r WHERE r.entity_id IN
                                  (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())));

-- ────────────────────────────────────────────────────────────────────────────
-- 9. Touch triggers (updated_at maintenance) — reuses ip_set_updated_at()
-- ────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS ar_invoices_touch_updated_at ON ar_invoices;
CREATE TRIGGER ar_invoices_touch_updated_at
  BEFORE UPDATE ON ar_invoices
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

DROP TRIGGER IF EXISTS ar_invoice_lines_touch_updated_at ON ar_invoice_lines;
CREATE TRIGGER ar_invoice_lines_touch_updated_at
  BEFORE UPDATE ON ar_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

DROP TRIGGER IF EXISTS ar_receipts_touch_updated_at ON ar_receipts;
CREATE TRIGGER ar_receipts_touch_updated_at
  BEFORE UPDATE ON ar_receipts
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

DROP TRIGGER IF EXISTS ar_receipt_applications_touch_updated_at ON ar_receipt_applications;
CREATE TRIGGER ar_receipt_applications_touch_updated_at
  BEFORE UPDATE ON ar_receipt_applications
  FOR EACH ROW EXECUTE FUNCTION ip_set_updated_at();

-- ────────────────────────────────────────────────────────────────────────────
-- 10. ar_invoice_lines BEFORE INSERT/UPDATE — compute line_total_cents
--     If quantity AND unit_price_cents are both set, line_total_cents is
--     computed as quantity*unit_price_cents. If either is null, the inserted
--     value is preserved (allows historical backfill to carry raw amounts).
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ar_invoice_lines_compute_total() RETURNS trigger AS $$
BEGIN
  IF NEW.quantity IS NOT NULL AND NEW.unit_price_cents IS NOT NULL THEN
    NEW.line_total_cents := (NEW.quantity * NEW.unit_price_cents)::bigint;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ar_invoice_lines_compute_total_trg ON ar_invoice_lines;
CREATE TRIGGER ar_invoice_lines_compute_total_trg
  BEFORE INSERT OR UPDATE OF quantity, unit_price_cents, line_total_cents ON ar_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION ar_invoice_lines_compute_total();

-- ────────────────────────────────────────────────────────────────────────────
-- 11. ar_invoice_lines AFTER trigger — maintain ar_invoices.total_amount_cents
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ar_invoice_lines_maintain_total() RETURNS trigger AS $$
DECLARE
  target_invoice_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_invoice_id := OLD.ar_invoice_id;
  ELSE
    target_invoice_id := NEW.ar_invoice_id;
  END IF;

  UPDATE ar_invoices i SET total_amount_cents = COALESCE((
    SELECT SUM(COALESCE(li.line_total_cents, 0))::bigint
           + COALESCE(SUM(li.tax_amount_cents), 0)::bigint
    FROM ar_invoice_lines li
    WHERE li.ar_invoice_id = target_invoice_id
  ), 0)
  WHERE i.id = target_invoice_id;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ar_invoice_lines_total_trg ON ar_invoice_lines;
CREATE TRIGGER ar_invoice_lines_total_trg
  AFTER INSERT OR UPDATE OR DELETE ON ar_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION ar_invoice_lines_maintain_total();

-- ────────────────────────────────────────────────────────────────────────────
-- 12. ar_receipt_applications AFTER trigger — maintain ar_invoices.paid_amount_cents
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ar_receipt_apps_maintain_paid() RETURNS trigger AS $$
DECLARE
  target_invoice_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_invoice_id := OLD.ar_invoice_id;
  ELSE
    target_invoice_id := NEW.ar_invoice_id;
  END IF;

  UPDATE ar_invoices i SET paid_amount_cents = COALESCE((
    SELECT SUM(app.amount_applied_cents)::bigint
    FROM ar_receipt_applications app
    JOIN ar_receipts r ON r.id = app.ar_receipt_id
    WHERE app.ar_invoice_id = target_invoice_id
      AND r.is_void = false
  ), 0)
  WHERE i.id = target_invoice_id;

  -- If a different invoice was touched via UPDATE (e.g. ar_invoice_id moved),
  -- also recompute the OLD invoice's paid total.
  IF TG_OP = 'UPDATE' AND OLD.ar_invoice_id <> NEW.ar_invoice_id THEN
    UPDATE ar_invoices i SET paid_amount_cents = COALESCE((
      SELECT SUM(app.amount_applied_cents)::bigint
      FROM ar_receipt_applications app
      JOIN ar_receipts r ON r.id = app.ar_receipt_id
      WHERE app.ar_invoice_id = OLD.ar_invoice_id
        AND r.is_void = false
    ), 0)
    WHERE i.id = OLD.ar_invoice_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ar_receipt_apps_paid_trg ON ar_receipt_applications;
CREATE TRIGGER ar_receipt_apps_paid_trg
  AFTER INSERT OR UPDATE OR DELETE ON ar_receipt_applications
  FOR EACH ROW EXECUTE FUNCTION ar_receipt_apps_maintain_paid();

-- ────────────────────────────────────────────────────────────────────────────
-- 13. ar_receipt_applications BEFORE — reject over-application
--     SUM(applications.amount_applied_cents) per receipt ≤ receipt.amount_cents.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ar_receipt_apps_overapply_guard() RETURNS trigger AS $$
DECLARE
  receipt_total bigint;
  sum_applied   bigint;
BEGIN
  SELECT amount_cents INTO receipt_total
    FROM ar_receipts WHERE id = NEW.ar_receipt_id;

  IF receipt_total IS NULL THEN
    RAISE EXCEPTION 'ar_receipt_applications: receipt % not found', NEW.ar_receipt_id;
  END IF;

  SELECT COALESCE(SUM(amount_applied_cents), 0)::bigint INTO sum_applied
    FROM ar_receipt_applications
    WHERE ar_receipt_id = NEW.ar_receipt_id
      AND id <> NEW.id;

  IF (sum_applied + NEW.amount_applied_cents) > receipt_total THEN
    RAISE EXCEPTION 'ar_receipt_applications: over-application rejected (applied % + new % > receipt total %)',
      sum_applied, NEW.amount_applied_cents, receipt_total
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ar_receipt_apps_overapply_guard_trg ON ar_receipt_applications;
CREATE TRIGGER ar_receipt_apps_overapply_guard_trg
  BEFORE INSERT OR UPDATE ON ar_receipt_applications
  FOR EACH ROW EXECUTE FUNCTION ar_receipt_apps_overapply_guard();

-- ────────────────────────────────────────────────────────────────────────────
-- 14. ar_invoices BEFORE UPDATE — gl_status flip from paid maintainer
--     When paid_amount_cents changes, flip gl_status sent ↔ partial_paid ↔ paid.
--     Backfilled posted_historical rows are immune (never auto-flipped).
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ar_invoices_status_from_paid() RETURNS trigger AS $$
BEGIN
  -- Only react when paid_amount_cents actually changed.
  IF NEW.paid_amount_cents IS NOT DISTINCT FROM OLD.paid_amount_cents THEN
    RETURN NEW;
  END IF;

  -- posted_historical / void / reversed are terminal; do not auto-flip.
  IF NEW.gl_status IN ('posted_historical','void','reversed','draft','unposted','pending_approval') THEN
    RETURN NEW;
  END IF;

  IF NEW.total_amount_cents > 0 AND NEW.paid_amount_cents >= NEW.total_amount_cents THEN
    NEW.gl_status := 'paid';
  ELSIF NEW.paid_amount_cents > 0 AND NEW.paid_amount_cents < NEW.total_amount_cents THEN
    NEW.gl_status := 'partial_paid';
  ELSIF NEW.paid_amount_cents = 0 AND NEW.gl_status IN ('paid','partial_paid') THEN
    -- All payments withdrawn — fall back to posted/sent.
    NEW.gl_status := CASE WHEN OLD.gl_status IN ('paid','partial_paid') THEN 'sent' ELSE OLD.gl_status END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ar_invoices_status_from_paid_trg ON ar_invoices;
CREATE TRIGGER ar_invoices_status_from_paid_trg
  BEFORE UPDATE OF paid_amount_cents ON ar_invoices
  FOR EACH ROW EXECUTE FUNCTION ar_invoices_status_from_paid();

-- ────────────────────────────────────────────────────────────────────────────
-- 15. journal_entry_post_guards — extend with historical-backfill bypass
--     Per arch §3.8 + §6.2: when journal_type IN
--       ('ar_invoice_historical','ar_receipt_historical','ap_invoice_historical'),
--     the closed-period check is skipped. The journal_type is set by the
--     backfill RPC (P4-8); no operator UI path can set those journal_types,
--     so the bypass is structurally trigger-side locked.
--
--     ap_invoice_historical is included defensively even though P3 doesn't
--     currently emit it — keeps the gate symmetric for any future AP backfill.
--
--     This OR REPLACEs the existing function from
--     20260521020200_p1_journal_entries.sql. All other guard checks (balance,
--     account validity, postable, control-subledger, entity hard-lock) remain.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION journal_entry_post_guards() RETURNS trigger AS $$
DECLARE
  total_d           numeric(18,2);
  total_c           numeric(18,2);
  bad_line          record;
  period            record;
  entity_lock       date;
  v_is_historical   boolean := false;
BEGIN
  -- 1. Balanced: Σ(debit) = Σ(credit)
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO total_d, total_c
  FROM journal_entry_lines WHERE journal_entry_id = NEW.id;

  IF total_d <> total_c THEN
    RAISE EXCEPTION 'Unbalanced journal_entry %: debits=% credits=%',
      NEW.id, total_d, total_c;
  END IF;

  IF total_d = 0 THEN
    RAISE EXCEPTION 'Journal_entry % has no lines or zero totals', NEW.id;
  END IF;

  -- Determine historical-bypass eligibility from NEW.journal_type. ONLY
  -- specific journal_type values qualify — operator UI never sets these
  -- (the AP/AR/JE handlers hardcode different journal_types).
  v_is_historical := NEW.journal_type IN (
    'ar_invoice_historical',
    'ar_receipt_historical',
    'ap_invoice_historical'
  );

  -- 2. Period status: the referenced period must be open, UNLESS this is a
  --    historical-backfill JE (trigger-side locked bypass).
  SELECT status, starts_on INTO period
    FROM gl_periods WHERE id = NEW.period_id;
  IF period.status <> 'open' AND NOT v_is_historical THEN
    RAISE EXCEPTION 'Cannot post journal_entry % into period in status %',
      NEW.id, period.status;
  END IF;

  -- 3. posting_date falls inside the referenced period
  IF NEW.posting_date NOT BETWEEN period.starts_on AND period.starts_on + interval '1 month' - interval '1 day' THEN
    PERFORM 1 FROM gl_periods
      WHERE id = NEW.period_id
        AND NEW.posting_date BETWEEN starts_on AND ends_on;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'posting_date % is outside period % bounds', NEW.posting_date, NEW.period_id;
    END IF;
  END IF;

  -- 4. entities.posting_locked_through hard lock — also bypassable for historical.
  SELECT posting_locked_through INTO entity_lock
    FROM entities WHERE id = NEW.entity_id;
  IF entity_lock IS NOT NULL AND NEW.posting_date <= entity_lock AND NOT v_is_historical THEN
    RAISE EXCEPTION 'posting_date % is on or before entity hard-lock %',
      NEW.posting_date, entity_lock;
  END IF;

  -- 5. Every line's account must belong to the same entity, be active, postable.
  --    Control accounts require subledger.
  FOR bad_line IN
    SELECT jel.id, jel.account_id, a.entity_id AS account_entity, a.status,
           a.is_postable, a.is_control, jel.subledger_type
    FROM journal_entry_lines jel
    JOIN gl_accounts a ON a.id = jel.account_id
    WHERE jel.journal_entry_id = NEW.id
      AND (a.entity_id <> NEW.entity_id
        OR a.status <> 'active'
        OR a.is_postable = false
        OR (a.is_control = true AND jel.subledger_type IS NULL))
  LOOP
    IF bad_line.account_entity <> NEW.entity_id THEN
      RAISE EXCEPTION 'JE line % references account in wrong entity', bad_line.id;
    ELSIF bad_line.status <> 'active' THEN
      RAISE EXCEPTION 'JE line % references inactive account %', bad_line.id, bad_line.account_id;
    ELSIF bad_line.is_postable = false THEN
      RAISE EXCEPTION 'JE line % targets non-postable account %', bad_line.id, bad_line.account_id;
    ELSE
      RAISE EXCEPTION 'JE line % targets control account % without subledger', bad_line.id, bad_line.account_id;
    END IF;
  END LOOP;

  NEW.posted_at := COALESCE(NEW.posted_at, now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION journal_entry_post_guards() IS
  'Posting guard trigger function. Validates balance, period status, account validity, postable, control-subledger, and entity hard-lock. '
  'P4 extension: bypasses period-status + entity-hard-lock when NEW.journal_type IN (ar_invoice_historical, ar_receipt_historical, ap_invoice_historical). '
  'The bypass is TRIGGER-SIDE LOCKED: only the P4-8 historical backfill RPC writes those journal_type values — no operator UI path can set them. '
  'All other guards (balance, account validity, postable, control-subledger) still apply to historical JEs.';

-- ────────────────────────────────────────────────────────────────────────────
-- 16. Views — v_cash_receipts_journal, v_ar_unapplied_receipts, v_ar_aging
-- ────────────────────────────────────────────────────────────────────────────

-- v_cash_receipts_journal: per-application detail rows for monthly recon.
CREATE OR REPLACE VIEW v_cash_receipts_journal AS
SELECT
  r.entity_id,
  r.id                         AS receipt_id,
  r.receipt_date,
  r.customer_payment_method    AS method,
  r.reference,
  r.bank_account_id,
  c.name                       AS customer_name,
  c.id                         AS customer_id,
  app.ar_invoice_id,
  inv.invoice_number,
  app.amount_applied_cents     AS applied_amount_cents,
  r.amount_cents               AS receipt_total_cents,
  r.accrual_je_id,
  r.cash_je_id
FROM ar_receipts r
  JOIN customers c ON c.id = r.customer_id
  LEFT JOIN ar_receipt_applications app ON app.ar_receipt_id = r.id
  LEFT JOIN ar_invoices inv ON inv.id = app.ar_invoice_id
WHERE r.is_void = false;

COMMENT ON VIEW v_cash_receipts_journal IS 'Cash receipts journal — one row per (receipt, applied invoice). Used for monthly bank-statement reconciliation. Excludes voided receipts.';

-- v_ar_unapplied_receipts: receipts with unapplied balance (over-payments
-- or on-account payments).
CREATE OR REPLACE VIEW v_ar_unapplied_receipts AS
SELECT
  r.entity_id,
  r.id                         AS receipt_id,
  r.customer_id,
  r.receipt_date,
  r.amount_cents               AS total_amount_cents,
  COALESCE(SUM(app.amount_applied_cents), 0)::bigint AS applied_cents,
  (r.amount_cents - COALESCE(SUM(app.amount_applied_cents), 0))::bigint AS unapplied_cents
FROM ar_receipts r
LEFT JOIN ar_receipt_applications app ON app.ar_receipt_id = r.id
WHERE r.is_void = false
GROUP BY r.id, r.entity_id, r.customer_id, r.receipt_date, r.amount_cents
HAVING r.amount_cents > COALESCE(SUM(app.amount_applied_cents), 0);

COMMENT ON VIEW v_ar_unapplied_receipts IS 'Receipts with unapplied balance. Surfaced in InternalARPayments operator UI (P4-5) so the operator can decide refund vs credit-memo vs apply-later.';

-- v_ar_aging: foundation aging view (relative to NOW()).
-- P4-6 wires the panel + a parameterized ar_aging_as_of(entity_id, as_of_date)
-- function. This view is the simpler 'live now' variant for quick lookups.
CREATE OR REPLACE VIEW v_ar_aging AS
SELECT
  inv.entity_id,
  inv.customer_id,
  CASE
    WHEN inv.due_date IS NULL OR (CURRENT_DATE - inv.due_date) <= 0 THEN 'current'
    WHEN (CURRENT_DATE - inv.due_date) BETWEEN 1   AND 30  THEN '1-30'
    WHEN (CURRENT_DATE - inv.due_date) BETWEEN 31  AND 60  THEN '31-60'
    WHEN (CURRENT_DATE - inv.due_date) BETWEEN 61  AND 90  THEN '61-90'
    WHEN (CURRENT_DATE - inv.due_date) BETWEEN 91  AND 120 THEN '91-120'
    ELSE '120+'
  END AS age_bucket,
  SUM(inv.total_amount_cents - inv.paid_amount_cents)::bigint AS outstanding_cents,
  COUNT(*) AS invoice_count
FROM ar_invoices inv
WHERE inv.paid_amount_cents < inv.total_amount_cents
  AND inv.gl_status IN ('posted','posted_historical','partial_paid','sent')
GROUP BY inv.entity_id, inv.customer_id, age_bucket;

COMMENT ON VIEW v_ar_aging IS 'Foundation AR aging view (relative to CURRENT_DATE). Per (entity_id, customer_id, age_bucket). P4-6 adds the parameterized ar_aging_as_of(entity_id, as_of_date) function + admin UI.';

-- ar_aging_as_of: parameterized variant for the P4-6 UI's date picker.
CREATE OR REPLACE FUNCTION ar_aging_as_of(p_entity_id uuid, p_as_of_date date)
RETURNS TABLE (
  customer_id              uuid,
  customer_name            text,
  current_cents            bigint,
  bucket_1_30_cents        bigint,
  bucket_31_60_cents       bigint,
  bucket_61_90_cents       bigint,
  bucket_91_120_cents      bigint,
  bucket_120_plus_cents    bigint,
  total_outstanding_cents  bigint
) AS $$
  SELECT
    c.id,
    c.name,
    COALESCE(SUM(CASE WHEN inv.due_date IS NULL OR (p_as_of_date - inv.due_date) <= 0  THEN inv.outstanding ELSE 0 END), 0)::bigint AS current_cents,
    COALESCE(SUM(CASE WHEN (p_as_of_date - inv.due_date) BETWEEN 1   AND 30  THEN inv.outstanding ELSE 0 END), 0)::bigint AS bucket_1_30_cents,
    COALESCE(SUM(CASE WHEN (p_as_of_date - inv.due_date) BETWEEN 31  AND 60  THEN inv.outstanding ELSE 0 END), 0)::bigint AS bucket_31_60_cents,
    COALESCE(SUM(CASE WHEN (p_as_of_date - inv.due_date) BETWEEN 61  AND 90  THEN inv.outstanding ELSE 0 END), 0)::bigint AS bucket_61_90_cents,
    COALESCE(SUM(CASE WHEN (p_as_of_date - inv.due_date) BETWEEN 91  AND 120 THEN inv.outstanding ELSE 0 END), 0)::bigint AS bucket_91_120_cents,
    COALESCE(SUM(CASE WHEN (p_as_of_date - inv.due_date) > 120 THEN inv.outstanding ELSE 0 END), 0)::bigint AS bucket_120_plus_cents,
    COALESCE(SUM(inv.outstanding), 0)::bigint AS total_outstanding_cents
  FROM customers c
  JOIN LATERAL (
    SELECT i.due_date,
           (i.total_amount_cents - i.paid_amount_cents) AS outstanding
      FROM ar_invoices i
     WHERE i.customer_id = c.id
       AND i.entity_id  = p_entity_id
       AND i.gl_status IN ('posted','posted_historical','partial_paid','sent')
       AND i.posting_date <= p_as_of_date
       AND (i.total_amount_cents - i.paid_amount_cents) > 0
  ) inv ON true
  GROUP BY c.id, c.name;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION ar_aging_as_of(uuid, date) IS 'Parameterized AR aging report for a given as_of_date. STABLE so Postgres can plan with current snapshot. Source data filtered to posted/posted_historical/partial_paid/sent invoices with outstanding balance > 0.';

-- ────────────────────────────────────────────────────────────────────────────
-- 17. Migration-tracking record-keeping
--     (Defensive DO $$ guard per the p3-all-migrations.sql pattern.)
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'supabase_migrations'
      AND table_name   = 'schema_migrations'
  ) THEN
    INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
    VALUES
      ('20260528100000', 'p4_chunk1_ar_schema', ARRAY[]::text[])
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;
