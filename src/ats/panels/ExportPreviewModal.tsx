// Preview modal for every ATS Excel export. Renders the AOA the export
// would produce as a scrollable HTML table so the operator can sanity-
// check the contents before triggering the download. Styling mirrors
// the workbook's intent (header band, zebra rows, currency / percent /
// thousands formatting) but is intentionally light — this is a preview,
// not a pixel-perfect viewer.
//
// Color note: the downloaded .xlsx keeps its tuned Excel palette
// unchanged. The on-screen preview here remaps the well-known Excel
// hexes to the app's TH.* theme tokens via mapExcelToAppPalette() so
// the preview matches the rest of the app's UI. Domain-specific colors
// (Neg-Inven red, Stock-Vs-SO triage colors, Aged-Inven cost bands)
// fall through unchanged because their semantic meaning is the signal.

import React, { useMemo } from "react";
import XLSXStyle from "xlsx-js-style";
import { mapExcelToAppPalette } from "../exportPreviewMapping";
import { REPORT_HEADER_ROW_COUNT } from "../reportHeader";
import { TH } from "../../utils/theme";

interface Cell {
  v?: string | number;
  t?: string;
  s?: any;
  f?: string;
}

interface Props {
  open: boolean;
  // Report being previewed. null when the modal is closed.
  payload: {
    title: string;
    aoa: Cell[][];
    wb: any;
    filename: string;
    // Filter chips + run timestamp surfaced inline in the modal header
    // instead of duplicating the xlsx banner as a wide column-spanning
    // table row. Both optional so legacy callers still type-check; the
    // modal hides each piece when its source value is empty.
    filterChips?: string[];
    runStamp?: string;
  } | null;
  // Header subtitle shows row count — preview reports the body row
  // count (header row excluded). Caller computes this so it matches
  // what the operator perceives as "data rows" for the report.
  rowCount: number;
  // Back / dismiss handlers. Back is only rendered when showBack is
  // true — currently only the main-grid export's Options-modal flow
  // uses it; the 4 simpler reports skip Back entirely.
  showBack?: boolean;
  onClose: () => void;
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

// Walk the cell's fill.fgColor.rgb (if present) through the palette
// remap, then return a CSS-ready "#XXXXXX" string. Returns undefined
// when the cell has no fill (the caller picks a default).
function cellFill(cell: Cell | undefined): string | undefined {
  const rgb: string | undefined = cell?.s?.fill?.fgColor?.rgb;
  if (!rgb) return undefined;
  return `#${mapExcelToAppPalette(rgb)}`;
}

function cellFontColor(cell: Cell | undefined): string | undefined {
  const rgb: string | undefined = cell?.s?.font?.color?.rgb;
  if (!rgb) return undefined;
  return `#${mapExcelToAppPalette(rgb)}`;
}

function isNumeric(cell: Cell | undefined): boolean {
  return cell?.t === "n" || typeof cell?.v === "number";
}

// Trigger the actual file download for the pre-built workbook the
// payload carries. Kept inline so the modal doesn't have to import
// XLSXStyle from anywhere else.
function downloadFromPayload(wb: any, filename: string) {
  const buf  = XLSXStyle.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const ExportPreviewModal: React.FC<Props> = ({ open, payload, rowCount, showBack = false, onClose, onCloseAll }) => {
  const aoa = payload?.aoa ?? null;
  const title = payload?.title ?? "Export";
  const filterChips = payload?.filterChips ?? [];
  const runStamp = payload?.runStamp ?? "";

  // Every ATS report's AOA starts with the 3-row report-metadata
  // banner (name / "Run: …" / "Filters: …") built by reportHeader.ts.
  // The modal hoists runStamp + filterChips into its own header strip,
  // so those 3 banner rows MUST be skipped here — otherwise the
  // banner Row 1 ("Run: 2026-05-26 15:41") gets rendered as the
  // wide column-header row of the preview table. Detection: row index
  // 1's first cell starts with "Run: " — unique to the banner and
  // resilient to changes in report name styling.
  const hasReportBanner = !!(aoa && aoa.length >= REPORT_HEADER_ROW_COUNT
    && typeof aoa[1]?.[0]?.v === "string"
    && (aoa[1][0].v as string).startsWith("Run: "));
  const bannerSkip = hasReportBanner ? REPORT_HEADER_ROW_COUNT : 0;

  // AFTER the banner, the main-grid export may still emit an OPTIONAL
  // title row carrying up to two text values:
  //   • Customer name at col 0 (font sz 22, left-aligned)
  //   • Date range banner somewhere (font sz 20, centered)
  // Both/either/neither may be present. Pre-banner code detected this
  // at AOA index 0; now it lives at index = bannerSkip.
  const looksLikeTitleRow = (row: Cell[] | undefined): boolean => {
    if (!row || row.length === 0) return false;
    let foundBigText = false;
    for (const cell of row) {
      if (!cell) continue;
      if (cell.v === undefined || cell.v === null || cell.v === "") continue;
      const sz = cell.s?.font?.sz;
      if (typeof sz !== "number" || sz < 20) return false;
      foundBigText = true;
    }
    return foundBigText;
  };

  const titleRow  = useMemo(() => (aoa && aoa.length > bannerSkip && looksLikeTitleRow(aoa[bannerSkip])) ? aoa[bannerSkip] : null, [aoa, bannerSkip]);
  const titleSkip = titleRow ? 1 : 0;
  const tableStart = bannerSkip + titleSkip;
  const headerRow = useMemo(() => aoa && aoa.length > tableStart ? aoa[tableStart] : null, [aoa, tableStart]);
  const bodyRows  = useMemo(() => aoa && aoa.length > tableStart + 1 ? aoa.slice(tableStart + 1) : [], [aoa, tableStart]);

  if (!open || !payload || !aoa || !headerRow) return null;

  const onDownload = () => {
    downloadFromPayload(payload.wb, payload.filename);
    onCloseAll();
  };

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
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #334155", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#10B981", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {title} Preview
            </div>
            {/* Subtitle: Run timestamp (when the payload carries one) +
                row / column counts. The filename ("…_2026-05-26.xlsx")
                was dropped per operator request — the .xlsx surfaces on
                the Download button + actual save dialog, no reason to
                duplicate it in the modal header. */}
            <div style={{ fontSize: 11, color: "#94A3B8" }}>
              {runStamp && (<><span>Run: {runStamp}</span><span> · </span></>)}
              <span>{rowCount.toLocaleString()} row{rowCount === 1 ? "" : "s"}</span>
              <span> · </span>
              <span>{headerRow.length} column{headerRow.length === 1 ? "" : "s"}</span>
            </div>
            {/* Filter chips — same list that lands in the xlsx banner's
                "Filters: …" row, surfaced here so the operator can
                confirm scope before downloading without the banner
                rendering as a wide column-spanning table row. Hidden
                when empty so reports without scope (Neg Inven, Stock
                vs SO, Incomplete SKUs) don't show "No filters" noise. */}
            {filterChips.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
                {filterChips.map((chip, i) => (
                  <span
                    key={i}
                    style={{
                      background: "rgba(16,185,129,0.12)",
                      border: "1px solid rgba(16,185,129,0.4)",
                      color: "#10B981",
                      borderRadius: 999,
                      padding: "2px 10px",
                      fontSize: 11,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                    }}
                  >{chip}</span>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {showBack && (
              <button
                style={{ background: "transparent", border: "1px solid #334155", borderRadius: 6, padding: "7px 14px", color: "#CBD5E1", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
                onClick={onClose}
                title="Back to export options"
              >Back</button>
            )}
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
              padding: "12px 18px", background: TH.surface, borderBottom: `1px solid ${TH.border}`,
              display: "flex", alignItems: "center", justifyContent: dateRangeCell && !customerCell ? "center" : "flex-start",
              gap: 24,
            }}>
              {customerCell && (
                <span style={{ fontSize: 22, fontWeight: 700, color: cellFontColor(customerCell) ?? TH.header, lineHeight: 1.1 }}>
                  {formatCell(customerCell)}
                </span>
              )}
              {dateRangeCell && (
                <span style={{
                  fontSize: 20, fontWeight: 700,
                  color: cellFontColor(dateRangeCell) ?? TH.header,
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
        <div style={{ flex: 1, overflow: "auto", padding: 0, background: TH.surface }}>
          <table style={{ borderCollapse: "collapse", fontSize: 11, fontFamily: "Calibri, Arial, sans-serif", color: TH.text, width: "100%" }}>
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
                        background: cellFill(cell) ?? TH.header,
                        color: cellFontColor(cell) ?? "#fff",
                        padding: "6px 8px",
                        border: `1px solid ${TH.header}`,
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
                    const bg = cellFill(cell) ?? (ri % 2 === 0 ? TH.surfaceHi : TH.surface);
                    const color = cellFontColor(cell);
                    const numeric = isNumeric(cell);
                    return (
                      <td
                        key={ci}
                        style={{
                          background: bg,
                          color: color,
                          padding: "4px 8px",
                          border: `1px solid ${TH.border}`,
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
          <span>Preview formatting uses the app's theme — the downloaded Excel keeps each cell's exact native styling.</span>
          <div style={{ display: "flex", gap: 8 }}>
            {showBack && (
              <button
                style={{ background: "transparent", border: "1px solid #334155", borderRadius: 6, padding: "7px 14px", color: "#CBD5E1", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
                onClick={onClose}
                title="Back to export options"
              >Back</button>
            )}
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
