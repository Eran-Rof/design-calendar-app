// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useCanSeeMargins } from "../useCanSeeMargins";
import {
  __setPermsForTests,
  __resetPermsCacheForTests,
} from "../useEffectivePermissions";

afterEach(() => __resetPermsCacheForTests());

describe("useCanSeeMargins — margin visibility gate", () => {
  it("fails open (margins visible) when RBAC mode is off — no behavior change today", () => {
    __setPermsForTests("off", []); // no margins grant, but off → inert
    const { result } = renderHook(() => useCanSeeMargins());
    expect(result.current.canView).toBe(true);
    expect(result.current.canExport).toBe(true);
  });

  it("fails open in log (dry-run) mode", () => {
    __setPermsForTests("log", []);
    const { result } = renderHook(() => useCanSeeMargins());
    expect(result.current.canView).toBe(true);
    expect(result.current.canExport).toBe(true);
  });

  it("hides margins under enforce when the caller lacks the grant", () => {
    __setPermsForTests("enforce", ["coa:read"]); // has other perms, not margins
    const { result } = renderHook(() => useCanSeeMargins());
    expect(result.current.canView).toBe(false);
    expect(result.current.canExport).toBe(false);
  });

  it("shows margins under enforce when granted margins:read", () => {
    __setPermsForTests("enforce", ["margins:read"]);
    const { result } = renderHook(() => useCanSeeMargins());
    expect(result.current.canView).toBe(true);
    expect(result.current.canExport).toBe(false); // read but not export
  });

  it("allows export only when granted margins:export", () => {
    __setPermsForTests("enforce", ["margins:read", "margins:export"]);
    const { result } = renderHook(() => useCanSeeMargins());
    expect(result.current.canView).toBe(true);
    expect(result.current.canExport).toBe(true);
  });
});
