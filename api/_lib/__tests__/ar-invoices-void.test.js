// Tests for P4-4 AR invoice POST /:id/void handler.
//
// We mock postEvent + notifications + supabase and verify:
//   - Already-void invoice → 409.
//   - Invoice with paid_amount_cents > 0 → 409 has_payments=true.
//   - Draft invoice → postEvent called, reversed_je_ids=[], gl_status flipped to 'void'.
//   - Sent invoice with accrual_je_id only → postEvent called, reversed_je_ids carries one id.
//   - Sent + paid invoice (cash_je_id set) — both reversed (verified at rule level).
//   - PostingError → 400.
//   - Notification kind = ar_invoice_voided with admin+accountant recipients.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../_lib/notifications/index.js", () => ({
  enqueue: vi.fn().mockResolvedValue({ event_id: "ev1", dispatch_count: 0 }),
}));
vi.mock("../../_lib/accounting/posting/index.js", () => ({
  postEvent: vi.fn(),
  PostingError: class extends Error {},
}));

import { enqueue as enqueueNotification } from "../../_lib/notifications/index.js";
import { postEvent, PostingError } from "../../_lib/accounting/posting/index.js";
// The void handler doesn't export a helper — we exercise it through its
// default handler with a mocked req/res.
import handlerDefault from "../../_handlers/internal/ar-invoices/void.js";

const INVOICE = "00000000-0000-0000-0000-000000000001";
const ENTITY  = "00000000-0000-0000-0000-000000000002";
const ACCRUAL = "00000000-0000-0000-0000-000000000010";
const CASH    = "00000000-0000-0000-0000-000000000011";

function makeRes() {
  const r = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(s) { this.statusCode = s; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
  return r;
}

function makeReq({ id = INVOICE, method = "POST", body = null } = {}) {
  // T11-2 D3: reason is REQUIRED for VOID. The P4-4 tests predate this
  // gate and exercise other behaviour; default body to a stub reason so
  // existing assertions still flow through to the void path.
  const finalBody = body == null ? { reason: "test void" } : body;
  return {
    method,
    query: { id },
    headers: {},
    body: finalBody,
  };
}

function makeAdmin({ invoice, updateError = null, rpcError = null } = {}) {
  const updates = [];
  const rpcCalls = [];
  return {
    // T11-2: extractActorFromRequest probes auth.getUser. With no token
    // present we never reach this in the existing tests, but provide the
    // stub so the handler doesn't crash on the call shape.
    auth: {
      getUser: vi.fn(async () => ({ data: { user: null } })),
    },
    rpc: vi.fn(async (name, params) => {
      rpcCalls.push({ name, params });
      return { data: null, error: rpcError };
    }),
    from(table) {
      if (table === "ar_invoices") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: invoice, error: null }),
          update(patch) {
            return {
              eq: async (col, val) => {
                updates.push({ patch, [col]: val });
                return { error: updateError };
              },
            };
          },
        };
      }
      if (table === "employees") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: null, error: null }),
        };
      }
      throw new Error(`unmocked ${table}`);
    },
    _updates: updates,
    _rpcCalls: rpcCalls,
  };
}

// Mock createClient
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(),
}));
import { createClient } from "@supabase/supabase-js";

describe("ar-invoices void handler (P4-4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VITE_SUPABASE_URL = "http://localhost";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fake";
  });

  it("404 when invoice not found", async () => {
    createClient.mockReturnValueOnce(makeAdmin({ invoice: null }));
    const req = makeReq();
    const res = makeRes();
    await handlerDefault(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("400 for bad id", async () => {
    const req = makeReq({ id: "not-uuid" });
    const res = makeRes();
    await handlerDefault(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Invalid id/);
  });

  it("409 when invoice already void", async () => {
    createClient.mockReturnValueOnce(makeAdmin({
      invoice: { id: INVOICE, entity_id: ENTITY, gl_status: "void", paid_amount_cents: "0" },
    }));
    const res = makeRes();
    await handlerDefault(makeReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already void/i);
    expect(postEvent).not.toHaveBeenCalled();
  });

  it("409 with has_payments=true when paid_amount_cents > 0", async () => {
    createClient.mockReturnValueOnce(makeAdmin({
      invoice: { id: INVOICE, entity_id: ENTITY, gl_status: "partial_paid", paid_amount_cents: "5000" },
    }));
    const res = makeRes();
    await handlerDefault(makeReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.has_payments).toBe(true);
    expect(res.body.paid_amount_cents).toBe("5000");
    expect(postEvent).not.toHaveBeenCalled();
  });

  it("draft invoice → postEvent called with empty reversals, gl_status flipped to void", async () => {
    const admin = makeAdmin({
      invoice: {
        id: INVOICE, entity_id: ENTITY, gl_status: "draft",
        accrual_je_id: null, cash_je_id: null,
        invoice_number: "AR-1", paid_amount_cents: "0", notes: null,
      },
    });
    createClient.mockReturnValueOnce(admin);
    postEvent.mockResolvedValueOnce({ reversed_je_ids: [] });

    const res = makeRes();
    await handlerDefault(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.gl_status).toBe("void");
    expect(res.body.reversed_je_ids).toEqual([]);
    expect(postEvent).toHaveBeenCalledOnce();
    const evt = postEvent.mock.calls[0][1];
    expect(evt.kind).toBe("ar_invoice_voided");
    expect(evt.entity_id).toBe(ENTITY);
    expect(evt.data.invoice_id).toBe(INVOICE);
    expect(evt.data.accrual_je_id).toBeNull();
    expect(evt.data.cash_je_id).toBeNull();
    // T11-2: gl_status flip happens via void_ar_invoice_with_audit RPC,
    // not via a direct .update(). The notes annotation is the only
    // remaining direct UPDATE in this handler.
    const voidRpc = admin._rpcCalls.find((c) => c.name === "void_ar_invoice_with_audit");
    expect(voidRpc).toBeTruthy();
    expect(voidRpc.params.invoice_id).toBe(INVOICE);
  });

  it("sent invoice with accrual_je_id → reverses one JE", async () => {
    const admin = makeAdmin({
      invoice: {
        id: INVOICE, entity_id: ENTITY, gl_status: "sent",
        accrual_je_id: ACCRUAL, cash_je_id: null,
        invoice_number: "AR-1", paid_amount_cents: "0", notes: null,
      },
    });
    createClient.mockReturnValueOnce(admin);
    postEvent.mockResolvedValueOnce({ reversed_je_ids: ["REV-NEW-1"] });

    const res = makeRes();
    await handlerDefault(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.reversed_je_ids).toEqual(["REV-NEW-1"]);
    const evt = postEvent.mock.calls[0][1];
    expect(evt.data.accrual_je_id).toBe(ACCRUAL);
  });

  it("notification fired with ar_invoice_voided kind + admin/accountant recipients", async () => {
    const admin = makeAdmin({
      invoice: {
        id: INVOICE, entity_id: ENTITY, gl_status: "sent",
        accrual_je_id: ACCRUAL, cash_je_id: null,
        invoice_number: "AR-7", paid_amount_cents: "0", notes: null,
      },
    });
    createClient.mockReturnValueOnce(admin);
    postEvent.mockResolvedValueOnce({ reversed_je_ids: ["REV-NEW-1"] });

    const res = makeRes();
    await handlerDefault(makeReq({ body: { reason: "billed wrong customer" } }), res);

    expect(enqueueNotification).toHaveBeenCalled();
    const args = enqueueNotification.mock.calls[0][1];
    expect(args.kind).toBe("ar_invoice_voided");
    expect(args.recipient_roles).toEqual(["admin", "accountant"]);
    expect(args.context_table).toBe("ar_invoices");
    expect(args.body).toMatch(/billed wrong customer/);
  });

  it("appends reason to invoice.notes column on void", async () => {
    const admin = makeAdmin({
      invoice: {
        id: INVOICE, entity_id: ENTITY, gl_status: "draft",
        accrual_je_id: null, cash_je_id: null,
        invoice_number: "AR-1", paid_amount_cents: "0", notes: "prior note",
      },
    });
    createClient.mockReturnValueOnce(admin);
    postEvent.mockResolvedValueOnce({ reversed_je_ids: [] });
    const res = makeRes();
    await handlerDefault(makeReq({ body: { reason: "duplicate" } }), res);
    expect(res.statusCode).toBe(200);
    expect(admin._updates.at(-1).patch.notes).toBe("prior note\n[void] duplicate");
  });

  it("400 when postEvent throws PostingError", async () => {
    const admin = makeAdmin({
      invoice: {
        id: INVOICE, entity_id: ENTITY, gl_status: "sent",
        accrual_je_id: ACCRUAL, cash_je_id: null,
        invoice_number: "AR-1", paid_amount_cents: "0", notes: null,
      },
    });
    createClient.mockReturnValueOnce(admin);
    postEvent.mockRejectedValueOnce(new PostingError("period_closed", "period closed"));

    const res = makeRes();
    await handlerDefault(makeReq(), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Void failed/);
  });

  it("405 for non-POST methods", async () => {
    const res = makeRes();
    await handlerDefault(makeReq({ method: "GET" }), res);
    expect(res.statusCode).toBe(405);
  });

  it("OPTIONS preflight returns 200", async () => {
    const res = makeRes();
    await handlerDefault(makeReq({ method: "OPTIONS" }), res);
    expect(res.statusCode).toBe(200);
  });

  it("paid invoice (cash_je_id set) passes both ids into rule via postEvent.data", async () => {
    const admin = makeAdmin({
      invoice: {
        id: INVOICE, entity_id: ENTITY, gl_status: "paid",
        accrual_je_id: ACCRUAL, cash_je_id: CASH,
        invoice_number: "AR-99", paid_amount_cents: "0", notes: null,
      },
    });
    createClient.mockReturnValueOnce(admin);
    postEvent.mockResolvedValueOnce({ reversed_je_ids: ["REV-1", "REV-2"] });

    const res = makeRes();
    await handlerDefault(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.reversed_je_ids).toEqual(["REV-1", "REV-2"]);
    const evt = postEvent.mock.calls[0][1];
    expect(evt.data.accrual_je_id).toBe(ACCRUAL);
    expect(evt.data.cash_je_id).toBe(CASH);
  });
});
