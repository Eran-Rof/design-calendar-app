// src/tanda/InternalPrepackMatrix.tsx
//
// Tangerine — Prepack Matrix Driver master admin panel.
//
// A prepack matrix defines the per-size garment composition of one prepack
// (PPK) pack. PPK inventory lives in ip_item_master as a pack row whose
// style_code ends in PPK (e.g. RYB059430PPK) and whose size is the pack token
// (PPK24 / PPK18 / …). This master says "one RYB059430PPK pack = 1×30, 2×32,
// 2×34, …" so the Inventory Matrix "Explode PPK" toggle can convert packs
// on-hand into garment-size eaches on the SIZED sibling style (RYB059430).
//
// Populated either by hand (add/edit modal) or via the Excel/CSV template:
//   • Download template / Download all PPK → a styled workbook (xlsx-js-style):
//     white cells are pre-filled (PPK Style Code, Matrix Name from master, Pack
//     Token, Carton Qty); the user fills YELLOW cells — one uniform Units /
//     Inner Pack plus each Size cell (= the NUMBER OF INNER PACKS of that size);
//     GREEN cells auto-compute: Num Inner Packs (= Σ of the per-size inner
//     packs), Unit Total (= Num Inner Packs × Units/Inner Pack), Status (OK when
//     Unit Total = Carton Qty). Carton units for a size = inner packs × Units/Inner Pack.
//   • Upload → parseWorkbook reads EVERY sheet, section-aware (title / band /
//     blank / legend rows skipped; a "PPK Style Code" header re-establishes
//     columns). Accepts the inner-pack format, the long format (one row per
//     size), and legacy wide (paired Inner/Box or plain "<size>"=box). Rows are
//     grouped by PPK Style Code and idempotently UPSERT each matrix (POST
//     upserts by ppk_style_code).
//
// Wraps /api/internal/prepack-matrices and /api/internal/prepack-matrices/:id.

import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import XLSXStyle from "xlsx-js-style";
import { newWorkbook, renderStyledAoa, downloadExcelWorkbook, type ExcelJS } from "../shared/excelLogo";

type PrepackSpec = { allRows: any[][]; cols: Array<{ wch: number }>; merges?: any[] };
// Render a prepack grid spec as a branded sheet (logo on top).
function appendPrepackSheet(wb: ExcelJS.Workbook, spec: PrepackSpec, name: string): void {
  renderStyledAoa(wb, name, spec.allRows, {
    banner: { cols: spec.cols.length },
    cols: spec.cols.map((c) => c.wch),
    merges: spec.merges,
  });
}
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import SearchableSelect from "./components/SearchableSelect";
import { readDrillParam, consumeDrillParams } from "./scorecardDrill";

const TABLE_KEY = "tangerine:prepackmatrix:columns";
const COLUMNS: ColumnDef[] = [
  { key: "code",           label: "Code" },
  { key: "name",           label: "Name" },
  { key: "ppk_style_code", label: "PPK Style" },
  { key: "pack_token",     label: "Pack" },
  { key: "composition",    label: "Composition" },
  { key: "pack_total",     label: "Pack Total" },
  { key: "is_active",      label: "Active" },
];

// qty_per_pack = Qty Per Box (carton units for the size); inner_pack_qty = # inner packs of that size.
type SizeRow = { size: string; qty_per_pack: number; inner_pack_qty?: number; sort_order?: number };
export type PrepackMatrix = {
  id: string;
  entity_id: string;
  code: string;
  name: string;
  ppk_style_code: string | null;
  pack_token: string | null;
  pack_total: number | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  sizes: SizeRow[];
  pack_total_computed: number;
  inner_packs_computed?: number;
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d" };
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
};
const readonlyCodeStyle: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, border: `1px dashed ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
  boxSizing: "border-box", display: "flex", alignItems: "center",
  fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600, opacity: 0.85,
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13,
};
// Stacked composition cells: size on top, carton qty below — one small boxed
// cell per size (no inner-pack annotation; the carton qty is what reads).
function CompositionCells({ sizes }: { sizes: SizeRow[] }) {
  if (!Array.isArray(sizes) || sizes.length === 0) return <span style={{ color: C.textMuted }}>—</span>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {sizes.map((s) => (
        <div key={s.size} style={{
          minWidth: 30, textAlign: "center", border: `1px solid ${C.cardBdr}`,
          borderRadius: 4, overflow: "hidden", fontFamily: "SFMono-Regular, Menlo, monospace",
        }}>
          <div style={{ background: "#0b1220", color: C.textSub, fontSize: 10, padding: "1px 5px", borderBottom: `1px solid ${C.cardBdr}` }}>{s.size}</div>
          <div style={{ color: C.text, fontSize: 12, padding: "2px 5px", fontWeight: 600 }}>{s.qty_per_pack}</div>
        </div>
      ))}
    </div>
  );
}

// One boxed cell per size (size label on top, a picked value below) — shared
// by the paired inner-pack / carton view below.
function SizeBoxGrid({ sizes, pick }: { sizes: SizeRow[]; pick: (s: SizeRow) => number }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {sizes.map((s) => (
        <div key={s.size} style={{
          minWidth: 30, textAlign: "center", border: `1px solid ${C.cardBdr}`,
          borderRadius: 4, overflow: "hidden", fontFamily: "SFMono-Regular, Menlo, monospace",
        }}>
          <div style={{ background: "#0b1220", color: C.textSub, fontSize: 10, padding: "1px 5px", borderBottom: `1px solid ${C.cardBdr}` }}>{s.size}</div>
          <div style={{ color: C.text, fontSize: 12, padding: "2px 5px", fontWeight: 600 }}>{pick(s)}</div>
        </div>
      ))}
    </div>
  );
}

// Paired composition view: the per-size INNER-PACK grid × units-per-pack = the
// per-size CARTON grid, with both totals — the way the carton actually breaks
// down (matches the Edit-modal mock). Falls back to the plain carton grid for
// legacy matrices that have no inner-pack data.
function PairedCompositionCells({ sizes }: { sizes: SizeRow[] }) {
  if (!Array.isArray(sizes) || sizes.length === 0) return <span style={{ color: C.textMuted }}>—</span>;
  const hasInner = sizes.some((s) => (s.inner_pack_qty || 0) > 0);
  if (!hasInner) return <CompositionCells sizes={sizes} />;
  const innerTotal = sizes.reduce((a, s) => a + (s.inner_pack_qty || 0), 0);
  const cartonTotal = sizes.reduce((a, s) => a + s.qty_per_pack, 0);
  const ref = sizes.find((s) => (s.inner_pack_qty || 0) > 0);
  const upp = ref && ref.inner_pack_qty ? Math.round(ref.qty_per_pack / ref.inner_pack_qty) : 1;
  const lbl: React.CSSProperties = { fontSize: 11, color: C.textMuted, marginBottom: 3 };
  const num: React.CSSProperties = { color: C.warn, fontWeight: 700 };
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
      <div>
        <div style={lbl}>inner packs = <span style={num}>{innerTotal}</span></div>
        <SizeBoxGrid sizes={sizes} pick={(s) => s.inner_pack_qty || 0} />
      </div>
      <div style={{ fontWeight: 700, fontSize: 14, color: C.textSub, alignSelf: "center", padding: "0 2px" }}>× {upp}</div>
      <div>
        <div style={lbl}>carton total = <span style={num}>{cartonTotal}</span></div>
        <SizeBoxGrid sizes={sizes} pick={(s) => s.qty_per_pack} />
      </div>
    </div>
  );
}

// Template columns (canonical headers the upload parser also accepts).
// Fixed (non-size) column headers — everything that is NOT a per-size column.
// Includes the styled template's auto/computed columns so they aren't mistaken
// for sizes.
const FIXED_HEADERS = new Set([
  "ppk style code", "ppk_style_code", "style", "style code",
  "matrix name", "name", "pack token", "pack_token", "pack",
  "carton total", "carton qty", "pack total", "size",
  "num inner packs", "units / inner pack", "units per inner pack", "units/inner pack", "units per pack",
  "inner pack qty", "inner_pack_qty", "inner packs", "inner",
  "inner pack total", "unit total", "status", "legend:",
  "qty per box", "qty per pack", "qty_per_box",
  "qty_per_pack", "qty", "quantity", "(sizes...)",
]);

// Plain composition text (size:box) for the xlsx Export. The on-screen list +
// editor show the stacked size/qty cells (CompositionCells) instead.
function compositionLabel(sizes: SizeRow[]): string {
  if (!Array.isArray(sizes) || sizes.length === 0) return "—";
  return sizes.map((s) => `${s.size}:${s.qty_per_pack}`).join("  ");
}

// ── Styled template (xlsx-js-style) ─────────────────────────────────────────
// One uniform "Units / Inner Pack" per style; each Size cell = the NUMBER OF
// INNER PACKS of that size. Layout matches the operator's mockup:
//   WHITE  = pre-filled by us  (PPK Style Code, Matrix Name, Pack Token, Carton Qty)
//   YELLOW = the user fills     (Units / Inner Pack + each Size cell)
//   GREEN  = auto formula       (Num Inner Packs = Σ sizes, Unit Total = Num Inner Packs × Units/Inner Pack, Status)
// On upload we read only the yellow inputs: per size, inner_pack_qty = the cell,
// qty_per_pack (carton units) = cell × Units/Inner Pack.
const _thin = { style: "thin", color: { rgb: "BFBFBF" } };
const _border = { top: _thin, bottom: _thin, left: _thin, right: _thin };
const ST = {
  title: { font: { bold: true, sz: 13, color: { rgb: "1F3864" } } },
  band:  { font: { bold: true, sz: 10 }, fill: { fgColor: { rgb: "DDEBF7" }, patternType: "solid" }, alignment: { horizontal: "center", vertical: "center" }, border: _border },
  hdr:   { font: { bold: true, sz: 11 }, fill: { fgColor: { rgb: "D9D9D9" }, patternType: "solid" }, alignment: { horizontal: "center", vertical: "center", wrapText: true }, border: _border },
  white: { fill: { fgColor: { rgb: "FFFFFF" }, patternType: "solid" }, border: _border, alignment: { horizontal: "left", vertical: "center" } },
  whiteC:{ fill: { fgColor: { rgb: "FFFFFF" }, patternType: "solid" }, border: _border, alignment: { horizontal: "center", vertical: "center" } },
  yellow:{ fill: { fgColor: { rgb: "FFF2CC" }, patternType: "solid" }, border: _border, alignment: { horizontal: "center", vertical: "center" } },
  green: { font: { italic: true, color: { rgb: "548235" } }, fill: { fgColor: { rgb: "E2EFDA" }, patternType: "solid" }, border: _border, alignment: { horizontal: "center", vertical: "center" } },
  legend:{ font: { italic: true, sz: 10, color: { rgb: "595959" } } },
} as Record<string, Record<string, unknown>>;

type Cell = { v: string | number; t: "s" | "n"; s: Record<string, unknown> } | { t: "n"; f: string; s: Record<string, unknown> } | null;
const sCell = (v: string, st: Record<string, unknown>): Cell => ({ v, t: "s", s: st });
const nCell = (v: number | string | null | undefined, st: Record<string, unknown>): Cell =>
  (v === "" || v == null) ? { v: "", t: "s", s: st } : { v: Number(v), t: "n", s: st };
const fCell = (f: string, st: Record<string, unknown>): Cell => ({ t: "n", f, s: st });

type FillItem = { ppk_style_code: string; style_name: string; pack_token: string | null; carton_qty: number | null; upp?: number | null; sizeIp?: Record<string, number> };

// Build one styled worksheet for a set of items sharing the same size scale.
function buildPrepackSheet(sizes: string[], items: FillItem[]) {
  const col = (c: number) => XLSXStyle.utils.encode_col(c);
  const N = sizes.length;
  const sizeStart = 6, unitCol = 6 + N, statusCol = 7 + N, totalCols = 8 + N;
  const D = col(3), F = col(5), IP = col(4), UNIT = col(unitCol);
  const first = col(sizeStart), last = col(sizeStart + N - 1);
  const grid: Cell[][] = [];

  // Row 1 — title (merged across).
  const titleRow: Cell[] = new Array(totalCols).fill(null);
  titleRow[0] = sCell("PREPACK MATRIX TEMPLATE", ST.title);
  grid.push(titleRow);
  // Row 2 — "INNER PACK" band over Num Inner Packs + Units / Inner Pack.
  const bandRow: Cell[] = new Array(totalCols).fill(null);
  bandRow[4] = sCell("INNER PACK", ST.band); bandRow[5] = sCell("", ST.band);
  grid.push(bandRow);
  // Row 3 — headers.
  const headers = ["PPK Style Code", "Matrix Name", "Pack Token", "Carton Qty", "Num Inner Packs", "Units / Inner Pack",
    ...sizes.map((z) => `Size ${z}`), "Unit Total", "Status"];
  grid.push(headers.map((t) => sCell(t, ST.hdr)));

  // Data rows.
  for (const it of items) {
    const r = grid.length + 1; // 1-based Excel row
    const row: Cell[] = new Array(totalCols).fill(null);
    row[0] = sCell(it.ppk_style_code, ST.white);
    row[1] = sCell(it.style_name || "", ST.white);
    row[2] = sCell(it.pack_token || "", ST.whiteC);
    row[3] = nCell(it.carton_qty ?? "", ST.whiteC);
    row[4] = fCell(`SUM(${first}${r}:${last}${r})`, ST.green);                 // Num Inner Packs = Σ per-size inner packs
    row[5] = nCell(it.upp ?? "", ST.yellow);                                   // Units / Inner Pack
    sizes.forEach((z, si) => { row[sizeStart + si] = nCell(it.sizeIp ? (it.sizeIp[z] ?? "") : "", ST.yellow); });
    row[unitCol] = fCell(`${IP}${r}*${F}${r}`, ST.green);                      // Unit Total = Num Inner Packs × Units / Inner Pack
    row[statusCol] = fCell(`IF(${UNIT}${r}=${D}${r},"OK","CHECK")`, ST.green); // Status: Unit Total vs Carton Qty
    grid.push(row);
  }

  // Legend.
  grid.push(new Array(totalCols).fill(null));
  const legend: Cell[] = new Array(totalCols).fill(null);
  legend[0] = sCell("Legend:", ST.legend);
  legend[1] = sCell("Yellow = you fill", { ...ST.legend, fill: { fgColor: { rgb: "FFF2CC" }, patternType: "solid" }, border: _border });
  legend[3] = sCell("White = pre-filled", { ...ST.legend, fill: { fgColor: { rgb: "FFFFFF" }, patternType: "solid" }, border: _border });
  legend[5] = sCell("Green = auto", { ...ST.legend, fill: { fgColor: { rgb: "E2EFDA" }, patternType: "solid" }, border: _border });
  grid.push(legend);

  const cols = [{ wch: 16 }, { wch: 22 }, { wch: 10 }, { wch: 10 }, { wch: 13 }, { wch: 14 },
    ...sizes.map(() => ({ wch: 7 })), { wch: 11 }, { wch: 9 }];
  const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: totalCols - 1 } }, { s: { r: 1, c: 4 }, e: { r: 1, c: 5 } }];
  return { allRows: grid, cols, merges } as PrepackSpec;
}

// Sanitize a worksheet name (≤31 chars, no []:*?/\).
function sheetName(raw: string): string {
  return raw.replace(/[[\]:*?/\\]/g, " ").slice(0, 31).trim() || "Sheet";
}

function downloadTemplate() {
  const ws = buildPrepackSheet(["30", "31", "32", "33", "34", "36"], [
    { ppk_style_code: "RYB059430PPK", style_name: "Edge Slim", pack_token: "PPK24", carton_qty: 24, upp: 3,
      sizeIp: { "30": 1, "31": 1, "32": 2, "33": 1, "34": 2, "36": 1 } },
  ]);
  const wb = newWorkbook();
  appendPrepackSheet(wb, ws, "Prepack Matrix");
  void downloadExcelWorkbook(wb, "prepack-matrix-template.xlsx");
}

type NeededRow = {
  ppk_style_code: string; style_name: string; pack_token: string | null; carton_total: number | null; sizes: string[];
  size_scale_id?: string | null; scale_code?: string | null; scale_name?: string | null; scale_sizes?: string[];
};
// Bulk workbook: every PPK style still needing a matrix, one styled SHEET per
// SIZE SCALE — all styles sharing a scale land on the same tab, with the scale's
// canonical ordered sizes as the columns. Styles with no assigned scale fall back
// to grouping by their raw size-set (the legacy behaviour). White cells are
// pre-filled from the master, yellow are blank to fill in.
type SheetGroup = { key: string; label: string; sizes: string[]; items: NeededRow[]; isScale: boolean };
function buildNeededWorkbook(rows: NeededRow[]) {
  const groups = new Map<string, SheetGroup>();
  const noSizes: NeededRow[] = [];
  for (const r of rows) {
    const scaleSizes = r.scale_sizes && r.scale_sizes.length ? r.scale_sizes : null;
    if (scaleSizes && r.scale_code) {
      // Group by the assigned size scale; columns = the scale's ordered sizes.
      const key = `scale:${r.scale_code}`;
      if (!groups.has(key)) groups.set(key, { key, label: r.scale_name || r.scale_code, sizes: scaleSizes, items: [], isScale: true });
      groups.get(key)!.items.push(r);
    } else if (r.sizes && r.sizes.length) {
      // Fallback: no scale assigned → group by the exact size-set.
      const key = `set:${r.sizes.join("|")}`;
      if (!groups.has(key)) groups.set(key, { key, label: `${r.sizes[0]}-${r.sizes[r.sizes.length - 1]}`, sizes: r.sizes, items: [], isScale: false });
      groups.get(key)!.items.push(r);
    } else {
      noSizes.push(r);
    }
  }
  // Scale tabs first (alpha by name), then the fallback size-set tabs (by width).
  const ordered = [...groups.values()].sort((a, b) => {
    if (a.isScale !== b.isScale) return a.isScale ? -1 : 1;
    if (a.isScale) return a.label.localeCompare(b.label);
    return a.sizes.length - b.sizes.length || a.sizes.join().localeCompare(b.sizes.join());
  });
  const wb = newWorkbook();
  let n = 0;
  for (const g of ordered) {
    // Skip one-size groups (e.g. the ONE-SIZE scale or a lone size) — a single-
    // column prepack template is useless, so it doesn't get its own tab.
    if (g.sizes.length <= 1) continue;
    n++;
    const items: FillItem[] = g.items.map((it) => ({ ppk_style_code: it.ppk_style_code, style_name: it.style_name, pack_token: it.pack_token, carton_qty: it.carton_total }));
    const label = `${n}. ${g.label} (${g.items.length})`;
    appendPrepackSheet(wb, buildPrepackSheet(g.sizes, items), sheetName(label));
  }
  if (noSizes.length) {
    // No sized sibling — just the prefill columns + a note; sizes added manually.
    const grid: Cell[][] = [
      [sCell("PPK styles with no sized sibling — add sizes manually", ST.title)],
      ["PPK Style Code", "Matrix Name", "Pack Token", "Carton Qty"].map((t) => sCell(t, ST.hdr)),
      ...noSizes.map((it) => [sCell(it.ppk_style_code, ST.white), sCell(it.style_name || "", ST.white), sCell(it.pack_token || "", ST.whiteC), nCell(it.carton_total ?? "", ST.whiteC)]),
    ];
    appendPrepackSheet(wb, { allRows: grid, cols: [{ wch: 16 }, { wch: 22 }, { wch: 10 }, { wch: 10 }] }, sheetName(`No sizes (${noSizes.length})`));
  }
  return wb;
}

// Parse an uploaded workbook → grouped matrices keyed by PPK Style Code.
type ParsedMatrix = { ppk_style_code: string; name: string; pack_token: string | null; sizes: SizeRow[] };
// Reads EVERY sheet. Per sheet it is section-aware (title / band / blank /
// legend rows skipped; a "PPK Style Code" header row re-establishes columns).
// Supports three layouts:
//   • Inner-pack (current styled template) — a "Units / Inner Pack" column +
//     "Size <x>" columns whose cells are the NUMBER OF INNER PACKS of that size.
//     Per size: inner_pack_qty = cell, qty_per_pack (carton units) = cell × upp.
//   • Long — one row per size with Inner Pack Qty + Qty Per Box.
//   • Legacy wide — paired "<size> Inner"/"<size> Box", or a plain "<size>"
//     column = Qty Per Box (older exports).
function parseWorkbook(buffer: ArrayBuffer): { matrices: ParsedMatrix[]; errors: string[] } {
  const wb = XLSX.read(buffer, { type: "array" });
  const errors: string[] = [];
  const byStyle = new Map<string, ParsedMatrix>();
  const norm = (v: unknown) => String(v ?? "").trim();
  const lc = (v: unknown) => norm(v).toLowerCase();

  const getMatrix = (style: string, name: string, pack: string): ParsedMatrix => {
    const key = style.toLowerCase();
    let m = byStyle.get(key);
    // name left blank when absent — the handler resolves it from the style master.
    if (!m) { m = { ppk_style_code: style, name: name || "", pack_token: pack || null, sizes: [] }; byStyle.set(key, m); }
    else { if (!m.name && name) m.name = name; if (!m.pack_token && pack) m.pack_token = pack; }
    return m;
  };
  const pushSize = (m: ParsedMatrix, size: string, box: number, inner: number) => {
    const i = m.sizes.findIndex((s) => s.size === size);
    const row = { size, qty_per_pack: box, inner_pack_qty: inner };
    if (i >= 0) m.sizes[i] = row; else m.sizes.push(row); // last value wins
  };
  const skipFirst = (c0: string) => {
    const l = c0.toLowerCase();
    return c0.startsWith("#") || l.startsWith("legend") || l.startsWith("prepack matrix") || l.startsWith("ppk styles with");
  };

  for (const tab of wb.SheetNames) {
    const ws = wb.Sheets[tab];
    if (!ws) continue;
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" });

    let cols: {
      ppk: number; name: number; pack: number; upp: number; size: number; box: number; inner: number;
      single: { size: string; idx: number }[];     // inner-pack OR plain-box columns
      paired: { size: string; box: number; inner: number }[];
    } | null = null;

    aoa.forEach((rowArr, i) => {
      const row = Array.isArray(rowArr) ? rowArr : [];
      const c0 = norm(row[0]);
      if (skipFirst(c0)) return;
      if (row.every((c) => norm(c) === "")) return;

      if (lc(row[0]) === "ppk style code") {            // (re)header
        const findIdx = (names: string[]) => row.findIndex((c) => names.includes(lc(c)));
        const single = new Map<string, number>();
        const paired = new Map<string, { box: number; inner: number }>();
        row.forEach((c, idx) => {
          const nm = norm(c);
          if (!nm || FIXED_HEADERS.has(lc(c))) return;
          const mSize = nm.match(/^size\s+(.+)$/i);
          if (mSize) { single.set(mSize[1].trim(), idx); return; }
          const mInner = nm.match(/^(.+?)\s+inner(?:\s+pack(?:\s+qty)?)?$/i);
          if (mInner) { const k = mInner[1].trim(); const e = paired.get(k) || { box: -1, inner: -1 }; e.inner = idx; paired.set(k, e); return; }
          const mBox = nm.match(/^(.+?)\s+(?:box|qty)$/i);
          if (mBox) { const k = mBox[1].trim(); const e = paired.get(k) || { box: -1, inner: -1 }; e.box = idx; paired.set(k, e); return; }
          single.set(nm, idx);                          // bare "<size>" column
        });
        cols = {
          ppk: findIdx(["ppk style code", "ppk_style_code", "style", "style code"]),
          name: findIdx(["matrix name", "name"]),
          pack: findIdx(["pack token", "pack_token", "pack"]),
          upp: findIdx(["units / inner pack", "units per inner pack", "units/inner pack", "units per pack"]),
          size: findIdx(["size"]),
          box: findIdx(["qty per box", "qty per pack", "qty_per_box", "qty_per_pack", "qty", "quantity"]),
          inner: findIdx(["inner pack qty", "inner_pack_qty", "inner packs", "inner"]),
          single: [...single.entries()].map(([size, idx]) => ({ size, idx })),
          paired: [...paired.entries()].map(([size, v]) => ({ size, ...v })),
        };
        return;
      }
      if (!cols || cols.ppk < 0) return;                // data before any header
      const c = cols;
      const style = norm(row[c.ppk]);
      if (!style) return;
      const name = c.name >= 0 ? norm(row[c.name]) : "";
      const pack = c.pack >= 0 ? norm(row[c.pack]) : "";
      const intOf = (v: unknown) => { const n = parseInt(norm(v), 10); return Number.isInteger(n) ? n : NaN; };

      if (c.upp >= 0 && c.single.length > 0) {          // INNER-PACK format (current)
        const upp = intOf(row[c.upp]);
        const m = getMatrix(style, name, pack);
        for (const sc of c.single) {
          const raw = norm(row[sc.idx]);
          if (raw === "") continue;
          const ip = intOf(raw);
          if (!Number.isInteger(ip) || ip < 0) { errors.push(`${tab} row ${i + 1} (${style}, size ${sc.size}): inner packs "${raw}" is not a non-negative integer`); continue; }
          if (ip === 0) continue;
          if (!Number.isInteger(upp) || upp <= 0) { errors.push(`${tab} row ${i + 1} (${style}): Units / Inner Pack must be a positive integer`); continue; }
          pushSize(m, sc.size, ip * upp, ip);           // qty_per_pack = inner packs × units/pack
        }
      } else if (c.size >= 0) {                         // LONG: one size per row
        const size = norm(row[c.size]);
        if (!size) return;
        const box = intOf(row[c.box]);
        if (!Number.isInteger(box) || box < 0) { errors.push(`${tab} row ${i + 1} (${style}): Qty Per Box must be ≥ 0`); return; }
        const innerN = c.inner >= 0 ? (Number.isInteger(intOf(row[c.inner])) ? intOf(row[c.inner]) : 0) : 0;
        if (box > 0) pushSize(getMatrix(style, name, pack), size, box, Math.max(0, innerN));
      } else if (c.paired.length > 0) {                 // LEGACY paired Inner/Box
        const m = getMatrix(style, name, pack);
        for (const sc of c.paired) {
          const boxRaw = sc.box >= 0 ? norm(row[sc.box]) : "";
          const innerRaw = sc.inner >= 0 ? norm(row[sc.inner]) : "";
          if (boxRaw === "" && innerRaw === "") continue;
          const box = boxRaw === "" ? 0 : intOf(boxRaw);
          if (!Number.isInteger(box) || box < 0) { errors.push(`${tab} row ${i + 1} (${style}, size ${sc.size}): box "${boxRaw}" invalid`); continue; }
          const innerN = innerRaw === "" ? 0 : intOf(innerRaw);
          if (box > 0) pushSize(m, sc.size, box, Number.isInteger(innerN) && innerN >= 0 ? innerN : 0);
        }
      } else if (c.single.length > 0) {                 // LEGACY plain "<size>" = box
        const m = getMatrix(style, name, pack);
        for (const sc of c.single) {
          const raw = norm(row[sc.idx]);
          if (raw === "") continue;
          const box = intOf(raw);
          if (!Number.isInteger(box) || box < 0) { errors.push(`${tab} row ${i + 1} (${style}, size ${sc.size}): "${raw}" invalid`); continue; }
          if (box > 0) pushSize(m, sc.size, box, 0);
        }
      }
    });
  }

  const matrices = [...byStyle.values()].filter((m) => {
    if (m.sizes.length === 0) { errors.push(`${m.ppk_style_code}: no sizes with a positive qty — skipped`); return false; }
    return true;
  });
  return { matrices, errors };
}

export default function InternalPrepackMatrix() {
  const [rows, setRows] = useState<PrepackMatrix[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addPrefill, setAddPrefill] = useState<Partial<PrepackMatrix> | null>(null);
  const [editing, setEditing] = useState<PrepackMatrix | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [needing, setNeeding] = useState(false);
  const [needed, setNeeded] = useState<NeededRow[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // "PPK styles needing a matrix" drill (Today → master.ppk_matrix_needed,
  // ?needed=1): open focused on the needed list — banner it and scroll it into
  // view (the list itself already renders below the matrices table).
  const [neededFocus, setNeededFocus] = useState<boolean>(() => readDrillParam("needed") === "1");
  const neededSectionRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (neededFocus) consumeDrillParams(["needed"]); }, [neededFocus]);

  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(TABLE_KEY, COLUMNS);
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  const { getRowProps } = useRowClickEdit<PrepackMatrix>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit prepack matrix ${r.code}`,
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (qDebounced.trim()) params.set("q", qDebounced.trim());
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/prepack-matrices?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as PrepackMatrix[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // Debounce the search box so results refresh AS YOU TYPE (no Enter / button).
  useEffect(() => { const t = setTimeout(() => setQDebounced(q), 250); return () => clearTimeout(t); }, [q]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [qDebounced, includeInactive]);

  // PPK styles that still NEED a matrix — so the search also brings up STYLES,
  // not just already-created matrices. Refreshed whenever the matrix list changes
  // (creating one drops it from "needed").
  async function loadNeeded() {
    try {
      const r = await fetch("/api/internal/prepack-matrices/needed");
      if (!r.ok) return;
      const d = await r.json();
      setNeeded(Array.isArray(d) ? d as NeededRow[] : []);
    } catch { /* non-fatal */ }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadNeeded(); }, [rows]);

  // Instant client-side filter as you type (code / name / PPK style).
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((m) =>
      [m.code, m.name, m.ppk_style_code].some((f) => (f || "").toLowerCase().includes(needle)));
  }, [rows, q]);

  // Needed styles that don't already have a matrix, filtered by the search box.
  const neededFiltered = useMemo(() => {
    const have = new Set(rows.map((m) => (m.ppk_style_code || "").toLowerCase()));
    const base = needed.filter((x) => !have.has((x.ppk_style_code || "").toLowerCase()));
    const needle = q.trim().toLowerCase();
    if (!needle) return base;
    return base.filter((x) =>
      [x.ppk_style_code, x.style_name, x.pack_token].some((f) => (f || "").toLowerCase().includes(needle)));
  }, [needed, rows, q]);

  // On the ?needed=1 drill, once the needed list has loaded, scroll it into
  // view so the operator lands directly on the styles that need work.
  useEffect(() => {
    if (neededFocus && neededFiltered.length > 0 && neededSectionRef.current) {
      neededSectionRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neededFocus, needed]);

  function createFromNeeded(x: NeededRow) {
    setAddPrefill({
      ppk_style_code: x.ppk_style_code,
      name: x.style_name || "",
      pack_token: x.pack_token || "",
      // Pre-load the size columns (empty inner/box) so the grid is ready to fill.
      sizes: (Array.isArray(x.sizes) ? x.sizes : []).map((sz) => ({ size: sz, qty_per_pack: 0, inner_pack_qty: 0 })),
    } as Partial<PrepackMatrix>);
    setAddOpen(true);
  }

  async function del(m: PrepackMatrix) {
    if (!(await confirmDialog(`Delete prepack matrix ${m.code} (${m.name})?\nIts size composition is removed too.`))) return;
    try {
      const r = await fetch(`/api/internal/prepack-matrices/${m.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  async function onUploadFile(file: File) {
    setUploading(true);
    try {
      const buffer = await file.arrayBuffer();
      const { matrices, errors } = parseWorkbook(buffer);
      if (matrices.length === 0) {
        notify(`No valid matrices found in the file.${errors.length ? "\n\n" + errors.slice(0, 8).join("\n") : ""}`, "error");
        return;
      }
      let ok = 0;
      const failures: string[] = [];
      for (const m of matrices) {
        const res = await fetch("/api/internal/prepack-matrices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: m.name, ppk_style_code: m.ppk_style_code, pack_token: m.pack_token,
            sizes: m.sizes,
          }),
        });
        if (res.ok) ok += 1;
        else failures.push(`${m.ppk_style_code}: ${(await res.json().catch(() => ({}))).error || `HTTP ${res.status}`}`);
      }
      const warnLines = [...errors, ...failures].slice(0, 10);
      notify(
        `Imported ${ok} of ${matrices.length} matrices (upsert by PPK style).` +
          (warnLines.length ? `\n\nNotes:\n${warnLines.join("\n")}` : ""),
        failures.length ? "error" : "success",
      );
      await load();
    } catch (e: unknown) {
      notify(`Upload failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  // Download EVERY PPK style still needing a matrix, as one wide paired-column
  // workbook grouped by size scale (cells blank to fill). Name comes from the
  // style master via v_prepack_ppk_needed (no guessing).
  async function downloadAllNeeded() {
    setNeeding(true);
    try {
      const r = await fetch("/api/internal/prepack-matrices/needed");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const needed = await r.json() as NeededRow[];
      if (!needed.length) { notify("All PPK styles already have a matrix — nothing to download.", "success"); return; }
      void downloadExcelWorkbook(buildNeededWorkbook(needed), "prepack-matrices-all-ppk.xlsx");
      notify(`Downloaded ${needed.length} PPK styles needing a matrix.`, "success");
    } catch (e: unknown) {
      notify(`Download all failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setNeeding(false);
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Prepack Matrices</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add matrix</button>
      </div>
      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 16, maxWidth: 760, lineHeight: 1.5 }}>
        Defines each prepack&apos;s per-size garment composition (1 pack = the size quantities below).
        The <strong>PPK Style Code</strong> links a matrix to its pack rows in inventory (e.g.{" "}
        <code style={{ color: C.textSub }}>RYB059430PPK</code>); the Inventory Matrix &quot;Explode PPK&quot;
        toggle uses it to convert packs on-hand into sized eaches on the sized sibling style.
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          placeholder="Search code, name or PPK style…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ ...inputStyle, maxWidth: 300 }}
        />
        <button onClick={() => void load()} style={btnSecondary}>Search</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show inactive
        </label>

        <button onClick={downloadTemplate} style={btnSecondary} title="Download an .xlsx template to fill in">
          Download template
        </button>
        <button onClick={() => void downloadAllNeeded()} style={btnSecondary} disabled={needing} title="Download every PPK style still needing a matrix, grouped by size scale, ready to fill in">
          {needing ? "Building…" : "Download all PPK"}
        </button>
        <button onClick={() => fileRef.current?.click()} style={{ ...btnSecondary, color: C.success, borderColor: "#14532d" }} disabled={uploading}>
          {uploading ? "Uploading…" : "Upload (xlsx / csv)"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onUploadFile(f); }}
        />

        <ExportButton
          rows={filtered.map((r) => ({
            ...r,
            composition: compositionLabel(r.sizes),
          })) as unknown as Array<Record<string, unknown>>}
          filename="prepack-matrices"
          sheetName="Prepack Matrices"
          columns={[
            { key: "code",           header: "Code" },
            { key: "name",           header: "Name" },
            { key: "ppk_style_code", header: "PPK Style Code" },
            { key: "pack_token",     header: "Pack Token" },
            { key: "composition",    header: "Composition" },
            { key: "pack_total_computed", header: "Carton Total (Σ box)", format: "number" },
            { key: "inner_packs_computed", header: "Inner Packs (Σ)", format: "number" },
            { key: "is_active",      header: "Active" },
            { key: "updated_at",     header: "Updated", format: "datetime" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
        <TablePrefsButton
          tableKey={TABLE_KEY}
          columns={COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
        />
      </div>

      {neededFocus && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, marginBottom: 12,
          background: "rgba(59,130,246,0.12)", border: `1px solid ${C.primary}`,
          borderRadius: 8, padding: "8px 12px", fontSize: 13, color: C.text,
        }}>
          <span style={{ fontWeight: 600 }}>
            Showing {neededFiltered.length.toLocaleString()} PPK style{neededFiltered.length === 1 ? "" : "s"} that still need a prepack matrix
          </span>
          <span style={{ color: C.textMuted }}>— click “+ Create” on any row below to build one.</span>
          <button
            onClick={() => setNeededFocus(false)}
            style={{ marginLeft: "auto", background: "transparent", border: `1px solid ${C.cardBdr}`, color: C.textSub, borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12 }}
          >
            ✕ Clear
          </button>
        </div>
      )}

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            No prepack matrices yet. Use <strong>+ Add matrix</strong>, or <strong>Download template</strong> →
            fill it in → <strong>Upload</strong> (xlsx or csv).
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th} hidden={!isVisible("code")}>Code</th>
                <th style={th} hidden={!isVisible("name")}>Name</th>
                <th style={th} hidden={!isVisible("ppk_style_code")}>PPK Style</th>
                <th style={th} hidden={!isVisible("pack_token")}>Pack</th>
                <th style={th} hidden={!isVisible("composition")}>Composition</th>
                <th style={th} hidden={!isVisible("pack_total")}>Pack Total</th>
                <th style={th} hidden={!isVisible("is_active")}>Active</th>
                <th style={{ ...th, width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => (
                <ScrollHighlightRow
                  key={m.id}
                  rowId={m.id}
                  highlightedRowId={highlightedId}
                  {...getRowProps(m)}
                  style={!m.is_active ? { opacity: 0.5 } : undefined}
                >
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }} hidden={!isVisible("code")}>{m.code}</td>
                  <td style={td} hidden={!isVisible("name")}>{m.name}</td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", color: C.textSub }} hidden={!isVisible("ppk_style_code")}>{m.ppk_style_code || "—"}</td>
                  <td style={{ ...td, color: C.textSub }} hidden={!isVisible("pack_token")}>{m.pack_token || "—"}</td>
                  <td style={{ ...td, color: C.textSub }} hidden={!isVisible("composition")}><PairedCompositionCells sizes={m.sizes} /></td>
                  <td style={{ ...td, fontFamily: "monospace", color: C.warn }} hidden={!isVisible("pack_total")}>{m.pack_total_computed}</td>
                  <td style={td} hidden={!isVisible("is_active")}>{m.is_active ? "yes" : "no"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={(e) => { e.stopPropagation(); setEditing(m); }} style={btnSecondary}>Edit</button>
                    <button onClick={(e) => { e.stopPropagation(); void del(m); }} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                  </td>
                </ScrollHighlightRow>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={8} style={{ ...td, textAlign: "center", color: C.textMuted, padding: 20 }}>No matches for &ldquo;{q.trim()}&rdquo;.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* PPK styles still needing a matrix — so the search surfaces STYLES too,
          not only existing matrices. Click "Create" to open the add form
          pre-filled with the style's PPK code, name and pack token. */}
      {neededFiltered.length > 0 && (
        <div style={{ marginTop: 18 }} ref={neededSectionRef}>
          <div style={{ fontSize: 13, color: C.textSub, marginBottom: 8 }}>
            <strong style={{ color: C.warn }}>{neededFiltered.length}</strong> PPK style{neededFiltered.length === 1 ? "" : "s"} still need{neededFiltered.length === 1 ? "s" : ""} a matrix{q.trim() ? ` matching “${q.trim()}”` : ""}
          </div>
          <div style={{ background: C.card, border: `1px dashed ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={th}>PPK Style</th><th style={th}>Name</th><th style={th}>Pack</th><th style={th}>Sizes</th><th style={{ ...th, width: 120 }}></th>
              </tr></thead>
              <tbody>
                {neededFiltered.slice(0, 100).map((x) => (
                  <tr key={x.ppk_style_code}>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>{x.ppk_style_code}</td>
                    <td style={td}>{x.style_name || "—"}</td>
                    <td style={{ ...td, color: C.textSub }}>{x.pack_token || "—"}</td>
                    <td style={{ ...td, color: C.textSub }}>{Array.isArray(x.sizes) && x.sizes.length ? x.sizes.join(", ") : "—"}</td>
                    <td style={{ ...td, textAlign: "right" }}>
                      <button onClick={() => createFromNeeded(x)} style={btnSecondary}>+ Create</button>
                    </td>
                  </tr>
                ))}
                {neededFiltered.length > 100 && (
                  <tr><td colSpan={5} style={{ ...td, textAlign: "center", color: C.textMuted }}>+{neededFiltered.length - 100} more — narrow the search, or use Download all PPK.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {addOpen && (
        <MatrixFormModal
          mode="add"
          matrix={(addPrefill || undefined) as PrepackMatrix | undefined}
          onClose={() => { setAddOpen(false); setAddPrefill(null); }}
          onSaved={() => { setAddOpen(false); setAddPrefill(null); void load(); void loadNeeded(); }}
        />
      )}
      {editing && (
        <MatrixFormModal mode="edit" matrix={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />
      )}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  matrix?: PrepackMatrix;
  /** Prefill PPK style / pack token in "add" mode — used when this modal is
   *  opened from the SO/PO line matrix for a specific prepack style (item 24,
   *  so the order popup and the master use the IDENTICAL add form). */
  initialPpk?: string;
  initialPackToken?: string;
  onClose: () => void;
  onSaved: () => void;
}

// Carton size from a pack token like "PPK24" → 24 — the qty that the per-size
// box quantities must sum to (the composition is validated against it).
function packQtyFromToken(token: string | null | undefined): number | null {
  const m = String(token || "").match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

// One editable composition row in the matrix grid (strings while typing).
type EditRow = { size: string; inner: string; box: string };

// A size scale from the Size Scale Master — its ordered `sizes` prefill the
// composition columns so the operator doesn't hand-type each size.
type SizeScale = { id: string; code: string; name: string; sizes: string[] };

// Size sort so added sizes slot into the right position on BOTH grids. Class 0 =
// number-bearing (numeric / 2T / 0-3M / combined "L/12" → by the number); class
// 1 = known alpha (S<M<L…, 2XL after XL); class 2 = unknown. Mirrors the
// download builder's cmpSize.
const SIZE_ALPHA_ORDER = ["XXS", "XS", "XSM", "S", "SM", "SML", "SMALL", "M", "MED", "MEDIUM", "L", "LG", "LRG", "LARGE", "XL", "XLG", "XLARGE", "XXL", "2XL", "XXXL", "3XL", "XXXXL", "4XL", "OS", "ONE SIZE"];
function sizeSortKey(s: string): [number, number, string] {
  const t = String(s).toUpperCase().trim();
  if (t.includes("/")) { const m = t.match(/\d+(\.\d+)?/); return [0, m ? Number(m[0]) : 999, t]; }
  const ar = SIZE_ALPHA_ORDER.indexOf(t);
  if (ar >= 0) return [1, ar, t];
  const m = t.match(/\d+(\.\d+)?/);
  if (m) return [0, Number(m[0]), t];
  return [2, 999, t];
}
function cmpSizeLabel(a: string, b: string): number {
  const ka = sizeSortKey(a), kb = sizeSortKey(b);
  return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
}
function sortRows(rs: EditRow[]): EditRow[] {
  return [...rs].sort((a, b) => cmpSizeLabel(a.size, b.size));
}

// Editable horizontal size grid (size label on top, number input below) — the
// editable twin of SizeBoxGrid, so data entry mirrors the row display.
function EditableSizeGrid({ rows, field, onChange, onRemove }: {
  rows: EditRow[];
  field: "inner" | "box";
  onChange: (i: number, v: string) => void;
  onRemove?: (i: number) => void;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {rows.map((r, i) => (
        <div key={r.size} style={{ minWidth: 38, textAlign: "center", border: `1px solid ${C.cardBdr}`, borderRadius: 4, overflow: "hidden", fontFamily: "SFMono-Regular, Menlo, monospace" }}>
          <div
            onClick={onRemove ? () => onRemove(i) : undefined}
            title={onRemove ? "Click to remove this size" : undefined}
            style={{ background: "#0b1220", color: C.textSub, fontSize: 10, padding: "1px 5px", borderBottom: `1px solid ${C.cardBdr}`, cursor: onRemove ? "pointer" : "default" }}
          >{r.size}</div>
          <input
            type="number" min={0}
            value={r[field]}
            onChange={(e) => onChange(i, e.target.value)}
            style={{ width: 38, border: 0, background: "transparent", color: C.text, fontSize: 12, fontWeight: 600, textAlign: "center", padding: "3px 2px", boxSizing: "border-box" }}
          />
        </div>
      ))}
    </div>
  );
}

export function MatrixFormModal({ mode, matrix, initialPpk, initialPackToken, onClose, onSaved }: ModalProps) {
  const [name, setName] = useState(matrix?.name ?? "");
  const [ppk, setPpk] = useState(matrix?.ppk_style_code ?? initialPpk ?? "");
  const [packToken, setPackToken] = useState(matrix?.pack_token ?? initialPackToken ?? "");
  const [notes, setNotes] = useState(matrix?.notes ?? "");
  const [isActive, setIsActive] = useState(matrix?.is_active ?? true);

  // Units / Inner Pack — derived from any existing size that has both inner +
  // box (box ÷ inner). Drives auto-fill of Box Qty from Inner Packs.
  const derivedUpp = (() => {
    for (const s of matrix?.sizes || []) {
      if (s.inner_pack_qty && s.qty_per_pack && s.inner_pack_qty > 0) return String(Math.round(s.qty_per_pack / s.inner_pack_qty));
    }
    return "";
  })();
  const [upp, setUpp] = useState(derivedUpp);
  const [rows, setRows] = useState<EditRow[]>(
    sortRows((matrix?.sizes || []).map((s) => ({
      size: s.size,
      inner: s.inner_pack_qty ? String(s.inner_pack_qty) : "",
      box: s.qty_per_pack ? String(s.qty_per_pack) : "",
    }))),
  );
  const [newSize, setNewSize] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Size scales from the master — pick one to prefill the composition columns
  // (the operator chooses a scale instead of hand-typing every size). Loaded
  // lazily when the modal opens.
  const [scales, setScales] = useState<SizeScale[]>([]);
  const [scaleId, setScaleId] = useState("");
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/internal/size-scales");
        if (!r.ok) return;
        const data = (await r.json()) as SizeScale[];
        if (alive) setScales(Array.isArray(data) ? data : []);
      } catch { /* picker just stays empty — manual + Add size still works */ }
    })();
    return () => { alive = false; };
  }, []);

  // Apply a scale: lay its ordered sizes out as composition columns, preserving
  // any inner/box already typed for a size that the scale also contains.
  function applyScale(id: string) {
    setScaleId(id);
    const sc = scales.find((s) => s.id === id);
    if (!sc) return;
    setRows((rs) => sortRows(sc.sizes.map((sz) => {
      const existing = rs.find((r) => r.size.toLowerCase() === sz.toLowerCase());
      return existing ? { ...existing, size: sz } : { size: sz, inner: "", box: "" };
    })));
  }

  // Editing Inner Packs auto-fills Box Qty (= inner × Units/Inner Pack) when a
  // unit count is set; Box Qty stays directly editable as an override.
  function setInner(i: number, v: string) {
    const u = parseInt(upp, 10);
    setRows((rs) => rs.map((r, idx) => {
      if (idx !== i) return r;
      const innerN = parseInt(v, 10);
      const box = Number.isFinite(u) && u > 0 && Number.isFinite(innerN) ? String(innerN * u) : r.box;
      return { ...r, inner: v, box };
    }));
  }
  function setBox(i: number, v: string) { setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, box: v } : r))); }
  function changeUpp(v: string) {
    setUpp(v);
    const u = parseInt(v, 10);
    if (Number.isFinite(u) && u > 0) {
      setRows((rs) => rs.map((r) => { const n = parseInt(r.inner, 10); return Number.isFinite(n) ? { ...r, box: String(n * u) } : r; }));
    }
  }
  function addSize() {
    const s = newSize.trim();
    if (!s) return;
    if (!rows.some((r) => r.size.toLowerCase() === s.toLowerCase())) setRows((rs) => sortRows([...rs, { size: s, inner: "", box: "" }]));
    setNewSize("");
  }
  function removeSize(i: number) { setRows((rs) => rs.filter((_, idx) => idx !== i)); }

  const totalInner = rows.reduce((a, r) => a + (parseInt(r.inner, 10) || 0), 0);
  const totalBox = rows.reduce((a, r) => a + (parseInt(r.box, 10) || 0), 0);
  const packQty = packQtyFromToken(packToken);
  const mismatch = packQty != null && totalBox !== packQty;

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const sizes: SizeRow[] = rows
        .map((r) => ({ size: r.size.trim(), qty_per_pack: parseInt(r.box, 10) || 0, inner_pack_qty: parseInt(r.inner, 10) || 0 }))
        .filter((s) => s.size && s.qty_per_pack > 0);
      if (sizes.length === 0) throw new Error("Enter a Box Qty for at least one size.");
      const body: Record<string, unknown> = {
        name: name.trim(),
        ppk_style_code: ppk.trim() || null,
        pack_token: packToken.trim() || null,
        notes: notes.trim() || null,
        is_active: isActive,
        sizes,
      };
      const url = mode === "add" ? "/api/internal/prepack-matrices" : `/api/internal/prepack-matrices/${matrix!.id}`;
      const method = mode === "add" ? "POST" : "PATCH";
      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(760px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{mode === "add" ? "Add prepack matrix" : `Edit ${matrix!.code}`}</h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Code">
            <div style={readonlyCodeStyle}>
              {mode === "add"
                ? <span style={{ color: C.textMuted, fontStyle: "italic", fontFamily: "inherit" }}>(auto-generated on save)</span>
                : (matrix?.code || "—")}
            </div>
          </Field>
          <Field label="Name">
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} placeholder="(blank → pulled from style master)" />
          </Field>
          <Field label="PPK Style Code">
            <input type="text" value={ppk} onChange={(e) => setPpk(e.target.value)} style={inputStyle} placeholder="e.g. RYB059430PPK" />
          </Field>
          <Field label="Pack Token">
            <input type="text" value={packToken} onChange={(e) => setPackToken(e.target.value)} style={inputStyle} placeholder="e.g. PPK24" />
          </Field>
          <Field label="Active">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              is_active
            </label>
          </Field>
          <Field label="Notes">
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} style={inputStyle} placeholder="optional" />
          </Field>
        </div>

        {/* Composition — horizontal twin of the row display: an INNER PACKS grid
            (user enters) × Units/Inner Pack = the CARTON grid (auto, editable).
            Sizes stay in sort order on both. Carton total checks the pack qty. */}
        <div style={{ marginTop: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 13 }}>Composition</strong>
            <span style={{ fontSize: 11, color: C.textMuted }}>Enter the number of inner packs per size; Box Qty = inner packs × Units/Inner Pack (editable). Carton must total the pack qty.</span>
          </div>

          {/* Size scale picker — choose a scale from the master to lay out its
              sizes as the composition columns (search by code / name / sizes). */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Size scale</span>
            <div style={{ width: 320, maxWidth: "100%" }}>
              <SearchableSelect
                value={scaleId || null}
                onChange={applyScale}
                options={scales.map((s) => ({
                  value: s.id,
                  label: `${s.code} · ${s.name}` + (s.sizes?.length ? ` (${s.sizes.join(", ")})` : ""),
                  searchHaystack: `${s.code} ${s.name} ${(s.sizes || []).join(" ")}`,
                }))}
                placeholder={scales.length ? "Pick a size scale to prefill sizes…" : "Loading scales…"}
              />
            </div>
            <span style={{ fontSize: 11, color: C.textMuted }}>optional — or add sizes by hand below</span>
          </div>

          {rows.length === 0 ? (
            <div style={{ color: C.textMuted, fontStyle: "italic", fontSize: 12, marginBottom: 10 }}>Add a size below to start the composition.</div>
          ) : (
            <div style={{ display: "flex", alignItems: "flex-end", gap: 14, flexWrap: "wrap" }}>
              {/* INNER PACKS — user enters */}
              <div>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4 }}>inner packs = <span style={{ color: C.warn, fontWeight: 700 }}>{totalInner}</span></div>
                <EditableSizeGrid rows={rows} field="inner" onChange={setInner} onRemove={removeSize} />
              </div>
              {/* × Units per Inner Pack */}
              <div style={{ alignSelf: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: C.textSub }}>×</span>
                <input type="number" min={0} value={upp} onChange={(e) => changeUpp(e.target.value)} title="Units / Inner Pack" style={{ ...inputStyle, width: 52, textAlign: "center", padding: "4px 4px" }} placeholder="8" />
              </div>
              {/* CARTON TOTAL — box qty (auto = inner × units, still editable) */}
              <div>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4 }}>carton total = <span style={{ color: mismatch ? C.danger : (packQty != null ? C.success : C.warn), fontWeight: 700 }}>{totalBox}{packQty != null ? ` / ${packQty}` : ""}</span></div>
                <EditableSizeGrid rows={rows} field="box" onChange={setBox} onRemove={removeSize} />
              </div>
            </div>
          )}

          <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input type="text" value={newSize} onChange={(e) => setNewSize(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSize(); } }} style={{ ...inputStyle, width: 90 }} placeholder="+ size" />
            <button onClick={addSize} style={btnSecondary}>+ Add size</button>
            {rows.length > 0 && <span style={{ fontSize: 11, color: C.textMuted }}>added sizes slot into sort order · click a size label to remove it</span>}
          </div>

          {mismatch && (
            <div style={{ marginTop: 8, padding: "8px 12px", background: "#7f1d1d", color: "white", borderRadius: 6, fontSize: 12 }}>
              Carton total <strong>{totalBox}</strong> doesn't match the pack token <strong>{packToken}</strong> (<strong>{packQty}</strong>). Adjust the box quantities so they sum to {packQty}.
            </div>
          )}
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>{err}</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting}>
            {submitting ? "Saving…" : mode === "add" ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      {children}
    </div>
  );
}
