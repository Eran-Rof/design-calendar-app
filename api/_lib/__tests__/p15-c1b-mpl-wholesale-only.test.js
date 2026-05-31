// @vitest-environment node
//
// P15 C1b — MPL-wholesale-only correction migration shape test.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(__dirname, "../../../supabase/migrations/20260710010000_p15_c1b_mpl_wholesale_only.sql"),
  "utf8",
);

describe("P15-C1b — MPL wholesale-only correction", () => {
  it("deletes the ecom-side channel mappings for the two MPL brands", () => {
    expect(SQL).toMatch(/DELETE FROM brand_channel_partition/);
    expect(SQL).toMatch(/b\.code IN \('MPLEPIC', 'MPLSUNSTONE'\)/);
    expect(SQL).toMatch(/c\.code IN \('DTC', 'FBA', 'WALMART', 'FAIRE'\)/);
  });

  it("drops the MPL Ecom partitions but leaves the WS pools alone", () => {
    expect(SQL).toMatch(/DELETE FROM inventory_partition\s+WHERE code IN \('MPLEPIC-EC', 'MPLSUNSTONE-EC'\)/);
    expect(SQL).not.toMatch(/MPLEPIC-WS/);      // wholesale pools must NOT be touched
    expect(SQL).not.toMatch(/MPLSUNSTONE-WS/);
  });

  it("does not touch the WHOLESALE channel mapping", () => {
    // The correction only removes ecom-side channels; WHOLESALE is never named.
    expect(SQL).not.toMatch(/'WHOLESALE'/);
  });

  it("reloads PostgREST", () => {
    expect(SQL).toMatch(/NOTIFY pgrst/);
  });
});
