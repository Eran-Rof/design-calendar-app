// src/tanda/InternalPurchaseOrders.tsx
//
// P16 / M11 — native Purchase Order entry (origination). List + create/edit
// modal. Mirrors the Sales Order modal (M10): vendor/brand/payment-terms
// pickers, item SearchableSelect lines, plus a matrix line-entry mode (style →
// /api/internal/style-matrix → editable MatrixGrid → resolve-sku per cell).
// PO number is system-assigned on Issue.

import { useEffect, useMemo, useRef, useState } from "react";
import { fmtDateDisplay } from "../utils/tandaTypes";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import SearchableSelect from "./components/SearchableSelect";
import LineMatrixBody, { type LineMatrixBodyHandle, type SeedSection, type FlatLine } from "./LineMatrixBody";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { notify } from "../shared/ui/warn";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { readDrillParam } from "./scorecardDrill";

// Universal column-visibility registry for this panel (operator ask #1).
const PO_TABLE_KEY = "tangerine:purchaseorders:columns";
const PO_COLUMNS: ColumnDef[] = [
  { key: "po_number",     label: "PO #" },
  { key: "vendor",        label: "Vendor" },
  { key: "order_date",    label: "Order date" },
  { key: "expected_date", label: "Expected" },
  { key: "status",        label: "Status" },
  { key: "total",         label: "Total" },
];

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box" };
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };

type PO = {
  id: string; po_number: string | null; vendor_id: string; brand_id: string | null;
  order_date: string; expected_date: string | null; status: string; currency: string;
  payment_terms_id: string | null; notes: string | null; subtotal_cents: number | string; total_cents: number | string;
};
type Vendor = { id: string; name: string; code?: string };
type Item = { id: string; sku_code: string; style_code?: string; description?: string };
type Lookup = { id: string; code?: string; name: string };

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
  // Scorecard drill-through: ?vendor=<id> seeds the vendor filter on mount so a
  // click from the Vendor Scorecard lands here pre-filtered to that vendor.
  const [vendorFilter, setVendorFilter] = useState(() => readDrillParam("vendor"));
  // Scorecard per-line drill: ?q=<po_number> seeds the search on mount so a
  // new-tab deep-link lands here filtered to that single PO. Server-side q is
  // all-field (search_purchase_orders RPC): matches PO #, notes, vendor
  // name/code, and any line's style / SKU / line description.
  const { value: search, debouncedValue: searchDebounced, setValue: setSearch } = useDebouncedSearch(readDrillParam("q"), 200);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PO | null>(null);

  // Wave 5 — universal column show/hide.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(PO_TABLE_KEY, PO_COLUMNS);
  const isVisible = (k: string): boolean => visibleColumns.has(k);

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
      if (searchDebounced.trim()) params.set("q", searchDebounced.trim());
      const r = await fetch(`/api/internal/purchase-orders?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as PO[]);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [statusFilter, vendorFilter, searchDebounced]);
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
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search PO #, vendor, style…" style={{ ...inputStyle, width: 240 }} />
        <button style={btnSecondary} onClick={() => void load()}>Refresh</button>
        <TablePrefsButton
          tableKey={PO_TABLE_KEY}
          columns={PO_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
        />
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={th} hidden={!isVisible("po_number")}>PO #</th><th style={th} hidden={!isVisible("vendor")}>Vendor</th><th style={th} hidden={!isVisible("order_date")}>Order date</th>
            <th style={th} hidden={!isVisible("expected_date")}>Expected</th><th style={th} hidden={!isVisible("status")}>Status</th><th style={{ ...th, textAlign: "right" }} hidden={!isVisible("total")}>Total</th>
          </tr></thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={6}>Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={6}>No purchase orders.</td></tr>}
            {rows.map((po) => (
              <tr key={po.id} style={{ cursor: "pointer" }} onClick={() => { setEditing(po); setModalOpen(true); }}>
                <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }} hidden={!isVisible("po_number")}>{po.po_number || <span style={{ color: C.textMuted }}>(draft)</span>}</td>
                <td style={td} hidden={!isVisible("vendor")}>{vendorName[po.vendor_id] || "—"}</td>
                <td style={td} hidden={!isVisible("order_date")}>{fmtDateDisplay(po.order_date)}</td>
                <td style={td} hidden={!isVisible("expected_date")}>{po.expected_date ? fmtDateDisplay(po.expected_date) : "—"}</td>
                <td style={td} hidden={!isVisible("status")}><span style={{ color: STATUS_COLORS[po.status] || C.text, fontWeight: 600 }}>● {po.status}</span></td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!isVisible("total")}>{fmtCents(po.total_cents)}</td>
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
  // Line body is the shared size matrix (mode="po" → Unit Cost $, no margin/ATS).
  const bodyRef = useRef<LineMatrixBodyHandle>(null);
  const [seed, setSeed] = useState<{ sections: SeedSection[]; flat: FlatLine[] } | null>(null);

  // ── Rich header fields ──────────────────────────────────────────────────────
  const [poType, setPoType] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [poPrefix, setPoPrefix] = useState("");
  const [vendorContact, setVendorContact] = useState("");
  const [vendorEmail, setVendorEmail] = useState("");
  const [vendorRef, setVendorRef] = useState("");
  const [factoryLocation, setFactoryLocation] = useState("");
  const [coo, setCoo] = useState("");
  const [requestedDeliveryDate, setRequestedDeliveryDate] = useState("");
  const [shipWindowStart, setShipWindowStart] = useState("");
  const [shipWindowEnd, setShipWindowEnd] = useState("");
  const [portDate, setPortDate] = useState("");
  const [acknowledgedDate, setAcknowledgedDate] = useState("");
  const [cancelDate, setCancelDate] = useState("");
  const [shipToLocationId, setShipToLocationId] = useState("");
  const [billToEntityId, setBillToEntityId] = useState("");
  const [shipMethod, setShipMethod] = useState("");
  const [freightForwarder, setFreightForwarder] = useState("");
  const [season, setSeason] = useState("");
  const [channelId, setChannelId] = useState("");
  const [departmentCategoryId, setDepartmentCategoryId] = useState("");
  const [rollup, setRollup] = useState<{ weight_kg: number; cartons: number; cbm_m3: number; complete: boolean } | null>(null);

  const [items, setItems] = useState<Item[]>([]);
  const [brands, setBrands] = useState<Lookup[]>([]);
  const [paymentTerms, setPaymentTerms] = useState<Lookup[]>([]);
  const [customers, setCustomers] = useState<{ id: string; name: string; customer_code?: string }[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string; code?: string }[]>([]);
  const [entities, setEntities] = useState<{ id: string; code?: string; legal_name?: string; name?: string }[]>([]);
  const [channels, setChannels] = useState<Lookup[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string; category_code?: string }[]>([]);
  const [seasons, setSeasons] = useState<{ id: string; name: string }[]>([]);
  const [countries, setCountries] = useState<{ iso2?: string; name: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/internal/items?limit=5000").then((r) => r.ok ? r.json() : []).then((a) => setItems(Array.isArray(a) ? a : [])).catch(() => {});
    fetch("/api/internal/brands").then((r) => r.json()).then((d) => setBrands(Array.isArray(d.brands) ? d.brands : [])).catch(() => {});
    fetch("/api/internal/payment-terms?limit=200").then((r) => r.json()).then((a) => setPaymentTerms(Array.isArray(a) ? a : [])).catch(() => {});
    fetch("/api/internal/customer-master?limit=5000").then((r) => r.ok ? r.json() : []).then((a) => setCustomers(Array.isArray(a) ? a : [])).catch(() => {});
    fetch("/api/internal/warehouses").then((r) => r.ok ? r.json() : []).then((a) => setWarehouses(Array.isArray(a) ? a : [])).catch(() => {});
    fetch("/api/internal/entities?flat=true").then((r) => r.ok ? r.json() : []).then((a) => setEntities(Array.isArray(a) ? a : [])).catch(() => {});
    fetch("/api/internal/channels").then((r) => r.json()).then((d) => setChannels(Array.isArray(d.channels) ? d.channels : [])).catch(() => {});
    fetch("/api/internal/categories").then((r) => r.ok ? r.json() : []).then((a) => setCategories(Array.isArray(a) ? a : [])).catch(() => {});
    fetch("/api/internal/seasons").then((r) => r.ok ? r.json() : []).then((a) => setSeasons(Array.isArray(a) ? a : [])).catch(() => {});
    fetch("/api/internal/countries").then((r) => r.ok ? r.json() : []).then((a) => setCountries(Array.isArray(a) ? a : [])).catch(() => {});
  }, []);

  // Load existing PO lines when editing → seed the matrix body. If the detail
  // endpoint decorates lines with style_code/color/size they regroup into
  // per-style matrices; otherwise they seed as flat lines (still editable).
  useEffect(() => {
    if (isNew || !po) { setSeed(null); return; }
    fetch(`/api/internal/purchase-orders/${po.id}`).then((r) => r.ok ? r.json() : null).then((full) => {
      if (!full) return;
      // Populate the rich-header state from the full PO record + the rollup.
      setPoType(full.po_type || ""); setCustomerId(full.customer_id || ""); setPoPrefix(full.po_prefix || "");
      setVendorContact(full.vendor_contact || ""); setVendorEmail(full.vendor_email || ""); setVendorRef(full.vendor_ref || "");
      setFactoryLocation(full.factory_location || ""); setCoo(full.coo || "");
      setRequestedDeliveryDate(full.requested_delivery_date || ""); setShipWindowStart(full.ship_window_start || ""); setShipWindowEnd(full.ship_window_end || "");
      setPortDate(full.port_date || ""); setAcknowledgedDate(full.acknowledged_date || ""); setCancelDate(full.cancel_date || "");
      setShipToLocationId(full.ship_to_location_id || ""); setBillToEntityId(full.bill_to_entity_id || "");
      setShipMethod(full.ship_method || ""); setFreightForwarder(full.freight_forwarder || "");
      setSeason(full.season || ""); setChannelId(full.channel_id || ""); setDepartmentCategoryId(full.department_category_id || "");
      if (full.logistics_rollup) setRollup(full.logistics_rollup);
      if (!full?.lines) return;
      type DLine = { inventory_item_id: string | null; description: string | null; qty_ordered: number; unit_cost_cents: number; style_code?: string | null; color?: string | null; size?: string | null; sku_code?: string | null; requested_ship_date?: string | null; vendor_confirmed_ship_date?: string | null };
      const byStyle = new Map<string, SeedSection>();
      const flat: FlatLine[] = [];
      let fk = 1;
      for (const l of (full.lines as DLine[])) {
        const dollars = l.unit_cost_cents != null ? (l.unit_cost_cents / 100).toFixed(2) : "";
        if (l.style_code && l.size) {
          let sec = byStyle.get(l.style_code);
          if (!sec) { sec = { styleCode: l.style_code, cells: [], requestedShipDate: l.requested_ship_date ?? null, vendorConfirmedShipDate: l.vendor_confirmed_ship_date ?? null }; byStyle.set(l.style_code, sec); }
          sec.cells.push({ color: l.color ?? null, size: l.size, qty: l.qty_ordered, unit: dollars });
        } else {
          flat.push({ key: fk++, inventory_item_id: l.inventory_item_id || "", qty_ordered: String(l.qty_ordered ?? ""), unit_price_dollars: dollars, label: l.sku_code ? `${l.sku_code}${l.style_code ? ` — ${l.style_code}` : ""}` : (l.description || undefined) });
        }
      }
      setSeed({ sections: [...byStyle.values()], flat });
    }).catch(() => {});
  }, [isNew, po]);

  async function save(): Promise<string | null> {
    setErr(null);
    if (!vendorId) { setErr("Pick a vendor."); return null; }
    // The matrix body resolves every filled cell + flat line to a SKU. Map its
    // generic unit_price_cents onto the PO's unit_cost_cents.
    const resolved = (await bodyRef.current?.resolve()) || [];
    const lines = resolved.map((r) => ({ inventory_item_id: r.inventory_item_id, qty_ordered: r.qty_ordered, unit_cost_cents: r.unit_price_cents, requested_ship_date: r.requested_ship_date ?? null, vendor_confirmed_ship_date: r.vendor_confirmed_ship_date ?? null }));
    if (lines.length === 0) { setErr("Add at least one line with a quantity."); return null; }
    const body: Record<string, unknown> = {
      vendor_id: vendorId, brand_id: brandId || null,
      order_date: orderDate, expected_date: expectedDate || null,
      payment_terms_id: paymentTermsId || null, notes: notes.trim() || null, lines,
      // Rich header
      po_type: poType || null, customer_id: customerId || null, po_prefix: poPrefix.trim() || null,
      vendor_contact: vendorContact.trim() || null, vendor_email: vendorEmail.trim() || null, vendor_ref: vendorRef.trim() || null,
      factory_location: factoryLocation.trim() || null, coo: coo || null,
      requested_delivery_date: requestedDeliveryDate || null, ship_window_start: shipWindowStart || null, ship_window_end: shipWindowEnd || null,
      port_date: portDate || null, acknowledged_date: acknowledgedDate || null, cancel_date: cancelDate || null,
      ship_to_location_id: shipToLocationId || null, bill_to_entity_id: billToEntityId || null,
      ship_method: shipMethod || null, freight_forwarder: freightForwarder.trim() || null,
      season: season || null, channel_id: channelId || null, department_category_id: departmentCategoryId || null,
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
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(1180px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{isNew ? "New purchase order" : `Purchase order ${po?.po_number || "(draft)"} — ${po?.status}`}</h3>

        {/* Identity & status */}
        <Section title="Identity &amp; status">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
            <Field label="PO type">
              <select value={poType} onChange={(e) => setPoType(e.target.value)} disabled={!editable} style={inputStyle as React.CSSProperties}>
                <option value="">(select)</option>
                {[["stock", "Stock"], ["replenishment", "Replenishment"], ["made_to_order", "Made-to-order"], ["sample", "Sample"], ["drop_ship", "Drop-ship"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <Field label="Customer">
              <SearchableSelect value={customerId || null} onChange={(v) => setCustomerId(v || "")}
                options={[{ value: "", label: "(none)" }, ...customers.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.name} ${c.customer_code || ""}` }))]} placeholder="(none)" disabled={!editable} />
            </Field>
            <Field label="PO number prefix"><input type="text" value={poPrefix} onChange={(e) => setPoPrefix(e.target.value)} disabled={!editable} style={inputStyle} placeholder="PO (default)" title="Overrides the 'PO-' prefix used when the PO is issued" /></Field>
            <Field label="PO number / status">
              <input type="text" value={po?.po_number ? `${po.po_number} · ${po.status}` : (po?.status || "(draft — assigned on issue)")} readOnly disabled style={{ ...inputStyle, opacity: 0.6 }} />
            </Field>
          </div>
        </Section>

        {/* Vendor / supplier */}
        <Section title="Vendor / supplier">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <Field label="Vendor">
              <SearchableSelect value={vendorId || null} onChange={(v) => setVendorId(v)}
                options={vendors.map((v) => ({ value: v.id, label: v.name, searchHaystack: `${v.name} ${v.code || ""}` }))}
                placeholder="(pick vendor…)" disabled={!editable} />
            </Field>
            <Field label="Vendor contact"><input type="text" value={vendorContact} onChange={(e) => setVendorContact(e.target.value)} disabled={!editable} style={inputStyle} placeholder="contact name" /></Field>
            <Field label="Vendor email"><input type="email" value={vendorEmail} onChange={(e) => setVendorEmail(e.target.value)} disabled={!editable} style={inputStyle} placeholder="name@vendor.com" /></Field>
            <Field label="Vendor PO / ref #"><input type="text" value={vendorRef} onChange={(e) => setVendorRef(e.target.value)} disabled={!editable} style={inputStyle} placeholder="their reference" /></Field>
            <Field label="Factory / production location"><input type="text" value={factoryLocation} onChange={(e) => setFactoryLocation(e.target.value)} disabled={!editable} style={inputStyle} placeholder="factory / city" /></Field>
            <Field label="COO (country of origin)">
              <SearchableSelect value={coo || null} onChange={(v) => setCoo(v || "")}
                options={[{ value: "", label: "(none)" }, ...countries.map((c) => ({ value: c.name, label: c.name, searchHaystack: `${c.name} ${c.iso2 || ""}` }))]} placeholder="(none)" disabled={!editable} />
            </Field>
          </div>
        </Section>

        {/* Dates */}
        <Section title="Dates">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
            <Field label="Order date"><input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
            <Field label="Requested delivery / in-DC"><input type="date" value={requestedDeliveryDate} onChange={(e) => setRequestedDeliveryDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
            <Field label="Ship window start"><input type="date" value={shipWindowStart} onChange={(e) => setShipWindowStart(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
            <Field label="Ship window end"><input type="date" value={shipWindowEnd} onChange={(e) => setShipWindowEnd(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
            <Field label="Port date"><input type="date" value={portDate} onChange={(e) => setPortDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
            <Field label="Vendor-confirmed / ack."><input type="date" value={acknowledgedDate} onChange={(e) => setAcknowledgedDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
            <Field label="Expected date"><input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
            <Field label="Cancel date"><input type="date" value={cancelDate} onChange={(e) => setCancelDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
          </div>
        </Section>

        {/* Logistics & destination */}
        <Section title="Logistics &amp; destination">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
            <Field label="Ship-to location / warehouse">
              <SearchableSelect value={shipToLocationId || null} onChange={(v) => setShipToLocationId(v || "")}
                options={[{ value: "", label: "(none)" }, ...warehouses.map((w) => ({ value: w.id, label: w.code ? `${w.code} — ${w.name}` : w.name }))]} placeholder="(none)" disabled={!editable} />
            </Field>
            <Field label="Bill-to entity">
              <SearchableSelect value={billToEntityId || null} onChange={(v) => setBillToEntityId(v || "")}
                options={[{ value: "", label: "(default entity)" }, ...entities.map((e) => ({ value: e.id, label: e.code || e.legal_name || e.name || e.id.slice(0, 8) }))]} placeholder="(default entity)" disabled={!editable} />
            </Field>
            <Field label="Ship method / mode">
              <select value={shipMethod} onChange={(e) => setShipMethod(e.target.value)} disabled={!editable} style={inputStyle as React.CSSProperties}>
                <option value="">(select)</option>
                {[["sea", "Sea"], ["air", "Air"], ["ground", "Ground"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <Field label="Consolidator / forwarder"><input type="text" value={freightForwarder} onChange={(e) => setFreightForwarder(e.target.value)} disabled={!editable} style={inputStyle} placeholder="freight forwarder" /></Field>
          </div>
        </Section>

        {/* Classification & terms */}
        <Section title="Classification &amp; terms">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr", gap: 12 }}>
            <Field label="Brand">
              <SearchableSelect value={brandId || null} onChange={(v) => setBrandId(v)}
                options={[{ value: "", label: "(entity default)" }, ...brands.map((b) => ({ value: b.id, label: b.code ? `${b.code} — ${b.name}` : b.name }))]} placeholder="(entity default)" disabled={!editable} />
            </Field>
            <Field label="Season">
              <SearchableSelect value={season || null} onChange={(v) => setSeason(v || "")}
                options={[{ value: "", label: "(none)" }, ...seasons.map((s) => ({ value: s.name, label: s.name }))]} placeholder="(none)" disabled={!editable} />
            </Field>
            <Field label="Channel">
              <SearchableSelect value={channelId || null} onChange={(v) => setChannelId(v || "")}
                options={[{ value: "", label: "(none)" }, ...channels.map((c) => ({ value: c.id, label: c.code ? `${c.code} — ${c.name}` : c.name }))]} placeholder="(none)" disabled={!editable} />
            </Field>
            <Field label="Department">
              <SearchableSelect value={departmentCategoryId || null} onChange={(v) => setDepartmentCategoryId(v || "")}
                options={[{ value: "", label: "(none)" }, ...categories.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.name} ${c.category_code || ""}` }))]} placeholder="(none)" disabled={!editable} />
            </Field>
            <Field label="Payment terms">
              <SearchableSelect value={paymentTermsId || null} onChange={(v) => setPaymentTermsId(v)}
                options={[{ value: "", label: "(select)" }, ...paymentTerms.map((t) => ({ value: t.id, label: t.code ? `${t.code} — ${t.name}` : t.name }))]} placeholder="(select)" disabled={!editable} />
            </Field>
          </div>
        </Section>

        <Field label="Notes"><input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!editable} style={inputStyle} placeholder="optional" /></Field>

        {/* Totals roll-up from Style Master logistics (read-only). On a new PO it
            populates after the first save (the server computes it from the lines). */}
        <div style={{ display: "flex", gap: 24, alignItems: "baseline", padding: "10px 12px", marginTop: 12, background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>
          <span style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Roll-up</span>
          <span style={{ color: C.textMuted, fontSize: 13 }}>Total weight <b style={{ color: C.text, marginLeft: 6, fontVariantNumeric: "tabular-nums" }}>{rollup ? `${rollup.weight_kg.toLocaleString()} kg` : "—"}</b></span>
          <span style={{ color: C.textMuted, fontSize: 13 }}>Cartons <b style={{ color: C.text, marginLeft: 6, fontVariantNumeric: "tabular-nums" }}>{rollup ? rollup.cartons.toLocaleString() : "—"}</b></span>
          <span style={{ color: C.textMuted, fontSize: 13 }}>Total CBM <b style={{ color: C.text, marginLeft: 6, fontVariantNumeric: "tabular-nums" }}>{rollup ? `${rollup.cbm_m3.toLocaleString()} m³` : "—"}</b></span>
          {rollup && !rollup.complete && <span style={{ fontSize: 11, color: C.warn }}>some styles missing weight/carton/CBM in Style Master</span>}
          {!rollup && <span style={{ fontSize: 11, color: C.textMuted }}>populates after save</span>}
        </div>

        {/* Line body — the shared size matrix, exactly like the Sales Order modal
            (mode="po": Unit Cost $ column, no margin / availability). Default-open. */}
        <div style={{ marginTop: 12, marginBottom: 12 }}>
          <LineMatrixBody
            ref={bodyRef}
            mode="po"
            editable={editable}
            items={items}
            seed={seed}
            showOnHand={false}
            showLineDates
          />
        </div>

        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

        <div style={{ position: "sticky", bottom: -20, zIndex: 3, background: C.card, borderTop: `1px solid ${C.cardBdr}`, margin: "0 -20px -20px", padding: "12px 20px", display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      {children}
    </div>
  );
}

// Grouped header section — a titled bordered block for the rich PO header.
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>{title}</div>
      {children}
    </div>
  );
}
