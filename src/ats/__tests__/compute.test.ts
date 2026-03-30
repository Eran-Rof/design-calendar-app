import { describe, it, expect } from "vitest";
import { computeRowsFromExcelData } from "../compute";
import type { ExcelData } from "../types";

function makeData(overrides: Partial<ExcelData> = {}): ExcelData {
  return {
    syncedAt: "2026-03-30T00:00:00Z",
    skus: [
      { sku: "SKU-A", description: "Test A", store: "ROF", onHand: 100, onOrder: 0 },
      { sku: "SKU-A", description: "Test A", store: "ROF ECOM", onHand: 50, onOrder: 0 },
      { sku: "SKU-B", description: "Test B", store: "ROF", onHand: 200, onOrder: 0 },
    ],
    pos: [],
    sos: [],
    ...overrides,
  };
}

const DATES = ["2026-04-01", "2026-04-02", "2026-04-03"];

describe("computeRowsFromExcelData", () => {
  it("returns correct on-hand for each SKU", () => {
    const rows = computeRowsFromExcelData(makeData(), DATES);
    expect(rows).toHaveLength(3);
    expect(rows[0].onHand).toBe(100);
    expect(rows[1].onHand).toBe(50);
    expect(rows[2].onHand).toBe(200);
  });

  it("applies PO events to correct store row only", () => {
    const data = makeData({
      pos: [
        { sku: "SKU-A", date: "2026-04-02", qty: 500, poNumber: "PO1", vendor: "V", store: "ROF", unitCost: 10 },
      ],
    });
    const rows = computeRowsFromExcelData(data, DATES);
    const rofRow = rows.find(r => r.sku === "SKU-A" && r.store === "ROF")!;
    const ecomRow = rows.find(r => r.sku === "SKU-A" && r.store === "ROF ECOM")!;

    // ROF row: 100 on-hand, +500 PO on Apr 2
    expect(rofRow.dates["2026-04-01"]).toBe(100);
    expect(rofRow.dates["2026-04-02"]).toBe(600);
    expect(rofRow.dates["2026-04-03"]).toBe(600);
    expect(rofRow.onOrder).toBe(500);

    // ECOM row: unaffected — PO is for ROF only
    expect(ecomRow.dates["2026-04-01"]).toBe(50);
    expect(ecomRow.dates["2026-04-02"]).toBe(50);
    expect(ecomRow.onOrder).toBe(0);
  });

  it("applies SO events to reduce ATS", () => {
    const data = makeData({
      sos: [
        { sku: "SKU-B", date: "2026-04-01", qty: 150, orderNumber: "SO1", customerName: "C", unitPrice: 20, totalPrice: 3000, store: "ROF" },
      ],
    });
    const rows = computeRowsFromExcelData(data, DATES);
    const row = rows.find(r => r.sku === "SKU-B")!;

    // 200 on-hand - 150 SO = 50
    expect(row.dates["2026-04-01"]).toBe(50);
    expect(row.dates["2026-04-02"]).toBe(50);
    expect(row.onCommitted).toBe(150);
  });

  it("preserves negative ATS (does not clamp to zero mid-stream)", () => {
    const data = makeData({
      sos: [
        { sku: "SKU-A", date: "2026-04-01", qty: 300, orderNumber: "SO1", customerName: "C", unitPrice: 10, totalPrice: 3000, store: "ROF" },
      ],
      pos: [
        { sku: "SKU-A", date: "2026-04-03", qty: 300, poNumber: "PO1", vendor: "V", store: "ROF", unitCost: 5 },
      ],
    });
    const rows = computeRowsFromExcelData(data, DATES);
    const row = rows.find(r => r.sku === "SKU-A" && r.store === "ROF")!;

    // 100 - 300 = -200 (negative, NOT clamped)
    expect(row.dates["2026-04-01"]).toBe(-200);
    // Still -200 on Apr 2
    expect(row.dates["2026-04-02"]).toBe(-200);
    // -200 + 300 PO = 100 (restored correctly because we didn't clamp)
    expect(row.dates["2026-04-03"]).toBe(100);
  });

  it("filters PO/SO by store when store filter is applied", () => {
    const data = makeData({
      pos: [
        { sku: "SKU-A", date: "2026-04-01", qty: 100, poNumber: "PO1", vendor: "V", store: "ROF", unitCost: 10 },
        { sku: "SKU-A", date: "2026-04-01", qty: 200, poNumber: "PO2", vendor: "V", store: "ROF ECOM", unitCost: 10 },
      ],
    });

    // Filter to ROF only
    const rows = computeRowsFromExcelData(data, DATES, ["ROF"], ["ROF"]);
    const rofRow = rows.find(r => r.sku === "SKU-A" && r.store === "ROF")!;
    const ecomRow = rows.find(r => r.sku === "SKU-A" && r.store === "ROF ECOM")!;

    expect(rofRow.onOrder).toBe(100); // only ROF PO
    expect(ecomRow.onOrder).toBe(0);  // ECOM PO filtered out
  });

  it("applies pre-range events to opening balance", () => {
    const data = makeData({
      sos: [
        { sku: "SKU-B", date: "2026-03-15", qty: 50, orderNumber: "SO1", customerName: "C", unitPrice: 10, totalPrice: 500, store: "ROF" },
      ],
    });
    const rows = computeRowsFromExcelData(data, DATES);
    const row = rows.find(r => r.sku === "SKU-B")!;

    // 200 on-hand - 50 pre-range SO = 150 opening balance
    expect(row.dates["2026-04-01"]).toBe(150);
  });
});
