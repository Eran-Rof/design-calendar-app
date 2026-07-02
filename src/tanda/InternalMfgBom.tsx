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
import QuickAddStyleModal from "./components/QuickAddStyleModal";
import { getCachedAuthUserId } from "../utils/tangerineAuthUser";

type ItemLite = { id: string; sku_code: string; style_code: string | null; description: string | null; color?: string | null; size?: string | null };
type PartLite = { id: string; code: string; name: string; default_unit_cost_cents?: number | null };
type ServiceLite = { id: string; code: string; name: string; default_charge_cents?: number | null };
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
  unit_cost_cents?: number | null;          // service override (persisted)
  resolved_unit_cost_cents?: number | null; // server-computed unit cost (read)
  component_code?: string | null;
  component_label?: string | null;
};

function fmtMoney(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

type Bom = {
  id: string;
  finished_item_id: string;
  finished_style_id?: string | null;
  customer_id?: string | null;
  customer_name?: string | null;
  version: number;
  status: "draft" | "active" | "archived";
  default_conversion_vendor_id: string | null;
  notes: string | null;
  finished_item?: { sku_code: string; style_code: string | null; description: string | null } | null;
  finished_style?: { style_code: string | null; style_name: string | null } | null;
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
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
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

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No BOMs yet. Create one with &quot;+ New BOM&quot;.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Finished Style</th>
                <th style={th}>Name</th>
                <th style={th}>Customer</th>
                <th style={{ ...th, textAlign: "right" }}>Version</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: "right" }}>Components</th>
                <th style={{ ...th, width: 150 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} style={{ cursor: "pointer" }} onClick={() => setEditing(b)}>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>{b.finished_style?.style_code ?? b.finished_item?.style_code ?? b.finished_item?.sku_code ?? "—"}</td>
                  <td style={{ ...td, color: C.textSub }}>{b.finished_style?.style_name ?? b.finished_item?.description ?? "—"}</td>
                  <td style={{ ...td, color: C.textSub }}>{b.customer_name ?? <span style={{ color: C.textMuted }}>generic</span>}</td>
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

// Item G — pick a BASE STYLE (style_master) as the BOM's finished good.
type StyleLite = { id: string; style_code: string; style_name: string | null; description?: string | null };
function StylePicker({ valueLabel, onChange }: { valueLabel: string; onChange: (styleId: string, label: string, styleCode: string) => void }) {
  const [q, setQ] = useState(""); const [open, setOpen] = useState(false); const [results, setResults] = useState<StyleLite[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!open) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try { const r = await fetch(`/api/internal/style-master?q=${encodeURIComponent(q)}&limit=25`); if (r.ok) { const j = await r.json(); setResults((Array.isArray(j) ? j : (j.rows || j.data || [])) as StyleLite[]); } } catch { /* */ }
    }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q, open]);
  return (
    <div style={{ position: "relative" }}>
      <input style={inputStyle} placeholder="Search the style to build…" value={open ? q : (valueLabel || "")}
        onFocus={() => { setOpen(true); setQ(""); }} onChange={(e) => setQ(e.target.value)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && results.length > 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 30, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 6, maxHeight: 220, overflowY: "auto", marginTop: 2 }}>
          {results.map((s) => { const name = s.style_name || s.description || ""; return (
            <div key={s.id} onMouseDown={() => { onChange(s.id, `${s.style_code}${name ? ` — ${name}` : ""}`, s.style_code); setOpen(false); }} style={{ padding: "6px 10px", cursor: "pointer", fontSize: 13, borderBottom: `1px solid ${C.cardBdr}` }}>
              <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>{s.style_code}</span>{name ? <span style={{ color: C.textSub }}> — {name}</span> : null}
            </div>
          ); })}
        </div>
      )}
    </div>
  );
}

// Optional customer for a private-label BOM. Searches the customer master.
type CustPick = { id: string; name: string; code?: string | null };
function CustomerPicker({ valueLabel, onChange }: { valueLabel: string; onChange: (cust: CustPick | null) => void }) {
  const [q, setQ] = useState(""); const [open, setOpen] = useState(false); const [results, setResults] = useState<CustPick[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!open) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try { const r = await fetch(`/api/internal/customer-master?q=${encodeURIComponent(q)}&limit=25`); if (r.ok) { const j = await r.json(); setResults((Array.isArray(j) ? j : (j.rows || j.data || [])) as CustPick[]); } } catch { /* */ }
    }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q, open]);
  return (
    <div style={{ position: "relative" }}>
      <input style={inputStyle} placeholder="— generic (no customer) —" value={open ? q : (valueLabel || "")}
        onFocus={() => { setOpen(true); setQ(""); }} onChange={(e) => setQ(e.target.value)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {valueLabel && !open && <button type="button" onMouseDown={() => onChange(null)} title="Clear customer" style={{ position: "absolute", right: 6, top: 6, background: "none", border: 0, color: C.textMuted, cursor: "pointer", fontSize: 13 }}>✕</button>}
      {open && results.length > 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 30, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 6, maxHeight: 220, overflowY: "auto", marginTop: 2 }}>
          {results.map((c) => (
            <div key={c.id} onMouseDown={() => { onChange(c); setOpen(false); }} style={{ padding: "6px 10px", cursor: "pointer", fontSize: 13, borderBottom: `1px solid ${C.cardBdr}` }}>
              {c.name}{c.code ? <span style={{ color: C.textMuted, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 11 }}> · {c.code}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BomEditor({ bomId, onClose, onSaved }: { bomId: string | null; onClose: () => void; onSaved: () => void }) {
  const [parts, setParts] = useState<PartLite[]>([]);
  const [services, setServices] = useState<ServiceLite[]>([]);
  const [vendors, setVendors] = useState<VendorLite[]>([]);
  const [finishedStyleId, setFinishedStyleId] = useState("");
  const [finishedStyleLabel, setFinishedStyleLabel] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [customerLabel, setCustomerLabel] = useState("");
  const [addStyleOpen, setAddStyleOpen] = useState(false);
  const isAdmin = !!getCachedAuthUserId();
  const [version, setVersion] = useState("1");
  const [status, setStatus] = useState<"draft" | "active" | "archived">("draft");
  const [vendorId, setVendorId] = useState("");
  const [notes, setNotes] = useState("");
  const [components, setComponents] = useState<Component[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!bomId);
  const [partTypes, setPartTypes] = useState<{ code: string; name: string }[]>([]);
  const [accounts, setAccounts] = useState<{ id: string; code: string; name: string; is_postable: boolean }[]>([]);
  const [addPartOpen, setAddPartOpen] = useState<number | null>(null);   // row index awaiting the new part
  const [addSvcOpen, setAddSvcOpen] = useState<number | null>(null);     // row index awaiting the new service

  async function reloadParts(): Promise<PartLite[]> {
    try { const r = await fetch(`/api/internal/part-master?include_inactive=false`); if (r.ok) { const d = await r.json() as PartLite[]; setParts(d); return d; } } catch { /* */ }
    return parts;
  }
  async function reloadServices(): Promise<ServiceLite[]> {
    try { const r = await fetch(`/api/internal/service-items?include_inactive=false`); if (r.ok) { const d = await r.json() as ServiceLite[]; setServices(d); return d; } } catch { /* */ }
    return services;
  }

  useEffect(() => {
    (async () => {
      try {
        const [pr, sr, vr, tr, ar] = await Promise.all([
          fetch(`/api/internal/part-master?include_inactive=false`),
          fetch(`/api/internal/service-items?include_inactive=false`),
          fetch(`/api/internal/vendor-master?limit=5000`),
          fetch(`/api/internal/part-types`),
          fetch(`/api/internal/gl-accounts?limit=1000`),
        ]);
        if (pr.ok) setParts(await pr.json() as PartLite[]);
        if (sr.ok) setServices(await sr.json() as ServiceLite[]);
        if (vr.ok) setVendors(await vr.json() as VendorLite[]);
        if (tr.ok) { const d = await tr.json(); if (Array.isArray(d)) setPartTypes(d); }
        if (ar.ok) { const d = await ar.json(); if (Array.isArray(d)) setAccounts(d); }
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
        setFinishedStyleId(b.finished_style_id || "");
        setFinishedStyleLabel(b.finished_style ? `${b.finished_style.style_code}${b.finished_style.style_name ? ` — ${b.finished_style.style_name}` : ""}` : (b.finished_item ? `${b.finished_item.style_code || b.finished_item.sku_code}` : ""));
        setCustomerId(b.customer_id || "");
        setCustomerLabel(b.customer_name || "");
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
  const partCostById = useMemo(() => new Map(parts.map((p) => [p.id, p.default_unit_cost_cents ?? null])), [parts]);
  const svcCostById = useMemo(() => new Map(services.map((s) => [s.id, s.default_charge_cents ?? null])), [services]);

  // Unit cost per row: part -> master default; service -> override ?? master
  // charge; finished_style -> server-resolved avg cost (present on loaded rows).
  function unitCostOf(c: Component): number | null {
    if (c.component_kind === "part") return c.part_id ? (partCostById.get(c.part_id) ?? null) : null;
    if (c.component_kind === "service") {
      if (c.unit_cost_cents != null) return c.unit_cost_cents;
      return c.service_item_id ? (svcCostById.get(c.service_item_id) ?? null) : null;
    }
    return c.resolved_unit_cost_cents ?? null; // finished_style
  }
  function extCostOf(c: Component): number | null {
    const u = unitCostOf(c);
    if (u == null) return null;
    return Math.round(u * (Number(c.qty_per_unit) || 0));
  }
  const bomTotalCents = useMemo(
    () => components.reduce((sum, c) => sum + (extCostOf(c) ?? 0), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [components, partCostById, svcCostById],
  );

  function addComponent() {
    setComponents((cs) => [...cs, { component_kind: "part", part_id: null, service_item_id: null, component_item_id: null, qty_per_unit: 1, scrap_pct: 0, cost_source: "fifo" }]);
  }
  function updateComponent(i: number, patch: Partial<Component>) {
    setComponents((cs) => cs.map((c, ix) => (ix === i ? { ...c, ...patch } : c)));
  }
  function removeComponent(i: number) {
    setComponents((cs) => cs.filter((_, ix) => ix !== i));
  }

  // Item #7 — a finished_style component is picked as a BASE STYLE, but the row
  // still needs an ip_item_master id. Resolve a representative SKU for the style
  // (first item whose style_code matches) and stamp it + its avg cost.
  async function resolveStyleSku(i: number, styleCode: string, styleLabel: string) {
    try {
      const r = await fetch(`/api/internal/items?q=${encodeURIComponent(styleCode)}&limit=25`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const items = (await r.json()) as ItemLite[];
      const rep = items.find((it) => (it.style_code || "").toUpperCase() === styleCode.toUpperCase()) || items[0];
      if (!rep) { notify(`No SKU found for style ${styleCode} — add one first.`, "error"); return; }
      // Unit cost (ip_item_avg_cost) is resolved authoritatively server-side and
      // returned on the next load; a freshly-picked style shows "—" until saved.
      updateComponent(i, { component_item_id: rep.id, component_code: rep.sku_code, component_label: styleLabel.includes(" — ") ? styleLabel.split(" — ").slice(1).join(" — ") : (rep.description || ""), resolved_unit_cost_cents: null });
    } catch (e: unknown) {
      notify(`Could not resolve a SKU for ${styleCode}: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  async function submit() {
    setErr(null);
    if (!finishedStyleId) { setErr("Pick a finished style"); return; }
    // Validate each component has its ref (before any prompt).
    for (const c of components) {
      const ref = c.component_kind === "part" ? c.part_id : c.component_kind === "service" ? c.service_item_id : c.component_item_id;
      if (!ref) { setErr("Every component needs an item selected"); return; }
    }

    // Item #2 — offer to activate a draft on save. Skip when already
    // active/archived (the user explicitly chose that status via the picker).
    let saveStatus: "draft" | "active" | "archived" = status;
    if (status === "draft") {
      const activate = await confirmDialog("Set this BOM Active now? (OK = active, Cancel = keep draft)");
      saveStatus = activate ? "active" : "draft";
    }

    setSubmitting(true);
    try {
      const payloadComponents = components.map((c) => ({
        component_kind: c.component_kind,
        part_id: c.component_kind === "part" ? c.part_id : null,
        service_item_id: c.component_kind === "service" ? c.service_item_id : null,
        component_item_id: c.component_kind === "finished_style" ? c.component_item_id : null,
        qty_per_unit: c.qty_per_unit,
        scrap_pct: c.scrap_pct,
        cost_source: c.cost_source,
        // Persist only the service override; other kinds derive their cost.
        unit_cost_cents: c.component_kind === "service" ? (c.unit_cost_cents ?? null) : null,
      }));
      const body = {
        finished_style_id: finishedStyleId,
        customer_id: customerId || null,
        version: parseInt(version, 10) || 1,
        status: saveStatus,
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
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 0, width: "min(1040px, 96vw)", maxHeight: "90vh", display: "flex", flexDirection: "column", color: C.text }}>
        <div style={{ padding: "18px 20px 0" }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{bomId ? "Edit BOM" : "New BOM"}</h3>
        </div>

        <div style={{ padding: "0 20px", overflowY: "auto", flex: 1 }}>
          {loading ? <div style={{ padding: 20, color: C.textMuted }}>Loading…</div> : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
                <div>
                  <Lbl>Finished style *</Lbl>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <StylePicker valueLabel={finishedStyleLabel} onChange={(id, label) => { setFinishedStyleId(id); setFinishedStyleLabel(label); }} />
                    </div>
                    {/* Item F — add a style on the fly (admins only). */}
                    <button type="button" style={{ ...btnSecondary, whiteSpace: "nowrap" }}
                      onClick={() => { if (!isAdmin) { notify("Only admins can add styles. Ask an admin, or pick an existing style.", "error"); return; } setAddStyleOpen(true); }}
                      title="Add a new style without leaving the BOM">+ New style</button>
                  </div>
                </div>
                <div><Lbl>Version</Lbl><input type="number" min="1" step="1" value={version} onChange={(e) => setVersion(e.target.value)} style={inputStyle} /></div>
                <div>
                  <Lbl>Status</Lbl>
                  <SearchableSelect value={status} onChange={(v) => setStatus(v as "draft" | "active" | "archived")} options={[{ value: "draft", label: "draft" }, { value: "active", label: "active" }, { value: "archived", label: "archived" }]} />
                </div>
                <div>
                  <Lbl>Customer (optional — private-label BOM)</Lbl>
                  <CustomerPicker valueLabel={customerLabel} onChange={(c) => { setCustomerId(c?.id || ""); setCustomerLabel(c ? `${c.name}${c.code ? ` (${c.code})` : ""}` : ""); }} />
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
                <div style={{ overflowX: "auto", marginBottom: 12 }}>
                <table style={{ width: "100%", minWidth: 940, borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, width: 130 }}>Kind</th>
                      <th style={{ ...th, minWidth: 260 }}>Item</th>
                      <th style={{ ...th, width: 80, textAlign: "right" }}>Qty/unit</th>
                      <th style={{ ...th, width: 70, textAlign: "right" }}>Scrap %</th>
                      <th style={{ ...th, width: 110, textAlign: "right" }}>Unit cost</th>
                      <th style={{ ...th, width: 100, textAlign: "right" }}>Ext. cost</th>
                      <th style={{ ...th, width: 100 }}>Cost src</th>
                      <th style={{ ...th, width: 40 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {components.map((c, i) => (
                      <tr key={i}>
                        <td style={td}>
                          <SearchableSelect value={c.component_kind} onChange={(v) => updateComponent(i, { component_kind: v as Component["component_kind"], part_id: null, service_item_id: null, component_item_id: null, unit_cost_cents: null, resolved_unit_cost_cents: null, component_code: null, component_label: null })} options={[{ value: "part", label: "Part" }, { value: "service", label: "Service" }, { value: "finished_style", label: "Finished style" }]} />
                        </td>
                        <td style={td}>
                          {c.component_kind === "part" && (
                            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <SearchableSelect value={c.part_id} onChange={(v) => updateComponent(i, { part_id: v })} options={partOptions} placeholder="Pick a part…" />
                              </div>
                              <button type="button" style={{ ...btnSecondary, whiteSpace: "nowrap", padding: "6px 8px" }} title="Create a new part without leaving the BOM"
                                onClick={() => { if (!isAdmin) { notify("Only admins can add parts. Ask an admin, or pick an existing part.", "error"); return; } setAddPartOpen(i); }}>+ New</button>
                            </div>
                          )}
                          {c.component_kind === "service" && (
                            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <SearchableSelect value={c.service_item_id} onChange={(v) => updateComponent(i, { service_item_id: v })} options={svcOptions} placeholder="Pick a service…" />
                              </div>
                              <button type="button" style={{ ...btnSecondary, whiteSpace: "nowrap", padding: "6px 8px" }} title="Create a new service without leaving the BOM"
                                onClick={() => { if (!isAdmin) { notify("Only admins can add services. Ask an admin, or pick an existing service.", "error"); return; } setAddSvcOpen(i); }}>+ New</button>
                            </div>
                          )}
                          {c.component_kind === "finished_style" && (
                            <StylePicker valueLabel={c.component_code ? `${c.component_code}${c.component_label ? ` — ${c.component_label}` : ""}` : ""} onChange={(_styleId, label, styleCode) => { void resolveStyleSku(i, styleCode, label); }} />
                          )}
                        </td>
                        <td style={td}><input type="number" min="0" step="0.0001" value={c.qty_per_unit} onChange={(e) => updateComponent(i, { qty_per_unit: parseFloat(e.target.value) || 0 })} style={{ ...inputStyle, textAlign: "right" }} /></td>
                        <td style={td}><input type="number" min="0" max="99" step="0.1" value={c.scrap_pct} onChange={(e) => updateComponent(i, { scrap_pct: parseFloat(e.target.value) || 0 })} style={{ ...inputStyle, textAlign: "right" }} /></td>
                        <td style={{ ...td, textAlign: "right" }}>
                          {c.component_kind === "service" ? (
                            <input type="number" min="0" step="0.01"
                              value={(() => { const u = unitCostOf(c); return u == null ? "" : (u / 100).toString(); })()}
                              onChange={(e) => { const v = e.target.value.trim(); updateComponent(i, { unit_cost_cents: v === "" ? null : Math.round(parseFloat(v) * 100) }); }}
                              placeholder={c.service_item_id && svcCostById.get(c.service_item_id) != null ? (svcCostById.get(c.service_item_id)! / 100).toFixed(2) : "0.00"}
                              style={{ ...inputStyle, textAlign: "right" }} />
                          ) : (
                            <span style={{ color: unitCostOf(c) == null ? C.textMuted : C.text }}>{fmtMoney(unitCostOf(c))}</span>
                          )}
                        </td>
                        <td style={{ ...td, textAlign: "right", color: extCostOf(c) == null ? C.textMuted : C.text }}>{fmtMoney(extCostOf(c))}</td>
                        <td style={td}>
                          <SearchableSelect value={c.cost_source} onChange={(v) => updateComponent(i, { cost_source: v as "fifo" | "default" })} options={[{ value: "fifo", label: "Actual (FIFO)" }, { value: "default", label: "Default" }]} />
                        </td>
                        <td style={{ ...td, textAlign: "center" }}><button onClick={() => removeComponent(i)} style={{ ...btnDanger, padding: "4px 8px" }}>✕</button></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td style={{ ...td, fontWeight: 700 }} colSpan={5}>BOM total</td>
                      <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{fmtMoney(bomTotalCents)}</td>
                      <td style={td} colSpan={2}></td>
                    </tr>
                  </tfoot>
                </table>
                </div>
              )}

              {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 12 }}>{err}</div>}
            </>
          )}
        </div>

        {/* Frozen footer */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: 16, borderTop: `1px solid ${C.cardBdr}`, background: C.card }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting || loading || !finishedStyleId}>
            {submitting ? "Saving…" : "Save BOM"}
          </button>
        </div>
      </div>
      {addStyleOpen && (
        <QuickAddStyleModal
          onClose={() => setAddStyleOpen(false)}
          onCreated={(_skuId, label, styleId) => { if (styleId) { setFinishedStyleId(styleId); setFinishedStyleLabel(label); } setAddStyleOpen(false); notify(`Style added — "${label}" selected.`, "success"); }}
        />
      )}
      {addPartOpen !== null && (
        <QuickAddPartModal
          vendors={vendors}
          partTypes={partTypes}
          onClose={() => setAddPartOpen(null)}
          onCreated={async (newId) => {
            const rowIx = addPartOpen; setAddPartOpen(null);
            const list = await reloadParts();
            const created = list.find((p) => p.id === newId);
            if (rowIx !== null) updateComponent(rowIx, { part_id: newId });
            notify(created ? `Part "${created.name}" created and selected.` : "Part created.", "success");
          }}
        />
      )}
      {addSvcOpen !== null && (
        <QuickAddServiceModal
          vendors={vendors}
          accounts={accounts}
          onClose={() => setAddSvcOpen(null)}
          onCreated={async (newId) => {
            const rowIx = addSvcOpen; setAddSvcOpen(null);
            const list = await reloadServices();
            const created = list.find((s) => s.id === newId);
            if (rowIx !== null) updateComponent(rowIx, { service_item_id: newId });
            notify(created ? `Service "${created.name}" created and selected.` : "Service created.", "success");
          }}
        />
      )}
    </div>
  );
}

// ── On-the-fly Part create (item #4). Mirrors the Part Master create form's
// key fields; POSTs /api/internal/part-master and returns the new id.
function QuickAddPartModal({ vendors, partTypes, onClose, onCreated }: {
  vendors: VendorLite[]; partTypes: { code: string; name: string }[];
  onClose: () => void; onCreated: (id: string) => void | Promise<void>;
}) {
  const [form, setForm] = useState({ name: "", part_type: "generic", uom: "each", default_vendor_id: "", default_unit_cost: "", is_size_scaled: false });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const vendorOptions: SearchableSelectOption[] = useMemo(() => [{ value: "", label: "— none —" }, ...vendors.map((v) => ({ value: v.id, label: v.name }))], [vendors]);
  const partTypeOptions: SearchableSelectOption[] = useMemo(() => (partTypes.length ? partTypes.map((t) => ({ value: t.code, label: t.name })) : [{ value: "generic", label: "Generic" }]), [partTypes]);

  async function submit() {
    if (!form.name.trim()) { setErr("Name is required"); return; }
    setSubmitting(true); setErr(null);
    try {
      const costStr = form.default_unit_cost.trim();
      const body = {
        name: form.name.trim(), part_type: form.part_type, uom: form.uom.trim() || "each",
        default_vendor_id: form.default_vendor_id || null,
        default_unit_cost_cents: costStr === "" ? null : Math.round(parseFloat(costStr) * 100),
        is_size_scaled: form.is_size_scaled, is_active: true,
      };
      const r = await fetch(`/api/internal/part-master`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const created = await r.json().catch(() => ({}));
      await onCreated(created.id);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); } finally { setSubmitting(false); }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(520px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>New part</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={{ gridColumn: "1 / -1" }}><Lbl>Name *</Lbl><input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} placeholder="e.g. Blank Tee 5000 White" autoFocus /></div>
          <div><Lbl>Part type</Lbl><SearchableSelect value={form.part_type} onChange={(v) => setForm({ ...form, part_type: v })} options={partTypeOptions} placeholder="Pick a type…" /></div>
          <div><Lbl>Unit of measure</Lbl><input type="text" value={form.uom} onChange={(e) => setForm({ ...form, uom: e.target.value })} style={inputStyle} placeholder="each" /></div>
          <div><Lbl>Default vendor</Lbl><SearchableSelect value={form.default_vendor_id} onChange={(v) => setForm({ ...form, default_vendor_id: v })} options={vendorOptions} placeholder="— none —" /></div>
          <div><Lbl>Default unit cost ($)</Lbl><input type="number" min="0" step="0.01" value={form.default_unit_cost} onChange={(e) => setForm({ ...form, default_unit_cost: e.target.value })} style={inputStyle} placeholder="0.00" /></div>
          <div style={{ gridColumn: "1 / -1" }}><label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}><input type="checkbox" checked={form.is_size_scaled} onChange={(e) => setForm({ ...form, is_size_scaled: e.target.checked })} /> Size-scaled (tracked per size, e.g. blank tees)</label></div>
        </div>
        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting}>{submitting ? "Saving…" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}

// ── On-the-fly Service create (item #4). Mirrors the Service Item Master create
// form's key fields; POSTs /api/internal/service-items and returns the new id.
function QuickAddServiceModal({ vendors, accounts, onClose, onCreated }: {
  vendors: VendorLite[]; accounts: { id: string; code: string; name: string; is_postable: boolean }[];
  onClose: () => void; onCreated: (id: string) => void | Promise<void>;
}) {
  const SERVICE_KINDS = ["print", "sew", "pack", "wash", "conversion", "other"];
  const KIND_LABEL: Record<string, string> = { print: "Print", sew: "Sew", pack: "Pack", wash: "Wash", conversion: "Conversion", other: "Other" };
  const [form, setForm] = useState({ name: "", service_kind: "conversion", is_labor: true, default_vendor_id: "", default_charge: "", default_expense_account_id: "", applied_to_wip: true });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const vendorOptions: SearchableSelectOption[] = useMemo(() => [{ value: "", label: "— none —" }, ...vendors.map((v) => ({ value: v.id, label: v.name }))], [vendors]);
  const acctOptions: SearchableSelectOption[] = useMemo(() => [{ value: "", label: "— none —" }, ...accounts.filter((a) => a.is_postable).map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))], [accounts]);

  async function submit() {
    if (!form.name.trim()) { setErr("Name is required"); return; }
    setSubmitting(true); setErr(null);
    try {
      const chargeStr = form.default_charge.trim();
      const body = {
        name: form.name.trim(), service_kind: form.service_kind, is_labor: form.is_labor,
        default_vendor_id: form.default_vendor_id || null,
        default_charge_cents: chargeStr === "" ? null : Math.round(parseFloat(chargeStr) * 100),
        default_expense_account_id: form.applied_to_wip ? null : (form.default_expense_account_id || null),
        applied_to_wip: form.applied_to_wip, is_active: true,
      };
      const r = await fetch(`/api/internal/service-items`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const created = await r.json().catch(() => ({}));
      await onCreated(created.id);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); } finally { setSubmitting(false); }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(520px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>New service item</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={{ gridColumn: "1 / -1" }}><Lbl>Name *</Lbl><input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} placeholder="e.g. Screen print front + back" autoFocus /></div>
          <div><Lbl>Service kind</Lbl><SearchableSelect value={form.service_kind} onChange={(v) => setForm({ ...form, service_kind: v })} options={SERVICE_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))} placeholder="Pick a kind…" /></div>
          <div><Lbl>Default vendor</Lbl><SearchableSelect value={form.default_vendor_id} onChange={(v) => setForm({ ...form, default_vendor_id: v })} options={vendorOptions} placeholder="— none —" /></div>
          <div><Lbl>Default charge ($/unit)</Lbl><input type="number" min="0" step="0.01" value={form.default_charge} onChange={(e) => setForm({ ...form, default_charge: e.target.value })} style={inputStyle} placeholder="0.00" /></div>
          <div><label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13, marginTop: 22 }}><input type="checkbox" checked={form.is_labor} onChange={(e) => setForm({ ...form, is_labor: e.target.checked })} /> Labor (reporting)</label></div>
          <div><label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13, marginTop: 6 }}><input type="checkbox" checked={form.applied_to_wip} onChange={(e) => setForm({ ...form, applied_to_wip: e.target.checked })} /> Capitalize to WIP</label></div>
          {!form.applied_to_wip && (
            <div style={{ gridColumn: "1 / -1" }}><Lbl>Expense account (when not WIP)</Lbl><SearchableSelect value={form.default_expense_account_id} onChange={(v) => setForm({ ...form, default_expense_account_id: v })} options={acctOptions} placeholder="— none —" /></div>
          )}
        </div>
        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting}>{submitting ? "Saving…" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}

function Lbl({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{children}</div>;
}
