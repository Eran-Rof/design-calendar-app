export interface EmailConfig {
  clientId: string;
  tenantId: string;
  emailMap: Record<string, string>;
}

export interface EmailState {
  // Auth (shared with Teams)
  msToken: string | null;
  msDisplayName: string;
  // Config
  emailConfig: EmailConfig;
  showEmailConfig: boolean;
  emailConfigForm: EmailConfig;
  // Main email view
  emailSelPO: string | null;
  emailsMap: Record<string, any[]>;
  emailLoadingMap: Record<string, boolean>;
  emailErrorsMap: Record<string, string | null>;
  emailSelMsg: any;
  emailThreadMsgs: any[];
  emailThreadLoading: boolean;
  emailTabCur: "inbox" | "sent" | "thread" | "compose";
  emailSentMap: Record<string, any[]>;
  emailSentLoading: Record<string, boolean>;
  emailSentErr: Record<string, string | null>;
  emailComposeTo: string;
  emailComposeSubject: string;
  emailComposeBody: string;
  emailSendErr: string | null;
  emailNextLinks: Record<string, string | null>;
  emailLoadingOlder: boolean;
  emailLastRefresh: Record<string, number>;
  emailReply: string;
  emailPOSearch: string;
  // 3-panel email UI
  emailActiveFolder: "inbox" | "sent";
  emailSearchQuery: string;
  emailFilterUnread: boolean;
  emailFilterFlagged: boolean;
  emailFlaggedSet: Set<string>;
  emailCollapsedMsgs: Set<string>;
  emailComposeOpen: boolean;
  emailDeleteConfirm: string | null;
  emailReplyText: string;
  emailSelectedId: string | null;
  emailCtxMenu: { x: number; y: number; em: any } | null;
  emailAttachments: Record<string, any[]>;
  emailAttachmentsLoading: Record<string, boolean>;
  // Per-PO aggregate stats fetched in one batch so badges + counts appear without clicking each PO
  emailAllStats: Record<string, { total: number; unread: number; latestDate: string; latestSubject: string; latestSender: string }>;
  emailAllStatsLoading: boolean;
  emailAllStatsError: string | null;
  // All inbox messages tagged with a [PO-...] prefix, used by "All POs" and "Unread" global views
  emailAllMessages: any[];
  // What the middle pane shows: a single PO's emails ("po"), all PO emails ("all"), or only unread ("unread")
  emailGlobalView: "po" | "all" | "unread" | "deleted";
  emailDeletedMessages: any[];
  emailDeletedLoading: boolean;
  emailDeletedError: string | null;
  emailFolderCtxMenu: { x: number; y: number; folder: "deleted" } | null;
  // Files staged in the compose window, encoded later by doSendEmail
  emailComposeAttachments: Array<{ name: string; size: number; contentType: string; contentBytes: string }>;
  emailComposeAttachLoading: boolean;
  // Detail-panel email tab
  dtlEmails: Record<string, any[]>;
  dtlEmailLoading: Record<string, boolean>;
  dtlEmailErr: Record<string, string | null>;
  dtlEmailSel: any;
  dtlEmailThread: any[];
  dtlThreadLoading: boolean;
  dtlEmailTab: "inbox" | "sent" | "thread" | "compose" | "teams";
  dtlSentEmails: Record<string, any[]>;
  dtlSentLoading: Record<string, boolean>;
  dtlComposeTo: string;
  dtlComposeSubject: string;
  dtlComposeBody: string;
  dtlSendErr: string | null;
  dtlReply: string;
  dtlNextLink: Record<string, string | null>;
  dtlLoadingOlder: boolean;
}

// Generic SET action — covers every field with type safety
export type EmailAction =
  | { type: "SET"; field: keyof EmailState; value: any }
  | { type: "MERGE_EMAILS_MAP"; key: string; emails: any[]; append?: boolean }
  | { type: "MERGE_SENT_MAP"; key: string; emails: any[] }
  | { type: "SET_NEXT_LINK"; key: string; link: string | null }
  | { type: "EMAIL_RESET_COMPOSE" }
  | { type: "EMAIL_RESET_DETAIL" }
  | { type: "TOGGLE_FLAGGED"; id: string }
  | { type: "TOGGLE_COLLAPSED_MSG"; id: string };

function loadEmailConfig(): EmailConfig {
  try { return JSON.parse(localStorage.getItem("tandaEmailConfig") || "null") || { clientId: "", tenantId: "", emailMap: {} }; }
  catch { return { clientId: "", tenantId: "", emailMap: {} }; }
}

function loadMsToken(): string | null {
  try { const s = JSON.parse(localStorage.getItem("ms_tokens_v1") || "null"); if (s?.accessToken && s.expiresAt > Date.now()) return s.accessToken; } catch (_) {}
  return null;
}

export const initialEmailState: EmailState = {
  msToken: loadMsToken(),
  msDisplayName: "",
  emailConfig: loadEmailConfig(),
  showEmailConfig: false,
  emailConfigForm: { clientId: "", tenantId: "", emailMap: {} },
  emailSelPO: null,
  emailsMap: {},
  emailLoadingMap: {},
  emailErrorsMap: {},
  emailSelMsg: null,
  emailThreadMsgs: [],
  emailThreadLoading: false,
  emailTabCur: "inbox",
  emailSentMap: {},
  emailSentLoading: {},
  emailSentErr: {},
  emailComposeTo: "",
  emailComposeSubject: "",
  emailComposeBody: "",
  emailSendErr: null,
  emailNextLinks: {},
  emailLoadingOlder: false,
  emailLastRefresh: {},
  emailReply: "",
  emailPOSearch: "",
  emailActiveFolder: "inbox",
  emailSearchQuery: "",
  emailFilterUnread: false,
  emailFilterFlagged: false,
  emailFlaggedSet: new Set(),
  emailCollapsedMsgs: new Set(),
  emailComposeOpen: false,
  emailDeleteConfirm: null,
  emailReplyText: "",
  emailSelectedId: null,
  emailCtxMenu: null,
  emailAttachments: {},
  emailAttachmentsLoading: {},
  emailAllStats: {},
  emailAllStatsLoading: false,
  emailAllStatsError: null,
  emailAllMessages: [],
  emailGlobalView: "po",
  emailComposeAttachments: [],
  emailComposeAttachLoading: false,
  emailDeletedMessages: [],
  emailDeletedLoading: false,
  emailDeletedError: null,
  emailFolderCtxMenu: null,
  dtlEmails: {},
  dtlEmailLoading: {},
  dtlEmailErr: {},
  dtlEmailSel: null,
  dtlEmailThread: [],
  dtlThreadLoading: false,
  dtlEmailTab: "inbox",
  dtlSentEmails: {},
  dtlSentLoading: {},
  dtlComposeTo: "",
  dtlComposeSubject: "",
  dtlComposeBody: "",
  dtlSendErr: null,
  dtlReply: "",
  dtlNextLink: {},
  dtlLoadingOlder: false,
};
