// Ecom planning grid. Columns per spec:
// SKU, category, channel, 4W, 13W, trend %, system, override, final,
// promo / launch / markdown flags, plus protected qty + return rate.

import { useEffect, useMemo, useRef, useState } from "react";
import type { IpEcomGridRow } from "../types/ecom";
import { S, PAL, formatQty, formatPeriodCode } from "../../components/styles";
import { StatCell } from "../../components/StatCell";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "../../../tanda/components/TablePrefs";
import SearchableSelect from "../../../tanda/components/SearchableSelect";

const TABLE_KEY = "ip.ecom_planning_grid";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "channel", label: "Channel" },
  { key: "category", label: "Category" },
  { key: "sku", label: "SKU" },
  { key: "week", label: "Week" },
  { key: "trailing4", label: "4W" },
  { key: "trailing13", label: "13W" },
  { key: "trend", label: "Trend" },
  { key: "system", label: "System" },
  { key: "override", label: "Override" },
  { key: "final", label: "Final" },
  { key: "protected", label: "Protected" },
  { key: "return", label: "Return" },
  { key: "on_hand", label: "On Hand" },
  { key: "ats", label: "ATS" },
  { key: "short", label: "Short" },
  { key: "excess", label: "Excess" },
  { key: "buy", label: "Buy" },
  { key: "buy_dollars", label: "Buy $" },
  { key: "flags", label: "Flags" },
];

export interface EcomPlanningGridProps {
  rows: IpEcomGridRow[];
  onSelectRow: (row: IpEcomGridRow) => void;
  onUpdateBuyQty: (forecastId: string, qty: number | null) => Promise<void>;
  loading?: boolean;
}

type SortKey = "channel" | "sku" | "period" | "final" | "trend" | "trailing4";

const PAGE_SIZE = 500; // safety for very wide horizons; planner sees a summary + can filter

export default function EcomPlanningGrid({ rows, onSelectRow, onUpdateBuyQty, loading }: EcomPlanningGridProps) {
  const [search, setSearch] = useState("");
  const [filterChannel, setFilterChannel] = useState("all");
  const [filterCategory, setFilterCategory] = useState("all");
  const [filterActive, setFilterActive] = useState<"all" | "active" | "inactive">("active");
  const [filterLaunch, setFilterLaunch] = useState<"all" | "launch" | "not">("all");
  const [filterPromo, setFilterPromo] = useState<"all" | "promo" | "not">("all");
  const [sortKey, setSortKey] = useState<SortKey>("channel");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  // Per-filter predicate set. A row "passes" a filter if it matches the
  // current value of THAT filter. Used both for the final filtered list and —
  // crucially — for cascading the Channel / Category dropdown option pools:
  // each dropdown's options are derived from the rows that pass every OTHER
  // active filter, so picking a Channel narrows the Category list (and the
  // search box) to only the categories that still have rows, and vice-versa.
  const passes = useMemo(() => {
    const q = search.trim().toUpperCase();
    return {
      channel: (r: IpEcomGridRow) => filterChannel === "all" || r.channel_id === filterChannel,
      category: (r: IpEcomGridRow) => filterCategory === "all" || r.category_id === filterCategory,
      active: (r: IpEcomGridRow) =>
        filterActive === "all" || (filterActive === "active" ? r.is_active : !r.is_active),
      launch: (r: IpEcomGridRow) =>
        filterLaunch === "all" || (filterLaunch === "launch" ? r.launch_flag : !r.launch_flag),
      promo: (r: IpEcomGridRow) =>
        filterPromo === "all" || (filterPromo === "promo" ? r.promo_flag : !r.promo_flag),
      search: (r: IpEcomGridRow) => !q || r.sku_code.includes(q) || r.channel_name.toUpperCase().includes(q),
    };
  }, [search, filterChannel, filterCategory, filterActive, filterLaunch, filterPromo]);

  // Channel options: rows passing every filter except Channel itself.
  const channels = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) {
      if (!passes.category(r) || !passes.active(r) || !passes.launch(r) || !passes.promo(r) || !passes.search(r)) continue;
      m.set(r.channel_id, r.channel_name);
    }
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, passes]);

  // Category options: rows passing every filter except Category itself.
  const categories = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) {
      if (!passes.channel(r) || !passes.active(r) || !passes.launch(r) || !passes.promo(r) || !passes.search(r)) continue;
      if (r.category_id) m.set(r.category_id, r.category_name ?? r.category_id);
    }
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, passes]);

  // Drop a now-invalid Channel / Category selection when narrowing the other
  // filter removes it from the option pool, so the grid never shows an empty
  // list under a stale pick the operator can no longer see.
  useEffect(() => {
    if (filterChannel !== "all" && !channels.some((c) => c.id === filterChannel)) setFilterChannel("all");
  }, [channels, filterChannel]);
  useEffect(() => {
    if (filterCategory !== "all" && !categories.some((c) => c.id === filterCategory)) setFilterCategory("all");
  }, [categories, filterCategory]);

  const filtered = useMemo(() => {
    const out = rows.filter((r) =>
      passes.channel(r) && passes.category(r) && passes.active(r) &&
      passes.launch(r) && passes.promo(r) && passes.search(r));
    return out.sort((a, b) => cmp(a, b, sortKey, sortDir)).slice(0, PAGE_SIZE);
  }, [rows, passes, sortKey, sortDir]);

  const totals = useMemo(() => {
    const t = { final: 0, protected: 0, promo: 0, launch: 0, markdown: 0 };
    for (const r of filtered) {
      t.final += r.final_forecast_qty;
      t.protected += r.protected_ecom_qty;
      if (r.promo_flag) t.promo++;
      if (r.launch_flag) t.launch++;
      if (r.markdown_flag) t.markdown++;
    }
    return t;
  }, [filtered]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir("asc"); }
  }

  return (
    <div>
      <div style={S.statsRow}>
        <StatCell label="Rows" value={filtered.length > 500 ? `500 / ${filtered.length.toLocaleString()}` : filtered.length.toLocaleString()} accent={filtered.length > 500 ? PAL.yellow : undefined} />
        <StatCell label="Σ Final" value={formatQty(totals.final)} accent={PAL.green} />
        <StatCell label="Σ Protected" value={formatQty(totals.protected)} accent={PAL.accent} />
        <StatCell label="Promo weeks" value={String(totals.promo)} accent={PAL.accent} />
        <StatCell label="Launch weeks" value={String(totals.launch)} accent={PAL.green} />
      </div>

      <div style={S.toolbar}>
        <input style={{ ...S.input, width: 220 }} placeholder="Search channel or SKU"
               value={search} onChange={(e) => setSearch(e.target.value)}
               onFocus={(e) => e.currentTarget.select()} />
        <SearchableSelect value={filterChannel} onChange={(v) => setFilterChannel(v)} inputStyle={S.select}
          options={[{ value: "all", label: "All channels" }, ...channels.map((c) => ({ value: c.id, label: c.name }))]} />
        <SearchableSelect value={filterCategory} onChange={(v) => setFilterCategory(v)} inputStyle={S.select}
          options={[{ value: "all", label: "All categories" }, ...categories.map((c) => ({ value: c.id, label: c.name }))]} />
        <SearchableSelect value={filterActive} onChange={(v) => setFilterActive(v as "all" | "active" | "inactive")} inputStyle={S.select} options={[
          { value: "active", label: "Active only" },
          { value: "all", label: "Active + inactive" },
          { value: "inactive", label: "Inactive only" },
        ]} />
        <SearchableSelect value={filterLaunch} onChange={(v) => setFilterLaunch(v as "all" | "launch" | "not")} inputStyle={S.select} options={[
          { value: "all", label: "Launch: any" },
          { value: "launch", label: "Launching" },
          { value: "not", label: "Not launching" },
        ]} />
        <SearchableSelect value={filterPromo} onChange={(v) => setFilterPromo(v as "all" | "promo" | "not")} inputStyle={S.select} options={[
          { value: "all", label: "Promo: any" },
          { value: "promo", label: "Promo weeks" },
          { value: "not", label: "No promo" },
        ]} />
        <button style={S.btnSecondary} onClick={() => {
          setSearch(""); setFilterChannel("all"); setFilterCategory("all");
          setFilterActive("active"); setFilterLaunch("all"); setFilterPromo("all");
        }}>Clear</button>
        <div style={{ marginLeft: "auto" }}>
          <TablePrefsButton tableKey={TABLE_KEY} columns={ALL_COLUMNS} visibleColumns={visibleColumns}
                            onToggle={toggleColumn} onReset={resetToDefault} onSetAll={setAllVisible} />
        </div>
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <Th label="Channel" k="channel" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={!visibleColumns.has("channel")} />
              <th hidden={!visibleColumns.has("category")} style={S.th}>Category</th>
              <Th label="SKU" k="sku" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={!visibleColumns.has("sku")} />
              <Th label="Week" k="period" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={!visibleColumns.has("week")} />
              <Th label="4W" k="trailing4" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={!visibleColumns.has("trailing4")} />
              <th hidden={!visibleColumns.has("trailing13")} style={{ ...S.th, textAlign: "right" }}>13W</th>
              <Th label="Trend" k="trend" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={!visibleColumns.has("trend")} />
              <th hidden={!visibleColumns.has("system")} style={{ ...S.th, textAlign: "right" }}>System</th>
              <th hidden={!visibleColumns.has("override")} style={{ ...S.th, textAlign: "right" }}>Override</th>
              <Th label="Final" k="final" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={!visibleColumns.has("final")} />
              <th hidden={!visibleColumns.has("protected")} style={{ ...S.th, textAlign: "right" }}>Protected</th>
              <th hidden={!visibleColumns.has("return")} style={{ ...S.th, textAlign: "right" }}>Return</th>
              <th hidden={!visibleColumns.has("on_hand")} style={{ ...S.th, textAlign: "right" }}>On Hand</th>
              <th hidden={!visibleColumns.has("ats")} style={{ ...S.th, textAlign: "right", color: PAL.accent }}>ATS</th>
              <th hidden={!visibleColumns.has("short")} style={{ ...S.th, textAlign: "right", color: PAL.red }}>Short</th>
              <th hidden={!visibleColumns.has("excess")} style={{ ...S.th, textAlign: "right", color: PAL.yellow }}>Excess</th>
              <th hidden={!visibleColumns.has("buy")} style={{ ...S.th, textAlign: "right", color: PAL.green }}>Buy</th>
              <th hidden={!visibleColumns.has("buy_dollars")} style={{ ...S.th, textAlign: "right", color: PAL.green }}>Buy $</th>
              <th hidden={!visibleColumns.has("flags")} style={S.th}>Flags</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 500).map((r) => (
              <tr key={r.forecast_id} style={{ cursor: "pointer" }} onClick={() => onSelectRow(r)}>
                <td hidden={!visibleColumns.has("channel")} style={S.td}>{r.channel_name}</td>
                <td hidden={!visibleColumns.has("category")} style={{ ...S.td, color: PAL.textDim }}>{r.category_name ?? "–"}</td>
                <td hidden={!visibleColumns.has("sku")} style={{ ...S.td, fontFamily: "monospace", color: PAL.accent }}>{r.sku_code}</td>
                <td hidden={!visibleColumns.has("week")} style={S.td}>{formatPeriodCode(r.period_code)}</td>
                <td hidden={!visibleColumns.has("trailing4")} style={S.tdNum}>{formatQty(r.trailing_4w_qty)}</td>
                <td hidden={!visibleColumns.has("trailing13")} style={S.tdNum}>{formatQty(r.trailing_13w_qty)}</td>
                <td hidden={!visibleColumns.has("trend")} style={{ ...S.tdNum, color: trendColor(r.trend_pct) }}>
                  {r.trend_pct == null ? "–" : `${r.trend_pct >= 0 ? "+" : ""}${(r.trend_pct * 100).toFixed(0)}%`}
                </td>
                <td hidden={!visibleColumns.has("system")} style={S.tdNum}>{formatQty(r.system_forecast_qty)}</td>
                <td hidden={!visibleColumns.has("override")} style={{ ...S.tdNum, color: r.override_qty !== 0 ? PAL.yellow : PAL.textMuted }}>
                  {r.override_qty > 0 ? "+" : ""}{formatQty(r.override_qty)}
                </td>
                <td hidden={!visibleColumns.has("final")} style={{ ...S.tdNum, color: PAL.green, fontWeight: 700 }}>{formatQty(r.final_forecast_qty)}</td>
                <td hidden={!visibleColumns.has("protected")} style={{ ...S.tdNum, color: PAL.accent }}>{formatQty(r.protected_ecom_qty)}</td>
                <td hidden={!visibleColumns.has("return")} style={{ ...S.tdNum, color: r.return_rate && r.return_rate > 0.2 ? PAL.red : PAL.textDim }}>
                  {r.return_rate == null ? "–" : `${(r.return_rate * 100).toFixed(0)}%`}
                </td>
                <td hidden={!visibleColumns.has("on_hand")} style={S.tdNum}>{formatQty(r.on_hand_qty)}</td>
                <td hidden={!visibleColumns.has("ats")} style={{ ...S.tdNum, color: PAL.accent }}>{formatQty(r.available_supply_qty)}</td>
                <td hidden={!visibleColumns.has("short")} style={{ ...S.tdNum, color: r.projected_shortage_qty > 0 ? PAL.red : PAL.textMuted, fontWeight: r.projected_shortage_qty > 0 ? 700 : 400 }}>
                  {r.projected_shortage_qty > 0 ? formatQty(r.projected_shortage_qty) : "–"}
                </td>
                <td hidden={!visibleColumns.has("excess")} style={{ ...S.tdNum, color: r.projected_excess_qty > 0 ? PAL.yellow : PAL.textMuted }}>
                  {r.projected_excess_qty > 0 ? formatQty(r.projected_excess_qty) : "–"}
                </td>
                <td hidden={!visibleColumns.has("buy")} onClick={(e) => e.stopPropagation()} style={{ ...S.td, padding: "2px 4px" }}>
                  <BuyCell value={r.planned_buy_qty} onSave={(qty) => onUpdateBuyQty(r.forecast_id, qty)} />
                </td>
                <td hidden={!visibleColumns.has("buy_dollars")} style={{ ...S.tdNum, color: r.planned_buy_qty && r.item_cost ? PAL.green : PAL.textMuted, fontFamily: "monospace" }}>
                  {r.planned_buy_qty && r.item_cost ? `$${(r.planned_buy_qty * r.item_cost).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "–"}
                </td>
                <td hidden={!visibleColumns.has("flags")} style={S.td}>
                  <FlagChip on={r.promo_flag} color={PAL.accent} label="P" />
                  <FlagChip on={r.launch_flag} color={PAL.green} label="L" />
                  <FlagChip on={r.markdown_flag} color={PAL.yellow} label="M" />
                  {!r.is_active && <FlagChip on color={PAL.textMuted} label="off" />}
                </td>
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={19} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                {rows.length === 0
                  ? "No forecast rows yet. Click \"Build forecast\" above to populate the grid."
                  : "No rows match your filters."}
              </td></tr>
            )}
            {loading && (
              <tr><td colSpan={19} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                Loading…
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.length > PAGE_SIZE && (
        <div style={{ padding: 8, color: PAL.textMuted, fontSize: 12, textAlign: "right" }}>
          Showing first {PAGE_SIZE.toLocaleString()} rows — use filters to narrow.
        </div>
      )}
    </div>
  );
}

function FlagChip({ on, color, label }: { on: boolean; color: string; label: string }) {
  if (!on) return null;
  return (
    <span style={{
      display: "inline-block",
      padding: "1px 6px",
      borderRadius: 6,
      fontSize: 10,
      fontWeight: 700,
      background: color + "22",
      color,
      marginRight: 4,
    }}>{label}</span>
  );
}

function Th({ label, k, sortKey, sortDir, onSort, numeric, hidden }: {
  label: string; k: SortKey; sortKey: SortKey; sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void; numeric?: boolean; hidden?: boolean;
}) {
  const active = sortKey === k;
  return (
    <th hidden={hidden}
        style={{ ...S.th, cursor: "pointer", textAlign: numeric ? "right" : "left", color: active ? PAL.text : PAL.textMuted }}
        onClick={() => onSort(k)}>
      {label}{active ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );
}


function trendColor(pct: number | null): string {
  if (pct == null) return PAL.textMuted;
  if (pct > 0.1) return PAL.green;
  if (pct < -0.1) return PAL.red;
  return PAL.textDim;
}

function BuyCell({ value, onSave }: { value: number | null; onSave: (qty: number | null) => Promise<void> }) {
  const [str, setStr] = useState(value != null ? String(value) : "");
  const [saving, setSaving] = useState(false);
  const [errored, setErrored] = useState(false);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setStr(value != null ? String(value) : "");
  }, [value]);

  async function commit() {
    const trimmed = str.trim();
    const qty = trimmed === "" ? null : Number(trimmed);
    if (qty !== null && (!Number.isFinite(qty) || !Number.isInteger(qty))) { setErrored(true); focused.current = false; return; }
    if (qty === value || (qty == null && value == null)) { focused.current = false; return; }
    setSaving(true); setErrored(false);
    try {
      await onSave(qty);
    } catch {
      setErrored(true);
    } finally {
      setSaving(false);
      focused.current = false;
    }
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      value={str}
      placeholder="–"
      onChange={(e) => { setStr(e.target.value); setErrored(false); }}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      disabled={saving}
      style={{
        width: 72,
        textAlign: "right",
        fontFamily: "monospace",
        fontSize: 12,
        padding: "3px 6px",
        borderRadius: 4,
        border: `1px solid ${errored ? PAL.red : "transparent"}`,
        background: "transparent",
        color: str.trim() ? PAL.green : PAL.textMuted,
        outline: "none",
      }}
      onFocus={(e) => {
        focused.current = true;
        (e.target as HTMLInputElement).style.border = `1px solid ${PAL.green}`;
        (e.target as HTMLInputElement).style.background = PAL.panel;
      }}
      onBlurCapture={(e) => {
        (e.target as HTMLInputElement).style.border = errored ? `1px solid ${PAL.red}` : "1px solid transparent";
        (e.target as HTMLInputElement).style.background = "transparent";
      }}
    />
  );
}

function cmp(a: IpEcomGridRow, b: IpEcomGridRow, k: SortKey, d: "asc" | "desc"): number {
  const sign = d === "asc" ? 1 : -1;
  switch (k) {
    case "channel":   return a.channel_name.localeCompare(b.channel_name) * sign;
    case "sku":       return a.sku_code.localeCompare(b.sku_code) * sign;
    case "period":    return a.week_start.localeCompare(b.week_start) * sign;
    case "final":     return (a.final_forecast_qty - b.final_forecast_qty) * sign;
    case "trend":     return ((a.trend_pct ?? 0) - (b.trend_pct ?? 0)) * sign;
    case "trailing4": return (a.trailing_4w_qty - b.trailing_4w_qty) * sign;
  }
}
