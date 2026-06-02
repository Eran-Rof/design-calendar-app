-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P13-2 — Legacy-bridge schema + backfill + pilot vendor seed
--
-- Second chunk of P13 Procurement (see docs/tangerine/P13-procurement-
-- architecture.md §7.2). P13-1 (PR #525) shipped the Tangerine-NATIVE
-- procurement schema (tanda_po_receipts + rollups + qc + compliance). This
-- chunk lands the LEGACY-side bridges so the existing `tanda_pos` (which
-- originated as an inventory-grid PO mirror pre-P11/P12) becomes a usable
-- procurement primitive during the parallel-run window.
--
-- Scope (arch §7.2):
--   • Backfill tanda_pos.procurement_status from the existing Xoro-mirrored
--     payload (data->>'StatusName'), defaulting to 'open' for unmatched.
--   • Tag the operator-confirmed pilot vendor (D18 — Zhejiang Zhuji Newdan
--     Garment Co., Ltd.) — set pilot_vendor_flag=true on all their tanda_pos.
--   • Add the M27 approval-rule template for D19 receipt-rollup AP invoices
--     so the bookkeeper-approval queue knows the routing rule when P13-4
--     ships the UI.
--   • Add vendors.requires_compliance_certs (M48 trade-compliance tie-in).
--   • Schema additions per arch §3.3-3.9:
--       §3.3  po_commitments (off-balance-sheet open-PO tracking, D3)
--       §3.4  receipts / receipt_line_items extensions (source tag, QC
--             routing fields, customs / broker linkage forward FKs)
--       §3.5  qc_inspections (legacy Xoro-era receipt path; new Tangerine-
--             native receipts use tanda_po_qc_inspections from P13-1)
--       §3.6  vendor_invoice_drafts (three-way-match staging, D14 OCR)
--       §3.7  customs_entries + customs_entry_lines (D11/D12 trade compliance)
--       §3.8  broker_invoices (D7/D8 landed cost allocation)
--       §3.9  vendors + ip_item_master extensions (D5, D7, D15, D18, D10/D11)
--   • GL seeds per arch §3.10: 1310 / 1320 / 5100 / 5110 / 5120 / 5130 /
--     2150 / 6320 (6420 already shipped P12-0).
--
-- All idempotent (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- DO-block guards on CHECK/RLS/seeds, ON CONFLICT DO NOTHING on inserts).
-- No COMMENT-concat (the P12-0 hotfix lint catches `IS 'a' || 'b'`).
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. vendors extensions (arch §3.9 + M48 compliance flag) ──────────────
--
-- D5  qc_required boolean — gating per vendor (defaults true; trusted-vendor
--     escape valve toggled by ops once qc_pass_count_12mo >= 12).
-- D5  qc_pass_count_12mo int — rolling 12-mo counter feeding the escape.
-- D7  landed_cost_allocation_method — value | weight | cbm (default value).
-- D15 parallel_run_complete / parallel_run_started_at — per-vendor cutover
--     gating; T10 mirror skips the vendor once complete=true.
-- D18 pilot_vendor boolean — marks the pilot vendor on the vendor row
--     itself (vs the per-PO pilot_vendor_flag added in P13-1).
-- M48 requires_compliance_certs boolean — trade-compliance tie-in for the
--     vendor_compliance_certifications gating in P13-9.

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS qc_required boolean NOT NULL DEFAULT true;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS qc_pass_count_12mo int NOT NULL DEFAULT 0;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS landed_cost_allocation_method text NOT NULL DEFAULT 'value';
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS parallel_run_complete boolean NOT NULL DEFAULT false;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS parallel_run_started_at timestamptz;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS pilot_vendor boolean NOT NULL DEFAULT false;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS requires_compliance_certs boolean NOT NULL DEFAULT false;

ALTER TABLE vendors DROP CONSTRAINT IF EXISTS vendors_landed_cost_method_check;
ALTER TABLE vendors ADD CONSTRAINT vendors_landed_cost_method_check
  CHECK (landed_cost_allocation_method IN ('value','weight','cbm'));

CREATE INDEX IF NOT EXISTS idx_vendors_pilot ON vendors (pilot_vendor) WHERE pilot_vendor = true;
CREATE INDEX IF NOT EXISTS idx_vendors_parallel_run_open
  ON vendors (parallel_run_started_at)
  WHERE parallel_run_started_at IS NOT NULL AND parallel_run_complete = false;
CREATE INDEX IF NOT EXISTS idx_vendors_compliance_required
  ON vendors (requires_compliance_certs) WHERE requires_compliance_certs = true;

-- ─── 2. ip_item_master extensions (arch §3.9) ─────────────────────────────
--
-- D10 hts_code — SKU-stable 10-digit Harmonized Tariff Schedule code; per-
--     PO-line override permitted in po_line_items.
-- D11 default_coo — 2-char default country of origin, sourced from vendor
--     master at PO creation but overridable per line.
-- D7  unit_weight_grams + unit_cbm_cm3 — feed the weight / CBM allocation
--     methods for landed-cost spreads when allocation_method != 'value'.

ALTER TABLE ip_item_master ADD COLUMN IF NOT EXISTS hts_code text;
ALTER TABLE ip_item_master ADD COLUMN IF NOT EXISTS default_coo char(2);
ALTER TABLE ip_item_master ADD COLUMN IF NOT EXISTS unit_weight_grams int;
ALTER TABLE ip_item_master ADD COLUMN IF NOT EXISTS unit_cbm_cm3 int;

CREATE INDEX IF NOT EXISTS idx_ip_item_master_hts
  ON ip_item_master (hts_code) WHERE hts_code IS NOT NULL;

-- ─── 3. receipts extensions (arch §3.4) ───────────────────────────────────
--
-- Adds the receiving-session detail fields the Xoro-mirror era flattened
-- away: receiving dock, carrier, container/BOL, GS1 SSCC array, QC routing
-- gates, and forward FKs to customs_entries + broker_invoices (created in
-- §6/§7 below). source tag per T10 enforcement.

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'tangerine';
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS receiving_dock text;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS carrier_name text;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS container_number text;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS bol_number text;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS gs1_sscc_codes text[] NOT NULL DEFAULT '{}';
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS qc_required boolean NOT NULL DEFAULT true;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS qc_completed_at timestamptz;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS putaway_completed_at timestamptz;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS customs_entry_id uuid;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS broker_invoice_id uuid;

ALTER TABLE receipts DROP CONSTRAINT IF EXISTS receipts_source_check;
ALTER TABLE receipts ADD CONSTRAINT receipts_source_check
  CHECK (source IN ('tangerine','xoro_mirror','edi_945_recv','manual','scanner'));

CREATE INDEX IF NOT EXISTS idx_receipts_source ON receipts (source);
CREATE INDEX IF NOT EXISTS idx_receipts_qc_pending
  ON receipts (qc_required, qc_completed_at)
  WHERE qc_required = true AND qc_completed_at IS NULL;

-- ─── 4. receipt_line_items extensions (arch §3.4) ─────────────────────────

ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS sku_id uuid REFERENCES ip_item_master(id) ON DELETE SET NULL;
ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS quantity_accepted numeric;
ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS quantity_rejected numeric;
ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS qc_disposition text;
ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS putaway_location_id uuid REFERENCES inventory_locations(id) ON DELETE SET NULL;
ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS landed_cost_per_unit_cents bigint;
ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS inventory_layer_id uuid REFERENCES inventory_layers(id) ON DELETE SET NULL;

ALTER TABLE receipt_line_items DROP CONSTRAINT IF EXISTS receipt_line_items_qc_disposition_check;
ALTER TABLE receipt_line_items ADD CONSTRAINT receipt_line_items_qc_disposition_check
  CHECK (qc_disposition IS NULL OR qc_disposition IN ('pending','pass','conditional_pass','fail'));

CREATE INDEX IF NOT EXISTS idx_receipt_line_items_sku ON receipt_line_items (sku_id);
CREATE INDEX IF NOT EXISTS idx_receipt_line_items_qc_open
  ON receipt_line_items (qc_disposition)
  WHERE qc_disposition IN ('pending','fail');

-- ─── 5. po_commitments (arch §3.3, D3) ────────────────────────────────────
--
-- Off-balance-sheet open-PO tracking. Submitted POs accrue a commitment row;
-- commitments consume as receipts land. NO GL post — surfaces in the open
-- commitments management report only (D3).

CREATE TABLE IF NOT EXISTS po_commitments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
                              REFERENCES entities(id) ON DELETE RESTRICT,
  po_id                    uuid NOT NULL REFERENCES tanda_pos(uuid_id) ON DELETE CASCADE,
  po_line_item_id          uuid REFERENCES po_line_items(id) ON DELETE CASCADE,
  vendor_id                uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  expected_account_id      uuid REFERENCES gl_accounts(id) ON DELETE SET NULL,
  committed_at             timestamptz NOT NULL DEFAULT now(),
  committed_amount_cents   bigint NOT NULL,
  consumed_amount_cents    bigint NOT NULL DEFAULT 0,
  remaining_amount_cents   bigint GENERATED ALWAYS AS (committed_amount_cents - consumed_amount_cents) STORED,
  status                   text NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open','partial','closed','cancelled')),
  expected_in_dc_date      date,
  closed_at                timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_commitments_open
  ON po_commitments (entity_id, vendor_id)
  WHERE status IN ('open','partial');
CREATE INDEX IF NOT EXISTS idx_po_commitments_expected_in_dc
  ON po_commitments (expected_in_dc_date)
  WHERE status IN ('open','partial');

-- ─── 6. customs_entries (arch §3.7) ───────────────────────────────────────
--
-- One CBP entry per shipment cleared into the US. raw_payload preserves the
-- broker's reported numbers so Section-301 rates aren't internally re-derived
-- (mitigation in arch §10). Receipts link via receipts.customs_entry_id
-- (FK constraint added in §11 below).

CREATE TABLE IF NOT EXISTS customs_entries (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                   uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
                                 REFERENCES entities(id) ON DELETE RESTRICT,
  entry_number                text NOT NULL,
  entry_date                  date NOT NULL,
  port_of_entry               text,
  importer_of_record          text,
  broker_name                 text,
  broker_id                   text,
  total_entered_value_cents   bigint NOT NULL,
  total_duty_cents            bigint NOT NULL DEFAULT 0,
  total_mpf_cents             bigint NOT NULL DEFAULT 0,
  total_hmf_cents             bigint NOT NULL DEFAULT 0,
  total_section_301_cents     bigint NOT NULL DEFAULT 0,
  total_other_fees_cents      bigint NOT NULL DEFAULT 0,
  form_7501_document_id       uuid,
  raw_payload                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  revaluation_je_id           uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customs_entries_unique UNIQUE (entity_id, entry_number)
);

CREATE INDEX IF NOT EXISTS idx_customs_entries_open
  ON customs_entries (entity_id, entry_date DESC);

CREATE TABLE IF NOT EXISTS customs_entry_lines (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customs_entry_id         uuid NOT NULL REFERENCES customs_entries(id) ON DELETE CASCADE,
  receipt_line_item_id     uuid REFERENCES receipt_line_items(id) ON DELETE SET NULL,
  hts_code                 text NOT NULL,
  country_of_origin        char(2) NOT NULL,
  trade_program            text,
  entered_value_cents      bigint NOT NULL,
  duty_rate_pct            numeric(7,4),
  duty_cents               bigint NOT NULL DEFAULT 0,
  section_301_rate_pct     numeric(7,4),
  section_301_cents        bigint NOT NULL DEFAULT 0,
  mpf_cents                bigint NOT NULL DEFAULT 0,
  hmf_cents                bigint NOT NULL DEFAULT 0,
  CONSTRAINT customs_entry_lines_unique UNIQUE (customs_entry_id, receipt_line_item_id)
);

CREATE INDEX IF NOT EXISTS idx_customs_entry_lines_entry
  ON customs_entry_lines (customs_entry_id);

-- ─── 7. broker_invoices (arch §3.8) ───────────────────────────────────────
--
-- Broker-as-vendor AP path with D7-default value-weighted allocation; D8
-- capitalizes duty / freight / brokerage into the receipt's FIFO layer.

CREATE TABLE IF NOT EXISTS broker_invoices (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
                              REFERENCES entities(id) ON DELETE RESTRICT,
  customs_entry_id         uuid REFERENCES customs_entries(id) ON DELETE SET NULL,
  vendor_id                uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  broker_invoice_number    text NOT NULL,
  invoice_date             date NOT NULL,
  freight_cents            bigint NOT NULL DEFAULT 0,
  brokerage_fee_cents      bigint NOT NULL DEFAULT 0,
  duty_advance_cents       bigint NOT NULL DEFAULT 0,
  other_cents              bigint NOT NULL DEFAULT 0,
  total_cents              bigint NOT NULL,
  ap_invoice_id            uuid REFERENCES invoices(id) ON DELETE SET NULL,
  allocation_method        text NOT NULL DEFAULT 'value'
                              CHECK (allocation_method IN ('value','weight','cbm','manual')),
  allocation_je_id         uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broker_invoices_unique UNIQUE (entity_id, vendor_id, broker_invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_broker_invoices_customs
  ON broker_invoices (customs_entry_id) WHERE customs_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_broker_invoices_vendor
  ON broker_invoices (vendor_id, invoice_date DESC);

-- ─── 8. vendor_invoice_drafts (arch §3.6, D14) ────────────────────────────
--
-- Three-way-match staging. Vendor invoice arrives separately from receipt
-- + PO; we stage it here for matching before it becomes an AP invoice.
-- source_kind tracks ingestion path (vendor portal / AP inbox / EDI 810 /
-- manual). ocr_confidence_pct < 80 (D14) → straight-to-manual-review queue.

CREATE TABLE IF NOT EXISTS vendor_invoice_drafts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
                              REFERENCES entities(id) ON DELETE RESTRICT,
  vendor_id                uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  vendor_invoice_number    text NOT NULL,
  invoice_date             date NOT NULL,
  due_date                 date,
  currency                 char(3) NOT NULL DEFAULT 'USD',
  total_cents              bigint NOT NULL,
  source_kind              text NOT NULL
                              CHECK (source_kind IN ('vendor_portal_upload','ap_inbox_pdf','manual','edi_810')),
  source_pdf_document_id   uuid,
  ocr_extracted_payload    jsonb,
  ocr_confidence_pct       numeric(5,2),
  three_way_match_status   text NOT NULL DEFAULT 'pending'
                              CHECK (three_way_match_status IN ('pending','matched','variance','exception','posted','rejected')),
  matched_po_ids           uuid[] NOT NULL DEFAULT '{}',
  matched_receipt_ids      uuid[] NOT NULL DEFAULT '{}',
  variance_cents           bigint NOT NULL DEFAULT 0,
  variance_reason          text,
  ap_invoice_id            uuid REFERENCES invoices(id) ON DELETE SET NULL,
  approved_by_user_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at              timestamptz,
  rejected_reason          text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendor_invoice_drafts_unique UNIQUE (vendor_id, vendor_invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_vendor_invoice_drafts_open
  ON vendor_invoice_drafts (three_way_match_status)
  WHERE three_way_match_status IN ('pending','variance','exception');
CREATE INDEX IF NOT EXISTS idx_vendor_invoice_drafts_low_confidence
  ON vendor_invoice_drafts (ocr_confidence_pct)
  WHERE ocr_confidence_pct IS NOT NULL AND ocr_confidence_pct < 80;

-- ─── 9. qc_inspections (arch §3.5 — legacy Xoro-era receipts) ─────────────
--
-- Lighter-weight than tanda_po_qc_inspections (P13-1); this table services
-- the legacy `receipts` rows during the parallel-run window. Once a vendor
-- cuts over to Tangerine-source-of-truth, future receipts write to
-- tanda_po_receipts + tanda_po_qc_inspections only.

CREATE TABLE IF NOT EXISTS qc_inspections (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id                uuid NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
                              REFERENCES entities(id) ON DELETE RESTRICT,
  receipt_id               uuid NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  receipt_line_item_id     uuid NOT NULL REFERENCES receipt_line_items(id) ON DELETE CASCADE,
  inspector_user_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  inspected_at             timestamptz NOT NULL DEFAULT now(),
  disposition              text NOT NULL CHECK (disposition IN ('pass','conditional_pass','fail')),
  qty_inspected            numeric(18,4) NOT NULL,
  qty_passed               numeric(18,4) NOT NULL,
  qty_conditional          numeric(18,4) NOT NULL DEFAULT 0,
  qty_failed               numeric(18,4) NOT NULL DEFAULT 0,
  failure_disposition      text
                              CHECK (failure_disposition IS NULL OR failure_disposition IN
                                ('vendor_rma','vendor_credit_only','write_off','rework_inhouse')),
  failure_reason           text,
  photo_attachment_ids     uuid[] NOT NULL DEFAULT '{}',
  rework_completed_at      timestamptz,
  vendor_credit_invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  writeoff_je_id           uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qc_inspections_open
  ON qc_inspections (entity_id, disposition)
  WHERE disposition = 'fail' AND failure_disposition IS NULL;
CREATE INDEX IF NOT EXISTS idx_qc_inspections_receipt
  ON qc_inspections (receipt_id);

-- ─── 10. receipts forward FKs (arch §3.7/§3.8 hookup) ─────────────────────
--
-- The customs_entry_id + broker_invoice_id columns were added in §3 above
-- as plain uuid; now that customs_entries + broker_invoices exist, attach
-- the FK constraints. DO-block guard for idempotency since PG lacks
-- "ADD CONSTRAINT IF NOT EXISTS" pre-15.

DO $$ BEGIN
  ALTER TABLE receipts ADD CONSTRAINT receipts_customs_fk
    FOREIGN KEY (customs_entry_id) REFERENCES customs_entries(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE receipts ADD CONSTRAINT receipts_broker_fk
    FOREIGN KEY (broker_invoice_id) REFERENCES broker_invoices(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 11. RLS — anon_all_* + auth_internal_* template on new tables ────────
--
-- Six new entity-scoped tables follow the standard P1 template. customs_
-- entry_lines is gated through its parent customs_entries row.

ALTER TABLE po_commitments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE customs_entries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE customs_entry_lines    ENABLE ROW LEVEL SECURITY;
ALTER TABLE broker_invoices        ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_invoice_drafts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE qc_inspections         ENABLE ROW LEVEL SECURITY;

-- po_commitments
DO $$ BEGIN
  CREATE POLICY "anon_all_po_commitments" ON po_commitments
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_po_commitments" ON po_commitments
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- customs_entries
DO $$ BEGIN
  CREATE POLICY "anon_all_customs_entries" ON customs_entries
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_customs_entries" ON customs_entries
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- customs_entry_lines — gated through parent customs_entries
DO $$ BEGIN
  CREATE POLICY "anon_all_customs_entry_lines" ON customs_entry_lines
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_customs_entry_lines" ON customs_entry_lines
    FOR ALL TO authenticated
    USING      (customs_entry_id IN (
                  SELECT ce.id FROM customs_entries ce
                  WHERE ce.entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())
               ))
    WITH CHECK (customs_entry_id IN (
                  SELECT ce.id FROM customs_entries ce
                  WHERE ce.entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid())
               ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- broker_invoices
DO $$ BEGIN
  CREATE POLICY "anon_all_broker_invoices" ON broker_invoices
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_broker_invoices" ON broker_invoices
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- vendor_invoice_drafts
DO $$ BEGIN
  CREATE POLICY "anon_all_vendor_invoice_drafts" ON vendor_invoice_drafts
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_vendor_invoice_drafts" ON vendor_invoice_drafts
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- qc_inspections
DO $$ BEGIN
  CREATE POLICY "anon_all_qc_inspections" ON qc_inspections
    FOR ALL TO anon USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "auth_internal_qc_inspections" ON qc_inspections
    FOR ALL TO authenticated
    USING      (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()))
    WITH CHECK (entity_id IN (SELECT eu.entity_id FROM entity_users eu WHERE eu.auth_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 12. GL account seeds (arch §3.10) ────────────────────────────────────
--
-- Eight new procurement GL accounts seeded for ROF entity. 6420 Inventory
-- Write-off already shipped P12-0 (reused for QC fails); we skip it here.
-- All idempotent via ON CONFLICT (entity_id, code) DO NOTHING.

DO $$
DECLARE
  v_rof uuid;
BEGIN
  SELECT id INTO v_rof FROM entities WHERE code = 'ROF';
  IF v_rof IS NULL THEN
    RAISE NOTICE 'ROF entity not found — skipping P13-2 GL account seeds; rerun once entity exists';
    RETURN;
  END IF;

  -- 1310 Inventory In-Transit
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, status)
    VALUES (v_rof, '1310', 'Inventory In-Transit', 'asset', 'DEBIT', true, 'active')
    ON CONFLICT (entity_id, code) DO NOTHING;
  -- 1320 Inventory On QC Hold
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, status)
    VALUES (v_rof, '1320', 'Inventory On QC Hold', 'asset', 'DEBIT', true, 'active')
    ON CONFLICT (entity_id, code) DO NOTHING;
  -- 5100 Inbound Freight
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, status)
    VALUES (v_rof, '5100', 'Inbound Freight', 'expense', 'DEBIT', true, 'active')
    ON CONFLICT (entity_id, code) DO NOTHING;
  -- 5110 Customs Duty
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, status)
    VALUES (v_rof, '5110', 'Customs Duty', 'expense', 'DEBIT', true, 'active')
    ON CONFLICT (entity_id, code) DO NOTHING;
  -- 5120 Brokerage + Clearance
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, status)
    VALUES (v_rof, '5120', 'Brokerage + Clearance', 'expense', 'DEBIT', true, 'active')
    ON CONFLICT (entity_id, code) DO NOTHING;
  -- 5130 Section 301 Tariffs
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, status)
    VALUES (v_rof, '5130', 'Section 301 Tariffs', 'expense', 'DEBIT', true, 'active')
    ON CONFLICT (entity_id, code) DO NOTHING;
  -- 2150 Accrued Customs / Duty
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, status)
    VALUES (v_rof, '2150', 'Accrued Customs / Duty', 'liability', 'CREDIT', true, 'active')
    ON CONFLICT (entity_id, code) DO NOTHING;
  -- 6320 PO Variance Expense
  INSERT INTO gl_accounts (entity_id, code, name, account_type, normal_balance, is_postable, status)
    VALUES (v_rof, '6320', 'PO Variance Expense', 'expense', 'DEBIT', true, 'active')
    ON CONFLICT (entity_id, code) DO NOTHING;
END $$;

-- ─── 13. tanda_pos.procurement_status backfill ────────────────────────────
--
-- procurement_status was added in P13-1 (orthogonal to the legacy `data`
-- JSON's StatusName); existing rows are NULL. Backfill from the Xoro-mirror
-- StatusName field on the JSON payload, mapping into the procurement
-- lifecycle. Default 'open' for anything unrecognized — operator can refine
-- via UI once P13-3 ships.

UPDATE tanda_pos
   SET procurement_status = CASE
     WHEN lower(coalesce(data->>'StatusName','')) IN ('received','closed','complete','completed') THEN 'received'
     WHEN lower(coalesce(data->>'StatusName','')) IN ('released','approved','in production','in_production','shipped') THEN 'open'
     WHEN lower(coalesce(data->>'StatusName','')) IN ('draft','pending','new') THEN 'draft'
     WHEN lower(coalesce(data->>'StatusName','')) IN ('cancelled','canceled','void','voided') THEN 'cancelled'
     ELSE 'open'
   END
 WHERE procurement_status IS NULL;

-- ─── 14. Pilot vendor seed + tag (D18 — Zhejiang Zhuji Newdan) ────────────
--
-- Find-or-create the operator-confirmed pilot vendor and tag both the
-- vendor row (vendors.pilot_vendor = true) and the per-PO marker added in
-- P13-1 (tanda_pos.pilot_vendor_flag = true) for every PO already linked
-- to that vendor. vendors is a global table (no entity_id) so the lookup
-- is fuzzy on legal_name first then aliases / name.

DO $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id
    FROM vendors
   WHERE deleted_at IS NULL
     AND (
       legal_name ILIKE '%Zhejiang%Zhuji%Newdan%'
       OR name       ILIKE '%Zhejiang%Zhuji%Newdan%'
       OR EXISTS (
         SELECT 1 FROM unnest(coalesce(aliases,'{}'::text[])) a
          WHERE a ILIKE '%Zhejiang%Zhuji%Newdan%'
       )
     )
   ORDER BY (legal_name IS NULL), updated_at DESC
   LIMIT 1;

  IF v_id IS NULL THEN
    INSERT INTO vendors (
      name, legal_name, country, status, default_currency
    ) VALUES (
      'Zhejiang Zhuji Newdan Garment Co., Ltd.',
      'Zhejiang Zhuji Newdan Garment Co., Ltd.',
      'CN',
      'active',
      'USD'
    )
    RETURNING id INTO v_id;
  END IF;

  -- Tag the vendor row itself.
  UPDATE vendors SET pilot_vendor = true WHERE id = v_id AND pilot_vendor = false;

  -- Tag every existing PO for the pilot vendor with the per-PO flag (P13-1
  -- column). Idempotent — only flips rows still at the default false.
  UPDATE tanda_pos
     SET pilot_vendor_flag = true
   WHERE vendor_id = v_id
     AND pilot_vendor_flag = false;
END $$;

-- ─── 15. M27 approval rule template — receipt rollup AP invoices ──────────
--
-- Seeds the canonical approval rule for D19 auto-AP rollup invoices, so the
-- bookkeeper-approval queue (P13-4) has a routing rule to match against.
-- approval_rules columns per CURRENT-SCHEMA: kind, name, match jsonb, steps
-- jsonb, is_active boolean. Single bookkeeper-role approver step. Match
-- jsonb keys mirror the D19 invoice shape: is_receipt_rollup=true +
-- status='pending_bookkeeper_approval'.

DO $$
DECLARE
  v_rof uuid;
BEGIN
  SELECT id INTO v_rof FROM entities WHERE code = 'ROF';
  IF v_rof IS NULL THEN
    RAISE NOTICE 'ROF entity not found — skipping P13-2 approval rule seed; rerun once entity exists';
    RETURN;
  END IF;

  INSERT INTO approval_rules (entity_id, kind, name, match, steps, is_active)
  SELECT
    v_rof,
    'ap_invoice_post',
    'Receipt rollup AP invoice — bookkeeper approval (D19)',
    jsonb_build_object(
      'description',          'Auto-created AP invoices spawned by tanda_po_receipt_rollups (D19). Routes to bookkeeper before P3 AP posting service runs.',
      'is_receipt_rollup',    true,
      'status',               'pending_bookkeeper_approval'
    ),
    jsonb_build_array(
      jsonb_build_object('approver_role', 'bookkeeper', 'order', 1, 'mode', 'all')
    ),
    true
  WHERE NOT EXISTS (
    SELECT 1 FROM approval_rules
     WHERE entity_id = v_rof
       AND kind = 'ap_invoice_post'
       AND name = 'Receipt rollup AP invoice — bookkeeper approval (D19)'
  );
END $$;

-- ─── 16. PostgREST schema cache reload ────────────────────────────────────
NOTIFY pgrst, 'reload schema';
