// src/tanda/InternalDatePresetMaster.tsx
//
// Tangerine — Date Presets Master admin panel.
// Operator-defined ADDITIONAL date-range presets that merge with the built-in
// ones (MTD/YTD/Last 30d/…) in every <DateRangePresets/> selector across the
// suite. Each preset is a relative expression (`kind` + optional `n`) that
// recomputes against "today" — never a stored absolute range.
// Wraps /api/internal/date-presets and /api/internal/date-presets/:id.

import { useEffect, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import SearchableSelect from "./components/SearchableSelect";
import { computeForKind } from "./components/dateRangeMath";

// Kinds the API accepts, with friendly labels. N_KINDS need a positive n.
const KINDS: { value: string; label: string }[] = [
  { value: "today",            label: "Today" },
  { value: "yesterday",        label: "Yesterday" },
  { value: "last_n_days",      label: "Last N days" },
  { value: "last_n_months",    label: "Last N months" },
  { value: "mtd",              label: "Month to date (MTD)" },
  { value: "ytd",              label: "Year to date (YTD)" },
  { value: "this_month",       label: "This month" },
  { value: "last_month",       label: "Last month" },
  { value: "this_quarter",     label: "This quarter" },
  { value: "last_quarter",     label: "Last quarter" },
  { value: "this_year",        label: "This year" },
  { value: "last_year",        label: "Last year" },
  { value: "ty_to_last_month", label: "This year → last month" },
];
const N_KINDS = new Set(["last_n_days", "last_n_months"]);
const kindLabel = (k: string) => KINDS.find((x) => x.value === k)?.label ?? k;

type DatePreset = {
  id: string;
  entity_id: string;
  label: string;
  kind: string;
  n: number | null;
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
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12 };
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d" };
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", colorScheme: "dark" };
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };

function previewRange(kind: string, n: number | null): string {
  const { from, to } = computeForKind(kind, n);
  return from === to ? from : `${from} → ${to}`;
}

export default function InternalDatePresetMaster() {
  const [rows, setRows] = useState<DatePreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<DatePreset | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const { getRowProps } = useRowClickEdit<DatePreset>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit date preset ${r.label}`,
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/date-presets?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as DatePreset[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [includeInactive]);

  async function del(s: DatePreset) {
    if (!(await confirmDialog(`Delete date preset “${s.label}”?`))) return;
    try {
      const r = await fetch(`/api/internal/date-presets/${s.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Date Presets</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add preset</button>
      </div>
      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 16 }}>
        Additional quick date-range presets. They appear — alongside the built-in MTD / YTD / Last 30d / … — in every date-range filter across the suite.
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show inactive
        </label>
        <ExportButton
          rows={rows as unknown as Array<Record<string, unknown>>}
          filename="date-presets"
          sheetName="Date Presets"
          columns={[
            { key: "label",      header: "Label" },
            { key: "kind",       header: "Kind" },
            { key: "n",          header: "N", format: "number" },
            { key: "sort_order", header: "Sort", format: "number" },
            { key: "is_active",  header: "Active" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>Error: {err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 260px)" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No custom date presets yet. Add one with “+ Add preset”.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Label</th>
                <th style={th}>Kind</th>
                <th style={th}>Range (today)</th>
                <th style={th}>Sort</th>
                <th style={th}>Active</th>
                <th style={{ ...th, width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <ScrollHighlightRow key={s.id} rowId={s.id} highlightedRowId={highlightedId} {...getRowProps(s)} style={!s.is_active ? { opacity: 0.5 } : undefined}>
                  <td style={{ ...td, fontWeight: 600 }}>{s.label}</td>
                  <td style={{ ...td, color: C.textSub }}>{kindLabel(s.kind)}{N_KINDS.has(s.kind) && s.n != null ? ` (${s.n})` : ""}</td>
                  <td style={{ ...td, color: C.textMuted, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 12 }}>{previewRange(s.kind, s.n)}</td>
                  <td style={{ ...td, color: C.textSub }}>{s.sort_order}</td>
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

      {addOpen && <DatePresetFormModal mode="add" onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load(); }} />}
      {editing && <DatePresetFormModal mode="edit" preset={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

function DatePresetFormModal({ mode, preset, onClose, onSaved }: { mode: "add" | "edit"; preset?: DatePreset; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    label:      preset?.label ?? "",
    kind:       preset?.kind ?? "last_n_days",
    n:          preset?.n != null ? String(preset.n) : "7",
    sort_order: preset?.sort_order != null ? String(preset.sort_order) : "0",
    is_active:  preset?.is_active ?? true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const needsN = N_KINDS.has(form.kind);
  const preview = previewRange(form.kind, needsN ? (parseInt(form.n, 10) || 0) : null);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const url = mode === "add" ? "/api/internal/date-presets" : `/api/internal/date-presets/${preset!.id}`;
      const method = mode === "add" ? "POST" : "PATCH";
      const body = {
        label: form.label.trim(),
        kind: form.kind,
        n: needsN ? (form.n.trim() === "" ? null : parseInt(form.n, 10)) : null,
        sort_order: form.sort_order.trim() === "" ? 0 : parseInt(form.sort_order, 10),
        is_active: form.is_active,
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
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(520px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{mode === "add" ? "Add date preset" : `Edit ${preset!.label}`}</h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Label *">
            <input type="text" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} style={inputStyle} placeholder="e.g. Last 14 days" autoFocus />
          </Field>
          <Field label="Kind *">
            <SearchableSelect
              value={form.kind || null}
              onChange={(v) => setForm({ ...form, kind: v })}
              options={KINDS.map((k) => ({ value: k.value, label: k.label }))}
              inputStyle={inputStyle}
            />
          </Field>
          {needsN && (
            <Field label={form.kind === "last_n_months" ? "Months (N) *" : "Days (N) *"}>
              <input type="number" min="1" step="1" value={form.n} onChange={(e) => setForm({ ...form, n: e.target.value })} style={inputStyle} placeholder={form.kind === "last_n_months" ? "e.g. 3" : "e.g. 14"} />
            </Field>
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
        </div>

        <div style={{ marginTop: 12, fontSize: 12, color: C.textMuted }}>
          Range as of today: <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace", color: C.textSub }}>{preview}</span>
        </div>

        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>{err}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting || !form.label.trim()}>
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
