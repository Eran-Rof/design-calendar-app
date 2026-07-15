import { describe, it, expect } from "vitest";
import { colPriceCents, colCostCents, type PricedSnapshotRow } from "../snapshotPricing";

// A colour that: costs $5.70 in the item master, sells for a $7.10 qty-weighted
// avg SO price, has $7.30 open orders, sold at $7.13, and whose OPEN POs are
// costed at $5.58 — plus a stray $17.53 most-recent-SO outlier we must ignore.
const row: PricedSnapshotRow = {
  avg_cost_cents: 570,
  sale_price_cents: 710,
  open_so_price_cents: 730,
  sold_price_cents: 713,
  on_po_cost_cents: 558,
};

describe("colPriceCents — per-column Avrg Sale basis", () => {
  it("On SO uses the open-SO price", () => {
    expect(colPriceCents(row, "on_so")).toBe(730);
  });
  it("Sold uses the actual sold price", () => {
    expect(colPriceCents(row, "sold")).toBe(713);
  });
  it.each(["on_hand", "allocated", "ats", "ats_incl_po", "on_po", "purchased", "in_transit"])(
    "%s uses the qty-weighted avg SO price (not a most-recent outlier)",
    (k) => {
      expect(colPriceCents(row, k)).toBe(710);
    },
  );
  it("returns null when the basis price is missing (excluded from the average)", () => {
    expect(colPriceCents({ avg_cost_cents: 570, sale_price_cents: null }, "on_hand")).toBeNull();
    expect(colPriceCents({ avg_cost_cents: 570, sale_price_cents: 710 }, "on_so")).toBeNull();
  });
});

describe("colCostCents — per-column Avg Cost basis", () => {
  it.each(["on_po", "in_transit"])("%s costs at the actual open-PO unit cost", (k) => {
    expect(colCostCents(row, k)).toBe(558);
  });
  it.each(["on_hand", "allocated", "ats", "ats_incl_po", "sold", "purchased", "on_so"])(
    "%s costs at the item-master blended avg",
    (k) => {
      expect(colCostCents(row, k)).toBe(570);
    },
  );
  it("On PO falls back to the item-master avg when no PO line is priced", () => {
    const noPo: PricedSnapshotRow = { avg_cost_cents: 570, sale_price_cents: 710, on_po_cost_cents: null };
    expect(colCostCents(noPo, "on_po")).toBe(570);
  });
  it("returns null when neither PO cost nor item-master cost exists", () => {
    expect(colCostCents({ avg_cost_cents: null, sale_price_cents: 710 }, "on_po")).toBeNull();
  });
});
