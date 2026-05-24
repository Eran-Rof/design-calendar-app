// src/shared/matrix/hooks/useMatrixData.ts
//
// Pure transform: (items, pivot, axisValues?, formatter?) → MatrixLayer[].
//
// Output rules per arch §5.4:
//   - One layer when all non-axis dims have ≤1 active filter value.
//   - Layered tabs when at least one non-axis dim has >1 active filter value.
//     A grid renders for each combination of multi-value filters.
//   - Empty cells (no items match) still appear in the layer with an empty
//     displayValue — caller renders a dash.

import { useMemo } from "react";
import { MATRIX_AXES } from "../types";
import type {
  CellFormatter,
  MatrixAxis,
  MatrixCellModel,
  MatrixItem,
  MatrixLayer,
  MatrixPivotState,
} from "../types";

const DEFAULT_FORMATTER: CellFormatter = (items) => (items.length === 0 ? "" : String(items.length));

export interface UseMatrixDataResult {
  layers: MatrixLayer[];
  /** Distinct values per dim across the WHOLE item set (not filtered). For chip choices. */
  axisValues: Record<MatrixAxis, string[]>;
}

export function useMatrixData(
  items: MatrixItem[],
  pivot: MatrixPivotState,
  axisValuesProp?: Partial<Record<MatrixAxis, string[]>>,
  formatter: CellFormatter = DEFAULT_FORMATTER,
): UseMatrixDataResult {
  return useMemo(() => {
    const distinctsPerAxis = computeDistincts(items, axisValuesProp);
    const layerCombinations = computeLayerCombinations(distinctsPerAxis, pivot);
    const layers = layerCombinations.map((layerKey) =>
      buildLayer(items, pivot, distinctsPerAxis, layerKey, formatter),
    );
    return { layers, axisValues: distinctsPerAxis };
  }, [items, pivot, axisValuesProp, formatter]);
}

function computeDistincts(
  items: MatrixItem[],
  override?: Partial<Record<MatrixAxis, string[]>>,
): Record<MatrixAxis, string[]> {
  const out: Record<MatrixAxis, string[]> = {} as Record<MatrixAxis, string[]>;
  for (const axis of MATRIX_AXES) {
    if (override?.[axis]) {
      out[axis] = [...new Set(override[axis] ?? [])].sort();
      continue;
    }
    const seen = new Set<string>();
    for (const it of items) {
      const v = it[axis];
      if (v != null && v !== "") seen.add(String(v));
    }
    out[axis] = [...seen].sort();
  }
  return out;
}

/**
 * Compute the cartesian product of filter values for non-axis dims that have
 * MULTIPLE active values. A dim with 0 or 1 active value contributes nothing
 * to the layering — it's collapsed into the single result layer.
 */
function computeLayerCombinations(
  distinctsPerAxis: Record<MatrixAxis, string[]>,
  pivot: MatrixPivotState,
): Array<Partial<Record<MatrixAxis, string>>> {
  const layerAxes: Array<{ axis: MatrixAxis; values: string[] }> = [];

  for (const axis of MATRIX_AXES) {
    if (axis === pivot.rowAxis || axis === pivot.colAxis) continue;
    const filter = pivot.filters[axis];
    if (filter && filter.length > 1) {
      layerAxes.push({ axis, values: filter });
    }
  }

  if (layerAxes.length === 0) return [{}];

  // Cartesian product
  let combos: Array<Partial<Record<MatrixAxis, string>>> = [{}];
  for (const { axis, values } of layerAxes) {
    const next: Array<Partial<Record<MatrixAxis, string>>> = [];
    for (const base of combos) {
      for (const v of values) {
        next.push({ ...base, [axis]: v });
      }
    }
    combos = next;
  }
  return combos;
}

function buildLayer(
  items: MatrixItem[],
  pivot: MatrixPivotState,
  distinctsPerAxis: Record<MatrixAxis, string[]>,
  layerKey: Partial<Record<MatrixAxis, string>>,
  formatter: CellFormatter,
): MatrixLayer {
  // Filter items to: (a) match layerKey exactly on layer axes,
  //                  (b) match single-value filters,
  //                  (c) match "all" (empty filter) on remaining non-axis dims.
  const matched = items.filter((it) => {
    for (const axis of MATRIX_AXES) {
      if (axis === pivot.rowAxis || axis === pivot.colAxis) continue;
      const v = it[axis] == null ? "" : String(it[axis]);

      // Layer key constrains exactly:
      if (axis in layerKey) {
        if (v !== layerKey[axis]) return false;
        continue;
      }

      // Active filter on this axis (single value or "all"):
      const f = pivot.filters[axis];
      if (f && f.length === 1 && v !== f[0]) return false;
      // f undefined OR f.length===0 → "all", pass through
    }
    return true;
  });

  const rowValues = distinctsPerAxis[pivot.rowAxis];
  const colValues = distinctsPerAxis[pivot.colAxis];

  const cells: MatrixCellModel[] = [];
  for (const rowKey of rowValues) {
    for (const colKey of colValues) {
      const cellItems = matched.filter(
        (it) => String(it[pivot.rowAxis] ?? "") === rowKey
             && String(it[pivot.colAxis] ?? "") === colKey,
      );
      cells.push({
        rowKey,
        colKey,
        items: cellItems,
        displayValue: formatter(cellItems),
      });
    }
  }

  return { layerKey, rowValues, colValues, cells };
}
