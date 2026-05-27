// Tests for apInvoicePaid (P3-1).
//
// Produces BOTH accrual and cash candidates (sibling-linked at persist time).

import { describe, it, expect } from "vitest";
import { apInvoicePaid } from "../accounting/posting/rules/apInvoicePaid.js";

const ENTITY = "00000000-0000-0000-0000-000000000001";
const VENDOR = "11111111-1111-1111-1111-111111111111";
const INVOICE = "22222222-2222-2222-2222-222222222222";
const PAYMENT = "77777777-7777-7777-7777-777777777777";
const AP = "33333333-3333-3333-3333-333333333333";
const CASH = "88888888-8888-8888-8888-888888888888";
const EXP = "44444444-4444-4444-4444-444444444444";

function basePayment(extra = {}) {
  return {
    kind: "ap_invoice_paid",
    entity_id: ENTITY,
    data: {
      payment_id: PAYMENT,
      invoice_id: INVOICE,
      vendor_id: VENDOR,
      payment_date: "2026-05-27",
      ap_account_id: AP,
      cash_account_id: CASH,
      expense_account_id: EXP,
      ...extra,
    },
  };
}

describe("apInvoicePaid — accrual side", () => {
  it("produces accrual JE: DR AP / CR cash", () => {
    const r = apInvoicePaid(basePayment({ amount: "1000.00" }));
    expect(r.accrual).not.toBeNull();
    expect(r.accrual.basis).toBe("ACCRUAL");
    expect(r.accrual.lines[0].account_id).toBe(AP);
    expect(r.accrual.lines[0].debit).toBe("1000.00");
    expect(r.accrual.lines[0].subledger_type).toBe("vendor");
    expect(r.accrual.lines[0].subledger_id).toBe(VENDOR);
    expect(r.accrual.lines[1].account_id).toBe(CASH);
    expect(r.accrual.lines[1].credit).toBe("1000.00");
  });

  it("uses payment_date as posting_date", () => {
    const r = apInvoicePaid(basePayment({ amount: "10.00" }));
    expect(r.accrual.posting_date).toBe("2026-05-27");
    expect(r.accrual.journal_type).toBe("ap_payment");
    expect(r.accrual.source_module).toBe("ap");
    expect(r.accrual.source_table).toBe("payments");
    expect(r.accrual.source_id).toBe(PAYMENT);
  });

  it("description includes payment_reference when set", () => {
    const r = apInvoicePaid(basePayment({ amount: "10.00", payment_reference: "CHK-3001" }));
    expect(r.accrual.description).toContain("CHK-3001");
    expect(r.cash.description).toContain("CHK-3001");
  });
});

describe("apInvoicePaid — cash side", () => {
  it("produces cash JE: DR expense / CR cash", () => {
    const r = apInvoicePaid(basePayment({ amount: "1000.00" }));
    expect(r.cash).not.toBeNull();
    expect(r.cash.basis).toBe("CASH");
    expect(r.cash.lines[0].account_id).toBe(EXP);
    expect(r.cash.lines[0].debit).toBe("1000.00");
    expect(r.cash.lines[1].account_id).toBe(CASH);
    expect(r.cash.lines[1].credit).toBe("1000.00");
  });

  it("both bases balance", () => {
    const r = apInvoicePaid(basePayment({ amount: "1234.56" }));
    for (const side of [r.accrual, r.cash]) {
      const sumDr = side.lines.reduce((a, l) => a + parseFloat(l.debit), 0);
      const sumCr = side.lines.reduce((a, l) => a + parseFloat(l.credit), 0);
      expect(sumDr).toBeCloseTo(sumCr, 2);
      expect(sumDr).toBeCloseTo(1234.56, 2);
    }
  });
});

describe("apInvoicePaid — partial vs full", () => {
  it("partial payment produces both JEs at the partial amount", () => {
    const r = apInvoicePaid(basePayment({ amount: "250.00" }));
    expect(r.accrual.lines[0].debit).toBe("250.00");
    expect(r.cash.lines[0].debit).toBe("250.00");
  });

  it("full payment amount matches invoice total", () => {
    const r = apInvoicePaid(basePayment({ amount: "9999.99" }));
    expect(r.accrual.lines[0].debit).toBe("9999.99");
    expect(r.accrual.lines[1].credit).toBe("9999.99");
  });
});

describe("apInvoicePaid — validation", () => {
  it("throws when amount missing", () => {
    expect(() => apInvoicePaid(basePayment())).toThrow(/amount is required/);
  });

  it("throws when payment_id missing", () => {
    expect(() => apInvoicePaid({
      kind: "ap_invoice_paid", entity_id: ENTITY,
      data: {
        invoice_id: INVOICE, vendor_id: VENDOR, payment_date: "2026-05-27",
        amount: "10.00", ap_account_id: AP, cash_account_id: CASH, expense_account_id: EXP,
      },
    })).toThrow(/payment_id is required/);
  });

  it("throws when ap_account_id missing", () => {
    expect(() => apInvoicePaid({
      kind: "ap_invoice_paid", entity_id: ENTITY,
      data: {
        payment_id: PAYMENT, invoice_id: INVOICE, vendor_id: VENDOR,
        payment_date: "2026-05-27", amount: "10.00",
        cash_account_id: CASH, expense_account_id: EXP,
      },
    })).toThrow(/ap_account_id is required/);
  });

  it("throws when cash_account_id missing", () => {
    expect(() => apInvoicePaid({
      kind: "ap_invoice_paid", entity_id: ENTITY,
      data: {
        payment_id: PAYMENT, invoice_id: INVOICE, vendor_id: VENDOR,
        payment_date: "2026-05-27", amount: "10.00",
        ap_account_id: AP, expense_account_id: EXP,
      },
    })).toThrow(/cash_account_id is required/);
  });

  it("throws when expense_account_id missing (cash basis needs it)", () => {
    expect(() => apInvoicePaid({
      kind: "ap_invoice_paid", entity_id: ENTITY,
      data: {
        payment_id: PAYMENT, invoice_id: INVOICE, vendor_id: VENDOR,
        payment_date: "2026-05-27", amount: "10.00",
        ap_account_id: AP, cash_account_id: CASH,
      },
    })).toThrow(/expense_account_id is required/);
  });
});
