// src/tanda/InternalSalesOrders.tsx
//
// P16 / M10-B — native Sales Order entry. List + create/edit modal. Mirrors the
// AR-invoice modal patterns (customer/ship-to/brand/channel pickers, item
// SearchableSelect, supporting docs). SO number is system-assigned on Confirm.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtDateDisplay } from "../utils/tandaTypes";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import SearchableSelect from "./components/SearchableSelect";
import { MultiSelectDropdown } from "../inventory-planning/components/MultiSelectDropdown";
import QuickAddPartyModal from "./components/QuickAddPartyModal";
import EmailSOConfirmationModal from "./components/EmailSOConfirmationModal";
import { notifyCompleteParty } from "./lib/notifyCompleteParty";
import { readDrillParam, consumeDrillParams } from "./scorecardDrill";
import LineMatrixBody, { type LineMatrixBodyHandle, type SeedSection, type FlatLine, type BodyTotals } from "./LineMatrixBody";
import { openOrderDocument, downloadOrderExcel, type OrderDocument } from "./orderDocument";
import DocumentAttachmentList from "../shared/documents/DocumentAttachmentList";
import StagedDocsPicker from "../shared/documents/StagedDocsPicker";
import { uploadStagedDocs } from "../shared/documents/uploadDocument";
import { notify, confirmDialog } from "../shared/ui/warn";
import {
  resolveLine, buildSeedFromResolved, matchCustomer, matchCustomerExact, matchPaymentTerms, isoDate,
  computeColorQuestions, customerCandidates, colorPickKey,
  type ParsedPo, type ParsedPoLine, type StyleLite, type LineResolution, type PrefillWarning, type ColorQuestion,
} from "./lib/customerPoPrefill";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import DateRangePresets from "./components/DateRangePresets";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

// Universal column-visibility registry for this panel (operator ask #1).
const SO_TABLE_KEY = "tangerine:salesorders:columns";
// Server-side page size for the list (the endpoint caps at 500). The full set
// lives server-side; use the search / filters to find older orders beyond this.
const SO_LIST_LIMIT = 500;
// Item 20 — new SOs default their Warehouse to the main warehouse (operator can
// change it). Must match a name in the Warehouses master (reconciled by mig
// 20260925); "Main Warehouse" is the canonical default location.
const DEFAULT_WAREHOUSE = "Main Warehouse";
// Item 19 — default the Cancel date to Start ship + this many days (editable).
const CANCEL_DAYS_AFTER_SHIP = 6;
function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const SO_COLUMNS: ColumnDef[] = [
  { key: "so_number",   label: "SO #" },
  { key: "customer",    label: "Customer" },
  { key: "store",       label: "Warehouse" },
  { key: "order_date",  label: "Order date" },
  { key: "start_ship",  label: "Start Ship" },
  { key: "cancel_date", label: "Cancel date" },
  { key: "status",      label: "Status" },
  { key: "factor",      label: "Factor" },
  { key: "credit",      label: "Credit" },
  { key: "avg_cost",    label: "Avg cost" },
  { key: "avg_sell",    label: "Avg sell" },
  { key: "margin_pct",  label: "Margin %" },
  { key: "margin_amt",  label: "Margin $" },
  { key: "total_margin_amt", label: "Total Margin $" },
  { key: "total_qty",   label: "Qty" },
  { key: "total",       label: "Total" },
];

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5 };
// Frozen header cell: th + sticky to the scroll container's top. Opaque
// background (#0b1220 matches `th`) so scrolling rows don't bleed through.
const thStick: React.CSSProperties = { ...th, position: "sticky", top: 0, zIndex: 2, background: "#0b1220" };
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
  customer_po_is_placeholder?: boolean | null;
  is_bulk_order?: boolean | null;
  sale_store?: string | null;
  fulfillment_source?: string | null;
  is_closeout?: boolean | null;
  factor_approval_status?: string | null; factor_reference?: string | null; factor_approved_cents?: number | string | null;
  // Non-factor credit ship-gate (house-account overdue AR / credit-card paid-in-full).
  credit_approval_status?: string | null; credit_hold_reason?: string | null;
  amount_paid_cents?: number | string | null; paid_in_full_at?: string | null;
  parent_sales_order_id?: string | null; is_split_parent?: boolean;
  // Per-SO cost/margin aggregates (server-computed; style-scoped when filtered).
  avg_cost_cents?: number | null; avg_sell_cents?: number | null;
  margin_cents?: number | null; margin_pct?: number | null;
  total_qty?: number | null;  // item 18 — total units across the SO's lines
  total_qty_exploded?: number | null;  // item 30 — PPK packs exploded to units
};
// Scenario 4.2 — bulk↔distro match shapes (mirror /sales-orders/bulk-match).
type BulkBreakdownRow = { style_code: string; color: string | null; bulk_qty: number; distro_qty: number; matched: number };
type BulkMatchRow = { id: string; so_number: string | null; customer_po: string | null; status: string; matched_units: number; bulk_units: number; distro_units: number; match_pct: number; bulk_coverage_pct: number; breakdown: BulkBreakdownRow[] };
// Scenario 5 — lot-aware allocation shapes (mirror /sales-orders/allocate-by-lot).
type SaveLine = { inventory_item_id: string | null; qty_ordered: number; unit_price_cents: number; lot_number?: string | null; customer_po?: string | null };
type LotPick = { lot_number: string | null; qty: number };
type PlanLine = { item_id: string; sku_code: string | null; style_code: string | null; color: string | null; size: string | null; qty_ordered: number; picks: LotPick[]; filled: number; shortfall: number };
type Customer = { id: string; name: string; customer_code?: string; default_brand_id?: string | null; default_channel_id?: string | null; default_revenue_account_id?: string | null; is_factored?: boolean | null; payment_terms_id?: string | null; contacts?: { id?: string; name?: string; email?: string; phone?: string; title?: string }[] };
type Item = { id: string; sku_code: string; style_code?: string; description?: string; color?: string; size?: string };
// Item 30 — a sales-order line for the grid row-expander.
type ExpandLine = { style_code: string | null; color: string | null; size: string | null; sku_code: string | null; description: string | null; qty: number; unit_cents: number };
// PPK pack size from a line (style has PPK; size = pack token e.g. PPK24 → 24), else 1.
function packSizeOfLine(l: ExpandLine): number {
  if (!/PPK/i.test(l.style_code ?? "")) return 1;
  const n = parseInt(String(l.size ?? "").match(/(\d+)/)?.[1] ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
type Lookup = { id: string; code?: string; name: string };
type ShipTo = { id: string; name: string; code?: string | null; location_type?: string | null; is_default?: boolean | null; address?: Record<string, unknown> | null };

// One-line address from a customer_locations.address jsonb ({line1,line2,city,
// state,postal_code,country}). Empty string when nothing is set.
function formatShipAddress(a: Record<string, unknown> | null | undefined): string {
  if (!a || typeof a !== "object") return "";
  const s = (k: string) => String(a[k] ?? "").trim();
  const cityLine = [s("city"), [s("state"), s("postal") || s("postal_code")].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [s("line1"), s("line2"), cityLine, s("country")].filter(Boolean).join(" · ");
}

function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0); const neg = n < 0; const abs = Math.abs(n);
  return `${neg ? "-" : ""}$${Math.trunc(abs / 100).toLocaleString()}.${String(Math.round(abs % 100)).padStart(2, "0")}`;
}
// 2-decimal money from cents, with a — placeholder for null (used by the
// Avg cost / Avg sell / Margin $ metric columns).
function fmtCents2(c: number | null | undefined): string {
  if (c == null) return "—";
  return `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
// Margin % to one decimal, with a — placeholder for null.
function fmtPct(p: number | null | undefined): string {
  if (p == null) return "—";
  return `${p.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
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
// Non-factor credit ship-gate states (operator ask): on_hold=amber, pending=blue,
// approved=green, declined=red. not_required = no gate (shown as a dash).
const CREDIT_COLORS: Record<string, string> = {
  not_required: C.textMuted, pending: C.primary, on_hold: C.warn, approved: C.success, declined: C.danger,
};
const CREDIT_LABELS: Record<string, string> = {
  pending: "card unpaid", on_hold: "on hold", approved: "approved", declined: "declined",
};
// True for a credit status worth surfacing in the grid/badge (not the neutral default).
const showCredit = (s?: string | null): boolean => !!s && s !== "not_required";

// Remove a sales order: a DRAFT can be hard-deleted; confirmed/allocated/fulfilling
// orders are CANCELLED (status='cancelled', kept for history) — matching the API,
// which forbids deleting a non-draft. shipped/invoiced/closed/cancelled are terminal.
const SO_CANCELLABLE = new Set(["confirmed", "allocated", "fulfilling"]);
function soRemoveMode(status: string): "delete" | "cancel" | null {
  if (status === "draft") return "delete";
  if (SO_CANCELLABLE.has(status)) return "cancel";
  return null;
}
// Confirms (via the app dialog), calls the API, toasts the result. Returns true
// when a change was made so the caller can reload / close.
async function deleteOrCancelSO(so: { id: string; so_number: string | null; status: string }): Promise<boolean> {
  const mode = soRemoveMode(so.status);
  if (!mode) { notify(`A ${so.status} sales order can't be deleted or cancelled.`, "info"); return false; }
  const label = so.so_number || "draft order";
  if (mode === "delete") {
    const ok = await confirmDialog(
      `Delete draft sales order (${label})? This permanently removes it and cannot be undone.`,
      { danger: true, confirmText: "Delete", title: "Delete draft sales order" });
    if (!ok) return false;
    const r = await fetch(`/api/internal/sales-orders/${so.id}`, { method: "DELETE" });
    if (!r.ok) { notify(`Could not delete: ${(await r.json().catch(() => ({}))).error || `HTTP ${r.status}`}`, "error"); return false; }
    notify("Draft sales order deleted.", "success");
    return true;
  }
  const ok = await confirmDialog(
    `Cancel sales order ${label}? It moves to "cancelled" and is kept for history (not deleted).`,
    { danger: true, confirmText: "Cancel order", title: "Cancel sales order" });
  if (!ok) return false;
  const r = await fetch(`/api/internal/sales-orders/${so.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "cancelled" }),
  });
  if (!r.ok) { notify(`Could not cancel: ${(await r.json().catch(() => ({}))).error || `HTTP ${r.status}`}`, "error"); return false; }
  notify(`Sales order ${label} cancelled.`, "success");
  return true;
}

export default function InternalSalesOrders() {
  const [rows, setRows] = useState<SO[]>([]);
  // Guards against a fetch race: rapidly toggling the status multi-select fires
  // several load()s; without sequencing a slower earlier response can land last
  // and clobber the newest filter (e.g. "cancelled only" briefly showing, then
  // reverting to all statuses). Only the latest request's result is applied.
  const loadSeqRef = useRef(0);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Item 6 — multi-select status filter (any combination of statuses). Defaults
  // to the live/open statuses (draft, confirmed, allocated, fulfilling) so the
  // grid opens on actionable orders, not the full closed/cancelled history.
  const [statusFilters, setStatusFilters] = useState<string[]>(["draft", "confirmed", "allocated", "fulfilling"]);
  // Item 5 — selling-store filter (Xoro SaleStoreName), mirrors the Inventory
  // Matrix store filter. storeOptions is the distinct store list for the dropdown.
  const [storeFilter, setStoreFilter] = useState("");
  const [storeOptions, setStoreOptions] = useState<string[]>([]);
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

  // Date-range filter (client-side). `dateField` chooses WHICH date the [from,to]
  // window applies to: the order date or the start (requested) ship date.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // Default the date-range field to Start ship date (operator request) rather
  // than order date.
  const [dateField, setDateField] = useState<"order_date" | "requested_ship_date">("requested_ship_date");

  // Item 30 — row-expander (per-SO line detail) + Explode toggle. When exploded,
  // PPK lines show units (packs × pack size) and per-each cost instead of packs.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [soLines, setSoLines] = useState<Record<string, ExpandLine[] | "loading" | "error">>({});
  const [explode, setExplode] = useState<boolean>(() => { try { return localStorage.getItem("tangerine:so:explode") === "1"; } catch { return false; } });
  function toggleExplode() { setExplode((v) => { const nv = !v; try { localStorage.setItem("tangerine:so:explode", nv ? "1" : "0"); } catch { /* ignore */ } return nv; }); }
  async function toggleExpand(so: SO) {
    setExpanded((prev) => { const n = new Set(prev); n.has(so.id) ? n.delete(so.id) : n.add(so.id); return n; });
    if (soLines[so.id]) return; // already fetched (or loading)
    setSoLines((p) => ({ ...p, [so.id]: "loading" }));
    try {
      const r = await fetch(`/api/internal/sales-orders/${so.id}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const lines: ExpandLine[] = (Array.isArray(j.lines) ? j.lines : []).map((l: Record<string, unknown>) => ({
        style_code: (l.style_code as string) || null, color: (l.color as string) || null, size: (l.size as string) || null,
        sku_code: (l.sku_code as string) || null, description: (l.description as string) || null,
        qty: Number(l.qty_ordered) || 0, unit_cents: Number(l.unit_price_cents) || 0,
      }));
      setSoLines((p) => ({ ...p, [so.id]: lines }));
    } catch { setSoLines((p) => ({ ...p, [so.id]: "error" })); }
  }

  // Wave 5 — universal column show/hide.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(SO_TABLE_KEY, SO_COLUMNS);
  const isVisible = (k: string): boolean => visibleColumns.has(k);

  const customerName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of customers) m[c.id] = c.name;
    return m;
  }, [customers]);

  // Client-side date-range filter on the chosen date field. A row with a null
  // value for the selected field is dropped only when a bound is set. Shared by
  // the on-screen list and the "Export all" fetch so both apply the same range.
  const inDateRange = useCallback((so: SO): boolean => {
    if (!dateFrom && !dateTo) return true;
    const raw = dateField === "order_date" ? so.order_date : so.requested_ship_date;
    const d = (raw || "").slice(0, 10);
    if (!d) return false;
    if (dateFrom && d < dateFrom) return false;
    if (dateTo && d > dateTo) return false;
    return true;
  }, [dateFrom, dateTo, dateField]);
  const filteredRows = useMemo(() => rows.filter(inDateRange), [rows, inDateRange]);

  // Map an SO header → the export row shape (ids resolved to human labels; cents
  // kept in cents for currency formatting). Shared by the on-screen export and
  // the full "Export all" fetch so both produce identical columns.
  const toExportRow = useCallback((so: SO) => {
   // Mirror the grid's Explode toggle: when on, export per-each metrics + units
   // (see the row-level packMult note below) so the sheet matches the screen.
   const pm = explode && so.total_qty != null && Number(so.total_qty) > 0 && so.total_qty_exploded != null
     ? Number(so.total_qty_exploded) / Number(so.total_qty)
     : 1;
   const pe = (c: number | null | undefined): number | null => (c == null ? null : c / pm);
   return ({
    so_number: so.so_number || "(draft)",
    customer: customerName[so.customer_id] || "—",
    store: so.sale_store || "",
    order_date: so.order_date,
    start_ship: so.requested_ship_date || "",
    cancel_date: so.cancel_date || "",
    status: so.status,
    factor: so.factor_approval_status && so.factor_approval_status !== "not_submitted" ? so.factor_approval_status : "",
    credit: showCredit(so.credit_approval_status) ? (CREDIT_LABELS[so.credit_approval_status!] || so.credit_approval_status!) : "",
    avg_cost_cents: pe(so.avg_cost_cents),
    avg_sell_cents: pe(so.avg_sell_cents),
    margin_pct: so.margin_pct ?? null,
    margin_cents: pe(so.margin_cents),
    total_margin_cents: (so.margin_cents != null && so.total_qty != null) ? so.margin_cents * Number(so.total_qty) : null,
    total_qty: explode && so.total_qty_exploded != null ? Number(so.total_qty_exploded) : (so.total_qty != null ? Number(so.total_qty) : null),
    total_cents: Number(so.total_cents ?? 0),
  }); }, [customerName, explode]);

  // Export rows mirror the displayed list (same filter/search).
  const exportRows = useMemo(() => filteredRows.map(toExportRow), [filteredRows, toExportRow]);
  const exportColumns: ExportColumn<(typeof exportRows)[number]>[] = [
    { key: "so_number",  header: "SO #" },
    { key: "customer",   header: "Customer" },
    { key: "store",      header: "Warehouse" },
    { key: "order_date", header: "Order date", format: "date" },
    { key: "start_ship", header: "Start Ship", format: "date" },
    { key: "cancel_date", header: "Cancel date", format: "date" },
    { key: "status",     header: "Status" },
    { key: "factor",     header: "Factor" },
    { key: "credit",     header: "Credit" },
    { key: "avg_cost_cents", header: "Avg cost", format: "currency_cents" },
    { key: "avg_sell_cents", header: "Avg sell", format: "currency_cents" },
    { key: "margin_pct", header: "Margin %", format: "percent", digits: 1 },
    { key: "margin_cents", header: "Margin $", format: "currency_cents" },
    { key: "total_margin_cents", header: "Total Margin $", format: "currency_cents" },
    { key: "total_qty",  header: "Qty", format: "number" },
    { key: "total_cents", header: "Total", format: "currency_cents" },
  ];

  // Item 17 — "Export all": walk every server page (offset 0, 500, 1000, …) with
  // the SAME filters/search the list uses, so the download covers the whole
  // filtered set rather than just the first 500 shown. Applies the same client
  // date-range filter, then maps to the export shape.
  const fetchAllForExport = useCallback(async () => {
    const base = new URLSearchParams();
    if (statusFilters.length) base.set("status", statusFilters.join(","));
    if (storeFilter) base.set("store", storeFilter);
    if (customerFilter) base.set("customer_id", customerFilter);
    if (searchDebounced.trim()) { base.set("q", searchDebounced.trim()); base.set("style", searchDebounced.trim()); }
    const styleDrill = readDrillParam("style_id");
    if (styleDrill) base.set("style_id", styleDrill);
    const PAGE = 500;
    const acc: SO[] = [];
    for (let offset = 0; offset < 100000; offset += PAGE) {
      const p = new URLSearchParams(base);
      p.set("limit", String(PAGE));
      p.set("offset", String(offset));
      const r = await fetch(`/api/internal/sales-orders?${p.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const page = await r.json() as SO[];
      acc.push(...page);
      if (page.length < PAGE) break;
    }
    return acc.filter(inDateRange).map(toExportRow);
  }, [statusFilters, storeFilter, customerFilter, searchDebounced, inDateRange, toExportRow]);

  async function load() {
    const seq = ++loadSeqRef.current;
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (statusFilters.length) params.set("status", statusFilters.join(","));
      if (storeFilter) params.set("store", storeFilter);
      if (customerFilter) params.set("customer_id", customerFilter);
      if (searchDebounced.trim()) {
        params.set("q", searchDebounced.trim());
        // Style-aware metrics: when the user is searching, scope the per-SO
        // cost/sell/margin aggregates to the matching style's lines. The server
        // only narrows when a line actually matches, so a non-style search (e.g.
        // a customer name) safely falls back to the whole-SO aggregate.
        params.set("style", searchDebounced.trim());
      }
      const styleDrill = readDrillParam("style_id");
      if (styleDrill) params.set("style_id", styleDrill);
      params.set("limit", String(SO_LIST_LIMIT));
      const r = await fetch(`/api/internal/sales-orders?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json() as SO[];
      if (seq !== loadSeqRef.current) return; // superseded by a newer load — drop this stale result
      setRows(data);
    } catch (e) { if (seq === loadSeqRef.current) setErr(e instanceof Error ? e.message : String(e)); }
    finally { if (seq === loadSeqRef.current) setLoading(false); }
  }
  const anyFilter = !!(statusFilters.length || storeFilter || customerFilter || search.trim() || dateFrom || dateTo);
  function clearFilters() { setStatusFilters([]); setStoreFilter(""); setCustomerFilter(""); setSearch(""); setDateFrom(""); setDateTo(""); }
  // Consume the one-shot drill params (?q=/?so=/?customer=/?style_id=) AFTER the
  // useState initializers above have seeded from them, so leaving and returning to
  // this panel starts with a clean (unfiltered) list instead of silently re-
  // applying a stale search that can hide the whole list. Runs once on mount.
  useEffect(() => { consumeDrillParams(["q", "so", "customer", "style_id"]); }, []);
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [statusFilters.join(","), storeFilter, customerFilter, searchDebounced]);
  useEffect(() => {
    // Warehouse list for the SO Warehouse field + filter — sourced from the
    // canonical Warehouses master (inventory_locations kind='warehouse'). Existing
    // orders' sale_store values were reconciled to these names (mig 20260925).
    fetch("/api/internal/warehouses").then((r) => r.ok ? r.json() : [])
      .then((a) => {
        const list = Array.isArray(a) ? a : (a?.rows || a?.warehouses || []);
        if (Array.isArray(list)) setStoreOptions(list.map((w: { name?: string }) => w?.name).filter((n): n is string => !!n));
      }).catch(() => {});
  }, []);
  useEffect(() => {
    fetch("/api/internal/customer-master?limit=1000").then((r) => r.json())
      .then((a) => { if (Array.isArray(a)) setCustomers(a as Customer[]); }).catch(() => {});
  }, []);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Sales Orders</h2>
        <button style={btnPrimary} onClick={() => { setEditing(null); setModalOpen(true); }}>+ New sales order</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        {/* Item 6 — multi-select status filter (pick any combination). */}
        <MultiSelectDropdown
          selected={statusFilters}
          onChange={setStatusFilters}
          options={["draft", "confirmed", "allocated", "fulfilling", "shipped", "invoiced", "closed", "cancelled"].map((s) => ({ value: s, label: s }))}
          allLabel="All statuses"
          placeholder="Search status…"
          title="Filter by one or more statuses"
          minWidth={180}
        />
        {/* Warehouse filter (sale_store = the order's Xoro warehouse). Tangerine
            has warehouses + brands, no sales stores — so this reads "Warehouse". */}
        <div style={{ width: 200 }}>
          <SearchableSelect value={storeFilter || null} onChange={(v) => setStoreFilter(v || "")}
            options={[{ value: "", label: "All warehouses" }, ...storeOptions.map((s) => ({ value: s, label: s }))]}
            placeholder="All warehouses" inputStyle={inputStyle} />
        </div>
        <div style={{ width: 240 }}>
          <SearchableSelect value={customerFilter || null} onChange={(v) => setCustomerFilter(v)}
            options={[{ value: "", label: "All customers" }, ...customers.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.name} ${c.customer_code || ""}` }))]}
            placeholder="All customers" inputStyle={inputStyle} />
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search SO #, customer, style…" style={{ ...inputStyle, width: 240 }} />
        {/* Date-range filter (client-side). Field picker + From/To + presets. */}
        <div style={{ width: 160 }} title="Which date the range filters on">
          <SearchableSelect value={dateField} onChange={(v) => setDateField((v as "order_date" | "requested_ship_date") || "order_date")}
            options={[{ value: "order_date", label: "Order date" }, { value: "requested_ship_date", label: "Start ship date" }]}
            placeholder="Date field" inputStyle={inputStyle} />
        </div>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ ...inputStyle, width: 150 }} aria-label="From date" title="From" />
        <span style={{ color: C.textMuted, fontSize: 13 }}>→</span>
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ ...inputStyle, width: 150 }} aria-label="To date" title="To" />
        <DateRangePresets variant="dropdown" from={dateFrom} to={dateTo}
          onChange={(f, t) => { setDateFrom(f); setDateTo(t); }}
          buttonStyle={{ background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, borderRadius: 4, padding: "6px 10px", fontSize: 13 }} />
        {(dateFrom || dateTo) && (
          <button style={btnSecondary} onClick={() => { setDateFrom(""); setDateTo(""); }} title="Clear date range">Clear dates</button>
        )}
        {anyFilter && (
          <button style={{ ...btnSecondary, color: C.warn, borderColor: C.warn }} onClick={clearFilters} title="Clear status, customer, search and date filters">Clear filters</button>
        )}
        <button style={btnSecondary} onClick={() => void load()}>Refresh</button>
        <TablePrefsButton
          tableKey={SO_TABLE_KEY}
          columns={SO_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
        />
        {/* Keep the label "Explode" in both states (highlighted when active) so
            the control never appears to vanish; the ✓ marks the on-state. */}
        <button onClick={toggleExplode} style={explode ? { ...btnSecondary, color: C.primary, borderColor: C.primary } : btnSecondary}
          title={explode ? "Prepack quantities shown as UNITS (packs × pack size) with per-each cost/sell/margin — click to show PACKS" : "Explode prepack quantities to UNITS (packs × pack size); expand a row to see per-line qty & cost"}>
          {explode ? "Explode ✓" : "Explode"}
        </button>
        <ExportButton rows={exportRows} filename="sales-orders" sheetName="Sales Orders" columns={exportColumns} fetchRows={fetchAllForExport} />
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      {/* Result count + cap notice. The list shows up to SO_LIST_LIMIT rows; when
          it's full there are more, reachable via the search / status / customer /
          date filters (server-side). Prevents mistaking the cap for the total. */}
      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 8 }}>
        {loading ? "Loading…" : (
          <>
            Showing <b style={{ color: C.text }}>{filteredRows.length.toLocaleString()}</b> sales order{filteredRows.length === 1 ? "" : "s"}
            {rows.length >= SO_LIST_LIMIT && <> — most recent {SO_LIST_LIMIT}; use search or filters to find older orders</>}
            {anyFilter && <> · <span style={{ color: C.warn }}>filters active</span></>}
          </>
        )}
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          {/* Frozen header — sticks to the scroll container's top while rows
              scroll. Opaque background so rows don't show through (mirrors the
              Inventory Matrix SnapshotView pattern). */}
          <thead><tr>
            <th style={{ ...thStick, width: 28 }} />
            <th style={thStick} hidden={!isVisible("so_number")}>SO #</th><th style={thStick} hidden={!isVisible("customer")}>Customer</th><th style={thStick} hidden={!isVisible("store")}>Warehouse</th><th style={thStick} hidden={!isVisible("order_date")}>Order date</th>
            <th style={thStick} hidden={!isVisible("start_ship")}>Start Ship</th><th style={thStick} hidden={!isVisible("cancel_date")}>Cancel date</th><th style={thStick} hidden={!isVisible("status")}>Status</th><th style={thStick} hidden={!isVisible("factor")}>Factor</th><th style={thStick} hidden={!isVisible("credit")}>Credit</th>
            <th style={{ ...thStick, textAlign: "right" }} hidden={!isVisible("avg_cost")}>Avg cost</th><th style={{ ...thStick, textAlign: "right" }} hidden={!isVisible("avg_sell")}>Avg sell</th><th style={{ ...thStick, textAlign: "right" }} hidden={!isVisible("margin_pct")}>Margin %</th><th style={{ ...thStick, textAlign: "right" }} hidden={!isVisible("margin_amt")}>Margin $</th><th style={{ ...thStick, textAlign: "right" }} hidden={!isVisible("total_margin_amt")}>Total Margin $</th>
            <th style={{ ...thStick, textAlign: "right" }} hidden={!isVisible("total_qty")}>Qty</th><th style={{ ...thStick, textAlign: "right" }} hidden={!isVisible("total")}>Total</th>
            <th style={{ ...thStick, textAlign: "center" }}>Actions</th>
          </tr></thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={17}>Loading…</td></tr>}
            {!loading && filteredRows.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={17}>No sales orders.</td></tr>}
            {filteredRows.map((so) => {
              const marginColor = so.margin_cents == null ? C.text : so.margin_cents >= 0 ? C.success : C.danger;
              // Item 30 (fix) — when exploded, the per-unit metric columns (avg
              // cost / avg sell / margin $) must switch from PER-PACK to PER-EACH
              // so they stay consistent with the exploded Qty. The blended pack
              // size is total_qty_exploded / total_qty; dividing the per-pack
              // aggregate by it yields the per-each average (= total ÷ units).
              // Margin %, Total and Total Margin $ are invariant to explode.
              const packMult = explode && so.total_qty != null && Number(so.total_qty) > 0 && so.total_qty_exploded != null
                ? Number(so.total_qty_exploded) / Number(so.total_qty)
                : 1;
              const perEach = (c: number | null | undefined): number | null | undefined => (c == null || packMult === 1 ? c : c / packMult);
              const metricTitle = explode && packMult !== 1 ? "Per each (exploded)" : undefined;
              const isOpen = expanded.has(so.id);
              return (
              <Fragment key={so.id}>
              <tr style={{ cursor: "pointer" }} onClick={() => { setEditing(so); setModalOpen(true); }}>
                <td style={{ ...td, textAlign: "center" }} onClick={(e) => { e.stopPropagation(); void toggleExpand(so); }} title="Show / hide line detail">
                  <span style={{ color: C.textMuted, cursor: "pointer", userSelect: "none" }}>{isOpen ? "▾" : "▸"}</span>
                </td>
                <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }} hidden={!isVisible("so_number")}>{so.so_number || <span style={{ color: C.textMuted }}>(draft)</span>}</td>
                <td style={td} hidden={!isVisible("customer")}>{customerName[so.customer_id] || "—"}</td>
                <td style={td} hidden={!isVisible("store")}>{so.sale_store || <span style={{ color: C.textMuted }}>—</span>}</td>
                <td style={td} hidden={!isVisible("order_date")}>{fmtDateDisplay(so.order_date)}</td>
                <td style={td} hidden={!isVisible("start_ship")}>{so.requested_ship_date ? fmtDateDisplay(so.requested_ship_date) : "—"}</td>
                <td style={td} hidden={!isVisible("cancel_date")}>{so.cancel_date ? fmtDateDisplay(so.cancel_date) : "—"}</td>
                <td style={td} hidden={!isVisible("status")}><span style={{ color: STATUS_COLORS[so.status] || C.text, fontWeight: 600 }}>● {so.status}</span></td>
                <td style={td} hidden={!isVisible("factor")}>{so.factor_approval_status && so.factor_approval_status !== "not_submitted"
                  ? <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 6px", borderRadius: 4, color: FACTOR_COLORS[so.factor_approval_status] || C.text, border: `1px solid ${FACTOR_COLORS[so.factor_approval_status] || C.cardBdr}` }}>{so.factor_approval_status}</span>
                  : <span style={{ color: C.textMuted }}>—</span>}</td>
                <td style={td} hidden={!isVisible("credit")}>{showCredit(so.credit_approval_status)
                  ? <span title={so.credit_hold_reason || undefined} style={{ fontSize: 11, fontWeight: 600, padding: "2px 6px", borderRadius: 4, color: CREDIT_COLORS[so.credit_approval_status!] || C.text, border: `1px solid ${CREDIT_COLORS[so.credit_approval_status!] || C.cardBdr}` }}>{CREDIT_LABELS[so.credit_approval_status!] || so.credit_approval_status}</span>
                  : <span style={{ color: C.textMuted }}>—</span>}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!isVisible("avg_cost")} title={metricTitle}>{fmtCents2(perEach(so.avg_cost_cents))}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!isVisible("avg_sell")} title={metricTitle}>{fmtCents2(perEach(so.avg_sell_cents))}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: marginColor }} hidden={!isVisible("margin_pct")}>{fmtPct(so.margin_pct)}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: marginColor }} hidden={!isVisible("margin_amt")} title={metricTitle}>{fmtCents2(perEach(so.margin_cents))}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: marginColor }} hidden={!isVisible("total_margin_amt")}>{so.margin_cents != null && so.total_qty != null ? fmtCents2(so.margin_cents * Number(so.total_qty)) : "—"}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!isVisible("total_qty")} title={explode ? "Exploded units (packs × pack size)" : "Order quantity (packs for prepacks)"}>{(() => { const v = explode ? so.total_qty_exploded : so.total_qty; return v != null ? Number(v).toLocaleString() : "—"; })()}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!isVisible("total")}>{fmtCents(so.total_cents)}</td>
                <td style={{ ...td, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                  {soRemoveMode(so.status)
                    ? <button
                        title={so.status === "draft" ? "Delete draft order" : "Cancel order"}
                        onClick={async (e) => { e.stopPropagation(); if (await deleteOrCancelSO(so)) void load(); }}
                        style={{ background: "none", border: "none", color: C.danger, cursor: "pointer", fontSize: 14, padding: "0 6px", lineHeight: 1 }}
                      >✕</button>
                    : <span style={{ color: C.textMuted }}>—</span>}
                </td>
              </tr>
              {isOpen && (
                <tr>
                  <td />
                  <td colSpan={16} style={{ ...td, background: "#0b1220", padding: "8px 12px" }}>
                    {(() => {
                      const detail = soLines[so.id];
                      if (detail === "loading" || detail === undefined) return <span style={{ color: C.textMuted, fontSize: 12 }}>Loading line detail…</span>;
                      if (detail === "error") return <span style={{ color: C.danger, fontSize: 12 }}>Couldn't load line detail.</span>;
                      if (detail.length === 0) return <span style={{ color: C.textMuted, fontSize: 12 }}>No lines on this order.</span>;
                      return (
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                          <thead><tr style={{ color: C.textMuted }}>
                            <th style={{ textAlign: "left", padding: "3px 8px" }}>Style</th>
                            <th style={{ textAlign: "left", padding: "3px 8px" }}>Color</th>
                            <th style={{ textAlign: "left", padding: "3px 8px" }}>Size</th>
                            <th style={{ textAlign: "right", padding: "3px 8px" }}>{explode ? "Units" : "Qty"}</th>
                            <th style={{ textAlign: "right", padding: "3px 8px" }}>{explode ? "Unit $ / each" : "Unit $"}</th>
                            <th style={{ textAlign: "right", padding: "3px 8px" }}>Line total</th>
                          </tr></thead>
                          <tbody>
                            {detail.map((l, i) => {
                              const ps = explode ? packSizeOfLine(l) : 1;
                              const qtyShown = l.qty * ps;
                              const unitShown = ps > 1 ? l.unit_cents / ps : l.unit_cents;
                              const lineTotal = l.qty * l.unit_cents; // invariant to explode
                              return (
                                <tr key={i} style={{ borderTop: `1px solid ${C.cardBdr}` }}>
                                  <td style={{ textAlign: "left", padding: "3px 8px", fontFamily: "monospace" }}>{l.style_code || l.sku_code || "—"}</td>
                                  <td style={{ textAlign: "left", padding: "3px 8px" }}>{l.color || (l.description ? l.description : "—")}</td>
                                  <td style={{ textAlign: "left", padding: "3px 8px" }}>{l.size || "—"}</td>
                                  <td style={{ textAlign: "right", padding: "3px 8px", fontVariantNumeric: "tabular-nums" }}>{qtyShown.toLocaleString()}</td>
                                  <td style={{ textAlign: "right", padding: "3px 8px", fontVariantNumeric: "tabular-nums" }}>{fmtCents2(Math.round(unitShown))}</td>
                                  <td style={{ textAlign: "right", padding: "3px 8px", fontVariantNumeric: "tabular-nums" }}>{fmtCents(lineTotal)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      );
                    })()}
                  </td>
                </tr>
              )}
              </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <SOModal
          so={editing}
          customers={customers}
          storeOptions={storeOptions}
          onClose={() => { setModalOpen(false); setEditing(null); }}
          onSaved={() => { setModalOpen(false); setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

function SOModal({ so, customers: customersProp, storeOptions, onClose, onSaved }: { so: SO | null; customers: Customer[]; storeOptions: string[]; onClose: () => void; onSaved: () => void }) {
  const isNew = so === null;
  // "Add styles" mode lets a CONFIRMED (not yet allocated/shipped/invoiced) SO
  // re-open its line grids to append styles. Base editability is draft-only.
  const [addMode, setAddMode] = useState(false);
  const editable = isNew || so?.status === "draft" || addMode;
  const canAddStyles = !isNew && so?.status === "confirmed" && !addMode;
  // Item 13 — unlock the order HEADER (customer, ship-to, dates, terms, brand,
  // channel, store, PO #, factor, notes) for editing on a saved SO via "✎ Edit
  // header", independent of the line matrix (which stays draft/Add-styles gated).
  // Saving header-only PATCHes the header without touching lines.
  const [headerEditMode, setHeaderEditMode] = useState(false);
  const headerEditable = editable || headerEditMode;

  // Item 1 — on-the-fly "+ New customer" rows created from this window are merged
  // in front of the loaded list so they're immediately selectable here without a
  // round-trip to the Customer Master screen.
  const [extraCustomers, setExtraCustomers] = useState<Customer[]>([]);
  const [quickAddCustomer, setQuickAddCustomer] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false); // item 7 — email confirmation modal
  const [confirmMenuOpen, setConfirmMenuOpen] = useState(false); // item 7 — Confirmation chooser (Excel / PDF / Email)
  // Item 8 — the typed-but-unmatched name to pre-fill the Add-customer popup with.
  const [quickAddInitialName, setQuickAddInitialName] = useState("");
  const customers = useMemo(
    () => (extraCustomers.length ? [...extraCustomers, ...customersProp] : customersProp),
    [extraCustomers, customersProp],
  );

  const [customerId, setCustomerId] = useState(so?.customer_id || "");
  const [shipToLocationId, setShipToLocationId] = useState(so?.ship_to_location_id || "");
  const [brandId, setBrandId] = useState(so?.brand_id || "");
  const [channelId, setChannelId] = useState(so?.channel_id || "");
  // Warehouse (sale_store). New SOs default to the main warehouse (item 20);
  // editing keeps the saved value.
  const [saleStore, setSaleStore] = useState(so?.sale_store || (so ? "" : DEFAULT_WAREHOUSE));
  const [orderDate, setOrderDate] = useState(so?.order_date || new Date().toISOString().slice(0, 10));
  const [reqShip, setReqShip] = useState(so?.requested_ship_date || "");
  const [cancelDate, setCancelDate] = useState(so?.cancel_date || "");
  // Item 19 — auto-fill Cancel date = Start ship + 6 days, but only while the
  // operator hasn't typed their own value. We remember the last auto value so a
  // later ship-date change re-derives it, yet a manual edit is never overwritten.
  const autoCancelRef = useRef(so?.cancel_date ? "__manual__" : "");
  const [paymentTermsId, setPaymentTermsId] = useState(so?.payment_terms_id || "");
  // #1156 — optional buyer (the person at the customer who placed the order).
  const [buyerId, setBuyerId] = useState(so?.buyer_id || "");
  const [buyers, setBuyers] = useState<{ id: string; name: string; title: string | null; email?: string | null }[]>([]);
  const [notes, setNotes] = useState(so?.notes || "");
  // Customer's PO number (their reference). Required before styles can be added.
  const [customerPo, setCustomerPo] = useState(so?.customer_po || "");
  // Scenario 4.2 — mark this SO as a bulk order; and the bulk-match result shown
  // after a distro is saved (matches an open bulk → offer to cancel the bulk).
  const [isBulkOrder, setIsBulkOrder] = useState(so?.is_bulk_order ?? false);
  const [bulkMatches, setBulkMatches] = useState<BulkMatchRow[] | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkDetail, setBulkDetail] = useState<BulkMatchRow | null>(null);
  // Scenario 2 — true while customer_po holds a system-generated placeholder
  // (not the real buyer PO). Set by "Generate placeholder"; cleared the moment
  // the operator types a real PO or uploads one.
  const [customerPoIsPlaceholder, setCustomerPoIsPlaceholder] = useState(so?.customer_po_is_placeholder ?? false);
  const [genningPlaceholder, setGenningPlaceholder] = useState(false);
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
  // Which step of the upload dialog is showing: file/text → base/PPK pick →
  // confirm fuzzy choices (customer + colour rows) → or a duplicate-PO block.
  const [poStep, setPoStep] = useState<"upload" | "ambig" | "confirm" | "dup">("upload");
  // "Confirm choices" step state — a customer pick (when the parsed name didn't
  // match exactly) and a colour-row pick per fuzzy-mapped line.
  const [poCustQ, setPoCustQ] = useState<{ parsedName: string; pick: string; reasoning?: string | null } | null>(null);
  const [poColorQs, setPoColorQs] = useState<(ColorQuestion & { pick: string })[]>([]);
  // Duplicate-PO guard: a non-cancelled SO already carries this customer PO #.
  const [poDup, setPoDup] = useState<{ po: string; existing: { id: string; so_number: string | null; status: string; customer_id: string }[] } | null>(null);
  const [allStyles, setAllStyles] = useState<StyleLite[]>([]);
  const [fulfillmentSource, setFulfillmentSource] = useState(so?.fulfillment_source || "");
  // Closeout order — when ticked, commission uses the customer's closeout rate.
  const [isCloseout, setIsCloseout] = useState<boolean>(so?.is_closeout ?? false);
  // True when an uploaded customer PO auto-chose ATS and the operator hasn't yet
  // confirmed/changed it — highlights the Fulfillment source for a double-check.
  const [fulfillmentReview, setFulfillmentReview] = useState(false);
  // Scenario 5 — pending lot-allocation plan when an ATS order can't be fully
  // filled from stock; the operator accepts (backorder the rest) or cancels.
  const [lotPlan, setLotPlan] = useState<{ expanded: SaveLine[]; shortfalls: PlanLine[]; confirm: boolean } | null>(null);
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
    type DLine = { inventory_item_id: string | null; qty_ordered: number; unit_price_cents: number; style_code: string | null; color: string | null; size: string | null; inseam: string | null; sku_code: string | null; description: string | null; lot_number: string | null };
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
          sec.cells.push({ color: l.color, size: l.size, inseam: l.inseam ?? null, qty: Number(l.qty_ordered) || 0, unit: dollars || undefined, lot: l.lot_number || undefined });
        } else {
          // A null-linked (unresolved-SKU) line carries no sku_code/style_code —
          // fall back to the line description so the document/list shows what it is
          // ("VERGE 5 Pkt Slim Fit") instead of a blank "(line)".
          const flatLabel = l.sku_code
            ? `${l.sku_code}${l.style_code ? ` — ${l.style_code}` : ""}`
            : (l.description?.trim() ? `${l.description.trim()}${l.inventory_item_id ? "" : " (unmatched SKU)"}` : undefined);
          flat.push({ key: fk++, inventory_item_id: l.inventory_item_id || "", qty_ordered: String(l.qty_ordered ?? ""), unit_price_dollars: dollars, label: flatLabel, description: l.description?.trim() || undefined });
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

  // Item 19 — keep Cancel date defaulted to Start ship + 6 days until the
  // operator overrides it. setCancelDate only runs when the current value is
  // blank or equals our previous auto value, so a manual edit sticks.
  useEffect(() => {
    if (!reqShip) return;
    const auto = addDaysIso(reqShip, CANCEL_DAYS_AFTER_SHIP);
    if (!auto) return;
    setCancelDate((cur) => (!cur || cur === autoCancelRef.current ? auto : cur));
    autoCancelRef.current = auto;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqShip]);

  // #1156 — the customer's buyers, for the optional Buyer picker.
  useEffect(() => {
    if (!customerId) { setBuyers([]); return; }
    let cancel = false;
    fetch(`/api/internal/customer-buyers?customer_id=${encodeURIComponent(customerId)}`).then((r) => r.ok ? r.json() : []).then((a) => { if (!cancel) setBuyers(Array.isArray(a) ? a as { id: string; name: string; title: string | null; email?: string | null }[] : []); }).catch(() => {});
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
    // Item 9 — auto-fill Payment terms from the customer master (don't clobber a
    // value already chosen on this order).
    if (c.payment_terms_id) setPaymentTermsId((cur) => cur || c.payment_terms_id || "");
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
  const sizeCache = useRef<Map<string, { sizes: string[]; colors: string[]; inseams: string[] }>>(new Map());
  // The operator's confirmed colour-row picks from the last apply, so post-prefill
  // actions (carton rounding) keep them and don't re-raise resolved warnings.
  const poColorPicksRef = useRef<Record<string, string>>({});
  // The resolved {line, chosen-style} list + unmatched-style notes computed in
  // prepareConfirm, handed verbatim to applyParsed when the operator clicks
  // Continue — so the apply never re-resolves against (possibly stale) state and
  // reuses the matrices already fetched for the colour questions.
  const poResolvedRef = useRef<{ line: ParsedPoLine; chosen: StyleLite }[]>([]);
  const poUnmatchedRef = useRef<string[]>([]);
  async function fetchMatrix(styleId: string): Promise<{ sizes: string[]; colors: string[]; inseams: string[] }> {
    if (sizeCache.current.has(styleId)) return sizeCache.current.get(styleId)!;
    const r = await fetch(`/api/internal/style-matrix?style_id=${encodeURIComponent(styleId)}`);
    const p = r.ok ? await r.json() : null;
    // For a PREPACK style the entry column is the pack token (e.g. "PPK24"), not
    // the garment sizes — surface it so the PO prefill can size the carton even
    // when the style_code itself has no digits (e.g. RYB0594PPK → SKU size PPK24).
    const packToken: string | undefined = p?.prepack?.pack_token;
    const out = {
      sizes: packToken ? [packToken] : (Array.isArray(p?.sizes) ? p.sizes : []),
      colors: Array.isArray(p?.colors) ? p.colors : [],
      // Inseams so the PO prefill keys seeded cells onto the right body rows (the
      // matrix keys rows by inseam whenever the style has one — e.g. denim/PPK).
      inseams: Array.isArray(p?.inseams) ? p.inseams : [],
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
  // Look up any non-cancelled SO that already carries this exact customer PO #.
  async function findDuplicateSo(po: string): Promise<{ id: string; so_number: string | null; status: string; customer_id: string }[]> {
    try {
      const r = await fetch(`/api/internal/sales-orders?customer_po=${encodeURIComponent(po)}`);
      if (!r.ok) return [];
      const a = await r.json();
      return (Array.isArray(a) ? a : []).map((s: { id: string; so_number: string | null; status: string; customer_id: string }) =>
        ({ id: s.id, so_number: s.so_number, status: s.status, customer_id: s.customer_id }));
    } catch { return []; }
  }
  async function parsePO() {
    setPoErr(null); setPoParsing(true); setPoReview(null); setPoDup(null);
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
      // Duplicate guard — same customer PO # already on a (non-cancelled) SO.
      // Block the prefill and let the operator cancel rather than create a dup.
      if (parsed.customer_po_number) {
        const existing = await findDuplicateSo(parsed.customer_po_number);
        if (existing.length) { setPoDup({ po: parsed.customer_po_number, existing }); setPoStep("dup"); return; }
      }
      // Detect base/PPK ambiguity; if any, ask before building the seed.
      const ambig = parsed.lines
        .map((l) => resolveLine(l, styles))
        .filter((res) => res.ambiguous)
        .map((res) => ({ res, pick: "base" as "base" | "ppk" }));
      if (ambig.length) { setPoAmbig(ambig); setPoStep("ambig"); }
      else { await prepareConfirm(parsed, styles, {}); }
    } catch (e) {
      setPoErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPoParsing(false);
    }
  }
  // After base/PPK is resolved, gather the remaining fuzzy choices (customer +
  // colour rows). If any need confirming, show the "confirm choices" step;
  // otherwise build the prefill straight away.
  async function prepareConfirm(parsed: ParsedPo, styles: StyleLite[], picks: Record<string, "base" | "ppk">) {
    // Resolve each line to its chosen style (apply the base/PPK picks). Done ONCE
    // here; the resolved list (and the matrices fetched below) are reused by
    // applyParsed so the apply never re-resolves against possibly-stale state.
    const resolved: { line: ParsedPoLine; chosen: StyleLite }[] = [];
    const unmatchedStyles: string[] = [];
    for (const line of parsed.lines) {
      const res = resolveLine(line, styles);
      let chosen = res.chosen;
      if (res.ambiguous) {
        const pick = picks[(line.style_code || "").toLowerCase()] || "base";
        chosen = pick === "ppk" ? res.ppk : res.base;
      }
      if (chosen) resolved.push({ line: res.line, chosen });
      else unmatchedStyles.push(`Style "${line.style_code || line.description || "?"}" — not found, add manually`);
    }
    sizeCache.current.clear();
    poResolvedRef.current = resolved;
    poUnmatchedRef.current = unmatchedStyles;
    // Colour rows that didn't map cleanly → ask the operator to confirm. This
    // also populates sizeCache with each style's matrix (reused by applyParsed).
    const colorQs = (await computeColorQuestions(resolved, fetchMatrix)).map((q) => ({ ...q, pick: q.suggested }));
    // Customer that didn't match exactly → ask. Default to the AI's pick (broad,
    // semantic) when available, else the best string candidate.
    const exactCust = matchCustomerExact(parsed.customer_name, customers);
    let custQ: { parsedName: string; pick: string; reasoning?: string | null } | null = null;
    if (!exactCust && parsed.customer_name) {
      const ai = await aiMatchCustomer(parsed.customer_name);
      const fallback = customerCandidates(parsed.customer_name, customers)[0]?.id || "";
      custQ = { parsedName: parsed.customer_name, pick: ai.customer_id || fallback, reasoning: ai.reasoning };
    }
    if (colorQs.length || custQ) {
      setPoColorQs(colorQs); setPoCustQ(custQ); setPoStep("confirm");
      return;
    }
    await applyParsed(parsed, resolved, unmatchedStyles, {}, undefined);
  }
  // Ask the server's AI matcher to map a parsed customer name onto a customer in
  // the master (semantic — e.g. "Ross Stores, Inc." → "Ross Procurement"). Falls
  // back to {customer_id:null} when the AI is unavailable.
  async function aiMatchCustomer(name: string): Promise<{ customer_id: string | null; reasoning: string | null }> {
    try {
      const r = await fetch("/api/internal/sales-orders/match-customer", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      if (!r.ok) return { customer_id: null, reasoning: null };
      const j = await r.json();
      const id = j.customer_id && customers.some((c) => c.id === j.customer_id) ? j.customer_id : null;
      return { customer_id: id, reasoning: j.reasoning ?? null };
    } catch { return { customer_id: null, reasoning: null }; }
  }
  // Build the prefill + header from a parsed PO using the resolved list computed
  // in prepareConfirm. `colorPicks` carries operator-confirmed colour rows
  // (colorPickKey → colour). `customerPick` is the confirmed customer id from the
  // choices step ("" = leave to pick manually); `undefined` means no customer
  // question was asked → fall back to the exact/fuzzy match.
  async function applyParsed(
    parsed: ParsedPo, resolved: { line: ParsedPoLine; chosen: StyleLite }[], unmatchedStyles: string[],
    colorPicks: Record<string, string> = {}, customerPick?: string,
  ) {
    const summary: string[] = [];
    const unmatched: string[] = [...unmatchedStyles];

    // Header
    // PO # — honour an explicit "use a placeholder" instruction (item: the app
    // generates the placeholder via its own endpoint instead of trusting an
    // AI-invented number), else use the parsed real PO number.
    if (parsed.use_placeholder_po) {
      try {
        const rp = await fetch("/api/internal/sales-orders/placeholder-po", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        const jp = await rp.json().catch(() => ({}));
        if (rp.ok && jp.customer_po) { setCustomerPo(jp.customer_po); setCustomerPoIsPlaceholder(true); summary.push(`Placeholder PO ${jp.customer_po}`); }
        else { unmatched.push("Placeholder PO requested — couldn't generate one, use the Generate placeholder button."); }
      } catch { unmatched.push("Placeholder PO requested — couldn't generate one, use the Generate placeholder button."); }
    } else if (parsed.customer_po_number) {
      setCustomerPo(parsed.customer_po_number); setCustomerPoIsPlaceholder(false); summary.push(`PO # ${parsed.customer_po_number}`);
    }
    const custId = customerPick !== undefined ? (customerPick || null) : matchCustomer(parsed.customer_name, customers);
    // pickCustomer (not a bare setCustomerId) so the customer's underlying data
    // loads exactly like a manual selection: ship-to (default location), channel,
    // brand and payment-terms autofill.
    if (custId) { pickCustomer(custId); summary.push(`Customer: ${customers.find((c) => c.id === custId)?.name}`); }
    else if (parsed.customer_name) unmatched.push(`Customer "${parsed.customer_name}" — pick manually`);
    // Payment terms from the PO override the customer-master autofill when present.
    const ptId = matchPaymentTerms(parsed.payment_terms, paymentTerms);
    if (ptId) { setPaymentTermsId(ptId); summary.push(`Terms: ${paymentTerms.find((t) => t.id === ptId)?.name}`); }
    else if (parsed.payment_terms) unmatched.push(`Payment terms "${parsed.payment_terms}" — pick manually`);
    const ss = isoDate(parsed.start_ship_date); if (ss) { setReqShip(ss); summary.push(`Start ship ${fmtDateDisplay(ss)}`); }
    const cd = isoDate(parsed.cancel_date); if (cd) { setCancelDate(cd); summary.push(`Cancel ${fmtDateDisplay(cd)}`); }
    // Fulfillment source — honour an explicit instruction ("from production" /
    // "from stock"); otherwise default to ATS and flag it for the operator to
    // confirm. An explicit choice is set without the "please confirm" flag.
    if (parsed.fulfillment_source === "production") {
      setFulfillmentSource("production"); setFulfillmentReview(false); summary.push("Fulfillment: Production");
    } else if (parsed.fulfillment_source === "ats") {
      setFulfillmentSource("ats"); setFulfillmentReview(false); summary.push("Fulfillment: ATS");
    } else {
      setFulfillmentSource("ats"); setFulfillmentReview(true); summary.push("Fulfillment: ATS (please confirm)");
    }

    // Reuse the matrices fetched in prepareConfirm (sizeCache is NOT cleared here)
    // so the seed builds from the exact data the colour questions were based on.
    poColorPicksRef.current = colorPicks;
    const { sections, warnings } = await buildSeedFromResolved(resolved, fetchMatrix, colorPicks);
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
    setPoColorQs([]);
    setPoCustQ(null);
    setPoStep("upload");
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
      const { sections, warnings } = await buildSeedFromResolved(resolved, fetchMatrix, poColorPicksRef.current);
      setSeedKey((k) => k + 1);
      setSeed({ sections, flat: [] });
      setPoReview((prev) => prev ? { ...prev, warnings, summary: [...prev.summary, "Rounded sizes up to full cartons"] } : prev);
    })();
  }

  // Item 16 — gate Add-style / Add-line with specific, click-time warnings.
  // Warehouse (the order's sale_store) is a must, alongside the Customer PO.
  function tryAddLine(kind: "section" | "flat") {
    if (!customerId) { notify("Pick a customer first.", "error"); return; }
    if (!shipToLocationId) { notify("Ship-to address must be populated before adding styles.", "error"); return; }
    if (!customerPo.trim()) { notify("Customer PO must be populated before adding styles.", "error"); return; }
    if (!saleStore.trim()) { notify("Warehouse must be populated before adding styles.", "error"); return; }
    if (!fulfillmentSource) { notify("Pick a Fulfillment source (ATS or Production) before adding styles.", "error"); return; }
    if (kind === "section") bodyRef.current?.addSection(); else bodyRef.current?.addFlat();
  }

  // Item 15 — cancel date cannot be earlier than the start-ship date.
  const cancelBeforeShip = !!(reqShip && cancelDate && cancelDate < reqShip);

  async function save(confirm: boolean) {
    setErr(null);
    if (!customerId) { setErr("Pick a customer."); return; }
    if (!shipToLocationId) { setErr("Pick a Ship-to address."); return; }
    if (!fulfillmentSource) { setErr("Select a Fulfillment source — ATS (ship from stock) or Production (make it)."); return; }
    if (!saleStore.trim()) { setErr("Pick a Warehouse."); return; }
    if (cancelBeforeShip) { setErr("Cancel date can't be earlier than the Start ship date."); return; }
    setSubmitting(true);
    // Resolve the matrix grids + flat lines → SO line payload (find-or-create
    // SKUs). Done before the header build so a resolve error surfaces cleanly.
    let resolvedLines: SaveLine[] = [];
    try {
      resolvedLines = ((await bodyRef.current?.resolve()) || []) as SaveLine[];
    } catch (e) {
      setErr(`Could not resolve order lines: ${e instanceof Error ? e.message : String(e)}`);
      setSubmitting(false);
      return;
    }
    if (resolvedLines.length === 0) { setErr("Add at least one line with a quantity."); setSubmitting(false); return; }

    // Scenario 5 — ATS (ship from available stock): allocate each line across
    // lots (fill from as few lots as possible) and split into per-lot lines. If
    // any line can't be fully filled, show the plan + shortfall for the operator
    // to accept (backorder the rest) or cancel. Production orders skip this.
    if (fulfillmentSource === "ats") {
      try {
        const need = resolvedLines
          .filter((l) => l.inventory_item_id && l.qty_ordered > 0)
          .map((l) => ({ item_id: l.inventory_item_id as string, qty: l.qty_ordered }));
        if (need.length > 0) {
          const r = await fetch("/api/internal/sales-orders/allocate-by-lot", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lines: need }),
          });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
          const plan = await r.json() as { lines: PlanLine[] };
          const expanded = expandByPlan(resolvedLines, plan.lines || []);
          const shortfalls = (plan.lines || []).filter((l) => l.shortfall > 0);
          if (shortfalls.length > 0) { setLotPlan({ expanded, shortfalls, confirm }); setSubmitting(false); return; }
          await commitSave(expanded, confirm);
          return;
        }
      } catch (e) {
        setErr(`Lot allocation failed: ${e instanceof Error ? e.message : String(e)}`);
        setSubmitting(false);
        return;
      }
    }
    await commitSave(resolvedLines, confirm);
  }

  // Scenario 5 — turn an allocation plan into per-lot SO lines. Each lot pick
  // becomes its own line (carrying lot_number); any shortfall stays one unlotted
  // line so the customer's full ordered quantity is preserved (backorder).
  function expandByPlan(resolved: SaveLine[], planLines: PlanLine[]): SaveLine[] {
    const byItem = new Map(planLines.map((l) => [l.item_id, l]));
    const out: SaveLine[] = [];
    for (const rl of resolved) {
      const plan = rl.inventory_item_id ? byItem.get(rl.inventory_item_id) : null;
      if (!plan || plan.picks.length === 0) { out.push(rl); continue; } // no lotted stock → leave as-is
      for (const p of plan.picks) out.push({ ...rl, qty_ordered: p.qty, lot_number: p.lot_number });
      if (plan.shortfall > 0) out.push({ ...rl, qty_ordered: plan.shortfall, lot_number: null });
    }
    return out;
  }

  // POST/PATCH the SO with a final line set (per-lot-expanded for ATS, or raw).
  async function commitSave(lines: SaveLine[], confirm: boolean) {
    try {
      // Per-line Customer PO split: pull every line whose customer_po differs
      // from the header PO onto a NEW auto-created SO, grouped by that PO. Lines
      // matching the header PO (or carrying none) stay on this order. The per-
      // line tag is stripped from the payload — each resulting SO's HEADER
      // carries its PO (no line-level column needed).
      const headerPo = customerPo.trim();
      const stripPo = (l: SaveLine): SaveLine => { const { customer_po: _drop, ...rest } = l; return rest; };
      const parentLines: SaveLine[] = [];
      const childByPo = new Map<string, SaveLine[]>();
      for (const l of lines) {
        const lp = (l.customer_po ?? "").trim();
        if (!lp || lp === headerPo) parentLines.push(stripPo(l));
        else { const g = childByPo.get(lp) || []; g.push(stripPo(l)); childByPo.set(lp, g); }
      }
      const hasSplit = childByPo.size > 0;
      if (hasSplit && parentLines.length === 0) {
        setErr("At least one style line must keep the header Customer PO. Change one line back to the header PO, or update the header PO to match.");
        setSubmitting(false);
        return;
      }

      const body: Record<string, unknown> = {
        customer_id: customerId, ship_to_location_id: shipToLocationId || null,
        brand_id: brandId || null, channel_id: channelId || null,
        order_date: orderDate, requested_ship_date: reqShip || null, cancel_date: cancelDate || null,
        payment_terms_id: paymentTermsId || null, buyer_id: buyerId || null, notes: notes.trim() || null, lines: parentLines,
        customer_po: customerPo.trim() || null,
        customer_po_is_placeholder: customerPoIsPlaceholder,
        is_bulk_order: isBulkOrder,
        sale_store: saleStore || null,
        fulfillment_source: fulfillmentSource || null,
        is_closeout: isCloseout,
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
        // Scenario 2 — surface lot propagation when a placeholder PO was replaced.
        const pj = await r.json().catch(() => ({}));
        if (pj?.relotted?.lines > 0) notify(`Customer PO updated — re-lotted ${pj.relotted.lines} line(s) across ${pj.relotted.pos} not-yet-received PO(s) from ${pj.relotted.from} → ${pj.relotted.to}.`, "success");
      }

      if (confirm && soId) {
        const r = await fetch(`/api/internal/sales-orders/${soId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "confirmed" }) });
        if (!r.ok) throw new Error(`Saved, but confirm failed: ${(await r.json().catch(() => ({}))).error || `HTTP ${r.status}`}`);
        const cj = await r.json().catch(() => ({}));
        notify("Sales order confirmed — SO number assigned.", "success");
        if (cj?.production_notice?.skipped) notify(cj.production_notice.reason || "Production order: no Production recipient configured.", "info");
        else if (cj?.production_notice?.sent) notify(`Production Manager notified (${cj.production_notice.sent} recipient${cj.production_notice.sent === 1 ? "" : "s"}).`, "success");
      }

      // Per-line PO split — after the parent is saved (+ confirmed as clicked),
      // create one NEW SO per distinct new PO. Each child copies ALL of this
      // order's header info (customer, ship-to, brand, channel, dates, terms,
      // buyer, warehouse, fulfillment, factor…) via the shared `body`, carries
      // only its own line group, is force-confirmed, and gets an audit note.
      if (hasSplit && soId) {
        const AUTO_NOTE = "Auto created due to new Customer PO";
        const childNotes = notes.trim() ? `${notes.trim()}\n${AUTO_NOTE}` : AUTO_NOTE;
        const created: { id: string | null; so_number: string | null; po: string; qty: number; styles: number }[] = [];
        for (const [po, childLines] of childByPo) {
          const childBody = { ...body, lines: childLines, customer_po: po, customer_po_is_placeholder: false, notes: childNotes };
          const cr = await fetch("/api/internal/sales-orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(childBody) });
          if (!cr.ok) throw new Error(`Auto-split SO for PO ${po} failed: ${(await cr.json().catch(() => ({}))).error || `HTTP ${cr.status}`}`);
          const childRow = await cr.json();
          const childId: string | null = childRow?.id || null;
          let childNo: string | null = childRow?.so_number || null;
          if (childId) {
            const cf = await fetch(`/api/internal/sales-orders/${childId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "confirmed" }) });
            if (!cf.ok) throw new Error(`Auto-split SO for PO ${po} was created but could not be confirmed: ${(await cf.json().catch(() => ({}))).error || `HTTP ${cf.status}`}`);
            const cfj = await cf.json().catch(() => ({}));
            childNo = cfj?.so_number || childNo;
          }
          created.push({ id: childId, so_number: childNo, po, qty: childLines.reduce((a, l) => a + (l.qty_ordered || 0), 0), styles: childLines.length });
        }
        setSplitResult({ parentPo: headerPo || null, created });
        setSubmitting(false);
        return; // summary modal handles the refresh on close
      }

      // Scenario 4.2 — a saved distro (non-bulk SO with a customer PO) is matched
      // against open bulk orders for the same customer. If any overlap, show the
      // match modal (which calls onSaved on close) instead of closing now.
      if (soId && !isBulkOrder && customerPo.trim()) {
        try {
          const mr = await fetch("/api/internal/sales-orders/bulk-match", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sales_order_id: soId }) });
          const mj = await mr.json().catch(() => ({}));
          if (mr.ok && Array.isArray(mj.matches) && mj.matches.length > 0) {
            setBulkMatches(mj.matches);
            setSubmitting(false);
            return; // keep the modal open; bulk modal handles the refresh on close
          }
        } catch { /* non-blocking */ }
      }
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  // Scenario 4.2 — cancel a bulk order superseded by distros (normal status PATCH).
  async function cancelBulk(bulkId: string) {
    setBulkBusy(true);
    try {
      const r = await fetch(`/api/internal/sales-orders/${bulkId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "cancelled" }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setBulkMatches((p) => (p || []).filter((m) => m.id !== bulkId));
      notify("Bulk order cancelled.", "success");
    } catch (e) { notify(`Could not cancel the bulk order: ${e instanceof Error ? e.message : String(e)}`, "error"); }
    finally { setBulkBusy(false); }
  }
  // Close the bulk-match modal and refresh the list (the distro was already saved).
  function closeBulkMatch() { setBulkMatches(null); setBulkDetail(null); onSaved(); }
  // Scenario 4.2 — view details: download the bulk↔distro breakdown as CSV
  // (opens in Excel) or print it.
  function bulkRows(m: BulkMatchRow) {
    return [["Style", "Color", "Bulk qty", "Distro qty", "Matched"],
      ...m.breakdown.map((r) => [r.style_code, r.color ?? "", String(r.bulk_qty), String(r.distro_qty), String(r.matched)])];
  }
  function downloadBulkCsv(m: BulkMatchRow) {
    const csv = bulkRows(m).map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url; a.download = `bulk-match-${m.so_number || m.customer_po || m.id.slice(0, 8)}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
  function printBulkDetail(m: BulkMatchRow) {
    const w = window.open("", "_blank", "width=800,height=600");
    if (!w) return;
    const rows = bulkRows(m);
    const head = rows[0].map((h) => `<th style="text-align:left;border-bottom:2px solid #333;padding:6px 10px">${h}</th>`).join("");
    const body = rows.slice(1).map((r) => `<tr>${r.map((c) => `<td style="border-bottom:1px solid #ccc;padding:6px 10px">${c}</td>`).join("")}</tr>`).join("");
    w.document.write(`<html><head><title>Bulk match ${m.so_number || m.customer_po || ""}</title></head><body style="font-family:system-ui,Arial,sans-serif"><h3>Bulk ${m.so_number || ""} ${m.customer_po ? `(PO ${m.customer_po})` : ""} — ${m.match_pct}% of distro / ${m.bulk_coverage_pct}% of bulk</h3><table style="border-collapse:collapse;font-size:13px">${head}${body}</table></body></html>`);
    w.document.close(); w.focus(); w.print();
  }

  // M10-C — generate a draft AR invoice from this SO's open lines.
  const canInvoice = !isNew && so != null && ["confirmed", "allocated", "fulfilling", "shipped"].includes(so.status);
  // Item 1 — the just-created draft invoice (drives the View / Post / Close dialog).
  const [invoiceResult, setInvoiceResult] = useState<{ id: string; number: string } | null>(null);
  // Per-line PO split result — the new SOs auto-created for lines whose Customer
  // PO differed from the header. Shown in a summary modal (open each in a tab).
  const [splitResult, setSplitResult] = useState<{ parentPo: string | null; created: { id: string | null; so_number: string | null; po: string; qty: number; styles: number }[] } | null>(null);
  const [postingInvoice, setPostingInvoice] = useState(false);
  async function createInvoice() {
    if (!so) return;
    setErr(null); setSubmitting(true);
    try {
      // Item 3 — quick-ship gate: auto-allocate available on-hand to this order
      // first. If it can't be filled 100% we DON'T invoice — open the Allocations
      // workbench so the operator reviews/approves the (partial) allocation.
      // Only confirmed/allocated SOs can (re-)allocate; a fulfilling/shipped order
      // is already past allocation, so skip the gate and invoice directly.
      if (so.status === "confirmed" || so.status === "allocated") {
        const ar = await fetch(`/api/internal/sales-orders/${so.id}/allocate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        const aj = await ar.json().catch(() => ({}));
        if (!ar.ok) throw new Error(aj.error || `Allocation failed (HTTP ${ar.status})`);
        const fully = aj.fully_allocated === true
          || !(Array.isArray(aj.lines) && aj.lines.some((l: { shortfall?: number }) => Number(l.shortfall) > 0));
        if (!fully) {
          notify("Not enough inventory to quick-ship this order 100%. Opening Allocations — please review and approve the allocation.", "info");
          openAllocations();
          return;
        }
      }
      // Fully allocated → create the draft AR invoice.
      const r = await fetch(`/api/internal/sales-orders/${so.id}/create-invoice`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      // Item 1 — surface the draft + let the operator View / Post / Close.
      setInvoiceResult({ id: j.invoice_id, number: j.invoice_number });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }
  function viewInvoice() {
    if (invoiceResult) window.location.href = `?m=ar_invoices&q=${encodeURIComponent(invoiceResult.number)}`;
  }
  async function postInvoiceNow() {
    if (!invoiceResult) return;
    setPostingInvoice(true);
    try {
      const r = await fetch(`/api/internal/ar-invoices/${invoiceResult.id}/post`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify(`Invoice ${invoiceResult.number} posted.`, "success");
      setInvoiceResult(null);
      onSaved();
    } catch (e) {
      notify(`Post failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally { setPostingInvoice(false); }
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

  // Non-factor credit ship-gate — operator actions. The gate is server-owned
  // (409 on allocate/ship); these are the operator release/record paths.
  // "Override → Approve" sets credit_approval_status='approved' (source manual);
  // "Record payment" posts a manual payment that, on a paid-in-full CREDIT_CARD
  // order, auto-approves the gate. Both visible on a non-draft SO that carries a
  // surfaced credit status (on_hold / pending).
  const creditStatus = so?.credit_approval_status || "not_required";
  const creditOnHold = !isNew && (creditStatus === "on_hold" || creditStatus === "pending");
  async function overrideApproveCredit() {
    if (!so) return;
    const ok = await confirmDialog(
      `Override the credit hold on this order and mark it APPROVED to ship?\n\n${so.credit_hold_reason || "This releases the non-factor credit ship-gate."}`,
      "Approve credit override",
    );
    if (!ok) return;
    setErr(null); setSubmitting(true);
    try {
      const r = await fetch(`/api/internal/sales-orders/${so.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credit_approval_status: "approved", credit_approval_source: "manual" }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify("Credit hold overridden — order approved to ship.", "success");
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  // Reinstate a cancelled order — status returns to 'confirmed' (keeps its SO #).
  async function reinstateSO() {
    if (!so) return;
    const ok = await confirmDialog(
      "This order's status will change to confirmed.",
      { confirmText: "Continue", title: `Reinstate ${so.so_number || "sales order"}` },
    );
    if (!ok) return;
    setErr(null); setSubmitting(true);
    try {
      const r = await fetch(`/api/internal/sales-orders/${so.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "confirmed" }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify(`Sales order ${so.so_number || ""} reinstated — status is now confirmed.`, "success");
      onSaved();
    } catch (e) { notify(`Could not reinstate: ${e instanceof Error ? e.message : String(e)}`, "error"); }
    finally { setSubmitting(false); }
  }

  // Record-payment dialog (credit-card orders). Manual record path; a future
  // hosted-payment/webhook flow can drive the same server endpoint.
  const [payOpen, setPayOpen] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState("credit_card");
  const [payReference, setPayReference] = useState("");
  const isCardOrder = useMemo(() => {
    const t = paymentTerms.find((pt) => pt.id === (so?.payment_terms_id || paymentTermsId));
    return t?.code === "CREDIT_CARD";
  }, [paymentTerms, so, paymentTermsId]);
  function openPayModal() {
    // Default the amount to the outstanding balance (total − already paid).
    const total = Number(so?.total_cents ?? 0);
    const paid = Number(so?.amount_paid_cents ?? 0);
    const due = Math.max(total - paid, 0);
    setPayAmount(due > 0 ? (due / 100).toFixed(2) : "");
    setPayReference(""); setPayMethod("credit_card"); setPayOpen(true);
  }
  async function recordPayment() {
    if (!so) return;
    const dollars = moneyToNumber(payAmount);
    if (dollars == null || dollars <= 0) { setErr("Enter a payment amount greater than 0."); return; }
    setErr(null); setSubmitting(true);
    try {
      const r = await fetch(`/api/internal/sales-orders/${so.id}/record-payment`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: Math.round(dollars * 100), method: payMethod, reference: payReference.trim() || null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify(j.message || "Payment recorded.", j.paid_in_full ? "success" : "info");
      setPayOpen(false);
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
        || !!shipToLocationId || !!brandId || !!channelId || !!buyerId || !!paymentTermsId || !!fulfillmentSource || !!saleStore;
    }
    return addMode; // editing an existing SO — warn only once they start adding/editing lines
  }
  async function requestClose() {
    if (submitting) return;
    if (hasUnsavedData() && !(await confirmDialog("This sales order hasn't been saved. Close and discard your changes?"))) return;
    onClose();
  }

  // Build the SO confirmation document (shared by the printable/PDF view and
  // the Excel download so they never diverge).
  function buildOrderDoc(): OrderDocument {
    const fields: { label: string; value: string }[] = [];
    const add = (label: string, value: string | null | undefined) => { if (value && String(value).trim()) fields.push({ label, value: String(value) }); };
    add("Customer PO #", customerPo);
    add("Order date", orderDate ? fmtDateDisplay(orderDate) : "");
    add("Requested ship", reqShip ? fmtDateDisplay(reqShip) : "");
    add("Cancel date", cancelDate ? fmtDateDisplay(cancelDate) : "");
    add("Payment terms", paymentTerms.find((t) => t.id === paymentTermsId)?.name);
    add("Brand", brands.find((b) => b.id === brandId)?.name);
    add("Channel", channels.find((c) => c.id === channelId)?.name);
    add("Buyer", buyers.find((b) => b.id === buyerId)?.name);
    add("Fulfillment", fulfillmentSource);
    return {
      kind: "so",
      title: "Sales Order",
      number: so?.so_number || "(draft)",
      status: so?.status || (isNew ? "draft" : null),
      partyLabel: "Customer",
      partyName: customers.find((c) => c.id === customerId)?.name || "",
      moneyLabel: "Unit $",
      fields,
      data: bodyRef.current?.getDocumentData() || { styles: [], flats: [] },
      notes,
    };
  }
  // Open the printable / downloadable SO document (logo + header + line items).
  function openView(autoPrint = false) { openOrderDocument({ ...buildOrderDoc(), autoPrint }); }

  // Item 13 — persist ONLY the header (no line resolution / replacement), so a
  // saved order's header can be corrected at any status without re-touching lines.
  async function saveHeaderOnly() {
    setErr(null);
    if (!customerId) { setErr("Pick a customer."); return; }
    if (!shipToLocationId) { setErr("Pick a Ship-to address."); return; }
    if (cancelBeforeShip) { setErr("Cancel date can't be earlier than the Start ship date."); return; }
    setSubmitting(true);
    try {
      const fa = moneyToNumber(factorApprovedDollars);
      const body: Record<string, unknown> = {
        customer_id: customerId, ship_to_location_id: shipToLocationId || null,
        brand_id: brandId || null, channel_id: channelId || null,
        order_date: orderDate, requested_ship_date: reqShip || null, cancel_date: cancelDate || null,
        payment_terms_id: paymentTermsId || null, buyer_id: buyerId || null, notes: notes.trim() || null,
        customer_po: customerPo.trim() || null, customer_po_is_placeholder: customerPoIsPlaceholder,
        is_bulk_order: isBulkOrder, sale_store: saleStore || null,
        fulfillment_source: fulfillmentSource || null, is_closeout: isCloseout,
        factor_approval_status: factorStatus, factor_reference: factorReference.trim() || null,
        factor_approved_cents: fa == null ? null : Math.round(fa * 100),
        // NB: no `lines` key → the [id] PATCH leaves lines untouched.
      };
      const r = await fetch(`/api/internal/sales-orders/${so!.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify("Order header saved.", "success");
      setHeaderEditMode(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const confirmMenuItem: React.CSSProperties = { display: "block", width: "100%", textAlign: "left", background: "transparent", color: "#F1F5F9", border: 0, borderBottom: "1px solid #334155", padding: "9px 14px", fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" };
  const saveCloseButtons = (
    <>
      <button onClick={() => void requestClose()} style={btnSecondary} disabled={submitting}>Close</button>
      {/* Item 7 — single "Confirmation" entry point: download Excel, save PDF, or email the buyer on the SO. */}
      <span style={{ position: "relative", display: "inline-flex" }}>
        <button onClick={() => setConfirmMenuOpen((o) => !o)} style={btnSecondary} disabled={submitting} title="Download to Excel, save as PDF, or email this order confirmation to the buyer">Confirmation ▾</button>
        {confirmMenuOpen && (
          <>
            <div onClick={() => setConfirmMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 90 }} />
            <div style={{ position: "absolute", bottom: "100%", left: 0, marginBottom: 6, zIndex: 91, background: "#1E293B", border: "1px solid #334155", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.45)", minWidth: 210, overflow: "hidden" }}>
              <button onClick={() => { setConfirmMenuOpen(false); void downloadOrderExcel(buildOrderDoc()); }} style={confirmMenuItem}>Download to Excel</button>
              <button onClick={() => { setConfirmMenuOpen(false); openView(true); }} style={confirmMenuItem}>Save as PDF / Print</button>
              <button
                onClick={() => { if (isNew || so == null) return; setConfirmMenuOpen(false); setEmailOpen(true); }}
                disabled={isNew || so == null}
                title={isNew || so == null ? "Save the order first, then email its confirmation" : "Email the confirmation to the buyer on this order (or pick another contact), optionally attaching documents"}
                style={{ ...confirmMenuItem, borderBottom: 0, opacity: isNew || so == null ? 0.5 : 1, cursor: isNew || so == null ? "not-allowed" : "pointer" }}
              >Email confirmation to buyer…</button>
            </div>
          </>
        )}
      </span>
      {/* Item 13 — edit the header on a saved order without re-opening the lines. */}
      {!isNew && !editable && !headerEditMode && so?.status !== "cancelled" && (
        <button onClick={() => setHeaderEditMode(true)} style={btnSecondary} disabled={submitting} title="Edit the order header (customer, ship-to, dates, terms, brand, channel, warehouse, PO #, notes) without changing lines">✎ Edit header</button>
      )}
      {headerEditMode && (
        <button onClick={() => void saveHeaderOnly()} style={btnPrimary} disabled={submitting}>{submitting ? "Saving…" : "Save header"}</button>
      )}
      {editable && <button onClick={() => void save(false)} style={btnSecondary} disabled={submitting}>{submitting ? "Saving…" : isNew ? "Create draft" : addMode ? "Save changes" : "Save draft"}</button>}
      {editable && !addMode && <button onClick={() => void save(true)} style={btnPrimary} disabled={submitting}>{submitting ? "…" : "Save & Confirm"}</button>}
      {!editable && !isNew && so?.status === "confirmed" && !headerEditMode && <button onClick={() => void save(false)} style={btnPrimary} disabled={submitting}>{submitting ? "Saving…" : "Save"}</button>}
    </>
  );

  return (
    <div onClick={() => void requestClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(1180px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        {/* When the SO has been billed into an AR invoice, the header turns
            green and links straight to that invoice (?m=ar_invoices&q=<INV#>).
            Otherwise it's the plain "Sales order … — <status>" title. */}
        {/* Status word is coloured with the SAME STATUS_COLORS + ● dot the grid
            uses, so the header matches the row the operator clicked (conformity). */}
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {isNew ? "New sales order" : relatedInvoice ? (
            <span>
              Sales order {so?.so_number || "(draft)"} — <span style={{ color: STATUS_COLORS[so?.status || ""] || C.text, fontWeight: 700 }}>● {so?.status}</span>{" · "}
              <span
                onClick={() => { window.location.href = `?m=ar_invoices&q=${encodeURIComponent(relatedInvoice.invoice_number)}`; }}
                title={`Open AR invoice ${relatedInvoice.invoice_number}`}
                style={{ color: C.success, cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted" }}
              >{relatedInvoice.invoice_number} ↗</span>
            </span>
          ) : (
            <span>Sales order {so?.so_number || "(draft)"} — <span style={{ color: STATUS_COLORS[so?.status || ""] || C.text, fontWeight: 700 }}>● {so?.status}</span></span>
          )}
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Customer">
            {/* Item 8 — pick an existing customer, or type a new name and click the
                "+ Add …" row that appears when there's no match to create it on the
                fly (replaces the old "+ New" button). */}
            <SearchableSelect value={customerId || null} onChange={(v) => pickCustomer(v)}
              options={customers.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.name} ${c.customer_code || ""}` }))}
              placeholder="(pick customer…)" disabled={!headerEditable}
              onAddNew={headerEditable ? (q) => { setQuickAddInitialName(q.trim()); setQuickAddCustomer(true); } : undefined}
              addNewLabel={(q) => `+ Add customer "${q.trim()}"`} />
          </Field>
          <Field label="Buyer (optional)">
            <SearchableSelect value={buyerId || null} onChange={(v) => setBuyerId(v)}
              options={[{ value: "", label: "(none)" }, ...buyers.map((b) => ({ value: b.id, label: b.title ? `${b.name} — ${b.title}` : b.name }))]}
              placeholder={customerId ? (buyers.length ? "(none)" : "(no buyers on this customer)") : "(pick customer first)"}
              disabled={!headerEditable || !customerId} />
          </Field>
          <Field label="Ship-to address *">
            <SearchableSelect value={shipToLocationId || null} onChange={(v) => setShipToLocationId(v)}
              options={[{ value: "", label: "(select)" }, ...shipTos.map((s) => ({ value: s.id, label: s.code ? `${s.code} — ${s.name}` : s.name }))]}
              placeholder={customerId ? "(select)" : "(pick customer first)"} disabled={!headerEditable || !customerId} />
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
          {/* Item 22 — header labels removed (the field + its required warning + Upload button stay). */}
          <Field label="">
            <input type="text" value={customerPo} onChange={(e) => { setCustomerPo(e.target.value); setCustomerPoIsPlaceholder(false); }} disabled={!headerEditable}
              style={{ ...inputStyle, borderColor: customerPoIsPlaceholder ? "#F59E0B" : (editable && !customerPo.trim() ? C.warn : C.cardBdr) }}
              placeholder="the customer's PO number" />
            {editable && !customerPo.trim() && (
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: C.warn }}>Required — enter the customer PO before adding styles.</span>
                <button type="button" disabled={genningPlaceholder} onClick={async () => {
                  setGenningPlaceholder(true);
                  try {
                    const r = await fetch("/api/internal/sales-orders/placeholder-po", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
                    const j = await r.json().catch(() => ({}));
                    if (!r.ok || !j.customer_po) throw new Error(j.error || `HTTP ${r.status}`);
                    setCustomerPo(j.customer_po); setCustomerPoIsPlaceholder(true);
                    notify(`Placeholder PO ${j.customer_po} assigned — replace it when the real customer PO arrives.`, "info");
                  } catch (e) { notify(`Could not generate a placeholder PO: ${e instanceof Error ? e.message : String(e)}`, "error"); }
                  finally { setGenningPlaceholder(false); }
                }} style={{ ...btnSecondary, fontSize: 11, padding: "2px 8px" }} title="Open the order now with a placeholder PO; replace it when the buyer's real PO comes in (Scenario 2).">
                  {genningPlaceholder ? "…" : "Generate placeholder"}
                </button>
              </div>
            )}
            {customerPoIsPlaceholder && customerPo.trim() && (
              <div style={{ fontSize: 11, color: "#F59E0B", marginTop: 4 }}>
                Placeholder PO. When the real customer PO arrives, replace it here (or upload it) — every not-yet-received PO on this order is re-lotted to the new number.
              </div>
            )}
            <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 12, color: C.textSub, cursor: editable ? "pointer" : "default" }} title="A bulk order is split later into multiple distro customer POs. Incoming distros are matched against it (Scenario 4.2).">
              <input type="checkbox" checked={isBulkOrder} disabled={!headerEditable} onChange={(e) => setIsBulkOrder(e.target.checked)} />
              Bulk order (split later across distro customer POs)
            </label>
          </Field>
          {isNew && editable && (
            <Field label="">
              <button type="button" onClick={() => { setPoErr(null); setPoReview(null); setPoAmbig([]); setPoColorQs([]); setPoCustQ(null); setPoDup(null); setPoStep("upload"); setPoUploadOpen(true); }}
                style={{ ...btnSecondary, color: C.primary, borderColor: C.primary, width: "100%" }}>
                Upload customer PO
              </button>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>PDF, Excel/CSV, or paste the email — AI fills the header + matrix.</div>
            </Field>
          )}
        </div>

        {/* Post-prefill "double-check" review banner. */}
        {poReview && (
          <div style={{ marginBottom: 12, padding: "10px 12px", background: "#0b1f17", border: `1px solid ${C.success}`, borderRadius: 8 }}>
            <div style={{ color: C.success, fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Prefilled from the customer PO — please double-check everything before saving.</div>
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
          <Field label="Order date"><input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} disabled={!headerEditable} style={inputStyle} /></Field>
          <Field label="Start Ship"><input type="date" value={reqShip} onChange={(e) => setReqShip(e.target.value)} disabled={!headerEditable} style={inputStyle} /></Field>
          <Field label="Cancel date">
            <input type="date" value={cancelDate} onChange={(e) => setCancelDate(e.target.value)} disabled={!headerEditable} style={{ ...inputStyle, borderColor: cancelBeforeShip ? C.warn : C.cardBdr }} />
            {cancelBeforeShip && <div style={{ fontSize: 11, color: C.warn, marginTop: 4 }}>Cancel date is before the Start ship date.</div>}
          </Field>
          <Field label="Payment terms">
            <SearchableSelect value={paymentTermsId || null} onChange={(v) => setPaymentTermsId(v)}
              options={[{ value: "", label: "(select)" }, ...paymentTerms.map((t) => ({ value: t.id, label: t.name, searchHaystack: `${t.name} ${t.code || ""}` }))]} placeholder="(select)" disabled={!headerEditable} />
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Brand">
            {/* Name only (no codes); code stays searchable. Auto-fills from the selected style. */}
            <SearchableSelect value={brandId || null} onChange={(v) => setBrandId(v)}
              options={[{ value: "", label: "(entity default)" }, ...brands.map((b) => ({ value: b.id, label: b.name, searchHaystack: `${b.code || ""} ${b.name}` }))]} placeholder="(entity default)" disabled={!headerEditable} />
          </Field>
          <Field label="Channel">
            {/* Name only (no codes); code stays searchable. Auto-fills from the customer. */}
            <SearchableSelect value={channelId || null} onChange={(v) => setChannelId(v)}
              options={[{ value: "", label: "(select)" }, ...channels.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.code || ""} ${c.name}` }))]} placeholder="(select)" disabled={!headerEditable} />
          </Field>
          <Field label="Warehouse *">
            {/* The order's warehouse (sale_store, from Xoro SaleStoreName). Tangerine
                has warehouses + brands, no sales stores. Required to add styles. */}
            <SearchableSelect value={saleStore || null} onChange={(v) => setSaleStore(v || "")}
              options={[{ value: "", label: "(select)" }, ...Array.from(new Set([...storeOptions, ...(saleStore ? [saleStore] : [])])).map((s) => ({ value: s, label: s }))]}
              placeholder="(select warehouse)" disabled={!headerEditable} />
            {headerEditable && !saleStore.trim() && <div style={{ fontSize: 11, color: C.warn, marginTop: 4 }}>Required to add styles.</div>}
          </Field>
        </div>

        {/* Item 3 — Factor / credit-insurance approval (Rosenthal & Rosenthal). Manual entry now. */}
        <div style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Factor / Ins Approval</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <Field label="Status">
              <SearchableSelect value={factorStatus || null} onChange={(v) => setFactorStatus(v || "not_submitted")}
                options={FACTOR_STATUSES.map((s) => ({ value: s, label: s }))} placeholder="not_submitted" disabled={!headerEditable} />
            </Field>
            <Field label="Factor ref #"><input type="text" value={factorReference} onChange={(e) => setFactorReference(e.target.value)} disabled={!headerEditable} style={inputStyle} placeholder="approval / ref number" /></Field>
            <Field label="Approved $"><input type="text" inputMode="decimal" value={factorApprovedDollars} onChange={(e) => setFactorApprovedDollars(e.target.value)} onBlur={() => setFactorApprovedDollars((v) => fmtMoneyComma(v))} disabled={!headerEditable} style={inputStyle} placeholder="0.00" /></Field>
          </div>
          {/* Chunk K (operator item 17) — ship-gate cue. Server is the source of truth (409 on ship). */}
          {customers.find((c) => c.id === customerId)?.is_factored === true && factorStatus !== "approved" && (
            <div style={{ fontSize: 11, color: C.warn, marginTop: 8, fontWeight: 600 }}>
              Factored customer — factor approval must be &quot;approved&quot; before this order can ship.
            </div>
          )}
        </div>

        {/* Non-factor credit ship-gate state — surfaced when the SO is on_hold
            (house-account overdue AR) or pending (credit-card not paid in full).
            Server is the source of truth (409 on allocate/ship). The release
            actions (Record payment / Override → Approve) live in the footer. */}
        {!isNew && showCredit(creditStatus) && (
          <div style={{
            border: `1px solid ${CREDIT_COLORS[creditStatus] || C.cardBdr}`, borderRadius: 8, padding: 12, marginBottom: 12,
            background: creditStatus === "approved" ? "#06281f" : creditStatus === "on_hold" ? "#3b2f0b" : "#0b1c3b",
          }}>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Credit status</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: CREDIT_COLORS[creditStatus] || C.text }}>
                {CREDIT_LABELS[creditStatus] || creditStatus}
              </span>
              {Number(so?.amount_paid_cents ?? 0) > 0 && (
                <span style={{ fontSize: 11, color: C.textSub }}>paid {fmtCents(so?.amount_paid_cents)} of {fmtCents(so?.total_cents)}</span>
              )}
            </div>
            {so?.credit_hold_reason && <div style={{ fontSize: 11, color: C.textSub, marginTop: 6 }}>{so.credit_hold_reason}</div>}
          </div>
        )}

        <Field label="Notes"><input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!headerEditable} style={inputStyle} placeholder="optional" /></Field>

        {/* Item 15 — ship to multiple stores: split this draft into per-store child SOs. */}
        {canSplit && (
          <div style={{ marginTop: 12, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
            <button onClick={() => setSplitOpen((v) => !v)} style={{ width: "100%", textAlign: "left", padding: "8px 12px", background: "#0b1220", color: C.text, border: 0, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
              <span style={{ color: C.textMuted, marginRight: 6 }}>{splitOpen ? "▼" : "▶"}</span>Ship to multiple stores (split into per-store orders)
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
                      {s.code ? `${s.code} — ${s.name}` : s.name}
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
        <div style={{ marginTop: 16, marginBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Fulfillment source *</span>
            <div style={{ width: 420 }}>
              <SearchableSelect
                value={fulfillmentSource || null}
                onChange={(v) => { setFulfillmentSource(v); setFulfillmentReview(false); }}
                disabled={!headerEditable}
                options={[
                  { value: "", label: "(select — required)" },
                  { value: "production", label: "Production — make it (notifies Production Mgr)" },
                  { value: "ats", label: "ATS — ship from available stock" },
                ]}
                placeholder="(select — required)"
                inputStyle={{
                  ...inputStyle, width: 420,
                  borderColor: fulfillmentReview ? C.primary : (editable && !fulfillmentSource ? C.warn : C.cardBdr),
                  boxShadow: fulfillmentReview ? `0 0 0 2px ${C.primary}55` : undefined,
                }}
              />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13, marginLeft: 8 }} title="Closeout order — commission uses the customer's closeout rate instead of the normal rep rate.">
              <input type="checkbox" checked={isCloseout} disabled={!headerEditable} onChange={(e) => setIsCloseout(e.target.checked)} />
              Closeout order
            </label>
            {/* Item 16 — Add-style / Add-non-matrix buttons stay VISIBLE; clicking
                without the prerequisites shows a specific warning (Customer PO and
                ship-to warehouse are required) instead of being hidden. */}
            {(editable || canAddStyles) && (
              <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
                <button type="button" onClick={() => tryAddLine("section")} style={{ ...btnSecondary, color: C.primary, borderColor: C.primary }}>Add style (matrix)</button>
                <button type="button" onClick={() => tryAddLine("flat")} style={btnSecondary}>+ Add non-matrix line</button>
              </div>
            )}
          </div>
          {/* Item 3 — fulfillment helper messages on their own line BELOW the
              selector (previously inline to the right of the dropdown). */}
          {(fulfillmentReview || fulfillmentSource === "production" || (editable && !fulfillmentSource)) && (
            <div style={{ marginTop: 6 }}>
              {fulfillmentReview && <span style={{ fontSize: 11, color: C.primary }}>✓ Auto-set to <strong>ATS</strong> from the uploaded PO — confirm it's correct or change it.</span>}
              {!fulfillmentReview && fulfillmentSource === "production" && <span style={{ fontSize: 11, color: C.warn }}>On-hand hidden; Production Manager is notified on confirm.</span>}
              {!fulfillmentReview && editable && !fulfillmentSource && <span style={{ fontSize: 11, color: C.warn }}>Pick ATS or Production to start adding styles.</span>}
            </div>
          )}
        </div>

        {/* MX-SO — the line body IS the size matrix: per-style color×size grids
            (95% of styles) + a "+ Add non-matrix line" button for one-offs. The
            Add buttons (above, on the Fulfillment-source line) stay hidden until
            the order prerequisites are filled: customer, ship-to address,
            Customer PO #, and Fulfillment source. */}
        {editable && (() => {
          const missing: string[] = [];
          if (!customerId) missing.push("Customer");
          if (!shipToLocationId) missing.push("Ship-to address");
          if (!customerPo.trim()) missing.push("Customer PO #");
          if (!saleStore.trim()) missing.push("Warehouse");
          if (!fulfillmentSource) missing.push("Fulfillment source");
          if (missing.length === 0) return null;
          return (
            <div style={{ marginBottom: 8, padding: "8px 12px", background: "#3b2f0b", border: `1px solid ${C.warn}`, borderRadius: 6, color: C.warn, fontSize: 12 }}>
              Fill <strong>{missing.join(", ")}</strong> above to start adding styles.
            </div>
          );
        })()}
        <div style={{ marginBottom: 12 }}>
          <LineMatrixBody
            key={seedKey}
            ref={bodyRef}
            editable={editable}
            canAdd={(editable || canAddStyles) && !!customerId && !!shipToLocationId && !!customerPo.trim() && !!fulfillmentSource}
            hideAddButtons
            onRequestEdit={() => { if (!editable) setAddMode(true); }}
            items={items}
            seed={seed}
            showOnHand={fulfillmentSource !== "production"}
            atsMode={fulfillmentSource === "ats"}
            atsAsOfDate={reqShip || null}
            onTotalsChange={setBodyTotals}
            onPrimaryBrandChange={(b) => { if (b) setBrandId(b); }}
            enableLinePo
            headerCustomerPo={customerPo}
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
            {canAllocate && <button onClick={() => void allocate()} style={{ ...btnSecondary, color: "#8B5CF6", borderColor: "#5b21b6" }} disabled={submitting} title="Reserve available on-hand stock to this order's lines, then open the Allocations workbench for this order">{submitting ? "…" : "Allocate stock"}</button>}
            {!isNew && so != null && <button onClick={openAllocations} style={{ ...btnSecondary, color: "#8B5CF6", borderColor: "#5b21b6" }} disabled={submitting} title="Open the Allocations workbench focused on this sales order">View allocation</button>}
            {canShip && <button onClick={() => void openShipModal()} style={{ ...btnSecondary, color: "#06B6D4", borderColor: "#0e7490" }} disabled={submitting} title="Record a carrier shipment (ships the allocated quantities)">Ship</button>}
            {/* Non-factor credit ship-gate operator actions. Record-payment for
                CREDIT_CARD orders; Override→Approve releases any credit hold. */}
            {!isNew && so != null && isCardOrder && creditStatus !== "approved" && (
              <button onClick={openPayModal} style={{ ...btnSecondary, color: C.primary, borderColor: "#1d4ed8" }} disabled={submitting} title="Record a payment against this credit-card order (paid in full releases the ship-gate)">Record payment</button>
            )}
            {creditOnHold && (
              <button onClick={() => void overrideApproveCredit()} style={{ ...btnSecondary, color: C.success, borderColor: "#065f46" }} disabled={submitting} title={so?.credit_hold_reason || "Override the credit hold and approve this order to ship"}>Override → Approve</button>
            )}
            {canInvoice && <button onClick={() => void createInvoice()} style={{ ...btnSecondary, color: C.success, borderColor: "#065f46" }} disabled={submitting}>{submitting ? "…" : "Create AR invoice"}</button>}
            {!isNew && so != null && soRemoveMode(so.status) && (
              <button
                onClick={async () => { if (await deleteOrCancelSO(so)) onSaved(); }}
                style={{ ...btnSecondary, color: C.danger, borderColor: "#7f1d1d" }}
                disabled={submitting}
                title={so.status === "draft" ? "Permanently delete this draft order" : "Cancel this order (moves to cancelled, kept for history)"}
              >{so.status === "draft" ? "Delete draft" : "Cancel order"}</button>
            )}
            {!isNew && so != null && so.status === "cancelled" && (
              <button
                onClick={() => void reinstateSO()}
                style={{ ...btnSecondary, color: C.success, borderColor: "#065f46" }}
                disabled={submitting}
                title="Reinstate this cancelled order — its status returns to confirmed"
              >Reinstate</button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {saveCloseButtons}
          </div>
        </div>
      </div>

      {/* Item 7 — email this order's confirmation. Recipients = the customer's
          buyers (which carry emails) merged with any legacy contacts, deduped by
          email; defaults to the buyer on THIS order so it "just sends to the
          buyer", and if the order has no buyer the operator picks one from the
          customer's master buyers/contacts in the modal. */}
      {emailOpen && so != null && (() => {
        const buyerContacts = buyers
          .filter((b) => b.email)
          .map((b) => ({ name: b.name, email: b.email || undefined, title: b.title || undefined }));
        const legacy = customers.find((c) => c.id === customerId)?.contacts || [];
        const seen = new Set<string>();
        const contacts = [...buyerContacts, ...legacy].filter((c) => {
          const e = (c.email || "").toLowerCase();
          if (!e || seen.has(e)) return false;
          seen.add(e);
          return true;
        });
        const defaultEmail = buyers.find((b) => b.id === buyerId)?.email || undefined;
        return (
          <EmailSOConfirmationModal
            soId={so.id}
            soNumber={so.so_number}
            customerName={customers.find((c) => c.id === customerId)?.name || "Customer"}
            contacts={contacts}
            defaultEmail={defaultEmail || undefined}
            onClose={() => setEmailOpen(false)}
            onSent={() => setEmailOpen(false)}
          />
        );
      })()}

      {/* Item 1 — after Create AR invoice, confirm the draft + offer View / Post / Close. */}
      {invoiceResult && (
        <div onClick={() => { if (!postingInvoice) { setInvoiceResult(null); onSaved(); } }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 210 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, width: "min(440px, 95vw)", padding: 22, color: C.text }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>Draft invoice {invoiceResult.number} created</h3>
            <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 18 }}>
              A draft AR invoice was created from this sales order. Post it to book the GL (revenue + COGS), open it to review, or close and post later from AR Invoices.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
              <button onClick={() => { setInvoiceResult(null); onSaved(); }} disabled={postingInvoice} style={btnSecondary}>Close</button>
              <button onClick={viewInvoice} disabled={postingInvoice} style={btnSecondary}>View invoice</button>
              <button onClick={() => void postInvoiceNow()} disabled={postingInvoice} style={{ ...btnPrimary, background: C.success, opacity: postingInvoice ? 0.6 : 1 }}>
                {postingInvoice ? "Posting…" : "Post now"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Per-line Customer PO split — the SOs auto-created (and confirmed) for the
          style lines whose PO differed from the header. Each is openable in a new
          tab (reuses the ?m=sales_orders&q=<SO#> deep-link). Closing refreshes. */}
      {splitResult && (
        <div onClick={() => { setSplitResult(null); onSaved(); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 210 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, width: "min(560px, 95vw)", maxHeight: "90vh", overflow: "auto", padding: 22, color: C.text }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>{splitResult.created.length} new sales order{splitResult.created.length === 1 ? "" : "s"} auto-created</h3>
            <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 14 }}>
              Style lines carrying a Customer PO other than the header PO{splitResult.parentPo ? <> (<strong>{splitResult.parentPo}</strong>)</> : null} were split onto their own confirmed sales order{splitResult.created.length === 1 ? "" : "s"} — same customer, ship-to and header details, with the note “Auto created due to new Customer PO”.
            </div>
            <div style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
              {splitResult.created.map((c, i) => (
                <div key={c.id || i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 12px", borderTop: i === 0 ? "none" : `1px solid ${C.cardBdr}`, flexWrap: "wrap" }}>
                  <div style={{ fontSize: 13 }}>
                    <div><strong>{c.so_number || "(draft)"}</strong> · PO <strong>{c.po}</strong></div>
                    <div style={{ fontSize: 12, color: C.textMuted }}>{c.styles} style{c.styles === 1 ? "" : "s"} · {c.qty.toLocaleString()} qty</div>
                  </div>
                  <button
                    onClick={() => window.open(`?m=sales_orders&q=${encodeURIComponent(c.so_number || c.po)}`, "_blank")}
                    style={{ ...btnSecondary, color: C.primary, borderColor: C.primary }}>Open</button>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
              <button
                onClick={() => splitResult.created.forEach((c) => window.open(`?m=sales_orders&q=${encodeURIComponent(c.so_number || c.po)}`, "_blank"))}
                style={btnSecondary}>Open all</button>
              <button onClick={() => { setSplitResult(null); onSaved(); }} style={btnPrimary}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* Item 8 — on-the-fly Add-customer popup, opened from the picker's typeahead
          "+ Add …" row and pre-filled with the typed name. The new customer is
          merged in + selected; a "complete the customer info" nudge is sent since
          this short form omits terms / GL routing / addresses. */}
      {quickAddCustomer && (
        <QuickAddPartyModal
          kind="customer"
          initialName={quickAddInitialName}
          onClose={() => { setQuickAddCustomer(false); setQuickAddInitialName(""); }}
          onCreated={(row) => {
            const c = row as unknown as Customer;
            setExtraCustomers((prev) => [c, ...prev]);
            setCustomerId(c.id);
            setShipToLocationId("");
            setBuyerId("");
            // Item 9 — autofill terms from the (newly created) customer if it carries any.
            if (c.payment_terms_id) setPaymentTermsId((cur) => cur || c.payment_terms_id || "");
            setQuickAddCustomer(false);
            setQuickAddInitialName("");
            notify(`Customer "${c.name}" added — finish its full record from the reminder in your notifications.`, "success");
            void notifyCompleteParty("customer", { id: c.id, name: c.name, customer_code: c.customer_code });
          }}
        />
      )}

      {/* 🤖 AI customer-PO upload dialog. */}
      {poUploadOpen && (
        <div onClick={(e) => { e.stopPropagation(); if (!poParsing) setPoUploadOpen(false); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>Upload customer PO</h3>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>
              Upload the customer's PO (PDF, Excel/CSV) or paste the email below. AI reads it and prefills the customer, terms, dates, PO #, and the size matrix — then you double-check before saving.
            </div>

            {poStep === "upload" && (
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
            )}

            {poStep === "dup" && poDup && (
              // Duplicate guard — a non-cancelled SO already carries this PO #.
              <>
                <div style={{ background: "#7f1d1d", color: "white", padding: "12px 14px", borderRadius: 8, fontSize: 13 }}>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>This customer PO already exists</div>
                  <div style={{ fontSize: 12 }}>PO <strong>{poDup.po}</strong> is already on {poDup.existing.length === 1 ? "an existing sales order" : `${poDup.existing.length} existing sales orders`}:</div>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12 }}>
                    {poDup.existing.map((e) => (
                      <li key={e.id}>{e.so_number || "(draft, no SO #)"} — {e.status}{customers.find((c) => c.id === e.customer_id) ? ` · ${customers.find((c) => c.id === e.customer_id)!.name}` : ""}</li>
                    ))}
                  </ul>
                  <div style={{ fontSize: 12, marginTop: 8 }}>Creating another would duplicate it. Cancel, or open the existing order instead.</div>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
                  {poDup.existing[0] && (
                    <button type="button" style={{ ...btnSecondary, color: C.primary, borderColor: C.primary }}
                      onClick={() => window.open(`?m=sales_orders&q=${encodeURIComponent(poDup.existing[0].so_number || poDup.po)}`, "_blank")}>
                      Open existing SO ↗
                    </button>
                  )}
                  <button type="button" style={btnPrimary} onClick={() => { setPoUploadOpen(false); setPoDup(null); setPoStep("upload"); }}>Cancel — don't create a duplicate</button>
                </div>
              </>
            )}

            {poStep === "ambig" && (
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
                  <button onClick={() => { setPoAmbig([]); setPoStep("upload"); }} style={btnSecondary} disabled={poParsing}>Back</button>
                  <button disabled={poParsing} style={btnPrimary} onClick={() => {
                    if (!poParsed) return;
                    const picks = Object.fromEntries(poAmbig.map((a) => [(a.res.line.style_code || "").toLowerCase(), a.pick]));
                    void prepareConfirm(poParsed, allStyles, picks);
                  }}>Continue</button>
                </div>
              </>
            )}

            {poStep === "confirm" && (
              // Confirm the fuzzy choices — customer (no exact match) + colour rows
              // that didn't map cleanly. Operator picks; then we build the prefill.
              <>
                <div style={{ fontSize: 13, color: C.textSub, marginBottom: 10 }}>A couple of things need confirming before we fill the order:</div>
                {poCustQ && (
                  <div style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: 10, marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6 }}>The PO names customer <strong style={{ color: C.text }}>"{poCustQ.parsedName}"</strong> — pick the matching customer:</div>
                    <SearchableSelect value={poCustQ.pick || null} onChange={(v) => setPoCustQ((q) => q ? { ...q, pick: v || "" } : q)}
                      options={[{ value: "", label: "— pick manually later —" }, ...customers.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.name} ${c.customer_code || ""}` }))]}
                      placeholder="Search customer…" inputStyle={inputStyle} />
                    {poCustQ.reasoning && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>{poCustQ.reasoning}</div>}
                  </div>
                )}
                {poColorQs.map((q, i) => (
                  <div key={i} style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: 10, marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6 }}><strong style={{ color: C.text }}>{q.styleCode}</strong> — PO colour <strong style={{ color: C.text }}>"{q.lineColor}"</strong>. Which colour row?</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {q.options.map((opt) => {
                        const active = q.pick === opt;
                        return (
                          <button key={opt} type="button" onClick={() => setPoColorQs((p) => p.map((x, j) => j === i ? { ...x, pick: opt } : x))}
                            style={{ ...btnSecondary, color: active ? C.primary : C.textSub, borderColor: active ? C.primary : C.cardBdr, fontWeight: active ? 700 : 400, fontSize: 12, padding: "4px 10px" }}>
                            {opt}{opt === q.suggested ? " ★" : ""}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {poErr && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, margin: "10px 0 0", fontSize: 12 }}>{poErr}</div>}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                  <button onClick={() => { setPoStep(poAmbig.length ? "ambig" : "upload"); }} style={btnSecondary} disabled={poParsing}>Back</button>
                  <button disabled={poParsing} style={btnPrimary} onClick={() => {
                    if (!poParsed) return;
                    const colorPicks = Object.fromEntries(poColorQs.map((q) => [colorPickKey(q.styleCode, q.lineColor), q.pick]));
                    void applyParsed(poParsed, poResolvedRef.current, poUnmatchedRef.current, colorPicks, poCustQ ? poCustQ.pick : undefined);
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
            <h3 style={{ margin: "0 0 14px", fontSize: 16 }}>Ship sales order</h3>
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

      {/* Scenario 4.2 — this distro matches one or more open bulk orders. */}
      {bulkMatches && bulkMatches.length > 0 && !bulkDetail && (
        <div onClick={() => closeBulkMatch()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 140 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: "1px solid #3B82F6", borderRadius: 10, padding: 22, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Distro matches a bulk order</div>
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.5, marginBottom: 14 }}>
              This customer PO overlaps {bulkMatches.length} open bulk order{bulkMatches.length === 1 ? "" : "s"} for the same customer (by style/color). Cancel a bulk PO once its distros cover it.
            </div>
            {bulkMatches.map((m) => (
              <div key={m.id} style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12, marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ fontSize: 13 }}>
                    <b>{m.so_number || "(draft)"}</b>{m.customer_po ? <span style={{ color: C.textMuted }}> · PO {m.customer_po}</span> : null}
                    <span style={{ color: C.textMuted }}> · {m.status}</span>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#3B82F6" }}>{m.match_pct}% match</div>
                </div>
                <div style={{ fontSize: 11, color: C.textMuted, margin: "4px 0 8px" }}>
                  {m.matched_units.toLocaleString()} units matched · {m.bulk_coverage_pct}% of the bulk covered by this distro
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={() => setBulkDetail(m)} style={{ ...btnSecondary, fontSize: 12, padding: "4px 10px" }}>View details</button>
                  <button onClick={() => void cancelBulk(m.id)} disabled={bulkBusy} style={{ ...btnSecondary, fontSize: 12, padding: "4px 10px", color: C.danger, borderColor: "#7f1d1d" }}>{bulkBusy ? "…" : "Cancel bulk PO"}</button>
                </div>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button onClick={() => closeBulkMatch()} style={btnSecondary} disabled={bulkBusy}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* Scenario 4.2 — bulk↔distro breakdown (view / download / print). */}
      {bulkDetail && (
        <div onClick={() => setBulkDetail(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 141 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(640px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>Bulk {bulkDetail.so_number || ""} {bulkDetail.customer_po ? `· PO ${bulkDetail.customer_po}` : ""}</h3>
              <span style={{ fontSize: 12, color: C.textMuted }}>{bulkDetail.match_pct}% of distro · {bulkDetail.bulk_coverage_pct}% of bulk</span>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 14 }}>
              <thead><tr style={{ color: C.textMuted, textAlign: "left" }}>
                <th style={{ padding: "4px 8px" }}>Style</th><th style={{ padding: "4px 8px" }}>Color</th>
                <th style={{ padding: "4px 8px", textAlign: "right" }}>Bulk</th><th style={{ padding: "4px 8px", textAlign: "right" }}>Distro</th><th style={{ padding: "4px 8px", textAlign: "right" }}>Matched</th>
              </tr></thead>
              <tbody>
                {bulkDetail.breakdown.map((r, i) => (
                  <tr key={`${r.style_code}-${r.color}-${i}`} style={{ borderTop: `1px solid ${C.cardBdr}` }}>
                    <td style={{ padding: "4px 8px" }}>{r.style_code}</td>
                    <td style={{ padding: "4px 8px" }}>{r.color || "—"}</td>
                    <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace" }}>{r.bulk_qty}</td>
                    <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace" }}>{r.distro_qty}</td>
                    <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: "monospace", color: r.matched > 0 ? "#10B981" : C.textMuted }}>{r.matched}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <button onClick={() => setBulkDetail(null)} style={btnSecondary}>← Back</button>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => downloadBulkCsv(bulkDetail)} style={btnSecondary}>Excel (CSV)</button>
                <button onClick={() => printBulkDetail(bulkDetail)} style={btnSecondary}>Print</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Scenario 5 — ATS lot allocation can't fully fill the order. Show what
          can be filled (per lot) and let the operator accept (backorder the
          rest) or cancel. */}
      {lotPlan && (
        <div onClick={() => { setLotPlan(null); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 130 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: "1px solid #F59E0B", borderRadius: 10, padding: 22, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#F59E0B", marginBottom: 8 }}>Order can't be fully filled from stock</div>
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.5, marginBottom: 14 }}>
              {lotPlan.shortfalls.length} line{lotPlan.shortfalls.length === 1 ? "" : "s"} can't be fully shipped from available lots. Accepting saves the order, allocates what's available by lot, and leaves the rest as a backorder (no lot).
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 16 }}>
              <thead>
                <tr style={{ color: C.textMuted, textAlign: "left" }}>
                  <th style={{ padding: "4px 6px" }}>Item</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>Ordered</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>Can fill</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>Short</th>
                  <th style={{ padding: "4px 6px" }}>From lots</th>
                </tr>
              </thead>
              <tbody>
                {lotPlan.shortfalls.map((l) => (
                  <tr key={l.item_id} style={{ borderTop: `1px solid ${C.cardBdr}` }}>
                    <td style={{ padding: "4px 6px" }}>{l.sku_code || `${l.style_code || ""} ${l.color || ""} ${l.size || ""}`.trim() || l.item_id.slice(0, 8)}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right", fontFamily: "monospace" }}>{l.qty_ordered}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right", fontFamily: "monospace", color: "#10B981" }}>{l.filled}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right", fontFamily: "monospace", color: "#F59E0B" }}>{l.shortfall}</td>
                    <td style={{ padding: "4px 6px", color: C.textMuted }}>{l.picks.length ? l.picks.map((p) => `${p.lot_number || "(unlotted)"}: ${p.qty}`).join(", ") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setLotPlan(null)} style={btnSecondary} disabled={submitting}>Cancel</button>
              <button onClick={() => { const p = lotPlan; setLotPlan(null); setSubmitting(true); void commitSave(p.expanded, p.confirm); }} style={btnPrimary} disabled={submitting}>
                {submitting ? "Saving…" : "Accept & save (backorder the rest)"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Record-payment modal — manual payment record for the credit-card gate.
          Processor (Stripe/hosted checkout) is deferred; this posts to the
          record-payment endpoint which increments amount_paid_cents and, on a
          paid-in-full CREDIT_CARD order, auto-approves the credit ship-gate. */}
      {payOpen && (
        <div onClick={(e) => { e.stopPropagation(); if (!submitting) setPayOpen(false); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 110 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(420px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>Record payment</h3>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 12 }}>
              Order total {fmtCents(so?.total_cents)} · already paid {fmtCents(so?.amount_paid_cents)}. Paying in full releases the credit-card ship-gate.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <Field label="Amount $"><input type="text" inputMode="decimal" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} onBlur={() => setPayAmount((v) => fmtMoneyComma(v))} style={inputStyle} placeholder="0.00" /></Field>
              <Field label="Method">
                <SearchableSelect value={payMethod || null} onChange={(v) => setPayMethod(v)}
                  options={["credit_card", "ach", "wire", "check", "cash", "paypal", "stripe", "other"].map((m) => ({ value: m, label: m }))}
                  placeholder="Method" inputStyle={inputStyle} />
              </Field>
            </div>
            <Field label="Reference #"><input type="text" value={payReference} onChange={(e) => setPayReference(e.target.value)} style={inputStyle} placeholder="auth code / txn id (optional)" /></Field>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button onClick={() => setPayOpen(false)} style={btnSecondary} disabled={submitting}>Cancel</button>
              <button onClick={() => void recordPayment()} style={btnPrimary} disabled={submitting}>{submitting ? "…" : "Record payment"}</button>
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
      {label ? <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div> : null}
      {children}
    </div>
  );
}
