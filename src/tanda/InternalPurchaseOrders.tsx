// src/tanda/InternalPurchaseOrders.tsx
//
// P16 / M11 — native Purchase Order entry (origination). List + create/edit
// modal. Mirrors the Sales Order modal (M10): vendor/brand/payment-terms
// pickers, item SearchableSelect lines, plus a matrix line-entry mode (style →
// /api/internal/style-matrix → editable MatrixGrid → resolve-sku per cell).
// PO number is system-assigned on Issue.

import { useEffect, useMemo, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import { EditableSizeMatrix, matrixCellKey } from "../shared/matrix";
import type { EditableMatrixRow } from "../shared/matrix";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { notify } from "../shared/ui/warn";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box" };
const numInputStyle: React.CSSProperties = { ...inputStyle, width: "8ch", textAlign: "right" };
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d", padding: "2px 8px" };

type PO = {
  id: string; po_number: string | null; vendor_id: string; brand_id: string | null;
  order_date: string; expected_date: string | null; status: string; currency: string;
  payment_terms_id: string | null; notes: string | null; subtotal_cents: number | string; total_cents: number | string;
};
type POLine = { key: number; inventory_item_id: string; description: string; qty_ordered: string; unit_cost_dollars: string };
type Vendor = { id: string; name: string; code?: string };
type Item = { id: string; sku_code: string; style_code?: string; description?: string };
type Lookup = { id: string; code?: string; name: string };
type StyleListRow = { id: string; style_code: string; style_name: string | null; description: string | null };
type MatrixPayload = {
  style: { id: string; style_code: string; style_name: string | null };
  sizes: string[]; colors: string[]; inseams: string[];
  skus: Array<{ id: string; color: string | null; size: string | null; inseam: string | null }>;
};

function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0); const neg = n < 0; const abs = Math.abs(n);
  return `${neg ? "-" : ""}$${Math.trunc(abs / 100).toLocaleString()}.${String(Math.round(abs % 100)).padStart(2, "0")}`;
}
const STATUSES = ["draft", "issued", "in_transit", "received", "cancelled"];
const STATUS_COLORS: Record<string, string> = {
  draft: C.textMuted, issued: C.primary, in_transit: C.warn, received: C.success, cancelled: C.danger,
};

export default function InternalPurchaseOrders() {
  const [rows, setRows] = useState<PO[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PO | null>(null);

  const vendorName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const v of vendors) m[v.id] = v.name;
    return m;
  }, [vendors]);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (vendorFilter) params.set("vendor_id", vendorFilter);
      if (search.trim()) params.set("q", search.trim());
      const r = await fetch(`/api/internal/purchase-orders?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as PO[]);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [statusFilter, vendorFilter]);
  useEffect(() => {
    fetch("/api/internal/vendor-master?limit=1000").then((r) => r.json())
      .then((a) => { if (Array.isArray(a)) setVendors(a as Vendor[]); }).catch(() => {});
  }, []);

  const exportRows = useMemo(() => rows.map((po) => ({
    po_number: po.po_number || "(draft)",
    vendor: vendorName[po.vendor_id] || "",
    order_date: po.order_date,
    expected_date: po.expected_date || "",
    status: po.status,
    total: Number(po.total_cents ?? 0) / 100,
  })), [rows, vendorName]);
  const exportColumns: ExportColumn<Record<string, unknown>>[] = [
    { key: "po_number", header: "PO #" },
    { key: "vendor", header: "Vendor" },
    { key: "order_date", header: "Order Date" },
    { key: "expected_date", header: "Expected" },
    { key: "status", header: "Status" },
    { key: "total", header: "Total", format: "number" },
  ];

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>📦 Purchase Orders</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <ExportButton rows={exportRows} filename="purchase-orders" sheetName="Purchase Orders" columns={exportColumns} />
          <button style={btnPrimary} onClick={() => { setEditing(null); setModalOpen(true); }}>+ New purchase order</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ ...inputStyle, width: 180 }}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <div style={{ width: 240 }}>
          <SearchableSelect value={vendorFilter || null} onChange={(v) => setVendorFilter(v)}
            options={[{ value: "", label: "All vendors" }, ...vendors.map((v) => ({ value: v.id, label: v.name, searchHaystack: `${v.name} ${v.code || ""}` }))]}
            placeholder="All vendors" inputStyle={inputStyle} />
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void load(); }} placeholder="Search PO #…" style={{ ...inputStyle, width: 200 }} />
        <button style={btnSecondary} onClick={() => void load()}>Refresh</button>
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={th}>PO #</th><th style={th}>Vendor</th><th style={th}>Order date</th>
            <th style={th}>Expected</th><th style={th}>Status</th><th style={{ ...th, textAlign: "right" }}>Total</th>
          </tr></thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={6}>Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={6}>No purchase orders.</td></tr>}
            {rows.map((po) => (
              <tr key={po.id} style={{ cursor: "pointer" }} onClick={() => { setEditing(po); setModalOpen(true); }}>
                <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{po.po_number || <span style={{ color: C.textMuted }}>(draft)</span>}</td>
                <td style={td}>{vendorName[po.vendor_id] || "—"}</td>
                <td style={td}>{po.order_date}</td>
                <td style={td}>{po.expected_date || "—"}</td>
                <td style={td}><span style={{ color: STATUS_COLORS[po.status] || C.text, fontWeight: 600 }}>● {po.status}</span></td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(po.total_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <POModal
          po={editing}
          vendors={vendors}
          onClose={() => { setModalOpen(false); setEditing(null); }}
          onSaved={() => { setModalOpen(false); setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

function POModal({ po, vendors, onClose, onSaved }: { po: PO | null; vendors: Vendor[]; onClose: () => void; onSaved: () => void }) {
  const isNew = po === null;
  const editable = isNew || po?.status === "draft";

  const [vendorId, setVendorId] = useState(po?.vendor_id || "");
  const [brandId, setBrandId] = useState(po?.brand_id || "");
  const [orderDate, setOrderDate] = useState(po?.order_date || new Date().toISOString().slice(0, 10));
  const [expectedDate, setExpectedDate] = useState(po?.expected_date || "");
  const [paymentTermsId, setPaymentTermsId] = useState(po?.payment_terms_id || "");
  const [notes, setNotes] = useState(po?.notes || "");
  const [lines, setLines] = useState<POLine[]>([{ key: 1, inventory_item_id: "", description: "", qty_ordered: "", unit_cost_dollars: "" }]);

  const [items, setItems] = useState<Item[]>([]);
  const [brands, setBrands] = useState<Lookup[]>([]);
  const [paymentTerms, setPaymentTerms] = useState<Lookup[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/internal/items?limit=500").then((r) => r.ok ? r.json() : []).then((a) => setItems(Array.isArray(a) ? a : [])).catch(() => {});
    fetch("/api/internal/brands").then((r) => r.json()).then((d) => setBrands(Array.isArray(d.brands) ? d.brands : [])).catch(() => {});
    fetch("/api/internal/payment-terms?limit=200").then((r) => r.json()).then((a) => setPaymentTerms(Array.isArray(a) ? a : [])).catch(() => {});
  }, []);

  // Load existing PO lines when editing.
  useEffect(() => {
    if (isNew || !po) return;
    fetch(`/api/internal/purchase-orders/${po.id}`).then((r) => r.ok ? r.json() : null).then((full) => {
      if (!full?.lines) return;
      setLines(full.lines.map((l: { inventory_item_id: string | null; description: string | null; qty_ordered: number; unit_cost_cents: number }, i: number) => ({
        key: i + 1, inventory_item_id: l.inventory_item_id || "", description: l.description || "",
        qty_ordered: String(l.qty_ordered ?? ""), unit_cost_dollars: l.unit_cost_cents != null ? (l.unit_cost_cents / 100).toFixed(2) : "",
      })));
    }).catch(() => {});
  }, [isNew, po]);

  function updateLine(idx: number, patch: Partial<POLine>) { setLines((p) => p.map((l, i) => i === idx ? { ...l, ...patch } : l)); }
  function addLine() { setLines((p) => [...p, { key: (p[p.length - 1]?.key ?? 0) + 1, inventory_item_id: "", description: "", qty_ordered: "", unit_cost_dollars: "" }]); }
  function removeLine(idx: number) { setLines((p) => p.filter((_, i) => i !== idx)); }

  // Auto-append a fresh row once the last row has a Style + qty>0.
  useEffect(() => {
    if (!editable) return;
    setLines((p) => {
      const last = p[p.length - 1];
      if (last && last.inventory_item_id && Number(last.qty_ordered) > 0) {
        return [...p, { key: (last.key ?? 0) + 1, inventory_item_id: "", description: "", qty_ordered: "", unit_cost_dollars: "" }];
      }
      return p;
    });
  }, [lines, editable]);

  const totalCents = useMemo(() => lines.reduce((s, l) => {
    const qty = Number(l.qty_ordered) || 0; const unit = Math.round((Number(l.unit_cost_dollars) || 0) * 100);
    return s + Math.round(qty * unit);
  }, 0), [lines]);

  function apiLines() {
    return lines
      .filter((l) => Number(l.qty_ordered) > 0)
      .map((l) => ({
        inventory_item_id: l.inventory_item_id || null,
        description: l.description.trim() || null,
        qty_ordered: Number(l.qty_ordered),
        unit_cost_cents: Math.round((Number(l.unit_cost_dollars) || 0) * 100),
      }));
  }

  // Append matrix-resolved lines (called by the matrix entry sub-panel).
  function appendLines(newLines: Array<{ inventory_item_id: string; description: string; qty: number; unitCostDollars: string }>) {
    setLines((p) => {
      // Drop a trailing empty row so appended lines read cleanly.
      const base = p.filter((l) => l.inventory_item_id || Number(l.qty_ordered) > 0);
      let key = (p[p.length - 1]?.key ?? 0);
      const appended = newLines.map((nl) => ({
        key: ++key, inventory_item_id: nl.inventory_item_id, description: nl.description,
        qty_ordered: String(nl.qty), unit_cost_dollars: nl.unitCostDollars,
      }));
      return [...base, ...appended, { key: ++key, inventory_item_id: "", description: "", qty_ordered: "", unit_cost_dollars: "" }];
    });
  }

  async function save(): Promise<string | null> {
    setErr(null);
    if (!vendorId) { setErr("Pick a vendor."); return null; }
    if (apiLines().length === 0) { setErr("Add at least one line with a quantity."); return null; }
    const body: Record<string, unknown> = {
      vendor_id: vendorId, brand_id: brandId || null,
      order_date: orderDate, expected_date: expectedDate || null,
      payment_terms_id: paymentTermsId || null, notes: notes.trim() || null, lines: apiLines(),
    };
    if (isNew) {
      const r = await fetch("/api/internal/purchase-orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const created = await r.json();
      return created?.id || null;
    }
    const r = await fetch(`/api/internal/purchase-orders/${po!.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return po!.id;
  }

  async function saveDraft() {
    setSubmitting(true);
    try { const id = await save(); if (id) { notify("Purchase order saved.", "success"); onSaved(); } }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  // Status transitions (issued assigns the PO number; in_transit / received advance).
  async function transition(status: string) {
    setSubmitting(true); setErr(null);
    try {
      let id = po?.id || null;
      if (editable) { id = await save(); if (!id) { setSubmitting(false); return; } }
      const r = await fetch(`/api/internal/purchase-orders/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      if (status === "issued") notify("Purchase order issued — PO number assigned.", "success");
      else notify(`Purchase order marked ${status.replace("_", "-")}.`, "success");
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, minWidth: 980, maxWidth: 1180, maxHeight: "90vh", overflowY: "auto", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{isNew ? "New purchase order" : `Purchase order ${po?.po_number || "(draft)"} — ${po?.status}`}</h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Vendor">
            <SearchableSelect value={vendorId || null} onChange={(v) => setVendorId(v)}
              options={vendors.map((v) => ({ value: v.id, label: v.name, searchHaystack: `${v.name} ${v.code || ""}` }))}
              placeholder="(pick vendor…)" disabled={!editable} />
          </Field>
          <Field label="Brand">
            <SearchableSelect value={brandId || null} onChange={(v) => setBrandId(v)}
              options={[{ value: "", label: "(entity default)" }, ...brands.map((b) => ({ value: b.id, label: b.code ? `${b.code} — ${b.name}` : b.name }))]} placeholder="(entity default)" disabled={!editable} />
          </Field>
          <Field label="PO number"><input type="text" value={po?.po_number || ""} readOnly disabled placeholder="(assigned on issue)" style={{ ...inputStyle, opacity: 0.6 }} /></Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Order date"><input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
          <Field label="Expected date"><input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
          <Field label="Payment terms">
            <SearchableSelect value={paymentTermsId || null} onChange={(v) => setPaymentTermsId(v)}
              options={[{ value: "", label: "(select)" }, ...paymentTerms.map((t) => ({ value: t.id, label: t.code ? `${t.code} — ${t.name}` : t.name }))]} placeholder="(select)" disabled={!editable} />
          </Field>
        </div>

        <Field label="Notes"><input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!editable} style={inputStyle} placeholder="optional" /></Field>

        {/* Matrix line entry — pick a style, fill a color × size grid, append resolved SKU lines. */}
        {editable && <MatrixEntry onAppend={appendLines} setErr={setErr} />}

        <div style={{ marginTop: 16, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Lines</div>
          {editable && <button onClick={addLine} style={btnSecondary}>+ Add line</button>}
        </div>
        <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup><col style={{ width: 36 }} /><col /><col style={{ width: 180 }} /><col style={{ width: 90 }} /><col style={{ width: 110 }} /><col style={{ width: 36 }} /></colgroup>
            <thead><tr>
              <th style={th}>#</th><th style={th}>Style / SKU</th><th style={th}>Description</th><th style={th}>Qty</th><th style={th}>Unit $</th><th style={th}></th>
            </tr></thead>
            <tbody>
              {lines.map((l, idx) => (
                <tr key={l.key}>
                  <td style={td}>{idx + 1}</td>
                  <td style={td}>
                    <SearchableSelect value={l.inventory_item_id || null} onChange={(v) => updateLine(idx, { inventory_item_id: v })}
                      options={[{ value: "", label: "(select)" }, ...items.map((it) => ({ value: it.id, label: `${it.sku_code}${it.description ? ` — ${it.description}` : ""}`, searchHaystack: `${it.sku_code} ${it.style_code || ""} ${it.description || ""}` }))]}
                      placeholder="(pick style…)" disabled={!editable} />
                  </td>
                  <td style={td}><input type="text" value={l.description} onChange={(e) => updateLine(idx, { description: e.target.value })} disabled={!editable} placeholder="optional" style={inputStyle} /></td>
                  <td style={td}><input type="text" inputMode="decimal" value={l.qty_ordered} onChange={(e) => updateLine(idx, { qty_ordered: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && editable) { e.preventDefault(); if (idx === lines.length - 1) addLine(); } }} disabled={!editable} placeholder="0" style={numInputStyle} /></td>
                  <td style={td}><input type="text" inputMode="decimal" value={l.unit_cost_dollars} onChange={(e) => updateLine(idx, { unit_cost_dollars: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && editable) { e.preventDefault(); if (idx === lines.length - 1) addLine(); } }} disabled={!editable} placeholder="0.00" style={numInputStyle} /></td>
                  <td style={td}>{editable && lines.length > 1 && <button type="button" onClick={() => removeLine(idx)} style={btnDanger}>✕</button>}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td style={td} colSpan={3}><span style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase" }}>Total</span></td><td style={{ ...td, fontWeight: 700 }} colSpan={3}>{fmtCents(totalCents)}</td></tr></tfoot>
          </table>
        </div>

        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Close</button>
          {editable && <button onClick={() => void saveDraft()} style={btnSecondary} disabled={submitting}>{submitting ? "Saving…" : isNew ? "Save draft" : "Save draft"}</button>}
          {editable && <button onClick={() => void transition("issued")} style={btnPrimary} disabled={submitting}>{submitting ? "…" : "Issue"}</button>}
          {!isNew && po?.status === "issued" && <button onClick={() => void transition("in_transit")} style={{ ...btnSecondary, color: C.warn, borderColor: "#92400e" }} disabled={submitting}>🚚 Mark in-transit</button>}
          {!isNew && (po?.status === "issued" || po?.status === "in_transit") && <button onClick={() => void transition("received")} style={{ ...btnSecondary, color: C.success, borderColor: "#065f46" }} disabled={submitting}>📥 Mark received</button>}
        </div>
      </div>
    </div>
  );
}

// ── Matrix line entry sub-panel ─────────────────────────────────────────────
// Pick a style → fetch /api/internal/style-matrix → render the shared editable
// size-matrix (EditableSizeMatrix): type quantities inline into a color × size
// grid, with a per-row Unit cost column + a "set all rows" header field. "Add to
// PO" resolves each non-zero cell to a SKU and appends, stamping the row's cost.
function MatrixEntry({ onAppend, setErr }: { onAppend: (lines: Array<{ inventory_item_id: string; description: string; qty: number; unitCostDollars: string }>) => void; setErr: (m: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [styles, setStyles] = useState<StyleListRow[]>([]);
  const [styleId, setStyleId] = useState("");
  const [payload, setPayload] = useState<MatrixPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [qtys, setQtys] = useState<Record<string, number>>({}); // key = matrixCellKey(color, size)
  const [unitMap, setUnitMap] = useState<Record<string, string>>({}); // unit cost $ per color row
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    if (!open || styles.length) return;
    fetch("/api/internal/style-master").then((r) => r.json())
      .then((d) => setStyles(Array.isArray(d) ? d : (d.rows || d.styles || []))).catch(() => {});
  }, [open, styles.length]);

  useEffect(() => {
    if (!styleId) { setPayload(null); setQtys({}); setUnitMap({}); return; }
    let cancelled = false;
    setLoading(true); setQtys({}); setUnitMap({});
    fetch(`/api/internal/style-matrix?style_id=${encodeURIComponent(styleId)}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error("style-matrix fetch failed")))
      .then((d: MatrixPayload) => { if (!cancelled) setPayload(d); })
      .catch(() => { if (!cancelled) setPayload(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [styleId]);

  const styleOptions = useMemo(() => styles.map((s) => {
    const name = s.style_name || s.description || "";
    return { value: s.id, label: name ? `${s.style_code} — ${name}` : s.style_code, searchHaystack: `${s.style_code} ${name}` };
  }), [styles]);

  // One grid row per color (rowKey = color); size columns from the scale.
  const rows = useMemo<EditableMatrixRow[]>(() => {
    if (!payload) return [];
    const colors = payload.colors.length ? payload.colors : [null];
    return colors.map((color) => ({ key: color ?? "", color: color ?? null }));
  }, [payload]);

  async function addToPo() {
    if (!payload) return;
    const cells = Object.entries(qtys).filter(([, q]) => q > 0);
    if (cells.length === 0) { setErr("Enter a quantity in at least one matrix cell."); return; }
    setResolving(true); setErr(null);
    try {
      const resolved: Array<{ inventory_item_id: string; description: string; qty: number; unitCostDollars: string }> = [];
      for (const [key, qty] of cells) {
        const [color, size] = key.split("__");
        const r = await fetch("/api/internal/style-matrix/resolve-sku", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ style_id: payload.style.id, style_code: payload.style.style_code, color: color || null, size }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.id) throw new Error(j.error || `Could not resolve SKU for ${payload.style.style_code} ${color} ${size}`);
        resolved.push({
          inventory_item_id: j.id,
          description: `${payload.style.style_code} ${color || ""} ${size}`.replace(/\s+/g, " ").trim(),
          qty, unitCostDollars: (unitMap[color] || "").trim(),
        });
      }
      onAppend(resolved);
      // Reset the grid for the next style.
      setQtys({}); setStyleId(""); setPayload(null); setUnitMap({});
      notify(`Added ${resolved.length} line${resolved.length === 1 ? "" : "s"} from the matrix.`, "success");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setResolving(false); }
  }

  return (
    <div style={{ marginTop: 12, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
      <button onClick={() => setOpen((v) => !v)} style={{ width: "100%", textAlign: "left", padding: "8px 12px", background: "#0b1220", color: C.text, border: 0, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
        <span style={{ color: C.textMuted, marginRight: 6 }}>{open ? "▼" : "▶"}</span>➕ Add by matrix (color × size grid)
      </button>
      {open && (
        <div style={{ padding: 12 }}>
          <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ minWidth: 320 }}>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Style</div>
              <SearchableSelect value={styleId || null} onChange={(v) => setStyleId(v)} options={styleOptions} placeholder="Search style code or name…" inputStyle={inputStyle} />
            </div>
            <button onClick={() => void addToPo()} style={{ ...btnSecondary, color: C.primary, borderColor: C.primary }} disabled={resolving || !payload}>
              {resolving ? "Resolving…" : "Add to PO"}
            </button>
          </div>

          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>Type quantities directly into the grid. Use the <b>Unit cost</b> header field to stamp one cost across every color row, then tweak rows as needed. Empty / zero cells are skipped.</div>

          {loading ? (
            <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
          ) : !styleId ? (
            <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Pick a style to build a matrix.</div>
          ) : !payload || payload.sizes.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No sizes found for this style.</div>
          ) : (
            <EditableSizeMatrix
              rows={rows}
              sizes={payload.sizes}
              qty={qtys}
              onQtyChange={(rowKey, size, value) => setQtys((p) => {
                const k = matrixCellKey(rowKey, size);
                const copy = { ...p };
                if (value > 0) copy[k] = value; else delete copy[k];
                return copy;
              })}
              unit={{
                label: "Unit cost $",
                placeholder: "0.00",
                values: unitMap,
                onChange: (rowKey, v) => setUnitMap((p) => ({ ...p, [rowKey]: v })),
                onSetAll: (v) => setUnitMap(() => Object.fromEntries(rows.map((r) => [r.key, v]))),
              }}
            />
          )}
        </div>
      )}
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
