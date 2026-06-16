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
import { openOrderDocument } from "./orderDocument";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { notify, confirmDialog } from "../shared/ui/warn";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { readDrillParam } from "./scorecardDrill";
import RowHistory from "./components/RowHistory";

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

// PO "Requested in DC" date derived from a Sales Order cancel date: the 1st of
// the cancel-date's month, AS LONG AS that's at least 20 days before the cancel
// date; otherwise (cancel date − 20 days). Returns YYYY-MM-DD (local, no TZ
// shift). Empty string if the input isn't a YYYY-MM-DD date.
function requestedInDcFromCancel(cancelIso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((cancelIso || "").trim());
  if (!m) return "";
  const y = Number(m[1]), mon = Number(m[2]), d = Number(m[3]);
  const firstOfMonth = new Date(y, mon - 1, 1);
  const twentyPrior = new Date(y, mon - 1, d - 20); // JS normalizes day underflow into the previous month
  const chosen = firstOfMonth.getTime() <= twentyPrior.getTime() ? firstOfMonth : twentyPrior;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${chosen.getFullYear()}-${pad(chosen.getMonth() + 1)}-${pad(chosen.getDate())}`;
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
  // ✎ Edit unlocks a saved (issued/in-transit/received) PO for revision — the
  // operator can change anything; saving fires a "PO revised" notification to
  // the vendor's portal users (if connected). Drafts + new POs are editable as-is.
  const [editMode, setEditMode] = useState(false);
  const isRevisable = !isNew && po != null && po.status !== "draft" && po.status !== "cancelled";
  const editable = isNew || po?.status === "draft" || editMode;

  const [vendorId, setVendorId] = useState(po?.vendor_id || "");
  const [brandId, setBrandId] = useState(po?.brand_id || "");
  const [orderDate, setOrderDate] = useState(po?.order_date || new Date().toISOString().slice(0, 10));
  const [expectedDate, setExpectedDate] = useState(po?.expected_date || "");
  const [paymentTermsId, setPaymentTermsId] = useState(po?.payment_terms_id || "");
  const [notes, setNotes] = useState(po?.notes || "");
  // Collapse the rich document header (boxes) down to just the vendor name once
  // the operator starts adding lines, so the size matrix has room. Toggleable.
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  // Line body is the shared size matrix (mode="po" → Unit Cost $, no margin/ATS).
  const bodyRef = useRef<LineMatrixBodyHandle>(null);
  const [seed, setSeed] = useState<{ sections: SeedSection[]; flat: FlatLine[] } | null>(null);
  const [seedKey, setSeedKey] = useState(0); // bump to remount + re-seed the matrix body
  const [salesOrderId, setSalesOrderId] = useState(""); // originating SO (Create from SO)
  // Create-from-SO dialog.
  const [soPickOpen, setSoPickOpen] = useState(false);
  const [soQuery, setSoQuery] = useState("");
  const [soList, setSoList] = useState<{ id: string; so_number: string | null; customer_id: string; status: string; requested_ship_date: string | null; cancel_date: string | null; brand_id: string | null; channel_id: string | null }[]>([]);
  const [soBusy, setSoBusy] = useState(false);
  // Get-PO-price (awarded RFQ) flow.
  type AwardQuote = { costing_line_id: string; style_code: string; vendor_id: string; vendor_name: string | null; quoted_cost: number | null; currency: string; awarded_at: string | null; quoted_date: string | null };
  const [priceAskOpen, setPriceAskOpen] = useState(false);   // "is this from an SO?"
  const [awardOpen, setAwardOpen] = useState(false);
  const [awardQuotes, setAwardQuotes] = useState<AwardQuote[]>([]);
  const [awardPick, setAwardPick] = useState<Record<string, string>>({}); // styleCode → chosen costing_line_id
  const [awardMissing, setAwardMissing] = useState<string[]>([]); // SO styles with no awarded price
  const [awardInPlace, setAwardInPlace] = useState(false); // apply onto existing matrix (preserve qty) vs add styles
  const applyAwardAfterSO = useRef(false);

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
      setSalesOrderId(full.sales_order_id || "");
      if (full.logistics_rollup) setRollup(full.logistics_rollup);
      if (!full?.lines) return;
      type DLine = { inventory_item_id: string | null; description: string | null; qty_ordered: number; unit_cost_cents: number; style_code?: string | null; color?: string | null; size?: string | null; inseam?: string | null; sku_code?: string | null; requested_ship_date?: string | null; vendor_confirmed_ship_date?: string | null };
      const byStyle = new Map<string, SeedSection>();
      const flat: FlatLine[] = [];
      let fk = 1;
      for (const l of (full.lines as DLine[])) {
        const dollars = l.unit_cost_cents != null ? (l.unit_cost_cents / 100).toFixed(2) : "";
        if (l.style_code && l.size) {
          let sec = byStyle.get(l.style_code);
          if (!sec) { sec = { styleCode: l.style_code, cells: [], requestedShipDate: l.requested_ship_date ?? null, vendorConfirmedShipDate: l.vendor_confirmed_ship_date ?? null }; byStyle.set(l.style_code, sec); }
          sec.cells.push({ color: l.color ?? null, size: l.size, inseam: l.inseam ?? null, qty: l.qty_ordered, unit: dollars });
        } else {
          flat.push({ key: fk++, inventory_item_id: l.inventory_item_id || "", qty_ordered: String(l.qty_ordered ?? ""), unit_price_dollars: dollars, label: l.sku_code ? `${l.sku_code}${l.style_code ? ` — ${l.style_code}` : ""}` : (l.description || undefined) });
        }
      }
      setSeed({ sections: [...byStyle.values()], flat });
    }).catch(() => {});
  }, [isNew, po]);

  // ── Create PO from a Sales Order ────────────────────────────────────────────
  // A PO can only be created from an SO that's still in the buying stage —
  // a draft or confirmed order. Anything past that (allocated / fulfilling /
  // shipped / invoiced / closed) has committed or billed stock, and cancelled
  // orders are dead. Allow-list so any future SO status defaults to blocked.
  const PO_FROM_SO_ALLOWED = ["draft", "confirmed"];
  // Load SOs for the picker (debounced) — only qualifying orders are shown.
  useEffect(() => {
    if (!soPickOpen) return;
    const t = setTimeout(() => {
      const qs = soQuery.trim() ? `?q=${encodeURIComponent(soQuery.trim())}&limit=50` : "?limit=50";
      fetch(`/api/internal/sales-orders${qs}`).then((r) => r.ok ? r.json() : []).then((a) => setSoList((Array.isArray(a) ? a : []).filter((so) => PO_FROM_SO_ALLOWED.includes(so.status)))).catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [soPickOpen, soQuery]);

  // Pull an SO's lines into the PO matrix + copy across the sensible header
  // fields. The SO carries SELLING prices, not costs, so unit cost is left blank
  // (fill manually or via "Get PO price"). Records sales_order_id for traceability.
  async function createFromSO(soId: string) {
    setSoBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/sales-orders/${soId}`);
      const full = await r.json();
      if (!r.ok) throw new Error(full.error || `HTTP ${r.status}`);
      // Guard: only a draft / confirmed SO can seed a PO.
      if (!PO_FROM_SO_ALLOWED.includes(full.status)) {
        setSoBusy(false);
        notify(`Sales order ${full.so_number || ""} is ${full.status} — a PO can only be created from a draft or confirmed sales order.`, "error");
        return;
      }
      type SLine = { qty_ordered: number; style_code?: string | null; color?: string | null; size?: string | null; inseam?: string | null; inventory_item_id?: string | null; sku_code?: string | null; description?: string | null };
      const byStyle = new Map<string, SeedSection>();
      const flat: FlatLine[] = [];
      let fk = 1;
      for (const l of (full.lines || []) as SLine[]) {
        if (l.style_code && l.size) {
          let sec = byStyle.get(l.style_code);
          if (!sec) { sec = { styleCode: l.style_code, cells: [] }; byStyle.set(l.style_code, sec); }
          sec.cells.push({ color: l.color ?? null, size: l.size, inseam: l.inseam ?? null, qty: l.qty_ordered }); // no unit cost
        } else if (l.inventory_item_id) {
          flat.push({ key: fk++, inventory_item_id: l.inventory_item_id, qty_ordered: String(l.qty_ordered ?? ""), unit_price_dollars: "", label: l.sku_code ? `${l.sku_code}${l.style_code ? ` — ${l.style_code}` : ""}` : (l.description || undefined) });
        }
      }
      // Header carry-over from the SO.
      setSalesOrderId(soId);
      if (full.customer_id) setCustomerId(full.customer_id);
      if (full.brand_id) setBrandId(full.brand_id);
      if (full.channel_id) setChannelId(full.channel_id);
      // Requested-in-DC = 1st of the SO cancel month, but ≥20 days before the
      // cancel date (else cancel − 20 days). Falls back to the SO ship date.
      if (full.cancel_date) setRequestedDeliveryDate(requestedInDcFromCancel(full.cancel_date) || full.requested_ship_date || "");
      else if (full.requested_ship_date) setRequestedDeliveryDate(full.requested_ship_date);
      if (full.cancel_date) setCancelDate(full.cancel_date);
      setSeedKey((k) => k + 1);
      const sections = [...byStyle.values()];
      setSeed({ sections, flat });
      setSoPickOpen(false);
      notify("PO matrix prefilled from the sales order.", "success");
      // Get-PO-price flow: after the SO fills the matrix, pull awarded RFQ prices.
      if (applyAwardAfterSO.current) {
        applyAwardAfterSO.current = false;
        await openAwardDialog(sections.map((s) => s.styleCode));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSoBusy(false);
    }
  }

  // ── Get PO price (awarded RFQ) ──────────────────────────────────────────────
  // Fetch awarded quotes (optionally scoped to the given styles) and open the
  // picker. Defaults each style's selection to its newest award.
  async function openAwardDialog(styleCodes?: string[]) {
    try {
      const requested = styleCodes || [];
      const qs = requested.length ? `?style_codes=${encodeURIComponent(requested.join(","))}` : "";
      const r = await fetch(`/api/internal/costing/awarded-quotes${qs}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const quotes = (j.quotes || []) as AwardQuote[];
      const awardedSet = new Set(quotes.map((q) => q.style_code));
      // Styles that came from the SO but have NO awarded price.
      const missing = requested.filter((c) => !awardedSet.has(c));
      if (quotes.length === 0) {
        if (requested.length) {
          // From-SO with zero awards: warn (list the styles), add nothing.
          setAwardQuotes([]); setAwardPick({}); setAwardMissing(requested); setAwardOpen(true);
        } else {
          notify("No awarded RFQ quotes found.", "info");
        }
        return;
      }
      const pick: Record<string, string> = {};
      for (const q of quotes) if (!pick[q.style_code]) pick[q.style_code] = q.costing_line_id; // newest first
      setAwardQuotes(quotes); setAwardPick(pick); setAwardMissing(missing); setAwardOpen(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  // Apply the chosen awards: stamp each style's awarded cost as the section's
  // default unit and set the PO vendor (warn if the picks span vendors).
  function applyAwards() {
    const chosen = awardQuotes.filter((q) => awardPick[q.style_code] === q.costing_line_id);
    const vendorIds0 = [...new Set(chosen.map((q) => q.vendor_id))];
    // In-place: the styles are already in the matrix — stamp the awarded cost on
    // their rows WITHOUT remounting, so the operator's quantities are preserved.
    if (awardInPlace) {
      const byStyle: Record<string, string> = {};
      for (const q of chosen) if (q.quoted_cost != null) byStyle[q.style_code] = String(q.quoted_cost);
      bodyRef.current?.applyUnitByStyle(byStyle);
      if (vendorIds0.length === 1) setVendorId(vendorIds0[0]);
      setAwardOpen(false);
      notify(vendorIds0.length > 1
        ? "Awarded prices applied (quantities kept). The picks span multiple vendors — set the PO vendor manually."
        : "Awarded prices + vendor applied; quantities kept. Review before saving.", vendorIds0.length > 1 ? "info" : "success");
      return;
    }
    const existing = new Map((seed?.sections || []).map((s) => [s.styleCode, s]));
    const sections: SeedSection[] = [];
    const styleCodesSeen = new Set<string>();
    for (const q of chosen) {
      const prev = existing.get(q.style_code);
      const unit = q.quoted_cost != null ? String(q.quoted_cost) : undefined;
      sections.push(prev ? { ...prev, defaultUnit: unit } : { styleCode: q.style_code, cells: [], defaultUnit: unit });
      styleCodesSeen.add(q.style_code);
    }
    // Keep any existing sections that weren't part of the award picks.
    for (const s of seed?.sections || []) if (!styleCodesSeen.has(s.styleCode)) sections.push(s);
    const vendorIds = [...new Set(chosen.map((q) => q.vendor_id))];
    if (vendorIds.length === 1) setVendorId(vendorIds[0]);
    setSeedKey((k) => k + 1);
    setSeed({ sections, flat: seed?.flat || [] });
    setAwardOpen(false);
    if (vendorIds.length > 1) notify("Awarded prices applied. Heads-up: the selected awards span multiple vendors — a PO is to one vendor, so pick the vendor manually.", "info");
    else notify("Awarded prices + vendor applied — review before saving.", "success");
  }

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
      sales_order_id: salesOrderId || null,
    };
    // Revising an already-saved (non-draft) PO: tell the server to allow the edit
    // past the draft-only line lock + notify the vendor.
    if (!isNew && po && po.status !== "draft") body.revise = true;
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
    const revising = !isNew && po != null && po.status !== "draft";
    setSubmitting(true);
    try {
      const id = await save();
      if (id) { notify(revising ? "Revision saved — vendor notified (if on the portal)." : "Purchase order saved.", "success"); onSaved(); }
    }
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

  // Unsaved-changes guard: warn before closing (Close button or click-outside)
  // a NEW PO that carries data that hasn't been saved.
  function hasUnsavedData(): boolean {
    if (!isNew) return false;
    const hasLines = (bodyRef.current?.getStyleCodes() || []).length > 0;
    return hasLines || !!vendorId || !!salesOrderId || !!notes.trim() || !!poType || !!customerId
      || !!requestedDeliveryDate || !!expectedDate || !!cancelDate || !!shipWindowStart
      || !!vendorContact.trim() || !!vendorEmail.trim() || !!vendorRef.trim() || !!factoryLocation.trim()
      || !!season || !!channelId || !!departmentCategoryId;
  }
  async function requestClose() {
    if (submitting) return;
    if (hasUnsavedData() && !(await confirmDialog("This purchase order hasn't been saved. Close and discard your changes?"))) return;
    onClose();
  }

  // Audit trail for Vendor-confirmed ship changes: every time a style's
  // Vendor-confirmed date is edited, append a dated line to the order Notes
  // (operator: "keep track of all changes in the notes section, incl. the date").
  function logVendorConfirmedChange(styleCode: string, prev: string, next: string) {
    const today = fmtDateDisplay(new Date().toISOString().slice(0, 10));
    const from = prev ? fmtDateDisplay(prev) : "—";
    const to = next ? fmtDateDisplay(next) : "—";
    const entry = `[${today}] ${styleCode} Vendor-confirmed ship: ${from} → ${to}`;
    setNotes((n) => (n && n.trim() ? `${n}\n${entry}` : entry));
  }

  // Open the printable / downloadable PO document (logo + header + line items).
  function openView() {
    const fields: { label: string; value: string }[] = [];
    const add = (label: string, value: string | null | undefined) => { if (value && String(value).trim()) fields.push({ label, value: String(value) }); };
    add("Customer", customers.find((c) => c.id === customerId)?.name);
    add("PO type", poType);
    add("Vendor ref #", vendorRef);
    add("Order date", orderDate ? fmtDateDisplay(orderDate) : "");
    add("Requested delivery", requestedDeliveryDate ? fmtDateDisplay(requestedDeliveryDate) : "");
    add("Ship window", shipWindowStart || shipWindowEnd ? `${shipWindowStart ? fmtDateDisplay(shipWindowStart) : "?"} – ${shipWindowEnd ? fmtDateDisplay(shipWindowEnd) : "?"}` : "");
    add("Port date", portDate ? fmtDateDisplay(portDate) : "");
    add("Expected date", expectedDate ? fmtDateDisplay(expectedDate) : "");
    add("Vendor-confirmed", acknowledgedDate ? fmtDateDisplay(acknowledgedDate) : "");
    add("Cancel date", cancelDate ? fmtDateDisplay(cancelDate) : "");
    add("Ship to", warehouses.find((w) => w.id === shipToLocationId)?.name);
    add("Payment terms", paymentTerms.find((t) => t.id === paymentTermsId)?.name);
    add("Brand", brands.find((b) => b.id === brandId)?.name);
    add("Season", season);
    add("Channel", channels.find((c) => c.id === channelId)?.name);
    add("COO", coo);
    openOrderDocument({
      kind: "po",
      title: "Purchase Order",
      number: po?.po_number || "(draft)",
      status: po?.status || (isNew ? "draft" : null),
      partyLabel: "Vendor",
      partyName: vendors.find((v) => v.id === vendorId)?.name || "",
      moneyLabel: "Unit Cost $",
      fields,
      data: bodyRef.current?.getDocumentData() || { styles: [], flats: [] },
      notes,
    });
  }

  return (
    <div onClick={() => void requestClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(1180px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{isNew ? "New purchase order" : `Purchase order ${po?.po_number || "(draft)"} — ${po?.status}`}</h3>

        {/* Header collapse bar — when collapsed, only the vendor name shows; the
            full document header is one click away. Auto-collapses when the
            operator adds a style / line (see onAddLine on the matrix below). */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: C.textMuted }}>
            Vendor <b style={{ color: C.text, marginLeft: 6 }}>{vendors.find((v) => v.id === vendorId)?.name || (isNew ? "— not selected" : "—")}</b>
          </div>
          <button type="button" onClick={() => setHeaderCollapsed((c) => !c)} style={{ ...btnSecondary, fontSize: 12 }}>
            {headerCollapsed ? "▾ Show header details" : "▴ Hide header details"}
          </button>
        </div>

        {!headerCollapsed && (<>
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
            {/* Row 1 */}
            <Field label="Order date"><input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
            <Field label="Requested in DC"><input type="date" value={requestedDeliveryDate} onChange={(e) => setRequestedDeliveryDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
            <Field label="Port date"><input type="date" value={portDate} onChange={(e) => setPortDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
            <Field label="Expected date"><input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
            {/* Row 2 */}
            <Field label="Ship window start"><input type="date" value={shipWindowStart} onChange={(e) => setShipWindowStart(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
            <Field label="Ship window end"><input type="date" value={shipWindowEnd} onChange={(e) => setShipWindowEnd(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
            <Field label="Cancel date"><input type="date" value={cancelDate} onChange={(e) => setCancelDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
            <Field label="Vendor-confirmed / ack."><input type="date" value={acknowledgedDate} onChange={(e) => setAcknowledgedDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
          </div>
        </Section>

        {/* Logistics & destination */}
        <Section title="Logistics &amp; destination">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
            <Field label="Ship-to location / warehouse">
              <SearchableSelect value={shipToLocationId || null} onChange={(v) => setShipToLocationId(v || "")}
                options={[{ value: "", label: "(none)" }, ...warehouses.map((w) => ({ value: w.id, label: w.name, searchHaystack: `${w.name} ${w.code || ""}` }))]} placeholder="(none)" disabled={!editable} />
            </Field>
            <Field label="Bill-to entity">
              <SearchableSelect value={billToEntityId || null} onChange={(v) => setBillToEntityId(v || "")}
                options={[{ value: "", label: "(default entity)" }, ...entities.map((e) => ({ value: e.id, label: e.legal_name || e.name || e.code || e.id.slice(0, 8), searchHaystack: `${e.legal_name || e.name || ""} ${e.code || ""}` }))]} placeholder="(default entity)" disabled={!editable} />
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
                options={[{ value: "", label: "(entity default)" }, ...brands.map((b) => ({ value: b.id, label: b.name, searchHaystack: `${b.name} ${b.code || ""}` }))]} placeholder="(entity default)" disabled={!editable} />
            </Field>
            <Field label="Season">
              <SearchableSelect value={season || null} onChange={(v) => setSeason(v || "")}
                options={[{ value: "", label: "(none)" }, ...seasons.map((s) => ({ value: s.name, label: s.name }))]} placeholder="(none)" disabled={!editable} />
            </Field>
            <Field label="Channel">
              <SearchableSelect value={channelId || null} onChange={(v) => setChannelId(v || "")}
                options={[{ value: "", label: "(none)" }, ...channels.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.name} ${c.code || ""}` }))]} placeholder="(none)" disabled={!editable} />
            </Field>
            <Field label="Department">
              <SearchableSelect value={departmentCategoryId || null} onChange={(v) => setDepartmentCategoryId(v || "")}
                options={[{ value: "", label: "(none)" }, ...categories.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.name} ${c.category_code || ""}` }))]} placeholder="(none)" disabled={!editable} />
            </Field>
            <Field label="Payment terms">
              <SearchableSelect value={paymentTermsId || null} onChange={(v) => setPaymentTermsId(v)}
                options={[{ value: "", label: "(select)" }, ...paymentTerms.map((t) => ({ value: t.id, label: t.name, searchHaystack: `${t.name} ${t.code || ""}` }))]} placeholder="(select)" disabled={!editable} />
            </Field>
          </div>
        </Section>

        <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!editable} rows={3} style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }} placeholder="optional — Vendor-confirmed ship changes are logged here automatically" /></Field>
        </>)}

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

        {/* Build the matrix from an existing Sales Order (new PO only). */}
        {isNew && editable && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
            <button type="button" onClick={() => { setSoQuery(""); applyAwardAfterSO.current = false; setSoPickOpen(true); }} style={{ ...btnSecondary, color: C.primary, borderColor: C.primary }}>📋 Create from Sales Order</button>
            <button type="button" onClick={() => {
              // If the matrix already has styles (from an SO or added manually),
              // price THOSE in place — no "from an SO?" prompt, no qty reset.
              const codes = bodyRef.current?.getStyleCodes() || [];
              if (codes.length) { setAwardInPlace(true); void openAwardDialog(codes); }
              else { setAwardInPlace(false); setPriceAskOpen(true); }
            }} style={{ ...btnSecondary, color: C.success, borderColor: "#065f46" }}>💲 Get PO price</button>
            {salesOrderId && <span style={{ fontSize: 11, color: C.success }}>✓ linked to a sales order</span>}
          </div>
        )}

        {/* Line body — the shared size matrix, exactly like the Sales Order modal
            (mode="po": Unit Cost $ column, no margin / availability). Default-open. */}
        <div style={{ marginTop: 12, marginBottom: 12 }}>
          <LineMatrixBody
            key={seedKey}
            ref={bodyRef}
            mode="po"
            editable={editable}
            items={items}
            seed={seed}
            showOnHand={false}
            showLineDates
            lineDateDefault={requestedDeliveryDate}
            onAddLine={() => setHeaderCollapsed(true)}
            onVendorConfirmedChange={logVendorConfirmedChange}
          />
        </div>

        {/* Audit trail — who changed which field, when (T11 row_changes). */}
        {!isNew && po && (
          <div style={{ marginTop: 16 }}>
            <RowHistory source_table="purchase_orders" source_id={po.id} />
          </div>
        )}

        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

        <div style={{ position: "sticky", bottom: -20, zIndex: 3, background: C.card, borderTop: `1px solid ${C.cardBdr}`, margin: "0 -20px -20px", padding: "12px 20px", display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
          <button onClick={() => void requestClose()} style={btnSecondary} disabled={submitting}>Close</button>
          <button onClick={openView} style={btnSecondary} title="Open a printable / downloadable PO document">🖨 View</button>

          {/* Draft / new — the original save + issue flow. */}
          {(isNew || po?.status === "draft") && <button onClick={() => void saveDraft()} style={btnSecondary} disabled={submitting}>{submitting ? "Saving…" : "Save draft"}</button>}
          {(isNew || po?.status === "draft") && <button onClick={() => void transition("issued")} style={btnPrimary} disabled={submitting}>{submitting ? "…" : "Issue"}</button>}

          {/* Saved PO, not editing — ✎ Edit unlocks a full revision + status moves. */}
          {isRevisable && !editMode && <button onClick={() => setEditMode(true)} style={btnPrimary} disabled={submitting}>✎ Edit</button>}
          {isRevisable && !editMode && po?.status === "issued" && <button onClick={() => void transition("in_transit")} style={{ ...btnSecondary, color: C.warn, borderColor: "#92400e" }} disabled={submitting}>🚚 Mark in-transit</button>}
          {/* "Received" is no longer a manual flip — it's set when a goods receipt
              is POSTED (FIFO layers + GR/IR JE). 📥 Receive opens Receiving for this PO. */}
          {isRevisable && !editMode && (po?.status === "issued" || po?.status === "in_transit") && po?.id && (
            <button onClick={() => window.open(`?m=receiving&po=${encodeURIComponent(po.id)}`, "_blank", "noopener")} style={{ ...btnSecondary, color: C.success, borderColor: "#065f46" }} disabled={submitting} title="Open Receiving to record a goods receipt (posts inventory + GR/IR) — that's what marks the PO received">📥 Receive…</button>
          )}

          {/* Revising a saved PO — save the revision (notifies the vendor) or cancel. */}
          {isRevisable && editMode && <button onClick={() => setEditMode(false)} style={btnSecondary} disabled={submitting}>Cancel edit</button>}
          {isRevisable && editMode && <button onClick={() => void saveDraft()} style={btnPrimary} disabled={submitting}>{submitting ? "Saving…" : "💾 Save revision"}</button>}
        </div>
      </div>

      {/* Create-from-SO picker (dynamic search). */}
      {soPickOpen && (
        <div onClick={(e) => { e.stopPropagation(); if (!soBusy) setSoPickOpen(false); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(640px, 95vw)", maxHeight: "85vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>📋 Create PO from a Sales Order</h3>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>Pick a sales order — its styles, colors, sizes, and quantities fill the PO matrix. Unit costs stay blank (the SO carries selling prices, not costs).</div>
            <input type="text" value={soQuery} onChange={(e) => setSoQuery(e.target.value)} autoFocus placeholder="Search SO # / customer / style…" style={{ ...inputStyle, marginBottom: 10 }} />
            <div style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 6, overflow: "hidden" }}>
              {soList.length === 0 && <div style={{ padding: 12, color: C.textMuted, fontSize: 13 }}>No sales orders.</div>}
              {soList.map((so) => (
                <div key={so.id} onClick={() => !soBusy && void createFromSO(so.id)}
                  style={{ padding: "8px 12px", cursor: soBusy ? "default" : "pointer", borderBottom: `1px solid ${C.cardBdr}`, display: "flex", justifyContent: "space-between", gap: 8 }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "#0b1220"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = ""; }}>
                  <span style={{ fontSize: 13 }}>
                    <b>{so.so_number || "(draft)"}</b>
                    <span style={{ color: C.textMuted, marginLeft: 8 }}>{customers.find((c) => c.id === so.customer_id)?.name || ""}</span>
                  </span>
                  <span style={{ fontSize: 12, color: C.textMuted }}>{so.status}{so.requested_ship_date ? ` · ship ${fmtDateDisplay(so.requested_ship_date)}` : ""}</span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
              <button onClick={() => setSoPickOpen(false)} style={btnSecondary} disabled={soBusy}>{soBusy ? "Loading…" : "Cancel"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Get-PO-price: is this PO from an SO? */}
      {priceAskOpen && (
        <div onClick={(e) => { e.stopPropagation(); setPriceAskOpen(false); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 121 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(440px, 95vw)", color: C.text }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>💲 Get PO price</h3>
            <div style={{ fontSize: 13, color: C.textSub, marginBottom: 16 }}>Is this PO being created from a Sales Order?</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => { setPriceAskOpen(false); applyAwardAfterSO.current = true; setSoQuery(""); setSoPickOpen(true); }} style={btnPrimary}>Yes — pick the SO first</button>
              <button onClick={() => { setPriceAskOpen(false); void openAwardDialog(); }} style={btnSecondary}>No — just awarded prices</button>
            </div>
          </div>
        </div>
      )}

      {/* Awarded-RFQ picker. */}
      {awardOpen && (
        <div onClick={(e) => { e.stopPropagation(); setAwardOpen(false); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 121 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(680px, 95vw)", maxHeight: "85vh", overflowY: "auto", color: C.text }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>💲 Awarded RFQ prices — review</h3>
            {awardMissing.length > 0 && (
              <div style={{ padding: "8px 12px", background: "#3b2f0b", border: `1px solid ${C.warn}`, borderRadius: 6, color: C.warn, fontSize: 12, marginBottom: 12 }}>
                ⚠️ No awarded RFQ price for {awardMissing.length === 1 ? "this style" : "these styles"}: <strong>{awardMissing.join(", ")}</strong>. {awardQuotes.length === 0 ? "Nothing was priced from an award — set unit costs manually." : "Those styles are left unpriced; the rest are below."}
              </div>
            )}
            {awardQuotes.length > 0 && (
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>Retrieved the awarded cost for the styles below (newest award pre-selected; pick another if several exist). <strong>Accept</strong> stamps the cost onto the matrix{awardInPlace ? " (your quantities are kept)" : ""} and sets the vendor.</div>
            )}
            {[...new Set(awardQuotes.map((q) => q.style_code))].map((code) => {
              const opts = awardQuotes.filter((q) => q.style_code === code);
              return (
                <div key={code} style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: 10, marginBottom: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{code}</div>
                  {opts.map((q) => {
                    const active = awardPick[code] === q.costing_line_id;
                    return (
                      <label key={q.costing_line_id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer", fontSize: 13 }}>
                        <input type="radio" name={`award-${code}`} checked={active} onChange={() => setAwardPick((p) => ({ ...p, [code]: q.costing_line_id }))} />
                        <span style={{ color: C.text }}>{q.vendor_name || "(vendor)"}</span>
                        <span style={{ color: C.success, fontFamily: "monospace" }}>${q.quoted_cost != null ? q.quoted_cost.toFixed(2) : "—"} {q.currency}</span>
                        <span style={{ color: C.textMuted, fontSize: 12 }}>awarded {q.awarded_at ? fmtDateDisplay(q.awarded_at.slice(0, 10)) : (q.quoted_date ? fmtDateDisplay(q.quoted_date) : "—")}</span>
                      </label>
                    );
                  })}
                </div>
              );
            })}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button onClick={() => setAwardOpen(false)} style={btnSecondary}>{awardQuotes.length === 0 ? "Close" : "Cancel"}</button>
              {awardQuotes.length > 0 && <button onClick={applyAwards} style={btnPrimary}>Accept</button>}
            </div>
          </div>
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

// Grouped header section — a bordered block for the rich PO header. The group
// title is intentionally not rendered (operator: no per-box header); the prop is
// kept optional so callers can stay self-documenting.
function Section({ children }: { title?: string; children: React.ReactNode }) {
  return (
    <div style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
      {children}
    </div>
  );
}
