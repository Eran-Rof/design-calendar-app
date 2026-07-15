// Tests for the SHADOW perpetual inventory helpers (migration 20261080000000).
import { describe, it, expect } from "vitest";
import {
  sumPerpetual,
  computeDrift,
  tracksTruth,
  summarizeReadiness,
  summarizeCoverage,
  sizeGrainCoveragePct,
  TIE_EPSILON,
} from "../perpetualInventory";

describe("sumPerpetual", () => {
  it("sums signed qty_delta per (item, location, size)", () => {
    const m = sumPerpetual([
      { item_id: "A", location_id: "L1", size: "M", qty_delta: 100, movement_type: "opening" },
      { item_id: "A", location_id: "L1", size: "M", qty_delta: -30, movement_type: "sale" },
      { item_id: "A", location_id: "L1", size: "L", qty_delta: 50, movement_type: "opening" },
      { item_id: "B", location_id: null, size: null, qty_delta: 12, movement_type: "receipt" },
    ]);
    expect(m.get("A|L1|M")).toBe(70);
    expect(m.get("A|L1|L")).toBe(50);
    expect(m.get("B||")).toBe(12);
  });

  it("coerces string/null qty_delta and keeps sizes separate", () => {
    const m = sumPerpetual([
      { item_id: "A", location_id: "L", size: "S", qty_delta: "5" },
      { item_id: "A", location_id: "L", size: "S", qty_delta: null },
      { item_id: "A", location_id: "L", size: "XL", qty_delta: "7" },
    ]);
    expect(m.get("A|L|S")).toBe(5);
    expect(m.get("A|L|XL")).toBe(7);
  });
});

describe("computeDrift / tracksTruth", () => {
  it("drift is signed perp - truth", () => {
    expect(computeDrift(100, 90)).toBe(10);
    expect(computeDrift(90, 100)).toBe(-10);
    expect(computeDrift("100", "100")).toBe(0);
  });
  it("tracks truth within the tie epsilon", () => {
    expect(tracksTruth(100, 100)).toBe(true);
    expect(tracksTruth(100, 100 + TIE_EPSILON / 2)).toBe(true);
    expect(tracksTruth(100, 101)).toBe(false);
  });
});

describe("summarizeReadiness", () => {
  it("scores readiness over REST-covered SKUs only", () => {
    const roll = summarizeReadiness([
      { perp_qty: 100, rest_qty: 100, rest_covered: true, drift_value_cents: 0 },   // tracks
      { perp_qty: 80, rest_qty: 100, rest_covered: true, drift_value_cents: 2000 }, // off by 20
      { perp_qty: 5, rest_qty: null, rest_covered: false, drift_value_cents: 0 },   // not in truth
    ]);
    expect(roll.skusTotal).toBe(3);
    expect(roll.skusCoveredTruth).toBe(2);
    expect(roll.skusTrackingTruth).toBe(1);
    expect(roll.readinessPct).toBe(50); // 1 of 2 covered
    expect(roll.sumAbsDriftVsTruth).toBe(25); // 0 + 20 + 5 (uncovered row still contributes abs drift)
    expect(roll.driftValueCents).toBe(2000);
  });

  it("100% when every covered SKU ties; ignores uncovered from the denominator", () => {
    const roll = summarizeReadiness([
      { perp_qty: 10, rest_qty: 10, rest_covered: true },
      { perp_qty: 10, rest_qty: 10, rest_covered: true },
      { perp_qty: 9, rest_qty: null, rest_covered: false },
    ]);
    expect(roll.readinessPct).toBe(100);
  });

  it("0% readiness when no SKU is REST-covered", () => {
    const roll = summarizeReadiness([{ perp_qty: 5, rest_qty: null, rest_covered: false }]);
    expect(roll.readinessPct).toBe(0);
    expect(roll.skusCoveredTruth).toBe(0);
  });

  it("counts size-flagged rows", () => {
    const roll = summarizeReadiness([
      { perp_qty: 1, rest_qty: 1, rest_covered: true, size_grain_known: false },
      { perp_qty: 1, rest_qty: 1, rest_covered: true, size_grain_known: true },
    ]);
    expect(roll.skusSizeFlagged).toBe(1);
  });

  it("prefers precomputed abs_drift_vs_truth when present", () => {
    const roll = summarizeReadiness([
      { perp_qty: 999, rest_qty: 0, rest_covered: true, abs_drift_vs_truth: 0 },
    ]);
    expect(roll.skusTrackingTruth).toBe(1); // trusts the precomputed 0
    expect(roll.readinessPct).toBe(100);
  });
});

describe("summarizeCoverage / sizeGrainCoveragePct", () => {
  it("splits opening vs incremental and by type", () => {
    const cov = summarizeCoverage([
      { movement_type: "opening", size_grain_known: true },
      { movement_type: "opening", size_grain_known: false },
      { movement_type: "receipt", size_grain_known: true },
      { movement_type: "sale", size_grain_known: true },
    ]);
    expect(cov.movementsTotal).toBe(4);
    expect(cov.movementsOpening).toBe(2);
    expect(cov.movementsIncremental).toBe(2);
    expect(cov.movementsSizeFlagged).toBe(1);
    expect(cov.byType).toEqual({ opening: 2, receipt: 1, sale: 1 });
  });

  it("size-grain coverage pct", () => {
    const cov = summarizeCoverage([
      { movement_type: "opening", size_grain_known: true },
      { movement_type: "opening", size_grain_known: true },
      { movement_type: "opening", size_grain_known: true },
      { movement_type: "opening", size_grain_known: false },
    ]);
    expect(sizeGrainCoveragePct(cov)).toBe(75);
  });

  it("empty ledger is 0% coverage, not NaN", () => {
    expect(sizeGrainCoveragePct(summarizeCoverage([]))).toBe(0);
  });
});
