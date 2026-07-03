// src/tanda/InternalPartTypeMaster.tsx
//
// Tangerine — Manufacturing Part Type Master. Operator-managed list of part
// types (blank garment, label, trim, …) that drives the Part Master "type"
// dropdown. The `code` is stored on part_master.part_type.

import { useEffect, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useRowClickEdit } from "./hooks/useRowClickEdit";

type PartType = { id: string; entity_id: string; code: string; name: string; sort_order: number; is_active: boolean; created_at: string; updated_at: string };

const C = { card: "#1E293B", cardBdr: "#334155", text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1", primary: "#3B82F6", danger: "#EF4444" };
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12 };
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d" };
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box" };
const readonlyCodeStyle: React.CSSProperties = { ...inputStyle, color: C.textMuted, border: `1px dashed ${C.cardBdr}`, display: "flex", alignItems: "center", fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600, opacity: 0.85 };
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };

export default function InternalPartTypeMaster() {
  const [rows, setRows] = useState<PartType[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<PartType | null>(null);

  const { getRowProps } = useRowClickEdit<PartType>({ onRowClick: (r) => setEditing(r), ariaLabel: (r) => `Edit part type ${r.code}` });

  async function load() {
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/part-types?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as PartType[]);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [includeInactive]);

  async function del(s: PartType) {
    if (!(await confirmDialog(`Delete part type ${s.name} (${s.code})?\nBlocked if any part uses it — deactivate instead.`))) return;
    try {
      const r = await fetch(`/api/internal/part-types/${s.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) { notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error"); }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Part Type Master</h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: C.textMuted }}>Categories for parts (blank garment, label, trim, packaging, fabric…). Drives the Part Master type dropdown.</p>
        </div>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add part type</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Show inactive
        </label>
        <ExportButton rows={rows as unknown as Array<Record<string, unknown>>} filename="part-types" sheetName="Part Types"
          columns={[{ key: "code", header: "Code" }, { key: "name", header: "Name" }, { key: "sort_order", header: "Sort", format: "number" }, { key: "is_active", header: "Active" }] as ExportColumn<Record<string, unknown>>[]} />
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>Error: {err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        {loading ? <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
          : rows.length === 0 ? <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No part types. Add one with &quot;+ Add part type&quot;.</div>
          : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={th}>Code</th><th style={th}>Name</th><th style={{ ...th, textAlign: "right" }}>Sort</th><th style={th}>Active</th><th style={{ ...th, width: 150 }}></th></tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} {...getRowProps(s)} style={{ cursor: "pointer", ...(!s.is_active ? { opacity: 0.5 } : {}) }}>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>{s.code}</td>
                    <td style={td}>{s.name}</td>
                    <td style={{ ...td, textAlign: "right", color: C.textSub }}>{s.sort_order}</td>
                    <td style={td}>{s.is_active ? "yes" : "no"}</td>
                    <td style={{ ...td, textAlign: "right" }}>
                      <button onClick={(e) => { e.stopPropagation(); setEditing(s); }} style={btnSecondary}>Edit</button>
                      <button onClick={(e) => { e.stopPropagation(); void del(s); }} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {addOpen && <FormModal mode="add" onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load(); }} />}
      {editing && <FormModal mode="edit" row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

function FormModal({ mode, row, onClose, onSaved }: { mode: "add" | "edit"; row?: PartType; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ code: row?.code ?? "", name: row?.name ?? "", sort_order: row?.sort_order != null ? String(row.sort_order) : "0", is_active: row?.is_active ?? true });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true); setErr(null);
    try {
      const url = mode === "add" ? "/api/internal/part-types" : `/api/internal/part-types/${row!.id}`;
      const method = mode === "add" ? "POST" : "PATCH";
      const body: Record<string, unknown> = { name: form.name.trim(), sort_order: form.sort_order.trim() === "" ? 0 : parseInt(form.sort_order, 10), is_active: form.is_active };
      if (mode === "add") body.code = form.code.trim();
      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onSaved();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(480px, 95vw)", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{mode === "add" ? "Add part type" : `Edit ${row!.code}`}</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Code *">
            {mode === "add"
              ? <input type="text" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} style={inputStyle} placeholder="e.g. zipper" autoFocus />
              : <div style={readonlyCodeStyle}>{row?.code}</div>}
          </Field>
          <Field label="Name *"><input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} placeholder="e.g. Zipper" /></Field>
          <Field label="Sort order"><input type="number" min="0" step="1" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: e.target.value })} style={inputStyle} /></Field>
          <Field label="Active">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /> is_active
            </label>
          </Field>
        </div>
        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting || (mode === "add" && !form.code.trim()) || !form.name.trim()}>{submitting ? "Saving…" : mode === "add" ? "Create" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>{children}</div>;
}
