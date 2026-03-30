import { type SyncState, type SyncAction, initialSyncState } from "./syncTypes";

export function syncReducer(state: SyncState, action: SyncAction): SyncState {
  switch (action.type) {
    // ── Individual setters ──
    case "SET_LOADING":           return { ...state, loading: action.payload };
    case "SET_SYNCING":           return { ...state, syncing: action.payload };
    case "SET_SYNC_ERR":          return { ...state, syncErr: action.payload };
    case "SET_LAST_SYNC":         return { ...state, lastSync: action.payload };
    case "SET_SHOW_SYNC_MODAL":   return { ...state, showSyncModal: action.payload };
    case "SET_SYNC_FILTERS":      return { ...state, syncFilters: action.payload };
    case "SET_SYNC_PROGRESS":     return { ...state, syncProgress: action.payload };
    case "SET_SYNC_PROGRESS_MSG": return { ...state, syncProgressMsg: action.payload };
    case "SET_SYNC_DONE":         return { ...state, syncDone: action.payload };
    case "SET_SYNC_LOG":          return { ...state, syncLog: action.payload };
    case "SET_SHOW_SYNC_LOG":     return { ...state, showSyncLog: action.payload };
    case "SET_PO_SEARCH":         return { ...state, poSearch: action.payload };
    case "SET_PO_DROPDOWN_OPEN":  return { ...state, poDropdownOpen: action.payload };
    case "SET_XORO_VENDORS":      return { ...state, xoroVendors: action.payload };
    case "SET_MANUAL_VENDORS":    return { ...state, manualVendors: action.payload };
    case "SET_VENDOR_SEARCH":     return { ...state, vendorSearch: action.payload };
    case "SET_LOADING_VENDORS":   return { ...state, loadingVendors: action.payload };
    case "SET_NEW_MANUAL_VENDOR": return { ...state, newManualVendor: action.payload };

    // ── Batch actions — atomic multi-field updates ──
    case "SYNC_START":
      return { ...state, syncing: true, syncErr: "", syncDone: null, syncProgress: 0, syncProgressMsg: "Connecting to Xoro…" };
    case "SYNC_PROGRESS":
      return { ...state, syncProgress: action.payload.progress, syncProgressMsg: action.payload.msg };
    case "SYNC_COMPLETE":
      return { ...state, syncing: false, syncDone: action.payload, syncProgress: 100, syncProgressMsg: "Complete", lastSync: action.payload.lastSync };
    case "SYNC_FAIL":
      return { ...state, syncing: false, syncErr: action.payload, syncProgress: 0, syncProgressMsg: "" };
    case "SYNC_RESET":
      return { ...state, syncing: false, syncProgress: 0, syncProgressMsg: "", syncDone: null };
    case "APPEND_SYNC_LOG":
      return { ...state, syncLog: [action.payload, ...state.syncLog].slice(0, 10) };

    default:
      return state;
  }
}
