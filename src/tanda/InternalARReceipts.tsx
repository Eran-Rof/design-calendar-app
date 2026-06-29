// src/tanda/InternalARReceipts.tsx
//
// Tangerine P4-5 — AR Receipts admin UI.
//
// What this panel does:
//   - List ar_receipts (filters: customer, method, date range, include-void, limit).
//   - Add modal: collect header + sub-table for applying to invoices.
//     On customer pick, fetches the customer's open AR invoices (gl_status in
//     sent/partial_paid + balance > 0) ordered by due_date ASC. Operator can
//     check rows + override amounts. Live sum must stay ≤ receipt amount.
//     amount_cents > sum(applications) is allowed (creates an unapplied receipt).
//   - Detail/edit modal: header form + applications table (× to unapply per
//     row when not yet posted) + Post and Void buttons. DocumentAttachmentList
//     drop-in for ar_receipts.
//
// All money handled in BigInt cents.

import { useEffect, useMemo, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import DocumentAttachmentList from "../shared/documents/DocumentAttachmentList";
import ExportButton from "./exports/ExportButton";
import DateRangePresets from "./components/DateRangePresets.tsx";
import type { ExportColumn } from "./exports/useTableExport";
import SourceBadge, { SOURCE_OPTIONS } from "./components/SourceBadge";
import SearchableSelect from "./components/SearchableSelect";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "./components/TablePrefs";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";

const TABLE_KEY = "tanda.ar_receipts";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "date",      label: "Date" },
  { key: "customer",  label: "Customer" },
  { key: "amount",    label: "Amount" },
  { key: "applied",   label: "Applied" },
  { key: "unapplied", label: "Unapplied" },
  { key: "method",    label: "Method" },
  { key: "bank",      label: "Bank" },
  { key: "status",    label: "Status" },
];

type ARReceipt = {
  id: string;
  entity_id: string;
  customer_id: string;
  receipt_date: string;
  amount_cents: string;
  bank_account_id: string;
  customer_payment_method: string;
  reference: string | null;
  notes: string | null;
  accrual_je_id: string | null;
  cash_je_id: string | null;
  is_void: boolean;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
  updated_at: string;
  applied_cents?: string;
  unapplied_cents?: string;
  source?: string | null;
};

type ARApplication = {
  id: string;
  ar_invoice_id: string;
  amount_applied_cents: string;
  applied_at: string;
  notes: string | null;
  ar_invoices?: {
    id: string;
    invoice_number: string;
    customer_id: string;
    total_amount_cents: string;
    paid_amount_cents: string;
    gl_status: string;
  };
};

type Customer = { id: string; code: string; name: string };
type Account = { id: string; code: string; name: string };
type OpenInvoice = {
  id: string;
  invoice_number: string;
  customer_id: string;
  total_amount_cents: string;
  paid_amount_cents: string;
  gl_status: string;
  due_date: string | null;
  posting_date: string;
};

const METHODS = ["ach", "wire", "check", "credit_card", "cash", "paypal", "stripe", "other"];

const C = {
  bg: "#0F172A",
  card: "#1E293B",
  cardBdr: "#334155",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  textSub: "#CBD5E1",
  primary: "#3B82F6",
  success: "#10B981",
  warn: "#F59E0B",
  danger: "#EF4444",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: "none",
  padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13,
  fontWeight: 500,
};
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const btnDanger: React.CSSProperties = {
  background: "#7f1d1d", color: "white", border: "none",
  padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12,
  fontWeight: 500,
};
const btnWarn: React.CSSProperties = {
  background: C.warn, color: "#1f1300", border: "none",
  padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12,
  fontWeight: 600,
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
const modalBackdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)",
  display: "flex", alignItems: "flex-start", justifyContent: "center",
  zIndex: 100, padding: "40px 20px", overflowY: "auto",
};
const modalContent: React.CSSProperties = {
  background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10,
  padding: 24, width: "min(880px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box",
};

function fmtCents(c: string | number | bigint | null | undefined): string {
  if (c == null) return "$0.00";
  const bi = typeof c === "bigint" ? c : BigInt(String(c).replace(/[^-0-9]/g, "") || "0");
  const neg = bi < 0n;
  const abs = neg ? -bi : bi;
  const whole = (abs / 100n).toString();
  const frac = (abs % 100n).toString().padStart(2, "0");
  const w = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${w}.${frac}`;
}

function parseCentsInput(s: string): bigint | null {
  // Accept "12.50" or "1250" (assume cents when no decimal).
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (/^\d+\.\d{1,2}$/.test(trimmed)) {
    const [w, f] = trimmed.split(".");
    return BigInt(w) * 100n + BigInt(f.padEnd(2, "0"));
  }
  if (/^\d+$/.test(trimmed)) return BigInt(trimmed) * 100n;
  return null;
}

function statusLabel(r: ARReceipt): { label: string; color: string } {
  if (r.is_void) return { label: "Voided", color: C.danger };
  if (r.accrual_je_id) return { label: "Posted", color: C.success };
  return { label: "Draft", color: C.textMuted };
}

export default function InternalARReceipts() {
  const [rows, setRows] = useState<ARReceipt[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [customerFilter, setCustomerFilter] = useState("");
  const [method, setMethod] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [includeVoid, setIncludeVoid] = useState(false);
  const [limit, setLimit] = useState(100);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  const { getRowProps } = useRowClickEdit<ARReceipt>({
    onRowClick: (r) => setDetailId(r.id),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: "Open receipt detail",
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (customerFilter) params.set("customer_id", customerFilter);
      if (method) params.set("method", method);
      if (sourceFilter) params.set("source", sourceFilter);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (includeVoid) params.set("include_void", "true");
      const r = await fetch(`/api/internal/ar-receipts?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows((await r.json()) as ARReceipt[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [customerFilter, method, sourceFilter, from, to, includeVoid, limit]);

  useEffect(() => {
    fetch("/api/internal/customer-master")
      .then((r) => r.json())
      .then((arr: Customer[]) => Array.isArray(arr) && setCustomers(arr))
      .catch(() => {});
    fetch("/api/internal/gl-accounts?limit=1000")
      .then((r) => r.json())
      .then((arr: Account[]) => Array.isArray(arr) && setAccounts(arr))
      .catch(() => {});
  }, []);

  const customerMap = useMemo(() => {
    const m: Record<string, Customer> = {};
    for (const c of customers) m[c.id] = c;
    return m;
  }, [customers]);
  const accountMap = useMemo(() => {
    const m: Record<string, Account> = {};
    for (const a of accounts) m[a.id] = a;
    return m;
  }, [accounts]);

  const totalCents = useMemo(() => {
    let t = 0n;
    for (const r of rows) {
      if (!r.is_void) t += BigInt(r.amount_cents || "0");
    }
    return t;
  }, [rows]);

  // #5 Sortable columns.
  const { sorted: sortedRows, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:arreceipts:sort",
    accessors: {
      date: (r) => r.receipt_date,
      customer: (r) => { const c = customerMap[r.customer_id]; return c ? (c.code ? `${c.code} ${c.name}` : c.name) : r.customer_id; },
      amount: (r) => Number(r.amount_cents || "0"),
      applied: (r) => Number(r.applied_cents || "0"),
      unapplied: (r) => Number(r.unapplied_cents || "0"),
      method: (r) => r.customer_payment_method,
      bank: (r) => { const b = accountMap[r.bank_account_id]; return b ? `${b.code} ${b.name}` : r.bank_account_id; },
      status: (r) => statusLabel(r).label,
    },
  });

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>AR Receipts</h2>
        <span style={{ fontSize: 12, color: C.textMuted }}>Customer payments + applications</span>
        <button style={{ ...btnPrimary, marginLeft: "auto" }} onClick={() => setAddOpen(true)}>
          + Add Receipt
        </button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ width: 220 }}>
          <SearchableSelect
            value={customerFilter || null}
            onChange={(v) => setCustomerFilter(v)}
            options={[
              { value: "", label: "All customers" },
              ...customers.map((c) => ({ value: c.id, label: c.code ? `${c.code} — ${c.name}` : c.name })),
            ]}
            placeholder="All customers"
          />
        </div>
        <div style={{ width: 160 }}>
          <SearchableSelect
            value={method || null}
            onChange={(v) => setMethod(v)}
            options={[
              { value: "", label: "All methods" },
              ...METHODS.map((m) => ({ value: m, label: m })),
            ]}
            placeholder="All methods"
          />
        </div>
        <div style={{ width: 150 }} title="Filter by row source — manual entries vs mirrored from Xoro / future integrations">
          <SearchableSelect
            value={sourceFilter || null}
            onChange={(v) => setSourceFilter(v)}
            options={[
              { value: "", label: "All sources" },
              ...SOURCE_OPTIONS.map((s) => ({ value: s, label: s })),
            ]}
            placeholder="All sources"
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
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input
            type="checkbox"
            checked={includeVoid}
            onChange={(e) => setIncludeVoid(e.target.checked)}
            style={{ accentColor: C.primary }}
          />
          Include voided
        </label>
        <div style={{ width: 100 }}>
          <SearchableSelect
            value={String(limit)}
            onChange={(v) => setLimit(Number(v) || 100)}
            options={[
              { value: "50", label: "50" },
              { value: "100", label: "100" },
              { value: "250", label: "250" },
              { value: "500", label: "500" },
            ]}
          />
        </div>
        <button onClick={() => void load()} style={btnSecondary}>Reload</button>
        <ExportButton
          // #23 Export totals — base rows + a trailing Totals row that mirrors
          // the on-screen "Active total" (non-void amount) and sums applied /
          // unapplied across the exported set.
          rows={(() => {
            const base = rows.map((r) => {
              const cust = customerMap[r.customer_id];
              const bank = accountMap[r.bank_account_id];
              return {
                receipt_date: r.receipt_date,
                customer: cust ? (cust.code ? `${cust.code} — ${cust.name}` : cust.name) : r.customer_id,
                amount_cents: r.amount_cents,
                applied_cents: r.applied_cents || "0",
                unapplied_cents: r.unapplied_cents || "0",
                method: r.customer_payment_method,
                bank: bank ? `${bank.code} — ${bank.name}` : r.bank_account_id,
                reference: r.reference,
                notes: r.notes,
                status: statusLabel(r).label,
                source: r.source || "manual",
              };
            });
            let appliedTot = 0n, unappliedTot = 0n;
            for (const r of rows) {
              appliedTot += BigInt(r.applied_cents || "0");
              unappliedTot += BigInt(r.unapplied_cents || "0");
            }
            return [
              ...base,
              {
                receipt_date: "",
                customer: "TOTAL (active)",
                amount_cents: totalCents.toString(),
                applied_cents: appliedTot.toString(),
                unapplied_cents: unappliedTot.toString(),
                method: "",
                bank: "",
                reference: null,
                notes: null,
                status: "",
                source: "",
              },
            ];
          })() as unknown as Array<Record<string, unknown>>}
          filename="ar-receipts"
          sheetName="AR Receipts"
          columns={[
            { key: "receipt_date",    header: "Date",      format: "date" },
            { key: "customer",        header: "Customer" },
            { key: "amount_cents",    header: "Amount",    format: "currency_cents" },
            { key: "applied_cents",   header: "Applied",   format: "currency_cents" },
            { key: "unapplied_cents", header: "Unapplied", format: "currency_cents" },
            { key: "method",          header: "Method" },
            { key: "bank",            header: "Bank" },
            { key: "reference",       header: "Reference" },
            { key: "notes",           header: "Notes" },
            { key: "status",          header: "Status" },
            { key: "source",          header: "Source" },
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
          Active total: <strong style={{ color: C.text, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{fmtCents(totalCents.toString())}</strong>
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
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No receipts recorded yet.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <SortableTh label="Date" sortKey="date" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!visibleColumns.has("date")} />
                <SortableTh label="Customer" sortKey="customer" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!visibleColumns.has("customer")} />
                <SortableTh label="Amount" sortKey="amount" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("amount")} />
                <SortableTh label="Applied" sortKey="applied" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("applied")} />
                <SortableTh label="Unapplied" sortKey="unapplied" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("unapplied")} />
                <SortableTh label="Method" sortKey="method" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!visibleColumns.has("method")} />
                <SortableTh label="Bank" sortKey="bank" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!visibleColumns.has("bank")} />
                <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!visibleColumns.has("status")} />
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((r) => {
                const cust = customerMap[r.customer_id];
                const bank = accountMap[r.bank_account_id];
                const st = statusLabel(r);
                return (
                  <ScrollHighlightRow
                    key={r.id}
                    rowId={r.id}
                    highlightedRowId={highlightedId}
                    {...getRowProps(r)}
                  >
                    <td style={td} hidden={!visibleColumns.has("date")}>{r.receipt_date}</td>
                    <td style={td} hidden={!visibleColumns.has("customer")}>
                      {cust ? (cust.code ? `${cust.code} — ${cust.name}` : cust.name) : <span style={{ color: C.textMuted }}>—</span>}
                      <SourceBadge source={r.source} />
                    </td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }} hidden={!visibleColumns.has("amount")}>{fmtCents(r.amount_cents)}</td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }} hidden={!visibleColumns.has("applied")}>{fmtCents(r.applied_cents || "0")}</td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right", color: BigInt(r.unapplied_cents || "0") > 0n ? C.warn : C.textMuted }} hidden={!visibleColumns.has("unapplied")}>
                      {fmtCents(r.unapplied_cents || "0")}
                    </td>
                    <td style={td} hidden={!visibleColumns.has("method")}>{r.customer_payment_method}</td>
                    <td style={{ ...td, fontSize: 12, color: C.textSub }} hidden={!visibleColumns.has("bank")}>
                      {bank ? `${bank.code} — ${bank.name}` : <span style={{ color: C.textMuted }}>—</span>}
                    </td>
                    <td style={td} hidden={!visibleColumns.has("status")}>
                      <span style={{ color: st.color, fontWeight: 500, fontSize: 12 }}>{st.label}</span>
                    </td>
                    <td style={td}>
                      <button onClick={(e) => { e.stopPropagation(); setDetailId(r.id); }} style={btnSecondary}>View</button>
                    </td>
                  </ScrollHighlightRow>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && (
        <AddReceiptModal
          customers={customers}
          accounts={accounts}
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); void load(); }}
        />
      )}
      {detailId && (
        <DetailReceiptModal
          receiptId={detailId}
          customers={customers}
          accounts={accounts}
          onClose={() => setDetailId(null)}
          onChanged={() => { void load(); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Add modal — customer pick → open-invoice picker → apply amounts + post
// ─────────────────────────────────────────────────────────────────────────

function AddReceiptModal({
  customers, accounts, onClose, onSaved,
}: {
  customers: Customer[];
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [customerId, setCustomerId] = useState("");
  const [receiptDate, setReceiptDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amountStr, setAmountStr] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("ach");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [openInvoices, setOpenInvoices] = useState<OpenInvoice[]>([]);
  const [appliedMap, setAppliedMap] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Bank account choices: code starts with '1' (asset) and code length-1 = '01' (cash)
  // is the typical convention. Show all assets; operator picks.
  const bankAccountChoices = useMemo(
    () => accounts.filter((a) => a.code?.startsWith("1")),
    [accounts],
  );

  // Fetch customer's open AR invoices when customer changes.
  useEffect(() => {
    if (!customerId) {
      setOpenInvoices([]);
      setAppliedMap({});
      return;
    }
    // The AR Invoices list endpoint (P4-4) — if not deployed, this returns
    // 404 and the picker stays empty (operator can still create an unapplied
    // receipt by entering amount only).
    fetch(`/api/internal/ar-invoices?customer_id=${customerId}&status_in=sent,partial_paid&limit=500`)
      .then((r) => (r.ok ? r.json() : []))
      .then((arr: OpenInvoice[]) => {
        if (!Array.isArray(arr)) { setOpenInvoices([]); return; }
        // Filter to invoices with outstanding balance > 0
        const open = arr.filter((inv) => {
          const out = BigInt(inv.total_amount_cents || "0") - BigInt(inv.paid_amount_cents || "0");
          return out > 0n;
        });
        // Sort by due_date ASC (oldest first), nulls last.
        open.sort((a, b) => {
          const ad = a.due_date || "9999-12-31";
          const bd = b.due_date || "9999-12-31";
          return ad < bd ? -1 : ad > bd ? 1 : 0;
        });
        setOpenInvoices(open);
      })
      .catch(() => setOpenInvoices([]));
  }, [customerId]);

  const amountCents = useMemo(() => parseCentsInput(amountStr), [amountStr]);

  const appliedTotalCents = useMemo(() => {
    let t = 0n;
    for (const k of Object.keys(appliedMap)) {
      const v = parseCentsInput(appliedMap[k] || "");
      if (v != null) t += v;
    }
    return t;
  }, [appliedMap]);

  const unappliedCents = useMemo(() => {
    if (amountCents == null) return null;
    return amountCents - appliedTotalCents;
  }, [amountCents, appliedTotalCents]);

  function toggleApply(inv: OpenInvoice, checked: boolean) {
    setAppliedMap((m) => {
      const next = { ...m };
      if (checked) {
        const out = BigInt(inv.total_amount_cents || "0") - BigInt(inv.paid_amount_cents || "0");
        // Default to outstanding balance, capped at remaining receipt amount.
        const remaining = (amountCents == null) ? out : (amountCents - appliedTotalCents);
        const dflt = remaining > 0n && remaining < out ? remaining : out;
        // format as decimal string for the input.
        next[inv.id] = (Number(dflt) / 100).toFixed(2);
      } else {
        delete next[inv.id];
      }
      return next;
    });
  }

  async function save() {
    setErr(null);
    if (!customerId) { setErr("Pick a customer first"); return; }
    if (!receiptDate) { setErr("Receipt date is required"); return; }
    if (amountCents == null || amountCents <= 0n) { setErr("Amount must be > 0"); return; }
    if (!bankAccountId) { setErr("Bank account is required"); return; }
    if (unappliedCents != null && unappliedCents < 0n) {
      setErr(`Applications total (${fmtCents(appliedTotalCents.toString())}) exceeds receipt amount (${fmtCents(amountCents.toString())})`);
      return;
    }

    const applications: Array<{ ar_invoice_id: string; amount_applied_cents: string }> = [];
    for (const invId of Object.keys(appliedMap)) {
      const v = parseCentsInput(appliedMap[invId]);
      if (v != null && v > 0n) {
        applications.push({ ar_invoice_id: invId, amount_applied_cents: v.toString() });
      }
    }

    setSaving(true);
    try {
      const body = {
        customer_id: customerId,
        receipt_date: receiptDate,
        amount_cents: amountCents.toString(),
        bank_account_id: bankAccountId,
        customer_payment_method: paymentMethod,
        reference: reference.trim() || undefined,
        notes: notes.trim() || undefined,
        applications,
      };
      const r = await fetch("/api/internal/ar-receipts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${r.status}`);
      }
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={modalBackdrop} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modalContent}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>Add AR Receipt</h3>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: C.textSub }}>
            Customer *
            <div style={{ marginTop: 4 }}>
              <SearchableSelect
                value={customerId || null}
                onChange={(v) => setCustomerId(v)}
                options={customers.map((c) => ({
                  value: c.id,
                  label: c.code ? `${c.code} — ${c.name}` : c.name,
                }))}
                placeholder="— select —"
              />
            </div>
          </label>
          <label style={{ fontSize: 12, color: C.textSub }}>
            Receipt date *
            <input type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} style={{ ...inputStyle, marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 12, color: C.textSub }}>
            Amount (USD) *
            <input
              type="text"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              placeholder="e.g. 1500.00"
              style={{ ...inputStyle, marginTop: 4, fontFamily: "SFMono-Regular, Menlo, monospace" }}
            />
          </label>
          <label style={{ fontSize: 12, color: C.textSub }}>
            Method *
            <div style={{ marginTop: 4 }}>
              <SearchableSelect
                value={paymentMethod || null}
                onChange={(v) => setPaymentMethod(v)}
                options={METHODS.map((m) => ({ value: m, label: m }))}
              />
            </div>
          </label>
          <label style={{ fontSize: 12, color: C.textSub, gridColumn: "1 / -1" }}>
            Bank account *
            <div style={{ marginTop: 4 }}>
              <SearchableSelect
                value={bankAccountId || null}
                onChange={(v) => setBankAccountId(v)}
                options={bankAccountChoices.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))}
                placeholder="— select —"
              />
            </div>
          </label>
          <label style={{ fontSize: 12, color: C.textSub }}>
            Reference (check# / wire conf.)
            <input value={reference} onChange={(e) => setReference(e.target.value)} style={{ ...inputStyle, marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 12, color: C.textSub }}>
            Notes
            <input value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...inputStyle, marginTop: 4 }} />
          </label>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Apply to open invoices ({openInvoices.length} open)
          </div>
          <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 6, maxHeight: 240, overflowY: "auto" }}>
            {!customerId ? (
              <div style={{ padding: 16, color: C.textMuted, fontSize: 13, textAlign: "center" }}>Pick a customer to load open invoices.</div>
            ) : openInvoices.length === 0 ? (
              <div style={{ padding: 16, color: C.textMuted, fontSize: 13, textAlign: "center" }}>No open invoices for this customer.</div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ ...th, width: 28 }}></th>
                    <th style={th}>Invoice</th>
                    <th style={th}>Due</th>
                    <th style={{ ...th, textAlign: "right" }}>Total</th>
                    <th style={{ ...th, textAlign: "right" }}>Paid</th>
                    <th style={{ ...th, textAlign: "right" }}>Outstanding</th>
                    <th style={{ ...th, textAlign: "right" }}>Apply</th>
                  </tr>
                </thead>
                <tbody>
                  {openInvoices.map((inv) => {
                    const checked = inv.id in appliedMap;
                    const out = BigInt(inv.total_amount_cents || "0") - BigInt(inv.paid_amount_cents || "0");
                    return (
                      <tr key={inv.id}>
                        <td style={td}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => toggleApply(inv, e.target.checked)}
                            style={{ accentColor: C.primary }}
                          />
                        </td>
                        <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{inv.invoice_number}</td>
                        <td style={td}>{inv.due_date || "—"}</td>
                        <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }}>{fmtCents(inv.total_amount_cents)}</td>
                        <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right", color: C.textMuted }}>{fmtCents(inv.paid_amount_cents)}</td>
                        <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right", color: C.warn }}>{fmtCents(out.toString())}</td>
                        <td style={{ ...td, textAlign: "right" }}>
                          {checked ? (
                            <input
                              type="text"
                              value={appliedMap[inv.id] || ""}
                              onChange={(e) => setAppliedMap((m) => ({ ...m, [inv.id]: e.target.value }))}
                              style={{ ...inputStyle, width: 100, textAlign: "right", fontFamily: "SFMono-Regular, Menlo, monospace" }}
                            />
                          ) : (
                            <span style={{ color: C.textMuted, fontSize: 11 }}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          {amountCents != null && (
            <div style={{ marginTop: 8, fontSize: 12, color: C.textSub, display: "flex", gap: 16, flexWrap: "wrap" }}>
              <span>Receipt: <strong style={{ color: C.text }}>{fmtCents(amountCents.toString())}</strong></span>
              <span>Applied: <strong style={{ color: C.text }}>{fmtCents(appliedTotalCents.toString())}</strong></span>
              <span>
                Unapplied:&nbsp;
                <strong style={{ color: (unappliedCents ?? 0n) < 0n ? C.danger : (unappliedCents ?? 0n) > 0n ? C.warn : C.success }}>
                  {fmtCents((unappliedCents ?? 0n).toString())}
                </strong>
                {(unappliedCents ?? 0n) > 0n && <span style={{ color: C.textMuted, fontStyle: "italic" }}> &nbsp;(stays as on-account credit)</span>}
                {(unappliedCents ?? 0n) < 0n && <span style={{ color: C.danger, fontStyle: "italic" }}> &nbsp;over-applied — reduce applications</span>}
              </span>
            </div>
          )}
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
            {err}
          </div>
        )}

        {/* Sticky action footer — pinned to the bottom of the scrolling modal so
            Save / Cancel stay reachable as the receipt-application grid grows. */}
        <div style={{ position: "sticky", bottom: -24, zIndex: 3, background: C.card, borderTop: `1px solid ${C.cardBdr}`, margin: "0 -24px -24px", padding: "14px 24px", display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
          <button onClick={onClose} style={btnSecondary} disabled={saving}>Cancel</button>
          <button onClick={() => void save()} style={btnPrimary} disabled={saving}>
            {saving ? "Saving…" : "Create draft"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Detail / Edit modal — header + applications + Post/Void/Unapply
// ─────────────────────────────────────────────────────────────────────────

type ReceiptDetail = ARReceipt & {
  customer: Customer | null;
  applications: ARApplication[];
  applied_cents: string;
  unapplied_cents: string;
};

function DetailReceiptModal({
  receiptId, customers, accounts, onClose, onChanged,
}: {
  receiptId: string;
  customers: Customer[];
  accounts: Account[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [receipt, setReceipt] = useState<ReceiptDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Header edit state — lazily populated from receipt.
  const [editReceiptDate, setEditReceiptDate] = useState("");
  const [editMethod, setEditMethod] = useState("ach");
  const [editBank, setEditBank] = useState("");
  const [editReference, setEditReference] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [voidReason, setVoidReason] = useState("");

  async function reload() {
    setErr(null);
    try {
      const r = await fetch(`/api/internal/ar-receipts/${receiptId}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const d = (await r.json()) as ReceiptDetail;
      setReceipt(d);
      setEditReceiptDate(d.receipt_date);
      setEditMethod(d.customer_payment_method);
      setEditBank(d.bank_account_id);
      setEditReference(d.reference || "");
      setEditNotes(d.notes || "");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => { void reload(); }, [receiptId]);

  const isPosted = !!(receipt && (receipt.accrual_je_id || receipt.cash_je_id));
  const isVoid = !!(receipt && receipt.is_void);
  const editable = !!receipt && !isPosted && !isVoid;

  async function savePatch() {
    if (!receipt) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/ar-receipts/${receipt.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          receipt_date: editReceiptDate,
          customer_payment_method: editMethod,
          bank_account_id: editBank,
          reference: editReference,
          notes: editNotes,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await reload();
      onChanged();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function postReceipt() {
    if (!receipt) return;
    if (!(await confirmDialog("Post this receipt? This emits the accrual + cash JEs and is not easily reversible."))) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/ar-receipts/${receipt.id}/post`, { method: "POST" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await reload();
      onChanged();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function voidReceipt() {
    if (!receipt) return;
    if (!(await confirmDialog("Void this receipt? Both JEs (if posted) will be reversed and the applications back out of invoice paid totals."))) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/ar-receipts/${receipt.id}/void`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ void_reason: voidReason || undefined }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await reload();
      onChanged();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function unapply(appId: string) {
    if (!(await confirmDialog("Unapply this application?"))) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/ar-receipt-applications/${appId}`, { method: "DELETE" });
      if (!r.ok && r.status !== 204) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await reload();
      onChanged();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!receipt) {
    return (
      <div style={modalBackdrop} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div style={modalContent}>
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        </div>
      </div>
    );
  }

  const bankAccountChoices = accounts.filter((a) => a.code?.startsWith("1"));
  const cust = receipt.customer || customers.find((c) => c.id === receipt.customer_id) || null;

  return (
    <div style={modalBackdrop} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modalContent}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 18 }}>
            AR Receipt — {fmtCents(receipt.amount_cents)}
          </h3>
          <span style={{ fontSize: 12, color: statusLabel(receipt).color, fontWeight: 500 }}>
            {statusLabel(receipt).label}
          </span>
          {cust && <span style={{ fontSize: 12, color: C.textSub }}>{cust.code ? `${cust.code} — ${cust.name}` : cust.name}</span>}
          <button onClick={onClose} style={{ ...btnSecondary, marginLeft: "auto" }}>Close</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: C.textSub }}>
            Receipt date
            <input
              type="date"
              value={editReceiptDate}
              onChange={(e) => setEditReceiptDate(e.target.value)}
              disabled={!editable}
              style={{ ...inputStyle, marginTop: 4, opacity: editable ? 1 : 0.6 }}
            />
          </label>
          <label style={{ fontSize: 12, color: C.textSub }}>
            Method
            <div style={{ marginTop: 4, opacity: editable ? 1 : 0.6 }}>
              <SearchableSelect
                value={editMethod || null}
                onChange={(v) => setEditMethod(v)}
                options={METHODS.map((m) => ({ value: m, label: m }))}
                disabled={!editable}
              />
            </div>
          </label>
          <label style={{ fontSize: 12, color: C.textSub, gridColumn: "1 / -1" }}>
            Bank
            <div style={{ marginTop: 4, opacity: editable ? 1 : 0.6 }}>
              <SearchableSelect
                value={editBank || null}
                onChange={(v) => setEditBank(v)}
                options={bankAccountChoices.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))}
                placeholder="— select —"
                disabled={!editable}
              />
            </div>
          </label>
          <label style={{ fontSize: 12, color: C.textSub }}>
            Reference
            <input value={editReference} onChange={(e) => setEditReference(e.target.value)} disabled={!editable} style={{ ...inputStyle, marginTop: 4, opacity: editable ? 1 : 0.6 }} />
          </label>
          <label style={{ fontSize: 12, color: C.textSub }}>
            Notes
            <input value={editNotes} onChange={(e) => setEditNotes(e.target.value)} disabled={!editable} style={{ ...inputStyle, marginTop: 4, opacity: editable ? 1 : 0.6 }} />
          </label>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Applications ({receipt.applications.length})
          </div>
          <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 6, overflow: "hidden" }}>
            {receipt.applications.length === 0 ? (
              <div style={{ padding: 16, color: C.textMuted, fontSize: 13, textAlign: "center" }}>
                No applications — this is an unapplied (on-account) receipt.
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={th}>Invoice</th>
                    <th style={{ ...th, textAlign: "right" }}>Applied</th>
                    <th style={th}>Notes</th>
                    <th style={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {receipt.applications.map((a) => (
                    <tr key={a.id}>
                      <td style={td}>
                        {a.ar_invoices?.invoice_number || "—"}
                      </td>
                      <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }}>
                        {fmtCents(a.amount_applied_cents)}
                      </td>
                      <td style={{ ...td, fontSize: 12, color: C.textSub }}>{a.notes || "—"}</td>
                      <td style={td}>
                        {editable ? (
                          <button onClick={() => void unapply(a.id)} style={btnSecondary} disabled={busy}>×</button>
                        ) : (
                          <span style={{ color: C.textMuted, fontSize: 11 }}>locked</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: C.textSub, display: "flex", gap: 16 }}>
            <span>Applied: <strong style={{ color: C.text }}>{fmtCents(receipt.applied_cents)}</strong></span>
            <span>Unapplied: <strong style={{ color: BigInt(receipt.unapplied_cents || "0") > 0n ? C.warn : C.textMuted }}>{fmtCents(receipt.unapplied_cents)}</strong></span>
          </div>
        </div>

        {!isVoid && (isPosted || !editable) && (
          <div style={{ marginBottom: 12, padding: "8px 12px", background: "#1d2747", border: `1px solid ${C.cardBdr}`, borderRadius: 6, fontSize: 12, color: C.textSub }}>
            {isPosted && (
              <>
                Accrual JE: <span style={{ color: C.success }}>{receipt.accrual_je_id ? "posted" : "—"}</span>
                &nbsp;·&nbsp;Cash JE: <span style={{ color: C.success }}>{receipt.cash_je_id ? "posted" : "—"}</span>
              </>
            )}
          </div>
        )}

        {isVoid && receipt.void_reason && (
          <div style={{ marginBottom: 12, padding: "8px 12px", background: "#3a1414", border: `1px solid ${C.danger}`, borderRadius: 6, fontSize: 12, color: C.text }}>
            Voided: {receipt.void_reason}
          </div>
        )}

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Supporting documents</div>
          <DocumentAttachmentList
            contextTable="ar_receipts"
            contextId={receipt.id}
            kinds={["customer_payment_proof", "check_image", "wire_confirmation", "other"]}
          />
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap" }}>
          {!isPosted && !isVoid && (
            <>
              <input
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                placeholder="Void reason (optional)"
                style={{ ...inputStyle, width: 220 }}
              />
              <button onClick={() => void voidReceipt()} style={btnDanger} disabled={busy}>Void</button>
              <button onClick={() => void postReceipt()} style={btnWarn} disabled={busy}>Post</button>
              <button onClick={() => void savePatch()} style={btnPrimary} disabled={busy}>Save</button>
            </>
          )}
          {isPosted && !isVoid && (
            <>
              <input
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                placeholder="Void reason"
                style={{ ...inputStyle, width: 220 }}
              />
              <button onClick={() => void voidReceipt()} style={btnDanger} disabled={busy}>Void posted receipt</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
