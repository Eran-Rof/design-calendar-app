import { describe, it, expect } from "vitest";
import { excludeRows, onlyExcluded } from "../exclude";
import type { ATSRow } from "../types";

function row(sku: string): ATSRow {
  return { sku, description: "", store: "ROF", dates: {}, onPO: 0, onOrder: 0, onHand: 0 } as ATSRow;
}

describe("exclude helpers", () => {
  const rows = [row("A"), row("B"), row("C")];

  describe("excludeRows", () => {
    it("returns the same array reference when nothing is excluded", () => {
      const out = excludeRows(rows, new Set());
      expect(out).toBe(rows); // no churn for memoized callers
    });
    it("drops excluded skus, keeps the rest in order", () => {
      const out = excludeRows(rows, new Set(["B"]));
      expect(out.map(r => r.sku)).toEqual(["A", "C"]);
    });
    it("can exclude everything", () => {
      expect(excludeRows(rows, new Set(["A", "B", "C"]))).toEqual([]);
    });
    it("ignores excluded skus that aren't present", () => {
      expect(excludeRows(rows, new Set(["Z"])).map(r => r.sku)).toEqual(["A", "B", "C"]);
    });
  });

  describe("onlyExcluded", () => {
    it("returns [] when nothing is excluded", () => {
      expect(onlyExcluded(rows, new Set())).toEqual([]);
    });
    it("returns only the excluded rows", () => {
      expect(onlyExcluded(rows, new Set(["A", "C"])).map(r => r.sku)).toEqual(["A", "C"]);
    });
  });

  it("excludeRows + onlyExcluded partition the input", () => {
    const excluded = new Set(["B"]);
    const calc = excludeRows(rows, excluded);
    const dropped = onlyExcluded(rows, excluded);
    expect(calc.length + dropped.length).toBe(rows.length);
    expect([...calc, ...dropped].map(r => r.sku).sort()).toEqual(["A", "B", "C"]);
  });
});
