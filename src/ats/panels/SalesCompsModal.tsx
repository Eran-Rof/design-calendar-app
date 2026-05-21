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
import { getItemMasterById } from "../itemMasterLookup";
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

type ViewMode = "summary" | "detailed";

interface SelectFieldProps<T extends string> {
  label: string;
  value: T[];
  options: T[];
  onChange: (next: T[]) => void;
  multi?: boolean;
  hint?: string;
}
function SelectField<T extends string>({ label, value, options, onChange, multi, hint }: SelectFieldProps<T>): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  // Click-outside closes the multi-select popover. Listens only while
  // open so we don't waste handlers on idle dropdowns.
  useEffect(() => {
    if (!open) return;
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
          {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    );
  }

  const filtered = search.trim() === ""
    ? options
    : options.filter(o => o.toLowerCase().includes(search.toLowerCase()));
  const summary = value.length === 0 ? "All" : value.length <= 2 ? value.join(", ") : `${value.length} selected`;
  const toggle = (o: T) => onChange(value.includes(o) ? value.filter(v => v !== o) : [...value, o]);

  return (
    <div ref={wrapRef} style={{ display: "flex", flexDirection: "column", gap: 4, position: "relative" }}>
      <label style={{ fontSize: 12, color: C.textMuted, fontWeight: 600 }}>{label}</label>
      {hint && <span style={{ fontSize: 10, color: C.textDim, lineHeight: 1.2 }}>{hint}</span>}
      <button type="button" onClick={() => setOpen(o => !o)} style={{ ...inputStyle, textAlign: "left", cursor: "pointer" }}>
        {summary}
        <span style={{ float: "right", color: C.textDim, fontSize: 10 }}>▼</span>
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 1100, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, maxHeight: 260, display: "flex", flexDirection: "column", padding: 4, boxShadow: "0 6px 18px rgba(0,0,0,0.5)" }}>
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
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o}</span>
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

  const [start, setStart] = useState(yearStartIso());
  const [end,   setEnd]   = useState(todayIso());
  const [customer, setCustomer]                 = useState<string[]>(defaultCustomer ? [defaultCustomer] : []);
  const [selCategories, setSelCategories]       = useState<string[]>(defaultCategories);
  const [selSubCategories, setSelSubCategories] = useState<string[]>(defaultSubCategories);
  const [selStyles, setSelStyles]               = useState<string[]>(defaultStyles);
  const [selStores, setSelStores]               = useState<string[]>(defaultStoreFilter);
  const [viewMode, setViewMode]                 = useState<ViewMode>("detailed");
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

  // Totals across the rolled-up rows — basis for the summary cards.
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
      });
      setResult(r);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setRunning(false);
    }
  };

  const reset = () => { setResult(null); setError(null); };

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
    if (viewMode === "detailed") {
      const header: string[] = customerFacing
        ? ["SKU", "TY Qty", "TY Rev", "LY Qty", "LY Rev", "Δ Rev"]
        : ["SKU", "TY Qty", "TY Rev", "TY Cogs", "TY Mrgn $", "TY Mrgn %", "LY Qty", "LY Rev", "LY Cogs", "LY Mrgn $", "LY Mrgn %", "Δ Rev", "Δ Margin pp"];
      aoa.push(header);
      for (const r of tableRows) {
        if (customerFacing) {
          aoa.push([r.sku, r.tyQty, r.tyRev, r.lyQty, r.lyRev, fmtGrowth(r.tyRev, r.lyRev).text]);
        } else {
          aoa.push([
            r.sku,
            r.tyQty, r.tyRev, r.tyRev - r.tyMrgn, r.tyMrgn,
            r.tyRev > 0 ? r.tyMrgn / r.tyRev : 0,
            r.lyQty, r.lyRev, r.lyRev - r.lyMrgn, r.lyMrgn,
            r.lyRev > 0 ? r.lyMrgn / r.lyRev : 0,
            fmtGrowth(r.tyRev, r.lyRev).text,
            fmtMarginPoints(r.tyMrgn, r.tyRev, r.lyMrgn, r.lyRev).text,
          ]);
        }
      }
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
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, minWidth: 540, maxWidth: result ? 920 : 560, maxHeight: "90vh", color: C.text, fontFamily: "inherit", boxShadow: "0 16px 48px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.accent, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Sales Comps {result && <span style={{ color: C.textMuted, fontWeight: 400, textTransform: "none", letterSpacing: 0, marginLeft: 8 }}>— results ({viewMode})</span>}
          </div>
          <button style={{ background: "none", border: "none", color: C.textDim, fontSize: 18, cursor: "pointer", padding: "2px 6px", borderRadius: 4 }} onClick={onClose} title="Close">✕</button>
        </div>

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

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <SelectField label="Customer" value={customer} options={customers} onChange={setCustomer} multi hint="Empty = all customers" />
              <SelectField label="Stores" value={selStores} options={stores} onChange={setSelStores} multi hint="Empty = all stores" />
              <SelectField label="Category" value={selCategories} options={categories} onChange={setSelCategories} multi />
              <SelectField label="Sub-Category" value={selSubCategories} options={subCategories} onChange={setSelSubCategories} multi />
              <SelectField label="Style" value={selStyles} options={styles} onChange={setSelStyles} multi />
            </div>

            <fieldset style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 12px", margin: 0 }}>
              <legend style={{ fontSize: 11, color: C.textMuted, padding: "0 4px", fontWeight: 600 }}>Output</legend>
              <div style={{ display: "flex", gap: 14, marginTop: 4 }}>
                <label title="Top-level totals only: qty, sales $, COGS $, margin $, margin %" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                  <input type="radio" name="comps-view" checked={viewMode === "summary"} onChange={() => setViewMode("summary")} />
                  <strong>Summary</strong>
                </label>
                <label title="Totals plus per-SKU table sorted by largest TY revenue" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                  <input type="radio" name="comps-view" checked={viewMode === "detailed"} onChange={() => setViewMode("detailed")} />
                  <strong>Detailed</strong>
                </label>
              </div>
              <label title="Hide COGS / Margin $ / Margin % from the report and Excel export — safe to share externally" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
                <input type="checkbox" checked={customerFacing} onChange={e => setCustomerFacing(e.target.checked)} />
                <strong>Customer-facing</strong>
              </label>
            </fieldset>

            {error && <div style={{ fontSize: 12, color: C.red, fontWeight: 600 }}>Fetch failed: {error}</div>}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
              <button onClick={onClose} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.text, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>Cancel</button>
              <button onClick={run} disabled={running} style={{ background: C.accent, border: `1px solid ${C.accent}`, color: "#001A12", padding: "8px 18px", borderRadius: 6, cursor: running ? "wait" : "pointer", fontSize: 13, fontWeight: 600, opacity: running ? 0.6 : 1 }}>
                {running ? "Running…" : "Run Comp"}
              </button>
            </div>
          </div>
        )}

        {result && (
          <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
            <SummaryBlock totals={totals} customerFacing={customerFacing} />

            <div style={{ fontSize: 11, color: C.textDim }}>
              Window: {start} → {end} (TY) · {tableRows.length} SKUs · scope: {scopeLine}{customerFacing ? " · customer-facing (margin hidden)" : ""}
            </div>

            {viewMode === "detailed" && (
              <div style={{ flex: 1, minHeight: 280, maxHeight: "48vh", overflowY: "auto", border: `1px solid ${C.border}`, borderRadius: 8 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead style={{ position: "sticky", top: 0, background: C.surface, zIndex: 1 }}>
                    <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                      <th style={th()}>SKU</th>
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
                    {tableRows.map((r, i) => {
                      const growth = fmtGrowth(r.tyRev, r.lyRev);
                      const mp = fmtMarginPoints(r.tyMrgn, r.tyRev, r.lyMrgn, r.lyRev);
                      return (
                        <tr key={r.sku} style={{ background: i % 2 === 0 ? "transparent" : C.rowAlt }}>
                          <td style={td()}>{r.sku}</td>
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
                    {tableRows.length === 0 && (
                      <tr><td colSpan={customerFacing ? 6 : 9} style={{ ...td(), color: C.textDim, textAlign: "center", padding: 18 }}>No sales in window for this scope.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

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

function th(align: "left" | "right" = "left"): React.CSSProperties {
  return { textAlign: align, padding: "8px 10px", fontSize: 11, fontWeight: 600, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.04em" };
}
function td(align: "left" | "right" = "left", color: string = C.text): React.CSSProperties {
  return { textAlign: align, padding: "6px 10px", fontSize: 12, color, borderTop: `1px solid ${C.border}` };
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
