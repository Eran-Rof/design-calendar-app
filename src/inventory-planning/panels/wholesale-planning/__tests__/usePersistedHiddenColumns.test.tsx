// @vitest-environment jsdom
//
// Tests for usePersistedHiddenColumns. Same shape as the collapse
// hook: synchronous-write setter + load from localStorage on mount.

import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePersistedHiddenColumns } from "../hooks/usePersistedHiddenColumns";

const KEY = "ws_planning_hidden_columns";

beforeEach(() => {
  localStorage.clear();
});

describe("usePersistedHiddenColumns", () => {
  it("returns an empty Set when localStorage is empty", () => {
    const { result } = renderHook(() => usePersistedHiddenColumns());
    expect(result.current.hiddenColumns.size).toBe(0);
  });

  it("loads from localStorage when present", () => {
    localStorage.setItem(KEY, JSON.stringify(["subCat", "histLY"]));
    const { result } = renderHook(() => usePersistedHiddenColumns());
    expect(result.current.hiddenColumns.has("subCat")).toBe(true);
    expect(result.current.hiddenColumns.has("histLY")).toBe(true);
    expect(result.current.hiddenColumns.has("style")).toBe(false);
  });

  it("toggleColumn adds when not present + writes to localStorage", () => {
    const { result } = renderHook(() => usePersistedHiddenColumns());
    act(() => { result.current.toggleColumn("subCat"); });
    expect(result.current.hiddenColumns.has("subCat")).toBe(true);
    const stored = JSON.parse(localStorage.getItem(KEY) || "[]");
    expect(stored).toContain("subCat");
  });

  it("toggleColumn removes when present + updates localStorage", () => {
    localStorage.setItem(KEY, JSON.stringify(["subCat", "histLY"]));
    const { result } = renderHook(() => usePersistedHiddenColumns());
    act(() => { result.current.toggleColumn("subCat"); });
    expect(result.current.hiddenColumns.has("subCat")).toBe(false);
    expect(result.current.hiddenColumns.has("histLY")).toBe(true);
    const stored = JSON.parse(localStorage.getItem(KEY) || "[]");
    expect(stored).not.toContain("subCat");
    expect(stored).toContain("histLY");
  });

  it("resetColumns empties the set + removes the localStorage entry", () => {
    localStorage.setItem(KEY, JSON.stringify(["subCat"]));
    const { result } = renderHook(() => usePersistedHiddenColumns());
    act(() => { result.current.resetColumns(); });
    expect(result.current.hiddenColumns.size).toBe(0);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("survives a corrupt JSON in localStorage by returning empty", () => {
    localStorage.setItem(KEY, "{{{ broken");
    const { result } = renderHook(() => usePersistedHiddenColumns());
    expect(result.current.hiddenColumns.size).toBe(0);
  });

  it("survives a non-array JSON in localStorage", () => {
    localStorage.setItem(KEY, JSON.stringify({ subCat: true }));
    const { result } = renderHook(() => usePersistedHiddenColumns());
    expect(result.current.hiddenColumns.size).toBe(0);
  });
});
