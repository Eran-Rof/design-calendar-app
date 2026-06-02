// Static-shape tests for P12b-1 migration: Walmart Marketplace foundation
// schema (5 entity-scoped tables + WFS_US location seed + token-encryption
// stub).
//
// Reads the migration SQL + the token-encryption stub and asserts
// shape — does not require a live DB.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = readFileSync(
  resolve(here, "../../../supabase/migrations/20260629310000_p12b_chunk1_walmart_schema.sql"),
  "utf8",
);
const STUB = readFileSync(
  resolve(here, "../../../api/_lib/marketplaces/walmart/token-encryption.js"),
  "utf8",
);

const WALMART_TABLES = [
  "walmart_seller_accounts",
  "walmart_orders",
  "walmart_order_items",
  "walmart_settlements",
  "walmart_returns",
];

const ENTITY_SCOPED_DEFAULT_TABLES = [
  "walmart_seller_accounts",
  "walmart_orders",
  "walmart_settlements",
  "walmart_returns",
];

describe("P12b-1 — Walmart Marketplace foundation schema migration", () => {
  describe("CREATE TABLE for all 5 Walmart tables (idempotent)", () => {
    for (const tbl of WALMART_TABLES) {
      it(`${tbl}: CREATE TABLE IF NOT EXISTS`, () => {
        expect(MIG).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${tbl}`));
      });
    }
  });

  describe("walmart_seller_accounts — per-seller config + OAuth client_credentials", () => {
    it("entity_id has DEFAULT rof_entity_id()", () => {
      expect(MIG).toMatch(/walmart_seller_accounts[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT rof_entity_id\(\) REFERENCES entities\(id\) ON DELETE RESTRICT/);
    });
    it("has client_id_ciphertext / iv / tag bytea columns", () => {
      expect(MIG).toMatch(/client_id_ciphertext\s+bytea/);
      expect(MIG).toMatch(/client_id_iv\s+bytea/);
      expect(MIG).toMatch(/client_id_tag\s+bytea/);
    });
    it("has client_secret_ciphertext / iv / tag bytea columns", () => {
      expect(MIG).toMatch(/client_secret_ciphertext\s+bytea/);
      expect(MIG).toMatch(/client_secret_iv\s+bytea/);
      expect(MIG).toMatch(/client_secret_tag\s+bytea/);
    });
    it("wfs_location_id FK to inventory_locations with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/wfs_location_id\s+uuid REFERENCES inventory_locations\(id\) ON DELETE SET NULL/);
    });
    it("is_active boolean DEFAULT true", () => {
      expect(MIG).toMatch(/is_active\s+boolean NOT NULL DEFAULT true/);
    });
    it("last_orders_sync_at + last_settlement_sync_at timestamptz", () => {
      expect(MIG).toMatch(/last_orders_sync_at\s+timestamptz/);
      expect(MIG).toMatch(/last_settlement_sync_at\s+timestamptz/);
    });
    it("UNIQUE constraint on (entity_id, partner_id)", () => {
      expect(MIG).toMatch(/UNIQUE \(entity_id, partner_id\)/);
    });
  });

  describe("walmart_orders — order table", () => {
    it("entity_id has DEFAULT rof_entity_id()", () => {
      expect(MIG).toMatch(/walmart_orders[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT rof_entity_id\(\)/);
    });
    it("walmart_seller_account_id FK with ON DELETE RESTRICT", () => {
      expect(MIG).toMatch(/walmart_seller_account_id\s+uuid NOT NULL REFERENCES walmart_seller_accounts\(id\) ON DELETE RESTRICT/);
    });
    it("source CHECK enforces 'walmart' only", () => {
      expect(MIG).toMatch(/source\s+text NOT NULL DEFAULT 'walmart' CHECK \(source = 'walmart'\)/);
    });
    it("ar_invoice_id + je_id FKs with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/ar_invoice_id\s+uuid REFERENCES ar_invoices\(id\) ON DELETE SET NULL/);
      expect(MIG).toMatch(/je_id\s+uuid REFERENCES journal_entries\(id\) ON DELETE SET NULL/);
    });
    it("customer_id FK to customers with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/customer_id\s+uuid REFERENCES customers\(id\) ON DELETE SET NULL/);
    });
    it("currency text DEFAULT 'USD'", () => {
      expect(MIG).toMatch(/currency\s+text NOT NULL DEFAULT 'USD'/);
    });
    it("ship_node_type text column present (nullable)", () => {
      expect(MIG).toMatch(/ship_node_type\s+text/);
    });
    it("has order_total / item_subtotal / tax / shipping / discount _cents bigint", () => {
      for (const col of ["order_total_cents", "item_subtotal_cents", "tax_collected_cents", "shipping_cents", "discount_cents"]) {
        expect(MIG).toMatch(new RegExp(`${col}\\s+bigint`));
      }
    });
    it("item_subtotal_cents / tax / shipping / discount default to 0", () => {
      for (const col of ["item_subtotal_cents", "tax_collected_cents", "shipping_cents", "discount_cents"]) {
        expect(MIG).toMatch(new RegExp(`${col}\\s+bigint NOT NULL DEFAULT 0`));
      }
    });
    it("UNIQUE (walmart_seller_account_id, purchase_order_id) for dedup", () => {
      expect(MIG).toMatch(/UNIQUE \(walmart_seller_account_id, purchase_order_id\)/);
    });
    it("has entity+order_date DESC index", () => {
      expect(MIG).toMatch(/walmart_orders_entity_order_date_idx[\s\S]*?\(entity_id, order_date DESC\)/);
    });
  });

  describe("walmart_order_items", () => {
    it("FK to walmart_orders with CASCADE on parent delete", () => {
      expect(MIG).toMatch(/walmart_order_id\s+uuid NOT NULL REFERENCES walmart_orders\(id\) ON DELETE CASCADE/);
    });
    it("ip_item_master_id FK with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/ip_item_master_id\s+uuid REFERENCES ip_item_master\(id\) ON DELETE SET NULL/);
    });
    it("has tax_cents / commission_cents / wfs_fulfillment_fee_cents DEFAULT 0", () => {
      expect(MIG).toMatch(/tax_cents\s+bigint NOT NULL DEFAULT 0/);
      expect(MIG).toMatch(/commission_cents\s+bigint NOT NULL DEFAULT 0/);
      expect(MIG).toMatch(/wfs_fulfillment_fee_cents\s+bigint NOT NULL DEFAULT 0/);
    });
    it("UNIQUE (walmart_order_id, line_number) for replay-safety", () => {
      expect(MIG).toMatch(/UNIQUE \(walmart_order_id, line_number\)/);
    });
  });

  describe("walmart_settlements", () => {
    it("entity_id has DEFAULT rof_entity_id()", () => {
      expect(MIG).toMatch(/walmart_settlements[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT rof_entity_id\(\)/);
    });
    it("walmart_seller_account_id FK with ON DELETE RESTRICT", () => {
      expect(MIG).toMatch(/walmart_settlements[\s\S]*?walmart_seller_account_id\s+uuid NOT NULL REFERENCES walmart_seller_accounts\(id\) ON DELETE RESTRICT/);
    });
    it("bank_transaction_id FK to bank_transactions with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/bank_transaction_id\s+uuid REFERENCES bank_transactions\(id\) ON DELETE SET NULL/);
    });
    it("period_start / period_end date columns", () => {
      expect(MIG).toMatch(/period_start\s+date/);
      expect(MIG).toMatch(/period_end\s+date/);
    });
    it("gross / fees / refunds / net amount_cents bigint columns", () => {
      for (const col of ["gross_amount_cents", "fees_amount_cents", "refunds_amount_cents", "net_amount_cents"]) {
        expect(MIG).toMatch(new RegExp(`${col}\\s+bigint`));
      }
    });
    it("currency text DEFAULT 'USD'", () => {
      expect(MIG).toMatch(/walmart_settlements[\s\S]*?currency\s+text NOT NULL DEFAULT 'USD'/);
    });
    it("UNIQUE (walmart_seller_account_id, settlement_id) for dedup", () => {
      expect(MIG).toMatch(/UNIQUE \(walmart_seller_account_id, settlement_id\)/);
    });
  });

  describe("walmart_returns", () => {
    it("entity_id has DEFAULT rof_entity_id()", () => {
      expect(MIG).toMatch(/walmart_returns[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT rof_entity_id\(\)/);
    });
    it("walmart_order_id FK to walmart_orders with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/walmart_returns[\s\S]*?walmart_order_id\s+uuid REFERENCES walmart_orders\(id\) ON DELETE SET NULL/);
    });
    it("ip_item_master_id FK with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/walmart_returns[\s\S]*?ip_item_master_id\s+uuid REFERENCES ip_item_master\(id\) ON DELETE SET NULL/);
    });
    it("ar_credit_memo_id FK to ar_invoices with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/ar_credit_memo_id\s+uuid REFERENCES ar_invoices\(id\) ON DELETE SET NULL/);
    });
    it("je_id FK to journal_entries with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/walmart_returns[\s\S]*?je_id\s+uuid REFERENCES journal_entries\(id\) ON DELETE SET NULL/);
    });
    it("refund_amount_cents / restocking_fee_cents bigint DEFAULT 0", () => {
      expect(MIG).toMatch(/refund_amount_cents\s+bigint NOT NULL DEFAULT 0/);
      expect(MIG).toMatch(/restocking_fee_cents\s+bigint NOT NULL DEFAULT 0/);
    });
    it("UNIQUE (return_order_id) — globally-unique Walmart return id", () => {
      expect(MIG).toMatch(/CONSTRAINT walmart_returns_dedup UNIQUE \(return_order_id\)/);
    });
  });

  describe("entity_id DEFAULT rof_entity_id() on entity-scoped tables", () => {
    for (const tbl of ENTITY_SCOPED_DEFAULT_TABLES) {
      it(`${tbl}: DEFAULT rof_entity_id()`, () => {
        const re = new RegExp(
          `${tbl}[\\s\\S]*?entity_id\\s+uuid NOT NULL DEFAULT rof_entity_id\\(\\)`,
        );
        expect(MIG).toMatch(re);
      });
    }
  });

  describe("WFS_US inventory_location seed (D14)", () => {
    it("inserts into inventory_locations with code WFS_US", () => {
      expect(MIG).toMatch(/INSERT INTO inventory_locations[\s\S]*?'WFS_US'/);
    });
    it("name = 'Walmart Fulfillment Services (US)'", () => {
      expect(MIG).toMatch(/'Walmart Fulfillment Services \(US\)'/);
    });
    it("kind = 'wfs' (matches inventory_locations CHECK from P12-0)", () => {
      expect(MIG).toMatch(/'WFS_US',\s*'Walmart Fulfillment Services \(US\)',\s*'wfs',\s*'US'/);
    });
    it("country_code = 'US'", () => {
      expect(MIG).toMatch(/'wfs',\s*'US'/);
    });
    it("uses rof_entity_id() for entity_id", () => {
      expect(MIG).toMatch(/SELECT rof_entity_id\(\), 'WFS_US'/);
    });
    it("idempotent via ON CONFLICT (entity_id, code) DO NOTHING", () => {
      expect(MIG).toMatch(/ON CONFLICT \(entity_id, code\) DO NOTHING/);
    });
  });

  describe("RLS — anon_all_* + auth_internal_* template", () => {
    for (const tbl of WALMART_TABLES) {
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
    it("walmart_order_items auth_internal scopes via parent walmart_orders.entity_id", () => {
      expect(MIG).toMatch(/auth_internal_walmart_order_items[\s\S]*?SELECT wo\.id FROM walmart_orders wo[\s\S]*?wo\.entity_id IN \(SELECT eu\.entity_id FROM entity_users eu WHERE eu\.auth_id = auth\.uid\(\)\)/);
    });
  });

  describe("PostgREST cache reload footer", () => {
    it("ends with NOTIFY pgrst, 'reload schema'", () => {
      expect(MIG).toMatch(/NOTIFY pgrst, 'reload schema';/);
    });
  });

  describe("idempotency primitives", () => {
    it("all 5 table creates use IF NOT EXISTS", () => {
      const creates = MIG.match(/CREATE TABLE IF NOT EXISTS/g) || [];
      expect(creates.length).toBeGreaterThanOrEqual(5);
    });
    it("no bare CREATE TABLE without IF NOT EXISTS", () => {
      const bare = MIG.match(/CREATE TABLE(?! IF NOT EXISTS)/g) || [];
      expect(bare.length).toBe(0);
    });
    it("RLS policies wrapped in DO $$ ... EXCEPTION WHEN duplicate_object", () => {
      const wrapped = MIG.match(/EXCEPTION WHEN duplicate_object THEN NULL/g) || [];
      // 5 entity-scoped tables × (anon + auth_internal) = 10 policies
      expect(wrapped.length).toBeGreaterThanOrEqual(10);
    });
  });

  describe("Postgres-pitfall guard — no string concat in COMMENT ON", () => {
    it("never uses `IS 'foo' || 'bar'` (Postgres rejects, shipped this bug twice)", () => {
      // Strip line comments (-- ...) first — the cautionary docstring at the
      // top of the file legitimately mentions the bad pattern in prose.
      // Then walk each statement and check that no COMMENT ON ... IS '...'
      // is followed by `||` (string concat — Postgres rejects).
      const sqlOnly = MIG.replace(/--[^\n]*/g, "");
      const stmts = sqlOnly.split(/;\s*\n/).filter((s) => /COMMENT ON/.test(s));
      const concats = stmts.filter((s) => /IS\s+'(?:[^']|'')*'\s*\|\|/.test(s));
      expect(concats.length).toBe(0);
    });
  });
});

describe("P12b-1 — token-encryption stub contract", () => {
  it("exports encryptToken function", () => {
    expect(STUB).toMatch(/export function encryptToken/);
  });
  it("exports decryptToken function", () => {
    expect(STUB).toMatch(/export function decryptToken/);
  });
  it("references WALMART_TOKEN_ENC_KEY env var in the contract", () => {
    expect(STUB).toMatch(/WALMART_TOKEN_ENC_KEY/);
  });
  it("documents AES-256-GCM intent", () => {
    expect(STUB).toMatch(/AES-256-GCM/);
  });
  it("real impl throws (lands in P12b-2)", async () => {
    const mod = await import("../../_lib/marketplaces/walmart/token-encryption.js");
    expect(() => mod.encryptToken("wm_client_id_demo")).toThrow();
    expect(() => mod.decryptToken(Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0))).toThrow();
  });
});
