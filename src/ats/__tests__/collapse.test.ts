import { describe, it, expect } from "vitest";
import type { ATSRow } from "../types";
import { collapseRows, groupKeyFor } from "../collapse";

function row(over: Partial<ATSRow>): ATSRow {
  return {
    sku: "SKU",
    description: "desc",
    dates: {},
    onPO: 0,
    onOrder: 0,
    onHand: 0,
    ...over,
  };
}

describe("collapseRows", () => {
  it("returns input unchanged for level=none", () => {
    const rows = [row({ sku: "A" }), row({ sku: "B" })];
    const out = collapseRows(rows, "none", new Set());
    expect(out).toBe(rows);
  });

  it("groups by category and sums numerics", () => {
    const rows = [
      row({ sku: "A", master_category: "DENIM", onHand: 5, onOrder: 1, onPO: 2, dates: { "2026-05-01": 10 } }),
      row({ sku: "B", master_category: "DENIM", onHand: 3, onOrder: 4, onPO: 6, dates: { "2026-05-01": 7 } }),
      row({ sku: "C", master_category: "TOPS", onHand: 1, onOrder: 0, onPO: 0, dates: { "2026-05-01": 2 } }),
    ];
    const out = collapseRows(rows, "category", new Set());
    expect(out).toHaveLength(2);
    expect(out[0].master_category).toBe("DENIM");
    expect(out[0].master_sub_category).toBeNull();
    expect(out[0].description).toBe("(2 items)");
    expect(out[0].onHand).toBe(8);
    expect(out[0].onOrder).toBe(5);
    expect(out[0].onPO).toBe(8);
    expect(out[0].dates["2026-05-01"]).toBe(17);
    expect(out[0].__collapsed).toEqual({ level: "category", key: "category:DENIM", childCount: 2 });
    expect(out[1].master_category).toBe("TOPS");
    expect(out[1].__collapsed?.childCount).toBe(1);
  });

  it("groups by subCategory with both fields populated", () => {
    const rows = [
      row({ sku: "A", master_category: "DENIM", master_sub_category: "SLIM", onHand: 5 }),
      row({ sku: "B", master_category: "DENIM", master_sub_category: "SLIM", onHand: 3 }),
      row({ sku: "C", master_category: "DENIM", master_sub_category: "WIDE", onHand: 1 }),
    ];
    const out = collapseRows(rows, "subCategory", new Set());
    expect(out).toHaveLength(2);
    expect(out[0].master_category).toBe("DENIM");
    expect(out[0].master_sub_category).toBe("SLIM");
    expect(out[0].master_style).toBeNull();
    expect(out[0].onHand).toBe(8);
  });

  it("groups by style with all three populated", () => {
    const rows = [
      row({ sku: "A", store: "X", master_category: "DENIM", master_sub_category: "SLIM", master_style: "RYB0185", master_color: "BLUE", onHand: 5 }),
      row({ sku: "B", store: "Y", master_category: "DENIM", master_sub_category: "SLIM", master_style: "RYB0185", master_color: "BLACK", onHand: 3 }),
    ];
    const out = collapseRows(rows, "style", new Set());
    expect(out).toHaveLength(1);
    expect(out[0].master_category).toBe("DENIM");
    expect(out[0].master_sub_category).toBe("SLIM");
    expect(out[0].master_style).toBe("RYB0185");
    expect(out[0].master_color).toBeNull();
    expect(out[0].store).toBeUndefined();
    expect(out[0].onHand).toBe(8);
  });

  it("treats missing master_category as (none)", () => {
    const rows = [
      row({ sku: "A", master_category: null, onHand: 5 }),
      row({ sku: "B", master_category: null, onHand: 3 }),
    ];
    const out = collapseRows(rows, "category", new Set());
    expect(out).toHaveLength(1);
    expect(out[0].master_category).toBe("(none)");
    expect(out[0].__collapsed?.key).toBe("category:(none)");
    expect(out[0].onHand).toBe(8);
  });

  it("expands one group while leaving others collapsed", () => {
    const a = row({ sku: "A", master_category: "DENIM", onHand: 5 });
    const b = row({ sku: "B", master_category: "DENIM", onHand: 3 });
    const c = row({ sku: "C", master_category: "TOPS", onHand: 1 });
    const out = collapseRows([a, b, c], "category", new Set(["category:DENIM"]));
    expect(out).toHaveLength(4);
    expect(out[0].__collapsed?.key).toBe("category:DENIM");
    expect(out[1]).toBe(a);
    expect(out[2]).toBe(b);
    expect(out[3].__collapsed?.key).toBe("category:TOPS");
  });

  it("sums dates as union of keys", () => {
    const rows = [
      row({ sku: "A", master_category: "DENIM", dates: { "2026-05-01": 10 } }),
      row({ sku: "B", master_category: "DENIM", dates: { "2026-05-01": 5, "2026-06-01": 7 } }),
    ];
    const out = collapseRows(rows, "category", new Set());
    expect(out[0].dates).toEqual({ "2026-05-01": 15, "2026-06-01": 7 });
  });

  it("freeMap undefined when no children have it", () => {
    const rows = [
      row({ sku: "A", master_category: "DENIM" }),
      row({ sku: "B", master_category: "DENIM" }),
    ];
    const out = collapseRows(rows, "category", new Set());
    expect(out[0].freeMap).toBeUndefined();
  });

  it("freeMap summed when at least one child has it", () => {
    const rows = [
      row({ sku: "A", master_category: "DENIM", freeMap: { "2026-05-01": 4 } }),
      row({ sku: "B", master_category: "DENIM", freeMap: { "2026-05-01": 2, "2026-06-01": 9 } }),
      row({ sku: "C", master_category: "DENIM" }),
    ];
    const out = collapseRows(rows, "category", new Set());
    expect(out[0].freeMap).toEqual({ "2026-05-01": 6, "2026-06-01": 9 });
  });

  it("groupKeyFor returns null for level=none and proper composite keys", () => {
    const r = row({ sku: "A", master_category: "DENIM", master_sub_category: "SLIM", master_style: "RYB0185" });
    expect(groupKeyFor(r, "none")).toBeNull();
    expect(groupKeyFor(r, "category")).toBe("category:DENIM");
    expect(groupKeyFor(r, "subCategory")).toBe("subCategory:DENIM:SLIM");
    expect(groupKeyFor(r, "style")).toBe("style:DENIM:SLIM:RYB0185");
    const empty = row({ sku: "B" });
    expect(groupKeyFor(empty, "category")).toBe("category:(none)");
  });

  it("is stable across calls", () => {
    const rows = [
      row({ sku: "A", master_category: "DENIM", onHand: 5, dates: { "2026-05-01": 10 } }),
      row({ sku: "B", master_category: "TOPS", onHand: 3, dates: { "2026-05-01": 2 } }),
      row({ sku: "C", master_category: "DENIM", onHand: 7, dates: { "2026-05-01": 4 } }),
    ];
    const out1 = collapseRows(rows, "category", new Set(["category:DENIM"]));
    const out2 = collapseRows(rows, "category", new Set(["category:DENIM"]));
    expect(out1).toEqual(out2);
  });
});
