// src/tanda/InternalARInvoices.tsx
//
// Tangerine P4 Chunk 4 — Accounts Receivable invoice admin UI.
// Lists invoices with status/customer/date/search filters. Add/Edit modal
// supports customer dropdown, GL account overrides, and inventory or
// flat-amount lines. Post / Void actions wired to dedicated handlers.

import { useEffect, useMemo, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import DocumentAttachmentList from "../shared/documents/DocumentAttachmentList";
import StagedDocsPicker from "../shared/documents/StagedDocsPicker";
import { uploadStagedDocs } from "../shared/documents/uploadDocument";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SourceBadge, { SOURCE_OPTIONS } from "./components/SourceBadge";
import SearchableSelect from "./components/SearchableSelect";
import DateRangePresets from "./components/DateRangePresets.tsx";
// Cross-cutter T11-3 — audit-trail drop-in for the detail modal.
import RowHistory from "./components/RowHistory";
// Wave 5 universal primitives — column show/hide, row-click-to-edit, dyn search.
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import DynamicSearchInput from "./components/DynamicSearchInput";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import LineColorSizeMatrix, { type MatrixEntry } from "./components/LineColorSizeMatrix";
import { useItemResolver } from "./hooks/useItemResolver";
import LineViewToggle from "./components/LineViewToggle";

// Universal column-visibility registry for this panel (operator ask #1).
const AR_INVOICES_TABLE_KEY = "tangerine:arinvoices:columns";
const AR_INVOICE_COLUMNS: ColumnDef[] = [
  { key: "invoice_number", label: "Invoice #" },
  { key: "invoice_date",   label: "Date" },
  { key: "customer",       label: "Customer" },
  { key: "total",          label: "Total" },
  { key: "paid",           label: "Paid" },
  { key: "balance",        label: "Balance" },
  { key: "status",         label: "Status" },
];

type GlStatus =
  | "draft" | "unposted" | "pending_approval" | "sent"
  | "partial_paid" | "paid" | "void" | "reversed" | "posted_historical";

// Status enum has 9 options (incl. "All statuses"); routed through SearchableSelect.
const AR_STATUS_OPTIONS: { value: GlStatus | ""; label: string }[] = [
  { value: "",                  label: "All statuses" },
  { value: "draft",             label: "Draft" },
  { value: "pending_approval",  label: "Pending approval" },
  { value: "sent",              label: "Sent" },
  { value: "partial_paid",      label: "Partial paid" },
  { value: "paid",              label: "Paid" },
  { value: "void",              label: "Void" },
  { value: "reversed",          label: "Reversed" },
  { value: "posted_historical", label: "Posted (historical)" },
];

// Source enum is a long static list (10 values); routed through SearchableSelect.
const AR_SOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All sources" },
  ...SOURCE_OPTIONS.map((s) => ({ value: s, label: s })),
];

type ARInvoice = {
  id: string;
  entity_id: string;
  customer_id: string;
  ship_to_location_id: string | null;
  invoice_number: string;
  invoice_kind: string;
  gl_status: GlStatus;
  invoice_date: string;
  posting_date: string;
  due_date: string | null;
  payment_terms_id: string | null;
  ar_account_id: string | null;
  revenue_account_id: string | null;
  cogs_account_id: string | null;
  inventory_asset_account_id: string | null;
  accrual_je_id: string | null;
  cash_je_id: string | null;
  total_amount_cents: string;
  paid_amount_cents: string;
  description: string | null;
  source?: string | null;
  created_at: string;
};

type ShipToLocation = { id: string; name: string; code: string | null; is_default: boolean };

type ARInvoiceLine = {
  id?: string;
  ar_invoice_id?: string;
  line_number: number;
  description: string | null;
  revenue_account_id: string | null;
  inventory_item_id: string | null;
  quantity: number | null;
  unit_price_cents: string | null;
  line_total_cents: string | null;
  cogs_cents: string | null;
};

type ARInvoiceFull = ARInvoice & { lines: ARInvoiceLine[] };

type Customer = { id: string; name: string; customer_code?: string };
type Account = {
  id: string;
  code: string;
  name: string;
  account_type: string;
  is_postable: boolean;
  status: string;
};

type ARItem = { id: string; sku_code: string; style_code?: string; description?: string; color?: string; size?: string };

type DraftLine = {
  key: number;
  description: string;
  inventory_item_id: string;
  quantity: string;
  unit_price_dollars: string;
  line_total_dollars: string;       // explicit total when no unit_price
  revenue_account_id: string;
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d" };
const btnWarn: React.CSSProperties = { ...btnSecondary, color: C.warn, borderColor: "#78350f" };
const btnSuccess: React.CSSProperties = { ...btnSecondary, color: C.success, borderColor: "#065f46" };

const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
  colorScheme: "dark",
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};

function statusColor(s: GlStatus): string {
  if (s === "sent" || s === "paid" || s === "partial_paid" || s === "posted_historical") return C.success;
  if (s === "pending_approval") return C.warn;
  if (s === "void" || s === "reversed") return C.danger;
  return C.textMuted;
}

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

function dollarsToCentsBigInt(s: string): bigint | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!/^-?\d{1,12}(\.\d{1,2})?$/.test(trimmed)) return null;
  const neg = trimmed.startsWith("-");
  const u = neg ? trimmed.slice(1) : trimmed;
  const [whole, frac = ""] = u.split(".");
  const padded = (frac + "00").slice(0, 2);
  const cents = BigInt(whole) * 100n + BigInt(padded);
  return neg ? -cents : cents;
}

export default function InternalARInvoices() {
  const [rows, setRows] = useState<ARInvoice[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<GlStatus | "">("");
  const [customerFilter, setCustomerFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("");
  // Wave 5 dynamic search — 200ms debounce drives load(), input updates sync.
  const { value: search, debouncedValue: debouncedSearch, setValue: setSearch } =
    useDebouncedSearch("", 200);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [includeVoid, setIncludeVoid] = useState(false);
  const [limit, setLimit] = useState(200);

  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<ARInvoice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Wave 5 — universal column show/hide.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    AR_INVOICES_TABLE_KEY,
    AR_INVOICE_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  // Wave 5 — universal row-click-to-edit + scroll-highlight.
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const { getRowProps } = useRowClickEdit<ARInvoice>({
    onRowClick: (inv) => { setEditing(inv); setEditOpen(true); },
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (inv) => `Edit AR invoice ${inv.invoice_number}`,
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (statusFilter) params.set("status", statusFilter);
      if (customerFilter) params.set("customer_id", customerFilter);
      if (sourceFilter) params.set("source", sourceFilter);
      if (debouncedSearch.trim()) params.set("q", debouncedSearch.trim());
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);
      if (includeVoid) params.set("include_void", "true");
      const r = await fetch(`/api/internal/ar-invoices?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as ARInvoice[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [statusFilter, customerFilter, sourceFilter, debouncedSearch, includeVoid, fromDate, toDate, limit]);

  useEffect(() => {
    fetch("/api/internal/customer-master?limit=1000")
      .then((r) => r.json())
      .then((arr: unknown) => {
        if (Array.isArray(arr)) setCustomers(arr as Customer[]);
      })
      .catch(() => {});
  }, []);

  const customerMap = useMemo(() => {
    const m: Record<string, Customer> = {};
    for (const c of customers) m[c.id] = c;
    return m;
  }, [customers]);

  async function doPost(inv: ARInvoice) {
    if (!(await confirmDialog(`Post invoice ${inv.invoice_number}? This creates the accrual JE and consumes FIFO inventory for any inventory lines.`))) return;
    setBusy(inv.id);
    try {
      const r = await fetch(`/api/internal/ar-invoices/${inv.id}/post`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok && r.status !== 202) throw new Error(j.error || `HTTP ${r.status}`);
      if (j.requires_approval) {
        notify(`Approval required. Approval request id: ${j.approval_request_id || "(see Approvals tab)"}.`, "info");
      }
      await load();
    } catch (e: unknown) {
      notify(`Post failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  async function doVoid(inv: ARInvoice) {
    const reason = prompt(`Void invoice ${inv.invoice_number}? Optional reason:`, "");
    if (reason === null) return;
    setBusy(inv.id);
    try {
      const r = await fetch(`/api/internal/ar-invoices/${inv.id}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason || null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (j.has_payments) {
          notify(`Cannot void: invoice has ${fmtCents(j.paid_amount_cents)} in receipt applications. Void the receipts first.`, "error");
        } else {
          throw new Error(j.error || `HTTP ${r.status}`);
        }
        return;
      }
      await load();
    } catch (e: unknown) {
      notify(`Void failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  async function doDelete(inv: ARInvoice) {
    if (!(await confirmDialog(`Delete draft invoice ${inv.invoice_number}? This is irreversible.`))) return;
    setBusy(inv.id);
    try {
      const r = await fetch(`/api/internal/ar-invoices/${inv.id}`, { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>AR Invoices</h2>
        <button onClick={() => { setEditing(null); setEditOpen(true); }} style={btnPrimary}>
          + New invoice
        </button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ width: 200 }}>
          <SearchableSelect
            value={statusFilter || null}
            onChange={(v) => setStatusFilter((v || "") as GlStatus | "")}
            options={AR_STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            placeholder="All statuses"
          />
        </div>
        <div style={{ width: 240 }}>
          <SearchableSelect
            value={customerFilter || null}
            onChange={(v) => setCustomerFilter(v)}
            options={[
              { value: "", label: "All customers" },
              ...customers.map((c) => ({ value: c.id, label: c.name })),
            ]}
            placeholder="All customers"
          />
        </div>
        <div
          style={{ width: 170 }}
          title="Filter by row source — manual entries vs mirrored from Xoro / future integrations"
        >
          <SearchableSelect
            value={sourceFilter || null}
            onChange={(v) => setSourceFilter(v || "")}
            options={AR_SOURCE_OPTIONS}
            placeholder="All sources"
          />
        </div>
        <DynamicSearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search invoice #"
          ariaLabel="Search AR invoices"
          wrapperStyle={{ maxWidth: 220 }}
        />
        <input
          type="date" placeholder="From" value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          style={{ ...inputStyle, width: 140 }}
        />
        <input
          type="date" placeholder="To" value={toDate}
          onChange={(e) => setToDate(e.target.value)}
          style={{ ...inputStyle, width: 140 }}
        />
        <DateRangePresets
          from={fromDate}
          to={toDate}
          onChange={(f, t) => { setFromDate(f); setToDate(t); }}
        />
        <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={{ ...inputStyle, width: 110 }}>
          <option value={50}>Limit 50</option>
          <option value={100}>Limit 100</option>
          <option value={200}>Limit 200</option>
          <option value={500}>Limit 500</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeVoid} onChange={(e) => setIncludeVoid(e.target.checked)} />
          Include void
        </label>
        <TablePrefsButton
          tableKey={AR_INVOICES_TABLE_KEY}
          columns={AR_INVOICE_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
        />
        <ExportButton
          rows={rows.map((inv) => ({
            invoice_number: inv.invoice_number,
            invoice_date: inv.invoice_date,
            posting_date: inv.posting_date,
            due_date: inv.due_date,
            customer: customerMap[inv.customer_id]?.name || inv.customer_id,
            invoice_kind: inv.invoice_kind,
            gl_status: inv.gl_status,
            source: inv.source || "manual",
            total_amount_cents: inv.total_amount_cents,
            paid_amount_cents: inv.paid_amount_cents,
            balance_cents: (BigInt(inv.total_amount_cents || "0") - BigInt(inv.paid_amount_cents || "0")).toString(),
            description: inv.description,
          })) as unknown as Array<Record<string, unknown>>}
          filename="ar-invoices"
          sheetName="AR Invoices"
          columns={[
            { key: "invoice_number",     header: "Invoice #" },
            { key: "invoice_date",       header: "Invoice Date", format: "date" },
            { key: "posting_date",       header: "Posting Date", format: "date" },
            { key: "due_date",           header: "Due Date",     format: "date" },
            { key: "customer",           header: "Customer" },
            { key: "invoice_kind",       header: "Type" },
            { key: "gl_status",          header: "Status" },
            { key: "source",             header: "Source" },
            { key: "total_amount_cents", header: "Total",   format: "currency_cents" },
            { key: "paid_amount_cents",  header: "Paid",    format: "currency_cents" },
            { key: "balance_cents",      header: "Balance", format: "currency_cents" },
            { key: "description",        header: "Description" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No AR invoices.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 130 }} hidden={!isVisible("invoice_number")}>Invoice #</th>
                <th style={th} hidden={!isVisible("invoice_date")}>Date</th>
                <th style={th} hidden={!isVisible("customer")}>Customer</th>
                <th style={{ ...th, textAlign: "right" }} hidden={!isVisible("total")}>Total</th>
                <th style={{ ...th, textAlign: "right" }} hidden={!isVisible("paid")}>Paid</th>
                <th style={{ ...th, textAlign: "right" }} hidden={!isVisible("balance")}>Balance</th>
                <th style={th} hidden={!isVisible("status")}>Status</th>
                <th style={{ ...th, width: 260, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => {
                const isDraft = inv.gl_status === "draft" || inv.gl_status === "unposted";
                const isPendingApproval = inv.gl_status === "pending_approval";
                const isSent = inv.gl_status === "sent" || inv.gl_status === "partial_paid" || inv.gl_status === "paid";
                const isVoid = inv.gl_status === "void" || inv.gl_status === "reversed";
                const isPaid = inv.gl_status === "paid";
                const canPost = isDraft || isPendingApproval;
                const canVoid = isSent;
                const canEdit = isDraft;
                const canDelete = isDraft;
                const balanceCents = BigInt(inv.total_amount_cents || "0") - BigInt(inv.paid_amount_cents || "0");
                return (
                  <ScrollHighlightRow
                    key={inv.id}
                    rowId={inv.id}
                    highlightedRowId={highlightedId}
                    {...getRowProps(inv)}
                    style={isVoid ? { opacity: 0.5 } : undefined}
                  >
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }} hidden={!isVisible("invoice_number")}>
                      {inv.invoice_number}
                      <SourceBadge source={inv.source} />
                    </td>
                    <td style={td} hidden={!isVisible("invoice_date")}>{inv.invoice_date}</td>
                    <td style={td} hidden={!isVisible("customer")}>{customerMap[inv.customer_id]?.name || "—"}</td>
                    <td
                      style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }}
                      hidden={!isVisible("total")}
                    >
                      {fmtCents(inv.total_amount_cents)}
                    </td>
                    <td
                      style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }}
                      hidden={!isVisible("paid")}
                    >
                      {fmtCents(inv.paid_amount_cents)}
                    </td>
                    <td
                      style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right", color: balanceCents > 0n ? C.warn : C.textMuted }}
                      hidden={!isVisible("balance")}
                    >
                      {fmtCents(balanceCents.toString())}
                    </td>
                    <td style={td} hidden={!isVisible("status")}>
                      <span style={{ color: statusColor(inv.gl_status), fontWeight: 600 }}>● {inv.gl_status}</span>
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>
                      {canEdit && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditing(inv); setEditOpen(true); }}
                          style={btnSecondary} disabled={busy === inv.id}
                        >
                          Edit
                        </button>
                      )}
                      {canPost && (
                        <button
                          onClick={(e) => { e.stopPropagation(); void doPost(inv); }}
                          style={{ ...btnSuccess, marginLeft: 6 }}
                          disabled={busy === inv.id}
                        >
                          Post
                        </button>
                      )}
                      {canVoid && (
                        <button
                          onClick={(e) => { e.stopPropagation(); void doVoid(inv); }}
                          style={{ ...btnWarn, marginLeft: 6 }}
                          disabled={busy === inv.id}
                        >
                          Void
                        </button>
                      )}
                      {canDelete && (
                        <button
                          onClick={(e) => { e.stopPropagation(); void doDelete(inv); }}
                          style={{ ...btnDanger, marginLeft: 6 }}
                          disabled={busy === inv.id}
                        >
                          Del
                        </button>
                      )}
                      {isPaid && !canVoid && (
                        <span style={{ fontSize: 11, color: C.success }}>Fully paid</span>
                      )}
                    </td>
                  </ScrollHighlightRow>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {editOpen && (
        <ARInvoiceModal
          invoice={editing}
          customers={customers}
          onClose={() => { setEditOpen(false); setEditing(null); }}
          onSaved={() => { setEditOpen(false); setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Add / Edit modal
// ─────────────────────────────────────────────────────────────────────
function ARInvoiceModal({
  invoice, customers, onClose, onSaved,
}: {
  invoice: ARInvoice | null;
  customers: Customer[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = invoice === null;
  const editable = isNew || invoice?.gl_status === "draft" || invoice?.gl_status === "unposted";

  const [customerId, setCustomerId] = useState(invoice?.customer_id || "");
  const [shipToLocationId, setShipToLocationId] = useState(invoice?.ship_to_location_id || "");
  const [shipToLocations, setShipToLocations] = useState<ShipToLocation[]>([]);
  const [kind, setKind] = useState(invoice?.invoice_kind || "customer_invoice");
  const [invoiceDate, setInvoiceDate] = useState(invoice?.invoice_date || new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState(invoice?.due_date || "");
  const [paymentTermsId, setPaymentTermsId] = useState(invoice?.payment_terms_id || "");
  const [description, setDescription] = useState(invoice?.description || "");
  const [arAccountId, setArAccountId] = useState(invoice?.ar_account_id || "");
  const [revenueAccountId, setRevenueAccountId] = useState(invoice?.revenue_account_id || "");
  const [cogsAccountId, setCogsAccountId] = useState(invoice?.cogs_account_id || "");
  const [inventoryAccountId, setInventoryAccountId] = useState(invoice?.inventory_asset_account_id || "");

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [items, setItems] = useState<ARItem[]>([]); // inventory items for the line picker
  const [paymentTerms, setPaymentTerms] = useState<{ id: string; code: string; name: string }[]>([]);
  const [lines, setLines] = useState<DraftLine[]>([
    { key: 1, description: "", inventory_item_id: "", quantity: "", unit_price_dollars: "", line_total_dollars: "", revenue_account_id: "" },
  ]);
  const [loading, setLoading] = useState(!isNew);
  const [stagedDocs, setStagedDocs] = useState<File[]>([]); // attached before save (new invoice)
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // ▦ Matrix / ☰ List toggle for the lines section.
  const [lineView, setLineView] = useState<"list" | "matrix">("list");

  // Resolve each line's inventory_item_id → {color,size} for the matrix view.
  // Defer the fetch until the operator actually opens the matrix.
  const lineItemIds = useMemo(
    () => lines.map((l) => l.inventory_item_id).filter(Boolean) as string[],
    [lines],
  );
  const { itemMap: resolvedItems } = useItemResolver(lineItemIds, lineView === "matrix");
  // Merge the modal's loaded `items` list as a fallback resolver source.
  const matrixData = useMemo(() => {
    const itemLookup = new Map<string, ARItem>();
    for (const it of items) itemLookup.set(it.id, it);
    const matrixEntries: MatrixEntry[] = [];
    const fallback: { label: string; qty: number }[] = [];
    for (const l of lines) {
      const qty = Number(l.quantity) || 0;
      const resolved = l.inventory_item_id
        ? (resolvedItems.get(l.inventory_item_id) || itemLookup.get(l.inventory_item_id))
        : undefined;
      if (resolved && resolved.color && resolved.size) {
        matrixEntries.push({ color: resolved.color, size: resolved.size, qty });
      } else {
        const sku = resolved?.sku_code;
        fallback.push({ label: sku || l.description || "(flat-amount line)", qty });
      }
    }
    return { matrixEntries, fallback };
  }, [lines, resolvedItems, items]);

  useEffect(() => {
    fetch("/api/internal/gl-accounts?limit=1000")
      .then((r) => r.json())
      .then((arr: Account[]) => setAccounts(Array.isArray(arr) ? arr.filter((a) => a.status === "active") : []))
      .catch(() => {});
    fetch("/api/internal/payment-terms?limit=200")
      .then((r) => r.json())
      .then((arr: { id: string; code: string; name: string }[]) => setPaymentTerms(Array.isArray(arr) ? arr : []))
      .catch(() => {});
    // Inventory items for the line picker (searchable dropdown).
    fetch("/api/internal/items?limit=500")
      .then((r) => (r.ok ? r.json() : []))
      .then((arr: ARItem[]) => setItems(Array.isArray(arr) ? arr : []))
      .catch(() => {});
  }, []);

  // Reload ship-to location options whenever the customer changes.
  useEffect(() => {
    if (!customerId) {
      setShipToLocations([]);
      setShipToLocationId("");
      return;
    }
    fetch(`/api/internal/customer-locations?customer_id=${encodeURIComponent(customerId)}`)
      .then((r) => r.json())
      .then((arr: ShipToLocation[]) => {
        if (Array.isArray(arr)) {
          setShipToLocations(arr);
          // Auto-select the default location when creating a new invoice and no
          // location is set yet; don't override an existing selection on edit.
          if (isNew && !shipToLocationId) {
            const def = arr.find((l) => l.is_default);
            if (def) setShipToLocationId(def.id);
          }
        }
      })
      .catch(() => {});
  }, [customerId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy-load existing lines on edit.
  useEffect(() => {
    if (isNew || !invoice) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/internal/ar-invoices/${invoice.id}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        const full = await r.json() as ARInvoiceFull;
        if (cancelled) return;
        if (full.lines?.length > 0) {
          const ll = full.lines.map((l, i) => ({
            key: i + 1,
            description: l.description || "",
            inventory_item_id: l.inventory_item_id || "",
            quantity: l.quantity != null ? String(l.quantity) : "",
            unit_price_dollars: l.unit_price_cents ? centsToDollarsStr(l.unit_price_cents) : "",
            line_total_dollars: !l.unit_price_cents && l.line_total_cents ? centsToDollarsStr(l.line_total_cents) : "",
            revenue_account_id: l.revenue_account_id || "",
          }));
          setLines(ll);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [invoice, isNew]);

  // Auto-compute due_date if payment_terms_id is set and operator hasn't typed
  // a date themselves. Uses compute_due_date RPC; falls back silently on error.
  useEffect(() => {
    if (!paymentTermsId || !invoiceDate) return;
    if (dueDate) return; // honor manual edit
    let cancelled = false;
    fetch(`/api/internal/payment-terms/${paymentTermsId}`)
      .then((r) => r.json())
      .then((pt: { net_days?: number }) => {
        if (cancelled || !pt?.net_days) return;
        const d = new Date(invoiceDate + "T00:00:00Z");
        d.setUTCDate(d.getUTCDate() + pt.net_days);
        setDueDate(d.toISOString().slice(0, 10));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [paymentTermsId, invoiceDate]); // eslint-disable-line react-hooks/exhaustive-deps

  function addLine() {
    setLines((ll) => [...ll, {
      key: (ll[ll.length - 1]?.key || 0) + 1,
      description: "", inventory_item_id: "", quantity: "",
      unit_price_dollars: "", line_total_dollars: "", revenue_account_id: "",
    }]);
  }
  function updateLine(idx: number, patch: Partial<DraftLine>) {
    setLines((ll) => ll.map((l, i) => i === idx ? { ...l, ...patch } : l));
  }
  function removeLine(idx: number) {
    if (lines.length <= 1) return;
    setLines((ll) => ll.filter((_, i) => i !== idx));
  }

  // M43 — suggest a unit price from the Pricing Engine for the line's SKU +
  // this invoice's customer + qty. Prefills only when the unit-price box is empty
  // (manual entries/edits preserved); `force` overwrites (the ↻ button). The
  // engine prices at style level; the resolve endpoint maps the SKU → style.
  const [priceSrc, setPriceSrc] = useState<Record<number, string>>({});
  async function suggestPrice(lineKey: number, itemId: string, qtyStr: string, force: boolean) {
    if (!itemId || !customerId) return;
    try {
      const p = new URLSearchParams({ customer_id: customerId, item_id: itemId });
      const qn = Number(qtyStr); if (Number.isFinite(qn) && qn > 0) p.set("qty", String(qn));
      const r = await fetch(`/api/internal/pricing/resolve?${p.toString()}`);
      if (!r.ok) return;
      const j = await r.json();
      if (j?.price_cents == null) { if (force) notify("No price found for this style/customer.", "info"); return; }
      const dollars = centsToDollarsStr(j.price_cents);
      setLines((prev) => prev.map((l) => l.key === lineKey ? (force || !l.unit_price_dollars ? { ...l, unit_price_dollars: dollars } : l) : l));
      if (j.source_list_code) setPriceSrc((m) => ({ ...m, [lineKey]: j.source_list_code }));
    } catch { /* non-fatal — operator can type the price */ }
  }

  const totalCents = useMemo(() => {
    let total = 0n;
    for (const l of lines) {
      if (l.unit_price_dollars && l.quantity) {
        const up = dollarsToCentsBigInt(l.unit_price_dollars);
        const qty = Number(l.quantity);
        if (up != null && Number.isFinite(qty) && qty > 0) {
          total += up * BigInt(Math.round(qty));
        }
      } else if (l.line_total_dollars) {
        const t = dollarsToCentsBigInt(l.line_total_dollars);
        if (t != null) total += t;
      }
    }
    return total;
  }, [lines]);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const apiLines = lines.map((l) => {
        const out: Record<string, unknown> = {
          description: l.description || null,
          revenue_account_id: l.revenue_account_id || null,
        };
        if (l.inventory_item_id) out.inventory_item_id = l.inventory_item_id;
        if (l.quantity) out.quantity = Number(l.quantity);
        if (l.unit_price_dollars) {
          const up = dollarsToCentsBigInt(l.unit_price_dollars);
          if (up != null) out.unit_price_cents = up.toString();
        }
        if (l.line_total_dollars && !l.unit_price_dollars) {
          const t = dollarsToCentsBigInt(l.line_total_dollars);
          if (t != null) out.line_total_cents = t.toString();
        }
        return out;
      });

      const body: Record<string, unknown> = {
        customer_id: customerId,
        ship_to_location_id: shipToLocationId || null,
        // invoice_number is always system-assigned on create (never sent) and
        // immutable on edit — so it is deliberately omitted from the body.
        invoice_kind: kind,
        invoice_date: invoiceDate,
        due_date: dueDate || null,
        payment_terms_id: paymentTermsId || null,
        description: description.trim() || null,
        ar_account_id: arAccountId || null,
        revenue_account_id: revenueAccountId || null,
        cogs_account_id: cogsAccountId || null,
        inventory_asset_account_id: inventoryAccountId || null,
        lines: apiLines,
      };

      let r: Response;
      if (isNew) {
        r = await fetch("/api/internal/ar-invoices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        r = await fetch(`/api/internal/ar-invoices/${invoice!.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      // Upload any documents staged on a brand-new invoice now that it has an id.
      if (isNew && stagedDocs.length > 0) {
        const created = await r.json().catch(() => null);
        if (created?.id) {
          try { await uploadStagedDocs("ar_invoices", created.id, stagedDocs); }
          catch (upErr) { notify(`Invoice saved, but a document upload failed: ${upErr instanceof Error ? upErr.message : String(upErr)}`, "error"); }
        }
      }
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const formValid =
    !!customerId && !!invoiceDate &&
    lines.length > 0 &&
    lines.every((l) => {
      const hasUnitPath = !!l.unit_price_dollars && !!l.quantity && Number(l.quantity) > 0;
      const hasFlatPath = !!l.line_total_dollars;
      if (!hasUnitPath && !hasFlatPath) return false;
      if (l.inventory_item_id && !hasUnitPath) return false; // inventory needs qty
      return true;
    });

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      zIndex: 100, paddingTop: 40, paddingBottom: 40, overflowY: "auto",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10,
        padding: 20, width: 1100, maxWidth: "95vw", color: C.text,
      }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {isNew ? "New AR invoice" : `Edit AR invoice ${invoice?.invoice_number || ""}`}
          {!isNew && (
            <span style={{ marginLeft: 12, fontSize: 12, color: statusColor(invoice!.gl_status) }}>
              ● {invoice!.gl_status}
            </span>
          )}
        </h3>

        {loading ? (
          <div style={{ color: C.textMuted, padding: 24, textAlign: "center" }}>Loading…</div>
        ) : (
          <>
            {!editable && (
              <div style={{ background: "#78350f", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 12 }}>
                This invoice is in status <strong>{invoice!.gl_status}</strong> and cannot be edited. Read-only view.
              </div>
            )}

            {/* Row 1: Customer + Ship-to + Invoice # */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <Field label="Customer">
                <SearchableSelect
                  value={customerId || null}
                  onChange={(v) => { setCustomerId(v); setShipToLocationId(""); }}
                  // Show the clean customer name (matches the costing app's
                  // customer source), not the source-prefixed import code
                  // (EXCEL:/ATS:/XORO:). Still searchable by code via haystack.
                  options={customers.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.name} ${c.customer_code || ""}` }))}
                  placeholder="(pick customer…)"
                  disabled={!editable}
                />
              </Field>
              <Field label="Ship-to location">
                <SearchableSelect
                  value={shipToLocationId || null}
                  onChange={(v) => setShipToLocationId(v)}
                  options={[
                    { value: "", label: "(select)" },
                    ...shipToLocations.map((l) => ({
                      value: l.id,
                      label: l.code ? `${l.code} — ${l.name}` : l.name,
                    })),
                  ]}
                  placeholder={customerId ? "(select)" : "(pick customer first)"}
                  disabled={!editable || !customerId}
                />
              </Field>
              <Field label="Invoice number">
                {/* Always system-assigned at save — never operator-editable. */}
                <input
                  type="text"
                  value={invoice?.invoice_number || ""}
                  readOnly
                  disabled
                  placeholder="(auto-generated on save)"
                  style={{ ...inputStyle, opacity: 0.6 }}
                />
              </Field>
            </div>
            {/* Row 2: Type (standalone) */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <Field label="Type">
                <select value={kind} onChange={(e) => setKind(e.target.value)} disabled={!editable} style={inputStyle as React.CSSProperties}>
                  <option value="customer_invoice">Invoice</option>
                  <option value="customer_credit_memo">Credit memo</option>
                </select>
              </Field>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <Field label="Invoice date">
                <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} disabled={!editable} style={inputStyle} />
              </Field>
              <Field label="Payment terms">
                <SearchableSelect
                  value={paymentTermsId || null}
                  onChange={(v) => setPaymentTermsId(v)}
                  options={[
                    { value: "", label: "(select)" },
                    ...paymentTerms.map((pt) => ({ value: pt.id, label: `${pt.code} — ${pt.name}` })),
                  ]}
                  placeholder="(select)"
                  disabled={!editable}
                />
              </Field>
              <Field label="Due date">
                <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={!editable} style={inputStyle} />
              </Field>
              <Field label="AR account (override)">
                <SearchableSelect
                  value={arAccountId || null}
                  onChange={(v) => setArAccountId(v)}
                  options={[
                    { value: "", label: "(entity default)" },
                    ...accounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
                  ]}
                  placeholder="(entity default)"
                  disabled={!editable}
                />
              </Field>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <Field label="Revenue / offset acct (default)">
                <SearchableSelect
                  value={revenueAccountId || null}
                  onChange={(v) => setRevenueAccountId(v)}
                  options={[
                    { value: "", label: "(entity default)" },
                    ...accounts.filter((a) => a.is_postable).map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
                  ]}
                  placeholder="(entity default)"
                  disabled={!editable}
                />
              </Field>
              <Field label="COGS account">
                <SearchableSelect
                  value={cogsAccountId || null}
                  onChange={(v) => setCogsAccountId(v)}
                  options={[
                    { value: "", label: "(entity default)" },
                    ...accounts.filter((a) => a.is_postable).map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
                  ]}
                  placeholder="(entity default)"
                  disabled={!editable}
                />
              </Field>
              <Field label="Inventory asset">
                <SearchableSelect
                  value={inventoryAccountId || null}
                  onChange={(v) => setInventoryAccountId(v)}
                  options={[
                    { value: "", label: "(entity default)" },
                    ...accounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
                  ]}
                  placeholder="(entity default)"
                  disabled={!editable}
                />
              </Field>
            </div>

            <Field label="Description">
              <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} disabled={!editable} style={inputStyle} placeholder="optional" />
            </Field>

            <div style={{ marginTop: 16, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Lines</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <LineViewToggle value={lineView} onChange={setLineView} />
                {editable && lineView === "list" && (
                  <button type="button" onClick={addLine} style={btnSecondary}>+ Add line</button>
                )}
              </div>
            </div>

            {lineView === "matrix" ? (
              <div style={{ marginBottom: 12 }}>
                <LineColorSizeMatrix entries={matrixData.matrixEntries} />
                {matrixData.fallback.length > 0 && (
                  <div style={{ marginTop: 10, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "8px 12px" }}>
                    <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                      Non-matrix lines (no color/size)
                    </div>
                    {matrixData.fallback.map((f, i) => (
                      <div key={i} style={{ fontSize: 12, color: C.textSub, display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
                        <span>{f.label}</span>
                        {f.qty > 0 && <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace", color: C.textMuted }}>qty {f.qty.toLocaleString()}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
            <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ ...th, width: 36 }}>#</th>
                    <th style={th}>Description</th>
                    <th style={th}>Style (optional)</th>
                    <th style={{ ...th, width: 70 }}>Qty</th>
                    <th style={{ ...th, width: 100 }}>Unit $</th>
                    <th style={{ ...th, width: 110 }}>Or total $</th>
                    <th style={th} title="Revenue account, OR an expense account to offset (e.g. rebilling a vendor for a personal portion of a bill)">Revenue / offset acct</th>
                    <th style={{ ...th, width: 36 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, idx) => (
                    <tr key={l.key}>
                      <td style={td}>{idx + 1}</td>
                      <td style={td}>
                        <input type="text" value={l.description} onChange={(e) => updateLine(idx, { description: e.target.value })} disabled={!editable} style={inputStyle} />
                      </td>
                      <td style={td}>
                        <SearchableSelect
                          value={l.inventory_item_id || null}
                          onChange={(v) => { updateLine(idx, { inventory_item_id: v }); if (v) void suggestPrice(l.key, v, l.quantity, false); }}
                          options={(() => {
                            const opts = [
                              { value: "", label: "(select)" },
                              ...items.map((it) => ({
                                value: it.id,
                                label: `${it.sku_code}${it.description ? ` — ${it.description}` : ""}`,
                                searchHaystack: `${it.sku_code} ${it.style_code || ""} ${it.description || ""} ${it.color || ""} ${it.size || ""}`,
                              })),
                            ];
                            if (l.inventory_item_id && !opts.some((o) => o.value === l.inventory_item_id)) {
                              opts.push({ value: l.inventory_item_id, label: "(saved item)", searchHaystack: l.inventory_item_id });
                            }
                            return opts;
                          })()}
                          placeholder="(select)"
                          disabled={!editable}
                        />
                      </td>
                      <td style={td}>
                        <input type="number" min="0" step="0.0001" value={l.quantity} onChange={(e) => updateLine(idx, { quantity: e.target.value })} disabled={!editable} style={inputStyle} />
                      </td>
                      <td style={td}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <input type="text" value={l.unit_price_dollars} onChange={(e) => updateLine(idx, { unit_price_dollars: e.target.value })} disabled={!editable} placeholder="unit $" style={inputStyle} />
                          {editable && l.inventory_item_id && customerId && <button type="button" title="Suggest price from the pricing engine" onClick={() => void suggestPrice(l.key, l.inventory_item_id, l.quantity, true)} style={{ background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, borderRadius: 4, padding: "2px 6px", cursor: "pointer", fontSize: 12 }}>↻</button>}
                        </div>
                        {priceSrc[l.key] && <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>from {priceSrc[l.key]}</div>}
                      </td>
                      <td style={td}>
                        <input type="text" value={l.line_total_dollars} onChange={(e) => updateLine(idx, { line_total_dollars: e.target.value })} disabled={!editable || (!!l.unit_price_dollars && !!l.quantity)} placeholder="0.00" style={inputStyle} />
                      </td>
                      <td style={td}>
                        <SearchableSelect
                          value={l.revenue_account_id || null}
                          onChange={(v) => updateLine(idx, { revenue_account_id: v })}
                          options={[
                            { value: "", label: "(header default)" },
                            ...accounts.filter((a) => a.is_postable).map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
                          ]}
                          placeholder="(header default)"
                          disabled={!editable}
                        />
                      </td>
                      <td style={td}>
                        {editable && lines.length > 1 && (
                          <button type="button" onClick={() => removeLine(idx)} style={btnDanger}>✕</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td style={td} colSpan={5}>
                      <span style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Total</span>
                    </td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 700 }}>
                      {fmtCents(totalCents.toString())}
                    </td>
                    <td style={td} colSpan={2}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
            )}

            {!isNew && invoice && (
              <div style={{ marginTop: 16, marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Supporting documents</div>
                <DocumentAttachmentList
                  contextTable="ar_invoices"
                  contextId={invoice.id}
                  kinds={["customer_invoice_pdf", "approval_correspondence", "other"]}
                />
              </div>
            )}

            {isNew && editable && (
              <div style={{ marginTop: 16, marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Supporting documents</div>
                <StagedDocsPicker files={stagedDocs} onChange={setStagedDocs} hint="attach the customer invoice / PO; uploaded when you save." />
              </div>
            )}

            {/* Cross-cutter T11-3 — audit trail timeline */}
            {!isNew && invoice && (
              <RowHistory source_table="ar_invoices" source_id={invoice.id} />
            )}

            {err && (
              <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
                {err}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={onClose} style={btnSecondary} disabled={submitting}>Close</button>
              {editable && (
                <button onClick={() => void submit()} style={btnPrimary} disabled={submitting || !formValid}>
                  {submitting ? "Saving…" : (isNew ? "Create draft" : "Save changes")}
                </button>
              )}
            </div>
          </>
        )}
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

function centsToDollarsStr(cents: string | null | undefined): string {
  if (!cents) return "";
  const bi = BigInt(cents);
  const neg = bi < 0n;
  const abs = neg ? -bi : bi;
  const whole = (abs / 100n).toString();
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
