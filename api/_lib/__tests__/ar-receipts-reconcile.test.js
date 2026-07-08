import { describe, it, expect } from "vitest";
import { isPaidState, receiptPostingDate, composeReceiptPayload } from "../../_handlers/cron/ar-receipts-reconcile.js";

describe("isPaidState — Xoro payment-state classification", () => {
  it("FullPaymentDate present → paid, regardless of status text", () => {
    expect(isPaidState({ full_payment_date: "2026-05-01" })).toBe(true);
  });
  it("paid-like statuses without partial/un qualifiers → paid", () => {
    expect(isPaidState({ payment_status: "Paid" })).toBe(true);
    expect(isPaidState({ payment_status: "Closed" })).toBe(true);
    expect(isPaidState({ payment_status: "Partially Paid" })).toBe(false);
    expect(isPaidState({ payment_status: "Unpaid" })).toBe(false);
    expect(isPaidState({ payment_status: "Open" })).toBe(false);
    expect(isPaidState(null)).toBe(false);
  });
});

describe("receiptPostingDate — clamped into the open window", () => {
  const today = "2026-07-08";
  it("uses FullPaymentDate when present", () => {
    expect(receiptPostingDate({ full_payment_date: "2026-03-15" }, "2026-03-01", today)).toBe("2026-03-15");
  });
  it("clamps below the locked floor to 2024-08-01", () => {
    expect(receiptPostingDate({ full_payment_date: "2024-05-01" }, null, today)).toBe("2024-08-01");
  });
  it("clamps future dates to today; falls back to invoice date then today", () => {
    expect(receiptPostingDate({ full_payment_date: "2027-01-01" }, null, today)).toBe(today);
    expect(receiptPostingDate({}, "2026-06-01", today)).toBe("2026-06-01");
    expect(receiptPostingDate({}, null, today)).toBe(today);
  });
});

describe("composeReceiptPayload", () => {
  const invoice = { id: "inv-1", invoice_number: "XI-9", customer_id: "cust-1", ar_account_id: "acct-ar", invoice_date: "2026-05-02", total_amount_cents: 123456 };
  it("DR clearing / CR AR with customer subledger, T11 reason, idempotency key", () => {
    const p = composeReceiptPayload({ entity_id: "ent", invoice, st: { full_payment_date: "2026-05-20" }, drAccountId: "acct-1051", todayIso: "2026-07-08" });
    expect(p.journal_type).toBe("ar_receipt_xoro");
    expect(p.source_module).toBe("xoro_receipts");
    expect(p.source_id).toBe("inv-1");
    expect(p.posting_date).toBe("2026-05-20");
    expect(p.audit_reason).toMatch(/Xoro payment state/);
    expect(p.lines[0]).toMatchObject({ account_id: "acct-1051", debit: "1234.56", credit: "0" });
    expect(p.lines[1]).toMatchObject({ account_id: "acct-ar", credit: "1234.56", subledger_type: "customer", subledger_id: "cust-1" });
  });
});
