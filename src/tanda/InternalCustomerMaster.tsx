// src/tanda/InternalCustomerMaster.tsx
//
// Tangerine P1 Chunk 7c — internal admin panel for customers (M36) CRUD.
// List + search + customer-type filter + status toggle + create + edit +
// soft-delete. Wraps /api/internal/customer-master and
// /api/internal/customer-master/:id.
//
// tax_exempt_certificate is editable as a plain text field (certificate number).
// The dedicated PII workflow for more sensitive cert handling is not yet built.
//
// Wave 5 primitive adoption (2026-05-30):
//   • TablePrefs        — per-user column show/hide (gear button) for the
//                         list grid; persists via user_preferences.
//   • Row-click + Scroll
//     Highlight         — click anywhere on a row to open the edit modal;
//                         briefly fades a highlight on the clicked row.
//   • DynamicSearchInput — debounced (200 ms) search-as-you-type, replacing
//                         the previous text input + explicit Search button.
//   • SearchableSelect  — applied to the Payment-terms picker in the edit
//                         modal (the only DB-driven dropdown that can grow
//                         beyond ~7 entries). Customer-type / status /
//                         type-filter selects are 3–5 fixed enum values, so
//                         native <select> remains the right choice there.

import { useCallback, useEffect, useMemo, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import { displayCustomerCode } from "../shared/customers/displayCustomerCode";
import DocumentAttachmentList from "../shared/documents/DocumentAttachmentList";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
// Cross-cutter T11-3 — audit-trail drop-in for the customer detail modal.
import RowHistory from "./components/RowHistory";
import AddressFields, { type Address } from "./components/AddressFields";
import { type Contact } from "./components/ContactList";
import BuyersEditor from "./components/BuyersEditor";
import CustomerContactNotes from "./components/CustomerContactNotes";
import MailLink from "./components/MailLink";
import { formatUsPhone } from "../shared/phone";
import CustomerLocations from "./components/CustomerLocations";
// Wave 5 primitives.
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";
import DynamicSearchInput from "./components/DynamicSearchInput";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import { useSearchSeed } from "./hooks/useSearchSeed";
import SearchableSelect, { type SearchableSelectOption } from "./components/SearchableSelect";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
// Chunk E — per-row drill-through scorecard (opened by the ℹ️ button).
import CustomerScorecard from "./CustomerScorecard";

type Customer = {
  id: string;
  entity_id: string;
  customer_code: string | null;
  code: string | null;
  name: string;
  parent_customer_id: string | null;
  customer_tier: string | null;
  country: string | null;
  channel_id: string | null;
  customer_type: string;
  // P4-family sales-rep / default / GL-routing columns.
  sales_rep_1_id: string | null;
  sales_rep_1_commission_pct: number | string | null;
  sales_rep_2_id: string | null;
  sales_rep_2_commission_pct: number | string | null;
  closeout_commission_pct: number | string | null;
  default_brand_id: string | null;
  default_channel_id: string | null;
  price_list_id: string | null;
  default_revenue_account_id: string | null;
  default_returns_account_id: string | null;
  default_cogs_account_id: string | null;
  default_ar_account_id: string | null;
  payment_terms: string | null;       // legacy free-text (read-only display)
  payment_terms_id: string | null;    // P3-9 structured FK
  default_currency: string;
  tax_exempt: boolean;
  tax_exempt_certificate: string | null;
  credit_limit: number | string | null;
  credit_limit_cents: number | string | null;
  credit_limit_currency: string | null;
  // Chunk K — customer factoring (operator item 17).
  is_factored: boolean | null;
  factor_id: string | null;
  status: string;
  billing_address: Record<string, unknown>;
  shipping_address: Record<string, unknown>;
  contact_name: string | null;
  contact_title: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  wechat_id: string | null;
  contacts: Contact[] | null;
  attributes: Record<string, unknown>;
  active: boolean | null;
  external_refs: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type GlAccount = {
  id: string;
  code: string;
  name: string;
  is_postable: boolean;
  status: string;
};

type Employee = {
  id: string;
  code: string | null;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  title: string | null;
  is_active: boolean;
};

type Brand = { id: string; code: string; name: string; is_default?: boolean };
type Channel = { id: string; code: string; name: string };
// Chunk K — factor / credit-insurance master (operator item 17).
type Factor = { id: string; code: string; name: string };

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const CUSTOMER_TYPE_OPTIONS = ["wholesale", "ecom", "showroom", "employee", "other"];
const STATUS_OPTIONS = ["active", "inactive", "on_hold"];

type PaymentTermOption = {
  id: string;
  code: string;
  name: string;
  due_days: number;
  is_active: boolean;
};

// Wave 5 — per-user column visibility for the customer list grid.
const CUSTOMER_MASTER_TABLE_KEY = "tangerine:customermaster:columns";
const CUSTOMER_MASTER_COLUMNS: ColumnDef[] = [
  { key: "code",           label: "Code"          },
  { key: "name",           label: "Name"          },
  { key: "customer_type",  label: "Type"          },
  { key: "country",        label: "Country"       },
  { key: "status",         label: "Status"        },
  { key: "credit_limit",   label: "Credit Limit"  },
  { key: "payment_terms",  label: "Payment Terms" },
];

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const btnDanger: React.CSSProperties = {
  ...btnSecondary, color: C.danger, borderColor: "#7f1d1d",
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
  colorScheme: "dark",
};
// Chunk M — greyed, read-only display for server-generated codes (operator item 14).
const readonlyCodeStyle: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, border: `1px dashed ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
  boxSizing: "border-box", display: "flex", alignItems: "center",
  fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600,
  opacity: 0.85,
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

function fmtMoney(n: number | string | null | undefined): string {
  if (n == null || n === "") return "—";
  const num = typeof n === "number" ? n : parseFloat(n);
  if (!Number.isFinite(num)) return "—";
  return num.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function statusPill(s: string): React.CSSProperties {
  const map: Record<string, { bg: string; color: string }> = {
    active:   { bg: "#064e3b", color: "#6ee7b7" },
    inactive: { bg: "#374151", color: "#d1d5db" },
    on_hold:  { bg: "#78350f", color: "#fcd34d" },
  };
  const c = map[s] || map.inactive;
  return {
    display: "inline-block", padding: "2px 8px", borderRadius: 10,
    background: c.bg, color: c.color, fontSize: 11, fontWeight: 600,
    textTransform: "uppercase", letterSpacing: 0.5,
  };
}

export default function InternalCustomerMaster() {
  const [rows, setRows] = useState<Customer[]>([]);
  const [paymentTerms, setPaymentTerms] = useState<PaymentTermOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Wave 5 — search-as-you-type. Synchronous `q` binds to the input so
  // typing feels instant; `qDebounced` drives the fetch (200 ms cadence,
  // matching the COA panel and the T6 GlobalSearchPalette).
  const { value: q, debouncedValue: qDebounced, setValue: setQ } = useDebouncedSearch(useSearchSeed(), 200);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [typeFilter, setTypeFilter] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  // Chunk E — customer whose scorecard drawer is open (null = closed).
  const [scorecardId, setScorecardId] = useState<string | null>(null);
  // Deep-link from a contact-reminder notification:
  //   ?m=customer_master&open=<customer_id>[&tab=payable&contact=<id>&note=<id>]
  const [deep, setDeep] = useState<{ openId: string; tab?: "payable"; contact?: string | null; note?: string | null } | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const open = p.get("open");
    if (open) setDeep({ openId: open, tab: "payable", contact: p.get("contact"), note: p.get("note") });
  }, []);
  // Once the list has loaded, open the deep-linked customer (once).
  useEffect(() => {
    if (!deep || editing || rows.length === 0) return;
    const c = rows.find((x) => x.id === deep.openId);
    if (c) setEditing(c);
  }, [deep, rows, editing]);

  // Wave 5 — row-click opens the edit modal; soft-deleted rows are
  // non-interactive (matches the existing "Edit / Delete buttons hidden
  // when deleted_at is set" rule).
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const { getRowProps } = useRowClickEdit<Customer>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit customer ${r.code || r.customer_code || r.name}`,
    disabled: (r) => !!r.deleted_at,
  });

  // Wave 5 — column visibility (gear button next to search).
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    CUSTOMER_MASTER_TABLE_KEY,
    CUSTOMER_MASTER_COLUMNS,
  );
  const isVisible = useCallback((k: string) => visibleColumns.has(k), [visibleColumns]);

  // payment_terms renders a resolved lookup (not a row scalar), so it stays
  // non-sortable.
  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:customermaster:sort",
    accessors: { code: (r) => r.code || r.customer_code },
  });

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (qDebounced.trim()) params.set("q", qDebounced.trim());
      if (includeInactive) params.set("include_inactive", "true");
      if (typeFilter) params.set("customer_type", typeFilter);
      const [custRes, ptRes] = await Promise.all([
        fetch(`/api/internal/customer-master?${params.toString()}`),
        fetch(`/api/internal/payment-terms`),
      ]);
      if (!custRes.ok) throw new Error((await custRes.json().catch(() => ({}))).error || `HTTP ${custRes.status}`);
      setRows(await custRes.json() as Customer[]);
      if (ptRes.ok) {
        setPaymentTerms(await ptRes.json() as PaymentTermOption[]);
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [qDebounced, includeInactive, typeFilter]);

  useEffect(() => { void load(); }, [load]);

  const termById = useMemo(
    () => new Map(paymentTerms.map((t) => [t.id, t])),
    [paymentTerms],
  );

  async function softDelete(c: Customer) {
    if (!(await confirmDialog(`Deactivate this customer?\n\n${c.name}\n\nThis soft-deletes the row. An admin can restore via SQL.`))) return;
    try {
      const r = await fetch(`/api/internal/customer-master/${c.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Customer Master</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add customer</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <DynamicSearchInput
          value={q}
          onChange={setQ}
          placeholder="Search name, code, or customer_code…"
          ariaLabel="Search customers"
          wrapperStyle={{ maxWidth: 360 }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <span style={{ textTransform: "uppercase", letterSpacing: 0.5, fontSize: 11, color: C.textMuted }}>Type</span>
          {/*
            Native <select> retained — only 5 fixed enum values, well under
            the >7 threshold where SearchableSelect's type-ahead becomes
            useful.
          */}
          <SearchableSelect
            value={typeFilter || null}
            onChange={(v) => setTypeFilter(v)}
            options={[{ value: "", label: "(all)" }, ...CUSTOMER_TYPE_OPTIONS.map((t) => ({ value: t, label: t }))]}
            inputStyle={{ ...inputStyle, width: 140 }}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Show inactive
        </label>
        <TablePrefsButton
          tableKey={CUSTOMER_MASTER_TABLE_KEY}
          columns={CUSTOMER_MASTER_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
        />
        <ExportButton
          rows={rows as unknown as Array<Record<string, unknown>>}
          filename="customers"
          sheetName="Customers"
          columns={[
            { key: "code",             header: "Code" },
            { key: "customer_code",    header: "Customer Code" },
            { key: "name",             header: "Name" },
            { key: "customer_type",    header: "Type" },
            { key: "customer_tier",    header: "Tier" },
            { key: "country",          header: "Country" },
            { key: "status",           header: "Status" },
            { key: "credit_limit",     header: "Credit Limit", format: "number" },
            { key: "payment_terms",    header: "Payment Terms" },
            { key: "default_currency", header: "Currency" },
            { key: "tax_exempt",       header: "Tax Exempt" },
            { key: "created_at",       header: "Created", format: "datetime" },
            { key: "updated_at",       header: "Updated", format: "datetime" },
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
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No customers found.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <SortableTh label="Code" sortKey="code" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("code")} />
                <SortableTh label="Name" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("name")} />
                <SortableTh label="Type" sortKey="customer_type" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("customer_type")} />
                <SortableTh label="Country" sortKey="country" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("country")} />
                <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("status")} />
                <SortableTh label="Credit Limit" sortKey="credit_limit" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!isVisible("credit_limit")} />
                <th style={th} hidden={!isVisible("payment_terms")}>Payment Terms</th>
                <th style={{ ...th, width: 180 }}></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <ScrollHighlightRow
                  key={r.id}
                  rowId={r.id}
                  highlightedRowId={highlightedId}
                  {...getRowProps(r)}
                  style={r.deleted_at ? { opacity: 0.4 } : undefined}
                >
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }} hidden={!isVisible("code")}>
                    {displayCustomerCode(r.code || r.customer_code) || "—"}
                  </td>
                  <td style={td} hidden={!isVisible("name")}>{r.name}</td>
                  <td style={td} hidden={!isVisible("customer_type")}>{r.customer_type}</td>
                  <td style={td} hidden={!isVisible("country")}>{r.country || "—"}</td>
                  <td style={td} hidden={!isVisible("status")}><span style={statusPill(r.status)}>{r.status}</span></td>
                  <td
                    style={{ ...td, textAlign: "right", fontFamily: "SFMono-Regular, Menlo, monospace" }}
                    hidden={!isVisible("credit_limit")}
                  >
                    {fmtMoney(r.credit_limit)}
                  </td>
                  <td style={td} hidden={!isVisible("payment_terms")}>
                    {r.payment_terms_id ? (
                      termById.get(r.payment_terms_id)?.code || "—"
                    ) : r.payment_terms ? (
                      <span style={{ color: C.textMuted, fontStyle: "italic" }} title="Legacy free-text — edit to migrate to structured term">{r.payment_terms}</span>
                    ) : "—"}
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    {/* Three separate, fully-framed buttons inline (each its own
                        bordered box, spaced — not joined, not borderless). */}
                    <div style={{ display: "inline-flex", gap: 8, verticalAlign: "middle" }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); setScorecardId(r.id); }}
                        style={{ ...btnSecondary, color: C.primary, borderColor: C.primary, fontWeight: 600 }}
                        title="Open customer scorecard (balance, purchases, margin, dilution, commission, invoices, SOs, JE)"
                        aria-label={`Open scorecard for ${r.name}`}
                      >
                        Scorecard
                      </button>
                      {!r.deleted_at && (
                        <>
                          <button onClick={(e) => { e.stopPropagation(); setEditing(r); }} style={btnSecondary}>Edit</button>
                          <button onClick={(e) => { e.stopPropagation(); void softDelete(r); }} style={btnDanger}>Delete</button>
                        </>
                      )}
                    </div>
                  </td>
                </ScrollHighlightRow>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && (
        <CustomerFormModal
          mode="add"
          paymentTerms={paymentTerms}
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); void load(); }}
        />
      )}
      {editing && (
        <CustomerFormModal
          mode="edit"
          customer={editing}
          paymentTerms={paymentTerms}
          initialTab={deep && deep.openId === editing.id ? deep.tab : undefined}
          initialContactId={deep && deep.openId === editing.id ? deep.contact : undefined}
          initialNoteId={deep && deep.openId === editing.id ? deep.note : undefined}
          onClose={() => { setEditing(null); setDeep(null); }}
          onSaved={() => { setEditing(null); setDeep(null); void load(); }}
        />
      )}
      {scorecardId && (
        <CustomerScorecard customerId={scorecardId} onClose={() => setScorecardId(null)} />
      )}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  customer?: Customer;
  paymentTerms: PaymentTermOption[];
  onClose: () => void;
  onSaved: () => void;
  // Deep-link (from a contact-reminder notification): open straight to a tab /
  // contact and highlight a note.
  initialTab?: "details" | "reps" | "gl" | "addresses" | "buyers" | "payable" | "styles";
  initialContactId?: string | null;
  initialNoteId?: string | null;
}

function CustomerFormModal({ mode, customer, paymentTerms, onClose, onSaved, initialTab, initialContactId, initialNoteId }: ModalProps) {
  // Initial credit_limit display value (in dollars). Prefer the canonical
  // credit_limit_cents (P4-7) and fall back to the legacy numeric credit_limit
  // column for rows that haven't been re-saved since P4-7.
  // Whole-dollar integer string (no decimals) — the field shows comma-formatted
  // whole dollars per operator request; cents precision isn't used for limits.
  const initCreditLimitDollars =
    customer?.credit_limit_cents != null && customer.credit_limit_cents !== ""
      ? String(Math.round(Number(customer.credit_limit_cents) / 100))
      : customer?.credit_limit != null
        ? String(Math.round(Number(customer.credit_limit)))
        : "";
  const [form, setForm] = useState({
    name:                         customer?.name                         ?? "",
    code:                         customer?.code                         ?? "",
    customer_type:                customer?.customer_type                ?? "wholesale",
    // Operator request — new customers default to the US market.
    country:                      customer?.country                      ?? (mode === "add" ? "US" : ""),
    payment_terms_id:             customer?.payment_terms_id             ?? "",
    default_currency:             customer?.default_currency             ?? "USD",
    // New customers default to tax-exempt=true (operator request).
    tax_exempt:                   mode === "add" ? true : (customer?.tax_exempt ?? false),
    credit_limit:                 initCreditLimitDollars,
    credit_limit_currency:        customer?.credit_limit_currency        ?? "USD",
    // Chunk K — customer factoring (operator item 17).
    is_factored:                  customer?.is_factored                  ?? false,
    factor_id:                    customer?.factor_id                    ?? "",
    status:                       customer?.status                       ?? "active",
    billing_address:              (customer?.billing_address && typeof customer.billing_address === "object"
                                    ? customer.billing_address : {}) as Address,
    shipping_address:             (customer?.shipping_address && typeof customer.shipping_address === "object"
                                    ? customer.shipping_address : {}) as Address,
    // P4-family sales-rep / default / GL-routing fields.
    sales_rep_1_id:               customer?.sales_rep_1_id               ?? "",
    sales_rep_1_commission_pct:   customer?.sales_rep_1_commission_pct != null ? String(customer.sales_rep_1_commission_pct) : "",
    sales_rep_2_id:               customer?.sales_rep_2_id               ?? "",
    sales_rep_2_commission_pct:   customer?.sales_rep_2_commission_pct != null ? String(customer.sales_rep_2_commission_pct) : "",
    closeout_commission_pct:      customer?.closeout_commission_pct != null ? String(customer.closeout_commission_pct) : "",
    default_brand_id:             customer?.default_brand_id             ?? "",
    default_channel_id:           customer?.default_channel_id           ?? "",
    price_list_id:                customer?.price_list_id                ?? "",
    default_revenue_account_id:   customer?.default_revenue_account_id   ?? "",
    default_returns_account_id:   customer?.default_returns_account_id   ?? "",
    default_cogs_account_id:      customer?.default_cogs_account_id      ?? "",
    default_ar_account_id:        customer?.default_ar_account_id        ?? "",
    contact_name:                 customer?.contact_name                 ?? "",
    contact_title:                customer?.contact_title                ?? "",
    email:                        customer?.email                        ?? "",
    phone:                        customer?.phone                        ?? "",
    website:                      customer?.website                      ?? "",
    wechat_id:                    customer?.wechat_id                    ?? "",
    // Stamp a stable id on any contact missing one so notes can attach (persists on save).
    contacts:                     ((Array.isArray(customer?.contacts) ? customer!.contacts : []) as Contact[])
                                    .map((c) => (c && c.id ? c : { ...c, id: (globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2)) })),
  });
  const [countries, setCountries] = useState<{ iso2: string; name: string }[]>([]);
  const [glAccounts, setGlAccounts] = useState<GlAccount[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [priceLists, setPriceLists] = useState<{ id: string; code: string; name: string }[]>([]);
  const [factors, setFactors] = useState<Factor[]>([]);
  const [tab, setTab] = useState<"details" | "reps" | "gl" | "addresses" | "buyers" | "payable" | "styles">(initialTab ?? "details");
  // Which contact's notes panel is expanded (by contact id) on the AP/Trans/CB tab.
  const [notesOpenId, setNotesOpenId] = useState<string | null>(initialContactId ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/internal/countries")
      .then((r) => (r.ok ? r.json() : []))
      .then((arr) => setCountries(Array.isArray(arr) ? arr as { iso2: string; name: string }[] : []))
      .catch(() => {});
    fetch("/api/internal/gl-accounts?limit=1000")
      .then((r) => r.json())
      .then((arr: GlAccount[]) => setGlAccounts(Array.isArray(arr) ? arr.filter((a) => a.status === "active") : []))
      .catch(() => {});
    fetch("/api/internal/employees")
      .then((r) => r.json())
      .then((arr: Employee[]) => setEmployees(Array.isArray(arr) ? arr : []))
      .catch(() => {});
    fetch("/api/internal/brands")
      .then((r) => r.json())
      .then((j: { brands?: Brand[] }) => setBrands(Array.isArray(j?.brands) ? j.brands : []))
      .catch(() => {});
    fetch("/api/internal/channels")
      .then((r) => r.json())
      .then((j: { channels?: Channel[] }) => setChannels(Array.isArray(j?.channels) ? j.channels : []))
      .catch(() => {});
    // M43 — price lists for the customer's assigned-list picker.
    fetch("/api/internal/price-lists")
      .then((r) => r.json())
      .then((arr) => setPriceLists(Array.isArray(arr) ? arr.map((l: { id: string; code: string; name: string }) => ({ id: l.id, code: l.code, name: l.name })) : []))
      .catch(() => {});
    // Chunk K — factor / credit-insurance master (operator item 17).
    fetch("/api/internal/factors")
      .then((r) => r.json())
      .then((arr: Factor[]) => setFactors(Array.isArray(arr) ? arr : []))
      .catch(() => {});
  }, []);

  // GL routing pickers (Tab 3) — postable AND active accounts only. Label shows
  // the account NAME only (code searchable) per operator "name not code" ask.
  const glRoutingOptions: SearchableSelectOption[] = useMemo(() => [
    { value: "", label: "(select)" },
    ...glAccounts.filter((a) => a.is_postable && a.status === "active").map((a) => ({
      value: a.id,
      label: a.name,
      searchHaystack: `${a.code} ${a.name}`,
    })),
  ], [glAccounts]);

  // Sales-rep pickers (Tab 2) — employees by display name.
  const employeeOptions: SearchableSelectOption[] = useMemo(() => [
    { value: "", label: "(select)" },
    ...employees.map((e) => {
      const label = e.display_name || `${e.first_name ?? ""} ${e.last_name ?? ""}`.trim() || e.code || e.id;
      return {
        value: e.id,
        label: e.title ? `${label} — ${e.title}` : label,
        searchHaystack: `${label} ${e.code ?? ""} ${e.title ?? ""}`,
      };
    }),
  ], [employees]);

  const brandOptions: SearchableSelectOption[] = useMemo(() => [
    { value: "", label: "(select)" },
    ...brands.map((b) => ({ value: b.id, label: b.name, searchHaystack: `${b.code} ${b.name}` })),
  ], [brands]);

  const channelOptions: SearchableSelectOption[] = useMemo(() => [
    { value: "", label: "(select)" },
    ...channels.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.code} ${c.name}` })),
  ], [channels]);

  // Chunk K — factor picker (operator item 17). Label = factor name (with
  // code as search haystack). Keep the current factor in the list even if it
  // were de-activated so an edit shows the existing selection.
  const factorOptions: SearchableSelectOption[] = useMemo(() => [
    { value: "", label: "(select)" },
    ...factors.map((f) => ({ value: f.id, label: f.name, searchHaystack: `${f.code} ${f.name}` })),
  ], [factors]);

  // Country picker from country_master (stored as ISO-2, e.g. "US"). A legacy
  // free-text value not in the master is injected as a one-off option so it
  // still shows and isn't dropped on save.
  const countryOptions: SearchableSelectOption[] = useMemo(() => {
    const opts = countries.map((c) => ({ value: c.iso2, label: c.name, searchHaystack: `${c.name} ${c.iso2}` }));
    const cur = form.country;
    if (cur && !opts.some((o) => o.value === cur)) opts.unshift({ value: cur, label: cur, searchHaystack: cur });
    return opts;
  }, [countries, form.country]);

  // Wave 5 — payment-terms picker is the only modal dropdown whose option
  // list comes from a DB table (payment_terms) and can grow beyond a
  // handful, so we route it through SearchableSelect. The customer_type
  // and status selects below stay as native <select> elements (5 and 3
  // fixed enum values respectively).
  const paymentTermsOptions: SearchableSelectOption[] = useMemo(() => {
    const active = paymentTerms.filter((t) => t.is_active || t.id === form.payment_terms_id);
    return [
      { value: "", label: "(select)" },
      ...active.map((t) => ({
        value: t.id,
        label: `${t.name} (${t.due_days}d)`,
        // Make the search match on the code, name, and the formatted due-days
        // chunk so an operator typing "n30" / "net 30" / "30d" all land.
        searchHaystack: `${t.code} ${t.name} ${t.due_days}d net${t.due_days}`,
      })),
    ];
  }, [paymentTerms, form.payment_terms_id]);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const dollars =
        form.credit_limit.trim() === "" ? null : parseFloat(form.credit_limit);
      // P4-7: write BOTH legacy credit_limit (dollars) AND canonical
      // credit_limit_cents so the credit-gate has a single source of truth.
      const creditCents =
        dollars == null || !Number.isFinite(dollars) ? null : Math.round(dollars * 100);
      // Parse billing/shipping address JSON blobs (textarea input).
      const body: Record<string, unknown> = {
        name:                         form.name.trim(),
        // Chunk M — code is server-generated; never sent from the client.
        customer_type:                form.customer_type,
        country:                      form.country.trim() || null,
        // P3-9: structured FK. Legacy text column stays read-only display.
        payment_terms_id:             form.payment_terms_id || null,
        default_currency:             form.default_currency.trim().toUpperCase() || "USD",
        tax_exempt:                   !!form.tax_exempt,
        credit_limit:                 dollars,
        credit_limit_cents:           creditCents,
        credit_limit_currency:        creditCents == null
          ? null
          : (form.credit_limit_currency.trim().toUpperCase() || "USD"),
        // Chunk K — customer factoring (operator item 17). When not factored,
        // always clear the factor link.
        is_factored:                  !!form.is_factored,
        factor_id:                    form.is_factored ? (form.factor_id || null) : null,
        status:                       form.status,
        billing_address:              form.billing_address,
        shipping_address:             form.shipping_address,
        // P4-family sales-rep / default / GL-routing fields.
        sales_rep_1_id:               form.sales_rep_1_id || null,
        sales_rep_1_commission_pct:   form.sales_rep_1_commission_pct.trim() === "" ? null : parseFloat(form.sales_rep_1_commission_pct),
        sales_rep_2_id:               form.sales_rep_2_id || null,
        sales_rep_2_commission_pct:   form.sales_rep_2_commission_pct.trim() === "" ? null : parseFloat(form.sales_rep_2_commission_pct),
        closeout_commission_pct:      form.closeout_commission_pct.trim() === "" ? null : parseFloat(form.closeout_commission_pct),
        default_brand_id:             form.default_brand_id || null,
        default_channel_id:           form.default_channel_id || null,
        price_list_id:                form.price_list_id || null,
        default_revenue_account_id:   form.default_revenue_account_id || null,
        default_returns_account_id:   form.default_returns_account_id || null,
        default_cogs_account_id:      form.default_cogs_account_id || null,
        default_ar_account_id:        form.default_ar_account_id || null,
        contact_name:                 form.contact_name.trim() || null,
        contact_title:                form.contact_title.trim() || null,
        email:                        form.email.trim() || null,
        phone:                        form.phone.trim() || null,
        website:                      form.website.trim() || null,
        wechat_id:                    form.wechat_id.trim() || null,
        // Up to 12 additional contacts; drop fully-blank rows on save.
        contacts:                     form.contacts.filter((c) => Object.values(c).some((x) => String(x ?? "").trim() !== "")),
      };
      let url: string;
      let method: string;
      if (mode === "add") {
        url = "/api/internal/customer-master";
        method = "POST";
      } else {
        url = `/api/internal/customer-master/${customer!.id}`;
        method = "PATCH";
      }
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(760px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {mode === "add" ? "Add customer" : `Edit ${customer!.name}`}
        </h3>

        {/* Tab bar */}
        <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.cardBdr}`, marginBottom: 16 }}>
          {([
            ["details", "Details"],
            ["reps", "Reps & Defaults"],
            ["gl", "GL Accounts"],
            ["addresses", "Addresses & Locations"],
            ["buyers", "Buyers"],
            ["payable", "AP/Trans/CBs"],
            ["styles", "Style numbers"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={{
                background: "transparent",
                border: 0,
                borderBottom: tab === key ? `2px solid ${C.primary}` : "2px solid transparent",
                color: tab === key ? C.text : C.textMuted,
                padding: "8px 12px",
                fontSize: 13,
                fontWeight: tab === key ? 600 : 500,
                cursor: "pointer",
                marginBottom: -1,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={{ display: tab === "details" ? "grid" : "none", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Name *">
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              style={inputStyle}
              placeholder="Customer display name"
              autoFocus
            />
          </Field>
          <Field label="Code">
            {/* Chunk M — codes are server-generated + read-only (operator item 14). */}
            <div style={readonlyCodeStyle}>
              {mode === "add"
                ? <span style={{ color: C.textMuted, fontStyle: "italic", fontFamily: "inherit" }}>(auto-generated on save)</span>
                : (displayCustomerCode(customer?.code) || "—")}
            </div>
          </Field>
          <Field label="Customer type">
            <SearchableSelect
              value={form.customer_type || null}
              onChange={(v) => setForm({ ...form, customer_type: v })}
              options={CUSTOMER_TYPE_OPTIONS.map((t) => ({ value: t, label: t }))}
              inputStyle={inputStyle as React.CSSProperties}
            />
          </Field>
          <Field label="Country">
            <SearchableSelect
              value={form.country || null}
              onChange={(v) => setForm({ ...form, country: v })}
              options={countryOptions}
              placeholder="Pick a country…"
            />
          </Field>
          <Field label="Payment terms">
            <SearchableSelect
              value={form.payment_terms_id || null}
              onChange={(v) => setForm({ ...form, payment_terms_id: v })}
              options={paymentTermsOptions}
              placeholder="Pick a payment term…"
            />
            {mode === "edit" && customer?.payment_terms && !form.payment_terms_id && (
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, fontStyle: "italic" }}>
                Legacy free-text: &quot;{customer.payment_terms}&quot; — pick from list to migrate.
              </div>
            )}
          </Field>
          <Field label="Default currency">
            <input type="text" value={form.default_currency} onChange={(e) => setForm({ ...form, default_currency: e.target.value.toUpperCase() })} style={inputStyle} placeholder="USD" maxLength={3} />
          </Field>
          <Field label="Credit limit">
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ color: C.textMuted, fontSize: 13 }}>$</span>
              <input
                type="text"
                inputMode="numeric"
                value={form.credit_limit ? Number(form.credit_limit).toLocaleString("en-US") : ""}
                onChange={(e) => setForm({ ...form, credit_limit: e.target.value.replace(/[^0-9]/g, "").slice(0, 12) })}
                style={{ ...inputStyle, width: "16ch", flex: "0 0 auto" }}
                placeholder="0"
                title="Whole dollars, up to 12 digits. 0 or blank = no credit limit (no gate)"
              />
              <input
                type="text"
                value={form.credit_limit_currency}
                onChange={(e) => setForm({ ...form, credit_limit_currency: e.target.value.toUpperCase() })}
                style={{ ...inputStyle, width: 64 }}
                placeholder="USD"
                maxLength={3}
                aria-label="Credit limit currency"
              />
            </div>
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, fontStyle: "italic" }}>
              For factored customers this is set from the factor&apos;s API.
            </div>
          </Field>
          {/* Chunk K — customer factoring (operator item 17). */}
          <Field label="Factored?">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={form.is_factored}
                onChange={(e) => setForm({ ...form, is_factored: e.target.checked, factor_id: e.target.checked ? form.factor_id : "" })}
              />
              Receivables are factored / insured
            </label>
            {form.is_factored && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4 }}>Factor / Insurance</div>
                <SearchableSelect
                  value={form.factor_id || null}
                  onChange={(v) => setForm({ ...form, factor_id: v })}
                  options={factorOptions}
                  placeholder="Pick a factor…"
                />
              </div>
            )}
          </Field>
          <Field label="Status">
            <SearchableSelect
              value={form.status || null}
              onChange={(v) => setForm({ ...form, status: v })}
              options={STATUS_OPTIONS.map((s) => ({ value: s, label: s }))}
              inputStyle={inputStyle as React.CSSProperties}
            />
          </Field>
          <Field label="Tax exempt?">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input type="checkbox" checked={form.tax_exempt} onChange={(e) => setForm({ ...form, tax_exempt: e.target.checked })} />
              Yes (skip AR tax calc)
            </label>
          </Field>
          {/* Contact information moved to the AP/Trans/CBs tab (operator #9/#10).
              The scalar fields stay on the record (preserved on save) but are no
              longer edited from the Details page. */}
        </div>

        {/* ── Tab 2 — Reps & Defaults ─────────────────────────────────── */}
        <div style={{ display: tab === "reps" ? "grid" : "none", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Sales rep 1">
            <SearchableSelect
              value={form.sales_rep_1_id || null}
              onChange={(v) => setForm({ ...form, sales_rep_1_id: v })}
              options={employeeOptions}
              placeholder="(select)"
            />
          </Field>
          <Field label="Sales rep 1 commission %">
            <input
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={form.sales_rep_1_commission_pct}
              onChange={(e) => setForm({ ...form, sales_rep_1_commission_pct: e.target.value })}
              style={inputStyle}
              placeholder="0.00"
            />
          </Field>
          <Field label="Sales rep 2">
            <SearchableSelect
              value={form.sales_rep_2_id || null}
              onChange={(v) => setForm({ ...form, sales_rep_2_id: v })}
              options={employeeOptions}
              placeholder="(select)"
            />
          </Field>
          <Field label="Sales rep 2 commission %">
            <input
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={form.sales_rep_2_commission_pct}
              onChange={(e) => setForm({ ...form, sales_rep_2_commission_pct: e.target.value })}
              style={inputStyle}
              placeholder="0.00"
            />
          </Field>
          <Field label="Closeout commission %">
            <input
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={form.closeout_commission_pct}
              onChange={(e) => setForm({ ...form, closeout_commission_pct: e.target.value })}
              style={inputStyle}
              placeholder="0.00"
              title="Commission % used for this customer's CLOSEOUT orders (when the SO is flagged closeout), in place of the normal rep rate."
            />
          </Field>
          <Field label="Default brand">
            <SearchableSelect
              value={form.default_brand_id || null}
              onChange={(v) => setForm({ ...form, default_brand_id: v })}
              options={brandOptions}
              placeholder="(select)"
            />
          </Field>
          <Field label="Default channel">
            <SearchableSelect
              value={form.default_channel_id || null}
              onChange={(v) => setForm({ ...form, default_channel_id: v })}
              options={channelOptions}
              placeholder="(select)"
            />
          </Field>
          <Field label="Price list">
            <SearchableSelect
              value={form.price_list_id || null}
              onChange={(v) => setForm({ ...form, price_list_id: v })}
              options={[{ value: "", label: "(default / tier)" }, ...priceLists.map((l) => ({ value: l.id, label: l.name, searchHaystack: `${l.code} ${l.name}` }))]}
              placeholder="(default / tier)"
            />
          </Field>
          <Field label="Default terms">
            <SearchableSelect
              value={form.payment_terms_id || null}
              onChange={(v) => setForm({ ...form, payment_terms_id: v })}
              options={paymentTermsOptions}
              placeholder="Pick a payment term…"
            />
          </Field>
        </div>

        {/* ── Tab 3 — GL Accounts ─────────────────────────────────────── */}
        <div style={{ display: tab === "gl" ? "block" : "none" }}>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>
            Used for this customer&apos;s sales-order and invoice GL routing.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Revenue account">
              <SearchableSelect
                value={form.default_revenue_account_id || null}
                onChange={(v) => setForm({ ...form, default_revenue_account_id: v })}
                options={glRoutingOptions}
                placeholder="(select)"
              />
            </Field>
            <Field label="Returns account">
              <SearchableSelect
                value={form.default_returns_account_id || null}
                onChange={(v) => setForm({ ...form, default_returns_account_id: v })}
                options={glRoutingOptions}
                placeholder="(select)"
              />
            </Field>
            <Field label="COGS account">
              <SearchableSelect
                value={form.default_cogs_account_id || null}
                onChange={(v) => setForm({ ...form, default_cogs_account_id: v })}
                options={glRoutingOptions}
                placeholder="(select)"
              />
            </Field>
            <Field label="AR account">
              <SearchableSelect
                value={form.default_ar_account_id || null}
                onChange={(v) => setForm({ ...form, default_ar_account_id: v })}
                options={glRoutingOptions}
                placeholder="(select)"
              />
            </Field>
          </div>
        </div>

        {/* ── Tab 4 — Addresses & Locations ───────────────────────────── */}
        <div style={{ display: tab === "addresses" ? "block" : "none" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <AddressFields label="Billing address" value={form.billing_address} onChange={(a) => setForm({ ...form, billing_address: a })} />
            <AddressFields label="Shipping address" value={form.shipping_address} onChange={(a) => setForm({ ...form, shipping_address: a })} />
          </div>
          <div style={{ marginTop: 20 }}>
            {mode === "edit" && customer ? (
              <CustomerLocations customerId={customer.id} />
            ) : (
              <div style={{ padding: "8px 12px", background: "#0b1220", borderRadius: 6, border: `1px solid ${C.cardBdr}`, fontSize: 12, color: C.textMuted }}>
                Save the customer first to add locations.
              </div>
            )}
          </div>
        </div>

        {/* ── Tab 5 — Buyers ──────────────────────────────────────────── */}
        <div style={{ display: tab === "buyers" ? "block" : "none" }}>
          <BuyersEditor customerId={mode === "edit" ? (customer?.id ?? null) : null} />
        </div>

        {/* ── Tab 6 — AP / Transportation / Chargeback contacts (up to 8) ─ */}
        <div style={{ display: tab === "payable" ? "block" : "none" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1.1fr 1.6fr 1.2fr auto auto", gap: 8, marginBottom: 6, fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
            <span>Name</span><span>Department</span><span>Email</span><span>Phone</span><span /><span />
          </div>
          {form.contacts.map((c, i) => (
            <div key={c.id ?? i} style={{ marginBottom: 8 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1.1fr 1.6fr 1.2fr auto auto", gap: 8, alignItems: "center" }}>
                <input type="text" value={c.name ?? ""} placeholder="Name"
                  onChange={(e) => setForm({ ...form, contacts: form.contacts.map((x, j) => j === i ? { ...x, name: e.target.value } : x) })} style={inputStyle} />
                <SearchableSelect
                  value={c.department ?? ""}
                  onChange={(v) => setForm({ ...form, contacts: form.contacts.map((x, j) => j === i ? { ...x, department: v } : x) })}
                  options={[
                    { value: "", label: "Dept…" },
                    { value: "ap", label: "Accounts Payable" },
                    { value: "transportation", label: "Transportation" },
                    { value: "chargeback", label: "Chargeback" },
                  ]}
                  inputStyle={inputStyle as React.CSSProperties}
                />
                <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                  <input type="email" value={c.email ?? ""} placeholder="email@example.com"
                    onChange={(e) => setForm({ ...form, contacts: form.contacts.map((x, j) => j === i ? { ...x, email: e.target.value } : x) })} style={{ ...inputStyle, paddingRight: 30 }} />
                  <MailLink email={c.email ?? ""} />
                </div>
                <input type="text" value={c.phone ?? ""} placeholder="(555) 000-0000"
                  onChange={(e) => setForm({ ...form, contacts: form.contacts.map((x, j) => j === i ? { ...x, phone: formatUsPhone(e.target.value) } : x) })} style={inputStyle} />
                <button type="button"
                  title={mode === "edit" && customer ? "Notes & reminders for this contact" : "Save the customer first to add notes"}
                  disabled={!(mode === "edit" && customer && c.id)}
                  onClick={() => setNotesOpenId((cur) => cur === c.id ? null : (c.id ?? null))}
                  style={{ ...btnSecondary, color: notesOpenId === c.id ? C.primary : C.textSub, borderColor: notesOpenId === c.id ? C.primary : C.cardBdr, opacity: (mode === "edit" && customer && c.id) ? 1 : 0.45 }}>Notes</button>
                <button type="button" title="Remove contact" onClick={() => setForm({ ...form, contacts: form.contacts.filter((_, j) => j !== i) })} style={btnDanger}>✕</button>
              </div>
              {mode === "edit" && customer && c.id && notesOpenId === c.id && (
                <CustomerContactNotes customerId={customer.id} contactId={c.id} highlightNoteId={initialNoteId ?? undefined} />
              )}
            </div>
          ))}
          {form.contacts.length < 8 && (
            <button type="button" onClick={() => setForm({ ...form, contacts: [...form.contacts, { id: (globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2)), name: "", department: "", email: "", phone: "" }] })}
              style={{ ...btnSecondary, color: C.primary, borderColor: C.primary, marginTop: 4 }}>
              + Add contact
            </button>
          )}
        </div>

        {/* Style numbers — this customer's private-label style numbers. Read-only
            here (the source of truth + editing lives in Style Master → Customer
            style numbers, and builds auto-mint them). */}
        <div style={{ display: tab === "styles" ? "block" : "none" }}>
          {mode === "edit" && customer
            ? <CustomerStyleNumbers customerId={customer.id} />
            : <div style={{ color: C.textMuted, fontSize: 13 }}>Save the customer first — style numbers are added from Style Master or auto-created when you build for this customer.</div>}
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>
            {err}
          </div>
        )}

        {mode === "edit" && customer && (
          <div style={{ marginTop: 16 }}>
            <DocumentAttachmentList
              contextTable="customers"
              contextId={customer.id}
              kinds={["contract", "tax_exempt", "credit_app", "other"]}
            />
          </div>
        )}

        {/* Cross-cutter T11-3 — audit trail timeline */}
        {mode === "edit" && customer && (
          <RowHistory source_table="customers" source_id={customer.id} />
        )}

        {/* Sticky action footer — pinned to the bottom of the scrolling modal so
            Save / Cancel stay reachable on tall records (negative margins span
            the modal's 20px padding; bottom:-20 cancels its padding-bottom). */}
        <div style={{ position: "sticky", bottom: -20, zIndex: 3, background: C.card, borderTop: `1px solid ${C.cardBdr}`, margin: "16px -20px -20px", padding: "12px 20px", display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting}>
            {submitting ? "Saving…" : mode === "add" ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Read-only list of this customer's private-label style numbers, from the
// shared style_customer_numbers junction (edited in Style Master; auto-created
// when a build is made for the customer). Phase B.
type ScnRow = { id: string; customer_style_number: string; notes: string | null; style?: { style_code?: string | null; style_name?: string | null } | null; style_id: string };
function CustomerStyleNumbers({ customerId }: { customerId: string }) {
  const [rows, setRows] = useState<ScnRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/internal/style-customer-numbers?customer_id=${customerId}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        if (alive) setRows(Array.isArray(j) ? j : []);
      } catch (e: unknown) { if (alive) setErr(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { alive = false; };
  }, [customerId]);
  if (err) return <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, fontSize: 12 }}>{err}</div>;
  if (rows === null) return <div style={{ color: C.textMuted, fontSize: 13 }}>Loading…</div>;
  if (rows.length === 0) return <div style={{ color: C.textMuted, fontSize: 13 }}>No style numbers yet for this customer. They're added in Style Master, or auto-created when you build a style for this customer.</div>;
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead><tr style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
        <th style={{ textAlign: "left", padding: "6px 8px" }}>Base style</th>
        <th style={{ textAlign: "left", padding: "6px 8px" }}>Customer style #</th>
        <th style={{ textAlign: "left", padding: "6px 8px" }}>Notes</th>
      </tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} style={{ borderTop: `1px solid ${C.cardBdr}` }}>
            <td style={{ padding: "6px 8px", fontFamily: "SFMono-Regular, Menlo, monospace" }}>{r.style?.style_code || "—"}{r.style?.style_name ? <span style={{ color: C.textMuted, fontFamily: "inherit" }}> — {r.style.style_name}</span> : null}</td>
            <td style={{ padding: "6px 8px", fontFamily: "SFMono-Regular, Menlo, monospace" }}>{r.customer_style_number}</td>
            <td style={{ padding: "6px 8px", color: C.textMuted }}>{r.notes || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
