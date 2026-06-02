// Static-shape tests for T6-1 migration: Global Search FTS schema.
//
// Reads the migration SQL and asserts each of the 11 v1 entities has:
//   1. ADD COLUMN IF NOT EXISTS search_doc tsvector
//   2. CREATE OR REPLACE FUNCTION <t>_search_doc_refresh()
//   3. CREATE TRIGGER <t>_search_doc_refresh_trg ... BEFORE INSERT OR UPDATE
//   4. CREATE INDEX ... USING GIN (search_doc)
//   5. Backfill: UPDATE <t> SET id = id WHERE search_doc IS NULL
//
// Plus footer: NOTIFY pgrst, 'reload schema'.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = readFileSync(
  resolve(here, "../../../supabase/migrations/20260623000000_t6_chunk1_fts_schema.sql"),
  "utf8",
);

const ENTITIES = [
  "customers",
  "vendors",
  "ar_invoices",
  "invoices",
  "tanda_pos",
  "style_master",
  "ip_item_master",
  "gl_accounts",
  "cases",
  "sales_reps",
  "bank_transactions",
];

describe("T6-1 — Global Search FTS migration", () => {
  describe("per-entity schema additions (11 entities × 5 shapes)", () => {
    for (const t of ENTITIES) {
      it(`${t}: ADD COLUMN IF NOT EXISTS search_doc tsvector`, () => {
        const re = new RegExp(
          `ALTER TABLE\\s+${t}\\s+ADD COLUMN IF NOT EXISTS search_doc tsvector`,
          "i",
        );
        expect(MIG).toMatch(re);
      });

      it(`${t}: CREATE OR REPLACE FUNCTION ${t}_search_doc_refresh()`, () => {
        const re = new RegExp(
          `CREATE OR REPLACE FUNCTION ${t}_search_doc_refresh\\(\\) RETURNS trigger`,
          "i",
        );
        expect(MIG).toMatch(re);
      });

      it(`${t}: CREATE TRIGGER ${t}_search_doc_refresh_trg BEFORE INSERT OR UPDATE`, () => {
        expect(MIG).toMatch(
          new RegExp(`DROP TRIGGER IF EXISTS ${t}_search_doc_refresh_trg ON ${t}`),
        );
        const re = new RegExp(
          `CREATE TRIGGER ${t}_search_doc_refresh_trg[\\s\\S]*?BEFORE INSERT OR UPDATE ON ${t}[\\s\\S]*?EXECUTE FUNCTION ${t}_search_doc_refresh\\(\\)`,
          "i",
        );
        expect(MIG).toMatch(re);
      });

      it(`${t}: CREATE INDEX idx_${t}_search_doc USING GIN`, () => {
        const re = new RegExp(
          `CREATE INDEX IF NOT EXISTS idx_${t}_search_doc\\s+ON ${t} USING GIN \\(search_doc\\)`,
          "i",
        );
        expect(MIG).toMatch(re);
      });

      it(`${t}: backfill UPDATE ${t} SET id = id WHERE search_doc IS NULL`, () => {
        const re = new RegExp(
          `UPDATE ${t} SET id = id WHERE search_doc IS NULL`,
          "i",
        );
        expect(MIG).toMatch(re);
      });
    }
  });

  describe("refresh-function bodies use setweight + to_tsvector('simple', ...)", () => {
    for (const t of ENTITIES) {
      it(`${t}: function body contains setweight(to_tsvector('simple', ...))`, () => {
        // Extract just this entity's function body so we don't false-positive
        // on a sibling function's contents.
        const fnRe = new RegExp(
          `CREATE OR REPLACE FUNCTION ${t}_search_doc_refresh\\(\\)[\\s\\S]*?END \\$\\$;`,
        );
        const m = MIG.match(fnRe);
        expect(m, `expected function body for ${t}`).toBeTruthy();
        expect(m[0]).toMatch(/setweight\(\s*to_tsvector\(\s*'simple'\s*,/);
        expect(m[0]).toMatch(/coalesce\(NEW\.[a-z_]+, ''\)/);
      });
    }
  });

  describe("weight letter coverage", () => {
    it("uses weight 'A' at least once per entity", () => {
      for (const t of ENTITIES) {
        const fnRe = new RegExp(
          `CREATE OR REPLACE FUNCTION ${t}_search_doc_refresh\\(\\)[\\s\\S]*?END \\$\\$;`,
        );
        const m = MIG.match(fnRe);
        expect(m[0]).toMatch(/, 'A'\)/);
      }
    });
  });

  describe("PostgREST schema reload footer", () => {
    it("ends with NOTIFY pgrst, 'reload schema'", () => {
      expect(MIG).toMatch(/NOTIFY pgrst, 'reload schema'/);
    });
  });
});
