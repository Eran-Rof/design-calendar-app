// Tests for the balance-sheet handler (P5-4).
//
// Pure-JS — exercises validateQuery + isISODate without DB.
// Per docs/tangerine/P5-close-core-financials-architecture.md §6.

import { describe, it, expect } from "vitest";
import { validateQuery, isISODate } from "../../_handlers/internal/balance-sheet/index.js";

function P(o) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) sp.set(k, String(v));
  return sp;
}

const ISO_TODAY_RE = /^\d{4}-\d{2}-\d{2}$/;

describe("isISODate", () => {
  it("accepts YYYY-MM-DD", () => {
    expect(isISODate("2026-05-27")).toBe(true);
    expect(isISODate("2000-01-01")).toBe(true);
    expect(isISODate("2099-12-31")).toBe(true);
  });

  it("rejects malformed dates", () => {
    expect(isISODate("2026-5-27")).toBe(false);   // not zero-padded
    expect(isISODate("26-05-27")).toBe(false);    // wrong year width
    expect(isISODate("2026/05/27")).toBe(false);
    expect(isISODate("")).toBe(false);
    expect(isISODate(null)).toBe(false);
    expect(isISODate(undefined)).toBe(false);
    expect(isISODate(20260527)).toBe(false);      // not string
  });

  it("rejects calendar-invalid dates", () => {
    expect(isISODate("2026-02-30")).toBe(false);  // Feb 30 doesn't exist
    expect(isISODate("2026-13-01")).toBe(false);  // month 13
    expect(isISODate("2026-04-31")).toBe(false);  // April has 30 days
    expect(isISODate("2026-00-15")).toBe(false);  // month 0
  });
});

describe("validateQuery — basis", () => {
  it("rejects missing basis", () => {
    const v = validateQuery(P({}));
    expect(v.error).toMatch(/basis/);
  });

  it("rejects blank basis", () => {
    const v = validateQuery(P({ basis: "   " }));
    expect(v.error).toMatch(/basis/);
  });

  it("rejects unknown basis values", () => {
    expect(validateQuery(P({ basis: "BOTH" })).error).toMatch(/basis/);
    expect(validateQuery(P({ basis: "accrual" })).error).toMatch(/basis/);  // lowercase rejected
    expect(validateQuery(P({ basis: "Cash" })).error).toMatch(/basis/);
    expect(validateQuery(P({ basis: "X" })).error).toMatch(/basis/);
  });

  it("accepts ACCRUAL", () => {
    const v = validateQuery(P({ basis: "ACCRUAL" }));
    expect(v.error).toBeUndefined();
    expect(v.data.basis).toBe("ACCRUAL");
  });

  it("accepts CASH", () => {
    const v = validateQuery(P({ basis: "CASH" }));
    expect(v.error).toBeUndefined();
    expect(v.data.basis).toBe("CASH");
  });
});

describe("validateQuery — as_of", () => {
  it("defaults to today (UTC YYYY-MM-DD) when omitted", () => {
    const v = validateQuery(P({ basis: "ACCRUAL" }));
    expect(v.error).toBeUndefined();
    expect(v.data.as_of).toMatch(ISO_TODAY_RE);
    // Should match today's UTC date.
    const today = new Date().toISOString().slice(0, 10);
    expect(v.data.as_of).toBe(today);
  });

  it("accepts a valid ISO date", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", as_of: "2026-05-27" }));
    expect(v.error).toBeUndefined();
    expect(v.data.as_of).toBe("2026-05-27");
  });

  it("rejects invalid as_of formats", () => {
    expect(validateQuery(P({ basis: "ACCRUAL", as_of: "yesterday" })).error).toMatch(/as_of/);
    expect(validateQuery(P({ basis: "ACCRUAL", as_of: "2026/05/27" })).error).toMatch(/as_of/);
    expect(validateQuery(P({ basis: "ACCRUAL", as_of: "2026-5-27" })).error).toMatch(/as_of/);
  });

  it("rejects calendar-invalid as_of", () => {
    expect(validateQuery(P({ basis: "ACCRUAL", as_of: "2026-02-31" })).error).toMatch(/as_of/);
  });

  it("treats blank as_of as missing (defaults to today)", () => {
    const v = validateQuery(P({ basis: "CASH", as_of: "  " }));
    expect(v.error).toBeUndefined();
    expect(v.data.as_of).toMatch(ISO_TODAY_RE);
  });

  it("combines basis + as_of correctly", () => {
    const v = validateQuery(P({ basis: "CASH", as_of: "2025-12-31" }));
    expect(v.error).toBeUndefined();
    expect(v.data.basis).toBe("CASH");
    expect(v.data.as_of).toBe("2025-12-31");
  });
});

describe("validateQuery — error short-circuits", () => {
  it("basis error reports before as_of validation even with bad as_of", () => {
    const v = validateQuery(P({ basis: "BOGUS", as_of: "not-a-date" }));
    expect(v.error).toMatch(/basis/);
  });
});
