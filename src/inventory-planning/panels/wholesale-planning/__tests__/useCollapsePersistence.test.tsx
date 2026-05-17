// @vitest-environment jsdom
//
// Tests for useCollapsePersistence. Verifies the localStorage write
// happens synchronously inside the setter (not via useEffect) so a
// subsequent unmount mid-write can't drop the change.

import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCollapsePersistence } from "../hooks/useCollapsePersistence";

const KEY = "ws_planning_collapse";

beforeEach(() => {
  localStorage.clear();
});

describe("useCollapsePersistence", () => {
  it("returns the all-false default when localStorage is empty", () => {
    const { result } = renderHook(() => useCollapsePersistence());
    const [collapse] = result.current;
    expect(collapse).toEqual({
      customers: false, colors: false, category: false, subCat: false,
      customerAllStyles: false, allCustomersPerCategory: false,
      allCustomersPerSubCat: false, allCustomersPerStyle: false,
    });
  });

  it("loads from localStorage when present", () => {
    localStorage.setItem(KEY, JSON.stringify({ customers: true, colors: false, category: true }));
    const { result } = renderHook(() => useCollapsePersistence());
    const [collapse] = result.current;
    expect(collapse.customers).toBe(true);
    expect(collapse.category).toBe(true);
    expect(collapse.colors).toBe(false);
    // Missing fields default to false
    expect(collapse.subCat).toBe(false);
  });

  it("setter writes to localStorage synchronously (inspect immediately after)", () => {
    const { result } = renderHook(() => useCollapsePersistence());
    act(() => {
      const [, setCollapse] = result.current;
      setCollapse(c => ({ ...c, customers: true, colors: true }));
    });
    const stored = JSON.parse(localStorage.getItem(KEY) || "{}");
    expect(stored.customers).toBe(true);
    expect(stored.colors).toBe(true);
  });

  it("setter accepts an object value (not just an updater function)", () => {
    const { result } = renderHook(() => useCollapsePersistence());
    act(() => {
      const [, setCollapse] = result.current;
      setCollapse({
        customers: true, colors: false, category: false, subCat: false,
        customerAllStyles: false, allCustomersPerCategory: false,
        allCustomersPerSubCat: false, allCustomersPerStyle: false,
      });
    });
    const [collapse] = result.current;
    expect(collapse.customers).toBe(true);
  });

  it("survives a corrupt JSON in localStorage by falling back to empty", () => {
    localStorage.setItem(KEY, "not valid json {{{");
    const { result } = renderHook(() => useCollapsePersistence());
    const [collapse] = result.current;
    expect(collapse.customers).toBe(false);
  });

  it("ignores non-object stored values + falls back to empty", () => {
    localStorage.setItem(KEY, JSON.stringify("string-not-object"));
    const { result } = renderHook(() => useCollapsePersistence());
    const [collapse] = result.current;
    expect(collapse.customers).toBe(false);
  });
});
