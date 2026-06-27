// Lot-aware allocation rule (Scenario 5).
import { describe, it, expect } from "vitest";
import { allocateByLot, bucketsFromLayers } from "../inventory/lotAllocation.js";

describe("allocateByLot", () => {
  it("fills the whole qty from one lot when a single lot covers it", () => {
    const r = allocateByLot(100, [
      { lot_number: "A", available: 50 },
      { lot_number: "B", available: 120 },
    ]);
    expect(r.shortfall).toBe(0);
    expect(r.filled).toBe(100);
    expect(r.picks).toEqual([{ lot_number: "B", qty: 100 }]);
  });

  it("prefers the SMALLEST sufficient lot (keeps bigger lots whole)", () => {
    const r = allocateByLot(40, [
      { lot_number: "BIG", available: 500 },
      { lot_number: "FIT", available: 60 },
    ]);
    expect(r.picks).toEqual([{ lot_number: "FIT", qty: 40 }]);
  });

  it("takes the largest lot then completes from a single lot", () => {
    // need 130; no single lot covers. Largest (90) first, then complete 40 from
    // the smallest sufficient remaining lot (50, not 80).
    const r = allocateByLot(130, [
      { lot_number: "A", available: 90 },
      { lot_number: "B", available: 80 },
      { lot_number: "C", available: 50 },
    ]);
    expect(r.shortfall).toBe(0);
    expect(r.filled).toBe(130);
    expect(r.picks).toEqual([
      { lot_number: "A", qty: 90 },
      { lot_number: "C", qty: 40 },
    ]);
  });

  it("greedily chains largest lots when no single lot can complete the remainder", () => {
    // need 100 from 40/35/30 — none can complete after the first take.
    const r = allocateByLot(100, [
      { lot_number: "A", available: 40 },
      { lot_number: "B", available: 35 },
      { lot_number: "C", available: 30 },
    ]);
    expect(r.shortfall).toBe(0);
    expect(r.picks).toEqual([
      { lot_number: "A", qty: 40 },
      { lot_number: "B", qty: 35 },
      { lot_number: "C", qty: 25 },
    ]);
  });

  it("reports a shortfall when stock can't cover the order", () => {
    const r = allocateByLot(100, [
      { lot_number: "A", available: 30 },
      { lot_number: "B", available: 25 },
    ]);
    expect(r.filled).toBe(55);
    expect(r.shortfall).toBe(45);
    expect(r.picks).toEqual([
      { lot_number: "A", qty: 30 },
      { lot_number: "B", qty: 25 },
    ]);
  });

  it("handles unlotted (null) stock as a normal bucket", () => {
    const r = allocateByLot(20, [{ lot_number: null, available: 50 }]);
    expect(r.picks).toEqual([{ lot_number: null, qty: 20 }]);
    expect(r.shortfall).toBe(0);
  });

  it("returns an empty plan for non-positive qty or no stock", () => {
    expect(allocateByLot(0, [{ lot_number: "A", available: 5 }])).toEqual({ picks: [], filled: 0, shortfall: 0 });
    expect(allocateByLot(10, [])).toEqual({ picks: [], filled: 0, shortfall: 10 });
  });
});

describe("bucketsFromLayers", () => {
  it("sums remaining_qty per lot and drops empties", () => {
    const buckets = bucketsFromLayers([
      { lot_number: "A", remaining_qty: 10 },
      { lot_number: "A", remaining_qty: 5 },
      { lot_number: "B", remaining_qty: 0 },
      { lot_number: null, remaining_qty: 7 },
    ]);
    const byLot = Object.fromEntries(buckets.map((b) => [String(b.lot_number), b.available]));
    expect(byLot.A).toBe(15);
    expect(byLot.B).toBeUndefined();
    expect(byLot.null).toBe(7);
  });
});
