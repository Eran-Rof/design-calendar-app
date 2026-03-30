import { type DCState, type DCAction } from "./dcTypes";

export function dcReducer(state: DCState, action: DCAction): DCState {
  switch (action.type) {
    case "SET":
      return { ...state, [action.field]: action.value };

    case "CLOSE_ALL_MODALS":
      return {
        ...state,
        showWizard: false, showVendors: false, showTeam: false, showUsers: false,
        showSizeLib: false, showCatLib: false, showAddTask: false, showBrands: false,
        showSeasons: false, showCustomers: false, showOrderTypes: false, showRoles: false,
        showGenders: false, showActivity: false, showTaskManager: false,
        showTeamsConfig: false, showEmailConfig: false,
        editTask: null, editCollKey: null, ctxMenu: null,
      };

    case "PUSH_UNDO":
      return { ...state, undoStack: [action.entry, ...state.undoStack].slice(0, 4) };

    case "POP_UNDO": {
      const [, ...rest] = state.undoStack;
      return { ...state, undoStack: rest };
    }

    default:
      return state;
  }
}
