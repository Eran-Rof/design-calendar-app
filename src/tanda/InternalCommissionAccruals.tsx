// src/tanda/InternalCommissionAccruals.tsx
//
// Tangerine P7-6 — Commission Accruals admin panel (arch §4.4).
// Read-only list with filters (sales_rep_id, status, period_id) + per-row
// "Pay" action + bulk "Pay All selected" — all funneled through the existing
// P7-5 /api/internal/commissions/settle handler.
//
// Hits: GET /api/internal/commissions/accruals, GET /api/internal/sales-reps,
//       GET /api/internal/gl-periods, GET /api/internal/gl-accounts,
//       POST /api/internal/commissions/settle.

import { useEffect, useMemo, useState } from "react";
import { getCachedAuthUserId } from "../utils/tangerineAuthUser";
import SearchableSelect from "./components/SearchableSelect";
import ExportButton from "./exports/ExportButton";
import { notify } from "../shared/ui/warn";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "./components/TablePrefs";
import { fmtDateDisplay } from "../utils/tandaTypes";

const TABLE_KEY = "tanda.commission_accruals";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "invoice_number", label: "Invoice #" },
  { key: "sales_rep", label: "Sales rep" },
  { key: "accrual_date", label: "Accrual date" },
  { key: "commissionable", label: "Commissionable" },
  { key: "rate", label: "Rate" },
  { key: "commission", label: "Commission" },
  { key: "status", label: "Status" },
  { key: "accrual_je", label: "Accrual JE" },
];

type Accrual = {
  id: string;
  entity_id: string;
  ar_invoice_id: string;
  sales_rep_id: string;
  commissionable_cents: number;
  rate_pct: number;
  commission_cents: number;
  status: "accrued" | "reversed" | "paid";
  accrual_je_id: string | null;
  payout_je_id: string | null;
  reversal_je_id: string | null;
  paid_at: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
  created_at: string;
  sales_reps?: { display_name: string } | null;
  ar_invoices?: { invoice_number: string; invoice_date: string | null } | null;
};

type RepLite = { id: string; display_name: string; is_active: boolean };

type PeriodLite = {
  id: string;
  fiscal_year: number;
  period_number: number;
  starts_on: string;
  ends_on: string;
  status: string;
};

type GLAccountLite = {
  id: string;
  code: string;
  name: string;
  account_type: string | null;
  account_subtype: string | null;
  is_postable: boolean;
  status: string;
};

const PAYMENT_METHODS = ["check", "wire", "ach", "cash", "other"] as const;
const STATUS_VALUES = ["accrued", "reversed", "paid"] as const;

const C = {
  bg: "#0F172A",
  card: "#1E293B",
  cardBdr: "#334155",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  textSub: "#CBD5E1",
  primary: "#3B82F6",
  primaryDim: "#1d4ed8",
  success: "#10B981",
  warn: "#F59E0B",
  danger: "#EF4444",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const btnSuccess: React.CSSProperties = {
  background: C.success, color: "white", border: 0,
  padding: "4px 10px", borderRadius: 4, cursor: "pointer", fontSize: 12, fontWeight: 600,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
  colorScheme: "dark",
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13, verticalAlign: "top",
};
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 11, color: C.textMuted, marginBottom: 4,
  textTransform: "uppercase", letterSpacing: 0.5,
};

const fmtDate = fmtDateDisplay;
function fmtCurrencyFromCents(cents: number | string | null | undefined): string {
  const n = Number(cents || 0);
  const dollars = n / 100;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A gl_account is "cash/bank" eligible iff account_type is asset AND its
 * subtype starts with "cash" or "bank", OR its code prefix matches the
 * ROF chart bank range (1000-1099). We use a permissive client-side filter;
 * the RPC enforces the real check. */
function isCashOrBank(a: GLAccountLite): boolean {
  if (!a.is_postable || a.status !== "active") return false;
  const sub = (a.account_subtype || "").toLowerCase();
  if (sub.includes("cash") || sub.includes("bank") || sub.includes("checking")) return true;
  const type = (a.account_type || "").toLowerCase();
  if (type === "bank") return true;
  // Fallback: typical ROF chart — bank accounts in 1000-1099.
  const codeN = parseInt(a.code, 10);
  if (Number.isFinite(codeN) && codeN >= 1000 && codeN < 1100) return true;
  return false;
}

function periodLabel(p: PeriodLite): string {
  return `FY${p.fiscal_year} P${String(p.period_number).padStart(2, "0")} (${p.starts_on} → ${p.ends_on})`;
}

export default function InternalCommissionAccruals() {
  const [rows, setRows] = useState<Accrual[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [repFilter, setRepFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [periodFilter, setPeriodFilter] = useState("");

  const [reps, setReps] = useState<RepLite[]>([]);
  const [periods, setPeriods] = useState<PeriodLite[]>([]);
  const [glAccounts, setGlAccounts] = useState<GLAccountLite[]>([]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [payOpen, setPayOpen] = useState(false);
  const [bulkPayOpen, setBulkPayOpen] = useState(false);
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (repFilter)    params.set("sales_rep_id", repFilter);
      if (statusFilter) params.set("status", statusFilter);
      const r = await fetch(`/api/internal/commissions/accruals?${params.toString()}`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      let data: Accrual[] = await r.json();
      if (!Array.isArray(data)) data = [];

      // Period filter is client-side: an accrual belongs to a period when
      // its created_at falls between starts_on / ends_on of the selected
      // period. (Server endpoint doesn't accept ?period_id= per P7-5.)
      if (periodFilter) {
        const p = periods.find((x) => x.id === periodFilter);
        if (p) {
          const startMs = new Date(p.starts_on + "T00:00:00Z").getTime();
          const endMs   = new Date(p.ends_on   + "T23:59:59Z").getTime();
          data = data.filter((a) => {
            const t = new Date(a.created_at).getTime();
            return t >= startMs && t <= endMs;
          });
        }
      }
      setRows(data);
      setSelected(new Set());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadReps() {
    try {
      const r = await fetch("/api/internal/sales-reps?include_inactive=1&limit=500");
      if (!r.ok) return;
      const data = await r.json();
      setReps(Array.isArray(data) ? data : []);
    } catch { /* non-fatal */ }
  }
  async function loadPeriods() {
    try {
      const r = await fetch("/api/internal/gl-periods?limit=500");
      if (!r.ok) return;
      const data = await r.json();
      setPeriods(Array.isArray(data) ? data : []);
    } catch { /* non-fatal */ }
  }
  async function loadGlAccounts() {
    try {
      const r = await fetch("/api/internal/gl-accounts?limit=1000");
      if (!r.ok) return;
      const data = await r.json();
      setGlAccounts(Array.isArray(data) ? data : []);
    } catch { /* non-fatal */ }
  }

  useEffect(() => { loadReps(); loadPeriods(); loadGlAccounts(); }, []);
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => {
    const t = setTimeout(() => { load(); }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repFilter, statusFilter, periodFilter, periods.length]);

  const cashAccounts = useMemo(
    () => glAccounts.filter(isCashOrBank).sort((a, b) => a.code.localeCompare(b.code)),
    [glAccounts],
  );

  const accrualForId = useMemo(() => {
    const m = new Map<string, Accrual>();
    for (const r of rows) m.set(r.id, r);
    return m;
  }, [rows]);

  const accruedRows = rows.filter((r) => r.status === "accrued");

  // For bulk pay: gather selected accruals and group by (rep, period-by-date).
  const selectedAccruals = useMemo(
    () => Array.from(selected).map((id) => accrualForId.get(id)).filter(Boolean) as Accrual[],
    [selected, accrualForId],
  );

  // Validate that bulk selection is all the same rep & all "accrued".
  const bulkRepId = selectedAccruals[0]?.sales_rep_id || null;
  const bulkAllSameRep = selectedAccruals.length > 0 &&
                         selectedAccruals.every((a) => a.sales_rep_id === bulkRepId);
  const bulkAllAccrued = selectedAccruals.every((a) => a.status === "accrued");

  function toggleSelect(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    if (selected.size === accruedRows.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(accruedRows.map((r) => r.id)));
    }
  }

  const [activePayId, setActivePayId] = useState<string | null>(null);
  function openPayOne(id: string) {
    setActivePayId(id);
    setPayOpen(true);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14, gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: C.text }}>
          Commission Accruals
        </h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          AR-invoice-posting-time accruals + per-rep settle (M44)
        </span>
        <div style={{ flex: 1 }} />
        <ExportButton
          rows={rows.map((r) => ({
            invoice_number: r.ar_invoices?.invoice_number || null,
            sales_rep:      r.sales_reps?.display_name || null,
            accrual_date:   r.created_at,
            commissionable_cents: r.commissionable_cents,
            rate_pct:       r.rate_pct,
            commission_cents:     r.commission_cents,
            status:         r.status,
            paid_at:        r.paid_at,
            accrual_je_id:  r.accrual_je_id,
            payout_je_id:   r.payout_je_id,
          })) as unknown as Array<Record<string, unknown>>}
          filename="commission-accruals"
          sheetName="Commission Accruals"
          columns={[
            { key: "invoice_number",       header: "Invoice #" },
            { key: "sales_rep",            header: "Sales Rep" },
            { key: "accrual_date",         header: "Accrual Date", format: "datetime" },
            { key: "commissionable_cents", header: "Commissionable", format: "currency_cents" },
            { key: "rate_pct",             header: "Rate %",         format: "number", digits: 2 },
            { key: "commission_cents",     header: "Commission",     format: "currency_cents" },
            { key: "status",               header: "Status" },
            { key: "paid_at",              header: "Paid At", format: "datetime" },
            { key: "accrual_je_id",        header: "Accrual JE" },
            { key: "payout_je_id",         header: "Payout JE" },
          ]}
        />
        <TablePrefsButton
          tableKey={TABLE_KEY}
          columns={ALL_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
          onSetAll={setAllVisible}
        />
        {selected.size > 0 && (
          <button
            type="button"
            style={btnPrimary}
            onClick={() => {
              if (!bulkAllSameRep) {
                notify("Bulk pay requires all selected rows to belong to the same sales rep.", "error");
                return;
              }
              if (!bulkAllAccrued) {
                notify("Bulk pay only works on rows in status=accrued.", "error");
                return;
              }
              setBulkPayOpen(true);
            }}
          >
            Pay {selected.size} selected
          </button>
        )}
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ minWidth: 220 }}>
          <label style={labelStyle}>Sales rep</label>
          <SearchableSelect
            value={repFilter || null}
            onChange={(v) => setRepFilter(v)}
            options={[
              { value: "", label: "All reps" },
              ...reps.map((r) => ({
                value: r.id,
                label: `${r.display_name}${!r.is_active ? " (inactive)" : ""}`,
              })),
            ]}
            placeholder="All reps"
            inputStyle={inputStyle}
          />
        </div>
        <div style={{ minWidth: 160 }}>
          <label style={labelStyle}>Status</label>
          <SearchableSelect
            value={statusFilter || null}
            onChange={(v) => setStatusFilter(v)}
            options={[
              { value: "", label: "All" },
              ...STATUS_VALUES.map((s) => ({ value: s, label: s })),
            ]}
            placeholder="All"
            inputStyle={inputStyle}
          />
        </div>
        <div style={{ minWidth: 280 }}>
          <label style={labelStyle}>Period (by accrual date)</label>
          <SearchableSelect
            value={periodFilter || null}
            onChange={(v) => setPeriodFilter(v)}
            options={[
              { value: "", label: "All periods" },
              ...periods.map((p) => ({ value: p.id, label: periodLabel(p) })),
            ]}
            placeholder="All periods"
            inputStyle={inputStyle}
          />
        </div>
      </div>

      {err && (
        <div style={{
          background: "#7f1d1d", color: "#fecaca", padding: "8px 12px",
          borderRadius: 6, marginBottom: 12, fontSize: 13,
        }}>{err}</div>
      )}

      <div style={{
        background: C.card, border: `1px solid ${C.cardBdr}`,
        borderRadius: 8, overflow: "auto", maxHeight: "70vh",
      }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 30 }}>
                <input
                  type="checkbox"
                  checked={accruedRows.length > 0 && selected.size === accruedRows.length}
                  onChange={toggleSelectAll}
                />
              </th>
              <th style={th} hidden={!visibleColumns.has("invoice_number")}>Invoice #</th>
              <th style={th} hidden={!visibleColumns.has("sales_rep")}>Sales rep</th>
              <th style={th} hidden={!visibleColumns.has("accrual_date")}>Accrual date</th>
              <th style={{ ...th, textAlign: "right" }} hidden={!visibleColumns.has("commissionable")}>Commissionable</th>
              <th style={{ ...th, textAlign: "right" }} hidden={!visibleColumns.has("rate")}>Rate</th>
              <th style={{ ...th, textAlign: "right" }} hidden={!visibleColumns.has("commission")}>Commission</th>
              <th style={th} hidden={!visibleColumns.has("status")}>Status</th>
              <th style={th} hidden={!visibleColumns.has("accrual_je")}>Accrual JE</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td style={td} colSpan={10}>Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td style={td} colSpan={10}>No accruals match.</td></tr>
            )}
            {!loading && rows.map((r) => (
              <tr key={r.id}>
                <td style={td}>
                  {r.status === "accrued" && (
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggleSelect(r.id)}
                    />
                  )}
                </td>
                <td style={{ ...td, fontFamily: "monospace", fontSize: 12 }} hidden={!visibleColumns.has("invoice_number")}>
                  {r.ar_invoices?.invoice_number ? (
                    <a
                      href={`/tanda/ar-invoices/${r.ar_invoice_id}`}
                      onClick={(e) => e.stopPropagation()}
                      style={{ color: C.primary, textDecoration: "none" }}
                    >
                      {r.ar_invoices.invoice_number}
                    </a>
                  ) : "—"}
                </td>
                <td style={td} hidden={!visibleColumns.has("sales_rep")}>{r.sales_reps?.display_name || "—"}</td>
                <td style={{ ...td, fontSize: 11, color: C.textMuted }} hidden={!visibleColumns.has("accrual_date")}>
                  {fmtDate(r.created_at)}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "monospace" }} hidden={!visibleColumns.has("commissionable")}>
                  {fmtCurrencyFromCents(r.commissionable_cents)}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "monospace" }} hidden={!visibleColumns.has("rate")}>
                  {Number(r.rate_pct).toFixed(2)}%
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "monospace", fontWeight: 600 }} hidden={!visibleColumns.has("commission")}>
                  {fmtCurrencyFromCents(r.commission_cents)}
                </td>
                <td style={td} hidden={!visibleColumns.has("status")}>{statusPill(r.status)}</td>
                <td style={{ ...td, fontSize: 11, color: C.textMuted }} hidden={!visibleColumns.has("accrual_je")}>
                  {r.accrual_je_id ? "Posted" : "—"}
                </td>
                <td style={td}>
                  {r.status === "accrued" && (
                    <button type="button" onClick={() => openPayOne(r.id)} style={btnSuccess}>
                      Pay
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {payOpen && activePayId && (
        <SettleModal
          mode="single"
          repIdFixed={accrualForId.get(activePayId)?.sales_rep_id || ""}
          repName={accrualForId.get(activePayId)?.sales_reps?.display_name || ""}
          accrualSummary={(() => {
            const a = accrualForId.get(activePayId);
            return a ? { count: 1, totalCents: a.commission_cents } : { count: 0, totalCents: 0 };
          })()}
          reps={reps}
          periods={periods}
          cashAccounts={cashAccounts}
          onClose={() => { setPayOpen(false); setActivePayId(null); }}
          onSettled={() => { setPayOpen(false); setActivePayId(null); load(); }}
        />
      )}
      {bulkPayOpen && bulkRepId && (
        <SettleModal
          mode="bulk"
          repIdFixed={bulkRepId}
          repName={selectedAccruals[0]?.sales_reps?.display_name || ""}
          accrualSummary={{
            count: selectedAccruals.length,
            totalCents: selectedAccruals.reduce((s, a) => s + (a.commission_cents || 0), 0),
          }}
          reps={reps}
          periods={periods}
          cashAccounts={cashAccounts}
          onClose={() => setBulkPayOpen(false)}
          onSettled={() => { setBulkPayOpen(false); load(); }}
        />
      )}
    </div>
  );
}

function statusPill(status: Accrual["status"]) {
  const palette = {
    accrued:  { bg: "#1e3a8a", color: "#93c5fd" },
    reversed: { bg: "#374151", color: "#d1d5db" },
    paid:     { bg: "#064e3b", color: "#6ee7b7" },
  }[status];
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 10,
      background: palette.bg, color: palette.color, fontSize: 11, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: 0.5,
    }}>{status}</span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Settle modal — single or bulk
//
// Both modes hit POST /api/internal/commissions/settle, which is per-rep,
// per-period: a single call settles ALL accrued rows for the (rep, period)
// pair. That's why bulk requires same-rep upfront.
// ─────────────────────────────────────────────────────────────────────────────
function SettleModal({
  mode, repIdFixed, repName, accrualSummary,
  periods, cashAccounts, onClose, onSettled,
}: {
  mode: "single" | "bulk";
  repIdFixed: string;
  repName: string;
  accrualSummary: { count: number; totalCents: number };
  reps: RepLite[];
  periods: PeriodLite[];
  cashAccounts: GLAccountLite[];
  onClose: () => void;
  onSettled: () => void;
}) {
  const [periodId, setPeriodId] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<typeof PAYMENT_METHODS[number]>("check");
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [bankAccountId, setBankAccountId] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!periodId) { setErr("Pick a period."); return; }
    if (!bankAccountId) { setErr("Pick a bank/cash GL account."); return; }
    if (!paidAt) { setErr("Pick a paid date."); return; }
    setSaving(true);
    setErr(null);
    try {
      const author = getCachedAuthUserId();
      const r = await fetch("/api/internal/commissions/settle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sales_rep_id: repIdFixed,
          period_id: periodId,
          payment_method: paymentMethod,
          paid_at: paidAt,
          bank_account_id: bankAccountId,
          actor_user_id: author || null,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      onSettled();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const openPeriods = periods.filter((p) => p.status === "open" || p.status === "soft_closed" || p.status === "active");
  const visiblePeriods = openPeriods.length > 0 ? openPeriods : periods;

  return (
    <Modal
      onClose={onClose}
      title={mode === "single" ? "Pay commission accrual" : `Pay ${accrualSummary.count} accruals`}
    >
      <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4 }}>Sales rep</div>
        <div style={{ fontSize: 14, color: C.text, fontWeight: 600 }}>{repName || repIdFixed}</div>
        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6 }}>
          {accrualSummary.count} accrual{accrualSummary.count === 1 ? "" : "s"} · total commission{" "}
          <span style={{ color: C.text, fontFamily: "monospace" }}>
            {fmtCurrencyFromCents(accrualSummary.totalCents)}
          </span>
        </div>
        <div style={{ fontSize: 11, color: C.warn, marginTop: 6 }}>
          Note: the settle RPC pays <em>all</em> accrued rows for this rep + period —
          the count above is informational. The server is the source of truth.
        </div>
      </div>

      {err && (
        <div style={{
          background: "#7f1d1d", color: "#fecaca", padding: "8px 12px",
          borderRadius: 6, marginBottom: 12, fontSize: 13,
        }}>{err}</div>
      )}

      <Field label="Period *">
        <SearchableSelect
          value={periodId || null}
          onChange={(v) => setPeriodId(v)}
          options={[
            { value: "", label: "(pick a period)" },
            ...visiblePeriods.map((p) => ({ value: p.id, label: `${periodLabel(p)} — ${p.status}` })),
          ]}
          placeholder="(pick a period)"
          required
          inputStyle={inputStyle}
        />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Payment method *">
          <SearchableSelect
            value={paymentMethod}
            onChange={(v) => setPaymentMethod(v as typeof PAYMENT_METHODS[number])}
            options={PAYMENT_METHODS.map((m) => ({ value: m, label: m }))}
            required
            inputStyle={inputStyle}
          />
        </Field>
        <Field label="Paid at *">
          <input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} style={inputStyle} />
        </Field>
      </div>
      <Field label="Bank / cash GL account *">
        <SearchableSelect
          value={bankAccountId || null}
          onChange={(v) => setBankAccountId(v)}
          options={[
            { value: "", label: "(pick an account)" },
            ...(cashAccounts.length === 0
              ? [{ value: "__none", label: "No cash/bank accounts found. Add one in Chart of Accounts.", disabled: true }]
              : []),
            ...cashAccounts.map((a) => ({
              value: a.id,
              label: `${a.code} — ${a.name}${a.account_subtype ? ` (${a.account_subtype})` : ""}`,
              searchHaystack: `${a.code} ${a.name} ${a.account_subtype || ""}`,
            })),
          ]}
          placeholder="(pick an account)"
          required
          inputStyle={inputStyle}
        />
      </Field>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <button type="button" onClick={onClose} style={btnSecondary}>Cancel</button>
        <button type="button" onClick={submit} disabled={saving} style={btnPrimary}>
          {saving ? "Posting payout…" : "Post payout"}
        </button>
      </div>
    </Modal>
  );
}

function Modal({ title, children, onClose }: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card, border: `1px solid ${C.cardBdr}`,
          borderRadius: 10, width: "min(620px, 95vw)", maxHeight: "90vh",
          overflowY: "auto", boxSizing: "border-box", padding: 18,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 16, color: C.text }}>{title}</h2>
          <div style={{ flex: 1 }} />
          <button type="button" onClick={onClose} style={{ ...btnSecondary, padding: "4px 8px" }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}
