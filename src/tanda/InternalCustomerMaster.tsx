// src/tanda/InternalCustomerMaster.tsx
//
// Tangerine P1 Chunk 7c — internal admin panel for customers (M36) CRUD.
// List + search + customer-type filter + status toggle + create + edit +
// soft-delete. Wraps /api/internal/customer-master and
// /api/internal/customer-master/:id.
//
// tax_exempt_certificate is NEVER touched here — it's a PII-adjacent field
// handled by a dedicated workflow (not built).

import { useEffect, useState } from "react";
import DocumentAttachmentList from "../shared/documents/DocumentAttachmentList";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

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
  credit_limit: number | string | null;
  status: string;
  billing_address: Record<string, unknown>;
  shipping_address: Record<string, unknown>;
  attributes: Record<string, unknown>;
  active: boolean | null;
  external_refs: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
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
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [typeFilter, setTypeFilter] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
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
  }

  useEffect(() => { void load(); }, [includeInactive, typeFilter]);

  const termById = new Map(paymentTerms.map((t) => [t.id, t]));

  async function softDelete(c: Customer) {
    if (!confirm(`Deactivate this customer?\n\n${c.name}\n\nThis soft-deletes the row. An admin can restore via SQL.`)) return;
    try {
      const r = await fetch(`/api/internal/customer-master/${c.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Customer Master</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add customer</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          placeholder="Search name, code, or customer_code…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void load()}
          style={{ ...inputStyle, maxWidth: 360 }}
        />
        <button onClick={() => void load()} style={btnSecondary}>Search</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <span style={{ textTransform: "uppercase", letterSpacing: 0.5, fontSize: 11, color: C.textMuted }}>Type</span>
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
                <th style={th}>Code</th>
                <th style={th}>Name</th>
                <th style={th}>Type</th>
                <th style={th}>Country</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: "right" }}>Credit Limit</th>
                <th style={th}>Payment Terms</th>
                <th style={{ ...th, width: 140 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={r.deleted_at ? { opacity: 0.4 } : {}}>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>
                    {r.code || r.customer_code || "—"}
                  </td>
                  <td style={td}>{r.name}</td>
                  <td style={td}>{r.customer_type}</td>
                  <td style={td}>{r.country || "—"}</td>
                  <td style={td}><span style={statusPill(r.status)}>{r.status}</span></td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "SFMono-Regular, Menlo, monospace" }}>
                    {fmtMoney(r.credit_limit)}
                  </td>
                  <td style={td}>
                    {r.payment_terms_id ? (
                      termById.get(r.payment_terms_id)?.code || r.payment_terms_id.slice(0, 8) + "…"
                    ) : r.payment_terms ? (
                      <span style={{ color: C.textMuted, fontStyle: "italic" }} title="Legacy free-text — edit to migrate to structured term">{r.payment_terms}</span>
                    ) : "—"}
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    {!r.deleted_at && (
                      <>
                        <button onClick={() => setEditing(r)} style={btnSecondary}>Edit</button>
                        <button onClick={() => void softDelete(r)} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                      </>
                    )}
                  </td>
                </tr>
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
  const [form, setForm] = useState({
    name:             customer?.name             ?? "",
    code:             customer?.code             ?? "",
    customer_type:    customer?.customer_type    ?? "wholesale",
    country:          customer?.country          ?? "",
    payment_terms_id: customer?.payment_terms_id ?? "",
    default_currency: customer?.default_currency ?? "USD",
    tax_exempt:       customer?.tax_exempt       ?? false,
    credit_limit:     customer?.credit_limit != null ? String(customer.credit_limit) : "",
    status:           customer?.status           ?? "active",
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        name:             form.name.trim(),
        code:             form.code.trim() || null,
        customer_type:    form.customer_type,
        country:          form.country.trim() || null,
        // P3-9: structured FK. Legacy text column stays read-only display.
        payment_terms_id: form.payment_terms_id || null,
        default_currency: form.default_currency.trim().toUpperCase() || "USD",
        tax_exempt:       !!form.tax_exempt,
        credit_limit:     form.credit_limit.trim() === "" ? null : parseFloat(form.credit_limit),
        status:           form.status,
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
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, minWidth: 520, maxWidth: 640, color: C.text }}
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
            <select
              value={form.payment_terms_id}
              onChange={(e) => setForm({ ...form, payment_terms_id: e.target.value })}
              style={inputStyle as React.CSSProperties}
            >
              <option value="">(none — inherit / no default)</option>
              {paymentTerms.filter((t) => t.is_active || t.id === form.payment_terms_id).map((t) => (
                <option key={t.id} value={t.id}>{t.code} — {t.name} ({t.due_days}d)</option>
              ))}
            </select>
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
            <input type="number" min="0" step="0.01" value={form.credit_limit} onChange={(e) => setForm({ ...form, credit_limit: e.target.value })} style={inputStyle} placeholder="0.00" />
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
        </div>

        <div style={{ marginTop: 12, padding: "8px 12px", background: "#0b1220", border: `1px dashed ${C.cardBdr}`, borderRadius: 6, fontSize: 11, color: C.textMuted }}>
          Tax exempt certificate handled via dedicated PII workflow — not editable here.
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
