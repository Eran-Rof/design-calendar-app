import { type TeamsState, type TeamsAction } from "./teamsTypes";

export function teamsReducer(state: TeamsState, action: TeamsAction): TeamsState {
  switch (action.type) {
    case "SET":
      return { ...state, [action.field]: action.value };

    case "TEAMS_RESET_DM":
      return { ...state, teamsDirectTo: "", teamsDirectMsg: "", teamsDirectSending: false, teamsDirectErr: null };

    case "TEAMS_RESET_DTL_DM":
      return { ...state, dtlDMTo: "", dtlDMMsg: "", dtlDMSending: false, dtlDMErr: null, dtlDMContactSearch: "", dtlDMContactDropdown: false, dtlDMContactSearchResults: [], dtlDMContactSearchLoading: false };

    default:
      return state;
  }
}
