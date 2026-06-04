// Tests for apInvoiceReceived (P3-1).
//
// The rule produces an accrual-only JE; cash side is always null.
// Two payload shapes: single-amount (legacy/simple) and multi-line.

import { describe, it, expect } from "vitest";
import { apInvoiceReceived } from "../accounting/posting/rules/apInvoiceReceived.js";

const ENTITY = "00000000-0000-0000-0000-000000000001";
const VENDOR = "11111111-1111-1111-1111-111111111111";
const INVOICE = "22222222-2222-2222-2222-222222222222";
const AP = "33333333-3333-3333-3333-333333333333";
const EXP = "44444444-4444-4444-4444-444444444444";
const INV_ACC = "55555555-5555-5555-5555-555555555555";
const ITEM = "66666666-6666-6666-6666-666666666666";

function baseEvent(extra = {}) {
  return {
    kind: "ap_invoice_received",
    entity_id: ENTITY,
    data: {
      invoice_id: INVOICE,
      vendor_id: VENDOR,
      invoice_number: "INV-1001",
      invoice_date: "2026-05-27",
      ap_account_id: AP,
      ...extra,
    },
  };
}

describe("apInvoiceReceived — vendor credit memo (#3B expense offset)", () => {
  it("reverses DR/CR: credits the expense (offset), debits AP", () => {
    const r = apInvoiceReceived(baseEvent({
      invoice_kind: "vendor_credit_memo",
      amount: "250.00",
      expense_account_id: EXP,
    }));
    expect(r.accrual.journal_type).toBe("ap_credit_memo");
    expect(r.accrual.lines).toHaveLength(2);
    // expense line is now a CREDIT (offsetting the expense)
    expect(r.accrual.lines[0].account_id).toBe(EXP);
    expect(r.accrual.lines[0].credit).toBe("250.00");
    expect(r.accrual.lines[0].debit).toBe("0");
    // AP line is now a DEBIT (reduces payable / vendor receivable)
    expect(r.accrual.lines[1].account_id).toBe(AP);
    expect(r.accrual.lines[1].debit).toBe("250.00");
    expect(r.accrual.lines[1].credit).toBe("0");
  });

  it("drops queued inventory layers on a credit memo (no FIFO layer)", () => {
    const r = apInvoiceReceived(baseEvent({
      invoice_kind: "vendor_credit_memo",
      lines: [{ amount: "100.00", inventory_item_id: ITEM, inventory_account_id: INV_ACC, qty: "10", unit_cost_cents: "1000" }],
    }));
    expect(r.inventoryLayers).toBeUndefined();
  });
});

describe("apInvoiceReceived — single-amount path", () => {
  it("produces accrual-only JE with DR expense / CR AP", () => {
    const r = apInvoiceReceived(baseEvent({ amount: "1000.00", expense_account_id: EXP }));
    expect(r.cash).toBeNull();
    expect(r.accrual).not.toBeNull();
    expect(r.accrual.lines).toHaveLength(2);
    expect(r.accrual.lines[0].account_id).toBe(EXP);
    expect(r.accrual.lines[0].debit).toBe("1000.00");
    expect(r.accrual.lines[1].account_id).toBe(AP);
    expect(r.accrual.lines[1].credit).toBe("1000.00");
    expect(r.accrual.lines[1].subledger_type).toBe("vendor");
    expect(r.accrual.lines[1].subledger_id).toBe(VENDOR);
  });

  it("uses invoice_date as posting_date and writes journal_type='ap_invoice'", () => {
    const r = apInvoiceReceived(baseEvent({ amount: "50.00", expense_account_id: EXP }));
    expect(r.accrual.posting_date).toBe("2026-05-27");
    expect(r.accrual.journal_type).toBe("ap_invoice");
    expect(r.accrual.source_module).toBe("ap");
    expect(r.accrual.source_table).toBe("invoices");
    expect(r.accrual.source_id).toBe(INVOICE);
  });

  it("throws on missing required fields", () => {
    expect(() => apInvoiceReceived({
      kind: "ap_invoice_received", entity_id: ENTITY,
      data: { invoice_id: INVOICE, vendor_id: VENDOR, invoice_number: "X",
              invoice_date: "2026-05-27", ap_account_id: AP, amount: "10.00" },
    })).toThrow(/expense_account_id is required/);
  });

  it("throws when invoice_number is empty", () => {
    expect(() => apInvoiceReceived(baseEvent({
      amount: "100.00", expense_account_id: EXP, invoice_number: "",
    }))).toThrow(/invoice_number is required/);
  });

  it("preserves description across lines", () => {
    const r = apInvoiceReceived(baseEvent({ amount: "10.00", expense_account_id: EXP }));
    expect(r.accrual.description).toBe("AP invoice INV-1001");
    expect(r.accrual.lines[0].memo).toBe("AP invoice INV-1001");
    expect(r.accrual.lines[1].memo).toBe("AP invoice INV-1001");
  });
});

describe("apInvoiceReceived — multi-line path", () => {
  it("produces one DR per line + one summed CR to AP", () => {
    const r = apInvoiceReceived(baseEvent({
      lines: [
        { amount: "100.00", expense_account_id: EXP, memo: "Line 1" },
        { amount: "250.00", expense_account_id: EXP, memo: "Line 2" },
      ],
    }));
    expect(r.cash).toBeNull();
    expect(r.accrual.lines).toHaveLength(3);
    expect(r.accrual.lines[0].account_id).toBe(EXP);
    expect(r.accrual.lines[0].debit).toBe("100.00");
    expect(r.accrual.lines[1].account_id).toBe(EXP);
    expect(r.accrual.lines[1].debit).toBe("250.00");
    expect(r.accrual.lines[2].account_id).toBe(AP);
    expect(r.accrual.lines[2].credit).toBe("350.00");
  });

  it("inventory line uses inventory_account_id + sets item subledger", () => {
    const r = apInvoiceReceived(baseEvent({
      lines: [
        {
          amount: "750.00",
          inventory_item_id: ITEM,
          inventory_account_id: INV_ACC,
          memo: "Inventory receipt",
        },
      ],
    }));
    expect(r.accrual.lines).toHaveLength(2);
    expect(r.accrual.lines[0].account_id).toBe(INV_ACC);
    expect(r.accrual.lines[0].debit).toBe("750.00");
    expect(r.accrual.lines[0].subledger_type).toBe("item");
    expect(r.accrual.lines[0].subledger_id).toBe(ITEM);
    expect(r.accrual.lines[1].account_id).toBe(AP);
    expect(r.accrual.lines[1].credit).toBe("750.00");
  });

  it("multi-line is balanced (sum DR === sum CR)", () => {
    const r = apInvoiceReceived(baseEvent({
      lines: [
        { amount: "100.00", expense_account_id: EXP },
        { amount: "75.25", expense_account_id: EXP },
        { amount: "0.50", inventory_item_id: ITEM, inventory_account_id: INV_ACC },
      ],
    }));
    const sumDr = r.accrual.lines.reduce((acc, l) => acc + parseFloat(l.debit), 0);
    const sumCr = r.accrual.lines.reduce((acc, l) => acc + parseFloat(l.credit), 0);
    expect(sumDr).toBeCloseTo(175.75, 2);
    expect(sumCr).toBeCloseTo(175.75, 2);
  });

  it("inventory line without inventory_account_id throws", () => {
    expect(() => apInvoiceReceived(baseEvent({
      lines: [{ amount: "10.00", inventory_item_id: ITEM }],
    }))).toThrow(/inventory_account_id/);
  });

  it("expense line without expense_account_id throws", () => {
    expect(() => apInvoiceReceived(baseEvent({
      lines: [{ amount: "10.00" }],
    }))).toThrow(/expense_account_id/);
  });

  it("line without amount throws", () => {
    expect(() => apInvoiceReceived(baseEvent({
      lines: [{ expense_account_id: EXP }],
    }))).toThrow(/amount/);
  });

  it("idempotency key derivation: source_id stable across reruns", () => {
    const r1 = apInvoiceReceived(baseEvent({ amount: "100.00", expense_account_id: EXP }));
    const r2 = apInvoiceReceived(baseEvent({ amount: "100.00", expense_account_id: EXP }));
    expect(r1.accrual.source_id).toBe(r2.accrual.source_id);
    expect(r1.accrual.source_table).toBe(r2.accrual.source_table);
    // (source_module, source_table, source_id) is the natural idempotency key
    // for the gl_post_journal_entry RPC.
  });
});
