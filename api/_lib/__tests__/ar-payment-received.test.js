// Tests for arPaymentReceived (P4-2; arch §4.2).
//
// Both single-application (legacy) and multi-application (P4-2) shapes
// supported. Always emits BOTH accrual + cash JE candidates (sibling-linked
// via persist.js + gl_link_sibling_je).

import { describe, it, expect } from "vitest";
import { arPaymentReceived } from "../accounting/posting/rules/arPaymentReceived.js";

const ENTITY = "00000000-0000-0000-0000-000000000001";
const CUSTOMER = "11111111-1111-1111-1111-111111111111";
const RECEIPT = "22222222-2222-2222-2222-222222222222";
const INV_A = "33333333-3333-3333-3333-333333333333";
const INV_B = "44444444-4444-4444-4444-444444444444";
const AR_A = "55555555-5555-5555-5555-555555555555";
const AR_B = "66666666-6666-6666-6666-666666666666";
const REV_A = "77777777-7777-7777-7777-777777777777";
const REV_B = "88888888-8888-8888-8888-888888888888";
const BANK = "99999999-9999-9999-9999-999999999999";

function baseEvent(extra = {}) {
  return {
    kind: "ar_payment_received",
    entity_id: ENTITY,
    data: {
      receipt_id: RECEIPT,
      customer_id: CUSTOMER,
      receipt_date: "2026-05-27",
      bank_account_id: BANK,
      ...extra,
    },
  };
}

describe("arPaymentReceived — single-application legacy path", () => {
  it("emits accrual + cash JEs with both bases", () => {
    const r = arPaymentReceived(baseEvent({
      amount: "500.00",
      ar_account_id: AR_A,
      revenue_account_id: REV_A,
      invoice_id: INV_A,
    }));
    expect(r.accrual).not.toBeNull();
    expect(r.cash).not.toBeNull();
    expect(r.accrual.basis).toBe("ACCRUAL");
    expect(r.cash.basis).toBe("CASH");
  });

  it("accrual: DR bank / CR ar_account", () => {
    const r = arPaymentReceived(baseEvent({
      amount: "100.00",
      ar_account_id: AR_A,
      revenue_account_id: REV_A,
    }));
    expect(r.accrual.lines).toHaveLength(2);
    expect(r.accrual.lines[0].account_id).toBe(BANK);
    expect(r.accrual.lines[0].debit).toBe("100.00");
    expect(r.accrual.lines[1].account_id).toBe(AR_A);
    expect(r.accrual.lines[1].credit).toBe("100.00");
    expect(r.accrual.lines[1].subledger_type).toBe("customer");
    expect(r.accrual.lines[1].subledger_id).toBe(CUSTOMER);
  });

  it("cash: DR bank / CR revenue (deferred recognition)", () => {
    const r = arPaymentReceived(baseEvent({
      amount: "100.00",
      ar_account_id: AR_A,
      revenue_account_id: REV_A,
    }));
    expect(r.cash.lines[0].account_id).toBe(BANK);
    expect(r.cash.lines[0].debit).toBe("100.00");
    expect(r.cash.lines[1].account_id).toBe(REV_A);
    expect(r.cash.lines[1].credit).toBe("100.00");
  });

  it("legacy cash_account_id alias works", () => {
    const e = baseEvent({
      amount: "10.00",
      ar_account_id: AR_A,
      revenue_account_id: REV_A,
    });
    delete e.data.bank_account_id;
    e.data.cash_account_id = BANK;
    const r = arPaymentReceived(e);
    expect(r.accrual.lines[0].account_id).toBe(BANK);
  });

  it("missing bank_account_id (and cash_account_id) throws", () => {
    const e = baseEvent({ amount: "10.00", ar_account_id: AR_A, revenue_account_id: REV_A });
    delete e.data.bank_account_id;
    expect(() => arPaymentReceived(e)).toThrow(/bank_account_id/);
  });

  it("uses 'ar_receipt' as journal_type", () => {
    const r = arPaymentReceived(baseEvent({
      amount: "10.00", ar_account_id: AR_A, revenue_account_id: REV_A,
    }));
    expect(r.accrual.journal_type).toBe("ar_receipt");
    expect(r.cash.journal_type).toBe("ar_receipt");
  });
});

describe("arPaymentReceived — multi-application path", () => {
  function multiAppEvent(extra = {}) {
    return baseEvent({
      applications: [
        { ar_invoice_id: INV_A, ar_account_id: AR_A, revenue_account_id: REV_A, amount_cents: 10000 },
        { ar_invoice_id: INV_B, ar_account_id: AR_B, revenue_account_id: REV_B, amount_cents: 25000 },
      ],
      ...extra,
    });
  }

  it("ONE accrual JE with header DR bank + per-app CR ar_account", () => {
    const r = arPaymentReceived(multiAppEvent());
    expect(r.accrual.lines).toHaveLength(3);
    // Header
    expect(r.accrual.lines[0].account_id).toBe(BANK);
    expect(r.accrual.lines[0].debit).toBe("350.00");
    // Per-app CR
    expect(r.accrual.lines[1].account_id).toBe(AR_A);
    expect(r.accrual.lines[1].credit).toBe("100.00");
    expect(r.accrual.lines[1].subledger_type).toBe("customer");
    expect(r.accrual.lines[1].subledger_id).toBe(CUSTOMER);
    expect(r.accrual.lines[2].account_id).toBe(AR_B);
    expect(r.accrual.lines[2].credit).toBe("250.00");
  });

  it("ONE cash JE with header DR bank + per-app CR revenue (split by app)", () => {
    const r = arPaymentReceived(multiAppEvent());
    expect(r.cash.lines).toHaveLength(3);
    expect(r.cash.lines[0].account_id).toBe(BANK);
    expect(r.cash.lines[0].debit).toBe("350.00");
    expect(r.cash.lines[1].account_id).toBe(REV_A);
    expect(r.cash.lines[1].credit).toBe("100.00");
    expect(r.cash.lines[2].account_id).toBe(REV_B);
    expect(r.cash.lines[2].credit).toBe("250.00");
  });

  it("both bases balanced", () => {
    const r = arPaymentReceived(multiAppEvent());
    const sumDrA = r.accrual.lines.reduce((a, l) => a + parseFloat(l.debit), 0);
    const sumCrA = r.accrual.lines.reduce((a, l) => a + parseFloat(l.credit), 0);
    expect(sumDrA).toBeCloseTo(350.00, 2);
    expect(sumCrA).toBeCloseTo(350.00, 2);
    const sumDrC = r.cash.lines.reduce((a, l) => a + parseFloat(l.debit), 0);
    const sumCrC = r.cash.lines.reduce((a, l) => a + parseFloat(l.credit), 0);
    expect(sumDrC).toBeCloseTo(350.00, 2);
    expect(sumCrC).toBeCloseTo(350.00, 2);
  });

  it("missing ar_account_id on an application throws", () => {
    expect(() => arPaymentReceived(baseEvent({
      applications: [{ ar_invoice_id: INV_A, revenue_account_id: REV_A, amount_cents: 100 }],
    }))).toThrow(/ar_account_id/);
  });

  it("missing revenue_account_id on an application throws", () => {
    expect(() => arPaymentReceived(baseEvent({
      applications: [{ ar_invoice_id: INV_A, ar_account_id: AR_A, amount_cents: 100 }],
    }))).toThrow(/revenue_account_id/);
  });

  it("missing amount_cents on an application throws", () => {
    expect(() => arPaymentReceived(baseEvent({
      applications: [{ ar_invoice_id: INV_A, ar_account_id: AR_A, revenue_account_id: REV_A }],
    }))).toThrow(/amount_cents/);
  });

  it("zero/negative amount_cents on an application throws", () => {
    expect(() => arPaymentReceived(baseEvent({
      applications: [{ ar_invoice_id: INV_A, ar_account_id: AR_A, revenue_account_id: REV_A, amount_cents: 0 }],
    }))).toThrow(/must be > 0/);
    expect(() => arPaymentReceived(baseEvent({
      applications: [{ ar_invoice_id: INV_A, ar_account_id: AR_A, revenue_account_id: REV_A, amount_cents: -100 }],
    }))).toThrow(/must be > 0/);
  });

  it("total_amount_cents mismatch with applications sum throws", () => {
    expect(() => arPaymentReceived(baseEvent({
      total_amount_cents: 99999,
      applications: [
        { ar_invoice_id: INV_A, ar_account_id: AR_A, revenue_account_id: REV_A, amount_cents: 10000 },
        { ar_invoice_id: INV_B, ar_account_id: AR_B, revenue_account_id: REV_B, amount_cents: 25000 },
      ],
    }))).toThrow(/does not equal sum/);
  });

  it("total_amount_cents matching applications sum is accepted", () => {
    const r = arPaymentReceived(baseEvent({
      total_amount_cents: 35000,
      applications: [
        { ar_invoice_id: INV_A, ar_account_id: AR_A, revenue_account_id: REV_A, amount_cents: 10000 },
        { ar_invoice_id: INV_B, ar_account_id: AR_B, revenue_account_id: REV_B, amount_cents: 25000 },
      ],
    }));
    expect(r.accrual.lines[0].debit).toBe("350.00");
  });

  it("invoice_number in application is used in line memo when provided", () => {
    const r = arPaymentReceived(baseEvent({
      applications: [
        { ar_invoice_id: INV_A, ar_account_id: AR_A, revenue_account_id: REV_A,
          amount_cents: 10000, invoice_number: "AR-2026-00100" },
      ],
    }));
    expect(r.accrual.lines[1].memo).toContain("AR-2026-00100");
    expect(r.cash.lines[1].memo).toContain("AR-2026-00100");
  });
});

describe("arPaymentReceived — bypass_period_lock pass-through (P4-8 backfill)", () => {
  it("propagates bypass_period_lock onto both accrual + cash candidates", () => {
    const e = baseEvent({
      amount: "100.00",
      ar_account_id: AR_A,
      revenue_account_id: REV_A,
      journal_type: "ar_receipt_historical",
    });
    e.bypass_period_lock = true;
    const r = arPaymentReceived(e);
    expect(r.accrual.bypass_period_lock).toBe(true);
    expect(r.cash.bypass_period_lock).toBe(true);
    expect(r.accrual.journal_type).toBe("ar_receipt_historical");
  });

  it("default bypass_period_lock is false on both bases", () => {
    const r = arPaymentReceived(baseEvent({
      amount: "100.00", ar_account_id: AR_A, revenue_account_id: REV_A,
    }));
    expect(r.accrual.bypass_period_lock).toBe(false);
    expect(r.cash.bypass_period_lock).toBe(false);
  });
});

describe("arPaymentReceived — required-field validation", () => {
  it("missing receipt_id throws", () => {
    const e = baseEvent({ amount: "10.00", ar_account_id: AR_A, revenue_account_id: REV_A });
    delete e.data.receipt_id;
    expect(() => arPaymentReceived(e)).toThrow(/receipt_id/);
  });
  it("missing customer_id throws", () => {
    const e = baseEvent({ amount: "10.00", ar_account_id: AR_A, revenue_account_id: REV_A });
    delete e.data.customer_id;
    expect(() => arPaymentReceived(e)).toThrow(/customer_id/);
  });
  it("missing receipt_date throws", () => {
    const e = baseEvent({ amount: "10.00", ar_account_id: AR_A, revenue_account_id: REV_A });
    delete e.data.receipt_date;
    expect(() => arPaymentReceived(e)).toThrow(/receipt_date/);
  });
});
