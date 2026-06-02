// Tests for Tangerine P4-5 ar-receipt-applications DELETE handler — the
// "unapply a single application" path. Pure validateDelete checks + a small
// integration sanity test for the DELETE flow.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(),
}));

import handler, { validateDelete } from "../../_handlers/internal/ar-receipt-applications/[id].js";
import { createClient } from "@supabase/supabase-js";

const RECEIPT = "00000000-0000-0000-0000-000000000001";
const APP_ID = "00000000-0000-0000-0000-000000000002";
const INV_ID = "00000000-0000-0000-0000-000000000003";
const JE = "00000000-0000-0000-0000-000000000aaa";

// ────────────────────────────────────────────────────────────────────────
// Pure validateDelete
// ────────────────────────────────────────────────────────────────────────

describe("ar-receipt-applications validateDelete", () => {
  it("blocks when parent embed is missing (defensive)", () => {
    expect(validateDelete({}).error).toMatch(/Parent receipt not found/);
    expect(validateDelete({ ar_receipts: null }).error).toMatch(/Parent receipt not found/);
  });
  it("blocks when parent receipt is voided", () => {
    expect(validateDelete({
      ar_receipts: { id: RECEIPT, is_void: true, accrual_je_id: null, cash_je_id: null },
    }).error).toMatch(/voided/i);
  });
  it("blocks when parent receipt has accrual_je_id (posted)", () => {
    expect(validateDelete({
      ar_receipts: { id: RECEIPT, is_void: false, accrual_je_id: JE, cash_je_id: null },
    }).error).toMatch(/posted/i);
  });
  it("blocks when parent receipt has cash_je_id only (defensive)", () => {
    expect(validateDelete({
      ar_receipts: { id: RECEIPT, is_void: false, accrual_je_id: null, cash_je_id: JE },
    }).error).toMatch(/posted/i);
  });
  it("allows when parent is a draft receipt (both JE ids null + not void)", () => {
    expect(validateDelete({
      ar_receipts: { id: RECEIPT, is_void: false, accrual_je_id: null, cash_je_id: null },
    }).ok).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// DELETE handler integration (mocked Supabase)
// ────────────────────────────────────────────────────────────────────────

function mockReq(id) {
  return {
    method: "DELETE",
    query: { id },
    headers: { host: "localhost" },
    url: `/api/internal/ar-receipt-applications/${id}`,
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

function makeSupabase({ app = null, deleteError = null } = {}) {
  const deleteCalls = [];
  return {
    from(table) {
      if (table === "ar_receipt_applications") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: app, error: null }),
          delete() {
            deleteCalls.push(true);
            return { eq: async () => ({ error: deleteError }) };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    __deleteCalls: deleteCalls,
  };
}

beforeEach(() => {
  process.env.VITE_SUPABASE_URL = "http://localhost";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  vi.clearAllMocks();
});

describe("ar-receipt-applications DELETE /:id", () => {
  it("400 on invalid uuid", async () => {
    const res = mockRes();
    await handler(mockReq("not-a-uuid"), res);
    expect(res.statusCode).toBe(400);
  });

  it("404 when application not found", async () => {
    createClient.mockReturnValue(makeSupabase({ app: null }));
    const res = mockRes();
    await handler(mockReq(APP_ID), res);
    expect(res.statusCode).toBe(404);
  });

  it("409 when parent receipt is voided", async () => {
    const sb = makeSupabase({
      app: {
        id: APP_ID,
        ar_receipt_id: RECEIPT,
        ar_invoice_id: INV_ID,
        amount_applied_cents: "1000",
        ar_receipts: { id: RECEIPT, is_void: true, accrual_je_id: null, cash_je_id: null },
      },
    });
    createClient.mockReturnValue(sb);

    const res = mockRes();
    await handler(mockReq(APP_ID), res);
    expect(res.statusCode).toBe(409);
    expect(sb.__deleteCalls.length).toBe(0);
  });

  it("409 when parent receipt is posted (accrual_je_id set)", async () => {
    const sb = makeSupabase({
      app: {
        id: APP_ID,
        ar_receipt_id: RECEIPT,
        ar_invoice_id: INV_ID,
        amount_applied_cents: "1000",
        ar_receipts: { id: RECEIPT, is_void: false, accrual_je_id: JE, cash_je_id: null },
      },
    });
    createClient.mockReturnValue(sb);

    const res = mockRes();
    await handler(mockReq(APP_ID), res);
    expect(res.statusCode).toBe(409);
    expect(sb.__deleteCalls.length).toBe(0);
  });

  it("204 on successful unapply (parent receipt is draft)", async () => {
    const sb = makeSupabase({
      app: {
        id: APP_ID,
        ar_receipt_id: RECEIPT,
        ar_invoice_id: INV_ID,
        amount_applied_cents: "1000",
        ar_receipts: { id: RECEIPT, is_void: false, accrual_je_id: null, cash_je_id: null },
      },
    });
    createClient.mockReturnValue(sb);

    const res = mockRes();
    await handler(mockReq(APP_ID), res);
    expect(res.statusCode).toBe(204);
    expect(sb.__deleteCalls.length).toBe(1);
  });

  it("405 on non-DELETE method", async () => {
    const res = mockRes();
    await handler({ ...mockReq(APP_ID), method: "POST" }, res);
    expect(res.statusCode).toBe(405);
  });

  it("OPTIONS returns 200 (CORS preflight)", async () => {
    const res = mockRes();
    await handler({ ...mockReq(APP_ID), method: "OPTIONS" }, res);
    expect(res.statusCode).toBe(200);
  });
});
