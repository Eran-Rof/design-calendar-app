import type { ATSRow, ExcelData, UploadWarning, CtxMenu, SummaryCtxMenu } from "../types";
import type { NormChange } from "../normalize";

export interface ATSState {
  // Date range
  startDate: string;
  rangeUnit: "days" | "weeks" | "months";
  rangeValue: number;
  // Filters
  search: string;
  filterCategory: string;
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
}

export type ATSAction =
  | { type: "SET"; field: keyof ATSState; value: any }
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
    filterCategory: "All",
    filterStatus: "All",
    minATS: "",
    storeFilter: ["All"],
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
  };
}
