// Regression tests for the PO-grid money grain rule (computePoLineMoney).
//
// The recurring "PPK styles show garbage margins" bug was a GRAIN mismatch: a
// PPK line's price is normalized to per-each, but the reference cost/sell were
// left at pack grain and then multiplied by eaches → a $324/pack cost read as
// $324/each (×ppk inflation, ~98% margins). These tests pin the canonical rule:
// every column is Σ(dollars) / Σ(eaches), with native-grain values weighted by
// qty and per-each (garment-list) values weighted by eaches.

import { describe, it, expect } from "vitest";
import { computePoLineMoney } from "../index.js";

// Helper: aggregate a set of lines the way enrichPricing does, returning the
// per-each column values in cents (or null).
function aggregate(lines) {
  let priceN = 0, priceD = 0, costN = 0, costD = 0, sellN = 0, sellD = 0;
  for (const [line, refs] of lines) {
    const m = computePoLineMoney(line, refs);
    if (!m || !m.linked) continue;
    priceN += m.priceCents; priceD += m.eaches;
    costN += m.costCents; costD += m.eaches;
    if (m.sellCents != null) { sellN += m.sellCents; sellD += m.eaches; }
  }
  return {
    avgPo: priceD > 0 ? Math.round(priceN / priceD) : null,
    avgCost: costD > 0 ? Math.round(costN / costD) : null,
    sell: sellD > 0 ? Math.round(sellN / sellD) : null,
  };
}

describe("computePoLineMoney — grain normalization", () => {
  it("PPK-only PO: pack cost + pack recent-sell collapse to per-EACH (ROF-P001177)", () => {
    // Line 1: 54 packs of PPK60 @ $324/pack, std cost $324/pack, recent sell $405/pack.
    // Line 2: 67 packs of PPK48 @ $273.60/pack, std cost $273.60/pack, recent sell $343.20/pack.
    const { avgPo, avgCost, sell } = aggregate([
      [{ qty_ordered: 54, unit_cost_cents: 32400, ppk: 60, sku_code: "RCB1869NBDPPK-BLACK", style_id: "s1" },
       { stdCost: 32400, recentSell: 40500 }],
      [{ qty_ordered: 67, unit_cost_cents: 27360, ppk: 48, sku_code: "RBB1869NBDPPK-CHARCOAL", style_id: "s2" },
       { stdCost: 27360, recentSell: 34320 }],
    ]);
    // Per-each: Avg PO Price ≈ $5.55, Avg cost ≈ $5.55 (std == PO price), Sell ≈ $6.95.
    expect(avgPo).toBe(555);
    expect(avgCost).toBe(555);
    expect(sell).toBe(695);
    // Margin (sell − PO price)/sell ≈ 20% — NOT the old 98%.
    const marginPct = Math.round(((sell - avgPo) / sell) * 1000) / 10;
    expect(marginPct).toBeGreaterThan(15);
    expect(marginPct).toBeLessThan(25);
  });

  it("loose (non-PPK) line: per-each cost/sell unchanged", () => {
    // 100 eaches @ $7.15, std cost $7.15/each, brand-list sell $9/each.
    const { avgPo, avgCost, sell } = aggregate([
      [{ qty_ordered: 100, unit_cost_cents: 715, ppk: 1, sku_code: "RYB161930-SANDLOT-30", style_id: "s1" },
       { stdCost: 715, brandPrice: 900 }],
    ]);
    expect(avgPo).toBe(715);
    expect(avgCost).toBe(715);
    expect(sell).toBe(900);
  });

  it("brand list on a PPK line is per-PACK → per-each (weighted by qty, not eaches)", () => {
    // A PPK (pack) style's brand-list price IS the pack price. 10 packs of PPK24 @
    // $171.60/pack; brand list $216/pack → $9/each. Weighting by eaches would have
    // read $216 as $216/EACH (the P001133 $65.66 bug).
    const { avgPo, sell } = aggregate([
      [{ qty_ordered: 10, unit_cost_cents: 17160, ppk: 24, sku_code: "X-PPK24", style_id: "s1" },
       { stdCost: 17160, brandPrice: 21600 }],
    ]);
    expect(avgPo).toBe(715);   // $171.60/pack ÷ 24 = $7.15/each
    expect(sell).toBe(900);    // $216/pack ÷ 24 = $9/each (NOT $216/each)
  });

  it("customer price on a PPK line is per-PACK too (weighted by qty)", () => {
    const { sell } = aggregate([
      [{ qty_ordered: 10, unit_cost_cents: 17160, ppk: 24, sku_code: "X-PPK24", style_id: "s1" },
       { stdCost: 17160, custPrice: 24000 }], // $240/pack → $10/each
    ]);
    expect(sell).toBe(1000);
  });

  it("mixed PO (PPK pack line + loose line): blends correctly at per-each grain", () => {
    const { avgPo, avgCost } = aggregate([
      [{ qty_ordered: 10, unit_cost_cents: 17160, ppk: 24, sku_code: "A-PPK24", style_id: "s1" }, { stdCost: 17160 }],
      [{ qty_ordered: 240, unit_cost_cents: 715, ppk: 1, sku_code: "B-30", style_id: "s2" }, { stdCost: 715 }],
    ]);
    // Both resolve to $7.15/each → blended avg is $7.15, not a pack/each mash.
    expect(avgPo).toBe(715);
    expect(avgCost).toBe(715);
  });

  it("unlinked (SKU-less) line is excluded from Avg PO Price + Avg cost", () => {
    const m = computePoLineMoney(
      { qty_ordered: 178, unit_cost_cents: 17160, ppk: 1, sku_code: null, style_id: null },
      { stdCost: null },
    );
    expect(m.linked).toBe(false);
    expect(m.priceCents).toBe(0);
    expect(m.costCents).toBe(0);
  });

  it("Avg cost falls back to the line's own PO price when no std cost resolves", () => {
    const m = computePoLineMoney(
      { qty_ordered: 5, unit_cost_cents: 715, ppk: 1, sku_code: "RYB-SANDLOT-32", style_id: "s1" },
      { stdCost: null },
    );
    expect(m.costCents).toBe(715 * 5); // = poPrice × qty
  });

  it("zero-qty line returns null", () => {
    expect(computePoLineMoney({ qty_ordered: 0, unit_cost_cents: 715, ppk: 1, sku_code: "x" }, {})).toBeNull();
  });
});
