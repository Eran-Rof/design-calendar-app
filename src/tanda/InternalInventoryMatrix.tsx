// src/tanda/InternalInventoryMatrix.tsx
//
// Tangerine MX-INV — Matrix Inventory on-hand view.
//
// Pick a style (SearchableSelect over /api/internal/style-master — the
// endpoint returns up to 10k entity-scoped styles so every style is
// reachable), fetch /api/internal/style-matrix?style_id=<uuid>, and render a
// poMatrixTab-style "Item Matrix" table: one row per color (× rise when the
// style spans more than one rise), size columns in scale order, an amber
// TOTAL, green Avg Cost + Total Cost, and a Last-Received date — mirroring the
// PO detail matrix the operator works from.
//
// No new API route — reuses the shared style-matrix endpoint. No migration.

import { useEffect, useMemo, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import type { SearchableSelectOption } from "./components/SearchableSelect";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { fmtCurrency, fmtDate } from "../utils/tandaTypes";

// ── types ────────────────────────────────────────────────────────────────────

type StyleListRow = {
  id: string;
  style_code: string;
  style_name: string | null;
  description: string | null;
  group_name?: string | null;
  category_name?: string | null;
  sub_category_name?: string | null;
  brand_id?: string | null;
};

type MatrixSku = {
  id: string;
  sku_code: string | null;
  color: string | null;
  size: string | null;
  inseam: string | null;
  length: string | null;
  fit: string | null;
  rise: string | null;
  on_hand_qty: number | string | null;
  on_hand_by_wh?: Record<string, number> | null;
  available_qty: number | string | null;
  avg_cost_cents: number | null;
  last_received: string | null;
};

type MatrixPayload = {
  style: {
    id: string;
    style_code: string;
    style_name: string | null;
    description: string | null;
    size_scale_id: string | null;
    brand_id?: string | null;
  };
  sizes: string[];
  colors: string[];
  inseams: string[];
  rises: string[];
  warehouses?: string[];
  skus: MatrixSku[];
  // Additive — present only when fetched with explode_ppk=true.
  explode?: ExplodeInfo;
};

type ExplodeCell = { color: string; size: string; qty: number; by_wh?: Record<string, number> };
type ExplodeInfo = {
  enabled: boolean;
  cells: ExplodeCell[];
  packs_exploded: number;
  packs_unmatched: Array<{ ppk_style_code: string; color: string | null; pack_token: string | null; qty: number }>;
  ppk_styles: string[];
};

type SizeScale = { id: string; name: string };

type Brand = { id: string; code: string | null; name: string | null };

const ALL_WAREHOUSES = "__all__";

// ── palette (mirrors poMatrixTab + other Internal* panels) ───────────────────

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
  // poMatrixTab tokens:
  headerBg: "#0F172A", headerText: "#6B7280", gridText: "#E5E7EB",
  base: "#60A5FA", desc: "#9CA3AF", amber: "#F59E0B", green: "#10B981",
  rowBdr: "#1E293B", sectionBdr: "#334155", emptyCell: "#334155",
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

// ATS app accent (matches the PLM launcher's ATS card color).
const ATS_GREEN = "#10B981";

// Cross-app link button → ATS app at /ats (same `<a href>` nav the suite uses
// for its other app links, e.g. App.tsx T&A → /tanda, Costing → /costing).
const atsLinkStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6,
  background: ATS_GREEN, color: "white",
  border: `1px solid ${ATS_GREEN}`,
  padding: "6px 14px", borderRadius: 6, cursor: "pointer",
  fontSize: 12, fontWeight: 600, textDecoration: "none",
  whiteSpace: "nowrap",
};

const chipStyle = (active: boolean): React.CSSProperties => ({
  padding: "4px 10px", borderRadius: 12,
  border: `1px solid ${active ? C.primary : C.cardBdr}`,
  background: active ? "rgba(59,130,246,0.18)" : "transparent",
  color: active ? "#93C5FD" : C.textSub,
  fontSize: 12, cursor: "pointer", lineHeight: 1.4,
});

// poMatrixTab header cell
const thBase: React.CSSProperties = {
  padding: "10px 14px", color: C.headerText, fontSize: 11,
  textTransform: "uppercase", letterSpacing: 1, borderBottom: `2px solid ${C.sectionBdr}`,
};

// ── helpers ──────────────────────────────────────────────────────────────────

const num = (v: number | string | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function fmtQty(v: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

// ── component ────────────────────────────────────────────────────────────────

export default function InternalInventoryMatrix() {
  const [styles, setStyles]     = useState<StyleListRow[]>([]);
  const [scales, setScales]     = useState<SizeScale[]>([]);
  const [brands, setBrands]     = useState<Brand[]>([]);
  const [brandId, setBrandId]   = useState<string>(""); // "" = all brands
  const [styleId, setStyleId]   = useState<string>("");
  const [payload, setPayload]   = useState<MatrixPayload | null>(null);
  // On-Hand is the only metric. The old "Available" toggle was replaced by an
  // ATS app link (see the Show/ATS controls below).
  const [warehouse, setWarehouse] = useState<string>(ALL_WAREHOUSES); // ALL_WAREHOUSES = sum everything
  const [hideZeros, setHideZeros] = useState(true); // default: hide zero-total color rows
  const [riseFilter, setRiseFilter] = useState<string[]>([]); // [] = all
  const [explodePpk, setExplodePpk] = useState(false); // off by default; folds PPK packs → sized eaches
  const [loading, setLoading]   = useState(false);
  const [err, setErr]           = useState<string | null>(null);

  // Style list + size-scale names once on mount. Request the endpoint's max
  // limit so EVERY entity style is reachable in the picker (operator reported
  // missing styles when the list was capped).
  useEffect(() => {
    fetch("/api/internal/style-master?limit=10000")
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
    // Brands for the style-picker scope filter.
    fetch("/api/internal/brands")
      .then((r) => r.json())
      .then((d) => {
        const rows = Array.isArray(d) ? d : (d.brands || []);
        setBrands(rows.map((b: { id: string; code?: string | null; name?: string | null }) => ({
          id: b.id, code: b.code ?? null, name: b.name ?? null,
        })));
      })
      .catch(() => {/* non-fatal; brand filter just stays empty */});
  }, []);

  // Fetch the matrix payload when a style is picked (or the explode toggle
  // flips — the explode folds in on the server). The rise/warehouse resets only
  // run on a style change, not on every explode toggle, so the operator keeps
  // their warehouse filter when turning Explode on/off.
  useEffect(() => {
    if (!styleId) { setPayload(null); setRiseFilter([]); return; }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    const url = `/api/internal/style-matrix?style_id=${encodeURIComponent(styleId)}${explodePpk ? "&explode_ppk=true" : ""}`;
    fetch(url)
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
  }, [styleId, explodePpk]);

  // Reset rise + warehouse filters on a STYLE change only (not on explode toggle).
  useEffect(() => {
    setRiseFilter([]);
    setWarehouse(ALL_WAREHOUSES);
  }, [styleId]);

  // Brand picker options (blank = all brands). Label prefers code, falls back to name.
  const brandOptions = useMemo<SearchableSelectOption[]>(
    () =>
      brands.map((b) => ({
        value: b.id,
        label: b.code && b.name ? `${b.code} — ${b.name}` : (b.name || b.code || b.id),
      })),
    [brands],
  );

  // Styles narrowed to the selected brand (brand filter scopes the STYLE picker).
  // brand_id comes straight off the style-master list payload, so the narrowing
  // is purely client-side — no extra fetch.
  const brandStyles = useMemo<StyleListRow[]>(
    () => (brandId ? styles.filter((s) => s.brand_id === brandId) : styles),
    [styles, brandId],
  );

  // If the currently-picked style isn't in the brand-narrowed set, clear it so
  // the matrix doesn't show a style that's hidden from the picker.
  useEffect(() => {
    if (styleId && !brandStyles.some((s) => s.id === styleId)) setStyleId("");
  }, [brandStyles, styleId]);

  // brand_id → "CODE Name" so a brand-only search (typing a brand code/name
  // into the Style picker) resolves that brand's styles. Without this the brand
  // never reaches the style haystack below, so a brand-alone search matched
  // nothing even though every style carries a brand_id.
  const brandLabelById = useMemo<Map<string, string>>(
    () => new Map(brands.map((b) => [b.id, [b.code, b.name].filter(Boolean).join(" ")])),
    [brands],
  );

  // Style picker options "<style_code> — <style_name>".
  const styleOptions = useMemo<SearchableSelectOption[]>(
    () =>
      brandStyles.map((s) => {
        const name = s.style_name || s.description || "";
        const label = name ? `${s.style_code} — ${name}` : s.style_code;
        // Search across code + name + description + group/category/sub + brand
        // so a style is reachable by any of them (not just code/name) — including
        // a brand-alone search where the operator types just the brand code/name.
        const searchHaystack = [
          s.style_code, s.style_name, s.description,
          s.group_name, s.category_name, s.sub_category_name,
          s.brand_id ? brandLabelById.get(s.brand_id) : null,
        ].filter(Boolean).join(" ");
        return { value: s.id, label, searchHaystack };
      }),
    [brandStyles, brandLabelById],
  );

  const rises = payload?.rises ?? [];
  const showRise = rises.length > 1;

  // Size columns in scale order (payload.sizes is already scale-ordered;
  // fall back to distinct SKU sizes if the style has no scale).
  const sizeOrder = useMemo<string[]>(() => {
    if (!payload) return [];
    if (payload.sizes.length) return payload.sizes;
    const seen: string[] = [];
    for (const s of payload.skus) if (s.size && !seen.includes(s.size)) seen.push(s.size);
    return seen;
  }, [payload]);

  // Warehouses available for the filter — prefer the payload's list; fall back
  // to deriving from the SKUs' on_hand_by_wh maps for older payload shapes.
  const warehouseList = useMemo<string[]>(() => {
    if (payload?.warehouses && payload.warehouses.length) return payload.warehouses;
    if (!payload) return [];
    const seen = new Set<string>();
    for (const s of payload.skus) for (const w of Object.keys(s.on_hand_by_wh || {})) seen.add(w);
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [payload]);

  // The warehouse filter narrows on-hand (the breakdown is on-hand-only).
  // "All" sums every warehouse; a specific warehouse narrows to its column.
  const whActive = warehouse !== ALL_WAREHOUSES;

  // qty for a SKU under the active warehouse filter (On-Hand is the only metric).
  const skuQty = (s: MatrixSku) => {
    if (whActive) return num((s.on_hand_by_wh || {})[warehouse]);
    return num(s.on_hand_qty);
  };

  // qty for one exploded cell under the active warehouse filter.
  const cellQty = (c: ExplodeCell) => {
    if (whActive) return num((c.by_wh || {})[warehouse]);
    return num(c.qty);
  };

  // Group SKUs into matrix rows: one row per color (× rise when the style
  // spans >1 rise). Each row carries a size→qty map, a blended avg cost
  // (qty-weighted across the row's SKUs), the row's total qty, total cost,
  // and the latest received date.
  type MatrixRow = {
    key: string;
    color: string;
    rise: string | null;
    sizes: Record<string, number>;
    totalQty: number;
    avgCostCents: number | null; // qty-weighted blended avg, cents
    totalCostCents: number;
    lastReceived: string | null;
  };

  const rows = useMemo<MatrixRow[]>(() => {
    if (!payload) return [];
    const active = riseFilter.length ? new Set(riseFilter) : null;
    const map = new Map<string, MatrixRow>();
    for (const s of payload.skus) {
      const rise = s.rise ?? null;
      if (active && !(rise != null && active.has(rise))) continue;
      const color = s.color ?? "—";
      const key = showRise ? `${color}|${rise ?? ""}` : color;
      let row = map.get(key);
      if (!row) {
        row = { key, color, rise, sizes: {}, totalQty: 0, avgCostCents: null, totalCostCents: 0, lastReceived: null };
        map.set(key, row);
      }
      const qty = skuQty(s);
      if (s.size) row.sizes[s.size] = (row.sizes[s.size] || 0) + qty;
      row.totalQty += qty;
      if (s.avg_cost_cents != null) {
        row.totalCostCents += Math.round(qty * s.avg_cost_cents);
      }
      if (s.last_received && (!row.lastReceived || s.last_received > row.lastReceived)) {
        row.lastReceived = s.last_received;
      }
    }

    // Fold exploded PPK eaches into the matrix (additive). Explode cells carry
    // no rise dimension (a pack is rise-agnostic), so when the style spans >1
    // rise they land on a rise-less "(prepack)" row per color rather than being
    // attributed to a specific rise. When rise filtering is active we still show
    // them (a rise-less bucket is never excluded by a rise filter). They add to
    // qty/sizes only — there is no per-each cost on a pack.
    if (payload.explode?.enabled) {
      for (const c of payload.explode.cells) {
        const qty = cellQty(c);
        if (!qty) continue;
        const color = c.color || "—";
        const key = showRise ? `${color}|` : color; // rise-less bucket
        let row = map.get(key);
        if (!row) {
          row = { key, color, rise: showRise ? "(prepack)" : null, sizes: {}, totalQty: 0, avgCostCents: null, totalCostCents: 0, lastReceived: null };
          map.set(key, row);
        }
        if (c.size) row.sizes[c.size] = (row.sizes[c.size] || 0) + qty;
        row.totalQty += qty;
      }
    }

    // Blended avg cost = totalCost / totalQty (cents). When a row has qty but
    // no cost data, leave avg null; when qty is 0 fall back to a simple mean of
    // the SKUs' avg_cost so a cost still shows for zero-on-hand colors.
    for (const row of map.values()) {
      if (row.totalQty > 0 && row.totalCostCents > 0) {
        row.avgCostCents = Math.round(row.totalCostCents / row.totalQty);
      }
    }
    // Simple-mean fallback for avg cost (covers zero-qty rows) and ensure every
    // row reflects an avg when any SKU has cost.
    const skuByRow = new Map<string, number[]>();
    for (const s of payload.skus) {
      const rise = s.rise ?? null;
      if (active && !(rise != null && active.has(rise))) continue;
      const color = s.color ?? "—";
      const key = showRise ? `${color}|${rise ?? ""}` : color;
      if (s.avg_cost_cents != null) {
        const arr = skuByRow.get(key) ?? [];
        arr.push(s.avg_cost_cents);
        skuByRow.set(key, arr);
      }
    }
    for (const row of map.values()) {
      if (row.avgCostCents == null) {
        const arr = skuByRow.get(row.key);
        if (arr && arr.length) row.avgCostCents = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
      }
    }
    // Sort by descending row Total qty (highest first); stable for ties — the
    // Map preserves first-seen (SKU) order, and we keep that order on equal qty.
    const ordered = [...map.values()];
    return ordered
      .map((r, i) => ({ r, i }))
      .sort((a, b) => (b.r.totalQty - a.r.totalQty) || (a.i - b.i))
      .map((x) => x.r);
  }, [payload, riseFilter, showRise, warehouse]);

  // Apply the hide-zero-total-rows toggle (default ON). Hides color rows whose
  // row Total under the active metric+warehouse is 0 (e.g. White / Woodland Camo
  // with no on-hand). Totals below are computed over the visible rows so the
  // Grand Total always matches what's shown.
  const visibleRows = useMemo<MatrixRow[]>(
    () => (hideZeros ? rows.filter((r) => r.totalQty !== 0) : rows),
    [rows, hideZeros],
  );

  // Column (size) grand totals + grand totals for the footer.
  const colTotals = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const sz of sizeOrder) out[sz] = visibleRows.reduce((s, r) => s + (r.sizes[sz] || 0), 0);
    return out;
  }, [visibleRows, sizeOrder]);

  const grandQty = useMemo(() => visibleRows.reduce((s, r) => s + r.totalQty, 0), [visibleRows]);
  const grandCostCents = useMemo(() => visibleRows.reduce((s, r) => s + r.totalCostCents, 0), [visibleRows]);

  const scaleName = useMemo(() => {
    if (!payload?.style.size_scale_id) return null;
    return scales.find((s) => s.id === payload.style.size_scale_id)?.name || null;
  }, [payload, scales]);

  // Flat rows for export (one per matrix row).
  const exportRows = useMemo<Array<Record<string, unknown>>>(() => {
    if (!payload) return [];
    return visibleRows.map((r) => {
      const out: Record<string, unknown> = {
        style_code: payload.style.style_code,
        color: r.color,
      };
      if (showRise) out.rise = r.rise ?? "";
      for (const sz of sizeOrder) out[`size_${sz}`] = r.sizes[sz] || 0;
      out.total_qty = r.totalQty;
      out.avg_cost_cents = r.avgCostCents == null ? "" : r.avgCostCents;
      out.total_cost_cents = r.totalCostCents;
      out.last_received = r.lastReceived ?? "";
      return out;
    });
  }, [payload, visibleRows, sizeOrder, showRise]);

  const exportColumns = useMemo<ExportColumn<Record<string, unknown>>[]>(() => {
    const cols: ExportColumn<Record<string, unknown>>[] = [
      { key: "style_code", header: "Style" },
      { key: "color", header: "Color" },
    ];
    if (showRise) cols.push({ key: "rise", header: "Rise" });
    for (const sz of sizeOrder) cols.push({ key: `size_${sz}`, header: sz, format: "number" });
    cols.push({ key: "total_qty", header: "Total", format: "number" });
    cols.push({ key: "avg_cost_cents", header: "Avg Cost", format: "currency_cents" });
    cols.push({ key: "total_cost_cents", header: "Total Cost", format: "currency_cents" });
    cols.push({ key: "last_received", header: "Last Received", format: "date" });
    return cols;
  }, [sizeOrder, showRise]);

  // The footer's "Grand Total" label must span EVERY leading data column so the
  // size totals and trailing Total/Total-Cost cells line up under their headers.
  // Leading data cols = Base Part + Description + Color (= 3), plus Rise when the
  // style spans >1 rise (= 4). The previous value (2/3) was off by one, which
  // shifted the whole footer one column left of the data rows.
  const colSpanLead = showRise ? 4 : 3;

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
        {/* Brand filter — scopes the style picker to one brand ("" = all). */}
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, minWidth: 200 }}>
          Brand
          <SearchableSelect
            value={brandId || null}
            onChange={(v) => setBrandId(v || "")}
            options={brandOptions}
            placeholder="(all brands)"
            inputStyle={inputStyle}
          />
        </label>

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

        {/* Metric + cross-app link. On-Hand is the only metric (always active);
            the old "Available" toggle is now a link out to the ATS app, which is
            the suite's source of truth for available-to-sell. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Show
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" style={btnToggle(true)} disabled>
              On-Hand
            </button>
            <a
              href="/ats"
              target="_blank"
              rel="noopener noreferrer"
              style={atsLinkStyle}
              title="Open the ATS app for available-to-sell"
            >
              ATS ↗
            </a>
          </div>
        </div>

        {/* Warehouse filter — on-hand-only; "All" sums every warehouse (today's
            number). Always enabled now that On-Hand is the only metric. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Warehouse
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              style={btnToggle(warehouse === ALL_WAREHOUSES)}
              onClick={() => setWarehouse(ALL_WAREHOUSES)}
            >
              All
            </button>
            {warehouseList.map((wh) => (
              <button
                key={wh}
                type="button"
                style={btnToggle(warehouse === wh)}
                onClick={() => setWarehouse(wh)}
              >
                {wh}
              </button>
            ))}
          </div>
        </div>

        {/* Hide-zero-rows toggle (default ON). */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Rows
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" style={btnToggle(hideZeros)} onClick={() => setHideZeros(true)}>
              Hide Zero
            </button>
            <button type="button" style={btnToggle(!hideZeros)} onClick={() => setHideZeros(false)}>
              Show All
            </button>
          </div>
        </div>

        {/* Explode-PPK toggle (default OFF). When ON, the picked style's PPK
            sibling packs on-hand are converted to sized eaches via the Prepack
            Matrix master and folded into the grid. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Prepacks
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" style={btnToggle(!explodePpk)} onClick={() => setExplodePpk(false)}>
              Off
            </button>
            <button type="button" style={btnToggle(explodePpk)} onClick={() => setExplodePpk(true)} title="Convert PPK packs on-hand into sized eaches using the Prepack Matrix master">
              Explode PPK
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

      {/* Rise filter — only when the style spans more than one rise. */}
      {showRise && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Rise:</span>
          <button type="button" style={chipStyle(riseFilter.length === 0)} onClick={() => setRiseFilter([])}>All</button>
          {rises.map((rv) => {
            const on = riseFilter.includes(rv);
            return (
              <button
                key={rv}
                type="button"
                style={chipStyle(on)}
                onClick={() => setRiseFilter(on ? riseFilter.filter((x) => x !== rv) : [...riseFilter, rv])}
              >
                {rv}
              </button>
            );
          })}
        </div>
      )}

      {/* Style meta */}
      {payload && (
        <div style={{ fontSize: 12, color: C.textSub, marginBottom: 12 }}>
          <span style={{ fontWeight: 600 }}>{payload.style.style_code}</span>
          {payload.style.style_name ? <span> — {payload.style.style_name}</span> : null}
          <span style={{ color: C.textMuted }}>
            {"  ·  Size scale: "}{scaleName || (payload.style.size_scale_id ? "—" : "none")}
            {"  ·  On-hand qty"}
            {whActive ? `  ·  Warehouse: ${warehouse}` : "  ·  All warehouses"}
          </span>
        </div>
      )}

      {/* Explode-PPK indicator — shown only when the toggle is ON and a style is
          loaded. Reports how many packs were exploded and any PPK styles that
          had no matrix in the Prepack Matrix master (those are NOT exploded). */}
      {explodePpk && payload?.explode?.enabled && (
        <div style={{
          marginBottom: 12, padding: "8px 12px", borderRadius: 6, fontSize: 12,
          background: "rgba(245,158,11,0.12)", border: `1px solid ${C.warn}`, color: "#FCD34D",
        }}>
          <strong>📦 Exploded packs included.</strong>{" "}
          {payload.explode.packs_exploded > 0
            ? `${payload.explode.packs_exploded} prepack SKU${payload.explode.packs_exploded === 1 ? "" : "s"} converted to sized eaches via the Prepack Matrix master.`
            : `No prepack SKUs on-hand were exploded.`}
          {payload.explode.packs_unmatched.length > 0 && (
            <div style={{ marginTop: 6, color: "#FECACA" }}>
              ⚠ {payload.explode.packs_unmatched.length} pack SKU{payload.explode.packs_unmatched.length === 1 ? "" : "s"} have on-hand but no matrix defined — NOT exploded:{" "}
              {payload.explode.packs_unmatched.slice(0, 6).map((u, i) => (
                <span key={`${u.ppk_style_code}-${u.color}-${i}`} style={{ fontFamily: "monospace" }}>
                  {u.ppk_style_code}{u.color ? `/${u.color}` : ""} ({u.qty}){i < Math.min(6, payload!.explode!.packs_unmatched.length) - 1 ? ", " : ""}
                </span>
              ))}
              {payload.explode.packs_unmatched.length > 6 ? " …" : ""}
              {" "}— add them in <strong>Prepack Matrices</strong>.
            </div>
          )}
        </div>
      )}

      {/* Error banner */}
      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      {/* Matrix table — poMatrixTab-style "Item Matrix" look. */}
      {loading ? (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
      ) : !styleId ? (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>
          Pick a style to view its inventory matrix.
        </div>
      ) : !payload || rows.length === 0 ? (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>
          No SKUs found for this style{showRise && riseFilter.length ? " at the selected rise." : "."}
        </div>
      ) : visibleRows.length === 0 ? (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>
          Every color row has a zero total{whActive ? ` for ${warehouse}` : ""}. Switch “Rows” to <strong>Show All</strong>{whActive ? " or pick a different warehouse" : ""} to see them.
        </div>
      ) : (
        <div style={{ overflowX: "auto", background: C.headerBg, borderRadius: 8, border: `1px solid ${C.sectionBdr}` }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: C.headerBg }}>
                <th style={{ ...thBase, textAlign: "left" }}>Base Part</th>
                <th style={{ ...thBase, textAlign: "left" }}>Description</th>
                <th style={{ ...thBase, textAlign: "left" }}>Color</th>
                {showRise && <th style={{ ...thBase, textAlign: "left" }}>Rise</th>}
                {sizeOrder.map((sz) => (
                  <th key={sz} style={{ ...thBase, textAlign: "center", minWidth: 60 }}>{sz}</th>
                ))}
                <th style={{ ...thBase, textAlign: "center" }}>Total</th>
                <th style={{ ...thBase, textAlign: "right" }}>Avg Cost</th>
                <th style={{ ...thBase, textAlign: "right" }}>Total Cost</th>
                <th style={{ ...thBase, textAlign: "center" }}>Last Received</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, ri) => {
                const isLast = ri === visibleRows.length - 1;
                return (
                  <tr
                    key={row.key}
                    style={{ borderBottom: isLast ? `2px solid ${C.sectionBdr}` : `1px solid ${C.rowBdr}` }}
                  >
                    <td style={{ padding: "8px 14px", color: C.base, fontFamily: "monospace", fontWeight: 700, borderRight: `1px solid ${C.sectionBdr}` }}>
                      {payload.style.style_code}
                    </td>
                    <td style={{ padding: "8px 14px", color: C.desc, fontSize: 12 }}>
                      {payload.style.style_name || payload.style.description || "—"}
                    </td>
                    <td style={{ padding: "8px 14px", color: "#D1D5DB" }}>{row.color || "—"}</td>
                    {showRise && (
                      <td style={{ padding: "8px 14px", color: "#C4B5FD", fontFamily: "monospace" }}>{row.rise || "—"}</td>
                    )}
                    {sizeOrder.map((sz) => (
                      <td key={sz} style={{ padding: "8px 14px", textAlign: "center", color: row.sizes[sz] ? C.gridText : C.emptyCell, fontFamily: "monospace" }}>
                        {row.sizes[sz] ? fmtQty(row.sizes[sz]) : "—"}
                      </td>
                    ))}
                    <td style={{ padding: "8px 14px", textAlign: "center", color: C.amber, fontWeight: 700, fontFamily: "monospace" }}>
                      {fmtQty(row.totalQty)}
                    </td>
                    <td style={{ padding: "8px 14px", textAlign: "right", color: C.green, fontFamily: "monospace" }}>
                      {row.avgCostCents == null ? "—" : fmtCurrency(row.avgCostCents / 100)}
                    </td>
                    <td style={{ padding: "8px 14px", textAlign: "right", color: C.green, fontWeight: 600, fontFamily: "monospace" }}>
                      {row.totalCostCents > 0 ? fmtCurrency(row.totalCostCents / 100) : "—"}
                    </td>
                    <td style={{ padding: "8px 14px", textAlign: "center", color: C.base, fontFamily: "monospace" }}>
                      {row.lastReceived ? fmtDate(row.lastReceived.slice(0, 10)) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: `2px solid ${C.sectionBdr}`, background: C.headerBg }}>
                <td colSpan={colSpanLead} style={{ padding: "12px 14px", color: C.desc, fontWeight: 700, textAlign: "right" }}>Grand Total</td>
                {sizeOrder.map((sz) => (
                  <td key={sz} style={{ padding: "12px 14px", textAlign: "center", color: C.amber, fontWeight: 700, fontFamily: "monospace" }}>
                    {colTotals[sz] ? fmtQty(colTotals[sz]) : "—"}
                  </td>
                ))}
                <td style={{ padding: "12px 14px", textAlign: "center", color: C.amber, fontWeight: 800, fontFamily: "monospace" }}>
                  {fmtQty(grandQty)}
                </td>
                <td style={{ padding: "12px 14px" }} />
                <td style={{ padding: "12px 14px", textAlign: "right", color: C.green, fontWeight: 800, fontFamily: "monospace" }}>
                  {grandCostCents > 0 ? fmtCurrency(grandCostCents / 100) : "—"}
                </td>
                <td style={{ padding: "12px 14px" }} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
