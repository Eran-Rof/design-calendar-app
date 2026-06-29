import React, { useMemo, useRef, useState } from "react";
import { TH } from "../../utils/theme";
import {
  parsePAWorkbook,
  aggregateVerifyAllOk,
  flattenRecords,
  summarizeRecords,
  uniqueChannelDateCombos,
  sizesPresent,
  paDateSortKey,
  comparePaSizes,
  PA_CHANNEL_KEYS,
} from "../services/paUnpackerService";
import type { PAParsedFile, PARecord, PAChannel } from "../services/paUnpackerService";
import { downloadPAWorkbook } from "../services/paUnpackerExport";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "../../tanda/components/TablePrefs";

// Column visibility applies to the Flat Table view (the only static-column
// table here — Size Matrix and Pivot are dynamic pivots driven by sizes/combos).
const TABLE_KEY = "gs1.pa_unpacker";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "file", label: "File" },
  { key: "sheet", label: "Sheet" },
  { key: "gender", label: "Gender" },
  { key: "style", label: "Style" },
  { key: "style_desc", label: "Style Desc" },
  { key: "color", label: "Color" },
  { key: "indc_date", label: "IN DC Date" },
  { key: "channel", label: "Channel" },
  { key: "size", label: "Size" },
  { key: "units", label: "Units" },
];

type ViewMode = "matrix" | "pivot" | "flat";

interface UploadState {
  fileName: string;
  status: "parsing" | "ok" | "error";
  errorMessage?: string;
  recordCount: number;
  sheetCount: number;
  mismatchCount: number;
  parsed: PAParsedFile | null;
}

const TH_STYLE: React.CSSProperties = {
  padding: "8px 12px", textAlign: "left", fontSize: 12,
  fontWeight: 600, color: TH.textSub2, background: TH.surfaceHi,
  borderBottom: `1px solid ${TH.border}`, textTransform: "uppercase", letterSpacing: "0.04em",
};
const TD_STYLE: React.CSSProperties = { padding: "6px 10px", fontSize: 12, color: TH.text, borderBottom: `1px solid ${TH.border}`, whiteSpace: "nowrap" };
const TD_NUM: React.CSSProperties = { ...TD_STYLE, textAlign: "right", fontVariantNumeric: "tabular-nums" };

function pillStatus(status: UploadState["status"]) {
  const map: Record<UploadState["status"], { bg: string; color: string; label: string }> = {
    parsing: { bg: "#FFFBEB", color: "#92400E", label: "Parsing…" },
    ok:      { bg: "#F0FFF4", color: "#276749", label: "OK" },
    error:   { bg: "#FFF5F5", color: TH.primary, label: "Error" },
  };
  const s = map[status];
  return (
    <span style={{ background: s.bg, color: s.color, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 10 }}>
      {s.label}
    </span>
  );
}

export default function PAUnpackerPanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("matrix");
  const [flatFilter, setFlatFilter] = useState("");
  const [flatSort, setFlatSort] = useState<{ col: keyof PARecord; dir: "asc" | "desc" }>({ col: "style", dir: "asc" });

  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  const allParsed = useMemo(() => uploads.map(u => u.parsed).filter((p): p is PAParsedFile => p !== null), [uploads]);
  const allRecords = useMemo(() => flattenRecords(allParsed), [allParsed]);
  const verify = useMemo(() => aggregateVerifyAllOk(allParsed), [allParsed]);
  const summary = useMemo(() => summarizeRecords(allRecords), [allRecords]);
  const combos = useMemo(() => uniqueChannelDateCombos(allRecords), [allRecords]);
  const sizes  = useMemo(() => sizesPresent(allRecords), [allRecords]);
  const fileNames = useMemo(() => uploads.filter(u => u.status === "ok").map(u => u.fileName), [uploads]);

  async function processFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList).filter(f => /\.(xls|xlsx)$/i.test(f.name));
    if (files.length === 0) return;

    // Add a "parsing" row up-front so the UI shows progress immediately.
    const newRows: UploadState[] = files.map(f => ({
      fileName: f.name, status: "parsing", recordCount: 0, sheetCount: 0, mismatchCount: 0, parsed: null,
    }));
    setUploads(prev => [...prev, ...newRows]);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const buf = await file.arrayBuffer();
        const parsed = parsePAWorkbook(buf, { fileName: file.name });
        const mismatches = parsed.checks.filter(c => !c.ok).length;
        const sheetCount = new Set(parsed.records.map(r => r.sheet)).size;
        if (parsed.records.length === 0 && parsed.errors.length > 0) {
          setUploads(prev => prev.map(u =>
            u.fileName === file.name && u.status === "parsing"
              ? { ...u, status: "error", errorMessage: parsed.errors[0].message }
              : u
          ));
        } else {
          setUploads(prev => prev.map(u =>
            u.fileName === file.name && u.status === "parsing"
              ? { ...u, status: "ok", recordCount: parsed.records.length, sheetCount, mismatchCount: mismatches, parsed }
              : u
          ));
        }
      } catch (err) {
        setUploads(prev => prev.map(u =>
          u.fileName === file.name && u.status === "parsing"
            ? { ...u, status: "error", errorMessage: (err as Error).message }
            : u
        ));
      }
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function onDragEnter(e: React.DragEvent<HTMLDivElement>) { e.preventDefault(); setDragActive(true); }
  function onDragOver (e: React.DragEvent<HTMLDivElement>) { e.preventDefault(); setDragActive(true); }
  function onDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    // Only clear when the leave hits the actual drop target (avoids flicker on children).
    if (e.target === dropRef.current) setDragActive(false);
  }
  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  }

  function handleClearAll() {
    setUploads([]);
  }

  function handleDownload() {
    if (allRecords.length === 0) return;
    downloadPAWorkbook(allRecords, fileNames);
  }

  // ── Build view data ─────────────────────────────────────────────────────────

  // Size Matrix rows: (Style, Color, Channel, IN-DC date) × sizes
  const matrixRows = useMemo(() => {
    interface Row {
      gender: string;
      style: string;
      style_desc: string;
      color: string;
      channel: PAChannel;
      indc_date: string;
      bySize: Map<string, number>;
      total: number;
    }
    const map = new Map<string, Row>();
    for (const r of allRecords) {
      const k = `${r.style}␟${r.color}␟${r.channel}␟${r.indc_date}`;
      let row = map.get(k);
      if (!row) {
        row = {
          gender: r.gender, style: r.style, style_desc: r.style_desc,
          color: r.color, channel: r.channel, indc_date: r.indc_date,
          bySize: new Map(), total: 0,
        };
        map.set(k, row);
      }
      row.bySize.set(r.size, (row.bySize.get(r.size) ?? 0) + r.units);
      row.total += r.units;
    }
    return [...map.values()].sort((a, b) => {
      if (a.style !== b.style) return a.style.localeCompare(b.style);
      if (a.color !== b.color) return a.color.localeCompare(b.color);
      const dc = compareDateStr(a.indc_date, b.indc_date);
      if (dc !== 0) return dc;
      return PA_CHANNEL_KEYS.indexOf(a.channel) - PA_CHANNEL_KEYS.indexOf(b.channel);
    });
  }, [allRecords]);

  // Subtotal rows: Style × Color × Delivery (all channels)
  const subtotalRows = useMemo(() => {
    interface Row {
      style: string;
      style_desc: string;
      color: string;
      indc_date: string;
      bySize: Map<string, number>;
      total: number;
    }
    const map = new Map<string, Row>();
    for (const r of allRecords) {
      const k = `${r.style}␟${r.color}␟${r.indc_date}`;
      let row = map.get(k);
      if (!row) {
        row = { style: r.style, style_desc: r.style_desc, color: r.color, indc_date: r.indc_date, bySize: new Map(), total: 0 };
        map.set(k, row);
      }
      row.bySize.set(r.size, (row.bySize.get(r.size) ?? 0) + r.units);
      row.total += r.units;
    }
    return [...map.values()].sort((a, b) => {
      if (a.style !== b.style) return a.style.localeCompare(b.style);
      if (a.color !== b.color) return a.color.localeCompare(b.color);
      return compareDateStr(a.indc_date, b.indc_date);
    });
  }, [allRecords]);

  // Pivot rows: Style × Color × Size, columns = (delivery × channel)
  const pivotRows = useMemo(() => {
    interface Row {
      style: string;
      color: string;
      size: string;
      byCombo: Map<string, number>;
      total: number;
    }
    const map = new Map<string, Row>();
    for (const r of allRecords) {
      const k = `${r.style}␟${r.color}␟${r.size}`;
      let row = map.get(k);
      if (!row) {
        row = { style: r.style, color: r.color, size: r.size, byCombo: new Map(), total: 0 };
        map.set(k, row);
      }
      const cKey = `${r.channel}|${r.indc_date}`;
      row.byCombo.set(cKey, (row.byCombo.get(cKey) ?? 0) + r.units);
      row.total += r.units;
    }
    return [...map.values()].sort((a, b) => {
      if (a.style !== b.style) return a.style.localeCompare(b.style);
      if (a.color !== b.color) return a.color.localeCompare(b.color);
      return comparePaSizes(a.size, b.size);
    });
  }, [allRecords]);

  // Filtered + sorted flat rows
  const filteredFlat = useMemo(() => {
    const q = flatFilter.trim().toLowerCase();
    let rows = allRecords;
    if (q) {
      rows = rows.filter(r =>
        r.style.toLowerCase().includes(q) ||
        r.color.toLowerCase().includes(q) ||
        r.channel.toLowerCase().includes(q) ||
        r.size.toLowerCase().includes(q) ||
        r.indc_date.toLowerCase().includes(q) ||
        r.style_desc.toLowerCase().includes(q)
      );
    }
    const { col, dir } = flatSort;
    const sign = dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = a[col] as string | number;
      const vb = b[col] as string | number;
      if (typeof va === "number" && typeof vb === "number") return sign * (va - vb);
      return sign * String(va).localeCompare(String(vb));
    });
  }, [allRecords, flatFilter, flatSort]);

  function toggleSort(col: keyof PARecord) {
    setFlatSort(prev => prev.col === col
      ? { col, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { col, dir: "asc" });
  }

  const hasData = allRecords.length > 0;
  const allOk   = verify.total > 0 && verify.passed === verify.total;

  return (
    <div style={{ padding: "24px 16px", maxWidth: 1400, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, color: TH.text }}>PA Unpacker</h2>
      <p style={{ margin: "0 0 20px", color: TH.textMuted, fontSize: 13 }}>
        Drop one or more Macy's PA (Pack Assortment) Excel files. Units are computed per
        Style / Color / Size / Channel / IN-DC date — no server round-trip.
      </p>

      {/* Drop zone */}
      <div
        ref={dropRef}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        style={{
          background: dragActive ? "#EBF8FF" : TH.surface,
          border: `2px dashed ${dragActive ? "#3182CE" : TH.border}`,
          borderRadius: 12,
          padding: "32px 24px",
          textAlign: "center",
          cursor: "pointer",
          marginBottom: 16,
          transition: "all 0.15s",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: TH.text }}>
          Drag & drop PA files here, or click to choose
        </div>
        <div style={{ fontSize: 12, color: TH.textMuted, marginTop: 6 }}>
          .xls or .xlsx · multiple files supported
        </div>
        <input
          ref={fileRef} type="file" multiple accept=".xls,.xlsx"
          onChange={handleFileInput}
          style={{ display: "none" }}
        />
      </div>

      {/* Upload status list */}
      {uploads.length > 0 && (
        <div style={{ background: TH.surface, borderRadius: 10, padding: "12px 18px", boxShadow: `0 1px 4px ${TH.shadow}`, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <strong style={{ fontSize: 13, color: TH.textSub }}>Files ({uploads.length})</strong>
            <button onClick={handleClearAll}
              style={{ background: "transparent", color: TH.textMuted, border: `1px solid ${TH.border}`, borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>
              Clear all
            </button>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={TH_STYLE}>File</th>
                <th style={TH_STYLE}>Status</th>
                <th style={{ ...TH_STYLE, textAlign: "right" }}>Sheets</th>
                <th style={{ ...TH_STYLE, textAlign: "right" }}>Records</th>
                <th style={{ ...TH_STYLE, textAlign: "right" }}>Verify</th>
                <th style={TH_STYLE}>Note</th>
              </tr>
            </thead>
            <tbody>
              {uploads.map((u, i) => (
                <tr key={`${u.fileName}-${i}`}>
                  <td style={TD_STYLE}>{u.fileName}</td>
                  <td style={TD_STYLE}>{pillStatus(u.status)}</td>
                  <td style={TD_NUM}>{u.status === "ok" ? u.sheetCount : "—"}</td>
                  <td style={TD_NUM}>{u.status === "ok" ? u.recordCount.toLocaleString() : "—"}</td>
                  <td style={TD_NUM}>
                    {u.status === "ok"
                      ? (u.mismatchCount === 0
                          ? <span style={{ color: "#276749", fontWeight: 600 }}>✓</span>
                          : <span style={{ color: TH.primary, fontWeight: 600 }}>{u.mismatchCount} ✗</span>)
                      : "—"}
                  </td>
                  <td style={{ ...TD_STYLE, color: TH.textMuted }}>{u.errorMessage ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Verification banner — silent self-check, runs on every parse */}
      {hasData && (
        allOk ? (
          <div style={{ background: "#F0FFF4", border: "1px solid #9AE6B4", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "#276749", fontWeight: 600 }}>
            ✓ Double-checked &amp; reconciled — {verify.byKind.color_coverage.passed.toLocaleString()} colors,{" "}
            {verify.byKind.row_total.passed.toLocaleString()} line rows and{" "}
            {verify.byKind.channel.passed.toLocaleString()} channel totals all tie out
            ({verify.total.toLocaleString()} checks passed).
          </div>
        ) : (
          <div style={{ background: "#FFF5F5", border: "1px solid #FEB2B2", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: TH.primary }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              ✗ {verify.mismatches.length} reconciliation {verify.mismatches.length === 1 ? "check" : "checks"} failed — output may be wrong, do not rely on it:
            </div>
            <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
              {verify.mismatches.slice(0, 10).map((m, idx) => (
                <li key={idx} style={{ fontSize: 12 }}>
                  {m.file} / {m.sheet}: {m.label}
                  {m.kind !== "color_coverage" && (
                    <> — computed {m.computed.toLocaleString()} ≠ reported {m.reported.toLocaleString()}</>
                  )}
                </li>
              ))}
              {verify.mismatches.length > 10 && (
                <li style={{ fontSize: 12 }}>… and {verify.mismatches.length - 10} more</li>
              )}
            </ul>
          </div>
        )
      )}

      {/* Summary + view toggle + download */}
      {hasData && (
        <div style={{ background: TH.surface, borderRadius: 10, padding: "12px 18px", boxShadow: `0 1px 4px ${TH.shadow}`, marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div style={{ display: "flex", gap: 24, fontSize: 13, color: TH.textSub }}>
            <span><strong>{summary.recordCount.toLocaleString()}</strong> size records</span>
            <span><strong>{summary.styleCount}</strong> styles</span>
            <span><strong>{summary.comboCount}</strong> delivery×channel combos</span>
            <span><strong>{sizes.length}</strong> sizes</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <ViewToggleButton active={viewMode === "matrix"} onClick={() => setViewMode("matrix")}>Size Matrix</ViewToggleButton>
            <ViewToggleButton active={viewMode === "pivot"} onClick={() => setViewMode("pivot")}>Pivot</ViewToggleButton>
            <ViewToggleButton active={viewMode === "flat"} onClick={() => setViewMode("flat")}>Flat Table</ViewToggleButton>
            <button onClick={handleDownload}
              style={{ background: TH.primary, color: "#fff", border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", marginLeft: 8 }}>
              Download Excel
            </button>
          </div>
        </div>
      )}

      {/* Views */}
      {hasData && viewMode === "matrix" && (
        <div style={{ background: TH.surface, borderRadius: 10, boxShadow: `0 1px 4px ${TH.shadow}`, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 800 }}>
            <thead>
              <tr>
                <th style={TH_STYLE}>Style</th>
                <th style={TH_STYLE}>Color</th>
                <th style={TH_STYLE}>Channel</th>
                <th style={TH_STYLE}>IN DC Date</th>
                {sizes.map(s => <th key={s} style={{ ...TH_STYLE, textAlign: "right" }}>{s}</th>)}
                <th style={{ ...TH_STYLE, textAlign: "right" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {matrixRows.map((row, i) => (
                <tr key={i}>
                  <td style={TD_STYLE}>{row.style}</td>
                  <td style={TD_STYLE}>{row.color}</td>
                  <td style={{ ...TD_STYLE, fontWeight: 600 }}>{row.channel}</td>
                  <td style={TD_STYLE}>{row.indc_date}</td>
                  {sizes.map(s => {
                    const v = row.bySize.get(s) ?? 0;
                    return <td key={s} style={TD_NUM}>{v > 0 ? v.toLocaleString() : ""}</td>;
                  })}
                  <td style={{ ...TD_NUM, fontWeight: 700 }}>{row.total.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
            <thead>
              <tr>
                <th colSpan={4 + sizes.length + 1}
                  style={{ ...TH_STYLE, background: "#FFF2CC", color: "#7B5800", fontStyle: "italic", textTransform: "none", letterSpacing: "0.01em" }}>
                  ── Subtotals: Style × Color × Delivery (all channels combined) ──
                </th>
              </tr>
              <tr>
                <th style={TH_STYLE}>Style</th>
                <th style={TH_STYLE}>Color</th>
                <th style={TH_STYLE}>{/* channel column intentionally blank */}</th>
                <th style={TH_STYLE}>IN DC Date</th>
                {sizes.map(s => <th key={s} style={{ ...TH_STYLE, textAlign: "right" }}>{s}</th>)}
                <th style={{ ...TH_STYLE, textAlign: "right" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {subtotalRows.map((row, i) => (
                <tr key={`sub-${i}`} style={{ background: "#F7FAF7" }}>
                  <td style={TD_STYLE}>{row.style}</td>
                  <td style={TD_STYLE}>{row.color}</td>
                  <td style={TD_STYLE}></td>
                  <td style={TD_STYLE}>{row.indc_date}</td>
                  {sizes.map(s => {
                    const v = row.bySize.get(s) ?? 0;
                    return <td key={s} style={TD_NUM}>{v > 0 ? v.toLocaleString() : ""}</td>;
                  })}
                  <td style={{ ...TD_NUM, fontWeight: 700 }}>{row.total.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasData && viewMode === "pivot" && (
        <div style={{ background: TH.surface, borderRadius: 10, boxShadow: `0 1px 4px ${TH.shadow}`, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 800 }}>
            <thead>
              <tr>
                <th style={TH_STYLE}>Style</th>
                <th style={TH_STYLE}>Color</th>
                <th style={TH_STYLE}>Size</th>
                {combos.map(c => (
                  <th key={`${c.indc_date}-${c.channel}`} style={{ ...TH_STYLE, textAlign: "right" }}>
                    {c.indc_date}
                    <div style={{ fontSize: 10, fontWeight: 500, color: TH.textMuted, textTransform: "none" }}>{c.channel}</div>
                  </th>
                ))}
                <th style={{ ...TH_STYLE, textAlign: "right" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {pivotRows.map((row, i) => (
                <tr key={i}>
                  <td style={TD_STYLE}>{row.style}</td>
                  <td style={TD_STYLE}>{row.color}</td>
                  <td style={TD_STYLE}>{row.size}</td>
                  {combos.map(c => {
                    const v = row.byCombo.get(`${c.channel}|${c.indc_date}`) ?? 0;
                    return <td key={`${c.indc_date}-${c.channel}`} style={TD_NUM}>{v > 0 ? v.toLocaleString() : ""}</td>;
                  })}
                  <td style={{ ...TD_NUM, fontWeight: 700 }}>{row.total.toLocaleString()}</td>
                </tr>
              ))}
              <tr style={{ background: "#FFF8E1" }}>
                <td style={{ ...TD_STYLE, fontWeight: 700 }} colSpan={3}>GRAND TOTAL</td>
                {combos.map(c => {
                  const t = pivotRows.reduce((s, r) => s + (r.byCombo.get(`${c.channel}|${c.indc_date}`) ?? 0), 0);
                  return <td key={`${c.indc_date}-${c.channel}`} style={{ ...TD_NUM, fontWeight: 700 }}>{t.toLocaleString()}</td>;
                })}
                <td style={{ ...TD_NUM, fontWeight: 700 }}>{pivotRows.reduce((s, r) => s + r.total, 0).toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {hasData && viewMode === "flat" && (
        <div style={{ background: TH.surface, borderRadius: 10, boxShadow: `0 1px 4px ${TH.shadow}` }}>
          <div style={{ padding: "10px 14px", borderBottom: `1px solid ${TH.border}` }}>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <input
                type="text"
                placeholder="Filter by style, color, channel, size, date…"
                value={flatFilter}
                onChange={e => setFlatFilter(e.target.value)}
                style={{ flex: 1, padding: "6px 10px", fontSize: 13, border: `1px solid ${TH.border}`, borderRadius: 6 }}
              />
              <TablePrefsButton
                tableKey={TABLE_KEY}
                columns={ALL_COLUMNS}
                visibleColumns={visibleColumns}
                onToggle={toggleColumn}
                onReset={resetToDefault}
                onSetAll={setAllVisible}
              />
            </div>
            <div style={{ fontSize: 12, color: TH.textMuted, marginTop: 6 }}>
              {filteredFlat.length.toLocaleString()} of {allRecords.length.toLocaleString()} rows
            </div>
          </div>
          <div style={{ overflow: "auto", maxHeight: "65vh" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <FlatTh col="file" label="File" sort={flatSort} toggle={toggleSort} hidden={!visibleColumns.has("file")} />
                  <FlatTh col="sheet" label="Sheet" sort={flatSort} toggle={toggleSort} hidden={!visibleColumns.has("sheet")} />
                  <FlatTh col="gender" label="Gender" sort={flatSort} toggle={toggleSort} hidden={!visibleColumns.has("gender")} />
                  <FlatTh col="style" label="Style" sort={flatSort} toggle={toggleSort} hidden={!visibleColumns.has("style")} />
                  <FlatTh col="style_desc" label="Style Desc" sort={flatSort} toggle={toggleSort} hidden={!visibleColumns.has("style_desc")} />
                  <FlatTh col="color" label="Color" sort={flatSort} toggle={toggleSort} hidden={!visibleColumns.has("color")} />
                  <FlatTh col="indc_date" label="IN DC Date" sort={flatSort} toggle={toggleSort} hidden={!visibleColumns.has("indc_date")} />
                  <FlatTh col="channel" label="Channel" sort={flatSort} toggle={toggleSort} hidden={!visibleColumns.has("channel")} />
                  <FlatTh col="size" label="Size" sort={flatSort} toggle={toggleSort} hidden={!visibleColumns.has("size")} />
                  <FlatTh col="units" label="Units" sort={flatSort} toggle={toggleSort} numeric hidden={!visibleColumns.has("units")} />
                </tr>
              </thead>
              <tbody>
                {filteredFlat.map((r, i) => (
                  <tr key={i}>
                    <td style={{ ...TD_STYLE, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }} hidden={!visibleColumns.has("file")}>{r.file}</td>
                    <td style={TD_STYLE} hidden={!visibleColumns.has("sheet")}>{r.sheet}</td>
                    <td style={TD_STYLE} hidden={!visibleColumns.has("gender")}>{r.gender}</td>
                    <td style={TD_STYLE} hidden={!visibleColumns.has("style")}>{r.style}</td>
                    <td style={TD_STYLE} hidden={!visibleColumns.has("style_desc")}>{r.style_desc}</td>
                    <td style={TD_STYLE} hidden={!visibleColumns.has("color")}>{r.color}</td>
                    <td style={TD_STYLE} hidden={!visibleColumns.has("indc_date")}>{r.indc_date}</td>
                    <td style={{ ...TD_STYLE, fontWeight: 600 }} hidden={!visibleColumns.has("channel")}>{r.channel}</td>
                    <td style={TD_STYLE} hidden={!visibleColumns.has("size")}>{r.size}</td>
                    <td style={{ ...TD_NUM, fontWeight: 700 }} hidden={!visibleColumns.has("units")}>{r.units.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!hasData && uploads.length === 0 && (
        <div style={{ background: TH.surface, borderRadius: 10, padding: "28px 24px", boxShadow: `0 1px 4px ${TH.shadow}`, textAlign: "center", color: TH.textMuted }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}>No files loaded yet.</div>
          <div style={{ fontSize: 12 }}>Drop one or more Macy's PA Excel files above to see units by style, color, size, channel, and delivery.</div>
        </div>
      )}
    </div>
  );
}

function ViewToggleButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? TH.primary : "transparent",
        color: active ? "#fff" : TH.textSub,
        border: `1px solid ${active ? TH.primary : TH.border}`,
        borderRadius: 6,
        padding: "6px 12px",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function FlatTh({ col, label, sort, toggle, numeric, hidden }: {
  col: keyof PARecord; label: string;
  sort: { col: keyof PARecord; dir: "asc" | "desc" };
  toggle: (c: keyof PARecord) => void;
  numeric?: boolean;
  hidden?: boolean;
}) {
  const isActive = sort.col === col;
  return (
    <th onClick={() => toggle(col)} hidden={hidden}
      style={{ ...TH_STYLE, textAlign: numeric ? "right" : "left", cursor: "pointer", userSelect: "none" }}>
      {label}{isActive ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
    </th>
  );
}

function compareDateStr(a: string, b: string): number {
  const da = paDateSortKey(a);
  const db = paDateSortKey(b);
  if (da[0] !== db[0]) return da[0] - db[0];
  if (da[1] !== db[1]) return da[1] - db[1];
  return da[2] - db[2];
}
