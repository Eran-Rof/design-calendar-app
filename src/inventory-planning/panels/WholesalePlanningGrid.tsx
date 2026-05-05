// The main workbench table. Columns listed here are intentionally wide
// so planners can scan a row end-to-end without scrolling. Click a row to
// open the detail drawer.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { IpPlanningGridRow } from "../types/wholesale";
import { S, PAL, ACTION_COLOR, CONFIDENCE_COLOR, METHOD_COLOR, METHOD_LABEL, formatQty, formatPeriodCode } from "../components/styles";
import { MultiSelectDropdown } from "../components/MultiSelectDropdown";
import { StatCell } from "../components/StatCell";
import { BuyCell } from "../components/cells/BuyCell";
import { IntCell } from "../components/cells/IntCell";
import { UnitCostCell } from "../components/cells/UnitCostCell";
import { SystemCell } from "../components/cells/SystemCell";
import { CollapseToggle } from "../components/cells/CollapseToggle";
import { ColumnsButton } from "../components/cells/ColumnsButton";
import { TbdStyleCell } from "../components/cells/TbdStyleCell";
import { TbdDescriptionCell } from "../components/cells/TbdDescriptionCell";
import { TbdCustomerCell } from "../components/cells/TbdCustomerCell";
import { TbdColorCell } from "../components/cells/TbdColorCell";
import { usePersistedString, usePersistedStringArray } from "../hooks/usePersistedFilter";
import { aggregateRows, type CollapseModes as ExtractedCollapseModes } from "./aggregateGridRows";
import { bucketKeyFor, type BucketKeyFilters } from "./bucketBuyKey";
import { recommendForRow } from "../compute/recommendations";
import { applyRollingPool } from "../compute/supply";

export interface WholesalePlanningGridProps {
  rows: IpPlanningGridRow[];
  // Active planning run's horizon. Used to seed the Period filter
  // dropdown with every month in the run, not just months that
  // currently have forecast rows — without this the filter collapses
  // to whatever the most recent (possibly filtered) build wrote, so a
  // planner running an Apr→Dec run who built only May sees only May
  // as a period option and can't pre-scope a build for the other
  // months.
  runHorizon?: { start: string; end: string } | null;
  onSelectRow: (row: IpPlanningGridRow) => void;
  onUpdateBuyQty: (forecastId: string, qty: number | null) => Promise<void>;
  // TBD-row mutations: rename color (with is_new_color flag), reassign
  // customer (Phase 3), and add a fresh row (Phase 4). Workbench
  // composes a saveTbdField call from these.
  onUpdateTbdColor?: (row: IpPlanningGridRow, color: string, isNewColor: boolean) => Promise<void>;
  // Rename the style on a TBD row. Picking "TBD" as the style turns
  // the row into the catch-all (style=TBD, color=TBD) line for the
  // bucket's period; picking a real style code from the same
  // category promotes the qty to that style's TBD line.
  onUpdateTbdStyle?: (row: IpPlanningGridRow, styleCode: string) => Promise<void>;
  // Delete a planner-added TBD row. Hidden on auto-synthesized rows
  // (the workbench enforces this server-side too).
  onDeleteTbdRow?: (row: IpPlanningGridRow) => Promise<void>;
  // Undo the most recent + Add row from the toolbar — distinct from
  // the row-level ✕ so the planner can hit it without hunting for
  // the row when they realize they added the wrong thing.
  onUndoLastAdd?: () => Promise<void>;
  // Identity of the row the planner just added — pinned to the top
  // of displayRows so it's the first thing they see. Cleared from
  // the workbench if/when the planner does another add.
  lastAddedTbdMarker?: {
    style_code: string;
    color: string;
    customer_id: string;
    period_code: string;
  } | null;
  // Master color set (lowercased, run-wide) used by the TBD color
  // picker to decide whether a typed color is "new". Sourced from
  // ip_item_master directly so colors on master entries with no
  // demand pair don't false-fire the NEW flag.
  masterColorsLower?: Set<string>;
  // Per-style master color set (lowercased). Used to differentiate
  // "new for this style but exists elsewhere" (green badge) from
  // "truly new, not in master at all" (orange badge).
  masterColorsByStyleLower?: Map<string, Set<string>>;
  // (style_code, group_name, sub_category_name) tuples from item
  // master. Drives the TBD style picker's category-wide list.
  masterStyles?: Array<{ style_code: string; group_name: string | null; sub_category_name: string | null }>;
  // Reassign a TBD row's customer. Picking a real customer promotes
  // the stock-buy line into that customer's committed demand; the
  // grid re-loads after save and the row shows under the new
  // customer (still flagged is_tbd until the next planning build
  // surfaces a real forecast row).
  onUpdateTbdCustomer?: (row: IpPlanningGridRow, customerId: string, customerName: string) => Promise<void>;
  // Insert a brand-new customer into ip_customer_master and assign
  // this TBD row to them. Triggered by "Add as NEW customer:" in
  // the TBD customer picker. The workbench refreshes the local
  // customers list so the new entry shows up in every dropdown.
  onAddTbdNewCustomer?: (row: IpPlanningGridRow, customerName: string) => Promise<void>;
  // Customer IDs flagged NEW for this session — shown with an
  // orange NEW badge on the customer cell. Populated by the
  // workbench when the planner uses "Add as NEW customer".
  newCustomerIds?: Set<string>;
  // Free-text description on TBD rows. Backed by the `notes`
  // column on ip_wholesale_forecast_tbd; passing an empty string
  // clears the override so the master's description (if any)
  // shows through.
  onUpdateTbdDescription?: (row: IpPlanningGridRow, description: string) => Promise<void>;
  // Add a brand-new TBD row (Phase 4 of the TBD feature). The grid
  // collects style/color/customer/category/sub_cat/period from the
  // inline form; the workbench upserts a fresh ip_wholesale_forecast_tbd
  // record and rebuilds. Style + color default to "TBD"; period defaults
  // to the first period of the planning run.
  onAddTbdRow?: (args: {
    style_code: string;
    color: string;
    is_new_color: boolean;
    customer_ids: string[];
    group_name: string | null;
    sub_category_name: string | null;
    period_codes: string[];
    notes?: string | null;
  }) => Promise<void>;
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
  // every time the planner changes a filter dropdown. The build
  // pipeline applies customer / style / category / sub-cat / gender
  // / period as input filters; recommended_action / confidence_level
  // / forecast_method are passed through but only surface as a chip
  // hint (they're outputs of the build, not inputs).
  onFiltersChange?: (filters: {
    customer_id: string | null;
    style_code: string | null;
    group_name: string | null;
    sub_category_name: string | null;
    gender: string | null;
    period_code: string | null;
    recommended_action: string | null;
    confidence_level: string | null;
    forecast_method: string | null;
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
  | "period" | "class" | "histT3" | "histLY" | "system" | "buyer" | "override" | "final"
  | "confidence" | "method" | "onHand" | "onSo" | "receipts" | "histRecv" | "ats"
  | "buy" | "avgCost" | "unitCost" | "buyDollars" | "shortage" | "excess" | "action";

// Re-export of the type now defined alongside the aggregate logic
// in ./aggregateGridRows.ts. Kept as a local alias so existing
// references (CollapseModes) compile without churn.
type CollapseModes = ExtractedCollapseModes;

// Multi-select dropdown options for the collapse selector. The
// dropdown stays open across selections so the planner can flick
// on combinations (e.g. customers + colors). applyCollapseKeys
// enforces the runtime invariants (category vs subCat exclusive,
// wide rollups override simple customers/colors).
const COLLAPSE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "customers",                  label: "All customers (per style/color)" },
  { value: "colors",                     label: "All colors per style" },
  { value: "customerAllStyles",          label: "All styles per customer" },
  { value: "allCustomersPerStyle",       label: "All customers per style" },
  { value: "allCustomersPerCategory",    label: "All customers per category" },
  { value: "allCustomersPerSubCat",      label: "All customers per sub cat" },
  { value: "category",                   label: "By category" },
  { value: "subCat",                     label: "By sub cat" },
];

const NO_COLLAPSE: CollapseModes = {
  customers: false, colors: false, category: false, subCat: false,
  customerAllStyles: false, allCustomersPerCategory: false,
  allCustomersPerSubCat: false, allCustomersPerStyle: false,
};

// Collapse-object → option keys. The dropdown stays open and is
// multi-select; the planner can flick on multiple modes at once.
// We surface the same option keys that applyCollapseKeys reads,
// reverse-mapped from whichever flags are currently true. The
// "customersAndColors" combo is decomposed back to "customers" +
// "colors" so the dropdown's checkmarks line up with the actual
// flags driving the grid.
function collapseToKeys(c: CollapseModes): string[] {
  const keys: string[] = [];
  if (c.customerAllStyles) keys.push("customerAllStyles");
  if (c.allCustomersPerStyle) keys.push("allCustomersPerStyle");
  if (c.allCustomersPerCategory) keys.push("allCustomersPerCategory");
  if (c.allCustomersPerSubCat) keys.push("allCustomersPerSubCat");
  if (c.subCat) keys.push("subCat");
  if (c.category) keys.push("category");
  if (c.customers) keys.push("customers");
  if (c.colors) keys.push("colors");
  return keys;
}

// Option keys → collapse object. The grid's CollapseModes object is
// flag-based, but several flags are mutually exclusive at runtime
// (e.g. category vs subCat). When the planner picks a wider rollup
// like customerAllStyles or allCustomersPerCategory, that mode
// supersedes the simpler customers / colors flags — picking it
// auto-clears the others to keep the bucketing sane.
function applyCollapseKeys(keys: string[]): CollapseModes {
  const out: CollapseModes = { ...NO_COLLAPSE };
  const set = new Set(keys);
  if (set.has("customers")) out.customers = true;
  if (set.has("colors")) out.colors = true;
  if (set.has("category")) out.category = true;
  if (set.has("subCat")) out.subCat = true;
  if (set.has("customerAllStyles")) out.customerAllStyles = true;
  if (set.has("allCustomersPerStyle")) out.allCustomersPerStyle = true;
  if (set.has("allCustomersPerCategory")) out.allCustomersPerCategory = true;
  if (set.has("allCustomersPerSubCat")) out.allCustomersPerSubCat = true;
  // Mutually-exclusive enforcement: category vs subCat.
  if (out.category && out.subCat) out.subCat = false;
  // The "wide rollup" modes drop the simpler customer/color flags
  // because their bucketing already drops those dims. Keeping the
  // simpler flags on alongside would just be ignored, but they'd
  // light up in the dropdown and confuse the planner.
  const wideRollupActive =
    out.customerAllStyles || out.allCustomersPerStyle
    || out.allCustomersPerCategory || out.allCustomersPerSubCat;
  if (wideRollupActive) {
    out.customers = false;
    out.colors = false;
  }
  return out;
}

// Spread a typed total across N supply-only forecast rows for a (style,
// color) bucket. Aggregate Buyer / Override edits route 100% to the
// "(Supply Only)" synthetic customer rows under the bucket, never to
// real customer rows — the planner treats top-level edits as stock
// buys, not as demand requests against any individual customer.
//
// When the bucket has multiple supply-only rows (e.g. multi-size where
// several sizes have no customer pair), the total is split across
// them — equally if every child is currently zero, otherwise weighted
// by their existing values. Rounding error is absorbed into the LAST
// child so the integer sum hits `newTotal` exactly.
//
// Returns one entry per underlying supply-only id with the new qty.
// The caller filters out no-op writes before dispatching network
// mutations.
function distributeAcrossChildren(
  underlyingIds: string[],
  currentValues: number[],
  newTotal: number,
): Array<{ fid: string; qty: number }> {
  const N = underlyingIds.length;
  if (N === 0) return [];
  if (N === 1) return [{ fid: underlyingIds[0], qty: newTotal }];
  const currentTotal = currentValues.reduce((a, b) => a + b, 0);
  if (currentTotal === 0) {
    const base = Math.trunc(newTotal / N);
    const remainder = newTotal - base * N;
    return underlyingIds.map((fid, i) => ({ fid, qty: base + (i < Math.abs(remainder) ? Math.sign(remainder) : 0) }));
  }
  const out: Array<{ fid: string; qty: number }> = [];
  let assigned = 0;
  for (let i = 0; i < N; i++) {
    const isLast = i === N - 1;
    const qty = isLast
      ? newTotal - assigned
      : Math.round((newTotal * currentValues[i]) / currentTotal);
    out.push({ fid: underlyingIds[i], qty });
    assigned += qty;
  }
  return out;
}

export default function WholesalePlanningGrid({ rows, runHorizon, onSelectRow, onUpdateBuyQty, onUpdateBucketBuy, onUpdateUnitCost, onUpdateBuyerRequest, onUpdateOverride, onUpdateSystemOverride, onUpdateTbdColor, onUpdateTbdStyle, onUpdateTbdCustomer, onAddTbdNewCustomer, newCustomerIds, onUpdateTbdDescription, onAddTbdRow, onDeleteTbdRow, onUndoLastAdd, lastAddedTbdMarker, masterColorsLower, masterColorsByStyleLower, masterStyles, onFiltersChange, headerSlot, bucketBuys, loading, systemSuggestionsOn, onSystemSuggestionsChange, onScopeChange }: WholesalePlanningGridProps) {
  // Persisted filter state — survives reloads + builds. Each slot is
  // mirrored to ws_planning_filter_<key> in localStorage so the
  // planner doesn't re-pick after a reload or rebuild.
  const [search, setSearch] = usePersistedString("search");
  // Multi-select filters — empty array = no filter (all rows pass).
  // Each non-empty array narrows to rows whose value is in the set.
  const [filterCustomer, setFilterCustomer] = usePersistedStringArray("customer");
  const [filterCategory, setFilterCategory] = usePersistedStringArray("category");
  const [filterSubCat, setFilterSubCat] = usePersistedStringArray("subCat");
  const [filterGender, setFilterGender] = usePersistedStringArray("gender");
  const [filterAction, setFilterAction] = usePersistedStringArray("action");
  const [filterConfidence, setFilterConfidence] = usePersistedStringArray("confidence");
  // Master toggle — owned by the workbench. When OFF, system forecast
  // suggestions are blanked out so the planner drives demand purely
  // through Buyer / Override edits.
  const setSystemSuggestionsOnPersistent = onSystemSuggestionsChange;
  const [filterMethod, setFilterMethod] = usePersistedStringArray("method");
  const [sortKey, setSortKey] = useState<SortKey>("period");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filterPeriod, setFilterPeriod] = usePersistedStringArray("period");
  const [filterStyle, setFilterStyle] = usePersistedStringArray("style");
  const [filterColor, setFilterColor] = usePersistedStringArray("color");
  // Inline "+ Add row" form state. Closed by default; opens above
  // the table to the planner's chosen cat/sub-cat/customer + first
  // period of the run. Style + color default to "TBD". Persists
  // through onAddTbdRow which the workbench wires to repo upsert.
  // Modal shown when the planner clicks a Color cell on a non-first
  // row of a NEW style. Color edits on those rows used to backfill
  // every period of the style — easy to mis-trigger and surfaced as
  // "some periods reverted to the original color" race conditions.
  // Lock editing to the first row, surface the why in-app.
  const [colorEditBlocked, setColorEditBlocked] = useState(false);
  const [addRowOpen, setAddRowOpen] = useState(false);
  const [addRowDraft, setAddRowDraft] = useState<{
    customer_ids: string[];
    group_name: string | null;
    sub_category_name: string | null;
    period_codes: string[];
    style_code: string;
    color: string;
    is_new_color: boolean;
    description: string;
  }>({
    customer_ids: [],
    group_name: null,
    sub_category_name: null,
    period_codes: [],
    style_code: "TBD",
    color: "TBD",
    is_new_color: false,
    description: "",
  });
  const [addRowSaving, setAddRowSaving] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(500);
  // Collapse / aggregation modes — independent toggles that change the
  // grouping key of the displayed rows. When any are on, grids show
  // aggregate rows and inline editing is disabled on those rows.
  const [collapseRaw, setCollapseRaw] = useState<CollapseModes>(() => {
    try {
      const raw = localStorage.getItem("ws_planning_collapse");
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.log("[ip-debug loadCollapse] raw=", raw);
      }
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          return {
            customers: !!parsed.customers,
            colors: !!parsed.colors,
            category: !!parsed.category,
            subCat: !!parsed.subCat,
            customerAllStyles: !!parsed.customerAllStyles,
            allCustomersPerCategory: !!parsed.allCustomersPerCategory,
            allCustomersPerSubCat: !!parsed.allCustomersPerSubCat,
            allCustomersPerStyle: !!parsed.allCustomersPerStyle,
          };
        }
      }
    } catch { /* ignore */ }
    return {
      customers: false, colors: false, category: false, subCat: false,
      customerAllStyles: false, allCustomersPerCategory: false, allCustomersPerSubCat: false,
      allCustomersPerStyle: false,
    };
  });
  // Persist synchronously inside the setter so a subsequent unmount
  // (tab switch, run change, build refresh) can't drop the write the
  // way a deferred useEffect could. Wraps setCollapseRaw.
  const collapse = collapseRaw;
  const setCollapse: typeof setCollapseRaw = (next) => {
    setCollapseRaw((cur) => {
      const computed = typeof next === "function" ? (next as (c: CollapseModes) => CollapseModes)(cur) : next;
      try {
        const json = JSON.stringify(computed);
        localStorage.setItem("ws_planning_collapse", json);
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.log("[ip-debug writeCollapse] ←", json);
        }
      } catch { /* ignore */ }
      return computed;
    });
  };
  const anyCollapsed =
    collapse.customers || collapse.colors || collapse.category || collapse.subCat ||
    collapse.customerAllStyles || collapse.allCustomersPerCategory || collapse.allCustomersPerSubCat ||
    collapse.allCustomersPerStyle;
  const currentCollapseKeys = collapseToKeys(collapse);

  // Forecast IDs of aggregate rows the planner has expanded — when set,
  // the underlying child rows render below the parent indented + muted.
  const [expandedAggs, setExpandedAggs] = useState<Set<string>>(new Set());
  // Aggregates the planner has EXPLICITLY collapsed despite an
  // auto-expand trigger (e.g. an active search). Without this, the
  // chevron click was a no-op while a search was active because
  // effectiveExpanded re-added every aggregate every render.
  const [manuallyCollapsedAggs, setManuallyCollapsedAggs] = useState<Set<string>>(new Set());
  const toggleAggExpanded = (forecastId: string) => {
    // Resolve the row's effective expansion at click time so toggling
    // means "do the opposite of what the user sees right now".
    const wasExpanded = expandedAggs.has(forecastId)
      || (search.trim().length > 0 && !manuallyCollapsedAggs.has(forecastId));
    setExpandedAggs((prev) => {
      const next = new Set(prev);
      next.delete(forecastId);
      if (!wasExpanded) next.add(forecastId);
      return next;
    });
    setManuallyCollapsedAggs((prev) => {
      const next = new Set(prev);
      if (wasExpanded) next.add(forecastId);
      else next.delete(forecastId);
      return next;
    });
  };
  // No reset on collapse change: expandedAggs is keyed on
  // aggregate_key (e.g. "cat:Knits:2026-04"), which is mode-prefixed
  // and stable across filter/search/page changes. Switching modes
  // changes the prefix, so stale keys from a prior mode are simply
  // never matched — they linger in the Set but cause no UI effect.

  // Edit-recency tracker for grid rows, keyed by forecast_id (stable
  // across rebuilds for both real forecast rows and TBD rows). Each
  // "touch" — row added, single-row qty save, or aggregate routing
  // target save — bumps a monotonic counter. Used by reduction logic
  // to peel back the most recently edited rows first when the
  // planner drops an aggregate total — applies to ALL rows with qty
  // in the bucket, not just TBD.
  const rowEditOrderRef = useRef<Map<string, number>>(new Map());
  const rowEditSeqRef = useRef<number>(0);
  const bumpRowEditOrder = (forecastId: string | undefined): void => {
    if (!forecastId) return;
    rowEditSeqRef.current += 1;
    rowEditOrderRef.current.set(forecastId, rowEditSeqRef.current);
  };
  // Mark the most recently added TBD row as the most recently
  // touched — covers the "or add" leg of "last style that had a qty
  // change OR add" sequencing.
  useEffect(() => {
    if (!lastAddedTbdMarker) return;
    const match = rows.find((r) =>
      r.is_tbd
      && r.is_user_added
      && (r.sku_style ?? "") === lastAddedTbdMarker.style_code
      && (r.sku_color ?? "") === lastAddedTbdMarker.color
      && r.customer_id === lastAddedTbdMarker.customer_id
      && r.period_code === lastAddedTbdMarker.period_code,
    );
    if (match) bumpRowEditOrder(match.forecast_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastAddedTbdMarker]);

  // Inline confirmation modal state — replaces window.confirm so the
  // warning matches the rest of the app's dark-theme styling. Resolved
  // by the user clicking Confirm or Cancel.
  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    onConfirm: () => void;
    onCancel: () => void;
  } | null>(null);
  const askConfirm = (title: string, body: string, confirmLabel = "Proceed"): Promise<boolean> => {
    return new Promise((resolve) => {
      setPendingConfirm({
        title, body, confirmLabel,
        onConfirm: () => { setPendingConfirm(null); resolve(true); },
        onCancel: () => { setPendingConfirm(null); resolve(false); },
      });
    });
  };
  // Reset to first page whenever filters/sort change so the user doesn't
  // wonder why an empty page is showing.
  useEffect(() => { setPage(0); }, [search, filterCustomer, filterCategory, filterSubCat, filterGender, filterPeriod, filterStyle, filterColor, filterAction, filterConfidence, filterMethod, sortKey, sortDir, pageSize, collapse, systemSuggestionsOn]);

  // Report active build-relevant filters up to the workbench so the
  // PlanningRunControls' Build button can scope itself to this subset.
  // Only the filters that map to the build pipeline are emitted —
  // customer, category (group_name), sub-cat, gender. The rest
  // (action / confidence / method / search) are display-only.
  useEffect(() => {
    if (!onFiltersChange) return;
    onFiltersChange({
      // Most build dims still take a single value; we send the first
      // selection. Period is the exception — the planner can pick
      // multiple periods to build, and the build pass honors the
      // entire array. period_code stays as the first selection too
      // for legacy callsites that only check the single value.
      customer_id: filterCustomer[0] ?? null,
      style_code: filterStyle[0] ?? null,
      group_name: filterCategory[0] ?? null,
      sub_category_name: filterSubCat[0] ?? null,
      gender: filterGender[0] ?? null,
      period_code: filterPeriod[0] ?? null,
      period_codes: filterPeriod.length > 0 ? filterPeriod : null,
      recommended_action: filterAction[0] ?? null,
      confidence_level: filterConfidence[0] ?? null,
      forecast_method: filterMethod[0] ?? null,
    });
  }, [filterCustomer, filterStyle, filterCategory, filterSubCat, filterGender, filterPeriod, filterAction, filterConfidence, filterMethod, onFiltersChange]);

  const customers = useMemo(() => {
    const s = new Map<string, string>();
    // Pull from rows so any planner-added customer that has been
    // assigned to a TBD line shows up in the filter dropdown — the
    // memo intentionally walks every row (TBD + non-TBD) so freshly
    // created customers don't have to wait for a build to surface.
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
    { key: "description", label: "Description" },
    { key: "color", label: "Color" },
    { key: "customer", label: "Customer" },
    { key: "period", label: "Period" },
    { key: "class", label: "Class" },
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
    // Merge run-horizon months so the dropdown lists every period the
    // run COULD cover, not just periods that already have forecast
    // rows. Lets the planner pre-scope a build to a not-yet-built
    // month (e.g. Aug on an Apr-Dec run that's only built May so far).
    if (runHorizon?.start && runHorizon?.end) {
      const [sy, sm] = runHorizon.start.split("-").map(Number);
      const [ey, em] = runHorizon.end.split("-").map(Number);
      let y = sy, m = sm;
      while (y < ey || (y === ey && m <= em)) {
        s.add(`${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}`);
        m += 1;
        if (m > 12) { m = 1; y += 1; }
      }
    }
    return Array.from(s).sort();
  }, [rows, runHorizon]);

  // Distinct styles for the by-Style filter dropdown. Styles are
  // sourced from sku_style; rows without a style fall back to sku_code
  // so prepacks (which use the full item number as their style) still
  // show up under their own line.
  //
  // Includes:
  //   • Master styles already in the run (regular forecast rows).
  //   • Planner-added NEW styles (TBD rows whose sku_style was renamed
  //     to a master-unknown code) — these appear as soon as the row
  //     carries them, before any rebuild widens the master.
  //   • The literal "TBD" placeholder (catch-all stock-buy slot) so
  //     the planner can scope the grid to unrenamed stock-buy rows.
  // Master styles that have no rows in the current run (item exists
  // but no demand pair) are also surfaced via masterStyles so the
  // planner can pre-filter ahead of the next build.
  const styles = useMemo(() => {
    const s = new Set<string>();
    let hasTbd = false;
    for (const r of rows) {
      const style = r.sku_style ?? r.sku_code;
      if (!style) continue;
      if (style.toUpperCase() === "TBD") { hasTbd = true; continue; }
      s.add(style);
    }
    if (masterStyles) {
      for (const m of masterStyles) {
        if (m.style_code && m.style_code.toUpperCase() !== "TBD") s.add(m.style_code);
      }
    }
    const out = Array.from(s).sort();
    if (hasTbd) out.unshift("TBD");
    return out;
  }, [rows, masterStyles]);

  // Colors filter — distinct sku_color values across rows that match
  // the current category + sub-cat selection. When neither cat nor
  // sub-cat is filtered, every color in the run is offered. Walks both
  // TBD and non-TBD rows so planner-added new colors are immediately
  // selectable. Literal "TBD" is excluded since it's the placeholder
  // value, not a real color.
  const colorOptions = useMemo(() => {
    const setCategory = filterCategory.length > 0 ? new Set(filterCategory) : null;
    const setSubCat = filterSubCat.length > 0 ? new Set(filterSubCat) : null;
    const s = new Set<string>();
    for (const r of rows) {
      if (setCategory && !setCategory.has(r.group_name ?? "—")) continue;
      if (setSubCat && !setSubCat.has(r.sub_category_name ?? "—")) continue;
      const color = (r.sku_color ?? "").trim();
      if (!color) continue;
      if (color.toUpperCase() === "TBD") continue;
      s.add(color);
    }
    return Array.from(s).sort();
  }, [rows, filterCategory, filterSubCat]);

  // Drop any selected colors that no longer exist under the current
  // cat/sub-cat scope so the planner doesn't see an empty grid because
  // of a stale filter (mirrors the subCategoryNames effect above).
  useEffect(() => {
    if (filterColor.length > 0) {
      const stillValid = filterColor.filter((c) => colorOptions.includes(c));
      if (stillValid.length !== filterColor.length) setFilterColor(stillValid);
    }
  }, [colorOptions, filterColor]);

  // Style → description map used by the + Add row form to auto-fill
  // the Description field when the planner picks a style. Both master
  // styles (which carry master description on every forecast row) and
  // planner-added NEW styles (description stored on the TBD row's
  // notes column, surfaced as sku_description) get covered. First
  // non-empty description wins per style; ties don't matter since
  // every row of a style should agree on description anyway.
  const descriptionByStyle = useMemo(() => {
    const out = new Map<string, string>();
    for (const r of rows) {
      const style = r.sku_style ?? r.sku_code;
      if (!style || out.has(style)) continue;
      const desc = r.sku_description?.trim();
      if (desc) out.set(style, desc);
    }
    return out;
  }, [rows]);

  // Map of category (group_name) → set of "known" colors for the TBD
  // color picker. Sourced from non-TBD rows so the picker offers every
  // color any style in the same category carries — useful when the
  // planner picks a color from a sibling style (e.g. RYB0594 borrowing
  // a color from RYB0599 in the same Shorts category) without having
  // to retype it. The literal "TBD" is excluded so it never surfaces
  // as a "known color" option.
  const colorsByGroupName = useMemo(() => {
    const out = new Map<string, Set<string>>();
    for (const r of rows) {
      if (r.is_tbd) continue;
      const group = r.group_name ?? "—";
      const color = r.sku_color;
      if (!color) continue;
      let set = out.get(group);
      if (!set) { set = new Set<string>(); out.set(group, set); }
      set.add(color);
    }
    return out;
  }, [rows]);
  // Lower-cased flat set of EVERY known color, used by the picker's
  // onSave to decide whether the typed string is "new". Prefers the
  // workbench-fed `masterColorsLower` (sourced directly from
  // ip_item_master, so colors on items with no demand pair still
  // count as known). Falls back to a rows-derived approximation
  // when the prop isn't passed (older call sites).
  const allKnownColorsLower = useMemo(() => {
    if (masterColorsLower && masterColorsLower.size > 0) return masterColorsLower;
    const out = new Set<string>();
    for (const r of rows) {
      if (r.is_tbd) continue;
      if (r.sku_color) out.add(r.sku_color.trim().toLowerCase());
    }
    return out;
  }, [rows, masterColorsLower]);

  // Distinct descriptions across the run + master fallback. Drives
  // the description picker's options. Master descriptions come from
  // non-TBD rows (sku_description is the master's value when no
  // override is set); planner-typed overrides come from TBD rows.
  const masterStylesLower = useMemo(() => {
    const out = new Set<string>();
    if (masterStyles) {
      for (const m of masterStyles) out.add(m.style_code.toLowerCase());
    }
    return out;
  }, [masterStyles]);
  const masterDescriptionsLower = useMemo(() => {
    const out = new Set<string>();
    for (const r of rows) {
      if (r.is_tbd) continue;
      const d = r.sku_description?.trim();
      if (d) out.add(d.toLowerCase());
    }
    return out;
  }, [rows]);
  const knownDescriptions = useMemo(() => {
    const map = new Map<string, string>(); // key=lower, value=display
    for (const r of rows) {
      const d = r.sku_description?.trim();
      if (!d) continue;
      const k = d.toLowerCase();
      if (!map.has(k)) map.set(k, d);
    }
    return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  // Pre-pack multiplier — checks color first, then size, then
  // description. The number after "PPK" (optionally separated by
  // whitespace, underscore, or dash) is the units-per-pack count.
  // Matches: "PPK24", "PPK 24", "PPK-24", "PPK_24", "PPK24-Black",
  // "Tech Jogger PPK24 Special", etc.
  function extractPpk(value: string | null | undefined): number | null {
    if (!value) return null;
    const m = value.match(/PPK[\s_-]*(\d+)/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  function ppkMultiplier(
    color: string | null | undefined,
    size: string | null | undefined,
    description?: string | null,
    style?: string | null,
  ): number {
    return extractPpk(color) ?? extractPpk(size) ?? extractPpk(description) ?? extractPpk(style) ?? 1;
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
    const setStyle = filterStyle.length > 0 ? new Set(filterStyle) : null;
    const setColor = filterColor.length > 0 ? new Set(filterColor) : null;
    const setAction = filterAction.length > 0 ? new Set(filterAction) : null;
    const setConfidence = filterConfidence.length > 0 ? new Set(filterConfidence) : null;
    const setMethod = filterMethod.length > 0 ? new Set(filterMethod) : null;
    const base = rows.filter((r) => {
      if (setCustomer && !setCustomer.has(r.customer_id)) return false;
      if (setCategory && !setCategory.has(r.group_name ?? "—")) return false;
      if (setSubCat && !setSubCat.has(r.sub_category_name ?? "—")) return false;
      // TBD rows with no gender (typical for planner-added new
      // styles that aren't in the item master yet) pass any gender
      // filter — otherwise the row vanishes whenever a planner
      // narrows by gender, even though they explicitly added it for
      // a real customer in a real category. The gender filter still
      // excludes non-TBD rows whose explicit gender doesn't match.
      if (setGender && !setGender.has(r.gender ?? "—")) {
        const isUntaggedTbd = r.is_tbd && (r.gender == null || r.gender === "");
        if (!isUntaggedTbd) return false;
      }
      if (setPeriod && !setPeriod.has(r.period_code)) return false;
      if (setStyle && !setStyle.has(r.sku_style ?? r.sku_code)) return false;
      if (setColor && !setColor.has((r.sku_color ?? "").trim())) return false;
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
      const mult = ppkMultiplier(r.sku_color, r.sku_size, r.sku_description, r.sku_style);
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
  }, [rows, search, filterCustomer, filterCategory, filterSubCat, filterGender, filterPeriod, filterStyle, filterColor, filterAction, filterConfidence, filterMethod, systemSuggestionsOn]);

  // Notify the workbench when the visible (filter+mute) row set changes
  // so MonthlyTotalsCards uses the same subset (drives the top FINAL
  // FORECAST card to match the grid's Σ Final).
  useEffect(() => {
    if (onScopeChange) onScopeChange(mutedRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutedRows]);

  // forecast_id → row lookup over mutedRows for fast drill-down expansion
  // and per-group rolling pool starting balance computation.
  const mutedById = useMemo(() => {
    const m = new Map<string, IpPlanningGridRow>();
    for (const r of mutedRows) m.set(r.forecast_id, r);
    return m;
  }, [mutedRows]);

  // Aggregate Buy save handler. Mirrors saveAggBuyerOrOverride: route
  // the typed value to the (Supply Only) TBD row for the bucket's
  // (style, period). For non-aggregate rows the value saves directly
  // to the row's own planned_buy_qty.
  async function saveAggBuy(r: IpPlanningGridRow, qty: number | null): Promise<void> {
    if (!r.is_aggregate || !r.aggregate_underlying_ids) {
      await onUpdateBuyQty(r.forecast_id, qty);
      return;
    }
    const ids = r.aggregate_underlying_ids;
    const styleSet = new Set<string>();
    let periodStart: string | null = null;
    let missingChildren = 0;
    for (const fid of ids) {
      const child = mutedById.get(fid);
      if (!child) { missingChildren++; continue; }
      const style = child.sku_style ?? child.sku_code;
      if (style) styleSet.add(style);
      periodStart = child.period_start;
    }
    if (missingChildren > 0) {
      // mutedRows changed since the aggregate was computed (e.g. a
      // filter dropdown moved while the planner was typing). Abort
      // the save rather than computing a partial restSum that would
      // misrepresent the bucket.
      console.warn(`[planning] aggregate Buy: ${missingChildren} of ${ids.length} children missing from mutedById — view changed mid-edit. Try again.`);
      return;
    }
    if (!periodStart) return;
    // Same routing preference as saveAggBuyerOrOverride: planner-
    // added rows in the bucket win, with the most recently added
    // (lastAddedTbdMarker match) preferred over older ones; then
    // per-style TBD, then the catch-all (style=TBD).
    let tbdRow: IpPlanningGridRow | null = null;
    const userAddedInBucket: IpPlanningGridRow[] = [];
    for (const fid of ids) {
      const child = mutedById.get(fid);
      if (child?.is_tbd && child.is_user_added) userAddedInBucket.push(child);
    }
    if (userAddedInBucket.length > 0) {
      const seqOf = (r: IpPlanningGridRow) => rowEditOrderRef.current.get(r.forecast_id) ?? 0;
      const updatedAt = (r: IpPlanningGridRow) => r.tbd_updated_at ?? "";
      const sorted = userAddedInBucket.slice().sort((a, b) => {
        const sd = seqOf(b) - seqOf(a);
        if (sd !== 0) return sd;
        return updatedAt(b).localeCompare(updatedAt(a));
      });
      if (seqOf(sorted[0]) > 0 || updatedAt(sorted[0]) !== "") {
        tbdRow = sorted[0];
      } else if (lastAddedTbdMarker) {
        const recent = userAddedInBucket.find((r) =>
          (r.sku_style ?? "") === lastAddedTbdMarker.style_code
          && (r.sku_color ?? "") === lastAddedTbdMarker.color
          && r.customer_id === lastAddedTbdMarker.customer_id
          && r.period_code === lastAddedTbdMarker.period_code,
        );
        if (recent) tbdRow = recent;
      }
      if (!tbdRow) tbdRow = sorted[0];
    } else {
      const styleCode = styleSet.size === 1 ? Array.from(styleSet)[0] : "TBD";
      // Same as saveAggBuyerOrOverride — search the FULL row set so
      // an active customer / period filter can't hide the catch-all
      // (Supply Only) TBD row from the routing target.
      const tbdCandidates = rows.filter((x) =>
        x.is_tbd
        && x.sku_style === styleCode
        && x.period_start === periodStart
        && x.customer_name === "(Supply Only)"
      );
      tbdRow = tbdCandidates.find((x) => x.sku_color === "TBD") ?? tbdCandidates[0] ?? null;
    }
    if (!tbdRow) {
      console.warn(`[planning] aggregate Buy: no TBD routing target found for period ${periodStart}. Has buildGridRows been refreshed?`);
      return;
    }
    // Subtract the rest of the bucket so the displayed sum hits
    // exactly the typed qty.
    let restSum = 0;
    for (const fid of ids) {
      if (fid === tbdRow.forecast_id) continue;
      const child = mutedById.get(fid);
      if (!child) continue;
      restSum += child.planned_buy_qty ?? 0;
    }
    const target = qty == null ? null : Math.max(0, qty - restSum);
    if (target === (tbdRow.planned_buy_qty ?? null)) return;
    await onUpdateBuyQty(tbdRow.forecast_id, target);
  }

  // Aggregate Buyer / Override save handler. Top-level edits represent
  // STOCK BUYS — they're routed to the (Supply Only) TBD row for the
  // bucket's (style, period) instead of distributed across real
  // customer rows. The TBD row is a synthesized line in mutedRows
  // (carrying is_tbd=true, customer = (Supply Only), color = "TBD"
  // by default) — every (style, period) has exactly one. The
  // planner can type at any rollup grain and the value lands on
  // that single TBD row.
  //
  // Math: aggregate.buyer_request_qty / override_qty displays the
  // SUM across all underlying rows, so the typed total is the new
  // sum. We subtract the existing non-TBD contribution to derive
  // what the TBD row should carry, then save that single value via
  // saver(tbdRow.forecast_id, ...). For buyer the result is clamped
  // at zero; override allows negative.
  //
  // Edge cases:
  //   1. Bucket spans multiple styles (e.g. category collapse) — no
  //      single TBD row owns it. We warn and skip; the planner can
  //      use the per-style TBD lines directly, or rely on bucket_buys
  //      for Buy (still works for that mode).
  //   2. No TBD row found for the (style, period) of the bucket —
  //      shouldn't happen post buildGridRows synthesis but log a
  //      warning if it does.
  async function saveAggBuyerOrOverride(
    r: IpPlanningGridRow,
    newTotal: number,
    field: "buyer_request_qty" | "override_qty",
    saver: (forecastId: string, qty: number) => Promise<void>,
    allowNegative: boolean,
  ): Promise<void> {
    if (!r.is_aggregate || !r.aggregate_underlying_ids) {
      // Single-row edit: bump edit-order so future bucket reductions
      // know this row was the most recently touched.
      bumpRowEditOrder(r.forecast_id);
      await saver(r.forecast_id, newTotal);
      return;
    }
    const ids = r.aggregate_underlying_ids;
    // Reduction case (newTotal < currentSum): walk EVERY child row
    // with qty in edit-recency order (most recently added/edited
    // first) and reduce each to zero before moving to the next,
    // until the delta is fully absorbed. Applies to TBD AND real
    // forecast rows alike. Matches the planner mental model: "drop
    // the bucket total → peel back the rows I just touched first."
    const currentSum = (r[field] as number | undefined) ?? 0;
    if (newTotal < currentSum) {
      const fieldLabel = field === "buyer_request_qty" ? "Buyer" : "Override";
      const ok = await askConfirm(
        `Reduce ${fieldLabel} bucket total?`,
        `${currentSum.toLocaleString()} → ${newTotal.toLocaleString()} (-${(currentSum - newTotal).toLocaleString()}).\n\n`
        + `The reduction will peel back the most recently added/edited rows first — TBD or otherwise — zeroing each before moving to the next.`,
        "Reduce",
      );
      if (!ok) return;
      const allChildren: IpPlanningGridRow[] = [];
      let missingChildren = 0;
      for (const fid of ids) {
        const child = mutedById.get(fid);
        if (!child) { missingChildren++; continue; }
        allChildren.push(child);
      }
      if (missingChildren > 0) {
        console.warn(`[planning] aggregate ${field}: ${missingChildren} of ${ids.length} children missing from mutedById — view changed mid-edit. Try again.`);
        return;
      }
      // Sort: most-recently-edited first, with rows having no
      // recency entry sorting last. TBD rows that DO have a
      // recency entry rank by that entry alongside non-TBD rows.
      const seqOf = (row: IpPlanningGridRow) => rowEditOrderRef.current.get(row.forecast_id) ?? 0;
      const sorted = allChildren.slice().sort((a, b) => seqOf(b) - seqOf(a));
      let remaining = currentSum - newTotal;
      const updates: Array<{ row: IpPlanningGridRow; nextQty: number }> = [];
      for (const child of sorted) {
        if (remaining <= 0) break;
        const childQty = (child[field] as number | undefined) ?? 0;
        if (childQty <= 0 && !allowNegative) continue;
        const reduceBy = Math.min(childQty, remaining);
        updates.push({ row: child, nextQty: childQty - reduceBy });
        remaining -= reduceBy;
      }
      if (remaining > 0 && allowNegative && sorted.length > 0) {
        // Override allows negative: push the leftover into the
        // last row in recency order so the bucket sum still hits
        // the typed total.
        const tail = sorted[sorted.length - 1];
        const tailQty = (tail[field] as number | undefined) ?? 0;
        const existing = updates.find((u) => u.row.forecast_id === tail.forecast_id);
        if (existing) existing.nextQty -= remaining;
        else updates.push({ row: tail, nextQty: tailQty - remaining });
        remaining = 0;
      }
      if (updates.length > 0) {
        for (const u of updates) {
          bumpRowEditOrder(u.row.forecast_id);
          await saver(u.row.forecast_id, u.nextQty);
        }
        return;
      }
      // No child had qty to drain — fall through to the routing-
      // target path so a fresh bucket can still receive the typed
      // value (the existing logic places it on the catch-all TBD).
    }
    // Collect the (style, period) tuples present in the bucket so
    // we can detect cross-style cases and pick the TBD row for the
    // single-style case. restSum (computed below after target
    // resolution) handles the per-field math.
    const styleSet = new Set<string>();
    let periodStart: string | null = null;
    let missingChildren = 0;
    for (const fid of ids) {
      const child = mutedById.get(fid);
      if (!child) { missingChildren++; continue; }
      const style = child.sku_style ?? child.sku_code;
      if (style) styleSet.add(style);
      periodStart = child.period_start;
    }
    if (missingChildren > 0) {
      // mutedRows changed mid-edit — abort to avoid an incorrect
      // restSum.
      console.warn(`[planning] aggregate ${field}: ${missingChildren} of ${ids.length} children missing from mutedById — view changed mid-edit. Try again.`);
      return;
    }
    if (!periodStart) return;
    // Pick the routing target. Preference order:
    //   1. The most recently edited/added user-added TBD row in
    //      this bucket — sorted by rowEditOrderRef (which is bumped
    //      on every save AND on add). Treats new-style rows the
    //      same as any other TBD row, so a planner who just typed
    //      a NEW style sees the next aggregate increment land
    //      there. Falls back to lastAddedTbdMarker, then to the
    //      first user-added in the bucket if no recency entry
    //      exists.
    //   2. The (Supply Only) TBD row for the bucket's single style.
    //   3. The catch-all (style=TBD) (Supply Only) TBD row for the
    //      bucket's period (multi-style buckets).
    let tbdRow: IpPlanningGridRow | null = null;
    const userAddedInBucket: IpPlanningGridRow[] = [];
    for (const fid of ids) {
      const child = mutedById.get(fid);
      if (child?.is_tbd && child.is_user_added) userAddedInBucket.push(child);
    }
    if (userAddedInBucket.length > 0) {
      const seqOf = (r: IpPlanningGridRow) => rowEditOrderRef.current.get(r.forecast_id) ?? 0;
      const updatedAt = (r: IpPlanningGridRow) => r.tbd_updated_at ?? "";
      const sorted = userAddedInBucket.slice().sort((a, b) => {
        const sd = seqOf(b) - seqOf(a);
        if (sd !== 0) return sd;
        return updatedAt(b).localeCompare(updatedAt(a));
      });
      if (seqOf(sorted[0]) > 0 || updatedAt(sorted[0]) !== "") {
        tbdRow = sorted[0];
      } else if (lastAddedTbdMarker) {
        const recent = userAddedInBucket.find((r) =>
          (r.sku_style ?? "") === lastAddedTbdMarker.style_code
          && (r.sku_color ?? "") === lastAddedTbdMarker.color
          && r.customer_id === lastAddedTbdMarker.customer_id
          && r.period_code === lastAddedTbdMarker.period_code,
        );
        if (recent) tbdRow = recent;
      }
      if (!tbdRow) tbdRow = sorted[0];
      // Routing decision log — kept on in prod while we hunt the
      // "buyer qty bypasses new style" report. Reveals which row
      // won and why (in-session seq vs DB updated_at vs the legacy
      // marker fallback).
      // eslint-disable-next-line no-console
      console.log(`[ip-routing ${field}]`, {
        newTotal,
        bucket_size: ids.length,
        candidates: sorted.map((r) => ({
          forecast_id: r.forecast_id,
          style: r.sku_style,
          color: r.sku_color,
          customer: r.customer_name,
          seq: seqOf(r),
          updated_at: r.tbd_updated_at,
          qty: r[field],
        })),
        chosen: tbdRow ? {
          forecast_id: tbdRow.forecast_id,
          style: tbdRow.sku_style,
          color: tbdRow.sku_color,
          customer: tbdRow.customer_name,
        } : null,
      });
    } else {
      const styleCode = styleSet.size === 1 ? Array.from(styleSet)[0] : "TBD";
      // Search the FULL row set (not just mutedRows) — the catch-all
      // (Supply Only) TBD row may be excluded by an active customer
      // / period / style filter, but it's still the legitimate
      // routing target. Without this fallback the planner sees a
      // "no TBD routing target" error after typing on an aggregate
      // while filters narrowed away (Supply Only).
      const tbdCandidates = rows.filter((x) =>
        x.is_tbd
        && x.sku_style === styleCode
        && x.period_start === periodStart
        && x.customer_name === "(Supply Only)"
      );
      tbdRow = tbdCandidates.find((x) => x.sku_color === "TBD") ?? tbdCandidates[0] ?? null;
      // Fallback path log — fires when no user-added row was found
      // in the bucket (this is what the user keeps hitting when a
      // NEW style row exists but lives in a DIFFERENT bucket than
      // the one being edited; the qty lands on the auto catch-all
      // for the bucket's style+period instead of the new style).
      // Surfaces the user-added rows OUTSIDE the bucket so we can
      // see where they ended up.
      const allUserAddedTbd = rows.filter((x) => x.is_tbd && x.is_user_added);
      // eslint-disable-next-line no-console
      console.log(`[ip-routing ${field} fallback]`, {
        newTotal,
        bucket_size: ids.length,
        bucket_styleSet: Array.from(styleSet),
        bucket_periodStart: periodStart,
        chose_catchall: tbdRow ? {
          forecast_id: tbdRow.forecast_id,
          style: tbdRow.sku_style,
          color: tbdRow.sku_color,
        } : null,
        user_added_rows_anywhere: allUserAddedTbd.map((r) => ({
          forecast_id: r.forecast_id,
          style: r.sku_style,
          color: r.sku_color,
          customer: r.customer_name,
          period_start: r.period_start,
          updated_at: r.tbd_updated_at,
        })),
      });
    }
    if (!tbdRow) {
      console.warn(`[planning] aggregate ${field}: no TBD routing target found for period ${periodStart}. Has buildGridRows been refreshed?`);
      return;
    }
    // Subtract the rest of the bucket (every underlying except the
    // chosen target) so typing newTotal makes the aggregate's
    // displayed sum hit exactly newTotal. Earlier we only subtracted
    // non-TBD rows, which broke the math when the bucket also held
    // an auto catch-all alongside a user-added row.
    let restSum = 0;
    for (const fid of ids) {
      if (fid === tbdRow.forecast_id) continue;
      const child = mutedById.get(fid);
      if (!child) continue;
      restSum += (child[field] as number | undefined) ?? 0;
    }
    let target = newTotal - restSum;
    if (!allowNegative && target < 0) target = 0;
    if (target === ((tbdRow[field] as number | undefined) ?? 0)) return;
    // Diagnostic: surface the routing decision so we can see in
    // DevTools whether the typed aggregate value is landing on the
    // correct TBD row (or being routed to a stale/synthetic one).
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log("[ip-debug agg-edit]", {
        field,
        newTotal,
        restSum,
        target,
        currentValue: tbdRow[field],
        target_row: {
          forecast_id: tbdRow.forecast_id,
          tbd_id: tbdRow.tbd_id,
          sku_style: tbdRow.sku_style,
          sku_color: tbdRow.sku_color,
          customer_name: tbdRow.customer_name,
          is_user_added: tbdRow.is_user_added,
        },
      });
    }
    bumpRowEditOrder(tbdRow.forecast_id);
    await saver(tbdRow.forecast_id, target);
  }

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
        const onHand = pool;                                                 // beginning balance
        // Available-to-sell against forecast demand. on_so is committed
        // demand already netted out of supply, so it must subtract from
        // ATS for the shortage / excess calc to match the displayed
        // ATS column (which subtracts on_so per row in applyRollingPool).
        // Without this, a period with a big committed SO would show
        // ATS - on_so on the row but compute shortage from a larger
        // ATS — inconsistent numbers across the same row.
        const ats = Math.max(0, pool + agg.receipts + agg.buy - agg.onSo);
        const demand = agg.demand;
        const excess = ats > demand ? ats - demand : 0;
        const shortage = demand > ats ? demand - ats : 0;
        out.set(`${skuId}:${periodStart}`, { onHand, ats, excess, shortage });
        // Roll-forward: don't double-subtract on_so (already taken out
        // of ats above).
        pool = Math.max(0, ats - demand);
      }
    }
    return out;
  }, [mutedRows]);

  const filtered = useMemo(() => {
    const muted = mutedRows;
    // Sizes are always merged — aggregateRows is the canonical pass even
    // when no other collapse is active, so a (style, color, customer,
    // period) bucket with multiple sku_id variants always renders as one
    // row. Single-size buckets fall through unchanged.
    const collapsed = aggregateRows(muted, collapse);
    // groupKey identifies the "chain" the rolling pool walks across
    // periods. Whenever consecutive rows share the same groupKey, the
    // pool carries forward (this row's OnHand = previous row's ATS).
    // When the groupKey changes, the pool resets to that group's own
    // unique-sku on_hand sum.
    //
    // Defined per active collapse mode so the chain matches whatever
    // the user is viewing — works for sub-cat, category, per-style
    // rollup, per-cat-style rollup, per-customer rollup, and even
    // non-collapsed (where the chain is style+color across sizes).
    const groupKeyFor = (r: IpPlanningGridRow): string => {
      if (collapse.subCat) return `sub:${r.sub_category_name ?? ""}`;
      if (collapse.category) return `cat:${r.group_name ?? ""}`;
      if (collapse.allCustomersPerStyle) return `acps:${r.sku_style ?? r.sku_code}`;
      const styleColorPart = `${r.sku_style ?? r.sku_code}:${r.sku_color ?? "—"}`;
      if (collapse.allCustomersPerCategory) {
        const skuPart = collapse.colors ? (r.sku_style ?? r.sku_code) : styleColorPart;
        return `acpc:${r.group_name ?? ""}:${skuPart}`;
      }
      if (collapse.allCustomersPerSubCat) {
        const skuPart = collapse.colors ? (r.sku_style ?? r.sku_code) : styleColorPart;
        return `acpsc:${r.sub_category_name ?? ""}:${skuPart}`;
      }
      if (collapse.customerAllStyles) return `cas:${r.customer_id}`;
      // Default — non-collapsed or only customers/colors. Group by
      // (style, color) across sizes. `colors` further drops the color
      // dim. Customer is ignored because customer-level rolling pool
      // would chain multiple customers' demand through one stock pool.
      if (collapse.colors) return `sku:${r.sku_style ?? r.sku_code}`;
      return `sku:${styleColorPart}`;
    };
    // When any collapse is active, force sort to (groupKey, period) so
    // chained rows render contiguously. Without collapse, keep the
    // user's sortKey — the pool still resets per-row anyway because
    // most non-collapsed rows are different SKUs.
    const sorted = anyCollapsed
      ? [...collapsed].sort((a, b) => {
          const aKey = groupKeyFor(a);
          const bKey = groupKeyFor(b);
          if (aKey !== bKey) return aKey.localeCompare(bKey);
          return a.period_start.localeCompare(b.period_start);
        })
      : [...collapsed].sort((a, b) => cmp(a, b, sortKey, sortDir));
    // Top-down rolling pool: per-row ATS = on_hand − on_so + receipts +
    // buy; the next row inherits this row's ATS as its on_hand. Receipts
    // and buy contribute once per (sku, period) so multi-customer rows
    // of the same SKU don't double-count.
    //
    // When grouping by sub-cat / category, the pool resets at each group
    // boundary and starts from that group's own unique-sku on_hand sum
    // — otherwise sub-cat B would inherit sub-cat A's last ATS, which
    // is meaningless across categories.
    const startingPoolFor = (rows: typeof sorted): number => {
      const seen = new Set<string>();
      let pool = 0;
      for (const r of rows) {
        const ids = r.is_aggregate
          ? (r.aggregate_underlying_ids ?? [])
          : [r.forecast_id];
        for (const fid of ids) {
          const src = mutedById.get(fid);
          if (!src || seen.has(src.sku_id)) continue;
          seen.add(src.sku_id);
          pool += src.on_hand_qty ?? 0;
        }
      }
      return pool;
    };
    // Walk sorted rows and split into groups whenever groupKey
    // changes between consecutive rows. Same groupKey = same chain;
    // different groupKey = pool resets.
    const groups: { rows: typeof sorted; startIndex: number }[] = [];
    let curKey: string | null = null;
    let curRows: typeof sorted = [];
    let curStart = 0;
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      const k = groupKeyFor(r);
      if (k !== curKey) {
        if (curRows.length > 0) groups.push({ rows: curRows, startIndex: curStart });
        curRows = [];
        curKey = k;
        curStart = i;
      }
      curRows.push(r);
    }
    if (curRows.length > 0) groups.push({ rows: curRows, startIndex: curStart });
    const rolled = new Array(sorted.length);
    for (const g of groups) {
      const groupRolled = applyRollingPool(
        g.rows.map((r) => ({
          on_so_qty: r.on_so_qty,
          receipts_due_qty: r.receipts_due_qty ?? 0,
          planned_buy_qty: r.planned_buy_qty ?? 0,
          dedupeKey: `${r.sku_id}:${r.period_start}`,
        })),
        startingPoolFor(g.rows),
      );
      for (let j = 0; j < groupRolled.length; j++) {
        rolled[g.startIndex + j] = groupRolled[j];
      }
    }
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
  }, [mutedRows, mutedById, skuPeriodMath, sortKey, sortDir, collapse, anyCollapsed]);

  // Interleave expanded aggregate children below their parent row. The
  // parent retains its rolled values (computed in `filtered`); children
  // render with their raw mutedRows values + per-(sku, period) math
  // from skuPeriodMath. The rolling pool is NOT recomputed for
  // children — drilling down is purely visual.
  const { displayRows, childIds } = useMemo(() => {
    const ids = new Set<string>();
    let base: typeof filtered = filtered;
    // The just-added row's child forecast_id (the synthetic id we
    // emit in buildGridRows for the underlying TBD row) — used both
    // to auto-expand whichever aggregate contains it AND to position
    // it first among that aggregate's children below.
    let pinnedChildFid: string | null = null;
    if (lastAddedTbdMarker) {
      const matches = (r: IpPlanningGridRow) =>
        r.is_tbd
        && r.is_user_added
        && (r.sku_style ?? "") === lastAddedTbdMarker.style_code
        && (r.sku_color ?? "") === lastAddedTbdMarker.color
        && r.customer_id === lastAddedTbdMarker.customer_id
        && r.period_code === lastAddedTbdMarker.period_code;
      const matchedRow = rows.find(matches);
      if (matchedRow) pinnedChildFid = matchedRow.forecast_id;
    }
    // Build the effective expansion set — the planner's manual
    // expandedAggs PLUS:
    //   1. Any aggregate that contains the just-added row's
    //      forecast_id (so the new line is visible under the
    //      collapsed header without the planner clicking ▶).
    //   2. Any aggregate whose children match the active search
    //      term — when a planner types a search query, they want
    //      to see the matching row, not just the bucket header.
    // The auto-expanders honor manuallyCollapsedAggs: an aggregate
    // the planner explicitly collapsed via the chevron stays
    // collapsed even if it would otherwise be auto-expanded.
    const effectiveExpanded = new Set(expandedAggs);
    if (pinnedChildFid) {
      for (const r of filtered) {
        if (!r.is_aggregate) continue;
        const key = r.aggregate_key ?? r.forecast_id;
        if (manuallyCollapsedAggs.has(key)) continue;
        if (r.aggregate_underlying_ids?.includes(pinnedChildFid)) {
          effectiveExpanded.add(key);
        }
      }
    }
    const searchTrim = search.trim();
    if (searchTrim.length > 0) {
      // Auto-expand every aggregate while the planner is searching
      // — bucketing the matches behind a header defeats the
      // purpose of typing a query.
      for (const r of filtered) {
        if (!r.is_aggregate) continue;
        const key = r.aggregate_key ?? r.forecast_id;
        if (manuallyCollapsedAggs.has(key)) continue;
        effectiveExpanded.add(key);
      }
    }
    if (effectiveExpanded.size > 0) {
      const out: typeof filtered = [];
      for (const r of filtered) {
        out.push(r);
        if (!r.is_aggregate) continue;
        if (!effectiveExpanded.has(r.aggregate_key ?? r.forecast_id)) continue;
        const underlying = r.aggregate_underlying_ids ?? [];
        // Resolve children, sort them by the active sort key (so
        // a-z / 0-9 toggles apply WITHIN each expanded bucket — the
        // bucket header keeps its position dictated by collapse
        // grouping but the rows below it follow the user's sort).
        // Pinned (just-added) child still wins by being lifted to
        // the front after the sort.
        const childRows: IpPlanningGridRow[] = [];
        for (const fid of underlying) {
          const c = mutedById.get(fid);
          if (c) childRows.push(c);
        }
        childRows.sort((a, b) => cmp(a, b, sortKey, sortDir));
        if (pinnedChildFid) {
          const pinnedIdx = childRows.findIndex((c) => c.forecast_id === pinnedChildFid);
          if (pinnedIdx > 0) {
            const [pinnedRow] = childRows.splice(pinnedIdx, 1);
            childRows.unshift(pinnedRow);
          }
        }
        for (const child of childRows) {
          const fid = child.forecast_id;
          const m = skuPeriodMath.get(`${child.sku_id}:${child.period_start}`);
          const projected = m
            ? { on_hand_qty: m.onHand, available_supply_qty: m.ats, projected_excess_qty: m.excess, projected_shortage_qty: m.shortage }
            : {};
          // Keep the real forecast_id so edit handlers continue to save
          // against the underlying row. _displayKey gives React a unique
          // key when the same child appears under multiple expanded
          // parents (rare but possible across collapse modes).
          out.push({ ...child, ...projected, _displayKey: `child:${r.forecast_id}:${fid}` } as IpPlanningGridRow & { _displayKey: string });
          ids.add(fid);
        }
      }
      base = out;
    }
    // Pin the just-added TBD row right under its parent aggregate
    // (e.g., if the planner added a TBD row in sub-cat BAGGY while
    // collapsed by Sub Cat, the row appears as the first line under
    // the BAGGY aggregate header — not at the top of the grid). The
    // marker is a 4-tuple identity so it survives the synthetic
    // forecast_id refresh on rebuild. If the row isn't in the
    // filtered set we still surface it — the workbench fires a
    // separate toast warning so the planner knows their filters
    // would have hidden it.
    if (lastAddedTbdMarker) {
      const matches = (r: IpPlanningGridRow) =>
        r.is_tbd
        && r.is_user_added
        && (r.sku_style ?? "") === lastAddedTbdMarker.style_code
        && (r.sku_color ?? "") === lastAddedTbdMarker.color
        && r.customer_id === lastAddedTbdMarker.customer_id
        && r.period_code === lastAddedTbdMarker.period_code;
      // Locate the row (or fetch from unfiltered if filters hide it).
      // Note: when multiple aggregates expand and contain the same
      // child forecast_id (rare cross-collapse case), `base` can
      // hold N copies of the matching row. Strip ALL of them, not
      // just the first — otherwise the pin re-insert would
      // duplicate.
      let pinned: IpPlanningGridRow | null = null;
      const inBase = base.filter(matches);
      if (inBase.length > 0) {
        pinned = inBase[0];
      } else {
        const fromAllRows = rows.find(matches);
        if (fromAllRows) pinned = fromAllRows;
      }
      if (pinned) {
        const stripped = base.filter((r) => !matches(r));
        // Find the parent aggregate row this row "belongs under" by
        // active collapse mode. When found, insert right after it so
        // the planner sees the new line immediately under the
        // collapsed header. When no aggregate matches (e.g., no
        // collapse active, or the collapse mode doesn't bucket on a
        // dim the new row carries), fall back to top-of-grid.
        let parentIdx = -1;
        if (collapse.subCat) {
          parentIdx = stripped.findIndex((r) => r.is_aggregate && r.sub_category_name === pinned!.sub_category_name);
        } else if (collapse.category) {
          parentIdx = stripped.findIndex((r) => r.is_aggregate && r.group_name === pinned!.group_name);
        } else if (collapse.allCustomersPerCategory) {
          parentIdx = stripped.findIndex((r) => r.is_aggregate && r.group_name === pinned!.group_name);
        } else if (collapse.allCustomersPerSubCat) {
          parentIdx = stripped.findIndex((r) => r.is_aggregate && r.sub_category_name === pinned!.sub_category_name);
        } else if (collapse.allCustomersPerStyle) {
          parentIdx = stripped.findIndex((r) => r.is_aggregate && (r.sku_style ?? r.sku_code) === (pinned!.sku_style ?? pinned!.sku_code));
        } else if (collapse.customerAllStyles) {
          parentIdx = stripped.findIndex((r) => r.is_aggregate && r.customer_id === pinned!.customer_id);
        }
        if (parentIdx >= 0) {
          base = [...stripped.slice(0, parentIdx + 1), pinned, ...stripped.slice(parentIdx + 1)];
        } else {
          // No collapsed parent to anchor against — pin to top.
          base = [pinned, ...stripped];
        }
      }
    }
    return { displayRows: base, childIds: ids };
  }, [filtered, expandedAggs, manuallyCollapsedAggs, mutedById, skuPeriodMath, lastAddedTbdMarker, rows, collapse, search, sortKey, sortDir]);

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
      <style>{`
        /* High-contrast selection highlight on the planning search
           inputs so the planner immediately sees that the existing
           text is selected and a single keystroke will replace it. */
        .ip-search-input::selection {
          background: ${PAL.yellow};
          color: #000;
        }
        .ip-search-input::-moz-selection {
          background: ${PAL.yellow};
          color: #000;
        }
        /* Aggregate-row underline. Each level of element draws its own
           underline so currentColor resolves at THAT element's color
           (greens green-underlined, reds red-underlined, etc.).
           Inline-block children (spans like the editable Unit Cost
           display) create a boundary that the parent td's underline
           can't visually cross — without their own text-decoration
           they appear un-underlined.
           Inputs are replaced elements: CSS text-decoration doesn't
           paint on their value. We swap for a matching border-bottom
           and explicitly clear text-decoration to avoid stacking the
           parent's underline on top of the border. */
        tr[data-agg="1"] td {
          text-decoration: underline currentColor 1px !important;
          text-underline-offset: 2px;
          font-size: 13px;
          line-height: 1.4;
        }
        tr[data-agg="1"] td *:not(input) {
          text-decoration: underline currentColor 1px !important;
          text-decoration-color: currentColor !important;
          font-size: inherit;
        }
        /* The td's text-decoration draws an underline below the line of
           inline content, which already passes visually under the input
           box — no need for an extra border-bottom on the input itself
           (that produced a second stacked line on Buyer / Override / Buy). */
        tr[data-agg="1"] input {
          border-bottom: none !important;
        }
      `}</style>
      {pendingConfirm && (
        <div
          onClick={pendingConfirm.onCancel}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
            zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: PAL.panel, color: PAL.text,
              border: `1px solid ${PAL.yellow}`, borderRadius: 12,
              padding: 20, width: "min(480px, 90vw)",
              boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24, borderRadius: 12,
                background: PAL.yellow, color: "#000", fontWeight: 800, fontSize: 14,
              }}>!</span>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{pendingConfirm.title}</div>
            </div>
            <div style={{ fontSize: 13, color: PAL.textDim, lineHeight: 1.5, whiteSpace: "pre-wrap", marginBottom: 16 }}>
              {pendingConfirm.body}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" style={{ ...S.btnSecondary }} onClick={pendingConfirm.onCancel}>Cancel</button>
              <button
                type="button"
                style={{ ...S.btnPrimary, background: PAL.yellow, color: "#000", borderColor: PAL.yellow }}
                onClick={pendingConfirm.onConfirm}
              >{pendingConfirm.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}
      {colorEditBlocked && (
        <div
          onClick={() => setColorEditBlocked(false)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
            zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: PAL.panel, color: PAL.text,
              border: `1px solid ${PAL.red}`, borderRadius: 12,
              padding: 20, width: "min(480px, 90vw)",
              boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24, borderRadius: 12,
                background: PAL.red, color: "#000", fontWeight: 800, fontSize: 14,
              }}>!</span>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Color can't be changed on this row</div>
            </div>
            <div style={{ fontSize: 13, color: PAL.textDim, lineHeight: 1.5, marginBottom: 16 }}>
              Color edits are locked to the <strong style={{ color: PAL.text }}>first row</strong> (earliest period) of a NEW style. Changing color on a later period would propagate to every period of the style and overwrite the planner's per-period work.
              <div style={{ marginTop: 10, color: PAL.textMuted, fontSize: 12 }}>
                To change the color for the whole NEW style, edit the first-period row. To split into a different colorway, use <strong style={{ color: PAL.text }}>+ Add row</strong> with a new color value.
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                style={{ ...S.btnPrimary, background: PAL.red, color: "#000", borderColor: PAL.red }}
                onClick={() => setColorEditBlocked(false)}
              >Got it</button>
            </div>
          </div>
        </div>
      )}
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
        <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
          <input
            className="ip-search-input"
            style={{ ...S.input, width: 220, padding: "6px 32px 6px 12px", fontSize: 12 }}
            placeholder="Search customer / SKU / category"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={(e) => {
              // Select-all only on initial focus (when the input
              // wasn't already active). Subsequent clicks inside an
              // already-focused input position the cursor normally
              // — the planner can click between characters without
              // losing their place.
              if (e.currentTarget.value) {
                const el = e.currentTarget;
                setTimeout(() => el.select(), 0);
              }
            }}
          />
          {search && (
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); setSearch(""); }}
              title="Clear search"
              aria-label="Clear search"
              style={{
                position: "absolute",
                right: 6,
                top: "50%",
                transform: "translateY(-50%)",
                width: 22, height: 22, padding: 0,
                border: `1px solid ${PAL.border}`,
                background: PAL.bg,
                color: PAL.text,
                cursor: "pointer",
                fontSize: 13, fontWeight: 700, lineHeight: 1,
                borderRadius: 4,
              }}
            >×</button>
          )}
        </div>
        <MultiSelectDropdown
          compact
          selected={filterCustomer}
          onChange={setFilterCustomer}
          allLabel="All customers"
          placeholder="Search customers…"
          options={customers.map((c) => ({ value: c.id, label: c.name }))}
        />
        <MultiSelectDropdown
          compact
          selected={filterStyle}
          onChange={setFilterStyle}
          allLabel="All styles"
          placeholder="Search styles…"
          options={styles.map((s) => ({ value: s, label: s }))}
        />
        <MultiSelectDropdown
          compact
          selected={filterCategory}
          onChange={setFilterCategory}
          allLabel="All categories"
          placeholder="Search categories…"
          options={groupNames.map((g) => ({ value: g, label: g }))}
        />
        <MultiSelectDropdown
          compact
          selected={filterSubCat}
          onChange={setFilterSubCat}
          allLabel="All sub cats"
          placeholder="Search sub cats…"
          options={subCategoryNames.map((s) => ({ value: s, label: s }))}
        />
        <MultiSelectDropdown
          compact
          selected={filterColor}
          onChange={setFilterColor}
          allLabel="All colors"
          placeholder="Search colors…"
          options={colorOptions.map((c) => ({ value: c, label: c }))}
          title="Color filter — scoped to the selected category + sub-cat. Includes planner-added NEW colors."
        />
        <MultiSelectDropdown
          compact
          selected={filterGender}
          onChange={setFilterGender}
          allLabel="All genders"
          placeholder="Search genders…"
          options={genders.map((g) => ({ value: g, label: genderLabel(g) }))}
          title="Gender filter — sourced from item-master GenderCode. No grid column rendered."
        />
        <MultiSelectDropdown
          compact
          selected={filterAction}
          onChange={setFilterAction}
          allLabel="All actions"
          placeholder="Search actions…"
          options={["buy", "expedite", "reduce", "hold", "monitor"].map((a) => ({ value: a, label: a }))}
        />
        <MultiSelectDropdown
          compact
          selected={filterConfidence}
          onChange={setFilterConfidence}
          allLabel="All confidence"
          placeholder="Search confidence…"
          options={["committed", "probable", "possible", "estimate"].map((c) => ({ value: c, label: c }))}
        />
        <MultiSelectDropdown
          compact
          selected={filterMethod}
          onChange={setFilterMethod}
          allLabel="All methods"
          placeholder="Search methods…"
          options={Object.keys(METHOD_LABEL).map((m) => ({ value: m, label: METHOD_LABEL[m] }))}
        />
        <MultiSelectDropdown
          compact
          selected={filterPeriod}
          onChange={setFilterPeriod}
          allLabel="All periods"
          placeholder="Search periods…"
          options={periods.map((p) => ({ value: p, label: formatPeriodCode(p) }))}
        />
        <button style={{ ...S.btnSecondary, padding: "5px 10px", fontSize: 12 }} onClick={() => {
          setSearch("");
          setFilterCustomer([]); setFilterCategory([]); setFilterSubCat([]); setFilterGender([]); setFilterPeriod([]); setFilterStyle([]); setFilterColor([]);
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

      <div style={{ ...S.toolbar, marginTop: -4, paddingTop: 0, gap: 10, fontSize: 12, color: PAL.textDim }}>
        <span style={{ fontWeight: 600 }}>Collapse:</span>
        <MultiSelectDropdown
          compact
          closeOnMouseLeave
          selected={currentCollapseKeys}
          onChange={(next) => setCollapse(applyCollapseKeys(next))}
          allLabel="None"
          placeholder="Search collapse modes…"
          options={COLLAPSE_OPTIONS}
          minWidth={210}
        />
        {anyCollapsed && (
          <button style={{ ...S.btnSecondary, fontSize: 11, padding: "2px 8px" }}
                  onClick={() => setCollapse({ customers: false, colors: false, category: false, subCat: false, customerAllStyles: false, allCustomersPerCategory: false, allCustomersPerSubCat: false, allCustomersPerStyle: false })}>
            Reset
          </button>
        )}
        {anyCollapsed && (
          <span style={{ color: PAL.textMuted, fontStyle: "italic" }}>
            Aggregate rows are read-only — drill in by clearing the toggles.
          </span>
        )}
      </div>

      {/* Add Row strip — sits above the table. Collapsed by default;
          expands to a row of pickers (cat, sub-cat, customer, period)
          that compose into a fresh (Supply Only) TBD line. Style +
          color hardcoded to "TBD" per the planner's spec. */}
      {onAddTbdRow && (
        <div style={{ marginBottom: 8 }}>
          {!addRowOpen ? (
            <>
            <button
              type="button"
              onClick={() => {
                // Seed the draft from the toolbar filters so the
                // planner doesn't have to re-pick what they already
                // narrowed to. Multi-selects collapse to the first
                // value; period defaults to the toolbar's filter
                // when one is selected, otherwise the first period
                // of the run. Customer defaults to (Supply Only)
                // when the planner hasn't filtered to a specific
                // customer — most + Add rows are stock-buy slots
                // under the synthetic placeholder customer.
                const supplyOnly = customers.find((c) => c.name === "(Supply Only)");
                setAddRowDraft({
                  customer_ids: filterCustomer.length > 0
                    ? filterCustomer
                    : (supplyOnly ? [supplyOnly.id] : []),
                  group_name: filterCategory[0] ?? null,
                  sub_category_name: filterSubCat[0] ?? null,
                  // Default to every period in the run when no period
                  // filter is active. Empty array means "all periods"
                  // both visually (renders "All periods") and at
                  // save-time (workbench falls back to every period).
                  period_codes: filterPeriod.length > 0 ? filterPeriod : [],
                  style_code: filterStyle[0] ?? "TBD",
                  color: filterColor[0] ?? "TBD",
                  is_new_color: false,
                  description: "",
                });
                setAddRowOpen(true);
              }}
              style={{
                background: "transparent",
                border: `1px dashed ${PAL.border}`,
                color: PAL.textDim,
                borderRadius: 8,
                padding: "6px 14px",
                fontSize: 12,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
              title="Add a new TBD stock-buy row. Style + Color default to TBD; you can edit them after saving."
            >
              + Add row
            </button>
              {lastAddedTbdMarker && onUndoLastAdd && (
                <button
                  type="button"
                  onClick={() => { void onUndoLastAdd(); }}
                  style={{
                    background: "transparent",
                    border: `1px solid ${PAL.yellow}`,
                    color: PAL.yellow,
                    borderRadius: 8,
                    padding: "6px 14px",
                    fontSize: 12,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    marginLeft: 8,
                  }}
                  title="Undo the most recent + Add row. The row will be deleted."
                >
                  ↶ Undo
                </button>
              )}
            </>
          ) : (
            <div style={{
              background: PAL.panel,
              border: `1px solid ${PAL.accent}`,
              borderRadius: 10,
              padding: "10px 14px",
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap" as const,
              fontSize: 12,
            }}>
              <span style={{ fontWeight: 600, color: PAL.accent }}>+ New TBD row</span>
              {/* Copy from top row — pulls dimensions from displayRows[0]
                  so the planner can quickly clone the topmost visible
                  row's setup (style, color, customer, description,
                  category, sub-cat) into the form. The grid's sort +
                  filters drive what "top" means; planners typically
                  search/sort to expose the row they want to copy. */}
              <button
                type="button"
                onClick={() => {
                  const top = displayRows[0];
                  if (!top) return;
                  setAddRowDraft((d) => ({
                    ...d,
                    style_code: top.sku_style ?? "TBD",
                    color: top.sku_color ?? "TBD",
                    is_new_color: !!top.is_new_color,
                    description: top.sku_description ?? "",
                    customer_ids: top.customer_id ? [top.customer_id] : d.customer_ids,
                    group_name: top.group_name ?? d.group_name,
                    sub_category_name: top.sub_category_name ?? d.sub_category_name,
                  }));
                }}
                disabled={displayRows.length === 0}
                title={displayRows.length === 0
                  ? "No row visible to copy from."
                  : `Copy style / color / customer / description / category / sub-cat from the top row (${displayRows[0]?.sku_style ?? "TBD"} / ${displayRows[0]?.sku_color ?? "TBD"} / ${displayRows[0]?.customer_name ?? ""}).`}
                style={{
                  ...S.btnSecondary,
                  padding: "4px 10px",
                  fontSize: 11,
                  opacity: displayRows.length === 0 ? 0.5 : 1,
                  cursor: displayRows.length === 0 ? "not-allowed" : "pointer",
                }}
              >
                ⎘ Copy top row
              </button>
              <MultiSelectDropdown
                compact
                singleSelect
                selected={addRowDraft.group_name ? [addRowDraft.group_name] : []}
                onChange={(next) => setAddRowDraft((d) => ({ ...d, group_name: next[0] ?? null }))}
                allLabel="Category"
                placeholder="Search categories…"
                options={groupNames.map((g) => ({ value: g, label: g }))}
              />
              <MultiSelectDropdown
                compact
                singleSelect
                selected={addRowDraft.sub_category_name ? [addRowDraft.sub_category_name] : []}
                onChange={(next) => setAddRowDraft((d) => ({ ...d, sub_category_name: next[0] ?? null }))}
                allLabel="Sub Cat"
                placeholder="Search sub cats…"
                options={subCategoryNames.map((s) => ({ value: s, label: s }))}
              />
              <span style={{ color: PAL.textMuted, fontSize: 11 }}>Style:</span>
              {/* Style — reuse the in-grid TbdStyleCell so the form's
                  picker is byte-for-byte identical to the grid's
                  (same colors, search bar, "Add as NEW" footer).
                  Scoped to the form's selected category when one is
                  picked; falls back to every style in the run when
                  the planner hasn't narrowed the category yet. Defaults
                  to TBD; the planner can pick TBD explicitly to keep
                  it as a catch-all stock-buy slot. */}
              {(() => {
                const masterStylesLowerSet = new Set((masterStyles ?? []).map((m) => m.style_code.toLowerCase()));
                const userAddedStylesSet = new Set<string>();
                for (const x of rows) {
                  if (x.is_tbd && x.sku_style && x.sku_style !== "TBD"
                      && !masterStylesLowerSet.has(x.sku_style.toLowerCase())) {
                    userAddedStylesSet.add(x.sku_style);
                  }
                }
                const allStylesLower = new Set<string>([
                  ...masterStylesLowerSet,
                  ...Array.from(userAddedStylesSet).map((s) => s.toLowerCase()),
                ]);
                const masterCategoryStyles = (masterStyles ?? [])
                  .filter((m) => !addRowDraft.group_name || m.group_name === addRowDraft.group_name)
                  .map((m) => m.style_code);
                const categoryStyles = [
                  ...masterCategoryStyles,
                  ...Array.from(userAddedStylesSet),
                ];
                const styleVal = addRowDraft.style_code || "TBD";
                const isNewStyle = styleVal !== "" && styleVal.toLowerCase() !== "tbd"
                  && !masterStylesLowerSet.has(styleVal.toLowerCase());
                return (
                  <TbdStyleCell
                    value={styleVal}
                    isNewStyle={isNewStyle}
                    categoryStyles={categoryStyles}
                    allKnownStylesLower={allStylesLower}
                    masterStylesLower={masterStylesLowerSet}
                    onSave={async (next) => {
                      const inherited = next !== "TBD" ? descriptionByStyle.get(next) ?? "" : "";
                      setAddRowDraft((d) => ({
                        ...d,
                        style_code: next,
                        description: d.description.trim() ? d.description : inherited,
                      }));
                    }}
                  />
                );
              })()}
              <span style={{ color: PAL.textMuted, fontSize: 11 }}>Color:</span>
              {/* Color — reuse the in-grid TbdColorCell so the form's
                  picker is byte-for-byte identical (same TBD/NEW
                  badges, search bar, "Add as NEW" footer). Scoped to
                  the form's selected category's known colors when
                  one is picked; falls back to every color in the run
                  when the category is unset. Defaults to TBD. */}
              {(() => {
                const knownColors = Array.from(
                  colorsByGroupName.get(addRowDraft.group_name ?? "—") ?? new Set<string>(),
                ).sort();
                const colorVal = addRowDraft.color || "TBD";
                const colorLower = colorVal.trim().toLowerCase();
                const inAnyMaster = colorLower !== "" && colorLower !== "tbd"
                  && (allKnownColorsLower.has(colorLower) || (masterColorsLower?.has(colorLower) ?? false));
                const styleColors = masterColorsByStyleLower?.get(addRowDraft.style_code);
                const inThisStyleMaster = colorLower !== "" && (styleColors?.has(colorLower) ?? false);
                const isNewForStyle = !addRowDraft.is_new_color && inAnyMaster && !inThisStyleMaster;
                return (
                  <TbdColorCell
                    value={colorVal}
                    isNewColor={!!addRowDraft.is_new_color}
                    isNewForStyle={isNewForStyle}
                    knownColors={knownColors}
                    allKnownColorsLower={allKnownColorsLower}
                    masterColorsLower={masterColorsLower}
                    onSave={async (color, isNew) => {
                      setAddRowDraft((d) => ({ ...d, color, is_new_color: isNew }));
                    }}
                  />
                );
              })()}
              <input
                type="text"
                placeholder="Description"
                value={addRowDraft.description}
                onChange={(e) => setAddRowDraft((d) => ({ ...d, description: e.target.value }))}
                style={{ ...S.input, minWidth: 160, fontSize: 12, padding: "4px 8px" }}
                title="Optional. Shows in the Description column with a NEW badge until the master gets one."
              />
              {/* Customers — multi-select. Each selected customer
                  combined with each selected period yields one new
                  row, so picking 3 customers × 4 periods creates 12
                  rows. The save handler shows a confirm modal before
                  going through. */}
              <MultiSelectDropdown
                compact
                selected={addRowDraft.customer_ids}
                onChange={(next) => setAddRowDraft((d) => ({ ...d, customer_ids: next }))}
                allLabel="Customer"
                placeholder="Search customers…"
                options={customers.map((c) => ({ value: c.id, label: c.name }))}
                title="Pick one or more customers. Each customer × period combo creates a row."
              />
              {/* Periods — multi-select. Empty selection = every
                  period in the run (default). Pick a subset to limit
                  the add to those months only. One row per chosen
                  period; no automatic sibling-period cloning. */}
              <MultiSelectDropdown
                compact
                selected={addRowDraft.period_codes}
                onChange={(next) => setAddRowDraft((d) => ({ ...d, period_codes: next }))}
                allLabel="All periods"
                placeholder="Search periods…"
                options={periods.map((p) => ({ value: p, label: formatPeriodCode(p) }))}
                title="Pick which periods to add a row in. Leave empty for every period in the run."
              />
              <button
                type="button"
                disabled={addRowSaving || addRowDraft.customer_ids.length === 0}
                onClick={async () => {
                  if (!onAddTbdRow) return;
                  // Resolve effective period count for the confirm
                  // message. Empty period_codes means "all periods".
                  const periodCount = addRowDraft.period_codes.length > 0
                    ? addRowDraft.period_codes.length
                    : periods.length;
                  const customerCount = addRowDraft.customer_ids.length;
                  const totalRows = customerCount * periodCount;
                  const customerNames = addRowDraft.customer_ids
                    .map((id) => customers.find((c) => c.id === id)?.name ?? id)
                    .slice(0, 3);
                  const customerSummary = addRowDraft.customer_ids.length > 3
                    ? `${customerNames.join(", ")} +${addRowDraft.customer_ids.length - 3} more`
                    : customerNames.join(", ");
                  const periodSummary = addRowDraft.period_codes.length > 0
                    ? addRowDraft.period_codes.map(formatPeriodCode).join(", ")
                    : "every period in the run";
                  const ok = await askConfirm(
                    `Create ${totalRows} TBD row${totalRows === 1 ? "" : "s"}?`,
                    `${totalRows} row${totalRows === 1 ? "" : "s"} will be created — ${customerCount} customer${customerCount === 1 ? "" : "s"} (${customerSummary}) × ${periodCount} period${periodCount === 1 ? "" : "s"} (${periodSummary}).\n\nStyle: ${addRowDraft.style_code || "TBD"} · Color: ${addRowDraft.color || "TBD"}${addRowDraft.description.trim() ? ` · Description: ${addRowDraft.description.trim()}` : ""}`,
                    "Create rows",
                  );
                  if (!ok) return;
                  setAddRowSaving(true);
                  try {
                    await onAddTbdRow({
                      style_code: addRowDraft.style_code || "TBD",
                      color: addRowDraft.color || "TBD",
                      is_new_color: addRowDraft.is_new_color,
                      customer_ids: addRowDraft.customer_ids,
                      group_name: addRowDraft.group_name,
                      sub_category_name: addRowDraft.sub_category_name,
                      period_codes: addRowDraft.period_codes,
                      notes: addRowDraft.description.trim() || null,
                    });
                  } catch { /* error toast surfaces from workbench */ }
                  finally {
                    // Close the form whether or not the save succeeded —
                    // a lingering open form after an error toast is more
                    // confusing than a re-open required to retry.
                    setAddRowOpen(false);
                    setAddRowSaving(false);
                  }
                }}
                style={{
                  ...S.btnPrimary,
                  padding: "5px 14px",
                  fontSize: 12,
                  opacity: addRowSaving || addRowDraft.customer_ids.length === 0 ? 0.5 : 1,
                  cursor: addRowSaving || addRowDraft.customer_ids.length === 0 ? "not-allowed" : "pointer",
                }}
              >
                {addRowSaving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => setAddRowOpen(false)}
                style={{ ...S.btnSecondary, padding: "5px 12px", fontSize: 12 }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <Th label="Category"    k="category"    sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("category")} />
              <Th label="Sub Cat"     k="subCat"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("subCat")} />
              <Th label="Style"       k="style"       sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("style")} />
              <Th label="Description" k="description" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("description")} />
              <Th label="Color"       k="color"       sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("color")} />
              <Th label="Customer"    k="customer"    sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("customer")} />
              <Th label="Period"      k="period"      sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} hidden={hiddenColumns.has("period")} />
              <Th label="Class"       k="class"       sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} title="ABC volume rank × XYZ demand variability" hidden={hiddenColumns.has("class")} />
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
            {displayRows.slice(page * pageSize, (page + 1) * pageSize).map((r) => {
              const isChild = childIds.has(r.forecast_id);
              const aggExpansionKey = r.aggregate_key ?? r.forecast_id;
              const isExpanded = r.is_aggregate && expandedAggs.has(aggExpansionKey);
              const rowKey = (r as IpPlanningGridRow & { _displayKey?: string })._displayKey ?? r.forecast_id;
              // Aggregate row visual treatment — distinctly tinted from
              // the panel background so the planner can spot rolled-up
              // rows at a glance, with a left accent bar that intensifies
              // when expanded. Uses the app's accent colors (green when
              // collapsed, blue when drilled-in) at higher opacity than
              // the previous near-invisible white tint. Content keeps
              // the same color family as child rows; weight goes bold
              // for emphasis.
              const aggBg = isExpanded
                ? `${PAL.accent}26`     // blue ~15% — drilled-in
                : `${PAL.accent2}1F`;   // green ~12% — rolled-up
              const aggBar = isExpanded ? PAL.accent : `${PAL.accent2}99`;
              return (
              <tr
                key={rowKey}
                data-agg={r.is_aggregate ? "1" : undefined}
                onContextMenu={(e) => { e.preventDefault(); if (!r.is_aggregate) onSelectRow(r); }}
                title={
                  r.is_user_added ? "Planner-added TBD row — click ✕ at the row tail to delete"
                  : r.is_aggregate ? "Click chevron to drill in"
                  : "Right-click for more info"
                }
                style={
                  // is_user_added wins over the other tints because
                  // the planner needs to spot their own rows quickly
                  // even when they're aggregates of multiple sizes.
                  r.is_user_added ? {
                    background: `${PAL.accent2}11`,
                    boxShadow: `inset 4px 0 0 ${PAL.accent2}`,
                  }
                  : r.is_aggregate ? {
                    background: aggBg,
                    boxShadow: `inset 3px 0 0 ${aggBar}`,
                    color: PAL.textDim,
                    fontWeight: 700,
                    fontStyle: "italic",
                    textDecoration: "underline",
                    // currentColor → underline matches whatever color the
                    // cell's text is rendered in. Greens stay green,
                    // chips' colors stay theirs, etc. Cleaner than a
                    // hard-coded accent tint that fights every cell.
                    textDecorationColor: "currentColor",
                    textDecorationThickness: 1,
                    textUnderlineOffset: 2,
                  }
                  : isChild ? { background: "rgba(255,255,255,0.015)", color: PAL.textDim }
                  : undefined
                }
              >
                <td style={{ ...S.td, color: PAL.textDim, ...colHide("category") }}>{r.group_name ?? "–"}</td>
                <td style={{ ...S.td, color: PAL.textDim, ...colHide("subCat") }}>{r.sub_category_name ?? "–"}</td>
                <td style={{ ...S.td, fontFamily: "monospace", color: PAL.accent, paddingLeft: (isChild || r.is_user_added) ? 28 : undefined, ...colHide("style") }} onClick={(e) => { if (r.is_tbd) e.stopPropagation(); }}>
                  {r.is_aggregate && (
                    <span
                      onClick={(e) => { e.stopPropagation(); toggleAggExpanded(aggExpansionKey); }}
                      style={{ cursor: "pointer", display: "inline-block", width: 14, color: PAL.textMuted, userSelect: "none", transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
                      title={isExpanded ? "Collapse" : "Drill into this row"}
                    >▶</span>
                  )}
                  {!r.is_aggregate && r.is_tbd && r.is_user_added && onUpdateTbdStyle && masterStyles ? (() => {
                    // Editable style picker only on planner-added rows.
                    // Auto-synthesized per-style and per-period catch-
                    // all rows show the style as plain text — they're
                    // standing infrastructure, not free-form entries.
                    //
                    // Derive the orange "NEW" badge at render time:
                    // a style is NEW when it isn't in masterStyles
                    // (any category). The literal "TBD" placeholder
                    // is never NEW.
                    //
                    // The dropdown's searchable list also includes
                    // any planner-added styles already in the run,
                    // so adding a second row with the same NEW style
                    // surfaces it in the list (no second "Add as
                    // NEW" prompt for a style the planner just typed).
                    const styleVal = r.sku_style ?? "TBD";
                    const styleLower = styleVal.trim().toLowerCase();
                    const masterStylesLower = new Set(masterStyles.map((m) => m.style_code.toLowerCase()));
                    const userAddedStyles = new Set<string>();
                    for (const x of rows) {
                      if (x.is_tbd && x.sku_style && x.sku_style !== "TBD"
                          && !masterStylesLower.has(x.sku_style.toLowerCase())) {
                        userAddedStyles.add(x.sku_style);
                      }
                    }
                    const allStylesLower = new Set([
                      ...masterStylesLower,
                      ...Array.from(userAddedStyles).map((s) => s.toLowerCase()),
                    ]);
                    const isNewStyle = styleLower !== "" && styleLower !== "tbd" && !masterStylesLower.has(styleLower);
                    const masterCategoryStyles = masterStyles
                      .filter((m) => !r.group_name || m.group_name === r.group_name)
                      .map((m) => m.style_code);
                    const categoryStyles = [
                      ...masterCategoryStyles,
                      ...Array.from(userAddedStyles),
                    ];
                    return (
                      <TbdStyleCell
                        value={styleVal}
                        isNewStyle={isNewStyle}
                        categoryStyles={categoryStyles}
                        allKnownStylesLower={allStylesLower}
                        masterStylesLower={masterStylesLower}
                        onSave={(styleCode) => onUpdateTbdStyle(r, styleCode)}
                      />
                    );
                  })() : (
                    r.sku_style ?? r.sku_code
                  )}
                </td>
                <td
                  style={{ ...S.td, color: PAL.textDim, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: !r.is_aggregate && r.is_tbd && r.is_user_added ? "0 4px" : undefined, ...colHide("description") }}
                  title={r.sku_description ?? ""}
                  onClick={(e) => { if (r.is_tbd) e.stopPropagation(); }}
                >
                  {!r.is_aggregate && r.is_tbd && r.is_user_added && onUpdateTbdDescription ? (
                    <TbdDescriptionCell
                      value={r.sku_description ?? ""}
                      isNew={!!r.is_new_description}
                      knownDescriptions={knownDescriptions}
                      masterDescriptionsLower={masterDescriptionsLower}
                      onSave={(d) => onUpdateTbdDescription(r, d)}
                    />
                  ) : (
                    r.sku_description ?? "—"
                  )}
                </td>
                <td style={{ ...S.td, color: PAL.textDim, padding: r.is_tbd ? "0 4px" : undefined, ...colHide("color") }} onClick={(e) => { if (r.is_tbd) e.stopPropagation(); }}>
                  {!r.is_aggregate && r.is_tbd && onUpdateTbdColor ? (() => {
                    // Derive the green "NEW for this style" flag at
                    // render time. The orange "NEW COLOR" flag
                    // (is_new_color) is set + persisted at save
                    // time; this one is purely display-derived from
                    // master state, so renaming the color or moving
                    // a row's style updates the badge instantly.
                    const colorLower = (r.sku_color ?? "").trim().toLowerCase();
                    const styleColors = masterColorsByStyleLower?.get(r.sku_style ?? "");
                    const inAnyMaster = colorLower !== "" && colorLower !== "tbd"
                      && (allKnownColorsLower.has(colorLower) || (masterColorsLower?.has(colorLower) ?? false));
                    const inThisStyleMaster = colorLower !== "" && (styleColors?.has(colorLower) ?? false);
                    const isNewForStyle = !r.is_new_color && inAnyMaster && !inThisStyleMaster;
                    // Block color edits on non-first rows of NEW styles.
                    // First = earliest period_start in the NEW-style
                    // family, tied broken by tbd_id. Master-known styles
                    // and orphan rows always edit freely — no propagation
                    // happens there. Mirrors the workbench's
                    // isFirstRowOfNewStyle helper so UI + save layer
                    // agree on what counts as "first".
                    const blockColorEdit = (() => {
                      const sLower = (r.sku_style ?? "").toLowerCase();
                      if (!sLower || sLower === "tbd") return false;
                      const isMaster = (masterStyles ?? []).some((m) => m.style_code.toLowerCase() === sLower);
                      if (isMaster) return false;
                      const family = rows.filter((x) =>
                        x.is_tbd && (x.sku_style ?? "").toLowerCase() === sLower,
                      );
                      if (family.length <= 1) return false;
                      const sorted = [...family].sort((a, b) => {
                        const ps = a.period_start.localeCompare(b.period_start);
                        if (ps !== 0) return ps;
                        return (a.tbd_id ?? "").localeCompare(b.tbd_id ?? "");
                      });
                      return sorted[0].forecast_id !== r.forecast_id;
                    })();
                    return (
                      <TbdColorCell
                        value={r.sku_color ?? "TBD"}
                        isNewColor={!!r.is_new_color}
                        isNewForStyle={isNewForStyle}
                        knownColors={Array.from(colorsByGroupName.get(r.group_name ?? "—") ?? new Set<string>()).sort()}
                        allKnownColorsLower={allKnownColorsLower}
                        masterColorsLower={masterColorsLower}
                        onSave={(color, isNew) => onUpdateTbdColor(r, color, isNew)}
                        blocked={blockColorEdit}
                        onBlocked={() => setColorEditBlocked(true)}
                      />
                    );
                  })() : (
                    <>
                      {r.sku_color ?? "—"}
                      {r.sku_color_inferred && (
                        <span
                          style={{ marginLeft: 6, color: PAL.yellow, cursor: "help", fontSize: 11 }}
                          title="Color inferred from sku_code suffix — variant master row has no color set. Populate items.color upstream to silence this hint."
                        >⚠</span>
                      )}
                    </>
                  )}
                </td>
                <td style={{ ...S.td, padding: r.is_tbd ? "0 4px" : undefined, ...colHide("customer") }} onClick={(e) => { if (r.is_tbd) e.stopPropagation(); }}>
                  {!r.is_aggregate && r.is_tbd && onUpdateTbdCustomer ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <TbdCustomerCell
                        value={r.customer_name}
                        isSupplyOnly={r.customer_name === "(Supply Only)"}
                        isNewCustomer={!!(r.customer_id && newCustomerIds?.has(r.customer_id))}
                        customers={customers}
                        newCustomerIds={newCustomerIds}
                        onSave={(id, name) => onUpdateTbdCustomer(r, id, name)}
                        onAddNew={onAddTbdNewCustomer ? (name) => onAddTbdNewCustomer(r, name) : undefined}
                      />
                      {r.is_user_added && onDeleteTbdRow && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void onDeleteTbdRow(r); }}
                          title="Delete this planner-added row"
                          style={{
                            background: "transparent",
                            border: `1px solid ${PAL.red}`,
                            color: PAL.red,
                            borderRadius: 6,
                            padding: "1px 6px",
                            fontSize: 11,
                            cursor: "pointer",
                            fontFamily: "inherit",
                            lineHeight: 1.2,
                          }}
                        >
                          ✕
                        </button>
                      )}
                    </span>
                  ) : (
                    r.customer_name
                  )}
                </td>
                <td style={{ ...S.td, ...colHide("period") }}>{formatPeriodCode(r.period_code)}</td>
                <td style={{ ...S.td, color: PAL.textDim, fontFamily: "monospace", fontSize: 11, ...colHide("class") }}
                    title={r.abc_class && r.xyz_class
                      ? `ABC ${r.abc_class} (volume rank) × XYZ ${r.xyz_class} (demand variability)`
                      : "Not classified — no trailing sales"}
                >
                  {r.abc_class && r.xyz_class ? `${r.abc_class}${r.xyz_class}` : "—"}
                </td>
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
                <td style={{ ...S.tdNum, padding: "0 4px", ...colHide("buyer") }} onClick={(e) => e.stopPropagation()}>
                  <IntCell
                    value={r.buyer_request_qty}
                    accent={PAL.accent}
                    allowNegative={false}
                    onSave={(qty) => saveAggBuyerOrOverride(r, qty, "buyer_request_qty", onUpdateBuyerRequest, false)}
                  />
                </td>
                <td style={{ ...S.tdNum, padding: "0 4px", ...colHide("override") }} onClick={(e) => e.stopPropagation()}>
                  <IntCell
                    value={r.override_qty}
                    accent={PAL.yellow}
                    allowNegative={true}
                    onSave={(qty) => saveAggBuyerOrOverride(r, qty, "override_qty", onUpdateOverride, true)}
                  />
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
                  <BuyCell
                    value={r.planned_buy_qty}
                    onSave={(qty) => saveAggBuy(r, qty)}
                  />
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
              );
            })}
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
    case "style": {
      // Tuple compare so a colon in a style code (rare but possible)
      // can't mix the two segments, and so localeCompare's
      // "sensitivity: base" doesn't fall over the synthetic ":"
      // separator in a way that misorders nullable colors.
      const styleA = a.sku_style ?? a.sku_code;
      const styleB = b.sku_style ?? b.sku_code;
      const styleCmp = cmpStr(styleA, styleB, sign);
      if (styleCmp !== 0) return styleCmp;
      return cmpStr(a.sku_color, b.sku_color, sign);
    }
    case "color":       return cmpStr(a.sku_color, b.sku_color, sign);
    case "description": return cmpStr(a.sku_description, b.sku_description, sign);
    case "customer":    return cmpStr(a.customer_name, b.customer_name, sign);
    case "period":      return cmpStr(a.period_start, b.period_start, sign);
    case "class":       return cmpStr(`${a.abc_class ?? "Z"}${a.xyz_class ?? "Z"}`, `${b.abc_class ?? "Z"}${b.xyz_class ?? "Z"}`, sign);
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
