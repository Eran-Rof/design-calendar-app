-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine T6-1 — Global Search FTS schema
--
-- Adds Postgres full-text search capability to 11 v1 entities. Each gets a
-- materialized `search_doc tsvector` column maintained by a BEFORE INSERT
-- OR UPDATE trigger that builds the doc with setweight()/to_tsvector(),
-- plus a GIN index for fast lookup. Backfill is triggered by a no-op
-- `UPDATE <t> SET id = id WHERE search_doc IS NULL`, which fires the
-- BEFORE trigger and populates the column.
--
-- Pattern per entity (idempotent):
--   1. ADD COLUMN IF NOT EXISTS search_doc tsvector
--   2. CREATE OR REPLACE FUNCTION <t>_search_doc_refresh() RETURNS trigger
--   3. DROP TRIGGER + CREATE TRIGGER <t>_search_doc_refresh_trg
--   4. CREATE INDEX IF NOT EXISTS idx_<t>_search_doc USING GIN
--   5. UPDATE <t> SET id = id WHERE search_doc IS NULL  -- backfill
--
-- Weight conventions:
--   A = code / number / name / subject (top hit)
--   B = legal_name / description / vendor name / body
--   C = email / status / sub-category
--   D = notes / least important
--
-- Field-name adaptations from arch §3 spec (per actual CURRENT-SCHEMA.md):
--   - customers has no `legal_name`/`email`/`notes` columns — only code+name.
--   - ar_invoices: arch said `description`; actual column is `notes` (B).
--   - style_master: no `category`/`sub_category` text; use planning_class +
--     base_fabric instead.
--   - ip_item_master: column is `sku_code` (not `sku`); no `category` text
--     column (only category_id FK) — index style_code + color + size as
--     secondary fields.
--   - bank_transactions: no `description` column — index merchant_name (A)
--     + external_txn_id (B).
--
-- Architecture: docs/tangerine/T6-global-search-architecture.md §3.
-- ════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────── 1/11 — customers ───────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS search_doc tsvector;

CREATE OR REPLACE FUNCTION customers_search_doc_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_doc :=
    setweight(to_tsvector('simple', coalesce(NEW.code, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.name, '')), 'A');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS customers_search_doc_refresh_trg ON customers;
CREATE TRIGGER customers_search_doc_refresh_trg
  BEFORE INSERT OR UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION customers_search_doc_refresh();

CREATE INDEX IF NOT EXISTS idx_customers_search_doc
  ON customers USING GIN (search_doc);

UPDATE customers SET id = id WHERE search_doc IS NULL;

-- ─────────────────────────── 2/11 — vendors ─────────────────────────────
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS search_doc tsvector;

CREATE OR REPLACE FUNCTION vendors_search_doc_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_doc :=
    setweight(to_tsvector('simple', coalesce(NEW.code, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.legal_name, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.email, '')), 'C');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS vendors_search_doc_refresh_trg ON vendors;
CREATE TRIGGER vendors_search_doc_refresh_trg
  BEFORE INSERT OR UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION vendors_search_doc_refresh();

CREATE INDEX IF NOT EXISTS idx_vendors_search_doc
  ON vendors USING GIN (search_doc);

UPDATE vendors SET id = id WHERE search_doc IS NULL;

-- ─────────────────────────── 3/11 — ar_invoices ─────────────────────────
ALTER TABLE ar_invoices
  ADD COLUMN IF NOT EXISTS search_doc tsvector;

CREATE OR REPLACE FUNCTION ar_invoices_search_doc_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_doc :=
    setweight(to_tsvector('simple', coalesce(NEW.invoice_number, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.notes, '')), 'B');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ar_invoices_search_doc_refresh_trg ON ar_invoices;
CREATE TRIGGER ar_invoices_search_doc_refresh_trg
  BEFORE INSERT OR UPDATE ON ar_invoices
  FOR EACH ROW EXECUTE FUNCTION ar_invoices_search_doc_refresh();

CREATE INDEX IF NOT EXISTS idx_ar_invoices_search_doc
  ON ar_invoices USING GIN (search_doc);

UPDATE ar_invoices SET id = id WHERE search_doc IS NULL;

-- ─────────────────────────── 4/11 — invoices (AP) ───────────────────────
-- For v1 we index header-only fields (no JOIN-hoisted vendor name).
-- T6-2 can add vendor name via a secondary trigger if operator asks.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS search_doc tsvector;

CREATE OR REPLACE FUNCTION invoices_search_doc_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_doc :=
    setweight(to_tsvector('simple', coalesce(NEW.invoice_number, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.description, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.notes, '')), 'D');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS invoices_search_doc_refresh_trg ON invoices;
CREATE TRIGGER invoices_search_doc_refresh_trg
  BEFORE INSERT OR UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_search_doc_refresh();

CREATE INDEX IF NOT EXISTS idx_invoices_search_doc
  ON invoices USING GIN (search_doc);

UPDATE invoices SET id = id WHERE search_doc IS NULL;

-- ─────────────────────────── 5/11 — tanda_pos ───────────────────────────
ALTER TABLE tanda_pos
  ADD COLUMN IF NOT EXISTS search_doc tsvector;

CREATE OR REPLACE FUNCTION tanda_pos_search_doc_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_doc :=
    setweight(to_tsvector('simple', coalesce(NEW.po_number, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.vendor, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.buyer_po, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.buyer_name, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(NEW.status, '')), 'C');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tanda_pos_search_doc_refresh_trg ON tanda_pos;
CREATE TRIGGER tanda_pos_search_doc_refresh_trg
  BEFORE INSERT OR UPDATE ON tanda_pos
  FOR EACH ROW EXECUTE FUNCTION tanda_pos_search_doc_refresh();

CREATE INDEX IF NOT EXISTS idx_tanda_pos_search_doc
  ON tanda_pos USING GIN (search_doc);

UPDATE tanda_pos SET id = id WHERE search_doc IS NULL;

-- ─────────────────────────── 6/11 — style_master ────────────────────────
ALTER TABLE style_master
  ADD COLUMN IF NOT EXISTS search_doc tsvector;

CREATE OR REPLACE FUNCTION style_master_search_doc_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_doc :=
    setweight(to_tsvector('simple', coalesce(NEW.style_code, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.style_name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.description, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.planning_class, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(NEW.base_fabric, '')), 'D');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS style_master_search_doc_refresh_trg ON style_master;
CREATE TRIGGER style_master_search_doc_refresh_trg
  BEFORE INSERT OR UPDATE ON style_master
  FOR EACH ROW EXECUTE FUNCTION style_master_search_doc_refresh();

CREATE INDEX IF NOT EXISTS idx_style_master_search_doc
  ON style_master USING GIN (search_doc);

UPDATE style_master SET id = id WHERE search_doc IS NULL;

-- ─────────────────────────── 7/11 — ip_item_master ──────────────────────
ALTER TABLE ip_item_master
  ADD COLUMN IF NOT EXISTS search_doc tsvector;

CREATE OR REPLACE FUNCTION ip_item_master_search_doc_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_doc :=
    setweight(to_tsvector('simple', coalesce(NEW.sku_code, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.description, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.style_code, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(NEW.color, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(NEW.size, '')), 'D');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ip_item_master_search_doc_refresh_trg ON ip_item_master;
CREATE TRIGGER ip_item_master_search_doc_refresh_trg
  BEFORE INSERT OR UPDATE ON ip_item_master
  FOR EACH ROW EXECUTE FUNCTION ip_item_master_search_doc_refresh();

CREATE INDEX IF NOT EXISTS idx_ip_item_master_search_doc
  ON ip_item_master USING GIN (search_doc);

-- ip_item_master backfill — current ROF prod is ~30k rows, fine as one shot.
-- For >100k row tables a batched backfill (LIMIT/OFFSET loop) would be safer.
UPDATE ip_item_master SET id = id WHERE search_doc IS NULL;

-- ─────────────────────────── 8/11 — gl_accounts ─────────────────────────
ALTER TABLE gl_accounts
  ADD COLUMN IF NOT EXISTS search_doc tsvector;

CREATE OR REPLACE FUNCTION gl_accounts_search_doc_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_doc :=
    setweight(to_tsvector('simple', coalesce(NEW.code, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.description, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.account_type, '')), 'C');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS gl_accounts_search_doc_refresh_trg ON gl_accounts;
CREATE TRIGGER gl_accounts_search_doc_refresh_trg
  BEFORE INSERT OR UPDATE ON gl_accounts
  FOR EACH ROW EXECUTE FUNCTION gl_accounts_search_doc_refresh();

CREATE INDEX IF NOT EXISTS idx_gl_accounts_search_doc
  ON gl_accounts USING GIN (search_doc);

UPDATE gl_accounts SET id = id WHERE search_doc IS NULL;

-- ─────────────────────────── 9/11 — cases ───────────────────────────────
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS search_doc tsvector;

CREATE OR REPLACE FUNCTION cases_search_doc_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_doc :=
    setweight(to_tsvector('simple', coalesce(NEW.case_number, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.subject, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.body, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.external_email, '')), 'C');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS cases_search_doc_refresh_trg ON cases;
CREATE TRIGGER cases_search_doc_refresh_trg
  BEFORE INSERT OR UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION cases_search_doc_refresh();

CREATE INDEX IF NOT EXISTS idx_cases_search_doc
  ON cases USING GIN (search_doc);

UPDATE cases SET id = id WHERE search_doc IS NULL;

-- ─────────────────────────── 10/11 — sales_reps ─────────────────────────
ALTER TABLE sales_reps
  ADD COLUMN IF NOT EXISTS search_doc tsvector;

CREATE OR REPLACE FUNCTION sales_reps_search_doc_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_doc :=
    setweight(to_tsvector('simple', coalesce(NEW.display_name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.email, '')), 'B');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS sales_reps_search_doc_refresh_trg ON sales_reps;
CREATE TRIGGER sales_reps_search_doc_refresh_trg
  BEFORE INSERT OR UPDATE ON sales_reps
  FOR EACH ROW EXECUTE FUNCTION sales_reps_search_doc_refresh();

CREATE INDEX IF NOT EXISTS idx_sales_reps_search_doc
  ON sales_reps USING GIN (search_doc);

UPDATE sales_reps SET id = id WHERE search_doc IS NULL;

-- ─────────────────────────── 11/11 — bank_transactions ──────────────────
ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS search_doc tsvector;

CREATE OR REPLACE FUNCTION bank_transactions_search_doc_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_doc :=
    setweight(to_tsvector('simple', coalesce(NEW.merchant_name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.external_txn_id, '')), 'B');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS bank_transactions_search_doc_refresh_trg ON bank_transactions;
CREATE TRIGGER bank_transactions_search_doc_refresh_trg
  BEFORE INSERT OR UPDATE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION bank_transactions_search_doc_refresh();

CREATE INDEX IF NOT EXISTS idx_bank_transactions_search_doc
  ON bank_transactions USING GIN (search_doc);

UPDATE bank_transactions SET id = id WHERE search_doc IS NULL;

-- ─────────────────────────── PostgREST schema reload ────────────────────
NOTIFY pgrst, 'reload schema';
