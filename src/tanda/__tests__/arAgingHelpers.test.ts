// Tests for the pure AR-aging helpers — pivoting, per-account summary label,
// the Shopify-D2C exclude filter, and bucket totals.

import { describe, it, expect } from "vitest";
import {
  pivotViewRows, rpcRowsToPivot, sumBuckets, filterAgingRows, accountShortLabel,
  type ApiRow, type PivotRow,
} from "../arAgingHelpers";

describe("pivotViewRows", () => {
  it("collapses (customer, bucket) long rows to one row per customer", () => {
    const rows: ApiRow[] = [
      { customer_id: "c1", customer_name: "Acme", age_bucket: "current", outstanding_cents: 1000 },
      { customer_id: "c1", customer_name: "Acme", age_bucket: "31-60", outstanding_cents: 500 },
      { customer_id: "c2", customer_name: "Beta", age_bucket: "120+", outstanding_cents: 250 },
    ];
    const out = pivotViewRows(rows);
    expect(out).toHaveLength(2);
    const c1 = out.find((r) => r.customer_id === "c1")!;
    expect(c1.current).toBe(1000);
    expect(c1.b31_60).toBe(500);
    expect(c1.total).toBe(1500);
    const c2 = out.find((r) => r.customer_id === "c2")!;
    expect(c2.b120plus).toBe(250);
    expect(c2.total).toBe(250);
  });
});

describe("rpcRowsToPivot", () => {
  it("maps wide RPC rows into the local pivot shape", () => {
    const rows: ApiRow[] = [
      {
        customer_id: "c1", customer_name: "Acme",
        current_cents: 100, bucket_1_30_cents: 200, bucket_31_60_cents: 0,
        bucket_61_90_cents: 0, bucket_91_120_cents: 0, bucket_120_plus_cents: 50,
        total_outstanding_cents: 350,
      },
    ];
    const out = rpcRowsToPivot(rows);
    expect(out[0].current).toBe(100);
    expect(out[0].b1_30).toBe(200);
    expect(out[0].b120plus).toBe(50);
    expect(out[0].total).toBe(350);
  });
});

const mk = (id: string, name: string, total: number): PivotRow => ({
  customer_id: id, customer_name: name, customer_code: null,
  current: total, b1_30: 0, b31_60: 0, b61_90: 0, b91_120: 0, b120plus: 0, total,
});

describe("filterAgingRows", () => {
  const rows = [mk("c1", "Acme", 1000), mk("shop1", "Shopify rof-clothing", 500), mk("c2", "Beta", 250)];

  it("passes everything through with no options", () => {
    expect(filterAgingRows(rows, {})).toHaveLength(3);
  });
  it("matches the free-text filter on name", () => {
    expect(filterAgingRows(rows, { customerText: "acme" })).toHaveLength(1);
  });
  it("excludes the Shopify D2C ids when asked", () => {
    const out = filterAgingRows(rows, { excludeIds: new Set(["shop1"]) });
    expect(out.map((r) => r.customer_id)).toEqual(["c1", "c2"]);
  });
  it("combines text + exclude", () => {
    const out = filterAgingRows(rows, { customerText: "e", excludeIds: new Set(["shop1"]) });
    // "Acme" and "Beta" contain 'e'; shop1 excluded
    expect(out.map((r) => r.customer_id).sort()).toEqual(["c1", "c2"]);
  });
});

describe("sumBuckets", () => {
  it("sums every bucket + total across rows", () => {
    const rows: PivotRow[] = [
      { customer_id: "c1", customer_name: null, customer_code: null, current: 10, b1_30: 20, b31_60: 0, b61_90: 0, b91_120: 0, b120plus: 5, total: 35 },
      { customer_id: "c2", customer_name: null, customer_code: null, current: 1, b1_30: 2, b31_60: 3, b61_90: 4, b91_120: 5, b120plus: 6, total: 21 },
    ];
    const t = sumBuckets(rows);
    expect(t.current).toBe(11);
    expect(t.b1_30).toBe(22);
    expect(t.b120plus).toBe(11);
    expect(t.total).toBe(56);
  });
  it("returns all-zero for an empty set", () => {
    expect(sumBuckets([])).toEqual({ current: 0, b1_30: 0, b31_60: 0, b61_90: 0, b91_120: 0, b120plus: 0, total: 0 });
  });
});

describe("accountShortLabel", () => {
  it("maps the known AR control codes to friendly labels", () => {
    expect(accountShortLabel("1108", "Accounts Receivable (house)")).toBe("1108 · House");
    expect(accountShortLabel("1107", "Accounts Receivable - Factor")).toBe("1107 · Factored");
    expect(accountShortLabel("1105", "AR - Credit Card")).toBe("1105 · Credit-card");
  });
  it("falls back to the code, then the name", () => {
    expect(accountShortLabel("9999", "Something")).toBe("9999");
    expect(accountShortLabel(null, "Only Name")).toBe("Only Name");
    expect(accountShortLabel(null, null)).toBe("(unmapped)");
  });
});
