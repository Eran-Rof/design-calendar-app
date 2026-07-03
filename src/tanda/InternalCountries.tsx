// src/tanda/InternalCountries.tsx
//
// Chunk I — Country Master admin panel.
// List + search + active toggle + create + edit + hard-delete.
// Wraps /api/internal/countries and /api/internal/countries/:id.
//
// country_master is GLOBAL (entity-agnostic): iso2 (ISO 3166-1 alpha-2),
// name, sort_order, is_active. Used as the country picker source across
// vendor / customer / factor address forms.

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

const COUNTRIES_TABLE_KEY = "tangerine:countries:columns";
const COUNTRY_COLUMNS: ColumnDef[] = [
  { key: "iso2",       label: "ISO2" },
  { key: "name",       label: "Name" },
  { key: "sort_order", label: "Sort" },
  { key: "is_active",  label: "Active" },
];

type Country = {
  id: string;
  iso2: string;
  name: string;
  sort_order: number;
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

export default function InternalCountries() {
  const [rows, setRows] = useState<Country[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const { value: q, debouncedValue: qDebounced, setValue: setQ } = useDebouncedSearch("", 200);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Country | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    COUNTRIES_TABLE_KEY,
    COUNTRY_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:countries:sort",
  });

  const { getRowProps } = useRowClickEdit<Country>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit country ${r.iso2}`,
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (qDebounced.trim()) params.set("q", qDebounced.trim());
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/countries?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as Country[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [qDebounced, includeInactive]);

  async function del(c: Country) {
    if (!(await confirmDialog(`Delete country ${c.iso2} (${c.name})?`))) return;
    try {
      const r = await fetch(`/api/internal/countries/${c.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Country Master</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add country</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          placeholder="Search iso2 or name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ ...inputStyle, maxWidth: 280 }}
        />
        <button onClick={() => void load()} style={btnSecondary}>Search</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show inactive
        </label>
        <ExportButton
          rows={rows as unknown as Array<Record<string, unknown>>}
          filename="countries"
          sheetName="Countries"
          columns={[
            { key: "iso2",       header: "ISO2" },
            { key: "name",       header: "Name" },
            { key: "sort_order", header: "Sort", format: "number" },
            { key: "is_active",  header: "Active" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
        <TablePrefsButton
          tableKey={COUNTRIES_TABLE_KEY}
          columns={COUNTRY_COLUMNS}
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
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No countries found.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <SortableTh label="ISO2" sortKey="iso2" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("iso2")} />
                <SortableTh label="Name" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("name")} />
                <SortableTh label="Sort" sortKey="sort_order" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!isVisible("sort_order")} />
                <SortableTh label="Active" sortKey="is_active" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("is_active")} />
                <th style={{ ...th, width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => (
                <ScrollHighlightRow
                  key={c.id}
                  rowId={c.id}
                  highlightedRowId={highlightedId}
                  {...getRowProps(c)}
                  style={!c.is_active ? { opacity: 0.5 } : undefined}
                >
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }} hidden={!isVisible("iso2")}>{c.iso2}</td>
                  <td style={td} hidden={!isVisible("name")}>{c.name}</td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!isVisible("sort_order")}>{c.sort_order}</td>
                  <td style={td} hidden={!isVisible("is_active")}>{c.is_active ? "yes" : "no"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={(e) => { e.stopPropagation(); setEditing(c); }} style={btnSecondary}>Edit</button>
                    <button onClick={(e) => { e.stopPropagation(); void del(c); }} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                  </td>
                </ScrollHighlightRow>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && <CountryFormModal mode="add" onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load(); }} />}
      {editing && <CountryFormModal mode="edit" country={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  country?: Country;
  onClose: () => void;
  onSaved: () => void;
}

function CountryFormModal({ mode, country, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    iso2:       country?.iso2       ?? "",
    name:       country?.name       ?? "",
    sort_order: country?.sort_order != null ? String(country.sort_order) : "0",
    is_active:  country?.is_active  ?? true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [isoLoading, setIsoLoading] = useState(false);
  const [isoErr, setIsoErr] = useState<string | null>(null);

  // AI ISO-2 suggestion — derive the ISO 3166-1 alpha-2 code from the typed
  // country name via Claude. Sets the ISO2 field (uppercased, 2 letters).
  async function suggestIso2() {
    const name = form.name.trim();
    if (!name) { setIsoErr("Enter a country name first."); return; }
    setIsoLoading(true);
    setIsoErr(null);
    try {
      const r = await fetch("/api/internal/ai/suggest-iso2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const code = String(data.code || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
      if (!code) { setIsoErr(data.note || "No ISO-2 code found for that name."); return; }
      setForm((f) => ({ ...f, iso2: code }));
    } catch (e: unknown) {
      setIsoErr(e instanceof Error ? e.message : String(e));
    } finally {
      setIsoLoading(false);
    }
  }

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const isAdd = mode === "add";
      const url = isAdd ? "/api/internal/countries" : `/api/internal/countries/${country!.id}`;
      const method = isAdd ? "POST" : "PATCH";
      const body: Record<string, unknown> = {
        name:       form.name.trim(),
        sort_order: form.sort_order.trim() === "" ? 0 : parseInt(form.sort_order, 10),
        is_active:  form.is_active,
      };
      if (isAdd) body.iso2 = form.iso2.trim().toUpperCase();
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
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{mode === "add" ? "Add country" : `Edit ${country!.iso2}`}</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="ISO2 *">
            {mode === "add" ? (
              <>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="text" value={form.iso2} onChange={(e) => { setForm({ ...form, iso2: e.target.value.toUpperCase().slice(0, 2) }); setIsoErr(null); }} style={{ ...inputStyle, flex: 1, minWidth: 0 }} placeholder="US" autoFocus maxLength={2} />
                  <button
                    type="button"
                    onClick={() => void suggestIso2()}
                    disabled={isoLoading}
                    style={{ ...btnSecondary, whiteSpace: "nowrap", flexShrink: 0 }}
                    title="Use Claude AI to suggest the ISO 3166-1 alpha-2 code from the country name"
                  >
                    {isoLoading ? "…" : "AI Suggest"}
                  </button>
                </div>
                {isoErr && <div style={{ fontSize: 11, color: C.warn, marginTop: 4 }}>{isoErr}</div>}
              </>
            ) : (
              <input type="text" value={form.iso2} disabled style={{ ...inputStyle, opacity: 0.5 }} />
            )}
          </Field>
          <Field label="Name *">
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} placeholder="United States" />
          </Field>
          <Field label="Sort order">
            <input type="number" min="0" step="1" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: e.target.value })} style={inputStyle} placeholder="0" />
          </Field>
          <Field label="Active">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
              is_active
            </label>
          </Field>
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
