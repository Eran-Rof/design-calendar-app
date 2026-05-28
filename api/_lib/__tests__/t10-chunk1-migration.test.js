// Static-shape tests for T10-1 migration: source-tagging columns +
// xoro_mirror_runs state table.
//
// Reads the migration SQL and asserts the right ADD COLUMNs + CHECK
// constraints + table CREATEs are present. Doesn't require a live DB.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = readFileSync(
  resolve(here, "../../../supabase/migrations/20260620000000_t10_chunk1_source_columns.sql"),
  "utf8",
);

const ENUM_VALUES = [
  "manual",
  "xoro_mirror",
  "shopify",
  "fba",
  "walmart",
  "faire",
  "edi_3pl",
  "plaid_sync",
  "api",
  "system",
];

describe("T10-1 — source-tagging migration", () => {
  describe("`source` column added to AR / AP / JE tables", () => {
    for (const table of ["ar_invoices", "ar_invoice_lines", "ar_receipts", "invoices", "journal_entries"]) {
      it(`${table}: ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'`, () => {
        const re = new RegExp(
          `ALTER TABLE\\s+${table}\\s+ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'`,
          "i",
        );
        expect(MIG).toMatch(re);
      });

      it(`${table}: CHECK constraint added in DO $$ block`, () => {
        expect(MIG).toMatch(new RegExp(`${table}_source_check`));
      });

      it(`${table}: index on source for fast filter`, () => {
        expect(MIG).toMatch(
          new RegExp(`CREATE INDEX IF NOT EXISTS idx_${table}_source ON ${table} \\(source\\)`),
        );
      });
    }
  });

  describe("source enum value coverage", () => {
    for (const v of ENUM_VALUES) {
      it(`includes '${v}'`, () => {
        // The enum appears in each CHECK; count occurrences (one per CHECK).
        const re = new RegExp(`'${v}'`, "g");
        const matches = MIG.match(re) || [];
        expect(matches.length).toBeGreaterThanOrEqual(5);
      });
    }
  });

  describe("inventory_layers — source_kind enum extension", () => {
    it("drops old CHECK then adds new with xoro_mirror_snapshot", () => {
      expect(MIG).toMatch(/DROP CONSTRAINT IF EXISTS inventory_layers_source_kind_check/);
      expect(MIG).toMatch(/ADD CONSTRAINT inventory_layers_source_kind_check[\s\S]*xoro_mirror_snapshot/);
    });
    it("preserves all original source_kind values", () => {
      for (const v of [
        "ap_invoice",
        "adjustment",
        "opening_balance",
        "transfer_in",
        "credit_memo_return",
      ]) {
        expect(MIG).toMatch(new RegExp(`'${v}'`));
      }
    });
    it("creates partial index for xoro_mirror_snapshot rows", () => {
      expect(MIG).toMatch(/idx_inventory_layers_xoro_mirror[\s\S]*WHERE source_kind = 'xoro_mirror_snapshot'/);
    });
  });

  describe("xoro_mirror_runs table", () => {
    it("CREATE TABLE IF NOT EXISTS xoro_mirror_runs", () => {
      expect(MIG).toMatch(/CREATE TABLE IF NOT EXISTS xoro_mirror_runs/);
    });
    it("domain CHECK includes ar / ap / inventory / summary_je", () => {
      expect(MIG).toMatch(/CHECK \(domain IN \('ar','ap','inventory','summary_je'\)\)/);
    });
    it("status CHECK includes all 5 expected values", () => {
      for (const s of ["running", "complete", "failed", "skipped_no_change", "skipped_stale_xoro"]) {
        expect(MIG).toMatch(new RegExp(`'${s}'`));
      }
    });
    it("UNIQUE constraint on (entity_id, domain, mirror_date) for idempotency", () => {
      expect(MIG).toMatch(/UNIQUE \(entity_id, domain, mirror_date\)/);
    });
    it("FK to journal_entries on je_id with ON DELETE SET NULL", () => {
      expect(MIG).toMatch(/je_id\s+uuid REFERENCES journal_entries\(id\) ON DELETE SET NULL/);
    });
    it("indexes for recent + status queries", () => {
      expect(MIG).toMatch(/idx_xoro_mirror_runs_recent/);
      expect(MIG).toMatch(/idx_xoro_mirror_runs_status/);
    });
  });

  describe("RLS", () => {
    it("ENABLE ROW LEVEL SECURITY on xoro_mirror_runs", () => {
      expect(MIG).toMatch(/ALTER TABLE xoro_mirror_runs ENABLE ROW LEVEL SECURITY/);
    });
    it("anon_all_xoro_mirror_runs policy created", () => {
      expect(MIG).toMatch(/CREATE POLICY anon_all_xoro_mirror_runs/);
    });
  });

  describe("PostgREST cache reload footer", () => {
    it("ends with NOTIFY pgrst, 'reload schema'", () => {
      expect(MIG).toMatch(/NOTIFY pgrst, 'reload schema';/);
    });
  });

  describe("idempotency primitives", () => {
    it("uses ADD COLUMN IF NOT EXISTS (not bare ADD COLUMN)", () => {
      const adds = MIG.match(/ALTER TABLE \w+\s+ADD COLUMN/gi) || [];
      const bareAdds = MIG.match(/ALTER TABLE \w+\s+ADD COLUMN(?! IF NOT EXISTS)/gi) || [];
      expect(bareAdds.length).toBe(0);
      expect(adds.length).toBeGreaterThan(0);
    });
    it("wraps CHECK adds in DO $$ ... EXCEPTION WHEN duplicate_object", () => {
      const wrapped = MIG.match(/EXCEPTION WHEN duplicate_object THEN NULL/g) || [];
      expect(wrapped.length).toBeGreaterThanOrEqual(5); // one per source column add
    });
  });
});
