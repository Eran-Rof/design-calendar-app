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
//   • Download template → a WIDE matrix: row = PPK style, column = size, cell =
//     Qty Per Box (carton units); each row sums to its Carton Total (the PPKnn
//     token, e.g. PPK24 → 24).
//   • Upload → parseWorkbook accepts BOTH the wide matrix and the long format
//     (one row per size). It is section-aware: '#'-comment + blank rows are
//     skipped and a repeated "PPK Style Code" header re-establishes the size
//     columns, so the bulk file (one block per size scale) imports in one shot.
//     Rows are grouped by PPK Style Code and idempotently UPSERT each matrix
//     (matrix POST upserts by ppk_style_code). Inner packs come from the editor
//     (size:inner:box) or the long template; wide import sets inner packs = 0.
//
// Wraps /api/internal/prepack-matrices and /api/internal/prepack-matrices/:id.

import { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";

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
type PrepackMatrix = {
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
  fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600, minHeight: 19, opacity: 0.85,
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

// Template columns (canonical headers the upload parser also accepts).
// Fixed (non-size) column headers shared by the wide + long templates.
const FIXED_HEADERS = new Set([
  "ppk style code", "ppk_style_code", "style", "style code",
  "matrix name", "name", "pack token", "pack_token", "pack",
  "carton total", "pack total", "size", "inner pack qty", "inner_pack_qty",
  "inner packs", "inner", "qty per box", "qty per pack", "qty_per_box",
  "qty_per_pack", "qty", "quantity", "(sizes...)",
]);

// Plain composition text (size:box) for the xlsx Export. The on-screen list +
// editor show the stacked size/qty cells (CompositionCells) instead.
function compositionLabel(sizes: SizeRow[]): string {
  if (!Array.isArray(sizes) || sizes.length === 0) return "—";
  return sizes.map((s) => `${s.size}:${s.qty_per_pack}`).join("  ");
}

// Header for the WIDE matrix: paired "<size> Inner" + "<size> Box" per size.
function pairedHeader(sizes: string[]): string[] {
  const h = ["PPK Style Code", "Matrix Name", "Pack Token", "Carton Total"];
  for (const s of sizes) h.push(`${s} Inner`, `${s} Box`);
  return h;
}
function writeSheet(aoa: (string | number)[][], filename: string) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Prepack Matrices");
  XLSX.writeFile(wb, filename);
}

// Download a small filled example so the wide paired-column format is obvious.
// Per size: Inner = # inner packs, Box = carton units; the Box cells sum to the
// Carton Total (PPK24 → 24).
function downloadTemplate() {
  const sizes = ["30", "31", "32", "33", "34", "36"];
  const aoa: (string | number)[][] = [
    ["# Prepack matrix — per size: Inner = inner packs, Box = carton units. Box cells sum to Carton Total. Upload accepts this file (xlsx or csv)."],
    pairedHeader(sizes),
    ["RYB059430PPK", "Edge Slim", "PPK24", 24, 1, 3, 1, 3, 2, 6, 1, 3, 2, 6, 1, 3],
  ];
  writeSheet(aoa, "prepack-matrix-template.xlsx");
}

type NeededRow = { ppk_style_code: string; style_name: string; pack_token: string | null; carton_total: number | null; sizes: string[] };
// Build the bulk file: every PPK style still needing a matrix, grouped into one
// section per size scale, paired Inner/Box columns, cells left blank to fill.
function buildNeededAoa(rows: NeededRow[]): (string | number)[][] {
  const groups = new Map<string, { sizes: string[]; items: NeededRow[] }>();
  const noSizes: NeededRow[] = [];
  for (const r of rows) {
    if (!r.sizes || r.sizes.length === 0) { noSizes.push(r); continue; }
    const key = r.sizes.join("|");
    if (!groups.has(key)) groups.set(key, { sizes: r.sizes, items: [] });
    groups.get(key)!.items.push(r);
  }
  const ordered = [...groups.values()].sort((a, b) => a.sizes.length - b.sizes.length || a.sizes.join().localeCompare(b.sizes.join()));
  const aoa: (string | number)[][] = [
    ["# PREPACK MATRICES TO SET UP — fill Inner (inner packs) + Box (carton units) per size. Box cells sum to Carton Total. Grouped by size scale; upload this whole file."],
  ];
  let n = 0;
  for (const g of ordered) {
    n++;
    aoa.push([], [`# === SIZE SCALE ${n}: ${g.sizes.join(", ")}  (${g.items.length})`]);
    aoa.push(pairedHeader(g.sizes));
    for (const it of g.items) aoa.push([it.ppk_style_code, it.style_name || "", it.pack_token || "", it.carton_total ?? "", ...g.sizes.flatMap(() => ["", ""])]);
  }
  if (noSizes.length) {
    aoa.push([], [`# === NO SIZED SIBLING (${noSizes.length}) — add sizes manually`]);
    aoa.push(["PPK Style Code", "Matrix Name", "Pack Token", "Carton Total"]);
    for (const it of noSizes) aoa.push([it.ppk_style_code, it.style_name || "", it.pack_token || "", it.carton_total ?? ""]);
  }
  return aoa;
}

// Parse an uploaded workbook → grouped matrices keyed by PPK Style Code.
type ParsedMatrix = { ppk_style_code: string; name: string; pack_token: string | null; sizes: SizeRow[] };
// Accepts BOTH the wide matrix (sizes as columns, cells = Qty Per Box) and the
// long format (one row per size). Works on a multi-section sheet: '#'-prefixed
// comment/divider rows and blank rows are skipped, and a new header row (first
// cell = "PPK Style Code") re-establishes the column layout for the rows below
// it — so the bulk export with one block per size scale imports in one go.
function parseWorkbook(buffer: ArrayBuffer): { matrices: ParsedMatrix[]; errors: string[] } {
  const wb = XLSX.read(buffer, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" });
  const errors: string[] = [];
  const byStyle = new Map<string, ParsedMatrix>();
  const norm = (v: unknown) => String(v ?? "").trim();
  const lc = (v: unknown) => norm(v).toLowerCase();

  const getMatrix = (style: string, name: string, pack: string): ParsedMatrix => {
    const key = style.toLowerCase();
    let m = byStyle.get(key);
    // name left blank when absent — the handler resolves it from the style
    // master (we never guess a "<code> prepack" name).
    if (!m) { m = { ppk_style_code: style, name: name || "", pack_token: pack || null, sizes: [] }; byStyle.set(key, m); }
    else { if (!m.name && name) m.name = name; if (!m.pack_token && pack) m.pack_token = pack; }
    return m;
  };
  const pushSize = (m: ParsedMatrix, size: string, box: number, inner: number) => {
    const i = m.sizes.findIndex((s) => s.size === size);
    const row = { size, qty_per_pack: box, inner_pack_qty: inner };
    if (i >= 0) m.sizes[i] = row; else m.sizes.push(row); // last value wins
  };

  // sizeCols: per garment size, the column index of its Box (qty per box) and
  // optional Inner (inner pack qty) cells. Supports paired "<size> Inner" /
  // "<size> Box" headers AND a plain "<size>" header (box only).
  let cols: { ppk: number; name: number; pack: number; size: number; box: number; inner: number; sizeCols: { size: string; box: number; inner: number }[] } | null = null;

  aoa.forEach((rowArr, i) => {
    const row = Array.isArray(rowArr) ? rowArr : [];
    if (norm(row[0]).startsWith("#")) return;            // comment / section divider
    if (row.every((c) => norm(c) === "")) return;        // blank

    if (lc(row[0]) === "ppk style code") {               // (re)header
      const findIdx = (names: string[]) => row.findIndex((c) => names.includes(lc(c)));
      const byName = new Map<string, { size: string; box: number; inner: number }>();
      row.forEach((c, idx) => {
        const name = norm(c);
        if (!name || FIXED_HEADERS.has(lc(c))) return;
        const mInner = name.match(/^(.+?)\s+inner(?:\s+pack(?:\s+qty)?)?$/i);
        const mBox = name.match(/^(.+?)\s+(?:box|qty)$/i);
        const size = mInner ? mInner[1].trim() : mBox ? mBox[1].trim() : name;
        const e = byName.get(size) || { size, box: -1, inner: -1 };
        if (mInner) e.inner = idx; else e.box = idx;     // plain "<size>" → box
        byName.set(size, e);
      });
      cols = {
        ppk: findIdx(["ppk style code", "ppk_style_code", "style", "style code"]),
        name: findIdx(["matrix name", "name"]),
        pack: findIdx(["pack token", "pack_token", "pack"]),
        size: findIdx(["size"]),
        box: findIdx(["qty per box", "qty per pack", "qty_per_box", "qty_per_pack", "qty", "quantity"]),
        inner: findIdx(["inner pack qty", "inner_pack_qty", "inner packs", "inner"]),
        sizeCols: [...byName.values()],
      };
      return;
    }
    if (!cols || cols.ppk < 0) return;                   // data before any header
    const style = norm(row[cols.ppk]);
    if (!style) return;
    const name = cols.name >= 0 ? norm(row[cols.name]) : "";
    const pack = cols.pack >= 0 ? norm(row[cols.pack]) : "";

    if (cols.size >= 0) {                                // LONG: one size per row
      const size = norm(row[cols.size]);
      if (!size) return;
      const box = parseInt(norm(row[cols.box]), 10);
      if (!Number.isInteger(box) || box < 0) { errors.push(`Row ${i + 1} (${style}): Qty Per Box must be ≥ 0 (got "${norm(row[cols.box])}")`); return; }
      const innerN = cols.inner >= 0 ? parseInt(norm(row[cols.inner]) || "0", 10) : 0;
      if (box > 0) pushSize(getMatrix(style, name, pack), size, box, Number.isInteger(innerN) && innerN >= 0 ? innerN : 0);
    } else {                                             // WIDE: size columns
      const m = getMatrix(style, name, pack);
      for (const sc of cols.sizeCols) {
        const boxRaw = sc.box >= 0 ? norm(row[sc.box]) : "";
        const innerRaw = sc.inner >= 0 ? norm(row[sc.inner]) : "";
        if (boxRaw === "" && innerRaw === "") continue;
        const box = boxRaw === "" ? 0 : parseInt(boxRaw, 10);
        if (!Number.isInteger(box) || box < 0) { errors.push(`Row ${i + 1} (${style}, size ${sc.size}): box "${boxRaw}" is not a non-negative integer`); continue; }
        const innerN = innerRaw === "" ? 0 : parseInt(innerRaw, 10);
        if (box > 0) pushSize(m, sc.size, box, Number.isInteger(innerN) && innerN >= 0 ? innerN : 0);
      }
    }
  });

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
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<PrepackMatrix | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [needing, setNeeding] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

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
      if (q.trim()) params.set("q", q.trim());
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

  useEffect(() => { void load(); }, [includeInactive]);

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
      writeSheet(buildNeededAoa(needed), "prepack-matrices-all-ppk.xlsx");
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
        <h2 style={{ margin: 0, fontSize: 22 }}>📦 Prepack Matrices</h2>
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
          onKeyDown={(e) => e.key === "Enter" && void load()}
          style={{ ...inputStyle, maxWidth: 300 }}
        />
        <button onClick={() => void load()} style={btnSecondary}>Search</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show inactive
        </label>

        <button onClick={downloadTemplate} style={btnSecondary} title="Download an .xlsx template to fill in">
          ⬇ Download template
        </button>
        <button onClick={() => void downloadAllNeeded()} style={btnSecondary} disabled={needing} title="Download every PPK style still needing a matrix, grouped by size scale, ready to fill in">
          {needing ? "Building…" : "⬇ Download all PPK"}
        </button>
        <button onClick={() => fileRef.current?.click()} style={{ ...btnSecondary, color: C.success, borderColor: "#14532d" }} disabled={uploading}>
          {uploading ? "Uploading…" : "⬆ Upload (xlsx / csv)"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onUploadFile(f); }}
        />

        <ExportButton
          rows={rows.map((r) => ({
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
              {rows.map((m) => (
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
                  <td style={{ ...td, color: C.textSub }} hidden={!isVisible("composition")}><CompositionCells sizes={m.sizes} /></td>
                  <td style={{ ...td, fontFamily: "monospace", color: C.warn }} hidden={!isVisible("pack_total")}>{m.pack_total_computed}</td>
                  <td style={td} hidden={!isVisible("is_active")}>{m.is_active ? "yes" : "no"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={(e) => { e.stopPropagation(); setEditing(m); }} style={btnSecondary}>Edit</button>
                    <button onClick={(e) => { e.stopPropagation(); void del(m); }} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                  </td>
                </ScrollHighlightRow>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && (
        <MatrixFormModal mode="add" onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load(); }} />
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
  onClose: () => void;
  onSaved: () => void;
}

// Sizes editor text shape: "<size>:<innerPacks>:<qtyPerBox>" triples,
// comma-separated, e.g. "30:1:3, 32:2:6". A 2-part "<size>:<qtyPerBox>" (no
// inner) is still accepted (inner packs = 0).
function sizesToText(sizes: SizeRow[]): string {
  return (sizes || []).map((s) => (s.inner_pack_qty ? `${s.size}:${s.inner_pack_qty}:${s.qty_per_pack}` : `${s.size}:${s.qty_per_pack}`)).join(", ");
}
function parseSizesText(raw: string): { sizes: SizeRow[]; error: string | null } {
  const out: SizeRow[] = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m3 = part.match(/^(.+?)\s*[:×x]\s*(\d+)\s*[:×x]\s*(\d+)$/i);
    const m2 = part.match(/^(.+?)\s*[:×x]\s*(\d+)$/i);
    if (m3) {
      const size = m3[1].trim();
      if (!size) return { sizes: [], error: `Empty size in "${part}"` };
      const inner = parseInt(m3[2], 10); const box = parseInt(m3[3], 10);
      if (box > 0) out.push({ size, qty_per_pack: box, inner_pack_qty: inner });
    } else if (m2) {
      const size = m2[1].trim();
      if (!size) return { sizes: [], error: `Empty size in "${part}"` };
      const box = parseInt(m2[2], 10);
      if (box > 0) out.push({ size, qty_per_pack: box, inner_pack_qty: 0 });
    } else {
      return { sizes: [], error: `Could not parse "${part}". Use size:innerPacks:qtyPerBox (e.g. 32:2:6) or size:qtyPerBox (e.g. 32:6)` };
    }
  }
  return { sizes: out, error: null };
}

function MatrixFormModal({ mode, matrix, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    name:           matrix?.name ?? "",
    ppk_style_code: matrix?.ppk_style_code ?? "",
    pack_token:     matrix?.pack_token ?? "",
    notes:          matrix?.notes ?? "",
    is_active:      matrix?.is_active ?? true,
    sizesText:      matrix?.sizes ? sizesToText(matrix.sizes) : "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const parsed = parseSizesText(form.sizesText);
  const packTotal = parsed.sizes.reduce((a, s) => a + s.qty_per_pack, 0);
  const innerTotal = parsed.sizes.reduce((a, s) => a + (s.inner_pack_qty || 0), 0);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      if (parsed.error) throw new Error(parsed.error);
      if (parsed.sizes.length === 0) throw new Error("Add at least one size (size:innerPacks:qtyPerBox)");
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        ppk_style_code: form.ppk_style_code.trim() || null,
        pack_token: form.pack_token.trim() || null,
        notes: form.notes.trim() || null,
        is_active: form.is_active,
        sizes: parsed.sizes,
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
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, minWidth: 560, maxWidth: 700, color: C.text }}>
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
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} placeholder="(blank → pulled from style master)" />
          </Field>
          <Field label="PPK Style Code">
            <input type="text" value={form.ppk_style_code} onChange={(e) => setForm({ ...form, ppk_style_code: e.target.value })} style={inputStyle} placeholder="e.g. RYB059430PPK" />
          </Field>
          <Field label="Pack Token">
            <input type="text" value={form.pack_token} onChange={(e) => setForm({ ...form, pack_token: e.target.value })} style={inputStyle} placeholder="e.g. PPK24" />
          </Field>
          <Field label="Active">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
              is_active
            </label>
          </Field>
          <Field label="Notes">
            <input type="text" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={inputStyle} placeholder="optional" />
          </Field>
        </div>

        <div style={{ marginTop: 12 }}>
          <Field label="Composition (size:innerPacks:qtyPerBox, comma-separated) *">
            <input type="text" value={form.sizesText} onChange={(e) => setForm({ ...form, sizesText: e.target.value })} style={inputStyle} placeholder="30:1:3, 31:1:3, 32:2:6, 33:1:3, 34:2:6, 36:1:3" />
          </Field>
        </div>

        <div style={{ marginTop: 14, padding: "10px 12px", background: "#0b1220", border: `1px dashed ${C.cardBdr}`, borderRadius: 6, fontSize: 11, color: C.textMuted, lineHeight: 1.6 }}>
          <div style={{ marginBottom: 6 }}>
            Preview ({parsed.sizes.length} size{parsed.sizes.length === 1 ? "" : "s"}, carton total = <strong style={{ color: C.warn }}>{packTotal}</strong>, inner packs = <strong style={{ color: C.warn }}>{innerTotal}</strong>):
          </div>
          {parsed.error ? (
            <span style={{ color: C.danger }}>{parsed.error}</span>
          ) : parsed.sizes.length === 0 ? (
            <span style={{ fontStyle: "italic" }}>Type size:innerPacks:qtyPerBox above (e.g. 32:2:6) to preview the carton composition.</span>
          ) : (
            <CompositionCells sizes={parsed.sizes} />
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
