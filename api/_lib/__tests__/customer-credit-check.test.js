// Tests for the customer credit-limit check helper (P4-7).
//
// computeBreach is pure — exercised without a supabase mock.
// checkCreditLimit is exercised with a tiny in-memory supabase double.

import { describe, it, expect, vi } from "vitest";
import { checkCreditLimit, computeBreach } from "../customers/creditCheck.js";

describe("computeBreach — pure breach math", () => {
  it("returns no-breach when credit_limit_cents is null", () => {
    const r = computeBreach({
      credit_limit_cents: null,
      current_open_cents: 100000,
      proposed_amount_cents: 200000,
    });
    expect(r.would_breach).toBe(false);
    expect(r.breach_amount_cents).toBe(0);
    expect(r.projected_balance_cents).toBe(300000);
  });

  it("returns no-breach when credit_limit_cents is 0 (no-limit sentinel)", () => {
    const r = computeBreach({
      credit_limit_cents: 0,
      current_open_cents: 100000,
      proposed_amount_cents: 200000,
    });
    expect(r.would_breach).toBe(false);
    expect(r.credit_limit_cents).toBe(0);
  });

  it("no breach when projected exactly equals limit", () => {
    const r = computeBreach({
      credit_limit_cents: 500000,
      current_open_cents: 300000,
      proposed_amount_cents: 200000,
    });
    expect(r.would_breach).toBe(false);
    expect(r.projected_balance_cents).toBe(500000);
    expect(r.breach_amount_cents).toBe(0);
  });

  it("breaches when projected exceeds limit by 1 cent", () => {
    const r = computeBreach({
      credit_limit_cents: 500000,
      current_open_cents: 300000,
      proposed_amount_cents: 200001,
    });
    expect(r.would_breach).toBe(true);
    expect(r.breach_amount_cents).toBe(1);
  });

  it("computes large-breach correctly", () => {
    const r = computeBreach({
      credit_limit_cents: 100000,
      current_open_cents: 50000,
      proposed_amount_cents: 200000,
    });
    expect(r.would_breach).toBe(true);
    expect(r.projected_balance_cents).toBe(250000);
    expect(r.breach_amount_cents).toBe(150000);
  });

  it("propagates currency through unchanged", () => {
    const r = computeBreach({
      credit_limit_cents: 1000,
      credit_limit_currency: "EUR",
      current_open_cents: 800,
      proposed_amount_cents: 500,
    });
    expect(r.credit_limit_currency).toBe("EUR");
  });

  it("handles zero proposed amount safely", () => {
    const r = computeBreach({
      credit_limit_cents: 1000,
      current_open_cents: 500,
      proposed_amount_cents: 0,
    });
    expect(r.would_breach).toBe(false);
    expect(r.projected_balance_cents).toBe(500);
  });

  it("handles zero open balance safely", () => {
    const r = computeBreach({
      credit_limit_cents: 1000,
      current_open_cents: 0,
      proposed_amount_cents: 999,
    });
    expect(r.would_breach).toBe(false);
  });

  it("treats negative or NaN limit as no-limit", () => {
    expect(computeBreach({ credit_limit_cents: -1, current_open_cents: 0, proposed_amount_cents: 100 }).would_breach).toBe(false);
    expect(computeBreach({ credit_limit_cents: NaN, current_open_cents: 0, proposed_amount_cents: 100 }).would_breach).toBe(false);
  });
});

// ─── Minimal supabase double for checkCreditLimit ────────────────────────────
function makeSupabase({ customer, invoices = [] }) {
  return {
    from(table) {
      if (table === "customers") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: vi.fn().mockResolvedValue({ data: customer ?? null, error: null }),
        };
      }
      if (table === "ar_invoices") {
        const builder = {
          select() { return builder; },
          eq() { return builder; },
          in() { return builder; },
          neq() { return builder; },
          then(resolve) { return resolve({ data: invoices, error: null }); },
        };
        return builder;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

describe("checkCreditLimit — supabase integration", () => {
  it("returns no-breach for customer with credit_limit_cents=null", async () => {
    const sb = makeSupabase({ customer: { id: "c1", credit_limit_cents: null, credit_limit_currency: null }, invoices: [] });
    const r = await checkCreditLimit(sb, { customer_id: "c1", proposed_amount_cents: 999999 });
    expect(r.would_breach).toBe(false);
    expect(r.credit_limit_cents).toBe(0);
  });

  it("sums open AR balance from sent/partial/posted_historical invoices", async () => {
    const sb = makeSupabase({
      customer: { id: "c1", credit_limit_cents: 100000, credit_limit_currency: "USD" },
      invoices: [
        { id: "i1", total_amount_cents: 30000, paid_amount_cents: 0 },
        { id: "i2", total_amount_cents: 50000, paid_amount_cents: 20000 },  // 30000 open
      ],
    });
    const r = await checkCreditLimit(sb, { customer_id: "c1", proposed_amount_cents: 20000 });
    expect(r.current_open_cents).toBe(60000);
    expect(r.projected_balance_cents).toBe(80000);
    expect(r.would_breach).toBe(false);
  });

  it("breaches when sum + proposed exceeds credit_limit_cents", async () => {
    const sb = makeSupabase({
      customer: { id: "c1", credit_limit_cents: 100000, credit_limit_currency: "USD" },
      invoices: [
        { id: "i1", total_amount_cents: 80000, paid_amount_cents: 0 },
      ],
    });
    const r = await checkCreditLimit(sb, { customer_id: "c1", proposed_amount_cents: 30000 });
    expect(r.would_breach).toBe(true);
    expect(r.breach_amount_cents).toBe(10000);
  });

  it("ignores fully-paid invoices (balance <= 0)", async () => {
    const sb = makeSupabase({
      customer: { id: "c1", credit_limit_cents: 100000, credit_limit_currency: "USD" },
      invoices: [
        { id: "i1", total_amount_cents: 80000, paid_amount_cents: 80000 },
        { id: "i2", total_amount_cents: 50000, paid_amount_cents: 100000 },  // weird overpaid case
      ],
    });
    const r = await checkCreditLimit(sb, { customer_id: "c1", proposed_amount_cents: 50000 });
    expect(r.current_open_cents).toBe(0);
    expect(r.would_breach).toBe(false);
  });

  it("throws when customer not found", async () => {
    const sb = makeSupabase({ customer: null });
    await expect(checkCreditLimit(sb, { customer_id: "c1", proposed_amount_cents: 100 }))
      .rejects.toThrow(/customer.*not found/);
  });

  it("throws on missing customer_id", async () => {
    const sb = makeSupabase({ customer: { id: "c1" } });
    await expect(checkCreditLimit(sb, { proposed_amount_cents: 100 }))
      .rejects.toThrow(/customer_id required/);
  });

  it("throws on negative proposed_amount_cents", async () => {
    const sb = makeSupabase({ customer: { id: "c1", credit_limit_cents: 100 } });
    await expect(checkCreditLimit(sb, { customer_id: "c1", proposed_amount_cents: -1 }))
      .rejects.toThrow(/proposed_amount_cents must be >= 0/);
  });

  it("accepts proposed_amount_cents as string of integer", async () => {
    const sb = makeSupabase({ customer: { id: "c1", credit_limit_cents: 1000 }, invoices: [] });
    const r = await checkCreditLimit(sb, { customer_id: "c1", proposed_amount_cents: "500" });
    expect(r.projected_balance_cents).toBe(500);
  });

  it("rejects non-integer-string proposed_amount_cents", async () => {
    const sb = makeSupabase({ customer: { id: "c1" } });
    await expect(checkCreditLimit(sb, { customer_id: "c1", proposed_amount_cents: "12.34" }))
      .rejects.toThrow(/integer cents string/);
  });
});
