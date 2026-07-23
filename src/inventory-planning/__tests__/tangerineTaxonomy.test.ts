import { describe, it, expect } from "vitest";
import { applyTangerineTaxonomy, taxonomyKey, type TangerineTaxonomy } from "../utils/tangerineTaxonomy";

function tax(entries: Array<[string, { category_name: string | null; sub_category_name: string | null; gender_code?: string | null }]>): TangerineTaxonomy {
  return new Map(entries.map(([k, v]) => [k, { gender_code: null, ...v }]));
}

describe("applyTangerineTaxonomy", () => {
  it("overlays style_master category/sub-cat onto the planning attr keys", () => {
    const items = [
      {
        style_code: "RYB0412",
        attributes: { group_name: "DENIM", category_name: "DENIM SHORTS", gender: "Mens" },
      },
    ];
    const out = applyTangerineTaxonomy(items, tax([
      ["RYB0412", { category_name: "SHORTS", sub_category_name: "TWILL SHORTS" }],
    ]));
    // Planning readers: attrs.group_name = "Category", attrs.category_name = "Sub cat".
    expect(out[0].attributes).toEqual({ group_name: "SHORTS", category_name: "TWILL SHORTS", gender: "Mens" });
  });

  it("keys case-insensitively and trims style codes", () => {
    const items = [{ style_code: "  ryb0412ppk ", attributes: { group_name: "OLD" } }];
    const out = applyTangerineTaxonomy(items, tax([
      ["RYB0412PPK", { category_name: "SHORTS", sub_category_name: "CARGO SHORTS" }],
    ]));
    expect((out[0].attributes as Record<string, unknown>).group_name).toBe("SHORTS");
    expect((out[0].attributes as Record<string, unknown>).category_name).toBe("CARGO SHORTS");
  });

  it("leaves Xoro attributes as fallback when style_master has no row", () => {
    const items = [{ style_code: "NOMATCH1", attributes: { group_name: "TOPS", category_name: "TEES" } }];
    const out = applyTangerineTaxonomy(items, tax([
      ["RYB0412", { category_name: "SHORTS", sub_category_name: "TWILL SHORTS" }],
    ]));
    expect(out[0]).toBe(items[0]); // untouched reference — no needless clone
  });

  it("partial style_master rows overlay only the populated field", () => {
    const items = [{ style_code: "RYB0100", attributes: { group_name: "DENIM", category_name: "SKINNY" } }];
    const out = applyTangerineTaxonomy(items, tax([
      ["RYB0100", { category_name: "PANTS", sub_category_name: null }],
    ]));
    expect(out[0].attributes).toEqual({ group_name: "PANTS", category_name: "SKINNY" });
  });

  it("handles null/absent attributes bags", () => {
    const items = [
      { style_code: "RYB0412", attributes: null },
      { style_code: "RYB0413" },
    ];
    const out = applyTangerineTaxonomy(items as Array<{ style_code: string; attributes?: unknown }>, tax([
      ["RYB0412", { category_name: "SHORTS", sub_category_name: "TWILL SHORTS" }],
      ["RYB0413", { category_name: "SHORTS", sub_category_name: "CARGO SHORTS" }],
    ]));
    expect(out[0].attributes).toEqual({ group_name: "SHORTS", category_name: "TWILL SHORTS" });
    expect(out[1].attributes).toEqual({ group_name: "SHORTS", category_name: "CARGO SHORTS" });
  });

  it("empty taxonomy map is a no-op (fetch-failure fallback)", () => {
    const items = [{ style_code: "RYB0412", attributes: { group_name: "DENIM" } }];
    expect(applyTangerineTaxonomy(items, new Map())).toBe(items);
  });

  it("does not mutate the input items", () => {
    const attrs = { group_name: "DENIM", category_name: "DENIM SHORTS" };
    const items = [{ style_code: "RYB0412", attributes: attrs }];
    applyTangerineTaxonomy(items, tax([
      ["RYB0412", { category_name: "SHORTS", sub_category_name: "TWILL SHORTS" }],
    ]));
    expect(attrs).toEqual({ group_name: "DENIM", category_name: "DENIM SHORTS" });
  });

  it("overlays gender_code onto attrs.gender (Xoro gender absent)", () => {
    // The common real case: 16k+ items have NO gender in Xoro attrs;
    // style_master.gender_code (#1907 prefix trigger) fills it.
    const items = [{ style_code: "RYB0412", attributes: { group_name: "DENIM" } }];
    const out = applyTangerineTaxonomy(items, tax([
      ["RYB0412", { category_name: "SHORTS", sub_category_name: "TWILL SHORTS", gender_code: "M" }],
    ]));
    expect(out[0].attributes).toEqual({ group_name: "SHORTS", category_name: "TWILL SHORTS", gender: "M" });
  });

  it("gender_code wins over a stale Xoro gender attr", () => {
    const items = [{ style_code: "CJB0100", attributes: { gender: "B" } }];
    const out = applyTangerineTaxonomy(items, tax([
      ["CJB0100", { category_name: null, sub_category_name: null, gender_code: "W" }],
    ]));
    expect((out[0].attributes as Record<string, unknown>).gender).toBe("W");
  });

  it("null gender_code keeps the Xoro gender fallback", () => {
    const items = [{ style_code: "RYB0412", attributes: { gender: "M" } }];
    const out = applyTangerineTaxonomy(items, tax([
      ["RYB0412", { category_name: "SHORTS", sub_category_name: null, gender_code: null }],
    ]));
    expect((out[0].attributes as Record<string, unknown>).gender).toBe("M");
  });
});

describe("taxonomyKey", () => {
  it("normalizes null/undefined/whitespace", () => {
    expect(taxonomyKey(null)).toBe("");
    expect(taxonomyKey(undefined)).toBe("");
    expect(taxonomyKey(" ryb0412 ")).toBe("RYB0412");
  });
});
