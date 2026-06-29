// src/tanda/InternalBuyerScopeMaster.tsx
//
// Tangerine — Buyer Scope Master admin panel (#1156).
// "Scopes" are what a customer buyer purchases (Men's Tops, Denim, …) and are
// multi-selected on a buyer in the Customer Master → Buyers tab.
// List + search + active toggle + create + edit + hard-delete. Code is OPTIONAL
// and (unlike Carrier Master) editable after creation.
// Wraps /api/internal/buyer-scope-master and /:id.

import { useEffect, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";

const SCOPE_TABLE_KEY = "tangerine:buyerscopemaster:columns";
const SCOPE_COLUMNS: ColumnDef[] = [
  { key: "name",       label: "Name" },
  { key: "code",       label: "Code" },
  { key: "sort_order", label: "Sort" },
  { key: "is_active",  label: "Active" },
];

type Scope = {
  id: string;
  name: string;
  code: string | null;
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

export default function InternalBuyerScopeMaster() {
  const [rows, setRows] = useState<Scope[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Scope | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(
    SCOPE_TABLE_KEY,
    SCOPE_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  const { getRowProps } = useRowClickEdit<Scope>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit scope ${r.name}`,
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/buyer-scope-master?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as Scope[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [includeInactive]);

  async function del(s: Scope) {
    if (!(await confirmDialog(`Delete scope "${s.name}"?\nIf any buyer is assigned this scope the delete is blocked — deactivate it (Active = no) instead to retire it from the picker while keeping existing assignments.`))) return;
    try {
      const r = await fetch(`/api/internal/buyer-scope-master/${s.id}`, { method: "DELETE" });
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Buyer Scope Master</h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: C.textMuted }}>
            What a customer buyer purchases. Multi-selected on a buyer in Customer Master → Buyers.
          </p>
        </div>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add scope</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
        <input
          type="text"
          placeholder="Search name or code…"
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
          filename="buyer-scopes"
          sheetName="Buyer Scopes"
          columns={[
            { key: "name",       header: "Name" },
            { key: "code",       header: "Code" },
            { key: "sort_order", header: "Sort", format: "number" },
            { key: "is_active",  header: "Active" },
            { key: "created_at", header: "Created", format: "datetime" },
            { key: "updated_at", header: "Updated", format: "datetime" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
        <TablePrefsButton
          tableKey={SCOPE_TABLE_KEY}
          columns={SCOPE_COLUMNS}
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
            No scopes found. Add one with &quot;+ Add scope&quot; — or check &quot;Show inactive&quot;.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th} hidden={!isVisible("name")}>Name</th>
                <th style={th} hidden={!isVisible("code")}>Code</th>
                <th style={th} hidden={!isVisible("sort_order")}>Sort</th>
                <th style={th} hidden={!isVisible("is_active")}>Active</th>
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
                  <td style={td} hidden={!isVisible("name")}>{s.name}</td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", color: C.textSub }} hidden={!isVisible("code")}>{s.code || "—"}</td>
                  <td style={{ ...td, color: C.textSub }} hidden={!isVisible("sort_order")}>{s.sort_order}</td>
                  <td style={td} hidden={!isVisible("is_active")}>{s.is_active ? "yes" : "no"}</td>
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
        <ScopeFormModal
          mode="add"
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); void load(); }}
        />
      )}
      {editing && (
        <ScopeFormModal
          mode="edit"
          scope={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  scope?: Scope;
  onClose: () => void;
  onSaved: () => void;
}

function ScopeFormModal({ mode, scope, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    name:       scope?.name ?? "",
    code:       scope?.code ?? "",
    sort_order: scope?.sort_order != null ? String(scope.sort_order) : "0",
    is_active:  scope?.is_active ?? true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!form.name.trim()) { setErr("Name is required"); return; }
    setSubmitting(true);
    setErr(null);
    try {
      const url = mode === "add" ? "/api/internal/buyer-scope-master" : `/api/internal/buyer-scope-master/${scope!.id}`;
      const method = mode === "add" ? "POST" : "PATCH";
      // code is auto-generated server-side (SCOPE-NNNNN) — never sent.
      const body = {
        name:       form.name.trim(),
        sort_order: form.sort_order.trim() === "" ? 0 : parseInt(form.sort_order, 10),
        is_active:  form.is_active,
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
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(480px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {mode === "add" ? "Add scope" : `Edit ${scope!.name}`}
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Name *" style={{ gridColumn: "1 / -1" }}>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              style={inputStyle}
              placeholder="e.g. Men's Tops"
              autoFocus
            />
          </Field>

          <Field label="Code (auto-generated)">
            <input
              type="text"
              value={mode === "add" ? "(assigned on save)" : (scope?.code ?? "—")}
              readOnly
              disabled
              style={{ ...inputStyle, opacity: 0.6, fontFamily: "SFMono-Regular, Menlo, monospace" }}
              title="Code is auto-generated (SCOPE-NNNNN) and cannot be edited"
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

function Field({ label, children, style }: { label: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={style}>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      {children}
    </div>
  );
}
