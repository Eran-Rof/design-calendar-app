// src/tanda/InternalAPPayments.tsx
//
// Tangerine P3 Chunk 2 — read-only AP payments ledger. Lists invoice_payments
// with method/date filters. Writes happen via /api/internal/ap-invoices/:id/pay
// (the AP Invoice panel) — this is for accountant review only.

import { useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import SearchableSelect from "./components/SearchableSelect";
import type { ExportColumn } from "./exports/useTableExport";
import DateRangePresets from "./components/DateRangePresets.tsx";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "./components/TablePrefs";
import JEDetailModal from "./components/JEDetailModal";

const TABLE_KEY = "tanda.ap_payments";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "date",      label: "Date" },
  { key: "invoice",   label: "Invoice" },
  { key: "vendor",    label: "Vendor" },
  { key: "amount",    label: "Amount" },
  { key: "method",    label: "Method" },
  { key: "bank",      label: "Bank" },
  { key: "reference", label: "Reference" },
  { key: "cash_je",   label: "Cash JE" },
];

type APPayment = {
  id: string;
  entity_id: string;
  invoice_id: string;
  payment_date: string;
  amount_cents: string;
  bank_account_id: string;
  method: string;
  reference: string | null;
  cash_je_id: string | null;
  notes: string | null;
  created_at: string;
};

type Invoice = { id: string; invoice_number: string; vendor_id: string };
type Vendor = { id: string; name: string };
type Account = { id: string; code: string; name: string };

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981",
};

const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
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
  color: C.text, fontSize: 13,
};

function fmtCents(c: string | number | null | undefined): string {
  if (c == null) return "$0.00";
  const bi = typeof c === "bigint" ? c : BigInt(String(c).replace(/[^-0-9]/g, "") || "0");
  const neg = bi < 0n;
  const abs = neg ? -bi : bi;
  const whole = (abs / 100n).toString();
  const frac = (abs % 100n).toString().padStart(2, "0");
  const w = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${w}.${frac}`;
}

export default function InternalAPPayments() {
  const [rows, setRows] = useState<APPayment[]>([]);
  // Drill-through: payment → its cash journal entry.
  const [jeSeed, setJeSeed] = useState<{ id: string } | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [method, setMethod] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams({ limit: "200" });
      if (method) params.set("method", method);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const r = await fetch(`/api/internal/ap-payments?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as APPayment[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [method, from, to]);

  useEffect(() => {
    fetch("/api/internal/ap-invoices?limit=500&include_void=true")
      .then((r) => r.json())
      .then((arr: Invoice[]) => Array.isArray(arr) && setInvoices(arr))
      .catch(() => {});
    fetch("/api/internal/vendors")
      .then((r) => r.json())
      .then((arr: Vendor[]) => Array.isArray(arr) && setVendors(arr))
      .catch(() => {});
    fetch("/api/internal/gl-accounts?limit=1000")
      .then((r) => r.json())
      .then((arr: Account[]) => Array.isArray(arr) && setAccounts(arr))
      .catch(() => {});
  }, []);

  const invMap = useMemo(() => {
    const m: Record<string, Invoice> = {};
    for (const i of invoices) m[i.id] = i;
    return m;
  }, [invoices]);
  const vendorMap = useMemo(() => {
    const m: Record<string, Vendor> = {};
    for (const v of vendors) m[v.id] = v;
    return m;
  }, [vendors]);
  const acctMap = useMemo(() => {
    const m: Record<string, Account> = {};
    for (const a of accounts) m[a.id] = a;
    return m;
  }, [accounts]);

  const totalCents = useMemo(() => {
    let total = 0n;
    for (const r of rows) total += BigInt(r.amount_cents || "0");
    return total;
  }, [rows]);

  return (
    <div style={{ color: C.text }}>
      <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>AP Payments (ledger)</h2>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ width: 160 }}>
          <SearchableSelect
            value={method || null}
            onChange={(v) => setMethod(v)}
            options={[
              { value: "", label: "All methods" },
              { value: "ach", label: "ACH" },
              { value: "wire", label: "Wire" },
              { value: "check", label: "Check" },
              { value: "credit_card", label: "Credit card" },
              { value: "cash", label: "Cash" },
            ]}
            placeholder="All methods"
            inputStyle={inputStyle}
          />
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          From&nbsp;
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ ...inputStyle, width: 150 }} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          To&nbsp;
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ ...inputStyle, width: 150 }} />
        </label>
        <DateRangePresets variant="dropdown"
          from={from}
          to={to}
          onChange={(f, t) => { setFrom(f); setTo(t); }}
        />
        <button onClick={() => void load()} style={btnSecondary}>Reload</button>
        <ExportButton
          rows={rows.map((p) => {
            const inv = invMap[p.invoice_id];
            const vendor = inv && vendorMap[inv.vendor_id];
            const bank = acctMap[p.bank_account_id];
            return {
              payment_date: p.payment_date,
              invoice_number: inv?.invoice_number || p.invoice_id,
              vendor: vendor?.name || "",
              amount_cents: p.amount_cents,
              method: p.method,
              bank: bank ? `${bank.code} — ${bank.name}` : p.bank_account_id,
              reference: p.reference,
              cash_je_id: p.cash_je_id,
              notes: p.notes,
            };
          }) as unknown as Array<Record<string, unknown>>}
          filename="ap-payments"
          sheetName="AP Payments"
          columns={[
            { key: "payment_date",   header: "Date",     format: "date" },
            { key: "invoice_number", header: "Invoice" },
            { key: "vendor",         header: "Vendor" },
            { key: "amount_cents",   header: "Amount",   format: "currency_cents" },
            { key: "method",         header: "Method" },
            { key: "bank",           header: "Bank" },
            { key: "reference",      header: "Reference" },
            { key: "cash_je_id",     header: "Cash JE" },
            { key: "notes",          header: "Notes" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
        <TablePrefsButton
          tableKey={TABLE_KEY}
          columns={ALL_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
          onSetAll={setAllVisible}
        />
        <div style={{ marginLeft: "auto", fontSize: 12, color: C.textMuted }}>
          Total this view: <strong style={{ color: C.text, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{fmtCents(totalCents.toString())}</strong>
        </div>
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No payments recorded yet.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th} hidden={!visibleColumns.has("date")}>Date</th>
                <th style={th} hidden={!visibleColumns.has("invoice")}>Invoice</th>
                <th style={th} hidden={!visibleColumns.has("vendor")}>Vendor</th>
                <th style={{ ...th, textAlign: "right" }} hidden={!visibleColumns.has("amount")}>Amount</th>
                <th style={th} hidden={!visibleColumns.has("method")}>Method</th>
                <th style={th} hidden={!visibleColumns.has("bank")}>Bank</th>
                <th style={th} hidden={!visibleColumns.has("reference")}>Reference</th>
                <th style={th} hidden={!visibleColumns.has("cash_je")}>Cash JE</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const inv = invMap[p.invoice_id];
                const vendor = inv && vendorMap[inv.vendor_id];
                const bank = acctMap[p.bank_account_id];
                return (
                  <tr key={p.id}>
                    <td style={td} hidden={!visibleColumns.has("date")}>{p.payment_date}</td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }} hidden={!visibleColumns.has("invoice")}>
                      {inv?.invoice_number || "—"}
                    </td>
                    <td style={td} hidden={!visibleColumns.has("vendor")}>{vendor?.name || "—"}</td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }} hidden={!visibleColumns.has("amount")}>
                      {fmtCents(p.amount_cents)}
                    </td>
                    <td style={td} hidden={!visibleColumns.has("method")}>{p.method}</td>
                    <td style={{ ...td, fontSize: 12, color: C.textSub }} hidden={!visibleColumns.has("bank")}>
                      {bank ? `${bank.code} — ${bank.name}` : <span style={{ color: C.textMuted }}>—</span>}
                    </td>
                    <td style={{ ...td, fontSize: 12, color: C.textSub }} hidden={!visibleColumns.has("reference")}>{p.reference || "—"}</td>
                    <td style={{ ...td, fontSize: 11, color: p.cash_je_id ? C.success : C.textMuted }} hidden={!visibleColumns.has("cash_je")}>
                      {p.cash_je_id
                        ? <button type="button"
                            onClick={(e) => { e.stopPropagation(); setJeSeed({ id: p.cash_je_id as string }); }}
                            title="Open the journal entry this payment posted"
                            style={{ background: "transparent", border: "none", color: C.success, cursor: "pointer", padding: 0, fontSize: 11, textDecoration: "underline" }}>
                            ✓ posted ↗
                          </button>
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {jeSeed && (
        <JEDetailModal je={jeSeed} onClose={() => setJeSeed(null)} onReversed={() => setJeSeed(null)} />
      )}
    </div>
  );
}
