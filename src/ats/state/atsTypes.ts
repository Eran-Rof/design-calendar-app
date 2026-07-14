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
  // Multi-select. Empty array = no filter. Each entry is a sub-category
  // (master_sub_category) name. Scoped at toolbar build time to whichever
  // categories are currently active so the dropdown shows only valid
  // sub-cats for that narrowing.
  filterSubCategory: string[];
  // Multi-select. Empty array = no filter. Each entry is a master_style
  // code (the upper-case style identifier the grid renders in the Style
  // column). Scoped at toolbar build time to whichever categories /
  // sub-cats are currently active so the dropdown stays manageable.
  filterStyle: string[];
  filterGender: string[];
  // Multi-select on master_brand (the brand NAME resolved from
  // ip_item_master.brand_id → brand_master). Empty array = no filter.
  // Options are the full brand_master list (every brand the Tangerine
  // app knows about), not just brands present in the loaded data.
  filterBrand: string[];
  filterStatus: string;
  minATS: number | "";
  // On-Order date window (inclusive, ISO YYYY-MM-DD; "" = unbounded on
  // that side). Scopes ONLY the "On Order" total/column/exports to SO
  // lines whose date falls in the range — lets the operator reproduce a
  // date-windowed Xoro "Open Orders" total. The SO date is the Xoro
  // "Date to be Cancelled" (see ats-parse.js), NOT ship date. Empty on
  // both sides = no window (full open book, the default).
  soWinFrom: string;
  soWinTo: string;
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
  // Sync — `lastSync` is the upload/load timestamp shown in the navbar
  // info line. The transient (syncing/syncStatus/syncError) fields and
  // their SYNC_ reducer actions were removed when the in-app Xoro
  // Sync Open SOs button was retired in favor of Playwright-driven
  // nightly fetches.
  lastSync: string;
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
  // Grid cell content selector. "ats" renders per-period availability
  // (cumulative free at period 0; per-period new-receipt delta after,
  // via periodAvail). "so" / "po" render the SO / PO qty whose date
  // falls within each column's period. Switches the totals-row Qty
  // sum to match.
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
  // Toggles a per-row style image thumbnail inside the Style column.
  // Defaults true. Thumbnails are fetched live from the PIM (Tangerine)
  // by style code, so styles gain images automatically as they're added
  // there. Click a thumbnail to open the full image gallery (enlarge /
  // download / print). Styles without an image render a small blank tile.
  showImages: boolean;
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
  // Operator-managed exclusion list. Each entry is a row SKU
  // (style+color, the grid's row identity) marked via the "X" checkbox
  // column. Excluded rows STAY VISIBLE in the grid (greyed, box checked,
  // so they can be unchecked) but are dropped from EVERY aggregation —
  // the totals row, the stat cards, On Hand / On SO / On PO / margin
  // values, and from report/export data. Persisted globally to app_data
  // (`ats_excluded_skus`) so the exclusions stick across reloads. Before
  // a report runs, the operator is warned and can Continue (exclude),
  // Cancel, or Include them for that one run.
  excludedSkus: string[];
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
  | { type: "UPLOAD_RESET" };

export function createInitialState(startDate: string, initialSearch = ""): ATSState {
  return {
    startDate,
    rangeUnit: "months",
    rangeValue: 6,
    // Prefilled from a `?style=` deep-link (e.g. the Inventory Matrix "ATS" link
    // link). The free-text search matches on row SKU, which carries the style
    // code prefix, so seeding it focuses ATS on that style on first paint.
    search: initialSearch,
    filterCategory: [],
    filterSubCategory: [],
    filterStyle: [],
    filterGender: [],
    filterBrand: [],
    filterStatus: "All",
    minATS: "",
    soWinFrom: "",
    soWinTo: "",
    // Default to ROF only (the primary customer-facing inventory).
    // PT and ROF ECOM stay OFF by default — operator flips them on
    // when they want to look at the secondary or ecom pool. Updated
    // 2026-05-14 per planner.
    // In demo mode the seed uses DEMO-WH1 as the only store, so default
    // to ["All"] — that's the sentinel filter.ts checks for to bypass
    // store filtering entirely. Empty [] would mean "no stores selected"
    // and hide every row.
    storeFilter: appConfig.demoMode ? ["All"] : ["ROF"],
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
    lastSync: "",
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
    // Default sort: style number ascending. Operators want the grid
    // to come up grouped by style so variants of the same style sit
    // together without needing to click the column header first.
    // Clicking another column still re-sorts as before.
    sortCol: "style",
    sortDir: "asc",
    mergeHistory: [],
    viewMode: "ats",
    showTotalsRow: false,
    showStatsCards: true,
    explodePpk: true,
    showImages: true,
    // Default "onPO" preserves the historical all-8-columns-sticky
    // behavior. Setting to null gives the planner an unfrozen scroll
    // experience; setting to a column earlier than On PO releases
    // the columns to its right.
    freezeKey: "onPO",
    hiddenColumns: [],
    generalMarginPct: 21,
    collapseLevel: "none",
    expandedGroups: [],
    excludedSkus: [],
  };
}
