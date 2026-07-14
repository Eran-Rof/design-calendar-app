// src/tanda/InternalAPInvoices.tsx
//
// Tangerine P3 Chunk 2 — Accounts Payable invoice admin UI.
// Lists invoices with status/vendor/date/search filters. Add + Edit modal
// supports vendor dropdown, header expense_account/ap_account pickers,
// and mixed expense/inventory lines. Post / Pay / Void actions wired to the
// dedicated handlers.
//
// Wave 5 adoption sweep (2026-05-30):
//   • TablePrefs — gear-icon column show/hide, persisted per-user under
//     tableKey "tangerine:apinvoices:columns".
//   • Row-click + ScrollHighlight — click anywhere on a list row (except
//     the action buttons) to open the edit modal; the most-recently-clicked
//     row gets a fading blue highlight that re-fires on scroll-back-in.
//   • DynamicSearchInput — replaces the "<input> + Search button" pattern
//     with a 200ms-debounced live-filter input.
//   • SearchableSelect — already adopted for vendor / expense / AP / per-line
//     account pickers; extended in this sweep to the Source filter (11
//     options) and the Pay modal's Bank account picker (chart of accounts
//     can grow past 7 postable bank entries).

import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtDateDisplay } from "../utils/tandaTypes";
import { notify, confirmDialog } from "../shared/ui/warn";
import DocumentAttachmentList from "../shared/documents/DocumentAttachmentList";
import StagedDocsPicker from "../shared/documents/StagedDocsPicker";
import { uploadStagedDocs } from "../shared/documents/uploadDocument";
import ExportButton from "./exports/ExportButton";
import JEDetailModal from "./components/JEDetailModal";
import type { ExportColumn } from "./exports/useTableExport";
import SourceBadge, { SOURCE_OPTIONS } from "./components/SourceBadge";
import SearchableSelect from "./components/SearchableSelect";
// Cross-cutter T11-3 — audit-trail drop-in for the detail modal.
import RowHistory from "./components/RowHistory";
// Wave 5 primitives.
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import DynamicSearchInput from "./components/DynamicSearchInput";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import LineColorSizeMatrix, { type MatrixEntry } from "./components/LineColorSizeMatrix";
import { useItemResolver } from "./hooks/useItemResolver";
import LineViewToggle from "./components/LineViewToggle";
import { readDrillParam } from "./scorecardDrill";

type GlStatus = "draft" | "unposted" | "pending_approval" | "posted" | "paid" | "void" | "reversed";

type APInvoice = {
  id: string;
  entity_id: string;
  vendor_id: string;
  invoice_number: string;
  invoice_kind: string;
  gl_status: GlStatus;
  posting_date: string;
  due_date: string | null;
  description: string | null;
  expense_account_id: string | null;
  ap_account_id: string | null;
  payment_terms_id?: string | null;
  receiving_channel?: "WS" | "EC" | null;
  accrual_je_id: string | null;
  cash_je_id: string | null;
  total_amount_cents: string;
  paid_amount_cents: string;
  source?: string | null;
  created_at: string;
};

type APInvoiceLine = {
  id?: string;
  invoice_id?: string;
  line_number: number;
  description: string | null;
  expense_account_id: string | null;
  inventory_item_id: string | null;
  quantity: number | null;
  unit_cost_cents: string | null;
};

type APInvoiceFull = APInvoice & { lines: APInvoiceLine[] };

type Vendor = { id: string; name: string; vendor_code?: string };
type PaymentTerm = { id: string; code: string; name: string; due_days: number; is_active?: boolean };
type Account = {
  id: string;
  code: string;
  name: string;
  account_type: string;
  is_postable: boolean;
  status: string;
};
type Item = { id: string; sku_code: string; style_code?: string; description?: string; color?: string; size?: string };

type DraftLine = {
  key: number; // stable for React lists
  kind: "expense" | "inventory";
  expense_account_id: string;
  inventory_item_id: string;
  quantity: string;
  amount_dollars: string;     // for expense lines (UI grain = dollars)
  unit_cost_dollars: string;  // for inventory lines
  description: string;
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
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};

function statusColor(s: GlStatus): string {
  if (s === "posted" || s === "paid") return C.success;
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

// Universal column visibility — operator ask #1.
// One TABLE_KEY per panel; per-user hidden-set persists via /preferences.
const AP_INVOICES_TABLE_KEY = "tangerine:apinvoices:columns";
const AP_INVOICES_COLUMNS: ColumnDef[] = [
  { key: "posting_date",   label: "Posting" },
  { key: "due_date",       label: "Due" },
  { key: "vendor",         label: "Vendor" },
  { key: "invoice_number", label: "Invoice #" },
  { key: "gl_status",      label: "Status" },
  { key: "total",          label: "Total" },
  { key: "paid",           label: "Paid" },
];

export default function InternalAPInvoices() {
  const [rows, setRows] = useState<APInvoice[]>([]);
  // Drill-through: bill → its posted journal entry.
  const [jeSeed, setJeSeed] = useState<{ id: string } | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<GlStatus | "">("");
  // Scorecard drill-through: ?vendor=<id> seeds the vendor filter on mount.
  const [vendorFilter, setVendorFilter] = useState(() => readDrillParam("vendor"));
  const [sourceFilter, setSourceFilter] = useState<string>("");
  // Wave 5 — DynamicSearchInput-controlled debounced search (200ms).
  // Scorecard per-line drill: ?q=<invoice_number> seeds the search on mount so a
  // new-tab deep-link lands here filtered to that single invoice (q ilike).
  const { value: search, debouncedValue: searchDebounced, setValue: setSearch } =
    useDebouncedSearch(readDrillParam("q"), 200);
  const [includeVoid, setIncludeVoid] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<APInvoice | null>(null); // null = new
  const [payOpen, setPayOpen] = useState<APInvoice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Universal row-click primitive — open edit modal when any non-interactive
  // cell of the row is clicked (Post / Pay / Void buttons keep their existing
  // stopPropagation safety as well via INTERACTIVE_SELECTOR).
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const { getRowProps } = useRowClickEdit<APInvoice>({
    onRowClick: (inv) => { setEditing(inv); setEditOpen(true); },
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (inv) => `Edit AP invoice ${inv.invoice_number}`,
  });

  // Universal column visibility hook.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    AP_INVOICES_TABLE_KEY,
    AP_INVOICES_COLUMNS,
  );
  const isVisible = useCallback(
    (k: string) => visibleColumns.has(k),
    [visibleColumns],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams({ limit: "200" });
      if (statusFilter) params.set("status", statusFilter);
      if (vendorFilter) params.set("vendor_id", vendorFilter);
      if (sourceFilter) params.set("source", sourceFilter);
      if (searchDebounced.trim()) params.set("q", searchDebounced.trim());
      if (includeVoid) params.set("include_void", "true");
      const r = await fetch(`/api/internal/ap-invoices?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as APInvoice[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, vendorFilter, sourceFilter, searchDebounced, includeVoid]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    fetch("/api/internal/vendors")
      .then((r) => r.json())
      .then((arr: unknown) => {
        if (Array.isArray(arr)) {
          // vendors endpoint shape: {id, name, vendor_code?, ...}
          setVendors(arr as Vendor[]);
        }
      })
      .catch(() => {});
  }, []);

  const vendorMap = useMemo(() => {
    const m: Record<string, Vendor> = {};
    for (const v of vendors) m[v.id] = v;
    return m;
  }, [vendors]);

  // #5 Sortable columns.
  const { sorted: sortedRows, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:apinvoices:sort",
    accessors: {
      posting_date: (inv) => inv.posting_date,
      due_date: (inv) => inv.due_date,
      vendor: (inv) => vendorMap[inv.vendor_id]?.name || inv.vendor_id,
      invoice_number: (inv) => inv.invoice_number,
      gl_status: (inv) => inv.gl_status,
      total: (inv) => Number(inv.total_amount_cents || "0"),
      paid: (inv) => Number(inv.paid_amount_cents || "0"),
    },
  });

  async function doPost(inv: APInvoice) {
    if (!(await confirmDialog(`Post invoice ${inv.invoice_number}? This will create the accrual JE.`))) return;
    setBusy(inv.id);
    try {
      const r = await fetch(`/api/internal/ap-invoices/${inv.id}/post`, { method: "POST" });
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

  async function doVoid(inv: APInvoice) {
    const reason = prompt(`Void invoice ${inv.invoice_number}? Optional reason:`, "");
    if (reason === null) return;
    setBusy(inv.id);
    try {
      const r = await fetch(`/api/internal/ap-invoices/${inv.id}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason || null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      notify(`Void failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>AP Invoices</h2>
        <button onClick={() => { setEditing(null); setEditOpen(true); }} style={btnPrimary}>
          + New invoice
        </button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ width: 180 }}>
          <SearchableSelect
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as GlStatus | "")}
            options={[
              { value: "", label: "All statuses" },
              { value: "draft", label: "Draft" },
              { value: "pending_approval", label: "Pending approval" },
              { value: "posted", label: "Posted" },
              { value: "paid", label: "Paid" },
              { value: "void", label: "Void" },
            ]}
            placeholder="All statuses"
          />
        </div>
        <div style={{ width: 240 }}>
          <SearchableSelect
            value={vendorFilter || null}
            onChange={(v) => setVendorFilter(v)}
            options={[
              { value: "", label: "All vendors" },
              ...vendors.map((v) => ({ value: v.id, label: v.name })),
            ]}
            placeholder="All vendors"
          />
        </div>
        <div style={{ width: 180 }}>
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
        <DynamicSearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search invoice #…"
          ariaLabel="Search AP invoices by invoice number"
          wrapperStyle={{ maxWidth: 240 }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeVoid} onChange={(e) => setIncludeVoid(e.target.checked)} />
          Include void
        </label>
        <TablePrefsButton
          tableKey={AP_INVOICES_TABLE_KEY}
          columns={AP_INVOICES_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
        />
        <ExportButton
          rows={rows.map((inv) => ({
            posting_date: inv.posting_date,
            due_date: inv.due_date,
            vendor: vendorMap[inv.vendor_id]?.name || inv.vendor_id,
            invoice_number: inv.invoice_number,
            invoice_kind: inv.invoice_kind,
            gl_status: inv.gl_status,
            source: inv.source || "manual",
            total_amount_cents: inv.total_amount_cents,
            paid_amount_cents: inv.paid_amount_cents,
            balance_cents: (BigInt(inv.total_amount_cents || "0") - BigInt(inv.paid_amount_cents || "0")).toString(),
            description: inv.description,
          })) as unknown as Array<Record<string, unknown>>}
          filename="ap-invoices"
          sheetName="AP Invoices"
          columns={[
            { key: "posting_date",       header: "Posting", format: "date" },
            { key: "due_date",           header: "Due",     format: "date" },
            { key: "vendor",             header: "Vendor" },
            { key: "invoice_number",     header: "Invoice #" },
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

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No AP invoices.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <SortableTh label="Posting" sortKey="posting_date" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("posting_date")} />
                <SortableTh label="Due" sortKey="due_date" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("due_date")} />
                <SortableTh label="Vendor" sortKey="vendor" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("vendor")} />
                <SortableTh label="Invoice #" sortKey="invoice_number" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("invoice_number")} />
                <SortableTh label="Status" sortKey="gl_status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("gl_status")} />
                <SortableTh label="Total" sortKey="total" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!isVisible("total")} />
                <SortableTh label="Paid" sortKey="paid" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!isVisible("paid")} />
                <th style={{ ...th, width: 260 }}></th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((inv) => {
                const isDraft = inv.gl_status === "draft" || inv.gl_status === "unposted";
                const isPosted = inv.gl_status === "posted";
                const isPaid = inv.gl_status === "paid";
                const isVoid = inv.gl_status === "void" || inv.gl_status === "reversed";
                const isPendingApproval = inv.gl_status === "pending_approval";
                const owedCents = BigInt(inv.total_amount_cents || "0") - BigInt(inv.paid_amount_cents || "0");
                const rowProps = getRowProps(inv);
                return (
                  <ScrollHighlightRow
                    key={inv.id}
                    rowId={inv.id}
                    highlightedRowId={highlightedId}
                    {...rowProps}
                    style={{ ...(rowProps.style || {}), ...(isVoid ? { opacity: 0.5 } : {}) }}
                  >
                    <td style={td} hidden={!isVisible("posting_date")}>{fmtDateDisplay(inv.posting_date)}</td>
                    <td style={td} hidden={!isVisible("due_date")}>{fmtDateDisplay(inv.due_date) || "—"}</td>
                    <td style={td} hidden={!isVisible("vendor")}>{vendorMap[inv.vendor_id]?.name || "—"}</td>
                    <td
                      style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}
                      hidden={!isVisible("invoice_number")}
                    >
                      <span style={{ color: C.primary, fontWeight: 600 }}>{inv.invoice_number}</span>
                      <SourceBadge source={inv.source} />
                    </td>
                    <td style={td} hidden={!isVisible("gl_status")}>
                      {inv.accrual_je_id
                        ? <button type="button"
                            onClick={(e) => { e.stopPropagation(); setJeSeed({ id: inv.accrual_je_id as string }); }}
                            title="Open the journal entry this bill posted"
                            style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0, color: statusColor(inv.gl_status), fontWeight: 600, fontSize: "inherit", textDecoration: "underline" }}>
                            ● {inv.gl_status}
                          </button>
                        : <span style={{ color: statusColor(inv.gl_status), fontWeight: 600 }}>● {inv.gl_status}</span>}
                    </td>
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
                    <td style={{ ...td, textAlign: "right" }}>
                      {isDraft && (
                        <button
                          onClick={(e) => { e.stopPropagation(); void doPost(inv); }} style={btnSuccess}
                          disabled={busy === inv.id}
                        >
                          Post
                        </button>
                      )}
                      {isPendingApproval && (
                        <span style={{ fontSize: 11, color: C.warn }}>Awaiting approval</span>
                      )}
                      {isPosted && owedCents > 0n && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setPayOpen(inv); }} style={btnPrimary}
                          disabled={busy === inv.id}
                        >
                          Pay
                        </button>
                      )}
                      {isPaid && (
                        <span style={{ fontSize: 11, color: C.success }}>Fully paid</span>
                      )}
                      {!isVoid && (
                        <button
                          onClick={(e) => { e.stopPropagation(); void doVoid(inv); }} style={{ ...btnDanger, marginLeft: 6 }}
                          disabled={busy === inv.id}
                        >
                          Void
                        </button>
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
        <APInvoiceModal
          invoice={editing}
          vendors={vendors}
          onClose={() => { setEditOpen(false); setEditing(null); }}
          onSaved={() => { setEditOpen(false); setEditing(null); void load(); }}
        />
      )}

      {payOpen && (
        <APPaymentModal
          invoice={payOpen}
          onClose={() => setPayOpen(null)}
          onPaid={() => { setPayOpen(null); void load(); }}
        />
      )}
      {jeSeed && (
        <JEDetailModal je={jeSeed} onClose={() => setJeSeed(null)} onReversed={() => setJeSeed(null)} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Add / Edit modal
// ─────────────────────────────────────────────────────────────────────
function APInvoiceModal({
  invoice, vendors, onClose, onSaved,
}: {
  invoice: APInvoice | null;
  vendors: Vendor[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = invoice === null;
  const editable = isNew || invoice?.gl_status === "draft" || invoice?.gl_status === "unposted";

  const [vendorId, setVendorId] = useState(invoice?.vendor_id || "");
  const [invoiceNumber, setInvoiceNumber] = useState(invoice?.invoice_number || "");
  const [kind, setKind] = useState(invoice?.invoice_kind || "vendor_bill");
  const [postingDate, setPostingDate] = useState(invoice?.posting_date || new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState(invoice?.due_date || "");
  // P15 — which brand pool side received inventory lands in (WS/EC).
  const [receivingChannel, setReceivingChannel] = useState<"WS" | "EC">(invoice?.receiving_channel === "EC" ? "EC" : "WS");
  const [description, setDescription] = useState(invoice?.description || "");
  const [apAccountId, setApAccountId] = useState(invoice?.ap_account_id || "");
  const [expenseAccountId, setExpenseAccountId] = useState(invoice?.expense_account_id || "");
  const [paymentTermsId, setPaymentTermsId] = useState(invoice?.payment_terms_id || "");
  const [paymentTerms, setPaymentTerms] = useState<PaymentTerm[]>([]);
  // The selected vendor's current defaults (for auto-fill + the write-back prompt).
  const [vendorDefaults, setVendorDefaults] = useState<{ ap: string | null; expense: string | null }>({ ap: null, expense: null });

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [lines, setLines] = useState<DraftLine[]>([
    { key: 1, kind: "expense", expense_account_id: "", inventory_item_id: "", quantity: "1", amount_dollars: "", unit_cost_dollars: "", description: "" },
  ]);
  const [loading, setLoading] = useState(!isNew);
  const [stagedDocs, setStagedDocs] = useState<File[]>([]); // attached before save (new invoice)
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // ▦ Matrix / ☰ List toggle for the lines section.
  const [lineView, setLineView] = useState<"list" | "matrix">("list");

  // Resolve inventory lines' item ids → {color,size} for the matrix view; only
  // inventory lines have an item id (expense lines fall back to the list below).
  const lineItemIds = useMemo(
    () => lines.filter((l) => l.kind === "inventory").map((l) => l.inventory_item_id).filter(Boolean),
    [lines],
  );
  const { itemMap: resolvedItems } = useItemResolver(lineItemIds, lineView === "matrix");
  const matrixData = useMemo(() => {
    const itemLookup = new Map<string, Item>();
    for (const it of items) itemLookup.set(it.id, it);
    const matrixEntries: MatrixEntry[] = [];
    const fallback: { label: string; qty: number }[] = [];
    for (const l of lines) {
      if (l.kind === "expense") {
        fallback.push({ label: l.description || "(expense line)", qty: 0 });
        continue;
      }
      const qty = Number(l.quantity) || 0;
      const resolved = l.inventory_item_id
        ? (resolvedItems.get(l.inventory_item_id) || itemLookup.get(l.inventory_item_id))
        : undefined;
      if (resolved && resolved.color && resolved.size) {
        matrixEntries.push({ color: resolved.color, size: resolved.size, qty });
      } else {
        fallback.push({ label: resolved?.sku_code || l.description || "(inventory line)", qty });
      }
    }
    return { matrixEntries, fallback };
  }, [lines, resolvedItems, items]);

  useEffect(() => {
    fetch("/api/internal/gl-accounts?limit=1000")
      .then((r) => r.json())
      .then((arr: Account[]) => setAccounts(Array.isArray(arr) ? arr.filter((a) => a.status === "active") : []))
      .catch(() => {});
  }, []);

  // Payment-terms master for the Payment Terms picker.
  useEffect(() => {
    fetch("/api/internal/payment-terms")
      .then((r) => (r.ok ? r.json() : []))
      .then((arr: PaymentTerm[]) => setPaymentTerms(Array.isArray(arr) ? arr : []))
      .catch(() => {});
  }, []);

  // #3A — load the selected vendor's items for the inventory-line item picker.
  useEffect(() => {
    if (!vendorId) { setItems([]); return; }
    let cancel = false;
    fetch(`/api/internal/items?vendor_id=${encodeURIComponent(vendorId)}&limit=500`)
      .then((r) => (r.ok ? r.json() : []))
      .then((arr: Item[]) => { if (!cancel) setItems(Array.isArray(arr) ? arr : []); })
      .catch(() => {});
    return () => { cancel = true; };
  }, [vendorId]);

  // On vendor select, load that vendor's default AP + expense accounts and
  // auto-fill the header accounts. New invoice → adopt the vendor's defaults;
  // editing → only fill blanks (don't clobber the invoice's saved coding).
  useEffect(() => {
    if (!vendorId) { setVendorDefaults({ ap: null, expense: null }); return; }
    let cancel = false;
    fetch(`/api/internal/vendor-master/${vendorId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => {
        if (cancel || !v) return;
        const dAp = v.default_gl_ap_account_id || null;
        const dEx = v.default_gl_expense_account_id || null;
        const dTerms = v.payment_terms_id || null;
        setVendorDefaults({ ap: dAp, expense: dEx });
        setApAccountId((prev) => (isNew ? (dAp || "") : (prev || dAp || "")));
        setExpenseAccountId((prev) => (isNew ? (dEx || "") : (prev || dEx || "")));
        // Auto-fill payment terms only when new or the field is still empty —
        // never clobber an explicit edit on an existing invoice.
        if (dTerms) setPaymentTermsId((prev) => (isNew ? dTerms : (prev || dTerms)));
      })
      .catch(() => {});
    return () => { cancel = true; };
  }, [vendorId]);

  // Lazy-load existing lines when editing.
  useEffect(() => {
    if (isNew || !invoice) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/internal/ap-invoices/${invoice.id}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        const full = await r.json() as APInvoiceFull;
        if (cancelled) return;
        if (full.lines?.length > 0) {
          const ll = full.lines.map((l, i) => ({
            key: i + 1,
            kind: (l.inventory_item_id ? "inventory" : "expense") as "expense" | "inventory",
            expense_account_id: l.expense_account_id || "",
            inventory_item_id: l.inventory_item_id || "",
            quantity: l.quantity != null ? String(l.quantity) : "1",
            amount_dollars: l.inventory_item_id ? "" : fmtCentsRaw(centsMul(l.unit_cost_cents, l.quantity)),
            unit_cost_dollars: l.inventory_item_id ? fmtCentsRaw(l.unit_cost_cents) : "",
            description: l.description || "",
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

  function addLine(kind: "expense" | "inventory") {
    setLines((ll) => [...ll, {
      key: (ll[ll.length - 1]?.key || 0) + 1,
      kind,
      expense_account_id: "",
      inventory_item_id: "",
      quantity: "1",
      amount_dollars: "",
      unit_cost_dollars: "",
      description: "",
    }]);
  }
  function updateLine(idx: number, patch: Partial<DraftLine>) {
    setLines((ll) => ll.map((l, i) => i === idx ? { ...l, ...patch } : l));
  }
  function removeLine(idx: number) {
    if (lines.length <= 1) return;
    setLines((ll) => ll.filter((_, i) => i !== idx));
  }

  const totalCents = useMemo(() => {
    let total = 0n;
    for (const l of lines) {
      if (l.kind === "expense") {
        const c = dollarsToCentsBigInt(l.amount_dollars);
        if (c != null) total += c;
      } else {
        const uc = dollarsToCentsBigInt(l.unit_cost_dollars);
        const qty = Number(l.quantity);
        if (uc != null && Number.isFinite(qty)) {
          total += uc * BigInt(Math.round(qty));
        }
      }
    }
    return total;
  }, [lines]);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const apiLines = lines.map((l) => {
        if (l.kind === "inventory") {
          // Lazy-resolve item — if user typed an inventory sku_code we'd need
          // to look it up; for now we send the explicit uuid in the field.
          const uc = dollarsToCentsBigInt(l.unit_cost_dollars);
          return {
            inventory_item_id: l.inventory_item_id,
            quantity: Number(l.quantity),
            unit_cost_cents: uc != null ? uc.toString() : null,
            description: l.description || null,
          };
        }
        const c = dollarsToCentsBigInt(l.amount_dollars);
        return {
          expense_account_id: l.expense_account_id,
          amount_cents: c != null ? c.toString() : null,
          description: l.description || null,
        };
      });

      const body: Record<string, unknown> = {
        vendor_id: vendorId,
        invoice_number: invoiceNumber.trim(),
        invoice_kind: kind,
        posting_date: postingDate,
        due_date: dueDate || null,
        receiving_channel: receivingChannel,
        description: description.trim() || null,
        expense_account_id: expenseAccountId || null,
        ap_account_id: apAccountId || null,
        payment_terms_id: paymentTermsId || null,
        lines: apiLines,
      };

      let r: Response;
      if (isNew) {
        r = await fetch("/api/internal/ap-invoices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        r = await fetch(`/api/internal/ap-invoices/${invoice!.id}`, {
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
          try { await uploadStagedDocs("invoices", created.id, stagedDocs); }
          catch (upErr) { notify(`Invoice saved, but a document upload failed: ${upErr instanceof Error ? upErr.message : String(upErr)}`, "error"); }
        }
      }

      // Offer to write back the chosen accounts as this vendor's defaults when
      // they differ from what's on file (the "set as default for this vendor?"
      // prompt). Best-effort; never blocks the saved invoice.
      const updates: Record<string, string> = {};
      if (apAccountId && apAccountId !== vendorDefaults.ap) updates.default_gl_ap_account_id = apAccountId;
      if (expenseAccountId && expenseAccountId !== vendorDefaults.expense) updates.default_gl_expense_account_id = expenseAccountId;
      if (vendorId && Object.keys(updates).length > 0) {
        const which = [
          updates.default_gl_ap_account_id ? "AP" : null,
          updates.default_gl_expense_account_id ? "expense" : null,
        ].filter(Boolean).join(" + ");
        if (await confirmDialog(`Set the chosen ${which} account${which.includes("+") ? "s" : ""} as the default for this vendor on future invoices?`)) {
          try {
            await fetch(`/api/internal/vendor-master/${vendorId}`, {
              method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updates),
            });
          } catch { /* non-fatal — the invoice already saved */ }
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
    !!vendorId && !!invoiceNumber.trim() && !!postingDate &&
    lines.length > 0 &&
    lines.every((l) =>
      (l.kind === "inventory" &&
        !!l.inventory_item_id && Number(l.quantity) > 0 &&
        dollarsToCentsBigInt(l.unit_cost_dollars) != null) ||
      (l.kind === "expense" &&
        !!l.expense_account_id &&
        (dollarsToCentsBigInt(l.amount_dollars) || 0n) > 0n)
    );

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      zIndex: 100, paddingTop: 40, paddingBottom: 40, overflowY: "auto",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10,
        padding: 20, width: "min(1000px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text,
      }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {isNew ? "New AP invoice" : `Edit AP invoice ${invoice?.invoice_number || ""}`}
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

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <Field label="Vendor">
                <SearchableSelect
                  value={vendorId || null}
                  onChange={(v) => setVendorId(v)}
                  options={vendors.map((v) => ({ value: v.id, label: v.name }))}
                  placeholder="(pick vendor…)"
                  disabled={!editable}
                />
              </Field>
              <Field label="Invoice number">
                <input type="text" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} disabled={!editable} style={inputStyle} />
              </Field>
              <Field label="Type">
                <SearchableSelect
                  value={kind || null}
                  onChange={(v) => setKind(v)}
                  options={[
                    { value: "vendor_bill", label: "Invoice" },
                    { value: "vendor_credit_memo", label: "Credit" },
                    { value: "expense_report", label: "Expense report" },
                  ]}
                  disabled={!editable}
                />
              </Field>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <Field label="Posting date">
                <input type="date" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} disabled={!editable} style={inputStyle} />
              </Field>
              <Field label="Due date">
                <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={!editable} style={inputStyle} />
              </Field>
              <Field label="Payment terms">
                <SearchableSelect
                  value={paymentTermsId || null}
                  onChange={(v) => setPaymentTermsId(v)}
                  options={[
                    { value: "", label: "(none)" },
                    ...paymentTerms.map((t) => ({ value: t.id, label: `${t.name} (${t.due_days}d)` })),
                  ]}
                  placeholder="(defaults from vendor)"
                  disabled={!editable}
                />
              </Field>
              <Field label="Default expense account">
                <SearchableSelect
                  value={expenseAccountId || null}
                  onChange={(v) => setExpenseAccountId(v)}
                  options={[
                    { value: "", label: "(select)" },
                    ...accounts.filter((a) => a.is_postable).map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
                  ]}
                  placeholder="(select)"
                  disabled={!editable}
                />
              </Field>
              <Field label="AP account">
                <SearchableSelect
                  value={apAccountId || null}
                  onChange={(v) => setApAccountId(v)}
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

            {lines.some((l) => l.kind === "inventory") && (
              <div style={{ marginTop: 12 }}>
                <Field label="Receive inventory into (brand pool)">
                  <SearchableSelect
                    value={receivingChannel}
                    onChange={(v) => setReceivingChannel(v as "WS" | "EC")}
                    options={[
                      { value: "WS", label: "Wholesale pool" },
                      { value: "EC", label: "Ecom pool" },
                    ]}
                    disabled={!editable}
                  />
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
                    Received units land in the brand's {receivingChannel === "EC" ? "Ecom" : "Wholesale"} pool when posted (single-pool brands ignore this).
                  </div>
                </Field>
              </div>
            )}

            <div style={{ marginTop: 16, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Lines</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <LineViewToggle value={lineView} onChange={setLineView} />
                {editable && lineView === "list" && (
                  <>
                    <button type="button" onClick={() => addLine("expense")} style={btnSecondary}>+ Expense line</button>
                    <button type="button" onClick={() => addLine("inventory")} style={btnSecondary}>+ Inventory line</button>
                  </>
                )}
              </div>
            </div>

            {lineView === "matrix" ? (
              <div style={{ marginBottom: 12 }}>
                <LineColorSizeMatrix entries={matrixData.matrixEntries} />
                {matrixData.fallback.length > 0 && (
                  <div style={{ marginTop: 10, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "8px 12px" }}>
                    <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                      Non-matrix lines (expense / no color&size)
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
                    <th style={{ ...th, width: 90 }}>Kind</th>
                    <th style={th}>Account / Style</th>
                    <th style={{ ...th, width: 80 }}>Qty</th>
                    <th style={{ ...th, width: 110 }}>Amount $</th>
                    <th style={th}>Description</th>
                    <th style={{ ...th, width: 36 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, idx) => (
                    <tr key={l.key}>
                      <td style={td}>{idx + 1}</td>
                      <td style={td}>
                        <SearchableSelect
                          value={l.kind}
                          onChange={(v) => updateLine(idx, { kind: v as "expense" | "inventory" })}
                          options={[
                            { value: "expense", label: "expense" },
                            { value: "inventory", label: "inventory" },
                          ]}
                          disabled={!editable}
                        />
                      </td>
                      <td style={td}>
                        {l.kind === "expense" ? (
                          <SearchableSelect
                            value={l.expense_account_id || null}
                            onChange={(v) => updateLine(idx, { expense_account_id: v })}
                            options={[
                              { value: "", label: "(pick account…)" },
                              ...accounts.filter((a) => a.is_postable).map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
                            ]}
                            placeholder="(pick account…)"
                            disabled={!editable}
                          />
                        ) : (
                          <SearchableSelect
                            value={l.inventory_item_id || null}
                            onChange={(v) => updateLine(idx, { inventory_item_id: v })}
                            options={(() => {
                              const opts = [
                                { value: "", label: vendorId ? "(pick item…)" : "(select a vendor first)" },
                                ...items.map((it) => ({
                                  value: it.id,
                                  label: `${it.sku_code}${it.description ? ` — ${it.description}` : ""}`,
                                  searchHaystack: `${it.sku_code} ${it.style_code || ""} ${it.description || ""} ${it.color || ""} ${it.size || ""}`,
                                })),
                              ];
                              // Preserve an already-saved item not in the vendor's current list.
                              if (l.inventory_item_id && !opts.some((o) => o.value === l.inventory_item_id)) {
                                opts.push({ value: l.inventory_item_id, label: "(saved item)", searchHaystack: l.inventory_item_id });
                              }
                              return opts;
                            })()}
                            placeholder={vendorId ? "(pick item…)" : "(select a vendor first)"}
                            disabled={!editable || !vendorId}
                          />
                        )}
                      </td>
                      <td style={td}>
                        {l.kind === "inventory" ? (
                          <input type="number" min="0" step="0.0001" value={l.quantity} onChange={(e) => updateLine(idx, { quantity: e.target.value })} disabled={!editable} style={inputStyle} />
                        ) : (
                          <span style={{ color: C.textMuted, fontSize: 11 }}>—</span>
                        )}
                      </td>
                      <td style={td}>
                        {l.kind === "inventory" ? (
                          <input type="text" value={l.unit_cost_dollars} onChange={(e) => updateLine(idx, { unit_cost_dollars: e.target.value })} disabled={!editable} placeholder="unit $" style={inputStyle} />
                        ) : (
                          <input type="text" value={l.amount_dollars} onChange={(e) => updateLine(idx, { amount_dollars: e.target.value })} disabled={!editable} placeholder="0.00" style={inputStyle} />
                        )}
                      </td>
                      <td style={td}>
                        <input type="text" value={l.description} onChange={(e) => updateLine(idx, { description: e.target.value })} disabled={!editable} style={inputStyle} />
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
                    <td style={td} colSpan={4}>
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
                  contextTable="invoices"
                  contextId={invoice.id}
                  kinds={["vendor_invoice_pdf", "receipt", "approval_correspondence", "other"]}
                />
              </div>
            )}

            {isNew && editable && (
              <div style={{ marginTop: 16, marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Supporting documents</div>
                <StagedDocsPicker files={stagedDocs} onChange={setStagedDocs} hint="attach the vendor invoice / receipt; uploaded when you save." />
              </div>
            )}

            {/* Cross-cutter T11-3 — audit trail timeline */}
            {!isNew && invoice && (
              <RowHistory source_table="invoices" source_id={invoice.id} />
            )}

            {err && (
              <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
                {err}
              </div>
            )}

            {/* Sticky action footer — pinned to the bottom of the scrolling
                modal so Save / Close stay reachable on tall invoices. */}
            <div style={{ position: "sticky", bottom: -20, zIndex: 3, background: C.card, borderTop: `1px solid ${C.cardBdr}`, margin: "0 -20px -20px", padding: "12px 20px", display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
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

// ─────────────────────────────────────────────────────────────────────
// Pay modal (sub-modal over the list)
// ─────────────────────────────────────────────────────────────────────
function APPaymentModal({
  invoice, onClose, onPaid,
}: {
  invoice: APInvoice;
  onClose: () => void;
  onPaid: () => void;
}) {
  const owedCents = BigInt(invoice.total_amount_cents || "0") - BigInt(invoice.paid_amount_cents || "0");
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));
  const [amountDollars, setAmountDollars] = useState(centsToDollarsStr(owedCents.toString()));
  const [method, setMethod] = useState("ach");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/internal/gl-accounts?limit=1000")
      .then((r) => r.json())
      .then((arr: Account[]) => setAccounts(Array.isArray(arr) ? arr.filter((a) => a.status === "active" && a.is_postable) : []))
      .catch(() => {});
  }, []);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const c = dollarsToCentsBigInt(amountDollars);
      if (c == null || c <= 0n) throw new Error("Amount must be > 0");
      const body = {
        payment_date: paymentDate,
        amount_cents: c.toString(),
        bank_account_id: bankAccountId || null,
        method,
        reference: reference.trim() || null,
        notes: notes.trim() || null,
      };
      const r = await fetch(`/api/internal/ap-invoices/${invoice.id}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await r.json().catch(() => ({}))) as {
        error?: string; requires_approval?: boolean; approval_request_id?: string;
      };
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      // Maker/checker: a payment at/above the threshold is routed to an
      // approval_request instead of posting. It settles once a DIFFERENT
      // authorized user approves it in the Approvals inbox.
      if (j.requires_approval) {
        notify(
          "Payment submitted for approval (at or above the $5,000 threshold). It will post once a different authorized user approves it in the Approvals inbox.",
          "info",
        );
        onPaid();
        return;
      }
      onPaid();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10,
        padding: 20, width: "min(600px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text,
      }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 18 }}>
          Record payment — invoice {invoice.invoice_number}
        </h3>
        <div style={{ marginBottom: 12, fontSize: 12, color: C.textMuted }}>
          Outstanding: <strong style={{ color: C.text }}>{fmtCents(owedCents.toString())}</strong>
          {" / "}
          Total: {fmtCents(invoice.total_amount_cents)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Payment date">
            <input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Amount $">
            <input type="text" value={amountDollars} onChange={(e) => setAmountDollars(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Method">
            <SearchableSelect
              value={method || null}
              onChange={(v) => setMethod(v)}
              options={[
                { value: "ach", label: "ACH" },
                { value: "wire", label: "Wire" },
                { value: "check", label: "Check" },
                { value: "credit_card", label: "Credit card" },
                { value: "cash", label: "Cash" },
              ]}
            />
          </Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Bank account">
            <SearchableSelect
              value={bankAccountId || null}
              onChange={(v) => setBankAccountId(v)}
              options={[
                { value: "", label: "(entity default)" },
                ...accounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
              ]}
              placeholder="(entity default)"
            />
          </Field>
          <Field label="Reference">
            <input type="text" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="check #, wire confirm, etc" style={inputStyle} />
          </Field>
        </div>
        <Field label="Notes">
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" style={inputStyle} />
        </Field>

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 13 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting}>
            {submitting ? "Posting…" : "Record payment"}
          </button>
        </div>
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

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────
function centsMul(unitCostCents: string | null, qty: number | null): string {
  if (!unitCostCents) return "0";
  const uc = BigInt(unitCostCents);
  const q = BigInt(Math.round(qty ?? 1));
  return (uc * q).toString();
}
function fmtCentsRaw(cents: string | null): string {
  if (!cents) return "";
  const bi = BigInt(cents);
  const neg = bi < 0n;
  const abs = neg ? -bi : bi;
  const whole = (abs / 100n).toString();
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
function centsToDollarsStr(cents: string | null | undefined): string {
  return fmtCentsRaw(cents || null);
}
