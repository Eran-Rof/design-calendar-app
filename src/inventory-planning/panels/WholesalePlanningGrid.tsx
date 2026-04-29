// The main workbench table. Columns listed here are intentionally wide
// so planners can scan a row end-to-end without scrolling. Click a row to
// open the detail drawer.

import { useEffect, useMemo, useRef, useState } from "react";
import type { IpPlanningGridRow } from "../types/wholesale";
import { S, PAL, ACTION_COLOR, CONFIDENCE_COLOR, METHOD_COLOR, METHOD_LABEL, formatQty, formatPeriodCode } from "../components/styles";
import { aggregateRows, type CollapseModes as ExtractedCollapseModes } from "./aggregateGridRows";

export interface WholesalePlanningGridProps {
  rows: IpPlanningGridRow[];
  onSelectRow: (row: IpPlanningGridRow) => void;
  onUpdateBuyQty: (forecastId: string, qty: number | null) => Promise<void>;
  onUpdateUnitCost: (forecastId: string, cost: number | null) => Promise<void>;
  onUpdateBuyerRequest: (forecastId: string, qty: number) => Promise<void>;
  onUpdateOverride: (forecastId: string, qty: number) => Promise<void>;
  // Direct edit of System forecast qty. Pass null to revert to the
  // computed suggestion. Stamps user + timestamp server-side for the
  // cell tooltip.
  onUpdateSystemOverride: (forecastId: string, qty: number | null) => Promise<void>;
  loading?: boolean;
}

// Every column is sortable via header click. Click toggles asc/desc on
// the same key; clicking a different column resets to asc.
type SortKey =
  | "category" | "subCat" | "style" | "color" | "description" | "customer"
  | "period" | "histT3" | "histLY" | "system" | "buyer" | "override" | "final"
  | "confidence" | "method" | "onHand" | "onSo" | "onPo" | "receipts" | "ats"
  | "buy" | "avgCost" | "unitCost" | "buyDollars" | "shortage" | "excess" | "action";

// Re-export of the type now defined alongside the aggregate logic
// in ./aggregateGridRows.ts. Kept as a local alias so existing
// references (CollapseModes) compile without churn.
type CollapseModes = ExtractedCollapseModes;

export default function WholesalePlanningGrid({ rows, onSelectRow, onUpdateBuyQty, onUpdateUnitCost, onUpdateBuyerRequest, onUpdateOverride, onUpdateSystemOverride, loading }: WholesalePlanningGridProps) {
  const [search, setSearch] = useState("");
  const [filterCustomer, setFilterCustomer] = useState<string>("all");
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [filterSubCat, setFilterSubCat] = useState<string>("all");
  const [filterGender, setFilterGender] = useState<string>("all");
  const [filterAction, setFilterAction] = useState<string>("all");
  const [filterConfidence, setFilterConfidence] = useState<string>("all");
  // Master toggle — when OFF, System forecast suggestions are blanked
  // out across the whole grid so the planner can drive demand purely
  // through Buyer / Override edits without the auto-suggestion biasing
  // the displayed Final. Persisted in localStorage so refresh keeps it.
  const [systemSuggestionsOn, setSystemSuggestionsOn] = useState<boolean>(() => {
    try { return localStorage.getItem("ws_planning_system_suggestions_off") !== "1"; }
    catch { return true; }
  });
  function setSystemSuggestionsOnPersistent(v: boolean) {
    try {
      if (v) localStorage.removeItem("ws_planning_system_suggestions_off");
      else localStorage.setItem("ws_planning_system_suggestions_off", "1");
    } catch { /* ignore quota */ }
    setSystemSuggestionsOn(v);
  }
  const [filterMethod, setFilterMethod] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("period");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filterPeriod, setFilterPeriod] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(500);
  // Collapse / aggregation modes — independent toggles that change the
  // grouping key of the displayed rows. When any are on, grids show
  // aggregate rows and inline editing is disabled on those rows.
  const [collapse, setCollapse] = useState<CollapseModes>({
    customers: false, colors: false, category: false, subCat: false,
  });
  const anyCollapsed = collapse.customers || collapse.colors || collapse.category || collapse.subCat;
  // Reset to first page whenever filters/sort change so the user doesn't
  // wonder why an empty page is showing.
  useEffect(() => { setPage(0); }, [search, filterCustomer, filterCategory, filterSubCat, filterGender, filterPeriod, filterAction, filterConfidence, filterMethod, sortKey, sortDir, pageSize, collapse, systemSuggestionsOn]);

  const customers = useMemo(() => {
    const s = new Map<string, string>();
    for (const r of rows) s.set(r.customer_id, r.customer_name);
    return Array.from(s, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  // Categories are now sourced from the item master GroupName attribute
  // (text, no FK), so the filter operates on the string directly.
  const groupNames = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.group_name) s.add(r.group_name);
    return Array.from(s).sort();
  }, [rows]);

  const subCategoryNames = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.sub_category_name) s.add(r.sub_category_name);
    return Array.from(s).sort();
  }, [rows]);

  // Gender values pulled from item-master attributes (Xoro export's
  // GenderCode column). No grid column is rendered — gender is purely
  // a filter dimension. Empty/null gender SKUs land under "—".
  const genders = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) {
      const g = (r.gender ?? "").trim();
      if (g) s.add(g);
    }
    return Array.from(s).sort();
  }, [rows]);

  const periods = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) s.add(r.period_code);
    return Array.from(s).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    const base = rows.filter((r) => {
      if (filterCustomer !== "all" && r.customer_id !== filterCustomer) return false;
      if (filterCategory !== "all" && (r.group_name ?? "—") !== filterCategory) return false;
      if (filterSubCat !== "all" && (r.sub_category_name ?? "—") !== filterSubCat) return false;
      if (filterGender !== "all" && (r.gender ?? "—") !== filterGender) return false;
      if (filterPeriod !== "all" && r.period_code !== filterPeriod) return false;
      if (filterAction !== "all" && r.recommended_action !== filterAction) return false;
      if (filterConfidence !== "all" && r.confidence_level !== filterConfidence) return false;
      if (filterMethod !== "all" && r.forecast_method !== filterMethod) return false;
      if (q && !(
        r.sku_code.includes(q)
        || (r.sku_style ?? "").toUpperCase().includes(q)
        || (r.sku_color ?? "").toUpperCase().includes(q)
        || r.customer_name.toUpperCase().includes(q)
        || (r.group_name ?? "").toUpperCase().includes(q)
        || (r.sub_category_name ?? "").toUpperCase().includes(q)
      )) return false;
      return true;
    });
    // Apply the master "system suggestions" toggle — when off, every
    // displayed row's system value is muted to 0 and Final is recomputed
    // accordingly. Override values stay; planner can still type direct
    // overrides on top.
    const muted = systemSuggestionsOn ? base : base.map((r) => ({
      ...r,
      system_forecast_qty: 0,
      final_forecast_qty: Math.max(0, 0 + r.buyer_request_qty + r.override_qty),
    }));
    const collapsed = anyCollapsed ? aggregateRows(muted, collapse) : muted;
    return collapsed.sort((a, b) => cmp(a, b, sortKey, sortDir));
  }, [rows, search, filterCustomer, filterCategory, filterSubCat, filterGender, filterPeriod, filterAction, filterConfidence, filterMethod, sortKey, sortDir, collapse, anyCollapsed, systemSuggestionsOn]);

  const totals = useMemo(() => {
    const t = { final: 0, shortage: 0, excess: 0, actions: {} as Record<string, number>, methods: {} as Record<string, number> };
    for (const r of filtered) {
      t.final += r.final_forecast_qty;
      t.shortage += r.projected_shortage_qty;
      t.excess += r.projected_excess_qty;
      t.actions[r.recommended_action] = (t.actions[r.recommended_action] ?? 0) + 1;
      t.methods[r.forecast_method] = (t.methods[r.forecast_method] ?? 0) + 1;
    }
    return t;
  }, [filtered]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  return (
    <div>
      {/* Stats row */}
      <div style={{ ...S.statsRow, gridTemplateColumns: "repeat(6,1fr)" }}>
        <StatCell label="Rows" value={filtered.length > pageSize ? `${pageSize.toLocaleString()} / ${filtered.length.toLocaleString()}` : filtered.length.toLocaleString()} accent={filtered.length > pageSize ? PAL.yellow : undefined} />
        <StatCell label="Σ Final forecast" value={formatQty(totals.final)} accent={PAL.green} />
        <StatCell label="Σ Shortage" value={formatQty(totals.shortage)} accent={PAL.red} />
        <StatCell label="Σ Excess" value={formatQty(totals.excess)} accent={PAL.yellow} />
        <StatCell label="Buy / Expedite"
                  value={`${totals.actions.buy ?? 0} / ${totals.actions.expedite ?? 0}`}
                  accent={PAL.accent} />
        <StatCell label="Same Period LY rows"
                  value={(totals.methods.ly_sales ?? 0).toLocaleString()}
                  accent={PAL.accent2} />
      </div>

      <div style={S.toolbar}>
        <input style={{ ...S.input, width: 240 }} placeholder="Search customer / SKU / category"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        <select style={S.select} value={filterCustomer} onChange={(e) => setFilterCustomer(e.target.value)}>
          <option value="all">All customers</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select style={S.select} value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
          <option value="all">All categories</option>
          {groupNames.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select style={S.select} value={filterSubCat} onChange={(e) => setFilterSubCat(e.target.value)}>
          <option value="all">All sub cats</option>
          {subCategoryNames.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select style={S.select} value={filterGender} onChange={(e) => setFilterGender(e.target.value)} title="Gender filter — sourced from item-master GenderCode. No grid column rendered.">
          <option value="all">All genders</option>
          {genders.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select style={S.select} value={filterAction} onChange={(e) => setFilterAction(e.target.value)}>
          <option value="all">All actions</option>
          {["buy", "expedite", "reduce", "hold", "monitor"].map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select style={S.select} value={filterConfidence} onChange={(e) => setFilterConfidence(e.target.value)}>
          <option value="all">All confidence</option>
          {["committed", "probable", "possible", "estimate"].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select style={S.select} value={filterMethod} onChange={(e) => setFilterMethod(e.target.value)}>
          <option value="all">All methods</option>
          {Object.keys(METHOD_LABEL).map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
        </select>
        <select style={S.select} value={filterPeriod} onChange={(e) => setFilterPeriod(e.target.value)}>
          <option value="all">All periods</option>
          {periods.map((p) => <option key={p} value={p}>{formatPeriodCode(p)}</option>)}
        </select>
        <button style={S.btnSecondary} onClick={() => {
          setSearch(""); setFilterCustomer("all"); setFilterCategory("all"); setFilterSubCat("all"); setFilterGender("all"); setFilterPeriod("all");
          setFilterAction("all"); setFilterConfidence("all"); setFilterMethod("all");
        }}>Clear</button>
        <CollapseToggle
          label={systemSuggestionsOn ? "System suggestions: ON" : "System suggestions: OFF"}
          active={!systemSuggestionsOn}
          onToggle={() => setSystemSuggestionsOnPersistent(!systemSuggestionsOn)}
        />
      </div>

      <div style={{ ...S.toolbar, marginTop: -4, paddingTop: 0, gap: 14, fontSize: 12, color: PAL.textDim }}>
        <span style={{ fontWeight: 600 }}>Collapse:</span>
        <CollapseToggle label="All customers" active={collapse.customers} onToggle={() => setCollapse((c) => ({ ...c, customers: !c.customers }))} />
        <CollapseToggle label="All colors per style" active={collapse.colors} onToggle={() => setCollapse((c) => ({ ...c, colors: !c.colors }))} />
        <CollapseToggle label="By category" active={collapse.category} onToggle={() => setCollapse((c) => ({ ...c, category: !c.category, subCat: c.category ? c.subCat : false }))} />
        <CollapseToggle label="By sub cat" active={collapse.subCat} onToggle={() => setCollapse((c) => ({ ...c, subCat: !c.subCat, category: c.subCat ? c.category : false }))} />
        {anyCollapsed && (
          <button style={{ ...S.btnSecondary, fontSize: 11, padding: "2px 8px" }}
                  onClick={() => setCollapse({ customers: false, colors: false, category: false, subCat: false })}>
            Reset
          </button>
        )}
        {anyCollapsed && (
          <span style={{ color: PAL.textMuted, fontStyle: "italic" }}>
            Aggregate rows are read-only — drill in by clearing the toggles.
          </span>
        )}
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <Th label="Category"    k="category"    sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Th label="Sub Cat"     k="subCat"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Th label="Style"       k="style"       sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Th label="Color"       k="color"       sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Th label="Description" k="description" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Th label="Customer"    k="customer"    sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Th label="Period"      k="period"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Th label="Hist T3"     k="histT3"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <Th label="Hist LY"     k="histLY"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <Th label="System"      k="system"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <Th label="Buyer"       k="buyer"       sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <Th label="Override"    k="override"    sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <Th label="Final"       k="final"       sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <Th label="Conf."       k="confidence"  sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Th label="Method"      k="method"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Th label="On hand"     k="onHand"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <Th label="On SO"       k="onSo"        sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <Th label="On PO"       k="onPo"        sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <Th label="Receipts"    k="receipts"    sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <Th label="ATS"         k="ats"         sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <Th label="Buy"         k="buy"         sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric tint={PAL.green} />
              <Th label="Avg Cost"    k="avgCost"     sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric tint={PAL.textMuted} title="From ip_item_avg_cost (Xoro / Excel ingest)" />
              <Th label="Unit Cost"   k="unitCost"    sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric tint={PAL.accent2} title="Auto-filled from Avg Cost — editable" />
              <Th label="Buy $"       k="buyDollars"  sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric tint={PAL.green} />
              <Th label="Short"       k="shortage"    sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <Th label="Excess"      k="excess"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <Th label="Action"      k="action"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {filtered.slice(page * pageSize, (page + 1) * pageSize).map((r) => (
              <tr
                key={r.forecast_id}
                onContextMenu={(e) => { e.preventDefault(); if (!r.is_aggregate) onSelectRow(r); }}
                title={r.is_aggregate ? `Aggregate of ${r.aggregate_count ?? 1} rows — toggle off Collapse to drill in` : "Right-click for more info"}
                style={r.is_aggregate ? { background: PAL.panelMuted ?? "rgba(255,255,255,0.03)" } : undefined}
              >
                <td style={{ ...S.td, color: PAL.textDim }}>{r.group_name ?? "–"}</td>
                <td style={{ ...S.td, color: PAL.textDim }}>{r.sub_category_name ?? "–"}</td>
                <td style={{ ...S.td, fontFamily: "monospace", color: PAL.accent }}>{r.sku_style ?? r.sku_code}</td>
                <td style={{ ...S.td, color: PAL.textDim }}>{r.sku_color ?? "—"}</td>
                <td style={{ ...S.td, color: PAL.textDim, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.sku_description ?? ""}>
                  {r.sku_description ?? "—"}
                </td>
                <td style={S.td}>{r.customer_name}</td>
                <td style={S.td}>{formatPeriodCode(r.period_code)}</td>
                <td style={S.tdNum}>{formatQty(r.historical_trailing_qty)}</td>
                <td style={{ ...S.tdNum, color: r.forecast_method === "ly_sales" && r.ly_reference_qty != null ? PAL.accent2 : PAL.textMuted }}>
                  {r.ly_reference_qty != null ? formatQty(r.ly_reference_qty) : "—"}
                </td>
                <td style={{ ...S.tdNum, padding: "0 4px" }} onClick={(e) => e.stopPropagation()}>
                  {r.is_aggregate ? (
                    <span style={{ fontFamily: "monospace", color: PAL.text }}>
                      {formatQty(r.system_forecast_qty)}
                    </span>
                  ) : (
                    <SystemCell
                      value={r.system_forecast_qty}
                      original={r.system_forecast_qty_original}
                      overriddenAt={r.system_forecast_qty_overridden_at}
                      overriddenBy={r.system_forecast_qty_overridden_by}
                      onSave={(qty) => onUpdateSystemOverride(r.forecast_id, qty)}
                    />
                  )}
                </td>
                <td style={{ ...S.tdNum, padding: "0 4px" }}>
                  {r.is_aggregate ? (
                    <span style={{ fontFamily: "monospace", color: r.buyer_request_qty !== 0 ? PAL.accent : PAL.textMuted }}>
                      {formatQty(r.buyer_request_qty)}
                    </span>
                  ) : (
                    <IntCell
                      value={r.buyer_request_qty}
                      accent={PAL.accent}
                      allowNegative={false}
                      onSave={(qty) => onUpdateBuyerRequest(r.forecast_id, qty)}
                    />
                  )}
                </td>
                <td style={{ ...S.tdNum, padding: "0 4px" }}>
                  {r.is_aggregate ? (
                    <span style={{ fontFamily: "monospace", color: r.override_qty !== 0 ? PAL.yellow : PAL.textMuted }}>
                      {formatQty(r.override_qty)}
                    </span>
                  ) : (
                    <IntCell
                      value={r.override_qty}
                      accent={PAL.yellow}
                      allowNegative={true}
                      onSave={(qty) => onUpdateOverride(r.forecast_id, qty)}
                    />
                  )}
                </td>
                <td style={{ ...S.tdNum, color: PAL.green, fontWeight: 700 }}>
                  {formatQty(r.final_forecast_qty)}
                </td>
                <td style={S.td}>
                  <span style={{ ...S.chip, background: CONFIDENCE_COLOR[r.confidence_level] + "33", color: CONFIDENCE_COLOR[r.confidence_level] }}>
                    {r.confidence_level}
                  </span>
                </td>
                <td style={S.td}>
                  <span style={{ ...S.chip, background: (METHOD_COLOR[r.forecast_method] ?? PAL.textMuted) + "22", color: METHOD_COLOR[r.forecast_method] ?? PAL.textMuted }}>
                    {METHOD_LABEL[r.forecast_method] ?? r.forecast_method}
                  </span>
                </td>
                <td style={S.tdNum}>{formatQty(r.on_hand_qty)}</td>
                <td style={{ ...S.tdNum, color: r.on_so_qty > 0 ? PAL.yellow : PAL.textMuted }}>
                  {r.on_so_qty > 0 ? formatQty(r.on_so_qty) : "—"}
                </td>
                <td style={S.tdNum}>{formatQty(r.on_po_qty)}</td>
                <td style={S.tdNum}>{formatQty(r.receipts_due_qty)}</td>
                <td style={{ ...S.tdNum, color: PAL.text }}>{formatQty(r.available_supply_qty)}</td>
                <td style={{ ...S.tdNum, padding: "0 4px" }} onClick={(e) => e.stopPropagation()}>
                  {r.is_aggregate ? (
                    <span style={{ fontFamily: "monospace", color: (r.planned_buy_qty ?? 0) > 0 ? PAL.green : PAL.textMuted }}>
                      {r.planned_buy_qty != null ? formatQty(r.planned_buy_qty) : "—"}
                    </span>
                  ) : (
                    <BuyCell
                      value={r.planned_buy_qty}
                      onSave={(qty) => onUpdateBuyQty(r.forecast_id, qty)}
                    />
                  )}
                </td>
                <td style={{ ...S.tdNum, color: r.avg_cost ? PAL.text : PAL.textMuted, fontFamily: "monospace" }}>
                  {r.avg_cost ? `$${r.avg_cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "–"}
                </td>
                <td style={{ ...S.tdNum, padding: "0 4px" }} onClick={(e) => e.stopPropagation()}>
                  {r.is_aggregate ? (
                    <span style={{ fontFamily: "monospace", color: r.unit_cost != null ? PAL.accent2 : PAL.textMuted }}>
                      {r.unit_cost != null ? `$${r.unit_cost.toFixed(2)}` : "—"}
                    </span>
                  ) : (
                    <UnitCostCell
                      value={r.unit_cost}
                      overridden={r.unit_cost_override != null}
                      onSave={(cost) => onUpdateUnitCost(r.forecast_id, cost)}
                    />
                  )}
                </td>
                {(() => {
                  const qty = r.planned_buy_qty;
                  const cost = r.unit_cost;
                  const hasCost = qty != null && qty > 0 && cost != null && cost > 0;
                  return (
                    <td style={{ ...S.tdNum, color: hasCost ? PAL.green : PAL.textMuted, fontFamily: "monospace" }}>
                      {hasCost ? `$${(qty * cost).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "–"}
                    </td>
                  );
                })()}
                <td style={{ ...S.tdNum, color: r.projected_shortage_qty > 0 ? PAL.red : PAL.textMuted }}>
                  {formatQty(r.projected_shortage_qty)}
                </td>
                <td style={{ ...S.tdNum, color: r.projected_excess_qty > 0 ? PAL.yellow : PAL.textMuted }}>
                  {formatQty(r.projected_excess_qty)}
                </td>
                <td style={S.td}>
                  <span style={{ ...S.chip, background: (ACTION_COLOR[r.recommended_action] ?? PAL.textMuted) + "33", color: ACTION_COLOR[r.recommended_action] ?? PAL.textMuted }}>
                    {r.recommended_action}
                  </span>
                </td>
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={27} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                {rows.length === 0
                  ? "No forecast rows yet. Click \"Build forecast\" above to populate the grid."
                  : "No rows match your filters."}
              </td></tr>
            )}
            {loading && (
              <tr><td colSpan={27} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                Loading…
              </td></tr>
            )}
          </tbody>
        </table>
        {filtered.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderTop: `1px solid ${PAL.border}`, color: PAL.textDim, fontSize: 12 }}>
            <span>
              {(page * pageSize + 1).toLocaleString()}–{Math.min((page + 1) * pageSize, filtered.length).toLocaleString()} of {filtered.length.toLocaleString()}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>Rows per page:</span>
              <select style={S.select} value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                {[100, 250, 500, 1000, 2000].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <button style={S.btnSecondary} disabled={page === 0} onClick={() => setPage(0)}>« First</button>
              <button style={S.btnSecondary} disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>‹ Prev</button>
              <span>Page {page + 1} / {Math.max(1, Math.ceil(filtered.length / pageSize))}</span>
              <button style={S.btnSecondary} disabled={(page + 1) * pageSize >= filtered.length} onClick={() => setPage((p) => p + 1)}>Next ›</button>
              <button style={S.btnSecondary} disabled={(page + 1) * pageSize >= filtered.length} onClick={() => setPage(Math.max(0, Math.ceil(filtered.length / pageSize) - 1))}>Last »</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Th({ label, k, sortKey, sortDir, onSort, numeric, tint, title }: {
  label: string; k: SortKey; sortKey: SortKey; sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void; numeric?: boolean; tint?: string; title?: string;
}) {
  const active = sortKey === k;
  const baseColor = tint ?? (active ? PAL.text : PAL.textMuted);
  return (
    <th
      style={{ ...S.th, cursor: "pointer", textAlign: numeric ? "right" : "left", color: active ? PAL.text : baseColor, userSelect: "none" }}
      onClick={() => onSort(k)}
      title={title}
    >
      {label}{active ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );
}

function BuyCell({ value, onSave }: { value: number | null; onSave: (qty: number | null) => Promise<void> }) {
  const [str, setStr] = useState(value != null ? String(value) : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(false);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setStr(value != null ? String(value) : "");
  }, [value]);

  async function commit(raw: string) {
    const trimmed = raw.trim();
    const qty = trimmed === "" ? null : Number(trimmed);
    if (qty !== null && (!Number.isFinite(qty) || !Number.isInteger(qty))) { setErr(true); focused.current = false; return; }
    if (qty === value || (qty == null && value == null)) { focused.current = false; return; }
    setErr(false);
    setSaving(true);
    try { await onSave(qty); } catch { setErr(true); } finally { setSaving(false); focused.current = false; }
  }

  return (
    <input
      data-buycell="1"
      type="text"
      inputMode="numeric"
      value={str}
      onChange={(e) => { setStr(e.target.value); setErr(false); }}
      onBlur={(e) => void commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      placeholder="—"
      style={{
        width: 64,
        background: "transparent",
        color: err ? PAL.red : str ? PAL.green : PAL.textDim,
        border: `1px solid ${err ? PAL.red : "transparent"}`,
        borderRadius: 4,
        padding: "2px 4px",
        fontFamily: "monospace",
        fontSize: 13,
        textAlign: "right",
        outline: "none",
        opacity: saving ? 0.5 : 1,
      }}
      onFocus={(e) => { focused.current = true; e.target.select(); e.target.style.borderColor = err ? PAL.red : PAL.green; e.target.style.background = PAL.panel; }}
      onBlurCapture={(e) => { e.target.style.borderColor = err ? PAL.red : "transparent"; e.target.style.background = "transparent"; }}
    />
  );
}

// Reusable integer cell for inline qty edits (Buyer / Override). Blank
// or non-numeric input commits 0. Negative values allowed when the column
// permits it (Override can subtract).
function IntCell({ value, accent, allowNegative, onSave }: {
  value: number;
  accent: string;
  allowNegative: boolean;
  onSave: (qty: number) => Promise<void>;
}) {
  const [str, setStr] = useState(value === 0 ? "" : (allowNegative && value > 0 ? "+" : "") + String(value));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(false);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setStr(value === 0 ? "" : (allowNegative && value > 0 ? "+" : "") + String(value));
  }, [value, allowNegative]);

  async function commit(raw: string) {
    const trimmed = raw.trim().replace(/^\+/, "");
    const qty = trimmed === "" ? 0 : Number(trimmed);
    if (!Number.isFinite(qty) || !Number.isInteger(qty) || (!allowNegative && qty < 0)) {
      setErr(true); focused.current = false; return;
    }
    if (qty === value) { focused.current = false; return; }
    setErr(false);
    setSaving(true);
    try { await onSave(qty); } catch { setErr(true); } finally { setSaving(false); focused.current = false; }
  }

  const color = err ? PAL.red : value !== 0 ? accent : PAL.textMuted;
  return (
    <input
      type="text"
      inputMode={allowNegative ? "text" : "numeric"}
      value={str}
      onChange={(e) => { setStr(e.target.value); setErr(false); }}
      onBlur={(e) => void commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      placeholder="—"
      style={{
        width: 64,
        background: "transparent",
        color,
        border: `1px solid ${err ? PAL.red : "transparent"}`,
        borderRadius: 4,
        padding: "2px 4px",
        fontFamily: "monospace",
        fontSize: 13,
        textAlign: "right",
        outline: "none",
        opacity: saving ? 0.5 : 1,
      }}
      onFocus={(e) => { focused.current = true; e.target.select(); e.target.style.borderColor = err ? PAL.red : accent; e.target.style.background = PAL.panel; }}
      onBlurCapture={(e) => { e.target.style.borderColor = err ? PAL.red : "transparent"; e.target.style.background = "transparent"; }}
    />
  );
}

// Editable per-row unit cost. Blank input → clears the override and reverts
// to the auto-derived ATS avg cost (or item_cost) on the next refresh.
// `overridden` controls the visual hint so planners can see at a glance
// which rows have a manual cost vs. the auto-fill.
function UnitCostCell({ value, overridden, onSave }: {
  value: number | null;
  overridden: boolean;
  onSave: (cost: number | null) => Promise<void>;
}) {
  const [str, setStr] = useState(value != null ? value.toFixed(2) : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(false);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setStr(value != null ? value.toFixed(2) : "");
  }, [value]);

  async function commit(raw: string) {
    const trimmed = raw.trim();
    const cost = trimmed === "" ? null : Number(trimmed);
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) { setErr(true); focused.current = false; return; }
    if (cost === value) { focused.current = false; return; }
    setErr(false);
    setSaving(true);
    try { await onSave(cost); } catch { setErr(true); } finally { setSaving(false); focused.current = false; }
  }

  const baseColor = err ? PAL.red : overridden ? PAL.accent2 : PAL.textDim;
  return (
    <input
      data-unitcost="1"
      type="text"
      inputMode="decimal"
      value={str}
      onChange={(e) => { setStr(e.target.value); setErr(false); }}
      onBlur={(e) => void commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      placeholder="—"
      title={overridden ? "Planner override — clear to revert to ATS avg" : "Auto-filled from ATS avg cost — type to override"}
      style={{
        width: 72,
        background: "transparent",
        color: baseColor,
        border: `1px solid ${err ? PAL.red : "transparent"}`,
        borderRadius: 4,
        padding: "2px 4px",
        fontFamily: "monospace",
        fontSize: 13,
        textAlign: "right",
        outline: "none",
        opacity: saving ? 0.5 : 1,
        fontStyle: overridden ? "normal" : "italic",
      }}
      onFocus={(e) => { focused.current = true; e.target.select(); e.target.style.borderColor = err ? PAL.red : PAL.accent2; e.target.style.background = PAL.panel; }}
      onBlurCapture={(e) => { e.target.style.borderColor = err ? PAL.red : "transparent"; e.target.style.background = "transparent"; }}
    />
  );
}

function StatCell({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={S.statCard}>
      <div style={{ fontSize: 11, color: PAL.textMuted }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: accent ?? PAL.text, fontFamily: "monospace" }}>{value}</div>
    </div>
  );
}

// Editable System forecast cell. Shows the override value when one is
// set (highlighted yellow + italic), otherwise the computed system
// suggestion in muted color. Tooltip carries the audit trail
// "Changed from X to Y by USER on DATE" so planners know who/when.
// Empty input clears the override (reverts to suggestion).
function SystemCell({ value, original, overriddenAt, overriddenBy, onSave }: {
  value: number;
  original: number;
  overriddenAt: string | null;
  overriddenBy: string | null;
  onSave: (qty: number | null) => Promise<void>;
}) {
  const overridden = overriddenAt != null && value !== original;
  const [str, setStr] = useState(value === 0 ? "" : String(value));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(false);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setStr(value === 0 ? "" : String(value));
  }, [value]);

  async function commit(raw: string) {
    const trimmed = raw.trim();
    // Empty / 0 = clear the override (revert to suggestion). Anything
    // else becomes the override; we pass even "= original" as a no-op
    // so the audit timestamp doesn't bump when the planner re-types
    // the same value.
    let nextOverride: number | null;
    if (trimmed === "" || trimmed === "0") {
      nextOverride = null;
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) { setErr(true); focused.current = false; return; }
      if (n === original && !overridden) { focused.current = false; return; }
      nextOverride = n;
    }
    setErr(false);
    setSaving(true);
    try { await onSave(nextOverride); } catch { setErr(true); } finally { setSaving(false); focused.current = false; }
  }

  const titleParts: string[] = [];
  if (overridden) {
    titleParts.push(`Changed from ${original.toLocaleString()} to ${value.toLocaleString()}`);
    if (overriddenBy) titleParts.push(`by ${overriddenBy}`);
    if (overriddenAt) {
      const when = new Date(overriddenAt);
      if (!isNaN(when.getTime())) titleParts.push(`on ${when.toLocaleString()}`);
    }
    titleParts.push("(empty input reverts to suggestion)");
  } else {
    titleParts.push(`System suggestion: ${original.toLocaleString()}. Type a value to override.`);
  }
  const title = titleParts.join(" · ");
  const baseColor = err ? PAL.red : overridden ? PAL.yellow : PAL.textMuted;

  return (
    <input
      type="text"
      inputMode="numeric"
      value={str}
      onChange={(e) => { setStr(e.target.value); setErr(false); }}
      onBlur={(e) => void commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      placeholder="—"
      title={title}
      style={{
        width: 64,
        background: overridden ? `${PAL.yellow}11` : "transparent",
        color: baseColor,
        border: `1px solid ${err ? PAL.red : overridden ? `${PAL.yellow}66` : "transparent"}`,
        borderRadius: 4,
        padding: "2px 4px",
        fontFamily: "monospace",
        fontSize: 13,
        textAlign: "right",
        outline: "none",
        opacity: saving ? 0.5 : 1,
        fontStyle: overridden ? "italic" : "normal",
        fontWeight: overridden ? 700 : 400,
      }}
      onFocus={(e) => { focused.current = true; e.target.select(); e.target.style.borderColor = err ? PAL.red : PAL.yellow; e.target.style.background = PAL.panel; }}
      onBlurCapture={(e) => { e.target.style.borderColor = err ? PAL.red : overridden ? `${PAL.yellow}66` : "transparent"; e.target.style.background = overridden ? `${PAL.yellow}11` : "transparent"; }}
    />
  );
}

function CollapseToggle({ label, active, onToggle }: { label: string; active: boolean; onToggle: () => void }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", padding: "2px 6px", borderRadius: 4, background: active ? `${PAL.accent}22` : "transparent", border: `1px solid ${active ? PAL.accent : PAL.border}`, color: active ? PAL.accent : PAL.textDim }}>
      <input type="checkbox" checked={active} onChange={onToggle} style={{ accentColor: PAL.accent }} />
      {label}
    </label>
  );
}

// Generic null-safe comparators. Numbers sort numerically; strings sort
// case-insensitively; nulls always at the end regardless of direction.
function cmpStr(a: string | null | undefined, b: string | null | undefined, sign: number): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a.localeCompare(b, undefined, { sensitivity: "base" }) * sign;
}
function cmpNum(a: number | null | undefined, b: number | null | undefined, sign: number): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return (a - b) * sign;
}

function cmp(a: IpPlanningGridRow, b: IpPlanningGridRow, k: SortKey, d: "asc" | "desc"): number {
  const sign = d === "asc" ? 1 : -1;
  switch (k) {
    case "category":    return cmpStr(a.group_name, b.group_name, sign);
    case "subCat":      return cmpStr(a.sub_category_name, b.sub_category_name, sign);
    case "style":       return cmpStr((a.sku_style ?? a.sku_code) + ":" + (a.sku_color ?? ""), (b.sku_style ?? b.sku_code) + ":" + (b.sku_color ?? ""), sign);
    case "color":       return cmpStr(a.sku_color, b.sku_color, sign);
    case "description": return cmpStr(a.sku_description, b.sku_description, sign);
    case "customer":    return cmpStr(a.customer_name, b.customer_name, sign);
    case "period":      return cmpStr(a.period_start, b.period_start, sign);
    case "histT3":      return cmpNum(a.historical_trailing_qty, b.historical_trailing_qty, sign);
    case "histLY":      return cmpNum(a.ly_reference_qty, b.ly_reference_qty, sign);
    case "system":      return cmpNum(a.system_forecast_qty, b.system_forecast_qty, sign);
    case "buyer":       return cmpNum(a.buyer_request_qty, b.buyer_request_qty, sign);
    case "override":    return cmpNum(a.override_qty, b.override_qty, sign);
    case "final":       return cmpNum(a.final_forecast_qty, b.final_forecast_qty, sign);
    case "confidence":  return cmpStr(a.confidence_level, b.confidence_level, sign);
    case "method":      return cmpStr(a.forecast_method, b.forecast_method, sign);
    case "onHand":      return cmpNum(a.on_hand_qty, b.on_hand_qty, sign);
    case "onSo":        return cmpNum(a.on_so_qty, b.on_so_qty, sign);
    case "onPo":        return cmpNum(a.on_po_qty, b.on_po_qty, sign);
    case "receipts":    return cmpNum(a.receipts_due_qty, b.receipts_due_qty, sign);
    case "ats":         return cmpNum(a.available_supply_qty, b.available_supply_qty, sign);
    case "buy":         return cmpNum(a.planned_buy_qty, b.planned_buy_qty, sign);
    case "avgCost":     return cmpNum(a.avg_cost, b.avg_cost, sign);
    case "unitCost":    return cmpNum(a.unit_cost, b.unit_cost, sign);
    case "buyDollars":  return cmpNum((a.planned_buy_qty ?? 0) * (a.unit_cost ?? 0), (b.planned_buy_qty ?? 0) * (b.unit_cost ?? 0), sign);
    case "shortage":    return cmpNum(a.projected_shortage_qty, b.projected_shortage_qty, sign);
    case "excess":      return cmpNum(a.projected_excess_qty, b.projected_excess_qty, sign);
    case "action":      return cmpStr(a.recommended_action, b.recommended_action, sign);
  }
}

// aggregateRows + mergeBucket moved to ./aggregateGridRows for unit
// testability. Imported at the top of this file.
