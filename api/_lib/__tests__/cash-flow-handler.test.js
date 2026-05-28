// Tests for the cash-flow handler (P5-5).
// Pure-JS — exercises validateQuery + isISODate without DB.

import { describe, it, expect } from "vitest";
import { validateQuery, isISODate } from "../../_handlers/internal/cash-flow/index.js";

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
    expect(isISODate("2026-5-27")).toBe(false);
    expect(isISODate("26-05-27")).toBe(false);
    expect(isISODate("2026/05/27")).toBe(false);
    expect(isISODate("")).toBe(false);
    expect(isISODate(null)).toBe(false);
  });
  it("rejects calendar-invalid dates", () => {
    expect(isISODate("2026-02-30")).toBe(false);
    expect(isISODate("2026-13-01")).toBe(false);
    expect(isISODate("2026-04-31")).toBe(false);
  });
});

describe("validateQuery — basis", () => {
  it("requires basis", () => {
    const v = validateQuery(P({}));
    expect(v.error).toMatch(/basis/i);
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
  it("uppercases lowercase basis", () => {
    const v = validateQuery(P({ basis: "accrual" }));
    expect(v.error).toBeUndefined();
    expect(v.data.basis).toBe("ACCRUAL");
  });
  it("rejects invalid basis", () => {
    expect(validateQuery(P({ basis: "MODIFIED" })).error).toMatch(/basis/i);
    expect(validateQuery(P({ basis: "tax" })).error).toMatch(/basis/i);
    expect(validateQuery(P({ basis: " " })).error).toMatch(/basis/i);
  });
});

describe("validateQuery — date defaults", () => {
  it("defaults from to Jan 1 of current year", () => {
    const v = validateQuery(P({ basis: "ACCRUAL" }));
    expect(v.error).toBeUndefined();
    const y = new Date().getUTCFullYear();
    expect(v.data.from).toBe(`${y}-01-01`);
  });
  it("defaults to to today (ISO)", () => {
    const v = validateQuery(P({ basis: "ACCRUAL" }));
    expect(v.error).toBeUndefined();
    expect(/^\d{4}-\d{2}-\d{2}$/.test(v.data.to)).toBe(true);
  });
});

describe("validateQuery — explicit dates", () => {
  it("accepts valid from/to", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", from: "2026-01-01", to: "2026-06-30" }));
    expect(v.error).toBeUndefined();
    expect(v.data.from).toBe("2026-01-01");
    expect(v.data.to).toBe("2026-06-30");
  });
  it("rejects malformed from", () => {
    expect(validateQuery(P({ basis: "ACCRUAL", from: "yesterday" })).error).toMatch(/from/);
    expect(validateQuery(P({ basis: "ACCRUAL", from: "2026/01/01" })).error).toMatch(/from/);
  });
  it("rejects malformed to", () => {
    expect(validateQuery(P({ basis: "ACCRUAL", to: "tomorrow" })).error).toMatch(/to/);
  });
  it("rejects to < from", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", from: "2026-06-30", to: "2026-01-01" }));
    expect(v.error).toMatch(/to/);
  });
  it("accepts to == from (single-day window)", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", from: "2026-05-27", to: "2026-05-27" }));
    expect(v.error).toBeUndefined();
  });
});

describe("validateQuery — combined", () => {
  it("combines basis + from + to correctly", () => {
    const v = validateQuery(P({
      basis: "CASH",
      from: "2025-01-01",
      to: "2025-12-31",
    }));
    expect(v.error).toBeUndefined();
    expect(v.data.basis).toBe("CASH");
    expect(v.data.from).toBe("2025-01-01");
    expect(v.data.to).toBe("2025-12-31");
  });
});
