// The main workbench table. Columns listed here are intentionally wide
// so planners can scan a row end-to-end without scrolling. Click a row to
// open the detail drawer.

import { useEffect, useMemo, useRef, useState } from "react";
import type { IpPlanningGridRow } from "../types/wholesale";
import { S, PAL, ACTION_COLOR, CONFIDENCE_COLOR, METHOD_COLOR, METHOD_LABEL, formatQty, formatPeriodCode } from "../components/styles";

export interface WholesalePlanningGridProps {
  rows: IpPlanningGridRow[];
  onSelectRow: (row: IpPlanningGridRow) => void;
  onUpdateBuyQty: (forecastId: string, qty: number | null) => Promise<void>;
  onUpdateUnitCost: (forecastId: string, cost: number | null) => Promise<void>;
  onUpdateBuyerRequest: (forecastId: string, qty: number) => Promise<void>;
  onUpdateOverride: (forecastId: string, qty: number) => Promise<void>;
  loading?: boolean;
}

type SortKey =
  | "customer" | "style" | "period" | "final" | "shortage" | "excess" | "action" | "method";

export default function WholesalePlanningGrid({ rows, onSelectRow, onUpdateBuyQty, onUpdateUnitCost, onUpdateBuyerRequest, onUpdateOverride, loading }: WholesalePlanningGridProps) {
  const [search, setSearch] = useState("");
  const [filterCustomer, setFilterCustomer] = useState<string>("all");
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [filterAction, setFilterAction] = useState<string>("all");
  const [filterConfidence, setFilterConfidence] = useState<string>("all");
  const [filterMethod, setFilterMethod] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("period");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filterPeriod, setFilterPeriod] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(500);
  // Reset to first page whenever filters/sort change so the user doesn't
  // wonder why an empty page is showing.
  useEffect(() => { setPage(0); }, [search, filterCustomer, filterCategory, filterPeriod, filterAction, filterConfidence, filterMethod, sortKey, sortDir, pageSize]);

  const customers = useMemo(() => {
    const s = new Map<string, string>();
    for (const r of rows) s.set(r.customer_id, r.customer_name);
    return Array.from(s, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const categories = useMemo(() => {
    const s = new Map<string, string>();
    for (const r of rows) if (r.category_id) s.set(r.category_id, r.category_name ?? r.category_id);
    return Array.from(s, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const periods = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) s.add(r.period_code);
    return Array.from(s).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    const out = rows.filter((r) => {
      if (filterCustomer !== "all" && r.customer_id !== filterCustomer) return false;
      if (filterCategory !== "all" && r.category_id !== filterCategory) return false;
      if (filterPeriod !== "all" && r.period_code !== filterPeriod) return false;
      if (filterAction !== "all" && r.recommended_action !== filterAction) return false;
      if (filterConfidence !== "all" && r.confidence_level !== filterConfidence) return false;
      if (filterMethod !== "all" && r.forecast_method !== filterMethod) return false;
      if (q && !(
        r.sku_code.includes(q)
        || (r.sku_style ?? "").toUpperCase().includes(q)
        || (r.sku_color ?? "").toUpperCase().includes(q)
        || r.customer_name.toUpperCase().includes(q)
      )) return false;
      return true;
    });
    return out.sort((a, b) => cmp(a, b, sortKey, sortDir));
  }, [rows, search, filterCustomer, filterCategory, filterPeriod, filterAction, filterConfidence, filterMethod, sortKey, sortDir]);

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
        <input style={{ ...S.input, width: 240 }} placeholder="Search customer or SKU"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        <select style={S.select} value={filterCustomer} onChange={(e) => setFilterCustomer(e.target.value)}>
          <option value="all">All customers</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select style={S.select} value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
          <option value="all">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
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
          setSearch(""); setFilterCustomer("all"); setFilterCategory("all"); setFilterPeriod("all");
          setFilterAction("all"); setFilterConfidence("all"); setFilterMethod("all");
        }}>Clear</button>
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <Th label="Customer" k="customer" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th style={S.th}>Category</th>
              <Th label="Style" k="style" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th style={S.th}>Color</th>
              <th style={S.th}>Description</th>
              <Th label="Period" k="period" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th style={{ ...S.th, textAlign: "right" }}>Hist T3</th>
              <th style={{ ...S.th, textAlign: "right" }}>Hist LY</th>
              <th style={{ ...S.th, textAlign: "right" }}>System</th>
              <th style={{ ...S.th, textAlign: "right" }}>Buyer</th>
              <th style={{ ...S.th, textAlign: "right" }}>Override</th>
              <Th label="Final" k="final" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <th style={S.th}>Conf.</th>
              <Th label="Method" k="method" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th style={{ ...S.th, textAlign: "right" }}>On hand</th>
              <th style={{ ...S.th, textAlign: "right" }}>On SO</th>
              <th style={{ ...S.th, textAlign: "right" }}>On PO</th>
              <th style={{ ...S.th, textAlign: "right" }}>Receipts</th>
              <th style={{ ...S.th, textAlign: "right" }}>ATS</th>
              <th style={{ ...S.th, textAlign: "right", color: PAL.green }}>Buy</th>
              <th style={{ ...S.th, textAlign: "right", color: PAL.textMuted }} title="From ip_item_avg_cost (Xoro / Excel ingest)">Avg Cost</th>
              <th style={{ ...S.th, textAlign: "right", color: PAL.accent2 }} title="Auto-filled from Avg Cost — editable">Unit Cost</th>
              <th style={{ ...S.th, textAlign: "right", color: PAL.green }}>Buy $</th>
              <Th label="Short" k="shortage" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <Th label="Excess" k="excess" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric />
              <Th label="Action" k="action" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {filtered.slice(page * pageSize, (page + 1) * pageSize).map((r) => (
              <tr
                key={r.forecast_id}
                onContextMenu={(e) => { e.preventDefault(); onSelectRow(r); }}
                title="Right-click for more info"
              >
                <td style={S.td}>{r.customer_name}</td>
                <td style={{ ...S.td, color: PAL.textDim }}>{r.category_name ?? "–"}</td>
                <td style={{ ...S.td, fontFamily: "monospace", color: PAL.accent }}>{r.sku_style ?? r.sku_code}</td>
                <td style={{ ...S.td, color: PAL.textDim }}>{r.sku_color ?? "—"}</td>
                <td style={{ ...S.td, color: PAL.textDim, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.sku_description ?? ""}>
                  {r.sku_description ?? "—"}
                </td>
                <td style={S.td}>{formatPeriodCode(r.period_code)}</td>
                <td style={S.tdNum}>{formatQty(r.historical_trailing_qty)}</td>
                <td style={{ ...S.tdNum, color: r.forecast_method === "ly_sales" && r.ly_reference_qty != null ? PAL.accent2 : PAL.textMuted }}>
                  {r.ly_reference_qty != null ? formatQty(r.ly_reference_qty) : "—"}
                </td>
                <td style={S.tdNum}>{formatQty(r.system_forecast_qty)}</td>
                <td style={{ ...S.tdNum, padding: "0 4px" }}>
                  <IntCell
                    value={r.buyer_request_qty}
                    accent={PAL.accent}
                    allowNegative={false}
                    onSave={(qty) => onUpdateBuyerRequest(r.forecast_id, qty)}
                  />
                </td>
                <td style={{ ...S.tdNum, padding: "0 4px" }}>
                  <IntCell
                    value={r.override_qty}
                    accent={PAL.yellow}
                    allowNegative={true}
                    onSave={(qty) => onUpdateOverride(r.forecast_id, qty)}
                  />
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
                  <BuyCell
                    value={r.planned_buy_qty}
                    onSave={(qty) => onUpdateBuyQty(r.forecast_id, qty)}
                  />
                </td>
                <td style={{ ...S.tdNum, color: r.avg_cost ? PAL.text : PAL.textMuted, fontFamily: "monospace" }}>
                  {r.avg_cost ? `$${r.avg_cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "–"}
                </td>
                <td style={{ ...S.tdNum, padding: "0 4px" }} onClick={(e) => e.stopPropagation()}>
                  <UnitCostCell
                    value={r.unit_cost}
                    overridden={r.unit_cost_override != null}
                    onSave={(cost) => onUpdateUnitCost(r.forecast_id, cost)}
                  />
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
              <tr><td colSpan={26} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                {rows.length === 0
                  ? "No forecast rows yet. Click \"Build forecast\" above to populate the grid."
                  : "No rows match your filters."}
              </td></tr>
            )}
            {loading && (
              <tr><td colSpan={26} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
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
      onFocus={(e) => { focused.current = true; e.target.style.borderColor = err ? PAL.red : PAL.green; e.target.style.background = PAL.panel; }}
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
      onFocus={(e) => { focused.current = true; e.target.style.borderColor = err ? PAL.red : accent; e.target.style.background = PAL.panel; }}
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
      onFocus={(e) => { focused.current = true; e.target.style.borderColor = err ? PAL.red : PAL.accent2; e.target.style.background = PAL.panel; }}
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

function cmp(a: IpPlanningGridRow, b: IpPlanningGridRow, k: SortKey, d: "asc" | "desc"): number {
  const sign = d === "asc" ? 1 : -1;
  switch (k) {
    case "customer": return a.customer_name.localeCompare(b.customer_name) * sign;
    case "style":    return ((a.sku_style ?? a.sku_code) + ":" + (a.sku_color ?? "")).localeCompare((b.sku_style ?? b.sku_code) + ":" + (b.sku_color ?? "")) * sign;
    case "period":   return a.period_start.localeCompare(b.period_start) * sign;
    case "final":    return (a.final_forecast_qty - b.final_forecast_qty) * sign;
    case "shortage": return (a.projected_shortage_qty - b.projected_shortage_qty) * sign;
    case "excess":   return (a.projected_excess_qty - b.projected_excess_qty) * sign;
    case "action":   return a.recommended_action.localeCompare(b.recommended_action) * sign;
    case "method":   return a.forecast_method.localeCompare(b.forecast_method) * sign;
  }
}
