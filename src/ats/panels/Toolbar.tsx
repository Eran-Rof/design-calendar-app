import React, { useState, useEffect, useRef } from "react";
import S from "../styles";
import type { ExcelData } from "../types";
// Shared app-wide dark calendar widget (same one every other app uses) so
// ATS date fields don't pop the browser's light native calendar.
import { AppDatePicker } from "../../shared/components/AppDatePicker";
import SearchableSelect from "../../tanda/components/SearchableSelect";

// Mouse-off auto-close for filter dropdowns. 600ms grace timer mirrors
// the planning grid's MultiSelectDropdown so a brief cursor flicker
// between trigger and popover doesn't dismiss before the operator can
// pick. Attach onMouseEnter={cancel} + onMouseLeave={schedule} to BOTH
// the trigger AND the popover (each lives in a separate subtree).
function useCloseOnMouseLeave(setOpen: (v: boolean) => void) {
  const timerRef = useRef<number | null>(null);
  const cancel = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  const schedule = () => {
    cancel();
    timerRef.current = window.setTimeout(() => setOpen(false), 600);
  };
  useEffect(() => () => cancel(), []);
  return { cancel, schedule };
}

// Reusable searchable dropdown built to match the existing Customer/Vendor
// dropdown pattern. Single-select; "All" entry always at the top.
interface SearchableDropdownProps {
  label: string;
  value: string;          // current selection (e.g. "DENIM" or "All")
  options: string[];      // includes "All" at index 0 (caller's responsibility)
  onChange: (v: string) => void;
  minWidth?: number;
  placeholder?: string;
}

// Multi-select variant. Empty array = no filter (renders "All"). Picking
// one or more options narrows the row set to that set. The "All" option
// at the top clears the array; tapping an already-selected option
// removes it. Header label shows "All" / "<name>" / "N selected" so
// the toolbar stays readable even with many filters active.
interface MultiSelectDropdownProps {
  label: string;
  value: string[];          // selected categories; empty = no filter
  options: string[];        // does NOT include "All" — caller passes real options
  onChange: (v: string[]) => void;
  minWidth?: number;
  placeholder?: string;
  // Optional label resolver — if the option's display name differs from
  // its stored value (e.g. Gender filter stores codes "M"/"B" but shows
  // "Mens"/"Boys"). Falls back to the raw option string.
  getLabel?: (v: string) => string;
}
const MultiSelectDropdown: React.FC<MultiSelectDropdownProps> = ({ label, value, options, onChange, minWidth = 140, placeholder, getLabel }) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const { cancel, schedule } = useCloseOnMouseLeave(setOpen);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);
  const q = search.toLowerCase();
  const labelFor = (o: string) => getLabel ? getLabel(o) : o;
  const shown = q ? options.filter(o => labelFor(o).toLowerCase().includes(q) || o.toLowerCase().includes(q)) : options;
  const selected = new Set(value);
  const headerText = value.length === 0
    ? "All"
    : value.length === 1
      ? labelFor(value[0])
      : `${value.length} selected`;
  const toggle = (opt: string) => {
    if (selected.has(opt)) {
      onChange(value.filter(v => v !== opt));
    } else {
      onChange([...value, opt]);
    }
  };
  return (
    <div ref={ref} style={{ position: "relative" }} onMouseEnter={cancel} onMouseLeave={schedule}>
      <button
        style={{ ...S.select, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", minWidth, justifyContent: "space-between" }}
        onClick={() => setOpen(o => !o)}
      >
        <span style={{ color: "#10B981", fontSize: 11, fontWeight: 600, marginRight: 2 }}>{label}:</span>
        <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {headerText}
        </span>
        {value.length > 0 && (
          <span
            role="button"
            aria-label={`Clear ${label}`}
            title={`Clear ${label}`}
            onClick={e => { e.stopPropagation(); onChange([]); }}
            style={{ fontSize: 12, color: "#FCA5A5", cursor: "pointer", padding: "0 4px", lineHeight: 1 }}
          >×</span>
        )}
        <span style={{ fontSize: 9, color: "#6B7280" }}>▼</span>
      </button>
      {open && (
        <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, background: "#1E293B", border: "1px solid #334155", borderRadius: 8, zIndex: 100, width: 260, maxHeight: 380, display: "flex", flexDirection: "column", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
          <div style={{ padding: "8px 10px", borderBottom: "1px solid #334155" }}>
            <input
              type="text"
              placeholder={placeholder ?? `Search ${label.toLowerCase()}…`}
              value={search}
              onChange={e => setSearch(e.target.value)}
              onFocus={e => e.currentTarget.select()}
              autoFocus
              style={{ width: "100%", boxSizing: "border-box", background: "#0F172A", border: "1px solid #334155", borderRadius: 6, padding: "6px 10px", color: "#F1F5F9", fontSize: 12, fontFamily: "inherit", outline: "none" }}
            />
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {/* "All" entry — clears the array. Distinct visual from
                checkboxes because it's a one-shot reset, not a toggleable
                row. */}
            <div
              style={{ padding: "8px 14px", cursor: "pointer", fontSize: 12, color: value.length === 0 ? "#6EE7B7" : "#CBD5E1", background: value.length === 0 ? "rgba(16,185,129,0.08)" : "transparent", fontWeight: value.length === 0 ? 600 : 400, borderBottom: "1px solid #2D3748" }}
              onClick={() => { onChange([]); }}
              onMouseEnter={e => (e.currentTarget.style.background = "rgba(16,185,129,0.12)")}
              onMouseLeave={e => (e.currentTarget.style.background = value.length === 0 ? "rgba(16,185,129,0.08)" : "transparent")}
            >All</div>
            {shown.map(opt => {
              const active = selected.has(opt);
              return (
                <label
                  key={opt}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 14px", cursor: "pointer", fontSize: 12, color: active ? "#6EE7B7" : "#CBD5E1", background: active ? "rgba(16,185,129,0.08)" : "transparent", fontWeight: active ? 600 : 400 }}
                  onMouseEnter={e => (e.currentTarget.style.background = "rgba(16,185,129,0.12)")}
                  onMouseLeave={e => (e.currentTarget.style.background = active ? "rgba(16,185,129,0.08)" : "transparent")}
                >
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={() => toggle(opt)}
                    style={{ accentColor: "#10B981", cursor: "pointer" }}
                  />
                  <span>{labelFor(opt)}</span>
                </label>
              );
            })}
            {shown.length === 0 && (
              <div style={{ padding: "10px 14px", fontSize: 12, color: "#6B7280" }}>No matches</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
const SearchableDropdown: React.FC<SearchableDropdownProps> = ({ label, value, options, onChange, minWidth = 140, placeholder }) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  // Close on outside click so the dropdown doesn't sit open behind other UI.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);
  const q = search.toLowerCase();
  const shown = q ? options.filter(o => o.toLowerCase().includes(q)) : options;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        style={{ ...S.select, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", minWidth, justifyContent: "space-between" }}
        onClick={() => setOpen(o => !o)}
      >
        <span style={{ color: "#10B981", fontSize: 11, fontWeight: 600, marginRight: 2 }}>{label}:</span>
        <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {value === "All" ? "All" : value}
        </span>
        <span style={{ fontSize: 9, color: "#6B7280" }}>▼</span>
      </button>
      {open && (
        <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, background: "#1E293B", border: "1px solid #334155", borderRadius: 8, zIndex: 100, width: 240, maxHeight: 340, display: "flex", flexDirection: "column", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
          <div style={{ padding: "8px 10px", borderBottom: "1px solid #334155" }}>
            <input
              type="text"
              placeholder={placeholder ?? `Search ${label.toLowerCase()}…`}
              value={search}
              onChange={e => setSearch(e.target.value)}
              onFocus={e => e.currentTarget.select()}
              autoFocus
              style={{ width: "100%", boxSizing: "border-box", background: "#0F172A", border: "1px solid #334155", borderRadius: 6, padding: "6px 10px", color: "#F1F5F9", fontSize: 12, fontFamily: "inherit", outline: "none" }}
            />
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {shown.map(opt => {
              const active = value === opt;
              return (
                <div
                  key={opt}
                  style={{ padding: "7px 14px", cursor: "pointer", fontSize: 12, color: active ? "#6EE7B7" : "#CBD5E1", background: active ? "rgba(16,185,129,0.08)" : "transparent", fontWeight: active ? 600 : 400 }}
                  onClick={() => { onChange(opt); setOpen(false); setSearch(""); }}
                  onMouseEnter={e => (e.currentTarget.style.background = "rgba(16,185,129,0.12)")}
                  onMouseLeave={e => (e.currentTarget.style.background = active ? "rgba(16,185,129,0.08)" : "transparent")}
                >{opt === "All" ? "All" : opt}</div>
              );
            })}
            {shown.length === 0 && (
              <div style={{ padding: "10px 14px", fontSize: 12, color: "#6B7280" }}>No matches</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

interface ToolbarProps {
  // Search + filters
  search: string;
  setSearch: (v: string) => void;
  filterCategory: string[];
  setFilterCategory: (v: string[]) => void;
  categories: string[];
  filterSubCategory: string[];
  setFilterSubCategory: (v: string[]) => void;
  subCategories: string[];
  // Multi-select Style filter. styles[] is scoped at build time to
  // whichever Category / Sub Cat narrowing is active so the dropdown
  // stays manageable as the catalog grows.
  filterStyle: string[];
  setFilterStyle: (v: string[]) => void;
  styles: string[];
  filterGender: string[];
  setFilterGender: (v: string[]) => void;
  // Gender option codes to show, narrowed to those present under the other
  // active filters (#9 cascade). Optional — falls back to the full canonical
  // set so legacy call sites keep working.
  genderOptions?: string[];
  // Multi-select Brand filter. brandOptions is the full brand_master
  // name list (every brand the Tangerine app knows about), so the
  // dropdown lists all brands regardless of what's loaded in the grid.
  filterBrand: string[];
  setFilterBrand: (v: string[]) => void;
  brandOptions: string[];
  // Status filter — driven by the colored stat-card pills (Negative ATS,
  // Aged Inven, etc.). Cleared by the toolbar's Clear button so a stuck
  // pill doesn't keep the grid filtered after the planner expects a reset.
  setFilterStatus: (v: string) => void;
  // Store dropdown
  STORES: readonly string[];
  storeFilter: string[];
  setStoreFilter: (v: string[]) => void;
  poDropOpen: boolean;
  setPoDropOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  setSoDropOpen: (v: boolean) => void;
  poDropRef: React.RefObject<HTMLDivElement>;
  toggleStore: (current: string[], set: (v: string[]) => void, store: string) => void;

  // Min ATS + date range
  minATS: number | "";
  setMinATS: (v: number | "") => void;
  // On-Order date window (inclusive ISO dates; "" = unbounded). Scopes
  // ONLY the "On Order" total/column to SO lines whose date falls in
  // range. The SO date is the Xoro "Date to be Cancelled" (NOT ship
  // date). Lets the operator reproduce a date-windowed Xoro "Open
  // Orders" total without touching the projection/ATS columns.
  soWinFrom: string;
  setSoWinFrom: (v: string) => void;
  soWinTo: string;
  setSoWinTo: (v: string) => void;
  startDate: string;
  setStartDate: (v: string) => void;
  rangeUnit: "days" | "weeks" | "months";
  setRangeUnit: (v: "days" | "weeks" | "months") => void;
  rangeValue: number;
  setRangeValue: (v: number) => void;

  // Customer/vendor dropdown
  excelData: ExcelData | null;
  customerFilter: string;
  setCustomerFilter: (v: string) => void;
  customerDropOpen: boolean;
  setCustomerDropOpen: (v: boolean) => void;
  customerSearch: string;
  setCustomerSearch: (v: string) => void;

  // Collapse mode
  collapseLevel: "none" | "category" | "subCategory" | "style";
  setCollapseLevel: (v: "none" | "category" | "subCategory" | "style") => void;

  // Grid view mode — what each cell shows. "ats" = per-period
  // availability (cumulative free at period 0; new-receipt delta
  // after, via periodAvail). "so" / "po" = SO or PO qty bucketed
  // into the column's period.
  viewMode: "ats" | "so" | "po";
  setViewMode: (v: "ats" | "so" | "po") => void;
  // TOTALS row (sticky header above column labels with Qty / Cost /
  // Sale / Mrgn% summed across the filtered set)
  showTotalsRow: boolean;
  setShowTotalsRow: (v: boolean) => void;
  // Explode prepacks: ON shows unit-grain qtys (5 packs of PPK24 →
  // 120). OFF shows pack counts with a faded "PPK24 = 120" hint so
  // the operator can flip mental gears without recomputing.
  explodePpk: boolean;
  setExplodePpk: (v: boolean) => void;
  // Show per-row style image thumbnails inside the Style column. ON by
  // default; OFF hides them for a denser grid.
  showImages: boolean;
  setShowImages: (v: boolean) => void;
  // Freeze through column: pin leftmost columns up through the
  // chosen one when scrolling horizontally. null = no freeze.
  freezeKey: "category" | "subCategory" | "style" | "description" | "color" | "onHand" | "onOrder" | "onPO" | null;
  setFreezeKey: (v: "category" | "subCategory" | "style" | "description" | "color" | "onHand" | "onOrder" | "onPO" | null) => void;
  // Per-column hide list for the grid's left sticky columns.
  hiddenColumns: string[];
  setHiddenColumns: (v: string[]) => void;
  // Target gross margin % used as fallback when a SKU is missing SO
  // sale prices or cost basis. 0-100, drives the totals row only.
  generalMarginPct: number;
  setGeneralMarginPct: (v: number) => void;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  search, setSearch, filterCategory, setFilterCategory, categories,
  filterSubCategory, setFilterSubCategory, subCategories,
  filterStyle, setFilterStyle, styles,
  filterGender, setFilterGender, genderOptions,
  filterBrand, setFilterBrand, brandOptions,
  setFilterStatus,
  STORES, storeFilter, setStoreFilter, poDropOpen, setPoDropOpen, setSoDropOpen,
  poDropRef, toggleStore,
  minATS, setMinATS, soWinFrom, setSoWinFrom, soWinTo, setSoWinTo, startDate, setStartDate,
  rangeUnit, setRangeUnit, rangeValue, setRangeValue,
  excelData, customerFilter, setCustomerFilter,
  customerDropOpen, setCustomerDropOpen, customerSearch, setCustomerSearch,
  collapseLevel, setCollapseLevel,
  viewMode, setViewMode,
  showTotalsRow, setShowTotalsRow,
  explodePpk, setExplodePpk,
  showImages, setShowImages,
  freezeKey, setFreezeKey,
  hiddenColumns, setHiddenColumns,
  generalMarginPct, setGeneralMarginPct,
}) => {
  // Margin input is decimal-aware. A separate `draft` string is what
  // the controlled <input> binds to, so the user can type "21." and
  // continue with "5" without parseFloat truncating to 21 and forcing
  // the input to re-render at "21" (which would swallow the dot).
  // The numeric prop only updates when the draft parses cleanly
  // (skipping "" / "." / trailing-dot). Sync from prop runs only when
  // it diverges from what the draft parses to, so our own writeback
  // can't clobber an in-progress edit.
  const [marginDraft, setMarginDraft] = useState<string>(() => String(generalMarginPct ?? 21));
  useEffect(() => {
    const cur = parseFloat(marginDraft);
    if (!Number.isFinite(cur) || Math.abs(cur - generalMarginPct) > 0.001) {
      setMarginDraft(String(generalMarginPct));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generalMarginPct]);

  // Reset every filter + collapse to its default state. Window controls
  // (date range / unit / value) are intentionally preserved — those
  // describe the planning horizon, not a filter.
  const handleClearFilters = () => {
    setSearch("");
    setFilterCategory([]);
    setFilterSubCategory([]);
    setFilterStyle([]);
    setFilterGender([]);
    setFilterBrand([]);
    setFilterStatus("All");
    setStoreFilter(["ROF"]);
    setMinATS("");
    setSoWinFrom("");
    setSoWinTo("");
    setCustomerFilter("");
    setCollapseLevel("none");
  };

  // Column visibility dropdown state. Anchored ref + open flag follow
  // the same pattern as the Cust/Vend dropdown a few rows below. Click-
  // outside-to-close handled by useEffect.
  const colDropRef = useRef<HTMLDivElement>(null);
  const [colDropOpen, setColDropOpen] = useState(false);
  useEffect(() => {
    if (!colDropOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (colDropRef.current && !colDropRef.current.contains(e.target as Node)) setColDropOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [colDropOpen]);

  // Mouse-off auto-close handlers for the 3 inline dropdowns (Store,
  // Cust/Vend, Columns). Each gets its own timer so closing one
  // doesn't race with another. See useCloseOnMouseLeave at top of file.
  const storeClose = useCloseOnMouseLeave((v) => setPoDropOpen(v));
  const customerClose = useCloseOnMouseLeave(setCustomerDropOpen);
  const columnsClose = useCloseOnMouseLeave(setColDropOpen);
  const COLUMN_OPTIONS: Array<{ key: string; label: string }> = [
    { key: "category",    label: "Category" },
    { key: "subCategory", label: "Sub Cat" },
    { key: "style",       label: "Style" },
    { key: "description", label: "Description" },
    { key: "color",       label: "Color" },
    { key: "onHand",      label: "On Hand" },
    { key: "onOrder",     label: "On Order" },
    { key: "onPO",        label: "On PO" },
  ];
  const toggleCol = (key: string) => {
    if (hiddenColumns.includes(key)) {
      setHiddenColumns(hiddenColumns.filter(k => k !== key));
    } else {
      setHiddenColumns([...hiddenColumns, key]);
    }
  };

  return (
  <div style={S.toolbar}>
    <button
      onClick={handleClearFilters}
      title="Reset search, all filters (category, sub cat, gender, status, stores, customer, min ATS), and collapse mode. Date range / units are preserved."
      style={{ ...S.select, padding: "6px 12px", color: "#FCA5A5", borderColor: "#7F1D1D", cursor: "pointer", whiteSpace: "nowrap", fontWeight: 600 }}
    >
      ✕ Clear all
    </button>
    <input
      type="text"
      inputMode="text"
      style={S.searchInput}
      placeholder="Search SKU or description…"
      value={search}
      onChange={e => setSearch(e.target.value)}
      onFocus={e => e.currentTarget.select()}
    />
    <MultiSelectDropdown
      label="Category"
      value={filterCategory}
      options={categories.filter(c => c !== "All")}
      onChange={setFilterCategory}
    />
    <MultiSelectDropdown
      label="Sub Cat"
      value={filterSubCategory}
      options={subCategories.filter(c => c !== "All")}
      onChange={setFilterSubCategory}
    />
    <MultiSelectDropdown
      label="Style"
      value={filterStyle}
      options={styles}
      onChange={setFilterStyle}
      minWidth={150}
    />
    <MultiSelectDropdown
      label="Gender"
      value={filterGender}
      options={genderOptions ?? ["M", "B", "C", "Wms", "G"]}
      onChange={setFilterGender}
      getLabel={v => ({ M: "Mens", B: "Boys", C: "Child", Wms: "Women's", G: "Girls" } as Record<string, string>)[v] ?? v}
    />
    <MultiSelectDropdown
      label="Brand"
      value={filterBrand}
      options={brandOptions}
      onChange={setFilterBrand}
      placeholder="Search brands…"
    />
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ color: "#10B981", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>Collapse:</span>
      <SearchableSelect
        value={collapseLevel}
        onChange={v => setCollapseLevel(v as typeof collapseLevel)}
        options={[
          { value: "none", label: "None" },
          { value: "category", label: "Category" },
          { value: "subCategory", label: "Sub Cat" },
          { value: "style", label: "Style" },
        ]}
        inputStyle={S.select}
      />
    </div>
    {/* Store filter */}
    <div ref={poDropRef} style={{ position: "relative" }} onMouseEnter={storeClose.cancel} onMouseLeave={storeClose.schedule}>
      <button
        style={{ ...S.select, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", minWidth: 140, justifyContent: "space-between" }}
        onClick={() => { setPoDropOpen(o => !o); setSoDropOpen(false); }}
      >
        <span style={{ color: "#10B981", fontSize: 11, fontWeight: 600, marginRight: 2 }}>Warehouse:</span>
        <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {storeFilter.includes("All") ? "All warehouses" : storeFilter.join(", ")}
        </span>
        <span style={{ fontSize: 9, color: "#6B7280" }}>▼</span>
      </button>
      {poDropOpen && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200, background: "#1E293B", border: "1px solid #334155", borderRadius: 8, minWidth: 160, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", padding: "6px 0" }}>
          {(["All", ...STORES] as string[]).map(s => {
            const checked = s === "All" ? storeFilter.includes("All") : storeFilter.includes(s);
            return (
              <label
                key={s}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 14px", cursor: "pointer", background: checked ? "rgba(16,185,129,0.08)" : "transparent" }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(16,185,129,0.12)")}
                onMouseLeave={e => (e.currentTarget.style.background = checked ? "rgba(16,185,129,0.08)" : "transparent")}
              >
                <input type="checkbox" checked={checked} onChange={() => toggleStore(storeFilter, setStoreFilter, s)} style={{ accentColor: "#10B981", cursor: "pointer" }} />
                <span style={{ color: checked ? "#6EE7B7" : "#9CA3AF", fontSize: 13 }}>{s}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>

    <div style={S.datePicker}>
      <label style={S.dateLabel}>Min ATS</label>
      <input
        type="number"
        style={{ ...S.dateInput, width: 72 }}
        placeholder="0"
        value={minATS}
        onChange={e => setMinATS(e.target.value === "" ? "" : Number(e.target.value))}
      />
    </div>

    {/* On-Order date window — scopes ONLY the "On Order" total/column to
        SO lines whose date (Xoro "Date to be Cancelled", NOT ship date)
        falls in [from, to] inclusive. Empty = full open book (default).
        Reproduces a date-windowed Xoro "Open Orders" total. Lights up
        amber when active so it's obvious the On Order numbers are
        scoped. The projection/ATS columns are unaffected. */}
    {(() => {
      const active = !!(soWinFrom || soWinTo);
      return (
        <div
          title={'Scope the "On Order" total to sales-order lines whose Cancel Date falls in this range. Leave blank for the full open order book. Note: this is the Xoro "Date to be Cancelled", not the ship date.'}
          style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 8, border: `1px solid ${active ? "#F59E0B" : "#334155"}`, background: active ? "rgba(245,158,11,0.10)" : "transparent", whiteSpace: "nowrap" }}
        >
          <span style={{ color: active ? "#FCD34D" : "#10B981", fontSize: 11, fontWeight: 600 }}>On-Order</span>
          <label style={S.dateLabel}>from</label>
          <AppDatePicker value={soWinFrom} onCommit={setSoWinFrom} style={S.dateInput} />
          <label style={S.dateLabel}>to</label>
          <AppDatePicker value={soWinTo} onCommit={setSoWinTo} style={S.dateInput} />
          {active && (
            <span
              role="button"
              aria-label="Clear On-Order window"
              title="Clear On-Order window"
              onClick={() => { setSoWinFrom(""); setSoWinTo(""); }}
              style={{ fontSize: 12, color: "#FCA5A5", cursor: "pointer", padding: "0 2px", lineHeight: 1 }}
            >×</span>
          )}
        </div>
      );
    })()}

    <div style={S.datePicker}>
      <label style={S.dateLabel}>From</label>
      <AppDatePicker value={startDate} onCommit={setStartDate} style={S.dateInput} />
    </div>

    <div style={S.datePicker}>
      <label style={S.dateLabel}>Show</label>
      <input
        type="number"
        min="1"
        max={rangeUnit === "days" ? 365 : rangeUnit === "weeks" ? 52 : 24}
        style={{ ...S.dateInput, width: 60 }}
        value={rangeValue}
        onChange={e => { const v = Math.max(1, Number(e.target.value)); if (v) setRangeValue(v); }}
      />
      <SearchableSelect
        value={rangeUnit}
        onChange={v => {
          setRangeUnit(v as "days" | "weeks" | "months");
          setRangeValue(v === "days" ? 14 : v === "weeks" ? 2 : 1);
        }}
        options={[
          { value: "days", label: "Days" },
          { value: "weeks", label: "Weeks" },
          { value: "months", label: "Months" },
        ]}
        inputStyle={{ ...S.select, minWidth: 96 }}
      />
    </div>

    {/* Customer / vendor dropdown */}
    <div style={{ position: "relative" }} onMouseEnter={customerClose.cancel} onMouseLeave={customerClose.schedule}>
      <button
        style={{ ...S.select, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", minWidth: 160, justifyContent: "space-between" }}
        onClick={() => setCustomerDropOpen(!customerDropOpen)}
      >
        <span style={{ color: "#10B981", fontSize: 11, fontWeight: 600, marginRight: 2 }}>Cust/Vend:</span>
        <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {customerFilter || "All"}
        </span>
        <span style={{ fontSize: 9, color: "#6B7280" }}>▼</span>
      </button>
      {customerDropOpen && (
        <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, background: "#1E293B", border: "1px solid #334155", borderRadius: 8, zIndex: 100, width: 280, maxHeight: 340, display: "flex", flexDirection: "column", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
          <div style={{ padding: "8px 10px", borderBottom: "1px solid #334155" }}>
            <input
              type="text"
              placeholder="Search customers…"
              value={customerSearch}
              onChange={e => setCustomerSearch(e.target.value)}
              onFocus={e => e.currentTarget.select()}
              autoFocus
              style={{ width: "100%", boxSizing: "border-box", background: "#0F172A", border: "1px solid #334155", borderRadius: 6, padding: "6px 10px", color: "#F1F5F9", fontSize: 12, fontFamily: "inherit", outline: "none" }}
            />
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            <div
              style={{ padding: "7px 14px", cursor: "pointer", fontSize: 12, color: !customerFilter ? "#6EE7B7" : "#9CA3AF", background: !customerFilter ? "rgba(16,185,129,0.08)" : "transparent", fontWeight: !customerFilter ? 600 : 400 }}
              onClick={() => { setCustomerFilter(""); setCustomerDropOpen(false); setCustomerSearch(""); }}
              onMouseEnter={e => (e.currentTarget.style.background = "rgba(16,185,129,0.12)")}
              onMouseLeave={e => (e.currentTarget.style.background = !customerFilter ? "rgba(16,185,129,0.08)" : "transparent")}
            >All Customers</div>
            {(() => {
              const custSet = new Set<string>();
              if (excelData) {
                excelData.sos.forEach(s => { if (s.customerName) custSet.add(s.customerName); });
                excelData.pos.forEach(p => { if (p.vendor) custSet.add(p.vendor); });
              }
              const all = [...custSet].sort();
              const q = customerSearch.toLowerCase();
              const shown = q ? all.filter(c => c.toLowerCase().includes(q)) : all;
              return shown.map(c => (
                <div
                  key={c}
                  style={{ padding: "7px 14px", cursor: "pointer", fontSize: 12, color: customerFilter === c ? "#6EE7B7" : "#CBD5E1", background: customerFilter === c ? "rgba(16,185,129,0.08)" : "transparent", fontWeight: customerFilter === c ? 600 : 400 }}
                  onClick={() => { setCustomerFilter(c); setCustomerDropOpen(false); setCustomerSearch(""); }}
                  onMouseEnter={e => (e.currentTarget.style.background = "rgba(16,185,129,0.12)")}
                  onMouseLeave={e => (e.currentTarget.style.background = customerFilter === c ? "rgba(16,185,129,0.08)" : "transparent")}
                >{c}</div>
              ));
            })()}
          </div>
        </div>
      )}
    </div>

    {/* VIEW mode selector — switches what the date cells show.
       ATS  → per-period availability (cumulative free at period 0;
              per-period new-receipt delta after, via periodAvail)
       SO   → sum of SO qty whose order date falls in the cell's period
       PO   → sum of PO qty whose receipt date falls in the cell's period */}
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ color: "#10B981", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>View:</span>
      <SearchableSelect
        value={viewMode}
        onChange={v => setViewMode(v as "ats" | "so" | "po")}
        options={[
          { value: "ats", label: "ATS" },
          { value: "so", label: "On SO" },
          { value: "po", label: "On PO Receipt" },
        ]}
        inputStyle={S.select}
      />
    </div>

    {/* TOTALS row toggle */}
    <label
      title="Show or hide the totals row above the column headers (Qty, Cost, Sale, Margin)"
      style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "4px 10px", borderRadius: 8, border: `1px solid ${showTotalsRow ? "#3B82F6" : "#334155"}`, background: showTotalsRow ? "rgba(59,130,246,0.12)" : "transparent", userSelect: "none", whiteSpace: "nowrap" }}
    >
      <input type="checkbox" checked={showTotalsRow} onChange={e => setShowTotalsRow(e.target.checked)} style={{ accentColor: "#3B82F6", cursor: "pointer", width: 14, height: 14 }} />
      <span style={{ color: showTotalsRow ? "#93C5FD" : "#9CA3AF", fontSize: 12, fontWeight: showTotalsRow ? 700 : 400 }}>TOTALS</span>
    </label>

    {/* EXPLODE PPK toggle — ON: unit-grain (default, matches selling units).
        OFF: pack count + faded "PPKn = N units" hint. */}
    <label
      title={explodePpk ? "Showing prepacks as units (packs × units-per-pack). Click to switch to pack counts." : "Showing prepacks as packs. Click to switch to unit grain."}
      style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "4px 10px", borderRadius: 8, border: `1px solid ${explodePpk ? "#A855F7" : "#334155"}`, background: explodePpk ? "rgba(168,85,247,0.12)" : "transparent", userSelect: "none", whiteSpace: "nowrap" }}
    >
      <input type="checkbox" checked={explodePpk} onChange={e => setExplodePpk(e.target.checked)} style={{ accentColor: "#A855F7", cursor: "pointer", width: 14, height: 14 }} />
      <span style={{ color: explodePpk ? "#C4B5FD" : "#9CA3AF", fontSize: 12, fontWeight: explodePpk ? 700 : 400 }}>EXPLODE PPK</span>
    </label>

    {/* IMAGES toggle — ON shows a per-row style thumbnail inside the
        Style column (click to open the full gallery: enlarge / download
        / print). OFF hides them for a denser grid. */}
    <label
      title={showImages ? "Showing style image thumbnails in the Style column. Click a thumbnail to view all images. Click here to hide images." : "Style images hidden. Click to show per-row thumbnails."}
      style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "4px 10px", borderRadius: 8, border: `1px solid ${showImages ? "#0EA5E9" : "#334155"}`, background: showImages ? "rgba(14,165,233,0.12)" : "transparent", userSelect: "none", whiteSpace: "nowrap" }}
    >
      <input type="checkbox" checked={showImages} onChange={e => setShowImages(e.target.checked)} style={{ accentColor: "#0EA5E9", cursor: "pointer", width: 14, height: 14 }} />
      <span style={{ color: showImages ? "#7DD3FC" : "#9CA3AF", fontSize: 12, fontWeight: showImages ? 700 : 400 }}>IMAGES</span>
    </label>

    {/* Freeze-through dropdown — pin leftmost columns when scrolling.
        Default "On PO" matches the historical all-8-sticky behavior;
        the planner can scale freeze back to fewer columns or off. */}
    <div title="Pin leftmost columns through the chosen one when scrolling horizontally">
      <SearchableSelect
        value={freezeKey ?? ""}
        onChange={v => setFreezeKey((v || null) as typeof freezeKey)}
        options={[
          { value: "", label: "No freeze" },
          { value: "category", label: "Freeze through Category" },
          { value: "subCategory", label: "Freeze through Sub Cat" },
          { value: "style", label: "Freeze through Style" },
          { value: "description", label: "Freeze through Description" },
          { value: "color", label: "Freeze through Color" },
          { value: "onHand", label: "Freeze through On Hand" },
          { value: "onOrder", label: "Freeze through On Order" },
          { value: "onPO", label: "Freeze through On PO" },
        ]}
        inputStyle={{ ...S.select, fontSize: 12, padding: "4px 8px" }}
      />
    </div>

    {/* Columns visibility dropdown — toggle individual sticky-left
        columns on/off (Category through On PO). Hidden count appears
        as a badge so the operator knows when the grid is narrowed. */}
    <div ref={colDropRef} style={{ position: "relative" }} onMouseEnter={columnsClose.cancel} onMouseLeave={columnsClose.schedule}>
      <button
        onClick={() => setColDropOpen(o => !o)}
        title="Show / hide grid columns"
        style={{ ...S.select, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", whiteSpace: "nowrap" }}
      >
        <span style={{ color: "#10B981", fontSize: 11, fontWeight: 600 }}>Columns</span>
        {hiddenColumns.length > 0 && (
          <span style={{ background: "#0EA5E9", color: "#fff", borderRadius: 8, padding: "0 6px", fontSize: 10, fontWeight: 700 }}>
            {hiddenColumns.length} hidden
          </span>
        )}
        <span style={{ fontSize: 9, color: "#6B7280" }}>▼</span>
      </button>
      {colDropOpen && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200, background: "#1E293B", border: "1px solid #334155", borderRadius: 8, minWidth: 180, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", padding: "6px 0" }}>
          {COLUMN_OPTIONS.map(c => {
            const visible = !hiddenColumns.includes(c.key);
            return (
              <label
                key={c.key}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 14px", cursor: "pointer", background: visible ? "rgba(16,185,129,0.06)" : "transparent" }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(16,185,129,0.12)")}
                onMouseLeave={e => (e.currentTarget.style.background = visible ? "rgba(16,185,129,0.06)" : "transparent")}
              >
                <input type="checkbox" checked={visible} onChange={() => toggleCol(c.key)} style={{ accentColor: "#10B981", cursor: "pointer" }} />
                <span style={{ color: visible ? "#6EE7B7" : "#9CA3AF", fontSize: 13 }}>{c.label}</span>
              </label>
            );
          })}
          {hiddenColumns.length > 0 && (
            <div style={{ borderTop: "1px solid #334155", padding: "6px 14px" }}>
              <button
                onClick={() => setHiddenColumns([])}
                style={{ background: "none", border: "none", color: "#60A5FA", cursor: "pointer", fontSize: 11, padding: 0 }}
              >
                Show all columns
              </button>
            </div>
          )}
        </div>
      )}
    </div>

    {/* General margin % — fills in Sale / Cost when SOs / avg cost / PO cost are missing.
       Only relevant when the totals header is showing, so the
       bubble is hidden when TOTALS is off. Once the user changes
       the value off the default (21), the input lights up
       light-blue to make it obvious the totals are being driven
       by a custom assumption. */}
    {showTotalsRow && (() => {
      const touched = generalMarginPct !== 21;
      return (
        <label
          title="Click to edit. Target gross margin % used as fallback in the totals row when a SKU has no SO sale prices or no cost basis. SKUs with no SO, no avg cost, AND no PO cost are skipped (* shown next to Mrgn). Decimal values are accepted (e.g. 21.5)."
          onClick={(e) => {
            if (e.target instanceof HTMLInputElement) return;
            const input = (e.currentTarget as HTMLLabelElement).querySelector("input");
            if (input) { input.focus(); input.select(); }
          }}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 8, border: `1px solid ${touched ? "#3B82F6" : "#334155"}`, background: touched ? "rgba(59,130,246,0.12)" : "transparent", userSelect: "none", whiteSpace: "nowrap", cursor: "text" }}
        >
          <span style={{ color: touched ? "#93C5FD" : "#9CA3AF", fontSize: 12, fontWeight: touched ? 700 : 600 }}>MARGIN</span>
          <input
            type="text"
            inputMode="decimal"
            value={marginDraft}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              // Strip non-digits/dots; collapse multiple dots to one.
              let raw = e.target.value.replace(/[^0-9.]/g, "");
              const firstDot = raw.indexOf(".");
              if (firstDot !== -1) {
                raw = raw.slice(0, firstDot + 1) + raw.slice(firstDot + 1).replace(/\./g, "");
              }
              setMarginDraft(raw);
              // Skip incomplete inputs ("" / "." / "21.") — committing
              // them would reset to an integer and snap the input back.
              if (raw === "" || raw === "." || raw.endsWith(".")) return;
              const n = parseFloat(raw);
              if (Number.isFinite(n)) setGeneralMarginPct(Math.max(0, Math.min(99, n)));
            }}
            onBlur={() => {
              // Normalize on blur so a partial "21." commits as 21.
              if (marginDraft === "" || marginDraft === ".") {
                setGeneralMarginPct(0);
                setMarginDraft("0");
              } else {
                const n = parseFloat(marginDraft);
                if (Number.isFinite(n)) {
                  const clamped = Math.max(0, Math.min(99, n));
                  setGeneralMarginPct(clamped);
                  setMarginDraft(String(clamped));
                }
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            style={{ width: 56, background: "#0F172A", border: `1px solid ${touched ? "#3B82F6" : "#334155"}`, borderRadius: 4, color: touched ? "#93C5FD" : "#F1F5F9", padding: "2px 6px", fontSize: 12, textAlign: "right", fontFamily: "monospace" }}
          />
          <span style={{ color: touched ? "#93C5FD" : "#6B7280", fontSize: 12 }}>%</span>
        </label>
      );
    })()}{/* /MARGIN bubble — totals-conditional */}
  </div>
  );
};
