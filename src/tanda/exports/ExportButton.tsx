// src/tanda/exports/ExportButton.tsx
//
// Tangerine universal export button — every report/list panel embeds one so the
// operator can yank the visible data into Excel without copy-paste.
//
// Renders a single "Export CSV" button styled to match the dark Tanda palette.
// Caller passes:
//   - filename: stem used for the downloaded file (".csv" appended automatically)
//   - columns:  [{ key: "code", label: "Code", format?: (raw, row) => string }]
//   - rows:     array of plain objects mirroring the table <tbody> rows
//
// CSV is RFC-4180-ish: double-quote-escapes embedded quotes, wraps any field
// containing comma/quote/newline.

import { useState } from "react";

export type ExportColumn<R> = {
  key: string;
  label: string;
  format?: (raw: unknown, row: R) => string;
};

type Props<R> = {
  filename: string;
  columns: ExportColumn<R>[];
  rows: R[];
  disabled?: boolean;
};

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export default function ExportButton<R extends Record<string, unknown>>({
  filename,
  columns,
  rows,
  disabled,
}: Props<R>) {
  const [busy, setBusy] = useState(false);

  function handleClick() {
    if (busy) return;
    setBusy(true);
    try {
      const header = columns.map((c) => csvEscape(c.label)).join(",");
      const body = rows.map((row) =>
        columns
          .map((c) => {
            const raw = row[c.key as keyof R];
            const cell = c.format ? c.format(raw, row) : raw;
            return csvEscape(cell);
          })
          .join(","),
      );
      const csv = [header, ...body].join("\r\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 10);
      a.download = `${filename}-${stamp}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || busy || rows.length === 0}
      style={{
        background: "#1E293B",
        color: "#CBD5E1",
        border: "1px solid #334155",
        padding: "6px 12px",
        borderRadius: 6,
        cursor: disabled || rows.length === 0 ? "not-allowed" : "pointer",
        fontSize: 12,
        opacity: disabled || rows.length === 0 ? 0.5 : 1,
      }}
      title={rows.length === 0 ? "No rows to export" : `Export ${rows.length} row${rows.length === 1 ? "" : "s"} as CSV`}
    >
      {busy ? "Exporting…" : "Export CSV"}
    </button>
  );
}
