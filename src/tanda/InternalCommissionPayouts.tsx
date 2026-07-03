// src/tanda/InternalCommissionPayouts.tsx
//
// Tangerine P7-6 — Commission Payouts history admin panel (arch §4.4).
// Read-only list with filters (sales_rep_id, period_id, paid_at date range).
// Clickable JE id links to the journal entry detail.
//
// Hits: GET /api/internal/commissions/payouts, GET /api/internal/sales-reps,
//       GET /api/internal/gl-periods.

import { useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import DateRangePresets from "./components/DateRangePresets";
import SearchableSelect from "./components/SearchableSelect";
import { fmtDateDisplay } from "../utils/tandaTypes";

type Payout = {
  id: string;
  entity_id: string;
  sales_rep_id: string;
  period_id: string;
  total_cents: number;
  payment_method: "check" | "wire" | "ach" | "cash" | "other";
  paid_at: string;
  payout_je_id: string | null;
  notes: string | null;
  created_at: string;
  sales_reps?: { display_name: string } | null;
  gl_periods?: { fiscal_year: number; period_number: number; ends_on: string } | null;
};

type RepLite = { id: string; display_name: string; is_active: boolean };
type PeriodLite = { id: string; fiscal_year: number; period_number: number; starts_on: string; ends_on: string; status: string };

const C = {
  bg: "#0F172A",
  card: "#1E293B",
  cardBdr: "#334155",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  textSub: "#CBD5E1",
  primary: "#3B82F6",
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
function periodLabel(p: PeriodLite): string {
  return `FY${p.fiscal_year} P${String(p.period_number).padStart(2, "0")}`;
}

export default function InternalCommissionPayouts() {
  const [rows, setRows] = useState<Payout[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [repFilter, setRepFilter] = useState("");
  const [periodFilter, setPeriodFilter] = useState("");
  const [paidFrom, setPaidFrom] = useState("");
  const [paidTo, setPaidTo] = useState("");

  const [reps, setReps] = useState<RepLite[]>([]);
  const [periods, setPeriods] = useState<PeriodLite[]>([]);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (repFilter)    params.set("sales_rep_id", repFilter);
      if (periodFilter) params.set("period_id", periodFilter);
      const r = await fetch(`/api/internal/commissions/payouts?${params.toString()}`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      let data: Payout[] = await r.json();
      if (!Array.isArray(data)) data = [];
      // Client-side date range filter on paid_at (server endpoint doesn't
      // accept date params in P7-5).
      if (paidFrom) data = data.filter((p) => (p.paid_at || "") >= paidFrom);
      if (paidTo)   data = data.filter((p) => (p.paid_at || "") <= paidTo);
      setRows(data);
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

  useEffect(() => { loadReps(); loadPeriods(); }, []);
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => {
    const t = setTimeout(() => { load(); }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repFilter, periodFilter, paidFrom, paidTo]);

  const totalCents = useMemo(
    () => rows.reduce((s, r) => s + (Number(r.total_cents) || 0), 0),
    [rows],
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14, gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: C.text }}>
          Commission Payouts
        </h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          Posted payout history (M44)
        </span>
        <div style={{ flex: 1 }} />
        <ExportButton
          rows={rows.map((r) => ({
            paid_at:        r.paid_at,
            sales_rep:      r.sales_reps?.display_name || null,
            period:         r.gl_periods ? periodLabel({ ...r.gl_periods, id: r.period_id, starts_on: "", status: "" } as PeriodLite) : null,
            total_cents:    r.total_cents,
            payment_method: r.payment_method,
            payout_je_id:   r.payout_je_id,
            notes:          r.notes,
            created_at:     r.created_at,
          })) as unknown as Array<Record<string, unknown>>}
          filename="commission-payouts"
          sheetName="Commission Payouts"
          columns={[
            { key: "paid_at",        header: "Paid At", format: "date" },
            { key: "sales_rep",      header: "Sales Rep" },
            { key: "period",         header: "Period" },
            { key: "total_cents",    header: "Total", format: "currency_cents" },
            { key: "payment_method", header: "Method" },
            { key: "payout_je_id",   header: "Payout JE" },
            { key: "notes",          header: "Notes" },
            { key: "created_at",     header: "Posted", format: "datetime" },
          ]}
        />
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
        <div style={{ minWidth: 280 }}>
          <label style={labelStyle}>Period</label>
          <SearchableSelect
            value={periodFilter || null}
            onChange={(v) => setPeriodFilter(v)}
            options={[
              { value: "", label: "All periods" },
              ...periods.map((p) => ({
                value: p.id,
                label: `FY${p.fiscal_year} P${String(p.period_number).padStart(2, "0")} (${p.starts_on} → ${p.ends_on})`,
              })),
            ]}
            placeholder="All periods"
            inputStyle={inputStyle}
          />
        </div>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <DateRangePresets variant="dropdown" from={paidFrom} to={paidTo} onChange={(f, t) => { setPaidFrom(f); setPaidTo(t); }} />
        </div>
        <div style={{ minWidth: 140 }}>
          <label style={labelStyle}>Paid from</label>
          <input type="date" value={paidFrom} onChange={(e) => setPaidFrom(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ minWidth: 140 }}>
          <label style={labelStyle}>Paid to</label>
          <input type="date" value={paidTo} onChange={(e) => setPaidTo(e.target.value)} style={inputStyle} />
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
              <th style={th}>Paid at</th>
              <th style={th}>Sales rep</th>
              <th style={th}>Period</th>
              <th style={{ ...th, textAlign: "right" }}>Total</th>
              <th style={th}>Method</th>
              <th style={th}>Payout JE</th>
              <th style={th}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td style={td} colSpan={7}>Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td style={td} colSpan={7}>No payouts match.</td></tr>
            )}
            {!loading && rows.map((r) => (
              <tr key={r.id}>
                <td style={td}>{fmtDate(r.paid_at)}</td>
                <td style={td}>{r.sales_reps?.display_name || "—"}</td>
                <td style={td}>
                  {r.gl_periods
                    ? `FY${r.gl_periods.fiscal_year} P${String(r.gl_periods.period_number).padStart(2, "0")}`
                    : "—"}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "monospace", fontWeight: 600 }}>
                  {fmtCurrencyFromCents(r.total_cents)}
                </td>
                <td style={td}>
                  <span style={{
                    display: "inline-block", padding: "2px 8px", borderRadius: 10,
                    background: "#0b1220", border: `1px solid ${C.cardBdr}`,
                    color: C.textSub, fontSize: 11, fontWeight: 600,
                    textTransform: "uppercase", letterSpacing: 0.5,
                  }}>{r.payment_method}</span>
                </td>
                <td style={{ ...td, fontSize: 11 }}>
                  {r.payout_je_id ? (
                    <a
                      href={`/tanda/journal-entries/${r.payout_je_id}`}
                      style={{ color: C.primary, textDecoration: "none" }}
                    >
                      View JE
                    </a>
                  ) : "—"}
                </td>
                <td style={{ ...td, fontSize: 12, color: C.textSub }}>
                  {r.notes || "—"}
                </td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr>
                <td style={{ ...td, background: "#0b1220", fontWeight: 600 }} colSpan={3}>
                  Totals ({rows.length} payout{rows.length === 1 ? "" : "s"})
                </td>
                <td style={{ ...td, background: "#0b1220", textAlign: "right", fontFamily: "monospace", fontWeight: 600 }}>
                  {fmtCurrencyFromCents(totalCents)}
                </td>
                <td style={{ ...td, background: "#0b1220" }} colSpan={3} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
