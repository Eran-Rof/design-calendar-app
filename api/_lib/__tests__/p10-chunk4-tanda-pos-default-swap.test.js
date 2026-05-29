// Static-shape sanity checks on the P10-4 tanda_pos + po_line_items
// DEFAULT swap migration. Mirrors the structure of p10-chunk3-default-swap
// for consistency, scaled down to the two-table scope.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(
  __dirname,
  "../../../supabase/migrations/20260629030000_p10_chunk4_tanda_pos_default_swap.sql",
);
const SQL = readFileSync(MIGRATION_PATH, "utf8");

// Exactly the two tables PR #463 left at plain rof_entity_id() — this chunk
// closes the loop on the 95-table entity_id-DEFAULT story (93 swapped in
// P10-3, 2 here).
const SWAP_TABLES = ["tanda_pos", "po_line_items"];

describe("P10-4 migration — tanda_pos + po_line_items DEFAULT swap static shape", () => {
  describe("filename convention", () => {
    it("matches the dated _p10_chunk4_*.sql naming convention", () => {
      expect(basename(MIGRATION_PATH)).toMatch(
        /^20260629030000_p10_chunk4_tanda_pos_default_swap\.sql$/,
      );
    });
  });

  describe("scope — exactly the two PR-#463 tables", () => {
    it("SWAP_TABLES holds exactly 2 unique tables", () => {
      expect(SWAP_TABLES.length).toBe(2);
      expect(new Set(SWAP_TABLES).size).toBe(2);
    });

    it("does NOT touch any other table (count check)", () => {
      const altered =
        SQL.match(
          /^ALTER TABLE\s+(\w+)\s+ALTER COLUMN entity_id SET DEFAULT/gm,
        ) || [];
      expect(altered.length).toBe(2);
    });
  });

  describe("per-table SET DEFAULT statements", () => {
    for (const table of SWAP_TABLES) {
      it(`${table} → SET DEFAULT coalesce(current_entity_id(), rof_entity_id())`, () => {
        const safe = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(
          `ALTER TABLE\\s+${safe}\\s+ALTER COLUMN entity_id SET DEFAULT coalesce\\(current_entity_id\\(\\), rof_entity_id\\(\\)\\);`,
        );
        expect(SQL).toMatch(pattern);
      });
    }
  });

  describe("uniformity — both ALTERs use the same coalesce body", () => {
    it("emits both as coalesce(current_entity_id(), rof_entity_id())", () => {
      const altered =
        SQL.match(
          /^ALTER TABLE\s+\w+\s+ALTER COLUMN entity_id SET DEFAULT ([^;]+);/gm,
        ) || [];
      expect(altered.length).toBe(2);
      for (const stmt of altered) {
        expect(stmt).toMatch(
          /SET DEFAULT coalesce\(current_entity_id\(\), rof_entity_id\(\)\)/,
        );
      }
    });
  });

  describe("idempotent shape — no destructive ALTERs", () => {
    it("contains no ALTER COLUMN entity_id DROP DEFAULT statements", () => {
      expect(SQL).not.toMatch(/ALTER COLUMN entity_id DROP DEFAULT/i);
    });

    it("contains no ALTER COLUMN entity_id SET NOT NULL statements", () => {
      expect(SQL).not.toMatch(/ALTER COLUMN entity_id SET NOT NULL/i);
    });

    it("contains no ALTER COLUMN entity_id TYPE statements (would rewrite column)", () => {
      expect(SQL).not.toMatch(/ALTER COLUMN entity_id TYPE/i);
    });
  });

  describe("prerequisite sanity probes", () => {
    it("guards on current_entity_id() helper presence (P10-2 prerequisite)", () => {
      expect(SQL).toMatch(/proname = 'current_entity_id'/);
      expect(SQL).toMatch(/current_entity_id\(\) function not found/);
    });

    it("guards on rof_entity_id() helper presence (PR #463 prerequisite)", () => {
      expect(SQL).toMatch(/proname = 'rof_entity_id'/);
      expect(SQL).toMatch(/rof_entity_id\(\) function not found/);
    });

    it("uses RAISE EXCEPTION (not RAISE WARNING) so a missing prereq aborts", () => {
      expect(SQL).toMatch(/RAISE EXCEPTION 'P10-4 prerequisite missing/);
    });
  });

  describe("documentation + cache reload", () => {
    it("ends with NOTIFY pgrst 'reload schema'", () => {
      expect(SQL).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
    });

    it("header references PR #463 (the migration this chunk follows up on)", () => {
      expect(SQL).toMatch(/PR #463/);
    });

    it("header references P10-3 (the chunk that swapped the other 93 tables)", () => {
      expect(SQL).toMatch(/P10-3/);
    });

    it("header explains the coalesce(current_entity_id(), rof_entity_id()) rationale", () => {
      expect(SQL).toMatch(/coalesce\(current_entity_id\(\), rof_entity_id\(\)\)/);
      expect(SQL).toMatch(/service-role/i);
    });
  });

  describe("no COMMENT-concat regressions (lint — see PR #486)", () => {
    // Strip line-comments so prose in the header doesn't trip the lint.
    const sqlOnly = SQL.split(/\r?\n/)
      .filter((l) => !/^\s*--/.test(l))
      .join("\n");

    // Extract each COMMENT ON statement up to its trailing `';` boundary.
    const commentStatements = sqlOnly.match(/COMMENT ON[^\n]*?'\s*;/g) || [];

    it("any COMMENT ON statements use IS '...' literals, no || concat", () => {
      // P10-4 has zero COMMENT ON statements (pure ALTER), but if a future
      // edit adds one, it must not use ||.
      for (const stmt of commentStatements) {
        expect(stmt).not.toMatch(/\|\|/);
        expect(stmt).toMatch(/IS\s+'[^']*'\s*;\s*$/);
      }
    });
  });
});
