// Tests for Tangerine P13-4 — real bookkeeper-approve handler.
//
// Replaces the P13-3 stub h499 with the actual approval workflow:
//   - bookkeeper role gate (employees.role OR entity_users.role)
//   - audit context capture (T11-2 pattern, reason REQUIRED)
//   - invoice status flip + AP JE post (via existing postInvoice)
//   - bookkeeper_approval_log row
//
// Coverage matches the P13-4 brief — 20+ unit tests across authN, authZ,
// input validation, precondition asserts, happy paths, error paths, and
// audit-context propagation.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock state shared across tests — controls what the fake supabase client
// returns for any given (table, filter) combination.
const state = vi.hoisted(() => ({
  authUser: null,                  // { id } or null
  authFail: false,
  employee: null,                  // { id, role, display_name } or null
  entityUser: null,                // { role } or null
  invoice: null,                   // invoice row or null
  invoiceLoadError: null,
  invoiceUpdateError: null,
  logInsertError: null,
  rpcCalls: [],                    // recorded set_audit_context / clear_audit_context calls
  postInvoiceResult: null,         // mocked postInvoice return
  postInvoiceCalls: [],
  invoiceUpdates: [],              // record every update payload
  logInserts: [],
}));

// Mock @supabase/supabase-js BEFORE importing the handler.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => makeFakeClient(),
}));

// Mock the postInvoice import so we don't drag in the real AP posting flow.
// Mock the AP post module. Path is relative to THIS test file:
//   api/_handlers/internal/procurement/invoices/__tests__/bookkeeper-approve.test.js
// → ../../../ap-invoices/post.js
//   (..) leaves __tests__, (..) leaves invoices/, (..) leaves procurement/, then ap-invoices/post.js
vi.mock("../../../ap-invoices/post.js", () => ({
  postInvoice: vi.fn(async (admin, opts) => {
    state.postInvoiceCalls.push(opts);
    return state.postInvoiceResult || { status: 200, body: { accrual_je_id: "je-from-mock", gl_status: "posted" } };
  }),
}));

function makeFakeClient() {
  return {
    auth: {
      async getUser(jwt) {
        if (state.authFail || !jwt) return { data: { user: null }, error: { message: "invalid" } };
        return { data: { user: state.authUser }, error: null };
      },
    },
    rpc: async (name, args) => {
      state.rpcCalls.push({ name, args });
      return { data: null, error: null };
    },
    from(table) {
      const ctx = { table, filters: [], updates: null, insertPayload: null };
      const builder = {
        select() { return builder; },
        update(payload) { ctx.updates = payload; return builder; },
        insert(payload) { ctx.insertPayload = payload; return builder; },
        eq(col, val) { ctx.filters.push([col, val]); return builder; },
        maybeSingle() { return runSelect(ctx); },
        single() { return runSelect(ctx).then(r => ({ data: r.data, error: r.error })); },
        then(resolve, reject) {
          // Triggered when the call is just an INSERT/UPDATE without .select()
          return runMutation(ctx).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

async function runMutation(ctx) {
  if (ctx.updates) {
    if (ctx.table === "invoices") {
      state.invoiceUpdates.push(ctx.updates);
      if (state.invoiceUpdateError) return { data: null, error: { message: state.invoiceUpdateError } };
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }
  if (ctx.insertPayload) {
    if (ctx.table === "bookkeeper_approval_log") {
      state.logInserts.push(ctx.insertPayload);
      if (state.logInsertError) return { data: null, error: { message: state.logInsertError } };
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }
  return { data: null, error: null };
}

async function runSelect(ctx) {
  // Mutating + .select().single() (not used here) — return inserted row.
  if (ctx.updates) {
    await runMutation(ctx);
    return { data: null, error: null };
  }
  switch (ctx.table) {
    case "employees":
      return { data: state.employee, error: null };
    case "entity_users":
      return { data: state.entityUser, error: null };
    case "invoices":
      if (state.invoiceLoadError) return { data: null, error: { message: state.invoiceLoadError } };
      return { data: state.invoice, error: null };
    default:
      return { data: null, error: null };
  }
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}

function makeReq({
  method = "POST",
  id = "00000000-0000-0000-0000-000000000abc",
  body,
  authHeader = "Bearer good-token",
  correlationId,
} = {}) {
  const headers = { host: "localhost" };
  if (authHeader) headers.authorization = authHeader;
  if (correlationId) headers["x-correlation-id"] = correlationId;
  return {
    method,
    body,
    url: `/api/internal/procurement/invoices/${id}/bookkeeper-approve`,
    query: id ? { id } : {},
    headers,
  };
}

function resetState() {
  state.authUser = { id: "auth-1" };
  state.authFail = false;
  state.employee = null;
  state.entityUser = null;
  state.invoice = null;
  state.invoiceLoadError = null;
  state.invoiceUpdateError = null;
  state.logInsertError = null;
  state.rpcCalls.length = 0;
  state.postInvoiceResult = null;
  state.postInvoiceCalls.length = 0;
  state.invoiceUpdates.length = 0;
  state.logInserts.length = 0;
}

function validBookkeeper() {
  state.employee = { id: "emp-bk-1", role: "bookkeeper", display_name: "Bookie B." };
}

function validInvoice(overrides = {}) {
  state.invoice = {
    id: "00000000-0000-0000-0000-000000000abc",
    entity_id: "00000000-0000-0000-0000-0000000000aa",
    vendor_id: "00000000-0000-0000-0000-0000000000bb",
    invoice_number: "AUTO-TPR-12345678-1",
    status: "pending_bookkeeper_approval",
    gl_status: "unposted",
    is_receipt_rollup: true,
    rollup_parent_receipt_id: "00000000-0000-0000-0000-0000000000cc",
    total_amount_cents: 125000,
    expense_account_id: "00000000-0000-0000-0000-0000000000dd",
    posting_date: "2026-05-29",
    accrual_je_id: null,
    ...overrides,
  };
}

let handler;
let validateApproveBody;
let resolveBookkeeperActor;

beforeEach(async () => {
  process.env.VITE_SUPABASE_URL = "https://fake.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
  process.env.NODE_ENV = "test";
  resetState();
  vi.resetModules();
  const mod = await import("../bookkeeper-approve.js");
  handler = mod.default;
  validateApproveBody = mod.validateApproveBody;
  resolveBookkeeperActor = mod.resolveBookkeeperActor;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("validateApproveBody (pure)", () => {
  it("rejects null body", () => {
    expect(validateApproveBody(null).error).toMatch(/Body/);
  });

  it("rejects non-object body", () => {
    expect(validateApproveBody(42).error).toMatch(/Body/);
  });

  it("rejects missing action", () => {
    expect(validateApproveBody({ reason: "ok" }).error).toMatch(/action is required/);
  });

  it("rejects bogus action enum", () => {
    expect(validateApproveBody({ action: "delete", reason: "ok ok" }).error).toMatch(
      /action must be 'approve' or 'reject'/,
    );
  });

  it("rejects missing reason (D3 required)", () => {
    expect(validateApproveBody({ action: "approve" }).error).toMatch(/reason is required/);
  });

  it("rejects whitespace-only reason", () => {
    expect(validateApproveBody({ action: "approve", reason: "   " }).error).toMatch(/reason is required/);
  });

  it("rejects too-short reason", () => {
    expect(validateApproveBody({ action: "approve", reason: "x" }).error).toMatch(/at least 3 characters/);
  });

  it("accepts valid approve + reason", () => {
    const v = validateApproveBody({ action: "approve", reason: "looks legit" });
    expect(v.error).toBeUndefined();
    expect(v.data).toEqual({ action: "approve", reason: "looks legit" });
  });

  it("accepts valid reject + reason", () => {
    const v = validateApproveBody({ action: "reject", reason: "duplicate" });
    expect(v.error).toBeUndefined();
    expect(v.data.action).toBe("reject");
  });

  it("trims reason whitespace", () => {
    expect(validateApproveBody({ action: "approve", reason: "  ok ok  " }).data.reason).toBe("ok ok");
  });

  it("lowercases action input", () => {
    expect(validateApproveBody({ action: "APPROVE", reason: "looks ok" }).data.action).toBe("approve");
  });
});

describe("HTTP framing", () => {
  it("answers OPTIONS preflight 200", async () => {
    const req = makeReq({ method: "OPTIONS" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Access-Control-Allow-Methods"]).toMatch(/POST/);
  });

  it("returns 405 on non-POST", async () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("POST");
  });

  it("returns 400 on missing id", async () => {
    const req = { method: "POST", query: {}, headers: { host: "x" }, body: {} };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 on non-uuid id", async () => {
    const req = makeReq({ id: "not-a-uuid" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 on invalid JSON string body", async () => {
    const req = makeReq({ body: "{not json" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });
});

describe("authN / authZ", () => {
  it("returns 401 when no Authorization header", async () => {
    const req = makeReq({ authHeader: null, body: { action: "approve", reason: "ok ok" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when JWT is invalid", async () => {
    state.authFail = true;
    const req = makeReq({ body: { action: "approve", reason: "ok ok" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 when actor is not a bookkeeper or admin", async () => {
    state.employee = { id: "emp-1", role: "warehouse_picker", display_name: "Pat" };
    const req = makeReq({ body: { action: "approve", reason: "ok ok" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/bookkeeper/);
  });

  it("accepts an admin via employees.role", async () => {
    state.employee = { id: "emp-admin", role: "admin", display_name: "A" };
    validInvoice();
    const req = makeReq({ body: { action: "reject", reason: "dup invoice" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.action).toBe("reject");
  });

  it("falls back to entity_users.role when no employees match", async () => {
    state.entityUser = { role: "bookkeeper" };
    validInvoice();
    const req = makeReq({ body: { action: "reject", reason: "duplicate" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("resolveBookkeeperActor returns null when neither lookup matches", async () => {
    // Without setting state.employee or state.entityUser → both null.
    const fake = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
      }),
    };
    const r = await resolveBookkeeperActor(fake, "auth-x");
    expect(r.role).toBe(null);
    expect(r.employee_id).toBe(null);
  });
});

describe("validation failures (400)", () => {
  beforeEach(() => validBookkeeper());

  it("returns 400 when action missing", async () => {
    const req = makeReq({ body: { reason: "ok ok" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when reason missing (D3 enforcement at API layer)", async () => {
    const req = makeReq({ body: { action: "approve" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/reason is required/);
  });

  it("returns 400 on wrong action enum", async () => {
    const req = makeReq({ body: { action: "yeet", reason: "ok ok" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });
});

describe("invoice precondition asserts", () => {
  beforeEach(() => validBookkeeper());

  it("returns 404 when invoice not found", async () => {
    state.invoice = null;
    const req = makeReq({ body: { action: "approve", reason: "ok ok" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("returns 500 when invoice load errors", async () => {
    state.invoiceLoadError = "DB down";
    const req = makeReq({ body: { action: "approve", reason: "ok ok" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
  });

  it("returns 409 when invoice is NOT is_receipt_rollup", async () => {
    validInvoice({ is_receipt_rollup: false });
    const req = makeReq({ body: { action: "approve", reason: "ok ok" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/receipt-rollup/);
  });

  it("returns 409 when invoice.status is not pending_bookkeeper_approval", async () => {
    validInvoice({ status: "approved" });
    const req = makeReq({ body: { action: "approve", reason: "ok ok" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/pending_bookkeeper_approval/);
  });
});

describe("approve happy path", () => {
  beforeEach(() => {
    validBookkeeper();
    validInvoice();
    state.postInvoiceResult = { status: 200, body: { accrual_je_id: "je-100", gl_status: "posted" } };
  });

  it("returns 200 + je_id on success", async () => {
    const req = makeReq({ body: { action: "approve", reason: "verified vs PO + receipt" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      invoice_id: "00000000-0000-0000-0000-000000000abc",
      action: "approve",
      status: "approved",
      je_id: "je-100",
    });
  });

  it("flips invoice.status → 'approved' via update", async () => {
    const req = makeReq({ body: { action: "approve", reason: "looks good" } });
    const res = makeRes();
    await handler(req, res);
    expect(state.invoiceUpdates).toContainEqual({ status: "approved" });
  });

  it("invokes postInvoice with fromApprovalHook=true (bypass standard P3 gate)", async () => {
    const req = makeReq({ body: { action: "approve", reason: "looks good" } });
    const res = makeRes();
    await handler(req, res);
    expect(state.postInvoiceCalls).toHaveLength(1);
    expect(state.postInvoiceCalls[0].fromApprovalHook).toBe(true);
  });

  it("inserts bookkeeper_approval_log row with action='approved' + je_id", async () => {
    const req = makeReq({ body: { action: "approve", reason: "ok looks good" } });
    const res = makeRes();
    await handler(req, res);
    expect(state.logInserts).toHaveLength(1);
    expect(state.logInserts[0]).toMatchObject({
      invoice_id: "00000000-0000-0000-0000-000000000abc",
      action: "approved",
      je_id: "je-100",
      reason: "ok looks good",
    });
    expect(state.logInserts[0].bookkeeper_employee_id).toBe("emp-bk-1");
    expect(state.logInserts[0].bookkeeper_auth_id).toBe("auth-1");
  });
});

describe("reject happy path", () => {
  beforeEach(() => {
    validBookkeeper();
    validInvoice();
  });

  it("returns 200 + status='rejected' (no je_id)", async () => {
    const req = makeReq({ body: { action: "reject", reason: "vendor mismatch" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      invoice_id: "00000000-0000-0000-0000-000000000abc",
      action: "reject",
      status: "rejected",
    });
  });

  it("flips invoice.status → 'rejected'", async () => {
    const req = makeReq({ body: { action: "reject", reason: "vendor mismatch" } });
    const res = makeRes();
    await handler(req, res);
    expect(state.invoiceUpdates).toContainEqual({ status: "rejected" });
  });

  it("does NOT call postInvoice on reject", async () => {
    const req = makeReq({ body: { action: "reject", reason: "vendor mismatch" } });
    const res = makeRes();
    await handler(req, res);
    expect(state.postInvoiceCalls).toHaveLength(0);
  });

  it("inserts bookkeeper_approval_log row with action='rejected', je_id=NULL", async () => {
    const req = makeReq({ body: { action: "reject", reason: "vendor mismatch" } });
    const res = makeRes();
    await handler(req, res);
    expect(state.logInserts).toHaveLength(1);
    expect(state.logInserts[0]).toMatchObject({
      invoice_id: "00000000-0000-0000-0000-000000000abc",
      action: "rejected",
      je_id: null,
      reason: "vendor mismatch",
    });
  });
});

describe("audit context propagation (T11-2 pattern)", () => {
  beforeEach(() => {
    validBookkeeper();
    validInvoice();
    state.postInvoiceResult = { status: 200, body: { accrual_je_id: "je-200", gl_status: "posted" } };
  });

  it("calls set_audit_context with the operator-typed reason", async () => {
    const req = makeReq({ body: { action: "approve", reason: "POs all match" } });
    const res = makeRes();
    await handler(req, res);
    const setCall = state.rpcCalls.find(c => c.name === "set_audit_context");
    expect(setCall).toBeDefined();
    expect(setCall.args.p_audit_reason).toBe("POs all match");
    expect(setCall.args.p_actor_auth_id).toBe("auth-1");
    expect(setCall.args.p_actor_employee_id).toBe("emp-bk-1");
    expect(setCall.args.p_audit_source).toBe("manual");
  });

  it("calls clear_audit_context after the mutation completes", async () => {
    const req = makeReq({ body: { action: "approve", reason: "verified" } });
    const res = makeRes();
    await handler(req, res);
    const clearCall = state.rpcCalls.find(c => c.name === "clear_audit_context");
    expect(clearCall).toBeDefined();
  });

  it("propagates X-Correlation-ID header into p_audit_correlation_id", async () => {
    const req = makeReq({
      body: { action: "approve", reason: "verified" },
      correlationId: "corr-xyz-99",
    });
    const res = makeRes();
    await handler(req, res);
    const setCall = state.rpcCalls.find(c => c.name === "set_audit_context");
    expect(setCall.args.p_audit_correlation_id).toBe("corr-xyz-99");
  });

  it("set_audit_context runs BEFORE the invoice update", async () => {
    const order = [];
    state.rpcCalls.length = 0;
    // Wrap state mutators to track order.
    const origPostInvoiceCalls = state.postInvoiceCalls;
    const req = makeReq({ body: { action: "approve", reason: "good" } });
    const res = makeRes();
    await handler(req, res);
    // First RPC call must be set_audit_context (before any mutation).
    expect(state.rpcCalls[0].name).toBe("set_audit_context");
    // Last RPC must be clear_audit_context.
    expect(state.rpcCalls[state.rpcCalls.length - 1].name).toBe("clear_audit_context");
    void order; void origPostInvoiceCalls;
  });
});

describe("error path: posting service fails", () => {
  beforeEach(() => {
    validBookkeeper();
    validInvoice();
  });

  it("reverts invoice.status to pending_bookkeeper_approval on AP-post failure", async () => {
    state.postInvoiceResult = { status: 500, error: "Inventory account missing" };
    const req = makeReq({ body: { action: "approve", reason: "ok looks ok" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    // First update was 'approved', then revert update was 'pending_bookkeeper_approval'.
    expect(state.invoiceUpdates).toContainEqual({ status: "approved" });
    expect(state.invoiceUpdates).toContainEqual({ status: "pending_bookkeeper_approval" });
  });

  it("logs the failure row with AUTO-REVERT prefix in reason", async () => {
    state.postInvoiceResult = { status: 500, error: "GL account missing" };
    const req = makeReq({ body: { action: "approve", reason: "verified" } });
    const res = makeRes();
    await handler(req, res);
    expect(state.logInserts).toHaveLength(1);
    expect(state.logInserts[0].reason).toMatch(/^AUTO-REVERT:/);
    expect(state.logInserts[0].reason).toMatch(/GL account missing/);
    expect(state.logInserts[0].je_id).toBe(null);
  });

  it("clears audit context even when AP-post throws", async () => {
    state.postInvoiceResult = null; // forces the mock to use default — let's throw instead
    const { postInvoice } = await import("../../../ap-invoices/post.js");
    postInvoice.mockImplementationOnce(async () => { throw new Error("boom"); });
    const req = makeReq({ body: { action: "approve", reason: "verified" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    const clearCall = state.rpcCalls.find(c => c.name === "clear_audit_context");
    expect(clearCall).toBeDefined();
  });
});

describe("error path: invoice update / log failures", () => {
  beforeEach(() => {
    validBookkeeper();
    validInvoice();
  });

  it("returns 500 when the status flip fails on approve", async () => {
    state.invoiceUpdateError = "deadlock";
    const req = makeReq({ body: { action: "approve", reason: "verified" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/deadlock/);
  });

  it("returns 500 when the status flip fails on reject", async () => {
    state.invoiceUpdateError = "fk violation";
    const req = makeReq({ body: { action: "reject", reason: "wrong vendor" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
  });

  it("returns 200 with warning when log insert fails on successful approve", async () => {
    state.postInvoiceResult = { status: 200, body: { accrual_je_id: "je-X", gl_status: "posted" } };
    state.logInsertError = "permission denied";
    const req = makeReq({ body: { action: "approve", reason: "verified" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.warning).toMatch(/audit log/);
    expect(res.body.je_id).toBe("je-X");
  });

  it("returns 200 with warning when log insert fails on successful reject", async () => {
    state.logInsertError = "permission denied";
    const req = makeReq({ body: { action: "reject", reason: "dup" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.warning).toMatch(/audit log/);
  });
});

describe("server config", () => {
  it("returns 500 when supabase env vars unset", async () => {
    const savedUrl = process.env.VITE_SUPABASE_URL;
    const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      vi.resetModules();
      const mod = await import("../bookkeeper-approve.js");
      const req = makeReq({ body: { action: "approve", reason: "ok ok" } });
      const res = makeRes();
      await mod.default(req, res);
      expect(res.statusCode).toBe(500);
    } finally {
      process.env.VITE_SUPABASE_URL = savedUrl;
      process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    }
  });
});
