import { describe, it, expect } from "vitest";
import { buildBuyerVsLyReport, filterOutZeroReportRows, filterStylesForBlock, reportComp, reportPct } from "../buildBuyerVsLyReport";
import type { IpPlanningGridRow } from "../../../types/wholesale";

function row(over: Partial<IpPlanningGridRow>): IpPlanningGridRow {
  return {
    forecast_id: "f", sku_code: "S", sku_style: "S", sku_color: "black",
    customer_name: "Ross Stores", period_code: "2027-01",
    ly_reference_qty: 0, buyer_request_qty: 0,
    ...over,
  } as IpPlanningGridRow;
}

describe("buildBuyerVsLyReport", () => {
  it("pivots customer → style → color across periods with LY + TY blocks", () => {
    const rep = buildBuyerVsLyReport([
      row({ sku_color: "black", period_code: "2027-01", ly_reference_qty: 1000, buyer_request_qty: 1200 }),
      row({ sku_color: "black", period_code: "2027-02", ly_reference_qty: 800, buyer_request_qty: 754 }),
      row({ sku_color: "black camo", period_code: "2027-01", ly_reference_qty: 3620, buyer_request_qty: 4200 }),
    ]);
    expect(rep.periods.map((p) => p.tyLabel)).toEqual(["Jan-27", "Feb-27"]);
    expect(rep.periods.map((p) => p.lyLabel)).toEqual(["Jan-26", "Feb-26"]);
    const cust = rep.customers[0];
    expect(cust.customer).toBe("Ross Stores");
    const colors = cust.styles[0].colors;
    const black = colors.find((c) => c.color === "black")!;
    expect(black.ly).toEqual([1000, 800]);
    expect(black.ty).toEqual([1200, 754]);
    expect(black.tyTotal).toBe(1954);
    // customer period totals sum both colors for Jan.
    expect(cust.tyTotals[0]).toBe(1200 + 4200);
    expect(cust.lyTotals[0]).toBe(1000 + 3620);
  });

  it("keeps styles and customers separate and sorted", () => {
    const rep = buildBuyerVsLyReport([
      row({ customer_name: "Burlington", sku_style: "RCB1510", sku_color: "black", buyer_request_qty: 5 }),
      row({ customer_name: "Ross Stores", sku_style: "RYB0412PPK", sku_color: "black", buyer_request_qty: 9 }),
    ]);
    expect(rep.customers.map((c) => c.customer)).toEqual(["Burlington", "Ross Stores"]);
    expect(rep.customers[1].styles[0].style).toBe("RYB0412PPK");
  });

  it("aggregates multiple rows sharing the same (customer, style, color, period)", () => {
    const rep = buildBuyerVsLyReport([
      row({ buyer_request_qty: 100, ly_reference_qty: 50 }),
      row({ buyer_request_qty: 200, ly_reference_qty: 25 }),
    ]);
    const black = rep.customers[0].styles[0].colors[0];
    expect(black.ty).toEqual([300]);
    expect(black.ly).toEqual([75]);
  });

  it("skips aggregate rows", () => {
    const rep = buildBuyerVsLyReport([
      row({ buyer_request_qty: 100 }),
      row({ buyer_request_qty: 999, is_aggregate: true }),
    ]);
    expect(rep.customers[0].styles[0].colors[0].ty).toEqual([100]);
  });

  it("filterOutZeroReportRows drops only colors empty in BOTH blocks (union), plus empty styles/customers", () => {
    const rep = buildBuyerVsLyReport([
      row({ customer_name: "Ross Stores", sku_style: "A", sku_color: "buyonly", buyer_request_qty: 100, ly_reference_qty: 0 }),
      row({ customer_name: "Ross Stores", sku_style: "A", sku_color: "lyonly", buyer_request_qty: 0, ly_reference_qty: 500 }),
      row({ customer_name: "Ross Stores", sku_style: "A", sku_color: "both", buyer_request_qty: 200, ly_reference_qty: 300 }),
      row({ customer_name: "Empty Co", sku_style: "B", sku_color: "zero", buyer_request_qty: 0, ly_reference_qty: 0 }),
    ]);
    const ross = filterOutZeroReportRows(rep).customers.find((c) => c.customer === "Ross Stores")!;
    // buyonly + lyonly + both all have data in SOME block → kept; only fully-empty drops.
    expect(ross.styles[0].colors.map((c) => c.color).sort()).toEqual(["both", "buyonly", "lyonly"]);
    // "Empty Co" had only a fully-empty row → customer dropped entirely.
    expect(filterOutZeroReportRows(rep).customers.find((c) => c.customer === "Empty Co")).toBeUndefined();
  });

  it("filterStylesForBlock hides each block's own zeros", () => {
    const rep = buildBuyerVsLyReport([
      row({ customer_name: "Ross Stores", sku_style: "A", sku_color: "buyonly", buyer_request_qty: 100, ly_reference_qty: 0 }),
      row({ customer_name: "Ross Stores", sku_style: "A", sku_color: "lyonly", buyer_request_qty: 0, ly_reference_qty: 500 }),
      row({ customer_name: "Ross Stores", sku_style: "A", sku_color: "both", buyer_request_qty: 200, ly_reference_qty: 300 }),
    ]);
    const cust = rep.customers[0];
    const colorsIn = (block: "ly" | "ty" | "comp") =>
      filterStylesForBlock(cust, block).flatMap((s) => s.colors.map((c) => c.color)).sort();
    // Last-Year table: only colors that sold last year.
    expect(colorsIn("ly")).toEqual(["both", "lyonly"]);
    // Buyer table: only colors being bought.
    expect(colorsIn("ty")).toEqual(["both", "buyonly"]);
    // Comparison: anything active in either block.
    expect(colorsIn("comp")).toEqual(["both", "buyonly", "lyonly"]);
  });

  it("comp + pct helpers: new color (no LY) reads +100%", () => {
    expect(reportComp(600, 0)).toBe(600);
    expect(reportPct(600, 0)).toBe(1);       // brand new
    expect(reportPct(1200, 1000)).toBeCloseTo(0.2);
    expect(reportPct(0, 0)).toBeNull();      // 0 vs 0 → no %
  });
});


describe("buildBuyerVsLyReport metric = buy vs buyer", () => {
  const rows = [
    row({ sku_color: "black", period_code: "2027-01", ly_reference_qty: 1000, buyer_request_qty: 1200, planned_buy_qty: 1500 }),
    row({ sku_color: "black", period_code: "2027-02", ly_reference_qty: 800, buyer_request_qty: 754, planned_buy_qty: 900 }),
  ];

  it("default metric ('buyer') pivots buyer_request_qty into TY", () => {
    const black = buildBuyerVsLyReport(rows).customers[0].styles[0].colors[0];
    expect(black.ty).toEqual([1200, 754]);
    expect(black.tyTotal).toBe(1954);
  });

  it("metric = 'buy' pivots planned_buy_qty into TY (LY unchanged)", () => {
    const black = buildBuyerVsLyReport(rows, "buy").customers[0].styles[0].colors[0];
    expect(black.ty).toEqual([1500, 900]);
    expect(black.tyTotal).toBe(2400);
    expect(black.ly).toEqual([1000, 800]); // SP/LY identical to the Buyer report
  });
});

describe("reportMetricMeta", () => {
  it("labels the Buyer report", async () => {
    const { reportMetricMeta } = await import("../buildBuyerVsLyReport");
    expect(reportMetricMeta("buyer")).toMatchObject({ noun: "Buyer", title: "Buyer vs Last Year", fileStem: "buyer-vs-ly", sheet: "Buyer vs LY" });
  });
  it("labels the Buy report", async () => {
    const { reportMetricMeta } = await import("../buildBuyerVsLyReport");
    expect(reportMetricMeta("buy")).toMatchObject({ noun: "Buy", title: "Buy vs Last Year", fileStem: "buy-vs-ly", sheet: "Buy vs LY" });
  });
});
