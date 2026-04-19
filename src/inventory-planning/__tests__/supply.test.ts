import { describe, it, expect } from "vitest";
import {
  latestOnHandBySku,
  openPoQtyBySku,
  receiptsDueInPeriod,
  supplyForPeriod,
} from "../compute/supply";
import type { IpInventorySnapshot, IpOpenPoRow, IpReceiptRow } from "../types/entities";

function snap(p: Partial<IpInventorySnapshot>): IpInventorySnapshot {
  return {
    sku_id: "sku-a", warehouse_code: "MAIN", snapshot_date: "2026-04-01",
    qty_on_hand: 0, qty_available: null, qty_committed: null, qty_on_order: null,
    qty_in_transit: null, source: "xoro", ...p,
  };
}

function po(p: Partial<IpOpenPoRow>): IpOpenPoRow {
  return {
    sku_id: "sku-a", vendor_id: null, po_number: "PO-1", po_line_number: "1",
    order_date: null, expected_date: null, qty_ordered: 0, qty_received: 0, qty_open: 0,
    unit_cost: null, currency: null, status: null, source: "xoro",
    source_line_key: "k", last_seen_at: "2026-04-01T00:00:00Z", ...p,
  };
}

function rc(p: Partial<IpReceiptRow>): IpReceiptRow {
  return {
    sku_id: "sku-a", vendor_id: null, po_number: null, receipt_number: null,
    received_date: "2026-04-01", qty: 0, warehouse_code: null, source: "xoro",
    source_line_key: "k", ...p,
  };
}

describe("supply compute", () => {
  it("latestOnHandBySku sums across warehouses on the latest date per sku", () => {
    const out = latestOnHandBySku([
      snap({ sku_id: "a", snapshot_date: "2026-04-01", qty_on_hand: 10, warehouse_code: "W1" }),
      snap({ sku_id: "a", snapshot_date: "2026-04-01", qty_on_hand: 20, warehouse_code: "W2" }),
      snap({ sku_id: "a", snapshot_date: "2026-03-01", qty_on_hand: 99, warehouse_code: "W1" }),
      snap({ sku_id: "b", snapshot_date: "2026-04-01", qty_on_hand: 5 }),
    ]);
    expect(out.get("a")).toBe(30);
    expect(out.get("b")).toBe(5);
  });

  it("openPoQtyBySku sums qty_open", () => {
    const out = openPoQtyBySku([
      po({ sku_id: "a", qty_open: 10 }),
      po({ sku_id: "a", qty_open: 20 }),
      po({ sku_id: "b", qty_open: 5 }),
    ]);
    expect(out.get("a")).toBe(30);
    expect(out.get("b")).toBe(5);
  });

  it("receiptsDueInPeriod combines historical receipts and future POs", () => {
    const got = receiptsDueInPeriod(
      {
        openPos: [
          po({ sku_id: "a", expected_date: "2026-06-15", qty_open: 50 }),
          po({ sku_id: "a", expected_date: "2026-07-01", qty_open: 999 }),
        ],
        receipts: [
          rc({ sku_id: "a", received_date: "2026-06-10", qty: 20 }),
          rc({ sku_id: "a", received_date: "2026-05-10", qty: 777 }),
        ],
      },
      "a", "2026-06-01", "2026-06-30",
    );
    expect(got).toBe(70); // 50 from PO + 20 from receipt
  });

  it("supplyForPeriod assembles on_hand + receipts_due for the period", () => {
    const s = supplyForPeriod(
      {
        inventorySnapshots: [snap({ sku_id: "a", qty_on_hand: 30 })],
        openPos: [po({ sku_id: "a", expected_date: "2026-06-15", qty_open: 50 })],
        receipts: [],
      },
      "a", "2026-06-01", "2026-06-30",
    );
    expect(s.on_hand_qty).toBe(30);
    expect(s.receipts_due_qty).toBe(50);
    expect(s.available_supply_qty).toBe(80);
  });
});
