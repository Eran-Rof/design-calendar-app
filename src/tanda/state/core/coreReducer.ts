import { type CoreState, type CoreAction } from "./coreTypes";

export function coreReducer(state: CoreState, action: CoreAction): CoreState {
  switch (action.type) {
    case "SET":
      return { ...state, [action.field]: action.value };

    case "SELECT_PO":
      return { ...state, selected: action.po, detailMode: action.mode ?? "po" };

    case "SET_MILESTONES_FOR_PO":
      return { ...state, milestones: { ...state.milestones, [action.poNumber]: action.milestones } };

    case "SET_ATTACHMENTS_FOR_PO":
      return { ...state, attachments: { ...state.attachments, [action.poNumber]: action.attachments } };

    case "UPDATE_MILESTONE": {
      const arr = [...(state.milestones[action.poNumber] || [])];
      const idx = arr.findIndex(x => x.id === action.milestoneId);
      if (idx >= 0) arr[idx] = action.milestone; else arr.push(action.milestone);
      return { ...state, milestones: { ...state.milestones, [action.poNumber]: arr } };
    }

    case "DELETE_MILESTONES_FOR_PO": {
      const next = { ...state.milestones };
      delete next[action.poNumber];
      return { ...state, milestones: next };
    }

    case "UPDATE_ATTACHMENT": {
      const files = (state.attachments[action.poNumber] || []).map(a => a.id === action.attachId ? action.entry : a);
      return { ...state, attachments: { ...state.attachments, [action.poNumber]: files } };
    }

    case "REMOVE_PO":
      return {
        ...state,
        pos: state.pos.filter(p => (p.PoNumber ?? "") !== action.poNumber),
        notes: state.notes.filter(n => n.po_number !== action.poNumber),
        milestones: (() => { const next = { ...state.milestones }; delete next[action.poNumber]; return next; })(),
      };

    default:
      return state;
  }
}
