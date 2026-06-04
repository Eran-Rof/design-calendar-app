// src/tanda/InternalVendorMaster.tsx
//
// Tangerine P1 Chunk 7b — internal admin panel for vendor master CRUD (M35).
// List + search + create + edit + soft-inactivate (no separate "show deleted"
// because vendors use status='inactive' alongside soft-delete).
// Wraps /api/internal/vendor-master and /api/internal/vendor-master/:id.
//
// PII NOTE: tax_id and bank_account_encrypted are NOT exposed in this panel.
// They are stored on the vendors table but flow through dedicated PII-aware
// endpoints (TBD). The admin handlers we wrap explicitly omit them from
// every SELECT and reject them on insert/patch.
//
// Wave 5 adoption sweep (2026-05-30):
//   • TablePrefs           — per-user column show/hide; gear button next to search.
//   • Row-click + Scroll-highlight — click anywhere on a row to open the edit
//                            modal; fades a translucent blue bg on the row.
//   • DynamicSearchInput   — type-as-you-go debounced search; replaces the
//                            old text input + explicit Search button.
//   • SearchableSelect     — payment_terms picker in the modal (list grows
//                            past the 7-option adoption threshold once finance
//                            wires the full term catalog).
//   The status select stays a native <select> (3 fixed options).

import { useCallback, useEffect, useMemo, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import DocumentAttachmentList from "../shared/documents/DocumentAttachmentList";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
// Cross-cutter T11-3 — audit-trail drop-in for the vendor detail modal.
import RowHistory from "./components/RowHistory";
import AddressFields, { type Address } from "./components/AddressFields";
// Wave 5 universal primitives.
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import DynamicSearchInput from "./components/DynamicSearchInput";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import SearchableSelect from "./components/SearchableSelect";
// Chunk E — per-row drill-through scorecard (opened by the 📊 button).
import VendorScorecard from "./VendorScorecard";

type Vendor = {
  id: string;
  code: string | null;
  name: string;
  legal_name: string | null;
  country: string | null;
  transit_days: number | null;
  categories: string[] | null;
  contact: string | null;
  contact_title: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  wechat_id: string | null;
  moq: number | null;
  payment_terms: string | null;       // legacy free-text (read-only display)
  payment_terms_id: string | null;    // P3-9 structured FK
  default_currency: string;
  default_gl_ap_account_id: string | null;
  default_gl_expense_account_id: string | null;
  status: string;
  is_1099_vendor: boolean;
  address: Record<string, unknown>;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type GlAccount = {
  id: string;
  code: string;
  name: string;
  is_postable: boolean;
  status: string;
};

type PaymentTermOption = {
  id: string;
  code: string;
  name: string;
  due_days: number;
  is_active: boolean;
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const STATUS_OPTIONS = ["active", "on_hold", "inactive"];

// Wave 5 — TablePrefs registry. Action column is fixed (always visible).
const VENDOR_MASTER_TABLE_KEY = "tangerine:vendormaster:columns";
const VENDOR_MASTER_COLUMNS: ColumnDef[] = [
  { key: "code",          label: "Code" },
  { key: "name",          label: "Name" },
  { key: "country",       label: "Country" },
  { key: "status",        label: "Status" },
  { key: "is_1099_vendor", label: "1099" },
  { key: "payment_terms", label: "Payment terms" },
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
// Chunk M — greyed, read-only display for server-generated codes (operator item 14).
const readonlyCodeStyle: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, border: `1px dashed ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
  fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600,
  minHeight: 19, opacity: 0.85,
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

function statusBadge(status: string): React.CSSProperties {
  const color =
    status === "active"   ? C.success :
    status === "on_hold"  ? C.warn    :
    status === "inactive" ? C.textMuted :
                            C.textSub;
  return {
    display: "inline-block",
    padding: "2px 8px",
    fontSize: 11,
    borderRadius: 10,
    background: `${color}22`,
    color,
    border: `1px solid ${color}55`,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  };
}

export default function InternalVendorMaster() {
  const [rows, setRows] = useState<Vendor[]>([]);
  const [paymentTerms, setPaymentTerms] = useState<PaymentTermOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Wave 5 — DynamicSearchInput. Sync `q` binds to the input so typing is
  // instant; `qDebounced` (200ms) is what drives the fetch.
  const { value: q, debouncedValue: qDebounced, setValue: setQ } = useDebouncedSearch("", 200);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Vendor | null>(null);
  // Chunk E — vendor whose scorecard drawer is open (null = closed).
  const [scorecardId, setScorecardId] = useState<string | null>(null);

  // Wave 5 — universal row-click primitive. Click anywhere on a row (except
  // Edit / Inactivate buttons) to open the edit modal. Soft-deleted vendors
  // are non-interactive.
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const { getRowProps } = useRowClickEdit<Vendor>({
    onRowClick: (v) => setEditing(v),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (v) => `Edit vendor ${v.code ? `${v.code} ` : ""}${v.name}`,
    disabled: (v) => !!v.deleted_at,
  });

  // Wave 5 — universal column visibility. Gear-icon next to search; choices
  // persist per-user via user_preferences (key='table_visibility').
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    VENDOR_MASTER_TABLE_KEY,
    VENDOR_MASTER_COLUMNS,
  );
  const isVisible = useCallback((k: string) => visibleColumns.has(k), [visibleColumns]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (qDebounced.trim()) params.set("q", qDebounced.trim());
      if (includeInactive) params.set("include_inactive", "true");
      const [vendorRes, ptRes] = await Promise.all([
        fetch(`/api/internal/vendor-master?${params.toString()}`),
        fetch(`/api/internal/payment-terms`),
      ]);
      if (!vendorRes.ok) throw new Error((await vendorRes.json().catch(() => ({}))).error || `HTTP ${vendorRes.status}`);
      setRows(await vendorRes.json() as Vendor[]);
      if (ptRes.ok) {
        setPaymentTerms(await ptRes.json() as PaymentTermOption[]);
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [qDebounced, includeInactive]);

  useEffect(() => { void load(); }, [load]);

  // Build a quick lookup map for showing the term label in the list.
  const termById = useMemo(
    () => new Map(paymentTerms.map((t) => [t.id, t])),
    [paymentTerms],
  );

  async function softDelete(id: string) {
    if (!(await confirmDialog("Inactivate this vendor?"))) return;
    try {
      const r = await fetch(`/api/internal/vendor-master/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      notify(`Inactivate failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Vendor Master</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add vendor</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <DynamicSearchInput
          value={q}
          onChange={setQ}
          placeholder="Search name, code, or legal name…"
          ariaLabel="Search vendors"
          wrapperStyle={{ maxWidth: 360 }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Show inactive
        </label>
        <TablePrefsButton
          tableKey={VENDOR_MASTER_TABLE_KEY}
          columns={VENDOR_MASTER_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
        />
        <ExportButton
          rows={rows as unknown as Array<Record<string, unknown>>}
          filename="vendors"
          sheetName="Vendors"
          columns={[
            { key: "code",             header: "Code" },
            { key: "name",             header: "Name" },
            { key: "legal_name",       header: "Legal Name" },
            { key: "country",          header: "Country" },
            { key: "status",           header: "Status" },
            { key: "is_1099_vendor",   header: "1099" },
            { key: "default_currency", header: "Currency" },
            { key: "payment_terms",    header: "Payment Terms" },
            { key: "transit_days",     header: "Transit Days", format: "number" },
            { key: "moq",              header: "MOQ", format: "number" },
            { key: "contact",          header: "Contact" },
            { key: "email",            header: "Email" },
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
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No vendors found.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th} hidden={!isVisible("code")}>Code</th>
                <th style={th} hidden={!isVisible("name")}>Name</th>
                <th style={th} hidden={!isVisible("country")}>Country</th>
                <th style={th} hidden={!isVisible("status")}>Status</th>
                <th style={th} hidden={!isVisible("is_1099_vendor")}>1099</th>
                <th style={th} hidden={!isVisible("payment_terms")}>Payment terms</th>
                <th style={{ ...th, width: 200 }}></th>
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
                    {r.code || "—"}
                  </td>
                  <td style={td} hidden={!isVisible("name")}>
                    <div>{r.name}</div>
                    {r.legal_name && r.legal_name !== r.name && (
                      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                        Legal: {r.legal_name}
                      </div>
                    )}
                  </td>
                  <td style={td} hidden={!isVisible("country")}>{r.country || "—"}</td>
                  <td style={td} hidden={!isVisible("status")}><span style={statusBadge(r.status)}>{r.status}</span></td>
                  <td style={td} hidden={!isVisible("is_1099_vendor")}>{r.is_1099_vendor ? "yes" : "no"}</td>
                  <td style={td} hidden={!isVisible("payment_terms")}>
                    {r.payment_terms_id ? (
                      termById.get(r.payment_terms_id)?.code || "—"
                    ) : r.payment_terms ? (
                      <span style={{ color: C.textMuted, fontStyle: "italic" }} title="Legacy free-text — edit to migrate to structured term">{r.payment_terms}</span>
                    ) : "—"}
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); setScorecardId(r.id); }}
                      style={{ ...btnSecondary, color: C.primary, borderColor: C.primary, fontWeight: 600, marginRight: 6 }}
                      title="Open vendor scorecard (lead time, on-time %, purchases, invoices, POs)"
                      aria-label={`Open scorecard for ${r.name}`}
                    >
                      📊 Scorecard
                    </button>
                    {!r.deleted_at && (
                      <>
                        <button onClick={(e) => { e.stopPropagation(); setEditing(r); }} style={{ ...btnSecondary, marginLeft: 6 }}>Edit</button>
                        <button onClick={(e) => { e.stopPropagation(); void softDelete(r.id); }} style={{ ...btnDanger, marginLeft: 6 }}>Inactivate</button>
                      </>
                    )}
                  </td>
                </ScrollHighlightRow>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && <VendorFormModal mode="add" paymentTerms={paymentTerms} onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load(); }} />}
      {editing && <VendorFormModal mode="edit" vendor={editing} paymentTerms={paymentTerms} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {scorecardId && <VendorScorecard vendorId={scorecardId} onClose={() => setScorecardId(null)} />}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  vendor?: Vendor;
  paymentTerms: PaymentTermOption[];
  onClose: () => void;
  onSaved: () => void;
}

function VendorFormModal({ mode, vendor, paymentTerms, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    name:                          vendor?.name                          ?? "",
    code:                          vendor?.code                          ?? "",
    legal_name:                    vendor?.legal_name                    ?? "",
    country:                       vendor?.country                       ?? "",
    contact:                       vendor?.contact                       ?? "",
    contact_title:                 vendor?.contact_title                 ?? "",
    email:                         vendor?.email                         ?? "",
    phone:                         vendor?.phone                         ?? "",
    address:                       (typeof vendor?.address === "object" && vendor.address !== null
                                     ? vendor.address
                                     : {}) as Address,
    website:                       vendor?.website                       ?? "",
    wechat_id:                     vendor?.wechat_id                     ?? "",
    payment_terms_id:              vendor?.payment_terms_id              ?? "",
    default_currency:              vendor?.default_currency              ?? "USD",
    default_gl_ap_account_id:      vendor?.default_gl_ap_account_id      ?? "",
    default_gl_expense_account_id: vendor?.default_gl_expense_account_id ?? "",
    is_1099_vendor:                vendor?.is_1099_vendor                ?? false,
    status:                        vendor?.status                        ?? "active",
  });
  const [glAccounts, setGlAccounts] = useState<GlAccount[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Load postable GL accounts for the AP + expense account pickers.
  useEffect(() => {
    fetch("/api/internal/gl-accounts?limit=1000")
      .then((r) => r.json())
      .then((arr: GlAccount[]) => setGlAccounts(Array.isArray(arr) ? arr.filter((a) => a.status === "active" && a.is_postable) : []))
      .catch(() => {});
  }, []);

  // Wave 5 — payment-terms picker via SearchableSelect. We include inactive
  // terms only if they are the currently-selected term (so editing an old
  // vendor doesn't silently drop their previous term off the list).
  const paymentTermOptions = useMemo(() => {
    const opts = [
      { value: "", label: "(select)" },
      ...paymentTerms
        .filter((t) => t.is_active || t.id === form.payment_terms_id)
        .map((t) => ({
          value: t.id,
          label: `${t.code} — ${t.name} (${t.due_days}d)`,
          searchHaystack: `${t.code} ${t.name} ${t.due_days}d`,
        })),
    ];
    return opts;
  }, [paymentTerms, form.payment_terms_id]);

  // GL account picker options — postable accounts formatted as "{code} — {name}".
  const glAccountOptions = useMemo(() => [
    { value: "", label: "(select)" },
    ...glAccounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
  ], [glAccounts]);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        name:                          form.name.trim(),
        // Chunk M — code is server-generated; never sent from the client.
        legal_name:                    form.legal_name.trim() || null,
        country:                       form.country.trim() || null,
        contact:                       form.contact.trim() || null,
        contact_title:                 form.contact_title.trim() || null,
        email:                         form.email.trim() || null,
        phone:                         form.phone.trim() || null,
        address:                       form.address,
        website:                       form.website.trim() || null,
        wechat_id:                     form.wechat_id.trim() || null,
        // P3-9: write the structured FK, leave the legacy text column untouched
        // (it stays read-only and can be displayed for backward-compat).
        payment_terms_id:              form.payment_terms_id || null,
        default_currency:              (form.default_currency || "USD").toUpperCase(),
        default_gl_ap_account_id:      form.default_gl_ap_account_id || null,
        default_gl_expense_account_id: form.default_gl_expense_account_id || null,
        is_1099_vendor:                form.is_1099_vendor,
        status:                        form.status,
      };
      let url: string;
      let method: string;
      if (mode === "add") {
        url = "/api/internal/vendor-master";
        method = "POST";
      } else {
        url = `/api/internal/vendor-master/${vendor!.id}`;
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
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, minWidth: 480, maxWidth: 580, color: C.text }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {mode === "add" ? "Add vendor" : `Edit ${vendor!.name}`}
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Name *">
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              style={inputStyle}
              placeholder="Display name"
              autoFocus
            />
          </Field>
          <Field label="Code">
            {/* Chunk M — codes are server-generated + read-only (operator item 14). */}
            <div style={readonlyCodeStyle}>
              {mode === "add"
                ? <span style={{ color: C.textMuted, fontStyle: "italic", fontFamily: "inherit" }}>(auto-generated on save)</span>
                : (vendor?.code || "—")}
            </div>
          </Field>
          <Field label="Legal name">
            <input
              type="text"
              value={form.legal_name}
              onChange={(e) => setForm({ ...form, legal_name: e.target.value })}
              style={inputStyle}
              placeholder="Registered legal entity name"
            />
          </Field>
          <Field label="Country">
            <input
              type="text"
              value={form.country}
              onChange={(e) => setForm({ ...form, country: e.target.value })}
              style={inputStyle}
              placeholder="e.g. US, CN, VN"
            />
          </Field>
          <Field label="Contact name">
            <input
              type="text"
              value={form.contact}
              onChange={(e) => setForm({ ...form, contact: e.target.value })}
              style={inputStyle}
              placeholder="Primary contact person"
            />
          </Field>
          <Field label="Contact title">
            <input
              type="text"
              value={form.contact_title}
              onChange={(e) => setForm({ ...form, contact_title: e.target.value })}
              style={inputStyle}
              placeholder="e.g. Account Manager"
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              style={inputStyle}
              placeholder="vendor@example.com"
            />
          </Field>
          <Field label="Phone">
            <input
              type="text"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              style={inputStyle}
              placeholder="+1 212 555 0100"
            />
          </Field>
          <Field label="Website">
            <input
              type="text"
              value={form.website}
              onChange={(e) => setForm({ ...form, website: e.target.value })}
              style={inputStyle}
              placeholder="https://example.com"
            />
          </Field>
          <Field label="WeChat ID">
            <input
              type="text"
              value={form.wechat_id}
              onChange={(e) => setForm({ ...form, wechat_id: e.target.value })}
              style={inputStyle}
              placeholder="WeChat / 微信"
            />
          </Field>
          <Field label="Payment terms">
            <SearchableSelect
              value={form.payment_terms_id || ""}
              onChange={(v) => setForm({ ...form, payment_terms_id: v })}
              options={paymentTermOptions}
              placeholder="(select)"
              emptyText="No matching terms"
            />
            {mode === "edit" && vendor?.payment_terms && !form.payment_terms_id && (
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, fontStyle: "italic" }}>
                Legacy free-text: &quot;{vendor.payment_terms}&quot; — pick from list to migrate.
              </div>
            )}
          </Field>
          <Field label="Default currency">
            <input
              type="text"
              value={form.default_currency}
              onChange={(e) => setForm({ ...form, default_currency: e.target.value.toUpperCase() })}
              style={inputStyle}
              placeholder="USD"
              maxLength={3}
            />
          </Field>
          <Field label="Status">
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} style={inputStyle as React.CSSProperties}>
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="1099 vendor?">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={form.is_1099_vendor}
                onChange={(e) => setForm({ ...form, is_1099_vendor: e.target.checked })}
              />
              Yes (issue 1099-MISC at year-end)
            </label>
          </Field>
          <Field label="Default AP account">
            <SearchableSelect
              value={form.default_gl_ap_account_id || ""}
              onChange={(v) => setForm({ ...form, default_gl_ap_account_id: v })}
              options={glAccountOptions}
              placeholder="(select)"
              emptyText="No matching accounts"
            />
          </Field>
          <Field label="Default expense account">
            <SearchableSelect
              value={form.default_gl_expense_account_id || ""}
              onChange={(v) => setForm({ ...form, default_gl_expense_account_id: v })}
              options={glAccountOptions}
              placeholder="(select)"
              emptyText="No matching accounts"
            />
          </Field>
          <div style={{ gridColumn: "1 / -1" }}>
            <AddressFields label="Address" value={form.address} onChange={(a) => setForm({ ...form, address: a })} />
          </div>
        </div>

        <div style={{
          marginTop: 14, padding: "8px 12px",
          background: "#0b1220", border: `1px dashed ${C.cardBdr}`,
          borderRadius: 6, fontSize: 11, color: C.textMuted, lineHeight: 1.5,
        }}>
          Tax ID and banking handled via dedicated PII workflow.
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

        {mode === "edit" && vendor && (
          <div style={{ marginTop: 16 }}>
            <DocumentAttachmentList
              contextTable="vendors"
              contextId={vendor.id}
              kinds={["contract", "w9", "coa", "insurance", "other"]}
            />
          </div>
        )}

        {/* Cross-cutter T11-3 — audit trail timeline */}
        {mode === "edit" && vendor && (
          <RowHistory source_table="vendors" source_id={vendor.id} />
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
