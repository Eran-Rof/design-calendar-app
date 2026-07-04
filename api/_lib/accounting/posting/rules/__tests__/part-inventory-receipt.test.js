// Unit tests for partInventoryReceipt — parts received via a native PO into
// part inventory (1360) against GR/IR (2050). Pure function, no DB.

import { describe, it, expect } from "vitest";
import { partInventoryReceipt } from "../partInventoryReceipt.js";

const ENTITY = "11111111-1111-1111-1111-111111111111";
const PARTS_ACCT = "44444444-4444-4444-4444-444444444444"; // 1360
const GRIR = "55555555-5555-5555-5555-555555555555";       // 2050
const PART_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PART_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const VENDOR = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const base = {
  entity_id: ENTITY,
  data: {
    receipt_id: "99999999-9999-9999-9999-999999999999", vendor_id: VENDOR, receipt_date: "2026-07-03",
    part_inventory_account_id: PARTS_ACCT, gr_ir_account_id: GRIR,
    lines: [{ part_id: PART_A, amount: "40.00" }, { part_id: PART_B, amount: "10.00" }],
    goods_amount: "50.00",
  },
};

describe("partInventoryReceipt", () => {
  it("posts DR 1360 per part / CR 2050 goods, balanced, accrual-only", () => {
    const out = partInventoryReceipt(base);
    expect(out.cash).toBeNull();
    const lines = out.accrual.lines;
    expect(lines).toHaveLength(3); // 2 part debits + 1 GR/IR credit
    const dr = lines.reduce((s, l) => s + Number(l.debit), 0);
    const cr = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(dr).toBeCloseTo(50);
    expect(cr).toBeCloseTo(50);
    // part debits carry subledger=part
    expect(lines[0].account_id).toBe(PARTS_ACCT);
    expect(lines[0].subledger_type).toBe("part");
    expect(lines[0].subledger_id).toBe(PART_A);
    expect(Number(lines[0].debit)).toBeCloseTo(40);
    // GR/IR credit carries subledger=vendor
    const grir = lines.find((l) => l.account_id === GRIR);
    expect(grir.subledger_type).toBe("vendor");
    expect(grir.subledger_id).toBe(VENDOR);
    expect(Number(grir.credit)).toBeCloseTo(50);
  });

  it("keys idempotency on the receipt via tanda_po_receipts", () => {
    const out = partInventoryReceipt(base);
    expect(out.accrual.source_table).toBe("tanda_po_receipts");
    expect(out.accrual.source_id).toBe(base.data.receipt_id);
  });

  it("throws when part debits do not sum to goods_amount", () => {
    expect(() => partInventoryReceipt({ entity_id: ENTITY, data: { ...base.data, goods_amount: "49.00" } })).toThrow();
  });

  it("throws on a line missing part_id or amount", () => {
    expect(() => partInventoryReceipt({ entity_id: ENTITY, data: { ...base.data, lines: [{ amount: "50.00" }], goods_amount: "50.00" } })).toThrow();
  });
});
