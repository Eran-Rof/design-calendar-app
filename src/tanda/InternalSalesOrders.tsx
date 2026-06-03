// src/tanda/InternalSalesOrders.tsx
//
// P16 / M10-B — native Sales Order entry. List + create/edit modal. Mirrors the
// AR-invoice modal patterns (customer/ship-to/brand/channel pickers, item
// SearchableSelect, supporting docs). SO number is system-assigned on Confirm.

import { useEffect, useMemo, useRef, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import SalesOrderMatrixBody, { type SalesOrderMatrixBodyHandle, type SeedSection, type FlatLine, type BodyTotals } from "./SalesOrderMatrixBody";
import DocumentAttachmentList from "../shared/documents/DocumentAttachmentList";
import StagedDocsPicker from "../shared/documents/StagedDocsPicker";
import { uploadStagedDocs } from "../shared/documents/uploadDocument";
import { notify } from "../shared/ui/warn";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";

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

type SO = {
  id: string; so_number: string | null; customer_id: string; ship_to_location_id: string | null;
  brand_id: string | null; channel_id: string | null; order_date: string; requested_ship_date: string | null;
  cancel_date: string | null; status: string; payment_terms_id: string | null; ar_account_id: string | null;
  revenue_account_id: string | null; notes: string | null; total_cents: number | string;
  fulfillment_source?: string | null;
  factor_approval_status?: string | null; factor_reference?: string | null; factor_approved_cents?: number | string | null;
  parent_sales_order_id?: string | null; is_split_parent?: boolean;
};
type Customer = { id: string; name: string; customer_code?: string; default_brand_id?: string | null; default_channel_id?: string | null; default_revenue_account_id?: string | null; is_factored?: boolean | null };
type Item = { id: string; sku_code: string; style_code?: string; description?: string; color?: string; size?: string };
type Lookup = { id: string; code?: string; name: string };
type ShipTo = { id: string; name: string; code?: string | null; location_type?: string | null };

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
  const [search, setSearch] = useState("");
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

  async function load() {
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (search.trim()) params.set("q", search.trim());
      const r = await fetch(`/api/internal/sales-orders?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as SO[]);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [statusFilter]);
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
        <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void load(); }} placeholder="Search SO #…" style={{ ...inputStyle, width: 200 }} />
        <button style={btnSecondary} onClick={() => void load()}>Refresh</button>
        <TablePrefsButton
          tableKey={SO_TABLE_KEY}
          columns={SO_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
        />
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
                <td style={td} hidden={!isVisible("order_date")}>{so.order_date}</td>
                <td style={td} hidden={!isVisible("start_ship")}>{so.requested_ship_date || "—"}</td>
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
  const [notes, setNotes] = useState(so?.notes || "");
  const [fulfillmentSource, setFulfillmentSource] = useState(so?.fulfillment_source || "");
  // MX-SO — the line body IS the size matrix (per-style color×size grids) + a
  // few non-matrix flat lines. The body owns its state; we read it at save via
  // the imperative resolve() handle. `seed` rebuilds the grids when editing.
  const bodyRef = useRef<SalesOrderMatrixBodyHandle>(null);
  const [seed, setSeed] = useState<{ sections: SeedSection[]; flat: FlatLine[] } | null>(null);
  const [bodyTotals, setBodyTotals] = useState<BodyTotals>({ qty: 0, cents: 0, costCents: 0, marginPct: 0, marginEstimated: true });
  const [stagedDocs, setStagedDocs] = useState<File[]>([]);
  // Item 3 — Factor / credit-insurance approval (manual entry; Rosenthal API auto-fill reserved).
  const [factorStatus, setFactorStatus] = useState(so?.factor_approval_status || "not_submitted");
  const [factorReference, setFactorReference] = useState(so?.factor_reference || "");
  const [factorApprovedDollars, setFactorApprovedDollars] = useState(
    so?.factor_approved_cents != null && so.factor_approved_cents !== "" ? (Number(so.factor_approved_cents) / 100).toFixed(2) : "");

  const [items, setItems] = useState<Item[]>([]);
  const [brands, setBrands] = useState<Lookup[]>([]);
  const [channels, setChannels] = useState<Lookup[]>([]);
  const [paymentTerms, setPaymentTerms] = useState<Lookup[]>([]);
  const [shipTos, setShipTos] = useState<ShipTo[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/internal/items?limit=500").then((r) => r.ok ? r.json() : []).then((a) => setItems(Array.isArray(a) ? a : [])).catch(() => {});
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
    type DLine = { inventory_item_id: string | null; qty_ordered: number; unit_price_cents: number; style_code: string | null; color: string | null; size: string | null; sku_code: string | null };
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
          sec.cells.push({ color: l.color, size: l.size, qty: Number(l.qty_ordered) || 0, unit: dollars || undefined });
        } else {
          flat.push({ key: fk++, inventory_item_id: l.inventory_item_id || "", qty_ordered: String(l.qty_ordered ?? ""), unit_price_dollars: dollars, label: l.sku_code ? `${l.sku_code}${l.style_code ? ` — ${l.style_code}` : ""}` : undefined });
        }
      }
      setSeed({ sections: [...byStyle.values()], flat });
    }).catch(() => {});
  }, [isNew, so]);

  // The customer's ship-to locations.
  useEffect(() => {
    if (!customerId) { setShipTos([]); return; }
    let cancel = false;
    fetch(`/api/internal/customer-locations?customer_id=${encodeURIComponent(customerId)}`).then((r) => r.ok ? r.json() : []).then((a) => { if (!cancel) setShipTos(Array.isArray(a) ? a : []); }).catch(() => {});
    return () => { cancel = true; };
  }, [customerId]);

  // Item 5 — prefill brand/channel from the customer's defaults (NEW SO only, and
  // only when the picker is still empty so an explicit choice isn't clobbered).
  function pickCustomer(v: string) {
    setCustomerId(v);
    setShipToLocationId("");
    if (!isNew) return;
    const c = customers.find((x) => x.id === v);
    if (!c) return;
    if (c.default_brand_id) setBrandId((cur) => cur || c.default_brand_id || "");
    if (c.default_channel_id) setChannelId((cur) => cur || c.default_channel_id || "");
  }

  async function save(confirm: boolean) {
    setErr(null);
    if (!customerId) { setErr("Pick a customer."); return; }
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
        payment_terms_id: paymentTermsId || null, notes: notes.trim() || null, lines: resolvedLines,
        fulfillment_source: fulfillmentSource || null,
        // Item 3 — factor / credit-insurance approval (manual).
        factor_approval_status: factorStatus,
        factor_reference: factorReference.trim() || null,
        factor_approved_cents: factorApprovedDollars.trim() === "" ? null : Math.round((Number(factorApprovedDollars) || 0) * 100),
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
  async function allocate() {
    if (!so) return;
    setErr(null); setSubmitting(true);
    try {
      const r = await fetch(`/api/internal/sales-orders/${so.id}/allocate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify(j.message || "Allocation run complete.", j.fully_allocated ? "success" : "info");
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  // M44 — ship an allocated SO (record carrier + tracking; bumps qty_shipped).
  const canShip = !isNew && so != null && ["allocated", "fulfilling"].includes(so.status);
  const [shipOpen, setShipOpen] = useState(false);
  const [shipCarrier, setShipCarrier] = useState("");
  const [shipTracking, setShipTracking] = useState("");
  const [shipDate, setShipDate] = useState(new Date().toISOString().slice(0, 10));
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

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, minWidth: 980, maxWidth: 1180, maxHeight: "90vh", overflowY: "auto", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{isNew ? "New sales order" : `Sales order ${so?.so_number || "(draft)"} — ${so?.status}`}</h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Customer">
            <SearchableSelect value={customerId || null} onChange={(v) => pickCustomer(v)}
              options={customers.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.name} ${c.customer_code || ""}` }))}
              placeholder="(pick customer…)" disabled={!editable} />
          </Field>
          <Field label="Ship-to location">
            <SearchableSelect value={shipToLocationId || null} onChange={(v) => setShipToLocationId(v)}
              options={[{ value: "", label: "(select)" }, ...shipTos.map((s) => ({ value: s.id, label: s.code ? `${s.code} — ${s.name}` : s.name }))]}
              placeholder={customerId ? "(select)" : "(pick customer first)"} disabled={!editable || !customerId} />
          </Field>
          <Field label="SO number"><input type="text" value={so?.so_number || ""} readOnly disabled placeholder="(assigned on confirm)" style={{ ...inputStyle, opacity: 0.6 }} /></Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Order date"><input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
          <Field label="Start Ship"><input type="date" value={reqShip} onChange={(e) => setReqShip(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
          <Field label="Cancel date"><input type="date" value={cancelDate} onChange={(e) => setCancelDate(e.target.value)} disabled={!editable} style={inputStyle} /></Field>
          <Field label="Payment terms">
            <SearchableSelect value={paymentTermsId || null} onChange={(v) => setPaymentTermsId(v)}
              options={[{ value: "", label: "(select)" }, ...paymentTerms.map((t) => ({ value: t.id, label: t.code ? `${t.code} — ${t.name}` : t.name }))]} placeholder="(select)" disabled={!editable} />
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Brand">
            <SearchableSelect value={brandId || null} onChange={(v) => setBrandId(v)}
              options={[{ value: "", label: "(entity default)" }, ...brands.map((b) => ({ value: b.id, label: b.code ? `${b.code} — ${b.name}` : b.name }))]} placeholder="(entity default)" disabled={!editable} />
          </Field>
          <Field label="Channel">
            <SearchableSelect value={channelId || null} onChange={(v) => setChannelId(v)}
              options={[{ value: "", label: "(select)" }, ...channels.map((c) => ({ value: c.id, label: c.code ? `${c.code} — ${c.name}` : c.name }))]} placeholder="(select)" disabled={!editable} />
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
            <Field label="Approved $"><input type="text" inputMode="decimal" value={factorApprovedDollars} onChange={(e) => setFactorApprovedDollars(e.target.value)} disabled={!editable} style={inputStyle} placeholder="0.00" /></Field>
          </div>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 8 }}>Manual entry for now — this will auto-fill from the Rosenthal &amp; Rosenthal Factor API in a future release.</div>
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

        {/* Fulfillment source — Production (make it; notify the Production
            Manager, hide on-hand) or ATS (ship from stock; show available qty). */}
        <div style={{ marginTop: 16, marginBottom: 4, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Fulfillment source</span>
          <select value={fulfillmentSource} onChange={(e) => setFulfillmentSource(e.target.value)} disabled={!editable} style={{ ...inputStyle, width: 280 }}>
            <option value="">(not set)</option>
            <option value="production">Production — make it (notifies Production Mgr)</option>
            <option value="ats">ATS — ship from available stock</option>
          </select>
          {fulfillmentSource === "production" && <span style={{ fontSize: 11, color: C.warn }}>On-hand hidden; Production Manager is notified on confirm.</span>}
          {fulfillmentSource === "ats" && <span style={{ fontSize: 11, color: C.primary }}>Cell numbers show available-to-ship by size{reqShip ? ` by ${reqShip}` : " (set a ship date to include inbound POs)"}.</span>}
        </div>

        {/* Lines header — totals + projected margin, and (on a confirmed SO) an
            "Add styles" button that re-opens the grids to append more styles. */}
        <div style={{ marginTop: 4, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 18, alignItems: "baseline", fontSize: 13 }}>
            <span style={{ color: C.textMuted }}>Total qty <b style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>{bodyTotals.qty.toLocaleString()}</b></span>
            <span style={{ color: C.textMuted }}>Total <b style={{ color: C.success, fontVariantNumeric: "tabular-nums" }}>{fmtCents(bodyTotals.cents)}</b></span>
            <span style={{ color: C.textMuted, display: "inline-flex", flexDirection: "column" }}>
              <span>Proj. margin <b style={{ color: bodyTotals.marginPct >= 20 ? C.success : C.warn, fontVariantNumeric: "tabular-nums" }}>{bodyTotals.cents > 0 ? `${bodyTotals.marginPct.toFixed(1)}%` : "—"}</b></span>
              {bodyTotals.cents > 0 && bodyTotals.marginEstimated && <span style={{ fontSize: 10, color: C.textMuted }}>estimated — no cost data (assumes 21%)</span>}
            </span>
          </div>
          {canAddStyles && <button onClick={() => setAddMode(true)} style={{ ...btnSecondary, color: C.primary, borderColor: C.primary }} title="Re-open the grids to add more styles to this confirmed order">✏️ Add styles</button>}
          {addMode && <span style={{ fontSize: 11, color: C.warn }}>Adding styles — Save to apply.</span>}
        </div>

        {/* MX-SO — the line body IS the size matrix: per-style color×size grids
            (95% of styles) + a "+ Add non-matrix line" button for one-offs. */}
        <div style={{ marginBottom: 12 }}>
          <SalesOrderMatrixBody
            ref={bodyRef}
            editable={editable}
            items={items}
            seed={seed}
            showOnHand={fulfillmentSource !== "production"}
            atsMode={fulfillmentSource === "ats"}
            atsAsOfDate={reqShip || null}
            onTotalsChange={setBodyTotals}
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

        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
          <div>
            {canAllocate && <button onClick={() => void allocate()} style={{ ...btnSecondary, color: "#8B5CF6", borderColor: "#5b21b6" }} disabled={submitting} title="Reserve available on-hand stock to this order's lines">{submitting ? "…" : "📦 Allocate stock"}</button>}
            {canShip && <button onClick={() => setShipOpen(true)} style={{ ...btnSecondary, color: "#06B6D4", borderColor: "#0e7490" }} disabled={submitting} title="Record a carrier shipment (ships the allocated quantities)">🚚 Ship</button>}
            {canInvoice && <button onClick={() => void createInvoice()} style={{ ...btnSecondary, color: C.success, borderColor: "#065f46" }} disabled={submitting}>{submitting ? "…" : "🧾 Create AR invoice"}</button>}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={btnSecondary} disabled={submitting}>Close</button>
            {editable && <button onClick={() => void save(false)} style={btnSecondary} disabled={submitting}>{submitting ? "Saving…" : isNew ? "Create draft" : addMode ? "Save changes" : "Save draft"}</button>}
            {/* Confirm only when the order isn't already confirmed (draft → confirm).
                In Add-styles mode it's already confirmed, so just Save changes. */}
            {editable && !addMode && <button onClick={() => void save(true)} style={btnPrimary} disabled={submitting}>{submitting ? "…" : "Save & Confirm"}</button>}
          </div>
        </div>
      </div>

      {/* M44 — ship modal (carrier + tracking; ships the allocated quantities). */}
      {shipOpen && (
        <div onClick={(e) => { e.stopPropagation(); setShipOpen(false); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 110 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, minWidth: 420, color: C.text }}>
            <h3 style={{ margin: "0 0 14px", fontSize: 16 }}>🚚 Ship sales order</h3>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 12 }}>Records a carrier shipment and ships each line's allocated quantity. The SO moves to <b>shipped</b> when fully shipped (else fulfilling).</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <Field label="Carrier"><input type="text" value={shipCarrier} onChange={(e) => setShipCarrier(e.target.value)} style={inputStyle} placeholder="UPS, FedEx…" /></Field>
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
