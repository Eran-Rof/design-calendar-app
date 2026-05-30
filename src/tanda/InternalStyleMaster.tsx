// src/tanda/InternalStyleMaster.tsx
//
// Tangerine P1 Chunk 7 — internal admin panel for style_master CRUD.
// List + search + create + edit + soft-delete (and a toggle to view deleted).
// Wraps /api/internal/style-master and /api/internal/style-master/:id.
//
// P3 Chunk 11 (2026-05-27): adds a "Fabrics" subsection in the edit modal that
// reads/writes the style_fabric_codes junction. The subsection manages its own
// state and calls /api/internal/style-fabric-codes directly — the style_master
// save flow is unchanged.
//
// Style Master Sweep (2026-05-30) — operator asks #5/#6/#7/#12:
//   • #5  Adds group_name / category_name / sub_category_name columns to the
//         list view and edit modal (SearchableSelect inputs since these have
//         a small but growing set of values across the catalog).
//   • #6  Replaces the modal title with "Style: <code> <name>" (edit) or
//         "Add Style" (add). Adds a notes-log section showing timestamp +
//         author email + note text, with an inline "Add note" composer.
//   • #7  style_name is now backfilled by the migration, so the list cell
//         renders the populated value (still falls back to "—" defensively).
//   • #12 Gender dropdown is the canonical six-letter set
//         { M, B, C, G, W, U } with descriptive labels.

import { useCallback, useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SearchableSelect, { type SearchableSelectOption } from "./components/SearchableSelect";
import { getCachedAuthUserId, getCachedAuthUserEmail } from "../utils/tangerineAuthUser";

type Style = {
  id: string;
  style_code: string;
  style_name: string | null;
  description: string;
  category_id: string | null;
  gender_code: string | null;
  season: string | null;
  design_year: number | null;
  is_apparel: boolean;
  launch_date: string | null;
  lifecycle_status: string;
  planning_class: string | null;
  base_fabric: string | null;
  group_name: string | null;
  category_name: string | null;
  sub_category_name: string | null;
  attributes: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type StyleNote = {
  id: string;
  style_id: string;
  note_text: string;
  created_by: string | null;
  created_by_email: string | null;
  created_at: string;
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

// Canonical gender set (operator ask #12, 2026-05-30).
// Display labels show the code + a descriptive name; value is the single letter.
const GENDER_OPTIONS: { value: string; label: string }[] = [
  { value: "",  label: "(none)"      },
  { value: "M", label: "M — Mens"    },
  { value: "B", label: "B — Boys"    },
  { value: "C", label: "C — Child"   },
  { value: "G", label: "G — Girls"   },
  { value: "W", label: "W — Womens"  },
  { value: "U", label: "U — Unisex"  },
];

const LIFECYCLE_OPTIONS = ["active", "phased_out", "discontinued", "core"];
const PLANNING_OPTIONS  = ["", "core", "seasonal", "fashion"];

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
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  // Freeze the header row when the list scrolls (the table is wrapped in a
  // scrolling container below; sticky positions relative to that ancestor).
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};

function genderLabelFor(code: string | null): string {
  if (!code) return "—";
  const hit = GENDER_OPTIONS.find((o) => o.value === code);
  return hit ? hit.label : code;
}

// Distinct + sorted list of values currently in use for one classifier column.
// Drives the SearchableSelect options so operators can pick an existing value
// or type a new one (the component accepts free text via its onChange).
function distinctValues(rows: Style[], key: keyof Style): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const v = r[key];
    if (typeof v === "string" && v.trim()) set.add(v.trim());
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

export default function InternalStyleMaster() {
  const [rows, setRows] = useState<Style[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Style | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (includeDeleted) params.set("include_deleted", "true");
      const r = await fetch(`/api/internal/style-master?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as Style[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // q is read at call-time via the input's Enter handler / Search button;
    // including it in deps would refetch on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeDeleted]);

  useEffect(() => { void load(); }, [load]);

  async function softDelete(id: string) {
    if (!confirm("Soft-delete this style? Can be restored by an admin SQL update.")) return;
    try {
      const r = await fetch(`/api/internal/style-master/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Memoized distinct-value lists for the three SearchableSelect inputs in the
  // modal. Recomputes only when the row set changes.
  const groupOptions = useMemo(() => distinctValues(rows, "group_name"), [rows]);
  const categoryOptions = useMemo(() => distinctValues(rows, "category_name"), [rows]);
  const subCategoryOptions = useMemo(() => distinctValues(rows, "sub_category_name"), [rows]);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Style Master</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add style</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        <input
          type="text"
          placeholder="Search style number, name or description…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void load()}
          style={{ ...inputStyle, maxWidth: 360 }}
        />
        <button onClick={() => void load()} style={btnSecondary}>Search</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(e) => setIncludeDeleted(e.target.checked)}
          />
          Show deleted
        </label>
        <ExportButton
          rows={rows as unknown as Array<Record<string, unknown>>}
          filename="style-master"
          sheetName="Style Master"
          columns={[
            { key: "style_code",        header: "Style Number" },
            { key: "style_name",        header: "Style Name" },
            { key: "description",       header: "Description" },
            { key: "gender_code",       header: "Gender" },
            { key: "group_name",        header: "Group" },
            { key: "category_name",     header: "Category" },
            { key: "sub_category_name", header: "Sub Category" },
            { key: "season",            header: "Season" },
            { key: "design_year",       header: "Year", format: "number" },
            { key: "lifecycle_status",  header: "Lifecycle" },
            { key: "is_apparel",        header: "Apparel" },
            { key: "planning_class",    header: "Planning Class" },
            { key: "base_fabric",       header: "Base Fabric" },
            { key: "launch_date",       header: "Launch Date", format: "date" },
            { key: "created_at",        header: "Created", format: "datetime" },
            { key: "updated_at",        header: "Updated", format: "datetime" },
            { key: "deleted_at",        header: "Deleted", format: "datetime" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, maxHeight: "calc(100vh - 220px)", overflowY: "auto", overflowX: "auto" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No styles found.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Style Number</th>
                <th style={th}>Style Name</th>
                <th style={th}>Description</th>
                <th style={th}>Gender</th>
                <th style={th}>Group</th>
                <th style={th}>Category</th>
                <th style={th}>Sub Category</th>
                <th style={th}>Season</th>
                <th style={th}>Year</th>
                <th style={th}>Lifecycle</th>
                <th style={th}>Apparel</th>
                <th style={{ ...th, width: 140 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={r.deleted_at ? { opacity: 0.4 } : {}}>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>
                    {r.style_code}
                  </td>
                  <td style={td}>{r.style_name || "—"}</td>
                  <td style={td}>{r.description}</td>
                  <td style={td}>{genderLabelFor(r.gender_code)}</td>
                  <td style={td}>{r.group_name || "—"}</td>
                  <td style={td}>{r.category_name || "—"}</td>
                  <td style={td}>{r.sub_category_name || "—"}</td>
                  <td style={td}>{r.season || "—"}</td>
                  <td style={td}>{r.design_year ?? "—"}</td>
                  <td style={td}>{r.lifecycle_status}</td>
                  <td style={td}>{r.is_apparel ? "yes" : "no"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    {!r.deleted_at && (
                      <>
                        <button onClick={() => setEditing(r)} style={btnSecondary}>Edit</button>
                        <button onClick={() => void softDelete(r.id)} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && (
        <StyleFormModal
          mode="add"
          groupOptions={groupOptions}
          categoryOptions={categoryOptions}
          subCategoryOptions={subCategoryOptions}
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); void load(); }}
        />
      )}
      {editing && (
        <StyleFormModal
          mode="edit"
          style={editing}
          groupOptions={groupOptions}
          categoryOptions={categoryOptions}
          subCategoryOptions={subCategoryOptions}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  style?: Style;
  groupOptions: string[];
  categoryOptions: string[];
  subCategoryOptions: string[];
  onClose: () => void;
  onSaved: () => void;
}

function StyleFormModal({ mode, style, groupOptions, categoryOptions, subCategoryOptions, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    style_code:         style?.style_code         ?? "",
    style_name:         style?.style_name         ?? "",
    description:        style?.description        ?? "",
    gender_code:        style?.gender_code        ?? "",
    season:             style?.season             ?? "",
    design_year:        style?.design_year        != null ? String(style.design_year) : "",
    lifecycle_status:   style?.lifecycle_status   ?? "active",
    planning_class:     style?.planning_class     ?? "",
    is_apparel:         style?.is_apparel         ?? true,
    base_fabric:        style?.base_fabric        ?? "",
    group_name:         style?.group_name         ?? "",
    category_name:      style?.category_name      ?? "",
    sub_category_name:  style?.sub_category_name  ?? "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        style_name:        form.style_name.trim() || null,
        description:       form.description.trim(),
        gender_code:       form.gender_code || null,
        season:            form.season || null,
        design_year:       form.design_year ? parseInt(form.design_year, 10) : null,
        lifecycle_status:  form.lifecycle_status,
        planning_class:    form.planning_class || null,
        is_apparel:        form.is_apparel,
        base_fabric:       form.base_fabric || null,
        group_name:        form.group_name.trim() || null,
        category_name:     form.category_name.trim() || null,
        sub_category_name: form.sub_category_name.trim() || null,
      };
      let url: string;
      let method: string;
      if (mode === "add") {
        body.style_code = form.style_code.trim().toUpperCase();
        url = "/api/internal/style-master";
        method = "POST";
      } else {
        url = `/api/internal/style-master/${style!.id}`;
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

  const title =
    mode === "add"
      ? "Add Style"
      : `Style: ${style?.style_code ?? ""}${style?.style_name ? ` ${style.style_name}` : ""}`;

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 24, width: "min(92vw, 760px)", maxHeight: "90vh", overflowY: "auto", color: C.text }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{title}</h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Style Number">
            {mode === "add" ? (
              <input
                type="text"
                value={form.style_code}
                onChange={(e) => setForm({ ...form, style_code: e.target.value })}
                style={inputStyle}
                placeholder="e.g. RY1234"
                autoFocus
              />
            ) : (
              <input type="text" value={form.style_code} disabled style={{ ...inputStyle, opacity: 0.6 }} />
            )}
          </Field>
          <Field label="Style Name">
            <input
              type="text"
              value={form.style_name}
              onChange={(e) => setForm({ ...form, style_name: e.target.value })}
              style={inputStyle}
              placeholder="Short marketing/internal name"
            />
          </Field>
          <Field label="Description">
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              style={inputStyle}
              placeholder="Free-text description"
            />
          </Field>
          <Field label="Gender">
            <select
              value={form.gender_code}
              onChange={(e) => setForm({ ...form, gender_code: e.target.value })}
              style={inputStyle as React.CSSProperties}
            >
              {GENDER_OPTIONS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
            </select>
          </Field>

          {/* Operator ask #5 — group / category / sub_category classifier inputs.
              SearchableSelect lets operators pick an existing value (from the
              current dataset) or type a new one without leaving the keyboard. */}
          <Field label="Group">
            <FreeTextSearchableSelect
              value={form.group_name}
              onChange={(v) => setForm({ ...form, group_name: v })}
              choices={groupOptions}
              placeholder="e.g. Apparel"
            />
          </Field>
          <Field label="Category">
            <FreeTextSearchableSelect
              value={form.category_name}
              onChange={(v) => setForm({ ...form, category_name: v })}
              choices={categoryOptions}
              placeholder="e.g. Tops"
            />
          </Field>
          <Field label="Sub Category">
            <FreeTextSearchableSelect
              value={form.sub_category_name}
              onChange={(v) => setForm({ ...form, sub_category_name: v })}
              choices={subCategoryOptions}
              placeholder="e.g. T-Shirts"
            />
          </Field>

          <Field label="Season">
            <input type="text" value={form.season} onChange={(e) => setForm({ ...form, season: e.target.value })} style={inputStyle} placeholder="e.g. FW26" />
          </Field>
          <Field label="Design year">
            <input type="number" value={form.design_year} onChange={(e) => setForm({ ...form, design_year: e.target.value })} style={inputStyle} placeholder="2026" />
          </Field>
          <Field label="Lifecycle">
            <select value={form.lifecycle_status} onChange={(e) => setForm({ ...form, lifecycle_status: e.target.value })} style={inputStyle as React.CSSProperties}>
              {LIFECYCLE_OPTIONS.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </Field>
          <Field label="Planning class">
            <select value={form.planning_class} onChange={(e) => setForm({ ...form, planning_class: e.target.value })} style={inputStyle as React.CSSProperties}>
              {PLANNING_OPTIONS.map((g) => <option key={g} value={g}>{g || "(none)"}</option>)}
            </select>
          </Field>
          <Field label="Base fabric">
            <input type="text" value={form.base_fabric} onChange={(e) => setForm({ ...form, base_fabric: e.target.value })} style={inputStyle} />
          </Field>
          <Field label="Apparel?">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input type="checkbox" checked={form.is_apparel} onChange={(e) => setForm({ ...form, is_apparel: e.target.checked })} />
              Yes (enforce 5-dim matrix on linked items)
            </label>
          </Field>
        </div>

        {mode === "edit" && style && (
          <StyleFabricsSection styleId={style.id} />
        )}

        {/* Operator ask #6 — notes log section. Only meaningful on existing
            rows, so we render it for edit mode only. */}
        {mode === "edit" && style && (
          <StyleNotesSection styleId={style.id} />
        )}

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

// ─────────────────────────────────────────────────────────────────────────────
// FreeTextSearchableSelect — thin wrapper around <SearchableSelect> that lets
// the operator either choose from the existing distinct values OR type a brand
// new one. Implementation: when the typed value doesn't match any choice, we
// synthesize a "(use: …)" option so the user can commit it; SearchableSelect's
// onChange returns the option value, which is exactly the typed text.
// ─────────────────────────────────────────────────────────────────────────────
function FreeTextSearchableSelect({
  value,
  onChange,
  choices,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  choices: string[];
  placeholder?: string;
}) {
  const options: SearchableSelectOption[] = useMemo(() => {
    const base: SearchableSelectOption[] = [
      { value: "", label: "(none)" },
      ...choices.map((c) => ({ value: c, label: c })),
    ];
    // If the current value isn't one of the known choices, surface it as the
    // selected option so the picker shows it.
    if (value && !choices.includes(value)) {
      base.push({ value, label: value });
    }
    return base;
  }, [choices, value]);

  // SearchableSelect supports picking from a list; for true free-text entry
  // we render a small adjacent text input so the operator can type a new value
  // and the change reflects immediately. The picker handles the "select from
  // known values" path.
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 6 }}>
      <SearchableSelect
        value={value || null}
        onChange={onChange}
        options={options}
        placeholder={placeholder || "Pick or type below"}
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle, fontSize: 12 }}
        placeholder="…or type a new value"
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// P3 Chunk 11 — Fabrics subsection embedded in the style edit modal.
// Self-managing: reads/writes /api/internal/style-fabric-codes directly.
// Style master save is independent of this section's lifecycle.
// ─────────────────────────────────────────────────────────────────────────────
const FABRIC_ROLES = ["primary", "lining", "trim", "interlining", "accent", "other"] as const;

type FabricCodeLite = {
  id: string;
  code: string;
  name: string;
  composition_text: string;
  fabric_weight_gsm: number | null;
};

type StyleFabricLink = {
  id: string;
  style_id: string;
  fabric_code_id: string;
  role: string;
  yardage_per_unit: number | null;
  notes: string | null;
  fabric?: FabricCodeLite | null;
};

function StyleFabricsSection({ styleId }: { styleId: string }) {
  const [links, setLinks] = useState<StyleFabricLink[]>([]);
  const [fabrics, setFabrics] = useState<FabricCodeLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState({
    role: "primary",
    fabric_code_id: "",
    yardage_per_unit: "",
    notes: "",
  });

  async function loadLinks() {
    try {
      const r = await fetch(`/api/internal/style-fabric-codes?style_id=${styleId}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setLinks(await r.json() as StyleFabricLink[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function loadFabrics() {
    try {
      const r = await fetch(`/api/internal/fabric-codes?limit=500`);
      if (!r.ok) return;
      const data = await r.json();
      if (Array.isArray(data)) setFabrics(data as FabricCodeLite[]);
    } catch { /* non-fatal */ }
  }

  useEffect(() => { void loadLinks(); void loadFabrics(); }, [styleId]);

  async function addLink() {
    setErr(null);
    try {
      if (!draft.fabric_code_id) throw new Error("Select a fabric");
      const body: Record<string, unknown> = {
        style_id: styleId,
        fabric_code_id: draft.fabric_code_id,
        role: draft.role,
        yardage_per_unit: draft.yardage_per_unit ? Number(draft.yardage_per_unit) : null,
        notes: draft.notes || null,
      };
      const r = await fetch(`/api/internal/style-fabric-codes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setAddOpen(false);
      setDraft({ role: "primary", fabric_code_id: "", yardage_per_unit: "", notes: "" });
      await loadLinks();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeLink(id: string) {
    if (!confirm("Remove this fabric from the style?")) return;
    try {
      const r = await fetch(`/api/internal/style-fabric-codes/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await loadLinks();
    } catch (e: unknown) {
      alert(`Remove failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div style={{ marginTop: 16, padding: 12, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Fabrics</div>
        {!addOpen && (
          <button onClick={() => setAddOpen(true)} style={btnSecondary}>+ Add fabric</button>
        )}
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "6px 10px", borderRadius: 4, marginBottom: 8, fontSize: 12 }}>
          {err}
        </div>
      )}

      {loading ? (
        <div style={{ color: C.textMuted, fontSize: 12, padding: "4px 0" }}>Loading…</div>
      ) : links.length === 0 ? (
        <div style={{ color: C.textMuted, fontSize: 12, padding: "4px 0" }}>No fabrics attached.</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={th}>Role</th>
              <th style={th}>Fabric</th>
              <th style={th}>Yards/unit</th>
              <th style={th}>Notes</th>
              <th style={{ ...th, width: 70 }}></th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.id}>
                <td style={td}>{l.role}</td>
                <td style={td}>
                  {l.fabric
                    ? <span><strong>{l.fabric.code}</strong> — {l.fabric.name}</span>
                    : <span style={{ color: C.textMuted }}>(unknown)</span>}
                </td>
                <td style={td}>{l.yardage_per_unit ?? "—"}</td>
                <td style={td}>{l.notes ?? "—"}</td>
                <td style={{ ...td, textAlign: "right" }}>
                  <button onClick={() => void removeLink(l.id)} style={btnDanger}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {addOpen && (
        <div style={{ marginTop: 10, padding: 10, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 6, minWidth: 0 }}>
          {/* Stacked layout — selects + inputs need ~150px minimum to render readably
              and a 3-column grid overflows the parent edit modal. Two rows × two cols
              keeps everything inside the modal width. */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, alignItems: "end", minWidth: 0 }}>
            <Field label="Role">
              <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} style={{ ...(inputStyle as React.CSSProperties), minWidth: 0 }}>
                {FABRIC_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
            <Field label="Yards/unit">
              <input
                type="number"
                step="0.0001"
                value={draft.yardage_per_unit}
                onChange={(e) => setDraft({ ...draft, yardage_per_unit: e.target.value })}
                style={{ ...inputStyle, minWidth: 0 }}
              />
            </Field>
          </div>
          <div style={{ marginTop: 8, minWidth: 0 }}>
            <Field label="Fabric">
              <select
                value={draft.fabric_code_id}
                onChange={(e) => setDraft({ ...draft, fabric_code_id: e.target.value })}
                style={{ ...(inputStyle as React.CSSProperties), minWidth: 0 }}
              >
                <option value="">— select —</option>
                {fabrics.map((f) => (
                  <option key={f.id} value={f.id}>{f.code} — {f.name}</option>
                ))}
              </select>
            </Field>
          </div>
          <div style={{ marginTop: 8, minWidth: 0 }}>
            <Field label="Notes">
              <input
                type="text"
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                style={{ ...inputStyle, minWidth: 0 }}
                placeholder="optional"
              />
            </Field>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 8 }}>
            <button onClick={() => setAddOpen(false)} style={btnSecondary}>Cancel</button>
            <button onClick={() => void addLink()} style={btnPrimary}>Add</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Style Master Sweep (#6) — Notes log embedded in the style edit modal.
// Reads/writes /api/internal/style-master/notes directly.
// ─────────────────────────────────────────────────────────────────────────────
function StyleNotesSection({ styleId }: { styleId: string }) {
  const [notes, setNotes] = useState<StyleNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);

  const cachedUserId = getCachedAuthUserId();
  const cachedUserEmail = getCachedAuthUserEmail();

  async function loadNotes() {
    setErr(null);
    try {
      const r = await fetch(`/api/internal/style-master/notes?style_id=${styleId}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setNotes(await r.json() as StyleNote[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadNotes(); }, [styleId]);

  async function addNote() {
    const text = draft.trim();
    if (!text) return;
    setPosting(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        style_id: styleId,
        note_text: text,
      };
      if (cachedUserId) body.created_by = cachedUserId;
      if (cachedUserEmail) body.created_by_email = cachedUserEmail;
      const r = await fetch(`/api/internal/style-master/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setDraft("");
      await loadNotes();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  }

  return (
    <div style={{ marginTop: 16, padding: 12, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Notes</div>
        <div style={{ fontSize: 11, color: C.textMuted }}>
          {cachedUserEmail ? `Signed in as ${cachedUserEmail}` : "Signed-in email not detected — notes will tag (unknown)"}
        </div>
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "6px 10px", borderRadius: 4, marginBottom: 8, fontSize: 12 }}>
          {err}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !posting && draft.trim()) void addNote(); }}
          style={{ ...inputStyle, flex: 1 }}
          placeholder="Add a note…"
          disabled={posting}
        />
        <button
          onClick={() => void addNote()}
          style={{ ...btnPrimary, opacity: posting || !draft.trim() ? 0.6 : 1 }}
          disabled={posting || !draft.trim()}
        >
          {posting ? "Adding…" : "Add note"}
        </button>
      </div>

      {loading ? (
        <div style={{ color: C.textMuted, fontSize: 12, padding: "4px 0" }}>Loading…</div>
      ) : notes.length === 0 ? (
        <div style={{ color: C.textMuted, fontSize: 12, padding: "4px 0" }}>No notes yet.</div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
          {notes.map((n) => (
            <li
              key={n.id}
              style={{
                background: C.card,
                border: `1px solid ${C.cardBdr}`,
                borderRadius: 6,
                padding: "6px 10px",
                fontSize: 12,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, color: C.textMuted, marginBottom: 2 }}>
                <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace" }}>
                  {formatNoteTimestamp(n.created_at)}
                </span>
                <span>{n.created_by_email || "(unknown)"}</span>
              </div>
              <div style={{ color: C.text, whiteSpace: "pre-wrap" }}>{n.note_text}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatNoteTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}
