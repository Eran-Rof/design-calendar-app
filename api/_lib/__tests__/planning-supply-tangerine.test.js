import { describe, it, expect } from "vitest";
import { aggregateOnHandLayers, buildOpenPoRows, OPEN_PO_STATUSES } from "../planning-supply-tangerine.js";

describe("aggregateOnHandLayers", () => {
  const codeByLoc = new Map([["loc1", "MAIN_WH"], ["loc2", "FBA_US"]]);

  it("sums remaining_qty by (item, warehouse_code)", () => {
    const layers = [
      { item_id: "i1", remaining_qty: 10, location_id: "loc1" },
      { item_id: "i1", remaining_qty: 5, location_id: "loc1" },
      { item_id: "i1", remaining_qty: 3, location_id: "loc2" },
    ];
    const out = aggregateOnHandLayers(layers, codeByLoc).sort((a, b) => a.warehouse_code.localeCompare(b.warehouse_code));
    expect(out).toEqual([
      { sku_id: "i1", warehouse_code: "FBA_US", qty_on_hand: 3 },
      { sku_id: "i1", warehouse_code: "MAIN_WH", qty_on_hand: 15 },
    ]);
  });

  it("drops non-positive and item-less layers; unknown location → UNKNOWN", () => {
    const layers = [
      { item_id: "i1", remaining_qty: 0, location_id: "loc1" },
      { item_id: "i1", remaining_qty: -4, location_id: "loc1" },
      { item_id: null, remaining_qty: 9, location_id: "loc1" },
      { item_id: "i2", remaining_qty: 7, location_id: "ghost" },
    ];
    const out = aggregateOnHandLayers(layers, codeByLoc);
    expect(out).toEqual([{ sku_id: "i2", warehouse_code: "UNKNOWN", qty_on_hand: 7 }]);
  });

  it("handles empty input", () => {
    expect(aggregateOnHandLayers([], codeByLoc)).toEqual([]);
    expect(aggregateOnHandLayers(null, codeByLoc)).toEqual([]);
  });
});

describe("buildOpenPoRows", () => {
  it("emits one row per open line with qty_open and tangerine source", () => {
    const pos = [{ id: "po1", vendor_id: "v1", po_number: "PO-100", order_date: "2026-06-01", expected_date: "2026-08-01", status: "issued", currency: "USD" }];
    const lines = new Map([["po1", [
      { line_number: 1, inventory_item_id: "i1", qty_ordered: 100, qty_received: 30, unit_cost_cents: 450 },
      { line_number: 2, inventory_item_id: "i2", qty_ordered: 50, qty_received: 50, unit_cost_cents: 200 }, // fully received → drop
    ]]]);
    const rows = buildOpenPoRows(pos, lines);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sku_id: "i1", vendor_id: "v1", po_number: "PO-100", qty_ordered: 100, qty_received: 30,
      qty_open: 70, unit_cost: 4.5, currency: "USD", status: "issued", source: "tangerine",
      source_line_key: "po1:1", channel: null,
    });
  });

  it("falls back to a PO-<id> number and drops item-less lines", () => {
    const pos = [{ id: "abcdef12-0000", vendor_id: null, po_number: null, status: "in_transit" }];
    const lines = new Map([["abcdef12-0000", [
      { line_number: 1, inventory_item_id: null, qty_ordered: 10, qty_received: 0, unit_cost_cents: 0 },
      { line_number: 2, inventory_item_id: "i9", qty_ordered: 10, qty_received: 0, unit_cost_cents: 0 },
    ]]]);
    const rows = buildOpenPoRows(pos, lines);
    expect(rows).toHaveLength(1);
    expect(rows[0].po_number).toBe("PO-abcdef12");
    expect(rows[0].qty_open).toBe(10);
    expect(rows[0].unit_cost).toBe(0);
  });

  it("returns [] when a PO has no lines", () => {
    expect(buildOpenPoRows([{ id: "p", status: "issued" }], new Map())).toEqual([]);
    expect(buildOpenPoRows([], new Map())).toEqual([]);
  });

  it("open statuses are issued + in_transit", () => {
    expect(OPEN_PO_STATUSES).toEqual(["issued", "in_transit"]);
  });
});
