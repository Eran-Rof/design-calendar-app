// Tests for the four P7-7 operational-report handlers (ap-aging, sales-by-rep,
// sales-by-customer, gl-detail). Pure-JS — exercises each handler's query-string
// validators without touching the DB.

import { describe, it, expect } from "vitest";

import {
  parseListQuery as apParseListQuery,
  isUuid as apIsUuid,
  isISODate as apIsISODate,
} from "../../_handlers/internal/ap-aging/index.js";

import {
  validateQuery as repValidateQuery,
  isISODate as repIsISODate,
} from "../../_handlers/internal/sales-by-rep/index.js";

import {
  validateQuery as custValidateQuery,
  isISODate as custIsISODate,
} from "../../_handlers/internal/sales-by-customer/index.js";

import {
  validateQuery as glValidateQuery,
  isUuid as glIsUuid,
  isISODate as glIsISODate,
} from "../../_handlers/internal/gl-detail/index.js";

function P(o) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) sp.set(k, String(v));
  return sp;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. AP Aging — parseListQuery + isUuid + isISODate
// ─────────────────────────────────────────────────────────────────────────────
describe("ap-aging: isUuid", () => {
  it("accepts a valid UUID v4 shape", () => {
    expect(apIsUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });
  it("rejects empty / non-string / malformed", () => {
    expect(apIsUuid("")).toBe(false);
    expect(apIsUuid(null)).toBe(false);
    expect(apIsUuid("not-a-uuid")).toBe(false);
    expect(apIsUuid("550e8400-e29b-41d4-a716-44665544000")).toBe(false);
  });
});

describe("ap-aging: isISODate", () => {
  it("accepts YYYY-MM-DD", () => {
    expect(apIsISODate("2026-05-27")).toBe(true);
    expect(apIsISODate("2000-01-01")).toBe(true);
    expect(apIsISODate("2099-12-31")).toBe(true);
  });
  it("rejects malformed shapes", () => {
    expect(apIsISODate("2026-5-27")).toBe(false);
    expect(apIsISODate("26-05-27")).toBe(false);
    expect(apIsISODate("2026/05/27")).toBe(false);
    expect(apIsISODate("05-27-2026")).toBe(false);
    expect(apIsISODate("")).toBe(false);
    expect(apIsISODate(null)).toBe(false);
    expect(apIsISODate(undefined)).toBe(false);
    expect(apIsISODate(20260527)).toBe(false);
  });
  it("rejects calendar-invalid dates", () => {
    expect(apIsISODate("2026-02-30")).toBe(false);
    expect(apIsISODate("2026-13-01")).toBe(false);
    expect(apIsISODate("2026-04-31")).toBe(false);
  });
});

describe("ap-aging: parseListQuery", () => {
  it("defaults to current mode with limit 500", () => {
    const v = apParseListQuery(P({}));
    expect(v.error).toBeUndefined();
    expect(v.data.mode).toBe("current");
    expect(v.data.as_of).toBeUndefined();
    expect(v.data.vendor_id).toBeNull();
    expect(v.data.limit).toBe(500);
  });

  it("flips to as_of mode when as_of is provided", () => {
    const v = apParseListQuery(P({ as_of: "2026-05-27" }));
    expect(v.error).toBeUndefined();
    expect(v.data.mode).toBe("as_of");
    expect(v.data.as_of).toBe("2026-05-27");
  });

  it("rejects malformed as_of", () => {
    expect(apParseListQuery(P({ as_of: "05/27/2026" })).error).toMatch(/YYYY-MM-DD/);
    expect(apParseListQuery(P({ as_of: "tomorrow" })).error).toMatch(/YYYY-MM-DD/);
  });

  it("accepts and echoes a valid vendor_id", () => {
    const v = apParseListQuery(P({ vendor_id: "550e8400-e29b-41d4-a716-446655440000" }));
    expect(v.error).toBeUndefined();
    expect(v.data.vendor_id).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("rejects malformed vendor_id", () => {
    expect(apParseListQuery(P({ vendor_id: "abc" })).error).toMatch(/UUID/);
  });

  it("clamps limit at the 2000 ceiling", () => {
    const v = apParseListQuery(P({ limit: "9999" }));
    expect(v.error).toBeUndefined();
    expect(v.data.limit).toBe(2000);
  });

  it("rejects non-positive limit", () => {
    expect(apParseListQuery(P({ limit: "0" })).error).toMatch(/positive/);
    expect(apParseListQuery(P({ limit: "-5" })).error).toMatch(/positive/);
    expect(apParseListQuery(P({ limit: "abc" })).error).toMatch(/positive/);
  });

  it("composes as_of + vendor_id + limit cleanly", () => {
    const v = apParseListQuery(P({
      as_of: "2026-05-27",
      vendor_id: "550e8400-e29b-41d4-a716-446655440000",
      limit: "50",
    }));
    expect(v.error).toBeUndefined();
    expect(v.data.mode).toBe("as_of");
    expect(v.data.vendor_id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(v.data.limit).toBe(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Sales by Rep — validateQuery
// ─────────────────────────────────────────────────────────────────────────────
describe("sales-by-rep: isISODate", () => {
  it("accepts valid YYYY-MM-DD", () => {
    expect(repIsISODate("2026-01-01")).toBe(true);
  });
  it("rejects calendar-invalid dates", () => {
    expect(repIsISODate("2026-02-30")).toBe(false);
  });
});

describe("sales-by-rep: validateQuery", () => {
  it("rejects missing from", () => {
    expect(repValidateQuery(P({ to: "2026-05-27" })).error).toMatch(/from is required/);
  });

  it("rejects missing to", () => {
    expect(repValidateQuery(P({ from: "2026-01-01" })).error).toMatch(/to is required/);
  });

  it("rejects malformed from", () => {
    expect(repValidateQuery(P({ from: "01/01/2026", to: "2026-05-27" })).error).toMatch(/from must be YYYY-MM-DD/);
  });

  it("rejects malformed to", () => {
    expect(repValidateQuery(P({ from: "2026-01-01", to: "tomorrow" })).error).toMatch(/to must be YYYY-MM-DD/);
  });

  it("rejects from > to", () => {
    expect(repValidateQuery(P({ from: "2026-05-27", to: "2026-01-01" })).error).toMatch(/on or before/);
  });

  it("accepts both dates", () => {
    const v = repValidateQuery(P({ from: "2026-01-01", to: "2026-05-27" }));
    expect(v.error).toBeUndefined();
    expect(v.data.from).toBe("2026-01-01");
    expect(v.data.to).toBe("2026-05-27");
  });

  it("accepts from == to (single-day window)", () => {
    const v = repValidateQuery(P({ from: "2026-05-27", to: "2026-05-27" }));
    expect(v.error).toBeUndefined();
  });

  it("trims whitespace around from/to", () => {
    const v = repValidateQuery(P({ from: "  2026-01-01 ", to: " 2026-05-27 " }));
    expect(v.error).toBeUndefined();
    expect(v.data.from).toBe("2026-01-01");
    expect(v.data.to).toBe("2026-05-27");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Sales by Customer — validateQuery (parallel to Rep)
// ─────────────────────────────────────────────────────────────────────────────
describe("sales-by-customer: isISODate", () => {
  it("rejects month 13", () => {
    expect(custIsISODate("2026-13-01")).toBe(false);
  });
});

describe("sales-by-customer: validateQuery", () => {
  it("rejects missing both dates", () => {
    expect(custValidateQuery(P({})).error).toMatch(/from is required/);
  });

  it("rejects malformed from", () => {
    expect(custValidateQuery(P({ from: "x", to: "2026-05-27" })).error).toMatch(/from must be YYYY-MM-DD/);
  });

  it("rejects from > to", () => {
    expect(custValidateQuery(P({ from: "2026-05-27", to: "2026-01-01" })).error).toMatch(/on or before/);
  });

  it("accepts valid window", () => {
    const v = custValidateQuery(P({ from: "2026-01-01", to: "2026-05-27" }));
    expect(v.error).toBeUndefined();
    expect(v.data.from).toBe("2026-01-01");
    expect(v.data.to).toBe("2026-05-27");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. GL Detail — validateQuery (account_id + dates)
// ─────────────────────────────────────────────────────────────────────────────
describe("gl-detail: isUuid", () => {
  it("accepts a valid UUID v4 shape", () => {
    expect(glIsUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });
  it("rejects malformed UUIDs", () => {
    expect(glIsUuid("not-a-uuid")).toBe(false);
    expect(glIsUuid("")).toBe(false);
  });
});

describe("gl-detail: isISODate", () => {
  it("accepts leap-day on actual leap years", () => {
    expect(glIsISODate("2024-02-29")).toBe(true);
    expect(glIsISODate("2026-02-29")).toBe(false); // 2026 not a leap year
  });
});

describe("gl-detail: validateQuery", () => {
  const UUID = "550e8400-e29b-41d4-a716-446655440000";

  it("rejects missing account_id", () => {
    expect(glValidateQuery(P({ from: "2026-01-01", to: "2026-05-27" })).error).toMatch(/account_id is required/);
  });

  it("rejects malformed account_id", () => {
    expect(glValidateQuery(P({ account_id: "abc", from: "2026-01-01", to: "2026-05-27" })).error).toMatch(/UUID/);
  });

  it("rejects missing from", () => {
    expect(glValidateQuery(P({ account_id: UUID, to: "2026-05-27" })).error).toMatch(/from is required/);
  });

  it("rejects missing to", () => {
    expect(glValidateQuery(P({ account_id: UUID, from: "2026-01-01" })).error).toMatch(/to is required/);
  });

  it("rejects malformed from", () => {
    expect(glValidateQuery(P({ account_id: UUID, from: "x", to: "2026-05-27" })).error).toMatch(/from must be YYYY-MM-DD/);
  });

  it("rejects malformed to", () => {
    expect(glValidateQuery(P({ account_id: UUID, from: "2026-01-01", to: "y" })).error).toMatch(/to must be YYYY-MM-DD/);
  });

  it("rejects from > to", () => {
    expect(glValidateQuery(P({ account_id: UUID, from: "2026-05-27", to: "2026-01-01" })).error).toMatch(/on or before/);
  });

  it("accepts the happy path", () => {
    const v = glValidateQuery(P({ account_id: UUID, from: "2026-01-01", to: "2026-05-27" }));
    expect(v.error).toBeUndefined();
    expect(v.data.account_id).toBe(UUID);
    expect(v.data.from).toBe("2026-01-01");
    expect(v.data.to).toBe("2026-05-27");
  });

  it("accepts single-day window", () => {
    const v = glValidateQuery(P({ account_id: UUID, from: "2026-05-27", to: "2026-05-27" }));
    expect(v.error).toBeUndefined();
  });
});
