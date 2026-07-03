// src/tanda/InternalEmployeeTitles.tsx
//
// P16 — Employee Title master admin panel.
// List + search + create + edit + hard-delete. Wraps
// /api/internal/employee-titles and /api/internal/employee-titles/:id.
//
// Titles flagged is_sales_role=true (e.g. "Sales Representative") unlock the
// commission-rate inputs on the Employee record (InternalEmployees.tsx).
// employees.title_id is ON DELETE SET NULL, so deleting a title just clears it
// off any employee that held it.

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

const EMPLOYEE_TITLES_TABLE_KEY = "tangerine:employeetitles:columns";
const EMPLOYEE_TITLE_COLUMNS: ColumnDef[] = [
  { key: "name",          label: "Title" },
  { key: "is_sales_role", label: "Sales role" },
  { key: "sort_order",    label: "Sort" },
];

type EmployeeTitle = {
  id: string;
  entity_id: string;
  name: string;
  is_sales_role: boolean;
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

export default function InternalEmployeeTitles() {
  const [rows, setRows] = useState<EmployeeTitle[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const { value: q, debouncedValue: qDebounced, setValue: setQ } = useDebouncedSearch("", 200);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<EmployeeTitle | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    EMPLOYEE_TITLES_TABLE_KEY,
    EMPLOYEE_TITLE_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:employeetitles:sort",
  });

  const { getRowProps } = useRowClickEdit<EmployeeTitle>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit title ${r.name}`,
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (qDebounced.trim()) params.set("q", qDebounced.trim());
      const r = await fetch(`/api/internal/employee-titles?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as EmployeeTitle[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [qDebounced]);

  async function del(t: EmployeeTitle) {
    if (!(await confirmDialog(`Delete title "${t.name}"?\nAny employee currently assigned this title will have it cleared.`))) return;
    try {
      const r = await fetch(`/api/internal/employee-titles/${t.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Employee Titles</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add title</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          placeholder="Search title name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ ...inputStyle, maxWidth: 280 }}
        />
        <button onClick={() => void load()} style={btnSecondary}>Search</button>
        <ExportButton
          rows={rows as unknown as Array<Record<string, unknown>>}
          filename="employee-titles"
          sheetName="Employee Titles"
          columns={[
            { key: "name",          header: "Title" },
            { key: "is_sales_role", header: "Sales Role" },
            { key: "sort_order",    header: "Sort Order", format: "number" },
            { key: "created_at",    header: "Created", format: "datetime" },
            { key: "updated_at",    header: "Updated", format: "datetime" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
        <TablePrefsButton
          tableKey={EMPLOYEE_TITLES_TABLE_KEY}
          columns={EMPLOYEE_TITLE_COLUMNS}
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
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            No titles yet. Click <strong>+ Add title</strong> to create one.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <SortableTh label="Title" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("name")} />
                <SortableTh label="Sales role" sortKey="is_sales_role" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("is_sales_role")} />
                <SortableTh label="Sort" sortKey="sort_order" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!isVisible("sort_order")} />
                <th style={{ ...th, width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((t) => (
                <ScrollHighlightRow
                  key={t.id}
                  rowId={t.id}
                  highlightedRowId={highlightedId}
                  {...getRowProps(t)}
                >
                  <td style={td} hidden={!isVisible("name")}>{t.name}</td>
                  <td style={td} hidden={!isVisible("is_sales_role")}>{t.is_sales_role ? "yes" : "—"}</td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!isVisible("sort_order")}>{t.sort_order}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={(e) => { e.stopPropagation(); setEditing(t); }} style={btnSecondary}>Edit</button>
                    <button onClick={(e) => { e.stopPropagation(); void del(t); }} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                  </td>
                </ScrollHighlightRow>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && <TitleFormModal mode="add" onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load(); }} />}
      {editing && <TitleFormModal mode="edit" title={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  title?: EmployeeTitle;
  onClose: () => void;
  onSaved: () => void;
}

function TitleFormModal({ mode, title, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    name:          title?.name          ?? "",
    is_sales_role: title?.is_sales_role ?? false,
    sort_order:    title?.sort_order    != null ? String(title.sort_order) : "0",
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const url = mode === "add" ? "/api/internal/employee-titles" : `/api/internal/employee-titles/${title!.id}`;
      const method = mode === "add" ? "POST" : "PATCH";
      const body = {
        name:          form.name.trim(),
        is_sales_role: form.is_sales_role,
        sort_order:    form.sort_order.trim() === "" ? 0 : parseInt(form.sort_order, 10),
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
          {mode === "add" ? "Add title" : `Edit ${title!.name}`}
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Name *">
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              style={inputStyle}
              placeholder="e.g. Sales Representative"
              autoFocus
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
          <Field label="Sales role">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13, paddingTop: 6 }}>
              <input
                type="checkbox"
                checked={form.is_sales_role}
                onChange={(e) => setForm({ ...form, is_sales_role: e.target.checked })}
              />
              is_sales_role
            </label>
          </Field>
        </div>

        <div style={{
          marginTop: 14, padding: "8px 12px",
          background: "#0b1220", border: `1px dashed ${C.cardBdr}`,
          borderRadius: 6, fontSize: 11, color: C.textMuted, lineHeight: 1.5,
        }}>
          Titles flagged as a <strong style={{ color: C.text }}>sales role</strong> unlock the
          Wholesale&nbsp;% and Closeouts&nbsp;% commission-rate fields on the employee record.
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
