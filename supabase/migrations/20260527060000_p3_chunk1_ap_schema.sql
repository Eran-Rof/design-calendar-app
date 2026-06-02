-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P3 / Chunk 1 / Migration 1
-- M3 Accounts Payable - schema extensions + invoice_payments table.
--
-- Per docs/tangerine/P3-acc-core-architecture.md §3.
--
-- Scope:
--   1. Extend `entities` with soft-default AP/bank account FKs.
--   2. Extend `invoices` with accounting columns (kind, gl_status, accounts,
--      JE pointers, monetary totals in cents).
--   3. Extend `invoice_line_items` with expense/inventory mapping + cost cols.
--   4. New table `invoice_payments` with standard P1 RLS.
--   5. Triggers:
--        - invoice_line_items -> maintain invoices.total_amount_cents
--        - invoice_payments  -> maintain invoices.paid_amount_cents
--        - invoice_payments  -> enforce SUM(amount) <= invoice.total
--   6. Indexes per arch §3.2 / §3.4.
--
-- Operator defaults (sub-decisions §11.1 + §11.2):
--   - AP control account code  = '2010' (Accounts Payable)
--   - Default bank account     = '1010' (Operating Bank)
-- These get looked up by code at runtime and set on entities as soft FKs.
-- Their actual GL row insertion is owned by the COA seed work; this migration
-- only references them best-effort and is safe if they don't yet exist.
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1. entities: default_ap_account_id + default_bank_account_id
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS default_ap_account_id   uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_bank_account_id uuid REFERENCES gl_accounts(id) ON DELETE SET NULL;

COMMENT ON COLUMN entities.default_ap_account_id   IS 'Soft default for AP control account. Looked up at runtime by code 2010. Per-invoice overridable.';
COMMENT ON COLUMN entities.default_bank_account_id IS 'Soft default for operating bank account. Looked up at runtime by code 1010. Per-payment overridable.';

-- Best-effort wire-up for any entity that already has the 2010 / 1010 GL rows.
-- Safe if the rows don't exist yet — the seed work will run later and the
-- entities row will simply stay null until then.
UPDATE entities e SET
  default_ap_account_id = COALESCE(
    e.default_ap_account_id,
    (SELECT id FROM gl_accounts ga WHERE ga.entity_id = e.id AND ga.code = '2010' LIMIT 1)
  ),
  default_bank_account_id = COALESCE(
    e.default_bank_account_id,
    (SELECT id FROM gl_accounts ga WHERE ga.entity_id = e.id AND ga.code = '1010' LIMIT 1)
  );

-- ────────────────────────────────────────────────────────────────────────────
-- 2. invoices: accounting extension columns
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS invoice_kind        text NOT NULL DEFAULT 'vendor_bill',
  ADD COLUMN IF NOT EXISTS gl_status           text NOT NULL DEFAULT 'unposted',
  ADD COLUMN IF NOT EXISTS expense_account_id  uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ap_account_id       uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS accrual_je_id       uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cash_je_id          uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS total_amount_cents  bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_amount_cents   bigint NOT NULL DEFAULT 0;

-- due_date already exists on the legacy invoices table (date); no-op-safe.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS due_date date;

-- CHECK constraints (drop-then-create so re-runs are idempotent).
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_invoice_kind_check;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_invoice_kind_check
    CHECK (invoice_kind IN ('vendor_bill','vendor_credit_memo','expense_report'));

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_gl_status_check;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_gl_status_check
    CHECK (gl_status IN ('unposted','pending_approval','posted','reversed','void'));

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_amounts_nonneg;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_amounts_nonneg
    CHECK (total_amount_cents >= 0 AND paid_amount_cents >= 0);

COMMENT ON COLUMN invoices.invoice_kind       IS 'vendor_bill / vendor_credit_memo / expense_report. Defaults to vendor_bill for legacy rows.';
COMMENT ON COLUMN invoices.gl_status          IS 'GL posting lifecycle: unposted -> pending_approval -> posted -> reversed/void. Independent of the legacy planning-side `status` column which tracks the vendor-facing workflow.';
COMMENT ON COLUMN invoices.expense_account_id IS 'Default expense (or asset) account to debit. Overridable per line via invoice_line_items.expense_account_id.';
COMMENT ON COLUMN invoices.ap_account_id      IS 'AP control account to credit. Defaults to entities.default_ap_account_id at insert.';
COMMENT ON COLUMN invoices.accrual_je_id      IS 'Set at posting time. Points at the accrual-side JE.';
COMMENT ON COLUMN invoices.cash_je_id         IS 'Set when payment posts (cash basis). NULL for unpaid invoices.';
COMMENT ON COLUMN invoices.total_amount_cents IS 'SUM of line items in cents. Trigger-maintained from invoice_line_items.';
COMMENT ON COLUMN invoices.paid_amount_cents  IS 'SUM of invoice_payments.amount_cents. Trigger-maintained.';

-- Indexes per arch §3.2
CREATE INDEX IF NOT EXISTS idx_invoices_entity_pending_approval
  ON invoices (entity_id, gl_status)
  WHERE gl_status = 'pending_approval';

CREATE INDEX IF NOT EXISTS idx_invoices_due_date_unpaid
  ON invoices (due_date)
  WHERE paid_amount_cents < total_amount_cents;

CREATE INDEX IF NOT EXISTS idx_invoices_entity_gl_status
  ON invoices (entity_id, gl_status);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. invoice_line_items: accounting extension columns
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE invoice_line_items
  ADD COLUMN IF NOT EXISTS expense_account_id  uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS inventory_item_id   uuid REFERENCES ip_item_master(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS quantity            numeric(18,4),
  ADD COLUMN IF NOT EXISTS unit_cost_cents     bigint,
  ADD COLUMN IF NOT EXISTS tax_amount_cents    bigint NOT NULL DEFAULT 0;

ALTER TABLE invoice_line_items DROP CONSTRAINT IF EXISTS invoice_line_items_tax_nonneg;
ALTER TABLE invoice_line_items
  ADD CONSTRAINT invoice_line_items_tax_nonneg
    CHECK (tax_amount_cents >= 0);

COMMENT ON COLUMN invoice_line_items.expense_account_id IS 'Per-line override of the parent invoice''s expense_account_id.';
COMMENT ON COLUMN invoice_line_items.inventory_item_id  IS 'Set for inventory receipts. P3-4 wires this to inventory_layers row creation at posting time.';
COMMENT ON COLUMN invoice_line_items.unit_cost_cents    IS 'Cost-per-unit in cents (line_total = quantity * unit_cost_cents).';
COMMENT ON COLUMN invoice_line_items.tax_amount_cents   IS 'Reserved for P21 tax module. Always 0 until tax ships.';

CREATE INDEX IF NOT EXISTS idx_invoice_line_items_inventory_item
  ON invoice_line_items (inventory_item_id)
  WHERE inventory_item_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. invoice_payments: new table
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  invoice_id           uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  payment_date         date NOT NULL,
  amount_cents         bigint NOT NULL,
  bank_account_id      uuid NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  method               text NOT NULL,
  reference            text,
  cash_je_id           uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT invoice_payments_amount_positive  CHECK (amount_cents > 0),
  CONSTRAINT invoice_payments_method_check
    CHECK (method IN ('ach','wire','check','credit_card','cash'))
);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice
  ON invoice_payments (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_entity_date
  ON invoice_payments (entity_id, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_bank
  ON invoice_payments (bank_account_id);

COMMENT ON TABLE  invoice_payments              IS 'Per-payment ledger for AP invoices. One invoice can have multiple payments (partial pays). SUM(amount_cents) per invoice <= invoices.total_amount_cents (trigger-enforced).';
COMMENT ON COLUMN invoice_payments.bank_account_id IS 'Source GL bank account (asset). Defaults to entities.default_bank_account_id at insert time in the handler.';
COMMENT ON COLUMN invoice_payments.cash_je_id   IS 'Set after the apInvoicePaid rule posts. Each payment posts its own cash JE.';

-- ────────────────────────────────────────────────────────────────────────────
-- 5. RLS - P1 template
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE invoice_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_invoice_payments" ON invoice_payments;
CREATE POLICY "anon_all_invoice_payments" ON invoice_payments
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_invoice_payments" ON invoice_payments;
CREATE POLICY "auth_internal_invoice_payments" ON invoice_payments
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Trigger: maintain invoices.total_amount_cents from invoice_line_items
--
-- Line total in cents = COALESCE(quantity * unit_cost_cents, 0) + tax_amount.
-- For legacy/non-inventory lines that have only `line_total` (numeric dollars),
-- we DON'T trigger off that column (P3-2 handler will set quantity +
-- unit_cost_cents on insert). The trigger here only reacts to the cents-grain
-- columns we control, which is exactly what the arch wants.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION invoice_line_items_maintain_total() RETURNS trigger AS $$
DECLARE
  target_invoice_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_invoice_id := OLD.invoice_id;
  ELSE
    target_invoice_id := NEW.invoice_id;
  END IF;

  UPDATE invoices i SET total_amount_cents = COALESCE((
    SELECT SUM(COALESCE(li.quantity, 0) * COALESCE(li.unit_cost_cents, 0))::bigint
           + COALESCE(SUM(li.tax_amount_cents), 0)::bigint
    FROM invoice_line_items li
    WHERE li.invoice_id = target_invoice_id
  ), 0)
  WHERE i.id = target_invoice_id;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS invoice_line_items_total_trg ON invoice_line_items;
CREATE TRIGGER invoice_line_items_total_trg
  AFTER INSERT OR UPDATE OR DELETE ON invoice_line_items
  FOR EACH ROW EXECUTE FUNCTION invoice_line_items_maintain_total();

-- ────────────────────────────────────────────────────────────────────────────
-- 7. Trigger: maintain invoices.paid_amount_cents from invoice_payments
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION invoice_payments_maintain_paid() RETURNS trigger AS $$
DECLARE
  target_invoice_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_invoice_id := OLD.invoice_id;
  ELSE
    target_invoice_id := NEW.invoice_id;
  END IF;

  UPDATE invoices i SET paid_amount_cents = COALESCE((
    SELECT SUM(p.amount_cents)::bigint
    FROM invoice_payments p
    WHERE p.invoice_id = target_invoice_id
  ), 0)
  WHERE i.id = target_invoice_id;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS invoice_payments_paid_trg ON invoice_payments;
CREATE TRIGGER invoice_payments_paid_trg
  AFTER INSERT OR UPDATE OR DELETE ON invoice_payments
  FOR EACH ROW EXECUTE FUNCTION invoice_payments_maintain_paid();

-- ────────────────────────────────────────────────────────────────────────────
-- 8. Trigger: enforce SUM(invoice_payments.amount_cents) <= invoice.total
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION invoice_payments_overpay_guard() RETURNS trigger AS $$
DECLARE
  inv_total bigint;
  sum_paid  bigint;
BEGIN
  SELECT total_amount_cents INTO inv_total
    FROM invoices WHERE id = NEW.invoice_id;

  IF inv_total IS NULL THEN
    RAISE EXCEPTION 'invoice_payments: invoice % not found', NEW.invoice_id;
  END IF;

  SELECT COALESCE(SUM(amount_cents), 0)::bigint INTO sum_paid
    FROM invoice_payments
    WHERE invoice_id = NEW.invoice_id
      AND id <> NEW.id;

  IF (sum_paid + NEW.amount_cents) > inv_total THEN
    RAISE EXCEPTION 'invoice_payments: overpayment rejected (paid % + new % > total %)',
      sum_paid, NEW.amount_cents, inv_total
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS invoice_payments_overpay_guard_trg ON invoice_payments;
CREATE TRIGGER invoice_payments_overpay_guard_trg
  BEFORE INSERT OR UPDATE ON invoice_payments
  FOR EACH ROW EXECUTE FUNCTION invoice_payments_overpay_guard();
