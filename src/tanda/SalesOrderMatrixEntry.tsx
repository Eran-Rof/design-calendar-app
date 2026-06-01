// src/tanda/SalesOrderMatrixEntry.tsx
//
// MX-SO — Matrix sales-order line entry.
//
// A sub-panel for the Sales Order modal's Lines area. Lets the operator pick a
// style, then type quantities INLINE into an editable color × size (× inseam)
// grid instead of one SearchableSelect line per SKU. Each color row also carries
// an editable Unit $ (with a "set all rows" bulk field in the column header) so
// the operator can stamp one price across the whole style and tweak per color.
//
// On "Add to order" each cell with qty > 0 is resolved to an ip_item_master SKU
// id (find-or-create via /api/internal/style-matrix/resolve-sku) and APPENDED to
// the modal's normal SO line state — the lines then submit through the EXISTING
// SO create/PATCH path unchanged.
//
// Uses the shared EditableSizeMatrix primitive (src/shared/matrix) so the SO,
// PO and inventory-adjustment grids all share one layout.

import { useEffect, useMemo, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import { EditableSizeMatrix, matrixCellKey } from "../shared/matrix";
import type { EditableMatrixRow } from "../shared/matrix";
import { notify } from "../shared/ui/warn";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };

type Style = { id: string; style_code: string; style_name?: string | null; description?: string | null };
type MatrixSku = { id: string; color: string | null; size: string | null; inseam: string | null; length: string | null; fit: string | null; on_hand_qty?: number; available_qty?: number | null };
type MatrixPayload = { style: { id: string; style_code: string }; sizes: string[]; colors: string[]; inseams: string[]; skus: MatrixSku[] };

/** A resolved SO line the parent appends to its line state. unit_price_dollars is
 *  blank when the operator left the row's Unit $ empty (server stamps the default). */
export type MatrixLineAdd = { inventory_item_id: string; qty_ordered: number; unit_price_dollars: string };

// (color, size, inseam) → existing-SKU lookup key.
const skuCellKey = (color: string | null, size: string | null, inseam: string | null) =>
  `${color ?? ""}|${size ?? ""}|${inseam ?? ""}`;
// Per-row key (color × inseam) used by the grid + the unit-price map.
const rowKeyOf = (color: string | null, inseam: string | null) => `${color ?? ""}|${inseam ?? ""}`;

export default function SalesOrderMatrixEntry({ onAdd, onClose }: { onAdd: (lines: MatrixLineAdd[]) => void; onClose: () => void }) {
  const [styles, setStyles] = useState<Style[]>([]);
  const [styleId, setStyleId] = useState<string>("");
  const [payload, setPayload] = useState<MatrixPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // qty per cell, keyed by matrixCellKey(rowKey, size).
  const [qtyMap, setQtyMap] = useState<Record<string, number>>({});
  // unit price (dollars, free text) per row, keyed by rowKey.
  const [unitMap, setUnitMap] = useState<Record<string, string>>({});

  // Style picker source.
  useEffect(() => {
    fetch("/api/internal/style-master?limit=10000")
      .then((r) => (r.ok ? r.json() : []))
      .then((a) => setStyles(Array.isArray(a) ? (a as Style[]) : []))
      .catch(() => {});
  }, []);

  // Fetch the matrix payload when a style is picked.
  useEffect(() => {
    if (!styleId) { setPayload(null); setQtyMap({}); setUnitMap({}); return; }
    let cancel = false;
    setLoading(true); setErr(null); setQtyMap({}); setUnitMap({});
    fetch(`/api/internal/style-matrix?style_id=${encodeURIComponent(styleId)}`)
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return r.json(); })
      .then((p) => { if (!cancel) setPayload(p as MatrixPayload); })
      .catch((e) => { if (!cancel) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [styleId]);

  const hasInseams = (payload?.inseams?.length ?? 0) > 1;

  // (color,size,inseam) → existing SKU, so resolve-sku is only called for cells
  // that don't already map to a SKU.
  const skuByCell = useMemo(() => {
    const m = new Map<string, MatrixSku>();
    for (const s of payload?.skus ?? []) m.set(skuCellKey(s.color, s.size, s.inseam || null), s);
    return m;
  }, [payload]);

  const sizes = payload?.sizes ?? [];

  // Grid rows: one per color (× inseam when the style spans multiple inseams).
  const rows = useMemo<EditableMatrixRow[]>(() => {
    if (!payload) return [];
    const colors = payload.colors.length
      ? payload.colors
      : [...new Set((payload.skus || []).map((s) => s.color).filter(Boolean) as string[])];
    const colorList: (string | null)[] = colors.length ? colors : [null];
    const inseamList: (string | null)[] = hasInseams ? payload.inseams : [null];
    const out: EditableMatrixRow[] = [];
    for (const color of colorList) {
      for (const inseam of inseamList) {
        out.push({ key: rowKeyOf(color, inseam), color: color ?? null, rise: inseam ?? null });
      }
    }
    return out;
  }, [payload, hasInseams]);

  // Per-cell on-hand hint (Σ remaining_qty — always ≥ 0). Keyed to grid cells.
  // NOTE: we intentionally show on-hand, NOT available_qty (on-hand − open
  // reservations), which can read negative on over-allocation and confused the
  // operator ("false negative"). On-hand is what the grid label promises.
  const onHand = useMemo(() => {
    const m: Record<string, number> = {};
    for (const row of rows) {
      const [color, inseam] = row.key.split("|");
      for (const sz of sizes) {
        const sku = skuByCell.get(skuCellKey(color || null, sz, inseam || null));
        if (sku && sku.on_hand_qty != null) m[matrixCellKey(row.key, sz)] = Math.max(0, Number(sku.on_hand_qty) || 0);
      }
    }
    return m;
  }, [rows, sizes, skuByCell]);

  const totalUnits = useMemo(() => Object.values(qtyMap).reduce((s, n) => s + (n || 0), 0), [qtyMap]);
  const cellsFilled = useMemo(() => Object.values(qtyMap).filter((n) => n > 0).length, [qtyMap]);

  function setQty(rowKey: string, size: string, n: number) {
    const key = matrixCellKey(rowKey, size);
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
      for (const [cell, qty] of entries) {
        // cell = `${rowKey}__${size}` = `${color}|${inseam}__${size}`.
        const [rowKey, size] = cell.split("__");
        const [color, inseam] = rowKey.split("|");
        const unitPrice = unitMap[rowKey]?.trim() || "";
        const existing = skuByCell.get(skuCellKey(color || null, size, inseam || null));
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
        adds.push({ inventory_item_id: itemId, qty_ordered: qty, unit_price_dollars: unitPrice });
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
          {cellsFilled > 0 ? <span style={{ color: C.text }}>{cellsFilled} cells · {totalUnits} units</span> : "type quantities into the grid"}
        </div>
      </div>

      {loading && <div style={{ color: C.textMuted, fontSize: 13, padding: 12 }}>Loading size grid…</div>}

      {!loading && payload && sizes.length === 0 && (
        <div style={{ color: C.warn, fontSize: 13, padding: 12 }}>
          This style has no size scale and no existing SKUs to derive sizes from — use manual line entry instead.
        </div>
      )}

      {!loading && payload && sizes.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <EditableSizeMatrix
            rows={rows}
            sizes={sizes}
            showRise={hasInseams}
            riseLabel="Inseam"
            qty={qtyMap}
            onQtyChange={setQty}
            onHand={onHand}
            unit={{
              label: "Unit $",
              placeholder: "0.00",
              values: unitMap,
              onChange: (rowKey, v) => setUnitMap((p) => ({ ...p, [rowKey]: v })),
              onSetAll: (v) => setUnitMap(() => Object.fromEntries(rows.map((r) => [r.key, v]))),
            }}
          />
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 8 }}>
            Type ordered quantities directly into the grid. The faint number above each cell is the current on-hand. Use the <b>Unit $</b> header field to stamp one price across every color, then tweak rows as needed (leave blank to use the customer's default price). Cells without a SKU yet are created automatically on “Add to order”.
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
