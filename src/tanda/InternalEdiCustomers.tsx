// src/tanda/InternalEdiCustomers.tsx
//
// Tangerine — EDI Customers (customer-side trading partners, MVP config).
//
// Lists the CUSTOMERS we exchange EDI with: customer NAME (never the uuid),
// partner ISA qualifier/ID, the supported X12 document sets, and an active flag.
// Create / edit via a modal (customer picked from /api/internal/customer-master
// via SearchableSelect). Wraps /api/internal/edi/customer-partners[/:id].
//
// SCOPE: config / structure only. Live transaction transport over the VAN is a
// follow-up; planned flows are inbound 850 (PO) → outbound 810 (invoice) /
// 856 (ASN).

import { useEffect, useMemo, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import SearchableSelect from "./components/SearchableSelect";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";

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
  padding: "8px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box",
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const docChip: React.CSSProperties = { background: "#1d4ed822", color: "#93c5fd", padding: "2px 7px", borderRadius: 10, fontSize: 11, fontWeight: 600, marginRight: 4 };

// X12 document sets a customer trading partner may exchange.
const DOC_OPTIONS: { code: string; label: string }[] = [
  { code: "850", label: "850 Purchase Order (inbound)" },
  { code: "810", label: "810 Invoice (outbound)" },
  { code: "856", label: "856 ASN (outbound)" },
  { code: "855", label: "855 PO Acknowledgement" },
  { code: "997", label: "997 Functional Ack" },
];

type Partner = {
  id: string;
  customer_id: string;
  customer_name: string;
  customer_code: string;
  partner_isa_qualifier: string | null;
  partner_isa_id: string | null;
  supported_docs: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
};
type Customer = { id: string; name: string; code?: string; customer_code?: string };

export default function InternalEdiCustomers() {
  const [rows, setRows] = useState<Partner[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Partner | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/edi/customer-partners?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as Partner[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [includeInactive]);
  useEffect(() => {
    fetch("/api/internal/customer-master?limit=5000")
      .then((r) => r.json())
      .then((a) => { if (Array.isArray(a)) setCustomers(a as Customer[]); })
      .catch(() => {});
  }, []);

  async function del(p: Partner) {
    if (!(await confirmDialog(`Remove EDI trading-partner config for ${p.customer_name || "this customer"}?`, { confirmText: "Remove", danger: true }))) return;
    try {
      const r = await fetch(`/api/internal/edi/customer-partners/${p.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify("Trading partner removed", "success");
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  // #5 — tri-state column sort for the trading-partner LIST table. Customer
  // sorts by display name; active by boolean. Supported-docs is JSX-only.
  const {
    sorted: sortedRows,
    sortKey,
    sortDir,
    onHeaderClick,
  } = useSort(rows, {
    persistKey: "tangerine:edi-customers:sort",
    accessors: {
      customer: (p) => p.customer_name || "",
      partner_isa_qualifier: (p) => p.partner_isa_qualifier || "",
      partner_isa_id: (p) => p.partner_isa_id || "",
      is_active: (p) => (p.is_active ? 1 : 0),
    },
  });

  const exportRows = rows.map((p) => ({
    customer: p.customer_name, partner_isa_qualifier: p.partner_isa_qualifier || "",
    partner_isa_id: p.partner_isa_id || "", supported_docs: (p.supported_docs || []).join(" "),
    is_active: p.is_active ? "yes" : "no",
  }));
  const exportCols: ExportColumn<Record<string, unknown>>[] = [
    { key: "customer", header: "Customer" },
    { key: "partner_isa_qualifier", header: "ISA Qual" },
    { key: "partner_isa_id", header: "ISA ID" },
    { key: "supported_docs", header: "Supported Docs" },
    { key: "is_active", header: "Active" },
  ];

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>EDI Customers</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add trading partner</button>
      </div>
      <p style={{ color: C.textMuted, fontSize: 13, marginTop: 0, maxWidth: 760 }}>
        Customer-side EDI trading partners. Config only — planned flows are inbound{" "}
        <strong>850</strong> (purchase order) and outbound <strong>810</strong> (invoice) /{" "}
        <strong>856</strong> (ASN). Live transport over the VAN is a follow-up.
      </p>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          placeholder="Search customer or ISA ID…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void load()}
          onFocus={(e) => e.currentTarget.select()}
          style={{ ...inputStyle, maxWidth: 280 }}
        />
        <button onClick={() => void load()} style={btnSecondary}>Search</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show inactive
        </label>
        <ExportButton rows={exportRows as unknown as Array<Record<string, unknown>>} columns={exportCols} filename="edi-customer-partners" sheetName="EDI Customers" />
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
            No customer trading partners yet. Add one with &quot;+ Add trading partner&quot;.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <SortableTh label="Customer" sortKey="customer" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
                <SortableTh label="ISA Qual" sortKey="partner_isa_qualifier" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
                <SortableTh label="ISA ID" sortKey="partner_isa_id" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
                <th style={th}>Supported docs</th>
                <SortableTh label="Active" sortKey="is_active" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
                <th style={{ ...th, width: 150 }}></th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((p) => (
                <tr key={p.id} style={!p.is_active ? { opacity: 0.5 } : undefined}>
                  <td style={td}>{p.customer_name || "—"}{p.customer_code ? <span style={{ color: C.textMuted }}> ({p.customer_code})</span> : null}</td>
                  <td style={{ ...td, fontFamily: "monospace" }}>{p.partner_isa_qualifier || "—"}</td>
                  <td style={{ ...td, fontFamily: "monospace" }}>{p.partner_isa_id || "—"}</td>
                  <td style={td}>{(p.supported_docs || []).length ? (p.supported_docs || []).map((d) => <span key={d} style={docChip}>{d}</span>) : <span style={{ color: C.textMuted }}>—</span>}</td>
                  <td style={td}>{p.is_active ? "yes" : "no"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={() => setEditing(p)} style={btnSecondary}>Edit</button>
                    <button onClick={() => void del(p)} style={{ ...btnDanger, marginLeft: 6 }}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Planned-document flows placeholder. */}
      <div style={{ marginTop: 18, background: C.card, border: `1px dashed ${C.cardBdr}`, borderRadius: 10, padding: 16, maxWidth: 760 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.textSub, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Documents (planned)</div>
        <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6 }}>
          Once VAN transport is wired up, the customer-side EDI flow will be:
          <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
            <li><span style={docChip}>850</span> inbound — retailer purchase order ingested into a Sales Order.</li>
            <li><span style={docChip}>810</span> outbound — invoice emitted from the AR invoice.</li>
            <li><span style={docChip}>856</span> outbound — Advance Ship Notice from the shipment.</li>
          </ul>
          <div style={{ marginTop: 8, color: C.warn }}>Transport / live transaction exchange is a follow-up — this panel configures partners only.</div>
        </div>
      </div>

      {addOpen && (
        <PartnerModal mode="add" customers={customers} existing={rows} onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load(); }} />
      )}
      {editing && (
        <PartnerModal mode="edit" partner={editing} customers={customers} existing={rows} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />
      )}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  partner?: Partner;
  customers: Customer[];
  existing: Partner[];
  onClose: () => void;
  onSaved: () => void;
}

function PartnerModal({ mode, partner, customers, existing, onClose, onSaved }: ModalProps) {
  const [customerId, setCustomerId] = useState(partner?.customer_id ?? "");
  const [isaQual, setIsaQual] = useState(partner?.partner_isa_qualifier ?? "");
  const [isaId, setIsaId] = useState(partner?.partner_isa_id ?? "");
  const [docs, setDocs] = useState<string[]>(partner?.supported_docs ?? ["850", "810", "856"]);
  const [isActive, setIsActive] = useState(partner?.is_active ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // On add, hide customers already configured as partners.
  const takenIds = useMemo(() => new Set(existing.map((e) => e.customer_id)), [existing]);
  const customerOptions = useMemo(() => customers
    .filter((c) => mode === "edit" || !takenIds.has(c.id))
    .map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.name} ${c.customer_code || c.code || ""}` })),
  [customers, takenIds, mode]);

  function toggleDoc(code: string) {
    setDocs((d) => d.includes(code) ? d.filter((x) => x !== code) : [...d, code]);
  }

  async function submit() {
    if (mode === "add" && !customerId) { setErr("Pick a customer"); return; }
    setSubmitting(true);
    setErr(null);
    try {
      const url = mode === "add" ? "/api/internal/edi/customer-partners" : `/api/internal/edi/customer-partners/${partner!.id}`;
      const method = mode === "add" ? "POST" : "PATCH";
      const body: Record<string, unknown> = {
        partner_isa_qualifier: isaQual.trim() || null,
        partner_isa_id: isaId.trim() || null,
        supported_docs: docs,
        is_active: isActive,
      };
      if (mode === "add") body.customer_id = customerId;
      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const customerLabel = partner?.customer_name
    || customers.find((c) => c.id === customerId)?.name
    || "—";

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {mode === "add" ? "Add trading partner" : `Edit ${customerLabel}`}
        </h3>

        <div style={{ display: "grid", gap: 14 }}>
          <Field label="Customer *">
            {mode === "add" ? (
              <SearchableSelect options={customerOptions} value={customerId} onChange={setCustomerId} placeholder="Pick a customer…" />
            ) : (
              <div style={{ ...inputStyle, color: C.textSub, background: "#0b1220" }}>{customerLabel}</div>
            )}
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Field label="Partner ISA qualifier">
              <input style={inputStyle} value={isaQual} onChange={(e) => setIsaQual(e.target.value)} placeholder="e.g. ZZ or 01" />
            </Field>
            <Field label="Partner ISA ID">
              <input style={inputStyle} value={isaId} onChange={(e) => setIsaId(e.target.value)} placeholder="ISA08" />
            </Field>
          </div>
          <Field label="Supported documents">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {DOC_OPTIONS.map((d) => (
                <label key={d.code} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: "6px 10px", cursor: "pointer" }}>
                  <input type="checkbox" checked={docs.includes(d.code)} onChange={() => toggleDoc(d.code)} />
                  {d.label}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Active">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              is_active
            </label>
          </Field>
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>{err}</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting}>
            {submitting ? "Saving…" : mode === "add" ? "Create" : "Save"}
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
