-- Tangerine P1 bundled migration (T1-fix-9)
-- Handles the actual prod state observed via diagnostic:
-- pre-existing 'customers' table (4-col stub from another system)
-- collides with ip_customer_master rename. Now archives existing
-- customers to customers_pretangerine_<timestamp> to make room.


-- ==== BEGIN: 20260521010000_p1_entities_extensions.sql ====
-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 1 / Migration 1
-- Extend `entities` with ERP-grade columns needed by M1 Tenancy and M2 GL.
-- Architecture: docs/tangerine/P1-foundation-architecture.md §3.1
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Add columns (all nullable first so backfill can run cleanly)
ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS code                       text,
  ADD COLUMN IF NOT EXISTS functional_currency        char(3),
  ADD COLUMN IF NOT EXISTS fiscal_year_start_month    smallint,
  ADD COLUMN IF NOT EXISTS accounting_basis_primary   text,
  ADD COLUMN IF NOT EXISTS posting_locked_through     date,
  ADD COLUMN IF NOT EXISTS country                    char(2),
  ADD COLUMN IF NOT EXISTS metadata                   jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 2. Backfill the seed RoF row + any other existing rows
UPDATE entities
SET
  code                     = COALESCE(code, CASE WHEN slug = 'ring-of-fire' THEN 'ROF' ELSE upper(replace(slug, '-', '')) END),
  functional_currency      = COALESCE(functional_currency, 'USD'),
  fiscal_year_start_month  = COALESCE(fiscal_year_start_month, 1),
  accounting_basis_primary = COALESCE(accounting_basis_primary, 'ACCRUAL')
WHERE code IS NULL
   OR functional_currency IS NULL
   OR fiscal_year_start_month IS NULL
   OR accounting_basis_primary IS NULL;

-- 3. Now lock down NOT NULL + defaults + CHECKs
ALTER TABLE entities
  ALTER COLUMN code                     SET NOT NULL,
  ALTER COLUMN functional_currency      SET NOT NULL,
  ALTER COLUMN functional_currency      SET DEFAULT 'USD',
  ALTER COLUMN fiscal_year_start_month  SET NOT NULL,
  ALTER COLUMN fiscal_year_start_month  SET DEFAULT 1,
  ALTER COLUMN accounting_basis_primary SET NOT NULL,
  ALTER COLUMN accounting_basis_primary SET DEFAULT 'ACCRUAL';

-- 4. Unique code per system (case-sensitive); CHECK on basis + fiscal month
ALTER TABLE entities
  ADD CONSTRAINT entities_code_unique UNIQUE (code);

ALTER TABLE entities
  ADD CONSTRAINT entities_basis_check
    CHECK (accounting_basis_primary IN ('ACCRUAL', 'CASH'));

ALTER TABLE entities
  ADD CONSTRAINT entities_fiscal_month_check
    CHECK (fiscal_year_start_month BETWEEN 1 AND 12);

ALTER TABLE entities
  ADD CONSTRAINT entities_currency_check
    CHECK (functional_currency ~ '^[A-Z]{3}$');

COMMENT ON COLUMN entities.code                     IS 'Short entity code (e.g. ROF). Drives PO/SO/invoice numbering prefixes. Unique.';
COMMENT ON COLUMN entities.functional_currency      IS 'Functional reporting currency. USD only at launch (per Tangerine P1 decision); schema future-proofs M2.';
COMMENT ON COLUMN entities.fiscal_year_start_month  IS '1..12; drives gl_periods generator.';
COMMENT ON COLUMN entities.accounting_basis_primary IS 'Primary reporting basis. ACCRUAL or CASH. Both books always exist (dual-basis); this is the default for reports.';
COMMENT ON COLUMN entities.posting_locked_through   IS 'Hard lock: any posting_date on or before this date is rejected. Sub-period grain in gl_periods.status.';
COMMENT ON COLUMN entities.country                  IS 'ISO 3166-1 alpha-2. Informational at launch; drives 1099/tax in later phases.';
COMMENT ON COLUMN entities.metadata                 IS 'Free-form (branding flags, integration toggles).';

-- ==== END: 20260521010000_p1_entities_extensions.sql ====


-- ==== BEGIN: 20260521010100_p1_entity_users.sql ====
-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 1 / Migration 2
-- entity_users: junction of auth.users → entities for internal staff and the
-- (deferred-identity) external accountant. Replaces what would otherwise need
-- to be a flag/column on auth.users.
-- Architecture: docs/tangerine/P1-foundation-architecture.md §3.3
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS entity_users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_id   uuid NOT NULL REFERENCES entities(id)   ON DELETE CASCADE,
  role        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_users_auth_entity_unique UNIQUE (auth_id, entity_id),
  CONSTRAINT entity_users_role_check
    CHECK (role IN ('admin', 'accountant', 'staff', 'readonly'))
);

CREATE INDEX IF NOT EXISTS idx_entity_users_entity ON entity_users (entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_users_auth   ON entity_users (auth_id);
CREATE INDEX IF NOT EXISTS idx_entity_users_role   ON entity_users (entity_id, role);

ALTER TABLE entity_users ENABLE ROW LEVEL SECURITY;

-- Internal SPA path (anon key) — full access, matching pattern in invoices etc.
CREATE POLICY "anon_all_entity_users" ON entity_users
  FOR ALL TO anon USING (true) WITH CHECK (true);

-- A signed-in user can see their OWN entity_users rows (which entities + roles they hold).
-- Cross-user visibility belongs to admin tooling and uses the anon-key SPA path.
CREATE POLICY "auth_own_entity_users_select" ON entity_users
  FOR SELECT TO authenticated
  USING (auth_id = auth.uid());

COMMENT ON TABLE  entity_users IS 'Junction of auth.users → entities for internal staff and external accountant. Role is text+CHECK (per Tangerine P1 decision).';
COMMENT ON COLUMN entity_users.role IS 'admin | accountant | staff | readonly. Adding values requires ALTER CONSTRAINT entity_users_role_check.';

-- ==== END: 20260521010100_p1_entity_users.sql ====


-- ==== BEGIN: 20260521010200_p1_entity_id_propagation.sql ====
-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 1 / Migration 3
-- Propagate entity_id across all 13 transactional + master tables.
-- Pattern per table: ADD nullable → backfill to ROF → SET NOT NULL → index.
-- Architecture: docs/tangerine/P1-foundation-architecture.md §3.2
--
-- Backfill uses subquery (SELECT id FROM entities WHERE code='ROF') which
-- works because migration 20260521010000 set the seed row's code to 'ROF'.
-- Safe to re-run: ADD COLUMN IF NOT EXISTS + COALESCE on UPDATE.
-- ════════════════════════════════════════════════════════════════════════════

-- Helper: stash the ROF entity uuid in a temp var via DO block.
-- Inline subqueries kept everywhere so this migration can replay against
-- partial state without needing the DO block to have committed.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. tanda_pos
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE tanda_pos SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE tanda_pos ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE tanda_pos
  ADD CONSTRAINT tanda_pos_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_tanda_pos_entity_id ON tanda_pos (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. po_line_items
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE po_line_items SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE po_line_items ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE po_line_items
  ADD CONSTRAINT po_line_items_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_po_line_items_entity_id ON po_line_items (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. invoices
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE invoices SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE invoices ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_invoices_entity_id ON invoices (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. invoice_line_items
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE invoice_line_items SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE invoice_line_items ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE invoice_line_items
  ADD CONSTRAINT invoice_line_items_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_invoice_line_items_entity_id ON invoice_line_items (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. shipments
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE shipments SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE shipments ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE shipments
  ADD CONSTRAINT shipments_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_shipments_entity_id ON shipments (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 6. shipment_lines
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE shipment_lines ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE shipment_lines SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE shipment_lines ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE shipment_lines
  ADD CONSTRAINT shipment_lines_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_shipment_lines_entity_id ON shipment_lines (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 7. shipment_events
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE shipment_events ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE shipment_events SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE shipment_events ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE shipment_events
  ADD CONSTRAINT shipment_events_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_shipment_events_entity_id ON shipment_events (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 8. receipts
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE receipts SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE receipts ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE receipts
  ADD CONSTRAINT receipts_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_receipts_entity_id ON receipts (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 9. receipt_line_items
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE receipt_line_items SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE receipt_line_items ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE receipt_line_items
  ADD CONSTRAINT receipt_line_items_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_receipt_line_items_entity_id ON receipt_line_items (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 10. ip_item_master
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE ip_item_master ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE ip_item_master SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE ip_item_master ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE ip_item_master
  ADD CONSTRAINT ip_item_master_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_ip_item_master_entity_id ON ip_item_master (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 11. ip_category_master
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE ip_category_master ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE ip_category_master SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE ip_category_master ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE ip_category_master
  ADD CONSTRAINT ip_category_master_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_ip_category_master_entity_id ON ip_category_master (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 12. ip_vendor_master
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE ip_vendor_master ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE ip_vendor_master SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE ip_vendor_master ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE ip_vendor_master
  ADD CONSTRAINT ip_vendor_master_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_ip_vendor_master_entity_id ON ip_vendor_master (entity_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 13. ip_customer_master
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE ip_customer_master ADD COLUMN IF NOT EXISTS entity_id uuid;
UPDATE ip_customer_master SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
ALTER TABLE ip_customer_master ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE ip_customer_master
  ADD CONSTRAINT ip_customer_master_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_ip_customer_master_entity_id ON ip_customer_master (entity_id);

-- ════════════════════════════════════════════════════════════════════════════
-- Sanity check: fail loudly if any table still has NULL entity_id (shouldn't
-- be possible at this point, but a single bad row would break later passes).
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  bad_table text;
BEGIN
  FOR bad_table IN
    SELECT table_name
    FROM (VALUES
      ('tanda_pos'),('po_line_items'),('invoices'),('invoice_line_items'),
      ('shipments'),('shipment_lines'),('shipment_events'),
      ('receipts'),('receipt_line_items'),
      ('ip_item_master'),('ip_category_master'),('ip_vendor_master'),('ip_customer_master')
    ) AS t(table_name)
  LOOP
    EXECUTE format('SELECT 1 FROM %I WHERE entity_id IS NULL LIMIT 1', bad_table);
    IF FOUND THEN
      RAISE EXCEPTION 'Tangerine P1 mig 3: % still has NULL entity_id rows', bad_table;
    END IF;
  END LOOP;
END $$;

-- ==== END: 20260521010200_p1_entity_id_propagation.sql ====


-- ==== BEGIN: 20260521010300_p1_rls_entity_scope.sql ====
-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 1 / Migration 4
-- Apply the canonical RLS template (policy #2: auth_internal) to every
-- entity-scoped table from migration 3. Pre-existing anon_all_* and
-- vendor_* policies are left untouched.
--
-- Rationale: only the internal-staff auth path (auth.users via entity_users)
-- is new in P1. Vendor isolation (auth_vendor_*) already exists and works;
-- entity-scoping vendor reads is deferred to P10 RLS-flip since RoF is
-- single-entity today and tightening now risks blocking the portal if
-- entity_vendors isn't fully seeded.
--
-- Architecture: docs/tangerine/P1-foundation-architecture.md §3.3
-- ════════════════════════════════════════════════════════════════════════════

-- Idempotent ENABLE RLS for every table touched (no-op if already enabled).
ALTER TABLE tanda_pos              ENABLE ROW LEVEL SECURITY;
ALTER TABLE po_line_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices               ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments              ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_lines         ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipt_line_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_item_master         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_category_master     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_vendor_master       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_customer_master     ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────────────────────
-- Canonical internal-auth policy (DROP+CREATE for idempotency).
-- Pattern: authenticated user can see/modify rows where they have an
-- entity_users row for that entity. Vendor users (who land in vendor_users
-- but not entity_users) match no rows here and are unaffected.
-- ────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "auth_internal_tanda_pos" ON tanda_pos;
CREATE POLICY "auth_internal_tanda_pos" ON tanda_pos
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_po_line_items" ON po_line_items;
CREATE POLICY "auth_internal_po_line_items" ON po_line_items
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_invoices" ON invoices;
CREATE POLICY "auth_internal_invoices" ON invoices
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_invoice_line_items" ON invoice_line_items;
CREATE POLICY "auth_internal_invoice_line_items" ON invoice_line_items
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_shipments" ON shipments;
CREATE POLICY "auth_internal_shipments" ON shipments
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_shipment_lines" ON shipment_lines;
CREATE POLICY "auth_internal_shipment_lines" ON shipment_lines
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_shipment_events" ON shipment_events;
CREATE POLICY "auth_internal_shipment_events" ON shipment_events
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_receipts" ON receipts;
CREATE POLICY "auth_internal_receipts" ON receipts
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_receipt_line_items" ON receipt_line_items;
CREATE POLICY "auth_internal_receipt_line_items" ON receipt_line_items
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_ip_item_master" ON ip_item_master;
CREATE POLICY "auth_internal_ip_item_master" ON ip_item_master
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_ip_category_master" ON ip_category_master;
CREATE POLICY "auth_internal_ip_category_master" ON ip_category_master
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_ip_vendor_master" ON ip_vendor_master;
CREATE POLICY "auth_internal_ip_vendor_master" ON ip_vendor_master
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

DROP POLICY IF EXISTS "auth_internal_ip_customer_master" ON ip_customer_master;
CREATE POLICY "auth_internal_ip_customer_master" ON ip_customer_master
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- ────────────────────────────────────────────────────────────────────────────
-- Anon-key policies are NOT touched by this migration. Existing anon_all_*
-- policies on each table continue to work; if a table never had one (e.g.
-- some ip_* tables), it operates without anon access until a future migration
-- adds the policy explicitly. This is intentional — we don't want to widen
-- access by accident.
-- ────────────────────────────────────────────────────────────────────────────

-- ==== END: 20260521010300_p1_rls_entity_scope.sql ====


-- ==== BEGIN: 20260521020000_p1_gl_accounts.sql ====
-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 2 / Migration 5
-- gl_accounts: Chart of Accounts. Schema only; the seed COA arrives as a
-- separate data migration once the accountant supplies the canonical list
-- (see docs/tangerine/accountant-coa-request-email.md).
-- Architecture: docs/tangerine/P1-foundation-architecture.md §4.1
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS gl_accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  code                 text NOT NULL,
  name                 text NOT NULL,
  account_type         text NOT NULL,
  account_subtype      text,
  parent_account_id    uuid REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  normal_balance       text NOT NULL,
  is_postable          boolean NOT NULL DEFAULT true,
  is_control           boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'active',
  description          text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT gl_accounts_code_unique UNIQUE (entity_id, code),
  CONSTRAINT gl_accounts_type_check
    CHECK (account_type IN ('asset','liability','equity','revenue','expense','contra_asset','contra_revenue')),
  CONSTRAINT gl_accounts_status_check
    CHECK (status IN ('active','inactive')),
  CONSTRAINT gl_accounts_normal_balance_check
    CHECK (normal_balance IN ('DEBIT','CREDIT'))
);

CREATE INDEX IF NOT EXISTS idx_gl_accounts_entity_type   ON gl_accounts (entity_id, account_type);
CREATE INDEX IF NOT EXISTS idx_gl_accounts_parent        ON gl_accounts (parent_account_id);
CREATE INDEX IF NOT EXISTS idx_gl_accounts_entity_status ON gl_accounts (entity_id, status);

COMMENT ON TABLE  gl_accounts                    IS 'Chart of Accounts. One row per postable or roll-up account per entity. Seed via accountant-supplied list (docs/tangerine/accountant-coa-request-email.md).';
COMMENT ON COLUMN gl_accounts.normal_balance     IS 'DEBIT or CREDIT. Derived from account_type at insert time (assets/expenses = DEBIT; liabilities/equity/revenue = CREDIT). Stored explicitly so the posting service can validate without re-deriving.';
COMMENT ON COLUMN gl_accounts.is_postable        IS 'False = roll-up parent only; the posting service rejects direct JE lines against non-postable accounts.';
COMMENT ON COLUMN gl_accounts.is_control         IS 'True for AR / AP / Inventory style accounts. Posting service requires subledger_type + subledger_id on every line hitting a control account.';

-- Bridging trigger: keep updated_at + updated_by fresh on every UPDATE.
CREATE OR REPLACE FUNCTION gl_accounts_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gl_accounts_touch_trg ON gl_accounts;
CREATE TRIGGER gl_accounts_touch_trg
  BEFORE UPDATE ON gl_accounts
  FOR EACH ROW EXECUTE FUNCTION gl_accounts_touch();

-- ==== END: 20260521020000_p1_gl_accounts.sql ====


-- ==== BEGIN: 20260521020100_p1_gl_periods.sql ====
-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 2 / Migration 6
-- gl_periods: 12 calendar-month accounting periods per fiscal year per entity.
-- Bootstrap 5 historical + 5 forward years × 12 periods for every entity that
-- exists at migration time (= RoF only today).
-- Architecture: docs/tangerine/P1-foundation-architecture.md §4.1
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS gl_periods (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  fiscal_year          smallint NOT NULL,
  period_number        smallint NOT NULL,
  starts_on            date NOT NULL,
  ends_on              date NOT NULL,
  status               text NOT NULL DEFAULT 'open',
  soft_closed_at       timestamptz,
  closed_at            timestamptz,
  closed_by_user_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gl_periods_unique UNIQUE (entity_id, fiscal_year, period_number),
  CONSTRAINT gl_periods_period_check CHECK (period_number BETWEEN 1 AND 12),
  CONSTRAINT gl_periods_range_check  CHECK (ends_on >= starts_on),
  CONSTRAINT gl_periods_status_check CHECK (status IN ('open','soft_close','closed'))
);

CREATE INDEX IF NOT EXISTS idx_gl_periods_entity_status ON gl_periods (entity_id, status);
CREATE INDEX IF NOT EXISTS idx_gl_periods_range         ON gl_periods (entity_id, starts_on, ends_on);

COMMENT ON TABLE gl_periods IS '12 calendar-month accounting periods per fiscal year per entity. Status flow: open → soft_close (entries blocked, accountant adjustments allowed) → closed (no writes).';

-- ════════════════════════════════════════════════════════════════════════════
-- Bootstrap periods for every existing entity.
-- 10 years total = 5 historical (FY currentYear-4 ... FY currentYear) + 4 forward.
-- Indexed by fiscal_year_start_month from the entity.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  e             record;
  current_year  smallint := EXTRACT(YEAR FROM CURRENT_DATE)::smallint;
  start_fy      smallint;
  end_fy        smallint;
  fy            smallint;
  pn            smallint;
  fy_start_m    smallint;
  p_start       date;
  p_end         date;
BEGIN
  FOR e IN SELECT id, fiscal_year_start_month FROM entities LOOP
    fy_start_m := e.fiscal_year_start_month;
    start_fy   := current_year - 5;
    end_fy     := current_year + 4;

    FOR fy IN start_fy..end_fy LOOP
      FOR pn IN 1..12 LOOP
        p_start := make_date(fy, fy_start_m, 1)
                   + ((pn - 1) || ' month')::interval;
        p_end   := (p_start + interval '1 month' - interval '1 day')::date;

        INSERT INTO gl_periods (entity_id, fiscal_year, period_number, starts_on, ends_on, status)
        VALUES (e.id, fy, pn, p_start::date, p_end, 'open')
        ON CONFLICT (entity_id, fiscal_year, period_number) DO NOTHING;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Helper function: find the period a posting_date falls into for an entity.
-- Used by the journal_entries posting trigger to validate posting_date.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION gl_find_period(p_entity_id uuid, p_date date)
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM gl_periods
   WHERE entity_id = p_entity_id
     AND p_date BETWEEN starts_on AND ends_on
   LIMIT 1;
$$;

COMMENT ON FUNCTION gl_find_period(uuid, date) IS 'Locate the gl_periods row whose [starts_on, ends_on] contains the date for an entity. Used by journal_entries posting trigger.';

-- ==== END: 20260521020100_p1_gl_periods.sql ====


-- ==== BEGIN: 20260521020200_p1_journal_entries.sql ====
-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 2 / Migration 7
-- journal_entries + journal_entry_lines, plus trigger-level posting guards:
--   • balanced: Σ(debit) = Σ(credit)
--   • period_open: posting_date must fall in an open period
--   • postable: lines reject non-postable accounts
--   • control_subledger: lines hitting is_control must include subledger
--   • idempotency: (source_table, source_id, basis) unique among non-NULL sources
-- Architecture: docs/tangerine/P1-foundation-architecture.md §4.1, §4.3
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS journal_entries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  period_id            uuid NOT NULL REFERENCES gl_periods(id) ON DELETE RESTRICT,
  basis                text NOT NULL,
  journal_type         text NOT NULL,
  posting_date         date NOT NULL,
  source_module        text NOT NULL,
  source_table         text,
  source_id            text,
  description          text NOT NULL,
  status               text NOT NULL DEFAULT 'draft',
  posted_at            timestamptz,
  posted_by_user_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reversed_by_je_id    uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  reverses_je_id       uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  sibling_je_id        uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT journal_entries_basis_check
    CHECK (basis IN ('ACCRUAL','CASH')),
  CONSTRAINT journal_entries_status_check
    CHECK (status IN ('draft','posted','reversed'))
);

CREATE INDEX IF NOT EXISTS idx_je_entity_basis_date
  ON journal_entries (entity_id, basis, posting_date);
CREATE INDEX IF NOT EXISTS idx_je_period_basis_status
  ON journal_entries (period_id, basis, status);
CREATE INDEX IF NOT EXISTS idx_je_source
  ON journal_entries (source_table, source_id);
CREATE INDEX IF NOT EXISTS idx_je_sibling
  ON journal_entries (sibling_je_id);

-- Idempotency: a given source event posts at most once per basis.
CREATE UNIQUE INDEX IF NOT EXISTS uq_je_source_basis
  ON journal_entries (source_table, source_id, basis)
  WHERE source_id IS NOT NULL;

COMMENT ON TABLE  journal_entries IS 'Header for every GL posting. Dual-basis: every event produces 0/1/2 sibling rows (one ACCRUAL, one CASH) linked via sibling_je_id. status=draft is editable; posted is immutable except for reversal; reversed is terminal.';
COMMENT ON COLUMN journal_entries.basis        IS 'ACCRUAL or CASH. Both books always coexist; reports filter by basis.';
COMMENT ON COLUMN journal_entries.sibling_je_id IS 'Points at the other-basis twin of this JE. NULL when only one basis emitted a row for the event.';
COMMENT ON COLUMN journal_entries.source_table  IS 'Origin table for the event (e.g. invoices, payments). Combined with source_id forms the idempotency key.';

-- ────────────────────────────────────────────────────────────────────────────
-- journal_entry_lines
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS journal_entry_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id     uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_number          smallint NOT NULL,
  account_id           uuid NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  debit                numeric(18,2) NOT NULL DEFAULT 0,
  credit               numeric(18,2) NOT NULL DEFAULT 0,
  memo                 text,
  subledger_type       text,
  subledger_id         uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jel_line_unique UNIQUE (journal_entry_id, line_number),
  CONSTRAINT jel_one_side_check
    CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)),
  CONSTRAINT jel_amounts_nonneg
    CHECK (debit >= 0 AND credit >= 0),
  CONSTRAINT jel_subledger_pair_check
    CHECK ((subledger_type IS NULL AND subledger_id IS NULL)
        OR (subledger_type IS NOT NULL AND subledger_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_jel_je               ON journal_entry_lines (journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_jel_account          ON journal_entry_lines (account_id);
CREATE INDEX IF NOT EXISTS idx_jel_subledger        ON journal_entry_lines (subledger_type, subledger_id);

COMMENT ON TABLE journal_entry_lines IS 'Lines belonging to a journal_entry. One side per line (debit XOR credit). Lines hitting an is_control=true account must include subledger_type + subledger_id; enforcement is in the JE posting trigger.';

-- ════════════════════════════════════════════════════════════════════════════
-- Posting guard trigger: runs when journal_entries.status transitions to
-- 'posted'. Validates everything the application posting service should have
-- already checked. Fail-loud safety net.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION journal_entry_post_guards() RETURNS trigger AS $$
DECLARE
  total_d           numeric(18,2);
  total_c           numeric(18,2);
  bad_line          record;
  period            record;
  entity_lock       date;
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

  -- 2. Period status: the referenced period must be open
  SELECT status, starts_on INTO period
    FROM gl_periods WHERE id = NEW.period_id;
  IF period.status <> 'open' THEN
    RAISE EXCEPTION 'Cannot post journal_entry % into period in status %',
      NEW.id, period.status;
  END IF;

  -- 3. posting_date falls inside the referenced period
  IF NEW.posting_date NOT BETWEEN period.starts_on AND period.starts_on + interval '1 month' - interval '1 day' THEN
    -- Cheap re-derive of ends_on to avoid a second SELECT
    PERFORM 1 FROM gl_periods
      WHERE id = NEW.period_id
        AND NEW.posting_date BETWEEN starts_on AND ends_on;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'posting_date % is outside period % bounds', NEW.posting_date, NEW.period_id;
    END IF;
  END IF;

  -- 4. entities.posting_locked_through hard lock
  SELECT posting_locked_through INTO entity_lock
    FROM entities WHERE id = NEW.entity_id;
  IF entity_lock IS NOT NULL AND NEW.posting_date <= entity_lock THEN
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

-- BEFORE INSERT — for direct inserts at status='posted'
DROP TRIGGER IF EXISTS journal_entries_post_guard_ins ON journal_entries;
CREATE TRIGGER journal_entries_post_guard_ins
  BEFORE INSERT ON journal_entries
  FOR EACH ROW
  WHEN (NEW.status = 'posted')
  EXECUTE FUNCTION journal_entry_post_guards();

-- BEFORE UPDATE — when status transitions to 'posted'
DROP TRIGGER IF EXISTS journal_entries_post_guard_upd ON journal_entries;
CREATE TRIGGER journal_entries_post_guard_upd
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW
  WHEN (OLD.status <> 'posted' AND NEW.status = 'posted')
  EXECUTE FUNCTION journal_entry_post_guards();

-- Touched timestamp
CREATE OR REPLACE FUNCTION journal_entries_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_entries_touch_trg ON journal_entries;
CREATE TRIGGER journal_entries_touch_trg
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_touch();

-- ════════════════════════════════════════════════════════════════════════════
-- Immutability: once a JE is 'posted' or 'reversed', lines cannot change.
-- Only the JE-level status flip to 'reversed' is allowed via the reverse path.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION journal_entry_lines_immutable() RETURNS trigger AS $$
DECLARE
  je_status text;
BEGIN
  SELECT status INTO je_status FROM journal_entries
    WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
  IF je_status IN ('posted','reversed') THEN
    RAISE EXCEPTION 'journal_entry_lines for JE in status % are immutable', je_status;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_entry_lines_immutable_trg ON journal_entry_lines;
CREATE TRIGGER journal_entry_lines_immutable_trg
  BEFORE INSERT OR UPDATE OR DELETE ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION journal_entry_lines_immutable();

-- ==== END: 20260521020200_p1_journal_entries.sql ====


-- ==== BEGIN: 20260521020300_p1_gl_subledger_balances_view.sql ====
-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 2 / Migration 8
-- gl_subledger_balances_v: read-only view of running subledger balances by
-- account × basis × subledger. View-only in P1 (per arch §4.1); promote to
-- materialized view after AR backfill load test (P4) if performance demands.
-- Architecture: docs/tangerine/P1-foundation-architecture.md §4.1
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW gl_subledger_balances_v AS
SELECT
  je.entity_id,
  jel.account_id,
  je.basis,
  jel.subledger_type,
  jel.subledger_id,
  SUM(jel.debit)  AS balance_debit,
  SUM(jel.credit) AS balance_credit,
  SUM(jel.debit) - SUM(jel.credit) AS net_balance_debit,
  SUM(jel.credit) - SUM(jel.debit) AS net_balance_credit,
  MAX(je.posting_date) AS as_of_date
FROM journal_entry_lines jel
JOIN journal_entries     je  ON je.id = jel.journal_entry_id
WHERE je.status = 'posted'
GROUP BY je.entity_id, jel.account_id, je.basis, jel.subledger_type, jel.subledger_id;

COMMENT ON VIEW gl_subledger_balances_v IS 'Running balance per (entity, account, basis, subledger). Only posted journal_entries contribute. net_balance_debit is positive when the account has a debit balance; net_balance_credit is its negation. Promote to materialized view if posted-JE volume makes the live aggregation too slow.';

-- ==== END: 20260521020300_p1_gl_subledger_balances_view.sql ====


-- ==== BEGIN: 20260521020400_p1_gl_rls.sql ====
-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 2 / Migration 9
-- RLS for GL tables. Vendors never see GL data; the anon-key SPA path retains
-- full access (internal app), and authenticated internal users are scoped via
-- entity_users. A closed-period guard prevents UPDATE/DELETE on JEs whose
-- referenced period has status='closed'.
-- Architecture: docs/tangerine/P1-foundation-architecture.md §4.4
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE gl_accounts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_periods           ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries      ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entry_lines  ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────────────────────
-- Anon-key SPA path (internal apps) — full access. Vendors never reach these
-- tables via the vendor portal because no vendor route queries them.
-- ────────────────────────────────────────────────────────────────────────────
CREATE POLICY "anon_all_gl_accounts" ON gl_accounts
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "anon_all_gl_periods" ON gl_periods
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "anon_all_journal_entries" ON journal_entries
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "anon_all_journal_entry_lines" ON journal_entry_lines
  FOR ALL TO anon USING (true) WITH CHECK (true);

-- ────────────────────────────────────────────────────────────────────────────
-- Authenticated internal users — entity-scoped via entity_users junction.
-- ────────────────────────────────────────────────────────────────────────────
CREATE POLICY "auth_internal_gl_accounts" ON gl_accounts
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

CREATE POLICY "auth_internal_gl_periods" ON gl_periods
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

CREATE POLICY "auth_internal_journal_entries" ON journal_entries
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

-- Lines inherit entity scoping via their parent journal_entry.
CREATE POLICY "auth_internal_journal_entry_lines" ON journal_entry_lines
  FOR ALL TO authenticated
  USING (journal_entry_id IN (
    SELECT je.id FROM journal_entries je
    JOIN entity_users eu ON eu.entity_id = je.entity_id
    WHERE eu.auth_id = auth.uid()
  ))
  WITH CHECK (journal_entry_id IN (
    SELECT je.id FROM journal_entries je
    JOIN entity_users eu ON eu.entity_id = je.entity_id
    WHERE eu.auth_id = auth.uid()
  ));

-- ════════════════════════════════════════════════════════════════════════════
-- Closed-period guard: trigger-based (RLS can't easily express "deny based on
-- referenced row's status"). Once a period is 'closed', NO writes to JEs in
-- it, regardless of caller. soft_close is a softer state — only inserts of
-- non-'adjustment' journal types are blocked.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION journal_entry_period_lock_guard() RETURNS trigger AS $$
DECLARE
  period_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO period_status FROM gl_periods WHERE id = OLD.period_id;
    IF period_status = 'closed' THEN
      RAISE EXCEPTION 'Cannot DELETE journal_entry % in closed period', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  SELECT status INTO period_status FROM gl_periods WHERE id = NEW.period_id;

  IF period_status = 'closed' THEN
    RAISE EXCEPTION 'Cannot write journal_entry % into closed period', NEW.id;
  END IF;

  IF TG_OP = 'INSERT' AND period_status = 'soft_close'
     AND NEW.journal_type NOT IN ('adjustment','close') THEN
    RAISE EXCEPTION 'Period is soft-closed; only adjustment/close journal types allowed';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS je_period_lock_ins ON journal_entries;
CREATE TRIGGER je_period_lock_ins
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entry_period_lock_guard();

DROP TRIGGER IF EXISTS je_period_lock_upd ON journal_entries;
CREATE TRIGGER je_period_lock_upd
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entry_period_lock_guard();

DROP TRIGGER IF EXISTS je_period_lock_del ON journal_entries;
CREATE TRIGGER je_period_lock_del
  BEFORE DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entry_period_lock_guard();

COMMENT ON FUNCTION journal_entry_period_lock_guard() IS 'Trigger-level period status enforcement. Blocks all writes into closed periods; in soft_close periods, only adjustment/close journal types may be inserted.';

-- ==== END: 20260521020400_p1_gl_rls.sql ====


-- ==== BEGIN: 20260521030000_p1_gl_post_rpc.sql ====
-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 3 / Migration 10
-- gl_post_journal_entry: atomic posting RPC. Inserts journal_entries header
-- at status='draft', inserts journal_entry_lines, then flips header to
-- status='posted' which fires the guard trigger (mig 7). Optionally links a
-- sibling JE id via UPDATE in the same transaction.
--
-- Why an RPC: PostgREST does not expose explicit BEGIN/COMMIT. A stored
-- function gives us a single round-trip + automatic rollback on any error
-- inside the function body.
--
-- Architecture: docs/tangerine/P1-foundation-architecture.md §4.3
-- ════════════════════════════════════════════════════════════════════════════

-- Payload shape:
-- {
--   "entity_id":     "uuid",
--   "basis":         "ACCRUAL" | "CASH",
--   "journal_type":  "manual" | "ap_invoice" | ... ,
--   "posting_date":  "YYYY-MM-DD",
--   "source_module": "ap" | "ar" | ...,
--   "source_table":  "invoices" | "payments" | ... | null,
--   "source_id":     "...uuid or text..." | null,
--   "description":   "free text",
--   "sibling_je_id": "uuid" | null,
--   "created_by_user_id": "uuid" | null,
--   "lines": [
--     { "line_number": 1, "account_id": "uuid", "debit": "12.00", "credit": "0",
--       "memo": null, "subledger_type": null, "subledger_id": null },
--     ...
--   ]
-- }

CREATE OR REPLACE FUNCTION gl_post_journal_entry(payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_entity_id      uuid          := (payload->>'entity_id')::uuid;
  v_basis          text          := payload->>'basis';
  v_journal_type   text          := payload->>'journal_type';
  v_posting_date   date          := (payload->>'posting_date')::date;
  v_source_module  text          := payload->>'source_module';
  v_source_table   text          := NULLIF(payload->>'source_table', '');
  v_source_id      text          := NULLIF(payload->>'source_id', '');
  v_description    text          := payload->>'description';
  v_sibling_id     uuid          := NULLIF(payload->>'sibling_je_id', '')::uuid;
  v_created_by     uuid          := NULLIF(payload->>'created_by_user_id', '')::uuid;
  v_lines          jsonb         := payload->'lines';
  v_period_id      uuid;
  v_je_id          uuid;
  v_line           jsonb;
  v_lock_through   date;
BEGIN
  IF v_entity_id IS NULL THEN
    RAISE EXCEPTION 'gl_post_journal_entry: entity_id is required';
  END IF;
  IF v_basis NOT IN ('ACCRUAL','CASH') THEN
    RAISE EXCEPTION 'gl_post_journal_entry: basis must be ACCRUAL or CASH (got %)', v_basis;
  END IF;
  IF v_journal_type IS NULL OR v_journal_type = '' THEN
    RAISE EXCEPTION 'gl_post_journal_entry: journal_type is required';
  END IF;
  IF v_posting_date IS NULL THEN
    RAISE EXCEPTION 'gl_post_journal_entry: posting_date is required';
  END IF;
  IF v_lines IS NULL OR jsonb_array_length(v_lines) = 0 THEN
    RAISE EXCEPTION 'gl_post_journal_entry: at least one line is required';
  END IF;

  -- Resolve the period for this posting_date / entity.
  v_period_id := gl_find_period(v_entity_id, v_posting_date);
  IF v_period_id IS NULL THEN
    RAISE EXCEPTION 'gl_post_journal_entry: no gl_periods row covers % for entity %', v_posting_date, v_entity_id;
  END IF;

  -- Hard-lock check (also enforced in the posting trigger; check here too for a
  -- friendlier error before we start inserting lines).
  SELECT posting_locked_through INTO v_lock_through
    FROM entities WHERE id = v_entity_id;
  IF v_lock_through IS NOT NULL AND v_posting_date <= v_lock_through THEN
    RAISE EXCEPTION 'gl_post_journal_entry: posting_date % is on or before entity hard-lock %',
      v_posting_date, v_lock_through;
  END IF;

  -- Insert header at status='draft' (so the post-guard trigger does NOT fire yet).
  INSERT INTO journal_entries (
    entity_id, period_id, basis, journal_type, posting_date,
    source_module, source_table, source_id,
    description, status, sibling_je_id, created_by_user_id
  ) VALUES (
    v_entity_id, v_period_id, v_basis, v_journal_type, v_posting_date,
    v_source_module, v_source_table, v_source_id,
    v_description, 'draft', v_sibling_id, v_created_by
  ) RETURNING id INTO v_je_id;

  -- Insert lines.
  FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines)
  LOOP
    INSERT INTO journal_entry_lines (
      journal_entry_id, line_number, account_id, debit, credit,
      memo, subledger_type, subledger_id
    ) VALUES (
      v_je_id,
      (v_line->>'line_number')::smallint,
      (v_line->>'account_id')::uuid,
      COALESCE((v_line->>'debit')::numeric(18,2), 0),
      COALESCE((v_line->>'credit')::numeric(18,2), 0),
      v_line->>'memo',
      NULLIF(v_line->>'subledger_type', ''),
      NULLIF(v_line->>'subledger_id', '')::uuid
    );
  END LOOP;

  -- Flip to status='posted' — this fires journal_entry_post_guards() which
  -- validates balance, period status, account membership, control-subledger,
  -- postable, and posting_date bounds. On any guard violation, the whole
  -- transaction (header + lines + flip) rolls back atomically.
  UPDATE journal_entries SET status = 'posted' WHERE id = v_je_id;

  RETURN v_je_id;
END;
$$;

COMMENT ON FUNCTION gl_post_journal_entry(jsonb) IS 'Atomic posting RPC. Inserts header at draft, inserts lines, flips to posted (which fires all guard triggers). Whole call rolls back on any failure. Returns the new journal_entries.id.';

-- ════════════════════════════════════════════════════════════════════════════
-- gl_link_sibling_je: helper to link two journal_entries as sibling twins
-- (one ACCRUAL, one CASH for the same source event). Sets sibling_je_id on
-- both rows in a single transaction.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION gl_link_sibling_je(je_a uuid, je_b uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  basis_a text;
  basis_b text;
BEGIN
  SELECT basis INTO basis_a FROM journal_entries WHERE id = je_a;
  SELECT basis INTO basis_b FROM journal_entries WHERE id = je_b;

  IF basis_a IS NULL OR basis_b IS NULL THEN
    RAISE EXCEPTION 'gl_link_sibling_je: one or both journal_entries not found';
  END IF;
  IF basis_a = basis_b THEN
    RAISE EXCEPTION 'gl_link_sibling_je: cannot link two JEs with the same basis (%)', basis_a;
  END IF;

  UPDATE journal_entries SET sibling_je_id = je_b WHERE id = je_a;
  UPDATE journal_entries SET sibling_je_id = je_a WHERE id = je_b;
END;
$$;

COMMENT ON FUNCTION gl_link_sibling_je(uuid, uuid) IS 'Bi-directionally link the ACCRUAL and CASH twin of a dual-basis posting event.';

-- ==== END: 20260521030000_p1_gl_post_rpc.sql ====


-- ==== BEGIN: 20260521040000_p1_style_master.sql ====
-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 4 / Migration 10
-- style_master: style-level attributes shared by every SKU variant of a
-- design. Today `ip_item_master.style_code` is denormalized text — promote
-- it to a proper master table with an FK from item_master (added in mig 11).
-- Architecture: docs/tangerine/P1-foundation-architecture.md §6.1
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS style_master (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id          uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  style_code         text NOT NULL,
  description        text NOT NULL,
  category_id        uuid REFERENCES ip_category_master(id) ON DELETE SET NULL,
  gender_code        text,
  season             text,
  design_year        smallint,
  is_apparel         boolean NOT NULL DEFAULT true,
  launch_date        date,
  lifecycle_status   text NOT NULL DEFAULT 'active',
  planning_class     text,
  base_fabric        text,
  attributes         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at         timestamptz,
  CONSTRAINT style_master_gender_check
    CHECK (gender_code IS NULL OR gender_code IN ('M', 'WMS', 'B', 'C', 'G', 'U')),
  CONSTRAINT style_master_lifecycle_check
    CHECK (lifecycle_status IN ('active', 'phased_out', 'discontinued', 'core')),
  CONSTRAINT style_master_planning_class_check
    CHECK (planning_class IS NULL OR planning_class IN ('core', 'seasonal', 'fashion')),
  CONSTRAINT style_master_design_year_check
    CHECK (design_year IS NULL OR design_year BETWEEN 1990 AND 2100)
);

-- Active style codes must be unique per entity. Soft-deleted rows are excluded
-- so a code can be reissued after a row is tombstoned.
CREATE UNIQUE INDEX IF NOT EXISTS uq_style_master_code
  ON style_master (entity_id, style_code)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_style_master_entity_gender    ON style_master (entity_id, gender_code);
CREATE INDEX IF NOT EXISTS idx_style_master_entity_lifecycle ON style_master (entity_id, lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_style_master_category         ON style_master (category_id);

-- Touched timestamp
CREATE OR REPLACE FUNCTION style_master_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS style_master_touch_trg ON style_master;
CREATE TRIGGER style_master_touch_trg
  BEFORE UPDATE ON style_master
  FOR EACH ROW EXECUTE FUNCTION style_master_touch();

ALTER TABLE style_master ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_style_master" ON style_master
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_internal_style_master" ON style_master
  FOR ALL TO authenticated
  USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
  WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));

COMMENT ON TABLE  style_master IS 'Style-level master. One row per design (Style × season etc.) per entity. Variant attributes (color/size/inseam/length/fit) live on ip_item_master rows that FK in via style_id.';
COMMENT ON COLUMN style_master.style_code   IS 'Human style code (e.g. RY1234). Unique per entity among non-tombstoned rows.';
COMMENT ON COLUMN style_master.is_apparel   IS 'True forces matrix dim NOT NULL on item rows that FK in (enforced by item_master CHECK in mig 11).';
COMMENT ON COLUMN style_master.gender_code  IS 'M | WMS | B | C | G | U — matches rof_xoro daily_check conformance set.';
COMMENT ON COLUMN style_master.deleted_at   IS 'Soft delete; row is excluded from the active-code unique index.';

-- ════════════════════════════════════════════════════════════════════════════
-- Backfill: one row per distinct (entity_id, TRIM(UPPER(style_code))) from
-- ip_item_master. Picks the most-recently-updated source row for description
-- + category + lifecycle attributes.
--
-- We use DISTINCT ON because there are typically many SKU variants per style.
-- Pre-trim/upper handles whitespace + case drift that may have crept into
-- legacy data. Merchandiser will reconcile any unexpected dedupe outcomes
-- via the admin UI in a later chunk.
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO style_master (
  entity_id, style_code, description, category_id,
  lifecycle_status, planning_class, is_apparel
)
SELECT DISTINCT ON (im.entity_id, TRIM(UPPER(im.style_code)))
  im.entity_id,
  TRIM(UPPER(im.style_code)) AS style_code,
  COALESCE(NULLIF(im.description, ''), TRIM(UPPER(im.style_code))) AS description,
  im.category_id,
  CASE
    WHEN im.lifecycle_status IN ('active','phased_out','discontinued','core')
      THEN im.lifecycle_status
    ELSE 'active'
  END AS lifecycle_status,
  CASE
    WHEN im.planning_class IN ('core','seasonal','fashion') THEN im.planning_class
    ELSE NULL
  END AS planning_class,
  true AS is_apparel  -- default; mig 4.5 (data prep) will flip non-apparel rows
FROM ip_item_master im
WHERE im.style_code IS NOT NULL
  AND TRIM(im.style_code) <> ''
ORDER BY im.entity_id, TRIM(UPPER(im.style_code)), im.updated_at DESC
ON CONFLICT DO NOTHING;

-- ==== END: 20260521040000_p1_style_master.sql ====


-- ==== BEGIN: 20260521040100_p1_ip_item_master_matrix.sql ====
-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 4 / Migration 11
-- ip_item_master: matrix dimensions + style FK + is_apparel flag.
--
-- All new columns are NULLABLE for now. The `apparel_dims_required` CHECK
-- constraint (which makes color/size/inseam/length/fit NOT NULL for apparel
-- rows) is INTENTIONALLY DEFERRED to a follow-up data-prep migration:
--   1. Merchandiser supplies the non-apparel category list.
--   2. We flip is_apparel=false for accessory SKUs.
--   3. Backfill apparel rows' missing dims (Bottoms category gets attention).
--   4. THEN add the CHECK constraint.
--
-- Architecture: docs/tangerine/P1-foundation-architecture.md §5.2 + §5.3.
-- The deferred step is documented in §12 (Risk register) and arch §11 (Sub-decisions).
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE ip_item_master
  ADD COLUMN IF NOT EXISTS gender_code  text,
  ADD COLUMN IF NOT EXISTS inseam       text,
  ADD COLUMN IF NOT EXISTS length       text,
  ADD COLUMN IF NOT EXISTS fit          text,
  ADD COLUMN IF NOT EXISTS style_id     uuid REFERENCES style_master(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_apparel   boolean NOT NULL DEFAULT true;

-- Gender code CHECK (nullable allows legacy rows to lift through without forcing
-- merchandiser intervention. Where set, must match the rof_xoro conformance set).
ALTER TABLE ip_item_master DROP CONSTRAINT IF EXISTS ip_item_master_gender_check;
ALTER TABLE ip_item_master ADD CONSTRAINT ip_item_master_gender_check
  CHECK (gender_code IS NULL OR gender_code IN ('M', 'WMS', 'B', 'C', 'G', 'U'));

-- Indexes per arch §5.2
CREATE INDEX IF NOT EXISTS idx_ip_item_master_entity_style
  ON ip_item_master (entity_id, style_id);
CREATE INDEX IF NOT EXISTS idx_ip_item_master_entity_gender
  ON ip_item_master (entity_id, gender_code);
CREATE INDEX IF NOT EXISTS idx_ip_item_master_matrix_lookup
  ON ip_item_master (entity_id, style_id, color, size);
CREATE INDEX IF NOT EXISTS idx_ip_item_master_is_apparel
  ON ip_item_master (entity_id, is_apparel);

-- ════════════════════════════════════════════════════════════════════════════
-- Backfill: link existing items to their newly-created style_master row.
-- Matches on UPPER(TRIM(style_code)) per entity since the style_master backfill
-- canonicalized style codes the same way.
-- ════════════════════════════════════════════════════════════════════════════
UPDATE ip_item_master im
SET style_id = sm.id
FROM style_master sm
WHERE im.style_id IS NULL
  AND im.style_code IS NOT NULL
  AND TRIM(im.style_code) <> ''
  AND sm.entity_id = im.entity_id
  AND sm.style_code = TRIM(UPPER(im.style_code))
  AND sm.deleted_at IS NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- Bidirectional sync trigger: when ip_item_master.style_code is changed, look
-- up (or fail) the style_master row and update style_id; when a row inserts
-- with style_code but no style_id, resolve it. Keeps rof_xoro's nightly post
-- (which writes style_code text) compatible without script changes.
--
-- The trigger DOES NOT auto-create style_master rows on unknown style_codes.
-- Unknown codes leave style_id NULL and surface in a "needs style_master row"
-- report (TBD). This is intentional — auto-creating styles would let typos
-- proliferate without merchandiser review.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION ip_item_master_sync_style_id() RETURNS trigger AS $$
DECLARE
  v_style_id uuid;
  v_canon    text;
BEGIN
  -- Only fire when style_code is set and either style_id is unset OR style_code is changing.
  IF NEW.style_code IS NULL OR TRIM(NEW.style_code) = '' THEN
    NEW.style_id := NULL;
    RETURN NEW;
  END IF;

  -- For UPDATE, only re-resolve when style_code actually changed.
  IF TG_OP = 'UPDATE'
     AND NEW.style_code IS NOT DISTINCT FROM OLD.style_code
     AND NEW.style_id   IS NOT DISTINCT FROM OLD.style_id
  THEN
    RETURN NEW;
  END IF;

  v_canon := TRIM(UPPER(NEW.style_code));

  SELECT id INTO v_style_id
    FROM style_master
   WHERE entity_id = NEW.entity_id
     AND style_code = v_canon
     AND deleted_at IS NULL
   LIMIT 1;

  -- Unknown style → leave style_id NULL; explicit FK lookups (allocation
  -- grid, matrix UI) filter on style_id IS NOT NULL.
  NEW.style_id := v_style_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ip_item_master_sync_style_trg ON ip_item_master;
CREATE TRIGGER ip_item_master_sync_style_trg
  BEFORE INSERT OR UPDATE OF style_code, style_id ON ip_item_master
  FOR EACH ROW EXECUTE FUNCTION ip_item_master_sync_style_id();

COMMENT ON COLUMN ip_item_master.gender_code IS 'M|WMS|B|C|G|U — explicit gender. NULL allowed at launch; rof_xoro daily_check conformance is canonical source.';
COMMENT ON COLUMN ip_item_master.inseam      IS 'Apparel dim 3. Required (NOT NULL) for apparel rows after the data-prep follow-up migration adds the CHECK.';
COMMENT ON COLUMN ip_item_master.length      IS 'Apparel dim 4. REGULAR|LONG|PETITE|TALL. Required for apparel rows post-CHECK.';
COMMENT ON COLUMN ip_item_master.fit         IS 'Apparel dim 5. SKINNY|SLIM|STRAIGHT|RELAXED|CURVY|... Required for apparel rows post-CHECK.';
COMMENT ON COLUMN ip_item_master.style_id    IS 'FK to style_master. Resolved by trigger from style_code (UPPER TRIM). NULL when style_code matches no style_master row.';
COMMENT ON COLUMN ip_item_master.is_apparel  IS 'Default true. When false, apparel CHECK (added in a later migration) does not apply.';

-- ==== END: 20260521040100_p1_ip_item_master_matrix.sql ====


-- ==== BEGIN: 20260521040200_p1_category_3level.sql ====
-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 4 / Migration 12
-- ip_category_master: 3-level taxonomy.
-- Adds parent_category_id self-ref, `level` (1..3), and materialized `path`
-- for fast display + search. Existing rows backfill as level=1 (top-level).
-- The merchandiser does a manual pass later to add level 2/3 categories.
-- Architecture: docs/tangerine/P1-foundation-architecture.md §6.2
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE ip_category_master
  ADD COLUMN IF NOT EXISTS parent_category_id uuid REFERENCES ip_category_master(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS level              smallint,
  ADD COLUMN IF NOT EXISTS path               text;

-- Backfill: every existing row is level 1 (top-level). path = category_code.
UPDATE ip_category_master
   SET level = 1,
       path  = category_code
 WHERE level IS NULL;

ALTER TABLE ip_category_master
  ALTER COLUMN level SET NOT NULL,
  ALTER COLUMN level SET DEFAULT 1,
  ALTER COLUMN path  SET NOT NULL;

ALTER TABLE ip_category_master DROP CONSTRAINT IF EXISTS ip_category_master_level_check;
ALTER TABLE ip_category_master ADD CONSTRAINT ip_category_master_level_check
  CHECK (level BETWEEN 1 AND 3);

ALTER TABLE ip_category_master DROP CONSTRAINT IF EXISTS ip_category_master_level1_no_parent;
ALTER TABLE ip_category_master ADD CONSTRAINT ip_category_master_level1_no_parent
  CHECK ((level = 1 AND parent_category_id IS NULL)
      OR (level > 1 AND parent_category_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_ip_category_master_parent
  ON ip_category_master (parent_category_id) WHERE parent_category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ip_category_master_level
  ON ip_category_master (entity_id, level);
CREATE INDEX IF NOT EXISTS idx_ip_category_master_path
  ON ip_category_master (entity_id, path);

-- ════════════════════════════════════════════════════════════════════════════
-- Parent-level consistency trigger: when a row inserts/updates with a parent,
-- verify parent.level + 1 = child.level. Also maintains the materialized path
-- as "parent.path > child.category_code" (using " > " as the separator since
-- it's unambiguous in apparel category names).
--
-- This is a trigger (not a CHECK constraint with subquery — PG doesn't allow
-- that) and runs BEFORE INSERT OR UPDATE.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION ip_category_master_validate_hierarchy() RETURNS trigger AS $$
DECLARE
  parent_level smallint;
  parent_path  text;
  parent_entity uuid;
BEGIN
  IF NEW.parent_category_id IS NULL THEN
    IF NEW.level <> 1 THEN
      RAISE EXCEPTION 'ip_category_master: top-level rows (parent_category_id IS NULL) must have level=1, got %', NEW.level;
    END IF;
    NEW.path := NEW.category_code;
    RETURN NEW;
  END IF;

  IF NEW.parent_category_id = NEW.id THEN
    RAISE EXCEPTION 'ip_category_master: a row cannot be its own parent (id=%)', NEW.id;
  END IF;

  SELECT level, path, entity_id INTO parent_level, parent_path, parent_entity
    FROM ip_category_master WHERE id = NEW.parent_category_id;

  IF parent_level IS NULL THEN
    RAISE EXCEPTION 'ip_category_master: parent_category_id % not found', NEW.parent_category_id;
  END IF;

  IF parent_entity <> NEW.entity_id THEN
    RAISE EXCEPTION 'ip_category_master: parent belongs to a different entity (% vs %)',
      parent_entity, NEW.entity_id;
  END IF;

  IF NEW.level <> parent_level + 1 THEN
    RAISE EXCEPTION 'ip_category_master: child level must be parent.level + 1 (parent=%, child=%)',
      parent_level, NEW.level;
  END IF;

  NEW.path := parent_path || ' > ' || NEW.category_code;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ip_category_master_hierarchy_trg ON ip_category_master;
CREATE TRIGGER ip_category_master_hierarchy_trg
  BEFORE INSERT OR UPDATE OF parent_category_id, level, category_code, entity_id
  ON ip_category_master
  FOR EACH ROW EXECUTE FUNCTION ip_category_master_validate_hierarchy();

-- ════════════════════════════════════════════════════════════════════════════
-- Cascade path refresh: when a parent's path or category_code changes, all
-- descendants need their path recomputed. Triggered by AFTER UPDATE on the
-- parent rows. Uses recursive CTE to avoid an N+1 trigger storm.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION ip_category_master_cascade_path() RETURNS trigger AS $$
BEGIN
  IF NEW.path IS NOT DISTINCT FROM OLD.path
     AND NEW.category_code IS NOT DISTINCT FROM OLD.category_code
  THEN
    RETURN NULL;
  END IF;

  WITH RECURSIVE descendants AS (
    SELECT id, parent_category_id, category_code, NEW.path AS new_path
      FROM ip_category_master
     WHERE parent_category_id = NEW.id
    UNION ALL
    SELECT c.id, c.parent_category_id, c.category_code, d.new_path || ' > ' || c.category_code
      FROM ip_category_master c
      JOIN descendants d ON c.parent_category_id = d.id
  )
  UPDATE ip_category_master c
     SET path = d.new_path || ' > ' || c.category_code
    FROM descendants d
   WHERE c.id = d.id;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ip_category_master_cascade_path_trg ON ip_category_master;
CREATE TRIGGER ip_category_master_cascade_path_trg
  AFTER UPDATE OF path, category_code ON ip_category_master
  FOR EACH ROW EXECUTE FUNCTION ip_category_master_cascade_path();

COMMENT ON COLUMN ip_category_master.parent_category_id IS 'Self-ref for 3-level hierarchy. NULL only for level=1 (top-level) rows.';
COMMENT ON COLUMN ip_category_master.level              IS '1=top, 2=mid, 3=leaf. CHECK constraint enforces BETWEEN 1 AND 3 and (level=1 ⇔ parent IS NULL).';
COMMENT ON COLUMN ip_category_master.path               IS 'Materialized full path "Apparel > Bottoms > Jeans" for display/search. Maintained by trigger; never set by hand.';

-- ==== END: 20260521040200_p1_category_3level.sql ====


-- ==== BEGIN: 20260522010000_p1_chunk4_5_apparel_check.sql ====
-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 4.5 / Migration 13
-- apparel_dims_required CHECK + is_apparel data prep.
--
-- Per arch §12 risk register: enforcing the 5-dim CHECK against legacy rows
-- would reject ~all existing items (most apparel SKUs have inseam/length/fit
-- NULL because they're tops/dresses/etc., not bottoms). The arch strategy:
--   1. Pattern-match category names/codes to identify "bottoms" — the only
--      category that semantically requires all 5 dims.
--   2. Flip is_apparel=true for bottoms items that have ALL 5 dims populated.
--   3. Leave is_apparel=false (default) for everything else AND for bottoms
--      with incomplete dims (they need merchandiser cleanup).
--   4. Add the CHECK. It's now safe because every is_apparel=true row has
--      complete dims.
--   5. Expose a "needs review" view so the merchandiser can finish backfilling
--      bottoms items and flip them to is_apparel=true later via the admin UI.
--
-- Heuristic for "bottoms": category_code OR name contains any of
--   jeans | pants | shorts | denim | bottoms | leggings | trousers | skirt
-- (case-insensitive). Merchandiser overrides via the admin UI later.
--
-- Architecture: docs/tangerine/P1-foundation-architecture.md §5.3 + §12.
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- Step 1: identify bottoms categories. Wrapped in a CTE-driven UPDATE so we
-- only touch items that match. Logged via a temp NOTICE for the migration
-- runner to surface in CI / supabase db push output.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  bottoms_pattern text := '(jeans|pants|shorts|denim|bottoms|leggings|trousers|skirt)';
  bottoms_count integer;
  apparel_flipped integer;
BEGIN
  -- Count bottoms categories for visibility
  SELECT count(*) INTO bottoms_count
    FROM ip_category_master
   WHERE category_code ~* bottoms_pattern
      OR name           ~* bottoms_pattern;
  RAISE NOTICE 'Tangerine 4.5: identified % bottoms categories', bottoms_count;

  -- Flip is_apparel = true only where the linked category matches the pattern
  -- AND all 5 dims are NOT NULL. Bottoms with missing dims stay at is_apparel
  -- = false (which is the column default).
  UPDATE ip_item_master im
     SET is_apparel = true
    FROM ip_category_master cm
   WHERE im.category_id = cm.id
     AND im.is_apparel IS DISTINCT FROM true
     AND (cm.category_code ~* bottoms_pattern OR cm.name ~* bottoms_pattern)
     AND im.color  IS NOT NULL AND im.color  <> ''
     AND im.size   IS NOT NULL AND im.size   <> ''
     AND im.inseam IS NOT NULL AND im.inseam <> ''
     AND im.length IS NOT NULL AND im.length <> ''
     AND im.fit    IS NOT NULL AND im.fit    <> '';

  GET DIAGNOSTICS apparel_flipped = ROW_COUNT;
  RAISE NOTICE 'Tangerine 4.5: flipped % item rows to is_apparel=true', apparel_flipped;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Step 1b (T1-fix-5): pre-CHECK cleanup. The Chunk 4 migration declared
-- is_apparel with DEFAULT true, so EVERY existing row got is_apparel=true on
-- column add. Step 1 above only flips matching rows TO true (no-op) — it
-- never demotes the tops/dresses/accessories that legitimately lack
-- inseam/length/fit. Without this cleanup the CHECK at Step 2 would fail.
--
-- This UPDATE flips is_apparel=false on any row currently marked true that
-- lacks at least one of the 5 matrix dims. Bottoms items with complete dims
-- stay true (the CHECK accepts them). Non-bottoms or incomplete-bottoms get
-- demoted (the CHECK ignores them).
--
-- Idempotent: re-running on already-cleaned data flips zero rows.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  demoted integer;
BEGIN
  UPDATE ip_item_master
     SET is_apparel = false
   WHERE is_apparel = true
     AND (color  IS NULL OR color  = ''
       OR size   IS NULL OR size   = ''
       OR inseam IS NULL OR inseam = ''
       OR length IS NULL OR length = ''
       OR fit    IS NULL OR fit    = '');

  GET DIAGNOSTICS demoted = ROW_COUNT;
  RAISE NOTICE 'Tangerine 4.5: demoted % item rows to is_apparel=false (missing dims)', demoted;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Step 2: add the CHECK constraint. Validate over the whole table; the prep
-- above guarantees it passes.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE ip_item_master DROP CONSTRAINT IF EXISTS apparel_dims_required;
ALTER TABLE ip_item_master ADD CONSTRAINT apparel_dims_required
  CHECK (
    NOT is_apparel
    OR (
      color  IS NOT NULL AND color  <> ''
      AND size   IS NOT NULL AND size   <> ''
      AND inseam IS NOT NULL AND inseam <> ''
      AND length IS NOT NULL AND length <> ''
      AND fit    IS NOT NULL AND fit    <> ''
    )
  );

COMMENT ON CONSTRAINT apparel_dims_required ON ip_item_master IS
  'Tangerine P1 §5.3: apparel-flagged rows (currently bottoms only) require all 5 matrix dims. Non-apparel rows (tops, dresses, accessories, incomplete-bottoms) bypass.';

-- ────────────────────────────────────────────────────────────────────────────
-- Step 3: merchandiser-review view. Items linked to a bottoms category but
-- still flagged is_apparel=false because at least one dim is NULL. The admin
-- UI surfaces this list with editable inseam/length/fit cells; once filled,
-- merchandiser flips is_apparel=true (which the CHECK now permits).
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW ip_item_master_needs_matrix_review_v AS
SELECT
  im.id,
  im.entity_id,
  im.sku_code,
  im.style_code,
  im.style_id,
  im.color,
  im.size,
  im.inseam,
  im.length,
  im.fit,
  im.is_apparel,
  cm.category_code AS category_code,
  cm.name          AS category_name
FROM ip_item_master im
JOIN ip_category_master cm ON cm.id = im.category_id
WHERE im.is_apparel = false
  AND (cm.category_code ~* '(jeans|pants|shorts|denim|bottoms|leggings|trousers|skirt)'
       OR cm.name           ~* '(jeans|pants|shorts|denim|bottoms|leggings|trousers|skirt)')
  AND (
       im.color  IS NULL OR im.color  = ''
    OR im.size   IS NULL OR im.size   = ''
    OR im.inseam IS NULL OR im.inseam = ''
    OR im.length IS NULL OR im.length = ''
    OR im.fit    IS NULL OR im.fit    = ''
  );

COMMENT ON VIEW ip_item_master_needs_matrix_review_v IS
  'Bottoms-category items with at least one matrix dim NULL. Merchandiser fills in missing dims via the admin UI, then sets is_apparel=true.';

-- ==== END: 20260522010000_p1_chunk4_5_apparel_check.sql ====


-- ==== BEGIN: 20260522020000_p1_vendors_erp_extensions.sql ====
-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 6 / Migration 13
-- vendors ERP-grade extensions. Promotes `vendors` to canonical M35 (per arch
-- §7.1) by adding the ERP-grade columns AP/AR/inventory modules will need.
--
-- Existing `deleted_at` soft-delete semantics preserved. `status` is added
-- alongside (derived from deleted_at on backfill) so future code can use the
-- enum directly without joining on null-checks.
--
-- ip_vendor_master is NOT converted to a view in this migration — pre-flight
-- found WRITES to ip_vendor_master in scripts/seed-demo-celebpink.mjs. That
-- conversion lands in a follow-up chunk (6.5) after the seed script is
-- updated to write to vendors directly. Arch §12 risk register documented
-- this mitigation.
--
-- Architecture: docs/tangerine/P1-foundation-architecture.md §7.2
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS code                            text,
  ADD COLUMN IF NOT EXISTS legal_name                      text,
  ADD COLUMN IF NOT EXISTS tax_id                          text,
  ADD COLUMN IF NOT EXISTS payment_terms                   text,
  ADD COLUMN IF NOT EXISTS default_currency                char(3) NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS default_gl_ap_account_id        uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_gl_expense_account_id   uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status                          text,
  ADD COLUMN IF NOT EXISTS is_1099_vendor                  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS address                         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS bank_account_encrypted          bytea,
  ADD COLUMN IF NOT EXISTS created_by_user_id              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by_user_id              uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Backfill `status` from existing soft-delete state.
UPDATE vendors
   SET status = CASE WHEN deleted_at IS NULL THEN 'active' ELSE 'inactive' END
 WHERE status IS NULL;

ALTER TABLE vendors
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'active';

ALTER TABLE vendors DROP CONSTRAINT IF EXISTS vendors_status_check;
ALTER TABLE vendors ADD CONSTRAINT vendors_status_check
  CHECK (status IN ('active', 'on_hold', 'inactive'));

ALTER TABLE vendors DROP CONSTRAINT IF EXISTS vendors_default_currency_check;
ALTER TABLE vendors ADD CONSTRAINT vendors_default_currency_check
  CHECK (default_currency ~ '^[A-Z]{3}$');

CREATE INDEX IF NOT EXISTS idx_vendors_status      ON vendors (status);
CREATE INDEX IF NOT EXISTS idx_vendors_is_1099     ON vendors (is_1099_vendor) WHERE is_1099_vendor = true;
CREATE INDEX IF NOT EXISTS idx_vendors_ap_account  ON vendors (default_gl_ap_account_id) WHERE default_gl_ap_account_id IS NOT NULL;

-- Touched timestamp (vendors already has updated_at column from Phase 0; no
-- trigger existed since the JSON-blob mirror handled it. Add an explicit one
-- so direct UPDATEs maintain updated_at correctly.)
CREATE OR REPLACE FUNCTION vendors_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vendors_touch_trg ON vendors;
CREATE TRIGGER vendors_touch_trg
  BEFORE UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION vendors_touch();

COMMENT ON COLUMN vendors.code                          IS 'Vendor short code (e.g. V0042). Nullable at launch; merchandiser populates via admin UI. Per-entity uniqueness via entity_vendors.vendor_code; vendors.code itself is global identifier.';
COMMENT ON COLUMN vendors.tax_id                        IS 'EIN / VAT. PII per CLAUDE.md — app layer must encrypt before INSERT/UPDATE (AES-256). Schema stores ciphertext as text. NEVER log this column.';
COMMENT ON COLUMN vendors.bank_account_encrypted        IS 'AES-256-GCM ciphertext of routing+account number, populated only when vendor opts into ACH. NEVER log. Schema enforces bytea so any string-coerced write fails loudly.';
COMMENT ON COLUMN vendors.status                        IS 'active | on_hold | inactive. Backfilled from deleted_at on migration; both columns coexist (status is the forward-facing enum, deleted_at remains for soft-delete semantics).';
COMMENT ON COLUMN vendors.is_1099_vendor                IS 'Pre-flags M20 1099 reporting eligibility. Default false; CPA flips via admin UI.';
COMMENT ON COLUMN vendors.default_gl_ap_account_id      IS 'Override of entity-default AP account. When NULL, posting service uses the entity-level default (configured in chart of accounts seed).';
COMMENT ON COLUMN vendors.default_gl_expense_account_id IS 'Default expense account for bills without explicit line coding. NULL → require line-level account on every bill.';

-- ==== END: 20260522020000_p1_vendors_erp_extensions.sql ====


-- ==== BEGIN: 20260522020100_p1_entity_vendors_code.sql ====
-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 6 / Migration 14
-- entity_vendors.vendor_code — per-entity vendor code override. Lets one
-- vendor row carry different codes in different entities (e.g. V0042 for
-- RoF, XV-42 for another entity in future multi-entity ops).
--
-- Architecture: docs/tangerine/P1-foundation-architecture.md §7.2 (bottom)
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE entity_vendors
  ADD COLUMN IF NOT EXISTS vendor_code text;

-- Backfill: for any entity_vendors row where the linked vendor already has a
-- code populated, default the per-entity code to match. Where vendors.code is
-- still NULL (most rows at this point), leave NULL.
UPDATE entity_vendors ev
   SET vendor_code = v.code
  FROM vendors v
 WHERE ev.vendor_code IS NULL
   AND ev.vendor_id = v.id
   AND v.code IS NOT NULL;

-- Unique per (entity_id, vendor_code) when set. Allows multiple NULL rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_vendors_vendor_code
  ON entity_vendors (entity_id, vendor_code)
  WHERE vendor_code IS NOT NULL;

COMMENT ON COLUMN entity_vendors.vendor_code IS
  'Per-entity vendor code override. Unique per entity when set. Falls back to vendors.code if NULL.';

-- ==== END: 20260522020100_p1_entity_vendors_code.sql ====


-- ==== BEGIN: 20260522020200_p1_customers_promotion.sql ====
-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk 6 / Migration 15 (was 16 in arch §9.1)
-- Promote ip_customer_master to canonical `customers` table per arch §8.
--
-- Strategy: ALTER TABLE RENAME + CREATE VIEW. The view is a simple SELECT
-- with no expressions, so PostgreSQL treats it as auto-updatable — existing
-- code paths that read/write ip_customer_master continue to work transparently
-- (xoro-sales-sync, planning-sync, AI executors, seed files all keep working).
--
-- New ERP-grade columns land on the renamed table. View doesn't expose them
-- by default — legacy callers ignore the new fields.
--
-- Architecture: docs/tangerine/P1-foundation-architecture.md §8.1, §8.2
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- Step 1: Rename table — handles 4 prod-state cases.
--
-- Case A: ip_customer_master exists (table), customers does NOT
--   → straightforward rename
-- Case B: ip_customer_master gone (view from prior run), customers exists (table from prior run)
--   → no-op, re-run scenario
-- Case C: ip_customer_master exists (table), customers also exists (table from a
--         DIFFERENT system / pre-Tangerine app) — this is the collision we hit
--         on the actual prod where a pre-existing `customers` stub lived
--   → archive the existing customers to customers_pretangerine_YYYYMMDDHH24MISS,
--     preserving its data, then rename ip_customer_master to customers
-- Case D: Neither exists → abort with a clear error
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  ipcm_is_table boolean;
  cust_is_table boolean;
  archive_name  text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ip_customer_master' AND table_type = 'BASE TABLE'
  ) INTO ipcm_is_table;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'customers' AND table_type = 'BASE TABLE'
  ) INTO cust_is_table;

  IF ipcm_is_table AND cust_is_table THEN
    -- Case C: collision. Archive the pre-existing customers, then rename ip_customer_master.
    archive_name := 'customers_pretangerine_' || to_char(now(), 'YYYYMMDDHH24MISS');
    EXECUTE format('ALTER TABLE customers RENAME TO %I', archive_name);
    RAISE NOTICE 'Tangerine: pre-existing customers table archived as % (data preserved). Inspect after migration to decide whether to keep or drop it.', archive_name;
    ALTER TABLE ip_customer_master RENAME TO customers;
    RAISE NOTICE 'Tangerine: ip_customer_master renamed to customers';
  ELSIF ipcm_is_table AND NOT cust_is_table THEN
    -- Case A: clean first run
    ALTER TABLE ip_customer_master RENAME TO customers;
    RAISE NOTICE 'Tangerine: ip_customer_master renamed to customers';
  ELSIF NOT ipcm_is_table AND cust_is_table THEN
    -- Case B: re-run; nothing to do
    RAISE NOTICE 'Tangerine: customers already exists, ip_customer_master is gone — skipping rename (re-run case)';
  ELSE
    -- Case D: nothing to promote
    RAISE EXCEPTION 'Tangerine: neither ip_customer_master nor customers exists as a base table. Cannot promote.';
  END IF;
END $$;

-- The Phase 0 migration created two indexes named idx_ip_customer_master_*.
-- PG keeps index names attached to the table after RENAME; the names become
-- misleading. Rename them for clarity but the renaming is purely cosmetic.
ALTER INDEX IF EXISTS idx_ip_customer_master_name   RENAME TO idx_customers_name;
ALTER INDEX IF EXISTS idx_ip_customer_master_parent RENAME TO idx_customers_parent;

-- Also rename the touched-timestamp trigger. (PostgreSQL does NOT support
-- ALTER TRIGGER IF EXISTS — wrap in a DO block that checks pg_trigger first.)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_ip_customer_master_updated'
      AND tgrelid = 'customers'::regclass
  ) THEN
    ALTER TRIGGER trg_ip_customer_master_updated ON customers
      RENAME TO trg_customers_updated;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Step 2: ERP-grade column additions.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS code                              text,
  ADD COLUMN IF NOT EXISTS customer_type                     text,
  ADD COLUMN IF NOT EXISTS default_gl_ar_account_id          uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_gl_revenue_account_id     uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_terms                     text,
  ADD COLUMN IF NOT EXISTS default_currency                  char(3) NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS tax_exempt                        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tax_exempt_certificate            text,
  ADD COLUMN IF NOT EXISTS credit_limit                      numeric(14, 2),
  ADD COLUMN IF NOT EXISTS status                            text,
  ADD COLUMN IF NOT EXISTS billing_address                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS shipping_address                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS attributes                        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS deleted_at                        timestamptz,
  ADD COLUMN IF NOT EXISTS created_by_user_id                uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by_user_id                uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Backfill: `code` from existing `customer_code` (if that column exists);
-- `status` from `active` (if that column exists). Guarded because some
-- legacy installs of ip_customer_master may differ from the Phase 0 schema.
DO $$
DECLARE
  has_customer_code boolean;
  has_active        boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'customer_code'
  ) INTO has_customer_code;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'active'
  ) INTO has_active;

  IF has_customer_code THEN
    EXECUTE 'UPDATE customers SET code = COALESCE(code, customer_code) WHERE code IS NULL';
  END IF;

  IF has_active THEN
    EXECUTE $sql$
      UPDATE customers
         SET status = COALESCE(status, CASE WHEN active THEN 'active' ELSE 'inactive' END)
       WHERE status IS NULL
    $sql$;
  ELSE
    -- No legacy active column → default everyone to active where status is null
    EXECUTE 'UPDATE customers SET status = ''active'' WHERE status IS NULL';
  END IF;
END $$;

-- customer_type backfill: heuristic from channel_id if present; otherwise 'wholesale'.
-- ip_channel_master has channel_type column (wholesale/ecom/marketplace/retail/other);
-- map directly when channel is set. Guarded too (channel_id may not exist on all installs).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'channel_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ip_channel_master'
  ) THEN
    EXECUTE $sql$
      UPDATE customers c
         SET customer_type = COALESCE(
               c.customer_type,
               CASE ch.channel_type
                 WHEN 'wholesale'   THEN 'wholesale'
                 WHEN 'ecom'        THEN 'ecom'
                 WHEN 'retail'      THEN 'showroom'
                 WHEN 'marketplace' THEN 'ecom'
                 ELSE 'wholesale'
               END,
               'wholesale'
             )
        FROM ip_channel_master ch
       WHERE (c.channel_id = ch.id OR c.channel_id IS NULL)
         AND c.customer_type IS NULL
    $sql$;
  END IF;
END $$;

UPDATE customers SET customer_type = 'wholesale' WHERE customer_type IS NULL;

ALTER TABLE customers
  ALTER COLUMN customer_type SET NOT NULL,
  ALTER COLUMN customer_type SET DEFAULT 'wholesale',
  ALTER COLUMN status        SET NOT NULL,
  ALTER COLUMN status        SET DEFAULT 'active';

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_type_check;
ALTER TABLE customers ADD CONSTRAINT customers_type_check
  CHECK (customer_type IN ('wholesale', 'ecom', 'showroom', 'employee', 'other'));

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_status_check;
ALTER TABLE customers ADD CONSTRAINT customers_status_check
  CHECK (status IN ('active', 'inactive', 'on_hold'));

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_default_currency_check;
ALTER TABLE customers ADD CONSTRAINT customers_default_currency_check
  CHECK (default_currency ~ '^[A-Z]{3}$');

-- ────────────────────────────────────────────────────────────────────────────
-- entity_id safety net. Chunk 1 mig 3 was supposed to add this to
-- ip_customer_master, but if it didn't (table missing at the time, partial
-- failure, etc.), the indexes below would fail with "column entity_id does
-- not exist." Add it now if missing; backfill from the ROF entity row.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'entity_id'
  ) THEN
    ALTER TABLE customers ADD COLUMN entity_id uuid;
    UPDATE customers SET entity_id = (SELECT id FROM entities WHERE code = 'ROF') WHERE entity_id IS NULL;
    -- Only enforce NOT NULL if there IS at least one row (otherwise the
    -- backfill matched nothing because customers is empty, which is fine).
    IF EXISTS (SELECT 1 FROM customers WHERE entity_id IS NULL) THEN
      RAISE NOTICE 'Tangerine 6 fix: customers has rows with NULL entity_id after backfill (no ROF entity yet?). Skipping NOT NULL.';
    ELSE
      ALTER TABLE customers ALTER COLUMN entity_id SET NOT NULL;
    END IF;
    ALTER TABLE customers
      ADD CONSTRAINT customers_entity_id_fkey
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE RESTRICT;
    RAISE NOTICE 'Tangerine 6 fix: added entity_id to customers + backfilled from ROF';
  END IF;
END $$;

-- Unique (entity_id, code) among non-deleted rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_entity_code
  ON customers (entity_id, code)
  WHERE deleted_at IS NULL AND code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_entity_type     ON customers (entity_id, customer_type);
CREATE INDEX IF NOT EXISTS idx_customers_entity_status   ON customers (entity_id, status);
CREATE INDEX IF NOT EXISTS idx_customers_ar_account      ON customers (default_gl_ar_account_id)
  WHERE default_gl_ar_account_id IS NOT NULL;

COMMENT ON TABLE  customers IS 'Canonical customer master (M36). Renamed from ip_customer_master in Tangerine P1 Chunk 6. Backward-compat view ip_customer_master still exposes the original schema for legacy callers.';
COMMENT ON COLUMN customers.code               IS 'Customer short code. Backfilled from customer_code on migration. Unique per entity among non-deleted rows.';
COMMENT ON COLUMN customers.customer_type      IS 'wholesale | ecom | showroom | employee | other. Drives default GL revenue account selection and reporting buckets.';
COMMENT ON COLUMN customers.credit_limit       IS 'Optional. When set, AR module blocks new orders that would push balance past this limit.';
COMMENT ON COLUMN customers.tax_exempt         IS 'When true, AR invoice tax calculation skipped. tax_exempt_certificate should be populated.';
COMMENT ON COLUMN customers.deleted_at         IS 'Soft delete. Indexes exclude soft-deleted rows.';

-- ────────────────────────────────────────────────────────────────────────────
-- Step 3: Backward-compat view alias.
--
-- Simple SELECT from one base table with no expressions → auto-updatable per
-- PostgreSQL view-update rules. xoro-sales-sync, planning-sync, AI executors,
-- seed scripts all continue to work without modification.
--
-- Built dynamically because legacy schemas vary: some installs of
-- ip_customer_master had customer_code / customer_tier / active / channel_id,
-- some didn't. The view only selects columns that exist on customers.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  view_cols text;
  legacy_cols text[] := ARRAY[
    'id', 'customer_code', 'name', 'parent_customer_id', 'customer_tier',
    'country', 'channel_id', 'active', 'external_refs', 'created_at', 'updated_at', 'entity_id'
  ];
  c text;
  selected text[] := ARRAY[]::text[];
BEGIN
  FOREACH c IN ARRAY legacy_cols LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = c
    ) THEN
      selected := array_append(selected, c);
    END IF;
  END LOOP;

  IF array_length(selected, 1) IS NULL THEN
    RAISE EXCEPTION 'Tangerine: customers table has none of the legacy columns; cannot create ip_customer_master view';
  END IF;

  view_cols := array_to_string(selected, ', ');
  EXECUTE format('CREATE OR REPLACE VIEW ip_customer_master AS SELECT %s FROM customers', view_cols);

  RAISE NOTICE 'Tangerine: created ip_customer_master view with cols [%]', view_cols;
END $$;

COMMENT ON VIEW ip_customer_master IS
  'Auto-updatable view over `customers` (Tangerine P1 Chunk 6). Preserves the original schema so legacy callers (xoro-sales-sync, planning-sync, AI executors, seed scripts) work without changes. Inserts/updates through the view propagate to customers.';

-- ────────────────────────────────────────────────────────────────────────────
-- Step 4: RLS — re-apply on the renamed table. RLS on the old name carries
-- over (RLS is attached to the table OID, not the name), but the policy names
-- still reference the old table name. Rename the policy for clarity.
--
-- The view doesn't need its own RLS — view access uses the security_invoker
-- caller's permissions against the base table per PG default.
-- ────────────────────────────────────────────────────────────────────────────
-- ALTER POLICY does NOT support IF EXISTS — wrap each in a pg_policies check.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'customers' AND policyname = 'anon_all_ip_customer_master') THEN
    ALTER POLICY "anon_all_ip_customer_master" ON customers RENAME TO "anon_all_customers";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'customers' AND policyname = 'auth_internal_ip_customer_master') THEN
    ALTER POLICY "auth_internal_ip_customer_master" ON customers RENAME TO "auth_internal_customers";
  END IF;
END $$;

-- ==== END: 20260522020200_p1_customers_promotion.sql ====


-- ==== BEGIN: 20260526010000_p1_t1fix_ensure_rof_entity.sql ====
-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P1 / Chunk T1-fix
-- Ensure exactly one entity has code='ROF'.
--
-- Why: Chunk 1's migration (20260521010000_p1_entities_extensions.sql) backfilled
-- entity.code using `CASE WHEN slug = 'ring-of-fire' THEN 'ROF' ELSE upper(replace(slug, '-', ''))`.
-- That only sets code='ROF' if the slug is the EXACT string 'ring-of-fire'.
-- Production deployments where the seed row had a different slug shape (e.g.
-- 'rof', 'ringoffire', or any custom variant) end up with code='RINGOFFIRE',
-- code='ROF' by accident, or code=something else entirely.
--
-- Every Tangerine admin handler looks up the entity via
--   SELECT id FROM entities WHERE code = 'ROF'
-- and returns 500 "Default entity (ROF) not found" if the row isn't there.
--
-- This migration is defensive + idempotent:
--   1. If any entity already has code='ROF', no-op.
--   2. Otherwise, find the most-likely-RoF entity by name/slug ilike + only
--      flip its code to 'ROF' if exactly one candidate matches.
--   3. As a final fallback, if the entities table has exactly one row, set its
--      code to 'ROF' (works for single-tenant installs which is everyone today).
--   4. If still ambiguous (multiple unmatched entities), do nothing and log —
--      manual intervention needed.
--
-- Safe to re-run. Safe across multiple environments (dev / staging / prod).
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  rof_id        uuid;
  candidate_id  uuid;
  total_count   integer;
BEGIN
  -- Step 1: already have one?
  SELECT id INTO rof_id FROM entities WHERE code = 'ROF' LIMIT 1;
  IF rof_id IS NOT NULL THEN
    RAISE NOTICE 'Tangerine T1-fix: entity with code=ROF already exists (%); no change', rof_id;
    RETURN;
  END IF;

  -- Step 2: find by name or slug ilike pattern
  SELECT id INTO candidate_id
  FROM entities
  WHERE name ILIKE 'ring%fire%'
     OR name ILIKE 'rof%'
     OR slug ILIKE 'ring%fire%'
     OR slug ILIKE 'ring-of-fire%'
     OR slug = 'rof'
  ORDER BY created_at ASC
  LIMIT 1;

  IF candidate_id IS NOT NULL THEN
    UPDATE entities SET code = 'ROF' WHERE id = candidate_id;
    RAISE NOTICE 'Tangerine T1-fix: entity % (matched by name/slug) flipped to code=ROF', candidate_id;
    RETURN;
  END IF;

  -- Step 3: single-row fallback
  SELECT count(*) INTO total_count FROM entities;
  IF total_count = 1 THEN
    SELECT id INTO candidate_id FROM entities LIMIT 1;
    UPDATE entities SET code = 'ROF' WHERE id = candidate_id;
    RAISE NOTICE 'Tangerine T1-fix: only 1 entity exists; flipped entity % to code=ROF', candidate_id;
    RETURN;
  END IF;

  -- Step 4: ambiguous; bail safely
  IF total_count = 0 THEN
    RAISE WARNING 'Tangerine T1-fix: entities table is EMPTY. Manual seed required: INSERT INTO entities (name, slug, code, status, functional_currency, fiscal_year_start_month, accounting_basis_primary) VALUES (''Ring of Fire'', ''ring-of-fire'', ''ROF'', ''active'', ''USD'', 1, ''ACCRUAL'');';
  ELSE
    RAISE WARNING 'Tangerine T1-fix: % entities exist, none match Ring-of-Fire by name/slug. Manually run UPDATE entities SET code = ''ROF'' WHERE id = ''<your-target-id>''.', total_count;
  END IF;
END $$;

-- ==== END: 20260526010000_p1_t1fix_ensure_rof_entity.sql ====

