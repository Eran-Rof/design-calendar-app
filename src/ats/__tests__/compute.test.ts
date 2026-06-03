import { describe, it, expect } from "vitest";
import { computeRowsFromExcelData } from "../compute";
import type { ExcelData } from "../types";

function makeData(overrides: Partial<ExcelData> = {}): ExcelData {
  return {
    syncedAt: "2026-03-30T00:00:00Z",
    skus: [
      { sku: "SKU-A", description: "Test A", store: "ROF", onHand: 100, onPO: 0 },
      { sku: "SKU-A", description: "Test A", store: "ROF ECOM", onHand: 50, onPO: 0 },
      { sku: "SKU-B", description: "Test B", store: "ROF", onHand: 200, onPO: 0 },
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
    expect(rofRow.onPO).toBe(500);

    // ECOM row: unaffected — PO is for ROF only
    expect(ecomRow.dates["2026-04-01"]).toBe(50);
    expect(ecomRow.dates["2026-04-02"]).toBe(50);
    expect(ecomRow.onPO).toBe(0);
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
    expect(row.onOrder).toBe(150);
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

    expect(rofRow.onPO).toBe(100); // only ROF PO
    expect(ecomRow.onPO).toBe(0);  // ECOM PO filtered out
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

describe("computeRowsFromExcelData — On-Order date window (soWindow)", () => {
  // SKU-B (onHand 200) with SO lines spread across dates + one undated.
  const winData = () => makeData({
    sos: [
      { sku: "SKU-B", date: "2026-04-02", qty: 30,  orderNumber: "SO0", customerName: "C", unitPrice: 20, totalPrice: 600,  store: "ROF" }, // inside DATES
      { sku: "SKU-B", date: "2026-04-10", qty: 150, orderNumber: "SO1", customerName: "C", unitPrice: 20, totalPrice: 3000, store: "ROF" },
      { sku: "SKU-B", date: "2026-04-30", qty: 40,  orderNumber: "SO2", customerName: "C", unitPrice: 20, totalPrice: 800,  store: "ROF" },
      { sku: "SKU-B", date: "2026-05-20", qty: 60,  orderNumber: "SO3", customerName: "C", unitPrice: 20, totalPrice: 1200, store: "ROF" },
      { sku: "SKU-B", date: "",           qty: 99,  orderNumber: "SO4", customerName: "C", unitPrice: 20, totalPrice: 1980, store: "ROF" },
    ],
  });

  it("sums every SO into onOrder when no window is set (including undated)", () => {
    const row = computeRowsFromExcelData(winData(), DATES).find(r => r.sku === "SKU-B")!;
    expect(row.onOrder).toBe(30 + 150 + 40 + 60 + 99);
  });

  it("scopes onOrder to the inclusive [start,end] window; drops out-of-range + undated", () => {
    const row = computeRowsFromExcelData(winData(), DATES, ["All"], ["All"], { start: "2026-04-10", end: "2026-04-30" })
      .find(r => r.sku === "SKU-B")!;
    // 04-10 (150) + 04-30 boundary-inclusive (40); 04-02, 05-20, undated all excluded
    expect(row.onOrder).toBe(190);
  });

  it("supports open-ended bounds (start-only / end-only)", () => {
    const startOnly = computeRowsFromExcelData(winData(), DATES, ["All"], ["All"], { start: "2026-05-01", end: "" })
      .find(r => r.sku === "SKU-B")!;
    expect(startOnly.onOrder).toBe(60); // only 05-20
    const endOnly = computeRowsFromExcelData(winData(), DATES, ["All"], ["All"], { start: "", end: "2026-04-09" })
      .find(r => r.sku === "SKU-B")!;
    expect(endOnly.onOrder).toBe(30); // only 04-02
  });

  it("windows ONLY the onOrder aggregate — the projection (dates) is untouched", () => {
    const projData = makeData({
      sos: [
        { sku: "SKU-B", date: "2026-04-02", qty: 30, orderNumber: "SO0", customerName: "C", unitPrice: 20, totalPrice: 600, store: "ROF" },
        { sku: "SKU-B", date: "2026-04-30", qty: 40, orderNumber: "SO2", customerName: "C", unitPrice: 20, totalPrice: 800, store: "ROF" },
      ],
    });
    const noWin = computeRowsFromExcelData(projData, DATES).find(r => r.sku === "SKU-B")!;
    const win   = computeRowsFromExcelData(projData, DATES, ["All"], ["All"], { start: "2026-04-20", end: "2026-04-30" }).find(r => r.sku === "SKU-B")!;
    expect(noWin.onOrder).toBe(70); // 30 + 40
    expect(win.onOrder).toBe(40);   // only the 04-30 line
    // Projection columns identical in both — the window never touches them.
    expect(win.dates).toEqual(noWin.dates);
    expect(win.dates["2026-04-02"]).toBe(170); // 200 onHand − 30 (in-DATES SO)
  });
});
