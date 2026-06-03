// Tests for the vendor onboarding step handler — specifically the
// "I currently do not have any" skip affordance on the Compliance Docs
// step (api/_handlers/vendor/onboarding/steps/[step_name].js).
//
// The handler:
//   • bypasses the required-docs validation when body.skip === true
//   • upserts the step with status='skipped' and the given skip_reason
//   • persists skip_reason: null when the body omits it but still skip-flags
//   • still enforces the required-docs validation when skip is false / omitted
//
// We mock @supabase/supabase-js so we never touch a real DB. The mock
// admin records every from()/upsert()/update() so the assertions can
// inspect exactly what the handler tried to write.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockState = vi.hoisted(() => ({ admin: null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => mockState.admin,
}));

// Imports AFTER vi.mock so the handler picks up the mocked createClient.
const {
  default: handler,
  validateStep,
  buildStepUpsert,
  ALL_STEPS,
} = await import("../../_handlers/vendor/onboarding/steps/[step_name].js");

// ─── helpers ──────────────────────────────────────────────────────────────

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
  stepName = "compliance_docs",
  body = {},
  bearer = "jwt-vendor-a",
} = {}) {
  return {
    method: "PUT",
    url: `/api/vendor/onboarding/steps/${stepName}`,
    query: { step_name: stepName },
    body,
    headers: {
      host: "localhost",
      authorization: bearer ? `Bearer ${bearer}` : undefined,
    },
  };
}

// Mock supabase admin client. Returns a chainable builder for each table
// and records every upsert/update on a `calls` log we expose for assertions.
function buildAdmin({
  vendorIdForJwt = "vendor-A",
  workflow = {
    id: "wf-A",
    vendor_id: "vendor-A",
    status: "in_progress",
    current_step: 3,
    completed_steps: ["company_info", "banking", "tax"],
    started_at: "2026-05-01T00:00:00Z",
  },
  // For compliance_docs validation:
  requiredDocTypes = [{ id: "type-1" }, { id: "type-2" }],
  uploadedDocs = [], // [{ document_type_id, status, uploaded_at }]
} = {}) {
  const calls = { upserts: [], updates: [], inserts: [] };

  function buildBuilder(table) {
    const state = { filters: [] };
    const fluent = {
      select() { return fluent; },
      eq(col, val) { state.filters.push([col, val]); return fluent; },
      // Terminal: maybeSingle returns the first match against state.filters.
      async maybeSingle() {
        if (table === "vendor_users") {
          // resolveVendor → look up the vendor_users row for this auth_id.
          return { data: { id: "vu-a", vendor_id: vendorIdForJwt, role: "primary", auth_id: "auth-a" }, error: null };
        }
        if (table === "onboarding_workflows") {
          return { data: workflow, error: null };
        }
        if (table === "banking_details") {
          return { data: { id: "bd-A" }, error: null };
        }
        return { data: null, error: null };
      },
      // Terminal "list" for compliance_documents / compliance_document_types.
      // The handler awaits these directly — `then` makes the chain awaitable.
      then(onFulfilled, onRejected) {
        let data = null;
        if (table === "compliance_document_types") data = requiredDocTypes;
        if (table === "compliance_documents") data = uploadedDocs;
        return Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
      },
      upsert(row, opts) {
        calls.upserts.push({ table, row, opts });
        return Promise.resolve({ data: null, error: null });
      },
      update(patch) {
        const upd = { table, patch, filters: [] };
        calls.updates.push(upd);
        const updChain = {
          eq(col, val) { upd.filters.push([col, val]); return updChain; },
          then(fn) { return Promise.resolve({ data: null, error: null }).then(fn); },
        };
        return updChain;
      },
      insert(row) {
        calls.inserts.push({ table, row });
        return Promise.resolve({ data: null, error: null });
      },
    };
    return fluent;
  }

  const admin = {
    auth: {
      async getUser(token) {
        if (token === "jwt-vendor-a") return { data: { user: { id: "auth-a", email: "a@vendor.com" } }, error: null };
        return { data: null, error: { message: "invalid" } };
      },
    },
    from(table) { return buildBuilder(table); },
    _calls: calls,
  };
  return admin;
}

beforeEach(() => {
  mockState.admin = null;
  process.env.VITE_SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-key";
});

// ─── buildStepUpsert (pure) ───────────────────────────────────────────────

describe("buildStepUpsert", () => {
  it("marks the row complete and clears skip_reason when not skipping", () => {
    const row = buildStepUpsert({
      workflowId: "wf-1",
      stepName: "compliance_docs",
      stepData: { acknowledged: true },
      skip: false,
      skipReason: "no_docs", // ignored when skip is false
      nowIso: "2026-06-02T12:00:00Z",
    });
    expect(row.status).toBe("complete");
    expect(row.skip_reason).toBeNull();
    expect(row.data).toEqual({ acknowledged: true });
    expect(row.completed_at).toBe("2026-06-02T12:00:00Z");
  });

  it("marks the row skipped and persists skip_reason when skipping", () => {
    const row = buildStepUpsert({
      workflowId: "wf-1",
      stepName: "compliance_docs",
      stepData: null,
      skip: true,
      skipReason: "no_docs",
      nowIso: "2026-06-02T12:00:00Z",
    });
    expect(row.status).toBe("skipped");
    expect(row.skip_reason).toBe("no_docs");
  });

  it("defaults skip_reason to null when skipping without an explicit reason", () => {
    const row = buildStepUpsert({
      workflowId: "wf-1",
      stepName: "compliance_docs",
      stepData: null,
      skip: true,
      skipReason: undefined,
      nowIso: "2026-06-02T12:00:00Z",
    });
    expect(row.status).toBe("skipped");
    expect(row.skip_reason).toBeNull();
  });
});

// ─── validateStep (pure-ish — needs admin only for compliance_docs/banking) ──

describe("validateStep — compliance_docs", () => {
  it("returns an error when required docs are missing (no skip path)", async () => {
    const admin = buildAdmin({
      requiredDocTypes: [{ id: "type-1" }, { id: "type-2" }],
      uploadedDocs: [], // nothing uploaded
    });
    const err = await validateStep(admin, "vendor-A", "compliance_docs", {});
    expect(err).toMatch(/compliance document\(s\) still need to be uploaded/);
  });

  it("returns null when all required docs are submitted", async () => {
    const admin = buildAdmin({
      requiredDocTypes: [{ id: "type-1" }, { id: "type-2" }],
      uploadedDocs: [
        { document_type_id: "type-1", status: "submitted", uploaded_at: "2026-06-01T00:00:00Z" },
        { document_type_id: "type-2", status: "approved", uploaded_at: "2026-06-01T00:00:00Z" },
      ],
    });
    const err = await validateStep(admin, "vendor-A", "compliance_docs", {});
    expect(err).toBeNull();
  });
});

// ─── handler — Compliance Docs skip path ──────────────────────────────────

describe("PUT /api/vendor/onboarding/steps/compliance_docs — skip flow", () => {
  it("succeeds with skip:true even when no docs are uploaded, marks skipped, persists skip_reason", async () => {
    mockState.admin = buildAdmin({ uploadedDocs: [] /* no docs at all */ });
    const req = makeReq({ body: { skip: true, skip_reason: "no_docs" } });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.step).toBe("compliance_docs");

    const stepUpsert = mockState.admin._calls.upserts.find((u) => u.table === "onboarding_steps");
    expect(stepUpsert).toBeTruthy();
    expect(stepUpsert.row.status).toBe("skipped");
    expect(stepUpsert.row.skip_reason).toBe("no_docs");
    expect(stepUpsert.row.workflow_id).toBe("wf-A");
    expect(stepUpsert.row.step_name).toBe("compliance_docs");
  });

  it("succeeds with skip:true even when skip_reason is omitted; stores null reason", async () => {
    mockState.admin = buildAdmin({ uploadedDocs: [] });
    const req = makeReq({ body: { skip: true } });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const stepUpsert = mockState.admin._calls.upserts.find((u) => u.table === "onboarding_steps");
    expect(stepUpsert.row.status).toBe("skipped");
    expect(stepUpsert.row.skip_reason).toBeNull();
  });

  it("rejects with 400 when skip is omitted and required docs are missing (regression guard)", async () => {
    mockState.admin = buildAdmin({
      requiredDocTypes: [{ id: "type-1" }, { id: "type-2" }],
      uploadedDocs: [],
    });
    const req = makeReq({ body: { data: { acknowledged: true } } });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/compliance document\(s\) still need to be uploaded/);
    expect(mockState.admin._calls.upserts).toHaveLength(0);
  });

  it("rejects with 400 when skip is explicitly false and required docs are missing", async () => {
    mockState.admin = buildAdmin({
      requiredDocTypes: [{ id: "type-1" }, { id: "type-2" }],
      uploadedDocs: [],
    });
    const req = makeReq({ body: { skip: false, data: { acknowledged: true } } });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/compliance document\(s\) still need to be uploaded/);
  });

  it("advances current_step and adds compliance_docs to completed_steps after skip", async () => {
    mockState.admin = buildAdmin({ uploadedDocs: [] });
    const req = makeReq({ body: { skip: true, skip_reason: "no_docs" } });
    const res = makeRes();
    await handler(req, res);

    const wfUpdate = mockState.admin._calls.updates.find((u) => u.table === "onboarding_workflows");
    expect(wfUpdate).toBeTruthy();
    expect(wfUpdate.patch.current_step).toBe(4); // compliance_docs is idx 3, next = 4
    expect(wfUpdate.patch.completed_steps).toContain("compliance_docs");
  });
});

// ─── ALL_STEPS export sanity ──────────────────────────────────────────────

describe("ALL_STEPS", () => {
  it("includes compliance_docs at the expected position", () => {
    expect(ALL_STEPS).toEqual(["company_info", "banking", "tax", "compliance_docs", "portal_tour", "agreement"]);
  });
});
