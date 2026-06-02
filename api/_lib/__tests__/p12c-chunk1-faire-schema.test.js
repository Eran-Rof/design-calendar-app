// Static-shape tests for P12c-1 migration: Faire wholesale marketplace
// foundation schema (5 entity-scoped tables + RLS + Faire token-encryption
// stub).
//
// Reads the migration SQL + the token-encryption stub and asserts shape —
// does not require a live DB.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = readFileSync(
  resolve(here, "../../../supabase/migrations/20260629320000_p12c_chunk1_faire_schema.sql"),
  "utf8",
);
const STUB = readFileSync(
  resolve(here, "../../../api/_lib/marketplaces/faire/token-encryption.js"),
  "utf8",
);

const FAIRE_TABLES = [
  "faire_shops",
  "faire_buyers",
  "faire_orders",
  "faire_order_items",
  "faire_payouts",
];

const ENTITY_SCOPED_DEFAULT_TABLES = [
  "faire_shops",
  "faire_buyers",
  "faire_orders",
  "faire_payouts",
];

describe("P12c-1 — Faire wholesale marketplace foundation schema migration", () => {
  describe("CREATE TABLE for all 5 Faire tables (idempotent)", () => {
    for (const tbl of FAIRE_TABLES) {
      it(`${tbl}: CREATE TABLE IF NOT EXISTS`, () => {
        expect(MIG).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${tbl}`));
      });
    }
  });

  describe("faire_shops — per-shop config + encrypted API key", () => {
    it("entity_id has DEFAULT rof_entity_id() + FK to entities", () => {
      expect(MIG).toMatch(/faire_shops[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT rof_entity_id\(\) REFERENCES entities\(id\) ON DELETE RESTRICT/);
    });
    it("has api_key_ciphertext / iv / tag bytea columns", () => {
      expect(MIG).toMatch(/api_key_ciphertext\s+bytea/);
      expect(MIG).toMatch(/api_key_iv\s+bytea/);
      expect(MIG).toMatch(/api_key_tag\s+bytea/);
    });
    it("is_active boolean DEFAULT true", () => {
      expect(MIG).toMatch(/is_active\s+boolean NOT NULL DEFAULT true/);
    });
    it("has last_orders_sync_at + last_payouts_sync_at timestamptz", () => {
      expect(MIG).toMatch(/last_orders_sync_at\s+timestamptz/);
      expect(MIG).toMatch(/last_payouts_sync_at\s+timestamptz/);
    });
    it("UNIQUE constraint on (entity_id, faire_shop_token)", () => {
      expect(MIG).toMatch(/UNIQUE \(entity_id, faire_shop_token\)/);
    });
  });

  describe("faire_buyers — wholesale buyer ↔ customer mapping (D6)", () => {
    it("entity_id has DEFAULT rof_entity_id()", () => {
      expect(MIG).toMatch(/faire_buyers[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT rof_entity_id\(\)/);
    });
    it("faire_shop_id FK with ON DELETE RESTRICT", () => {
      expect(MIG).toMatch(/faire_buyers[\s\S]*?faire_shop_id\s+uuid NOT NULL REFERENCES faire_shops\(id\) ON DELETE RESTRICT/);
    });
    it("customer_id FK to customers with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/faire_buyers[\s\S]*?customer_id\s+uuid REFERENCES customers\(id\) ON DELETE SET NULL/);
    });
    it("has buyer_email (nullable) + buyer_name (text)", () => {
      expect(MIG).toMatch(/buyer_name\s+text NOT NULL/);
      expect(MIG).toMatch(/buyer_email\s+text(?!\s+NOT NULL)/);
    });
    it("is_first_order_completed boolean DEFAULT false", () => {
      expect(MIG).toMatch(/is_first_order_completed\s+boolean NOT NULL DEFAULT false/);
    });
    it("raw_payload jsonb DEFAULT '{}'::jsonb", () => {
      expect(MIG).toMatch(/faire_buyers[\s\S]*?raw_payload\s+jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
    });
    it("UNIQUE constraint on (faire_shop_id, faire_brand_token)", () => {
      expect(MIG).toMatch(/UNIQUE \(faire_shop_id, faire_brand_token\)/);
    });
  });

  describe("faire_orders — order table with commission split", () => {
    it("entity_id has DEFAULT rof_entity_id()", () => {
      expect(MIG).toMatch(/faire_orders[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT rof_entity_id\(\)/);
    });
    it("faire_shop_id FK with ON DELETE RESTRICT", () => {
      expect(MIG).toMatch(/faire_orders[\s\S]*?faire_shop_id\s+uuid NOT NULL REFERENCES faire_shops\(id\) ON DELETE RESTRICT/);
    });
    it("faire_buyer_id FK with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/faire_buyer_id\s+uuid REFERENCES faire_buyers\(id\) ON DELETE SET NULL/);
    });
    it("source CHECK enforces 'faire' only", () => {
      expect(MIG).toMatch(/source\s+text NOT NULL DEFAULT 'faire' CHECK \(source = 'faire'\)/);
    });
    it("commission_rate is numeric(5,4) for exact 0.2500 / 0.1500", () => {
      expect(MIG).toMatch(/commission_rate\s+numeric\(5,4\) NOT NULL/);
    });
    it("is_first_order_for_buyer boolean DEFAULT false", () => {
      expect(MIG).toMatch(/is_first_order_for_buyer\s+boolean NOT NULL DEFAULT false/);
    });
    it("has subtotal/shipping/commission/net_payout _cents bigint", () => {
      expect(MIG).toMatch(/subtotal_cents\s+bigint NOT NULL/);
      expect(MIG).toMatch(/faire_orders[\s\S]*?shipping_cents\s+bigint NOT NULL DEFAULT 0/);
      expect(MIG).toMatch(/commission_cents\s+bigint NOT NULL/);
      expect(MIG).toMatch(/net_payout_cents\s+bigint NOT NULL/);
    });
    it("currency text DEFAULT 'USD'", () => {
      expect(MIG).toMatch(/faire_orders[\s\S]*?currency\s+text NOT NULL DEFAULT 'USD'/);
    });
    it("ar_invoice_id + je_id FKs with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/faire_orders[\s\S]*?ar_invoice_id\s+uuid REFERENCES ar_invoices\(id\) ON DELETE SET NULL/);
      expect(MIG).toMatch(/faire_orders[\s\S]*?je_id\s+uuid REFERENCES journal_entries\(id\) ON DELETE SET NULL/);
    });
    it("customer_id FK to customers with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/faire_orders[\s\S]*?customer_id\s+uuid REFERENCES customers\(id\) ON DELETE SET NULL/);
    });
    it("UNIQUE (faire_shop_id, faire_order_id) for dedup", () => {
      expect(MIG).toMatch(/UNIQUE \(faire_shop_id, faire_order_id\)/);
    });
    it("has entity_id + placed_at DESC index", () => {
      expect(MIG).toMatch(/faire_orders_entity_placed_idx[\s\S]*\(entity_id, placed_at DESC\)/);
    });
    it("has faire_buyer_id index", () => {
      expect(MIG).toMatch(/faire_orders_buyer_idx[\s\S]*\(faire_buyer_id\)/);
    });
  });

  describe("faire_order_items — line-level breakdown", () => {
    it("FK to faire_orders with CASCADE on parent delete", () => {
      expect(MIG).toMatch(/faire_order_items[\s\S]*?faire_order_id\s+uuid NOT NULL REFERENCES faire_orders\(id\) ON DELETE CASCADE/);
    });
    it("ip_item_master_id FK with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/faire_order_items[\s\S]*?ip_item_master_id\s+uuid REFERENCES ip_item_master\(id\) ON DELETE SET NULL/);
    });
    it("has unit_price_wholesale_cents (wholesale grain)", () => {
      expect(MIG).toMatch(/unit_price_wholesale_cents\s+bigint NOT NULL/);
    });
    it("has line_total_cents + quantity int", () => {
      expect(MIG).toMatch(/line_total_cents\s+bigint NOT NULL/);
      expect(MIG).toMatch(/faire_order_items[\s\S]*?quantity\s+int NOT NULL/);
    });
    it("UNIQUE (faire_order_id, line_number) for replay-safety", () => {
      expect(MIG).toMatch(/UNIQUE \(faire_order_id, line_number\)/);
    });
  });

  describe("faire_payouts — monthly remittances (D9)", () => {
    it("entity_id has DEFAULT rof_entity_id()", () => {
      expect(MIG).toMatch(/faire_payouts[\s\S]*?entity_id\s+uuid NOT NULL DEFAULT rof_entity_id\(\)/);
    });
    it("faire_shop_id FK with ON DELETE RESTRICT", () => {
      expect(MIG).toMatch(/faire_payouts[\s\S]*?faire_shop_id\s+uuid NOT NULL REFERENCES faire_shops\(id\) ON DELETE RESTRICT/);
    });
    it("has period_start + period_end date columns", () => {
      expect(MIG).toMatch(/period_start\s+date NOT NULL/);
      expect(MIG).toMatch(/period_end\s+date NOT NULL/);
    });
    it("has gross / commission / refunds / net amount_cents columns", () => {
      expect(MIG).toMatch(/gross_amount_cents\s+bigint NOT NULL/);
      expect(MIG).toMatch(/commission_amount_cents\s+bigint NOT NULL/);
      expect(MIG).toMatch(/refunds_amount_cents\s+bigint NOT NULL DEFAULT 0/);
      expect(MIG).toMatch(/net_amount_cents\s+bigint NOT NULL/);
    });
    it("bank_transaction_id FK with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/faire_payouts[\s\S]*?bank_transaction_id\s+uuid REFERENCES bank_transactions\(id\) ON DELETE SET NULL/);
    });
    it("je_id FK with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/faire_payouts[\s\S]*?je_id\s+uuid REFERENCES journal_entries\(id\) ON DELETE SET NULL/);
    });
    it("currency text DEFAULT 'USD'", () => {
      expect(MIG).toMatch(/faire_payouts[\s\S]*?currency\s+text NOT NULL DEFAULT 'USD'/);
    });
    it("UNIQUE (faire_shop_id, faire_payout_id) for dedup", () => {
      expect(MIG).toMatch(/UNIQUE \(faire_shop_id, faire_payout_id\)/);
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

  describe("D15 — no Faire-side inventory location seed", () => {
    it("does not seed FAIRE_WH or any faire-specific inventory_locations row", () => {
      // Operator ships from MAIN_WH always; no INSERT into inventory_locations.
      expect(MIG).not.toMatch(/INSERT INTO inventory_locations/);
    });
  });

  describe("RLS — anon_all_* + auth_internal_* template", () => {
    for (const tbl of FAIRE_TABLES) {
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
      // 5 tables × (anon_all + auth_internal) = 10 policies
      expect(wrapped.length).toBeGreaterThanOrEqual(10);
    });
    it("indexes use CREATE INDEX IF NOT EXISTS", () => {
      const idx = MIG.match(/CREATE INDEX IF NOT EXISTS/g) || [];
      expect(idx.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe("no COMMENT ON ... IS string-concat (P12-0 hotfix PR #485)", () => {
    it("no COMMENT body uses the || operator (Postgres requires string literal)", () => {
      // Iterate non-comment lines, find COMMENT ON ... IS occurrences, and
      // grab the body up to the terminating semicolon. Reject any body that
      // contains '||' (concat would crash the migration — see PR #485).
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

describe("P12c-1 — faire token-encryption stub contract (now real in P12c-2)", () => {
  it("exports encryptToken function", () => {
    expect(STUB).toMatch(/export function encryptToken/);
  });
  it("exports decryptToken function", () => {
    expect(STUB).toMatch(/export function decryptToken/);
  });
  it("references FAIRE_TOKEN_ENC_KEY env var in the contract", () => {
    expect(STUB).toMatch(/FAIRE_TOKEN_ENC_KEY/);
  });
  it("documents AES-256-GCM intent", () => {
    expect(STUB).toMatch(/AES-256-GCM/);
  });
  it("P12c-2 shipped the real impl — encrypt/decrypt roundtrips", async () => {
    process.env.FAIRE_TOKEN_ENC_KEY = "b".repeat(64);
    const mod = await import("../../_lib/marketplaces/faire/token-encryption.js");
    const { ciphertext, iv, tag } = mod.encryptToken("faire_test_key");
    expect(Buffer.isBuffer(ciphertext)).toBe(true);
    expect(Buffer.isBuffer(iv)).toBe(true);
    expect(Buffer.isBuffer(tag)).toBe(true);
    expect(mod.decryptToken(ciphertext, iv, tag)).toBe("faire_test_key");
  });
});
