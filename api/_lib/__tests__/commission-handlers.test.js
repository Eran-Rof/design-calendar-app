// Tests for the P7-5 commission handler body / query validators.

import { describe, it, expect } from "vitest";
import { validateBody as validateAccrue }  from "../../_handlers/internal/commissions/accrue.js";
import { validateBody as validateReverse } from "../../_handlers/internal/commissions/reverse.js";
import { validateBody as validateSettle, isISODate } from "../../_handlers/internal/commissions/settle.js";
import { parseListQuery as parseAccrualsQuery } from "../../_handlers/internal/commissions/accruals.js";
import { parseListQuery as parsePayoutsQuery }  from "../../_handlers/internal/commissions/payouts.js";

const UUID  = "550e8400-e29b-41d4-a716-446655440000";
const UUID2 = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function P(o) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) sp.set(k, String(v));
  return sp;
}

describe("commissions/accrue validateBody", () => {
  it("rejects null body", () => {
    expect(validateAccrue(null).error).toMatch(/object/);
  });
  it("rejects missing ar_invoice_id", () => {
    expect(validateAccrue({}).error).toMatch(/ar_invoice_id/);
  });
  it("rejects malformed ar_invoice_id", () => {
    expect(validateAccrue({ ar_invoice_id: "abc" }).error).toMatch(/ar_invoice_id/);
  });
  it("accepts valid ar_invoice_id alone", () => {
    expect(validateAccrue({ ar_invoice_id: UUID }).data).toEqual({
      ar_invoice_id: UUID, actor_user_id: null,
    });
  });
  it("rejects malformed actor_user_id", () => {
    expect(validateAccrue({ ar_invoice_id: UUID, actor_user_id: "x" }).error).toMatch(/actor_user_id/);
  });
  it("accepts actor_user_id when valid", () => {
    expect(validateAccrue({ ar_invoice_id: UUID, actor_user_id: UUID2 }).data.actor_user_id).toBe(UUID2);
  });
  it("treats empty actor_user_id as null", () => {
    expect(validateAccrue({ ar_invoice_id: UUID, actor_user_id: "" }).data.actor_user_id).toBeNull();
  });
});

describe("commissions/reverse validateBody", () => {
  it("rejects missing ar_invoice_id", () => {
    expect(validateReverse({ reason: "void" }).error).toMatch(/ar_invoice_id/);
  });
  it("rejects missing reason", () => {
    expect(validateReverse({ ar_invoice_id: UUID }).error).toMatch(/reason/);
  });
  it("rejects empty reason", () => {
    expect(validateReverse({ ar_invoice_id: UUID, reason: "   " }).error).toMatch(/non-empty/);
  });
  it("rejects > 500-char reason", () => {
    expect(validateReverse({ ar_invoice_id: UUID, reason: "x".repeat(501) }).error).toMatch(/500/);
  });
  it("trims reason", () => {
    const v = validateReverse({ ar_invoice_id: UUID, reason: "  void shipment  " });
    expect(v.data.reason).toBe("void shipment");
  });
  it("accepts full valid body with actor", () => {
    const v = validateReverse({ ar_invoice_id: UUID, reason: "voided by ops", actor_user_id: UUID2 });
    expect(v.data).toEqual({ ar_invoice_id: UUID, reason: "voided by ops", actor_user_id: UUID2 });
  });
  it("rejects malformed actor_user_id", () => {
    expect(validateReverse({ ar_invoice_id: UUID, reason: "r", actor_user_id: "x" }).error).toMatch(/actor_user_id/);
  });
});

describe("commissions/settle isISODate", () => {
  it("accepts valid YYYY-MM-DD", () => {
    expect(isISODate("2026-05-28")).toBe(true);
  });
  it("rejects bad format", () => {
    expect(isISODate("2026/05/28")).toBe(false);
    expect(isISODate("28-05-2026")).toBe(false);
  });
  it("rejects invalid calendar date", () => {
    expect(isISODate("2026-02-30")).toBe(false);
    expect(isISODate("2026-13-01")).toBe(false);
  });
});

describe("commissions/settle validateBody", () => {
  const baseBody = () => ({
    sales_rep_id: UUID,
    period_id: UUID2,
    payment_method: "wire",
    paid_at: "2026-05-28",
    bank_account_id: "11111111-1111-1111-1111-111111111111",
  });

  it("rejects missing sales_rep_id", () => {
    const b = baseBody(); delete b.sales_rep_id;
    expect(validateSettle(b).error).toMatch(/sales_rep_id/);
  });
  it("rejects missing period_id", () => {
    const b = baseBody(); delete b.period_id;
    expect(validateSettle(b).error).toMatch(/period_id/);
  });
  it("rejects invalid payment_method", () => {
    const b = baseBody(); b.payment_method = "bitcoin";
    expect(validateSettle(b).error).toMatch(/payment_method/);
  });
  it("rejects each non-enum payment_method", () => {
    for (const bad of ["", "venmo", "paypal", "credit_card"]) {
      const b = baseBody(); b.payment_method = bad;
      expect(validateSettle(b).error).toMatch(/payment_method/);
    }
  });
  it("accepts each valid payment_method", () => {
    for (const ok of ["check", "wire", "ach", "cash", "other"]) {
      const b = baseBody(); b.payment_method = ok;
      const v = validateSettle(b);
      expect(v.error).toBeUndefined();
      expect(v.data.payment_method).toBe(ok);
    }
  });
  it("rejects bad paid_at", () => {
    const b = baseBody(); b.paid_at = "2026/05/28";
    expect(validateSettle(b).error).toMatch(/paid_at/);
  });
  it("rejects missing bank_account_id", () => {
    const b = baseBody(); delete b.bank_account_id;
    expect(validateSettle(b).error).toMatch(/bank_account_id/);
  });
  it("accepts a fully valid body", () => {
    const v = validateSettle(baseBody());
    expect(v.error).toBeUndefined();
    expect(v.data.sales_rep_id).toBe(UUID);
    expect(v.data.period_id).toBe(UUID2);
    expect(v.data.actor_user_id).toBeNull();
  });
  it("rejects malformed actor_user_id", () => {
    const b = baseBody(); b.actor_user_id = "x";
    expect(validateSettle(b).error).toMatch(/actor_user_id/);
  });
});

describe("commissions/accruals parseListQuery", () => {
  it("defaults to nulls", () => {
    expect(parseAccrualsQuery(P({})).data).toEqual({ sales_rep_id: null, status: null });
  });
  it("rejects bad sales_rep_id", () => {
    expect(parseAccrualsQuery(P({ sales_rep_id: "abc" })).error).toMatch(/sales_rep_id/);
  });
  it("accepts valid sales_rep_id", () => {
    expect(parseAccrualsQuery(P({ sales_rep_id: UUID })).data.sales_rep_id).toBe(UUID);
  });
  it("rejects bad status", () => {
    expect(parseAccrualsQuery(P({ status: "lost" })).error).toMatch(/status/);
  });
  it("accepts each valid status", () => {
    for (const st of ["accrued", "reversed", "paid"]) {
      expect(parseAccrualsQuery(P({ status: st })).data.status).toBe(st);
    }
  });
});

describe("commissions/payouts parseListQuery", () => {
  it("defaults to nulls", () => {
    expect(parsePayoutsQuery(P({})).data).toEqual({ sales_rep_id: null, period_id: null });
  });
  it("rejects bad sales_rep_id", () => {
    expect(parsePayoutsQuery(P({ sales_rep_id: "abc" })).error).toMatch(/sales_rep_id/);
  });
  it("rejects bad period_id", () => {
    expect(parsePayoutsQuery(P({ period_id: "abc" })).error).toMatch(/period_id/);
  });
  it("accepts both", () => {
    const v = parsePayoutsQuery(P({ sales_rep_id: UUID, period_id: UUID2 }));
    expect(v.data).toEqual({ sales_rep_id: UUID, period_id: UUID2 });
  });
});
