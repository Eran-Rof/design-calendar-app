// src/shared/matrix/MatrixGrid.tsx
//
// Top-level matrix grid. Handles controlled vs uncontrolled pivot, renders
// the pivot control + one or more layered grids per arch §5.4. The render
// rules:
//   - Default: 2-D grid (color × size).
//   - User can pivot any 2 of 5 dims as axes.
//   - Non-axis dims show as filter chips. Multi-value filters render layered
//     tabs — one grid per layer combination.
//   - Empty cells display "–".
//   - Read-only mode disables cell click affordance.

import React from "react";
import { useMatrixData } from "./hooks/useMatrixData";
import { useMatrixPivot } from "./hooks/useMatrixPivot";
import { MatrixCell } from "./MatrixCell";
import { MatrixHeader } from "./MatrixHeader";
import { MatrixPivotControl } from "./MatrixPivotControl";
import type { MatrixAxis, MatrixGridProps, MatrixLayer } from "./types";

export function MatrixGrid({
  items,
  pivot: controlledPivot,
  defaultPivot,
  onPivotChange,
  format,
  readOnly = true,
  onCellClick,
  axisValues: axisValuesProp,
}: MatrixGridProps) {
  // Controlled vs uncontrolled pivot. When `pivot` prop is provided, parent
  // owns state; the hook still drives state changes but its values shadow.
  const uncontrolled = useMatrixPivot(defaultPivot, onPivotChange);
  const pivot = controlledPivot ?? uncontrolled.pivot;

  const { layers, axisValues } = useMatrixData(items, pivot, axisValuesProp, format);

  return (
    <div data-testid="matrix-grid">
      <MatrixPivotControl
        pivot={pivot}
        axisValues={axisValues}
        onAxesChange={(r, c) => uncontrolled.setAxes(r, c)}
        onFilterChange={(axis, vals) => uncontrolled.setFilter(axis, vals)}
      />

      {layers.length > 1 ? (
        <LayeredGrids
          layers={layers}
          pivot={pivot}
          readOnly={readOnly}
          onCellClick={onCellClick}
        />
      ) : (
        <SingleGrid
          layer={layers[0]}
          pivot={pivot}
          readOnly={readOnly}
          onCellClick={onCellClick}
        />
      )}
    </div>
  );
}

interface SingleGridProps {
  layer: MatrixLayer;
  pivot: { rowAxis: MatrixAxis; colAxis: MatrixAxis };
  readOnly: boolean;
  onCellClick: MatrixGridProps["onCellClick"];
}

function SingleGrid({ layer, pivot, readOnly, onCellClick }: SingleGridProps) {
  if (!layer || (layer.rowValues.length === 0 && layer.colValues.length === 0)) {
    return (
      <div style={{ padding: 12, color: "#94a3b8" }} data-testid="matrix-empty">
        No data
      </div>
    );
  }

  return (
    <table style={{ borderCollapse: "collapse" }} data-testid="matrix-table">
      <MatrixHeader rowAxis={pivot.rowAxis} colAxis={pivot.colAxis} colValues={layer.colValues} />
      <tbody>
        {layer.rowValues.map((rowKey) => (
          <tr key={rowKey}>
            <th
              style={{
                padding: "4px 8px",
                border: "1px solid #e5e7eb",
                background: "#f8fafc",
                fontSize: 12,
                fontWeight: 600,
                color: "#475569",
                textAlign: "left",
              }}
              data-testid={`matrix-row-header-${rowKey}`}
            >
              {rowKey}
            </th>
            {layer.colValues.map((colKey) => {
              const cell = layer.cells.find((c) => c.rowKey === rowKey && c.colKey === colKey)!;
              return (
                <MatrixCell
                  key={colKey}
                  cell={cell}
                  readOnly={readOnly}
                  onClick={() => onCellClick?.(cell, layer.layerKey)}
                />
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface LayeredGridsProps {
  layers: MatrixLayer[];
  pivot: { rowAxis: MatrixAxis; colAxis: MatrixAxis };
  readOnly: boolean;
  onCellClick: MatrixGridProps["onCellClick"];
}

function LayeredGrids({ layers, pivot, readOnly, onCellClick }: LayeredGridsProps) {
  const [activeIdx, setActiveIdx] = React.useState(0);
  const active = layers[Math.min(activeIdx, layers.length - 1)];

  return (
    <div data-testid="matrix-layered">
      <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
        {layers.map((layer, idx) => {
          const label = Object.entries(layer.layerKey)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ") || "—";
          const isActive = idx === activeIdx;
          return (
            <button
              key={label + idx}
              type="button"
              onClick={() => setActiveIdx(idx)}
              data-testid={`matrix-layer-tab-${idx}`}
              style={{
                padding: "4px 10px",
                border: `1px solid ${isActive ? "#2563eb" : "#cbd5e1"}`,
                borderRadius: 4,
                background: isActive ? "#dbeafe" : "white",
                color: isActive ? "#1e40af" : "#334155",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
      <SingleGrid layer={active} pivot={pivot} readOnly={readOnly} onCellClick={onCellClick} />
    </div>
  );
}
