// src/shared/matrix/MatrixPivotControl.tsx
//
// Two dropdowns (row axis, col axis) + filter chips for the remaining 3 dims.
// Per arch §5.4 the user can pivot any 2 of 5 dims to axes.

import React from "react";
import { MATRIX_AXES } from "./types";
import type { MatrixAxis, MatrixPivotState } from "./types";
import SearchableSelect from "../../tanda/components/SearchableSelect";

export interface MatrixPivotControlProps {
  pivot: MatrixPivotState;
  axisValues: Record<MatrixAxis, string[]>;
  onAxesChange: (rowAxis: MatrixAxis, colAxis: MatrixAxis) => void;
  onFilterChange: (axis: MatrixAxis, values: string[]) => void;
}

export function MatrixPivotControl({
  pivot,
  axisValues,
  onAxesChange,
  onFilterChange,
}: MatrixPivotControlProps) {
  const nonAxisDims = MATRIX_AXES.filter((a) => a !== pivot.rowAxis && a !== pivot.colAxis);

  const wrapStyle: React.CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: 12,
    alignItems: "center",
    marginBottom: 8,
    fontSize: 13,
    color: "#334155",
  };
  const selectStyle: React.CSSProperties = {
    padding: "2px 6px",
    border: "1px solid #cbd5e1",
    borderRadius: 4,
    background: "white",
    fontSize: 13,
    textTransform: "capitalize",
  };

  return (
    <div style={wrapStyle} data-testid="matrix-pivot-control">
      <label>
        Rows:{" "}
        <SearchableSelect
          value={pivot.rowAxis}
          onChange={(v) => onAxesChange(v as MatrixAxis, pivot.colAxis)}
          inputStyle={selectStyle}
          options={MATRIX_AXES.map((a) => ({
            value: a,
            label: a,
            disabled: a === pivot.colAxis,
          }))}
        />
      </label>

      <label>
        Cols:{" "}
        <SearchableSelect
          value={pivot.colAxis}
          onChange={(v) => onAxesChange(pivot.rowAxis, v as MatrixAxis)}
          inputStyle={selectStyle}
          options={MATRIX_AXES.map((a) => ({
            value: a,
            label: a,
            disabled: a === pivot.rowAxis,
          }))}
        />
      </label>

      {nonAxisDims.map((dim) => {
        const allValues = axisValues[dim];
        const active = pivot.filters[dim] ?? [];
        const isAll = active.length === 0;
        return (
          <div key={dim} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ textTransform: "capitalize", color: "#64748b" }}>{dim}:</span>
            <button
              type="button"
              onClick={() => onFilterChange(dim, [])}
              style={chipStyle(isAll)}
              data-testid={`matrix-filter-${dim}-all`}
            >
              All
            </button>
            {allValues.map((v) => {
              const on = active.includes(v);
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => onFilterChange(dim, on ? active.filter((x) => x !== v) : [...active, v])}
                  style={chipStyle(on)}
                  data-testid={`matrix-filter-${dim}-${v}`}
                >
                  {v}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: "2px 8px",
    borderRadius: 12,
    border: `1px solid ${active ? "#2563eb" : "#cbd5e1"}`,
    background: active ? "#dbeafe" : "white",
    color: active ? "#1e40af" : "#334155",
    fontSize: 12,
    cursor: "pointer",
    lineHeight: 1.4,
  };
}
