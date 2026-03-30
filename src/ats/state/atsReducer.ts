import { type ATSState, type ATSAction } from "./atsTypes";

export function atsReducer(state: ATSState, action: ATSAction): ATSState {
  switch (action.type) {
    case "SET":
      return { ...state, [action.field]: action.value };

    case "UPLOAD_START":
      return { ...state, uploadingFile: true, uploadProgress: { step: "Preparing…", pct: 0 }, uploadError: null, uploadSuccess: null };

    case "UPLOAD_PROGRESS":
      return { ...state, uploadProgress: { step: action.step, pct: action.pct } };

    case "UPLOAD_DONE":
      return { ...state, uploadingFile: false, uploadProgress: null, uploadSuccess: action.message, showUpload: false, invFile: null, purFile: null, ordFile: null };

    case "UPLOAD_FAIL":
      return { ...state, uploadingFile: false, uploadProgress: null, uploadError: action.error };

    case "UPLOAD_RESET":
      return { ...state, uploadingFile: false, uploadProgress: null, uploadError: null, uploadSuccess: null, uploadWarnings: null, pendingUploadData: null, showUpload: false, invFile: null, purFile: null, ordFile: null };

    case "SYNC_START":
      return { ...state, syncing: true, syncStatus: "Syncing…", syncError: null };

    case "SYNC_DONE":
      return { ...state, syncing: false, syncStatus: "", lastSync: action.lastSync };

    case "SYNC_FAIL":
      return { ...state, syncing: false, syncStatus: "", syncError: action.error };

    default:
      return state;
  }
}
