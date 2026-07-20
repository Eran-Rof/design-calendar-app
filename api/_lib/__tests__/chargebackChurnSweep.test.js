import { describe, it, expect } from "vitest";
import { pairKeyToUuid, hasDispositionHistory, shouldAutoDisposition } from "../chargebackChurnSweep.js";

describe("pairKeyToUuid", () => {
  it("is deterministic and uuid-shaped (v5)", () => {
    const u = pairKeyToUuid("a:b");
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(pairKeyToUuid("a:b")).toBe(u); // stable across calls → idempotent re-import
  });
  it("distinct pair keys map to distinct uuids", () => {
    expect(pairKeyToUuid("a:b")).not.toBe(pairKeyToUuid("a:c"));
  });
});

describe("shouldAutoDisposition guard", () => {
  it("auto-dispositions an OPEN churn row with no prior disposition history", () => {
    expect(shouldAutoDisposition({ is_factor_churn: true, disposition: "open", status_history: [] })).toBe(true);
    expect(shouldAutoDisposition({ is_factor_churn: true, disposition: "open", status_history: null })).toBe(true);
  });
  it("never touches a non-churn row", () => {
    expect(shouldAutoDisposition({ is_factor_churn: false, disposition: "open" })).toBe(false);
    expect(shouldAutoDisposition({ is_factor_churn: null, disposition: "open" })).toBe(false);
  });
  it("never touches a row that is not open (e.g. #1854 bulk 'valid' — flags only)", () => {
    expect(shouldAutoDisposition({ is_factor_churn: true, disposition: "valid", status_history: [] })).toBe(false);
    expect(shouldAutoDisposition({ is_factor_churn: true, disposition: "disputed", status_history: [] })).toBe(false);
  });
  it("never touches a row that already has a disposition change in history (operator-set back to open)", () => {
    const row = {
      is_factor_churn: true,
      disposition: "open",
      status_history: [{ at: "2026-01-01T00:00:00Z", by: "user:eran", field: "disposition", from: "disputed", to: "open", note: "reopened" }],
    };
    expect(hasDispositionHistory(row)).toBe(true);
    expect(shouldAutoDisposition(row)).toBe(false);
  });
  it("ignores non-disposition history entries", () => {
    const row = {
      is_factor_churn: true,
      disposition: "open",
      status_history: [{ at: "2026-01-01T00:00:00Z", by: "x", field: "owner", from: null, to: "eran" }],
    };
    expect(hasDispositionHistory(row)).toBe(false);
    expect(shouldAutoDisposition(row)).toBe(true);
  });
});
