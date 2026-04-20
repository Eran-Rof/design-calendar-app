import { describe, it, expect } from "vitest";
import { tokenise, matchesSearch, matchesFilters, rankListings } from "../marketplace.js";

describe("tokenise", () => {
  it("lowercases, drops short / non-alnum noise, splits on whitespace", () => {
    expect(tokenise("CNC Milling, 5-axis a b")).toEqual(["cnc", "milling", "5axis"]);
    expect(tokenise("  ")).toEqual([]);
    expect(tokenise(null)).toEqual([]);
  });
});

describe("matchesSearch", () => {
  const l = { title: "CNC precision milling", description: "5-axis aluminum parts", capabilities: ["titanium", "stainless"] };
  it("matches token in any of title/description/capabilities", () => {
    expect(matchesSearch(l, "cnc")).toBe(true);
    expect(matchesSearch(l, "titanium")).toBe(true);
    expect(matchesSearch(l, "aluminum")).toBe(true);
  });
  it("requires ALL tokens to match somewhere", () => {
    expect(matchesSearch(l, "cnc titanium")).toBe(true);
    expect(matchesSearch(l, "cnc plastic")).toBe(false);
  });
  it("empty query matches everything", () => {
    expect(matchesSearch(l, "")).toBe(true);
    expect(matchesSearch(l, "   ")).toBe(true);
  });
});

describe("matchesFilters", () => {
  const l = { category: "metalwork", certifications: ["ISO9001", "AS9100"], geographic_coverage: ["US", "MX"], min_order_value: 500 };
  it("filters by category", () => {
    expect(matchesFilters(l, { category: "metalwork" })).toBe(true);
    expect(matchesFilters(l, { category: "plastics" })).toBe(false);
  });
  it("requires ALL requested certifications", () => {
    expect(matchesFilters(l, { certifications: ["ISO9001"] })).toBe(true);
    expect(matchesFilters(l, { certifications: ["ISO9001", "AS9100"] })).toBe(true);
    expect(matchesFilters(l, { certifications: ["ISO9001", "B-Corp"] })).toBe(false);
  });
  it("matches ANY requested geography", () => {
    expect(matchesFilters(l, { geographic_coverage: ["EU", "MX"] })).toBe(true);
    expect(matchesFilters(l, { geographic_coverage: ["EU"] })).toBe(false);
  });
  it("min_order_value filter rejects listings whose MOV exceeds the buyer's ceiling", () => {
    expect(matchesFilters(l, { min_order_value: 1000 })).toBe(true);   // 500 ≤ 1000
    expect(matchesFilters(l, { min_order_value: 200 })).toBe(false);  // 500 > 200
  });
});

describe("rankListings", () => {
  const listings = [
    { id: "a", vendor_id: "v1", featured: false, views: 100 },
    { id: "b", vendor_id: "v2", featured: true,  views: 10  },
    { id: "c", vendor_id: "v3", featured: false, views: 50  },
    { id: "d", vendor_id: "v4", featured: false, views: 100 },
  ];
  it("featured first, then views desc, then ESG desc", () => {
    const ranked = rankListings(listings, { v1: 70, v4: 85 });
    expect(ranked.map((l) => l.id)).toEqual(["b", "d", "a", "c"]);
  });
  it("works without any ESG data", () => {
    const ranked = rankListings(listings);
    // b featured, then a & d tied on views (stable on 0/0 ESG — both return 0), then c
    expect(ranked[0].id).toBe("b");
    expect(ranked[ranked.length - 1].id).toBe("c");
  });
});
