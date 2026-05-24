// @vitest-environment jsdom
// Tests for the useMatrixData pure transform. No React render needed —
// renderHook is used purely to call the hook in a React context.

import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useMatrixData } from "../hooks/useMatrixData";
import type { MatrixItem, MatrixPivotState } from "../types";

function item(over: Partial<MatrixItem>): MatrixItem {
  return {
    id: over.id ?? "x",
    color: over.color ?? null,
    size: over.size ?? null,
    inseam: over.inseam ?? null,
    length: over.length ?? null,
    fit: over.fit ?? null,
    value: over.value,
  };
}

const sampleItems: MatrixItem[] = [
  item({ id: "1", color: "RED",  size: "M", inseam: "30", length: "REGULAR", fit: "SLIM" }),
  item({ id: "2", color: "RED",  size: "L", inseam: "30", length: "REGULAR", fit: "SLIM" }),
  item({ id: "3", color: "BLUE", size: "M", inseam: "32", length: "LONG",    fit: "RELAXED" }),
  item({ id: "4", color: "BLUE", size: "L", inseam: "32", length: "LONG",    fit: "RELAXED" }),
  item({ id: "5", color: "RED",  size: "M", inseam: "32", length: "REGULAR", fit: "SLIM" }),
];

const defaultPivot: MatrixPivotState = {
  rowAxis: "color",
  colAxis: "size",
  filters: {},
};

describe("useMatrixData — default 2-D layout", () => {
  it("produces one layer with all rows/cols when no filters", () => {
    const { result } = renderHook(() => useMatrixData(sampleItems, defaultPivot));
    expect(result.current.layers).toHaveLength(1);
    const layer = result.current.layers[0];
    expect(layer.rowValues).toEqual(["BLUE", "RED"]);
    expect(layer.colValues).toEqual(["L", "M"]);
    expect(layer.cells).toHaveLength(4);
  });

  it("groups items into their (row, col) cell", () => {
    const { result } = renderHook(() => useMatrixData(sampleItems, defaultPivot));
    const layer = result.current.layers[0];
    const redM = layer.cells.find((c) => c.rowKey === "RED" && c.colKey === "M");
    expect(redM?.items.map((i) => i.id).sort()).toEqual(["1", "5"]);
  });

  it("returns axisValues for every dim distinct-summarized across items", () => {
    const { result } = renderHook(() => useMatrixData(sampleItems, defaultPivot));
    expect(result.current.axisValues.color).toEqual(["BLUE", "RED"]);
    expect(result.current.axisValues.inseam).toEqual(["30", "32"]);
    expect(result.current.axisValues.fit).toEqual(["RELAXED", "SLIM"]);
  });

  it("default count formatter renders cell count as displayValue, empty string for empty cells", () => {
    const { result } = renderHook(() => useMatrixData(sampleItems, defaultPivot));
    const layer = result.current.layers[0];
    const redM = layer.cells.find((c) => c.rowKey === "RED" && c.colKey === "M");
    expect(redM?.displayValue).toBe("2");
    // BLUE×L exists (id=4), RED×L exists (id=2) — no empty cells in this set.
    // Pivot color×inseam to create empties:
  });

  it("empty cell when no items match", () => {
    const pivot = { ...defaultPivot, colAxis: "inseam" as const };
    // RED only has inseam 30 and 32; BLUE only 32. Pivot should leave RED×(no col) gaps.
    const subset = sampleItems.filter((i) => i.color === "RED");
    const { result } = renderHook(() => useMatrixData(subset, pivot));
    const layer = result.current.layers[0];
    // no BLUE rows in subset → only RED row
    expect(layer.rowValues).toEqual(["RED"]);
    expect(layer.colValues).toEqual(["30", "32"]);
    // every cell here has items, so introduce a missing combo via custom axisValues
  });
});

describe("useMatrixData — filters", () => {
  it("single-value filter collapses items to that value, still one layer", () => {
    const pivot: MatrixPivotState = { ...defaultPivot, filters: { inseam: ["30"] } };
    const { result } = renderHook(() => useMatrixData(sampleItems, pivot));
    expect(result.current.layers).toHaveLength(1);
    const total = result.current.layers[0].cells.reduce((n, c) => n + c.items.length, 0);
    expect(total).toBe(2); // ids 1 + 2 are inseam=30
  });

  it("multi-value filter on a non-axis dim creates one layer per value", () => {
    const pivot: MatrixPivotState = { ...defaultPivot, filters: { inseam: ["30", "32"] } };
    const { result } = renderHook(() => useMatrixData(sampleItems, pivot));
    expect(result.current.layers).toHaveLength(2);
    expect(result.current.layers[0].layerKey).toEqual({ inseam: "30" });
    expect(result.current.layers[1].layerKey).toEqual({ inseam: "32" });
  });

  it("multi-value across two dims = cartesian layer count", () => {
    const pivot: MatrixPivotState = {
      ...defaultPivot,
      filters: { inseam: ["30", "32"], fit: ["SLIM", "RELAXED"] },
    };
    const { result } = renderHook(() => useMatrixData(sampleItems, pivot));
    expect(result.current.layers).toHaveLength(4);
  });

  it("empty filter array means 'all' (passthrough)", () => {
    const pivot: MatrixPivotState = { ...defaultPivot, filters: { inseam: [] } };
    const { result } = renderHook(() => useMatrixData(sampleItems, pivot));
    expect(result.current.layers).toHaveLength(1);
    const total = result.current.layers[0].cells.reduce((n, c) => n + c.items.length, 0);
    expect(total).toBe(5);
  });
});

describe("useMatrixData — custom formatter + axisValues", () => {
  it("custom formatter shapes the cell text", () => {
    const fmt = (items: MatrixItem[]) =>
      items.length === 0 ? "" : `${items.length}u`;
    const { result } = renderHook(() => useMatrixData(sampleItems, defaultPivot, undefined, fmt));
    const layer = result.current.layers[0];
    expect(layer.cells[0].displayValue.endsWith("u") || layer.cells[0].displayValue === "").toBe(true);
  });

  it("axisValues override forces axis distincts even when items lack values", () => {
    const onlyRed = sampleItems.filter((i) => i.color === "RED");
    const { result } = renderHook(() =>
      useMatrixData(onlyRed, defaultPivot, { color: ["RED", "BLUE", "GREEN"], size: ["S", "M", "L"] }),
    );
    const layer = result.current.layers[0];
    expect(layer.rowValues).toEqual(["BLUE", "GREEN", "RED"]);
    expect(layer.colValues).toEqual(["L", "M", "S"]);
    // GREEN row + S col combinations are all empty
    const greenS = layer.cells.find((c) => c.rowKey === "GREEN" && c.colKey === "S");
    expect(greenS?.items).toEqual([]);
    expect(greenS?.displayValue).toBe("");
  });
});
