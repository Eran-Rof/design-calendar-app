import { describe, it, expect } from "vitest";
import {
  matchCustomerExact,
  customerCandidates,
  colorPickKey,
  computeColorQuestions,
  buildSeedFromResolved,
  type ParsedPoLine,
  type StyleLite,
} from "../customerPoPrefill";

const CUSTOMERS = [
  { id: "c1", name: "Ross Stores, Inc." },
  { id: "c2", name: "Ross Dress for Less" },
  { id: "c3", name: "Nordstrom Inc" },
  { id: "c4", name: "TJ Maxx" },
];

describe("matchCustomerExact", () => {
  it("matches case-insensitively, exact only", () => {
    expect(matchCustomerExact("ross stores, inc.", CUSTOMERS)).toBe("c1");
  });
  it("does NOT fuzzy-match", () => {
    expect(matchCustomerExact("Ross Stores", CUSTOMERS)).toBeNull();
    expect(matchCustomerExact("Rosss", CUSTOMERS)).toBeNull();
  });
  it("is null for empty / unknown", () => {
    expect(matchCustomerExact(null, CUSTOMERS)).toBeNull();
    expect(matchCustomerExact("Walmart", CUSTOMERS)).toBeNull();
  });
});

describe("customerCandidates", () => {
  it("ranks prefix/substring matches and returns multiple Ross candidates", () => {
    const cands = customerCandidates("Ross Stores", CUSTOMERS);
    expect(cands.length).toBeGreaterThanOrEqual(1);
    expect(cands[0].id).toBe("c1"); // prefix match wins
    expect(cands.map((c) => c.id)).toContain("c2"); // token overlap "ross"
  });
  it("respects the limit", () => {
    expect(customerCandidates("Ross", CUSTOMERS, 1).length).toBe(1);
  });
  it("is empty for no name / no overlap", () => {
    expect(customerCandidates(null, CUSTOMERS)).toEqual([]);
    expect(customerCandidates("Zzzzz", CUSTOMERS)).toEqual([]);
  });
});

describe("colorPickKey", () => {
  it("lowercases + trims the colour text", () => {
    expect(colorPickKey("RYB0594", "  Media Park ")).toBe("RYB0594|media park");
    expect(colorPickKey("RYB0594", null)).toBe("RYB0594|");
  });
});

const STYLE: StyleLite = { id: "s1", style_code: "RYB0594" };
const line = (over: Partial<ParsedPoLine> = {}): ParsedPoLine => ({
  style_code: "RYB0594", color: null, description: null, unit_price: null,
  total_qty: null, size_breakdown: null, ...over,
});

describe("computeColorQuestions", () => {
  const matrix = async () => ({ sizes: ["S", "M", "L"], colors: ["Media Park- Dark Wash", "Indigo"] });

  it("raises a question when the PO colour fuzzy-maps to a different row", async () => {
    const qs = await computeColorQuestions([{ line: line({ color: "Media Park" }), chosen: STYLE }], matrix);
    expect(qs.length).toBe(1);
    expect(qs[0].styleCode).toBe("RYB0594");
    expect(qs[0].lineColor).toBe("Media Park");
    expect(qs[0].suggested).toBe("Media Park- Dark Wash");
    expect(qs[0].options).toEqual(["Media Park- Dark Wash", "Indigo"]);
  });
  it("does NOT ask when the colour is an exact match", async () => {
    const qs = await computeColorQuestions([{ line: line({ color: "Indigo" }), chosen: STYLE }], matrix);
    expect(qs).toEqual([]);
  });
  it("does NOT ask for a single-colour style", async () => {
    const single = async () => ({ sizes: ["S"], colors: ["Indigo"] });
    const qs = await computeColorQuestions([{ line: line({ color: "Anything" }), chosen: STYLE }], single);
    expect(qs).toEqual([]);
  });
});

describe("buildSeedFromResolved colorPicks", () => {
  const matrix = async () => ({ sizes: ["S", "M", "L"], colors: ["Media Park- Dark Wash", "Indigo"] });

  it("uses the confirmed colour and suppresses the mapped-to warning", async () => {
    const resolved = [{ line: line({ color: "Media Park", total_qty: 24 }), chosen: STYLE }];
    const picks = { [colorPickKey("RYB0594", "Media Park")]: "Indigo" };
    const { sections, warnings } = await buildSeedFromResolved(resolved, matrix, picks);
    // No "mapped to" warning because the operator confirmed the row.
    expect(warnings.some((w) => /mapped to/.test(w.detail))).toBe(false);
    // The cells landed on the confirmed colour.
    const sec = sections.find((s) => s.styleCode === "RYB0594");
    expect(sec).toBeTruthy();
    expect(sec!.cells.every((c) => c.color === "Indigo")).toBe(true);
  });

  it("still warns when no pick is supplied (fuzzy fallback)", async () => {
    const resolved = [{ line: line({ color: "Media Park", total_qty: 24 }), chosen: STYLE }];
    const { warnings } = await buildSeedFromResolved(resolved, matrix);
    expect(warnings.some((w) => /mapped to/.test(w.detail))).toBe(true);
  });
});

describe("buildSeedFromResolved PPK packs vs units", () => {
  // PPK style whose style_code has no digits; the pack token rides on the matrix
  // sizes (as fetchMatrix now surfaces it from the prepack block).
  const PPK: StyleLite = { id: "p1", style_code: "RYB0594PPK" };
  // Real RYB0594PPK has an inseam ("30") on its pack SKUs — the body keys rows by
  // it, so the seeded cell must carry the same inseam or it disappears.
  const ppkMatrix = async () => ({ sizes: ["PPK24"], colors: ["Indigo"], inseams: ["30"] });
  const ppkLine = (over: Partial<ParsedPoLine> = {}): ParsedPoLine => ({
    style_code: "RYB0594PPK", color: "Indigo", description: null, unit_price: 216,
    total_qty: 20, size_breakdown: null, ...over,
  });

  it("seeds the pack count directly when qty_is_packs is true (no division), with the inseam", async () => {
    const resolved = [{ line: ppkLine({ qty_is_packs: true }), chosen: PPK }];
    const { sections, warnings } = await buildSeedFromResolved(resolved, ppkMatrix);
    const sec = sections.find((s) => s.styleCode === "RYB0594PPK");
    expect(sec).toBeTruthy();
    // 20 packs on PPK24 (not 20÷24=1), keyed to the style's inseam "30".
    expect(sec!.cells).toEqual([{ color: "Indigo", size: "PPK24", inseam: "30", qty: 20, unit: "216" }]);
    expect(warnings).toHaveLength(0);
  });

  it("converts units → cartons when qty_is_packs is false", async () => {
    const resolved = [{ line: ppkLine({ qty_is_packs: false, total_qty: 480 }), chosen: PPK }];
    const { sections } = await buildSeedFromResolved(resolved, ppkMatrix);
    const sec = sections.find((s) => s.styleCode === "RYB0594PPK");
    // 480 units ÷ 24/pack = 20 cartons.
    expect(sec!.cells[0]).toMatchObject({ size: "PPK24", qty: 20, inseam: "30" });
  });

  it("no longer fails to size the carton for a no-digit PPK style code", async () => {
    const resolved = [{ line: ppkLine({ qty_is_packs: true }), chosen: PPK }];
    const { warnings } = await buildSeedFromResolved(resolved, ppkMatrix);
    expect(warnings.some((w) => /Couldn't determine the PPK carton/.test(w.detail))).toBe(false);
  });

  it("seeds inseam null when the style has none (non-inseam style)", async () => {
    const flatMatrix = async () => ({ sizes: ["PPK24"], colors: ["Indigo"], inseams: [] });
    const resolved = [{ line: ppkLine({ qty_is_packs: true }), chosen: PPK }];
    const { sections } = await buildSeedFromResolved(resolved, flatMatrix);
    expect(sections[0].cells[0]).toMatchObject({ size: "PPK24", inseam: null, qty: 20 });
  });
});
