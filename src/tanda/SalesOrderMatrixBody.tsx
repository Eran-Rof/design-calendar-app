// src/tanda/SalesOrderMatrixBody.tsx
//
// MX-SO body — the Sales Order modal's LINE BODY *is* the size matrix.
//
// ~95% of styles are matrix-driven, so the SO body is a stack of per-style
// color × size grids (the same EditableSizeMatrix the inventory matrix uses):
// pick a style → type ordered quantities straight into its grid, with an
// editable Unit $ per color. A separate "+ Add non-matrix line" button adds a
// plain SKU/qty/$ row for the rare non-matrix item.
//
// Nothing is "added to the order" as a side step — the grids ARE the order.
// At save time the parent calls the imperative `resolve()` which turns every
// filled cell into an ip_item_master SKU (find-or-create via
// /api/internal/style-matrix/resolve-sku) plus the flat lines, and returns the
// SO line payload. This replaces the old two-step "Add by matrix → flat list".

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import { EditableSizeMatrix, matrixCellKey } from "../shared/matrix";
import type { EditableMatrixRow } from "../shared/matrix";

const C = {
  card: "#1E293B", cardBdr: "#334155", text: "#F1F5F9", textMuted: "#94A3B8",
  textSub: "#CBD5E1", primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
  base: "#60A5FA",
};
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d", padding: "2px 8px" };
const numInput: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 8px", borderRadius: 4, fontSize: 13, width: "100%", textAlign: "right", boxSizing: "border-box" };
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5 };
const td: React.CSSProperties = { padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };

type Style = { id: string; style_code: string; style_name?: string | null; description?: string | null };
type MatrixSku = { id: string; color: string | null; size: string | null; inseam: string | null; on_hand_qty?: number; avg_cost_cents?: number | null };
type MatrixPayload = { style: { id: string; style_code: string }; sizes: string[]; colors: string[]; inseams: string[]; skus: MatrixSku[] };
type FlatItem = { id: string; sku_code: string; style_code?: string | null; description?: string | null };

export type FlatLine = { key: number; inventory_item_id: string; qty_ordered: string; unit_price_dollars: string; label?: string };
export type ResolvedLine = { inventory_item_id: string | null; qty_ordered: number; unit_price_cents: number };
export type SeedSection = { styleCode: string; cells: { color: string | null; size: string; inseam?: string | null; qty: number; unit?: string }[] };
export interface SalesOrderMatrixBodyHandle { resolve: () => Promise<ResolvedLine[]> }

type Section = { id: number; styleId: string; payload: MatrixPayload | null; qty: Record<string, number>; unit: Record<string, string>; loading: boolean; err: string | null };

const rowKeyOf = (color: string | null, inseam: string | null) => `${color ?? ""}|${inseam ?? ""}`;
const skuCellKey = (color: string | null, size: string | null, inseam: string | null) => `${color ?? ""}|${size ?? ""}|${inseam ?? ""}`;

export interface SalesOrderMatrixBodyProps {
  editable: boolean;
  items: FlatItem[];                         // 500-item list for the non-matrix picker
  seed?: { sections: SeedSection[]; flat: FlatLine[] } | null;
  /** Show the faint on-hand number above each size cell. Off for Production
   *  fulfillment (the order is being made, not shipped from stock). Default true. */
  showOnHand?: boolean;
  /** ATS fulfillment: the number above each cell is real available-to-ship BY
   *  SIZE (on-hand + inbound − open reservations, from tangerine_size_onhand via
   *  /api/internal/ats-by-size) rather than raw on-hand. Overrides showOnHand. */
  atsMode?: boolean;
  /** ATS fulfillment ship-date window (the SO's requested ship date). When set,
   *  available-to-ship ADDS native PO inbound expected to arrive by this date. */
  atsAsOfDate?: string | null;
  onTotalsChange?: (t: BodyTotals) => void;
}

export type BodyTotals = { qty: number; cents: number; costCents: number; marginPct: number; marginEstimated: boolean };
const MARGIN_FALLBACK = 0.21; // assumed gross margin when a style has no cost history

const SalesOrderMatrixBody = forwardRef<SalesOrderMatrixBodyHandle, SalesOrderMatrixBodyProps>(function SalesOrderMatrixBody(
  { editable, items, seed, showOnHand = true, atsMode = false, atsAsOfDate = null, onTotalsChange }, ref,
) {
  const [styles, setStyles] = useState<Style[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [flat, setFlat] = useState<FlatLine[]>([]);
  const [atsByItem, setAtsByItem] = useState<Record<string, number>>({});
  const [atsAsOf, setAtsAsOf] = useState<string | null>(null);
  const [atsLoading, setAtsLoading] = useState(false);
  const nextSectionId = useRef(1);
  const nextFlatKey = useRef(1);
  const seeded = useRef(false);

  useEffect(() => {
    fetch("/api/internal/style-master?limit=10000").then((r) => (r.ok ? r.json() : [])).then((a) => setStyles(Array.isArray(a) ? a : [])).catch(() => {});
  }, []);

  // Fetch the size-matrix payload for a section's style.
  async function loadPayload(styleId: string): Promise<MatrixPayload | null> {
    const r = await fetch(`/api/internal/style-matrix?style_id=${encodeURIComponent(styleId)}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return (await r.json()) as MatrixPayload;
  }
  function patchSection(id: number, patch: Partial<Section>) { setSections((p) => p.map((s) => (s.id === id ? { ...s, ...patch } : s))); }

  async function pickStyle(id: number, styleId: string) {
    patchSection(id, { styleId, payload: null, loading: !!styleId, err: null });
    if (!styleId) return;
    try { const p = await loadPayload(styleId); patchSection(id, { payload: p, loading: false }); }
    catch (e) { patchSection(id, { loading: false, err: e instanceof Error ? e.message : String(e) }); }
  }

  function addSection() { setSections((p) => [...p, { id: nextSectionId.current++, styleId: "", payload: null, qty: {}, unit: {}, loading: false, err: null }]); }
  function removeSection(id: number) { setSections((p) => p.filter((s) => s.id !== id)); }
  function setQty(id: number, rowKey: string, size: string, n: number) {
    setSections((p) => p.map((s) => {
      if (s.id !== id) return s;
      const key = matrixCellKey(rowKey, size); const q = { ...s.qty };
      if (n > 0) q[key] = n; else delete q[key];
      return { ...s, qty: q };
    }));
  }
  function setUnit(id: number, rowKey: string, v: string) { setSections((p) => p.map((s) => (s.id === id ? { ...s, unit: { ...s.unit, [rowKey]: v } } : s))); }
  function setAllUnit(id: number, rows: EditableMatrixRow[], v: string) { setSections((p) => p.map((s) => (s.id === id ? { ...s, unit: Object.fromEntries(rows.map((r) => [r.key, v])) } : s))); }

  function addFlat() { setFlat((p) => [...p, { key: nextFlatKey.current++, inventory_item_id: "", qty_ordered: "", unit_price_dollars: "" }]); }
  function updateFlat(idx: number, patch: Partial<FlatLine>) { setFlat((p) => p.map((l, i) => (i === idx ? { ...l, ...patch } : l))); }
  function removeFlat(idx: number) { setFlat((p) => p.filter((_, i) => i !== idx)); }

  // Seed (edit mode) once styles are available so styleCode → styleId resolves.
  useEffect(() => {
    if (seeded.current || !seed || styles.length === 0) return;
    seeded.current = true;
    if (seed.flat.length) { setFlat(seed.flat); nextFlatKey.current = Math.max(0, ...seed.flat.map((f) => f.key)) + 1; }
    for (const sec of seed.sections) {
      const st = styles.find((s) => s.style_code === sec.styleCode);
      const id = nextSectionId.current++;
      const qty: Record<string, number> = {}; const unit: Record<string, string> = {};
      for (const c of sec.cells) {
        const rk = rowKeyOf(c.color, c.inseam ?? null);
        if (c.qty > 0) qty[matrixCellKey(rk, c.size)] = c.qty;
        if (c.unit) unit[rk] = c.unit;
      }
      setSections((p) => [...p, { id, styleId: st?.id || "", payload: null, qty, unit, loading: !!st, err: st ? null : `Style ${sec.styleCode} not found` }]);
      if (st) loadPayload(st.id).then((pl) => patchSection(id, { payload: pl, loading: false })).catch((e) => patchSection(id, { loading: false, err: e instanceof Error ? e.message : String(e) }));
    }
  }, [seed, styles]);

  // Build EditableSizeMatrix rows for a section payload.
  function rowsFor(payload: MatrixPayload | null): EditableMatrixRow[] {
    if (!payload) return [];
    const hasInseams = (payload.inseams?.length ?? 0) > 1;
    const colors = payload.colors.length ? payload.colors : [...new Set((payload.skus || []).map((s) => s.color).filter(Boolean) as string[])];
    const colorList: (string | null)[] = colors.length ? colors : [null];
    const inseamList: (string | null)[] = hasInseams ? payload.inseams : [null];
    const out: EditableMatrixRow[] = [];
    for (const color of colorList) for (const inseam of inseamList) out.push({ key: rowKeyOf(color, inseam), color: color ?? null, rise: inseam ?? null });
    return out;
  }

  // ── Totals + projected margin ───────────────────────────────────────────────
  //   margin % = (revenue − cost) / revenue. Per cell the cost is the SKU's
  //   avg_cost_cents (Xoro/Excel history). When a cell has NO cost history we
  //   fall back to the assumed 21% gross margin (cost = price × 0.79) and flag
  //   the order's margin as "estimated" only when NO line had real cost data.
  const totals = useMemo<BodyTotals>(() => {
    let qty = 0, cents = 0, costCents = 0, realCostCells = 0;
    for (const s of sections) {
      const byCell = new Map<string, MatrixSku>();
      for (const sk of s.payload?.skus || []) byCell.set(skuCellKey(sk.color, sk.size, sk.inseam || null), sk);
      for (const [cell, n] of Object.entries(s.qty)) {
        if (!(n > 0)) continue;
        const [rowKey, size] = cell.split("__");
        const [color, inseam] = rowKey.split("|");
        const unit = Math.round((Number(s.unit[rowKey]) || 0) * 100);
        qty += n; cents += Math.round(n * unit);
        const sku = byCell.get(skuCellKey(color || null, size, inseam || null));
        const ac = sku?.avg_cost_cents != null ? Number(sku.avg_cost_cents) : null;
        if (ac != null && ac > 0) { costCents += Math.round(n * ac); realCostCells += 1; }
        else costCents += Math.round(n * unit * (1 - MARGIN_FALLBACK));
      }
    }
    for (const l of flat) {
      const q = Number(l.qty_ordered) || 0; if (!(q > 0)) continue;
      const unit = Math.round((Number(l.unit_price_dollars) || 0) * 100);
      qty += q; cents += Math.round(q * unit);
      costCents += Math.round(q * unit * (1 - MARGIN_FALLBACK)); // flat lines have no matrix cost source
    }
    const marginPct = cents > 0 ? ((cents - costCents) / cents) * 100 : 0;
    return { qty, cents, costCents, marginPct, marginEstimated: realCostCells === 0 };
  }, [sections, flat]);
  useEffect(() => { onTotalsChange?.(totals); }, [totals, onTotalsChange]);

  // ── ATS-by-size availability ────────────────────────────────────────────────
  //   When the SO is set to ATS fulfillment, fetch real available-to-ship by
  //   size for every SKU currently in the loaded grids and show it above each
  //   cell (instead of raw on-hand). Re-runs when the set of SKUs changes.
  const allSkuIdsSig = useMemo(() => {
    const ids = new Set<string>();
    for (const s of sections) for (const sk of s.payload?.skus || []) if (sk.id) ids.add(sk.id);
    return [...ids].sort().join(",");
  }, [sections]);
  useEffect(() => {
    if (!atsMode) { setAtsByItem({}); setAtsAsOf(null); return; }
    const ids = allSkuIdsSig ? allSkuIdsSig.split(",") : [];
    if (ids.length === 0) { setAtsByItem({}); setAtsAsOf(null); return; }
    let cancelled = false;
    setAtsLoading(true);
    const reqBody: { item_ids: string[]; as_of_date?: string } = { item_ids: ids };
    if (atsAsOfDate) reqBody.as_of_date = atsAsOfDate; // window inbound supply to the ship date
    fetch("/api/internal/ats-by-size", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqBody) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        if (cancelled) return;
        const map: Record<string, number> = {};
        for (const [id, v] of Object.entries(j.availability || {})) map[id] = Math.max(0, Number((v as { available?: number })?.available) || 0);
        setAtsByItem(map); setAtsAsOf(j.as_of || null);
      })
      .catch(() => { if (!cancelled) { setAtsByItem({}); setAtsAsOf(null); } })
      .finally(() => { if (!cancelled) setAtsLoading(false); });
    return () => { cancelled = true; };
  }, [atsMode, allSkuIdsSig, atsAsOfDate]);

  // ── Imperative resolve (called at save) ────────────────────────────────────
  useImperativeHandle(ref, () => ({
    async resolve(): Promise<ResolvedLine[]> {
      const lines: ResolvedLine[] = [];
      for (const s of sections) {
        if (!s.payload) continue;
        const byCell = new Map<string, MatrixSku>();
        for (const sk of s.payload.skus) byCell.set(skuCellKey(sk.color, sk.size, sk.inseam || null), sk);
        for (const [cell, n] of Object.entries(s.qty)) {
          if (!(n > 0)) continue;
          const [rowKey, size] = cell.split("__");
          const [color, inseam] = rowKey.split("|");
          const unitDollars = (s.unit[rowKey] || "").trim();
          const existing = byCell.get(skuCellKey(color || null, size, inseam || null));
          let itemId = existing?.id || null;
          if (!itemId) {
            const r = await fetch("/api/internal/style-matrix/resolve-sku", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ style_id: s.payload.style.id, style_code: s.payload.style.style_code, color: color || null, size, inseam: inseam || null }),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok || !j.id) throw new Error(j.error || `Could not resolve SKU for ${color || ""} ${size} ${inseam || ""}`.trim());
            itemId = j.id as string;
          }
          lines.push({ inventory_item_id: itemId, qty_ordered: n, unit_price_cents: Math.round((Number(unitDollars) || 0) * 100) });
        }
      }
      for (const l of flat) {
        const q = Number(l.qty_ordered) || 0;
        if (q > 0 && l.inventory_item_id) lines.push({ inventory_item_id: l.inventory_item_id, qty_ordered: q, unit_price_cents: Math.round((Number(l.unit_price_dollars) || 0) * 100) });
      }
      return lines;
    },
  }), [sections, flat]);

  // Flat-picker options: merge any seeded label whose SKU isn't in the 500-item list.
  const flatOptions = useMemo(() => {
    const base = items.map((it) => ({ value: it.id, label: `${it.sku_code}${it.description ? ` — ${it.description}` : ""}`, searchHaystack: `${it.sku_code} ${it.style_code || ""} ${it.description || ""}` }));
    const have = new Set(items.map((i) => i.id));
    const extra = flat.filter((l) => l.inventory_item_id && l.label && !have.has(l.inventory_item_id)).map((l) => ({ value: l.inventory_item_id, label: l.label as string, searchHaystack: l.label as string }));
    return [{ value: "", label: "(select)" }, ...extra, ...base];
  }, [items, flat]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Lines — size matrix</div>
        {editable && (
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={addSection} style={{ ...btnSecondary, color: C.primary, borderColor: C.primary }}>➕ Add style (matrix)</button>
            <button onClick={addFlat} style={btnSecondary}>+ Add non-matrix line</button>
          </div>
        )}
      </div>

      {/* Prominent order totals at the top of the lines section (≈4× the size of
          the small footer totals, which is kept below). Replaces the old "▲
          available-to-ship by size" caption per operator request. */}
      {(sections.length > 0 || flat.length > 0) && (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "baseline", gap: 40, padding: "6px 4px 12px", borderBottom: `1px solid ${C.cardBdr}`, marginBottom: 12 }}>
          <span style={{ color: C.textMuted, fontSize: 18 }}>Total qty <b style={{ color: C.text, fontSize: 44, fontVariantNumeric: "tabular-nums", marginLeft: 8 }}>{totals.qty.toLocaleString()}</b></span>
          <span style={{ color: C.textMuted, fontSize: 18 }}>Total <b style={{ color: C.success, fontSize: 44, fontVariantNumeric: "tabular-nums", marginLeft: 8 }}>${(totals.cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></span>
          <span style={{ color: C.textMuted, fontSize: 18, display: "inline-flex", flexDirection: "column", alignItems: "flex-start" }}>
            <span>Proj. margin <b style={{ color: totals.marginPct >= 20 ? C.success : C.warn, fontSize: 44, fontVariantNumeric: "tabular-nums", marginLeft: 8 }}>{totals.cents > 0 ? `${totals.marginPct.toFixed(1)}%` : "—"}</b></span>
            {totals.cents > 0 && totals.marginEstimated && <span style={{ fontSize: 11, color: C.textMuted }}>estimated — no cost data (assumes 21%)</span>}
          </span>
        </div>
      )}

      {sections.length === 0 && flat.length === 0 && (
        <div style={{ color: C.textMuted, fontSize: 13, padding: "16px 12px", border: `1px dashed ${C.cardBdr}`, borderRadius: 8, marginBottom: 12 }}>
          {editable ? "Click ➕ Add style (matrix) and type ordered quantities into the color × size grid. Most styles are matrix-driven; use + Add non-matrix line for the rare one-off SKU." : "No lines."}
        </div>
      )}

      {/* Per-style matrix sections. */}
      {sections.map((s) => {
        const allRows = rowsFor(s.payload);
        // When locked (a confirmed order viewed read-only) show ONLY the color
        // rows that carry a quantity — the order, not the whole scale. Editable
        // (draft or "Add styles" mode) shows every color so any can be filled.
        const rows = editable ? allRows : allRows.filter((r) => (s.payload?.sizes || []).some((sz) => (s.qty[matrixCellKey(r.key, sz)] || 0) > 0));
        const onHand: Record<string, number> = {};
        if ((showOnHand || atsMode) && s.payload) for (const r of rows) { const [color, inseam] = r.key.split("|"); for (const sz of s.payload.sizes) { const sk = s.payload.skus.find((k) => skuCellKey(k.color, k.size, k.inseam || null) === skuCellKey(color || null, sz, inseam || null)); if (!sk) continue; const v = atsMode ? (atsByItem[sk.id] ?? 0) : sk.on_hand_qty; if (v != null) onHand[matrixCellKey(r.key, sz)] = Math.max(0, Number(v) || 0); } }
        return (
          <div key={s.id} style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 8, marginBottom: 12, background: C.card, padding: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center", marginBottom: 10 }}>
              <SearchableSelect value={s.styleId || null} onChange={(v) => void pickStyle(s.id, v)} disabled={!editable}
                options={styles.map((st) => ({ value: st.id, label: `${st.style_code}${st.style_name ? ` — ${st.style_name}` : st.description ? ` — ${st.description}` : ""}`, searchHaystack: `${st.style_code} ${st.style_name || ""} ${st.description || ""}` }))}
                placeholder="(pick a style…)" />
              {editable && <button onClick={() => removeSection(s.id)} style={btnDanger} title="Remove this style">✕</button>}
            </div>
            {s.loading && <div style={{ color: C.textMuted, fontSize: 13, padding: 8 }}>Loading size grid…</div>}
            {s.err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, fontSize: 13 }}>{s.err}</div>}
            {s.payload && s.payload.sizes.length === 0 && <div style={{ color: C.warn, fontSize: 13, padding: 8 }}>This style has no size scale — use “+ Add non-matrix line”.</div>}
            {s.payload && s.payload.sizes.length > 0 && (
              <EditableSizeMatrix
                rows={rows} sizes={s.payload.sizes}
                showRise={(s.payload.inseams?.length ?? 0) > 1} riseLabel="Inseam"
                qty={s.qty} onQtyChange={(rk, sz, v) => setQty(s.id, rk, sz, v)} onHand={onHand}
                unit={{ label: "Unit $", placeholder: "0.00", values: s.unit, onChange: (rk, v) => setUnit(s.id, rk, v), onSetAll: (v) => setAllUnit(s.id, rows, v), showLineTotal: true, forceDecimals: 2 }}
              />
            )}
          </div>
        );
      })}

      {/* Non-matrix flat lines (the ~5%). */}
      {flat.length > 0 && (
        <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup><col style={{ width: 36 }} /><col /><col style={{ width: 100 }} /><col style={{ width: 120 }} /><col style={{ width: 36 }} /></colgroup>
            <thead><tr><th style={th}>#</th><th style={th}>Non-matrix SKU</th><th style={th}>Qty</th><th style={th}>Unit $</th><th style={th}></th></tr></thead>
            <tbody>
              {flat.map((l, idx) => (
                <tr key={l.key}>
                  <td style={td}>{idx + 1}</td>
                  <td style={td}><SearchableSelect value={l.inventory_item_id || null} onChange={(v) => updateFlat(idx, { inventory_item_id: v })} options={flatOptions} placeholder="(pick SKU…)" disabled={!editable} /></td>
                  <td style={td}><input type="text" inputMode="decimal" value={l.qty_ordered} onChange={(e) => updateFlat(idx, { qty_ordered: e.target.value })} disabled={!editable} placeholder="0" style={numInput} /></td>
                  <td style={td}><input type="text" inputMode="decimal" value={l.unit_price_dollars} onChange={(e) => updateFlat(idx, { unit_price_dollars: e.target.value })} onBlur={() => { const n = Number((l.unit_price_dollars || "").replace(/,/g, "")); if (l.unit_price_dollars.trim() !== "" && Number.isFinite(n)) updateFlat(idx, { unit_price_dollars: n.toFixed(2) }); }} disabled={!editable} placeholder="0.00" style={numInput} /></td>
                  <td style={td}>{editable && <button type="button" onClick={() => removeFlat(idx)} style={btnDanger}>✕</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 24, padding: "4px 4px 0", fontSize: 13 }}>
        <span style={{ color: C.textMuted }}>Total qty <b style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>{totals.qty.toLocaleString()}</b></span>
        <span style={{ color: C.textMuted }}>Total <b style={{ color: C.success, fontVariantNumeric: "tabular-nums" }}>${(totals.cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></span>
      </div>
    </div>
  );
});

export default SalesOrderMatrixBody;
