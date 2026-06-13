// src/tanda/InternalMfgBom.tsx
//
// Tangerine — Manufacturing Bill of Materials (BOM).
// A BOM is the recipe for assembling a finished style out of components:
//   • part           — a purchased part_master row (consumed from part inventory)
//   • service        — an outsourced service_item_master charge (CMT/print/sew/pack)
//   • finished_style — an existing finished style consumed into the build
// List + create/edit (header + component matrix) + delete. One active version
// per finished item.

import { useEffect, useMemo, useRef, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SearchableSelect, { type SearchableSelectOption } from "./components/SearchableSelect";

type ItemLite = { id: string; sku_code: string; style_code: string | null; description: string | null; color?: string | null; size?: string | null };
type PartLite = { id: string; code: string; name: string };
type ServiceLite = { id: string; code: string; name: string };
type VendorLite = { id: string; name: string };

type Component = {
  id?: string;
  component_kind: "part" | "service" | "finished_style";
  part_id: string | null;
  service_item_id: string | null;
  component_item_id: string | null;
  qty_per_unit: number;
  scrap_pct: number;
  cost_source: "fifo" | "default";
  component_code?: string | null;
  component_label?: string | null;
};

type Bom = {
  id: string;
  finished_item_id: string;
  version: number;
  status: "draft" | "active" | "archived";
  default_conversion_vendor_id: string | null;
  notes: string | null;
  finished_item?: { sku_code: string; style_code: string | null; description: string | null } | null;
  component_count?: number;
  components?: Component[];
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
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };

const STATUS_COLOR: Record<string, string> = { draft: C.textMuted, active: C.success, archived: C.warn };

export default function InternalMfgBom() {
  const [rows, setRows] = useState<Bom[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Bom | "new" | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/mfg-boms`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as Bom[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function del(b: Bom) {
    const label = b.finished_item?.sku_code || b.finished_item_id.slice(0, 8);
    if (!(await confirmDialog(`Delete BOM for ${label} (v${b.version})? This removes its components.`))) return;
    try {
      const r = await fetch(`/api/internal/mfg-boms/${b.id}`, { method: "DELETE" });
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
          <h2 style={{ margin: 0, fontSize: 22 }}>Bill of Materials</h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: C.textMuted }}>
            Recipes for assembling a finished style from parts, services, and other finished styles. One active version per style.
          </p>
        </div>
        <button onClick={() => setEditing("new")} style={btnPrimary}>+ New BOM</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center" }}>
        <ExportButton
          rows={rows.map((b) => ({
            finished_sku: b.finished_item?.sku_code ?? "", finished_desc: b.finished_item?.description ?? "",
            version: b.version, status: b.status, component_count: b.component_count ?? 0,
          })) as unknown as Array<Record<string, unknown>>}
          filename="boms"
          sheetName="BOMs"
          columns={[
            { key: "finished_sku", header: "Finished SKU" },
            { key: "finished_desc", header: "Description" },
            { key: "version", header: "Version", format: "number" },
            { key: "status", header: "Status" },
            { key: "component_count", header: "Components", format: "number" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>Error: {err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No BOMs yet. Create one with &quot;+ New BOM&quot;.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Finished Style</th>
                <th style={th}>Description</th>
                <th style={{ ...th, textAlign: "right" }}>Version</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: "right" }}>Components</th>
                <th style={{ ...th, width: 150 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} style={{ cursor: "pointer" }} onClick={() => setEditing(b)}>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>{b.finished_item?.sku_code ?? "—"}</td>
                  <td style={{ ...td, color: C.textSub }}>{b.finished_item?.description ?? "—"}</td>
                  <td style={{ ...td, textAlign: "right" }}>v{b.version}</td>
                  <td style={td}><span style={{ color: STATUS_COLOR[b.status] }}>{b.status}</span></td>
                  <td style={{ ...td, textAlign: "right" }}>{b.component_count ?? 0}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={(e) => { e.stopPropagation(); setEditing(b); }} style={btnSecondary}>Edit</button>
                    <button onClick={(e) => { e.stopPropagation(); void del(b); }} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <BomEditor
          bomId={editing === "new" ? null : editing.id}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

// Async item picker — type to search ip_item_master via /api/internal/items?q=.
function ItemPicker({ value, valueLabel, onChange, placeholder }: {
  value: string; valueLabel: string; onChange: (id: string, label: string) => void; placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<ItemLite[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/internal/items?q=${encodeURIComponent(q)}&limit=50`);
        if (r.ok) setResults(await r.json() as ItemLite[]);
      } catch { /* non-fatal */ }
    }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q, open]);

  return (
    <div style={{ position: "relative" }}>
      <input
        style={inputStyle}
        placeholder={placeholder || "Search style / SKU…"}
        value={open ? q : (valueLabel || "")}
        onFocus={() => { setOpen(true); setQ(""); }}
        onChange={(e) => setQ(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && results.length > 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 30, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 6, maxHeight: 220, overflowY: "auto", marginTop: 2 }}>
          {results.map((it) => (
            <div
              key={it.id}
              onMouseDown={() => { onChange(it.id, `${it.sku_code}${it.description ? ` — ${it.description}` : ""}`); setOpen(false); }}
              style={{ padding: "6px 10px", cursor: "pointer", fontSize: 13, borderBottom: `1px solid ${C.cardBdr}` }}
            >
              <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>{it.sku_code}</span>
              {it.description ? <span style={{ color: C.textSub }}> — {it.description}</span> : null}
            </div>
          ))}
        </div>
      )}
      {value && !open && <input type="hidden" value={value} readOnly />}
    </div>
  );
}

function BomEditor({ bomId, onClose, onSaved }: { bomId: string | null; onClose: () => void; onSaved: () => void }) {
  const [parts, setParts] = useState<PartLite[]>([]);
  const [services, setServices] = useState<ServiceLite[]>([]);
  const [vendors, setVendors] = useState<VendorLite[]>([]);
  const [finishedItemId, setFinishedItemId] = useState("");
  const [finishedItemLabel, setFinishedItemLabel] = useState("");
  const [version, setVersion] = useState("1");
  const [status, setStatus] = useState<"draft" | "active" | "archived">("draft");
  const [vendorId, setVendorId] = useState("");
  const [notes, setNotes] = useState("");
  const [components, setComponents] = useState<Component[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!bomId);

  useEffect(() => {
    (async () => {
      try {
        const [pr, sr, vr] = await Promise.all([
          fetch(`/api/internal/part-master?include_inactive=false`),
          fetch(`/api/internal/service-items?include_inactive=false`),
          fetch(`/api/internal/vendor-master?limit=5000`),
        ]);
        if (pr.ok) setParts(await pr.json() as PartLite[]);
        if (sr.ok) setServices(await sr.json() as ServiceLite[]);
        if (vr.ok) setVendors(await vr.json() as VendorLite[]);
      } catch { /* non-fatal */ }
    })();
  }, []);

  useEffect(() => {
    if (!bomId) return;
    (async () => {
      try {
        const r = await fetch(`/api/internal/mfg-boms/${bomId}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        const b = await r.json() as Bom;
        setFinishedItemId(b.finished_item_id);
        setFinishedItemLabel(b.finished_item ? `${b.finished_item.sku_code}${b.finished_item.description ? ` — ${b.finished_item.description}` : ""}` : "");
        setVersion(String(b.version));
        setStatus(b.status);
        setVendorId(b.default_conversion_vendor_id || "");
        setNotes(b.notes || "");
        setComponents((b.components || []).map((c) => ({ ...c })));
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [bomId]);

  const vendorOptions: SearchableSelectOption[] = useMemo(
    () => [{ value: "", label: "— none —" }, ...vendors.map((v) => ({ value: v.id, label: v.name }))],
    [vendors],
  );
  const partOptions: SearchableSelectOption[] = useMemo(() => parts.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` })), [parts]);
  const svcOptions: SearchableSelectOption[] = useMemo(() => services.map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` })), [services]);

  function addComponent() {
    setComponents((cs) => [...cs, { component_kind: "part", part_id: null, service_item_id: null, component_item_id: null, qty_per_unit: 1, scrap_pct: 0, cost_source: "fifo" }]);
  }
  function updateComponent(i: number, patch: Partial<Component>) {
    setComponents((cs) => cs.map((c, ix) => (ix === i ? { ...c, ...patch } : c)));
  }
  function removeComponent(i: number) {
    setComponents((cs) => cs.filter((_, ix) => ix !== i));
  }

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      if (!finishedItemId) throw new Error("Pick a finished style");
      // Validate each component has its ref.
      for (const c of components) {
        const ref = c.component_kind === "part" ? c.part_id : c.component_kind === "service" ? c.service_item_id : c.component_item_id;
        if (!ref) throw new Error("Every component needs an item selected");
      }
      const payloadComponents = components.map((c) => ({
        component_kind: c.component_kind,
        part_id: c.component_kind === "part" ? c.part_id : null,
        service_item_id: c.component_kind === "service" ? c.service_item_id : null,
        component_item_id: c.component_kind === "finished_style" ? c.component_item_id : null,
        qty_per_unit: c.qty_per_unit,
        scrap_pct: c.scrap_pct,
        cost_source: c.cost_source,
      }));
      const body = {
        finished_item_id: finishedItemId,
        version: parseInt(version, 10) || 1,
        status,
        default_conversion_vendor_id: vendorId || null,
        notes: notes.trim() || null,
        components: payloadComponents,
      };
      const url = bomId ? `/api/internal/mfg-boms/${bomId}` : `/api/internal/mfg-boms`;
      const method = bomId ? "PATCH" : "POST";
      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify("BOM saved.", "success");
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 0, width: "min(900px, 96vw)", maxHeight: "90vh", display: "flex", flexDirection: "column", color: C.text }}>
        <div style={{ padding: "18px 20px 0" }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{bomId ? "Edit BOM" : "New BOM"}</h3>
        </div>

        <div style={{ padding: "0 20px", overflowY: "auto", flex: 1 }}>
          {loading ? <div style={{ padding: 20, color: C.textMuted }}>Loading…</div> : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
                <div>
                  <Lbl>Finished style *</Lbl>
                  <ItemPicker value={finishedItemId} valueLabel={finishedItemLabel} onChange={(id, label) => { setFinishedItemId(id); setFinishedItemLabel(label); }} placeholder="Search the style to build…" />
                </div>
                <div><Lbl>Version</Lbl><input type="number" min="1" step="1" value={version} onChange={(e) => setVersion(e.target.value)} style={inputStyle} /></div>
                <div>
                  <Lbl>Status</Lbl>
                  <select value={status} onChange={(e) => setStatus(e.target.value as "draft" | "active" | "archived")} style={inputStyle}>
                    <option value="draft">draft</option>
                    <option value="active">active</option>
                    <option value="archived">archived</option>
                  </select>
                </div>
                <div style={{ gridColumn: "1 / 3" }}>
                  <Lbl>Default conversion vendor (factory)</Lbl>
                  <SearchableSelect value={vendorId} onChange={setVendorId} options={vendorOptions} placeholder="— none —" />
                </div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <Lbl>Notes</Lbl>
                  <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} style={inputStyle} placeholder="Optional" />
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <strong style={{ fontSize: 14 }}>Components</strong>
                <button onClick={addComponent} style={btnSecondary}>+ Add component</button>
              </div>

              {components.length === 0 ? (
                <div style={{ padding: 16, textAlign: "center", color: C.textMuted, border: `1px dashed ${C.cardBdr}`, borderRadius: 8, marginBottom: 12 }}>
                  No components yet. A printed tee = a blank-tee part + a print service. Click &quot;+ Add component&quot;.
                </div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, width: 130 }}>Kind</th>
                      <th style={th}>Item</th>
                      <th style={{ ...th, width: 90, textAlign: "right" }}>Qty/unit</th>
                      <th style={{ ...th, width: 90, textAlign: "right" }}>Scrap %</th>
                      <th style={{ ...th, width: 110 }}>Cost</th>
                      <th style={{ ...th, width: 40 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {components.map((c, i) => (
                      <tr key={i}>
                        <td style={td}>
                          <select value={c.component_kind} onChange={(e) => updateComponent(i, { component_kind: e.target.value as Component["component_kind"], part_id: null, service_item_id: null, component_item_id: null })} style={inputStyle}>
                            <option value="part">Part</option>
                            <option value="service">Service</option>
                            <option value="finished_style">Finished style</option>
                          </select>
                        </td>
                        <td style={td}>
                          {c.component_kind === "part" && (
                            <SearchableSelect value={c.part_id} onChange={(v) => updateComponent(i, { part_id: v })} options={partOptions} placeholder="Pick a part…" />
                          )}
                          {c.component_kind === "service" && (
                            <SearchableSelect value={c.service_item_id} onChange={(v) => updateComponent(i, { service_item_id: v })} options={svcOptions} placeholder="Pick a service…" />
                          )}
                          {c.component_kind === "finished_style" && (
                            <ItemPicker value={c.component_item_id || ""} valueLabel={c.component_code ? `${c.component_code}${c.component_label ? ` — ${c.component_label}` : ""}` : ""} onChange={(id, label) => updateComponent(i, { component_item_id: id, component_code: label.split(" — ")[0], component_label: label })} placeholder="Search consumed style…" />
                          )}
                        </td>
                        <td style={td}><input type="number" min="0" step="0.0001" value={c.qty_per_unit} onChange={(e) => updateComponent(i, { qty_per_unit: parseFloat(e.target.value) || 0 })} style={{ ...inputStyle, textAlign: "right" }} /></td>
                        <td style={td}><input type="number" min="0" max="99" step="0.1" value={c.scrap_pct} onChange={(e) => updateComponent(i, { scrap_pct: parseFloat(e.target.value) || 0 })} style={{ ...inputStyle, textAlign: "right" }} /></td>
                        <td style={td}>
                          <select value={c.cost_source} onChange={(e) => updateComponent(i, { cost_source: e.target.value as "fifo" | "default" })} style={inputStyle}>
                            <option value="fifo">Actual (FIFO)</option>
                            <option value="default">Default</option>
                          </select>
                        </td>
                        <td style={{ ...td, textAlign: "center" }}><button onClick={() => removeComponent(i)} style={{ ...btnDanger, padding: "4px 8px" }}>✕</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 12 }}>{err}</div>}
            </>
          )}
        </div>

        {/* Frozen footer */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: 16, borderTop: `1px solid ${C.cardBdr}`, background: C.card }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting || loading || !finishedItemId}>
            {submitting ? "Saving…" : "Save BOM"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Lbl({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{children}</div>;
}
