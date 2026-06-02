// Tests for gl-periods/:id/reopen (P5-1).
// Pure helper — full DB integration happens via deploy smoke.

import { describe, it, expect } from "vitest";
import { validateBody } from "../../_handlers/internal/gl-periods/reopen.js";

describe("reopen.validateBody", () => {
  const UUID = "550e8400-e29b-41d4-a716-446655440000";

  it("rejects non-object", () => {
    expect(validateBody(null).error).toMatch(/object/);
    expect(validateBody(42).error).toMatch(/object/);
  });
  it("rejects missing actor_user_id", () => {
    expect(validateBody({ reason: "x" }).error).toMatch(/actor_user_id/);
  });
  it("rejects non-UUID actor_user_id", () => {
    expect(validateBody({ actor_user_id: "not-a-uuid", reason: "x" }).error).toMatch(/actor_user_id/);
  });
  it("rejects missing reason", () => {
    expect(validateBody({ actor_user_id: UUID }).error).toMatch(/reason/);
  });
  it("rejects whitespace-only reason", () => {
    expect(validateBody({ actor_user_id: UUID, reason: "   " }).error).toMatch(/reason/);
  });
  it("rejects reason > 500 chars", () => {
    expect(validateBody({ actor_user_id: UUID, reason: "x".repeat(501) }).error).toMatch(/<= 500/);
  });
  it("accepts valid minimum input + trims reason", () => {
    const v = validateBody({ actor_user_id: UUID, reason: "  late correction needed  " });
    expect(v.error).toBeUndefined();
    expect(v.data.actor_user_id).toBe(UUID);
    expect(v.data.reason).toBe("late correction needed");
  });
});
