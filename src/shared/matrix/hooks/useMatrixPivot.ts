// src/shared/matrix/hooks/useMatrixPivot.ts
//
// State for which 2 of 5 dims are axes + which values are filtered per
// non-axis dim. Default pivot per arch §5.4: color × size.

import { useCallback, useRef, useState } from "react";
import type { MatrixAxis, MatrixPivotState } from "../types";

const DEFAULT_PIVOT: MatrixPivotState = {
  rowAxis: "color",
  colAxis: "size",
  filters: {},
};

export interface UseMatrixPivotResult {
  pivot: MatrixPivotState;
  setAxes: (rowAxis: MatrixAxis, colAxis: MatrixAxis) => void;
  setFilter: (axis: MatrixAxis, values: string[]) => void;
  clearFilter: (axis: MatrixAxis) => void;
  reset: () => void;
}

/**
 * Pivot state hook. Caller can pass initial state or rely on the default
 * (color × size, no filters). On every change, `onChange` (if supplied) is
 * invoked with the new pivot — used to keep parent state in sync.
 */
export function useMatrixPivot(
  initial?: Partial<MatrixPivotState>,
  onChange?: (next: MatrixPivotState) => void,
): UseMatrixPivotResult {
  const [pivot, setPivot] = useState<MatrixPivotState>(() => mergePivot(DEFAULT_PIVOT, initial));

  // Keep the latest onChange in a ref so the callbacks below don't need to
  // re-create whenever the parent passes a new function identity.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const apply = useCallback((next: MatrixPivotState) => {
    setPivot(next);
    onChangeRef.current?.(next);
  }, []);

  const setAxes = useCallback(
    (rowAxis: MatrixAxis, colAxis: MatrixAxis) => {
      if (rowAxis === colAxis) {
        // Disallow same-axis pivot. Keep current colAxis or fall back to size.
        return;
      }
      // Drop any filter rules for the new axis dims — they're now displayed
      // explicitly via the axis labels, not filtered down.
      setPivot((prev) => {
        const nextFilters = { ...prev.filters };
        delete nextFilters[rowAxis];
        delete nextFilters[colAxis];
        const next = { ...prev, rowAxis, colAxis, filters: nextFilters };
        onChangeRef.current?.(next);
        return next;
      });
    },
    [],
  );

  const setFilter = useCallback(
    (axis: MatrixAxis, values: string[]) => {
      setPivot((prev) => {
        if (axis === prev.rowAxis || axis === prev.colAxis) {
          // Axis dims can't be filtered; ignore.
          return prev;
        }
        const next: MatrixPivotState = {
          ...prev,
          filters: { ...prev.filters, [axis]: values },
        };
        onChangeRef.current?.(next);
        return next;
      });
    },
    [],
  );

  const clearFilter = useCallback((axis: MatrixAxis) => {
    setPivot((prev) => {
      const nextFilters = { ...prev.filters };
      delete nextFilters[axis];
      const next: MatrixPivotState = { ...prev, filters: nextFilters };
      onChangeRef.current?.(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => apply(DEFAULT_PIVOT), [apply]);

  return { pivot, setAxes, setFilter, clearFilter, reset };
}

function mergePivot(base: MatrixPivotState, partial?: Partial<MatrixPivotState>): MatrixPivotState {
  if (!partial) return base;
  return {
    rowAxis: partial.rowAxis ?? base.rowAxis,
    colAxis: partial.colAxis ?? base.colAxis,
    filters: partial.filters ?? base.filters,
  };
}
