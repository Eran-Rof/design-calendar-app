// Today drill-to-subset pure filters (#1826 follow-up).
// Exercises the exact selection logic the Allocations Workbench (?focus=) and
// 3-Way Match (?tw=exceptions) panels apply to their loaded rows.

import { describe, it, expect } from "vitest";
import {
  addDaysISO,
  matchesAllocationFocus,
  filterAllocationFocus,
  allocationFocusLabel,
  filterThreeWayExceptions,
  isThreeWayException,
  type AllocFocusRow,
} from "../todayDrillFilters";

const TODAY = "2026-07-16"; // plus7 = 2026-07-23, plus14 = 2026-07-30

describe("addDaysISO", () => {
  it("adds days across a month boundary (UTC-anchored)", () => {
    expect(addDaysISO("2026-07-16", 7)).toBe("2026-07-23");
    expect(addDaysISO("2026-07-30", 14)).toBe("2026-08-13");
    expect(addDaysISO("2026-07-16", 0)).toBe("2026-07-16");
  });
});

// ── Allocation focus ─────────────────────────────────────────────────────────
const row = (over: Partial<AllocFocusRow>): AllocFocusRow => ({
  open_qty: 5,
  requested_ship_date: null,
  is_factored: false,
  factor_approval_status: null,
  factor_reference: null,
  ...over,
});

describe("matchesAllocationFocus — ship_due", () => {
  it("selects open lines shipping today..+7d inclusive", () => {
    expect(matchesAllocationFocus(row({ requested_ship_date: "2026-07-16" }), "ship_due", TODAY)).toBe(true); // today
    expect(matchesAllocationFocus(row({ requested_ship_date: "2026-07-18" }), "ship_due", TODAY)).toBe(true);
    expect(matchesAllocationFocus(row({ requested_ship_date: "2026-07-23" }), "ship_due", TODAY)).toBe(true); // +7 boundary
  });
  it("excludes beyond 7d, past dates, zero-open, and null dates", () => {
    expect(matchesAllocationFocus(row({ requested_ship_date: "2026-07-24" }), "ship_due", TODAY)).toBe(false);
    expect(matchesAllocationFocus(row({ requested_ship_date: "2026-07-10" }), "ship_due", TODAY)).toBe(false);
    expect(matchesAllocationFocus(row({ requested_ship_date: "2026-07-18", open_qty: 0 }), "ship_due", TODAY)).toBe(false);
    expect(matchesAllocationFocus(row({ requested_ship_date: null }), "ship_due", TODAY)).toBe(false);
  });
});

describe("matchesAllocationFocus — ship_overdue", () => {
  it("selects only open lines strictly before today", () => {
    expect(matchesAllocationFocus(row({ requested_ship_date: "2026-07-10" }), "ship_overdue", TODAY)).toBe(true);
    expect(matchesAllocationFocus(row({ requested_ship_date: "2026-07-16" }), "ship_overdue", TODAY)).toBe(false); // today not overdue
    expect(matchesAllocationFocus(row({ requested_ship_date: "2026-07-20" }), "ship_overdue", TODAY)).toBe(false);
    expect(matchesAllocationFocus(row({ requested_ship_date: "2026-07-10", open_qty: 0 }), "ship_overdue", TODAY)).toBe(false);
  });
});

describe("matchesAllocationFocus — factor_gate", () => {
  it("selects factored, open, not-fully-approved lines shipping ≤14d", () => {
    // pending approval, within window
    expect(matchesAllocationFocus(row({ is_factored: true, factor_approval_status: "pending", requested_ship_date: "2026-07-20" }), "factor_gate", TODAY)).toBe(true);
    // approved status but NO factor_reference → still gated
    expect(matchesAllocationFocus(row({ is_factored: true, factor_approval_status: "approved", factor_reference: "", requested_ship_date: "2026-07-20" }), "factor_gate", TODAY)).toBe(true);
    // overdue factored line (no lower bound) still counts
    expect(matchesAllocationFocus(row({ is_factored: true, factor_approval_status: "pending", requested_ship_date: "2026-07-10" }), "factor_gate", TODAY)).toBe(true);
  });
  it("excludes fully approved, non-factored, beyond 14d, and null-date lines", () => {
    expect(matchesAllocationFocus(row({ is_factored: true, factor_approval_status: "approved", factor_reference: "REF1", requested_ship_date: "2026-07-20" }), "factor_gate", TODAY)).toBe(false);
    expect(matchesAllocationFocus(row({ is_factored: false, requested_ship_date: "2026-07-20" }), "factor_gate", TODAY)).toBe(false);
    expect(matchesAllocationFocus(row({ is_factored: true, factor_approval_status: "pending", requested_ship_date: "2026-07-31" }), "factor_gate", TODAY)).toBe(false);
    expect(matchesAllocationFocus(row({ is_factored: true, factor_approval_status: "pending", requested_ship_date: null }), "factor_gate", TODAY)).toBe(false);
  });
});

describe("filterAllocationFocus / labels", () => {
  const rows: AllocFocusRow[] = [
    row({ requested_ship_date: "2026-07-18" }),                                             // ship_due
    row({ requested_ship_date: "2026-07-10" }),                                             // overdue
    row({ is_factored: true, factor_approval_status: "pending", requested_ship_date: "2026-07-20" }), // factor + ship_due
    row({ requested_ship_date: "2026-09-01" }),                                             // none
  ];
  it("ship_due picks the two lines inside the 7-day window", () => {
    expect(filterAllocationFocus(rows, "ship_due", TODAY)).toHaveLength(2);
  });
  it("ship_overdue picks the single past line", () => {
    expect(filterAllocationFocus(rows, "ship_overdue", TODAY)).toHaveLength(1);
  });
  it("factor_gate picks the single factored line", () => {
    expect(filterAllocationFocus(rows, "factor_gate", TODAY)).toHaveLength(1);
  });
  it("labels name the focus and count", () => {
    expect(allocationFocusLabel("ship_due", 12)).toBe("Showing 12 lines shipping in the next 7 days");
    expect(allocationFocusLabel("ship_overdue", 1)).toBe("Showing 1 line past their ship date");
    expect(allocationFocusLabel("factor_gate", 3)).toContain("factor approval");
  });
});

// ── 3-Way Match exceptions ───────────────────────────────────────────────────
describe("filterThreeWayExceptions", () => {
  const drafts = [
    { three_way_match_status: "pending" },
    { three_way_match_status: "matched" },
    { three_way_match_status: "variance" },
    { three_way_match_status: "exception" },
    { three_way_match_status: "posted" },
    { three_way_match_status: "rejected" },
    { three_way_match_status: null },
  ];
  it("keeps only variance + exception", () => {
    const out = filterThreeWayExceptions(drafts);
    expect(out.map((d) => d.three_way_match_status)).toEqual(["variance", "exception"]);
  });
  it("isThreeWayException matches the exception-grade statuses only", () => {
    expect(isThreeWayException({ three_way_match_status: "variance" })).toBe(true);
    expect(isThreeWayException({ three_way_match_status: "exception" })).toBe(true);
    expect(isThreeWayException({ three_way_match_status: "matched" })).toBe(false);
    expect(isThreeWayException({ three_way_match_status: null })).toBe(false);
  });
});
