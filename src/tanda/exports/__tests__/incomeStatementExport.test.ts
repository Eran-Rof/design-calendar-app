import { describe, it, expect } from "vitest";
import {
  buildIncomeStatementHtml, buildIncomeStatementWorkbook, type StatementModel, type StmtLine,
} from "../incomeStatementExport";

function model(overrides: Partial<StatementModel> = {}): StatementModel {
  const lines: StmtLine[] = [
    { kind: "section", label: "Revenue", indent: 0, hasValues: false },
    { kind: "account", code: "4005", label: "Sales Revenue ROF Brands", indent: 1, byMonth: { "2026-01": 100000, "2026-02": 200000 }, total: 300000 },
    { kind: "subtotal", label: "Total Revenue", indent: 0, byMonth: { "2026-01": 100000, "2026-02": 200000 }, total: 300000 },
    { kind: "band_strong", label: "NET SALES", indent: 0, byMonth: { "2026-01": 100000, "2026-02": 200000 }, total: 300000 },
    { kind: "section", label: "Operating Expenses", indent: 0, hasValues: false },
    { kind: "account", code: "6010", label: "Rent", indent: 1, byMonth: { "2026-01": 50000, "2026-02": 50000 }, total: 100000 },
    { kind: "subtotal", label: "Total Operating Expenses", indent: 0, byMonth: { "2026-01": 50000, "2026-02": 50000 }, total: 100000 },
    { kind: "band_strong", label: "NET INCOME", indent: 0, byMonth: { "2026-01": 50000, "2026-02": -350000 }, total: -300000 },
  ];
  return {
    company: "Ring of Fire",
    reportTitle: "Income Statement",
    periodLabel: "January 1, 2026 through February 28, 2026",
    basisLabel: "Accrual basis",
    printedLabel: "Printed 2/28/2026",
    months: [{ key: "2026-01", label: "Jan 2026" }, { key: "2026-02", label: "Feb 2026" }],
    showPct: true,
    hideAccountNum: false,
    netSalesBase: 300000,
    lines,
    ...overrides,
  };
}

describe("incomeStatementExport — HTML (PDF) statement", () => {
  it("renders the report header block", () => {
    const html = buildIncomeStatementHtml(model());
    expect(html).toContain("Ring of Fire");
    expect(html).toContain("Income Statement");
    expect(html).toContain("January 1, 2026 through February 28, 2026");
    expect(html).toContain("Accrual basis");
  });

  it("shows negatives in parentheses and positives with $ + thousands separators", () => {
    const html = buildIncomeStatementHtml(model());
    expect(html).toContain("$3,000.00");     // 300000 cents total
    expect(html).toContain("($3,500.00)");   // -350000 cents month → parentheses
    expect(html).toContain("($3,000.00)");   // net income negative total
  });

  it("emits monthly columns + Total header and a % of Net Sales column", () => {
    const html = buildIncomeStatementHtml(model());
    expect(html).toContain("Jan 2026");
    expect(html).toContain("Feb 2026");
    expect(html).toContain(">Total<");
    expect(html).toContain("% of Net Sales");
    expect(html).toContain("100.0%"); // net sales / net sales base
  });

  it("marks band + section rows for statement styling", () => {
    const html = buildIncomeStatementHtml(model());
    expect(html).toContain('class="row section');
    expect(html).toMatch(/class="row band strong/);
  });

  it("collapses to a single Amount column in single-period mode", () => {
    const html = buildIncomeStatementHtml(model({ months: [] }));
    expect(html).toContain(">Amount<");
    expect(html).not.toContain("Jan 2026");
  });

  it("hides the Account # column when requested", () => {
    const withNums = buildIncomeStatementHtml(model());
    const without = buildIncomeStatementHtml(model({ hideAccountNum: true }));
    expect(withNums).toContain("Account #");
    expect(without).not.toContain("Account #");
  });
});

describe("incomeStatementExport — xlsx workbook", () => {
  it("builds a workbook without throwing (one sheet)", () => {
    const wb = buildIncomeStatementWorkbook(model());
    expect(wb.worksheets.length).toBeGreaterThanOrEqual(1);
  });
  it("builds in single-period + hidden-account-# mode", () => {
    const wb = buildIncomeStatementWorkbook(model({ months: [], hideAccountNum: true, showPct: false }));
    expect(wb.worksheets.length).toBeGreaterThanOrEqual(1);
  });
});
