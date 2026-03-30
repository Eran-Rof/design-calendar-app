import type { SyncFilters } from "../../../utils/tandaTypes";

export interface SyncLogEntry {
  ts: string;
  user: string;
  success: boolean;
  added: number;
  changed: number;
  deleted: number;
  error?: string;
  filters?: SyncFilters;
}

export interface SyncState {
  loading: boolean;
  syncing: boolean;
  syncErr: string;
  lastSync: string;
  showSyncModal: boolean;
  syncFilters: SyncFilters;
  syncProgress: number;
  syncProgressMsg: string;
  syncDone: { added: number; changed: number; deleted: number } | null;
  syncLog: SyncLogEntry[];
  showSyncLog: boolean;
  poSearch: string;
  poDropdownOpen: boolean;
  xoroVendors: string[];
  manualVendors: string[];
  vendorSearch: string;
  loadingVendors: boolean;
  newManualVendor: string;
}

export type SyncAction =
  | { type: "SET_LOADING"; payload: boolean }
  | { type: "SET_SYNCING"; payload: boolean }
  | { type: "SET_SYNC_ERR"; payload: string }
  | { type: "SET_LAST_SYNC"; payload: string }
  | { type: "SET_SHOW_SYNC_MODAL"; payload: boolean }
  | { type: "SET_SYNC_FILTERS"; payload: SyncFilters }
  | { type: "SET_SYNC_PROGRESS"; payload: number }
  | { type: "SET_SYNC_PROGRESS_MSG"; payload: string }
  | { type: "SET_SYNC_DONE"; payload: { added: number; changed: number; deleted: number } | null }
  | { type: "SET_SYNC_LOG"; payload: SyncLogEntry[] }
  | { type: "SET_SHOW_SYNC_LOG"; payload: boolean }
  | { type: "SET_PO_SEARCH"; payload: string }
  | { type: "SET_PO_DROPDOWN_OPEN"; payload: boolean }
  | { type: "SET_XORO_VENDORS"; payload: string[] }
  | { type: "SET_MANUAL_VENDORS"; payload: string[] }
  | { type: "SET_VENDOR_SEARCH"; payload: string }
  | { type: "SET_LOADING_VENDORS"; payload: boolean }
  | { type: "SET_NEW_MANUAL_VENDOR"; payload: string }
  // Batch actions — set multiple fields atomically (1 render instead of N)
  | { type: "SYNC_START" }
  | { type: "SYNC_PROGRESS"; payload: { progress: number; msg: string } }
  | { type: "SYNC_COMPLETE"; payload: { added: number; changed: number; deleted: number; lastSync: string } }
  | { type: "SYNC_FAIL"; payload: string }
  | { type: "SYNC_RESET" }
  | { type: "APPEND_SYNC_LOG"; payload: SyncLogEntry };

export const initialSyncState: SyncState = {
  loading: false,
  syncing: false,
  syncErr: "",
  lastSync: "",
  showSyncModal: false,
  syncFilters: { poNumbers: [], dateFrom: "", dateTo: "", vendors: [], statuses: [] },
  syncProgress: 0,
  syncProgressMsg: "",
  syncDone: null,
  syncLog: [],
  showSyncLog: false,
  poSearch: "",
  poDropdownOpen: false,
  xoroVendors: [],
  manualVendors: [],
  vendorSearch: "",
  loadingVendors: false,
  newManualVendor: "",
};
