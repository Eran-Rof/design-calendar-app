// Tests for apInvoiceVoided (P3-1).
//
// Unlike the other rules, this rule emits NO new JE candidates. Instead it
// returns a `reversals` array of JE ids to feed to reverseJournalEntry.
// The posting service short-circuits when it sees the `reversals` shape.

import { describe, it, expect } from "vitest";
import { apInvoiceVoided } from "../accounting/posting/rules/apInvoiceVoided.js";

const ENTITY = "00000000-0000-0000-0000-000000000001";
const INVOICE = "22222222-2222-2222-2222-222222222222";
const ACCRUAL_JE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CASH_JE    = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function baseEvent(data) {
  return {
    kind: "ap_invoice_voided",
    entity_id: ENTITY,
    data: { invoice_id: INVOICE, ...data },
  };
}

describe("apInvoiceVoided — posted (accrual only)", () => {
  it("returns reversals=[accrual_je_id]", () => {
    const r = apInvoiceVoided(baseEvent({
      gl_status: "posted",
      accrual_je_id: ACCRUAL_JE,
      cash_je_id: null,
    }));
    expect(r.accrual).toBeNull();
    expect(r.cash).toBeNull();
    expect(r.reversals).toEqual([ACCRUAL_JE]);
  });

  it("returns reversals=[accrual_je_id, cash_je_id] when both posted", () => {
    const r = apInvoiceVoided(baseEvent({
      gl_status: "posted",
      accrual_je_id: ACCRUAL_JE,
      cash_je_id: CASH_JE,
    }));
    expect(r.reversals).toEqual([ACCRUAL_JE, CASH_JE]);
  });
});

describe("apInvoiceVoided — already terminal status (no-op)", () => {
  it("status=reversed returns empty reversals", () => {
    const r = apInvoiceVoided(baseEvent({
      gl_status: "reversed",
      accrual_je_id: ACCRUAL_JE,
    }));
    expect(r.reversals).toEqual([]);
  });

  it("status=void returns empty reversals", () => {
    const r = apInvoiceVoided(baseEvent({
      gl_status: "void",
      accrual_je_id: ACCRUAL_JE,
    }));
    expect(r.reversals).toEqual([]);
  });
});

describe("apInvoiceVoided — never-posted statuses", () => {
  it("status=unposted returns empty reversals (nothing to reverse)", () => {
    const r = apInvoiceVoided(baseEvent({
      gl_status: "unposted",
    }));
    expect(r.reversals).toEqual([]);
  });

  it("status=pending_approval returns empty reversals", () => {
    const r = apInvoiceVoided(baseEvent({
      gl_status: "pending_approval",
    }));
    expect(r.reversals).toEqual([]);
  });

  it("default (status unspecified) treats as posted", () => {
    const r = apInvoiceVoided(baseEvent({
      accrual_je_id: ACCRUAL_JE,
    }));
    expect(r.reversals).toEqual([ACCRUAL_JE]);
  });
});

describe("apInvoiceVoided — validation", () => {
  it("throws on missing invoice_id", () => {
    expect(() => apInvoiceVoided({
      kind: "ap_invoice_voided", entity_id: ENTITY, data: {},
    })).toThrow(/invoice_id/);
  });

  it("throws on missing data", () => {
    expect(() => apInvoiceVoided({
      kind: "ap_invoice_voided", entity_id: ENTITY,
    })).toThrow(/data is required/);
  });

  it("throws on unknown status", () => {
    expect(() => apInvoiceVoided(baseEvent({
      gl_status: "frozen",
      accrual_je_id: ACCRUAL_JE,
    }))).toThrow(/cannot void.*frozen/);
  });

  it("posted invoice with no JE ids returns empty reversals (defensive)", () => {
    // This shouldn't happen in practice (posted => accrual_je_id set) but the
    // rule shouldn't crash — the handler can decide what to do.
    const r = apInvoiceVoided(baseEvent({
      gl_status: "posted",
    }));
    expect(r.reversals).toEqual([]);
  });
});
