import type { ATSRow, ExcelData, UploadWarning, CtxMenu, SummaryCtxMenu } from "../types";
import type { NormChange } from "../normalize";
import { appConfig } from "../../config/env";

export interface ATSState {
  // Date range
  startDate: string;
  rangeUnit: "days" | "weeks" | "months";
  rangeValue: number;
  // Filters
  search: string;
  // Multi-select: empty array = no filter (every category passes). Each
  // entry is a category name as it appears in master_category. The
  // single-string "All" sentinel from the prior single-select shape was
  // dropped — a clean array is easier to reason about and serializes
  // straight to localStorage if we add persistence later.
  filterCategory: string[];
  filterSubCategory: string;
  // Multi-select. Empty array = no filter. Each entry is a master_style
  // code (the upper-case style identifier the grid renders in the Style
  // column). Scoped at toolbar build time to whichever categories /
  // sub-cats are currently active so the dropdown stays manageable.
  filterStyle: string[];
  filterGender: string;
  filterStatus: string;
  minATS: number | "";
  storeFilter: string[];
  // Dropdowns
  poDropOpen: boolean;
  soDropOpen: boolean;
  // Data
  rows: ATSRow[];
  loading: boolean;
  mockMode: boolean;
  page: number;
  excelData: ExcelData | null;
  // Upload
  uploadingFile: boolean;
  uploadProgress: { step: string; pct: number } | null;
  uploadSuccess: string | null;
  uploadError: string | null;
  uploadWarnings: UploadWarning[] | null;
  pendingUploadData: ExcelData | null;
  showUpload: boolean;
  invFile: File | null;
  purFile: File | null;
  ordFile: File | null;
  // Sync
  syncing: boolean;
  syncStatus: string;
  lastSync: string;
  syncError: { title: string; detail: string } | null;
  // Normalization review
  normChanges: NormChange[] | null;
  normPendingData: ExcelData | null;
  normSource: "upload" | "load";
  // Customer filter
  customerFilter: string;
  customerDropOpen: boolean;
  customerSearch: string;
  // UI
  hoveredCell: { sku: string; date: string } | null;
  pinnedSku: string | null;
  ctxMenu: CtxMenu | null;
  summaryCtx: SummaryCtxMenu | null;
  activeSort: string | null;
  sortCol: string | null;
  sortDir: "asc" | "desc";
  mergeHistory: Array<{ fromSku: string; toSku: string }>;
  atShip: boolean;
  // Grid cell content selector. "ats" renders the daily on-hand + PO − SO
  // running balance (current behavior, including AT SHIP free-to-sell when
  // atShip is on). "so" / "po" render the SO / PO qty whose date falls
  // within each column's period. Switches the totals-row Qty sum to match.
  viewMode: "ats" | "so" | "po";
  // Toggles the totals row above the column headers (Qty / Cost / Sale
  // / Mrgn% summed across the filtered set). Defaults off — operator
  // turns it on when they need the summary; otherwise the totals row
  // adds noise to the typical SKU-lookup workflow.
  showTotalsRow: boolean;
  // Toggles the stat cards row at the top of the page (Low Stock,
  // Zero Stock, Neg ATS, etc.). Defaults on. Operator hides them to
  // gain vertical room for the grid.
  showStatsCards: boolean;
  // Toggles whether prepack qtys are shown exploded (unit grain —
  // packs × units-per-pack) or as raw pack counts. Defaults true
  // (exploded) so the grid matches selling-unit thinking. When
  // false, the cell shows the pack count and a faded "PPKn = X"
  // hint with the unit-grain equivalent so the operator can flip
  // mental gears without losing the conversion.
  explodePpk: boolean;
  // Rightmost sticky column when scrolling horizontally. null = no
  // freeze (all 8 leftmost columns stay sticky — historical default).
  // Otherwise the named column is the rightmost frozen one and
  // every column to its right becomes scrollable. Lets the planner
  // unfreeze noisy columns (e.g. Description) without losing the
  // anchor on Style + Color.
  freezeKey: "category" | "subCategory" | "style" | "description" | "color" | "onHand" | "onOrder" | "onPO" | null;
  // Per-column hide list for the grid's left fixed columns. Keys
  // map to the 8 sticky columns (category | subCategory | style |
  // description | color | onHand | onOrder | onPO). Defaults to []
  // (everything visible). Hiding a column shrinks the table's
  // sticky-left area horizontally — sibling columns reflow.
  hiddenColumns: string[];
  // Target gross margin % (0-100). Used in the totals row as a
  // fallback when a SKU is missing SO sale prices or cost basis,
  // so the header still produces a meaningful Sale / Cost / Mrgn.
  generalMarginPct: number;
  // Phase 3: row collapse mode + per-group expand toggles. "none" = leaf
  // rows only (current behavior); other levels group + sum upward and
  // expandedGroups carries the keys of groups the user has drilled into.
  collapseLevel: "none" | "category" | "subCategory" | "style";
  expandedGroups: string[];
}

// Per-field SET action so `value` is typed to match `field`.
// Allowing a functional updater (prev => next) keeps React-style ergonomics.
export type SetAction = {
  [K in keyof ATSState]: {
    type: "SET";
    field: K;
    value: ATSState[K] | ((prev: ATSState[K]) => ATSState[K]);
  };
}[keyof ATSState];

export type ATSAction =
  | SetAction
  | { type: "UPLOAD_START" }
  | { type: "UPLOAD_PROGRESS"; step: string; pct: number }
  | { type: "UPLOAD_DONE"; message: string }
  | { type: "UPLOAD_FAIL"; error: string }
  | { type: "UPLOAD_RESET" }
  | { type: "SYNC_START" }
  | { type: "SYNC_DONE"; lastSync: string }
  | { type: "SYNC_FAIL"; error: { title: string; detail: string } };

export function createInitialState(startDate: string): ATSState {
  return {
    startDate,
    rangeUnit: "months",
    rangeValue: 6,
    search: "",
    filterCategory: [],
    filterStyle: [],
    filterSubCategory: "All",
    filterGender: "All",
    filterStatus: "All",
    minATS: "",
    // Default to ROF + PT (both are real customer-facing inventory).
    // ROF ECOM is intentionally OFF by default — it's a small ecom-only
    // pool the operator flips on when looking at ecom-specific buys.
    // Confirmed with user 2026-05-12.
    // In demo mode the seed uses DEMO-WH1 as the only store, so default
    // to ["All"] — that's the sentinel filter.ts checks for to bypass
    // store filtering entirely. Empty [] would mean "no stores selected"
    // and hide every row.
    storeFilter: appConfig.demoMode ? ["All"] : ["ROF", "PT"],
    poDropOpen: false,
    soDropOpen: false,
    rows: [],
    loading: false,
    mockMode: false,
    page: 0,
    excelData: null,
    uploadingFile: false,
    uploadProgress: null,
    uploadSuccess: null,
    uploadError: null,
    uploadWarnings: null,
    pendingUploadData: null,
    showUpload: false,
    invFile: null,
    purFile: null,
    ordFile: null,
    syncing: false,
    syncStatus: "",
    lastSync: "",
    syncError: null,
    normChanges: null,
    normPendingData: null,
    normSource: "upload",
    customerFilter: "",
    customerDropOpen: false,
    customerSearch: "",
    hoveredCell: null,
    pinnedSku: null,
    ctxMenu: null,
    summaryCtx: null,
    activeSort: null,
    sortCol: null,
    sortDir: "asc",
    mergeHistory: [],
    atShip: false,
    viewMode: "ats",
    showTotalsRow: false,
    showStatsCards: true,
    explodePpk: true,
    // Default "onPO" preserves the historical all-8-columns-sticky
    // behavior. Setting to null gives the planner an unfrozen scroll
    // experience; setting to a column earlier than On PO releases
    // the columns to its right.
    freezeKey: "onPO",
    hiddenColumns: [],
    generalMarginPct: 21,
    collapseLevel: "none",
    expandedGroups: [],
  };
}
