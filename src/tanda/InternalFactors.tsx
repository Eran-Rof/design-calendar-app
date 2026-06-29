// src/tanda/InternalFactors.tsx
//
// Chunk I — Factor / Insurance Master admin panel.
// List + search + active toggle + create + edit + hard-delete.
// Wraps /api/internal/factors and /api/internal/factors/:id.
//
// A "factor" is a receivables financier / credit insurer. Full contact
// profile: code, name, contact_name, phone, email, website, address (jsonb),
// up to 3 additional contacts (jsonb), api_enabled, notes, is_active.
// Entity-scoped (ROF). Country + state inside the address are searchable
// dropdowns provided by the shared AddressFields editor.

import { useEffect, useState } from "react";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";

const FACTORS_TABLE_KEY = "tangerine:factors:columns";
const FACTOR_COLUMNS: ColumnDef[] = [
  { key: "code",         label: "Code" },
  { key: "name",         label: "Name" },
  { key: "contact_name", label: "Contact" },
  { key: "phone",        label: "Phone" },
  { key: "email",        label: "Email" },
  { key: "api_enabled",  label: "API" },
  { key: "is_active",    label: "Active" },
];
import AddressFields, { type Address } from "./components/AddressFields";
import ContactList, { type Contact } from "./components/ContactList";
import MailLink from "./components/MailLink";
import { formatUsPhone } from "../shared/phone";

type Factor = {
  id: string;
  entity_id: string;
  code: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: Address | null;
  contacts: Contact[] | null;
  api_enabled: boolean;
  notes: string | null;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
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
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box",
};
// Chunk M — greyed, read-only display for server-generated codes (operator item 14).
const readonlyCodeStyle: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, border: `1px dashed ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box",
  display: "flex", alignItems: "center",
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

export default function InternalFactors() {
  const [rows, setRows] = useState<Factor[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const { value: q, debouncedValue: qDebounced, setValue: setQ } = useDebouncedSearch("", 200);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Factor | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    FACTORS_TABLE_KEY,
    FACTOR_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:factors:sort",
  });

  const { getRowProps } = useRowClickEdit<Factor>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit factor ${r.code}`,
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (qDebounced.trim()) params.set("q", qDebounced.trim());
      if (includeInactive) params.set("include_inactive", "true");
      const fRes = await fetch(`/api/internal/factors?${params.toString()}`);
      if (!fRes.ok) throw new Error((await fRes.json().catch(() => ({}))).error || `HTTP ${fRes.status}`);
      setRows(await fRes.json() as Factor[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [qDebounced, includeInactive]);

  async function del(f: Factor) {
    if (!(await confirmDialog(`Delete factor ${f.code} (${f.name})?`))) return;
    try {
      const r = await fetch(`/api/internal/factors/${f.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Factor / Insurance Master</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add factor</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          placeholder="Search code, name, or contact…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ ...inputStyle, maxWidth: 320 }}
        />
        <button onClick={() => void load()} style={btnSecondary}>Search</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show inactive
        </label>
        <ExportButton
          rows={rows as unknown as Array<Record<string, unknown>>}
          filename="factors"
          sheetName="Factors"
          columns={[
            { key: "code",         header: "Code" },
            { key: "name",         header: "Name" },
            { key: "contact_name", header: "Contact" },
            { key: "phone",        header: "Phone" },
            { key: "email",        header: "Email" },
            { key: "website",      header: "Website" },
            { key: "api_enabled",  header: "API" },
            { key: "is_active",    header: "Active" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
        <TablePrefsButton
          tableKey={FACTORS_TABLE_KEY}
          columns={FACTOR_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
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
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No factors found.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <SortableTh label="Code" sortKey="code" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("code")} />
                <SortableTh label="Name" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("name")} />
                <SortableTh label="Contact" sortKey="contact_name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("contact_name")} />
                <SortableTh label="Phone" sortKey="phone" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("phone")} />
                <SortableTh label="Email" sortKey="email" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("email")} />
                <SortableTh label="API" sortKey="api_enabled" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("api_enabled")} />
                <SortableTh label="Active" sortKey="is_active" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("is_active")} />
                <th style={{ ...th, width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((f) => (
                <ScrollHighlightRow
                  key={f.id}
                  rowId={f.id}
                  highlightedRowId={highlightedId}
                  {...getRowProps(f)}
                  style={!f.is_active ? { opacity: 0.5 } : undefined}
                >
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }} hidden={!isVisible("code")}>{f.code}</td>
                  <td style={td} hidden={!isVisible("name")}>{f.name}</td>
                  <td style={td} hidden={!isVisible("contact_name")}>{f.contact_name || "—"}</td>
                  <td style={td} hidden={!isVisible("phone")}>{f.phone || "—"}</td>
                  <td style={td} hidden={!isVisible("email")}>{f.email ? <MailLink email={f.email}>{f.email}</MailLink> : "—"}</td>
                  <td style={td} hidden={!isVisible("api_enabled")}>{f.api_enabled ? "yes" : "no"}</td>
                  <td style={td} hidden={!isVisible("is_active")}>{f.is_active ? "yes" : "no"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={(e) => { e.stopPropagation(); setEditing(f); }} style={btnSecondary}>Edit</button>
                    <button onClick={(e) => { e.stopPropagation(); void del(f); }} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                  </td>
                </ScrollHighlightRow>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && <FactorFormModal mode="add" onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load(); }} />}
      {editing && <FactorFormModal mode="edit" factor={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  factor?: Factor;
  onClose: () => void;
  onSaved: () => void;
}

function FactorFormModal({ mode, factor, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    code:         factor?.code         ?? "",
    name:         factor?.name         ?? "",
    contact_name: factor?.contact_name ?? "",
    phone:        factor?.phone        ?? "",
    email:        factor?.email        ?? "",
    website:      factor?.website      ?? "",
    notes:        factor?.notes        ?? "",
    api_enabled:  factor?.api_enabled  ?? false,
    is_active:    factor?.is_active    ?? true,
    contacts:     (Array.isArray(factor?.contacts) ? factor!.contacts : []) as Contact[],
  });
  const [address, setAddress] = useState<Address>(factor?.address ?? {});
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const isAdd = mode === "add";
      const url = isAdd ? "/api/internal/factors" : `/api/internal/factors/${factor!.id}`;
      const method = isAdd ? "POST" : "PATCH";
      const body: Record<string, unknown> = {
        name:         form.name.trim(),
        contact_name: form.contact_name.trim() || null,
        phone:        form.phone.trim() || null,
        email:        form.email.trim() || null,
        website:      form.website.trim() || null,
        notes:        form.notes.trim() || null,
        address,
        api_enabled:  form.api_enabled,
        is_active:    form.is_active,
        contacts:     form.contacts.filter((c) => Object.values(c).some((x) => String(x ?? "").trim() !== "")),
      };
      // Chunk M — code is server-generated; never sent from the client.
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
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(720px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{mode === "add" ? "Add factor" : `Edit ${factor!.code}`}</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Code">
            {/* Chunk M — codes are server-generated + read-only (operator item 14). */}
            <div style={readonlyCodeStyle}>
              {mode === "add"
                ? <span style={{ color: C.textMuted, fontStyle: "italic", fontFamily: "inherit" }}>(auto-generated on save)</span>
                : (factor?.code || "—")}
            </div>
          </Field>
          <Field label="Name *">
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} placeholder="CIT Commercial Services" />
          </Field>
          <Field label="Contact name">
            <input type="text" value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} style={inputStyle} />
          </Field>
          <Field label="Phone">
            <input type="text" value={form.phone} onChange={(e) => setForm({ ...form, phone: formatUsPhone(e.target.value) })} style={inputStyle} placeholder="(555) 000-0000" />
          </Field>
          <Field label="Email">
            <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} style={{ ...inputStyle, paddingRight: 30 }} placeholder="contact@factor.com" />
              <MailLink email={form.email} />
            </div>
          </Field>
          <Field label="Website">
            <input type="text" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} style={inputStyle} placeholder="https://…" />
          </Field>
        </div>

        <div style={{ marginTop: 12 }}>
          <AddressFields label="Address" value={address} onChange={setAddress} />
        </div>

        <div style={{ marginTop: 12 }}>
          <ContactList
            label="Additional contacts"
            value={form.contacts}
            onChange={(next) => setForm({ ...form, contacts: next })}
            max={3}
            fields={["name", "phone", "email", "title"]}
          />
        </div>

        <div style={{ marginTop: 12 }}>
          <Field label="Notes">
            <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={{ ...inputStyle, minHeight: 56, resize: "vertical" }} />
          </Field>
        </div>

        <div style={{ display: "flex", gap: 24, marginTop: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
            <input type="checkbox" checked={form.api_enabled} onChange={(e) => setForm({ ...form, api_enabled: e.target.checked })} />
            API enabled
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
            <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
            Active
          </label>
        </div>

        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting}>{submitting ? "Saving…" : mode === "add" ? "Create" : "Save"}</button>
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
