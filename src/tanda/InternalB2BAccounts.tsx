// src/tanda/InternalB2BAccounts.tsx
//
// Tangerine P18-F — internal B2B Buyers admin panel.
// Authorize a buyer (pre-authorization step): map a customer + email to a
// portal role. The auth_user_id binds on first magic-link login (portal side),
// so it + last_login_at are READ-ONLY here.
// Wraps /api/internal/b2b-accounts and /api/internal/b2b-accounts/:id.

import { useEffect, useMemo, useState } from "react";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import SearchableSelect from "./components/SearchableSelect";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";

// Universal column-visibility registry for this panel (operator ask #1).
const B2B_ACCOUNTS_TABLE_KEY = "tangerine:b2baccounts:columns";
const B2B_ACCOUNT_COLUMNS: ColumnDef[] = [
  { key: "customer",   label: "Customer" },
  { key: "email",      label: "Email" },
  { key: "role",       label: "Role" },
  { key: "active",     label: "Active" },
  { key: "can_order",  label: "Can order" },
  { key: "activated",  label: "Activated" },
  { key: "last_login", label: "Last login" },
];

type Role = "buyer" | "approver" | "admin";

type B2BAccount = {
  id: string;
  entity_id: string;
  customer_id: string;
  email: string;
  auth_user_id: string | null;
  display_name: string | null;
  role: Role;
  is_active: boolean;
  can_place_orders: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
};

type Customer = { id: string; name: string; customer_code?: string | null };

// Customer codes/names carry a legacy Xoro "EXCEL:" prefix from the Excel ingest
// (e.g. EXCEL:MACYS). Strip it for display — mirrors costingApi's stripExcelTag.
const stripExcel = (s: string | null | undefined): string => (s || "").replace(/^EXCEL:/i, "").trim();

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: "buyer", label: "Buyer" },
  { value: "approver", label: "Approver" },
  { value: "admin", label: "Admin" },
];

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

function fmtDateTime(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

export default function InternalB2BAccounts() {
  const [rows, setRows] = useState<B2BAccount[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const { value: q, debouncedValue: qDebounced, setValue: setQ } = useDebouncedSearch("", 200);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<B2BAccount | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const { getRowProps } = useRowClickEdit<B2BAccount>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit B2B account ${r.email}`,
  });

  // Wave 5 — universal column show/hide.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    B2B_ACCOUNTS_TABLE_KEY,
    B2B_ACCOUNT_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  const customerMap = useMemo(() => {
    const m: Record<string, Customer> = {};
    for (const c of customers) m[c.id] = c;
    return m;
  }, [customers]);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (qDebounced.trim()) params.set("q", qDebounced.trim());
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/b2b-accounts?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as B2BAccount[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [qDebounced, includeInactive]);

  useEffect(() => {
    fetch("/api/internal/customer-master?limit=5000")
      .then((r) => r.json())
      .then((arr: unknown) => { if (Array.isArray(arr)) setCustomers(arr as Customer[]); })
      .catch(() => {});
  }, []);

  async function del(acct: B2BAccount) {
    if (!(await confirmDialog(`Delete B2B account ${acct.email}?\nThis removes the portal authorization for this buyer.`))) return;
    try {
      const r = await fetch(`/api/internal/b2b-accounts/${acct.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  function customerName(id: string): string {
    const c = customerMap[id];
    if (!c) return "—";
    const name = stripExcel(c.name);
    const code = stripExcel(c.customer_code);
    return code ? `${name} (${code})` : name;
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>B2B Buyers</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Authorize buyer</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          placeholder="Search email or name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ ...inputStyle, maxWidth: 280 }}
        />
        <button onClick={() => void load()} style={btnSecondary}>Search</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show inactive
        </label>
        <TablePrefsButton
          tableKey={B2B_ACCOUNTS_TABLE_KEY}
          columns={B2B_ACCOUNT_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
        />
        <ExportButton
          rows={rows.map((a) => ({
            customer: customerName(a.customer_id),
            email: a.email,
            display_name: a.display_name || "",
            role: a.role,
            is_active: a.is_active,
            can_place_orders: a.can_place_orders,
            activated: a.auth_user_id ? "yes" : "no",
            last_login_at: a.last_login_at,
            created_at: a.created_at,
          })) as unknown as Array<Record<string, unknown>>}
          filename="b2b-buyers"
          sheetName="B2B Buyers"
          columns={[
            { key: "customer",         header: "Customer" },
            { key: "email",            header: "Email" },
            { key: "display_name",     header: "Display Name" },
            { key: "role",             header: "Role" },
            { key: "is_active",        header: "Active" },
            { key: "can_place_orders", header: "Can Order" },
            { key: "activated",        header: "Activated" },
            { key: "last_login_at",    header: "Last Login", format: "datetime" },
            { key: "created_at",       header: "Created", format: "datetime" },
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
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            No B2B buyers authorized yet. Click &quot;Authorize buyer&quot; to pre-authorize an email.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th} hidden={!isVisible("customer")}>Customer</th>
                <th style={th} hidden={!isVisible("email")}>Email</th>
                <th style={th} hidden={!isVisible("role")}>Role</th>
                <th style={th} hidden={!isVisible("active")}>Active</th>
                <th style={th} hidden={!isVisible("can_order")}>Can order</th>
                <th style={th} hidden={!isVisible("activated")}>Activated</th>
                <th style={th} hidden={!isVisible("last_login")}>Last login</th>
                <th style={{ ...th, width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <ScrollHighlightRow
                  key={a.id}
                  rowId={a.id}
                  highlightedRowId={highlightedId}
                  {...getRowProps(a)}
                  style={!a.is_active ? { opacity: 0.5 } : undefined}
                >
                  <td style={td} hidden={!isVisible("customer")}>{customerName(a.customer_id)}</td>
                  <td style={td} hidden={!isVisible("email")}>{a.email}{a.display_name ? <span style={{ color: C.textMuted }}> — {a.display_name}</span> : null}</td>
                  <td style={td} hidden={!isVisible("role")}>{a.role}</td>
                  <td style={td} hidden={!isVisible("active")}>{a.is_active ? "yes" : "no"}</td>
                  <td style={td} hidden={!isVisible("can_order")}>{a.can_place_orders ? "yes" : "no"}</td>
                  <td style={td} hidden={!isVisible("activated")}>
                    {a.auth_user_id
                      ? <span style={{ color: C.success }}>activated</span>
                      : <span style={{ color: C.textMuted }}>pending</span>}
                  </td>
                  <td style={{ ...td, color: C.textMuted, fontSize: 12 }} hidden={!isVisible("last_login")}>{fmtDateTime(a.last_login_at)}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={(e) => { e.stopPropagation(); setEditing(a); }} style={btnSecondary}>Edit</button>
                    <button onClick={(e) => { e.stopPropagation(); void del(a); }} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                  </td>
                </ScrollHighlightRow>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && <B2BAccountFormModal mode="add" customers={customers} onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load(); }} />}
      {editing && <B2BAccountFormModal mode="edit" account={editing} customers={customers} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  account?: B2BAccount;
  customers: Customer[];
  onClose: () => void;
  onSaved: () => void;
}

function B2BAccountFormModal({ mode, account, customers, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    customer_id:      account?.customer_id ?? "",
    email:            account?.email ?? "",
    display_name:     account?.display_name ?? "",
    role:             account?.role ?? ("buyer" as Role),
    is_active:        account?.is_active ?? true,
    can_place_orders: account?.can_place_orders ?? true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        customer_id:      form.customer_id,
        email:            form.email.trim(),
        display_name:     form.display_name.trim() === "" ? null : form.display_name.trim(),
        role:             form.role,
        is_active:        form.is_active,
        can_place_orders: form.can_place_orders,
      };
      const url = mode === "add" ? "/api/internal/b2b-accounts" : `/api/internal/b2b-accounts/${account!.id}`;
      const method = mode === "add" ? "POST" : "PATCH";
      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const customerOptions = customers.map((c) => {
    const name = stripExcel(c.name);
    const code = stripExcel(c.customer_code);
    return {
      value: c.id,
      label: code ? `${name} (${code})` : name,
      searchHaystack: `${name} ${code}`,
    };
  });

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(640px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {mode === "add" ? "Authorize buyer" : `Edit ${account!.email}`}
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={{ gridColumn: "1 / -1" }}>
            <Field label="Customer *">
              <SearchableSelect
                value={form.customer_id || null}
                onChange={(v) => setForm({ ...form, customer_id: v })}
                options={customerOptions}
                placeholder="Search customer…"
              />
            </Field>
          </div>
          <Field label="Email *">
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              style={inputStyle}
              placeholder="buyer@company.com"
            />
          </Field>
          <Field label="Display name">
            <input
              type="text"
              value={form.display_name}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              style={inputStyle}
              placeholder="e.g. Jane Buyer"
            />
          </Field>
          <Field label="Role">
            <SearchableSelect
              value={form.role}
              onChange={(v) => setForm({ ...form, role: v as Role })}
              options={ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
          </Field>
          <Field label="Active">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
              is_active
            </label>
          </Field>
          <Field label="Can place orders">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input type="checkbox" checked={form.can_place_orders} onChange={(e) => setForm({ ...form, can_place_orders: e.target.checked })} />
              can_place_orders
            </label>
          </Field>
        </div>

        <div style={{
          marginTop: 14, padding: "8px 12px",
          background: "#0b1220", border: `1px dashed ${C.cardBdr}`,
          borderRadius: 6, fontSize: 11, color: C.textMuted, lineHeight: 1.5,
        }}>
          This pre-authorizes the email. The buyer&apos;s login binds automatically on
          their first magic-link sign-in (activation + last-login are portal-managed).
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting}>
            {submitting ? "Saving…" : mode === "add" ? "Authorize" : "Save"}
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
