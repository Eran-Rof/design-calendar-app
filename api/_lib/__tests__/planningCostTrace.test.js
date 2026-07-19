import { describe, it, expect } from "vitest";
import { buildCostTraceSummary } from "../planningCostTrace.js";

describe("buildCostTraceSummary", () => {
  it("returns zeroed counts and full-blank notes for empty input", () => {
    const { summary, notes } = buildCostTraceSummary({});
    expect(summary).toMatchObject({
      item_master_rows: 0,
      avg_cost_rows: 0,
      open_po_rows: 0,
      open_po_with_positive_cost: 0,
    });
    expect(notes).toContain("No ip_item_master rows match this query — the SKU/style is not in the planning item master at all.");
    expect(notes.some((n) => n.includes("No cost signal anywhere"))).toBe(true);
  });

  it("fires the 'sku_id not in item master' note when an open PO is orphaned", () => {
    const { summary, notes } = buildCostTraceSummary({
      itemMaster: [{ id: "im1", sku_code: "RYB0412PPK-BLACK", style_code: "RYB0412PPK", unit_cost: null, pack_size: 6, active: true }],
      avgCost: [],
      openPos: [
        { sku_id: "im1", unit_cost: 12.5, qty_open: 100, channel: "wholesale", sku_in_item_master: true },
        { sku_id: "ghost", unit_cost: 9.0, qty_open: 50, channel: "wholesale", sku_in_item_master: false },
      ],
    });
    expect(summary.open_po_sku_not_in_item_master).toBe(1);
    expect(notes.some((n) => n.includes("reference a sku_id not in item master") && n.includes("silently dropped"))).toBe(true);
  });

  it("fires the 'null unit_cost' note when open POs have no cost", () => {
    const { summary, notes } = buildCostTraceSummary({
      itemMaster: [{ id: "im1", sku_code: "RYB0412-BLACK", style_code: "RYB0412", unit_cost: null, pack_size: 1, active: true }],
      avgCost: [],
      openPos: [
        { sku_id: "im1", unit_cost: null, qty_open: 100, channel: "wholesale", sku_in_item_master: true },
        { sku_id: "im1", unit_cost: null, qty_open: 40, channel: "wholesale", sku_in_item_master: true },
      ],
    });
    expect(summary.open_po_with_null_cost).toBe(2);
    expect(summary.open_po_with_positive_cost).toBe(0);
    expect(notes.some((n) => n.includes("null unit_cost") && n.includes("contribute nothing"))).toBe(true);
  });

  it("flags a single-channel PO set", () => {
    const { notes } = buildCostTraceSummary({
      itemMaster: [{ id: "im1", sku_code: "RYB0412-BLACK", style_code: "RYB0412", unit_cost: 5, pack_size: 1, active: true }],
      avgCost: [{ sku_code: "RYB0412-BLACK", avg_cost: 4.8, source: "xoro", updated_at: "2026-07-01T00:00:00Z" }],
      openPos: [{ sku_id: "im1", unit_cost: 10, qty_open: 10, channel: "ecom", sku_in_item_master: true }],
    });
    expect(notes.some((n) => n.includes('Open POs found only on channel "ecom"'))).toBe(true);
  });

  it("does NOT fire the blank-cost note when a positive cost signal exists", () => {
    const { notes } = buildCostTraceSummary({
      itemMaster: [{ id: "im1", sku_code: "RYB0412-BLACK", style_code: "RYB0412", unit_cost: 6.25, pack_size: 1, active: true }],
      avgCost: [],
      openPos: [],
    });
    expect(notes.some((n) => n.includes("No cost signal anywhere"))).toBe(false);
  });

  it("flags avg rows that exist but are all non-positive", () => {
    const { summary, notes } = buildCostTraceSummary({
      itemMaster: [{ id: "im1", sku_code: "RYB0412-BLACK", style_code: "RYB0412", unit_cost: null, pack_size: 1, active: true }],
      avgCost: [{ sku_code: "RYB0412-BLACK", avg_cost: 0, source: "manual", updated_at: "2026-07-01T00:00:00Z" }],
      openPos: [{ sku_id: "im1", unit_cost: 0, qty_open: 0, channel: "wholesale", sku_in_item_master: true }],
    });
    expect(summary.avg_cost_with_positive).toBe(0);
    expect(notes.some((n) => n.includes("none have a positive avg_cost"))).toBe(true);
    expect(notes.some((n) => n.includes("none have a positive qty_open"))).toBe(true);
  });
});
