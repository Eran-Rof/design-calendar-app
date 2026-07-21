// Tests for the tiered layer unit-cost resolver (api/_lib/layerCost.js).
//
// Focus: the 2026-07-21 zero-cost defect class — Xoro costing keys embed the
// inseam in the BasePartNumber (RYB059430-…) while our per-size SKUs are coded
// RYB0594-COLOR-SIZE, so the old exact-code lookup returned $0 for whole denim
// programs. The resolver mirrors the executed backfill's tiers.

import { describe, it, expect } from "vitest";
import { makeCostResolver } from "../layerCost.js";

const AVG = new Map([
  // exact per-size code
  ["RYB0412-GREY-32", 5.72],
  // color-level code (no size suffix)
  ["RYB0412-BLACK", 5.5],
  // inseam-embedded BP program (our SKUs are coded RYB0594-…)
  ["RYB059430-MOISTURE-MEDWASH", 6.57],
  ["RYB059430-LASSO-WASH-DK-WASH-30", 6.57],
  ["RYB059432-BEACHWASH-LTWASH", 6.7],
  // style-prefix-only coverage
  ["ACMB0060-CAMO-LG", 4.0],
  ["ACMB0060-CAMO-XL", 6.0],
  // zero-value costing rows must never win a tier
  ["ZED0001-BLACK-MD", 0],
]);

const resolve = makeCostResolver(AVG);

describe("makeCostResolver tiers", () => {
  it("T1: exact sku_code wins", () => {
    expect(resolve({ skuCode: "RYB0412-GREY-32", styleCode: "RYB0412" })).toBe(572);
  });
  it("T2: falls back to the color-level code (trailing token stripped)", () => {
    expect(resolve({ skuCode: "RYB0412-BLACK-34", styleCode: "RYB0412" })).toBe(550);
  });
  it("T3: inseam-stem average for inseam-embedded costing keys", () => {
    // SKU coded under the parent style; costing lives under RYB059430-…
    const cents = resolve({ skuCode: "RYB0594-MOISTURE-MEDWASH-32-30", styleCode: "RYB0594", inseam: "30" });
    expect(cents).toBe(657); // mean of the two RYB059430-… rows
  });
  it("T3 scopes to THIS inseam (30 vs 32 stems stay distinct)", () => {
    const cents = resolve({ skuCode: "RYB0594-BEACHWASH-LTWASH-34-32", styleCode: "RYB0594", inseam: "32" });
    expect(cents).toBe(670);
  });
  it("T4: style-prefix average when no exact/color/inseam hit", () => {
    expect(resolve({ skuCode: "ACMB0060-NEW-COLOR-SM", styleCode: "ACMB0060" })).toBe(500); // mean(4.00, 6.00)
  });
  it("returns 0 only when the costing mirror has nothing for the style", () => {
    expect(resolve({ skuCode: "NOPE-X-Y", styleCode: "NOPE" })).toBe(0);
  });
  it("zero-value costing rows never satisfy a tier", () => {
    expect(resolve({ skuCode: "ZED0001-BLACK-MD", styleCode: "ZED0001" })).toBe(0);
  });
  it("tolerates null/absent meta", () => {
    expect(resolve(null)).toBe(0);
    expect(resolve({})).toBe(0);
    expect(resolve({ skuCode: null, styleCode: null, inseam: null })).toBe(0);
  });
  it("inseam values are trimmed; blank inseam skips the stem tier", () => {
    expect(resolve({ skuCode: "RYB0594-X-30", styleCode: "RYB0594", inseam: " 30 " })).toBe(657);
    // blank inseam -> falls through to style-prefix average over ALL RYB0594* rows
    const cents = resolve({ skuCode: "RYB0594-X-30", styleCode: "RYB0594", inseam: "" });
    expect(cents).toBe(Math.round(((6.57 + 6.57 + 6.7) / 3) * 100));
  });
});
