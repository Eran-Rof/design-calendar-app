import { type EmailState, type EmailAction } from "./emailTypes";

export function emailReducer(state: EmailState, action: EmailAction): EmailState {
  switch (action.type) {
    case "SET":
      return { ...state, [action.field]: action.value };

    case "MERGE_EMAILS_MAP": {
      const prev = state.emailsMap[action.key] || [];
      return { ...state, emailsMap: { ...state.emailsMap, [action.key]: action.append ? [...prev, ...action.emails] : action.emails } };
    }
    case "MERGE_SENT_MAP":
      return { ...state, emailSentMap: { ...state.emailSentMap, [action.key]: action.emails } };

    case "SET_NEXT_LINK":
      return { ...state, emailNextLinks: { ...state.emailNextLinks, [action.key]: action.link } };

    case "EMAIL_RESET_COMPOSE":
      return { ...state, emailComposeTo: "", emailComposeSubject: "", emailComposeBody: "", emailSendErr: null };

    case "EMAIL_RESET_DETAIL":
      return { ...state, dtlComposeTo: "", dtlComposeSubject: "", dtlComposeBody: "", dtlSendErr: null, dtlReply: "", dtlEmailSel: null, dtlEmailThread: [], dtlThreadLoading: false };

    case "TOGGLE_FLAGGED": {
      const next = new Set(state.emailFlaggedSet);
      if (next.has(action.id)) next.delete(action.id); else next.add(action.id);
      return { ...state, emailFlaggedSet: next };
    }
    case "TOGGLE_COLLAPSED_MSG": {
      const next = new Set(state.emailCollapsedMsgs);
      if (next.has(action.id)) next.delete(action.id); else next.add(action.id);
      return { ...state, emailCollapsedMsgs: next };
    }

    default:
      return state;
  }
}
