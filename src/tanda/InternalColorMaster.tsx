// src/tanda/InternalColorMaster.tsx
//
// Tangerine — Color Master admin panel.
// List + search + active toggle + create + edit + reference-protected delete
// (rejected if any style still declares the color in attributes.color_ids).
// Wraps /api/internal/colors and /api/internal/colors/:id.
//
// A color is a named row (optional short code + #RRGGBB swatch). Style Master
// stores a style's chosen colors as an array of color ids in
// style_master.attributes.color_ids — this master curates the picklist, and the
// SO/PO size matrix renders the declared colors as rows. The list is seeded from
// every distinct color already in the catalog.

import { useEffect, useState } from "react";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import { type ExportColumn } from "./exports/useTableExport";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { ColorSwatch } from "../shared/ui/ColorSwatch";

const COLORS_TABLE_KEY = "tangerine:colors:columns";
const COLOR_COLUMNS: ColumnDef[] = [
  { key: "swatch",     label: "" },
  { key: "name",       label: "Name" },
  { key: "code",       label: "Code" },
  { key: "hex",        label: "Hex" },
  { key: "sort_order", label: "Sort" },
  { key: "is_active",  label: "Active" },
];

type Color = {
  id: string;
  name: string;
  code: string | null;
  hex: string | null;
  sort_order: number;
  is_active: boolean;
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
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};

export default function InternalColorMaster() {
  const [rows, setRows] = useState<Color[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const { value: q, debouncedValue: qDebounced, setValue: setQ } = useDebouncedSearch("", 200);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Color | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(
    COLORS_TABLE_KEY,
    COLOR_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  const { getRowProps } = useRowClickEdit<Color>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit color ${r.name}`,
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (qDebounced.trim()) params.set("q", qDebounced.trim());
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/colors?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as Color[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [qDebounced, includeInactive]);

  async function del(c: Color) {
    if (!(await confirmDialog(`Delete color "${c.name}"?\nWill fail if any style still uses it — toggle Active off to retire it instead.`))) return;
    try {
      const r = await fetch(`/api/internal/colors/${c.id}`, { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        if (r.status === 409 && j.references) {
          notify(`Cannot delete — still used by ${j.references.styles} style(s).\n\nRemove it from those styles first, or toggle Active off instead.`, "error");
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
        <h2 style={{ margin: 0, fontSize: 22 }}>Colors</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add color</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          placeholder="Search name or code…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
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
        <span style={{ fontSize: 12, color: C.textMuted }}>{rows.length} color{rows.length === 1 ? "" : "s"}</span>
        <ExportButton
          rows={rows as unknown as Array<Record<string, unknown>>}
          filename="colors"
          sheetName="Colors"
          columns={[
            { key: "name",       header: "Name" },
            { key: "code",       header: "Code" },
            { key: "hex",        header: "Hex" },
            { key: "sort_order", header: "Sort", format: "number" },
            { key: "is_active",  header: "Active" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
        <TablePrefsButton
          tableKey={COLORS_TABLE_KEY}
          columns={COLOR_COLUMNS}
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
            No colors found. Add one with &quot;+ Add color&quot; — or check &quot;Show inactive&quot;.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 28 }} hidden={!isVisible("swatch")}></th>
                <th style={th} hidden={!isVisible("name")}>Name</th>
                <th style={th} hidden={!isVisible("code")}>Code</th>
                <th style={th} hidden={!isVisible("hex")}>Hex</th>
                <th style={th} hidden={!isVisible("sort_order")}>Sort</th>
                <th style={th} hidden={!isVisible("is_active")}>Active</th>
                <th style={{ ...th, width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <ScrollHighlightRow
                  key={c.id}
                  rowId={c.id}
                  highlightedRowId={highlightedId}
                  {...getRowProps(c)}
                  style={!c.is_active ? { opacity: 0.5 } : undefined}
                >
                  <td style={{ ...td, textAlign: "center" }} hidden={!isVisible("swatch")}><ColorSwatch name={c.name} hex={c.hex} /></td>
                  <td style={td} hidden={!isVisible("name")}>{c.name}</td>
                  <td style={{ ...td, color: C.textSub }} hidden={!isVisible("code")}>{c.code || "—"}</td>
                  <td style={{ ...td, color: C.textSub, fontFamily: "SFMono-Regular, Menlo, monospace" }} hidden={!isVisible("hex")}>{c.hex || "—"}</td>
                  <td style={{ ...td, color: C.textSub }} hidden={!isVisible("sort_order")}>{c.sort_order}</td>
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

      {addOpen && (
        <ColorFormModal
          mode="add"
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); void load(); }}
        />
      )}
      {editing && <ColorFormModal mode="edit" color={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  color?: Color;
  onClose: () => void;
  onSaved: () => void;
}

function ColorFormModal({ mode, color, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    name:       color?.name ?? "",
    code:       color?.code ?? "",
    hex:        color?.hex ?? "",
    sort_order: color?.sort_order != null ? String(color.sort_order) : "0",
    is_active:  color?.is_active ?? true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const url = mode === "add" ? "/api/internal/colors" : `/api/internal/colors/${color!.id}`;
      const method = mode === "add" ? "POST" : "PATCH";
      const body = {
        name:       form.name.trim(),
        code:       form.code.trim() === "" ? null : form.code.trim(),
        hex:        form.hex.trim() === "" ? null : form.hex.trim(),
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

  const hexValid = form.hex.trim() === "" || /^#?[0-9a-fA-F]{6}$/.test(form.hex.trim());

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(520px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {mode === "add" ? "Add color" : `Edit ${color!.name}`}
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Name *">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                style={inputStyle}
                placeholder="e.g. Charcoal Heather, or Grey/Black"
                autoFocus
              />
              <ColorSwatch name={form.name} hex={form.hex} size={26} />
            </div>
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
              Two-tone colourway? Use <strong>A/B</strong> (e.g. <em>Grey/Black</em>) — the square auto-splits half-and-half.
            </div>
          </Field>
          <Field label="Code">
            <input
              type="text"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              style={inputStyle}
              placeholder="optional"
            />
          </Field>
          <Field label="Swatch (hex)">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="color"
                value={/^#?[0-9a-fA-F]{6}$/.test(form.hex.trim()) ? (form.hex.trim().startsWith("#") ? form.hex.trim() : `#${form.hex.trim()}`) : "#000000"}
                onChange={(e) => setForm({ ...form, hex: e.target.value })}
                style={{ width: 34, height: 32, padding: 0, border: `1px solid ${C.cardBdr}`, borderRadius: 4, background: "#0b1220", cursor: "pointer" }}
                title="Pick a swatch"
              />
              <input
                type="text"
                value={form.hex}
                onChange={(e) => setForm({ ...form, hex: e.target.value })}
                style={{ ...inputStyle, borderColor: hexValid ? C.cardBdr : C.danger }}
                placeholder="#RRGGBB (optional)"
              />
            </div>
            {!hexValid && <div style={{ fontSize: 11, color: C.danger, marginTop: 4 }}>Use a 6-digit hex, e.g. #1A2B3C.</div>}
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
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting || !form.name.trim() || !hexValid}>
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
