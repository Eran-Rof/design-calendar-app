// Tests for the income-statement handler (P5-3).
// Pure-JS — exercises validateQuery + isISODate without DB.

import { describe, it, expect } from "vitest";
import { validateQuery, isISODate } from "../../_handlers/internal/income-statement/index.js";

function P(o) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) sp.set(k, String(v));
  return sp;
}

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
  });
  it("rejects calendar-invalid dates", () => {
    expect(isISODate("2026-02-30")).toBe(false);  // Feb 30 doesn't exist
    expect(isISODate("2026-13-01")).toBe(false);  // month 13
    expect(isISODate("2026-04-31")).toBe(false);  // April has 30 days
  });
});

describe("validateQuery", () => {
  it("requires basis", () => {
    const v = validateQuery(P({}));
    expect(v.error).toMatch(/basis is required/);
  });

  it("accepts ACCRUAL basis", () => {
    const v = validateQuery(P({ basis: "ACCRUAL" }));
    expect(v.error).toBeUndefined();
    expect(v.data.basis).toBe("ACCRUAL");
    expect(v.data.from).toBeNull();
    expect(v.data.to).toBeNull();
  });

  it("accepts CASH basis", () => {
    const v = validateQuery(P({ basis: "CASH" }));
    expect(v.error).toBeUndefined();
    expect(v.data.basis).toBe("CASH");
  });

  it("normalizes basis to uppercase", () => {
    expect(validateQuery(P({ basis: "accrual" })).data.basis).toBe("ACCRUAL");
    expect(validateQuery(P({ basis: "Cash"    })).data.basis).toBe("CASH");
  });

  it("rejects unknown basis", () => {
    expect(validateQuery(P({ basis: "BOTH"  })).error).toMatch(/basis/);
    expect(validateQuery(P({ basis: "TAX"   })).error).toMatch(/basis/);
    expect(validateQuery(P({ basis: "xyz"   })).error).toMatch(/basis/);
  });

  it("accepts valid from date", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", from: "2026-01-01" }));
    expect(v.error).toBeUndefined();
    expect(v.data.from).toBe("2026-01-01");
  });

  it("accepts valid to date", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", to: "2026-12-31" }));
    expect(v.error).toBeUndefined();
    expect(v.data.to).toBe("2026-12-31");
  });

  it("rejects invalid from format", () => {
    expect(validateQuery(P({ basis: "ACCRUAL", from: "01/01/2026" })).error).toMatch(/from/);
    expect(validateQuery(P({ basis: "ACCRUAL", from: "yesterday"  })).error).toMatch(/from/);
  });

  it("rejects invalid to format", () => {
    expect(validateQuery(P({ basis: "ACCRUAL", to: "12/31/2026" })).error).toMatch(/to/);
    expect(validateQuery(P({ basis: "ACCRUAL", to: "later"       })).error).toMatch(/to/);
  });

  it("rejects from > to", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", from: "2026-12-31", to: "2026-01-01" }));
    expect(v.error).toMatch(/from must be on or before to/);
  });

  it("accepts from = to (single-day range)", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", from: "2026-05-27", to: "2026-05-27" }));
    expect(v.error).toBeUndefined();
    expect(v.data.from).toBe("2026-05-27");
    expect(v.data.to).toBe("2026-05-27");
  });

  it("treats blank from / to as omitted", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", from: "", to: "" }));
    expect(v.error).toBeUndefined();
    expect(v.data.from).toBeNull();
    expect(v.data.to).toBeNull();
  });

  it("accepts only from (no to)", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", from: "2026-01-01" }));
    expect(v.error).toBeUndefined();
    expect(v.data.from).toBe("2026-01-01");
    expect(v.data.to).toBeNull();
  });

  it("accepts only to (no from)", () => {
    const v = validateQuery(P({ basis: "CASH", to: "2026-12-31" }));
    expect(v.error).toBeUndefined();
    expect(v.data.from).toBeNull();
    expect(v.data.to).toBe("2026-12-31");
  });

  it("rejects calendar-invalid from", () => {
    expect(validateQuery(P({ basis: "ACCRUAL", from: "2026-02-30" })).error).toMatch(/from/);
  });

  it("rejects calendar-invalid to", () => {
    expect(validateQuery(P({ basis: "ACCRUAL", to: "2026-13-01" })).error).toMatch(/to/);
  });

  it("returns data shape consistent across calls", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", from: "2026-01-01", to: "2026-06-30" }));
    expect(v.error).toBeUndefined();
    expect(Object.keys(v.data).sort()).toEqual(["basis", "from", "to"]);
  });
});
