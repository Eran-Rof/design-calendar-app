// src/tanda/InternalServiceItemMaster.tsx
//
// Tangerine — Manufacturing Service Item Master admin panel.
// List + search + active toggle + create + edit + hard-delete.
// Wraps /api/internal/service-items and /api/internal/service-items/:id.
//
// A SERVICE ITEM is an outsourced conversion/labor charge (print, sew, pack,
// wash). Per the CMT model it is a VENDOR AP CHARGE, not a stocked item or an
// internal labor rate. When `applied_to_wip` it capitalizes into the finished
// good's WIP cost; otherwise it expenses to `default_expense_account_id`.

import { useEffect, useMemo, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import SearchableSelect, { type SearchableSelectOption } from "./components/SearchableSelect";
import DocumentAttachmentList from "../shared/documents/DocumentAttachmentList";

type Vendor = { id: string; name: string };
type Account = { id: string; code: string; name: string; is_postable: boolean };

type ServiceItem = {
  id: string;
  entity_id: string;
  code: string;
  name: string;
  service_kind: string;
  is_labor: boolean;
  default_vendor_id: string | null;
  default_charge_cents: number | null;
  default_expense_account_id: string | null;
  applied_to_wip: boolean;
  notes: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

const SERVICE_KINDS = ["print", "sew", "pack", "wash", "conversion", "other"] as const;
const KIND_LABEL: Record<string, string> = {
  print: "Print", sew: "Sew", pack: "Pack", wash: "Wash", conversion: "Conversion", other: "Other",
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12 };
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d" };
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box" };
const readonlyCodeStyle: React.CSSProperties = { background: "#0b1220", color: C.textMuted, border: `1px dashed ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box", display: "flex", alignItems: "center", fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600, opacity: 0.85 };
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };

function fmtMoney(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function InternalServiceItemMaster() {
  const [rows, setRows] = useState<ServiceItem[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<ServiceItem | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const vendorName = useMemo(() => {
    const m = new Map(vendors.map((v) => [v.id, v.name]));
    return (id: string | null) => (id ? m.get(id) ?? "—" : "—");
  }, [vendors]);
  const acctLabel = useMemo(() => {
    const m = new Map(accounts.map((a) => [a.id, `${a.code} — ${a.name}`]));
    return (id: string | null) => (id ? m.get(id) ?? "—" : "—");
  }, [accounts]);

  const { getRowProps } = useRowClickEdit<ServiceItem>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit service ${r.code}`,
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/service-items?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as ServiceItem[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function loadVendors() {
    try {
      const r = await fetch(`/api/internal/vendor-master?limit=5000`);
      if (r.ok) { const d = await r.json(); if (Array.isArray(d)) setVendors(d as Vendor[]); }
    } catch { /* non-fatal */ }
  }
  async function loadAccounts() {
    try {
      const r = await fetch(`/api/internal/gl-accounts?limit=1000`);
      if (r.ok) { const d = await r.json(); if (Array.isArray(d)) setAccounts(d as Account[]); }
    } catch { /* non-fatal */ }
  }

  useEffect(() => { void load(); }, [includeInactive]);
  useEffect(() => { void loadVendors(); void loadAccounts(); }, []);

  async function del(s: ServiceItem) {
    if (!(await confirmDialog(`Delete service ${s.code} (${s.name})?\nThis cannot be undone — toggle is_active=false to retire it instead.`))) return;
    try {
      const r = await fetch(`/api/internal/service-items/${s.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Service Item Master</h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: C.textMuted }}>
            Outsourced conversion / labor charges (print, sew, pack, wash). Captured as a vendor AP charge; capitalized into WIP when applied.
          </p>
        </div>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add service</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input type="text" placeholder="Search code or name…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void load()} style={{ ...inputStyle, maxWidth: 280 }} />
        <button onClick={() => void load()} style={btnSecondary}>Search</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show inactive
        </label>
        <ExportButton
          rows={rows.map((s) => ({ ...s, vendor_name: vendorName(s.default_vendor_id), expense_account: acctLabel(s.default_expense_account_id), kind_label: KIND_LABEL[s.service_kind] ?? s.service_kind })) as unknown as Array<Record<string, unknown>>}
          filename="service-items"
          sheetName="Service Items"
          columns={[
            { key: "code", header: "Code" },
            { key: "name", header: "Name" },
            { key: "kind_label", header: "Kind" },
            { key: "is_labor", header: "Labor" },
            { key: "vendor_name", header: "Vendor" },
            { key: "default_charge_cents", header: "Default Charge", format: "currency_cents" },
            { key: "applied_to_wip", header: "To WIP" },
            { key: "expense_account", header: "Expense Acct" },
            { key: "notes", header: "Notes" },
            { key: "is_active", header: "Active" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>Error: {err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No service items found. Add one with &quot;+ Add service&quot;.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Code</th>
                <th style={th}>Name</th>
                <th style={th}>Kind</th>
                <th style={th}>Default Vendor</th>
                <th style={{ ...th, textAlign: "right" }}>Default Charge</th>
                <th style={th}>To WIP</th>
                <th style={th}>Active</th>
                <th style={{ ...th, width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <ScrollHighlightRow key={s.id} rowId={s.id} highlightedRowId={highlightedId} {...getRowProps(s)} style={!s.is_active ? { opacity: 0.5 } : undefined}>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>{s.code}</td>
                  <td style={td}>{s.name}</td>
                  <td style={{ ...td, color: C.textSub }}>{KIND_LABEL[s.service_kind] ?? s.service_kind}</td>
                  <td style={{ ...td, color: C.textSub }}>{vendorName(s.default_vendor_id)}</td>
                  <td style={{ ...td, textAlign: "right" }}>{fmtMoney(s.default_charge_cents)}</td>
                  <td style={td}>{s.applied_to_wip ? "yes" : "no"}</td>
                  <td style={td}>{s.is_active ? "yes" : "no"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={(e) => { e.stopPropagation(); setEditing(s); }} style={btnSecondary}>Edit</button>
                    <button onClick={(e) => { e.stopPropagation(); void del(s); }} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                  </td>
                </ScrollHighlightRow>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && <ServiceFormModal mode="add" vendors={vendors} accounts={accounts} onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load(); }} />}
      {editing && <ServiceFormModal mode="edit" item={editing} vendors={vendors} accounts={accounts} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  item?: ServiceItem;
  vendors: Vendor[];
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}

function ServiceFormModal({ mode, item, vendors, accounts, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    name:           item?.name ?? "",
    service_kind:   item?.service_kind ?? "conversion",
    is_labor:       item?.is_labor ?? true,
    default_vendor_id: item?.default_vendor_id ?? "",
    default_charge: item?.default_charge_cents != null ? (item.default_charge_cents / 100).toString() : "",
    default_expense_account_id: item?.default_expense_account_id ?? "",
    applied_to_wip: item?.applied_to_wip ?? true,
    notes:          item?.notes ?? "",
    sort_order:     item?.sort_order != null ? String(item.sort_order) : "0",
    is_active:      item?.is_active ?? true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const vendorOptions: SearchableSelectOption[] = useMemo(
    () => [{ value: "", label: "— none —" }, ...vendors.map((v) => ({ value: v.id, label: v.name }))],
    [vendors],
  );
  const acctOptions: SearchableSelectOption[] = useMemo(
    () => [{ value: "", label: "— none —" }, ...accounts.filter((a) => a.is_postable).map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))],
    [accounts],
  );

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const url = mode === "add" ? "/api/internal/service-items" : `/api/internal/service-items/${item!.id}`;
      const method = mode === "add" ? "POST" : "PATCH";
      const chargeStr = form.default_charge.trim();
      const body = {
        name:           form.name.trim(),
        service_kind:   form.service_kind,
        is_labor:       form.is_labor,
        default_vendor_id: form.default_vendor_id || null,
        default_charge_cents: chargeStr === "" ? null : Math.round(parseFloat(chargeStr) * 100),
        default_expense_account_id: form.default_expense_account_id || null,
        applied_to_wip: form.applied_to_wip,
        notes:          form.notes.trim() || null,
        sort_order:     form.sort_order.trim() === "" ? 0 : parseInt(form.sort_order, 10),
        is_active:      form.is_active,
      };
      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(620px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{mode === "add" ? "Add service item" : `Edit ${item!.code}`}</h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Code">
            <div style={readonlyCodeStyle}>
              {mode === "add" ? <span style={{ color: C.textMuted, fontStyle: "italic", fontFamily: "inherit" }}>(auto-generated on save)</span> : (item?.code || "—")}
            </div>
          </Field>
          <Field label="Name *">
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} placeholder="e.g. Screen print front + back" autoFocus />
          </Field>
          <Field label="Service kind">
            <SearchableSelect value={form.service_kind} onChange={(v) => setForm({ ...form, service_kind: v })} options={SERVICE_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))} placeholder="Pick a kind…" />
          </Field>
          <Field label="Default vendor">
            <SearchableSelect value={form.default_vendor_id} onChange={(v) => setForm({ ...form, default_vendor_id: v })} options={vendorOptions} placeholder="— none —" />
          </Field>
          <Field label="Default charge ($/unit)">
            <input type="number" min="0" step="0.01" value={form.default_charge} onChange={(e) => setForm({ ...form, default_charge: e.target.value })} style={inputStyle} placeholder="0.00" />
          </Field>
          <Field label="Labor">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input type="checkbox" checked={form.is_labor} onChange={(e) => setForm({ ...form, is_labor: e.target.checked })} />
              is_labor (reporting)
            </label>
          </Field>
          <Field label="Capitalize to WIP">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input type="checkbox" checked={form.applied_to_wip} onChange={(e) => setForm({ ...form, applied_to_wip: e.target.checked })} />
              applied_to_wip
            </label>
          </Field>
          {!form.applied_to_wip && (
            <div style={{ gridColumn: "1 / -1" }}>
              <Field label="Expense account (when not WIP)">
                <SearchableSelect value={form.default_expense_account_id} onChange={(v) => setForm({ ...form, default_expense_account_id: v })} options={acctOptions} placeholder="— none —" />
              </Field>
            </div>
          )}
          <Field label="Sort order">
            <input type="number" min="0" step="1" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: e.target.value })} style={inputStyle} placeholder="0" />
          </Field>
          <Field label="Active">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
              is_active
            </label>
          </Field>
          <div style={{ gridColumn: "1 / -1" }}>
            <Field label="Notes">
              <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={{ ...inputStyle, minHeight: 64, resize: "vertical" }} placeholder="Any notes about this service…" />
            </Field>
          </div>
        </div>

        {mode === "edit" && item && (
          <div style={{ marginTop: 16, borderTop: `1px solid ${C.cardBdr}`, paddingTop: 16 }}>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Attachments</div>
            <DocumentAttachmentList contextTable="service_item_master" contextId={item.id} kinds={["quote", "contract", "other"]} />
          </div>
        )}

        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>{err}</div>}

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
