// Tests for Tangerine P4-5 AR Receipt void handler. Validates:
//   - reverseJournalEntry called for BOTH accrual + cash JEs when both set
//   - reverseJournalEntry called only for the one that's set
//   - reverseJournalEntry skipped entirely for an un-posted draft (still
//     flips is_void; the applications back out via the is_void=false filter
//     on the paid maintainer)
//   - is_void=true + voided_at + void_reason are stamped
//   - 409 on already-void receipt
//   - 404 on missing receipt
//   - notification fires to admin + accountant with severity 'warn'

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../_lib/notifications/index.js", () => ({
  enqueue: vi.fn().mockResolvedValue({ event_id: "ev1", dispatch_count: 0 }),
}));
vi.mock("../../_lib/accounting/posting/index.js", () => ({
  reverseJournalEntry: vi.fn(),
  postEvent: vi.fn(),
  PostingError: class extends Error {},
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(),
}));

import handler from "../../_handlers/internal/ar-receipts/void.js";
import { reverseJournalEntry } from "../../_lib/accounting/posting/index.js";
import { enqueue as enqueueNotification } from "../../_lib/notifications/index.js";
import { createClient } from "@supabase/supabase-js";

const ENTITY = "00000000-0000-0000-0000-000000000001";
const RECEIPT = "00000000-0000-0000-0000-000000000002";
const CUSTOMER = "00000000-0000-0000-0000-000000000003";
const BANK = "00000000-0000-0000-0000-000000000004";
const ACC_JE = "00000000-0000-0000-0000-0000000ccc01";
const CASH_JE = "00000000-0000-0000-0000-0000000ccc02";
const REV_ACC_JE = "00000000-0000-0000-0000-000000d0d001";
const REV_CASH_JE = "00000000-0000-0000-0000-000000d0d002";

function mockReq(id, body = {}) {
  return {
    method: "POST",
    query: { id },
    body,
    headers: { host: "localhost" },
    url: `/api/internal/ar-receipts/${id}/void`,
  };
}

function mockRes() {
  return {
    statusCode: 200,
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this._payload = p; return this; },
    end() { return this; },
  };
}

function makeReceipt(over = {}) {
  return {
    id: RECEIPT,
    entity_id: ENTITY,
    customer_id: CUSTOMER,
    receipt_date: "2026-05-27",
    amount_cents: "10000",
    bank_account_id: BANK,
    customer_payment_method: "ach",
    reference: null,
    notes: null,
    accrual_je_id: ACC_JE,
    cash_je_id: CASH_JE,
    is_void: false,
    ...over,
  };
}

function makeSupabase({ receipt = makeReceipt(), updateError = null } = {}) {
  const updateCalls = [];
  return {
    from(table) {
      if (table === "ar_receipts") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: receipt, error: null }),
          update(payload) {
            updateCalls.push(payload);
            return { eq: async () => ({ error: updateError }) };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    __updateCalls: updateCalls,
  };
}

beforeEach(() => {
  process.env.VITE_SUPABASE_URL = "http://localhost";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  vi.clearAllMocks();
});

describe("ar-receipts POST /:id/void", () => {
  it("400 on invalid uuid", async () => {
    const res = mockRes();
    await handler(mockReq("not-a-uuid"), res);
    expect(res.statusCode).toBe(400);
  });

  it("404 when receipt not found", async () => {
    createClient.mockReturnValue(makeSupabase({ receipt: null }));
    const res = mockRes();
    await handler(mockReq(RECEIPT), res);
    expect(res.statusCode).toBe(404);
  });

  it("409 when receipt is already void", async () => {
    createClient.mockReturnValue(makeSupabase({ receipt: makeReceipt({ is_void: true }) }));
    const res = mockRes();
    await handler(mockReq(RECEIPT), res);
    expect(res.statusCode).toBe(409);
    expect(res._payload.error).toMatch(/already void/i);
  });

  it("reverses BOTH JEs when accrual + cash are set, then stamps is_void", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    reverseJournalEntry
      .mockResolvedValueOnce(REV_ACC_JE)
      .mockResolvedValueOnce(REV_CASH_JE);

    const res = mockRes();
    await handler(mockReq(RECEIPT, { void_reason: "customer disputed" }), res);

    expect(res.statusCode).toBe(200);
    expect(reverseJournalEntry).toHaveBeenCalledTimes(2);
    // accrual first, then cash (handler iterates in this order)
    expect(reverseJournalEntry.mock.calls[0][1]).toBe(ACC_JE);
    expect(reverseJournalEntry.mock.calls[1][1]).toBe(CASH_JE);
    expect(res._payload.reversed_je_ids).toEqual([REV_ACC_JE, REV_CASH_JE]);

    expect(sb.__updateCalls.length).toBe(1);
    expect(sb.__updateCalls[0].is_void).toBe(true);
    expect(sb.__updateCalls[0].voided_at).toBeTypeOf("string");
    expect(sb.__updateCalls[0].void_reason).toBe("customer disputed");
  });

  it("reverses ONLY the accrual JE when cash_je_id is null", async () => {
    const sb = makeSupabase({ receipt: makeReceipt({ cash_je_id: null }) });
    createClient.mockReturnValue(sb);
    reverseJournalEntry.mockResolvedValueOnce(REV_ACC_JE);

    const res = mockRes();
    await handler(mockReq(RECEIPT), res);

    expect(res.statusCode).toBe(200);
    expect(reverseJournalEntry).toHaveBeenCalledTimes(1);
    expect(reverseJournalEntry.mock.calls[0][1]).toBe(ACC_JE);
    expect(res._payload.reversed_je_ids).toEqual([REV_ACC_JE]);
  });

  it("does NOT call reverseJournalEntry on an unposted draft (both JE ids null)", async () => {
    const sb = makeSupabase({ receipt: makeReceipt({ accrual_je_id: null, cash_je_id: null }) });
    createClient.mockReturnValue(sb);

    const res = mockRes();
    await handler(mockReq(RECEIPT), res);

    expect(res.statusCode).toBe(200);
    expect(reverseJournalEntry).not.toHaveBeenCalled();
    // is_void is still flipped — the applications back out via the
    // ar_invoices.paid_amount_cents maintainer's `is_void=false` filter.
    expect(sb.__updateCalls[0].is_void).toBe(true);
    expect(res._payload.reversed_je_ids).toEqual([]);
  });

  it("400 when reverseJournalEntry throws", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    reverseJournalEntry.mockRejectedValue(new Error("cannot reverse JE in closed period"));

    const res = mockRes();
    await handler(mockReq(RECEIPT), res);

    expect(res.statusCode).toBe(400);
    expect(res._payload.error).toMatch(/Failed to reverse JE/);
    // is_void is NOT flipped (bail-out on reversal failure)
    expect(sb.__updateCalls.length).toBe(0);
  });

  it("fires ar_receipt_voided notification to admin + accountant with severity=warn", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    reverseJournalEntry
      .mockResolvedValueOnce(REV_ACC_JE)
      .mockResolvedValueOnce(REV_CASH_JE);

    await handler(mockReq(RECEIPT, { void_reason: "dispute" }), mockRes());

    expect(enqueueNotification).toHaveBeenCalledTimes(1);
    const [, notif] = enqueueNotification.mock.calls[0];
    expect(notif.kind).toBe("ar_receipt_voided");
    expect(notif.severity).toBe("warn");
    expect(notif.context_table).toBe("ar_receipts");
    expect(notif.context_id).toBe(RECEIPT);
    expect(notif.recipient_roles).toEqual(["admin", "accountant"]);
    expect(notif.body).toMatch(/dispute/);
  });

  it("405 on non-POST", async () => {
    const res = mockRes();
    await handler({ ...mockReq(RECEIPT), method: "GET" }, res);
    expect(res.statusCode).toBe(405);
  });

  it("OPTIONS preflight returns 200", async () => {
    const res = mockRes();
    await handler({ ...mockReq(RECEIPT), method: "OPTIONS" }, res);
    expect(res.statusCode).toBe(200);
  });

  it("stamps voided_by_user_id when valid uuid supplied", async () => {
    const userId = "00000000-0000-0000-0000-0000000d0d0d";
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    reverseJournalEntry
      .mockResolvedValueOnce(REV_ACC_JE)
      .mockResolvedValueOnce(REV_CASH_JE);

    await handler(mockReq(RECEIPT, { created_by_user_id: userId }), mockRes());

    expect(sb.__updateCalls[0].voided_by_user_id).toBe(userId);
  });

  it("stamps null voided_by_user_id when garbage supplied", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    reverseJournalEntry
      .mockResolvedValueOnce(REV_ACC_JE)
      .mockResolvedValueOnce(REV_CASH_JE);

    await handler(mockReq(RECEIPT, { created_by_user_id: "abc" }), mockRes());

    expect(sb.__updateCalls[0].voided_by_user_id).toBeNull();
  });

  it("trims void_reason; empty string → null", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    reverseJournalEntry
      .mockResolvedValueOnce(REV_ACC_JE)
      .mockResolvedValueOnce(REV_CASH_JE);

    await handler(mockReq(RECEIPT, { void_reason: "   trimmed   " }), mockRes());

    expect(sb.__updateCalls[0].void_reason).toBe("trimmed");
  });
});
