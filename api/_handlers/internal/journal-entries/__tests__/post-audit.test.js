// Tests for the T11-2 sweep of api/_handlers/internal/journal-entries/index.js
// (manual JE post, which fires the audit trigger as a POST operation).

import { describe, it, expect, vi, beforeEach } from "vitest";

const ENT_ID = "33333333-3333-4333-8333-333333333333";
const AUTH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCT_A = "44444444-4444-4444-8444-444444444444";
const ACCT_B = "55555555-5555-4555-8555-555555555555";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => globalThis.__adminStub),
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
  const rpcSpy = vi.fn(async (name) => {
    if (name === "gl_post_journal_entry") {
      return { data: "je-new-id", error: null };
    }
    return { data: null, error: null };
  });
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: AUTH_ID } } })),
    },
    from(table) {
      if (table === "entities") {
        const chain = {
          select() { return chain; },
          eq() { return chain; },
          async maybeSingle() { return { data: { id: ENT_ID }, error: null }; },
        };
        return chain;
      }
      if (table === "employees") {
        const chain = {
          select() { return chain; },
          eq() { return chain; },
          async maybeSingle() {
            return { data: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", full_name: "Acct Manager" }, error: null };
          },
        };
        return chain;
      }
      if (table === "approval_rules") {
        // Maker/checker gate: the handler queries active rules for this JE. No
        // rule → below threshold → posts normally (these test JEs are $100).
        const chain = {
          select() { return chain; },
          eq() { return chain; },
          then(resolve) { return resolve({ data: [], error: null }); },
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
  const mod = await import("../index.js");
  return mod.default;
}

function validPostBody(extra = {}) {
  return {
    basis: "ACCRUAL",
    posting_date: "2026-05-29",
    description: "Test JE",
    lines: [
      { line_number: 1, account_id: ACCT_A, debit: "100.00", credit: "0" },
      { line_number: 2, account_id: ACCT_B, debit: "0", credit: "100.00" },
    ],
    ...extra,
  };
}

describe("JE manual-post T11-2 sweep", () => {
  it("returns 400 when reason is missing (T11 D3)", async () => {
    globalThis.__adminStub = adminStub();
    const handler = await loadHandler();
    const res = makeRes();
    await handler(
      {
        method: "POST",
        url: "/api/internal/journal-entries",
        headers: { host: "x" },
        body: validPostBody(),
      },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/reason is required for POST/);
  });

  it("returns 400 when reason is whitespace", async () => {
    globalThis.__adminStub = adminStub();
    const handler = await loadHandler();
    const res = makeRes();
    await handler(
      {
        method: "POST",
        url: "/api/internal/journal-entries",
        headers: { host: "x" },
        body: validPostBody({ reason: "   " }),
      },
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it("calls set_audit_context before gl_post_journal_entry when valid", async () => {
    const admin = adminStub();
    globalThis.__adminStub = admin;
    const handler = await loadHandler();
    const res = makeRes();
    await handler(
      {
        method: "POST",
        url: "/api/internal/journal-entries",
        headers: { host: "x", authorization: "Bearer x.y.z", "x-request-id": "r-1" },
        body: validPostBody({ reason: "month-end accrual" }),
      },
      res,
    );
    // Both RPCs should fire — set_audit_context first, then the post.
    const rpcNames = admin._rpcSpy.mock.calls.map((c) => c[0]);
    expect(rpcNames).toContain("set_audit_context");
    expect(rpcNames).toContain("gl_post_journal_entry");
    const setIdx = rpcNames.indexOf("set_audit_context");
    const postIdx = rpcNames.indexOf("gl_post_journal_entry");
    expect(setIdx).toBeLessThan(postIdx);

    // set_audit_context received the right payload
    const setCall = admin._rpcSpy.mock.calls.find((c) => c[0] === "set_audit_context");
    expect(setCall[1]).toMatchObject({
      p_actor_auth_id: AUTH_ID,
      p_actor_employee_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      p_actor_display_name: "Acct Manager",
      p_audit_source: "manual",
      p_audit_reason: "month-end accrual",
      p_audit_correlation_id: "r-1",
    });
    expect(res.statusCode).toBe(201);
  });

  it("still rejects unbalanced lines with 400", async () => {
    globalThis.__adminStub = adminStub();
    const handler = await loadHandler();
    const res = makeRes();
    await handler(
      {
        method: "POST",
        url: "/api/internal/journal-entries",
        headers: { host: "x" },
        body: validPostBody({
          reason: "x",
          lines: [
            { line_number: 1, account_id: ACCT_A, debit: "100", credit: "0" },
            { line_number: 2, account_id: ACCT_B, debit: "0", credit: "50" },
          ],
        }),
      },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Unbalanced/);
  });
});
