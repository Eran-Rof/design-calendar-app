// src/tanda/InternalSizeScales.tsx
//
// Tangerine — Size Scale Master admin panel.
// List + search + active toggle + create + edit + hard-delete (rejected with
// reference detail if any style_master rows still reference it).
// Wraps /api/internal/size-scales and /api/internal/size-scales/:id.
//
// A size scale is an ORDERED list of size labels (Postgres text[]) — e.g.
// ALPHA-XS-3XL = [XS, S, M, L, XL, 2XL, 3XL]. Style Master links a style to
// one scale via style_master.size_scale_id. The editor takes comma-separated
// input and preserves the typed order exactly.

import { useEffect, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";

type SizeScale = {
  id: string;
  entity_id: string;
  code: string;
  name: string;
  sizes: string[];
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
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};

const chipStyle: React.CSSProperties = {
  display: "inline-block", background: "#0b1220", color: C.textSub,
  border: `1px solid ${C.cardBdr}`, borderRadius: 4, padding: "2px 8px",
  fontSize: 11, fontFamily: "SFMono-Regular, Menlo, monospace", marginRight: 6, marginBottom: 4,
};

// Parse comma-separated input into an ordered, trimmed, de-blanked list.
function parseSizes(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

export default function InternalSizeScales() {
  const [rows, setRows] = useState<SizeScale[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<SizeScale | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const { getRowProps } = useRowClickEdit<SizeScale>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit size scale ${r.code}`,
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/size-scales?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as SizeScale[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [includeInactive]);

  async function del(ss: SizeScale) {
    if (!(await confirmDialog(`Delete size scale ${ss.code} (${ss.name})?\nWill fail if any style still references it — toggle is_active=false in that case.`))) return;
    try {
      const r = await fetch(`/api/internal/size-scales/${ss.id}`, { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        if (r.status === 409 && j.references) {
          notify(`Cannot delete — still referenced by ${j.references.styles} style(s).\n\nReassign those styles first, or toggle is_active=false instead.`, "error");
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
        <h2 style={{ margin: 0, fontSize: 22 }}>Size Scales</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add scale</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          placeholder="Search code or name…"
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
          rows={rows.map((r) => ({
            ...r,
            sizes_joined: Array.isArray(r.sizes) ? r.sizes.join(" · ") : "",
          })) as unknown as Array<Record<string, unknown>>}
          filename="size-scales"
          sheetName="Size Scales"
          columns={[
            { key: "code",         header: "Code" },
            { key: "name",         header: "Name" },
            { key: "sizes_joined", header: "Sizes" },
            { key: "sort_order",   header: "Sort", format: "number" },
            { key: "is_active",    header: "Active" },
            { key: "created_at",   header: "Created", format: "datetime" },
            { key: "updated_at",   header: "Updated", format: "datetime" },
          ] as ExportColumn<Record<string, unknown>>[]}
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
            No size scales found. The migration seeded the common ones (ALPHA-XS-3XL, MENS-S-2XL, etc.)
            — check &quot;Show inactive&quot; if you may have deactivated all of them.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Code</th>
                <th style={th}>Name</th>
                <th style={th}>Sizes</th>
                <th style={th}>Active</th>
                <th style={{ ...th, width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((ss) => (
                <ScrollHighlightRow
                  key={ss.id}
                  rowId={ss.id}
                  highlightedRowId={highlightedId}
                  {...getRowProps(ss)}
                  style={!ss.is_active ? { opacity: 0.5 } : undefined}
                >
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>{ss.code}</td>
                  <td style={td}>{ss.name}</td>
                  <td style={{ ...td, color: C.textSub }}>
                    {Array.isArray(ss.sizes) ? ss.sizes.join(" · ") : ""}
                  </td>
                  <td style={td}>{ss.is_active ? "yes" : "no"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={(e) => { e.stopPropagation(); setEditing(ss); }} style={btnSecondary}>Edit</button>
                    <button onClick={(e) => { e.stopPropagation(); void del(ss); }} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                  </td>
                </ScrollHighlightRow>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && <SizeScaleFormModal mode="add" onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load(); }} />}
      {editing && <SizeScaleFormModal mode="edit" scale={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  scale?: SizeScale;
  onClose: () => void;
  onSaved: () => void;
}

function SizeScaleFormModal({ mode, scale, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    code:       scale?.code ?? "",
    name:       scale?.name ?? "",
    sizesText:  scale?.sizes ? scale.sizes.join(", ") : "",
    sort_order: scale?.sort_order != null ? String(scale.sort_order) : "0",
    is_active:  scale?.is_active ?? true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const parsedSizes = parseSizes(form.sizesText);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      let url: string;
      let method: string;
      let body: Record<string, unknown>;
      if (mode === "add") {
        url = "/api/internal/size-scales";
        method = "POST";
        body = {
          code:       form.code.trim(),
          name:       form.name.trim(),
          sizes:      parsedSizes,
          sort_order: form.sort_order.trim() === "" ? 0 : parseInt(form.sort_order, 10),
          is_active:  form.is_active,
        };
      } else {
        url = `/api/internal/size-scales/${scale!.id}`;
        method = "PATCH";
        // code is locked — don't send.
        body = {
          name:       form.name.trim(),
          sizes:      parsedSizes,
          sort_order: form.sort_order.trim() === "" ? 0 : parseInt(form.sort_order, 10),
          is_active:  form.is_active,
        };
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
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, minWidth: 520, maxWidth: 640, color: C.text }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {mode === "add" ? "Add size scale" : `Edit ${scale!.code}`}
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Code *">
            {mode === "add" ? (
              <input
                type="text"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                style={inputStyle}
                placeholder="e.g. ALPHA-XS-3XL"
              />
            ) : (
              <div style={{ ...inputStyle, color: C.textMuted, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{scale?.code}</div>
            )}
          </Field>
          <Field label="Name *">
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              style={inputStyle}
              placeholder="e.g. Alpha XS–3XL"
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

        <div style={{ marginTop: 12 }}>
          <Field label="Sizes (comma-separated, in order) *">
            <input
              type="text"
              value={form.sizesText}
              onChange={(e) => setForm({ ...form, sizesText: e.target.value })}
              style={inputStyle}
              placeholder="S, M, L, XL"
            />
          </Field>
        </div>

        <div style={{
          marginTop: 14, padding: "10px 12px",
          background: "#0b1220", border: `1px dashed ${C.cardBdr}`,
          borderRadius: 6, fontSize: 11, color: C.textMuted, lineHeight: 1.6,
        }}>
          <div style={{ marginBottom: 6 }}>Preview ({parsedSizes.length} size{parsedSizes.length === 1 ? "" : "s"}, in order):</div>
          {parsedSizes.length === 0 ? (
            <span style={{ fontStyle: "italic" }}>Type comma-separated sizes above to preview the ordered scale.</span>
          ) : (
            <div>{parsedSizes.map((s, i) => <span key={`${s}-${i}`} style={chipStyle}>{s}</span>)}</div>
          )}
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
