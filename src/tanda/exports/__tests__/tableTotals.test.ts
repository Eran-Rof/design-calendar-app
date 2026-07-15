import { describe, it, expect } from "vitest";
import {
  computeColumnTotals,
  formatIsSummable,
  inferredNumeric,
  hasAnyNumericTotal,
  hasPercentColumn,
} from "../tableTotals";
import { type ExportColumn } from "../useTableExport";

describe("formatIsSummable", () => {
  it("sums money and number formats", () => {
    expect(formatIsSummable("currency_cents")).toBe(true);
    expect(formatIsSummable("currency_dollars")).toBe(true);
    expect(formatIsSummable("number")).toBe(true);
  });
  it("does NOT sum percent, text, date, datetime, or undefined", () => {
    expect(formatIsSummable("percent")).toBe(false);
    expect(formatIsSummable("text")).toBe(false);
    expect(formatIsSummable("date")).toBe(false);
    expect(formatIsSummable("datetime")).toBe(false);
    expect(formatIsSummable(undefined)).toBe(false);
  });
});

describe("inferredNumeric", () => {
  it("true when every non-null value is a real number", () => {
    expect(inferredNumeric([{ x: 1 }, { x: 2 }, { x: null }], "x")).toBe(true);
  });
  it("false when a value is a numeric-looking string (avoid summing codes)", () => {
    expect(inferredNumeric([{ x: "00123" }, { x: "00456" }], "x")).toBe(false);
  });
  it("false when the column is entirely empty/null", () => {
    expect(inferredNumeric([{ x: null }, { x: undefined }], "x")).toBe(false);
  });
  it("false when mixed number and text", () => {
    expect(inferredNumeric([{ x: 5 }, { x: "abc" }], "x")).toBe(false);
  });
});

describe("computeColumnTotals — declared formats", () => {
  const columns: ExportColumn<Record<string, unknown>>[] = [
    { key: "customer", header: "Customer", format: "text" },
    { key: "gross_cents", header: "Gross", format: "currency_cents" },
    { key: "qty", header: "Qty", format: "number" },
    { key: "margin_pct", header: "Margin %", format: "percent" },
    { key: "order_date", header: "Date", format: "date" },
  ];
  const rows = [
    { customer: "A", gross_cents: 12345, qty: 10, margin_pct: 12.5, order_date: "2026-01-01" },
    { customer: "B", gross_cents: 20000, qty: 5, margin_pct: 40.0, order_date: "2026-02-02" },
    { customer: "C", gross_cents: null, qty: null, margin_pct: 30.0, order_date: "2026-03-03" },
  ];

  it("sums cents in raw cents and renders $", () => {
    const totals = computeColumnTotals(rows, columns);
    const gross = totals.find((t) => t.key === "gross_cents")!;
    expect(gross.isNumeric).toBe(true);
    expect(gross.total).toBe(32345); // raw cents, nulls skipped
    expect(gross.display).toBe("$323.45");
  });

  it("sums qty (number) with nulls skipped", () => {
    const totals = computeColumnTotals(rows, columns);
    const qty = totals.find((t) => t.key === "qty")!;
    expect(qty.total).toBe(15);
    expect(qty.display).toBe("15");
  });

  it("does NOT sum percent columns (blank, flagged as percent)", () => {
    const totals = computeColumnTotals(rows, columns);
    const pct = totals.find((t) => t.key === "margin_pct")!;
    expect(pct.isNumeric).toBe(false);
    expect(pct.isPercent).toBe(true);
    expect(pct.total).toBe(null);
    expect(pct.display).toBe("");
  });

  it("leaves text and date columns blank", () => {
    const totals = computeColumnTotals(rows, columns);
    expect(totals.find((t) => t.key === "customer")!.display).toBe("");
    expect(totals.find((t) => t.key === "order_date")!.display).toBe("");
  });

  it("preserves column order 1:1", () => {
    const totals = computeColumnTotals(rows, columns);
    expect(totals.map((t) => t.key)).toEqual([
      "customer",
      "gross_cents",
      "qty",
      "margin_pct",
      "order_date",
    ]);
  });
});

describe("computeColumnTotals — inferred (no columns)", () => {
  it("sums real-number columns and leaves string columns blank", () => {
    const rows = [
      { name: "A", amount: 100, code: "X1" },
      { name: "B", amount: 250, code: "X2" },
    ];
    const totals = computeColumnTotals(rows);
    const amount = totals.find((t) => t.key === "amount")!;
    expect(amount.isNumeric).toBe(true);
    expect(amount.total).toBe(350);
    expect(amount.display).toBe("350");
    expect(totals.find((t) => t.key === "name")!.isNumeric).toBe(false);
    expect(totals.find((t) => t.key === "code")!.isNumeric).toBe(false);
  });

  it("returns [] for empty rows", () => {
    expect(computeColumnTotals([])).toEqual([]);
  });
});

describe("helpers", () => {
  it("hasAnyNumericTotal detects at least one summed column", () => {
    const rows = [{ a: "x", b: 1 }];
    expect(hasAnyNumericTotal(computeColumnTotals(rows))).toBe(true);
    expect(hasAnyNumericTotal(computeColumnTotals([{ a: "x", b: "y" }]))).toBe(false);
  });

  it("hasPercentColumn flags a percent column", () => {
    const cols: ExportColumn<Record<string, unknown>>[] = [{ key: "p", header: "P", format: "percent" }];
    expect(hasPercentColumn(computeColumnTotals([{ p: 12 }], cols))).toBe(true);
    expect(hasPercentColumn(computeColumnTotals([{ x: 1 }]))).toBe(false);
  });

  it("all-null numeric column yields null total (nothing to sum)", () => {
    const cols: ExportColumn<Record<string, unknown>>[] = [{ key: "n", header: "N", format: "number" }];
    const totals = computeColumnTotals([{ n: null }, { n: null }], cols);
    expect(totals[0].isNumeric).toBe(true);
    expect(totals[0].total).toBe(null);
    expect(totals[0].display).toBe("");
  });
});
