// Static-shape tests for P13-2 migration: legacy-bridge schema +
// procurement_status backfill + pilot vendor seed + approval rule template
// (arch §7.2). Reads the migration SQL + the P13 architecture doc and
// asserts shape — does not require a live DB.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = readFileSync(
  resolve(
    here,
    "../../../supabase/migrations/20260629A10000_p13_chunk2_legacy_bridge.sql",
  ),
  "utf8",
);
const ARCH = readFileSync(
  resolve(here, "../../../docs/tangerine/P13-procurement-architecture.md"),
  "utf8",
);

const NEW_LEGACY_TABLES = [
  "po_commitments",
  "customs_entries",
  "customs_entry_lines",
  "broker_invoices",
  "vendor_invoice_drafts",
  "qc_inspections",
];

const ENTITY_SCOPED_TABLES = [
  "po_commitments",
  "customs_entries",
  "broker_invoices",
  "vendor_invoice_drafts",
  "qc_inspections",
];

describe("P13-2 — Legacy-bridge schema migration", () => {
  describe("CREATE TABLE for all 6 new legacy-bridge tables (idempotent)", () => {
    for (const tbl of NEW_LEGACY_TABLES) {
      it(`${tbl}: CREATE TABLE IF NOT EXISTS`, () => {
        expect(MIG).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${tbl}`));
      });
    }
  });

  describe("vendors extensions (arch §3.9 + M48)", () => {
    it("adds qc_required boolean NOT NULL DEFAULT true (D5)", () => {
      expect(MIG).toMatch(
        /ALTER TABLE vendors ADD COLUMN IF NOT EXISTS qc_required boolean NOT NULL DEFAULT true/,
      );
    });
    it("adds qc_pass_count_12mo int NOT NULL DEFAULT 0 (D5)", () => {
      expect(MIG).toMatch(
        /ALTER TABLE vendors ADD COLUMN IF NOT EXISTS qc_pass_count_12mo int NOT NULL DEFAULT 0/,
      );
    });
    it("adds landed_cost_allocation_method text NOT NULL DEFAULT 'value' (D7)", () => {
      expect(MIG).toMatch(
        /ALTER TABLE vendors ADD COLUMN IF NOT EXISTS landed_cost_allocation_method text NOT NULL DEFAULT 'value'/,
      );
    });
    it("adds landed_cost_allocation_method CHECK (value/weight/cbm)", () => {
      expect(MIG).toMatch(
        /vendors_landed_cost_method_check[\s\S]*?'value'[\s\S]*?'weight'[\s\S]*?'cbm'/,
      );
    });
    it("adds parallel_run_complete boolean NOT NULL DEFAULT false (D15)", () => {
      expect(MIG).toMatch(
        /ALTER TABLE vendors ADD COLUMN IF NOT EXISTS parallel_run_complete boolean NOT NULL DEFAULT false/,
      );
    });
    it("adds parallel_run_started_at timestamptz (D15)", () => {
      expect(MIG).toMatch(
        /ALTER TABLE vendors ADD COLUMN IF NOT EXISTS parallel_run_started_at timestamptz/,
      );
    });
    it("adds pilot_vendor boolean NOT NULL DEFAULT false (D18)", () => {
      expect(MIG).toMatch(
        /ALTER TABLE vendors ADD COLUMN IF NOT EXISTS pilot_vendor boolean NOT NULL DEFAULT false/,
      );
    });
    it("adds requires_compliance_certs boolean NOT NULL DEFAULT false (M48)", () => {
      expect(MIG).toMatch(
        /ALTER TABLE vendors ADD COLUMN IF NOT EXISTS requires_compliance_certs boolean NOT NULL DEFAULT false/,
      );
    });
  });

  describe("ip_item_master extensions (arch §3.9)", () => {
    it("adds hts_code text (D10)", () => {
      expect(MIG).toMatch(
        /ALTER TABLE ip_item_master ADD COLUMN IF NOT EXISTS hts_code text/,
      );
    });
    it("adds default_coo char(2) (D11)", () => {
      expect(MIG).toMatch(
        /ALTER TABLE ip_item_master ADD COLUMN IF NOT EXISTS default_coo char\(2\)/,
      );
    });
    it("adds unit_weight_grams int (D7)", () => {
      expect(MIG).toMatch(
        /ALTER TABLE ip_item_master ADD COLUMN IF NOT EXISTS unit_weight_grams int/,
      );
    });
    it("adds unit_cbm_cm3 int (D7)", () => {
      expect(MIG).toMatch(
        /ALTER TABLE ip_item_master ADD COLUMN IF NOT EXISTS unit_cbm_cm3 int/,
      );
    });
  });

  describe("receipts extensions (arch §3.4)", () => {
    it("adds source text NOT NULL DEFAULT 'tangerine'", () => {
      expect(MIG).toMatch(
        /ALTER TABLE receipts ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'tangerine'/,
      );
    });
    it("adds source CHECK with the 5 enum values (T10)", () => {
      for (const v of ["tangerine", "xoro_mirror", "edi_945_recv", "manual", "scanner"]) {
        expect(MIG).toMatch(
          new RegExp(`receipts_source_check[\\s\\S]*?'${v}'`),
        );
      }
    });
    it("adds receiving_dock / carrier_name / container_number / bol_number text columns", () => {
      for (const c of ["receiving_dock", "carrier_name", "container_number", "bol_number"]) {
        expect(MIG).toMatch(
          new RegExp(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS ${c} text`),
        );
      }
    });
    it("adds gs1_sscc_codes text[] NOT NULL DEFAULT '{}'", () => {
      expect(MIG).toMatch(
        /ALTER TABLE receipts ADD COLUMN IF NOT EXISTS gs1_sscc_codes text\[\] NOT NULL DEFAULT '\{\}'/,
      );
    });
    it("adds qc_required + qc_completed_at + putaway_completed_at", () => {
      expect(MIG).toMatch(
        /ALTER TABLE receipts ADD COLUMN IF NOT EXISTS qc_required boolean NOT NULL DEFAULT true/,
      );
      expect(MIG).toMatch(
        /ALTER TABLE receipts ADD COLUMN IF NOT EXISTS qc_completed_at timestamptz/,
      );
      expect(MIG).toMatch(
        /ALTER TABLE receipts ADD COLUMN IF NOT EXISTS putaway_completed_at timestamptz/,
      );
    });
    it("adds customs_entry_id + broker_invoice_id forward-FK columns", () => {
      expect(MIG).toMatch(
        /ALTER TABLE receipts ADD COLUMN IF NOT EXISTS customs_entry_id uuid/,
      );
      expect(MIG).toMatch(
        /ALTER TABLE receipts ADD COLUMN IF NOT EXISTS broker_invoice_id uuid/,
      );
    });
    it("attaches receipts_customs_fk FK constraint to customs_entries", () => {
      expect(MIG).toMatch(
        /receipts_customs_fk[\s\S]*?REFERENCES customs_entries\(id\) ON DELETE SET NULL/,
      );
    });
    it("attaches receipts_broker_fk FK constraint to broker_invoices", () => {
      expect(MIG).toMatch(
        /receipts_broker_fk[\s\S]*?REFERENCES broker_invoices\(id\) ON DELETE SET NULL/,
      );
    });
  });

  describe("receipt_line_items extensions (arch §3.4)", () => {
    it("adds sku_id FK to ip_item_master", () => {
      expect(MIG).toMatch(
        /ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS sku_id uuid REFERENCES ip_item_master\(id\) ON DELETE SET NULL/,
      );
    });
    it("adds quantity_accepted + quantity_rejected numerics", () => {
      expect(MIG).toMatch(
        /ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS quantity_accepted numeric/,
      );
      expect(MIG).toMatch(
        /ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS quantity_rejected numeric/,
      );
    });
    it("adds qc_disposition CHECK pending/pass/conditional_pass/fail", () => {
      for (const v of ["pending", "pass", "conditional_pass", "fail"]) {
        expect(MIG).toMatch(
          new RegExp(`receipt_line_items_qc_disposition_check[\\s\\S]*?'${v}'`),
        );
      }
    });
    it("adds putaway_location_id FK to inventory_locations", () => {
      expect(MIG).toMatch(
        /ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS putaway_location_id uuid REFERENCES inventory_locations\(id\) ON DELETE SET NULL/,
      );
    });
    it("adds landed_cost_per_unit_cents bigint + inventory_layer_id FK", () => {
      expect(MIG).toMatch(
        /ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS landed_cost_per_unit_cents bigint/,
      );
      expect(MIG).toMatch(
        /ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS inventory_layer_id uuid REFERENCES inventory_layers\(id\) ON DELETE SET NULL/,
      );
    });
  });

  describe("po_commitments (arch §3.3, D3)", () => {
    it("entity_id DEFAULT coalesce(current_entity_id(), rof_entity_id())", () => {
      expect(MIG).toMatch(
        /po_commitments[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT coalesce\(current_entity_id\(\), rof_entity_id\(\)\)/,
      );
    });
    it("po_id FK to tanda_pos(uuid_id) with CASCADE", () => {
      expect(MIG).toMatch(
        /po_id\s+uuid NOT NULL REFERENCES tanda_pos\(uuid_id\) ON DELETE CASCADE/,
      );
    });
    it("vendor_id FK to vendors with ON DELETE RESTRICT", () => {
      expect(MIG).toMatch(
        /po_commitments[\s\S]*?vendor_id\s+uuid NOT NULL REFERENCES vendors\(id\) ON DELETE RESTRICT/,
      );
    });
    it("remaining_amount_cents is a GENERATED ALWAYS column", () => {
      expect(MIG).toMatch(
        /remaining_amount_cents\s+bigint GENERATED ALWAYS AS \(committed_amount_cents - consumed_amount_cents\) STORED/,
      );
    });
    it("status CHECK includes open / partial / closed / cancelled", () => {
      for (const s of ["open", "partial", "closed", "cancelled"]) {
        expect(MIG).toMatch(
          new RegExp(`po_commitments[\\s\\S]*?'${s}'`),
        );
      }
    });
    it("has open-commitments partial index by (entity_id, vendor_id)", () => {
      expect(MIG).toMatch(
        /idx_po_commitments_open[\s\S]*?WHERE status IN \('open','partial'\)/,
      );
    });
    it("has expected_in_dc_date partial index", () => {
      expect(MIG).toMatch(
        /idx_po_commitments_expected_in_dc[\s\S]*?WHERE status IN \('open','partial'\)/,
      );
    });
  });

  describe("customs_entries (arch §3.7)", () => {
    it("entity_id DEFAULT coalesce(current_entity_id(), rof_entity_id())", () => {
      expect(MIG).toMatch(
        /customs_entries[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT coalesce\(current_entity_id\(\), rof_entity_id\(\)\)/,
      );
    });
    it("entry_number text NOT NULL + UNIQUE per entity", () => {
      expect(MIG).toMatch(/entry_number\s+text NOT NULL/);
      expect(MIG).toMatch(
        /customs_entries_unique UNIQUE \(entity_id, entry_number\)/,
      );
    });
    it("total_entered_value_cents + duty/mpf/hmf/section_301/other fee columns present", () => {
      for (const c of [
        "total_entered_value_cents",
        "total_duty_cents",
        "total_mpf_cents",
        "total_hmf_cents",
        "total_section_301_cents",
        "total_other_fees_cents",
      ]) {
        expect(MIG).toMatch(new RegExp(`${c}\\s+bigint`));
      }
    });
    it("raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb", () => {
      expect(MIG).toMatch(
        /raw_payload\s+jsonb NOT NULL DEFAULT '\{\}'::jsonb/,
      );
    });
    it("revaluation_je_id FK to journal_entries", () => {
      expect(MIG).toMatch(
        /revaluation_je_id\s+uuid REFERENCES journal_entries\(id\) ON DELETE SET NULL/,
      );
    });
  });

  describe("customs_entry_lines (arch §3.7)", () => {
    it("customs_entry_id FK with CASCADE", () => {
      expect(MIG).toMatch(
        /customs_entry_lines[\s\S]*?customs_entry_id\s+uuid NOT NULL REFERENCES customs_entries\(id\) ON DELETE CASCADE/,
      );
    });
    it("receipt_line_item_id FK with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(
        /receipt_line_item_id\s+uuid REFERENCES receipt_line_items\(id\) ON DELETE SET NULL/,
      );
    });
    it("hts_code + country_of_origin NOT NULL", () => {
      expect(MIG).toMatch(/hts_code\s+text NOT NULL/);
      expect(MIG).toMatch(/country_of_origin\s+char\(2\) NOT NULL/);
    });
    it("UNIQUE (customs_entry_id, receipt_line_item_id)", () => {
      expect(MIG).toMatch(
        /customs_entry_lines_unique UNIQUE \(customs_entry_id, receipt_line_item_id\)/,
      );
    });
  });

  describe("broker_invoices (arch §3.8)", () => {
    it("entity_id DEFAULT coalesce(current_entity_id(), rof_entity_id())", () => {
      expect(MIG).toMatch(
        /broker_invoices[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT coalesce\(current_entity_id\(\), rof_entity_id\(\)\)/,
      );
    });
    it("customs_entry_id FK with SET NULL on delete", () => {
      expect(MIG).toMatch(
        /broker_invoices[\s\S]*?customs_entry_id\s+uuid REFERENCES customs_entries\(id\) ON DELETE SET NULL/,
      );
    });
    it("vendor_id (broker-as-vendor) FK with RESTRICT", () => {
      expect(MIG).toMatch(
        /broker_invoices[\s\S]*?vendor_id\s+uuid NOT NULL REFERENCES vendors\(id\) ON DELETE RESTRICT/,
      );
    });
    it("allocation_method CHECK includes value/weight/cbm/manual", () => {
      for (const v of ["value", "weight", "cbm", "manual"]) {
        expect(MIG).toMatch(
          new RegExp(`allocation_method[\\s\\S]*?'${v}'`),
        );
      }
    });
    it("freight / brokerage_fee / duty_advance / other / total cents columns", () => {
      for (const c of [
        "freight_cents",
        "brokerage_fee_cents",
        "duty_advance_cents",
        "other_cents",
        "total_cents",
      ]) {
        expect(MIG).toMatch(new RegExp(`${c}\\s+bigint`));
      }
    });
    it("UNIQUE (entity_id, vendor_id, broker_invoice_number)", () => {
      expect(MIG).toMatch(
        /broker_invoices_unique UNIQUE \(entity_id, vendor_id, broker_invoice_number\)/,
      );
    });
  });

  describe("vendor_invoice_drafts (arch §3.6, D14)", () => {
    it("entity_id DEFAULT coalesce(current_entity_id(), rof_entity_id())", () => {
      expect(MIG).toMatch(
        /vendor_invoice_drafts[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT coalesce\(current_entity_id\(\), rof_entity_id\(\)\)/,
      );
    });
    it("source_kind CHECK vendor_portal_upload / ap_inbox_pdf / manual / edi_810", () => {
      for (const v of ["vendor_portal_upload", "ap_inbox_pdf", "manual", "edi_810"]) {
        expect(MIG).toMatch(
          new RegExp(`source_kind[\\s\\S]*?'${v}'`),
        );
      }
    });
    it("three_way_match_status CHECK includes pending/matched/variance/exception/posted/rejected", () => {
      for (const v of ["pending", "matched", "variance", "exception", "posted", "rejected"]) {
        expect(MIG).toMatch(
          new RegExp(`three_way_match_status[\\s\\S]*?'${v}'`),
        );
      }
    });
    it("matched_po_ids + matched_receipt_ids uuid[] (N:M three-way match)", () => {
      expect(MIG).toMatch(
        /matched_po_ids\s+uuid\[\] NOT NULL DEFAULT '\{\}'/,
      );
      expect(MIG).toMatch(
        /matched_receipt_ids\s+uuid\[\] NOT NULL DEFAULT '\{\}'/,
      );
    });
    it("ap_invoice_id FK to invoices", () => {
      expect(MIG).toMatch(
        /vendor_invoice_drafts[\s\S]*?ap_invoice_id\s+uuid REFERENCES invoices\(id\) ON DELETE SET NULL/,
      );
    });
    it("UNIQUE (vendor_id, vendor_invoice_number) — no double-ingest", () => {
      expect(MIG).toMatch(
        /vendor_invoice_drafts_unique UNIQUE \(vendor_id, vendor_invoice_number\)/,
      );
    });
    it("partial index on low-confidence OCR rows (< 80% per D14)", () => {
      expect(MIG).toMatch(
        /idx_vendor_invoice_drafts_low_confidence[\s\S]*?WHERE ocr_confidence_pct IS NOT NULL AND ocr_confidence_pct < 80/,
      );
    });
  });

  describe("qc_inspections — legacy receipts path (arch §3.5)", () => {
    it("entity_id DEFAULT coalesce(current_entity_id(), rof_entity_id())", () => {
      expect(MIG).toMatch(
        /qc_inspections[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT coalesce\(current_entity_id\(\), rof_entity_id\(\)\)/,
      );
    });
    it("receipt_id FK to receipts (NOT tanda_po_receipts) with CASCADE", () => {
      expect(MIG).toMatch(
        /qc_inspections[\s\S]*?receipt_id\s+uuid NOT NULL REFERENCES receipts\(id\) ON DELETE CASCADE/,
      );
    });
    it("receipt_line_item_id FK to receipt_line_items with CASCADE", () => {
      expect(MIG).toMatch(
        /receipt_line_item_id\s+uuid NOT NULL REFERENCES receipt_line_items\(id\) ON DELETE CASCADE/,
      );
    });
    it("disposition CHECK includes pass / conditional_pass / fail", () => {
      for (const v of ["pass", "conditional_pass", "fail"]) {
        expect(MIG).toMatch(
          new RegExp(`disposition[\\s\\S]*?'${v}'`),
        );
      }
    });
    it("failure_disposition CHECK includes the 4 dispositions (D6)", () => {
      for (const v of [
        "vendor_rma",
        "vendor_credit_only",
        "write_off",
        "rework_inhouse",
      ]) {
        expect(MIG).toMatch(
          new RegExp(`failure_disposition[\\s\\S]*?'${v}'`),
        );
      }
    });
    it("photo_attachment_ids uuid[] for M29 docs", () => {
      expect(MIG).toMatch(
        /photo_attachment_ids\s+uuid\[\] NOT NULL DEFAULT '\{\}'/,
      );
    });
    it("vendor_credit_invoice_id FK to invoices (D6 vendor_credit_only path)", () => {
      expect(MIG).toMatch(
        /vendor_credit_invoice_id\s+uuid REFERENCES invoices\(id\) ON DELETE SET NULL/,
      );
    });
    it("writeoff_je_id FK to journal_entries (D6 write_off path)", () => {
      expect(MIG).toMatch(
        /writeoff_je_id\s+uuid REFERENCES journal_entries\(id\) ON DELETE SET NULL/,
      );
    });
    it("has open-fail partial index (disposition='fail' AND failure_disposition IS NULL)", () => {
      expect(MIG).toMatch(
        /idx_qc_inspections_open[\s\S]*?WHERE disposition = 'fail' AND failure_disposition IS NULL/,
      );
    });
  });

  describe("entity_id DEFAULT coalesce(current_entity_id(), rof_entity_id()) on entity-scoped tables", () => {
    for (const tbl of ENTITY_SCOPED_TABLES) {
      it(`${tbl}: DEFAULT coalesce(current_entity_id(), rof_entity_id())`, () => {
        const re = new RegExp(
          `${tbl}[\\s\\S]*?entity_id\\s+uuid NOT NULL DEFAULT coalesce\\(current_entity_id\\(\\), rof_entity_id\\(\\)\\)`,
        );
        expect(MIG).toMatch(re);
      });
    }
  });

  describe("RLS — anon_all_* + auth_internal_* template", () => {
    for (const tbl of NEW_LEGACY_TABLES) {
      it(`${tbl}: ENABLE ROW LEVEL SECURITY`, () => {
        expect(MIG).toMatch(
          new RegExp(`ALTER TABLE ${tbl}\\s+ENABLE ROW LEVEL SECURITY`),
        );
      });
      it(`${tbl}: anon_all_* policy created`, () => {
        expect(MIG).toMatch(new RegExp(`anon_all_${tbl}`));
      });
      it(`${tbl}: auth_internal_* policy created`, () => {
        expect(MIG).toMatch(new RegExp(`auth_internal_${tbl}`));
      });
    }
  });

  describe("RLS policies wrapped in DO $$ ... EXCEPTION WHEN duplicate_object", () => {
    it("at least 12 policies (6 tables x 2 templates)", () => {
      const wrapped = MIG.match(/EXCEPTION WHEN duplicate_object THEN NULL/g) || [];
      expect(wrapped.length).toBeGreaterThanOrEqual(12);
    });
  });

  describe("GL account seeds (arch §3.10)", () => {
    it("seeds 1310 Inventory In-Transit (asset / DEBIT)", () => {
      expect(MIG).toMatch(/'1310'[\s\S]*?'Inventory In-Transit'/);
    });
    it("seeds 1320 Inventory On QC Hold (asset / DEBIT)", () => {
      expect(MIG).toMatch(/'1320'[\s\S]*?'Inventory On QC Hold'/);
    });
    it("seeds 5100 Inbound Freight (expense)", () => {
      expect(MIG).toMatch(/'5100'[\s\S]*?'Inbound Freight'/);
    });
    it("seeds 5110 Customs Duty (expense)", () => {
      expect(MIG).toMatch(/'5110'[\s\S]*?'Customs Duty'/);
    });
    it("seeds 5120 Brokerage \\+ Clearance (expense)", () => {
      expect(MIG).toMatch(/'5120'[\s\S]*?'Brokerage \+ Clearance'/);
    });
    it("seeds 5130 Section 301 Tariffs (expense)", () => {
      expect(MIG).toMatch(/'5130'[\s\S]*?'Section 301 Tariffs'/);
    });
    it("seeds 2150 Accrued Customs / Duty (liability / CREDIT)", () => {
      expect(MIG).toMatch(/'2150'[\s\S]*?'Accrued Customs \/ Duty'/);
    });
    it("seeds 6320 PO Variance Expense (expense)", () => {
      expect(MIG).toMatch(/'6320'[\s\S]*?'PO Variance Expense'/);
    });
    it("all GL seeds use ON CONFLICT (entity_id, code) DO NOTHING (idempotent)", () => {
      const onConflicts =
        MIG.match(/ON CONFLICT \(entity_id, code\) DO NOTHING/g) || [];
      expect(onConflicts.length).toBeGreaterThanOrEqual(8);
    });
    it("GL seeds gated on existence of ROF entity (graceful skip)", () => {
      expect(MIG).toMatch(
        /SELECT id INTO v_rof FROM entities WHERE code = 'ROF'/,
      );
    });
  });

  describe("procurement_status backfill (UPDATE tanda_pos)", () => {
    it("contains UPDATE tanda_pos SET procurement_status = CASE", () => {
      expect(MIG).toMatch(
        /UPDATE tanda_pos[\s\S]*?SET procurement_status = CASE/,
      );
    });
    it("backfill maps received/closed/complete into 'received'", () => {
      expect(MIG).toMatch(
        /lower\(coalesce\(data->>'StatusName',''\)\)[\s\S]*?'received'[\s\S]*?'closed'[\s\S]*?THEN 'received'/,
      );
    });
    it("backfill maps released/in_production into 'open'", () => {
      expect(MIG).toMatch(
        /'released'[\s\S]*?'in_production'[\s\S]*?THEN 'open'/,
      );
    });
    it("backfill maps draft/pending into 'draft'", () => {
      expect(MIG).toMatch(/'draft'[\s\S]*?'pending'[\s\S]*?THEN 'draft'/);
    });
    it("backfill maps cancelled/voided into 'cancelled'", () => {
      expect(MIG).toMatch(
        /'cancelled'[\s\S]*?'voided'[\s\S]*?THEN 'cancelled'/,
      );
    });
    it("default ELSE branch is 'open' for unknown statuses", () => {
      expect(MIG).toMatch(/ELSE 'open'/);
    });
    it("backfill is idempotent (only fills NULL procurement_status)", () => {
      expect(MIG).toMatch(
        /UPDATE tanda_pos[\s\S]*?WHERE procurement_status IS NULL/,
      );
    });
  });

  describe("pilot vendor seed (D18 — Zhejiang Zhuji Newdan)", () => {
    it("vendor lookup fuzzy-matches Zhejiang Zhuji Newdan", () => {
      expect(MIG).toMatch(/Zhejiang%Zhuji%Newdan/);
    });
    it("lookup checks legal_name, name, and aliases array", () => {
      expect(MIG).toMatch(/legal_name ILIKE/);
      expect(MIG).toMatch(/name\s+ILIKE/);
      expect(MIG).toMatch(/unnest\(coalesce\(aliases/);
    });
    it("falls back to INSERT INTO vendors when not found", () => {
      expect(MIG).toMatch(
        /INSERT INTO vendors[\s\S]*?Zhejiang Zhuji Newdan Garment Co\., Ltd\./,
      );
    });
    it("inserts with country='CN' and currency='USD' (D2)", () => {
      expect(MIG).toMatch(
        /Zhejiang Zhuji Newdan[\s\S]*?'CN'[\s\S]*?'USD'/,
      );
    });
    it("tags vendors.pilot_vendor = true on the matched row", () => {
      expect(MIG).toMatch(/UPDATE vendors SET pilot_vendor = true WHERE id = v_id/);
    });
    it("tags tanda_pos.pilot_vendor_flag = true on the vendor's POs", () => {
      expect(MIG).toMatch(
        /UPDATE tanda_pos[\s\S]*?SET pilot_vendor_flag = true[\s\S]*?WHERE vendor_id = v_id/,
      );
    });
    it("pilot tagging is idempotent (skips already-flagged rows)", () => {
      expect(MIG).toMatch(/pilot_vendor_flag = false/);
      expect(MIG).toMatch(/pilot_vendor = false/);
    });
    it("wrapped in a DO $$ block", () => {
      expect(MIG).toMatch(/DO \$\$[\s\S]*?v_id uuid[\s\S]*?END \$\$;/);
    });
  });

  describe("M27 approval rule — D19 receipt rollup invoices", () => {
    it("INSERTs into approval_rules with kind='ap_invoice_post'", () => {
      expect(MIG).toMatch(
        /INSERT INTO approval_rules[\s\S]*?'ap_invoice_post'/,
      );
    });
    it("rule name flags the D19 receipt-rollup origin", () => {
      expect(MIG).toMatch(/Receipt rollup AP invoice/);
    });
    it("match jsonb keys on is_receipt_rollup=true + pending_bookkeeper_approval", () => {
      expect(MIG).toMatch(/'is_receipt_rollup'[\s\S]*?true/);
      expect(MIG).toMatch(/'status'[\s\S]*?'pending_bookkeeper_approval'/);
    });
    it("steps jsonb routes to bookkeeper role", () => {
      expect(MIG).toMatch(/'approver_role'[\s\S]*?'bookkeeper'/);
    });
    it("seed is idempotent via WHERE NOT EXISTS", () => {
      expect(MIG).toMatch(
        /WHERE NOT EXISTS[\s\S]*?FROM approval_rules[\s\S]*?Receipt rollup AP invoice/,
      );
    });
    it("seed gated on existence of ROF entity (graceful skip)", () => {
      const blockMatch = MIG.match(
        /DO \$\$[\s\S]*?ap_invoice_post[\s\S]*?END \$\$;/,
      );
      expect(blockMatch).toBeTruthy();
      expect(blockMatch[0]).toMatch(/v_rof[\s\S]*?ROF/);
    });
    it("uses jsonb_build_object / jsonb_build_array (no raw text concat)", () => {
      expect(MIG).toMatch(/jsonb_build_object\([\s\S]*?'is_receipt_rollup'/);
      expect(MIG).toMatch(/jsonb_build_array\([\s\S]*?jsonb_build_object/);
    });
  });

  describe("PostgREST cache reload footer", () => {
    it("ends with NOTIFY pgrst, 'reload schema'", () => {
      expect(MIG).toMatch(/NOTIFY pgrst, 'reload schema';/);
    });
  });

  describe("idempotency primitives", () => {
    it("all 6 new tables use CREATE TABLE IF NOT EXISTS", () => {
      const creates = MIG.match(/CREATE TABLE IF NOT EXISTS/g) || [];
      expect(creates.length).toBeGreaterThanOrEqual(6);
    });
    it("no bare CREATE TABLE without IF NOT EXISTS", () => {
      const bare = MIG.match(/CREATE TABLE(?! IF NOT EXISTS)/g) || [];
      expect(bare.length).toBe(0);
    });
    it("vendors extensions use ADD COLUMN IF NOT EXISTS (>= 7 cols)", () => {
      const adds = MIG.match(/ALTER TABLE vendors ADD COLUMN IF NOT EXISTS/g) || [];
      expect(adds.length).toBeGreaterThanOrEqual(7);
    });
    it("ip_item_master extensions use ADD COLUMN IF NOT EXISTS (>= 4 cols)", () => {
      const adds = MIG.match(/ALTER TABLE ip_item_master ADD COLUMN IF NOT EXISTS/g) || [];
      expect(adds.length).toBeGreaterThanOrEqual(4);
    });
    it("receipts extensions use ADD COLUMN IF NOT EXISTS (>= 11 cols)", () => {
      const adds = MIG.match(/ALTER TABLE receipts ADD COLUMN IF NOT EXISTS/g) || [];
      expect(adds.length).toBeGreaterThanOrEqual(11);
    });
    it("receipt_line_items extensions use ADD COLUMN IF NOT EXISTS (>= 7 cols)", () => {
      const adds = MIG.match(/ALTER TABLE receipt_line_items ADD COLUMN IF NOT EXISTS/g) || [];
      expect(adds.length).toBeGreaterThanOrEqual(7);
    });
    it("forward FK constraints on receipts wrapped in DO-block (PG <15)", () => {
      expect(MIG).toMatch(
        /DO \$\$ BEGIN[\s\S]*?ALTER TABLE receipts ADD CONSTRAINT receipts_customs_fk[\s\S]*?EXCEPTION WHEN duplicate_object/,
      );
      expect(MIG).toMatch(
        /DO \$\$ BEGIN[\s\S]*?ALTER TABLE receipts ADD CONSTRAINT receipts_broker_fk[\s\S]*?EXCEPTION WHEN duplicate_object/,
      );
    });
  });

  describe("no COMMENT ON ... IS string-concat (P12-0 hotfix PR #485)", () => {
    it("no COMMENT body uses the || operator (Postgres requires string literal)", () => {
      const lines = MIG.split(/\r?\n/);
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line.trimStart().startsWith("--")) {
          i++;
          continue;
        }
        if (/^\s*COMMENT ON .* IS /.test(line)) {
          let body = line;
          while (!/;\s*(--.*)?$/.test(body) && i + 1 < lines.length) {
            i++;
            body += "\n" + lines[i];
          }
          expect(body).not.toMatch(/\|\|/);
        }
        i++;
      }
    });
  });
});

describe("P13 arch doc — §7.2 P13-2 scope alignment", () => {
  it("§7 chunk table lists P13-2 as the legacy-side schema chunk", () => {
    expect(ARCH).toMatch(/\*\*P13-2\*\*/);
    expect(ARCH).toMatch(/P13-2[\s\S]*?Legacy/i);
  });
  it("§7.2 enumerates 3.3 / 3.4 / 3.5 / 3.6 / 3.7 / 3.8 schema sections", () => {
    // Pin to the P13-2 row in the §7 chunk table (one logical line, then |).
    const rowMatch = ARCH.match(/\*\*P13-2\*\*[^\n]*/);
    expect(rowMatch).toBeTruthy();
    const row = rowMatch[0];
    for (const sec of ["3.3", "3.4", "3.5", "3.6", "3.7", "3.8"]) {
      expect(row).toContain(sec);
    }
  });
  it("D18 pilot vendor confirmed as Zhejiang Zhuji Newdan Garment Co., Ltd.", () => {
    expect(ARCH).toMatch(/Zhejiang Zhuji Newdan Garment Co\., Ltd\./);
  });
});
