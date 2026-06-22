// Bulk↔distro match by style/color (Scenario 4.2).
import { describe, it, expect } from "vitest";
import { computeBulkMatch, aggregateByStyleColor, styleColorKey } from "../sales/bulkMatch.js";

const L = (style_code, color, qty) => ({ style_code, color, qty });

describe("styleColorKey / aggregateByStyleColor", () => {
  it("is case- and space-insensitive and sums per style+color", () => {
    expect(styleColorKey(" ryb01 ", "Khaki")).toBe(styleColorKey("RYB01", "khaki"));
    const m = aggregateByStyleColor([L("RYB01", "Khaki", 24), L("ryb01", "khaki", 12)]);
    expect(m.get(styleColorKey("RYB01", "Khaki")).qty).toBe(36);
  });
  it("skips lines with no style_code", () => {
    expect(aggregateByStyleColor([{ color: "Red", qty: 10 }]).size).toBe(0);
  });
});

describe("computeBulkMatch", () => {
  it("matches overlapping style/colors as min of the two", () => {
    const bulk = [L("A", "Red", 100), L("B", "Blue", 100)];
    const distro = [L("A", "Red", 40), L("B", "Blue", 120)];
    const r = computeBulkMatch(bulk, distro);
    expect(r.bulk_units).toBe(200);
    expect(r.distro_units).toBe(160);
    expect(r.matched_units).toBe(40 + 100); // min(100,40)+min(100,120)
    expect(r.match_pct).toBe(Math.round((140 / 160) * 1000) / 10); // of distro
    expect(r.bulk_coverage_pct).toBe(70); // 140/200
  });

  it("ignores non-overlapping style/colors (matched=0 for them)", () => {
    const r = computeBulkMatch([L("A", "Red", 50)], [L("C", "Green", 50)]);
    expect(r.matched_units).toBe(0);
    expect(r.match_pct).toBe(0);
    expect(r.breakdown).toHaveLength(2);
  });

  it("ranks the breakdown by matched desc", () => {
    const r = computeBulkMatch(
      [L("A", "Red", 10), L("B", "Blue", 100)],
      [L("A", "Red", 10), L("B", "Blue", 100)],
    );
    expect(r.breakdown[0].style_code).toBe("B");
    expect(r.breakdown[0].matched).toBe(100);
  });

  it("handles empty inputs", () => {
    const r = computeBulkMatch([], []);
    expect(r).toMatchObject({ matched_units: 0, bulk_units: 0, distro_units: 0, match_pct: 0, bulk_coverage_pct: 0 });
    expect(r.breakdown).toEqual([]);
  });
});
