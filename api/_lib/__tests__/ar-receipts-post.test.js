// Tests for Tangerine P4-5 AR Receipt POST handler — the multi-application
// posting flow. Supabase + postEvent + notifications are mocked. We verify:
//   - Already-posted receipt → 409
//   - Voided receipt → 409
//   - Zero applications → 409 (we require at least one)
//   - Missing invoice → 404
//   - Multi-application payload reaches postEvent with the correct shape
//     (one entry per application, ar_account_id + revenue_account_id per
//      invoice, total_amount_cents = sum of applications)
//   - On success: receipt is stamped with accrual_je_id + cash_je_id
//   - Notification fires to admin + accountant roles
//   - Invalid id → 400

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be hoisted ABOVE the import-under-test.
vi.mock("../../_lib/notifications/index.js", () => ({
  enqueue: vi.fn().mockResolvedValue({ event_id: "ev1", dispatch_count: 0 }),
}));
vi.mock("../../_lib/accounting/posting/index.js", () => ({
  postEvent: vi.fn(),
  PostingError: class extends Error {},
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(),
}));

import handler from "../../_handlers/internal/ar-receipts/post.js";
import { postEvent } from "../../_lib/accounting/posting/index.js";
import { enqueue as enqueueNotification } from "../../_lib/notifications/index.js";
import { createClient } from "@supabase/supabase-js";

const ENTITY = "00000000-0000-0000-0000-000000000001";
const RECEIPT = "00000000-0000-0000-0000-000000000002";
const CUSTOMER = "00000000-0000-0000-0000-000000000003";
const BANK = "00000000-0000-0000-0000-000000000004";
const AR_ACCT = "00000000-0000-0000-0000-00000000aa01";
const REV_ACCT = "00000000-0000-0000-0000-00000000bb01";
const INV1 = "00000000-0000-0000-0000-0000000a0001";
const INV2 = "00000000-0000-0000-0000-0000000a0002";
const ACC_JE = "00000000-0000-0000-0000-0000000ccc01";
const CASH_JE = "00000000-0000-0000-0000-0000000ccc02";

function mockReq(id, body = {}) {
  return {
    method: "POST",
    query: { id },
    body,
    headers: { host: "localhost" },
    url: `/api/internal/ar-receipts/${id}/post`,
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
    reference: "WIRE-001",
    notes: null,
    accrual_je_id: null,
    cash_je_id: null,
    is_void: false,
    ...over,
  };
}

function makeSupabase({
  receipt = makeReceipt(),
  applications = [
    { id: "app1", ar_invoice_id: INV1, amount_applied_cents: "6000" },
    { id: "app2", ar_invoice_id: INV2, amount_applied_cents: "4000" },
  ],
  invoices = [
    { id: INV1, invoice_number: "AR-2026-00001", ar_account_id: AR_ACCT, revenue_account_id: REV_ACCT },
    { id: INV2, invoice_number: "AR-2026-00002", ar_account_id: AR_ACCT, revenue_account_id: REV_ACCT },
  ],
  entityDefaults = { default_ar_account_id: AR_ACCT, default_revenue_account_id: REV_ACCT },
  updateError = null,
} = {}) {
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
      if (table === "ar_receipt_applications") {
        return {
          select() { return this; },
          eq: async () => ({ data: applications, error: null }),
        };
      }
      if (table === "ar_invoices") {
        return {
          select() { return this; },
          in: async () => ({ data: invoices, error: null }),
        };
      }
      if (table === "entities") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: entityDefaults, error: null }),
        };
      }
      if (table === "gl_accounts") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: null, error: null }),
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

describe("ar-receipts POST /:id/post", () => {
  it("400 on invalid uuid", async () => {
    const req = mockReq("not-a-uuid");
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._payload.error).toMatch(/Invalid id/);
  });

  it("404 when receipt not found", async () => {
    const sb = makeSupabase({ receipt: null });
    createClient.mockReturnValue(sb);
    const req = mockReq(RECEIPT);
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("409 when receipt is voided", async () => {
    const sb = makeSupabase({ receipt: makeReceipt({ is_void: true }) });
    createClient.mockReturnValue(sb);
    const req = mockReq(RECEIPT);
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res._payload.error).toMatch(/voided/i);
  });

  it("409 when receipt is already posted (accrual_je_id set)", async () => {
    const sb = makeSupabase({ receipt: makeReceipt({ accrual_je_id: ACC_JE }) });
    createClient.mockReturnValue(sb);
    const req = mockReq(RECEIPT);
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res._payload.error).toMatch(/already posted/i);
  });

  it("409 when zero applications exist", async () => {
    const sb = makeSupabase({ applications: [] });
    createClient.mockReturnValue(sb);
    const req = mockReq(RECEIPT);
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res._payload.error).toMatch(/zero applications/i);
  });

  it("posts both JEs on success and stamps the receipt", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    postEvent.mockResolvedValue({ accrual_je_id: ACC_JE, cash_je_id: CASH_JE });

    const req = mockReq(RECEIPT);
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._payload.accrual_je_id).toBe(ACC_JE);
    expect(res._payload.cash_je_id).toBe(CASH_JE);
    expect(res._payload.applications_count).toBe(2);
    // receipt was stamped via .update({...})
    expect(sb.__updateCalls.length).toBe(1);
    expect(sb.__updateCalls[0]).toEqual({
      accrual_je_id: ACC_JE,
      cash_je_id: CASH_JE,
    });
  });

  it("emits postEvent with multi-application shape (one entry per app + total cross-check)", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    postEvent.mockResolvedValue({ accrual_je_id: ACC_JE, cash_je_id: CASH_JE });

    await handler(mockReq(RECEIPT), mockRes());

    expect(postEvent).toHaveBeenCalledTimes(1);
    const [, ev] = postEvent.mock.calls[0];
    expect(ev.kind).toBe("ar_payment_received");
    expect(ev.entity_id).toBe(ENTITY);
    expect(ev.data.receipt_id).toBe(RECEIPT);
    expect(ev.data.bank_account_id).toBe(BANK);
    expect(ev.data.applications).toHaveLength(2);
    expect(ev.data.applications[0]).toMatchObject({
      ar_invoice_id: INV1,
      ar_account_id: AR_ACCT,
      revenue_account_id: REV_ACCT,
      amount_cents: "6000",
      invoice_number: "AR-2026-00001",
    });
    expect(ev.data.applications[1]).toMatchObject({
      ar_invoice_id: INV2,
      amount_cents: "4000",
    });
    // total_amount_cents = sum of applications (6000 + 4000 = 10000)
    expect(ev.data.total_amount_cents).toBe("10000");
  });

  it("falls back to entity default ar_account_id + revenue_account_id when invoice fields are null", async () => {
    const sb = makeSupabase({
      invoices: [
        { id: INV1, invoice_number: "AR-2026-00001", ar_account_id: null, revenue_account_id: null },
        { id: INV2, invoice_number: "AR-2026-00002", ar_account_id: null, revenue_account_id: null },
      ],
    });
    createClient.mockReturnValue(sb);
    postEvent.mockResolvedValue({ accrual_je_id: ACC_JE, cash_je_id: CASH_JE });

    await handler(mockReq(RECEIPT), mockRes());

    const [, ev] = postEvent.mock.calls[0];
    for (const app of ev.data.applications) {
      expect(app.ar_account_id).toBe(AR_ACCT);
      expect(app.revenue_account_id).toBe(REV_ACCT);
    }
  });

  it("400 when no ar_account_id available on invoice OR entity OR by code", async () => {
    const sb = makeSupabase({
      invoices: [{ id: INV1, invoice_number: "X", ar_account_id: null, revenue_account_id: REV_ACCT }],
      applications: [{ id: "app1", ar_invoice_id: INV1, amount_applied_cents: "10000" }],
      entityDefaults: { default_ar_account_id: null, default_revenue_account_id: REV_ACCT },
    });
    createClient.mockReturnValue(sb);

    const res = mockRes();
    await handler(mockReq(RECEIPT), res);
    expect(res.statusCode).toBe(400);
    expect(res._payload.error).toMatch(/ar_account_id/);
  });

  it("400 when no revenue_account_id available on invoice OR entity OR by code", async () => {
    const sb = makeSupabase({
      invoices: [{ id: INV1, invoice_number: "X", ar_account_id: AR_ACCT, revenue_account_id: null }],
      applications: [{ id: "app1", ar_invoice_id: INV1, amount_applied_cents: "10000" }],
      entityDefaults: { default_ar_account_id: AR_ACCT, default_revenue_account_id: null },
    });
    createClient.mockReturnValue(sb);

    const res = mockRes();
    await handler(mockReq(RECEIPT), res);
    expect(res.statusCode).toBe(400);
    expect(res._payload.error).toMatch(/revenue_account_id/);
  });

  it("fires ar_receipt_posted notification to admin + accountant", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    postEvent.mockResolvedValue({ accrual_je_id: ACC_JE, cash_je_id: CASH_JE });

    await handler(mockReq(RECEIPT), mockRes());

    expect(enqueueNotification).toHaveBeenCalledTimes(1);
    const [, notif] = enqueueNotification.mock.calls[0];
    expect(notif.kind).toBe("ar_receipt_posted");
    expect(notif.context_table).toBe("ar_receipts");
    expect(notif.context_id).toBe(RECEIPT);
    expect(notif.recipient_roles).toEqual(["admin", "accountant"]);
  });

  it("surfaces PostingError as 400", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    const { PostingError } = await import("../../_lib/accounting/posting/index.js");
    postEvent.mockRejectedValue(new PostingError("balance_failed", "DR ≠ CR"));

    const res = mockRes();
    await handler(mockReq(RECEIPT), res);
    expect(res.statusCode).toBe(400);
    expect(res._payload.error).toMatch(/AR receipt posting failed/);
  });

  it("405 on non-POST", async () => {
    const res = mockRes();
    await handler({ ...mockReq(RECEIPT), method: "GET" }, res);
    expect(res.statusCode).toBe(405);
  });

  it("OPTIONS returns 200 (CORS preflight)", async () => {
    const res = mockRes();
    await handler({ ...mockReq(RECEIPT), method: "OPTIONS" }, res);
    expect(res.statusCode).toBe(200);
  });

  it("passes created_by_user_id from body to postEvent", async () => {
    const userId = "00000000-0000-0000-0000-0000000d0d0d";
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    postEvent.mockResolvedValue({ accrual_je_id: ACC_JE, cash_je_id: CASH_JE });

    await handler(mockReq(RECEIPT, { created_by_user_id: userId }), mockRes());

    const [, ev] = postEvent.mock.calls[0];
    expect(ev.created_by_user_id).toBe(userId);
  });

  it("ignores malformed created_by_user_id (falls back to null)", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    postEvent.mockResolvedValue({ accrual_je_id: ACC_JE, cash_je_id: CASH_JE });

    await handler(mockReq(RECEIPT, { created_by_user_id: "bad" }), mockRes());

    const [, ev] = postEvent.mock.calls[0];
    expect(ev.created_by_user_id).toBeNull();
  });
});
