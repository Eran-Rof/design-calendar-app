// src/tanda/InternalWarehouseMaster.tsx
//
// Tangerine — Warehouse Master admin panel.
// List + search + active toggle + create + edit + hard-delete (rejected with
// reference detail if any inventory layer/transfer still references it).
// Wraps /api/internal/warehouses and /api/internal/warehouses/:id.
//
// Builds OVER the existing inventory_locations table (P12-0). This panel curates
// the operator-owned warehouse rows (kind='warehouse'); marketplace/3pl kinds
// are managed by their channel integrations and are NOT shown here.

import { useEffect, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import SearchableSelect from "./components/SearchableSelect";

type Country = { id: string; iso2: string; name: string };

const WAREHOUSES_TABLE_KEY = "tangerine:warehouses:columns";
const WAREHOUSE_COLUMNS: ColumnDef[] = [
  { key: "code",         label: "Code" },
  { key: "name",         label: "Name" },
  { key: "address",      label: "Address" },
  { key: "country_code", label: "Country" },
  { key: "sort_order",   label: "Sort" },
  { key: "is_active",    label: "Active" },
];

type Warehouse = {
  id: string;
  entity_id: string;
  code: string;
  name: string;
  kind: string;
  address: string | null;
  country_code: string | null;
  sort_order: number;
  is_active: boolean;
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
// Greyed, read-only display for server-generated codes (operator item 14).
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
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};

export default function InternalWarehouseMaster() {
  const [rows, setRows] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(
    WAREHOUSES_TABLE_KEY,
    WAREHOUSE_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  const { getRowProps } = useRowClickEdit<Warehouse>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit warehouse ${r.code}`,
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/warehouses?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as Warehouse[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [includeInactive]);

  async function del(w: Warehouse) {
    if (!(await confirmDialog(`Delete warehouse ${w.code} (${w.name})?\nWill fail if any inventory layer or transfer still references it — toggle is_active=false in that case.`))) return;
    try {
      const r = await fetch(`/api/internal/warehouses/${w.id}`, { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        if (r.status === 409 && j.references) {
          notify(`Cannot delete — still referenced by ${j.references.inventory_layers} layer(s) and ${j.references.inventory_transfers} transfer(s).\n\nMove that stock first, or toggle is_active=false instead.`, "error");
          return;
        }
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
        <h2 style={{ margin: 0, fontSize: 22 }}>Warehouses</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add warehouse</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          placeholder="Search code, name or address…"
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
          filename="warehouses"
          sheetName="Warehouses"
          columns={[
            { key: "code",         header: "Code" },
            { key: "name",         header: "Name" },
            { key: "address",      header: "Address" },
            { key: "country_code", header: "Country" },
            { key: "sort_order",   header: "Sort", format: "number" },
            { key: "is_active",    header: "Active" },
            { key: "created_at",   header: "Created", format: "datetime" },
            { key: "updated_at",   header: "Updated", format: "datetime" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
        <TablePrefsButton
          tableKey={WAREHOUSES_TABLE_KEY}
          columns={WAREHOUSE_COLUMNS}
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

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            No warehouses found. Add one with &quot;+ Add warehouse&quot; — or check &quot;Show inactive&quot;
            if you may have deactivated all of them.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th} hidden={!isVisible("code")}>Code</th>
                <th style={th} hidden={!isVisible("name")}>Name</th>
                <th style={th} hidden={!isVisible("address")}>Address</th>
                <th style={th} hidden={!isVisible("country_code")}>Country</th>
                <th style={th} hidden={!isVisible("sort_order")}>Sort</th>
                <th style={th} hidden={!isVisible("is_active")}>Active</th>
                <th style={{ ...th, width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <ScrollHighlightRow
                  key={w.id}
                  rowId={w.id}
                  highlightedRowId={highlightedId}
                  {...getRowProps(w)}
                  style={!w.is_active ? { opacity: 0.5 } : undefined}
                >
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }} hidden={!isVisible("code")}>{w.code}</td>
                  <td style={td} hidden={!isVisible("name")}>{w.name}</td>
                  <td style={{ ...td, color: C.textSub }} hidden={!isVisible("address")}>{w.address || "—"}</td>
                  <td style={{ ...td, color: C.textSub }} hidden={!isVisible("country_code")}>{w.country_code || "—"}</td>
                  <td style={{ ...td, color: C.textSub }} hidden={!isVisible("sort_order")}>{w.sort_order}</td>
                  <td style={td} hidden={!isVisible("is_active")}>{w.is_active ? "yes" : "no"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={(e) => { e.stopPropagation(); setEditing(w); }} style={btnSecondary}>Edit</button>
                    <button onClick={(e) => { e.stopPropagation(); void del(w); }} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                  </td>
                </ScrollHighlightRow>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && (
        <WarehouseFormModal
          mode="add"
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); void load(); }}
        />
      )}
      {editing && <WarehouseFormModal mode="edit" warehouse={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  warehouse?: Warehouse;
  onClose: () => void;
  onSaved: () => void;
}

function WarehouseFormModal({ mode, warehouse, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    name:         warehouse?.name ?? "",
    address:      warehouse?.address ?? "",
    country_code: warehouse?.country_code ?? "",
    sort_order:   warehouse?.sort_order != null ? String(warehouse.sort_order) : "0",
    is_active:    warehouse?.is_active ?? true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [countries, setCountries] = useState<Country[]>([]);

  // Country picker is sourced from the Country Master (country_master / iso2).
  useEffect(() => {
    fetch("/api/internal/countries")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => { if (Array.isArray(d)) setCountries(d); })
      .catch(() => {/* non-fatal — picker just stays empty */});
  }, []);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      let url: string;
      let method: string;
      if (mode === "add") {
        url = "/api/internal/warehouses";
        method = "POST";
      } else {
        url = `/api/internal/warehouses/${warehouse!.id}`;
        method = "PATCH";
      }
      // code + kind are server-generated (add) / locked (edit) — don't send.
      const body = {
        name:         form.name.trim(),
        address:      form.address.trim() || null,
        country_code: form.country_code.trim() || null,
        sort_order:   form.sort_order.trim() === "" ? 0 : parseInt(form.sort_order, 10),
        is_active:    form.is_active,
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
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, minWidth: 480, maxWidth: 560, color: C.text }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {mode === "add" ? "Add warehouse" : `Edit ${warehouse!.code}`}
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Code">
            {/* Codes are server-generated + read-only (operator item 14). */}
            <div style={readonlyCodeStyle}>
              {mode === "add"
                ? <span style={{ color: C.textMuted, fontStyle: "italic", fontFamily: "inherit" }}>(auto-generated on save)</span>
                : (warehouse?.code || "—")}
            </div>
          </Field>
          <Field label="Name *">
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              style={inputStyle}
              placeholder="e.g. Main Warehouse"
              autoFocus
            />
          </Field>
          <Field label="Address">
            <input
              type="text"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              style={inputStyle}
              placeholder="e.g. 1 Industrial Way, City, ST"
            />
          </Field>
          <Field label="Country">
            <SearchableSelect
              value={form.country_code || null}
              onChange={(v) => setForm({ ...form, country_code: v || "" })}
              options={countries.map((c) => ({
                value: c.iso2,
                label: `${c.iso2} — ${c.name}`,
                searchHaystack: `${c.iso2} ${c.name}`,
              }))}
              placeholder="Search country…"
              emptyText="No countries — add them in Country Master"
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
