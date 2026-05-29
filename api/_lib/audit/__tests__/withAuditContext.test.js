// Tests for api/_lib/audit/withAuditContext.js — the T11-2 JS-side
// audit-context helper.
//
// Mocks supabase-js admin with a thin chain stub. Coverage:
//   • extractActorFromRequest:
//       - no headers → empty actor
//       - non-Bearer header → empty actor
//       - invalid JWT → empty actor
//       - valid JWT + employees row → full actor (full_name)
//       - valid JWT + employees row with first/last only → derived display_name
//       - valid JWT + no employees row → auth_id only
//   • normalizeAuditContext:
//       - happy path
//       - invalid auth_id throws
//       - invalid employee_id throws
//       - invalid source throws
//       - empty strings normalized to null
//   • setAuditSessionVars:
//       - calls the right RPC with the right params
//   • buildAuditRpcParams:
//       - produces audit_* prefix
//   • callWithAudit:
//       - merges operation params + audit_*
//       - calls the right RPC name
//       - rejects bad inputs
//   • requireReason:
//       - returns 400 on VOID/POST/REVERSE without reason
//       - passes on UPDATE/INSERT regardless
//       - passes when reason present
//   • withAuditContext wrapper:
//       - invokes fn with the admin client
//       - calls set_audit_context RPC first

import { describe, it, expect, vi } from "vitest";
import {
  extractActorFromRequest,
  normalizeAuditContext,
  setAuditSessionVars,
  buildAuditRpcParams,
  callWithAudit,
  requireReason,
  withAuditContext,
  AUDIT_SOURCE_VALUES,
} from "../withAuditContext.js";

const AUTH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EMP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BAD_UUID = "not-a-uuid";

/** Build an admin stub that returns the given employees row + getUser id. */
function makeAdmin({
  getUserId = null,
  employee = null,
  rpcResult = { data: null, error: null },
} = {}) {
  const rpcSpy = vi.fn(async () => rpcResult);
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: getUserId ? { id: getUserId } : null } })),
    },
    from(table) {
      if (table !== "employees") throw new Error(`Unexpected table: ${table}`);
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        async maybeSingle() { return { data: employee, error: null }; },
      };
      return chain;
    },
    rpc: rpcSpy,
    _rpcSpy: rpcSpy,
  };
}

function bearerReq(token = "abc.def.ghi", extra = {}) {
  return { headers: { authorization: `Bearer ${token}`, ...extra } };
}

describe("extractActorFromRequest", () => {
  it("returns empty actor when req has no headers", async () => {
    const admin = makeAdmin();
    const a = await extractActorFromRequest({}, admin);
    expect(a).toEqual({ auth_id: null, employee_id: null, display_name: null });
  });

  it("returns empty actor for non-Bearer header", async () => {
    const admin = makeAdmin();
    const a = await extractActorFromRequest(
      { headers: { authorization: "Basic xxx" } },
      admin,
    );
    expect(a).toEqual({ auth_id: null, employee_id: null, display_name: null });
  });

  it("returns empty actor when JWT resolves to no user", async () => {
    const admin = makeAdmin({ getUserId: null });
    const a = await extractActorFromRequest(bearerReq(), admin);
    expect(a).toEqual({ auth_id: null, employee_id: null, display_name: null });
  });

  it("returns full actor with full_name when employees row matches", async () => {
    const admin = makeAdmin({
      getUserId: AUTH_ID,
      employee: { id: EMP_ID, full_name: "Alice Q. Operator" },
    });
    const a = await extractActorFromRequest(bearerReq(), admin);
    expect(a).toEqual({
      auth_id: AUTH_ID,
      employee_id: EMP_ID,
      display_name: "Alice Q. Operator",
    });
  });

  it("falls back to first+last when full_name missing", async () => {
    const admin = makeAdmin({
      getUserId: AUTH_ID,
      employee: {
        id: EMP_ID,
        full_name: null,
        first_name: "Bob",
        last_name: "Bookkeeper",
      },
    });
    const a = await extractActorFromRequest(bearerReq(), admin);
    expect(a.display_name).toBe("Bob Bookkeeper");
  });

  it("falls back to email when no name fields are populated", async () => {
    const admin = makeAdmin({
      getUserId: AUTH_ID,
      employee: { id: EMP_ID, email: "c@d.com" },
    });
    const a = await extractActorFromRequest(bearerReq(), admin);
    expect(a.display_name).toBe("c@d.com");
  });

  it("auth_id only when JWT resolves but no employees row exists", async () => {
    const admin = makeAdmin({ getUserId: AUTH_ID, employee: null });
    const a = await extractActorFromRequest(bearerReq(), admin);
    expect(a).toEqual({
      auth_id: AUTH_ID,
      employee_id: null,
      display_name: null,
    });
  });

  it("swallows getUser errors and returns empty actor", async () => {
    const admin = makeAdmin();
    admin.auth.getUser = vi.fn(async () => { throw new Error("boom"); });
    const a = await extractActorFromRequest(bearerReq(), admin);
    expect(a).toEqual({ auth_id: null, employee_id: null, display_name: null });
  });

  it("reads canonical-case Authorization header", async () => {
    const admin = makeAdmin({ getUserId: AUTH_ID, employee: null });
    const a = await extractActorFromRequest(
      { headers: { Authorization: "Bearer x.y.z" } },
      admin,
    );
    expect(a.auth_id).toBe(AUTH_ID);
  });
});

describe("normalizeAuditContext", () => {
  it("normalizes a happy-path context", () => {
    const out = normalizeAuditContext({
      actor: { auth_id: AUTH_ID, employee_id: EMP_ID, display_name: "Eve" },
      source: "manual",
      reason: "  customer cancelled  ",
      correlation_id: "req-123",
    });
    expect(out).toEqual({
      auth_id: AUTH_ID,
      employee_id: EMP_ID,
      display_name: "Eve",
      source: "manual",
      reason: "customer cancelled",
      correlation_id: "req-123",
    });
  });

  it("throws on invalid auth_id uuid", () => {
    expect(() =>
      normalizeAuditContext({ actor: { auth_id: BAD_UUID } }),
    ).toThrow(/auth_id must be a uuid/);
  });

  it("throws on invalid employee_id uuid", () => {
    expect(() =>
      normalizeAuditContext({ actor: { employee_id: BAD_UUID } }),
    ).toThrow(/employee_id must be a uuid/);
  });

  it("throws on invalid source value", () => {
    expect(() =>
      normalizeAuditContext({ source: "twitter" }),
    ).toThrow(/T10 enum value/);
  });

  it("accepts every documented T10 source", () => {
    for (const s of AUDIT_SOURCE_VALUES) {
      expect(() => normalizeAuditContext({ source: s })).not.toThrow();
    }
  });

  it("returns null reason when reason is whitespace", () => {
    const out = normalizeAuditContext({ reason: "   " });
    expect(out.reason).toBeNull();
  });

  it("throws when ctx is not an object", () => {
    expect(() => normalizeAuditContext(null)).toThrow(/object/);
    expect(() => normalizeAuditContext("hi")).toThrow(/object/);
  });
});

describe("setAuditSessionVars", () => {
  it("calls set_audit_context RPC with normalized params", async () => {
    const admin = makeAdmin();
    await setAuditSessionVars(admin, {
      actor: { auth_id: AUTH_ID, employee_id: EMP_ID, display_name: "Eve" },
      source: "manual",
      reason: "x",
      correlation_id: "c-1",
    });
    expect(admin._rpcSpy).toHaveBeenCalledTimes(1);
    expect(admin._rpcSpy).toHaveBeenCalledWith("set_audit_context", {
      p_actor_auth_id: AUTH_ID,
      p_actor_employee_id: EMP_ID,
      p_actor_display_name: "Eve",
      p_audit_source: "manual",
      p_audit_reason: "x",
      p_audit_correlation_id: "c-1",
    });
  });

  it("propagates RPC errors to the caller", async () => {
    const admin = makeAdmin({ rpcResult: { data: null, error: { message: "denied" } } });
    const r = await setAuditSessionVars(admin, { actor: {} });
    expect(r.error).toEqual({ message: "denied" });
  });
});

describe("buildAuditRpcParams", () => {
  it("returns the audit_* prefix shape", () => {
    const p = buildAuditRpcParams({
      actor: { auth_id: AUTH_ID, employee_id: EMP_ID, display_name: "Eve" },
      source: "manual",
      reason: "r",
      correlation_id: "c-1",
    });
    expect(p).toEqual({
      audit_actor_auth_id: AUTH_ID,
      audit_actor_employee_id: EMP_ID,
      audit_actor_display_name: "Eve",
      audit_source: "manual",
      audit_reason: "r",
      audit_correlation_id: "c-1",
    });
  });
});

describe("callWithAudit", () => {
  it("merges operation params with audit_* prefix and calls the RPC", async () => {
    const admin = makeAdmin();
    await callWithAudit(admin, "void_ar_invoice_with_audit", {
      invoice_id: "11111111-1111-4111-8111-111111111111",
      actor: { auth_id: AUTH_ID, employee_id: EMP_ID, display_name: "Eve" },
      source: "manual",
      reason: "cancel",
      correlation_id: "r-1",
    });
    expect(admin._rpcSpy).toHaveBeenCalledWith("void_ar_invoice_with_audit", {
      invoice_id: "11111111-1111-4111-8111-111111111111",
      audit_actor_auth_id: AUTH_ID,
      audit_actor_employee_id: EMP_ID,
      audit_actor_display_name: "Eve",
      audit_source: "manual",
      audit_reason: "cancel",
      audit_correlation_id: "r-1",
    });
  });

  it("forwards extra operation params (e.g. reversal_je_id) verbatim", async () => {
    const admin = makeAdmin();
    await callWithAudit(admin, "reverse_journal_entry_with_audit", {
      je_id: "j-1",
      reversal_je_id: "j-2",
      actor: {},
      reason: "fix typo",
      source: "manual",
    });
    const [name, params] = admin._rpcSpy.mock.calls[0];
    expect(name).toBe("reverse_journal_entry_with_audit");
    expect(params.je_id).toBe("j-1");
    expect(params.reversal_je_id).toBe("j-2");
    expect(params.audit_reason).toBe("fix typo");
  });

  it("rejects bad rpcName", async () => {
    const admin = makeAdmin();
    await expect(callWithAudit(admin, "", { actor: {} })).rejects.toThrow(/rpcName/);
  });

  it("rejects bad ctx", async () => {
    const admin = makeAdmin();
    await expect(callWithAudit(admin, "x", null)).rejects.toThrow(/ctx/);
  });
});

describe("requireReason", () => {
  it("returns 400 on VOID without reason", () => {
    const r = requireReason("VOID", "");
    expect(r).toEqual({
      status: 400,
      error: expect.stringMatching(/reason is required for VOID/),
    });
  });

  it("returns 400 on POST without reason", () => {
    expect(requireReason("POST", null)).not.toBeNull();
  });

  it("returns 400 on REVERSE without reason", () => {
    expect(requireReason("REVERSE", "   ")).not.toBeNull();
  });

  it("passes on UPDATE regardless", () => {
    expect(requireReason("UPDATE", null)).toBeNull();
  });

  it("passes on INSERT regardless", () => {
    expect(requireReason("INSERT", null)).toBeNull();
  });

  it("passes VOID when reason is present", () => {
    expect(requireReason("VOID", "customer canceled")).toBeNull();
  });

  it("is case-insensitive on the op name", () => {
    expect(requireReason("void", null)).not.toBeNull();
    expect(requireReason("post", "yes")).toBeNull();
  });
});

describe("withAuditContext wrapper", () => {
  it("calls set_audit_context then invokes fn with the same admin", async () => {
    const admin = makeAdmin();
    const fn = vi.fn(async (c) => {
      expect(c).toBe(admin);
      return "result-x";
    });
    const r = await withAuditContext(
      { admin, actor: {}, source: "manual", reason: null, correlation_id: null },
      fn,
    );
    expect(r).toBe("result-x");
    expect(admin._rpcSpy).toHaveBeenCalledWith(
      "set_audit_context",
      expect.objectContaining({ p_audit_source: "manual" }),
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws when admin is missing", async () => {
    await expect(
      withAuditContext({ actor: {} }, async () => {}),
    ).rejects.toThrow(/admin is required/);
  });

  it("throws when fn is not a function", async () => {
    const admin = makeAdmin();
    await expect(
      withAuditContext({ admin, actor: {} }, "not-a-fn"),
    ).rejects.toThrow(/fn must be a function/);
  });
});
