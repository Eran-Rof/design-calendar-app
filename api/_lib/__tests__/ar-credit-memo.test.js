// Tests for arCreditMemo (P4-2; arch §4.4).
//
// Credit memos are inverse-of-arInvoiceSent:
//   - CR ar_account (reduces customer balance)
//   - DR revenue per line (reverses recognized revenue)
//   - For inventory-return lines: DR inventory_asset / CR cogs + emit
//     inventoryLayers[] entry with source_kind='credit_memo_return'.

import { describe, it, expect } from "vitest";
import { arCreditMemo } from "../accounting/posting/rules/arCreditMemo.js";

const ENTITY = "00000000-0000-0000-0000-000000000001";
const CUSTOMER = "11111111-1111-1111-1111-111111111111";
const CM = "22222222-2222-2222-2222-222222222222";          // credit memo (ar_invoices.id)
const ORIG_INV = "33333333-3333-3333-3333-333333333333";    // original invoice (optional)
const AR = "44444444-4444-4444-4444-444444444444";
const REV = "55555555-5555-5555-5555-555555555555";
const COGS = "66666666-6666-6666-6666-666666666666";
const INV_ASSET = "77777777-7777-7777-7777-777777777777";
const ITEM_A = "88888888-8888-8888-8888-888888888888";
const ITEM_B = "99999999-9999-9999-9999-999999999999";

function baseEvent(extra = {}) {
  return {
    kind: "ar_credit_memo",
    entity_id: ENTITY,
    data: {
      credit_memo_id: CM,
      customer_id: CUSTOMER,
      credit_memo_number: "CM-2026-00001",
      posting_date: "2026-05-27",
      ar_account_id: AR,
      revenue_account_id: REV,
      ...extra,
    },
  };
}

describe("arCreditMemo — pure service credit (no inventory return)", () => {
  it("emits CR AR header + per-line DR revenue, accrual-only", () => {
    const r = arCreditMemo(baseEvent({
      lines: [
        { line_total_cents: 5000, description: "Service credit" },
      ],
    }));
    expect(r.cash).toBeNull();
    expect(r.inventoryLayers).toBeUndefined();
    expect(r.accrual.lines).toHaveLength(2);
    // Header CR AR
    expect(r.accrual.lines[0].account_id).toBe(AR);
    expect(r.accrual.lines[0].credit).toBe("50.00");
    expect(r.accrual.lines[0].debit).toBe("0");
    expect(r.accrual.lines[0].subledger_type).toBe("customer");
    // DR revenue
    expect(r.accrual.lines[1].account_id).toBe(REV);
    expect(r.accrual.lines[1].debit).toBe("50.00");
  });

  it("multi-line pure-service credit is balanced", () => {
    const r = arCreditMemo(baseEvent({
      lines: [
        { line_total_cents: 10000 },
        { line_total_cents: 25000 },
      ],
    }));
    const sumDr = r.accrual.lines.reduce((a, l) => a + parseFloat(l.debit), 0);
    const sumCr = r.accrual.lines.reduce((a, l) => a + parseFloat(l.credit), 0);
    expect(sumDr).toBeCloseTo(350.00, 2);
    expect(sumCr).toBeCloseTo(350.00, 2);
  });

  it("uses 'ar_credit_memo' as journal_type", () => {
    const r = arCreditMemo(baseEvent({
      lines: [{ line_total_cents: 1000 }],
    }));
    expect(r.accrual.journal_type).toBe("ar_credit_memo");
    expect(r.accrual.source_table).toBe("ar_invoices");
    expect(r.accrual.source_id).toBe(CM);
  });

  it("description references original_invoice_id when provided", () => {
    const r = arCreditMemo(baseEvent({
      original_invoice_id: ORIG_INV,
      lines: [{ line_total_cents: 1000 }],
    }));
    expect(r.accrual.description).toContain(ORIG_INV);
    expect(r.accrual.description).toContain("CM-2026-00001");
  });

  it("standalone credit (no original_invoice_id) is allowed", () => {
    const r = arCreditMemo(baseEvent({
      lines: [{ line_total_cents: 1000 }],
    }));
    expect(r.accrual.description).toContain("CM-2026-00001");
    expect(r.accrual.description).not.toContain("vs invoice");
  });
});

describe("arCreditMemo — inventory return", () => {
  it("emits DR inv / CR cogs pair + inventoryLayers entry for return line", () => {
    const r = arCreditMemo(baseEvent({
      cogs_account_id: COGS,
      inventory_account_id: INV_ASSET,
      lines: [
        {
          line_index: 1,
          inventory_item_id: ITEM_A,
          quantity: 2,
          return_unit_cost_cents: 1500,  // $15/unit → $30 return cost
          line_total_cents: 5000,        // $50 revenue credit
        },
      ],
    }));
    // Lines: AR-cr header + revenue-dr + inv-dr + cogs-cr = 4
    expect(r.accrual.lines).toHaveLength(4);
    const invDr = r.accrual.lines.find((l) => l.account_id === INV_ASSET);
    const cogsCr = r.accrual.lines.find((l) => l.account_id === COGS);
    expect(invDr.debit).toBe("30.00");
    expect(invDr.subledger_type).toBe("item");
    expect(invDr.subledger_id).toBe(ITEM_A);
    expect(cogsCr.credit).toBe("30.00");
    expect(cogsCr.subledger_type).toBe("item");
    expect(cogsCr.subledger_id).toBe(ITEM_A);

    expect(r.inventoryLayers).toHaveLength(1);
    expect(r.inventoryLayers[0]).toMatchObject({
      item_id: ITEM_A,
      qty: 2,
      unit_cost_cents: 1500,
      source_kind: "credit_memo_return",
      source_credit_memo_id: CM,
      received_at: "2026-05-27",
    });
  });

  it("inventory return line WITHOUT return_unit_cost_cents throws (handler must resolve)", () => {
    expect(() => arCreditMemo(baseEvent({
      cogs_account_id: COGS,
      inventory_account_id: INV_ASSET,
      lines: [
        { inventory_item_id: ITEM_A, quantity: 1, line_total_cents: 1000 },
      ],
    }))).toThrow(/return_unit_cost_cents/);
  });

  it("inventory return without cogs_account_id at payload top-level throws", () => {
    expect(() => arCreditMemo(baseEvent({
      inventory_account_id: INV_ASSET,
      lines: [
        { inventory_item_id: ITEM_A, quantity: 1, return_unit_cost_cents: 100, line_total_cents: 1000 },
      ],
    }))).toThrow(/cogs_account_id/);
  });

  it("inventory return without inventory_account_id at payload top-level throws", () => {
    expect(() => arCreditMemo(baseEvent({
      cogs_account_id: COGS,
      lines: [
        { inventory_item_id: ITEM_A, quantity: 1, return_unit_cost_cents: 100, line_total_cents: 1000 },
      ],
    }))).toThrow(/inventory_account_id/);
  });

  it("inventory return without quantity throws", () => {
    expect(() => arCreditMemo(baseEvent({
      cogs_account_id: COGS,
      inventory_account_id: INV_ASSET,
      lines: [
        { inventory_item_id: ITEM_A, return_unit_cost_cents: 100, line_total_cents: 1000 },
      ],
    }))).toThrow(/quantity/);
  });

  it("mixed service + inventory-return lines: only inventory lines emit layers", () => {
    const r = arCreditMemo(baseEvent({
      cogs_account_id: COGS,
      inventory_account_id: INV_ASSET,
      lines: [
        { description: "service refund", line_total_cents: 2500 },
        { inventory_item_id: ITEM_A, quantity: 1, return_unit_cost_cents: 500, line_total_cents: 1500 },
        { inventory_item_id: ITEM_B, quantity: 3, return_unit_cost_cents: 800, line_total_cents: 5000 },
      ],
    }));
    expect(r.inventoryLayers).toHaveLength(2);
    expect(r.inventoryLayers[0].item_id).toBe(ITEM_A);
    expect(r.inventoryLayers[1].item_id).toBe(ITEM_B);
    // Cogs+inv DR/CR pair per inventory line = 4 lines
    const itemLines = r.accrual.lines.filter((l) => l.subledger_type === "item");
    expect(itemLines).toHaveLength(4);
  });

  it("BigInt cents math: 333 cents × 3 qty = 999 cents = '9.99'", () => {
    const r = arCreditMemo(baseEvent({
      cogs_account_id: COGS,
      inventory_account_id: INV_ASSET,
      lines: [
        { inventory_item_id: ITEM_A, quantity: 3, return_unit_cost_cents: 333, line_total_cents: 1000 },
      ],
    }));
    const invDr = r.accrual.lines.find((l) => l.account_id === INV_ASSET);
    expect(invDr.debit).toBe("9.99");
  });
});

describe("arCreditMemo — partial vs full credit", () => {
  it("partial credit (smaller line_total than original) just reduces AR by that amount", () => {
    // Credit only $20 of an original $100 invoice
    const r = arCreditMemo(baseEvent({
      original_invoice_id: ORIG_INV,
      lines: [{ line_total_cents: 2000 }],
    }));
    expect(r.accrual.lines[0].credit).toBe("20.00");   // AR CR
    expect(r.accrual.lines[1].debit).toBe("20.00");    // revenue DR
  });

  it("full credit (equal to original invoice) is just a larger line_total", () => {
    const r = arCreditMemo(baseEvent({
      original_invoice_id: ORIG_INV,
      lines: [{ line_total_cents: 100000 }],
    }));
    expect(r.accrual.lines[0].credit).toBe("1000.00");
  });
});

describe("arCreditMemo — validation", () => {
  it("missing lines array throws", () => {
    expect(() => arCreditMemo(baseEvent({}))).toThrow(/lines/);
  });

  it("empty lines array throws", () => {
    expect(() => arCreditMemo(baseEvent({ lines: [] }))).toThrow(/lines/);
  });

  it("line with zero line_total_cents throws", () => {
    expect(() => arCreditMemo(baseEvent({
      lines: [{ line_total_cents: 0 }],
    }))).toThrow(/must be > 0/);
  });

  it("line with negative line_total_cents throws", () => {
    expect(() => arCreditMemo(baseEvent({
      lines: [{ line_total_cents: -100 }],
    }))).toThrow(/must be > 0/);
  });

  it("missing required field credit_memo_number throws", () => {
    const e = baseEvent({ lines: [{ line_total_cents: 1000 }] });
    delete e.data.credit_memo_number;
    expect(() => arCreditMemo(e)).toThrow(/credit_memo_number/);
  });

  it("missing posting_date throws", () => {
    const e = baseEvent({ lines: [{ line_total_cents: 1000 }] });
    delete e.data.posting_date;
    expect(() => arCreditMemo(e)).toThrow(/posting_date/);
  });

  it("missing ar_account_id throws", () => {
    const e = baseEvent({ lines: [{ line_total_cents: 1000 }] });
    delete e.data.ar_account_id;
    expect(() => arCreditMemo(e)).toThrow(/ar_account_id/);
  });
});

describe("arCreditMemo — bypass_period_lock", () => {
  it("propagates bypass_period_lock onto the accrual candidate", () => {
    const e = baseEvent({
      journal_type: "ar_invoice_historical",
      lines: [{ line_total_cents: 1000 }],
    });
    e.bypass_period_lock = true;
    const r = arCreditMemo(e);
    expect(r.accrual.bypass_period_lock).toBe(true);
  });
});

describe("arCreditMemo — JE shape", () => {
  it("line_numbers are 1..N", () => {
    const r = arCreditMemo(baseEvent({
      cogs_account_id: COGS,
      inventory_account_id: INV_ASSET,
      lines: [
        { inventory_item_id: ITEM_A, quantity: 1, return_unit_cost_cents: 500, line_total_cents: 1000 },
      ],
    }));
    expect(r.accrual.lines.map((l) => l.line_number)).toEqual([1, 2, 3, 4]);
  });

  it("per-line revenue_account_id override is honored", () => {
    const REV_ALT = "abcdef00-0000-0000-0000-000000000000";
    const r = arCreditMemo(baseEvent({
      lines: [
        { line_total_cents: 1000 },
        { line_total_cents: 2000, revenue_account_id: REV_ALT },
      ],
    }));
    expect(r.accrual.lines[1].account_id).toBe(REV);
    expect(r.accrual.lines[2].account_id).toBe(REV_ALT);
  });
});
