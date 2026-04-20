import { describe, it, expect } from "vitest";
import {
  can,
  canAny,
  canAll,
  requirePermission,
  PermissionDeniedError,
} from "../governance/services/permissionService";
import type { IpUserWithPermissions } from "../governance/types/governance";

function user(perms: Record<string, boolean>): IpUserWithPermissions {
  return {
    user_email: "t@example.com",
    roles: [{ role_name: "test", description: null }],
    permissions: perms as IpUserWithPermissions["permissions"],
  };
}

describe("permission guards", () => {
  it("can() returns true for granted permission", () => {
    expect(can(user({ run_writeback: true }), "run_writeback")).toBe(true);
  });
  it("can() returns false for missing permission", () => {
    expect(can(user({}), "run_writeback")).toBe(false);
  });
  it("canAny() short-circuits on any match", () => {
    const u = user({ read_forecasts: true });
    expect(canAny(u, "run_writeback", "read_forecasts")).toBe(true);
  });
  it("canAll() requires every permission", () => {
    const u = user({ run_writeback: true });
    expect(canAll(u, "run_writeback", "approve_plans")).toBe(false);
  });
  it("requirePermission throws PermissionDeniedError with key + email", () => {
    try {
      requirePermission(user({}), "approve_plans");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PermissionDeniedError);
      if (e instanceof PermissionDeniedError) {
        expect(e.key).toBe("approve_plans");
        expect(e.user_email).toBe("t@example.com");
      }
    }
  });
  it("requirePermission passes silently when granted", () => {
    expect(() => requirePermission(user({ approve_plans: true }), "approve_plans")).not.toThrow();
  });
});
