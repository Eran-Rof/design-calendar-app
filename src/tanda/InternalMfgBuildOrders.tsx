// src/tanda/InternalMfgBuildOrders.tsx
//
// Tangerine — Manufacturing Build Orders.
// Assemble a finished style from its BOM: draft → release → issue (parts/styles
// into WIP at FIFO cost) → capitalize conversion services → complete (WIP →
// finished-goods inventory at actual cost). Shows the live WIP cost rollup.

import { useCallback, useEffect, useRef, useState } from "react";
import { notify, confirmDialog, promptDialog } from "../shared/ui/warn";
import { getCachedAuthUserId } from "../utils/tangerineAuthUser";
import QuickAddStyleModal from "./components/QuickAddStyleModal";
import { EditableSizeMatrix, matrixCellKey, type EditableMatrixRow } from "../shared/matrix/EditableSizeMatrix";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useStyleThumbs, StyleThumb } from "../shared/ui/StyleThumb";
import { usePartThumbs, PartThumb } from "../shared/ui/PartThumb";
import DocumentAttachmentList from "../shared/documents/DocumentAttachmentList";

type CustLite = { id: string; name: string; code?: string | null; customer_code?: string | null };
type Component = {
  id: string;
  component_kind: "part" | "service" | "finished_style";
  part_id?: string | null;
  qty_required: number; qty_consumed: number; actual_cost_cents: number;
  service_charge_cents: number | null; service_capitalized: boolean; service_vendor_name: string | null;
  component_code: string | null; component_label: string | null;
  // #8 — projected (pre-capitalize) cost derived from master defaults / avg cost.
  projected_unit_cost_cents?: number | null; projected_cost_cents?: number | null;
};
type ProjRollup = { parts_cost_cents: number; style_cost_cents: number; service_cost_cents: number; total_cents: number; has_estimate: boolean; missing_costs: number };
type Rollup = { parts_cost_cents: number; style_cost_cents: number; service_cost_cents: number; total_cents: number; projected?: ProjRollup };
type BuildOutput = { id: string; item_id: string; color: string | null; size: string | null; qty: number; unit_cost_cents: number };
type Build = {
  id: string; build_number: string; finished_item_id: string; target_qty: number; completed_qty: number;
  status: "draft" | "released" | "issued" | "in_progress" | "completed" | "cancelled";
  accumulated_cost_cents: number; finished_unit_cost_cents: number | null;
  finished_item?: { sku_code: string; description: string | null; color?: string | null } | null;
  finished_style_id?: string | null;
  outputs?: BuildOutput[];
  customer_id?: string | null; customer_name?: string | null; customer_style_number?: string | null;
  components?: Component[]; rollup?: Rollup;
  // M11 — conversion PO (outsourced CMT). mode drives GL: procurement (document
  // only) or capitalize (AP bill capitalizes CMT into WIP).
  conversion_po_id?: string | null;
  conversion_po_mode?: "procurement" | "capitalize";
  conversion_po?: { id: string; po_number: string | null; status: string; vendor_id: string | null; total_cents: number | null } | null;
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12 };
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d" };
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box" };
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const STATUS_COLOR: Record<string, string> = { draft: C.textMuted, released: C.primary, issued: C.warn, in_progress: C.warn, completed: C.success, cancelled: C.danger };
const KIND_LABEL: Record<string, string> = { part: "Part", service: "Service", finished_style: "Finished style" };
const money = (c: number | null | undefined) => c == null ? "—" : `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function InternalMfgBuildOrders() {
  const [rows, setRows] = useState<Build[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/build-orders`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as Build[]);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  // Item 2 — delete a build line. The server only deletes draft/cancelled builds
  // (components cascade); we check whether a BOM is attached (snapshotted on
  // Release) and warn before deleting so the operator can continue or cancel.
  async function handleDelete(b: Build) {
    if (b.status !== "draft" && b.status !== "cancelled") {
      notify("Only a draft or cancelled build can be deleted — cancel it first.", "error");
      return;
    }
    let hasBom = b.status !== "draft"; // fallback heuristic if the detail fetch fails
    try {
      const r = await fetch(`/api/internal/build-orders/${b.id}`);
      if (r.ok) { const full = await r.json() as Build; hasBom = Array.isArray(full.components) && full.components.length > 0; }
    } catch { /* keep heuristic */ }
    const ok = await confirmDialog(
      hasBom
        ? `Build ${b.build_number} has a BOM attached (its components are snapshotted). Deleting removes the build and its components. Continue?`
        : `Delete build ${b.build_number}? This can't be undone.`,
    );
    if (!ok) return;
    try {
      const r = await fetch(`/api/internal/build-orders/${b.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify(`Build ${b.build_number} deleted.`, "success");
      void load();
    } catch (e: unknown) { notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error"); }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Build Orders</h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: C.textMuted }}>
            Assemble a finished style from its BOM. Costs flow through WIP to finished-goods inventory at actual cost.
          </p>
        </div>
        <button onClick={() => setNewOpen(true)} style={btnPrimary}>+ New build</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center" }}>
        <ExportButton
          rows={rows.map((b) => ({ build_number: b.build_number, finished_sku: b.finished_item?.sku_code ?? "", target_qty: b.target_qty, status: b.status, accumulated_cost_cents: b.accumulated_cost_cents, finished_unit_cost_cents: b.finished_unit_cost_cents })) as unknown as Array<Record<string, unknown>>}
          filename="build-orders"
          sheetName="Build Orders"
          columns={[
            { key: "build_number", header: "Build #" },
            { key: "finished_sku", header: "Finished SKU" },
            { key: "target_qty", header: "Target Qty", format: "number" },
            { key: "status", header: "Status" },
            { key: "accumulated_cost_cents", header: "WIP/Accum Cost", format: "currency_cents" },
            { key: "finished_unit_cost_cents", header: "Finished Unit Cost", format: "currency_cents" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>Error: {err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        {loading ? <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
          : rows.length === 0 ? <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No build orders yet. Create one with &quot;+ New build&quot;.</div>
          : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Build #</th>
                  <th style={th}>Finished Style</th>
                  <th style={{ ...th, textAlign: "right" }}>Target</th>
                  <th style={th}>Status</th>
                  <th style={{ ...th, textAlign: "right" }}>WIP/Accum</th>
                  <th style={{ ...th, textAlign: "right" }}>Unit Cost</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id} style={{ cursor: "pointer" }} onClick={() => setDetailId(b.id)}>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>{b.build_number}</td>
                    <td style={td}>{b.finished_item?.sku_code ?? "—"}{b.finished_item?.description ? <span style={{ color: C.textSub }}> — {b.finished_item.description}</span> : null}</td>
                    <td style={{ ...td, textAlign: "right" }}>{b.target_qty.toLocaleString()}</td>
                    <td style={td}><span style={{ color: STATUS_COLOR[b.status] }}>{b.status}</span></td>
                    <td style={{ ...td, textAlign: "right" }}>{money(b.accumulated_cost_cents)}</td>
                    <td style={{ ...td, textAlign: "right" }}>{money(b.finished_unit_cost_cents)}</td>
                    {/* Item 2 — delete a build (draft/cancelled only; warns when a BOM is attached). */}
                    <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                      {(b.status === "draft" || b.status === "cancelled") && (
                        <button style={btnDanger} onClick={() => void handleDelete(b)}>Del</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {newOpen && <NewBuildModal onClose={() => setNewOpen(false)} onCreated={(bid) => { setNewOpen(false); void load(); setDetailId(bid); }} />}
      {detailId && <BuildDetail buildId={detailId} onClose={() => setDetailId(null)} onChanged={() => void load()} />}
    </div>
  );
}

// Item G — search BASE STYLES (one row per style, code + name), not per-size
// SKUs, so the finished good of a build/BOM is a style. Backed by style-master.
type StyleLite = { id: string; style_code: string; style_name: string | null; description?: string | null };
function StylePicker({ onChange, placeholder }: { onChange: (styleId: string, label: string, styleCode: string) => void; placeholder?: string }) {
  const [q, setQ] = useState(""); const [open, setOpen] = useState(false); const [results, setResults] = useState<StyleLite[]>([]);
  const [chosen, setChosen] = useState(""); const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!open) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try { const r = await fetch(`/api/internal/style-master?q=${encodeURIComponent(q)}&limit=25`); if (r.ok) { const j = await r.json(); setResults((Array.isArray(j) ? j : (j.rows || j.data || [])) as StyleLite[]); } } catch { /* */ }
    }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q, open]);
  return (
    <div style={{ position: "relative" }}>
      <input style={inputStyle} placeholder={placeholder || "Search the style to build…"} value={open ? q : chosen} onFocus={() => { setOpen(true); setQ(""); }} onChange={(e) => setQ(e.target.value)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && results.length > 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 30, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 6, maxHeight: 220, overflowY: "auto", marginTop: 2 }}>
          {results.map((s) => {
            const name = s.style_name || s.description || "";
            return (
              <div key={s.id} onMouseDown={() => { const label = `${s.style_code}${name ? ` — ${name}` : ""}`; setChosen(label); onChange(s.id, label, s.style_code); setOpen(false); }} style={{ padding: "6px 10px", cursor: "pointer", fontSize: 13, borderBottom: `1px solid ${C.cardBdr}` }}>
                <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>{s.style_code}</span>{name ? <span style={{ color: C.textSub }}> — {name}</span> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Phase B — pick the customer this build is for (optional). Mirrors ItemPicker;
// searches the customer master by name / code.
function CustomerPicker({ onChange }: { onChange: (cust: CustLite | null) => void }) {
  const [q, setQ] = useState(""); const [open, setOpen] = useState(false); const [results, setResults] = useState<CustLite[]>([]);
  const [chosen, setChosen] = useState(""); const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!open) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try { const r = await fetch(`/api/internal/customer-master?q=${encodeURIComponent(q)}&limit=25`); if (r.ok) { const j = await r.json(); setResults(Array.isArray(j) ? j : (j.rows || j.data || [])); } } catch { /* */ }
    }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q, open]);
  return (
    <div style={{ position: "relative" }}>
      <input style={inputStyle} placeholder="Search a customer (optional)…" value={open ? q : chosen}
        onFocus={() => { setOpen(true); setQ(""); }} onChange={(e) => setQ(e.target.value)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {chosen && !open && <button type="button" onMouseDown={() => { setChosen(""); onChange(null); }} title="Clear customer" style={{ position: "absolute", right: 6, top: 6, background: "none", border: 0, color: C.textMuted, cursor: "pointer", fontSize: 13 }}>✕</button>}
      {open && results.length > 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 30, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 6, maxHeight: 220, overflowY: "auto", marginTop: 2 }}>
          {results.map((c) => (
            <div key={c.id} onMouseDown={() => { setChosen(`${c.name}${c.code ? ` (${c.code})` : ""}`); onChange(c); setOpen(false); }} style={{ padding: "6px 10px", cursor: "pointer", fontSize: 13, borderBottom: `1px solid ${C.cardBdr}` }}>
              {c.name}{c.code ? <span style={{ color: C.textMuted, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 11 }}> · {c.code}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Fetches a style's scale (sizes/colors) and renders the shared size matrix so
// the operator can plan the run by size at build creation. Reports the filled
// cells + total up to the parent. Falls back to a note when the style has no
// scale (parent then shows a plain target field).
type StyleSku = { color: string | null; size: string | null; on_hand_qty?: number | null };
function PlannedSizeMatrix({ styleId, defaultColor, onChange }: {
  styleId: string; defaultColor: string | null;
  onChange: (outputs: { color: string | null; size: string; qty: number }[], total: number, hasScale: boolean) => void;
}) {
  const [sizes, setSizes] = useState<string[]>([]);
  const [colors, setColors] = useState<string[]>([]);
  const [onHand, setOnHand] = useState<Record<string, number>>({});
  const [qty, setQty] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true; setLoading(true); setQty({});
    (async () => {
      try {
        const r = await fetch(`/api/internal/style-matrix?style_id=${styleId}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        if (!alive) return;
        const szs: string[] = Array.isArray(j.sizes) ? j.sizes.filter(Boolean) : [];
        let cols: string[] = Array.isArray(j.colors) ? j.colors.filter(Boolean) : [];
        if (cols.length === 0) cols = [defaultColor || "—"];
        // #10 — build a per-(color,size) on-hand map so each FG cell shows a
        // faint on-hand hint (mirrors SO entry). Cells with no color fold onto
        // the single "—" row when the style has no colour scale.
        const oh: Record<string, number> = {};
        for (const s of (Array.isArray(j.skus) ? j.skus : []) as StyleSku[]) {
          if (!s.size) continue;
          const rowKey = cols.includes(s.color || "") ? (s.color as string) : cols[0];
          const k = matrixCellKey(rowKey, s.size);
          oh[k] = (oh[k] || 0) + (Number(s.on_hand_qty) || 0);
        }
        setSizes(szs); setColors(cols); setOnHand(oh);
      } catch (e: unknown) { if (alive) setLoadErr(e instanceof Error ? e.message : String(e)); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [styleId, defaultColor]);
  useEffect(() => {
    const outs: { color: string | null; size: string; qty: number }[] = [];
    let total = 0;
    for (const c of colors) for (const sz of sizes) {
      const v = Number(qty[matrixCellKey(c, sz)] || 0);
      if (v > 0) { outs.push({ color: c === "—" ? (defaultColor || null) : c, size: sz, qty: v }); total += v; }
    }
    onChange(outs, total, sizes.length > 0);
  }, [qty, colors, sizes, defaultColor, onChange]);

  if (loading) return <div style={{ color: C.textMuted, fontSize: 12 }}>Loading sizes…</div>;
  if (loadErr) return <div style={{ background: "#7f1d1d", color: "white", padding: "6px 10px", borderRadius: 6, fontSize: 12 }}>{loadErr}</div>;
  if (sizes.length === 0) return <div style={{ color: C.warn, fontSize: 12 }}>No size scale on this style — enter a total quantity below.</div>;
  const rows: EditableMatrixRow[] = colors.map((c) => ({ key: c, color: c }));
  return <EditableSizeMatrix rows={rows} sizes={sizes} qty={qty} onHand={onHand} onHandTitle="finished-goods on-hand" onQtyChange={(rowKey, size, value) => setQty((p) => ({ ...p, [matrixCellKey(rowKey, size)]: value }))} />;
}

// #1/#2/#10 — BOM-driven state for the New Build modal.
type BomLite = {
  id: string; finished_style_id: string | null; customer_id: string | null; customer_name: string | null;
  status: "draft" | "active" | "archived"; version: number | null; component_count?: number;
};
type BomComponentLite = {
  component_kind: "part" | "service" | "finished_style";
  part_id: string | null; service_item_id: string | null; component_item_id: string | null;
  qty_per_unit: number; scrap_pct: number;
  component_code: string | null; component_label: string | null;
};
type BomDetail = BomLite & { components: BomComponentLite[] };
type PartAvail = { part_id: string; code: string | null; name: string; uom: string | null; on_hand_qty: number };

// #10 — parts + services availability under the FG plan. For each PART component
// of the active BOM: required = qty_per_unit × (1 + scrap%) × plan total units;
// ATU = aggregate part on-hand from /part-inventory (per-size part data is NOT
// available from existing endpoints, so this is an AGGREGATE first version —
// on-PO is likewise not exposed, so we show on-hand only). Warns when required
// exceeds on-hand (informational; never blocks the build).
function BuildAvailability({ bom, planTotal }: { bom: BomDetail; planTotal: number }) {
  const [avail, setAvail] = useState<Record<string, PartAvail>>({});
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true; setLoading(true);
    (async () => {
      try {
        // One fetch of on-hand parts (include_zero so parts we hold none of still
        // resolve to 0 rather than "unknown").
        const r = await fetch(`/api/internal/part-inventory?include_zero=true`);
        if (r.ok) {
          const rows = (await r.json()) as PartAvail[];
          if (!alive) return;
          const by: Record<string, PartAvail> = {};
          for (const p of Array.isArray(rows) ? rows : []) by[p.part_id] = p;
          setAvail(by);
        }
      } catch { /* leave availability unknown */ }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [bom.id]);

  const parts = bom.components.filter((c) => c.component_kind === "part");
  const services = bom.components.filter((c) => c.component_kind === "service");
  const styleComps = bom.components.filter((c) => c.component_kind === "finished_style");
  const units = planTotal > 0 ? planTotal : 0;

  return (
    <div style={{ marginTop: 14 }}>
      {/* Parts availability */}
      {parts.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <Lbl>Parts availability {units > 0 ? <span style={{ color: C.textMuted, fontWeight: 400 }}>· for {units} unit{units === 1 ? "" : "s"}</span> : null}</Lbl>
          <div style={{ background: "#0F172A", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr>
                <th style={th}>Part</th>
                <th style={{ ...th, textAlign: "right" }}>Per unit</th>
                <th style={{ ...th, textAlign: "right" }}>Required</th>
                <th style={{ ...th, textAlign: "right" }}>On-hand</th>
                <th style={th}></th>
              </tr></thead>
              <tbody>
                {parts.map((c, i) => {
                  const perUnit = Number(c.qty_per_unit) * (1 + Number(c.scrap_pct) / 100);
                  const required = units > 0 ? perUnit * units : 0;
                  const a = c.part_id ? avail[c.part_id] : undefined;
                  const onHand = a?.on_hand_qty ?? (loading ? null : 0);
                  const short = onHand != null && units > 0 && required > onHand;
                  const fmt = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(2);
                  return (
                    <tr key={i}>
                      <td style={td}><span style={{ fontFamily: "SFMono-Regular, Menlo, monospace" }}>{c.component_code ?? "—"}</span>{c.component_label ? <span style={{ color: C.textSub }}> — {c.component_label}</span> : null}{a?.uom ? <span style={{ color: C.textMuted }}> ({a.uom})</span> : null}</td>
                      <td style={{ ...td, textAlign: "right", color: C.textSub }}>{fmt(perUnit)}</td>
                      <td style={{ ...td, textAlign: "right", color: short ? C.warn : C.text }}>{units > 0 ? fmt(required) : "—"}</td>
                      <td style={{ ...td, textAlign: "right", color: C.textSub }}>{onHand == null ? "…" : fmt(onHand)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{short ? <span style={{ color: C.warn, fontSize: 11 }} title="Building from inventory you don't have">⚠ short {fmt(required - (onHand || 0))}</span> : (onHand != null && units > 0 ? <span style={{ color: C.success, fontSize: 11 }}>✓</span> : null)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 10, color: C.textMuted, marginTop: 4 }}>On-hand is an aggregate across sizes/warehouses (per-size part inventory and on-PO are not yet exposed). Shortages warn only — they don't block the build.</div>
        </div>
      )}

      {/* Consumed finished-styles (sub-assemblies), if any */}
      {styleComps.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <Lbl>Consumed styles</Lbl>
          <div style={{ background: "#0F172A", border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "8px 10px", fontSize: 12, color: C.textSub }}>
            {styleComps.map((c, i) => (
              <div key={i}><span style={{ fontFamily: "SFMono-Regular, Menlo, monospace" }}>{c.component_code ?? "—"}</span>{c.component_label ? ` — ${c.component_label}` : ""} · {Number(c.qty_per_unit)}/unit</div>
            ))}
          </div>
        </div>
      )}

      {/* Services — labor, no inventory/ATU */}
      {services.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <Lbl>Services (labor — no inventory)</Lbl>
          <div style={{ background: "#0F172A", border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "8px 10px", fontSize: 12, color: C.textSub }}>
            {services.map((c, i) => (
              <div key={i}><span style={{ fontFamily: "SFMono-Regular, Menlo, monospace" }}>{c.component_code ?? "—"}</span>{c.component_label ? ` — ${c.component_label}` : ""}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NewBuildModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [finishedStyleId, setFinishedStyleId] = useState("");
  const [pickedLabel, setPickedLabel] = useState("");
  const [styleCode, setStyleCode] = useState<string | null>(null);
  const [defaultColor, setDefaultColor] = useState<string | null>(null);
  const [targetQty, setTargetQty] = useState("");
  const [plan, setPlan] = useState<{ outputs: { color: string | null; size: string; qty: number }[]; total: number; hasScale: boolean }>({ outputs: [], total: 0, hasScale: false });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Item 1 — add a style on the fly (admins only; others get a warning).
  const isAdmin = !!getCachedAuthUserId();
  const [addStyleOpen, setAddStyleOpen] = useState(false);
  // Phase B — build FOR a customer (optional) + that customer's style number.
  const [customer, setCustomer] = useState<CustLite | null>(null);
  const [custStyleNumber, setCustStyleNumber] = useState("");
  const [custStyleTouched, setCustStyleTouched] = useState(false);
  // #1/#2 — the style's usable (active) BOM gates the build. bomState tracks the
  // fetch; activeBom is the resolved BOM detail (with components) once available.
  const [bomState, setBomState] = useState<"idle" | "loading" | "no-bom" | "draft-only" | "active" | "activating">("idle");
  const [activeBom, setActiveBom] = useState<BomDetail | null>(null);
  const [custTouched, setCustTouched] = useState(false); // operator picked a customer manually → don't auto-clobber

  // #1/#2 — after a style is picked, load its BOMs. Prefer an ACTIVE BOM (choose
  // the one matching an already-selected customer, else a generic one). If only
  // a DRAFT exists, offer to activate it. If none, block the build.
  const resolveBom = useCallback(async (styleId: string, forCustomerId: string | null) => {
    setBomState("loading"); setActiveBom(null);
    try {
      const r = await fetch(`/api/internal/mfg-boms`); // all non-archived
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const all = (await r.json()) as BomLite[];
      const mine = (Array.isArray(all) ? all : []).filter((b) => b.finished_style_id === styleId);
      if (mine.length === 0) { setBomState("no-bom"); return; }
      const actives = mine.filter((b) => b.status === "active");
      // Prefer customer-matched active, then generic (no customer), then any active.
      const pick = actives.find((b) => forCustomerId && b.customer_id === forCustomerId)
        || actives.find((b) => !b.customer_id)
        || actives[0];
      if (pick) {
        const d = await fetch(`/api/internal/mfg-boms/${pick.id}`);
        if (d.ok) { setActiveBom((await d.json()) as BomDetail); setBomState("active"); return; }
      }
      // No active BOM — is there a draft we can activate?
      if (mine.some((b) => b.status === "draft")) { setBomState("draft-only"); return; }
      setBomState("no-bom");
    } catch { setBomState("no-bom"); }
  }, []);

  // #1 — activate a draft BOM in place (PATCH → status:active), then re-resolve.
  async function activateDraft() {
    if (!finishedStyleId) return;
    const ok = await confirmDialog("This style's BOM is still Draft. Activate it now so it can be built?");
    if (!ok) return;
    setBomState("activating");
    try {
      const r = await fetch(`/api/internal/mfg-boms`);
      const all = r.ok ? ((await r.json()) as BomLite[]) : [];
      const draft = (Array.isArray(all) ? all : []).find((b) => b.finished_style_id === finishedStyleId && b.status === "draft");
      if (!draft) { notify("No draft BOM found to activate — pick another style.", "error"); setBomState("no-bom"); return; }
      const patch = await fetch(`/api/internal/mfg-boms/${draft.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "active" }) });
      if (!patch.ok) throw new Error((await patch.json().catch(() => ({}))).error || `HTTP ${patch.status}`);
      notify("BOM activated.", "success");
      await resolveBom(finishedStyleId, customer?.id ?? null);
    } catch (e: unknown) { notify(`Activate failed: ${e instanceof Error ? e.message : String(e)}`, "error"); setBomState("draft-only"); }
  }

  // Re-resolve when the style or the picked customer changes (a customer-specific
  // BOM may exist), so #2 auto-population tracks the current customer.
  useEffect(() => {
    if (!finishedStyleId) { setBomState("idle"); setActiveBom(null); return; }
    void resolveBom(finishedStyleId, customer?.id ?? null);
  }, [finishedStyleId, customer?.id, resolveBom]);

  // #2 — when the resolved active BOM is customer-specific and the operator
  // hasn't picked a customer, auto-populate "Build for customer" from the BOM.
  useEffect(() => {
    if (custTouched) return;
    if (bomState === "active" && activeBom?.customer_id && !customer) {
      setCustomer({ id: activeBom.customer_id, name: activeBom.customer_name || "Customer" });
      setCustStyleTouched(false);
    }
  }, [bomState, activeBom, customer, custTouched]);

  useEffect(() => {
    if (custStyleTouched) return;
    if (customer && styleCode) setCustStyleNumber(`${customer.code || customer.customer_code || "CUST"}-${styleCode}`);
    else setCustStyleNumber("");
  }, [customer, styleCode, custStyleTouched]);
  const onPlanChange = useCallback((outputs: { color: string | null; size: string; qty: number }[], total: number, hasScale: boolean) => setPlan({ outputs, total, hasScale }), []);
  const styleThumbs = useStyleThumbs([finishedStyleId]);
  const finishedThumb = finishedStyleId ? (styleThumbs.get(finishedStyleId)?.default ?? null) : null;

  async function submit() {
    setSubmitting(true); setErr(null);
    try {
      if (!finishedStyleId) throw new Error("Pick a finished style");
      if (bomState !== "active") throw new Error("This style needs an active BOM before it can be built.");
      const payload: Record<string, unknown> = { finished_style_id: finishedStyleId };
      // Pin the resolved BOM so the build releases against the exact recipe shown.
      if (activeBom?.id) payload.bom_id = activeBom.id;
      if (plan.outputs.length > 0) {
        payload.outputs = plan.outputs; // target derived server-side from the matrix
      } else {
        const qty = parseFloat(targetQty);
        if (!Number.isFinite(qty) || qty <= 0) throw new Error(plan.hasScale ? "Enter quantities in the size matrix" : "Enter a target quantity");
        payload.target_qty = qty;
      }
      if (customer) { payload.customer_id = customer.id; if (custStyleNumber.trim()) payload.customer_style_number = custStyleNumber.trim(); }
      const r = await fetch(`/api/internal/build-orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const b = await r.json();
      onCreated(b.id);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  // #1 — Create is gated on a usable (active) BOM being present.
  const canSubmit = !!finishedStyleId && bomState === "active" && (plan.total > 0 || (!plan.hasScale && parseFloat(targetQty) > 0));

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(720px, 96vw)", maxHeight: "90vh", overflowY: "auto", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>New build order</h3>
        <div style={{ marginBottom: 12 }}>
          <Lbl>Finished style *</Lbl>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {finishedStyleId && <StyleThumb styleId={finishedStyleId} label={pickedLabel} url={finishedThumb} size={44} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <StylePicker onChange={(id, label, sc) => { setFinishedStyleId(id); setPickedLabel(label); setStyleCode(sc); setDefaultColor(null); }} />
            </div>
            {/* Item 1 — add a style on the fly (admin only). */}
            <button type="button" style={{ ...btnSecondary, whiteSpace: "nowrap" }}
              onClick={() => { if (!isAdmin) { notify("Only admins can add styles. Ask an admin, or pick an existing style.", "error"); return; } setAddStyleOpen(true); }}
              title="Add a new style without leaving the build">+ New style</button>
          </div>
          {pickedLabel && <div style={{ fontSize: 12, color: C.textSub, marginTop: 4 }}>Selected: <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace" }}>{pickedLabel}</span></div>}
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Its active BOM is snapshotted when you Release the build.</div>
          {/* #1 — BOM gate. A style can be built only with an ACTIVE BOM. */}
          {finishedStyleId && bomState === "loading" && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6 }}>Checking this style's BOM…</div>}
          {finishedStyleId && bomState === "activating" && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6 }}>Activating BOM…</div>}
          {finishedStyleId && bomState === "active" && activeBom && (
            <div style={{ fontSize: 12, color: C.success, marginTop: 6 }}>✓ Active BOM (v{activeBom.version ?? "?"}{activeBom.customer_name ? ` · ${activeBom.customer_name}` : ""}) · {activeBom.components.length} component{activeBom.components.length === 1 ? "" : "s"}</div>
          )}
          {finishedStyleId && bomState === "draft-only" && (
            <div style={{ fontSize: 12, color: C.warn, marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span>This style's BOM is still Draft — activate it to build.</span>
              <button type="button" style={{ ...btnSecondary, borderColor: C.warn, color: C.warn }} onClick={() => void activateDraft()}>Activate BOM</button>
            </div>
          )}
          {finishedStyleId && bomState === "no-bom" && (
            <div style={{ fontSize: 12, color: C.danger, marginTop: 6 }}>This style has no BOM — create one first (Manufacturing → Bill of Materials).</div>
          )}
        </div>
        {addStyleOpen && (
          <QuickAddStyleModal
            onClose={() => setAddStyleOpen(false)}
            onCreated={(_skuId, label, styleId, sCode) => { if (styleId) { setFinishedStyleId(styleId); setStyleCode(sCode ?? null); } setPickedLabel(label); setAddStyleOpen(false); notify(`Style added — "${label}" selected. Attach its BOM before releasing.`, "success"); }}
          />
        )}
        {/* Item a — plan the run by size at creation (matrix); falls back to a
            plain total when the style has no size scale. */}
        {finishedStyleId ? (
          <div style={{ marginBottom: 12 }}>
            {/* #10 — stacked matrices: FIRST the FG plan (editable, with on-hand
                hints), then parts availability + services below it. */}
            <Lbl>Plan by size · finished goods {plan.total > 0 ? <span style={{ color: C.textMuted, fontWeight: 400 }}>· total {plan.total}</span> : null}</Lbl>
            <PlannedSizeMatrix styleId={finishedStyleId} defaultColor={defaultColor} onChange={onPlanChange} />
            {!plan.hasScale && (
              <input type="number" min="1" step="1" value={targetQty} onChange={(e) => setTargetQty(e.target.value)} style={{ ...inputStyle, marginTop: 8 }} placeholder="Target quantity, e.g. 500" />
            )}
            {bomState === "active" && activeBom && (
              <BuildAvailability bom={activeBom} planTotal={plan.total > 0 ? plan.total : (parseFloat(targetQty) || 0)} />
            )}
          </div>
        ) : (
          <div style={{ marginBottom: 12 }}>
            <Lbl>Target quantity *</Lbl>
            <input type="number" min="1" step="1" value={targetQty} onChange={(e) => setTargetQty(e.target.value)} style={inputStyle} placeholder="Pick a style first, or enter a total" />
          </div>
        )}
        {/* Phase B — build for a customer (optional). */}
        <div style={{ marginBottom: 12 }}>
          <Lbl>Build for customer (optional){customer && activeBom?.customer_id === customer.id && !custTouched ? <span style={{ color: C.textMuted, fontWeight: 400 }}> · from BOM</span> : null}</Lbl>
          <CustomerPicker onChange={(c) => { setCustomer(c); setCustTouched(true); setCustStyleTouched(false); }} />
        </div>
        {customer && (
          <div style={{ marginBottom: 12 }}>
            <Lbl>Customer style #</Lbl>
            <input value={custStyleNumber} onChange={(e) => { setCustStyleNumber(e.target.value); setCustStyleTouched(true); }} style={inputStyle} placeholder="e.g. CUST-00042-RYB0412" />
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Saved to this customer's style numbers (also visible in Customer Master → Style numbers). Kept if one already exists for this style.</div>
          </div>
        )}
        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 12 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting || !canSubmit}>{submitting ? "Creating…" : "Create draft"}</button>
        </div>
      </div>
    </div>
  );
}

function BuildDetail({ buildId, onClose, onChanged }: { buildId: string; onClose: () => void; onChanged: () => void }) {
  const [build, setBuild] = useState<Build | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [convMode, setConvMode] = useState<"procurement" | "capitalize">("procurement");
  const styleThumbs = useStyleThumbs([build?.finished_style_id]);
  const finishedThumb = build?.finished_style_id ? (styleThumbs.get(build.finished_style_id)?.default ?? null) : null;
  const partThumbs = usePartThumbs((build?.components || []).filter((c) => c.component_kind === "part").map((c) => c.part_id ?? null));

  async function load() {
    try {
      const r = await fetch(`/api/internal/build-orders/${buildId}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setBuild(await r.json() as Build);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
  }
  useEffect(() => { void load(); }, [buildId]);

  async function act(path: string, body?: Record<string, unknown>) {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/build-orders/${buildId}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify(`Build ${path} ok.`, "success");
      await load(); onChanged();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  // Cancel goes through the /cancel action endpoint, which FULLY reverses an
  // issued build: reverses the issue + service journal entries and restores the
  // consumed parts/styles back to inventory, then flips to cancelled. Draft/
  // released builds (nothing posted) just cancel. Reversing GL requires a T11
  // reason, so an issued build prompts for one.
  async function cancelBuild() {
    const issued = status === "issued";
    if (!(await confirmDialog(
      issued
        ? `Cancel build ${build?.build_number}? This reverses the WIP postings (issue + capitalized services) and returns the consumed parts/styles to inventory. This can't be undone.`
        : `Cancel build ${build?.build_number}? This can't be undone.`,
    ))) return;
    let reason: string | null = null;
    if (issued) {
      reason = await promptDialog(`Reason for cancelling build ${build?.build_number} (required — it's recorded on the reversing journal entries)`, { required: true });
      if (reason === null) return; // operator backed out of the reason prompt
    }
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/build-orders/${buildId}/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason || undefined }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const rev = Array.isArray(j.reversed_je_ids) ? j.reversed_je_ids.length : 0;
      notify(
        rev > 0
          ? `Build ${build?.build_number} cancelled — reversed ${rev} journal entr${rev === 1 ? "y" : "ies"}, restored ${Number(j.restored_part_qty || 0)} part + ${Number(j.restored_style_qty || 0)} style unit(s).`
          : `Build ${build?.build_number} cancelled.`,
        "success",
      );
      await load(); onChanged();
    } catch (e: unknown) { const msg = e instanceof Error ? e.message : String(e); setErr(msg); notify(msg, "error"); }
    finally { setBusy(false); }
  }

  // M11 — auto-create the conversion (outsourced-CMT) PO. Optional per-unit CMT
  // charge; vendor defaults to the BOM's default conversion vendor server-side.
  async function createConversionPo() {
    const v = await promptDialog(
      `Per-unit CMT charge for the conversion PO ($, optional — leave blank for a document-only PO)`,
      { inputType: "number", defaultValue: "", placeholder: "0.00" },
    );
    if (v === null) return; // operator backed out
    let unitCostCents: number | undefined;
    const t = v.trim();
    if (t !== "") {
      const dollars = parseFloat(t);
      if (!Number.isFinite(dollars) || dollars < 0) { notify("Enter a non-negative amount", "error"); return; }
      unitCostCents = Math.round(dollars * 100);
    }
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/build-orders/${buildId}/conversion-po`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: convMode, unit_cost_cents: unitCostCents }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify(j.message || "Conversion PO created.", "success");
      await load(); onChanged();
    } catch (e: unknown) { const msg = e instanceof Error ? e.message : String(e); setErr(msg); notify(msg, "error"); }
    finally { setBusy(false); }
  }

  async function capitalizeService(componentId: string, label: string, suggested: number | null) {
    const def = suggested != null ? (suggested / 100).toFixed(2) : "";
    const v = await promptDialog(`Conversion charge for "${label}" ($)`, { inputType: "number", defaultValue: def, placeholder: "0.00", required: true });
    if (v === null) return;
    const dollars = parseFloat(v);
    if (!Number.isFinite(dollars) || dollars <= 0) { notify("Enter a positive amount", "error"); return; }
    await act("service", { component_id: componentId, charge_cents: Math.round(dollars * 100) });
  }

  const status = build?.status;
  // M11 — in 'capitalize' mode the CMT is capitalized into WIP by the conversion
  // PO's AP bill, so the per-service Capitalize buttons are hidden and completion
  // is not gated on manual capitalization (the receipt path skips that guard).
  const capMode = build?.conversion_po_mode === "capitalize";
  const allServicesCapitalized = capMode || (build?.components || []).filter((c) => c.component_kind === "service").every((c) => c.service_capitalized);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, width: "min(940px, 96vw)", maxHeight: "90vh", display: "flex", flexDirection: "column", color: C.text }}>
        <div style={{ padding: "18px 20px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
              {build?.finished_style_id && <StyleThumb styleId={build.finished_style_id} label={build.finished_item?.sku_code} url={finishedThumb} size={44} />}
              <div style={{ minWidth: 0 }}>
                <h3 style={{ margin: 0, fontSize: 18 }}>{build ? build.build_number : "Build"}{build?.status ? <span style={{ marginLeft: 10, fontSize: 13, color: STATUS_COLOR[build.status] }}>● {build.status}</span> : null}</h3>
                {build?.finished_item && <div style={{ fontSize: 13, color: C.textSub, marginTop: 4 }}>{build.finished_item.sku_code} — {build.finished_item.description} · target {build.target_qty}</div>}
              </div>
            </div>
            <button onClick={onClose} style={btnSecondary}>Close</button>
          </div>
          {build?.customer_name && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>For <span style={{ color: C.textSub }}>{build.customer_name}</span>{build.customer_style_number ? <> · cust style <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace", color: C.textSub }}>{build.customer_style_number}</span></> : null}</div>}
        </div>

        <div style={{ padding: "12px 20px", overflowY: "auto", flex: 1 }}>
          {!build ? <div style={{ color: C.textMuted, padding: 20 }}>Loading…</div> : (
            <>
              {/* WIP rollup — actual (posted) plus a PROJECTED estimate (#8) so
                  costs are visible before issue/capitalize. Pre-issue the WIP
                  totals are 0; the projected row fills the gap from master
                  defaults / avg cost. */}
              {build.rollup && (() => {
                const proj = build.rollup.projected;
                const posted = build.rollup.total_cents > 0;
                const projTotal = proj ? proj.total_cents : 0;
                const projUnit = proj && build.target_qty > 0 ? Math.round(projTotal / build.target_qty) : null;
                return (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", padding: 12, background: "#0b1220", borderRadius: 8 }}>
                      <Stat label="Parts" value={money(build.rollup.parts_cost_cents)} />
                      <Stat label="Consumed styles" value={money(build.rollup.style_cost_cents)} />
                      <Stat label="Services" value={money(build.rollup.service_cost_cents)} />
                      <Stat label="WIP total (actual)" value={money(build.rollup.total_cents)} strong />
                      <Stat label={posted ? "Actual unit cost" : "Proj. unit cost"} value={posted && build.target_qty > 0 ? money(Math.round(build.rollup.total_cents / build.target_qty)) : (projUnit != null ? money(projUnit) : "—")} />
                      {build.finished_unit_cost_cents != null && <Stat label="Finished unit cost" value={money(build.finished_unit_cost_cents)} strong />}
                    </div>
                    {proj && proj.has_estimate && (
                      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 8, padding: "10px 12px", background: "#0b1220", border: `1px dashed ${C.cardBdr}`, borderRadius: 8 }}>
                        <div style={{ alignSelf: "center", fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Projected (pre-cost)</div>
                        <Stat label="Parts" value={money(proj.parts_cost_cents)} />
                        <Stat label="Consumed styles" value={money(proj.style_cost_cents)} />
                        <Stat label="Services" value={money(proj.service_cost_cents)} />
                        <Stat label="Projected total" value={money(proj.total_cents)} strong />
                        <Stat label="Proj. unit cost" value={projUnit != null ? money(projUnit) : "—"} />
                        {proj.missing_costs > 0 && <div style={{ alignSelf: "center", fontSize: 11, color: C.warn }}>{proj.missing_costs} component{proj.missing_costs === 1 ? "" : "s"} without a default cost — estimate is partial.</div>}
                      </div>
                    )}
                  </div>
                );
              })()}

              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={th}>Kind</th><th style={th}>Item</th>
                    <th style={{ ...th, textAlign: "right" }}>Qty req.</th>
                    <th style={{ ...th, textAlign: "right" }}>Consumed</th>
                    <th style={{ ...th, textAlign: "right" }}>Proj. cost</th>
                    <th style={{ ...th, textAlign: "right" }}>Actual cost</th>
                    <th style={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {(build.components || []).map((c) => (
                    <tr key={c.id}>
                      <td style={{ ...td, color: C.textSub }}>{KIND_LABEL[c.component_kind]}</td>
                      <td style={td}>
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          {c.component_kind === "part" && c.part_id && <PartThumb partId={c.part_id} url={partThumbs.get(c.part_id) ?? null} label={c.component_code ?? undefined} size={28} />}
                          <span><span style={{ fontFamily: "SFMono-Regular, Menlo, monospace" }}>{c.component_code ?? "—"}</span>{c.component_label ? <span style={{ color: C.textSub }}> — {c.component_label}</span> : null}{c.component_kind === "service" && c.service_vendor_name ? <span style={{ color: C.textMuted, fontSize: 11 }}> · {c.service_vendor_name}</span> : null}</span>
                        </div>
                      </td>
                      <td style={{ ...td, textAlign: "right" }}>{c.qty_required}</td>
                      <td style={{ ...td, textAlign: "right", color: C.textSub }}>{c.component_kind === "service" ? "—" : c.qty_consumed}</td>
                      {/* #8 — projected cost from master defaults / avg cost, shown before capitalization. */}
                      <td style={{ ...td, textAlign: "right", color: C.textMuted }} title={c.projected_unit_cost_cents != null ? `Projected unit ${money(c.projected_unit_cost_cents)}` : "No default cost on record"}>{c.projected_cost_cents != null ? money(c.projected_cost_cents) : "—"}</td>
                      <td style={{ ...td, textAlign: "right" }}>{money(c.actual_cost_cents)}</td>
                      <td style={{ ...td, textAlign: "right" }}>
                        {c.component_kind === "service" && !c.service_capitalized && !capMode && (status === "released" || status === "issued") && (
                          <button disabled={busy} onClick={() => void capitalizeService(c.id, c.component_label || c.component_code || "service", c.service_charge_cents)} style={btnSecondary}>Capitalize</button>
                        )}
                        {c.component_kind === "service" && c.service_capitalized && <span style={{ color: C.success, fontSize: 12 }}>✓ capitalized</span>}
                        {c.component_kind === "service" && !c.service_capitalized && capMode && <span style={{ color: C.textMuted, fontSize: 11 }}>via conversion PO</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* By size — the planned matrix (before completion) or the actual
                  produced quantities (once completed). */}
              {(build.outputs && build.outputs.length > 0) && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 12, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>{build.status === "completed" ? "Produced (by size)" : "Planned (by size)"}</div>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr><th style={th}>Color</th><th style={th}>Size</th><th style={{ ...th, textAlign: "right" }}>Qty</th><th style={{ ...th, textAlign: "right" }}>Unit cost</th></tr></thead>
                    <tbody>
                      {build.outputs.map((o) => (
                        <tr key={o.id}><td style={td}>{o.color || "—"}</td><td style={td}>{o.size || "—"}</td><td style={{ ...td, textAlign: "right" }}>{o.qty}</td><td style={{ ...td, textAlign: "right" }}>{money(o.unit_cost_cents)}</td></tr>
                      ))}
                      <tr><td style={{ ...td, fontWeight: 600 }} colSpan={2}>Total</td><td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{build.outputs.reduce((s, o) => s + Number(o.qty), 0)}</td><td style={td} /></tr>
                    </tbody>
                  </table>
                </div>
              )}

              {/* M11 — conversion PO (outsourced CMT). Create a native draft PO to
                  the conversion vendor; once linked, show its number/status/mode. */}
              <div style={{ marginTop: 16, borderTop: `1px solid ${C.cardBdr}`, paddingTop: 16 }}>
                <div style={{ fontSize: 12, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Conversion PO</div>
                {build.conversion_po_id ? (
                  <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
                    <span>PO <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace", color: C.textSub }}>{build.conversion_po?.po_number || "(draft, unassigned #)"}</span></span>
                    {build.conversion_po?.status && <span style={{ color: C.textMuted }}>● {build.conversion_po.status}</span>}
                    <span style={{ padding: "2px 8px", borderRadius: 4, background: "#0b1220", border: `1px solid ${C.cardBdr}`, color: capMode ? C.warn : C.textSub, fontSize: 11 }}>
                      {capMode ? "capitalize (AP bill → WIP)" : "procurement (document only)"}
                    </span>
                    {build.conversion_po?.total_cents != null && <span style={{ color: C.textMuted }}>{money(build.conversion_po.total_cents)}</span>}
                  </div>
                ) : (status === "draft" || status === "released" || status === "issued") ? (
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <label style={{ fontSize: 12, color: C.textMuted }}>GL mode</label>
                    <select value={convMode} onChange={(e) => setConvMode(e.target.value as "procurement" | "capitalize")} disabled={busy}
                      style={{ background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13 }}>
                      <option value="procurement">Procurement — document only (no GL)</option>
                      <option value="capitalize">Capitalize — AP bill capitalizes CMT into WIP</option>
                    </select>
                    <button disabled={busy} onClick={() => void createConversionPo()} style={btnSecondary}>Create conversion PO</button>
                    <span style={{ fontSize: 11, color: C.textMuted }}>Vendor defaults to the BOM's conversion vendor.</span>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: C.textMuted }}>No conversion PO.</div>
                )}
              </div>

              <div style={{ marginTop: 16, borderTop: `1px solid ${C.cardBdr}`, paddingTop: 16 }}>
                <div style={{ fontSize: 12, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Attachments</div>
                <DocumentAttachmentList contextTable="mfg_build_orders" contextId={build.id} kinds={["po", "packing_list", "qc", "other"]} />
              </div>

              {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>{err}</div>}
            </>
          )}
        </div>

        {/* Action footer */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: 16, borderTop: `1px solid ${C.cardBdr}`, background: C.card }}>
          {status === "draft" && <button disabled={busy} onClick={() => void act("release")} style={btnPrimary}>Release (snapshot BOM)</button>}
          {status === "released" && <button disabled={busy} onClick={() => void act("issue")} style={btnPrimary}>Issue components → WIP</button>}
          {status === "issued" && (
            <button
              disabled={busy || !allServicesCapitalized}
              title={allServicesCapitalized ? "" : "Capitalize all service charges first"}
              onClick={async () => {
                // Style-backed finished good → enter a color x size matrix so
                // stock lands per size. Otherwise complete the single item.
                if (build?.finished_style_id) { setCompleteOpen(true); return; }
                if (await confirmDialog(`Complete build ${build?.build_number}? This moves WIP into finished-goods inventory.`)) void act("complete");
              }}
              style={btnPrimary}
            >Complete → finished goods</button>
          )}
          {(status === "draft" || status === "released" || status === "issued") && (
            <button disabled={busy} onClick={() => void cancelBuild()} style={btnDanger}>Cancel build</button>
          )}
        </div>
      </div>

      {completeOpen && build?.finished_style_id && (
        <CompleteMatrixModal
          styleId={build.finished_style_id}
          buildNumber={build.build_number}
          targetQty={build.target_qty}
          defaultColor={build.finished_item?.color || null}
          initial={build.outputs || []}
          busy={busy}
          onClose={() => setCompleteOpen(false)}
          onSubmit={async (outputs) => { await act("complete", { outputs }); setCompleteOpen(false); }}
        />
      )}
    </div>
  );
}

// Complete a style-backed build by entering the produced color x size matrix.
// Reuses the shared EditableSizeMatrix (same grid as SO/PO entry). Each filled
// cell becomes a finished-goods layer at completion (server resolves the SKU).
function CompleteMatrixModal({ styleId, buildNumber, targetQty, defaultColor, initial, busy, onClose, onSubmit }: {
  styleId: string; buildNumber: string; targetQty: number; defaultColor: string | null;
  initial?: { color: string | null; size: string | null; qty: number }[]; busy: boolean;
  onClose: () => void; onSubmit: (outputs: { color: string | null; size: string; qty: number }[]) => void | Promise<void>;
}) {
  const [sizes, setSizes] = useState<string[]>([]);
  const [colors, setColors] = useState<string[]>([]);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/internal/style-matrix?style_id=${styleId}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        if (!alive) return;
        const szs: string[] = Array.isArray(j.sizes) ? j.sizes.filter(Boolean) : [];
        let cols: string[] = Array.isArray(j.colors) ? j.colors.filter(Boolean) : [];
        if (cols.length === 0) cols = [defaultColor || "—"];
        setSizes(szs); setColors(cols);
        // Pre-fill from the planned matrix entered at build creation.
        if (initial && initial.length) {
          const seed: Record<string, number> = {};
          for (const o of initial) {
            if (!o.size) continue;
            const rowKey = cols.includes(o.color || "") ? (o.color as string) : cols[0];
            seed[matrixCellKey(rowKey, o.size)] = Number(o.qty) || 0;
          }
          setQty(seed);
        }
      } catch (e: unknown) { if (alive) setLoadErr(e instanceof Error ? e.message : String(e)); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [styleId, defaultColor, initial]);

  const rows: EditableMatrixRow[] = colors.map((c) => ({ key: c, color: c }));
  const total = Object.values(qty).reduce((s, v) => s + (Number(v) || 0), 0);

  // Convenience: split target evenly across the sizes of the default color.
  function evenSplit() {
    if (sizes.length === 0) return;
    const rowKey = colors.includes(defaultColor || "") ? (defaultColor as string) : colors[0];
    const per = Math.floor(targetQty / sizes.length);
    const rem = targetQty - per * sizes.length;
    const next = { ...qty };
    sizes.forEach((sz, i) => { next[matrixCellKey(rowKey, sz)] = per + (i < rem ? 1 : 0); });
    setQty(next);
  }

  function submit() {
    const outputs: { color: string | null; size: string; qty: number }[] = [];
    for (const c of colors) for (const sz of sizes) {
      const v = Number(qty[matrixCellKey(c, sz)] || 0);
      if (v > 0) outputs.push({ color: c === "—" ? (defaultColor || null) : c, size: sz, qty: v });
    }
    if (outputs.length === 0) { notify("Enter at least one produced quantity", "error"); return; }
    void onSubmit(outputs);
  }

  return (
    <div onClick={(e) => { e.stopPropagation(); onClose(); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, width: "min(940px, 96vw)", maxHeight: "90vh", display: "flex", flexDirection: "column", color: C.text }}>
        <div style={{ padding: "18px 20px", borderBottom: `1px solid ${C.cardBdr}`, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Complete {buildNumber} — produced by size</h3>
          <button onClick={onClose} style={btnSecondary}>Close</button>
        </div>
        <div style={{ padding: "12px 20px", overflow: "auto", flex: 1 }}>
          {loading ? <div style={{ color: C.textMuted, padding: 20 }}>Loading sizes…</div>
            : loadErr ? <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, fontSize: 12 }}>{loadErr}</div>
            : sizes.length === 0 ? <div style={{ color: C.warn, fontSize: 13 }}>This style has no size scale, so a size matrix can't be built. Close and complete the build without a matrix.</div>
            : (
              <>
                <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10, fontSize: 12, color: C.textMuted }}>
                  <button onClick={evenSplit} style={btnSecondary}>Even-split target ({targetQty})</button>
                  <span>Total produced: <b style={{ color: total === targetQty ? C.success : C.warn }}>{total}</b>{total !== targetQty ? <span style={{ color: C.textMuted }}> (target {targetQty})</span> : null}</span>
                </div>
                <EditableSizeMatrix rows={rows} sizes={sizes} qty={qty} onQtyChange={(rowKey, size, value) => setQty((p) => ({ ...p, [matrixCellKey(rowKey, size)]: value }))} />
              </>
            )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: 16, borderTop: `1px solid ${C.cardBdr}`, background: C.card }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button disabled={busy || loading || total <= 0} onClick={submit} style={btnPrimary}>Complete → finished goods</button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: strong ? 18 : 15, fontWeight: strong ? 700 : 500, color: C.text }}>{value}</div>
    </div>
  );
}

function Lbl({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{children}</div>;
}
