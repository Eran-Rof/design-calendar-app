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

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import type { SearchableSelectOption } from "./components/SearchableSelect";
import { MultiSelectDropdown } from "../inventory-planning/components/MultiSelectDropdown";
import DateRangePresets from "./components/DateRangePresets";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { computeSizeCollapse } from "../shared/matrix";
import { openStyleGallery } from "../shared/ui/StyleImageGallery";
import { useStyleThumbs, StyleThumb, type StyleThumbInfo } from "../shared/ui/StyleThumb";
import { colPriceCents, colCostCents } from "./snapshotPricing";
import { ColorSwatch } from "../shared/ui/ColorSwatch";
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
  // Additive — the full set of lot numbers present on this style's on-hand
  // (NO_LOT bucket "(no lot)" sorts last). Populates the lot filter dropdown; it
  // stays the full list even when the fetch scopes on-hand to selected lots.
  lots?: string[];
  skus: MatrixSku[];
  // Additive — present only when fetched with explode_ppk=true.
  explode?: ExplodeInfo;
};

type ExplodeCell = { color: string; size: string; qty: number; by_wh?: Record<string, number> };
type ExplodeInfo = {
  enabled: boolean;
  self?: boolean; // true = the picked PPK style was exploded into its own size grid
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
// Bucket label for unlotted stock — must match NO_LOT in api/_lib/styleMatrix.js.
const NO_LOT_LABEL = "(no lot)";

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

// ── reusable column sort (drill modals) ──────────────────────────────────────
// A tiny click-to-sort helper for the Sold / Purchased popup tables (#5/#7). Each
// header toggles asc → desc on the clicked key; the arrow renders the direction.
type SortDir = "asc" | "desc";
function useColumnSort<T>(initialKey: keyof T | null = null, initialDir: SortDir = "asc") {
  const [key, setKey] = useState<keyof T | null>(initialKey);
  const [dir, setDir] = useState<SortDir>(initialDir);
  const onSort = (k: keyof T) => {
    setKey((prev) => { if (prev === k) { setDir((d) => (d === "asc" ? "desc" : "asc")); return prev; } setDir("asc"); return k; });
  };
  const sort = (rows: T[]): T[] => {
    if (key == null) return rows;
    const out = [...rows];
    out.sort((a, b) => {
      const av = a[key], bv = b[key];
      let c: number;
      if (typeof av === "number" || typeof bv === "number") c = num(av as number) - num(bv as number);
      else c = String(av ?? "").localeCompare(String(bv ?? ""));
      return dir === "asc" ? c : -c;
    });
    return out;
  };
  const arrow = (k: keyof T) => (key === k ? (dir === "asc" ? " ▲" : " ▼") : "");
  return { key, dir, onSort, sort, arrow };
}


const ALL_BRANDS_SENTINEL     = "__ALL_BRANDS__";
const ALL_GENDER_SENTINEL     = "__ALL_GENDER__";
const ALL_GROUP_SENTINEL      = "__ALL_GROUP__";
const ALL_CATEGORY_SENTINEL   = "__ALL_CATEGORY__";
const ALL_SUBCATEGORY_SENTINEL = "__ALL_SUBCATEGORY__";
const MULTI_PAGE_SIZE = 25;

// ── Inventory Snapshot (default all-styles view) ─────────────────────────────
// One row per (style, color) with the lifecycle quantities, from
// /api/internal/inventory-snapshot. Each quantity drills into the matching app
// in a NEW TAB (on-hand → this matrix; SO/PO/Allocations → those windows
// searched to the style; ATS → the ATS app filtered to the style).
type SnapshotRow = {
  style_id: string; style_code: string; description: string;
  color: string | null; category: string | null;
  on_hand: number; allocated: number; on_so: number;
  on_po: number; in_transit: number; ats: number; ats_incl_po: number;
  sold: number; purchased: number; avg_cost_cents: number | null;
  sale_price_cents: number | null;
  // Per-column transaction prices (per-each cents): On SO → open_so_price;
  // Sold → sold_price; inventory/PO columns → sale_price (qty-weighted avg SO
  // price — the representative wholesale price, same basis as the Avrg Sale
  // column). NOT current_price (single most-recent SO line), which is an
  // outlier that inflated On Hand / Allocated / Purchased on the totals strip.
  open_so_price_cents?: number | null;
  sold_price_cents?: number | null;
  current_price_cents?: number | null;
  // Qty-weighted unit cost of the OPEN purchase-order lines feeding On PO (and
  // In Trnst) — the actual PO cost, so the On PO column ties to the PO grid
  // rather than the item-master historical blend (avg_cost_cents).
  on_po_cost_cents?: number | null;
};

// Per-column cost/price basis for the totals strip lives in snapshotPricing.ts
// (pure + unit-tested): colPriceCents / colCostCents, imported below.
// A snapshot row after client-side roll-up. `_merged` flags a Merge-PPK row
// (base + its PPK sibling combined) so the table can style it distinctly.
// `_components` carries the underlying base-style + PPK-pack rows (already
// per-unit / exploded) that summed into the merged line, so the row can be
// expanded (▾) to drill into what it's made of — they reconcile exactly to the
// merged totals because the merge is a plain sum of these same rows.
type MergedRow = SnapshotRow & { _merged?: boolean; _components?: SnapshotRow[] };

// Snapshot column key — the real SnapshotRow fields plus the DERIVED "Avg Mrgn %"
// column (computed from avg sale − avg cost, not a stored field).
type SnapColKey = keyof SnapshotRow | "avg_margin_pct";

// Gross-margin fraction for a snapshot row: (avg sale − avg cost) / avg sale.
// Null when the avg sale price is missing or zero (divide-by-zero guard) or the
// avg cost is missing → the row's Avg Mrgn % renders blank. Cents in, fraction
// out (e.g. 0.4215 → "42.15%").
function marginFrac(saleCents: number | null | undefined, costCents: number | null | undefined): number | null {
  if (saleCents == null || saleCents === 0 || costCents == null) return null;
  return (saleCents - costCents) / saleCents;
}
// Percent display for the Avg Mrgn % cell — two decimals, blank ("—") when null.
function fmtMarginPct(saleCents: number | null | undefined, costCents: number | null | undefined): string {
  const m = marginFrac(saleCents, costCents);
  return m == null ? "—" : `${(m * 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

// NOTE: no `noopener`. These are same-origin Tangerine deep-links, and Tangerine
// adopts its identity from the opener tab's sessionStorage ("plm_user"). `noopener`
// starts the new tab with an EMPTY sessionStorage, so the drill tab loses the PLM
// session and Tangerine falls back to a fresh Microsoft sign-in prompt. Keeping the
// opener link lets the new tab inherit the session (same as NavDrawer's new-tab).
function openTab(url: string) { window.open(url, "_blank"); }
// Same-app (Tangerine) module deep-links — relative so the current /tangerine
// path is kept and only the query changes.
const lnkMatrix = (styleId: string) => `?m=inventory_matrix&style_id=${encodeURIComponent(styleId)}`;
const lnkSO     = (code: string)    => `?m=sales_orders&q=${encodeURIComponent(code)}`;
const lnkPO     = (code: string)    => `?m=purchase_orders&q=${encodeURIComponent(code)}`;
const lnkAlloc  = (code: string)    => `?m=sales_allocations&q=${encodeURIComponent(code)}`;
// ATS is a separate app at /ats; preselect the style via its search filter.
const lnkATS    = (code: string, inclPo = false) => `/ats?style=${encodeURIComponent(code)}${inclPo ? "&incl_po=1" : ""}`;

const SNAP_COLS: { key: SnapColKey; label: string; numeric: boolean }[] = [
  { key: "style_code",  label: "Style",                  numeric: false },
  { key: "color",       label: "Color",                  numeric: false },
  { key: "description", label: "Name",                   numeric: false },
  { key: "on_hand",     label: "On Hand",                numeric: true },
  { key: "allocated",   label: "Allocated",              numeric: true },
  { key: "on_so",       label: "On SO",                  numeric: true },
  { key: "ats",         label: "ATS Qty",                numeric: true },
  { key: "on_po",       label: "On PO",                  numeric: true },
  { key: "ats_incl_po", label: "ATS Qty (Incl POs)",    numeric: true },
  { key: "sold",        label: "Sold",                   numeric: true },
  { key: "purchased",   label: "Purchased",              numeric: true },
  { key: "category",    label: "Item Category",          numeric: false },
  { key: "in_transit",  label: "In Trnst",               numeric: true },
  { key: "avg_cost_cents", label: "Avrg Cost",           numeric: true },
  { key: "sale_price_cents", label: "Avrg Sale",         numeric: true },
  { key: "avg_margin_pct", label: "Avg Mrgn %",          numeric: true },
];

const SNAP_HIDE_KEY = "inv_snapshot_hidden_cols";

// Determinate-style progress bar for the snapshot load (app colors). The fetch
// is a single opaque request, so we ramp toward ~90% while it's in flight and
// snap to 100% on completion (the NProgress pattern) — it reads as a filling
// progress bar rather than an indeterminate spinner.
function SnapshotProgressBar({ active }: { active: boolean }) {
  const [pct, setPct] = useState(0);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (active) {
      setVisible(true);
      setPct(8);
      const id = setInterval(() => setPct((p) => (p < 90 ? p + Math.max(0.5, (90 - p) * 0.12) : p)), 110);
      return () => clearInterval(id);
    }
    if (visible) {
      setPct(100);
      const t = setTimeout(() => { setVisible(false); setPct(0); }, 350);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!visible) return null;
  return (
    <div role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}
         style={{ height: 5, background: C.bg, border: `1px solid ${C.cardBdr}`, borderRadius: 3, overflow: "hidden", marginBottom: 10 }}>
      <div style={{ height: "100%", width: `${pct}%`, background: C.primary, borderRadius: 3, transition: "width 0.2s ease" }} />
    </div>
  );
}

// Quantity columns summed on roll-up AND in the Totals row (avg_cost is a
// per-unit cost, never summed).
const SNAP_SUM_COLS = ["on_hand", "allocated", "on_so", "ats", "on_po", "ats_incl_po", "sold", "purchased", "in_transit"] as const;

// Client-side roll-up shared by the table AND the export so both render the
// exact same rows: (1) Merge PPK (base + its PPK sibling -> one BASE/PPK row
// per colour), then (2) Collapse ONTO the checked text column(s) (those become
// the group-by key; every other text column folds away and numerics sum).
function rollupSnapshot(rows: SnapshotRow[], mergePpk: boolean, collapseCols: Set<string>): MergedRow[] {
  const DIMS = ["style_code", "color", "description", "category"] as const;
  const SUMS = SNAP_SUM_COLS;
  const hasData = (r: SnapshotRow) => SUMS.some((k) => num(r[k] as number) !== 0); // any quantity column non-zero
  const isPpk = (code: string) => /ppk/i.test(code);
  const stemOf = (code: string) => code.replace(/ppk.*$/i, "").trim(); // "RYB0594PPK" -> "RYB0594"

  // 1. Merge PPK — combine a base style with its PPK sibling, but ONLY for the
  //    colours that carry data (any quantity column non-zero) in BOTH the base
  //    AND the PPK style. Colours present (with data) in only one side stay as
  //    their own rows; styles with no PPK sibling are untouched.
  let src: MergedRow[] = rows;
  if (mergePpk) {
    const byStem = new Map<string, { rows: SnapshotRow[]; hasPpk: boolean }>();
    for (const r of rows) {
      const sl = stemOf(r.style_code).toLowerCase();
      let e = byStem.get(sl);
      if (!e) { e = { rows: [], hasPpk: false }; byStem.set(sl, e); }
      e.rows.push(r);
      if (isPpk(r.style_code)) e.hasPpk = true;
    }
    const out: MergedRow[] = [];
    for (const e of byStem.values()) {
      if (!e.hasPpk) { out.push(...e.rows); continue; } // no PPK sibling -> pass through
      const byColor = new Map<string, { base: SnapshotRow[]; ppk: SnapshotRow[] }>();
      for (const r of e.rows) {
        const ck = String(r.color ?? "").toLowerCase().trim();
        let c = byColor.get(ck);
        if (!c) { c = { base: [], ppk: [] }; byColor.set(ck, c); }
        (isPpk(r.style_code) ? c.ppk : c.base).push(r);
      }
      for (const c of byColor.values()) {
        const both = c.base.some(hasData) && c.ppk.some(hasData);
        if (!both) { out.push(...c.base, ...c.ppk); continue; } // data on only one side -> unchanged
        const all = [...c.base, ...c.ppk];
        const stemCode = stemOf((c.base[0] ?? all[0]).style_code);
        const g: MergedRow & { _cost: number[]; _sale: number[]; _openSo: number[]; _sold: number[]; _cur: number[]; _poCost: number[] } = {
          style_id: "", style_code: `${stemCode}/PPK`, description: "", color: null, category: null,
          on_hand: 0, allocated: 0, on_so: 0, on_po: 0, in_transit: 0, ats: 0, ats_incl_po: 0,
          sold: 0, purchased: 0, avg_cost_cents: null, sale_price_cents: null, _merged: true, _cost: [], _sale: [], _openSo: [], _sold: [], _cur: [], _poCost: [] };
        for (const r of all) {
          if (!isPpk(r.style_code)) { g.description = r.description; g.category = r.category; if (!g.style_id) g.style_id = r.style_id; }
          if (r.color && !g.color) g.color = r.color;
          for (const nk of SUMS) (g as unknown as Record<string, number>)[nk] += num(r[nk] as number);
          if (r.avg_cost_cents != null) g._cost.push(r.avg_cost_cents);
          if (r.sale_price_cents != null) g._sale.push(r.sale_price_cents);
          if (r.open_so_price_cents != null) g._openSo.push(r.open_so_price_cents);
          if (r.sold_price_cents != null) g._sold.push(r.sold_price_cents);
          if (r.current_price_cents != null) g._cur.push(r.current_price_cents);
          if (r.on_po_cost_cents != null) g._poCost.push(r.on_po_cost_cents);
        }
        const { _cost, _sale, _openSo, _sold, _cur, _poCost, ...row } = g;
        const avgOf = (a: number[]) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null);
        // Keep the underlying base + PPK rows (already per-unit) so the merged
        // line can be expanded (▾) to drill into its components; only those
        // carrying data are shown. They sum back to the merged totals exactly.
        const components = all.filter(hasData);
        out.push({ ...row, avg_cost_cents: avgOf(_cost), sale_price_cents: avgOf(_sale), open_so_price_cents: avgOf(_openSo), sold_price_cents: avgOf(_sold), current_price_cents: avgOf(_cur), on_po_cost_cents: avgOf(_poCost), _components: components } as MergedRow);
      }
    }
    src = out;
  }

  // 2. Collapse ONTO the checked column(s): those become the group-by key and
  //    every other text column folds away (numerics summed, Avg Cost averaged).
  //    A non-key text column is still SHOWN when it is constant across the group
  //    (so collapse onto Style keeps the one Style number + its Name/Category;
  //    collapse onto Item Category shows just the category, the rest blank).
  if (collapseCols.size === 0) return src; // nothing chosen -> no roll-up
  const keyDims = DIMS.filter((k) => collapseCols.has(k));
  type G = MergedRow & { _vals: Record<string, Set<string>>; _sids: Set<string>; _cost: number[]; _sale: number[]; _openSo: number[]; _sold: number[]; _cur: number[]; _poCost: number[] };
  const map = new Map<string, G>();
  for (const r of src) {
    const key = keyDims.map((k) => String(r[k] ?? "")).join(""); // sep avoids value collisions
    let g = map.get(key);
    if (!g) {
      g = { style_id: "", style_code: "", description: "", color: null, category: null,
        on_hand: 0, allocated: 0, on_so: 0, on_po: 0, in_transit: 0, ats: 0, ats_incl_po: 0,
        sold: 0, purchased: 0, avg_cost_cents: null, sale_price_cents: null,
        _vals: { style_code: new Set(), color: new Set(), description: new Set(), category: new Set() },
        _sids: new Set(), _cost: [], _sale: [], _openSo: [], _sold: [], _cur: [], _poCost: [] };
      map.set(key, g);
    }
    for (const d of DIMS) g._vals[d].add(String(r[d] ?? ""));
    for (const nk of SUMS) (g as unknown as Record<string, number>)[nk] += num(r[nk] as number);
    if (r.avg_cost_cents != null) g._cost.push(r.avg_cost_cents);
    if (r.sale_price_cents != null) g._sale.push(r.sale_price_cents);
    if (r.open_so_price_cents != null) g._openSo.push(r.open_so_price_cents);
    if (r.sold_price_cents != null) g._sold.push(r.sold_price_cents);
    if (r.current_price_cents != null) g._cur.push(r.current_price_cents);
    if (r.on_po_cost_cents != null) g._poCost.push(r.on_po_cost_cents);
    if (r._merged) g._merged = true;
    g._sids.add(r.style_id);
  }
  const avgOf2 = (a: number[]) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null);
  return [...map.values()].map((g) => {
    const { _vals, _sids, _cost, _sale, _openSo, _sold, _cur, _poCost, ...row } = g;
    const one = (d: string): string | null => (_vals[d].size === 1 ? ([..._vals[d]][0] || null) : null); // constant value, else blank
    return { ...row,
      style_id: _sids.size === 1 ? [..._sids][0] : "",
      style_code: one("style_code") ?? "",
      color: one("color"),
      description: one("description") ?? "",
      category: one("category"),
      avg_cost_cents: avgOf2(_cost),
      sale_price_cents: avgOf2(_sale),
      on_po_cost_cents: avgOf2(_poCost),
      open_so_price_cents: avgOf2(_openSo),
      sold_price_cents: avgOf2(_sold),
      current_price_cents: avgOf2(_cur),
    } as MergedRow;
  });
}

function SnapshotView({
  rows, loading, err, sortKey, sortDir, onSort, thumbs, onOpenSold, onOpenPurchased, show, explodePpk, mergePpk, collapseCols, showTotals,
}: {
  rows: SnapshotRow[];
  loading: boolean;
  err: string | null;
  sortKey: SnapColKey;
  sortDir: "asc" | "desc";
  onSort: (k: SnapColKey) => void;
  thumbs: Map<string, StyleThumbInfo>;
  onOpenSold: (r: SnapshotRow) => void;
  onOpenPurchased: (r: SnapshotRow) => void;
  // Column visibility lifted to the parent (control lives in the header row).
  show: (k: string) => boolean;
  explodePpk: boolean; // carries the explode flag into the new-tab drill URLs
  mergePpk: boolean;   // collapse base style + its PPK sibling into one BASE/PPK row
  collapseCols: Set<string>; // text column(s) to collapse ONTO (group-by key; rest summed)
  showTotals: boolean; // totals strip above the headers (Qty + $ Cost + $ Wholesale + Avg Cost + Avg Sale stacked per column)
}) {
  // Zebra striping tint by row index — alternate rows get a clearly visible
  // background so long lists stay readable; mirrors the drill modals' zebra().
  const zebra = (i: number): React.CSSProperties => ({ background: i % 2 ? "rgba(148,163,184,0.16)" : "transparent" });
  const HOVER_BG = "rgba(59,130,246,0.26)"; // distinct from BOTH zebra tints

  // Expanded Merge-PPK rows — a merged "BASE/PPK" line can be expanded (▾) to
  // reveal its components: the base-style eaches + the PPK-pack contribution
  // (exploded to per-unit), which sum back to the merged totals exactly.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (key: string) =>
    setExpanded((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });

  // Sticky bottom horizontal scrollbar. The grid can be far wider than the
  // viewport; its native h-scrollbar sits at the bottom of the (tall) scroll box,
  // so you'd have to scroll down to reach it. This proxy bar is pinned to the
  // bottom of the viewport and scroll-synced both ways with the grid, so
  // horizontal scrolling is always one reach away.
  const scrollRef = useRef<HTMLDivElement>(null);
  const hbarRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  const [scrollMetrics, setScrollMetrics] = useState({ scrollW: 0, clientW: 0 });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setScrollMetrics({ scrollW: el.scrollWidth, clientW: el.clientWidth });
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => { ro?.disconnect(); window.removeEventListener("resize", measure); };
  }, [rows, explodePpk, mergePpk, showTotals, collapseCols]);
  const onGridScroll = () => {
    if (syncing.current) { syncing.current = false; return; }
    const g = scrollRef.current, b = hbarRef.current;
    if (g && b) { syncing.current = true; b.scrollLeft = g.scrollLeft; }
  };
  const onBarScroll = () => {
    if (syncing.current) { syncing.current = false; return; }
    const g = scrollRef.current, b = hbarRef.current;
    if (g && b) { syncing.current = true; g.scrollLeft = b.scrollLeft; }
  };
  const showHBar = scrollMetrics.scrollW > scrollMetrics.clientW + 1;

  // ── Collapse / roll-up ────────────────────────────────────────────────────
  // "Collapse onto X" = the CHECKED column(s) become the group-by key; every
  // other text column is dropped so its rows merge, and numerics are summed
  // (Avg Cost averaged); a non-key text column is still shown when constant
  // across the group. Collapse onto Style -> one row per style (all colours
  // summed) showing the style number + its Name; Collapse onto Item Category ->
  // one row per category showing just the category name. The control offers
  // Style + Item Category.
  const collapseKey = [...collapseCols].sort().join(",");
  const grouped = useMemo<MergedRow[]>(() => rollupSnapshot(rows, mergePpk, collapseCols), [rows, collapseKey, mergePpk]); // eslint-disable-line react-hooks/exhaustive-deps

  const sorted = useMemo(() => {
    const r = [...grouped];
    r.sort((a, b) => {
      let c: number;
      if (sortKey === "avg_margin_pct") {
        // Derived column — sort by computed margin; rows with no margin sort low.
        const am = marginFrac(a.sale_price_cents, a.avg_cost_cents);
        const bm = marginFrac(b.sale_price_cents, b.avg_cost_cents);
        c = (am ?? -Infinity) - (bm ?? -Infinity);
      } else {
        const av = a[sortKey as keyof SnapshotRow], bv = b[sortKey as keyof SnapshotRow];
        if (typeof av === "number" || typeof bv === "number") c = num(av as number) - num(bv as number);
        else c = String(av ?? "").localeCompare(String(bv ?? ""));
      }
      return sortDir === "asc" ? c : -c;
    });
    return r;
  }, [grouped, sortKey, sortDir]);

  // Totals across the displayed rows, per quantity column. qty = unit counts;
  // cost = qty × per-column unit cost (item-master avg, or the open-PO cost for
  // On PO / In Trnst); wholesale = qty × per-column sale price (qty-weighted avg
  // SO wholesale price, or the open-SO / sold price for those columns). avgCost /
  // avgWhol are the per-unit means = $ total ÷ priced qty for that column (#10).
  const totals = useMemo(() => {
    const qty: Record<string, number> = {};
    const cost: Record<string, number> = {};
    const wholesale: Record<string, number> = {};
    // Qty of rows that ACTUALLY carry a cost / sale price — the correct
    // denominator for the per-unit averages (see below).
    const cQty: Record<string, number> = {};
    const pQty: Record<string, number> = {};
    for (const k of SNAP_SUM_COLS) { qty[k] = 0; cost[k] = 0; wholesale[k] = 0; cQty[k] = 0; pQty[k] = 0; }
    for (const r of sorted) {
      for (const k of SNAP_SUM_COLS) {
        const v = num(r[k] as number);
        qty[k] += v;
        // Per-column cost: On PO / In Trnst use the actual open-PO unit cost
        // (ties to the PO grid); every other column the item-master avg cost.
        const cc = colCostCents(r, k);
        if (cc != null) { cost[k] += v * (cc / 100); cQty[k] += v; }
        // Per-column transaction price: On SO uses the open-SO price, Sold the
        // actual sold price, inventory/PO columns the qty-weighted avg SO price.
        // Unpriced rows are excluded from that column's average (no dilution).
        const pc = colPriceCents(r, k);
        if (pc != null) { wholesale[k] += v * (pc / 100); pQty[k] += v; }
      }
    }
    // Per-unit averages divide by the qty of rows that carry a cost/price — NOT
    // total qty. Dividing by total qty drags the average DOWN whenever a column
    // holds units from rows with no known wholesale price (e.g. styles never
    // sold on an SO): those units count in the denominator but add $0 to the
    // numerator. That was the bug — On PO / Sold read ~$4.4 while the true
    // wholesale price is ~$7. ($ Cost / $ Wholesale totals are unchanged since
    // unpriced rows contribute $0 either way.)
    const avgCost: Record<string, number> = {};
    const avgWhol: Record<string, number> = {};
    for (const k of SNAP_SUM_COLS) {
      avgCost[k] = cQty[k] > 0 ? cost[k] / cQty[k] : 0;
      avgWhol[k] = pQty[k] > 0 ? wholesale[k] / pQty[k] : 0;
    }
    return { qty, cost, wholesale, avgCost, avgWhol };
  }, [sorted]);

  // Quantity cell — opens a URL in a new tab.
  const QtyLink = ({ v, url }: { v: number; url: string }) => (
    <a href={url} target="_blank" rel="noreferrer"
       onClick={(e) => { e.preventDefault(); openTab(url); }}
       style={{ color: C.base, textDecoration: "none", cursor: "pointer", fontFamily: "monospace" }}>{fmtQty(v)}</a>
  );
  // Quantity cell — opens a drill modal (Sold / Purchased).
  const QtyBtn = ({ v, onClick }: { v: number; onClick: () => void }) => (
    <span role="button" tabIndex={0} onClick={onClick} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick(); }}
       style={{ color: C.base, cursor: "pointer", fontFamily: "monospace", textDecoration: "underline dotted" }}>{fmtQty(v)}</span>
  );
  // Collapsed rows that span >1 style have no single style to drill into → plain.
  const NumLink = ({ v, url }: { v: number; url: string | null }) =>
    url ? <QtyLink v={v} url={url} /> : <span style={{ fontFamily: "monospace", color: C.text }}>{fmtQty(v)}</span>;
  const NumBtn = ({ v, onClick }: { v: number; onClick: (() => void) | null }) =>
    onClick ? <QtyBtn v={v} onClick={onClick} /> : <span style={{ fontFamily: "monospace", color: C.text }}>{fmtQty(v)}</span>;
  // Double the row spacing and bump the font to 125% (operator request).
  const tdNum: React.CSSProperties = { padding: "16px 14px", textAlign: "right", fontFamily: "monospace", color: C.text };
  const tdTxt: React.CSSProperties = { padding: "16px 14px", textAlign: "left", color: C.text };
  // Frozen header cell: thBase + sticky to the scroll container's top. Opaque
  // card background so scrolling rows don't show through the header. When the
  // Totals strip is on it occupies the top band, so the column header sticks
  // just below it (top: TOTALS_H).
  const TOTALS_H = 108; // six stacked lines (Qty / $ Cost / $ Wholesale / Avg Cost / Avg Mrgn / Avg Sale)
  const headerTop = showTotals ? TOTALS_H : 0;
  const thStick: React.CSSProperties = { ...thBase, position: "sticky", top: headerTop, zIndex: 2, background: C.card };
  // Totals strip cells — sticky at the very top, above the column header.
  const totalsTh: React.CSSProperties = { ...thBase, position: "sticky", top: 0, zIndex: 3, height: TOTALS_H, background: C.card, borderBottom: `2px solid ${C.primary}`, fontFamily: "monospace", padding: "4px 10px" };
  const fmtUSD = (v: number) => (v ? `$${Math.round(v).toLocaleString()}` : "—");
  const fmtUSD2 = (v: number) => (v ? `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—");
  // One totals cell stacks all five measures so a single Totals toggle shows
  // Qty + $ Cost + $ Wholesale + Avg Cost + Avg Sale together (no mode choice).
  const totStack: React.CSSProperties = { display: "flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.3, fontFamily: "monospace", fontSize: 11 };

  if (loading) return <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>Loading snapshot…</div>;
  if (err) return <div style={{ background: "#7f1d1d", color: "white", padding: "10px 14px", borderRadius: 8, fontSize: 13 }}>{err}</div>;
  if (rows.length === 0) return <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>No inventory rows.</div>;

  return (
    <div>
      <div ref={scrollRef} onScroll={onGridScroll} style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)", background: C.card, borderRadius: 10, border: `1px solid ${C.cardBdr}` }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 16 /* 125% of the 13px base */ }}>
          <thead>
            {/* Totals strip — above the column headers (ATS-modelled). Each
                quantity column stacks five measures: Qty (unit counts), $ Cost
                (qty × avg cost), $ Wholesale (qty × avg wholesale SO sale price),
                Avg Cost and Avg Sale (per-unit means over the units that carry a
                cost / price — NOT ÷ total qty, which would dilute them with
                unpriced units). */}
            {showTotals && (() => {
              const visCols = SNAP_COLS.filter((c) => show(c.key as string));
              let labelled = false;
              return (
                <tr>
                  {show("image") && <th style={totalsTh} />}
                  {visCols.map((col) => {
                    const k = col.key as string;
                    const isSum = (SNAP_SUM_COLS as readonly string[]).includes(k);
                    if (isSum) {
                      return (
                        <th key={k} style={{ ...totalsTh, textAlign: "right" }}>
                          <div style={totStack}>
                            <span style={{ color: C.amber, fontWeight: 800 }}>{fmtQty(totals.qty[k])}</span>
                            <span style={{ color: C.textSub }}>{fmtUSD(totals.cost[k])}</span>
                            <span style={{ color: C.base }}>{fmtUSD(totals.wholesale[k])}</span>
                            <span style={{ color: C.green }}>{fmtUSD2(totals.avgCost[k])}</span>
                            <span style={{ color: "#93C5FD" }}>{fmtUSD2(totals.avgWhol[k])}</span>
                            <span style={{ color: "#34D399" }}>{totals.avgWhol[k] > 0 ? `${(((totals.avgWhol[k] - totals.avgCost[k]) / totals.avgWhol[k]) * 100).toFixed(2)}%` : "—"}</span>
                          </div>
                        </th>
                      );
                    }
                    // First non-summed column carries the row legend.
                    if (!labelled) {
                      labelled = true;
                      return (
                        <th key={k} style={{ ...totalsTh, textAlign: "right" }}>
                          <div style={{ ...totStack, fontWeight: 700 }}>
                            <span style={{ color: C.amber }}>Qty</span>
                            <span style={{ color: C.textSub }}>$ Cost</span>
                            <span style={{ color: C.base }}>$ Wholesale</span>
                            <span style={{ color: C.green }}>Avg Cost</span>
                            <span style={{ color: "#93C5FD" }}>Avrg Sale</span>
                            <span style={{ color: "#34D399" }}>Avg Mrgn</span>
                          </div>
                        </th>
                      );
                    }
                    return <th key={k} style={totalsTh} />;
                  })}
                </tr>
              );
            })()}
            <tr>
              {/* Frozen header — sticks to the top while the body scrolls. Opaque
                  background so rows don't bleed through. */}
              {show("image") && <th style={{ ...thStick, textAlign: "center" }}>Image</th>}
              {SNAP_COLS.filter((c) => show(c.key as string)).map((col) => {
                // The widest headers ("ATS Qty (Incl POs)", "Item Category") WRAP
                // onto multiple lines (constrained width) so the column stays narrow.
                const wrap = col.key === "ats_incl_po" || col.key === "category";
                return (
                  <th key={col.key as string} onClick={() => onSort(col.key)}
                      style={{ ...thStick, textAlign: col.numeric ? "right" : "left", cursor: "pointer", whiteSpace: wrap ? "normal" : "nowrap", ...(wrap ? { maxWidth: 72, width: 72 } : {}), userSelect: "none" }}>
                    {col.label}{sortKey === col.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => {
              const thumbUrl = thumbs.get(r.style_id)?.byColor[(r.color || "").toLowerCase().trim()] ?? thumbs.get(r.style_id)?.default ?? null;
              const exp = explodePpk ? "&explode_ppk=true" : ""; // carry explode into matrix drill
              // A collapsed row that rolls up >1 style has no single style to
              // drill into → render its quantities as plain numbers.
              const merged = !!r._merged; // Merge-PPK row (base + PPK combined)
              const linkable = !!r.style_id && !!r.style_code && !merged;
              const rowBg = merged ? "rgba(139,92,246,0.16)" : (zebra(i).background as string);
              const rowKey = `${r.style_id}|${r.style_code}|${r.color ?? ""}|${r.category ?? ""}`;
              // Merged rows with components get a ▾ expander to drill into the
              // base-style eaches + PPK-pack contribution that summed into them.
              const comps = merged ? (r._components ?? []) : [];
              const canExpand = comps.length > 0;
              const isOpen = expanded.has(rowKey);
              return (
                <Fragment key={rowKey}>
                <tr style={{ borderBottom: `1px solid ${C.rowBdr}`, background: rowBg }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = HOVER_BG; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = rowBg; }}>
                  {show("image") && <td style={{ padding: "8px 14px", textAlign: "center" }}><StyleThumb styleId={r.style_id} label={r.style_code} url={thumbUrl} size={48} /></td>}
                  {show("style_code") && <td style={{ ...tdTxt, fontWeight: 600, color: merged ? "#C4B5FD" : C.text }}>
                    {canExpand && (
                      <span role="button" tabIndex={0} aria-expanded={isOpen} title={isOpen ? "Hide components" : "Show base + PPK components"}
                        onClick={() => toggleExpand(rowKey)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpand(rowKey); } }}
                        style={{ cursor: "pointer", marginRight: 6, color: "#C4B5FD", userSelect: "none", display: "inline-block", width: 12 }}>{isOpen ? "▾" : "▸"}</span>
                    )}
                    {r.style_code || "—"}
                  </td>}
                  {show("color") && <td style={tdTxt}><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><ColorSwatch name={r.color} size={18} /> {r.color || "—"}</span></td>}
                  {show("description") && <td style={{ ...tdTxt, color: C.textMuted }}>{r.description || "—"}</td>}
                  {show("on_hand") && <td style={tdNum}><NumLink v={r.on_hand} url={linkable ? `${lnkMatrix(r.style_id)}${exp}` : null} /></td>}
                  {show("allocated") && <td style={tdNum}><NumLink v={r.allocated} url={linkable ? lnkAlloc(r.style_code) : null} /></td>}
                  {show("on_so") && <td style={tdNum}><NumLink v={r.on_so} url={linkable ? lnkSO(r.style_code) : null} /></td>}
                  {show("ats") && <td style={tdNum}><NumLink v={r.ats} url={linkable ? lnkATS(r.style_code) : null} /></td>}
                  {show("on_po") && <td style={tdNum}><NumLink v={r.on_po} url={linkable ? lnkPO(r.style_code) : null} /></td>}
                  {show("ats_incl_po") && <td style={tdNum}><NumLink v={r.ats_incl_po} url={linkable ? lnkATS(r.style_code, true) : null} /></td>}
                  {show("sold") && <td style={tdNum}><NumBtn v={r.sold} onClick={linkable ? () => onOpenSold(r) : null} /></td>}
                  {show("purchased") && <td style={tdNum}><NumBtn v={r.purchased} onClick={linkable ? () => onOpenPurchased(r) : null} /></td>}
                  {show("category") && <td style={{ ...tdTxt, color: C.textMuted }}>{r.category || "—"}</td>}
                  {show("in_transit") && <td style={tdNum}>{fmtQty(r.in_transit)}</td>}
                  {show("avg_cost_cents") && <td style={tdNum}>{r.avg_cost_cents != null ? (r.avg_cost_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}</td>}
                  {show("sale_price_cents") && <td style={tdNum}>{r.sale_price_cents != null ? (r.sale_price_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}</td>}
                  {show("avg_margin_pct") && <td style={tdNum}>{fmtMarginPct(r.sale_price_cents, r.avg_cost_cents)}</td>}
                </tr>
                {/* Component drill — base-style eaches + PPK-pack contribution
                    (per-unit), each linkable to its own style, summing back to
                    the merged line above. Tinted + indented to read as children. */}
                {isOpen && comps.map((cr, ci) => {
                  const cPpk = /ppk/i.test(cr.style_code); // PPK grain rule (style code, not size)
                  const cLink = !!cr.style_id && !!cr.style_code;
                  const cThumb = thumbs.get(cr.style_id)?.byColor[(cr.color || "").toLowerCase().trim()] ?? thumbs.get(cr.style_id)?.default ?? null;
                  const cBg = "rgba(139,92,246,0.07)";
                  return (
                    <tr key={`${rowKey}::comp::${cr.style_id}|${cr.style_code}|${cr.color ?? ""}|${ci}`}
                        style={{ borderBottom: `1px solid ${C.rowBdr}`, background: cBg }}>
                      {show("image") && <td style={{ padding: "8px 14px", textAlign: "center" }}><StyleThumb styleId={cr.style_id} label={cr.style_code} url={cThumb} size={36} /></td>}
                      {show("style_code") && <td style={{ ...tdTxt, paddingLeft: 34, color: C.textSub }}>
                        <span style={{ color: cPpk ? "#93C5FD" : C.textSub, fontWeight: 600 }}>{cPpk ? "PPK pack" : "Base eaches"}</span>{"  "}
                        <span style={{ color: C.textMuted, fontSize: 13 }}>{cr.style_code}</span>
                      </td>}
                      {show("color") && <td style={tdTxt}><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><ColorSwatch name={cr.color} size={16} /> {cr.color || "—"}</span></td>}
                      {show("description") && <td style={{ ...tdTxt, color: C.textMuted }}>{cr.description || "—"}</td>}
                      {show("on_hand") && <td style={tdNum}><NumLink v={cr.on_hand} url={cLink ? `${lnkMatrix(cr.style_id)}${exp}` : null} /></td>}
                      {show("allocated") && <td style={tdNum}><NumLink v={cr.allocated} url={cLink ? lnkAlloc(cr.style_code) : null} /></td>}
                      {show("on_so") && <td style={tdNum}><NumLink v={cr.on_so} url={cLink ? lnkSO(cr.style_code) : null} /></td>}
                      {show("ats") && <td style={tdNum}><NumLink v={cr.ats} url={cLink ? lnkATS(cr.style_code) : null} /></td>}
                      {show("on_po") && <td style={tdNum}><NumLink v={cr.on_po} url={cLink ? lnkPO(cr.style_code) : null} /></td>}
                      {show("ats_incl_po") && <td style={tdNum}><NumLink v={cr.ats_incl_po} url={cLink ? lnkATS(cr.style_code, true) : null} /></td>}
                      {show("sold") && <td style={tdNum}><NumBtn v={cr.sold} onClick={cLink ? () => onOpenSold(cr) : null} /></td>}
                      {show("purchased") && <td style={tdNum}><NumBtn v={cr.purchased} onClick={cLink ? () => onOpenPurchased(cr) : null} /></td>}
                      {show("category") && <td style={{ ...tdTxt, color: C.textMuted }}>{cr.category || "—"}</td>}
                      {show("in_transit") && <td style={tdNum}>{fmtQty(cr.in_transit)}</td>}
                      {show("avg_cost_cents") && <td style={tdNum}>{cr.avg_cost_cents != null ? (cr.avg_cost_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}</td>}
                      {show("sale_price_cents") && <td style={tdNum}>{cr.sale_price_cents != null ? (cr.sale_price_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}</td>}
                      {show("avg_margin_pct") && <td style={tdNum}>{fmtMarginPct(cr.sale_price_cents, cr.avg_cost_cents)}</td>}
                    </tr>
                  );
                })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* Sticky bottom horizontal scrollbar — pinned to the viewport bottom and
          scroll-synced with the grid above, so wide grids are always scrollable
          without hunting for the native bar at the end of a tall list. */}
      {showHBar && (
        <div ref={hbarRef} onScroll={onBarScroll}
          style={{ position: "sticky", bottom: 0, zIndex: 5, overflowX: "auto", overflowY: "hidden", height: 14, background: C.card, borderTop: `1px solid ${C.cardBdr}`, borderRadius: "0 0 10px 10px" }}>
          <div style={{ width: scrollMetrics.scrollW, height: 1 }} />
        </div>
      )}
    </div>
  );
}

// ── Drill modals (Sold / Purchased + Invoice / Bill detail) ──────────────────
type SoldDetail = {
  color_totals: { color: string | null; qty: number; avg_unit_price: number | null }[];
  grand_total: number;
  rows: { color: string | null; store: string | null; warehouse: string | null; qty: number; invoice_number: string | null; ar_invoice_id: string | null; customer: string | null; unit_price: number | null; date: string | null; kind: string }[];
};
type PurchasedDetail = {
  color_totals: { color: string | null; qty: number }[];
  grand_total: number;
  rows: { color: string | null; vendor: string | null; qty: number; unit_price: number | null; ref: string | null; bill_id: string | null; receipt_type: string; receipt_date: string | null; bill_date: string | null }[];
};

// Backdrop clears the NavDrawer: its left edge starts at --tng-nav-offset (the
// live drawer width published by Tangerine) so the centered drill panel sits in
// the content area and never slides UNDER the menu on a wrapped/narrow view
// (#24). Falls back to 0 outside Tangerine. The card caps to the remaining width.
const modalBackdrop: React.CSSProperties = { position: "fixed", top: 0, right: 0, bottom: 0, left: "var(--tng-nav-offset, 0px)", background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 20 };
const modalCard: React.CSSProperties = { background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, width: "min(1000px, calc(100vw - var(--tng-nav-offset, 0px) - 40px))", maxHeight: "90vh", overflow: "auto", padding: 20 };
const dl/* date-label */: React.CSSProperties = { fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 };
const dateInput: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, borderRadius: 4, padding: "4px 8px", fontSize: 13, colorScheme: "dark" };
const money = (n: number | null | undefined) => n == null ? "—" : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// DateRange — two native date inputs seeded from the header range.
function DateRange({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <DateRangePresets variant="dropdown" from={from} to={to} onChange={(f, t) => onChange(f, t)} />
      <label style={dl}>From <input type="date" value={from} onChange={(e) => onChange(e.target.value, to)} style={{ ...dateInput, marginLeft: 4 }} /></label>
      <label style={dl}>To <input type="date" value={to} onChange={(e) => onChange(from, e.target.value)} style={{ ...dateInput, marginLeft: 4 }} /></label>
      {(from || to) && <button onClick={() => onChange("", "")} style={{ background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, borderRadius: 4, padding: "3px 10px", fontSize: 12, cursor: "pointer" }}>Clear</button>}
    </div>
  );
}

function SoldDetailModal({ row, headerFrom, headerTo, explodePpk, onClose, onOpenInvoice }: {
  row: SnapshotRow; headerFrom: string; headerTo: string; explodePpk: boolean; onClose: () => void;
  onOpenInvoice: (arId: string, num: string, customer: string | null) => void;
}) {
  const [from, setFrom] = useState(headerFrom);
  const [to, setTo] = useState(headerTo);
  const [data, setData] = useState<SoldDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [store, setStore] = useState<string>("");      // "" = all stores (#7)
  const [collapseInv, setCollapseInv] = useState(false); // collapse rows on Invoice # (#18)
  type SoldRow = SoldDetail["rows"][number];
  const ctSort = useColumnSort<SoldDetail["color_totals"][number]>("qty", "desc");
  const rowSort = useColumnSort<SoldRow>("date", "desc");
  useEffect(() => {
    let cancelled = false; setLoading(true); setErr(null);
    const qs = new URLSearchParams({ style_id: row.style_id }); if (from) qs.set("from", from); if (to) qs.set("to", to);
    if (explodePpk) qs.set("explode_ppk", "true"); // explode the drilled detail too
    fetch(`/api/internal/inventory-sold-detail?${qs}`).then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j) => { if (!cancelled) { setData(j); setStore(""); } }).catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [row.style_id, from, to, explodePpk]);
  const th: React.CSSProperties = { ...thBase, textAlign: "left", padding: "8px 12px", cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" };
  const thR: React.CSSProperties = { ...th, textAlign: "right" };
  const td: React.CSSProperties = { padding: "8px 12px", color: C.text, borderBottom: `1px solid ${C.rowBdr}` };
  const tdR: React.CSSProperties = { ...td, textAlign: "right", fontFamily: "monospace" };
  // Store options across the invoice rows (#7). Wholesale rows carry no store, so
  // this is mostly Ecom vs blank, but it constrains whatever store data exists.
  const storeOptions = useMemo(() => [...new Set((data?.rows ?? []).map((r) => r.warehouse).filter((s): s is string => !!s))].sort(), [data]);
  // Apply store filter → collapse-on-invoice (optional) → sort.
  const invoiceRows = useMemo<SoldRow[]>(() => {
    let rows = (data?.rows ?? []).filter((r) => !store || (r.warehouse ?? "") === store);
    if (collapseInv) {
      const map = new Map<string, SoldRow & { _amt: number; _pq: number }>();
      for (const r of rows) {
        const key = r.invoice_number ?? `__${r.color ?? ""}`;
        let g = map.get(key);
        if (!g) { g = { ...r, color: null, qty: 0, _amt: 0, _pq: 0 }; map.set(key, g); }
        g.qty += num(r.qty);
        if (r.unit_price != null) { g._amt += num(r.unit_price) * num(r.qty); g._pq += num(r.qty); }
      }
      rows = [...map.values()].map(({ _amt, _pq, ...g }) => ({ ...g, unit_price: _pq > 0 ? +(_amt / _pq).toFixed(4) : null }));
    }
    return rowSort.sort(rows);
  }, [data, store, collapseInv, rowSort.key, rowSort.dir]); // eslint-disable-line react-hooks/exhaustive-deps
  const selStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, borderRadius: 4, padding: "4px 8px", fontSize: 12, colorScheme: "dark" };
  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div style={modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>Qty Sold — {row.style_code}{row.color ? ` · ${row.color}` : ""}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.textMuted, fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ marginBottom: 12 }}><DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} /></div>
        {loading ? <div style={{ color: C.textMuted, padding: 16 }}>Loading…</div> : err ? <div style={{ background: "#7f1d1d", color: "#fff", padding: 10, borderRadius: 6 }}>{err}</div> : data && (
          <>
            <div style={{ fontSize: 12, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, margin: "4px 0 6px" }}>Color totals</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 18 }}>
              <thead><tr>
                <th style={th} onClick={() => ctSort.onSort("color")}>Color{ctSort.arrow("color")}</th>
                <th style={thR} onClick={() => ctSort.onSort("qty")}>Qty Sold{ctSort.arrow("qty")}</th>
                <th style={thR} onClick={() => ctSort.onSort("avg_unit_price")}>Avg Unit Price{ctSort.arrow("avg_unit_price")}</th>
              </tr></thead>
              <tbody>
                {ctSort.sort(data.color_totals).map((c) => (
                  <tr key={c.color ?? ""}><td style={td}><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><ColorSwatch name={c.color} size={16} /> {c.color || "—"}</span></td><td style={tdR}>{fmtQty(c.qty)}</td><td style={tdR}>{money(c.avg_unit_price)}</td></tr>
                ))}
                <tr style={{ borderTop: `2px solid ${C.sectionBdr}` }}><td style={{ ...td, fontWeight: 700 }}>Total</td><td style={{ ...tdR, fontWeight: 800, color: C.amber }}>{fmtQty(data.grand_total)}</td><td style={tdR} /></tr>
              </tbody>
            </table>
            <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0 6px", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Invoices</span>
              {storeOptions.length > 0 && (
                <label style={{ fontSize: 11, color: C.textMuted, display: "inline-flex", alignItems: "center", gap: 4 }}>
                  Warehouse
                  <select value={store} onChange={(e) => setStore(e.target.value)} style={selStyle}>
                    <option value="">All</option>
                    {storeOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
              )}
              <button type="button" onClick={() => setCollapseInv((v) => !v)} title="Collapse the rows onto Invoice number"
                style={{ background: collapseInv ? C.primary : "transparent", color: collapseInv ? "#fff" : C.textSub, border: `1px solid ${collapseInv ? C.primary : C.cardBdr}`, borderRadius: 4, padding: "3px 10px", fontSize: 11, cursor: "pointer" }}>
                Collapse: Invoice {collapseInv ? "✓" : ""}
              </button>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr>
                <th style={th} onClick={() => rowSort.onSort("color")}>Color{rowSort.arrow("color")}</th>
                <th style={th} onClick={() => rowSort.onSort("warehouse")}>Warehouse{rowSort.arrow("warehouse")}</th>
                <th style={thR} onClick={() => rowSort.onSort("qty")}>Sold{rowSort.arrow("qty")}</th>
                <th style={th} onClick={() => rowSort.onSort("invoice_number")}>Invoice #{rowSort.arrow("invoice_number")}</th>
                <th style={th} onClick={() => rowSort.onSort("customer")}>Customer{rowSort.arrow("customer")}</th>
                <th style={thR} onClick={() => rowSort.onSort("unit_price")}>Unit Price{rowSort.arrow("unit_price")}</th>
                <th style={th} onClick={() => rowSort.onSort("date")}>Date{rowSort.arrow("date")}</th>
              </tr></thead>
              <tbody>
                {invoiceRows.map((r, i) => (
                  <tr key={i}>
                    <td style={td}>{collapseInv ? "—" : (r.color || "—")}</td>
                    <td style={td}>{r.warehouse || "—"}</td>
                    <td style={tdR}>{fmtQty(r.qty)}</td>
                    <td style={td}>{r.invoice_number ? (r.ar_invoice_id ? <span role="button" tabIndex={0} onClick={() => onOpenInvoice(r.ar_invoice_id!, r.invoice_number!, r.customer)} style={{ color: C.base, cursor: "pointer", textDecoration: "underline" }}>{r.invoice_number}</span> : r.invoice_number) : "—"}</td>
                    <td style={td}>{r.customer || "—"}</td>
                    <td style={tdR}>{money(r.unit_price)}</td>
                    <td style={td}>{r.date ? fmtDate(String(r.date).slice(0, 10)) : "—"}</td>
                  </tr>
                ))}
                {invoiceRows.length === 0 && <tr><td style={td} colSpan={7}>No invoices in this range{store ? ` for store ${store}` : ""}.</td></tr>}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

function PurchasedDetailModal({ row, headerFrom, headerTo, explodePpk, onClose, onOpenBill }: {
  row: SnapshotRow; headerFrom: string; headerTo: string; explodePpk: boolean; onClose: () => void;
  onOpenBill: (billId: string, ref: string, vendor: string | null) => void;
}) {
  const [from, setFrom] = useState(headerFrom);
  const [to, setTo] = useState(headerTo);
  const [data, setData] = useState<PurchasedDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Click a colour row to filter the receipts/bills list to just that colour.
  // null = show all. Stored as the colour string ("" for the null-colour row).
  const [pickedColor, setPickedColor] = useState<string | null>(null);
  const [collapseBill, setCollapseBill] = useState(false); // collapse rows on Bill # (#17)
  type PurchRow = PurchasedDetail["rows"][number];
  const ctSort = useColumnSort<PurchasedDetail["color_totals"][number]>("qty", "desc");
  const rowSort = useColumnSort<PurchRow>("bill_date", "desc");
  useEffect(() => {
    let cancelled = false; setLoading(true); setErr(null);
    const qs = new URLSearchParams({ style_id: row.style_id }); if (from) qs.set("from", from); if (to) qs.set("to", to);
    if (explodePpk) qs.set("explode_ppk", "true"); // explode the drilled detail too
    fetch(`/api/internal/inventory-purchased-detail?${qs}`).then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j) => { if (!cancelled) { setData(j); setPickedColor(null); } }).catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [row.style_id, from, to, explodePpk]);
  const th: React.CSSProperties = { ...thBase, textAlign: "left", padding: "8px 12px", cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" };
  const thR: React.CSSProperties = { ...th, textAlign: "right" };
  const td: React.CSSProperties = { padding: "8px 12px", color: C.text, borderBottom: `1px solid ${C.rowBdr}` };
  const tdR: React.CSSProperties = { ...td, textAlign: "right", fontFamily: "monospace" };
  // Zebra/fade: alternate row tint so long colour lists stay readable on scroll.
  const zebra = (i: number): React.CSSProperties => ({ background: i % 2 ? "rgba(148,163,184,0.06)" : "transparent" });
  // Apply colour filter → collapse-on-bill (optional) → sort.
  const billRows = useMemo<PurchRow[]>(() => {
    let rows = (data?.rows ?? []).filter((r) => pickedColor == null || (r.color ?? "") === pickedColor);
    if (collapseBill) {
      const map = new Map<string, PurchRow & { _amt: number; _pq: number }>();
      for (const r of rows) {
        // Key on the bill/ref; rows with no ref (bare receipts) collapse per type.
        const key = r.ref ?? `__${r.receipt_type}|${r.color ?? ""}`;
        let g = map.get(key);
        if (!g) { g = { ...r, color: null, qty: 0, _amt: 0, _pq: 0 }; map.set(key, g); }
        g.qty += num(r.qty);
        if (r.unit_price != null) { g._amt += num(r.unit_price) * num(r.qty); g._pq += num(r.qty); }
      }
      rows = [...map.values()].map(({ _amt, _pq, ...g }) => ({ ...g, unit_price: _pq > 0 ? +(_amt / _pq).toFixed(4) : null }));
    }
    return rowSort.sort(rows);
  }, [data, pickedColor, collapseBill, rowSort.key, rowSort.dir]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div style={modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>Purchased — {row.style_code}{row.color ? ` · ${row.color}` : ""}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.textMuted, fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ marginBottom: 12 }}><DateRange from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} /></div>
        {loading ? <div style={{ color: C.textMuted, padding: 16 }}>Loading…</div> : err ? <div style={{ background: "#7f1d1d", color: "#fff", padding: 10, borderRadius: 6 }}>{err}</div> : data && (
          <>
            <div style={{ fontSize: 12, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, margin: "4px 0 6px" }}>Color totals <span style={{ textTransform: "none", letterSpacing: 0, fontStyle: "italic" }}>— click a colour to filter the bills below</span></div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 18 }}>
              <thead><tr>
                <th style={th} onClick={() => ctSort.onSort("color")}>Color{ctSort.arrow("color")}</th>
                <th style={thR} onClick={() => ctSort.onSort("qty")}>Purchased{ctSort.arrow("qty")}</th>
              </tr></thead>
              <tbody>
                {ctSort.sort(data.color_totals).map((c, i) => {
                  const key = c.color ?? "";
                  const selected = pickedColor === key;
                  return (
                    <tr key={key}
                        onClick={() => setPickedColor((prev) => prev === key ? null : key)}
                        title={selected ? "Click to clear filter" : `Show only ${c.color || "—"} bills`}
                        style={{ cursor: "pointer", ...zebra(i), ...(selected ? { background: "rgba(59,130,246,0.22)", boxShadow: `inset 3px 0 0 ${C.primary}` } : null) }}>
                      <td style={td}><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><ColorSwatch name={c.color} size={16} /> {c.color || "—"}{selected ? " ✓" : ""}</span></td>
                      <td style={tdR}>{fmtQty(c.qty)}</td>
                    </tr>
                  );
                })}
                <tr style={{ borderTop: `2px solid ${C.sectionBdr}` }}><td style={{ ...td, fontWeight: 700 }}>Total</td><td style={{ ...tdR, fontWeight: 800, color: C.amber }}>{fmtQty(data.grand_total)}</td></tr>
              </tbody>
            </table>
            <div style={{ fontSize: 12, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, margin: "4px 0 6px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span>Receipts &amp; bills</span>
              <button type="button" onClick={() => setCollapseBill((v) => !v)} title="Collapse the rows onto Bill number"
                style={{ textTransform: "none", letterSpacing: 0, background: collapseBill ? C.primary : "transparent", color: collapseBill ? "#fff" : C.textSub, border: `1px solid ${collapseBill ? C.primary : C.cardBdr}`, borderRadius: 4, padding: "3px 10px", fontSize: 11, cursor: "pointer" }}>
                Collapse: Bill {collapseBill ? "✓" : ""}
              </button>
              {pickedColor != null && (
                <span style={{ textTransform: "none", letterSpacing: 0, color: C.textSub, display: "inline-flex", alignItems: "center", gap: 6 }}>
                  · filtered to <strong style={{ color: C.text }}>{pickedColor || "—"}</strong>
                  <button onClick={() => setPickedColor(null)} style={{ background: "transparent", color: C.base, border: `1px solid ${C.cardBdr}`, borderRadius: 4, padding: "1px 8px", fontSize: 11, cursor: "pointer" }}>Clear ✕</button>
                </span>
              )}
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr>
                <th style={th} onClick={() => rowSort.onSort("color")}>Color{rowSort.arrow("color")}</th>
                <th style={th} onClick={() => rowSort.onSort("vendor")}>Vendor{rowSort.arrow("vendor")}</th>
                <th style={thR} onClick={() => rowSort.onSort("qty")}>Purchased{rowSort.arrow("qty")}</th>
                <th style={thR} onClick={() => rowSort.onSort("unit_price")}>Unit Price{rowSort.arrow("unit_price")}</th>
                <th style={th} onClick={() => rowSort.onSort("ref")}>Ref #{rowSort.arrow("ref")}</th>
                <th style={th} onClick={() => rowSort.onSort("receipt_type")}>Type{rowSort.arrow("receipt_type")}</th>
                <th style={th} onClick={() => rowSort.onSort("receipt_date")}>Receipt Date{rowSort.arrow("receipt_date")}</th>
                <th style={th} onClick={() => rowSort.onSort("bill_date")}>Bill Date{rowSort.arrow("bill_date")}</th>
              </tr></thead>
              <tbody>
                {billRows.map((r, i) => (
                  <tr key={i} style={zebra(i)}>
                    <td style={td}>{collapseBill ? "—" : (r.color || "—")}</td>
                    <td style={td}>{r.vendor || "—"}</td>
                    <td style={tdR}>{fmtQty(r.qty)}</td>
                    <td style={tdR}>{money(r.unit_price)}</td>
                    <td style={td}>{r.ref ? (r.bill_id ? <span role="button" tabIndex={0} onClick={() => onOpenBill(r.bill_id!, r.ref!, r.vendor)} style={{ color: C.base, cursor: "pointer", textDecoration: "underline" }}>{r.ref}</span> : r.ref) : "—"}</td>
                    <td style={td}>{r.receipt_type}</td>
                    <td style={td}>{r.receipt_date ? fmtDate(String(r.receipt_date).slice(0, 10)) : "—"}</td>
                    <td style={td}>{r.bill_date ? fmtDate(String(r.bill_date).slice(0, 10)) : "—"}</td>
                  </tr>
                ))}
                {billRows.length === 0 && <tr><td style={td} colSpan={8}>{pickedColor != null ? "No bills for the selected colour in this range." : "No purchases in this range."}</td></tr>}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

// Full invoice / bill detail popup. `kind` picks AR vs AP. Customer/vendor name
// is passed in (the [id] endpoint returns only the uuid — no-UUID rule).
function DocDetailModal({ kind, id, number, party, onClose }: {
  kind: "ar" | "ap"; id: string; number: string; party: string | null; onClose: () => void;
}) {
  const [doc, setDoc] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false; setLoading(true); setErr(null);
    fetch(`/api/internal/${kind === "ar" ? "ar-invoices" : "ap-invoices"}/${id}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j) => { if (!cancelled) setDoc(j); }).catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [kind, id]);
  const editUrl = `?m=${kind === "ar" ? "ar_invoices" : "ap_invoices"}&q=${encodeURIComponent(number)}`;
  const lines = (doc?.lines as Record<string, unknown>[]) || [];
  const th: React.CSSProperties = { ...thBase, textAlign: "left", padding: "8px 12px" };
  const thR: React.CSSProperties = { ...th, textAlign: "right" };
  const td: React.CSSProperties = { padding: "8px 12px", color: C.text, borderBottom: `1px solid ${C.rowBdr}` };
  const tdR: React.CSSProperties = { ...td, textAlign: "right", fontFamily: "monospace" };
  const centsCol = kind === "ar" ? "unit_price_cents" : "unit_cost_cents";
  return (
    <div style={{ ...modalBackdrop, zIndex: 210 }} onClick={onClose}>
      <div style={{ ...modalCard, width: "min(820px, calc(100vw - var(--tng-nav-offset, 0px) - 40px))" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{kind === "ar" ? "Invoice" : "Bill"} {number}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => openTab(editUrl)} style={{ background: "transparent", color: C.primary, border: `1px solid ${C.primary}`, borderRadius: 6, padding: "5px 14px", fontSize: 13, cursor: "pointer" }}>✎ Edit (new tab)</button>
            <button onClick={onClose} style={{ background: "none", border: "none", color: C.textMuted, fontSize: 20, cursor: "pointer" }}>✕</button>
          </div>
        </div>
        {loading ? <div style={{ color: C.textMuted, padding: 16 }}>Loading…</div> : err ? <div style={{ background: "#7f1d1d", color: "#fff", padding: 10, borderRadius: 6 }}>{err}</div> : doc && (
          <>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 13, color: C.textSub, marginBottom: 14 }}>
              <div><span style={dl}>{kind === "ar" ? "Customer" : "Vendor"}</span><br />{party || "—"}</div>
              <div><span style={dl}>Date</span><br />{doc.invoice_date ? fmtDate(String(doc.invoice_date).slice(0, 10)) : "—"}</div>
              <div><span style={dl}>Status</span><br />{String(doc.gl_status ?? "—")}</div>
              <div><span style={dl}>Total</span><br />{doc.total_amount_cents != null ? `$${money(Number(doc.total_amount_cents) / 100)}` : "—"}</div>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr><th style={th}>#</th><th style={th}>Description</th><th style={thR}>Qty</th><th style={thR}>Unit</th><th style={thR}>Line Total</th></tr></thead>
              <tbody>
                {lines.map((l, i) => {
                  const qty = Number(l.quantity) || 0;
                  const unit = l[centsCol] != null ? Number(l[centsCol]) / 100 : null;
                  // Line shapes differ by table: AR (ar_invoice_lines) carries
                  // line_number + line_total_cents; AP (invoice_line_items) carries
                  // a 0-based line_index + line_total in DOLLARS. Read whichever is
                  // present so the bill popup doesn't blank out (paired with the
                  // handler's line_index order fix — the #16 bill 500).
                  const lineNo = l.line_number ?? (l.line_index != null ? Number(l.line_index) + 1 : i + 1);
                  const lineTotal = l.line_total_cents != null
                    ? Number(l.line_total_cents) / 100
                    : (l.line_total != null ? Number(l.line_total) : (unit != null ? unit * qty : null));
                  return (
                    <tr key={i}>
                      <td style={td}>{String(lineNo)}</td>
                      <td style={td}>{String(l.description ?? "—")}</td>
                      <td style={tdR}>{fmtQty(qty)}</td>
                      <td style={tdR}>{money(unit)}</td>
                      <td style={tdR}>{lineTotal != null ? `$${money(lineTotal)}` : "—"}</td>
                    </tr>
                  );
                })}
                {lines.length === 0 && <tr><td style={td} colSpan={5}>No lines.</td></tr>}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

// ── component ────────────────────────────────────────────────────────────────

export default function InternalInventoryMatrix() {
  const [styles, setStyles]     = useState<StyleListRow[]>([]);
  const [scales, setScales]     = useState<SizeScale[]>([]);
  const [brands, setBrands]     = useState<Brand[]>([]);
  const [brandId, setBrandId]   = useState<string>(""); // "" = all brands
  // Preselect a style from the URL (?style_id=…) — used by the Snapshot's
  // On-Hand drill, which opens this matrix in a new tab focused on one style.
  const [styleId, setStyleId]   = useState<string>(() => {
    try { return new URLSearchParams(window.location.search).get("style_id") || ""; } catch { return ""; }
  });
  // Default all-styles view = the Inventory Snapshot summary table; "matrix"
  // shows the stacked per-style size grids.
  const [noStyleView, setNoStyleView] = useState<"snapshot" | "matrix">("snapshot");
  const [snapRows, setSnapRows] = useState<SnapshotRow[]>([]);
  // Lots present across the snapshot's fetched styles (full set, filter-independent)
  // — feeds the lot dropdown in the all-styles snapshot view.
  const [snapLots, setSnapLots] = useState<string[]>([]);
  const [snapLoading, setSnapLoading] = useState(false);
  const [snapErr, setSnapErr] = useState<string | null>(null);
  const [snapSortKey, setSnapSortKey] = useState<SnapColKey>("style_code");
  const [snapSortDir, setSnapSortDir] = useState<"asc" | "desc">("asc");
  const onSnapSort = (k: SnapColKey) => {
    setSnapSortKey((prev) => { if (prev === k) { setSnapSortDir((d) => (d === "asc" ? "desc" : "asc")); return prev; } setSnapSortDir("asc"); return k; });
  };
  // Header date range — filters the Sold/Purchased columns AND seeds the drills.
  const [snapFrom, setSnapFrom] = useState("");
  const [snapTo, setSnapTo] = useState("");
  // Per-row thumbnails for the snapshot (style + colour matched).
  const snapThumbs = useStyleThumbs(snapRows.map((r) => r.style_id));
  // Open drill modals.
  const [soldFor, setSoldFor] = useState<SnapshotRow | null>(null);
  const [purchasedFor, setPurchasedFor] = useState<SnapshotRow | null>(null);
  const [docModal, setDocModal] = useState<{ kind: "ar" | "ap"; id: string; number: string; party: string | null } | null>(null);
  // Dynamic style search (mirrors Style Master): the matrix loads ALL styles on
  // open and this debounced text filters the multi-style view live (e.g. "ppk"
  // → every PPK style). Replaces the old style-picker dropdown.
  const { value: styleSearch, debouncedValue: styleSearchDeb, setValue: setStyleSearch } = useDebouncedSearch("", 200);
  const [payload, setPayload]   = useState<MatrixPayload | null>(null);
  // On-Hand is the only metric. The old "Available" toggle was replaced by an
  // ATS app link (see the Show/ATS controls below).
  const [warehouse, setWarehouse] = useState<string>(ALL_WAREHOUSES); // ALL_WAREHOUSES = sum everything
  // Lot filter (single-style view): [] = all lots (whole-style on-hand). When one
  // or more lots are picked, the fetch re-scopes on-hand to just those lots. The
  // option list comes from payload.lots (always the full set). Reset on style change.
  const [lotFilter, setLotFilter] = useState<string[]>([]);
  // Global warehouse names (inventory_locations kind='warehouse') — these match
  // the keys in each SKU's on_hand_by_wh map, so the dropdown works even in the
  // multi-style view where no single-style payload (with its own list) exists.
  const [allWarehouses, setAllWarehouses] = useState<string[]>([]);
  const [hideZeros, setHideZeros] = useState(true); // default: hide zero-total color rows
  // Hide sizes (matrix view): drop ALL per-size columns, leaving the non-size
  // columns (Color / Total / Avg Cost / Total Cost / Last Received). Off by default.
  const [hideSizes, setHideSizes] = useState(false);
  // Empty-size-column collapse (single-style matrix) — mirrors the SO/PO grid:
  // once any size column has stock, the first VISIBLE size header turns green +
  // clickable and hides the all-zero leading/trailing size columns.
  const [sizesCollapsed, setSizesCollapsed] = useState(false);
  // Same collapse, but per-STYLE-BLOCK for the multi-style (brand-level) view —
  // each block owns its own collapsed flag (keyed by style id) so one style's
  // green-header click doesn't collapse every other block. Same SO behavior.
  const [blockCollapsed, setBlockCollapsed] = useState<Set<string>>(new Set());
  const toggleBlockCollapsed = (id: string) =>
    setBlockCollapsed((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // Snapshot column show/hide — lifted up from SnapshotView so the control can
  // live in the filter header row (next to Warehouse). Persisted per browser.
  const [snapHidden, setSnapHidden] = useState<Set<string>>(() => {
    try { const v = JSON.parse(sessionStorage.getItem(SNAP_HIDE_KEY) || "[]"); return new Set(Array.isArray(v) ? v : []); } catch { return new Set(); }
  });
  const [snapColsOpen, setSnapColsOpen] = useState(false);
  const toggleSnapCol = (k: string) => setSnapHidden((prev) => {
    const next = new Set(prev); if (next.has(k)) next.delete(k); else next.add(k);
    try { sessionStorage.setItem(SNAP_HIDE_KEY, JSON.stringify([...next])); } catch { /* noop */ }
    return next;
  });
  const snapShow = (k: string) => !snapHidden.has(k);
  // Collapse: which text column(s) to collapse ONTO — the checked dims become
  // the group-by key, all other text columns merge away, numerics sum.
  // Independent of column show/hide.
  const [snapCollapse, setSnapCollapse] = useState<Set<string>>(new Set());
  const [snapCollapseOpen, setSnapCollapseOpen] = useState(false);
  const toggleSnapCollapse = (k: string) => setSnapCollapse((prev) => {
    const next = new Set(prev); if (next.has(k)) next.delete(k); else next.add(k); return next;
  });
  const [riseFilter, setRiseFilter] = useState<string[]>([]); // [] = all
  // off by default; folds PPK packs → sized eaches. Honors ?explode_ppk in the
  // URL so the Snapshot's On-Hand drill (which appends it) opens already exploded.
  const [explodePpk, setExplodePpk] = useState(() => {
    try { return new URLSearchParams(window.location.search).get("explode_ppk") === "true"; } catch { return false; }
  });
  // Merge PPK: collapse each base style + its PPK sibling into one "BASE/PPK"
  // row (snapshot only). Requires exploded eaches, so selecting it forces Explode on.
  const [mergePpk, setMergePpk] = useState(false);
  // Totals strip (snapshot only), modelled on the ATS totals view: a single
  // toggle that shows a strip above the column headers stacking, for each
  // quantity column, Qty (unit counts) + $ Cost (qty × avg cost) + $ Wholesale
  // (qty × avg wholesale SO sale price) + Avg Cost + Avg Sale — all together, no
  // mode choice. When the page has a PPK style this auto-forces per-unit explode
  // (see effectiveExplodePpk) so the $ values reconcile.
  const [snapTotals, setSnapTotals] = useState(false);
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
  // Batch-fetch per-color thumbnails for every style in the all-styles view.
  const brandThumbs = useStyleThumbs(brandPayloads.map((b) => b.style.id));
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
    const lotQs = lotFilter.length ? `&lots=${lotFilter.map((l) => encodeURIComponent(l)).join(",")}` : "";
    const url = `/api/internal/style-matrix?style_id=${encodeURIComponent(styleId)}${explodePpk ? "&explode_ppk=true" : ""}${lotQs}`;
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
  }, [styleId, explodePpk, lotFilter]);


  // Reset rise + warehouse + inseam-mode filters on a STYLE change only (not on
  // explode toggle). Inseam mode resets so a new style opens on its plain color
  // matrix; the toggle reappears only if the new style's scale has inseams.
  useEffect(() => {
    setRiseFilter([]);
    setWarehouse(ALL_WAREHOUSES);
    setInseamMode(false);
    setLotFilter([]);
  }, [styleId]);

  // Fetch per-color thumbnail images for the active style from the PIM endpoint.
  // Build a Map<color_lowercase, thumbUrl> so each color row can show its image.
  useEffect(() => {
    setStyleImages(new Map());
    if (!styleId) return;
    fetch(`/api/internal/pim/styles/${encodeURIComponent(styleId)}/images`)
      .then((r) => (r.ok ? r.json() : []))
      // The PIM images endpoint returns `signed_urls` (snake_case) with renderable
      // thumb/web URLs. (storage_path_thumb is a bucket-relative path, NOT a URL —
      // never usable as an <img src>.) Shopify-pulled images are style-level
      // (color = null) → they land under "__default__", and the per-color rows
      // fall back to it, so the whole style shows its product image.
      .then((imgs: Array<{color?: string | null; signed_urls?: {thumb?: string; web?: string} | null}>) => {
        const m = new Map<string, string>();
        for (const img of (Array.isArray(imgs) ? imgs : [])) {
          const key = (img.color || "").toLowerCase().trim() || "__default__";
          const url = img.signed_urls?.thumb || img.signed_urls?.web || "";
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
  // CASCADING filter options (#9): each dropdown only offers values that exist
  // among the styles matching ALL the OTHER active filters (search text + the
  // sibling dropdowns), so the filters narrow each other reciprocally. `except`
  // is the dimension being computed (so it doesn't constrain its own options).
  const matchesExcept = useMemo(() => {
    const q = styleSearchDeb.trim().toLowerCase();
    return (s: StyleListRow, except: "gender" | "group" | "category" | "sub") => {
      if (except !== "gender" && genderFilter && s.gender_code !== genderFilter) return false;
      if (except !== "group" && groupFilter && s.group_name !== groupFilter) return false;
      if (except !== "category" && categoryFilter && s.category_name !== categoryFilter) return false;
      if (except !== "sub" && subCategoryFilter && s.sub_category_name !== subCategoryFilter) return false;
      if (q) {
        const hay = [s.style_code, s.style_name, s.description, s.group_name, s.category_name, s.sub_category_name]
          .filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    };
  }, [styleSearchDeb, genderFilter, groupFilter, categoryFilter, subCategoryFilter]);

  const genderOptions = useMemo<string[]>(
    () => [...new Set(brandScopedStyles.filter((s) => matchesExcept(s, "gender")).map((s) => s.gender_code).filter((g): g is string => !!g))]
      .sort((a, b) => (GENDER_LABELS[a] || a).localeCompare(GENDER_LABELS[b] || b)),
    [brandScopedStyles, matchesExcept],
  );
  const groupOptions = useMemo<string[]>(
    () => [...new Set(brandScopedStyles.filter((s) => matchesExcept(s, "group")).map((s) => s.group_name).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b)),
    [brandScopedStyles, matchesExcept],
  );
  const categoryOptions = useMemo<string[]>(
    () => [...new Set(brandScopedStyles.filter((s) => matchesExcept(s, "category")).map((s) => s.category_name).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b)),
    [brandScopedStyles, matchesExcept],
  );
  const subCategoryOptions = useMemo<string[]>(
    () => [...new Set(brandScopedStyles.filter((s) => matchesExcept(s, "sub")).map((s) => s.sub_category_name).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b)),
    [brandScopedStyles, matchesExcept],
  );

  // Reset sub-category when category changes.
  useEffect(() => { setSubCategoryFilter(""); }, [categoryFilter]);

  // Reset to page 0 whenever the style list scope changes (brand/filter change).
  useEffect(() => { setMultiPage(0); }, [brandStyles]);

  // The style ids on the current page (shared by the matrices fetch + snapshot).
  const pageStyleIds = useMemo(
    () => brandStyles.slice(multiPage * MULTI_PAGE_SIZE, multiPage * MULTI_PAGE_SIZE + MULTI_PAGE_SIZE).map((s) => s.id),
    [brandStyles, multiPage],
  );

  // Collapse (#13) aggregates across the FULL filtered set, not just the visible
  // page — exactly like Export. When ANY Collapse column is checked, the snapshot
  // fetches every filtered style (capped) so the roll-up sums all of them; the
  // pager is hidden in that mode. A safety cap keeps a giant "all styles" collapse
  // from posting tens of thousands of ids.
  const SNAP_ALL_CAP = 4000;
  const collapseActive = snapCollapse.size > 0;
  const snapStyleIds = useMemo(
    () => (collapseActive ? brandStyles.slice(0, SNAP_ALL_CAP).map((s) => s.id) : pageStyleIds),
    [collapseActive, brandStyles, pageStyleIds],
  );

  // Does the snapshot's fetched set include ANY PPK (prepack) style? PPK grain
  // rule is canonical: a style is a pack iff /PPK/i.test(style_code) (NOT
  // size/pack_size). Used to FORCE per-unit explode when Totals is on — a PPK
  // row's qty (packs) × pack avg-cost/price is meaningless as a $ total; the
  // explode converts both to per-each so $ Cost / $ Wholesale reconcile. (#11)
  const pageHasPpk = useMemo(() => {
    const set = new Set(snapStyleIds);
    return brandStyles.some((s) => set.has(s.id) && /ppk/i.test(s.style_code || ""));
  }, [brandStyles, snapStyleIds]);

  // Effective explode flag for the snapshot: the operator's Explode toggle, OR a
  // forced explode when Totals is showing AND the page contains a PPK style (so
  // the Totals strip's $ values are per-unit, not pack × pack-price). Merge PPK
  // also implies explode (it folds packs into eaches). (#11)
  const effectiveExplodePpk = explodePpk || mergePpk || (snapTotals && pageHasPpk);
  // Explode is LOCKED on (can't be unclicked) whenever something else requires
  // it: Merge PPK (needs eaches) or Totals over a page with a PPK style (the $
  // totals only reconcile at unit grain). The Explode button reflects this.
  const explodeLocked = mergePpk || (snapTotals && pageHasPpk);

  // Snapshot view (default all-styles): fetch the aggregate rows for the visible
  // page — or, when Collapse is active, the full filtered set (#13).
  const snapFetchKey = snapStyleIds.join(",");
  useEffect(() => {
    if (styleId || noStyleView !== "snapshot") { setSnapRows([]); setSnapLots([]); setSnapErr(null); return; }
    if (snapStyleIds.length === 0) { setSnapRows([]); setSnapLots([]); setSnapErr(null); return; }
    let cancelled = false;
    setSnapLoading(true); setSnapErr(null);
    fetch("/api/internal/inventory-snapshot", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ style_ids: snapStyleIds, from: snapFrom || undefined, to: snapTo || undefined, explode_ppk: effectiveExplodePpk || undefined, warehouse: warehouse !== ALL_WAREHOUSES ? warehouse : undefined, lots: lotFilter.length ? lotFilter : undefined }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => { if (!cancelled) { setSnapRows(Array.isArray(j.rows) ? j.rows : []); setSnapLots(Array.isArray(j.lots) ? j.lots : []); } })
      .catch((e) => { if (!cancelled) setSnapErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setSnapLoading(false); });
    return () => { cancelled = true; };
  }, [styleId, noStyleView, snapFetchKey, snapFrom, snapTo, effectiveExplodePpk, warehouse, lotFilter]); // eslint-disable-line react-hooks/exhaustive-deps

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
          const lotQs = lotFilter.length ? `&lots=${lotFilter.map((l) => encodeURIComponent(l)).join(",")}` : "";
          const r = await fetch(`/api/internal/style-matrix?style_id=${encodeURIComponent(s.id)}${explodePpk ? "&explode_ppk=true" : ""}${lotQs}`, { signal: controller.signal });
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
  }, [styleId, brandStyles, multiPage, explodePpk, lotFilter]);

  // Lot numbers available for the current view, feeding the Lot # filter:
  //  • single style → the payload's full lot list
  //  • all-styles Snapshot → lots across the fetched snapshot styles
  //  • all-styles Matrix → union of every loaded per-style payload's lots
  // Always the FULL set (filter-independent) so the dropdown stays selectable.
  const availableLots = useMemo<string[]>(() => {
    if (styleId) return payload?.lots ?? [];
    if (noStyleView === "snapshot") return snapLots;
    const set = new Set<string>();
    let hasNoLot = false;
    for (const { payload: bp } of brandPayloads) {
      for (const l of (bp.lots ?? [])) { if (l === NO_LOT_LABEL) hasNoLot = true; else set.add(l); }
    }
    const out = [...set].sort((a, b) => a.localeCompare(b));
    if (hasNoLot) out.push(NO_LOT_LABEL);
    return out;
  }, [styleId, payload, noStyleView, snapLots, brandPayloads]);

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
  // the matrix doesn't show a style that's hidden from the picker. Guarded on the
  // style list being loaded so a URL-preselected style (?style_id=, from the
  // Snapshot On-Hand drill) isn't wiped during the initial empty-load window.
  useEffect(() => {
    if (styles.length > 0 && styleId && !brandStyles.some((s) => s.id === styleId)) setStyleId("");
  }, [styles.length, brandStyles, styleId]);

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

  // Warehouse dropdown options — "All Warehouses" + every warehouse name.
  const warehouseDropdownOptions = useMemo<SearchableSelectOption[]>(
    () => [
      { value: ALL_WAREHOUSES, label: "All Warehouses", searchHaystack: "all warehouses stores" },
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

  // Empty-size-column collapse for the single-style matrix — the SAME model the
  // SO/PO grid uses (computeSizeCollapse). Once any size column has stock the
  // first VISIBLE size header turns green + is clickable to hide the all-zero
  // leading/trailing size columns. `renderSizes` is the size axis actually drawn:
  // empty when "Hide sizes" is on, else the collapsed range.
  const sizeCollapse = useMemo(
    () => computeSizeCollapse(sizeOrder, colTotals, { enabled: true, collapsed: sizesCollapsed }),
    [sizeOrder, colTotals, sizesCollapsed],
  );
  const renderSizes = hideSizes ? [] : sizeCollapse.visibleSizes;

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

  // Brand / all-styles export — flat rows across every loaded style. Each style
  // may have a different size scale, so the size columns are the union of all
  // scales' sizes (first-seen order). Non-inseam matrix grain, honoring the
  // warehouse + hide-zeros filters, mirroring the on-screen brand blocks.
  const brandExportColumns = useMemo<ExportColumn<Record<string, unknown>>[]>(() => {
    const sizeKeys: string[] = [];
    for (const { payload: bp } of brandPayloads) {
      const order = bp.sizes.length
        ? bp.sizes
        : bp.skus.reduce<string[]>((acc, sk) => { if (sk.size && !acc.includes(sk.size)) acc.push(sk.size); return acc; }, []);
      for (const sz of order) if (!sizeKeys.includes(sz)) sizeKeys.push(sz);
    }
    const cols: ExportColumn<Record<string, unknown>>[] = [
      { key: "style_code", header: "Style" },
      { key: "style_name", header: "Style Name" },
      { key: "color", header: "Color" },
    ];
    for (const sz of sizeKeys) cols.push({ key: `size_${sz}`, header: sz, format: "number" });
    cols.push({ key: "total_qty", header: "Total", format: "number" });
    cols.push({ key: "avg_cost_cents", header: "Avg Cost", format: "currency_cents" });
    cols.push({ key: "total_cost_cents", header: "Total Cost", format: "currency_cents" });
    cols.push({ key: "last_received", header: "Last Received", format: "date" });
    return cols;
  }, [brandPayloads]);

  const brandExportRows = useMemo<Array<Record<string, unknown>>>(() => {
    const out: Array<Record<string, unknown>> = [];
    for (const { style: bStyle, payload: bp } of brandPayloads) {
      const bSkuQty = (s: MatrixSku) =>
        warehouse !== ALL_WAREHOUSES ? num((s.on_hand_by_wh || {})[warehouse]) : num(s.on_hand_qty);
      const bCellQty = (c: ExplodeCell) =>
        warehouse !== ALL_WAREHOUSES ? num((c.by_wh || {})[warehouse]) : num(c.qty);
      const bShowRise = (bp.rises ?? []).length > 1;
      const bRows = buildMatrixRows(bp, [], bShowRise, bSkuQty, bCellQty, false)
        .filter((r) => !hideZeros || r.totalQty !== 0);
      for (const r of bRows) {
        const row: Record<string, unknown> = {
          style_code: bStyle.style_code,
          style_name: bStyle.style_name ?? "",
          color: r.color,
        };
        for (const [sz, q] of Object.entries(r.sizes)) row[`size_${sz}`] = q || 0;
        row.total_qty = r.totalQty;
        row.avg_cost_cents = r.avgCostCents == null ? "" : r.avgCostCents;
        row.total_cost_cents = r.totalCostCents;
        row.last_received = r.lastReceived ?? "";
        out.push(row);
      }
    }
    return out;
  }, [brandPayloads, warehouse, hideZeros]);

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

  // Snapshot rows after the Hide-Zeros toggle (drops on-hand-0 rows, matching the
  // matrices' behavior). The fetched set is already scoped to the active filters
  // (brand/search/gender/group/category/sub-category) via pageStyleIds, so this
  // is the same set shown — both the table AND the export read it.
  // Hide-Zeros for the Snapshot: a row is hidden ONLY when it is zero across
  // EVERY quantity column. If any column is populated (e.g. a PPK style with
  // 0 on-hand but sales/PO/ATS activity — on-hand lives on the BASE style) the
  // row stays. (Earlier this filtered on on_hand alone, which wrongly dropped
  // all PPK styles.)
  const snapVisibleRows = useMemo<SnapshotRow[]>(
    () => (hideZeros
      ? snapRows.filter((r) =>
          num(r.on_hand) !== 0 || num(r.allocated) !== 0 || num(r.on_so) !== 0 ||
          num(r.ats) !== 0 || num(r.on_po) !== 0 || num(r.ats_incl_po) !== 0 ||
          num(r.sold) !== 0 || num(r.purchased) !== 0 || num(r.in_transit) !== 0)
      : snapRows),
    [snapRows, hideZeros],
  );

  // Snapshot export — every visible (filtered) row, honoring the column show/hide
  // selection so the sheet matches the on-screen table.
  const snapExportColumns = useMemo<ExportColumn<Record<string, unknown>>[]>(
    () => SNAP_COLS.filter((c) => snapShow(c.key as string)).map((c) => ({
      key: c.key as string,
      header: c.label,
      format: c.key === "avg_margin_pct" ? "percent"
        : (c.key === "avg_cost_cents" || c.key === "sale_price_cents") ? "currency_cents"
        : (c.numeric ? "number" : undefined),
      ...(c.key === "avg_margin_pct" ? { digits: 2 } : {}),
    })),
    [snapHidden],
  );
  // Export mirrors EXACTLY what's on screen: run the same Merge-PPK + Collapse
  // roll-up the table uses, so a collapsed/merged view exports collapsed/merged.
  // When the Totals strip is on, append its Totals row(s) to the bottom of the
  // sheet (#23) — one row per measure (Qty / $ Cost / $ Wholesale / Avg Cost /
  // Avg Sale), each carrying that measure's value in the summed quantity columns,
  // matching the on-screen strip. avg_cost_cents/sale_price_cents export as
  // currency_cents, so the $-measure rows store cents in those two columns.
  const snapExportRows = useMemo<Array<Record<string, unknown>>>(
    () => {
      const data = rollupSnapshot(snapVisibleRows, mergePpk, snapCollapse).map((r) => {
        // Derived Avg Mrgn % column — percent units (e.g. 42.15), blank when no
        // margin; matches the on-screen column's percent format (2 decimals).
        const m = marginFrac(r.sale_price_cents, r.avg_cost_cents);
        return { ...r, avg_margin_pct: m == null ? "" : +(m * 100).toFixed(2) };
      });
      if (!snapTotals || data.length === 0) return data;
      const qty: Record<string, number> = {};
      const cost: Record<string, number> = {};
      const whol: Record<string, number> = {};
      const cQty: Record<string, number> = {}; // qty of rows with a cost
      const pQty: Record<string, number> = {}; // qty of rows with a price (per column)
      for (const k of SNAP_SUM_COLS) { qty[k] = 0; cost[k] = 0; whol[k] = 0; cQty[k] = 0; pQty[k] = 0; }
      for (const r of data) {
        for (const k of SNAP_SUM_COLS) {
          const v = num((r as unknown as Record<string, number>)[k]);
          qty[k] += v;
          // Same per-column cost/price basis as the on-screen totals strip so
          // the workbook and the screen agree exactly (On PO / In Trnst costed
          // at the open-PO unit cost; inventory columns priced at the qty-
          // weighted avg SO price).
          const cc = colCostCents(r as MergedRow, k);
          if (cc != null) { cost[k] += v * (cc / 100); cQty[k] += v; }
          const pc = colPriceCents(r as MergedRow, k);
          if (pc != null) { whol[k] += v * (pc / 100); pQty[k] += v; }
        }
      }
      const mkRow = (label: string, valOf: (k: string) => number): Record<string, unknown> => {
        const row: Record<string, unknown> = { style_code: label };
        for (const k of SNAP_SUM_COLS) row[k] = valOf(k);
        return row;
      };
      return [
        ...data,
        mkRow("TOTAL — Qty", (k) => qty[k]),
        mkRow("TOTAL — $ Cost", (k) => Math.round(cost[k])),
        mkRow("TOTAL — $ Wholesale", (k) => Math.round(whol[k])),
        mkRow("AVG — Cost / unit", (k) => (cQty[k] > 0 ? +(cost[k] / cQty[k]).toFixed(2) : 0)),
        mkRow("AVG — Margin %", (k) => {
          const s = pQty[k] > 0 ? whol[k] / pQty[k] : 0;
          const c = cQty[k] > 0 ? cost[k] / cQty[k] : 0;
          return s > 0 ? +(((s - c) / s) * 100).toFixed(2) : 0;
        }),
        mkRow("AVG — Sale / unit", (k) => (pQty[k] > 0 ? +(whol[k] / pQty[k]).toFixed(2) : 0)),
      ];
    },
    [snapVisibleRows, mergePpk, snapCollapse, snapTotals],
  );

  // Multi-style pagination (shared by both no-style views) — computed here so the
  // single consolidated controls row can render the "Styles X–Y of N" count and
  // the Prev/Next pager inline (instead of a separate bar above the table).
  const hdrTotalStyles = brandStyles.length;
  const hdrTotalPages = Math.max(1, Math.ceil(hdrTotalStyles / MULTI_PAGE_SIZE));
  const hdrPageStart = hdrTotalStyles === 0 ? 0 : multiPage * MULTI_PAGE_SIZE + 1;
  const hdrPageEnd = Math.min((multiPage + 1) * MULTI_PAGE_SIZE, hdrTotalStyles);
  const pagBtn: React.CSSProperties = { background: "none", border: `1px solid ${C.cardBdr}`, borderRadius: 4, padding: "4px 12px", fontSize: 13, color: C.text };

  return (
    <div style={{ color: C.text, marginTop: 0 }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Inventory Matrix</h2>
        {payload && (
          <div style={{ fontSize: 11, color: C.textMuted }}>
            {payload.skus.length} SKU{payload.skus.length === 1 ? "" : "s"}
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={{ marginBottom: 54, display: "flex", flexDirection: "column", gap: 10 }}>

        {/* Row 1 — filter dropdowns + the Columns control (right of Warehouse).
            Fields are kept compact so the whole row fits on one line. */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, minWidth: 150 }}>
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

          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, minWidth: 200 }}>
            Search styles
            <input
              type="text"
              value={styleSearch}
              onChange={(e) => { setStyleSearch(e.target.value); if (styleId) setStyleId(""); }}
              placeholder="Type to filter — e.g. PPK, code, name…"
              style={{ ...inputStyle, minWidth: 200 }}
            />
          </label>

          {genderDropdownOptions.length > 1 && (
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, minWidth: 90 }}>
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
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, minWidth: 85 }}>
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
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, minWidth: 90 }}>
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
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, minWidth: 125 }}>
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

          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, minWidth: 100 }}>
            Warehouse
            <SearchableSelect
              value={warehouse}
              onChange={(v) => setWarehouse(!v ? ALL_WAREHOUSES : v)}
              options={warehouseDropdownOptions}
              placeholder="Search warehouse…"
              inputStyle={inputStyle}
            />
          </label>

          {/* Lot filter — single style OR the all-styles views (snapshot / matrix).
              A style/color received at different times carries multiple lot
              numbers; pick any combination to scope the On Hand to those lots
              (empty = all lots). The option list is the full set of lots present
              on the current styles' on-hand, so it spans base + PPK styles too. */}
          {availableLots.length > 0 && (
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, minWidth: 140 }}>
              Lot #
              <MultiSelectDropdown
                selected={lotFilter}
                onChange={setLotFilter}
                options={availableLots.map((l) => ({ value: l, label: l }))}
                allLabel="All lots"
                placeholder="Search lot…"
                title="Show on-hand from one or more lots (empty = all lots)"
                minWidth={180}
              />
            </label>
          )}

          {/* Column show/hide — sits at the end of Row 1, right of Warehouse.
              Only meaningful on the all-styles Snapshot view. */}
          {!styleId && noStyleView === "snapshot" && (
            <div style={{ position: "relative", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}
                 onMouseLeave={() => setSnapColsOpen(false)}>
              <button type="button" onClick={() => setSnapColsOpen((o) => !o)}
                style={{ background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                Columns {snapColsOpen ? "▴" : "▾"}
              </button>
              {snapColsOpen && (
                <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, zIndex: 30, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.5)", minWidth: 200, maxHeight: 340, overflowY: "auto" }}>
                  {[{ key: "image", label: "Image" }, ...SNAP_COLS].map((col) => (
                    <label key={col.key as string} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 2px", fontSize: 13, color: C.text, cursor: "pointer" }}>
                      <input type="checkbox" checked={snapShow(col.key as string)} onChange={() => toggleSnapCol(col.key as string)} />
                      {col.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Collapse — choose which text column(s) to collapse ONTO (group by; rest summed). */}
          {!styleId && noStyleView === "snapshot" && (
            <div style={{ position: "relative", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}
                 onMouseLeave={() => setSnapCollapseOpen(false)}>
              <button type="button" onClick={() => setSnapCollapseOpen((o) => !o)}
                style={{ background: snapCollapse.size ? C.primary : C.card, color: snapCollapse.size ? "#fff" : C.textSub, border: `1px solid ${snapCollapse.size ? C.primary : C.cardBdr}`, borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                Collapse {snapCollapseOpen ? "▴" : "▾"}
              </button>
              {snapCollapseOpen && (
                <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, zIndex: 30, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.5)", minWidth: 180 }}>
                  <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6 }}>Collapse onto:</div>
                  {[{ key: "style_code", label: "Style" }, { key: "category", label: "Item Category" }].map((c) => (
                    <label key={c.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 2px", fontSize: 13, color: C.text, cursor: "pointer" }}>
                      <input type="checkbox" checked={snapCollapse.has(c.key)} onChange={() => toggleSnapCollapse(c.key)} />
                      {c.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Row 2 — ONE control row: view switch · presets+dates · Hide Zeros ·
            Explode · Export · count + pager. Same left origin + gap as Row 1 so
            the two rows read as aligned "bubble" rows. */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {/* All-styles view switch (no single style picked). */}
          {!styleId && (
            <div style={{ display: "inline-flex", gap: 6 }}>
              {([["snapshot", "Inventory Snapshot"], ["matrix", "OH matrices"]] as const).map(([v, label]) => (
                <button key={v} type="button" onClick={() => setNoStyleView(v)}
                  style={{ background: noStyleView === v ? C.primary : C.card, color: noStyleView === v ? "#fff" : C.textMuted,
                    border: `1px solid ${noStyleView === v ? C.primary : C.cardBdr}`, padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* Presets + From/To date range — Snapshot view (filters Sold/Purchased + seeds drills). */}
          {!styleId && noStyleView === "snapshot" && (
            <DateRange from={snapFrom} to={snapTo} onChange={(f, t) => { setSnapFrom(f); setSnapTo(t); }} />
          )}

          {/* Hide Zeros toggle — blue = active (zeros hidden). */}
          <button type="button" title="Hide rows that are zero across every column"
            style={{ background: hideZeros ? C.primary : C.card, color: hideZeros ? "#fff" : C.textMuted, border: `1px solid ${hideZeros ? C.primary : C.cardBdr}`, padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600, transition: "all 0.15s" }}
            onClick={() => setHideZeros((v) => !v)}>Hide 0s</button>

          {/* Explode PPK toggle — blue = active. LOCKED on (darker blue + not-allowed
              cursor + explanatory tooltip + no-op click) whenever it's required:
              Merge PPK (needs eaches) OR Totals over a PPK page ($ totals reconcile
              only at unit grain). Unlocks when that driver is switched off. */}
          <button type="button"
            aria-disabled={explodeLocked}
            title={explodeLocked
              ? (mergePpk
                  ? "Explode stays on while Merge PPK is selected — merging a base style with its PPK sibling needs unit-grain eaches. Turn off Merge PPK to change this."
                  : "Explode stays on while Totals is selected — the $ totals reconcile only at unit grain (a pack of 24 must read per-unit). Turn off Totals to change this.")
              : "Convert PPK packs into sized eaches using the Prepack Matrix master"}
            style={{ background: explodeLocked ? "#1D4ED8" : (explodePpk ? C.primary : C.card), color: (explodeLocked || explodePpk) ? "#fff" : C.textMuted, border: `1px solid ${explodeLocked ? "#1D4ED8" : (explodePpk ? C.primary : C.cardBdr)}`, padding: "6px 14px", borderRadius: 6, cursor: explodeLocked ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600, transition: "all 0.15s" }}
            onClick={() => { if (explodeLocked) return; setExplodePpk((v) => !v); }}>Explode</button>

          {/* Merge PPK — snapshot only. Collapse each base style + its PPK
              sibling into one "BASE/PPK" row; forces Explode on (needs eaches). */}
          {!styleId && noStyleView === "snapshot" && (
            <button type="button" title="Merge each base style with its PPK sibling into one BASE/PPK row (auto-enables Explode)"
              style={{ background: mergePpk ? C.primary : C.card, color: mergePpk ? "#fff" : C.textMuted, border: `1px solid ${mergePpk ? C.primary : C.cardBdr}`, padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600, transition: "all 0.15s" }}
              onClick={() => setMergePpk((v) => { const next = !v; if (next) setExplodePpk(true); return next; })}>Merge PPK</button>
          )}

          {/* Totals — snapshot only. Single toggle: a totals strip above the
              column headers stacks Qty + $ Cost + $ Wholesale + Avg Cost +
              Avg Sale for every quantity column (no mode choice — all shown). */}
          {!styleId && noStyleView === "snapshot" && (
            <button type="button" title="Totals strip above the headers — Qty + $ Cost (qty × avg cost) + $ Wholesale (qty × avg wholesale SO price) + Avg Cost + Avg Sale per unit"
              style={{ background: snapTotals ? C.primary : C.card, color: snapTotals ? "#fff" : C.textMuted, border: `1px solid ${snapTotals ? C.primary : C.cardBdr}`, padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600, transition: "all 0.15s" }}
              onClick={() => setSnapTotals((v) => !v)}>Totals</button>
          )}

          {/* Hide sizes — matrix views only. Drops every per-size column, leaving
              the non-size columns (Color / Total / Avg Cost / Total Cost / Last
              Received). Blue = active. */}
          {((styleId && viewMode === "matrix") || (!styleId && noStyleView === "matrix")) && (
            <button type="button" title="Hide all per-size columns; keep totals and the non-size columns"
              style={{ background: hideSizes ? C.primary : C.card, color: hideSizes ? "#fff" : C.textMuted, border: `1px solid ${hideSizes ? C.primary : C.cardBdr}`, padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600, transition: "all 0.15s" }}
              onClick={() => setHideSizes((v) => !v)}>Hide sizes</button>
          )}

          {/* By Inseam — single-style matrix tab, or the all-styles "OH matrices"
              view (NOT the Snapshot view). */}
          {((styleId && viewMode === "matrix" && styleHasInseams) || (!styleId && noStyleView === "matrix" && anyBrandInseams)) && (
            <button type="button" title="Split each color into one row per inseam, with a per-color subtotal"
              style={{ background: inseamMode ? C.primary : C.card, color: inseamMode ? "#fff" : C.textMuted, border: `1px solid ${inseamMode ? C.primary : C.cardBdr}`, padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600, transition: "all 0.15s" }}
              onClick={() => setInseamMode((v) => !v)}>By Inseam</button>
          )}

          {/* Export — Snapshot view. */}
          {!styleId && noStyleView === "snapshot" && (
            <ExportButton rows={snapExportRows} filename={`inventory-snapshot-${brandId ? "brand" : "all-styles"}`} sheetName="Inventory Snapshot" columns={snapExportColumns} />
          )}
          {/* Export — single-style matrix. */}
          {payload && viewMode === "matrix" && (
            <ExportButton rows={exportRows} filename={`inventory-matrix-${payload.style.style_code}`} sheetName="Inventory Matrix" columns={exportColumns} />
          )}
          {/* Export — all/brand matrix (OH matrices view only, NOT the Snapshot). */}
          {!styleId && noStyleView === "matrix" && brandPayloads.length > 0 && (
            <ExportButton rows={brandExportRows} filename={`inventory-matrix-${brandId ? "brand" : "all-styles"}`} sheetName="Inventory Matrix" columns={brandExportColumns} />
          )}

          {/* Style count + Prev/Next pager — Snapshot view (matrix view keeps its
              own bar). When Collapse is active the snapshot aggregates the FULL
              filtered set (#13), so the pager is replaced by an "all N styles"
              note. */}
          {!styleId && noStyleView === "snapshot" && (
            collapseActive ? (
              <span style={{ color: C.textMuted, fontSize: 13 }}>
                Collapsed across all {Math.min(hdrTotalStyles, SNAP_ALL_CAP)} filtered style{hdrTotalStyles === 1 ? "" : "s"}
                {hdrTotalStyles > SNAP_ALL_CAP ? ` (capped at ${SNAP_ALL_CAP})` : ""}
              </span>
            ) : (
              <>
                <span style={{ color: C.textMuted, fontSize: 13 }}>Styles {hdrPageStart}–{hdrPageEnd} of {hdrTotalStyles}</span>
                {hdrTotalPages > 1 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <button onClick={() => setMultiPage((p) => Math.max(0, p - 1))} disabled={multiPage === 0} style={{ ...pagBtn, opacity: multiPage === 0 ? 0.4 : 1, cursor: multiPage === 0 ? "default" : "pointer" }}>◀ Prev</button>
                    <span style={{ color: C.textMuted, fontSize: 12 }}>Page {multiPage + 1} of {hdrTotalPages}</span>
                    <button onClick={() => setMultiPage((p) => Math.min(hdrTotalPages - 1, p + 1))} disabled={multiPage >= hdrTotalPages - 1} style={{ ...pagBtn, opacity: multiPage >= hdrTotalPages - 1 ? 0.4 : 1, cursor: multiPage >= hdrTotalPages - 1 ? "default" : "pointer" }}>Next ▶</button>
                  </div>
                )}
              </>
            )
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
            ["matrix", "Matrix"],
            ["so", "SO"],
            ["po", "PO"],
            ["invoices", "Invoices"],
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
          <strong>Exploded packs included.</strong>{" "}
          {payload.explode.packs_exploded > 0
            ? `${payload.explode.packs_exploded} prepack SKU${payload.explode.packs_exploded === 1 ? "" : "s"} converted to sized eaches via the Prepack Matrix master.`
            : `No prepack SKUs on-hand were exploded.`}
          {payload.explode.packs_unmatched.length > 0 && (
            <div style={{ marginTop: 6, color: "#FECACA" }}>
              {payload.explode.packs_unmatched.length} pack SKU{payload.explode.packs_unmatched.length === 1 ? "" : "s"} have on-hand but no matrix defined — NOT exploded:{" "}
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

      {/* Inventory Snapshot — one row per (style, color) with clickable
          quantities that drill into the matching app in a new tab. The view
          switch, presets/dates, export and pager all live in the single
          controls row above; here we render just the column show/hide control
          and the table. */}
      {!styleId && noStyleView === "snapshot" && (
        <>
          <SnapshotProgressBar active={snapLoading} />
          <SnapshotView rows={snapVisibleRows} loading={snapLoading} err={snapErr} sortKey={snapSortKey} sortDir={snapSortDir} onSort={onSnapSort}
            thumbs={snapThumbs} onOpenSold={setSoldFor} onOpenPurchased={setPurchasedFor} show={snapShow} explodePpk={effectiveExplodePpk} mergePpk={mergePpk} collapseCols={snapCollapse} showTotals={snapTotals} />
        </>
      )}

      {/* Drill modals */}
      {soldFor && (
        <SoldDetailModal row={soldFor} headerFrom={snapFrom} headerTo={snapTo} explodePpk={effectiveExplodePpk} onClose={() => setSoldFor(null)}
          onOpenInvoice={(arId, num, customer) => setDocModal({ kind: "ar", id: arId, number: num, party: customer })} />
      )}
      {purchasedFor && (
        <PurchasedDetailModal row={purchasedFor} headerFrom={snapFrom} headerTo={snapTo} explodePpk={effectiveExplodePpk} onClose={() => setPurchasedFor(null)}
          onOpenBill={(billId, ref, vendor) => setDocModal({ kind: "ap", id: billId, number: ref, party: vendor })} />
      )}
      {docModal && (
        <DocDetailModal kind={docModal.kind} id={docModal.id} number={docModal.number} party={docModal.party} onClose={() => setDocModal(null)} />
      )}

      {/* Multi-style view — no specific style selected: render one page of styles
          (MULTI_PAGE_SIZE each) in the current scope (selected brand or all brands),
          stacked with a style header bar each. Paginated via prev/next controls. */}
      {!styleId && noStyleView === "matrix" && (
        brandLoading ? (
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>
            Loading inventory…
          </div>
        ) : brandStyles.length === 0 ? (
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>
            No styles match{brandId ? " for this brand" : ""}.
          </div>
        ) : (() => {
          const totalStyles = brandStyles.length;
          // Render one block per style on this page — including styles with no
          // on-hand (a slim stub) — so the rendered block count always matches the
          // "Styles X–Y of N" header. Previously only brandPayloads rendered, so a
          // zero-on-hand sibling (e.g. a -PPK or -KO style) was counted but
          // invisible: the header read "3 of 3" while one block showed.
          const pageStyles = brandStyles.slice(multiPage * MULTI_PAGE_SIZE, multiPage * MULTI_PAGE_SIZE + MULTI_PAGE_SIZE);
          const payloadById = new Map(brandPayloads.map((b) => [b.style.id, b.payload] as const));
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
            {pageStyles.map((bStyle) => {
              const bPayload = payloadById.get(bStyle.id);
              // Shared clickable style header — drills into the single-style view
              // (and its SO / PO / Invoice tabs) whether or not the style has stock.
              const header = (
                <div
                  onClick={() => setStyleId(bStyle.id)}
                  title="Open this style (SO / PO / Invoice tabs)"
                  style={{ padding: "6px 12px", background: C.card, borderRadius: "8px 8px 0 0", border: `1px solid ${C.sectionBdr}`, borderBottom: "none", fontSize: 13, fontWeight: 700, color: C.base, fontFamily: "monospace", cursor: "pointer" }}
                >
                  {bStyle.style_code}{bStyle.style_name ? ` — ${bStyle.style_name}` : ""}
                </div>
              );

              const bRises = bPayload?.rises ?? [];
              const bShowRise = bRises.length > 1;
              const bSizeOrder = bPayload ? (bPayload.sizes.length ? bPayload.sizes :
                (() => { const s: string[] = []; for (const sk of bPayload.skus) if (sk.size && !s.includes(sk.size)) s.push(sk.size); return s; })()) : [];
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
              const bInseamOrder = bPayload ? computeInseamOrder(bPayload, scales) : [];
              const bByInseam = inseamMode && bInseamOrder.length > 0;
              const bShowSecondary = bByInseam || bShowRise;
              const bRows = bPayload
                ? buildMatrixRows(bPayload, [], bShowRise, bSkuQty, bCellQty, bByInseam).filter((r) => !hideZeros || r.totalQty !== 0)
                : [];

              // No visible rows — no inventory record, or every row zeroed out by
              // the warehouse + Hide-Zeros filters. Render a slim stub (not null) so
              // the style stays visible + clickable and the count stays honest.
              if (bRows.length === 0) {
                const stubMsg = !bPayload
                  ? "No inventory records for this style."
                  : `No on-hand inventory${whActive ? ` at ${warehouse}` : ""}${hideZeros ? " — turn off Hide Zeros to show zero rows." : "."}`;
                return (
                  <div key={bStyle.id}>
                    {header}
                    <div style={{ background: C.headerBg, borderRadius: "0 0 8px 8px", border: `1px solid ${C.sectionBdr}`, borderTop: "none", padding: "10px 14px", color: C.textMuted, fontSize: 12, fontStyle: "italic" }}>
                      {stubMsg}
                    </div>
                  </div>
                );
              }

              const bInseamModel = bByInseam ? buildInseamModel(bRows, bInseamOrder) : null;
              const bColSpan = bShowSecondary ? 3 : 2; // Image + Color [+ Rise/Inseam]
              const bColTotals: Record<string, number> = {};
              for (const sz of bSizeOrder) bColTotals[sz] = bRows.reduce((s, r) => s + (r.sizes[sz] || 0), 0);
              // Empty-size-column collapse for this block — the SAME model the
              // SO/PO grid + single-style matrix use (computeSizeCollapse). Once
              // any size column has stock the first VISIBLE size header turns
              // green + is clickable to hide the all-zero leading/trailing size
              // columns. Collapsed state is owned per style id (blockCollapsed).
              const bCollapse = computeSizeCollapse(bSizeOrder, bColTotals, { enabled: true, collapsed: blockCollapsed.has(bStyle.id) });
              // Honor the global "Hide sizes" toggle — drop all size columns;
              // else draw the (possibly collapsed) visible size range.
              const bRenderSizes = hideSizes ? [] : bCollapse.visibleSizes;
              const bGrandQty = bRows.reduce((s, r) => s + r.totalQty, 0);
              const bGrandCost = bRows.reduce((s, r) => s + r.totalCostCents, 0);
              return (
                <div key={bStyle.id}>
                  {header}
                  <div style={{ overflowX: "auto", background: C.headerBg, borderRadius: "0 0 8px 8px", border: `1px solid ${C.sectionBdr}` }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: C.headerBg }}>
                          <th style={{ ...thBase, textAlign: "center", width: 52 }}>Img</th>
                          <th style={{ ...thBase, textAlign: "left" }}>Color</th>
                          {bShowSecondary && <th style={{ ...thBase, textAlign: "left" }}>{bByInseam ? "Inseam" : "Rise"}</th>}
                          {bRenderSizes.map((sz, i) => {
                            const isFirst = i === 0;
                            const isLast = i === bRenderSizes.length - 1;
                            const green = bCollapse.hasQty && isFirst;
                            const clickable = isFirst && bCollapse.canToggle;
                            return (
                              <th
                                key={sz}
                                onClick={clickable ? () => toggleBlockCollapsed(bStyle.id) : undefined}
                                title={clickable
                                  ? (bCollapse.collapsedActive ? "Show all size columns" : "Hide the empty size columns before/after the sizes with stock")
                                  : undefined}
                                style={{
                                  ...thBase, textAlign: "center", minWidth: 52,
                                  ...(green ? { color: C.green } : {}),
                                  ...(clickable ? { cursor: "pointer", userSelect: "none" } : {}),
                                }}
                              >
                                {bCollapse.collapsedActive && isFirst && bCollapse.hiddenLeading > 0 ? "⋯ " : ""}{sz}{bCollapse.collapsedActive && isLast && bCollapse.hiddenTrailing > 0 ? " ⋯" : ""}
                              </th>
                            );
                          })}
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
                                  {bRenderSizes.map((sz) => (
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
                                  <StyleThumb styleId={bStyle.id} label={bStyle.style_code} url={brandThumbs.get(bStyle.id)?.byColor[(row.color || "").toLowerCase().trim()] ?? brandThumbs.get(bStyle.id)?.default ?? null} />
                                </td>
                                <td style={{ padding: "6px 12px", color: "#D1D5DB" }}>{row.color || "—"}</td>
                                <td style={{ padding: "6px 12px", color: "#C4B5FD", fontFamily: "monospace" }}>{row.inseam ? `${row.inseam}"` : "—"}</td>
                                {bRenderSizes.map((sz) => (
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
                                <StyleThumb styleId={bStyle.id} label={bStyle.style_code} url={brandThumbs.get(bStyle.id)?.byColor[(row.color || "").toLowerCase().trim()] ?? brandThumbs.get(bStyle.id)?.default ?? null} />
                              </td>
                              <td style={{ padding: "6px 12px", color: "#D1D5DB" }}>{row.color || "—"}</td>
                              {bShowRise && <td style={{ padding: "6px 12px", color: "#C4B5FD", fontFamily: "monospace" }}>{row.rise || "—"}</td>}
                              {bRenderSizes.map((sz) => (
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
                          {bRenderSizes.map((sz) => (
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
          Every color row has a zero total{whActive ? ` for ${warehouse}` : ""}. Turn off <strong>Hide Zeros</strong>{whActive ? " or pick a different warehouse" : ""} to see them.
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
                {renderSizes.map((sz, i) => {
                  const isFirst = i === 0;
                  const isLast = i === renderSizes.length - 1;
                  const green = sizeCollapse.hasQty && isFirst;
                  const clickable = isFirst && sizeCollapse.canToggle;
                  return (
                    <th
                      key={sz}
                      onClick={clickable ? () => setSizesCollapsed((c) => !c) : undefined}
                      title={clickable
                        ? (sizeCollapse.collapsedActive ? "Show all size columns" : "Hide the empty size columns before/after the sizes with stock")
                        : undefined}
                      style={{
                        ...thBase, textAlign: "center", minWidth: 60,
                        ...(green ? { color: C.green } : {}),
                        ...(clickable ? { cursor: "pointer", userSelect: "none" } : {}),
                      }}
                    >
                      {sizeCollapse.collapsedActive && isFirst && sizeCollapse.hiddenLeading > 0 ? "⋯ " : ""}{sz}{sizeCollapse.collapsedActive && isLast && sizeCollapse.hiddenTrailing > 0 ? " ⋯" : ""}
                    </th>
                  );
                })}
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
                        {renderSizes.map((sz) => (
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
                          <img src={url} alt={row.color} title="View all images for this style" onClick={() => styleId && openStyleGallery(styleId, payload.style.style_code)} style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 4, border: "1px solid #334155", cursor: "pointer" }} />
                        ) : <span style={{ display: "block", width: 44, height: 44, background: "#1E293B", borderRadius: 4, margin: "0 auto" }} />}
                      </td>
                      <td style={{ padding: "8px 14px", color: C.base, fontFamily: "monospace", fontWeight: 700, borderRight: `1px solid ${C.sectionBdr}` }}>{payload.style.style_code}</td>
                      <td style={{ padding: "8px 14px", color: C.desc, fontSize: 12 }}>{payload.style.style_name || payload.style.description || "—"}</td>
                      <td style={{ padding: "8px 14px", color: "#D1D5DB" }}>{row.color || "—"}</td>
                      <td style={{ padding: "8px 14px", color: "#C4B5FD", fontFamily: "monospace" }}>{row.inseam ? `${row.inseam}"` : "—"}</td>
                      {renderSizes.map((sz) => (
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
                            title="View all images for this style"
                            onClick={() => styleId && openStyleGallery(styleId, payload.style.style_code)}
                            style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 4, border: "1px solid #334155", cursor: "pointer" }}
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
                    {renderSizes.map((sz) => (
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
                {renderSizes.map((sz) => (
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
