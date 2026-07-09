// Drill-through Phase 2 — pure-core tests.
//
//   • aging bucket math (ar-aging/detail, ap-aging/detail) must replicate the
//     report SQL exactly (v_ar_aging / ar_aging_as_of / v_ap_aging_buckets /
//     ap_aging_as_of CASE expressions) or drill lists stop tying to cells.
//   • segment-pl/gl-drill's cell→account mapping must mirror both the panel's
//     column-filter semantics and the revenue bridge's routing.

import { describe, it, expect } from "vitest";
import {
  daysPastDue,
  arBucketFor,
  parseDetailQuery as parseArDetail,
} from "../internal/ar-aging/detail.js";
import { apBucketFor, parseDetailQuery as parseApDetail } from "../internal/ap-aging/detail.js";
import { channelFromDims, rowMatches, mapCellToAccounts } from "../internal/segment-pl/gl-drill.js";

describe("aging bucket math", () => {
  it("daysPastDue matches SQL integer date subtraction", () => {
    expect(daysPastDue("2026-07-09", "2026-07-09")).toBe(0);
    expect(daysPastDue("2026-07-09", "2026-06-09")).toBe(30);
    expect(daysPastDue("2026-07-09", "2026-08-01")).toBe(-23);
    expect(daysPastDue("2026-07-09", null)).toBeNull();
  });

  it("AR buckets replicate the v_ar_aging CASE boundaries", () => {
    expect(arBucketFor(null)).toBe("current");
    expect(arBucketFor(0)).toBe("current");
    expect(arBucketFor(-5)).toBe("current");
    expect(arBucketFor(1)).toBe("1-30");
    expect(arBucketFor(30)).toBe("1-30");
    expect(arBucketFor(31)).toBe("31-60");
    expect(arBucketFor(60)).toBe("31-60");
    expect(arBucketFor(61)).toBe("61-90");
    expect(arBucketFor(90)).toBe("61-90");
    expect(arBucketFor(91)).toBe("91-120");
    expect(arBucketFor(120)).toBe("91-120");
    expect(arBucketFor(121)).toBe("120+");
  });

  it("AP buckets replicate the v_ap_aging_buckets CASE boundaries (91+ merged)", () => {
    expect(apBucketFor(null)).toBe("current");
    expect(apBucketFor(0)).toBe("current");
    expect(apBucketFor(30)).toBe("1-30");
    expect(apBucketFor(60)).toBe("31-60");
    expect(apBucketFor(90)).toBe("61-90");
    expect(apBucketFor(91)).toBe("91+");
    expect(apBucketFor(500)).toBe("91+");
  });

  it("query parsers validate bucket / as_of / party id", () => {
    const q = (s) => new URLSearchParams(s);
    expect(parseArDetail(q("bucket=61-90")).data.bucket).toBe("61-90");
    expect(parseArDetail(q("bucket=nope")).error).toMatch(/bucket/);
    expect(parseArDetail(q("bucket=total&as_of=2026-13-01")).error).toMatch(/as_of/);
    expect(parseArDetail(q("bucket=total&customer_id=xyz")).error).toMatch(/customer_id/);
    expect(parseApDetail(q("bucket=91%2B")).data.bucket).toBe("91+");
    expect(parseApDetail(q("bucket=91-120")).error).toMatch(/bucket/); // AR-only bucket
  });
});

describe("segment-pl gl-drill mapping", () => {
  it("channelFromDims: DTC store-scoped, else wholesale", () => {
    expect(channelFromDims("WHOLESALE", "Main Warehouse")).toBe("wholesale");
    expect(channelFromDims("DTC", "PT Ecom")).toBe("ecom_pt");
    expect(channelFromDims("DTC", "ROF Ecom")).toBe("ecom_rof");
  });

  const rows = [
    // (brand, channel, store, gender, is_pl, net, cogs)
    { brand_code: "ROF", channel_code: "WHOLESALE", store_key: "Main Warehouse", gender_code: "M", is_pl: false, net_sales: 1000, cogs: 600 },
    { brand_code: "ROF", channel_code: "WHOLESALE", store_key: "Main Warehouse", gender_code: "B", is_pl: false, net_sales: 500, cogs: 300 },
    { brand_code: "MPLEPIC", channel_code: "WHOLESALE", store_key: "Main Warehouse", gender_code: "M", is_pl: true, net_sales: 800, cogs: 500 },
    { brand_code: "PT", channel_code: "DTC", store_key: "PT Ecom", gender_code: "M", is_pl: false, net_sales: 200, cogs: null },
    { brand_code: "ROF", channel_code: "DTC", store_key: "ROF Ecom", gender_code: "W", is_pl: false, net_sales: 300, cogs: null },
  ];

  it("routes a Private-Label cell 1:1 to 4012 and flags nothing shared", () => {
    const out = mapCellToAccounts(rows, { brands: ["MPLEPIC"], channels: [], stores: [], genders: [] }, "net_sales");
    expect(out.accounts).toEqual([{ code: "4012", subledger_amount: 800, shared: false }]);
    expect(out.subledger_total).toBe(800);
  });

  it("routes the Total cell across all revenue buckets", () => {
    const out = mapCellToAccounts(rows, { brands: [], channels: [], stores: [], genders: [] }, "net_sales");
    expect(out.accounts.map((a) => a.code)).toEqual(["4005", "4006", "4008", "4011", "4012"]);
    expect(out.subledger_total).toBe(2800);
    // Total leaves nothing outside → nothing shared.
    expect(out.accounts.every((a) => !a.shared)).toBe(true);
  });

  it("marks catch-all 4005 shared when the cell excludes other rows routing there", () => {
    // Men's wholesale ROF cell — 4005; but nothing else routes to 4005 here.
    const men = mapCellToAccounts(rows, { brands: ["ROF"], channels: ["WHOLESALE"], stores: [], genders: ["M"] }, "net_sales");
    expect(men.accounts).toEqual([{ code: "4005", subledger_amount: 1000, shared: false }]);
    // Add another non-matching row that also routes 4005 → shared flips on.
    const rows2 = [...rows, { brand_code: "AXECROWN", channel_code: "WHOLESALE", store_key: "Main Warehouse", gender_code: "M", is_pl: false, net_sales: 50, cogs: 20 }];
    const men2 = mapCellToAccounts(rows2, { brands: ["ROF"], channels: ["WHOLESALE"], stores: [], genders: ["M"] }, "net_sales");
    expect(men2.accounts).toEqual([{ code: "4005", subledger_amount: 1000, shared: true }]);
  });

  it("COGS measure routes to the 50xx twins and skips costless rows", () => {
    const out = mapCellToAccounts(rows, { brands: [], channels: [], stores: [], genders: [] }, "cogs");
    expect(out.accounts.map((a) => a.code)).toEqual(["5010", "5011", "5015"]);
    expect(out.subledger_total).toBe(1400);
    expect(out.cogs_unknown).toBe(true); // the two ecom rows have null cogs
  });

  it("gender filter matches '(none)' for null gender rows", () => {
    const r = { brand_code: "ROF", channel_code: "WHOLESALE", store_key: "Main Warehouse", gender_code: null, is_pl: false, net_sales: 10, cogs: 5 };
    expect(rowMatches(r, { brands: [], channels: [], stores: [], genders: ["(none)"] })).toBe(true);
    expect(rowMatches(r, { brands: [], channels: [], stores: [], genders: ["M"] })).toBe(false);
  });
});
