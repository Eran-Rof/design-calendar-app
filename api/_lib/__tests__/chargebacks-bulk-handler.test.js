// Tests for the bulk chargeback reason-coding handler's validator (#1744).
// Pure-JS, no DB — exercises validateBulkCoding directly (it encapsulates the
// non-trivial logic); the update itself is a single parameterised .in() query.

import { describe, it, expect } from "vitest";
import { validateBulkCoding, BULK_MAX_IDS } from "../../_handlers/internal/chargebacks/bulk.js";

const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";
const RC = "33333333-3333-3333-3333-333333333333";

describe("validateBulkCoding", () => {
  it("rejects a non-object body", () => {
    expect(validateBulkCoding(null).error).toMatch(/object/);
    expect(validateBulkCoding("x").error).toMatch(/object/);
  });
  it("rejects a missing / empty ids array", () => {
    expect(validateBulkCoding({ reason_code_id: RC }).error).toMatch(/non-empty/);
    expect(validateBulkCoding({ ids: [], reason_code_id: RC }).error).toMatch(/non-empty/);
    expect(validateBulkCoding({ ids: "nope", reason_code_id: RC }).error).toMatch(/non-empty/);
  });
  it(`rejects more than ${BULK_MAX_IDS} ids`, () => {
    const ids = Array.from({ length: BULK_MAX_IDS + 1 }, () => U1);
    expect(validateBulkCoding({ ids, reason_code_id: RC }).error).toMatch(/at most/);
  });
  it("rejects a non-uuid id", () => {
    expect(validateBulkCoding({ ids: [U1, "not-a-uuid"], reason_code_id: RC }).error).toMatch(/uuid/);
  });
  it("requires reason_code_id to be present (even if null)", () => {
    expect(validateBulkCoding({ ids: [U1] }).error).toMatch(/reason_code_id is required/);
  });
  it("rejects a non-uuid, non-null reason_code_id", () => {
    expect(validateBulkCoding({ ids: [U1], reason_code_id: "x" }).error).toMatch(/uuid or null/);
  });
  it("accepts a valid coding request and de-duplicates ids", () => {
    const v = validateBulkCoding({ ids: [U1, U2, U1], reason_code_id: RC });
    expect(v.error).toBeUndefined();
    expect(v.data.ids).toEqual([U1, U2]);
    expect(v.data.reason_code_id).toBe(RC);
  });
  it("accepts null reason_code_id (un-code)", () => {
    const v = validateBulkCoding({ ids: [U1], reason_code_id: null });
    expect(v.error).toBeUndefined();
    expect(v.data.reason_code_id).toBeNull();
  });
  it("trims id whitespace", () => {
    const v = validateBulkCoding({ ids: [` ${U1} `], reason_code_id: null });
    expect(v.error).toBeUndefined();
    expect(v.data.ids).toEqual([U1]);
  });
});
