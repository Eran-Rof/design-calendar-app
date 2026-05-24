// src/shared/matrix/MatrixCell.tsx
//
// One cell of the matrix grid. Empty cells render a dash (per arch §5.4).
// Editable cells dispatch onClick; read-only cells are display-only.

import React from "react";
import type { MatrixCellModel } from "./types";

export interface MatrixCellProps {
  cell: MatrixCellModel;
  readOnly: boolean;
  onClick?: () => void;
}

export function MatrixCell({ cell, readOnly, onClick }: MatrixCellProps) {
  const isEmpty = cell.items.length === 0;
  const display = isEmpty ? "–" : cell.displayValue;

  const baseStyle: React.CSSProperties = {
    padding: "4px 8px",
    border: "1px solid #e5e7eb",
    background: isEmpty ? "#f8fafc" : "white",
    color: isEmpty ? "#94a3b8" : "#0f172a",
    fontSize: 13,
    textAlign: "right" as const,
    minWidth: 48,
    cursor: readOnly || isEmpty ? "default" : "pointer",
    userSelect: "none" as const,
  };

  if (readOnly || isEmpty) {
    return (
      <td style={baseStyle} data-testid={`matrix-cell-${cell.rowKey}-${cell.colKey}`}>
        {display}
      </td>
    );
  }

  return (
    <td
      style={{ ...baseStyle, background: "#eff6ff" }}
      data-testid={`matrix-cell-${cell.rowKey}-${cell.colKey}`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
    >
      {display}
    </td>
  );
}
