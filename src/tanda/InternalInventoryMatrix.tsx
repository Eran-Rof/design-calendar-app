// src/tanda/InternalInventoryMatrix.tsx
//
// Tangerine MX-INV — Matrix Inventory on-hand view.
//
// A read-only color × size (× inseam) matrix of inventory for one style.
// Pick a style (SearchableSelect over /api/internal/style-master), fetch
// /api/internal/style-matrix?style_id=<uuid>, and render the shared
// MatrixGrid primitive with each cell showing the SKU's on-hand qty (or
// available qty when the toggle is flipped). When a style spans more than
// one inseam, inseam becomes a filter/layer dim on the grid.
//
// No new API route — reuses the shared style-matrix endpoint. No migration.

import { useEffect, useMemo, useState } from "react";
import { MatrixGrid } from "../shared/matrix";
import type { MatrixItem, MatrixPivotState } from "../shared/matrix";
import SearchableSelect from "./components/SearchableSelect";
import type { SearchableSelectOption } from "./components/SearchableSelect";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

// ── types ────────────────────────────────────────────────────────────────────

type StyleListRow = {
  id: string;
  style_code: string;
  style_name: string | null;
  description: string | null;
};

type MatrixSku = {
  id: string;
  color: string | null;
  size: string | null;
  inseam: string | null;
  length: string | null;
  fit: string | null;
  on_hand_qty: number | string | null;
  available_qty: number | string | null;
};

type MatrixPayload = {
  style: {
    id: string;
    style_code: string;
    style_name: string | null;
    description: string | null;
    size_scale_id: string | null;
  };
  sizes: string[];
  colors: string[];
  inseams: string[];
  skus: MatrixSku[];
};

type SizeScale = { id: string; name: string };

// ── palette (mirrors other Internal* panels) ─────────────────────────────────

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, colorScheme: "dark",
};

const btnToggle = (active: boolean): React.CSSProperties => ({
  background: active ? C.primary : "transparent",
  color: active ? "white" : C.textSub,
  border: `1px solid ${active ? C.primary : C.cardBdr}`,
  padding: "6px 14px", borderRadius: 6, cursor: "pointer",
  fontSize: 12, fontWeight: 600,
});

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtQty(v: number | string | null | undefined): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

// ── component ────────────────────────────────────────────────────────────────

export default function InternalInventoryMatrix() {
  const [styles, setStyles]     = useState<StyleListRow[]>([]);
  const [scales, setScales]     = useState<SizeScale[]>([]);
  const [styleId, setStyleId]   = useState<string>("");
  const [payload, setPayload]   = useState<MatrixPayload | null>(null);
  const [metric, setMetric]     = useState<"on_hand" | "available">("on_hand");
  const [loading, setLoading]   = useState(false);
  const [err, setErr]           = useState<string | null>(null);

  // Style list + size-scale names once on mount.
  useEffect(() => {
    fetch("/api/internal/style-master")
      .then((r) => r.json())
      .then((d) => setStyles(Array.isArray(d) ? d : (d.rows || d.styles || [])))
      .catch(() => {/* non-fatal; picker just stays empty */});
    fetch("/api/internal/size-scales")
      .then((r) => r.json())
      .then((d) => {
        const rows = Array.isArray(d) ? d : (d.rows || d.scales || []);
        setScales(rows.map((s: { id: string; name?: string; scale_name?: string }) => ({
          id: s.id, name: s.name || s.scale_name || "",
        })));
      })
      .catch(() => {/* non-fatal; scale name just shows as the id */});
  }, []);

  // Fetch the matrix payload when a style is picked.
  useEffect(() => {
    if (!styleId) { setPayload(null); return; }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetch(`/api/internal/style-matrix?style_id=${encodeURIComponent(styleId)}`)
      .then(async (r) => {
        if (!r.ok) {
          const detail = await r.json().catch(() => ({}));
          throw new Error((detail as { error?: string }).error || `HTTP ${r.status}`);
        }
        return r.json() as Promise<MatrixPayload>;
      })
      .then((d) => { if (!cancelled) setPayload(d); })
      .catch((e: unknown) => {
        if (!cancelled) { setErr(e instanceof Error ? e.message : String(e)); setPayload(null); }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [styleId]);

  // Style picker options "<style_code> — <style_name>".
  const styleOptions = useMemo<SearchableSelectOption[]>(
    () =>
      styles.map((s) => {
        const name = s.style_name || s.description || "";
        const label = name ? `${s.style_code} — ${name}` : s.style_code;
        return { value: s.id, label, searchHaystack: `${s.style_code} ${name}` };
      }),
    [styles],
  );

  // Map SKUs → MatrixItem[] with value = the selected metric.
  const items = useMemo<MatrixItem[]>(() => {
    if (!payload) return [];
    return payload.skus.map((s) => ({
      id: s.id,
      color: s.color,
      size: s.size,
      inseam: s.inseam,
      length: s.length,
      fit: s.fit,
      value: Number((metric === "on_hand" ? s.on_hand_qty : s.available_qty) ?? 0),
    }));
  }, [payload, metric]);

  // Default pivot: rows=color, cols=size. When the style spans >1 inseam,
  // inseam joins as a (no-op-default) filter dim so the pivot control offers
  // it as a layer/filter choice.
  const defaultPivot = useMemo<Partial<MatrixPivotState>>(() => {
    const base: Partial<MatrixPivotState> = { rowAxis: "color", colAxis: "size" };
    if (payload && payload.inseams.length > 1) base.filters = { inseam: [] };
    return base;
  }, [payload]);

  // Cell formatter: sum the metric across items in the cell; blank when empty
  // or zero so empty cells read cleanly.
  const format = useMemo(
    () => (cellItems: MatrixItem[]) => {
      if (cellItems.length === 0) return "";
      const sum = cellItems.reduce((acc, it) => acc + Number(it.value ?? 0), 0);
      return sum === 0 ? "" : fmtQty(sum);
    },
    [],
  );

  const scaleName = useMemo(() => {
    if (!payload?.style.size_scale_id) return null;
    return scales.find((s) => s.id === payload.style.size_scale_id)?.name || null;
  }, [payload, scales]);

  // Flat SKU rows for export.
  const exportRows = useMemo<Array<Record<string, unknown>>>(() => {
    if (!payload) return [];
    return payload.skus.map((s) => ({
      style_code:    payload.style.style_code,
      color:         s.color ?? "",
      size:          s.size ?? "",
      inseam:        s.inseam ?? "",
      on_hand_qty:   Number(s.on_hand_qty ?? 0),
      available_qty: s.available_qty == null ? "" : Number(s.available_qty),
    }));
  }, [payload]);

  const exportColumns: ExportColumn<Record<string, unknown>>[] = [
    { key: "style_code",    header: "Style" },
    { key: "color",         header: "Color" },
    { key: "size",          header: "Size" },
    { key: "inseam",        header: "Inseam" },
    { key: "on_hand_qty",   header: "On-Hand",   format: "number" },
    { key: "available_qty", header: "Available", format: "number" },
  ];

  return (
    <div style={{ color: C.text }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>🧮 Inventory Matrix</h2>
        {payload && (
          <div style={{ fontSize: 11, color: C.textMuted }}>
            {payload.skus.length} SKU{payload.skus.length === 1 ? "" : "s"}
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
        {/* Style picker */}
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, minWidth: 320 }}>
          Style
          <SearchableSelect
            value={styleId || null}
            onChange={(v) => setStyleId(v)}
            options={styleOptions}
            placeholder="Search style code or name…"
            inputStyle={inputStyle}
          />
        </label>

        {/* Metric toggle */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Show
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" style={btnToggle(metric === "on_hand")} onClick={() => setMetric("on_hand")}>
              On-Hand
            </button>
            <button type="button" style={btnToggle(metric === "available")} onClick={() => setMetric("available")}>
              Available
            </button>
          </div>
        </div>

        {payload && (
          <div style={{ alignSelf: "flex-end" }}>
            <ExportButton
              rows={exportRows}
              filename={`inventory-matrix-${payload.style.style_code}`}
              sheetName="Inventory Matrix"
              columns={exportColumns}
            />
          </div>
        )}
      </div>

      {/* Style meta */}
      {payload && (
        <div style={{ fontSize: 12, color: C.textSub, marginBottom: 12 }}>
          <span style={{ fontWeight: 600 }}>{payload.style.style_code}</span>
          {payload.style.style_name ? <span> — {payload.style.style_name}</span> : null}
          <span style={{ color: C.textMuted }}>
            {"  ·  Size scale: "}{scaleName || (payload.style.size_scale_id ? "—" : "none")}
            {"  ·  "}{metric === "on_hand" ? "On-hand qty" : "Available qty"}
          </span>
        </div>
      )}

      {/* Error banner */}
      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      {/* Grid */}
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 12, overflowX: "auto" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : !styleId ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            Pick a style to view its inventory matrix.
          </div>
        ) : !payload || payload.skus.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            No SKUs found for this style.
          </div>
        ) : (
          <MatrixGrid
            items={items}
            defaultPivot={defaultPivot}
            readOnly
            format={format}
          />
        )}
      </div>
    </div>
  );
}
