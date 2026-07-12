// src/tanda/InternalThreeWayMatch.tsx
//
// 3-Way Match — the payables control panel, two tabs:
//
// 1. "Bill Match Audit" (default) — the match ENGINE results over every AP
//    bill in the book (invoices.invoice_kind='vendor_bill'). The engine
//    (run_three_way_match() SQL RPC, shared with the 06:45 UTC nightly cron)
//    matches each bill to its PO(s) via explicit invoice_line_items.po_number
//    refs or a fuzzy vendor+amount+date pass, then checks the bill against
//    the PO price/amount and the RECEIVING EVIDENCE (po_line_items.qty_
//    received on the Xoro mirror; purchase_order_lines.qty_received for
//    native-only POs — the standalone receipt tables are empty in prod, so
//    received-qty on the PO lines IS the receipt leg). Summary tiles,
//    exception grid with filters, drill to bill/PO, Accept-variance /
//    Dispute actions (T11 reason required), tolerance config.
//
// 2. "Vendor Invoice Drafts" — the original P13-C4 staging vertical: stage a
//    NEW vendor invoice against native POs + posted tanda_po_receipts before
//    it becomes an AP invoice draft. Unchanged.
//
// Mirrors InternalReceiving.tsx conventions (C palette, th/td/input/button
// styles, SearchableSelect, notify/confirmDialog, mandatory ExportButton, Field).

import { useEffect, useMemo, useState } from "react";
import { fmtDateDisplay } from "../utils/tandaTypes";
import SearchableSelect from "./components/SearchableSelect";
import { notify, confirmDialog, promptDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";
import { useSeqGuard } from "./hooks/useSeqGuard";
import DateRangePresets from "./components/DateRangePresets";
import { drillToModule } from "./scorecardDrill";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box", colorScheme: "dark" };
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const btnSuccess: React.CSSProperties = { ...btnPrimary, background: C.success };
const btnDangerSolid: React.CSSProperties = { ...btnPrimary, background: C.danger };

type Draft = {
  id: string; vendor_id: string; vendor_invoice_number: string; invoice_date: string;
  due_date: string | null; currency: string; total_cents: number | string;
  source_kind: string; three_way_match_status: string;
  matched_po_ids: string[]; matched_receipt_ids: string[];
  variance_cents: number | string; variance_reason: string | null;
  ap_invoice_id: string | null; rejected_reason: string | null;
  vendor_name?: string | null;
};
type MatchLine = {
  purchase_order_line_id: string; line_number: number | null; description: string | null;
  qty_ordered: number | null; qty_accepted: number; unit_cost_cents: number; line_received_value_cents: number;
};
type MatchBreakdown = {
  purchase_order_id: string | null; po_number: string | null; po_total_cents: number | null;
  received_value_cents: number; invoice_total_cents: number; variance_cents: number;
  tolerance_cents: number; within_tolerance: boolean; lines: MatchLine[];
};
type DraftDetail = Draft & { match?: MatchBreakdown };
type PO = { id: string; po_number: string | null; vendor_id: string | null; status: string; total_cents?: number | string };
type Vendor = { id: string; name: string; code?: string };

function fmtCents(c: number | string | null | undefined): string {
  if (c === null || c === undefined) return "—";
  const n = Number(c ?? 0); const neg = n < 0; const abs = Math.abs(n);
  return `${neg ? "-" : ""}$${Math.trunc(abs / 100).toLocaleString()}.${String(Math.round(abs % 100)).padStart(2, "0")}`;
}
const STATUS_COLORS: Record<string, string> = {
  pending: C.textMuted, matched: C.success, variance: C.warn, exception: C.danger,
  posted: C.primary, rejected: C.textMuted,
};

const EXPORT_COLUMNS: ExportColumn<Record<string, unknown>>[] = [
  { key: "vendor_name", header: "Vendor" },
  { key: "vendor_invoice_number", header: "Invoice #" },
  { key: "invoice_date", header: "Invoice date", format: "date" },
  { key: "total_cents", header: "Total $", format: "currency_cents" },
  { key: "three_way_match_status", header: "Match status" },
  { key: "variance_cents", header: "Variance $", format: "currency_cents" },
];

// ═══════════════════════════════════════════════════════════════════════════
// Bill Match Audit tab — engine results, tiles, exception queue
// ═══════════════════════════════════════════════════════════════════════════

type MatchPoRef = { po_number: string | null; tanda_po_uuid: string | null; native_po_id: string | null };
type MatchVarPo = {
  po_number: string | null; found?: boolean;
  billed_val?: number | null; billed_qty?: number | null; billed_avg_price?: number | null;
  ordered_qty?: number | null; ordered_val?: number | null;
  received_qty?: number | null; received_val?: number | null; po_avg_price?: number | null;
  cum_billed_val?: number | null; cum_billed_qty?: number | null;
};
type MatchRow = {
  id: string; bill_id: string; status: string; method: string;
  po_refs: MatchPoRef[];
  variance: { pos?: MatchVarPo[]; checks?: Record<string, boolean> };
  matched_at: string; engine_version: number;
  resolution: "open" | "accepted" | "disputed";
  resolution_reason: string | null; resolved_by: string | null; resolved_at: string | null;
  invoice_number: string | null; invoice_date: string | null; total_amount_cents: number;
  vendor_id: string | null; vendor_name: string | null; po_numbers: string[];
};
type MatchSummary = Record<string, { n: number; cents: number; open_n: number; open_cents: number }>;
type Tolerances = {
  id: string; qty_tol_pct: number; price_tol_pct: number; price_tol_abs_cents: number;
  amount_tol_abs_cents: number; fuzzy_amount_tol_pct: number; fuzzy_amount_tol_abs_cents: number;
  fuzzy_date_back_days: number; fuzzy_date_fwd_days: number;
};

const MATCH_STATUS_META: Record<string, { label: string; color: string; exception: boolean }> = {
  matched_3way:            { label: "Matched (3-way)",     color: C.success,   exception: false },
  matched_2way_po_only:    { label: "2-way (no receipt)",  color: C.primary,   exception: false },
  price_variance:          { label: "Price variance",      color: C.warn,      exception: true },
  qty_variance:            { label: "Qty variance",        color: C.warn,      exception: true },
  over_billed_vs_received: { label: "Over-billed",         color: C.danger,    exception: true },
  no_po_found:             { label: "No PO found",         color: C.warn,      exception: true },
  not_applicable:          { label: "Not applicable",      color: C.textMuted, exception: false },
};
const MATCH_STATUS_ORDER = [
  "over_billed_vs_received", "qty_variance", "price_variance", "no_po_found",
  "matched_2way_po_only", "matched_3way", "not_applicable",
];
const METHOD_LABEL: Record<string, string> = {
  explicit_line_ref: "PO ref on bill lines",
  fuzzy_vendor_amount_date: "Fuzzy (vendor + amount + date)",
  none: "—",
};
const RESOLUTION_COLOR: Record<string, string> = { open: C.textMuted, accepted: C.success, disputed: C.danger };

const MATCH_EXPORT_COLUMNS: ExportColumn<Record<string, unknown>>[] = [
  { key: "vendor_name", header: "Vendor" },
  { key: "invoice_number", header: "Bill #" },
  { key: "invoice_date", header: "Bill date", format: "date" },
  { key: "total_amount_cents", header: "Bill $", format: "currency_cents" },
  { key: "po_numbers", header: "PO(s)" },
  { key: "status", header: "Match status" },
  { key: "method", header: "Method" },
  { key: "resolution", header: "Resolution" },
  { key: "resolution_reason", header: "Resolution reason" },
];

function BillMatchTab() {
  const [rows, setRows] = useState<MatchRow[]>([]);
  const [summary, setSummary] = useState<MatchSummary>({});
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");
  const [resolutionFilter, setResolutionFilter] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [detail, setDetail] = useState<MatchRow | null>(null);
  const [tolOpen, setTolOpen] = useState(false);
  const seqGuard = useSeqGuard();

  async function load() {
    const seq = seqGuard.begin();
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (resolutionFilter) params.set("resolution", resolutionFilter);
      if (vendorFilter.trim()) params.set("vendor", vendorFilter.trim());
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);
      const r = await fetch(`/api/internal/three-way-match/matches?${params.toString()}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      if (!seqGuard.isCurrent(seq)) return;
      setRows(Array.isArray(j.rows) ? j.rows as MatchRow[] : []);
      setSummary((j.summary || {}) as MatchSummary);
      setLastRun(j.last_run || null);
    } catch (e) {
      if (seqGuard.isCurrent(seq)) { setErr(e instanceof Error ? e.message : String(e)); setRows([]); }
    } finally {
      if (seqGuard.isCurrent(seq)) setLoading(false);
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [statusFilter, resolutionFilter, fromDate, toDate]);

  async function rerunEngine() {
    if (!(await confirmDialog(
      "Re-run the 3-way match engine over ALL AP bills now? This only recomputes match verdicts — it never touches bills, POs or the GL. The nightly cron does this automatically at 06:45 UTC.",
      { confirmText: "Re-run engine", title: "Re-run match engine" }))) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/internal/three-way-match/run", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify("Match engine re-ran over the full bill book.", "success");
      void load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:threewaymatch:billaudit:sort",
    accessors: {
      vendor_name: (r) => r.vendor_name || "",
      invoice_number: (r) => r.invoice_number || "",
      total_amount_cents: (r) => Number(r.total_amount_cents ?? 0),
      po_numbers: (r) => (r.po_numbers || []).join(", "),
    },
  });

  const exportRows = useMemo(() => rows.map((r) => ({
    vendor_name: r.vendor_name || "",
    invoice_number: r.invoice_number || "",
    invoice_date: r.invoice_date || "",
    total_amount_cents: r.total_amount_cents,
    po_numbers: (r.po_numbers || []).join(", "),
    status: MATCH_STATUS_META[r.status]?.label || r.status,
    method: METHOD_LABEL[r.method] || r.method,
    resolution: r.resolution,
    resolution_reason: r.resolution_reason || "",
  })), [rows]);

  const totalBills = Object.values(summary).reduce((s, v) => s + v.n, 0);
  const inScope = totalBills - (summary.not_applicable?.n || 0);
  const matchedN = (summary.matched_3way?.n || 0) + (summary.matched_2way_po_only?.n || 0);
  const matchRate = inScope > 0 ? Math.round((matchedN / inScope) * 1000) / 10 : 0;

  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        {MATCH_STATUS_ORDER.map((s) => {
          const meta = MATCH_STATUS_META[s];
          const v = summary[s] || { n: 0, cents: 0, open_n: 0, open_cents: 0 };
          const active = statusFilter === s;
          return (
            <div key={s} onClick={() => setStatusFilter(active ? "" : s)}
              style={{ background: active ? "#0b1220" : C.card, border: `1px solid ${active ? meta.color : C.cardBdr}`, borderRadius: 10, padding: "10px 14px", minWidth: 148, cursor: "pointer", flex: "1 1 148px" }}>
              <div style={{ fontSize: 11, color: meta.color, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>{meta.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums" }}>{v.n.toLocaleString()}</div>
              <div style={{ fontSize: 12, color: C.textSub, fontVariantNumeric: "tabular-nums" }}>{fmtCents(v.cents)}</div>
              {meta.exception && v.open_n > 0 && (
                <div style={{ fontSize: 11, color: meta.color, marginTop: 2 }}>{v.open_n} open · {fmtCents(v.open_cents)}</div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <SearchableSelect value={statusFilter || null} onChange={(v) => setStatusFilter(v)} inputStyle={{ ...inputStyle, width: 190 }}
          placeholder="All statuses"
          options={[{ value: "", label: "All statuses" },
            ...MATCH_STATUS_ORDER.map((s) => ({ value: s, label: MATCH_STATUS_META[s].label }))]} />
        <SearchableSelect value={resolutionFilter || null} onChange={(v) => setResolutionFilter(v)} inputStyle={{ ...inputStyle, width: 150 }}
          placeholder="All resolutions"
          options={[{ value: "", label: "All resolutions" },
            ...["open", "accepted", "disputed"].map((s) => ({ value: s, label: s }))]} />
        <input type="text" value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void load(); }} onBlur={() => void load()}
          placeholder="Vendor contains…" style={{ ...inputStyle, width: 180 }} />
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ ...inputStyle, width: 150 }} />
        <span style={{ color: C.textMuted }}>–</span>
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ ...inputStyle, width: 150 }} />
        <DateRangePresets from={fromDate} to={toDate} variant="dropdown"
          onChange={(f, t) => { setFromDate(f); setToDate(t); }} />
        <button style={btnSecondary} onClick={() => void load()} disabled={busy}>Refresh</button>
        <button style={btnSecondary} onClick={() => setTolOpen(true)} disabled={busy}>Tolerances</button>
        <button style={btnPrimary} onClick={() => void rerunEngine()} disabled={busy}>{busy ? "Running…" : "Re-run engine"}</button>
        <ExportButton rows={exportRows} columns={MATCH_EXPORT_COLUMNS} filename="three-way-match-bills" sheetName="Bill Matches" />
      </div>

      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>
        {totalBills.toLocaleString()} bills · match rate {matchRate}% of the {inScope.toLocaleString()} in-scope (PO-vendor) bills
        {lastRun ? ` · last engine change ${fmtDateDisplay(lastRun.slice(0, 10))}` : ""}
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 380px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <SortableTh label="Vendor" sortKey="vendor_name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Bill #" sortKey="invoice_number" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Date" sortKey="invoice_date" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Bill $" sortKey="total_amount_cents" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={{ ...th, textAlign: "right" }} />
            <SortableTh label="PO(s)" sortKey="po_numbers" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Resolution" sortKey="resolution" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
          </tr></thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={7}>Loading…</td></tr>}
            {!loading && sorted.length === 0 && (
              <tr><td style={{ ...td, color: C.textMuted }} colSpan={7}>
                No match rows{totalBills === 0 ? " yet — run the engine (Re-run engine) or wait for the 06:45 UTC nightly." : " for these filters."}
              </td></tr>
            )}
            {!loading && sorted.map((r) => {
              const meta = MATCH_STATUS_META[r.status] || { label: r.status, color: C.text, exception: false };
              return (
                <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => setDetail(r)}>
                  <td style={td}>{r.vendor_name || <span style={{ color: C.textMuted }}>(vendor)</span>}</td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{r.invoice_number || "—"}</td>
                  <td style={td}>{r.invoice_date ? fmtDateDisplay(r.invoice_date) : "—"}</td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(r.total_amount_cents)}</td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 12 }}>
                    {(r.po_numbers || []).slice(0, 3).join(", ")}{(r.po_numbers || []).length > 3 ? ` +${r.po_numbers.length - 3}` : ""}
                  </td>
                  <td style={td}><span style={{ color: meta.color, fontWeight: 600 }}>● {meta.label}</span></td>
                  <td style={{ ...td, color: RESOLUTION_COLOR[r.resolution] || C.text }}>{r.resolution}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {detail && <MatchDetailModal row={detail} onClose={() => setDetail(null)} onChanged={() => { setDetail(null); void load(); }} />}
      {tolOpen && <TolerancesModal onClose={() => setTolOpen(false)} />}
    </div>
  );
}

// ── Match detail modal: per-PO variance evidence + resolve actions ──────────
function MatchDetailModal({ row, onClose, onChanged }: { row: MatchRow; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const meta = MATCH_STATUS_META[row.status] || { label: row.status, color: C.text, exception: false };
  const pos = row.variance?.pos || [];
  const canResolve = row.status !== "matched_3way" && row.status !== "not_applicable";

  async function resolve(resolution: "accepted" | "disputed" | "open") {
    let reason = "";
    if (resolution !== "open") {
      const verb = resolution === "accepted" ? "accept this variance" : "dispute this bill";
      const answer = await promptDialog(`Reason to ${verb}? (required — audit-logged)`, {
        title: resolution === "accepted" ? "Accept variance" : "Dispute bill", multiline: true, required: true,
      });
      if (answer === null) return;
      reason = answer.trim();
      if (!reason) { notify("A reason is required (audit-logged).", "error"); return; }
    } else if (!(await confirmDialog("Re-open this exception (clears the current resolution)?", { confirmText: "Re-open", title: "Re-open exception" }))) {
      return;
    }
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/internal/three-way-match/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ match_id: row.id, resolution, reason }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify(resolution === "accepted" ? "Variance accepted." : resolution === "disputed" ? "Bill flagged as disputed." : "Exception re-opened.",
        resolution === "disputed" ? "info" : "success");
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <Overlay onClose={onClose}>
      <h3 style={{ margin: "0 0 4px", fontSize: 18 }}>{row.vendor_name || "(vendor)"} — {row.invoice_number || "(bill)"}</h3>
      <div style={{ marginBottom: 14, fontSize: 13, color: C.textSub }}>
        <span style={{ color: meta.color, fontWeight: 600 }}>● {meta.label}</span>
        {" · "}{row.invoice_date ? fmtDateDisplay(row.invoice_date) : "—"}
        {" · "}{fmtCents(row.total_amount_cents)}
        {" · "}{METHOD_LABEL[row.method] || row.method}
      </div>

      <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 14, marginBottom: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
          <Stat label="Bill total" value={fmtCents(row.total_amount_cents)} />
          <Stat label="Match method" value={METHOD_LABEL[row.method] || row.method} />
          <Stat label="Resolution" value={row.resolution} color={RESOLUTION_COLOR[row.resolution]} />
          <Stat label="Engine ver / matched" value={`v${row.engine_version} · ${fmtDateDisplay(row.matched_at.slice(0, 10))}`} />
        </div>
        {row.resolution !== "open" && (
          <div style={{ marginTop: 10, fontSize: 12, color: C.textSub }}>
            <span style={{ color: RESOLUTION_COLOR[row.resolution], fontWeight: 600 }}>{row.resolution}</span>
            {row.resolved_by ? ` by ${row.resolved_by}` : ""}{row.resolved_at ? ` on ${fmtDateDisplay(row.resolved_at.slice(0, 10))}` : ""}
            {row.resolution_reason ? ` — ${row.resolution_reason}` : ""}
          </div>
        )}
      </div>

      {pos.length > 0 && (
        <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflowX: "auto", marginBottom: 14 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={th}>PO</th>
              <th style={{ ...th, textAlign: "right" }}>Billed qty</th>
              <th style={{ ...th, textAlign: "right" }}>Billed $</th>
              <th style={{ ...th, textAlign: "right" }}>Billed unit $</th>
              <th style={{ ...th, textAlign: "right" }}>PO unit $</th>
              <th style={{ ...th, textAlign: "right" }}>Ordered qty</th>
              <th style={{ ...th, textAlign: "right" }}>Received qty</th>
              <th style={{ ...th, textAlign: "right" }}>Received $</th>
              <th style={{ ...th, textAlign: "right" }}>Cum billed $</th>
              <th style={th}></th>
            </tr></thead>
            <tbody>
              {pos.map((p, i) => (
                <tr key={`${p.po_number || "?"}-${i}`}>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>
                    {p.po_number || "—"}{p.found === false && <span style={{ color: C.danger, marginLeft: 6, fontSize: 11 }}>not found</span>}
                  </td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{p.billed_qty != null ? Number(p.billed_qty).toLocaleString() : "—"}</td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{p.billed_val != null ? `$${Number(p.billed_val).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "—"}</td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{p.billed_avg_price != null ? `$${Number(p.billed_avg_price).toFixed(4)}` : "—"}</td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{p.po_avg_price != null ? `$${Number(p.po_avg_price).toFixed(4)}` : "—"}</td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{p.ordered_qty != null ? Number(p.ordered_qty).toLocaleString() : "—"}</td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{p.received_qty != null ? Number(p.received_qty).toLocaleString() : "—"}</td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{p.received_val != null ? `$${Number(p.received_val).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "—"}</td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{p.cum_billed_val != null ? `$${Number(p.cum_billed_val).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "—"}</td>
                  <td style={td}>
                    {p.po_number && (
                      <button style={{ ...btnSecondary, padding: "3px 10px", fontSize: 12 }}
                        onClick={() => drillToModule("purchase_orders", { q: p.po_number! })}>View PO</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pos.length === 0 && (
        <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 14 }}>
          {row.status === "not_applicable"
            ? "This vendor has no purchase orders — expense / freight / service bill, out of 3-way scope."
            : "No PO reference found on this bill and no unique fuzzy candidate (vendor + amount + date window)."}
        </div>
      )}

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <div>
          {row.invoice_number && (
            <button style={btnSecondary} onClick={() => drillToModule("ap_invoices", { q: row.invoice_number! })}>View bill</button>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary} disabled={busy}>Close</button>
          {canResolve && row.resolution !== "open" && (
            <button onClick={() => void resolve("open")} style={btnSecondary} disabled={busy}>Re-open</button>
          )}
          {canResolve && row.resolution === "open" && (
            <>
              <button onClick={() => void resolve("disputed")} style={btnDangerSolid} disabled={busy}>Dispute</button>
              <button onClick={() => void resolve("accepted")} style={btnSuccess} disabled={busy}>Accept variance</button>
            </>
          )}
        </div>
      </div>
    </Overlay>
  );
}

// ── Tolerance config modal ──────────────────────────────────────────────────
function TolerancesModal({ onClose }: { onClose: () => void }) {
  const [tol, setTol] = useState<Tolerances | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/internal/three-way-match/tolerances")
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return r.json(); })
      .then((j: Tolerances | null) => {
        setTol(j);
        if (j) setForm({
          qty_tol_pct: String(j.qty_tol_pct), price_tol_pct: String(j.price_tol_pct),
          price_tol_abs_cents: String(j.price_tol_abs_cents / 100), amount_tol_abs_cents: String(j.amount_tol_abs_cents / 100),
          fuzzy_amount_tol_pct: String(j.fuzzy_amount_tol_pct), fuzzy_amount_tol_abs_cents: String(j.fuzzy_amount_tol_abs_cents / 100),
          fuzzy_date_back_days: String(j.fuzzy_date_back_days), fuzzy_date_fwd_days: String(j.fuzzy_date_fwd_days),
        });
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setBusy(true); setErr(null);
    try {
      const body: Record<string, number> = {};
      const num = (k: string) => Number(form[k]);
      for (const k of ["qty_tol_pct", "price_tol_pct", "fuzzy_amount_tol_pct", "fuzzy_date_back_days", "fuzzy_date_fwd_days"]) {
        if (!Number.isFinite(num(k)) || num(k) < 0) throw new Error(`Invalid value for ${k}`);
        body[k] = num(k);
      }
      for (const k of ["price_tol_abs_cents", "amount_tol_abs_cents", "fuzzy_amount_tol_abs_cents"]) {
        if (!Number.isFinite(num(k)) || num(k) < 0) throw new Error(`Invalid value for ${k}`);
        body[k] = Math.round(num(k) * 100); // form holds dollars
      }
      const r = await fetch("/api/internal/three-way-match/tolerances", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify("Tolerances saved. Re-run the engine (or wait for the nightly) to apply them.", "success");
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const F = (label: string, key: string, suffix: string) => (
    <Field label={`${label} (${suffix})`}>
      <input type="text" inputMode="decimal" value={form[key] ?? ""} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} style={inputStyle} />
    </Field>
  );

  return (
    <Overlay onClose={onClose}>
      <h3 style={{ margin: "0 0 12px", fontSize: 18 }}>Match tolerances</h3>
      {loading && <div style={{ color: C.textMuted }}>Loading…</div>}
      {!loading && tol && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            {F("Qty tolerance", "qty_tol_pct", "%")}
            {F("Price tolerance", "price_tol_pct", "%")}
            {F("Price tolerance floor", "price_tol_abs_cents", "$")}
            {F("Amount tolerance", "amount_tol_abs_cents", "$")}
            {F("Fuzzy amount tolerance", "fuzzy_amount_tol_pct", "%")}
            {F("Fuzzy amount floor", "fuzzy_amount_tol_abs_cents", "$")}
            {F("Fuzzy window back", "fuzzy_date_back_days", "days")}
            {F("Fuzzy window forward", "fuzzy_date_fwd_days", "days")}
          </div>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 12 }}>
            Defaults: qty ±2%, price ±1% or $50 (whichever is greater), amount $100. Changes apply on the next engine run.
          </div>
        </>
      )}
      {!loading && !tol && !err && <div style={{ color: C.textMuted, marginBottom: 12 }}>No tolerance row found — apply the 3-way match migration.</div>}
      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button onClick={onClose} style={btnSecondary} disabled={busy}>Close</button>
        {tol && <button onClick={() => void save()} style={btnPrimary} disabled={busy}>{busy ? "Saving…" : "Save"}</button>}
      </div>
    </Overlay>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Panel shell — tabs
// ═══════════════════════════════════════════════════════════════════════════

export default function InternalThreeWayMatch() {
  const [tab, setTab] = useState<"audit" | "drafts">("audit");
  const tabBtn = (active: boolean): React.CSSProperties => ({
    background: active ? C.primary : "transparent",
    color: active ? "white" : C.textSub,
    border: active ? 0 : `1px solid ${C.cardBdr}`,
    padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
  });
  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>3-Way Match</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={tabBtn(tab === "audit")} onClick={() => setTab("audit")}>Bill Match Audit</button>
          <button style={tabBtn(tab === "drafts")} onClick={() => setTab("drafts")}>Vendor Invoice Drafts</button>
        </div>
      </div>
      {tab === "audit" ? <BillMatchTab /> : <VendorInvoiceDraftsTab />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Vendor Invoice Drafts tab — the original P13-C4 staging vertical (unchanged)
// ═══════════════════════════════════════════════════════════════════════════

function VendorInvoiceDraftsTab() {
  const [rows, setRows] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      const r = await fetch(`/api/internal/procurement/vendor-invoice-drafts?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as Draft[]);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [statusFilter]);

  // #5 sortable columns — total/variance are number|string from the API, so
  // sort them numerically; vendor sorts on the resolved name.
  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:threewaymatch:sort",
    accessors: {
      vendor_name: (r) => r.vendor_name || "",
      total_cents: (r) => Number(r.total_cents ?? 0),
      variance_cents: (r) => Number(r.variance_cents ?? 0),
    },
  });

  const exportRows = useMemo(() => {
    const base = rows.map((r) => ({
      vendor_name: r.vendor_name || "",
      vendor_invoice_number: r.vendor_invoice_number,
      invoice_date: r.invoice_date,
      total_cents: r.total_cents,
      three_way_match_status: r.three_way_match_status,
      variance_cents: r.variance_cents,
    }));
    if (base.length === 0) return base;
    // #23 export totals — append a TOTAL row summing the numeric cents columns.
    const totalRow = {
      vendor_name: "TOTAL",
      vendor_invoice_number: "",
      invoice_date: "",
      total_cents: rows.reduce((s, r) => s + Number(r.total_cents ?? 0), 0),
      three_way_match_status: "",
      variance_cents: rows.reduce((s, r) => s + Number(r.variance_cents ?? 0), 0),
    };
    return [...base, totalRow];
  }, [rows]);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <button style={btnPrimary} onClick={() => { setCreating(true); setEditingId(null); setModalOpen(true); }}>+ New vendor invoice</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <SearchableSelect value={statusFilter || null} onChange={(v) => setStatusFilter(v)} inputStyle={{ ...inputStyle, width: 200 }}
          placeholder="All statuses"
          options={[
            { value: "", label: "All statuses" },
            ...["pending", "matched", "variance", "exception", "posted", "rejected"].map((s) => ({ value: s, label: s })),
          ]}
        />
        <button style={btnSecondary} onClick={() => void load()}>Refresh</button>
        <ExportButton rows={exportRows} columns={EXPORT_COLUMNS} filename="three-way-match" sheetName="3-Way Match" />
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <SortableTh label="Vendor" sortKey="vendor_name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Invoice #" sortKey="vendor_invoice_number" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Date" sortKey="invoice_date" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Total" sortKey="total_cents" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={{ ...th, textAlign: "right" }} />
            <SortableTh label="Status" sortKey="three_way_match_status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Variance" sortKey="variance_cents" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={{ ...th, textAlign: "right" }} />
          </tr></thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={6}>Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={6}>No vendor invoice drafts.</td></tr>}
            {sorted.map((r) => (
              <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => { setCreating(false); setEditingId(r.id); setModalOpen(true); }}>
                <td style={td}>{r.vendor_name || <span style={{ color: C.textMuted }}>(vendor)</span>}</td>
                <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{r.vendor_invoice_number}</td>
                <td style={td}>{fmtDateDisplay(r.invoice_date)}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(r.total_cents)}</td>
                <td style={td}><span style={{ color: STATUS_COLORS[r.three_way_match_status] || C.text, fontWeight: 600 }}>● {r.three_way_match_status}</span></td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: Number(r.variance_cents) !== 0 ? C.warn : C.textSub }}>{fmtCents(r.variance_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        creating
          ? <NewInvoiceModal onClose={() => setModalOpen(false)} onSaved={() => { setModalOpen(false); void load(); }} />
          : editingId && <DetailModal draftId={editingId} onClose={() => { setModalOpen(false); setEditingId(null); }} onChanged={() => { void load(); }} />
      )}
    </div>
  );
}

// ── New vendor invoice (create + auto-match) ──────────────────────────────
function NewInvoiceModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [vendorId, setVendorId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState("");
  const [totalDollars, setTotalDollars] = useState("");
  const [poId, setPoId] = useState("");

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [pos, setPos] = useState<PO[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Load vendors + matchable POs (in_transit + received).
  useEffect(() => {
    fetch("/api/internal/vendor-master?limit=1000").then((r) => r.ok ? r.json() : []).then((a) => {
      setVendors(Array.isArray(a) ? a as Vendor[] : []);
    }).catch(() => {});
    Promise.all([
      fetch("/api/internal/purchase-orders?status=in_transit&limit=500").then((r) => r.ok ? r.json() : []),
      fetch("/api/internal/purchase-orders?status=received&limit=500").then((r) => r.ok ? r.json() : []),
    ]).then(([a, b]) => {
      const merged = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])] as PO[];
      setPos(merged);
    }).catch(() => {});
  }, []);

  // When a vendor is picked, narrow the PO picker to that vendor's POs.
  const visiblePos = useMemo(() => vendorId ? pos.filter((p) => p.vendor_id === vendorId) : pos, [pos, vendorId]);

  async function save() {
    setErr(null);
    if (!vendorId) { setErr("Pick a vendor."); return; }
    if (!invoiceNumber.trim()) { setErr("Enter the vendor invoice number."); return; }
    const cents = Math.round((Number(totalDollars) || 0) * 100);
    if (!Number.isFinite(cents) || cents < 0) { setErr("Enter a valid total."); return; }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        vendor_id: vendorId,
        vendor_invoice_number: invoiceNumber.trim(),
        invoice_date: invoiceDate,
        due_date: dueDate || undefined,
        total_cents: cents,
        purchase_order_id: poId || undefined,
      };
      const r = await fetch("/api/internal/procurement/vendor-invoice-drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const status = j?.three_way_match_status || "pending";
      notify(`Vendor invoice saved — match status: ${status}.`, status === "matched" ? "success" : status === "variance" || status === "exception" ? "error" : "info");
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  return (
    <Overlay onClose={onClose}>
      <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>New vendor invoice</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        <Field label="Vendor">
          <SearchableSelect value={vendorId || null} onChange={(v) => setVendorId(v)}
            options={[{ value: "", label: "(pick a vendor…)" }, ...vendors.map((vd) => ({ value: vd.id, label: vd.code ? `${vd.code} — ${vd.name}` : vd.name, searchHaystack: `${vd.code || ""} ${vd.name}` }))]}
            placeholder="(pick a vendor…)" />
        </Field>
        <Field label="Vendor invoice #"><input type="text" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} style={inputStyle} placeholder="e.g. INV-10293" /></Field>
        <Field label="Invoice date"><input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} style={inputStyle} /></Field>
        <Field label="Due date (optional)"><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} style={inputStyle} /></Field>
        <Field label="Invoice total $"><input type="text" inputMode="decimal" value={totalDollars} onChange={(e) => setTotalDollars(e.target.value)} style={inputStyle} placeholder="0.00" /></Field>
        <Field label="Purchase order (in-transit / received — optional)">
          <SearchableSelect value={poId || null} onChange={(v) => setPoId(v)}
            options={[{ value: "", label: "(no PO — match later)" }, ...visiblePos.map((p) => ({ value: p.id, label: `${p.po_number || "(draft)"} — ${p.status} — ${fmtCents(p.total_cents)}`, searchHaystack: `${p.po_number || ""} ${p.status}` }))]}
            placeholder="(no PO — match later)" />
        </Field>
      </div>

      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 12 }}>
        Linking a PO auto-matches the invoice against its posted receipts (matched within $5 or 2%, whichever is greater).
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button onClick={onClose} style={btnSecondary} disabled={submitting}>Close</button>
        <button onClick={() => void save()} style={btnPrimary} disabled={submitting}>{submitting ? "Saving…" : "Save + match"}</button>
      </div>
    </Overlay>
  );
}

// ── Detail / match breakdown + actions ────────────────────────────────────
function DetailModal({ draftId, onClose, onChanged }: { draftId: string; onClose: () => void; onChanged: () => void }) {
  const [draft, setDraft] = useState<DraftDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/procurement/vendor-invoice-drafts/${draftId}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setDraft(await r.json() as DraftDetail);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [draftId]);

  const status = draft?.three_way_match_status || "";
  const isOpen = ["pending", "matched", "variance", "exception"].includes(status);

  async function patch(body: Record<string, unknown>, okMsg: string, kind: "success" | "info" | "error" = "success") {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/procurement/vendor-invoice-drafts/${draftId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify(okMsg, kind);
      setDraft(j as DraftDetail);
      onChanged();
      return true;
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return false; }
    finally { setBusy(false); }
  }

  async function rematch() {
    const ok = await patch({ action: "rematch" }, "Re-matched.", "info");
    if (ok) void load(); // reload to refresh the breakdown numbers
  }
  async function approve() {
    if (!(await confirmDialog("Approve this invoice and create an AP invoice draft? The AP panel will post it to the GL.", { confirmText: "Approve", title: "Approve invoice" }))) return;
    await patch({ action: "approve" }, "AP invoice draft created — post it from the AP panel.", "success");
  }
  async function reject() {
    const reason = await promptDialog("Reason for rejecting this vendor invoice?", { title: "Reject invoice", icon: "", multiline: true, required: true });
    if (reason === null) return;
    if (!reason.trim()) { notify("A reason is required to reject.", "error"); return; }
    if (!(await confirmDialog(`Reject this invoice?\n\n${reason.trim()}`, { confirmText: "Reject", title: "Reject invoice" }))) return;
    await patch({ action: "reject", reason: reason.trim() }, "Invoice rejected.", "info");
  }

  const m = draft?.match;

  return (
    <Overlay onClose={onClose}>
      <h3 style={{ margin: "0 0 4px", fontSize: 18 }}>
        {draft ? `${draft.vendor_name || "(vendor)"} — ${draft.vendor_invoice_number}` : "Vendor invoice"}
      </h3>
      {draft && (
        <div style={{ marginBottom: 16, fontSize: 13, color: C.textSub }}>
          <span style={{ color: STATUS_COLORS[status] || C.text, fontWeight: 600 }}>● {status}</span>
          {" · "}{fmtDateDisplay(draft.invoice_date)}{draft.due_date ? ` · due ${fmtDateDisplay(draft.due_date)}` : ""}
        </div>
      )}

      {loading && <div style={{ color: C.textMuted }}>Loading…</div>}

      {draft && !loading && (
        <>
          {/* Match summary */}
          <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 14, marginBottom: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 10 }}>
              <Stat label="PO #" value={m?.po_number || "(none)"} mono />
              <Stat label="PO total" value={fmtCents(m?.po_total_cents)} />
              <Stat label="Invoice total" value={fmtCents(m?.invoice_total_cents ?? draft.total_cents)} />
              <Stat label="Received + accepted value" value={fmtCents(m?.received_value_cents ?? 0)} />
              <Stat label="Variance (invoice − received)" value={fmtCents(m?.variance_cents ?? draft.variance_cents)} color={Number(m?.variance_cents ?? draft.variance_cents) !== 0 ? C.warn : C.success} />
              <Stat label="Tolerance ($5 or 2%)" value={fmtCents(m?.tolerance_cents ?? 0)} />
            </div>
            <div style={{ fontSize: 13 }}>
              {m && m.purchase_order_id ? (
                m.received_value_cents === 0
                  ? <span style={{ color: C.danger, fontWeight: 600 }}>Exception — no posted receipt found for the linked PO.</span>
                  : m.within_tolerance
                    ? <span style={{ color: C.success, fontWeight: 600 }}>✓ Within tolerance — matched.</span>
                    : <span style={{ color: C.warn, fontWeight: 600 }}>Variance exceeds tolerance.</span>
              ) : <span style={{ color: C.textMuted }}>No PO linked — re-match is unavailable.</span>}
            </div>
            {draft.variance_reason && <div style={{ marginTop: 6, fontSize: 12, color: C.textMuted }}>{draft.variance_reason}</div>}
            {draft.rejected_reason && <div style={{ marginTop: 6, fontSize: 12, color: C.danger }}>Rejected: {draft.rejected_reason}</div>}
            {draft.ap_invoice_id && <div style={{ marginTop: 6, fontSize: 12, color: C.primary }}>AP invoice draft created — post it from the AP panel.</div>}
          </div>

          {/* Per-line breakdown */}
          {m && m.lines.length > 0 && (
            <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 14 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr>
                  <th style={th}>Line</th><th style={th}>Description</th>
                  <th style={{ ...th, textAlign: "right" }}>Ordered</th><th style={{ ...th, textAlign: "right" }}>Accepted</th>
                  <th style={{ ...th, textAlign: "right" }}>Unit $</th><th style={{ ...th, textAlign: "right" }}>Received value</th>
                </tr></thead>
                <tbody>
                  {m.lines.map((l) => (
                    <tr key={l.purchase_order_line_id}>
                      <td style={td}>{l.line_number ?? "—"}</td>
                      <td style={td}>{l.description || <span style={{ color: C.textMuted }}>(no desc)</span>}</td>
                      <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{l.qty_ordered != null ? l.qty_ordered.toLocaleString() : "—"}</td>
                      <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{l.qty_accepted.toLocaleString()}</td>
                      <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(l.unit_cost_cents)}</td>
                      <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(l.line_received_value_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
            <button onClick={onClose} style={btnSecondary} disabled={busy}>Close</button>
            {isOpen && m && m.purchase_order_id && <button onClick={() => void rematch()} style={btnSecondary} disabled={busy}>{busy ? "…" : "Re-match"}</button>}
            {isOpen && <button onClick={() => void reject()} style={btnDangerSolid} disabled={busy}>Reject</button>}
            {isOpen && <button onClick={() => void approve()} style={btnSuccess} disabled={busy} title="Create an AP invoice draft (no JE posted here)">Approve → AP draft</button>}
          </div>
        </>
      )}
    </Overlay>
  );
}

function Stat({ label, value, color, mono }: { label: string; value: string; color?: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: color || C.text, fontVariantNumeric: "tabular-nums", fontFamily: mono ? "SFMono-Regular, Menlo, monospace" : undefined }}>{value}</div>
    </div>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(920px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      {children}
    </div>
  );
}
