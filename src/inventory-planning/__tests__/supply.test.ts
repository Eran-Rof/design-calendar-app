import { describe, it, expect } from "vitest";
import {
  applyRollingPool,
  buildRollingWholesaleSupply,
  historicalReceiptsInPeriod,
  latestOnHandBySku,
  openPoQtyBySku,
  openPoQtyBySkuPeriod,
  openSoQtyBySkuPeriod,
  receiptsDueInPeriod,
  supplyForPeriod,
} from "../compute/supply";
import type { IpInventorySnapshot, IpOpenPoRow, IpOpenSoRow, IpReceiptRow } from "../types/entities";

function so(p: Partial<IpOpenSoRow>): IpOpenSoRow {
  return {
    sku_id: "sku-a", customer_id: null, customer_name: null, so_number: "SO-1",
    ship_date: null, cancel_date: null, qty_ordered: 0, qty_shipped: 0, qty_open: 0,
    unit_price: null, currency: null, status: null, store: null, source: "xoro",
    source_line_key: "k", last_seen_at: "2026-04-01T00:00:00Z", ...p,
  };
}

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

  it("receiptsDueInPeriod returns ONLY future open POs in the period", () => {
    // Past receipts are already in on_hand_qty; counting them here would
    // double-count supply for any period overlapping the snapshot.
    const got = receiptsDueInPeriod(
      {
        openPos: [
          po({ sku_id: "a", expected_date: "2026-06-15", qty_open: 50 }),
          po({ sku_id: "a", expected_date: "2026-07-01", qty_open: 999 }),
        ],
      },
      "a", "2026-06-01", "2026-06-30",
    );
    expect(got).toBe(50);
  });

  it("historicalReceiptsInPeriod returns past actuals in the period", () => {
    const got = historicalReceiptsInPeriod(
      {
        receipts: [
          rc({ sku_id: "a", received_date: "2026-06-10", qty: 20 }),
          rc({ sku_id: "a", received_date: "2026-06-30", qty: 5 }),
          rc({ sku_id: "a", received_date: "2026-05-10", qty: 777 }),
          rc({ sku_id: "b", received_date: "2026-06-10", qty: 1 }),
        ],
      },
      "a", "2026-06-01", "2026-06-30",
    );
    expect(got).toBe(25);
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

  describe("applyRollingPool", () => {
    it("top row gets the full pool; each row's ATS becomes next row's OnHand", () => {
      const out = applyRollingPool(
        [
          { on_so_qty: 4_703, receipts_due_qty: 45_408, planned_buy_qty: 0 },
          { on_so_qty: 4_704, receipts_due_qty: 40_464, planned_buy_qty: 0 },
          { on_so_qty: 0,     receipts_due_qty: 3_648,  planned_buy_qty: 0 },
        ],
        14_352,
      );
      expect(out[0].on_hand_qty).toBe(14_352);
      expect(out[0].available_supply_qty).toBe(14_352 - 4_703 + 45_408);
      expect(out[1].on_hand_qty).toBe(out[0].available_supply_qty);
      expect(out[1].available_supply_qty).toBe(out[1].on_hand_qty - 4_704 + 40_464);
      expect(out[2].on_hand_qty).toBe(out[1].available_supply_qty);
      expect(out[2].available_supply_qty).toBe(out[2].on_hand_qty + 3_648);
    });

    it("includes planned_buy in the row's ATS", () => {
      const out = applyRollingPool(
        [{ on_so_qty: 0, receipts_due_qty: 0, planned_buy_qty: 1_000 }],
        100,
      );
      expect(out[0].available_supply_qty).toBe(1_100);
    });

    it("clamps to zero when SO exceeds incoming pool + receipts (no negative carry)", () => {
      const out = applyRollingPool(
        [
          { on_so_qty: 999, receipts_due_qty: 0, planned_buy_qty: 0 },
          { on_so_qty: 0,   receipts_due_qty: 50, planned_buy_qty: 0 },
        ],
        10,
      );
      expect(out[0].available_supply_qty).toBe(0);
      expect(out[1].on_hand_qty).toBe(0);
      expect(out[1].available_supply_qty).toBe(50);
    });

    it("returns an empty array for empty input", () => {
      expect(applyRollingPool([], 100)).toEqual([]);
    });
  });

  describe("openSoQtyBySkuPeriod", () => {
    it("buckets open SOs by ship_date", () => {
      const out = openSoQtyBySkuPeriod(
        [
          so({ sku_id: "a", ship_date: "2026-06-15", qty_open: 30 }),
          so({ sku_id: "a", ship_date: "2026-06-30", qty_open: 20 }),
          so({ sku_id: "a", ship_date: "2026-07-01", qty_open: 999 }), // outside
        ],
        "2026-06-01",
        "2026-06-30",
      );
      expect(out.get("a")).toBe(50);
    });

    it("excludes SOs with no ship_date", () => {
      const out = openSoQtyBySkuPeriod(
        [so({ sku_id: "a", ship_date: null, qty_open: 100 })],
        "2026-06-01",
        "2026-06-30",
      );
      expect(out.get("a")).toBeUndefined();
    });
  });

  describe("buildRollingWholesaleSupply — SO-by-month bucketing", () => {
    const periods = [
      { period_start: "2026-04-01", period_end: "2026-04-30" },
      { period_start: "2026-05-01", period_end: "2026-05-31" },
      { period_start: "2026-06-01", period_end: "2026-06-30" },
    ] as const;
    const baseInputs = (extra: { openSos?: IpOpenSoRow[] } = {}) => ({
      inventorySnapshots: [snap({ sku_id: "a", qty_on_hand: 100, qty_committed: 60 })],
      openPos: [],
      receipts: [],
      ...extra,
    });
    const forecasts = [
      { sku_id: "a", period_start: "2026-04-01", final_forecast_qty: 0 },
      { sku_id: "a", period_start: "2026-05-01", final_forecast_qty: 0 },
      { sku_id: "a", period_start: "2026-06-01", final_forecast_qty: 0 },
    ];

    it("legacy mode (no openSos) deducts qty_committed from period 1 only", () => {
      const out = buildRollingWholesaleSupply(forecasts, baseInputs(), [...periods]);
      // 100 on_hand − 60 committed = 40 starts period 1 and rolls forward
      expect(out.get("a:2026-04-01")?.beginning_balance_qty).toBe(40);
      expect(out.get("a:2026-05-01")?.beginning_balance_qty).toBe(40);
      expect(out.get("a:2026-06-01")?.beginning_balance_qty).toBe(40);
    });

    it("dated SOs only deduct from their ship-month, not month 1", () => {
      const out = buildRollingWholesaleSupply(forecasts, baseInputs({
        openSos: [
          so({ sku_id: "a", ship_date: "2026-04-15", qty_open: 10 }),
          so({ sku_id: "a", ship_date: "2026-05-20", qty_open: 30 }),
          so({ sku_id: "a", ship_date: "2026-06-10", qty_open: 20 }),
        ],
      }), [...periods]);
      expect(out.get("a:2026-04-01")?.beginning_balance_qty).toBe(100); // full on_hand at start
      expect(out.get("a:2026-05-01")?.beginning_balance_qty).toBe(90);  // 100 − 10 ship-out in April
      expect(out.get("a:2026-06-01")?.beginning_balance_qty).toBe(60);  // 90 − 30 in May
    });

    it("undated SOs apply to period 1 as a fallback so commitment isn't lost", () => {
      const out = buildRollingWholesaleSupply(forecasts, baseInputs({
        openSos: [so({ sku_id: "a", ship_date: null, qty_open: 25 })],
      }), [...periods]);
      expect(out.get("a:2026-04-01")?.beginning_balance_qty).toBe(100);
      expect(out.get("a:2026-05-01")?.beginning_balance_qty).toBe(75); // 100 − 25 undated
      expect(out.get("a:2026-06-01")?.beginning_balance_qty).toBe(75);
    });
  });
});
