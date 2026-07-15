import { describe, it, expect } from "vitest";
import {
  netDueCents,
  formatCents,
  addDaysISO,
  periodBounds,
  enumeratePeriods,
  filingDueDateISO,
  filingStatus,
  rollupByJurisdiction,
  summarizeLiability,
  type GLActivityRow,
} from "./taxLiability";

describe("netDueCents", () => {
  it("is collected minus remitted", () => {
    expect(netDueCents(19_808_68, 317_29)).toBe(19_491_39);
  });
  it("goes negative when over-remitted", () => {
    expect(netDueCents(100_00, 150_00)).toBe(-50_00);
  });
  it("rounds each operand to whole cents", () => {
    expect(netDueCents(100.4, 0.4)).toBe(100); // round(100.4)=100, round(0.4)=0
  });
});

describe("formatCents", () => {
  it("formats with thousands separators and two decimals", () => {
    expect(formatCents(19_491_39)).toBe("$19,491.39");
    expect(formatCents(8_230_74)).toBe("$8,230.74");
    expect(formatCents(5)).toBe("$0.05");
  });
  it("prefixes a minus for negatives", () => {
    expect(formatCents(-50_00)).toBe("-$50.00");
  });
});

describe("addDaysISO", () => {
  it("adds days across a month boundary", () => {
    expect(addDaysISO("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDaysISO("2026-06-30", 20)).toBe("2026-07-20");
  });
});

describe("periodBounds", () => {
  it("monthly returns the containing calendar month", () => {
    expect(periodBounds("monthly", "2026-02-15")).toEqual({
      start: "2026-02-01",
      end: "2026-02-28",
      label: "Feb 2026",
    });
  });
  it("quarterly aligns to the calendar quarter", () => {
    expect(periodBounds("quarterly", "2026-05-10")).toEqual({
      start: "2026-04-01",
      end: "2026-06-30",
      label: "Q2 2026",
    });
    expect(periodBounds("quarterly", "2026-01-01").label).toBe("Q1 2026");
    expect(periodBounds("quarterly", "2026-12-31").label).toBe("Q4 2026");
  });
  it("annual returns the calendar year", () => {
    expect(periodBounds("annual", "2026-07-14")).toEqual({
      start: "2026-01-01",
      end: "2026-12-31",
      label: "2026",
    });
  });
});

describe("enumeratePeriods", () => {
  it("enumerates whole months intersecting the range", () => {
    const p = enumeratePeriods("monthly", "2026-01-10", "2026-03-05");
    expect(p.map((x) => x.label)).toEqual(["Jan 2026", "Feb 2026", "Mar 2026"]);
    expect(p[0].start).toBe("2026-01-01");
    expect(p[2].end).toBe("2026-03-31");
  });
  it("enumerates calendar quarters across a year boundary", () => {
    const p = enumeratePeriods("quarterly", "2025-11-01", "2026-04-15");
    expect(p.map((x) => x.label)).toEqual(["Q4 2025", "Q1 2026", "Q2 2026"]);
  });
  it("returns a single period when range is inside one", () => {
    expect(enumeratePeriods("annual", "2026-03-01", "2026-09-01").map((x) => x.label)).toEqual(["2026"]);
  });
  it("returns empty on bad dates", () => {
    expect(enumeratePeriods("monthly", "nope", "2026-01-01")).toEqual([]);
  });
});

describe("filingDueDateISO", () => {
  it("adds the grace window to the period end", () => {
    expect(filingDueDateISO("2026-06-30", 20)).toBe("2026-07-20");
  });
});

describe("filingStatus", () => {
  const periodEnd = "2026-06-30";
  const due = "2026-07-20";
  it("passes through a recorded filed/paid status", () => {
    expect(filingStatus(periodEnd, due, "2026-08-01", "filed")).toBe("filed");
    expect(filingStatus(periodEnd, due, "2026-08-01", "paid")).toBe("paid");
  });
  it("is upcoming before the period closes", () => {
    expect(filingStatus(periodEnd, due, "2026-06-15")).toBe("upcoming");
  });
  it("is due after period close but before the deadline", () => {
    expect(filingStatus(periodEnd, due, "2026-07-10")).toBe("due");
  });
  it("is overdue past the deadline with no recorded filing", () => {
    expect(filingStatus(periodEnd, due, "2026-07-21")).toBe("overdue");
  });
});

describe("rollupByJurisdiction", () => {
  const rows: GLActivityRow[] = [
    { jurisdiction_code: "US", credit_cents: 1_000_00, debit_cents: 10_00 },
    { jurisdiction_code: "US", credit_cents: 500_00, debit_cents: 0 },
    { jurisdiction_code: "GB", credit_cents: 145_42, debit_cents: 0 },
  ];
  it("sums credits→collected, debits→remitted, and nets per jurisdiction", () => {
    const out = rollupByJurisdiction(rows);
    expect(out).toEqual([
      { jurisdiction_code: "GB", collected_cents: 145_42, remitted_cents: 0, net_due_cents: 145_42 },
      { jurisdiction_code: "US", collected_cents: 1_500_00, remitted_cents: 10_00, net_due_cents: 1_490_00 },
    ]);
  });
  it("ignores blank jurisdiction codes", () => {
    expect(rollupByJurisdiction([{ jurisdiction_code: "", credit_cents: 5, debit_cents: 0 }])).toEqual([]);
  });
});

describe("summarizeLiability", () => {
  it("totals collected/remitted/net and counts jurisdictions", () => {
    const s = summarizeLiability(rollupByJurisdiction([
      { jurisdiction_code: "US", credit_cents: 1_500_00, debit_cents: 10_00 },
      { jurisdiction_code: "GB", credit_cents: 145_42, debit_cents: 0 },
    ]));
    expect(s).toEqual({
      collected_cents: 1_645_42,
      remitted_cents: 10_00,
      net_due_cents: 1_635_42,
      jurisdiction_count: 2,
    });
  });
});
