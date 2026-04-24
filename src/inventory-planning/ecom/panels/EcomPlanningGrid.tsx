// Ecom planning grid. Columns per spec:
// SKU, category, channel, 4W, 13W, trend %, system, override, final,
// promo / launch / markdown flags, plus protected qty + return rate.

import { useMemo, useRef, useState } from "react";
import type { IpEcomGridRow } from "../types/ecom";
import { S, PAL, formatQty, formatPeriodCode } from "../../components/styles";

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

  const channels = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.channel_id, r.channel_name);
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const categories = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.category_id) m.set(r.category_id, r.category_name ?? r.category_id);
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    const out = rows.filter((r) => {
      if (filterChannel !== "all" && r.channel_id !== filterChannel) return false;
      if (filterCategory !== "all" && r.category_id !== filterCategory) return false;
      if (filterActive === "active" && !r.is_active) return false;
      if (filterActive === "inactive" && r.is_active) return false;
      if (filterLaunch === "launch" && !r.launch_flag) return false;
      if (filterLaunch === "not" && r.launch_flag) return false;
      if (filterPromo === "promo" && !r.promo_flag) return false;
      if (filterPromo === "not" && r.promo_flag) return false;
      if (q && !(r.sku_code.includes(q) || r.channel_name.toUpperCase().includes(q))) return false;
      return true;
    });
    return out.sort((a, b) => cmp(a, b, sortKey, sortDir)).slice(0, PAGE_SIZE);
  }, [rows, search, filterChannel, filterCategory, filterActive, filterLaunch, filterPromo, sortKey, sortDir]);

  const totals = useMemo(() => {
    const t = { final: 0, protected: 0, shortage: 0, promo: 0, launch: 0, markdown: 0 };
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
               value={search} onChange={(e) => setSearch(e.target.value)} />
        <select style={S.select} value={filterChannel} onChange={(e) => setFilterChannel(e.target.value)}>
          <option value="all">All channels</option>
          {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select style={S.select} value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
          <option value="all">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select style={S.select} value={filterActive} onChange={(e) => setFilterActive(e.target.value as "all" | "active" | "inactive")}>
          <option value="active">Active only</option>
          <option value="all">Active + inactive</option>
          <option value="inactive">Inactive only</option>
        </select>
        <select style={S.select} value={filterLaunch} onChange={(e) => setFilterLaunch(e.target.value as "all" | "launch" | "not")}>
          <option value="all">Launch: any</option>
          <option value="launch">Launching</option>
          <option value="not">Not launching</option>
        </select>
        <select style={S.select} value={filterPromo} onChange={(e) => setFilterPromo(e.target.value as "all" | "promo" | "not")}>
          <option value="all">Promo: any</option>
          <option value="promo">Promo weeks</option>
          <option value="not">No promo</option>
        </select>
        <button style={S.btnSecondary} onClick={() => {
          setSearch(""); setFilterChannel("all"); setFilterCategory("all");
          setFilterActive("active"); setFilterLaunch("all"); setFilterPromo("all");
        }}>Clear</button>
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <Th label="Channel" k="channel" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th style={S.th}>Category</th>
              <Th label="SKU" k="sku" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Th label="Week" k="period" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Th label="4W" k="trailing4" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <th style={{ ...S.th, textAlign: "right" }}>13W</th>
              <Th label="Trend" k="trend" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <th style={{ ...S.th, textAlign: "right" }}>System</th>
              <th style={{ ...S.th, textAlign: "right" }}>Override</th>
              <Th label="Final" k="final" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <th style={{ ...S.th, textAlign: "right" }}>Protected</th>
              <th style={{ ...S.th, textAlign: "right" }}>Return</th>
              <th style={{ ...S.th, textAlign: "right", color: PAL.green }}>Buy</th>
              <th style={S.th}>Flags</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 500).map((r) => (
              <tr key={r.forecast_id} style={{ cursor: "pointer" }} onClick={() => onSelectRow(r)}>
                <td style={S.td}>{r.channel_name}</td>
                <td style={{ ...S.td, color: PAL.textDim }}>{r.category_name ?? "–"}</td>
                <td style={{ ...S.td, fontFamily: "monospace", color: PAL.accent }}>{r.sku_code}</td>
                <td style={S.td}>{formatPeriodCode(r.period_code)}</td>
                <td style={S.tdNum}>{formatQty(r.trailing_4w_qty)}</td>
                <td style={S.tdNum}>{formatQty(r.trailing_13w_qty)}</td>
                <td style={{ ...S.tdNum, color: trendColor(r.trend_pct) }}>
                  {r.trend_pct == null ? "–" : `${r.trend_pct >= 0 ? "+" : ""}${(r.trend_pct * 100).toFixed(0)}%`}
                </td>
                <td style={S.tdNum}>{formatQty(r.system_forecast_qty)}</td>
                <td style={{ ...S.tdNum, color: r.override_qty !== 0 ? PAL.yellow : PAL.textMuted }}>
                  {r.override_qty > 0 ? "+" : ""}{formatQty(r.override_qty)}
                </td>
                <td style={{ ...S.tdNum, color: PAL.green, fontWeight: 700 }}>{formatQty(r.final_forecast_qty)}</td>
                <td style={{ ...S.tdNum, color: PAL.accent }}>{formatQty(r.protected_ecom_qty)}</td>
                <td style={{ ...S.tdNum, color: r.return_rate && r.return_rate > 0.2 ? PAL.red : PAL.textDim }}>
                  {r.return_rate == null ? "–" : `${(r.return_rate * 100).toFixed(0)}%`}
                </td>
                <td onClick={(e) => e.stopPropagation()} style={{ ...S.td, padding: "2px 4px" }}>
                  <BuyCell value={r.planned_buy_qty} onSave={(qty) => onUpdateBuyQty(r.forecast_id, qty)} />
                </td>
                <td style={S.td}>
                  <FlagChip on={r.promo_flag} color={PAL.accent} label="P" />
                  <FlagChip on={r.launch_flag} color={PAL.green} label="L" />
                  <FlagChip on={r.markdown_flag} color={PAL.yellow} label="M" />
                  {!r.is_active && <FlagChip on color={PAL.textMuted} label="off" />}
                </td>
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={14} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                {rows.length === 0
                  ? "No forecast rows yet. Click \"Build forecast\" above to populate the grid."
                  : "No rows match your filters."}
              </td></tr>
            )}
            {loading && (
              <tr><td colSpan={14} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
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

function Th({ label, k, sortKey, sortDir, onSort, numeric }: {
  label: string; k: SortKey; sortKey: SortKey; sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void; numeric?: boolean;
}) {
  const active = sortKey === k;
  return (
    <th style={{ ...S.th, cursor: "pointer", textAlign: numeric ? "right" : "left", color: active ? PAL.text : PAL.textMuted }}
        onClick={() => onSort(k)}>
      {label}{active ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
    </th>
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
  const prev = useRef(str);

  async function commit() {
    const trimmed = str.trim();
    const qty = trimmed === "" ? null : parseInt(trimmed, 10);
    if (qty !== null && !Number.isFinite(qty)) { setErrored(true); return; }
    if (trimmed === prev.current) return;
    setSaving(true); setErrored(false);
    try {
      await onSave(qty);
      prev.current = trimmed;
    } catch {
      setErrored(true);
    } finally {
      setSaving(false);
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
