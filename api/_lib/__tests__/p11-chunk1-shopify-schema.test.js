// Static-shape tests for P11-1 migration: Shopify direct-integration
// foundation schema (5 entity-scoped tables + webhook log + GL seeds +
// inventory_layers source_kind extension).
//
// Reads the migration SQL + the token-encryption stub and asserts
// shape — does not require a live DB.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = readFileSync(
  resolve(here, "../../../supabase/migrations/20260629100000_p11_chunk1_shopify_schema.sql"),
  "utf8",
);
const STUB = readFileSync(
  resolve(here, "../../../api/_lib/shopify/token-encryption.js"),
  "utf8",
);

const SHOPIFY_TABLES = [
  "shopify_stores",
  "shopify_orders",
  "shopify_order_lines",
  "shopify_refunds",
  "shopify_payouts",
  "shopify_webhook_log",
];

const ENTITY_SCOPED_DEFAULT_TABLES = [
  "shopify_orders",
  "shopify_refunds",
  "shopify_payouts",
];

describe("P11-1 — Shopify foundation schema migration", () => {
  describe("CREATE TABLE for all 6 Shopify tables (idempotent)", () => {
    for (const tbl of SHOPIFY_TABLES) {
      it(`${tbl}: CREATE TABLE IF NOT EXISTS`, () => {
        expect(MIG).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${tbl}`));
      });
    }
  });

  describe("shopify_stores — per-store config", () => {
    it("has entity_id FK with ON DELETE RESTRICT", () => {
      expect(MIG).toMatch(/shopify_stores[\s\S]*?entity_id\s+uuid NOT NULL REFERENCES entities\(id\) ON DELETE RESTRICT/);
    });
    it("has access_token_ciphertext / iv / tag bytea columns", () => {
      expect(MIG).toMatch(/access_token_ciphertext\s+bytea/);
      expect(MIG).toMatch(/access_token_iv\s+bytea/);
      expect(MIG).toMatch(/access_token_tag\s+bytea/);
    });
    it("has webhook_secret_ciphertext / iv / tag bytea columns", () => {
      expect(MIG).toMatch(/webhook_secret_ciphertext\s+bytea/);
      expect(MIG).toMatch(/webhook_secret_iv\s+bytea/);
      expect(MIG).toMatch(/webhook_secret_tag\s+bytea/);
    });
    it("api_version DEFAULT '2025-01'", () => {
      expect(MIG).toMatch(/api_version\s+text NOT NULL DEFAULT '2025-01'/);
    });
    it("UNIQUE constraint on (entity_id, shopify_domain)", () => {
      expect(MIG).toMatch(/UNIQUE \(entity_id, shopify_domain\)/);
    });
  });

  describe("shopify_orders — order table", () => {
    it("entity_id has DEFAULT rof_entity_id()", () => {
      expect(MIG).toMatch(/shopify_orders[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT rof_entity_id\(\)/);
    });
    it("shopify_store_id FK to shopify_stores with ON DELETE RESTRICT", () => {
      expect(MIG).toMatch(/shopify_store_id\s+uuid NOT NULL REFERENCES shopify_stores\(id\) ON DELETE RESTRICT/);
    });
    it("source CHECK enforces 'shopify' only", () => {
      expect(MIG).toMatch(/source\s+text NOT NULL DEFAULT 'shopify' CHECK \(source IN \('shopify'\)\)/);
    });
    it("ar_invoice_id + je_id FKs with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/ar_invoice_id\s+uuid REFERENCES ar_invoices\(id\) ON DELETE SET NULL/);
      expect(MIG).toMatch(/je_id\s+uuid REFERENCES journal_entries\(id\) ON DELETE SET NULL/);
    });
    it("customer_id FK to customers with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/customer_id\s+uuid REFERENCES customers\(id\) ON DELETE SET NULL/);
    });
    it("has total/subtotal/tax/shipping/discount _amount_cents bigint", () => {
      for (const col of ["total_amount_cents", "subtotal_amount_cents", "tax_amount_cents", "shipping_amount_cents", "discount_amount_cents"]) {
        expect(MIG).toMatch(new RegExp(`${col}\\s+bigint`));
      }
    });
    it("UNIQUE (shopify_store_id, shopify_order_id) for dedup", () => {
      expect(MIG).toMatch(/UNIQUE \(shopify_store_id, shopify_order_id\)/);
    });
    it("has entity+processed_at and store+processed_at indexes", () => {
      expect(MIG).toMatch(/shopify_orders_entity_processed_idx/);
      expect(MIG).toMatch(/shopify_orders_store_processed_idx/);
    });
  });

  describe("shopify_order_lines", () => {
    it("FK to shopify_orders with CASCADE on parent delete", () => {
      expect(MIG).toMatch(/shopify_order_id\s+uuid NOT NULL REFERENCES shopify_orders\(id\) ON DELETE CASCADE/);
    });
    it("ip_item_master_id FK with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/ip_item_master_id\s+uuid REFERENCES ip_item_master\(id\) ON DELETE SET NULL/);
    });
    it("UNIQUE (shopify_order_id, line_number) for replay-safety", () => {
      expect(MIG).toMatch(/UNIQUE \(shopify_order_id, line_number\)/);
    });
  });

  describe("shopify_refunds", () => {
    it("entity_id has DEFAULT rof_entity_id()", () => {
      expect(MIG).toMatch(/shopify_refunds[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT rof_entity_id\(\)/);
    });
    it("refund_type CHECK includes full and partial", () => {
      expect(MIG).toMatch(/refund_type\s+text NOT NULL CHECK \(refund_type IN \('full','partial'\)\)/);
    });
    it("ar_credit_memo_id FK to ar_invoices (sibling credit memo for partial)", () => {
      expect(MIG).toMatch(/ar_credit_memo_id\s+uuid REFERENCES ar_invoices\(id\) ON DELETE SET NULL/);
    });
    it("restocking_fee_cents bigint DEFAULT 0", () => {
      expect(MIG).toMatch(/restocking_fee_cents\s+bigint NOT NULL DEFAULT 0/);
    });
    it("UNIQUE (shopify_order_id, shopify_refund_id) for dedup", () => {
      expect(MIG).toMatch(/UNIQUE \(shopify_order_id, shopify_refund_id\)/);
    });
  });

  describe("shopify_payouts", () => {
    it("entity_id has DEFAULT rof_entity_id()", () => {
      expect(MIG).toMatch(/shopify_payouts[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT rof_entity_id\(\)/);
    });
    it("bank_transaction_id FK to bank_transactions with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/bank_transaction_id\s+uuid REFERENCES bank_transactions\(id\) ON DELETE SET NULL/);
    });
    it("gross / fees / net amount_cents columns", () => {
      for (const col of ["gross_amount_cents", "fees_amount_cents", "net_amount_cents"]) {
        expect(MIG).toMatch(new RegExp(`${col}\\s+bigint NOT NULL`));
      }
    });
    it("UNIQUE (shopify_store_id, shopify_payout_id) for dedup", () => {
      expect(MIG).toMatch(/UNIQUE \(shopify_store_id, shopify_payout_id\)/);
    });
  });

  describe("shopify_webhook_log — idempotency", () => {
    it("UNIQUE (webhook_id) for at-least-once dedup", () => {
      expect(MIG).toMatch(/UNIQUE \(webhook_id\)/);
    });
    it("status CHECK includes 4 expected values", () => {
      for (const s of ["pending", "processed", "failed", "skipped_duplicate"]) {
        expect(MIG).toMatch(new RegExp(`'${s}'`));
      }
    });
    it("has status+received and store+received indexes", () => {
      expect(MIG).toMatch(/shopify_webhook_log_status_received_idx/);
      expect(MIG).toMatch(/shopify_webhook_log_store_received_idx/);
    });
  });

  describe("entity_id DEFAULT rof_entity_id() on entity-scoped Shopify tables", () => {
    for (const tbl of ENTITY_SCOPED_DEFAULT_TABLES) {
      it(`${tbl}: DEFAULT rof_entity_id()`, () => {
        const re = new RegExp(
          `${tbl}[\\s\\S]*?entity_id\\s+uuid NOT NULL DEFAULT rof_entity_id\\(\\)`,
        );
        expect(MIG).toMatch(re);
      });
    }
  });

  describe("GL account seeds (D6 / D8 / D9)", () => {
    it("uses ROF entity lookup", () => {
      expect(MIG).toMatch(/SELECT id INTO v_rof FROM entities WHERE code = 'ROF'/);
    });
    it("uses status='active' (not is_active — T4 migration renamed)", () => {
      // Every INSERT should pass status='active' (4 seeds)
      const statusActives = MIG.match(/'active'\)/g) || [];
      expect(statusActives.length).toBeGreaterThanOrEqual(4);
    });
    it("seeds 4500 Restocking Fee Income (revenue, CREDIT) — NEW from P11-1", () => {
      expect(MIG).toMatch(/'4500',\s*'Restocking Fee Income',\s*'revenue',\s*'CREDIT'/);
    });
    it("seeds 6510 Merchant Fees (expense, DEBIT)", () => {
      expect(MIG).toMatch(/'6510',\s*'Merchant Fees',\s*'expense',\s*'DEBIT'/);
    });
    it("seeds 6610 Chargeback Expense (expense, DEBIT)", () => {
      expect(MIG).toMatch(/'6610',\s*'Chargeback Expense',\s*'expense',\s*'DEBIT'/);
    });
    it("seeds 1110 Payment Processor Clearing (asset, DEBIT)", () => {
      expect(MIG).toMatch(/'1110',\s*'Payment Processor Clearing',\s*'asset',\s*'DEBIT'/);
    });
    it("all seeds idempotent via ON CONFLICT (entity_id, code) DO NOTHING", () => {
      const conflicts = MIG.match(/ON CONFLICT \(entity_id, code\) DO NOTHING/g) || [];
      expect(conflicts.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("inventory_layers.source_kind CHECK extension", () => {
    it("drops old CHECK and adds new with shopify_refund_restock", () => {
      expect(MIG).toMatch(/DROP CONSTRAINT IF EXISTS inventory_layers_source_kind_check/);
      expect(MIG).toMatch(/ADD CONSTRAINT inventory_layers_source_kind_check[\s\S]*shopify_refund_restock/);
    });
    it("preserves all original P3-3 + P4-2 + T10-1 enum values", () => {
      for (const v of [
        "ap_invoice",
        "adjustment",
        "opening_balance",
        "transfer_in",
        "credit_memo_return",
        "xoro_mirror_snapshot",
      ]) {
        expect(MIG).toMatch(new RegExp(`'${v}'`));
      }
    });
    it("creates partial index for shopify_refund_restock rows", () => {
      expect(MIG).toMatch(
        /idx_inventory_layers_shopify_refund_restock[\s\S]*WHERE source_kind = 'shopify_refund_restock'/,
      );
    });
  });

  describe("RLS — anon_all_* + auth_internal_* template", () => {
    for (const tbl of SHOPIFY_TABLES) {
      it(`${tbl}: ENABLE ROW LEVEL SECURITY`, () => {
        expect(MIG).toMatch(new RegExp(`ALTER TABLE ${tbl}\\s+ENABLE ROW LEVEL SECURITY`));
      });
      it(`${tbl}: anon_all_* policy created`, () => {
        expect(MIG).toMatch(new RegExp(`anon_all_${tbl}`));
      });
    }
    // auth_internal_* on the 5 entity-scoped tables (webhook_log is anon-only).
    for (const tbl of ["shopify_stores", "shopify_orders", "shopify_order_lines", "shopify_refunds", "shopify_payouts"]) {
      it(`${tbl}: auth_internal_* policy created`, () => {
        expect(MIG).toMatch(new RegExp(`auth_internal_${tbl}`));
      });
    }
  });

  describe("PostgREST cache reload footer", () => {
    it("ends with NOTIFY pgrst, 'reload schema'", () => {
      expect(MIG).toMatch(/NOTIFY pgrst, 'reload schema';/);
    });
  });

  describe("idempotency primitives", () => {
    it("all 6 table creates use IF NOT EXISTS", () => {
      const creates = MIG.match(/CREATE TABLE IF NOT EXISTS/g) || [];
      expect(creates.length).toBeGreaterThanOrEqual(6);
    });
    it("no bare CREATE TABLE without IF NOT EXISTS", () => {
      const bare = MIG.match(/CREATE TABLE(?! IF NOT EXISTS)/g) || [];
      expect(bare.length).toBe(0);
    });
    it("seed DO block guards CHECK + GL inserts", () => {
      expect(MIG).toMatch(/DO \$\$\s*DECLARE\s+v_rof uuid;/);
    });
    it("RLS policies wrapped in DO $$ ... EXCEPTION WHEN duplicate_object", () => {
      const wrapped = MIG.match(/EXCEPTION WHEN duplicate_object THEN NULL/g) || [];
      // 5 entity-scoped tables × (anon + auth_internal) + shopify_webhook_log anon = 11 policies
      expect(wrapped.length).toBeGreaterThanOrEqual(11);
    });
  });
});

describe("P11-1 — token-encryption stub contract", () => {
  it("exports encryptToken function", () => {
    expect(STUB).toMatch(/export function encryptToken/);
  });
  it("exports decryptToken function", () => {
    expect(STUB).toMatch(/export function decryptToken/);
  });
  it("references SHOPIFY_TOKEN_ENC_KEY env var in the contract", () => {
    expect(STUB).toMatch(/SHOPIFY_TOKEN_ENC_KEY/);
  });
  it("documents AES-256-GCM intent", () => {
    expect(STUB).toMatch(/AES-256-GCM/);
  });
  it("real impl throws (lands in P11-2)", async () => {
    const mod = await import("../../_lib/shopify/token-encryption.js");
    expect(() => mod.encryptToken("shpat_demo")).toThrow();
    expect(() => mod.decryptToken(Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0))).toThrow();
  });
});
