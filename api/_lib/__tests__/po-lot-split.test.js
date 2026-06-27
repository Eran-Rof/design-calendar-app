// PO line split by lot, even per-carton (Scenario 4.4).
import { describe, it, expect } from "vitest";
import { splitQtyByCartonEven, splitLinesByLot } from "../inventory/poLotSplit.js";

describe("splitQtyByCartonEven", () => {
  it("splits whole cartons evenly", () => {
    // 120 = 5 cartons of 24 across 2 lots → 3 + 2 cartons = 72 + 48.
    expect(splitQtyByCartonEven(120, 2)).toEqual([72, 48]);
  });

  it("always sums back to the original qty (remainder on first lot)", () => {
    // 100 = 4 cartons (96) + 4 rem; 4 cartons across 3 lots → 2,1,1 → +rem on [0].
    const parts = splitQtyByCartonEven(100, 3);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([2 * 24 + 4, 1 * 24, 1 * 24]);
  });

  it("gives fewer lots cartons when cartons < lots (zeros allowed)", () => {
    expect(splitQtyByCartonEven(72, 5)).toEqual([24, 24, 24, 0, 0]);
  });

  it("respects a custom carton size", () => {
    expect(splitQtyByCartonEven(60, 2, 12)).toEqual([36, 24]); // 5 cartons of 12 → 3+2
  });

  it("returns [] for n<=0 and zeros for qty 0", () => {
    expect(splitQtyByCartonEven(100, 0)).toEqual([]);
    expect(splitQtyByCartonEven(0, 3)).toEqual([0, 0, 0]);
  });
});

describe("splitLinesByLot", () => {
  it("expands each line into per-lot lines, drops zero splits, renumbers", () => {
    const lines = [
      { inventory_item_id: "i1", qty_ordered: 72, unit_cost_cents: 500, description: "M" },
    ];
    const out = splitLinesByLot(lines, ["PO-A", "PO-B", "PO-C"]); // 3 cartons / 3 lots → 1 each
    expect(out).toHaveLength(3);
    expect(out.map((l) => l.lot_number)).toEqual(["PO-A", "PO-B", "PO-C"]);
    expect(out.map((l) => l.qty_ordered)).toEqual([24, 24, 24]);
    expect(out.map((l) => l.line_number)).toEqual([1, 2, 3]);
    expect(out[0].line_total_cents).toBe(24 * 500);
  });

  it("drops the empty split when a lot gets zero of a line", () => {
    const lines = [{ inventory_item_id: "i1", qty_ordered: 24, unit_cost_cents: 100 }];
    const out = splitLinesByLot(lines, ["PO-A", "PO-B"]); // 1 carton / 2 lots → 24,0
    expect(out).toHaveLength(1);
    expect(out[0].lot_number).toBe("PO-A");
    expect(out[0].qty_ordered).toBe(24);
  });

  it("returns [] when no lots given", () => {
    expect(splitLinesByLot([{ qty_ordered: 24, unit_cost_cents: 0 }], [])).toEqual([]);
  });
});
