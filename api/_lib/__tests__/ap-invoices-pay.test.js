// Tests for P3-2 AP pay handler — body validator + partial-vs-full payment
// logic. Full-flow integration (insert + posting service + notification) is
// covered by smoke testing after deploy; this verifies the validator + the
// pure semantic helpers.

import { describe, it, expect } from "vitest";
import { validatePay } from "../../_handlers/internal/ap-invoices/pay.js";

const UUID = "00000000-0000-0000-0000-000000000001";

describe("ap-invoices pay validatePay", () => {
  it("rejects missing payment_date", () => {
    expect(validatePay({ amount_cents: 1, method: "ach" }).error).toMatch(/payment_date/);
  });
  it("rejects malformed payment_date", () => {
    expect(validatePay({ payment_date: "tomorrow", amount_cents: 1, method: "ach" }).error)
      .toMatch(/payment_date/);
  });
  it("rejects missing amount_cents", () => {
    expect(validatePay({ payment_date: "2026-05-26", method: "ach" }).error)
      .toMatch(/amount_cents/);
  });
  it("rejects zero amount_cents", () => {
    expect(validatePay({ payment_date: "2026-05-26", amount_cents: 0, method: "ach" }).error)
      .toMatch(/amount_cents must be > 0/);
  });
  it("rejects negative amount_cents", () => {
    expect(validatePay({ payment_date: "2026-05-26", amount_cents: -100, method: "ach" }).error)
      .toMatch(/amount_cents must be > 0/);
  });
  it("rejects non-integer string amount_cents", () => {
    expect(validatePay({ payment_date: "2026-05-26", amount_cents: "12.50", method: "ach" }).error)
      .toMatch(/amount_cents/);
  });
  it("rejects invalid method", () => {
    expect(validatePay({ payment_date: "2026-05-26", amount_cents: 100, method: "venmo" }).error)
      .toMatch(/method/);
  });
  it("rejects non-uuid bank_account_id", () => {
    expect(validatePay({ payment_date: "2026-05-26", amount_cents: 100, method: "ach", bank_account_id: "x" }).error)
      .toMatch(/bank_account_id/);
  });
  it("rejects non-uuid created_by_user_id", () => {
    expect(validatePay({ payment_date: "2026-05-26", amount_cents: 100, method: "ach", created_by_user_id: "abc" }).error)
      .toMatch(/created_by_user_id/);
  });

  it("accepts a minimal payment", () => {
    const v = validatePay({ payment_date: "2026-05-26", amount_cents: 100, method: "ach" });
    expect(v.error).toBeUndefined();
    expect(v.data.amount_cents).toBe("100");
    expect(v.data.method).toBe("ach");
    expect(v.data.bank_account_id).toBeNull();
  });
  it("accepts all 5 methods", () => {
    for (const m of ["ach", "wire", "check", "credit_card", "cash"]) {
      expect(validatePay({ payment_date: "2026-05-26", amount_cents: 100, method: m }).error).toBeUndefined();
    }
  });
  it("normalizes reference and notes (trim, null when empty)", () => {
    const v = validatePay({
      payment_date: "2026-05-26", amount_cents: 100, method: "ach",
      reference: "  WIRE-001  ", notes: "",
    });
    expect(v.data.reference).toBe("WIRE-001");
    expect(v.data.notes).toBeNull();
  });
  it("preserves bank_account_id and created_by_user_id uuid", () => {
    const v = validatePay({
      payment_date: "2026-05-26", amount_cents: 5000, method: "check",
      bank_account_id: UUID, created_by_user_id: UUID,
    });
    expect(v.data.bank_account_id).toBe(UUID);
    expect(v.data.created_by_user_id).toBe(UUID);
  });

  it("amount_cents accepts string of large digits without precision loss", () => {
    const v = validatePay({ payment_date: "2026-05-26", amount_cents: "999999999999", method: "wire" });
    expect(v.error).toBeUndefined();
    expect(v.data.amount_cents).toBe("999999999999");
  });
});

// Pure logic check: full-pay detection via BigInt comparison. The handler
// uses `paid >= total && total > 0` to flip gl_status='paid'. We replicate
// that check here to make sure BigInt arithmetic is correct across boundaries.
describe("ap-invoices pay — full-vs-partial payment detection", () => {
  function isFullyPaid(paid, total) {
    return BigInt(paid) >= BigInt(total) && BigInt(total) > 0n;
  }
  it("partial 50% does NOT flip", () => {
    expect(isFullyPaid(5000, 10000)).toBe(false);
  });
  it("exact 100% DOES flip", () => {
    expect(isFullyPaid(10000, 10000)).toBe(true);
  });
  it("over-paid (defensive) still flips", () => {
    expect(isFullyPaid(10001, 10000)).toBe(true);
  });
  it("zero total never flips (defensive)", () => {
    expect(isFullyPaid(0, 0)).toBe(false);
  });
  it("very large totals work without float drift", () => {
    expect(isFullyPaid("999999999998", "999999999999")).toBe(false);
    expect(isFullyPaid("999999999999", "999999999999")).toBe(true);
  });
});
