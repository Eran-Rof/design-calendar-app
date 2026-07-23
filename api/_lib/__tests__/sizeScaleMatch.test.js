import { describe, it, expect } from "vitest";
import { canonToken, bestScaleFor } from "../sizeScaleMatch.js";

// The 8 scales actually defined in the size_scales master (probed 2026-06-04).
const SCALES = [
  { id: "denim",   code: "DENIM-WAIST",    name: "Denim Waist",   sizes: ["28","30","31","32","34","36","38","40","42"] },
  { id: "even",    code: "EVEN-NUM-WAIST", name: "Even Num Waist",sizes: ["28","30","32","34","36","38","40","42"] },
  { id: "infant",  code: "INFANT-MO",      name: "Infant Months", sizes: ["0-3M","3-6M","6-9M","12M","18M","24M"] },
  { id: "kids",    code: "KIDS",           name: "Kids",          sizes: ["XSMALL","SMALL","MEDIUM","LARGE","XLARGE"] },
  { id: "mens",    code: "MENS-S-2XL",     name: "Mens S-2XL",    sizes: ["SMALL","MEDIUM","LARGE","XLARGE","2XLARGE"] },
  { id: "os",      code: "ONE-SIZE",       name: "One Size",      sizes: ["OS"] },
  { id: "toddler", code: "TODDLER",        name: "Toddler",       sizes: ["2T","3T","4T","5T"] },
  { id: "womens",  code: "WOMENS-NUM",     name: "Womens Numeric",sizes: ["0","2","4","6","8","10","12","14","16"] },
];

describe("canonToken", () => {
  it("maps alpha synonyms", () => {
    expect(canonToken("SML")).toEqual(["S"]);
    expect(canonToken("LRG")).toEqual(["L"]);
    expect(canonToken("XLG")).toEqual(["XL"]);
    expect(canonToken("XXL")).toEqual(["2XL"]);
  });
  it("keeps numerics", () => expect(canonToken("32")).toEqual(["32"]));
  it("splits combined tokens into both forms", () => {
    expect(canonToken("L/12").sort()).toEqual(["12", "L"]);
  });
  it("normalises one-size", () => expect(canonToken("One Size")).toEqual(["OS"]));
});

describe("bestScaleFor", () => {
  it("alpha mens run → MENS-S-2XL", () => {
    const r = bestScaleFor(["LRG", "MED", "SML", "XLG"], SCALES, "M");
    expect(r.size_scale_id).toBe("mens");
    expect(r.matched).toBe(4);
  });
  it("women's numeric subset → WOMENS-NUM", () => {
    const r = bestScaleFor(["10", "12", "14", "8"], SCALES, "W");
    expect(r.size_scale_id).toBe("womens");
  });
  it("denim waist with an odd extra size → DENIM-WAIST (best coverage)", () => {
    const r = bestScaleFor(["30", "31", "32", "33", "34", "36"], SCALES, "M");
    expect(r.size_scale_id).toBe("denim");      // covers 5/6; even-num covers 4/6
    expect(r.reason).toBe("best_available");
  });
  it("gender disambiguates KIDS vs MENS on the same S-XL run", () => {
    const kid = bestScaleFor(["S", "M", "L", "XL"], SCALES, "C");
    expect(kid.size_scale_id).toBe("kids");
    const men = bestScaleFor(["S", "M", "L", "XL"], SCALES, "M");
    expect(men.size_scale_id).toBe("mens");
  });
  it("one-size → ONE-SIZE", () => {
    const r = bestScaleFor(["OS"], SCALES, "U");
    expect(r.size_scale_id).toBe("os");
    expect(r.reason).toBe("one_size");
  });
  it("single ambiguous size is left unassigned", () => {
    const r = bestScaleFor(["SML"], SCALES, "M");
    expect(r.size_scale_id).toBeNull();
    expect(r.reason).toBe("too_few_sizes");
  });
  it("a weak 2-size pair is left unassigned (full scale, not single)", () => {
    const r = bestScaleFor(["30", "32"], SCALES, "M");
    expect(r.size_scale_id).toBeNull();
    expect(r.reason).toBe("too_few_sizes");
  });
  it("a 3+ size run is assigned", () => {
    expect(bestScaleFor(["30", "32", "34"], SCALES, "M").size_scale_id).not.toBeNull();
  });
  it("no good numeric match → unassigned", () => {
    const r = bestScaleFor(["4", "5", "6", "7"], SCALES, "C");
    expect(r.size_scale_id).toBeNull();          // only 4,6 overlap WOMENS = 0.5
  });
  it("empty variants → unassigned", () => {
    expect(bestScaleFor([], SCALES, "M").size_scale_id).toBeNull();
  });
  it("combined alpha/numeric still resolves to a scale", () => {
    const r = bestScaleFor(["S/8", "M/10", "L/12", "XL/14"], SCALES, "W");
    expect(r.size_scale_id).not.toBeNull();
  });
});

// 2026-07-21 CEO toddler-scale finding: SKUs spell month sizes 12MO/18MO while
// scales carry 12M/18M — the same size. canonToken now aliases the MO spelling
// to the scale form; and O/S is consulted in ALPHA before the slash-split
// (it used to split into O + S, making every One-Size scale look like it was
// missing its own size — 85 false positives in the scale-gap audit).
describe("canonToken month + O/S aliases", () => {
  it("12MO/18MO/24MO canonicalize to the scale spelling", () => {
    expect(canonToken("12MO")).toEqual(["12M"]);
    expect(canonToken("18mo")).toEqual(["18M"]);
    expect(canonToken("24 MO")).toEqual(["24M"]);
    expect(canonToken("12M")).toEqual(["12M"]);
  });
  it("Toddler Girl scale covers a 12MO/18MO style", () => {
    const tg = { id: "tg", code: "SCALE-00010", name: "Toddler Girl", sizes: ["12M", "18M", "2T", "3T", "4T", "5T"] };
    const r = bestScaleFor(["12MO", "18MO", "2T", "3T", "4T", "5T"], [tg], "C");
    expect(r.size_scale_id).toBe("tg");
  });
  it("O/S resolves as One Size, not O + S", () => {
    expect(canonToken("O/S")).toEqual(["OS"]);
  });
  it("combined tokens still split (L/12 → L + 12)", () => {
    expect(new Set(canonToken("L/12"))).toEqual(new Set(["L", "12"]));
  });
});

// 2026-07-22 CEO scale-gap annotations ("apply all and relink"): the operator
// endorsed a handful of equivalences the canon didn't yet make — the flagged
// SKU token and the scale spell the same size the other way round. SL≡SMALL,
// 3X≡3XLARGE, the 4XL/5XL family (the Mens scale grew a big-and-tall tail), and
// Asst≡Assorted. Kept in lock-step with LETTER_SIZE_CANON (see sizeSortKey test).
describe("canonToken CEO scale-gap aliases (2026-07-22)", () => {
  it("SL canonicalizes to Small", () => expect(canonToken("SL")).toEqual(["S"]));
  it("3X ≡ 3XL ≡ 3XLARGE", () => {
    for (const t of ["3X", "3XL", "3XLARGE", "XXXL"]) expect(canonToken(t)).toEqual(["3XL"]);
  });
  it("the 4XL family ≡ 4XL", () => {
    for (const t of ["4X", "4XL", "4XLARGE", "XXXXL"]) expect(canonToken(t)).toEqual(["4XL"]);
  });
  it("the 5XL family ≡ 5XL", () => {
    for (const t of ["5X", "5XL", "5XLARGE", "XXXXXL"]) expect(canonToken(t)).toEqual(["5XL"]);
  });
  it("2X ≡ 2XL (ALPHA now carries the same short forms as LETTER_SIZE_CANON)", () => {
    for (const t of ["2X", "2XL", "XXL", "2XLARGE"]) expect(canonToken(t)).toEqual(["2XL"]);
  });
  it("Asst ≡ Assorted", () => {
    for (const t of ["Ass", "Asst", "ASSORTED"]) expect(canonToken(t)).toEqual(["ASSORTED"]);
  });
});

describe("bestScaleFor — Mens XS–2XL coverage regression (2026-07-22)", () => {
  // SCALE-00011 grew XSMALL + a 3XLARGE…5XLARGE tail (CEO edit). A style whose
  // SKUs abbreviate those (XS, SL, 3X, 4XL, 5XL) must now be fully covered.
  const mens = {
    id: "mens-xs-5xl", code: "SCALE-00011", name: "Men's XS–2XL",
    sizes: ["XSMALL", "SMALL", "MEDIUM", "LARGE", "XLARGE", "2XLARGE", "3XLARGE", "4XLARGE", "5XLARGE"],
  };
  it("covers XS/SL/M/L/XL/XXL/3X/4XL/5XL abbreviations 100%", () => {
    const r = bestScaleFor(["XS", "SL", "M", "L", "XL", "XXL", "3X", "4XL", "5XL"], [mens], "M");
    expect(r.size_scale_id).toBe("mens-xs-5xl");
    expect(r.reason).toBe("exact_cover");
    expect(r.matched).toBe(9);
  });
  it("Assorted-scale column 'Asst' matches an 'Assorted' SKU (coverage-audit intersection)", () => {
    // The Assorted scale (SCALE-00021) has a single size, so bestScaleFor leaves
    // it unassigned (too_few_sizes) — coverage is what matters: the SKU token and
    // the scale column must canonicalize to the same form.
    expect(canonToken("Assorted")).toEqual(canonToken("Asst"));
    expect(canonToken("Assorted")).toEqual(["ASSORTED"]);
  });
});
