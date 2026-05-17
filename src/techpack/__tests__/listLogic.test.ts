// Unit tests for the TechPack list / filter / stats helpers. Drives
// the dashboard stat cards + the list filter pills, so a regression
// here = wrong counts staring at every operator.

import { describe, it, expect } from "vitest";
import {
  filterTechPacks,
  computeDashboardStats,
  flattenAllSamples,
  uniqueBrands,
  uniqueSeasons,
  filterMaterials,
  filterSpecSheets,
} from "../listLogic";
import { emptyTechPack } from "../factories";
import type { TechPack, Material, SpecSheet } from "../types";

function tp(over: Partial<TechPack> = {}): TechPack {
  return { ...emptyTechPack({ name: "test" }), ...over };
}

// ────────────────────────────────────────────────────────────────────────

describe("filterTechPacks", () => {
  const seed: TechPack[] = [
    tp({ id: "a", brand: "ROF",   season: "SS26", status: "Draft",     styleName: "Edge Slim",      styleNumber: "RYB059430" }),
    tp({ id: "b", brand: "Other", season: "SS26", status: "In Review", styleName: "Bartram",         styleNumber: "RYB060000" }),
    tp({ id: "c", brand: "ROF",   season: "FW26", status: "Approved",  styleName: "Edge Wide",      styleNumber: "RYB059431" }),
    tp({ id: "d", brand: "ROF",   season: "SS26", status: "Approved",  styleName: "Other Style",    styleNumber: "RYB070000" }),
  ];

  it("returns everything when filter is empty", () => {
    expect(filterTechPacks(seed, { status: "", brand: "", season: "", search: "" }).map(t => t.id))
      .toEqual(["a", "b", "c", "d"]);
  });

  it("filters by status", () => {
    expect(filterTechPacks(seed, { status: "Approved", brand: "", season: "" }).map(t => t.id))
      .toEqual(["c", "d"]);
  });

  it("filters by brand", () => {
    expect(filterTechPacks(seed, { status: "", brand: "ROF", season: "" }).map(t => t.id))
      .toEqual(["a", "c", "d"]);
  });

  it("filters by season", () => {
    expect(filterTechPacks(seed, { status: "", brand: "", season: "SS26" }).map(t => t.id))
      .toEqual(["a", "b", "d"]);
  });

  it("free-text search hits styleName / styleNumber / brand (case-insensitive)", () => {
    expect(filterTechPacks(seed, { status: "", brand: "", season: "", search: "edge" }).map(t => t.id))
      .toEqual(["a", "c"]);
    expect(filterTechPacks(seed, { status: "", brand: "", season: "", search: "RYB060000" }).map(t => t.id))
      .toEqual(["b"]);
    expect(filterTechPacks(seed, { status: "", brand: "", season: "", search: "OTHER" }).map(t => t.id))
      .toEqual(["b", "d"]);
  });

  it("filters AND together", () => {
    expect(filterTechPacks(seed, { status: "Approved", brand: "ROF", season: "SS26" }).map(t => t.id))
      .toEqual(["d"]);
  });

  it("returns [] when nothing matches", () => {
    expect(filterTechPacks(seed, { status: "Revised", brand: "", season: "" })).toEqual([]);
  });

  it("handles null/undefined search like empty", () => {
    expect(filterTechPacks(seed, { status: "", brand: "", season: "", search: null }).length).toBe(seed.length);
    expect(filterTechPacks(seed, { status: "", brand: "", season: "", search: undefined }).length).toBe(seed.length);
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("computeDashboardStats", () => {
  it("counts by status; zero-fills missing statuses", () => {
    const stats = computeDashboardStats([
      tp({ status: "Draft" }),
      tp({ status: "Draft" }),
      tp({ status: "In Review" }),
      tp({ status: "Approved" }),
    ]);
    expect(stats).toEqual({ total: 4, draft: 2, review: 1, approved: 1 });
  });

  it("ignores Revised / unknown statuses for the four stat buckets but counts them in total", () => {
    const stats = computeDashboardStats([
      tp({ status: "Revised" }),
      tp({ status: "Draft" }),
    ]);
    expect(stats.total).toBe(2);
    expect(stats.draft).toBe(1);
    expect(stats.review).toBe(0);
    expect(stats.approved).toBe(0);
  });

  it("zeros for empty input", () => {
    expect(computeDashboardStats([])).toEqual({ total: 0, draft: 0, review: 0, approved: 0 });
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("flattenAllSamples", () => {
  it("flattens samples + denormalises styleNumber + styleName onto each entry", () => {
    const seed: TechPack[] = [
      tp({
        styleName: "Edge", styleNumber: "100",
        samples: [
          { id: "s1", type: "Proto",      status: "Requested", requestDate: "2026-01-01", receiveDate: null, vendor: "V", comments: "", images: [] },
          { id: "s2", type: "Production", status: "Approved",  requestDate: "2026-02-01", receiveDate: "2026-03-01", vendor: "V", comments: "", images: [] },
        ],
      }),
      tp({
        styleName: "Bartram", styleNumber: "200",
        samples: [
          { id: "s3", type: "PP",         status: "Received",  requestDate: "2026-02-15", receiveDate: "2026-03-15", vendor: "V", comments: "", images: [] },
        ],
      }),
    ];
    const flat = flattenAllSamples(seed);
    expect(flat.length).toBe(3);
    expect(flat[0]).toMatchObject({ id: "s1", styleName: "Edge",    styleNumber: "100" });
    expect(flat[1]).toMatchObject({ id: "s2", styleName: "Edge",    styleNumber: "100" });
    expect(flat[2]).toMatchObject({ id: "s3", styleName: "Bartram", styleNumber: "200" });
  });

  it("returns [] when nothing has samples", () => {
    expect(flattenAllSamples([tp({ samples: [] }), tp({ samples: [] })])).toEqual([]);
    expect(flattenAllSamples([])).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────

function mat(over: Partial<Material> = {}): Material {
  return {
    id: "x", name: "", type: "Fabric", composition: "", weight: "", width: "",
    color: "", supplier: "", unitPrice: 0, moq: "", leadTime: "",
    certifications: [], notes: "", createdAt: "2026-01-01", ...over,
  };
}

describe("filterMaterials", () => {
  const seed = [
    mat({ id: "a", name: "Cotton Twill",    type: "Fabric",  supplier: "MillCo",   composition: "100% Cotton" }),
    mat({ id: "b", name: "Polyester Twill", type: "Fabric",  supplier: "WeaveInc", composition: "100% Polyester" }),
    mat({ id: "c", name: "YKK Zipper",      type: "Trim",    supplier: "YKK",      composition: "Metal" }),
    mat({ id: "d", name: "Hangtag",         type: "Label",   supplier: "PaperCo",  composition: "Recycled paper" }),
  ];

  it("returns everything when filter is empty", () => {
    expect(filterMaterials(seed, { type: "", search: "" }).map(m => m.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("filters by type", () => {
    expect(filterMaterials(seed, { type: "Fabric", search: "" }).map(m => m.id)).toEqual(["a", "b"]);
    expect(filterMaterials(seed, { type: "Trim",   search: "" }).map(m => m.id)).toEqual(["c"]);
  });

  it("free-text matches name / supplier / composition (case-insensitive)", () => {
    expect(filterMaterials(seed, { type: "", search: "twill"   }).map(m => m.id)).toEqual(["a", "b"]);
    expect(filterMaterials(seed, { type: "", search: "ykk"     }).map(m => m.id)).toEqual(["c"]);
    expect(filterMaterials(seed, { type: "", search: "polyester" }).map(m => m.id)).toEqual(["b"]);
    expect(filterMaterials(seed, { type: "", search: "PAPER"   }).map(m => m.id)).toEqual(["d"]);
  });

  it("type + search AND together", () => {
    expect(filterMaterials(seed, { type: "Fabric", search: "polyester" }).map(m => m.id)).toEqual(["b"]);
  });

  it("treats null/undefined search like empty", () => {
    expect(filterMaterials(seed, { type: "",       search: null      }).length).toBe(seed.length);
    expect(filterMaterials(seed, { type: "Fabric", search: undefined }).length).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────

function ss(over: Partial<SpecSheet> = {}): SpecSheet {
  return {
    id: "x", styleName: "", styleNumber: "", brand: "", season: "",
    category: "", description: "", sizes: [], rows: [],
    createdAt: "2026-01-01", updatedAt: "2026-01-01", ...over,
  };
}

describe("filterSpecSheets", () => {
  const seed = [
    ss({ id: "a", styleName: "Edge Slim",  styleNumber: "100", brand: "ROF"   }),
    ss({ id: "b", styleName: "Bartram",     styleNumber: "200", brand: "Other" }),
    ss({ id: "c", styleName: "Edge Wide",  styleNumber: "300", brand: "ROF"   }),
  ];

  it("returns everything (as a fresh copy) when query is empty/whitespace/null", () => {
    const out1 = filterSpecSheets(seed, "");
    const out2 = filterSpecSheets(seed, "   ");
    const out3 = filterSpecSheets(seed, null);
    expect(out1).toEqual(seed);
    expect(out2).toEqual(seed);
    expect(out3).toEqual(seed);
    expect(out1).not.toBe(seed); // new array — caller can mutate safely
  });

  it("matches styleName (case-insensitive substring)", () => {
    expect(filterSpecSheets(seed, "edge").map(s => s.id)).toEqual(["a", "c"]);
  });

  it("matches styleNumber", () => {
    expect(filterSpecSheets(seed, "200").map(s => s.id)).toEqual(["b"]);
  });

  it("matches brand", () => {
    expect(filterSpecSheets(seed, "rof").map(s => s.id)).toEqual(["a", "c"]);
  });

  it("returns [] when no match", () => {
    expect(filterSpecSheets(seed, "missing")).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("uniqueBrands / uniqueSeasons", () => {
  const seed = [
    tp({ brand: "ROF",     season: "SS26" }),
    tp({ brand: "Other",   season: "SS26" }),
    tp({ brand: "ROF",     season: "FW26" }),
    tp({ brand: "",        season: "" }),    // blanks filtered out
    tp({ brand: "AAA",     season: "Resort 2026" }),
  ];

  it("uniqueBrands returns sorted unique non-empty list", () => {
    expect(uniqueBrands(seed)).toEqual(["AAA", "Other", "ROF"]);
  });

  it("uniqueSeasons returns sorted unique non-empty list", () => {
    expect(uniqueSeasons(seed)).toEqual(["FW26", "Resort 2026", "SS26"]);
  });

  it("both handle empty input", () => {
    expect(uniqueBrands([])).toEqual([]);
    expect(uniqueSeasons([])).toEqual([]);
  });
});
