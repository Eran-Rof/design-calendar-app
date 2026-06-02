// Static-shape tests for P12-0 migration:
//   shared marketplaces foundation — inventory_locations + inventory_layers
//   location_id + source_kind extension + customers.marketplace_buyer_refs +
//   8 GL accounts + source enum reassert + RLS.
//
// Reads the migration SQL and asserts CREATE / ALTER / CHECK / INDEX / RLS
// fragments are present. No live DB required.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = readFileSync(
  resolve(
    here,
    "../../../supabase/migrations/20260629200000_p12_chunk0_marketplaces_shared.sql",
  ),
  "utf8",
);

describe("P12-0 — marketplaces shared schema migration", () => {
  describe("inventory_locations table", () => {
    it("CREATE TABLE IF NOT EXISTS inventory_locations", () => {
      expect(MIG).toMatch(/CREATE TABLE IF NOT EXISTS inventory_locations/);
    });

    it("entity_id FK with DEFAULT rof_entity_id()", () => {
      expect(MIG).toMatch(
        /entity_id\s+uuid NOT NULL DEFAULT rof_entity_id\(\) REFERENCES entities\(id\) ON DELETE RESTRICT/,
      );
    });

    it("kind CHECK covers warehouse/fba/wfs/3pl/dropship/virtual", () => {
      for (const v of ["warehouse", "fba", "wfs", "3pl", "dropship", "virtual"]) {
        expect(MIG).toMatch(new RegExp(`'${v}'`));
      }
      expect(MIG).toMatch(/CHECK \(kind IN \(/);
    });

    it("UNIQUE (entity_id, code)", () => {
      expect(MIG).toMatch(
        /CONSTRAINT inventory_locations_code_per_entity UNIQUE \(entity_id, code\)/,
      );
    });

    it("is_active boolean defaults true", () => {
      expect(MIG).toMatch(/is_active\s+boolean NOT NULL DEFAULT true/);
    });

    it("country_code text column", () => {
      expect(MIG).toMatch(/country_code\s+text/);
    });

    it("index on (entity_id, kind)", () => {
      expect(MIG).toMatch(/idx_inventory_locations_entity_kind/);
    });
  });

  describe("MAIN_WH seed for every entity", () => {
    it("INSERT ... SELECT FROM entities seeds MAIN_WH", () => {
      expect(MIG).toMatch(
        /INSERT INTO inventory_locations[\s\S]*'MAIN_WH'[\s\S]*'Main Warehouse'[\s\S]*'warehouse'[\s\S]*FROM entities/,
      );
    });

    it("ON CONFLICT (entity_id, code) DO NOTHING for re-runs", () => {
      expect(MIG).toMatch(/ON CONFLICT \(entity_id, code\) DO NOTHING/);
    });
  });

  describe("inventory_layers.location_id column", () => {
    it("ADD COLUMN IF NOT EXISTS location_id FK to inventory_locations", () => {
      expect(MIG).toMatch(
        /ALTER TABLE inventory_layers\s+ADD COLUMN IF NOT EXISTS location_id uuid\s+REFERENCES inventory_locations\(id\) ON DELETE RESTRICT/,
      );
    });

    it("backfills NULL location_id rows to MAIN_WH of their entity", () => {
      expect(MIG).toMatch(
        /UPDATE inventory_layers[\s\S]*SET location_id = \([\s\S]*FROM inventory_locations[\s\S]*code = 'MAIN_WH'[\s\S]*WHERE location_id IS NULL/,
      );
    });

    it("safety-net DO block before SET NOT NULL", () => {
      // The DO block aborts if any NULL location_id rows remain.
      expect(MIG).toMatch(/DO \$\$[\s\S]*v_null_count[\s\S]*RAISE EXCEPTION[\s\S]*SET NOT NULL/);
    });

    it("SET NOT NULL appears inside the DO block", () => {
      expect(MIG).toMatch(
        /ALTER TABLE inventory_layers ALTER COLUMN location_id SET NOT NULL/,
      );
    });

    it("re-run path checks is_nullable so SET NOT NULL is skipped on second apply", () => {
      expect(MIG).toMatch(/is_nullable = 'NO'/);
    });

    it("index on (location_id, item_id)", () => {
      expect(MIG).toMatch(
        /idx_inventory_layers_location[\s\S]*\(location_id, item_id\)/,
      );
    });
  });

  describe("inventory_layers.source_kind enum extension", () => {
    it("drops old CHECK then recreates with marketplace values", () => {
      expect(MIG).toMatch(
        /DROP CONSTRAINT IF EXISTS inventory_layers_source_kind_check/,
      );
      expect(MIG).toMatch(/ADD CONSTRAINT inventory_layers_source_kind_check/);
    });

    it("preserves all original source_kind values", () => {
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

    it("adds new FBA / WFS / shopify values", () => {
      for (const v of [
        "fba_inbound",
        "wfs_inbound",
        "fba_return_restock",
        "wfs_return_restock",
        "shopify_refund_restock",
      ]) {
        expect(MIG).toMatch(new RegExp(`'${v}'`));
      }
    });
  });

  describe("customers.marketplace_buyer_refs", () => {
    it("ADD COLUMN IF NOT EXISTS marketplace_buyer_refs jsonb NOT NULL DEFAULT {}", () => {
      expect(MIG).toMatch(
        /ALTER TABLE customers\s+ADD COLUMN IF NOT EXISTS marketplace_buyer_refs jsonb NOT NULL DEFAULT '\{\}'::jsonb/,
      );
    });

    it("GIN index on the JSONB column", () => {
      expect(MIG).toMatch(
        /idx_customers_marketplace_buyer_refs[\s\S]*USING gin \(marketplace_buyer_refs\)/,
      );
    });
  });

  describe("8 new GL accounts seeded against ROF", () => {
    const EXPECTED = [
      ["6520", "Marketplace Fees", "expense"],
      ["6521", "Sponsored Ads", "expense"],
      ["6522", "Storage Fees", "expense"],
      ["6523", "Fulfillment Fees", "expense"],
      ["6524", "Referral Fees", "expense"],
      ["6525", "FBA Removal/Disposal Fees", "expense"],
      ["1115", "Marketplace Receivable Clearing", "asset"],
      ["1116", "Marketplace Reserve", "asset"],
    ];

    it("uses rof_entity_id() and includes status='active' + normal_balance", () => {
      expect(MIG).toMatch(
        /INSERT INTO gl_accounts \(entity_id, code, name, account_type, normal_balance, status\)/,
      );
      expect(MIG).toMatch(/SELECT rof_entity_id\(\)/);
      expect(MIG).toMatch(/ON CONFLICT \(entity_id, code\) DO NOTHING/);
    });

    for (const [code, name, type] of EXPECTED) {
      it(`seeds ${code} ${name} (${type})`, () => {
        // Each VALUES row appears as `('CODE', 'NAME', ..., 'TYPE', 'DEBIT')`.
        // Look for the code + name pair AND a nearby occurrence of the type
        // — keeps the matcher resilient to whitespace inside the VALUES tuple.
        const escName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        expect(MIG).toMatch(new RegExp(`'${code}',\\s*'${escName}'`));
        expect(MIG).toMatch(new RegExp(`'${escName}'[\\s\\S]{0,80}'${type}'`));
      });
    }
  });

  describe("source enum reassert on AR/AP/JE tables", () => {
    it("checks all 5 tables in a FOREACH loop", () => {
      expect(MIG).toMatch(/ar_invoices/);
      expect(MIG).toMatch(/ar_invoice_lines/);
      expect(MIG).toMatch(/ar_receipts/);
      expect(MIG).toMatch(/'invoices'/);
      expect(MIG).toMatch(/journal_entries/);
    });

    it("verifies fba / walmart / faire are present in each CHECK", () => {
      expect(MIG).toMatch(/v_def NOT LIKE '%fba%'/);
      expect(MIG).toMatch(/v_def NOT LIKE '%walmart%'/);
      expect(MIG).toMatch(/v_def NOT LIKE '%faire%'/);
    });
  });

  describe("RLS policies on inventory_locations", () => {
    it("ENABLE ROW LEVEL SECURITY on inventory_locations", () => {
      expect(MIG).toMatch(
        /ALTER TABLE inventory_locations ENABLE ROW LEVEL SECURITY/,
      );
    });

    it("anon_all_inventory_locations policy", () => {
      expect(MIG).toMatch(/CREATE POLICY "anon_all_inventory_locations"/);
    });

    it("auth_internal_inventory_locations policy scoped to entity_users", () => {
      expect(MIG).toMatch(/CREATE POLICY "auth_internal_inventory_locations"/);
      expect(MIG).toMatch(
        /entity_id IN \(SELECT eu\.entity_id FROM entity_users eu WHERE eu\.auth_id = auth\.uid\(\)\)/,
      );
    });
  });

  describe("PostgREST cache reload footer", () => {
    it("ends with NOTIFY pgrst, 'reload schema'", () => {
      expect(MIG).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
    });
  });

  describe("idempotency primitives", () => {
    it("CREATE TABLE uses IF NOT EXISTS", () => {
      expect(MIG).toMatch(/CREATE TABLE IF NOT EXISTS inventory_locations/);
    });

    it("ALTER TABLE ADD COLUMN uses IF NOT EXISTS", () => {
      const bare = MIG.match(/ALTER TABLE \w+\s+ADD COLUMN(?! IF NOT EXISTS)/gi) || [];
      expect(bare.length).toBe(0);
    });

    it("RLS policy creation wrapped in DO $$ ... EXCEPTION WHEN duplicate_object", () => {
      const wrapped = MIG.match(/EXCEPTION WHEN duplicate_object THEN NULL/g) || [];
      expect(wrapped.length).toBeGreaterThanOrEqual(2);
    });

    it("ON CONFLICT DO NOTHING used for seed inserts", () => {
      const noConflicts = MIG.match(/ON CONFLICT \(entity_id, code\) DO NOTHING/g) || [];
      expect(noConflicts.length).toBeGreaterThanOrEqual(2);
    });
  });
});
