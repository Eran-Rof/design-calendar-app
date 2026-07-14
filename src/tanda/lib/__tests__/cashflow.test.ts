import { describe, it, expect } from "vitest";
import { classifyCashflowSection, reconcileCashFlow, type CashflowRow } from "../cashflow";

describe("classifyCashflowSection — matches migration 20260993000000 ranges", () => {
  it("classifies cash & cash equivalents (1000–1030)", () => {
    for (const code of ["1000", "1001", "1002", "1003", "1010", "1011", "1020", "1030"]) {
      expect(classifyCashflowSection("asset", code)).toBe("cash");
    }
  });

  it("classifies operating working-capital assets", () => {
    expect(classifyCashflowSection("asset", "1100")).toBe("operating"); // A/R
    expect(classifyCashflowSection("asset", "1107")).toBe("operating"); // A/R - factor
    expect(classifyCashflowSection("asset", "1051")).toBe("operating"); // factor advances
    expect(classifyCashflowSection("asset", "1201")).toBe("operating"); // inventory
    expect(classifyCashflowSection("asset", "1210")).toBe("operating"); // consignment inv
    expect(classifyCashflowSection("asset", "1301")).toBe("operating"); // prepaid
    expect(classifyCashflowSection("asset", "1308")).toBe("operating"); // vendor prepayments
    expect(classifyCashflowSection("asset", "1403")).toBe("operating"); // ERC receivable
  });

  it("classifies investing long-term assets", () => {
    expect(classifyCashflowSection("asset", "1503")).toBe("investing"); // building
    expect(classifyCashflowSection("asset", "1590")).toBe("investing"); // accum deprec (asset-typed)
    expect(classifyCashflowSection("asset", "1305")).toBe("investing"); // warehouse deposit
    expect(classifyCashflowSection("asset", "1601")).toBe("investing"); // trademark
    expect(classifyCashflowSection("asset", "1453")).toBe("investing"); // notes receivable
  });

  it("classifies operating liabilities", () => {
    expect(classifyCashflowSection("liability", "2000")).toBe("operating"); // A/P
    expect(classifyCashflowSection("liability", "2010")).toBe("operating"); // accrued
    expect(classifyCashflowSection("liability", "2105")).toBe("operating"); // credit card
    expect(classifyCashflowSection("liability", "2200")).toBe("operating"); // customer deposits
    expect(classifyCashflowSection("liability", "2300")).toBe("operating"); // sales tax
    expect(classifyCashflowSection("liability", "2401")).toBe("operating"); // payroll payable
    expect(classifyCashflowSection("liability", "2450")).toBe("operating"); // inventory offset
  });

  it("classifies financing debt + equity", () => {
    expect(classifyCashflowSection("liability", "2460")).toBe("financing"); // factor loan
    expect(classifyCashflowSection("liability", "2503")).toBe("financing"); // loan payable
    expect(classifyCashflowSection("liability", "2701")).toBe("financing"); // LT auto note
    expect(classifyCashflowSection("liability", "2805")).toBe("financing"); // SBA EIDL
    expect(classifyCashflowSection("liability", "2251")).toBe("financing"); // due to affiliates
    expect(classifyCashflowSection("equity", "3000")).toBe("financing");    // capital
    expect(classifyCashflowSection("equity", "3001")).toBe("financing");    // distribution
    expect(classifyCashflowSection("equity", "3900")).toBe("financing");    // retained earnings
  });

  it("returns null for P&L accounts (they flow through Net Income)", () => {
    expect(classifyCashflowSection("revenue", "4005")).toBeNull();
    expect(classifyCashflowSection("contra_revenue", "4900")).toBeNull();
    expect(classifyCashflowSection("expense", "6135")).toBeNull();
  });

  it("returns null for an unmapped balance-sheet code (→ residual)", () => {
    expect(classifyCashflowSection("asset", "1999")).toBeNull();
    expect(classifyCashflowSection("liability", "2999")).toBeNull();
  });
});

describe("reconcileCashFlow — footing", () => {
  // Dec-2024 foot-check figures (cents) verified against the live RPC on prod.
  const rows: CashflowRow[] = [
    { section: "operating", line_item: "Net Income", amount_cents: -74328369 },
    { section: "operating", line_item: "Change in Accounts Receivable", amount_cents: 100428063 },
    { section: "operating", line_item: "Net cash from operating activities", amount_cents: -115512663 },
    { section: "investing", line_item: "Purchases of Property & Equipment (net)", amount_cents: -6935600 },
    { section: "investing", line_item: "Net cash from investing activities", amount_cents: 18064400 },
    { section: "financing", line_item: "Owner Contributions & Distributions (net)", amount_cents: 505172097 },
    { section: "financing", line_item: "Net cash from financing activities", amount_cents: 91956441 },
    { section: "_cash_reference", line_item: "Beginning Cash", amount_cents: 21602236 },
    { section: "_cash_reference", line_item: "Ending Cash", amount_cents: 16110414 },
  ];

  it("nets the three sections and foots to Δcash", () => {
    const r = reconcileCashFlow(rows);
    expect(r.operating).toBe(-115512663);
    expect(r.investing).toBe(18064400);
    expect(r.financing).toBe(91956441);
    expect(r.netChange).toBe(-5491822);
    expect(r.endingCash - r.beginningCash).toBe(r.netChange);
    expect(r.gap).toBe(0);
    expect(r.foots).toBe(true);
  });

  it("flags a statement that does not foot", () => {
    const broken = rows.map((x) =>
      x.line_item === "Ending Cash" ? { ...x, amount_cents: x.amount_cents + 5000 } : x,
    );
    const r = reconcileCashFlow(broken);
    expect(r.foots).toBe(false);
    expect(Math.abs(r.gap)).toBe(5000);
  });

  it("treats missing rows as zero", () => {
    const r = reconcileCashFlow([]);
    expect(r.netChange).toBe(0);
    expect(r.foots).toBe(true);
  });
});
