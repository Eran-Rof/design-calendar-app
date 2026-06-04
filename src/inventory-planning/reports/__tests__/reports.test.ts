import { describe, it, expect } from "vitest";
import { buildLookups } from "../lib/aggUtils";
import { buildSalesPerformance } from "../reports/salesPerformance";
import { buildInventoryHealth } from "../reports/inventoryHealth";
import { buildForecastAccuracy } from "../reports/forecastAccuracy";
import { buildBuyPlanSupply } from "../reports/buyPlanSupply";

// Minimal masters: 2 items in one category, costs from unit_cost (no avg).
const item = (id: string, sku: string, cost: number) => ({
  id, sku_code: sku, style_code: null, description: `${sku} desc`, category_id: "c1",
  color: null, size: null, unit_cost: cost, lead_time_days: null, active: true,
});
const ctx = buildLookups({
  items: [item("i1", "A", 10), item("i2", "B", 5)],
  categories: [{ id: "c1", name: "Tees" }],
  customers: [{ id: "cu1", name: "Acme" }],
  channels: [],
  vendors: [{ id: "v1", name: "VendOne" }],
  avgCosts: [],
});

const sale = (sku: string, date: string, qty: number, net: number, margin: number, order: string) => ({
  sku_id: sku, customer_id: "cu1", category_id: "c1", channel_id: null,
  txn_type: "invoice", txn_date: date, qty, net_amount: net, margin_amount: margin, order_number: order,
});

describe("salesPerformance", () => {
  const sales = [
    sale("i1", "2026-01-15", 10, 200, 80, "O1"), // TY
    sale("i2", "2026-02-15", 5, 50, 10, "O2"),   // TY
    sale("i1", "2025-01-15", 8, 160, 60, "O0"),  // LY
  ];
  const params = { groupBy: "sku" as const, txnType: "invoice", tyStartIso: "2025-06-01", endIso: "2026-06-01" };

  it("computes TY totals, YoY and ABC at SKU grain", () => {
    const r = buildSalesPerformance(sales, ctx, params);
    const a = r.rows.find((x) => x.dimension === "A")!;
    const b = r.rows.find((x) => x.dimension === "B")!;
    expect(a.units).toBe(10);
    expect(a.net_sales).toBe(200);
    expect(a.yoy_pct).toBe(25);      // (200-160)/160
    expect(a.abc).toBe("A");          // cumulative 80%
    expect(b.yoy_pct).toBeNull();     // no LY
    expect(b.abc).toBe("C");
    expect(r.summary[0].value).toContain("250"); // net sales TY
  });

  it("respects txn_type filter", () => {
    const mixed = [...sales, { ...sale("i1", "2026-03-01", 99, 9900, 0, "X"), txn_type: "order" }];
    const r = buildSalesPerformance(mixed, ctx, params);
    const a = r.rows.find((x) => x.dimension === "A")!;
    expect(a.units).toBe(10); // the "order" row excluded
  });
});

describe("inventoryHealth", () => {
  const inv = [
    { sku_id: "i1", warehouse_code: "WH1", snapshot_date: "2026-06-01", qty_on_hand: 100, qty_available: 100, qty_committed: 0, qty_on_order: 0, qty_in_transit: 0 },
    { sku_id: "i1", warehouse_code: "WH1", snapshot_date: "2026-05-01", qty_on_hand: 50, qty_available: 50, qty_committed: 0, qty_on_order: 0, qty_in_transit: 0 },
    { sku_id: "i2", warehouse_code: "WH1", snapshot_date: "2026-06-01", qty_on_hand: 0, qty_available: 0, qty_committed: 0, qty_on_order: 0, qty_in_transit: 0 },
  ];
  const velocity = new Map([["i1", 10], ["i2", 0]]);

  it("uses latest snapshot, values on-hand, classifies coverage", () => {
    const r = buildInventoryHealth(inv, ctx, { groupBy: "sku", weeklyVelocity: velocity });
    const a = r.rows.find((x) => x.dimension === "A")!;
    const b = r.rows.find((x) => x.dimension === "B")!;
    expect(a.on_hand).toBe(100);             // latest, not 150
    expect(a.on_hand_value).toBe(1000);      // 100 * 10
    expect(a.weeks_of_supply).toBe(10);
    expect(a.status).toBe("Healthy");
    expect(b.status).toBe("Stockout");
    expect(r.summary[0].value).toContain("1,000"); // on-hand value
  });
});

describe("forecastAccuracy", () => {
  const rows = [{
    planning_run_id: "run1", forecast_type: "wholesale", sku_id: "i1", category_id: "c1",
    period_code: "2026-01", forecast_method: "ly_sales",
    system_forecast_qty: 100, final_forecast_qty: 90, actual_qty: 100,
    abs_error_system: null, abs_error_final: null, bias_system: null, bias_final: null,
  }];

  it("computes volume-weighted MAPE and bias", () => {
    const r = buildForecastAccuracy(rows, ctx, "method");
    const row = r.rows[0];
    expect(row.mape_final).toBe(10);   // |90-100|/100
    expect(row.mape_system).toBe(0);   // |100-100|/100
    expect(row.mape_delta).toBe(10);
    expect(row.bias_final).toBe(-10);  // (90-100)/100
  });
});

describe("buyPlanSupply", () => {
  const recs = [
    { planning_run_id: "run1", sku_id: "i1", category_id: "c1", period_code: "2026-01", recommendation_type: "buy", recommendation_qty: 10, priority_level: "critical", shortage_qty: 5, excess_qty: 0, service_risk_flag: true },
    { planning_run_id: "run1", sku_id: "i2", category_id: "c1", period_code: "2026-01", recommendation_type: "hold", recommendation_qty: 99, priority_level: "low", shortage_qty: 0, excess_qty: 0, service_risk_flag: false },
  ];
  const openPos = [
    { sku_id: "i1", vendor_id: "v1", po_number: "P1", expected_date: "2026-07-15", qty_open: 3, unit_cost: 10, status: "issued" },
  ];

  it("demand lens rolls up buy recs + open-PO overlay", () => {
    const r = buildBuyPlanSupply(recs, openPos, ctx, "category");
    const row = r.rows[0];
    expect(row.buy_qty).toBe(10);       // only the buy-type rec
    expect(row.buy_value).toBe(100);    // 10 * cost(i1=10)
    expect(row.shortage_qty).toBe(5);
    expect(row.critical).toBe(1);
    expect(row.open_po_qty).toBe(3);
  });

  it("supply lens rolls up open POs by vendor", () => {
    const r = buildBuyPlanSupply(recs, openPos, ctx, "vendor");
    const row = r.rows[0];
    expect(row.dimension).toBe("VendOne");
    expect(row.open_po_qty).toBe(3);
    expect(row.open_po_value).toBe(30); // 3 * 10
  });
});
