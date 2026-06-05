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

// PIM composite image row (subset) — shape returned by
// GET /api/internal/pim/styles/:style_id. We reuse the SAME source the PIM
// Product Catalog uses so the matrix thumbnail matches the catalog image.
// The handler signs the bucket-relative storage_path* derivatives and returns
// the usable URLs under `signed_urls` (the raw storage_path* are NOT URLs).
type PimImageRow = {
  id: string;
  storage_path: string | null;
  storage_path_thumb: string | null;
  storage_path_web: string | null;
  is_primary: boolean;
  sort_order: number;
  signed_urls?: { thumb: string | null; web: string | null; print: string | null } | null;
};

// Resolved primary image for the picked style: a small thumb URL for the
// header and a larger URL for the enlarge lightbox.
type PrimaryImage = { thumb: string; full: string } | null;

// Pick the style's primary image the SAME way InternalPimProductCatalog does:
// prefer is_primary, then lowest sort_order. URLs come from the handler's
// signed_urls (thumb for the header; web → print → thumb for the lightbox).
function pickPrimaryImage(images: PimImageRow[]): PrimaryImage {
  if (!images || images.length === 0) return null;
  const sorted = [...images].sort((a, b) => {
    if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
    return a.sort_order - b.sort_order;
  });
  const top = sorted[0];
  const s = top.signed_urls || { thumb: null, web: null, print: null };
  const thumb = s.thumb || s.web || s.print || null;
  const full = s.web || s.print || s.thumb || null;
  if (!thumb || !full) return null;
  return { thumb, full };
}

const ALL_WAREHOUSES = "__all__";

// ── MatrixRow type (shared by single-style and brand-level views) ─────────────

type MatrixRow = {
  key: string;
  color: string;
  rise: string | null;
  sizes: Record<string, number>;
  totalQty: number;
  avgCostCents: number | null; // qty-weighted blended avg, cents
  totalCostCents: number;
  costedQty: number; // qty of SKUs that actually carry a cost (blend denominator)
  lastReceived: string | null;
};

// Pure helper — builds MatrixRow[] from a payload given a qty accessor.
// Extracted so both the single-style useMemo and the brand-level renderer can
// call the same logic without duplication.
function buildMatrixRows(
  payload: MatrixPayload,
  riseFilter: string[],
  showRise: boolean,
  skuQtyFn: (s: MatrixSku) => number,
  cellQtyFn: (c: ExplodeCell) => number,
): MatrixRow[] {
  const active = riseFilter.length ? new Set(riseFilter) : null;
  const map = new Map<string, MatrixRow>();
  for (const s of payload.skus) {
    const rise = s.rise ?? null;
    if (active && !(rise != null && active.has(rise))) continue;
    const color = s.color ?? "—";
    const key = showRise ? `${color}|${rise ?? ""}` : color;
    let row = map.get(key);
    if (!row) {
      row = { key, color, rise, sizes: {}, totalQty: 0, avgCostCents: null, totalCostCents: 0, costedQty: 0, lastReceived: null };
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
  if (payload.explode?.enabled) {
    for (const c of payload.explode.cells) {
      const qty = cellQtyFn(c);
      if (!qty) continue;
      const color = c.color || "—";
      const key = showRise ? `${color}|` : color;
      let row = map.get(key);
      if (!row) {
        row = { key, color, rise: showRise ? "(prepack)" : null, sizes: {}, totalQty: 0, avgCostCents: null, totalCostCents: 0, costedQty: 0, lastReceived: null };
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

// Download an image URL to a file. Fetch → blob → object-URL so the browser
// saves the bytes (a plain <a download> to a cross-origin/storage URL often
// just navigates); falls back to a direct link if the fetch is blocked.
async function downloadImage(url: string, filename: string): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
  } catch {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.click();
  }
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
  // Primary product image for the picked style (same source as the PIM
  // Product Catalog) + the enlarge lightbox open flag.
  const [primaryImage, setPrimaryImage] = useState<PrimaryImage>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // Per-color thumbnail images for each row in the matrix (fetched from the
  // PIM style images endpoint). Key = color lowercase-trimmed || "__default__".
  const [styleImages, setStyleImages] = useState<Map<string, string>>(new Map());

  // Brand-level view: when brandId is set but styleId is empty, load matrices
  // for up to 50 of the brand's styles and render them all.
  const [brandPayloads, setBrandPayloads] = useState<Array<{style: StyleListRow; payload: MatrixPayload}>>([]);
  const [brandLoading, setBrandLoading] = useState(false);

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

  // Fetch the picked style's primary product image from the PIM composite —
  // the SAME endpoint/field the PIM Product Catalog uses, so the matrix
  // thumbnail matches the catalog. Single style in view → one fetch, no N+1.
  useEffect(() => {
    if (!styleId) { setPrimaryImage(null); setLightboxOpen(false); return; }
    let cancelled = false;
    setPrimaryImage(null);
    setLightboxOpen(false);
    fetch(`/api/internal/pim/styles/${encodeURIComponent(styleId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { images?: PimImageRow[] } | null) => {
        if (cancelled || !d) return;
        setPrimaryImage(pickPrimaryImage(d.images || []));
      })
      .catch(() => {/* non-fatal; header just shows the placeholder */});
    return () => { cancelled = true; };
  }, [styleId]);

  // Reset rise + warehouse filters on a STYLE change only (not on explode toggle).
  useEffect(() => {
    setRiseFilter([]);
    setWarehouse(ALL_WAREHOUSES);
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

  // Brand-level view: when brandId is set but no specific styleId, fetch
  // matrices for up to 50 of the brand's styles in parallel.
  useEffect(() => {
    if (!brandId || styleId) { setBrandPayloads([]); return; }
    const stylesToLoad = brandStyles.slice(0, 50);
    if (stylesToLoad.length === 0) { setBrandPayloads([]); return; }
    setBrandLoading(true);
    setBrandPayloads([]);
    Promise.all(
      stylesToLoad.map(async (s) => {
        try {
          const r = await fetch(`/api/internal/style-matrix?style_id=${encodeURIComponent(s.id)}`);
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
  }, [brandId, styleId, brandStyles]);

  // Brand picker options (blank = all brands). Label prefers code, falls back to name.
  const brandOptions = useMemo<SearchableSelectOption[]>(
    () =>
      brands.map((b) => ({
        value: b.id,
        label: b.code && b.name ? `${b.code} — ${b.name}` : (b.name || b.code || "—"),
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
  // spans >1 rise). Delegates to the pure buildMatrixRows helper above,
  // capturing the warehouse-aware qty accessors from this closure.
  const rows = useMemo<MatrixRow[]>(() => {
    if (!payload) return [];
    return buildMatrixRows(payload, riseFilter, showRise, skuQty, cellQty);
  }, [payload, riseFilter, showRise, warehouse]); // warehouse drives skuQty/cellQty

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

  // The footer's "Grand Total" label cell spans the non-image leading data
  // columns: Base Part + Description + Color (= 3), plus Rise when the style
  // spans >1 rise (= 4). The Image column is a separate empty <td /> that
  // precedes this cell in the footer row (added PR #1022).
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
              href={`/ats${payload?.style.style_code ? `?style=${encodeURIComponent(payload.style.style_code)}` : ""}`}
              target="_blank"
              rel="noopener noreferrer"
              style={atsLinkStyle}
              title={payload?.style.style_code
                ? `Open the ATS app filtered to ${payload.style.style_code}`
                : "Open the ATS app for available-to-sell"}
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

      {/* Style meta — the product image sits BEFORE the style number. Clicking
          the thumbnail opens the enlarge lightbox (with a Download button). */}
      {payload && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          {/* Primary product image (same source as the PIM Product Catalog). */}
          {primaryImage ? (
            <img
              src={primaryImage.thumb}
              alt={payload.style.style_code}
              onClick={() => setLightboxOpen(true)}
              title="Click to enlarge"
              style={{
                width: 48, height: 48, objectFit: "cover", borderRadius: 6,
                border: `1px solid ${C.cardBdr}`, background: "#0b1220",
                cursor: "zoom-in", flexShrink: 0,
              }}
            />
          ) : (
            <div
              style={{
                width: 48, height: 48, borderRadius: 6,
                border: `1px dashed ${C.cardBdr}`, background: "#0b1220",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 20, color: C.textMuted, flexShrink: 0,
              }}
              title="No product image"
            >
              🖼️
            </div>
          )}
          <div style={{ fontSize: 12, color: C.textSub }}>
            <span style={{ fontWeight: 600 }}>{payload.style.style_code}</span>
            {payload.style.style_name ? <span> — {payload.style.style_name}</span> : null}
            <span style={{ color: C.textMuted }}>
              {"  ·  Size scale: "}{scaleName || (payload.style.size_scale_id ? "—" : "none")}
              {"  ·  On-hand qty"}
              {whActive ? `  ·  Warehouse: ${warehouse}` : "  ·  All warehouses"}
            </span>
          </div>
        </div>
      )}

      {/* Enlarge lightbox — full image + Download button. Self-contained so the
          matrix doesn't pull in the heavier multi-image ImageGalleryModal. */}
      {lightboxOpen && primaryImage && payload && (
        <div
          onClick={() => setLightboxOpen(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 10000,
            background: "rgba(0,0,0,0.9)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 24, cursor: "zoom-out",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              gap: 16, maxWidth: "90vw", maxHeight: "92vh", cursor: "default",
            }}
          >
            <img
              src={primaryImage.full}
              alt={payload.style.style_code}
              style={{
                maxWidth: "90vw", maxHeight: "78vh", objectFit: "contain",
                borderRadius: 10, boxShadow: "0 20px 60px rgba(0,0,0,0.8)",
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>
                {payload.style.style_code}
                {payload.style.style_name ? ` — ${payload.style.style_name}` : ""}
              </span>
              <button
                type="button"
                onClick={() => void downloadImage(
                  primaryImage.full,
                  `${payload.style.style_code}.jpg`,
                )}
                style={{
                  background: C.primary, color: "white", border: 0,
                  padding: "8px 16px", borderRadius: 6, cursor: "pointer",
                  fontSize: 13, fontWeight: 600,
                }}
              >
                ⬇ Download
              </button>
              <button
                type="button"
                onClick={() => setLightboxOpen(false)}
                style={{
                  background: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.8)",
                  border: "1px solid rgba(255,255,255,0.2)",
                  padding: "8px 16px", borderRadius: 6, cursor: "pointer",
                  fontSize: 13, fontWeight: 600,
                }}
              >
                ✕ Close
              </button>
            </div>
          </div>
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

      {/* Brand-level view — brand selected but no specific style: render all
          brand styles' matrices stacked, each with a style header bar. */}
      {!styleId && brandId && (
        brandLoading ? (
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>
            Loading brand inventory…
          </div>
        ) : brandPayloads.length === 0 ? (
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>
            No styles with inventory for this brand.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
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
              const bRows = buildMatrixRows(bPayload, [], bShowRise, bSkuQty, bCellQty)
                .filter((r) => !hideZeros || r.totalQty !== 0);
              if (bRows.length === 0) return null;
              const bColSpan = bShowRise ? 3 : 2; // Image + Color [+ Rise]
              const bColTotals: Record<string, number> = {};
              for (const sz of bSizeOrder) bColTotals[sz] = bRows.reduce((s, r) => s + (r.sizes[sz] || 0), 0);
              const bGrandQty = bRows.reduce((s, r) => s + r.totalQty, 0);
              const bGrandCost = bRows.reduce((s, r) => s + r.totalCostCents, 0);
              return (
                <div key={bStyle.id}>
                  <div style={{ padding: "6px 12px", background: C.card, borderRadius: "8px 8px 0 0", border: `1px solid ${C.sectionBdr}`, borderBottom: "none", fontSize: 13, fontWeight: 700, color: C.base, fontFamily: "monospace" }}>
                    {bStyle.style_code}{bStyle.style_name ? ` — ${bStyle.style_name}` : ""}
                  </div>
                  <div style={{ overflowX: "auto", background: C.headerBg, borderRadius: "0 0 8px 8px", border: `1px solid ${C.sectionBdr}` }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: C.headerBg }}>
                          <th style={{ ...thBase, textAlign: "center", width: 52 }}>Img</th>
                          <th style={{ ...thBase, textAlign: "left" }}>Color</th>
                          {bShowRise && <th style={{ ...thBase, textAlign: "left" }}>Rise</th>}
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
                        {bRows.map((row, ri) => {
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
                        })}
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
          </div>
        )
      )}

      {/* Matrix table — poMatrixTab-style "Item Matrix" look. */}
      {loading ? (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
      ) : !styleId && !brandId ? (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, textAlign: "center", color: C.textMuted }}>
          Pick a style to view its inventory matrix.
        </div>
      ) : !styleId ? null /* brand-level view rendered above */
      : !payload || rows.length === 0 ? (
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
                <th style={{ ...thBase, textAlign: "center", width: 52 }}>Img</th>
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
              })}
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
      )}
    </div>
  );
}
