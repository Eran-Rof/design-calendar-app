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
import DocumentAttachmentList from "../shared/documents/DocumentAttachmentList";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
// Cross-cutter T11-3 — audit-trail drop-in for the customer detail modal.
import RowHistory from "./components/RowHistory";
import AddressFields, { type Address } from "./components/AddressFields";
import CustomerLocations from "./components/CustomerLocations";
// Wave 5 primitives.
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import DynamicSearchInput from "./components/DynamicSearchInput";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import SearchableSelect, { type SearchableSelectOption } from "./components/SearchableSelect";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";

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
  default_gl_ar_account_id: string | null;
  default_gl_revenue_account_id: string | null;
  payment_terms: string | null;       // legacy free-text (read-only display)
  payment_terms_id: string | null;    // P3-9 structured FK
  default_currency: string;
  tax_exempt: boolean;
  tax_exempt_certificate: string | null;
  credit_limit: number | string | null;
  credit_limit_cents: number | string | null;
  credit_limit_currency: string | null;
  status: string;
  billing_address: Record<string, unknown>;
  shipping_address: Record<string, unknown>;
  contact_name: string | null;
  contact_title: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  wechat_id: string | null;
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
  const { value: q, debouncedValue: qDebounced, setValue: setQ } = useDebouncedSearch("", 200);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [typeFilter, setTypeFilter] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);

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
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={{ ...inputStyle, width: 140 }}>
            <option value="">(all)</option>
            {CUSTOMER_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
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

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No customers found.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th} hidden={!isVisible("code")}>Code</th>
                <th style={th} hidden={!isVisible("name")}>Name</th>
                <th style={th} hidden={!isVisible("customer_type")}>Type</th>
                <th style={th} hidden={!isVisible("country")}>Country</th>
                <th style={th} hidden={!isVisible("status")}>Status</th>
                <th style={{ ...th, textAlign: "right" }} hidden={!isVisible("credit_limit")}>Credit Limit</th>
                <th style={th} hidden={!isVisible("payment_terms")}>Payment Terms</th>
                <th style={{ ...th, width: 140 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <ScrollHighlightRow
                  key={r.id}
                  rowId={r.id}
                  highlightedRowId={highlightedId}
                  {...getRowProps(r)}
                  style={r.deleted_at ? { opacity: 0.4 } : undefined}
                >
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }} hidden={!isVisible("code")}>
                    {r.code || r.customer_code || "—"}
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
                      termById.get(r.payment_terms_id)?.code || r.payment_terms_id.slice(0, 8) + "…"
                    ) : r.payment_terms ? (
                      <span style={{ color: C.textMuted, fontStyle: "italic" }} title="Legacy free-text — edit to migrate to structured term">{r.payment_terms}</span>
                    ) : "—"}
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    {!r.deleted_at && (
                      <>
                        <button onClick={(e) => { e.stopPropagation(); setEditing(r); }} style={btnSecondary}>Edit</button>
                        <button onClick={(e) => { e.stopPropagation(); void softDelete(r); }} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                      </>
                    )}
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
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
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
}

function CustomerFormModal({ mode, customer, paymentTerms, onClose, onSaved }: ModalProps) {
  // Initial credit_limit display value (in dollars). Prefer the canonical
  // credit_limit_cents (P4-7) and fall back to the legacy numeric credit_limit
  // column for rows that haven't been re-saved since P4-7.
  const initCreditLimitDollars =
    customer?.credit_limit_cents != null && customer.credit_limit_cents !== ""
      ? String(Number(customer.credit_limit_cents) / 100)
      : customer?.credit_limit != null
        ? String(customer.credit_limit)
        : "";
  const [form, setForm] = useState({
    name:                         customer?.name                         ?? "",
    code:                         customer?.code                         ?? "",
    customer_type:                customer?.customer_type                ?? "wholesale",
    country:                      customer?.country                      ?? "",
    payment_terms_id:             customer?.payment_terms_id             ?? "",
    default_currency:             customer?.default_currency             ?? "USD",
    // New customers default to tax-exempt=true (operator request).
    tax_exempt:                   mode === "add" ? true : (customer?.tax_exempt ?? false),
    credit_limit:                 initCreditLimitDollars,
    credit_limit_currency:        customer?.credit_limit_currency        ?? "USD",
    status:                       customer?.status                       ?? "active",
    billing_address:              (customer?.billing_address && typeof customer.billing_address === "object"
                                    ? customer.billing_address : {}) as Address,
    shipping_address:             (customer?.shipping_address && typeof customer.shipping_address === "object"
                                    ? customer.shipping_address : {}) as Address,
    default_gl_ar_account_id:     customer?.default_gl_ar_account_id     ?? "",
    default_gl_revenue_account_id: customer?.default_gl_revenue_account_id ?? "",
    contact_name:                 customer?.contact_name                 ?? "",
    contact_title:                customer?.contact_title                ?? "",
    email:                        customer?.email                        ?? "",
    phone:                        customer?.phone                        ?? "",
    website:                      customer?.website                      ?? "",
    wechat_id:                    customer?.wechat_id                    ?? "",
  });
  const [glAccounts, setGlAccounts] = useState<GlAccount[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/internal/gl-accounts?limit=1000")
      .then((r) => r.json())
      .then((arr: GlAccount[]) => setGlAccounts(Array.isArray(arr) ? arr.filter((a) => a.status === "active") : []))
      .catch(() => {});
  }, []);

  // GL account picker options — postable accounts only, with "(none)" entry.
  const glAccountOptions: SearchableSelectOption[] = useMemo(() => [
    { value: "", label: "(none)" },
    ...glAccounts.filter((a) => a.is_postable).map((a) => ({
      value: a.id,
      label: `${a.code} — ${a.name}`,
    })),
  ], [glAccounts]);

  // Wave 5 — payment-terms picker is the only modal dropdown whose option
  // list comes from a DB table (payment_terms) and can grow beyond a
  // handful, so we route it through SearchableSelect. The customer_type
  // and status selects below stay as native <select> elements (5 and 3
  // fixed enum values respectively).
  const paymentTermsOptions: SearchableSelectOption[] = useMemo(() => {
    const active = paymentTerms.filter((t) => t.is_active || t.id === form.payment_terms_id);
    return [
      { value: "", label: "(none — inherit / no default)" },
      ...active.map((t) => ({
        value: t.id,
        label: `${t.code} — ${t.name} (${t.due_days}d)`,
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
        code:                         form.code.trim() || null,
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
        status:                       form.status,
        billing_address:              form.billing_address,
        shipping_address:             form.shipping_address,
        default_gl_ar_account_id:     form.default_gl_ar_account_id || null,
        default_gl_revenue_account_id: form.default_gl_revenue_account_id || null,
        contact_name:                 form.contact_name.trim() || null,
        contact_title:                form.contact_title.trim() || null,
        email:                        form.email.trim() || null,
        phone:                        form.phone.trim() || null,
        website:                      form.website.trim() || null,
        wechat_id:                    form.wechat_id.trim() || null,
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
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, minWidth: 560, maxWidth: 760, color: C.text, maxHeight: "90vh", overflowY: "auto" }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {mode === "add" ? "Add customer" : `Edit ${customer!.name}`}
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
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
            <input
              type="text"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              style={inputStyle}
              placeholder="Short ERP code"
            />
          </Field>
          <Field label="Customer type">
            <select value={form.customer_type} onChange={(e) => setForm({ ...form, customer_type: e.target.value })} style={inputStyle as React.CSSProperties}>
              {CUSTOMER_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Country">
            <input type="text" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} style={inputStyle} placeholder="e.g. US" />
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
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.credit_limit}
                onChange={(e) => setForm({ ...form, credit_limit: e.target.value })}
                style={{ ...inputStyle, flex: 1 }}
                placeholder="0.00"
                title="0 or blank = no credit limit (no gate)"
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
          </Field>
          <Field label="Status">
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} style={inputStyle as React.CSSProperties}>
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Tax exempt?">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input type="checkbox" checked={form.tax_exempt} onChange={(e) => setForm({ ...form, tax_exempt: e.target.checked })} />
              Yes (skip AR tax calc)
            </label>
          </Field>
          <Field label="Default AR account">
            <SearchableSelect
              value={form.default_gl_ar_account_id || null}
              onChange={(v) => setForm({ ...form, default_gl_ar_account_id: v })}
              options={glAccountOptions}
              placeholder="(none)"
            />
          </Field>
          <Field label="Default revenue account">
            <SearchableSelect
              value={form.default_gl_revenue_account_id || null}
              onChange={(v) => setForm({ ...form, default_gl_revenue_account_id: v })}
              options={glAccountOptions}
              placeholder="(none)"
            />
          </Field>
          <Field label="Contact name">
            <input
              type="text"
              value={form.contact_name}
              onChange={(e) => setForm({ ...form, contact_name: e.target.value })}
              style={inputStyle}
              placeholder="Primary contact"
            />
          </Field>
          <Field label="Contact title">
            <input
              type="text"
              value={form.contact_title}
              onChange={(e) => setForm({ ...form, contact_title: e.target.value })}
              style={inputStyle}
              placeholder="e.g. Buyer"
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              style={inputStyle}
              placeholder="contact@example.com"
            />
          </Field>
          <Field label="Phone">
            <input
              type="text"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              style={inputStyle}
              placeholder="+1 (555) 000-0000"
            />
          </Field>
          <Field label="Website">
            <input
              type="text"
              value={form.website}
              onChange={(e) => setForm({ ...form, website: e.target.value })}
              style={inputStyle}
              placeholder="https://"
            />
          </Field>
          <Field label="WeChat ID">
            <input
              type="text"
              value={form.wechat_id}
              onChange={(e) => setForm({ ...form, wechat_id: e.target.value })}
              style={inputStyle}
              placeholder="WeChat handle"
            />
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 12 }}>
          <AddressFields label="Billing address" value={form.billing_address} onChange={(a) => setForm({ ...form, billing_address: a })} />
          <AddressFields label="Shipping address" value={form.shipping_address} onChange={(a) => setForm({ ...form, shipping_address: a })} />
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting}>
            {submitting ? "Saving…" : mode === "add" ? "Create" : "Save"}
          </button>
        </div>

        {mode === "edit" && customer && (
          <div style={{ marginTop: 16 }}>
            <DocumentAttachmentList
              contextTable="customers"
              contextId={customer.id}
              kinds={["contract", "tax_exempt", "credit_app", "other"]}
            />
          </div>
        )}

        {/* Ship-to locations — only shown for existing (saved) customers */}
        {mode === "edit" && customer ? (
          <div style={{ marginTop: 20 }}>
            <CustomerLocations customerId={customer.id} />
          </div>
        ) : mode === "add" ? (
          <div style={{ marginTop: 16, padding: "8px 12px", background: "#0b1220", borderRadius: 6, border: `1px solid ${C.cardBdr}`, fontSize: 12, color: C.textMuted }}>
            Ship-to locations can be added after the customer is saved.
          </div>
        ) : null}

        {/* Cross-cutter T11-3 — audit trail timeline */}
        {mode === "edit" && customer && (
          <RowHistory source_table="customers" source_id={customer.id} />
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
