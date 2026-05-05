// Phase 3 reconciliation grid. One row per (sku, month).
// Filter + collapse + pagination ported from the wholesale planning
// grid (same MultiSelectDropdown filter strip, same search-with-
// inline-× pattern, same paginator). Recon-specific: skips the
// customer/sub-cat/color/gender/confidence/method filters that don't
// map to a per-(sku, period) grain. Adds Period and Priority.

import { useEffect, useMemo, useState } from "react";
import type { IpReconciliationGridRow } from "../types/supply";
import type { CSSProperties } from "react";
import { S, PAL, formatQty, formatPeriodCode } from "../../components/styles";
import { StatCell } from "../../components/StatCell";
import { MultiSelectDropdown } from "../../components/MultiSelectDropdown";
import { ColumnsButton } from "../../components/cells/ColumnsButton";

export interface ReconciliationGridProps {
  rows: IpReconciliationGridRow[];
  loading?: boolean;
  onSelectRow: (row: IpReconciliationGridRow) => void;
}

// Every column on the grid is sortable. The header `<Th>` toggles
// asc → desc → asc on repeated click. Numeric columns default to
// desc (largest first) since planners triage by magnitude; string
// columns default to asc (alphabetical).
type SortKey =
  | "sku" | "style" | "category" | "subCat" | "period"
  | "onHand" | "ats" | "inboundPo" | "plannedBuy" | "receipts" | "wip"
  | "supply"
  | "wsDemand" | "ecomDemand" | "protected" | "reserved" | "allocated" | "ending"
  | "shortage" | "excess" | "priority";

const NUMERIC_DESC_FIRST: ReadonlySet<SortKey> = new Set([
  "onHand", "ats", "inboundPo", "plannedBuy", "receipts", "wip", "supply",
  "wsDemand", "ecomDemand", "protected", "reserved", "allocated", "ending",
  "shortage", "excess",
]);

const PRIORITY_COLOR: Record<string, string> = {
  critical: "#EF4444",
  high:     "#F59E0B",
  medium:   "#3B82F6",
  low:      "#94A3B8",
};

const ACTION_COLOR: Record<string, string> = {
  buy:               "#3B82F6",
  expedite:          "#EF4444",
  reduce:            "#F59E0B",
  hold:              "#6B7280",
  monitor:           "#94A3B8",
  reallocate:        "#8B5CF6",
  cancel_receipt:    "#F59E0B",
  push_receipt:      "#3B82F6",
  protect_inventory: "#10B981",
};

// Collapse modes — recon-specific. Each rolls the per-(sku, period)
// rows up to the chosen dimension, summing the qty columns. Multiple
// modes can be active at once (e.g. "by category" + "by period" =
// one row per (category, period)).
type CollapseMode = "category" | "sku" | "period";
const COLLAPSE_OPTIONS: Array<{ value: CollapseMode; label: string }> = [
  { value: "category", label: "By category" },
  { value: "sku",      label: "By SKU (collapse periods)" },
  { value: "period",   label: "By period (collapse SKUs)" },
];

// Synthetic row used for aggregate rendering — same shape as a real
// grid row but with sku_id / category prefixed by `agg:` so React
// keys stay unique and the click handler can distinguish.
type GridRow = IpReconciliationGridRow & { _agg?: boolean; _aggKey?: string };

export default function ReconciliationGrid({ rows, loading, onSelectRow }: ReconciliationGridProps) {
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState<string[]>([]);
  const [filterSubCat, setFilterSubCat] = useState<string[]>([]);
  const [filterStyle, setFilterStyle] = useState<string[]>([]);
  const [filterGender, setFilterGender] = useState<string[]>([]);
  const [filterPriority, setFilterPriority] = useState<string[]>([]);
  const [filterAction, setFilterAction] = useState<string[]>([]);
  const [filterPeriod, setFilterPeriod] = useState<string[]>([]);
  const [filterStockout, setFilterStockout] = useState<"all" | "stockout" | "ok">("all");
  const [collapse, setCollapse] = useState<CollapseMode[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(500);

  // Reset to page 0 when any filter / sort / page-size shifts so the
  // planner doesn't end up on a now-empty page after narrowing the
  // view. Same reset behavior as wholesale grid.
  useEffect(() => { setPage(0); }, [search, filterCategory, filterSubCat, filterStyle, filterGender, filterPriority, filterAction, filterPeriod, filterStockout, collapse, sortKey, sortDir, pageSize]);

  // ── Column visibility — same pattern as the wholesale grid:
  //    a Set of hidden column keys, persisted to localStorage so
  //    the planner's choice survives reloads. Applied via colHide()
  //    on every <td> + the `hidden` prop on each Th.
  // SKU and Action are not in the toggleable list — they're always
  // visible (primary identifier + verdict).
  const TOGGLEABLE_COLUMNS: Array<{ key: string; label: string }> = [
    { key: "style",      label: "Style" },
    { key: "category",   label: "Category" },
    { key: "subCat",     label: "Sub Cat" },
    { key: "period",     label: "Period" },
    { key: "onHand",     label: "On hand" },
    { key: "ats",        label: "ATS" },
    { key: "inboundPo",  label: "Inbound PO" },
    { key: "plannedBuy", label: "Planned Buy" },
    { key: "receipts",   label: "Receipts" },
    { key: "wip",        label: "WIP" },
    { key: "supply",     label: "Supply" },
    { key: "wsDemand",   label: "W/s dmd" },
    { key: "ecomDemand", label: "Ecom dmd" },
    { key: "protected",  label: "Protected" },
    { key: "reserved",   label: "Reserved" },
    { key: "allocated",  label: "Allocated" },
    { key: "ending",     label: "Ending" },
    { key: "shortage",   label: "Shortage" },
    { key: "excess",     label: "Excess" },
  ];
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("ip_recon_hidden_columns");
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr : []);
    } catch { return new Set(); }
  });
  function toggleColumn(key: string) {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem("ip_recon_hidden_columns", JSON.stringify(Array.from(next))); }
      catch { /* ignore quota */ }
      return next;
    });
  }
  function resetColumns() {
    setHiddenColumns(new Set());
    try { localStorage.removeItem("ip_recon_hidden_columns"); } catch { /* ignore */ }
  }
  const colHide = (key: string): CSSProperties | undefined =>
    hiddenColumns.has(key) ? { display: "none" } : undefined;

  // ── Option pools — derived from the row set so picker shows only
  //    values present in the data.
  // Cat filter uses group_name (item.attributes.group_name) — same
  // source the wholesale grid uses. ip_projected_inventory.category_id
  // is sparse so the FK-derived category_name was producing a blank
  // dropdown.
  const groupNames = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.group_name) set.add(r.group_name);
    return Array.from(set).sort();
  }, [rows]);
  const periods = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.period_code) set.add(r.period_code);
    return Array.from(set).sort();
  }, [rows]);
  const subCats = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.sub_category_name) set.add(r.sub_category_name);
    return Array.from(set).sort();
  }, [rows]);
  const styles = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.sku_style) set.add(r.sku_style);
    return Array.from(set).sort();
  }, [rows]);
  const genders = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.gender) set.add(r.gender);
    return Array.from(set).sort();
  }, [rows]);
  const actions = useMemo(() => Object.keys(ACTION_COLOR), []);
  const priorities = useMemo(() => ["critical", "high", "medium", "low"], []);

  // ── Filter pass — same shape as wholesale grid: every dim is a
  //    multi-select; empty array = no filter on that dim.
  const filteredAll = useMemo(() => {
    const q = search.trim().toUpperCase();
    const out = rows.filter((r) => {
      if (filterCategory.length > 0 && (!r.group_name || !filterCategory.includes(r.group_name))) return false;
      if (filterSubCat.length > 0 && (!r.sub_category_name || !filterSubCat.includes(r.sub_category_name))) return false;
      if (filterStyle.length > 0 && (!r.sku_style || !filterStyle.includes(r.sku_style))) return false;
      if (filterGender.length > 0 && (!r.gender || !filterGender.includes(r.gender))) return false;
      if (filterPriority.length > 0 && (!r.top_recommendation_priority || !filterPriority.includes(r.top_recommendation_priority))) return false;
      if (filterAction.length > 0 && (!r.top_recommendation || !filterAction.includes(r.top_recommendation))) return false;
      if (filterPeriod.length > 0 && !filterPeriod.includes(r.period_code)) return false;
      if (filterStockout === "stockout" && !r.projected_stockout_flag) return false;
      if (filterStockout === "ok" && r.projected_stockout_flag) return false;
      if (q && !(
        r.sku_code.toUpperCase().includes(q)
        || (r.sku_description ?? "").toUpperCase().includes(q)
        || (r.group_name ?? "").toUpperCase().includes(q)
        || (r.sub_category_name ?? "").toUpperCase().includes(q)
        || (r.sku_style ?? "").toUpperCase().includes(q)
      )) return false;
      return true;
    });
    return out.sort((a, b) => cmp(a, b, sortKey, sortDir));
  }, [rows, search, filterCategory, filterPriority, filterAction, filterPeriod, filterStockout, sortKey, sortDir]);

  // ── Collapse — aggregate filtered rows to whichever dim(s) are on.
  const displayRows = useMemo<GridRow[]>(() => {
    if (collapse.length === 0) return filteredAll;
    return aggregateByDims(filteredAll, collapse);
  }, [filteredAll, collapse]);

  const totals = useMemo(() => {
    const t = { supply: 0, demand: 0, shortage: 0, excess: 0, stockouts: 0, critical: 0 };
    for (const r of filteredAll) {
      t.supply += r.total_available_supply_qty;
      t.demand += r.wholesale_demand_qty + r.ecom_demand_qty;
      t.shortage += r.shortage_qty;
      t.excess += r.excess_qty;
      if (r.projected_stockout_flag) t.stockouts++;
      if (r.top_recommendation_priority === "critical") t.critical++;
    }
    return t;
  }, [filteredAll]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(NUMERIC_DESC_FIRST.has(k) ? "desc" : "asc"); }
  }

  return (
    <div>
      <div style={S.statsRow}>
        <StatCell label="Rows" value={displayRows.length.toLocaleString()} />
        <StatCell label="Σ Supply" value={formatQty(totals.supply)} accent={PAL.accent} />
        <StatCell label="Σ Demand" value={formatQty(totals.demand)} accent={PAL.text} />
        <StatCell label="Σ Shortage" value={formatQty(totals.shortage)} accent={PAL.red} />
        <StatCell label="Stockouts / Critical" value={`${totals.stockouts} / ${totals.critical}`} accent={PAL.red} />
      </div>

      {/* ── Filter strip — same shape as the wholesale grid: search
          with inline × clear, then multi-select dropdowns, then the
          Clear-all button. The inline × replaces the previous
          standalone "Clear" button on this grid (search clear was
          the same work). */}
      <div style={S.toolbar}>
        <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
          <input
            className="ip-search-input"
            style={{ ...S.input, width: 220, padding: "6px 32px 6px 12px", fontSize: 12 }}
            placeholder="Search SKU / style / category"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={(e) => {
              if (e.currentTarget.value) {
                const el = e.currentTarget;
                setTimeout(() => el.select(), 0);
              }
            }}
          />
          {search && (
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); setSearch(""); }}
              title="Clear search"
              aria-label="Clear search"
              style={{
                position: "absolute",
                right: 6,
                top: "50%",
                transform: "translateY(-50%)",
                width: 22, height: 22, padding: 0,
                border: `1px solid ${PAL.border}`,
                background: PAL.bg,
                color: PAL.text,
                cursor: "pointer",
                fontSize: 13, fontWeight: 700, lineHeight: 1,
                borderRadius: 4,
              }}
            >×</button>
          )}
        </div>
        <MultiSelectDropdown
          compact
          selected={filterCategory}
          onChange={setFilterCategory}
          allLabel="All categories"
          placeholder="Search categories…"
          options={groupNames.map((g) => ({ value: g, label: g }))}
        />
        <MultiSelectDropdown
          compact
          selected={filterSubCat}
          onChange={setFilterSubCat}
          allLabel="All sub cats"
          placeholder="Search sub cats…"
          options={subCats.map((s) => ({ value: s, label: s }))}
        />
        <MultiSelectDropdown
          compact
          selected={filterStyle}
          onChange={setFilterStyle}
          allLabel="All styles"
          placeholder="Search styles…"
          options={styles.map((s) => ({ value: s, label: s }))}
        />
        <MultiSelectDropdown
          compact
          selected={filterGender}
          onChange={setFilterGender}
          allLabel="All genders"
          placeholder="Search genders…"
          options={genders.map((g) => ({ value: g, label: g }))}
          title="Gender filter — sourced from item-master GenderCode."
        />
        <MultiSelectDropdown
          compact
          selected={filterPeriod}
          onChange={setFilterPeriod}
          allLabel="All periods"
          placeholder="Search periods…"
          options={periods.map((p) => ({ value: p, label: formatPeriodCode(p) }))}
        />
        <MultiSelectDropdown
          compact
          selected={filterAction}
          onChange={setFilterAction}
          allLabel="All actions"
          placeholder="Search actions…"
          options={actions.map((a) => ({ value: a, label: a.replace(/_/g, " ") }))}
        />
        <MultiSelectDropdown
          compact
          selected={filterPriority}
          onChange={setFilterPriority}
          allLabel="All priorities"
          placeholder="Search priorities…"
          options={priorities.map((p) => ({ value: p, label: p }))}
        />
        <select style={S.select} value={filterStockout} onChange={(e) => setFilterStockout(e.target.value as "all" | "stockout" | "ok")}>
          <option value="all">Stockout: any</option>
          <option value="stockout">Projected stockouts</option>
          <option value="ok">Covered</option>
        </select>
        <button style={{ ...S.btnSecondary, padding: "5px 10px", fontSize: 12 }} onClick={() => {
          setSearch("");
          setFilterCategory([]); setFilterSubCat([]); setFilterStyle([]); setFilterGender([]);
          setFilterPriority([]); setFilterAction([]); setFilterPeriod([]);
          setFilterStockout("all"); setCollapse([]);
        }}>Clear</button>
        <ColumnsButton
          columns={TOGGLEABLE_COLUMNS}
          hidden={hiddenColumns}
          onToggle={toggleColumn}
          onReset={resetColumns}
        />
      </div>

      {/* Collapse strip — porting the wholesale grid's pattern. The
          recon grain is (sku, period) so the collapse modes here
          are dim-rollups instead of customer/style hierarchies. */}
      <div style={{ ...S.toolbar, marginTop: -4, paddingTop: 0, gap: 10, fontSize: 12, color: PAL.textDim }}>
        <span style={{ fontWeight: 600 }}>Collapse:</span>
        <MultiSelectDropdown
          compact
          closeOnMouseLeave
          selected={collapse}
          onChange={(next) => setCollapse(next as CollapseMode[])}
          allLabel="None"
          placeholder="Search collapse modes…"
          options={COLLAPSE_OPTIONS}
          minWidth={210}
        />
        {collapse.length > 0 && (
          <button style={{ ...S.btnSecondary, fontSize: 11, padding: "2px 8px" }}
                  onClick={() => setCollapse([])}>Reset collapse</button>
        )}
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <Th label="SKU"        k="sku"        sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Th label="Style"      k="style"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("style")} />
              <Th label="Category"   k="category"   sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("category")} />
              <Th label="Sub Cat"    k="subCat"     sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("subCat")} />
              <Th label="Period"     k="period"     sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("period")} />
              <Th label="On hand"    k="onHand"     sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("onHand")} />
              <Th label="ATS"        k="ats"        sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("ats")} />
              <Th label="Inbound PO" k="inboundPo"  sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("inboundPo")} />
              <Th label="Planned Buy" k="plannedBuy" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric title="Phase 1 planned_buy_qty bucketed to (sku, period). Counted toward Supply only when the run flag is on." hidden={hiddenColumns.has("plannedBuy")} />
              <Th label="Receipts"   k="receipts"   sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("receipts")} />
              <Th label="WIP"        k="wip"        sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("wip")} />
              <Th label="Supply"     k="supply"     sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("supply")} />
              <Th label="W/s dmd"    k="wsDemand"   sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("wsDemand")} />
              <Th label="Ecom dmd"   k="ecomDemand" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("ecomDemand")} />
              <Th label="Protected"  k="protected"  sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("protected")} />
              <Th label="Reserved"   k="reserved"   sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("reserved")} />
              <Th label="Allocated"  k="allocated"  sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("allocated")} />
              <Th label="Ending"     k="ending"     sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("ending")} />
              <Th label="Shortage"   k="shortage"   sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("shortage")} />
              <Th label="Excess"     k="excess"     sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("excess")} />
              <Th label="Action"     k="priority"   sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {displayRows.slice(page * pageSize, (page + 1) * pageSize).map((r) => (
              <tr key={r._aggKey ?? r.projected_id}
                  style={{
                    cursor: r._agg ? "default" : "pointer",
                    background: r._agg
                      ? `${PAL.accent2}1F`
                      : (r.projected_stockout_flag ? "#3f1d1d22" : undefined),
                    fontWeight: r._agg ? 600 : undefined,
                  }}
                  onClick={() => { if (!r._agg) onSelectRow(r); }}>
                <td style={{ ...S.td, fontFamily: "monospace", color: r._agg ? PAL.text : PAL.accent }}>{r.sku_code}</td>
                <td style={{ ...S.td, fontFamily: "monospace", color: PAL.textDim }}>{r.sku_style ?? "–"}</td>
                <td style={{ ...S.td, color: PAL.textDim }}>{r.group_name ?? r.category_name ?? "–"}</td>
                <td style={{ ...S.td, color: PAL.textDim }}>{r.sub_category_name ?? "–"}</td>
                <td style={S.td}>{r.period_code ? formatPeriodCode(r.period_code) : "–"}</td>
                <td style={S.tdNum}>{formatQty(r.beginning_on_hand_qty)}</td>
                <td style={{ ...S.tdNum, color: PAL.textDim }}>{formatQty(r.ats_qty)}</td>
                <td style={S.tdNum}>{formatQty(r.inbound_po_qty)}</td>
                <td style={{ ...S.tdNum, color: r.inbound_planned_buy_qty > 0 ? PAL.green : PAL.textMuted }}>
                  {formatQty(r.inbound_planned_buy_qty)}
                </td>
                <td style={S.tdNum}>{formatQty(r.inbound_receipts_qty)}</td>
                <td style={{ ...S.tdNum, color: PAL.textMuted }}>{formatQty(r.wip_qty)}</td>
                <td style={{ ...S.tdNum, color: PAL.accent, fontWeight: 700 }}>{formatQty(r.total_available_supply_qty)}</td>
                <td style={S.tdNum}>{formatQty(r.wholesale_demand_qty)}</td>
                <td style={S.tdNum}>{formatQty(r.ecom_demand_qty)}</td>
                <td style={{ ...S.tdNum, color: PAL.green }}>{formatQty(r.protected_ecom_qty)}</td>
                <td style={{ ...S.tdNum, color: PAL.yellow }}>{formatQty(r.reserved_wholesale_qty)}</td>
                <td style={{ ...S.tdNum, color: PAL.text, fontWeight: 600 }}>{formatQty(r.allocated_total_qty)}</td>
                <td style={{ ...S.tdNum, color: r.ending_inventory_qty > 0 ? PAL.textDim : PAL.textMuted }}>
                  {formatQty(r.ending_inventory_qty)}
                </td>
                <td style={{ ...S.tdNum, color: r.shortage_qty > 0 ? PAL.red : PAL.textMuted }}>
                  {formatQty(r.shortage_qty)}
                </td>
                <td style={{ ...S.tdNum, color: r.excess_qty > 0 ? PAL.yellow : PAL.textMuted }}>
                  {formatQty(r.excess_qty)}
                </td>
                <td style={S.td}>
                  {r.top_recommendation ? (
                    <span style={{
                      ...S.chip,
                      background: (ACTION_COLOR[r.top_recommendation] ?? PAL.textMuted) + "33",
                      color: ACTION_COLOR[r.top_recommendation] ?? PAL.textMuted,
                      marginRight: 6,
                    }}>
                      {r.top_recommendation}
                    </span>
                  ) : "–"}
                  {r.top_recommendation_priority && (
                    <span style={{
                      ...S.chip,
                      background: (PRIORITY_COLOR[r.top_recommendation_priority] ?? PAL.textMuted) + "33",
                      color: PRIORITY_COLOR[r.top_recommendation_priority] ?? PAL.textMuted,
                    }}>
                      {r.top_recommendation_priority}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {!loading && displayRows.length === 0 && (
              <tr><td colSpan={21} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                {rows.length === 0
                  ? "No reconciled rows yet. Run the reconciliation pass above to populate the grid."
                  : "No rows match your filters."}
              </td></tr>
            )}
            {loading && (
              <tr><td colSpan={21} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                Loading…
              </td></tr>
            )}
          </tbody>
        </table>
        {/* Paginator — identical to the wholesale grid's, including
            the pageSize options [100, 250, 500, 1000, 2000]. Scales
            cleanly to 9 000+ rows. */}
        {displayRows.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderTop: `1px solid ${PAL.border}`, color: PAL.textDim, fontSize: 12 }}>
            <span>
              {(page * pageSize + 1).toLocaleString()}–{Math.min((page + 1) * pageSize, displayRows.length).toLocaleString()} of {displayRows.length.toLocaleString()}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>Rows per page:</span>
              <select style={S.select} value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                {[100, 250, 500, 1000, 2000].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <button style={S.btnSecondary} disabled={page === 0} onClick={() => setPage(0)}>« First</button>
              <button style={S.btnSecondary} disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>‹ Prev</button>
              <span>Page {page + 1} / {Math.max(1, Math.ceil(displayRows.length / pageSize))}</span>
              <button style={S.btnSecondary} disabled={(page + 1) * pageSize >= displayRows.length} onClick={() => setPage((p) => p + 1)}>Next ›</button>
              <button style={S.btnSecondary} disabled={(page + 1) * pageSize >= displayRows.length} onClick={() => setPage(Math.max(0, Math.ceil(displayRows.length / pageSize) - 1))}>Last »</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Th({ label, k, sortKey, sortDir, onSort, numeric, title, hidden }: {
  label: string; k: SortKey; sortKey: SortKey; sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void; numeric?: boolean; title?: string; hidden?: boolean;
}) {
  const active = sortKey === k;
  return (
    <th
      style={{
        ...S.th,
        cursor: "pointer",
        textAlign: numeric ? "right" : "left",
        color: active ? PAL.text : PAL.textMuted,
        userSelect: "none",
        ...(hidden ? { display: "none" as const } : null),
      }}
      onClick={() => onSort(k)}
      title={title}
    >
      {label}{active ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );
}

function cmp(a: IpReconciliationGridRow, b: IpReconciliationGridRow, k: SortKey, d: "asc" | "desc"): number {
  const sign = d === "asc" ? 1 : -1;
  const pRank = (p: string | null) => (p === "critical" ? 0 : p === "high" ? 1 : p === "medium" ? 2 : p === "low" ? 3 : 4);
  switch (k) {
    case "sku":        return a.sku_code.localeCompare(b.sku_code) * sign;
    case "style":      return (a.sku_style ?? "").localeCompare(b.sku_style ?? "") * sign;
    case "category":   return (a.group_name ?? a.category_name ?? "").localeCompare(b.group_name ?? b.category_name ?? "") * sign;
    case "subCat":     return (a.sub_category_name ?? "").localeCompare(b.sub_category_name ?? "") * sign;
    case "period":     return a.period_start.localeCompare(b.period_start) * sign;
    case "onHand":     return (a.beginning_on_hand_qty - b.beginning_on_hand_qty) * sign;
    case "ats":        return (a.ats_qty - b.ats_qty) * sign;
    case "inboundPo":  return (a.inbound_po_qty - b.inbound_po_qty) * sign;
    case "plannedBuy": return (a.inbound_planned_buy_qty - b.inbound_planned_buy_qty) * sign;
    case "receipts":   return (a.inbound_receipts_qty - b.inbound_receipts_qty) * sign;
    case "wip":        return (a.wip_qty - b.wip_qty) * sign;
    case "supply":     return (a.total_available_supply_qty - b.total_available_supply_qty) * sign;
    case "wsDemand":   return (a.wholesale_demand_qty - b.wholesale_demand_qty) * sign;
    case "ecomDemand": return (a.ecom_demand_qty - b.ecom_demand_qty) * sign;
    case "protected":  return (a.protected_ecom_qty - b.protected_ecom_qty) * sign;
    case "reserved":   return (a.reserved_wholesale_qty - b.reserved_wholesale_qty) * sign;
    case "allocated":  return (a.allocated_total_qty - b.allocated_total_qty) * sign;
    case "ending":     return (a.ending_inventory_qty - b.ending_inventory_qty) * sign;
    case "shortage":   return (a.shortage_qty - b.shortage_qty) * sign;
    case "excess":     return (a.excess_qty - b.excess_qty) * sign;
    case "priority":   return (pRank(a.top_recommendation_priority) - pRank(b.top_recommendation_priority)) * sign;
  }
}

// ── Aggregation: group rows by the chosen dim(s) and sum the qty
//    columns. Rendered with a tinted background + bold weight (same
//    visual treatment as wholesale grid aggregate rows).
function aggregateByDims(rows: IpReconciliationGridRow[], dims: CollapseMode[]): GridRow[] {
  // Build the group key from whichever dims are active. When all
  // three are selected the grouping degenerates to per-(sku, period,
  // category) which is identical to the un-collapsed view, so we
  // can safely fall through to the dedup-by-key path below.
  const keyOf = (r: IpReconciliationGridRow): string => {
    const parts: string[] = [];
    if (dims.includes("category")) parts.push(r.category_id ?? "—");
    if (dims.includes("sku"))      parts.push(r.sku_id);
    if (dims.includes("period"))   parts.push(r.period_start);
    return parts.join("|");
  };
  const groups = new Map<string, IpReconciliationGridRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    let bucket = groups.get(k);
    if (!bucket) { bucket = []; groups.set(k, bucket); }
    bucket.push(r);
  }
  const out: GridRow[] = [];
  for (const [k, bucket] of groups) {
    const first = bucket[0];
    const aggLabelParts: string[] = [];
    if (dims.includes("category")) aggLabelParts.push(first.category_name ?? "(no category)");
    if (dims.includes("sku"))      aggLabelParts.push(first.sku_code);
    if (dims.includes("period"))   aggLabelParts.push(first.period_code);
    const sums = bucket.reduce((a, r) => {
      a.beginning_on_hand_qty += r.beginning_on_hand_qty;
      a.ats_qty += r.ats_qty;
      a.inbound_po_qty += r.inbound_po_qty;
      a.inbound_planned_buy_qty += r.inbound_planned_buy_qty;
      a.inbound_receipts_qty += r.inbound_receipts_qty;
      a.wip_qty += r.wip_qty;
      a.total_available_supply_qty += r.total_available_supply_qty;
      a.wholesale_demand_qty += r.wholesale_demand_qty;
      a.ecom_demand_qty += r.ecom_demand_qty;
      a.protected_ecom_qty += r.protected_ecom_qty;
      a.reserved_wholesale_qty += r.reserved_wholesale_qty;
      a.allocated_total_qty += r.allocated_total_qty;
      a.ending_inventory_qty += r.ending_inventory_qty;
      a.shortage_qty += r.shortage_qty;
      a.excess_qty += r.excess_qty;
      if (r.projected_stockout_flag) a.projected_stockout_flag = true;
      return a;
    }, {
      beginning_on_hand_qty: 0, ats_qty: 0, inbound_po_qty: 0, inbound_planned_buy_qty: 0,
      inbound_receipts_qty: 0, wip_qty: 0, total_available_supply_qty: 0,
      wholesale_demand_qty: 0, ecom_demand_qty: 0, protected_ecom_qty: 0,
      reserved_wholesale_qty: 0, allocated_total_qty: 0, ending_inventory_qty: 0,
      shortage_qty: 0, excess_qty: 0, projected_stockout_flag: false,
    });
    // Pick the highest-priority recommendation in the bucket as the
    // representative top_rec for the aggregate row.
    const pRank = (p: string | null) => (p === "critical" ? 0 : p === "high" ? 1 : p === "medium" ? 2 : p === "low" ? 3 : 4);
    const top = [...bucket].sort((a, b) => pRank(a.top_recommendation_priority) - pRank(b.top_recommendation_priority))[0];
    out.push({
      ...first,
      ...sums,
      // Aggregate display: show dims joined; clear fields that don't
      // make sense at the rolled-up grain.
      sku_code: dims.includes("sku") ? first.sku_code : aggLabelParts.join(" · "),
      sku_description: null,
      period_code: dims.includes("period") ? first.period_code : "",
      category_name: dims.includes("category") ? first.category_name : null,
      top_recommendation: top.top_recommendation,
      top_recommendation_priority: top.top_recommendation_priority,
      top_recommendation_qty: null,
      top_recommendation_reason: null,
      service_risk_flag: bucket.some((r) => r.service_risk_flag),
      _agg: true,
      _aggKey: `agg:${k}`,
    });
  }
  // Sort alphabetically by the aggregate label so the rolled-up view
  // is stable. (The page paginator runs on top of this.)
  return out.sort((a, b) => (a.sku_code ?? "").localeCompare(b.sku_code ?? ""));
}
