// Tests for gl-periods/:id/close (P5-1).
// Pure helpers — full DB integration happens via deploy smoke.

import { describe, it, expect } from "vitest";
import {
  validateBody,
  transitionAllowed,
} from "../../_handlers/internal/gl-periods/close.js";

describe("close.validateBody", () => {
  it("rejects non-object body", () => {
    expect(validateBody(null).error).toMatch(/object/);
    expect(validateBody("hello").error).toMatch(/object/);
  });
  it("rejects missing target_status", () => {
    expect(validateBody({}).error).toMatch(/target_status/);
  });
  it("rejects invalid target_status", () => {
    expect(validateBody({ target_status: "open" }).error).toMatch(/target_status/);
    expect(validateBody({ target_status: "closed_with_closing_jes" }).error).toMatch(/target_status/);
    expect(validateBody({ target_status: "" }).error).toMatch(/target_status/);
  });
  it("accepts target_status=soft_close", () => {
    const v = validateBody({ target_status: "soft_close" });
    expect(v.error).toBeUndefined();
    expect(v.data.target_status).toBe("soft_close");
    expect(v.data.actor_user_id).toBeNull();
    expect(v.data.reason).toBeNull();
  });
  it("accepts target_status=closed", () => {
    const v = validateBody({ target_status: "closed" });
    expect(v.error).toBeUndefined();
  });
  it("rejects malformed actor_user_id", () => {
    expect(validateBody({ target_status: "closed", actor_user_id: "abc" }).error).toMatch(/actor_user_id/);
  });
  it("accepts valid actor_user_id UUID", () => {
    const v = validateBody({ target_status: "closed", actor_user_id: "550e8400-e29b-41d4-a716-446655440000" });
    expect(v.error).toBeUndefined();
    expect(v.data.actor_user_id).toBe("550e8400-e29b-41d4-a716-446655440000");
  });
  it("treats empty-string actor_user_id as null", () => {
    const v = validateBody({ target_status: "closed", actor_user_id: "" });
    expect(v.error).toBeUndefined();
    expect(v.data.actor_user_id).toBeNull();
  });
  it("trims reason; treats whitespace-only as null", () => {
    expect(validateBody({ target_status: "closed", reason: "  " }).data.reason).toBeNull();
    expect(validateBody({ target_status: "closed", reason: "  end of month  " }).data.reason).toBe("end of month");
  });
  it("rejects reason > 500 chars", () => {
    expect(validateBody({ target_status: "closed", reason: "x".repeat(501) }).error).toMatch(/<= 500/);
  });
  it("flags ignore_warnings=true", () => {
    expect(validateBody({ target_status: "closed", ignore_warnings: true }).data.ignore_warnings).toBe(true);
    expect(validateBody({ target_status: "closed", ignore_warnings: false }).data.ignore_warnings).toBe(false);
    expect(validateBody({ target_status: "closed" }).data.ignore_warnings).toBe(false);
  });
});

describe("transitionAllowed", () => {
  it("open → soft_close", () => {
    expect(transitionAllowed("open", "soft_close")).toBe(true);
  });
  it("soft_close → soft_close (idempotent same-status)", () => {
    expect(transitionAllowed("soft_close", "soft_close")).toBe(true);
  });
  it("soft_close → closed", () => {
    expect(transitionAllowed("soft_close", "closed")).toBe(true);
  });
  it("closed → closed (idempotent)", () => {
    expect(transitionAllowed("closed", "closed")).toBe(true);
  });
  it("open → closed (must go through soft_close first)", () => {
    expect(transitionAllowed("open", "closed")).toBe(false);
  });
  it("closed → soft_close (use reopen.js, not close.js)", () => {
    expect(transitionAllowed("closed", "soft_close")).toBe(false);
  });
  it("soft_close → open (use reopen.js)", () => {
    expect(transitionAllowed("soft_close", "open")).toBe(false);
  });
  it("closed_with_closing_jes → anything via close.js — never", () => {
    expect(transitionAllowed("closed_with_closing_jes", "soft_close")).toBe(false);
    expect(transitionAllowed("closed_with_closing_jes", "closed")).toBe(false);
  });
  it("unknown source status returns false", () => {
    expect(transitionAllowed("frozen", "closed")).toBe(false);
  });
});
