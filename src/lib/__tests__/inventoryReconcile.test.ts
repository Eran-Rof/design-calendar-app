// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  classifyDivergence,
  severityRank,
  summarizeRows,
  TIE_EPSILON,
  MINOR_MAX,
  type ReconcileRowLike,
} from "../inventoryReconcile";

describe("classifyDivergence", () => {
  it("ties when layers match REST within epsilon", () => {
    const r = classifyDivergence({ layersQty: 100, restQty: 100, restCovered: true });
    expect(r.severity).toBe("tie");
    expect(r.divergence).toBe(0);
    expect(r.isPhantomSuspect).toBe(false);
  });

  it("treats a sub-epsilon rounding gap as a tie", () => {
    const r = classifyDivergence({ layersQty: 100, restQty: 100 - TIE_EPSILON / 2, restCovered: true });
    expect(r.severity).toBe("tie");
  });

  it("classifies a small gap as minor", () => {
    const r = classifyDivergence({ layersQty: 110, restQty: 100, restCovered: true });
    expect(r.severity).toBe("minor");
    expect(r.divergence).toBe(10);
  });

  it("classifies exactly MINOR_MAX as minor (boundary)", () => {
    const r = classifyDivergence({ layersQty: 100 + MINOR_MAX, restQty: 100, restCovered: true });
    expect(r.severity).toBe("minor");
  });

  it("classifies a gap above MINOR_MAX as material", () => {
    const r = classifyDivergence({ layersQty: 100 + MINOR_MAX + 1, restQty: 100, restCovered: true });
    expect(r.severity).toBe("material");
  });

  it("flags phantom-suspect when app shows stock but REST says zero", () => {
    const r = classifyDivergence({ layersQty: 2505, restQty: 0, restCovered: true });
    expect(r.severity).toBe("phantom_suspect");
    expect(r.isPhantomSuspect).toBe(true);
    expect(r.divergence).toBe(2505);
  });

  it("flags phantom-suspect on a stale opening_balance residual even if REST absent", () => {
    const r = classifyDivergence({ layersQty: 12, restQty: null, restCovered: false, hasOpeningResidual: true });
    expect(r.severity).toBe("phantom_suspect");
  });

  it("does NOT flag phantom when REST simply has no coverage (app understates)", () => {
    // layers 0, REST truth 6400 but this SKU is only in REST (not layers-overstate)
    const r = classifyDivergence({ layersQty: 0, restQty: 6400, restCovered: true });
    expect(r.severity).toBe("material");
    expect(r.isPhantomSuspect).toBe(false);
    expect(r.divergence).toBe(-6400);
  });

  it("treats null restQty as zero for divergence", () => {
    const r = classifyDivergence({ layersQty: 50, restQty: null, restCovered: false });
    expect(r.divergence).toBe(50);
    expect(r.severity).toBe("material");
  });
});

describe("severityRank", () => {
  it("orders phantom > material > minor > tie", () => {
    expect(severityRank("phantom_suspect")).toBeGreaterThan(severityRank("material"));
    expect(severityRank("material")).toBeGreaterThan(severityRank("minor"));
    expect(severityRank("minor")).toBeGreaterThan(severityRank("tie"));
  });
});

describe("summarizeRows", () => {
  const rows: ReconcileRowLike[] = [
    { severity: "tie", abs_divergence: 0, divergence_value_cents: 0 },
    { severity: "minor", abs_divergence: 10, divergence_value_cents: 500 },
    { severity: "material", abs_divergence: 6400, divergence_value_cents: 1689600, is_zero_cost: true },
    { severity: "phantom_suspect", abs_divergence: 2505, divergence_value_cents: 2379800, is_negative: false },
    { severity: "material", abs_divergence: "100", divergence_value_cents: "1000", is_zero_cost: true },
  ];

  it("rolls counts and totals up correctly", () => {
    const s = summarizeRows(rows);
    expect(s.skusTotal).toBe(5);
    expect(s.skusTie).toBe(1);
    expect(s.skusMinor).toBe(1);
    expect(s.skusMaterial).toBe(2);
    expect(s.skusPhantom).toBe(1);
    expect(s.skusDivergent).toBe(4); // everything but the tie
    expect(s.sumAbsUnits).toBe(0 + 10 + 6400 + 2505 + 100);
    expect(s.exposureCents).toBe(0 + 500 + 1689600 + 2379800 + 1000);
    expect(s.zeroCostSkus).toBe(2);
    expect(s.negativeSkus).toBe(0);
  });

  it("returns an all-zero rollup for no rows", () => {
    const s = summarizeRows([]);
    expect(s.skusTotal).toBe(0);
    expect(s.exposureCents).toBe(0);
  });
});
