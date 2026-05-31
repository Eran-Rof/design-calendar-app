// @vitest-environment node
//
// P15 C1e — ip_item_avg_cost brand_id mapping migration shape test.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(__dirname, "../../../supabase/migrations/20260710040000_p15_c1e_ip_avg_cost_brand.sql"),
  "utf8",
);

describe("P15-C1e — ip_item_avg_cost brand mapping", () => {
  it("seeds the two data-surfaced brands PL + ROHM", () => {
    expect(SQL).toMatch(/\(rof_entity_id\(\), 'PL', +'Private Label'/);
    expect(SQL).toMatch(/\(rof_entity_id\(\), 'ROHM', +'ROHM'/);
  });

  it("adds brand_id WITHOUT a default first (so backfill controls every value)", () => {
    // ADD COLUMN must not carry a DEFAULT (else existing rows get ROF before the
    // brand_name backfill, wrongly tagging Axel).
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES brand_master\(id\) ON DELETE RESTRICT;/);
    expect(SQL).not.toMatch(/ADD COLUMN IF NOT EXISTS brand_id[^;]*DEFAULT/);
    // DEFAULT is set AFTER the backfill, for future inserts only.
    expect(SQL).toMatch(/ALTER COLUMN brand_id SET DEFAULT rof_default_brand_id\(\)/);
  });

  it("maps every confirmed brand_name to the right code", () => {
    const pairs = [
      ["Ring of Fire", "ROF"], ["Psycho Tuna", "PT"], ["Axe n Crown", "AXECROWN"],
      ["Epic Threads", "MPLEPIC"], ["BLUE RISE", "BLUERISE"], ["Sun \\+ Stone", "MPLSUNSTONE"],
      ["FORT KNOX", "FORTKNOX"], ["Departed", "DEPARTED"], ["Private Label", "PL"], ["ROHM", "ROHM"],
    ];
    for (const [name, code] of pairs) {
      expect(SQL).toMatch(new RegExp(`WHEN '${name}'\\s+THEN '${code}'`));
    }
  });

  it("leaves Axel NULL (separate entity) — never mapped to a code", () => {
    expect(SQL).not.toMatch(/WHEN 'Axel'/);
    expect(SQL).toMatch(/ELSE NULL/);
  });

  it("maps null brand_name to the ROF default brand", () => {
    expect(SQL).toMatch(/WHERE brand_name IS NULL AND brand_id IS NULL/);
    expect(SQL).toMatch(/SET brand_id = rof_default_brand_id\(\)/);
  });

  it("keeps brand_name (no DROP) + does not add partition_id here", () => {
    expect(SQL).not.toMatch(/DROP COLUMN brand_name/);
    expect(SQL).not.toMatch(/partition_id/);
  });
});
