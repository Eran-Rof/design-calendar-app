// The main workbench table. Columns listed here are intentionally wide
// so planners can scan a row end-to-end without scrolling. Click a row to
// open the detail drawer.

import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ppkMultiplier, resolvePackSize, looksPpk } from "../../shared/prepack";
import { useArrowKeyScroll } from "../../shared/grid/useArrowKeyScroll";
import { GridScrollbarStyles } from "../../shared/grid/GridScrollbarStyles";
import type { IpPlanningGridRow } from "../types/wholesale";
import { S, PAL, ACTION_COLOR, CONFIDENCE_COLOR, METHOD_COLOR, METHOD_LABEL, formatQty, formatPeriodCode } from "../components/styles";
import { MultiSelectDropdown } from "../components/MultiSelectDropdown";
import SearchableSelect from "../../tanda/components/SearchableSelect";
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
import { usePersistedString, usePersistedStringArray, usePersistedBool, usePersistedInt } from "../hooks/usePersistedFilter";
import { aggregateRows } from "./aggregateGridRows";
import type { SortKey, SortEntry } from "./wholesale-planning/types";
import { COLLAPSE_OPTIONS, NO_COLLAPSE } from "./wholesale-planning/constants";
import {
  collapseToKeys,
  applyCollapseKeys,
  distributeAcrossChildren,
  cmpStr,
  cmpNum,
  cmpMulti,
} from "./wholesale-planning/gridUtils";
import { Th } from "./wholesale-planning/Th";
import {
  FREEZABLE_COLS,
  FREEZE_LABELS,
  TOGGLEABLE_COLUMNS,
  COLUMN_LABEL,
  genderLabel,
  type FreezeKey,
} from "./wholesale-planning/columns";
import { computeTotals } from "./wholesale-planning/computeTotals";
import { PlanningGridRow } from "./wholesale-planning/PlanningGridRow";
import { useCollapsePersistence } from "./wholesale-planning/hooks/useCollapsePersistence";
import { usePersistedHiddenColumns } from "./wholesale-planning/hooks/usePersistedHiddenColumns";
import { useAggregateExpansion } from "./wholesale-planning/hooks/useAggregateExpansion";
import { useDynamicColWidths } from "./wholesale-planning/hooks/useDynamicColWidths";
import { bucketKeyFor, type BucketKeyFilters } from "./bucketBuyKey";
import { recommendForRow } from "../compute/recommendations";
import { applyRollingPool } from "../compute/supply";
import { wholesaleRepo } from "../services/wholesalePlanningRepository";
// Right-click context menu reused verbatim from the ATS app so the
// look matches what the planner already knows. The menu expects ATS-
// shaped row + event records — we build them from the planning row +
// the lazy-fetched ip_open_purchase_orders / ip_open_sales_orders
// lines for the clicked cell.
import { SummaryContextMenu } from "../../ats/panels/ContextMenus";
import type {
  ATSRow,
  ATSPoEvent,
  ATSSoEvent,
  SummaryCtxMenu,
} from "../../ats/types";

// Stable empty fallback for the optional ppkUnitsByStyle prop so the per-row
// resolvePackSize() call doesn't allocate a fresh Map every render.
const EMPTY_PACK_MAP: Map<string, number> = new Map();

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
  // Promote a planner-added new style+color into the company masters.
  onPromoteTbdRow?: (row: IpPlanningGridRow) => Promise<void>;
  promotedTbdKeys?: Set<string>;
  // Undo the most recent + Add row from the toolbar — distinct from
  // the row-level ✕ so the planner can hit it without hunting for
  // the row when they realize they added the wrong thing.
  onUndoLastAdd?: () => Promise<void>;
  // How many "+ Add row" batches are on the undo stack (0-4). Drives the
  // toolbar Undo button's visibility + its "(N)" count.
  undoDepth?: number;
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
  // master. Drives the TBD style picker's category-wide list AND lets
  // the Category / Sub Cat filters populate before a build.
  masterStyles?: Array<{ style_code: string; group_name: string | null; sub_category_name: string | null }>;
  // Units-per-pack per PPK style_code (lowercased) from Tangerine's Prepack
  // Matrix. Supplements the SKU/size "PPKn" token when resolving the pack size
  // for the Explode-PPK eaches ⇄ packs conversion.
  ppkUnitsByStyle?: Map<string, number>;
  // Full customer master (id + name). Seeds the Customer filter so it's
  // usable before a build — without it the dropdown was empty until the
  // run's forecast was built (rows are the only other source).
  masterCustomers?: Array<{ id: string; name: string }>;
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
    customer_ids: string[] | null;
    style_code: string | null;
    style_codes: string[] | null;
    group_name: string | null;
    group_names: string[] | null;
    sub_category_name: string | null;
    sub_category_names: string[] | null;
    gender: string | null;
    genders: string[] | null;
    period_code: string | null;
    period_codes: string[] | null;
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

// Types, constants, and pure helpers have been extracted to
// ./wholesale-planning/{types,constants,gridUtils}.ts — see the
// import block above. Pure-helper unit tests live alongside in
// wholesale-planning/__tests__/gridUtils.test.ts.

// localStorage key for the persisted multi-column sort stack (same
// ws_planning_* convention as the hidden-columns preference).
const SORT_STORAGE_KEY = "ws_planning_sort_stack";

export default function WholesalePlanningGrid({ rows, runHorizon, onSelectRow, onUpdateBuyQty, onUpdateBucketBuy, onUpdateUnitCost, onUpdateBuyerRequest, onUpdateOverride, onUpdateSystemOverride, onUpdateTbdColor, onUpdateTbdStyle, onUpdateTbdCustomer, onAddTbdNewCustomer, newCustomerIds, onUpdateTbdDescription, onAddTbdRow, onDeleteTbdRow, onPromoteTbdRow, promotedTbdKeys, onUndoLastAdd, undoDepth, lastAddedTbdMarker, masterColorsLower, masterColorsByStyleLower, masterStyles, ppkUnitsByStyle, masterCustomers, onFiltersChange, headerSlot, bucketBuys, loading, systemSuggestionsOn, onSystemSuggestionsChange, onScopeChange }: WholesalePlanningGridProps) {
  // Persisted filter state — survives reloads + builds. Each slot is
  // mirrored to ws_planning_filter_<key> in localStorage so the
  // planner doesn't re-pick after a reload or rebuild.
  const [search, setSearch] = usePersistedString("search");
  // Defer the search value used by the heavy filter / aggregate
  // computations. The input keeps re-rendering with `search` so each
  // keystroke is instant; React falls behind on the filter pass with
  // `deferredSearch`, then catches up when typing pauses. Without
  // this, every keystroke (including Backspace and Enter) blocked
  // on a full filter+sort pass of thousands of rows — felt like a
  // multi-hundred-ms lag per character.
  const deferredSearch = useDeferredValue(search);
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
  // Multi-column sort stack — index 0 is the parent (primary) sort, later
  // entries are children (tie-breakers). Plain header click = single-column
  // sort; Shift+click adds/toggles a child. Defaults to a single Period sort
  // (the prior behaviour) so the initial view is unchanged. Persisted to
  // localStorage (like the hidden-columns preference) so a planner's sort
  // survives a reload. Bad/stale entries are filtered on read.
  const [sortStack, setSortStack] = useState<SortEntry[]>(() => {
    try {
      const raw = localStorage.getItem(SORT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const clean = parsed.filter(
            (e): e is SortEntry => e && typeof e.key === "string" && (e.dir === "asc" || e.dir === "desc"),
          );
          if (clean.length > 0) return clean;
        }
      }
    } catch { /* ignore malformed storage */ }
    return [{ key: "period", dir: "asc" }];
  });
  const sortSig = sortStack.map((s) => `${s.key}:${s.dir}`).join(",");
  useEffect(() => {
    try { localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sortStack)); } catch { /* ignore */ }
  }, [sortSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const [filterPeriod, setFilterPeriod] = usePersistedStringArray("period");
  const [filterStyle, setFilterStyle] = usePersistedStringArray("style");
  const [filterColor, setFilterColor] = usePersistedStringArray("color");
  // Show-zero-rows toggle. When OFF, rows where every meaningful qty
  // (forecast, buy, on_hand, on_so, on_po) is 0/null are hidden — keeps
  // the grid focused on rows the planner needs to act on. When ON, the
  // full row set is visible — useful for searching prepacks or
  // freshly-renamed SKUs that may not have data attached yet. Default
  // ON so renames / migrations don't silently disappear from the view.
  const [showZeroRows, setShowZeroRows] = usePersistedBool("showZeroRows", true);
  // Trailing-history window shown in the Hist-T column: 3 / 6 / 9 / 12 months.
  // Persisted; the value is remapped onto historical_trailing_qty below so the
  // cell, sort and column totals all follow the selection instantly.
  const [trailingWindow, setTrailingWindow] = useState<number>(() => {
    try { const v = Number(localStorage.getItem("ws_planning_trailing_window")); return [3, 6, 9, 12].includes(v) ? v : 3; } catch { return 3; }
  });
  useEffect(() => { try { localStorage.setItem("ws_planning_trailing_window", String(trailingWindow)); } catch { /* ignore */ } }, [trailingWindow]);
  // Busy flag for the "Copy Final → Buy" bulk action.
  const [copyingBuy, setCopyingBuy] = useState(false);
  // Column-totals header row — sums each numeric column across the rows in
  // view, shown under the header labels. Persisted; off by default.
  const [showColumnTotals, setShowColumnTotals] = usePersistedBool("showColumnTotals", false);
  // EXPLODE PPK toggle. When ON (default), supply-side qtys for
  // prepack rows are multiplied by units-per-pack (e.g. 5 packs of
  // PPK24 → 120 units) so the grid reads in selling units. When
  // OFF, qtys stay in pack grain. Costs invert (per-unit when ON,
  // per-pack when OFF). Demand fields (forecast / buyer / override
  // / planned_buy) are entered in selling units always and don't
  // multiply either way.
  const [explodePpk, setExplodePpk] = usePersistedBool("explodePpk", true);
  // Carton qty — rounds every quantity on a NON-prepack row UP to the next
  // whole carton (default 24) so the plan stays orderable in full cartons.
  // PPK styles keep rounding to their own pack size (that wins); a carton
  // qty of 0/1 disables the rounding. Applied both to the system-generated
  // display values and on entry in the editable cells.
  const [cartonQty, setCartonQty] = usePersistedInt("cartonQty", 24);

  // Freeze-through-column. Combined with table-layout: fixed +
  // explicit per-column widths (see dynamicColWidths inside the
  // component and the Th component below) so column widths are
  // deterministic regardless of row content. This makes
  // position: sticky on <td> cells stable across sort / filter / page
  // changes (auto-layout recomputed widths after each re-render and
  // broke the freeze visually).
  //
  // Cumulative left offsets are derived synchronously from
  // dynamicColWidths, no runtime measurement needed.
  // FREEZABLE_COLS / FREEZE_LABELS / FreezeKey moved to ./wholesale-planning/columns.
  const [freezeKey, setFreezeKey] = usePersistedString("freezeKey");
  const freezeIdxDom = freezeKey ? FREEZABLE_COLS.indexOf(freezeKey as FreezeKey) + 1 : 0;
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
    // Multi-color: each chosen color makes its own row (× customer × period).
    // is_new flags a colorway not yet in the master (badged NEW). An empty
    // list means a single TBD-color row.
    colors: Array<{ color: string; is_new: boolean }>;
    description: string;
  }>({
    customer_ids: [],
    group_name: null,
    sub_category_name: null,
    period_codes: [],
    style_code: "TBD",
    colors: [],
    description: "",
  });
  const [addRowSaving, setAddRowSaving] = useState(false);
  // Right-click context menu state, reused from the ATS app via
  // SummaryContextMenu. summaryCtx is null until the planner right-
  // clicks an On SO or Receipts cell; opening sets it (plus the
  // ATS-shaped row + event arrays the menu expects). Click-outside +
  // Escape both dismiss it via the useEffect below.
  const [summaryCtx, setSummaryCtx] = useState<SummaryCtxMenu | null>(null);
  const summaryCtxRef = useRef<HTMLDivElement>(null);
  const [summaryCtxLoading, setSummaryCtxLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(500);
  // Collapse / aggregation modes — independent toggles that change the
  // grouping key of the displayed rows. When any are on, grids show
  // aggregate rows and inline editing is disabled on those rows.
  // Persistence + the synchronous-write setter both live in the hook.
  const [collapse, setCollapse] = useCollapsePersistence();
  const anyCollapsed =
    collapse.customers || collapse.colors || collapse.category || collapse.subCat ||
    collapse.customerAllStyles || collapse.allCustomersPerCategory || collapse.allCustomersPerSubCat ||
    collapse.allCustomersPerStyle;
  const currentCollapseKeys = collapseToKeys(collapse);

  // Aggregate expansion (expanded + manually-collapsed Sets + toggle)
  // lives in a hook so the chevron-click behavior under-search-active
  // can be tested in isolation.
  const { expandedAggs, manuallyCollapsedAggs, toggleAggExpanded: toggleAggExpandedRaw } = useAggregateExpansion();
  const toggleAggExpanded = (forecastId: string) =>
    toggleAggExpandedRaw(forecastId, search.trim().length > 0);
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
  // Arrow-key scroll wired to the tableWrap div so the planner can
  // navigate the grid without clicking it first.
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  useArrowKeyScroll(tableWrapRef);
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
  useEffect(() => { setPage(0); }, [search, filterCustomer, filterCategory, filterSubCat, filterGender, filterPeriod, filterStyle, filterColor, filterAction, filterConfidence, filterMethod, sortSig, pageSize, collapse, systemSuggestionsOn, showZeroRows, explodePpk]);

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
      // Every INPUT dimension is passed as its FULL array so a filtered build
      // honors the grid's entire selection (not just the first of each). The
      // single-value fields stay for legacy callers. period_codes already did
      // this; the rest now match.
      customer_id: filterCustomer[0] ?? null,
      customer_ids: filterCustomer.length > 0 ? filterCustomer : null,
      style_code: filterStyle[0] ?? null,
      style_codes: filterStyle.length > 0 ? filterStyle : null,
      group_name: filterCategory[0] ?? null,
      group_names: filterCategory.length > 0 ? filterCategory : null,
      sub_category_name: filterSubCat[0] ?? null,
      sub_category_names: filterSubCat.length > 0 ? filterSubCat : null,
      gender: filterGender[0] ?? null,
      genders: filterGender.length > 0 ? filterGender : null,
      period_code: filterPeriod[0] ?? null,
      period_codes: filterPeriod.length > 0 ? filterPeriod : null,
      recommended_action: filterAction[0] ?? null,
      confidence_level: filterConfidence[0] ?? null,
      forecast_method: filterMethod[0] ?? null,
    });
  }, [filterCustomer, filterStyle, filterCategory, filterSubCat, filterGender, filterPeriod, filterAction, filterConfidence, filterMethod, onFiltersChange]);

  const customers = useMemo(() => {
    const s = new Map<string, string>();
    // Seed from the customer master so the filter is usable BEFORE a
    // build — an unbuilt run has no rows, so a rows-only memo left the
    // Customer dropdown empty until the planner built the forecast. The
    // master list lets them pre-scope the build by customer.
    for (const c of masterCustomers ?? []) s.set(c.id, c.name);
    // Then pull from rows so any planner-added customer that has been
    // assigned to a TBD line shows up too — the memo intentionally walks
    // every row (TBD + non-TBD) so freshly created customers don't have
    // to wait for a build to surface.
    for (const r of rows) s.set(r.customer_id, r.customer_name);
    return Array.from(s, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, masterCustomers]);

  // Categories are sourced from the item master GroupName attribute
  // (text, no FK), so the filter operates on the string directly.
  // masterStyles carries the same group_name per style straight from the
  // item master, so the Category filter populates before a build too.
  const groupNames = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.group_name) s.add(r.group_name);
    for (const m of masterStyles ?? []) if (m.group_name) s.add(m.group_name);
    return Array.from(s).sort();
  }, [rows, masterStyles]);

  // Sub cat options are scoped to the selected Category — picking
  // "Joggers" in the Category dropdown narrows the Sub Cat list to
  // only the sub cats found under Joggers. When no category is chosen,
  // every sub cat is offered. Merges master styles so sub cats are
  // pickable pre-build (same rationale as the Category filter above).
  const subCategoryNames = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) {
      if (filterCategory.length > 0 && !filterCategory.includes(r.group_name ?? "—")) continue;
      if (r.sub_category_name) s.add(r.sub_category_name);
    }
    for (const m of masterStyles ?? []) {
      if (filterCategory.length > 0 && !filterCategory.includes(m.group_name ?? "—")) continue;
      if (m.sub_category_name) s.add(m.sub_category_name);
    }
    return Array.from(s).sort();
  }, [rows, masterStyles, filterCategory]);

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
  // GENDER_LABELS + genderLabel moved to ./wholesale-planning/columns.

  // Column visibility — every column except the small lock set
  // EVERY column is toggleable. Persisted to localStorage so refresh
  // keeps the planner's preference.
  // TOGGLEABLE_COLUMNS moved to ./wholesale-planning/columns.
  // Hidden-column toggles + persistence live in usePersistedHiddenColumns.
  const { hiddenColumns, toggleColumn, resetColumns } = usePersistedHiddenColumns();
  const colHide = (key: string): React.CSSProperties | undefined =>
    hiddenColumns.has(key) ? { display: "none" } : undefined;

  // Freeze-offsets measurement removed alongside the freeze feature
  // (see comment near explodePpk above). This block measured <th>
  // widths via getBoundingClientRect to compute sticky-left offsets;
  // unnecessary now that the freeze CSS is gone.

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

  // PPK multiplier comes from the shared module (src/shared/prepack)
  // — same logic ATS uses, single source of truth.

  // Step 1: filter + mute (post-user-filters, post-system-suggestions toggle,
  // pre-aggregate, pre-roll). This is the canonical "rows in scope" set
  // used by per-row math, totals, and MonthlyTotalsCards.
  // Remap historical_trailing_qty to the selected trailing window (T3/6/9/12)
  // once, up front — every downstream consumer (filter, sort, cell, column
  // totals) reads historical_trailing_qty, so this single swap makes them all
  // reflect the toggle without touching the cell/sort/aggregate code.
  const windowedRows = useMemo(() => {
    if (trailingWindow === 3) return rows;
    return rows.map((r) => (
      r.historical_trailing_windows
        ? { ...r, historical_trailing_qty: r.historical_trailing_windows[trailingWindow] ?? r.historical_trailing_qty }
        : r
    ));
  }, [rows, trailingWindow]);

  const mutedRows = useMemo(() => {
    const q = deferredSearch.trim().toUpperCase();
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
    const base = windowedRows.filter((r) => {
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
      // Hide-zero-rows filter — drops rows where EVERY qty/value field
      // across the whole row is 0 / null. Bypassed entirely when the
      // toggle is on. Earlier this only checked 7 fields; the planner
      // pointed out that rows with non-zero receipts / system_forecast
      // / ly_reference / etc. were getting hidden, so the check now
      // covers every numeric column the grid renders.
      //
      // Planner-added TBD rows are exempt: a freshly-added row starts at
      // zero qty (the planner adds it precisely to fill in), so hiding it
      // for being empty makes their deliberate addition vanish the moment
      // any other filter narrows the view (only the single pinned row
      // survived otherwise). Same rationale as the untagged-gender bypass
      // above — never hide a row the planner explicitly created.
      if (!showZeroRows && !(r.is_tbd && r.is_user_added)) {
        const hasAnyQty =
          (r.final_forecast_qty ?? 0) !== 0 ||
          (r.system_forecast_qty ?? 0) !== 0 ||
          (r.planned_buy_qty ?? 0) !== 0 ||
          (r.on_hand_qty ?? 0) !== 0 ||
          (r.on_so_qty ?? 0) !== 0 ||
          (r.on_po_qty ?? 0) !== 0 ||
          (r.buyer_request_qty ?? 0) !== 0 ||
          (r.override_qty ?? 0) !== 0 ||
          (r.receipts_due_qty ?? 0) !== 0 ||
          (r.historical_receipts_qty ?? 0) !== 0 ||
          (r.historical_trailing_qty ?? 0) !== 0 ||
          (r.available_supply_qty ?? 0) !== 0 ||
          (r.projected_shortage_qty ?? 0) !== 0 ||
          (r.projected_excess_qty ?? 0) !== 0 ||
          (r.ly_reference_qty ?? 0) !== 0 ||
          (r.recommended_qty ?? 0) !== 0;
        if (!hasAnyQty) return false;
      }
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
    const packMap = ppkUnitsByStyle ?? new Map<string, number>();
    const expanded = base.map((r) => {
      // Resolve units-per-pack from the SKU/size "PPKn" token first, then
      // Tangerine's Prepack Matrix (digit-less styles like RYB0412PPK). 1 = not
      // a prepack (or unresolved — handled below).
      const tokenMult = ppkMultiplier(r.sku_color, r.sku_size, r.sku_description, r.sku_style, r.sku_code);
      const mult = resolvePackSize(tokenMult, r.sku_style ?? r.sku_code, packMap);
      if (mult <= 1) {
        // Non-prepack row: round the forecast / demand / buy quantities UP to
        // the next whole carton (cartonQty). PPK styles are handled below and
        // keep their own pack size — carton qty never touches them. Supply /
        // inventory columns (on_hand, on_so, receipts, ATS) are left as-is:
        // they report real quantities, not orderable cartons. A carton qty of
        // 0/1 disables the rounding.
        if (cartonQty <= 1) return r;
        const c = cartonQty;
        const up = (q: number | null | undefined): number | null => {
          if (q == null) return q ?? null;
          if (q === 0) return 0;
          const sign = q < 0 ? -1 : 1;
          return sign * Math.ceil(Math.abs(q) / c) * c;
        };
        const system_forecast_qty = up(r.system_forecast_qty) ?? 0;
        const buyer_request_qty = up(r.buyer_request_qty) ?? 0;
        const override_qty = up(r.override_qty) ?? 0;
        return {
          ...r,
          system_forecast_qty,
          // Round the suggestion too so the System cell's overridden check
          // (value vs. original) compares like-for-like in carton grain.
          system_forecast_qty_original: up(r.system_forecast_qty_original) ?? 0,
          buyer_request_qty,
          override_qty,
          final_forecast_qty: Math.max(0, system_forecast_qty + buyer_request_qty + override_qty),
          planned_buy_qty: up(r.planned_buy_qty),
          recommended_qty: up(r.recommended_qty),
        };
      }
      if (explodePpk) {
        // Explode ON → everything in selling units (eaches). Supply is Xoro-
        // native pack grain, so multiply it up; costs are per-pack, so divide.
        // Demand + Buy are already entered in eaches, so they pass through.
        const divCost = (c: number | null | undefined): number | null => {
          if (c == null) return c ?? null;
          return c / mult;
        };
        // unit_cost may be a planner-entered override (already in unit terms)
        // OR derived from the master's pack-cost. Only divide when there's no
        // override — preserves overrides as-is.
        const unit_cost = r.unit_cost_override != null ? r.unit_cost : divCost(r.unit_cost);
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
      }
      // Explode OFF → everything in PACK grain. Supply + costs are already
      // Xoro-native packs, so they pass through. Demand + Buy + demand-history
      // are stored in eaches, so divide them down to packs for display (round-
      // to-pack on entry keeps these whole; a stray remainder rounds to the
      // nearest pack). system_forecast_qty_original is divided too so the
      // System cell's override math (value vs. original) stays in one grain.
      const toPacks = (q: number | null | undefined): number => q == null ? 0 : Math.round(q / mult);
      const toPacksN = (q: number | null | undefined): number | null => q == null ? q ?? null : Math.round(q / mult);
      const system_forecast_qty = toPacks(r.system_forecast_qty);
      const buyer_request_qty = toPacks(r.buyer_request_qty);
      const override_qty = toPacks(r.override_qty);
      return {
        ...r,
        system_forecast_qty,
        system_forecast_qty_original: toPacks(r.system_forecast_qty_original),
        buyer_request_qty,
        override_qty,
        final_forecast_qty: Math.max(0, system_forecast_qty + buyer_request_qty + override_qty),
        planned_buy_qty: toPacksN(r.planned_buy_qty),
        recommended_qty: toPacksN(r.recommended_qty),
        historical_trailing_qty: toPacksN(r.historical_trailing_qty),
        ly_reference_qty: toPacksN(r.ly_reference_qty),
      };
    });
    return systemSuggestionsOn ? expanded : expanded.map((r) => ({
      ...r,
      system_forecast_qty: 0,
      final_forecast_qty: Math.max(0, 0 + r.buyer_request_qty + r.override_qty),
    }));
  }, [windowedRows, deferredSearch, filterCustomer, filterCategory, filterSubCat, filterGender, filterPeriod, filterStyle, filterColor, filterAction, filterConfidence, filterMethod, systemSuggestionsOn, showZeroRows, explodePpk, ppkUnitsByStyle, cartonQty]);

  // Bulk "Copy Final → Buy": set Buy = Final for every row currently in view
  // (i.e. matching the active filters/search), so the planner can seed the buy
  // plan from the forecast in one click instead of typing each cell. Scoped to
  // mutedRows (the filtered base rows, pre-aggregation) and batched to avoid a
  // thundering herd of PATCHes. Only rows whose Buy differs from Final are sent.
  async function copyFinalToBuy() {
    if (copyingBuy) return;
    const targets = mutedRows.filter((r) => r.forecast_id && (r.final_forecast_qty ?? 0) !== (r.planned_buy_qty ?? 0));
    if (targets.length === 0) {
      await askConfirm("Nothing to copy", "Every row in view already has Buy equal to its Final forecast.", "OK");
      return;
    }
    const ok = await askConfirm(
      `Copy Final → Buy for ${targets.length.toLocaleString()} row${targets.length === 1 ? "" : "s"}?`,
      `Sets Buy = Final forecast for the ${targets.length.toLocaleString()} row${targets.length === 1 ? "" : "s"} currently in view (matching your filters/search). This overwrites any Buy you've already typed on those rows; you can still edit individual Buy cells afterwards.`,
      "Copy Final → Buy",
    );
    if (!ok) return;
    setCopyingBuy(true);
    try {
      for (let i = 0; i < targets.length; i += 25) {
        const chunk = targets.slice(i, i + 25);
        await Promise.all(chunk.map((r) => onUpdateBuyQty(r.forecast_id, r.final_forecast_qty)));
      }
    } finally {
      setCopyingBuy(false);
    }
  }

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
      : [...collapsed].sort((a, b) => cmpMulti(a, b, sortStack));
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
  }, [mutedRows, mutedById, skuPeriodMath, sortSig, collapse, anyCollapsed]);

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
    const searchTrim = deferredSearch.trim();
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
        childRows.sort((a, b) => cmpMulti(a, b, sortStack));
        if (pinnedChildFid) {
          const pinnedIdx = childRows.findIndex((c) => c.forecast_id === pinnedChildFid);
          if (pinnedIdx > 0) {
            const [pinnedRow] = childRows.splice(pinnedIdx, 1);
            childRows.unshift(pinnedRow);
          }
        }
        // Chain children through applyRollingPool starting from the
        // parent aggregate's rolled incoming on-hand (set by `filtered`
        // above). Receipts dedupe per (sku, period) so multi-customer
        // children of the same SKU don't multiply receipts into the
        // pool. Because mergeBucket's parent on_so / receipts / buy
        // exactly equal the sum of children's contributions to the
        // pool, the final child's outgoing ATS lands on the parent's
        // displayed ATS — no parent/child mismatch when the planner
        // expands a group. projected_shortage / projected_excess stay
        // sourced from the per-(sku, period) math map (they're
        // SKU-grain truths, not depleted by the customer-row walk).
        const childFacts = childRows.map((c) => ({
          on_so_qty: c.on_so_qty,
          receipts_due_qty: c.receipts_due_qty ?? 0,
          planned_buy_qty: c.planned_buy_qty ?? 0,
          final_forecast_qty: c.final_forecast_qty,
          dedupeKey: `${c.sku_id}:${c.period_start}`,
        }));
        const childRolled = applyRollingPool(childFacts, r.on_hand_qty ?? 0);
        for (let i = 0; i < childRows.length; i++) {
          const child = childRows[i];
          const fid = child.forecast_id;
          const m = skuPeriodMath.get(`${child.sku_id}:${child.period_start}`);
          const projected = {
            on_hand_qty: childRolled[i].on_hand_qty,
            available_supply_qty: childRolled[i].available_supply_qty,
            projected_excess_qty: m?.excess ?? 0,
            projected_shortage_qty: m?.shortage ?? 0,
          };
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
  }, [filtered, expandedAggs, manuallyCollapsedAggs, mutedById, skuPeriodMath, lastAddedTbdMarker, rows, collapse, deferredSearch, sortSig]);

  // computeTotals moved to ./wholesale-planning/computeTotals (tested).
  const totals = useMemo(() => computeTotals(mutedRows, skuPeriodMath), [mutedRows, skuPeriodMath]);
  // Column total to pass to a Th header (undefined = totals toggle off, no row).
  const ct = (key: string): number | undefined => (showColumnTotals ? (totals.columns[key] ?? 0) : undefined);

  // Auto-shrink columns to fit the widest content currently displayed
  // plus ~2 chars of breathing room each side. table-layout: fixed
  // (required for the freeze-through-column feature) takes the width
  // assigned to each <Th>, so widths computed here become the actual
  // column widths every render. Per-column FLOOR values protect cells
  // that wrap an <input> (BuyCell etc.) from being crushed below their
  // input's intrinsic width; CAP values keep one outlier description
  // from blowing the whole row out.
  // Per-column width compute moved to useDynamicColWidths.
  const dynamicColWidths = useDynamicColWidths(displayRows);

  // Header click handler.
  //   Plain click  → single-column sort by `key`; a repeat plain-click on the
  //                  same lone key flips asc↔desc.
  //   Shift+click  → add `key` as a child sort (keeps existing columns as
  //                  parents); if already in the stack, cycle asc → desc →
  //                  remove. This is how the planner builds "Customer, then
  //                  Period within customer, then …".
  function toggleSort(key: SortKey, additive: boolean) {
    setSortStack((prev) => {
      const idx = prev.findIndex((s) => s.key === key);
      if (!additive) {
        if (prev.length === 1 && idx === 0) {
          return [{ key, dir: prev[0].dir === "asc" ? "desc" : "asc" }];
        }
        return [{ key, dir: "asc" }];
      }
      if (idx === -1) return [...prev, { key, dir: "asc" }];
      if (prev[idx].dir === "asc") {
        const next = prev.slice();
        next[idx] = { key, dir: "desc" };
        return next;
      }
      // desc → drop this level (but never leave the stack empty — fall back to
      // a single Period sort so the grid always has a deterministic order).
      const dropped = prev.filter((s) => s.key !== key);
      return dropped.length > 0 ? dropped : [{ key: "period", dir: "asc" }];
    });
  }

  // Open the ATS-style right-click context menu for an On Hand,
  // On SO or Receipts (On PO) cell. type="onHand" → blue stock detail
  // (no fetch needed, render synchronously); type="onOrder" → SO menu
  // (yellow); type="onPO" → PO menu (green). Resolves the row's SKU
  // set (aggregates expand to their underlying mutedRows sku_ids; leaf
  // rows use their own sku_id), then lazy-fetches the relevant
  // ip_open_sales_orders / ip_open_purchase_orders for that
  // (sku_ids[], period, customer_id) grain and maps each line to the
  // ATSPoEvent / ATSSoEvent shape the menu component expects.
  async function openSummaryCtx(
    e: React.MouseEvent,
    type: "onHand" | "onOrder" | "onPO",
    row: IpPlanningGridRow,
  ) {
    e.preventDefault();
    const cellEl = e.currentTarget as HTMLElement;
    const rect = cellEl.getBoundingClientRect();
    const ARROW_OVERLAP = 12;
    const initialX = rect.left;
    const initialY = rect.bottom - ARROW_OVERLAP;

    // Resolve sku + customer scope from the row's underlying children.
    // For leaf rows: just the row's own sku + customer. For aggregates
    // (size merges always, plus any explicit collapse): collect every
    // underlying mutedRow's sku_id + customer_id. If exactly one
    // customer appears across the bucket the lookup filters to it; if
    // many appear (e.g. customer-rolled-up aggregate) pass null so the
    // lookup spans all customers under that bucket.
    const skuIdSet = new Set<string>();
    const customerIdSet = new Set<string>();
    if (row.is_aggregate && row.aggregate_underlying_ids?.length) {
      for (const fid of row.aggregate_underlying_ids) {
        const u = mutedById.get(fid);
        if (u?.sku_id) skuIdSet.add(u.sku_id);
        if (u?.customer_id) customerIdSet.add(u.customer_id);
      }
    } else {
      skuIdSet.add(row.sku_id);
      if (row.customer_id) customerIdSet.add(row.customer_id);
    }
    const sku_ids = Array.from(skuIdSet);
    const customer_id = customerIdSet.size === 1
      ? Array.from(customerIdSet)[0]
      : null;

    // Raw on-hand from the mutedRows pre-rolling-pool snapshot. The
    // displayed row.on_hand_qty has been overwritten to the rolled
    // beginning-balance value by `filtered`, but the menu's "On Hand"
    // section should show the actual Xoro snapshot for the SKU(s).
    // Dedupe across underlying ids by sku_id so multi-period buckets
    // don't multiply the on-hand by N.
    let rawOnHand = 0;
    {
      const seenSkus = new Set<string>();
      if (row.is_aggregate && row.aggregate_underlying_ids?.length) {
        for (const fid of row.aggregate_underlying_ids) {
          const u = mutedById.get(fid);
          if (!u || seenSkus.has(u.sku_id)) continue;
          seenSkus.add(u.sku_id);
          rawOnHand += u.on_hand_qty ?? 0;
        }
      } else {
        const u = mutedById.get(row.forecast_id);
        rawOnHand = u?.on_hand_qty ?? row.on_hand_qty ?? 0;
      }
    }

    // Build a fake ATSRow from the planning row so SummaryContextMenu's
    // header pills (SKU code, On Hand chip, Avg Cost) render with the
    // right values. ppkMult=1 keeps the menu's prepack math a no-op.
    const skuLabel = row.sku_style && row.sku_color
      ? `${row.sku_style} ${row.sku_color}`
      : (row.sku_code ?? row.sku_style ?? "");
    const atsRow: ATSRow = {
      sku: skuLabel,
      description: row.sku_description ?? "",
      onHand: rawOnHand,
      onPO: row.receipts_due_qty ?? 0,
      onOrder: row.on_so_qty ?? 0,
      avgCost: row.avg_cost ?? 0,
      totalAmount: rawOnHand * (row.avg_cost ?? 0),
      store: "ROF",
    } as ATSRow;

    // On Hand is a fact already on the row — render synchronously, no
    // network fetch. The menu's onHand panel reads atsRow.{onHand,
    // avgCost, totalAmount, description, store} directly.
    if (type === "onHand") {
      setSummaryCtx({
        type: "onHand",
        row: atsRow,
        pos: [],
        sos: [],
        cellEl,
        initialX,
        initialY,
      });
      setSummaryCtxLoading(false);
      return;
    }

    // Render an empty menu immediately so the user gets feedback that
    // the click registered. The fetch fills in the events below.
    setSummaryCtx({
      type: type === "onOrder" ? "onOrder" : "onPO",
      row: atsRow,
      pos: [],
      sos: [],
      cellEl,
      initialX,
      initialY,
    });
    setSummaryCtxLoading(true);
    try {
      if (type === "onOrder") {
        const lines = await wholesaleRepo.listOpenSoLinesForCell({
          sku_ids,
          period_start: row.period_start,
          period_end: row.period_end,
          customer_id,
        });
        const sos: ATSSoEvent[] = lines.map((l) => ({
          sku: skuLabel,
          // ATS treats `date` as the ship/cancel date — surface ship_date.
          date: l.ship_date ?? "",
          qty: l.qty_open ?? 0,
          orderNumber: l.so_number ?? "",
          customerName: l.customer_name ?? row.customer_name ?? "",
          unitPrice: l.unit_price ?? 0,
          totalPrice: (l.unit_price ?? 0) * (l.qty_open ?? 0),
          store: l.store ?? "ROF",
        }));
        setSummaryCtx((prev) => (prev ? { ...prev, sos } : prev));
      } else {
        const lines = await wholesaleRepo.listOpenPoLinesForCell({
          sku_ids,
          period_start: row.period_start,
          period_end: row.period_end,
          customer_id,
        });
        const pos: ATSPoEvent[] = lines.map((l) => ({
          sku: skuLabel,
          date: l.expected_date ?? "",
          qty: l.qty_open ?? 0,
          poNumber: l.po_number ?? "",
          // buyer_name on the planning side carries the TandA "BuyerName"
          // string (often a customer name for committed POs, "ROF Stock"
          // / "PT Stock" for stock POs). The ATS menu labels this field
          // as "vendor" — same visual slot.
          vendor: l.buyer_name ?? "",
          store: l.channel === "ecom" ? "ROF ECOM" : "ROF",
          unitCost: l.unit_cost ?? 0,
        }));
        setSummaryCtx((prev) => (prev ? { ...prev, pos } : prev));
      }
    } finally {
      setSummaryCtxLoading(false);
    }
  }

  // Click-outside + Escape dismiss for the right-click menu. Matches the
  // ATS implementation: any pointerdown that isn't inside the menu (or
  // on a cell that just opened it) closes the menu.
  useEffect(() => {
    if (!summaryCtx) return;
    function onPointerDown(e: PointerEvent) {
      const node = summaryCtxRef.current;
      if (!node) { setSummaryCtx(null); return; }
      if (node.contains(e.target as Node)) return;
      // Don't dismiss if the click landed on the cell that opened the
      // menu — the right-click handler will re-open it anyway.
      if (summaryCtx.cellEl && summaryCtx.cellEl.contains(e.target as Node)) return;
      setSummaryCtx(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSummaryCtx(null);
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [summaryCtx]);

  // Keep the right-click menu pinned to its source cell as the planner
  // scrolls the grid or the page. Without this the menu uses its
  // initial click-time position and visibly drifts away from the cell
  // (the bug we hit after shipping the first version). Mutates
  // el.style.top/left directly via the ref so we don't churn React
  // state on every scroll frame. Also flips the menu above the cell
  // when the cell is closer to the viewport bottom, and dismisses
  // when the cell scrolls behind the sticky header. Same shape as
  // ATS's repositionSummaryCtx.
  const repositionSummaryCtx = useCallback(() => {
    if (!summaryCtx?.cellEl || !summaryCtxRef.current) return;
    const el = summaryCtxRef.current;
    const cell = summaryCtx.cellEl.getBoundingClientRect();
    const wrap = tableWrapRef.current;
    // Hide when the cell scrolls behind the sticky table header or
    // off the bottom of the visible region. Mirrors the ATS check
    // (top sticky thead bottom vs cell.bottom) so the menu doesn't
    // hover over a cell the planner can no longer see.
    const theadEl = wrap?.querySelector("thead th") as HTMLElement | null;
    const theadBottom = theadEl?.getBoundingClientRect().bottom ?? 0;
    if (cell.bottom <= theadBottom + 2 || cell.top >= window.innerHeight) {
      setSummaryCtx(null);
      return;
    }
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const pad = 8;
    const ARROW_OVERLAP = 12;
    const ARROW_DIV_H = 8;
    const belowSpace = vh - cell.bottom + ARROW_OVERLAP - pad;
    const aboveSpace = cell.top + ARROW_OVERLAP - pad;
    const flipped = aboveSpace > belowSpace;
    const space = flipped ? aboveSpace : belowSpace;
    const bodyMax = Math.max(120, space - ARROW_DIV_H);
    const bodyEl = el.querySelector("[data-popup-body]") as HTMLElement | null;
    if (bodyEl) bodyEl.style.maxHeight = `${bodyMax}px`;
    const ph = el.offsetHeight;
    let top: number;
    if (flipped) {
      top = (cell.top + ARROW_OVERLAP) - ph;
    } else {
      top = cell.bottom - ARROW_OVERLAP;
    }
    const pw = el.offsetWidth;
    const left = Math.max(pad, Math.min(vw - pw - pad, cell.left));
    el.style.top = `${Math.max(pad, top)}px`;
    el.style.left = `${left}px`;
    const arrowLeft = Math.max(10, Math.min(cell.left + cell.width / 2 - left - 9, pw - 28));
    const upEl = el.querySelector("[data-arrow='up']") as HTMLElement | null;
    const downEl = el.querySelector("[data-arrow='down']") as HTMLElement | null;
    if (upEl) { upEl.style.display = flipped ? "none" : "block"; upEl.style.left = `${arrowLeft}px`; }
    if (downEl) { downEl.style.display = flipped ? "block" : "none"; downEl.style.left = `${arrowLeft}px`; }
  }, [summaryCtx]);

  useLayoutEffect(() => { repositionSummaryCtx(); }, [repositionSummaryCtx]);

  useEffect(() => {
    if (!summaryCtx) return;
    // Listen for scroll on window AND the grid wrap — the wrap has its
    // own scroll container (overflow set on S.tableWrap) so window
    // scroll alone misses internal grid scrolling. capture=true so
    // nested scrollable parents (e.g. layout containers) also fire.
    const targets: EventTarget[] = [window];
    if (tableWrapRef.current) targets.push(tableWrapRef.current);
    targets.forEach((t) => t.addEventListener("scroll", repositionSummaryCtx, { passive: true, capture: true } as AddEventListenerOptions));
    window.addEventListener("resize", repositionSummaryCtx);
    return () => {
      targets.forEach((t) => t.removeEventListener("scroll", repositionSummaryCtx, { capture: true } as EventListenerOptions));
      window.removeEventListener("resize", repositionSummaryCtx);
    };
  }, [summaryCtx, repositionSummaryCtx]);

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
              maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box",
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
              maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box",
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
        <CollapseToggle
          label={showZeroRows ? "Zero-qty rows: ON" : "Zero-qty rows: OFF"}
          active={!showZeroRows}
          onToggle={() => setShowZeroRows(!showZeroRows)}
        />
        <CollapseToggle
          label={explodePpk ? "Explode PPK: ON" : "Explode PPK: OFF"}
          active={!explodePpk}
          onToggle={() => setExplodePpk(!explodePpk)}
        />
        {/* Carton qty — rounds every quantity on a NON-prepack row up to the
            next whole carton (default 24). Prepack styles keep their own pack
            size. Set to 0/1 to disable. */}
        <div
          title="Round all quantities on non-prepack styles UP to the next whole carton. Prepack (PPK) styles keep their own pack size. Set to 0 or 1 to turn off."
          style={{ display: "inline-flex", alignItems: "center", gap: 6, border: `1px solid ${PAL.border}`, borderRadius: 8, padding: "2px 8px", background: PAL.panel }}
        >
          <span style={{ color: PAL.textDim, fontSize: 11 }}>Carton qty</span>
          <input
            type="number"
            min={0}
            step={1}
            value={cartonQty}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              setCartonQty(Number.isFinite(n) && n > 0 ? n : 1);
            }}
            style={{
              width: 52, background: PAL.bg, color: PAL.text,
              border: `1px solid ${cartonQty > 1 ? PAL.accent : PAL.border}`,
              borderRadius: 6, padding: "3px 6px", fontSize: 12, textAlign: "right",
              fontFamily: "monospace", outline: "none",
            }}
          />
        </div>
        <CollapseToggle
          label={showColumnTotals ? "Totals: ON" : "Totals: OFF"}
          active={showColumnTotals}
          onToggle={() => setShowColumnTotals(!showColumnTotals)}
        />
        {/* Hist-T window selector — sets how many trailing months the Hist T
            column sums (through each row's same period last year). */}
        <div
          title="Hist column: trailing 3 / 6 / 9 / 12 months, each ending at the row's same period last year"
          style={{ display: "inline-flex", alignItems: "center", gap: 2, border: `1px solid ${PAL.border}`, borderRadius: 8, padding: "2px 3px", background: PAL.panel }}
        >
          <span style={{ color: PAL.textDim, fontSize: 11, padding: "0 4px" }}>Hist</span>
          {[3, 6, 9, 12].map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setTrailingWindow(w)}
              style={{
                background: trailingWindow === w ? PAL.accent : "transparent",
                color: trailingWindow === w ? "#fff" : PAL.textDim,
                border: "none", borderRadius: 6, padding: "3px 8px", fontSize: 11,
                cursor: "pointer", fontFamily: "inherit", fontWeight: trailingWindow === w ? 700 : 400,
              }}
            >T{w}</button>
          ))}
        </div>
        {/* Bulk seed: set Buy = Final forecast for every row in view. */}
        <button
          type="button"
          onClick={() => { void copyFinalToBuy(); }}
          disabled={copyingBuy}
          title="Set Buy = Final forecast for every row currently in view (matching your filters). You can still edit individual Buy cells afterwards."
          style={{
            background: "transparent", border: `1px solid ${PAL.border}`, color: PAL.textDim,
            borderRadius: 8, padding: "5px 12px", fontSize: 12, cursor: copyingBuy ? "wait" : "pointer",
            fontFamily: "inherit", opacity: copyingBuy ? 0.6 : 1,
          }}
        >{copyingBuy ? "Copying…" : "Copy Final → Buy"}</button>
        {/* Freeze through column. Pins the chosen column + everything
            to its left sticky when the planner scrolls horizontally.
            Filtered to visible columns so picking a hidden one can't
            create a 0-width freeze line. */}
        <div title="Pin leftmost columns through the chosen one when scrolling horizontally" style={{ minWidth: 180 }}>
          <SearchableSelect
            value={freezeKey || null}
            onChange={(v) => setFreezeKey(v)}
            inputStyle={{ ...S.select, fontSize: 12, padding: "2px 6px" }}
            options={[
              { value: "", label: "No freeze" },
              ...FREEZABLE_COLS.filter(k => !hiddenColumns.has(k)).map(k => (
                { value: k, label: `Freeze through ${FREEZE_LABELS[k]}` }
              )),
            ]}
          />
        </div>
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
                  // Seed the color chips from an active Color filter (each
                  // becomes its own row); otherwise start empty = a single
                  // TBD-color row.
                  colors: filterColor.length > 0 ? filterColor.map((c) => ({ color: c, is_new: false })) : [],
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
              {(undoDepth ?? 0) > 0 && onUndoLastAdd && (
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
                  title="Undo the most recent + Add row (deletes every row it created). Press again to undo earlier adds — up to the last 4."
                >
                  ↶ Undo{(undoDepth ?? 0) > 1 ? ` (${undoDepth})` : ""}
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
                    colors: top.sku_color && top.sku_color.toUpperCase() !== "TBD"
                      ? [{ color: top.sku_color, is_new: !!top.is_new_color }]
                      : [],
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
                Copy top row
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
              <span style={{ color: PAL.textMuted, fontSize: 11 }}>Colors:</span>
              {/* Multi-color: chips of the chosen colors + a TbdColorCell that
                  ADDS each pick/created color to the list (instead of setting a
                  single value). Each color makes its own row (× customer ×
                  period). Empty = one TBD-color row. The adder keeps the rich
                  TbdColorCell so existing colorways AND brand-new ones (with the
                  "Add as NEW" footer) both work. */}
              {addRowDraft.colors.map((c) => (
                <span key={c.color} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: PAL.bg, border: `1px solid ${c.is_new ? PAL.yellow : PAL.border}`, borderRadius: 12, padding: "2px 8px", fontSize: 12, color: PAL.text }}>
                  {c.color}{c.is_new ? <span style={{ color: PAL.yellow, fontSize: 9, fontWeight: 700 }}>NEW</span> : null}
                  <button
                    type="button"
                    onClick={() => setAddRowDraft((d) => ({ ...d, colors: d.colors.filter((x) => x.color !== c.color) }))}
                    title={`Remove ${c.color}`}
                    style={{ background: "transparent", border: "none", color: PAL.textMuted, cursor: "pointer", fontSize: 12, lineHeight: 1, padding: 0 }}
                  >✕</button>
                </span>
              ))}
              {(() => {
                const knownColors = Array.from(
                  colorsByGroupName.get(addRowDraft.group_name ?? "—") ?? new Set<string>(),
                ).sort();
                return (
                  <TbdColorCell
                    value="TBD"
                    isNewColor={false}
                    isNewForStyle={false}
                    knownColors={knownColors}
                    allKnownColorsLower={allKnownColorsLower}
                    masterColorsLower={masterColorsLower}
                    onSave={async (color, isNew) => {
                      const cc = color.trim();
                      if (!cc || cc.toUpperCase() === "TBD") return;
                      setAddRowDraft((d) =>
                        d.colors.some((x) => x.color.toLowerCase() === cc.toLowerCase())
                          ? d
                          : { ...d, colors: [...d.colors, { color: cc, is_new: isNew }] },
                      );
                    }}
                  />
                );
              })()}
              <span style={{ color: PAL.textMuted, fontSize: 10 }}>{addRowDraft.colors.length === 0 ? "(TBD — pick one or more)" : `${addRowDraft.colors.length} color${addRowDraft.colors.length === 1 ? "" : "s"}`}</span>
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
                  // Empty color list = one TBD-color row; otherwise one row per
                  // color (× customer × period).
                  const colorEntries = addRowDraft.colors.length > 0
                    ? addRowDraft.colors
                    : [{ color: "TBD", is_new: false }];
                  const colorCount = colorEntries.length;
                  const totalRows = customerCount * periodCount * colorCount;
                  const customerNames = addRowDraft.customer_ids
                    .map((id) => customers.find((c) => c.id === id)?.name ?? id)
                    .slice(0, 3);
                  const customerSummary = addRowDraft.customer_ids.length > 3
                    ? `${customerNames.join(", ")} +${addRowDraft.customer_ids.length - 3} more`
                    : customerNames.join(", ");
                  const periodSummary = addRowDraft.period_codes.length > 0
                    ? addRowDraft.period_codes.map(formatPeriodCode).join(", ")
                    : "every period in the run";
                  const colorSummary = colorEntries.map((c) => c.color).join(", ");
                  const ok = await askConfirm(
                    `Create ${totalRows} TBD row${totalRows === 1 ? "" : "s"}?`,
                    `${totalRows} row${totalRows === 1 ? "" : "s"} will be created — ${customerCount} customer${customerCount === 1 ? "" : "s"} (${customerSummary}) × ${periodCount} period${periodCount === 1 ? "" : "s"} (${periodSummary}) × ${colorCount} color${colorCount === 1 ? "" : "s"} (${colorSummary}).\n\nStyle: ${addRowDraft.style_code || "TBD"}${addRowDraft.description.trim() ? ` · Description: ${addRowDraft.description.trim()}` : ""}`,
                    "Create rows",
                  );
                  if (!ok) return;
                  setAddRowSaving(true);
                  try {
                    // One onAddTbdRow call per color; the workbench fans each
                    // out over the selected customers × periods.
                    for (const ce of colorEntries) {
                      await onAddTbdRow({
                        style_code: addRowDraft.style_code || "TBD",
                        color: ce.color || "TBD",
                        is_new_color: ce.is_new,
                        customer_ids: addRowDraft.customer_ids,
                        group_name: addRowDraft.group_name,
                        sub_category_name: addRowDraft.sub_category_name,
                        period_codes: addRowDraft.period_codes,
                        notes: addRowDraft.description.trim() || null,
                      });
                    }
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

      <GridScrollbarStyles scope="ip-grid-table-wrap" trackColor={PAL.bg} thumbColor={PAL.border} thumbHoverColor={PAL.borderFaint} />
      {/* Sticky-left CSS for the freeze-through-column feature.
          Targets the header <th> + body <td>s in matching DOM
          positions via nth-child against the planning-grid-row
          class. Offsets are runtime-measured (see freezeOffsets
          state) so columns can keep their auto-fit widths and the
          freeze still positions accurately. zIndex wins over
          regular cells but stays below the top-sticky thead. */}
      {/* Freeze CSS — pins leftmost columns sticky-left when the
          planner scrolls horizontally. Cumulative left offsets are
          derived from dynamicColWidths so the freeze stays aligned
          when columns auto-shrink/grow to content. Header cells
          use z-index 5 so the corner stays on top during both-axis
          scroll; body cells use z-index 1 so they slide UNDER the
          top-sticky header on vertical scroll. */}
      {freezeIdxDom > 0 && (() => {
        const offsets: number[] = [];
        let acc = 0;
        for (let i = 0; i < freezeIdxDom; i++) {
          offsets.push(acc);
          const k = FREEZABLE_COLS[i];
          acc += hiddenColumns.has(k) ? 0 : (dynamicColWidths[k] ?? 0);
        }
        return (
          <style>{[
            ...offsets.map((left, i) => (
              `tbody tr.planning-grid-row > :nth-child(${i + 1}) { position: sticky; left: ${left}px; z-index: 1; background: ${PAL.panel}; }`
            )),
            ...offsets.map((left, i) => (
              `thead tr.planning-grid-row > :nth-child(${i + 1}) { position: sticky; left: ${left}px; z-index: 5 !important; background: ${PAL.panel}; }`
            )),
          ].join("\n")}</style>
        );
      })()}
      <div ref={tableWrapRef} className="ip-grid-table-wrap" style={S.tableWrap}>
        <table style={{ ...S.table, tableLayout: "fixed" as const }}>
          <thead>
            <tr className="planning-grid-row">
              <Th widths={dynamicColWidths} label="Category"    k="category"    sortStack={sortStack} onSort={toggleSort} hidden={hiddenColumns.has("category")} />
              <Th widths={dynamicColWidths} label="Sub Cat"     k="subCat"      sortStack={sortStack} onSort={toggleSort} hidden={hiddenColumns.has("subCat")} />
              <Th widths={dynamicColWidths} label="Style"       k="style"       sortStack={sortStack} onSort={toggleSort} hidden={hiddenColumns.has("style")} />
              <Th widths={dynamicColWidths} label="Description" k="description" sortStack={sortStack} onSort={toggleSort} hidden={hiddenColumns.has("description")} />
              <Th widths={dynamicColWidths} label="Color"       k="color"       sortStack={sortStack} onSort={toggleSort} hidden={hiddenColumns.has("color")} />
              <Th widths={dynamicColWidths} label="Inseam"      k="inseam"      sortStack={sortStack} onSort={toggleSort} title="Inseam length (denim/pants) from the item master — each inseam is its own planning line" hidden={hiddenColumns.has("inseam")} />
              <Th widths={dynamicColWidths} label="Customer"    k="customer"    sortStack={sortStack} onSort={toggleSort} hidden={hiddenColumns.has("customer")} />
              <Th widths={dynamicColWidths} label="Period"      k="period"      sortStack={sortStack} onSort={toggleSort} hidden={hiddenColumns.has("period")} />
              <Th widths={dynamicColWidths} label="Class"       k="class"       sortStack={sortStack} onSort={toggleSort} title="ABC volume rank × XYZ demand variability" hidden={hiddenColumns.has("class")} />
              <Th widths={dynamicColWidths} label={`Hist T${trailingWindow}`} k="histT3" sortStack={sortStack} onSort={toggleSort} numeric total={ct("histT3")} title={`Trailing ${trailingWindow} months through this row's same period last year — change the window in the T3/T6/T9/T12 selector above the grid`} hidden={hiddenColumns.has("histT3")} />
              <Th widths={dynamicColWidths} label="SP/LY"       k="histLY"      sortStack={sortStack} onSort={toggleSort} title="Same Period Last Year" numeric total={ct("histLY")} hidden={hiddenColumns.has("histLY")} />
              <Th widths={dynamicColWidths} label="Margin %"    k="margin"      sortStack={sortStack} onSort={toggleSort} title="Weighted-avg gross margin over trailing 3 months. Green ≥ 30%, red < 0%." numeric hidden={hiddenColumns.has("margin")} />
              <Th widths={dynamicColWidths} label="System"      k="system"      sortStack={sortStack} onSort={toggleSort} numeric total={ct("system")} hidden={hiddenColumns.has("system")} />
              <Th widths={dynamicColWidths} label="Buyer"       k="buyer"       sortStack={sortStack} onSort={toggleSort} numeric total={ct("buyer")} hidden={hiddenColumns.has("buyer")} />
              <Th widths={dynamicColWidths} label="Override"    k="override"    sortStack={sortStack} onSort={toggleSort} numeric total={ct("override")} hidden={hiddenColumns.has("override")} />
              <Th widths={dynamicColWidths} label="Final"       k="final"       sortStack={sortStack} onSort={toggleSort} numeric total={ct("final")} hidden={hiddenColumns.has("final")} />
              <Th widths={dynamicColWidths} label="Conf."       k="confidence"  sortStack={sortStack} onSort={toggleSort} hidden={hiddenColumns.has("confidence")} />
              <Th widths={dynamicColWidths} label="Method"      k="method"      sortStack={sortStack} onSort={toggleSort} hidden={hiddenColumns.has("method")} />
              <Th widths={dynamicColWidths} label="On hand"     k="onHand"      sortStack={sortStack} onSort={toggleSort} numeric total={ct("onHand")} hidden={hiddenColumns.has("onHand")} />
              <Th widths={dynamicColWidths} label="On SO"       k="onSo"        sortStack={sortStack} onSort={toggleSort} numeric total={ct("onSo")} hidden={hiddenColumns.has("onSo")} />
              <Th widths={dynamicColWidths} label="Receipts"    k="receipts"    sortStack={sortStack} onSort={toggleSort} numeric total={ct("receipts")} title="Open POs scheduled to land in this period (drives supply math)" hidden={hiddenColumns.has("receipts")} />
              <Th widths={dynamicColWidths} label="Hist Recv"   k="histRecv"    sortStack={sortStack} onSort={toggleSort} numeric total={ct("histRecv")} tint={PAL.textMuted} title="Past actual receipts in this period — display only, already in On hand" hidden={hiddenColumns.has("histRecv")} />
              <Th widths={dynamicColWidths} label="ATS"         k="ats"         sortStack={sortStack} onSort={toggleSort} numeric total={ct("ats")} hidden={hiddenColumns.has("ats")} />
              <Th widths={dynamicColWidths} label="Buy"         k="buy"         sortStack={sortStack} onSort={toggleSort} numeric total={ct("buy")} tint={PAL.green} hidden={hiddenColumns.has("buy")} />
              <Th widths={dynamicColWidths} label="Avg Cost"    k="avgCost"     sortStack={sortStack} onSort={toggleSort} numeric tint={PAL.textMuted} title="From ip_item_avg_cost (Xoro / Excel ingest)" hidden={hiddenColumns.has("avgCost")} />
              <Th widths={dynamicColWidths} label="Unit Cost"   k="unitCost"    sortStack={sortStack} onSort={toggleSort} numeric tint={PAL.accent2} title="Auto-filled from Avg Cost — editable" hidden={hiddenColumns.has("unitCost")} />
              <Th widths={dynamicColWidths} label="Buy $"       k="buyDollars"  sortStack={sortStack} onSort={toggleSort} numeric total={ct("buyDollars")} tint={PAL.green} hidden={hiddenColumns.has("buyDollars")} />
              <Th widths={dynamicColWidths} label="Short"       k="shortage"    sortStack={sortStack} onSort={toggleSort} numeric total={ct("shortage")} hidden={hiddenColumns.has("shortage")} />
              <Th widths={dynamicColWidths} label="Excess"      k="excess"      sortStack={sortStack} onSort={toggleSort} numeric total={ct("excess")} hidden={hiddenColumns.has("excess")} />
              <Th widths={dynamicColWidths} label="Action"      k="action"      sortStack={sortStack} onSort={toggleSort} hidden={hiddenColumns.has("action")} />
            </tr>
          </thead>
          <tbody>
            {displayRows.slice(page * pageSize, (page + 1) * pageSize).map((r) => {
              const aggExpansionKey = r.aggregate_key ?? r.forecast_id;
              const rowKey = (r as IpPlanningGridRow & { _displayKey?: string })._displayKey ?? r.forecast_id;
              // Pack context for the eaches ⇄ packs conversion on save + the
              // unresolved-prepack warning. packSize resolves the SKU/size
              // "PPKn" token first, then Tangerine's Prepack Matrix.
              const rowTokenMult = ppkMultiplier(r.sku_color, r.sku_size, r.sku_description, r.sku_style, r.sku_code);
              const rowPackSize = resolvePackSize(rowTokenMult, r.sku_style ?? r.sku_code, ppkUnitsByStyle ?? EMPTY_PACK_MAP);
              const rowPpkUnresolved = looksPpk(r.sku_code, r.sku_style, r.sku_size) && rowPackSize <= 1;
              return (
                <PlanningGridRow
                  key={rowKey}
                  row={r}
                  isChild={childIds.has(r.forecast_id)}
                  isExpanded={!!(r.is_aggregate && expandedAggs.has(aggExpansionKey))}
                  aggExpansionKey={aggExpansionKey}
                  explodePpk={explodePpk}
                  packSize={rowPackSize}
                  ppkUnresolved={rowPpkUnresolved}
                  cartonQty={cartonQty}
                  rows={rows}
                  masterStyles={masterStyles}
                  masterColorsLower={masterColorsLower}
                  masterColorsByStyleLower={masterColorsByStyleLower}
                  allKnownColorsLower={allKnownColorsLower}
                  colorsByGroupName={colorsByGroupName}
                  knownDescriptions={knownDescriptions}
                  masterDescriptionsLower={masterDescriptionsLower}
                  customers={customers}
                  newCustomerIds={newCustomerIds}
                  hiddenColumns={hiddenColumns}
                  onSelectRow={onSelectRow}
                  toggleAggExpanded={toggleAggExpanded}
                  setColorEditBlocked={setColorEditBlocked}
                  onUpdateTbdStyle={onUpdateTbdStyle}
                  onUpdateTbdDescription={onUpdateTbdDescription}
                  onUpdateTbdColor={onUpdateTbdColor}
                  onUpdateTbdCustomer={onUpdateTbdCustomer}
                  onAddTbdNewCustomer={onAddTbdNewCustomer}
                  onDeleteTbdRow={onDeleteTbdRow}
                  onPromoteTbdRow={onPromoteTbdRow}
                  promotedTbdKeys={promotedTbdKeys}
                  onUpdateSystemOverride={onUpdateSystemOverride}
                  onUpdateUnitCost={onUpdateUnitCost}
                  saveAggBuyerOrOverride={saveAggBuyerOrOverride}
                  saveAggBuy={saveAggBuy}
                  openSummaryCtx={openSummaryCtx}
                  onUpdateBuyerRequest={onUpdateBuyerRequest}
                  onUpdateOverride={onUpdateOverride}
                />
              );
            })}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={28} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                {rows.length === 0
                  ? "No forecast rows yet. Click \"Build forecast\" above to populate the grid."
                  : "No rows match your filters."}
              </td></tr>
            )}
            {loading && (
              <tr><td colSpan={28} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
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
              <div style={{ minWidth: 90 }}>
                <SearchableSelect
                  value={String(pageSize)}
                  onChange={(v) => setPageSize(Number(v))}
                  inputStyle={S.select}
                  options={[100, 250, 500, 1000, 2000].map((n) => ({ value: String(n), label: String(n) }))}
                />
              </div>
              <button style={S.btnSecondary} disabled={page === 0} onClick={() => setPage(0)}>« First</button>
              <button style={S.btnSecondary} disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>‹ Prev</button>
              <span>Page {page + 1} / {Math.max(1, Math.ceil(filtered.length / pageSize))}</span>
              <button style={S.btnSecondary} disabled={(page + 1) * pageSize >= filtered.length} onClick={() => setPage((p) => p + 1)}>Next ›</button>
              <button style={S.btnSecondary} disabled={(page + 1) * pageSize >= filtered.length} onClick={() => setPage(Math.max(0, Math.ceil(filtered.length / pageSize) - 1))}>Last »</button>
            </div>
          </div>
        )}
      </div>
      {/* Right-click PO/SO details — reused from the ATS app verbatim
          so the look matches. summaryCtx is null when no cell is
          active; loading state is only the small window between the
          click and the lazy fetch landing. */}
      <SummaryContextMenu
        summaryCtx={summaryCtx}
        summaryCtxRef={summaryCtxRef as React.RefObject<HTMLDivElement>}
        setSummaryCtx={setSummaryCtx}
      />
      {summaryCtxLoading && summaryCtx && (
        <div
          style={{
            position: "fixed",
            left: summaryCtx.initialX + 12,
            top: summaryCtx.initialY + 20,
            zIndex: 501,
            background: PAL.panel,
            color: PAL.textDim,
            border: `1px solid ${PAL.border}`,
            borderRadius: 6,
            padding: "4px 10px",
            fontSize: 11,
            pointerEvents: "none",
          }}
        >Loading…</div>
      )}
    </div>
  );
}

// Column widths are now computed per-render inside WholesalePlanningGrid
// (see dynamicColWidths) from the current displayRows content set, then
// threaded through Th + the freeze-through-column CSS IIFE via the
// `widths` prop. The static COL_WIDTHS table that used to live here was
// removed because it was permanently wider than necessary on most
// columns and required hand-tuning every time a content shape changed.

// Th + cmpStr / cmpNum / cmp moved to ./wholesale-planning/{Th,gridUtils}.
// aggregateRows + mergeBucket moved to ./aggregateGridRows. All
// imported at the top of this file.
