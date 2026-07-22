// src/shared/matrix/index.ts
//
// Barrel exports for the Matrix React primitive (Tangerine P1 §5.4).

export { MatrixGrid } from "./MatrixGrid";
export { EditableSizeMatrix, matrixCellKey } from "./EditableSizeMatrix";
export type { EditableSizeMatrixProps, EditableMatrixRow } from "./EditableSizeMatrix";
export { computeSizeCollapse } from "./sizeCollapse";
export type { SizeCollapseModel } from "./sizeCollapse";
export {
  MATRIX_HIDE_EMPTY_KEY, MATRIX_TOTALS_ONLY_KEY,
  readHideEmptySizes, readTotalsOnly, useHideEmptySizes, useTotalsOnly,
} from "./matrixPrefs";
export { MatrixTotalsToggle } from "./MatrixTotalsToggle";
export { MatrixCell } from "./MatrixCell";
export { MatrixHeader } from "./MatrixHeader";
export { MatrixPivotControl } from "./MatrixPivotControl";
export { useMatrixPivot } from "./hooks/useMatrixPivot";
export { useMatrixData } from "./hooks/useMatrixData";
export { MATRIX_AXES } from "./types";
export type {
  MatrixAxis,
  MatrixItem,
  MatrixPivotState,
  MatrixCellModel,
  MatrixLayer,
  MatrixGridProps,
  CellFormatter,
} from "./types";
