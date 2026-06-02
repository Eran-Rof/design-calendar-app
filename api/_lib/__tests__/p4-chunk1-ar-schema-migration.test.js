// Static-shape tests for the P4-1 AR schema migration.
//
// Pure-text grep over the SQL file. We are NOT running the migration in CI;
// we just validate the bundle's shape so reviewers know the required pieces
// landed (CHECK constraints, idempotency guards, indexes per arch §3.2).
//
// Per docs/tangerine/P4-ar-architecture.md §3 + §6 + §10.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../supabase/migrations/20260528100000_p4_chunk1_ar_schema.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");

describe("P4-1 AR schema migration", () => {
  it("file exists and is non-trivial", () => {
    expect(sql.length).toBeGreaterThan(5000);
  });

  // ── Idempotency ──────────────────────────────────────────────────────────
  describe("idempotency", () => {
    it("all CREATE TABLE statements use IF NOT EXISTS", () => {
      const creates = sql.match(/CREATE TABLE\s+(?!IF NOT EXISTS)/g) || [];
      expect(creates).toEqual([]);
    });

    it("all CREATE INDEX statements use IF NOT EXISTS", () => {
      const creates = sql.match(/CREATE INDEX\s+(?!IF NOT EXISTS)/g) || [];
      expect(creates).toEqual([]);
    });

    it("CHECK constraints follow drop-then-create pattern", () => {
      // Spot-check the major ones.
      expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS ar_invoices_invoice_kind_check/);
      expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS ar_invoices_gl_status_check/);
      expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS ar_invoices_amounts_nonneg/);
      expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS customers_credit_limit_cents_nonneg/);
    });

    it("inventory_layers source_kind extension wrapped in DO $$ guard", () => {
      expect(sql).toMatch(/DO \$\$[\s\S]*?inventory_layers_source_kind_check[\s\S]*?customer_return[\s\S]*?END \$\$/);
    });

    it("ALTER TABLE entities uses ADD COLUMN IF NOT EXISTS", () => {
      const altersWithoutGuard = sql.match(/ALTER TABLE entities[\s\S]*?ADD COLUMN(?!\s+IF NOT EXISTS)/g) || [];
      expect(altersWithoutGuard).toEqual([]);
    });

    it("ALTER TABLE customers uses ADD COLUMN IF NOT EXISTS", () => {
      const altersWithoutGuard = sql.match(/ALTER TABLE customers[\s\S]*?ADD COLUMN(?!\s+IF NOT EXISTS)/g) || [];
      expect(altersWithoutGuard).toEqual([]);
    });

    it("migration-tracking footer is wrapped in defensive DO $$ guard", () => {
      expect(sql).toMatch(/DO \$\$[\s\S]*?schema_migrations[\s\S]*?ON CONFLICT \(version\) DO NOTHING/);
    });
  });

  // ── Tables ───────────────────────────────────────────────────────────────
  describe("tables", () => {
    it("creates ar_invoices", () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS ar_invoices\b/);
    });
    it("creates ar_invoice_lines", () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS ar_invoice_lines\b/);
    });
    it("creates ar_receipts", () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS ar_receipts\b/);
    });
    it("creates ar_receipt_applications", () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS ar_receipt_applications\b/);
    });
  });

  // ── ar_invoices columns ─────────────────────────────────────────────────
  describe("ar_invoices required columns", () => {
    const cols = [
      "entity_id",
      "customer_id",
      "invoice_number",
      "invoice_kind",
      "gl_status",
      "invoice_date",
      "posting_date",
      "due_date",
      "payment_terms_id",
      "revenue_account_id",
      "ar_account_id",
      "cogs_account_id",
      "inventory_asset_account_id",
      "accrual_je_id",
      "cash_je_id",
      "total_amount_cents",
      "paid_amount_cents",
      "description",
      "notes",
      "created_at",
      "updated_at",
      "created_by_user_id",
    ];
    for (const c of cols) {
      it(`has column ${c}`, () => {
        // Look for the column within the ar_invoices CREATE TABLE block.
        const block = sql.split(/CREATE TABLE IF NOT EXISTS ar_invoices/)[1].split(/CREATE TABLE/)[0];
        expect(block).toMatch(new RegExp(`\\b${c}\\b`));
      });
    }
    it("UNIQUE (entity_id, invoice_number)", () => {
      expect(sql).toMatch(/ar_invoices_entity_number_unique UNIQUE \(entity_id, invoice_number\)/);
    });
  });

  // ── CHECK constraints ────────────────────────────────────────────────────
  describe("CHECK constraints", () => {
    it("invoice_kind includes customer_invoice + customer_credit_memo + customer_invoice_historical", () => {
      expect(sql).toMatch(/invoice_kind IN \('customer_invoice','customer_credit_memo','customer_invoice_historical'\)/);
    });

    it("gl_status includes posted_historical + paid + partial_paid + reversed + void", () => {
      const m = sql.match(/gl_status IN \(([^)]+)\)/);
      expect(m).not.toBeNull();
      const list = m[1];
      for (const s of ["unposted", "pending_approval", "posted", "posted_historical", "paid", "partial_paid", "reversed", "void"]) {
        expect(list).toMatch(new RegExp(`'${s}'`));
      }
    });

    it("ar_receipts.customer_payment_method allows all listed methods", () => {
      const m = sql.match(/customer_payment_method IN \(([^)]+)\)/);
      expect(m).not.toBeNull();
      for (const method of ["ach", "wire", "check", "credit_card", "cash", "paypal", "stripe", "other"]) {
        expect(m[1]).toMatch(new RegExp(`'${method}'`));
      }
    });

    it("ar_receipts.amount_cents > 0", () => {
      expect(sql).toMatch(/ar_receipts_amount_positive CHECK \(amount_cents > 0\)/);
    });

    it("ar_receipt_applications.amount_applied_cents > 0", () => {
      expect(sql).toMatch(/ar_receipt_applications_amount_positive CHECK \(amount_applied_cents > 0\)/);
    });

    it("ar_receipt_applications UNIQUE (ar_receipt_id, ar_invoice_id)", () => {
      expect(sql).toMatch(/ar_receipt_applications_unique_pair UNIQUE \(ar_receipt_id, ar_invoice_id\)/);
    });

    it("customers.credit_limit_cents >= 0", () => {
      expect(sql).toMatch(/customers_credit_limit_cents_nonneg[\s\S]*?CHECK \(credit_limit_cents >= 0\)/);
    });
  });

  // ── Indexes ─────────────────────────────────────────────────────────────
  describe("indexes per arch §3.2", () => {
    it("idx_ar_invoices_entity_pending_approval is partial", () => {
      expect(sql).toMatch(
        /idx_ar_invoices_entity_pending_approval[\s\S]*?WHERE gl_status = 'pending_approval'/,
      );
    });
    it("idx_ar_invoices_due_date_unpaid is partial (paid<total)", () => {
      expect(sql).toMatch(
        /idx_ar_invoices_due_date_unpaid[\s\S]*?WHERE paid_amount_cents < total_amount_cents/,
      );
    });
    it("idx_ar_invoices_entity_posting_date orders DESC", () => {
      expect(sql).toMatch(/idx_ar_invoices_entity_posting_date[\s\S]*?\(entity_id, posting_date DESC\)/);
    });
    it("idx_ar_invoices_customer covers customer_id", () => {
      expect(sql).toMatch(/idx_ar_invoices_customer[\s\S]*?\(customer_id\)/);
    });
    it("idx_ar_invoice_lines_inventory_item is partial NOT NULL", () => {
      expect(sql).toMatch(
        /idx_ar_invoice_lines_inventory_item[\s\S]*?WHERE inventory_item_id IS NOT NULL/,
      );
    });
    it("idx_ar_receipts_entity_date orders DESC", () => {
      expect(sql).toMatch(/idx_ar_receipts_entity_date[\s\S]*?\(entity_id, receipt_date DESC\)/);
    });
  });

  // ── RLS ─────────────────────────────────────────────────────────────────
  describe("RLS — P1 template", () => {
    const tbls = ["ar_invoices", "ar_invoice_lines", "ar_receipts", "ar_receipt_applications"];
    for (const t of tbls) {
      it(`${t}: anon_all + auth_internal policy + RLS enabled`, () => {
        expect(sql).toMatch(new RegExp(`ALTER TABLE ${t}\\s+ENABLE ROW LEVEL SECURITY`));
        expect(sql).toMatch(new RegExp(`anon_all_${t}`));
        expect(sql).toMatch(new RegExp(`auth_internal_${t}`));
      });
    }
  });

  // ── Triggers ────────────────────────────────────────────────────────────
  describe("triggers", () => {
    it("ar_invoice_lines compute line_total trigger exists", () => {
      expect(sql).toMatch(/ar_invoice_lines_compute_total_trg/);
      expect(sql).toMatch(/BEFORE INSERT OR UPDATE OF quantity, unit_price_cents/);
    });
    it("ar_invoice_lines total maintainer trigger exists", () => {
      expect(sql).toMatch(/ar_invoice_lines_total_trg/);
      expect(sql).toMatch(/ar_invoice_lines_maintain_total/);
    });
    it("ar_receipt_apps paid maintainer trigger exists", () => {
      expect(sql).toMatch(/ar_receipt_apps_paid_trg/);
    });
    it("ar_receipt_apps over-application guard exists", () => {
      expect(sql).toMatch(/ar_receipt_apps_overapply_guard_trg/);
      expect(sql).toMatch(/over-application rejected/);
    });
    it("ar_invoices status-from-paid trigger exists", () => {
      expect(sql).toMatch(/ar_invoices_status_from_paid_trg/);
    });
    it("touch_updated_at triggers exist for all 4 tables", () => {
      for (const t of ["ar_invoices", "ar_invoice_lines", "ar_receipts", "ar_receipt_applications"]) {
        expect(sql).toMatch(new RegExp(`${t}_touch_updated_at`));
      }
    });
  });

  // ── Period-lock bypass for historical-backfill ──────────────────────────
  describe("journal_entry_post_guards historical bypass", () => {
    it("recognizes ar_invoice_historical journal_type", () => {
      expect(sql).toMatch(/'ar_invoice_historical'/);
    });
    it("recognizes ar_receipt_historical journal_type", () => {
      expect(sql).toMatch(/'ar_receipt_historical'/);
    });
    it("recognizes ap_invoice_historical defensively", () => {
      expect(sql).toMatch(/'ap_invoice_historical'/);
    });
    it("bypass is conditional on v_is_historical, not operator-settable", () => {
      expect(sql).toMatch(/v_is_historical/);
      expect(sql).toMatch(/AND NOT v_is_historical/);
    });
    it("documents trigger-side lock in COMMENT", () => {
      expect(sql).toMatch(/TRIGGER-SIDE LOCKED/);
    });
  });

  // ── Views + function ─────────────────────────────────────────────────────
  describe("views and aging function", () => {
    it("v_cash_receipts_journal view exists", () => {
      expect(sql).toMatch(/CREATE OR REPLACE VIEW v_cash_receipts_journal/);
    });
    it("v_ar_unapplied_receipts view exists", () => {
      expect(sql).toMatch(/CREATE OR REPLACE VIEW v_ar_unapplied_receipts/);
    });
    it("v_ar_aging view exists", () => {
      expect(sql).toMatch(/CREATE OR REPLACE VIEW v_ar_aging/);
    });
    it("v_ar_aging uses standard age buckets", () => {
      for (const bucket of ["'current'", "'1-30'", "'31-60'", "'61-90'", "'91-120'", "'120+'"]) {
        expect(sql).toMatch(new RegExp(bucket));
      }
    });
    it("v_ar_aging filters paid<total + posted/posted_historical/partial_paid/sent", () => {
      const m = sql.split(/CREATE OR REPLACE VIEW v_ar_aging/)[1];
      expect(m).toMatch(/paid_amount_cents\s*<\s*\S*total_amount_cents/);
      expect(m).toMatch(/'posted'.*'posted_historical'.*'partial_paid'/s);
    });
    it("ar_aging_as_of function is STABLE and parameterized", () => {
      expect(sql).toMatch(/CREATE OR REPLACE FUNCTION ar_aging_as_of\(p_entity_id uuid, p_as_of_date date\)/);
      expect(sql).toMatch(/LANGUAGE sql STABLE/);
    });
  });

  // ── Migration tracking ──────────────────────────────────────────────────
  it("inserts version 20260528100000 into schema_migrations", () => {
    expect(sql).toMatch(/'20260528100000', 'p4_chunk1_ar_schema'/);
  });
});
