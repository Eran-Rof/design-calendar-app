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
import { AppDatePicker } from "../../shared/components/AppDatePicker";
import SearchableSelect from "../../tanda/components/SearchableSelect";
import { fetchSalesAggregates, type SalesFetchResult, type DailyStyleAgg } from "../exportSalesFetch";
import { getItemMasterById, resolveItemMasterIds } from "../itemMasterLookup";
import { fmtDateDisplay } from "../helpers";
import { estimateSoMargin, type SoCostInputs } from "../salesCompsSoMargin";
import { useCanSeeMargins } from "../../hooks/useCanSeeMargins";
import {
  aggregateExplodeAware,
  totalsForDimRows,
  type DimKind,
  type DimRow,
  type DimTotals,
  type RawSkuAgg,
} from "../salesCompsAggregate";
import {
  classifyMasterGrain,
  firstMasterFor,
  packSizeFor,
} from "../salesCompsGrain";
import {
  downloadSalesCompsWorkbook,
  computeSoCatchallRow,
  type SalesCompsExportInput,
  type SoRow as ExportSoRow,
} from "../salesCompsExport";
import type { ATSRow, ATSSoEvent, ExcelData } from "../types";

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
function isoShiftDays(iso: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// Per-SO LY window: ±30 days centered on the SO's cancel date shifted
// back 12 months. Each SO row in the TY-vs-LY-SOs table compares its
// open commitment against shipments of the same style inside this
// window, so two SOs of the same style with different cancel dates
// produce different LY numbers (instead of every row showing the same
// full-window style total).
const SO_LY_WINDOW_DAYS = 30;
function lyWindowForCancelDate(cancelDate: string): { start: string; end: string } {
  const anchor = isoMinusMonths(cancelDate, 12);
  return { start: isoShiftDays(anchor, -SO_LY_WINDOW_DAYS), end: isoShiftDays(anchor, SO_LY_WINDOW_DAYS) };
}
// Sum a style's daily LY entries that fall within [winStart, winEnd].
// The arr is pre-sorted by date so we can break early when we pass the
// upper bound; a linear scan is fine — per-style arrays carry only the
// LY-window days for that style and are small in practice.
function sumLyInWindow(
  arr: DailyStyleAgg[] | undefined,
  winStart: string,
  winEnd: string,
): { qty: number; rev: number; mrgn: number } {
  if (!arr) return { qty: 0, rev: 0, mrgn: 0 };
  let qty = 0, rev = 0, mrgn = 0;
  for (const e of arr) {
    if (e.date < winStart) continue;
    if (e.date > winEnd) break;
    qty += e.qty; rev += e.totalPrice; mrgn += e.marginAmount;
  }
  return { qty, rev, mrgn };
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
  sku:          "Style/Color",
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
        <SearchableSelect
          value={single}
          onChange={v => onChange(v ? [v as T] : [])}
          options={[
            { value: "", label: "All" },
            ...options.map(o => ({ value: o, label: fmt(o) })),
          ]}
          inputStyle={inputStyle}
        />
      </div>
    );
  }

  const filtered = search.trim() === ""
    ? options
    // Match against the formatted label (e.g. "RYB1416 — ARENA Loose Relaxed")
    // so the operator can find a style by its description, not just its code.
    : options.filter(o => fmt(o).toLowerCase().includes(search.toLowerCase()));
  const summary = value.length === 0 ? "All" : value.length <= 2 ? value.map(fmt).join(", ") : `${value.length} selected`;
  const toggle = (o: T) => onChange(value.includes(o) ? value.filter(v => v !== o) : [...value, o]);

  // Mouse-leave close: a short grace period gives the operator room
  // to dart between the button and the popover (the ~4px gap between
  // them briefly leaves the wrap on the way through). 180ms is the
  // sweet spot — long enough to feel forgiving, short enough that
  // the dropdown still feels responsive when you walk away from it.
  const leaveTimerRef = useRef<number | null>(null);
  const cancelLeave = () => {
    if (leaveTimerRef.current != null) {
      window.clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
  };
  const scheduleClose = () => {
    cancelLeave();
    leaveTimerRef.current = window.setTimeout(() => setOpen(false), 180);
  };
  useEffect(() => () => cancelLeave(), []);

  return (
    <div
      ref={wrapRef}
      style={{ display: "flex", flexDirection: "column", gap: 4, position: "relative" }}
      onMouseLeave={open ? scheduleClose : undefined}
      onMouseEnter={cancelLeave}
    >
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
          // Grow to fit the widest option (e.g. "RYB1416 — ARENA Loose
          // Relaxed") rather than clamping to the field width, so the style
          // description is readable. At least the field width; capped so it
          // never runs off-screen.
          left: 0, right: "auto", minWidth: "100%", width: "max-content", maxWidth: "min(560px, 92vw)", zIndex: 1100,
          background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6,
          maxHeight: 260, display: "flex", flexDirection: "column", padding: 4,
          boxShadow: "0 6px 18px rgba(0,0,0,0.5)",
        }}>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onFocus={e => e.currentTarget.select()}
            placeholder="Search…"
            autoFocus
            style={{ ...inputStyle, padding: "5px 8px", fontSize: 12, marginBottom: 4 }}
          />
          <div style={{ overflowY: "auto", flex: 1 }}>
            {filtered.length === 0 && <div style={{ fontSize: 11, color: C.textDim, padding: 6 }}>No matches</div>}
            {filtered.map(o => (
              <label key={o} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", cursor: "pointer", fontSize: 12, color: C.text, borderRadius: 4 }} onMouseEnter={e => (e.currentTarget.style.background = "rgba(16,185,129,0.10)")} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                <input type="checkbox" checked={value.includes(o)} onChange={() => toggle(o)} />
                <span style={{ whiteSpace: "normal", wordBreak: "break-word" }}>{fmt(o)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface Props {
  // Parent is responsible for conditional-mounting this modal. Mount =
  // open, unmount = closed. That way every open is a fresh React mount
  // and the operator never sees stale results from a prior run.
  onClose: () => void;
  // Pre-selected scope from the grid's current filter state. Operator
  // can override any field via the dropdowns below.
  defaultCustomer: string;
  defaultCategories: string[];
  defaultSubCategories: string[];
  defaultStyles: string[];
  defaultStoreFilter: string[];
  // Gender filter — initial value for the Gender multi-select.
  defaultGenders?: string[];
  // Grid's current TY window. When provided, the Start / End date
  // pickers initialize to these values so the modal opens on the same
  // window the operator is looking at on the grid. Either undefined →
  // fall back to YTD defaults.
  defaultStart?: string;
  defaultEnd?: string;
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
  // Grid's current "Explode PPK" toggle. When true, Sales Comps
  // multiplies PPK-grain qty by master.pack_size everywhere and
  // collapses PPK + each siblings into one row per (style stem, color).
  // When false, qty stays in master's native grain and dim rows split
  // into one row per grain (with grain-labeled totals when mixed).
  // See src/ats/salesCompsAggregate.ts for the full behavior contract.
  explodePpk: boolean;
}

// One row in the SO view's table. Two shapes:
//   - `kind: "row"`: a real SO (or aggregated dimension) with the full
//     metadata block (order #, customer, cancel date) the SO-specific
//     columns render.
//   - `kind: "subtotal"`: synthetic per-style subtotal inserted under
//     a style group that has ≥ 2 distinct SOs. Carries only the
//     summed totals; the SO-specific metadata is omitted.
type SoRow = {
  kind: "row";
  key: string;
  label: string;
  style?: string;
  orderNumber?: string;
  customer?: string;
  cancelDate?: string;
  tyQty: number; tyRev: number; tyMrgn: number;
  lyQty: number; lyRev: number; lyMrgn: number;
} | {
  kind: "subtotal";
  key: string;
  label: string;
  tyQty: number; tyRev: number; tyMrgn: number;
  lyQty: number; lyRev: number; lyMrgn: number;
};

export const SalesCompsModal: React.FC<Props> = ({
  onClose,
  defaultCustomer, defaultCategories, defaultSubCategories, defaultStyles, defaultStoreFilter,
  defaultGenders, defaultStart, defaultEnd,
  allCategories, allSubCategories, allStyles, allStores,
  rows, excelData, explodePpk,
}) => {
  // Margin visibility gate (P14 RBAC `margins` capability): canView hides the
  // on-screen TY/LY Mrgn% + Δ Mrgn pp columns and the Margin $ / Margin %
  // summary rows (COGS stays — cost, not margin); canExport drops the same
  // from the Excel workbook via hideMargins. Fails open until enforcement.
  const { canView: canViewMargin, canExport: canExportMargin } = useCanSeeMargins();
  // Option lists come from the FULL dataset (not the filtered rows) so
  // operators can broaden the report past the grid's current scope.
  // Sorted for predictable presentation in the dropdowns.
  const categories    = useMemo(() => [...allCategories].sort(),    [allCategories]);
  const subCategories = useMemo(() => [...allSubCategories].sort(), [allSubCategories]);
  const styles        = useMemo(() => [...allStyles].sort(),        [allStyles]);
  // style_code → clean style description, sourced from the enriched grid rows
  // (master fields). Lets the Style picker show the description beside the code.
  const styleDescByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) {
      const code = (r.master_style ?? "").trim();
      const desc = (r.master_description ?? "").trim();
      if (code && desc && !m.has(code)) m.set(code, desc);
    }
    return m;
  }, [rows]);
  const styleOptionLabel = (code: string) => {
    const d = styleDescByCode.get(code);
    return d ? `${code} — ${d}` : code;
  };
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

  const [start, setStart] = useState(defaultStart || yearStartIso());
  const [end,   setEnd]   = useState(defaultEnd   || todayIso());
  const [customer, setCustomer]                 = useState<string[]>(defaultCustomer ? [defaultCustomer] : []);
  const [selCategories, setSelCategories]       = useState<string[]>(defaultCategories);
  const [selSubCategories, setSelSubCategories] = useState<string[]>(defaultSubCategories);
  const [selStyles, setSelStyles]               = useState<string[]>(defaultStyles);
  const [selStores, setSelStores]               = useState<string[]>(defaultStoreFilter);
  const [selGenders, setSelGenders]             = useState<string[]>(defaultGenders ?? []);
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

  // Cost-source maps for the SO margin estimator. Built ONCE per
  // window+filter change and handed into every estimateSoMargin call
  // below. Mirrors the ATS grid's own canonical cost chain
  // (ATS.tsx:970-995 — the marginDollars useMemo): snapshot avgCost
  // wins; PO weighted average across in-window POs (narrowed to the
  // modal's style filter) is the fallback; master.unit_cost is NOT
  // consulted.
  //
  // poWeightedAvgByStyle is keyed on master.style_code (not sku)
  // so new styles with multiple color / size variants pick up the
  // same PO cost across siblings — matches the operator's "covering
  // the same filtered styles" expectation. Filter chain on each PO:
  //   - p.unitCost > 0 (drops PO lines with no cost)
  //   - p.date inside [start, end] window (or unfiltered when no PO
  //     in the file carries a usable date — fallback noted in the
  //     code below)
  //   - resolved style passes the modal's selStyles filter (or all
  //     styles when selStyles is empty)
  // Weighted avg = Σ(qty × unitCost) / Σ(qty).
  const avgCostBySku = useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    if (!excelData) return m;
    for (const s of excelData.skus) {
      if (s.avgCost && s.avgCost > 0) m.set(s.sku, s.avgCost);
    }
    return m;
  }, [excelData]);

  const poWeightedAvgByStyle = useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    if (!excelData) return m;
    // Decide whether to enforce the date window. If NO PO in the
    // file carries a usable date string, an in-window filter would
    // produce an empty map and silently drop the fallback chain.
    // Fall back to "all open POs" in that case so cost coverage
    // doesn't disappear because of upstream data-quality gaps. The
    // common path (PO WIP nightly + Expected-Delivery-Date populated)
    // takes the strict in-window branch.
    const anyDated = excelData.pos.some(p => typeof p.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(p.date));
    const styleFilterActive = selStyles.length > 0;
    type Acc = { qtyCost: number; qty: number };
    const acc = new Map<string, Acc>();
    for (const p of excelData.pos) {
      if (!p.unitCost || p.unitCost <= 0) continue;
      if (!(Number(p.qty) > 0)) continue;
      if (anyDated) {
        if (!p.date || p.date < start || p.date > end) continue;
      }
      // Resolve the PO sku's style. resolveItemMasterIds may return
      // multiple ids on cross-grid hits; first record with a
      // style_code wins.
      const ids = resolveItemMasterIds(p.sku);
      let style: string | null = null;
      for (const id of ids) {
        const rec = getItemMasterById(id);
        if (rec?.style_code) { style = rec.style_code; break; }
      }
      if (!style) continue;
      if (styleFilterActive && !selStyles.includes(style)) continue;
      const cur = acc.get(style) ?? { qtyCost: 0, qty: 0 };
      cur.qtyCost += p.qty * p.unitCost;
      cur.qty += p.qty;
      acc.set(style, cur);
    }
    for (const [style, a] of acc) {
      if (a.qty > 0) m.set(style, a.qtyCost / a.qty);
    }
    return m;
  }, [excelData, start, end, selStyles]);

  // Pre-bind the cost-source inputs into one object that's reused
  // across every estimator call in this render — keeps the per-row
  // call sites compact and ensures the lookups stay in lockstep with
  // the maps above.
  const soCostInputs = useMemo<SoCostInputs>(() => ({
    resolveIds: resolveItemMasterIds,
    getMaster: getItemMasterById,
    avgCostBySku,
    poWeightedAvgByStyle,
  }), [avgCostBySku, poWeightedAvgByStyle]);

  // Per-customer + per-SKU aggregation of OPEN SOs in the picked
  // window. Sourced from excelData.sos with the same scope filter
  // chain as soRows. Folded into the per-customer + per-SKU summary
  // tables below so that a forward-looking window (where TY shipped
  // is empty by definition — those days haven't happened yet) still
  // shows meaningful TY numbers from open commitments. For mostly-
  // past windows the SOs all have cancel dates ≥ today so they
  // contribute 0 to the window and this is a no-op.
  //
  // Margin contribution: ATSSoEvent doesn't carry a cost field, so
  // estimateSoMargin pulls per-each cost via soCostInputs (snapshot
  // avgCost → in-window PO weighted avg; see the maps above).
  // When cost can't be resolved the row's margin contribution is 0
  // — the qty / revenue still merge, and coverage.costMissing is
  // bumped so the caveat line below the totals can surface
  // "M had no resolvable cost".
  const openSoAggregates = useMemo(() => {
    const byCustomer = new Map<string, { qty: number; rev: number; mrgn: number }>();
    const bySkuCode = new Map<string, { qty: number; rev: number; mrgn: number }>();
    // Per-(customer, sku_code) breakdown — required for grain-aware
    // customer dim aggregation. SO qty/rev/mrgn folded per pair so the
    // customer aggregator can classify grain via the SKU's master and
    // split (or collapse) the customer's open-SO contribution along the
    // same explodePpk policy used elsewhere.
    const byCustomerSku = new Map<string, Map<string, { qty: number; rev: number; mrgn: number }>>();
    const coverage = { contributing: 0, costResolved: 0, costMissing: 0 };
    if (!excelData) return { byCustomer, bySkuCode, byCustomerSku, coverage };
    const want = (set: string[], v: string | null | undefined) => set.length === 0 || (v != null && set.includes(v));
    for (const s of excelData.sos) {
      const filterDate = s.cancelDate || s.date;
      if (!filterDate || filterDate < start || filterDate > end) continue;
      if (!want(selStores, s.store)) continue;
      if (customer.length > 0 && !customer.includes(s.customerName)) continue;
      const ids = resolveItemMasterIds(s.sku);
      let style: string | null = null, cat: string | null = null, subCat: string | null = null, gender: string | null = null;
      let skuCode: string | null = null;
      for (const id of ids) {
        const rec = getItemMasterById(id);
        if (!rec) continue;
        if (!skuCode) skuCode = rec.sku_code ?? null;
        style = style ?? rec.style_code ?? null;
        cat = cat ?? rec.attributes?.group_name ?? null;
        subCat = subCat ?? rec.attributes?.category_name ?? null;
        gender = gender ?? rec.attributes?.gender ?? null;
        if (skuCode && style && cat && subCat && gender) break;
      }
      if (!want(selCategories, cat))       continue;
      if (!want(selSubCategories, subCat)) continue;
      if (!want(selStyles, style))         continue;
      if (!want(selGenders, gender))       continue;

      // Estimate per-row margin from master cost. costResolved feeds
      // the caveat-line counter; the margin gets folded into the
      // customer + sku rollups so downstream TY MRGN% is meaningful
      // on forward windows.
      const est = estimateSoMargin(s.sku, s.qty, s.totalPrice, soCostInputs);
      coverage.contributing += 1;
      if (est.costResolved) coverage.costResolved += 1;
      else                  coverage.costMissing  += 1;

      // Qty stays in master's native grain here — explodePpk
      // multiplication is applied uniformly at the dim aggregation
      // step (aggregateExplodeAware) so SKU/style/category dims share
      // the same explode policy as the customer dim (and so we don't
      // double-multiply when openSoAggregates feeds into the per-sku
      // raw aggregate downstream).
      const custKey = s.customerName || "(no customer)";
      const cc = byCustomer.get(custKey) ?? { qty: 0, rev: 0, mrgn: 0 };
      cc.qty += s.qty; cc.rev += s.totalPrice; cc.mrgn += est.margin;
      byCustomer.set(custKey, cc);

      if (skuCode) {
        const ss = bySkuCode.get(skuCode) ?? { qty: 0, rev: 0, mrgn: 0 };
        ss.qty += s.qty; ss.rev += s.totalPrice; ss.mrgn += est.margin;
        bySkuCode.set(skuCode, ss);

        // (customer, sku_code) folding — feeds the grain-aware
        // customer dim aggregator. Unresolved sku_code (master miss)
        // drops here; falls into the customer-totals slot via the
        // first byCustomer write above so grand totals stay correct,
        // it just can't contribute per-grain detail.
        let perCust = byCustomerSku.get(custKey);
        if (!perCust) { perCust = new Map(); byCustomerSku.set(custKey, perCust); }
        const cs = perCust.get(skuCode) ?? { qty: 0, rev: 0, mrgn: 0 };
        cs.qty += s.qty; cs.rev += s.totalPrice; cs.mrgn += est.margin;
        perCust.set(skuCode, cs);
      }
    }
    return { byCustomer, bySkuCode, byCustomerSku, coverage };
  }, [excelData, customer, selStores, selCategories, selSubCategories, selStyles, selGenders, start, end, soCostInputs]);

  // Raw per-SKU aggregate, keyed by sku_code (BASE-COLOR). qty stays
  // in master's native grain (packs for PPK-grain SKUs, eaches for
  // each-grain). Revenue and margin are always in dollars. This is the
  // input to aggregateExplodeAware, which applies the explodePpk
  // multiplication + sibling collapse (ON) or per-grain split (OFF)
  // uniformly across every dimension downstream.
  //
  // Entries we can't resolve to a real master record are dropped —
  // "only show styles" per the spec.
  const rawSkuAggs = useMemo<RawSkuAgg[]>(() => {
    if (!result) return [];
    const map = new Map<string, RawSkuAgg>();
    const ensure = (sku: string): RawSkuAgg => {
      const cur = map.get(sku);
      if (cur) return cur;
      const fresh: RawSkuAgg = { sku, tyQty: 0, tyRev: 0, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 };
      map.set(sku, fresh);
      return fresh;
    };
    // fetchSalesAggregates feeds qty in UNIT GRAIN (qty_units = eaches —
    // see exportSalesFetch.ts:807). The downstream aggregator
    // (aggregateExplodeAware) expects NATIVE GRAIN (packs for PPK, eaches
    // for each) so its explode multiplier doesn't double-count. Convert
    // back here: divide PPK SKU qty by pack_size; each-grain SKUs are a
    // no-op (pack_size=1). Verified 2026-05-27: every nightly-synced PPK
    // row has qty_units == qty * pack_size, so dividing eaches by
    // pack_size cleanly recovers the original pack count.
    const toNativeGrain = (sku: string, eachesQty: number): number => {
      const master = firstMasterFor(sku, resolveItemMasterIds, getItemMasterById);
      const ps = classifyMasterGrain(master) === "ppk" ? packSizeFor(master) : 1;
      return ps > 1 ? eachesQty / ps : eachesQty;
    };
    for (const [sku, a] of result.t3) {
      const r = ensure(sku);
      r.tyQty += toNativeGrain(sku, a.qty);
      r.tyRev += a.totalPrice;
      r.tyMrgn += a.marginAmount;
    }
    for (const [sku, a] of result.ly) {
      const r = ensure(sku);
      r.lyQty += toNativeGrain(sku, a.qty);
      r.lyRev += a.totalPrice;
      r.lyMrgn += a.marginAmount;
    }
    for (const [skuId, e] of result.extraBySkuId) {
      const master = getItemMasterById(skuId);
      if (!master?.sku_code) continue; // drop unresolvable rows
      const r = ensure(master.sku_code);
      const ps = classifyMasterGrain(master) === "ppk" ? packSizeFor(master) : 1;
      const qDiv = ps > 1 ? ps : 1;
      r.tyQty += e.t3Qty / qDiv; r.tyRev += e.t3Total; r.tyMrgn += e.t3Margin;
      r.lyQty += e.lyQty / qDiv; r.lyRev += e.lyTotal; r.lyMrgn += e.lyMargin;
    }
    // Fold in open-SO contributions so a forward-looking window still
    // shows non-zero TY in the per-SKU / Style / Category breakdowns.
    // Margin is the estimated value from estimateSoMargin (cost from
    // item-master) — caveat surfaced below the totals when coverage
    // is partial.
    for (const [skuCode, agg] of openSoAggregates.bySkuCode) {
      const r = ensure(skuCode);
      r.tyQty += agg.qty;
      r.tyRev += agg.rev;
      r.tyMrgn += agg.mrgn;
    }
    return [...map.values()].filter(r => r.tyRev > 0 || r.lyRev > 0);
  }, [result, openSoAggregates]);

  // SKU-dim view: explode-aware rows. In explode-ON mode, PPK + each
  // siblings collapse to one row per (style stem, color) with qty in
  // eaches. In explode-OFF mode, each row stays per-sku in its native
  // grain with a "(PPK packs)" or "(each)" suffix appended to the label.
  const tableRows = useMemo<DimRow[]>(() =>
    aggregateExplodeAware({
      raw: rawSkuAggs, dim: "sku", explodePpk,
      resolveIds: resolveItemMasterIds, getMaster: getItemMasterById,
    }),
    [rawSkuAggs, explodePpk],
  );

  // Totals for the SummaryBlock. In explode-OFF mode with mixed grain,
  // we surface two totals rows (PPK packs vs each) so packs + eaches
  // never sum into a single misleading number. In explode-ON mode or
  // single-grain explode-OFF mode, one combined totals row is correct.
  const dimTotals = useMemo<DimTotals>(() => totalsForDimRows(tableRows, explodePpk), [tableRows, explodePpk]);
  // Combined totals — used by all explode-ON code paths + as the
  // single-row totals when only one grain is present in explode-OFF
  // mode. Mirrors the old `totals` shape so downstream consumers
  // (SummaryBlock, Excel export rows) don't have to change shape.
  const totals = dimTotals.combined;

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
    // SO view is built primarily from excelData.sos (open SOs). The
    // fetch result is only needed for the LY column. Don't gate on
    // `result` being truthy — even when the fetch returns empty or
    // fails, the operator still expects to see their open SOs.
    if (!excelData) return [];
    if (!viewBy.includes("so")) return [];
    const want = (set: string[], v: string | null | undefined) => set.length === 0 || (v != null && set.includes(v));
    // Resolve each open SO's master_style + master_category + master_sub_category
    // up front so we can apply scope filters without doing the lookup
    // multiple times per SO.
    const enriched: Array<{ s: ATSSoEvent; style: string | null; category: string | null; subCategory: string | null; gender: string | null; cancelDate: string; tyMrgn: number }> = [];
    for (const s of excelData.sos) {
      // The SO view filters on cancel_date per the operator spec
      // ("comp open SOs against ship dollars for the same selection
      // in prior year based on sales order cancel date"). Legacy SOs
      // uploaded before the May 2026 CancelDate-trim change won't
      // carry a cancel_date — fall back to `s.date` (DateToBeShipped)
      // so those uploads still show, even though the comparison is
      // technically anchored to the ship date for those rows.
      const filterDate = s.cancelDate || s.date;
      if (!filterDate || filterDate < start || filterDate > end) continue;
      if (!want(selStores, s.store)) continue;
      if (customer.length > 0 && !customer.includes(s.customerName)) continue;
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
      const tyMrgn = estimateSoMargin(s.sku, s.qty, s.totalPrice, soCostInputs).margin;
      enriched.push({ s, style, category: cat, subCategory: subCat, gender, cancelDate: filterDate, tyMrgn });
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
      // matching SKUs. LY is scoped to a ±30d window around the SO's
      // cancel date shifted -12mo (per the operator spec): two SOs of
      // the same style with different cancel dates produce different
      // LY numbers, rather than every row carrying the same full-window
      // style total.
      const perStyleSo = new Map<string, SoRow>();
      const lyDaily = result?.lyDailyByStyle;
      for (const e of enriched) {
        const styleKey = e.style ?? "(no style)";
        const composite = `${styleKey}::${e.s.orderNumber}`;
        const existing = perStyleSo.get(composite);
        if (existing) {
          existing.tyQty += e.s.qty;
          existing.tyRev += e.s.totalPrice;
          existing.tyMrgn += e.tyMrgn;
          continue;
        }
        const win = lyWindowForCancelDate(e.cancelDate);
        const lyEntry = e.style
          ? sumLyInWindow(lyDaily?.get(e.style), win.start, win.end)
          : { qty: 0, rev: 0, mrgn: 0 };
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
          // Estimated from item-master cost — see estimateSoMargin.
          // Caveat surfaced below the totals when coverage is partial.
          tyMrgn: e.tyMrgn,
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
            // Sum the estimated per-row margins — each row is its own
            // SO, so margins are additive (no double-count).
            tyMrgn: rows.reduce((s, r) => s + r.tyMrgn, 0),
            // Per-SO LY windows: each row carries its own ±30d slice of
            // LY shipments for this style. SOs with cancel dates >60d
            // apart have non-overlapping windows, so the subtotal must
            // SUM across rows (the old "same style → same LY → take
            // first" was correct only under the full-window LY rule).
            // Same-day-or-near-same SOs DO double-count overlapping LY
            // days here — acceptable tradeoff vs. losing per-row signal.
            lyQty: rows.reduce((s, r) => s + r.lyQty, 0),
            lyRev: rows.reduce((s, r) => s + r.lyRev, 0),
            lyMrgn: rows.reduce((s, r) => s + r.lyMrgn, 0),
          });
        }
      }
    } else if (groupBy === "so") {
      // Default: one row per SO order_number. Multiple SKUs / styles
      // on the same SO collapse — sum qty / totalPrice across them.
      // LY uses the SET of styles touched by the SO, scoped to a ±30d
      // window around the SO's cancel date shifted -12mo: two SOs of
      // the same style with different cancel dates produce different
      // LY (instead of every row carrying the same full-window total).
      const perOrder = new Map<string, { e: typeof enriched[number]; tyQty: number; tyRev: number; tyMrgn: number; styles: Set<string> }>();
      for (const e of enriched) {
        const cur = perOrder.get(e.s.orderNumber);
        if (cur) {
          cur.tyQty += e.s.qty;
          cur.tyRev += e.s.totalPrice;
          cur.tyMrgn += e.tyMrgn;
          if (e.style) cur.styles.add(e.style);
        } else {
          perOrder.set(e.s.orderNumber, {
            e,
            tyQty: e.s.qty,
            tyRev: e.s.totalPrice,
            tyMrgn: e.tyMrgn,
            styles: e.style ? new Set([e.style]) : new Set(),
          });
        }
      }
      const lyDaily = result?.lyDailyByStyle;
      for (const { e, tyQty, tyRev, tyMrgn, styles } of perOrder.values()) {
        const win = lyWindowForCancelDate(e.cancelDate);
        let lyQty = 0, lyRev = 0, lyMrgn = 0;
        for (const st of styles) {
          const ent = sumLyInWindow(lyDaily?.get(st), win.start, win.end);
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
          // Estimated margin from item-master cost — see estimateSoMargin.
          tyQty, tyRev, tyMrgn,
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
      const agg = new Map<string, { tyQty: number; tyRev: number; tyMrgn: number; styles: Set<string> }>();
      for (const e of enriched) {
        const k = dimGet(e);
        const cur = agg.get(k) ?? { tyQty: 0, tyRev: 0, tyMrgn: 0, styles: new Set<string>() };
        cur.tyQty += e.s.qty;
        cur.tyRev += e.s.totalPrice;
        cur.tyMrgn += e.tyMrgn;
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
          // Estimated margin from item-master cost — see estimateSoMargin.
          tyQty: v.tyQty, tyRev: v.tyRev, tyMrgn: v.tyMrgn,
          lyQty, lyRev, lyMrgn,
        });
      }
      out.sort((a, b) => b.tyRev - a.tyRev);
    }

    // Catch-all row: any style in lyRevByStyle that is NOT covered by
    // a TY SO in the current scope. Without this, the SO TOTAL LY
    // would silently undercount vs the Customer / Style / Sub-Cat
    // TOTALs (which already include those styles via the per-style
    // ship-history match). Pushed between the last meaningful row and
    // the grand TOTAL in every groupBy variant. Detected by
    // SO_CATCHALL_KEY in the TOTAL emitters so its LY contribution
    // folds into the bottom TOTAL row.
    const tyStyles = new Set<string>();
    for (const e of enriched) {
      if (e.style) tyStyles.add(e.style);
    }
    const catchall = computeSoCatchallRow(tyStyles, lyRevByStyle);
    if (catchall) out.push(catchall);

    return out;
  }, [excelData, result, viewBy, customer, selStores, selCategories, selSubCategories, selStyles, selGenders, start, end, lyRevByStyle, soCostInputs]);

  // Parallel diagnostic — same filter chain as soRows, but counts how
  // many open SOs make it past each step. Surfaced above the SO table
  // so the operator can see where their rows are being dropped. A
  // common silent-fail is the modal inheriting the grid's store /
  // style / category filters from defaultStoreFilter / defaultStyles
  // — the diagnostic makes that obvious instead of leaving the user
  // staring at an empty table wondering why.
  const soDiag = useMemo(() => {
    if (!excelData) return null;
    const want = (set: string[], v: string | null | undefined) => set.length === 0 || (v != null && set.includes(v));
    let total = 0, afterDate = 0, afterStore = 0, afterCustomer = 0, afterScope = 0;
    for (const s of excelData.sos) {
      total++;
      const fd = s.cancelDate || s.date;
      if (!fd || fd < start || fd > end) continue;
      afterDate++;
      if (!want(selStores, s.store)) continue;
      afterStore++;
      if (customer.length > 0 && !customer.includes(s.customerName)) continue;
      afterCustomer++;
      const ids = resolveItemMasterIds(s.sku);
      let style: string | null = null, cat: string | null = null, subCat: string | null = null, gender: string | null = null;
      for (const id of ids) {
        const rec = getItemMasterById(id);
        if (!rec) continue;
        style = style ?? rec.style_code ?? null;
        cat = cat ?? rec.attributes?.group_name ?? null;
        subCat = subCat ?? rec.attributes?.category_name ?? null;
        gender = gender ?? rec.attributes?.gender ?? null;
        if (style && cat && subCat && gender) break;
      }
      if (!want(selCategories, cat))       continue;
      if (!want(selSubCategories, subCat)) continue;
      if (!want(selStyles, style))         continue;
      if (!want(selGenders, gender))       continue;
      afterScope++;
    }
    return { total, afterDate, afterStore, afterCustomer, afterScope };
  }, [excelData, customer, selStores, selCategories, selSubCategories, selStyles, selGenders, start, end]);

  // Per-(customer, sku) raw aggregates for the Customer dim view.
  // Replaces the old "one row per customer" rollup with per-SKU detail
  // so the grain-aware aggregator (aggregateExplodeAware, dim: customer)
  // can classify each SKU's grain and split (or collapse) the
  // customer's rows along the same explodePpk policy used by every
  // other dim.
  //
  // Sources:
  //   * result.byCustomer.bySku — per-(customer, sku_id) breakdown of
  //     shipped sales for the TY + LY windows (added in #292; built
  //     server-side from the same row scan as t3/ly with no extra DB
  //     round trip). sku_id is a uuid — resolved to sku_code here via
  //     the in-memory item-master cache. Unresolvable sku_ids fold
  //     into a "(unknown sku)" bucket so the customer's totals stay
  //     correct even if a per-grain split for them isn't possible.
  //   * openSoAggregates.byCustomerSku — per-(customer, sku_code)
  //     breakdown of open SOs in the picked window. Folded into TY
  //     (qty + rev + estimated margin) so a forward-looking window
  //     still surfaces meaningful TY numbers per customer.
  //
  // Output shape matches the aggregator's customerRaw arg: one entry
  // per (customer, sku) pair with TY + LY qty/rev/mrgn.
  const customerRawAggs = useMemo(() => {
    type Entry = { customer: string; sku: string; tyQty: number; tyRev: number; tyMrgn: number; lyQty: number; lyRev: number; lyMrgn: number };
    // Key = `${customer}::${sku}` — same composite as the aggregator's
    // internal buckets so duplicate (cust, sku) pairs across the two
    // sources accumulate cleanly.
    const byKey = new Map<string, Entry>();
    const ensure = (customer: string, sku: string): Entry => {
      const k = `${customer}::${sku}`;
      const cur = byKey.get(k);
      if (cur) return cur;
      const fresh: Entry = { customer, sku, tyQty: 0, tyRev: 0, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 };
      byKey.set(k, fresh);
      return fresh;
    };
    if (result?.byCustomer) {
      for (const entry of result.byCustomer.values()) {
        for (const [skuId, agg] of entry.bySku) {
          const master = getItemMasterById(skuId);
          // sku_code is what aggregateExplodeAware resolves back to a
          // master via resolveItemMasterIds. Falling back to a synthetic
          // "(unknown sku)" label keeps grand totals correct (the
          // contribution still folds under the customer) while making
          // the unresolved chunk visible as its own row in explode-OFF
          // mode — operator can investigate without a silent drop.
          const skuKey = master?.sku_code ?? "(unknown sku)";
          const row = ensure(entry.customerName, skuKey);
          // result.byCustomer.bySku qty is UNIT GRAIN (qty_units = eaches)
          // — see exportSalesFetch.ts:807. The customer-dim aggregator
          // (aggregateExplodeAware "customer" branch) expects NATIVE
          // grain just like rawSkuAggs above; without this divide PPK
          // rows get pack_size² in explode-ON. See [[ppk-grain-rule-canonical]]
          // §7 (PR #387 fixed rawSkuAggs; this is the matching path).
          const ps = classifyMasterGrain(master) === "ppk" ? packSizeFor(master) : 1;
          const qDiv = ps > 1 ? ps : 1;
          row.tyQty += agg.t3.qty / qDiv; row.tyRev += agg.t3.totalPrice; row.tyMrgn += agg.t3.marginAmount;
          row.lyQty += agg.ly.qty / qDiv; row.lyRev += agg.ly.totalPrice; row.lyMrgn += agg.ly.marginAmount;
        }
      }
    }
    // Merge open SO contributions (per customer + sku_code). Brand-new
    // accounts with no LY history still appear here — they have a
    // (cust, sku) row from the SO side with non-zero TY.
    for (const [customerName, perSku] of openSoAggregates.byCustomerSku) {
      for (const [skuCode, agg] of perSku) {
        const row = ensure(customerName, skuCode);
        row.tyQty += agg.qty;
        row.tyRev += agg.rev;
        row.tyMrgn += agg.mrgn;
      }
    }
    return [...byKey.values()].filter(r => r.tyRev > 0 || r.lyRev > 0);
  }, [result, openSoAggregates]);

  const run = async () => {
    setRangeWarn(false);
    setError(null);
    if (!start || !end || start > end) { setRangeWarn(true); return; }
    setRunning(true);
    try {
      const r = await fetchSalesAggregates({
        rows, needT3: true, needLY: true,
        customer:          customer,
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
        // Pull per-(style, day) LY breakdown so the SO view can scope
        // each row's LY column to a ±30d window around that SO's
        // cancel date shifted back 12 months — instead of every row
        // showing the same full-window style total.
        needLyDailyByStyle: true,
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
    // Build per-View By dim sections in the same order the operator
    // selected. Numbers / shape / row-splits are computed here so the
    // export-side file stays purely about styling (preview-parity rule).
    const viewSections: SalesCompsExportInput["viewSections"] = [];
    for (const dim of viewBy) {
      if (dim === "so") {
        viewSections.push({
          kind: "so",
          viewBy,
          soRows: soRows as ExportSoRow[],
        });
        continue;
      }
      const dataRows = groupedRowsFor(dim, rawSkuAggs, customerRawAggs, explodePpk);
      const dataTotals = totalsForDimRows(dataRows, explodePpk);
      viewSections.push({ kind: "dim", dim, dataRows, dataTotals });
    }

    downloadSalesCompsWorkbook({
      start,
      end,
      scope: {
        customer,
        selStores,
        selCategories,
        selSubCategories,
        selStyles,
      },
      customerFacing,
      explodePpk,
      // Permission gate — margin rows/columns never reach a workbook the
      // caller isn't granted to export (preview-parity with the on-screen gate).
      hideMargins: !canExportMargin,
      dimTotals,
      viewSections,
    });
  };


  // Each scope facet lists the actual selected values joined by "/", matching
  // the export's buildScopeText. Operator wanted the names visible, not a count.
  const scopeLine = [
    customer.length        > 0 && `customer ${customer.join("/")}`,
    selStores.length       > 0 && `stores ${selStores.join("/")}`,
    selCategories.length   > 0 && `categories ${selCategories.join("/")}`,
    selSubCategories.length> 0 && `sub-cats ${selSubCategories.join("/")}`,
    selStyles.length       > 0 && `styles ${selStyles.join("/")}`,
  ].filter(Boolean).join(" · ") || "all";

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div style={{ position: "relative", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, width: result ? "min(920px, 95vw)" : "min(560px, 95vw)", maxHeight: "90vh", boxSizing: "border-box", color: C.text, fontFamily: "inherit", boxShadow: "0 16px 48px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.accent, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Sales Comps {result && <span style={{ color: C.textMuted, fontWeight: 400, textTransform: "none", letterSpacing: 0, marginLeft: 8 }}>— results · {viewBy.map(v => VIEW_BY_LABELS[v]).join(" + ")}</span>}
            </div>
            <button style={{ background: "none", border: "none", color: C.textDim, fontSize: 18, cursor: "pointer", padding: "2px 6px", borderRadius: 4 }} onClick={onClose} title="Close">✕</button>
          </div>
          {/* Window/scope summary — promoted from the 11pt faded line
              that previously sat below the caveat in the results pane.
              One prominent line at the top of the modal so the operator
              always sees the window + scope of what they're looking at
              without scanning two faded lines in different spots. 14pt
              matches the section labels (Totals / TY vs LY sales),
              500 weight + primary text color so it reads as a
              first-class label rather than a dim caption. */}
          {result && (
            <div style={{ fontSize: 14, fontWeight: 500, color: C.text, lineHeight: 1.35 }}>
              Window: {start} → {end} (TY) · {tableRows.length} Style/Colors · {viewBy.length} view{viewBy.length === 1 ? "" : "s"} · scope: {scopeLine}{customerFacing ? " · customer-facing (margin hidden)" : ""} · Explode PPK: {explodePpk ? "ON" : "OFF"}
            </div>
          )}
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
              <SelectField label="Warehouses" value={selStores} options={stores} onChange={setSelStores} multi />
              <SelectField label="Category" value={selCategories} options={categories} onChange={setSelCategories} multi />
              <SelectField label="Sub-Category" value={selSubCategories} options={subCategories} onChange={setSelSubCategories} multi />
              <SelectField label="Style" value={selStyles} options={styles} onChange={setSelStyles} multi optionLabel={styleOptionLabel} />
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
            {/* Section header — Totals block. 14pt bold, primary text
                color. 16px top margin breathes from the modal header
                above. */}
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginTop: 16 }}>Totals</div>
            <SummaryBlock dimTotals={dimTotals} customerFacing={customerFacing} canViewMargin={canViewMargin} />

            {/* Open-SO margin-coverage caveat. Surfaced when any open
                SOs contributed to TY so the operator knows the TY
                MRGN% includes an estimate. Hidden when no open SOs
                landed in the window (past windows where SOs all have
                cancel dates ≥ today). Also hidden in customer-facing
                mode — the margin columns are already suppressed there. */}
            {!customerFacing && canViewMargin && openSoAggregates.coverage.contributing > 0 && (
              <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.4 }}>
                TY margin includes estimated margin on {openSoAggregates.coverage.contributing} open SO{openSoAggregates.coverage.contributing === 1 ? "" : "s"} (cost from snapshot avg + in-window POs; {openSoAggregates.coverage.costMissing} had no resolvable cost).
              </div>
            )}

            {/* Grain caveat — when the grid's Explode PPK toggle is OFF
                and the result contains a mix of PPK + each grain, qty
                cells stay in their master's native grain (packs vs
                eaches). The summary + per-dim totals split into two
                rows so the operator can read each grain's total
                separately without packs and eaches getting summed into
                a single misleading number. */}
            {!explodePpk && dimTotals.hasMixed && (
              <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.4 }}>
                Explode PPK is OFF — qty is reported in each master's native grain. PPK rows show pack qty; each rows show unit qty. Totals split per grain to avoid summing packs and eaches.
              </div>
            )}

            {/* Section header — TY vs LY sales. Rendered ONCE before
                the first non-SO dimension table (the individual table
                headers below already say which dimension). Skipped when
                no non-SO dim is selected. */}
            {viewBy.some(d => d !== "so") && (
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginTop: 16 }}>TY vs LY sales</div>
            )}

            {/* Render one CompsTable per selected View By dimension.
                The grouping logic for each dimension lives in
                groupedRowsFor — sku/style/category/sub_category use the
                item-master cache; customer uses the byCustomer rollup
                from the fetch; SO is a placeholder pending the open-SO
                data model. */}
            {viewBy.map(dim => {
              if (dim === "so") {
                // Match the per-SO column set when style is co-selected
                // (row-per-(style,SO)) or SO is alone (row-per-order_number).
                // Customer / Category / Sub-Category co-select collapses
                // to a single dimension column (no per-order metadata).
                const showSoMeta = viewBy.includes("style") || !(viewBy.includes("customer") || viewBy.includes("category") || viewBy.includes("sub_category"));
                const soDimLabel =
                  viewBy.includes("customer")     ? "Customer" :
                  viewBy.includes("category")     ? "Category" :
                  viewBy.includes("sub_category") ? "Sub-Category" :
                  "SO";
                return (
                  <div key={dim} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {/* Section header — TY SO Detail. 14pt bold,
                        primary text color. Replaces the prior 11pt
                        uppercase mini-header. Diagnostics box + table
                        remain unchanged. LY columns removed from this
                        table per operator request — the LY comparison
                        already lives in the Totals block above. */}
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginTop: 16 }}>TY SO Detail</div>
                    {soDiag && (
                      <div style={{ fontSize: 11, color: C.textMuted, lineHeight: 1.4, padding: "6px 10px", background: C.rowAlt, border: `1px solid ${C.border}`, borderRadius: 6 }}>
                        <strong style={{ color: C.text }}>Filter breakdown:</strong>{" "}
                        {soDiag.total} SOs total
                        {" → "}{soDiag.afterDate} in {start}…{end}
                        {" → "}{soDiag.afterStore} after store{selStores.length > 0 ? ` (${selStores.join("/")})` : ""}
                        {" → "}{soDiag.afterCustomer} after customer{customer.length > 0 ? ` (${customer.length === 1 ? customer[0] : `${customer.length} selected`})` : ""}
                        {" → "}<strong style={{ color: soDiag.afterScope > 0 ? C.green : C.red }}>{soDiag.afterScope} final</strong>
                        {(selCategories.length + selSubCategories.length + selStyles.length + selGenders.length) > 0 && (
                          <span style={{ color: C.textDim }}> (after cat/sub-cat/style/gender)</span>
                        )}
                      </div>
                    )}
                    <SoCompsTable rows={soRows} showSoMeta={showSoMeta} dimensionLabel={soDimLabel} />
                  </div>
                );
              }
              const built = groupedRowsFor(dim, rawSkuAggs, customerRawAggs, explodePpk);
              // Per-dim totals — used to decide whether to render two
              // grain-split totals rows (mixed grain in explode-OFF
              // mode) or a single combined totals row. With Explode ON,
              // qty is uniformly in eaches and one TOTAL is correct;
              // totalsForDimRows forces hasMixed=false in that mode.
              const builtTotals = totalsForDimRows(built, explodePpk);
              return (
                <CompsTable
                  key={dim}
                  colLabel={VIEW_BY_LABELS[dim]}
                  rows={built}
                  totals={builtTotals}
                  customerFacing={customerFacing}
                  canViewMargin={canViewMargin}
                  descByLabel={dim === "style" ? styleDescByCode : undefined}
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
// dimensions. Delegates to aggregateExplodeAware so all dims share the
// same explodePpk policy: ON collapses PPK + each siblings into one row
// (qty in eaches); OFF splits dim rows by grain (qty stays in master's
// native grain, with "(PPK packs)" / "(each)" suffix on the label).
//
// Customer dim is grain-aware as of #292: result.byCustomer.bySku
// carries the per-(customer, sku_id) breakdown so the aggregator can
// classify each SKU's grain and split the customer's rows along the
// explodePpk policy used by every other dim. customerRawAggs is the
// pre-built (customer, sku) raw set the modal feeds in.
function groupedRowsFor(
  dim: Exclude<ViewByKey, "so">,
  rawSkuAggs: RawSkuAgg[],
  customerRawAggs: Array<{ customer: string; sku: string; tyQty: number; tyRev: number; tyMrgn: number; lyQty: number; lyRev: number; lyMrgn: number }>,
  explodePpk: boolean,
): DimRow[] {
  if (dim === "customer") {
    return aggregateExplodeAware({
      raw: [],
      dim: "customer",
      explodePpk,
      resolveIds: resolveItemMasterIds,
      getMaster: getItemMasterById,
      customerRaw: customerRawAggs,
    });
  }
  return aggregateExplodeAware({
    raw: rawSkuAggs,
    dim: dim as DimKind,
    explodePpk,
    resolveIds: resolveItemMasterIds,
    getMaster: getItemMasterById,
  });
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
// CompsTable accepts DimRow[] (output of aggregateExplodeAware) and
// renders a comparison table with optional TWO totals rows when mixed
// grain is present in explode-OFF mode. The totals prop carries the
// per-grain + combined totals computed by totalsForDimRows so the
// renderer can decide whether to split based on .hasMixed.
interface CompsTotalsProp {
  ppk: { tyQty: number; tyRev: number; tyMrgn: number; tyCogs: number; lyQty: number; lyRev: number; lyMrgn: number; lyCogs: number };
  each: { tyQty: number; tyRev: number; tyMrgn: number; tyCogs: number; lyQty: number; lyRev: number; lyMrgn: number; lyCogs: number };
  combined: { tyQty: number; tyRev: number; tyMrgn: number; tyCogs: number; lyQty: number; lyRev: number; lyMrgn: number; lyCogs: number };
  hasMixed: boolean;
}
// Sort keys for the comparison table. "label" sorts on the leftmost
// dimension text; the rest are numeric. Δ Rev / Δ Mrgn use the same
// growth math the cells render so the sort matches what's on screen.
type CompsSortKey = "label" | "tyQty" | "tyRev" | "tyMrgn" | "lyQty" | "lyRev" | "lyMrgn" | "dRev" | "dMrgn";
function compsSortValue(r: DimRow, key: CompsSortKey): number | string {
  switch (key) {
    case "label":  return r.label.toLowerCase();
    case "tyQty":  return r.tyQty;
    case "tyRev":  return r.tyRev;
    case "tyMrgn": return r.tyRev > 0 ? r.tyMrgn / r.tyRev : -Infinity;
    case "lyQty":  return r.lyQty;
    case "lyRev":  return r.lyRev;
    case "lyMrgn": return r.lyRev > 0 ? r.lyMrgn / r.lyRev : -Infinity;
    // Growth fraction (ty - ly)/ty — matches fmtGrowth; no-TY rows sink.
    case "dRev":   return r.tyRev > 0 ? (r.tyRev - r.lyRev) / r.tyRev : -Infinity;
    // Margin-points diff — matches fmtMarginPoints.
    case "dMrgn": {
      const typ = r.tyRev > 0 ? r.tyMrgn / r.tyRev : 0;
      const lyp = r.lyRev > 0 ? r.lyMrgn / r.lyRev : 0;
      return (typ === 0 || lyp === 0) ? -Infinity : typ - lyp;
    }
  }
}

function CompsTable({ colLabel, rows, totals, customerFacing, canViewMargin, descByLabel }: { colLabel: string; rows: DimRow[]; totals: CompsTotalsProp; customerFacing: boolean; canViewMargin: boolean; descByLabel?: Map<string, string> }): React.ReactElement {
  // Margin columns show only when the report is internal-facing AND the
  // operator holds the margins:read grant (module-level component, so the
  // flag is threaded in as a prop rather than calling the hook here).
  const showMrgn = !customerFacing && canViewMargin;
  // Per-column sort over the data rows. null = natural (upstream) order,
  // which is already TY-rev descending. Clicking a header sorts; clicking
  // the active header flips direction. Totals rows below are unaffected —
  // they're rendered after the sorted data rows, so they stay pinned.
  const [sortKey, setSortKey] = useState<CompsSortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const onSort = (k: CompsSortKey) => {
    if (sortKey === k) { setSortDir(d => (d === "asc" ? "desc" : "asc")); }
    else { setSortKey(k); setSortDir(k === "label" ? "asc" : "desc"); }
  };
  const sortedRows = useMemo(() => {
    if (!sortKey) return rows;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = compsSortValue(a, sortKey);
      const vb = compsSortValue(b, sortKey);
      if (typeof va === "string" || typeof vb === "string") {
        return String(va).localeCompare(String(vb)) * dir;
      }
      return (va - vb) * dir;
    });
  }, [rows, sortKey, sortDir]);
  // Header cell with a functional ▲▼ affordance. align mirrors the body
  // cell alignment so the arrow sits flush with the column.
  const SortTh = ({ k, label, align }: { k: CompsSortKey; label: string; align?: "left" | "right" }): React.ReactElement => {
    const active = sortKey === k;
    return (
      <th style={{ ...th(align === "right" ? "right" : "left"), cursor: "pointer", userSelect: "none", color: active ? C.text : undefined }} onClick={() => onSort(k)} title="Click to sort">
        {label}{active ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
      </th>
    );
  };
  // Helper: render one totals row. Used three times below — once for
  // the combined total (single-grain modes), or twice (one per grain
  // when hasMixed is true and we're in explode-OFF mode).
  const renderTotalRow = (
    label: string,
    t: CompsTotalsProp["combined"],
  ): React.ReactElement => {
    const growth = fmtGrowth(t.tyRev, t.lyRev);
    const mp = fmtMarginPoints(t.tyMrgn, t.tyRev, t.lyMrgn, t.lyRev);
    return (
      <tr key={label} style={{ background: C.surface, borderTop: `2px solid ${C.border}`, fontWeight: 700 }}>
        <td style={{ ...td(), fontWeight: 700, color: C.accent }}>{label}</td>
        <td style={{ ...td("right"), fontWeight: 700 }}>{t.tyQty.toLocaleString()}</td>
        <td style={{ ...td("right"), fontWeight: 700 }}>{fmtUSD(t.tyRev)}</td>
        {showMrgn && <td style={{ ...td("right"), fontWeight: 700 }}>{fmtPct(t.tyMrgn, t.tyRev)}</td>}
        <td style={{ ...td("right", C.textMuted), fontWeight: 700 }}>{t.lyQty.toLocaleString()}</td>
        <td style={{ ...td("right", C.textMuted), fontWeight: 700 }}>{fmtUSD(t.lyRev)}</td>
        {showMrgn && <td style={{ ...td("right", C.textMuted), fontWeight: 700 }}>{fmtPct(t.lyMrgn, t.lyRev)}</td>}
        <td style={{ ...td("right"), color: growth.positive ? C.green : C.red, fontWeight: 700 }}>{growth.text}</td>
        {showMrgn && <td style={{ ...td("right"), color: mp.positive ? C.green : C.red, fontWeight: 700 }}>{mp.text}</td>}
      </tr>
    );
  };
  return (
    <div style={{ flex: 1, minHeight: 280, maxHeight: "48vh", overflowY: "auto", border: `1px solid ${C.border}`, borderRadius: 8 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead style={{ position: "sticky", top: 0, background: C.surface, zIndex: 1 }}>
          <tr style={{ borderBottom: `1px solid ${C.border}` }}>
            <SortTh k="label" label={colLabel} />
            <SortTh k="tyQty" label="TY Qty" align="right" />
            <SortTh k="tyRev" label="TY Rev" align="right" />
            {showMrgn && <SortTh k="tyMrgn" label="TY Mrgn%" align="right" />}
            <SortTh k="lyQty" label="LY Qty" align="right" />
            <SortTh k="lyRev" label="LY Rev" align="right" />
            {showMrgn && <SortTh k="lyMrgn" label="LY Mrgn%" align="right" />}
            <SortTh k="dRev" label="Δ Rev" align="right" />
            {showMrgn && <SortTh k="dMrgn" label="Δ Mrgn pp" align="right" />}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((r, i) => {
            const growth = fmtGrowth(r.tyRev, r.lyRev);
            const mp = fmtMarginPoints(r.tyMrgn, r.tyRev, r.lyMrgn, r.lyRev);
            return (
              <tr key={r.key} style={{ background: i % 2 === 0 ? "transparent" : C.rowAlt }}>
                <td style={td()}>{r.label}{descByLabel?.get(r.label) && <span style={{ color: C.textMuted, fontWeight: 400 }}> — {descByLabel.get(r.label)}</span>}</td>
                <td style={td("right")}>{r.tyQty.toLocaleString()}</td>
                <td style={td("right")}>{fmtUSD(r.tyRev)}</td>
                {showMrgn && <td style={td("right")}>{fmtPct(r.tyMrgn, r.tyRev)}</td>}
                <td style={td("right", C.textMuted)}>{r.lyQty.toLocaleString()}</td>
                <td style={td("right", C.textMuted)}>{fmtUSD(r.lyRev)}</td>
                {showMrgn && <td style={td("right", C.textMuted)}>{fmtPct(r.lyMrgn, r.lyRev)}</td>}
                <td style={{ ...td("right"), color: growth.positive ? C.green : C.red, fontWeight: 600 }}>{growth.text}</td>
                {showMrgn && <td style={{ ...td("right"), color: mp.positive ? C.green : C.red, fontWeight: 600 }}>{mp.text}</td>}
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan={showMrgn ? 9 : 6} style={{ ...td(), color: C.textDim, textAlign: "center", padding: 18 }}>No sales in window for this scope.</td></tr>
          )}
          {/* Bottom TOTAL row(s) — when mixed grain is present in
              explode-OFF mode, render TWO totals (one per grain) so
              packs + eaches never sum into a single misleading number.
              Otherwise render one combined totals row. */}
          {rows.length > 0 && totals.hasMixed && renderTotalRow("TOTAL (PPK packs)", totals.ppk)}
          {rows.length > 0 && totals.hasMixed && renderTotalRow("TOTAL (each)", totals.each)}
          {rows.length > 0 && !totals.hasMixed && renderTotalRow("TOTAL", totals.combined)}
        </tbody>
      </table>
    </div>
  );
}

// SO view's table. Compares open SO $ (TY) against same-style-all-
// colors LY ship $. The column set depends on how the rows were
// grouped upstream (soRows useMemo):
//   - "style"-grouped or SO-only: shows the per-SO metadata columns
//     (Style? · Order # · Cancel Date · Customer).
//   - "customer" / "category" / "sub_category"-grouped: shows the
//     dimension label only, since order/customer/date no longer make
//     sense on a multi-SO row.
// Subtotal rows (kind: "subtotal") render with bold accent styling
// under their style group.
function SoCompsTable({
  rows,
  showSoMeta,
  dimensionLabel,
}: {
  rows: SoRow[];
  showSoMeta: boolean;
  dimensionLabel: string;
}): React.ReactElement {
  // Grand total across the data rows. Subtotal rows are skipped (they
  // already sum the rows above them — adding them would double-count).
  // Each row's LY is now a per-SO ±30d window, so totals SUM across
  // rows rather than de-duping by style key. Overlapping windows (same
  // style, near-same cancel dates) double-count their overlapping LY
  // days — acceptable tradeoff vs. losing per-row signal in the table.
  // The LY catch-all subtotal (SO_CATCHALL_KEY) is no longer tracked
  // here since the table is TY-only — the dim sections + Totals block
  // above still surface the LY context the operator needs.
  const dataRows = rows.filter((r): r is Extract<SoRow, { kind: "row" }> => r.kind === "row");
  let totalTyQty = 0, totalTyRev = 0;
  for (const r of dataRows) {
    totalTyQty += r.tyQty;
    totalTyRev += r.tyRev;
  }

  return (
    <div style={{ flex: 1, minHeight: 280, maxHeight: "48vh", overflowY: "auto", border: `1px solid ${C.border}`, borderRadius: 8 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead style={{ position: "sticky", top: 0, background: C.surface, zIndex: 1 }}>
          <tr style={{ borderBottom: `1px solid ${C.border}` }}>
            {showSoMeta ? (
              <>
                <th style={th()}>Style</th>
                <th style={th()}>Order #</th>
                <th style={th()}>Cancel</th>
                <th style={th()}>Customer</th>
              </>
            ) : (
              <th style={th()}>{dimensionLabel}</th>
            )}
            <th style={th("right")}>TY Qty</th>
            <th style={th("right")}>TY Open SO $</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            if (r.kind === "subtotal") {
              return (
                <tr key={r.key} style={{ background: C.rowAlt, fontWeight: 600 }}>
                  <td colSpan={showSoMeta ? 4 : 1} style={{ ...td(), color: C.accent, fontWeight: 600 }}>{r.label}</td>
                  <td style={{ ...td("right"), fontWeight: 600 }}>{r.tyQty.toLocaleString()}</td>
                  <td style={{ ...td("right"), fontWeight: 600 }}>{fmtUSD(r.tyRev)}</td>
                </tr>
              );
            }
            return (
              <tr key={r.key} style={{ background: i % 2 === 0 ? "transparent" : C.rowAlt }}>
                {showSoMeta ? (
                  <>
                    <td style={td()}>{r.style ?? ""}</td>
                    <td style={{ ...td(), fontFamily: "monospace", color: C.text }}>{r.orderNumber ?? ""}</td>
                    <td style={td("left", C.textMuted)}>{r.cancelDate ? fmtDateDisplay(r.cancelDate) : ""}</td>
                    <td style={td()}>{r.customer ?? ""}</td>
                  </>
                ) : (
                  <td style={td()}>{r.label}</td>
                )}
                <td style={td("right")}>{r.tyQty.toLocaleString()}</td>
                <td style={td("right")}>{fmtUSD(r.tyRev)}</td>
              </tr>
            );
          })}
          {dataRows.length === 0 && (
            <tr><td colSpan={showSoMeta ? 6 : 3} style={{ ...td(), color: C.textDim, textAlign: "center", padding: 18 }}>
              No open SOs match this scope.
            </td></tr>
          )}
          {dataRows.length > 0 && (
            <tr style={{ background: C.surface, borderTop: `2px solid ${C.border}`, fontWeight: 700 }}>
              <td colSpan={showSoMeta ? 4 : 1} style={{ ...td(), fontWeight: 700, color: C.accent }}>TOTAL</td>
              <td style={{ ...td("right"), fontWeight: 700 }}>{totalTyQty.toLocaleString()}</td>
              <td style={{ ...td("right"), fontWeight: 700 }}>{fmtUSD(totalTyRev)}</td>
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
//
// When mixed grain is present in explode-OFF mode (dimTotals.hasMixed
// === true), renders TWO stacks side-by-side (PPK packs vs each) so the
// operator never sees packs + eaches summed into a single misleading
// row. Otherwise renders the standard single-totals stack.
function SummaryBlock({ dimTotals, customerFacing, canViewMargin }: { dimTotals: DimTotals; customerFacing: boolean; canViewMargin: boolean }): React.ReactElement {
  type RowDef = { label: string; ty: string; ly: string; diff: { text: string; positive: boolean }; tone?: "muted"; internalOnly?: boolean; marginRow?: boolean };
  const rowsFor = (totals: DimTotals["combined"]): RowDef[] => {
    const all: RowDef[] = [
      { label: "Units",    ty: totals.tyQty.toLocaleString(),       ly: totals.lyQty.toLocaleString(),       diff: fmtGrowth(totals.tyQty,  totals.lyQty)  },
      { label: "Revenue",  ty: fmtUSD(totals.tyRev),                ly: fmtUSD(totals.lyRev),                diff: fmtGrowth(totals.tyRev,  totals.lyRev)  },
      { label: "COGS",     ty: fmtUSD(totals.tyCogs),               ly: fmtUSD(totals.lyCogs),               diff: fmtGrowth(totals.tyCogs, totals.lyCogs), tone: "muted", internalOnly: true },
      { label: "Margin $", ty: fmtUSD(totals.tyMrgn),               ly: fmtUSD(totals.lyMrgn),               diff: fmtGrowth(totals.tyMrgn, totals.lyMrgn), internalOnly: true, marginRow: true },
      { label: "Margin %", ty: fmtPct(totals.tyMrgn, totals.tyRev), ly: fmtPct(totals.lyMrgn, totals.lyRev), diff: fmtMarginPoints(totals.tyMrgn, totals.tyRev, totals.lyMrgn, totals.lyRev), internalOnly: true, marginRow: true },
    ];
    // customerFacing drops all internal rows (COGS + margins); the margin
    // permission gate additionally drops just the margin rows (COGS stays —
    // cost data, not margin).
    const base = customerFacing ? all.filter(r => !r.internalOnly) : all;
    return canViewMargin ? base : base.filter(r => !r.marginRow);
  };
  const renderTable = (rows: RowDef[], heading?: string): React.ReactElement => (
    <div style={{ background: C.rowAlt, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 16px", flex: 1, minWidth: 0 }}>
      {heading && (
        <div style={{ fontSize: 11, fontWeight: 700, color: C.accent, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
          {heading}
        </div>
      )}
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

  if (dimTotals.hasMixed) {
    return (
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {renderTable(rowsFor(dimTotals.ppk),  "TOTAL (PPK packs)")}
        {renderTable(rowsFor(dimTotals.each), "TOTAL (each)")}
      </div>
    );
  }
  return renderTable(rowsFor(dimTotals.combined));
}
