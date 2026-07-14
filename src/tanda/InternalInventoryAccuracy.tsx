// src/tanda/InternalInventoryAccuracy.tsx
//
// Inventory Accuracy — READ-ONLY on-hand divergence monitor. Surfaces the gap
// between Tangerine's LIVE on-hand (inventory_layers, the number the Inventory
// Matrix reads) and the authoritative Xoro REST by-size feed (tangerine_size_
// onhand). Backed by the v_inventory_onhand_reconcile view + the summary RPC
// (migration 20260997000000) via /api/internal/inventory-accuracy/*.
//
// This is a MEASUREMENT surface. It cannot fix stock — the root cause (phantom
// opening balances, two feeds disagreeing, disabled nightly syncs, no perpetual
// by-size ledger) needs the Xoro cutover. It shows exactly WHICH SKUs are wrong,
// by HOW MUCH, and the $ exposure at cost — the view the CEO never had.
//
// House UI rules: full-row click, no ↗ glyphs, blue identifiers, dark palette,
// dark selects, no decorative emoji, responsive modal min(cap,95vw)/90vh with a
// frozen footer, MM/DD/YYYY dates, no visible UUIDs, universal ExportButton.

import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtDateDisplay } from "../utils/tandaTypes";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";
import { useSeqGuard } from "./hooks/useSeqGuard";
import { SEVERITY_LABEL, type Severity } from "../lib/inventoryReconcile";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444", purple: "#A78BFA",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
const thR: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const tdR: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const selectStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, colorScheme: "dark" };
const inputStyle: React.CSSProperties = { ...selectStyle, minWidth: 220 };

const SEV_COLOR: Record<Severity, string> = {
  tie: C.textMuted, minor: C.warn, material: C.danger, phantom_suspect: C.purple,
};

type Row = {
  item_id: string;
  sku_code: string | null; style_code: string | null; color: string | null; size: string | null;
  description: string | null; category_id: string | null;
  layers_qty: number; rest_qty: number | null; rest_covered: boolean;
  ats_qty: number | null; phantom_qty: number | null;
  divergence: number; abs_divergence: number;
  unit_cost_cents: number; divergence_value_cents: number;
  is_negative: boolean; is_zero_cost: boolean; is_phantom_suspect: boolean;
  severity: Severity;
};
type Summary = {
  generated_at: string; rest_snapshot_date: string | null;
  skus_total: number; skus_tie: number; skus_minor: number; skus_material: number;
  skus_phantom: number; skus_divergent: number; sum_abs_units: number; exposure_cents: number;
  negative_skus: number; negative_units: number; zero_cost_skus: number; zero_cost_units: number;
  phantom_units: number; opening_residual_skus: number; opening_residual_units: number;
  layers_total_units: number; rest_total_units: number; ats_total_units: number; phantom_feed_units: number;
};
type TrendRow = {
  snapshot_date: string; skus_divergent: number; sum_abs_units: number; exposure_cents: number;
  skus_phantom: number; zero_cost_skus: number;
};
type Layer = {
  id: string; source_kind: string; remaining_qty: number; original_qty: number;
  unit_cost_cents: number | null; received_at: string | null; notes: string | null;
  location_code: string | null; location_name: string | null;
};
type RestSnap = { warehouse_code: string | null; snapshot_date: string; qty_on_hand: number; source: string | null };
type Detail = { row: Row | null; layers: Layer[]; rest_rows: RestSnap[] };

const n = (v: number | string | null | undefined) => {
  const x = typeof v === "string" ? Number(v) : v ?? 0;
  return Number.isFinite(x as number) ? (x as number) : 0;
};
const fmtInt = (v: number | string | null | undefined) => Math.round(n(v)).toLocaleString();
const fmtSignedInt = (v: number | string | null | undefined) => {
  const x = Math.round(n(v));
  return `${x > 0 ? "+" : ""}${x.toLocaleString()}`;
};
const fmtUsd = (cents: number | string | null | undefined) =>
  `$${(n(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const EXPORT_COLUMNS: ExportColumn<Record<string, unknown>>[] = [
  { key: "style_code", header: "Style" },
  { key: "color", header: "Color" },
  { key: "size", header: "Size" },
  { key: "severity", header: "Severity" },
  { key: "layers_qty", header: "Live layers" },
  { key: "rest_qty", header: "Xoro REST (truth)" },
  { key: "ats_qty", header: "ATS feed" },
  { key: "divergence", header: "Divergence (units)" },
  { key: "divergence_value_cents", header: "Exposure $", format: "currency_cents" },
  { key: "is_zero_cost", header: "Zero-cost layer" },
  { key: "is_negative", header: "Negative" },
];

const SEV_FILTERS: { key: "" | Severity; label: string }[] = [
  { key: "", label: "All divergent" },
  { key: "phantom_suspect", label: "Phantom-suspect" },
  { key: "material", label: "Material" },
  { key: "minor", label: "Minor" },
];

function Tile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: "12px 16px", minWidth: 150, flex: "1 1 150px" }}>
      <div style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ color: color || C.text, fontSize: 22, fontWeight: 700, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub ? <div style={{ color: C.textSub, fontSize: 12, marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

function SevBadge({ sev }: { sev: Severity }) {
  return (
    <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600, color: "#0b1220", background: SEV_COLOR[sev] }}>
      {SEVERITY_LABEL[sev]}
    </span>
  );
}

export default function InternalInventoryAccuracy() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [trend, setTrend] = useState<TrendRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sev, setSev] = useState<"" | Severity>("");
  const [search, setSearch] = useState("");
  const seqGuard = useSeqGuard();

  const [selected, setSelected] = useState<Row | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    const seq = seqGuard.begin();
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (sev) params.set("severity", sev);
      const r = await fetch(`/api/internal/inventory-accuracy/summary?${params.toString()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (!seqGuard.isCurrent(seq)) return;
      setSummary(data.summary || null);
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setTrend(Array.isArray(data.trend) ? data.trend : []);
    } catch (e) {
      if (!seqGuard.isCurrent(seq)) return;
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (seqGuard.isCurrent(seq)) setLoading(false);
    }
  }, [sev, seqGuard]);

  useEffect(() => { void load(); }, [load]);

  const openDetail = useCallback(async (row: Row) => {
    setSelected(row); setDetail(null); setDetailLoading(true);
    try {
      const r = await fetch(`/api/internal/inventory-accuracy/detail?item_id=${encodeURIComponent(row.item_id)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setDetail(await r.json());
    } catch {
      setDetail({ row, layers: [], rest_rows: [] });
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.style_code, r.sku_code, r.color, r.size, r.description].some((v) => (v || "").toLowerCase().includes(q)));
  }, [rows, search]);

  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(filtered, {
    persistKey: "tangerine:inv-accuracy:sort",
    accessors: { exposure: (r) => n(r.divergence_value_cents), absdiv: (r) => n(r.abs_divergence) },
  });

  // Trend delta: newest snapshot vs the one before it (only when ≥2 days recorded).
  const trendDelta = useMemo(() => {
    if (trend.length < 2) return null;
    const cur = trend[trend.length - 1];
    const prev = trend[trend.length - 2];
    return {
      exposure: n(cur.exposure_cents) - n(prev.exposure_cents),
      skus: n(cur.skus_divergent) - n(prev.skus_divergent),
      date: prev.snapshot_date,
    };
  }, [trend]);

  const exportRows = useMemo(() => sorted as unknown as Record<string, unknown>[], [sorted]);

  return (
    <div style={{ padding: 20, color: C.text, background: C.bg, minHeight: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Inventory Accuracy</h2>
          <div style={{ color: C.textSub, fontSize: 13, marginTop: 4, maxWidth: 760 }}>
            Live on-hand (FIFO layers) reconciled against the Xoro REST by-size feed — the authoritative truth.
            This is a read-only measurement: fixing the gaps requires the Xoro cutover.
            {summary?.rest_snapshot_date ? <> REST snapshot as of <strong>{fmtDateDisplay(summary.rest_snapshot_date)}</strong>.</> : null}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => void load()} style={{ background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>Refresh</button>
          <ExportButton rows={exportRows} columns={EXPORT_COLUMNS} filename="inventory-accuracy" sheetName="Inventory Accuracy" />
        </div>
      </div>

      {err ? (
        <div style={{ marginTop: 16, background: "#3f1d1d", border: `1px solid ${C.danger}`, borderRadius: 8, padding: 12, color: "#FCA5A5", fontSize: 13 }}>
          Failed to load: {err}
        </div>
      ) : null}

      {/* Scorecard */}
      {summary ? (
        <>
          <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
            <Tile label="SKUs divergent" value={fmtInt(summary.skus_divergent)} sub={`of ${fmtInt(summary.skus_total)} compared`} color={summary.skus_divergent > 0 ? C.warn : C.success} />
            <Tile label="Units off (Σ|Δ|)" value={fmtInt(summary.sum_abs_units)} sub="absolute unit divergence" color={C.warn} />
            <Tile label="$ exposure at cost" value={fmtUsd(summary.exposure_cents)} sub={trendDelta ? `${trendDelta.exposure >= 0 ? "▲" : "▼"} ${fmtUsd(Math.abs(trendDelta.exposure))} vs ${fmtDateDisplay(trendDelta.date)}` : "trend accrues daily"} color={C.danger} />
            <Tile label="Phantom-suspect" value={fmtInt(summary.skus_phantom)} sub={`${fmtInt(summary.phantom_units)} units overstated`} color={summary.skus_phantom > 0 ? C.purple : C.success} />
            <Tile label="Negative on-hand" value={fmtInt(summary.negative_skus)} sub="SKUs below zero" color={summary.negative_skus > 0 ? C.danger : C.success} />
            <Tile label="Zero-cost on-hand" value={fmtInt(summary.zero_cost_skus)} sub={`${fmtInt(summary.zero_cost_units)} units unvalued`} color={summary.zero_cost_skus > 0 ? C.warn : C.success} />
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
            <Tile label="Live layers total" value={fmtInt(summary.layers_total_units)} sub="app on-hand (units)" />
            <Tile label="Xoro REST total" value={fmtInt(summary.rest_total_units)} sub="by-size truth (units)" color={C.primary} />
            <Tile label="ATS feed total" value={fmtInt(summary.ats_total_units)} sub="manual snapshot (units)" />
            <Tile label="Severity mix" value={`${fmtInt(summary.skus_material)} / ${fmtInt(summary.skus_minor)}`} sub="material / minor SKUs" />
          </div>
        </>
      ) : null}

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, marginTop: 18, alignItems: "center", flexWrap: "wrap" }}>
        <select value={sev} onChange={(e) => setSev(e.target.value as "" | Severity)} style={selectStyle} aria-label="Severity filter">
          {SEV_FILTERS.map((f) => <option key={f.key || "all"} value={f.key}>{f.label}</option>)}
        </select>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search style / color / size…" style={inputStyle} />
        <span style={{ color: C.textMuted, fontSize: 12 }}>{loading ? "Loading…" : `${fmtInt(filtered.length)} row(s)`}</span>
      </div>

      {/* Grid */}
      <div style={{ marginTop: 10, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "auto", maxHeight: "60vh" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
          <thead>
            <tr>
              <SortableTh label="Style" sortKey="style_code" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
              <SortableTh label="Color" sortKey="color" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
              <SortableTh label="Size" sortKey="size" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
              <SortableTh label="Severity" sortKey="severity" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
              <SortableTh label="Live layers" sortKey="layers_qty" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thR} cellStyle={{ textAlign: "right" }} />
              <SortableTh label="Xoro REST" sortKey="rest_qty" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thR} cellStyle={{ textAlign: "right" }} />
              <SortableTh label="ATS" sortKey="ats_qty" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thR} cellStyle={{ textAlign: "right" }} />
              <SortableTh label="Δ units" sortKey="absdiv" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thR} cellStyle={{ textAlign: "right" }} />
              <SortableTh label="Exposure $" sortKey="exposure" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thR} cellStyle={{ textAlign: "right" }} />
              <th style={th}>Flags</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.item_id} onClick={() => void openDetail(r)} style={{ cursor: "pointer" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#172033")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                <td style={{ ...td, color: C.primary, fontWeight: 600 }}>{r.style_code || "—"}</td>
                <td style={td}>{r.color || "—"}</td>
                <td style={td}>{r.size || "—"}</td>
                <td style={td}><SevBadge sev={r.severity} /></td>
                <td style={tdR}>{fmtInt(r.layers_qty)}</td>
                <td style={tdR}>{r.rest_covered ? fmtInt(r.rest_qty) : "—"}</td>
                <td style={tdR}>{r.ats_qty == null ? "—" : fmtInt(r.ats_qty)}</td>
                <td style={{ ...tdR, color: n(r.divergence) > 0 ? C.danger : C.warn, fontWeight: 600 }}>{fmtSignedInt(r.divergence)}</td>
                <td style={tdR}>{fmtUsd(r.divergence_value_cents)}</td>
                <td style={td}>
                  {r.is_phantom_suspect ? <span title="Phantom-suspect" style={{ color: C.purple, marginRight: 6 }}>phantom</span> : null}
                  {r.is_zero_cost ? <span title="On-hand on a zero-cost layer" style={{ color: C.warn, marginRight: 6 }}>zero-cost</span> : null}
                  {r.is_negative ? <span title="Negative on-hand" style={{ color: C.danger }}>negative</span> : null}
                </td>
              </tr>
            ))}
            {!loading && sorted.length === 0 ? (
              <tr><td colSpan={10} style={{ ...td, textAlign: "center", color: C.textMuted, padding: 24 }}>No divergent SKUs for this filter.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {selected ? (
        <DetailModal selected={selected} detail={detail} loading={detailLoading} onClose={() => { setSelected(null); setDetail(null); }} />
      ) : null}
    </div>
  );
}

function FeedCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "10px 12px", flex: "1 1 120px" }}>
      <div style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ color: color || C.text, fontSize: 18, fontWeight: 700, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

function DetailModal({ selected, detail, loading, onClose }: { selected: Row; detail: Detail | null; loading: boolean; onClose: () => void }) {
  const row = detail?.row || selected;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 12, width: "min(920px, 95vw)", maxHeight: "90vh", display: "flex", flexDirection: "column", color: C.text }}>
        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.cardBdr}` }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: C.primary }}>{selected.style_code || selected.sku_code || "SKU"}</div>
          <div style={{ color: C.textSub, fontSize: 13, marginTop: 2 }}>
            {[selected.color, selected.size].filter(Boolean).join(" · ") || "—"}
            {selected.description ? <> — {selected.description}</> : null}
          </div>
        </div>

        {/* Body (scrolls) */}
        <div style={{ padding: 20, overflowY: "auto" }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <FeedCell label="Live layers" value={fmtInt(row.layers_qty)} />
            <FeedCell label="Xoro REST (truth)" value={row.rest_covered ? fmtInt(row.rest_qty) : "not in REST"} color={C.primary} />
            <FeedCell label="ATS feed" value={row.ats_qty == null ? "—" : fmtInt(row.ats_qty)} />
            <FeedCell label="Phantom feed" value={row.phantom_qty == null ? "—" : fmtInt(row.phantom_qty)} color={C.purple} />
            <FeedCell label="Divergence" value={fmtSignedInt(row.divergence)} color={n(row.divergence) > 0 ? C.danger : C.warn} />
            <FeedCell label="Exposure $" value={fmtUsd(row.divergence_value_cents)} color={C.danger} />
          </div>

          <div style={{ marginTop: 8, color: C.textSub, fontSize: 12 }}>
            Severity <SevBadge sev={row.severity} />
            {row.is_phantom_suspect ? <span style={{ color: C.purple, marginLeft: 8 }}>· phantom-suspect (app shows stock REST says is gone)</span> : null}
            {row.is_zero_cost ? <span style={{ color: C.warn, marginLeft: 8 }}>· on-hand carried on a zero-cost layer</span> : null}
            {row.is_negative ? <span style={{ color: C.danger, marginLeft: 8 }}>· negative on-hand</span> : null}
          </div>

          {/* FIFO layers */}
          <div style={{ marginTop: 18, fontSize: 13, fontWeight: 600, color: C.textSub }}>FIFO layers (live on-hand build-up)</div>
          <div style={{ marginTop: 6, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
              <thead><tr>
                <th style={th}>Source kind</th><th style={th}>Warehouse</th>
                <th style={thR}>Remaining</th><th style={thR}>Original</th><th style={thR}>Unit cost</th><th style={th}>Received</th>
              </tr></thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} style={{ ...td, textAlign: "center", color: C.textMuted }}>Loading…</td></tr>
                ) : (detail?.layers || []).length === 0 ? (
                  <tr><td colSpan={6} style={{ ...td, textAlign: "center", color: C.textMuted }}>No FIFO layers — the live app shows zero on-hand for this SKU.</td></tr>
                ) : (detail?.layers || []).map((l) => (
                  <tr key={l.id}>
                    <td style={td}>{l.source_kind}</td>
                    <td style={td}>{l.location_name || l.location_code || "—"}</td>
                    <td style={tdR}>{fmtInt(l.remaining_qty)}</td>
                    <td style={tdR}>{fmtInt(l.original_qty)}</td>
                    <td style={tdR}>{l.unit_cost_cents == null ? "—" : fmtUsd(l.unit_cost_cents)}</td>
                    <td style={td}>{l.received_at ? fmtDateDisplay(l.received_at) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* REST snapshot rows */}
          <div style={{ marginTop: 18, fontSize: 13, fontWeight: 600, color: C.textSub }}>Xoro REST by-size snapshot (truth)</div>
          <div style={{ marginTop: 6, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 420 }}>
              <thead><tr>
                <th style={th}>Warehouse</th><th style={th}>Snapshot date</th><th style={thR}>Qty on hand</th>
              </tr></thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={3} style={{ ...td, textAlign: "center", color: C.textMuted }}>Loading…</td></tr>
                ) : (detail?.rest_rows || []).length === 0 ? (
                  <tr><td colSpan={3} style={{ ...td, textAlign: "center", color: C.textMuted }}>This SKU is absent from the Xoro REST feed.</td></tr>
                ) : (detail?.rest_rows || []).map((s, i) => (
                  <tr key={`${s.warehouse_code}-${s.snapshot_date}-${i}`}>
                    <td style={td}>{s.warehouse_code || "—"}</td>
                    <td style={td}>{fmtDateDisplay(s.snapshot_date)}</td>
                    <td style={tdR}>{fmtInt(s.qty_on_hand)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Frozen footer */}
        <div style={{ padding: "12px 20px", borderTop: `1px solid ${C.cardBdr}`, display: "flex", justifyContent: "flex-end", background: C.card, borderRadius: "0 0 12px 12px" }}>
          <button onClick={onClose} style={{ background: C.primary, color: "white", border: 0, padding: "8px 18px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Close</button>
        </div>
      </div>
    </div>
  );
}
