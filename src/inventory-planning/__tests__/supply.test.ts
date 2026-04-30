import { describe, it, expect } from "vitest";
import {
  buildPerCustomerRollingSupply,
  latestOnHandBySku,
  openPoQtyBySku,
  openPoQtyBySkuPeriod,
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

  describe("openPoQtyBySkuPeriod", () => {
    it("sums qty_open only when expected_date lands in [start, end]", () => {
      const out = openPoQtyBySkuPeriod(
        [
          po({ sku_id: "a", expected_date: "2026-06-01", qty_open: 100 }),
          po({ sku_id: "a", expected_date: "2026-06-30", qty_open: 50 }),
          po({ sku_id: "a", expected_date: "2026-07-01", qty_open: 999 }), // outside
          po({ sku_id: "a", expected_date: "2026-05-31", qty_open: 999 }), // outside
        ],
        "2026-06-01",
        "2026-06-30",
      );
      expect(out.get("a")).toBe(150);
    });

    it("excludes POs with no expected_date", () => {
      const out = openPoQtyBySkuPeriod(
        [
          po({ sku_id: "a", expected_date: null, qty_open: 100 }),
          po({ sku_id: "a", expected_date: "2026-06-15", qty_open: 50 }),
        ],
        "2026-06-01",
        "2026-06-30",
      );
      expect(out.get("a")).toBe(50);
    });

    it("returns empty map when no PO falls in the window", () => {
      const out = openPoQtyBySkuPeriod(
        [po({ sku_id: "a", expected_date: "2026-08-01", qty_open: 100 })],
        "2026-06-01",
        "2026-06-30",
      );
      expect(out.size).toBe(0);
    });

    it("aggregates across multiple SKUs independently", () => {
      const out = openPoQtyBySkuPeriod(
        [
          po({ sku_id: "a", expected_date: "2026-06-15", qty_open: 10 }),
          po({ sku_id: "b", expected_date: "2026-06-15", qty_open: 5 }),
          po({ sku_id: "a", expected_date: "2026-06-20", qty_open: 7 }),
        ],
        "2026-06-01",
        "2026-06-30",
      );
      expect(out.get("a")).toBe(17);
      expect(out.get("b")).toBe(5);
    });

    it("treats inclusive boundaries on both ends", () => {
      // start and end dates both included
      const out = openPoQtyBySkuPeriod(
        [
          po({ sku_id: "a", expected_date: "2026-06-01", qty_open: 1 }),
          po({ sku_id: "a", expected_date: "2026-06-30", qty_open: 2 }),
        ],
        "2026-06-01",
        "2026-06-30",
      );
      expect(out.get("a")).toBe(3);
    });
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

  describe("buildPerCustomerRollingSupply", () => {
    const periods = [
      { period_start: "2026-06-01", period_end: "2026-06-30" },
      { period_start: "2026-07-01", period_end: "2026-07-31" },
    ];

    it("computes ATS = OnHand − OnSO + Receipts and rolls ATS into next OnHand", () => {
      const onSo = new Map<string, number>([
        ["cust-1:a:2026-06-01", 4_703],
        ["cust-1:a:2026-07-01", 10_505],
      ]);
      const out = buildPerCustomerRollingSupply(
        [
          { customer_id: "cust-1", sku_id: "a", period_start: "2026-06-01" },
          { customer_id: "cust-1", sku_id: "a", period_start: "2026-07-01" },
        ],
        {
          inventorySnapshots: [snap({ sku_id: "a", qty_on_hand: 14_352 })],
          openPos: [
            po({ sku_id: "a", expected_date: "2026-06-15", qty_open: 45_408 }),
            po({ sku_id: "a", expected_date: "2026-07-15", qty_open: 72_598 }),
          ],
          receipts: [],
        },
        periods,
        onSo,
      );

      const jun = out.get("cust-1:a:2026-06-01")!;
      expect(jun.beginning_balance_qty).toBe(14_352);
      expect(jun.receipts_due_qty).toBe(45_408);
      expect(jun.available_supply_qty).toBe(14_352 - 4_703 + 45_408);

      const jul = out.get("cust-1:a:2026-07-01")!;
      expect(jul.beginning_balance_qty).toBe(jun.available_supply_qty);
      expect(jul.available_supply_qty).toBe(jul.beginning_balance_qty - 10_505 + 72_598);
    });

    it("includes planned_buy in the period's ATS", () => {
      const out = buildPerCustomerRollingSupply(
        [{ customer_id: "c1", sku_id: "a", period_start: "2026-06-01", planned_buy_qty: 1_000 }],
        {
          inventorySnapshots: [snap({ sku_id: "a", qty_on_hand: 100 })],
          openPos: [],
          receipts: [],
        },
        [periods[0]],
        new Map(),
      );
      expect(out.get("c1:a:2026-06-01")!.available_supply_qty).toBe(1_100);
    });

    it("clamps ATS to zero when SO exceeds OnHand + Receipts (no negative carry)", () => {
      const onSo = new Map<string, number>([["c1:a:2026-06-01", 999]]);
      const out = buildPerCustomerRollingSupply(
        [
          { customer_id: "c1", sku_id: "a", period_start: "2026-06-01" },
          { customer_id: "c1", sku_id: "a", period_start: "2026-07-01" },
        ],
        {
          inventorySnapshots: [snap({ sku_id: "a", qty_on_hand: 10 })],
          openPos: [],
          receipts: [],
        },
        periods,
        onSo,
      );
      expect(out.get("c1:a:2026-06-01")!.available_supply_qty).toBe(0);
      expect(out.get("c1:a:2026-07-01")!.beginning_balance_qty).toBe(0);
    });

    it("isolates rolling between distinct customers of the same SKU", () => {
      // Both customers see the full SKU on_hand at period 1 (caveat documented
      // on the function); their rolling pools then diverge based on each
      // customer's own SO commitments.
      const onSo = new Map<string, number>([
        ["A:a:2026-06-01", 30],
        ["B:a:2026-06-01", 10],
      ]);
      const out = buildPerCustomerRollingSupply(
        [
          { customer_id: "A", sku_id: "a", period_start: "2026-06-01" },
          { customer_id: "A", sku_id: "a", period_start: "2026-07-01" },
          { customer_id: "B", sku_id: "a", period_start: "2026-06-01" },
          { customer_id: "B", sku_id: "a", period_start: "2026-07-01" },
        ],
        { inventorySnapshots: [snap({ sku_id: "a", qty_on_hand: 100 })], openPos: [], receipts: [] },
        periods,
        onSo,
      );
      expect(out.get("A:a:2026-06-01")!.available_supply_qty).toBe(70);
      expect(out.get("B:a:2026-06-01")!.available_supply_qty).toBe(90);
      expect(out.get("A:a:2026-07-01")!.beginning_balance_qty).toBe(70);
      expect(out.get("B:a:2026-07-01")!.beginning_balance_qty).toBe(90);
    });
  });
});
