import { describe, it, expect } from "vitest";
import {
  buildFacetRecords, facetOptions, FACET_DIMS, ANY,
  type FacetSelections, type RowLike, type MasterStyleLike,
} from "../filterFacets";

const emptySel: FacetSelections = { customer: [], season: [], category: [], subCat: [], gender: [], style: [], color: [] };
const sel = (p: Partial<FacetSelections>): FacetSelections => ({ ...emptySel, ...p });

const rows: RowLike[] = [
  { customer_id: "ross",  season: "SP26", group_name: "SHORTS", sub_category_name: "DENIM SHORTS", gender: "B", sku_style: "RBB1", sku_code: "RBB1", sku_color: "Black" },
  { customer_id: "ross",  season: "SP26", group_name: "DENIM",  sub_category_name: "DENIM SHORTS", gender: "G", sku_style: "GKD1", sku_code: "GKD1", sku_color: "Light Wash" },
  { customer_id: "burl",  season: "FL26", group_name: "SHORTS", sub_category_name: "CARGO SHORTS", gender: "M", sku_style: "RYB0", sku_code: "RYB0", sku_color: "Charcoal" },
];

describe("buildFacetRecords", () => {
  it("uses rows when the run is built (all dims real)", () => {
    const recs = buildFacetRecords(rows, []);
    expect(recs).toHaveLength(3);
    expect(recs[0].customer).toBe("ross");
    expect(recs[0].color).toBe("Black");
  });

  it("falls back to master styles pre-build with WILDCARD customer + colour", () => {
    const master: MasterStyleLike[] = [
      { style_code: "RBB1", group_name: "SHORTS", sub_category_name: "DENIM SHORTS", gender: "B", season: "SP26" },
    ];
    const recs = buildFacetRecords([], master);
    expect(recs).toHaveLength(1);
    expect(recs[0].customer).toBe(ANY);
    expect(recs[0].color).toBe(ANY);
    expect(recs[0].category).toBe("SHORTS");
  });
});

describe("facetOptions — full interdependence", () => {
  const recs = buildFacetRecords(rows, []);

  it("no selection → every distinct value per dim", () => {
    expect(facetOptions(recs, "category", emptySel).sort()).toEqual(["DENIM", "SHORTS"]);
    expect(facetOptions(recs, "customer", emptySel).sort()).toEqual(["burl", "ross"]);
    expect(facetOptions(recs, "gender", emptySel).sort()).toEqual(["B", "G", "M"]);
  });

  it("selecting a Customer narrows every other dimension (downward)", () => {
    const s = sel({ customer: ["ross"] });
    expect(facetOptions(recs, "category", s).sort()).toEqual(["DENIM", "SHORTS"]);
    expect(facetOptions(recs, "gender", s).sort()).toEqual(["B", "G"]); // no Mens (burl only)
    expect(facetOptions(recs, "season", s)).toEqual(["SP26"]);
  });

  it("selecting a Style narrows Customer too (UPWARD — the any-to-all part)", () => {
    // Only Burlington carries RYB0.
    expect(facetOptions(recs, "customer", sel({ style: ["RYB0"] }))).toEqual(["burl"]);
    // And gender collapses to that style's gender.
    expect(facetOptions(recs, "gender", sel({ style: ["RYB0"] }))).toEqual(["M"]);
  });

  it("selecting Gender narrows Category and Customer", () => {
    expect(facetOptions(recs, "category", sel({ gender: ["M"] }))).toEqual(["SHORTS"]);
    expect(facetOptions(recs, "customer", sel({ gender: ["G"] }))).toEqual(["ross"]);
  });

  it("a dimension's own selection does not constrain its own options", () => {
    // Category options ignore the category selection but honor sub-cat:
    // DENIM SHORTS spans both SHORTS and DENIM categories.
    expect(facetOptions(recs, "category", sel({ category: ["SHORTS"], subCat: ["DENIM SHORTS"] })).sort())
      .toEqual(["DENIM", "SHORTS"]);
  });

  it("combined selections intersect", () => {
    const s = sel({ customer: ["ross"], category: ["SHORTS"] });
    expect(facetOptions(recs, "gender", s)).toEqual(["B"]); // ross + SHORTS → only the boys denim short
    expect(facetOptions(recs, "color", s)).toEqual(["Black"]);
  });
});

describe("facetOptions — pre-build (master, WILDCARD customer/colour)", () => {
  const master: MasterStyleLike[] = [
    { style_code: "RBB1", group_name: "SHORTS", sub_category_name: "DENIM SHORTS", gender: "B", season: "SP26" },
    { style_code: "GKD1", group_name: "DENIM",  sub_category_name: "DENIM SHORTS", gender: "G", season: null },
    { style_code: "RYB0", group_name: "SHORTS", sub_category_name: "CARGO SHORTS", gender: "M", season: null },
  ];
  const recs = buildFacetRecords([], master);

  it("product dims cascade among themselves", () => {
    expect(facetOptions(recs, "gender", sel({ category: ["SHORTS"], subCat: ["DENIM SHORTS"] }))).toEqual(["B"]);
    expect(facetOptions(recs, "subCat", sel({ category: ["SHORTS"] })).sort()).toEqual(["CARGO SHORTS", "DENIM SHORTS"]);
  });

  it("a Customer selection does NOT empty product options pre-build (WILDCARD matches)", () => {
    // No customer info exists yet, so picking one must not blank the products.
    const s = sel({ customer: ["ross"], category: ["SHORTS"] });
    expect(facetOptions(recs, "gender", s).sort()).toEqual(["B", "M"]);
  });

  it("customer + colour yield NO options pre-build (both wildcard)", () => {
    expect(facetOptions(recs, "customer", emptySel)).toEqual([]);
    expect(facetOptions(recs, "color", emptySel)).toEqual([]);
  });
});

describe("null handling", () => {
  it("null dimension values fall in the — bucket and only match a — selection", () => {
    const recs = buildFacetRecords(
      [{ customer_id: "x", season: null, group_name: null, sub_category_name: null, gender: null, sku_style: "S", sku_code: "S", sku_color: null }],
      [],
    );
    expect(facetOptions(recs, "category", emptySel)).toEqual([]); // null not offered as a real option
    expect(facetOptions(recs, "style", sel({ category: ["—"] }))).toEqual(["S"]); // — selection matches the null
    expect(facetOptions(recs, "style", sel({ category: ["SHORTS"] }))).toEqual([]);
  });
});

describe("FACET_DIMS", () => {
  it("covers the seven interdependent filters", () => {
    expect(FACET_DIMS).toEqual(["customer", "season", "category", "subCat", "gender", "style", "color"]);
  });
});
