// src/tanda/InternalSalesOrders.tsx
//
// P16 / M10-B — native Sales Order entry. List + create/edit modal. Mirrors the
// AR-invoice modal patterns (customer/ship-to/brand/channel pickers, item
// SearchableSelect, supporting docs). SO number is system-assigned on Confirm.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtDateDisplay } from "../utils/tandaTypes";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import SearchableSelect from "./components/SearchableSelect";
import { readDrillParam } from "./scorecardDrill";
import LineMatrixBody, { type LineMatrixBodyHandle, type SeedSection, type FlatLine, type BodyTotals } from "./LineMatrixBody";
import { openOrderDocument } from "./orderDocument";
import DocumentAttachmentList from "../shared/documents/DocumentAttachmentList";
import StagedDocsPicker from "../shared/documents/StagedDocsPicker";
import { uploadStagedDocs } from "../shared/documents/uploadDocument";
import { notify, confirmDialog } from "../shared/ui/warn";
import {
  resolveLine, buildSeedFromResolved, matchCustomer, matchPaymentTerms, isoDate,
  type ParsedPo, type ParsedPoLine, type StyleLite, type LineResolution, type PrefillWarning,
} from "./lib/customerPoPrefill";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

// Universal column-visibility registry for this panel (operator ask #1).
const SO_TABLE_KEY = "tangerine:salesorders:columns";
const SO_COLUMNS: ColumnDef[] = [
  { key: "so_number",   label: "SO #" },
  { key: "customer",    label: "Customer" },
  { key: "order_date",  label: "Order date" },
  { key: "start_ship",  label: "Start Ship" },
  { key: "status",      label: "Status" },
  { key: "factor",      label: "Factor" },
  { key: "total",       label: "Total" },
];

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
// colorScheme:"dark" makes native controls (esp. <input type=date> text + the
// calendar/picker icon) render light-on-dark instead of the near-invisible
// dark-on-dark default — matches the Inventory Matrix inputs.
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box", colorScheme: "dark" };
// Item 7 — ~8-char numeric box with no browser spinner arrows (type=text + inputMode=decimal).
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };

// Approved $ is a comma-grouped, 2-decimal money field. Display carries the
// grouping commas; strip them with moneyToNumber() before persisting cents.
const moneyToNumber = (raw: string): number | null => {
  const t = (raw ?? "").replace(/,/g, "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const fmtMoneyComma = (raw: string): string => {
  const n = moneyToNumber(raw);
  return n == null ? "" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

type SO = {
  id: string; so_number: string | null; customer_id: string; ship_to_location_id: string | null;
  brand_id: string | null; channel_id: string | null; order_date: string; requested_ship_date: string | null;
  cancel_date: string | null; status: string; payment_terms_id: string | null; ar_account_id: string | null;
  buyer_id?: string | null; buyer_name?: string | null;
  revenue_account_id: string | null; notes: string | null; total_cents: number | string;
  customer_po?: string | null;
  fulfillment_source?: string | null;
  factor_approval_status?: string | null; factor_reference?: string | null; factor_approved_cents?: number | string | null;
  parent_sales_order_id?: string | null; is_split_parent?: boolean;
};
type Customer = { id: string; name: string; customer_code?: string; default_brand_id?: string | null; default_channel_id?: string | null; default_revenue_account_id?: string | null; is_factored?: boolean | null };
type Item = { id: string; sku_code: string; style_code?: string; description?: string; color?: string; size?: string };
type Lookup = { id: string; code?: string; name: string };
type ShipTo = { id: string; name: string; code?: string | null; location_type?: string | null; is_default?: boolean | null; address?: Record<string, unknown> | null };

// One-line address from a customer_locations.address jsonb ({line1,line2,city,
// state,postal_code,country}). Empty string when nothing is set.
function formatShipAddress(a: Record<string, unknown> | null | undefined): string {
  if (!a || typeof a !== "object") return "";
  const s = (k: string) => String(a[k] ?? "").trim();
  const cityLine = [s("city"), [s("state"), s("postal_code")].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [s("line1"), s("line2"), cityLine, s("country")].filter(Boolean).join(" · ");
}

function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0); const neg = n < 0; const abs = Math.abs(n);
  return `${neg ? "-" : ""}$${Math.trunc(abs / 100).toLocaleString()}.${String(Math.round(abs % 100)).padStart(2, "0")}`;
}
const STATUS_COLORS: Record<string, string> = {
  draft: C.textMuted, confirmed: C.primary, allocated: "#8B5CF6", fulfilling: C.warn,
  shipped: "#06B6D4", invoiced: C.success, closed: C.textSub, cancelled: C.danger,
};
// Item 3 — Factor/Ins approval states.
const FACTOR_STATUSES = ["not_submitted", "pending", "approved", "partial", "declined", "not_required"];
const FACTOR_COLORS: Record<string, string> = {
  not_submitted: C.textMuted, pending: C.warn, approved: C.success, partial: "#8B5CF6",
  declined: C.danger, not_required: C.textSub,
};

export default function InternalSalesOrders() {
  const [rows, setRows] = useState<SO[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  // Scorecard drill-through: ?customer=<id> seeds the customer filter on mount
  // so a click from the Customer Scorecard lands here pre-filtered.
  const [customerFilter, setCustomerFilter] = useState(() => readDrillParam("customer"));
  // PART 44 — reverse drill from the Allocations Workbench: clicking a SO #
  // sub-header navigates here with ?so=<SO#>; seed the SO search box with it so
  // this panel lands pre-filtered to that order (mirrors the ?customer= seed).
  // Server-side q is all-field (search_sales_orders RPC): matches SO #, notes,
  // customer name/code, and any line's style / SKU / line description.
  // Seed from ?q= (generic drill, e.g. the Inventory Snapshot's On-SO click →
  // style number) or the legacy ?so= deep-link.
  const { value: search, debouncedValue: searchDebounced, setValue: setSearch } = useDebouncedSearch(readDrillParam("q") || readDrillParam("so"), 200);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SO | null>(null);

  // Wave 5 — universal column show/hide.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(SO_TABLE_KEY, SO_COLUMNS);
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  const customerName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of customers) m[c.id] = c.name;
    return m;
  }, [customers]);

  // Export rows mirror the displayed list (same filter/search), with ids
  // resolved to human labels and cents kept in cents for currency formatting.
  const exportRows = useMemo(
    () =>
      rows.map((so) => ({
        so_number: so.so_number || "(draft)",
        customer: customerName[so.customer_id] || "—",
        order_date: so.order_date,
        start_ship: so.requested_ship_date || "",
        status: so.status,
        factor: so.factor_approval_status && so.factor_approval_status !== "not_submitted" ? so.factor_approval_status : "",
        total_cents: Number(so.total_cents ?? 0),
      })),
    [rows, customerName],
  );
  const exportColumns: ExportColumn<(typeof exportRows)[number]>[] = [
    { key: "so_number",  header: "SO #" },
    { key: "customer",   header: "Customer" },
    { key: "order_date", header: "Order date", format: "date" },
    { key: "start_ship", header: "Start Ship", format: "date" },
    { key: "status",     header: "Status" },
    { key: "factor",     header: "Factor" },
    { key: "total_cents", header: "Total", format: "currency_cents" },
  ];

  async function load() {
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (customerFilter) params.set("customer_id", customerFilter);
      if (searchDebounced.trim()) params.set("q", searchDebounced.trim());
      const r = await fetch(`/api/internal/sales-orders?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as SO[]);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [statusFilter, customerFilter, searchDebounced]);
  useEffect(() => {
    fetch("/api/internal/customer-master?limit=1000").then((r) => r.json())
      .then((a) => { if (Array.isArray(a)) setCustomers(a as Customer[]); }).catch(() => {});
  }, []);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>🛒 Sales Orders</h2>
        <button style={btnPrimary} onClick={() => { setEditing(null); setModalOpen(true); }}>+ New sales order</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ ...inputStyle, width: 180 }}>
          <option value="">All statuses</option>
          {["draft", "confirmed", "allocated", "fulfilling", "shipped", "invoiced", "closed", "cancelled"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <div style={{ width: 240 }}>
          <SearchableSelect value={customerFilter || null} onChange={(v) => setCustomerFilter(v)}
            options={[{ value: "", label: "All customers" }, ...customers.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.name} ${c.customer_code || ""}` }))]}
            placeholder="All customers" inputStyle={inputStyle} />
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search SO #, customer, style…" style={{ ...inputStyle, width: 240 }} />
        <button style={btnSecondary} onClick={() => void load()}>Refresh</button>
        <TablePrefsButton
          tableKey={SO_TABLE_KEY}
          columns={SO_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
        />
        <ExportButton rows={exportRows} filename="sales-orders" sheetName="Sales Orders" columns={exportColumns} />
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={th} hidden={!isVisible("so_number")}>SO #</th><th style={th} hidden={!isVisible("customer")}>Customer</th><th style={th} hidden={!isVisible("order_date")}>Order date</th>
            <th style={th} hidden={!isVisible("start_ship")}>Start Ship</th><th style={th} hidden={!isVisible("status")}>Status</th><th style={th} hidden={!isVisible("factor")}>Factor</th><th style={{ ...th, textAlign: "right" }} hidden={!isVisible("total")}>Total</th>
          </tr></thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={7}>Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={7}>No sales orders.</td></tr>}
            {rows.map((so) => (
              <tr key={so.id} style={{ cursor: "pointer" }} onClick={() => { setEditing(so); setModalOpen(true); }}>
                <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }} hidden={!isVisible("so_number")}>{so.so_number || <span style={{ color: C.textMuted }}>(draft)</span>}</td>
                <td style={td} hidden={!isVisible("customer")}>{customerName[so.customer_id] || "—"}</td>
                <td style={td} hidden={!isVisible("order_date")}>{fmtDateDisplay(so.order_date)}</td>
                <td style={td} hidden={!isVisible("start_ship")}>{so.requested_ship_date ? fmtDateDisplay(so.requested_ship_date) : "—"}</td>
                <td style={td} hidden={!isVisible("status")}><span style={{ color: STATUS_COLORS[so.status] || C.text, fontWeight: 600 }}>● {so.status}</span></td>
                <td style={td} hidden={!isVisible("factor")}>{so.factor_approval_status && so.factor_approval_status !== "not_submitted"
                  ? <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 6px", borderRadius: 4, color: FACTOR_COLORS[so.factor_approval_status] || C.text, border: `1px solid ${FACTOR_COLORS[so.factor_approval_status] || C.cardBdr}` }}>{so.factor_approval_status}</span>
                  : <span style={{ color: C.textMuted }}>—</span>}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!isVisible("total")}>{fmtCents(so.total_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <SOModal
          so={editing}
          customers={customers}
          onClose={() => { setModalOpen(false); setEditing(null); }}
          onSaved={() => { setModalOpen(false); setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

function SOModal({ so, customers, onClose, onSaved }: { so: SO | null; customers: Customer[]; onClose: () => void; onSaved: () => void }) {
  const isNew = so === null;
  // "Add styles" mode lets a CONFIRMED (not yet allocated/shipped/invoiced) SO
  // re-open its line grids to append styles. Base editability is draft-only.
  const [addMode, setAddMode] = useState(false);
  const editable = isNew || so?.status === "draft" || addMode;
  const canAddStyles = !isNew && so?.status === "confirmed" && !addMode;

  const [customerId, setCustomerId] = useState(so?.customer_id || "");
  const [shipToLocationId, setShipToLocationId] = useState(so?.ship_to_location_id || "");
  const [brandId, setBrandId] = useState(so?.brand_id || "");
  const [channelId, setChannelId] = useState(so?.channel_id || "");
  const [orderDate, setOrderDate] = useState(so?.order_date || new Date().toISOString().slice(0, 10));
  const [reqShip, setReqShip] = useState(so?.requested_ship_date || "");
  const [cancelDate, setCancelDate] = useState(so?.cancel_date || "");
  const [paymentTermsId, setPaymentTermsId] = useState(so?.payment_terms_id || "");
  // #1156 — optional buyer (the person at the customer who placed the order).
  const [buyerId, setBuyerId] = useState(so?.buyer_id || "");
  const [buyers, setBuyers] = useState<{ id: string; name: string; title: string | null }[]>([]);
  const [notes, setNotes] = useState(so?.notes || "");
  // Customer's PO number (their reference). Required before styles can be added.
  const [customerPo, setCustomerPo] = useState(so?.customer_po || "");
  // 🤖 AI customer-PO upload (new SO only). Dialog + parse + base/PPK disambig
  // + the post-prefill "double-check" review.
  const [poUploadOpen, setPoUploadOpen] = useState(false);
  const [poParsing, setPoParsing] = useState(false);
  const [poErr, setPoErr] = useState<string | null>(null);
  const [poText, setPoText] = useState("");
  const [poFileName, setPoFileName] = useState("");
  const [poB64, setPoB64] = useState("");
  const [poParsed, setPoParsed] = useState<ParsedPo | null>(null);
  const [poAmbig, setPoAmbig] = useState<{ res: LineResolution; pick: "base" | "ppk" }[]>([]);
  const [poReview, setPoReview] = useState<{ warnings: PrefillWarning[]; summary: string[]; unmatched: string[] } | null>(null);
  const [allStyles, setAllStyles] = useState<StyleLite[]>([]);
  const [fulfillmentSource, setFulfillmentSource] = useState(so?.fulfillment_source || "");
  // True when an uploaded customer PO auto-chose ATS and the operator hasn't yet
  // confirmed/changed it — highlights the Fulfillment source for a double-check.
  const [fulfillmentReview, setFulfillmentReview] = useState(false);
  // MX-SO — the line body IS the size matrix (per-style color×size grids) + a
  // few non-matrix flat lines. The body owns its state; we read it at save via
  // the imperative resolve() handle. `seed` rebuilds the grids when editing.
  const bodyRef = useRef<LineMatrixBodyHandle>(null);
  const [seed, setSeed] = useState<{ sections: SeedSection[]; flat: FlatLine[] } | null>(null);
  // Bump to force LineMatrixBody to remount + re-seed (used after an AI PO
  // prefill replaces the grids; the body otherwise seeds only once).
  const [seedKey, setSeedKey] = useState(0);
  // The body reports its totals up via onTotalsChange; the prominent totals now
  // render inside the matrix body (big line), so we only keep the setter.
  const [, setBodyTotals] = useState<BodyTotals>({ qty: 0, cents: 0, costCents: 0, marginPct: 0, marginEstimated: true });
  const [stagedDocs, setStagedDocs] = useState<File[]>([]);
  // Item 3 — Factor / credit-insurance approval (manual entry; Rosenthal API auto-fill reserved).
  const [factorStatus, setFactorStatus] = useState(so?.factor_approval_status || "not_submitted");
  const [factorReference, setFactorReference] = useState(so?.factor_reference || "");
  const [factorApprovedDollars, setFactorApprovedDollars] = useState(
    so?.factor_approved_cents != null && so.factor_approved_cents !== "" ? fmtMoneyComma(String(Number(so.factor_approved_cents) / 100)) : "");

  const [items, setItems] = useState<Item[]>([]);
  const [brands, setBrands] = useState<Lookup[]>([]);
  const [channels, setChannels] = useState<Lookup[]>([]);
  const [paymentTerms, setPaymentTerms] = useState<Lookup[]>([]);
  const [shipTos, setShipTos] = useState<ShipTo[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // M10-C — the AR invoice this SO was billed into (NULL until invoiced). Drives
  // the green, clickable "→ invoice" header. Most-recent non-void invoice wins.
  const [relatedInvoice, setRelatedInvoice] = useState<{ id: string; invoice_number: string } | null>(null);

  useEffect(() => {
    fetch("/api/internal/items?limit=5000").then((r) => r.ok ? r.json() : []).then((a) => setItems(Array.isArray(a) ? a : [])).catch(() => {});
    fetch("/api/internal/brands").then((r) => r.json()).then((d) => setBrands(Array.isArray(d.brands) ? d.brands : [])).catch(() => {});
    fetch("/api/internal/channels").then((r) => r.json()).then((d) => setChannels(Array.isArray(d.channels) ? d.channels : [])).catch(() => {});
    fetch("/api/internal/payment-terms?limit=200").then((r) => r.json()).then((a) => setPaymentTerms(Array.isArray(a) ? a : [])).catch(() => {});
  }, []);

  // Load an existing SO's lines when editing → rebuild the matrix body. Lines
  // that decompose to style_code + size group into per-style matrix sections
  // (qty per color×size cell); anything else (no style/size) falls to the
  // non-matrix flat list. The detail endpoint decorates each line with its
  // style_code/color/size/sku_code.
  useEffect(() => {
    if (isNew || !so) return;
    type DLine = { inventory_item_id: string | null; qty_ordered: number; unit_price_cents: number; style_code: string | null; color: string | null; size: string | null; inseam: string | null; sku_code: string | null };
    fetch(`/api/internal/sales-orders/${so.id}`).then((r) => r.ok ? r.json() : null).then((full) => {
      if (!full?.lines) return;
      const byStyle = new Map<string, SeedSection>();
      const flat: FlatLine[] = [];
      let fk = 1;
      for (const l of (full.lines as DLine[])) {
        const dollars = l.unit_price_cents != null ? (l.unit_price_cents / 100).toFixed(2) : "";
        if (l.style_code && l.size) {
          let sec = byStyle.get(l.style_code);
          if (!sec) { sec = { styleCode: l.style_code, cells: [] }; byStyle.set(l.style_code, sec); }
          sec.cells.push({ color: l.color, size: l.size, inseam: l.inseam ?? null, qty: Number(l.qty_ordered) || 0, unit: dollars || undefined });
        } else {
          flat.push({ key: fk++, inventory_item_id: l.inventory_item_id || "", qty_ordered: String(l.qty_ordered ?? ""), unit_price_dollars: dollars, label: l.sku_code ? `${l.sku_code}${l.style_code ? ` — ${l.style_code}` : ""}` : undefined });
        }
      }
      setSeed({ sections: [...byStyle.values()], flat });
    }).catch(() => {});
  }, [isNew, so]);

  // M10-C — resolve the AR invoice generated from this SO (if any) so the
  // header can turn green and link straight to it. Picks the most recent
  // non-void invoice carrying this sales_order_id.
  useEffect(() => {
    if (isNew || !so) { setRelatedInvoice(null); return; }
    let cancel = false;
    fetch(`/api/internal/ar-invoices?sales_order_id=${encodeURIComponent(so.id)}&limit=1`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        if (cancel) return;
        const inv = Array.isArray(rows) ? rows[0] : null;
        setRelatedInvoice(inv?.invoice_number ? { id: inv.id, invoice_number: inv.invoice_number } : null);
      })
      .catch(() => { if (!cancel) setRelatedInvoice(null); });
    return () => { cancel = true; };
  }, [isNew, so]);

  // The customer's ship-to locations. Pre-fill the ship-to from the customer
  // master: pick the customer's DEFAULT location (or the only one) so the
  // operator doesn't re-key it on every SO. Only fills when none is set yet.
  useEffect(() => {
    if (!customerId) { setShipTos([]); return; }
    let cancel = false;
    fetch(`/api/internal/customer-locations?customer_id=${encodeURIComponent(customerId)}`)
      .then((r) => r.ok ? r.json() : [])
      .then((a: ShipTo[]) => {
        if (cancel) return;
        const locs = Array.isArray(a) ? a : [];
        setShipTos(locs);
        // Prefer the explicit default; fall back to the only location.
        const pre = locs.find((l) => l.is_default) || (locs.length === 1 ? locs[0] : null);
        if (pre && !shipToLocationId) setShipToLocationId(pre.id);
      })
      .catch(() => {});
    return () => { cancel = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  // #1156 — the customer's buyers, for the optional Buyer picker.
  useEffect(() => {
    if (!customerId) { setBuyers([]); return; }
    let cancel = false;
    fetch(`/api/internal/customer-buyers?customer_id=${encodeURIComponent(customerId)}`).then((r) => r.ok ? r.json() : []).then((a) => { if (!cancel) setBuyers(Array.isArray(a) ? a as { id: string; name: string; title: string | null }[] : []); }).catch(() => {});
    return () => { cancel = true; };
  }, [customerId]);

  // Channel id for a channel_master code (e.g. "DTC", "WHOLESALE"), case-insensitive.
  const channelIdByCode = useCallback(
    (code: string) => channels.find((c) => (c.code || "").toUpperCase() === code.toUpperCase())?.id || "",
    [channels],
  );
  // A customer is DTC when its name is a Shopify storefront; everyone else is
  // Wholesale. (Matches the sync convention: customer name contains "shopify".)
  const channelForCustomer = useCallback(
    (c: Customer | undefined) => (c && /shopify/i.test(c.name || "") ? channelIdByCode("DTC") : channelIdByCode("WHOLESALE")),
    [channelIdByCode],
  );

  // Picking a customer auto-fills the Channel from the customer (Shopify ⇒ DTC,
  // else Wholesale) and seeds Brand from the customer default (the selected
  // style overrides Brand — see the LineMatrixBody onPrimaryBrandChange wiring).
  function pickCustomer(v: string) {
    setCustomerId(v);
    setShipToLocationId("");
    setBuyerId(""); // buyer belongs to the customer — clear when the customer changes
    const c = customers.find((x) => x.id === v);
    if (!c) return;
    const ch = channelForCustomer(c);
    if (ch) setChannelId(ch);
    if (isNew && c.default_brand_id) setBrandId((cur) => cur || c.default_brand_id || "");
  }

  // Channels load asynchronously — if a customer was already chosen before the
  // channel list arrived and Channel is still empty, derive it once they load.
  useEffect(() => {
    if (!customerId || channelId || channels.length === 0) return;
    const ch = channelForCustomer(customers.find((x) => x.id === customerId));
    if (ch) setChannelId(ch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, customerId]);

  // ── 🤖 AI customer-PO upload ───────────────────────────────────────────────
  // Lazily load the style catalogue (with attributes.size_scale_pack) the first
  // time the upload dialog opens — needed to resolve style codes + scales.
  async function ensureStyles(): Promise<StyleLite[]> {
    if (allStyles.length) return allStyles;
    const r = await fetch("/api/internal/style-master?limit=10000");
    const a = r.ok ? await r.json() : [];
    const list = (Array.isArray(a) ? a : []) as StyleLite[];
    setAllStyles(list);
    return list;
  }
  // Style → matrix size columns (cached per style id within this parse).
  const sizeCache = useRef<Map<string, { sizes: string[]; colors: string[] }>>(new Map());
  async function fetchMatrix(styleId: string): Promise<{ sizes: string[]; colors: string[] }> {
    if (sizeCache.current.has(styleId)) return sizeCache.current.get(styleId)!;
    const r = await fetch(`/api/internal/style-matrix?style_id=${encodeURIComponent(styleId)}`);
    const p = r.ok ? await r.json() : null;
    const out = {
      sizes: Array.isArray(p?.sizes) ? p.sizes : [],
      colors: Array.isArray(p?.colors) ? p.colors : [],
    };
    sizeCache.current.set(styleId, out);
    return out;
  }
  // The picked PO file is kept so it can be auto-attached to the SO on save.
  const poFileRef = useRef<File | null>(null);
  function pickFile(file: File) {
    setPoFileName(file.name);
    poFileRef.current = file;
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      setPoB64(result.includes(",") ? result.split(",")[1] : result); // strip data: prefix
    };
    reader.readAsDataURL(file);
  }
  async function parsePO() {
    setPoErr(null); setPoParsing(true); setPoReview(null);
    try {
      const payload = poB64 ? { filename: poFileName, base64: poB64 } : { text: poText };
      const r = await fetch("/api/internal/sales-orders/parse-customer-po", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const parsed = j.parsed as ParsedPo;
      setPoParsed(parsed);
      const styles = await ensureStyles();
      // Detect base/PPK ambiguity; if any, ask before building the seed.
      const ambig = parsed.lines
        .map((l) => resolveLine(l, styles))
        .filter((res) => res.ambiguous)
        .map((res) => ({ res, pick: "base" as "base" | "ppk" }));
      if (ambig.length) { setPoAmbig(ambig); }
      else { await applyParsed(parsed, styles, {}); }
    } catch (e) {
      setPoErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPoParsing(false);
    }
  }
  // Build the prefill + header from a parsed PO. `picks` maps an ambiguous line's
  // style_code (lower) → the chosen variant.
  async function applyParsed(parsed: ParsedPo, styles: StyleLite[], picks: Record<string, "base" | "ppk">) {
    const summary: string[] = [];
    const unmatched: string[] = [];

    // Header
    if (parsed.customer_po_number) { setCustomerPo(parsed.customer_po_number); summary.push(`PO # ${parsed.customer_po_number}`); }
    const custId = matchCustomer(parsed.customer_name, customers);
    if (custId) { setCustomerId(custId); summary.push(`Customer: ${customers.find((c) => c.id === custId)?.name}`); }
    else if (parsed.customer_name) unmatched.push(`Customer "${parsed.customer_name}" — pick manually`);
    const ptId = matchPaymentTerms(parsed.payment_terms, paymentTerms);
    if (ptId) { setPaymentTermsId(ptId); summary.push(`Terms: ${paymentTerms.find((t) => t.id === ptId)?.name}`); }
    else if (parsed.payment_terms) unmatched.push(`Payment terms "${parsed.payment_terms}" — pick manually`);
    const ss = isoDate(parsed.start_ship_date); if (ss) { setReqShip(ss); summary.push(`Start ship ${fmtDateDisplay(ss)}`); }
    const cd = isoDate(parsed.cancel_date); if (cd) { setCancelDate(cd); summary.push(`Cancel ${fmtDateDisplay(cd)}`); }
    // An uploaded customer PO is fulfilled from stock by default — auto-pick ATS
    // and flag the field so the operator confirms (or switches to Production).
    setFulfillmentSource("ats"); setFulfillmentReview(true); summary.push("Fulfillment: ATS (please confirm)");

    // Resolve each line to a chosen style (apply disambiguation picks).
    const resolved: { line: ParsedPoLine; chosen: StyleLite }[] = [];
    for (const line of parsed.lines) {
      const res = resolveLine(line, styles);
      let chosen = res.chosen;
      if (res.ambiguous) {
        const pick = picks[(line.style_code || "").toLowerCase()] || "base";
        chosen = pick === "ppk" ? res.ppk : res.base;
      }
      // res.line carries any style/color split out of a combined "STYLE-COLOR" code.
      if (chosen) resolved.push({ line: res.line, chosen });
      else unmatched.push(`Style "${line.style_code || line.description || "?"}" — not found, add manually`);
    }

    sizeCache.current.clear();
    const { sections, warnings } = await buildSeedFromResolved(resolved, fetchMatrix);
    if (sections.length) {
      // Reset the seed so the body re-seeds with the prefilled grids.
      setSeedKey((k) => k + 1);
      setSeed({ sections, flat: [] });
      summary.push(`${sections.length} style${sections.length === 1 ? "" : "s"} prefilled`);
    }
    // Auto-attach the uploaded PO file to the SO's supporting documents (staged;
    // uploaded on save). Skip the paste-text path (no file).
    if (poFileRef.current) {
      const f = poFileRef.current;
      setStagedDocs((prev) => prev.some((x) => x.name === f.name && x.size === f.size) ? prev : [...prev, f]);
      summary.push(`Attached ${f.name}`);
    }
    setPoReview({ warnings, summary, unmatched });
    setPoAmbig([]);
    setPoUploadOpen(false);
  }
  // Round every partial-carton (×24) prefilled size UP to a full carton, per the
  // operator's "update qtys to full cartons" choice in the review banner.
  function roundReviewToCartons() {
    if (!poParsed) return;
    void (async () => {
      const styles = allStyles.length ? allStyles : await ensureStyles();
      const resolved: { line: ParsedPoLine; chosen: StyleLite }[] = [];
      for (const line of poParsed.lines) {
        const res = resolveLine(line, styles);
        const chosen = res.chosen || (res.ambiguous ? res.base : undefined);
        if (!chosen) continue;
        // res.line carries any split-out style/color from a combined code.
        const baseLine = res.line;
        // Round each per-size cell up to a full carton of 24 (non-PPK only).
        const roundedLine: ParsedPoLine = res.ambiguous || !baseLine.size_breakdown ? baseLine : {
          ...baseLine,
          size_breakdown: baseLine.size_breakdown.map((sb) => ({ size: sb.size, qty: Math.ceil(Math.max(0, sb.qty) / 24) * 24 })),
        };
        resolved.push({ line: roundedLine, chosen });
      }
      sizeCache.current.clear();
      const { sections, warnings } = await buildSeedFromResolved(resolved, fetchMatrix);
      setSeedKey((k) => k + 1);
      setSeed({ sections, flat: [] });
      setPoReview((prev) => prev ? { ...prev, warnings, summary: [...prev.summary, "Rounded sizes up to full cartons"] } : prev);
    })();
  }

  async function save(confirm: boolean) {
    setErr(null);
    if (!customerId) { setErr("Pick a customer."); return; }
    if (!shipToLocationId) { setErr("Pick a Ship-to address."); return; }
    if (!fulfillmentSource) { setErr("Select a Fulfillment source — ATS (ship from stock) or Production (make it)."); return; }
    setSubmitting(true);
    // Resolve the matrix grids + flat lines → SO line payload (find-or-create
    // SKUs). Done before the header build so a resolve error surfaces cleanly.
    let resolvedLines: { inventory_item_id: string | null; qty_ordered: number; unit_price_cents: number }[] = [];
    try {
      resolvedLines = (await bodyRef.current?.resolve()) || [];
    } catch (e) {
      setErr(`Could not resolve order lines: ${e instanceof Error ? e.message : String(e)}`);
      setSubmitting(false);
      return;
    }
    if (resolvedLines.length === 0) { setErr("Add at least one line with a quantity."); setSubmitting(false); return; }
    try {
      const body: Record<string, unknown> = {
        customer_id: customerId, ship_to_location_id: shipToLocationId || null,
        brand_id: brandId || null, channel_id: channelId || null,
        order_date: orderDate, requested_ship_date: reqShip || null, cancel_date: cancelDate || null,
        payment_terms_id: paymentTermsId || null, buyer_id: buyerId || null, notes: notes.trim() || null, lines: resolvedLines,
        customer_po: customerPo.trim() || null,
        fulfillment_source: fulfillmentSource || null,
        // Item 3 — factor / credit-insurance approval (manual).
        factor_approval_status: factorStatus,
        factor_reference: factorReference.trim() || null,
        factor_approved_cents: moneyToNumber(factorApprovedDollars) == null ? null : Math.round((moneyToNumber(factorApprovedDollars) || 0) * 100),
      };

      let soId = so?.id || null;
      if (isNew) {
        const r = await fetch("/api/internal/sales-orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        const created = await r.json();
        soId = created?.id || null;
        if (soId && stagedDocs.length > 0) {
          try { await uploadStagedDocs("sales_orders", soId, stagedDocs); }
          catch (e) { notify(`SO saved, but a document upload failed: ${e instanceof Error ? e.message : String(e)}`, "error"); }
        }
      } else {
        const r = await fetch(`/api/internal/sales-orders/${so!.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      }

      if (confirm && soId) {
        const r = await fetch(`/api/internal/sales-orders/${soId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "confirmed" }) });
        if (!r.ok) throw new Error(`Saved, but confirm failed: ${(await r.json().catch(() => ({}))).error || `HTTP ${r.status}`}`);
        const cj = await r.json().catch(() => ({}));
        notify("Sales order confirmed — SO number assigned.", "success");
        if (cj?.production_notice?.skipped) notify(cj.production_notice.reason || "Production order: no Production recipient configured.", "info");
        else if (cj?.production_notice?.sent) notify(`Production Manager notified (${cj.production_notice.sent} recipient${cj.production_notice.sent === 1 ? "" : "s"}).`, "success");
      }
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  // M10-C — generate a draft AR invoice from this SO's open lines.
  const canInvoice = !isNew && so != null && ["confirmed", "allocated", "fulfilling", "shipped"].includes(so.status);
  async function createInvoice() {
    if (!so) return;
    setErr(null); setSubmitting(true);
    try {
      const r = await fetch(`/api/internal/sales-orders/${so.id}/create-invoice`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify(j.message || `Draft AR invoice ${j.invoice_number} created.`, "success");
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  // M18 — allocate available on-hand stock to this SO's lines (confirmed/allocated).
  const canAllocate = !isNew && so != null && ["confirmed", "allocated"].includes(so.status);
  // PART 40 — once a SO has allocation, jump straight to the Allocations
  // Workbench focused on this order (mirrors the scorecard drill: ?m=…&so=<#>).
  // Seeded by SO number so the workbench's search lands pre-filtered to it.
  function openAllocations() {
    if (!so) return;
    const key = so.so_number || so.id; // number when assigned, else id fallback
    window.location.href = `?m=sales_allocations&so=${encodeURIComponent(key)}`;
  }
  async function allocate() {
    if (!so) return;
    // Gate: if the SO has no ship-to location and the customer has more than
    // one, ask the operator to assign one before proceeding.
    if (!shipToLocationId && shipTos.length > 1) {
      const opts = shipTos.map((s) => `${s.code ? s.code + " — " : ""}${s.name}`).join("\n");
      const ok = await confirmDialog(
        `This order has no ship-to location assigned.\n\n` +
        `${customerId ? `Customer has ${shipTos.length} locations:\n${opts}\n\n` : ""}` +
        `Please select a ship-to location above before allocating, or continue without one.`,
        "Select location before allocating",
      );
      if (!ok) return;
    }
    setErr(null); setSubmitting(true);
    try {
      const r = await fetch(`/api/internal/sales-orders/${so.id}/allocate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify(j.message || "Allocation run complete.", j.fully_allocated ? "success" : "info");
      onSaved();
      // Auto-open the Allocations window focused on this SO so the user can
      // view/edit the resulting allocation immediately.
      openAllocations();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  // M44 — ship an allocated SO (record carrier + tracking; bumps qty_shipped).
  const canShip = !isNew && so != null && ["allocated", "fulfilling"].includes(so.status);
  const [shipOpen, setShipOpen] = useState(false);
  const [shipCarrier, setShipCarrier] = useState("");
  const [shipTracking, setShipTracking] = useState("");
  const [shipDate, setShipDate] = useState(new Date().toISOString().slice(0, 10));
  const [carrierOptions, setCarrierOptions] = useState<{ value: string; label: string }[]>([]);
  async function openShipModal() {
    setShipOpen(true);
    // Load carriers for the SearchableSelect on modal open (non-blocking).
    try {
      const r = await fetch("/api/internal/carriers");
      if (r.ok) {
        const data = await r.json() as { code: string; name: string }[];
        setCarrierOptions(data.map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` })));
      }
    } catch {
      // silently ignore — operator can still type a carrier name manually
    }
  }

  async function shipOrder() {
    if (!so) return;
    setErr(null); setSubmitting(true);
    try {
      const r = await fetch(`/api/internal/sales-orders/${so.id}/ship`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ carrier: shipCarrier.trim() || null, tracking_number: shipTracking.trim() || null, ship_date: shipDate }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify(j.message || "Shipment recorded.", j.sales_order_status === "shipped" ? "success" : "info");
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  // Item 15 — split a draft SO across multiple of the customer's stores/DCs.
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitLocs, setSplitLocs] = useState<string[]>([]);
  const canSplit = !isNew && so != null && so.status === "draft" && !so.is_split_parent && shipTos.length >= 2;
  function toggleSplitLoc(locId: string) {
    setSplitLocs((p) => (p.includes(locId) ? p.filter((x) => x !== locId) : [...p, locId]));
  }
  async function splitOrder() {
    if (!so) return;
    if (splitLocs.length < 2) { setErr("Pick at least two locations to split across."); return; }
    setErr(null); setSubmitting(true);
    try {
      const r = await fetch(`/api/internal/sales-orders/${so.id}/split`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location_ids: splitLocs }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify(j.message || `Split into ${j.count} per-store sales orders.`, "success");
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  // Shared Save / Close actions — rendered in the sticky footer AND in a
  // duplicate bar at the top of the modal. On a CONFIRMED order the matrix stays
  // editable (e.g. to fill in unit prices); save(false) PATCHes the lines
  // without changing status, so we surface a plain "Save" there too.
  // Unsaved-changes guard: warn before closing (Close button or click-outside)
  // when the order carries data that hasn't been saved.
  function hasUnsavedData(): boolean {
    const hasLines = (bodyRef.current?.getStyleCodes() || []).length > 0;
    if (isNew) {
      return hasLines || !!customerId || !!customerPo.trim() || !!notes.trim() || !!reqShip || !!cancelDate
        || !!shipToLocationId || !!brandId || !!channelId || !!buyerId || !!paymentTermsId || !!fulfillmentSource;
    }
    return addMode; // editing an existing SO — warn only once they start adding/editing lines
  }
  async function requestClose() {
    if (submitting) return;
    if (hasUnsavedData() && !(await confirmDialog("This sales order hasn't been saved. Close and discard your changes?"))) return;
    onClose();
  }

  // Open the printable / downloadable SO document (logo + header + line items).
  function openView() {
    const fields: { label: string; value: string }[] = [];
    const add = (label: string, value: string | null | undefined) => { if (value && String(value).trim()) fields.push({ label, value: String(value) }); };
    add("Customer PO #", customerPo);
    add("Order date", orderDate ? fmtDateDisplay(orderDate) : "");
    add("Requested ship", reqShip ? fmtDateDisplay(reqShip) : "");
    add("Cancel date", cancelDate ? fmtDateDisplay(cancelDate) : "");
    add("Payment terms", paymentTerms.find((t) => t.id === paymentTermsId)?.name);
    add("Brand", brands.find((b) => b.id === brandId)?.name);
    add("Channel", channels.find((c) => c.id === channelId)?.name);
    add("Fulfillment", fulfillmentSource);
    openOrderDocument({
      kind: "so",
      title: "Sales Order",
      number: so?.so_number || "(draft)",
      status: so?.status || (isNew ? "draft" : null),
      partyLabel: "Customer",
      partyName: customers.find((c) => c.id === customerId)?.name || "",
      moneyLabel: "Unit $",
      fields,
      lines: bodyRef.current?.getDocumentLines() || [],
      notes,
    });
  }

  const saveCloseButtons = (
    <>
      <button onClick={() => void requestClose()} style={btnSecondary} disabled={submitting}>Close</button>
      <button onClick={openView} style={btnSecondary} title="Open a printable / downloadable SO document">🖨 View</button>
      {editable && <button onClick={() => void save(false)} style={btnSecondary} disabled={submitting}>{submitting ? "Saving…" : isNew ? "Create draft" : addMode ? "Save changes" : "Save draft"}</button>}
      {editable && !addMode && <button onClick={() => void save(true)} style={btnPrimary} disabled={submitting}>{submitting ? "…" : "Save & Confirm"}</button>}
      {!editable && !isNew && so?.status === "confirmed" && <button onClick={() => void save(false)} style={btnPrimary} disabled={submitting}>{submitting ? "Saving…" : "Save"}</button>}
    </>
  );

  return (
    <div onClick={() => void requestClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(1180px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        {/* When the SO has been billed into an AR invoice, the header turns
            green and links straight to that invoice (?m=ar_invoices&q=<INV#>).
            Otherwise it's the plain "Sales order … — <status>" title. */}
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {isNew ? "New sales order" : relatedInvoice ? (
            <span
              onClick={() => { window.location.href = `?m=ar_invoices&q=${encodeURIComponent(relatedInvoice.invoice_number)}`; }}
              title={`Open AR invoice ${relatedInvoice.invoice_number}`}
              style={{ color: C.success, cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted" }}
            >
              Sales order {so?.so_number || "(draft)"} — {so?.status} · 🧾 {relatedInvoice.invoice_number} ↗
            </span>
          ) : (
            `Sales order ${so?.so_number || "(draft)"} — ${so?.status}`
          )}
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Customer">
            <SearchableSelect value={customerId || null} onChange={(v) => pickCustomer(v)}
              options={customers.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.name} ${c.customer_code || ""}` }))}
              placeholder="(pick customer…)" disabled={!editable} />
          </Field>
          <Field label="Buyer (optional)">
            <SearchableSelect value={buyerId || null} onChange={(v) => setBuyerId(v)}
              options={[{ value: "", label: "(none)" }, ...buyers.map((b) => ({ value: b.id, label: b.title ? `${b.name} — ${b.title}` : b.name }))]}
              placeholder={customerId ? (buyers.length ? "(none)" : "(no buyers on this customer)") : "(pick customer first)"}
              disabled={!editable || !customerId} />
          </Field>
          <Field label="Ship-to address *">
            <SearchableSelect value={shipToLocationId || null} onChange={(v) => setShipToLocationId(v)}
              options={[{ value: "", label: "(select)" }, ...shipTos.map((s) => ({ value: s.id, label: s.code ? `${s.code} — ${s.name}` : s.name }))]}
              placeholder={customerId ? "(select)" : "(pick customer first)"} disabled={!editable || !customerId} />
            {(() => {
              const sel = shipTos.find((s) => s.id === shipToLocationId);
              const addr = formatShipAddress(sel?.address);
              if (sel && addr) return <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>{addr}</div>;
              if (editable && customerId && !shipToLocationId) return <div style={{ fontSize: 11, color: C.warn, marginTop: 4 }}>Required — pick the ship-to address before adding styles.</div>;
              return null;
            })()}
          </Field>
          <Field label="SO number"><input type="text" value={so?.so_number || ""} readOnly disabled placeholder="(assigned on confirm)" style={{ ...inputStyle, opacity: 0.6 }} /></Field>
        </div>

        {/* Customer PO number — the buyer's reference. Required before styles can
            be added (gates the matrix's Add buttons below). Also the field the
            AI "Upload customer PO" flow fills in. */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12, alignItems: "start" }}>
          <Field label="Customer PO # *">
            <input type="text" value={customerPo} onChange={(e) => setCustomerPo(e.target.value)} disabled={!editable}
              style={{ ...inputStyle, borderColor: editable && !customerPo.trim() ? C.warn : C.cardBdr }}
              placeholder="the customer's PO number" />
            {editable && !customerPo.trim() && (
              <div style={{ fontSize: 11, color: C.warn, marginTop: 4 }}>Required — enter the customer PO before adding styles.</div>
            )}
          </Field>
          {isNew && editable && (
            <Field label="Or auto-fill from the customer's PO">
              <button type="button" onClick={() => { setPoErr(null); setPoReview(null); setPoAmbig([]); setPoUploadOpen(true); }}
                style={{ ...btnSecondary, color: C.primary, borderColor: C.primary, width: "100%" }}>
                🤖 Upload customer PO
              </button>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>PDF, Excel/CSV, or paste the email — AI fills the header + matrix.</div>
            </Field>
          )}
        </div>

        {/* Post-prefill "double-check" review banner. */}
        {poReview && (
          <div style={{ marginBottom: 12, padding: "10px 12px", background: "#0b1f17", border: `1px solid ${C.success}`, borderRadius: 8 }}>
            <div style={{ color: C.success, fontWeight: 700, fontSize: 13, marginBottom: 4 }}>🤖 Prefilled from the customer PO — please double-check everything before saving.</div>
            {poReview.summary.length > 0 && <div style={{ fontSize: 12, color: C.textSub }}>{poReview.summary.join(" · ")}</div>}
            {poReview.unmatched.length > 0 && (
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: C.warn, fontSize: 12 }}>
                {poReview.unmatched.map((u, i) => <li key={i}>{u}</li>)}
              </ul>
            )}
            {poReview.warnings.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <ul style={{ margin: 0, paddingLeft: 18, color: C.warn, fontSize: 12 }}>
                  {poReview.warnings.map((w, i) => <li key={i}><strong>{w.style}</strong> — {w.detail}</li>)}
                </ul>
                {poReview.warnings.some((w) => /not a full carton/.test(w.detail)) && (
                  <button type="button" onClick={roundReviewToCartons} style={{ ...btnSecondary, marginTop: 6, color: C.warn, borderColor: C.warn, fontSize: 12, padding: "4px 10px" }}>
                    Round those sizes up to full cartons
                  </button>
                )}
              </div>
            )}
            <button type="button" onClick={() => setPoReview(null)} style={{ ...btnSecondary, marginTop: 8, fontSize: 12, padding: "4px 10px" }}>Dismiss</button>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Order date"><input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
          <Field label="Start Ship"><input type="date" value={reqShip} onChange={(e) => setReqShip(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
          <Field label="Cancel date"><input type="date" value={cancelDate} onChange={(e) => setCancelDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
          <Field label="Payment terms">
            <SearchableSelect value={paymentTermsId || null} onChange={(v) => setPaymentTermsId(v)}
              options={[{ value: "", label: "(select)" }, ...paymentTerms.map((t) => ({ value: t.id, label: t.name, searchHaystack: `${t.name} ${t.code || ""}` }))]} placeholder="(select)" disabled={!editable} />
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Brand">
            {/* Name only (no codes); code stays searchable. Auto-fills from the selected style. */}
            <SearchableSelect value={brandId || null} onChange={(v) => setBrandId(v)}
              options={[{ value: "", label: "(entity default)" }, ...brands.map((b) => ({ value: b.id, label: b.name, searchHaystack: `${b.code || ""} ${b.name}` }))]} placeholder="(entity default)" disabled={!editable} />
          </Field>
          <Field label="Channel">
            {/* Name only (no codes); code stays searchable. Auto-fills from the customer. */}
            <SearchableSelect value={channelId || null} onChange={(v) => setChannelId(v)}
              options={[{ value: "", label: "(select)" }, ...channels.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.code || ""} ${c.name}` }))]} placeholder="(select)" disabled={!editable} />
          </Field>
        </div>

        {/* Item 3 — Factor / credit-insurance approval (Rosenthal & Rosenthal). Manual entry now. */}
        <div style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Factor / Ins Approval</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <Field label="Status">
              <SearchableSelect value={factorStatus || null} onChange={(v) => setFactorStatus(v || "not_submitted")}
                options={FACTOR_STATUSES.map((s) => ({ value: s, label: s }))} placeholder="not_submitted" disabled={!editable} />
            </Field>
            <Field label="Factor ref #"><input type="text" value={factorReference} onChange={(e) => setFactorReference(e.target.value)} disabled={!editable} style={inputStyle} placeholder="approval / ref number" /></Field>
            <Field label="Approved $"><input type="text" inputMode="decimal" value={factorApprovedDollars} onChange={(e) => setFactorApprovedDollars(e.target.value)} onBlur={() => setFactorApprovedDollars((v) => fmtMoneyComma(v))} disabled={!editable} style={inputStyle} placeholder="0.00" /></Field>
          </div>
          {/* Chunk K (operator item 17) — ship-gate cue. Server is the source of truth (409 on ship). */}
          {customers.find((c) => c.id === customerId)?.is_factored === true && factorStatus !== "approved" && (
            <div style={{ fontSize: 11, color: C.warn, marginTop: 8, fontWeight: 600 }}>
              ⚠ Factored customer — factor approval must be &quot;approved&quot; before this order can ship.
            </div>
          )}
        </div>

        <Field label="Notes"><input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!editable} style={inputStyle} placeholder="optional" /></Field>

        {/* Item 15 — ship to multiple stores: split this draft into per-store child SOs. */}
        {canSplit && (
          <div style={{ marginTop: 12, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
            <button onClick={() => setSplitOpen((v) => !v)} style={{ width: "100%", textAlign: "left", padding: "8px 12px", background: "#0b1220", color: C.text, border: 0, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
              <span style={{ color: C.textMuted, marginRight: 6 }}>{splitOpen ? "▼" : "▶"}</span>🏬 Ship to multiple stores (split into per-store orders)
            </button>
            {splitOpen && (
              <div style={{ padding: 12 }}>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>
                  Select the customer's stores/DCs to split across. Each line's quantity is divided evenly into one child order per location (adjust afterward). Mostly driven by incoming EDI.
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                  {shipTos.map((s) => (
                    <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub, border: `1px solid ${splitLocs.includes(s.id) ? C.primary : C.cardBdr}`, borderRadius: 6, padding: "4px 8px", cursor: "pointer" }}>
                      <input type="checkbox" checked={splitLocs.includes(s.id)} onChange={() => toggleSplitLoc(s.id)} />
                      {s.location_type === "dc" ? "🏭" : "🏬"} {s.code ? `${s.code} — ${s.name}` : s.name}
                    </label>
                  ))}
                </div>
                <button onClick={() => void splitOrder()} style={{ ...btnSecondary, color: C.primary, borderColor: C.primary }} disabled={submitting || splitLocs.length < 2}>
                  {submitting ? "…" : `Split into ${splitLocs.length || ""} per-store orders`}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Fulfillment source — REQUIRED: Production (make it; notify the
            Production Manager, hide on-hand) or ATS (ship from stock; show
            available qty). An uploaded customer PO auto-picks ATS + highlights
            the field for the operator to confirm. */}
        <div style={{ marginTop: 16, marginBottom: 4, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Fulfillment source *</span>
          <select
            value={fulfillmentSource}
            onChange={(e) => { setFulfillmentSource(e.target.value); setFulfillmentReview(false); }}
            disabled={!editable}
            style={{
              ...inputStyle, width: 280,
              borderColor: fulfillmentReview ? C.primary : (editable && !fulfillmentSource ? C.warn : C.cardBdr),
              boxShadow: fulfillmentReview ? `0 0 0 2px ${C.primary}55` : undefined,
            }}
          >
            <option value="">(select — required)</option>
            <option value="production">Production — make it (notifies Production Mgr)</option>
            <option value="ats">ATS — ship from available stock</option>
          </select>
          {fulfillmentReview && <span style={{ fontSize: 11, color: C.primary }}>✓ Auto-set to <strong>ATS</strong> from the uploaded PO — confirm it's correct or change it.</span>}
          {!fulfillmentReview && fulfillmentSource === "production" && <span style={{ fontSize: 11, color: C.warn }}>On-hand hidden; Production Manager is notified on confirm.</span>}
          {!fulfillmentReview && editable && !fulfillmentSource && <span style={{ fontSize: 11, color: C.warn }}>⚠️ Pick ATS or Production to start adding styles.</span>}
        </div>

        {/* The Add-style / Add-line buttons live in the matrix body itself
            (always shown, even on a confirmed SO). */}

        {/* MX-SO — the line body IS the size matrix: per-style color×size grids
            (95% of styles) + a "+ Add non-matrix line" button for one-offs.
            The Add buttons stay hidden until the order prerequisites are filled:
            customer, ship-to address, Customer PO #, and Fulfillment source. */}
        {editable && (() => {
          const missing: string[] = [];
          if (!customerId) missing.push("Customer");
          if (!shipToLocationId) missing.push("Ship-to address");
          if (!customerPo.trim()) missing.push("Customer PO #");
          if (!fulfillmentSource) missing.push("Fulfillment source");
          if (missing.length === 0) return null;
          return (
            <div style={{ marginBottom: 8, padding: "8px 12px", background: "#3b2f0b", border: `1px solid ${C.warn}`, borderRadius: 6, color: C.warn, fontSize: 12 }}>
              ⚠️ Fill <strong>{missing.join(", ")}</strong> above to start adding styles.
            </div>
          );
        })()}
        <div style={{ marginBottom: 12 }}>
          <LineMatrixBody
            key={seedKey}
            ref={bodyRef}
            editable={editable}
            canAdd={(editable || canAddStyles) && !!customerId && !!shipToLocationId && !!customerPo.trim() && !!fulfillmentSource}
            onRequestEdit={() => { if (!editable) setAddMode(true); }}
            items={items}
            seed={seed}
            showOnHand={fulfillmentSource !== "production"}
            atsMode={fulfillmentSource === "ats"}
            atsAsOfDate={reqShip || null}
            onTotalsChange={setBodyTotals}
            onPrimaryBrandChange={(b) => { if (b) setBrandId(b); }}
          />
        </div>

        {/* Supporting documents — staged on new, in-place on existing. */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Supporting documents</div>
          {isNew
            ? <StagedDocsPicker files={stagedDocs} onChange={setStagedDocs} hint="attach the PO / order confirmation; uploaded when you save." />
            : so && <DocumentAttachmentList contextTable="sales_orders" contextId={so.id} kinds={["customer_po", "order_confirmation", "other"]} />}
        </div>

        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

        {/* Sticky action footer — pinned to the bottom of the scrolling modal so
            the Save buttons are always reachable no matter how tall the matrix
            grows (negative margins + padding span the modal's 20px padding;
            bottom:-20 cancels the container's padding-bottom). */}
        <div style={{ position: "sticky", bottom: -20, zIndex: 3, background: C.card, borderTop: `1px solid ${C.cardBdr}`, margin: "0 -20px -20px", padding: "12px 20px", display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
          <div>
            {canAllocate && <button onClick={() => void allocate()} style={{ ...btnSecondary, color: "#8B5CF6", borderColor: "#5b21b6" }} disabled={submitting} title="Reserve available on-hand stock to this order's lines, then open the Allocations workbench for this order">{submitting ? "…" : "📦 Allocate stock"}</button>}
            {!isNew && so != null && <button onClick={openAllocations} style={{ ...btnSecondary, color: "#8B5CF6", borderColor: "#5b21b6" }} disabled={submitting} title="Open the Allocations workbench focused on this sales order">📊 View allocation</button>}
            {canShip && <button onClick={() => void openShipModal()} style={{ ...btnSecondary, color: "#06B6D4", borderColor: "#0e7490" }} disabled={submitting} title="Record a carrier shipment (ships the allocated quantities)">🚚 Ship</button>}
            {canInvoice && <button onClick={() => void createInvoice()} style={{ ...btnSecondary, color: C.success, borderColor: "#065f46" }} disabled={submitting}>{submitting ? "…" : "🧾 Create AR invoice"}</button>}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {saveCloseButtons}
          </div>
        </div>
      </div>

      {/* 🤖 AI customer-PO upload dialog. */}
      {poUploadOpen && (
        <div onClick={(e) => { e.stopPropagation(); if (!poParsing) setPoUploadOpen(false); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>🤖 Upload customer PO</h3>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>
              Upload the customer's PO (PDF, Excel/CSV) or paste the email below. AI reads it and prefills the customer, terms, dates, PO #, and the size matrix — then you double-check before saving.
            </div>

            {poAmbig.length === 0 ? (
              <>
                <Field label="PO document">
                  <input type="file" accept=".pdf,.xlsx,.xls,.csv,.txt,.eml" disabled={poParsing}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) { setPoText(""); pickFile(f); } }}
                    style={{ ...inputStyle, padding: 8 }} />
                  {poFileName && <div style={{ fontSize: 11, color: C.textSub, marginTop: 4 }}>Selected: {poFileName}</div>}
                </Field>
                <div style={{ textAlign: "center", color: C.textMuted, fontSize: 11, margin: "10px 0" }}>— or —</div>
                <Field label="Paste the PO / order email">
                  <textarea value={poText} onChange={(e) => { setPoText(e.target.value); if (e.target.value) { setPoB64(""); setPoFileName(""); poFileRef.current = null; } }} disabled={poParsing}
                    placeholder="Paste the customer's order email or PO text here…" rows={6}
                    style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }} />
                </Field>
                {poErr && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, margin: "10px 0 0", fontSize: 12 }}>{poErr}</div>}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
                  <button onClick={() => setPoUploadOpen(false)} style={btnSecondary} disabled={poParsing}>Cancel</button>
                  <button onClick={() => void parsePO()} style={btnPrimary} disabled={poParsing || (!poB64 && !poText.trim())}>
                    {poParsing ? "Reading…" : "Read & prefill"}
                  </button>
                </div>
              </>
            ) : (
              // Base vs PPK disambiguation — one or more styles exist in both forms.
              <>
                <div style={{ fontSize: 13, color: C.textSub, marginBottom: 10 }}>These styles exist in both a <strong>base</strong> and a <strong>prepack (PPK)</strong> form. Pick which to order:</div>
                {poAmbig.map((a, i) => (
                  <div key={i} style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: 10, marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6 }}>PO line: <strong style={{ color: C.text }}>{a.res.line.style_code}</strong>{a.res.line.color ? ` · ${a.res.line.color}` : ""}{a.res.line.total_qty ? ` · ${a.res.line.total_qty} units` : ""}</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      {(["base", "ppk"] as const).map((opt) => {
                        const st = opt === "base" ? a.res.base : a.res.ppk;
                        const active = a.pick === opt;
                        return (
                          <button key={opt} type="button" onClick={() => setPoAmbig((p) => p.map((x, j) => j === i ? { ...x, pick: opt } : x))}
                            style={{ ...btnSecondary, flex: 1, color: active ? C.primary : C.textSub, borderColor: active ? C.primary : C.cardBdr, fontWeight: active ? 700 : 400 }}>
                            {opt === "base" ? "Base" : "Prepack"}: {st?.style_code}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {poErr && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, margin: "10px 0 0", fontSize: 12 }}>{poErr}</div>}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                  <button onClick={() => setPoAmbig([])} style={btnSecondary} disabled={poParsing}>Back</button>
                  <button disabled={poParsing} style={btnPrimary} onClick={() => {
                    if (!poParsed) return;
                    const picks = Object.fromEntries(poAmbig.map((a) => [(a.res.line.style_code || "").toLowerCase(), a.pick]));
                    void applyParsed(poParsed, allStyles, picks);
                  }}>Continue</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* M44 — ship modal (carrier + tracking; ships the allocated quantities). */}
      {shipOpen && (
        <div onClick={(e) => { e.stopPropagation(); setShipOpen(false); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 110 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(420px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
            <h3 style={{ margin: "0 0 14px", fontSize: 16 }}>🚚 Ship sales order</h3>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 12 }}>Records a carrier shipment and ships each line's allocated quantity. The SO moves to <b>shipped</b> when fully shipped (else fulfilling).</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <Field label="Carrier">
                <SearchableSelect
                  value={shipCarrier || null}
                  onChange={(v) => setShipCarrier(v || "")}
                  options={carrierOptions}
                  placeholder="Search carrier…"
                  inputStyle={inputStyle}
                />
              </Field>
              <Field label="Ship date"><input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} style={inputStyle} /></Field>
            </div>
            <Field label="Tracking #"><input type="text" value={shipTracking} onChange={(e) => setShipTracking(e.target.value)} style={inputStyle} placeholder="optional" /></Field>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button onClick={() => setShipOpen(false)} style={btnSecondary} disabled={submitting}>Cancel</button>
              <button onClick={() => void shipOrder()} style={btnPrimary} disabled={submitting}>{submitting ? "…" : "Confirm shipment"}</button>
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
