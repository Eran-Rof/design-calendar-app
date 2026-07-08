import { describe, it, expect } from "vitest";
import { splitBillLineCents, composeApBillJe } from "../apBillPosting.js";

const ACCTS = { inventory: "acct-inv", fallbackExpense: "acct-exp", ap: "acct-ap" };
const BILL = {
  id: "bill-1", invoice_number: "B-100", vendor_id: "vend-1",
  invoice_date: "2026-05-01", posting_date: null, total_amount_cents: 110_00,
};

describe("splitBillLineCents", () => {
  it("splits item-linked vs other lines", () => {
    const { goods_cents, other_cents } = splitBillLineCents([
      { inventory_item_id: "sku1", quantity: 10, unit_cost_cents: 500 },
      { inventory_item_id: null, quantity: 1, unit_cost_cents: 2500 },
    ]);
    expect(goods_cents).toBe(5000n);
    expect(other_cents).toBe(2500n);
  });
  it("handles empty/missing lines", () => {
    expect(splitBillLineCents([])).toEqual({ goods_cents: 0n, other_cents: 0n });
    expect(splitBillLineCents(null)).toEqual({ goods_cents: 0n, other_cents: 0n });
  });
});

describe("composeApBillJe", () => {
  it("posts DR inventory + DR expense-plug / CR AP with vendor subledger", () => {
    const je = composeApBillJe({
      entity_id: "ent", bill: BILL, goods_cents: 100_00n, other_cents: 5_00n, accounts: ACCTS,
    });
    // total 110.00 = goods 100.00 + other 5.00 + plug 5.00 (tax/rounding)
    expect(je.journal_type).toBe("ap_invoice_historical");
    expect(je.posting_date).toBe("2026-05-01");
    const inv = je.lines.find((l) => l.account_id === "acct-inv");
    const exp = je.lines.find((l) => l.account_id === "acct-exp");
    const ap = je.lines.find((l) => l.account_id === "acct-ap");
    expect(inv.debit).toBe("100.00");
    expect(exp.debit).toBe("10.00");
    expect(ap.credit).toBe("110.00");
    expect(ap.subledger_type).toBe("vendor");
    expect(ap.subledger_id).toBe("vend-1");
    const dr = je.lines.reduce((s, l) => s + Number(l.debit), 0);
    const cr = je.lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(dr).toBeCloseTo(cr, 2);
  });

  it("flips directions for a credit memo (negative total)", () => {
    const je = composeApBillJe({
      entity_id: "ent",
      bill: { ...BILL, total_amount_cents: -50_00 },
      goods_cents: -50_00n, other_cents: 0n, accounts: ACCTS,
    });
    const inv = je.lines.find((l) => l.account_id === "acct-inv");
    const ap = je.lines.find((l) => l.account_id === "acct-ap");
    expect(inv.credit).toBe("50.00");
    expect(ap.debit).toBe("50.00");
  });

  it("skips zero-total bills and vendor-less bills", () => {
    expect(composeApBillJe({ entity_id: "e", bill: { ...BILL, total_amount_cents: 0 }, goods_cents: 0n, other_cents: 0n, accounts: ACCTS })).toBeNull();
    expect(composeApBillJe({ entity_id: "e", bill: { ...BILL, vendor_id: null }, goods_cents: 0n, other_cents: 0n, accounts: ACCTS })).toBeNull();
  });

  it("omits zero lines (pure-goods bill has no expense line)", () => {
    const je = composeApBillJe({
      entity_id: "ent",
      bill: { ...BILL, total_amount_cents: 100_00 },
      goods_cents: 100_00n, other_cents: 0n, accounts: ACCTS,
    });
    expect(je.lines).toHaveLength(2);
    expect(je.lines.some((l) => l.account_id === "acct-exp")).toBe(false);
  });
});
