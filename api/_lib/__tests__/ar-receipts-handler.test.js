// Tests for Tangerine P4-5 AR Receipts handlers — pure validator exports.
//
// We exercise validateInsert + parseListQuery + validatePatch here. Live
// posting / DB triggers are covered by ar-receipts-post.test.js + the
// schema's own trigger tests in p4-1-ar-schema.test.js.

import { describe, it, expect } from "vitest";

import {
  validateInsert,
  parseListQuery,
  isUuid,
} from "../../_handlers/internal/ar-receipts/index.js";
import { validatePatch } from "../../_handlers/internal/ar-receipts/[id].js";

const UUID = "00000000-0000-0000-0000-000000000001";
const UUID2 = "00000000-0000-0000-0000-000000000002";
const UUID3 = "00000000-0000-0000-0000-000000000003";
const UUID4 = "00000000-0000-0000-0000-000000000004";

// ────────────────────────────────────────────────────────────────────────
// isUuid sanity
// ────────────────────────────────────────────────────────────────────────

describe("ar-receipts isUuid", () => {
  it("accepts a canonical uuid", () => {
    expect(isUuid(UUID)).toBe(true);
  });
  it("rejects garbage", () => {
    expect(isUuid("abc")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// parseListQuery
// ────────────────────────────────────────────────────────────────────────

describe("ar-receipts parseListQuery", () => {
  it("accepts empty params and defaults limit=100, offset=0", () => {
    const v = parseListQuery({});
    expect(v.error).toBeUndefined();
    expect(v.data.limit).toBe(100);
    expect(v.data.offset).toBe(0);
    expect(v.data.includeVoid).toBe(false);
    expect(v.data.customer_id).toBeNull();
    expect(v.data.method).toBeNull();
  });
  it("rejects non-uuid customer_id", () => {
    expect(parseListQuery({ customer_id: "nope" }).error).toMatch(/customer_id/);
  });
  it("accepts valid customer_id", () => {
    expect(parseListQuery({ customer_id: UUID }).data.customer_id).toBe(UUID);
  });
  it("rejects malformed dates", () => {
    expect(parseListQuery({ from: "2026/01/01" }).error).toMatch(/from/);
    expect(parseListQuery({ to: "yesterday" }).error).toMatch(/to/);
  });
  it("rejects invalid method", () => {
    expect(parseListQuery({ method: "venmo" }).error).toMatch(/method/);
  });
  it("accepts every supported method including paypal/stripe", () => {
    for (const m of ["ach", "wire", "check", "credit_card", "cash", "paypal", "stripe", "other"]) {
      expect(parseListQuery({ method: m }).error).toBeUndefined();
    }
  });
  it("caps limit at 500", () => {
    expect(parseListQuery({ limit: "9999" }).data.limit).toBe(500);
  });
  it("treats NaN limit as default", () => {
    expect(parseListQuery({ limit: "garbage" }).data.limit).toBe(100);
  });
  it("treats negative offset as 0", () => {
    expect(parseListQuery({ offset: "-10" }).data.offset).toBe(0);
  });
  it("preserves a valid offset (pagination per PostgREST cap rule)", () => {
    expect(parseListQuery({ offset: "1000" }).data.offset).toBe(1000);
  });
  it("flips includeVoid when query is true", () => {
    expect(parseListQuery({ include_void: "true" }).data.includeVoid).toBe(true);
    expect(parseListQuery({ include_void: "false" }).data.includeVoid).toBe(false);
    expect(parseListQuery({ include_void: "1" }).data.includeVoid).toBe(false);
  });
  it("normalizes empty filters to null", () => {
    const v = parseListQuery({ customer_id: "", method: "", from: "", to: "" });
    expect(v.data.customer_id).toBeNull();
    expect(v.data.method).toBeNull();
    expect(v.data.from).toBeNull();
    expect(v.data.to).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// validateInsert — header + applications schema
// ────────────────────────────────────────────────────────────────────────

const okBody = {
  customer_id: UUID,
  receipt_date: "2026-05-27",
  amount_cents: 10000,
  customer_payment_method: "ach",
  bank_account_id: UUID2,
};

describe("ar-receipts validateInsert header", () => {
  it("accepts a minimal valid body (no applications)", () => {
    const v = validateInsert(okBody);
    expect(v.error).toBeUndefined();
    expect(v.data.amount_cents).toBe("10000");
    expect(v.data.applications).toEqual([]);
  });
  it("rejects missing customer_id", () => {
    const b = { ...okBody };
    delete b.customer_id;
    expect(validateInsert(b).error).toMatch(/customer_id/);
  });
  it("rejects non-uuid customer_id", () => {
    expect(validateInsert({ ...okBody, customer_id: "abc" }).error).toMatch(/customer_id/);
  });
  it("rejects malformed receipt_date", () => {
    expect(validateInsert({ ...okBody, receipt_date: "5/27/2026" }).error).toMatch(/receipt_date/);
  });
  it("rejects missing receipt_date", () => {
    const b = { ...okBody };
    delete b.receipt_date;
    expect(validateInsert(b).error).toMatch(/receipt_date/);
  });
  it("rejects missing amount_cents", () => {
    const b = { ...okBody };
    delete b.amount_cents;
    expect(validateInsert(b).error).toMatch(/amount_cents/);
  });
  it("rejects zero amount_cents", () => {
    expect(validateInsert({ ...okBody, amount_cents: 0 }).error).toMatch(/amount_cents must be > 0/);
  });
  it("rejects negative amount_cents", () => {
    expect(validateInsert({ ...okBody, amount_cents: -1 }).error).toMatch(/amount_cents must be > 0/);
  });
  it("rejects float amount_cents", () => {
    expect(validateInsert({ ...okBody, amount_cents: 12.5 }).error).toMatch(/amount_cents/);
  });
  it("accepts amount_cents as integer string", () => {
    expect(validateInsert({ ...okBody, amount_cents: "1234" }).data.amount_cents).toBe("1234");
  });
  it("rejects non-integer amount_cents string", () => {
    expect(validateInsert({ ...okBody, amount_cents: "12.50" }).error).toMatch(/amount_cents/);
  });
  it("rejects missing customer_payment_method", () => {
    const b = { ...okBody };
    delete b.customer_payment_method;
    expect(validateInsert(b).error).toMatch(/customer_payment_method/);
  });
  it("rejects invalid method", () => {
    expect(validateInsert({ ...okBody, customer_payment_method: "venmo" }).error)
      .toMatch(/customer_payment_method/);
  });
  it("accepts paypal + stripe + other (P4-1 enum extras)", () => {
    for (const m of ["paypal", "stripe", "other"]) {
      expect(validateInsert({ ...okBody, customer_payment_method: m }).error).toBeUndefined();
    }
  });
  it("rejects non-uuid bank_account_id when present", () => {
    expect(validateInsert({ ...okBody, bank_account_id: "x" }).error).toMatch(/bank_account_id/);
  });
  it("accepts a null/undefined bank_account_id (server falls back to entity default)", () => {
    const b = { ...okBody };
    delete b.bank_account_id;
    expect(validateInsert(b).error).toBeUndefined();
  });
  it("rejects non-uuid created_by_user_id", () => {
    expect(validateInsert({ ...okBody, created_by_user_id: "abc" }).error)
      .toMatch(/created_by_user_id/);
  });
  it("trims reference and notes (null when empty after trim)", () => {
    const v = validateInsert({ ...okBody, reference: "  WIRE-123  ", notes: "" });
    expect(v.data.reference).toBe("WIRE-123");
    expect(v.data.notes).toBeNull();
  });
  it("amount_cents accepts a very large bigint-safe integer string", () => {
    const v = validateInsert({ ...okBody, amount_cents: "999999999999" });
    expect(v.data.amount_cents).toBe("999999999999");
  });
});

// ────────────────────────────────────────────────────────────────────────
// validateInsert — applications
// ────────────────────────────────────────────────────────────────────────

describe("ar-receipts validateInsert applications", () => {
  it("rejects non-uuid ar_invoice_id in application", () => {
    expect(validateInsert({
      ...okBody,
      applications: [{ ar_invoice_id: "abc", amount_applied_cents: 500 }],
    }).error).toMatch(/applications\[0\].ar_invoice_id/);
  });
  it("rejects duplicate invoice (same invoice listed twice)", () => {
    expect(validateInsert({
      ...okBody,
      applications: [
        { ar_invoice_id: UUID3, amount_applied_cents: 500 },
        { ar_invoice_id: UUID3, amount_applied_cents: 500 },
      ],
    }).error).toMatch(/duplicate/);
  });
  it("rejects missing amount_applied_cents", () => {
    expect(validateInsert({
      ...okBody,
      applications: [{ ar_invoice_id: UUID3 }],
    }).error).toMatch(/amount_applied_cents/);
  });
  it("rejects zero amount_applied_cents", () => {
    expect(validateInsert({
      ...okBody,
      applications: [{ ar_invoice_id: UUID3, amount_applied_cents: 0 }],
    }).error).toMatch(/amount_applied_cents must be > 0/);
  });
  it("rejects negative amount_applied_cents", () => {
    expect(validateInsert({
      ...okBody,
      applications: [{ ar_invoice_id: UUID3, amount_applied_cents: -1 }],
    }).error).toMatch(/amount_applied_cents must be > 0/);
  });
  it("REJECTS sum(applications) > receipt amount (over-application — caught in JS, not just DB)", () => {
    expect(validateInsert({
      ...okBody,
      amount_cents: 10000,
      applications: [
        { ar_invoice_id: UUID3, amount_applied_cents: 6000 },
        { ar_invoice_id: UUID4, amount_applied_cents: 5000 },
      ],
    }).error).toMatch(/exceeds receipt amount_cents/);
  });
  it("ALLOWS sum(applications) < receipt amount (under-application — on-account credit)", () => {
    const v = validateInsert({
      ...okBody,
      amount_cents: 10000,
      applications: [
        { ar_invoice_id: UUID3, amount_applied_cents: 3000 },
        { ar_invoice_id: UUID4, amount_applied_cents: 4000 },
      ],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.applications).toHaveLength(2);
  });
  it("ALLOWS sum(applications) === receipt amount (exact)", () => {
    const v = validateInsert({
      ...okBody,
      amount_cents: 10000,
      applications: [
        { ar_invoice_id: UUID3, amount_applied_cents: 7500 },
        { ar_invoice_id: UUID4, amount_applied_cents: 2500 },
      ],
    });
    expect(v.error).toBeUndefined();
  });
  it("trims application notes", () => {
    const v = validateInsert({
      ...okBody,
      applications: [{ ar_invoice_id: UUID3, amount_applied_cents: 500, notes: "  early-pay discount  " }],
    });
    expect(v.data.applications[0].notes).toBe("early-pay discount");
  });
  it("accepts applications array of length 0 (no applications = unapplied receipt)", () => {
    const v = validateInsert({ ...okBody, applications: [] });
    expect(v.error).toBeUndefined();
    expect(v.data.applications).toEqual([]);
  });
  it("treats missing applications field as empty array", () => {
    const v = validateInsert(okBody);
    expect(v.error).toBeUndefined();
    expect(v.data.applications).toEqual([]);
  });
  it("preserves amount_applied_cents as integer string (no precision loss)", () => {
    const v = validateInsert({
      ...okBody,
      amount_cents: "999999999",
      applications: [{ ar_invoice_id: UUID3, amount_applied_cents: "999999999" }],
    });
    expect(v.data.applications[0].amount_applied_cents).toBe("999999999");
  });
});

// ────────────────────────────────────────────────────────────────────────
// validatePatch — header-only edits
// ────────────────────────────────────────────────────────────────────────

describe("ar-receipts validatePatch", () => {
  it("returns empty data for empty body", () => {
    expect(validatePatch({}).data).toEqual({});
  });
  it("rejects entity_id mutation", () => {
    expect(validatePatch({ entity_id: UUID }).error).toMatch(/entity_id/);
  });
  it("rejects customer_id mutation (locked)", () => {
    expect(validatePatch({ customer_id: UUID }).error).toMatch(/customer_id/);
  });
  it("rejects amount_cents mutation", () => {
    expect(validatePatch({ amount_cents: 1 }).error).toMatch(/amount_cents/);
  });
  it("rejects accrual_je_id mutation (server-controlled)", () => {
    expect(validatePatch({ accrual_je_id: UUID }).error).toMatch(/accrual_je_id/);
  });
  it("rejects cash_je_id mutation", () => {
    expect(validatePatch({ cash_je_id: UUID }).error).toMatch(/cash_je_id/);
  });
  it("rejects is_void mutation (use /void)", () => {
    expect(validatePatch({ is_void: true }).error).toMatch(/is_void/);
  });
  it("rejects void_reason mutation", () => {
    expect(validatePatch({ void_reason: "x" }).error).toMatch(/void_reason/);
  });
  it("accepts receipt_date in correct format", () => {
    expect(validatePatch({ receipt_date: "2026-05-27" }).data.receipt_date).toBe("2026-05-27");
  });
  it("rejects bad receipt_date", () => {
    expect(validatePatch({ receipt_date: "5/27" }).error).toMatch(/receipt_date/);
  });
  it("rejects unknown customer_payment_method", () => {
    expect(validatePatch({ customer_payment_method: "venmo" }).error)
      .toMatch(/customer_payment_method/);
  });
  it("accepts all valid methods", () => {
    for (const m of ["ach", "wire", "check", "credit_card", "cash", "paypal", "stripe", "other"]) {
      expect(validatePatch({ customer_payment_method: m }).data.customer_payment_method).toBe(m);
    }
  });
  it("accepts bank_account_id uuid", () => {
    expect(validatePatch({ bank_account_id: UUID }).data.bank_account_id).toBe(UUID);
  });
  it("rejects clearing bank_account_id to null", () => {
    expect(validatePatch({ bank_account_id: null }).error).toMatch(/bank_account_id/);
  });
  it("rejects non-uuid bank_account_id", () => {
    expect(validatePatch({ bank_account_id: "x" }).error).toMatch(/bank_account_id/);
  });
  it("trims reference / notes; empty → null", () => {
    const v = validatePatch({ reference: "  CHECK-99  ", notes: "" });
    expect(v.data.reference).toBe("CHECK-99");
    expect(v.data.notes).toBeNull();
  });
  it("allows multiple header fields in one patch", () => {
    const v = validatePatch({
      receipt_date: "2026-06-01",
      customer_payment_method: "wire",
      reference: "WIRE-9",
    });
    expect(v.data.receipt_date).toBe("2026-06-01");
    expect(v.data.customer_payment_method).toBe("wire");
    expect(v.data.reference).toBe("WIRE-9");
  });
});
