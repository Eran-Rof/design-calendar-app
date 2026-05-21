// Sales Comps modal — picks a date range + filter scope, fetches sales
// for that window AND the same window shifted 12 months back (LY),
// then shows a TY vs LY comparison.
//
// Selection step: AppDatePicker for start/end (custom popover, no native
// browser widget so styling is consistent across apps), plus searchable
// dropdowns pre-populated from the grid's current filter state. Each
// dropdown closes on outside click. A radio toggle picks Summary vs
// Detailed output.
//
// Results step: an expanded summary block (totals for qty / rev / cogs /
// margin$ / margin%) and — in Detailed mode — a per-SKU table sorted
// by largest TY revenue. Cross-grid sku_ids are resolved via the item-
// master cache, so the table shows the real sku_code (e.g. RYO0658PPK-
// BLACK/BIRCH) instead of an opaque uuid prefix. An Excel-download
// button on the results view emits the same shape as the on-screen
// data so it can live alongside the existing ATS reports folder.

import React, { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { AppDatePicker } from "../../shared/components/AppDatePicker";
import { fetchSalesAggregates, type SalesFetchResult } from "../exportSalesFetch";
import { getItemMasterById, resolveItemMasterIds } from "../itemMasterLookup";
import type { ATSRow, ExcelData } from "../types";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function yearStartIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-01-01`;
}
function isoMinusMonths(iso: string, months: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "—";
  const d = new Date(iso + "T00:00:00");
  d.setMonth(d.getMonth() - months);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtUSD(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "—";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
function fmtPct(num: number, denom: number): string {
  if (!Number.isFinite(num) || !Number.isFinite(denom) || denom <= 0) return "—";
  return `${((num / denom) * 100).toFixed(1)}%`;
}
// Revenue/qty growth math — matches the ATS export's t3VsLyCell:
// (ty - ly) / ty (NOT divided by ly). NEW when ty > 0 and ly = 0.
function fmtGrowth(ty: number, ly: number): { text: string; positive: boolean } {
  if (!Number.isFinite(ty)) ty = 0;
  if (!Number.isFinite(ly)) ly = 0;
  if (ty <= 0 && ly <= 0) return { text: "—", positive: true };
  if (ty <= 0) return { text: "Only LY", positive: false };
  const frac = (ty - ly) / ty;
  return { text: `${frac >= 0 ? "+" : ""}${(frac * 100).toFixed(1)}%`, positive: frac >= 0 };
}
// Margin-points diff — matches the ATS export's marginDiffCell: a plain
// subtraction of the two margin percentages (no division). Result is in
// percentage points (e.g. 22% TY − 19% LY = "+3.0pp").
function fmtMarginPoints(tyMrgn: number, tyRev: number, lyMrgn: number, lyRev: number): { text: string; positive: boolean } {
  const tyPct = tyRev > 0 ? tyMrgn / tyRev : 0;
  const lyPct = lyRev > 0 ? lyMrgn / lyRev : 0;
  if (tyPct === 0 || lyPct === 0) return { text: "—", positive: true };
  const diff = tyPct - lyPct;
  return { text: `${diff >= 0 ? "+" : ""}${(diff * 100).toFixed(1)}pp`, positive: diff >= 0 };
}

// Theme tokens — mirror NavBar/ExportOptionsModal so the new modal looks
// native to the rest of the app. Slate-800 surfaces, emerald accents.
const C = {
  surface:    "#1E293B",
  border:     "#334155",
  text:       "#F1F5F9",
  textMuted:  "#94A3B8",
  textDim:    "#64748B",
  accent:     "#10B981",
  rowAlt:     "#0F172A",
  green:      "#10B981",
  red:        "#F87171",
};

const inputStyle: React.CSSProperties = {
  background: C.rowAlt,
  border: `1px solid ${C.border}`,
  color: C.text,
  padding: "6px 10px",
  borderRadius: 6,
  fontSize: 13,
  width: "100%",
  fontFamily: "inherit",
};

// "View By" dimensions the results step can roll up against. Multi-
// select — each selected dimension renders its own CompsTable in the
// results pane. "so" is a special view that compares open SOs to LY
// ship $ using the SO's cancel_date as the reference; the rest are
// straightforward group-bys of the existing fetch result.
type ViewByKey = "customer" | "category" | "sub_category" | "style" | "sku" | "so";
const VIEW_BY_LABELS: Record<ViewByKey, string> = {
  customer:     "Customer",
  category:     "Category",
  sub_category: "Sub-Category",
  style:        "Style",
  sku:          "SKU",
  so:           "SO (open vs LY ship)",
};
const VIEW_BY_OPTIONS: ViewByKey[] = ["customer", "category", "sub_category", "style", "sku", "so"];

interface SelectFieldProps<T extends string> {
  label: string;
  value: T[];
  options: T[];
  onChange: (next: T[]) => void;
  multi?: boolean;
  hint?: string;
  // Optional display formatter — used by the View By selector which
  // wants "Sub-Category" shown even though the underlying key is
  // "sub_category". Other callers pass plain string options and don't
  // need this.
  optionLabel?: (o: T) => string;
}
function SelectField<T extends string>({ label, value, options, onChange, multi, hint, optionLabel }: SelectFieldProps<T>): React.ReactElement {
  const fmt = (o: T) => optionLabel ? optionLabel(o) : o;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // Direction the popover opens — "down" when there's room below the
  // button, "up" otherwise. Computed when the popover opens so the
  // bottom-most fields (like View By) don't get their popover clipped
  // by the modal's scroll-container edge.
  const [openDir, setOpenDir] = useState<"down" | "up">("down");
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Click-outside closes the multi-select popover. Listens only while
  // open so we don't waste handlers on idle dropdowns.
  useEffect(() => {
    if (!open) return;
    // Compute direction once at open time. Popover height capped at
    // 260px (see styles below); flip up if the button's bottom is
    // within that distance of the viewport bottom.
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const roomBelow = window.innerHeight - rect.bottom;
      setOpenDir(roomBelow < 280 && rect.top > 280 ? "up" : "down");
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t || !wrapRef.current) return;
      if (!wrapRef.current.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!multi) {
    const single = value[0] ?? "";
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label style={{ fontSize: 12, color: C.textMuted, fontWeight: 600 }}>{label}</label>
        {hint && <span style={{ fontSize: 10, color: C.textDim, lineHeight: 1.2 }}>{hint}</span>}
        <select value={single} onChange={e => onChange(e.target.value ? [e.target.value as T] : [])} style={inputStyle}>
          <option value="">All</option>
          {options.map(o => <option key={o} value={o}>{fmt(o)}</option>)}
        </select>
      </div>
    );
  }

  const filtered = search.trim() === ""
    ? options
    : options.filter(o => o.toLowerCase().includes(search.toLowerCase()));
  const summary = value.length === 0 ? "All" : value.length <= 2 ? value.map(fmt).join(", ") : `${value.length} selected`;
  const toggle = (o: T) => onChange(value.includes(o) ? value.filter(v => v !== o) : [...value, o]);

  return (
    <div ref={wrapRef} style={{ display: "flex", flexDirection: "column", gap: 4, position: "relative" }}>
      <label style={{ fontSize: 12, color: C.textMuted, fontWeight: 600 }}>{label}</label>
      {hint && <span style={{ fontSize: 10, color: C.textDim, lineHeight: 1.2 }}>{hint}</span>}
      <button ref={buttonRef} type="button" onClick={() => setOpen(o => !o)} style={{ ...inputStyle, textAlign: "left", cursor: "pointer" }}>
        {summary}
        <span style={{ float: "right", color: C.textDim, fontSize: 10 }}>▼</span>
      </button>
      {open && (
        <div style={{
          position: "absolute",
          // Opens upward when the button is too close to the viewport
          // bottom — keeps the popover inside the modal's scroll area
          // so options aren't clipped.
          ...(openDir === "down"
            ? { top: "calc(100% + 4px)" }
            : { bottom: "calc(100% + 4px)" }),
          left: 0, right: 0, zIndex: 1100,
          background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6,
          maxHeight: 260, display: "flex", flexDirection: "column", padding: 4,
          boxShadow: "0 6px 18px rgba(0,0,0,0.5)",
        }}>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            autoFocus
            style={{ ...inputStyle, padding: "5px 8px", fontSize: 12, marginBottom: 4 }}
          />
          <div style={{ overflowY: "auto", flex: 1 }}>
            {filtered.length === 0 && <div style={{ fontSize: 11, color: C.textDim, padding: 6 }}>No matches</div>}
            {filtered.map(o => (
              <label key={o} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", cursor: "pointer", fontSize: 12, color: C.text, borderRadius: 4 }} onMouseEnter={e => (e.currentTarget.style.background = "rgba(16,185,129,0.10)")} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                <input type="checkbox" checked={value.includes(o)} onChange={() => toggle(o)} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fmt(o)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  // Pre-selected scope from the grid's current filter state. Operator
  // can override any field via the dropdowns below.
  defaultCustomer: string;
  defaultCategories: string[];
  defaultSubCategories: string[];
  defaultStyles: string[];
  defaultStoreFilter: string[];
  // FULL option lists — sourced from the broader dataset (not just the
  // currently-filtered grid rows) so the operator can broaden the
  // selection beyond what's already on screen. Defaults above stay
  // tied to the grid filter; options here let the operator add anything.
  allCategories: string[];
  allSubCategories: string[];
  allStyles: string[];
  allStores: string[];
  rows: ATSRow[];
  excelData: ExcelData | null;
}

interface AggRow {
  sku: string;
  styleKey: string;       // BASE-COLOR — used to dedupe cross-grid hits
  tyQty: number; tyRev: number; tyMrgn: number;
  lyQty: number; lyRev: number; lyMrgn: number;
}

export const SalesCompsModal: React.FC<Props> = ({
  open, onClose,
  defaultCustomer, defaultCategories, defaultSubCategories, defaultStyles, defaultStoreFilter,
  allCategories, allSubCategories, allStyles, allStores,
  rows, excelData,
}) => {
  // Option lists come from the FULL dataset (not the filtered rows) so
  // operators can broaden the report past the grid's current scope.
  // Sorted for predictable presentation in the dropdowns.
  const categories    = useMemo(() => [...allCategories].sort(),    [allCategories]);
  const subCategories = useMemo(() => [...allSubCategories].sort(), [allSubCategories]);
  const styles        = useMemo(() => [...allStyles].sort(),        [allStyles]);
  const stores        = useMemo(() => {
    if (allStores.length > 0) return [...allStores].sort();
    return ["ROF", "ROF ECOM", "PT", "PT ECOM"];
  }, [allStores]);
  // Gender option list — derived from rows (no equivalent allGenders
  // prop yet; the gender domain is small enough that the filtered-
  // rows derivation is rarely missing values in practice).
  const genders = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) { if (r.gender) s.add(r.gender); }
    return [...s].sort();
  }, [rows]);

  const [start, setStart] = useState(yearStartIso());
  const [end,   setEnd]   = useState(todayIso());
  const [customer, setCustomer]                 = useState<string[]>(defaultCustomer ? [defaultCustomer] : []);
  const [selCategories, setSelCategories]       = useState<string[]>(defaultCategories);
  const [selSubCategories, setSelSubCategories] = useState<string[]>(defaultSubCategories);
  const [selStyles, setSelStyles]               = useState<string[]>(defaultStyles);
  const [selStores, setSelStores]               = useState<string[]>(defaultStoreFilter);
  const [selGenders, setSelGenders]             = useState<string[]>([]);
  // Multi-select for the results layout. Each selected dimension gets
  // its own CompsTable. Default is Customer (matches the old Summary
  // mode); operators can add Style/Category/etc. to stack additional
  // breakdowns underneath. "sku" replaces the old Detailed mode.
  const [viewBy, setViewBy]                     = useState<ViewByKey[]>(["customer"]);
  // Customer-facing toggle. When ON, COGS / Margin $ / Margin % rows
  // are hidden from the summary, the per-SKU table, and the Excel
  // export. Mirrors the pattern in ExportOptionsModal so internal
  // shoppable numbers don't accidentally leave the building.
  const [customerFacing, setCustomerFacing]     = useState(false);

  const [running, setRunning] = useState(false);
  const [result, setResult]   = useState<SalesFetchResult | null>(null);
  const [rangeWarn, setRangeWarn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const customers = useMemo(() => {
    const set = new Set<string>();
    if (excelData) for (const s of excelData.sos) if (s.customerName) set.add(s.customerName);
    return [...set].sort();
  }, [excelData]);

  // Per-SKU aggregate, rolled up by sku_code (BASE-COLOR). Cross-grid
  // sku_ids are resolved via the item-master cache so the table shows
  // a real "RBB1438N-BLACK" instead of "[cross-grid] xxxxxxxx".
  // Entries we can't resolve to a real master record are dropped —
  // "only show styles" per the spec.
  const tableRows = useMemo<AggRow[]>(() => {
    if (!result) return [];
    const map = new Map<string, AggRow>();
    const ensure = (sku: string): AggRow => {
      const cur = map.get(sku);
      if (cur) return cur;
      const fresh: AggRow = { sku, styleKey: sku, tyQty: 0, tyRev: 0, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 };
      map.set(sku, fresh);
      return fresh;
    };
    for (const [sku, a] of result.t3) { const r = ensure(sku); r.tyQty += a.qty; r.tyRev += a.totalPrice; r.tyMrgn += a.marginAmount; }
    for (const [sku, a] of result.ly) { const r = ensure(sku); r.lyQty += a.qty; r.lyRev += a.totalPrice; r.lyMrgn += a.marginAmount; }
    for (const [skuId, e] of result.extraBySkuId) {
      const master = getItemMasterById(skuId);
      if (!master?.sku_code) continue; // drop unresolvable rows
      const r = ensure(master.sku_code);
      r.tyQty += e.t3Qty; r.tyRev += e.t3Total; r.tyMrgn += e.t3Margin;
      r.lyQty += e.lyQty; r.lyRev += e.lyTotal; r.lyMrgn += e.lyMargin;
    }
    return [...map.values()]
      .filter(r => r.tyRev > 0 || r.lyRev > 0)
      .sort((a, b) => Math.max(b.tyRev, b.lyRev) - Math.max(a.tyRev, a.lyRev));
  }, [result]);

  // Totals across the rolled-up rows — basis for the summary table.
  const totals = useMemo(() => {
    let tyQty = 0, tyRev = 0, tyMrgn = 0, lyQty = 0, lyRev = 0, lyMrgn = 0;
    for (const r of tableRows) {
      tyQty += r.tyQty; tyRev += r.tyRev; tyMrgn += r.tyMrgn;
      lyQty += r.lyQty; lyRev += r.lyRev; lyMrgn += r.lyMrgn;
    }
    return {
      tyQty, tyRev, tyMrgn, tyCogs: tyRev - tyMrgn,
      lyQty, lyRev, lyMrgn, lyCogs: lyRev - lyMrgn,
    };
  }, [tableRows]);

  // LY ship $ keyed by master_style — used by the SO view to fetch
  // "same style all colors" comparison numbers. result.ly is keyed by
  // variant-level sku; we collapse to style via the item-master cache.
  const lyRevByStyle = useMemo(() => {
    const m = new Map<string, { qty: number; rev: number; mrgn: number }>();
    if (!result) return m;
    const add = (style: string | null | undefined, qty: number, rev: number, mrgn: number) => {
      if (!style) return;
      const cur = m.get(style) ?? { qty: 0, rev: 0, mrgn: 0 };
      cur.qty += qty; cur.rev += rev; cur.mrgn += mrgn;
      m.set(style, cur);
    };
    for (const [sku, a] of result.ly) {
      const ids = resolveItemMasterIds(sku);
      let style: string | null = null;
      for (const id of ids) {
        const rec = getItemMasterById(id);
        if (rec?.style_code) { style = rec.style_code; break; }
      }
      add(style, a.qty, a.totalPrice, a.marginAmount);
    }
    for (const [skuId, e] of result.extraBySkuId) {
      const rec = getItemMasterById(skuId);
      add(rec?.style_code, e.lyQty, e.lyTotal, e.lyMargin);
    }
    return m;
  }, [result]);

  // SO view rows. Built from the OPEN SOs in excelData, filtered by
  // every form selection: cancel-date within TY window, plus
  // customer / store / category / sub-cat / style / gender. LY column
  // comes from the lyRevByStyle map above ("same style, all colors").
  //
  // Row grouping follows whichever OTHER View By dimension the operator
  // picked together with SO:
  //   • Style co-selected → one row per (style, SO) — multiple SOs
  //     with the same style produce multiple lines; subtotals when a
  //     style spans ≥ 2 SOs.
  //   • Customer / Category / Sub-Category co-selected → aggregate
  //     under that dimension (sum of open SOs).
  //   • Only SO selected → one row per SO order_number.
  // A grand-total row closes every variant.
  const soRows = useMemo<SoRow[]>(() => {
    // SO view is built primarily from excelData.sos (open SOs) — the
    // fetch result is only used for the LY column. Don't gate on
    // `result` being truthy; even with a future TY window where
    // result has empty maps, the operator still expects to see
    // their open SOs.
    if (!excelData) return [];
    if (!viewBy.includes("so")) return [];
    const want = (set: string[], v: string | null | undefined) => set.length === 0 || (v != null && set.includes(v));
    // Resolve each open SO's master_style + master_category + master_sub_category
    // up front so we can apply scope filters without doing the lookup
    // multiple times per SO.
    const enriched: Array<{ s: ATSSoEvent; style: string | null; category: string | null; subCategory: string | null; gender: string | null; cancelDate: string }> = [];
    for (const s of excelData.sos) {
      if (!s.date || s.date < start || s.date > end) continue;
      if (!want(selStores, s.store)) continue;
      if (customer[0] && s.customerName !== customer[0]) continue;
      const ids = resolveItemMasterIds(s.sku);
      let style: string | null = null;
      let cat: string | null = null;
      let subCat: string | null = null;
      let gender: string | null = null;
      for (const id of ids) {
        const rec = getItemMasterById(id);
        if (!rec) continue;
        style  = style  ?? rec.style_code               ?? null;
        cat    = cat    ?? rec.attributes?.group_name    ?? null;
        subCat = subCat ?? rec.attributes?.category_name ?? null;
        gender = gender ?? rec.attributes?.gender        ?? null;
        if (style && cat && subCat && gender) break;
      }
      if (!want(selCategories, cat))       continue;
      if (!want(selSubCategories, subCat)) continue;
      if (!want(selStyles, style))         continue;
      if (!want(selGenders, gender))       continue;
      enriched.push({ s, style, category: cat, subCategory: subCat, gender, cancelDate: s.date });
    }

    const groupBy: "style" | "customer" | "category" | "sub_category" | "so" =
      viewBy.includes("style")        ? "style"        :
      viewBy.includes("customer")     ? "customer"     :
      viewBy.includes("category")     ? "category"     :
      viewBy.includes("sub_category") ? "sub_category" :
      "so";

    const out: SoRow[] = [];
    if (groupBy === "style") {
      // One row per (style, SO). An SO with multiple SKUs of the
      // same style (e.g. 3 colors of RYO0658 on the same order)
      // collapses to ONE row — sum qty / totalPrice across the
      // matching SKUs. LY comes from lyRevByStyle (shared across
      // all SOs of the same style — that's intentional, the user
      // asked for "same style all colors" matching).
      const perStyleSo = new Map<string, SoRow>();
      for (const e of enriched) {
        const styleKey = e.style ?? "(no style)";
        const composite = `${styleKey}::${e.s.orderNumber}`;
        const existing = perStyleSo.get(composite);
        if (existing) {
          existing.tyQty += e.s.qty;
          existing.tyRev += e.s.totalPrice;
          continue;
        }
        const lyEntry = lyRevByStyle.get(styleKey) ?? { qty: 0, rev: 0, mrgn: 0 };
        perStyleSo.set(composite, {
          kind: "row",
          key: composite,
          label: `${styleKey} — ${e.s.orderNumber}`,
          style: styleKey,
          orderNumber: e.s.orderNumber,
          customer: e.s.customerName,
          cancelDate: e.cancelDate,
          tyQty: e.s.qty,
          tyRev: e.s.totalPrice,
          tyMrgn: 0, // open SOs don't carry per-row cost here
          lyQty: lyEntry.qty,
          lyRev: lyEntry.rev,
          lyMrgn: lyEntry.mrgn,
        });
      }
      const groups = new Map<string, SoRow[]>();
      for (const row of perStyleSo.values()) {
        const styleKey = row.style ?? "(no style)";
        if (!groups.has(styleKey)) groups.set(styleKey, []);
        groups.get(styleKey)!.push(row);
      }
      // Style groups, sorted by total TY rev descending. Subtotal row
      // only when the group has ≥ 2 SOs (one-line groups don't need
      // a subtotal — the row is its own total).
      const sorted = [...groups.entries()].sort((a, b) => {
        const aSum = a[1].reduce((s, r) => s + r.tyRev, 0);
        const bSum = b[1].reduce((s, r) => s + r.tyRev, 0);
        return bSum - aSum;
      });
      for (const [style, rows] of sorted) {
        for (const r of rows) out.push(r);
        if (rows.length >= 2) {
          out.push({
            kind: "subtotal",
            key: `__subtotal::${style}`,
            label: `Subtotal — ${style}`,
            tyQty: rows.reduce((s, r) => s + r.tyQty, 0),
            tyRev: rows.reduce((s, r) => s + r.tyRev, 0),
            tyMrgn: 0,
            lyQty: rows[0].lyQty,    // same style → same LY (no double-count)
            lyRev: rows[0].lyRev,
            lyMrgn: rows[0].lyMrgn,
          });
        }
      }
    } else if (groupBy === "so") {
      // Default: one row per SO order_number. Multiple SKUs / styles
      // on the same SO collapse — sum qty / totalPrice across them.
      // LY uses the SET of styles touched by the SO so the comp
      // covers every style on that order.
      const perOrder = new Map<string, { e: typeof enriched[number]; tyQty: number; tyRev: number; styles: Set<string> }>();
      for (const e of enriched) {
        const cur = perOrder.get(e.s.orderNumber);
        if (cur) {
          cur.tyQty += e.s.qty;
          cur.tyRev += e.s.totalPrice;
          if (e.style) cur.styles.add(e.style);
        } else {
          perOrder.set(e.s.orderNumber, {
            e,
            tyQty: e.s.qty,
            tyRev: e.s.totalPrice,
            styles: e.style ? new Set([e.style]) : new Set(),
          });
        }
      }
      for (const { e, tyQty, tyRev, styles } of perOrder.values()) {
        let lyQty = 0, lyRev = 0, lyMrgn = 0;
        for (const st of styles) {
          const ent = lyRevByStyle.get(st);
          if (!ent) continue;
          lyQty += ent.qty; lyRev += ent.rev; lyMrgn += ent.mrgn;
        }
        out.push({
          kind: "row",
          key: e.s.orderNumber,
          label: e.s.orderNumber,
          style: styles.size === 1 ? [...styles][0] : (styles.size > 1 ? `${styles.size} styles` : undefined),
          orderNumber: e.s.orderNumber,
          customer: e.s.customerName,
          cancelDate: e.cancelDate,
          tyQty, tyRev, tyMrgn: 0,
          lyQty, lyRev, lyMrgn,
        });
      }
      out.sort((a, b) => b.tyRev - a.tyRev);
    } else {
      // Aggregate under customer / category / sub_category.
      const dimGet = (e: typeof enriched[number]): string => {
        if (groupBy === "customer") return e.s.customerName || "(no customer)";
        if (groupBy === "category") return e.category || "(no category)";
        return e.subCategory || "(no sub-category)";
      };
      const agg = new Map<string, { tyQty: number; tyRev: number; styles: Set<string> }>();
      for (const e of enriched) {
        const k = dimGet(e);
        const cur = agg.get(k) ?? { tyQty: 0, tyRev: 0, styles: new Set<string>() };
        cur.tyQty += e.s.qty;
        cur.tyRev += e.s.totalPrice;
        if (e.style) cur.styles.add(e.style);
        agg.set(k, cur);
      }
      for (const [label, v] of agg) {
        // LY for an aggregate row = sum of lyRevByStyle for every style
        // touched by the rolled-up SOs. Same-style dedup is implicit
        // because Set keys are unique.
        let lyQty = 0, lyRev = 0, lyMrgn = 0;
        for (const st of v.styles) {
          const ent = lyRevByStyle.get(st);
          if (!ent) continue;
          lyQty += ent.qty; lyRev += ent.rev; lyMrgn += ent.mrgn;
        }
        out.push({
          kind: "row", key: label, label,
          tyQty: v.tyQty, tyRev: v.tyRev, tyMrgn: 0,
          lyQty, lyRev, lyMrgn,
        });
      }
      out.sort((a, b) => b.tyRev - a.tyRev);
    }
    return out;
  }, [excelData, result, viewBy, customer, selStores, selCategories, selSubCategories, selStyles, selGenders, start, end, lyRevByStyle]);

  // Per-customer rows for the Summary view. Sorted by TY revenue
  // descending so the biggest customers appear first. Dropped rows
  // where neither TY nor LY had any sales — they'd be noise.
  const customerRows = useMemo(() => {
    if (!result?.byCustomer) return [];
    type CRow = { customer: string; tyQty: number; tyRev: number; tyMrgn: number; lyQty: number; lyRev: number; lyMrgn: number };
    const out: CRow[] = [];
    for (const entry of result.byCustomer.values()) {
      if (entry.t3.totalPrice <= 0 && entry.ly.totalPrice <= 0) continue;
      out.push({
        customer: entry.customerName,
        tyQty: entry.t3.qty, tyRev: entry.t3.totalPrice, tyMrgn: entry.t3.marginAmount,
        lyQty: entry.ly.qty, lyRev: entry.ly.totalPrice, lyMrgn: entry.ly.marginAmount,
      });
    }
    return out.sort((a, b) => Math.max(b.tyRev, b.lyRev) - Math.max(a.tyRev, a.lyRev));
  }, [result]);

  if (!open) return null;

  const run = async () => {
    setRangeWarn(false);
    setError(null);
    if (!start || !end || start > end) { setRangeWarn(true); return; }
    setRunning(true);
    try {
      const r = await fetchSalesAggregates({
        rows, needT3: true, needLY: true,
        customer:          customer[0] || "",
        customStart:       start,
        customEnd:         end,
        storeFilter:       selStores.length > 0 ? selStores : undefined,
        filterCategory:    selCategories.length > 0 ? selCategories : undefined,
        filterSubCategory: selSubCategories.length > 0 ? selSubCategories : undefined,
        filterStyle:       selStyles.length > 0 ? selStyles : undefined,
        filterGender:      selGenders.length > 0 ? selGenders : undefined,
        // Pull per-customer rollup so Summary mode can render a
        // customer-by-customer breakdown alongside the grand total.
        // Cheap — one extra batched ip_customer_master lookup, no
        // extra sales-history round trip.
        needByCustomer:    true,
      });
      setResult(r);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setRunning(false);
    }
  };

  const reset = () => { setResult(null); setError(null); };
  // Clear button on the selection step. Resets everything back to
  // defaults — dates back to YTD, every filter dropdown empty, view-by
  // back to Customer, customer-facing off. Operator can start fresh
  // without closing + reopening the modal.
  const clearAll = () => {
    setStart(yearStartIso());
    setEnd(todayIso());
    setCustomer([]);
    setSelCategories([]);
    setSelSubCategories([]);
    setSelStyles([]);
    setSelStores([]);
    setSelGenders([]);
    setViewBy(["customer"]);
    setCustomerFacing(false);
    setRangeWarn(false);
    setError(null);
  };

  const downloadExcel = () => {
    if (!result) return;
    const scope = [
      customer[0] && `customer ${customer[0]}`,
      selStores.length > 0 && `stores ${selStores.join("/")}`,
      selCategories.length > 0 && `categories ${selCategories.join("/")}`,
      selSubCategories.length > 0 && `sub-cats ${selSubCategories.join("/")}`,
      selStyles.length > 0 && `styles ${selStyles.join("/")}`,
    ].filter(Boolean).join(" · ") || "all";
    const aoa: (string | number)[][] = [
      ["Sales Comps"],
      [`TY window: ${start} → ${end}`],
      [`LY window: ${isoMinusMonths(start, 12)} → ${isoMinusMonths(end, 12)}`],
      [`Scope: ${scope}${customerFacing ? "  (customer-facing — margin hidden)" : ""}`],
      [],
      ["", "TY", "LY", "Δ"],
      ["Units",   totals.tyQty,   totals.lyQty,   fmtGrowth(totals.tyQty,  totals.lyQty).text],
      ["Revenue", totals.tyRev,   totals.lyRev,   fmtGrowth(totals.tyRev,  totals.lyRev).text],
    ];
    if (!customerFacing) {
      aoa.push(["COGS",    totals.tyCogs,  totals.lyCogs,  fmtGrowth(totals.tyCogs, totals.lyCogs).text]);
      aoa.push(["Margin $", totals.tyMrgn, totals.lyMrgn,  fmtGrowth(totals.tyMrgn, totals.lyMrgn).text]);
      aoa.push(["Margin %",
        totals.tyRev > 0 ? totals.tyMrgn / totals.tyRev : 0,
        totals.lyRev > 0 ? totals.lyMrgn / totals.lyRev : 0,
        fmtMarginPoints(totals.tyMrgn, totals.tyRev, totals.lyMrgn, totals.lyRev).text]);
    }
    aoa.push([]);
    // One table per selected View By dimension. SO is skipped (data
    // model TBD — see modal placeholder).
    for (const dim of viewBy) {
      if (dim === "so") {
        aoa.push([`-- ${VIEW_BY_LABELS[dim]} -- (data model TBD; placeholder)`]);
        aoa.push([]);
        continue;
      }
      const dataRows = groupedRowsFor(dim, tableRows, customerRows);
      aoa.push([`-- ${VIEW_BY_LABELS[dim]} --`]);
      const header: string[] = customerFacing
        ? [VIEW_BY_LABELS[dim], "TY Qty", "TY Rev", "LY Qty", "LY Rev", "Δ Rev"]
        : [VIEW_BY_LABELS[dim], "TY Qty", "TY Rev", "TY Cogs", "TY Mrgn $", "TY Mrgn %", "LY Qty", "LY Rev", "LY Cogs", "LY Mrgn $", "LY Mrgn %", "Δ Rev", "Δ Margin pp"];
      aoa.push(header);
      for (const r of dataRows) {
        if (customerFacing) {
          aoa.push([r.label, r.tyQty, r.tyRev, r.lyQty, r.lyRev, fmtGrowth(r.tyRev, r.lyRev).text]);
        } else {
          aoa.push([
            r.label,
            r.tyQty, r.tyRev, r.tyRev - r.tyMrgn, r.tyMrgn,
            r.tyRev > 0 ? r.tyMrgn / r.tyRev : 0,
            r.lyQty, r.lyRev, r.lyRev - r.lyMrgn, r.lyMrgn,
            r.lyRev > 0 ? r.lyMrgn / r.lyRev : 0,
            fmtGrowth(r.tyRev, r.lyRev).text,
            fmtMarginPoints(r.tyMrgn, r.tyRev, r.lyMrgn, r.lyRev).text,
          ]);
        }
      }
      // Per-view TOTAL row — sums always equal the grand totals across
      // dimensions, but repeating the row inside each section keeps each
      // table self-contained in the spreadsheet.
      if (dataRows.length > 0) {
        if (customerFacing) {
          aoa.push(["TOTAL", totals.tyQty, totals.tyRev, totals.lyQty, totals.lyRev, fmtGrowth(totals.tyRev, totals.lyRev).text]);
        } else {
          aoa.push([
            "TOTAL",
            totals.tyQty, totals.tyRev, totals.tyCogs, totals.tyMrgn,
            totals.tyRev > 0 ? totals.tyMrgn / totals.tyRev : 0,
            totals.lyQty, totals.lyRev, totals.lyCogs, totals.lyMrgn,
            totals.lyRev > 0 ? totals.lyMrgn / totals.lyRev : 0,
            fmtGrowth(totals.tyRev, totals.lyRev).text,
            fmtMarginPoints(totals.tyMrgn, totals.tyRev, totals.lyMrgn, totals.lyRev).text,
          ]);
        }
      }
      aoa.push([]);
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, "Sales Comps");
    const cfSuffix = customerFacing ? "_customer" : "";
    XLSX.writeFile(wb, `SalesComps_${start}_to_${end}${cfSuffix}.xlsx`);
  };

  const scopeLine = [
    customer[0] && `customer ${customer[0]}`,
    selStores.length > 0 && `stores ${selStores.join("/")}`,
    selCategories.length > 0 && `categories ${selCategories.length}`,
    selSubCategories.length > 0 && `sub-cats ${selSubCategories.length}`,
    selStyles.length > 0 && `styles ${selStyles.length}`,
  ].filter(Boolean).join(" · ") || "all";

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div style={{ position: "relative", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, minWidth: 540, maxWidth: result ? 920 : 560, maxHeight: "90vh", color: C.text, fontFamily: "inherit", boxShadow: "0 16px 48px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.accent, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Sales Comps {result && <span style={{ color: C.textMuted, fontWeight: 400, textTransform: "none", letterSpacing: 0, marginLeft: 8 }}>— results · {viewBy.map(v => VIEW_BY_LABELS[v]).join(" + ")}</span>}
          </div>
          <button style={{ background: "none", border: "none", color: C.textDim, fontSize: 18, cursor: "pointer", padding: "2px 6px", borderRadius: 4 }} onClick={onClose} title="Close">✕</button>
        </div>

        {/* Loading overlay shown during the 10–15s fetch. Sits inside
            the modal body so the operator can still see the selection
            form context behind it. Centered spinner + status text +
            estimated time. Pointer-events:none so click-outside on
            backdrop still works to cancel. */}
        {running && (
          <div style={{
            position: "absolute", inset: 0, background: "rgba(15,23,42,0.85)",
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            gap: 14, zIndex: 1200, borderRadius: 12,
          }}>
            <div style={{
              width: 42, height: 42, borderRadius: "50%",
              border: `3px solid ${C.border}`, borderTopColor: C.accent,
              animation: "salescomps-spin 0.8s linear infinite",
            }} />
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>Fetching sales history…</div>
            <div style={{ fontSize: 11, color: C.textMuted, maxWidth: 320, textAlign: "center", lineHeight: 1.4 }}>
              Typically 10–15 seconds. Pulling the {start} → {end} window plus the LY-shifted comparison, then aggregating per-customer + per-style.
            </div>
            <style>{`@keyframes salescomps-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {!result && (
          <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
            <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.45 }}>
              Compares the date range you pick against the same range shifted 12 months back. Filters default to whatever the grid has on right now — change them here to broaden or narrow the report.
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, color: C.textMuted, fontWeight: 600, display: "block", marginBottom: 4 }}>Start (TY)</label>
                <AppDatePicker value={start} onCommit={setStart} style={inputStyle} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: C.textMuted, fontWeight: 600, display: "block", marginBottom: 4 }}>End (TY)</label>
                <AppDatePicker value={end} onCommit={setEnd} style={inputStyle} />
              </div>
            </div>
            <div style={{ fontSize: 11, color: C.textDim, marginTop: -8 }}>
              LY window auto-computes: {isoMinusMonths(start, 12)} → {isoMinusMonths(end, 12)}
            </div>

            {rangeWarn && <div style={{ fontSize: 12, color: C.red, fontWeight: 600 }}>Start date must be on or before End date.</div>}

            {/* 3-column grid for the 6 filter dropdowns so the whole
                form fits in ~90vh without scrolling — keeps the Output
                section above the fold even when DevTools is open. */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <SelectField label="Customer" value={customer} options={customers} onChange={setCustomer} multi />
              <SelectField label="Stores" value={selStores} options={stores} onChange={setSelStores} multi />
              <SelectField label="Category" value={selCategories} options={categories} onChange={setSelCategories} multi />
              <SelectField label="Sub-Category" value={selSubCategories} options={subCategories} onChange={setSelSubCategories} multi />
              <SelectField label="Style" value={selStyles} options={styles} onChange={setSelStyles} multi />
              <SelectField label="Gender" value={selGenders} options={genders} onChange={setSelGenders} multi />
            </div>

            <fieldset style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 12px", margin: 0 }}>
              <legend style={{ fontSize: 11, color: C.textMuted, padding: "0 4px", fontWeight: 600 }}>Output</legend>
              <div title="Each selected dimension renders its own comparison table in the results. Pick one to focus, several to stack breakdowns. SO is an open-SO comparison anchored to the SO's cancel date.">
                <SelectField<ViewByKey>
                  label="View By"
                  value={viewBy}
                  options={VIEW_BY_OPTIONS}
                  onChange={(next) => setViewBy(next.length === 0 ? ["customer"] : next)}
                  multi
                  hint="Pick one or more dimensions — each renders its own table"
                  optionLabel={k => VIEW_BY_LABELS[k]}
                />
              </div>
              <label title="Hide COGS / Margin $ / Margin % from the report and Excel export — safe to share externally" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
                <input type="checkbox" checked={customerFacing} onChange={e => setCustomerFacing(e.target.checked)} />
                <strong>Customer-facing</strong>
              </label>
            </fieldset>

            {error && <div style={{ fontSize: 12, color: C.red, fontWeight: 600 }}>Fetch failed: {error}</div>}

            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 4, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
              <button onClick={clearAll} title="Reset all filters + date range + view options to defaults" style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.textMuted, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 12 }}>Clear</button>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={onClose} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.text, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>Cancel</button>
                <button onClick={run} disabled={running} style={{ background: C.accent, border: `1px solid ${C.accent}`, color: "#001A12", padding: "8px 18px", borderRadius: 6, cursor: running ? "wait" : "pointer", fontSize: 13, fontWeight: 600, opacity: running ? 0.6 : 1 }}>
                  {running ? "Running…" : "Run Comp"}
                </button>
              </div>
            </div>
          </div>
        )}

        {result && (
          <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
            <SummaryBlock totals={totals} customerFacing={customerFacing} />

            <div style={{ fontSize: 11, color: C.textDim }}>
              Window: {start} → {end} (TY) · {tableRows.length} SKUs · {viewBy.length} view{viewBy.length === 1 ? "" : "s"} · scope: {scopeLine}{customerFacing ? " · customer-facing (margin hidden)" : ""}
            </div>

            {/* Render one CompsTable per selected View By dimension.
                The grouping logic for each dimension lives in
                groupedRowsFor — sku/style/category/sub_category use the
                item-master cache; customer uses the byCustomer rollup
                from the fetch; SO is a placeholder pending the open-SO
                data model. */}
            {viewBy.map(dim => {
              if (dim === "so") {
                return (
                  <div key={dim} style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: "14px 16px", color: C.textMuted, fontSize: 12, lineHeight: 1.5 }}>
                    <div style={{ fontWeight: 700, color: C.text, marginBottom: 4 }}>SO view — open SOs vs LY ship $</div>
                    Coming next. The data model for this view (matching open SOs to last-year shipped \$ using each SO's cancel_date as the anchor) needs alignment with the open-SO dataset before the table can render. Pick another View By dimension for now.
                  </div>
                );
              }
              const built = groupedRowsFor(dim, tableRows, customerRows);
              return (
                <CompsTable
                  key={dim}
                  colLabel={VIEW_BY_LABELS[dim]}
                  rows={built}
                  totals={totals}
                  customerFacing={customerFacing}
                />
              );
            })}

            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, paddingTop: 6, borderTop: `1px solid ${C.border}` }}>
              <button onClick={downloadExcel} style={{ background: "#1D6F42", border: "1px solid #155734", color: "#fff", padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>↓ Download Excel</button>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={reset} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.text, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>← Back</button>
                <button onClick={onClose} style={{ background: C.accent, border: `1px solid ${C.accent}`, color: "#001A12", padding: "8px 18px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Done</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Build a CompsTable rows array for one of the simple View By
// dimensions. SKU/customer pass through; style/category/sub_category
// look the dimension value up via the item-master cache + group the
// per-SKU rows. Rows without a resolvable dimension value land under
// "(no <dim>)" so the operator can see how much money is unattributed.
function groupedRowsFor(
  dim: Exclude<ViewByKey, "so">,
  skuRows: AggRow[],
  customerRows: Array<{ customer: string; tyQty: number; tyRev: number; tyMrgn: number; lyQty: number; lyRev: number; lyMrgn: number }>,
): Array<{ key: string; label: string; tyQty: number; tyRev: number; tyMrgn: number; lyQty: number; lyRev: number; lyMrgn: number }> {
  if (dim === "sku") {
    return skuRows.map(r => ({ key: r.sku, label: r.sku, tyQty: r.tyQty, tyRev: r.tyRev, tyMrgn: r.tyMrgn, lyQty: r.lyQty, lyRev: r.lyRev, lyMrgn: r.lyMrgn }));
  }
  if (dim === "customer") {
    return customerRows.map(c => ({ key: c.customer, label: c.customer, tyQty: c.tyQty, tyRev: c.tyRev, tyMrgn: c.tyMrgn, lyQty: c.lyQty, lyRev: c.lyRev, lyMrgn: c.lyMrgn }));
  }
  const acc = new Map<string, { tyQty: number; tyRev: number; tyMrgn: number; lyQty: number; lyRev: number; lyMrgn: number }>();
  for (const r of skuRows) {
    // Look up the dimension value via the master cache. sku-keyed
    // lookup — first variant id under that sku string.
    const ids = resolveItemMasterIds(r.sku);
    let label: string | null = null;
    for (const id of ids) {
      const rec = getItemMasterById(id);
      if (!rec) continue;
      if (dim === "style")        label = rec.style_code ?? null;
      if (dim === "category")     label = rec.attributes?.group_name    ?? null;
      if (dim === "sub_category") label = rec.attributes?.category_name ?? null;
      if (label) break;
    }
    const key = label ?? `(no ${VIEW_BY_LABELS[dim].toLowerCase()})`;
    const cur = acc.get(key) ?? { tyQty: 0, tyRev: 0, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 };
    cur.tyQty += r.tyQty; cur.tyRev += r.tyRev; cur.tyMrgn += r.tyMrgn;
    cur.lyQty += r.lyQty; cur.lyRev += r.lyRev; cur.lyMrgn += r.lyMrgn;
    acc.set(key, cur);
  }
  return [...acc.entries()]
    .map(([k, v]) => ({ key: k, label: k, ...v }))
    .sort((a, b) => Math.max(b.tyRev, b.lyRev) - Math.max(a.tyRev, a.lyRev));
}

function th(align: "left" | "right" = "left"): React.CSSProperties {
  return { textAlign: align, padding: "8px 10px", fontSize: 11, fontWeight: 600, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.04em" };
}
function td(align: "left" | "right" = "left", color: string = C.text): React.CSSProperties {
  return { textAlign: align, padding: "6px 10px", fontSize: 12, color, borderTop: `1px solid ${C.border}` };
}

// Shared comparison table used by both Summary (per-customer) and
// Detailed (per-SKU) views. Same column shape; the only difference
// is the leftmost dimension. Bottom TOTAL row is computed from the
// `totals` prop so it matches the SummaryBlock at the top exactly.
interface CompsRow { key: string; label: string; tyQty: number; tyRev: number; tyMrgn: number; lyQty: number; lyRev: number; lyMrgn: number }
interface CompsTotals { tyQty: number; tyRev: number; tyMrgn: number; lyQty: number; lyRev: number; lyMrgn: number }
function CompsTable({ colLabel, rows, totals, customerFacing }: { colLabel: string; rows: CompsRow[]; totals: CompsTotals; customerFacing: boolean }): React.ReactElement {
  const totalGrowth = fmtGrowth(totals.tyRev, totals.lyRev);
  const totalMp = fmtMarginPoints(totals.tyMrgn, totals.tyRev, totals.lyMrgn, totals.lyRev);
  return (
    <div style={{ flex: 1, minHeight: 280, maxHeight: "48vh", overflowY: "auto", border: `1px solid ${C.border}`, borderRadius: 8 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead style={{ position: "sticky", top: 0, background: C.surface, zIndex: 1 }}>
          <tr style={{ borderBottom: `1px solid ${C.border}` }}>
            <th style={th()}>{colLabel}</th>
            <th style={th("right")}>TY Qty</th>
            <th style={th("right")}>TY Rev</th>
            {!customerFacing && <th style={th("right")}>TY Mrgn%</th>}
            <th style={th("right")}>LY Qty</th>
            <th style={th("right")}>LY Rev</th>
            {!customerFacing && <th style={th("right")}>LY Mrgn%</th>}
            <th style={th("right")}>Δ Rev</th>
            {!customerFacing && <th style={th("right")}>Δ Mrgn pp</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const growth = fmtGrowth(r.tyRev, r.lyRev);
            const mp = fmtMarginPoints(r.tyMrgn, r.tyRev, r.lyMrgn, r.lyRev);
            return (
              <tr key={r.key} style={{ background: i % 2 === 0 ? "transparent" : C.rowAlt }}>
                <td style={td()}>{r.label}</td>
                <td style={td("right")}>{r.tyQty.toLocaleString()}</td>
                <td style={td("right")}>{fmtUSD(r.tyRev)}</td>
                {!customerFacing && <td style={td("right")}>{fmtPct(r.tyMrgn, r.tyRev)}</td>}
                <td style={td("right", C.textMuted)}>{r.lyQty.toLocaleString()}</td>
                <td style={td("right", C.textMuted)}>{fmtUSD(r.lyRev)}</td>
                {!customerFacing && <td style={td("right", C.textMuted)}>{fmtPct(r.lyMrgn, r.lyRev)}</td>}
                <td style={{ ...td("right"), color: growth.positive ? C.green : C.red, fontWeight: 600 }}>{growth.text}</td>
                {!customerFacing && <td style={{ ...td("right"), color: mp.positive ? C.green : C.red, fontWeight: 600 }}>{mp.text}</td>}
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan={customerFacing ? 6 : 9} style={{ ...td(), color: C.textDim, textAlign: "center", padding: 18 }}>No sales in window for this scope.</td></tr>
          )}
          {/* Bottom TOTAL row — sums match the per-row sums above. Sticky-ish bold styling so the operator can find it at a glance. */}
          {rows.length > 0 && (
            <tr style={{ background: C.surface, borderTop: `2px solid ${C.border}`, fontWeight: 700 }}>
              <td style={{ ...td(), fontWeight: 700, color: C.accent }}>TOTAL</td>
              <td style={{ ...td("right"), fontWeight: 700 }}>{totals.tyQty.toLocaleString()}</td>
              <td style={{ ...td("right"), fontWeight: 700 }}>{fmtUSD(totals.tyRev)}</td>
              {!customerFacing && <td style={{ ...td("right"), fontWeight: 700 }}>{fmtPct(totals.tyMrgn, totals.tyRev)}</td>}
              <td style={{ ...td("right", C.textMuted), fontWeight: 700 }}>{totals.lyQty.toLocaleString()}</td>
              <td style={{ ...td("right", C.textMuted), fontWeight: 700 }}>{fmtUSD(totals.lyRev)}</td>
              {!customerFacing && <td style={{ ...td("right", C.textMuted), fontWeight: 700 }}>{fmtPct(totals.lyMrgn, totals.lyRev)}</td>}
              <td style={{ ...td("right"), color: totalGrowth.positive ? C.green : C.red, fontWeight: 700 }}>{totalGrowth.text}</td>
              {!customerFacing && <td style={{ ...td("right"), color: totalMp.positive ? C.green : C.red, fontWeight: 700 }}>{totalMp.text}</td>}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// Five-row summary block (Units, Revenue, COGS, Margin $, Margin %).
// Used in both view modes — same totals appear regardless. Detailed
// mode renders the per-SKU table below this. When customerFacing is
// true, COGS / Margin $ / Margin % are dropped so the report can be
// shared externally.
function SummaryBlock({ totals, customerFacing }: { totals: { tyQty: number; tyRev: number; tyMrgn: number; tyCogs: number; lyQty: number; lyRev: number; lyMrgn: number; lyCogs: number }; customerFacing: boolean }): React.ReactElement {
  const allRows: Array<{ label: string; ty: string; ly: string; diff: { text: string; positive: boolean }; tone?: "muted"; internalOnly?: boolean }> = [
    { label: "Units",    ty: totals.tyQty.toLocaleString(),       ly: totals.lyQty.toLocaleString(),       diff: fmtGrowth(totals.tyQty,  totals.lyQty)  },
    { label: "Revenue",  ty: fmtUSD(totals.tyRev),                ly: fmtUSD(totals.lyRev),                diff: fmtGrowth(totals.tyRev,  totals.lyRev)  },
    { label: "COGS",     ty: fmtUSD(totals.tyCogs),               ly: fmtUSD(totals.lyCogs),               diff: fmtGrowth(totals.tyCogs, totals.lyCogs), tone: "muted", internalOnly: true },
    { label: "Margin $", ty: fmtUSD(totals.tyMrgn),               ly: fmtUSD(totals.lyMrgn),               diff: fmtGrowth(totals.tyMrgn, totals.lyMrgn), internalOnly: true },
    { label: "Margin %", ty: fmtPct(totals.tyMrgn, totals.tyRev), ly: fmtPct(totals.lyMrgn, totals.lyRev), diff: fmtMarginPoints(totals.tyMrgn, totals.tyRev, totals.lyMrgn, totals.lyRev), internalOnly: true },
  ];
  const rows = customerFacing ? allRows.filter(r => !r.internalOnly) : allRows;
  return (
    <div style={{ background: C.rowAlt, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 16px" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${C.border}` }}>
            <th style={{ textAlign: "left",  padding: "4px 8px", fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Metric</th>
            <th style={{ textAlign: "right", padding: "4px 8px", fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>TY</th>
            <th style={{ textAlign: "right", padding: "4px 8px", fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>LY</th>
            <th style={{ textAlign: "right", padding: "4px 8px", fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Δ TY vs LY</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.label}>
              <td style={{ padding: "6px 8px", fontWeight: 600, color: r.tone === "muted" ? C.textMuted : C.text }}>{r.label}</td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: r.tone === "muted" ? C.textMuted : C.text }}>{r.ty}</td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: C.textMuted }}>{r.ly}</td>
              <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600, color: r.diff.positive ? C.green : C.red }}>{r.diff.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
