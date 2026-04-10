import React, { useState, useEffect, useCallback, useRef } from "react";
import { msSignIn, loadMsTokens, saveMsTokens, clearMsTokens, getMsAccessToken, MS_CLIENT_ID, MS_TENANT_ID } from "./utils/msAuth";

import { SB_URL, SB_KEY, SB_HEADERS } from "./utils/supabase";
import { type XoroPO, type Milestone, type WipTemplate, type LocalNote, type User, type DCVendor, type DmConversation, type SyncFilters, type View, ALL_PO_STATUSES, ACTIVE_PO_STATUSES, STATUS_COLORS, STATUS_OPTIONS, WIP_CATEGORIES, MILESTONE_STATUSES, MILESTONE_STATUS_COLORS, DEFAULT_WIP_TEMPLATES, milestoneUid, itemQty, poTotal, normalizeSize, sizeSort, mapXoroRaw, fmtDate, fmtCurrency } from "./utils/tandaTypes";
import S from "./tanda/styles";
import { generateMilestones as _generateMilestones, mergeMilestones } from "./tanda/milestones";
import { getArchiveDecisions } from "./tanda/syncLogic";
import { exportPOExcel } from "./tanda/exportHelpers";
import { emailViewPanel as emailViewPanelExtracted, type EmailPanelCtx } from "./tanda/emailPanel";
import { buildEmailHtml } from "./tanda/richTextEditor";
import { teamsViewPanel as teamsViewPanelExtracted, type TeamsPanelCtx } from "./tanda/teamsPanel";
import { timelinePanel as timelinePanelExtracted, type TimelinePanelCtx } from "./tanda/timelinePanel";
import { detailPanel as detailPanelExtracted, WipTemplateEditor } from "./tanda/detailPanel";
import { SyncProvider, useSyncState, useSyncDispatch } from "./tanda/state/sync/SyncContext";
import type { SyncLogEntry } from "./tanda/state/sync/syncTypes";
import { EmailProvider, useEmailState, useEmailDispatch } from "./tanda/state/email/EmailContext";
import type { EmailState } from "./tanda/state/email/emailTypes";
import { TeamsProvider, useTeamsState, useTeamsDispatch } from "./tanda/state/teams/TeamsContext";
import type { TeamsState } from "./tanda/state/teams/teamsTypes";
import { CoreProvider, useCoreState, useCoreDispatch } from "./tanda/state/core/CoreContext";
import type { CoreState } from "./tanda/state/core/coreTypes";

// ── Supabase helpers ──────────────────────────────────────────────────────────
const sb = {
  from: (table: string) => ({
    select: async (cols = "*", filter = "") => {
      const res = await fetch(`${SB_URL}/rest/v1/${table}?select=${cols}${filter ? "&" + filter : ""}`, { headers: SB_HEADERS });
      const data = await res.json();
      return { data, error: res.ok ? null : data };
    },
    insert: async (rows: any) => {
      const body = Array.isArray(rows) ? rows : [rows];
      const res = await fetch(`${SB_URL}/rest/v1/${table}`, { method: "POST", headers: SB_HEADERS, body: JSON.stringify(body) });
      const data = await res.json();
      return { data, error: res.ok ? null : data };
    },
    upsert: async (rows: any, opts?: { onConflict?: string }) => {
      const body = Array.isArray(rows) ? rows : [rows];
      const url = `${SB_URL}/rest/v1/${table}${opts?.onConflict ? `?on_conflict=${opts.onConflict}` : ""}`;
      const res = await fetch(url, { method: "POST", headers: { ...SB_HEADERS, "Prefer": "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
      const data = await res.json();
      return { data, error: res.ok ? null : data };
    },
    delete: async (filter: string) => {
      const res = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, { method: "DELETE", headers: SB_HEADERS });
      return { error: res.ok ? null : await res.json() };
    },
    single: async (cols = "*", filter = "") => {
      const res = await fetch(`${SB_URL}/rest/v1/${table}?select=${cols}${filter ? "&" + filter : ""}&limit=1`, { headers: SB_HEADERS });
      const data = await res.json();
      return { data: Array.isArray(data) ? data[0] ?? null : null, error: res.ok ? null : data };
    },
  }),
};
// ── Xoro fetch helpers ────────────────────────────────────────────────────────

interface XoroFetchOpts {
  page?: number;
  fetchAll?: boolean;
  signal?: AbortSignal;
  statuses?: string[];
  vendors?: string[];
  poNumber?: string;
  dateFrom?: string;
  dateTo?: string;
}

async function fetchXoroPOs(opts: XoroFetchOpts = {}): Promise<{ pos: XoroPO[]; totalPages: number }> {
  const { page = 1, fetchAll = false, signal, statuses, vendors, poNumber, dateFrom, dateTo } = opts;
  const params = new URLSearchParams({ path: "purchaseorder/getpurchaseorder", per_page: "200", page_size: "200", pagesize: "200", rows: "200", limit: "200", RecordsPerPage: "200", PageSize: "200", itemsPerPage: "200" });
  if (fetchAll) { params.set("fetch_all", "true"); } else { params.set("page", String(page)); }
  const statusList = statuses?.length ? statuses : ALL_PO_STATUSES;
  params.set("status", statusList.join(","));
  if (vendors?.length) params.set("vendor_name", vendors.join(","));
  if (poNumber) params.set("order_number", poNumber);
  if (dateFrom) {
    const d = new Date(dateFrom);
    if (!isNaN(d.getTime())) params.set("created_at_min", d.toISOString());
  }
  if (dateTo) {
    const d = new Date(dateTo + "T23:59:59");
    if (!isNaN(d.getTime())) params.set("created_at_max", d.toISOString());
  }
  // 30s per-request timeout — chained with caller's signal so cancelSync still works.
  const timeoutCtl = new AbortController();
  const timeoutId = setTimeout(() => timeoutCtl.abort(), 30000);
  const onAbort = () => timeoutCtl.abort();
  if (signal) {
    if (signal.aborted) timeoutCtl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  let res: Response;
  try {
    res = await fetch(`/api/xoro-proxy?${params}`, { signal: timeoutCtl.signal });
  } catch (err: any) {
    if (timeoutCtl.signal.aborted && !signal?.aborted) {
      throw new Error("Xoro proxy timed out after 30s");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
  if (!res.ok) throw new Error(`Xoro proxy error: ${res.status}`);
  const json = await res.json();
  if (!json.Result) {
    if (Array.isArray(json.Data) && json.Data.length > 0) {
      // Has data despite Result:false — use it
    } else {
      return { pos: [], totalPages: 0 };
    }
  }
  const raw = Array.isArray(json.Data) ? json.Data : [];
  if (json._pagesActuallyFetched) console.log(`[Xoro] pages fetched: ${json._pagesActuallyFetched}, records: ${raw.length}`);
  return { pos: mapXoroRaw(raw), totalPages: json.TotalPages ?? 1 };
}

function applyFilters(pos: XoroPO[], filters?: SyncFilters): XoroPO[] {
  if (!filters) return pos;
  return pos.filter(po => {
    if (filters.poNumbers?.length && !filters.poNumbers.some(pn => (po.PoNumber ?? "").toLowerCase().includes(pn.toLowerCase()))) return false;
    if (filters.statuses?.length && !filters.statuses.includes(po.StatusName ?? "")) return false;
    if (filters.vendors?.length && !filters.vendors.some(v => v.toLowerCase() === (po.VendorName ?? "").toLowerCase())) return false;
    if (filters.dateFrom) {
      const d = po.DateOrder ? new Date(po.DateOrder) : null;
      if (!d || d < new Date(filters.dateFrom)) return false;
    }
    if (filters.dateTo) {
      const d = po.DateOrder ? new Date(po.DateOrder) : null;
      if (!d || d > new Date(filters.dateTo + "T23:59:59")) return false;
    }
    return true;
  });
}

async function fetchXoroVendors(): Promise<string[]> {
  try {
    const { pos } = await fetchXoroPOs({ page: 1 });
    return [...new Set(pos.map(p => p.VendorName ?? "").filter(Boolean))].sort();
  } catch { return []; }
}

function daysUntil(d?: string) {
  if (!d) return null;
  return Math.ceil((new Date(d).getTime() - Date.now()) / 86400000);
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function TandAAppWrapper() {
  return <CoreProvider><SyncProvider><EmailProvider><TeamsProvider><TandAApp /></TeamsProvider></EmailProvider></SyncProvider></CoreProvider>;
}

function TandAApp() {
  const sync = useSyncState();
  const syncD = useSyncDispatch();
  const em = useEmailState();
  const emD = useEmailDispatch();
  const emSet = <K extends keyof EmailState>(field: K, value: EmailState[K]) => emD({ type: "SET", field, value });
  const tm = useTeamsState();
  const tmD = useTeamsDispatch();
  const tmSet = <K extends keyof TeamsState>(field: K, value: TeamsState[K]) => tmD({ type: "SET", field, value });
  const core = useCoreState();
  const coreD = useCoreDispatch();
  const coreSet = <K extends keyof CoreState>(field: K, value: CoreState[K]) => coreD({ type: "SET", field, value });
  // ── Core PO state → useCoreState() + useCoreDispatch() (see tanda/state/core/) ──
  const user = core.user;
  const view = core.view;
  const pos = core.pos;
  const notes = core.notes;
  const selected = core.selected;
  const detailMode = core.detailMode;
  const attachments = core.attachments;
  const uploadingAttachment = core.uploadingAttachment;
  const setUser = (v: User | null) => coreSet("user", v);
  const setView = (v: View) => coreSet("view", v);
  const setPos = (v: any) => { if (typeof v === "function") coreSet("pos", v(core.pos)); else coreSet("pos", v); };
  const setNotes = (v: any) => { if (typeof v === "function") coreSet("notes", v(core.notes)); else coreSet("notes", v); };
  const setSelected = (v: XoroPO | null) => coreSet("selected", v);
  const setDetailMode = (v: "header" | "po" | "milestones" | "notes" | "history" | "matrix" | "email" | "attachments" | "all") => coreSet("detailMode", v);
  const setAttachments = (v: any) => { if (typeof v === "function") coreSet("attachments", v(core.attachments)); else coreSet("attachments", v); };
  const setUploadingAttachment = (v: boolean) => coreSet("uploadingAttachment", v);
  const [, setCountdownTick] = useState(0);
  // Tick every second when there are soft-deleted attachments (for live countdown)
  useEffect(() => { localStorage.setItem("tanda_view", view); }, [view]);

  useEffect(() => {
    const hasPending = Object.values(attachments).flat().some(a => (a as any).deleted_at);
    if (!hasPending) return;
    const t = setInterval(() => setCountdownTick(c => c + 1), 1000);
    return () => clearInterval(t);
  }, [attachments]);
  const attachInputRef = useRef<HTMLInputElement>(null);
  // ── Archive state ───────────────────────────────────────────────────────
  const [archivedPos, setArchivedPos] = useState<XoroPO[]>([]);
  const [archiveSearch, setArchiveSearch] = useState("");
  const [archiveFilterVendor, setArchiveFilterVendor] = useState("All");
  const [archiveFilterStatus, setArchiveFilterStatus] = useState("All");
  const [archiveSelected, setArchiveSelected] = useState<Set<string>>(new Set());
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [matrixCollapsed, setMatrixCollapsed] = useState(false);
  const [lineItemsCollapsed, setLineItemsCollapsed] = useState(true);
  const [poInfoCollapsed, setPoInfoCollapsed] = useState(false);
  const [progressCollapsed, setProgressCollapsed] = useState(false);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState("");
  const [msNoteText, setMsNoteText] = useState("");
  const [expandedVariants, setExpandedVariants] = useState<Set<string>>(new Set());
  // Close any open variant panels when the user clicks outside the panel or its toggle.
  useEffect(() => {
    if (expandedVariants.size === 0) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest("[data-variant-panel]")) return;
      if (t.closest("[data-variant-toggle]")) return;
      setExpandedVariants(new Set());
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [expandedVariants]);
  const [addingPhase, setAddingPhase] = useState(false);
  const [newPhaseForm, setNewPhaseForm] = useState({ name: "", category: "Pre-Production", dueDate: "", afterPhase: "" });
  const [acceptedBlocked, setAcceptedBlocked] = useState<Set<string>>(new Set());
  const [blockedModal, setBlockedModal] = useState<{ cat: string; delayedCat: string; daysLate: number; onConfirm: () => void } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ title: string; message: string; icon: string; confirmText: string; confirmColor: string; cancelText?: string; listItems?: string[]; onConfirm: () => void; onCancel?: () => void } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [askMeOpen, setAskMeOpen] = useState(false);
  const [askMeQuery, setAskMeQuery] = useState("");
  const [askMeHistory, setAskMeHistory] = useState<{ q: string; a: string }[]>([]);
  const [showBulkUpdate, setShowBulkUpdate] = useState(false);
  const [bulkVendor, setBulkVendor] = useState("");
  const [bulkPhase, setBulkPhase] = useState("");
  const [bulkStatus, setBulkStatus] = useState("");
  const [bulkCategory, setBulkCategory] = useState("");
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [bulkPOs, setBulkPOs] = useState<string[]>([]);
  const [bulkPOSearch, setBulkPOSearch] = useState("");
  const [bulkPhases, setBulkPhases] = useState<string[]>([]);
  // sync state → useSyncState() + useSyncDispatch() (see tanda/state/sync/)
  const loading = sync.loading;
  const syncing = sync.syncing;
  const syncErr = sync.syncErr;
  const lastSync = sync.lastSync;
  const showSyncModal = sync.showSyncModal;
  const setLoading = (v: boolean) => syncD({ type: "SET_LOADING", payload: v });
  const setSyncing = (v: boolean) => syncD({ type: "SET_SYNCING", payload: v });
  const setSyncErr = (v: string) => syncD({ type: "SET_SYNC_ERR", payload: v });
  const setLastSync = (v: string) => syncD({ type: "SET_LAST_SYNC", payload: v });
  const setShowSyncModal = (v: boolean) => syncD({ type: "SET_SHOW_SYNC_MODAL", payload: v });
  const [search, setSearch]     = useState("");
  const [filterStatus, setFilterStatus] = useState("All");
  const [filterVendor, setFilterVendor] = useState("All");
  const [sortBy, setSortBy] = useState<"ddp" | "po_date" | "status">("ddp");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [showSettings, setShowSettings] = useState(false);
  const [newNote, setNewNote]   = useState("");
  const syncAbortRef = useRef<AbortController | null>(null);
  const generatingRef = useRef<Set<string>>(new Set());
  const conflictPendingRef = useRef<Set<string>>(new Set());

  // Sync filter/progress/log state → reducer
  const syncFilters = sync.syncFilters;
  const syncProgress = sync.syncProgress;
  const syncProgressMsg = sync.syncProgressMsg;
  const syncDone = sync.syncDone;
  const syncLog = sync.syncLog;
  const showSyncLog = sync.showSyncLog;
  const poSearch = sync.poSearch;
  const poDropdownOpen = sync.poDropdownOpen;
  const xoroVendors = sync.xoroVendors;
  const manualVendors = sync.manualVendors;
  const vendorSearch = sync.vendorSearch;
  const loadingVendors = sync.loadingVendors;
  const newManualVendor = sync.newManualVendor;
  const setSyncFilters = (v: any) => { if (typeof v === "function") syncD({ type: "SET_SYNC_FILTERS", payload: v(sync.syncFilters) }); else syncD({ type: "SET_SYNC_FILTERS", payload: v }); };
  const setSyncProgress = (v: number) => syncD({ type: "SET_SYNC_PROGRESS", payload: v });
  const setSyncProgressMsg = (v: string) => syncD({ type: "SET_SYNC_PROGRESS_MSG", payload: v });
  const setSyncDone = (v: { added: number; changed: number; deleted: number } | null) => syncD({ type: "SET_SYNC_DONE", payload: v });
  const setSyncLog = (v: SyncLogEntry[]) => syncD({ type: "SET_SYNC_LOG", payload: v });
  const setShowSyncLog = (v: boolean) => syncD({ type: "SET_SHOW_SYNC_LOG", payload: v });
  const setPoSearch = (v: string) => syncD({ type: "SET_PO_SEARCH", payload: v });
  const setPoDropdownOpen = (v: boolean) => syncD({ type: "SET_PO_DROPDOWN_OPEN", payload: v });
  const setXoroVendors = (v: string[]) => syncD({ type: "SET_XORO_VENDORS", payload: v });
  const setManualVendors = (v: string[]) => syncD({ type: "SET_MANUAL_VENDORS", payload: v });
  const setVendorSearch = (v: string) => syncD({ type: "SET_VENDOR_SEARCH", payload: v });
  const setLoadingVendors = (v: boolean) => syncD({ type: "SET_LOADING_VENDORS", payload: v });
  const setNewManualVendor = (v: string) => syncD({ type: "SET_NEW_MANUAL_VENDOR", payload: v });

  // ── WIP Milestone state → core reducer ──
  const wipTemplates = core.wipTemplates;
  const milestones = core.milestones;
  const dcVendors = core.dcVendors;
  const designTemplates = core.designTemplates;
  const setWipTemplates = (v: any) => { if (typeof v === "function") coreSet("wipTemplates", v(core.wipTemplates)); else coreSet("wipTemplates", v); };
  const setMilestones = (v: any) => { if (typeof v === "function") coreSet("milestones", v(core.milestones)); else coreSet("milestones", v); };
  const setDcVendors = (v: any) => coreSet("dcVendors", v);
  const setDesignTemplates = (v: any) => coreSet("designTemplates", v);
  const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>({});
  const [tplVendor, setTplVendor] = useState("__default__"); // selected vendor in templates view
  const [showCreateTpl, setShowCreateTpl] = useState<string | null>(null); // vendor name to create template for
  // ── Template editor local state (buffers edits until Save is clicked) ──
  const [tplLocalEdits, setTplLocalEdits] = useState<{ vendor: string; edits: WipTemplate[] } | null>(null);
  const [tplUndoStack, setTplUndoStack] = useState<WipTemplate[][]>([]);
  const [tplDragIdx, setTplDragIdx] = useState<number | null>(null);
  const [tplDragOverIdx, setTplDragOverIdx] = useState<number | null>(null);

  // ── Outlook Email state → useEmailState() + useEmailDispatch() (see tanda/state/email/) ──
  const emailConfig = em.emailConfig;
  const msToken = em.msToken;
  const msDisplayName = em.msDisplayName;
  const emailToken = msToken;
  const teamsToken = msToken;
  const emailTokenExpiry = null as number | null; // legacy compat
  const showEmailConfig = em.showEmailConfig;
  const emailSelPO = em.emailSelPO;
  const emailsMap = em.emailsMap;
  const emailLoadingMap = em.emailLoadingMap;
  const emailErrorsMap = em.emailErrorsMap;
  const emailSelMsg = em.emailSelMsg;
  const emailThreadMsgs = em.emailThreadMsgs;
  const emailThreadLoading = em.emailThreadLoading;
  const emailTabCur = em.emailTabCur;
  const emailSentMap = em.emailSentMap;
  const emailSentLoading = em.emailSentLoading;
  const emailSentErr = em.emailSentErr;
  const emailComposeTo = em.emailComposeTo;
  const emailComposeSubject = em.emailComposeSubject;
  const emailComposeBody = em.emailComposeBody;
  const emailSendErr = em.emailSendErr;
  const emailNextLinks = em.emailNextLinks;
  const emailLoadingOlder = em.emailLoadingOlder;
  const emailLastRefresh = em.emailLastRefresh;
  const emailReply = em.emailReply;
  const emailConfigForm = em.emailConfigForm;
  const emailPOSearch = em.emailPOSearch;
  const setEmailConfig = (v: any) => emSet("emailConfig", v);
  const setMsToken = (v: string | null) => emSet("msToken", v);
  const setMsDisplayName = (v: string) => emSet("msDisplayName", v);
  const setShowEmailConfig = (v: boolean) => emSet("showEmailConfig", v);
  const setEmailSelPO = (v: string | null) => emSet("emailSelPO", v);
  const setEmailsMap = (v: any) => { if (typeof v === "function") emSet("emailsMap", v(em.emailsMap)); else emSet("emailsMap", v); };
  const setEmailLoadingMap = (v: any) => { if (typeof v === "function") emSet("emailLoadingMap", v(em.emailLoadingMap)); else emSet("emailLoadingMap", v); };
  const setEmailErrorsMap = (v: any) => { if (typeof v === "function") emSet("emailErrorsMap", v(em.emailErrorsMap)); else emSet("emailErrorsMap", v); };
  const setEmailSelMsg = (v: any) => emSet("emailSelMsg", v);
  const setEmailThreadMsgs = (v: any) => emSet("emailThreadMsgs", v);
  const setEmailThreadLoading = (v: boolean) => emSet("emailThreadLoading", v);
  const setEmailTabCur = (v: "inbox" | "sent" | "thread" | "compose") => emSet("emailTabCur", v);
  const setEmailSentMap = (v: any) => { if (typeof v === "function") emSet("emailSentMap", v(em.emailSentMap)); else emSet("emailSentMap", v); };
  const setEmailSentLoading = (v: any) => { if (typeof v === "function") emSet("emailSentLoading", v(em.emailSentLoading)); else emSet("emailSentLoading", v); };
  const setEmailSentErrMap = (v: any) => { if (typeof v === "function") emSet("emailSentErr", v(em.emailSentErr)); else emSet("emailSentErr", v); };
  const setEmailComposeTo = (v: string) => emSet("emailComposeTo", v);
  const setEmailComposeSubject = (v: string) => emSet("emailComposeSubject", v);
  const setEmailComposeBody = (v: string) => emSet("emailComposeBody", v);
  const setEmailSendErr = (v: string | null) => emSet("emailSendErr", v);
  const setEmailNextLinks = (v: any) => { if (typeof v === "function") emSet("emailNextLinks", v(em.emailNextLinks)); else emSet("emailNextLinks", v); };
  const setEmailLoadingOlder = (v: boolean) => emSet("emailLoadingOlder", v);
  const setEmailLastRefresh = (v: any) => { if (typeof v === "function") emSet("emailLastRefresh", v(em.emailLastRefresh)); else emSet("emailLastRefresh", v); };
  const setEmailReply = (v: string) => emSet("emailReply", v);
  const setEmailConfigForm = (v: any) => emSet("emailConfigForm", v);
  const setEmailPOSearch = (v: string) => emSet("emailPOSearch", v);
  // ── Teams state → useTeamsState() + useTeamsDispatch() (see tanda/state/teams/) ──
  const teamsChannelMap = tm.teamsChannelMap;
  const teamsTeamId = tm.teamsTeamId;
  const teamsSelPO = tm.teamsSelPO;
  const teamsMessages = tm.teamsMessages;
  const teamsLoading = tm.teamsLoading;
  const teamsCreating = tm.teamsCreating;
  const teamsNewMsg = tm.teamsNewMsg;
  const teamsAuthStatus = tm.teamsAuthStatus;
  const teamsSearchPO = tm.teamsSearchPO;
  const teamsDirectTo = tm.teamsDirectTo;
  const teamsDirectMsg = tm.teamsDirectMsg;
  const teamsDirectSending = tm.teamsDirectSending;
  const teamsDirectErr = tm.teamsDirectErr;
  const teamsTab = tm.teamsTab;
  const dmConversations = tm.dmConversations;
  const dmActiveChatId = tm.dmActiveChatId;
  const dmComposing = tm.dmComposing;
  const dmSelectedName = tm.dmSelectedName;
  const dmLoading = tm.dmLoading;
  const dmError = tm.dmError;
  const dmNewMsg = tm.dmNewMsg;
  const dmSending = tm.dmSending;
  const dmScrollRef = useRef<HTMLDivElement>(null);
  const dmPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const TEAMS_PURPLE = "#5b5ea6";
  const TEAMS_PURPLE_LT = "#7b83eb";
  const teamsContacts = tm.teamsContacts;
  const teamsContactsLoading = tm.teamsContactsLoading;
  const teamsContactSearch = tm.teamsContactSearch;
  const teamsContactDropdown = tm.teamsContactDropdown;
  const teamsContactSearchResults = tm.teamsContactSearchResults;
  const teamsContactSearchLoading = tm.teamsContactSearchLoading;
  const teamsContactsError = tm.teamsContactsError;
  const teamsContactSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dtlDMTo = tm.dtlDMTo;
  const dtlDMMsg = tm.dtlDMMsg;
  const dtlDMSending = tm.dtlDMSending;
  const dtlDMErr = tm.dtlDMErr;
  const dtlDMContactSearch = tm.dtlDMContactSearch;
  const dtlDMContactDropdown = tm.dtlDMContactDropdown;
  const dtlDMContactSearchResults = tm.dtlDMContactSearchResults;
  const dtlDMContactSearchLoading = tm.dtlDMContactSearchLoading;
  const dtlDMContactSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setTeamsChannelMap = (v: any) => tmSet("teamsChannelMap", v);
  const setTeamsTeamId = (v: string) => tmSet("teamsTeamId", v);
  const setTeamsSelPO = (v: string | null) => tmSet("teamsSelPO", v);
  const setTeamsMessages = (v: any) => { if (typeof v === "function") tmSet("teamsMessages", v(tm.teamsMessages)); else tmSet("teamsMessages", v); };
  const setTeamsLoading = (v: any) => { if (typeof v === "function") tmSet("teamsLoading", v(tm.teamsLoading)); else tmSet("teamsLoading", v); };
  const setTeamsCreating = (v: string | null) => tmSet("teamsCreating", v);
  const setTeamsNewMsg = (v: string) => tmSet("teamsNewMsg", v);
  const setTeamsAuthStatus = (v: "idle" | "loading" | "error") => tmSet("teamsAuthStatus", v);
  const setTeamsSearchPO = (v: string) => tmSet("teamsSearchPO", v);
  const setTeamsDirectTo = (v: string) => tmSet("teamsDirectTo", v);
  const setTeamsDirectMsg = (v: string) => tmSet("teamsDirectMsg", v);
  const setTeamsDirectSending = (v: boolean) => tmSet("teamsDirectSending", v);
  const setTeamsDirectErr = (v: string | null) => tmSet("teamsDirectErr", v);
  const setTeamsTab = (v: "channels" | "direct") => tmSet("teamsTab", v);
  const setDmConversations = (v: any) => { if (typeof v === "function") tmSet("dmConversations", v(tm.dmConversations)); else tmSet("dmConversations", v); };
  const setDmActiveChatId = (v: string | null) => tmSet("dmActiveChatId", v);
  const setDmComposing = (v: boolean) => tmSet("dmComposing", v);
  const setDmSelectedName = (v: string) => tmSet("dmSelectedName", v);
  const setDmLoading = (v: boolean) => tmSet("dmLoading", v);
  const setDmError = (v: string | null) => tmSet("dmError", v);
  const setDmNewMsg = (v: string) => tmSet("dmNewMsg", v);
  const setDmSending = (v: boolean) => tmSet("dmSending", v);
  const setTeamsContacts = (v: any) => tmSet("teamsContacts", v);
  const setTeamsContactsLoading = (v: boolean) => tmSet("teamsContactsLoading", v);
  const setTeamsContactSearch = (v: string) => tmSet("teamsContactSearch", v);
  const setTeamsContactDropdown = (v: boolean) => tmSet("teamsContactDropdown", v);
  const setTeamsContactSearchResults = (v: any) => tmSet("teamsContactSearchResults", v);
  const setTeamsContactSearchLoading = (v: boolean) => tmSet("teamsContactSearchLoading", v);
  const setTeamsContactsError = (v: string | null) => tmSet("teamsContactsError", v);
  const setDtlDMTo = (v: string) => tmSet("dtlDMTo", v);
  const setDtlDMMsg = (v: string) => tmSet("dtlDMMsg", v);
  const setDtlDMSending = (v: boolean) => tmSet("dtlDMSending", v);
  const setDtlDMErr = (v: string | null) => tmSet("dtlDMErr", v);
  const setDtlDMContactSearch = (v: string) => tmSet("dtlDMContactSearch", v);
  const setDtlDMContactDropdown = (v: boolean) => tmSet("dtlDMContactDropdown", v);
  const setDtlDMContactSearchResults = (v: any) => tmSet("dtlDMContactSearchResults", v);
  const setDtlDMContactSearchLoading = (v: boolean) => tmSet("dtlDMContactSearchLoading", v);
  // Detail-panel email + 3-panel UI → email reducer
  const dtlEmails = em.dtlEmails;
  const dtlEmailLoading = em.dtlEmailLoading;
  const dtlEmailErr = em.dtlEmailErr;
  const dtlEmailSel = em.dtlEmailSel;
  const dtlEmailThread = em.dtlEmailThread;
  const dtlThreadLoading = em.dtlThreadLoading;
  const dtlEmailTab = em.dtlEmailTab;
  const dtlSentEmails = em.dtlSentEmails;
  const dtlSentLoading = em.dtlSentLoading;
  const dtlComposeTo = em.dtlComposeTo;
  const dtlComposeSubject = em.dtlComposeSubject;
  const dtlComposeBody = em.dtlComposeBody;
  const dtlSendErr = em.dtlSendErr;
  const dtlReply = em.dtlReply;
  const dtlNextLink = em.dtlNextLink;
  const dtlLoadingOlder = em.dtlLoadingOlder;
  const emailActiveFolder = em.emailActiveFolder;
  const emailSearchQuery = em.emailSearchQuery;
  const emailFilterUnread = em.emailFilterUnread;
  const emailFilterFlagged = em.emailFilterFlagged;
  const emailFlaggedSet = em.emailFlaggedSet;
  const emailCollapsedMsgs = em.emailCollapsedMsgs;
  const emailComposeOpen = em.emailComposeOpen;
  const emailDeleteConfirm = em.emailDeleteConfirm;
  const emailReplyText = em.emailReplyText;
  const emailSelectedId = em.emailSelectedId;
  const emailCtxMenu = em.emailCtxMenu;
  const emailAttachments = em.emailAttachments;
  const emailAttachmentsLoading = em.emailAttachmentsLoading;
  const setEmailAllMessages = (v: any) => { if (typeof v === "function") emSet("emailAllMessages" as any, v((em as any).emailAllMessages)); else emSet("emailAllMessages" as any, v); };
  const setEmailDeletedMessages = (v: any) => { if (typeof v === "function") emSet("emailDeletedMessages" as any, v((em as any).emailDeletedMessages)); else emSet("emailDeletedMessages" as any, v); };
  const setDtlEmails = (v: any) => { if (typeof v === "function") emSet("dtlEmails", v(em.dtlEmails)); else emSet("dtlEmails", v); };
  const setDtlEmailLoading = (v: any) => { if (typeof v === "function") emSet("dtlEmailLoading", v(em.dtlEmailLoading)); else emSet("dtlEmailLoading", v); };
  const setDtlEmailErr = (v: any) => { if (typeof v === "function") emSet("dtlEmailErr", v(em.dtlEmailErr)); else emSet("dtlEmailErr", v); };
  const setDtlEmailSel = (v: any) => emSet("dtlEmailSel", v);
  const setDtlEmailThread = (v: any) => emSet("dtlEmailThread", v);
  const setDtlThreadLoading = (v: boolean) => emSet("dtlThreadLoading", v);
  const setDtlEmailTab = (v: "inbox" | "sent" | "thread" | "compose" | "teams") => emSet("dtlEmailTab", v);
  const setDtlSentEmails = (v: any) => { if (typeof v === "function") emSet("dtlSentEmails", v(em.dtlSentEmails)); else emSet("dtlSentEmails", v); };
  const setDtlSentLoading = (v: any) => { if (typeof v === "function") emSet("dtlSentLoading", v(em.dtlSentLoading)); else emSet("dtlSentLoading", v); };
  const setDtlComposeTo = (v: string) => emSet("dtlComposeTo", v);
  const setDtlComposeSubject = (v: string) => emSet("dtlComposeSubject", v);
  const setDtlComposeBody = (v: string) => emSet("dtlComposeBody", v);
  const setDtlSendErr = (v: string | null) => emSet("dtlSendErr", v);
  const setDtlReply = (v: string) => emSet("dtlReply", v);
  const setDtlNextLink = (v: any) => { if (typeof v === "function") emSet("dtlNextLink", v(em.dtlNextLink)); else emSet("dtlNextLink", v); };
  const setDtlLoadingOlder = (v: boolean) => emSet("dtlLoadingOlder", v);
  const setEmailActiveFolder = (v: "inbox" | "sent") => emSet("emailActiveFolder", v);
  const setEmailSearchQuery = (v: string) => emSet("emailSearchQuery", v);
  const setEmailFilterUnread = (v: boolean) => emSet("emailFilterUnread", v);
  const setEmailFilterFlagged = (v: boolean) => emSet("emailFilterFlagged", v);
  const setEmailFlaggedSet = (v: any) => emSet("emailFlaggedSet", v);
  const setEmailCollapsedMsgs = (v: any) => emSet("emailCollapsedMsgs", v);
  const setEmailComposeOpen = (v: boolean) => emSet("emailComposeOpen", v);
  const setEmailDeleteConfirm = (v: string | null) => emSet("emailDeleteConfirm", v);
  const setEmailReplyText = (v: string) => emSet("emailReplyText", v);
  const setEmailSelectedId = (v: string | null) => emSet("emailSelectedId", v);
  const setEmailCtxMenu = (v: any) => emSet("emailCtxMenu", v);
  const setEmailAttachments = (v: any) => { if (typeof v === "function") emSet("emailAttachments", v(em.emailAttachments)); else emSet("emailAttachments", v); };
  const setEmailAttachmentsLoading = (v: any) => { if (typeof v === "function") emSet("emailAttachmentsLoading", v(em.emailAttachmentsLoading)); else emSet("emailAttachmentsLoading", v); };

  // ── Microsoft auth — shared token for Email + Teams ────────────────────
  function emailTokenIsValid() {
    return !!msToken;
  }
  function handleEmailTokenExpired() {
    clearMsTokens();
    setMsToken(null);
    setMsDisplayName("");
  }
  async function authenticateMS() {
    if (!MS_CLIENT_ID || !MS_TENANT_ID) return;
    setTeamsAuthStatus("loading");
    try {
      const tokens = await msSignIn();
      setMsToken(tokens.accessToken);
      setTeamsAuthStatus("idle");
      // Load display name
      try {
        const me = await fetch("https://graph.microsoft.com/v1.0/me?$select=displayName", { headers: { Authorization: "Bearer " + tokens.accessToken } });
        const meData = await me.json();
        if (meData.displayName) setMsDisplayName(meData.displayName);
      } catch(_) {}
    } catch(e) { console.error("MS auth failed:", e); setTeamsAuthStatus("error"); }
  }
  const authenticateEmail = authenticateMS;
  const authenticateTeams = authenticateMS;

  // ── On mount: restore token from localStorage ─────────────────────────
  useEffect(() => {
    (async () => {
      const tok = await getMsAccessToken();
      if (tok) {
        setMsToken(tok);
        try {
          const me = await fetch("https://graph.microsoft.com/v1.0/me?$select=displayName", { headers: { Authorization: "Bearer " + tok } });
          const meData = await me.json();
          if (meData.displayName) setMsDisplayName(meData.displayName);
        } catch(_) {}
      }
    })();
  }, []);

  // ── MS Graph helpers ─────────────────────────────────────────────────
  async function getGraphToken(): Promise<string> {
    // Try auto-refresh first, fall back to current state token
    const tok = await getMsAccessToken();
    if (tok) { if (tok !== msToken) setMsToken(tok); return tok; }
    if (msToken) return msToken;
    throw new Error("Not signed in to Microsoft");
  }
  async function teamsGraph(path: string, extraHeaders?: Record<string, string>) {
    const tok = await getGraphToken();
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json", ...extraHeaders } });
    if (r.status === 401) { handleEmailTokenExpired(); throw new Error("Session expired — please sign in again"); }
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  }
  async function teamsGraphPost(path: string, body: any) {
    const tok = await getGraphToken();
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 401) { handleEmailTokenExpired(); throw new Error("Session expired — please sign in again"); }
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  }
  function friendlyContactError(e: any): string {
    const msg: string = e?.message || "";
    if (msg.includes("403") || msg.toLowerCase().includes("insufficient")) return "Permission denied — sign out and sign back in";
    if (msg.includes("401") || msg.toLowerCase().includes("expired")) return "Session expired — sign out and sign back in";
    if (msg.includes("404")) return "Contacts not available on this account";
    return "Could not load contacts — sign out and sign back in";
  }

  async function loadTeamsContacts() {
    if (teamsContactsLoading) return;
    setTeamsContactsLoading(true);
    setTeamsContactsError(null);
    try {
      // Load Ring of Fire team members directly
      let tid = teamsTeamId;
      if (!tid) {
        const stored = await (async () => { try { const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.teams_team_id&select=value`, { headers: SB_HEADERS }); const rows = await res.json(); return rows?.length ? JSON.parse(rows[0].value) : null; } catch(_) { return null; } })();
        if (stored) { tid = stored; setTeamsTeamId(stored); } else throw new Error("No team ID — open a PO channel first");
      }
      const d = await teamsGraph(`/teams/${tid}/members?$top=999`);
      const members = (d.value || [])
        .filter((m: any) => m.displayName)
        .map((m: any) => ({
          displayName: m.displayName,
          userPrincipalName: m.email || "",
          scoredEmailAddresses: m.email ? [{ address: m.email }] : [],
        }))
        .sort((a: any, b: any) => a.displayName.localeCompare(b.displayName));
      setTeamsContacts(members);
    } catch(e: any) {
      console.warn("[Teams contacts] team members failed:", e?.message);
      try {
        const d2 = await teamsGraph("/me/people?$top=100&$select=displayName,userPrincipalName,scoredEmailAddresses,mail");
        setTeamsContacts(d2.value || []);
      } catch(e2: any) {
        setTeamsContactsError(friendlyContactError(e2 || e));
      }
    }
    setTeamsContactsLoading(false);
  }

  function searchTeamsContacts(q: string, target: "main" | "dtl") {
    if (!q.trim()) {
      if (target === "main") setTeamsContactSearchResults([]);
      else setDtlDMContactSearchResults([]);
      return;
    }
    const lower = q.toLowerCase();
    const results = teamsContacts.filter(c =>
      c.displayName?.toLowerCase().includes(lower) ||
      c.userPrincipalName?.toLowerCase().includes(lower) ||
      (c.scoredEmailAddresses?.[0]?.address || "").toLowerCase().includes(lower)
    ).slice(0, 25);
    if (target === "main") setTeamsContactSearchResults(results);
    else setDtlDMContactSearchResults(results);
  }

  function handleTeamsContactInput(val: string, target: "main" | "dtl") {
    if (target === "main") { setTeamsDirectTo(val); setTeamsContactSearch(val); setTeamsContactDropdown(true); setTeamsDirectErr(null); }
    else { setDtlDMTo(val); setDtlDMContactSearch(val); setDtlDMContactDropdown(true); }
    if (val.trim().length >= 2) {
      searchTeamsContacts(val.trim(), target);
    } else {
      if (target === "main") setTeamsContactSearchResults([]);
      else setDtlDMContactSearchResults([]);
    }
  }
  async function teamsLoadChannelMap() {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.po_teams_channel_map&select=value`, { headers: SB_HEADERS });
      const rows = await res.json();
      if (rows?.length) setTeamsChannelMap(JSON.parse(rows[0].value) || {});
      const res2 = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.teams_team_id&select=value`, { headers: SB_HEADERS });
      const rows2 = await res2.json();
      if (rows2?.length) setTeamsTeamId(JSON.parse(rows2[0].value) || "");
    } catch(e) { console.error("Teams: load channel map error", e); }
  }
  async function teamsSbSave(key: string, value: any) {
    await fetch(`${SB_URL}/rest/v1/app_data`, { method: "POST", headers: SB_HEADERS, body: JSON.stringify({ key, value: JSON.stringify(value) }) });
  }
  async function teamsFindRofTeam(): Promise<string> {
    if (teamsTeamId) return teamsTeamId;
    const data = await teamsGraph("/me/joinedTeams");
    const rofTeam = (data.value || []).find((t: any) => t.displayName?.toLowerCase().replace(/\s+/g, "").includes("ringoffire"));
    if (!rofTeam) throw new Error('Could not find "RING OF FIRE" team');
    await teamsSbSave("teams_team_id", rofTeam.id);
    setTeamsTeamId(rofTeam.id);
    return rofTeam.id as string;
  }
  async function teamsStartChat(poNum: string) {
    setTeamsCreating(poNum);
    try {
      const tid = await teamsFindRofTeam();
      const slug = poNum.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
      const chName = `po-${slug}`;
      let channelId = "";
      try {
        const channels = await teamsGraph(`/teams/${tid}/channels`);
        const existing = (channels.value || []).find((c: any) => c.displayName === chName);
        if (existing) channelId = existing.id;
      } catch(_) {}
      if (!channelId) {
        const ch = await teamsGraphPost(`/teams/${tid}/channels`, { displayName: chName, description: `PO WIP — PO# ${poNum}`, membershipType: "standard" });
        channelId = ch.id;
      }
      const newMap = { ...teamsChannelMap, [poNum]: { channelId, teamId: tid } };
      setTeamsChannelMap(newMap);
      await teamsSbSave("po_teams_channel_map", newMap);
      await teamsLoadPOMessages(poNum, { channelId, teamId: tid });
    } catch(e: any) { setToast("Could not start Teams chat: " + e.message); }
    setTeamsCreating(null);
  }
  async function teamsLoadPOMessages(poNum: string, mp?: { channelId: string; teamId: string }) {
    const mapping = mp || teamsChannelMap[poNum];
    if (!mapping || !teamsToken) return;
    setTeamsLoading(l => ({ ...l, [poNum]: true }));
    try {
      const d = await teamsGraph(`/teams/${mapping.teamId}/channels/${mapping.channelId}/messages?$top=50`);
      setTeamsMessages(m => ({ ...m, [poNum]: (d.value || []).filter((m: any) => m.messageType === "message") }));
    } catch(e) { console.error("Teams load msgs error", e); }
    setTeamsLoading(l => ({ ...l, [poNum]: false }));
  }
  async function teamsSendMessage(poNum: string) {
    const mp = teamsChannelMap[poNum];
    if (!mp || !teamsNewMsg.trim() || !teamsToken) return;
    try {
      const sent = await teamsGraphPost(`/teams/${mp.teamId}/channels/${mp.channelId}/messages`, { body: { content: teamsNewMsg.trim(), contentType: "text" } });
      setTeamsMessages(m => ({ ...m, [poNum]: [sent, ...(m[poNum] || [])] }));
      setTeamsNewMsg("");
    } catch(e: any) { setToast("Failed to send message: " + e.message); }
  }
  async function loadDmMessages(chatId: string, silent = false) {
    if (!silent) { setDmLoading(true); setDmError(null); }
    try {
      const d = await teamsGraph(`/chats/${chatId}/messages?$top=50`);
      const msgs = ((d.value || []) as any[]).filter((m: any) => m.messageType === "message").reverse();
      setDmConversations(prev => {
        const existing = prev.find(c => c.chatId === chatId);
        if (silent && existing && existing.messages.length === msgs.length &&
            existing.messages[existing.messages.length - 1]?.id === msgs[msgs.length - 1]?.id) return prev;
        if (!silent || (existing && existing.messages.length !== msgs.length)) {
          setTimeout(() => { if (dmScrollRef.current) dmScrollRef.current.scrollTop = dmScrollRef.current.scrollHeight; }, 50);
        }
        const found = prev.find(c => c.chatId === chatId);
        if (found) return prev.map(c => c.chatId === chatId ? { ...c, messages: msgs } : c);
        // Conversation was just created but not yet in state — add it
        return [...prev, { chatId, recipient: "", recipientName: "", messages: msgs }];
      });
    } catch(e: any) {
      if (!silent) setDmError("Could not load messages: " + e.message);
    }
    if (!silent) setDmLoading(false);
  }

  async function teamsSendDirect() {
    if (!teamsDirectTo.trim() || !teamsDirectMsg.trim()) return;
    setTeamsDirectSending(true);
    setTeamsDirectErr(null);
    try {
      const me = await teamsGraph("/me");
      const chat = await teamsGraphPost("/chats", {
        chatType: "oneOnOne",
        members: [
          { "@odata.type": "#microsoft.graph.aadUserConversationMember", roles: ["owner"], "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${me.id}')` },
          { "@odata.type": "#microsoft.graph.aadUserConversationMember", roles: ["owner"], "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${teamsDirectTo.trim()}')` },
        ],
      });
      await teamsGraphPost(`/chats/${chat.id}/messages`, { body: { content: teamsDirectMsg.trim(), contentType: "text" } });
      const recipientName = dmSelectedName || teamsDirectTo.trim();
      setDmConversations(prev => {
        const existing = prev.find(c => c.chatId === chat.id);
        if (existing) return prev.map(c => c.chatId === chat.id ? { ...c, recipientName } : c);
        return [...prev, { chatId: chat.id, recipient: teamsDirectTo.trim(), recipientName, messages: [] }];
      });
      setDmActiveChatId(chat.id);
      setDmComposing(false);
      setTeamsDirectMsg("");
      setTeamsDirectTo("");
      setDmSelectedName("");
      await loadDmMessages(chat.id);
    } catch(e: any) {
      setTeamsDirectErr("Failed to send: " + e.message);
    }
    setTeamsDirectSending(false);
  }

  async function sendDmReply() {
    if (!dmActiveChatId || !dmNewMsg.trim()) return;
    setDmSending(true);
    setDmError(null);
    try {
      const sent = await teamsGraphPost(`/chats/${dmActiveChatId}/messages`, { body: { content: dmNewMsg.trim(), contentType: "text" } });
      setDmConversations(prev => prev.map(c => c.chatId === dmActiveChatId ? { ...c, messages: [...c.messages, sent] } : c));
      setDmNewMsg("");
      setTimeout(() => { if (dmScrollRef.current) dmScrollRef.current.scrollTop = dmScrollRef.current.scrollHeight; }, 50);
    } catch(e: any) {
      setDmError("Failed to send: " + e.message);
    }
    setDmSending(false);
  }
  function msSignOut() {
    clearMsTokens();
    setMsToken(null);
    setMsDisplayName("");
    setTeamsAuthStatus("idle");
  }
  useEffect(() => { teamsLoadChannelMap(); }, []);
  useEffect(() => { if (teamsSelPO && teamsToken && teamsChannelMap[teamsSelPO]) teamsLoadPOMessages(teamsSelPO); }, [teamsSelPO, teamsToken]);
  useEffect(() => { if (teamsToken && teamsContacts.length === 0 && !teamsContactsLoading) loadTeamsContacts(); }, [teamsToken]);
  // Auto-poll active DM every 15s to pick up incoming replies
  useEffect(() => {
    if (dmPollRef.current) clearInterval(dmPollRef.current);
    if (!dmActiveChatId || !teamsToken) return;
    dmPollRef.current = setInterval(() => { loadDmMessages(dmActiveChatId, true); }, 15000);
    return () => { if (dmPollRef.current) clearInterval(dmPollRef.current); };
  }, [dmActiveChatId, teamsToken]);

  // Auto-select first PO (by unread count) when entering email view with no PO selected
  useEffect(() => {
    if (view === "email" && !emailSelPO && pos.length > 0 && msToken) {
      const sorted = [...pos].sort((a: any, b: any) => {
        const ua = (emailsMap[a.PoNumber ?? ""] || []).filter((e: any) => !e.isRead).length;
        const ub = (emailsMap[b.PoNumber ?? ""] || []).filter((e: any) => !e.isRead).length;
        return ub - ua;
      });
      const firstPO = (sorted[0]?.PoNumber ?? "") as string;
      if (firstPO) {
        setEmailSelPO(firstPO);
        setEmailSelectedId(null);
        setEmailSelMsg(null);
        setEmailThreadMsgs([]);
        setEmailActiveFolder("inbox");
        loadPOEmails(firstPO, undefined, true);
      }
    }
  }, [view, msToken]);
  // ── Thread collapse: collapse all but last when thread changes ────────────
  useEffect(() => {
    if (emailThreadMsgs.length > 1) setEmailCollapsedMsgs(new Set(emailThreadMsgs.slice(0, -1).map((m: any) => m.id)));
    else setEmailCollapsedMsgs(new Set());
  }, [emailThreadMsgs]);

  function teamsViewPanel() {
    return teamsViewPanelExtracted({
      tm, tmD, msToken, msDisplayName, pos, setView, dmScrollRef,
      teamsLoadPOMessages, teamsStartChat, teamsSendMessage, teamsSendDirect,
      sendDmReply, loadDmMessages, handleTeamsContactInput, loadTeamsContacts,
      authenticateTeams, msSignOut,
    });
  }

  async function emailGraph(path: string) {
    const tok = await getGraphToken();
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" } });
    if (r.status === 401) { handleEmailTokenExpired(); throw new Error("Session expired"); }
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  }
  async function emailGraphPost(path: string, body: any) {
    const tok = await getGraphToken();
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 401) { handleEmailTokenExpired(); throw new Error("Session expired"); }
    if (r.status === 202 || r.status === 200) return r.status === 202 ? {} : r.json();
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  }
  async function loadEmailAttachments(messageId: string, force = false) {
    if (!force && emailAttachments[messageId] !== undefined && emailAttachments[messageId].length > 0) return;
    setEmailAttachmentsLoading(a => ({ ...a, [messageId]: true }));
    try {
      const tok = await getGraphToken();
      // Expand fileAttachment so we get contentBytes inline; filter out inline images (cid:) since they're embedded in the body.
      const r = await fetch("https://graph.microsoft.com/v1.0/me/messages/" + messageId + "/attachments?$top=20", { headers: { Authorization: "Bearer " + tok } });
      if (!r.ok) {
        const txt = await r.text();
        console.warn(`loadEmailAttachments(${messageId}) failed:`, r.status, txt);
        setEmailAttachments(a => ({ ...a, [messageId]: [] }));
      } else {
        const d = await r.json();
        const all = (d.value || []) as any[];
        // Store ALL attachments (inline + file). Inline ones are used by the
        // renderer to swap cid: refs to data URLs; file ones show in the chip
        // list. UI filters at display time.
        setEmailAttachments(a => ({ ...a, [messageId]: all }));
      }
    } catch (e) {
      console.warn(`loadEmailAttachments(${messageId}) error:`, e);
      setEmailAttachments(a => ({ ...a, [messageId]: [] }));
    }
    setEmailAttachmentsLoading(a => ({ ...a, [messageId]: false }));
  }

  async function emailMarkAsRead(id: string) {
    try {
      const tok = await getGraphToken();
      await fetch("https://graph.microsoft.com/v1.0/me/messages/" + id, {
        method: "PATCH",
        headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
        body: JSON.stringify({ isRead: true }),
      });
    } catch {}
  }

  async function emailGraphDelete(path: string) {
    const tok = await getGraphToken();
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { method: "DELETE", headers: { Authorization: "Bearer " + tok } });
    if (r.status === 401) { handleEmailTokenExpired(); throw new Error("Session expired"); }
  }
  async function deleteMainEmail(messageId: string) {
    try {
      // Move to Deleted Items (trash) instead of permanently deleting.
      // Graph's POST /move with destinationId:"deleteditems" mirrors Outlook's behavior.
      await emailGraphPost("/me/messages/" + messageId + "/move", { destinationId: "deleteditems" });
      setEmailSelectedId(null);
      setEmailSelMsg(null);
      setEmailDeleteConfirm(null);
      setEmailThreadMsgs([]);
      const filterOut = (arr: any[]) => arr.filter((e: any) => e.id !== messageId);
      if (emailSelPO) {
        setEmailsMap(m => ({ ...m, [emailSelPO]: filterOut(m[emailSelPO] || []) }));
        setEmailSentMap(m => ({ ...m, [emailSelPO]: filterOut(m[emailSelPO] || []) }));
        setDtlEmails(m => ({ ...m, [emailSelPO]: filterOut(m[emailSelPO] || []) }));
        setDtlSentEmails(m => ({ ...m, [emailSelPO]: filterOut(m[emailSelPO] || []) }));
      }
      // Also remove from global caches — use functional updater pattern via
      // the SET action reading current state, not the stale em closure.
      setEmailAllMessages((arr: any[]) => (arr || []).filter((e: any) => e.id !== messageId));
    } catch(e) { console.error("Delete email error", e); }
  }

  // ── Detail panel email helpers ───────────────────────────────────────────
  async function loadDtlEmails(poNum: string, olderUrl?: string) {
    if (!emailToken) return;
    const prefix = "[PO-" + poNum + "]";
    if (olderUrl) { setDtlLoadingOlder(true); } else { setDtlEmailLoading(l => ({ ...l, [poNum]: true })); }
    setDtlEmailErr(e => ({ ...e, [poNum]: null }));
    try {
      const searchTerm = prefix.replace(/[\[\]{}()*?]/g, "").trim();
      const url = olderUrl || ("/me/mailFolders/Inbox/messages?$search=" + encodeURIComponent('"' + searchTerm + '"') + "&$top=25&$select=id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead,hasAttachments");
      const d = await emailGraph(url);
      const items = d.value || [];
      if (olderUrl) {
        setDtlEmails(m => ({ ...m, [poNum]: [...(m[poNum] || []), ...items] }));
        setEmailsMap(m => ({ ...m, [poNum]: [...(m[poNum] || []), ...items] }));
      } else {
        setDtlEmails(m => ({ ...m, [poNum]: items }));
        setEmailsMap(m => ({ ...m, [poNum]: items }));
      }
      const nextLink = d["@odata.nextLink"] ? d["@odata.nextLink"].replace("https://graph.microsoft.com/v1.0", "") : null;
      setDtlNextLink(nl => ({ ...nl, [poNum]: nextLink }));
      setEmailNextLinks(nl => ({ ...nl, [poNum]: nextLink }));
      setEmailLastRefresh(lr => ({ ...lr, [poNum]: Date.now() }));
    } catch (e: any) { setDtlEmailErr(err => ({ ...err, [poNum]: e.message })); }
    setDtlEmailLoading(l => ({ ...l, [poNum]: false }));
    setDtlLoadingOlder(false);
  }
  async function loadDtlSentEmails(poNum: string) {
    if (!emailToken) return;
    const prefix = "[PO-" + poNum + "]";
    setDtlSentLoading(l => ({ ...l, [poNum]: true }));
    try {
      const searchTerm = prefix.replace(/[\[\]{}()*?]/g, "").trim();
      const d = await emailGraph("/me/mailFolders/SentItems/messages?$search=" + encodeURIComponent('"' + searchTerm + '"') + "&$top=25&$select=id,subject,from,toRecipients,sentDateTime,bodyPreview,conversationId,hasAttachments");
      setDtlSentEmails(m => ({ ...m, [poNum]: d.value || [] }));
      setEmailSentMap(m => ({ ...m, [poNum]: d.value || [] }));
    } catch (e) { console.error(e); }
    setDtlSentLoading(l => ({ ...l, [poNum]: false }));
  }

  async function loadDtlFullEmail(id: string) {
    try { const d = await emailGraph("/me/messages/" + id); setDtlEmailSel(d); } catch (e) { console.error(e); }
  }
  async function loadDtlThread(conversationId: string) {
    setDtlThreadLoading(true);
    try {
      const d = await emailGraph("/me/messages?$filter=" + encodeURIComponent("conversationId eq '" + conversationId + "'") + "&$orderby=receivedDateTime%20asc&$select=id,subject,from,receivedDateTime,body,conversationId,isRead,hasAttachments");
      setDtlEmailThread(d.value || []);
    } catch (e) { setDtlEmailThread([]); }
    setDtlThreadLoading(false);
    setDtlEmailTab("thread");
  }
  async function dtlSendEmail(poNum: string) {
    if (!dtlComposeTo.trim() || !dtlComposeSubject.trim()) return;
    setDtlSendErr(null);
    try {
      await emailGraphPost("/me/sendMail", {
        message: { subject: dtlComposeSubject, body: { contentType: "HTML", content: buildEmailHtml(dtlComposeBody) }, toRecipients: dtlComposeTo.split(",").map(e => ({ emailAddress: { address: e.trim() } })) },
      });
      setDtlComposeTo(""); setDtlComposeSubject(""); setDtlComposeBody("");
      setDtlEmailTab("inbox");
      setTimeout(() => { loadDtlEmails(poNum); loadPOEmails(poNum); }, 2000);
    } catch (e: any) { setDtlSendErr("Failed to send: " + e.message); }
  }
  async function dtlReplyToEmail(messageId: string) {
    if (!dtlReply.trim()) return;
    setDtlSendErr(null);
    try {
      await emailGraphPost("/me/messages/" + messageId + "/reply", { comment: dtlReply });
      setDtlReply("");
      if (dtlEmailSel?.conversationId) loadDtlThread(dtlEmailSel.conversationId);
    } catch (e: any) { setDtlSendErr("Failed to reply: " + e.message); }
  }

  // ── PLM session auto-login ────────────────────────────────────────────────
  const [sessionChecked, setSessionChecked] = useState(false);
  const realtimeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastDataHashRef = useRef<string>("");

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem("plm_user");
      if (saved) setUser(JSON.parse(saved));
    } catch {}
    setSessionChecked(true);
  }, []);

  // Load XLSX library dynamically
  useEffect(() => {
    if ((window as any).XLSX) return;
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.min.js";
    document.head.appendChild(s);
  }, []);

  // ── Auth ──────────────────────────────────────────────────────────────────
  const [loginName, setLoginName] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginErr, setLoginErr]   = useState("");

  async function handleLogin() {
    setLoginErr("");
    try {
      // Load users from app_data (same as Design Calendar)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.users&select=value`, { headers: SB_HEADERS, signal: controller.signal });
      clearTimeout(timeout);
      const rows = await res.json();
      let allUsers: User[] = [];
      if (Array.isArray(rows) && rows.length > 0 && rows[0].value) {
        try { allUsers = JSON.parse(rows[0].value); } catch {}
      }
      if (!allUsers || allUsers.length === 0) {
        setLoginErr("No users found. Please ask your admin to set up users in the Design Calendar.");
        return;
      }
      const match = allUsers.find(
        (u: User) => (u as any).username?.toLowerCase() === loginName.trim().toLowerCase() &&
          (u.password === loginPass || (u as any).pin === loginPass)
      );
      if (match) {
        sessionStorage.setItem("plm_user", JSON.stringify(match));
        setUser(match);
      } else setLoginErr("Invalid username or password.");
    } catch {
      setLoginErr("Could not connect to database. Please try again.");
    }
  }

  // ── Load notes from Supabase ──────────────────────────────────────────────
  const loadNotes = useCallback(async () => {
    const { data } = await sb.from("tanda_notes").select("*", "order=created_at.desc");
    setNotes((data as LocalNote[]) ?? []);
  }, []);

  // ── Load cached POs from Supabase ─────────────────────────────────────────
  const loadCachedPOs = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await sb.from("tanda_pos").select("*", "order=date_order.desc");
      if (error) {
        const msg = (error as any)?.message || JSON.stringify(error);
        console.warn("loadCachedPOs failed:", msg);
        setSyncErr(`Failed to load POs: ${msg}`);
        return;
      }
      if (Array.isArray(data) && data.length > 0) {
        // Exclude archived POs from active list
        const active = data.filter((r: any) => !(r.data as XoroPO)?._archived);
        setPos(active.map((r: any) => r.data as XoroPO));
        setLastSync(data[0]?.synced_at ?? "");
      } else {
        setPos([]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Load vendors from Xoro + manual list ─────────────────────────────────
  const loadVendors = useCallback(async () => {
    setLoadingVendors(true);
    const xv = await fetchXoroVendors();
    setXoroVendors(xv);
    // load manual vendors from supabase
    const { data } = await sb.from("tanda_settings").single("value", "key=eq.manual_vendors");
    if (data?.value) setManualVendors(JSON.parse(data.value));
    setLoadingVendors(false);
  }, []);

  async function saveManualVendor() {
    if (!newManualVendor.trim()) return;
    const updated = [...manualVendors, newManualVendor.trim()];
    setManualVendors(updated);
    setNewManualVendor("");
    await sb.from("tanda_settings").upsert({ key: "manual_vendors", value: JSON.stringify(updated) }, { onConflict: "key" });
  }

  async function removeManualVendor(v: string) {
    const updated = manualVendors.filter(x => x !== v);
    setManualVendors(updated);
    await sb.from("tanda_settings").upsert({ key: "manual_vendors", value: JSON.stringify(updated) }, { onConflict: "key" });
  }

  // ── WIP Template data layer ─────────────────────────────────────────────
  // Shape: { "__default__": WipTemplate[], "VENDOR A": WipTemplate[], ... }
  async function loadWipTemplates() {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.wip_templates&select=value`, { headers: SB_HEADERS });
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0 && rows[0].value) {
        const parsed = JSON.parse(rows[0].value);
        // Migrate: if old format was an array, convert to { __default__: [...] }
        if (Array.isArray(parsed)) {
          const migrated = { __default__: parsed };
          setWipTemplates(migrated);
          // Save migrated format back
          await _saveWipTemplatesRaw(migrated);
          return migrated;
        }
        if (parsed && typeof parsed === "object") {
          // Ensure __default__ exists
          if (!parsed.__default__) parsed.__default__ = DEFAULT_WIP_TEMPLATES;
          // Migrate: move "Top Sample" from Transit → Samples (last in Samples) in every vendor template
          let migrationNeeded = false;
          for (const key of Object.keys(parsed)) {
            const tpls: WipTemplate[] = parsed[key];
            const idx = tpls.findIndex(t => (t.id === "wip_topsample" || t.phase === "Top Sample") && t.category === "Transit");
            if (idx === -1) continue;
            migrationNeeded = true;
            const arr = [...tpls];
            const [ts] = arr.splice(idx, 1);
            const updated = { ...ts, category: "Samples" };
            const lastSamples = arr.reduce((last, t, i) => t.category === "Samples" ? i : last, -1);
            arr.splice(lastSamples + 1, 0, updated);
            parsed[key] = arr;
          }
          if (migrationNeeded) await _saveWipTemplatesRaw(parsed);
          setWipTemplates(parsed);
          return parsed;
        }
      }
    } catch {}
    const defaults = { __default__: DEFAULT_WIP_TEMPLATES };
    setWipTemplates(defaults);
    return defaults;
  }

  async function _saveWipTemplatesRaw(all: Record<string, WipTemplate[]>) {
    await fetch(`${SB_URL}/rest/v1/app_data`, {
      method: "POST",
      headers: { ...SB_HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ key: "wip_templates", value: JSON.stringify(all) }),
    });
  }

  async function saveVendorTemplates(vendorKey: string, templates: WipTemplate[]) {
    const updated = { ...wipTemplates, [vendorKey]: templates };
    setWipTemplates(updated);
    await _saveWipTemplatesRaw(updated);
  }

  async function deleteVendorTemplate(vendorKey: string) {
    const updated = { ...wipTemplates };
    delete updated[vendorKey];
    setWipTemplates(updated);
    await _saveWipTemplatesRaw(updated);
  }

  function getVendorTemplates(vendorName?: string): WipTemplate[] {
    if (vendorName && wipTemplates[vendorName]) return wipTemplates[vendorName];
    return wipTemplates.__default__ || DEFAULT_WIP_TEMPLATES;
  }

  function vendorHasTemplate(vendorName: string): boolean {
    return !!(vendorName && wipTemplates[vendorName]);
  }

  function templateVendorList(): string[] {
    return Object.keys(wipTemplates).filter(k => k !== "__default__").sort();
  }

  async function loadDesignTemplates() {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.task_templates&select=value`, { headers: SB_HEADERS });
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0 && rows[0].value) {
        const parsed = JSON.parse(rows[0].value);
        if (Array.isArray(parsed)) setDesignTemplates(parsed);
      }
    } catch {}
  }

  async function loadDCVendors() {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.vendors&select=value`, { headers: SB_HEADERS });
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0 && rows[0].value) {
        const parsed = JSON.parse(rows[0].value);
        if (Array.isArray(parsed)) setDcVendors(parsed);
      }
    } catch {}
  }

  // Sync vendor names from PO WIP into Design Calendar's vendor list.
  // replace=true: set DC vendors = vendorNames (preserve existing settings where names match, drop the rest)
  // replace=false: add-only — append any names not already in DC
  async function syncVendorsToDC(replace: boolean, vendorNames: string[]) {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.vendors&select=value`, { headers: SB_HEADERS });
      const rows = await res.json();
      const existing: any[] = (Array.isArray(rows) && rows.length > 0 && rows[0].value)
        ? (JSON.parse(rows[0].value) || []) : [];

      const mkVendor = (name: string) => ({
        id: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
        name,
        country: "",
        transitDays: 21,
        categories: [],
        contact: "",
        email: "",
        moq: 0,
        leadOverrides: {},
        wipLeadOverrides: {},
      });

      let updated: any[];
      if (replace) {
        // Build from vendorNames, preserving existing entries where names match
        updated = vendorNames.map(name => existing.find(v => v.name === name) || mkVendor(name));
      } else {
        const existingNames = new Set(existing.map((v: any) => v.name));
        const toAdd = vendorNames.filter(name => !existingNames.has(name));
        if (toAdd.length === 0) return;
        updated = [...existing, ...toAdd.map(mkVendor)];
      }

      await fetch(`${SB_URL}/rest/v1/app_data`, {
        method: "POST",
        headers: { ...SB_HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "vendors", value: JSON.stringify(updated) }),
      });
      setDcVendors(updated);
    } catch (e) {
      console.error("Failed to sync vendors to DC:", e);
    }
  }

  // ── Milestone data layer (table schema: id TEXT PK, data JSONB) ───────
  async function loadAllMilestones() {
    try {
      const { data } = await sb.from("tanda_milestones").select("id,data");
      if (data && Array.isArray(data)) {
        const grouped: Record<string, Milestone[]> = {};
        data.forEach((row: any) => {
          const m = row.data as Milestone;
          if (!m || !m.po_number) return;
          if (!grouped[m.po_number]) grouped[m.po_number] = [];
          grouped[m.po_number].push(m);
        });
        // Sort each group by sort_order
        Object.values(grouped).forEach(arr => arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)));
        setMilestones(grouped);
      }
    } catch (e) { console.error("[MS] loadAll error:", e); }
  }

  async function loadMilestones(poNumber: string): Promise<Milestone[]> {
    try {
      const { data } = await sb.from("tanda_milestones").select("id,data");
      if (!data) return [];
      return (data as any[])
        .map(row => row.data as Milestone)
        .filter(m => m.po_number === poNumber)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    } catch { return []; }
  }

  async function saveMilestone(m: Milestone, skipHistory = false) {
    // Ensure updated_at is always set
    if (!m.updated_at || m.updated_at === (milestones[m.po_number] || []).find(x => x.id === m.id)?.updated_at) {
      m = { ...m, updated_at: new Date().toISOString(), updated_by: m.updated_by || user?.name || "" };
    }
    const existing = (milestones[m.po_number] || []).find(x => x.id === m.id);
    // When status changes, store date per status in status_dates map
    if (existing && existing.status !== m.status) {
      const today = new Date().toISOString().split("T")[0];
      const dates = { ...(m.status_dates || existing.status_dates || {}) };
      // Record today for the new status (if it doesn't already have a date)
      if (!dates[m.status]) dates[m.status] = today;
      m.status_dates = dates;
      // Set status_date to the date for the current status
      m.status_date = dates[m.status] || today;
    }
    // Track changes for history
    if (!skipHistory && existing) {
      const changes: string[] = [];
      if (existing.status !== m.status) changes.push(`Status: ${existing.status} → ${m.status} (${m.status_date || "today"})`);
      if (existing.status !== m.status && existing.status_date !== m.status_date) {} // already logged above
      else if (existing.status_date !== m.status_date) changes.push(`Status Date: ${existing.status_date || "—"} → ${m.status_date || "—"}`);
      if (existing.notes !== m.notes) changes.push(`Notes updated`);
      if (changes.length > 0) {
        addHistory(m.po_number, `${m.phase}: ${changes.join(", ")}`);
      }
    }
    // Conflict detection: check if another user modified this milestone since we loaded it.
    // If a conflict modal is already pending for this milestone, skip — the previous
    // save is waiting on user input and we don't want to stack multiple modals.
    if (conflictPendingRef.current.has(m.id)) return;
    if (existing) {
      const { data: currentRow } = await sb.from("tanda_milestones").single("id,data", `id=eq.${encodeURIComponent(m.id)}`);
      const serverData = (currentRow as any)?.data as Milestone | undefined;
      if (serverData && serverData.updated_at && serverData.updated_at !== existing.updated_at && serverData.updated_by !== (user?.name || "")) {
        // Conflict detected — let user decide (skip if we're the one who made the change)
        conflictPendingRef.current.add(m.id);
        setConfirmModal({
          title: "Conflict Detected",
          message: `"${m.phase}" was modified by ${serverData.updated_by || "another user"}.\n\nTheir status: ${serverData.status} · Your status: ${m.status}\n\nOverwrite with your changes?`,
          icon: "⚠️",
          confirmText: "Use Mine",
          cancelText: "Keep Theirs",
          confirmColor: "#3B82F6",
          onConfirm: async () => {
            try {
              await sb.from("tanda_milestones").upsert({ id: m.id, data: m }, { onConflict: "id" });
              coreD({ type: "UPDATE_MILESTONE", poNumber: m.po_number, milestoneId: m.id, milestone: m });
            } finally {
              conflictPendingRef.current.delete(m.id);
            }
          },
          onCancel: async () => {
            try { await loadAllMilestones(); }
            finally { conflictPendingRef.current.delete(m.id); }
          },
        });
        return; // Don't save yet — modal callbacks handle it
      }
    }
    await sb.from("tanda_milestones").upsert({ id: m.id, data: m }, { onConflict: "id" });
    coreD({ type: "UPDATE_MILESTONE", poNumber: m.po_number, milestoneId: m.id, milestone: m });
    // Clear collapsed overrides for this PO so auto-collapse/expand recalculates
    if (!skipHistory) {
      // Check if this milestone completing finishes its entire category
      const updatedMs = [...(milestones[m.po_number] || [])];
      const idx2 = updatedMs.findIndex(x => x.id === m.id);
      if (idx2 >= 0) updatedMs[idx2] = m;
      const catMs = updatedMs.filter(x => x.category === m.category);
      const catJustCompleted = m.status === "Complete" && catMs.every(x => x.status === "Complete" || x.status === "N/A");

      if (catJustCompleted) {
        // Keep the completed category open immediately (override auto-collapse)
        const completedKey = m.category + m.po_number;
        setCollapsedCats(prev => {
          const next = { ...prev };
          // Clear other categories so they recalculate
          WIP_CATEGORIES.forEach(cat => {
            const key = cat + m.po_number;
            if (key === completedKey) { next[key] = false; } // force open
            else if (!acceptedBlocked.has(key)) { delete next[key]; }
          });
          return next;
        });
        // After 4 seconds, release the override so it collapses naturally
        setTimeout(() => {
          setCollapsedCats(prev => {
            const next = { ...prev };
            delete next[completedKey];
            return next;
          });
        }, 2000);
      } else {
        setCollapsedCats(prev => {
          const next = { ...prev };
          WIP_CATEGORIES.forEach(cat => {
            const key = cat + m.po_number;
            if (!acceptedBlocked.has(key)) delete next[key];
          });
          return next;
        });
      }
    }
  }

  async function saveMilestones(ms: Milestone[]) {
    if (!ms.length) return;
    await sb.from("tanda_milestones").upsert(
      ms.map(m => ({ id: m.id, data: m })),
      { onConflict: "id" }
    );
    ms.forEach(m => coreD({ type: "UPDATE_MILESTONE", poNumber: m.po_number, milestoneId: m.id, milestone: m }));
  }

  async function deleteMilestonesForPO(poNumber: string) {
    // Load all milestone IDs for this PO, then delete them
    const existing = milestones[poNumber] || [];
    for (const m of existing) {
      await sb.from("tanda_milestones").delete(`id=eq.${encodeURIComponent(m.id)}`);
    }
    coreD({ type: "DELETE_MILESTONES_FOR_PO", poNumber });
  }

  function generateMilestones(poNumber: string, ddpDate: string, vendorName?: string): Milestone[] {
    return _generateMilestones(poNumber, ddpDate, getVendorTemplates(vendorName), user?.name || "");
  }

  async function ensureMilestones(po: XoroPO): Promise<Milestone[] | "needs_template"> {
    const poNum = po.PoNumber ?? "";
    if (!poNum) return [];
    // Prevent concurrent generation for the same PO
    if (generatingRef.current.has(poNum)) return [];
    // Check state first
    const existing = milestones[poNum];
    if (existing && existing.length > 0) return existing;
    generatingRef.current.add(poNum);
    try {
      // Double-check DB to prevent duplicates
      const dbExisting = await loadMilestones(poNum);
      if (dbExisting.length > 0) {
        coreD({ type: "SET_MILESTONES_FOR_PO", poNumber: poNum, milestones: dbExisting });
        return dbExisting;
      }
      const ddp = po.DateExpectedDelivery;
      if (!ddp) return [];
      const vendor = po.VendorName ?? "";
      if (vendor && !vendorHasTemplate(vendor)) {
        return "needs_template";
      }
      const ms = generateMilestones(poNum, ddp, vendor);
      if (ms.length > 0) {
        await saveMilestones(ms);
        addHistory(poNum, `Milestones generated (${ms.length} phases) using ${vendor || "default"} template`);
      }
      return ms;
    } finally {
      generatingRef.current.delete(poNum);
    }
  }

  async function regenerateMilestones(po: XoroPO) {
    const poNum = po.PoNumber ?? "";
    const ddp = po.DateExpectedDelivery;
    if (!poNum || !ddp) return;
    // Guard against detailPanel's lazy-generate race: it triggers ensureMilestones
    // whenever milestones[poNum] is empty during render. Holding generatingRef blocks it.
    if (generatingRef.current.has(poNum)) return;
    generatingRef.current.add(poNum);
    try {
      const existing = milestones[poNum] || [];
      const fresh = generateMilestones(poNum, ddp, po.VendorName);
      const merged = mergeMilestones(existing, fresh);
      // 1. Upsert merged FIRST so the PO is never in a zero-milestones state.
      //    If we crash or disconnect after this, the PO still has a valid set
      //    (the new merged set) — only orphaned old rows would remain, which
      //    the next regenerate or load can clean up.
      if (merged.length > 0) {
        const { error: upErr } = await sb.from("tanda_milestones").upsert(
          merged.map(m => ({ id: m.id, data: m })),
          { onConflict: "id" }
        );
        if (upErr) {
          throw new Error(`Failed to write merged milestones: ${(upErr as any)?.message || JSON.stringify(upErr)}`);
        }
      }
      // 2. Delete only the old rows whose ids are not in the merged set.
      //    Preserved-progress milestones keep their old ids (mergeMilestones
      //    sets id: old.id), so they won't be deleted here.
      const mergedIds = new Set(merged.map(m => m.id));
      const stragglers = existing.filter(m => !mergedIds.has(m.id));
      for (const m of stragglers) {
        await sb.from("tanda_milestones").delete(`id=eq.${encodeURIComponent(m.id)}`);
      }
      // 3. Atomically replace in state — never leave milestones[poNum] empty
      coreD({ type: "SET_MILESTONES_FOR_PO", poNumber: poNum, milestones: merged });
      addHistory(poNum, `Milestones regenerated (${merged.length} phases)`);
    } finally {
      generatingRef.current.delete(poNum);
    }
  }

  // ── Cancel sync ─────────────────────────────────────────────────────────
  function cancelSync() {
    syncAbortRef.current?.abort();
    syncAbortRef.current = null;
    setSyncing(false);
    setSyncErr("Sync cancelled.");
  }

  // ── Sync log helpers ─────────────────────────────────────────────────────
  async function loadSyncLog() {
    try {
      const res = await sb.from("app_data").single("value", "key=eq.tanda_sync_log");
      if (res.data?.value) setSyncLog(JSON.parse(res.data.value) || []);
    } catch(_) {}
  }

  async function appendSyncLog(entry: SyncLogEntry) {
    const next = [entry, ...syncLog].slice(0, 10); // keep last 10 sync events
    setSyncLog(next);
    try {
      await fetch(`${SB_URL}/rest/v1/app_data`, {
        method: "POST",
        headers: { ...SB_HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "tanda_sync_log", value: JSON.stringify(next) }),
      });
    } catch(_) {}
  }

  // ── Sync from Xoro with filters ───────────────────────────────────────────
  async function syncFromXoro(filters?: SyncFilters) {
    // Abort any previous sync
    syncAbortRef.current?.abort();
    const controller = new AbortController();
    syncAbortRef.current = controller;

    // Capture applied filters before resetting state
    const appliedFilters = filters && (
      (filters.vendors?.length ?? 0) > 0 ||
      (filters.statuses?.length ?? 0) > 0 ||
      (filters.poNumbers?.length ?? 0) > 0 ||
      filters.dateFrom || filters.dateTo
    ) ? {
      vendors: filters.vendors?.length ? filters.vendors : undefined,
      statuses: filters.statuses?.length ? filters.statuses : undefined,
      poNumbers: filters.poNumbers?.length ? filters.poNumbers : undefined,
      dateFrom: filters.dateFrom || undefined,
      dateTo: filters.dateTo || undefined,
    } : undefined;

    setSyncing(true);
    setSyncErr("");
    setSyncDone(null);
    setSyncProgress(0);
    setSyncProgressMsg("Connecting to Xoro…");
    setShowSyncModal(false);
    setSyncFilters({ poNumbers: [], dateFrom: "", dateTo: "", vendors: [], statuses: [] });
    try {
      let all: XoroPO[] = [];
      // Fetch ALL statuses so that:
      // • Terminal-status POs (Received/Closed/Cancelled) are caught by source-1 archiving with correct labels
      // • POs absent from every status bucket are truly deleted from Xoro → source-3 archiving
      const statusList = filters?.statuses?.length ? filters.statuses : ALL_PO_STATUSES;
      // Pass first PO number to API if only one selected; multi is filtered client-side
      const apiPoNumber = filters?.poNumbers?.length === 1 ? filters.poNumbers[0] : undefined;

      setSyncProgressMsg("Fetching POs from Xoro…");
      setSyncProgress(10);

      // Each status fetched in parallel — proxy handles pagination server-side per call.
      // DB check runs concurrently too.
      const fetchOpts = { fetchAll: true, signal: controller.signal, vendors: filters?.vendors, poNumber: apiPoNumber, dateFrom: filters?.dateFrom, dateTo: filters?.dateTo };
      const [statusResults, existingRowsRes] = await Promise.all([
        Promise.allSettled(
          statusList.map(status => fetchXoroPOs({ ...fetchOpts, statuses: [status] }))
        ),
        sb.from("tanda_pos").select("po_number,data"),
      ]);

      // Track which statuses returned ≥1 result — used to guard against silent empty responses
      const statusesWithResults = new Set<string>();
      let firstError: string | null = null;
      for (let i = 0; i < statusResults.length; i++) {
        const result = statusResults[i];
        if (result.status === "fulfilled") {
          const pos = Array.isArray(result.value?.pos) ? result.value.pos : [];
          all = [...all, ...pos];
          if (pos.length > 0) statusesWithResults.add(statusList[i]);
        } else {
          const msg = (result as PromiseRejectedResult).reason?.message;
          console.warn("Sync warning:", msg);
          if (!firstError) firstError = msg ?? "Unknown error";
        }
      }

      // Only fail if every status fetch failed — a successful fetch with 0 results is valid
      const successCount = statusResults.filter(r => r.status === "fulfilled").length;
      if (successCount === 0 && firstError) {
        throw new Error(`Xoro sync failed: ${firstError}`);
      }

      // Client-side fallback filter
      all = applyFilters(all, filters);

      setSyncProgress(78);

      const { data: existingRows } = existingRowsRes;
      const existingMap = new Map<string, XoroPO>(
        (existingRows ?? []).map((r: any) => [r.po_number as string, r.data as XoroPO])
      );

      // Only fully Closed/Received/Cancelled — "Partially Received" stays active
      const autoDeleteStatuses = ["Closed", "Received", "Cancelled"];
      // Never delete partially received POs
      const toKeep = (s: string) => (s || "").toLowerCase().includes("partial");
      const synced = all.filter(po => !autoDeleteStatuses.includes(po.StatusName ?? "") || toKeep(po.StatusName ?? ""));

      const addedPOs = synced.filter(po => !existingMap.has(po.PoNumber ?? ""));
      // Always update ALL existing POs to ensure QtyReceived/QtyRemaining data is fresh
      const changedPOs = synced.filter(po => existingMap.has(po.PoNumber ?? ""));
      const addedCount   = addedPOs.length;
      const changedCount = changedPOs.length;
      const toUpsert     = [...addedPOs, ...changedPOs];

      setSyncProgress(85);
      setSyncProgressMsg(
        toUpsert.length > 0
          ? `Saving ${toUpsert.length} new/changed PO${toUpsert.length !== 1 ? "s" : ""} to database…`
          : "No changes detected, skipping database write…"
      );

      const now = new Date().toISOString();
      if (toUpsert.length > 0) {
        const { error: upsertError } = await sb.from("tanda_pos").upsert(
          toUpsert.map(po => ({
            po_number:     po.PoNumber ?? `unknown-${Math.random()}`,
            vendor:        po.VendorName ?? "",
            date_order:    po.DateOrder ?? null,
            date_expected: po.DateExpectedDelivery ?? null,
            status:        po.StatusName ?? "",
            data:          po,
            synced_at:     now,
          })),
          { onConflict: "po_number" }
        );
        if (upsertError) {
          const msg = (upsertError as any)?.message || (upsertError as any)?.hint || JSON.stringify(upsertError);
          throw new Error(`Failed to save POs to database: ${msg}`);
        }
      }

      setSyncProgress(88);
      setSyncProgressMsg("Archiving closed/received/deleted POs…");

      const cachedRows = (existingRows ?? []).map((r: any) => ({ po_number: r.po_number as string, data: r.data as XoroPO }));

      // Only check for missing POs on a full unfiltered sync where all fetches succeeded
      const allStatusesSucceeded = statusResults.every(r => r.status === "fulfilled");
      const isFullSync = allStatusesSucceeded && !filters?.poNumbers?.length && !filters?.vendors?.length && !filters?.dateFrom && !filters?.dateTo && !filters?.statuses?.length;

      const archiveDecisions = getArchiveDecisions(all, cachedRows, isFullSync ? statusesWithResults : null);
      const archiveFailures: Array<{ poNumber: string; error: string }> = [];
      for (const { poNumber, freshData } of archiveDecisions) {
        try {
          if (freshData) {
            // Source 1: Xoro returned the PO as terminal — archive with fresh data so
            // the status label is correct (e.g. "Received" not the stale "Released").
            const archivedData = { ...freshData, _archived: true, _archivedAt: now };
            const { error: archErr } = await sb.from("tanda_pos").upsert({ po_number: poNumber, vendor: freshData.VendorName ?? "", status: freshData.StatusName ?? "", data: archivedData, synced_at: now }, { onConflict: "po_number" });
            if (archErr) {
              const msg = (archErr as any)?.message || JSON.stringify(archErr);
              throw new Error(msg);
            }
            coreD({ type: "REMOVE_PO", poNumber });
            if (selected?.PoNumber === poNumber) setSelected(null);
          } else {
            // Source 2/3: PO has a terminal status in the DB, or is absent from ALL
            // Xoro status buckets (deleted). Archive using existing DB data.
            await archivePO(poNumber);
          }
        } catch (err: any) {
          const msg = err?.message || String(err);
          console.warn(`Archive failed for ${poNumber}:`, msg);
          archiveFailures.push({ poNumber, error: msg });
        }
      }
      const deletedCount = archiveDecisions.length - archiveFailures.length;
      if (archiveFailures.length > 0) {
        const sample = archiveFailures.slice(0, 3).map(f => f.poNumber).join(", ");
        const more = archiveFailures.length > 3 ? ` +${archiveFailures.length - 3} more` : "";
        setSyncErr(`Sync completed but ${archiveFailures.length} PO${archiveFailures.length === 1 ? "" : "s"} failed to archive (${sample}${more}). Check console for details.`);
      }

      setSyncProgress(95);
      setSyncProgressMsg("Reloading PO cache…");
      await loadCachedPOs();

      // Auto-add any new vendor names from this sync into Design Calendar
      const syncedVendorNames = Array.from(new Set(synced.map(po => po.VendorName ?? "").filter(Boolean))) as string[];
      if (syncedVendorNames.length > 0) {
        setSyncProgressMsg("Syncing new vendors to Design Calendar…");
        await syncVendorsToDC(false, syncedVendorNames);
      }

      setLastSync(now);
      setSyncProgress(100);

      for (const po of synced.slice(0, 5)) {
        addHistory(po.PoNumber ?? "", `PO synced from Xoro (${synced.length} POs in batch${deletedCount > 0 ? `, ${deletedCount} removed` : ""})`);
      }
      if (synced.length > 5) addHistory(synced[0]?.PoNumber ?? "", `... and ${synced.length - 5} more POs synced`);

      setSyncDone({ added: addedCount, changed: changedCount, deleted: deletedCount });
      await appendSyncLog({ ts: new Date().toISOString(), user: user?.name || "Unknown", success: true, added: addedCount, changed: changedCount, deleted: deletedCount, filters: appliedFilters });
    } catch (e: any) {
      const errMsg = e.name === "AbortError" ? "Sync timed out or was cancelled" : (e.message ?? "Sync failed");
      if (e.name === "AbortError") setSyncErr("Sync timed out or was cancelled. Check your Xoro API credentials and try again.");
      else setSyncErr(e.message ?? "Sync failed");
      await appendSyncLog({ ts: new Date().toISOString(), user: user?.name || "Unknown", success: false, added: 0, changed: 0, deleted: 0, error: errMsg, filters: appliedFilters });
    } finally {
      syncAbortRef.current = null;
      setSyncing(false);
      setSyncProgress(0);
      setSyncProgressMsg("");
    }
  }

  useEffect(() => {
    if (user) { loadCachedPOs(); loadNotes(); loadVendors(); loadWipTemplates(); loadAllMilestones(); loadDCVendors(); loadDesignTemplates(); loadSyncLog(); }
  }, [user, loadCachedPOs, loadNotes, loadVendors]);

  // ── Deep-link from ATS: ?po=NUMBER opens that PO directly to milestones tab ──
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current || pos.length === 0) return;
    const param = new URLSearchParams(window.location.search).get("po");
    if (!param) return;
    const target = pos.find(p => (p.PoNumber ?? "").toLowerCase() === param.toLowerCase());
    if (target) {
      deepLinkHandled.current = true;
      setSelected(target);
      setDetailMode("milestones");
      setView("list");
    }
  }, [pos]);

  // ── Realtime sync — poll every 15 seconds for changes from other users ──
  // Skips while: a sync is running, the tab is hidden, or a poll is already
  // in flight. Reload-on-change is debounced 1.5s so that bursts of writes
  // (e.g. someone running their own sync) coalesce into a single reload.
  useEffect(() => {
    if (!user) return;

    const pollBusy = { current: false };
    let reloadDebounceId: ReturnType<typeof setTimeout> | null = null;

    const isUserEditing = () => {
      const ae = document.activeElement as HTMLElement | null;
      if (!ae) return false;
      const tag = ae.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if ((ae as HTMLElement).isContentEditable) return true;
      return false;
    };
    const doReload = async () => {
      reloadDebounceId = null;
      // If the user is mid-edit (focused input/textarea/select), defer the
      // reload — re-rendering the milestones list while a date picker is
      // open will close it. Retry on the next poll tick.
      if (isUserEditing()) return;
      try {
        await loadCachedPOs();
        await loadAllMilestones();
        await loadNotes();
      } catch (e) {
        console.warn("Realtime reload failed:", e);
      }
    };

    const poll = async () => {
      if (pollBusy.current) return;
      if (document.visibilityState === "hidden") return;
      if (syncAbortRef.current) return; // user's own sync in progress
      pollBusy.current = true;
      try {
        // Quick check: fetch latest record hint from each table
        const [posRes, msRes, notesRes] = await Promise.all([
          fetch(`${SB_URL}/rest/v1/tanda_pos?select=po_number,synced_at&order=synced_at.desc&limit=1`, { headers: SB_HEADERS }),
          fetch(`${SB_URL}/rest/v1/tanda_milestones?select=id&order=id.desc&limit=1`, { headers: SB_HEADERS }),
          fetch(`${SB_URL}/rest/v1/tanda_notes?select=id,created_at&order=created_at.desc&limit=1`, { headers: SB_HEADERS }),
        ]);
        if (!posRes.ok || !msRes.ok || !notesRes.ok) return;
        const [posData, msData, notesData] = await Promise.all([posRes.json(), msRes.json(), notesRes.json()]);
        const hash = JSON.stringify({ p: posData, m: msData, n: notesData });

        if (lastDataHashRef.current && hash !== lastDataHashRef.current) {
          // Debounce: if another change arrives within 1.5s, restart the timer
          if (reloadDebounceId) clearTimeout(reloadDebounceId);
          reloadDebounceId = setTimeout(doReload, 1500);
        }
        lastDataHashRef.current = hash;
      } catch {
        // Silent fail — next poll will retry
      } finally {
        pollBusy.current = false;
      }
    };

    // Capture initial hash then start interval
    poll();
    realtimeIntervalRef.current = setInterval(poll, 15000);

    return () => {
      if (realtimeIntervalRef.current) clearInterval(realtimeIntervalRef.current);
      realtimeIntervalRef.current = null;
      if (reloadDebounceId) clearTimeout(reloadDebounceId);
    };
  }, [user, loadCachedPOs, loadNotes]);

  // ── Auto-delay overdue milestones ────────────────────────────────────────
  const autoDelayedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    Object.values(milestones).flat().forEach(m => {
      if (m.expected_date && m.expected_date <= today && m.status === "Not Started" && !autoDelayedRef.current.has(m.id)) {
        autoDelayedRef.current.add(m.id);
        const dates = { ...(m.status_dates || {}) };
        if (!dates["Delayed"]) dates["Delayed"] = today;
        saveMilestone({ ...m, status: "Delayed", status_date: dates["Delayed"], status_dates: dates, updated_at: new Date().toISOString(), updated_by: "System" }, true);
      }
    });
  }, [milestones]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const vendors = ["All", ...Array.from(new Set(pos.map(p => p.VendorName ?? "Unknown"))).sort()];

  const filtered = pos.filter(p => {
    const s = search.toLowerCase();
    const matchSearch = !s
      || (p.PoNumber ?? "").toLowerCase().includes(s)
      || (p.VendorName ?? "").toLowerCase().includes(s)
      || (p.BuyerName ?? "").toLowerCase().includes(s)
      || (p.Memo ?? "").toLowerCase().includes(s)
      || (p.Tags ?? "").toLowerCase().includes(s)
      || (p.Items ?? []).some((item: any) =>
          (item.ItemNumber ?? "").toLowerCase().includes(s) ||
          (item.Description ?? "").toLowerCase().includes(s)
        );
    const matchStatus = filterStatus === "All" || (p.StatusName ?? "") === filterStatus;
    const matchVendor = filterVendor === "All" || (p.VendorName ?? "") === filterVendor;
    return matchSearch && matchStatus && matchVendor;
  }).sort((a, b) => {
    // Status priority: lower = "more delayed" (shown first when asc).
    //   0 overdue (DDP in past, not received/closed/cancelled)
    //   1 active (Open/Released/Pending/Draft/Partially Received), DDP in future
    //   2 active with no DDP
    //   3 Received/Closed
    //   4 Cancelled
    const statusPriority = (p: XoroPO): number => {
      const s = p.StatusName ?? "";
      if (s === "Cancelled") return 4;
      if (s === "Received" || s === "Closed") return 3;
      if (!p.DateExpectedDelivery) return 2;
      const today = new Date(); today.setHours(0,0,0,0);
      const ddp = new Date(p.DateExpectedDelivery);
      if (!isNaN(ddp.getTime()) && ddp.getTime() < today.getTime()) return 0;
      return 1;
    };
    const tsOr = (s: string | null | undefined, fallback: number) => {
      if (!s) return fallback;
      const t = new Date(s).getTime();
      return isNaN(t) ? fallback : t;
    };
    let cmp = 0;
    if (sortBy === "ddp") {
      // asc = earliest DDP first (most urgent)
      cmp = tsOr(a.DateExpectedDelivery, Infinity) - tsOr(b.DateExpectedDelivery, Infinity);
    } else if (sortBy === "po_date") {
      // asc = oldest PO first
      cmp = tsOr(a.DateOrder, Infinity) - tsOr(b.DateOrder, Infinity);
    } else {
      // status: asc = delayed/overdue first → completed last
      cmp = statusPriority(a) - statusPriority(b);
      // Within the same priority, fall back to DDP ascending so the list stays predictable
      if (cmp === 0) {
        cmp = tsOr(a.DateExpectedDelivery, Infinity) - tsOr(b.DateExpectedDelivery, Infinity);
      }
    }
    return sortDir === "asc" ? cmp : -cmp;
  });

  const overdue = pos.filter(p => {
    const d = daysUntil(p.DateExpectedDelivery);
    return d !== null && d < 0 && p.StatusName !== "Received" && p.StatusName !== "Closed";
  }).length;
  const dueThisWeek = pos.filter(p => {
    const d = daysUntil(p.DateExpectedDelivery);
    return d !== null && d >= 0 && d <= 7;
  }).length;
  const totalValue = pos.reduce((s, p) => s + poTotal(p), 0);

  // ── Dashboard: scope all cards to search-filtered POs ─────────────────
  const dashPOs = search ? filtered : pos;
  const dashPoNums = new Set(dashPOs.map((p: XoroPO) => p.PoNumber ?? ""));

  // ── Milestone dashboard aggregates ────────────────────────────────────
  const allMilestonesList = Object.values(milestones).flat();
  const today = new Date().toISOString().slice(0, 10);
  const weekFromNow = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const overdueMilestones = allMilestonesList.filter(m => m.expected_date && m.expected_date < today && m.status !== "Complete" && m.status !== "N/A");
  const dueThisWeekMilestones = allMilestonesList.filter(m => m.expected_date && m.expected_date >= today && m.expected_date <= weekFromNow && m.status !== "Complete" && m.status !== "N/A");
  const completedMilestones = allMilestonesList.filter(m => m.status === "Complete");
  const milestoneCompletionRate = allMilestonesList.length > 0 ? Math.round((completedMilestones.length / allMilestonesList.length) * 100) : 0;
  const upcomingMilestones = allMilestonesList
    .filter(m => m.expected_date && m.expected_date >= today && m.status !== "Complete" && m.status !== "N/A")
    .sort((a, b) => (a.expected_date ?? "").localeCompare(b.expected_date ?? ""))
    .slice(0, 15);

  // ── Dashboard-scoped aggregates (filtered to dashPOs when search active) ──
  const dashMs = search ? allMilestonesList.filter(m => dashPoNums.has(m.po_number ?? "")) : allMilestonesList;
  const dashOverdueMilestones = dashMs.filter(m => m.expected_date && m.expected_date < today && m.status !== "Complete" && m.status !== "N/A");
  const dashDueThisWeekMilestones = dashMs.filter(m => m.expected_date && m.expected_date >= today && m.expected_date <= weekFromNow && m.status !== "Complete" && m.status !== "N/A");
  const dashUpcomingMilestones = dashMs.filter(m => m.expected_date && m.expected_date >= today && m.status !== "Complete" && m.status !== "N/A").sort((a, b) => (a.expected_date ?? "").localeCompare(b.expected_date ?? "")).slice(0, 15);
  const dashMsCompleted = dashMs.filter(m => m.status === "Complete");
  const dashMilestoneCompletionRate = dashMs.length > 0 ? Math.round((dashMsCompleted.length / dashMs.length) * 100) : 0;
  const dashTotalValue = dashPOs.reduce((s: number, p: XoroPO) => s + poTotal(p), 0);
  const dashOverduePOs = dashPOs.filter((p: XoroPO) => { const d = daysUntil(p.DateExpectedDelivery); return d !== null && d < 0 && p.StatusName !== "Received" && p.StatusName !== "Closed"; }).length;
  const dashDueThisWeekPOs = dashPOs.filter((p: XoroPO) => { const d = daysUntil(p.DateExpectedDelivery); return d !== null && d >= 0 && d <= 7; }).length;

  // Cascade alerts: POs where upstream delays block downstream categories
  const cascadeAlerts: { poNum: string; vendor: string; blockedCat: string; delayedCat: string; daysLate: number }[] = [];
  pos.forEach(po => {
    const poNum = po.PoNumber ?? "";
    const poMs = milestones[poNum] || [];
    if (poMs.length === 0) return;
    const grouped: Record<string, Milestone[]> = {};
    poMs.forEach(m => { if (!grouped[m.category]) grouped[m.category] = []; grouped[m.category].push(m); });
    const activeCats = WIP_CATEGORIES.filter(c => grouped[c]?.length);
    activeCats.forEach((cat, idx) => {
      for (let p = 0; p < idx; p++) {
        const prevCat = activeCats[p];
        const prevMs = grouped[prevCat] || [];
        if (prevMs.every(m => m.status === "Complete" || m.status === "N/A")) continue;
        const maxLate = prevMs.reduce((max, m) => {
          if (m.status === "Complete" || m.status === "N/A" || !m.expected_date) return max;
          const d = Math.ceil((Date.now() - new Date(m.expected_date).getTime()) / 86400000);
          return d > 0 ? Math.max(max, d) : max;
        }, 0);
        if (maxLate > 0) cascadeAlerts.push({ poNum, vendor: po.VendorName ?? "", blockedCat: cat, delayedCat: prevCat, daysLate: maxLate });
        break; // only report the first blocking predecessor
      }
    });
  });

  function isCatBlocked(poNum: string, cat: string): { blocked: boolean; delayedCat: string; daysLate: number } {
    const poMs = milestones[poNum] || [];
    const grouped: Record<string, Milestone[]> = {};
    poMs.forEach(m => { if (!grouped[m.category]) grouped[m.category] = []; grouped[m.category].push(m); });
    const activeCats = WIP_CATEGORIES.filter(c => grouped[c]?.length);
    const catIdx = activeCats.indexOf(cat);
    for (let p = 0; p < catIdx; p++) {
      const prevCat = activeCats[p];
      const prevMs = grouped[prevCat] || [];
      if (prevMs.every(m => m.status === "Complete" || m.status === "N/A")) continue;
      const maxLate = prevMs.reduce((max, m) => {
        if (m.status === "Complete" || m.status === "N/A" || !m.expected_date) return max;
        const d = Math.ceil((Date.now() - new Date(m.expected_date).getTime()) / 86400000);
        return d > 0 ? Math.max(max, d) : max;
      }, 0);
      return { blocked: true, delayedCat: prevCat, daysLate: maxLate };
    }
    return { blocked: false, delayedCat: "", daysLate: 0 };
  }

  async function cascadeDueDateChange(milestone: Milestone, newDate: string) {
    const poNum = milestone.po_number;
    const oldDate = milestone.expected_date;
    if (!oldDate || !newDate || oldDate === newDate) {
      // No old date or no change — just save this one
      saveMilestone({ ...milestone, expected_date: newDate || null, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
      return;
    }
    const diffDays = Math.round((new Date(newDate).getTime() - new Date(oldDate).getTime()) / 86400000);
    if (diffDays === 0) {
      saveMilestone({ ...milestone, expected_date: newDate, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
      return;
    }
    // Get all milestones for this PO sorted by sort_order
    const allMs = [...(milestones[poNum] || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const msIdx = allMs.findIndex(m => m.id === milestone.id);
    // Save the changed milestone — if new date is >= today and status is Delayed, reset to Not Started
    const today = new Date().toISOString().slice(0, 10);
    const resetStatus = (date: string, currentStatus: string) => {
      if (date >= today && currentStatus === "Delayed") return "Not Started";
      return currentStatus;
    };
    const newStatus = resetStatus(newDate, milestone.status);
    const failures: string[] = [];
    try {
      await saveMilestone({ ...milestone, expected_date: newDate, status: newStatus, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
    } catch (e: any) {
      console.warn(`Cascade: failed to save trigger milestone "${milestone.phase}":`, e);
      setToast(`Failed to save "${milestone.phase}" — ${e?.message || "unknown error"}. Cascade aborted.`);
      return;
    }
    // Shift all subsequent milestones by the same number of days
    let shifted = 0;
    for (let i = msIdx + 1; i < allMs.length; i++) {
      const m = allMs[i];
      if (m.expected_date && m.status !== "Complete") {
        const d = new Date(m.expected_date);
        d.setDate(d.getDate() + diffDays);
        const newDateStr = d.toISOString().slice(0, 10);
        const mStatus = resetStatus(newDateStr, m.status);
        try {
          await saveMilestone({ ...m, expected_date: newDateStr, status: mStatus, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
          shifted++;
        } catch (e: any) {
          console.warn(`Cascade: failed to shift "${m.phase}":`, e);
          failures.push(m.phase);
        }
      }
    }
    if (shifted > 0) {
      addHistory(poNum, `Due date changed for "${milestone.phase}": ${oldDate} → ${newDate} (${diffDays > 0 ? "+" : ""}${diffDays}d). ${shifted} subsequent milestone${shifted > 1 ? "s" : ""} shifted.`);
    }
    if (failures.length > 0) {
      const sample = failures.slice(0, 3).join(", ");
      const more = failures.length > 3 ? ` +${failures.length - 3} more` : "";
      setToast(`Cascade partially failed — ${failures.length} milestone${failures.length === 1 ? "" : "s"} not updated: ${sample}${more}`);
    }
  }

  function openCategoryWithCheck(poNum: string, cat: string, po?: XoroPO | null, switchView?: boolean) {
    const key = cat + poNum;
    const info = isCatBlocked(poNum, cat);
    const doOpen = () => {
      setAcceptedBlocked(prev => new Set(prev).add(key));
      setDetailMode("milestones");
      setNewNote("");
      setSearch("");
      if (po) setSelected(po);
      if (switchView) setView("list");
      setCollapsedCats(prev => { const next = { ...prev }; WIP_CATEGORIES.forEach(c => { next[c + poNum] = c !== cat; }); return next; });
    };
    if (info.blocked && !acceptedBlocked.has(key)) {
      setBlockedModal({ cat, delayedCat: info.delayedCat, daysLate: info.daysLate, onConfirm: doOpen });
    } else {
      doOpen();
    }
  }

  // ── Ask Me — AI Help System ────────────────────────────────────────────
  const askMeKnowledge: { keywords: string[]; answer: string }[] = [
    { keywords: ["sync", "xoro", "import", "load", "po"], answer: "**Syncing POs from Xoro**\n\nClick **🔄 Sync** in the nav bar. You can filter by vendor, status, PO number, or date range. The sync fetches active POs (Open, Released, Pending, Draft) and auto-deletes Closed/Received/Cancelled ones.\n\nPOs sync one status at a time to avoid timeouts. If a status fails, it skips and continues with the rest." },
    { keywords: ["milestone", "status", "change", "update"], answer: "**Changing Milestone Status**\n\nOpen any PO → Milestones tab. Each milestone has a status dropdown:\n• **Not Started** → default\n• **In Progress** → work has begun\n• **Delayed** → past due (auto-set when date passes)\n• **Complete** → finished\n• **N/A** → not applicable\n\nEach status change records the date automatically. When switching from Complete, you'll be asked whether to clear the completion date." },
    { keywords: ["cascade", "blocked", "dependency", "dependencies"], answer: "**Cascade Dependencies**\n\nCategories follow a sequence: Pre-Production → Fabric T&A → Samples → Production → Transit. Each depends on the previous being Complete.\n\nIf a category is delayed, downstream categories show:\n• Yellow border + \"Blocked by X\" badge\n• Projected shifted due dates (→ arrow)\n• A confirmation dialog before opening\n\nThe Dashboard shows cascade alerts sorted by severity." },
    { keywords: ["timeline", "gantt", "chart", "bar"], answer: "**Gantt Timeline**\n\nClick **📊 Timeline** in the nav bar. Shows all POs with milestone category bars:\n• 🟢 Green = Complete\n• 🔵 Blue = In Progress\n• 🔴 Red = Delayed\n• ⬜ Gray = Not Started\n\nClick a PO name → opens its detail. Click a bar → opens that specific category.\n\nThe search bar filters by PO#, vendor, memo, or tags. Selecting a PO in All POs and switching to Timeline auto-fills the search." },
    { keywords: ["matrix", "size", "color", "base", "sku"], answer: "**Item Matrix**\n\nThe PO/Matrix tab parses each SKU by dashes:\n• Before 1st dash = **Base Part**\n• Between 1st and 2nd dash = **Color**\n• After 2nd dash = **Size**\n\nSizes sort numerically (5, 6, 7, 8, 10, 12...). Shows quantity per size, row totals, PO cost, and total cost. The Line Items section below shows the raw SKU list." },
    { keywords: ["excel", "export", "download", "spreadsheet"], answer: "**Excel Export**\n\nClick the green **Excel** button in any PO detail view. It exports the current tab:\n• **PO/Matrix** → Matrix sheet + Line Items sheet\n• **Milestones** → Milestone details\n• **Notes** → All notes\n• **All** → Everything combined\n\nEach export includes a styled header with PO info, colored headers, alternating rows, and number formatting ($#,##0.00 for dollars, #,##0 for quantities)." },
    { keywords: ["print"], answer: "**Printing**\n\nClick the **🖨️ Print** button in any PO detail view. Opens a clean print-friendly popup with the current tab content. Buttons, inputs, and iframes are hidden for clean output." },
    { keywords: ["note", "notes", "comment"], answer: "**Milestone Notes**\n\nEach milestone has a 📝 icon. Click it to expand the notes panel:\n• See existing notes with timestamps and who wrote them\n• Type a new note and press Enter or click Add\n• Notes are timestamped and user-identified\n• The icon shows a blue badge with the note count" },
    { keywords: ["custom", "phase", "add phase"], answer: "**Adding Custom Phases**\n\nAt the bottom of the Milestones tab, click **+ Add Custom Phase**:\n• Enter a **phase name** (e.g. \"Lab Dip Review\")\n• Select a **category**\n• Optionally set a **due date** — or it auto-calculates\n• Choose **Insert After** to position it between existing phases\n\nIf you use Insert After without a due date, it auto-sets the midpoint between the adjacent phases." },
    { keywords: ["due date", "change date", "shift", "cascade date"], answer: "**Changing Due Dates**\n\nClick any milestone's due date to edit it. When you change a date:\n• All subsequent milestones shift by the same number of days\n• Delayed milestones reset to Not Started if the new date is in the future\n• Change is logged to history with the shift amount\n\nExample: Moving a date forward by 5 days shifts all following milestones +5 days." },
    { keywords: ["delete", "po", "remove"], answer: "**Deleting a PO**\n\nIn the PO detail view, click **🗑 Delete PO**. This permanently removes:\n• The PO record\n• All milestones\n• All notes and history\n• All attachments\n\nClosed, Received, and Cancelled POs are auto-deleted on sync." },
    { keywords: ["attachment", "file", "upload", "dropbox"], answer: "**Attachments**\n\nOpen any PO → **📎 Files** tab:\n• Click **+ Upload Files** to upload one or multiple files\n• Files are stored in Dropbox at `/Eran Bitton/Apps/design-calendar-app/po-attachments/`\n• Click a filename to open/download\n• Image files show a thumbnail preview\n• Delete shows a 24-hour undo countdown — the file stays in Dropbox until the timer expires" },
    { keywords: ["email", "outlook", "send", "inbox"], answer: "**Email Integration**\n\nThe **📧 Email** tab in PO detail shows Outlook emails matching the subject prefix [PO-{number}]:\n• **Inbox** — all matching emails with unread indicators\n• **Thread** — conversation view with HTML rendering\n• **Compose** — send new emails with pre-filled subject prefix\n\nRequires Azure AD setup with Mail.Read and Mail.Send permissions." },
    { keywords: ["vendor", "scorecard", "performance", "on-time"], answer: "**Vendor Scorecard**\n\nClick **🏆 Vendors** in the nav bar. Shows per-vendor:\n• PO count and milestone completion\n• On-time vs late count\n• Average days late\n• On-time % with color-coded bar (🟢 ≥90%, 🟡 ≥70%, 🔴 <70%)\n\nClick a vendor to filter the PO list by that vendor." },
    { keywords: ["activity", "feed", "history", "log"], answer: "**Activity Feed**\n\nClick **📋 Activity** in the nav bar. Shows a unified global feed of all recent changes:\n• Status changes, bulk updates, syncs, milestone generation\n• Contextual icons (⚡📊🔄🏭📝)\n• Time-ago labels\n• Click any row to open the relevant PO" },
    { keywords: ["dashboard", "health", "score"], answer: "**Dashboard**\n\nThe dashboard shows:\n• **Production Health Score** — ring chart combining completion rate minus delay penalty\n• **8 stat cards** — all clickable to navigate to details\n• **Milestone Pipeline** — status distribution bars\n• **Progress by Category** — per-category completion\n• **Top Vendors** — best performers\n• **Cascade Alerts** — blocked categories sorted by severity\n• **Upcoming + Overdue** — side-by-side milestone tables" },
    { keywords: ["template", "wip", "production template", "create template", "vendor template"], answer: "**Production Templates**\n\nClick **Templates** in the nav bar.\n\n• **Default template** — applies to all vendors without a custom one\n• **Vendor templates** — override the default for a specific vendor\n• Each phase has: name, category, days before DDP, default status\n\n**Creating a vendor template:** Select a vendor from the dropdown → click **+ New Vendor Template** → choose a vendor and optionally copy from an existing template.\n\n**Editing:** All changes are **local until you click Save**. Use **↩ Undo** to step back. Drag the **⠿** handle to reorder phases. Click ✕ to delete a phase. Click **+ Add Phase** to add a new one.\n\nWhen a PO is opened for a vendor without a template, you're prompted to create one." },
    { keywords: ["conflict", "realtime", "sync", "multi-user", "other user"], answer: "**Multi-User & Conflict Handling**\n\nThe app syncs every 10 seconds. When another user makes changes, your view updates automatically.\n\nIf you and another user edit the same milestone simultaneously, a conflict dialog appears:\n• **Use Mine** — saves your version\n• **Keep Theirs** — reloads the server version\n\nNo data is lost — you always choose which version to keep." },
    { keywords: ["search", "find", "filter"], answer: "**Search & Filter**\n\nThe search bar in **All POs** filters by: PO#, vendor, memo, tags, and status.\n\nIn **Timeline**, the same search filters the Gantt chart. Selecting a PO in All POs and switching to Timeline auto-fills the search.\n\nIn **Email view**, search filters the PO list.\n\nYou can also filter by: vendor dropdown, status pills (Open / Released / Pending), due date range, and tags." },
    { keywords: ["ddp", "delivery date", "due date", "days before"], answer: "**DDP Date (Delivered Duty Paid)**\n\nDDP is the target date when goods must arrive at the destination. All milestone due dates are calculated relative to DDP:\n\n• A phase with **60 days before DDP** is due 60 days before the delivery date\n• Changing the DDP date on a PO shifts all milestone dates proportionally\n• The **In House / DDP** milestone is at 0 days — it IS the DDP date\n\nTo change the DDP date: open the PO → PO Info tab → edit the Expected Delivery field." },
    { keywords: ["archive", "archived", "closed", "cancelled", "received"], answer: "**Archived POs**\n\nPOs with status Closed, Received, or Cancelled are automatically archived on each sync and removed from the main list.\n\nTo view them: click **📦 Archive** in the nav bar.\n\nArchived POs retain all milestones, notes, and attachments. They cannot be edited but can be viewed.\n\nIf a PO is accidentally archived, re-sync — if it's still active in Xoro it will reappear." },
    { keywords: ["tag", "tags", "label", "mark"], answer: "**Tags**\n\nTags let you label POs for quick filtering.\n\nTo add a tag: open a PO → PO Info tab → Tags field → type and press Enter.\n\nTo filter by tag: use the search bar in All POs — it matches tag text.\n\nTags are free-form text — examples: 'Rush', 'Hold', 'Review Needed', 'Season 2025'." },
    { keywords: ["regenerate", "reset milestones", "rebuild milestones", "regen"], answer: "**Regenerating Milestones**\n\nIf the template changes or milestones get out of sync, you can regenerate them.\n\nOpen a PO → Milestones tab → click **↺ Regenerate**.\n\n⚠️ This replaces existing milestones with fresh ones based on the current template and DDP date. Status history and notes on deleted milestones are lost.\n\nIf you only want to add missing phases, use **+ Add Custom Phase** instead." },
    { keywords: ["admin", "role", "user", "permission", "access"], answer: "**User Roles**\n\nThere are two roles:\n\n**Admin** — full access: can edit templates, bulk update, delete POs, manage vendors, view all POs across all teams.\n\n**User** — can update milestone statuses, add notes, view POs. Cannot edit templates or delete POs.\n\nYour role is set in the Teams settings page by an admin. The current user is shown in the top-right of the nav bar." },
    { keywords: ["undo", "revert", "undo change"], answer: "**Undo**\n\nUndo is available in two places:\n\n**Milestone dates** — if you change a due date or drag a milestone, an **Undo** button appears at the bottom of the screen. Click it to revert the last date change.\n\n**Template editor** — while editing a template, use the **↩ Undo** button above the table to step back through changes. Undo history resets when you Save or switch vendors." },
    { keywords: ["drag", "reorder", "order", "move phase", "rearrange"], answer: "**Reordering Template Phases**\n\nIn the Templates editor (admin only):\n\nGrab the **⠿** handle on the left of any phase row and drag it to a new position. A blue line shows where it will land.\n\nThe order is saved to the database only when you click **Save** — changes are buffered locally until then. Use **↩ Undo** to reverse a reorder before saving." },
    { keywords: ["phase", "category", "pre-production", "fabric", "samples", "production", "transit"], answer: "**Milestone Categories**\n\nMilestones are grouped into 5 categories in order:\n\n1. **Pre-Production** — Lab Dip, Trims\n2. **Fabric T&A** — Raw Goods, Printing, Finishing, Cutting\n3. **Samples** — Fit Sample, PP Sample, PP Approval, Size Set, Top Sample\n4. **Production** — Fabric Ready, Prod Start, Packing, Prod End\n5. **Transit** — Ex Factory, Packing Docs, In House / DDP\n\nCategories cascade — each must be Complete before the next can start. Blocked categories are highlighted in yellow." },
    { keywords: ["po info", "purchase order", "vendor name", "memo", "status name"], answer: "**PO Detail Tabs**\n\nOpening a PO shows these tabs:\n\n• **PO / Matrix** — order summary, SKU matrix by color/size, line items, total cost\n• **Milestones** — production timeline with status per phase and category\n• **Notes** — team notes and comments on this PO\n• **History** — auto-logged changelog of all status changes and updates\n• **📎 Files** — attachments stored in Dropbox\n• **📧 Email** — Outlook emails matching this PO number\n\nClick the **X** or press Escape to close the detail view." },
    { keywords: ["bulk", "update", "multiple", "vendor"], answer: "**Bulk Milestone Update**\n\nClick **⚡ Bulk Update** in the nav bar.\n\n1. Select a **vendor**\n2. Optionally filter by **POs** (search + checkboxes)\n3. Optionally filter by **category** and **phases**\n4. Select the **new status**\n5. Preview shows how many milestones will be affected\n6. Click Update\n\nPOs without milestones will have them auto-generated before the update.\n\nBulk updates are logged in the Activity feed and each PO's history." },
  ];

  function getAskMeAnswer(query: string): string {
    const q = query.toLowerCase();
    let bestMatch = { score: 0, answer: "" };
    for (const item of askMeKnowledge) {
      const score = item.keywords.reduce((s, kw) => s + (q.includes(kw.toLowerCase()) ? 1 : 0), 0);
      if (score > bestMatch.score) bestMatch = { score, answer: item.answer };
    }
    if (bestMatch.score > 0) return bestMatch.answer;
    return "I'm not sure about that. Try asking about:\n• **Syncing POs** from Xoro\n• **Milestones** — status, cascade, dependencies, regenerate\n• **DDP Date** — what it is and how it affects milestones\n• **Timeline** — Gantt chart view\n• **Matrix** — size/color SKU breakdown\n• **Bulk Update** — update multiple POs at once\n• **Excel Export** — download data\n• **Attachments** — file uploads\n• **Email** — Outlook integration\n• **Vendor Scorecard** — performance tracking\n• **Templates** — create, edit, drag to reorder, save\n• **Dashboard** — health score, stats, cascade alerts\n• **Archive** — closed/cancelled POs\n• **Tags** — labeling POs\n• **User Roles** — admin vs user permissions\n• **Undo** — reverting changes\n• **Search & Filter** — finding POs";
  }

  async function addNote() {
    if (!newNote.trim() || !selected || !user) return;
    const noteText = newNote.trim();
    await sb.from("tanda_notes").insert({
      po_number: selected.PoNumber,
      note: noteText,
      status_override: null,
      user_name: user.name,
      created_at: new Date().toISOString(),
    });
    setNewNote("");
    addHistory(selected.PoNumber ?? "", `Note added: "${noteText.length > 80 ? noteText.slice(0, 80) + "…" : noteText}"`);
  }

  async function editNote(noteId: string, newText: string) {
    if (!newText.trim()) return;
    await fetch(`${SB_URL}/rest/v1/tanda_notes?id=eq.${encodeURIComponent(noteId)}`, {
      method: "PATCH", headers: { ...SB_HEADERS, "Prefer": "return=minimal" },
      body: JSON.stringify({ note: newText.trim() }),
    });
    await loadNotes();
  }

  async function deleteNote(noteId: string) {
    await sb.from("tanda_notes").delete(`id=eq.${encodeURIComponent(noteId)}`);
    await loadNotes();
  }

  async function addHistory(poNumber: string, description: string) {
    if (!poNumber) return;
    await sb.from("tanda_notes").insert({
      po_number: poNumber,
      note: description,
      status_override: "__history__",
      user_name: user?.name || "System",
      created_at: new Date().toISOString(),
    });
    await loadNotes();
  }

  // ── Attachments (Dropbox) ────────────────────────────────────────────────
  async function uploadAttachment(poNumber: string, file: File) {
    const safeName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const dbxPath = `/Eran Bitton/Apps/design-calendar-app/po-attachments/${poNumber}/${safeName}`;
    const res = await fetch("/api/dropbox-proxy", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Dropbox-Action": "upload", "X-Dropbox-Path": dbxPath },
      body: file,
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    const data = await res.json();
    const url = data.shared_url || "";
    const entry = { id: safeName, name: file.name, url, dbxPath: data.path_display || dbxPath, type: file.type, size: file.size, uploaded_by: user?.name || "", uploaded_at: new Date().toISOString() };
    await sb.from("tanda_notes").insert({ po_number: poNumber, note: JSON.stringify(entry), status_override: "__attachment__", user_name: user?.name || "", created_at: new Date().toISOString() });
  }
  async function loadAttachments(poNumber: string) {
    const { data } = await sb.from("tanda_notes").select("*", `po_number=eq.${encodeURIComponent(poNumber)}&status_override=eq.__attachment__`);
    if (data) {
      const entries = data.map((r: any) => { try { return JSON.parse(r.note); } catch { return null; } }).filter(Boolean);
      coreD({ type: "SET_ATTACHMENTS_FOR_PO", poNumber, attachments: entries });
    }
  }
  async function deleteAttachment(poNumber: string, attachId: string) {
    const entry = (attachments[poNumber] || []).find(a => a.id === attachId);
    if (!entry) return;
    // Soft delete: mark as deleted with timestamp, don't remove from Dropbox yet
    const updatedEntry = { ...entry, deleted_at: new Date().toISOString() };
    // Update metadata in Supabase
    const { data, error: selErr } = await sb.from("tanda_notes").select("id,note", `po_number=eq.${encodeURIComponent(poNumber)}&status_override=eq.__attachment__`);
    if (selErr) {
      console.warn("deleteAttachment: failed to load attachment rows", selErr);
      await loadAttachments(poNumber);
      return;
    }
    const row = data?.find((r: any) => { try { return JSON.parse(r.note).id === attachId; } catch { return false; } });
    if (!row) {
      // Row was deleted by another user (or never persisted) — refresh and bail
      console.warn(`deleteAttachment: attachment ${attachId} not found in DB for ${poNumber}; refreshing local state`);
      await loadAttachments(poNumber);
      return;
    }
    const { error: upErr } = await sb.from("tanda_notes").upsert({ id: row.id, po_number: poNumber, note: JSON.stringify(updatedEntry), status_override: "__attachment__", user_name: entry.uploaded_by, created_at: entry.uploaded_at }, { onConflict: "id" });
    if (upErr) {
      console.warn("deleteAttachment: upsert failed", upErr);
      await loadAttachments(poNumber);
      return;
    }
    coreD({ type: "UPDATE_ATTACHMENT", poNumber, attachId, entry: updatedEntry });
    addHistory(poNumber, `Attachment soft-deleted: ${entry.name} (undo available for 24h)`);
  }

  async function undoDeleteAttachment(poNumber: string, attachId: string) {
    const entry = (attachments[poNumber] || []).find(a => a.id === attachId);
    if (!entry) return;
    const restoredEntry = { ...entry }; delete (restoredEntry as any).deleted_at;
    const { data } = await sb.from("tanda_notes").select("id,note", `po_number=eq.${encodeURIComponent(poNumber)}&status_override=eq.__attachment__`);
    const row = data?.find((r: any) => { try { return JSON.parse(r.note).id === attachId; } catch { return false; } });
    if (row) {
      await sb.from("tanda_notes").upsert({ id: row.id, po_number: poNumber, note: JSON.stringify(restoredEntry), status_override: "__attachment__", user_name: entry.uploaded_by, created_at: entry.uploaded_at }, { onConflict: "id" });
    }
    coreD({ type: "UPDATE_ATTACHMENT", poNumber, attachId, entry: restoredEntry });
    addHistory(poNumber, `Attachment restored: ${entry.name}`);
  }

  async function purgeExpiredAttachments(poNumber: string) {
    const files = attachments[poNumber] || [];
    const now = Date.now();
    const expired = files.filter((f: any) =>
      f.deleted_at && now - new Date(f.deleted_at).getTime() > 24 * 60 * 60 * 1000
    );
    if (expired.length === 0) return;

    // Fetch attachment rows ONCE up front, build an id→row.id map.
    const { data: rows, error: selErr } = await sb.from("tanda_notes").select("id,note", `po_number=eq.${encodeURIComponent(poNumber)}&status_override=eq.__attachment__`);
    if (selErr) {
      console.warn("purgeExpiredAttachments: failed to load rows", selErr);
      return;
    }
    const attachIdToRowId = new Map<string, string>();
    (rows ?? []).forEach((r: any) => {
      try { attachIdToRowId.set(JSON.parse(r.note).id, r.id); } catch {}
    });

    // Delete each expired attachment from Dropbox + DB.
    for (const f of expired) {
      const dbxPath = (f as any).dbxPath || `/Eran Bitton/Apps/design-calendar-app/po-attachments/${poNumber}/${f.id}`;
      try {
        await fetch(`/api/dropbox-proxy?action=delete&path=${encodeURIComponent(dbxPath)}`);
      } catch (e) {
        console.warn(`Dropbox purge failed for ${f.id}:`, e);
        addHistory(poNumber, `Warning: failed to purge Dropbox file for ${f.name}`);
      }
      const rowId = attachIdToRowId.get(f.id);
      if (rowId) {
        const { error: delErr } = await sb.from("tanda_notes").delete(`id=eq.${encodeURIComponent(rowId)}`);
        if (delErr) console.warn(`DB purge failed for ${f.id}:`, delErr);
      }
    }

    // Reload from Supabase to get clean state after purge
    const { data: refreshed } = await sb.from("tanda_notes").select("*", `po_number=eq.${encodeURIComponent(poNumber)}&status_override=eq.__attachment__`);
    if (refreshed) {
      const entries = refreshed.map((r: any) => { try { return JSON.parse(r.note); } catch { return null; } }).filter(Boolean);
      coreD({ type: "SET_ATTACHMENTS_FOR_PO", poNumber, attachments: entries });
    }
  }

  async function deletePO(poNumber: string) {
    if (!poNumber) return;
    // Delete from tanda_pos
    await sb.from("tanda_pos").delete(`po_number=eq.${encodeURIComponent(poNumber)}`);
    // Delete all milestones for this PO
    const poMs = milestones[poNumber] || [];
    for (const m of poMs) {
      await sb.from("tanda_milestones").delete(`id=eq.${encodeURIComponent(m.id)}`);
    }
    // Delete all notes and history for this PO
    const poNotes = notes.filter(n => n.po_number === poNumber);
    for (const n of poNotes) {
      if (n.id) await sb.from("tanda_notes").delete(`id=eq.${encodeURIComponent(n.id)}`);
    }
    // Remove from local state — atomic via reducer
    coreD({ type: "REMOVE_PO", poNumber });
    if (selected?.PoNumber === poNumber) setSelected(null);
  }

  // ── Archive functions ──────────────────────────────────────────────────
  async function archivePO(poNumber: string) {
    if (!poNumber) return;
    // Mark as archived in the data JSON — preserves all milestones, notes, attachments
    const { data: rows } = await sb.from("tanda_pos").select("data", `po_number=eq.${encodeURIComponent(poNumber)}`);
    if (rows?.[0]) {
      const poData = rows[0].data as XoroPO;
      const archived = { ...poData, _archived: true, _archivedAt: new Date().toISOString() };
      await sb.from("tanda_pos").upsert({ po_number: poNumber, data: archived }, { onConflict: "po_number" });
    }
    // Remove from active local state only
    coreD({ type: "REMOVE_PO", poNumber });
    if (selected?.PoNumber === poNumber) setSelected(null);
  }

  async function loadArchivedPOs() {
    setArchiveLoading(true);
    try {
      const { data } = await sb.from("tanda_pos").select("*");
      if (data) {
        const archived = data
          .filter((r: any) => (r.data as XoroPO)?._archived === true)
          .map((r: any) => r.data as XoroPO);
        setArchivedPos(archived);
      }
    } catch (e) { console.error("Load archived error:", e); }
    setArchiveLoading(false);
  }

  async function unarchivePO(poNumber: string) {
    if (!poNumber) return;
    const { data: rows } = await sb.from("tanda_pos").select("data", `po_number=eq.${encodeURIComponent(poNumber)}`);
    if (rows?.[0]) {
      const poData = rows[0].data as XoroPO;
      const restored = { ...poData, _archived: false, _archivedAt: undefined };
      delete (restored as any)._archived;
      delete (restored as any)._archivedAt;
      await sb.from("tanda_pos").upsert({ po_number: poNumber, data: restored }, { onConflict: "po_number" });
    }
    addHistory(poNumber, "PO restored from archive");
    await loadCachedPOs();
    await loadArchivedPOs();
  }

  async function permanentDeleteArchived(poNumbers: string[]) {
    for (const poNumber of poNumbers) {
      // Delete PO record
      await sb.from("tanda_pos").delete(`po_number=eq.${encodeURIComponent(poNumber)}`);
      // Delete milestones
      const { data: msRows } = await sb.from("tanda_milestones").select("id,data");
      if (msRows) {
        for (const r of msRows) {
          if ((r.data as any)?.po_number === poNumber) {
            await sb.from("tanda_milestones").delete(`id=eq.${encodeURIComponent(r.id)}`);
          }
        }
      }
      // Delete notes/history/attachments
      const { data: noteRows } = await sb.from("tanda_notes").select("id", `po_number=eq.${encodeURIComponent(poNumber)}`);
      if (noteRows) {
        for (const n of noteRows) {
          await sb.from("tanda_notes").delete(`id=eq.${encodeURIComponent(n.id)}`);
        }
      }
    }
    await loadArchivedPOs();
  }

  async function bulkUpdateMilestones() {
    if (!bulkVendor || !bulkStatus) return;
    setBulkUpdating(true);
    const vendorPOs = pos.filter(p => (p.VendorName ?? "") === bulkVendor);
    const targetPOs = bulkPOs.length > 0 ? vendorPOs.filter(p => bulkPOs.includes(p.PoNumber ?? "")) : vendorPOs;
    const today = new Date().toISOString().split("T")[0];
    let count = 0;
    let generated = 0;
    // Auto-generate milestones for POs that don't have them
    for (const po of targetPOs) {
      const poNum = po.PoNumber ?? "";
      if (!(milestones[poNum]?.length) && po.DateExpectedDelivery) {
        const result = await ensureMilestones(po);
        if (result !== "needs_template" && Array.isArray(result) && result.length > 0) generated++;
      }
    }
    // Now update milestones
    for (const po of targetPOs) {
      const poNum = po.PoNumber ?? "";
      const poMs = milestones[poNum] || [];
      for (const m of poMs) {
        const matchPhase = bulkPhases.length === 0 || bulkPhases.includes(m.phase);
        const matchCat = !bulkCategory || m.category === bulkCategory;
        if (matchPhase && matchCat && m.status !== bulkStatus && m.status !== "N/A") {
          const dates = { ...(m.status_dates || {}) };
          if (bulkStatus !== "Not Started" && !dates[bulkStatus]) dates[bulkStatus] = today;
          await saveMilestone({
            ...m,
            status: bulkStatus,
            status_date: dates[bulkStatus] || today,
            status_dates: Object.keys(dates).length > 0 ? dates : null,
            updated_at: new Date().toISOString(),
            updated_by: user?.name || "",
          }, true);
          count++;
        }
      }
    }
    const poNums = targetPOs.map(p => p.PoNumber ?? "").filter(Boolean);
    if (count > 0) {
      addHistory(targetPOs[0]?.PoNumber ?? "", `Bulk update: ${count} milestones → ${bulkStatus} for ${bulkVendor} [${poNums.join(", ")}]${bulkCategory ? ` (${bulkCategory})` : ""}`);
    }
    setBulkUpdating(false);
    setShowBulkUpdate(false);
    setBulkPhase(""); setBulkPhases([]);
    setBulkCategory("");
    setBulkPOs([]); setBulkPOSearch("");
    const genMsg = generated > 0 ? ` (${generated} POs had milestones auto-generated)` : "";
    setConfirmModal({ title: "Bulk Update Complete", message: `Updated ${count} milestones to "${bulkStatus}" for ${bulkVendor} — POs: ${poNums.join(", ")}${genMsg}`, icon: "✅", confirmText: "OK", confirmColor: "#10B981", onConfirm: () => {} });
  }

  const allPONotes = notes.filter(n => n.po_number === selected?.PoNumber);
  const selectedNotes = allPONotes.filter(n => n.status_override !== "__history__" && n.status_override !== "__attachment__");
  const selectedHistory = allPONotes.filter(n => n.status_override === "__history__");

  // ════════════════════════════════════════════════════════════════════════════
  // LOGIN SCREEN
  // ════════════════════════════════════════════════════════════════════════════
  const [showLoginPass, setShowLoginPass] = useState(false);

  // Auto-load email stats once after MS auth, then refresh every 2 minutes.
  // MUST be declared before any early returns below to keep hook order stable.
  useEffect(() => {
    if (!msToken) return;
    loadAllPOEmailStats();
    const id = setInterval(loadAllPOEmailStats, 120000);
    return () => clearInterval(id);
  }, [msToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // While checking PLM session, show blank (prevents login flash)
  if (!sessionChecked) return <div style={{ minHeight: "100vh", background: "#F9FAFB" }} />;

  if (!user) return (
    <div style={S.loginBg}>
      <div style={S.loginCard}>
        <div style={S.loginLogo}>PO</div>
        <h1 style={S.loginTitle}>Purchase Orders</h1>
        <p style={S.loginSub}>Powered by XoroERP</p>
        <input style={S.input} placeholder="Username" value={loginName}
          onChange={e => setLoginName(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleLogin()} />
        <div style={{ position: "relative" }}>
          <input style={{ ...S.input, paddingRight: 40 }} placeholder="Password"
            type={showLoginPass ? "text" : "password"} value={loginPass}
            onChange={e => setLoginPass(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleLogin()} />
          <button onClick={() => setShowLoginPass(p => !p)}
            style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#6B7280", fontSize: 16, lineHeight: 1, padding: 0 }}>
            {showLoginPass ? "🙈" : "👁"}
          </button>
        </div>
        {loginErr && <p style={S.err}>{loginErr}</p>}
        <button style={S.btnPrimary} onClick={handleLogin}>Sign In</button>
      </div>
    </div>
  );

  // ════════════════════════════════════════════════════════════════════════════
  // SYNC MODAL
  // ════════════════════════════════════════════════════════════════════════════
  const allVendors = Array.from(new Set([...xoroVendors, ...manualVendors, ...pos.map(p => p.VendorName ?? "").filter(Boolean)])).sort();
  const filteredVendorList = allVendors.filter(v =>
    !vendorSearch || v.toLowerCase().includes(vendorSearch.toLowerCase())
  );

  const SyncModal = () => (
    <div style={S.modalOverlay} onClick={() => { setShowSyncModal(false); setSyncFilters({ poNumbers: [], dateFrom: "", dateTo: "", vendors: [], statuses: [] }); }}>
      <div style={{ ...S.modal, width: 540 }} onClick={e => e.stopPropagation()}>
        <div style={S.modalHeader}>
          <h2 style={S.modalTitle}>🔄 Sync from Xoro</h2>
          <button style={S.closeBtn} onClick={() => { setShowSyncModal(false); setSyncFilters({ poNumbers: [], dateFrom: "", dateTo: "", vendors: [], statuses: [] }); }}>✕</button>
        </div>
        <div style={S.modalBody}>
          <p style={{ color: "#9CA3AF", fontSize: 13, marginTop: 0, marginBottom: 20 }}>
            Filter which POs to pull from Xoro. Leave all blank to sync everything. New POs will be added; existing ones updated.
          </p>

          {/* PO Number multi-select */}
          <label style={S.label}>PO Number (search & select one or more, or leave blank for all)</label>
          {/* Selected PO chips */}
          {syncFilters.poNumbers.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {syncFilters.poNumbers.map(pn => (
                <span key={pn} style={{ display: "flex", alignItems: "center", gap: 4, background: "#3B82F622", border: "1px solid #3B82F6", borderRadius: 20, padding: "3px 10px", fontSize: 13, color: "#60A5FA", fontFamily: "monospace" }}>
                  {pn}
                  <button onClick={() => setSyncFilters(p => ({ ...p, poNumbers: p.poNumbers.filter(x => x !== pn) }))}
                    style={{ background: "none", border: "none", color: "#60A5FA", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "0 0 0 2px" }}>✕</button>
                </span>
              ))}
            </div>
          )}
          {/* Search input */}
          <div style={{ position: "relative", marginBottom: 16 }}>
            <input style={{ ...S.input, marginBottom: 0 }}
              placeholder="Type to search PO numbers…"
              value={poSearch}
              onChange={e => { setPoSearch(e.target.value); setPoDropdownOpen(true); }}
              onFocus={() => setPoDropdownOpen(true)}
              onBlur={() => setTimeout(() => setPoDropdownOpen(false), 200)}
            />
            {poDropdownOpen && poSearch && (() => {
              const matches = pos.filter(p =>
                (p.PoNumber ?? "").toLowerCase().includes(poSearch.toLowerCase()) &&
                !syncFilters.poNumbers.includes(p.PoNumber ?? "")
              ).slice(0, 10);
              if (!matches.length) return null;
              return (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "#1E293B", border: "1px solid #334155", borderRadius: 8, zIndex: 100, maxHeight: 200, overflowY: "auto" }}>
                  {matches.map(p => (
                    <div key={p.PoNumber} onMouseDown={() => {
                      setSyncFilters(prev => ({ ...prev, poNumbers: [...prev.poNumbers, p.PoNumber ?? ""] }));
                      setPoSearch("");
                      setPoDropdownOpen(false);
                    }} style={{ padding: "8px 12px", cursor: "pointer", borderBottom: "1px solid #334155", display: "flex", alignItems: "center", gap: 10 }}
                      onMouseEnter={e => e.currentTarget.style.background = "#334155"}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <span style={{ color: "#60A5FA", fontFamily: "monospace", fontSize: 13 }}>{p.PoNumber}</span>
                      <span style={{ color: "#9CA3AF", fontSize: 12 }}>{p.VendorName}</span>
                      <span style={{ color: "#6B7280", fontSize: 11, marginLeft: "auto" }}>{fmtDate(p.DateExpectedDelivery)}</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>

          {/* Date range */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            <div>
              <label style={S.label}>Date Created — From</label>
              <div style={{ position: "relative" }}>
                <input style={{ ...S.input, paddingRight: syncFilters.dateFrom ? 58 : 36 }}
                  placeholder="MM/DD/YYYY"
                  value={syncFilters.dateFrom}
                  onChange={e => {
                    let v = e.target.value.replace(/[^\d/]/g, "");
                    setSyncFilters(p => ({ ...p, dateFrom: v }));
                  }} />
                {syncFilters.dateFrom && (
                  <button onClick={() => setSyncFilters(p => ({ ...p, dateFrom: "" }))}
                    style={{ position: "absolute", right: 34, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#6B7280", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 2 }}>✕</button>
                )}
                <input type="date" style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", opacity: 0, width: 24, height: 24, cursor: "pointer" }}
                  onChange={e => {
                    if (e.target.value) {
                      const [y, m, d] = e.target.value.split("-");
                      setSyncFilters(p => ({ ...p, dateFrom: `${m}/${d}/${y}` }));
                    }
                  }} />
                <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontSize: 16, pointerEvents: "none" }}>📅</span>
              </div>
            </div>
            <div>
              <label style={S.label}>Date Created — To</label>
              <div style={{ position: "relative" }}>
                <input style={{ ...S.input, paddingRight: syncFilters.dateTo ? 58 : 36 }}
                  placeholder="MM/DD/YYYY"
                  value={syncFilters.dateTo}
                  onChange={e => {
                    let v = e.target.value.replace(/[^\d/]/g, "");
                    setSyncFilters(p => ({ ...p, dateTo: v }));
                  }} />
                {syncFilters.dateTo && (
                  <button onClick={() => setSyncFilters(p => ({ ...p, dateTo: "" }))}
                    style={{ position: "absolute", right: 34, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#6B7280", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 2 }}>✕</button>
                )}
                <input type="date" style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", opacity: 0, width: 24, height: 24, cursor: "pointer" }}
                  onChange={e => {
                    if (e.target.value) {
                      const [y, m, d] = e.target.value.split("-");
                      setSyncFilters(p => ({ ...p, dateTo: `${m}/${d}/${y}` }));
                    }
                  }} />
                <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontSize: 16, pointerEvents: "none" }}>📅</span>
              </div>
            </div>
          </div>

          {/* Status multi-select */}
          <label style={S.label}>Status (select one or more, or leave blank for all)</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
            {STATUS_OPTIONS.map(s => {
              const active = syncFilters.statuses.includes(s);
              const color  = STATUS_COLORS[s] ?? "#6B7280";
              return (
                <button key={s} onClick={() => setSyncFilters(p => ({
                  ...p,
                  statuses: active ? p.statuses.filter(x => x !== s) : [...p.statuses, s]
                }))} style={{
                  background: active ? color + "33" : "#0F172A",
                  border: `1px solid ${active ? color : "#334155"}`,
                  color: active ? color : "#9CA3AF",
                  borderRadius: 20, padding: "5px 14px", fontSize: 13,
                  cursor: "pointer", fontWeight: active ? 600 : 400,
                }}>{s}</button>
              );
            })}
          </div>

          {/* Vendor multi-select */}
          <label style={S.label}>
            Vendor (select one or more, or leave blank for all)
            {loadingVendors && <span style={{ color: "#6B7280", fontWeight: 400, marginLeft: 8 }}>Loading…</span>}
          </label>
          <input style={{ ...S.input, marginBottom: 8 }}
            placeholder="🔍 Type to search vendors…"
            value={vendorSearch}
            onChange={e => setVendorSearch(e.target.value)} />
          <div style={{ maxHeight: 160, overflowY: "auto", background: "#0F172A", borderRadius: 8, marginBottom: 8 }}>
            {!vendorSearch && filteredVendorList.length === 0 && (
              <div style={{ padding: 12, color: "#6B7280", fontSize: 13 }}>
                {allVendors.length === 0 ? "No vendors loaded yet — sync will fetch all." : "Type to search vendors."}
              </div>
            )}
            {vendorSearch && filteredVendorList.length === 0 && (
              <div style={{ padding: 12, color: "#6B7280", fontSize: 13 }}>No vendors match your search.</div>
            )}
            {(vendorSearch ? filteredVendorList : []).map(v => {
              const active = syncFilters.vendors.includes(v);
              const isManual = manualVendors.includes(v);
              return (
                <div key={v} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid #1E293B", cursor: "pointer",
                  background: active ? "#3B82F620" : "transparent" }}
                  onClick={() => setSyncFilters(p => ({
                    ...p,
                    vendors: active ? p.vendors.filter(x => x !== v) : [...p.vendors, v]
                  }))}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${active ? "#3B82F6" : "#334155"}`,
                      background: active ? "#3B82F6" : "transparent", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {active && <span style={{ color: "#fff", fontSize: 10 }}>✓</span>}
                    </div>
                    <span style={{ color: "#D1D5DB", fontSize: 13 }}>{v}</span>
                    {isManual && <span style={{ fontSize: 10, color: "#6B7280", background: "#1E293B", borderRadius: 4, padding: "1px 5px" }}>manual</span>}
                  </div>
                  {isManual && (
                    <button style={{ background: "none", border: "none", color: "#EF4444", cursor: "pointer", fontSize: 12 }}
                      onClick={e => { e.stopPropagation(); setConfirmModal({ title: "Remove Vendor", message: `Are you sure you want to remove vendor "${v}"?`, icon: "🗑", confirmText: "Remove", confirmColor: "#EF4444", onConfirm: () => removeManualVendor(v) }); }}>✕</button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Add manual vendor */}
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input style={{ ...S.input, marginBottom: 0 }} placeholder="Add vendor manually…"
              value={newManualVendor} onChange={e => setNewManualVendor(e.target.value)}
              onKeyDown={e => e.key === "Enter" && saveManualVendor()} />
            <button style={{ ...S.btnSecondary, whiteSpace: "nowrap" }} onClick={saveManualVendor}>+ Add</button>
          </div>

          {/* Sync vendors to Design Calendar */}
          <button
            style={{ ...S.btnSecondary, width: "100%", marginBottom: 16, color: "#34D399", borderColor: "#34D39944", fontSize: 12 }}
            onClick={() => setConfirmModal({
              title: "Sync Vendors → Design Calendar",
              message: `Replace all Design Calendar vendors with the ${allVendors.length} vendor${allVendors.length !== 1 ? "s" : ""} currently in PO WIP? Any existing DC vendor settings (country, lead times, etc.) will be preserved where names match. Vendors not in PO WIP will be removed.`,
              icon: "🔄",
              confirmText: "Replace",
              confirmColor: "#10B981",
              onConfirm: () => syncVendorsToDC(true, allVendors),
            })}
          >
            🔄 Sync All Vendors → Design Calendar
          </button>

          {/* Selected summary */}
          {(syncFilters.vendors.length > 0 || syncFilters.statuses.length > 0 || syncFilters.poNumbers.length > 0 || syncFilters.dateFrom || syncFilters.dateTo) && (
            <div style={{ background: "#0F172A", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 12, color: "#9CA3AF" }}>
              <strong style={{ color: "#60A5FA" }}>Will sync:</strong>
              {syncFilters.poNumbers.length > 0 && <span style={{ marginLeft: 8 }}>PO#s: <b style={{ color: "#F1F5F9" }}>{syncFilters.poNumbers.join(", ")}</b></span>}
              {syncFilters.dateFrom && <span style={{ marginLeft: 8 }}>From <b style={{ color: "#F1F5F9" }}>{syncFilters.dateFrom}</b></span>}
              {syncFilters.dateTo   && <span style={{ marginLeft: 8 }}>To <b style={{ color: "#F1F5F9" }}>{syncFilters.dateTo}</b></span>}
              {syncFilters.statuses.length > 0 && <span style={{ marginLeft: 8 }}>Status: <b style={{ color: "#F1F5F9" }}>{syncFilters.statuses.join(", ")}</b></span>}
              {syncFilters.vendors.length  > 0 && <span style={{ marginLeft: 8 }}>Vendors: <b style={{ color: "#F1F5F9" }}>{syncFilters.vendors.join(", ")}</b></span>}
            </div>
          )}

          <div style={{ display: "flex", gap: 10 }}>
            <button style={{ ...S.btnSecondary, flex: 1 }} onClick={() => { setSyncFilters({ poNumbers: [], dateFrom: "", dateTo: "", vendors: [], statuses: [] }); setPoSearch(""); }}>
              Clear Filters
            </button>
            <button style={{ ...S.btnSecondary }} onClick={() => { setShowSyncModal(false); setShowSyncLog(true); }}
              title={`${syncLog.length} sync${syncLog.length !== 1 ? "s" : ""} logged`}>
              📋 Log{syncLog.length > 0 ? ` (${syncLog.length})` : ""}
            </button>
            <button style={{ ...S.btnPrimary, flex: 2 }} onClick={() => syncFromXoro(syncFilters)}>
              🔄 {syncFilters.vendors.length === 0 && syncFilters.statuses.length === 0 && syncFilters.poNumbers.length === 0 && !syncFilters.dateFrom ? "Sync All POs" : "Sync Filtered POs"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  // ════════════════════════════════════════════════════════════════════════════
  // SYNC PROGRESS MODAL
  // ════════════════════════════════════════════════════════════════════════════
  const SyncProgressModal = () => syncing ? (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3000 }}>
      <div style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 16, padding: 32, width: 420, boxShadow: "0 32px 80px rgba(0,0,0,0.5)" }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#F1F5F9", marginBottom: 8 }}>🔄 Syncing from Xoro…</div>
        <div style={{ fontSize: 13, color: "#9CA3AF", marginBottom: 20 }}>{syncProgressMsg || "Please wait…"}</div>
        <div style={{ background: "#0F172A", borderRadius: 8, overflow: "hidden", height: 10, marginBottom: 12 }}>
          <div style={{ height: "100%", width: `${syncProgress}%`, background: "linear-gradient(90deg,#3B82F6,#8B5CF6)", borderRadius: 8, transition: "width 0.4s ease" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#6B7280" }}>
          <span>{syncProgress}%</span>
          <button onClick={cancelSync} style={{ background: "none", border: "1px solid #EF4444", color: "#EF4444", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>✕ Cancel</button>
        </div>
        {syncErr && <div style={{ color: "#EF4444", fontSize: 13, marginTop: 12 }}>{syncErr}</div>}
      </div>
    </div>
  ) : null;

  // ════════════════════════════════════════════════════════════════════════════
  // SYNC DONE MODAL
  // ════════════════════════════════════════════════════════════════════════════
  const SyncDoneModal = () => {
    const [countdown, setCountdown] = useState(4);
    useEffect(() => {
      if (!syncDone) return;
      const t = setInterval(() => setCountdown(c => c - 1), 1000);
      const close = setTimeout(() => setSyncDone(null), 4000);
      return () => { clearInterval(t); clearTimeout(close); };
    }, []);
    if (!syncDone) return null;
    const { added, changed, deleted } = syncDone;
    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3000 }}>
        <div style={{ background: "#1E293B", border: "1px solid #10B981", borderRadius: 16, padding: 32, width: 380, boxShadow: "0 32px 80px rgba(0,0,0,0.5)", textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#10B981", marginBottom: 16 }}>Sync Complete!</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 20 }}>
            {[["Added", added, "#10B981"], ["Updated", changed, "#60A5FA"], ["Removed", deleted, "#F87171"]].map(([label, count, color]) => (
              <div key={String(label)} style={{ background: "#0F172A", borderRadius: 10, padding: "12px 8px" }}>
                <div style={{ fontSize: 26, fontWeight: 800, color: color as string }}>{count as number}</div>
                <div style={{ fontSize: 12, color: "#9CA3AF", marginTop: 2 }}>{label as string}</div>
              </div>
            ))}
          </div>
          <button onClick={() => setSyncDone(null)} style={{ ...S.btnPrimary, width: "100%" }}>
            OK{countdown > 0 ? ` (${countdown})` : ""}
          </button>
        </div>
      </div>
    );
  };

  // ════════════════════════════════════════════════════════════════════════════
  // SYNC LOG MODAL
  // ════════════════════════════════════════════════════════════════════════════
  const SyncLogModal = () => {
    if (!showSyncLog) return null;
    return (
      <div style={S.modalOverlay} onClick={() => setShowSyncLog(false)}>
        <div style={{ ...S.modal, width: 620, maxHeight: "80vh", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>
          <div style={S.modalHeader}>
            <h2 style={S.modalTitle}>📋 Sync Log</h2>
            <button style={S.closeBtn} onClick={() => setShowSyncLog(false)}>✕</button>
          </div>
          <div style={{ ...S.modalBody, overflowY: "auto", flex: 1 }}>
            {syncLog.length === 0 ? (
              <div style={{ textAlign: "center", padding: "40px 0", color: "#6B7280", fontSize: 14 }}>No sync history yet</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {syncLog.map((entry, i) => {
                  const hasFilters = entry.filters && Object.values(entry.filters).some(v => v && (Array.isArray(v) ? v.length > 0 : true));
                  const posUpdated = entry.added + entry.changed + entry.deleted;
                  return (
                    <div key={i} style={{ background: "#0F172A", border: `1px solid ${entry.success ? "#1E3A5F" : "#7F1D1D"}`, borderRadius: 10, padding: "12px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                        <span style={{ fontSize: 15 }}>{entry.success ? "✅" : "❌"}</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: entry.success ? "#34D399" : "#F87171" }}>
                          {entry.success ? "Sync successful" : "Sync failed"}
                        </span>
                        <span style={{ marginLeft: "auto", fontSize: 11, color: "#6B7280" }}>
                          {new Date(entry.ts).toLocaleString()}
                        </span>
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, fontSize: 12, color: "#9CA3AF" }}>
                        <span>👤 <b style={{ color: "#CBD5E1" }}>{entry.user}</b></span>
                        {entry.success ? (
                          <>
                            <span style={{ color: posUpdated > 0 ? "#F1F5F9" : "#6B7280" }}>
                              POs updated: <b style={{ color: posUpdated > 0 ? "#60A5FA" : "#6B7280" }}>{posUpdated > 0 ? posUpdated : "none"}</b>
                            </span>
                            {entry.added > 0   && <span>➕ Added <b style={{ color: "#10B981" }}>{entry.added}</b></span>}
                            {entry.changed > 0 && <span>✏️ Changed <b style={{ color: "#60A5FA" }}>{entry.changed}</b></span>}
                            {entry.deleted > 0 && <span>🗑 Removed <b style={{ color: "#F87171" }}>{entry.deleted}</b></span>}
                          </>
                        ) : (
                          <span style={{ color: "#FCA5A5" }}>Error: {entry.error}</span>
                        )}
                      </div>
                      {hasFilters && (
                        <div style={{ marginTop: 6, fontSize: 11, color: "#475569" }}>
                          Filters: {[
                            entry.filters?.vendors?.length ? `Vendors: ${entry.filters.vendors.join(", ")}` : null,
                            entry.filters?.statuses?.length ? `Status: ${entry.filters.statuses.join(", ")}` : null,
                            entry.filters?.poNumbers?.length ? `PO#: ${entry.filters.poNumbers.join(", ")}` : null,
                            entry.filters?.dateFrom ? `From ${entry.filters.dateFrom}` : null,
                            entry.filters?.dateTo   ? `To ${entry.filters.dateTo}` : null,
                          ].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  // ════════════════════════════════════════════════════════════════════════════
  // SETTINGS MODAL
  // ════════════════════════════════════════════════════════════════════════════
  const SettingsModal = () => (
    <div style={S.modalOverlay} onClick={() => setShowSettings(false)}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={S.modalHeader}>
          <h2 style={S.modalTitle}>⚙️ Settings</h2>
          <button style={S.closeBtn} onClick={() => setShowSettings(false)}>✕</button>
        </div>
        <div style={S.modalBody}>
          <h3 style={S.settingSection}>Xoro API Credentials</h3>
          <p style={{ color: "#9CA3AF", fontSize: 13, marginBottom: 12 }}>
            API credentials are stored securely on the server via Vercel environment variables.
            They are not exposed in the browser.
          </p>

          <h3 style={{ ...S.settingSection, marginTop: 24 }}>Sync Info</h3>
          <p style={{ color: "#9CA3AF", fontSize: 13 }}>
            Last synced: {lastSync ? new Date(lastSync).toLocaleString() : "Never"}
          </p>
          <p style={{ color: "#9CA3AF", fontSize: 13, marginTop: 4 }}>
            POs loaded: {pos.length}
          </p>

          <h3 style={{ ...S.settingSection, marginTop: 24 }}>Status Colors</h3>
          {STATUS_OPTIONS.map(s => (
            <div key={s} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <div style={{ width: 12, height: 12, borderRadius: "50%", background: STATUS_COLORS[s] ?? "#6B7280" }} />
              <span style={{ color: "#E5E7EB", fontSize: 13 }}>{s}</span>
            </div>
          ))}

          <button style={{ ...S.btnPrimary, marginTop: 24 }} onClick={() => { setShowSettings(false); setShowSyncModal(true); }}>
            🔄 Sync from Xoro Now
          </button>
        </div>
      </div>
    </div>
  );

  // ════════════════════════════════════════════════════════════════════════════
  // PRINT + EXCEL EXPORT — see tanda/exportHelpers.ts
  // Wrapper to pass milestones/notes from component state
  function handleExportPOExcel(po: XoroPO, items: any[], mode: string) {
    try {
      exportPOExcel(po, items, mode, milestones, notes);
    } catch (e: any) {
      setToast("Excel export failed: " + (e.message || "Unknown error"));
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PO DETAIL PANEL
  // ════════════════════════════════════════════════════════════════════════════
  const DetailPanel = () => detailPanelExtracted({
    selected, detailMode, setDetailMode, setSelected, setView, setNewNote,
    matrixCollapsed, setMatrixCollapsed, lineItemsCollapsed, setLineItemsCollapsed,
    poInfoCollapsed, setPoInfoCollapsed, progressCollapsed, setProgressCollapsed,
    editingNote, setEditingNote, editingNoteId, setEditingNoteId, editingNoteText, setEditingNoteText, msNoteText, setMsNoteText, expandedVariants, setExpandedVariants,
    addingPhase, setAddingPhase, newPhaseForm, setNewPhaseForm, acceptedBlocked, setAcceptedBlocked,
    blockedModal, setBlockedModal, confirmModal, setConfirmModal, collapsedCats, setCollapsedCats,
    showCreateTpl, setShowCreateTpl, attachments, setAttachments, attachInputRef,
    uploadingAttachment, setUploadingAttachment, milestones, setMilestones, wipTemplates, setWipTemplates,
    dcVendors, designTemplates, notes, newNote, user, emailToken, teamsToken, msDisplayName, pos, toast, setToast,
    handleExportPOExcel, ensureMilestones, saveMilestone, saveMilestones, generateMilestones,
    regenerateMilestones, cascadeDueDateChange, vendorHasTemplate, templateVendorList,
    getVendorTemplates, saveVendorTemplates, openCategoryWithCheck, isCatBlocked,
    uploadAttachment, loadAttachments, deleteAttachment, undoDeleteAttachment, purgeExpiredAttachments,
    addNote, editNote, deleteNote, addHistory, deletePO, setSearch, setTeamsSelPO, setTeamsTab, loadDtlEmails, loadDtlFullEmail, loadDtlThread, loadDtlSentEmails,
    authenticateEmail, dtlReplyToEmail, dtlSendEmail, emailMarkAsRead, deleteMainEmail, loadEmailAttachments, emailAttachments, emailAttachmentsLoading,
    teamsLoadPOMessages, teamsStartChat,
    teamsSendMessage, teamsGraphPost, teamsGraph, loadTeamsContacts, handleTeamsContactInput,
    teamsSendDirect, sendDmReply, loadDmMessages, msSignOut, selectedNotes, selectedHistory,
    dtlEmails, dtlEmailLoading, dtlEmailErr, dtlEmailSel, dtlEmailThread, dtlThreadLoading,
    dtlEmailTab, setDtlEmailTab, dtlSentEmails, dtlSentLoading, dtlComposeTo, setDtlComposeTo,
    dtlComposeSubject, setDtlComposeSubject, dtlComposeBody, setDtlComposeBody, dtlSendErr, setDtlSendErr,
    dtlReply, setDtlReply, dtlNextLink, dtlLoadingOlder, setDtlLoadingOlder,
    teamsChannelMap, teamsMessages, setTeamsMessages, teamsLoading, teamsNewMsg, setTeamsNewMsg,
    teamsContacts, teamsContactsLoading, teamsContactsError,
    dtlDMTo, setDtlDMTo, dtlDMMsg, setDtlDMMsg, dtlDMSending, setDtlDMSending, dtlDMErr, setDtlDMErr,
    dtlDMContactSearch, setDtlDMContactSearch, dtlDMContactDropdown, setDtlDMContactDropdown,
    dtlDMContactSearchResults, setDtlDMContactSearchResults, dtlDMContactSearchLoading, setDtlDMContactSearchLoading,
    dmConversations, setDmConversations, dmActiveChatId, setDmActiveChatId, dmScrollRef,
  });

  // ════════════════════════════════════════════════════════════════════════════
  // OUTLOOK EMAIL VIEW
  // ════════════════════════════════════════════════════════════════════════════
  // ── Email data-fetching helpers (component-level so they're accessible from nav/effects) ──
  function emailGetPrefix(poNum: string) { return "[PO-" + poNum + "]"; }

  async function loadFullEmail(id: string) {
    try { const d = await emailGraph("/me/messages/" + id); setEmailSelMsg(d); } catch (e) { console.error(e); }
  }

  async function loadEmailThread(conversationId: string) {
    setEmailThreadLoading(true);
    try {
      const d = await emailGraph("/me/messages?$filter=" + encodeURIComponent("conversationId eq '" + conversationId + "'") + "&$orderby=receivedDateTime%20asc&$select=id,subject,from,receivedDateTime,body,conversationId,isRead,hasAttachments");
      setEmailThreadMsgs(d.value || []);
    } catch (e) { setEmailThreadMsgs([]); }
    setEmailThreadLoading(false);
  }

  async function loadPOEmails(poNum: string, olderUrl?: string, autoSelect?: boolean) {
    if (!msToken) return;
    const prefix = emailGetPrefix(poNum);
    if (olderUrl) { setEmailLoadingOlder(true); } else { setEmailLoadingMap(l => ({ ...l, [poNum]: true })); }
    setEmailErrorsMap(e => ({ ...e, [poNum]: null }));
    try {
      const searchTermPO = prefix.replace(/[\[\]{}()*?]/g, "").trim();
      const url = olderUrl || ("/me/mailFolders/Inbox/messages?$search=" + encodeURIComponent('"' + searchTermPO + '"') + "&$top=25&$select=id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead,hasAttachments");
      const d = await emailGraph(url);
      const items = d.value || [];
      if (olderUrl) {
        setEmailsMap(m => ({ ...m, [poNum]: [...(m[poNum] || []), ...items] }));
        setDtlEmails(m => ({ ...m, [poNum]: [...(m[poNum] || []), ...items] }));
      } else {
        setEmailsMap(m => ({ ...m, [poNum]: items }));
        setDtlEmails(m => ({ ...m, [poNum]: items }));
        if (autoSelect && items.length > 0) {
          const sorted = [...items].sort((a: any, b: any) => {
            if (!a.isRead && b.isRead) return -1;
            if (a.isRead && !b.isRead) return 1;
            return new Date(b.receivedDateTime || 0).getTime() - new Date(a.receivedDateTime || 0).getTime();
          });
          const first = sorted[0];
          setEmailSelectedId(first.id);
          setEmailSelMsg(null);
          loadFullEmail(first.id);
          if (first.conversationId) loadEmailThread(first.conversationId);
          if (first.hasAttachments) loadEmailAttachments(first.id);
        }
      }
      const nextLink = d["@odata.nextLink"] ? d["@odata.nextLink"].replace("https://graph.microsoft.com/v1.0", "") : null;
      setEmailNextLinks(nl => ({ ...nl, [poNum]: nextLink }));
      setDtlNextLink(nl => ({ ...nl, [poNum]: nextLink }));
      setEmailLastRefresh(lr => ({ ...lr, [poNum]: Date.now() }));
    } catch (e: any) { setEmailErrorsMap(err => ({ ...err, [poNum]: e.message })); }
    setEmailLoadingMap(l => ({ ...l, [poNum]: false }));
    setEmailLoadingOlder(false);
  }

  // Fetch all messages currently in the Outlook Deleted Items folder so the
  // user can review/restore/empty them. Limited to 200 most recent.
  async function loadDeletedFolder() {
    if (!msToken) return;
    emD({ type: "SET", field: "emailDeletedLoading", value: true });
    emD({ type: "SET", field: "emailDeletedError", value: null });
    try {
      const url = "/me/mailFolders/DeletedItems/messages?$top=200&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead,hasAttachments";
      const d = await emailGraph(url);
      const raw = Array.isArray(d?.value) ? d.value : [];
      const items: any[] = raw.map((m: any) => {
        const match = (m.subject || "").match(/\[PO-([^\]]+)\]/);
        return match ? { ...m, _poNumber: match[1] } : m;
      });
      emD({ type: "SET", field: "emailDeletedMessages", value: items });
    } catch (e: any) {
      emD({ type: "SET", field: "emailDeletedError", value: e?.message || "Failed to load deleted folder" });
    } finally {
      emD({ type: "SET", field: "emailDeletedLoading", value: false });
    }
  }

  // Permanently delete every message currently in Deleted Items.
  async function emptyDeletedFolder() {
    if (!msToken) return;
    // Read current deleted messages from state via the setter pattern to avoid stale closure
    let messages: any[] = [];
    setEmailDeletedMessages((cur: any[]) => { messages = cur || []; return cur; });
    if (messages.length === 0) return;
    emD({ type: "SET", field: "emailDeletedLoading", value: true });
    try {
      // Best-effort: serial deletes (Graph batch is more code than it's worth here)
      for (const m of messages) {
        try {
          const tok = await getGraphToken();
          await fetch(`https://graph.microsoft.com/v1.0/me/messages/${m.id}`, {
            method: "DELETE",
            headers: { Authorization: "Bearer " + tok },
          });
        } catch (e) {
          console.warn("emptyDeletedFolder: failed for", m.id, e);
        }
      }
      emD({ type: "SET", field: "emailDeletedMessages", value: [] });
    } finally {
      emD({ type: "SET", field: "emailDeletedLoading", value: false });
    }
  }

  // Pre-fetches a single batch of inbox messages tagged with a [PO-...] prefix,
  // groups them by PO number, and stores per-PO stats + a flat list for the
  // "All POs" / "Unread" global views. Cheaper than per-PO fetches and means
  // unread badges + counts appear without the user having to click each PO.
  async function loadAllPOEmailStats() {
    if (!msToken) return;
    emD({ type: "SET", field: "emailAllStatsLoading", value: true });
    emD({ type: "SET", field: "emailAllStatsError", value: null });
    try {
      const url = `/me/mailFolders/Inbox/messages?$search=${encodeURIComponent('"[PO-"')}&$top=500&$select=id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,conversationId`;
      const d = await emailGraph(url);
      const items: any[] = Array.isArray(d?.value) ? d.value : [];
      // Group by extracted PO number — subject must contain "[PO-...]"
      const stats: Record<string, { total: number; unread: number; latestDate: string; latestSubject: string; latestSender: string }> = {};
      const re = /\[PO-([^\]]+)\]/;
      const tagged: any[] = [];
      for (const m of items) {
        const subj = m.subject || "";
        const match = subj.match(re);
        if (!match) continue;
        const poNum = match[1];
        const dateStr = m.receivedDateTime || "";
        if (!stats[poNum]) stats[poNum] = { total: 0, unread: 0, latestDate: dateStr, latestSubject: subj, latestSender: m.from?.emailAddress?.name || m.from?.emailAddress?.address || "" };
        stats[poNum].total += 1;
        if (!m.isRead) stats[poNum].unread += 1;
        if (dateStr > stats[poNum].latestDate) {
          stats[poNum].latestDate = dateStr;
          stats[poNum].latestSubject = subj;
          stats[poNum].latestSender = m.from?.emailAddress?.name || m.from?.emailAddress?.address || "";
        }
        // Tag the message so the global views know which PO it belongs to
        tagged.push({ ...m, _poNumber: poNum });
      }
      emD({ type: "SET", field: "emailAllStats", value: stats });
      emD({ type: "SET", field: "emailAllMessages", value: tagged });
    } catch (e: any) {
      emD({ type: "SET", field: "emailAllStatsError", value: e?.message || "Failed to load email stats" });
    } finally {
      emD({ type: "SET", field: "emailAllStatsLoading", value: false });
    }
  }

  function emailViewPanel() {
    return emailViewPanelExtracted({
      em, emD, pos, setView,
      emailGraph, emailGraphPost, loadEmailAttachments, authenticateEmail,
      loadPOEmails, loadFullEmail, loadEmailThread, emailGetPrefix,
      emailMarkAsRead, deleteMainEmail, msSignOut,
      loadAllPOEmailStats,
      loadDeletedFolder, emptyDeletedFolder,
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MAIN RENDER
  // ════════════════════════════════════════════════════════════════════════════
  return (
    <div style={S.app}>
      {/* NAV */}
      <nav style={S.nav}>
        <div style={S.navLeft}>
          <div style={S.navLogo}>PO</div>
          <span style={S.navTitle}>Purchase Orders</span>
          <span style={S.navSub}>via XoroERP</span>
        </div>
        <div style={S.navRight}>
          <button style={view === "dashboard" ? S.navBtnActive : S.navBtn} onClick={() => { setSelected(null); setView("dashboard"); }}>Dashboard</button>
          <button style={view === "list"      ? S.navBtnActive : S.navBtn} onClick={() => { setSelected(null); setView("list"); }}>All POs</button>
          <button style={view === "templates" ? S.navBtnActive : S.navBtn} onClick={() => { setSelected(null); setView("templates"); }}>Templates</button>
          <button style={view === "teams" ? { ...S.navBtnActive, borderColor: TEAMS_PURPLE, color: TEAMS_PURPLE_LT } : { ...S.navBtn, color: TEAMS_PURPLE_LT }} onClick={() => { setSelected(null); setView("teams"); }}>💬 Teams</button>
          <button style={view === "email" ? S.navBtnActive : S.navBtn} onClick={() => {
            setSelected(null); setView("email");
            if (emailSelPO && msToken) {
              loadPOEmails(emailSelPO, undefined, true);
            } else if (!emailSelPO && pos.length > 0 && msToken) {
              const sorted = [...pos].sort((a: any, b: any) => {
                const ua = (emailsMap[a.PoNumber ?? ""] || []).filter((e: any) => !e.isRead).length;
                const ub = (emailsMap[b.PoNumber ?? ""] || []).filter((e: any) => !e.isRead).length;
                return ub - ua;
              });
              const firstPO = (sorted[0]?.PoNumber ?? "") as string;
              if (firstPO) { setEmailSelPO(firstPO); setEmailSelectedId(null); setEmailSelMsg(null); setEmailThreadMsgs([]); setEmailActiveFolder("inbox"); loadPOEmails(firstPO, undefined, true); }
            }
          }}>📧 Email</button>
          <button style={view === "activity" ? S.navBtnActive : S.navBtn} onClick={() => { setSelected(null); setView("activity"); }}>📋 Activity</button>
          <button style={view === "vendors" ? S.navBtnActive : S.navBtn} onClick={() => { setSelected(null); setView("vendors"); loadArchivedPOs(); }}>🏆 Vendors</button>
          <button style={view === "timeline" ? S.navBtnActive : S.navBtn} onClick={() => { if (selected) setSearch(selected.PoNumber ?? ""); setView("timeline"); }}>📊 Timeline</button>
          <button style={view === "archive" ? S.navBtnActive : S.navBtn} onClick={() => { setSelected(null); setView("archive"); loadArchivedPOs(); }}>📦 Archive{archivedPos.length > 0 ? ` (${archivedPos.length})` : ""}</button>
          <button style={S.navBtn} onClick={() => { setShowBulkUpdate(true); setBulkVendor(""); setBulkPhase(""); setBulkPhases([]); setBulkCategory(""); setBulkStatus(""); setBulkPOs([]); setBulkPOSearch(""); }}>⚡ Bulk Update</button>
          <button style={S.navBtn} onClick={() => { setShowSyncModal(true); loadVendors(); }} disabled={syncing} title="Sync POs from Xoro">
            {syncing ? "⏳ Syncing…" : "🔄 Sync"}
          </button>
          {syncing && (
            <button style={{ ...S.navBtn, color: "#EF4444", borderColor: "#EF4444" }} onClick={cancelSync} title="Cancel sync">
              ✕ Cancel
            </button>
          )}
          <button style={S.navBtn} onClick={() => setShowSettings(true)}>⚙️ Settings</button>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {user.avatar ? (
              <img src={user.avatar} alt={user.name || ""} style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
            ) : (
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: user.color ?? "#3B82F6", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{user.initials || (user.name || user.username || "?").split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2)}</div>
            )}
            <span style={{ color: "#94A3B8", fontSize: 12, fontWeight: 600 }}>{user.name || user.username}</span>
          </div>
          <button style={S.navBtn} onClick={() => window.location.href = "/"}>← PLM</button>
          <button style={S.navBtnDanger} onClick={() => { sessionStorage.removeItem("plm_user"); window.location.href = "/"; }}>Sign Out</button>
        </div>
      </nav>

      {/* SYNC ERROR MODAL */}
      {syncErr && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setSyncErr("")}>
          <div style={{ background: "#1E1A2E", border: "1.5px solid #7C3AED", borderRadius: 14, padding: "32px 36px", maxWidth: 480, width: "90%", textAlign: "center", boxShadow: "0 8px 40px rgba(0,0,0,0.5)" }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
            <div style={{ color: "#C4B5FD", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Xoro Sync Error</div>
            <div style={{ color: "#F1F5F9", fontSize: 14, lineHeight: 1.6, wordBreak: "break-word", marginBottom: 24 }}>{syncErr}</div>
            <button onClick={() => setSyncErr("")} style={{ background: "#7C3AED", color: "#fff", border: "none", borderRadius: 8, padding: "10px 32px", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Dismiss</button>
          </div>
        </div>
      )}

      <div style={S.content}>
        {/* ── DASHBOARD ── */}
        {view === "dashboard" && (
          <>
            {/* Search bar — top of dashboard, same as All POs */}
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <input
                style={{ ...S.input, flex: 1, marginBottom: 0 }}
                placeholder="🔍 Search PO#, vendor, brand, style #…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              {search && (
                <button style={S.btnSecondary} onClick={() => setSearch("")}>✕ Clear</button>
              )}
            </div>

            {/* Row 1: Production Health Score + Key Stats */}
            <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 16, marginBottom: 16 }}>
              {/* Health Score Ring */}
              {(() => {
                const active = dashMs.filter(m => m.status !== "N/A").length;
                const complete = dashMs.filter(m => m.status === "Complete").length;
                const delayed = dashMs.filter(m => m.status === "Delayed").length;
                const onTimePct = active > 0 ? Math.round(((complete) / active) * 100) : 0;
                const delayPenalty = active > 0 ? Math.round((delayed / active) * 50) : 0;
                const healthScore = Math.max(0, Math.min(100, onTimePct - delayPenalty));
                const healthColor = healthScore >= 80 ? "#10B981" : healthScore >= 60 ? "#F59E0B" : "#EF4444";
                const circumference = 2 * Math.PI * 54;
                const strokeDash = (healthScore / 100) * circumference;
                return (
                  <div style={{ background: "#1E293B", borderRadius: 12, padding: 20, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "transform 0.15s" }}
                    onClick={() => setView("timeline")}
                    onMouseEnter={e => e.currentTarget.style.transform = "translateY(-2px)"}
                    onMouseLeave={e => e.currentTarget.style.transform = "none"}>
                    <div style={{ position: "relative", width: 130, height: 130, marginBottom: 12 }}>
                      <svg width="130" height="130" viewBox="0 0 130 130">
                        <circle cx="65" cy="65" r="54" fill="none" stroke="#0F172A" strokeWidth="12" />
                        <circle cx="65" cy="65" r="54" fill="none" stroke={healthColor} strokeWidth="12" strokeLinecap="round"
                          strokeDasharray={`${strokeDash} ${circumference}`} transform="rotate(-90 65 65)" style={{ transition: "stroke-dasharray 0.5s" }} />
                      </svg>
                      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                        <span style={{ fontSize: 32, fontWeight: 800, color: healthColor, fontFamily: "monospace" }}>{healthScore}</span>
                        <span style={{ fontSize: 10, color: "#6B7280", textTransform: "uppercase", letterSpacing: 1 }}>Health</span>
                      </div>
                    </div>
                    <span style={{ fontSize: 12, color: "#94A3B8", fontWeight: 600 }}>Production Health Score</span>
                    <span style={{ fontSize: 10, color: "#6B7280", marginTop: 2 }}>{complete}/{active} complete · {delayed} delayed</span>
                  </div>
                );
              })()}

              {/* Key Stats Grid */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
                <StatCard label="Total POs" value={dashPOs.length} color="#3B82F6" icon="📋" onClick={() => setView("list")} />
                <StatCard label="Total Value" value={fmtCurrency(dashTotalValue)} color="#10B981" icon="💰" onClick={() => setView("list")} />
                <StatCard label="Overdue POs" value={dashOverduePOs} color="#EF4444" icon="⚠️" onClick={() => { setFilterStatus("All"); setView("list"); }} />
                <StatCard label="Due This Week" value={dashDueThisWeekPOs} color="#F59E0B" icon="📅" onClick={() => setView("list")} />
                <StatCard label="Overdue Milestones" value={dashOverdueMilestones.length} color="#EF4444" icon="🚨" onClick={() => setView("timeline")} />
                <StatCard label="Due This Week" value={dashDueThisWeekMilestones.length} color="#F59E0B" icon="📌" onClick={() => setView("timeline")} />
                <StatCard label="Completion Rate" value={`${dashMilestoneCompletionRate}%`} color="#10B981" icon="📊" onClick={() => setView("vendors")} />
                <StatCard label="Cascade Alerts" value={cascadeAlerts.filter(a => dashPoNums.has(a.poNum)).length} color="#F59E0B" icon="⚡" onClick={() => setView("timeline")} />
              </div>
            </div>

            {/* Row 2: Milestone Pipeline + Status Breakdown */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
              {/* Milestone Pipeline */}
              <div style={{ ...S.card, cursor: "pointer" }} onClick={() => setView("timeline")}>
                <h3 style={S.cardTitle}>Milestone Pipeline</h3>
                {(() => {
                  const active = dashMs.filter(m => m.status !== "N/A").length;
                  const statuses = [
                    { label: "Not Started", count: dashMs.filter(m => m.status === "Not Started").length, color: "#6B7280", gradLight: "#6B7280", gradDark: "#1F2937" },
                    { label: "In Progress", count: dashMs.filter(m => m.status === "In Progress").length, color: "#3B82F6", gradLight: "#93C5FD", gradDark: "#1D4ED8" },
                    { label: "Delayed", count: dashMs.filter(m => m.status === "Delayed").length, color: "#EF4444", gradLight: "#FCA5A5", gradDark: "#7F1D1D" },
                    { label: "Complete", count: dashMs.filter(m => m.status === "Complete").length, color: "#10B981", gradLight: "#6EE7B7", gradDark: "#047857" },
                  ];
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {statuses.map(s => {
                        const pct = active > 0 ? Math.round((s.count / active) * 100) : 0;
                        return (
                          <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <span style={{ width: 85, fontSize: 12, color: s.color, fontWeight: 600, textAlign: "right", flexShrink: 0 }}>{s.label}</span>
                            <div style={{ flex: 1, height: 14, borderRadius: 7, background: "#0F172A", overflow: "hidden" }}>
                              <div style={{ width: `${pct}%`, height: "100%", background: `linear-gradient(90deg, ${s.gradLight}, ${s.gradDark})`, borderRadius: 7, transition: "width 0.3s", minWidth: s.count > 0 ? 6 : 0 }} />
                            </div>
                            <span style={{ width: 60, fontSize: 12, color: "#94A3B8", fontFamily: "monospace", flexShrink: 0 }}>{s.count} ({pct}%)</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>

              {/* Category Progress */}
              <div style={{ ...S.card, cursor: "pointer" }} onClick={() => setView("timeline")}>
                <h3 style={S.cardTitle}>Progress by Category</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {WIP_CATEGORIES.map(cat => {
                    const catMs = dashMs.filter(m => m.category === cat && m.status !== "N/A");
                    const catDone = catMs.filter(m => m.status === "Complete").length;
                    const catDelayed = catMs.filter(m => m.status === "Delayed").length;
                    const pct = catMs.length > 0 ? Math.round((catDone / catMs.length) * 100) : 0;
                    const color = pct === 100 ? "#10B981" : catDelayed > 0 ? "#EF4444" : pct > 0 ? "#3B82F6" : "#6B7280";
                    return (
                      <div key={cat} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ width: 100, fontSize: 12, color: "#D1D5DB", fontWeight: 600, flexShrink: 0 }}>{cat}</span>
                        <div style={{ flex: 1, height: 12, borderRadius: 6, background: "#0F172A", overflow: "hidden" }}>
                          <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 6, transition: "width 0.3s" }} />
                        </div>
                        <span style={{ width: 70, fontSize: 11, color: "#94A3B8", fontFamily: "monospace", flexShrink: 0, textAlign: "right" }}>{catDone}/{catMs.length}</span>
                        {catDelayed > 0 && <span style={{ fontSize: 10, color: "#EF4444", fontWeight: 600, flexShrink: 0 }}>⚠{catDelayed}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Row 3: PO Status + Top Vendors */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
              {/* PO Status */}
              <div style={S.card}>
                <h3 style={S.cardTitle}>POs by Status</h3>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {STATUS_OPTIONS.map(s => {
                    const count = dashPOs.filter((p: XoroPO) => p.StatusName === s).length;
                    if (!count) return null;
                    const color = STATUS_COLORS[s] ?? "#6B7280";
                    return (
                      <div key={s} style={{ ...S.statusChip, background: color + "22", border: `1px solid ${color}44`, cursor: "pointer" }}
                        onClick={() => { setFilterStatus(s); setView("list"); }}>
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
                        <span style={{ color, fontWeight: 600 }}>{count}</span>
                        <span style={{ color: "#9CA3AF" }}>{s}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Top Vendors */}
              <div style={S.card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <h3 style={{ ...S.cardTitle, margin: 0 }}>Top Vendors</h3>
                  <button style={{ ...S.btnSecondary, fontSize: 10, padding: "4px 10px" }} onClick={() => setView("vendors")}>View All →</button>
                </div>
                {(() => {
                  const vendorNames = [...new Set(dashPOs.map((p: XoroPO) => p.VendorName ?? "").filter(Boolean))];
                  const vendorData = vendorNames.map(v => {
                    const vPOs = dashPOs.filter((p: XoroPO) => (p.VendorName ?? "") === v);
                    const vMs = vPOs.flatMap(p => milestones[p.PoNumber ?? ""] || []).filter(m => m.status !== "N/A");
                    const done = vMs.filter(m => m.status === "Complete");
                    let onTime = 0;
                    done.forEach(m => { const d = m.status_date || m.status_dates?.["Complete"]; if (d && m.expected_date && d <= m.expected_date) onTime++; else onTime++; });
                    const pct = done.length > 0 ? Math.round((onTime / done.length) * 100) : 0;
                    return { vendor: v, poCount: vPOs.length, msTotal: vMs.length, done: done.length, pct };
                  }).filter(v => v.msTotal > 0).sort((a, b) => b.pct - a.pct).slice(0, 5);
                  return vendorData.length === 0 ? (
                    <div style={{ color: "#6B7280", fontSize: 13, textAlign: "center", padding: 16 }}>No milestone data yet</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {vendorData.map(v => {
                        const pctColor = v.pct >= 90 ? "#10B981" : v.pct >= 70 ? "#F59E0B" : "#EF4444";
                        return (
                          <div key={v.vendor} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => { setSearch(v.vendor); setView("list"); }}>
                            <span style={{ flex: 1, fontSize: 13, color: "#D1D5DB", fontWeight: 600 }}>{v.vendor}</span>
                            <span style={{ fontSize: 11, color: "#6B7280" }}>{v.poCount} POs</span>
                            <div style={{ width: 50, height: 6, borderRadius: 3, background: "#0F172A", overflow: "hidden" }}>
                              <div style={{ width: `${v.pct}%`, height: "100%", background: pctColor, borderRadius: 3 }} />
                            </div>
                            <span style={{ fontSize: 12, fontWeight: 700, color: pctColor, fontFamily: "monospace", width: 36, textAlign: "right" }}>{v.pct}%</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Row 4: Cascade Alerts (if any) */}
            {cascadeAlerts.filter(a => dashPoNums.has(a.poNum)).length > 0 && (
              <div style={{ ...S.card, marginBottom: 16, borderLeft: "3px solid #F59E0B" }}>
                <h3 style={{ ...S.cardTitle, color: "#F59E0B" }}>⚠ Cascade Alerts — {cascadeAlerts.length} Blocked</h3>
                <div style={{ fontSize: 12 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "110px 1fr 120px 120px 70px", padding: "8px 12px", background: "#0F172A", borderRadius: "8px 8px 0 0", gap: 8 }}>
                    <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>PO #</span>
                    <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>Vendor</span>
                    <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>Blocked</span>
                    <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>Delayed By</span>
                    <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "right" }}>Days Late</span>
                  </div>
                  {cascadeAlerts.filter(a => dashPoNums.has(a.poNum)).sort((a, b) => b.daysLate - a.daysLate).slice(0, 10).map((a, i) => (
                    <div key={i} style={{ display: "grid", gridTemplateColumns: "110px 1fr 120px 120px 70px", padding: "8px 12px", borderTop: "1px solid #1E293B", gap: 8, cursor: "pointer", background: "#0F172A" }}
                      onClick={() => { const p = pos.find(x => x.PoNumber === a.poNum); if (p) openCategoryWithCheck(a.poNum, a.blockedCat, p); }}>
                      <span style={{ color: "#60A5FA", fontFamily: "monospace", fontSize: 11 }}>{a.poNum}</span>
                      <span style={{ color: "#D1D5DB" }}>{a.vendor}</span>
                      <span style={{ color: "#F59E0B", fontWeight: 600 }}>{a.blockedCat}</span>
                      <span style={{ color: "#EF4444" }}>{a.delayedCat}</span>
                      <span style={{ color: "#EF4444", fontWeight: 700, textAlign: "right" }}>{a.daysLate}d</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Row 5: Upcoming + Overdue side by side */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
              {/* Upcoming */}
              <div style={S.card}>
                <h3 style={S.cardTitle}>Upcoming Milestones</h3>
                {dashUpcomingMilestones.length === 0 ? (
                  <div style={{ color: "#6B7280", fontSize: 13, textAlign: "center", padding: 16 }}>No upcoming milestones</div>
                ) : (
                  <div style={{ fontSize: 12 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "100px 1fr 80px 60px", padding: "6px 10px", color: "#6B7280", fontWeight: 600, borderBottom: "1px solid #334155", textTransform: "uppercase", letterSpacing: 1, fontSize: 9 }}>
                      <span>PO #</span><span>Phase</span><span>Due</span><span style={{ textAlign: "right" }}>Days</span>
                    </div>
                    {dashUpcomingMilestones.slice(0, 10).map(m => {
                      const daysRem = m.expected_date ? Math.ceil((new Date(m.expected_date).getTime() - Date.now()) / 86400000) : null;
                      return (
                        <div key={m.id} style={{ display: "grid", gridTemplateColumns: "100px 1fr 80px 60px", padding: "6px 10px", borderBottom: "1px solid #1E293B", cursor: "pointer", alignItems: "center" }}
                          onClick={() => { const p = pos.find(x => x.PoNumber === m.po_number); if (p) { setDetailMode("milestones"); setNewNote(""); setSearch(""); setSelected(p); } }}>
                          <span style={{ color: "#60A5FA", fontFamily: "monospace", fontSize: 10 }}>{m.po_number}</span>
                          <span style={{ color: "#D1D5DB", fontSize: 11 }}>{m.phase}</span>
                          <span style={{ color: "#9CA3AF", fontSize: 10 }}>{fmtDate(m.expected_date ?? undefined)}</span>
                          <span style={{ color: daysRem !== null && daysRem <= 3 ? "#F59E0B" : "#10B981", fontWeight: 600, textAlign: "right", fontSize: 11 }}>{daysRem !== null ? `${daysRem}d` : "—"}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Overdue */}
              <div style={{ ...S.card, borderLeft: dashOverdueMilestones.length > 0 ? "3px solid #EF4444" : undefined }}>
                <h3 style={{ ...S.cardTitle, color: dashOverdueMilestones.length > 0 ? "#EF4444" : undefined }}>Overdue Milestones ({dashOverdueMilestones.length})</h3>
                {dashOverdueMilestones.length === 0 ? (
                  <div style={{ color: "#10B981", fontSize: 13, textAlign: "center", padding: 16 }}>✓ No overdue milestones</div>
                ) : (
                  <div style={{ fontSize: 12 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "100px 1fr 80px 60px", padding: "6px 10px", color: "#6B7280", fontWeight: 600, borderBottom: "1px solid #334155", textTransform: "uppercase", letterSpacing: 1, fontSize: 9 }}>
                      <span>PO #</span><span>Phase</span><span>Due</span><span style={{ textAlign: "right" }}>Late</span>
                    </div>
                    {dashOverdueMilestones.sort((a, b) => (a.expected_date ?? "").localeCompare(b.expected_date ?? "")).slice(0, 10).map(m => {
                      const daysLate = m.expected_date ? Math.abs(Math.ceil((new Date(m.expected_date).getTime() - Date.now()) / 86400000)) : 0;
                      return (
                        <div key={m.id} style={{ display: "grid", gridTemplateColumns: "100px 1fr 80px 60px", padding: "6px 10px", borderBottom: "1px solid #1E293B", cursor: "pointer", alignItems: "center" }}
                          onClick={() => { const p = pos.find(x => x.PoNumber === m.po_number); if (p) { setDetailMode("milestones"); setNewNote(""); setSearch(""); setSelected(p); } }}>
                          <span style={{ color: "#60A5FA", fontFamily: "monospace", fontSize: 10 }}>{m.po_number}</span>
                          <span style={{ color: "#D1D5DB", fontSize: 11 }}>{m.phase}</span>
                          <span style={{ color: "#9CA3AF", fontSize: 10 }}>{fmtDate(m.expected_date ?? undefined)}</span>
                          <span style={{ color: "#EF4444", fontWeight: 700, textAlign: "right", fontSize: 11 }}>{daysLate}d</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Row 6: Recent POs / Search Results */}
            <div style={S.card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <h3 style={{ ...S.cardTitle, marginBottom: 0 }}>
                  {search ? `Search Results (${filtered.length})` : "Recent Purchase Orders"}
                </h3>
                {!search && (
                  <button style={S.btnSecondary} onClick={() => setView("list")}>View All →</button>
                )}
              </div>
              {loading && <p style={{ color: "#6B7280" }}>Loading…</p>}
              {!loading && pos.length === 0 && (
                <div style={S.emptyState}>
                  <p>No purchase orders loaded.</p>
                  <button style={S.btnPrimary} onClick={() => { setShowSyncModal(true); loadVendors(); }} disabled={syncing}>
                    {syncing ? "Syncing…" : "🔄 Sync from Xoro"}
                  </button>
                </div>
              )}
              {search ? (
                filtered.length === 0
                  ? <p style={{ color: "#6B7280", fontSize: 13 }}>No POs match "{search}"</p>
                  : filtered.map((po, i) => <PORow key={i} po={po} onClick={() => { setDetailMode("milestones"); setNewNote(""); setSelected(po); }} detailed />)
              ) : (
                pos.slice(0, 8).map((po, i) => <PORow key={i} po={po} onClick={() => { setDetailMode("milestones"); setNewNote(""); setSelected(po); }} />)
              )}
            </div>
          </>
        )}

        {/* ── ALL POs ── */}
        {view === "list" && (
          <div style={{ maxWidth: 1100, margin: "0 auto" }}>
            <div style={S.filters}>
              <input style={{ ...S.input, flex: 1, marginBottom: 0 }} placeholder="🔍 Search PO#, vendor, brand, style #, memo…"
                value={search} onChange={e => setSearch(e.target.value)} />
              <select style={{ ...S.select, width: 160 }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                <option value="All">All PO Statuses</option>
                {STATUS_OPTIONS.map(s => <option key={s}>{s}</option>)}
              </select>
              <select style={{ ...S.select, width: 180 }} value={filterVendor} onChange={e => setFilterVendor(e.target.value)}>
                {vendors.map(v => <option key={v} value={v}>{v === "All" ? "All Vendors" : v}</option>)}
              </select>
              <select
                style={{ ...S.select, width: 150 }}
                value={sortBy}
                onChange={e => setSortBy(e.target.value as "ddp" | "po_date" | "status")}
                title="Sort by"
              >
                <option value="ddp">Sort by DDP date</option>
                <option value="po_date">Sort by PO date</option>
                <option value="status">Sort by Status</option>
              </select>
              <button
                style={{ ...S.btnSecondary, minWidth: 130 }}
                onClick={() => setSortDir(d => d === "asc" ? "desc" : "asc")}
                title="Toggle sort direction"
              >
                {sortBy === "status"
                  ? (sortDir === "asc" ? "↓ Delayed first" : "↑ Completed first")
                  : (sortDir === "asc" ? "↓ Oldest first" : "↑ Newest first")}
              </button>
              <button style={S.btnSecondary} onClick={() => { setSearch(""); setFilterStatus("All"); setFilterVendor("All"); setSortBy("ddp"); setSortDir("asc"); }}>
                Clear
              </button>
            </div>
            <div style={S.card}>
              <div style={{ marginBottom: 12, color: "#9CA3AF", fontSize: 13 }}>
                Showing {filtered.length} of {pos.length} purchase orders
                {lastSync && <span style={{ marginLeft: 12 }}>· Last synced: {new Date(lastSync).toLocaleString()}</span>}
              </div>
              {loading && <p style={{ color: "#6B7280" }}>Loading…</p>}
              {!loading && filtered.length === 0 && (
                <div style={S.emptyState}>
                  <p>{pos.length === 0 ? "No POs loaded. Click Sync to fetch from Xoro." : "No POs match your filters."}</p>
                  {pos.length === 0 && <button style={S.btnPrimary} onClick={() => { setShowSyncModal(true); loadVendors(); }} disabled={syncing}>🔄 Sync from Xoro</button>}
                </div>
              )}
              {filtered.map((po, i) => <PORow key={i} po={po} onClick={() => { setDetailMode("milestones"); setNewNote(""); setSearch(""); setSelected(po); }} detailed />)}
            </div>
          </div>
        )}

        {/* ── TEMPLATES ── */}
        {view === "templates" && (() => {
          const isAdmin = user?.role === "admin";
          const [tplTab, setTplTab_] = [
            (window as any).__tplTab ?? "production",
            (v: string) => { (window as any).__tplTab = v; setWipTemplates({ ...wipTemplates }); }
          ];
          const vendorKeys = templateVendorList();
          // All unique vendors from POs (for adding new vendor templates)
          const poVendors = [...new Set(pos.map(p => p.VendorName ?? "").filter(Boolean))].sort();
          const vendorsWithoutTemplate = poVendors.filter(v => !vendorHasTemplate(v));
          const currentTemplates = getVendorTemplates(tplVendor === "__default__" ? undefined : tplVendor);
          // Derive local editing state — keyed by vendor so switching resets automatically
          const localTpl: WipTemplate[] = (tplLocalEdits?.vendor === tplVendor ? tplLocalEdits.edits : currentTemplates) ?? [];
          const tplDirty = tplLocalEdits?.vendor === tplVendor;
          const activeTplUndo = tplDirty ? tplUndoStack : [];
          function tplPushState(newEdits: WipTemplate[]) {
            setTplUndoStack(s => [...(tplDirty ? s : []), localTpl]);
            setTplLocalEdits({ vendor: tplVendor, edits: newEdits });
          }
          function tplUpdate(i: number, field: string, value: any) {
            const arr = [...localTpl]; arr[i] = { ...arr[i], [field]: value }; tplPushState(arr);
          }
          function tplUndo() {
            if (!activeTplUndo.length) return;
            const prev = activeTplUndo[activeTplUndo.length - 1];
            setTplUndoStack(s => s.slice(0, -1));
            setTplLocalEdits({ vendor: tplVendor, edits: prev });
          }
          function tplSave() {
            saveVendorTemplates(tplVendor, localTpl);
            setTplLocalEdits(null); setTplUndoStack([]);
          }
          const [showNewVendor, setShowNewVendor_] = [
            (window as any).__showNewVendor ?? false,
            (v: boolean) => { (window as any).__showNewVendor = v; setWipTemplates({ ...wipTemplates }); }
          ];

          return (
            <>
              <div style={S.card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <h3 style={S.cardTitle}>Production Templates</h3>
                </div>

                {/* Vendor selector */}
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16 }}>
                  <span style={{ color: "#94A3B8", fontSize: 13 }}>Vendor:</span>
                  <select style={{ ...S.select, flex: 1, maxWidth: 300 }} value={tplVendor} onChange={e => setTplVendor(e.target.value)}>
                    <option value="__default__">Default Template</option>
                    {vendorKeys.map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                  {isAdmin && (
                    <button style={{ ...S.btnSecondary, fontSize: 12, padding: "6px 12px" }} onClick={() => setShowNewVendor_(true)}>
                      + New Vendor Template
                    </button>
                  )}
                  {isAdmin && tplVendor !== "__default__" && (
                    <button style={{ ...S.btnSecondary, fontSize: 12, padding: "6px 12px", borderColor: "#EF4444", color: "#EF4444" }}
                      onClick={() => setConfirmModal({ title: "Delete Template", message: `Delete template for "${tplVendor}"? POs will fall back to default template.`, icon: "🗑", confirmText: "Delete", confirmColor: "#EF4444", onConfirm: () => { deleteVendorTemplate(tplVendor); setTplVendor("__default__"); } })}>
                      Delete Template
                    </button>
                  )}
                </div>

                {/* New vendor template creation */}
                {showNewVendor && isAdmin && (
                  <div style={{ background: "#0F172A", borderRadius: 8, padding: 16, marginBottom: 16 }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
                      <span style={{ color: "#94A3B8", fontSize: 12 }}>Vendor:</span>
                      <select style={{ ...S.select, flex: 1 }} id="newTplVendor">
                        {vendorsWithoutTemplate.length > 0
                          ? vendorsWithoutTemplate.map(v => <option key={v} value={v}>{v}</option>)
                          : <option value="">All vendors have templates</option>
                        }
                      </select>
                    </div>
                    <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
                      <span style={{ color: "#94A3B8", fontSize: 12 }}>Copy from:</span>
                      <select style={{ ...S.select, flex: 1 }} id="copyFromVendor">
                        <option value="__default__">Default Template</option>
                        {vendorKeys.map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </div>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button style={S.btnSecondary} onClick={() => setShowNewVendor_(false)}>Cancel</button>
                      <button style={{ ...S.btnPrimary, width: "auto", padding: "8px 16px" }} onClick={() => {
                        const vendorEl = document.getElementById("newTplVendor") as HTMLSelectElement;
                        const copyEl = document.getElementById("copyFromVendor") as HTMLSelectElement;
                        const vendorName = vendorEl?.value;
                        const copyFrom = copyEl?.value || "__default__";
                        if (!vendorName) return;
                        const source = getVendorTemplates(copyFrom === "__default__" ? undefined : copyFrom);
                        const newTpls = source.map(t => ({ ...t, id: milestoneUid() }));
                        saveVendorTemplates(vendorName, newTpls);
                        setTplVendor(vendorName);
                        setShowNewVendor_(false);
                      }}>Create Template</button>
                    </div>
                  </div>
                )}

                {/* Template label */}
                <div style={{ marginBottom: 12, fontSize: 12, color: "#6B7280" }}>
                  {tplVendor === "__default__"
                    ? "Default template used for vendors without a custom template."
                    : `Custom production template for ${tplVendor}.`}
                </div>

                {/* Template table */}
                {!isAdmin && <p style={{ color: "#F59E0B", fontSize: 12, marginBottom: 12 }}>View only — admin access required to edit.</p>}
                {isAdmin && (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                    <button
                      disabled={!activeTplUndo.length}
                      onClick={tplUndo}
                      style={{ background: "none", border: "1px solid #334155", color: activeTplUndo.length ? "#94A3B8" : "#334155", borderRadius: 6, cursor: activeTplUndo.length ? "pointer" : "default", padding: "5px 12px", fontSize: 12 }}
                    >↩ Undo</button>
                    <button
                      disabled={!tplDirty}
                      onClick={tplSave}
                      style={{ background: tplDirty ? "#2563EB" : "#1E293B", border: "none", color: tplDirty ? "#fff" : "#475569", borderRadius: 6, cursor: tplDirty ? "pointer" : "default", padding: "5px 14px", fontSize: 12, fontWeight: 600 }}
                    >Save</button>
                    {tplDirty && <span style={{ color: "#F59E0B", fontSize: 11 }}>Unsaved changes</span>}
                  </div>
                )}
                <div style={{ border: "1px solid #334155", borderRadius: 8, overflow: "hidden" }}>
                  <div style={{ display: "grid", gridTemplateColumns: (isAdmin ? "22px " : "") + "32px 1fr 140px 110px 90px" + (isAdmin ? " 40px" : ""), padding: "8px 14px", background: "#0F172A", color: "#6B7280", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>
                    {isAdmin && <span />}
                    <span>#</span><span>Phase</span><span>Category</span><span style={{ textAlign: "center" }}>Days Before DDP</span><span style={{ textAlign: "center" }}>Status</span>
                    {isAdmin && <span />}
                  </div>
                  {localTpl.map((tpl, i) => {
                    const isDragging = tplDragIdx === i;
                    const isDropTarget = tplDragOverIdx === i && tplDragIdx !== null && tplDragIdx !== i;
                    const isAbove = tplDragIdx !== null && tplDragIdx < i;
                    return (
                    <div
                      key={tpl.id}
                      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (tplDragIdx !== null && tplDragIdx !== i) setTplDragOverIdx(i); }}
                      onDragLeave={() => { if (tplDragOverIdx === i) setTplDragOverIdx(null); }}
                      onDrop={e => {
                        e.preventDefault();
                        const from = parseInt(e.dataTransfer.getData("text/plain"));
                        if (!isNaN(from) && from !== i) {
                          const arr = [...localTpl];
                          const [moved] = arr.splice(from, 1);
                          arr.splice(i, 0, moved);
                          tplPushState(arr);
                        }
                        setTplDragIdx(null); setTplDragOverIdx(null);
                      }}
                      style={{
                        display: "grid",
                        gridTemplateColumns: (isAdmin ? "22px " : "") + "32px 1fr 140px 110px 90px" + (isAdmin ? " 40px" : ""),
                        padding: "8px 14px",
                        fontSize: 13,
                        alignItems: "center",
                        opacity: isDragging ? 0.3 : 1,
                        transform: isDragging ? "scale(0.97)" : isDropTarget ? `translateY(${isAbove ? "4px" : "-4px"})` : "none",
                        transition: "all 0.2s cubic-bezier(0.2, 0, 0, 1)",
                        background: isDropTarget ? "rgba(59, 130, 246, 0.08)" : isDragging ? "rgba(59, 130, 246, 0.04)" : "transparent",
                        borderTop: isDropTarget && isAbove ? "3px solid #3B82F6" : "1px solid #1E293B",
                        borderBottom: isDropTarget && !isAbove ? "3px solid #3B82F6" : "none",
                        borderRadius: isDropTarget ? 4 : 0,
                        boxShadow: isDragging ? "0 4px 16px rgba(59, 130, 246, 0.15)" : "none",
                        position: "relative" as const,
                        zIndex: isDragging ? 10 : isDropTarget ? 5 : 1,
                      }}
                    >
                      {isAdmin && (
                        <span
                          draggable
                          onDragStart={e => { setTplDragIdx(i); e.dataTransfer.setData("text/plain", String(i)); e.dataTransfer.effectAllowed = "move"; (e.target as HTMLElement).style.cursor = "grabbing"; }}
                          onDragEnd={() => { setTplDragIdx(null); setTplDragOverIdx(null); }}
                          style={{ cursor: isDragging ? "grabbing" : "grab", color: isDragging ? "#3B82F6" : "#475569", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, userSelect: "none", transition: "color 0.15s, transform 0.15s", transform: isDragging ? "scale(1.2)" : "none" }}
                        >⠿</span>
                      )}
                      <span style={{ color: "#6B7280", fontSize: 11 }}>{i + 1}</span>
                      {isAdmin ? (
                        <input style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 4, color: "#D1D5DB", fontSize: 13, padding: "3px 8px", width: "100%", outline: "none", boxSizing: "border-box" }}
                          value={tpl.phase} onChange={e => tplUpdate(i, "phase", e.target.value)} />
                      ) : <span style={{ color: "#D1D5DB" }}>{tpl.phase}</span>}
                      {isAdmin ? (
                        <select style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 4, color: "#9CA3AF", fontSize: 12, padding: "3px 4px" }}
                          value={tpl.category} onChange={e => tplUpdate(i, "category", e.target.value)}>
                          {WIP_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      ) : <span style={{ color: "#9CA3AF", fontSize: 12 }}>{tpl.category}</span>}
                      {isAdmin ? (
                        <input
                          type="text" inputMode="numeric" pattern="[0-9]*"
                          style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 4, color: "#9CA3AF", fontSize: 13, padding: "3px 8px", textAlign: "center", width: "100%", outline: "none", boxSizing: "border-box" }}
                          value={tpl.daysBeforeDDP}
                          onClick={e => (e.target as HTMLInputElement).select()}
                          onChange={e => { const v = e.target.value.replace(/[^0-9]/g, ""); tplUpdate(i, "daysBeforeDDP", v === "" ? 0 : parseInt(v)); }}
                        />
                      ) : <span style={{ color: "#9CA3AF", textAlign: "center" }}>{tpl.daysBeforeDDP}</span>}
                      {isAdmin ? (
                        <select style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 4, color: MILESTONE_STATUS_COLORS[tpl.status] || "#6B7280", fontSize: 11, padding: "3px 4px" }}
                          value={tpl.status} onChange={e => tplUpdate(i, "status", e.target.value)}>
                          {MILESTONE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      ) : <span style={{ color: MILESTONE_STATUS_COLORS[tpl.status] || "#6B7280", textAlign: "center", fontSize: 11 }}>{tpl.status}</span>}
                      {isAdmin && (
                        <div style={{ display: "flex", justifyContent: "center" }}>
                          <button style={{ background: "none", border: "1px solid #EF4444", color: "#EF4444", borderRadius: 4, cursor: "pointer", padding: "2px 6px", fontSize: 10 }}
                            onClick={() => setConfirmModal({ title: "Delete Phase", message: `Delete "${tpl.phase}" from this template?`, icon: "🗑", confirmText: "Delete", confirmColor: "#EF4444", onConfirm: () => { const arr = localTpl.filter(t => t.id !== tpl.id); tplPushState(arr); } })}>✕</button>
                        </div>
                      )}
                    </div>
                  );
                  })}
                  {localTpl.length === 0 && <div style={{ padding: 20, textAlign: "center", color: "#6B7280", fontSize: 13 }}>No phases defined.</div>}
                </div>
                {isAdmin && (
                  <WipTemplateEditor templates={localTpl} onSave={t => tplPushState(t)} />
                )}
              </div>
            </>
          );
        })()}

        {/* ── TEAMS ── */}
        {view === "teams" && teamsViewPanel()}

        {/* ── EMAIL ── */}
        {view === "email" && emailViewPanel()}

        {/* ── ACTIVITY ── */}
        {view === "activity" && (() => {
          const historyEntries = notes.filter(n => n.status_override === "__history__").sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "")).slice(0, 100);
          return (
            <div style={{ maxWidth: "50%", margin: "0 auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h2 style={{ margin: 0, color: "#F1F5F9", fontSize: 20, fontWeight: 700 }}>Activity Feed</h2>
                <span style={{ color: "#6B7280", fontSize: 12 }}>{historyEntries.length} recent activities</span>
              </div>
              <div style={{ background: "#1E293B", borderRadius: 12, border: "1px solid #334155", overflow: "hidden" }}>
                {historyEntries.length === 0 ? (
                  <div style={{ padding: 40, textAlign: "center", color: "#6B7280" }}>No activity recorded yet</div>
                ) : historyEntries.map((entry, i) => {
                  const isStatus = (entry.note ?? "").includes("Status:");
                  const isBulk = (entry.note ?? "").includes("Bulk update");
                  const isSync = (entry.note ?? "").includes("synced");
                  const isGen = (entry.note ?? "").includes("generated") || (entry.note ?? "").includes("Regenerated");
                  const icon = isBulk ? "⚡" : isSync ? "🔄" : isGen ? "🏭" : isStatus ? "📊" : "📝";
                  const time = entry.created_at ? new Date(entry.created_at).toLocaleString() : "";
                  const timeAgo = entry.created_at ? (() => { const ms = Date.now() - new Date(entry.created_at).getTime(); const m = Math.floor(ms / 60000); if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`; return `${Math.floor(h / 24)}d ago`; })() : "";
                  return (
                    <div key={entry.id || i} style={{ display: "flex", gap: 12, padding: "14px 18px", borderBottom: "1px solid #0F172A", background: i % 2 === 0 ? "#1E293B" : "#1A2332", cursor: "pointer" }}
                      onClick={() => { const p = pos.find(x => x.PoNumber === entry.po_number); if (p) { setDetailMode("milestones"); setNewNote(""); setSearch(""); setSelected(p); setView("list"); } }}>
                      <div style={{ fontSize: 18, flexShrink: 0, width: 32, textAlign: "center" }}>{icon}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                          <span style={{ fontSize: 14, fontWeight: 700, color: "#60A5FA", fontFamily: "monospace" }}>{entry.po_number}</span>
                          <span style={{ fontSize: 12, color: "#94A3B8" }}>{entry.user_name}</span>
                          <span style={{ fontSize: 13, color: "#6B7280", marginLeft: "auto", flexShrink: 0, fontFamily: "monospace" }}>{timeAgo} · {time}</span>
                        </div>
                        <div style={{ fontSize: 14, color: "#D1D5DB", lineHeight: 1.5 }}>{entry.note}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* ── VENDORS ── */}
        {view === "vendors" && (() => {
          // Include both active + archived POs for complete vendor performance history
          const allPOsForVendors = [...pos, ...archivedPos];
          const vendorStats: { vendor: string; totalMs: number; completed: number; onTime: number; late: number; avgDaysLate: number; poCount: number }[] = [];
          const vendorNames = [...new Set(allPOsForVendors.map(p => p.VendorName ?? "").filter(Boolean))].sort();
          vendorNames.forEach(vendor => {
            const vPOs = allPOsForVendors.filter(p => (p.VendorName ?? "") === vendor);
            const vMs = vPOs.flatMap(p => milestones[p.PoNumber ?? ""] || []).filter(m => m.status !== "N/A");
            const completed = vMs.filter(m => m.status === "Complete");
            let onTime = 0, late = 0, totalDaysLate = 0;
            completed.forEach(m => {
              const done = m.status_date || m.status_dates?.["Complete"];
              if (done && m.expected_date) {
                if (done <= m.expected_date) onTime++;
                else { late++; totalDaysLate += Math.ceil((new Date(done).getTime() - new Date(m.expected_date).getTime()) / 86400000); }
              } else { onTime++; }
            });
            if (vMs.length > 0) vendorStats.push({ vendor, totalMs: vMs.length, completed: completed.length, onTime, late, avgDaysLate: late > 0 ? Math.round(totalDaysLate / late) : 0, poCount: vPOs.length });
          });
          vendorStats.sort((a, b) => { const aPct = a.completed > 0 ? a.onTime / a.completed : 0; const bPct = b.completed > 0 ? b.onTime / b.completed : 0; return bPct - aPct; });

          return (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h2 style={{ margin: 0, color: "#F1F5F9", fontSize: 20, fontWeight: 700 }}>Vendor Scorecard</h2>
                <span style={{ color: "#6B7280", fontSize: 12 }}>{vendorStats.length} vendors</span>
              </div>
              <div style={{ background: "#1E293B", borderRadius: 12, border: "1px solid #334155", overflow: "hidden" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 80px 80px 80px 90px 100px", gap: 8, padding: "12px 16px", background: "#0F172A", borderBottom: "1px solid #334155" }}>
                  <span style={{ color: "#6B7280", fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>Vendor</span>
                  <span style={{ color: "#6B7280", fontSize: 11, fontWeight: 700, textTransform: "uppercase", textAlign: "center" }}>POs</span>
                  <span style={{ color: "#6B7280", fontSize: 11, fontWeight: 700, textTransform: "uppercase", textAlign: "center" }}>Milestones</span>
                  <span style={{ color: "#6B7280", fontSize: 11, fontWeight: 700, textTransform: "uppercase", textAlign: "center" }}>On Time</span>
                  <span style={{ color: "#6B7280", fontSize: 11, fontWeight: 700, textTransform: "uppercase", textAlign: "center" }}>Late</span>
                  <span style={{ color: "#6B7280", fontSize: 11, fontWeight: 700, textTransform: "uppercase", textAlign: "center" }}>Avg Late</span>
                  <span style={{ color: "#6B7280", fontSize: 11, fontWeight: 700, textTransform: "uppercase", textAlign: "center" }}>On-Time %</span>
                </div>
                {vendorStats.length === 0 ? (
                  <div style={{ padding: 40, textAlign: "center", color: "#6B7280" }}>No milestone data yet</div>
                ) : vendorStats.map((v, i) => {
                  const pct = v.completed > 0 ? Math.round((v.onTime / v.completed) * 100) : 0;
                  const pctColor = pct >= 90 ? "#10B981" : pct >= 70 ? "#F59E0B" : "#EF4444";
                  return (
                    <div key={v.vendor} style={{ display: "grid", gridTemplateColumns: "1fr 80px 80px 80px 80px 90px 100px", gap: 8, padding: "12px 16px", borderBottom: "1px solid #0F172A", background: i % 2 === 0 ? "#1E293B" : "#1A2332", cursor: "pointer" }}
                      onClick={() => { setSearch(v.vendor); setView("list"); }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: "#F1F5F9" }}>{v.vendor}</div>
                      </div>
                      <span style={{ textAlign: "center", color: "#94A3B8", fontSize: 14, fontFamily: "monospace" }}>{v.poCount}</span>
                      <span style={{ textAlign: "center", color: "#94A3B8", fontSize: 14, fontFamily: "monospace" }}>{v.completed}/{v.totalMs}</span>
                      <span style={{ textAlign: "center", color: "#10B981", fontSize: 14, fontWeight: 700, fontFamily: "monospace" }}>{v.onTime}</span>
                      <span style={{ textAlign: "center", color: v.late > 0 ? "#EF4444" : "#6B7280", fontSize: 14, fontWeight: 700, fontFamily: "monospace" }}>{v.late}</span>
                      <span style={{ textAlign: "center", color: v.avgDaysLate > 0 ? "#F59E0B" : "#6B7280", fontSize: 14, fontFamily: "monospace" }}>{v.avgDaysLate > 0 ? `${v.avgDaysLate}d` : "—"}</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "center" }}>
                        <div style={{ width: 50, height: 8, borderRadius: 4, background: "#0F172A", overflow: "hidden" }}>
                          <div style={{ width: `${pct}%`, height: "100%", background: pctColor, borderRadius: 4 }} />
                        </div>
                        <span style={{ color: pctColor, fontSize: 14, fontWeight: 800, fontFamily: "monospace" }}>{v.completed > 0 ? `${pct}%` : "—"}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          );
        })()}

        {/* ── TIMELINE ── */}
        {view === "timeline" && timelinePanelExtracted({
          pos, milestones, search, setSearch, selected, setSelected,
          setDetailMode: setDetailMode as any, setView, setNewNote, openCategoryWithCheck,
        })}
      </div>

        {/* ── ARCHIVE VIEW ── */}
        {view === "archive" && (() => {
          const s = archiveSearch.toLowerCase();
          const filtered = archivedPos.filter(po => {
            if (s && !(po.PoNumber ?? "").toLowerCase().includes(s) && !(po.VendorName ?? "").toLowerCase().includes(s)) return false;
            if (archiveFilterVendor !== "All" && (po.VendorName ?? "") !== archiveFilterVendor) return false;
            if (archiveFilterStatus !== "All" && (po.StatusName ?? "") !== archiveFilterStatus) return false;
            return true;
          });
          const vendors = ["All", ...new Set(archivedPos.map(p => p.VendorName ?? "").filter(Boolean))].sort();
          const statuses = ["All", ...new Set(archivedPos.map(p => p.StatusName ?? "").filter(Boolean))];
          const allSelected = filtered.length > 0 && filtered.every(p => archiveSelected.has(p.PoNumber ?? ""));
          return (
            <div style={{ maxWidth: "85%", margin: "0 auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <div>
                  <h2 style={{ margin: "0 0 2px", color: "#F1F5F9", fontSize: 20, fontWeight: 700 }}>Archived Purchase Orders</h2>
                  <div style={{ color: "#6B7280", fontSize: 12 }}>{archivedPos.length} archived POs · milestones and notes preserved</div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  {archiveSelected.size > 0 && (<>
                    <button onClick={() => { archiveSelected.forEach(pn => unarchivePO(pn)); setArchiveSelected(new Set()); }}
                      style={{ ...S.navBtn, color: "#10B981", borderColor: "#10B98144" }}>↩ Restore {archiveSelected.size} Selected</button>
                    <button onClick={() => {
                      setConfirmModal({
                        title: "Permanently Delete",
                        message: `Permanently delete ${archiveSelected.size} PO${archiveSelected.size > 1 ? "s" : ""}?\n\nThis will remove all data including milestones, notes, and attachments. This cannot be undone.`,
                        icon: "🗑️", confirmText: "Delete Forever", confirmColor: "#EF4444",
                        onConfirm: async () => { await permanentDeleteArchived([...archiveSelected]); setArchiveSelected(new Set()); },
                      });
                    }} style={{ ...S.navBtnDanger }}>🗑 Delete {archiveSelected.size} Selected</button>
                  </>)}
                  {archivedPos.length > 0 && (
                    <button onClick={() => {
                      setConfirmModal({
                        title: "Restore All Archived",
                        message: `Restore all ${archivedPos.length} archived PO${archivedPos.length > 1 ? "s" : ""} back to All POs?\n\nPOs that should stay archived (Closed, Received, Cancelled) will be re-archived on your next sync.`,
                        icon: "↩", confirmText: "Restore All", confirmColor: "#10B981",
                        onConfirm: async () => {
                          for (const po of archivedPos) await unarchivePO(po.PoNumber ?? "");
                          setArchiveSelected(new Set());
                        },
                      });
                    }} style={{ ...S.navBtn, color: "#10B981", borderColor: "#10B98144" }}>↩ Restore All ({archivedPos.length})</button>
                  )}
                </div>
              </div>
              <div style={S.filters}>
                <input value={archiveSearch} onChange={e => setArchiveSearch(e.target.value)} placeholder="🔍 Search PO#, vendor…" style={{ ...S.input, width: 240, marginBottom: 0 }} />
                <select value={archiveFilterVendor} onChange={e => setArchiveFilterVendor(e.target.value)} style={S.select}>
                  {vendors.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
                <select value={archiveFilterStatus} onChange={e => setArchiveFilterStatus(e.target.value)} style={S.select}>
                  {statuses.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                {filtered.length > 0 && (
                  <button onClick={() => {
                    setConfirmModal({
                      title: "Delete All Filtered",
                      message: `Permanently delete all ${filtered.length} filtered PO${filtered.length > 1 ? "s" : ""}? This cannot be undone.`,
                      icon: "🗑️", confirmText: "Delete All", confirmColor: "#EF4444",
                      onConfirm: async () => { await permanentDeleteArchived(filtered.map(p => p.PoNumber ?? "").filter(Boolean)); setArchiveSelected(new Set()); },
                    });
                  }} style={S.navBtnDanger}>🗑 Delete All Filtered ({filtered.length})</button>
                )}
              </div>
              {archiveLoading ? (
                <div style={S.emptyState}>Loading archived POs…</div>
              ) : filtered.length === 0 ? (
                <div style={S.emptyState}>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>📦</div>
                  <p style={{ color: "#6B7280", margin: 0 }}>{archivedPos.length === 0 ? "No archived POs yet" : "No POs match your filters"}</p>
                </div>
              ) : (
                <div style={{ background: "#1E293B", borderRadius: 12, border: "1px solid #334155", overflow: "hidden" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "40px 1fr 1fr 120px 140px 100px", padding: "10px 16px", background: "#0F172A", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "1px solid #334155" }}>
                    <div><input type="checkbox" checked={allSelected} onChange={() => {
                      if (allSelected) setArchiveSelected(new Set());
                      else setArchiveSelected(new Set(filtered.map(p => p.PoNumber ?? "")));
                    }} style={{ accentColor: "#3B82F6" }} /></div>
                    <div>PO#</div><div>Vendor</div><div>Status</div><div>Archived</div><div>Actions</div>
                  </div>
                  {filtered.map((po, i) => {
                    const poNum = po.PoNumber ?? "";
                    const isChecked = archiveSelected.has(poNum);
                    const statusColor = STATUS_COLORS[po.StatusName ?? ""] ?? "#6B7280";
                    return (
                      <div key={poNum} style={{ display: "grid", gridTemplateColumns: "40px 1fr 1fr 120px 140px 100px", padding: "12px 16px", borderBottom: "1px solid #0F172A", background: i % 2 === 0 ? "#1E293B" : "#1A2332", alignItems: "center" }}>
                        <div><input type="checkbox" checked={isChecked} onChange={() => {
                          const next = new Set(archiveSelected);
                          if (isChecked) next.delete(poNum); else next.add(poNum);
                          setArchiveSelected(next);
                        }} style={{ accentColor: "#3B82F6" }} /></div>
                        <div style={{ fontFamily: "monospace", color: "#60A5FA", fontWeight: 700, fontSize: 14 }}>{poNum}</div>
                        <div style={{ color: "#D1D5DB", fontSize: 13 }}>{po.VendorName ?? ""}</div>
                        <div><span style={{ ...S.badge, background: statusColor + "22", color: statusColor, border: `1px solid ${statusColor}44` }}>{po.StatusName ?? ""}</span></div>
                        <div style={{ color: "#6B7280", fontSize: 12, fontFamily: "monospace" }}>{po._archivedAt ? new Date(po._archivedAt).toLocaleDateString() : "—"}</div>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={() => unarchivePO(poNum)} title="Restore" style={{ background: "none", border: "1px solid #10B98144", color: "#10B981", borderRadius: 6, padding: "3px 8px", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>↩</button>
                          <button onClick={() => {
                            setConfirmModal({
                              title: "Permanently Delete", message: `Delete PO ${poNum} permanently? All data will be lost.`,
                              icon: "🗑️", confirmText: "Delete", confirmColor: "#EF4444",
                              onConfirm: () => permanentDeleteArchived([poNum]),
                            });
                          }} title="Delete permanently" style={{ background: "none", border: "1px solid #EF444444", color: "#EF4444", borderRadius: 6, padding: "3px 8px", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>🗑</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}

      {selected && view !== "timeline" && DetailPanel()}
      {showSettings  && <SettingsModal />}
      {showSyncModal && SyncModal()}
      {showSyncLog   && <SyncLogModal />}
      <SyncProgressModal />
      <SyncDoneModal />
      {blockedModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setBlockedModal(null)}>
          <div style={{ background: "#1E293B", borderRadius: 16, width: 420, border: "1px solid #F59E0B44", boxShadow: "0 24px 64px rgba(0,0,0,0.5)", overflow: "hidden" }} onClick={e => e.stopPropagation()}>
            <div style={{ background: "linear-gradient(135deg, #F59E0B22, #EF444422)", padding: "20px 24px", borderBottom: "1px solid #334155", display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: "#F59E0B22", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>⚠️</div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#F1F5F9" }}>Category Blocked</div>
                <div style={{ fontSize: 12, color: "#94A3B8" }}>Dependency not yet complete</div>
              </div>
            </div>
            <div style={{ padding: "20px 24px" }}>
              <p style={{ color: "#D1D5DB", fontSize: 14, margin: "0 0 16px", lineHeight: 1.6 }}>
                <strong style={{ color: "#F59E0B" }}>{blockedModal.cat}</strong> is blocked by <strong style={{ color: "#EF4444" }}>{blockedModal.delayedCat}</strong>
                {blockedModal.daysLate > 0 && <span>, which is <strong style={{ color: "#EF4444" }}>{blockedModal.daysLate} days late</strong></span>}.
              </p>
              <p style={{ color: "#6B7280", fontSize: 12, margin: "0 0 20px" }}>
                The predecessor category must be completed before this phase should begin. You can still view it if needed.
              </p>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => setBlockedModal(null)} style={{ flex: 1, padding: "10px 20px", borderRadius: 8, border: "1px solid #334155", background: "none", color: "#94A3B8", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600 }}>Cancel</button>
                <button onClick={() => { blockedModal.onConfirm(); setBlockedModal(null); }} style={{ flex: 1, padding: "10px 20px", borderRadius: 8, border: "none", background: "linear-gradient(135deg, #F59E0B, #D97706)", color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700 }}>View Anyway</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div style={{ position: "fixed", bottom: 32, left: "50%", transform: "translateX(-50%)", background: "#10B981", color: "#fff", padding: "12px 28px", borderRadius: 10, fontSize: 15, fontWeight: 700, boxShadow: "0 8px 32px rgba(0,0,0,0.4)", zIndex: 400, pointerEvents: "none" }}>
          ✓ {toast}
        </div>
      )}
      {confirmModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => { confirmModal.onCancel?.(); setConfirmModal(null); }}>
          <div style={{ background: "#1E293B", borderRadius: 16, width: 420, border: `1px solid ${confirmModal.confirmColor}44`, boxShadow: "0 24px 64px rgba(0,0,0,0.5)", overflow: "hidden" }} onClick={e => e.stopPropagation()}>
            <div style={{ background: `${confirmModal.confirmColor}15`, padding: "20px 24px", borderBottom: "1px solid #334155", display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: `${confirmModal.confirmColor}22`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>{confirmModal.icon}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#F1F5F9" }}>{confirmModal.title}</div>
            </div>
            <div style={{ padding: "20px 24px" }}>
              <p style={{ color: "#D1D5DB", fontSize: 14, margin: "0 0 12px", lineHeight: 1.6 }}>{confirmModal.message}</p>
              {confirmModal.listItems && confirmModal.listItems.length > 0 && (
                <div style={{ background: "#0F172A", borderRadius: 8, padding: "8px 12px", marginBottom: 16, maxHeight: 160, overflowY: "auto" }}>
                  {confirmModal.listItems.map(item => (
                    <div key={item} style={{ fontSize: 12, color: "#60A5FA", fontFamily: "monospace", padding: "2px 0", borderBottom: "1px solid #1E293B" }}>{item}</div>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 10, marginTop: confirmModal.listItems ? 0 : 8 }}>
                <button onClick={() => { confirmModal.onCancel?.(); setConfirmModal(null); }} style={{ flex: 1, padding: "10px 20px", borderRadius: 8, border: "1px solid #334155", background: "none", color: "#94A3B8", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600 }}>{confirmModal.cancelText || "Cancel"}</button>
                <button onClick={() => { confirmModal.onConfirm(); setConfirmModal(null); }} style={{ flex: 1, padding: "10px 20px", borderRadius: 8, border: "none", background: `linear-gradient(135deg, ${confirmModal.confirmColor}, ${confirmModal.confirmColor}CC)`, color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700 }}>{confirmModal.confirmText}</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {showBulkUpdate && (
        <div style={S.modalOverlay} onClick={() => setShowBulkUpdate(false)}>
          <div style={{ ...S.modal, width: 520 }} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h2 style={S.modalTitle}>Bulk Milestone Update</h2>
              <button style={S.closeBtn} onClick={() => setShowBulkUpdate(false)}>✕</button>
            </div>
            <div style={S.modalBody}>
              <p style={{ color: "#9CA3AF", fontSize: 13, marginTop: 0, marginBottom: 16 }}>
                Update milestones across all POs for a specific vendor. Select a vendor, optionally filter by category or phase, then choose the new status.
              </p>
              <label style={S.label}>Vendor</label>
              <select style={{ ...S.select, width: "100%", marginBottom: 12 }} value={bulkVendor} onChange={e => { setBulkVendor(e.target.value); setBulkPhase(""); setBulkCategory(""); }}>
                <option value="">Select vendor…</option>
                {[...new Set(pos.map(p => p.VendorName ?? "").filter(Boolean))].sort().map(v => {
                  const vPOs = pos.filter(p => (p.VendorName ?? "") === v);
                  const vMs = vPOs.flatMap(p => milestones[p.PoNumber ?? ""] || []);
                  return <option key={v} value={v}>{v} ({vPOs.length} POs, {vMs.length} milestones)</option>;
                })}
              </select>

              {bulkVendor && (() => {
                const vendorPOs = pos.filter(p => (p.VendorName ?? "") === bulkVendor);
                const targetPOs = bulkPOs.length > 0 ? vendorPOs.filter(p => bulkPOs.includes(p.PoNumber ?? "")) : vendorPOs;
                const targetMs = targetPOs.flatMap(p => milestones[p.PoNumber ?? ""] || []);
                const cats = WIP_CATEGORIES.filter(c => targetMs.some(m => m.category === c));
                const phases = [...new Set(targetMs.filter(m => !bulkCategory || m.category === bulkCategory).map(m => m.phase))];
                const matching = targetMs.filter(m => {
                  const matchPhase = bulkPhases.length === 0 || bulkPhases.includes(m.phase);
                  const matchCat = !bulkCategory || m.category === bulkCategory;
                  return matchPhase && matchCat && m.status !== "N/A";
                });
                const filteredVendorPOs = bulkPOSearch ? vendorPOs.filter(p => (p.PoNumber ?? "").toLowerCase().includes(bulkPOSearch.toLowerCase())) : vendorPOs;

                return (
                  <>
                    <label style={S.label}>POs (optional — leave empty for all)</label>
                    <div style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
                      <input value={bulkPOSearch} onChange={e => setBulkPOSearch(e.target.value)} placeholder="🔍 Search PO#…" style={{ ...S.input, marginBottom: 0, flex: 1, fontSize: 12, padding: "6px 10px" }} />
                      <button style={{ ...S.btnSecondary, fontSize: 11, padding: "5px 10px", whiteSpace: "nowrap" }} onClick={() => setBulkPOs(filteredVendorPOs.map(p => p.PoNumber ?? "").filter(Boolean))}>All</button>
                      <button style={{ ...S.btnSecondary, fontSize: 11, padding: "5px 10px", whiteSpace: "nowrap" }} onClick={() => setBulkPOs([])}>None</button>
                    </div>
                    <div style={{ marginBottom: 12, maxHeight: 160, overflowY: "auto", background: "#0F172A", borderRadius: 8, border: "1px solid #334155", padding: 6 }}>
                      {filteredVendorPOs.map(p => {
                        const pn = p.PoNumber ?? "";
                        const isChecked = bulkPOs.includes(pn);
                        const poMsCount = (milestones[pn] || []).length;
                        return (
                          <label key={pn} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", cursor: "pointer", borderRadius: 4 }}
                            onMouseEnter={e => e.currentTarget.style.background = "#1E293B"}
                            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                            <input type="checkbox" checked={isChecked} onChange={() => setBulkPOs(prev => isChecked ? prev.filter(x => x !== pn) : [...prev, pn])}
                              style={{ accentColor: "#3B82F6" }} />
                            <span style={{ fontSize: 13, color: "#60A5FA", fontFamily: "monospace", fontWeight: 600 }}>{pn}</span>
                            <span style={{ fontSize: 11, color: "#6B7280" }}>{poMsCount} milestones</span>
                            <span style={{ fontSize: 11, color: "#9CA3AF", marginLeft: "auto" }}>
                              {fmtDate(p.DateOrder) || "—"} → {fmtDate(p.DateExpectedDelivery) || "—"}
                            </span>
                          </label>
                        );
                      })}
                      {filteredVendorPOs.length === 0 && <div style={{ padding: 8, color: "#6B7280", fontSize: 12, textAlign: "center" }}>No POs match</div>}
                    </div>

                    <label style={S.label}>Category (optional)</label>
                    <select style={{ ...S.select, width: "100%", marginBottom: 12 }} value={bulkCategory} onChange={e => { setBulkCategory(e.target.value); setBulkPhases([]); }}>
                      <option value="">All Categories</option>
                      {cats.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>

                    <label style={S.label}>Phases (optional — leave empty for all)</label>
                    <div style={{ marginBottom: 12, maxHeight: 120, overflowY: "auto", background: "#0F172A", borderRadius: 8, border: "1px solid #334155", padding: 6 }}>
                      {phases.map(p => {
                        const isChecked = bulkPhases.includes(p);
                        return (
                          <label key={p} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", cursor: "pointer", borderRadius: 4 }}
                            onMouseEnter={e => e.currentTarget.style.background = "#1E293B"}
                            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                            <input type="checkbox" checked={isChecked} onChange={() => setBulkPhases(prev => isChecked ? prev.filter(x => x !== p) : [...prev, p])}
                              style={{ accentColor: "#3B82F6" }} />
                            <span style={{ fontSize: 12, color: "#D1D5DB" }}>{p}</span>
                          </label>
                        );
                      })}
                      {phases.length === 0 && <div style={{ padding: 8, color: "#6B7280", fontSize: 12, textAlign: "center" }}>No phases available</div>}
                    </div>

                    <label style={S.label}>New Status</label>
                    <select style={{ ...S.select, width: "100%", marginBottom: 16 }} value={bulkStatus} onChange={e => setBulkStatus(e.target.value)}>
                      <option value="">Select status…</option>
                      {MILESTONE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>

                    <div style={{ background: "#0F172A", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 12, color: "#9CA3AF" }}>
                      <strong style={{ color: "#60A5FA" }}>Preview:</strong> {matching.length} milestones across {targetPOs.length} POs{bulkPOs.length > 0 ? ` (${bulkPOs.length} selected)` : " (all)"}
                      {bulkStatus && <span> will be set to <strong style={{ color: MILESTONE_STATUS_COLORS[bulkStatus] || "#fff" }}>{bulkStatus}</strong></span>}
                    </div>

                    <div style={{ display: "flex", gap: 10 }}>
                      <button style={{ ...S.btnSecondary, flex: 1 }} onClick={() => setShowBulkUpdate(false)}>Cancel</button>
                      {bulkPOs.length > 0 && (
                        <button
                          style={{ flex: 1, background: "none", border: "1px solid #EF4444", color: "#EF4444", borderRadius: 8, padding: "10px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
                          onMouseEnter={e => { e.currentTarget.style.background = "#EF4444"; e.currentTarget.style.color = "#fff"; }}
                          onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "#EF4444"; }}
                          onClick={() => {
                            const toDelete = [...bulkPOs];
                            setConfirmModal({
                              title: "Delete POs",
                              message: `Are you sure you want to delete ${toDelete.length} PO${toDelete.length > 1 ? "s" : ""}? This will permanently remove all milestones, notes, and history.`,
                              listItems: toDelete,
                              icon: "🗑",
                              confirmText: "Yes, I'm sure",
                              cancelText: "Cancel",
                              confirmColor: "#EF4444",
                              onConfirm: async () => {
                                for (const pn of toDelete) await deletePO(pn);
                                setBulkPOs([]);
                                setShowBulkUpdate(false);
                                setToast(`${toDelete.length} PO${toDelete.length > 1 ? "s" : ""} deleted`);
                                setTimeout(() => setToast(null), 2000);
                              }
                            });
                          }}>
                          🗑 Delete {bulkPOs.length} PO{bulkPOs.length > 1 ? "s" : ""}
                        </button>
                      )}
                      <button style={{ ...S.btnPrimary, flex: 2, opacity: (!bulkStatus || bulkUpdating) ? 0.5 : 1 }}
                        disabled={!bulkStatus || bulkUpdating}
                        onClick={() => {
                          setConfirmModal({ title: "Bulk Update", message: `Update ${matching.length} milestones to "${bulkStatus}" for ${bulkVendor}?`, icon: "⚡", confirmText: "Update", confirmColor: "#3B82F6", onConfirm: bulkUpdateMilestones });
                        }}>
                        {bulkUpdating ? "Updating…" : `Update ${matching.length} Milestones`}
                      </button>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}
      {/* Ask Me — Floating Help Button + Panel */}
      <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 250 }}>
        {askMeOpen && (
          <div style={{ position: "absolute", bottom: 60, right: 0, width: 380, maxHeight: 500, background: "#1E293B", borderRadius: 16, border: "1px solid #334155", boxShadow: "0 16px 48px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", borderBottom: "1px solid #334155", display: "flex", alignItems: "center", justifyContent: "space-between", background: "linear-gradient(135deg, #3B82F6, #8B5CF6)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 20 }}>🤖</span>
                <span style={{ color: "#fff", fontWeight: 700, fontSize: 15 }}>Ask Me Anything</span>
              </div>
              <button onClick={() => setAskMeOpen(false)} style={{ background: "none", border: "none", color: "#fff", fontSize: 16, cursor: "pointer", fontFamily: "inherit", opacity: 0.8 }}>✕</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 12, maxHeight: 360 }}>
              {askMeHistory.length === 0 && (
                <div style={{ textAlign: "center", padding: "20px 0", color: "#6B7280" }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>💡</div>
                  <div style={{ fontSize: 13, marginBottom: 12 }}>Ask me anything about using PO WIP!</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center" }}>
                    {["How do I sync?", "Milestone status", "Timeline view", "Bulk update", "Excel export", "Cascade alerts"].map(q => (
                      <button key={q} onClick={() => { const a = getAskMeAnswer(q); setAskMeHistory(h => [...h, { q, a }]); setAskMeQuery(""); }}
                        style={{ padding: "4px 10px", borderRadius: 12, border: "1px solid #334155", background: "#0F172A", color: "#94A3B8", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>{q}</button>
                    ))}
                  </div>
                </div>
              )}
              {askMeHistory.map((item, i) => (
                <div key={i}>
                  <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
                    <div style={{ background: "#3B82F6", color: "#fff", padding: "8px 12px", borderRadius: "12px 12px 2px 12px", fontSize: 13, maxWidth: "80%" }}>{item.q}</div>
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-start" }}>
                    <div style={{ background: "#0F172A", color: "#D1D5DB", padding: "10px 14px", borderRadius: "12px 12px 12px 2px", fontSize: 12, maxWidth: "90%", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                      {item.a.split(/\*\*(.*?)\*\*/g).map((part, j) => j % 2 === 1 ? <strong key={j} style={{ color: "#60A5FA" }}>{part}</strong> : part)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ padding: "10px 14px", borderTop: "1px solid #334155", display: "flex", gap: 8 }}>
              <input value={askMeQuery} onChange={e => setAskMeQuery(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && askMeQuery.trim()) { const a = getAskMeAnswer(askMeQuery); setAskMeHistory(h => [...h, { q: askMeQuery.trim(), a }]); setAskMeQuery(""); } }}
                placeholder="Type your question..." style={{ flex: 1, background: "#0F172A", border: "1px solid #334155", borderRadius: 8, color: "#D1D5DB", fontSize: 13, padding: "8px 12px", outline: "none", fontFamily: "inherit" }} />
              <button onClick={() => { if (askMeQuery.trim()) { const a = getAskMeAnswer(askMeQuery); setAskMeHistory(h => [...h, { q: askMeQuery.trim(), a }]); setAskMeQuery(""); } }}
                style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: "linear-gradient(135deg, #3B82F6, #8B5CF6)", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Ask</button>
            </div>
          </div>
        )}
        <button onClick={() => setAskMeOpen(!askMeOpen)}
          style={{ width: 52, height: 52, borderRadius: "50%", border: "none", background: askMeOpen ? "linear-gradient(135deg, #8B5CF6, #3B82F6)" : "linear-gradient(135deg, #3B82F6, #8B5CF6)", color: "#fff", fontSize: 22, cursor: "pointer", boxShadow: "0 4px 16px rgba(59,130,246,0.4)", display: "flex", alignItems: "center", justifyContent: "center", transition: "transform 0.2s, box-shadow 0.2s" }}
          onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.1)"; e.currentTarget.style.boxShadow = "0 6px 24px rgba(59,130,246,0.6)"; }}
          onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.boxShadow = "0 4px 16px rgba(59,130,246,0.4)"; }}>
          {askMeOpen ? "✕" : "💬"}
        </button>
      </div>
    </div>
  );

  function StatCard({ label, value, color, icon, onClick }: { label: string; value: string | number; color: string; icon: string; onClick?: () => void }) {
    return (
      <div style={{ ...S.statCard, borderTop: `3px solid ${color}`, cursor: onClick ? "pointer" : "default", transition: "transform 0.15s, box-shadow 0.15s" }}
        onClick={onClick}
        onMouseEnter={e => { if (onClick) { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.3)"; } }}
        onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "none"; }}>
        <div style={{ fontSize: 24 }}>{icon}</div>
        <div style={{ fontSize: 28, fontWeight: 700, color, fontFamily: "monospace" }}>{value}</div>
        <div style={{ color: "#9CA3AF", fontSize: 13 }}>{label}</div>
      </div>
    );
  }

  function PORow({ po, onClick, detailed }: { po: XoroPO; onClick: () => void; detailed?: boolean }) {
    const color = STATUS_COLORS[po.StatusName ?? ""] ?? "#6B7280";
    const days  = daysUntil(po.DateExpectedDelivery);
    const total = poTotal(po);
    const items = po.Items ?? po.PoLineArr ?? [];
    const poMs = milestones[po.PoNumber ?? ""] || [];
    const msComplete = poMs.filter(m => m.status === "Complete").length;
    const msActive = poMs.filter(m => m.status !== "N/A").length;
    const msInProg = poMs.filter(m => m.status === "In Progress").length;
    const msDelayed = poMs.filter(m => m.status === "Delayed").length;
    const msNotStarted = msActive - msComplete - msInProg - msDelayed;
    const msOverdue = poMs.some(m => m.expected_date && m.expected_date < today && m.status !== "Complete" && m.status !== "N/A");
    const msApproaching = poMs.some(m => m.expected_date && m.expected_date >= today && m.expected_date <= weekFromNow && m.status !== "Complete" && m.status !== "N/A");
    const msDotColor = msActive === 0 ? "#6B7280" : msOverdue ? "#EF4444" : msApproaching ? "#F59E0B" : "#10B981";
    const msPercent = msActive > 0 ? Math.round((msComplete / msActive) * 100) : 0;
    const statusBars = [
      [msComplete, "#047857", "#6EE7B7"],
      [msInProg, "#1D4ED8", "#93C5FD"],
      [msDelayed, "#7F1D1D", "#FCA5A5"],
      [msNotStarted, "#374151", "#9CA3AF"],
    ].filter(([c]) => (c as number) > 0) as [number, string, string][];
    return (
      <div style={{ ...S.poRow, borderLeft: `3px solid ${color}` }} onClick={onClick}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <span style={S.poNumber}>{po.PoNumber ?? "—"}</span>
            <span style={{ ...S.badge, background: color + "22", color, border: `1px solid ${color}44` }}>
              {po.StatusName ?? "Unknown"}
            </span>
            {days !== null && days < 0 && <span style={{ ...S.badge, background: "#EF444422", color: "#EF4444", border: "1px solid #EF444444" }}>Overdue</span>}
            {days !== null && days >= 0 && days <= 7 && <span style={{ ...S.badge, background: "#F59E0B22", color: "#F59E0B", border: "1px solid #F59E0B44" }}>Due Soon</span>}
          </div>
          <div style={{ color: "#D1D5DB", fontWeight: 600 }}>{po.VendorName ?? "Unknown Vendor"}</div>
          {detailed && po.Memo && <div style={{ color: "#6B7280", fontSize: 12, marginTop: 2 }}>{po.Memo}</div>}
        </div>
        {/* Milestone segmented progress bars */}
        {msActive > 0 && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, minWidth: 110 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "#9CA3AF", fontSize: 11, fontFamily: "monospace" }}>{msComplete}/{msActive}</span>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: msDotColor }} />
              <span style={{ color: "#10B981", fontSize: 12, fontWeight: 700, fontFamily: "monospace" }}>{msPercent}%</span>
            </div>
            {statusBars.map(([count, dark, light], i) => {
              const sPct = msActive > 0 ? Math.round(((count as number) / msActive) * 100) : 0;
              return (
                <div key={i} style={{ width: 110, height: 6, borderRadius: 3, background: "#0F172A", overflow: "hidden" }}>
                  <div style={{ width: `${sPct}%`, height: "100%", background: `linear-gradient(90deg, ${light}, ${dark})`, borderRadius: 3, minWidth: (count as number) > 0 ? 3 : 0 }} />
                </div>
              );
            })}
          </div>
        )}
        <div style={{ textAlign: "right", minWidth: 160 }}>
          <div style={{ color: "#10B981", fontWeight: 700, fontSize: 16 }}>{fmtCurrency(total, po.CurrencyCode)}</div>
          {detailed && <div style={{ color: "#6B7280", fontSize: 12 }}>{items.length} line items</div>}
          {detailed && <div style={{ color: "#9CA3AF", fontSize: 12, marginTop: 4 }}>
            Created: <span style={{ color: "#94A3B8" }}>{fmtDate(po.DateOrder) || "—"}</span>
          </div>}
          <div style={{ color: "#9CA3AF", fontSize: 12, marginTop: 2 }}>
            DDP Date: <span style={{ color: "#60A5FA" }}>{fmtDate(po.DateExpectedDelivery) || "—"}</span>
          </div>
        </div>
      </div>
    );
  }
}

