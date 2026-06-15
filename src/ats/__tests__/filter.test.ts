import { describe, it, expect } from "vitest";
import { tokenizeSearch, rowMatchesSearch, filterRows, statFilterRows, sortRows } from "../filter";
import type { ATSRow } from "../types";

function row(partial: Partial<ATSRow> & { sku: string }): ATSRow {
  return {
    description: "",
    store: "ROF",
    dates: {},
    onPO: 0,
    onOrder: 0,
    onHand: 0,
    ...partial,
  } as ATSRow;
}

const TODAY = new Date("2026-04-10T12:00:00Z");

describe("tokenizeSearch", () => {
  it("splits on whitespace and drops empty + dash-only tokens", () => {
    expect(tokenizeSearch("  412   -  es  ")).toEqual(["412", "es"]);
  });
  it("lowercases", () => {
    expect(tokenizeSearch("AbC dEf")).toEqual(["abc", "def"]);
  });
  it("returns empty array for empty input", () => {
    expect(tokenizeSearch("")).toEqual([]);
    expect(tokenizeSearch("   ")).toEqual([]);
  });
});

describe("rowMatchesSearch", () => {
  it("matches when every token is a substring of sku or description", () => {
    const r = row({ sku: "RYB04412", description: "Delano Espresso" });
    expect(rowMatchesSearch(r, ["412", "es"])).toBe(true);
  });
  it("fails if any token is missing", () => {
    const r = row({ sku: "RYB04412", description: "Delano" });
    expect(rowMatchesSearch(r, ["412", "nonexistent"])).toBe(false);
  });
  it("null description doesn't crash", () => {
    const r = row({ sku: "X", description: null as any });
    expect(rowMatchesSearch(r, ["x"])).toBe(true);
    expect(rowMatchesSearch(r, ["y"])).toBe(false);
  });
  it("empty tokens means everything matches", () => {
    expect(rowMatchesSearch(row({ sku: "A" }), [])).toBe(true);
  });
});

describe("filterRows", () => {
  const base = [
    row({ sku: "A", category: "red",  store: "ROF",      dates: { "2026-04-10": 5  }, onHand: 5  }),
    row({ sku: "B", category: "blue", store: "ROF ECOM", dates: { "2026-04-10": 0  }, onHand: 0  }),
    row({ sku: "C", category: "red",  store: "PT",       dates: { "2026-04-10": 50 }, onHand: 50 }),
  ];
  const defaults = {
    search: "", filterCategory: [] as string[], filterSubCategory: [] as string[], filterStyle: [] as string[], filterGender: [] as string[], filterStatus: "All", minATS: "" as const,
    storeFilter: ["All"], customerSkuSet: null, today: TODAY,
  };

  it("returns all rows with default filters", () => {
    expect(filterRows(base, defaults)).toHaveLength(3);
  });

  it("single-category filter", () => {
    const out = filterRows(base, { ...defaults, filterCategory: ["red"] });
    expect(out.map(r => r.sku)).toEqual(["A", "C"]);
  });

  it("multi-category filter", () => {
    const out = filterRows(base, { ...defaults, filterCategory: ["red", "blue"] });
    expect(out.map(r => r.sku)).toEqual(["A", "B", "C"]);
  });

  it("status Low filter (1–10 today)", () => {
    const out = filterRows(base, { ...defaults, filterStatus: "Low" });
    expect(out.map(r => r.sku)).toEqual(["A"]);
  });

  it("status Out filter (≤0 today)", () => {
    const out = filterRows(base, { ...defaults, filterStatus: "Out" });
    expect(out.map(r => r.sku)).toEqual(["B"]);
  });

  it("minATS filter", () => {
    const out = filterRows(base, { ...defaults, minATS: 10 });
    expect(out.map(r => r.sku)).toEqual(["C"]);
  });

  it("gender filter prefers master_gender, falls back to feed gender, and is case/whitespace tolerant", () => {
    const rows = [
      // master_gender wins even though the feed gender column is blank
      // (the RYB1477 case: item master says M, feed carries nothing).
      row({ sku: "M1", master_gender: "M", gender: "" }),
      // no master match → falls back to the feed's gender
      row({ sku: "M2", master_gender: null, gender: "M" }),
      // womens, via master (raw Xoro code "WMS"); dropdown picks "Wms"
      row({ sku: "W1", master_gender: " wms ", gender: "" }),
      // boys, should be excluded by a Mens filter
      row({ sku: "B1", master_gender: "B", gender: "M" }),
    ];
    const mens = filterRows(rows, { ...defaults, filterGender: ["M"] });
    expect(mens.map(r => r.sku)).toEqual(["M1", "M2"]);
    const womens = filterRows(rows, { ...defaults, filterGender: ["Wms"] });
    expect(womens.map(r => r.sku)).toEqual(["W1"]);
  });

  it("store filter", () => {
    const out = filterRows(base, { ...defaults, storeFilter: ["ROF ECOM"] });
    expect(out.map(r => r.sku)).toEqual(["B"]);
  });

  it("customerSkuSet filter", () => {
    const out = filterRows(base, { ...defaults, customerSkuSet: new Set(["A", "C"]) });
    expect(out.map(r => r.sku)).toEqual(["A", "C"]);
  });

  it("falls back to onHand when today date not in dates", () => {
    const r = row({ sku: "X", dates: {}, onHand: 7 });
    const out = filterRows([r], { ...defaults, filterStatus: "Low" });
    expect(out).toHaveLength(1);
  });

  describe("brand filter", () => {
    const branded = [
      row({ sku: "A", master_brand: "Ring of Fire", dates: { "2026-04-10": 5 }, onHand: 5 }),
      row({ sku: "B", master_brand: "Psycho Tuna",  dates: { "2026-04-10": 5 }, onHand: 5 }),
      row({ sku: "C", master_brand: null,           dates: { "2026-04-10": 5 }, onHand: 5 }),
    ];
    it("empty / absent filterBrand passes every row", () => {
      expect(filterRows(branded, defaults).map(r => r.sku)).toEqual(["A", "B", "C"]);
      expect(filterRows(branded, { ...defaults, filterBrand: [] }).map(r => r.sku)).toEqual(["A", "B", "C"]);
    });
    it("single brand narrows to that brand", () => {
      expect(filterRows(branded, { ...defaults, filterBrand: ["Psycho Tuna"] }).map(r => r.sku)).toEqual(["B"]);
    });
    it("multiple brands match any (set membership)", () => {
      expect(filterRows(branded, { ...defaults, filterBrand: ["Ring of Fire", "Psycho Tuna"] }).map(r => r.sku)).toEqual(["A", "B"]);
    });
    it("rows with no brand never match a brand filter", () => {
      expect(filterRows(branded, { ...defaults, filterBrand: ["Ring of Fire"] }).map(r => r.sku)).toEqual(["A"]);
    });
  });
});

describe("statFilterRows", () => {
  const periods = [{ endDate: "2026-04-10" }, { endDate: "2026-05-01" }];
  const rows = [
    row({ sku: "A", dates: { "2026-04-10": -5, "2026-05-01":  5 } }),
    row({ sku: "B", dates: { "2026-04-10":  5, "2026-05-01":  0 } }),
    row({ sku: "C", dates: { "2026-04-10":  5, "2026-05-01": 10 } }),
  ];

  it("null returns input unchanged", () => {
    expect(statFilterRows(rows, null, periods)).toBe(rows);
  });

  it("negATS matches any negative value in displayPeriods", () => {
    const out = statFilterRows(rows, "negATS", periods);
    expect(out.map(r => r.sku)).toEqual(["A"]);
  });
  it("negATS ignores negative values on dates outside displayPeriods", () => {
    const withHistorical = [
      ...rows,
      // Only negative on a past date not in displayPeriods — should NOT appear
      row({ sku: "D", dates: { "2025-12-01": -3, "2026-04-10": 0, "2026-05-01": 0 } }),
    ];
    const out = statFilterRows(withHistorical, "negATS", periods);
    expect(out.map(r => r.sku)).toEqual(["A"]);
  });

  it("zeroStock matches when any displayPeriod value is <=0", () => {
    const out = statFilterRows(rows, "zeroStock", periods);
    expect(out.map(r => r.sku).sort()).toEqual(["A", "B"]);
  });

  it("lowStock matches when any displayPeriod value is 1–10", () => {
    const out = statFilterRows(rows, "lowStock", periods);
    expect(out.map(r => r.sku).sort()).toEqual(["A", "B", "C"]);
  });
});

describe("sortRows", () => {
  const rows = [
    row({ sku: "B", onHand: 50 }),
    row({ sku: "A", onHand: 30 }),
    row({ sku: "C", onHand: 40 }),
  ];

  it("with no sortCol, preserves order when no rows have open activity", () => {
    // None of A/B/C have onPO or onOrder set → bubble is a no-op, content
    // matches input. New array returned (sortRows now always returns new).
    expect(sortRows(rows, null, "asc").map(r => r.sku)).toEqual(["B", "A", "C"]);
  });

  it("sorts by sku ascending/descending", () => {
    expect(sortRows(rows, "sku", "asc").map(r => r.sku)).toEqual(["A", "B", "C"]);
    expect(sortRows(rows, "sku", "desc").map(r => r.sku)).toEqual(["C", "B", "A"]);
  });

  it("sorts by onHand numeric", () => {
    expect(sortRows(rows, "onHand", "asc").map(r => r.sku)).toEqual(["A", "C", "B"]);
  });

  it("does not mutate input", () => {
    const copy = [...rows];
    sortRows(rows, "sku", "asc");
    expect(rows).toEqual(copy);
  });

  it("sorts by onOrder (committed SO qty) — UI column 'On Order'", () => {
    const r = [
      row({ sku: "A", onOrder: 10 }),
      row({ sku: "B", onOrder: 30 }),
      row({ sku: "C", onOrder: 20 }),
    ];
    expect(sortRows(r, "onOrder", "asc").map(x => x.sku)).toEqual(["A", "C", "B"]);
    expect(sortRows(r, "onOrder", "desc").map(x => x.sku)).toEqual(["B", "C", "A"]);
  });

  it("sorts by onPO (purchase order qty) — UI column 'On PO'", () => {
    const r = [
      row({ sku: "A", onPO: 100 }),
      row({ sku: "B", onPO: 300 }),
      row({ sku: "C", onPO: 200 }),
    ];
    expect(sortRows(r, "onPO", "asc").map(x => x.sku)).toEqual(["A", "C", "B"]);
    expect(sortRows(r, "onPO", "desc").map(x => x.sku)).toEqual(["B", "C", "A"]);
  });

  it("onOrder sort is independent of onPO values", () => {
    const r = [
      row({ sku: "A", onOrder: 5,  onPO: 999 }),
      row({ sku: "B", onOrder: 1,  onPO: 1   }),
      row({ sku: "C", onOrder: 50, onPO: 500 }),
    ];
    expect(sortRows(r, "onOrder", "asc").map(x => x.sku)).toEqual(["B", "A", "C"]);
  });
});
