// Static-shape tests for P13-1 migration: Procurement schema
// (D19 receipt-rollup workflow with auto-AP-invoice + bookkeeper approval gate).
//
// Reads the migration SQL + the P13 architecture doc and asserts shape —
// does not require a live DB.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = readFileSync(
  resolve(here, "../../../supabase/migrations/20260629A00000_p13_chunk1_procurement_schema.sql"),
  "utf8",
);
const ARCH = readFileSync(
  resolve(here, "../../../docs/tangerine/P13-procurement-architecture.md"),
  "utf8",
);

const NEW_P13_TABLES = [
  "tanda_po_receipts",
  "tanda_po_receipt_lines",
  "tanda_po_receipt_rollups",
  "tanda_po_qc_inspections",
  "tanda_po_qc_findings",
  "vendor_compliance_certifications",
  "import_documentation",
];

const ENTITY_SCOPED_TABLES = [
  "tanda_po_receipts",
  "tanda_po_receipt_rollups",
  "tanda_po_qc_inspections",
  "vendor_compliance_certifications",
  "import_documentation",
];

describe("P13-1 — Procurement schema migration", () => {
  describe("CREATE TABLE for all 7 new procurement tables (idempotent)", () => {
    for (const tbl of NEW_P13_TABLES) {
      it(`${tbl}: CREATE TABLE IF NOT EXISTS`, () => {
        expect(MIG).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${tbl}`));
      });
    }
  });

  describe("tanda_pos extensions (D1 reuse-not-new, D18 pilot vendor)", () => {
    it("adds originated_by_employee_id FK to employees with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(
        /ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS originated_by_employee_id uuid\s+REFERENCES employees\(id\) ON DELETE SET NULL/,
      );
    });
    it("adds procurement_status text column", () => {
      expect(MIG).toMatch(
        /ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS procurement_status text/,
      );
    });
    it("adds expected_landed_cost_cents bigint", () => {
      expect(MIG).toMatch(
        /ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS expected_landed_cost_cents bigint/,
      );
    });
    it("adds actual_landed_cost_cents bigint", () => {
      expect(MIG).toMatch(
        /ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS actual_landed_cost_cents bigint/,
      );
    });
    it("adds pilot_vendor_flag boolean NOT NULL DEFAULT false (D18)", () => {
      expect(MIG).toMatch(
        /ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS pilot_vendor_flag boolean NOT NULL DEFAULT false/,
      );
    });
  });

  describe("tanda_po_receipts — receipt header", () => {
    it("entity_id DEFAULT coalesce(current_entity_id(), rof_entity_id())", () => {
      expect(MIG).toMatch(
        /tanda_po_receipts[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT coalesce\(current_entity_id\(\), rof_entity_id\(\)\)/,
      );
    });
    it("tanda_po_id FK to tanda_pos with ON DELETE RESTRICT", () => {
      expect(MIG).toMatch(
        /tanda_po_id\s+uuid NOT NULL REFERENCES tanda_pos\(uuid_id\) ON DELETE RESTRICT/,
      );
    });
    it("received_by_employee_id FK to employees with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(
        /received_by_employee_id\s+uuid REFERENCES employees\(id\) ON DELETE SET NULL/,
      );
    });
    it("status CHECK includes draft / pending_approval / approved / posted", () => {
      for (const s of ["draft", "pending_approval", "approved", "posted"]) {
        expect(MIG).toMatch(new RegExp(`'${s}'`));
      }
    });
    it("landed_cost_cents bigint NOT NULL DEFAULT 0", () => {
      expect(MIG).toMatch(/landed_cost_cents\s+bigint NOT NULL DEFAULT 0/);
    });
    it("je_id FK to journal_entries with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(
        /je_id\s+uuid REFERENCES journal_entries\(id\) ON DELETE SET NULL/,
      );
    });
    it("has (tanda_po_id, receipt_date DESC) index", () => {
      expect(MIG).toMatch(/tanda_po_receipts_po_idx/);
    });
  });

  describe("tanda_po_receipt_lines", () => {
    it("receipt_id FK to tanda_po_receipts with CASCADE on parent delete", () => {
      expect(MIG).toMatch(
        /receipt_id\s+uuid NOT NULL REFERENCES tanda_po_receipts\(id\) ON DELETE CASCADE/,
      );
    });
    it("po_line_item_id FK to po_line_items with ON DELETE RESTRICT", () => {
      expect(MIG).toMatch(
        /po_line_item_id\s+uuid NOT NULL REFERENCES po_line_items\(id\) ON DELETE RESTRICT/,
      );
    });
    it("qty_received int with CHECK > 0", () => {
      expect(MIG).toMatch(/qty_received\s+int NOT NULL CHECK \(qty_received > 0\)/);
    });
    it("qty_accepted int with CHECK >= 0", () => {
      expect(MIG).toMatch(/qty_accepted\s+int NOT NULL CHECK \(qty_accepted >= 0\)/);
    });
    it("unit_cost_cents bigint CHECK >= 0 (pre-rollup PO cost)", () => {
      expect(MIG).toMatch(/unit_cost_cents\s+bigint NOT NULL CHECK \(unit_cost_cents >= 0\)/);
    });
    it("landed_unit_cost_cents bigint (computed post-rollup)", () => {
      expect(MIG).toMatch(/landed_unit_cost_cents\s+bigint/);
    });
    it("inventory_location_id FK to inventory_locations with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(
        /inventory_location_id\s+uuid REFERENCES inventory_locations\(id\) ON DELETE SET NULL/,
      );
    });
    it("inventory_layer_id FK to inventory_layers with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(
        /inventory_layer_id\s+uuid REFERENCES inventory_layers\(id\) ON DELETE SET NULL/,
      );
    });
    it("UNIQUE (receipt_id, po_line_item_id)", () => {
      expect(MIG).toMatch(/UNIQUE \(receipt_id, po_line_item_id\)/);
    });
  });

  describe("tanda_po_receipt_rollups (D19 — auto-AP rollup)", () => {
    it("entity_id DEFAULT coalesce(current_entity_id(), rof_entity_id())", () => {
      expect(MIG).toMatch(
        /tanda_po_receipt_rollups[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT coalesce\(current_entity_id\(\), rof_entity_id\(\)\)/,
      );
    });
    it("receipt_id FK to tanda_po_receipts with CASCADE", () => {
      expect(MIG).toMatch(
        /tanda_po_receipt_rollups[\s\S]*?receipt_id\s+uuid NOT NULL REFERENCES tanda_po_receipts\(id\) ON DELETE CASCADE/,
      );
    });
    it("expense_gl_account_id FK to gl_accounts with ON DELETE RESTRICT", () => {
      expect(MIG).toMatch(
        /expense_gl_account_id\s+uuid NOT NULL REFERENCES gl_accounts\(id\) ON DELETE RESTRICT/,
      );
    });
    it("amount_cents bigint NOT NULL CHECK > 0", () => {
      expect(MIG).toMatch(/amount_cents\s+bigint NOT NULL CHECK \(amount_cents > 0\)/);
    });
    it("vendor_id FK to vendors with ON DELETE SET NULL (often != PO vendor)", () => {
      expect(MIG).toMatch(
        /tanda_po_receipt_rollups[\s\S]*?vendor_id\s+uuid REFERENCES vendors\(id\) ON DELETE SET NULL/,
      );
    });
    it("description text NOT NULL", () => {
      expect(MIG).toMatch(/description\s+text NOT NULL/);
    });
    it("capitalized_to_inventory boolean NOT NULL DEFAULT true", () => {
      expect(MIG).toMatch(
        /capitalized_to_inventory\s+boolean NOT NULL DEFAULT true/,
      );
    });
    it("auto_invoice_id FK to invoices with ON DELETE SET NULL (D19 link)", () => {
      expect(MIG).toMatch(
        /auto_invoice_id\s+uuid REFERENCES invoices\(id\) ON DELETE SET NULL/,
      );
    });
    it("has (receipt_id) index", () => {
      expect(MIG).toMatch(/tanda_po_receipt_rollups_receipt_idx/);
    });
    it("has (auto_invoice_id) index", () => {
      expect(MIG).toMatch(/tanda_po_receipt_rollups_invoice_idx/);
    });
  });

  describe("invoices extensions (D19)", () => {
    it("adds is_receipt_rollup boolean NOT NULL DEFAULT false", () => {
      expect(MIG).toMatch(
        /ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_receipt_rollup boolean NOT NULL DEFAULT false/,
      );
    });
    it("adds rollup_parent_receipt_id uuid FK to tanda_po_receipts", () => {
      expect(MIG).toMatch(
        /ALTER TABLE invoices ADD COLUMN IF NOT EXISTS rollup_parent_receipt_id uuid[\s\S]*?REFERENCES tanda_po_receipts\(id\) ON DELETE SET NULL/,
      );
    });
    it("drops old invoices.status CHECK constraint", () => {
      expect(MIG).toMatch(/DROP CONSTRAINT IF EXISTS invoices_status_check/);
    });
    it("adds new invoices.status CHECK with pending_bookkeeper_approval", () => {
      expect(MIG).toMatch(
        /ADD CONSTRAINT invoices_status_check[\s\S]*?'pending_bookkeeper_approval'/,
      );
    });
    it("preserves all 6 existing invoices.status enum values", () => {
      const preserved = [
        "submitted",
        "under_review",
        "approved",
        "paid",
        "rejected",
        "disputed",
      ];
      // The full extended CHECK must list each existing value plus the new one
      for (const v of preserved) {
        expect(MIG).toMatch(
          new RegExp(`invoices_status_check[\\s\\S]*?'${v}'`),
        );
      }
    });
    it("creates partial index for pending_bookkeeper_approval rows", () => {
      expect(MIG).toMatch(
        /idx_invoices_pending_bookkeeper[\s\S]*?WHERE status = 'pending_bookkeeper_approval'/,
      );
    });
    it("creates partial index for rollup_parent_receipt_id rows", () => {
      expect(MIG).toMatch(
        /idx_invoices_rollup_parent[\s\S]*?WHERE rollup_parent_receipt_id IS NOT NULL/,
      );
    });
  });

  describe("tanda_po_qc_inspections (M26)", () => {
    it("entity_id DEFAULT coalesce(current_entity_id(), rof_entity_id())", () => {
      expect(MIG).toMatch(
        /tanda_po_qc_inspections[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT coalesce\(current_entity_id\(\), rof_entity_id\(\)\)/,
      );
    });
    it("receipt_id FK to tanda_po_receipts with CASCADE", () => {
      expect(MIG).toMatch(
        /tanda_po_qc_inspections[\s\S]*?receipt_id\s+uuid NOT NULL REFERENCES tanda_po_receipts\(id\) ON DELETE CASCADE/,
      );
    });
    it("inspector_employee_id FK to employees with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(
        /inspector_employee_id\s+uuid REFERENCES employees\(id\) ON DELETE SET NULL/,
      );
    });
    it("status CHECK includes pending / passed / failed / partial", () => {
      for (const s of ["pending", "passed", "failed", "partial"]) {
        expect(MIG).toMatch(new RegExp(`'${s}'`));
      }
    });
    it("overall_pass_rate numeric(5,4)", () => {
      expect(MIG).toMatch(/overall_pass_rate\s+numeric\(5,4\)/);
    });
  });

  describe("tanda_po_qc_findings (M26)", () => {
    it("inspection_id FK to tanda_po_qc_inspections with CASCADE", () => {
      expect(MIG).toMatch(
        /inspection_id\s+uuid NOT NULL REFERENCES tanda_po_qc_inspections\(id\) ON DELETE CASCADE/,
      );
    });
    it("severity CHECK includes minor / major / critical", () => {
      for (const s of ["minor", "major", "critical"]) {
        expect(MIG).toMatch(new RegExp(`'${s}'`));
      }
    });
    it("photo_urls text[] for M29 attachments", () => {
      expect(MIG).toMatch(/photo_urls\s+text\[\]/);
    });
  });

  describe("vendor_compliance_certifications (M48)", () => {
    it("entity_id DEFAULT coalesce(current_entity_id(), rof_entity_id())", () => {
      expect(MIG).toMatch(
        /vendor_compliance_certifications[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT coalesce\(current_entity_id\(\), rof_entity_id\(\)\)/,
      );
    });
    it("vendor_id FK to vendors with ON DELETE CASCADE", () => {
      expect(MIG).toMatch(
        /vendor_compliance_certifications[\s\S]*?vendor_id\s+uuid NOT NULL REFERENCES vendors\(id\) ON DELETE CASCADE/,
      );
    });
    it("status CHECK includes active / expired / revoked / pending", () => {
      for (const s of ["active", "expired", "revoked", "pending"]) {
        expect(MIG).toMatch(new RegExp(`'${s}'`));
      }
    });
    it("has (vendor_id, status) index", () => {
      expect(MIG).toMatch(/vendor_compliance_vendor_idx/);
    });
    it("has expiring-active partial index", () => {
      expect(MIG).toMatch(
        /vendor_compliance_expiring_idx[\s\S]*?WHERE status = 'active'/,
      );
    });
  });

  describe("import_documentation (M48)", () => {
    it("entity_id DEFAULT coalesce(current_entity_id(), rof_entity_id())", () => {
      expect(MIG).toMatch(
        /import_documentation[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT coalesce\(current_entity_id\(\), rof_entity_id\(\)\)/,
      );
    });
    it("tanda_po_id FK to tanda_pos with CASCADE", () => {
      expect(MIG).toMatch(
        /import_documentation[\s\S]*?tanda_po_id\s+uuid NOT NULL REFERENCES tanda_pos\(uuid_id\) ON DELETE CASCADE/,
      );
    });
    it("declared_value_cents bigint", () => {
      expect(MIG).toMatch(/declared_value_cents\s+bigint/);
    });
    it("duty_rate_pct numeric(8,4)", () => {
      expect(MIG).toMatch(/duty_rate_pct\s+numeric\(8,4\)/);
    });
    it("status CHECK includes pending / received / verified / filed", () => {
      for (const s of ["pending", "received", "verified", "filed"]) {
        expect(MIG).toMatch(new RegExp(`'${s}'`));
      }
    });
    it("has (tanda_po_id) index", () => {
      expect(MIG).toMatch(/import_docs_po_idx/);
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
    for (const tbl of NEW_P13_TABLES) {
      it(`${tbl}: ENABLE ROW LEVEL SECURITY`, () => {
        expect(MIG).toMatch(new RegExp(`ALTER TABLE ${tbl}\\s+ENABLE ROW LEVEL SECURITY`));
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
    it("at least 14 policies (7 tables × 2 templates)", () => {
      const wrapped = MIG.match(/EXCEPTION WHEN duplicate_object THEN NULL/g) || [];
      expect(wrapped.length).toBeGreaterThanOrEqual(14);
    });
  });

  describe("PostgREST cache reload footer", () => {
    it("ends with NOTIFY pgrst, 'reload schema'", () => {
      expect(MIG).toMatch(/NOTIFY pgrst, 'reload schema';/);
    });
  });

  describe("idempotency primitives", () => {
    it("all 7 new tables use CREATE TABLE IF NOT EXISTS", () => {
      const creates = MIG.match(/CREATE TABLE IF NOT EXISTS/g) || [];
      expect(creates.length).toBeGreaterThanOrEqual(7);
    });
    it("no bare CREATE TABLE without IF NOT EXISTS", () => {
      const bare = MIG.match(/CREATE TABLE(?! IF NOT EXISTS)/g) || [];
      expect(bare.length).toBe(0);
    });
    it("tanda_pos extensions use ADD COLUMN IF NOT EXISTS", () => {
      const adds = MIG.match(/ALTER TABLE tanda_pos ADD COLUMN IF NOT EXISTS/g) || [];
      expect(adds.length).toBeGreaterThanOrEqual(5);
    });
    it("invoices extensions use ADD COLUMN IF NOT EXISTS", () => {
      const adds = MIG.match(/ALTER TABLE invoices ADD COLUMN IF NOT EXISTS/g) || [];
      expect(adds.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("no COMMENT ON ... IS string-concat (P12-0 hotfix PR #485)", () => {
    it("no COMMENT body uses the || operator (Postgres requires string literal)", () => {
      const lines = MIG.split(/\r?\n/);
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line.trimStart().startsWith("--")) { i++; continue; }
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

describe("P13 arch doc — D19 amendment", () => {
  it("§2 includes a D19 decision row", () => {
    expect(ARCH).toMatch(/\| D19 \|/);
  });
  it("D19 mentions auto-AP-invoice + bookkeeper approval gate", () => {
    expect(ARCH).toMatch(/D19[\s\S]*?auto-AP/i);
    expect(ARCH).toMatch(/D19[\s\S]*?bookkeeper/i);
  });
  it("D19 references tanda_po_receipt_rollups and pending_bookkeeper_approval", () => {
    expect(ARCH).toMatch(/tanda_po_receipt_rollups/);
    expect(ARCH).toMatch(/pending_bookkeeper_approval/);
  });
  it("§3 schema additions sub-section for receipts + rollups (3.11) present", () => {
    expect(ARCH).toMatch(/### 3\.11/);
    expect(ARCH).toMatch(/tanda_po_receipts/);
  });
  it("§3 invoices extensions sub-section (3.12) present", () => {
    expect(ARCH).toMatch(/### 3\.12/);
    expect(ARCH).toMatch(/is_receipt_rollup/);
    expect(ARCH).toMatch(/rollup_parent_receipt_id/);
  });
  it("§6 JE pattern 6.9 covers D19 receipt-rollup + auto-AP", () => {
    expect(ARCH).toMatch(/### 6\.9/);
    expect(ARCH).toMatch(/6\.9[\s\S]*?D19/);
  });
  it("§7 implementation chunks call out P13-1 carrying D19 schema", () => {
    expect(ARCH).toMatch(/P13-1[\s\S]*?D19/);
  });
  it("§13 operator confirm notes D19 is part of P13-1", () => {
    expect(ARCH).toMatch(/D19[\s\S]*?P13-1/);
  });
  it("D18 pilot vendor recorded as Zhejiang Zhuji Newdan Garment Co., Ltd.", () => {
    expect(ARCH).toMatch(/Zhejiang Zhuji Newdan Garment/);
  });
});
