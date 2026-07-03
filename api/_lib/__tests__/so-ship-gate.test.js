// Tests for the non-factor Sales-Order credit ship-gate helpers.
//
// classifyGate / creditCardUnpaid are pure. houseAccountOverdue and
// evaluateSoCreditGate are exercised with a tiny in-memory supabase double that
// mirrors the chained query the gate builds (.in/.not/.lt/.eq).

import { describe, it, expect, vi } from "vitest";
import {
  classifyGate, creditCardUnpaid, houseAccountOverdue, evaluateSoCreditGate, OPEN_AR_STATUSES,
} from "../customers/soShipGate.js";

describe("classifyGate — pure customer/term classification", () => {
  it("factored customer is always the factor gate (skipped here)", () => {
    expect(classifyGate({ is_factored: true, term: { code: "NET30", due_days: 30 } })).toBe("factor");
    expect(classifyGate({ is_factored: true, term: { code: "CREDIT_CARD", due_days: 0 } })).toBe("factor");
  });
  it("CREDIT_CARD term → credit_card gate (non-factored)", () => {
    expect(classifyGate({ is_factored: false, term: { code: "CREDIT_CARD", due_days: 0 } })).toBe("credit_card");
  });
  it("net terms (due_days > 0) → house_account gate", () => {
    expect(classifyGate({ is_factored: false, term: { code: "NET30", due_days: 30 } })).toBe("house_account");
  });
  it("COD / due-on-receipt (due_days 0) → no gate", () => {
    expect(classifyGate({ is_factored: false, term: { code: "COD", due_days: 0 } })).toBe("none");
    expect(classifyGate({ is_factored: false, term: null })).toBe("none");
  });
});

describe("creditCardUnpaid — pure predicate", () => {
  const term = { code: "CREDIT_CARD", due_days: 0 };
  it("true when card order not paid in full", () => {
    expect(creditCardUnpaid({ total_cents: 10000, amount_paid_cents: 0 }, term)).toBe(true);
    expect(creditCardUnpaid({ total_cents: 10000, amount_paid_cents: 9999 }, term)).toBe(true);
  });
  it("false when paid in full or overpaid", () => {
    expect(creditCardUnpaid({ total_cents: 10000, amount_paid_cents: 10000 }, term)).toBe(false);
    expect(creditCardUnpaid({ total_cents: 10000, amount_paid_cents: 12000 }, term)).toBe(false);
  });
  it("false for non-card terms regardless of payment", () => {
    expect(creditCardUnpaid({ total_cents: 10000, amount_paid_cents: 0 }, { code: "NET30", due_days: 30 })).toBe(false);
    expect(creditCardUnpaid({ total_cents: 10000, amount_paid_cents: 0 }, null)).toBe(false);
  });
});

// ─── supabase double for the ar_invoices overdue query ───────────────────────
function makeArSupabase({ customer = null, term = null, invoices = [] } = {}) {
  return {
    from(table) {
      if (table === "customers") {
        return { select() { return this; }, eq() { return this; }, maybeSingle: vi.fn().mockResolvedValue({ data: customer, error: null }) };
      }
      if (table === "payment_terms") {
        return { select() { return this; }, eq() { return this; }, maybeSingle: vi.fn().mockResolvedValue({ data: term, error: null }) };
      }
      if (table === "ar_invoices") {
        const b = {
          select() { return b; }, eq() { return b; }, in() { return b; },
          not() { return b; }, lt() { return b; },
          then(resolve) { return resolve({ data: invoices, error: null }); },
        };
        return b;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

describe("houseAccountOverdue — supabase integration", () => {
  it("exports the AR open-status set used by the aging views", () => {
    expect(OPEN_AR_STATUSES).toContain("sent");
    expect(OPEN_AR_STATUSES).toContain("partial_paid");
    expect(OPEN_AR_STATUSES).toContain("posted_historical");
  });

  it("flags overdue with count + summed outstanding + oldest due date", async () => {
    const sb = makeArSupabase({ invoices: [
      { id: "i1", total_amount_cents: 30000, paid_amount_cents: 0, due_date: "2026-03-01" },
      { id: "i2", total_amount_cents: 50000, paid_amount_cents: 20000, due_date: "2026-04-15" }, // 30000 open
    ] });
    const r = await houseAccountOverdue(sb, { customer_id: "c1", today: "2026-06-18" });
    expect(r.overdue).toBe(true);
    expect(r.count).toBe(2);
    expect(r.overdue_cents).toBe(60000);
    expect(r.oldest_due_date).toBe("2026-03-01");
  });

  it("ignores fully-paid invoices (zero balance) even if past due", async () => {
    const sb = makeArSupabase({ invoices: [
      { id: "i1", total_amount_cents: 30000, paid_amount_cents: 30000, due_date: "2026-03-01" },
    ] });
    const r = await houseAccountOverdue(sb, { customer_id: "c1", today: "2026-06-18" });
    expect(r.overdue).toBe(false);
    expect(r.count).toBe(0);
  });

  it("no overdue rows → not overdue", async () => {
    const sb = makeArSupabase({ invoices: [] });
    const r = await houseAccountOverdue(sb, { customer_id: "c1", today: "2026-06-18" });
    expect(r.overdue).toBe(false);
  });
});

describe("evaluateSoCreditGate — orchestration", () => {
  it("factored customer is not gated here", async () => {
    const sb = makeArSupabase({ customer: { is_factored: true }, term: { code: "NET30", due_days: 30 } });
    const d = await evaluateSoCreditGate(sb, { customer_id: "c1", payment_terms_id: "t1", total_cents: 10000, amount_paid_cents: 0 });
    expect(d.gate).toBe("factor");
    expect(d.blocked).toBe(false);
    expect(d.target_status).toBe("not_required");
  });

  it("credit-card unpaid → pending + blocked", async () => {
    const sb = makeArSupabase({ customer: { is_factored: false }, term: { code: "CREDIT_CARD", due_days: 0 } });
    const d = await evaluateSoCreditGate(sb, { customer_id: "c1", payment_terms_id: "t1", total_cents: 10000, amount_paid_cents: 0 });
    expect(d.gate).toBe("credit_card");
    expect(d.blocked).toBe(true);
    expect(d.target_status).toBe("pending");
  });

  it("credit-card paid in full → not blocked", async () => {
    const sb = makeArSupabase({ customer: { is_factored: false }, term: { code: "CREDIT_CARD", due_days: 0 } });
    const d = await evaluateSoCreditGate(sb, { customer_id: "c1", payment_terms_id: "t1", total_cents: 10000, amount_paid_cents: 10000 });
    expect(d.blocked).toBe(false);
    expect(d.target_status).toBe("not_required");
  });

  it("house account with overdue AR → on_hold + blocked", async () => {
    const sb = makeArSupabase({
      customer: { is_factored: false }, term: { code: "NET30", due_days: 30 },
      invoices: [{ id: "i1", total_amount_cents: 5000, paid_amount_cents: 0, due_date: "2026-01-01" }],
    });
    const d = await evaluateSoCreditGate(sb, { customer_id: "c1", entity_id: "e1", payment_terms_id: "t1", total_cents: 10000, amount_paid_cents: 0, today: "2026-06-18" });
    expect(d.gate).toBe("house_account");
    expect(d.blocked).toBe(true);
    expect(d.target_status).toBe("on_hold");
    expect(d.reason).toMatch(/overdue/i);
  });

  it("house account with no overdue AR → not blocked", async () => {
    const sb = makeArSupabase({ customer: { is_factored: false }, term: { code: "NET30", due_days: 30 }, invoices: [] });
    const d = await evaluateSoCreditGate(sb, { customer_id: "c1", entity_id: "e1", payment_terms_id: "t1", total_cents: 10000, amount_paid_cents: 0 });
    expect(d.blocked).toBe(false);
  });

  it("COD / no term and not factored → no gate", async () => {
    const sb = makeArSupabase({ customer: { is_factored: false }, term: null });
    const d = await evaluateSoCreditGate(sb, { customer_id: "c1", total_cents: 10000, amount_paid_cents: 0 });
    expect(d.gate).toBe("none");
    expect(d.blocked).toBe(false);
  });
});
