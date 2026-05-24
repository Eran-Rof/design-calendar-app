// src/shared/matrix/index.ts
//
// Barrel exports for the Matrix React primitive (Tangerine P1 §5.4).

export { MatrixGrid } from "./MatrixGrid";
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
