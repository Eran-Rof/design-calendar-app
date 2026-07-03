// src/tanda/InternalPartMaster.tsx
//
// Tangerine — Manufacturing Part Master admin panel.
// List + search + active toggle + create + edit + hard-delete.
// Wraps /api/internal/part-master and /api/internal/part-master/:id.
//
// A PART is a purchased component that gets assembled into a finished style
// (blank garments, labels, trims, packaging, fabric-as-part). Parts are kept
// SEPARATE from style inventory (ip_item_master) — they have their own master
// here and (M2) their own FIFO inventory pool. Default sourcing vendor + cost
// seed the AP receiving flow.

import { useEffect, useMemo, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import SearchableSelect, { type SearchableSelectOption } from "./components/SearchableSelect";
import DocumentAttachmentList from "../shared/documents/DocumentAttachmentList";
import { usePartThumbs, PartThumb } from "../shared/ui/PartThumb";

type Vendor = { id: string; name: string };
type FabricCode = { id: string; code: string; name: string | null };

type Part = {
  id: string;
  entity_id: string;
  code: string;
  name: string;
  part_type: string;
  uom: string;
  default_vendor_id: string | null;
  default_unit_cost_cents: number | null;
  is_size_scaled: boolean;
  fabric_code_id: string | null;
  notes: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type PartTypeRow = { code: string; name: string };
// Fallback labels for the 6 seed codes (used until the Part Type Master loads).
const PART_TYPE_LABEL: Record<string, string> = {
  blank_garment: "Blank garment", label: "Label", trim: "Trim",
  packaging: "Packaging", fabric: "Fabric", generic: "Generic",
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12 };
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d" };
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box" };
const readonlyCodeStyle: React.CSSProperties = { background: "#0b1220", color: C.textMuted, border: `1px dashed ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box", display: "flex", alignItems: "center", fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600, opacity: 0.85 };
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };

function fmtMoney(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function InternalPartMaster() {
  const [rows, setRows] = useState<Part[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [fabricCodes, setFabricCodes] = useState<FabricCode[]>([]);
  const [partTypes, setPartTypes] = useState<PartTypeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Part | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const thumbs = usePartThumbs(rows.map((r) => r.id));

  const vendorName = useMemo(() => {
    const m = new Map(vendors.map((v) => [v.id, v.name]));
    return (id: string | null) => (id ? m.get(id) ?? "—" : "—");
  }, [vendors]);
  const partTypeLabel = useMemo(() => {
    const m = new Map(partTypes.map((t) => [t.code, t.name]));
    return (code: string) => m.get(code) ?? PART_TYPE_LABEL[code] ?? code;
  }, [partTypes]);

  const { getRowProps } = useRowClickEdit<Part>({
    onRowClick: (r) => setEditing(r),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (r) => `Edit part ${r.code}`,
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/part-master?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as Part[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function loadVendors() {
    try {
      const r = await fetch(`/api/internal/vendor-master?limit=5000`);
      if (r.ok) { const d = await r.json(); if (Array.isArray(d)) setVendors(d as Vendor[]); }
    } catch { /* non-fatal */ }
  }
  async function loadFabricCodes() {
    try {
      const r = await fetch(`/api/internal/fabric-codes?limit=5000`);
      if (r.ok) { const d = await r.json(); if (Array.isArray(d)) setFabricCodes(d as FabricCode[]); }
    } catch { /* non-fatal */ }
  }
  async function loadPartTypes() {
    try {
      const r = await fetch(`/api/internal/part-types`);
      if (r.ok) { const d = await r.json(); if (Array.isArray(d)) setPartTypes(d as PartTypeRow[]); }
    } catch { /* non-fatal */ }
  }

  useEffect(() => { void load(); }, [includeInactive]);
  useEffect(() => { void loadVendors(); void loadFabricCodes(); void loadPartTypes(); }, []);

  async function del(s: Part) {
    if (!(await confirmDialog(`Delete part ${s.code} (${s.name})?\nThis cannot be undone — toggle is_active=false to retire it instead.`))) return;
    try {
      const r = await fetch(`/api/internal/part-master/${s.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Part Master</h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: C.textMuted }}>
            Purchased components (blank garments, labels, trims, packaging) assembled into finished styles. Kept separate from style inventory.
          </p>
        </div>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add part</button>
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
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show inactive
        </label>
        <ExportButton
          rows={rows.map((s) => ({ ...s, vendor_name: vendorName(s.default_vendor_id), part_type_label: partTypeLabel(s.part_type) })) as unknown as Array<Record<string, unknown>>}
          filename="parts"
          sheetName="Parts"
          columns={[
            { key: "code", header: "Code" },
            { key: "name", header: "Name" },
            { key: "part_type_label", header: "Type" },
            { key: "uom", header: "UOM" },
            { key: "vendor_name", header: "Vendor" },
            { key: "default_unit_cost_cents", header: "Default Cost", format: "currency_cents" },
            { key: "is_size_scaled", header: "Size-scaled" },
            { key: "notes", header: "Notes" },
            { key: "is_active", header: "Active" },
            { key: "created_at", header: "Created", format: "datetime" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>Error: {err}</div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            No parts found. Add one with &quot;+ Add part&quot; — or check &quot;Show inactive&quot;.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 56 }}></th>
                <th style={th}>Code</th>
                <th style={th}>Name</th>
                <th style={th}>Type</th>
                <th style={th}>UOM</th>
                <th style={th}>Default Vendor</th>
                <th style={{ ...th, textAlign: "right" }}>Default Cost</th>
                <th style={th}>Active</th>
                <th style={{ ...th, width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <ScrollHighlightRow key={s.id} rowId={s.id} highlightedRowId={highlightedId} {...getRowProps(s)} style={!s.is_active ? { opacity: 0.5 } : undefined}>
                  <td style={{ ...td, padding: 4 }}><PartThumb partId={s.id} url={thumbs.get(s.id) ?? null} label={s.code} size={40} /></td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>{s.code}</td>
                  <td style={td}>{s.name}</td>
                  <td style={{ ...td, color: C.textSub }}>{partTypeLabel(s.part_type)}</td>
                  <td style={{ ...td, color: C.textSub }}>{s.uom}</td>
                  <td style={{ ...td, color: C.textSub }}>{vendorName(s.default_vendor_id)}</td>
                  <td style={{ ...td, textAlign: "right" }}>{fmtMoney(s.default_unit_cost_cents)}</td>
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

      {addOpen && (
        <PartFormModal mode="add" vendors={vendors} fabricCodes={fabricCodes} partTypes={partTypes} onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load(); }} />
      )}
      {editing && (
        <PartFormModal mode="edit" part={editing} vendors={vendors} fabricCodes={fabricCodes} partTypes={partTypes} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />
      )}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  part?: Part;
  vendors: Vendor[];
  fabricCodes: FabricCode[];
  partTypes: PartTypeRow[];
  onClose: () => void;
  onSaved: () => void;
}

function PartFormModal({ mode, part, vendors, fabricCodes, partTypes, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    name:            part?.name ?? "",
    part_type:       part?.part_type ?? "generic",
    uom:             part?.uom ?? "each",
    default_vendor_id: part?.default_vendor_id ?? "",
    default_unit_cost: part?.default_unit_cost_cents != null ? (part.default_unit_cost_cents / 100).toString() : "",
    is_size_scaled:  part?.is_size_scaled ?? false,
    fabric_code_id:  part?.fabric_code_id ?? "",
    notes:           part?.notes ?? "",
    sort_order:      part?.sort_order != null ? String(part.sort_order) : "0",
    is_active:       part?.is_active ?? true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const vendorOptions: SearchableSelectOption[] = useMemo(
    () => [{ value: "", label: "— none —" }, ...vendors.map((v) => ({ value: v.id, label: v.name }))],
    [vendors],
  );
  const fabricOptions: SearchableSelectOption[] = useMemo(
    () => [{ value: "", label: "— none —" }, ...fabricCodes.map((f) => ({ value: f.id, label: `${f.code}${f.name ? ` — ${f.name}` : ""}` }))],
    [fabricCodes],
  );
  const partTypeOptions: SearchableSelectOption[] = useMemo(() => {
    const opts = partTypes.map((t) => ({ value: t.code, label: t.name }));
    // Ensure the part's current value is selectable even if the master hasn't loaded / it's retired.
    if (part?.part_type && !opts.some((o) => o.value === part.part_type)) {
      opts.unshift({ value: part.part_type, label: PART_TYPE_LABEL[part.part_type] ?? part.part_type });
    }
    return opts;
  }, [partTypes, part]);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const url = mode === "add" ? "/api/internal/part-master" : `/api/internal/part-master/${part!.id}`;
      const method = mode === "add" ? "POST" : "PATCH";
      const costStr = form.default_unit_cost.trim();
      const body = {
        name:            form.name.trim(),
        part_type:       form.part_type,
        uom:             form.uom.trim() || "each",
        default_vendor_id: form.default_vendor_id || null,
        default_unit_cost_cents: costStr === "" ? null : Math.round(parseFloat(costStr) * 100),
        is_size_scaled:  form.is_size_scaled,
        fabric_code_id:  form.part_type === "fabric" ? (form.fabric_code_id || null) : null,
        notes:           form.notes.trim() || null,
        sort_order:      form.sort_order.trim() === "" ? 0 : parseInt(form.sort_order, 10),
        is_active:       form.is_active,
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
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(620px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{mode === "add" ? "Add part" : `Edit ${part!.code}`}</h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Code">
            <div style={readonlyCodeStyle}>
              {mode === "add" ? <span style={{ color: C.textMuted, fontStyle: "italic", fontFamily: "inherit" }}>(auto-generated on save)</span> : (part?.code || "—")}
            </div>
          </Field>
          <Field label="Name *">
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} placeholder="e.g. Blank Tee 5000 White" autoFocus />
          </Field>
          <Field label="Part type">
            <SearchableSelect value={form.part_type} onChange={(v) => setForm({ ...form, part_type: v })} options={partTypeOptions} placeholder="Pick a type…" />
          </Field>
          <Field label="Unit of measure">
            <input type="text" value={form.uom} onChange={(e) => setForm({ ...form, uom: e.target.value })} style={inputStyle} placeholder="each" />
          </Field>
          <Field label="Default vendor">
            <SearchableSelect value={form.default_vendor_id} onChange={(v) => setForm({ ...form, default_vendor_id: v })} options={vendorOptions} placeholder="— none —" />
          </Field>
          <Field label="Default unit cost ($)">
            <input type="number" min="0" step="0.01" value={form.default_unit_cost} onChange={(e) => setForm({ ...form, default_unit_cost: e.target.value })} style={inputStyle} placeholder="0.00" />
          </Field>
          {form.part_type === "fabric" && (
            <Field label="Fabric code">
              <SearchableSelect value={form.fabric_code_id} onChange={(v) => setForm({ ...form, fabric_code_id: v })} options={fabricOptions} placeholder="— none —" />
            </Field>
          )}
          <Field label="Size-scaled">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input type="checkbox" checked={form.is_size_scaled} onChange={(e) => setForm({ ...form, is_size_scaled: e.target.checked })} />
              tracked per size (e.g. blank tees)
            </label>
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
          <div style={{ gridColumn: "1 / -1" }}>
            <Field label="Notes">
              <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={{ ...inputStyle, minHeight: 64, resize: "vertical" }} placeholder="Any notes about this part…" />
            </Field>
          </div>
        </div>

        {mode === "edit" && part && (
          <div style={{ marginTop: 16, borderTop: `1px solid ${C.cardBdr}`, paddingTop: 16 }}>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Images</div>
            <PartImagesManager partId={part.id} partLabel={part.code} />
          </div>
        )}

        {mode === "edit" && part && (
          <div style={{ marginTop: 16, borderTop: `1px solid ${C.cardBdr}`, paddingTop: 16 }}>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Attachments</div>
            <DocumentAttachmentList contextTable="part_master" contextId={part.id} kinds={["spec", "coa", "invoice", "other"]} />
          </div>
        )}

        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>{err}</div>}

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

// Upload / list / delete / set-primary for a part's images. Backed by
// /api/internal/parts/:part_id/images (+ /:image_id for PATCH/DELETE). Reuses
// the same Sharp pipeline + pim-images bucket as the PIM style images.
type PartImage = {
  id: string; is_primary: boolean; sort_order: number; alt_text: string | null;
  signed_urls?: { thumb: string | null; web: string | null; print: string | null };
};
function PartImagesManager({ partId, partLabel }: { partId: string; partLabel: string }) {
  const [images, setImages] = useState<PartImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [imgErr, setImgErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch(`/api/internal/parts/${partId}/images`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setImages(await r.json() as PartImage[]);
      setImgErr(null);
    } catch (e: unknown) {
      setImgErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [partId]);

  async function upload(file: File) {
    setUploading(true); setImgErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`/api/internal/parts/${partId}/images`, { method: "POST", body: fd });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify("Image uploaded.", "success");
      await load();
    } catch (e: unknown) {
      notify(`Upload failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setUploading(false);
    }
  }

  async function setPrimary(id: string) {
    try {
      const r = await fetch(`/api/internal/parts/${partId}/images/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_primary: true }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      notify(`Could not set primary: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  async function remove(id: string) {
    if (!(await confirmDialog("Delete this image? This can't be undone."))) return;
    try {
      const r = await fetch(`/api/internal/parts/${partId}/images/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        {loading ? (
          <span style={{ color: C.textMuted, fontSize: 12 }}>Loading images…</span>
        ) : images.length === 0 ? (
          <span style={{ color: C.textMuted, fontSize: 12 }}>No images yet. Upload one below.</span>
        ) : images.map((img) => {
          const url = img.signed_urls?.thumb || img.signed_urls?.web || null;
          const full = img.signed_urls?.print || img.signed_urls?.web || url;
          return (
            <div key={img.id} style={{ width: 92, border: `1px solid ${img.is_primary ? C.primary : C.cardBdr}`, borderRadius: 6, padding: 4, background: "#0b1220" }}>
              {url ? (
                <img src={url} alt={img.alt_text || partLabel} title="Open full image"
                  onClick={() => full && window.open(full, "_blank", "noopener,noreferrer")}
                  style={{ width: 84, height: 84, objectFit: "cover", borderRadius: 4, cursor: "pointer", display: "block" }} />
              ) : (
                <div style={{ width: 84, height: 84, background: "#1E293B", borderRadius: 4 }} />
              )}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                {img.is_primary ? (
                  <span style={{ fontSize: 10, color: C.primary }}>★ primary</span>
                ) : (
                  <button type="button" onClick={() => void setPrimary(img.id)} style={{ background: "none", border: 0, color: C.textMuted, cursor: "pointer", fontSize: 10, padding: 0 }} title="Make primary">☆ set</button>
                )}
                <button type="button" onClick={() => void remove(img.id)} style={{ background: "none", border: 0, color: C.danger, cursor: "pointer", fontSize: 12, padding: 0 }} title="Delete image">✕</button>
              </div>
            </div>
          );
        })}
      </div>
      <label style={{ ...btnSecondary, display: "inline-block", cursor: uploading ? "wait" : "pointer", opacity: uploading ? 0.6 : 1 }}>
        {uploading ? "Uploading…" : "+ Upload image"}
        <input type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }}
          style={{ display: "none" }} />
      </label>
      {imgErr && <div style={{ background: "#7f1d1d", color: "white", padding: "6px 10px", borderRadius: 6, marginTop: 8, fontSize: 12 }}>{imgErr}</div>}
    </div>
  );
}
