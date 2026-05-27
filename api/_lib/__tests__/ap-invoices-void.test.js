// Tests for P3-2 apInvoiceVoided rule output shape — the rule decides
// whether to reverse JE(s) based on current gl_status. The handler then
// flips gl_status to 'void' regardless.

import { describe, it, expect } from "vitest";
import { apInvoiceVoided } from "../accounting/posting/rules/apInvoiceVoided.js";

const INVOICE = "00000000-0000-0000-0000-000000000001";
const ACCRUAL_JE = "00000000-0000-0000-0000-0000000000aa";
const CASH_JE = "00000000-0000-0000-0000-0000000000bb";

describe("apInvoiceVoided rule (P3-1 schema, exercised by P3-2 handler)", () => {
  it("requires invoice_id", () => {
    expect(() => apInvoiceVoided({ data: {} })).toThrow(/invoice_id/);
  });

  it("returns empty reversals for a 'draft' invoice (nothing to undo)", () => {
    const out = apInvoiceVoided({
      data: { invoice_id: INVOICE, gl_status: "unposted" },
    });
    expect(out.reversals).toEqual([]);
    expect(out.accrual).toBeNull();
    expect(out.cash).toBeNull();
  });

  it("returns empty reversals for 'pending_approval' invoice (not yet GL-posted)", () => {
    const out = apInvoiceVoided({
      data: { invoice_id: INVOICE, gl_status: "pending_approval" },
    });
    expect(out.reversals).toEqual([]);
  });

  it("returns [accrual_je_id] for a 'posted' invoice with no payment yet", () => {
    const out = apInvoiceVoided({
      data: {
        invoice_id: INVOICE, gl_status: "posted",
        accrual_je_id: ACCRUAL_JE, cash_je_id: null,
      },
    });
    expect(out.reversals).toEqual([ACCRUAL_JE]);
  });

  it("returns [accrual_je_id, cash_je_id] for a posted+paid invoice", () => {
    const out = apInvoiceVoided({
      data: {
        invoice_id: INVOICE, gl_status: "posted",
        accrual_je_id: ACCRUAL_JE, cash_je_id: CASH_JE,
      },
    });
    expect(out.reversals).toEqual([ACCRUAL_JE, CASH_JE]);
  });

  it("returns empty reversals for already-void invoice (no-op)", () => {
    const out = apInvoiceVoided({
      data: { invoice_id: INVOICE, gl_status: "void" },
    });
    expect(out.reversals).toEqual([]);
  });

  it("returns empty reversals for already-reversed invoice", () => {
    const out = apInvoiceVoided({
      data: { invoice_id: INVOICE, gl_status: "reversed" },
    });
    expect(out.reversals).toEqual([]);
  });

  it("throws on unexpected status", () => {
    expect(() => apInvoiceVoided({
      data: { invoice_id: INVOICE, gl_status: "frozen" },
    })).toThrow(/cannot void/i);
  });

  it("defaults gl_status to 'posted' when not provided + reverses accrual", () => {
    const out = apInvoiceVoided({
      data: { invoice_id: INVOICE, accrual_je_id: ACCRUAL_JE },
    });
    expect(out.reversals).toEqual([ACCRUAL_JE]);
  });

  it("output shape always has accrual=null, cash=null", () => {
    const variations = [
      { gl_status: "posted", accrual_je_id: ACCRUAL_JE },
      { gl_status: "unposted" },
      { gl_status: "void" },
    ];
    for (const v of variations) {
      const out = apInvoiceVoided({ data: { invoice_id: INVOICE, ...v } });
      expect(out.accrual).toBeNull();
      expect(out.cash).toBeNull();
      expect(Array.isArray(out.reversals)).toBe(true);
    }
  });
});
