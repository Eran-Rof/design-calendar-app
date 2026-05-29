// Tests for the T11-2 sweep of api/_handlers/internal/ar-invoices/void.js.
//
// We exercise the handler with mocked supabase-js, postEvent, and
// extractActorFromRequest. Key assertions:
//   • POST with no reason → 400 (T11 D3)
//   • POST with reason → calls void_ar_invoice_with_audit RPC with the
//     audit_* param prefix
//   • paid invoice → 409 (existing behaviour still works)
//   • already-void → 409 (existing behaviour still works)
//   • not-found → 404
//
// We don't try to exercise the full posting flow — those are covered by
// the existing P4 chunk-4 test suite. Here we only assert the D3 gate +
// audit-aware RPC call.

import { describe, it, expect, vi, beforeEach } from "vitest";

const ENT_ID = "11111111-1111-4111-8111-111111111111";
const INV_ID = "22222222-2222-4222-8222-222222222222";
const AUTH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => globalThis.__adminStub),
}));

vi.mock("../../../../_lib/accounting/posting/index.js", () => ({
  postEvent: vi.fn(async () => ({ reversed_je_ids: [] })),
  PostingError: class PostingError extends Error {},
}));

vi.mock("../../../../_lib/notifications/index.js", () => ({
  enqueue: vi.fn(async () => {}),
}));

function makeRes() {
  const headers = {};
  const res = {
    statusCode: 0,
    body: null,
    setHeader(k, v) { headers[k] = v; },
    headers,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
    end() { return res; },
  };
  return res;
}

function adminStubWithInvoice(invoice) {
  const rpcSpy = vi.fn(async () => ({ data: null, error: null }));
  const updateSpy = vi.fn(async () => ({ error: null }));
  const stub = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: AUTH_ID } } })),
    },
    from(table) {
      if (table === "ar_invoices") {
        const chain = {
          select() { return chain; },
          eq() { return chain; },
          async maybeSingle() { return { data: invoice, error: null }; },
          update(patch) {
            const upChain = {
              eq: () => updateSpy(patch),
            };
            return upChain;
          },
        };
        return chain;
      }
      if (table === "employees") {
        const chain = {
          select() { return chain; },
          eq() { return chain; },
          async maybeSingle() {
            return { data: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", full_name: "Eve Operator" }, error: null };
          },
        };
        return chain;
      }
      throw new Error(`Unexpected table: ${table}`);
    },
    rpc: rpcSpy,
    _rpcSpy: rpcSpy,
    _updateSpy: updateSpy,
  };
  return stub;
}

beforeEach(() => {
  process.env.VITE_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
});

async function loadHandler() {
  const mod = await import("../void.js");
  return mod.default;
}

describe("AR-invoice void T11-2 sweep", () => {
  it("returns 400 when reason is missing (T11 D3)", async () => {
    globalThis.__adminStub = adminStubWithInvoice(null);
    const handler = await loadHandler();
    const res = makeRes();
    await handler(
      {
        method: "POST",
        query: { id: INV_ID },
        body: { /* no reason */ },
        headers: { authorization: `Bearer x.y.z` },
      },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/reason is required for VOID/);
  });

  it("returns 400 when reason is whitespace", async () => {
    globalThis.__adminStub = adminStubWithInvoice(null);
    const handler = await loadHandler();
    const res = makeRes();
    await handler(
      {
        method: "POST",
        query: { id: INV_ID },
        body: { reason: "   " },
        headers: {},
      },
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when invoice not found", async () => {
    globalThis.__adminStub = adminStubWithInvoice(null);
    const handler = await loadHandler();
    const res = makeRes();
    await handler(
      {
        method: "POST",
        query: { id: INV_ID },
        body: { reason: "customer cancelled" },
        headers: {},
      },
      res,
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns 409 when invoice already void", async () => {
    globalThis.__adminStub = adminStubWithInvoice({
      id: INV_ID, entity_id: ENT_ID, gl_status: "void", paid_amount_cents: "0",
    });
    const handler = await loadHandler();
    const res = makeRes();
    await handler(
      {
        method: "POST",
        query: { id: INV_ID },
        body: { reason: "second void" },
        headers: {},
      },
      res,
    );
    expect(res.statusCode).toBe(409);
  });

  it("returns 409 when receipts have been applied", async () => {
    globalThis.__adminStub = adminStubWithInvoice({
      id: INV_ID, entity_id: ENT_ID, gl_status: "sent", paid_amount_cents: "5000",
    });
    const handler = await loadHandler();
    const res = makeRes();
    await handler(
      {
        method: "POST",
        query: { id: INV_ID },
        body: { reason: "operator request" },
        headers: {},
      },
      res,
    );
    expect(res.statusCode).toBe(409);
    expect(res.body.has_payments).toBe(true);
  });

  it("calls void_ar_invoice_with_audit RPC with audit_* params when valid", async () => {
    const admin = adminStubWithInvoice({
      id: INV_ID,
      entity_id: ENT_ID,
      gl_status: "sent",
      paid_amount_cents: "0",
      invoice_number: "INV-0001",
      notes: null,
    });
    globalThis.__adminStub = admin;
    const handler = await loadHandler();
    const res = makeRes();
    await handler(
      {
        method: "POST",
        query: { id: INV_ID },
        body: { reason: "customer cancelled order" },
        headers: { authorization: "Bearer x.y.z", "x-request-id": "req-42" },
      },
      res,
    );
    // RPC was called with the audit prefix
    const calls = admin._rpcSpy.mock.calls;
    const auditCall = calls.find((c) => c[0] === "void_ar_invoice_with_audit");
    expect(auditCall).toBeTruthy();
    expect(auditCall[1]).toMatchObject({
      invoice_id: INV_ID,
      audit_actor_auth_id: AUTH_ID,
      audit_actor_employee_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      audit_actor_display_name: "Eve Operator",
      audit_source: "manual",
      audit_reason: "customer cancelled order",
      audit_correlation_id: "req-42",
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 405 on non-POST methods", async () => {
    globalThis.__adminStub = adminStubWithInvoice(null);
    const handler = await loadHandler();
    const res = makeRes();
    await handler({ method: "GET", query: { id: INV_ID }, headers: {} }, res);
    expect(res.statusCode).toBe(405);
  });
});
