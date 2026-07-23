// api/_lib/__tests__/betaData.test.js
//
// Beta guardrails — Chunk C: unit tests for the pure eligibility/verdict
// functions of the cleanup engine (mock rows; no DB).

import { describe, it, expect } from "vitest";
import {
  isPostedGlStatus, isProtectedTable, PROTECTED_TABLES,
  assessArInvoice, assessApInvoice, assessJournalEntry, assessArReceipt,
  assessInvoicePayment, assessSalesOrder, assessPurchaseOrder, assessGeneric,
  assessDoc, TABLE_RULES, fkRefusalReason, chunk,
} from "../betaData.js";

describe("isPostedGlStatus", () => {
  it("treats 'unposted' (the default, which CONTAINS 'post') as NOT posted", () => {
    expect(isPostedGlStatus("unposted")).toBe(false);
    expect(isPostedGlStatus("UNPOSTED")).toBe(false);
  });
  it("flags posted variants", () => {
    expect(isPostedGlStatus("posted")).toBe(true);
    expect(isPostedGlStatus("POSTED")).toBe(true);
    expect(isPostedGlStatus("post_pending")).toBe(true);
  });
  it("passes non-posting statuses and blanks", () => {
    expect(isPostedGlStatus("pending_approval")).toBe(false);
    expect(isPostedGlStatus("draft")).toBe(false);
    expect(isPostedGlStatus(null)).toBe(false);
    expect(isPostedGlStatus("")).toBe(false);
  });
});

describe("assessArInvoice", () => {
  const clean = { accrual_je_id: null, cash_je_id: null, gl_status: "unposted", paid_amount_cents: 0 };
  it("deletable when unposted and unpaid", () => {
    expect(assessArInvoice(clean)).toEqual({ verdict: "deletable" });
  });
  it("refuses when accrual JE linked", () => {
    const v = assessArInvoice({ ...clean, accrual_je_id: "je-1" });
    expect(v.verdict).toBe("refused");
    expect(v.reason).toBe("posted — reverse instead");
  });
  it("refuses when cash JE linked", () => {
    expect(assessArInvoice({ ...clean, cash_je_id: "je-2" }).verdict).toBe("refused");
  });
  it("refuses when gl_status says posted", () => {
    expect(assessArInvoice({ ...clean, gl_status: "posted" }).reason).toBe("posted — reverse instead");
  });
  it("refuses when any cash applied", () => {
    expect(assessArInvoice({ ...clean, paid_amount_cents: 100 }).reason).toBe("has payments");
  });
});

describe("assessApInvoice (AP bills — `invoices`)", () => {
  const clean = { accrual_je_id: null, cash_je_id: null, gl_status: "unposted", paid_amount_cents: 0 };
  it("deletable when unposted, unpaid, no payment rows", () => {
    expect(assessApInvoice(clean, { paymentCount: 0 })).toEqual({ verdict: "deletable" });
  });
  it("refuses on JE linkage", () => {
    expect(assessApInvoice({ ...clean, accrual_je_id: "je" }).reason).toBe("posted — reverse instead");
  });
  it("refuses when invoice_payments rows exist even at 0 paid cents", () => {
    expect(assessApInvoice(clean, { paymentCount: 2 }).reason).toBe("has payments");
  });
  it("refuses when paid_amount_cents > 0", () => {
    expect(assessApInvoice({ ...clean, paid_amount_cents: 5 }, {}).reason).toBe("has payments");
  });
});

describe("assessJournalEntry", () => {
  it("only draft is deletable", () => {
    expect(assessJournalEntry({ status: "draft" })).toEqual({ verdict: "deletable" });
  });
  it("posted and reversed refuse with the reverse-instead reason", () => {
    expect(assessJournalEntry({ status: "posted" }).reason).toBe("posted — reverse instead");
    expect(assessJournalEntry({ status: "reversed" }).verdict).toBe("refused");
  });
  it("missing status refuses (fail closed)", () => {
    expect(assessJournalEntry({}).verdict).toBe("refused");
  });
});

describe("assessArReceipt", () => {
  const clean = { accrual_je_id: null, cash_je_id: null };
  it("deletable when unposted and unapplied", () => {
    expect(assessArReceipt(clean, { applicationCount: 0 })).toEqual({ verdict: "deletable" });
  });
  it("refuses when JE-linked", () => {
    expect(assessArReceipt({ ...clean, accrual_je_id: "je" }).reason).toBe("posted — reverse instead");
  });
  it("refuses when applied to invoices", () => {
    expect(assessArReceipt(clean, { applicationCount: 1 }).reason).toBe("applied to invoices — unapply first");
  });
});

describe("assessInvoicePayment", () => {
  it("deletable without cash JE; refuses with one", () => {
    expect(assessInvoicePayment({ cash_je_id: null })).toEqual({ verdict: "deletable" });
    expect(assessInvoicePayment({ cash_je_id: "je" }).reason).toBe("posted — reverse instead");
  });
});

describe("assessSalesOrder", () => {
  it("deletable with no downstream activity", () => {
    expect(assessSalesOrder({}, { shipmentCount: 0, allocatedQty: 0, shippedQty: 0, invoicedQty: 0 }))
      .toEqual({ verdict: "deletable" });
  });
  it("refuses on shipments / allocation / shipped / invoiced qty", () => {
    expect(assessSalesOrder({}, { shipmentCount: 1 }).reason).toBe("has shipments/allocations");
    expect(assessSalesOrder({}, { allocatedQty: 12 }).verdict).toBe("refused");
    expect(assessSalesOrder({}, { shippedQty: 3 }).verdict).toBe("refused");
    expect(assessSalesOrder({}, { invoicedQty: 3 }).verdict).toBe("refused");
  });
});

describe("assessPurchaseOrder", () => {
  it("deletable when nothing received", () => {
    expect(assessPurchaseOrder({}, { receivedQty: 0 })).toEqual({ verdict: "deletable" });
  });
  it("refuses when any line qty_received > 0", () => {
    expect(assessPurchaseOrder({}, { receivedQty: 4 }).reason).toBe("has receipts");
  });
});

describe("assessGeneric", () => {
  it("plain master row is deletable (FK violations refuse at delete time)", () => {
    expect(assessGeneric({ id: "x", name: "ZZ-BETA CUSTOMER" })).toEqual({ verdict: "deletable" });
  });
  it("refuses when a posted-JE linkage column is set (e.g. inventory_adjustments.posted_je_id)", () => {
    expect(assessGeneric({ posted_je_id: "je" }).reason).toBe("posted — reverse instead");
    expect(assessGeneric({ accrual_je_id: "je" }).verdict).toBe("refused");
    expect(assessGeneric({ cash_je_id: "je" }).verdict).toBe("refused");
  });
  it("refuses on a posted gl_status", () => {
    expect(assessGeneric({ gl_status: "posted" }).verdict).toBe("refused");
    expect(assessGeneric({ gl_status: "unposted" }).verdict).toBe("deletable");
  });
});

describe("assessDoc dispatcher", () => {
  it("missing doc → already_gone", () => {
    expect(assessDoc("customers", null)).toEqual({ verdict: "already_gone" });
  });
  it("protected tables always refuse — even when the row is missing", () => {
    expect(assessDoc("journal_entry_lines", null).reason)
      .toBe("protected table — never cleaned by the beta engine");
    expect(assessDoc("xoro_gl_mirror", { id: "x" }).verdict).toBe("refused");
    expect(assessDoc("gl_accounts", { id: "x" }).verdict).toBe("refused");
    expect(assessDoc("inventory_ledger", { id: "x" }).verdict).toBe("refused");
    expect(assessDoc("beta_created_docs", { id: 1 }).verdict).toBe("refused");
  });
  it("routes known tables to their specific rules", () => {
    expect(assessDoc("ar_invoices", { accrual_je_id: "je" }).reason).toBe("posted — reverse instead");
    expect(assessDoc("journal_entries", { status: "posted" }).verdict).toBe("refused");
    expect(assessDoc("purchase_orders", {}, { receivedQty: 1 }).reason).toBe("has receipts");
  });
  it("unknown tables fall through to the generic rule", () => {
    expect(assessDoc("some_future_table", { id: "x" })).toEqual({ verdict: "deletable" });
  });
});

describe("protected-table matcher", () => {
  it("covers the explicit denylist", () => {
    for (const t of PROTECTED_TABLES) expect(isProtectedTable(t)).toBe(true);
  });
  it("covers gl_* and *_ledger by prefix/suffix", () => {
    expect(isProtectedTable("gl_anything_new")).toBe(true);
    expect(isProtectedTable("future_inv_ledger")).toBe(true);
    expect(isProtectedTable("customers")).toBe(false);
    expect(isProtectedTable("sales_orders")).toBe(false);
  });
});

describe("TABLE_RULES delete plan", () => {
  it("maps each doc table to its OWN lines table only", () => {
    expect(TABLE_RULES.ar_invoices).toEqual({ lineTable: "ar_invoice_lines", lineFk: "ar_invoice_id" });
    expect(TABLE_RULES.invoices).toEqual({ lineTable: "invoice_line_items", lineFk: "invoice_id" });
    expect(TABLE_RULES.sales_orders.lineTable).toBe("sales_order_lines");
    expect(TABLE_RULES.purchase_orders.lineTable).toBe("purchase_order_lines");
    expect(TABLE_RULES.rfqs.lineTable).toBe("rfq_line_items");
  });
  it("never lists journal_entry_lines (draft-JE lines cascade in the DB)", () => {
    expect(TABLE_RULES.journal_entries).toBeUndefined();
    for (const rule of Object.values(TABLE_RULES)) {
      expect(rule.lineTable).not.toBe("journal_entry_lines");
    }
  });
});

describe("fkRefusalReason", () => {
  it("extracts the constraint name from a 23503", () => {
    const err = {
      code: "23503",
      message: 'update or delete on table "customers" violates foreign key constraint "ar_invoices_customer_id_fkey" on table "ar_invoices"',
    };
    expect(fkRefusalReason(err)).toBe("still referenced (ar_invoices_customer_id_fkey)");
  });
  it("recognises FK text without the code", () => {
    expect(fkRefusalReason({ message: "violates foreign key constraint" }))
      .toBe("still referenced (foreign key)");
  });
  it("passes other errors through", () => {
    expect(fkRefusalReason({ code: "42501", message: "permission denied" }))
      .toBe("delete failed: permission denied");
    expect(fkRefusalReason(null)).toBe("delete failed: delete failed");
  });
});

describe("chunk", () => {
  it("splits arrays into fixed-size batches", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 10)).toEqual([]);
  });
});
