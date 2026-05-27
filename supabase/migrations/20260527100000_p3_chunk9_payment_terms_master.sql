-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P3 / Chunk 9 / Migration 1
-- Payment Terms Master — structured reference data for due_date computation.
--
-- Per docs/tangerine/P3-acc-core-architecture.md §3.9 (Payment Terms — added
-- 2026-05-27 to close the gap between vendors.payment_terms / customers.
-- payment_terms free-text columns and AP invoice due_date computation).
--
-- Scope:
--   1. Create payment_terms table (per-entity reference data).
--   2. Helper function compute_due_date(anchor_date, payment_terms_id).
--   3. Add payment_terms_id FK to vendors, customers, invoices.
--   4. Seed common terms (COD, NET10, NET15, NET30, NET45, NET60, NET90,
--      DUE_ON_RECEIPT, 2_10_NET30) for the ROF entity.
--   5. Best-effort backfill from vendors.payment_terms / customers.payment_terms
--      free-text values to the seeded FK (case-insensitive, normalized).
--
-- The legacy free-text payment_terms columns are RETAINED for backward-compat
-- display; new writes from the UI should set payment_terms_id (the text column
-- stays NULL on new rows but is not dropped). A future migration may strip it.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── payment_terms ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_terms (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  code                 text NOT NULL,
  name                 text NOT NULL,
  due_days             int  NOT NULL,
  discount_pct         numeric(5,4) NOT NULL DEFAULT 0,
  discount_days        int  NOT NULL DEFAULT 0,
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT payment_terms_due_days_check
    CHECK (due_days >= 0),
  CONSTRAINT payment_terms_discount_pct_check
    CHECK (discount_pct >= 0 AND discount_pct < 1),
  CONSTRAINT payment_terms_discount_days_check
    CHECK (discount_days >= 0),
  CONSTRAINT payment_terms_discount_window_check
    CHECK (discount_pct = 0 OR discount_days > 0),
  CONSTRAINT payment_terms_entity_code_unique
    UNIQUE (entity_id, code)
);

CREATE INDEX IF NOT EXISTS idx_payment_terms_entity_active
  ON payment_terms (entity_id, is_active);

COMMENT ON TABLE payment_terms IS 'Per-entity payment terms reference data. due_date on AP/AR invoices = posting_date + due_days. discount_pct/discount_days are reserved for early-payment discount workflows (not yet wired into posting). Codes are uppercased + UNIQUE per entity.';
COMMENT ON COLUMN payment_terms.code IS 'Short identifier (e.g. NET30, COD, 2_10_NET30). Uppercased + UNIQUE per entity_id.';
COMMENT ON COLUMN payment_terms.name IS 'Human-readable label shown in dropdowns (e.g. "Net 30", "2/10 Net 30").';
COMMENT ON COLUMN payment_terms.due_days IS 'Days from anchor date (typically posting_date) until invoice is due.';
COMMENT ON COLUMN payment_terms.discount_pct IS 'Early-payment discount expressed as decimal (0.02 = 2%). Reserved for future discount workflows.';
COMMENT ON COLUMN payment_terms.discount_days IS 'Days within which the discount applies. Must be > 0 if discount_pct > 0 (enforced by CHECK).';

-- ─── Touch trigger ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION payment_terms_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_terms_touch_trg ON payment_terms;
CREATE TRIGGER payment_terms_touch_trg
  BEFORE UPDATE ON payment_terms
  FOR EACH ROW EXECUTE FUNCTION payment_terms_touch();

-- ─── RLS (P1 standard template: anon_all + auth_internal_*) ────────────────
ALTER TABLE payment_terms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_payment_terms" ON payment_terms;
CREATE POLICY "anon_all_payment_terms" ON payment_terms
  FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_internal_payment_terms" ON payment_terms;
CREATE POLICY "auth_internal_payment_terms" ON payment_terms
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- ─── compute_due_date helper function ──────────────────────────────────────
CREATE OR REPLACE FUNCTION compute_due_date(p_anchor_date date, p_payment_terms_id uuid)
  RETURNS date AS $$
DECLARE
  v_due_days int;
BEGIN
  IF p_payment_terms_id IS NULL OR p_anchor_date IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT due_days INTO v_due_days
    FROM payment_terms
   WHERE id = p_payment_terms_id;
  IF v_due_days IS NULL THEN RETURN NULL; END IF;
  RETURN p_anchor_date + v_due_days;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION compute_due_date(date, uuid) IS 'Returns p_anchor_date + payment_terms.due_days, or NULL if payment_terms_id is null or not found. Used to populate invoices.due_date at posting time.';

-- ─── Add FK columns to vendors / customers / invoices ──────────────────────
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS payment_terms_id uuid REFERENCES payment_terms(id) ON DELETE SET NULL;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS payment_terms_id uuid REFERENCES payment_terms(id) ON DELETE SET NULL;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS payment_terms_id uuid REFERENCES payment_terms(id) ON DELETE SET NULL;

COMMENT ON COLUMN vendors.payment_terms_id   IS 'FK to payment_terms. Supersedes the legacy free-text payment_terms column for new records. Text column retained for backward-compat display.';
COMMENT ON COLUMN customers.payment_terms_id IS 'FK to payment_terms. Supersedes the legacy free-text payment_terms column for new records.';
COMMENT ON COLUMN invoices.payment_terms_id  IS 'FK to payment_terms. Overrides the vendor''s (or customer''s) default for this specific invoice. NULL = inherit from counterparty.';

CREATE INDEX IF NOT EXISTS idx_vendors_payment_terms   ON vendors (payment_terms_id)   WHERE payment_terms_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_payment_terms ON customers (payment_terms_id) WHERE payment_terms_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_payment_terms  ON invoices (payment_terms_id)  WHERE payment_terms_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- Seed common terms for ROF entity (idempotent — skip if any rows exist).
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_entity_id uuid;
  v_existing  int;
BEGIN
  SELECT id INTO v_entity_id FROM entities WHERE code = 'ROF' LIMIT 1;
  IF v_entity_id IS NULL THEN
    RAISE NOTICE 'payment_terms seed: ROF entity not found; skipping seed.';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_existing
    FROM payment_terms
   WHERE entity_id = v_entity_id;

  IF v_existing > 0 THEN
    RAISE NOTICE 'payment_terms seed: % rows already exist for ROF; skipping seed.', v_existing;
    RETURN;
  END IF;

  INSERT INTO payment_terms (entity_id, code, name, due_days, discount_pct, discount_days) VALUES
    (v_entity_id, 'COD',            'Cash on Delivery',     0,  0,      0),
    (v_entity_id, 'DUE_ON_RECEIPT', 'Due on Receipt',       0,  0,      0),
    (v_entity_id, 'NET10',          'Net 10',              10,  0,      0),
    (v_entity_id, 'NET15',          'Net 15',              15,  0,      0),
    (v_entity_id, 'NET30',          'Net 30',              30,  0,      0),
    (v_entity_id, 'NET45',          'Net 45',              45,  0,      0),
    (v_entity_id, 'NET60',          'Net 60',              60,  0,      0),
    (v_entity_id, 'NET90',          'Net 90',              90,  0,      0),
    (v_entity_id, '2_10_NET30',     '2/10 Net 30',         30,  0.0200, 10);

  RAISE NOTICE 'payment_terms seed: inserted 9 default terms for ROF entity (%)', v_entity_id;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Best-effort text → FK backfill on vendors + customers.
-- Normalizes free-text payment_terms to seeded codes (case-insensitive,
-- whitespace-stripped). Unambiguous matches set payment_terms_id; unmatched
-- rows are logged via NOTICE so the operator can fix them via the UI.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_entity_id   uuid;
  v_row         record;
  v_term_id     uuid;
  v_normalized  text;
  v_count_ok    int := 0;
  v_count_miss  int := 0;
BEGIN
  SELECT id INTO v_entity_id FROM entities WHERE code = 'ROF' LIMIT 1;
  IF v_entity_id IS NULL THEN
    RAISE NOTICE 'payment_terms backfill: ROF entity not found; skipping.';
    RETURN;
  END IF;

  -- Vendors
  FOR v_row IN
    SELECT id, payment_terms
      FROM vendors
     WHERE payment_terms IS NOT NULL
       AND payment_terms_id IS NULL
       AND TRIM(payment_terms) <> ''
  LOOP
    -- Normalize: uppercase + strip whitespace + collapse "NET 30" -> "NET30"
    v_normalized := UPPER(REGEXP_REPLACE(v_row.payment_terms, '\s+', '', 'g'));
    -- Map "DUEONRECEIPT" -> "DUE_ON_RECEIPT" for legacy free-text variants.
    IF v_normalized = 'DUEONRECEIPT' THEN v_normalized := 'DUE_ON_RECEIPT'; END IF;
    -- Map "2/10NET30" or "2-10-NET30" -> "2_10_NET30"
    v_normalized := REPLACE(REPLACE(v_normalized, '/', '_'), '-', '_');

    SELECT id INTO v_term_id
      FROM payment_terms
     WHERE entity_id = v_entity_id
       AND code = v_normalized
     LIMIT 1;

    IF v_term_id IS NOT NULL THEN
      UPDATE vendors SET payment_terms_id = v_term_id WHERE id = v_row.id;
      v_count_ok := v_count_ok + 1;
    ELSE
      v_count_miss := v_count_miss + 1;
      RAISE NOTICE 'payment_terms backfill (vendor %): could not match free-text "%" — set via UI.', v_row.id, v_row.payment_terms;
    END IF;
  END LOOP;
  RAISE NOTICE 'payment_terms backfill (vendors): matched=%, unmatched=%', v_count_ok, v_count_miss;

  -- Customers
  v_count_ok := 0;
  v_count_miss := 0;
  FOR v_row IN
    SELECT id, payment_terms
      FROM customers
     WHERE payment_terms IS NOT NULL
       AND payment_terms_id IS NULL
       AND TRIM(payment_terms) <> ''
  LOOP
    v_normalized := UPPER(REGEXP_REPLACE(v_row.payment_terms, '\s+', '', 'g'));
    IF v_normalized = 'DUEONRECEIPT' THEN v_normalized := 'DUE_ON_RECEIPT'; END IF;
    v_normalized := REPLACE(REPLACE(v_normalized, '/', '_'), '-', '_');

    SELECT id INTO v_term_id
      FROM payment_terms
     WHERE entity_id = v_entity_id
       AND code = v_normalized
     LIMIT 1;

    IF v_term_id IS NOT NULL THEN
      UPDATE customers SET payment_terms_id = v_term_id WHERE id = v_row.id;
      v_count_ok := v_count_ok + 1;
    ELSE
      v_count_miss := v_count_miss + 1;
      RAISE NOTICE 'payment_terms backfill (customer %): could not match free-text "%" — set via UI.', v_row.id, v_row.payment_terms;
    END IF;
  END LOOP;
  RAISE NOTICE 'payment_terms backfill (customers): matched=%, unmatched=%', v_count_ok, v_count_miss;
END $$;
