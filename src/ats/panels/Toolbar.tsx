import React, { useState, useEffect, useRef } from "react";
import S from "../styles";
import { fmtDateDisplay } from "../helpers";
import type { ExcelData } from "../types";

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
  filterCategory: string;
  setFilterCategory: (v: string) => void;
  categories: string[];
  filterSubCategory: string;
  setFilterSubCategory: (v: string) => void;
  subCategories: string[];
  filterGender: string;
  setFilterGender: (v: string) => void;
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

  // AT SHIP + status line
  atShip: boolean;
  setAtShip: (v: boolean) => void;
  // TOTALS row (sticky header above column labels with Qty / Cost /
  // Sale / Mrgn% summed across the filtered set)
  showTotalsRow: boolean;
  setShowTotalsRow: (v: boolean) => void;
  // Explode prepacks: ON shows unit-grain qtys (5 packs of PPK24 →
  // 120). OFF shows pack counts with a faded "PPK24 = 120" hint so
  // the operator can flip mental gears without recomputing.
  explodePpk: boolean;
  setExplodePpk: (v: boolean) => void;
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
  filteredCount: number;
  lastSync: string;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  search, setSearch, filterCategory, setFilterCategory, categories,
  filterSubCategory, setFilterSubCategory, subCategories,
  filterGender, setFilterGender,
  STORES, storeFilter, setStoreFilter, poDropOpen, setPoDropOpen, setSoDropOpen,
  poDropRef, toggleStore,
  minATS, setMinATS, startDate, setStartDate,
  rangeUnit, setRangeUnit, rangeValue, setRangeValue,
  excelData, customerFilter, setCustomerFilter,
  customerDropOpen, setCustomerDropOpen, customerSearch, setCustomerSearch,
  collapseLevel, setCollapseLevel,
  atShip, setAtShip,
  showTotalsRow, setShowTotalsRow,
  explodePpk, setExplodePpk,
  freezeKey, setFreezeKey,
  hiddenColumns, setHiddenColumns,
  generalMarginPct, setGeneralMarginPct,
  filteredCount, lastSync,
}) => {
  // Reset every filter + collapse to its default state. Window controls
  // (date range / unit / value) are intentionally preserved — those
  // describe the planning horizon, not a filter.
  const handleClearFilters = () => {
    setSearch("");
    setFilterCategory("All");
    setFilterSubCategory("All");
    setFilterGender("All");
    setStoreFilter(["ROF"]);
    setMinATS("");
    setCustomerFilter("");
    setCollapseLevel("none");
    setAtShip(false);
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
      title="Reset all filters and collapse to defaults (window settings preserved)"
      style={{ ...S.select, padding: "6px 10px", color: "#94A3B8", cursor: "pointer", whiteSpace: "nowrap" }}
    >
      ✕ Clear filters
    </button>
    <input
      type="text"
      inputMode="text"
      style={S.searchInput}
      placeholder="Search SKU or description…"
      value={search}
      onChange={e => setSearch(e.target.value)}
    />
    <SearchableDropdown label="Category" value={filterCategory} options={categories} onChange={setFilterCategory} />
    <SearchableDropdown label="Sub Cat"  value={filterSubCategory} options={subCategories} onChange={setFilterSubCategory} />
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ color: "#10B981", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>Gender:</span>
      <select style={S.select} value={filterGender} onChange={e => setFilterGender(e.target.value)}>
        <option value="All">All</option>
        <option value="M">Mens</option>
        <option value="B">Boys</option>
        <option value="C">Child</option>
        <option value="Wms">Women's</option>
        <option value="G">Girls</option>
      </select>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ color: "#10B981", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>Collapse:</span>
      <select style={S.select} value={collapseLevel} onChange={e => setCollapseLevel(e.target.value as typeof collapseLevel)}>
        <option value="none">None</option>
        <option value="category">Category</option>
        <option value="subCategory">Sub Cat</option>
        <option value="style">Style</option>
      </select>
    </div>
    {/* Store filter */}
    <div ref={poDropRef} style={{ position: "relative" }}>
      <button
        style={{ ...S.select, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", minWidth: 140, justifyContent: "space-between" }}
        onClick={() => { setPoDropOpen(o => !o); setSoDropOpen(false); }}
      >
        <span style={{ color: "#10B981", fontSize: 11, fontWeight: 600, marginRight: 2 }}>Store:</span>
        <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {storeFilter.includes("All") ? "All stores" : storeFilter.join(", ")}
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

    <div style={S.datePicker}>
      <label style={S.dateLabel}>From</label>
      <input
        type="date"
        style={S.dateInput}
        value={startDate}
        onChange={e => setStartDate(e.target.value)}
      />
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
      <select
        style={{ ...S.select, minWidth: 96 }}
        value={rangeUnit}
        onChange={e => {
          setRangeUnit(e.target.value as "days" | "weeks" | "months");
          setRangeValue(e.target.value === "days" ? 14 : e.target.value === "weeks" ? 2 : 1);
        }}
      >
        <option value="days">Days</option>
        <option value="weeks">Weeks</option>
        <option value="months">Months</option>
      </select>
    </div>

    {/* Customer / vendor dropdown */}
    <div style={{ position: "relative" }}>
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

    {/* AT SHIP toggle */}
    <label
      title="Show only qty free to ship — not reserved for future uncovered SOs"
      style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "4px 10px", borderRadius: 8, border: `1px solid ${atShip ? "#10B981" : "#334155"}`, background: atShip ? "rgba(16,185,129,0.12)" : "transparent", userSelect: "none", whiteSpace: "nowrap" }}
    >
      <input type="checkbox" checked={atShip} onChange={e => setAtShip(e.target.checked)} style={{ accentColor: "#10B981", cursor: "pointer", width: 14, height: 14 }} />
      <span style={{ color: atShip ? "#6EE7B7" : "#9CA3AF", fontSize: 12, fontWeight: atShip ? 700 : 400 }}>AT SHIP</span>
    </label>

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

    {/* Freeze-through dropdown — pin leftmost columns when scrolling.
        Default "On PO" matches the historical all-8-sticky behavior;
        the planner can scale freeze back to fewer columns or off. */}
    <select
      value={freezeKey ?? ""}
      onChange={e => setFreezeKey((e.target.value || null) as typeof freezeKey)}
      title="Pin leftmost columns through the chosen one when scrolling horizontally"
      style={{ ...S.select, fontSize: 12, padding: "4px 8px" }}
    >
      <option value="">No freeze</option>
      <option value="category">Freeze through Category</option>
      <option value="subCategory">Freeze through Sub Cat</option>
      <option value="style">Freeze through Style</option>
      <option value="description">Freeze through Description</option>
      <option value="color">Freeze through Color</option>
      <option value="onHand">Freeze through On Hand</option>
      <option value="onOrder">Freeze through On Order</option>
      <option value="onPO">Freeze through On PO</option>
    </select>

    {/* Columns visibility dropdown — toggle individual sticky-left
        columns on/off (Category through On PO). Hidden count appears
        as a badge so the operator knows when the grid is narrowed. */}
    <div ref={colDropRef} style={{ position: "relative" }}>
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
          title="Click to edit. Target gross margin % used as fallback in the totals row when a SKU has no SO sale prices or no cost basis. SKUs with no SO, no avg cost, AND no PO cost are skipped (* shown next to Mrgn)."
          onClick={(e) => {
            // Tap the label/value/% surround to focus + select. If
            // the click landed on the input itself, leave caret
            // placement to the browser so the user can position
            // mid-edit without losing their click target.
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
            value={String(generalMarginPct)}
            onFocus={(e) => e.currentTarget.select()}
            onChange={e => {
              const raw = e.target.value.replace(/[^0-9.]/g, "");
              if (raw === "") { setGeneralMarginPct(0); return; }
              const n = parseFloat(raw);
              if (Number.isFinite(n)) setGeneralMarginPct(Math.max(0, Math.min(99, n)));
            }}
            style={{ width: 44, background: "#0F172A", border: `1px solid ${touched ? "#3B82F6" : "#334155"}`, borderRadius: 4, color: touched ? "#93C5FD" : "#F1F5F9", padding: "2px 6px", fontSize: 12, textAlign: "right", fontFamily: "monospace" }}
          />
          <span style={{ color: touched ? "#93C5FD" : "#6B7280", fontSize: 12 }}>%</span>
        </label>
      );
    })()}{/* /MARGIN bubble — totals-conditional */}


    <div style={{ color: "#6B7280", fontSize: 12, whiteSpace: "nowrap" }}>
      {filteredCount.toLocaleString()} SKUs
      {lastSync && <span style={{ display: "block" }}>Synced {fmtDateDisplay(lastSync.split("T")[0])} {new Date(lastSync).toLocaleTimeString()}</span>}
    </div>
  </div>
  );
};
