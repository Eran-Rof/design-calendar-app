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
// Source of record note: the Tangerine GL has no posted sales yet; this reports
// off the sales sub-ledgers (wholesale today; ecom once the Xoro import lands).

import { Fragment, useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import DateRangePresets from "./components/DateRangePresets.tsx";

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

const LS_KEY = "segment_pl_columns_v1";

// Default segments per the CEO request. ROF/PT DTC read $0 until the Xoro ecom
// import lands (all current data is wholesale) — expected, not a bug.
function defaultColumns(): ColFilter[] {
  return [
    { id: "total",  label: "Total",          brandCodes: [], channels: [], stores: [], genders: [] },
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
function aggregate(rows: BreakdownRow[]): Agg {
  let net = 0, cogs = 0, qty = 0, cogsKnown = false;
  for (const r of rows) {
    net += r.net_sales || 0;
    qty += r.qty || 0;
    if (r.cogs != null) { cogs += r.cogs; cogsKnown = true; }
  }
  return { net, cogs, cogsKnown, qty };
}

export default function InternalSegmentPL() {
  const [rows, setRows] = useState<BreakdownRow[]>([]);
  const [dims, setDims] = useState<Dims>({ brands: [], channels: [], stores: [], genders: [] });
  const [from, setFrom] = useState<string>(fyStartISO());
  const [to, setTo] = useState<string>(todayISO());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [byGender, setByGender] = useState(false);
  const [columns, setColumns] = useState<ColFilter[]>(() => {
    try { const s = localStorage.getItem(LS_KEY); if (s) return JSON.parse(s); } catch { /* ignore */ }
    return defaultColumns();
  });
  const [editing, setEditing] = useState<ColFilter | null>(null);

  useEffect(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(columns)); } catch { /* ignore */ } }, [columns]);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const p = new URLSearchParams();
      if (from) p.set("from", from);
      if (to) p.set("to", to);
      const r = await fetch(`/api/internal/segment-pl?${p.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json();
      setRows((data.breakdown || []) as BreakdownRow[]);
      setDims((data.dims || { brands: [], channels: [], stores: [], genders: [] }) as Dims);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Per-column aggregates (and per-gender within each column when expanded).
  const genders = useMemo(
    () => Array.from(new Set(rows.map((r) => r.gender_code))).sort(),
    [rows],
  );
  const colAgg = useMemo(
    () => columns.map((col) => aggregate(rows.filter((r) => matches(r, col)))),
    [columns, rows],
  );
  const colGenderAgg = useMemo(
    () => columns.map((col) =>
      genders.map((g) => aggregate(rows.filter((r) => matches(r, col) && r.gender_code === g)))),
    [columns, rows, genders],
  );

  const gm = (a: Agg) => (a.cogsKnown ? a.net - a.cogs : null);
  const gmPct = (a: Agg) => (a.cogsKnown && a.net !== 0 ? (100 * (a.net - a.cogs)) / a.net : null);

  // Export: flatten measure × column into rows.
  const exportRows = useMemo(() => {
    const out: Record<string, unknown>[] = [];
    const measure = (label: string, fn: (a: Agg) => number | null) => {
      const row: Record<string, unknown> = { measure: label };
      columns.forEach((c, i) => { row[c.label] = fn(colAgg[i]); });
      out.push(row);
    };
    measure("Net Sales", (a) => a.net);
    if (byGender) {
      genders.forEach((g, gi) => {
        const row: Record<string, unknown> = { measure: `  ${genderLabel(g)} (net sales)` };
        columns.forEach((c, i) => { row[c.label] = colGenderAgg[i][gi].net; });
        out.push(row);
      });
    }
    measure("COGS", (a) => (a.cogsKnown ? a.cogs : null));
    measure("Gross Margin", gm);
    measure("Gross Margin %", gmPct);
    measure("Units", (a) => a.qty);
    return out;
  }, [columns, colAgg, colGenderAgg, genders, byGender]);

  const exportColumns: ExportColumn<Record<string, unknown>>[] = useMemo(() => [
    { key: "measure", header: "Measure" },
    ...columns.map((c) => ({ key: c.label, header: c.label, format: "number" as const })),
  ], [columns]);

  const colCount = columns.length;
  const numCell: React.CSSProperties = {
    padding: "8px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums",
    fontSize: 13, color: C.text, borderBottom: `1px solid ${C.cardBdr}`,
  };
  const labelCell: React.CSSProperties = {
    padding: "8px 12px", textAlign: "left", fontSize: 13, color: C.textSub,
    borderBottom: `1px solid ${C.cardBdr}`, position: "sticky", left: 0, background: C.card,
  };

  function measureRow(label: string, fn: (a: Agg) => number | null, fmt: (v: number | null) => string, opts?: { bold?: boolean; color?: (v: number | null) => string }) {
    return (
      <tr>
        <td style={{ ...labelCell, fontWeight: opts?.bold ? 700 : 400, color: opts?.bold ? C.text : C.textSub }}>{label}</td>
        {columns.map((c, i) => {
          const v = fn(colAgg[i]);
          return (
            <td key={c.id} style={{ ...numCell, fontWeight: opts?.bold ? 700 : 400, color: opts?.color ? opts.color(v) : C.text }}>
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
          Sourced from sales history (the Tangerine GL has no posted sales yet); DTC columns
          populate once the Xoro ecom import lands.
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

      {/* Column manager */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: C.textMuted }}>Columns:</span>
        {columns.map((c) => (
          <span key={c.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 14, padding: "4px 10px", fontSize: 12 }}>
            {c.label}
            <button onClick={() => setEditing(c)} title="Edit column" style={{ background: "none", border: "none", color: C.primary, cursor: "pointer", fontSize: 12, padding: 0 }}>✎</button>
            {columns.length > 1 && (
              <button onClick={() => setColumns((cs) => cs.filter((x) => x.id !== c.id))} title="Remove column" style={{ background: "none", border: "none", color: C.textMuted, cursor: "pointer", fontSize: 13, padding: 0 }}>✕</button>
            )}
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
                {columns.map((c) => (
                  <th key={c.id} style={{ ...numCell, color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, borderBottom: `1px solid ${C.cardBdr}` }}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {measureRow("Net Sales", (a) => a.net, money, { bold: true })}
              {byGender && genders.map((g, gi) => (
                <tr key={`g-${g}`}>
                  <td style={{ ...labelCell, paddingLeft: 28, color: C.textMuted, fontStyle: "italic" }}>{genderLabel(g)}</td>
                  {columns.map((c, i) => (
                    <td key={c.id} style={{ ...numCell, color: C.textSub }}>{money(colGenderAgg[i][gi].net)}</td>
                  ))}
                </tr>
              ))}
              {measureRow("COGS", (a) => (a.cogsKnown ? a.cogs : null), money)}
              {measureRow("Gross Margin", gm, money, { bold: true, color: (v) => (v == null ? C.textMuted : v >= 0 ? C.success : C.danger) })}
              {measureRow("Gross Margin %", gmPct, pct, { color: (v) => (v == null ? C.textMuted : v >= 0 ? C.success : C.danger) })}
              {measureRow("Units", (a) => a.qty, (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-US")))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ fontSize: 11, color: C.textMuted, fontStyle: "italic", marginTop: 10 }}>
        Define a column as any filter over brand / channel / warehouse / gender — e.g. "Private Label" =
        MPL brands, "ROF DTC" = brand ROF + channel DTC. Empty filter = all values. COGS is blank where the
        source has no cost (ecom).
      </div>

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
