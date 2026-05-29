// Static-shape tests for P12a-1 migration: Amazon FBA foundation schema
// (6 entity-scoped tables + FBA_US inventory_location seed + LWA stub).
//
// Reads the migration SQL + the token-encryption stub and asserts
// shape — does not require a live DB.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = readFileSync(
  resolve(here, "../../../supabase/migrations/20260629300000_p12a_chunk1_fba_schema.sql"),
  "utf8",
);
const STUB = readFileSync(
  resolve(here, "../../../api/_lib/marketplaces/fba/token-encryption.js"),
  "utf8",
);

const FBA_TABLES = [
  "fba_seller_accounts",
  "fba_orders",
  "fba_order_items",
  "fba_settlements",
  "fba_inventory_snapshots",
  "fba_returns",
];

const ENTITY_SCOPED_DEFAULT_TABLES = [
  "fba_seller_accounts",
  "fba_orders",
  "fba_settlements",
  "fba_inventory_snapshots",
  "fba_returns",
];

describe("P12a-1 — FBA foundation schema migration", () => {
  describe("CREATE TABLE for all 6 FBA tables (idempotent)", () => {
    for (const tbl of FBA_TABLES) {
      it(`${tbl}: CREATE TABLE IF NOT EXISTS`, () => {
        expect(MIG).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${tbl}`));
      });
    }
  });

  describe("fba_seller_accounts — multi-account + LWA creds", () => {
    it("has entity_id with DEFAULT rof_entity_id()", () => {
      expect(MIG).toMatch(/fba_seller_accounts[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT rof_entity_id\(\)/);
    });
    it("region CHECK enforces NA/EU/FE", () => {
      expect(MIG).toMatch(/region\s+text NOT NULL CHECK \(region IN \('NA','EU','FE'\)\)/);
    });
    it("has lwa_client_id_ciphertext / iv / tag bytea columns", () => {
      expect(MIG).toMatch(/lwa_client_id_ciphertext\s+bytea/);
      expect(MIG).toMatch(/lwa_client_id_iv\s+bytea/);
      expect(MIG).toMatch(/lwa_client_id_tag\s+bytea/);
    });
    it("has lwa_client_secret_ciphertext / iv / tag bytea columns", () => {
      expect(MIG).toMatch(/lwa_client_secret_ciphertext\s+bytea/);
      expect(MIG).toMatch(/lwa_client_secret_iv\s+bytea/);
      expect(MIG).toMatch(/lwa_client_secret_tag\s+bytea/);
    });
    it("has refresh_token_ciphertext / iv / tag bytea columns", () => {
      expect(MIG).toMatch(/refresh_token_ciphertext\s+bytea/);
      expect(MIG).toMatch(/refresh_token_iv\s+bytea/);
      expect(MIG).toMatch(/refresh_token_tag\s+bytea/);
    });
    it("aws_role_arn column is nullable text", () => {
      expect(MIG).toMatch(/aws_role_arn\s+text,/);
    });
    it("fba_location_id FK to inventory_locations", () => {
      expect(MIG).toMatch(/fba_location_id\s+uuid REFERENCES inventory_locations\(id\) ON DELETE RESTRICT/);
    });
    it("has last_orders_sync_at / last_settlement_sync_at / last_inventory_sync_at timestamptz", () => {
      expect(MIG).toMatch(/last_orders_sync_at\s+timestamptz/);
      expect(MIG).toMatch(/last_settlement_sync_at\s+timestamptz/);
      expect(MIG).toMatch(/last_inventory_sync_at\s+timestamptz/);
    });
    it("UNIQUE (entity_id, seller_id, marketplace_id)", () => {
      expect(MIG).toMatch(/UNIQUE \(entity_id, seller_id, marketplace_id\)/);
    });
  });

  describe("fba_orders — order table", () => {
    it("entity_id has DEFAULT rof_entity_id()", () => {
      expect(MIG).toMatch(/fba_orders[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT rof_entity_id\(\)/);
    });
    it("fba_seller_account_id FK with ON DELETE RESTRICT", () => {
      expect(MIG).toMatch(/fba_seller_account_id\s+uuid NOT NULL REFERENCES fba_seller_accounts\(id\) ON DELETE RESTRICT/);
    });
    it("fulfillment_channel CHECK enforces AFN/MFN", () => {
      expect(MIG).toMatch(/fulfillment_channel\s+text NOT NULL CHECK \(fulfillment_channel IN \('AFN','MFN'\)\)/);
    });
    it("source CHECK enforces 'fba' only", () => {
      expect(MIG).toMatch(/source\s+text NOT NULL DEFAULT 'fba' CHECK \(source IN \('fba'\)\)/);
    });
    it("currency text DEFAULT 'USD'", () => {
      expect(MIG).toMatch(/fba_orders[\s\S]*?currency\s+text NOT NULL DEFAULT 'USD'/);
    });
    it("ar_invoice_id + je_id FKs with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/ar_invoice_id\s+uuid REFERENCES ar_invoices\(id\) ON DELETE SET NULL/);
      expect(MIG).toMatch(/je_id\s+uuid REFERENCES journal_entries\(id\) ON DELETE SET NULL/);
    });
    it("customer_id FK to customers with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/customer_id\s+uuid REFERENCES customers\(id\) ON DELETE SET NULL/);
    });
    it("has order_total/item_subtotal/tax_collected/shipping/promotion_discount _cents bigint", () => {
      for (const col of [
        "order_total_cents",
        "item_subtotal_cents",
        "tax_collected_cents",
        "shipping_cents",
        "promotion_discount_cents",
      ]) {
        expect(MIG).toMatch(new RegExp(`${col}\\s+bigint`));
      }
    });
    it("UNIQUE (fba_seller_account_id, amazon_order_id) for dedup", () => {
      expect(MIG).toMatch(/UNIQUE \(fba_seller_account_id, amazon_order_id\)/);
    });
    it("has entity+purchase_date and account+status indexes", () => {
      expect(MIG).toMatch(/fba_orders_entity_purchase_idx[\s\S]*entity_id, purchase_date DESC/);
      expect(MIG).toMatch(/fba_orders_account_status_idx[\s\S]*fba_seller_account_id, order_status/);
    });
  });

  describe("fba_order_items", () => {
    it("FK to fba_orders with CASCADE on parent delete", () => {
      expect(MIG).toMatch(/fba_order_id\s+uuid NOT NULL REFERENCES fba_orders\(id\) ON DELETE CASCADE/);
    });
    it("ip_item_master_id FK with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/ip_item_master_id\s+uuid REFERENCES ip_item_master\(id\) ON DELETE SET NULL/);
    });
    it("has fulfillment_fee_cents + referral_fee_cents bigint DEFAULT 0", () => {
      expect(MIG).toMatch(/fulfillment_fee_cents\s+bigint NOT NULL DEFAULT 0/);
      expect(MIG).toMatch(/referral_fee_cents\s+bigint NOT NULL DEFAULT 0/);
    });
    it("has quantity_ordered int NOT NULL + quantity_shipped DEFAULT 0", () => {
      expect(MIG).toMatch(/quantity_ordered\s+int NOT NULL/);
      expect(MIG).toMatch(/quantity_shipped\s+int NOT NULL DEFAULT 0/);
    });
    it("UNIQUE (fba_order_id, order_item_id) for replay-safety", () => {
      expect(MIG).toMatch(/UNIQUE \(fba_order_id, order_item_id\)/);
    });
  });

  describe("fba_settlements", () => {
    it("entity_id has DEFAULT rof_entity_id()", () => {
      expect(MIG).toMatch(/fba_settlements[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT rof_entity_id\(\)/);
    });
    it("processing_status CHECK enforces Open/Closed", () => {
      expect(MIG).toMatch(/processing_status\s+text NOT NULL DEFAULT 'Open' CHECK \(processing_status IN \('Open','Closed'\)\)/);
    });
    it("bank_transaction_id FK to bank_transactions with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/bank_transaction_id\s+uuid REFERENCES bank_transactions\(id\) ON DELETE SET NULL/);
    });
    it("gross / fees / refunds / net _amount_cents columns", () => {
      for (const col of ["gross_amount_cents", "fees_amount_cents", "refunds_amount_cents", "net_amount_cents"]) {
        expect(MIG).toMatch(new RegExp(`${col}\\s+bigint NOT NULL`));
      }
    });
    it("UNIQUE (fba_seller_account_id, financial_event_group_id) for dedup", () => {
      expect(MIG).toMatch(/UNIQUE \(fba_seller_account_id, financial_event_group_id\)/);
    });
  });

  describe("fba_inventory_snapshots — multi-location mirror", () => {
    it("entity_id has DEFAULT rof_entity_id()", () => {
      expect(MIG).toMatch(/fba_inventory_snapshots[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT rof_entity_id\(\)/);
    });
    it("has all 6 inventory quantity columns int DEFAULT 0", () => {
      for (const col of [
        "fulfillable_qty",
        "inbound_working_qty",
        "inbound_shipped_qty",
        "inbound_receiving_qty",
        "reserved_qty",
        "unfulfillable_qty",
      ]) {
        expect(MIG).toMatch(new RegExp(`${col}\\s+int NOT NULL DEFAULT 0`));
      }
    });
    it("ip_item_master_id FK with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/fba_inventory_snapshots[\s\S]*?ip_item_master_id\s+uuid REFERENCES ip_item_master\(id\) ON DELETE SET NULL/);
    });
    it("UNIQUE (fba_seller_account_id, snapshot_at, asin, sku) preserves history", () => {
      expect(MIG).toMatch(/UNIQUE \(fba_seller_account_id, snapshot_at, asin, sku\)/);
    });
    it("has account+snapshot_at DESC index", () => {
      expect(MIG).toMatch(/fba_inventory_snapshots_account_taken_idx[\s\S]*fba_seller_account_id, snapshot_at DESC/);
    });
  });

  describe("fba_returns", () => {
    it("entity_id has DEFAULT rof_entity_id()", () => {
      expect(MIG).toMatch(/fba_returns[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT rof_entity_id\(\)/);
    });
    it("fba_order_id FK to fba_orders with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/fba_returns[\s\S]*?fba_order_id\s+uuid REFERENCES fba_orders\(id\) ON DELETE SET NULL/);
    });
    it("ar_credit_memo_id FK to ar_invoices (sibling credit memo)", () => {
      expect(MIG).toMatch(/ar_credit_memo_id\s+uuid REFERENCES ar_invoices\(id\) ON DELETE SET NULL/);
    });
    it("ip_item_master_id FK with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/fba_returns[\s\S]*?ip_item_master_id\s+uuid REFERENCES ip_item_master\(id\) ON DELETE SET NULL/);
    });
    it("refund_amount_cents bigint DEFAULT 0", () => {
      expect(MIG).toMatch(/refund_amount_cents\s+bigint NOT NULL DEFAULT 0/);
    });
    it("UNIQUE (return_request_id) for dedup", () => {
      expect(MIG).toMatch(/UNIQUE \(return_request_id\)/);
    });
  });

  describe("entity_id DEFAULT rof_entity_id() on entity-scoped FBA tables", () => {
    for (const tbl of ENTITY_SCOPED_DEFAULT_TABLES) {
      it(`${tbl}: DEFAULT rof_entity_id()`, () => {
        const re = new RegExp(
          `${tbl}[\\s\\S]*?entity_id\\s+uuid NOT NULL DEFAULT rof_entity_id\\(\\)`,
        );
        expect(MIG).toMatch(re);
      });
    }
  });

  describe("FBA_US inventory_location seed", () => {
    it("INSERT INTO inventory_locations for ROF with code='FBA_US'", () => {
      expect(MIG).toMatch(/INSERT INTO inventory_locations[\s\S]*?'FBA_US'/);
    });
    it("seed uses rof_entity_id() helper", () => {
      expect(MIG).toMatch(/SELECT rof_entity_id\(\), 'FBA_US', 'Amazon FBA \(US\)', 'fba', 'US'/);
    });
    it("seed is idempotent via ON CONFLICT (entity_id, code) DO NOTHING", () => {
      expect(MIG).toMatch(/'FBA_US'[\s\S]*?ON CONFLICT \(entity_id, code\) DO NOTHING/);
    });
  });

  describe("RLS — anon_all_* + auth_internal_* on all 6 tables", () => {
    for (const tbl of FBA_TABLES) {
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
    it("auth_internal_* uses entity_users join via auth.uid()", () => {
      expect(MIG).toMatch(/entity_id IN \(SELECT eu\.entity_id FROM entity_users eu WHERE eu\.auth_id = auth\.uid\(\)\)/);
    });
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
    it("RLS policies wrapped in DO $$ ... EXCEPTION WHEN duplicate_object", () => {
      const wrapped = MIG.match(/EXCEPTION WHEN duplicate_object THEN NULL/g) || [];
      // 6 tables × (anon + auth_internal) = 12 policies
      expect(wrapped.length).toBeGreaterThanOrEqual(12);
    });
  });

  describe("no COMMENT-concat regressions (lint — see migration header)", () => {
    // Strip line-comments so prose like `do not use COMMENT ON x IS 'a' || 'b';`
    // in the header doesn't trip the lint. We only want SQL statements.
    const sqlOnly = MIG
      .split(/\r?\n/)
      .filter((l) => !/^\s*--/.test(l))
      .join("\n");

    // Extract each COMMENT ON statement up to its trailing `';` boundary.
    // The literal body may legitimately contain `;` mid-sentence; the
    // statement boundary is `'<optional whitespace>;` on the same logical
    // line (which is how every COMMENT in this migration is written).
    const commentStatements = sqlOnly.match(/COMMENT ON[^\n]*?'\s*;/g) || [];

    it("found at least 6 COMMENT ON statements (one per table)", () => {
      expect(commentStatements.length).toBeGreaterThanOrEqual(6);
    });

    it("no COMMENT ON statement uses || concat", () => {
      for (const stmt of commentStatements) {
        expect(stmt).not.toMatch(/\|\|/);
      }
    });

    it("every COMMENT ON statement contains an IS '...' literal", () => {
      for (const stmt of commentStatements) {
        expect(stmt).toMatch(/IS\s+'[^']*'\s*;\s*$/);
      }
    });
  });
});

describe("P12a-1 — FBA token-encryption stub contract", () => {
  it("exports encryptToken function", () => {
    expect(STUB).toMatch(/export function encryptToken/);
  });
  it("exports decryptToken function", () => {
    expect(STUB).toMatch(/export function decryptToken/);
  });
  it("references FBA_TOKEN_ENC_KEY env var in the contract", () => {
    expect(STUB).toMatch(/FBA_TOKEN_ENC_KEY/);
  });
  it("documents AES-256-GCM intent", () => {
    expect(STUB).toMatch(/AES-256-GCM/);
  });
  it("real impl throws (lands in P12a-2) — encryptToken", async () => {
    const mod = await import("../../_lib/marketplaces/fba/token-encryption.js");
    expect(() => mod.encryptToken("lwa_refresh_demo")).toThrow();
  });
  it("real impl throws (lands in P12a-2) — decryptToken", async () => {
    const mod = await import("../../_lib/marketplaces/fba/token-encryption.js");
    expect(() => mod.decryptToken(Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0))).toThrow();
  });
});
