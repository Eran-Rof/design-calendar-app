-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P13-1 — Procurement schema (D19 receipt-rollup workflow)
--
-- First chunk of P13 (Procurement — see
-- docs/tangerine/P13-procurement-architecture.md). Operator-confirmed
-- decisions:
--   • D14 OCR confidence threshold = 80 percent (High)
--   • D18 Pilot vendor = Zhejiang Zhuji Newdan Garment Co., Ltd.
--   • D9  Strict landed cost capture at receipt
--   • D19 (NEW arch amendment) Receipt-time landed-cost rollup workflow
--        with auto-AP-invoice generation + bookkeeper approval gate.
--
-- D19 workflow summary: at receipt close, the receiving user adds N rollup
-- lines — each is (expense GL account, amount, optional vendor, capitalize
-- boolean). The system auto-creates an AP invoice for each rollup with
-- status='pending_bookkeeper_approval' (it does NOT post to GL until a
-- bookkeeper-role user approves). Capitalize=true rollups fold into
-- tanda_po_receipts.landed_cost_cents so the inventory layer's
-- unit_cost_cents is correct from day one.
--
-- This chunk = SCHEMA ONLY. Handlers (rollup save endpoint, auto-AP
-- generation service, bookkeeper approval queue API) land in P13-3 + P13-4.
--
-- Tables (all idempotent CREATE TABLE IF NOT EXISTS):
--   1. tanda_po_receipts                  — receipt header + landed_cost (D19)
--   2. tanda_po_receipt_lines             — per-line received qty + landed unit cost
--   3. tanda_po_receipt_rollups           — D19 expense rollups + auto-AP link
--   4. tanda_po_qc_inspections            — M26 inspection header
--   5. tanda_po_qc_findings               — M26 inspection findings
--   6. vendor_compliance_certifications   — M48 vendor cert tracking
--   7. import_documentation               — M48 commercial-invoice / 7501 docs
--
-- Plus:
--   • tanda_pos extensions (D1 reuse-not-new): originated_by_employee_id,
--     procurement_status, expected_landed_cost_cents, actual_landed_cost_cents,
--     pilot_vendor_flag (D18 marker).
--   • invoices extensions (D19): is_receipt_rollup boolean,
--     rollup_parent_receipt_id uuid → tanda_po_receipts(id),
--     status CHECK extended to add 'pending_bookkeeper_approval'.
--   • RLS template (anon_all_* + auth_internal_*) on all 7 new tables.
--   • NOTIFY pgrst, 'reload schema' at the tail.
--
-- Fully idempotent: CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT for the invoices.status
-- extension, DO-block + EXCEPTION WHEN duplicate_object for RLS policies.
-- No COMMENT-concat (the migrations-comment-concat lint catches `IS 'a' || 'b'`).
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. tanda_pos extensions (D1 — reuse not new) ────────────────────────
--
-- Five new columns on the existing tanda_pos table per D1 (reuse-not-new).
-- D18 pilot_vendor_flag marks the operator-selected pilot vendor's POs
-- (Zhejiang Zhuji Newdan Garment Co., Ltd.) for the parallel-run cycle.

ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS originated_by_employee_id uuid
  REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS procurement_status text;
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS expected_landed_cost_cents bigint;
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS actual_landed_cost_cents bigint;
ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS pilot_vendor_flag boolean NOT NULL DEFAULT false;

-- ─── 2. tanda_po_receipts ───────────────────────────────────────────────
--
-- Tangerine-native receipt header. One row per dated receipt event against
-- a tanda_pos. landed_cost_cents is computed as sum of capitalize=true
-- rollups (D19); set by the rollup-save service in P13-3.

CREATE TABLE IF NOT EXISTS tanda_po_receipts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
                              REFERENCES entities(id) ON DELETE RESTRICT,
  tanda_po_id              uuid NOT NULL REFERENCES tanda_pos(id) ON DELETE RESTRICT,
  receipt_date             date NOT NULL,
  received_by_employee_id  uuid REFERENCES employees(id) ON DELETE SET NULL,
  status                   text NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft','pending_approval','approved','posted')),
  landed_cost_cents        bigint NOT NULL DEFAULT 0,
  notes                    text,
  je_id                    uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tanda_po_receipts_po_idx
  ON tanda_po_receipts (tanda_po_id, receipt_date DESC);

-- ─── 3. tanda_po_receipt_lines ──────────────────────────────────────────
--
-- Per-line received qty + accepted/rejected + pre-rollup unit cost and
-- post-rollup landed unit cost. inventory_layer_id populated by the
-- posting service when receipt.status → 'posted'.

CREATE TABLE IF NOT EXISTS tanda_po_receipt_lines (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id               uuid NOT NULL REFERENCES tanda_po_receipts(id) ON DELETE CASCADE,
  po_line_item_id          uuid NOT NULL REFERENCES po_line_items(id) ON DELETE RESTRICT,
  qty_received             int NOT NULL CHECK (qty_received > 0),
  qty_accepted             int NOT NULL CHECK (qty_accepted >= 0),
  qty_rejected             int NOT NULL DEFAULT 0,
  unit_cost_cents          bigint NOT NULL CHECK (unit_cost_cents >= 0),
  landed_unit_cost_cents   bigint,
  inventory_location_id    uuid REFERENCES inventory_locations(id) ON DELETE SET NULL,
  inventory_layer_id       uuid REFERENCES inventory_layers(id) ON DELETE SET NULL,
  raw_payload              jsonb,
  UNIQUE (receipt_id, po_line_item_id)
);

-- ─── 4. tanda_po_receipt_rollups ────────────────────────────────────────
--
-- D19 — landed-cost rollups with auto-AP-invoice link. Each rollup row
-- represents one additional expense (freight, duty, broker fee,
-- inspection, etc.) that the receiving user folds into the receipt.
-- auto_invoice_id points at the AP invoice the rollup-save service
-- generates (the AP row is created in status='pending_bookkeeper_approval'
-- and does NOT post to GL until approved).

CREATE TABLE IF NOT EXISTS tanda_po_receipt_rollups (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
                                 REFERENCES entities(id) ON DELETE RESTRICT,
  receipt_id                  uuid NOT NULL REFERENCES tanda_po_receipts(id) ON DELETE CASCADE,
  expense_gl_account_id       uuid NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  amount_cents                bigint NOT NULL CHECK (amount_cents > 0),
  vendor_id                   uuid REFERENCES vendors(id) ON DELETE SET NULL,
  description                 text NOT NULL,
  capitalized_to_inventory    boolean NOT NULL DEFAULT true,
  auto_invoice_id             uuid REFERENCES invoices(id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tanda_po_receipt_rollups_receipt_idx
  ON tanda_po_receipt_rollups (receipt_id);
CREATE INDEX IF NOT EXISTS tanda_po_receipt_rollups_invoice_idx
  ON tanda_po_receipt_rollups (auto_invoice_id);

-- ─── 5. invoices extensions (D19 — auto-AP + bookkeeper approval gate) ──
--
-- Two new columns on the existing invoices table for D19:
--   • is_receipt_rollup       — true when this AP invoice was auto-created
--                                by the receipt-rollup-save service
--   • rollup_parent_receipt_id — FK back to the tanda_po_receipts row that
--                                spawned this AP invoice
-- Plus extend the status CHECK to add 'pending_bookkeeper_approval' (the
-- default status auto-created rollup invoices land in; the bookkeeper
-- approval queue lists these and a bookkeeper-role user approves them
-- before the P3 AP posting service runs).

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_receipt_rollup boolean NOT NULL DEFAULT false;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS rollup_parent_receipt_id uuid
  REFERENCES tanda_po_receipts(id) ON DELETE SET NULL;

-- Extend invoices.status CHECK additively (preserves all existing values
-- per CURRENT-SCHEMA: 'submitted','under_review','approved','paid',
-- 'rejected','disputed') and adds 'pending_bookkeeper_approval' for D19.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN (
    'submitted',
    'under_review',
    'approved',
    'paid',
    'rejected',
    'disputed',
    'pending_bookkeeper_approval'
  ));

CREATE INDEX IF NOT EXISTS idx_invoices_pending_bookkeeper
  ON invoices (entity_id, status)
  WHERE status = 'pending_bookkeeper_approval';

CREATE INDEX IF NOT EXISTS idx_invoices_rollup_parent
  ON invoices (rollup_parent_receipt_id)
  WHERE rollup_parent_receipt_id IS NOT NULL;

-- ─── 6. tanda_po_qc_inspections (M26) ───────────────────────────────────
--
-- QC inspection header for Tangerine-native receipts. One row per
-- inspection event against a receipt; findings cascade off this row.

CREATE TABLE IF NOT EXISTS tanda_po_qc_inspections (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
                              REFERENCES entities(id) ON DELETE RESTRICT,
  receipt_id               uuid NOT NULL REFERENCES tanda_po_receipts(id) ON DELETE CASCADE,
  inspection_date          date NOT NULL,
  inspector_employee_id    uuid REFERENCES employees(id) ON DELETE SET NULL,
  status                   text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','passed','failed','partial')),
  overall_pass_rate        numeric(5,4),
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tanda_po_qc_inspections_receipt_idx
  ON tanda_po_qc_inspections (receipt_id);
CREATE INDEX IF NOT EXISTS tanda_po_qc_inspections_open_idx
  ON tanda_po_qc_inspections (entity_id, status)
  WHERE status IN ('pending','failed','partial');

-- ─── 7. tanda_po_qc_findings (M26) ──────────────────────────────────────
--
-- Per-finding detail for a QC inspection. severity drives the disposition
-- workflow; photo_urls links to M29 Document Management.

CREATE TABLE IF NOT EXISTS tanda_po_qc_findings (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id            uuid NOT NULL REFERENCES tanda_po_qc_inspections(id) ON DELETE CASCADE,
  category                 text NOT NULL,
  severity                 text NOT NULL CHECK (severity IN ('minor','major','critical')),
  qty_affected             int NOT NULL DEFAULT 0,
  description              text NOT NULL,
  photo_urls               text[],
  resolution               text,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tanda_po_qc_findings_inspection_idx
  ON tanda_po_qc_findings (inspection_id);

-- ─── 8. vendor_compliance_certifications (M48) ──────────────────────────
--
-- Vendor-level certification tracking. document_url links to M29.
-- Partial index on (expires_at) where status='active' drives the
-- "expiring certifications" notification rule in P13-9.

CREATE TABLE IF NOT EXISTS vendor_compliance_certifications (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
                              REFERENCES entities(id) ON DELETE RESTRICT,
  vendor_id                uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  certification_type       text NOT NULL,
  cert_number              text,
  issued_at                date,
  expires_at               date,
  document_url             text,
  status                   text NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','expired','revoked','pending')),
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vendor_compliance_vendor_idx
  ON vendor_compliance_certifications (vendor_id, status);
CREATE INDEX IF NOT EXISTS vendor_compliance_expiring_idx
  ON vendor_compliance_certifications (expires_at)
  WHERE status = 'active';

-- ─── 9. import_documentation (M48) ──────────────────────────────────────
--
-- Per-PO import document tracking: commercial invoice, packing list, BOL,
-- COO certificate, customs declaration. Forms the audit trail for the
-- customs entry that lands in P13-6.

CREATE TABLE IF NOT EXISTS import_documentation (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
                              REFERENCES entities(id) ON DELETE RESTRICT,
  tanda_po_id              uuid NOT NULL REFERENCES tanda_pos(id) ON DELETE CASCADE,
  document_type            text NOT NULL,
  document_url             text,
  hs_code                  text,
  country_of_origin        text,
  declared_value_cents     bigint,
  duty_rate_pct            numeric(8,4),
  status                   text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','received','verified','filed')),
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS import_docs_po_idx
  ON import_documentation (tanda_po_id);

-- ─── 10. RLS — anon_all_* + auth_internal_* template on all 7 new tables ─
--
-- Seven entity-scoped tables follow the standard P1 template (anon_all_*
-- for the service-role / anon-key API surface; auth_internal_* scoped to
-- entity_users via auth.uid()).
--
-- tanda_po_receipt_lines + tanda_po_qc_findings are NOT entity-scoped
-- directly; auth_internal_* gates via the parent (receipt / inspection).

ALTER TABLE tanda_po_receipts                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE tanda_po_receipt_lines            ENABLE ROW LEVEL SECURITY;
ALTER TABLE tanda_po_receipt_rollups          ENABLE ROW LEVEL SECURITY;
ALTER TABLE tanda_po_qc_inspections           ENABLE ROW LEVEL SECURITY;
ALTER TABLE tanda_po_qc_findings              ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_compliance_certifications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_documentation              ENABLE ROW LEVEL SECURITY;

-- tanda_po_receipts
DO $$ BEGIN
  CREATE POLICY "anon_all_tanda_po_receipts" ON tanda_po_receipts
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_tanda_po_receipts" ON tanda_po_receipts
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- tanda_po_receipt_lines — gated through parent receipt
DO $$ BEGIN
  CREATE POLICY "anon_all_tanda_po_receipt_lines" ON tanda_po_receipt_lines
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_tanda_po_receipt_lines" ON tanda_po_receipt_lines
    FOR ALL TO authenticated
    USING      (receipt_id IN (
                  SELECT r.id FROM tanda_po_receipts r
                  WHERE r.entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())
               ))
    WITH CHECK (receipt_id IN (
                  SELECT r.id FROM tanda_po_receipts r
                  WHERE r.entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())
               ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- tanda_po_receipt_rollups
DO $$ BEGIN
  CREATE POLICY "anon_all_tanda_po_receipt_rollups" ON tanda_po_receipt_rollups
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_tanda_po_receipt_rollups" ON tanda_po_receipt_rollups
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- tanda_po_qc_inspections
DO $$ BEGIN
  CREATE POLICY "anon_all_tanda_po_qc_inspections" ON tanda_po_qc_inspections
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_tanda_po_qc_inspections" ON tanda_po_qc_inspections
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- tanda_po_qc_findings — gated through parent inspection
DO $$ BEGIN
  CREATE POLICY "anon_all_tanda_po_qc_findings" ON tanda_po_qc_findings
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_tanda_po_qc_findings" ON tanda_po_qc_findings
    FOR ALL TO authenticated
    USING      (inspection_id IN (
                  SELECT i.id FROM tanda_po_qc_inspections i
                  WHERE i.entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())
               ))
    WITH CHECK (inspection_id IN (
                  SELECT i.id FROM tanda_po_qc_inspections i
                  WHERE i.entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())
               ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- vendor_compliance_certifications
DO $$ BEGIN
  CREATE POLICY "anon_all_vendor_compliance_certifications" ON vendor_compliance_certifications
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_vendor_compliance_certifications" ON vendor_compliance_certifications
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- import_documentation
DO $$ BEGIN
  CREATE POLICY "anon_all_import_documentation" ON import_documentation
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_import_documentation" ON import_documentation
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 11. PostgREST schema cache reload ──────────────────────────────────
NOTIFY pgrst, 'reload schema';
