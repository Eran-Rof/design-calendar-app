// src/tanda/InternalChargebacks.tsx
//
// Chargeback Management module (#1744) — promotes factor_chargebacks from a
// recording-grade import ledger to a managed worklist. Two tabs:
//
//   • Worklist — every chargeback/creditback with its auto-matched AR invoice,
//     governed reason code and disposition. Filter by disposition / customer /
//     reason / month / matched / type / text. Column headers sort SERVER-SIDE
//     (the grid is paginated; keys mirror the handler's SORTS whitelist).
//     FULL-ROW click opens the detail modal (no ↗ arrows — house rule). The
//     clickable item identifier renders blue. Every table carries <ExportButton>.
//
//   • Dilution — chargeback $ and % of gross sales: top offenders by customer,
//     breakdown by reason, and the monthly trend. Table-first (no chart libs).
//     Column headers sort CLIENT-SIDE (full dataset in memory); exports follow
//     the on-screen sort.
//
// Detail modal: chargeback fields + matched invoice (click drills to the AR
// invoice), the disposition workflow (a change requires a reason note), owner
// assignment and reason-code coding.
//
// Reads: GET /api/internal/chargebacks (paginated worklist),
//        GET /api/internal/chargebacks/dilution-summary.
// Writes: PATCH /api/internal/chargebacks/:id (disposition/owner/reason/link).

import React, { useEffect, useMemo, useState } from "react";
import { useSeqGuard } from "./hooks/useSeqGuard";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { drillToModule, readDrillParam, consumeDrillParams } from "./scorecardDrill";
import { promptDialog, notify } from "../shared/ui/warn";
import JEDetailModal, { type JEDetailSeed } from "./components/JEDetailModal";
import SourceDocumentModal, { type SourceDocOpen } from "./components/SourceDocumentModal";

const C = {
  bg: "#0b1220", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
  groupHeaderBg: "#162033", totalBg: "#111827",
};

const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2,
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "7px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13,
  whiteSpace: "nowrap",
};
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const thNum: React.CSSProperties = { ...th, textAlign: "right" };
const selectDark: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "3px 6px", borderRadius: 4, fontSize: 12, colorScheme: "dark",
};
const labelStyle: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted,
  textTransform: "uppercase", letterSpacing: 0.5,
};

function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0);
  if (!Number.isFinite(n)) return "$0.00";
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return `${m}/${d}/${y}`;
}
function fmtMonth(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m] = String(iso).split("-");
  return `${m}/${y}`;
}
function fmtPct(p: number | null | undefined): string {
  return p == null ? "—" : `${p.toFixed(2)}%`;
}
// Mirrors isFactorChurnChargeback in api/_lib/chargebackMatch.js: Rosenthal
// "Manual Charge Back" (code 610) recourses the whole invoice back to us — it is
// NOT a customer deduction, so it is excluded from dilution.
function isFactorChurn(r: { reason_code?: string | null; reason?: string | null }): boolean {
  if ((r.reason_code ?? "").toString().trim() === "610") return true;
  return /manual\s*charge\s*back/i.test(r.reason ?? "");
}

// ── Types ────────────────────────────────────────────────────────────────────
type ReasonCode = { id: string; code: string; label: string; category: string; sort?: number };
type MatchedInvoice = { id: string; invoice_number: string; invoice_date: string | null; total_amount_cents: number | string; customer_id: string | null };
type ReasonRef = { code: string; label: string; category: string };

type CBRow = {
  id: string;
  report_month: string;
  factor_customer_no: string;
  customer_name: string;
  client_customer: string | null;
  item_num: string;
  item_date: string | null;
  cb_date: string | null;
  batch: string | null;
  amount_cents: number | string;
  item_type: string;
  reason: string | null;
  reason_code: string | null;
  status: string;
  notes: string | null;
  customer_id: string | null;
  matched_ar_invoice_id: string | null;
  match_method: string | null;
  disposition: string;
  disposition_reason: string | null;
  owner: string | null;
  disposition_at: string | null;
  reason_code_id: string | null;
  updated_by: string | null;
  updated_at: string | null;
  matched: MatchedInvoice | null;
  reason_ref: ReasonRef | null;
};

type DilutionCustomer = { customer_id: string; customer_name: string; chargeback_cents: number; creditback_cents: number; excluded_cents: number; net_cents: number; gross_sales_cents: number; dilution_pct: number | null; count: number };
type DilutionReason = { code: string | null; label: string; category: string | null; chargeback_cents: number; creditback_cents: number; excluded_cents: number; net_cents: number; count: number; pct_of_deductions: number | null };
type DilutionMonth = { ym: string; chargeback_cents: number; creditback_cents: number; excluded_cents: number; net_cents: number; gross_sales_cents: number; dilution_pct: number | null; count: number };
type DilutionSummary = {
  totals: { chargeback_cents: number; creditback_cents: number; excluded_cents: number; net_cents: number; count: number; excluded_count: number; matched_count: number };
  by_customer: DilutionCustomer[];
  by_customer_month: Array<DilutionCustomer & { ym: string }>;
  by_month: DilutionMonth[];
  by_reason: DilutionReason[];
};

// Worklist sort — server-side (the grid is paginated); keys must stay in the
// handler's SORTS whitelist (api/_handlers/internal/chargebacks/index.js).
type WorklistSortKey = "item_num" | "customer_name" | "cb_date" | "reason" | "amount_cents" | "disposition" | "owner";
const WORKLIST_SORT_DEFAULT_DIR: Record<WorklistSortKey, "asc" | "desc"> = {
  item_num: "asc", customer_name: "asc", cb_date: "desc", reason: "asc",
  amount_cents: "desc", disposition: "asc", owner: "asc",
};

function sortIndicator(active: boolean, dir: "asc" | "desc"): string {
  return active ? (dir === "asc" ? " ▲" : " ▼") : "";
}

const DISPOSITIONS = ["open", "valid", "disputed", "recovered", "written_off"] as const;
const DISPOSITION_LABEL: Record<string, string> = {
  open: "Open", valid: "Valid", disputed: "Disputed", recovered: "Recovered", written_off: "Written Off",
};
const DISPOSITION_COLOR: Record<string, string> = {
  open: C.textMuted, valid: C.warn, disputed: C.primary, recovered: C.success, written_off: C.danger,
};

const WORKLIST_EXPORT_COLUMNS = [
  { key: "month_label",     header: "Month" },
  { key: "customer_name",   header: "Customer (Factor)" },
  { key: "item_num",        header: "Item / Invoice" },
  { key: "matched_invoice", header: "Matched Invoice" },
  { key: "match_method",    header: "Match" },
  { key: "item_date_us",    header: "Item Date" },
  { key: "cb_date_us",      header: "C/B Date" },
  { key: "item_type",       header: "Type" },
  { key: "reason_label",    header: "Reason (coded)" },
  { key: "reason",          header: "Reason (raw)" },
  { key: "amount_cents",    header: "Amount", format: "currency_cents" },
  { key: "disposition_label", header: "Disposition" },
  { key: "owner",           header: "Owner" },
] as ExportColumn<Record<string, unknown>>[];

const DILUTION_CUST_COLUMNS = [
  { key: "customer_name",     header: "Customer" },
  { key: "chargeback_cents",  header: "Chargebacks",  format: "currency_cents" },
  { key: "creditback_cents",  header: "Creditbacks",  format: "currency_cents" },
  { key: "excluded_cents",    header: "Excluded (factor churn)", format: "currency_cents" },
  { key: "net_cents",         header: "Net",          format: "currency_cents" },
  { key: "gross_sales_cents", header: "Gross Sales",  format: "currency_cents" },
  { key: "dilution_pct_str",  header: "Dilution %" },
  { key: "count",             header: "Items" },
] as ExportColumn<Record<string, unknown>>[];

const DILUTION_REASON_COLUMNS = [
  { key: "label",             header: "Reason" },
  { key: "category",          header: "Category" },
  { key: "chargeback_cents",  header: "Chargebacks", format: "currency_cents" },
  { key: "excluded_cents",    header: "Excluded (factor churn)", format: "currency_cents" },
  { key: "net_cents",         header: "Net",         format: "currency_cents" },
  { key: "count",             header: "Items" },
  { key: "pct_str",           header: "% of Deductions" },
] as ExportColumn<Record<string, unknown>>[];

const DILUTION_MONTH_COLUMNS = [
  { key: "month_label",       header: "Month" },
  { key: "chargeback_cents",  header: "Chargebacks",  format: "currency_cents" },
  { key: "creditback_cents",  header: "Creditbacks",  format: "currency_cents" },
  { key: "net_cents",         header: "Net",          format: "currency_cents" },
  { key: "gross_sales_cents", header: "Gross Sales",  format: "currency_cents" },
  { key: "dilution_pct_str",  header: "Dilution %" },
] as ExportColumn<Record<string, unknown>>[];

// ── Detail modal ─────────────────────────────────────────────────────────────
function DetailModal({ row, reasonCodes, onClose, onPatch, saving }: {
  row: CBRow;
  reasonCodes: ReasonCode[];
  onClose: () => void;
  onPatch: (id: string, patch: Record<string, unknown>) => Promise<void>;
  saving: boolean;
}) {
  const [origin, setOrigin] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function changeDisposition(next: string) {
    if (next === row.disposition) return;
    const reason = await promptDialog(
      `Change disposition to "${DISPOSITION_LABEL[next]}". A reason note is required.`,
      { title: "Disposition change", confirmText: "Save" }
    );
    if (reason == null) return; // cancelled
    if (!reason.trim()) { notify("A reason note is required to change disposition.", "error"); return; }
    await onPatch(row.id, { disposition: next, disposition_reason: reason.trim() });
  }

  async function assignOwner() {
    const owner = await promptDialog("Assign owner (name or email); blank to clear:", {
      title: "Assign owner", defaultValue: row.owner || "", confirmText: "Save",
    });
    if (owner == null) return;
    await onPatch(row.id, { owner: owner.trim() || null });
  }

  const amt = Number(row.amount_cents || 0);
  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span>
      <span style={{ fontSize: 13, color: C.text }}>{children}</span>
    </div>
  );

  return (
    <>
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 12, width: "min(720px, 95vw)", maxHeight: "90vh", display: "flex", flexDirection: "column" }}
      >
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.cardBdr}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>
            Chargeback — <span style={{ fontFamily: "monospace" }}>{row.item_num}</span>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: C.textMuted, fontSize: 20, cursor: "pointer" }} title="Close">✕</button>
        </div>

        <div style={{ padding: 18, overflow: "auto", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Field label="Customer (Factor)">{row.customer_name}{row.client_customer ? ` (${row.client_customer})` : ""}</Field>
          <Field label="Rosenthal #">{row.factor_customer_no}</Field>
          <Field label="Type">{row.item_type}</Field>
          <Field label="Amount"><span style={{ color: amt < 0 ? C.success : C.warn, fontWeight: 600 }}>{fmtCents(amt)}</span></Field>
          <Field label="Item Date">{fmtDate(row.item_date)}</Field>
          <Field label="Chargeback Date">{fmtDate(row.cb_date)}</Field>
          <Field label="Report Month">{fmtMonth(row.report_month)}</Field>
          <Field label="Batch">{row.batch || "—"}</Field>
          <Field label="Reason (raw)">{row.reason ? `${row.reason}${row.reason_code ? ` (${row.reason_code})` : ""}` : "—"}</Field>
          <Field label="Match Method">{row.match_method || "unmatched"}</Field>

          {isFactorChurn(row) && (
            <div style={{ gridColumn: "1 / -1", background: C.groupHeaderBg, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "8px 12px", fontSize: 12, color: C.textSub }}>
              <strong style={{ color: C.text }}>Factor receivable churn.</strong> Rosenthal recoursed the whole invoice back
              to us (Manual Charge Back) — this is not a customer deduction, so it is <em>excluded</em> from dilution
              analytics. The ledger row is kept as-is.
            </div>
          )}

          <div style={{ gridColumn: "1 / -1", height: 1, background: C.cardBdr }} />

          <Field label="Matched AR Invoice">
            {row.matched ? (
              <span
                onClick={() => drillToModule("ar_invoices", { q: row.matched!.invoice_number })}
                style={{ color: C.primary, fontWeight: 600, cursor: "pointer", fontFamily: "monospace" }}
                title="Open the AR invoice"
              >
                {row.matched.invoice_number}
              </span>
            ) : (
              <span style={{ color: C.textMuted }}>Not matched</span>
            )}
          </Field>
          <Field label="Invoice Total">{row.matched ? fmtCents(row.matched.total_amount_cents) : "—"}</Field>

          <Field label="Origin trace">
            <span onClick={() => setOrigin(true)} style={{ color: C.primary, fontWeight: 600, cursor: "pointer" }} title="Trace this chargeback to its matched invoice and the journal entries that posted it">
              Trace → invoice → JE
            </span>
          </Field>

          <label style={labelStyle}>
            Reason code
            <select
              value={row.reason_code_id || ""}
              disabled={saving}
              onChange={(e) => void onPatch(row.id, { reason_code_id: e.target.value || null })}
              style={{ ...selectDark, padding: "5px 8px", fontSize: 13 }}
            >
              <option value="">— Un-coded —</option>
              {reasonCodes.map((rc) => <option key={rc.id} value={rc.id}>{rc.label}</option>)}
            </select>
          </label>

          <label style={labelStyle}>
            Disposition
            <select
              value={row.disposition}
              disabled={saving}
              onChange={(e) => void changeDisposition(e.target.value)}
              style={{ ...selectDark, padding: "5px 8px", fontSize: 13 }}
            >
              {DISPOSITIONS.map((d) => <option key={d} value={d}>{DISPOSITION_LABEL[d]}</option>)}
            </select>
          </label>

          <Field label="Owner">
            <span onClick={assignOwner} style={{ color: C.primary, fontWeight: 600, cursor: "pointer" }} title="Assign owner">
              {row.owner || "Assign…"}
            </span>
          </Field>
          <Field label="Disposition note">{row.disposition_reason || "—"}</Field>

          {row.disposition_at && (
            <Field label="Last disposition">{fmtDate(row.disposition_at)} {row.updated_by ? `· ${row.updated_by}` : ""}</Field>
          )}
        </div>

        <div style={{ padding: "12px 18px", borderTop: `1px solid ${C.cardBdr}`, display: "flex", justifyContent: "flex-end", gap: 10, position: "sticky", bottom: 0, background: C.card }}>
          <button onClick={onClose} style={{ background: C.cardBdr, color: C.text, border: "none", padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>Close</button>
        </div>
      </div>
    </div>
    {origin && <OriginChainModal chargebackId={row.id} itemNum={row.item_num} onClose={() => setOrigin(false)} />}
    </>
  );
}

// ── Worklist tab ─────────────────────────────────────────────────────────────
function Worklist({ dilution }: { dilution: DilutionSummary | null }) {
  const [rows, setRows] = useState<CBRow[]>([]);
  const [reasonCodes, setReasonCodes] = useState<ReasonCode[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 100;
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<CBRow | null>(null);

  // Seed disposition/month from a one-shot drill (e.g. the Month-End Close
  // "Chargebacks reviewed → Review" link seeds cb_disposition=open & cb_month).
  const [fDisposition, setFDisposition] = useState(() => readDrillParam("cb_disposition"));
  const [fCustomer, setFCustomer] = useState("");
  const [fReason, setFReason] = useState("");
  const [fMonth, setFMonth] = useState(() => readDrillParam("cb_month"));
  const [fMatched, setFMatched] = useState("");
  const [fType, setFType] = useState("");
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState<WorklistSortKey>("cb_date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const seqGuard = useSeqGuard();

  const load = React.useCallback(async (goPage: number) => {
    const seq = seqGuard.begin();
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams();
      if (fDisposition) p.set("disposition", fDisposition);
      if (fCustomer) p.set("customer_id", fCustomer);
      if (fReason) p.set("reason_code_id", fReason);
      if (fMonth) p.set("month", fMonth);
      if (fMatched) p.set("matched", fMatched);
      if (fType) p.set("item_type", fType);
      if (q.trim()) p.set("q", q.trim());
      p.set("sort", sortKey);
      p.set("dir", sortDir);
      p.set("page", String(goPage));
      p.set("page_size", String(pageSize));
      const r = await fetch(`/api/internal/chargebacks?${p}`);
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `HTTP ${r.status}`); }
      const data = await r.json();
      if (!seqGuard.isCurrent(seq)) return;
      setRows(data.rows || []);
      setReasonCodes(data.reason_codes || []);
      setTotal(data.total || 0);
      setPage(data.page || goPage);
    } catch (e: unknown) {
      if (seqGuard.isCurrent(seq)) { setErr(e instanceof Error ? e.message : String(e)); setRows([]); }
    } finally {
      if (seqGuard.isCurrent(seq)) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fDisposition, fCustomer, fReason, fMonth, fMatched, fType, q, sortKey, sortDir]);

  useEffect(() => { void load(1); }, [fDisposition, fCustomer, fReason, fMonth, fMatched, fType, sortKey, sortDir]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(1); consumeDrillParams(["cb_disposition", "cb_month"]); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function patchRow(id: string, patch: Record<string, unknown>) {
    setSaving(true);
    try {
      const r = await fetch(`/api/internal/chargebacks/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `HTTP ${r.status}`); }
      const updated = await r.json();
      setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...updated } : row)));
      setDetail((prev) => (prev && prev.id === id ? { ...prev, ...updated } : prev));
      notify("Saved.", "success");
    } catch (e: unknown) {
      notify(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSaving(false);
    }
  }

  const months = dilution?.by_month.map((m) => m.ym) || [];
  const customers = dilution?.by_customer || [];

  const exportRows = rows.map((r) => ({
    ...r,
    month_label: fmtMonth(r.report_month),
    item_date_us: fmtDate(r.item_date),
    cb_date_us: fmtDate(r.cb_date),
    matched_invoice: r.matched?.invoice_number || "",
    reason_label: r.reason_ref?.label || "",
    disposition_label: DISPOSITION_LABEL[r.disposition] || r.disposition,
  })) as unknown as Array<Record<string, unknown>>;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  function toggleSort(key: WorklistSortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(WORKLIST_SORT_DEFAULT_DIR[key]); }
  }
  const SortTh = ({ label, k, numeric }: { label: string; k: WorklistSortKey; numeric?: boolean }) => (
    <th
      style={{ ...(numeric ? thNum : th), cursor: "pointer", userSelect: "none", color: sortKey === k ? C.text : C.textMuted }}
      onClick={() => toggleSort(k)}
      title={`Sort by ${label}`}
    >
      {label}{sortIndicator(sortKey === k, sortDir)}
    </th>
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={labelStyle}>Disposition
          <select value={fDisposition} onChange={(e) => setFDisposition(e.target.value)} style={{ ...selectDark, padding: "6px 10px", fontSize: 13 }}>
            <option value="">All</option>
            {DISPOSITIONS.map((d) => <option key={d} value={d}>{DISPOSITION_LABEL[d]}</option>)}
          </select>
        </label>
        <label style={labelStyle}>Customer
          <select value={fCustomer} onChange={(e) => setFCustomer(e.target.value)} style={{ ...selectDark, padding: "6px 10px", fontSize: 13, maxWidth: 200 }}>
            <option value="">All</option>
            {customers.map((c) => <option key={c.customer_id} value={c.customer_id}>{c.customer_name}</option>)}
          </select>
        </label>
        <label style={labelStyle}>Reason
          <select value={fReason} onChange={(e) => setFReason(e.target.value)} style={{ ...selectDark, padding: "6px 10px", fontSize: 13 }}>
            <option value="">All</option>
            <option value="none">Un-coded</option>
            {reasonCodes.map((rc) => <option key={rc.id} value={rc.id}>{rc.label}</option>)}
          </select>
        </label>
        <label style={labelStyle}>Month
          <select value={fMonth} onChange={(e) => setFMonth(e.target.value)} style={{ ...selectDark, padding: "6px 10px", fontSize: 13 }}>
            <option value="">All</option>
            {months.map((m) => <option key={m} value={m}>{fmtMonth(m)}</option>)}
          </select>
        </label>
        <label style={labelStyle}>Matched
          <select value={fMatched} onChange={(e) => setFMatched(e.target.value)} style={{ ...selectDark, padding: "6px 10px", fontSize: 13 }}>
            <option value="">All</option>
            <option value="true">Matched</option>
            <option value="false">Unmatched</option>
          </select>
        </label>
        <label style={labelStyle}>Type
          <select value={fType} onChange={(e) => setFType(e.target.value)} style={{ ...selectDark, padding: "6px 10px", fontSize: 13 }}>
            <option value="">All</option>
            <option value="chargeback">Chargeback</option>
            <option value="creditback">Creditback</option>
          </select>
        </label>
        <label style={labelStyle}>Search
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void load(1); }}
            placeholder="item / customer…"
            style={{ ...selectDark, padding: "6px 10px", fontSize: 13 }}
          />
        </label>
        <div style={{ flex: 1 }} />
        <ExportButton rows={exportRows} filename="chargebacks-worklist" sheetName="Chargebacks" columns={WORKLIST_EXPORT_COLUMNS} />
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>Error: {err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, maxHeight: "calc(100vh - 320px)", overflow: "auto" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No chargebacks match these filters.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <SortTh label="Item / Invoice" k="item_num" />
                <SortTh label="Customer" k="customer_name" />
                <th style={th}>Matched Invoice</th>
                <SortTh label="C/B Date" k="cb_date" />
                <SortTh label="Reason" k="reason" />
                <SortTh label="Amount" k="amount_cents" numeric />
                <SortTh label="Disposition" k="disposition" />
                <SortTh label="Owner" k="owner" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const amt = Number(r.amount_cents || 0);
                return (
                  <tr key={r.id} onClick={() => setDetail(r)} style={{ cursor: "pointer" }} title="Open detail">
                    <td style={{ ...td, fontFamily: "monospace", color: C.primary, fontWeight: 600 }}>{r.item_num}</td>
                    <td style={{ ...td, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>{r.customer_name}</td>
                    <td style={{ ...td, fontFamily: "monospace", color: r.matched ? C.textSub : C.textMuted }}>
                      {r.matched?.invoice_number || "—"}
                    </td>
                    <td style={td}>{fmtDate(r.cb_date)}</td>
                    <td style={{ ...td, fontSize: 12, whiteSpace: "normal", maxWidth: 200 }}>
                      {r.reason_ref?.label || <span style={{ color: C.textMuted }}>{r.reason || "—"}</span>}
                      {isFactorChurn(r) && (
                        <div style={{ color: C.textMuted, fontSize: 10, fontStyle: "italic", marginTop: 2 }}>
                          Factor churn — excluded from dilution
                        </div>
                      )}
                    </td>
                    <td style={{ ...tdNum, color: amt < 0 ? C.success : C.warn }}>{fmtCents(amt)}</td>
                    <td style={{ ...td, color: DISPOSITION_COLOR[r.disposition], fontWeight: 600 }}>{DISPOSITION_LABEL[r.disposition]}</td>
                    <td style={{ ...td, color: r.owner ? C.text : C.textMuted }}>{r.owner || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 12, fontSize: 12, color: C.textSub }}>
        <span>{total.toLocaleString()} chargeback{total === 1 ? "" : "s"}</span>
        <div style={{ flex: 1 }} />
        <button disabled={page <= 1 || loading} onClick={() => void load(page - 1)} style={{ ...selectDark, padding: "5px 12px", cursor: page <= 1 ? "default" : "pointer", opacity: page <= 1 ? 0.5 : 1 }}>◀ Prev</button>
        <span>Page {page} / {totalPages}</span>
        <button disabled={page >= totalPages || loading} onClick={() => void load(page + 1)} style={{ ...selectDark, padding: "5px 12px", cursor: page >= totalPages ? "default" : "pointer", opacity: page >= totalPages ? 0.5 : 1 }}>Next ▶</button>
      </div>

      {detail && <DetailModal row={detail} reasonCodes={reasonCodes} onClose={() => setDetail(null)} onPatch={patchRow} saving={saving} />}
    </div>
  );
}

// ── Dilution tab ─────────────────────────────────────────────────────────────
function Dilution({ dilution, loading, err }: { dilution: DilutionSummary | null; loading: boolean; err: string | null }) {
  const [drill, setDrill] = useState<DrillFacet | null>(null);
  const custRows = useMemo(() => (dilution?.by_customer || []).map((c) => ({
    ...c, dilution_pct_str: fmtPct(c.dilution_pct),
  })) as unknown as Array<Record<string, unknown>>, [dilution]);
  const reasonRows = useMemo(() => (dilution?.by_reason || []).map((r) => ({
    ...r, pct_str: fmtPct(r.pct_of_deductions),
  })) as unknown as Array<Record<string, unknown>>, [dilution]);
  const monthRows = useMemo(() => (dilution?.by_month || []).map((m) => ({
    ...m, month_label: fmtMonth(m.ym), dilution_pct_str: fmtPct(m.dilution_pct),
  })) as unknown as Array<Record<string, unknown>>, [dilution]);

  if (loading) return <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>;
  if (err) return <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6 }}>Error: {err}</div>;
  if (!dilution) return null;

  const t = dilution.totals;
  const totalFacet = (measure: string, title: string, clicked: string): DrillFacet => ({ by: "total", key: "", measure, title, clicked });
  const Card = ({ label, value, color, facet }: { label: string; value: string; color?: string; facet?: DrillFacet }) => (
    <div
      onClick={facet ? () => setDrill(facet) : undefined}
      role={facet ? "button" : undefined}
      tabIndex={facet ? 0 : undefined}
      onKeyDown={facet ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDrill(facet); } } : undefined}
      title={facet ? "Drill to the constituent rows → invoice → journal entries" : undefined}
      style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: "12px 16px", minWidth: 160, cursor: facet ? "pointer" : "default" }}
    >
      <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || C.text, marginTop: 4, fontVariantNumeric: "tabular-nums", textDecoration: facet ? "underline" : undefined, textDecorationStyle: "dotted", textUnderlineOffset: 3 }}>{value}</div>
    </div>
  );

  // ── Per-table cell → drill facet builders ──────────────────────────────────
  const custCellFacet = (row: Record<string, unknown>, ci: number): DrillFacet | null => {
    const cid = String(row.customer_id || "");
    const name = String(row.customer_name || "customer");
    if (!cid) return null;
    const f = (measure: string, clicked: unknown): DrillFacet => ({ by: "customer", key: cid, measure, title: name, clicked: String(clicked) });
    switch (ci) {
      case 1: return f("chargeback", fmtCents(row.chargeback_cents as number));
      case 2: return f("creditback", fmtCents(row.creditback_cents as number));
      case 3: return (row.excluded_cents as number) ? f("excluded", fmtCents(row.excluded_cents as number)) : null;
      case 4: return f("net", fmtCents(row.net_cents as number));
      case 5: return (row.gross_sales_cents as number) ? f("gross_sales", fmtCents(row.gross_sales_cents as number)) : null;
      case 6: return row.dilution_pct != null ? f("dilution", String(row.dilution_pct_str)) : null;
      case 7: return f("count", row.count);
      default: return null;
    }
  };
  const reasonCellFacet = (row: Record<string, unknown>, ci: number): DrillFacet | null => {
    const key = row.code == null ? "__uncoded__" : String(row.code);
    const name = String(row.label || "reason");
    const f = (measure: string, clicked: unknown): DrillFacet => ({ by: "reason", key, measure, title: name, clicked: String(clicked) });
    switch (ci) {
      case 2: return (row.chargeback_cents as number) ? f("chargeback", fmtCents(row.chargeback_cents as number)) : null;
      case 3: return (row.excluded_cents as number) ? f("excluded", fmtCents(row.excluded_cents as number)) : null;
      case 4: return f("net", fmtCents(row.net_cents as number));
      case 5: return f("count", row.count);
      case 6: return (row.chargeback_cents as number) ? f("chargeback", String(row.pct_str)) : null;
      default: return null;
    }
  };
  const monthCellFacet = (row: Record<string, unknown>, ci: number): DrillFacet | null => {
    const ym = String(row.ym || "");
    const name = String(row.month_label || ym);
    if (!ym) return null;
    const f = (measure: string, clicked: unknown): DrillFacet => ({ by: "month", key: ym, measure, title: name, clicked: String(clicked) });
    switch (ci) {
      case 1: return f("chargeback", fmtCents(row.chargeback_cents as number));
      case 2: return f("creditback", fmtCents(row.creditback_cents as number));
      case 3: return f("net", fmtCents(row.net_cents as number));
      case 4: return (row.gross_sales_cents as number) ? f("gross_sales", fmtCents(row.gross_sales_cents as number)) : null;
      case 5: return row.dilution_pct != null ? f("dilution", String(row.dilution_pct_str)) : null;
      default: return null;
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Card label="Gross Chargebacks" value={fmtCents(t.chargeback_cents)} color={C.warn} facet={totalFacet("chargeback", "All chargebacks", fmtCents(t.chargeback_cents))} />
        <Card label="Creditbacks / Recoveries" value={fmtCents(t.creditback_cents)} color={C.success} facet={totalFacet("creditback", "All creditbacks / recoveries", fmtCents(t.creditback_cents))} />
        <Card label="Excluded (factor churn)" value={fmtCents(t.excluded_cents)} color={C.textMuted} facet={t.excluded_cents ? totalFacet("excluded", "All excluded (factor churn)", fmtCents(t.excluded_cents)) : undefined} />
        <Card label="Net" value={fmtCents(t.net_cents)} facet={totalFacet("net", "All net deductions", fmtCents(t.net_cents))} />
        <Card label="Items" value={t.count.toLocaleString()} facet={totalFacet("count", "All chargeback items", t.count.toLocaleString())} />
        <Card label="Matched to invoice" value={`${t.matched_count.toLocaleString()} / ${t.count.toLocaleString()}`} color={C.primary} facet={totalFacet("matched", "Matched to a customer", t.matched_count.toLocaleString())} />
      </div>
      <div style={{ fontSize: 11, color: C.textMuted, fontStyle: "italic", marginTop: -6 }}>
        Gross Chargebacks and Dilution % exclude {t.excluded_count.toLocaleString()} factor receivable-churn item
        {t.excluded_count === 1 ? "" : "s"} ({fmtCents(t.excluded_cents)}) — Rosenthal "Manual Charge Back" recourses the
        whole invoice back to us; it is not a customer deduction.
      </div>

      <DilutionTable
        title="Top offenders — dilution by customer"
        note="Dilution % = gross chargeback deductions ÷ gross sales. Factor receivable churn is excluded."
        rows={custRows}
        columns={DILUTION_CUST_COLUMNS}
        filename="chargeback-dilution-by-customer"
        head={["Customer", "Chargebacks", "Creditbacks", "Excluded", "Net", "Gross Sales", "Dilution %", "Items"]}
        sortKeys={["customer_name", "chargeback_cents", "creditback_cents", "excluded_cents", "net_cents", "gross_sales_cents", "dilution_pct", "count"]}
        render={(c) => [
          <span style={{ color: C.text }}>{String(c.customer_name)}</span>,
          <span style={{ color: C.warn }}>{fmtCents(c.chargeback_cents as number)}</span>,
          <span style={{ color: C.success }}>{fmtCents(c.creditback_cents as number)}</span>,
          <span style={{ color: C.textMuted }}>{(c.excluded_cents as number) ? fmtCents(c.excluded_cents as number) : "—"}</span>,
          fmtCents(c.net_cents as number),
          fmtCents(c.gross_sales_cents as number),
          <strong style={{ color: (c.dilution_pct as number) >= 5 ? C.danger : C.textSub }}>{String(c.dilution_pct_str)}</strong>,
          String(c.count),
        ]}
        numericFrom={1}
        cellFacet={custCellFacet}
        onCellDrill={setDrill}
      />

      <DilutionTable
        title="By reason"
        note="Share of total gross chargeback deductions. Factor receivable churn is shown but excluded from the share."
        rows={reasonRows}
        columns={DILUTION_REASON_COLUMNS}
        filename="chargeback-dilution-by-reason"
        head={["Reason", "Category", "Chargebacks", "Excluded", "Net", "Items", "% of Deductions"]}
        sortKeys={["label", "category", "chargeback_cents", "excluded_cents", "net_cents", "count", "pct_of_deductions"]}
        render={(r) => [
          <span style={{ color: C.text }}>{String(r.label)}</span>,
          <span style={{ color: C.textMuted }}>{r.category ? String(r.category) : "—"}</span>,
          <span style={{ color: C.warn }}>{fmtCents(r.chargeback_cents as number)}</span>,
          <span style={{ color: C.textMuted }}>{(r.excluded_cents as number) ? fmtCents(r.excluded_cents as number) : "—"}</span>,
          fmtCents(r.net_cents as number),
          String(r.count),
          String(r.pct_str),
        ]}
        numericFrom={2}
        cellFacet={reasonCellFacet}
        onCellDrill={setDrill}
      />

      <DilutionTable
        title="Monthly trend"
        note="Chargebacks and dilution % by report month."
        rows={monthRows}
        columns={DILUTION_MONTH_COLUMNS}
        filename="chargeback-dilution-by-month"
        head={["Month", "Chargebacks", "Creditbacks", "Net", "Gross Sales", "Dilution %"]}
        sortKeys={["ym", "chargeback_cents", "creditback_cents", "net_cents", "gross_sales_cents", "dilution_pct"]}
        render={(m) => [
          <span style={{ color: C.text }}>{String(m.month_label)}</span>,
          <span style={{ color: C.warn }}>{fmtCents(m.chargeback_cents as number)}</span>,
          <span style={{ color: C.success }}>{fmtCents(m.creditback_cents as number)}</span>,
          fmtCents(m.net_cents as number),
          fmtCents(m.gross_sales_cents as number),
          <strong style={{ color: C.textSub }}>{String(m.dilution_pct_str)}</strong>,
        ]}
        numericFrom={1}
        cellFacet={monthCellFacet}
        onCellDrill={setDrill}
      />

      {drill && <DrillModal facet={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}

// Null-safe comparator: numbers numerically, everything else as text; nulls last.
function cmpVals(a: unknown, b: unknown): number {
  const aNull = a == null || a === "";
  const bNull = b == null || b === "";
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function DilutionTable({ title, note, rows, columns, filename, head, sortKeys, render, numericFrom, cellFacet, onCellDrill }: {
  title: string; note: string; rows: Array<Record<string, unknown>>;
  columns: ExportColumn<Record<string, unknown>>[]; filename: string;
  head: string[]; sortKeys: Array<string | null>;
  render: (r: Record<string, unknown>) => React.ReactNode[]; numericFrom: number;
  cellFacet?: (row: Record<string, unknown>, colIndex: number) => DrillFacet | null;
  onCellDrill?: (f: DrillFacet) => void;
}) {
  const [sortIdx, setSortIdx] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function toggleSort(i: number) {
    if (sortIdx === i) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortIdx(i); setSortDir(i >= numericFrom ? "desc" : "asc"); }
  }

  const sorted = useMemo(() => {
    if (sortIdx == null) return rows;
    const key = sortKeys[sortIdx];
    if (!key) return rows;
    const sign = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => sign * cmpVals(a[key], b[key]));
  }, [rows, sortKeys, sortIdx, sortDir]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{title}</div>
          <div style={{ fontSize: 11, color: C.textMuted, fontStyle: "italic" }}>{note}</div>
        </div>
        <div style={{ flex: 1 }} />
        <ExportButton rows={sorted} filename={filename} sheetName={title} columns={columns} />
      </div>
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, maxHeight: 360, overflow: "auto" }}>
        {rows.length === 0 ? (
          <div style={{ padding: 16, textAlign: "center", color: C.textMuted }}>No data.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {head.map((h, i) => sortKeys[i] ? (
                  <th
                    key={h}
                    style={{ ...(i >= numericFrom ? thNum : th), cursor: "pointer", userSelect: "none", color: sortIdx === i ? C.text : C.textMuted }}
                    onClick={() => toggleSort(i)}
                    title={`Sort by ${h}`}
                  >
                    {h}{sortIndicator(sortIdx === i, sortDir)}
                  </th>
                ) : (
                  <th key={h} style={i >= numericFrom ? thNum : th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, ri) => (
                <tr key={ri}>
                  {render(r).map((cell, ci) => {
                    const facet = cellFacet && onCellDrill ? cellFacet(r, ci) : null;
                    return (
                      <td key={ci} style={ci >= numericFrom ? tdNum : td}>
                        {facet ? (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={() => onCellDrill!(facet)}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onCellDrill!(facet); } }}
                            style={{ cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 }}
                            title="Drill to the constituent rows → invoice → journal entries"
                          >
                            {cell}
                          </span>
                        ) : cell}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Drill-through (audit trace) ──────────────────────────────────────────────
// Every dilution figure is clickable. A click opens DrillModal with the exact
// constituent rows that sum to it (they reconcile to the number); a row click
// opens OriginChainModal, tracing chargeback → matched AR invoice → the GL
// journal entries that posted it (JE lines via the shared JEDetailModal).

type DrillFacet = { by: string; key: string; measure: string; title: string; clicked: string };

const MEASURE_LABEL: Record<string, string> = {
  chargeback: "Gross chargebacks",
  creditback: "Creditbacks / recoveries",
  excluded: "Excluded (factor churn)",
  net: "Net",
  count: "Items",
  matched: "Matched to a customer",
  dilution: "Gross chargebacks (dilution numerator)",
  gross_sales: "Gross sales",
};

type DrillInvoiceRow = {
  id: string; invoice_number: string; invoice_date: string | null;
  total_amount_cents: number | string; customer_id: string | null; customer_name: string | null;
};
type DrillResp = {
  kind: "chargebacks" | "invoices";
  by: string; key: string; measure: string;
  count: number; sum_cents: number;
  rows: CBRow[] | DrillInvoiceRow[];
  truncated: boolean; limit: number;
};

const DRILL_EXPORT_COLUMNS = [
  { key: "month_label",     header: "Month" },
  { key: "customer_name",   header: "Customer (Factor)" },
  { key: "item_num",        header: "Item / Invoice" },
  { key: "matched_invoice", header: "Matched Invoice" },
  { key: "cb_date_us",      header: "C/B Date" },
  { key: "reason_label",    header: "Reason" },
  { key: "amount_cents",    header: "Amount", format: "currency_cents" },
  { key: "disposition_label", header: "Disposition" },
] as ExportColumn<Record<string, unknown>>[];

function Breadcrumb({ parts }: { parts: string[] }) {
  return (
    <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span style={{ color: C.cardBdr }}>›</span>}
          <span style={{ color: i === parts.length - 1 ? C.textSub : C.textMuted }}>{p}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

function DrillModal({ facet, onClose }: { facet: DrillFacet; onClose: () => void }) {
  const [data, setData] = useState<DrillResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [origin, setOrigin] = useState<CBRow | null>(null);
  const [doc, setDoc] = useState<SourceDocOpen | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setErr(null);
      try {
        const p = new URLSearchParams();
        p.set("by", facet.by);
        if (facet.key) p.set("key", facet.key);
        p.set("measure", facet.measure);
        const r = await fetch(`/api/internal/chargebacks/drill?${p}`);
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `HTTP ${r.status}`); }
        const j = await r.json();
        if (!cancelled) setData(j);
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [facet.by, facet.key, facet.measure]);

  const isCount = facet.measure === "count" || facet.measure === "matched";
  const cbRows = (data?.kind === "chargebacks" ? (data.rows as CBRow[]) : []);
  const invRows = (data?.kind === "invoices" ? (data.rows as DrillInvoiceRow[]) : []);

  const exportRows = cbRows.map((r) => ({
    ...r,
    month_label: fmtMonth(r.report_month),
    cb_date_us: fmtDate(r.cb_date),
    matched_invoice: r.matched?.invoice_number || "",
    reason_label: r.reason_ref?.label || r.reason || "",
    disposition_label: DISPOSITION_LABEL[r.disposition] || r.disposition,
  })) as unknown as Array<Record<string, unknown>>;

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 1000, paddingTop: 40, paddingBottom: 40, overflowY: "auto" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 12, width: "min(900px, 96vw)", maxHeight: "88vh", display: "flex", flexDirection: "column" }}
      >
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.cardBdr}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <Breadcrumb parts={["Dilution", facet.title, MEASURE_LABEL[facet.measure] || facet.measure]} />
              <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>{facet.title}</div>
            </div>
            <button onClick={onClose} style={{ background: "transparent", border: "none", color: C.textMuted, fontSize: 20, cursor: "pointer" }} title="Close">✕</button>
          </div>
          {data && (
            <div style={{ marginTop: 8, fontSize: 12, color: C.textSub, background: C.groupHeaderBg, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "8px 12px" }}>
              {isCount ? (
                <>Constituents: <strong style={{ color: C.text }}>{data.count.toLocaleString()}</strong> {data.kind === "invoices" ? "invoice" : "chargeback"}{data.count === 1 ? "" : "s"} — reconciles to the clicked figure <strong style={{ color: C.text }}>{facet.clicked}</strong>.</>
              ) : (
                <>{data.count.toLocaleString()} {data.kind === "invoices" ? "invoice" : "row"}{data.count === 1 ? "" : "s"} summing to <strong style={{ color: C.text }}>{fmtCents(data.sum_cents)}</strong> — ties to the clicked figure <strong style={{ color: C.text }}>{facet.clicked}</strong>.</>
              )}
              {data.truncated && <span style={{ color: C.textMuted }}> Showing the {data.rows.length} most recent; the sum covers all {data.count}.</span>}
            </div>
          )}
        </div>

        <div style={{ padding: 0, overflow: "auto", flex: 1 }}>
          {loading ? (
            <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
          ) : err ? (
            <div style={{ margin: 16, background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6 }}>Error: {err}</div>
          ) : data?.kind === "invoices" ? (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Invoice</th>
                  <th style={th}>Date</th>
                  <th style={th}>Customer</th>
                  <th style={thNum}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {invRows.length === 0 ? (
                  <tr><td colSpan={4} style={{ ...td, textAlign: "center", color: C.textMuted }}>No invoices.</td></tr>
                ) : invRows.map((r) => (
                  <tr key={r.id} onClick={() => setDoc({ docType: "ar", id: r.id, number: r.invoice_number, party: r.customer_name, module: "ar_invoices" })} style={{ cursor: "pointer" }} title="Open the invoice → its journal entries">
                    <td style={{ ...td, fontFamily: "monospace", color: C.primary, fontWeight: 600 }}>{r.invoice_number}</td>
                    <td style={td}>{fmtDate(r.invoice_date)}</td>
                    <td style={{ ...td, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis" }}>{r.customer_name || "—"}</td>
                    <td style={tdNum}>{fmtCents(r.total_amount_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Item / Invoice</th>
                  <th style={th}>Customer</th>
                  <th style={th}>Matched Invoice</th>
                  <th style={th}>C/B Date</th>
                  <th style={th}>Reason</th>
                  <th style={thNum}>Amount</th>
                  <th style={th}>Disposition</th>
                </tr>
              </thead>
              <tbody>
                {cbRows.length === 0 ? (
                  <tr><td colSpan={7} style={{ ...td, textAlign: "center", color: C.textMuted }}>No chargebacks.</td></tr>
                ) : cbRows.map((r) => {
                  const amt = Number(r.amount_cents || 0);
                  return (
                    <tr key={r.id} onClick={() => setOrigin(r)} style={{ cursor: "pointer" }} title="Trace this chargeback to its invoice & journal entries">
                      <td style={{ ...td, fontFamily: "monospace", color: C.primary, fontWeight: 600 }}>{r.item_num}</td>
                      <td style={{ ...td, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>{r.customer_name}</td>
                      <td style={{ ...td, fontFamily: "monospace", color: r.matched ? C.textSub : C.textMuted }}>{r.matched?.invoice_number || "—"}</td>
                      <td style={td}>{fmtDate(r.cb_date)}</td>
                      <td style={{ ...td, fontSize: 12, whiteSpace: "normal", maxWidth: 200 }}>{r.reason_ref?.label || <span style={{ color: C.textMuted }}>{r.reason || "—"}</span>}</td>
                      <td style={{ ...tdNum, color: amt < 0 ? C.success : C.warn }}>{fmtCents(amt)}</td>
                      <td style={{ ...td, color: DISPOSITION_COLOR[r.disposition], fontWeight: 600 }}>{DISPOSITION_LABEL[r.disposition]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ padding: "10px 18px", borderTop: `1px solid ${C.cardBdr}`, display: "flex", justifyContent: "flex-end", gap: 10 }}>
          {data?.kind === "chargebacks" && cbRows.length > 0 && (
            <ExportButton rows={exportRows} filename="chargeback-drill" sheetName="Constituents" columns={DRILL_EXPORT_COLUMNS} />
          )}
          <button onClick={onClose} style={{ background: C.cardBdr, color: C.text, border: "none", padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>Close</button>
        </div>
      </div>

      {origin && <OriginChainModal chargebackId={origin.id} itemNum={origin.item_num} onClose={() => setOrigin(null)} />}
      {doc && <SourceDocumentModal doc={doc} onClose={() => setDoc(null)} />}
    </div>
  );
}

type OriginResp = {
  chargeback: {
    id: string; item_num: string; customer_name: string; client_customer: string | null;
    amount_cents: number | string; item_type: string; cb_date: string | null; report_month: string;
    reason: string | null; reason_code: string | null; reason_ref: ReasonRef | null;
    disposition: string; match_method: string | null;
  };
  invoice: { id: string; invoice_number: string; invoice_date: string | null; total_amount_cents: number | string; customer_id: string | null; customer_name: string | null } | null;
  jes: Array<{ id: string; je_number: string | null; basis: string; journal_type: string; posting_date: string | null; status: string; description: string | null; leg: string | null; total_debit_cents: number }>;
  note: string;
};

function OriginChainModal({ chargebackId, itemNum, onClose }: { chargebackId: string; itemNum: string; onClose: () => void }) {
  const [data, setData] = useState<OriginResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [doc, setDoc] = useState<SourceDocOpen | null>(null);
  const [jeSeed, setJeSeed] = useState<JEDetailSeed | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setErr(null);
      try {
        const r = await fetch(`/api/internal/chargebacks/${chargebackId}/origin`);
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `HTTP ${r.status}`); }
        const j = await r.json();
        if (!cancelled) setData(j);
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [chargebackId]);

  const cb = data?.chargeback;
  const inv = data?.invoice || null;
  const amt = Number(cb?.amount_cents || 0);

  const SectionTitle = ({ children }: { children: React.ReactNode }) => (
    <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, margin: "14px 0 6px" }}>{children}</div>
  );

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 1050, paddingTop: 40, paddingBottom: 40, overflowY: "auto" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 12, width: "min(760px, 96vw)", maxHeight: "88vh", overflowY: "auto", padding: 18, boxSizing: "border-box" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <Breadcrumb parts={["Chargeback", itemNum, "Origin trace", "Journal entries"]} />
            <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>
              Origin trace — <span style={{ fontFamily: "monospace" }}>{itemNum}</span>
            </div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: C.textMuted, fontSize: 20, cursor: "pointer" }} title="Close">✕</button>
        </div>

        {loading && <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>}
        {err && <div style={{ margin: "12px 0", background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6 }}>Error: {err}</div>}

        {cb && (
          <>
            <SectionTitle>Chargeback</SectionTitle>
            <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "10px 12px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, fontSize: 13 }}>
              <div><div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase" }}>Amount</div><span style={{ color: amt < 0 ? C.success : C.warn, fontWeight: 600 }}>{fmtCents(amt)}</span></div>
              <div><div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase" }}>C/B Date</div>{fmtDate(cb.cb_date)}</div>
              <div><div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase" }}>Disposition</div><span style={{ color: DISPOSITION_COLOR[cb.disposition], fontWeight: 600 }}>{DISPOSITION_LABEL[cb.disposition] || cb.disposition}</span></div>
              <div style={{ gridColumn: "1 / -1" }}><div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase" }}>Customer / Reason</div>{cb.customer_name}{cb.reason_ref?.label ? ` · ${cb.reason_ref.label}` : cb.reason ? ` · ${cb.reason}` : ""}</div>
            </div>

            <SectionTitle>Matched AR invoice (source document)</SectionTitle>
            {inv ? (
              <div
                onClick={() => setDoc({ docType: "ar", id: inv.id, number: inv.invoice_number, party: inv.customer_name, module: "ar_invoices" })}
                style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "10px 12px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                title="Open the invoice document"
              >
                <div>
                  <span style={{ color: C.primary, fontWeight: 600, fontFamily: "monospace" }}>{inv.invoice_number}</span>
                  <span style={{ color: C.textMuted, fontSize: 12, marginLeft: 8 }}>{inv.customer_name || "—"} · {fmtDate(inv.invoice_date)}</span>
                </div>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtCents(inv.total_amount_cents)}</span>
              </div>
            ) : (
              <div style={{ color: C.textMuted, fontSize: 13, fontStyle: "italic" }}>Not matched — no source document.</div>
            )}

            <SectionTitle>Journal entries (posted to GL)</SectionTitle>
            {data && data.jes.length > 0 ? (
              <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={th}>JE #</th>
                      <th style={th}>Basis / Leg</th>
                      <th style={th}>Posting Date</th>
                      <th style={th}>Status</th>
                      <th style={thNum}>Debits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.jes.map((je) => (
                      <tr key={je.id} onClick={() => setJeSeed({ id: je.id, je_number: je.je_number, description: je.description, status: je.status as JEDetailSeed["status"] })} style={{ cursor: "pointer" }} title="Open the journal entry and its lines">
                        <td style={{ ...td, fontFamily: "monospace", color: C.primary, fontWeight: 600 }}>{je.je_number || "JE"}</td>
                        <td style={td}>{je.basis}{je.leg ? ` · ${je.leg}` : ""}</td>
                        <td style={td}>{fmtDate(je.posting_date)}</td>
                        <td style={td}>{je.status}</td>
                        <td style={tdNum}>{fmtCents(je.total_debit_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ color: C.textMuted, fontSize: 13, fontStyle: "italic" }}>No journal entries on this chain.</div>
            )}

            {data?.note && (
              <div style={{ marginTop: 14, fontSize: 12, color: C.textSub, background: C.groupHeaderBg, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "8px 12px" }}>
                {data.note}
              </div>
            )}
          </>
        )}

        <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ background: C.cardBdr, color: C.text, border: "none", padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>Close</button>
        </div>
      </div>

      {doc && <SourceDocumentModal doc={doc} onClose={() => setDoc(null)} />}
      {jeSeed && <JEDetailModal je={jeSeed} onClose={() => setJeSeed(null)} onReversed={() => {}} />}
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────
export default function InternalChargebacks() {
  const [tab, setTab] = useState<"worklist" | "dilution">("worklist");
  const [dilution, setDilution] = useState<DilutionSummary | null>(null);
  const [dLoading, setDLoading] = useState(true);
  const [dErr, setDErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setDLoading(true); setDErr(null);
      try {
        const r = await fetch("/api/internal/chargebacks/dilution-summary");
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `HTTP ${r.status}`); }
        const data = await r.json();
        if (!cancelled) setDilution(data);
      } catch (e: unknown) {
        if (!cancelled) setDErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setDLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const tabBtn = (key: "worklist" | "dilution", label: string): React.CSSProperties => ({
    background: tab === key ? C.card : "transparent",
    color: tab === key ? C.text : C.textMuted,
    border: `1px solid ${tab === key ? C.cardBdr : "transparent"}`,
    borderBottom: tab === key ? `2px solid ${C.primary}` : "2px solid transparent",
    padding: "8px 16px", borderRadius: "8px 8px 0 0", cursor: "pointer", fontSize: 13, fontWeight: 600,
  });

  return (
    <div>
      <div style={{ marginBottom: 4 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>Chargeback Management</div>
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>
          Rosenthal factor chargebacks matched to their originating AR invoices, with a disposition workflow and dilution analytics.
          Positive = chargeback (deduction taken by the customer); negative = creditback / recovery.
        </div>
      </div>

      <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.cardBdr}`, marginBottom: 16 }}>
        <button onClick={() => setTab("worklist")} style={tabBtn("worklist", "Worklist")}>Worklist</button>
        <button onClick={() => setTab("dilution")} style={tabBtn("dilution", "Dilution")}>Dilution</button>
      </div>

      {tab === "worklist" ? <Worklist dilution={dilution} /> : <Dilution dilution={dilution} loading={dLoading} err={dErr} />}
    </div>
  );
}
