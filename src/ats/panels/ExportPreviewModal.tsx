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
  // Back to the options modal — operator can adjust selections + re-view.
  onClose: () => void;
  // Full dismiss — used by the header X and the footer Close button.
  // Closes everything (preview + options) without re-opening anything.
  onCloseAll: () => void;
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

export const ExportPreviewModal: React.FC<Props> = ({ open, aoa, filename, rowCount, onDownload, onClose, onCloseAll }) => {
  // Detect an optional title row at AOA index 0. The exporter writes
  // it when the operator narrows by customer (22pt, col A) AND/OR
  // picks a custom date range (20pt banner). Both, either, or neither
  // may be present. A row qualifies as a title row when:
  //   • At least one cell has a value AND a font size >= 16
  //   • Every non-empty cell has a font size >= 16 (i.e. there are
  //     no normal data cells; this is purely the title band)
  const looksLikeTitleRow = (row: Cell[]): boolean => {
    if (!row || row.length === 0) return false;
    let foundBigText = false;
    for (const cell of row) {
      if (!cell) continue;
      if (cell.v === undefined || cell.v === null || cell.v === "") continue;
      const sz = cell.s?.font?.sz;
      if (typeof sz !== "number" || sz < 16) return false;
      foundBigText = true;
    }
    return foundBigText;
  };

  const titleRow  = useMemo(() => (aoa && aoa.length > 0 && looksLikeTitleRow(aoa[0])) ? aoa[0] : null, [aoa]);
  const titleSkip = titleRow ? 1 : 0;
  const headerRow = useMemo(() => aoa && aoa.length > titleSkip ? aoa[titleSkip] : null, [aoa, titleSkip]);
  const bodyRows  = useMemo(() => aoa && aoa.length > titleSkip + 1 ? aoa.slice(titleSkip + 1) : [], [aoa, titleSkip]);

  if (!open || !aoa || !headerRow) return null;

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1200,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}
      onClick={onCloseAll}
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
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              style={{ background: "transparent", border: "1px solid #334155", borderRadius: 6, padding: "7px 14px", color: "#CBD5E1", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
              onClick={onClose}
              title="Back to export options"
            >Back</button>
            <button
              style={{ background: "#10B981", border: "1px solid #10B981", borderRadius: 6, padding: "7px 16px", color: "#0F172A", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
              onClick={onDownload}
            >Download</button>
            <button
              style={{ background: "none", border: "none", color: "#64748B", fontSize: 22, cursor: "pointer", padding: "2px 8px", borderRadius: 4, lineHeight: 1, marginLeft: 4 }}
              onClick={onCloseAll}
              title="Close"
              aria-label="Close"
            >×</button>
          </div>
        </div>

        {titleRow && (() => {
          // Title row may carry up to two text values:
          //   • Customer name at col 0 (font sz 22, left-aligned)
          //   • Date range banner somewhere (font sz 20, centered)
          // Either or both may be present. Find each by scanning the
          // row for cells whose font.sz matches the corresponding
          // banner size — keeps the preview parity with the xlsx
          // construction in exportExcel.ts.
          const customerCell = titleRow.find(c => c?.s?.font?.sz === 22 && c?.v);
          const dateRangeCell = titleRow.find(c => c?.s?.font?.sz === 20 && c?.v);
          return (
            <div style={{
              padding: "12px 18px", background: "#fff", borderBottom: "1px solid #C7D2DE",
              display: "flex", alignItems: "center", justifyContent: dateRangeCell && !customerCell ? "center" : "flex-start",
              gap: 24,
            }}>
              {customerCell && (
                <span style={{ fontSize: 22, fontWeight: 700, color: cellFontColor(customerCell) ?? "#1F497D", lineHeight: 1.1 }}>
                  {formatCell(customerCell)}
                </span>
              )}
              {dateRangeCell && (
                <span style={{
                  fontSize: 20, fontWeight: 700,
                  color: cellFontColor(dateRangeCell) ?? "#1F497D",
                  lineHeight: 1.1,
                  // When both customer and date range are present, the
                  // banner should center in the remaining space to the
                  // right of the customer name. flex:1 + textAlign
                  // center gives that. When only the date range is
                  // present, the parent's justifyContent: center is
                  // doing the work.
                  flex: customerCell ? 1 : undefined,
                  textAlign: customerCell ? "center" : undefined,
                }}>
                  {formatCell(dateRangeCell)}
                </span>
              )}
            </div>
          );
        })()}
        <div style={{ flex: 1, overflow: "auto", padding: 0, background: "#fff" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 11, fontFamily: "Calibri, Arial, sans-serif", color: "#1f2937", width: "100%" }}>
            <thead style={{ position: "sticky", top: 0, zIndex: 2 }}>
              <tr>
                {headerRow.map((cell, ci) => {
                  // Respect each header cell's wrapText style — long
                  // headers (Sales Jan/01/2026..May/17/2026 Qty, etc.)
                  // get wrapText set at construction in exportExcel.ts,
                  // and the preview should render the same wrap so the
                  // operator sees the workbook's actual layout.
                  const wraps = !!cell?.s?.alignment?.wrapText;
                  return (
                    <th
                      key={ci}
                      style={{
                        background: cellFill(cell) ?? "#1F497D",
                        color: cellFontColor(cell) ?? "#fff",
                        padding: "6px 8px",
                        border: "1px solid #1F497D",
                        whiteSpace: wraps ? "normal" : "nowrap",
                        // Cap wrapped header width so the wrap actually
                        // engages instead of expanding to the longest
                        // line. Matches the 13-char auto-fit cap
                        // exportExcel.ts applies — wide enough to keep
                        // an MMM/DD/YYYY date intact on one line.
                        // wordBreak: normal (not break-word) so the
                        // wrap engine breaks on whitespace only and
                        // never splits a date mid-character.
                        maxWidth: wraps ? 120 : undefined,
                        wordBreak: wraps ? "normal" : undefined,
                        textAlign: "center",
                        fontWeight: 700,
                        verticalAlign: "middle",
                        lineHeight: wraps ? 1.2 : 1.1,
                      }}
                    >{formatCell(cell)}</th>
                  );
                })}
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
              title="Back to export options"
            >Back</button>
            <button
              style={{ background: "transparent", border: "1px solid #334155", borderRadius: 6, padding: "7px 14px", color: "#CBD5E1", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
              onClick={onCloseAll}
            >Close</button>
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
