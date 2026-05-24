// @vitest-environment jsdom
// Tests for the useMatrixPivot state hook.

import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMatrixPivot } from "../hooks/useMatrixPivot";

describe("useMatrixPivot", () => {
  it("starts with default color × size, no filters", () => {
    const { result } = renderHook(() => useMatrixPivot());
    expect(result.current.pivot).toEqual({
      rowAxis: "color",
      colAxis: "size",
      filters: {},
    });
  });

  it("accepts initial overrides", () => {
    const { result } = renderHook(() => useMatrixPivot({ rowAxis: "inseam", colAxis: "fit" }));
    expect(result.current.pivot.rowAxis).toBe("inseam");
    expect(result.current.pivot.colAxis).toBe("fit");
  });

  it("setAxes swaps row/col and drops their filters", () => {
    const { result } = renderHook(() => useMatrixPivot({ filters: { inseam: ["30"] } }));
    act(() => result.current.setAxes("inseam", "fit"));
    expect(result.current.pivot.rowAxis).toBe("inseam");
    expect(result.current.pivot.colAxis).toBe("fit");
    expect(result.current.pivot.filters.inseam).toBeUndefined();
  });

  it("setAxes refuses same-axis row+col", () => {
    const { result } = renderHook(() => useMatrixPivot());
    act(() => result.current.setAxes("color", "color"));
    expect(result.current.pivot.rowAxis).toBe("color");
    expect(result.current.pivot.colAxis).toBe("size"); // unchanged
  });

  it("setFilter adds values for non-axis dims", () => {
    const { result } = renderHook(() => useMatrixPivot());
    act(() => result.current.setFilter("inseam", ["30", "32"]));
    expect(result.current.pivot.filters.inseam).toEqual(["30", "32"]);
  });

  it("setFilter no-ops for axis dims", () => {
    const { result } = renderHook(() => useMatrixPivot());
    act(() => result.current.setFilter("color", ["RED"]));
    expect(result.current.pivot.filters.color).toBeUndefined();
  });

  it("clearFilter drops the entry entirely", () => {
    const { result } = renderHook(() => useMatrixPivot({ filters: { inseam: ["30"] } }));
    act(() => result.current.clearFilter("inseam"));
    expect(result.current.pivot.filters.inseam).toBeUndefined();
  });

  it("reset returns to default state", () => {
    const { result } = renderHook(() =>
      useMatrixPivot({ rowAxis: "inseam", colAxis: "length", filters: { fit: ["SLIM"] } }),
    );
    act(() => result.current.reset());
    expect(result.current.pivot).toEqual({ rowAxis: "color", colAxis: "size", filters: {} });
  });

  it("invokes onChange with every state transition", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useMatrixPivot(undefined, onChange));
    act(() => result.current.setAxes("inseam", "fit"));
    act(() => result.current.setFilter("color", ["RED"]));
    act(() => result.current.clearFilter("color"));
    // setAxes fires, setFilter (color is now non-axis after swap) fires, clearFilter fires
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});
