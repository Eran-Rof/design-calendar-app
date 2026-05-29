// Static-shape tests for P12c-4 migration: Faire wholesale returns table.
//
// Reads the migration SQL and asserts shape — does not require a live DB.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = readFileSync(
  resolve(here, "../../../supabase/migrations/20260629700000_p12c_chunk4_returns.sql"),
  "utf8",
);

describe("P12c-4 — Faire wholesale returns migration", () => {
  describe("CREATE TABLE faire_returns", () => {
    it("creates the table with IF NOT EXISTS (idempotent)", () => {
      expect(MIG).toMatch(/CREATE TABLE IF NOT EXISTS faire_returns/);
    });

    it("id is uuid PRIMARY KEY DEFAULT gen_random_uuid()", () => {
      expect(MIG).toMatch(/id\s+uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    });

    it("entity_id uses coalesce(current_entity_id(), rof_entity_id()) DEFAULT", () => {
      expect(MIG).toMatch(/entity_id\s+uuid NOT NULL DEFAULT coalesce\(current_entity_id\(\), rof_entity_id\(\)\)/);
    });

    it("entity_id references entities(id)", () => {
      expect(MIG).toMatch(/entity_id[\s\S]*REFERENCES entities\(id\)/);
    });

    it("faire_shop_id is NOT NULL REFERENCES faire_shops(id) ON DELETE RESTRICT", () => {
      expect(MIG).toMatch(/faire_shop_id\s+uuid NOT NULL REFERENCES faire_shops\(id\) ON DELETE RESTRICT/);
    });

    it("faire_order_id REFERENCES faire_orders(id) ON DELETE SET NULL (nullable)", () => {
      expect(MIG).toMatch(/faire_order_id\s+uuid REFERENCES faire_orders\(id\) ON DELETE SET NULL/);
    });

    it("faire_return_id is text NOT NULL (Faire-side id)", () => {
      expect(MIG).toMatch(/faire_return_id\s+text NOT NULL/);
    });

    it("return_status is text NOT NULL", () => {
      expect(MIG).toMatch(/return_status\s+text NOT NULL/);
    });

    it("refund_amount_cents bigint NOT NULL DEFAULT 0", () => {
      expect(MIG).toMatch(/refund_amount_cents\s+bigint NOT NULL DEFAULT 0/);
    });

    it("reason is nullable text", () => {
      expect(MIG).toMatch(/reason\s+text(?!\s+NOT NULL)/);
    });

    it("ar_credit_memo_id REFERENCES ar_invoices(id) ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/ar_credit_memo_id\s+uuid REFERENCES ar_invoices\(id\) ON DELETE SET NULL/);
    });

    it("je_id REFERENCES journal_entries(id) ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/je_id\s+uuid REFERENCES journal_entries\(id\) ON DELETE SET NULL/);
    });

    it("raw_payload jsonb NOT NULL (without DEFAULT — must store the API payload)", () => {
      expect(MIG).toMatch(/raw_payload\s+jsonb NOT NULL/);
    });

    it("source text NOT NULL DEFAULT 'faire' CHECK (source = 'faire')", () => {
      expect(MIG).toMatch(/source\s+text NOT NULL DEFAULT 'faire' CHECK \(source = 'faire'\)/);
    });

    it("created_at timestamptz NOT NULL DEFAULT now()", () => {
      expect(MIG).toMatch(/created_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
    });

    it("UNIQUE constraint on (faire_shop_id, faire_return_id) for replay-safe upsert", () => {
      expect(MIG).toMatch(/UNIQUE \(faire_shop_id, faire_return_id\)/);
    });
  });

  describe("Indexes", () => {
    it("entity_id + created_at DESC index", () => {
      expect(MIG).toMatch(/faire_returns_entity_created_idx[\s\S]*\(entity_id, created_at DESC\)/);
    });

    it("faire_shop_id + created_at DESC index", () => {
      expect(MIG).toMatch(/faire_returns_shop_created_idx[\s\S]*\(faire_shop_id, created_at DESC\)/);
    });

    it("faire_order_id lookup index", () => {
      expect(MIG).toMatch(/faire_returns_order_idx[\s\S]*\(faire_order_id\)/);
    });

    it("partial index on unposted returns (je_id IS NULL)", () => {
      expect(MIG).toMatch(/faire_returns_unposted_idx[\s\S]*WHERE je_id IS NULL/);
    });

    it("all indexes use CREATE INDEX IF NOT EXISTS", () => {
      const idx = MIG.match(/CREATE INDEX IF NOT EXISTS faire_returns_/g) || [];
      expect(idx.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("RLS — anon_all_* + auth_internal_* template (P1)", () => {
    it("ALTER TABLE faire_returns ENABLE ROW LEVEL SECURITY", () => {
      expect(MIG).toMatch(/ALTER TABLE faire_returns ENABLE ROW LEVEL SECURITY/);
    });

    it("anon_all_faire_returns policy", () => {
      expect(MIG).toMatch(/CREATE POLICY "anon_all_faire_returns"[\s\S]*FOR ALL TO anon[\s\S]*USING \(true\) WITH CHECK \(true\)/);
    });

    it("auth_internal_faire_returns policy scoped via entity_users", () => {
      expect(MIG).toMatch(/CREATE POLICY "auth_internal_faire_returns"[\s\S]*FOR ALL TO authenticated/);
      expect(MIG).toMatch(/auth_internal_faire_returns[\s\S]*entity_id IN \(SELECT eu\.entity_id FROM entity_users eu WHERE eu\.auth_id = auth\.uid\(\)\)/);
    });

    it("policies wrapped in DO $$ ... EXCEPTION WHEN duplicate_object (idempotent)", () => {
      const wrapped = MIG.match(/EXCEPTION WHEN duplicate_object THEN NULL/g) || [];
      expect(wrapped.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("PostgREST cache reload", () => {
    it("ends with NOTIFY pgrst, 'reload schema'", () => {
      expect(MIG).toMatch(/NOTIFY pgrst, 'reload schema';/);
    });
  });

  describe("hygiene", () => {
    it("no bare CREATE TABLE without IF NOT EXISTS", () => {
      const bare = MIG.match(/CREATE TABLE(?! IF NOT EXISTS)/g) || [];
      expect(bare.length).toBe(0);
    });

    it("no COMMENT ON ... IS string-concat (P12-0 hotfix PR #485)", () => {
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

    it("does not seed FAIRE_RETURNS_WH or any new inventory_locations row (D15)", () => {
      expect(MIG).not.toMatch(/INSERT INTO inventory_locations/);
    });
  });
});
