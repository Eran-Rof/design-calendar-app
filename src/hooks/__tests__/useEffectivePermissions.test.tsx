// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useEffectivePermissions,
  __setPermsForTests,
  __resetPermsCacheForTests,
} from "../useEffectivePermissions";

afterEach(() => __resetPermsCacheForTests());

describe("useEffectivePermissions.can — fail-open + inert-unless-enforce", () => {
  it("shows everything when mode is off (no behavior change)", () => {
    __setPermsForTests("off", []);
    const { result } = renderHook(() => useEffectivePermissions());
    expect(result.current.enforcing).toBe(false);
    expect(result.current.can("coa", "read")).toBe(true);
    expect(result.current.can("je_post", "post")).toBe(true);
  });

  it("shows everything when mode is log (dry-run only)", () => {
    __setPermsForTests("log", []); // empty perms, but log ≠ enforce
    const { result } = renderHook(() => useEffectivePermissions());
    expect(result.current.can("coa", "read")).toBe(true);
  });

  it("hides only unheld permissions when enforcing", () => {
    __setPermsForTests("enforce", ["coa:read", "ar_invoices:read"]);
    const { result } = renderHook(() => useEffectivePermissions());
    expect(result.current.enforcing).toBe(true);
    expect(result.current.can("coa", "read")).toBe(true);
    expect(result.current.can("ap_invoices", "read")).toBe(false);
  });

  it("defaults the action to read", () => {
    __setPermsForTests("enforce", ["coa:read"]);
    const { result } = renderHook(() => useEffectivePermissions());
    expect(result.current.can("coa")).toBe(true);
    expect(result.current.can("ap_invoices")).toBe(false);
  });

  it("always shows unmapped (null moduleKey) items", () => {
    __setPermsForTests("enforce", []);
    const { result } = renderHook(() => useEffectivePermissions());
    expect(result.current.can(null)).toBe(true);
    expect(result.current.can(undefined)).toBe(true);
  });
});
