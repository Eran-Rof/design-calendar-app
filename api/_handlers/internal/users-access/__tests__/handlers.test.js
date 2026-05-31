// @vitest-environment node
import { describe, it, expect } from "vitest";
import { validateRoleAssignment } from "../index.js";
import { validateOverride } from "../override.js";

const UUID_A = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";

// Minimal admin stub: only module_keys.select(...).eq(...).maybeSingle() is hit.
function mockAdmin(availableActions) {
  return {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() {
          if (availableActions === null) return { data: null, error: null };
          return { data: { available_actions: availableActions }, error: null };
        },
      };
    },
  };
}

describe("validateRoleAssignment", () => {
  it("requires uuid user_id and role_id", () => {
    expect(validateRoleAssignment({ user_id: "nope", role_id: UUID_B }).error).toMatch(/user_id/);
    expect(validateRoleAssignment({ user_id: UUID_A, role_id: "nope" }).error).toMatch(/role_id/);
  });
  it("accepts a valid pair", () => {
    expect(validateRoleAssignment({ user_id: UUID_A, role_id: UUID_B })).toEqual({
      data: { user_id: UUID_A, role_id: UUID_B },
    });
  });
});

describe("validateOverride", () => {
  const ADMIN = mockAdmin(["read", "write", "post", "void", "export"]);

  it("rejects bad user_id / module_key / action", async () => {
    expect((await validateOverride(ADMIN, { user_id: "x", module_key: "coa", action: "read", allowed: true }, { requireAllowed: true })).error).toMatch(/user_id/);
    expect((await validateOverride(ADMIN, { user_id: UUID_A, module_key: "", action: "read", allowed: true }, { requireAllowed: true })).error).toMatch(/module_key/);
    expect((await validateOverride(ADMIN, { user_id: UUID_A, module_key: "coa", action: "bogus", allowed: true }, { requireAllowed: true })).error).toMatch(/action/);
  });

  it("requires a boolean allowed when granting (PUT)", async () => {
    const r = await validateOverride(ADMIN, { user_id: UUID_A, module_key: "coa", action: "read" }, { requireAllowed: true });
    expect(r.error).toMatch(/allowed/);
  });

  it("does NOT require allowed when deleting", async () => {
    const r = await validateOverride(ADMIN, { user_id: UUID_A, module_key: "coa", action: "read" }, { requireAllowed: false });
    expect(r.error).toBeUndefined();
    expect(r.data).toEqual({ user_id: UUID_A, module_key: "coa", action: "read" });
  });

  it("rejects an action the module does not expose", async () => {
    const readOnly = mockAdmin(["read", "export"]); // e.g. analytics
    const r = await validateOverride(readOnly, { user_id: UUID_A, module_key: "analytics", action: "post", allowed: true }, { requireAllowed: true });
    expect(r.error).toMatch(/does not expose/);
  });

  it("rejects an unknown module", async () => {
    const r = await validateOverride(mockAdmin(null), { user_id: UUID_A, module_key: "nope", action: "read", allowed: true }, { requireAllowed: true });
    expect(r.error).toMatch(/Unknown module/);
  });

  it("accepts a valid grant and trims reason", async () => {
    const r = await validateOverride(ADMIN, { user_id: UUID_A, module_key: "je_post", action: "post", allowed: true, reason: "  temp cover  " }, { requireAllowed: true });
    expect(r.data).toEqual({ user_id: UUID_A, module_key: "je_post", action: "post", allowed: true, reason: "temp cover" });
  });
});
