// Tests for the ar-aging handler (P4-6).
// Pure-JS — exercises parseListQuery + isUuid + isISODate without DB.

import { describe, it, expect } from "vitest";
import { parseListQuery, isUuid, isISODate } from "../../_handlers/internal/ar-aging/index.js";

function P(o) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) sp.set(k, String(v));
  return sp;
}

describe("isUuid", () => {
  it("accepts a valid UUID v4 shape", () => {
    expect(isUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });
  it("rejects empty / non-string / malformed", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("550e8400-e29b-41d4-a716-44665544000")).toBe(false);  // short
  });
});

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
  });
  it("rejects calendar-invalid dates", () => {
    expect(isISODate("2026-02-30")).toBe(false);  // Feb 30 doesn't exist
    expect(isISODate("2026-13-01")).toBe(false);  // month 13
    expect(isISODate("2026-04-31")).toBe(false);  // April has 30 days
  });
});

describe("parseListQuery", () => {
  it("defaults to current mode with limit 500", () => {
    const v = parseListQuery(P({}));
    expect(v.error).toBeUndefined();
    expect(v.data.mode).toBe("current");
    expect(v.data.as_of).toBeUndefined();
    expect(v.data.customer_id).toBeNull();
    expect(v.data.limit).toBe(500);
  });
  it("switches to as_of mode on valid date", () => {
    const v = parseListQuery(P({ as_of: "2026-05-27" }));
    expect(v.error).toBeUndefined();
    expect(v.data.mode).toBe("as_of");
    expect(v.data.as_of).toBe("2026-05-27");
  });
  it("rejects invalid as_of", () => {
    expect(parseListQuery(P({ as_of: "yesterday" })).error).toMatch(/as_of/);
    expect(parseListQuery(P({ as_of: "2026/05/27" })).error).toMatch(/as_of/);
  });
  it("accepts valid customer_id UUID", () => {
    const v = parseListQuery(P({ customer_id: "550e8400-e29b-41d4-a716-446655440000" }));
    expect(v.error).toBeUndefined();
    expect(v.data.customer_id).toBe("550e8400-e29b-41d4-a716-446655440000");
  });
  it("rejects non-UUID customer_id", () => {
    expect(parseListQuery(P({ customer_id: "abc" })).error).toMatch(/customer_id/);
  });
  it("clamps limit to 2000", () => {
    const v = parseListQuery(P({ limit: "99999" }));
    expect(v.data.limit).toBe(2000);
  });
  it("rejects non-positive limit", () => {
    expect(parseListQuery(P({ limit: "0" })).error).toMatch(/limit/);
    expect(parseListQuery(P({ limit: "-5" })).error).toMatch(/limit/);
    expect(parseListQuery(P({ limit: "abc" })).error).toMatch(/limit/);
  });
  it("combines filters correctly", () => {
    const v = parseListQuery(P({
      as_of: "2026-05-27",
      customer_id: "550e8400-e29b-41d4-a716-446655440000",
      limit: "100",
    }));
    expect(v.error).toBeUndefined();
    expect(v.data.mode).toBe("as_of");
    expect(v.data.as_of).toBe("2026-05-27");
    expect(v.data.customer_id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(v.data.limit).toBe(100);
  });

  it("defaults ar_account_id to null (all accounts)", () => {
    expect(parseListQuery(P({})).data.ar_account_id).toBeNull();
    expect(parseListQuery(P({ ar_account: "all" })).data.ar_account_id).toBeNull();
  });
  it("accepts a valid ar_account UUID", () => {
    const v = parseListQuery(P({ ar_account: "560b5e8b-8ff4-442c-b0e0-a6676790d7f1" }));
    expect(v.error).toBeUndefined();
    expect(v.data.ar_account_id).toBe("560b5e8b-8ff4-442c-b0e0-a6676790d7f1");
  });
  it("rejects a non-UUID ar_account", () => {
    expect(parseListQuery(P({ ar_account: "1108" })).error).toMatch(/ar_account/);
  });
});
