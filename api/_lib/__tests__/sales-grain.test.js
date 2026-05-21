// Tests for the sales-grain helper module — the inference rule + the
// cost-grain rule + margin/cogs math that every nightly run leans on.
// Pure functions, no DB.

import { describe, it, expect } from "vitest";
import {
  inferQtyGrain,
  toQtyUnits,
  computeRowMargin,
  resolvePerUnitCost,
  deriveSalesGrainFields,
  findSiblingPpkMaster,
  pickReferenceUnitPrice,
  detectPackPricedAsUnit,
  isChargebackReversalRow,
  SUSPICIOUS_PRICE_RATIO,
} from "../sales-grain.js";

describe("inferQtyGrain", () => {
  describe("non-prepacks (pack_size <= 1)", () => {
    it("returns 'unit' for any item with pack_size 1", () => {
      expect(inferQtyGrain("RBB1234-RED-L", 1)).toBe("unit");
      expect(inferQtyGrain("RBB1234-PPK-RED", 1)).toBe("unit");
    });
    it("returns 'unit' when pack_size is null/undefined/0", () => {
      expect(inferQtyGrain("RYG1768PPK", null)).toBe("unit");
      expect(inferQtyGrain("RYG1768PPK", undefined)).toBe("unit");
      expect(inferQtyGrain("RYG1768PPK", 0)).toBe("unit");
    });
  });

  describe("prepacks (pack_size > 1)", () => {
    it("returns 'pack' when PPK is in the style code (modern prepacks)", () => {
      expect(inferQtyGrain("RYG1768PPK", 81)).toBe("pack");
      expect(inferQtyGrain("RYG1768PPK-Black", 81)).toBe("pack");
      expect(inferQtyGrain("RYB0412PPK24-RED-XL", 24)).toBe("pack");
    });
    it("returns 'pack' when PPK is in the size suffix (legacy prepacks)", () => {
      expect(inferQtyGrain("RYG0123-Black-PPK24", 24)).toBe("pack");
      expect(inferQtyGrain("ABC-RED-PPK", 18)).toBe("pack");
      expect(inferQtyGrain("ABC_RED_PPK6", 6)).toBe("pack");
    });
    it("returns 'unit' for a prepack-master line sold as a size variant (PPK token absent)", () => {
      expect(inferQtyGrain("RYG1768-Black-XL", 24)).toBe("unit");
      expect(inferQtyGrain("RYB0412-Red-M", 24)).toBe("unit");
    });
    it("is case-insensitive on the PPK token", () => {
      expect(inferQtyGrain("ryg1768ppk", 81)).toBe("pack");
      expect(inferQtyGrain("RYG1768Ppk-Black", 81)).toBe("pack");
    });
    it("does NOT match PPK embedded in a longer word (e.g. APPKEEPER)", () => {
      expect(inferQtyGrain("APPKEEPER-RED-L", 24)).toBe("unit");
    });
  });

  it("returns 'unit' for empty / missing Item Number", () => {
    expect(inferQtyGrain(null, 24)).toBe("unit");
    expect(inferQtyGrain(undefined, 24)).toBe("unit");
    expect(inferQtyGrain("", 24)).toBe("unit");
  });
});

describe("toQtyUnits", () => {
  it("multiplies by pack_size for pack-grain rows", () => {
    expect(toQtyUnits(20, "pack", 81)).toBe(1620);
    expect(toQtyUnits(5, "pack", 24)).toBe(120);
  });
  it("returns qty as-is for unit-grain rows", () => {
    expect(toQtyUnits(1620, "unit", 81)).toBe(1620);
    expect(toQtyUnits(100, "unit", 1)).toBe(100);
  });
  it("treats missing pack_size as 1 (no inflation)", () => {
    expect(toQtyUnits(50, "pack", null)).toBe(50);
    expect(toQtyUnits(50, "pack", undefined)).toBe(50);
    expect(toQtyUnits(50, "pack", 0)).toBe(50);
  });
  it("coerces string qty + handles negatives", () => {
    expect(toQtyUnits("20", "pack", 24)).toBe(480);
    expect(toQtyUnits(-5, "pack", 24)).toBe(-120);
  });
});

describe("computeRowMargin", () => {
  it("computes amount + pct for valid inputs", () => {
    const m = computeRowMargin({ netAmount: 700, qtyUnits: 100, perUnitCost: 5 });
    expect(m.amount).toBe(200);
    expect(m.pct).toBeCloseTo(0.2857, 4);
  });
  it("handles zero margin (sale at cost)", () => {
    const m = computeRowMargin({ netAmount: 100, qtyUnits: 20, perUnitCost: 5 });
    expect(m.amount).toBe(0);
    expect(m.pct).toBe(0);
  });
  it("handles negative margin (sale below cost)", () => {
    const m = computeRowMargin({ netAmount: 80, qtyUnits: 20, perUnitCost: 5 });
    expect(m.amount).toBe(-20);
    expect(m.pct).toBeCloseTo(-0.25, 5);
  });
  it("returns null fields when netAmount is zero or negative", () => {
    expect(computeRowMargin({ netAmount: 0,   qtyUnits: 10, perUnitCost: 1 })).toEqual({ amount: null, pct: null });
    expect(computeRowMargin({ netAmount: -10, qtyUnits: 10, perUnitCost: 1 })).toEqual({ amount: null, pct: null });
  });
  it("returns null fields when any input is missing / non-numeric", () => {
    expect(computeRowMargin({ netAmount: null, qtyUnits: 10,   perUnitCost: 1 })).toEqual({ amount: null, pct: null });
    expect(computeRowMargin({ netAmount: 100,  qtyUnits: null, perUnitCost: 1 })).toEqual({ amount: null, pct: null });
    expect(computeRowMargin({ netAmount: 100,  qtyUnits: 10,   perUnitCost: null })).toEqual({ amount: null, pct: null });
    expect(computeRowMargin({ netAmount: 100,  qtyUnits: 10,   perUnitCost: NaN })).toEqual({ amount: null, pct: null });
  });
});

describe("resolvePerUnitCost", () => {
  it("divides per-pack master cost by pack_size for pack-grain sales", () => {
    const c = resolvePerUnitCost({
      masterUnitCost: 240, packSize: 60, grain: "pack",
      netAmount: 4800, qtyUnits: 1200,
    });
    expect(c).toBeCloseTo(4, 5);
  });

  it("uses master cost as-is for unit-grain sales with plausible cost vs price", () => {
    const c = resolvePerUnitCost({
      masterUnitCost: 5, packSize: 1, grain: "unit",
      netAmount: 87.5, qtyUnits: 10,
    });
    expect(c).toBe(5);
  });

  it("divides per-pack master cost by pack_size for unit-grain sale when master cost > 2x unit price", () => {
    // Variant SKU mis-tagged with pack_size=24, master cost $158 (per-pack).
    // Sold at $8.75/unit. 158 > 8.75*2 -> divide.
    const c = resolvePerUnitCost({
      masterUnitCost: 158, packSize: 24, grain: "unit",
      netAmount: 87.5, qtyUnits: 10,
    });
    expect(c).toBeCloseTo(158 / 24, 5);
  });

  it("uses master cost as-is when cost just slightly above price (within 2x threshold)", () => {
    const c = resolvePerUnitCost({
      masterUnitCost: 10, packSize: 24, grain: "unit",
      netAmount: 70, qtyUnits: 10,
    });
    expect(c).toBe(10);
  });

  it("falls back to as-is when sale price is missing / non-positive (can't sanity-check)", () => {
    const c = resolvePerUnitCost({
      masterUnitCost: 158, packSize: 24, grain: "unit",
      netAmount: null, qtyUnits: 0,
    });
    expect(c).toBe(158);
  });

  it("returns null when master cost is missing or non-numeric", () => {
    expect(resolvePerUnitCost({ masterUnitCost: null, packSize: 1, grain: "unit", netAmount: 10, qtyUnits: 1 })).toBe(null);
    expect(resolvePerUnitCost({ masterUnitCost: undefined, packSize: 1, grain: "unit", netAmount: 10, qtyUnits: 1 })).toBe(null);
    expect(resolvePerUnitCost({ masterUnitCost: "not a number", packSize: 1, grain: "unit", netAmount: 10, qtyUnits: 1 })).toBe(null);
  });

  it("returns null when master cost is zero (data quality gap, not a free-cost good)", () => {
    expect(resolvePerUnitCost({ masterUnitCost: 0, packSize: 1, grain: "unit", netAmount: 10, qtyUnits: 1 })).toBe(null);
    expect(resolvePerUnitCost({ masterUnitCost: 0, packSize: 60, grain: "pack", netAmount: 4800, qtyUnits: 1200 })).toBe(null);
  });

  it("returns null when master cost is negative (impossible — treat as missing)", () => {
    expect(resolvePerUnitCost({ masterUnitCost: -1, packSize: 1, grain: "unit", netAmount: 10, qtyUnits: 1 })).toBe(null);
  });
});

describe("deriveSalesGrainFields — zero-cost suppression", () => {
  it("suppresses cogs/margin when master.unit_cost is 0 (the RCB0975N-* 100% margin pollution)", () => {
    const r = deriveSalesGrainFields({
      rawItemNumber: "RCB0975N-GREY",
      qty: 736,
      netAmount: 4674,
      master: { pack_size: 60, unit_cost: 0 },
    });
    expect(r.qty_grain).toBe("unit");
    expect(r.qty_units).toBe(736);
    expect(r.unit_cost_at_sale).toBe(null);
    expect(r.cogs_amount).toBe(null);
    expect(r.margin_amount).toBe(null);
    expect(r.margin_pct).toBe(null);
  });
});

describe("deriveSalesGrainFields", () => {
  // The screenshot scenario: RYG1768PPK, pack_size=60, master $240/pack ($4/unit).
  // LY row: 20 PACKS at $240/pack = $4,800.
  it("normalises pack-grain Xoro line + persists cogs (the LY case)", () => {
    const r = deriveSalesGrainFields({
      rawItemNumber: "RYG1768PPK-Black",
      qty: 20,
      netAmount: 4800,
      master: { pack_size: 60, unit_cost: 240 },
    });
    expect(r.qty_grain).toBe("pack");
    expect(r.qty_units).toBe(1200);
    expect(r.unit_cost_at_sale).toBeCloseTo(4, 5);
    expect(r.cogs_amount).toBeCloseTo(4800, 2);
    expect(r.margin_amount).toBeCloseTo(0, 2);
    expect(r.margin_pct).toBeCloseTo(0, 4);
  });

  it("preserves unit-grain Xoro line + computes cogs (the TY case)", () => {
    const r = deriveSalesGrainFields({
      rawItemNumber: "RYG1768-Black-XL",
      qty: 1200,
      netAmount: 4800,
      master: { pack_size: 60, unit_cost: 4 },
    });
    expect(r.qty_grain).toBe("unit");
    expect(r.qty_units).toBe(1200);
    expect(r.unit_cost_at_sale).toBe(4);
    expect(r.cogs_amount).toBe(4800);
    expect(r.margin_amount).toBeCloseTo(0, 2);
  });

  // The anomaly from the spot-check: variant sku tagged pack_size=24
  // but actually unit-grain with master cost stored at per-unit grain.
  // Smart cost rule avoids the spurious 96.87% margin.
  it("handles the unit-grain anomaly: variant SKU, pack_size>1 mis-tag, per-unit master cost", () => {
    const r = deriveSalesGrainFields({
      rawItemNumber: "RYB059430-ALGAE-DARKWASH",
      qty: 4078,
      netAmount: 35682.50,
      master: { pack_size: 24, unit_cost: 6.58 },
    });
    expect(r.qty_grain).toBe("unit");
    expect(r.qty_units).toBe(4078);
    expect(r.unit_cost_at_sale).toBe(6.58);
    expect(r.cogs_amount).toBeCloseTo(4078 * 6.58, 2);
    expect(r.margin_amount).toBeCloseTo(35682.50 - 4078 * 6.58, 2);
    expect(r.margin_pct).toBeGreaterThan(0.20);
    expect(r.margin_pct).toBeLessThan(0.30);
  });

  it("handles the converse anomaly: unit-grain sale with per-pack master cost (sanity check divides)", () => {
    const r = deriveSalesGrainFields({
      rawItemNumber: "RYB059430-LOOSE-XL",
      qty: 100,
      netAmount: 800,
      master: { pack_size: 24, unit_cost: 158 },
    });
    expect(r.qty_grain).toBe("unit");
    expect(r.unit_cost_at_sale).toBeCloseTo(158 / 24, 5);
    expect(r.cogs_amount).toBeCloseTo(100 * (158 / 24), 2);
  });

  it("returns 'unit' grain + qty_units=qty for non-prepacks", () => {
    const r = deriveSalesGrainFields({
      rawItemNumber: "RBB1234-RED-L",
      qty: 12,
      netAmount: 360,
      master: { pack_size: 1, unit_cost: 15 },
    });
    expect(r.qty_grain).toBe("unit");
    expect(r.qty_units).toBe(12);
    expect(r.unit_cost_at_sale).toBe(15);
    expect(r.cogs_amount).toBe(180);
    expect(r.margin_amount).toBe(180);
    expect(r.margin_pct).toBeCloseTo(0.5, 4);
  });

  it("returns nulls for cost-dependent fields when master.unit_cost is missing", () => {
    const r = deriveSalesGrainFields({
      rawItemNumber: "RBB1234-RED-L",
      qty: 12,
      netAmount: 360,
      master: { pack_size: 1, unit_cost: null },
    });
    expect(r.qty_grain).toBe("unit");
    expect(r.qty_units).toBe(12);
    expect(r.unit_cost_at_sale).toBe(null);
    expect(r.cogs_amount).toBe(null);
    expect(r.margin_amount).toBe(null);
    expect(r.margin_pct).toBe(null);
  });

  it("survives a null master (e.g. item not in master cache yet)", () => {
    const r = deriveSalesGrainFields({
      rawItemNumber: "NEWITEM-X",
      qty: 5,
      netAmount: 50,
      master: null,
    });
    expect(r.qty_grain).toBe("unit");
    expect(r.qty_units).toBe(5);
    expect(r.unit_cost_at_sale).toBe(null);
    expect(r.cogs_amount).toBe(null);
    expect(r.margin_amount).toBe(null);
    expect(r.margin_pct).toBe(null);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Pack-priced-as-unit detector — operator-reported bug where Xoro codes
// a wholesale prepack line under the unit-grain SKU (e.g. 131 packs of
// 18 jackets recorded as 131 jackets at $222.30/unit). False-positive
// protection is critical: any honest unit-grain sale at an elevated
// price must NOT be reclassified.
// ────────────────────────────────────────────────────────────────────────

describe("findSiblingPpkMaster", () => {
  function masterMap(rows) {
    const m = new Map();
    for (const r of rows) m.set(r.sku_code, r);
    return m;
  }

  it("finds the variant PPK sibling for a unit-grain color-coded SKU", () => {
    const masters = masterMap([
      { sku_code: "RYO0658-BLACK/BIRCH",     style_code: "RYO0658",    pack_size: 1,  unit_cost: 10 },
      { sku_code: "RYO0658PPK-BLACK/BIRCH", style_code: "RYO0658PPK", pack_size: 18, unit_cost: 180 },
    ]);
    const unit = masters.get("RYO0658-BLACK/BIRCH");
    const sibling = findSiblingPpkMaster(unit, masters);
    expect(sibling?.sku_code).toBe("RYO0658PPK-BLACK/BIRCH");
    expect(sibling?.pack_size).toBe(18);
  });

  it("finds the bare PPK sibling when sku_code has no variant suffix", () => {
    const masters = masterMap([
      { sku_code: "RYO0658",    style_code: "RYO0658",    pack_size: 1,  unit_cost: 10 },
      { sku_code: "RYO0658PPK", style_code: "RYO0658PPK", pack_size: 18, unit_cost: 180 },
    ]);
    const sibling = findSiblingPpkMaster(masters.get("RYO0658"), masters);
    expect(sibling?.sku_code).toBe("RYO0658PPK");
  });

  it("returns null when no PPK sibling exists", () => {
    const masters = masterMap([
      { sku_code: "PLAIN-SKU", style_code: "PLAIN", pack_size: 1, unit_cost: 5 },
    ]);
    expect(findSiblingPpkMaster(masters.get("PLAIN-SKU"), masters)).toBeNull();
  });

  it("returns null when sibling exists but has pack_size <= 1 (data quality)", () => {
    const masters = masterMap([
      { sku_code: "X",    style_code: "X",    pack_size: 1, unit_cost: 5 },
      { sku_code: "XPPK", style_code: "XPPK", pack_size: 1, unit_cost: 5 }, // mis-tagged sibling
    ]);
    expect(findSiblingPpkMaster(masters.get("X"), masters)).toBeNull();
  });

  it("returns null when the unit master is missing required fields", () => {
    expect(findSiblingPpkMaster(null, new Map())).toBeNull();
    expect(findSiblingPpkMaster({ sku_code: "X" }, new Map())).toBeNull();
    expect(findSiblingPpkMaster({ style_code: "X" }, new Map())).toBeNull();
  });
});

describe("pickReferenceUnitPrice", () => {
  it("returns the median of reasonable prices (between cost and SUSPICIOUS_PRICE_RATIO × cost)", () => {
    // cost = $10, SUSPICIOUS_PRICE_RATIO = 5 → reasonable band [10, 50]
    expect(pickReferenceUnitPrice([12.35, 12.35, 35.70], 10)).toBe(12.35);
  });

  it("filters out pack-priced outliers above the reasonable band", () => {
    // $222.30 is in the data but outside [10, 50] band → excluded
    expect(pickReferenceUnitPrice([12.35, 222.30, 12.35], 10)).toBe(12.35);
  });

  it("returns null when no historical prices fall in the reasonable band", () => {
    // All prices are pack-priced ($222.30 way above 5×$10 cap)
    expect(pickReferenceUnitPrice([222.30, 222.30, 222.30], 10)).toBeNull();
  });

  it("returns null when masterUnitCost is missing or zero", () => {
    expect(pickReferenceUnitPrice([12.35], 0)).toBeNull();
    expect(pickReferenceUnitPrice([12.35], null)).toBeNull();
    expect(pickReferenceUnitPrice([12.35], undefined)).toBeNull();
  });

  it("returns null on empty / non-array input", () => {
    expect(pickReferenceUnitPrice([], 10)).toBeNull();
    expect(pickReferenceUnitPrice(null, 10)).toBeNull();
  });

  it("medians a 2-row dataset by averaging the pair", () => {
    expect(pickReferenceUnitPrice([12.00, 14.00], 10)).toBe(13);
  });
});

describe("detectPackPricedAsUnit — false-positive protection", () => {
  function masters() {
    const m = new Map();
    m.set("RYO0658-BLACK/BIRCH",     { sku_code: "RYO0658-BLACK/BIRCH",     style_code: "RYO0658",    pack_size: 1,  unit_cost: 10 });
    m.set("RYO0658PPK-BLACK/BIRCH", { sku_code: "RYO0658PPK-BLACK/BIRCH", style_code: "RYO0658PPK", pack_size: 18, unit_cost: 180 });
    return m;
  }
  const unitMaster = masters().get("RYO0658-BLACK/BIRCH");

  it("RECLASSIFIES the operator's smoking-gun row (131 @ $222.30 with $12.35 history)", () => {
    const sibling = detectPackPricedAsUnit({
      candidateUnitPrice: 222.30,
      unitMaster,
      masterByCode: masters(),
      historicalUnitPrices: [12.35, 12.35],
    });
    expect(sibling?.sku_code).toBe("RYO0658PPK-BLACK/BIRCH");
  });

  it("does NOT reclassify when the price ratio is off (e.g. ~12× cost but not divisible by pack_size)", () => {
    // $200 is suspicious (20× cost) but $200/18 = $11.11 doesn't match the $12.35 reference within 5%
    const sibling = detectPackPricedAsUnit({
      candidateUnitPrice: 200,
      unitMaster,
      masterByCode: masters(),
      historicalUnitPrices: [12.35, 12.35],
    });
    expect(sibling).toBeNull();
  });

  it("does NOT reclassify a normal retail sale at 3.5× cost (below suspicious threshold)", () => {
    const sibling = detectPackPricedAsUnit({
      candidateUnitPrice: 35.70,
      unitMaster,
      masterByCode: masters(),
      historicalUnitPrices: [35.70, 33.90],
    });
    expect(sibling).toBeNull();
  });

  it("does NOT reclassify when no reference history exists (false-positive safety)", () => {
    const sibling = detectPackPricedAsUnit({
      candidateUnitPrice: 222.30,
      unitMaster,
      masterByCode: masters(),
      historicalUnitPrices: [],
    });
    expect(sibling).toBeNull();
  });

  it("does NOT reclassify when ALL history is also pack-priced (no reasonable reference)", () => {
    // Recursive safety: if every prior row for this customer/sku is at the
    // pack price, we can't establish a unit-price reference. Skip — better
    // to leave the data as-is than to confidently mis-classify.
    const sibling = detectPackPricedAsUnit({
      candidateUnitPrice: 222.30,
      unitMaster,
      masterByCode: masters(),
      historicalUnitPrices: [222.30, 222.30, 222.30],
    });
    expect(sibling).toBeNull();
  });

  it("does NOT reclassify when no PPK sibling exists", () => {
    const m = new Map();
    m.set("PLAIN-SKU", { sku_code: "PLAIN-SKU", style_code: "PLAIN", pack_size: 1, unit_cost: 10 });
    const sibling = detectPackPricedAsUnit({
      candidateUnitPrice: 222.30,
      unitMaster: m.get("PLAIN-SKU"),
      masterByCode: m,
      historicalUnitPrices: [12.35],
    });
    expect(sibling).toBeNull();
  });

  it("does NOT reclassify when the unit master is already pack-grain (pack_size > 1)", () => {
    const m = new Map();
    m.set("RYO0658PPK", { sku_code: "RYO0658PPK", style_code: "RYO0658PPK", pack_size: 18, unit_cost: 180 });
    const sibling = detectPackPricedAsUnit({
      candidateUnitPrice: 222.30,
      unitMaster: m.get("RYO0658PPK"),
      masterByCode: m,
      historicalUnitPrices: [180],
    });
    expect(sibling).toBeNull();
  });

  it("does NOT reclassify when master.unit_cost is missing (can't gauge suspicion)", () => {
    const m = masters();
    m.set("X-NOCOST", { sku_code: "X-NOCOST", style_code: "X", pack_size: 1, unit_cost: null });
    m.set("XPPK-NOCOST", { sku_code: "XPPK-NOCOST", style_code: "XPPK", pack_size: 18, unit_cost: null });
    const sibling = detectPackPricedAsUnit({
      candidateUnitPrice: 222.30,
      unitMaster: m.get("X-NOCOST"),
      masterByCode: m,
      historicalUnitPrices: [12.35],
    });
    expect(sibling).toBeNull();
  });

  it("RECLASSIFIES when the price matches within the 5% tolerance band but not exactly", () => {
    // ref × pack = $12.35 × 18 = $222.30; ±5% = [$211.19, $233.42]
    expect(
      detectPackPricedAsUnit({
        candidateUnitPrice: 215,
        unitMaster,
        masterByCode: masters(),
        historicalUnitPrices: [12.35],
      })?.sku_code,
    ).toBe("RYO0658PPK-BLACK/BIRCH");
    expect(
      detectPackPricedAsUnit({
        candidateUnitPrice: 230,
        unitMaster,
        masterByCode: masters(),
        historicalUnitPrices: [12.35],
      })?.sku_code,
    ).toBe("RYO0658PPK-BLACK/BIRCH");
  });

  it("does NOT reclassify just outside the 5% tolerance band", () => {
    // $200 / $222.30 → 10% off → outside the ±5% band
    expect(
      detectPackPricedAsUnit({
        candidateUnitPrice: 200,
        unitMaster,
        masterByCode: masters(),
        historicalUnitPrices: [12.35],
      }),
    ).toBeNull();
  });
});

describe("isChargebackReversalRow", () => {
  it("matches the three known chargeback-reversal SKUs from the Xoro feed", () => {
    expect(isChargebackReversalRow("ROSSCBREVERSAL", "Ross CB Reversal")).toBe(true);
    expect(isChargebackReversalRow("MACYCBREVERSAL", "Macy CB Reversal")).toBe(true);
    expect(isChargebackReversalRow("HERITAGESURFCBREVERSAL", "Heritage Surf CB Reversal")).toBe(true);
  });

  it("requires BOTH item number and description to match — neither alone is enough", () => {
    expect(isChargebackReversalRow("ROSSCBREVERSAL", "Some real item")).toBe(false);
    expect(isChargebackReversalRow("RYO0658-BLACK", "Customer-issued reversal")).toBe(false);
  });

  it("ignores legit SKUs even when the description mentions reversal", () => {
    expect(isChargebackReversalRow("RYB1239-BLACK", "Returns / reversal handling kit")).toBe(false);
  });

  it("handles null and undefined inputs without throwing", () => {
    expect(isChargebackReversalRow(null, null)).toBe(false);
    expect(isChargebackReversalRow(undefined, "Ross CB Reversal")).toBe(false);
    expect(isChargebackReversalRow("ROSSCBREVERSAL", undefined)).toBe(false);
  });
});
