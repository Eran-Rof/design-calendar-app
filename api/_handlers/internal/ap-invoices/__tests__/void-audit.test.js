// Tests for the T11-2 sweep of api/_handlers/internal/ap-invoices/void.js.

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
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: AUTH_ID } } })),
    },
    from(table) {
      if (table === "invoices") {
        const chain = {
          select() { return chain; },
          eq() { return chain; },
          async maybeSingle() { return { data: invoice, error: null }; },
        };
        return chain;
      }
      if (table === "employees") {
        const chain = {
          select() { return chain; },
          eq() { return chain; },
          async maybeSingle() {
            return { data: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", full_name: "Bob Bookkeeper" }, error: null };
          },
        };
        return chain;
      }
      throw new Error(`Unexpected table: ${table}`);
    },
    rpc: rpcSpy,
    _rpcSpy: rpcSpy,
  };
}

beforeEach(() => {
  process.env.VITE_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
});

async function loadHandler() {
  const mod = await import("../void.js");
  return mod.default;
}

describe("AP-invoice void T11-2 sweep", () => {
  it("returns 400 when reason is missing (T11 D3)", async () => {
    globalThis.__adminStub = adminStubWithInvoice(null);
    const handler = await loadHandler();
    const res = makeRes();
    await handler(
      { method: "POST", query: { id: INV_ID }, body: {}, headers: {} },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/reason is required for VOID/);
  });

  it("returns 404 when invoice not found", async () => {
    globalThis.__adminStub = adminStubWithInvoice(null);
    const handler = await loadHandler();
    const res = makeRes();
    await handler(
      { method: "POST", query: { id: INV_ID }, body: { reason: "x" }, headers: {} },
      res,
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns 409 when invoice is already void", async () => {
    globalThis.__adminStub = adminStubWithInvoice({
      id: INV_ID, entity_id: ENT_ID, gl_status: "void", invoice_number: "AP-1",
    });
    const handler = await loadHandler();
    const res = makeRes();
    await handler(
      { method: "POST", query: { id: INV_ID }, body: { reason: "x" }, headers: {} },
      res,
    );
    expect(res.statusCode).toBe(409);
  });

  it("calls void_ap_invoice_with_audit RPC when valid", async () => {
    const admin = adminStubWithInvoice({
      id: INV_ID, entity_id: ENT_ID, gl_status: "posted", invoice_number: "AP-1",
    });
    globalThis.__adminStub = admin;
    const handler = await loadHandler();
    const res = makeRes();
    await handler(
      {
        method: "POST",
        query: { id: INV_ID },
        body: { reason: "duplicate bill" },
        headers: { authorization: "Bearer x.y.z", "x-correlation-id": "corr-1" },
      },
      res,
    );
    const auditCall = admin._rpcSpy.mock.calls.find(
      (c) => c[0] === "void_ap_invoice_with_audit",
    );
    expect(auditCall).toBeTruthy();
    expect(auditCall[1]).toMatchObject({
      invoice_id: INV_ID,
      audit_actor_auth_id: AUTH_ID,
      audit_reason: "duplicate bill",
      audit_source: "manual",
      audit_correlation_id: "corr-1",
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 400 with invalid uuid id", async () => {
    globalThis.__adminStub = adminStubWithInvoice(null);
    const handler = await loadHandler();
    const res = makeRes();
    await handler(
      { method: "POST", query: { id: "bad" }, body: { reason: "x" }, headers: {} },
      res,
    );
    expect(res.statusCode).toBe(400);
  });
});
