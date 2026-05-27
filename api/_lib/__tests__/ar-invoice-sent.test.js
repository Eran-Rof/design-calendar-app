// Tests for arInvoiceSent (P4-2; arch §4.1).
//
// Rule produces:
//   Single-amount path (P3 compat): { accrual, cash: null }
//   Multi-line path (P4-2):          { accrual, cash: null, consumePlan?: [...] }
//
// Cash side is always null — AR cash recognition happens at receipt time
// (see arPaymentReceived).
//
// COGS-side sentinel "0" amounts on inventory lines are rewritten by
// postEvent after inventory_fifo_consume() resolves the per-line cogs.

import { describe, it, expect } from "vitest";
import { arInvoiceSent } from "../accounting/posting/rules/arInvoiceSent.js";

const ENTITY = "00000000-0000-0000-0000-000000000001";
const CUSTOMER = "11111111-1111-1111-1111-111111111111";
const INVOICE = "22222222-2222-2222-2222-222222222222";
const AR = "33333333-3333-3333-3333-333333333333";
const REV = "44444444-4444-4444-4444-444444444444";
const COGS = "55555555-5555-5555-5555-555555555555";
const INV_ASSET = "66666666-6666-6666-6666-666666666666";
const ITEM_A = "77777777-7777-7777-7777-777777777777";
const ITEM_B = "88888888-8888-8888-8888-888888888888";
const REV_ALT = "99999999-9999-9999-9999-999999999999";
const LINE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1";
const LINE_B = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2";

function baseEvent(extra = {}) {
  return {
    kind: "ar_invoice_sent",
    entity_id: ENTITY,
    data: {
      invoice_id: INVOICE,
      customer_id: CUSTOMER,
      invoice_number: "AR-2026-00001",
      invoice_date: "2026-05-27",
      ar_account_id: AR,
      revenue_account_id: REV,
      ...extra,
    },
  };
}

describe("arInvoiceSent — single-amount legacy path", () => {
  it("produces accrual-only JE: DR AR / CR revenue", () => {
    const r = arInvoiceSent(baseEvent({ amount: "1000.00" }));
    expect(r.cash).toBeNull();
    expect(r.accrual.lines).toHaveLength(2);
    expect(r.accrual.lines[0].account_id).toBe(AR);
    expect(r.accrual.lines[0].debit).toBe("1000.00");
    expect(r.accrual.lines[0].subledger_type).toBe("customer");
    expect(r.accrual.lines[0].subledger_id).toBe(CUSTOMER);
    expect(r.accrual.lines[1].account_id).toBe(REV);
    expect(r.accrual.lines[1].credit).toBe("1000.00");
  });

  it("uses invoice_date as posting_date and writes journal_type='ar_invoice'", () => {
    const r = arInvoiceSent(baseEvent({ amount: "50.00" }));
    expect(r.accrual.posting_date).toBe("2026-05-27");
    expect(r.accrual.journal_type).toBe("ar_invoice");
    expect(r.accrual.source_module).toBe("ar");
    expect(r.accrual.source_table).toBe("ar_invoices");
    expect(r.accrual.source_id).toBe(INVOICE);
  });

  it("throws on missing required fields", () => {
    expect(() => arInvoiceSent({
      kind: "ar_invoice_sent", entity_id: ENTITY,
      data: { invoice_id: INVOICE, customer_id: CUSTOMER, invoice_number: "X",
              invoice_date: "2026-05-27", ar_account_id: AR },
    })).toThrow(/amount.*required|revenue_account_id.*required/);
  });

  it("does NOT emit consumePlan on legacy path", () => {
    const r = arInvoiceSent(baseEvent({ amount: "10.00" }));
    expect(r.consumePlan).toBeUndefined();
  });
});

describe("arInvoiceSent — multi-line path (no inventory)", () => {
  it("produces DR AR (header) + CR revenue per line, balanced", () => {
    const r = arInvoiceSent(baseEvent({
      lines: [
        { line_index: 1, line_total_cents: 10000, description: "Line 1" },  // $100.00
        { line_index: 2, line_total_cents: 25050, description: "Line 2" },  // $250.50
      ],
    }));
    expect(r.cash).toBeNull();
    expect(r.consumePlan).toBeUndefined();
    expect(r.accrual.lines).toHaveLength(3);
    // Header DR AR
    expect(r.accrual.lines[0].account_id).toBe(AR);
    expect(r.accrual.lines[0].debit).toBe("350.50");
    expect(r.accrual.lines[0].subledger_type).toBe("customer");
    expect(r.accrual.lines[0].subledger_id).toBe(CUSTOMER);
    // CR revenue × 2
    expect(r.accrual.lines[1].account_id).toBe(REV);
    expect(r.accrual.lines[1].credit).toBe("100.00");
    expect(r.accrual.lines[1].memo).toBe("Line 1");
    expect(r.accrual.lines[2].account_id).toBe(REV);
    expect(r.accrual.lines[2].credit).toBe("250.50");
    // Balance
    const sumDr = r.accrual.lines.reduce((acc, l) => acc + parseFloat(l.debit), 0);
    const sumCr = r.accrual.lines.reduce((acc, l) => acc + parseFloat(l.credit), 0);
    expect(sumDr).toBeCloseTo(350.50, 2);
    expect(sumCr).toBeCloseTo(350.50, 2);
  });

  it("per-line revenue_account_id override is honored", () => {
    const r = arInvoiceSent(baseEvent({
      lines: [
        { line_total_cents: 10000 },
        { line_total_cents: 5000, revenue_account_id: REV_ALT },
      ],
    }));
    expect(r.accrual.lines[1].account_id).toBe(REV);
    expect(r.accrual.lines[2].account_id).toBe(REV_ALT);
  });

  it("accepts decimal-string line_total alternative", () => {
    const r = arInvoiceSent(baseEvent({
      lines: [
        { line_total: "100.00" },
        { line_total: "0.50" },
      ],
    }));
    expect(r.accrual.lines[0].debit).toBe("100.50");
    expect(r.accrual.lines[1].credit).toBe("100.00");
    expect(r.accrual.lines[2].credit).toBe("0.50");
  });

  it("throws when a line has neither line_total_cents nor line_total", () => {
    expect(() => arInvoiceSent(baseEvent({
      lines: [{ description: "missing amount" }],
    }))).toThrow(/line_total_cents or line_total/);
  });

  it("throws when line_total is zero or negative", () => {
    expect(() => arInvoiceSent(baseEvent({
      lines: [{ line_total_cents: 0 }],
    }))).toThrow(/must be > 0/);
    expect(() => arInvoiceSent(baseEvent({
      lines: [{ line_total_cents: -100 }],
    }))).toThrow(/must be > 0/);
  });
});

describe("arInvoiceSent — multi-line path with inventory (consumePlan)", () => {
  it("emits sentinel '0' COGS pair + consumePlan for inventory lines", () => {
    const r = arInvoiceSent(baseEvent({
      cogs_account_id: COGS,
      inventory_account_id: INV_ASSET,
      lines: [
        {
          id: LINE_A,
          line_index: 1,
          inventory_item_id: ITEM_A,
          quantity: 5,
          line_total_cents: 50000,  // $500.00 revenue
        },
      ],
    }));

    expect(r.accrual.lines).toHaveLength(4); // AR + revenue + DR cogs + CR inv
    // Revenue lines come first; cogs after
    const cogsDr = r.accrual.lines.find((l) => l.account_id === COGS);
    const invCr = r.accrual.lines.find((l) => l.account_id === INV_ASSET);
    expect(cogsDr.debit).toBe("0");  // sentinel
    expect(cogsDr.credit).toBe("0");
    expect(cogsDr.subledger_type).toBe("item");
    expect(cogsDr.subledger_id).toBe(ITEM_A);
    expect(invCr.credit).toBe("0");
    expect(invCr.debit).toBe("0");
    expect(invCr.subledger_type).toBe("item");
    expect(invCr.subledger_id).toBe(ITEM_A);

    expect(r.consumePlan).toHaveLength(1);
    // Indexed-mode: cogs DR/CR pair sits right after AR header + 1 revenue line,
    // so dr_line_ix=2, cr_line_ix=3 (zero-based into accrual.lines).
    expect(r.consumePlan[0]).toEqual({
      item_id: ITEM_A,
      qty: 5,
      consumer_kind: "ar_invoice",
      consumer_ref_id: LINE_A,
      target_line_id: LINE_A,
      dr_line_ix: 2,
      cr_line_ix: 3,
    });
  });

  it("mixed inventory + service lines: revenue lines for ALL, cogs pair only for inventory", () => {
    const r = arInvoiceSent(baseEvent({
      cogs_account_id: COGS,
      inventory_account_id: INV_ASSET,
      lines: [
        { id: LINE_A, line_index: 1, inventory_item_id: ITEM_A, quantity: 2, line_total_cents: 20000 },
        { id: LINE_B, line_index: 2, description: "Setup fee", line_total_cents: 5000 },
      ],
    }));
    // Lines: AR header + 2 revenue + 2 cogs (one pair) = 5
    expect(r.accrual.lines).toHaveLength(5);
    // Revenue is recognized for both
    const revLines = r.accrual.lines.filter((l) => l.account_id === REV);
    expect(revLines).toHaveLength(2);
    // Cogs pair for the inventory line only
    const cogsLines = r.accrual.lines.filter(
      (l) => l.account_id === COGS || l.account_id === INV_ASSET,
    );
    expect(cogsLines).toHaveLength(2);
    expect(r.consumePlan).toHaveLength(1);
    expect(r.consumePlan[0].item_id).toBe(ITEM_A);
  });

  it("two inventory lines emit two consumePlan entries + two sentinel pairs", () => {
    const r = arInvoiceSent(baseEvent({
      cogs_account_id: COGS,
      inventory_account_id: INV_ASSET,
      lines: [
        { id: LINE_A, inventory_item_id: ITEM_A, quantity: 3, line_total_cents: 30000 },
        { id: LINE_B, inventory_item_id: ITEM_B, quantity: 4, line_total_cents: 40000 },
      ],
    }));
    expect(r.consumePlan).toHaveLength(2);
    expect(r.consumePlan[0].item_id).toBe(ITEM_A);
    expect(r.consumePlan[1].item_id).toBe(ITEM_B);
    // Indexed-mode: 1 header + 2 revenue + cogs pair k=0 at (3,4) + pair k=1 at (5,6).
    expect(r.consumePlan[0].dr_line_ix).toBe(3);
    expect(r.consumePlan[0].cr_line_ix).toBe(4);
    expect(r.consumePlan[1].dr_line_ix).toBe(5);
    expect(r.consumePlan[1].cr_line_ix).toBe(6);
    // Cogs sentinel pairs — 2 lines × 2 pairs = 4
    const sentinelCogsLines = r.accrual.lines.filter(
      (l) => l.subledger_type === "item" && l.debit === "0" && l.credit === "0",
    );
    expect(sentinelCogsLines).toHaveLength(4);
  });

  it("inventory line without quantity throws", () => {
    expect(() => arInvoiceSent(baseEvent({
      cogs_account_id: COGS,
      inventory_account_id: INV_ASSET,
      lines: [{ inventory_item_id: ITEM_A, line_total_cents: 10000 }],
    }))).toThrow(/quantity/);
  });

  it("inventory line without cogs_account_id at payload top-level throws", () => {
    expect(() => arInvoiceSent(baseEvent({
      inventory_account_id: INV_ASSET,
      lines: [{ inventory_item_id: ITEM_A, quantity: 1, line_total_cents: 10000 }],
    }))).toThrow(/cogs_account_id/);
  });

  it("inventory line without inventory_account_id at payload top-level throws", () => {
    expect(() => arInvoiceSent(baseEvent({
      cogs_account_id: COGS,
      lines: [{ inventory_item_id: ITEM_A, quantity: 1, line_total_cents: 10000 }],
    }))).toThrow(/inventory_account_id/);
  });

  it("uses invoice_id as consumer_ref_id fallback when line.id missing", () => {
    const r = arInvoiceSent(baseEvent({
      cogs_account_id: COGS,
      inventory_account_id: INV_ASSET,
      lines: [{ inventory_item_id: ITEM_A, quantity: 1, line_total_cents: 10000 }],
    }));
    expect(r.consumePlan[0].consumer_ref_id).toBe(INVOICE);
    expect(r.consumePlan[0].target_line_id).toBeNull();
    expect(r.consumePlan[0].dr_line_ix).toBe(2);
    expect(r.consumePlan[0].cr_line_ix).toBe(3);
  });
});

describe("arInvoiceSent — JE balance + line numbering", () => {
  it("line_numbers are 1..N", () => {
    const r = arInvoiceSent(baseEvent({
      cogs_account_id: COGS,
      inventory_account_id: INV_ASSET,
      lines: [
        { inventory_item_id: ITEM_A, quantity: 2, line_total_cents: 10000 },
      ],
    }));
    expect(r.accrual.lines.map((l) => l.line_number)).toEqual([1, 2, 3, 4]);
  });

  it("revenue+AR-only balanced even with cogs sentinels at '0'", () => {
    const r = arInvoiceSent(baseEvent({
      cogs_account_id: COGS,
      inventory_account_id: INV_ASSET,
      lines: [
        { inventory_item_id: ITEM_A, quantity: 1, line_total_cents: 12345 },
      ],
    }));
    const sumDr = r.accrual.lines.reduce((acc, l) => acc + parseFloat(l.debit), 0);
    const sumCr = r.accrual.lines.reduce((acc, l) => acc + parseFloat(l.credit), 0);
    // AR debit ($123.45) matches revenue credit ($123.45); COGS pair both "0"
    expect(sumDr).toBeCloseTo(123.45, 2);
    expect(sumCr).toBeCloseTo(123.45, 2);
  });

  it("BigInt cents math: 333 cents × 3 lines = 999 cents = '9.99'", () => {
    const r = arInvoiceSent(baseEvent({
      lines: [
        { line_total_cents: 333 },
        { line_total_cents: 333 },
        { line_total_cents: 333 },
      ],
    }));
    expect(r.accrual.lines[0].debit).toBe("9.99");
  });
});

describe("arInvoiceSent — required-field validation", () => {
  it("missing customer_id throws", () => {
    const e = baseEvent({ amount: "10.00" });
    delete e.data.customer_id;
    expect(() => arInvoiceSent(e)).toThrow(/customer_id/);
  });
  it("missing invoice_date throws", () => {
    const e = baseEvent({ amount: "10.00" });
    delete e.data.invoice_date;
    expect(() => arInvoiceSent(e)).toThrow(/invoice_date/);
  });
  it("missing ar_account_id throws", () => {
    const e = baseEvent({ amount: "10.00" });
    delete e.data.ar_account_id;
    expect(() => arInvoiceSent(e)).toThrow(/ar_account_id/);
  });
});

describe("arInvoiceSent — bypass_period_lock pass-through (P4-8 backfill)", () => {
  it("propagates bypass_period_lock=true onto the accrual candidate", () => {
    const e = baseEvent({
      amount: "100.00",
      journal_type: "ar_invoice_historical",
    });
    e.bypass_period_lock = true;
    const r = arInvoiceSent(e);
    expect(r.accrual.bypass_period_lock).toBe(true);
    expect(r.accrual.journal_type).toBe("ar_invoice_historical");
  });
  it("default bypass_period_lock is false", () => {
    const r = arInvoiceSent(baseEvent({ amount: "100.00" }));
    expect(r.accrual.bypass_period_lock).toBe(false);
  });
});
