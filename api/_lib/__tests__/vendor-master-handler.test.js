// Tests for the vendor-master admin handlers. Pure-JS, no DB —
// we test the validate* helpers directly since they encapsulate the
// non-trivial logic (including the all-important PII rejection paths).
// End-to-end testing happens via real-DB smoke after deploy.

import { describe, it, expect } from "vitest";
import { validateInsert } from "../../_handlers/internal/vendor-master/index.js";
import { validatePatch } from "../../_handlers/internal/vendor-master/[id].js";

describe("validateInsert", () => {
  it("rejects missing name", () => {
    expect(validateInsert({}).error).toMatch(/name/);
  });
  it("rejects empty name", () => {
    expect(validateInsert({ name: "   " }).error).toMatch(/name/);
  });
  it("accepts a minimal valid create", () => {
    const v = validateInsert({ name: "Acme Mills" });
    expect(v.error).toBeUndefined();
    expect(v.data.name).toBe("Acme Mills");
    expect(v.data.status).toBe("active");
    expect(v.data.default_currency).toBe("USD");
    expect(v.data.is_1099_vendor).toBe(false);
  });
  it("rejects tax_id (PII)", () => {
    expect(validateInsert({ name: "Acme", tax_id: "12-3456789" }).error).toMatch(/tax_id/);
  });
  it("rejects bank_account_encrypted (PII)", () => {
    expect(validateInsert({ name: "Acme", bank_account_encrypted: "deadbeef" }).error).toMatch(/bank_account_encrypted/);
  });
  it("rejects invalid status", () => {
    expect(validateInsert({ name: "Acme", status: "BOGUS" }).error).toMatch(/status/);
  });
  it("accepts on_hold status", () => {
    const v = validateInsert({ name: "Acme", status: "on_hold" });
    expect(v.error).toBeUndefined();
    expect(v.data.status).toBe("on_hold");
  });
  it("rejects invalid currency (too short)", () => {
    expect(validateInsert({ name: "Acme", default_currency: "US" }).error).toMatch(/default_currency/);
  });
  it("rejects invalid currency (lowercase)", () => {
    expect(validateInsert({ name: "Acme", default_currency: "usd" }).error).toMatch(/default_currency/);
  });
  it("accepts a valid 3-letter currency", () => {
    const v = validateInsert({ name: "Acme", default_currency: "EUR" });
    expect(v.error).toBeUndefined();
    expect(v.data.default_currency).toBe("EUR");
  });
  it("coerces transit_days from string", () => {
    const v = validateInsert({ name: "Acme", transit_days: "21" });
    expect(v.error).toBeUndefined();
    expect(v.data.transit_days).toBe(21);
  });
  it("rejects negative transit_days", () => {
    expect(validateInsert({ name: "Acme", transit_days: -3 }).error).toMatch(/transit_days/);
  });
  it("coerces moq from string", () => {
    const v = validateInsert({ name: "Acme", moq: "500" });
    expect(v.error).toBeUndefined();
    expect(v.data.moq).toBe(500);
  });
  it("rejects negative moq", () => {
    expect(validateInsert({ name: "Acme", moq: -10 }).error).toMatch(/moq/);
  });
  it("uppercases code on insert", () => {
    const v = validateInsert({ name: "Acme", code: "acme01" });
    expect(v.error).toBeUndefined();
    expect(v.data.code).toBe("ACME01");
  });
  it("accepts a fully-specified payload", () => {
    const v = validateInsert({
      name: "Acme Mills",
      code: "ACME01",
      legal_name: "Acme Mills LLC",
      country: "US",
      payment_terms: "NET 30",
      default_currency: "USD",
      is_1099_vendor: true,
      status: "active",
      transit_days: 14,
      moq: 100,
    });
    expect(v.error).toBeUndefined();
    expect(v.data.is_1099_vendor).toBe(true);
  });
});

describe("validatePatch", () => {
  it("rejects tax_id (PII)", () => {
    expect(validatePatch({ tax_id: "12-3456789" }).error).toMatch(/tax_id/);
  });
  it("rejects bank_account_encrypted (PII)", () => {
    expect(validatePatch({ bank_account_encrypted: "deadbeef" }).error).toMatch(/bank_account_encrypted/);
  });
  it("filters out non-mutable fields", () => {
    const v = validatePatch({ id: "evil-uuid", created_at: "2020", deleted_at: null, name: "ok" });
    expect(v.error).toBeUndefined();
    expect(v.data.id).toBeUndefined();
    expect(v.data.created_at).toBeUndefined();
    expect(v.data.deleted_at).toBeUndefined();
    expect(v.data.name).toBe("ok");
  });
  it("normalizes empty strings to null for nullable fields", () => {
    const v = validatePatch({ legal_name: "", country: "", contact: "", email: "", payment_terms: "" });
    expect(v.error).toBeUndefined();
    expect(v.data.legal_name).toBeNull();
    expect(v.data.country).toBeNull();
    expect(v.data.contact).toBeNull();
    expect(v.data.email).toBeNull();
    expect(v.data.payment_terms).toBeNull();
  });
  it("normalizes empty code to null", () => {
    const v = validatePatch({ code: "" });
    expect(v.data.code).toBeNull();
  });
  it("uppercases code on patch", () => {
    const v = validatePatch({ code: "acme01" });
    expect(v.data.code).toBe("ACME01");
  });
  it("rejects invalid status", () => {
    expect(validatePatch({ status: "BOGUS" }).error).toMatch(/status/);
  });
  it("accepts a valid status", () => {
    const v = validatePatch({ status: "inactive" });
    expect(v.error).toBeUndefined();
    expect(v.data.status).toBe("inactive");
  });
  it("rejects invalid currency", () => {
    expect(validatePatch({ default_currency: "us" }).error).toMatch(/default_currency/);
  });
  it("accepts a valid currency", () => {
    const v = validatePatch({ default_currency: "CAD" });
    expect(v.error).toBeUndefined();
    expect(v.data.default_currency).toBe("CAD");
  });
  it("coerces transit_days from string", () => {
    const v = validatePatch({ transit_days: "30" });
    expect(v.error).toBeUndefined();
    expect(v.data.transit_days).toBe(30);
  });
  it("rejects negative transit_days", () => {
    expect(validatePatch({ transit_days: -1 }).error).toMatch(/transit_days/);
  });
  it("coerces moq from string", () => {
    const v = validatePatch({ moq: "250" });
    expect(v.error).toBeUndefined();
    expect(v.data.moq).toBe(250);
  });
  it("rejects negative moq", () => {
    expect(validatePatch({ moq: -5 }).error).toMatch(/moq/);
  });
  it("accepts an empty body without error (caller should reject empties)", () => {
    const v = validatePatch({});
    expect(v.error).toBeUndefined();
    expect(v.data).toEqual({});
  });
});
