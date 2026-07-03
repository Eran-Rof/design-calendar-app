// src/tanda/InternalFabricMillMaster.tsx
//
// Tangerine — Fabric Mill Master admin panel.
// List + search + active toggle + create + edit + hard-delete.
// Wraps /api/internal/fabric-mills and /api/internal/fabric-mills/:id.
//
// A fabric mill is a manufacturer or supplier of fabric. Operators use this
// panel to track which mills they source fabric from (name, country, contact,
// website, notes). The master simply curates the list; there is no FK from
// fabric codes or styles to this table yet.

import { useEffect, useMemo, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import SearchableSelect from "./components/SearchableSelect";
import ContactList, { type Contact } from "./components/ContactList";

// ── Country master cache: fetch /api/internal/countries once, share across
// every mounted modal (mirrors AddressFields' module-level cache). ────────────
type Country = { iso2: string; name: string };
let countriesCache: Country[] | null = null;
let countriesPromise: Promise<Country[]> | null = null;
function loadCountries(): Promise<Country[]> {
  if (countriesCache) return Promise.resolve(countriesCache);
  if (!countriesPromise) {
    countriesPromise = fetch("/api/internal/countries")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => { countriesCache = Array.isArray(d) ? d : []; return countriesCache; })
      .catch(() => { countriesCache = []; return countriesCache; });
  }
  return countriesPromise;
}

const FABRIC_MILLS_TABLE_KEY = "tangerine:fabricmills:columns";
const FABRIC_MILL_COLUMNS: ColumnDef[] = [
  { key: "code",     label: "Code" },
  { key: "name",     label: "Name" },
  { key: "country",  label: "Country" },
  { key: "contact",  label: "Contact" },
  { key: "email",    label: "Email" },
  { key: "website",  label: "Website" },
  { key: "active",   label: "Active" },
];

type FabricMill = {
  id: string;
  entity_id: string;
  code: string;
  name: string;
  country_code: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contacts: Contact[] | null;
  website: string | null;
  notes: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
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
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
};
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
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};

export default function InternalFabricMillMaster() {
  const [rows, setRows] = useState<FabricMill[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<FabricMill | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(
    FABRIC_MILLS_TABLE_KEY,
    FABRIC_MILL_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  const { getRowProps } = useRowClickEdit<FabricMill>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit fabric mill ${r.code}`,
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/fabric-mills?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as FabricMill[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [includeInactive]);

  async function del(s: FabricMill) {
    if (!(await confirmDialog(`Delete fabric mill ${s.code} (${s.name})?\nThis cannot be undone — toggle is_active=false to retire it instead.`))) return;
    try {
      const r = await fetch(`/api/internal/fabric-mills/${s.id}`, { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Fabric Mill Master</h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: C.textMuted }}>
            Fabric manufacturers and suppliers. Used to track sourcing origins.
          </p>
        </div>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add mill</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          placeholder="Search code, name, or country…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void load()}
          style={{ ...inputStyle, maxWidth: 280 }}
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
        <ExportButton
          rows={rows as unknown as Array<Record<string, unknown>>}
          filename="fabric-mills"
          sheetName="Fabric Mills"
          columns={[
            { key: "code",          header: "Code" },
            { key: "name",          header: "Name" },
            { key: "country_code",  header: "Country" },
            { key: "contact_name",  header: "Contact" },
            { key: "contact_email", header: "Email" },
            { key: "website",       header: "Website" },
            { key: "notes",         header: "Notes" },
            { key: "sort_order",    header: "Sort", format: "number" },
            { key: "is_active",     header: "Active" },
            { key: "created_at",    header: "Created", format: "datetime" },
            { key: "updated_at",    header: "Updated", format: "datetime" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
        <TablePrefsButton
          tableKey={FABRIC_MILLS_TABLE_KEY}
          columns={FABRIC_MILL_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
          onSetAll={setAllVisible}
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
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            No fabric mills found. Add one with &quot;+ Add mill&quot; — or check &quot;Show inactive&quot;
            if you may have deactivated all of them.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th} hidden={!isVisible("code")}>Code</th>
                <th style={th} hidden={!isVisible("name")}>Name</th>
                <th style={th} hidden={!isVisible("country")}>Country</th>
                <th style={th} hidden={!isVisible("contact")}>Contact</th>
                <th style={th} hidden={!isVisible("email")}>Email</th>
                <th style={th} hidden={!isVisible("website")}>Website</th>
                <th style={th} hidden={!isVisible("active")}>Active</th>
                <th style={{ ...th, width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <ScrollHighlightRow
                  key={s.id}
                  rowId={s.id}
                  highlightedRowId={highlightedId}
                  {...getRowProps(s)}
                  style={!s.is_active ? { opacity: 0.5 } : undefined}
                >
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }} hidden={!isVisible("code")}>{s.code}</td>
                  <td style={td} hidden={!isVisible("name")}>{s.name}</td>
                  <td style={{ ...td, color: C.textSub }} hidden={!isVisible("country")}>{s.country_code ?? "—"}</td>
                  <td style={{ ...td, color: C.textSub }} hidden={!isVisible("contact")}>{s.contact_name ?? "—"}</td>
                  <td style={{ ...td, color: C.textSub }} hidden={!isVisible("email")}>{s.contact_email ?? "—"}</td>
                  <td style={{ ...td, color: C.textSub }} hidden={!isVisible("website")}>
                    {s.website
                      ? <a href={s.website} target="_blank" rel="noopener noreferrer" style={{ color: C.primary }}>{s.website}</a>
                      : "—"}
                  </td>
                  <td style={td} hidden={!isVisible("active")}>{s.is_active ? "yes" : "no"}</td>
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

      {addOpen && (
        <FabricMillFormModal
          mode="add"
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); void load(); }}
        />
      )}
      {editing && (
        <FabricMillFormModal
          mode="edit"
          mill={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  mill?: FabricMill;
  onClose: () => void;
  onSaved: () => void;
}

function FabricMillFormModal({ mode, mill, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    name:          mill?.name          ?? "",
    country_code:  mill?.country_code  ?? "",
    contact_name:  mill?.contact_name  ?? "",
    contact_email: mill?.contact_email ?? "",
    contacts:      (Array.isArray(mill?.contacts) ? mill!.contacts : []) as Contact[],
    website:       mill?.website       ?? "",
    notes:         mill?.notes         ?? "",
    sort_order:    mill?.sort_order != null ? String(mill.sort_order) : "0",
    is_active:     mill?.is_active     ?? true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Country dropdown sourced from the country master (stores the iso2 code).
  const [countries, setCountries] = useState<Country[]>(countriesCache ?? []);
  useEffect(() => {
    let cancel = false;
    void loadCountries().then((d) => { if (!cancel) setCountries(d); });
    return () => { cancel = true; };
  }, []);

  // Resolve the stored value (iso2 OR a legacy free-text value) to an iso2.
  const rawCountry = form.country_code;
  const matchedCountry = useMemo(
    () => countries.find((c) => c.iso2 === rawCountry.toUpperCase() || c.name.toLowerCase() === rawCountry.toLowerCase()),
    [countries, rawCountry],
  );
  const countryValue = matchedCountry?.iso2 || rawCountry;
  const countryOptions = useMemo(() => {
    const opts = countries.map((c) => ({ value: c.iso2, label: c.name, searchHaystack: `${c.name} ${c.iso2}` }));
    // Tolerate an existing free-text value that isn't an iso2 — show it anyway.
    if (rawCountry && !matchedCountry && !opts.some((o) => o.value === rawCountry)) {
      opts.unshift({ value: rawCountry, label: rawCountry, searchHaystack: rawCountry });
    }
    return opts;
  }, [countries, rawCountry, matchedCountry]);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      let url: string;
      let method: string;
      if (mode === "add") {
        url = "/api/internal/fabric-mills";
        method = "POST";
      } else {
        url = `/api/internal/fabric-mills/${mill!.id}`;
        method = "PATCH";
      }
      // code is server-generated (add) / locked (edit) — don't send.
      const body = {
        name:          form.name.trim(),
        country_code:  form.country_code.trim()  || null,
        contact_name:  form.contact_name.trim()  || null,
        contact_email: form.contact_email.trim() || null,
        contacts:      form.contacts,
        website:       form.website.trim()       || null,
        notes:         form.notes.trim()         || null,
        sort_order:    form.sort_order.trim() === "" ? 0 : parseInt(form.sort_order, 10),
        is_active:     form.is_active,
      };
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
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {mode === "add" ? "Add fabric mill" : `Edit ${mill!.code}`}
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Code">
            {/* Codes are server-generated + read-only (operator item 14). */}
            <div style={readonlyCodeStyle}>
              {mode === "add"
                ? <span style={{ color: C.textMuted, fontStyle: "italic", fontFamily: "inherit" }}>(auto-generated on save)</span>
                : (mill?.code || "—")}
            </div>
          </Field>
          <Field label="Name *">
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              style={inputStyle}
              placeholder="e.g. Hengfeng Textile"
              autoFocus
            />
          </Field>
          <Field label="Country">
            <SearchableSelect
              value={countryValue || null}
              onChange={(val) => setForm({ ...form, country_code: val })}
              options={countryOptions}
              placeholder="Select country…"
              inputStyle={inputStyle}
            />
          </Field>
          <Field label="Contact name">
            <input
              type="text"
              value={form.contact_name}
              onChange={(e) => setForm({ ...form, contact_name: e.target.value })}
              style={inputStyle}
              placeholder="e.g. Li Wei"
            />
          </Field>
          <Field label="Contact email">
            <input
              type="email"
              value={form.contact_email}
              onChange={(e) => setForm({ ...form, contact_email: e.target.value })}
              style={inputStyle}
              placeholder="e.g. info@mill.com"
            />
          </Field>
          <Field label="Website">
            <input
              type="url"
              value={form.website}
              onChange={(e) => setForm({ ...form, website: e.target.value })}
              style={inputStyle}
              placeholder="e.g. https://mill.com"
            />
          </Field>
          <Field label="Sort order">
            <input
              type="number"
              min="0"
              step="1"
              value={form.sort_order}
              onChange={(e) => setForm({ ...form, sort_order: e.target.value })}
              style={inputStyle}
              placeholder="0"
            />
          </Field>
          <Field label="Active">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
              />
              is_active
            </label>
          </Field>
          <div style={{ gridColumn: "1 / -1" }}>
            <ContactList
              label="Additional contacts"
              value={form.contacts}
              onChange={(next) => setForm({ ...form, contacts: next })}
              max={5}
              fields={["name", "email", "phone", "title"]}
            />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <Field label="Notes">
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                style={{ ...inputStyle, minHeight: 72, resize: "vertical" }}
                placeholder="Any additional notes about this mill…"
              />
            </Field>
          </div>
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
