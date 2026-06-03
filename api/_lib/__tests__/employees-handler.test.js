// Tests for P2-8 employees handler validation.

import { describe, it, expect } from "vitest";
import { validateInsert } from "../../_handlers/internal/employees/index.js";
import { validatePatch } from "../../_handlers/internal/employees/[id].js";

const UUID = "00000000-0000-0000-0000-000000000001";

describe("employees validateInsert", () => {
  it("rejects missing first_name (code no longer required — server-generated)", () => {
    expect(validateInsert({}).error).toMatch(/first_name/);
  });
  it("rejects bad email", () => {
    expect(validateInsert({ code: "EB001", first_name: "Eran", last_name: "B", email: "no-at-sign" }).error).toMatch(/email/);
  });
  it("rejects bad hire_date format", () => {
    expect(validateInsert({
      code: "EB001", first_name: "E", last_name: "B", email: "x@y.com",
      hire_date: "1/2/2026",
    }).error).toMatch(/hire_date/);
  });
  it("rejects termination before hire", () => {
    expect(validateInsert({
      code: "EB001", first_name: "E", last_name: "B", email: "x@y.com",
      hire_date: "2026-05-01", termination_date: "2026-04-01",
    }).error).toMatch(/termination_date/);
  });
  it("rejects non-uuid auth_user_id", () => {
    expect(validateInsert({
      code: "EB001", first_name: "E", last_name: "B", email: "x@y.com",
      auth_user_id: "abc",
    }).error).toMatch(/auth_user_id/);
  });
  it("does not take code from body (server-generated)", () => {
    const v = validateInsert({ code: "eb001", first_name: "E", last_name: "B", email: "x@y.com" });
    expect(v.data.code).toBeUndefined();
  });
  it("lowercases email", () => {
    const v = validateInsert({ code: "EB001", first_name: "E", last_name: "B", email: "X@Y.COM" });
    expect(v.data.email).toBe("x@y.com");
  });
  it("accepts no auth_user_id (contractor case)", () => {
    const v = validateInsert({ code: "C001", first_name: "Con", last_name: "Tractor", email: "c@t.com" });
    expect(v.error).toBeUndefined();
    expect(v.data.auth_user_id).toBeNull();
  });
  it("default is_active=true", () => {
    expect(validateInsert({ code: "C001", first_name: "C", last_name: "T", email: "c@t.com" }).data.is_active).toBe(true);
  });
});

describe("employees validatePatch", () => {
  it("rejects code change", () => {
    expect(validatePatch({ code: "X" }).error).toMatch(/code/);
  });
  it("rejects entity_id change", () => {
    expect(validatePatch({ entity_id: UUID }).error).toMatch(/entity_id/);
  });
  it("accepts title change", () => {
    expect(validatePatch({ title: "VP" }).data.title).toBe("VP");
  });
  it("rejects bad email", () => {
    expect(validatePatch({ email: "no-at" }).error).toMatch(/email/);
  });
  it("accepts is_active toggle", () => {
    expect(validatePatch({ is_active: false }).data.is_active).toBe(false);
  });
  it("rejects non-uuid manager", () => {
    expect(validatePatch({ manager_employee_id: "abc" }).error).toMatch(/manager_employee_id/);
  });
  it("accepts manager null (no manager)", () => {
    const v = validatePatch({ manager_employee_id: null });
    expect(v.data.manager_employee_id).toBeNull();
  });
  it("trims department to null when empty string", () => {
    expect(validatePatch({ department: "" }).data.department).toBeNull();
  });
  it("empty patch returns empty data", () => {
    const v = validatePatch({});
    expect(v.error).toBeUndefined();
    expect(Object.keys(v.data)).toHaveLength(0);
  });
});

describe("employees notification_subscriptions", () => {
  it("defaults to empty array on create", () => {
    const v = validateInsert({ first_name: "E", last_name: "B", email: "x@y.com" });
    expect(v.data.notification_subscriptions).toEqual([]);
  });
  it("accepts and dedupes valid categories on create", () => {
    const v = validateInsert({
      first_name: "E", last_name: "B", email: "x@y.com",
      notification_subscriptions: ["onboarding", "invoice", "onboarding"],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.notification_subscriptions).toEqual(["onboarding", "invoice"]);
  });
  it("rejects an unknown category on create", () => {
    expect(validateInsert({
      first_name: "E", last_name: "B", email: "x@y.com",
      notification_subscriptions: ["not_a_real_category"],
    }).error).toMatch(/unknown notification category/);
  });
  it("rejects a non-array on create", () => {
    expect(validateInsert({
      first_name: "E", last_name: "B", email: "x@y.com",
      notification_subscriptions: "onboarding",
    }).error).toMatch(/must be an array/);
  });
  it("accepts a valid subscription patch", () => {
    const v = validatePatch({ notification_subscriptions: ["dispute"] });
    expect(v.data.notification_subscriptions).toEqual(["dispute"]);
  });
  it("rejects an unknown category on patch", () => {
    expect(validatePatch({ notification_subscriptions: ["bogus"] }).error).toMatch(/unknown notification category/);
  });
});
