// src/shared/matrix/types.ts
//
// Type definitions for the Matrix React primitive — a generic 2..6-D grid
// for apparel SKU variants (color × size × inseam × length × fit × rise).
// Default view is 2-D (color × size); pivot control lets the user choose any
// 2 of 6 dims as axes and the remaining 4 become filter chips.
//
// Tangerine P1 — see docs/tangerine/P1-foundation-architecture.md §5.4.

/** The six matrix dimensions per arch §5.2 (rise added for denim HIGH/MID/LOW). */
export const MATRIX_AXES = ["color", "size", "inseam", "length", "fit", "rise"] as const;
export type MatrixAxis = (typeof MATRIX_AXES)[number];

/**
 * An item placed in the matrix. Typically a SKU; can be any object that has
 * the 5 dim values. `value` is what renders in the cell (qty, cost, etc.) —
 * leave null for a presence-only grid.
 */
export interface MatrixItem {
  id: string;
  color: string | null;
  size: string | null;
  inseam: string | null;
  length: string | null;
  fit: string | null;
  rise: string | null;
  value?: number | string | null;
}

/** Current pivot state: which dims are axes, which are filters/layers. */
export interface MatrixPivotState {
  rowAxis: MatrixAxis;
  colAxis: MatrixAxis;
  /**
   * For each non-axis dim, the active filter values. `[]` = "all" (no filter).
   * Multi-value entries cause the grid to render layered tabs (one grid per
   * unique value) per arch §5.4.
   */
  filters: Partial<Record<MatrixAxis, string[]>>;
}

/** A single grouped cell in the rendered matrix. */
export interface MatrixCellModel {
  rowKey: string;
  colKey: string;
  items: MatrixItem[];
  /** Formatted display value (caller's formatter applied). Empty string = empty cell. */
  displayValue: string;
}

/** Layout produced by useMatrixData per layer (filter tab). */
export interface MatrixLayer {
  /** Filter values that define this layer, e.g. { inseam: "30" }. Empty for non-layered grids. */
  layerKey: Partial<Record<MatrixAxis, string>>;
  rowValues: string[];
  colValues: string[];
  cells: MatrixCellModel[];
}

/** Caller-provided cell-value formatter. Defaults to count when value not provided. */
export type CellFormatter = (items: MatrixItem[]) => string;

export interface MatrixGridProps {
  items: MatrixItem[];
  pivot?: MatrixPivotState;
  /** When set, makes the grid uncontrolled — internal state owns pivot via useMatrixPivot. */
  defaultPivot?: Partial<MatrixPivotState>;
  /** Notified whenever pivot changes (uncontrolled mode). */
  onPivotChange?: (next: MatrixPivotState) => void;
  /** Per-cell formatter. Default: count of items in cell. */
  format?: CellFormatter;
  /** When true, hides edit affordances. Default true (read-only). */
  readOnly?: boolean;
  /** Fires when user clicks an editable cell. Caller persists. */
  onCellClick?: (cell: MatrixCellModel, layerKey: Partial<Record<MatrixAxis, string>>) => void;
  /** Available distinct values per dim. If omitted, derived from `items`. */
  axisValues?: Partial<Record<MatrixAxis, string[]>>;
}
