// Memoized per-column width map for the wholesale planning grid.
// Re-derives whenever displayRows changes: scans the rows once
// (computeContentLengths) then runs each column key through
// computeColumnWidth (which applies the per-column floor/cap).
//
// Lives as a hook (not a pure helper) only because the result is
// memoized — the underlying compute functions stay pure + are
// independently tested.

import { useMemo } from "react";
import type { IpPlanningGridRow } from "../../../types/wholesale";
import { computeContentLengths } from "../computeContentLengths";
import { computeColumnWidth } from "../computeColumnWidth";
import { COLUMN_LABEL } from "../columns";

export function useDynamicColWidths(
  displayRows: IpPlanningGridRow[],
): Record<string, number> {
  return useMemo(() => {
    const lenByCol = computeContentLengths(displayRows);
    const widths: Record<string, number> = {};
    for (const k of Object.keys(COLUMN_LABEL)) {
      widths[k] = computeColumnWidth(k, lenByCol[k]);
    }
    return widths;
  }, [displayRows]);
}
