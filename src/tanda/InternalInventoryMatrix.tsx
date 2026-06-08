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
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { fmtCurrency, fmtDate } from "../utils/tandaTypes";
import { drillToModule } from "./scorecardDrill";

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
  gender_code?: string | null;
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

type SizeScale = { id: string; name: string; inseams: string[] };

type Brand = { id: string; code: string | null; name: string | null };

// Which body the panel renders for the picked style.
type ViewMode = "matrix" | "so" | "po" | "invoices";

// Row shapes returned by GET /api/internal/style-orders?style_id=&view=…
// (the *_id fields arrive already resolved to names server-side).
type StyleSoRow = {
  id: string; so_number: string | null;
  customer_id: string | null; customer_name: string | null;
  requested_ship_date: string | null; cancel_date: string | null;
  status: string | null; total_cents: number | null; qty_for_style: number;
};
type StylePoRow = {
  id: string; po_number: string | null;
  vendor_id: string | null; vendor_name: string | null;
  expected_date: string | null; status: string | null;
  total_cents: number | null; qty_for_style: number;
};
type StyleInvoiceRow = {
  id: string; invoice_number: string | null;
  customer_id: string | null; customer_name: string | null;
  invoice_date: string | null; gl_status: string | null;
  total_amount_cents: number | null; qty_for_style: number;
};


const ALL_WAREHOUSES = "__all__";

// ── MatrixRow type (shared by single-style and brand-level views) ─────────────

type MatrixRow = {
  key: string;
  color: string;
  rise: string | null;
  inseam: string | null; // set only in by-inseam mode; null otherwise
  sizes: Record<string, number>;
  totalQty: number;
  avgCostCents: number | null; // qty-weighted blended avg, cents
  totalCostCents: number;
  costedQty: number; // qty of SKUs that actually carry a cost (blend denominator)
  lastReceived: string | null;
};

// Grouping key for one matrix row. In by-inseam mode each (color, inseam) is its
// own row; otherwise one row per color (× rise when the style spans >1 rise).
// One helper so the main accumulation + the simple-mean fallback never drift.
function matrixRowKey(color: string, rise: string | null, inseam: string | null, showRise: boolean, byInseam: boolean): string {
  if (byInseam) return `${color}|${inseam ?? ""}`;
  return showRise ? `${color}|${rise ?? ""}` : color;
}

// Pure helper — builds MatrixRow[] from a payload given a qty accessor.
// Extracted so both the single-style useMemo and the brand-level renderer can
// call the same logic without duplication. `byInseam` splits each color into
// one row per inseam (for bottoms whose scale carries inseams).
function buildMatrixRows(
  payload: MatrixPayload,
  riseFilter: string[],
  showRise: boolean,
  skuQtyFn: (s: MatrixSku) => number,
  cellQtyFn: (c: ExplodeCell) => number,
  byInseam = false,
): MatrixRow[] {
  const active = riseFilter.length ? new Set(riseFilter) : null;
  const map = new Map<string, MatrixRow>();
  for (const s of payload.skus) {
    const rise = s.rise ?? null;
    if (active && !(rise != null && active.has(rise))) continue;
    const color = s.color ?? "—";
    const inseam = s.inseam ?? null;
    const key = matrixRowKey(color, rise, inseam, showRise, byInseam);
    let row = map.get(key);
    if (!row) {
      row = { key, color, rise: byInseam ? null : rise, inseam: byInseam ? inseam : null, sizes: {}, totalQty: 0, avgCostCents: null, totalCostCents: 0, costedQty: 0, lastReceived: null };
      map.set(key, row);
    }
    const qty = skuQtyFn(s);
    if (s.size) row.sizes[s.size] = (row.sizes[s.size] || 0) + qty;
    row.totalQty += qty;
    // Only SKUs with a real (non-zero) cost contribute to the weighted blend.
    if (s.avg_cost_cents != null && s.avg_cost_cents > 0) {
      row.totalCostCents += Math.round(qty * s.avg_cost_cents);
      row.costedQty += qty;
    }
    if (s.last_received && (!row.lastReceived || s.last_received > row.lastReceived)) {
      row.lastReceived = s.last_received;
    }
  }
  // Fold exploded PPK eaches (additive, qty/sizes only — no per-each cost).
  // Prepack eaches carry no inseam, so in by-inseam mode they land in the
  // color's empty-inseam row.
  if (payload.explode?.enabled) {
    for (const c of payload.explode.cells) {
      const qty = cellQtyFn(c);
      if (!qty) continue;
      const color = c.color || "—";
      const key = matrixRowKey(color, null, null, showRise, byInseam);
      let row = map.get(key);
      if (!row) {
        row = { key, color, rise: !byInseam && showRise ? "(prepack)" : null, inseam: null, sizes: {}, totalQty: 0, avgCostCents: null, totalCostCents: 0, costedQty: 0, lastReceived: null };
        map.set(key, row);
      }
      if (c.size) row.sizes[c.size] = (row.sizes[c.size] || 0) + qty;
      row.totalQty += qty;
    }
  }
  // Blended avg cost = totalCost / costedQty (weighted over costed SKUs only).
  for (const row of map.values()) {
    if (row.costedQty > 0 && row.totalCostCents > 0) {
      row.avgCostCents = Math.round(row.totalCostCents / row.costedQty);
    }
  }
  // Simple-mean fallback for avg cost when no qty-weighted cost is available.
  const skuByRow = new Map<string, number[]>();
  for (const s of payload.skus) {
    const rise = s.rise ?? null;
    if (active && !(rise != null && active.has(rise))) continue;
    const color = s.color ?? "—";
    const key = matrixRowKey(color, rise, s.inseam ?? null, showRise, byInseam);
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
  // Recalculate totalCostCents for rows where the simple-mean fallback filled
  // avgCostCents but the primary accumulation produced 0 (no costedQty). Without
  // this the row's Total Cost cell renders "—" even though the avg is known.
  for (const row of map.values()) {
    if (row.totalCostCents === 0 && row.avgCostCents != null && row.avgCostCents > 0 && row.totalQty > 0) {
      row.totalCostCents = Math.round(row.totalQty * row.avgCostCents);
    }
  }
  // Sort by descending row Total qty (highest first); stable for ties.
  const ordered = [...map.values()];
  return ordered
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r.totalQty - a.r.totalQty) || (a.i - b.i))
    .map((x) => x.r);
}

// ── inseam view model (shared by single-style + brand-level renderers) ────────
//
// In by-inseam mode each MatrixRow is one (color, inseam) cell. buildInseamModel
// groups those rows by color, orders colors by descending total and each color's
// inseam rows by the scale's inseam order, and appends a per-color SUBTOTAL row
// (the roll-up the operator asked for). Extracted to module scope so both the
// single-style table and each brand-view block render the same shape.

type InseamSubtotal = { color: string; sizes: Record<string, number>; totalQty: number; avgCostCents: number | null; totalCostCents: number };
// `groupEnd` marks a row that ends its color group with no subtotal following
// (a single-inseam color) so the renderer can draw the thicker group divider.
type InseamItem = { kind: "row"; row: MatrixRow; groupEnd?: boolean } | { kind: "subtotal"; sub: InseamSubtotal };

function buildInseamModel(rows: MatrixRow[], inseamOrder: string[]): InseamItem[] {
  const byColor = new Map<string, MatrixRow[]>();
  for (const r of rows) {
    const arr = byColor.get(r.color) ?? [];
    arr.push(r);
    byColor.set(r.color, arr);
  }
  const inseamIdx = (i: string | null): number => {
    const k = inseamOrder.indexOf(i ?? "");
    return k < 0 ? Number.MAX_SAFE_INTEGER : k;
  };
  const colorGroups = [...byColor.entries()]
    .map(([color, rs]) => ({ color, rs, total: rs.reduce((s, r) => s + r.totalQty, 0) }))
    .sort((a, b) => b.total - a.total);
  const items: InseamItem[] = [];
  for (const { color, rs } of colorGroups) {
    const sorted = [...rs].sort((a, b) => inseamIdx(a.inseam) - inseamIdx(b.inseam));
    // A color with only one inseam row needs no subtotal — it would just
    // duplicate that single row. Mark it as the group end so the divider shows.
    if (rs.length < 2) {
      items.push({ kind: "row", row: sorted[0], groupEnd: true });
      continue;
    }
    for (const row of sorted) items.push({ kind: "row", row });
    const sizes: Record<string, number> = {};
    let totalQty = 0, totalCostCents = 0, costedQty = 0;
    for (const row of rs) {
      for (const sz of Object.keys(row.sizes)) sizes[sz] = (sizes[sz] || 0) + row.sizes[sz];
      totalQty += row.totalQty;
      totalCostCents += row.totalCostCents;
      costedQty += row.costedQty;
    }
    const avgCostCents = costedQty > 0 && totalCostCents > 0 ? Math.round(totalCostCents / costedQty) : null;
    items.push({ kind: "subtotal", sub: { color, sizes, totalQty, avgCostCents, totalCostCents } });
  }
  return items;
}

// Inseam axis order for one payload: prefer the assigned size scale's ordered
// inseams (kept to those actually present on the SKUs), append stray SKU inseams,
// else fall back to the SKU-derived inseams. Pure so both views call it.
function computeInseamOrder(payload: MatrixPayload, scales: SizeScale[]): string[] {
  const present = new Set(payload.skus.map((s) => s.inseam).filter((i): i is string => !!i));
  const scale = payload.style.size_scale_id ? scales.find((s) => s.id === payload.style.size_scale_id) : null;
  const scaleIns = (scale?.inseams ?? []).filter((i) => present.has(i));
  if (scaleIns.length) {
    const out = [...scaleIns];
    for (const i of payload.inseams) if (i && !out.includes(i)) out.push(i);
    return out;
  }
  return payload.inseams.filter(Boolean);
}

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

// Gender-code → label (mirrors CustomerScorecard / Style Master). Used by the
// ATS-style gender filter that scopes the style picker.
const GENDER_LABELS: Record<string, string> = {
  M: "Men", W: "Women", WMS: "Women", B: "Boys", C: "Children", G: "Girls", U: "Unisex",
};

// Cross-app link button → ATS app at /ats (same `<a href>` nav the suite uses
// for its other app links, e.g. App.tsx T&A → /tanda, Costing → /costing).
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


const ALL_BRANDS_SENTINEL     = "__ALL_BRANDS__";
const ALL_GENDER_SENTINEL     = "__ALL_GENDER__";
const ALL_GROUP_SENTINEL      = "__ALL_GROUP__";
const ALL_CATEGORY_SENTINEL   = "__ALL_CATEGORY__";
const ALL_SUBCATEGORY_SENTINEL = "__ALL_SUBCATEGORY__";
const MULTI_PAGE_SIZE = 25;

// ── component ────────────────────────────────────────────────────────────────

export default function InternalInventoryMatrix() {
  const [styles, setStyles]     = useState<StyleListRow[]>([]);
  const [scales, setScales]     = useState<SizeScale[]>([]);
  const [brands, setBrands]     = useState<Brand[]>([]);
  const [brandId, setBrandId]   = useState<string>(""); // "" = all brands
  const [styleId, setStyleId]   = useState<string>("");
  // Dynamic style search (mirrors Style Master): the matrix loads ALL styles on
  // open and this debounced text filters the multi-style view live (e.g. "ppk"
  // → every PPK style). Replaces the old style-picker dropdown.
  const { value: styleSearch, debouncedValue: styleSearchDeb, setValue: setStyleSearch } = useDebouncedSearch("", 200);
  const [payload, setPayload]   = useState<MatrixPayload | null>(null);
  // On-Hand is the only metric. The old "Available" toggle was replaced by an
  // ATS app link (see the Show/ATS controls below).
  const [warehouse, setWarehouse] = useState<string>(ALL_WAREHOUSES); // ALL_WAREHOUSES = sum everything
  // Global warehouse names (inventory_locations kind='warehouse') — these match
  // the keys in each SKU's on_hand_by_wh map, so the dropdown works even in the
  // multi-style view where no single-style payload (with its own list) exists.
  const [allWarehouses, setAllWarehouses] = useState<string[]>([]);
  const [hideZeros, setHideZeros] = useState(true); // default: hide zero-total color rows
  const [riseFilter, setRiseFilter] = useState<string[]>([]); // [] = all
  const [explodePpk, setExplodePpk] = useState(false); // off by default; folds PPK packs → sized eaches
  const [inseamMode, setInseamMode] = useState(false); // off by default; split each color into per-inseam rows + subtotals
  const [loading, setLoading]   = useState(false);
  const [err, setErr]           = useState<string | null>(null);

  // View-mode switch (Matrix | SO | PO | Invoices). Only meaningful when a
  // single style is picked; the brand-level view always shows matrices.
  const [viewMode, setViewMode] = useState<ViewMode>("matrix");
  const [soRows, setSoRows]           = useState<StyleSoRow[]>([]);
  const [poRows, setPoRows]           = useState<StylePoRow[]>([]);
  const [invoiceRows, setInvoiceRows] = useState<StyleInvoiceRow[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listErr, setListErr]         = useState<string | null>(null);

  // Single-value filter dropdowns that scope the STYLE picker. "" = all.
  const [genderFilter, setGenderFilter]         = useState("");
  const [groupFilter, setGroupFilter]           = useState("");
  const [categoryFilter, setCategoryFilter]     = useState("");
  const [subCategoryFilter, setSubCategoryFilter] = useState("");
  // Primary product image for the picked style (same source as the PIM
  // Product Catalog) + the enlarge lightbox open flag.

  // Per-color thumbnail images for each row in the matrix (fetched from the
  // PIM style images endpoint). Key = color lowercase-trimmed || "__default__".
  const [styleImages, setStyleImages] = useState<Map<string, string>>(new Map());

  // Brand-level view: when brandId is set but styleId is empty, load matrices
  // for up to 50 of the brand's styles and render them all.
  const [brandPayloads, setBrandPayloads] = useState<Array<{style: StyleListRow; payload: MatrixPayload}>>([]);
  const [brandLoading, setBrandLoading] = useState(false);
  const [multiPage, setMultiPage] = useState(0); // 0-indexed page for multi-style view

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
        setScales(rows.map((s: { id: string; name?: string; scale_name?: string; inseams?: string[] }) => ({
          id: s.id, name: s.name || s.scale_name || "",
          inseams: Array.isArray(s.inseams) ? s.inseams : [],
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
    // Warehouse names for the Store dropdown (keys match on_hand_by_wh).
    fetch("/api/internal/warehouses")
      .then((r) => r.json())
      .then((d) => {
        const rows = Array.isArray(d) ? d : (d.rows || d.warehouses || []);
        setAllWarehouses(
          rows.map((w: { name?: string | null; code?: string | null }) => w.name || w.code || "")
            .filter((n: string) => !!n),
        );
      })
      .catch(() => {/* non-fatal; falls back to payload-derived list */});
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


  // Reset rise + warehouse + inseam-mode filters on a STYLE change only (not on
  // explode toggle). Inseam mode resets so a new style opens on its plain color
  // matrix; the toggle reappears only if the new style's scale has inseams.
  useEffect(() => {
    setRiseFilter([]);
    setWarehouse(ALL_WAREHOUSES);
    setInseamMode(false);
  }, [styleId]);

  // Fetch per-color thumbnail images for the active style from the PIM endpoint.
  // Build a Map<color_lowercase, thumbUrl> so each color row can show its image.
  useEffect(() => {
    setStyleImages(new Map());
    if (!styleId) return;
    fetch(`/api/internal/pim/styles/${encodeURIComponent(styleId)}/images`)
      .then((r) => (r.ok ? r.json() : []))
      .then((imgs: Array<{color?: string | null; signedUrls?: {thumb?: string}; storage_path_thumb?: string}>) => {
        const m = new Map<string, string>();
        for (const img of (Array.isArray(imgs) ? imgs : [])) {
          const key = (img.color || "").toLowerCase().trim() || "__default__";
          const url = img.signedUrls?.thumb || img.storage_path_thumb || "";
          if (url && !m.has(key)) m.set(key, url); // first image per color wins
        }
        setStyleImages(m);
      })
      .catch(() => {/* non-fatal — matrix still renders without per-row images */});
  }, [styleId]);

  // Reset to the Matrix view whenever the picked style changes, so a new style
  // always opens on its on-hand matrix (not a stale SO/PO/Invoices list).
  useEffect(() => { setViewMode("matrix"); }, [styleId]);

  // Fetch the row-driven list for the active non-matrix view. Re-runs when the
  // style or the view changes. ALL statuses are returned (no status filter).
  useEffect(() => {
    if (!styleId || viewMode === "matrix") { setListErr(null); return; }
    let cancelled = false;
    setListLoading(true);
    setListErr(null);
    setSoRows([]); setPoRows([]); setInvoiceRows([]);
    fetch(`/api/internal/style-orders?style_id=${encodeURIComponent(styleId)}&view=${viewMode}`)
      .then(async (r) => {
        if (!r.ok) {
          const detail = await r.json().catch(() => ({}));
          throw new Error((detail as { error?: string }).error || `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((d) => {
        if (cancelled) return;
        const rows = Array.isArray(d) ? d : [];
        if (viewMode === "so") setSoRows(rows as StyleSoRow[]);
        else if (viewMode === "po") setPoRows(rows as StylePoRow[]);
        else setInvoiceRows(rows as StyleInvoiceRow[]);
      })
      .catch((e: unknown) => { if (!cancelled) setListErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setListLoading(false); });
    return () => { cancelled = true; };
  }, [styleId, viewMode]);

  // Styles narrowed to the selected brand (brand filter scopes the STYLE picker).
  // brand_id comes straight off the style-master list payload, so the narrowing
  // is purely client-side — no extra fetch. Declared BEFORE the brand-level-view
  // effect below because that effect reads `brandStyles` in its dependency array,
  // which is evaluated during render — referencing it earlier is a TDZ crash.
  const brandStyles = useMemo<StyleListRow[]>(
    () => {
      const q = styleSearchDeb.trim().toLowerCase();
      return styles.filter((s) => {
        if (brandId && s.brand_id !== brandId) return false;
        if (genderFilter && s.gender_code !== genderFilter) return false;
        if (groupFilter && s.group_name !== groupFilter) return false;
        if (categoryFilter && s.category_name !== categoryFilter) return false;
        if (subCategoryFilter && s.sub_category_name !== subCategoryFilter) return false;
        if (q) {
          const hay = [
            s.style_code, s.style_name, s.description,
            s.group_name, s.category_name, s.sub_category_name,
          ].filter(Boolean).join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    },
    [styles, brandId, genderFilter, groupFilter, categoryFilter, subCategoryFilter, styleSearchDeb],
  );

  // Distinct filter option values derived from the loaded style list (scoped to
  // the picked brand so the dropdowns only offer values that exist there).
  const brandScopedStyles = useMemo<StyleListRow[]>(
    () => (brandId ? styles.filter((s) => s.brand_id === brandId) : styles),
    [styles, brandId],
  );
  const genderOptions = useMemo<string[]>(
    () => [...new Set(brandScopedStyles.map((s) => s.gender_code).filter((g): g is string => !!g))]
      .sort((a, b) => (GENDER_LABELS[a] || a).localeCompare(GENDER_LABELS[b] || b)),
    [brandScopedStyles],
  );
  const groupOptions = useMemo<string[]>(
    () => [...new Set(brandScopedStyles.map((s) => s.group_name).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b)),
    [brandScopedStyles],
  );
  const categoryOptions = useMemo<string[]>(
    () => [...new Set(brandScopedStyles.map((s) => s.category_name).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b)),
    [brandScopedStyles],
  );
  const subCategoryOptions = useMemo<string[]>(
    () => {
      const base = categoryFilter ? brandScopedStyles.filter((s) => s.category_name === categoryFilter) : brandScopedStyles;
      return [...new Set(base.map((s) => s.sub_category_name).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b));
    },
    [brandScopedStyles, categoryFilter],
  );

  // Reset sub-category when category changes.
  useEffect(() => { setSubCategoryFilter(""); }, [categoryFilter]);

  // Reset to page 0 whenever the style list scope changes (brand/filter change).
  useEffect(() => { setMultiPage(0); }, [brandStyles]);

  // Multi-style view: fetch one page of matrices (MULTI_PAGE_SIZE styles) on demand.
  // Cancelled via AbortController when page/scope changes before the fetch completes.
  useEffect(() => {
    if (styleId) { setBrandPayloads([]); return; }
    const start = multiPage * MULTI_PAGE_SIZE;
    const stylesToLoad = brandStyles.slice(start, start + MULTI_PAGE_SIZE);
    if (stylesToLoad.length === 0) { setBrandPayloads([]); return; }
    setBrandLoading(true);
    setBrandPayloads([]);
    const controller = new AbortController();
    Promise.all(
      stylesToLoad.map(async (s) => {
        try {
          const r = await fetch(`/api/internal/style-matrix?style_id=${encodeURIComponent(s.id)}`, { signal: controller.signal });
          if (!r.ok) return null;
          const p = await r.json() as MatrixPayload;
          return { style: s, payload: p };
        } catch { return null; }
      })
    ).then((results) => {
      const valid = results.filter(
        (x): x is {style: StyleListRow; payload: MatrixPayload} =>
          x !== null && (x.payload.skus?.length ?? 0) > 0
      );
      setBrandPayloads(valid);
      setBrandLoading(false);
    });
    return () => controller.abort();
  }, [styleId, brandStyles, multiPage]);

  // Brand picker options (blank = all brands). Shows name only.
  const brandOptions = useMemo<SearchableSelectOption[]>(
    () => [
      { value: ALL_BRANDS_SENTINEL, label: "(All Brands)", searchHaystack: "all brands" },
      ...brands.map((b) => ({
        value: b.id,
        label: b.name || b.code || "—",
        searchHaystack: [b.name, b.code].filter(Boolean).join(" "),
      })),
    ],
    [brands],
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

  // Dropdown options for filter pickers (all include an "All" sentinel first).
  const genderDropdownOptions = useMemo<SearchableSelectOption[]>(
    () => [
      { value: ALL_GENDER_SENTINEL, label: "All Genders", searchHaystack: "all genders" },
      ...genderOptions.map((g) => ({ value: g, label: GENDER_LABELS[g] || g, searchHaystack: `${g} ${GENDER_LABELS[g] || ""}` })),
    ],
    [genderOptions],
  );
  const groupDropdownOptions = useMemo<SearchableSelectOption[]>(
    () => [
      { value: ALL_GROUP_SENTINEL, label: "All Groups", searchHaystack: "all groups" },
      ...groupOptions.map((g) => ({ value: g, label: g, searchHaystack: g })),
    ],
    [groupOptions],
  );
  const categoryDropdownOptions = useMemo<SearchableSelectOption[]>(
    () => [
      { value: ALL_CATEGORY_SENTINEL, label: "All Categories", searchHaystack: "all categories" },
      ...categoryOptions.map((c) => ({ value: c, label: c, searchHaystack: c })),
    ],
    [categoryOptions],
  );
  const subCategoryDropdownOptions = useMemo<SearchableSelectOption[]>(
    () => [
      { value: ALL_SUBCATEGORY_SENTINEL, label: "All Sub-Categories", searchHaystack: "all sub-categories" },
      ...subCategoryOptions.map((s) => ({ value: s, label: s, searchHaystack: s })),
    ],
    [subCategoryOptions],
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

  // Inseam axis order: prefer the assigned size scale's ordered inseams (the
  // Phase-1 master field), keeping only the inseams that actually appear on the
  // style's SKUs; append any stray SKU inseams not in the scale at the end. Falls
  // back to the payload's SKU-derived inseams when the scale carries none.
  const inseamOrder = useMemo<string[]>(
    () => (payload ? computeInseamOrder(payload, scales) : []),
    [payload, scales],
  );

  // The style supports the inseam view only when there's at least one inseam to
  // split on (>1 makes the split meaningful, but we allow 1 so the operator can
  // confirm a single-inseam bottom too).
  const styleHasInseams = inseamOrder.length > 0;
  const byInseam = inseamMode && styleHasInseams;

  // Brand (multi-style) view: does any loaded style have inseams? Drives the
  // global By Inseam toggle's visibility when no single style is picked.
  const anyBrandInseams = useMemo<boolean>(
    () => !styleId && brandPayloads.some((bp) => computeInseamOrder(bp.payload, scales).length > 0),
    [styleId, brandPayloads, scales],
  );

  // Warehouses available for the filter — prefer the global master list (always
  // present, works in multi-style view), then the payload's list, then derive
  // from the SKUs' on_hand_by_wh maps for older payload shapes.
  const warehouseList = useMemo<string[]>(() => {
    if (allWarehouses.length) return [...allWarehouses].sort((a, b) => a.localeCompare(b));
    if (payload?.warehouses && payload.warehouses.length) return payload.warehouses;
    if (!payload) return [];
    const seen = new Set<string>();
    for (const s of payload.skus) for (const w of Object.keys(s.on_hand_by_wh || {})) seen.add(w);
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [allWarehouses, payload]);

  // Store dropdown options — "All Stores" + every warehouse name.
  const warehouseDropdownOptions = useMemo<SearchableSelectOption[]>(
    () => [
      { value: ALL_WAREHOUSES, label: "All Stores", searchHaystack: "all stores warehouses" },
      ...warehouseList.map((w) => ({ value: w, label: w, searchHaystack: w })),
    ],
    [warehouseList],
  );

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
  // spans >1 rise). Delegates to the pure buildMatrixRows helper above,
  // capturing the warehouse-aware qty accessors from this closure.
  const rows = useMemo<MatrixRow[]>(() => {
    if (!payload) return [];
    return buildMatrixRows(payload, riseFilter, showRise, skuQty, cellQty, byInseam);
  }, [payload, riseFilter, showRise, warehouse, byInseam]); // warehouse drives skuQty/cellQty

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

  // By-inseam render model for the single-style table (null when off). Shared
  // logic lives in module-level buildInseamModel (also used per brand block).
  const inseamModel = useMemo<InseamItem[] | null>(
    () => (byInseam ? buildInseamModel(visibleRows, inseamOrder) : null),
    [byInseam, visibleRows, inseamOrder],
  );

  // Flat rows for export (one per matrix row). In inseam mode the export mirrors
  // the on-screen grid: an Inseam column, per-(color,inseam) rows, and a
  // "{color} — subtotal" row after each color group.
  const exportRows = useMemo<Array<Record<string, unknown>>>(() => {
    if (!payload) return [];
    const mkBase = (color: string, inseam: string, sizes: Record<string, number>, totalQty: number, avg: number | null, totalCost: number, lastRcvd: string): Record<string, unknown> => {
      const out: Record<string, unknown> = { style_code: payload.style.style_code, color };
      if (byInseam) out.inseam = inseam;
      if (showRise && !byInseam) out.rise = inseam; // 'inseam' arg reused as rise label in non-inseam path
      for (const sz of sizeOrder) out[`size_${sz}`] = sizes[sz] || 0;
      out.total_qty = totalQty;
      out.avg_cost_cents = avg == null ? "" : avg;
      out.total_cost_cents = totalCost;
      out.last_received = lastRcvd;
      return out;
    };
    if (byInseam && inseamModel) {
      return inseamModel.map((it) =>
        it.kind === "row"
          ? mkBase(it.row.color, it.row.inseam ?? "", it.row.sizes, it.row.totalQty, it.row.avgCostCents, it.row.totalCostCents, it.row.lastReceived ?? "")
          : mkBase(`${it.sub.color} — subtotal`, "", it.sub.sizes, it.sub.totalQty, it.sub.avgCostCents, it.sub.totalCostCents, ""),
      );
    }
    return visibleRows.map((r) => mkBase(r.color, r.rise ?? "", r.sizes, r.totalQty, r.avgCostCents, r.totalCostCents, r.lastReceived ?? ""));
  }, [payload, visibleRows, sizeOrder, showRise, byInseam, inseamModel]);

  const exportColumns = useMemo<ExportColumn<Record<string, unknown>>[]>(() => {
    const cols: ExportColumn<Record<string, unknown>>[] = [
      { key: "style_code", header: "Style" },
      { key: "color", header: "Color" },
    ];
    if (byInseam) cols.push({ key: "inseam", header: "Inseam" });
    else if (showRise) cols.push({ key: "rise", header: "Rise" });
    for (const sz of sizeOrder) cols.push({ key: `size_${sz}`, header: sz, format: "number" });
    cols.push({ key: "total_qty", header: "Total", format: "number" });
    cols.push({ key: "avg_cost_cents", header: "Avg Cost", format: "currency_cents" });
    cols.push({ key: "total_cost_cents", header: "Total Cost", format: "currency_cents" });
    cols.push({ key: "last_received", header: "Last Received", format: "date" });
    return cols;
  }, [sizeOrder, showRise, byInseam]);

  // The footer's "Grand Total" label cell spans the non-image leading data
  // columns: Base Part + Description + Color (= 3), plus the Rise/Inseam secondary
  // column when shown (= 4). The Image column is a separate empty <td /> that
  // precedes this cell in the footer row (added PR #1022).
  const showSecondary = byInseam || showRise;
  const colSpanLead = showSecondary ? 4 : 3;

  // Whether the panel is showing a row-driven list (vs the matrix) for the
  // picked style. The brand-level view never uses list mode.
  const isListView = !!styleId && viewMode !== "matrix";

  // Drill-through: navigate to the real module focused on the clicked record,
  // reusing the canonical scorecard-drill URL contract. SO panel reads `so`,
  // PO/AR panels read `q` (seeded into their search box on mount).
  const openSo = (r: StyleSoRow) => drillToModule("sales_orders", { so: r.so_number || "" });
  const openPo = (r: StylePoRow) => drillToModule("purchase_orders", { q: r.po_number || "" });
  const openInvoice = (r: StyleInvoiceRow) => drillToModule("ar_invoices", { q: r.invoice_number || "" });

  // Export configs for the three list views.
  const soExportRows = useMemo<Array<Record<string, unknown>>>(
    () => soRows.map((r) => ({
      so_number: r.so_number || "(draft)", customer: r.customer_name || "—",
      qty_for_style: r.qty_for_style, total_cents: r.total_cents ?? "",
      ship_date: r.requested_ship_date || "", cancel_date: r.cancel_date || "", status: r.status || "",
    })),
    [soRows],
  );
  const soExportColumns = useMemo<ExportColumn<Record<string, unknown>>[]>(() => [
    { key: "so_number", header: "SO #" },
    { key: "customer", header: "Customer" },
    { key: "qty_for_style", header: "Qty (style)", format: "number" },
    { key: "total_cents", header: "Order Total", format: "currency_cents" },
    { key: "ship_date", header: "Ship Date", format: "date" },
    { key: "cancel_date", header: "Cancel Date", format: "date" },
    { key: "status", header: "Status" },
  ], []);
  const poExportRows = useMemo<Array<Record<string, unknown>>>(
    () => poRows.map((r) => ({
      po_number: r.po_number || "(draft)", vendor: r.vendor_name || "—",
      qty_for_style: r.qty_for_style, total_cents: r.total_cents ?? "",
      ddp_date: r.expected_date || "", status: r.status || "",
    })),
    [poRows],
  );
  const poExportColumns = useMemo<ExportColumn<Record<string, unknown>>[]>(() => [
    { key: "po_number", header: "PO #" },
    { key: "vendor", header: "Vendor" },
    { key: "qty_for_style", header: "Qty (style)", format: "number" },
    { key: "total_cents", header: "Order Total", format: "currency_cents" },
    { key: "ddp_date", header: "DDP Date", format: "date" },
    { key: "status", header: "Status" },
  ], []);
  const invExportRows = useMemo<Array<Record<string, unknown>>>(
    () => invoiceRows.map((r) => ({
      invoice_number: r.invoice_number || "—", customer: r.customer_name || "—",
      qty_for_style: r.qty_for_style, total_cents: r.total_amount_cents ?? "",
      invoice_date: r.invoice_date || "", status: r.gl_status || "",
    })),
    [invoiceRows],
  );
  const invExportColumns = useMemo<ExportColumn<Record<string, unknown>>[]>(() => [
    { key: "invoice_number", header: "Invoice #" },
    { key: "customer", header: "Customer" },
    { key: "qty_for_style", header: "Qty (style)", format: "number" },
    { key: "total_cents", header: "Total", format: "currency_cents" },
    { key: "invoice_date", header: "Invoice Date", format: "date" },
    { key: "status", header: "Status" },
  ], []);

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
      <div style={{ marginBottom: 18, display: "flex", flexDirection: "column", gap: 10 }}>

        {/* Row 1 — filter dropdowns */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, minWidth: 180 }}>
            Brand
            <SearchableSelect
              value={brandId ? brandId : ALL_BRANDS_SENTINEL}
              onChange={(v) => {
                if (!v || v === ALL_BRANDS_SENTINEL) { setBrandId(""); setStyleId(""); }
                else setBrandId(v);
              }}
              options={brandOptions}
              placeholder="Search brand…"
              inputStyle={inputStyle}
            />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, minWidth: 280 }}>
            Search styles
            <input
              type="text"
              value={styleSearch}
              onChange={(e) => { setStyleSearch(e.target.value); if (styleId) setStyleId(""); }}
              placeholder="Type to filter — e.g. PPK, code, name…"
              style={{ ...inputStyle, minWidth: 280 }}
            />
          </label>

          {genderDropdownOptions.length > 1 && (
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, minWidth: 130 }}>
              Gender
              <SearchableSelect
                value={genderFilter || ALL_GENDER_SENTINEL}
                onChange={(v) => setGenderFilter(!v || v === ALL_GENDER_SENTINEL ? "" : v)}
                options={genderDropdownOptions}
                placeholder="Gender…"
                inputStyle={inputStyle}
              />
            </label>
          )}

          {groupDropdownOptions.length > 1 && (
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, minWidth: 130 }}>
              Group
              <SearchableSelect
                value={groupFilter || ALL_GROUP_SENTINEL}
                onChange={(v) => setGroupFilter(!v || v === ALL_GROUP_SENTINEL ? "" : v)}
                options={groupDropdownOptions}
                placeholder="Group…"
                inputStyle={inputStyle}
              />
            </label>
          )}

          {categoryDropdownOptions.length > 1 && (
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, minWidth: 140 }}>
              Category
              <SearchableSelect
                value={categoryFilter || ALL_CATEGORY_SENTINEL}
                onChange={(v) => setCategoryFilter(!v || v === ALL_CATEGORY_SENTINEL ? "" : v)}
                options={categoryDropdownOptions}
                placeholder="Category…"
                inputStyle={inputStyle}
              />
            </label>
          )}

          {subCategoryDropdownOptions.length > 1 && (
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, minWidth: 150 }}>
              Sub-Category
              <SearchableSelect
                value={subCategoryFilter || ALL_SUBCATEGORY_SENTINEL}
                onChange={(v) => setSubCategoryFilter(!v || v === ALL_SUBCATEGORY_SENTINEL ? "" : v)}
                options={subCategoryDropdownOptions}
                placeholder="Sub-category…"
                inputStyle={inputStyle}
              />
            </label>
          )}

          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, minWidth: 160 }}>
            Store
            <SearchableSelect
              value={warehouse}
              onChange={(v) => setWarehouse(!v ? ALL_WAREHOUSES : v)}
              options={warehouseDropdownOptions}
              placeholder="Search store…"
              inputStyle={inputStyle}
            />
          </label>
        </div>

        {/* Row 2 — display controls */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {/* Hide Zeros toggle — blue = active (zeros hidden) */}
          <button
            type="button"
            title="Toggle zero-qty rows"
            style={{
              background: hideZeros ? C.primary : C.card,
              color: hideZeros ? "#fff" : C.textMuted,
              border: `1px solid ${hideZeros ? C.primary : C.cardBdr}`,
              padding: "6px 14px", borderRadius: 6, cursor: "pointer",
              fontSize: 12, fontWeight: 600, transition: "all 0.15s",
            }}
            onClick={() => setHideZeros((v) => !v)}
          >
            Hide Zeros
          </button>

          {/* Explode PPK toggle — blue = active */}
          <button
            type="button"
            title="Convert PPK packs on-hand into sized eaches using the Prepack Matrix master"
            style={{
              background: explodePpk ? C.primary : C.card,
              color: explodePpk ? "#fff" : C.textMuted,
              border: `1px solid ${explodePpk ? C.primary : C.cardBdr}`,
              padding: "6px 14px", borderRadius: 6, cursor: "pointer",
              fontSize: 12, fontWeight: 600, transition: "all 0.15s",
            }}
            onClick={() => setExplodePpk((v) => !v)}
          >
            Explode
          </button>

          {/* Inseam toggle — shows when the picked style's scale carries inseams
              (single-style view) OR any loaded style does (brand/all-styles view).
              ON splits each color into one row per inseam, with a per-color
              subtotal row. Blue = active. */}
          {viewMode === "matrix" && ((styleId && styleHasInseams) || anyBrandInseams) && (
            <button
              type="button"
              title="Split each color into one row per inseam, with a per-color subtotal"
              style={{
                background: inseamMode ? C.primary : C.card,
                color: inseamMode ? "#fff" : C.textMuted,
                border: `1px solid ${inseamMode ? C.primary : C.cardBdr}`,
                padding: "6px 14px", borderRadius: 6, cursor: "pointer",
                fontSize: 12, fontWeight: 600, transition: "all 0.15s",
              }}
              onClick={() => setInseamMode((v) => !v)}
            >
              By Inseam
            </button>
          )}

          {payload && viewMode === "matrix" && (
            <>
              <div style={{ width: 1, height: 22, background: C.cardBdr, flexShrink: 0 }} />
              <ExportButton
                rows={exportRows}
                filename={`inventory-matrix-${payload.style.style_code}`}
                sheetName="Inventory Matrix"
                columns={exportColumns}
              />
            </>
          )}
        </div>
      </div>

      {/* View-mode switch — Matrix | SO | PO | Invoices. Only when a single
          style is picked (the brand-level view is matrix-only). Buttons, not
          links: they swap the panel body in place. */}
      {styleId && (
        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
          <button
            type="button"
            onClick={() => { setStyleId(""); setViewMode("matrix"); }}
            style={{ ...btnToggle(false), marginRight: 4 }}
            title="Back to the searchable all-styles view"
          >
            ← All styles
          </button>
          {([
            ["matrix", "🧮 Matrix"],
            ["so", "🛒 SO"],
            ["po", "📦 PO"],
            ["invoices", "🧾 Invoices"],
          ] as Array<[ViewMode, string]>).map(([mode, label]) => (
            <button key={mode} type="button" style={btnToggle(viewMode === mode)} onClick={() => setViewMode(mode)}>
              {label}
            </button>
          ))}
        </div>
      )}

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

      {/* Multi-style view — no specific style selected: render one page of styles
          (MULTI_PAGE_SIZE each) in the current scope (selected brand or all brands),
          stacked with a style header bar each. Paginated via prev/next controls. */}
      {!styleId && (
        brandLoading ? (
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>
            Loading inventory…
          </div>
        ) : brandPayloads.length === 0 ? (
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>
            No styles with inventory{brandId ? " for this brand" : ""}.
          </div>
        ) : (() => {
          const totalStyles = brandStyles.length;
          const totalPages = Math.ceil(totalStyles / MULTI_PAGE_SIZE);
          const pageStart = multiPage * MULTI_PAGE_SIZE + 1;
          const pageEnd = Math.min((multiPage + 1) * MULTI_PAGE_SIZE, totalStyles);
          const pagBtnBase: React.CSSProperties = {
            background: "none", border: `1px solid ${C.cardBdr}`, borderRadius: 4,
            padding: "4px 14px", fontSize: 13, cursor: "pointer", color: C.text,
          };
          const PagBar = () => (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "10px 16px", fontSize: 13 }}>
              <span style={{ color: C.textMuted }}>Styles {pageStart}–{pageEnd} of {totalStyles}</span>
              {totalPages > 1 && (
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <button onClick={() => setMultiPage(p => Math.max(0, p - 1))} disabled={multiPage === 0}
                    style={{ ...pagBtnBase, opacity: multiPage === 0 ? 0.4 : 1, cursor: multiPage === 0 ? "default" : "pointer" }}>◀ Prev</button>
                  <span style={{ color: C.textMuted, fontSize: 12 }}>Page {multiPage + 1} of {totalPages}</span>
                  <button onClick={() => setMultiPage(p => Math.min(totalPages - 1, p + 1))} disabled={multiPage >= totalPages - 1}
                    style={{ ...pagBtnBase, opacity: multiPage >= totalPages - 1 ? 0.4 : 1, cursor: multiPage >= totalPages - 1 ? "default" : "pointer" }}>Next ▶</button>
                </div>
              )}
            </div>
          );
          return (
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <PagBar />
            {brandPayloads.map(({ style: bStyle, payload: bPayload }) => {
              const bRises = bPayload.rises ?? [];
              const bShowRise = bRises.length > 1;
              const bSizeOrder = bPayload.sizes.length ? bPayload.sizes :
                (() => { const s: string[] = []; for (const sk of bPayload.skus) if (sk.size && !s.includes(sk.size)) s.push(sk.size); return s; })();
              const bSkuQty = (s: MatrixSku) => {
                if (warehouse !== ALL_WAREHOUSES) return num((s.on_hand_by_wh || {})[warehouse]);
                return num(s.on_hand_qty);
              };
              const bCellQty = (c: ExplodeCell) => {
                if (warehouse !== ALL_WAREHOUSES) return num((c.by_wh || {})[warehouse]);
                return num(c.qty);
              };
              // Per-block inseam state: split this style by inseam when the
              // global By Inseam toggle is on AND this style's scale has inseams.
              const bInseamOrder = computeInseamOrder(bPayload, scales);
              const bByInseam = inseamMode && bInseamOrder.length > 0;
              const bShowSecondary = bByInseam || bShowRise;
              const bRows = buildMatrixRows(bPayload, [], bShowRise, bSkuQty, bCellQty, bByInseam)
                .filter((r) => !hideZeros || r.totalQty !== 0);
              if (bRows.length === 0) return null;
              const bInseamModel = bByInseam ? buildInseamModel(bRows, bInseamOrder) : null;
              const bColSpan = bShowSecondary ? 3 : 2; // Image + Color [+ Rise/Inseam]
              const bColTotals: Record<string, number> = {};
              for (const sz of bSizeOrder) bColTotals[sz] = bRows.reduce((s, r) => s + (r.sizes[sz] || 0), 0);
              const bGrandQty = bRows.reduce((s, r) => s + r.totalQty, 0);
              const bGrandCost = bRows.reduce((s, r) => s + r.totalCostCents, 0);
              return (
                <div key={bStyle.id}>
                  <div
                    onClick={() => setStyleId(bStyle.id)}
                    title="Open this style (SO / PO / Invoice tabs)"
                    style={{ padding: "6px 12px", background: C.card, borderRadius: "8px 8px 0 0", border: `1px solid ${C.sectionBdr}`, borderBottom: "none", fontSize: 13, fontWeight: 700, color: C.base, fontFamily: "monospace", cursor: "pointer" }}
                  >
                    {bStyle.style_code}{bStyle.style_name ? ` — ${bStyle.style_name}` : ""}
                  </div>
                  <div style={{ overflowX: "auto", background: C.headerBg, borderRadius: "0 0 8px 8px", border: `1px solid ${C.sectionBdr}` }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: C.headerBg }}>
                          <th style={{ ...thBase, textAlign: "center", width: 52 }}>Img</th>
                          <th style={{ ...thBase, textAlign: "left" }}>Color</th>
                          {bShowSecondary && <th style={{ ...thBase, textAlign: "left" }}>{bByInseam ? "Inseam" : "Rise"}</th>}
                          {bSizeOrder.map((sz) => (
                            <th key={sz} style={{ ...thBase, textAlign: "center", minWidth: 52 }}>{sz}</th>
                          ))}
                          <th style={{ ...thBase, textAlign: "center" }}>Total</th>
                          <th style={{ ...thBase, textAlign: "right" }}>Avg Cost</th>
                          <th style={{ ...thBase, textAlign: "right" }}>Total Cost</th>
                          <th style={{ ...thBase, textAlign: "center" }}>Last Rcvd</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bByInseam && bInseamModel ? (
                          bInseamModel.map((it) => {
                            if (it.kind === "subtotal") {
                              const sub = it.sub;
                              return (
                                <tr key={`sub|${sub.color}`} style={{ background: "#16233b", borderBottom: `2px solid ${C.sectionBdr}` }}>
                                  <td style={{ padding: "4px 8px" }} />
                                  <td style={{ padding: "6px 12px", color: "#D1D5DB", fontWeight: 700 }}>{sub.color || "—"}</td>
                                  <td style={{ padding: "6px 12px", color: C.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, fontSize: 10 }}>Subtotal</td>
                                  {bSizeOrder.map((sz) => (
                                    <td key={sz} style={{ padding: "6px 12px", textAlign: "center", color: sub.sizes[sz] ? C.gridText : C.emptyCell, fontFamily: "monospace", fontWeight: 700 }}>
                                      {sub.sizes[sz] ? fmtQty(sub.sizes[sz]) : "—"}
                                    </td>
                                  ))}
                                  <td style={{ padding: "6px 12px", textAlign: "center", color: C.amber, fontWeight: 800, fontFamily: "monospace" }}>{fmtQty(sub.totalQty)}</td>
                                  <td style={{ padding: "6px 12px", textAlign: "right", color: C.green, fontFamily: "monospace" }}>{sub.avgCostCents == null ? "—" : fmtCurrency(sub.avgCostCents / 100)}</td>
                                  <td style={{ padding: "6px 12px", textAlign: "right", color: C.green, fontWeight: 700, fontFamily: "monospace" }}>{sub.totalCostCents > 0 ? fmtCurrency(sub.totalCostCents / 100) : "—"}</td>
                                  <td style={{ padding: "6px 12px" }} />
                                </tr>
                              );
                            }
                            const row = it.row;
                            return (
                              <tr key={row.key} style={{ borderBottom: it.groupEnd ? `2px solid ${C.sectionBdr}` : `1px solid ${C.rowBdr}` }}>
                                <td style={{ padding: "4px 8px", width: 52, textAlign: "center" }}>
                                  <span style={{ display: "block", width: 44, height: 44, background: "#1E293B", borderRadius: 4, margin: "0 auto" }} />
                                </td>
                                <td style={{ padding: "6px 12px", color: "#D1D5DB" }}>{row.color || "—"}</td>
                                <td style={{ padding: "6px 12px", color: "#C4B5FD", fontFamily: "monospace" }}>{row.inseam ? `${row.inseam}"` : "—"}</td>
                                {bSizeOrder.map((sz) => (
                                  <td key={sz} style={{ padding: "6px 12px", textAlign: "center", color: row.sizes[sz] ? C.gridText : C.emptyCell, fontFamily: "monospace" }}>
                                    {row.sizes[sz] ? fmtQty(row.sizes[sz]) : "—"}
                                  </td>
                                ))}
                                <td style={{ padding: "6px 12px", textAlign: "center", color: C.amber, fontWeight: 700, fontFamily: "monospace" }}>{fmtQty(row.totalQty)}</td>
                                <td style={{ padding: "6px 12px", textAlign: "right", color: C.green, fontFamily: "monospace" }}>{row.avgCostCents == null ? "—" : fmtCurrency(row.avgCostCents / 100)}</td>
                                <td style={{ padding: "6px 12px", textAlign: "right", color: C.green, fontWeight: 600, fontFamily: "monospace" }}>{row.totalCostCents > 0 ? fmtCurrency(row.totalCostCents / 100) : "—"}</td>
                                <td style={{ padding: "6px 12px", textAlign: "center", color: C.base, fontFamily: "monospace" }}>{row.lastReceived ? fmtDate(row.lastReceived.slice(0, 10)) : "—"}</td>
                              </tr>
                            );
                          })
                        ) : (
                        bRows.map((row, ri) => {
                          const isLast = ri === bRows.length - 1;
                          // Use brand-level styleImages map doesn't apply here (we'd need per-style
                          // maps). Render an empty placeholder so layout is consistent.
                          return (
                            <tr key={row.key} style={{ borderBottom: isLast ? `2px solid ${C.sectionBdr}` : `1px solid ${C.rowBdr}` }}>
                              <td style={{ padding: "4px 8px", width: 52, textAlign: "center" }}>
                                <span style={{ display: "block", width: 44, height: 44, background: "#1E293B", borderRadius: 4, margin: "0 auto" }} />
                              </td>
                              <td style={{ padding: "6px 12px", color: "#D1D5DB" }}>{row.color || "—"}</td>
                              {bShowRise && <td style={{ padding: "6px 12px", color: "#C4B5FD", fontFamily: "monospace" }}>{row.rise || "—"}</td>}
                              {bSizeOrder.map((sz) => (
                                <td key={sz} style={{ padding: "6px 12px", textAlign: "center", color: row.sizes[sz] ? C.gridText : C.emptyCell, fontFamily: "monospace" }}>
                                  {row.sizes[sz] ? fmtQty(row.sizes[sz]) : "—"}
                                </td>
                              ))}
                              <td style={{ padding: "6px 12px", textAlign: "center", color: C.amber, fontWeight: 700, fontFamily: "monospace" }}>{fmtQty(row.totalQty)}</td>
                              <td style={{ padding: "6px 12px", textAlign: "right", color: C.green, fontFamily: "monospace" }}>{row.avgCostCents == null ? "—" : fmtCurrency(row.avgCostCents / 100)}</td>
                              <td style={{ padding: "6px 12px", textAlign: "right", color: C.green, fontWeight: 600, fontFamily: "monospace" }}>{row.totalCostCents > 0 ? fmtCurrency(row.totalCostCents / 100) : "—"}</td>
                              <td style={{ padding: "6px 12px", textAlign: "center", color: C.base, fontFamily: "monospace" }}>{row.lastReceived ? fmtDate(row.lastReceived.slice(0, 10)) : "—"}</td>
                            </tr>
                          );
                        })
                        )}
                      </tbody>
                      <tfoot>
                        <tr style={{ borderTop: `2px solid ${C.sectionBdr}`, background: C.headerBg }}>
                          <td colSpan={bColSpan} style={{ padding: "10px 12px", color: C.desc, fontWeight: 700, textAlign: "right" }}>Grand Total</td>
                          {bSizeOrder.map((sz) => (
                            <td key={sz} style={{ padding: "10px 12px", textAlign: "center", color: C.amber, fontWeight: 700, fontFamily: "monospace" }}>
                              {bColTotals[sz] ? fmtQty(bColTotals[sz]) : "—"}
                            </td>
                          ))}
                          <td style={{ padding: "10px 12px", textAlign: "center", color: C.amber, fontWeight: 800, fontFamily: "monospace" }}>{fmtQty(bGrandQty)}</td>
                          <td style={{ padding: "10px 12px" }} />
                          <td style={{ padding: "10px 12px", textAlign: "right", color: C.green, fontWeight: 800, fontFamily: "monospace" }}>{bGrandCost > 0 ? fmtCurrency(bGrandCost / 100) : "—"}</td>
                          <td style={{ padding: "10px 12px" }} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              );
            })}
            <PagBar />
          </div>
          );
        })()
      )}

      {/* ── Row-driven list views (SO / PO / Invoices) ───────────────────────
          Replace the matrix body when a non-matrix view is active for the
          picked style. Each row is fully clickable and drills to the real
          module. *_id values arrive pre-resolved to names from the handler. */}
      {isListView && (
        <>
          {/* Export for the active list. */}
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
            {viewMode === "so" && soRows.length > 0 && (
              <ExportButton rows={soExportRows} filename={`so-for-${payload?.style.style_code || "style"}`} sheetName="Sales Orders" columns={soExportColumns} />
            )}
            {viewMode === "po" && poRows.length > 0 && (
              <ExportButton rows={poExportRows} filename={`po-for-${payload?.style.style_code || "style"}`} sheetName="Purchase Orders" columns={poExportColumns} />
            )}
            {viewMode === "invoices" && invoiceRows.length > 0 && (
              <ExportButton rows={invExportRows} filename={`invoices-for-${payload?.style.style_code || "style"}`} sheetName="Invoices" columns={invExportColumns} />
            )}
          </div>

          {listErr && (
            <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
              Error: {listErr}
            </div>
          )}

          {listLoading ? (
            <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
          ) : viewMode === "so" ? (
            soRows.length === 0 ? (
              <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>
                No sales orders contain this style.
              </div>
            ) : (
              <div style={{ overflowX: "auto", background: C.headerBg, borderRadius: 8, border: `1px solid ${C.sectionBdr}` }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: C.headerBg }}>
                      <th style={{ ...thBase, textAlign: "left" }}>SO #</th>
                      <th style={{ ...thBase, textAlign: "left" }}>Customer</th>
                      <th style={{ ...thBase, textAlign: "center" }}>Qty (style)</th>
                      <th style={{ ...thBase, textAlign: "right" }}>Order Total</th>
                      <th style={{ ...thBase, textAlign: "center" }}>Ship Date</th>
                      <th style={{ ...thBase, textAlign: "center" }}>Cancel Date</th>
                      <th style={{ ...thBase, textAlign: "left" }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {soRows.map((r, ri) => (
                      <tr key={r.id} onClick={() => openSo(r)} title="Open this sales order"
                        style={{ cursor: "pointer", borderBottom: ri === soRows.length - 1 ? `2px solid ${C.sectionBdr}` : `1px solid ${C.rowBdr}` }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "#162033")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ padding: "8px 14px", color: C.base, fontFamily: "monospace", fontWeight: 700 }}>{r.so_number || "(draft)"}</td>
                        <td style={{ padding: "8px 14px", color: "#D1D5DB" }}>{r.customer_name || "—"}</td>
                        <td style={{ padding: "8px 14px", textAlign: "center", color: C.gridText, fontFamily: "monospace" }}>{fmtQty(r.qty_for_style)}</td>
                        <td style={{ padding: "8px 14px", textAlign: "right", color: C.green, fontFamily: "monospace" }}>{r.total_cents == null ? "—" : fmtCurrency(r.total_cents / 100)}</td>
                        <td style={{ padding: "8px 14px", textAlign: "center", color: C.base, fontFamily: "monospace" }}>{r.requested_ship_date ? fmtDate(r.requested_ship_date.slice(0, 10)) : "—"}</td>
                        <td style={{ padding: "8px 14px", textAlign: "center", color: C.base, fontFamily: "monospace" }}>{r.cancel_date ? fmtDate(r.cancel_date.slice(0, 10)) : "—"}</td>
                        <td style={{ padding: "8px 14px", color: C.textSub, textTransform: "capitalize" }}>{r.status || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : viewMode === "po" ? (
            poRows.length === 0 ? (
              <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>
                No purchase orders contain this style.
              </div>
            ) : (
              <div style={{ overflowX: "auto", background: C.headerBg, borderRadius: 8, border: `1px solid ${C.sectionBdr}` }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: C.headerBg }}>
                      <th style={{ ...thBase, textAlign: "left" }}>PO #</th>
                      <th style={{ ...thBase, textAlign: "left" }}>Vendor</th>
                      <th style={{ ...thBase, textAlign: "center" }}>Qty (style)</th>
                      <th style={{ ...thBase, textAlign: "right" }}>Order Total</th>
                      <th style={{ ...thBase, textAlign: "center" }}>DDP Date</th>
                      <th style={{ ...thBase, textAlign: "left" }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {poRows.map((r, ri) => (
                      <tr key={r.id} onClick={() => openPo(r)} title="Open this purchase order"
                        style={{ cursor: "pointer", borderBottom: ri === poRows.length - 1 ? `2px solid ${C.sectionBdr}` : `1px solid ${C.rowBdr}` }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "#162033")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ padding: "8px 14px", color: C.base, fontFamily: "monospace", fontWeight: 700 }}>{r.po_number || "(draft)"}</td>
                        <td style={{ padding: "8px 14px", color: "#D1D5DB" }}>{r.vendor_name || "—"}</td>
                        <td style={{ padding: "8px 14px", textAlign: "center", color: C.gridText, fontFamily: "monospace" }}>{fmtQty(r.qty_for_style)}</td>
                        <td style={{ padding: "8px 14px", textAlign: "right", color: C.green, fontFamily: "monospace" }}>{r.total_cents == null ? "—" : fmtCurrency(r.total_cents / 100)}</td>
                        <td style={{ padding: "8px 14px", textAlign: "center", color: C.base, fontFamily: "monospace" }}>{r.expected_date ? fmtDate(r.expected_date.slice(0, 10)) : "—"}</td>
                        <td style={{ padding: "8px 14px", color: C.textSub, textTransform: "capitalize" }}>{(r.status || "—").replace(/_/g, " ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            invoiceRows.length === 0 ? (
              <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>
                No invoices contain this style.
              </div>
            ) : (
              <div style={{ overflowX: "auto", background: C.headerBg, borderRadius: 8, border: `1px solid ${C.sectionBdr}` }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: C.headerBg }}>
                      <th style={{ ...thBase, textAlign: "left" }}>Invoice #</th>
                      <th style={{ ...thBase, textAlign: "left" }}>Customer</th>
                      <th style={{ ...thBase, textAlign: "center" }}>Qty (style)</th>
                      <th style={{ ...thBase, textAlign: "right" }}>Total</th>
                      <th style={{ ...thBase, textAlign: "center" }}>Invoice Date</th>
                      <th style={{ ...thBase, textAlign: "left" }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoiceRows.map((r, ri) => (
                      <tr key={r.id} onClick={() => openInvoice(r)} title="Open this invoice"
                        style={{ cursor: "pointer", borderBottom: ri === invoiceRows.length - 1 ? `2px solid ${C.sectionBdr}` : `1px solid ${C.rowBdr}` }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "#162033")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ padding: "8px 14px", color: C.base, fontFamily: "monospace", fontWeight: 700 }}>{r.invoice_number || "—"}</td>
                        <td style={{ padding: "8px 14px", color: "#D1D5DB" }}>{r.customer_name || "—"}</td>
                        <td style={{ padding: "8px 14px", textAlign: "center", color: C.gridText, fontFamily: "monospace" }}>{fmtQty(r.qty_for_style)}</td>
                        <td style={{ padding: "8px 14px", textAlign: "right", color: C.green, fontFamily: "monospace" }}>{r.total_amount_cents == null ? "—" : fmtCurrency(r.total_amount_cents / 100)}</td>
                        <td style={{ padding: "8px 14px", textAlign: "center", color: C.base, fontFamily: "monospace" }}>{r.invoice_date ? fmtDate(r.invoice_date.slice(0, 10)) : "—"}</td>
                        <td style={{ padding: "8px 14px", color: C.textSub, textTransform: "capitalize" }}>{(r.gl_status || "—").replace(/_/g, " ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </>
      )}

      {/* Matrix table — poMatrixTab-style "Item Matrix" look. */}
      {!isListView && (loading ? (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
      ) : !styleId ? null /* multi-style view rendered above */
      : !payload || rows.length === 0 ? (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>
          No SKUs found for this style{showRise && riseFilter.length ? " at the selected rise." : "."}
        </div>
      ) : visibleRows.length === 0 ? (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>
          Every color row has a zero total{whActive ? ` for ${warehouse}` : ""}. Turn off <strong>Hide Zeros</strong>{whActive ? " or pick a different store" : ""} to see them.
        </div>
      ) : (
        <div style={{ overflowX: "auto", background: C.headerBg, borderRadius: 8, border: `1px solid ${C.sectionBdr}` }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: C.headerBg }}>
                <th style={{ ...thBase, textAlign: "center", width: 52 }}>Img</th>
                <th style={{ ...thBase, textAlign: "left" }}>Base Part</th>
                <th style={{ ...thBase, textAlign: "left" }}>Description</th>
                <th style={{ ...thBase, textAlign: "left" }}>Color</th>
                {showSecondary && <th style={{ ...thBase, textAlign: "left" }}>{byInseam ? "Inseam" : "Rise"}</th>}
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
              {byInseam && inseamModel ? (
                // By-inseam: one row per (color, inseam) followed by a per-color
                // subtotal row. The secondary column shows the inseam value.
                inseamModel.map((it) => {
                  if (it.kind === "subtotal") {
                    const sub = it.sub;
                    return (
                      <tr key={`sub|${sub.color}`} style={{ background: "#16233b", borderBottom: `2px solid ${C.sectionBdr}` }}>
                        <td style={{ padding: "6px 8px" }} />
                        <td style={{ padding: "8px 14px", borderRight: `1px solid ${C.sectionBdr}` }} />
                        <td style={{ padding: "8px 14px" }} />
                        <td style={{ padding: "8px 14px", color: "#D1D5DB", fontWeight: 700 }}>{sub.color || "—"}</td>
                        <td style={{ padding: "8px 14px", color: C.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, fontSize: 11 }}>Subtotal</td>
                        {sizeOrder.map((sz) => (
                          <td key={sz} style={{ padding: "8px 14px", textAlign: "center", color: sub.sizes[sz] ? C.gridText : C.emptyCell, fontFamily: "monospace", fontWeight: 700 }}>
                            {sub.sizes[sz] ? fmtQty(sub.sizes[sz]) : "—"}
                          </td>
                        ))}
                        <td style={{ padding: "8px 14px", textAlign: "center", color: C.amber, fontWeight: 800, fontFamily: "monospace" }}>{fmtQty(sub.totalQty)}</td>
                        <td style={{ padding: "8px 14px", textAlign: "right", color: C.green, fontFamily: "monospace" }}>{sub.avgCostCents == null ? "—" : fmtCurrency(sub.avgCostCents / 100)}</td>
                        <td style={{ padding: "8px 14px", textAlign: "right", color: C.green, fontWeight: 700, fontFamily: "monospace" }}>{sub.totalCostCents > 0 ? fmtCurrency(sub.totalCostCents / 100) : "—"}</td>
                        <td style={{ padding: "8px 14px" }} />
                      </tr>
                    );
                  }
                  const row = it.row;
                  const imgKey = row.color.toLowerCase().trim();
                  const url = styleImages.get(imgKey) || styleImages.get("__default__") || "";
                  return (
                    <tr key={row.key} style={{ borderBottom: it.groupEnd ? `2px solid ${C.sectionBdr}` : `1px solid ${C.rowBdr}` }}>
                      <td style={{ padding: "4px 8px", width: 52, textAlign: "center" }}>
                        {url ? (
                          <img src={url} alt={row.color} style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 4, border: "1px solid #334155" }} />
                        ) : <span style={{ display: "block", width: 44, height: 44, background: "#1E293B", borderRadius: 4, margin: "0 auto" }} />}
                      </td>
                      <td style={{ padding: "8px 14px", color: C.base, fontFamily: "monospace", fontWeight: 700, borderRight: `1px solid ${C.sectionBdr}` }}>{payload.style.style_code}</td>
                      <td style={{ padding: "8px 14px", color: C.desc, fontSize: 12 }}>{payload.style.style_name || payload.style.description || "—"}</td>
                      <td style={{ padding: "8px 14px", color: "#D1D5DB" }}>{row.color || "—"}</td>
                      <td style={{ padding: "8px 14px", color: "#C4B5FD", fontFamily: "monospace" }}>{row.inseam ? `${row.inseam}"` : "—"}</td>
                      {sizeOrder.map((sz) => (
                        <td key={sz} style={{ padding: "8px 14px", textAlign: "center", color: row.sizes[sz] ? C.gridText : C.emptyCell, fontFamily: "monospace" }}>
                          {row.sizes[sz] ? fmtQty(row.sizes[sz]) : "—"}
                        </td>
                      ))}
                      <td style={{ padding: "8px 14px", textAlign: "center", color: C.amber, fontWeight: 700, fontFamily: "monospace" }}>{fmtQty(row.totalQty)}</td>
                      <td style={{ padding: "8px 14px", textAlign: "right", color: C.green, fontFamily: "monospace" }}>{row.avgCostCents == null ? "—" : fmtCurrency(row.avgCostCents / 100)}</td>
                      <td style={{ padding: "8px 14px", textAlign: "right", color: C.green, fontWeight: 600, fontFamily: "monospace" }}>{row.totalCostCents > 0 ? fmtCurrency(row.totalCostCents / 100) : "—"}</td>
                      <td style={{ padding: "8px 14px", textAlign: "center", color: C.base, fontFamily: "monospace" }}>{row.lastReceived ? fmtDate(row.lastReceived.slice(0, 10)) : "—"}</td>
                    </tr>
                  );
                })
              ) : (
                visibleRows.map((row, ri) => {
                const isLast = ri === visibleRows.length - 1;
                return (
                  <tr
                    key={row.key}
                    style={{ borderBottom: isLast ? `2px solid ${C.sectionBdr}` : `1px solid ${C.rowBdr}` }}
                  >
                    <td style={{ padding: "4px 8px", width: 52, textAlign: "center" }}>
                      {(() => {
                        const key = row.color.toLowerCase().trim();
                        const url = styleImages.get(key) || styleImages.get("__default__") || "";
                        return url ? (
                          <img
                            src={url}
                            alt={row.color}
                            style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 4, border: "1px solid #334155" }}
                          />
                        ) : <span style={{ display: "block", width: 44, height: 44, background: "#1E293B", borderRadius: 4, margin: "0 auto" }} />;
                      })()}
                    </td>
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
              })
              )}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: `2px solid ${C.sectionBdr}`, background: C.headerBg }}>
                <td style={{ padding: "12px 14px" }} />
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
      ))}
    </div>
  );
}
