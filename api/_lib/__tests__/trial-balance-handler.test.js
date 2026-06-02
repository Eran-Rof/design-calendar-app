// Tests for the trial-balance handler (P5-2).
// Pure-JS — exercises validateQuery + isISODate + BASIS_VALUES.
// No DB / no network calls.

import { describe, it, expect } from "vitest";
import { validateQuery, isISODate, BASIS_VALUES } from "../../_handlers/internal/trial-balance/index.js";

function P(o) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) sp.set(k, String(v));
  return sp;
}

describe("BASIS_VALUES", () => {
  it("contains exactly ACCRUAL and CASH", () => {
    expect(BASIS_VALUES).toEqual(["ACCRUAL", "CASH"]);
  });

  it("does not include lowercase variants", () => {
    expect(BASIS_VALUES).not.toContain("accrual");
    expect(BASIS_VALUES).not.toContain("cash");
  });
});

describe("isISODate", () => {
  it("accepts well-formed YYYY-MM-DD", () => {
    expect(isISODate("2026-05-27")).toBe(true);
    expect(isISODate("2000-01-01")).toBe(true);
    expect(isISODate("2099-12-31")).toBe(true);
  });

  it("rejects malformed shapes", () => {
    expect(isISODate("2026-5-27")).toBe(false);      // not zero-padded
    expect(isISODate("26-05-27")).toBe(false);       // wrong year width
    expect(isISODate("2026/05/27")).toBe(false);     // slashes
    expect(isISODate("05-27-2026")).toBe(false);     // US-style
    expect(isISODate("")).toBe(false);
    expect(isISODate(null)).toBe(false);
    expect(isISODate(undefined)).toBe(false);
    expect(isISODate(20260527)).toBe(false);         // not a string
  });

  it("rejects calendar-invalid dates", () => {
    expect(isISODate("2026-02-30")).toBe(false);     // Feb 30
    expect(isISODate("2026-13-01")).toBe(false);     // month 13
    expect(isISODate("2026-04-31")).toBe(false);     // Apr has 30
    expect(isISODate("2026-00-15")).toBe(false);     // month 0
    expect(isISODate("2026-02-29")).toBe(false);     // 2026 is not a leap year
  });

  it("accepts leap-day on actual leap years", () => {
    expect(isISODate("2024-02-29")).toBe(true);      // 2024 is leap
    expect(isISODate("2000-02-29")).toBe(true);      // 2000 is leap (div by 400)
  });
});

describe("validateQuery — basis", () => {
  it("rejects missing basis", () => {
    const v = validateQuery(P({}));
    expect(v.error).toMatch(/basis is required/);
  });

  it("rejects empty basis", () => {
    const v = validateQuery(P({ basis: "" }));
    expect(v.error).toMatch(/basis is required/);
  });

  it("rejects invalid basis enum", () => {
    expect(validateQuery(P({ basis: "accrual" })).error).toMatch(/basis must be one of/);
    expect(validateQuery(P({ basis: "TAX" })).error).toMatch(/basis must be one of/);
    expect(validateQuery(P({ basis: "ACCRUALl" })).error).toMatch(/basis must be one of/);
  });

  it("accepts ACCRUAL", () => {
    const v = validateQuery(P({ basis: "ACCRUAL" }));
    expect(v.error).toBeUndefined();
    expect(v.data.basis).toBe("ACCRUAL");
    expect(v.data.mode).toBe("view");
  });

  it("accepts CASH", () => {
    const v = validateQuery(P({ basis: "CASH" }));
    expect(v.error).toBeUndefined();
    expect(v.data.basis).toBe("CASH");
    expect(v.data.mode).toBe("view");
  });
});

describe("validateQuery — date range", () => {
  it("defaults from/to to null when omitted", () => {
    const v = validateQuery(P({ basis: "ACCRUAL" }));
    expect(v.data.from).toBeNull();
    expect(v.data.to).toBeNull();
    expect(v.data.mode).toBe("view");
  });

  it("accepts both from and to in RPC mode", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", from: "2026-01-01", to: "2026-05-27" }));
    expect(v.error).toBeUndefined();
    expect(v.data.from).toBe("2026-01-01");
    expect(v.data.to).toBe("2026-05-27");
    expect(v.data.mode).toBe("rpc");
  });

  it("rejects from without to", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", from: "2026-01-01" }));
    expect(v.error).toMatch(/both/);
  });

  it("rejects to without from", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", to: "2026-05-27" }));
    expect(v.error).toMatch(/both/);
  });

  it("rejects malformed from", () => {
    const v = validateQuery(P({ basis: "CASH", from: "01/01/2026", to: "2026-05-27" }));
    expect(v.error).toMatch(/from must be YYYY-MM-DD/);
  });

  it("rejects malformed to", () => {
    const v = validateQuery(P({ basis: "CASH", from: "2026-01-01", to: "tomorrow" }));
    expect(v.error).toMatch(/to must be YYYY-MM-DD/);
  });

  it("rejects calendar-invalid from", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", from: "2026-02-30", to: "2026-05-27" }));
    expect(v.error).toMatch(/from must be YYYY-MM-DD/);
  });

  it("rejects calendar-invalid to", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", from: "2026-01-01", to: "2026-13-01" }));
    expect(v.error).toMatch(/to must be YYYY-MM-DD/);
  });

  it("rejects from > to", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", from: "2026-05-27", to: "2026-01-01" }));
    expect(v.error).toMatch(/from must be on or before to/);
  });

  it("accepts from == to (single-day range)", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", from: "2026-05-27", to: "2026-05-27" }));
    expect(v.error).toBeUndefined();
    expect(v.data.from).toBe("2026-05-27");
    expect(v.data.to).toBe("2026-05-27");
    expect(v.data.mode).toBe("rpc");
  });

  it("trims whitespace around basis", () => {
    const v = validateQuery(P({ basis: "  ACCRUAL  " }));
    expect(v.error).toBeUndefined();
    expect(v.data.basis).toBe("ACCRUAL");
  });

  it("trims whitespace around from/to", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", from: "  2026-01-01 ", to: " 2026-05-27 " }));
    expect(v.error).toBeUndefined();
    expect(v.data.from).toBe("2026-01-01");
    expect(v.data.to).toBe("2026-05-27");
  });

  it("returns mode=view when no dates and basis present", () => {
    const v = validateQuery(P({ basis: "ACCRUAL" }));
    expect(v.data.mode).toBe("view");
  });

  it("returns mode=rpc when both dates and basis present", () => {
    const v = validateQuery(P({ basis: "CASH", from: "2025-01-01", to: "2025-12-31" }));
    expect(v.data.mode).toBe("rpc");
  });
});

describe("validateQuery — combined edge cases", () => {
  it("rejects missing basis even when from/to are valid", () => {
    const v = validateQuery(P({ from: "2026-01-01", to: "2026-05-27" }));
    expect(v.error).toMatch(/basis is required/);
  });

  it("treats both dates blank as view mode", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", from: "", to: "" }));
    expect(v.error).toBeUndefined();
    expect(v.data.mode).toBe("view");
    expect(v.data.from).toBeNull();
    expect(v.data.to).toBeNull();
  });

  it("rejects from set + to blank", () => {
    const v = validateQuery(P({ basis: "ACCRUAL", from: "2026-01-01", to: "" }));
    expect(v.error).toMatch(/both/);
  });
});
