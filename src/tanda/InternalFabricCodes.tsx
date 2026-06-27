// src/tanda/InternalFabricCodes.tsx
//
// Tangerine P3 Chunk 11 — internal admin panel for fabric_codes CRUD.
// List + search + country/active filter + add/edit modal + hard-delete with
// 409-on-reference guard. Wraps /api/internal/fabric-codes and /:id.

import { useEffect, useMemo, useState } from "react";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SearchableSelect, { type SearchableSelectOption } from "./components/SearchableSelect";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";

const FABRIC_CODES_TABLE_KEY = "tangerine:fabriccodes:columns";
const FABRIC_CODE_COLUMNS: ColumnDef[] = [
  { key: "code",              label: "Code" },
  { key: "name",              label: "Name" },
  { key: "composition_text",  label: "Composition" },
  { key: "fabric_weight_gsm", label: "GSM" },
  { key: "country_of_origin", label: "COO" },
  { key: "is_active",         label: "Active" },
];

type FabricCode = {
  id: string;
  code: string;
  name: string;
  composition_text: string;
  composition_json: unknown;
  fabric_weight_gsm: number | null;
  country_of_origin_iso2: string | null;
  care_instructions: string | null;
  default_vendor_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type Vendor = { id: string; name: string };
// Chunk J item 7 — country_master rows for the COO picker.
type Country = { id: string; iso2: string; name: string };

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
  padding: "6px 10px", borderRadius: 4, fontSize: 13,
  // Narrower than the full column (code is short) + flex-centered with no
  // minHeight so its height matches the adjacent Name input.
  width: "calc(100% - 6ch)", boxSizing: "border-box",
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

export default function InternalFabricCodes() {
  const [rows, setRows] = useState<FabricCode[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [countries, setCountries] = useState<Country[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const { value: q, debouncedValue: qDebounced, setValue: setQ } = useDebouncedSearch("", 200);
  const { value: country, debouncedValue: countryDebounced, setValue: setCountry } = useDebouncedSearch("", 200);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<FabricCode | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    FABRIC_CODES_TABLE_KEY,
    FABRIC_CODE_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:fabriccodes:sort",
    // The COO column key differs from its underlying scalar field name.
    accessors: { country_of_origin: (r) => r.country_of_origin_iso2 },
  });

  const { getRowProps } = useRowClickEdit<FabricCode>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit fabric ${r.code}`,
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (qDebounced.trim()) params.set("q", qDebounced.trim());
      if (countryDebounced.trim()) params.set("country", countryDebounced.trim().toUpperCase());
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/fabric-codes?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as FabricCode[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function loadVendors() {
    try {
      const r = await fetch(`/api/internal/vendor-master?limit=5000`);
      if (!r.ok) return;
      const data = await r.json();
      if (Array.isArray(data)) setVendors(data as Vendor[]);
    } catch { /* non-fatal */ }
  }

  async function loadCountries() {
    try {
      const r = await fetch(`/api/internal/countries`);
      if (!r.ok) return;
      const data = await r.json();
      if (Array.isArray(data)) setCountries(data as Country[]);
    } catch { /* non-fatal */ }
  }

  useEffect(() => { void load(); }, [qDebounced, countryDebounced, includeInactive]);
  useEffect(() => { void loadVendors(); }, []);
  useEffect(() => { void loadCountries(); }, []);

  async function hardDelete(id: string, code: string) {
    if (!(await confirmDialog(`Permanently delete fabric ${code}? This fails if any style uses it (deactivate instead).`))) return;
    try {
      const r = await fetch(`/api/internal/fabric-codes/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Fabric Codes</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add fabric</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="Search code / name / composition…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ ...inputStyle, maxWidth: 320 }}
        />
        <input
          type="text"
          placeholder="Country (ISO-2)"
          value={country}
          onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))}
          style={{ ...inputStyle, maxWidth: 130 }}
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
          filename="fabric-codes"
          sheetName="Fabric Codes"
          columns={[
            { key: "code",                   header: "Code" },
            { key: "name",                   header: "Name" },
            { key: "composition_text",       header: "Composition" },
            { key: "fabric_weight_gsm",      header: "GSM", format: "number" },
            { key: "country_of_origin_iso2", header: "COO" },
            { key: "care_instructions",      header: "Care Instructions" },
            { key: "default_vendor_id",      header: "Default Vendor ID" },
            { key: "is_active",              header: "Active" },
            { key: "created_at",             header: "Created", format: "datetime" },
            { key: "updated_at",             header: "Updated", format: "datetime" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
        <TablePrefsButton
          tableKey={FABRIC_CODES_TABLE_KEY}
          columns={FABRIC_CODE_COLUMNS}
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
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No fabric codes found.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <SortableTh label="Code" sortKey="code" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("code")} />
                <SortableTh label="Name" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("name")} />
                <SortableTh label="Composition" sortKey="composition_text" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("composition_text")} />
                <SortableTh label="GSM" sortKey="fabric_weight_gsm" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("fabric_weight_gsm")} />
                <SortableTh label="COO" sortKey="country_of_origin" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("country_of_origin")} />
                <SortableTh label="Active" sortKey="is_active" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("is_active")} />
                <th style={{ ...th, width: 140 }}></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <ScrollHighlightRow
                  key={r.id}
                  rowId={r.id}
                  highlightedRowId={highlightedId}
                  {...getRowProps(r)}
                  style={!r.is_active ? { opacity: 0.5 } : undefined}
                >
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }} hidden={!isVisible("code")}>
                    {r.code}
                  </td>
                  <td style={td} hidden={!isVisible("name")}>{r.name}</td>
                  <td style={td} hidden={!isVisible("composition_text")}>{r.composition_text}</td>
                  <td style={td} hidden={!isVisible("fabric_weight_gsm")}>{r.fabric_weight_gsm ?? "—"}</td>
                  <td style={td} hidden={!isVisible("country_of_origin")}>{r.country_of_origin_iso2 ?? "—"}</td>
                  <td style={td} hidden={!isVisible("is_active")}>{r.is_active ? "yes" : "no"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={(e) => { e.stopPropagation(); setEditing(r); }} style={btnSecondary}>Edit</button>
                    <button onClick={(e) => { e.stopPropagation(); void hardDelete(r.id, r.code); }} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                  </td>
                </ScrollHighlightRow>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && (
        <FabricFormModal
          mode="add"
          vendors={vendors}
          countries={countries}
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); void load(); }}
        />
      )}
      {editing && (
        <FabricFormModal
          mode="edit"
          fabric={editing}
          vendors={vendors}
          countries={countries}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  fabric?: FabricCode;
  vendors: Vendor[];
  countries: Country[];
  onClose: () => void;
  onSaved: () => void;
}

function FabricFormModal({ mode, fabric, vendors, countries, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    code:                   fabric?.code                   ?? "",
    name:                   fabric?.name                   ?? "",
    composition_text:       fabric?.composition_text       ?? "",
    fabric_weight_gsm:      fabric?.fabric_weight_gsm != null ? String(fabric.fabric_weight_gsm) : "",
    country_of_origin_iso2: fabric?.country_of_origin_iso2 ?? "",
    care_instructions:      fabric?.care_instructions      ?? "",
    default_vendor_id:      fabric?.default_vendor_id      ?? "",
    is_active:              fabric?.is_active              ?? true,
  });

  // Chunk J item 7 — COO picker options ("<iso2> — <name>", value = iso2).
  // The stored value remains the 2-letter ISO code. If the row already holds
  // an ISO that isn't in the active country_master list, surface it so the
  // picker can render the current selection.
  const countryOptions: SearchableSelectOption[] = useMemo(() => {
    const opts: SearchableSelectOption[] = [
      { value: "", label: "(select)" },
      ...countries.map((c) => ({
        value: c.iso2,
        label: `${c.iso2} — ${c.name}`,
        searchHaystack: `${c.iso2} ${c.name}`,
      })),
    ];
    const cur = form.country_of_origin_iso2;
    if (cur && !countries.some((c) => c.iso2 === cur)) {
      opts.push({ value: cur, label: cur });
    }
    return opts;
  }, [countries, form.country_of_origin_iso2]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        name:                   form.name.trim(),
        composition_text:       form.composition_text.trim(),
        // Chunk J item 6 — composition_json is no longer collected in the UI.
        // The DB column + handler support remain; we simply stop sending it.
        fabric_weight_gsm:      form.fabric_weight_gsm ? Number(form.fabric_weight_gsm) : null,
        country_of_origin_iso2: form.country_of_origin_iso2.trim().toUpperCase() || null,
        care_instructions:      form.care_instructions.trim() || null,
        default_vendor_id:      form.default_vendor_id || null,
        is_active:              form.is_active,
      };
      let url: string;
      let method: string;
      if (mode === "add") {
        // Chunk M — code is server-generated; never sent from the client.
        url = "/api/internal/fabric-codes";
        method = "POST";
      } else {
        url = `/api/internal/fabric-codes/${fabric!.id}`;
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
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(680px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {mode === "add" ? "Add fabric code" : `Edit ${fabric!.code}`}
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Code">
            {/* Chunk M — codes are server-generated + read-only (operator item 14). */}
            <div style={readonlyCodeStyle}>
              {mode === "add"
                ? <span style={{ color: C.textMuted, fontStyle: "italic", fontFamily: "inherit" }}>(auto-generated on save)</span>
                : (fabric?.code || "—")}
            </div>
          </Field>
          <Field label="Name">
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              style={inputStyle}
              placeholder="Human label"
            />
          </Field>
          <Field label="Composition (text)" wide>
            <input
              type="text"
              value={form.composition_text}
              onChange={(e) => setForm({ ...form, composition_text: e.target.value })}
              style={inputStyle}
              placeholder='e.g. 60% Polyester / 40% Cotton'
            />
          </Field>
          <Field label="Weight (GSM)">
            <input
              type="number"
              step="0.01"
              value={form.fabric_weight_gsm}
              onChange={(e) => setForm({ ...form, fabric_weight_gsm: e.target.value })}
              style={inputStyle}
              placeholder="180"
            />
          </Field>
          <Field label="Country of origin">
            <SearchableSelect
              value={form.country_of_origin_iso2 || null}
              onChange={(v) => setForm({ ...form, country_of_origin_iso2: v })}
              options={countryOptions}
              placeholder="Pick a country (search ISO / name)…"
            />
          </Field>
          <Field label="Default vendor">
            <SearchableSelect
              value={form.default_vendor_id || null}
              onChange={(v) => setForm({ ...form, default_vendor_id: v })}
              options={[
                { value: "", label: "(select)" },
                ...vendors.map((v) => ({ value: v.id, label: v.name })),
              ]}
              inputStyle={inputStyle}
            />
          </Field>
          <Field label="Care instructions" wide>
            <textarea
              value={form.care_instructions}
              onChange={(e) => setForm({ ...form, care_instructions: e.target.value })}
              style={{ ...inputStyle, minHeight: 60 }}
              placeholder="Machine wash cold, tumble dry low…"
            />
          </Field>
          <Field label="Active?">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
              Yes (selectable in style master)
            </label>
          </Field>
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>
            {err}
          </div>
        )}

        {/* Sticky action footer — pinned to the bottom of the scrolling modal so
            Save / Cancel stay reachable on tall records. */}
        <div style={{ position: "sticky", bottom: -20, zIndex: 3, background: C.card, borderTop: `1px solid ${C.cardBdr}`, margin: "16px -20px -20px", padding: "12px 20px", display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting}>
            {submitting ? "Saving…" : mode === "add" ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div style={wide ? { gridColumn: "1 / -1" } : {}}>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      {children}
    </div>
  );
}
