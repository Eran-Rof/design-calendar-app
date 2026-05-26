// Tests for COA admin handlers. Pure-JS — focused on validate* helpers.

import { describe, it, expect } from "vitest";
import { validateInsert } from "../../_handlers/internal/gl-accounts/index.js";
import { validatePatch } from "../../_handlers/internal/gl-accounts/[id].js";

describe("validateInsert", () => {
  it("rejects missing code", () => {
    expect(validateInsert({ name: "x", account_type: "asset" }).error).toMatch(/code/);
  });
  it("rejects empty code", () => {
    expect(validateInsert({ code: "   ", name: "x", account_type: "asset" }).error).toMatch(/code/);
  });
  it("rejects missing name", () => {
    expect(validateInsert({ code: "1100", account_type: "asset" }).error).toMatch(/name/);
  });
  it("rejects missing account_type", () => {
    expect(validateInsert({ code: "1100", name: "AR" }).error).toMatch(/account_type/);
  });
  it("rejects invalid account_type", () => {
    expect(validateInsert({ code: "1100", name: "AR", account_type: "BOGUS" }).error).toMatch(/account_type/);
  });
  it("rejects invalid normal_balance when supplied", () => {
    expect(validateInsert({ code: "1100", name: "AR", account_type: "asset", normal_balance: "FOO" }).error).toMatch(/normal_balance/);
  });
  it("rejects invalid status", () => {
    expect(validateInsert({ code: "1100", name: "AR", account_type: "asset", status: "BAD" }).error).toMatch(/status/);
  });

  it("auto-derives DEBIT for asset", () => {
    const v = validateInsert({ code: "1100", name: "AR", account_type: "asset" });
    expect(v.error).toBeUndefined();
    expect(v.data.normal_balance).toBe("DEBIT");
  });
  it("auto-derives DEBIT for expense", () => {
    expect(validateInsert({ code: "5000", name: "COGS", account_type: "expense" }).data.normal_balance).toBe("DEBIT");
  });
  it("auto-derives DEBIT for contra_revenue", () => {
    expect(validateInsert({ code: "4900", name: "Returns", account_type: "contra_revenue" }).data.normal_balance).toBe("DEBIT");
  });
  it("auto-derives CREDIT for liability", () => {
    expect(validateInsert({ code: "2000", name: "AP", account_type: "liability" }).data.normal_balance).toBe("CREDIT");
  });
  it("auto-derives CREDIT for equity", () => {
    expect(validateInsert({ code: "3000", name: "Equity", account_type: "equity" }).data.normal_balance).toBe("CREDIT");
  });
  it("auto-derives CREDIT for revenue", () => {
    expect(validateInsert({ code: "4000", name: "Wholesale", account_type: "revenue" }).data.normal_balance).toBe("CREDIT");
  });
  it("auto-derives CREDIT for contra_asset", () => {
    expect(validateInsert({ code: "1900", name: "Allowance", account_type: "contra_asset" }).data.normal_balance).toBe("CREDIT");
  });

  it("explicit normal_balance overrides auto-derivation", () => {
    const v = validateInsert({ code: "1100", name: "Unusual", account_type: "asset", normal_balance: "CREDIT" });
    expect(v.error).toBeUndefined();
    expect(v.data.normal_balance).toBe("CREDIT");
  });

  it("trims and uppercases code", () => {
    const v = validateInsert({ code: "  ar-101  ", name: "x", account_type: "asset" });
    expect(v.data.code).toBe("AR-101");
  });

  it("defaults is_postable to true and is_control to false", () => {
    const v = validateInsert({ code: "1100", name: "AR", account_type: "asset" });
    expect(v.data.is_postable).toBe(true);
    expect(v.data.is_control).toBe(false);
  });

  it("defaults status to active", () => {
    expect(validateInsert({ code: "1100", name: "AR", account_type: "asset" }).data.status).toBe("active");
  });

  it("accepts a complete minimal payload", () => {
    const v = validateInsert({ code: "2000", name: "AP", account_type: "liability", is_control: true });
    expect(v.error).toBeUndefined();
    expect(v.data.is_control).toBe(true);
    expect(v.data.normal_balance).toBe("CREDIT");
  });
});

describe("validatePatch", () => {
  it("rejects code (locked)", () => {
    expect(validatePatch({ code: "HACK" }).error).toMatch(/code is locked/);
  });
  it("rejects account_type (locked)", () => {
    expect(validatePatch({ account_type: "liability" }).error).toMatch(/account_type is locked/);
  });
  it("rejects normal_balance (locked)", () => {
    expect(validatePatch({ normal_balance: "DEBIT" }).error).toMatch(/normal_balance is locked/);
  });
  it("rejects entity_id (locked)", () => {
    expect(validatePatch({ entity_id: "abc" }).error).toMatch(/entity_id is locked/);
  });

  it("accepts mutable fields", () => {
    const v = validatePatch({ name: "New Name", description: "updated" });
    expect(v.error).toBeUndefined();
    expect(v.data.name).toBe("New Name");
    expect(v.data.description).toBe("updated");
  });

  it("filters out non-mutable, non-locked fields", () => {
    const v = validatePatch({ name: "ok", created_at: "2026-01-01" });
    expect(v.data.created_at).toBeUndefined();
    expect(v.data.name).toBe("ok");
  });

  it("rejects invalid status", () => {
    expect(validatePatch({ status: "BOGUS" }).error).toMatch(/status/);
  });
  it("accepts valid status active", () => {
    expect(validatePatch({ status: "active" }).error).toBeUndefined();
  });
  it("accepts valid status inactive", () => {
    expect(validatePatch({ status: "inactive" }).error).toBeUndefined();
  });

  it("normalizes empty strings to null for nullable text", () => {
    const v = validatePatch({ account_subtype: "", parent_account_id: "", description: "" });
    expect(v.data.account_subtype).toBeNull();
    expect(v.data.parent_account_id).toBeNull();
    expect(v.data.description).toBeNull();
  });

  it("accepts an empty body (caller rejects)", () => {
    const v = validatePatch({});
    expect(v.error).toBeUndefined();
    expect(v.data).toEqual({});
  });
});
