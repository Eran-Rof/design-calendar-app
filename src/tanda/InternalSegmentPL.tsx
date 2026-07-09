// src/tanda/InternalSegmentPL.tsx
//
// P26 — Segment / Dimensional P&L panel.
//
// Reads GET /api/internal/segment-pl?from&to → a breakdown grouped by
// Brand × Channel × Store/Warehouse × Gender (net sales + COGS + qty), plus the
// distinct dimension values present. The operator defines COLUMNS as arbitrary
// filters over those dimensions (e.g. "Private Label" = MPL brands; "ROF DTC" =
// brand ROF + channel DTC), and the panel pivots the breakdown into those
// columns. GL accounts are shared — the split is purely this reporting pivot.
//
// Amounts are DOLLARS (the sub-ledger ip_sales_history_* stores dollars), unlike
// the GL Income Statement which is in cents.
//
// Source of record note: this reports off the sales sub-ledger
// (ip_sales_history_wholesale, which holds both wholesale and ecom/DTC rows
// tagged by channel). The GL carries the same sales as routed daily bridge JEs.
//
// Drill-through Phase 2: Net Sales / gender break-out / COGS cells are
// clickable → SegmentGLDrillModal maps the cell to the routed GL account(s)
// behind it (revenueRouting) → GLDetailModal → JE → source document.

import { Fragment, useEffect, useMemo, useState } from "react";
import { useSeqGuard } from "./hooks/useSeqGuard";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import DateRangePresets from "./components/DateRangePresets.tsx";
import SegmentGLDrillModal, { type SegmentGLDrillTarget } from "./components/SegmentGLDrillModal";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

type BreakdownRow = {
  brand_id: string | null;
  brand_code: string | null;
  brand_name: string;
  channel_code: string;
  store_key: string;
  gender_code: string;
  lines: number;
  qty: number;
  net_sales: number;
  cogs: number | null;
};
type Dims = {
  brands: { id: string | null; code: string | null; name: string }[];
  channels: string[];
  stores: string[];
  genders: string[];
};

// A column = a name + a filter over each dimension. Empty array = "any value".
type ColFilter = {
  id: string;
  label: string;
  brandCodes: string[];
  channels: string[];
  stores: string[];
  genders: string[];
};

const GENDER_LABEL: Record<string, string> = {
  M: "Men", W: "Women", B: "Boys", G: "Girls", C: "Child", U: "Unisex", "(none)": "Unspecified",
};
function genderLabel(g: string): string { return GENDER_LABEL[g] || g; }

const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: "none",
  padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13,
};

function money(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const neg = n < 0;
  return `${neg ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}
function pct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}%`;
}
function todayISO(): string { return new Date().toISOString().slice(0, 10); }
function fyStartISO(): string { return `${new Date().getUTCFullYear()}-01-01`; }

// v2: "Total" is no longer a stored column — it's computed + pinned, and an
// "Other" bucket auto-reconciles. Bumping the key ignores stale v1 layouts.
const LS_KEY = "segment_pl_columns_v2";

// Default user segments per the CEO request. Total + Other are computed, not
// stored. ROF/PT DTC populate from existing data (ecom rows tagged channel=DTC).
function defaultColumns(): ColFilter[] {
  return [
    { id: "pl",     label: "Private Label",   brandCodes: ["MPLEPIC", "MPLSUNSTONE"], channels: [], stores: [], genders: [] },
    { id: "rofdtc", label: "ROF DTC",         brandCodes: ["ROF"], channels: ["DTC"], stores: [], genders: [] },
    { id: "ptdtc",  label: "PT DTC",          brandCodes: ["PT"],  channels: ["DTC"], stores: [], genders: [] },
  ];
}

function matches(r: BreakdownRow, col: ColFilter): boolean {
  if (col.brandCodes.length && !col.brandCodes.includes(r.brand_code || "")) return false;
  if (col.channels.length && !col.channels.includes(r.channel_code)) return false;
  if (col.stores.length && !col.stores.includes(r.store_key)) return false;
  if (col.genders.length && !col.genders.includes(r.gender_code)) return false;
  return true;
}

type Agg = { net: number; cogs: number; cogsKnown: boolean; qty: number };
function emptyAgg(): Agg { return { net: 0, cogs: 0, cogsKnown: false, qty: 0 }; }
function addTo(a: Agg, r: BreakdownRow): void {
  a.net += r.net_sales || 0;
  a.qty += r.qty || 0;
  if (r.cogs != null) { a.cogs += r.cogs; a.cogsKnown = true; }
}

// A rendered column: a user segment, the auto "Other" bucket, or the pinned Total.
// `filter` = the column's dimension filters (Total = empty/all; Other = null —
// its composition is "whatever no segment matched", which has no filter form,
// so Other cells don't drill).
type DisplayCol = { key: string; label: string; kind: "seg" | "other" | "total"; agg: Agg; genderAgg: Agg[]; filter: ColFilter | null };

export default function InternalSegmentPL() {
  const [rows, setRows] = useState<BreakdownRow[]>([]);
  const [dims, setDims] = useState<Dims>({ brands: [], channels: [], stores: [], genders: [] });
  const [from, setFrom] = useState<string>(fyStartISO());
  const [to, setTo] = useState<string>(todayISO());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [byGender, setByGender] = useState(false);
  const [columns, setColumns] = useState<ColFilter[]>(() => {
    try {
      const s = localStorage.getItem(LS_KEY);
      if (s) {
        const arr = (JSON.parse(s) as ColFilter[]).filter((c) => c && c.id !== "total");
        if (arr.length) return arr;
      }
    } catch { /* ignore */ }
    return defaultColumns();
  });
  const [editing, setEditing] = useState<ColFilter | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  // Drill-through Phase 2 — the cell → GL accounts modal.
  const [glDrill, setGlDrill] = useState<SegmentGLDrillTarget | null>(null);

  useEffect(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(columns)); } catch { /* ignore */ } }, [columns]);

  // Drag-to-reorder a segment column from index `from` to index `to`.
  function moveColumn(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return;
    setColumns((cs) => {
      const a = [...cs];
      const [m] = a.splice(from, 1);
      a.splice(to, 0, m);
      return a;
    });
  }

  // Fetch-race guard: rapid date changes fire overlapping load()s; a slower
  // earlier response must never clobber the newest state.
  const seqGuard = useSeqGuard();

  async function load() {
    const seq = seqGuard.begin();
    setLoading(true);
    setErr(null);
    try {
      const p = new URLSearchParams();
      if (from) p.set("from", from);
      if (to) p.set("to", to);
      const r = await fetch(`/api/internal/segment-pl?${p.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json();
      if (!seqGuard.isCurrent(seq)) return; // superseded by a newer load — drop stale result
      setRows((data.breakdown || []) as BreakdownRow[]);
      setDims((data.dims || { brands: [], channels: [], stores: [], genders: [] }) as Dims);
    } catch (e: unknown) {
      if (seqGuard.isCurrent(seq)) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (seqGuard.isCurrent(seq)) setLoading(false);
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const genders = useMemo(
    () => Array.from(new Set(rows.map((r) => r.gender_code))).sort(),
    [rows],
  );

  // Partition every sale into exactly ONE column: the FIRST user segment (in
  // display order) whose filter matches, else the auto "Other" bucket. Total is
  // computed over all rows. Because each row lands in exactly one segment-or-Other,
  // Total ALWAYS equals the sum of the segment columns + Other — the math ties by
  // construction, and reordering only changes which column claims overlapping rows.
  const { displayCols, hasOther } = useMemo(() => {
    const gIndex = new Map(genders.map((g, i) => [g, i]));
    const segAgg = columns.map(() => emptyAgg());
    const segGen = columns.map(() => genders.map(() => emptyAgg()));
    const otherAgg = emptyAgg();
    const otherGen = genders.map(() => emptyAgg());
    const totalAgg = emptyAgg();
    const totalGen = genders.map(() => emptyAgg());

    for (const r of rows) {
      addTo(totalAgg, r);
      const gi = gIndex.get(r.gender_code);
      if (gi != null) addTo(totalGen[gi], r);
      let idx = -1;
      for (let i = 0; i < columns.length; i++) { if (matches(r, columns[i])) { idx = i; break; } }
      if (idx >= 0) {
        addTo(segAgg[idx], r);
        if (gi != null) addTo(segGen[idx][gi], r);
      } else {
        addTo(otherAgg, r);
        if (gi != null) addTo(otherGen[gi], r);
      }
    }

    const hasOther = otherAgg.net !== 0 || otherAgg.qty !== 0;
    const cols: DisplayCol[] = columns.map((c, i) => ({
      key: c.id, label: c.label, kind: "seg" as const, agg: segAgg[i], genderAgg: segGen[i], filter: c,
    }));
    if (hasOther) cols.push({ key: "__other", label: "Other", kind: "other", agg: otherAgg, genderAgg: otherGen, filter: null });
    cols.push({
      key: "__total", label: "Total", kind: "total", agg: totalAgg, genderAgg: totalGen,
      filter: { id: "__total", label: "Total", brandCodes: [], channels: [], stores: [], genders: [] },
    });
    return { displayCols: cols, hasOther };
  }, [columns, rows, genders]);

  const gm = (a: Agg) => (a.cogsKnown ? a.net - a.cogs : null);
  const gmPct = (a: Agg) => (a.cogsKnown && a.net !== 0 ? (100 * (a.net - a.cogs)) / a.net : null);

  // Export: flatten measure × displayed column (segments + Other + Total) into rows.
  const exportRows = useMemo(() => {
    const out: Record<string, unknown>[] = [];
    const measure = (label: string, fn: (a: Agg) => number | null) => {
      const row: Record<string, unknown> = { measure: label };
      displayCols.forEach((c) => { row[c.label] = fn(c.agg); });
      out.push(row);
    };
    measure("Net Sales", (a) => a.net);
    if (byGender) {
      genders.forEach((g, gi) => {
        const row: Record<string, unknown> = { measure: `  ${genderLabel(g)} (net sales)` };
        displayCols.forEach((c) => { row[c.label] = c.genderAgg[gi]?.net ?? 0; });
        out.push(row);
      });
    }
    measure("COGS", (a) => (a.cogsKnown ? a.cogs : null));
    measure("Gross Margin", gm);
    measure("Gross Margin %", gmPct);
    measure("Units", (a) => a.qty);
    return out;
  }, [displayCols, genders, byGender]);

  const exportColumns: ExportColumn<Record<string, unknown>>[] = useMemo(() => [
    { key: "measure", header: "Measure" },
    ...displayCols.map((c) => ({ key: c.label, header: c.label, format: "number" as const })),
  ], [displayCols]);

  const colCount = displayCols.length;
  const numCell: React.CSSProperties = {
    padding: "8px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums",
    fontSize: 13, color: C.text, borderBottom: `1px solid ${C.cardBdr}`,
  };
  const labelCell: React.CSSProperties = {
    padding: "8px 12px", textAlign: "left", fontSize: 13, color: C.textSub,
    borderBottom: `1px solid ${C.cardBdr}`, position: "sticky", left: 0, background: C.card,
  };

  // Total column gets a left divider + bold; Other is muted/italic.
  const colCellStyle = (kind: DisplayCol["kind"], base: React.CSSProperties): React.CSSProperties => ({
    ...base,
    // Total is pinned to the RIGHT edge: sticky so it stays visible while scrolling
    // across many columns. Opaque bg + left divider so scrolled cells pass under it.
    ...(kind === "total" ? { borderLeft: `2px solid ${C.cardBdr}`, fontWeight: 700, background: "#0b1220", position: "sticky", right: 0, zIndex: 1 } : {}),
    ...(kind === "other" ? { fontStyle: "italic", color: C.textMuted } : {}),
  });

  // Open the GL drill for one cell. `gender` narrows a gender break-out row.
  function openCellDrill(c: DisplayCol, measure: "net_sales" | "cogs", measureLabel: string, gender?: string) {
    if (!c.filter) return; // "Other" has no filter form — not drillable
    setGlDrill({
      colLabel: c.label,
      measure,
      measureLabel,
      from,
      to,
      filters: {
        brands: c.filter.brandCodes,
        channels: c.filter.channels,
        stores: c.filter.stores,
        genders: gender ? [gender] : c.filter.genders,
      },
    });
  }

  function measureRow(label: string, fn: (a: Agg) => number | null, fmt: (v: number | null) => string, opts?: { bold?: boolean; color?: (v: number | null) => string; drill?: "net_sales" | "cogs" }) {
    return (
      <tr>
        <td style={{ ...labelCell, fontWeight: opts?.bold ? 700 : 400, color: opts?.bold ? C.text : C.textSub }}>{label}</td>
        {displayCols.map((c) => {
          const v = fn(c.agg);
          const col = opts?.color ? opts.color(v) : (c.kind === "other" ? C.textMuted : C.text);
          const drillable = !!opts?.drill && !!c.filter && v != null && v !== 0;
          return (
            <td
              key={c.key}
              style={colCellStyle(c.kind, {
                ...numCell, fontWeight: opts?.bold || c.kind === "total" ? 700 : 400, color: col,
                ...(drillable ? { cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 } : {}),
              })}
              onClick={drillable ? () => openCellDrill(c, opts!.drill!, label) : undefined}
              title={drillable ? "Show the GL accounts behind this number" : undefined}
            >
              {fmt(v)}
            </td>
          );
        })}
      </tr>
    );
  }

  return (
    <div style={{ background: C.bg, minHeight: "100%", color: C.text, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Segment P&amp;L</h2>
        <div style={{ fontSize: 11, color: C.textMuted, maxWidth: 520 }}>
          Revenue &amp; margin by Brand × Channel × Warehouse × Gender. Columns are configurable.
          Sourced from sales history (the Tangerine GL has no posted sales yet); wholesale and
          DTC (ROF / PT ecom) are both included.
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          From:
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ ...inputStyle, width: 150 }} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          To:
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ ...inputStyle, width: 150 }} />
        </label>
        <DateRangePresets variant="dropdown" from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
        <button onClick={() => void load()} style={btnSecondary}>Refresh</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub, cursor: "pointer" }}>
          <input type="checkbox" checked={byGender} onChange={(e) => setByGender(e.target.checked)} />
          Break out net sales by gender
        </label>
        <ExportButton rows={exportRows} filename={`segment-pl-${from}-to-${to}`} sheetName="Segment P&L" columns={exportColumns} />
      </div>

      {/* Column manager — drag a chip to reorder. */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: C.textMuted }}>Columns (drag to reorder):</span>
        {columns.map((c, i) => (
          <span
            key={c.id}
            draggable
            onDragStart={() => setDragIdx(i)}
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); if (dragIdx != null) moveColumn(dragIdx, i); setDragIdx(null); }}
            onDragEnd={() => setDragIdx(null)}
            title="Drag to reorder"
            style={{
              display: "inline-flex", alignItems: "center", gap: 6, background: dragIdx === i ? "#1e293b" : "#0b1220",
              border: `1px solid ${dragIdx === i ? C.primary : C.cardBdr}`, borderRadius: 14, padding: "4px 10px",
              fontSize: 12, cursor: "grab", opacity: dragIdx != null && dragIdx !== i ? 0.7 : 1,
            }}
          >
            <span style={{ color: C.textMuted, cursor: "grab", letterSpacing: -2 }}>⠿</span>
            {c.label}
            <button onClick={() => setEditing(c)} title="Edit column" style={{ background: "none", border: "none", color: C.primary, cursor: "pointer", fontSize: 12, padding: 0 }}>✎</button>
            <button onClick={() => setColumns((cs) => cs.filter((x) => x.id !== c.id))} title="Remove column" style={{ background: "none", border: "none", color: C.textMuted, cursor: "pointer", fontSize: 13, padding: 0 }}>✕</button>
          </span>
        ))}
        <button onClick={() => setEditing({ id: `c${Date.now() % 100000}`, label: "", brandCodes: [], channels: [], stores: [], genders: [] })} style={btnSecondary}>+ Add column</button>
        <button onClick={() => setColumns(defaultColumns())} style={btnSecondary} title="Reset to default segments">Reset</button>
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>Error: {err}</div>
      )}

      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: C.textMuted }}>Loading…</div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 480 + colCount * 120 }}>
            <thead>
              <tr>
                <th style={{ ...labelCell, color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600, borderBottom: `1px solid ${C.cardBdr}`, zIndex: 1 }}>Measure</th>
                {displayCols.map((c) => (
                  <th key={c.key} style={colCellStyle(c.kind, { ...numCell, color: c.kind === "total" ? C.text : C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, borderBottom: `1px solid ${C.cardBdr}` })}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {measureRow("Net Sales", (a) => a.net, money, { bold: true, drill: "net_sales" })}
              {byGender && genders.map((g, gi) => (
                <tr key={`g-${g}`}>
                  <td style={{ ...labelCell, paddingLeft: 28, color: C.textMuted, fontStyle: "italic" }}>{genderLabel(g)}</td>
                  {displayCols.map((c) => {
                    const v = c.genderAgg[gi]?.net ?? 0;
                    const drillable = !!c.filter && v !== 0;
                    return (
                      <td
                        key={c.key}
                        style={colCellStyle(c.kind, {
                          ...numCell, color: C.textSub,
                          ...(drillable ? { cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 } : {}),
                        })}
                        onClick={drillable ? () => openCellDrill(c, "net_sales", `Net Sales — ${genderLabel(g)}`, g) : undefined}
                        title={drillable ? "Show the GL accounts behind this number" : undefined}
                      >
                        {money(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {measureRow("COGS", (a) => (a.cogsKnown ? a.cogs : null), money, { drill: "cogs" })}
              {measureRow("Gross Margin", gm, money, { bold: true, color: (v) => (v == null ? C.textMuted : v >= 0 ? C.success : C.danger) })}
              {measureRow("Gross Margin %", gmPct, pct, { color: (v) => (v == null ? C.textMuted : v >= 0 ? C.success : C.danger) })}
              {measureRow("Units", (a) => a.qty, (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-US")))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ fontSize: 11, color: C.textMuted, fontStyle: "italic", marginTop: 10, maxWidth: 760 }}>
        Define a column as any filter over brand / channel / warehouse / gender — e.g. "Private Label" =
        MPL brands, "ROF DTC" = brand ROF + channel DTC. Empty filter = all values. <strong>Drag the chips
        to reorder.</strong> Each sale counts in the <em>first</em> matching column (left → right), and any
        sale not captured by your columns falls into <strong>Other</strong> — so the columns always sum to
        <strong> Total</strong>. COGS/margin are blank where the source has no cost. Click a Net Sales or
        COGS number to see the GL accounts behind it and walk down to the journal entries.
      </div>

      {glDrill && <SegmentGLDrillModal target={glDrill} onClose={() => setGlDrill(null)} />}

      {editing && (
        <ColumnEditor
          col={editing}
          dims={dims}
          genders={genders}
          onCancel={() => setEditing(null)}
          onSave={(c) => {
            setColumns((cs) => (cs.some((x) => x.id === c.id) ? cs.map((x) => (x.id === c.id ? c : x)) : [...cs, c]));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

// ── Column editor modal ──────────────────────────────────────────────────────
function ColumnEditor({ col, dims, genders, onSave, onCancel }: {
  col: ColFilter; dims: Dims; genders: string[];
  onSave: (c: ColFilter) => void; onCancel: () => void;
}) {
  const [label, setLabel] = useState(col.label);
  const [brandCodes, setBrandCodes] = useState<string[]>(col.brandCodes);
  const [channels, setChannels] = useState<string[]>(col.channels);
  const [stores, setStores] = useState<string[]>(col.stores);
  const [gendersSel, setGendersSel] = useState<string[]>(col.genders);

  const toggle = (arr: string[], v: string, set: (a: string[]) => void) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const chip = (active: boolean): React.CSSProperties => ({
    display: "inline-block", padding: "4px 10px", margin: "0 6px 6px 0", borderRadius: 14,
    border: `1px solid ${active ? C.primary : C.cardBdr}`, background: active ? C.primary : "#0b1220",
    color: active ? "white" : C.textSub, cursor: "pointer", fontSize: 12,
  });

  const group = (title: string, opts: { value: string; label: string }[], sel: string[], set: (a: string[]) => void) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6 }}>{title} <span style={{ fontStyle: "italic" }}>{sel.length ? "" : "(all)"}</span></div>
      <div>{opts.map((o) => (
        <span key={o.value} style={chip(sel.includes(o.value))} onClick={() => toggle(sel, o.value, set)}>{o.label}</span>
      ))}</div>
    </div>
  );

  const valid = label.trim().length > 0;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }} onClick={onCancel}>
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 12, width: "min(640px, 95vw)", maxHeight: "90vh", overflow: "auto", color: C.text }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 16, fontWeight: 600 }}>
          {col.label ? `Edit column — ${col.label}` : "Add column"}
        </div>
        <div style={{ padding: 18 }}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6 }}>Column name</div>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. ROF Wholesale" style={{ ...inputStyle, width: "100%" }} autoFocus />
          </div>
          {group("Brands", dims.brands.filter((b) => b.code).map((b) => ({ value: b.code as string, label: b.name })), brandCodes, setBrandCodes)}
          {group("Channels", dims.channels.map((c) => ({ value: c, label: c })), channels, setChannels)}
          {group("Warehouses / Stores", dims.stores.map((s) => ({ value: s, label: s })), stores, setStores)}
          {group("Genders", genders.map((g) => ({ value: g, label: genderLabel(g) })), gendersSel, setGendersSel)}
        </div>
        <div style={{ position: "sticky", bottom: 0, background: C.card, borderTop: `1px solid ${C.cardBdr}`, padding: "12px 18px", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onCancel} style={btnSecondary}>Cancel</button>
          <button
            disabled={!valid}
            onClick={() => onSave({ id: col.id, label: label.trim(), brandCodes, channels, stores, genders: gendersSel })}
            style={{ ...btnPrimary, opacity: valid ? 1 : 0.5, cursor: valid ? "pointer" : "not-allowed" }}
          >Save column</button>
        </div>
      </div>
    </div>
  );
}
