// src/tanda/InternalHtsMaster.tsx
//
// Tangerine — HTS (Harmonized Tariff Schedule) Master panel.
// Operator-managed reference table of HTS codes used for import classification.
// List + search + add/edit modal + hard-delete.
// Wraps /api/internal/hts-codes and /:id.

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

const HTS_TABLE_KEY = "tangerine:htsmaster:columns";
const HTS_COLUMNS: ColumnDef[] = [
  { key: "code",          label: "Code" },
  { key: "description",   label: "Description" },
  { key: "chapter",       label: "Chapter" },
  { key: "heading",       label: "Heading" },
  { key: "duty_rate_pct", label: "Duty Rate %" },
  { key: "is_active",     label: "Active" },
];

type HtsRow = {
  id: string;
  entity_id: string;
  code: string;
  description: string;
  chapter: string | null;
  heading: string | null;
  duty_rate_pct: number | null;
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

export default function InternalHtsMaster() {
  const [rows, setRows] = useState<HtsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const { value: q, debouncedValue: qDebounced, setValue: setQ } = useDebouncedSearch("", 200);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<HtsRow | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(HTS_TABLE_KEY, HTS_COLUMNS);
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:htsmaster:sort",
  });

  const { getRowProps } = useRowClickEdit<HtsRow>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit HTS code ${r.code}`,
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (qDebounced.trim()) params.set("q", qDebounced.trim());
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/hts-codes?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as HtsRow[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [qDebounced, includeInactive]);

  async function hardDelete(id: string, code: string) {
    if (!(await confirmDialog(`Permanently delete HTS code ${code}? This cannot be undone.`))) return;
    try {
      const r = await fetch(`/api/internal/hts-codes/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <div>
          <h2 style={{ margin: "0 0 4px", fontSize: 22 }}>HTS Master</h2>
          <p style={{ margin: 0, fontSize: 13, color: C.textMuted }}>
            Harmonized Tariff Schedule codes for import classification.
          </p>
        </div>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add HTS code</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 16, marginBottom: 12, flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="Search code / description / chapter…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ ...inputStyle, maxWidth: 340 }}
        />
        <button onClick={() => void load()} style={btnSecondary}>Search</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show inactive
        </label>
        <ExportButton
          rows={rows as unknown as Array<Record<string, unknown>>}
          filename="hts-master"
          sheetName="HTS Master"
          columns={[
            { key: "code",          header: "Code" },
            { key: "description",   header: "Description" },
            { key: "chapter",       header: "Chapter" },
            { key: "heading",       header: "Heading" },
            { key: "duty_rate_pct", header: "Duty Rate %", format: "number" },
            { key: "notes",         header: "Notes" },
            { key: "is_active",     header: "Active" },
            { key: "sort_order",    header: "Sort Order", format: "number" },
            { key: "created_at",    header: "Created", format: "datetime" },
            { key: "updated_at",    header: "Updated", format: "datetime" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
        <TablePrefsButton
          tableKey={HTS_TABLE_KEY}
          columns={HTS_COLUMNS}
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
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No HTS codes found.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <SortableTh label="Code"        sortKey="code"          activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("code")} />
                <SortableTh label="Description" sortKey="description"   activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("description")} />
                <SortableTh label="Chapter"     sortKey="chapter"       activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("chapter")} />
                <SortableTh label="Heading"     sortKey="heading"       activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("heading")} />
                <SortableTh label="Duty Rate %" sortKey="duty_rate_pct" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("duty_rate_pct")} />
                <SortableTh label="Active"      sortKey="is_active"     activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!isVisible("is_active")} />
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
                  <td style={td} hidden={!isVisible("description")}>{r.description}</td>
                  <td style={td} hidden={!isVisible("chapter")}>{r.chapter ?? "—"}</td>
                  <td style={td} hidden={!isVisible("heading")}>{r.heading ?? "—"}</td>
                  <td style={td} hidden={!isVisible("duty_rate_pct")}>
                    {r.duty_rate_pct != null ? `${r.duty_rate_pct}%` : "—"}
                  </td>
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
        <HtsFormModal
          mode="add"
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); void load(); }}
        />
      )}
      {editing && (
        <HtsFormModal
          mode="edit"
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  row?: HtsRow;
  onClose: () => void;
  onSaved: () => void;
}

function HtsFormModal({ mode, row, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    code:          row?.code          ?? "",
    description:   row?.description   ?? "",
    chapter:       row?.chapter       ?? "",
    heading:       row?.heading       ?? "",
    duty_rate_pct: row?.duty_rate_pct != null ? String(row.duty_rate_pct) : "",
    notes:         row?.notes         ?? "",
    is_active:     row?.is_active     ?? true,
    sort_order:    row?.sort_order    != null ? String(row.sort_order) : "0",
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // AI HTS classification (Claude Haiku via /api/internal/hts/suggest). Type a
  // description/fabric content, get the top-3 codes, click one to fill the form.
  type HtsSuggestion = { code: string; description: string; duty_rate_pct?: number; confidence: string; reasoning: string };
  const [aiSuggestions, setAiSuggestions] = useState<HtsSuggestion[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);

  async function fetchAiSuggestions() {
    setAiLoading(true);
    setAiErr(null);
    setAiSuggestions([]);
    try {
      const r = await fetch("/api/internal/hts/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fabric_content: form.description.trim(), category: form.description.trim() }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setAiSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
      if (data.note) setAiErr(data.note);
    } catch (e: unknown) {
      setAiErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAiLoading(false);
    }
  }

  function applyAiSuggestion(s: HtsSuggestion) {
    const digits = String(s.code).replace(/\D/g, "");
    setForm((f) => ({
      ...f,
      code: s.code,
      description: s.description || f.description,
      chapter: digits.slice(0, 2) || f.chapter,
      heading: digits.slice(0, 4) || f.heading,
      duty_rate_pct: s.duty_rate_pct != null ? String(s.duty_rate_pct) : f.duty_rate_pct,
    }));
    setAiSuggestions([]);
  }

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        description:   form.description.trim(),
        chapter:       form.chapter.trim() || null,
        heading:       form.heading.trim() || null,
        duty_rate_pct: form.duty_rate_pct.trim() ? Number(form.duty_rate_pct) : null,
        notes:         form.notes.trim() || null,
        is_active:     form.is_active,
        sort_order:    parseInt(form.sort_order || "0", 10),
      };
      let url: string;
      let method: string;
      if (mode === "add") {
        body.code = form.code.trim();
        url = "/api/internal/hts-codes";
        method = "POST";
      } else {
        url = `/api/internal/hts-codes/${row!.id}`;
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
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {mode === "add" ? "Add HTS code" : `Edit ${row!.code}`}
        </h3>

        {mode === "add" && (
          <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12, marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: C.textSub }}>
                Type a product/fabric description below, then auto-fill the code, chapter, heading & duty with AI.
              </span>
              <button
                type="button"
                onClick={() => void fetchAiSuggestions()}
                disabled={aiLoading || !form.description.trim()}
                style={{ ...btnSecondary, whiteSpace: "nowrap", flexShrink: 0, opacity: !form.description.trim() ? 0.5 : 1 }}
                title="Use Claude AI to classify and fill HTS fields from the description"
              >
                {aiLoading ? "…" : "Suggest HTS"}
              </button>
            </div>
            {aiErr && <div style={{ fontSize: 11, color: C.warn }}>{aiErr}</div>}
            {aiSuggestions.length > 0 && (
              <div style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 4, overflow: "hidden", marginTop: 4 }}>
                {aiSuggestions.map((s, i) => (
                  <div
                    key={i}
                    onClick={() => applyAiSuggestion(s)}
                    style={{ padding: "7px 10px", cursor: "pointer", borderBottom: i < aiSuggestions.length - 1 ? `1px solid ${C.cardBdr}` : undefined, background: C.card }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 700, color: C.primary, fontSize: 13 }}>{s.code}</span>
                      <span style={{ fontSize: 11, color: s.confidence === "high" ? C.success : s.confidence === "medium" ? C.warn : C.textMuted }}>{s.confidence}</span>
                    </div>
                    <div style={{ fontSize: 12, color: C.textSub, marginTop: 2 }}>{s.description}</div>
                    {s.duty_rate_pct != null && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>Duty: {s.duty_rate_pct}%</div>}
                    {s.reasoning && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2, fontStyle: "italic" }}>{s.reasoning}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="HTS Code" wide={mode === "edit"}>
            {mode === "add" ? (
              <input
                type="text"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                style={inputStyle}
                placeholder="e.g. 6110.20.2090"
              />
            ) : (
              <div style={{ background: "#0b1220", color: C.textMuted, border: `1px dashed ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>
                {row!.code}
              </div>
            )}
          </Field>
          <Field label="Description" wide>
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              style={inputStyle}
              placeholder="e.g. Sweaters, pullovers — cotton, knitted"
            />
          </Field>
          <Field label="Chapter">
            <input
              type="text"
              value={form.chapter}
              onChange={(e) => setForm({ ...form, chapter: e.target.value })}
              style={inputStyle}
              placeholder="e.g. 61"
            />
          </Field>
          <Field label="Heading">
            <input
              type="text"
              value={form.heading}
              onChange={(e) => setForm({ ...form, heading: e.target.value })}
              style={inputStyle}
              placeholder="e.g. 6110"
            />
          </Field>
          <Field label="Duty Rate %">
            <input
              type="number"
              step="0.001"
              min="0"
              value={form.duty_rate_pct}
              onChange={(e) => setForm({ ...form, duty_rate_pct: e.target.value })}
              style={inputStyle}
              placeholder="e.g. 16.5"
            />
          </Field>
          <Field label="Sort Order">
            <input
              type="number"
              step="1"
              min="0"
              value={form.sort_order}
              onChange={(e) => setForm({ ...form, sort_order: e.target.value })}
              style={inputStyle}
              placeholder="0"
            />
          </Field>
          <Field label="Notes" wide>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              style={{ ...inputStyle, minHeight: 60 }}
              placeholder="Optional notes on this HTS classification…"
            />
          </Field>
          <Field label="Active?">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
              Yes (visible in HTS code picker)
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

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div style={wide ? { gridColumn: "1 / -1" } : {}}>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      {children}
    </div>
  );
}
