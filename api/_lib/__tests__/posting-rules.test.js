// Tests for the per-event rule modules. Pure-JS — no DB needed since rules
// are deterministic transforms (event payload → JE candidates).

import { describe, it, expect } from "vitest";
import { manualEntry } from "../accounting/posting/rules/manualEntry.js";
import { apInvoiceReceived } from "../accounting/posting/rules/apInvoiceReceived.js";
import { apInvoicePaid } from "../accounting/posting/rules/apInvoicePaid.js";
import { arInvoiceSent } from "../accounting/posting/rules/arInvoiceSent.js";
import { arPaymentReceived } from "../accounting/posting/rules/arPaymentReceived.js";
import { inventoryReceipt } from "../accounting/posting/rules/inventoryReceipt.js";
import { inventoryAdjustment } from "../accounting/posting/rules/inventoryAdjustment.js";

const ENTITY = "00000000-0000-0000-0000-000000000001";

describe("manualEntry", () => {
  it("ACCRUAL only", () => {
    const r = manualEntry({
      kind: "manual", entity_id: ENTITY,
      data: {
        basis: "ACCRUAL", posting_date: "2026-05-21",
        description: "test",
        lines: [
          { line_number: 1, account_id: "a", debit: "10", credit: "0" },
          { line_number: 2, account_id: "b", debit: "0", credit: "10" },
        ],
      },
    });
    expect(r.accrual).not.toBeNull();
    expect(r.cash).toBeNull();
    expect(r.accrual.basis).toBe("ACCRUAL");
    expect(r.accrual.journal_type).toBe("manual");
  });

  it("BOTH produces two candidates with identical lines", () => {
    const r = manualEntry({
      kind: "manual", entity_id: ENTITY,
      data: {
        basis: "BOTH", posting_date: "2026-05-21", description: "t",
        lines: [
          { line_number: 1, account_id: "a", debit: "5", credit: "0" },
          { line_number: 2, account_id: "b", debit: "0", credit: "5" },
        ],
      },
    });
    expect(r.accrual.basis).toBe("ACCRUAL");
    expect(r.cash.basis).toBe("CASH");
    expect(r.accrual.lines).toEqual(r.cash.lines);
  });

  it("throws when basis missing", () => {
    expect(() => manualEntry({
      kind: "manual", entity_id: ENTITY,
      data: { posting_date: "2026-05-21", lines: [{}] },
    })).toThrow(/basis is required/);
  });
});

describe("apInvoiceReceived", () => {
  it("produces accrual JE only (DR expense / CR ap)", () => {
    const r = apInvoiceReceived({
      kind: "ap_invoice_received", entity_id: ENTITY,
      data: {
        invoice_id: "inv-1", vendor_id: "v-1",
        invoice_number: "INV-001", invoice_date: "2026-05-21",
        amount: "1000.00",
        ap_account_id: "ap1", expense_account_id: "exp1",
      },
    });
    expect(r.cash).toBeNull();
    expect(r.accrual.lines).toHaveLength(2);
    expect(r.accrual.lines[0].account_id).toBe("exp1");
    expect(r.accrual.lines[0].debit).toBe("1000.00");
    expect(r.accrual.lines[1].account_id).toBe("ap1");
    expect(r.accrual.lines[1].credit).toBe("1000.00");
    expect(r.accrual.lines[1].subledger_type).toBe("vendor");
    expect(r.accrual.source_id).toBe("inv-1");
  });
});

describe("apInvoicePaid", () => {
  it("produces both accrual and cash JEs", () => {
    const r = apInvoicePaid({
      kind: "ap_invoice_paid", entity_id: ENTITY,
      data: {
        payment_id: "pay-1", invoice_id: "inv-1", vendor_id: "v-1",
        payment_date: "2026-05-21", amount: "1000.00",
        ap_account_id: "ap1", cash_account_id: "cash1", expense_account_id: "exp1",
      },
    });
    expect(r.accrual).not.toBeNull();
    expect(r.cash).not.toBeNull();
    // Accrual: DR AP / CR Cash
    expect(r.accrual.lines[0].account_id).toBe("ap1");
    expect(r.accrual.lines[0].debit).toBe("1000.00");
    expect(r.accrual.lines[1].account_id).toBe("cash1");
    // Cash basis: DR Expense / CR Cash
    expect(r.cash.lines[0].account_id).toBe("exp1");
    expect(r.cash.lines[1].account_id).toBe("cash1");
  });
});

describe("arInvoiceSent", () => {
  it("produces accrual JE only (DR ar / CR revenue)", () => {
    const r = arInvoiceSent({
      kind: "ar_invoice_sent", entity_id: ENTITY,
      data: {
        invoice_id: "ar-1", customer_id: "c-1",
        invoice_number: "AR-001", invoice_date: "2026-05-21",
        amount: "500.00",
        ar_account_id: "ar1", revenue_account_id: "rev1",
      },
    });
    expect(r.cash).toBeNull();
    expect(r.accrual.lines[0].account_id).toBe("ar1");
    expect(r.accrual.lines[0].subledger_type).toBe("customer");
    expect(r.accrual.lines[1].account_id).toBe("rev1");
  });
});

describe("arPaymentReceived", () => {
  it("produces both accrual and cash JEs", () => {
    const r = arPaymentReceived({
      kind: "ar_payment_received", entity_id: ENTITY,
      data: {
        receipt_id: "rcpt-1", invoice_id: "ar-1", customer_id: "c-1",
        receipt_date: "2026-05-21", amount: "500.00",
        ar_account_id: "ar1", cash_account_id: "cash1", revenue_account_id: "rev1",
      },
    });
    // Accrual: DR Cash / CR AR
    expect(r.accrual.lines[0].account_id).toBe("cash1");
    expect(r.accrual.lines[1].account_id).toBe("ar1");
    // Cash: DR Cash / CR Revenue
    expect(r.cash.lines[0].account_id).toBe("cash1");
    expect(r.cash.lines[1].account_id).toBe("rev1");
  });
});

describe("inventoryReceipt", () => {
  it("produces accrual JE only (DR inventory / CR GR-IR)", () => {
    const r = inventoryReceipt({
      kind: "inventory_receipt", entity_id: ENTITY,
      data: {
        receipt_id: "rcpt-1", vendor_id: "v-1", item_id: "i-1",
        receipt_date: "2026-05-21", amount: "750.00",
        inventory_account_id: "inv1", gr_ir_account_id: "grir1",
      },
    });
    expect(r.cash).toBeNull();
    expect(r.accrual.lines[0].account_id).toBe("inv1");
    expect(r.accrual.lines[0].subledger_type).toBe("item");
    expect(r.accrual.lines[1].account_id).toBe("grir1");
    expect(r.accrual.lines[1].subledger_type).toBe("vendor");
  });
});

describe("inventoryAdjustment", () => {
  it("'up' direction: DR inventory / CR adjustment, both bases", () => {
    const r = inventoryAdjustment({
      kind: "inventory_adjustment", entity_id: ENTITY,
      data: {
        adjustment_id: "adj-1", item_id: "i-1",
        adjustment_date: "2026-05-21", amount: "25.00", direction: "up",
        inventory_account_id: "inv1", adjustment_account_id: "adj1",
      },
    });
    expect(r.accrual.lines[0].account_id).toBe("inv1");
    expect(r.accrual.lines[0].subledger_type).toBe("item");
    expect(r.cash.lines).toEqual(r.accrual.lines);
  });

  it("'down' direction: DR adjustment / CR inventory", () => {
    const r = inventoryAdjustment({
      kind: "inventory_adjustment", entity_id: ENTITY,
      data: {
        adjustment_id: "adj-2", item_id: "i-1",
        adjustment_date: "2026-05-21", amount: "25.00", direction: "down",
        inventory_account_id: "inv1", adjustment_account_id: "adj1",
      },
    });
    expect(r.accrual.lines[0].account_id).toBe("adj1");
    expect(r.accrual.lines[1].account_id).toBe("inv1");
    expect(r.accrual.lines[1].subledger_type).toBe("item");
  });

  it("rejects invalid direction", () => {
    expect(() => inventoryAdjustment({
      kind: "inventory_adjustment", entity_id: ENTITY,
      data: {
        adjustment_id: "adj-3", item_id: "i-1",
        adjustment_date: "2026-05-21", amount: "25.00", direction: "sideways",
        inventory_account_id: "inv1", adjustment_account_id: "adj1",
      },
    })).toThrow(/direction must be/);
  });
});
