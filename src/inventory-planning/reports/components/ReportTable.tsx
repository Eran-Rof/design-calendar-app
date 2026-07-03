// Renders a ReportResult: summary stat cards + a sortable-on-export table,
// with the universal <ExportButton> wired to the same columns/rows so the
// Excel download is exactly what's on screen.

import { useMemo, useState } from "react";
import type { ReportResult, ReportColumn, ReportStat } from "../types";
import { S, PAL, formatDate } from "../../components/styles";
import ExportButton from "../../../tanda/exports/ExportButton";

const TONE_COLOR: Record<NonNullable<ReportStat["tone"]>, string> = {
  default: PAL.text, good: PAL.green, warn: PAL.yellow, bad: PAL.red,
};

function fmtCell(value: unknown, col: ReportColumn): string {
  if (value == null || value === "") return "—";
  const n = Number(value);
  switch (col.format) {
    case "number":
      return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: col.digits ?? 0 }) : String(value);
    case "currency_dollars":
      return Number.isFinite(n) ? n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: col.digits ?? 0 }) : String(value);
    case "currency_cents":
      return Number.isFinite(n) ? (n / 100).toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }) : String(value);
    case "percent":
      return Number.isFinite(n) ? `${n.toLocaleString(undefined, { maximumFractionDigits: col.digits ?? 1 })}%` : String(value);
    case "date":
      return formatDate(String(value));
    default:
      return String(value);
  }
}

export default function ReportTable({ result, filename, sheetName, busy }: {
  result: ReportResult;
  filename: string;
  sheetName: string;
  busy?: boolean;
}) {
  const { columns, rows, summary, note } = result;
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    const numeric = col && col.format && col.format !== "text" && col.format !== "date";
    return [...rows].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (av == null) return 1;
      if (bv == null) return -1;
      if (numeric) return (Number(av) - Number(bv)) * sortDir;
      return String(av).localeCompare(String(bv)) * sortDir;
    });
  }, [rows, columns, sortKey, sortDir]);

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(-1); }
  }

  // Export rows = on-screen rows + a TOTAL row that sums the additive numeric
  // columns (number / currency). Percent / date / text columns are left blank
  // (averaging a percent across rows is misleading; "TOTAL" rides the first
  // text column as the row label). Skipped entirely when there are no rows or
  // no summable column, so the Excel download never carries an empty footer.
  const exportRows = useMemo(() => {
    if (rows.length === 0) return rows;
    const sumKeys = columns.filter(
      (c) => c.format === "number" || c.format === "currency_cents" || c.format === "currency_dollars",
    );
    if (sumKeys.length === 0) return rows;
    const totalRow: Record<string, unknown> = {};
    for (const c of sumKeys) {
      let sum = 0;
      for (const r of rows) {
        const n = Number(r[c.key]);
        if (Number.isFinite(n)) sum += n;
      }
      totalRow[c.key] = sum;
    }
    const firstText = columns.find((c) => !c.format || c.format === "text" || c.format === "date");
    if (firstText) totalRow[firstText.key] = "TOTAL";
    return [...rows, totalRow];
  }, [rows, columns]);

  return (
    <div>
      {summary.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${summary.length}, 1fr)`, gap: 10, marginBottom: 12 }}>
          {summary.map((s) => (
            <div key={s.label} style={{ ...S.card, padding: "12px 14px" }}>
              <div style={{ color: PAL.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{s.label}</div>
              <div style={{ color: TONE_COLOR[s.tone ?? "default"], fontSize: 20, fontWeight: 700, marginTop: 4 }}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, gap: 12 }}>
        <div style={{ color: PAL.textMuted, fontSize: 12 }}>
          {busy ? "Loading…" : `${rows.length.toLocaleString()} row${rows.length === 1 ? "" : "s"}`}
          {note ? <span style={{ marginLeft: 10 }}>· {note}</span> : null}
        </div>
        <ExportButton rows={exportRows} columns={columns} filename={filename} sheetName={sheetName} />
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} style={{ ...S.th, textAlign: c.align === "right" ? "right" : "left", cursor: "pointer", userSelect: "none" }}
                    onClick={() => toggleSort(c.key)} title="Click to sort">
                  {c.header}{sortKey === c.key ? (sortDir === 1 ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key} style={{ ...S.td, textAlign: c.align === "right" ? "right" : "left",
                    ...(c.format && c.format !== "text" && c.format !== "date" ? { fontVariantNumeric: "tabular-nums" } : {}) }}>
                    {fmtCell(row[c.key], c)}
                  </td>
                ))}
              </tr>
            ))}
            {!busy && sorted.length === 0 && (
              <tr><td colSpan={columns.length} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                No data for the current filters.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
