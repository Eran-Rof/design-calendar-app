import { describe, it, expect } from "vitest";
import { tokenizeSearch, rowMatchesSearch, filterRows, statFilterRows, sortRows } from "../filter";
import type { ATSRow } from "../types";

function row(partial: Partial<ATSRow> & { sku: string }): ATSRow {
  return {
    description: "",
    store: "ROF",
    dates: {},
    onOrder: 0,
    onCommitted: 0,
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
    search: "", filterCategory: "All", filterStatus: "All", minATS: "" as const,
    storeFilter: ["All"], customerSkuSet: null, today: TODAY,
  };

  it("returns all rows with default filters", () => {
    expect(filterRows(base, defaults)).toHaveLength(3);
  });

  it("category filter", () => {
    const out = filterRows(base, { ...defaults, filterCategory: "red" });
    expect(out.map(r => r.sku)).toEqual(["A", "C"]);
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

  it("returns input unchanged when sortCol null", () => {
    expect(sortRows(rows, null, "asc")).toBe(rows);
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
});
