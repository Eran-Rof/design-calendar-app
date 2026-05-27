// Tests for the P2-2 approval handler validation helpers. Pure-JS - focused
// on the validate* paths; the actual DB-side flows are exercised by the
// P2-1 lifecycle tests + the integration smoke after merge.

import { describe, it, expect } from "vitest";
import { validateInsert } from "../../_handlers/internal/approval-rules/index.js";
import { validatePatch } from "../../_handlers/internal/approval-rules/[id].js";
import { validateBody } from "../../_handlers/internal/approval-requests/decide.js";

const UUID = "00000000-0000-0000-0000-000000000001";
const UUID_B = "00000000-0000-0000-0000-000000000002";

describe("approval-rules validateInsert", () => {
  it("rejects missing kind", () => {
    expect(validateInsert({
      name: "x", match: {},
      steps: [{ step_order: 1, mode: "any", role_required: "admin" }],
    }).error).toMatch(/kind/);
  });

  it("rejects missing name", () => {
    expect(validateInsert({
      kind: "ap_invoice", match: {},
      steps: [{ step_order: 1, mode: "any", role_required: "admin" }],
    }).error).toMatch(/name/);
  });

  it("rejects bad match operator", () => {
    expect(validateInsert({
      kind: "ap_invoice", name: "x", match: { foo: 1 },
      steps: [{ step_order: 1, mode: "any", role_required: "admin" }],
    }).error).toMatch(/foo/);
  });

  it("rejects missing steps", () => {
    expect(validateInsert({ kind: "ap_invoice", name: "x", match: {} }).error).toMatch(/steps/);
  });

  it("rejects empty steps", () => {
    expect(validateInsert({ kind: "ap_invoice", name: "x", match: {}, steps: [] }).error).toMatch(/steps/);
  });

  it("rejects invalid role in step", () => {
    expect(validateInsert({
      kind: "ap_invoice", name: "x", match: {},
      steps: [{ step_order: 1, mode: "any", role_required: "cfo" }],
    }).error).toMatch(/role_required/);
  });

  it("defaults match to empty object when omitted", () => {
    const v = validateInsert({
      kind: "ap_invoice", name: "x",
      steps: [{ step_order: 1, mode: "any", role_required: "admin" }],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.match).toEqual({});
  });

  it("accepts valid full rule", () => {
    const v = validateInsert({
      kind: "ap_invoice", name: "> $5k",
      match: { min_amount_cents: 500000 },
      steps: [{ step_order: 1, mode: "any", role_required: "admin" }],
      is_active: true,
    });
    expect(v.error).toBeUndefined();
    expect(v.data.kind).toBe("ap_invoice");
    expect(v.data.is_active).toBe(true);
  });

  it("defaults is_active to true", () => {
    const v = validateInsert({
      kind: "ap_invoice", name: "x", match: {},
      steps: [{ step_order: 1, mode: "any", role_required: "admin" }],
    });
    expect(v.data.is_active).toBe(true);
  });

  it("respects is_active=false explicit", () => {
    const v = validateInsert({
      kind: "ap_invoice", name: "x", match: {},
      steps: [{ step_order: 1, mode: "any", role_required: "admin" }],
      is_active: false,
    });
    expect(v.data.is_active).toBe(false);
  });
});

describe("approval-rules validatePatch", () => {
  it("rejects kind change (locked)", () => {
    expect(validatePatch({ kind: "po_release" }).error).toMatch(/kind/);
  });

  it("rejects entity_id change (locked)", () => {
    expect(validatePatch({ entity_id: UUID }).error).toMatch(/entity_id/);
  });

  it("accepts name change", () => {
    expect(validatePatch({ name: "renamed" }).data.name).toBe("renamed");
  });

  it("rejects empty name", () => {
    expect(validatePatch({ name: "" }).error).toMatch(/name/);
  });

  it("accepts is_active toggle", () => {
    expect(validatePatch({ is_active: false }).data.is_active).toBe(false);
  });

  it("rejects non-boolean is_active", () => {
    expect(validatePatch({ is_active: "yes" }).error).toMatch(/is_active/);
  });

  it("accepts steps change", () => {
    const v = validatePatch({
      steps: [{ step_order: 1, mode: "all", role_required: "accountant" }],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.steps).toHaveLength(1);
  });

  it("accepts match change", () => {
    expect(validatePatch({ match: { vendor_new: true } }).data.match).toEqual({ vendor_new: true });
  });

  it("rejects invalid match", () => {
    expect(validatePatch({ match: { widgets: 1 } }).error).toMatch(/widgets/);
  });

  it("empty patch returns empty data", () => {
    const v = validatePatch({});
    expect(v.error).toBeUndefined();
    expect(Object.keys(v.data)).toHaveLength(0);
  });
});

describe("approval-requests/decide validateBody", () => {
  it("rejects missing step_id", () => {
    expect(validateBody({ decision: "approve", actor_user_id: UUID }).error).toMatch(/step_id/);
  });

  it("rejects non-uuid step_id", () => {
    expect(validateBody({ step_id: "abc", decision: "approve", actor_user_id: UUID }).error).toMatch(/uuid/);
  });

  it("rejects bad decision", () => {
    expect(validateBody({ step_id: UUID, decision: "yep", actor_user_id: UUID_B }).error).toMatch(/decision/);
  });

  it("rejects missing actor", () => {
    expect(validateBody({ step_id: UUID, decision: "approve" }).error).toMatch(/actor_user_id/);
  });

  it("accepts approve", () => {
    const v = validateBody({ step_id: UUID, decision: "approve", actor_user_id: UUID_B });
    expect(v.error).toBeUndefined();
    expect(v.data.decision).toBe("approve");
  });

  it("accepts reject", () => {
    expect(validateBody({ step_id: UUID, decision: "reject", actor_user_id: UUID_B }).data.decision).toBe("reject");
  });

  it("accepts request_changes", () => {
    expect(validateBody({ step_id: UUID, decision: "request_changes", actor_user_id: UUID_B }).data.decision).toBe("request_changes");
  });

  it("trims notes", () => {
    const v = validateBody({ step_id: UUID, decision: "approve", actor_user_id: UUID_B, notes: "  hello  " });
    expect(v.data.notes).toBe("hello");
  });

  it("notes null when omitted", () => {
    expect(validateBody({ step_id: UUID, decision: "approve", actor_user_id: UUID_B }).data.notes).toBeNull();
  });
});
