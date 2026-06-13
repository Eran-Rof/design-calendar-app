// Unit test for the M5b part-line branch in apInvoiceReceived: a vendor bill
// line that stocks a part into part inventory (1360) instead of a style SKU.

import { describe, it, expect } from "vitest";
import { apInvoiceReceived } from "../apInvoiceReceived.js";

const ENTITY = "11111111-1111-1111-1111-111111111111";
const INV = "22222222-2222-2222-2222-222222222222";
const VENDOR = "33333333-3333-3333-3333-333333333333";
const AP = "44444444-4444-4444-4444-444444444444";
const PARTS_ACCT = "55555555-5555-5555-5555-555555555555";
const PART = "66666666-6666-6666-6666-666666666666";

const baseData = {
  invoice_id: INV, vendor_id: VENDOR, invoice_number: "PB-1", invoice_date: "2026-06-13", ap_account_id: AP,
};

describe("apInvoiceReceived — part line (M5b)", () => {
  const event = {
    entity_id: ENTITY,
    data: { ...baseData, lines: [{ amount: "120.00", part_id: PART, part_inventory_account_id: PARTS_ACCT, qty: 100, unit_cost_cents: 120 }] },
  };

  it("debits 1360 with a 'part' subledger and credits AP with a 'vendor' subledger", () => {
    const out = apInvoiceReceived(event);
    const lines = out.accrual.lines;
    const dr = lines.find((l) => l.account_id === PARTS_ACCT);
    expect(dr.debit).toBe("120.00");
    expect(dr.subledger_type).toBe("part");
    expect(dr.subledger_id).toBe(PART);
    const cr = lines.find((l) => l.account_id === AP);
    expect(cr.credit).toBe("120.00");
    expect(cr.subledger_type).toBe("vendor");
    expect(cr.subledger_id).toBe(VENDOR);
  });

  it("queues a partInventoryLayers entry (not a style inventoryLayers entry)", () => {
    const out = apInvoiceReceived(event);
    expect(out.partInventoryLayers).toHaveLength(1);
    expect(out.partInventoryLayers[0].part_id).toBe(PART);
    expect(out.partInventoryLayers[0].qty).toBe(100);
    expect(out.partInventoryLayers[0].unit_cost_cents).toBe(120);
    expect(out.partInventoryLayers[0].source_kind).toBe("ap_invoice");
    expect(out.inventoryLayers).toBeUndefined();
  });

  it("still produces balanced accrual-only output", () => {
    const out = apInvoiceReceived(event);
    expect(out.cash).toBeNull();
    const debit = out.accrual.lines.reduce((s, l) => s + Number(l.debit), 0);
    const credit = out.accrual.lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(debit).toBeCloseTo(120);
    expect(credit).toBeCloseTo(120);
  });

  it("requires part_inventory_account_id on a part line", () => {
    expect(() => apInvoiceReceived({ entity_id: ENTITY, data: { ...baseData, lines: [{ amount: "1.00", part_id: PART, qty: 1, unit_cost_cents: 100 }] } })).toThrow();
  });

  it("drops part layers on a vendor credit memo", () => {
    const out = apInvoiceReceived({ entity_id: ENTITY, data: { ...baseData, invoice_kind: "vendor_credit_memo", lines: [{ amount: "120.00", part_id: PART, part_inventory_account_id: PARTS_ACCT, qty: 100, unit_cost_cents: 120 }] } });
    expect(out.partInventoryLayers).toBeUndefined();
  });
});
