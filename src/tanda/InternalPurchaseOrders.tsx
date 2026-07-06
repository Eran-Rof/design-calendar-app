// src/tanda/InternalPurchaseOrders.tsx
//
// P16 / M11 — native Purchase Order entry (origination). List + create/edit
// modal. Mirrors the Sales Order modal (M10): vendor/brand/payment-terms
// pickers, item SearchableSelect lines, plus a matrix line-entry mode (style →
// /api/internal/style-matrix → editable MatrixGrid → resolve-sku per cell).
// PO number is system-assigned on Issue.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { fmtDateDisplay } from "../utils/tandaTypes";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import SearchableSelect from "./components/SearchableSelect";
import QuickAddPartyModal from "./components/QuickAddPartyModal";
import { notifyCompleteParty } from "./lib/notifyCompleteParty";
import LineMatrixBody, { type LineMatrixBodyHandle, type SeedSection, type FlatLine } from "./LineMatrixBody";
import { openOrderDocument, downloadOrderExcel, type OrderDocument } from "./orderDocument";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { notify, confirmDialog, promptDialog } from "../shared/ui/warn";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";
import { readDrillParam, consumeDrillParams } from "./scorecardDrill";
import RowHistory from "./components/RowHistory";
import DateRangePresets from "./components/DateRangePresets";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";
import { extractPpk } from "../shared/prepack";
import { MultiSelectDropdown } from "../inventory-planning/components/MultiSelectDropdown";

// EXPLODE PPK preference — shared with the PO/Item Matrix tab. Lifted to module
// scope so the grid-level toggle and the row expanders read/write one value.
const EXPLODE_PPK_KEY = "tanda_matrix_explode_ppk";
function readExplodePpk(): boolean { try { return localStorage.getItem(EXPLODE_PPK_KEY) !== "false"; } catch { return true; } }

// Universal column-visibility registry for this panel (operator ask #1).
const PO_TABLE_KEY = "tangerine:purchaseorders:columns";
// Server-side page size for the list (the endpoint caps at 500). Search / filters
// reach older orders beyond this window (server-side).
const PO_LIST_LIMIT = 500;
// Mirrors the Sales Orders grid's cost/sell/margin strip: Avg cost is the item's
// STANDARD (catalog) cost, Avg PO Price is what THIS PO actually pays the vendor,
// so the two read side-by-side as PO variance. Plus the SO-style Cancel date.
const PO_COLUMNS: ColumnDef[] = [
  { key: "po_number",     label: "PO #" },
  { key: "vendor",        label: "Vendor" },
  { key: "order_date",    label: "Order date" },
  { key: "expected_date", label: "Expected" },
  { key: "cancel_date",   label: "Cancel date" },
  { key: "status",        label: "Status" },
  { key: "avg_po_price",  label: "Avg PO Price" },
  { key: "avg_cost",      label: "Avg cost" },
  { key: "sell_price",    label: "Sell price" },
  { key: "margin_pct",    label: "Margin %" },
  { key: "margin_amt",    label: "Margin $" },
  { key: "total",         label: "Total" },
  { key: "remaining_ship", label: "Remaining to ship" },
];
// colSpan for full-width rows = every column + the leading expander cell.
const PO_COL_TOTAL = PO_COLUMNS.length + 1;
// Per-column sort persistence (mirrors useTablePrefs key scheme).
const PO_SORT_KEY = "tangerine:purchaseorders:sort";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5 };
// Frozen header cell — th + sticky to the scroll container's top. Opaque bg so
// rows scroll underneath cleanly (mirrors InventoryMatrix SnapshotView thStick).
const thStick: React.CSSProperties = { ...th, position: "sticky", top: 0, zIndex: 2 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const dateInput: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, borderRadius: 4, padding: "5px 8px", fontSize: 13, colorScheme: "dark" };
const dl: React.CSSProperties = { fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 };
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box" };
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
// Dropdown item for the View → PDF / Excel menu (app dark palette).
const viewMenuItem: React.CSSProperties = { display: "block", width: "100%", textAlign: "left", background: "transparent", color: "#F1F5F9", border: 0, borderBottom: "1px solid #334155", padding: "9px 14px", fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" };

type PO = {
  id: string; po_number: string | null; vendor_id: string; brand_id: string | null;
  order_date: string; expected_date: string | null; cancel_date?: string | null; status: string; currency: string;
  payment_terms_id: string | null; notes: string | null; subtotal_cents: number | string; total_cents: number | string;
  // List-endpoint enrichment (see enrichPricing() in the list handler):
  //   avg_cost_cents     — qty-weighted STANDARD/catalog cost (ip_item_avg_cost).
  //   avg_po_price_cents — qty-weighted unit cost on THIS PO's own lines.
  //   sell_cents         — qty-weighted resolved sell price.
  //   margin_cents/_pct  — Sell − Avg PO Price (server-computed; recomputed
  //                        client-side too for the sort/totals accessors).
  avg_cost_cents?: number | null; avg_po_price_cents?: number | null; sell_cents?: number | null;
  margin_cents?: number | null; margin_pct?: number | null;
  //   remaining_to_ship_cents — Σ max(0, qty_ordered − qty_received) × PO unit
  //                             cost. The open commitment (ties to Xoro's
  //                             "$ Remaining to Ship"), vs Total = ordered value.
  remaining_to_ship_cents?: number | null;
  // In-transit OVERLAY (po_shipments) — a separate dimension from `status`; a PO
  // can be "issued · in transit" or "partially received · in transit".
  in_transit?: boolean; transit_eta?: string | null; transit_shipments?: number;
};
type Vendor = { id: string; name: string; code?: string };
type Item = { id: string; sku_code: string; style_code?: string; description?: string };
type Lookup = { id: string; code?: string; name: string };

function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0); const neg = n < 0; const abs = Math.abs(n);
  return `${neg ? "-" : ""}$${Math.trunc(abs / 100).toLocaleString()}.${String(Math.round(abs % 100)).padStart(2, "0")}`;
}
// Margin % to one decimal, "—" when null (mirrors the Sales Orders grid).
function fmtPct(p: number | null | undefined): string {
  if (p == null) return "—";
  return `${p.toFixed(1)}%`;
}
// Per-PO margin $ = resolved sell − the price THIS PO actually pays the vendor
// (avg_po_price_cents), both qty-weighted. Priced against the PO's own cost (not
// standard cost) so the margin reflects the real buy, mirroring the Sales Orders
// grid's Sell − Cost convention. Null when either side is missing.
function poMarginCents(po: Pick<PO, "avg_po_price_cents" | "sell_cents">): number | null {
  const sell = po.sell_cents;
  const price = po.avg_po_price_cents;
  if (sell == null || price == null) return null;
  return sell - price;
}
// Per-PO margin % = margin $ / sell. Null when sell is missing or ≤ 0.
function poMarginPct(po: Pick<PO, "avg_po_price_cents" | "sell_cents">): number | null {
  const sell = po.sell_cents;
  const m = poMarginCents(po);
  if (m == null || sell == null || sell <= 0) return null;
  return (m / sell) * 100;
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
const STATUSES = ["draft", "issued", "partially_received", "in_transit", "received", "cancelled"];
const STATUS_COLORS: Record<string, string> = {
  draft: C.textMuted, issued: C.primary, partially_received: "#14B8A6", in_transit: C.warn, received: C.success, cancelled: C.danger,
};
// Human-readable status label — drops the underscore ("in_transit" → "in transit")
// for every place the raw status is shown (filter options, grid chip, modal).
const statusLabel = (s: string) => s.replace(/_/g, " ");
// In-transit OVERLAY chip — rendered next to the lifecycle status when the PO
// has ≥1 active shipment (po_shipments). A PO reads e.g. "issued · ✈ in transit".
function InTransitChip({ po }: { po: Pick<PO, "in_transit" | "transit_eta"> }) {
  if (!po.in_transit) return null;
  const eta = po.transit_eta ? fmtDateDisplay(po.transit_eta) : null;
  return (
    <span title={eta ? `In transit · ETA ${eta}` : "In transit (shipment on the way)"} style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, color: C.warn, border: `1px solid ${C.warn}`, borderRadius: 4, padding: "0 5px", whiteSpace: "nowrap", verticalAlign: "middle" }}>✈ in transit{eta ? ` · ${eta}` : ""}</span>
  );
}
// Default status filter — the live/actionable set the buyer works from.
const DEFAULT_PO_STATUSES = ["draft", "issued", "partially_received"];

export default function InternalPurchaseOrders() {
  const [rows, setRows] = useState<PO[]>([]);
  // Guards against a fetch race: rapidly toggling the status multi-select fires
  // several load()s; without sequencing a slower earlier response can land last
  // and clobber the newest filter (e.g. "in transit only" briefly showing, then
  // reverting to all statuses). Only the latest request's result is applied.
  const loadSeqRef = useRef(0);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Multi-select status filter (model after the SO grid). Defaults to the live
  // set (draft / issued / in-transit); empty = all statuses.
  const [statusFilters, setStatusFilters] = useState<string[]>(DEFAULT_PO_STATUSES);
  // In-transit overlay filter (client-side) — show only POs with an active
  // shipment. It's an overlay, not a lifecycle status, so it filters separately.
  const [inTransitOnly, setInTransitOnly] = useState(false);
  // Grid-level EXPLODE PPK toggle — one control drives every row expander
  // (moved out of the individual detail rows). Persisted, shared with the tab.
  const [explodePpk, setExplodePpk] = useState<boolean>(readExplodePpk);
  useEffect(() => { try { localStorage.setItem(EXPLODE_PPK_KEY, explodePpk ? "true" : "false"); } catch { /* ignore */ } }, [explodePpk]);
  // Scorecard drill-through: ?vendor=<id> seeds the vendor filter on mount so a
  // click from the Vendor Scorecard lands here pre-filtered to that vendor.
  const [vendorFilter, setVendorFilter] = useState(() => readDrillParam("vendor"));
  // Optional style scope (deep-link ?style=<style_code>): when set, the Avg cost
  // + Sell price columns count only that style's lines (whole-PO otherwise).
  const [styleScope] = useState(() => readDrillParam("style"));
  // Scorecard per-line drill: ?q=<po_number> seeds the search on mount so a
  // new-tab deep-link lands here filtered to that single PO. Server-side q is
  // all-field (search_purchase_orders RPC): matches PO #, notes, vendor
  // name/code, and any line's style / SKU / line description.
  const { value: search, debouncedValue: searchDebounced, setValue: setSearch } = useDebouncedSearch(readDrillParam("q"), 200);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PO | null>(null);
  // Date-range filter (client-side): pick WHICH date to filter on, then a
  // [from,to] window (preset dropdown + manual pickers). Empty = no bound.
  const [dateField, setDateField] = useState<"order_date" | "expected_date">("order_date");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Wave 5 — universal column show/hide.
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(PO_TABLE_KEY, PO_COLUMNS);
  const isVisible = (k: string): boolean => visibleColumns.has(k);
  // Totals strip scope: sum only the currently-filtered rows, or the whole
  // loaded dataset (ignores the client-side date window). Server search/status/
  // vendor filters always bound `rows`, so "All" = everything currently loaded.
  const [totalsScope, setTotalsScope] = useState<"filtered" | "all">("filtered");
  // Remaining-to-Ship rollup — a planning breakdown of the open commitment by
  // expected-delivery month (receiving / cash-outflow pipeline) or by vendor.
  const [rollupOpen, setRollupOpen] = useState(false);
  const [rollupBy, setRollupBy] = useState<"month" | "vendor">("month");

  const vendorName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const v of vendors) m[v.id] = v.name;
    return m;
  }, [vendors]);

  // Apply the date-range window client-side on the selected date field. A row
  // with no value on that field is dropped while a bound is set (can't place it).
  const filteredRows = useMemo(() => {
    if (!dateFrom && !dateTo && !inTransitOnly) return rows;
    return rows.filter((po) => {
      if (inTransitOnly && !po.in_transit) return false; // in-transit overlay is a client-side filter (not a status)
      if (dateFrom || dateTo) {
        const v = (po[dateField] || "") as string;
        if (!v) return false;
        const d = v.slice(0, 10);
        if (dateFrom && d < dateFrom) return false;
        if (dateTo && d > dateTo) return false;
      }
      return true;
    });
  }, [rows, dateField, dateFrom, dateTo, inTransitOnly]);

  // Universal per-column sort (tri-state asc → desc → off, persisted). Computed
  // columns (vendor name, margin) read through accessors; the rest map 1:1.
  const { sorted: sortedRows, sortKey, sortDir, onHeaderClick } = useSort(filteredRows, {
    persistKey: PO_SORT_KEY,
    accessors: {
      vendor: (po: PO) => vendorName[po.vendor_id] || "",
      avg_cost: (po: PO) => po.avg_cost_cents,
      avg_po_price: (po: PO) => po.avg_po_price_cents,
      sell_price: (po: PO) => po.sell_cents,
      margin_pct: (po: PO) => poMarginPct(po),
      margin_amt: (po: PO) => poMarginCents(po),
      total: (po: PO) => Number(po.total_cents ?? 0),
      remaining_ship: (po: PO) => Number(po.remaining_to_ship_cents ?? 0),
    },
  });

  // Row expander (▸ carrot): which PO's line detail is open. One at a time.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Totals strip — sum across either the filtered subset or the full loaded
  // dataset. Qty-weighted avg cost/sell so the weighted Margin % is meaningful
  // (mirrors the server's enrichPricing weighting). Total = Σ total_cents.
  const totals = useMemo(() => {
    const src = totalsScope === "all" ? rows : filteredRows;
    let totalCents = 0;
    let remainingCents = 0;
    let costNum = 0, costDen = 0, priceNum = 0, priceDen = 0, sellNum = 0, sellDen = 0;
    for (const po of src) {
      totalCents += Number(po.total_cents ?? 0);
      remainingCents += Number(po.remaining_to_ship_cents ?? 0);
      // Weight the avg-cost / PO-price / sell by the PO total $ as a proxy for
      // line volume (the per-unit averages are all we have at the grid grain).
      const w = Math.abs(Number(po.total_cents ?? 0)) || 1;
      if (po.avg_cost_cents != null) { costNum += po.avg_cost_cents * w; costDen += w; }
      if (po.avg_po_price_cents != null) { priceNum += po.avg_po_price_cents * w; priceDen += w; }
      if (po.sell_cents != null) { sellNum += po.sell_cents * w; sellDen += w; }
    }
    const avgCost = costDen > 0 ? Math.round(costNum / costDen) : null;
    const avgPoPrice = priceDen > 0 ? Math.round(priceNum / priceDen) : null;
    const sell = sellDen > 0 ? Math.round(sellNum / sellDen) : null;
    // Margin follows the row convention: Sell − Avg PO Price.
    const marginCents = sell != null && avgPoPrice != null ? sell - avgPoPrice : null;
    const marginPct = sell != null && marginCents != null && sell > 0 ? (marginCents / sell) * 100 : null;
    return { count: src.length, totalCents, remainingCents, avgCost, avgPoPrice, sell, marginCents, marginPct };
  }, [totalsScope, rows, filteredRows]);

  // Remaining-to-Ship rollup — group the currently-filtered POs by expected
  // month (YYYY-MM, chronological) or vendor (by size), summing the open
  // commitment so the buyer sees the receiving / cash-outflow pipeline.
  const rollup = useMemo(() => {
    const groups = new Map<string, { key: string; label: string; count: number; remaining: number }>();
    for (const po of filteredRows) {
      let key: string, label: string;
      if (rollupBy === "vendor") { key = vendorName[po.vendor_id] || "(no vendor)"; label = key; }
      else {
        const ym = (po.expected_date || "").slice(0, 7);
        key = ym || "9999-99"; // undated sinks to the bottom of the chronological sort
        label = ym ? new Date(`${ym}-01T00:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" }) : "No date";
      }
      const g = groups.get(key) || { key, label, count: 0, remaining: 0 };
      g.count += 1; g.remaining += Number(po.remaining_to_ship_cents ?? 0);
      groups.set(key, g);
    }
    const arr = [...groups.values()];
    arr.sort(rollupBy === "vendor" ? (a, b) => b.remaining - a.remaining : (a, b) => a.key.localeCompare(b.key));
    const max = arr.reduce((m, g) => Math.max(m, g.remaining), 0);
    const total = arr.reduce((s, g) => s + g.remaining, 0);
    return { rows: arr, max, total };
  }, [filteredRows, rollupBy, vendorName]);

  async function load() {
    const seq = ++loadSeqRef.current;
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (statusFilters.length) params.set("status", statusFilters.join(","));
      if (vendorFilter) params.set("vendor_id", vendorFilter);
      if (searchDebounced.trim()) params.set("q", searchDebounced.trim());
      if (styleScope) params.set("style", styleScope);
      params.set("limit", String(PO_LIST_LIMIT));
      const r = await fetch(`/api/internal/purchase-orders?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json() as PO[];
      if (seq !== loadSeqRef.current) return; // superseded by a newer load — drop this stale result
      setRows(data);
    } catch (e) { if (seq === loadSeqRef.current) setErr(e instanceof Error ? e.message : String(e)); }
    finally { if (seq === loadSeqRef.current) setLoading(false); }
  }
  const anyFilter = !!(statusFilters.length || vendorFilter || search.trim() || dateFrom || dateTo || inTransitOnly);
  function clearFilters() { setStatusFilters([]); setVendorFilter(""); setSearch(""); setDateFrom(""); setDateTo(""); setInTransitOnly(false); }
  // Consume one-shot drill params (?q=/?vendor=/?style=) AFTER the useState
  // initializers above seeded from them, so leaving and returning to this panel
  // starts unfiltered instead of silently re-applying a stale search that can
  // hide the whole PO list. Runs once on mount.
  useEffect(() => { consumeDrillParams(["q", "vendor", "style"]); }, []);
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [statusFilters.join(","), vendorFilter, searchDebounced]);
  useEffect(() => {
    fetch("/api/internal/vendor-master?limit=1000").then((r) => r.json())
      .then((a) => { if (Array.isArray(a)) setVendors(a as Vendor[]); }).catch(() => {});
  }, []);

  const exportRows = useMemo(() => {
    const body = sortedRows.map((po) => ({
      po_number: po.po_number || "(draft)",
      vendor: vendorName[po.vendor_id] || "",
      order_date: po.order_date,
      expected_date: po.expected_date || "",
      cancel_date: po.cancel_date || "",
      status: po.status,
      avg_cost: po.avg_cost_cents != null ? po.avg_cost_cents / 100 : "",
      avg_po_price: po.avg_po_price_cents != null ? po.avg_po_price_cents / 100 : "",
      sell_price: po.sell_cents != null ? po.sell_cents / 100 : "",
      margin_pct: poMarginPct(po),
      margin_amt: (() => { const m = poMarginCents(po); return m != null ? m / 100 : ""; })(),
      total: Number(po.total_cents ?? 0) / 100,
      remaining_ship: Number(po.remaining_to_ship_cents ?? 0) / 100,
    }));
    // #23 — append the on-screen Totals row to the export so the spreadsheet
    // carries the same footer the grid shows (honours the Filtered/All scope).
    body.push({
      po_number: totalsScope === "all" ? "TOTAL (all loaded)" : "TOTAL (filtered)",
      vendor: "",
      order_date: "",
      expected_date: "",
      cancel_date: "",
      status: `${totals.count} PO${totals.count === 1 ? "" : "s"}`,
      avg_cost: totals.avgCost != null ? totals.avgCost / 100 : "",
      avg_po_price: totals.avgPoPrice != null ? totals.avgPoPrice / 100 : "",
      sell_price: totals.sell != null ? totals.sell / 100 : "",
      margin_pct: totals.marginPct,
      margin_amt: totals.marginCents != null ? totals.marginCents / 100 : "",
      total: totals.totalCents / 100,
      remaining_ship: totals.remainingCents / 100,
    });
    return body;
  }, [sortedRows, vendorName, totals, totalsScope]);
  const exportColumns: ExportColumn<Record<string, unknown>>[] = [
    { key: "po_number", header: "PO #" },
    { key: "vendor", header: "Vendor" },
    { key: "order_date", header: "Order Date" },
    { key: "expected_date", header: "Expected" },
    { key: "cancel_date", header: "Cancel Date" },
    { key: "status", header: "Status" },
    { key: "avg_po_price", header: "Avg PO Price", format: "number" },
    { key: "avg_cost", header: "Avg Cost", format: "number" },
    { key: "sell_price", header: "Sell Price", format: "number" },
    { key: "margin_pct", header: "Margin %", format: "percent", digits: 1 },
    { key: "margin_amt", header: "Margin $", format: "number" },
    { key: "total", header: "Total", format: "number" },
    { key: "remaining_ship", header: "Remaining to Ship", format: "number" },
  ];

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Purchase Orders</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <ExportButton rows={exportRows} filename="purchase-orders" sheetName="Purchase Orders" columns={exportColumns} />
          <button style={btnPrimary} onClick={() => { setEditing(null); setModalOpen(true); }}>+ New purchase order</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        {/* Multi-select status filter (pick any combination) — mirrors the SO grid. */}
        <MultiSelectDropdown
          selected={statusFilters}
          onChange={setStatusFilters}
          options={STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))}
          allLabel="All statuses"
          placeholder="Search status…"
          title="Filter by one or more statuses"
          minWidth={180}
        />
        {/* In-transit overlay filter — separate from status (a PO can be issued
            OR partially received AND in transit). */}
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: inTransitOnly ? C.warn : C.textSub, cursor: "pointer", whiteSpace: "nowrap" }} title="Show only POs with an active shipment in transit">
          <input type="checkbox" checked={inTransitOnly} onChange={(e) => setInTransitOnly(e.target.checked)} style={{ accentColor: C.warn, cursor: "pointer", width: 13, height: 13 }} />
          ✈ In transit only
        </label>
        <div style={{ width: 240 }}>
          <SearchableSelect value={vendorFilter || null} onChange={(v) => setVendorFilter(v)}
            options={[{ value: "", label: "All vendors" }, ...vendors.map((v) => ({ value: v.id, label: v.name, searchHaystack: `${v.name} ${v.code || ""}` }))]}
            placeholder="All vendors" inputStyle={inputStyle} />
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search PO #, vendor, style…" style={{ ...inputStyle, width: 240 }} />
        {/* Date-range filter: which date + [from,to] window (presets + manual). */}
        <div style={{ width: 150 }} title="Which date the range filters on">
          <SearchableSelect value={dateField} onChange={(v) => setDateField(v as "order_date" | "expected_date")}
            options={[
              { value: "order_date", label: "PO date" },
              { value: "expected_date", label: "Expected date" },
            ]} inputStyle={inputStyle} />
        </div>
        <DateRangePresets variant="dropdown" from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t); }} />
        <label style={dl}>From <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ ...dateInput, marginLeft: 4 }} /></label>
        <label style={dl}>To <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ ...dateInput, marginLeft: 4 }} /></label>
        {(dateFrom || dateTo) && <button onClick={() => { setDateFrom(""); setDateTo(""); }} style={{ ...btnSecondary, padding: "5px 10px", fontSize: 12 }}>Clear dates</button>}
        {anyFilter && <button onClick={clearFilters} style={{ ...btnSecondary, padding: "5px 10px", fontSize: 12, color: C.warn, borderColor: C.warn }} title="Clear status, vendor, search and date filters">Clear filters</button>}
        <button style={btnSecondary} onClick={() => void load()}>Refresh</button>
        <TablePrefsButton
          tableKey={PO_TABLE_KEY}
          columns={PO_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
        />
        {/* Grid-level EXPLODE PPK toggle — controls every row's ▸ line detail
            (moved here from inside each expander). Shared, persisted preference. */}
        <label
          title={explodePpk ? "Row detail shows prepack totals as units (packs × units-per-pack) with per-each cost. Click to switch to packs." : "Row detail shows prepack totals as packs. Click to explode to units + per-each cost."}
          style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "5px 10px", borderRadius: 6, border: `1px solid ${explodePpk ? "#A855F7" : C.cardBdr}`, background: explodePpk ? "rgba(168,85,247,0.12)" : "transparent", userSelect: "none", whiteSpace: "nowrap" }}>
          <input type="checkbox" checked={explodePpk} onChange={(e) => setExplodePpk(e.target.checked)} style={{ accentColor: "#A855F7", cursor: "pointer", width: 12, height: 12 }} />
          <span style={{ color: explodePpk ? "#C4B5FD" : C.textMuted, fontSize: 11, fontWeight: explodePpk ? 700 : 400 }}>EXPLODE PPK</span>
        </label>
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      {/* Result count + cap notice — prevents mistaking the page cap for the total. */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: C.textMuted }}>
          {loading ? "Loading…" : (
            <>
              Showing <b style={{ color: C.text }}>{filteredRows.length.toLocaleString()}</b> purchase order{filteredRows.length === 1 ? "" : "s"}
              {rows.length >= PO_LIST_LIMIT && <> — most recent {PO_LIST_LIMIT}; use search or filters to find older orders</>}
              {anyFilter && <> · <span style={{ color: C.warn }}>filters active</span></>}
            </>
          )}
        </div>
        {/* #1 — Totals strip scope: sum the filtered rows or the whole loaded set. */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textMuted }} title="Switch the Totals row between the currently-filtered rows and the whole loaded dataset">
          <span>Totals:</span>
          {(["filtered", "all"] as const).map((s) => (
            <button key={s} type="button" onClick={() => setTotalsScope(s)}
              style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12,
                ...(totalsScope === s ? { color: C.text, borderColor: C.primary, background: "#0b1220" } : null) }}>
              {s === "filtered" ? "Filtered rows" : "All rows"}
            </button>
          ))}
          <button type="button" onClick={() => setRollupOpen((o) => !o)}
            style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12, ...(rollupOpen ? { color: C.text, borderColor: C.primary, background: "#0b1220" } : null) }}
            title="Break Remaining-to-Ship down by expected month or vendor (the receiving / cash-outflow pipeline)">
            📊 Remaining-to-ship rollup {rollupOpen ? "▾" : "▸"}
          </button>
        </div>
      </div>

      {/* Remaining-to-Ship rollup — planning breakdown of the open commitment. */}
      {rollupOpen && (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 14, marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Remaining to ship by {rollupBy === "month" ? "expected month" : "vendor"} <span style={{ color: C.textMuted, fontWeight: 400 }}>· {rollup.rows.length} group{rollup.rows.length === 1 ? "" : "s"} · {fmtCents(rollup.total)} open{anyFilter ? " (filtered)" : ""}</span></div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textMuted }}>
              <span>Group by:</span>
              {(["month", "vendor"] as const).map((b) => (
                <button key={b} type="button" onClick={() => setRollupBy(b)}
                  style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12, ...(rollupBy === b ? { color: C.text, borderColor: C.primary, background: "#0b1220" } : null) }}>
                  {b === "month" ? "Expected month" : "Vendor"}
                </button>
              ))}
            </div>
          </div>
          {rollup.rows.length === 0 ? <div style={{ color: C.textMuted, fontSize: 13 }}>No open POs in the current view.</div> : (
            <div style={{ maxHeight: 300, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <tbody>
                  {rollup.rows.map((g) => (
                    <tr key={g.key}>
                      <td style={{ padding: "5px 10px 5px 0", whiteSpace: "nowrap", color: C.text }}>{g.label}</td>
                      <td style={{ padding: "5px 10px", color: C.textMuted, textAlign: "right", fontVariantNumeric: "tabular-nums", width: 70 }}>{g.count} PO{g.count === 1 ? "" : "s"}</td>
                      <td style={{ padding: "5px 0", width: "55%" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ flex: 1, height: 8, background: "#0b1220", borderRadius: 4, overflow: "hidden" }}>
                            <div style={{ width: `${rollup.max > 0 ? (g.remaining / rollup.max) * 100 : 0}%`, height: "100%", background: C.primary, borderRadius: 4 }} />
                          </div>
                          <span style={{ width: 120, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{fmtCents(g.remaining)}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {styleScope && <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 8 }}>Cost, PO price, sell &amp; margin scoped to style <b style={{ color: C.text }}>{styleScope}</b></div>}
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            {/* Leading expander column (▸ carrot → per-style line detail). */}
            <th style={{ ...thStick, width: 28, padding: "8px 6px" }} aria-label="Expand" />
            <SortableTh label="PO #" sortKey="po_number" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStick} hidden={!isVisible("po_number")} />
            <SortableTh label="Vendor" sortKey="vendor" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStick} hidden={!isVisible("vendor")} />
            <SortableTh label="Order date" sortKey="order_date" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStick} hidden={!isVisible("order_date")} />
            <SortableTh label="Expected" sortKey="expected_date" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStick} hidden={!isVisible("expected_date")} />
            <SortableTh label="Cancel date" sortKey="cancel_date" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStick} hidden={!isVisible("cancel_date")} />
            <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStick} hidden={!isVisible("status")} />
            <SortableTh label="Avg PO Price" sortKey="avg_po_price" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStick} cellStyle={{ textAlign: "right" }} hidden={!isVisible("avg_po_price")} title="What this PO actually pays the vendor (qty-weighted)" />
            <SortableTh label="Avg cost" sortKey="avg_cost" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStick} cellStyle={{ textAlign: "right" }} hidden={!isVisible("avg_cost")} title="Standard / catalog cost (PO price where the colorway isn't in the cost table)" />
            <SortableTh label="Sell price" sortKey="sell_price" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStick} cellStyle={{ textAlign: "right" }} hidden={!isVisible("sell_price")} />
            <SortableTh label="Margin %" sortKey="margin_pct" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStick} cellStyle={{ textAlign: "right" }} hidden={!isVisible("margin_pct")} title="Sort by margin % — (sell − avg PO price) / sell" />
            <SortableTh label="Margin $" sortKey="margin_amt" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStick} cellStyle={{ textAlign: "right" }} hidden={!isVisible("margin_amt")} title="Sell − avg PO price" />
            <SortableTh label="Total" sortKey="total" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStick} cellStyle={{ textAlign: "right" }} hidden={!isVisible("total")} />
            <SortableTh label="Remaining to ship" sortKey="remaining_ship" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStick} cellStyle={{ textAlign: "right" }} hidden={!isVisible("remaining_ship")} />
          </tr></thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={PO_COL_TOTAL}>Loading…</td></tr>}
            {!loading && sortedRows.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={PO_COL_TOTAL}>No purchase orders.</td></tr>}
            {sortedRows.map((po) => {
              const mPct = poMarginPct(po);
              const mCents = poMarginCents(po);
              const marginColor = mCents == null ? C.text : mCents >= 0 ? C.success : C.danger;
              const isOpen = expandedId === po.id;
              return (
              <Fragment key={po.id}>
              <tr style={{ cursor: "pointer" }} onClick={() => { setEditing(po); setModalOpen(true); }}>
                {/* Carrot — toggles the detail row; stops propagation so it doesn't open the modal. */}
                <td style={{ ...td, width: 28, padding: "8px 6px", textAlign: "center", color: C.textMuted, userSelect: "none" }}
                  onClick={(e) => { e.stopPropagation(); setExpandedId(isOpen ? null : po.id); }}
                  title={isOpen ? "Hide line detail" : "Show line detail"}>{isOpen ? "▾" : "▸"}</td>
                <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }} hidden={!isVisible("po_number")}>{po.po_number || <span style={{ color: C.textMuted }}>(draft)</span>}</td>
                <td style={td} hidden={!isVisible("vendor")}>{vendorName[po.vendor_id] || "—"}</td>
                <td style={td} hidden={!isVisible("order_date")}>{fmtDateDisplay(po.order_date)}</td>
                <td style={td} hidden={!isVisible("expected_date")}>{po.expected_date ? fmtDateDisplay(po.expected_date) : "—"}</td>
                <td style={td} hidden={!isVisible("cancel_date")}>{po.cancel_date ? fmtDateDisplay(po.cancel_date) : "—"}</td>
                <td style={td} hidden={!isVisible("status")}><span style={{ color: STATUS_COLORS[po.status] || C.text, fontWeight: 600 }}>● {statusLabel(po.status)}</span><InTransitChip po={po} /></td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!isVisible("avg_po_price")} title="This PO's actual unit price">{po.avg_po_price_cents != null ? fmtCents(po.avg_po_price_cents) : <span style={{ color: C.textMuted }}>—</span>}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!isVisible("avg_cost")} title="Standard / catalog cost (PO price where the colorway isn't in the cost table)">{po.avg_cost_cents != null ? fmtCents(po.avg_cost_cents) : <span style={{ color: C.textMuted }}>—</span>}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!isVisible("sell_price")}>{po.sell_cents != null ? fmtCents(po.sell_cents) : <span style={{ color: C.textMuted }}>—</span>}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: marginColor }} hidden={!isVisible("margin_pct")} title="(sell − avg PO price) / sell">{fmtPct(mPct)}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: marginColor }} hidden={!isVisible("margin_amt")} title="sell − avg PO price">{mCents != null ? fmtCents(mCents) : <span style={{ color: C.textMuted }}>—</span>}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!isVisible("total")}>{fmtCents(po.total_cents)}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!isVisible("remaining_ship")} title="Open commitment: Σ (ordered − received) × PO cost">{fmtCents(po.remaining_to_ship_cents ?? 0)}</td>
              </tr>
              {isOpen && (
                <tr>
                  <td style={{ padding: 0, background: "#0b1220", borderBottom: `1px solid ${C.cardBdr}` }} colSpan={PO_COL_TOTAL}>
                    <PoRowDetail poId={po.id} explode={explodePpk} status={po.status} />
                  </td>
                </tr>
              )}
              </Fragment>
              );
            })}
          </tbody>
          {/* #1 / #23 — Totals strip (also exported). Scope follows the toggle. */}
          {!loading && totals.count > 0 && (
            <tfoot>
              <tr style={{ position: "sticky", bottom: 0, zIndex: 1 }}>
                {/* Expander column — no total. */}
                <td style={{ ...td, width: 28, padding: "8px 6px", background: "#0b1220", borderTop: `2px solid ${C.cardBdr}` }} />
                <td style={{ ...td, background: "#0b1220", fontWeight: 700, borderTop: `2px solid ${C.cardBdr}` }} hidden={!isVisible("po_number")}>
                  {totalsScope === "all" ? "Total · all loaded" : "Total · filtered"}
                </td>
                <td style={{ ...td, background: "#0b1220", color: C.textMuted, borderTop: `2px solid ${C.cardBdr}` }} hidden={!isVisible("vendor")}>{totals.count.toLocaleString()} PO{totals.count === 1 ? "" : "s"}</td>
                <td style={{ ...td, background: "#0b1220", borderTop: `2px solid ${C.cardBdr}` }} hidden={!isVisible("order_date")} />
                <td style={{ ...td, background: "#0b1220", borderTop: `2px solid ${C.cardBdr}` }} hidden={!isVisible("expected_date")} />
                <td style={{ ...td, background: "#0b1220", borderTop: `2px solid ${C.cardBdr}` }} hidden={!isVisible("cancel_date")} />
                <td style={{ ...td, background: "#0b1220", borderTop: `2px solid ${C.cardBdr}` }} hidden={!isVisible("status")} />
                <td style={{ ...td, background: "#0b1220", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, borderTop: `2px solid ${C.cardBdr}` }} hidden={!isVisible("avg_po_price")} title="Total-weighted average PO price">{totals.avgPoPrice != null ? fmtCents(totals.avgPoPrice) : "—"}</td>
                <td style={{ ...td, background: "#0b1220", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, borderTop: `2px solid ${C.cardBdr}` }} hidden={!isVisible("avg_cost")} title="Total-weighted average standard cost">{totals.avgCost != null ? fmtCents(totals.avgCost) : "—"}</td>
                <td style={{ ...td, background: "#0b1220", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, borderTop: `2px solid ${C.cardBdr}` }} hidden={!isVisible("sell_price")} title="Total-weighted average sell price">{totals.sell != null ? fmtCents(totals.sell) : "—"}</td>
                <td style={{ ...td, background: "#0b1220", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, borderTop: `2px solid ${C.cardBdr}`, color: totals.marginPct == null ? C.text : totals.marginPct >= 0 ? C.success : C.danger }} hidden={!isVisible("margin_pct")} title="Weighted margin % across the totalled rows">{fmtPct(totals.marginPct)}</td>
                <td style={{ ...td, background: "#0b1220", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, borderTop: `2px solid ${C.cardBdr}`, color: totals.marginCents == null ? C.text : totals.marginCents >= 0 ? C.success : C.danger }} hidden={!isVisible("margin_amt")} title="Weighted margin $ (sell − PO price)">{totals.marginCents != null ? fmtCents(totals.marginCents) : "—"}</td>
                <td style={{ ...td, background: "#0b1220", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 800, borderTop: `2px solid ${C.cardBdr}` }} hidden={!isVisible("total")}>{fmtCents(totals.totalCents)}</td>
                <td style={{ ...td, background: "#0b1220", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 800, borderTop: `2px solid ${C.cardBdr}` }} hidden={!isVisible("remaining_ship")} title="Open commitment (ties to Xoro $ Remaining to Ship)">{fmtCents(totals.remainingCents)}</td>
              </tr>
            </tfoot>
          )}
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

// ── Row expander: per-style line detail ─────────────────────────────────────
// Lazy-fetches the PO's lines and renders a per-style color×size matrix. The
// EXPLODE PPK state is owned by the grid toolbar and passed in via `explode`:
// OFF → cells/totals are pack counts and the unit column is the per-pack PO cost;
// ON → cells/totals are units (packs × units-per-pack) and the unit column is the
// per-EACH cost. Ext $ is grain-safe either way (line unit_cost_cents is per-pack,
// qty is packs, so Σ qty·unit is the same).
type PoDetailLine = {
  style_code: string | null; color: string | null; size: string | null;
  sku_code: string | null; qty_ordered: number; qty_received: number | null;
  unit_cost_cents: number; lot_number: string | null; description: string | null;
};
// Apparel-ish size rank so grids read XS,S,M,L,XL… then numerics then alpha.
const SIZE_RANK: Record<string, number> = { XXS: 0, XS: 1, S: 2, M: 3, L: 4, XL: 5, XXL: 6, "2XL": 6, XXXL: 7, "3XL": 7, "4XL": 8 };
function sizeSort(a: string, b: string): number {
  const ra = SIZE_RANK[a.toUpperCase()], rb = SIZE_RANK[b.toUpperCase()];
  if (ra != null && rb != null) return ra - rb;
  if (ra != null) return -1;
  if (rb != null) return 1;
  const na = parseFloat(a), nb = parseFloat(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

function PoRowDetail({ poId, explode, status }: { poId: string; explode: boolean; status: string }) {
  const [lines, setLines] = useState<PoDetailLine[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Qty view — mirrors the PO WIP matrix's itemQty logic: a partially-received
  // PO defaults to REMAINING (ordered − received), toggleable to the ORIGINAL
  // ordered qty. Harmless for non-partial POs (received = 0 → the two agree).
  const [qtyView, setQtyView] = useState<"remaining" | "original">("remaining");
  useEffect(() => {
    let cancel = false;
    setLines(null); setErr(null);
    fetch(`/api/internal/purchase-orders/${poId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((full) => { if (!cancel) setLines(Array.isArray(full?.lines) ? (full.lines as PoDetailLine[]) : []); })
      .catch((e) => { if (!cancel) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { cancel = true; };
  }, [poId]);

  if (err) return <div style={{ padding: "10px 14px", color: C.danger, fontSize: 12 }}>Couldn't load line detail: {err}</div>;
  if (lines == null) return <div style={{ padding: "10px 14px", color: C.textMuted, fontSize: 12 }}>Loading line detail…</div>;
  if (lines.length === 0) return <div style={{ padding: "10px 14px", color: C.textMuted, fontSize: 12 }}>No lines on this purchase order.</div>;

  // A partial receipt exists → offer the Remaining/Original toggle. Driven by
  // real per-line receipts OR the header status, so it shows even if one lags.
  const hasReceipts = status === "partially_received" || lines.some((l) => (Number(l.qty_received) || 0) > 0);
  // Effective (packs) qty for a line under the current view.
  const effLineQty = (l: PoDetailLine) => {
    const ord = Number(l.qty_ordered) || 0;
    if (qtyView === "original") return ord;
    return Math.max(0, ord - (Number(l.qty_received) || 0));
  };

  // Split into matrix-able lines (real style + size → color×size grid) and
  // unlinked lines (SKU-less pack / aggregate lines — no size to place in a
  // matrix, e.g. Xoro prepack rows). Unlinked lines get their own list below
  // instead of scattering as broken single-cell "matrix" rows.
  const matrixLines = lines.filter((l) => l.style_code && l.size);
  const unlinkedLines = lines.filter((l) => !(l.style_code && l.size));

  // Group matrix lines by style → color → size (qty + Σ qty·unit for a weighted cost).
  type Cell = { qty: number; costNum: number };
  const byStyle = new Map<string, { sizes: Set<string>; colors: Map<string, Map<string, Cell>>; lots: Set<string> }>();
  for (const l of matrixLines) {
    const style = l.style_code as string;
    const color = l.color || "—";
    const size = l.size as string;
    let s = byStyle.get(style);
    if (!s) { s = { sizes: new Set(), colors: new Map(), lots: new Set() }; byStyle.set(style, s); }
    s.sizes.add(size);
    if (l.lot_number) s.lots.add(l.lot_number);
    let cm = s.colors.get(color);
    if (!cm) { cm = new Map(); s.colors.set(color, cm); }
    const cell = cm.get(size) || { qty: 0, costNum: 0 };
    const qty = effLineQty(l);
    const unit = Number(l.unit_cost_cents) || 0;
    cell.qty += qty; cell.costNum += qty * unit;
    cm.set(size, cell);
  }
  // Explode multiplier for a size (1 when off or non-PPK).
  const mult = (style: string, size: string) => (explode ? (extractPpk(size) ?? extractPpk(style) ?? 1) : 1);
  const ppkOf = (style: string, size: string) => (extractPpk(size) ?? extractPpk(style) ?? 1);
  const miniTh: React.CSSProperties = { ...th, position: "static" };
  const remainingView = qtyView === "remaining" && hasReceipts;

  return (
    <div style={{ padding: "10px 14px 14px", display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>Line detail</span>
        <span style={{ color: explode ? "#C4B5FD" : C.textMuted, fontSize: 10 }}>· {explode ? "units (PPK exploded)" : "packs"}</span>
        {remainingView && <span style={{ color: "#14B8A6", fontSize: 10 }}>· remaining to ship</span>}
        {hasReceipts && (
          <div style={{ marginLeft: "auto", display: "inline-flex", border: `1px solid ${C.cardBdr}`, borderRadius: 6, overflow: "hidden" }}
            title="Show the quantity still to ship (ordered − received) or the original ordered quantity">
            {(["remaining", "original"] as const).map((v) => (
              <button key={v} type="button" onClick={() => setQtyView(v)}
                style={{ padding: "3px 10px", fontSize: 11, fontWeight: qtyView === v ? 700 : 400, cursor: "pointer", border: "none",
                  background: qtyView === v ? "#14B8A6" : "transparent", color: qtyView === v ? "#04211d" : C.textMuted }}>
                {v === "remaining" ? "Remaining" : "Original"}
              </button>
            ))}
          </div>
        )}
      </div>
      {[...byStyle.entries()].map(([style, s]) => {
        const sizes = [...s.sizes].sort(sizeSort);
        let styleQty = 0, styleExt = 0;
        for (const cm of s.colors.values()) for (const [sz, cell] of cm) { styleQty += cell.qty * mult(style, sz); styleExt += cell.costNum; }
        return (
          <div key={style} style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", background: C.bg }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "6px 10px", background: C.card }}>
              <span style={{ color: C.primary, fontFamily: "monospace", fontWeight: 700 }}>{style}</span>
              {s.lots.size > 0 && <span style={{ color: C.textMuted, fontSize: 11 }}>lot {[...s.lots].join(", ")}</span>}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr>
                  <th style={miniTh}>Color</th>
                  {sizes.map((sz) => <th key={sz} style={{ ...miniTh, textAlign: "center" }}>{sz}</th>)}
                  <th style={{ ...miniTh, textAlign: "center" }}>{explode ? "Units" : "Packs"}</th>
                  <th style={{ ...miniTh, textAlign: "right" }}>{explode ? "Per-each $" : "PO unit $"}</th>
                  <th style={{ ...miniTh, textAlign: "right" }}>Ext $</th>
                </tr></thead>
                <tbody>
                  {[...s.colors.entries()].map(([color, cm]) => {
                    let rowPacks = 0, rowExt = 0, rowUnits = 0, rowQtyDisp = 0;
                    for (const [sz, cell] of cm) {
                      rowPacks += cell.qty;
                      rowExt += cell.costNum;
                      rowUnits += cell.qty * ppkOf(style, sz);
                      rowQtyDisp += cell.qty * mult(style, sz);
                    }
                    const avgPackUnit = rowPacks > 0 ? rowExt / rowPacks : 0;
                    const perEach = rowUnits > 0 ? rowExt / rowUnits : avgPackUnit;
                    const unitDisp = explode ? perEach : avgPackUnit;
                    return (
                      <tr key={color} style={{ borderTop: `1px solid ${C.cardBdr}` }}>
                        <td style={{ ...td, borderBottom: "none" }}>{color}</td>
                        {sizes.map((sz) => {
                          const cell = cm.get(sz);
                          return <td key={sz} style={{ ...td, borderBottom: "none", textAlign: "center", fontFamily: "monospace", color: cell ? C.text : C.cardBdr }}>{cell ? (cell.qty * mult(style, sz)).toLocaleString() : "—"}</td>;
                        })}
                        <td style={{ ...td, borderBottom: "none", textAlign: "center", fontFamily: "monospace", color: C.warn, fontWeight: 700 }}>{rowQtyDisp.toLocaleString()}</td>
                        <td style={{ ...td, borderBottom: "none", textAlign: "right", fontFamily: "monospace", color: C.textSub }}>{fmtCents(Math.round(unitDisp))}</td>
                        <td style={{ ...td, borderBottom: "none", textAlign: "right", fontFamily: "monospace", color: C.success, fontWeight: 600 }}>{fmtCents(Math.round(rowExt))}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: `2px solid ${C.cardBdr}` }}>
                    <td style={{ ...td, borderBottom: "none", color: C.textMuted, fontWeight: 700 }} colSpan={sizes.length + 1}>Style total</td>
                    <td style={{ ...td, borderBottom: "none", textAlign: "center", fontFamily: "monospace", color: C.warn, fontWeight: 800 }}>{styleQty.toLocaleString()}</td>
                    <td style={{ ...td, borderBottom: "none" }} />
                    <td style={{ ...td, borderBottom: "none", textAlign: "right", fontFamily: "monospace", color: C.success, fontWeight: 800 }}>{fmtCents(Math.round(styleExt))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        );
      })}

      {/* Unlinked / prepack lines — SKU-less rows (no size to place in a matrix,
          e.g. Xoro pack-priced aggregate lines). Shown as a plain list so they're
          visible and correct rather than scattered as broken single-cell rows. */}
      {unlinkedLines.length > 0 && (
        <div style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", background: C.bg }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "6px 10px", background: C.card }}>
            <span style={{ color: C.warn, fontWeight: 700, fontSize: 12 }}>Unlinked lines</span>
            <span style={{ color: C.textMuted, fontSize: 11 }}>no size matrix — pack / aggregate lines with no per-size SKU</span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr>
                <th style={miniTh}>Description</th>
                <th style={{ ...miniTh, textAlign: "center" }}>Qty</th>
                <th style={{ ...miniTh, textAlign: "right" }}>PO unit $</th>
                <th style={{ ...miniTh, textAlign: "right" }}>Ext $</th>
              </tr></thead>
              <tbody>
                {unlinkedLines.map((l, i) => {
                  const q = effLineQty(l);
                  const unit = Number(l.unit_cost_cents) || 0;
                  return (
                    <tr key={i} style={{ borderTop: `1px solid ${C.cardBdr}` }}>
                      <td style={{ ...td, borderBottom: "none" }}>{l.description || l.sku_code || "—"}</td>
                      <td style={{ ...td, borderBottom: "none", textAlign: "center", fontFamily: "monospace", color: C.warn, fontWeight: 700 }}>{q.toLocaleString()}</td>
                      <td style={{ ...td, borderBottom: "none", textAlign: "right", fontFamily: "monospace", color: C.textSub }}>{fmtCents(unit)}</td>
                      <td style={{ ...td, borderBottom: "none", textAlign: "right", fontFamily: "monospace", color: C.success, fontWeight: 600 }}>{fmtCents(Math.round(q * unit))}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `2px solid ${C.cardBdr}` }}>
                  <td style={{ ...td, borderBottom: "none", color: C.textMuted, fontWeight: 700 }}>Total</td>
                  <td style={{ ...td, borderBottom: "none", textAlign: "center", fontFamily: "monospace", color: C.warn, fontWeight: 800 }}>{unlinkedLines.reduce((s, l) => s + effLineQty(l), 0).toLocaleString()}</td>
                  <td style={{ ...td, borderBottom: "none" }} />
                  <td style={{ ...td, borderBottom: "none", textAlign: "right", fontFamily: "monospace", color: C.success, fontWeight: 800 }}>{fmtCents(Math.round(unlinkedLines.reduce((s, l) => s + effLineQty(l) * (Number(l.unit_cost_cents) || 0), 0)))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── In-transit overlay editor ────────────────────────────────────────────────
type Shipment = {
  id: string; status: string; source: string; ship_method: string | null;
  carrier: string | null; tracking_number: string | null; asn_ref: string | null;
  shipped_date: string | null; eta: string | null; notes: string | null;
  lines: { id: string; purchase_order_line_id: string; qty_in_transit: number }[];
};
type POLineLite = { id: string; description: string | null; qty_ordered: number; qty_received: number | null; sku_code?: string | null };
const SHIP_METHOD_OPTS = ["", "sea", "air", "ground"];

// Shipments = the in-transit OVERLAY for one PO. A PO carries zero-or-more
// shipments (carrier / method / ETA + per-line qty on the way); it reads
// "in transit" while any is still status 'in_transit'. Buyer-entered here.
function ShipmentsModal({ poId, poNumber, onClose, onChanged }: { poId: string; poNumber: string | null; onClose: () => void; onChanged: () => void }) {
  const [ships, setShips] = useState<Shipment[]>([]);
  const [lines, setLines] = useState<POLineLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Shipment | null>(null); // null = list view
  // Editable form fields (shared new/edit).
  const [f, setF] = useState<{ ship_method: string; carrier: string; tracking_number: string; asn_ref: string; shipped_date: string; eta: string; notes: string }>({ ship_method: "", carrier: "", tracking_number: "", asn_ref: "", shipped_date: "", eta: "", notes: "" });
  const [qty, setQty] = useState<Record<string, string>>({}); // po_line_id → qty in transit

  async function reload() {
    setLoading(true); setErr(null);
    try {
      const [sr, pr] = await Promise.all([
        fetch(`/api/internal/purchase-orders/${poId}/shipments`).then((r) => r.ok ? r.json() : []),
        fetch(`/api/internal/purchase-orders/${poId}`).then((r) => r.ok ? r.json() : null),
      ]);
      setShips(Array.isArray(sr) ? sr : []);
      setLines(Array.isArray(pr?.lines) ? pr.lines : []);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, [poId]);

  function openForm(s: Shipment | null) {
    setEditing(s ?? ({ id: "", status: "in_transit", source: "buyer", ship_method: null, carrier: null, tracking_number: null, asn_ref: null, shipped_date: null, eta: null, notes: null, lines: [] } as Shipment));
    setF({
      ship_method: s?.ship_method ?? "", carrier: s?.carrier ?? "", tracking_number: s?.tracking_number ?? "",
      asn_ref: s?.asn_ref ?? "", shipped_date: s?.shipped_date ?? "", eta: s?.eta ?? "", notes: s?.notes ?? "",
    });
    const q: Record<string, string> = {};
    if (s) for (const l of s.lines) q[l.purchase_order_line_id] = String(l.qty_in_transit);
    else for (const l of lines) { const rem = Number(l.qty_ordered) - Number(l.qty_received || 0); if (rem > 0) q[l.id] = String(rem); } // default new = remaining
    setQty(q);
  }

  async function save() {
    if (!editing) return;
    setBusy(true); setErr(null);
    const payload = {
      ship_method: f.ship_method || null, carrier: f.carrier || null, tracking_number: f.tracking_number || null,
      asn_ref: f.asn_ref || null, shipped_date: f.shipped_date || null, eta: f.eta || null, notes: f.notes || null,
      lines: Object.entries(qty).map(([purchase_order_line_id, v]) => ({ purchase_order_line_id, qty_in_transit: Number(v) || 0 })).filter((l) => l.qty_in_transit > 0),
    };
    const isNew = !editing.id;
    const url = isNew ? `/api/internal/purchase-orders/${poId}/shipments` : `/api/internal/purchase-orders/${poId}/shipments/${editing.id}`;
    try {
      const r = await fetch(url, { method: isNew ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setEditing(null); await reload(); onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function patchStatus(s: Shipment, status: string) {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/purchase-orders/${poId}/shipments/${s.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await reload(); onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function remove(s: Shipment) {
    if (!(await confirmDialog("Delete this shipment record? This does not change received quantities."))) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/purchase-orders/${poId}/shipments/${s.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await reload(); onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  const shipColor: Record<string, string> = { in_transit: C.warn, arrived: C.success, cancelled: C.danger };
  const inp: React.CSSProperties = { ...inputStyle };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 120, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 16px", overflow: "auto" }} onClick={onClose}>
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 12, width: "min(760px, 95vw)", maxHeight: "90vh", overflow: "auto", padding: 20, color: C.text }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 18 }}>🚚 Shipments · <span style={{ color: C.textMuted }}>{poNumber || "(draft)"}</span></h3>
          <button onClick={onClose} style={btnSecondary}>Close</button>
        </div>
        {err && <div style={{ color: C.danger, marginBottom: 10, fontSize: 13 }}>{err}</div>}
        {loading ? <div style={{ color: C.textMuted }}>Loading…</div> : editing ? (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
              <label style={dl}>Method<select value={f.ship_method} onChange={(e) => setF({ ...f, ship_method: e.target.value })} style={inp}>{SHIP_METHOD_OPTS.map((m) => <option key={m} value={m}>{m ? m[0].toUpperCase() + m.slice(1) : "—"}</option>)}</select></label>
              <label style={dl}>Carrier<input value={f.carrier} onChange={(e) => setF({ ...f, carrier: e.target.value })} style={inp} placeholder="Maersk…" /></label>
              <label style={dl}>Tracking / BOL<input value={f.tracking_number} onChange={(e) => setF({ ...f, tracking_number: e.target.value })} style={inp} /></label>
              <label style={dl}>ASN ref<input value={f.asn_ref} onChange={(e) => setF({ ...f, asn_ref: e.target.value })} style={inp} /></label>
              <label style={dl}>Shipped date<input type="date" value={f.shipped_date} onChange={(e) => setF({ ...f, shipped_date: e.target.value })} style={{ ...inp, colorScheme: "dark" }} /></label>
              <label style={dl}>ETA<input type="date" value={f.eta} onChange={(e) => setF({ ...f, eta: e.target.value })} style={{ ...inp, colorScheme: "dark" }} /></label>
            </div>
            <label style={dl}>Notes<input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} style={{ ...inp, marginBottom: 12 }} /></label>
            <div style={{ fontSize: 12, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, margin: "6px 0" }}>Quantities on the way</div>
            <div style={{ maxHeight: 240, overflow: "auto", border: `1px solid ${C.cardBdr}`, borderRadius: 6 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr style={{ position: "sticky", top: 0 }}><th style={{ ...th, position: "sticky", top: 0 }}>Line</th><th style={{ ...th, textAlign: "right" }}>Ordered</th><th style={{ ...th, textAlign: "right" }}>Received</th><th style={{ ...th, textAlign: "right" }}>Remaining</th><th style={{ ...th, textAlign: "right" }}>In transit</th></tr></thead>
                <tbody>
                  {lines.map((l) => { const rem = Number(l.qty_ordered) - Number(l.qty_received || 0); return (
                    <tr key={l.id}>
                      <td style={td}>{l.sku_code || l.description || "—"}</td>
                      <td style={{ ...td, textAlign: "right" }}>{Number(l.qty_ordered).toLocaleString()}</td>
                      <td style={{ ...td, textAlign: "right" }}>{Number(l.qty_received || 0).toLocaleString()}</td>
                      <td style={{ ...td, textAlign: "right", color: C.textMuted }}>{rem.toLocaleString()}</td>
                      <td style={{ ...td, textAlign: "right" }}><input value={qty[l.id] ?? ""} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value.replace(/[^0-9]/g, "") })} style={{ ...inp, width: 80, textAlign: "right", padding: "4px 6px" }} placeholder="0" /></td>
                    </tr>
                  ); })}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
              <button onClick={() => setEditing(null)} style={btnSecondary} disabled={busy}>Cancel</button>
              <button onClick={() => void save()} style={btnPrimary} disabled={busy}>{busy ? "Saving…" : editing.id ? "Save shipment" : "Add shipment"}</button>
            </div>
          </div>
        ) : (
          <div>
            {ships.length === 0 ? <div style={{ color: C.textMuted, padding: "12px 0" }}>No shipments recorded. Add one to mark this PO in transit.</div> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {ships.map((s) => (
                  <div key={s.id} style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "10px 12px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}><span style={{ color: shipColor[s.status] || C.text }}>● {statusLabel(s.status)}</span> {s.ship_method ? `· ${s.ship_method}` : ""} {s.carrier ? `· ${s.carrier}` : ""} {s.source === "vendor_asn" ? "· vendor ASN" : ""}</div>
                      <div style={{ fontSize: 12, color: C.textMuted }}>{s.eta ? `ETA ${fmtDateDisplay(s.eta)}` : "no ETA"} · {s.lines.reduce((a, l) => a + Number(l.qty_in_transit), 0).toLocaleString()} units · {s.lines.length} line{s.lines.length === 1 ? "" : "s"}{s.tracking_number ? ` · ${s.tracking_number}` : ""}</div>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      <button onClick={() => openForm(s)} style={{ ...btnSecondary, padding: "4px 10px" }} disabled={busy}>Edit</button>
                      {s.status === "in_transit" && <button onClick={() => void patchStatus(s, "arrived")} style={{ ...btnSecondary, padding: "4px 10px", color: C.success, borderColor: "#065f46" }} disabled={busy} title="Mark this shipment arrived (clears the in-transit overlay for it)">Arrived</button>}
                      {s.status === "in_transit" && <button onClick={() => void patchStatus(s, "cancelled")} style={{ ...btnSecondary, padding: "4px 10px", color: C.warn }} disabled={busy}>Cancel</button>}
                      <button onClick={() => void remove(s)} style={{ ...btnSecondary, padding: "4px 10px", color: C.danger, borderColor: "#7f1d1d" }} disabled={busy}>✕</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: 14 }}><button onClick={() => openForm(null)} style={btnPrimary} disabled={busy}>+ Add shipment</button></div>
          </div>
        )}
      </div>
    </div>
  );
}

function POModal({ po, vendors: vendorsProp, onClose, onSaved }: { po: PO | null; vendors: Vendor[]; onClose: () => void; onSaved: () => void }) {
  const isNew = po === null;
  // Item 1 — on-the-fly "+ New vendor / + New customer" rows are merged in front
  // of the loaded lists so they're immediately selectable without leaving the PO.
  const [extraVendors, setExtraVendors] = useState<Vendor[]>([]);
  const [quickAddVendor, setQuickAddVendor] = useState(false);
  const [quickAddCustomer, setQuickAddCustomer] = useState(false);
  const [quickAddInitialName, setQuickAddInitialName] = useState(""); // item 8 — typeahead prefill
  const vendors = useMemo(
    () => (extraVendors.length ? [...extraVendors, ...vendorsProp] : vendorsProp),
    [extraVendors, vendorsProp],
  );
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
  // View button → PDF / Excel dropdown (mirrors the SO "Confirmation" menu).
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  // Line body is the shared size matrix (mode="po" → Unit Cost $, no margin/ATS).
  const bodyRef = useRef<LineMatrixBodyHandle>(null);
  const [seed, setSeed] = useState<{ sections: SeedSection[]; flat: FlatLine[] } | null>(null);
  const [seedKey, setSeedKey] = useState(0); // bump to remount + re-seed the matrix body
  const [salesOrderId, setSalesOrderId] = useState(""); // originating SO (Create from SO)
  // Scenario 4 — split this PO's lines across multiple customer POs (lots),
  // evenly on a full-carton basis. Each entered customer PO becomes a lot.
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitLots, setSplitLots] = useState<string[]>([]);
  const [splitInput, setSplitInput] = useState("");
  const [splitBusy, setSplitBusy] = useState(false);
  // Create-from-SO dialog.
  const [soPickOpen, setSoPickOpen] = useState(false);
  const [soQuery, setSoQuery] = useState("");
  const [soList, setSoList] = useState<{ id: string; so_number: string | null; customer_id: string; status: string; requested_ship_date: string | null; cancel_date: string | null; brand_id: string | null; channel_id: string | null; customer_po: string | null; fulfillment_source: string | null }[]>([]);
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
  const [shipmentsOpen, setShipmentsOpen] = useState(false);

  // Manufacturing-part PO (po_type='manufacturing_part'): lines pick PARTS, not
  // style SKUs. A non-matrix part uses a single qty; a matrix (by-size) part
  // enters a qty per size (P2b) that resolves to per-size child parts on save.
  type PartLine = { key: number; part_id: string; qty: string; unit: string; is_matrix?: boolean; sizes?: string[]; sizeQty?: Record<string, string> };
  type PartOpt = { id: string; code: string; name: string; default_unit_cost_cents?: number | null; uom?: string | null; is_matrix?: boolean };
  const [parts, setParts] = useState<PartOpt[]>([]);
  const [partLines, setPartLines] = useState<PartLine[]>([{ key: 1, part_id: "", qty: "", unit: "" }]);
  const partKey = useRef(2);
  const isPartPo = poType === "manufacturing_part";

  // Pick a part into a line. For a MATRIX part, fetch its sizes and switch the
  // row into by-size entry; otherwise a single qty.
  async function pickPart(rowKey: number, partId: string) {
    const p = parts.find((pp) => pp.id === partId) || null;
    const unitDefault = p && p.default_unit_cost_cents != null ? (p.default_unit_cost_cents / 100).toFixed(2) : "";
    setPartLines((ls) => ls.map((x) => x.key === rowKey ? { ...x, part_id: partId || "", unit: x.unit || unitDefault, is_matrix: !!p?.is_matrix, sizes: [], sizeQty: p?.is_matrix ? {} : undefined, qty: p?.is_matrix ? "" : x.qty } : x));
    if (p?.is_matrix) {
      try {
        const r = await fetch(`/api/internal/part-matrix?part_id=${partId}`);
        if (r.ok) { const j = await r.json(); const sizes = Array.isArray(j.sizes) ? j.sizes.map(String) : []; setPartLines((ls) => ls.map((x) => x.key === rowKey ? { ...x, sizes } : x)); }
      } catch { /* ignore */ }
    }
  }
  function setSizeQty(rowKey: number, size: string, val: string) {
    setPartLines((ls) => ls.map((x) => x.key === rowKey ? { ...x, sizeQty: { ...(x.sizeQty || {}), [size]: val } } : x));
  }

  useEffect(() => {
    fetch("/api/internal/items?limit=5000").then((r) => r.ok ? r.json() : []).then((a) => setItems(Array.isArray(a) ? a : [])).catch(() => {});
    fetch("/api/internal/part-master?limit=5000").then((r) => r.ok ? r.json() : []).then((a) => setParts(Array.isArray(a) ? a : (a?.parts || a?.data || []))).catch(() => {});
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

  // Build the matrix seed (per-style sections + flat lines) from decorated PO
  // lines. Shared by the initial load and the post-split reload.
  function poSeedFromLines(lines: unknown[]): { sections: SeedSection[]; flat: FlatLine[] } {
    type DLine = { inventory_item_id: string | null; description: string | null; qty_ordered: number; unit_cost_cents: number; style_code?: string | null; color?: string | null; size?: string | null; inseam?: string | null; sku_code?: string | null; requested_ship_date?: string | null; vendor_confirmed_ship_date?: string | null; lot_number?: string | null };
    const byStyle = new Map<string, SeedSection>();
    const flat: FlatLine[] = [];
    let fk = 1;
    for (const l of (lines as DLine[])) {
      const dollars = l.unit_cost_cents != null ? (l.unit_cost_cents / 100).toFixed(2) : "";
      if (l.style_code && l.size) {
        let sec = byStyle.get(l.style_code);
        if (!sec) { sec = { styleCode: l.style_code, cells: [], requestedShipDate: l.requested_ship_date ?? null, vendorConfirmedShipDate: l.vendor_confirmed_ship_date ?? null }; byStyle.set(l.style_code, sec); }
        sec.cells.push({ color: l.color ?? null, size: l.size, inseam: l.inseam ?? null, qty: l.qty_ordered, unit: dollars, lot: l.lot_number ?? null });
      } else {
        flat.push({ key: fk++, inventory_item_id: l.inventory_item_id || "", qty_ordered: String(l.qty_ordered ?? ""), unit_price_dollars: dollars, label: l.sku_code ? `${l.sku_code}${l.style_code ? ` — ${l.style_code}` : ""}` : (l.description || undefined) });
      }
    }
    return { sections: [...byStyle.values()], flat };
  }

  // Load existing PO lines when editing → seed the matrix body. If the detail
  // endpoint decorates lines with style_code/color/size they regroup into
  // per-style matrices; otherwise they seed as flat lines (still editable).
  useEffect(() => {
    if (isNew || !po) { setSeed(null); return; }
    fetch(`/api/internal/purchase-orders/${po.id}`).then((r) => r.ok ? r.json() : null).then((full) => {
      if (!full) return;
      // Populate the rich-header state from the full PO record + the rollup.
      setPoType(full.po_type || ""); setCustomerId(full.customer_id || "");
      // Manufacturing-part PO → seed the part-line grid. Per-size CHILD lines
      // (part_parent_id set) regroup into a by-size MATRIX row per parent; other
      // part lines seed as flat rows.
      if (full.po_type === "manufacturing_part") {
        type SLine = { part_id: string; qty_ordered: number; unit_cost_cents: number | null; part_parent_id?: string | null; part_size?: string | null };
        const rows: PartLine[] = [];
        const parentRow = new Map<string, PartLine>();
        let k = 1;
        for (const l of ((full.lines || []) as SLine[])) {
          if (!l.part_id) continue;
          const unit = l.unit_cost_cents != null ? (l.unit_cost_cents / 100).toFixed(2) : "";
          if (l.part_parent_id) {
            let row = parentRow.get(l.part_parent_id);
            if (!row) { row = { key: k++, part_id: l.part_parent_id, qty: "", unit, is_matrix: true, sizes: [], sizeQty: {} }; parentRow.set(l.part_parent_id, row); rows.push(row); }
            if (l.part_size) row.sizeQty![l.part_size] = String(l.qty_ordered ?? "");
            if (!row.unit && unit) row.unit = unit;
          } else {
            rows.push({ key: k++, part_id: l.part_id, qty: String(l.qty_ordered ?? ""), unit });
          }
        }
        partKey.current = k;
        setPartLines(rows.length ? rows : [{ key: 1, part_id: "", qty: "", unit: "" }]);
        // Load each matrix row's full size list (so unfilled sizes are enterable too).
        for (const row of rows) {
          if (!row.is_matrix) continue;
          fetch(`/api/internal/part-matrix?part_id=${row.part_id}`).then((r) => r.ok ? r.json() : null).then((j) => {
            if (j?.sizes) setPartLines((ls) => ls.map((x) => x.key === row.key ? { ...x, sizes: (j.sizes as unknown[]).map(String) } : x));
          }).catch(() => {});
        }
      }
      setVendorContact(full.vendor_contact || ""); setVendorEmail(full.vendor_email || ""); setVendorRef(full.vendor_ref || "");
      setFactoryLocation(full.factory_location || ""); setCoo(full.coo || "");
      setRequestedDeliveryDate(full.requested_delivery_date || ""); setShipWindowStart(full.ship_window_start || ""); setShipWindowEnd(full.ship_window_end || "");
      setPortDate(full.port_date || ""); setAcknowledgedDate(full.acknowledged_date || ""); setCancelDate(full.cancel_date || "");
      setShipToLocationId(full.ship_to_location_id || ""); setBillToEntityId(full.bill_to_entity_id || "");
      setShipMethod(full.ship_method || ""); setFreightForwarder(full.freight_forwarder || "");
      setSeason(full.season || ""); setChannelId(full.channel_id || ""); setDepartmentCategoryId(full.department_category_id || "");
      setSalesOrderId(full.sales_order_id || "");
      if (full.logistics_rollup) setRollup(full.logistics_rollup);
      if (full?.lines) setSeed(poSeedFromLines(full.lines));
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
      // Scenario 3 — a PO created from an SO inherits the customer's PO number as
      // the lot on every line (the lot column is editable; blank customer PO falls
      // back to the PO# auto-stamped at issue). Grain = style+color.
      const soLot = (full.customer_po && String(full.customer_po).trim()) || null;
      const byStyle = new Map<string, SeedSection>();
      const flat: FlatLine[] = [];
      let fk = 1;
      for (const l of (full.lines || []) as SLine[]) {
        if (l.style_code && l.size) {
          let sec = byStyle.get(l.style_code);
          if (!sec) { sec = { styleCode: l.style_code, cells: [] }; byStyle.set(l.style_code, sec); }
          sec.cells.push({ color: l.color ?? null, size: l.size, inseam: l.inseam ?? null, qty: l.qty_ordered, lot: soLot }); // no unit cost; lot = customer PO
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
      notify(soLot
        ? `PO matrix prefilled from the sales order. Lots set to customer PO ${soLot} (editable per line).`
        : "PO matrix prefilled from the sales order. No customer PO on the SO — lots will default to the PO number at issue.", "success");
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

  // ── Split this PO across customer POs (lots) — Scenario 4 ───────────────────
  // Each line is divided evenly across the entered customer POs on a full-carton
  // basis; every split carries its customer PO as the lot. Persisted server-side,
  // then the matrix is reloaded to show the per-lot lines.
  async function applySplitByLot() {
    if (!po) return;
    const lots = [...new Set(splitLots.map((s) => s.trim()).filter(Boolean))];
    if (lots.length < 2) { notify("Add at least two customer PO numbers to split across.", "error"); return; }
    setSplitBusy(true);
    try {
      const r = await fetch(`/api/internal/purchase-orders/${po.id}/split-by-lot`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lots }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const full = await fetch(`/api/internal/purchase-orders/${po.id}`).then((rr) => rr.ok ? rr.json() : null).catch(() => null);
      if (full?.lines) { setSeed(poSeedFromLines(full.lines)); setSeedKey((k) => k + 1); }
      setSplitOpen(false); setSplitLots([]); setSplitInput("");
      notify(j.message || "PO lines split by customer PO.", "success");
    } catch (e) { notify(`Split failed: ${e instanceof Error ? e.message : String(e)}`, "error"); }
    finally { setSplitBusy(false); }
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

  // Item 15 — cancel date can't be earlier than the ship (window start) date.
  const cancelBeforeShip = !!(shipWindowStart && cancelDate && cancelDate < shipWindowStart);

  async function save(): Promise<string | null> {
    setErr(null);
    if (!vendorId) { setErr("Pick a vendor."); return null; }
    if (cancelBeforeShip) { setErr("Cancel date can't be earlier than the Ship window start date."); return null; }
    // Manufacturing-part PO: lines carry part_id (not a style SKU). Otherwise the
    // matrix body resolves every filled cell + flat line to a SKU; map its generic
    // unit_price_cents onto the PO's unit_cost_cents.
    let lines: Record<string, unknown>[];
    if (isPartPo) {
      const out: Record<string, unknown>[] = [];
      for (const l of partLines) {
        if (!l.part_id) continue;
        const unitCents = Math.round(parseFloat(l.unit || "0") * 100);
        if (l.is_matrix) {
          // Resolve each filled size cell to its per-size CHILD part → one line each.
          for (const sz of l.sizes || []) {
            const q = Number(l.sizeQty?.[sz] || 0);
            if (q <= 0) continue;
            const rr = await fetch("/api/internal/part-matrix/resolve-part-size", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ part_id: l.part_id, size: sz }) });
            if (!rr.ok) { setErr(`Could not resolve size ${sz}: ${(await rr.json().catch(() => ({}))).error || rr.status}`); return null; }
            const jj = await rr.json();
            out.push({ part_id: jj.id, qty_ordered: q, unit_cost_cents: unitCents });
          }
        } else if (Number(l.qty) > 0) {
          out.push({ part_id: l.part_id, qty_ordered: Number(l.qty), unit_cost_cents: unitCents });
        }
      }
      lines = out;
      if (lines.length === 0) { setErr("Add at least one part line with a quantity."); return null; }
    } else {
      const resolved = (await bodyRef.current?.resolve()) || [];
      lines = resolved.map((r) => ({ inventory_item_id: r.inventory_item_id, qty_ordered: r.qty_ordered, unit_cost_cents: r.unit_price_cents, requested_ship_date: r.requested_ship_date ?? null, vendor_confirmed_ship_date: r.vendor_confirmed_ship_date ?? null, lot_number: r.lot_number ?? null }));
      if (lines.length === 0) { setErr("Add at least one line with a quantity."); return null; }
    }
    const body: Record<string, unknown> = {
      vendor_id: vendorId, brand_id: brandId || null,
      order_date: orderDate, expected_date: expectedDate || null,
      payment_terms_id: paymentTermsId || null, notes: notes.trim() || null, lines,
      // Rich header
      po_type: poType || null, customer_id: customerId || null,
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
  // Manufacturing-part PO 3-way match — enter the vendor's bill after receiving.
  // Clears 2050 GR/IR; any difference vs. the received value goes to 6320 PPV.
  const [partBilled, setPartBilled] = useState(false);
  async function enterPartBill() {
    const v = await promptDialog("Vendor bill total for this part PO ($)", { inputType: "number", required: true, placeholder: "0.00" });
    if (v === null) return;
    const dollars = parseFloat(v);
    if (!Number.isFinite(dollars) || dollars < 0) { notify("Enter a non-negative amount", "error"); return; }
    const num = await promptDialog("Vendor invoice number (optional)", { defaultValue: "" });
    if (num === null) return;
    setSubmitting(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/purchase-orders/${po!.id}/part-bill`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ total_cents: Math.round(dollars * 100), invoice_number: num.trim() || undefined }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify(j.message || "Part vendor bill matched.", "success");
      setPartBilled(true); onSaved();
    } catch (e) { const m = e instanceof Error ? e.message : String(e); setErr(m); notify(m, "error"); }
    finally { setSubmitting(false); }
  }

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

  // Cancel a live PO — moves to 'cancelled' (kept for history) and releases its
  // open-PO commitments (server-side). Reversible via Reinstate below.
  async function cancelPo() {
    if (!po) return;
    const ok = await confirmDialog(
      "This purchase order will move to cancelled (kept for history). Its open-PO commitments are released; reinstate it later to restore them.",
      { confirmText: "Cancel PO", title: `Cancel ${po.po_number || "purchase order"}` },
    );
    if (!ok) return;
    setErr(null); setSubmitting(true);
    try {
      const r = await fetch(`/api/internal/purchase-orders/${po.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "cancelled" }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify(`Purchase order ${po.po_number || ""} cancelled.`, "success");
      onSaved();
    } catch (e) { notify(`Could not cancel: ${e instanceof Error ? e.message : String(e)}`, "error"); }
    finally { setSubmitting(false); }
  }

  // Reinstate a cancelled PO — status returns to 'issued' (keeps its PO #); the
  // server re-opens the commitments the cancel closed (P13 open-PO tracking).
  async function reinstatePo() {
    if (!po) return;
    const ok = await confirmDialog(
      "This purchase order's status will change back to issued and its open-PO commitments will be restored.",
      { confirmText: "Reinstate", title: `Reinstate ${po.po_number || "purchase order"}` },
    );
    if (!ok) return;
    setErr(null); setSubmitting(true);
    try {
      const r = await fetch(`/api/internal/purchase-orders/${po.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "issued" }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify(`Purchase order ${po.po_number || ""} reinstated — status is now issued.`, "success");
      onSaved();
    } catch (e) { notify(`Could not reinstate: ${e instanceof Error ? e.message : String(e)}`, "error"); }
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

  // Build the shared order-document model (logo + header + line items) that both
  // the printable PDF view and the .xlsx export render from, so the two never
  // diverge (same pattern as the Sales Order modal's buildOrderDoc).
  function buildPoDoc(): OrderDocument {
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
    return {
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
    };
  }

  // Open the printable PO document (View → PDF). autoPrint jumps straight to
  // the browser print / save-as-PDF dialog.
  function openView(autoPrint = false) { openOrderDocument({ ...buildPoDoc(), autoPrint }); }

  return (
    <div onClick={() => void requestClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(1180px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        {/* #6 — the status in the open PO carries the same color coding as the
            grid status chip (STATUS_COLORS), so the open view matches the list. */}
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {isNew ? "New purchase order" : (
            <>Purchase order {po?.po_number || "(draft)"} — <span style={{ color: STATUS_COLORS[po?.status || ""] || C.text, fontWeight: 700 }}>● {statusLabel(po?.status || "")}</span></>
          )}
        </h3>

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
              <SearchableSelect value={poType || null} onChange={(v) => setPoType(v)} disabled={!editable}
                options={[{ value: "", label: "(select)" }, ...([["stock", "Stock"], ["replenishment", "Replenishment"], ["made_to_order", "Made-to-order"], ["sample", "Sample"], ["drop_ship", "Drop-ship"], ["manufacturing_part", "Manufacturing part"]] as [string, string][]).map(([v, l]) => ({ value: v, label: l }))]}
                placeholder="(select)" inputStyle={inputStyle as React.CSSProperties} />
            </Field>
            <Field label="Customer">
              {/* Item 8 — pick a customer, or type a new name and click the "+ Add …"
                  typeahead row to create it on the fly (replaces the "+ New" button). */}
              <SearchableSelect value={customerId || null} onChange={(v) => setCustomerId(v || "")}
                options={[{ value: "", label: "(none)" }, ...customers.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.name} ${c.customer_code || ""}` }))]} placeholder="(none)" disabled={!editable}
                onAddNew={editable ? (q) => { setQuickAddInitialName(q.trim()); setQuickAddCustomer(true); } : undefined}
                addNewLabel={(q) => `+ Add customer "${q.trim()}"`} />
            </Field>
            <Field label="PO number / status">
              {/* #6 — read-only chip carrying the grid's status color so the open
                  PO matches the list. Rendered as a div (not an input) so the
                  status token can be colored. */}
              <div style={{ ...inputStyle, display: "flex", alignItems: "center", gap: 8, minHeight: 33 }}>
                <span>{po?.po_number || "(draft — assigned on issue)"}</span>
                {po?.status && (
                  <span style={{ color: STATUS_COLORS[po.status] || C.text, fontWeight: 600 }}>● {statusLabel(po.status)}</span>
                )}
                {po && <InTransitChip po={po as PO} />}
              </div>
            </Field>
          </div>
        </Section>

        {/* Vendor / supplier */}
        <Section title="Vendor / supplier">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <Field label="Vendor">
              {/* Item 1 — pick an existing vendor or add one on the fly (+ New). */}
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <SearchableSelect value={vendorId || null} onChange={(v) => setVendorId(v)}
                    options={vendors.map((v) => ({ value: v.id, label: v.name, searchHaystack: `${v.name} ${v.code || ""}` }))}
                    placeholder="(pick vendor…)" disabled={!editable} />
                </div>
                {editable && (
                  <button type="button" onClick={() => setQuickAddVendor(true)} title="Add a new vendor without leaving this PO"
                    style={{ ...btnSecondary, padding: "6px 10px", whiteSpace: "nowrap" }}>+ New</button>
                )}
              </div>
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
            <Field label="Cancel date">
              <input type="date" value={cancelDate} onChange={(e) => setCancelDate(e.target.value)} disabled={!editable} style={{ ...inputStyle, borderColor: cancelBeforeShip ? C.warn : C.cardBdr }} />
              {cancelBeforeShip && <div style={{ fontSize: 11, color: C.warn, marginTop: 4 }}>Cancel date is before the Ship window start.</div>}
            </Field>
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
              <SearchableSelect value={shipMethod || null} onChange={(v) => setShipMethod(v)} disabled={!editable}
                options={[{ value: "", label: "(select)" }, ...([["sea", "Sea"], ["air", "Air"], ["ground", "Ground"]] as [string, string][]).map(([v, l]) => ({ value: v, label: l }))]}
                placeholder="(select)" inputStyle={inputStyle as React.CSSProperties} />
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
            <button type="button" onClick={() => { setSoQuery(""); applyAwardAfterSO.current = false; setSoPickOpen(true); }} style={{ ...btnSecondary, color: C.primary, borderColor: C.primary }}>Create from Sales Order</button>
            <button type="button" onClick={() => {
              // If the matrix already has styles (from an SO or added manually),
              // price THOSE in place — no "from an SO?" prompt, no qty reset.
              const codes = bodyRef.current?.getStyleCodes() || [];
              if (codes.length) { setAwardInPlace(true); void openAwardDialog(codes); }
              else { setAwardInPlace(false); setPriceAskOpen(true); }
            }} style={{ ...btnSecondary, color: C.success, borderColor: "#065f46" }}>Get PO price</button>
            {salesOrderId && <span style={{ fontSize: 11, color: C.success }}>✓ linked to a sales order</span>}
          </div>
        )}

        {/* Scenario 4 — split an existing (pre-receiving) PO across customer POs. */}
        {!isNew && po && !["received", "cancelled"].includes(po.status) && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
            <button type="button" onClick={() => { setSplitLots([]); setSplitInput(""); setSplitOpen(true); }} style={{ ...btnSecondary, color: C.primary, borderColor: C.primary }}>Split by customer PO</button>
            <span style={{ fontSize: 11, color: C.textMuted }}>Divide each line evenly (full cartons) across multiple customer POs — each becomes its own lot.</span>
          </div>
        )}

        {/* Line body. A Manufacturing-part PO buys PARTS (non-matrix, P1) — a
            simple part / qty / unit-cost grid. Every other PO type uses the
            shared style size matrix (mode="po"). */}
        {isPartPo ? (
          <div style={{ marginTop: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Parts</div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={{ textAlign: "left", padding: "6px 8px", fontSize: 11, color: C.textMuted, borderBottom: `1px solid ${C.cardBdr}` }}>Part</th>
                <th style={{ textAlign: "right", padding: "6px 8px", fontSize: 11, color: C.textMuted, borderBottom: `1px solid ${C.cardBdr}`, width: 110 }}>Qty</th>
                <th style={{ textAlign: "right", padding: "6px 8px", fontSize: 11, color: C.textMuted, borderBottom: `1px solid ${C.cardBdr}`, width: 140 }}>Unit cost $</th>
                <th style={{ padding: "6px 8px", borderBottom: `1px solid ${C.cardBdr}`, width: 40 }} />
              </tr></thead>
              <tbody>
                {partLines.map((pl) => {
                  const matrixTotal = pl.is_matrix ? Object.values(pl.sizeQty || {}).reduce((s, v) => s + (Number(v) || 0), 0) : 0;
                  return (
                  <Fragment key={pl.key}>
                  <tr>
                    <td style={{ padding: "4px 8px", borderBottom: pl.is_matrix ? "none" : `1px solid ${C.cardBdr}` }}>
                      <SearchableSelect value={pl.part_id || null} disabled={!editable}
                        onChange={(v) => void pickPart(pl.key, v || "")}
                        options={parts.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}${p.is_matrix ? " · by size" : ""}` }))}
                        placeholder="Pick a part" inputStyle={inputStyle as React.CSSProperties} />
                    </td>
                    <td style={{ padding: "4px 8px", borderBottom: pl.is_matrix ? "none" : `1px solid ${C.cardBdr}`, textAlign: "right" }}>
                      {pl.is_matrix
                        ? <span style={{ fontSize: 12, color: C.textMuted }}>{matrixTotal} <span style={{ fontSize: 10 }}>by size ↓</span></span>
                        : <input value={pl.qty} disabled={!editable} inputMode="numeric" placeholder="0"
                            onChange={(e) => setPartLines((ls) => ls.map((x) => x.key === pl.key ? { ...x, qty: e.target.value } : x))}
                            style={{ ...(inputStyle as React.CSSProperties), textAlign: "right" }} />}
                    </td>
                    <td style={{ padding: "4px 8px", borderBottom: pl.is_matrix ? "none" : `1px solid ${C.cardBdr}` }}>
                      <input value={pl.unit} disabled={!editable} inputMode="decimal" placeholder="0.00"
                        onChange={(e) => setPartLines((ls) => ls.map((x) => x.key === pl.key ? { ...x, unit: e.target.value } : x))}
                        style={{ ...(inputStyle as React.CSSProperties), textAlign: "right" }} />
                    </td>
                    <td style={{ padding: "4px 8px", borderBottom: pl.is_matrix ? "none" : `1px solid ${C.cardBdr}`, textAlign: "center" }}>
                      {editable && partLines.length > 1 && <button type="button" title="Remove line" onClick={() => setPartLines((ls) => ls.filter((x) => x.key !== pl.key))} style={btnSecondary}>✕</button>}
                    </td>
                  </tr>
                  {pl.is_matrix && (
                    <tr>
                      <td colSpan={4} style={{ padding: "0 8px 8px 24px", borderBottom: `1px solid ${C.cardBdr}` }}>
                        {pl.sizes && pl.sizes.length > 0 ? (
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {pl.sizes.map((sz) => (
                              <label key={sz} style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 10, color: C.textMuted }}>
                                {sz}
                                <input value={pl.sizeQty?.[sz] ?? ""} disabled={!editable} inputMode="numeric" placeholder="0"
                                  onChange={(e) => setSizeQty(pl.key, sz, e.target.value)}
                                  style={{ ...(inputStyle as React.CSSProperties), width: 56, textAlign: "right", padding: "4px 6px" }} />
                              </label>
                            ))}
                          </div>
                        ) : <span style={{ fontSize: 11, color: C.warn }}>This matrix part has no sizes yet — assign a size scale in Part Master.</span>}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
            {editable && <button type="button" onClick={() => { const k = partKey.current++; setPartLines((ls) => [...ls, { key: k, part_id: "", qty: "", unit: "" }]); }} style={{ ...btnSecondary, marginTop: 8 }}>+ Add part line</button>}
          </div>
        ) : (
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
        )}

        {/* Audit trail — who changed which field, when (T11 row_changes). */}
        {!isNew && po && (
          <div style={{ marginTop: 16 }}>
            <RowHistory source_table="purchase_orders" source_id={po.id} />
          </div>
        )}

        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

        <div style={{ position: "sticky", bottom: -20, zIndex: 3, background: C.card, borderTop: `1px solid ${C.cardBdr}`, margin: "0 -20px -20px", padding: "12px 20px", display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
          <button onClick={() => void requestClose()} style={btnSecondary} disabled={submitting}>Close</button>
          {/* View → PDF / Excel dropdown. PDF is the existing printable document;
              Excel downloads the same PO via the shared downloadOrderExcel helper
              (branded ATS xlsx layout). App dark palette; caret ▾. */}
          <span style={{ position: "relative", display: "inline-flex" }}>
            <button type="button" onClick={() => setViewMenuOpen((o) => !o)} aria-haspopup="menu" aria-expanded={viewMenuOpen} style={btnSecondary} title="View this PO as a printable PDF or download it to Excel">View ▾</button>
            {viewMenuOpen && (
              <>
                <div onClick={() => setViewMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 90 }} />
                <div role="menu" style={{ position: "absolute", bottom: "100%", left: 0, marginBottom: 6, zIndex: 91, background: "#1E293B", border: "1px solid #334155", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.45)", minWidth: 180, overflow: "hidden" }}>
                  <button type="button" role="menuitem" onClick={() => { setViewMenuOpen(false); openView(true); }} style={viewMenuItem}>PDF</button>
                  <button type="button" role="menuitem" onClick={() => { setViewMenuOpen(false); void downloadOrderExcel(buildPoDoc()); }} style={{ ...viewMenuItem, borderBottom: 0 }}>Excel</button>
                </div>
              </>
            )}
          </span>

          {/* Draft / new — the original save + issue flow. */}
          {(isNew || po?.status === "draft") && <button onClick={() => void saveDraft()} style={btnSecondary} disabled={submitting}>{submitting ? "Saving…" : "Save draft"}</button>}
          {(isNew || po?.status === "draft") && <button onClick={() => void transition("issued")} style={btnPrimary} disabled={submitting}>{submitting ? "…" : "Issue"}</button>}

          {/* Saved PO, not editing — ✎ Edit unlocks a full revision + status moves. */}
          {isRevisable && !editMode && <button onClick={() => setEditMode(true)} style={btnPrimary} disabled={submitting}>✎ Edit</button>}
          {/* Shipments (in-transit overlay) — a PO can carry one or more shipments
              (carrier / ETA / per-line qty on the way) ON TOP of its lifecycle
              status, so it reads "issued · in transit" / "partially received ·
              in transit". Buyer-entered here; a vendor ASN sets them later. */}
          {isRevisable && !editMode && po?.id && <button onClick={() => setShipmentsOpen(true)} style={{ ...btnSecondary, color: C.warn, borderColor: "#92400e" }} disabled={submitting} title="Record shipments in transit (carrier, ETA, per-line quantities on the way)">🚚 Shipments…</button>}
          {/* "Received" is no longer a manual flip — it's set when a goods receipt
              is POSTED (FIFO layers + GR/IR JE). 📥 Receive opens Receiving for this PO. */}
          {isRevisable && !editMode && (po?.status === "issued" || po?.status === "partially_received" || po?.status === "in_transit") && po?.id && (
            <button onClick={() => window.open(`?m=receiving&po=${encodeURIComponent(po.id)}`, "_blank", "noopener")} style={{ ...btnSecondary, color: C.success, borderColor: "#065f46" }} disabled={submitting} title="Open Receiving to record a goods receipt (posts inventory + GR/IR) — that's what marks the PO received">Receive…</button>
          )}
          {/* Manufacturing-part PO — enter the vendor's bill (3-way match) once the
              parts have been received. Clears 2050 GR/IR; variance → 6320 PPV. */}
          {isPartPo && !editMode && po?.id && (po?.status === "received" || po?.status === "partially_received" || po?.status === "in_transit") && !partBilled && (
            <button onClick={() => void enterPartBill()} style={{ ...btnSecondary, color: C.primary, borderColor: C.primary }} disabled={submitting} title="Enter the vendor's AP bill for this part PO and 3-way match it (clears GR/IR)">Enter part bill (3-way match)</button>
          )}
          {isPartPo && partBilled && <span style={{ fontSize: 12, color: C.success, alignSelf: "center" }}>✓ part bill matched</span>}
          {/* Cancel a live (issued / in-transit) PO — kept for history, releases
              its open-PO commitments; reversible via Reinstate. */}
          {isRevisable && !editMode && (po?.status === "issued" || po?.status === "partially_received" || po?.status === "in_transit") && (
            <button onClick={() => void cancelPo()} style={{ ...btnSecondary, color: C.danger, borderColor: "#7f1d1d" }} disabled={submitting} title="Cancel this purchase order (moves to cancelled, kept for history)">Cancel PO</button>
          )}
          {/* Reinstate a cancelled PO — status returns to issued (keeps its PO #). */}
          {!isNew && po != null && po.status === "cancelled" && !editMode && (
            <button onClick={() => void reinstatePo()} style={{ ...btnSecondary, color: C.success, borderColor: "#065f46" }} disabled={submitting} title="Reinstate this cancelled purchase order — its status returns to issued">Reinstate</button>
          )}

          {/* Revising a saved PO — save the revision (notifies the vendor) or cancel. */}
          {isRevisable && editMode && <button onClick={() => setEditMode(false)} style={btnSecondary} disabled={submitting}>Cancel edit</button>}
          {isRevisable && editMode && <button onClick={() => void saveDraft()} style={btnPrimary} disabled={submitting}>{submitting ? "Saving…" : "Save revision"}</button>}
        </div>
      </div>

      {/* In-transit overlay editor — shipments (carrier / ETA / per-line qty). */}
      {shipmentsOpen && po?.id && (
        <ShipmentsModal poId={po.id} poNumber={po.po_number} onClose={() => setShipmentsOpen(false)} onChanged={onSaved} />
      )}

      {/* Item 1 — on-the-fly "+ New vendor / + New customer" popups. */}
      {quickAddVendor && (
        <QuickAddPartyModal
          kind="vendor"
          onClose={() => setQuickAddVendor(false)}
          onCreated={(row) => {
            const v = row as unknown as Vendor;
            setExtraVendors((prev) => [v, ...prev]);
            setVendorId(v.id);
            if (typeof row.contact === "string" && row.contact && !vendorContact) setVendorContact(row.contact);
            if (typeof row.email === "string" && row.email && !vendorEmail) setVendorEmail(row.email);
            setQuickAddVendor(false);
            notify(`Vendor "${v.name}" added.`, "success");
          }}
        />
      )}
      {quickAddCustomer && (
        <QuickAddPartyModal
          kind="customer"
          initialName={quickAddInitialName}
          onClose={() => { setQuickAddCustomer(false); setQuickAddInitialName(""); }}
          onCreated={(row) => {
            const c = { id: String(row.id), name: String(row.name), customer_code: typeof row.customer_code === "string" ? row.customer_code : undefined };
            setCustomers((prev) => [c, ...prev]);
            setCustomerId(c.id);
            setQuickAddCustomer(false);
            setQuickAddInitialName("");
            notify(`Customer "${c.name}" added — finish its full record from the reminder in your notifications.`, "success");
            void notifyCompleteParty("customer", c);
          }}
        />
      )}

      {/* Create-from-SO picker (dynamic search). */}
      {soPickOpen && (
        <div onClick={(e) => { e.stopPropagation(); if (!soBusy) setSoPickOpen(false); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(640px, 95vw)", maxHeight: "85vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>Create PO from a Sales Order</h3>
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
                    {so.customer_po && <span style={{ color: C.primary, marginLeft: 8 }} title="This customer PO becomes the lot on the new PO's lines">PO {so.customer_po}</span>}
                  </span>
                  <span style={{ fontSize: 12, color: C.textMuted }}>{so.status}{so.fulfillment_source ? ` · ${so.fulfillment_source}` : ""}{so.requested_ship_date ? ` · ship ${fmtDateDisplay(so.requested_ship_date)}` : ""}</span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
              <button onClick={() => setSoPickOpen(false)} style={btnSecondary} disabled={soBusy}>{soBusy ? "Loading…" : "Cancel"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Scenario 4 — split this PO across customer POs (lots). */}
      {splitOpen && (
        <div onClick={(e) => { e.stopPropagation(); if (!splitBusy) setSplitOpen(false); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 121 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(520px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>Split by customer PO</h3>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>
              Enter the customer PO numbers this PO covers. Each line is divided evenly across them on a full-carton basis, and every split carries its customer PO as the lot. Replaces the PO's current lines.
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <input type="text" value={splitInput} onChange={(e) => setSplitInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); const v = splitInput.trim(); if (v && !splitLots.includes(v)) setSplitLots((p) => [...p, v]); setSplitInput(""); } }}
                placeholder="customer PO number — Enter to add" style={{ ...inputStyle, flex: 1 }} />
              <button type="button" onClick={() => { const v = splitInput.trim(); if (v && !splitLots.includes(v)) setSplitLots((p) => [...p, v]); setSplitInput(""); }} style={btnSecondary}>Add</button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14, minHeight: 28 }}>
              {splitLots.length === 0 && <span style={{ fontSize: 12, color: C.textMuted }}>No customer POs added yet (need at least two).</span>}
              {splitLots.map((lot) => (
                <span key={lot} style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "100%", background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 14, padding: "2px 8px", fontSize: 11, lineHeight: 1.3 }}>
                  {/* #2 — smaller font + word-break so long customer-PO lot
                      numbers stay inside the bubble instead of overflowing it. */}
                  <span style={{ overflowWrap: "anywhere", wordBreak: "break-all" }}>{lot}</span>
                  <button type="button" onClick={() => setSplitLots((p) => p.filter((x) => x !== lot))} style={{ background: "transparent", border: "none", color: C.danger, cursor: "pointer", fontSize: 12, lineHeight: 1, flexShrink: 0 }} title="Remove">✕</button>
                </span>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setSplitOpen(false)} style={btnSecondary} disabled={splitBusy}>Cancel</button>
              <button onClick={() => void applySplitByLot()} style={btnPrimary} disabled={splitBusy || splitLots.length < 2}>{splitBusy ? "Splitting…" : `Split across ${splitLots.length || 0} lot(s)`}</button>
            </div>
          </div>
        </div>
      )}

      {/* Get-PO-price: is this PO from an SO? */}
      {priceAskOpen && (
        <div onClick={(e) => { e.stopPropagation(); setPriceAskOpen(false); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 121 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(440px, 95vw)", color: C.text }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>Get PO price</h3>
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
            <h3 style={{ margin: "0 0 6px", fontSize: 16 }}>Awarded RFQ prices — review</h3>
            {awardMissing.length > 0 && (
              <div style={{ padding: "8px 12px", background: "#3b2f0b", border: `1px solid ${C.warn}`, borderRadius: 6, color: C.warn, fontSize: 12, marginBottom: 12 }}>
                No awarded RFQ price for {awardMissing.length === 1 ? "this style" : "these styles"}: <strong>{awardMissing.join(", ")}</strong>. {awardQuotes.length === 0 ? "Nothing was priced from an award — set unit costs manually." : "Those styles are left unpriced; the rest are below."}
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
