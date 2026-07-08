// src/tanda/InternalSalesByCustomer.tsx
//
// Tangerine P7-7 — Sales by Customer × Period panel (Reports menu group).
// Reads /api/internal/sales-by-customer?from=YYYY-MM-DD&to=YYYY-MM-DD.

import { useEffect, useState } from "react";
import { useSeqGuard } from "./hooks/useSeqGuard";
import ExportButton from "./exports/ExportButton";
import DateRangePresets from "./components/DateRangePresets.tsx";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";

// Universal column-visibility registry for this panel (operator ask #1).
const SALES_BY_CUSTOMER_TABLE_KEY = "tangerine:salesbycustomer:columns";
const SALES_BY_CUSTOMER_COLUMNS: ColumnDef[] = [
  { key: "customer",     label: "Customer" },
  { key: "invoices",     label: "Invoices" },
  { key: "gross",        label: "Gross" },
  { key: "credit_memos", label: "Credit Memos" },
  { key: "net",          label: "Net" },
];

type Row = {
  customer_id: string;
  customer_name: string | null;
  customer_code: string | null;
  invoice_count: number | string;
  gross_cents: number | string;
  credit_memo_cents: number | string;
  net_cents: number | string;
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

export default function InternalSalesByCustomer() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState<string>(isoMinusDays(90));
  const [toDate, setToDate] = useState<string>(todayISO());
  const [filter, setFilter] = useState<string>("");

  // Wave 5 — universal column show/hide.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    SALES_BY_CUSTOMER_TABLE_KEY,
    SALES_BY_CUSTOMER_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  // Fetch-race guard: only the latest load()'s result may be applied.
  const seqGuard = useSeqGuard();

  async function load() {
    const seq = seqGuard.begin();
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      params.set("from", fromDate);
      params.set("to", toDate);
      const r = await fetch(`/api/internal/sales-by-customer?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json();
      if (!seqGuard.isCurrent(seq)) return; // superseded by a newer load — drop stale result
      setRows((data.rows || []) as Row[]);
    } catch (e: unknown) {
      if (seqGuard.isCurrent(seq)) {
        setErr(e instanceof Error ? e.message : String(e));
        setRows([]);
      }
    } finally {
      if (seqGuard.isCurrent(seq)) setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const filtered = filter.trim()
    ? rows.filter((r) =>
        (r.customer_name || "").toLowerCase().includes(filter.trim().toLowerCase()) ||
        (r.customer_code || "").toLowerCase().includes(filter.trim().toLowerCase()),
      )
    : rows;

  const totals = filtered.reduce(
    (acc, r) => {
      acc.invoice_count += Number(r.invoice_count || 0);
      acc.gross += Number(r.gross_cents || 0);
      acc.credit_memo += Number(r.credit_memo_cents || 0);
      acc.net += Number(r.net_cents || 0);
      return acc;
    },
    { invoice_count: 0, gross: 0, credit_memo: 0, net: 0 },
  );

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Sales by Customer</h2>
        <div style={{ fontSize: 11, color: C.textMuted }}>
          {filtered.length} customer{filtered.length === 1 ? "" : "s"}
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
        <DateRangePresets variant="dropdown"
          from={fromDate}
          to={toDate}
          onChange={(f, t) => { setFromDate(f); setToDate(t); }}
        />
        <button onClick={() => void load()} style={btnPrimary} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
        <input
          type="text"
          placeholder="Filter customer name or code…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ ...inputStyle, maxWidth: 320 }}
        />
        <TablePrefsButton
          tableKey={SALES_BY_CUSTOMER_TABLE_KEY}
          columns={SALES_BY_CUSTOMER_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
        />
        <ExportButton
          rows={filtered as unknown as Array<Record<string, unknown>>}
          filename="sales-by-customer"
          sheetName="Sales by Customer"
          columns={[
            { key: "customer_name",     header: "Customer" },
            { key: "customer_code",     header: "Code" },
            { key: "invoice_count",     header: "Invoices",     format: "number" },
            { key: "gross_cents",       header: "Gross",        format: "currency_cents" },
            { key: "credit_memo_cents", header: "Credit Memos", format: "currency_cents" },
            { key: "net_cents",         header: "Net",          format: "currency_cents" },
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
        ) : filtered.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            No customer activity between {fromDate} and {toDate}.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th} hidden={!isVisible("customer")}>Customer</th>
                <th style={{ ...th, textAlign: "right" }} hidden={!isVisible("invoices")}>Invoices</th>
                <th style={{ ...th, textAlign: "right" }} hidden={!isVisible("gross")}>Gross</th>
                <th style={{ ...th, textAlign: "right" }} hidden={!isVisible("credit_memos")}>Credit Memos</th>
                <th style={{ ...th, textAlign: "right" }} hidden={!isVisible("net")}>Net</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.customer_id}>
                  <td style={td} hidden={!isVisible("customer")}>
                    <strong>{r.customer_name || r.customer_code || r.customer_id}</strong>
                    {r.customer_code && r.customer_name && (
                      <span style={{ color: C.textMuted, marginLeft: 6, fontSize: 11 }}>({r.customer_code})</span>
                    )}
                  </td>
                  <td style={tdNum} hidden={!isVisible("invoices")}>{r.invoice_count}</td>
                  <td style={tdNum} hidden={!isVisible("gross")}>{fmtCents(r.gross_cents)}</td>
                  <td style={tdNum} hidden={!isVisible("credit_memos")}>{fmtCents(r.credit_memo_cents)}</td>
                  <td style={{ ...tdNum, fontWeight: 700 }} hidden={!isVisible("net")}>{fmtCents(r.net_cents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: "#111827" }}>
                <td style={{ ...td, fontWeight: 700, color: C.textSub }} hidden={!isVisible("customer")}>TOTAL ({filtered.length})</td>
                <td style={{ ...tdNum, fontWeight: 700 }} hidden={!isVisible("invoices")}>{totals.invoice_count}</td>
                <td style={{ ...tdNum, fontWeight: 700 }} hidden={!isVisible("gross")}>{fmtCents(totals.gross)}</td>
                <td style={{ ...tdNum, fontWeight: 700 }} hidden={!isVisible("credit_memos")}>{fmtCents(totals.credit_memo)}</td>
                <td style={{ ...tdNum, fontWeight: 700 }} hidden={!isVisible("net")}>{fmtCents(totals.net)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}
