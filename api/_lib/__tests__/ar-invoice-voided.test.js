// Tests for arInvoiceVoided (P4-2; arch §4.3).
//
// Emits `reversals: string[]` shape (same pattern as P3-1's apInvoiceVoided).
// postEvent short-circuits the candidates and calls reverseJournalEntry()
// for each id.

import { describe, it, expect } from "vitest";
import { arInvoiceVoided } from "../accounting/posting/rules/arInvoiceVoided.js";

const ENTITY = "00000000-0000-0000-0000-000000000001";
const INVOICE = "22222222-2222-2222-2222-222222222222";
const ACCRUAL_JE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CASH_JE    = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function baseEvent(data) {
  return {
    kind: "ar_invoice_voided",
    entity_id: ENTITY,
    data: { invoice_id: INVOICE, ...data },
  };
}

describe("arInvoiceVoided — reversible statuses", () => {
  it("status='sent' with accrual_je_id only → reverse accrual", () => {
    const r = arInvoiceVoided(baseEvent({
      gl_status: "sent",
      accrual_je_id: ACCRUAL_JE,
    }));
    expect(r.accrual).toBeNull();
    expect(r.cash).toBeNull();
    expect(r.reversals).toEqual([ACCRUAL_JE]);
  });

  it("status='partial_paid' with both accrual + cash → reverse both", () => {
    const r = arInvoiceVoided(baseEvent({
      gl_status: "partial_paid",
      accrual_je_id: ACCRUAL_JE,
      cash_je_id: CASH_JE,
    }));
    expect(r.reversals).toEqual([ACCRUAL_JE, CASH_JE]);
  });

  it("status='paid' with both → reverse both", () => {
    const r = arInvoiceVoided(baseEvent({
      gl_status: "paid",
      accrual_je_id: ACCRUAL_JE,
      cash_je_id: CASH_JE,
    }));
    expect(r.reversals).toEqual([ACCRUAL_JE, CASH_JE]);
  });

  it("status='posted_historical' (backfill) → reverses normally", () => {
    const r = arInvoiceVoided(baseEvent({
      gl_status: "posted_historical",
      accrual_je_id: ACCRUAL_JE,
    }));
    expect(r.reversals).toEqual([ACCRUAL_JE]);
  });

  it("default (status unspecified) treats as 'sent'", () => {
    const r = arInvoiceVoided(baseEvent({
      accrual_je_id: ACCRUAL_JE,
    }));
    expect(r.reversals).toEqual([ACCRUAL_JE]);
  });
});

describe("arInvoiceVoided — already-terminal statuses (idempotent no-op)", () => {
  it("status='reversed' returns empty reversals", () => {
    const r = arInvoiceVoided(baseEvent({
      gl_status: "reversed",
      accrual_je_id: ACCRUAL_JE,
      cash_je_id: CASH_JE,
    }));
    expect(r.reversals).toEqual([]);
  });

  it("status='void' returns empty reversals", () => {
    const r = arInvoiceVoided(baseEvent({
      gl_status: "void",
      accrual_je_id: ACCRUAL_JE,
    }));
    expect(r.reversals).toEqual([]);
  });
});

describe("arInvoiceVoided — never-posted statuses", () => {
  it("status='draft' returns empty reversals", () => {
    const r = arInvoiceVoided(baseEvent({
      gl_status: "draft",
    }));
    expect(r.reversals).toEqual([]);
  });

  it("status='pending_approval' returns empty reversals", () => {
    const r = arInvoiceVoided(baseEvent({
      gl_status: "pending_approval",
    }));
    expect(r.reversals).toEqual([]);
  });
});

describe("arInvoiceVoided — validation", () => {
  it("throws on missing invoice_id", () => {
    expect(() => arInvoiceVoided({
      kind: "ar_invoice_voided", entity_id: ENTITY, data: {},
    })).toThrow(/invoice_id/);
  });

  it("throws on missing data", () => {
    expect(() => arInvoiceVoided({
      kind: "ar_invoice_voided", entity_id: ENTITY,
    })).toThrow(/data is required/);
  });

  it("throws on unknown status", () => {
    expect(() => arInvoiceVoided(baseEvent({
      gl_status: "frozen",
      accrual_je_id: ACCRUAL_JE,
    }))).toThrow(/cannot void.*frozen/);
  });

  it("sent invoice with no JE ids returns empty reversals (defensive)", () => {
    // Shouldn't happen in practice but the rule shouldn't crash
    const r = arInvoiceVoided(baseEvent({
      gl_status: "sent",
    }));
    expect(r.reversals).toEqual([]);
  });

  it("sent invoice with cash_je_id but no accrual_je_id reverses only cash (defensive)", () => {
    const r = arInvoiceVoided(baseEvent({
      gl_status: "sent",
      cash_je_id: CASH_JE,
    }));
    expect(r.reversals).toEqual([CASH_JE]);
  });
});
