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
    for (const input of [[], null]) {
      const r = splitBillLineCents(input);
      expect(r.goods_cents).toBe(0n);
      expect(r.other_cents).toBe(0n);
      expect(r.other_by_account.size).toBe(0);
    }
  });
  it("buckets non-goods cents by resolved Xoro expense account (#xoro-account-truth)", () => {
    const { other_cents, other_by_account } = splitBillLineCents([
      { inventory_item_id: null, quantity: 1, unit_cost_cents: 2500, expense_account_id: "acct-freight" },
      { inventory_item_id: null, quantity: 1, unit_cost_cents: 1000, expense_account_id: "acct-freight" },
      { inventory_item_id: null, quantity: 1, unit_cost_cents: 700 }, // unresolved
    ]);
    expect(other_cents).toBe(4200n);
    expect(other_by_account.get("acct-freight")).toBe(3500n);
    expect(other_by_account.get(null)).toBe(700n);
  });
  it("drops non-allowlisted account ids into the null bucket", () => {
    const { other_by_account } = splitBillLineCents(
      [{ inventory_item_id: null, quantity: 1, unit_cost_cents: 100, expense_account_id: "acct-bogus" }],
      new Set(["acct-freight"]),
    );
    expect(other_by_account.get(null)).toBe(100n);
    expect(other_by_account.has("acct-bogus")).toBe(false);
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

  it("routes the non-item/plug line to the vendor's default expense account when present", () => {
    const je = composeApBillJe({
      entity_id: "ent", bill: BILL, goods_cents: 100_00n, other_cents: 5_00n,
      accounts: { ...ACCTS, vendorExpense: "acct-vend-exp" },
    });
    const vend = je.lines.find((l) => l.account_id === "acct-vend-exp");
    expect(vend.debit).toBe("10.00"); // other 5.00 + plug 5.00
    expect(je.lines.some((l) => l.account_id === "acct-exp")).toBe(false);
    const dr = je.lines.reduce((s, l) => s + Number(l.debit), 0);
    const cr = je.lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(dr).toBeCloseTo(cr, 2);
  });

  it("falls back to 8007 (fallbackExpense) when the vendor has no default expense account", () => {
    for (const vendorExpense of [null, undefined]) {
      const je = composeApBillJe({
        entity_id: "ent", bill: BILL, goods_cents: 100_00n, other_cents: 5_00n,
        accounts: { ...ACCTS, vendorExpense },
      });
      const exp = je.lines.find((l) => l.account_id === "acct-exp");
      expect(exp.debit).toBe("10.00");
    }
  });

  it("prefers the bill line's own Xoro account over the vendor default (#xoro-account-truth)", () => {
    const je = composeApBillJe({
      entity_id: "ent", bill: BILL, goods_cents: 100_00n, other_cents: 5_00n,
      other_by_account: new Map([["acct-freight", 3_00n], [null, 2_00n]]),
      accounts: { ...ACCTS, vendorExpense: "acct-vend-exp" },
    });
    const freight = je.lines.find((l) => l.account_id === "acct-freight");
    const vend = je.lines.find((l) => l.account_id === "acct-vend-exp");
    expect(freight.debit).toBe("3.00");             // Xoro-classified line
    expect(vend.debit).toBe("7.00");                // unresolved 2.00 + plug 5.00
    expect(je.lines.some((l) => l.account_id === "acct-exp")).toBe(false);
    const dr = je.lines.reduce((s, l) => s + Number(l.debit), 0);
    const cr = je.lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(dr).toBeCloseTo(cr, 2);                  // still balances to the bill total
  });

  it("routes everything Xoro classifies even when the whole non-goods slice resolves", () => {
    const je = composeApBillJe({
      entity_id: "ent", bill: { ...BILL, total_amount_cents: 105_00 },
      goods_cents: 100_00n, other_cents: 5_00n,
      other_by_account: new Map([["acct-freight", 5_00n]]),
      accounts: ACCTS, // no vendor default
    });
    const freight = je.lines.find((l) => l.account_id === "acct-freight");
    expect(freight.debit).toBe("5.00");
    // no plug, no unresolved cents -> no 8007 line at all
    expect(je.lines.some((l) => l.account_id === "acct-exp")).toBe(false);
  });
});
