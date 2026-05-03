// Regression: filter + collapse interaction. Reproduces the user-reported
// bug "store filter doesn't work with collapse — multi shows nothing".
import { describe, it, expect } from "vitest";
import { filterRows, sortRows } from "../filter";
import { collapseRows } from "../collapse";
import type { ATSRow } from "../types";

function row(p: Partial<ATSRow> & { sku: string; store: string; master_category: string }): ATSRow {
  return {
    description: p.description ?? `desc ${p.sku}`,
    dates: p.dates ?? {},
    onPO: p.onPO ?? 0,
    onOrder: p.onOrder ?? 0,
    onHand: p.onHand ?? 0,
    master_category: p.master_category,
    master_sub_category: p.master_sub_category ?? "Slim",
    master_style: p.master_style ?? p.sku.split(" - ")[0],
    master_color: p.master_color ?? null,
    master_match_source: "style",
    ...p,
  };
}

const TODAY = new Date("2026-05-04T12:00:00Z");
const filtDefaults = {
  search: "", filterCategory: "All", filterSubCategory: "All", filterGender: "All",
  filterStatus: "All", minATS: "" as const, customerSkuSet: null, today: TODAY,
};

describe("filter + collapse: multi-store store filter", () => {
  const data: ATSRow[] = [
    row({ sku: "A", store: "ROF",      master_category: "DENIM",  onHand: 10 }),
    row({ sku: "B", store: "PT",       master_category: "DENIM",  onHand: 20 }),
    row({ sku: "C", store: "ROF ECOM", master_category: "DENIM",  onHand: 30 }),
    row({ sku: "D", store: "ROF",      master_category: "SHORTS", onHand: 5  }),
    row({ sku: "E", store: "PT",       master_category: "SHORTS", onHand: 7  }),
  ];

  it("storeFilter=['All'] keeps all 5 rows; collapse by category yields 2 aggregates summing all stores", () => {
    const f = filterRows(data, { ...filtDefaults, storeFilter: ["All"] });
    expect(f).toHaveLength(5);
    const collapsed = collapseRows(sortRows(f, null, "asc"), "category", new Set());
    expect(collapsed).toHaveLength(2);
    const denim = collapsed.find(r => r.master_category === "DENIM")!;
    expect(denim.onHand).toBe(60);
    const shorts = collapsed.find(r => r.master_category === "SHORTS")!;
    expect(shorts.onHand).toBe(12);
  });

  it("storeFilter=['ROF'] keeps 2 rows; collapse yields 2 aggregates with ROF-only sums", () => {
    const f = filterRows(data, { ...filtDefaults, storeFilter: ["ROF"] });
    expect(f.map(r => r.sku).sort()).toEqual(["A", "D"]);
    const collapsed = collapseRows(sortRows(f, null, "asc"), "category", new Set());
    expect(collapsed).toHaveLength(2);
    expect(collapsed.find(r => r.master_category === "DENIM")!.onHand).toBe(10);
    expect(collapsed.find(r => r.master_category === "SHORTS")!.onHand).toBe(5);
  });

  it("storeFilter=['ROF','PT'] keeps 4 rows (ROF ECOM dropped); collapse aggregates ROF+PT", () => {
    const f = filterRows(data, { ...filtDefaults, storeFilter: ["ROF", "PT"] });
    expect(f.map(r => r.sku).sort()).toEqual(["A", "B", "D", "E"]);
    const collapsed = collapseRows(sortRows(f, null, "asc"), "category", new Set());
    expect(collapsed).toHaveLength(2);
    expect(collapsed.find(r => r.master_category === "DENIM")!.onHand).toBe(30); // 10 + 20
    expect(collapsed.find(r => r.master_category === "SHORTS")!.onHand).toBe(12); // 5 + 7
  });

  it("expand reveals only filtered children (multi-store)", () => {
    const f = filterRows(data, { ...filtDefaults, storeFilter: ["ROF", "PT"] });
    const collapsed = collapseRows(sortRows(f, null, "asc"), "category", new Set(["category:DENIM"]));
    // expect aggregate + 2 children (A and B; C is ROF ECOM and was filtered)
    const denimChildren = collapsed.filter(r => !r.__collapsed && r.master_category === "DENIM");
    expect(denimChildren.map(r => r.sku).sort()).toEqual(["A", "B"]);
  });

  it("storeFilter is case- and whitespace-tolerant — 'rof' / 'PT ' / ' Pt ' all match canonical 'ROF' / 'PT'", () => {
    const dirty: ATSRow[] = [
      row({ sku: "X", store: "rof",  master_category: "DENIM" }),
      row({ sku: "Y", store: "PT ",  master_category: "DENIM" }),
      row({ sku: "Z", store: " Pt ", master_category: "DENIM" }),
      row({ sku: "W", store: "FOO",  master_category: "DENIM" }), // truly different — should drop
    ];
    const f = filterRows(dirty, { ...filtDefaults, storeFilter: ["ROF", "PT"] });
    expect(f.map(r => r.sku).sort()).toEqual(["X", "Y", "Z"]);
  });
});

describe("filter + collapse: gender filter", () => {
  const data: ATSRow[] = [
    row({ sku: "A", store: "ROF", master_category: "DENIM", gender: "M",   onHand: 10 }),
    row({ sku: "B", store: "ROF", master_category: "DENIM", gender: "B",   onHand: 20 }),
    row({ sku: "C", store: "ROF", master_category: "DENIM", gender: "Wms", onHand: 30 }),
  ];

  it("gender='M' keeps only A; collapse aggregates only A", () => {
    const f = filterRows(data, { ...filtDefaults, storeFilter: ["All"], filterGender: "M" });
    expect(f.map(r => r.sku)).toEqual(["A"]);
    const collapsed = collapseRows(sortRows(f, null, "asc"), "category", new Set());
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].onHand).toBe(10);
  });

  it("gender comparator is case- and whitespace-tolerant — 'm' / ' M ' match 'M'", () => {
    const dirty: ATSRow[] = [
      row({ sku: "A", store: "ROF", master_category: "DENIM", gender: "m"   }),
      row({ sku: "B", store: "ROF", master_category: "DENIM", gender: " M " }),
      row({ sku: "C", store: "ROF", master_category: "DENIM", gender: "B"   }), // truly different — drops
    ];
    const f = filterRows(dirty, { ...filtDefaults, storeFilter: ["All"], filterGender: "M" });
    expect(f.map(r => r.sku).sort()).toEqual(["A", "B"]);
  });
});
