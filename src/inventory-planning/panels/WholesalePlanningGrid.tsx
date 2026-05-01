// The main workbench table. Columns listed here are intentionally wide
// so planners can scan a row end-to-end without scrolling. Click a row to
// open the detail drawer.

import { useEffect, useMemo, useRef, useState } from "react";
import type { IpPlanningGridRow } from "../types/wholesale";
import { S, PAL, ACTION_COLOR, CONFIDENCE_COLOR, METHOD_COLOR, METHOD_LABEL, formatQty, formatPeriodCode } from "../components/styles";
import { MultiSelectDropdown } from "../components/MultiSelectDropdown";
import { applyRollingPool } from "../compute/supply";
import { aggregateRows, type CollapseModes as ExtractedCollapseModes } from "./aggregateGridRows";
import { bucketKeyFor, type BucketKeyFilters } from "./bucketBuyKey";
import { recommendForRow } from "../compute/recommendations";

export interface WholesalePlanningGridProps {
  rows: IpPlanningGridRow[];
  onSelectRow: (row: IpPlanningGridRow) => void;
  onUpdateBuyQty: (forecastId: string, qty: number | null) => Promise<void>;
  // Save bucket-level buy for an aggregate row. The grid computes
  // the bucket_key from the active collapse mode + filters + the
  // row's dimensions and passes the full descriptor — the workbench
  // just upserts.
  onUpdateBucketBuy: (descriptor: {
    bucket_key: string;
    qty: number | null;
    collapse_mode: string;
    customer_id: string | null;
    group_name: string | null;
    sub_category_name: string | null;
    gender: string | null;
    period_code: string;
  }) => Promise<void>;
  // Map of bucket_key → qty, populated by the workbench from the
  // listBucketBuys repo call. The grid overlays these onto aggregate
  // rows' planned_buy_qty for display.
  bucketBuys?: Map<string, number>;
  onUpdateUnitCost: (forecastId: string, cost: number | null) => Promise<void>;
  onUpdateBuyerRequest: (forecastId: string, qty: number) => Promise<void>;
  onUpdateOverride: (forecastId: string, qty: number) => Promise<void>;
  // Direct edit of System forecast qty. Pass null to revert to the
  // computed suggestion. Stamps user + timestamp server-side for the
  // cell tooltip.
  onUpdateSystemOverride: (forecastId: string, qty: number | null) => Promise<void>;
  // Reports the current filter set up to the workbench so a "Build
  // (filtered)" Build can scope itself to the visible subset. Called
  // every time the planner changes a filter dropdown.
  onFiltersChange?: (filters: {
    customer_id: string | null;
    group_name: string | null;
    sub_category_name: string | null;
    gender: string | null;
  }) => void;
  loading?: boolean;
  // Optional render slot inserted directly above the filter/search
  // toolbar. Used to host PlanningRunControls so the Build button
  // sits adjacent to the search bar without restructuring the
  // workbench layout.
  headerSlot?: React.ReactNode;
  // Lifted from the grid so MonthlyTotalsCards can apply the same
  // muting math. Owned by WholesalePlanningWorkbench; this component
  // only reads the value and reports user-flips via the setter.
  systemSuggestionsOn: boolean;
  onSystemSuggestionsChange: (v: boolean) => void;
  // Emits the current filter+mute scoped row set up to the workbench
  // so MonthlyTotalsCards uses the same subset the grid does. Without
  // this, the top FINAL FORECAST card showed the whole run while the
  // grid showed only the user's filtered slice.
  onScopeChange?: (rows: IpPlanningGridRow[]) => void;
}

// Every column is sortable via header click. Click toggles asc/desc on
// the same key; clicking a different column resets to asc.
type SortKey =
  | "category" | "subCat" | "style" | "color" | "description" | "customer"
  | "period" | "histT3" | "histLY" | "system" | "buyer" | "override" | "final"
  | "confidence" | "method" | "onHand" | "onSo" | "receipts" | "histRecv" | "ats"
  | "buy" | "avgCost" | "unitCost" | "buyDollars" | "shortage" | "excess" | "action";

// Re-export of the type now defined alongside the aggregate logic
// in ./aggregateGridRows.ts. Kept as a local alias so existing
// references (CollapseModes) compile without churn.
type CollapseModes = ExtractedCollapseModes;

export default function WholesalePlanningGrid({ rows, onSelectRow, onUpdateBuyQty, onUpdateBucketBuy, onUpdateUnitCost, onUpdateBuyerRequest, onUpdateOverride, onUpdateSystemOverride, onFiltersChange, headerSlot, bucketBuys, loading, systemSuggestionsOn, onSystemSuggestionsChange, onScopeChange }: WholesalePlanningGridProps) {
  const [search, setSearch] = useState("");
  // Multi-select filters — empty array = no filter (all rows pass).
  // Each non-empty array narrows to rows whose value is in the set.
  const [filterCustomer, setFilterCustomer] = useState<string[]>([]);
  const [filterCategory, setFilterCategory] = useState<string[]>([]);
  const [filterSubCat, setFilterSubCat] = useState<string[]>([]);
  const [filterGender, setFilterGender] = useState<string[]>([]);
  const [filterAction, setFilterAction] = useState<string[]>([]);
  const [filterConfidence, setFilterConfidence] = useState<string[]>([]);
  // Master toggle — owned by the workbench. When OFF, system forecast
  // suggestions are blanked out so the planner drives demand purely
  // through Buyer / Override edits.
  const setSystemSuggestionsOnPersistent = onSystemSuggestionsChange;
  const [filterMethod, setFilterMethod] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("period");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filterPeriod, setFilterPeriod] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(500);
  // Collapse / aggregation modes — independent toggles that change the
  // grouping key of the displayed rows. When any are on, grids show
  // aggregate rows and inline editing is disabled on those rows.
  const [collapse, setCollapse] = useState<CollapseModes>({
    customers: false, colors: false, category: false, subCat: false,
    customerAllStyles: false, allCustomersPerCategory: false, allCustomersPerSubCat: false,
  });
  const anyCollapsed =
    collapse.customers || collapse.colors || collapse.category || collapse.subCat ||
    collapse.customerAllStyles || collapse.allCustomersPerCategory || collapse.allCustomersPerSubCat;
  // Reset to first page whenever filters/sort change so the user doesn't
  // wonder why an empty page is showing.
  useEffect(() => { setPage(0); }, [search, filterCustomer, filterCategory, filterSubCat, filterGender, filterPeriod, filterAction, filterConfidence, filterMethod, sortKey, sortDir, pageSize, collapse, systemSuggestionsOn]);

  // Report active build-relevant filters up to the workbench so the
  // PlanningRunControls' Build button can scope itself to this subset.
  // Only the filters that map to the build pipeline are emitted —
  // customer, category (group_name), sub-cat, gender. The rest
  // (action / confidence / method / search) are display-only.
  useEffect(() => {
    if (!onFiltersChange) return;
    onFiltersChange({
      // Build flow only supports a single value per dim. When the
      // planner has multi-selected, send the first (or null when none).
      customer_id: filterCustomer[0] ?? null,
      group_name: filterCategory[0] ?? null,
      sub_category_name: filterSubCat[0] ?? null,
      gender: filterGender[0] ?? null,
    });
  }, [filterCustomer, filterCategory, filterSubCat, filterGender, onFiltersChange]);

  const customers = useMemo(() => {
    const s = new Map<string, string>();
    for (const r of rows) s.set(r.customer_id, r.customer_name);
    return Array.from(s, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  // Categories are now sourced from the item master GroupName attribute
  // (text, no FK), so the filter operates on the string directly.
  const groupNames = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.group_name) s.add(r.group_name);
    return Array.from(s).sort();
  }, [rows]);

  // Sub cat options are scoped to the selected Category — picking
  // "Joggers" in the Category dropdown narrows the Sub Cat list to
  // only the sub cats found under Joggers. When no category is chosen,
  // every sub cat is offered.
  const subCategoryNames = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) {
      if (filterCategory.length > 0 && !filterCategory.includes(r.group_name ?? "—")) continue;
      if (r.sub_category_name) s.add(r.sub_category_name);
    }
    return Array.from(s).sort();
  }, [rows, filterCategory]);

  // When category changes and the current sub cat selection is no
  // longer valid in the new scope, clear it so the user doesn't see
  // an empty grid because of a stale filter.
  useEffect(() => {
    // Drop any selected sub cats that no longer exist under the
    // current category set.
    if (filterSubCat.length > 0) {
      const stillValid = filterSubCat.filter((s) => subCategoryNames.includes(s));
      if (stillValid.length !== filterSubCat.length) setFilterSubCat(stillValid);
    }
  }, [filterCategory, subCategoryNames, filterSubCat]);

  // Gender values pulled from item-master attributes (Xoro export's
  // GenderCode column). No grid column is rendered — gender is purely
  // a filter dimension. Empty/null gender SKUs land under "—".
  const genders = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) {
      const g = (r.gender ?? "").trim();
      if (g) s.add(g);
    }
    return Array.from(s).sort();
  }, [rows]);

  // Friendly labels for the dropdown — Xoro's GenderCode column stores
  // single-letter codes (M, C, B, WMS, G). Filtering still uses the raw
  // code as the option value so existing filter wiring is unchanged.
  const GENDER_LABELS: Record<string, string> = {
    M: "Mens",
    C: "Child",
    B: "Boys",
    WMS: "Womens",
    G: "Girls",
  };
  const genderLabel = (code: string): string => GENDER_LABELS[code] ?? code;

  // Column visibility — every column except the small lock set
  // EVERY column is toggleable. Persisted to localStorage so refresh
  // keeps the planner's preference.
  const TOGGLEABLE_COLUMNS: Array<{ key: string; label: string }> = [
    { key: "category", label: "Category" },
    { key: "subCat", label: "Sub Cat" },
    { key: "style", label: "Style" },
    { key: "color", label: "Color" },
    { key: "description", label: "Description" },
    { key: "customer", label: "Customer" },
    { key: "period", label: "Period" },
    { key: "histT3", label: "Hist T3" },
    { key: "histLY", label: "Hist LY" },
    { key: "system", label: "System" },
    { key: "buyer", label: "Buyer" },
    { key: "override", label: "Override" },
    { key: "final", label: "Final" },
    { key: "confidence", label: "Conf." },
    { key: "method", label: "Method" },
    { key: "onHand", label: "On hand" },
    { key: "onSo", label: "On SO" },
    { key: "receipts", label: "Receipts" },
    { key: "histRecv", label: "Hist Recv" },
    { key: "ats", label: "ATS" },
    { key: "buy", label: "Buy" },
    { key: "avgCost", label: "Avg Cost" },
    { key: "unitCost", label: "Unit Cost" },
    { key: "buyDollars", label: "Buy $" },
    { key: "shortage", label: "Short" },
    { key: "excess", label: "Excess" },
    { key: "action", label: "Action" },
  ];
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("ws_planning_hidden_columns");
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr : []);
    } catch { return new Set(); }
  });
  function toggleColumn(key: string) {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem("ws_planning_hidden_columns", JSON.stringify(Array.from(next))); }
      catch { /* ignore quota */ }
      return next;
    });
  }
  function resetColumns() {
    setHiddenColumns(new Set());
    try { localStorage.removeItem("ws_planning_hidden_columns"); } catch { /* ignore */ }
  }
  const colHide = (key: string): React.CSSProperties | undefined =>
    hiddenColumns.has(key) ? { display: "none" } : undefined;

  const periods = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) s.add(r.period_code);
    return Array.from(s).sort();
  }, [rows]);

  // Pre-pack multiplier from the color field. A SKU coded with
  // "PPK24" in the color column ships as 24 units per pre-pack, so
  // raw inventory/PO/SO qtys (which Xoro reports in PACKS) need to
  // be multiplied by the pack size to display in actual selling
  // units. Color "BLUE" or anything without "PPK<n>" → multiplier 1.
  function ppkMultiplier(color: string | null | undefined): number {
    if (!color) return 1;
    const m = color.match(/PPK(\d+)/i);
    if (!m) return 1;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  // Step 1: filter + mute (post-user-filters, post-system-suggestions toggle,
  // pre-aggregate, pre-roll). This is the canonical "rows in scope" set
  // used by per-row math, totals, and MonthlyTotalsCards.
  const mutedRows = useMemo(() => {
    const q = search.trim().toUpperCase();
    // Pre-compute Sets for O(1) membership checks. Without this, 30k
    // rows × 8 filters × dozens of selected values per filter became
    // a million+ array.includes scans per render.
    const setCustomer = filterCustomer.length > 0 ? new Set(filterCustomer) : null;
    const setCategory = filterCategory.length > 0 ? new Set(filterCategory) : null;
    const setSubCat = filterSubCat.length > 0 ? new Set(filterSubCat) : null;
    const setGender = filterGender.length > 0 ? new Set(filterGender) : null;
    const setPeriod = filterPeriod.length > 0 ? new Set(filterPeriod) : null;
    const setAction = filterAction.length > 0 ? new Set(filterAction) : null;
    const setConfidence = filterConfidence.length > 0 ? new Set(filterConfidence) : null;
    const setMethod = filterMethod.length > 0 ? new Set(filterMethod) : null;
    const base = rows.filter((r) => {
      if (setCustomer && !setCustomer.has(r.customer_id)) return false;
      if (setCategory && !setCategory.has(r.group_name ?? "—")) return false;
      if (setSubCat && !setSubCat.has(r.sub_category_name ?? "—")) return false;
      if (setGender && !setGender.has(r.gender ?? "—")) return false;
      if (setPeriod && !setPeriod.has(r.period_code)) return false;
      if (setAction && !setAction.has(r.recommended_action)) return false;
      if (setConfidence && !setConfidence.has(r.confidence_level)) return false;
      if (setMethod && !setMethod.has(r.forecast_method)) return false;
      if (q && !(
        r.sku_code.includes(q)
        || (r.sku_style ?? "").toUpperCase().includes(q)
        || (r.sku_color ?? "").toUpperCase().includes(q)
        || r.customer_name.toUpperCase().includes(q)
        || (r.group_name ?? "").toUpperCase().includes(q)
        || (r.sub_category_name ?? "").toUpperCase().includes(q)
      )) return false;
      return true;
    });
    // PPK pre-pack expansion. Xoro reports inventory / PO / SO qtys
    // in PACKS for SKUs whose color is coded "PPKn" (e.g. PPK24 means
    // each pack ships 24 units). Multiply the supply-side qtys here
    // so on_hand / on_so / receipts / ATS all display in actual
    // selling units. Costs come in as pack cost from the master, so
    // divide them by n to get per-unit cost. Demand fields (forecast
    // / buyer / override) and planned_buy_qty are entered in selling
    // units already and stay unchanged.
    const expanded = base.map((r) => {
      const mult = ppkMultiplier(r.sku_color);
      if (mult === 1) return r;
      const divCost = (c: number | null | undefined): number | null => {
        if (c == null) return c ?? null;
        return c / mult;
      };
      // unit_cost may be a planner-entered override (already in unit
      // terms) OR derived from the master's pack-cost. Only divide
      // when there's no override — preserves overrides as-is.
      const unit_cost = r.unit_cost_override != null
        ? r.unit_cost
        : divCost(r.unit_cost);
      return {
        ...r,
        on_hand_qty: r.on_hand_qty == null ? r.on_hand_qty : r.on_hand_qty * mult,
        on_so_qty: r.on_so_qty * mult,
        on_po_qty: r.on_po_qty == null ? r.on_po_qty : r.on_po_qty * mult,
        receipts_due_qty: r.receipts_due_qty == null ? r.receipts_due_qty : r.receipts_due_qty * mult,
        historical_receipts_qty: r.historical_receipts_qty == null ? r.historical_receipts_qty : r.historical_receipts_qty * mult,
        available_supply_qty: r.available_supply_qty * mult,
        avg_cost: divCost(r.avg_cost),
        ats_avg_cost: divCost(r.ats_avg_cost),
        item_cost: divCost(r.item_cost),
        unit_cost,
      };
    });
    return systemSuggestionsOn ? expanded : expanded.map((r) => ({
      ...r,
      system_forecast_qty: 0,
      final_forecast_qty: Math.max(0, 0 + r.buyer_request_qty + r.override_qty),
    }));
  }, [rows, search, filterCustomer, filterCategory, filterSubCat, filterGender, filterPeriod, filterAction, filterConfidence, filterMethod, systemSuggestionsOn]);

  // Notify the workbench when the visible (filter+mute) row set changes
  // so MonthlyTotalsCards uses the same subset (drives the top FINAL
  // FORECAST card to match the grid's Σ Final).
  useEffect(() => {
    if (onScopeChange) onScopeChange(mutedRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutedRows]);

  // Step 2: per-(sku, period) display values using a proper per-SKU
  // multi-period rolling pool that subtracts demand each period (same
  // model as buildRollingWholesaleSupply on the backend). The display-
  // layer applyRollingPool only subtracts on_so, so its pool grows
  // unboundedly — that's why on_hand / ATS / excess all looked like
  // 1.2M everywhere. This map is the single source of truth for the
  // grid's per-row displayed on_hand, ATS, excess, shortage, and for
  // the Σ totals.
  const skuPeriodMath = useMemo(() => {
    type Agg = { receipts: number; onSo: number; buy: number; demand: number };
    const skuOnHand = new Map<string, number>();
    const bySkuPeriod = new Map<string, Map<string, Agg>>();
    for (const r of mutedRows) {
      if (!skuOnHand.has(r.sku_id)) skuOnHand.set(r.sku_id, r.on_hand_qty ?? 0);
      let perPeriod = bySkuPeriod.get(r.sku_id);
      if (!perPeriod) { perPeriod = new Map(); bySkuPeriod.set(r.sku_id, perPeriod); }
      let agg = perPeriod.get(r.period_start);
      if (!agg) {
        agg = { receipts: r.receipts_due_qty ?? 0, onSo: 0, buy: 0, demand: 0 };
        perPeriod.set(r.period_start, agg);
      }
      agg.onSo += r.on_so_qty;
      agg.buy += r.planned_buy_qty ?? 0;
      agg.demand += r.final_forecast_qty;
    }
    const out = new Map<string, { onHand: number; ats: number; excess: number; shortage: number }>();
    for (const [skuId, perPeriod] of bySkuPeriod) {
      const periods = Array.from(perPeriod.entries()).sort((a, b) => a[0].localeCompare(b[0]));
      let pool = skuOnHand.get(skuId) ?? 0;
      for (const [periodStart, agg] of periods) {
        const onHand = pool;                                  // beginning balance
        const ats = pool + agg.receipts + agg.buy;            // available to sell
        const demand = agg.demand;
        const excess = ats > demand ? ats - demand : 0;
        const shortage = demand > ats ? demand - ats : 0;
        out.set(`${skuId}:${periodStart}`, { onHand, ats, excess, shortage });
        pool = Math.max(0, ats - demand - agg.onSo);
      }
    }
    return out;
  }, [mutedRows]);

  const filtered = useMemo(() => {
    const muted = mutedRows;
    // Total pool = sum of unique-sku raw on_hand across the visible
    // (pre-aggregation) set.
    const seenSku = new Set<string>();
    let totalPool = 0;
    for (const r of muted) {
      if (seenSku.has(r.sku_id)) continue;
      seenSku.add(r.sku_id);
      totalPool += r.on_hand_qty ?? 0;
    }
    const collapsed = anyCollapsed ? aggregateRows(muted, collapse) : muted;
    const sorted = collapsed.sort((a, b) => cmp(a, b, sortKey, sortDir));
    // Top-down rolling pool: per-row ATS = on_hand − on_so + receipts +
    // buy; the next row inherits this row's ATS as its on_hand. Receipts
    // and buy contribute once per (sku, period) so multi-customer rows
    // of the same SKU don't double-count. on_so depletes per row since
    // it's customer-scoped.
    const rolled = applyRollingPool(
      sorted.map((r) => ({
        on_so_qty: r.on_so_qty,
        receipts_due_qty: r.receipts_due_qty ?? 0,
        planned_buy_qty: r.planned_buy_qty ?? 0,
        // Demand is consumed when rolling forward — the displayed ATS
        // doesn't subtract it, but the next row's on_hand reflects
        // post-demand leftover. Without this, the pool snowballs as
        // receipts pile up and Apr→May→Jun on_hand grows unboundedly.
        final_forecast_qty: r.final_forecast_qty,
        dedupeKey: `${r.sku_id}:${r.period_start}`,
      })),
      totalPool,
    );
    const asOf = new Date().toISOString().slice(0, 10);
    return sorted.map((r, i) => {
      const onHand = rolled[i].on_hand_qty;
      const ats = rolled[i].available_supply_qty;
      // Excess / Shortage stay sourced from the per-(sku, period)
      // rolling-pool map (bounded by real demand mismatch, not by the
      // visual top-down accumulation).
      const grainKey = `${r.sku_id}:${r.period_start}`;
      const m = skuPeriodMath.get(grainKey) ?? { onHand: 0, ats: 0, excess: 0, shortage: 0 };
      const liveRec = recommendForRow(
        { final_forecast_qty: r.final_forecast_qty, period_start: r.period_start, period_end: r.period_end },
        { on_hand_qty: onHand, beginning_balance_qty: onHand, on_po_qty: r.on_po_qty ?? 0, receipts_due_qty: r.receipts_due_qty ?? 0, available_supply_qty: ats },
        asOf,
      );
      return {
        ...r,
        on_hand_qty: onHand,
        available_supply_qty: ats,
        projected_shortage_qty: m.shortage,
        projected_excess_qty: m.excess,
        recommended_action: liveRec.recommended_action,
        recommended_qty: liveRec.recommended_qty,
        action_reason: liveRec.action_reason,
      };
    });
  }, [mutedRows, skuPeriodMath, sortKey, sortDir, collapse, anyCollapsed]);

  const totals = useMemo(() => {
    const t = { final: 0, shortage: 0, excess: 0, actions: {} as Record<string, number>, methods: {} as Record<string, number> };
    for (const r of mutedRows) {
      t.final += r.final_forecast_qty;
      t.actions[r.recommended_action] = (t.actions[r.recommended_action] ?? 0) + 1;
      t.methods[r.forecast_method] = (t.methods[r.forecast_method] ?? 0) + 1;
    }
    // Σ Excess / Σ Shortage = sum across unique (sku, period) grains
    // from the pre-computed rolling-pool map. Single source of truth
    // shared with per-row display.
    for (const { excess, shortage } of skuPeriodMath.values()) {
      t.excess += excess;
      t.shortage += shortage;
    }
    return t;
  }, [mutedRows, skuPeriodMath]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  return (
    <div>
      {/* Stats row */}
      <div style={{ ...S.statsRow, gridTemplateColumns: "repeat(6,1fr)" }}>
        <StatCell label="Rows" value={filtered.length > pageSize ? `${pageSize.toLocaleString()} / ${filtered.length.toLocaleString()}` : filtered.length.toLocaleString()} accent={filtered.length > pageSize ? PAL.yellow : undefined} />
        <StatCell label="Σ Final forecast" value={formatQty(totals.final)} accent={PAL.green} />
        <StatCell label="Σ Shortage" value={formatQty(totals.shortage)} accent={PAL.red} />
        <StatCell label="Σ Excess" value={formatQty(totals.excess)} accent={PAL.yellow} />
        <StatCell label="Buy / Expedite"
                  value={`${totals.actions.buy ?? 0} / ${totals.actions.expedite ?? 0}`}
                  accent={PAL.accent} />
        <StatCell label="Same Period LY rows"
                  value={(totals.methods.ly_sales ?? 0).toLocaleString()}
                  accent={PAL.accent2} />
      </div>

      {headerSlot}

      <div style={S.toolbar}>
        <input style={{ ...S.input, width: 240 }} placeholder="Search customer / SKU / category"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        <MultiSelectDropdown
          selected={filterCustomer}
          onChange={setFilterCustomer}
          allLabel="All customers"
          placeholder="Search customers…"
          options={customers.map((c) => ({ value: c.id, label: c.name }))}
        />
        <MultiSelectDropdown
          selected={filterCategory}
          onChange={setFilterCategory}
          allLabel="All categories"
          placeholder="Search categories…"
          options={groupNames.map((g) => ({ value: g, label: g }))}
        />
        <MultiSelectDropdown
          selected={filterSubCat}
          onChange={setFilterSubCat}
          allLabel="All sub cats"
          placeholder="Search sub cats…"
          options={subCategoryNames.map((s) => ({ value: s, label: s }))}
        />
        <MultiSelectDropdown
          selected={filterGender}
          onChange={setFilterGender}
          allLabel="All genders"
          placeholder="Search genders…"
          options={genders.map((g) => ({ value: g, label: genderLabel(g) }))}
          title="Gender filter — sourced from item-master GenderCode. No grid column rendered."
        />
        <MultiSelectDropdown
          selected={filterAction}
          onChange={setFilterAction}
          allLabel="All actions"
          placeholder="Search actions…"
          options={["buy", "expedite", "reduce", "hold", "monitor"].map((a) => ({ value: a, label: a }))}
        />
        <MultiSelectDropdown
          selected={filterConfidence}
          onChange={setFilterConfidence}
          allLabel="All confidence"
          placeholder="Search confidence…"
          options={["committed", "probable", "possible", "estimate"].map((c) => ({ value: c, label: c }))}
        />
        <MultiSelectDropdown
          selected={filterMethod}
          onChange={setFilterMethod}
          allLabel="All methods"
          placeholder="Search methods…"
          options={Object.keys(METHOD_LABEL).map((m) => ({ value: m, label: METHOD_LABEL[m] }))}
        />
        <MultiSelectDropdown
          selected={filterPeriod}
          onChange={setFilterPeriod}
          allLabel="All periods"
          placeholder="Search periods…"
          options={periods.map((p) => ({ value: p, label: formatPeriodCode(p) }))}
        />
        <button style={S.btnSecondary} onClick={() => {
          setSearch("");
          setFilterCustomer([]); setFilterCategory([]); setFilterSubCat([]); setFilterGender([]); setFilterPeriod([]);
          setFilterAction([]); setFilterConfidence([]); setFilterMethod([]);
        }}>Clear</button>
        <ColumnsButton
          columns={TOGGLEABLE_COLUMNS}
          hidden={hiddenColumns}
          onToggle={toggleColumn}
          onReset={resetColumns}
        />
        <CollapseToggle
          label={systemSuggestionsOn ? "System suggestions: ON" : "System suggestions: OFF"}
          active={!systemSuggestionsOn}
          onToggle={() => setSystemSuggestionsOnPersistent(!systemSuggestionsOn)}
        />
      </div>

      <div style={{ ...S.toolbar, marginTop: -4, paddingTop: 0, gap: 14, fontSize: 12, color: PAL.textDim }}>
        <span style={{ fontWeight: 600 }}>Collapse:</span>
        <CollapseToggle label="All customers" active={collapse.customers} onToggle={() => setCollapse((c) => ({ ...c, customers: !c.customers, customerAllStyles: false, allCustomersPerCategory: false, allCustomersPerSubCat: false }))} />
        <CollapseToggle label="All colors per style" active={collapse.colors} onToggle={() => setCollapse((c) => ({ ...c, colors: !c.colors }))} />
        <CollapseToggle label="All styles per customer" active={collapse.customerAllStyles} onToggle={() => setCollapse((c) => ({ ...c, customerAllStyles: !c.customerAllStyles, customers: false, colors: false, category: false, subCat: false, allCustomersPerCategory: false, allCustomersPerSubCat: false }))} />
        <CollapseToggle label="All customers per category" active={collapse.allCustomersPerCategory} onToggle={() => setCollapse((c) => ({ ...c, allCustomersPerCategory: !c.allCustomersPerCategory, allCustomersPerSubCat: false, category: false, subCat: false, customerAllStyles: false, customers: false }))} />
        <CollapseToggle label="All customers per sub cat" active={collapse.allCustomersPerSubCat} onToggle={() => setCollapse((c) => ({ ...c, allCustomersPerSubCat: !c.allCustomersPerSubCat, allCustomersPerCategory: false, category: false, subCat: false, customerAllStyles: false, customers: false }))} />
        <CollapseToggle label="By category" active={collapse.category} onToggle={() => setCollapse((c) => ({ ...c, category: !c.category, subCat: c.category ? c.subCat : false, customerAllStyles: false, allCustomersPerCategory: false, allCustomersPerSubCat: false }))} />
        <CollapseToggle label="By sub cat" active={collapse.subCat} onToggle={() => setCollapse((c) => ({ ...c, subCat: !c.subCat, category: c.subCat ? c.category : false, customerAllStyles: false, allCustomersPerCategory: false, allCustomersPerSubCat: false }))} />
        {anyCollapsed && (
          <button style={{ ...S.btnSecondary, fontSize: 11, padding: "2px 8px" }}
                  onClick={() => setCollapse({ customers: false, colors: false, category: false, subCat: false, customerAllStyles: false, allCustomersPerCategory: false, allCustomersPerSubCat: false })}>
            Reset
          </button>
        )}
        {anyCollapsed && (
          <span style={{ color: PAL.textMuted, fontStyle: "italic" }}>
            Aggregate rows are read-only — drill in by clearing the toggles.
          </span>
        )}
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <Th label="Category"    k="category"    sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("category")} />
              <Th label="Sub Cat"     k="subCat"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("subCat")} />
              <Th label="Style"       k="style"       sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("style")} />
              <Th label="Color"       k="color"       sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("color")} />
              <Th label="Description" k="description" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("description")} />
              <Th label="Customer"    k="customer"    sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("customer")} />
              <Th label="Period"      k="period"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("period")} />
              <Th label="Hist T3"     k="histT3"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("histT3")} />
              <Th label="Hist LY"     k="histLY"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("histLY")} />
              <Th label="System"      k="system"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("system")} />
              <Th label="Buyer"       k="buyer"       sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("buyer")} />
              <Th label="Override"    k="override"    sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("override")} />
              <Th label="Final"       k="final"       sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("final")} />
              <Th label="Conf."       k="confidence"  sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("confidence")} />
              <Th label="Method"      k="method"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("method")} />
              <Th label="On hand"     k="onHand"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("onHand")} />
              <Th label="On SO"       k="onSo"        sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("onSo")} />
              <Th label="Receipts"    k="receipts"    sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric title="Open POs scheduled to land in this period (drives supply math)" hidden={hiddenColumns.has("receipts")} />
              <Th label="Hist Recv"   k="histRecv"    sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric tint={PAL.textMuted} title="Past actual receipts in this period — display only, already in On hand" hidden={hiddenColumns.has("histRecv")} />
              <Th label="ATS"         k="ats"         sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("ats")} />
              <Th label="Buy"         k="buy"         sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric tint={PAL.green} hidden={hiddenColumns.has("buy")} />
              <Th label="Avg Cost"    k="avgCost"     sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric tint={PAL.textMuted} title="From ip_item_avg_cost (Xoro / Excel ingest)" hidden={hiddenColumns.has("avgCost")} />
              <Th label="Unit Cost"   k="unitCost"    sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric tint={PAL.accent2} title="Auto-filled from Avg Cost — editable" hidden={hiddenColumns.has("unitCost")} />
              <Th label="Buy $"       k="buyDollars"  sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric tint={PAL.green} hidden={hiddenColumns.has("buyDollars")} />
              <Th label="Short"       k="shortage"    sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("shortage")} />
              <Th label="Excess"      k="excess"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} numeric hidden={hiddenColumns.has("excess")} />
              <Th label="Action"      k="action"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("action")} />
            </tr>
          </thead>
          <tbody>
            {filtered.slice(page * pageSize, (page + 1) * pageSize).map((r) => (
              <tr
                key={r.forecast_id}
                onContextMenu={(e) => { e.preventDefault(); if (!r.is_aggregate) onSelectRow(r); }}
                title={r.is_aggregate ? `Aggregate of ${r.aggregate_count ?? 1} rows — toggle off Collapse to drill in` : "Right-click for more info"}
                style={r.is_aggregate ? { background: PAL.panelMuted ?? "rgba(255,255,255,0.03)" } : undefined}
              >
                <td style={{ ...S.td, color: PAL.textDim, ...colHide("category") }}>{r.group_name ?? "–"}</td>
                <td style={{ ...S.td, color: PAL.textDim, ...colHide("subCat") }}>{r.sub_category_name ?? "–"}</td>
                <td style={{ ...S.td, fontFamily: "monospace", color: PAL.accent, ...colHide("style") }}>{r.sku_style ?? r.sku_code}</td>
                <td style={{ ...S.td, color: PAL.textDim, ...colHide("color") }}>{r.sku_color ?? "—"}</td>
                <td style={{ ...S.td, color: PAL.textDim, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...colHide("description") }} title={r.sku_description ?? ""}>
                  {r.sku_description ?? "—"}
                </td>
                <td style={{ ...S.td, ...colHide("customer") }}>{r.customer_name}</td>
                <td style={{ ...S.td, ...colHide("period") }}>{formatPeriodCode(r.period_code)}</td>
                <td style={{ ...S.tdNum, ...colHide("histT3") }}>{formatQty(r.historical_trailing_qty)}</td>
                <td style={{ ...S.tdNum, color: r.forecast_method === "ly_sales" && r.ly_reference_qty != null ? PAL.accent2 : PAL.textMuted, ...colHide("histLY") }}>
                  {r.ly_reference_qty != null ? formatQty(r.ly_reference_qty) : "—"}
                </td>
                <td style={{ ...S.tdNum, padding: "0 4px", ...colHide("system") }} onClick={(e) => e.stopPropagation()}>
                  {r.is_aggregate ? (
                    <span style={{ fontFamily: "monospace", color: PAL.text }}>
                      {formatQty(r.system_forecast_qty)}
                    </span>
                  ) : (
                    <SystemCell
                      value={r.system_forecast_qty}
                      original={r.system_forecast_qty_original}
                      overriddenAt={r.system_forecast_qty_overridden_at}
                      overriddenBy={r.system_forecast_qty_overridden_by}
                      onSave={(qty) => onUpdateSystemOverride(r.forecast_id, qty)}
                    />
                  )}
                </td>
                <td style={{ ...S.tdNum, padding: "0 4px", ...colHide("buyer") }}>
                  {r.is_aggregate ? (
                    <span style={{ fontFamily: "monospace", color: r.buyer_request_qty !== 0 ? PAL.accent : PAL.textMuted }}>
                      {formatQty(r.buyer_request_qty)}
                    </span>
                  ) : (
                    <IntCell
                      value={r.buyer_request_qty}
                      accent={PAL.accent}
                      allowNegative={false}
                      onSave={(qty) => onUpdateBuyerRequest(r.forecast_id, qty)}
                    />
                  )}
                </td>
                <td style={{ ...S.tdNum, padding: "0 4px", ...colHide("override") }}>
                  {r.is_aggregate ? (
                    <span style={{ fontFamily: "monospace", color: r.override_qty !== 0 ? PAL.yellow : PAL.textMuted }}>
                      {formatQty(r.override_qty)}
                    </span>
                  ) : (
                    <IntCell
                      value={r.override_qty}
                      accent={PAL.yellow}
                      allowNegative={true}
                      onSave={(qty) => onUpdateOverride(r.forecast_id, qty)}
                    />
                  )}
                </td>
                <td style={{ ...S.tdNum, color: PAL.green, fontWeight: 700, ...colHide("final") }}>
                  {formatQty(r.final_forecast_qty)}
                </td>
                <td style={{ ...S.td, ...colHide("confidence") }}>
                  <span style={{ ...S.chip, background: CONFIDENCE_COLOR[r.confidence_level] + "33", color: CONFIDENCE_COLOR[r.confidence_level] }}>
                    {r.confidence_level}
                  </span>
                </td>
                <td style={{ ...S.td, ...colHide("method") }}>
                  <span style={{ ...S.chip, background: (METHOD_COLOR[r.forecast_method] ?? PAL.textMuted) + "22", color: METHOD_COLOR[r.forecast_method] ?? PAL.textMuted }}>
                    {METHOD_LABEL[r.forecast_method] ?? r.forecast_method}
                  </span>
                </td>
                <td style={{ ...S.tdNum, ...colHide("onHand") }}>{formatQty(r.on_hand_qty)}</td>
                <td style={{ ...S.tdNum, color: r.on_so_qty > 0 ? PAL.yellow : PAL.textMuted, ...colHide("onSo") }}>
                  {r.on_so_qty > 0 ? formatQty(r.on_so_qty) : "—"}
                </td>
                <td style={{ ...S.tdNum, ...colHide("receipts") }}>{formatQty(r.receipts_due_qty)}</td>
                <td style={{ ...S.tdNum, color: PAL.textMuted, ...colHide("histRecv") }}>{r.historical_receipts_qty ? formatQty(r.historical_receipts_qty) : "—"}</td>
                <td style={{ ...S.tdNum, color: PAL.text, ...colHide("ats") }}>{formatQty(r.available_supply_qty)}</td>
                <td style={{ ...S.tdNum, padding: "0 4px", ...colHide("buy") }} onClick={(e) => e.stopPropagation()}>
                  {r.is_aggregate ? (() => {
                    // Aggregate Buy is bucket-level: a single qty
                    // recorded against (collapse_mode + filters + row
                    // dims). Compute the bucket_key here, look up the
                    // existing qty, render an editable cell. On save
                    // the workbench upserts via repo.
                    const filters: BucketKeyFilters = {
                      // Bucket-buy filters scope to a single dim value;
                      // when the planner has multi-selected, key the
                      // bucket against the first selection (most common
                      // scope is one).
                      customer_id: filterCustomer[0] ?? null,
                      group_name: filterCategory[0] ?? null,
                      sub_category_name: filterSubCat[0] ?? null,
                      gender: filterGender[0] ?? null,
                    };
                    const desc = bucketKeyFor(r, collapse, filters);
                    if (!desc) {
                      return <span style={{ color: PAL.textMuted }}>—</span>;
                    }
                    const stored = bucketBuys?.get(desc.bucket_key) ?? null;
                    return (
                      <BuyCell
                        value={stored}
                        onSave={(qty) => onUpdateBucketBuy({ ...desc, qty })}
                      />
                    );
                  })() : (
                    <BuyCell
                      value={r.planned_buy_qty}
                      onSave={(qty) => onUpdateBuyQty(r.forecast_id, qty)}
                    />
                  )}
                </td>
                <td style={{ ...S.tdNum, color: r.avg_cost ? PAL.text : PAL.textMuted, fontFamily: "monospace", ...colHide("avgCost") }}>
                  {r.avg_cost ? `$${r.avg_cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "–"}
                </td>
                <td style={{ ...S.tdNum, padding: "0 4px", ...colHide("unitCost") }} onClick={(e) => e.stopPropagation()}>
                  {r.is_aggregate ? (
                    <span style={{ fontFamily: "monospace", color: r.unit_cost != null ? PAL.accent2 : PAL.textMuted }}>
                      {r.unit_cost != null ? `$${r.unit_cost.toFixed(2)}` : "—"}
                    </span>
                  ) : (
                    <UnitCostCell
                      value={r.unit_cost}
                      overridden={r.unit_cost_override != null}
                      onSave={(cost) => onUpdateUnitCost(r.forecast_id, cost)}
                    />
                  )}
                </td>
                {(() => {
                  const qty = r.planned_buy_qty;
                  const cost = r.unit_cost;
                  const hasCost = qty != null && qty > 0 && cost != null && cost > 0;
                  return (
                    <td style={{ ...S.tdNum, color: hasCost ? PAL.green : PAL.textMuted, fontFamily: "monospace", ...colHide("buyDollars") }}>
                      {hasCost ? `$${(qty * cost).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "–"}
                    </td>
                  );
                })()}
                <td style={{ ...S.tdNum, color: r.projected_shortage_qty > 0 ? PAL.red : PAL.textMuted, ...colHide("shortage") }}>
                  {formatQty(r.projected_shortage_qty)}
                </td>
                <td style={{ ...S.tdNum, color: r.projected_excess_qty > 0 ? PAL.yellow : PAL.textMuted, ...colHide("excess") }}>
                  {formatQty(r.projected_excess_qty)}
                </td>
                <td style={{ ...S.td, ...colHide("action") }}>
                  <span style={{ ...S.chip, background: (ACTION_COLOR[r.recommended_action] ?? PAL.textMuted) + "33", color: ACTION_COLOR[r.recommended_action] ?? PAL.textMuted }}>
                    {r.recommended_action}
                  </span>
                </td>
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={27} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                {rows.length === 0
                  ? "No forecast rows yet. Click \"Build forecast\" above to populate the grid."
                  : "No rows match your filters."}
              </td></tr>
            )}
            {loading && (
              <tr><td colSpan={27} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                Loading…
              </td></tr>
            )}
          </tbody>
        </table>
        {filtered.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderTop: `1px solid ${PAL.border}`, color: PAL.textDim, fontSize: 12 }}>
            <span>
              {(page * pageSize + 1).toLocaleString()}–{Math.min((page + 1) * pageSize, filtered.length).toLocaleString()} of {filtered.length.toLocaleString()}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>Rows per page:</span>
              <select style={S.select} value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                {[100, 250, 500, 1000, 2000].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <button style={S.btnSecondary} disabled={page === 0} onClick={() => setPage(0)}>« First</button>
              <button style={S.btnSecondary} disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>‹ Prev</button>
              <span>Page {page + 1} / {Math.max(1, Math.ceil(filtered.length / pageSize))}</span>
              <button style={S.btnSecondary} disabled={(page + 1) * pageSize >= filtered.length} onClick={() => setPage((p) => p + 1)}>Next ›</button>
              <button style={S.btnSecondary} disabled={(page + 1) * pageSize >= filtered.length} onClick={() => setPage(Math.max(0, Math.ceil(filtered.length / pageSize) - 1))}>Last »</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ColumnsButton({
  columns,
  hidden,
  onToggle,
  onReset,
}: {
  columns: Array<{ key: string; label: string }>;
  hidden: Set<string>;
  onToggle: (key: string) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Reset the search input each time the popover closes so reopening
  // starts fresh.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const hiddenCount = hidden.size;
  const q = query.trim().toLowerCase();
  const filteredColumns = q
    ? columns.filter((c) => c.label.toLowerCase().includes(q))
    : columns;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        style={S.btnSecondary}
        onClick={() => setOpen((v) => !v)}
        title="Show or hide grid columns"
      >
        Columns{hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ""}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 50,
            background: PAL.panel,
            border: `1px solid ${PAL.border}`,
            borderRadius: 8,
            minWidth: 240,
            maxHeight: 420,
            overflowY: "auto",
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{
            padding: "8px 12px",
            borderBottom: `1px solid ${PAL.borderFaint}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 12,
            color: PAL.textMuted,
            textTransform: "uppercase",
            letterSpacing: 1,
            position: "sticky" as const,
            top: 0,
            background: PAL.panel,
            zIndex: 1,
          }}>
            <span>Visible columns</span>
            <button type="button" style={{ ...S.btnGhost, fontSize: 11 }} onClick={onReset}>Show all</button>
          </div>
          <div style={{
            padding: 8,
            borderBottom: `1px solid ${PAL.borderFaint}`,
            position: "sticky" as const,
            top: 33,
            background: PAL.panel,
            zIndex: 1,
          }}>
            <input
              autoFocus
              type="text"
              placeholder="Search columns…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ ...S.input, width: "100%" }}
            />
          </div>
          {filteredColumns.length === 0 ? (
            <div style={{ padding: 12, color: PAL.textMuted, fontSize: 12 }}>No matches</div>
          ) : (
            filteredColumns.map((c) => {
              const visible = !hidden.has(c.key);
              return (
                <label
                  key={c.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 12px",
                    cursor: "pointer",
                    fontSize: 13,
                    color: visible ? PAL.text : PAL.textMuted,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={visible}
                    onChange={() => onToggle(c.key)}
                  />
                  {c.label}
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function Th({ label, k, sortKey, sortDir, onSort, numeric, tint, title, hidden }: {
  label: string; k: SortKey; sortKey: SortKey; sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void; numeric?: boolean; tint?: string; title?: string; hidden?: boolean;
}) {
  const active = sortKey === k;
  const baseColor = tint ?? (active ? PAL.text : PAL.textMuted);
  return (
    <th
      style={{
        ...S.th,
        cursor: "pointer",
        textAlign: numeric ? "right" : "left",
        color: active ? PAL.text : baseColor,
        userSelect: "none",
        ...(hidden ? { display: "none" as const } : null),
      }}
      onClick={() => onSort(k)}
      title={title}
    >
      {label}{active ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );
}

function BuyCell({ value, onSave }: { value: number | null; onSave: (qty: number | null) => Promise<void> }) {
  const [str, setStr] = useState(value != null ? String(value) : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(false);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setStr(value != null ? String(value) : "");
  }, [value]);

  async function commit(raw: string) {
    const trimmed = raw.trim();
    const qty = trimmed === "" ? null : Number(trimmed);
    if (qty !== null && (!Number.isFinite(qty) || !Number.isInteger(qty))) { setErr(true); focused.current = false; return; }
    if (qty === value || (qty == null && value == null)) { focused.current = false; return; }
    setErr(false);
    setSaving(true);
    try { await onSave(qty); } catch { setErr(true); } finally { setSaving(false); focused.current = false; }
  }

  return (
    <input
      data-buycell="1"
      type="text"
      inputMode="numeric"
      value={str}
      onChange={(e) => { setStr(e.target.value); setErr(false); }}
      onBlur={(e) => void commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      placeholder="—"
      style={{
        width: 64,
        background: "transparent",
        color: err ? PAL.red : str ? PAL.green : PAL.textDim,
        border: `1px solid ${err ? PAL.red : "transparent"}`,
        borderRadius: 4,
        padding: "2px 4px",
        fontFamily: "monospace",
        fontSize: 13,
        textAlign: "right",
        outline: "none",
        opacity: saving ? 0.5 : 1,
      }}
      onFocus={(e) => { focused.current = true; e.target.select(); e.target.style.borderColor = err ? PAL.red : PAL.green; e.target.style.background = PAL.panel; }}
      onBlurCapture={(e) => { e.target.style.borderColor = err ? PAL.red : "transparent"; e.target.style.background = "transparent"; }}
    />
  );
}

// Reusable integer cell for inline qty edits (Buyer / Override). Blank
// or non-numeric input commits 0. Negative values allowed when the column
// permits it (Override can subtract).
function IntCell({ value, accent, allowNegative, onSave }: {
  value: number;
  accent: string;
  allowNegative: boolean;
  onSave: (qty: number) => Promise<void>;
}) {
  const [str, setStr] = useState(value === 0 ? "" : (allowNegative && value > 0 ? "+" : "") + String(value));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(false);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setStr(value === 0 ? "" : (allowNegative && value > 0 ? "+" : "") + String(value));
  }, [value, allowNegative]);

  async function commit(raw: string) {
    const trimmed = raw.trim().replace(/^\+/, "");
    const qty = trimmed === "" ? 0 : Number(trimmed);
    if (!Number.isFinite(qty) || !Number.isInteger(qty) || (!allowNegative && qty < 0)) {
      setErr(true); focused.current = false; return;
    }
    if (qty === value) { focused.current = false; return; }
    setErr(false);
    setSaving(true);
    try { await onSave(qty); } catch { setErr(true); } finally { setSaving(false); focused.current = false; }
  }

  const color = err ? PAL.red : value !== 0 ? accent : PAL.textMuted;
  return (
    <input
      type="text"
      inputMode={allowNegative ? "text" : "numeric"}
      value={str}
      onChange={(e) => { setStr(e.target.value); setErr(false); }}
      onBlur={(e) => void commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      placeholder="—"
      style={{
        width: 64,
        background: "transparent",
        color,
        border: `1px solid ${err ? PAL.red : "transparent"}`,
        borderRadius: 4,
        padding: "2px 4px",
        fontFamily: "monospace",
        fontSize: 13,
        textAlign: "right",
        outline: "none",
        opacity: saving ? 0.5 : 1,
      }}
      onFocus={(e) => { focused.current = true; e.target.select(); e.target.style.borderColor = err ? PAL.red : accent; e.target.style.background = PAL.panel; }}
      onBlurCapture={(e) => { e.target.style.borderColor = err ? PAL.red : "transparent"; e.target.style.background = "transparent"; }}
    />
  );
}

// Editable per-row unit cost. Blank input → clears the override and reverts
// to the auto-derived ATS avg cost (or item_cost) on the next refresh.
// `overridden` controls the visual hint so planners can see at a glance
// which rows have a manual cost vs. the auto-fill.
function UnitCostCell({ value, overridden, onSave }: {
  value: number | null;
  overridden: boolean;
  onSave: (cost: number | null) => Promise<void>;
}) {
  const [str, setStr] = useState(value != null ? value.toFixed(2) : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(false);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setStr(value != null ? value.toFixed(2) : "");
  }, [value]);

  async function commit(raw: string) {
    const trimmed = raw.trim();
    const cost = trimmed === "" ? null : Number(trimmed);
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) { setErr(true); focused.current = false; return; }
    if (cost === value) { focused.current = false; return; }
    setErr(false);
    setSaving(true);
    try { await onSave(cost); } catch { setErr(true); } finally { setSaving(false); focused.current = false; }
  }

  const baseColor = err ? PAL.red : overridden ? PAL.accent2 : PAL.textDim;
  return (
    <input
      data-unitcost="1"
      type="text"
      inputMode="decimal"
      value={str}
      onChange={(e) => { setStr(e.target.value); setErr(false); }}
      onBlur={(e) => void commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      placeholder="—"
      title={overridden ? "Planner override — clear to revert to ATS avg" : "Auto-filled from ATS avg cost — type to override"}
      style={{
        width: 72,
        background: "transparent",
        color: baseColor,
        border: `1px solid ${err ? PAL.red : "transparent"}`,
        borderRadius: 4,
        padding: "2px 4px",
        fontFamily: "monospace",
        fontSize: 13,
        textAlign: "right",
        outline: "none",
        opacity: saving ? 0.5 : 1,
        fontStyle: overridden ? "normal" : "italic",
      }}
      onFocus={(e) => { focused.current = true; e.target.select(); e.target.style.borderColor = err ? PAL.red : PAL.accent2; e.target.style.background = PAL.panel; }}
      onBlurCapture={(e) => { e.target.style.borderColor = err ? PAL.red : "transparent"; e.target.style.background = "transparent"; }}
    />
  );
}

function StatCell({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={S.statCard}>
      <div style={{ fontSize: 11, color: PAL.textMuted }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: accent ?? PAL.text, fontFamily: "monospace" }}>{value}</div>
    </div>
  );
}

// Editable System forecast cell. Shows the override value when one is
// set (highlighted yellow + italic), otherwise the computed system
// suggestion in muted color. Tooltip carries the audit trail
// "Changed from X to Y by USER on DATE" so planners know who/when.
// Empty input clears the override (reverts to suggestion).
function SystemCell({ value, original, overriddenAt, overriddenBy, onSave }: {
  value: number;
  original: number;
  overriddenAt: string | null;
  overriddenBy: string | null;
  onSave: (qty: number | null) => Promise<void>;
}) {
  const overridden = overriddenAt != null && value !== original;
  const [str, setStr] = useState(value === 0 ? "" : String(value));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(false);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setStr(value === 0 ? "" : String(value));
  }, [value]);

  async function commit(raw: string) {
    const trimmed = raw.trim();
    // Empty / 0 = clear the override (revert to suggestion). Anything
    // else becomes the override; we pass even "= original" as a no-op
    // so the audit timestamp doesn't bump when the planner re-types
    // the same value.
    let nextOverride: number | null;
    if (trimmed === "" || trimmed === "0") {
      nextOverride = null;
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) { setErr(true); focused.current = false; return; }
      if (n === original && !overridden) { focused.current = false; return; }
      nextOverride = n;
    }
    setErr(false);
    setSaving(true);
    try { await onSave(nextOverride); } catch { setErr(true); } finally { setSaving(false); focused.current = false; }
  }

  const titleParts: string[] = [];
  if (overridden) {
    titleParts.push(`Changed from ${original.toLocaleString()} to ${value.toLocaleString()}`);
    if (overriddenBy) titleParts.push(`by ${overriddenBy}`);
    if (overriddenAt) {
      const when = new Date(overriddenAt);
      if (!isNaN(when.getTime())) titleParts.push(`on ${when.toLocaleString()}`);
    }
    titleParts.push("(empty input reverts to suggestion)");
  } else {
    titleParts.push(`System suggestion: ${original.toLocaleString()}. Type a value to override.`);
  }
  const title = titleParts.join(" · ");
  const baseColor = err ? PAL.red : overridden ? PAL.yellow : PAL.textMuted;

  return (
    <input
      type="text"
      inputMode="numeric"
      value={str}
      onChange={(e) => { setStr(e.target.value); setErr(false); }}
      onBlur={(e) => void commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      placeholder="—"
      title={title}
      style={{
        width: 64,
        background: overridden ? `${PAL.yellow}11` : "transparent",
        color: baseColor,
        border: `1px solid ${err ? PAL.red : overridden ? `${PAL.yellow}66` : "transparent"}`,
        borderRadius: 4,
        padding: "2px 4px",
        fontFamily: "monospace",
        fontSize: 13,
        textAlign: "right",
        outline: "none",
        opacity: saving ? 0.5 : 1,
        fontStyle: overridden ? "italic" : "normal",
        fontWeight: overridden ? 700 : 400,
      }}
      onFocus={(e) => { focused.current = true; e.target.select(); e.target.style.borderColor = err ? PAL.red : PAL.yellow; e.target.style.background = PAL.panel; }}
      onBlurCapture={(e) => { e.target.style.borderColor = err ? PAL.red : overridden ? `${PAL.yellow}66` : "transparent"; e.target.style.background = overridden ? `${PAL.yellow}11` : "transparent"; }}
    />
  );
}

function CollapseToggle({ label, active, onToggle }: { label: string; active: boolean; onToggle: () => void }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", padding: "2px 6px", borderRadius: 4, background: active ? `${PAL.accent}22` : "transparent", border: `1px solid ${active ? PAL.accent : PAL.border}`, color: active ? PAL.accent : PAL.textDim }}>
      <input type="checkbox" checked={active} onChange={onToggle} style={{ accentColor: PAL.accent }} />
      {label}
    </label>
  );
}

// Generic null-safe comparators. Numbers sort numerically; strings sort
// case-insensitively; nulls always at the end regardless of direction.
function cmpStr(a: string | null | undefined, b: string | null | undefined, sign: number): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a.localeCompare(b, undefined, { sensitivity: "base" }) * sign;
}
function cmpNum(a: number | null | undefined, b: number | null | undefined, sign: number): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return (a - b) * sign;
}

function cmp(a: IpPlanningGridRow, b: IpPlanningGridRow, k: SortKey, d: "asc" | "desc"): number {
  const sign = d === "asc" ? 1 : -1;
  switch (k) {
    case "category":    return cmpStr(a.group_name, b.group_name, sign);
    case "subCat":      return cmpStr(a.sub_category_name, b.sub_category_name, sign);
    case "style":       return cmpStr((a.sku_style ?? a.sku_code) + ":" + (a.sku_color ?? ""), (b.sku_style ?? b.sku_code) + ":" + (b.sku_color ?? ""), sign);
    case "color":       return cmpStr(a.sku_color, b.sku_color, sign);
    case "description": return cmpStr(a.sku_description, b.sku_description, sign);
    case "customer":    return cmpStr(a.customer_name, b.customer_name, sign);
    case "period":      return cmpStr(a.period_start, b.period_start, sign);
    case "histT3":      return cmpNum(a.historical_trailing_qty, b.historical_trailing_qty, sign);
    case "histLY":      return cmpNum(a.ly_reference_qty, b.ly_reference_qty, sign);
    case "system":      return cmpNum(a.system_forecast_qty, b.system_forecast_qty, sign);
    case "buyer":       return cmpNum(a.buyer_request_qty, b.buyer_request_qty, sign);
    case "override":    return cmpNum(a.override_qty, b.override_qty, sign);
    case "final":       return cmpNum(a.final_forecast_qty, b.final_forecast_qty, sign);
    case "confidence":  return cmpStr(a.confidence_level, b.confidence_level, sign);
    case "method":      return cmpStr(a.forecast_method, b.forecast_method, sign);
    case "onHand":      return cmpNum(a.on_hand_qty, b.on_hand_qty, sign);
    case "onSo":        return cmpNum(a.on_so_qty, b.on_so_qty, sign);
    case "receipts":    return cmpNum(a.receipts_due_qty, b.receipts_due_qty, sign);
    case "histRecv":    return cmpNum(a.historical_receipts_qty, b.historical_receipts_qty, sign);
    case "ats":         return cmpNum(a.available_supply_qty, b.available_supply_qty, sign);
    case "buy":         return cmpNum(a.planned_buy_qty, b.planned_buy_qty, sign);
    case "avgCost":     return cmpNum(a.avg_cost, b.avg_cost, sign);
    case "unitCost":    return cmpNum(a.unit_cost, b.unit_cost, sign);
    case "buyDollars":  return cmpNum((a.planned_buy_qty ?? 0) * (a.unit_cost ?? 0), (b.planned_buy_qty ?? 0) * (b.unit_cost ?? 0), sign);
    case "shortage":    return cmpNum(a.projected_shortage_qty, b.projected_shortage_qty, sign);
    case "excess":      return cmpNum(a.projected_excess_qty, b.projected_excess_qty, sign);
    case "action":      return cmpStr(a.recommended_action, b.recommended_action, sign);
  }
}

// aggregateRows + mergeBucket moved to ./aggregateGridRows for unit
// testability. Imported at the top of this file.
