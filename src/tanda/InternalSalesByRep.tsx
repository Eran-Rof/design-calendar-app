// src/tanda/InternalSalesByRep.tsx
//
// Tangerine P7-7 — Sales by Rep × Period panel (Reports menu group).
// Reads /api/internal/sales-by-rep?from=YYYY-MM-DD&to=YYYY-MM-DD.

import { useEffect, useState } from "react";
import ExportButton from "./exports/ExportButton";

type Row = {
  sales_rep_id: string;
  sales_rep_name: string | null;
  invoice_count: number | string;
  gross_cents: number | string;
  commission_cents: number | string;
};

const C = {
  card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: `1px solid ${C.primary}`,
  padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};
const tdNum: React.CSSProperties = {
  ...td, textAlign: "right", fontVariantNumeric: "tabular-nums",
};

function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0);
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoMinusDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export default function InternalSalesByRep() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState<string>(isoMinusDays(90));
  const [toDate, setToDate] = useState<string>(todayISO());

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      params.set("from", fromDate);
      params.set("to", toDate);
      const r = await fetch(`/api/internal/sales-by-rep?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json();
      setRows((data.rows || []) as Row[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const totals = rows.reduce(
    (acc, r) => {
      acc.invoice_count += Number(r.invoice_count || 0);
      acc.gross += Number(r.gross_cents || 0);
      acc.commission += Number(r.commission_cents || 0);
      return acc;
    },
    { invoice_count: 0, gross: 0, commission: 0 },
  );

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Sales by Rep</h2>
        <div style={{ fontSize: 11, color: C.textMuted }}>
          {rows.length} rep{rows.length === 1 ? "" : "s"}
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          From
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ ...inputStyle, width: 160 }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
          To
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ ...inputStyle, width: 160 }} />
        </label>
        <button onClick={() => void load()} style={btnPrimary} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
        <ExportButton
          rows={rows as unknown as Array<Record<string, unknown>>}
          filename="sales-by-rep"
          sheetName="Sales by Rep"
          columns={[
            { key: "sales_rep_name",   header: "Sales Rep" },
            { key: "invoice_count",    header: "Invoices",   format: "number" },
            { key: "gross_cents",      header: "Gross",      format: "currency_cents" },
            { key: "commission_cents", header: "Commission", format: "currency_cents" },
          ]}
        />
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, maxHeight: "calc(100vh - 280px)", overflowY: "auto" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            No sales-rep activity between {fromDate} and {toDate}.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Sales Rep</th>
                <th style={{ ...th, textAlign: "right" }}>Invoices</th>
                <th style={{ ...th, textAlign: "right" }}>Gross</th>
                <th style={{ ...th, textAlign: "right" }}>Commission</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sales_rep_id}>
                  <td style={td}>
                    <strong>{r.sales_rep_name || r.sales_rep_id}</strong>
                  </td>
                  <td style={tdNum}>{r.invoice_count}</td>
                  <td style={tdNum}>{fmtCents(r.gross_cents)}</td>
                  <td style={tdNum}>{fmtCents(r.commission_cents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: "#111827" }}>
                <td style={{ ...td, fontWeight: 700, color: C.textSub }}>TOTAL</td>
                <td style={{ ...tdNum, fontWeight: 700 }}>{totals.invoice_count}</td>
                <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(totals.gross)}</td>
                <td style={{ ...tdNum, fontWeight: 700 }}>{fmtCents(totals.commission)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}
