// Tests for Payment Terms Master admin handlers (P3-9).
// Pure-JS — focused on the exported validate* helpers.

import { describe, it, expect } from "vitest";
import { validateInsert } from "../../_handlers/internal/payment-terms/index.js";
import { validatePatch }  from "../../_handlers/internal/payment-terms/[id].js";

// Plus a couple of integration-style tests for the vendor + customer master
// handlers to confirm payment_terms_id flows through their validators.
import { validateInsert as vendorInsert } from "../../_handlers/internal/vendor-master/index.js";
import { validatePatch  as vendorPatch  } from "../../_handlers/internal/vendor-master/[id].js";
import { validateInsert as customerInsert } from "../../_handlers/internal/customer-master/index.js";
import { validatePatch  as customerPatch  } from "../../_handlers/internal/customer-master/[id].js";

describe("payment-terms validateInsert", () => {
  it("rejects missing name", () => {
    expect(validateInsert({ code: "NET30", due_days: 30 }).error).toMatch(/name/);
  });
  it("rejects missing due_days", () => {
    expect(validateInsert({ code: "NET30", name: "Net 30" }).error).toMatch(/due_days/);
  });
  it("rejects negative due_days", () => {
    expect(validateInsert({ code: "NET30", name: "Net 30", due_days: -5 }).error).toMatch(/due_days/);
  });
  it("rejects non-integer due_days", () => {
    expect(validateInsert({ code: "NET30", name: "Net 30", due_days: 1.5 }).error).toMatch(/due_days/);
  });
  it("accepts due_days = 0 (COD)", () => {
    const v = validateInsert({ code: "COD", name: "Cash on Delivery", due_days: 0 });
    expect(v.error).toBeUndefined();
    expect(v.data.due_days).toBe(0);
  });

  it("does not take code from body (server-generated)", () => {
    const v = validateInsert({ code: "net30", name: "Net 30", due_days: 30 });
    expect(v.error).toBeUndefined();
    expect(v.data.code).toBeUndefined();
  });

  it("rejects discount_pct >= 1", () => {
    expect(validateInsert({ code: "X", name: "x", due_days: 30, discount_pct: 1.0 }).error).toMatch(/discount_pct/);
  });
  it("rejects negative discount_pct", () => {
    expect(validateInsert({ code: "X", name: "x", due_days: 30, discount_pct: -0.1 }).error).toMatch(/discount_pct/);
  });
  it("rejects non-numeric discount_pct", () => {
    expect(validateInsert({ code: "X", name: "x", due_days: 30, discount_pct: "two percent" }).error).toMatch(/discount_pct/);
  });
  it("rejects negative discount_days", () => {
    expect(validateInsert({ code: "X", name: "x", due_days: 30, discount_days: -1 }).error).toMatch(/discount_days/);
  });
  it("rejects discount_pct > 0 with discount_days = 0", () => {
    expect(validateInsert({ code: "X", name: "x", due_days: 30, discount_pct: 0.02, discount_days: 0 }).error).toMatch(/discount_days must be > 0/);
  });
  it("accepts discount_pct = 0 with discount_days = 0", () => {
    const v = validateInsert({ code: "NET30", name: "Net 30", due_days: 30 });
    expect(v.error).toBeUndefined();
    expect(v.data.discount_pct).toBe(0);
    expect(v.data.discount_days).toBe(0);
  });
  it("accepts discount_pct > 0 with discount_days > 0", () => {
    const v = validateInsert({ code: "2_10_NET30", name: "2/10 Net 30", due_days: 30, discount_pct: 0.02, discount_days: 10 });
    expect(v.error).toBeUndefined();
    expect(v.data.discount_pct).toBe(0.02);
    expect(v.data.discount_days).toBe(10);
  });

  it("defaults is_active to true", () => {
    expect(validateInsert({ code: "NET30", name: "Net 30", due_days: 30 }).data.is_active).toBe(true);
  });
  it("accepts is_active=false explicitly", () => {
    expect(validateInsert({ code: "NET30", name: "Net 30", due_days: 30, is_active: false }).data.is_active).toBe(false);
  });
  it("coerces is_active='true' string to boolean", () => {
    expect(validateInsert({ code: "NET30", name: "Net 30", due_days: 30, is_active: "true" }).data.is_active).toBe(true);
  });

  it("returns clean shape on a minimal valid payload", () => {
    const v = validateInsert({ code: "NET30", name: "Net 30", due_days: 30 });
    expect(v.error).toBeUndefined();
    expect(v.data).toEqual({
      name: "Net 30",
      due_days: 30,
      discount_pct: 0,
      discount_days: 0,
      is_active: true,
    });
  });
});

describe("payment-terms validatePatch", () => {
  it("rejects code (locked)", () => {
    expect(validatePatch({ code: "HACK" }).error).toMatch(/code is locked/);
  });
  it("rejects entity_id (locked)", () => {
    expect(validatePatch({ entity_id: "abc" }).error).toMatch(/entity_id is locked/);
  });
  it("rejects id (locked)", () => {
    expect(validatePatch({ id: "abc" }).error).toMatch(/id is locked/);
  });

  it("accepts mutable name", () => {
    const v = validatePatch({ name: "Updated" });
    expect(v.error).toBeUndefined();
    expect(v.data.name).toBe("Updated");
  });
  it("rejects blanked name", () => {
    expect(validatePatch({ name: "  " }).error).toMatch(/name/);
  });
  it("rejects blanked due_days", () => {
    expect(validatePatch({ due_days: "" }).error).toMatch(/due_days/);
  });
  it("rejects negative due_days in PATCH", () => {
    expect(validatePatch({ due_days: -1 }).error).toMatch(/due_days/);
  });
  it("accepts due_days=0 (COD swap)", () => {
    expect(validatePatch({ due_days: 0 }).data.due_days).toBe(0);
  });

  it("rejects discount_pct >= 1 in PATCH", () => {
    expect(validatePatch({ discount_pct: 1.0 }).error).toMatch(/discount_pct/);
  });
  it("normalizes empty discount fields to 0", () => {
    const v = validatePatch({ discount_pct: "", discount_days: "" });
    expect(v.data.discount_pct).toBe(0);
    expect(v.data.discount_days).toBe(0);
  });
  it("rejects discount_pct > 0 with discount_days = 0 when both supplied", () => {
    expect(validatePatch({ discount_pct: 0.05, discount_days: 0 }).error).toMatch(/discount_days must be > 0/);
  });
  it("accepts discount_pct > 0 with discount_days > 0", () => {
    const v = validatePatch({ discount_pct: 0.02, discount_days: 10 });
    expect(v.error).toBeUndefined();
    expect(v.data.discount_pct).toBe(0.02);
    expect(v.data.discount_days).toBe(10);
  });

  it("filters out non-mutable fields", () => {
    const v = validatePatch({ name: "ok", created_at: "2026-01-01" });
    expect(v.data.created_at).toBeUndefined();
    expect(v.data.name).toBe("ok");
  });

  it("coerces is_active=1 to true", () => {
    expect(validatePatch({ is_active: 1 }).data.is_active).toBe(true);
  });
  it("coerces is_active='true' to true", () => {
    expect(validatePatch({ is_active: "true" }).data.is_active).toBe(true);
  });

  it("accepts an empty body (caller rejects)", () => {
    const v = validatePatch({});
    expect(v.error).toBeUndefined();
    expect(v.data).toEqual({});
  });
});

describe("vendor-master payment_terms_id integration", () => {
  it("vendor insert accepts payment_terms_id UUID", () => {
    const ptId = "11111111-1111-1111-1111-111111111111";
    const v = vendorInsert({ name: "ACME", payment_terms_id: ptId });
    expect(v.error).toBeUndefined();
    expect(v.data.payment_terms_id).toBe(ptId);
  });
  it("vendor insert rejects malformed payment_terms_id", () => {
    expect(vendorInsert({ name: "ACME", payment_terms_id: "not-a-uuid" }).error).toMatch(/payment_terms_id/);
  });
  it("vendor insert normalizes empty payment_terms_id to null", () => {
    const v = vendorInsert({ name: "ACME", payment_terms_id: "" });
    expect(v.error).toBeUndefined();
    expect(v.data.payment_terms_id).toBeNull();
  });
  it("vendor patch accepts payment_terms_id", () => {
    const ptId = "22222222-2222-2222-2222-222222222222";
    const v = vendorPatch({ payment_terms_id: ptId });
    expect(v.error).toBeUndefined();
    expect(v.data.payment_terms_id).toBe(ptId);
  });
  it("vendor patch normalizes empty payment_terms_id to null", () => {
    const v = vendorPatch({ payment_terms_id: "" });
    expect(v.error).toBeUndefined();
    expect(v.data.payment_terms_id).toBeNull();
  });
  it("vendor patch rejects malformed payment_terms_id", () => {
    expect(vendorPatch({ payment_terms_id: "12345" }).error).toMatch(/payment_terms_id/);
  });
});

describe("customer-master payment_terms_id integration", () => {
  it("customer insert accepts payment_terms_id UUID", () => {
    const ptId = "33333333-3333-3333-3333-333333333333";
    const v = customerInsert({ name: "Big Box", payment_terms_id: ptId });
    expect(v.error).toBeUndefined();
    expect(v.data.payment_terms_id).toBe(ptId);
  });
  it("customer insert rejects malformed payment_terms_id", () => {
    expect(customerInsert({ name: "Big Box", payment_terms_id: "garbage" }).error).toMatch(/payment_terms_id/);
  });
  it("customer patch accepts payment_terms_id", () => {
    const ptId = "44444444-4444-4444-4444-444444444444";
    const v = customerPatch({ payment_terms_id: ptId });
    expect(v.error).toBeUndefined();
    expect(v.data.payment_terms_id).toBe(ptId);
  });
  it("customer patch normalizes empty payment_terms_id to null", () => {
    const v = customerPatch({ payment_terms_id: "" });
    expect(v.error).toBeUndefined();
    expect(v.data.payment_terms_id).toBeNull();
  });
  it("customer patch rejects malformed payment_terms_id", () => {
    expect(customerPatch({ payment_terms_id: "not-a-uuid" }).error).toMatch(/payment_terms_id/);
  });
});
