// Tests for the T11-2 sweep of api/_handlers/internal/journal-entries/reverse.js.

import { describe, it, expect, vi, beforeEach } from "vitest";

const JE_ID = "11111111-1111-4111-8111-111111111111";
const NEW_JE = "22222222-2222-4222-8222-222222222222";
const AUTH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => globalThis.__adminStub),
}));

vi.mock("../../../../_lib/accounting/posting/reverse.js", () => ({
  reverseJournalEntry: vi.fn(async () => NEW_JE),
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

function adminStub() {
  const rpcSpy = vi.fn(async () => ({ data: null, error: null }));
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: AUTH_ID } } })),
    },
    from(table) {
      if (table === "employees") {
        const chain = {
          select() { return chain; },
          eq() { return chain; },
          async maybeSingle() { return { data: null, error: null }; },
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
  const mod = await import("../reverse.js");
  return mod.default;
}

describe("JE reverse T11-2 sweep", () => {
  it("returns 400 when reason is missing (T11 D3)", async () => {
    globalThis.__adminStub = adminStub();
    const handler = await loadHandler();
    const res = makeRes();
    await handler(
      {
        method: "POST",
        query: { id: JE_ID },
        body: { posting_date: "2026-05-29" },
        headers: {},
      },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/reason is required for REVERSE/);
  });

  it("calls reverse_journal_entry_with_audit RPC when valid", async () => {
    const admin = adminStub();
    globalThis.__adminStub = admin;
    const handler = await loadHandler();
    const res = makeRes();
    await handler(
      {
        method: "POST",
        query: { id: JE_ID },
        body: { reason: "fix typo on line 3", posting_date: "2026-05-29" },
        headers: { authorization: "Bearer x.y.z", "x-request-id": "r-9" },
      },
      res,
    );
    expect(res.statusCode).toBe(201);
    expect(res.body.reversal_je_id).toBe(NEW_JE);
    expect(res.body.original_je_id).toBe(JE_ID);

    const auditCall = admin._rpcSpy.mock.calls.find(
      (c) => c[0] === "reverse_journal_entry_with_audit",
    );
    expect(auditCall).toBeTruthy();
    expect(auditCall[1]).toMatchObject({
      je_id: JE_ID,
      reversal_je_id: NEW_JE,
      audit_actor_auth_id: AUTH_ID,
      audit_reason: "fix typo on line 3",
      audit_source: "manual",
      audit_correlation_id: "r-9",
    });
  });

  it("returns 400 on invalid id", async () => {
    globalThis.__adminStub = adminStub();
    const handler = await loadHandler();
    const res = makeRes();
    await handler(
      { method: "POST", query: { id: "bad-id" }, body: { reason: "x" }, headers: {} },
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns 405 on GET", async () => {
    globalThis.__adminStub = adminStub();
    const handler = await loadHandler();
    const res = makeRes();
    await handler({ method: "GET", query: { id: JE_ID }, headers: {} }, res);
    expect(res.statusCode).toBe(405);
  });

  it("rejects bad posting_date format", async () => {
    globalThis.__adminStub = adminStub();
    const handler = await loadHandler();
    const res = makeRes();
    await handler(
      {
        method: "POST",
        query: { id: JE_ID },
        body: { reason: "x", posting_date: "May 29 2026" },
        headers: {},
      },
      res,
    );
    expect(res.statusCode).toBe(400);
  });
});
