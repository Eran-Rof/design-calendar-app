import { describe, expect, it } from "vitest";
import type { ATSRow } from "../types";
import {
  toUnitGrainCost,
  resolveCostPerUnit,
  hydrateRowsAvgCost,
  emptyCostSourceCounts,
} from "../exportCostCascade";

function row(sku: string, opts: Partial<ATSRow> = {}): ATSRow {
  return {
    sku,
    description: "",
    dates: {},
    freeMap: {},
    onHand: 0,
    onOrder: 0,
    onPO: 0,
    ...opts,
  } as ATSRow;
}

describe("toUnitGrainCost", () => {
  it("divides pack cost by ppkMult for prepacks", () => {
    expect(toUnitGrainCost(136.80, 24)).toBeCloseTo(5.70, 5);
  });

  it("passes through unchanged for non-prepacks (mult <= 1)", () => {
    expect(toUnitGrainCost(5.70, 1)).toBeCloseTo(5.70, 5);
    expect(toUnitGrainCost(5.70, 0)).toBeCloseTo(5.70, 5);
    expect(toUnitGrainCost(5.70, null)).toBeCloseTo(5.70, 5);
    expect(toUnitGrainCost(5.70, undefined)).toBeCloseTo(5.70, 5);
  });

  it("passes through null and non-positive inputs unchanged", () => {
    expect(toUnitGrainCost(null, 24)).toBe(null);
    expect(toUnitGrainCost(0, 24)).toBe(0);
    expect(toUnitGrainCost(-1, 24)).toBe(-1);
  });
});

describe("resolveCostPerUnit", () => {
  it("returns per-unit cost on direct cascade hit", () => {
    const r = resolveCostPerUnit("RYB0412PPK-BLACK", 24, {
      avgCostMap: new Map([["RYB0412PPK-BLACK", 136.80]]),
    });
    expect(r.source).toBe("direct");
    expect(r.cost).toBeCloseTo(5.70, 5);
  });

  it("returns per-unit cost on PO fallback", () => {
    const r = resolveCostPerUnit("RYB0412PPK-NEW", 24, {
      openPoCostsBySku: new Map([["RYB0412PPK-NEW", [144.0, 168.0]]]),
    });
    expect(r.source).toBe("po");
    expect(r.cost).toBeCloseTo(6.50, 5);
  });

  it("passes null/source=unknown through unchanged", () => {
    const r = resolveCostPerUnit("UNKNOWN", 24, {});
    expect(r.cost).toBe(null);
    expect(r.source).toBe("unknown");
  });
});

describe("hydrateRowsAvgCost", () => {
  it("leaves rows with valid avgCost untouched", () => {
    const result = hydrateRowsAvgCost({
      rows: [row("RYB001-Black", { avgCost: 5.0 })],
      avgCostMap: new Map([["RYB001-BLACK", 99]]),
      openPoCostsBySku: new Map(),
    });
    expect(result.hydrated).toBe(0);
    expect(result.needed).toBe(0);
    expect(result.rows[0].avgCost).toBe(5.0);
  });

  it("hydrates a missing-cost row via direct cascade hit", () => {
    const result = hydrateRowsAvgCost({
      rows: [row("RYB001 - Black", { avgCost: 0 })],
      avgCostMap: new Map([["RYB001-BLACK", 7.25]]),
      openPoCostsBySku: new Map(),
    });
    expect(result.hydrated).toBe(1);
    expect(result.needed).toBe(1);
    expect(result.rows[0].avgCost).toBeCloseTo(7.25, 5);
    expect(result.sourceCounts.direct).toBe(1);
  });

  it("applies ppkMult divide for prepack rows", () => {
    const result = hydrateRowsAvgCost({
      rows: [row("RYB0412PPK - Black", { avgCost: 0, ppkMult: 24 })],
      avgCostMap: new Map([["RYB0412PPK-BLACK", 136.80]]),
      openPoCostsBySku: new Map(),
    });
    expect(result.rows[0].avgCost).toBeCloseTo(5.70, 5);
    expect(result.sourceCounts.direct).toBe(1);
  });

  it("uses sibling cascade when SKU itself is missing", () => {
    const result = hydrateRowsAvgCost({
      rows: [
        row("RYB001 - Black", { avgCost: 0 }),
        row("RYB001 - Navy", { avgCost: 5.50 }),
      ],
      avgCostMap: new Map(), // ip_item_avg_cost has nothing
      openPoCostsBySku: new Map(),
    });
    // Black borrows Navy's avgCost via the sibling-step (in-stock rows
    // are auto-merged into the avg-cost map).
    expect(result.rows[0].avgCost).toBeCloseTo(5.50, 5);
    expect(result.sourceCounts.sibling).toBe(1);
  });

  it("falls through to PO when neither direct nor sibling hits", () => {
    const result = hydrateRowsAvgCost({
      rows: [row("RYB999 - New", { avgCost: 0 })],
      avgCostMap: new Map(),
      openPoCostsBySku: new Map([["RYB999-NEW", [4.0, 6.0]]]),
    });
    expect(result.rows[0].avgCost).toBeCloseTo(5.0, 5);
    expect(result.sourceCounts.po).toBe(1);
  });

  it("counts unknown when every cascade step fails", () => {
    const result = hydrateRowsAvgCost({
      rows: [row("MYSTERY", { avgCost: 0 })],
      avgCostMap: new Map(),
      openPoCostsBySku: new Map(),
    });
    // Row passes through unchanged on cascade miss (avgCost stays 0).
    expect(result.rows[0].avgCost).toBe(0);
    expect(result.sourceCounts.unknown).toBe(1);
    expect(result.hydrated).toBe(0);
  });
});

describe("emptyCostSourceCounts", () => {
  it("returns a fresh zeroed counter object", () => {
    const a = emptyCostSourceCounts();
    const b = emptyCostSourceCounts();
    a.direct = 5;
    expect(b.direct).toBe(0); // separate instances
    expect(a).toEqual({ direct: 5, sibling: 0, po: 0, margin: 0, unknown: 0 });
  });
});
