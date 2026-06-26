// Tests for the customer-master admin handlers (M36).
// Pure-JS, no DB — exercises the validate* helpers directly since they
// encapsulate the non-trivial logic. End-to-end happens via real-DB smoke
// after deploy.

import { describe, it, expect } from "vitest";
import { validateInsert } from "../../_handlers/internal/customer-master/index.js";
import { validatePatch } from "../../_handlers/internal/customer-master/[id].js";

describe("validateInsert", () => {
  it("rejects missing name", () => {
    expect(validateInsert({}).error).toMatch(/name/);
  });
  it("rejects empty name (whitespace only)", () => {
    expect(validateInsert({ name: "   " }).error).toMatch(/name/);
  });
  it("accepts a valid minimal create (name only)", () => {
    const v = validateInsert({ name: "ACME Corp" });
    expect(v.error).toBeUndefined();
    expect(v.data.name).toBe("ACME Corp");
  });
  it("rejects tax_exempt_certificate as PII", () => {
    const v = validateInsert({ name: "ACME", tax_exempt_certificate: "CERT-123" });
    expect(v.error).toMatch(/tax_exempt_certificate/);
  });
  it("rejects invalid customer_type", () => {
    expect(validateInsert({ name: "ACME", customer_type: "consumer" }).error).toMatch(/customer_type/);
  });
  it("accepts all valid customer_types", () => {
    for (const t of ["wholesale", "ecom", "showroom", "employee", "other"]) {
      expect(validateInsert({ name: "X", customer_type: t }).error).toBeUndefined();
    }
  });
  it("rejects invalid status", () => {
    expect(validateInsert({ name: "ACME", status: "archived" }).error).toMatch(/status/);
  });
  it("accepts all valid statuses", () => {
    for (const s of ["active", "inactive", "on_hold"]) {
      expect(validateInsert({ name: "X", status: s }).error).toBeUndefined();
    }
  });
  it("rejects invalid default_currency (length)", () => {
    expect(validateInsert({ name: "X", default_currency: "DOLLAR" }).error).toMatch(/currency/);
  });
  it("rejects invalid default_currency (non-letters)", () => {
    expect(validateInsert({ name: "X", default_currency: "U$D" }).error).toMatch(/currency/);
  });
  it("uppercases default_currency", () => {
    const v = validateInsert({ name: "X", default_currency: "eur" });
    expect(v.error).toBeUndefined();
    expect(v.data.default_currency).toBe("EUR");
  });
  it("coerces credit_limit from string", () => {
    const v = validateInsert({ name: "X", credit_limit: "5000.50" });
    expect(v.error).toBeUndefined();
    expect(v.data.credit_limit).toBe(5000.5);
  });
  it("rejects negative credit_limit", () => {
    expect(validateInsert({ name: "X", credit_limit: -100 }).error).toMatch(/credit_limit/);
  });
  it("rejects non-numeric credit_limit", () => {
    expect(validateInsert({ name: "X", credit_limit: "lots" }).error).toMatch(/credit_limit/);
  });
  it("normalizes blank credit_limit to null", () => {
    const v = validateInsert({ name: "X", credit_limit: "" });
    expect(v.error).toBeUndefined();
    expect(v.data.credit_limit).toBeNull();
  });
  it("accepts a complete payload", () => {
    const v = validateInsert({
      name: "ACME Wholesale Co",
      code: "ACME",
      customer_type: "wholesale",
      country: "US",
      payment_terms: "Net 30",
      default_currency: "USD",
      tax_exempt: false,
      credit_limit: 50000,
      status: "active",
      billing_address: { line1: "123 Main" },
      shipping_address: { line1: "123 Main" },
    });
    expect(v.error).toBeUndefined();
    expect(v.data.code).toBe("ACME");
    expect(v.data.credit_limit).toBe(50000);
  });
});

describe("validatePatch", () => {
  it("rejects tax_exempt_certificate as PII", () => {
    const v = validatePatch({ name: "X", tax_exempt_certificate: "CERT-7" });
    expect(v.error).toMatch(/tax_exempt_certificate/);
  });
  it("filters out non-mutable fields", () => {
    const v = validatePatch({ id: "abc", entity_id: "def", customer_code: "OLD", created_at: "now", name: "ACME" });
    expect(v.data.id).toBeUndefined();
    expect(v.data.entity_id).toBeUndefined();
    expect(v.data.customer_code).toBeUndefined();
    expect(v.data.created_at).toBeUndefined();
    expect(v.data.name).toBe("ACME");
  });
  it("normalizes empty strings to null for nullable text/uuid fields", () => {
    const v = validatePatch({
      code: "", country: "", payment_terms: "",
      default_ar_account_id: "", default_revenue_account_id: "",
      parent_customer_id: "",
    });
    expect(v.error).toBeUndefined();
    expect(v.data.code).toBeNull();
    expect(v.data.country).toBeNull();
    expect(v.data.payment_terms).toBeNull();
    expect(v.data.default_ar_account_id).toBeNull();
    expect(v.data.default_revenue_account_id).toBeNull();
    expect(v.data.parent_customer_id).toBeNull();
  });
  it("rejects invalid customer_type", () => {
    expect(validatePatch({ customer_type: "vip" }).error).toMatch(/customer_type/);
  });
  it("rejects blanking customer_type (NOT NULL)", () => {
    expect(validatePatch({ customer_type: "" }).error).toMatch(/customer_type/);
  });
  it("rejects invalid status", () => {
    expect(validatePatch({ status: "deleted" }).error).toMatch(/status/);
  });
  it("rejects blanking status (NOT NULL)", () => {
    expect(validatePatch({ status: "" }).error).toMatch(/status/);
  });
  it("rejects blanking name", () => {
    expect(validatePatch({ name: "   " }).error).toMatch(/name/);
  });
  it("uppercases default_currency", () => {
    const v = validatePatch({ default_currency: "gbp" });
    expect(v.error).toBeUndefined();
    expect(v.data.default_currency).toBe("GBP");
  });
  it("rejects bad currency length", () => {
    expect(validatePatch({ default_currency: "USDA" }).error).toMatch(/currency/);
  });
  it("coerces credit_limit from string", () => {
    const v = validatePatch({ credit_limit: "1250" });
    expect(v.error).toBeUndefined();
    expect(v.data.credit_limit).toBe(1250);
  });
  it("normalizes blank credit_limit to null", () => {
    const v = validatePatch({ credit_limit: "" });
    expect(v.error).toBeUndefined();
    expect(v.data.credit_limit).toBeNull();
  });
  it("rejects negative credit_limit", () => {
    expect(validatePatch({ credit_limit: -50 }).error).toMatch(/credit_limit/);
  });
  it("accepts empty body without error (caller should reject empty)", () => {
    const v = validatePatch({});
    expect(v.error).toBeUndefined();
    expect(v.data).toEqual({});
  });
  it("normalizes tax_exempt string -> bool", () => {
    const v = validatePatch({ tax_exempt: "true" });
    expect(v.error).toBeUndefined();
    expect(v.data.tax_exempt).toBe(true);
  });

  // ─── P4-7: credit_limit_cents + credit_limit_currency ─────────────────────
  it("accepts integer credit_limit_cents", () => {
    const v = validatePatch({ credit_limit_cents: 250000 });
    expect(v.error).toBeUndefined();
    expect(v.data.credit_limit_cents).toBe(250000);
  });
  it("accepts numeric-string credit_limit_cents", () => {
    const v = validatePatch({ credit_limit_cents: "500000" });
    expect(v.error).toBeUndefined();
    expect(v.data.credit_limit_cents).toBe(500000);
  });
  it("rejects non-integer credit_limit_cents", () => {
    expect(validatePatch({ credit_limit_cents: 123.45 }).error).toMatch(/credit_limit_cents/);
    expect(validatePatch({ credit_limit_cents: "abc" }).error).toMatch(/credit_limit_cents/);
  });
  it("rejects negative credit_limit_cents", () => {
    expect(validatePatch({ credit_limit_cents: -1 }).error).toMatch(/credit_limit_cents/);
  });
  it("normalizes blank credit_limit_cents to null", () => {
    expect(validatePatch({ credit_limit_cents: "" }).data.credit_limit_cents).toBeNull();
    expect(validatePatch({ credit_limit_cents: null }).data.credit_limit_cents).toBeNull();
  });
  it("accepts and uppercases credit_limit_currency", () => {
    const v = validatePatch({ credit_limit_currency: "usd" });
    expect(v.error).toBeUndefined();
    expect(v.data.credit_limit_currency).toBe("USD");
  });
  it("rejects non-3-letter credit_limit_currency", () => {
    expect(validatePatch({ credit_limit_currency: "USDX" }).error).toMatch(/credit_limit_currency/);
    expect(validatePatch({ credit_limit_currency: "12" }).error).toMatch(/credit_limit_currency/);
  });
  it("normalizes blank credit_limit_currency to null", () => {
    expect(validatePatch({ credit_limit_currency: "" }).data.credit_limit_currency).toBeNull();
  });

  it("validateInsert accepts credit_limit_cents + credit_limit_currency together", () => {
    const v = validateInsert({ name: "ACME", credit_limit_cents: 100000, credit_limit_currency: "usd" });
    expect(v.error).toBeUndefined();
    expect(v.data.credit_limit_cents).toBe(100000);
    expect(v.data.credit_limit_currency).toBe("USD");
  });
  it("validateInsert rejects bad credit_limit_cents", () => {
    expect(validateInsert({ name: "ACME", credit_limit_cents: -5 }).error).toMatch(/credit_limit_cents/);
    expect(validateInsert({ name: "ACME", credit_limit_cents: 1.5 }).error).toMatch(/credit_limit_cents/);
  });
});
