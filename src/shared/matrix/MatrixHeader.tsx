// src/shared/matrix/MatrixHeader.tsx
//
// Column header for the matrix. Displays the colAxis label + each column value.

import React from "react";
import type { MatrixAxis } from "./types";

export interface MatrixHeaderProps {
  rowAxis: MatrixAxis;
  colAxis: MatrixAxis;
  colValues: string[];
}

export function MatrixHeader({ rowAxis, colAxis, colValues }: MatrixHeaderProps) {
  const headerStyle: React.CSSProperties = {
    padding: "4px 8px",
    border: "1px solid #e5e7eb",
    background: "#f1f5f9",
    fontSize: 12,
    fontWeight: 600,
    color: "#475569",
    textAlign: "center",
    textTransform: "capitalize",
  };

  return (
    <thead>
      <tr>
        <th style={{ ...headerStyle, textAlign: "left" }} data-testid="matrix-corner-header">
          {rowAxis} ↓ / {colAxis} →
        </th>
        {colValues.map((cv) => (
          <th key={cv} style={headerStyle} data-testid={`matrix-col-header-${cv}`}>
            {cv}
          </th>
        ))}
      </tr>
    </thead>
  );
}
