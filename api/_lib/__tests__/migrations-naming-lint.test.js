// Lint guard: supabase migration FILENAME hygiene.
//
// supabase-db-push applies migrations in lexicographic order and tracks
// them by their version prefix (the leading token before the first `_`).
// Two recurring footguns have bitten us:
//
//   1. DUPLICATE version prefix — two different migration files sharing the
//      same version string. supabase records the version once, so the
//      second file's DDL silently never applies (a prod-schema gap that's
//      invisible until something downstream breaks).
//   2. NON-NUMERIC timestamp — uppercase letters (e.g. `...A00000`) used as
//      a same-day sub-ordering hack. These have been observed to be
//      skipped/mis-ordered by the supabase CLI.
//
// This lint fails on any NEW occurrence of either. Pre-existing violations
// are grandfathered below (the lists must SHRINK over time, never grow) so
// the gate is green on the current tree without forcing risky renames of
// already-applied migrations.

import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../../supabase/migrations");

// ── Grandfathered pre-existing violations (resolve & remove; never add) ────
// Versions currently used by >1 migration file. KNOWN BUG: one of each pair
// may not have applied to prod — flagged for manual resolution. New
// duplicates beyond this set fail the gate.
const KNOWN_DUPLICATE_VERSIONS = new Set([
  "20260629C00000", // je_memo_line_2.sql + tanda_po_tombstones.sql (PRs #587/#541)
]);
// Files whose version prefix is not purely numeric (legacy A/B/C same-day
// sub-ordering). New non-numeric timestamps fail the gate.
const KNOWN_NONNUMERIC = new Set([
  "20260629A00000_p13_chunk1_procurement_schema.sql",
  "20260629A10000_p13_chunk2_legacy_bridge.sql",
  "20260629B00000_t11_chunk2_audit_rpc.sql",
  "20260629C00000_je_memo_line_2.sql",
  "20260629C00000_tanda_po_tombstones.sql",
]);

function listMigrations() {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
}

/** Version prefix = leading token before the first underscore. */
function versionOf(filename) {
  return filename.split("_")[0];
}

describe("supabase migrations — filename hygiene", () => {
  it("no NEW duplicate version prefixes (one version → one migration)", () => {
    const byVersion = new Map();
    for (const f of listMigrations()) {
      const v = versionOf(f);
      if (!byVersion.has(v)) byVersion.set(v, []);
      byVersion.get(v).push(f);
    }
    const dups = [...byVersion.entries()]
      .filter(([v, files]) => files.length > 1 && !KNOWN_DUPLICATE_VERSIONS.has(v))
      .map(([v, files]) => `${v}: ${files.join(", ")}`);
    expect(
      dups,
      `New duplicate migration version(s) detected. Each migration needs a UNIQUE version ` +
      `prefix or the later one silently never applies. Bump the timestamp (+10s/+1m).\n\n${dups.join("\n")}`,
    ).toEqual([]);
  });

  it("no NEW non-numeric (uppercase) version timestamps", () => {
    const bad = listMigrations()
      .filter((f) => !/^\d{14}_/.test(f) && !KNOWN_NONNUMERIC.has(f));
    expect(
      bad,
      `Migration version timestamps must be 14 numeric digits (YYYYMMDDHHMMSS). ` +
      `Uppercase letters get mis-ordered/skipped by the supabase CLI.\n\n${bad.join("\n")}`,
    ).toEqual([]);
  });
});
