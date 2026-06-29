// src/tanda/InternalStyleClassifications.tsx
//
// Chunk I — Group / Category / Sub-category Master admin panel.
// ONE panel, 3-tab UI (Group | Category | Sub-category). Each tab
// lists/edits the style_classifications rows of that `kind`.
// Wraps /api/internal/style-classifications?kind=… and /:id.
//
// Entity-scoped (ROF). Seeded from existing style_master group/category/
// sub_category values; operators curate the controlled vocabulary here.

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

const STYLE_CLASS_TABLE_KEY = "tangerine:styleclassifications:columns";
const STYLE_CLASS_COLUMNS: ColumnDef[] = [
  { key: "name",       label: "Name" },
  { key: "sort_order", label: "Sort" },
  { key: "is_active",  label: "Active" },
];

type Kind = "group" | "category" | "sub_category";

type Classification = {
  id: string;
  entity_id: string;
  kind: Kind;
  name: string;
  sort_order: number;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
};

const KIND_TABS: { kind: Kind; label: string }[] = [
  { kind: "group",        label: "Group" },
  { kind: "category",     label: "Category" },
  { kind: "sub_category", label: "Sub-category" },
];

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

function tabStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? C.primary : "transparent",
    color: active ? "white" : C.textSub,
    border: `1px solid ${active ? C.primary : C.cardBdr}`,
    padding: "8px 16px", borderRadius: 6, cursor: "pointer",
    fontSize: 13, fontWeight: 600,
  };
}

export default function InternalStyleClassifications() {
  const [kind, setKind] = useState<Kind>("group");
  const [rows, setRows] = useState<Classification[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const { value: q, debouncedValue: qDebounced, setValue: setQ } = useDebouncedSearch("", 200);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Classification | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(
    STYLE_CLASS_TABLE_KEY,
    STYLE_CLASS_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:styleclassifications:sort",
  });

  const { getRowProps } = useRowClickEdit<Classification>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit ${r.kind} ${r.name}`,
  });

  const kindLabel = KIND_TABS.find((t) => t.kind === kind)!.label;

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      params.set("kind", kind);
      if (qDebounced.trim()) params.set("q", qDebounced.trim());
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/style-classifications?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as Classification[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // Reload on kind / include-inactive change. Search is on Enter / button.
  useEffect(() => { void load(); }, [qDebounced, kind, includeInactive]);

  async function del(row: Classification) {
    if (!(await confirmDialog(`Delete ${row.kind} "${row.name}"?`))) return;
    try {
      const r = await fetch(`/api/internal/style-classifications/${row.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Group / Category / Sub-category</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add {kindLabel.toLowerCase()}</button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {KIND_TABS.map((t) => (
          <button key={t.kind} onClick={() => { setKind(t.kind); setQ(""); }} style={tabStyle(kind === t.kind)}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          placeholder={`Search ${kindLabel.toLowerCase()} name…`}
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
          filename={`style-${kind}`}
          sheetName={kindLabel}
          columns={[
            { key: "kind",       header: "Kind" },
            { key: "name",       header: "Name" },
            { key: "sort_order", header: "Sort", format: "number" },
            { key: "is_active",  header: "Active" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
        <TablePrefsButton
          tableKey={STYLE_CLASS_TABLE_KEY}
          columns={STYLE_CLASS_COLUMNS}
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
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No {kindLabel.toLowerCase()} values found.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <SortableTh label="Name" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("name")} />
                <SortableTh label="Sort" sortKey="sort_order" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!isVisible("sort_order")} />
                <SortableTh label="Active" sortKey="is_active" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("is_active")} />
                <th style={{ ...th, width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <ScrollHighlightRow
                  key={row.id}
                  rowId={row.id}
                  highlightedRowId={highlightedId}
                  {...getRowProps(row)}
                  style={!row.is_active ? { opacity: 0.5 } : undefined}
                >
                  <td style={td} hidden={!isVisible("name")}>{row.name}</td>
                  <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!isVisible("sort_order")}>{row.sort_order}</td>
                  <td style={td} hidden={!isVisible("is_active")}>{row.is_active ? "yes" : "no"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={(e) => { e.stopPropagation(); setEditing(row); }} style={btnSecondary}>Edit</button>
                    <button onClick={(e) => { e.stopPropagation(); void del(row); }} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                  </td>
                </ScrollHighlightRow>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && <ClassificationFormModal mode="add" kind={kind} kindLabel={kindLabel} onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load(); }} />}
      {editing && <ClassificationFormModal mode="edit" kind={editing.kind} kindLabel={KIND_TABS.find((t) => t.kind === editing.kind)!.label} row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  kind: Kind;
  kindLabel: string;
  row?: Classification;
  onClose: () => void;
  onSaved: () => void;
}

function ClassificationFormModal({ mode, kind, kindLabel, row, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    name:       row?.name       ?? "",
    sort_order: row?.sort_order != null ? String(row.sort_order) : "0",
    is_active:  row?.is_active  ?? true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const isAdd = mode === "add";
      const url = isAdd ? "/api/internal/style-classifications" : `/api/internal/style-classifications/${row!.id}`;
      const method = isAdd ? "POST" : "PATCH";
      const body: Record<string, unknown> = {
        name:       form.name.trim(),
        sort_order: form.sort_order.trim() === "" ? 0 : parseInt(form.sort_order, 10),
        is_active:  form.is_active,
      };
      if (isAdd) body.kind = kind;
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
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {mode === "add" ? `Add ${kindLabel.toLowerCase()}` : `Edit ${kindLabel.toLowerCase()} "${row!.name}"`}
        </h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Name *">
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} placeholder={kindLabel} autoFocus />
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
