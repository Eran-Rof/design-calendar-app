// Sales Comps modal — picks a date range + filter scope, fetches sales
// for that window AND the same window shifted 12 months back (LY),
// then shows a TY vs LY comparison.
//
// Selection step: AppDatePicker for start/end (custom popover, no native
// browser widget so styling is consistent across apps), plus dropdowns
// pre-populated from the grid's current filter state. Operator can
// override any filter before running.
//
// Results step: top summary card (TY total / LY total / Δ) + per-SKU
// table sorted by TY revenue. Back button returns to the selection
// view without losing inputs.

import React, { useMemo, useState } from "react";
import { AppDatePicker } from "../../shared/components/AppDatePicker";
import { fetchSalesAggregates, type SalesFetchResult } from "../exportSalesFetch";
import type { ATSRow, ExcelData } from "../types";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function yearStartIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-01-01`;
}
function fmtUSD(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "—";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
function fmtPct(num: number, denom: number): string {
  if (!Number.isFinite(num) || !Number.isFinite(denom) || denom <= 0) return "—";
  return `${((num / denom) * 100).toFixed(1)}%`;
}
function fmtDiff(ty: number, ly: number): { text: string; positive: boolean } {
  if (!Number.isFinite(ty) || !Number.isFinite(ly) || ly === 0) return { text: ty > 0 ? "NEW" : "—", positive: ty > 0 };
  const diff = (ty - ly) / ly;
  return { text: `${diff >= 0 ? "+" : ""}${(diff * 100).toFixed(1)}%`, positive: diff >= 0 };
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
  accentSoft: "#6EE7B7",
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

interface SelectFieldProps<T extends string> {
  label: string;
  value: T[];
  options: T[];
  onChange: (next: T[]) => void;
  // single = render as plain select; multi = checkbox dropdown
  multi?: boolean;
  // human-readable description shown under the label
  hint?: string;
}
function SelectField<T extends string>({ label, value, options, onChange, multi, hint }: SelectFieldProps<T>): React.ReactElement {
  if (!multi) {
    const single = value[0] ?? "";
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label style={{ fontSize: 12, color: C.textMuted, fontWeight: 600 }}>{label}</label>
        {hint && <span style={{ fontSize: 10, color: C.textDim, lineHeight: 1.2 }}>{hint}</span>}
        <select
          value={single}
          onChange={e => onChange(e.target.value ? [e.target.value as T] : [])}
          style={inputStyle}
        >
          <option value="">All</option>
          {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    );
  }
  // Multi: render a summary + dropdown of checkboxes. Tight footprint;
  // no popover gymnastics — we want this to feel like an inline form.
  const [open, setOpen] = useState(false);
  const summary = value.length === 0 ? "All" : value.length <= 2 ? value.join(", ") : `${value.length} selected`;
  const toggle = (o: T) => {
    onChange(value.includes(o) ? value.filter(v => v !== o) : [...value, o]);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, position: "relative" }}>
      <label style={{ fontSize: 12, color: C.textMuted, fontWeight: 600 }}>{label}</label>
      {hint && <span style={{ fontSize: 10, color: C.textDim, lineHeight: 1.2 }}>{hint}</span>}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{ ...inputStyle, textAlign: "left", cursor: "pointer" }}
      >
        {summary}
        <span style={{ float: "right", color: C.textDim, fontSize: 10 }}>▼</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 1100,
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            maxHeight: 220,
            overflowY: "auto",
            padding: 4,
            boxShadow: "0 6px 18px rgba(0,0,0,0.5)",
          }}
        >
          {options.length === 0 && <div style={{ fontSize: 11, color: C.textDim, padding: 6 }}>No options</div>}
          {options.map(o => (
            <label key={o} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", cursor: "pointer", fontSize: 12, color: C.text, borderRadius: 4 }} onMouseEnter={e => (e.currentTarget.style.background = "rgba(16,185,129,0.10)")} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
              <input type="checkbox" checked={value.includes(o)} onChange={() => toggle(o)} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  // Pre-populated filter scope — auto-defaults to whatever the grid
  // toolbar has selected when the modal opens. Operator can override
  // any field before running.
  defaultCustomer: string;
  defaultCategories: string[];
  defaultSubCategories: string[];
  defaultStyles: string[];
  defaultStoreFilter: string[];
  // The grid's row set + excelData needed by fetchSalesAggregates to
  // resolve sku_id ↔ ATS sku and surface cross-grid synthetic rows.
  // Dropdown option lists are derived from these rows so the modal
  // doesn't need a separate prop per filter dimension.
  rows: ATSRow[];
  excelData: ExcelData | null;
}

export const SalesCompsModal: React.FC<Props> = ({
  open, onClose,
  defaultCustomer, defaultCategories, defaultSubCategories, defaultStyles, defaultStoreFilter,
  rows, excelData,
}) => {
  // Filter option lists derived from rows. Prefer the cleaner
  // master_* fields populated by ip_item_master enrichment; fall back
  // to the row's own field when master didn't match.
  const categories = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) { const v = r.master_category ?? r.category; if (v) s.add(v); }
    return [...s].sort();
  }, [rows]);
  const subCategories = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) { if (r.master_sub_category) s.add(r.master_sub_category); }
    return [...s].sort();
  }, [rows]);
  const styles = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) { if (r.master_style) s.add(r.master_style); }
    return [...s].sort();
  }, [rows]);
  const stores = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) { if (r.store) s.add(r.store); }
    if (s.size === 0) ["ROF", "ROF ECOM", "PT", "PT ECOM"].forEach(c => s.add(c));
    return [...s].sort();
  }, [rows]);
  const [start, setStart] = useState(yearStartIso());
  const [end,   setEnd]   = useState(todayIso());
  const [customer, setCustomer]                 = useState<string[]>(defaultCustomer ? [defaultCustomer] : []);
  const [selCategories, setSelCategories]       = useState<string[]>(defaultCategories);
  const [selSubCategories, setSelSubCategories] = useState<string[]>(defaultSubCategories);
  const [selStyles, setSelStyles]               = useState<string[]>(defaultStyles);
  const [selStores, setSelStores]               = useState<string[]>(defaultStoreFilter);

  const [running, setRunning] = useState(false);
  const [result, setResult]   = useState<SalesFetchResult | null>(null);
  const [rangeWarn, setRangeWarn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Customer list comes from excelData.sos — same source ExportOptions
  // uses. Sorted + deduped.
  const customers = useMemo(() => {
    const set = new Set<string>();
    if (excelData) for (const s of excelData.sos) if (s.customerName) set.add(s.customerName);
    return [...set].sort();
  }, [excelData]);

  if (!open) return null;

  const run = async () => {
    setRangeWarn(false);
    setError(null);
    if (!start || !end || start > end) { setRangeWarn(true); return; }
    setRunning(true);
    try {
      const r = await fetchSalesAggregates({
        rows,
        needT3: true,
        needLY: true,
        customer:  customer[0] || "",
        customStart: start,
        customEnd:   end,
        storeFilter:      selStores.length > 0 ? selStores : undefined,
        filterCategory:   selCategories.length > 0 ? selCategories : undefined,
        filterSubCategory: selSubCategories.length > 0 ? selSubCategories : undefined,
        filterStyle:      selStyles.length > 0 ? selStyles : undefined,
      });
      setResult(r);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setRunning(false);
    }
  };

  const reset = () => {
    setResult(null);
    setError(null);
  };

  // Summary rollup across all SKUs in the fetch result (t3 = TY since
  // the picker shifts the window, ly = LY by design).
  const summary = useMemo(() => {
    if (!result) return null;
    let tyQty = 0, tyRev = 0, tyMrgn = 0;
    let lyQty = 0, lyRev = 0, lyMrgn = 0;
    for (const a of result.t3.values()) { tyQty += a.qty; tyRev += a.totalPrice; tyMrgn += a.marginAmount; }
    for (const a of result.ly.values()) { lyQty += a.qty; lyRev += a.totalPrice; lyMrgn += a.marginAmount; }
    for (const e of result.extraBySkuId.values()) {
      tyQty += e.t3Qty; tyRev += e.t3Total; tyMrgn += e.t3Margin;
      lyQty += e.lyQty; lyRev += e.lyTotal; lyMrgn += e.lyMargin;
    }
    return { tyQty, tyRev, tyMrgn, lyQty, lyRev, lyMrgn };
  }, [result]);

  // Per-SKU table: merge t3 and ly maps + extras into a single keyed list
  // sorted by max(ty rev, ly rev) so the biggest movers float to the top.
  const tableRows = useMemo(() => {
    if (!result) return [];
    type Row = { sku: string; tyQty: number; tyRev: number; tyMrgn: number; lyQty: number; lyRev: number; lyMrgn: number };
    const map = new Map<string, Row>();
    const ensure = (sku: string): Row => {
      const cur = map.get(sku);
      if (cur) return cur;
      const fresh: Row = { sku, tyQty: 0, tyRev: 0, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 };
      map.set(sku, fresh);
      return fresh;
    };
    for (const [sku, a] of result.t3) { const r = ensure(sku); r.tyQty += a.qty; r.tyRev += a.totalPrice; r.tyMrgn += a.marginAmount; }
    for (const [sku, a] of result.ly) { const r = ensure(sku); r.lyQty += a.qty; r.lyRev += a.totalPrice; r.lyMrgn += a.marginAmount; }
    // extras don't have a string sku; surface them under their sku_id
    // so the operator can at least see the magnitude. Cross-grid coverage
    // is best-effort — the export-render layer resolves these more
    // thoroughly.
    for (const [skuId, e] of result.extraBySkuId) {
      const r = ensure(`[cross-grid] ${skuId.slice(0, 8)}`);
      r.tyQty += e.t3Qty; r.tyRev += e.t3Total; r.tyMrgn += e.t3Margin;
      r.lyQty += e.lyQty; r.lyRev += e.lyTotal; r.lyMrgn += e.lyMargin;
    }
    return [...map.values()]
      .filter(r => r.tyRev > 0 || r.lyRev > 0)
      .sort((a, b) => Math.max(b.tyRev, b.lyRev) - Math.max(a.tyRev, a.lyRev));
  }, [result]);

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}
    >
      <div
        style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, minWidth: 540, maxWidth: result ? 920 : 560, maxHeight: "90vh", color: C.text, fontFamily: "inherit", boxShadow: "0 16px 48px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column" }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.accent, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Sales Comps {result && <span style={{ color: C.textMuted, fontWeight: 400, textTransform: "none", letterSpacing: 0, marginLeft: 8 }}>— results</span>}
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
              LY window auto-computes: {(() => { const ly = (d: string) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return "—"; const dt = new Date(d + "T00:00:00"); dt.setMonth(dt.getMonth() - 12); return dt.toISOString().slice(0, 10); }; return `${ly(start)} → ${ly(end)}`; })()}
            </div>

            {rangeWarn && <div style={{ fontSize: 12, color: C.red, fontWeight: 600 }}>Start date must be on or before End date.</div>}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <SelectField label="Customer" value={customer} options={customers} onChange={setCustomer} hint="Empty = all customers" />
              <SelectField label="Stores" value={selStores} options={stores} onChange={setSelStores} multi hint="Empty = all stores" />
              <SelectField label="Category" value={selCategories} options={categories} onChange={setSelCategories} multi />
              <SelectField label="Sub-Category" value={selSubCategories} options={subCategories} onChange={setSelSubCategories} multi />
              <SelectField label="Style" value={selStyles} options={styles} onChange={setSelStyles} multi />
            </div>

            {error && <div style={{ fontSize: 12, color: C.red, fontWeight: 600 }}>Fetch failed: {error}</div>}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
              <button onClick={onClose} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.text, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>Cancel</button>
              <button onClick={run} disabled={running} style={{ background: C.accent, border: `1px solid ${C.accent}`, color: "#001A12", padding: "8px 18px", borderRadius: 6, cursor: running ? "wait" : "pointer", fontSize: 13, fontWeight: 600, opacity: running ? 0.6 : 1 }}>
                {running ? "Running…" : "Run Comp"}
              </button>
            </div>
          </div>
        )}

        {result && summary && (
          <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <SummaryCard label="TY Revenue" big={fmtUSD(summary.tyRev)} sub={`${summary.tyQty.toLocaleString()} units · ${fmtPct(summary.tyMrgn, summary.tyRev)} margin`} />
              <SummaryCard label="LY Revenue" big={fmtUSD(summary.lyRev)} sub={`${summary.lyQty.toLocaleString()} units · ${fmtPct(summary.lyMrgn, summary.lyRev)} margin`} />
              <SummaryCard
                label="TY vs LY"
                big={fmtDiff(summary.tyRev, summary.lyRev).text}
                sub={`${summary.tyRev - summary.lyRev >= 0 ? "+" : ""}${fmtUSD(Math.abs(summary.tyRev - summary.lyRev))} vs LY`}
                positive={fmtDiff(summary.tyRev, summary.lyRev).positive}
              />
            </div>

            <div style={{ fontSize: 11, color: C.textDim }}>
              Window: {start} → {end} (TY) · {tableRows.length} SKUs · scope: {[
                customer[0] && `customer ${customer[0]}`,
                selStores.length > 0 && `stores ${selStores.join("/")}`,
                selCategories.length > 0 && `categories ${selCategories.length}`,
                selSubCategories.length > 0 && `sub-cats ${selSubCategories.length}`,
                selStyles.length > 0 && `styles ${selStyles.length}`,
              ].filter(Boolean).join(" · ") || "all"}
            </div>

            <div style={{ flex: 1, minHeight: 280, maxHeight: "55vh", overflowY: "auto", border: `1px solid ${C.border}`, borderRadius: 8 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead style={{ position: "sticky", top: 0, background: C.surface, zIndex: 1 }}>
                  <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                    <th style={th()}>SKU</th>
                    <th style={th("right")}>TY Qty</th>
                    <th style={th("right")}>TY Rev</th>
                    <th style={th("right")}>TY Mrgn%</th>
                    <th style={th("right")}>LY Qty</th>
                    <th style={th("right")}>LY Rev</th>
                    <th style={th("right")}>LY Mrgn%</th>
                    <th style={th("right")}>Δ Rev</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((r, i) => {
                    const diff = fmtDiff(r.tyRev, r.lyRev);
                    return (
                      <tr key={r.sku} style={{ background: i % 2 === 0 ? "transparent" : C.rowAlt }}>
                        <td style={td()}>{r.sku}</td>
                        <td style={td("right")}>{r.tyQty.toLocaleString()}</td>
                        <td style={td("right")}>{fmtUSD(r.tyRev)}</td>
                        <td style={td("right")}>{fmtPct(r.tyMrgn, r.tyRev)}</td>
                        <td style={td("right", C.textMuted)}>{r.lyQty.toLocaleString()}</td>
                        <td style={td("right", C.textMuted)}>{fmtUSD(r.lyRev)}</td>
                        <td style={td("right", C.textMuted)}>{fmtPct(r.lyMrgn, r.lyRev)}</td>
                        <td style={{ ...td("right"), color: diff.positive ? C.green : C.red, fontWeight: 600 }}>{diff.text}</td>
                      </tr>
                    );
                  })}
                  {tableRows.length === 0 && (
                    <tr><td colSpan={8} style={{ ...td(), color: C.textDim, textAlign: "center", padding: 18 }}>No sales in window for this scope.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 6, borderTop: `1px solid ${C.border}` }}>
              <button onClick={reset} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.text, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>← Back</button>
              <button onClick={onClose} style={{ background: C.accent, border: `1px solid ${C.accent}`, color: "#001A12", padding: "8px 18px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Done</button>
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

interface SummaryCardProps { label: string; big: string; sub: string; positive?: boolean }
function SummaryCard({ label, big, sub, positive }: SummaryCardProps): React.ReactElement {
  return (
    <div style={{ background: C.rowAlt, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px" }}>
      <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2, color: positive == null ? C.text : positive ? C.green : C.red }}>{big}</div>
      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{sub}</div>
    </div>
  );
}
