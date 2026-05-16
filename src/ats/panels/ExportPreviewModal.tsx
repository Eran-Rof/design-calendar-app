// Preview modal for the ATS Excel export. Renders the AOA the export
// would produce as a scrollable HTML table so the operator can sanity-
// check the contents before triggering the download. Styling mirrors
// the workbook's intent (header band, zebra rows, currency / percent /
// thousands formatting) but is intentionally light — this is a preview,
// not a pixel-perfect viewer.

import React, { useMemo } from "react";

interface Cell {
  v?: string | number;
  t?: string;
  s?: any;
  f?: string;
}

interface Props {
  open: boolean;
  aoa: Cell[][] | null;
  filename: string;
  rowCount: number;       // body rows (excludes header)
  onDownload: () => void;
  onClose: () => void;
}

function formatCell(cell: Cell | undefined): string {
  if (!cell || cell.v === undefined || cell.v === null || cell.v === "") return "";
  const v = cell.v;
  const numFmt: string | undefined = cell.s?.numFmt;
  if (typeof v === "number") {
    if (numFmt) {
      if (numFmt.includes("%")) return `${(v * 100).toFixed(numFmt.includes("0.0") ? 1 : 0)}%`;
      if (numFmt.includes("$")) return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      return v.toLocaleString();
    }
    return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return String(v);
}

function cellFill(cell: Cell | undefined): string | undefined {
  const rgb: string | undefined = cell?.s?.fill?.fgColor?.rgb;
  return rgb ? `#${rgb}` : undefined;
}

function cellFontColor(cell: Cell | undefined): string | undefined {
  const rgb: string | undefined = cell?.s?.font?.color?.rgb;
  return rgb ? `#${rgb}` : undefined;
}

function isNumeric(cell: Cell | undefined): boolean {
  return cell?.t === "n" || typeof cell?.v === "number";
}

export const ExportPreviewModal: React.FC<Props> = ({ open, aoa, filename, rowCount, onDownload, onClose }) => {
  const headerRow = useMemo(() => aoa && aoa.length > 0 ? aoa[0] : null, [aoa]);
  const bodyRows = useMemo(() => aoa && aoa.length > 1 ? aoa.slice(1) : [], [aoa]);

  if (!open || !aoa || !headerRow) return null;

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1200,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#0F172A", border: "1px solid #334155", borderRadius: 12,
          width: "95vw", maxWidth: 1600, height: "90vh", color: "#F1F5F9",
          fontFamily: "inherit", display: "flex", flexDirection: "column",
          boxShadow: "0 16px 48px rgba(0,0,0,0.7)",
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #334155", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#10B981", textTransform: "uppercase", letterSpacing: "0.06em" }}>Export Preview</div>
            <div style={{ fontSize: 11, color: "#94A3B8" }}>
              {filename} · {rowCount.toLocaleString()} row{rowCount === 1 ? "" : "s"} · {headerRow.length} column{headerRow.length === 1 ? "" : "s"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              style={{ background: "transparent", border: "1px solid #334155", borderRadius: 6, padding: "7px 14px", color: "#CBD5E1", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
              onClick={onClose}
            >Back</button>
            <button
              style={{ background: "#10B981", border: "1px solid #10B981", borderRadius: 6, padding: "7px 16px", color: "#0F172A", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
              onClick={onDownload}
            >Download</button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: 0, background: "#fff" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 11, fontFamily: "Calibri, Arial, sans-serif", color: "#1f2937", width: "100%" }}>
            <thead style={{ position: "sticky", top: 0, zIndex: 2 }}>
              <tr>
                {headerRow.map((cell, ci) => (
                  <th
                    key={ci}
                    style={{
                      background: cellFill(cell) ?? "#1F497D",
                      color: cellFontColor(cell) ?? "#fff",
                      padding: "6px 8px",
                      border: "1px solid #1F497D",
                      whiteSpace: "nowrap",
                      textAlign: "center",
                      fontWeight: 700,
                    }}
                  >{formatCell(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => {
                    const bg = cellFill(cell) ?? (ri % 2 === 0 ? "#EEF3FA" : "#FFFFFF");
                    const color = cellFontColor(cell);
                    const numeric = isNumeric(cell);
                    return (
                      <td
                        key={ci}
                        style={{
                          background: bg,
                          color: color,
                          padding: "4px 8px",
                          border: "1px solid #C7D2DE",
                          whiteSpace: "nowrap",
                          textAlign: numeric ? "right" : "left",
                          fontWeight: cell?.s?.font?.bold ? 700 : 400,
                        }}
                      >{formatCell(cell)}</td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ padding: "10px 18px", borderTop: "1px solid #334155", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, color: "#94A3B8" }}>
          <span>Preview formatting is approximate — the downloaded Excel keeps every cell's exact styling.</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              style={{ background: "transparent", border: "1px solid #334155", borderRadius: 6, padding: "7px 14px", color: "#CBD5E1", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
              onClick={onClose}
            >Back</button>
            <button
              style={{ background: "#10B981", border: "1px solid #10B981", borderRadius: 6, padding: "7px 16px", color: "#0F172A", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
              onClick={onDownload}
            >Download</button>
          </div>
        </div>
      </div>
    </div>
  );
};
