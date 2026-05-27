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

import { useEffect, useState } from "react";
import DocumentAttachmentList from "../shared/documents/DocumentAttachmentList";

type Vendor = {
  id: string;
  code: string | null;
  name: string;
  legal_name: string | null;
  country: string | null;
  transit_days: number | null;
  categories: string[] | null;
  contact: string | null;
  email: string | null;
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
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Vendor | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
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
  }

  useEffect(() => { void load(); }, [includeInactive]);

  // Build a quick lookup map for showing the term label in the list.
  const termById = new Map(paymentTerms.map((t) => [t.id, t]));

  async function softDelete(id: string) {
    if (!confirm("Inactivate this vendor?")) return;
    try {
      const r = await fetch(`/api/internal/vendor-master/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      alert(`Inactivate failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Vendor Master</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add vendor</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        <input
          type="text"
          placeholder="Search name, code, or legal name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void load()}
          style={{ ...inputStyle, maxWidth: 360 }}
        />
        <button onClick={() => void load()} style={btnSecondary}>Search</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Show inactive
        </label>
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
                <th style={th}>Code</th>
                <th style={th}>Name</th>
                <th style={th}>Country</th>
                <th style={th}>Status</th>
                <th style={th}>1099</th>
                <th style={th}>Payment terms</th>
                <th style={{ ...th, width: 140 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={r.deleted_at ? { opacity: 0.4 } : {}}>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>
                    {r.code || "—"}
                  </td>
                  <td style={td}>
                    <div>{r.name}</div>
                    {r.legal_name && r.legal_name !== r.name && (
                      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                        Legal: {r.legal_name}
                      </div>
                    )}
                  </td>
                  <td style={td}>{r.country || "—"}</td>
                  <td style={td}><span style={statusBadge(r.status)}>{r.status}</span></td>
                  <td style={td}>{r.is_1099_vendor ? "yes" : "no"}</td>
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
                        <button onClick={() => void softDelete(r.id)} style={{ ...btnDanger, marginLeft: 6 }}>Inactivate</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && <VendorFormModal mode="add" paymentTerms={paymentTerms} onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load(); }} />}
      {editing && <VendorFormModal mode="edit" vendor={editing} paymentTerms={paymentTerms} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
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
    name:             vendor?.name             ?? "",
    code:             vendor?.code             ?? "",
    legal_name:       vendor?.legal_name       ?? "",
    country:          vendor?.country          ?? "",
    payment_terms_id: vendor?.payment_terms_id ?? "",
    default_currency: vendor?.default_currency ?? "USD",
    is_1099_vendor:   vendor?.is_1099_vendor   ?? false,
    status:           vendor?.status           ?? "active",
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        name:             form.name.trim(),
        code:             form.code.trim() ? form.code.trim().toUpperCase() : null,
        legal_name:       form.legal_name.trim() || null,
        country:          form.country.trim() || null,
        // P3-9: write the structured FK, leave the legacy text column untouched
        // (it stays read-only and can be displayed for backward-compat).
        payment_terms_id: form.payment_terms_id || null,
        default_currency: (form.default_currency || "USD").toUpperCase(),
        is_1099_vendor:   form.is_1099_vendor,
        status:           form.status,
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
            <input
              type="text"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              style={inputStyle}
              placeholder="Short code (e.g. ACME01)"
            />
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
