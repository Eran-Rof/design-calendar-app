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
import { apInvoiceGrirMatch } from "../accounting/posting/rules/apInvoiceGrirMatch.js";
import { landedCostRevaluation } from "../accounting/posting/rules/landedCostRevaluation.js";
import { qcVendorCredit } from "../accounting/posting/rules/qcVendorCredit.js";

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

  it("routes revenue + COGS per line from the line's own accounts (#6 per-style)", () => {
    const r = arInvoiceSent({
      kind: "ar_invoice_sent", entity_id: ENTITY,
      data: {
        invoice_id: "ar-2", customer_id: "c-1",
        invoice_number: "AR-002", invoice_date: "2026-06-26",
        ar_account_id: "ar1",
        revenue_account_id: "revDEFAULT", cogs_account_id: "cogsDEFAULT",
        inventory_account_id: "inv1",
        lines: [
          // line with its own style accounts → must win over the invoice defaults
          { id: "l1", line_index: 1, inventory_item_id: "i1", quantity: 2,
            revenue_account_id: "revROF", cogs_account_id: "cogsROF",
            line_total_cents: 1000 },
          // line with no per-line accounts → falls back to invoice defaults
          { id: "l2", line_index: 2, inventory_item_id: "i2", quantity: 1,
            line_total_cents: 500 },
        ],
      },
    });
    const rev = r.accrual.lines.filter((l) => l.credit !== "0" && l.account_id.startsWith("rev"));
    expect(rev.map((l) => l.account_id)).toEqual(["revROF", "revDEFAULT"]);
    // COGS DR lines (sentinel "0" amounts) carry the per-line vs default account.
    const cogsDr = r.accrual.lines.filter((l) => l.memo && l.memo.startsWith("COGS") && l.subledger_id);
    const cogsAccts = [...new Set(cogsDr.map((l) => l.account_id))];
    expect(cogsAccts).toContain("cogsROF");      // line 1 → its style COGS
    expect(cogsAccts).toContain("cogsDEFAULT");  // line 2 → invoice default
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

  it("multi-line: DR inventory per item / CR GR-IR goods / CR accrued landed", () => {
    const r = inventoryReceipt({
      kind: "inventory_receipt", entity_id: ENTITY,
      data: {
        receipt_id: "rcpt-2", vendor_id: "v-1", receipt_date: "2026-05-21",
        inventory_account_id: "inv1", gr_ir_account_id: "grir1", accrued_landed_account_id: "accr1",
        lines: [{ item_id: "i-1", amount: "60.00" }, { item_id: "i-2", amount: "45.00" }],
        goods_amount: "100.00", accrued_landed_amount: "5.00",
        source_table: "tanda_po_receipts",
      },
    });
    expect(r.cash).toBeNull();
    expect(r.accrual.source_table).toBe("tanda_po_receipts");
    expect(r.accrual.lines).toHaveLength(4); // 2 inventory DR + GR/IR goods CR + accrued landed CR
    expect(r.accrual.lines[0].account_id).toBe("inv1");
    expect(r.accrual.lines[0].debit).toBe("60.00");
    expect(r.accrual.lines[1].debit).toBe("45.00");
    expect(r.accrual.lines[2].account_id).toBe("grir1");
    expect(r.accrual.lines[2].credit).toBe("100.00");
    expect(r.accrual.lines[3].account_id).toBe("accr1");
    expect(r.accrual.lines[3].credit).toBe("5.00");
  });

  it("multi-line: rejects when landed DR != goods + accrued landed", () => {
    expect(() => inventoryReceipt({
      kind: "inventory_receipt", entity_id: ENTITY,
      data: {
        receipt_id: "rcpt-3", vendor_id: "v-1", receipt_date: "2026-05-21",
        inventory_account_id: "inv1", gr_ir_account_id: "grir1",
        lines: [{ item_id: "i-1", amount: "60.00" }],
        goods_amount: "100.00",
      },
    })).toThrow(/landed DR/);
  });
});

describe("apInvoiceGrirMatch", () => {
  const base = {
    invoice_id: "inv-1", vendor_id: "v-1", invoice_number: "VINV-1", invoice_date: "2026-05-21",
    ap_account_id: "ap1", grir_account_id: "grir1", variance_account_id: "var1",
  };
  it("invoice == received: DR GR/IR / CR AP, no variance line", () => {
    const r = apInvoiceGrirMatch({ kind: "ap_invoice_grir_match", entity_id: ENTITY,
      data: { ...base, received_amount: "100.00", total_amount: "100.00" } });
    expect(r.cash).toBeNull();
    expect(r.accrual.lines).toHaveLength(2);
    expect(r.accrual.lines[0].account_id).toBe("grir1");
    expect(r.accrual.lines[0].debit).toBe("100.00");
    expect(r.accrual.lines[1].account_id).toBe("ap1");
    expect(r.accrual.lines[1].credit).toBe("100.00");
    expect(r.accrual.lines[1].subledger_type).toBe("vendor");
  });
  it("invoice > received: DR GR/IR + DR variance / CR AP (balanced)", () => {
    const r = apInvoiceGrirMatch({ kind: "ap_invoice_grir_match", entity_id: ENTITY,
      data: { ...base, received_amount: "100.00", total_amount: "103.00" } });
    expect(r.accrual.lines).toHaveLength(3);
    expect(r.accrual.lines[0].debit).toBe("100.00");   // GR/IR
    expect(r.accrual.lines[1].account_id).toBe("var1"); // variance DR
    expect(r.accrual.lines[1].debit).toBe("3.00");
    expect(r.accrual.lines[2].credit).toBe("103.00");   // AP
  });
  it("invoice < received: DR GR/IR / CR variance + CR AP (balanced)", () => {
    const r = apInvoiceGrirMatch({ kind: "ap_invoice_grir_match", entity_id: ENTITY,
      data: { ...base, received_amount: "100.00", total_amount: "98.00" } });
    expect(r.accrual.lines).toHaveLength(3);
    expect(r.accrual.lines[0].debit).toBe("100.00");   // GR/IR DR
    expect(r.accrual.lines[1].account_id).toBe("var1");
    expect(r.accrual.lines[1].credit).toBe("2.00");    // variance CR
    expect(r.accrual.lines[2].credit).toBe("98.00");   // AP
    // DR 100 == CR (2 + 98)
  });
  it("requires variance_account_id when there is a variance", () => {
    expect(() => apInvoiceGrirMatch({ kind: "ap_invoice_grir_match", entity_id: ENTITY,
      data: { ...base, variance_account_id: undefined, received_amount: "100.00", total_amount: "103.00" } }))
      .toThrow(/variance_account_id/);
  });
});

describe("landedCostRevaluation", () => {
  const base = {
    invoice_id: "binv-1", vendor_id: "broker-1", invoice_number: "BRK-1", invoice_date: "2026-05-25",
    ap_account_id: "ap1", inventory_account_id: "inv1", variance_account_id: "lcv1",
  };
  it("all in stock: DR inventory per item / CR AP, no variance line", () => {
    const r = landedCostRevaluation({ kind: "landed_cost_revaluation", entity_id: ENTITY,
      data: { ...base, inventory_lines: [{ item_id: "i-1", amount: "30.00" }, { item_id: "i-2", amount: "20.00" }],
        consumed_variance_amount: "0.00", total_amount: "50.00" } });
    expect(r.cash).toBeNull();
    expect(r.accrual.lines).toHaveLength(3);
    expect(r.accrual.lines[0].account_id).toBe("inv1");
    expect(r.accrual.lines[0].subledger_type).toBe("item");
    expect(r.accrual.lines[2].account_id).toBe("ap1");
    expect(r.accrual.lines[2].credit).toBe("50.00");
  });
  it("partly sold: DR inventory + DR 5150 variance / CR AP (balanced)", () => {
    const r = landedCostRevaluation({ kind: "landed_cost_revaluation", entity_id: ENTITY,
      data: { ...base, inventory_lines: [{ item_id: "i-1", amount: "30.00" }],
        consumed_variance_amount: "20.00", total_amount: "50.00" } });
    expect(r.accrual.lines).toHaveLength(3);
    expect(r.accrual.lines[0].debit).toBe("30.00");   // inventory uplift
    expect(r.accrual.lines[1].account_id).toBe("lcv1");
    expect(r.accrual.lines[1].debit).toBe("20.00");   // consumed variance
    expect(r.accrual.lines[2].credit).toBe("50.00");  // AP
  });
  it("rejects when uplift + consumed != total", () => {
    expect(() => landedCostRevaluation({ kind: "landed_cost_revaluation", entity_id: ENTITY,
      data: { ...base, inventory_lines: [{ item_id: "i-1", amount: "30.00" }],
        consumed_variance_amount: "10.00", total_amount: "50.00" } })).toThrow(/!= broker total/);
  });
});

describe("qcVendorCredit", () => {
  it("DR AP (vendor) / CR Inventory (item) at the credit amount", () => {
    const r = qcVendorCredit({ kind: "qc_vendor_credit", entity_id: ENTITY,
      data: { invoice_id: "ci-1", vendor_id: "v-1", item_id: "i-1", amount: "42.00",
        ap_account_id: "ap1", inventory_account_id: "inv1", posting_date: "2026-05-25" } });
    expect(r.cash).toBeNull();
    expect(r.accrual.journal_type).toBe("ap_credit_memo");
    expect(r.accrual.lines).toHaveLength(2);
    expect(r.accrual.lines[0].account_id).toBe("ap1");
    expect(r.accrual.lines[0].debit).toBe("42.00");
    expect(r.accrual.lines[0].subledger_type).toBe("vendor");
    expect(r.accrual.lines[1].account_id).toBe("inv1");
    expect(r.accrual.lines[1].credit).toBe("42.00");
    expect(r.accrual.lines[1].subledger_type).toBe("item");
  });
  it("rejects a non-positive amount", () => {
    expect(() => qcVendorCredit({ kind: "qc_vendor_credit", entity_id: ENTITY,
      data: { invoice_id: "ci-1", vendor_id: "v-1", item_id: "i-1", amount: "0.00",
        ap_account_id: "ap1", inventory_account_id: "inv1", posting_date: "2026-05-25" } })).toThrow(/amount must be/);
  });
});

describe("inventoryAdjustment", () => {
  // P3-5 (2026-05-27) reworked the rule from a `direction: up|down` + `amount`
  // contract to a signed `qty_delta` + `adjustment_type` contract that does
  // its own cents math + emits side-effect descriptors (inventoryLayers for
  // positive, consumePlan for negative). See inventory-adjustment-rule.test.js
  // for the full surface coverage; the legacy assertions below were rewritten
  // to match the new shape.
  it("positive qty_delta: DR inventory / CR counter, both bases", () => {
    const r = inventoryAdjustment({
      kind: "inventory_adjustment", entity_id: ENTITY,
      data: {
        adjustment_id: "adj-1", item_id: "i-1",
        posting_date: "2026-05-21",
        adjustment_type: "found", qty_delta: 5, unit_cost_cents: 500,
        inventory_account_id: "inv1", gl_account_id: "adj1",
      },
    });
    expect(r.accrual.lines[0].account_id).toBe("inv1");
    expect(r.accrual.lines[0].subledger_type).toBe("item");
    // Line content equal across bases (independent arrays)
    expect(r.cash.lines[0].account_id).toBe(r.accrual.lines[0].account_id);
    expect(r.cash.lines[0].debit).toBe(r.accrual.lines[0].debit);
    expect(r.inventoryLayers).toHaveLength(1);
  });

  it("negative qty_delta: DR counter / CR inventory + consumePlan", () => {
    const r = inventoryAdjustment({
      kind: "inventory_adjustment", entity_id: ENTITY,
      data: {
        adjustment_id: "adj-2", item_id: "i-1",
        posting_date: "2026-05-21",
        adjustment_type: "damage", qty_delta: -5, unit_cost_cents: null,
        inventory_account_id: "inv1", gl_account_id: "adj1",
      },
    });
    expect(r.accrual.lines[0].account_id).toBe("adj1");
    expect(r.accrual.lines[1].account_id).toBe("inv1");
    expect(r.accrual.lines[1].subledger_type).toBe("item");
    // Sentinel "0" amounts; rewritten by postEvent.
    expect(r.accrual.lines[0].debit).toBe("0");
    expect(r.accrual.lines[1].credit).toBe("0");
    expect(r.consumePlan).toHaveLength(1);
  });

  it("rejects invalid adjustment_type", () => {
    expect(() => inventoryAdjustment({
      kind: "inventory_adjustment", entity_id: ENTITY,
      data: {
        adjustment_id: "adj-3", item_id: "i-1",
        posting_date: "2026-05-21",
        adjustment_type: "sideways", qty_delta: -1,
        inventory_account_id: "inv1", gl_account_id: "adj1",
      },
    })).toThrow(/adjustment_type/);
  });
});
