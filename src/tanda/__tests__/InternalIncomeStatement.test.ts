import { describe, it, expect } from "vitest";
import { classifyBand, monthsInRange } from "../InternalIncomeStatement";

// These lock the band classification + month-column enumeration that drive the
// Income Statement's Net Sales / COGS / Gross Profit / OpEx / Other bands. The
// classification reproduces the CEO's May-2026 Xoro figures (Net Sales ties to
// the cent; the cost bands within GL rounding).

describe("classifyBand", () => {
  it("operating sales revenue (code < 4900) → revenue", () => {
    expect(classifyBand("revenue", "4005", "Sales Revenue ROF Brands")).toBe("revenue");
    expect(classifyBand("revenue", "4015", "Shipping income - web")).toBe("revenue");
    expect(classifyBand("revenue", "4003", "Other Income Detail")).toBe("revenue");
  });

  it("non-operating income (code ≥ 4900) → other_inc", () => {
    expect(classifyBand("revenue", "4900", "Exchange Rate Gain/Loss")).toBe("other_inc");
    expect(classifyBand("revenue", "4905", "Shipping Income")).toBe("other_inc");
  });

  it("all contra_revenue → contra (deducted to Net Sales)", () => {
    expect(classifyBand("contra_revenue", "4212", "Chargebacks - Burlington")).toBe("contra");
    expect(classifyBand("contra_revenue", "4230", "Sales Discount")).toBe("contra");
  });

  it("product cost 5xxx → cogs", () => {
    expect(classifyBand("expense", "5010", "Cost of Goods Sold ROF Brands")).toBe("cogs");
    expect(classifyBand("expense", "5001", "*Cost of Goods Sold")).toBe("cogs");
    expect(classifyBand("expense", "5402", "Freight In Expense")).toBe("cogs");
    expect(classifyBand("expense", "5403", "Freight Out Expense")).toBe("cogs");
  });

  it("non-product operating 5xxx (clearing/tickets/shipping) → opex", () => {
    expect(classifyBand("expense", "5020", "Manufacturing Expense Clearing")).toBe("opex");
    expect(classifyBand("expense", "5022", "Macys Private Label Tickets")).toBe("opex");
    expect(classifyBand("expense", "5023", "Ross Price Tickets")).toBe("opex");
    expect(classifyBand("expense", "5405", "Shipping Expense")).toBe("opex");
  });

  it("6xxx–7xxx expense → opex", () => {
    expect(classifyBand("expense", "6119", "Payroll Expense - Salaries")).toBe("opex");
    expect(classifyBand("expense", "6360", "Rent Expense")).toBe("opex");
    expect(classifyBand("expense", "7119", "PT - tradeshow")).toBe("opex");
  });

  it("8xxx+ expense → other_exp", () => {
    expect(classifyBand("expense", "8001", "Penny Rounding Adjustments")).toBe("other_exp");
  });
});

describe("monthsInRange", () => {
  it("enumerates each month inclusive, across a year boundary", () => {
    const m = monthsInRange("2025-11-01", "2026-02-28");
    expect(m.map((x) => x.key)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(m[0].label).toBe("Nov '25");
    expect(m[3].label).toBe("Feb '26");
  });

  it("a single-month range yields one column", () => {
    expect(monthsInRange("2026-05-01", "2026-05-31").map((x) => x.key)).toEqual(["2026-05"]);
  });

  it("a three-month range yields three columns", () => {
    expect(monthsInRange("2026-03-01", "2026-05-31")).toHaveLength(3);
  });
});
