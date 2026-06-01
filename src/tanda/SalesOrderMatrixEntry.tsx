// src/tanda/SalesOrderMatrixEntry.tsx
//
// MX-SO — Matrix sales-order line entry.
//
// A sub-panel for the Sales Order modal's Lines area. Lets the operator pick a
// style, then enter quantities into an editable color × size (× inseam) grid
// instead of one SearchableSelect line per SKU. On "Add to order" each cell
// with qty > 0 is resolved to an ip_item_master SKU id (find-or-create via
// /api/internal/style-matrix/resolve-sku) and APPENDED to the modal's normal
// SO line state — the lines then submit through the EXISTING SO create/PATCH
// path unchanged.
//
// Reuses the shared Matrix primitive (src/shared/matrix). Because MatrixCell
// only dispatches onCellClick for non-empty cells, we seed one synthetic
// MatrixItem per color × size (× inseam) combination so every cell is clickable
// — carrying the entered qty in `value` and the real SKU id (when the style
// already has one for that cell) so we can skip resolve-sku for known SKUs.

import { useEffect, useMemo, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import { MatrixGrid } from "../shared/matrix";
import type { MatrixItem, MatrixPivotState } from "../shared/matrix";
import { notify } from "../shared/ui/warn";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box" };
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };

type Style = { id: string; style_code: string; style_name?: string | null; description?: string | null };
type MatrixSku = { id: string; color: string | null; size: string | null; inseam: string | null; length: string | null; fit: string | null; on_hand_qty?: number; available_qty?: number | null };
type MatrixPayload = { style: { id: string; style_code: string }; sizes: string[]; colors: string[]; inseams: string[]; skus: MatrixSku[] };

/** A resolved SO line the parent appends to its line state. */
export type MatrixLineAdd = { inventory_item_id: string; qty_ordered: number };

const cellKey = (color: string | null, size: string | null, inseam: string | null) =>
  `${color ?? ""}|${size ?? ""}|${inseam ?? ""}`;

export default function SalesOrderMatrixEntry({ onAdd, onClose }: { onAdd: (lines: MatrixLineAdd[]) => void; onClose: () => void }) {
  const [styles, setStyles] = useState<Style[]>([]);
  const [styleId, setStyleId] = useState<string>("");
  const [payload, setPayload] = useState<MatrixPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // qty per cell, keyed by `${color}|${size}|${inseam||""}`.
  const [qtyMap, setQtyMap] = useState<Record<string, number>>({});

  // Style picker source.
  useEffect(() => {
    fetch("/api/internal/style-master?limit=10000")
      .then((r) => (r.ok ? r.json() : []))
      .then((a) => setStyles(Array.isArray(a) ? (a as Style[]) : []))
      .catch(() => {});
  }, []);

  // Fetch the matrix payload when a style is picked.
  useEffect(() => {
    if (!styleId) { setPayload(null); setQtyMap({}); return; }
    let cancel = false;
    setLoading(true); setErr(null); setQtyMap({});
    fetch(`/api/internal/style-matrix?style_id=${encodeURIComponent(styleId)}`)
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return r.json(); })
      .then((p) => { if (!cancel) setPayload(p as MatrixPayload); })
      .catch((e) => { if (!cancel) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [styleId]);

  const hasInseams = (payload?.inseams?.length ?? 0) > 1;

  // Map (color,size,inseam) → existing SKU id + available, so resolve-sku is
  // only called for cells that don't already map to a SKU.
  const skuByCell = useMemo(() => {
    const m = new Map<string, MatrixSku>();
    for (const s of payload?.skus ?? []) m.set(cellKey(s.color, s.size, s.inseam || null), s);
    return m;
  }, [payload]);

  // Build a synthetic MatrixItem per color × size (× inseam) so EVERY cell is
  // clickable (MatrixCell only fires onCellClick for non-empty cells). When an
  // inseam axis applies we fan each color×size out across inseams; otherwise a
  // single inseam=null plane. `value` carries the entered qty for display.
  const items = useMemo<MatrixItem[]>(() => {
    if (!payload) return [];
    const colors = payload.colors.length ? payload.colors : [...new Set((payload.skus || []).map((s) => s.color).filter(Boolean) as string[])];
    const colorList: (string | null)[] = colors.length ? colors : [null];
    const inseamList: (string | null)[] = hasInseams ? payload.inseams : [null];
    const out: MatrixItem[] = [];
    for (const color of colorList) {
      for (const size of payload.sizes) {
        for (const inseam of inseamList) {
          const key = cellKey(color, size, inseam);
          out.push({
            id: key,
            color: color ?? null,
            size: size ?? null,
            inseam: inseam ?? null,
            length: null,
            fit: null,
            rise: null,
            value: qtyMap[key] ?? 0,
          });
        }
      }
    }
    return out;
  }, [payload, qtyMap, hasInseams]);

  const axisValues = useMemo(
    () => ({ color: (payload?.colors ?? []) as string[], size: (payload?.sizes ?? []) as string[], inseam: (payload?.inseams ?? []) as string[] }),
    [payload],
  );

  // Pivot: rows = color, cols = size. When the style has >1 inseam we layer by
  // inseam (multi-value filter → one grid per inseam tab).
  const pivot = useMemo<MatrixPivotState>(() => ({
    rowAxis: "color",
    colAxis: "size",
    filters: hasInseams ? { inseam: payload!.inseams } : {},
  }), [hasInseams, payload]);

  const totalUnits = useMemo(() => Object.values(qtyMap).reduce((s, n) => s + (n || 0), 0), [qtyMap]);
  const cellsFilled = useMemo(() => Object.values(qtyMap).filter((n) => n > 0).length, [qtyMap]);

  // Cell formatter: show entered qty, with available_qty as a faint hint.
  function format(cellItems: MatrixItem[]): string {
    const it = cellItems[0];
    if (!it) return "";
    const key = cellKey(it.color, it.size, it.inseam);
    const qty = qtyMap[key] ?? 0;
    const sku = skuByCell.get(key);
    const avail = sku && sku.available_qty != null ? sku.available_qty : null;
    const hint = avail != null ? ` (${avail})` : "";
    return qty > 0 ? `${qty}${hint}` : (avail != null ? `·${hint.trim()}` : "");
  }

  function editCell(color: string | null, size: string | null, inseam: string | null) {
    const key = cellKey(color, size, inseam);
    const current = qtyMap[key] ?? 0;
    const sku = skuByCell.get(key);
    const availTxt = sku && sku.available_qty != null ? ` (available: ${sku.available_qty})` : "";
    const labelBits = [color, size, hasInseams && inseam ? `${inseam}"` : ""].filter(Boolean).join(" / ");
    // eslint-disable-next-line no-alert
    const raw = window.prompt(`Qty for ${labelBits}${availTxt}`, current ? String(current) : "");
    if (raw == null) return; // cancelled
    const n = Math.max(0, Math.floor(Number(raw) || 0));
    setQtyMap((p) => {
      const next = { ...p };
      if (n > 0) next[key] = n; else delete next[key];
      return next;
    });
  }

  async function addToOrder() {
    if (!payload) return;
    const entries = Object.entries(qtyMap).filter(([, n]) => n > 0);
    if (entries.length === 0) { setErr("Enter a quantity in at least one cell."); return; }
    setSubmitting(true); setErr(null);
    try {
      const adds: MatrixLineAdd[] = [];
      for (const [key, qty] of entries) {
        const [color, size, inseam] = key.split("|");
        const existing = skuByCell.get(key);
        let itemId = existing?.id || null;
        if (!itemId) {
          const r = await fetch("/api/internal/style-matrix/resolve-sku", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              style_id: payload.style.id, style_code: payload.style.style_code,
              color: color || null, size, inseam: inseam || null,
            }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.id) throw new Error(j.error || `Could not resolve SKU for ${color || ""} ${size} ${inseam || ""}`.trim());
          itemId = j.id as string;
        }
        adds.push({ inventory_item_id: itemId, qty_ordered: qty });
      }
      onAdd(adds);
      notify(`Added ${adds.length} line${adds.length === 1 ? "" : "s"} (${totalUnits} units) from the size grid.`, "success");
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "end", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Style</div>
          <SearchableSelect
            value={styleId || null}
            onChange={(v) => setStyleId(v)}
            options={styles.map((s) => ({
              value: s.id,
              label: `${s.style_code}${s.style_name ? ` — ${s.style_name}` : s.description ? ` — ${s.description}` : ""}`,
              searchHaystack: `${s.style_code} ${s.style_name || ""} ${s.description || ""}`,
            }))}
            placeholder="(pick a style…)"
          />
        </div>
        <div style={{ fontSize: 12, color: C.textMuted, whiteSpace: "nowrap" }}>
          {cellsFilled > 0 ? <span style={{ color: C.text }}>{cellsFilled} cells · {totalUnits} units</span> : "click a cell to enter qty"}
        </div>
      </div>

      {loading && <div style={{ color: C.textMuted, fontSize: 13, padding: 12 }}>Loading size grid…</div>}

      {!loading && payload && payload.sizes.length === 0 && (
        <div style={{ color: C.warn, fontSize: 13, padding: 12 }}>
          This style has no size scale and no existing SKUs to derive sizes from — use manual line entry instead.
        </div>
      )}

      {!loading && payload && payload.sizes.length > 0 && (
        <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12, marginBottom: 12, overflowX: "auto" }}>
          <MatrixGrid
            items={items}
            pivot={pivot}
            axisValues={axisValues}
            readOnly={false}
            format={format}
            onCellClick={(cell) => {
              const it = cell.items[0];
              if (!it) return;
              editCell(it.color, it.size, it.inseam);
            }}
          />
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 8 }}>
            Click a cell to enter the ordered quantity. Numbers in parentheses are currently available on-hand. Cells without a SKU yet are created automatically on “Add to order”.
          </div>
        </div>
      )}

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
        <button type="button" onClick={() => void addToOrder()} style={btnPrimary} disabled={submitting || !payload || totalUnits === 0}>
          {submitting ? "Adding…" : `Add to order${totalUnits > 0 ? ` (${totalUnits} units)` : ""}`}
        </button>
      </div>
    </div>
  );
}
