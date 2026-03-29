import React, { useState, useEffect, useCallback, useRef } from "react";
import { msSignIn, loadMsTokens, saveMsTokens, clearMsTokens, getMsAccessToken, MS_CLIENT_ID, MS_TENANT_ID } from "./utils/msAuth";
import { styledEmailHtml } from "./utils/emailHtml";

// ── Supabase ─────────────────────────────────────────────────────────────────
import { SB_URL, SB_KEY, SB_HEADERS } from "./utils/supabase";

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

// ── Xoro API (proxied via /api/xoro-proxy to avoid CORS) ─────────────────────

// ── Mock data for UI testing while Xoro API is being configured ───────────────

interface SyncFilters {
  poNumbers: string[];
  dateFrom: string;
  dateTo: string;
  vendors: string[];
  statuses: string[];
}

interface SyncLogEntry {
  ts: string;           // ISO timestamp
  user: string;         // user name
  success: boolean;
  added: number;
  changed: number;
  deleted: number;
  error?: string;       // error message if failed
  filters?: {           // filters applied (if any)
    vendors?: string[];
    statuses?: string[];
    poNumbers?: string[];
    dateFrom?: string;
    dateTo?: string;
  };
}

function mapXoroRaw(raw: any[]): XoroPO[] {
  return raw.map((item: any) => {
    const h = item.poHeader ?? item;
    const lines = item.poLines ?? item.PoLineArr ?? item.Items ?? [];
    return {
      PoNumber:              h.OrderNumber ?? h.PoNumber ?? "",
      VendorName:            h.VendorName ?? "",
      DateOrder:             h.DateOrder ?? "",
      DateExpectedDelivery:  h.DateExpectedDelivery ?? "",
      VendorReqDate:         h.VendorReqDate ?? "",
      StatusName:            h.StatusName ?? "",
      CurrencyCode:          h.CurrencyCode ?? "USD",
      Memo:                  h.Memo ?? "",
      Tags:                  h.Tags ?? "",
      PaymentTermsName:      h.PaymentTermsName ?? "",
      ShipMethodName:        h.ShipMethodName ?? "",
      CarrierName:           h.CarrierName ?? "",
      BuyerName:             h.BuyerName ?? "",
      BrandName:             h.BrandName ?? h.Brand ?? "",
      TotalAmount:           h.TotalAmount ?? 0,
      Items: lines.map((l: any) => ({
        ItemNumber:  l.PoItemNumber ?? l.ItemNumber ?? "",
        Description: l.Description ?? l.Title ?? "",
        QtyOrder:    l.QtyOrder ?? 0,
        QtyReceived: l.QtyReceived ?? 0,
        QtyRemaining: l.QtyRemaining ?? (l.QtyOrder ?? 0) - (l.QtyReceived ?? 0),
        UnitPrice:   l.UnitPrice ?? l.EffectiveUnitPrice ?? 0,
      })),
    } as XoroPO;
  });
}

// All PO statuses — Xoro only returns "Open" by default, so we must request all explicitly
const ALL_PO_STATUSES = ["Open", "Released", "Received", "Partially Received", "Closed", "Cancelled", "Pending", "Draft"];
// Active statuses — skip fully Closed/Received/Cancelled since we auto-delete them
const ACTIVE_PO_STATUSES = ["Open", "Released", "Partially Received", "Pending", "Draft"];

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

  // Pass status filter — default to all statuses so Xoro doesn't just return "Open"
  const statusList = statuses?.length ? statuses : ALL_PO_STATUSES;
  params.set("status", statusList.join(","));

  // Pass vendor filter if specified
  if (vendors?.length) params.set("vendor_name", vendors.join(","));

  // Pass PO number filter if specified (single PO number only for API; multi is filtered client-side)
  if (poNumber) params.set("order_number", poNumber);
  // Note: vendor_name is passed as comma-separated; client-side filter handles case-insensitive fallback

  // Pass date filters if specified (ISO format: 2014-04-25T16:15:47-04:00)
  if (dateFrom) {
    const d = new Date(dateFrom);
    if (!isNaN(d.getTime())) params.set("created_at_min", d.toISOString());
  }
  if (dateTo) {
    const d = new Date(dateTo + "T23:59:59");
    if (!isNaN(d.getTime())) params.set("created_at_max", d.toISOString());
  }

  const res = await fetch(`/api/xoro-proxy?${params}`, { signal });
  if (!res.ok) throw new Error(`Xoro proxy error: ${res.status}`);
  const json = await res.json();
  // Result:false with no usable Data means no records for this filter — treat as empty, not an error
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

// Client-side fallback filter (in case API-side filters are incomplete)
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

// ── Types ─────────────────────────────────────────────────────────────────────
interface XoroPO {
  PoNumber?: string;
  VendorName?: string;
  DateOrder?: string;
  DateExpectedDelivery?: string;
  VendorReqDate?: string;
  StatusName?: string;
  CurrencyCode?: string;
  Memo?: string;
  Tags?: string;
  PaymentTermsName?: string;
  ShipMethodName?: string;
  CarrierName?: string;
  BuyerName?: string;
  BrandName?: string;
  TotalAmount?: number;
  Items?: XoroPOItem[];
  // raw API may nest items differently
  PoLineArr?: XoroPOItem[];
}

interface XoroPOItem {
  ItemNumber?: string;
  Description?: string;
  QtyOrder?: number;
  UnitPrice?: number;
  Discount?: number;
}

interface LocalNote {
  id: string;
  po_number: string;
  note: string;
  status_override?: string;
  created_at: string;
  user_name: string;
}

interface User {
  id: string;
  username?: string;
  name?: string;
  password: string;
  role?: string;
  color?: string;
  initials?: string;
  avatar?: string | null;
}

type View = "dashboard" | "list" | "detail" | "templates" | "email" | "teams" | "activity" | "vendors" | "timeline";

// ── Alpha size normaliser ─────────────────────────────────────────────────────
function normalizeSize(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[\s.]+/g, "");
  if (s === "s" || s === "sm" || s === "sml" || s === "small")                          return "Small";
  if (s === "m" || s === "med" || s === "medium")                                        return "Medium";
  if (s === "l" || s === "lg" || s === "lrg" || s === "large")                          return "Large";
  if (s === "xl" || s === "xlg" || s === "xlarge" || s === "xtralarge" || s === "extralarge") return "Xlarge";
  if (s === "xxl" || s === "2xl" || s === "2x")                                         return "XXL";
  if (s === "xxxl" || s === "3xl" || s === "3x")                                        return "3XL";
  if (s === "xxxxl" || s === "4xl" || s === "4x")                                       return "4XL";
  return raw; // keep original for numeric / unrecognised
}
const ALPHA_SZ_ORDER: Record<string, number> = { Small:1, Medium:2, Large:3, Xlarge:4, XXL:5, "3XL":6, "4XL":7 };
function sizeSort(a: string, b: string): number {
  const na = Number(a), nb = Number(b);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  const oa = ALPHA_SZ_ORDER[a], ob = ALPHA_SZ_ORDER[b];
  if (oa !== undefined && ob !== undefined) return oa - ob;
  if (oa !== undefined) return 1;  // alpha after numeric
  if (ob !== undefined) return -1;
  return a.localeCompare(b);
}

const STATUS_COLORS: Record<string, string> = {
  Open:       "#3B82F6",
  Released:   "#8B5CF6",
  Received:   "#10B981",
  Closed:     "#6B7280",
  Cancelled:  "#EF4444",
  Pending:    "#F59E0B",
  Draft:      "#9CA3AF",
};

const STATUS_OPTIONS = ["Open", "Released", "Received", "Closed", "Cancelled", "Pending", "Draft"];

// ── WIP Milestone Types & Constants ───────────────────────────────────────
interface WipTemplate {
  id: string;
  phase: string;
  category: string;
  daysBeforeDDP: number;
  status: string;
  notes: string;
}

interface Milestone {
  id: string;
  po_number: string;
  phase: string;
  category: string;
  sort_order: number;
  days_before_ddp: number;
  expected_date: string | null;
  actual_date: string | null;
  status: string;
  status_date: string | null;
  status_dates: Record<string, string> | null;
  notes: string;
  note_entries: { text: string; user: string; date: string }[] | null;
  updated_at: string;
  updated_by: string;
  // Per-color/variant status tracking
  variant_statuses: Record<string, { status: string; status_date: string | null }> | null;
}

interface DCVendor {
  id: string;
  name: string;
  wipLeadOverrides?: Record<string, number>;
}

interface DmConversation {
  chatId: string;
  recipient: string;      // email / UPN used to create the chat
  recipientName: string;  // display name
  messages: any[];
}

const WIP_CATEGORIES = ["Pre-Production", "Fabric T&A", "Samples", "Production", "Transit"];

const MILESTONE_STATUSES = ["Not Started", "In Progress", "Complete", "Delayed", "N/A"];

const MILESTONE_STATUS_COLORS: Record<string, string> = {
  "Not Started": "#6B7280",
  "In Progress": "#3B82F6",
  "Complete": "#10B981",
  "Delayed": "#EF4444",
  "N/A": "#9CA3AF",
};

const DEFAULT_WIP_TEMPLATES: WipTemplate[] = [
  { id: "wip_labdip",    phase: "Lab Dip / Strike Off",      category: "Pre-Production", daysBeforeDDP: 120, status: "Not Started", notes: "" },
  { id: "wip_trims",     phase: "Trims",                     category: "Pre-Production", daysBeforeDDP: 110, status: "Not Started", notes: "" },
  { id: "wip_rawgoods",  phase: "Raw Goods Available",       category: "Fabric T&A",     daysBeforeDDP: 100, status: "Not Started", notes: "" },
  { id: "wip_fabprint",  phase: "Fabric at Printing Mill",   category: "Fabric T&A",     daysBeforeDDP: 90,  status: "Not Started", notes: "" },
  { id: "wip_fabfg",     phase: "Fabric Finished Goods",     category: "Fabric T&A",     daysBeforeDDP: 80,  status: "Not Started", notes: "" },
  { id: "wip_fabfact",   phase: "Fabric at Factory",         category: "Fabric T&A",     daysBeforeDDP: 70,  status: "Not Started", notes: "" },
  { id: "wip_fabcut",    phase: "Fabric at Cutting Line",    category: "Fabric T&A",     daysBeforeDDP: 60,  status: "Not Started", notes: "" },
  { id: "wip_fitsample", phase: "Fit Sample",                category: "Samples",        daysBeforeDDP: 90,  status: "Not Started", notes: "" },
  { id: "wip_ppsample",  phase: "PP Sample",                 category: "Samples",        daysBeforeDDP: 75,  status: "Not Started", notes: "" },
  { id: "wip_ppapproval",phase: "PP Approval",               category: "Samples",        daysBeforeDDP: 65,  status: "Not Started", notes: "" },
  { id: "wip_sizeset",   phase: "Size Set",                  category: "Samples",        daysBeforeDDP: 55,  status: "Not Started", notes: "" },
  { id: "wip_fabready",  phase: "Fabric Ready",              category: "Production",     daysBeforeDDP: 50,  status: "Not Started", notes: "" },
  { id: "wip_prodstart", phase: "Prod Start",                category: "Production",     daysBeforeDDP: 42,  status: "Not Started", notes: "" },
  { id: "wip_packstart", phase: "Packing Start",             category: "Production",     daysBeforeDDP: 28,  status: "Not Started", notes: "" },
  { id: "wip_prodend",   phase: "Prod End",                  category: "Production",     daysBeforeDDP: 21,  status: "Not Started", notes: "" },
  { id: "wip_topsample", phase: "Top Sample",                category: "Transit",        daysBeforeDDP: 18,  status: "Not Started", notes: "" },
  { id: "wip_exfactory", phase: "Ex Factory",                category: "Transit",        daysBeforeDDP: 14,  status: "Not Started", notes: "" },
  { id: "wip_packdocs",  phase: "Packing List / Docs Rec'd", category: "Transit",        daysBeforeDDP: 7,   status: "Not Started", notes: "" },
  { id: "wip_inhouse",   phase: "In House / DDP",            category: "Transit",        daysBeforeDDP: 0,   status: "Not Started", notes: "" },
];

function milestoneUid() { return "ms_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(d?: string) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d;
  return `${String(dt.getMonth() + 1).padStart(2, "0")}/${String(dt.getDate()).padStart(2, "0")}/${dt.getFullYear()}`;
}
function fmtCurrency(n?: number, code = "USD") {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(n);
}
function daysUntil(d?: string) {
  if (!d) return null;
  const diff = Math.ceil((new Date(d).getTime() - Date.now()) / 86400000);
  return diff;
}
function poTotal(po: XoroPO) {
  const items = po.Items ?? po.PoLineArr ?? [];
  // For partially received POs, calculate from remaining qty; otherwise use TotalAmount
  const hasReceived = items.some((i: any) => (i.QtyReceived ?? 0) > 0);
  if (hasReceived) {
    return items.reduce((s, i: any) => {
      const remaining = i.QtyRemaining != null ? i.QtyRemaining : (i.QtyOrder ?? 0) - (i.QtyReceived ?? 0);
      return s + remaining * (i.UnitPrice ?? 0);
    }, 0);
  }
  if (po.TotalAmount != null) return po.TotalAmount;
  return items.reduce((s, i) => s + (i.QtyOrder ?? 0) * (i.UnitPrice ?? 0), 0);
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function TandAApp() {
  const [user, setUser]         = useState<User | null>(null);
  const [view, setView]         = useState<View>(() => {
    const saved = localStorage.getItem("tanda_view");
    const valid: View[] = ["dashboard", "list", "detail", "templates", "email", "teams", "activity", "vendors", "timeline"];
    return valid.includes(saved as View) ? (saved as View) : "dashboard";
  });
  const [pos, setPos]           = useState<XoroPO[]>([]);
  const [notes, setNotes]       = useState<LocalNote[]>([]);
  const [selected, setSelected] = useState<XoroPO | null>(null);
  const [detailMode, setDetailMode] = useState<"header" | "po" | "milestones" | "notes" | "history" | "matrix" | "email" | "attachments" | "all">("po");
  const [attachments, setAttachments] = useState<Record<string, { id: string; name: string; url: string; type: string; size: number; uploaded_by: string; uploaded_at: string }[]>>({});
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
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
  const [matrixCollapsed, setMatrixCollapsed] = useState(false);
  const [lineItemsCollapsed, setLineItemsCollapsed] = useState(true);
  const [poInfoCollapsed, setPoInfoCollapsed] = useState(false);
  const [progressCollapsed, setProgressCollapsed] = useState(false);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [msNoteText, setMsNoteText] = useState("");
  const [expandedVariants, setExpandedVariants] = useState<Set<string>>(new Set());
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
  const [loading, setLoading]   = useState(false);
  const [syncing, setSyncing]   = useState(false);
  const [syncErr, setSyncErr]   = useState("");
  const [lastSync, setLastSync] = useState<string>("");
  const [search, setSearch]     = useState("");
  const [filterStatus, setFilterStatus] = useState("All");
  const [filterVendor, setFilterVendor] = useState("All");
  const [showSettings, setShowSettings] = useState(false);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [newNote, setNewNote]   = useState("");
  const syncAbortRef = useRef<AbortController | null>(null);
  const generatingRef = useRef<Set<string>>(new Set());

  // Sync filter state
  const [syncFilters, setSyncFilters] = useState<SyncFilters>({
    poNumbers: [], dateFrom: "", dateTo: "", vendors: [], statuses: []
  });
  const [syncProgress, setSyncProgress] = useState(0);
  const [syncProgressMsg, setSyncProgressMsg] = useState("");
  const [syncDone, setSyncDone] = useState<{ added: number; changed: number; deleted: number } | null>(null);
  const [syncLog, setSyncLog] = useState<SyncLogEntry[]>([]);
  const [showSyncLog, setShowSyncLog] = useState(false);
  const [poSearch, setPoSearch] = useState("");
  const [poDropdownOpen, setPoDropdownOpen] = useState(false);
  const [xoroVendors, setXoroVendors]         = useState<string[]>([]);
  const [manualVendors, setManualVendors]       = useState<string[]>([]);
  const [vendorSearch, setVendorSearch]         = useState("");
  const [loadingVendors, setLoadingVendors]     = useState(false);
  const [newManualVendor, setNewManualVendor]   = useState("");

  // ── WIP Milestone state ───────────────────────────────────────────────
  // wipTemplates: { "__default__": [...], "VENDOR NAME": [...], ... }
  const [wipTemplates, setWipTemplates] = useState<Record<string, WipTemplate[]>>({});
  const [milestones, setMilestones] = useState<Record<string, Milestone[]>>({});
  const [dcVendors, setDcVendors] = useState<DCVendor[]>([]);
  const [designTemplates, setDesignTemplates] = useState<any[]>([]);
  const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>({});
  const [tplVendor, setTplVendor] = useState("__default__"); // selected vendor in templates view
  const [showCreateTpl, setShowCreateTpl] = useState<string | null>(null); // vendor name to create template for

  // ── Outlook Email state ───────────────────────────────────────────────
  const [emailConfig, setEmailConfig] = useState(() => {
    try { return JSON.parse(localStorage.getItem("tandaEmailConfig") || "null") || { clientId: "", tenantId: "", emailMap: {} }; }
    catch { return { clientId: "", tenantId: "", emailMap: {} }; }
  });
  const [msToken, setMsToken] = useState<string | null>(() => {
    try { const s = JSON.parse(localStorage.getItem("ms_tokens_v1") || "null"); if (s?.accessToken && s.expiresAt > Date.now()) return s.accessToken; } catch (_) {}
    return null;
  });
  const [msDisplayName, setMsDisplayName] = useState<string>("");
  // emailToken / teamsToken are aliases to the shared msToken
  const emailToken = msToken;
  const teamsToken = msToken;
  const [emailTokenExpiry] = useState<number | null>(null); // kept for legacy checks, expiry handled by getMsAccessToken
  const [showEmailConfig, setShowEmailConfig] = useState(false);
  const [emailSelPO, setEmailSelPO] = useState<string | null>(null);
  const [emailsMap, setEmailsMap] = useState<Record<string, any[]>>({});
  const [emailLoadingMap, setEmailLoadingMap] = useState<Record<string, boolean>>({});
  const [emailErrorsMap, setEmailErrorsMap] = useState<Record<string, string | null>>({});
  const [emailSelMsg, setEmailSelMsg] = useState<any>(null);
  const [emailThreadMsgs, setEmailThreadMsgs] = useState<any[]>([]);
  const [emailThreadLoading, setEmailThreadLoading] = useState(false);
  const [emailTabCur, setEmailTabCur] = useState<"inbox" | "sent" | "thread" | "compose">("inbox");
  const [emailSentMap, setEmailSentMap] = useState<Record<string, any[]>>({});
  const [emailSentLoading, setEmailSentLoading] = useState<Record<string, boolean>>({});
  const [emailSentErr, setEmailSentErrMap] = useState<Record<string, string | null>>({});
  const [emailComposeTo, setEmailComposeTo] = useState("");
  const [emailComposeSubject, setEmailComposeSubject] = useState("");
  const [emailComposeBody, setEmailComposeBody] = useState("");
  const [emailSendErr, setEmailSendErr] = useState<string | null>(null);
  const [emailNextLinks, setEmailNextLinks] = useState<Record<string, string | null>>({});
  const [emailLoadingOlder, setEmailLoadingOlder] = useState(false);
  const [emailLastRefresh, setEmailLastRefresh] = useState<Record<string, number>>({});
  const [emailReply, setEmailReply] = useState("");
  const [emailConfigForm, setEmailConfigForm] = useState({ clientId: "", tenantId: "", emailMap: {} });
  const [emailPOSearch, setEmailPOSearch] = useState("");
  // ── Teams state ────────────────────────────────────────────────────────────
  const [teamsChannelMap, setTeamsChannelMap] = useState<Record<string, { channelId: string; teamId: string }>>({});
  const [teamsTeamId, setTeamsTeamId] = useState("");
  const [teamsSelPO, setTeamsSelPO] = useState<string | null>(null);
  const [teamsMessages, setTeamsMessages] = useState<Record<string, any[]>>({});
  const [teamsLoading, setTeamsLoading] = useState<Record<string, boolean>>({});
  const [teamsCreating, setTeamsCreating] = useState<string | null>(null);
  const [teamsNewMsg, setTeamsNewMsg] = useState("");
  const [teamsAuthStatus, setTeamsAuthStatus] = useState<"idle"|"loading"|"error">("idle");
  const [teamsSearchPO, setTeamsSearchPO] = useState("");
  const [teamsDirectTo, setTeamsDirectTo] = useState("");
  const [teamsDirectMsg, setTeamsDirectMsg] = useState("");
  const [teamsDirectSending, setTeamsDirectSending] = useState(false);
  const [teamsDirectErr, setTeamsDirectErr] = useState<string | null>(null);
  const [teamsTab, setTeamsTab] = useState<"channels"|"direct">("channels");
  const [dmConversations, setDmConversations] = useState<DmConversation[]>([]);
  const [dmActiveChatId, setDmActiveChatId] = useState<string | null>(null);
  const [dmComposing, setDmComposing] = useState(true);
  const [dmSelectedName, setDmSelectedName] = useState("");
  const [dmLoading, setDmLoading] = useState(false);
  const [dmError, setDmError] = useState<string | null>(null);
  const [dmNewMsg, setDmNewMsg] = useState("");
  const [dmSending, setDmSending] = useState(false);
  const dmScrollRef = useRef<HTMLDivElement>(null);
  const dmPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const TEAMS_PURPLE = "#5b5ea6";
  const TEAMS_PURPLE_LT = "#7b83eb";
  // ── Teams contacts (for DM recipient dropdown) ───────────────────────────
  const [teamsContacts, setTeamsContacts] = useState<any[]>([]);
  const [teamsContactsLoading, setTeamsContactsLoading] = useState(false);
  const [teamsContactSearch, setTeamsContactSearch] = useState("");
  const [teamsContactDropdown, setTeamsContactDropdown] = useState(false);
  const [teamsContactSearchResults, setTeamsContactSearchResults] = useState<any[]>([]);
  const [teamsContactSearchLoading, setTeamsContactSearchLoading] = useState(false);
  const [teamsContactsError, setTeamsContactsError] = useState<string | null>(null);
  const teamsContactSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ── Detail-panel Teams DM state ──────────────────────────────────────────
  const [dtlDMTo, setDtlDMTo] = useState("");
  const [dtlDMMsg, setDtlDMMsg] = useState("");
  const [dtlDMSending, setDtlDMSending] = useState(false);
  const [dtlDMErr, setDtlDMErr] = useState<string | null>(null);
  const [dtlDMContactSearch, setDtlDMContactSearch] = useState("");
  const [dtlDMContactDropdown, setDtlDMContactDropdown] = useState(false);
  const [dtlDMContactSearchResults, setDtlDMContactSearchResults] = useState<any[]>([]);
  const [dtlDMContactSearchLoading, setDtlDMContactSearchLoading] = useState(false);
  const dtlDMContactSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Detail-panel email tab state (separate from main email view)
  const [dtlEmails, setDtlEmails] = useState<Record<string, any[]>>({});
  const [dtlEmailLoading, setDtlEmailLoading] = useState<Record<string, boolean>>({});
  const [dtlEmailErr, setDtlEmailErr] = useState<Record<string, string | null>>({});
  const [dtlEmailSel, setDtlEmailSel] = useState<any>(null);
  const [dtlEmailThread, setDtlEmailThread] = useState<any[]>([]);
  const [dtlThreadLoading, setDtlThreadLoading] = useState(false);
  const [dtlEmailTab, setDtlEmailTab] = useState<"inbox" | "sent" | "thread" | "compose" | "teams">("inbox");
  const [dtlSentEmails, setDtlSentEmails] = useState<Record<string, any[]>>({});
  const [dtlSentLoading, setDtlSentLoading] = useState<Record<string, boolean>>({});
  const [dtlComposeTo, setDtlComposeTo] = useState("");
  const [dtlComposeSubject, setDtlComposeSubject] = useState("");
  const [dtlComposeBody, setDtlComposeBody] = useState("");
  const [dtlSendErr, setDtlSendErr] = useState<string | null>(null);
  const [dtlReply, setDtlReply] = useState("");
  const [dtlNextLink, setDtlNextLink] = useState<Record<string, string | null>>({});
  const [dtlLoadingOlder, setDtlLoadingOlder] = useState(false);
  // ── New 3-panel email UI state (main email view) ──────────────────────────
  const [emailActiveFolder, setEmailActiveFolder] = useState<"inbox" | "sent">("inbox");
  const [emailSearchQuery, setEmailSearchQuery] = useState("");
  const [emailFilterUnread, setEmailFilterUnread] = useState(false);
  const [emailFilterFlagged, setEmailFilterFlagged] = useState(false);
  const [emailFlaggedSet, setEmailFlaggedSet] = useState(new Set<string>());
  const [emailCollapsedMsgs, setEmailCollapsedMsgs] = useState(new Set<string>());
  const [emailComposeOpen, setEmailComposeOpen] = useState(false);
  const [emailDeleteConfirm, setEmailDeleteConfirm] = useState<string | null>(null);
  const [emailReplyText, setEmailReplyText] = useState("");
  const [emailSelectedId, setEmailSelectedId] = useState<string | null>(null);
  const [emailCtxMenu, setEmailCtxMenu] = useState<{ x: number; y: number; em: any } | null>(null);
  const [emailAttachments, setEmailAttachments] = useState<Record<string, any[]>>({});
  const [emailAttachmentsLoading, setEmailAttachmentsLoading] = useState<Record<string, boolean>>({});

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
        const stored = await (async () => { try { const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.teams_team_id&select=value`, { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }); const rows = await res.json(); return rows?.length ? JSON.parse(rows[0].value) : null; } catch(_) { return null; } })();
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
      const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.po_teams_channel_map&select=value`, { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } });
      const rows = await res.json();
      if (rows?.length) setTeamsChannelMap(JSON.parse(rows[0].value) || {});
      const res2 = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.teams_team_id&select=value`, { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } });
      const rows2 = await res2.json();
      if (rows2?.length) setTeamsTeamId(JSON.parse(rows2[0].value) || "");
    } catch(e) { console.error("Teams: load channel map error", e); }
  }
  async function teamsSbSave(key: string, value: any) {
    await fetch(`${SB_URL}/rest/v1/app_data`, { method: "POST", headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, value: JSON.stringify(value) }) });
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
    } catch(e: any) { alert("Could not start Teams chat: " + e.message); }
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
    } catch(e: any) { alert("Failed to send: " + e.message); }
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
        return prev.map(c => c.chatId === chatId ? { ...c, messages: msgs } : c);
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
    const poList2 = pos.filter(p => {
      const s = teamsSearchPO.toLowerCase();
      return !s || (p.PoNumber ?? "").toLowerCase().includes(s) || (p.VendorName ?? "").toLowerCase().includes(s);
    });
    const mp = teamsSelPO ? teamsChannelMap[teamsSelPO] : null;
    const msgs = (teamsSelPO ? teamsMessages[teamsSelPO] : null) || [];
    const isLoadingMsgs = teamsSelPO ? !!teamsLoading[teamsSelPO] : false;
    const isCreating = teamsSelPO ? teamsCreating === teamsSelPO : false;
    const selPO = teamsSelPO ? pos.find(p => p.PoNumber === teamsSelPO) : null;
    return (
      <div style={{ position: "relative" }}>
        <button onClick={() => setView("dashboard")} title="Close Teams"
          style={{ position: "absolute", top: 10, right: 10, zIndex: 10, width: 28, height: 28, borderRadius: "50%", border: `1px solid ${TEAMS_PURPLE}44`, background: `${TEAMS_PURPLE}15`, color: TEAMS_PURPLE, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>✕</button>
        {teamsTab !== "direct" && teamsSelPO && mp && teamsToken && (
          <button onClick={() => teamsLoadPOMessages(teamsSelPO)} title="Refresh messages"
            style={{ position: "absolute", top: 10, right: 46, zIndex: 10, height: 28, padding: "0 10px", borderRadius: 6, border: "1px solid #334155", background: "none", color: "#6B7280", cursor: "pointer", fontFamily: "inherit", fontSize: 11, display: "flex", alignItems: "center" }}>↻ Refresh</button>
        )}
        <div style={{ display: "flex", height: "calc(100vh - 140px)", minHeight: 500, background: "#1E293B", borderRadius: 12, border: "1px solid #334155", overflow: "hidden" }}>
          {/* LEFT: PO list */}
          <div style={{ width: 280, flexShrink: 0, borderRight: "1px solid #334155", display: "flex", flexDirection: "column", background: "#0F172A" }}>
            <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid #334155", flexShrink: 0 }}>
              <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6B7280" }}>Purchase Orders</span>
            </div>
            <div style={{ padding: "8px 16px", borderBottom: "1px solid #334155", flexShrink: 0 }}>
              <input value={teamsSearchPO} onChange={e => setTeamsSearchPO(e.target.value)} placeholder="🔍 Search PO#, vendor…" style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 6, padding: "7px 10px", color: "#F1F5F9", fontSize: 12, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
            </div>
            <div style={{ padding: "10px 16px", borderBottom: "1px solid #334155", background: teamsToken ? "#064E3B44" : "#78350F44", flexShrink: 0 }}>
              {teamsToken ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, color: "#34D399", fontWeight: 600 }}>✓ {msDisplayName || "Connected to Microsoft"}</span>
                  <button onClick={msSignOut} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, border: "1px solid #34D39944", background: "none", color: "#34D399", cursor: "pointer", fontFamily: "inherit" }}>Sign out</button>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 11, color: "#FBBF24", fontWeight: 600, marginBottom: 6 }}>{teamsAuthStatus === "error" ? "Sign-in failed" : "Sign in to use Teams"}</div>
                  {(!MS_CLIENT_ID || !MS_TENANT_ID) ? (
                    <div style={{ fontSize: 11, color: "#D97706" }}>Azure credentials not configured</div>
                  ) : (
                    <button onClick={authenticateTeams} disabled={teamsAuthStatus === "loading"} style={{ ...S.btnPrimary, fontSize: 11, padding: "5px 12px", width: "auto" }}>{teamsAuthStatus === "loading" ? "Signing in…" : "Sign in with Microsoft"}</button>
                  )}
                </div>
              )}
            </div>
            {/* Tabs: Channels | Direct Message */}
            <div style={{ display: "flex", borderBottom: "1px solid #334155", flexShrink: 0 }}>
              {(["channels","direct"] as const).map(t => (
                <button key={t} onClick={() => setTeamsTab(t)} style={{ flex: 1, padding: "9px 0", fontSize: 11, fontWeight: 700, fontFamily: "inherit", border: "none", borderBottom: teamsTab === t ? `2px solid ${TEAMS_PURPLE}` : "2px solid transparent", background: "none", color: teamsTab === t ? TEAMS_PURPLE_LT : "#6B7280", cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  {t === "channels" ? "PO Channels" : "Direct Message"}
                </button>
              ))}
            </div>
            {teamsTab === "channels" && (
            <div style={{ flex: 1, overflowY: "auto" }}>
              {poList2.map(po => {
                const poNum = po.PoNumber ?? "";
                const isSelected = teamsSelPO === poNum;
                const hasCh = !!teamsChannelMap[poNum];
                const msgCount = (teamsMessages[poNum] || []).length;
                const color = STATUS_COLORS[po.StatusName ?? ""] ?? "#6B7280";
                return (
                  <div key={poNum} onClick={() => { setTeamsSelPO(poNum === teamsSelPO ? null : poNum); }}
                    style={{ padding: "11px 16px", borderBottom: "1px solid #1E293B", cursor: "pointer", background: isSelected ? `${TEAMS_PURPLE}22` : "transparent", borderLeft: isSelected ? `3px solid ${TEAMS_PURPLE}` : "3px solid transparent", transition: "all 0.12s" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: isSelected ? TEAMS_PURPLE_LT : "#F1F5F9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>PO# {poNum}</div>
                        <div style={{ fontSize: 11, color: "#6B7280" }}>{po.VendorName ?? ""}</div>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                        <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 10, background: hasCh ? "#064E3B" : "#1E293B", color: hasCh ? "#34D399" : "#6B7280", border: hasCh ? "none" : "1px solid #334155", fontWeight: 700 }}>{hasCh ? "ACTIVE" : "NO CHAT"}</span>
                        {msgCount > 0 && <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 10, background: TEAMS_PURPLE, color: "#fff", fontWeight: 700 }}>{msgCount}</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
              {poList2.length === 0 && <div style={{ padding: 24, fontSize: 13, color: "#6B7280", textAlign: "center" }}>No POs found</div>}
            </div>
            )}
            {teamsTab === "direct" && (
            <div style={{ flex: 1, overflowY: "auto" }}>
              {!teamsToken ? (
                <div style={{ textAlign: "center", padding: "40px 20px" }}>
                  <div style={{ fontSize: 32, marginBottom: 10 }}>🔒</div>
                  <div style={{ fontSize: 13, color: "#94A3B8", marginBottom: 12 }}>Sign in with Microsoft</div>
                  <button onClick={authenticateTeams} disabled={teamsAuthStatus === "loading"} style={{ ...S.btnPrimary, fontSize: 12, padding: "8px 18px", width: "auto" }}>{teamsAuthStatus === "loading" ? "Signing in…" : "Sign in with Microsoft"}</button>
                </div>
              ) : (
                <>
                  <div style={{ padding: "10px 12px 6px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 10, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: "#6B7280", fontWeight: 600 }}>Direct Messages</span>
                    <button onClick={() => { setDmActiveChatId(null); setDmComposing(true); setTeamsDirectTo(""); setTeamsDirectMsg(""); setDmSelectedName(""); setDmError(null); setTeamsDirectErr(null); }}
                      style={{ fontSize: 10, padding: "3px 8px", borderRadius: 5, border: `1px solid ${TEAMS_PURPLE}44`, background: `${TEAMS_PURPLE}15`, color: TEAMS_PURPLE_LT, cursor: "pointer", fontFamily: "inherit" }}>
                      ✎ New
                    </button>
                  </div>
                  {dmConversations.length === 0 && (
                    <div style={{ padding: "12px 14px", fontSize: 12, color: "#6B7280" }}>No conversations yet. Use ✎ New to start one.</div>
                  )}
                  {dmConversations.map(conv => (
                    <div key={conv.chatId}
                      onClick={() => { setDmActiveChatId(conv.chatId); setDmComposing(false); }}
                      style={{ padding: "8px 12px", cursor: "pointer", background: conv.chatId === dmActiveChatId && !dmComposing ? `${TEAMS_PURPLE}22` : "transparent", borderLeft: conv.chatId === dmActiveChatId && !dmComposing ? `3px solid ${TEAMS_PURPLE}` : "3px solid transparent", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid #1E293B" }}>
                      <div style={{ width: 28, height: 28, borderRadius: "50%", background: `${TEAMS_PURPLE}33`, border: `2px solid ${TEAMS_PURPLE}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: TEAMS_PURPLE_LT, flexShrink: 0 }}>
                        {(conv.recipientName || conv.recipient).slice(0, 2).toUpperCase()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: conv.chatId === dmActiveChatId && !dmComposing ? TEAMS_PURPLE_LT : "#F1F5F9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{conv.recipientName || conv.recipient}</div>
                        <div style={{ fontSize: 10, color: "#6B7280", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{conv.messages.length > 0 ? (conv.messages[conv.messages.length - 1]?.body?.content || "").replace(/<[^>]+>/g, "").trim() || "Message" : "No messages yet"}</div>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
            )}
          </div>
          {/* RIGHT: chat panel */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {teamsTab === "direct" ? (
              !teamsToken ? (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#6B7280" }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>🔒</div>
                  <div style={{ fontSize: 14, color: "#94A3B8", marginBottom: 12 }}>Sign in to use Direct Message</div>
                  <button onClick={authenticateTeams} disabled={teamsAuthStatus === "loading"} style={{ ...S.btnPrimary, fontSize: 13, padding: "9px 20px", width: "auto" }}>{teamsAuthStatus === "loading" ? "Signing in…" : "Sign in with Microsoft"}</button>
                </div>
              ) : dmComposing || !dmActiveChatId ? (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                  <div style={{ padding: "16px 24px 12px", borderBottom: "1px solid #334155", background: "#1E293B", flexShrink: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#F1F5F9" }}>New Direct Message</div>
                    <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>Send a Teams DM to any team member</div>
                  </div>
                  <div style={{ flex: 1, padding: "20px 24px", overflowY: "auto" }}>
                    <div style={{ marginBottom: 14, position: "relative" as const }}>
                      <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 5 }}>
                        {teamsContactsLoading
                          ? "Loading contacts…"
                          : teamsContactsError
                            ? <span style={{ color: "#F87171" }}>⚠ {teamsContactsError} — <button onClick={loadTeamsContacts} style={{ background: "none", border: "none", color: TEAMS_PURPLE_LT, cursor: "pointer", fontFamily: "inherit", fontSize: 12, padding: 0, textDecoration: "underline" }}>retry</button> or sign out &amp; back in</span>
                            : teamsContacts.length > 0
                              ? `To — ${teamsContacts.length} contacts loaded · type to search all`
                              : "To — type name or email"}
                      </div>
                      <input value={teamsDirectTo}
                        onChange={e => handleTeamsContactInput(e.target.value, "main")}
                        onFocus={() => { setTeamsContactSearch(teamsDirectTo); setTeamsContactDropdown(true); }}
                        onBlur={() => setTimeout(() => setTeamsContactDropdown(false), 150)}
                        placeholder={teamsContactsLoading ? "Loading contacts…" : "Search name or type email…"}
                        style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 7, padding: "9px 12px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const }} />
                      {teamsContactDropdown && (() => {
                        const q = (teamsContactSearch || "").toLowerCase();
                        const list = teamsContactSearchResults.length > 0
                          ? teamsContactSearchResults
                          : teamsContacts.filter((c: any) =>
                              !q ||
                              (c.displayName || "").toLowerCase().includes(q) ||
                              (c.userPrincipalName || "").toLowerCase().includes(q) ||
                              (c.scoredEmailAddresses?.[0]?.address || "").toLowerCase().includes(q) ||
                              (c.mail || "").toLowerCase().includes(q)
                            );
                        if (list.length === 0 && !teamsContactSearchLoading) return null;
                        return (
                          <div style={{ position: "absolute" as const, top: "100%", left: 0, right: 0, zIndex: 200, background: "#1E293B", border: "1px solid #475569", borderRadius: 8, maxHeight: 220, overflowY: "auto" as const, boxShadow: "0 8px 24px rgba(0,0,0,0.5)", marginTop: 2 }}>
                            {teamsContactSearchLoading && <div style={{ padding: "8px 14px", fontSize: 12, color: "#6B7280" }}>Searching…</div>}
                            {list.slice(0, 15).map((c: any) => {
                              const email = c.userPrincipalName || c.mail || c.scoredEmailAddresses?.[0]?.address || "";
                              return (
                                <div key={email || c.displayName}
                                  onMouseDown={() => {
                                    const existing = dmConversations.find(conv => conv.recipient.toLowerCase() === email.toLowerCase());
                                    if (existing) {
                                      setDmActiveChatId(existing.chatId);
                                      setDmComposing(false);
                                      setTeamsDirectTo("");
                                    } else {
                                      setTeamsDirectTo(email);
                                      setDmSelectedName(c.displayName || email);
                                    }
                                    setTeamsContactDropdown(false); setTeamsContactSearch(""); setTeamsContactSearchResults([]); setTeamsDirectErr(null);
                                  }}
                                  style={{ padding: "9px 14px", cursor: "pointer", borderBottom: "1px solid #334155" }}>
                                  <div style={{ fontSize: 13, fontWeight: 600, color: "#F1F5F9" }}>{c.displayName}</div>
                                  <div style={{ fontSize: 11, color: "#6B7280" }}>{email}</div>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </div>
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 5 }}>Message</div>
                      <textarea value={teamsDirectMsg} onChange={e => { setTeamsDirectMsg(e.target.value); setTeamsDirectErr(null); }}
                        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); teamsSendDirect(); } }}
                        placeholder="Type your message… (Enter to send)" rows={6}
                        style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 7, padding: "9px 12px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit", resize: "vertical" as const, boxSizing: "border-box" as const }} />
                    </div>
                    {teamsDirectErr && (
                      <div style={{ background: "#1E293B", border: "1px solid #EF444444", borderRadius: 8, padding: "10px 14px", color: "#EF4444", fontSize: 12, marginBottom: 12 }}>⚠ {teamsDirectErr}</div>
                    )}
                    <button onClick={teamsSendDirect} disabled={teamsDirectSending || !teamsDirectTo.trim() || !teamsDirectMsg.trim()}
                      style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "11px 24px", fontSize: 13, fontWeight: 700, cursor: teamsDirectSending ? "wait" : "pointer", fontFamily: "inherit", opacity: (teamsDirectSending || !teamsDirectTo.trim() || !teamsDirectMsg.trim()) ? 0.6 : 1 }}>
                      {teamsDirectSending ? "Sending…" : "Send Direct Message ↗"}
                    </button>
                  </div>
                </div>
              ) : (() => {
                const activeConv = dmConversations.find(c => c.chatId === dmActiveChatId) ?? null;
                const dmRecipientDisplay = activeConv?.recipientName || activeConv?.recipient || "";
                const dmMsgs = activeConv?.messages ?? [];
                return (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                  <div style={{ padding: "14px 50px 14px 20px", borderBottom: "1px solid #334155", background: "#1E293B", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                    <div style={{ width: 34, height: 34, borderRadius: "50%", background: `${TEAMS_PURPLE}33`, border: `2px solid ${TEAMS_PURPLE}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: TEAMS_PURPLE_LT, flexShrink: 0 }}>{dmRecipientDisplay.slice(0, 2).toUpperCase()}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#F1F5F9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dmRecipientDisplay}</div>
                      <div style={{ fontSize: 11, color: "#6B7280" }}>Direct Message · Teams</div>
                    </div>
                    <button onClick={() => dmActiveChatId && loadDmMessages(dmActiveChatId)} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #334155", background: "none", color: "#6B7280", cursor: "pointer", fontFamily: "inherit" }}>↻ Refresh</button>
                  </div>
                  {dmError && (
                    <div style={{ background: "#1E293B", borderBottom: "1px solid #EF444444", padding: "8px 20px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                      <span style={{ fontSize: 12, color: "#EF4444", flex: 1 }}>⚠ {dmError}</span>
                      <button onClick={() => setDmError(null)} style={{ border: "none", background: "none", color: "#EF4444", cursor: "pointer", fontFamily: "inherit", fontSize: 14 }}>✕</button>
                    </div>
                  )}
                  <div ref={dmScrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
                    {dmLoading ? (
                      <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 40, fontSize: 13 }}>Loading messages…</div>
                    ) : dmMsgs.length === 0 ? (
                      <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 40, fontSize: 13 }}>No messages yet in this conversation</div>
                    ) : dmMsgs.map((msg: any) => {
                      const author = msg.from?.user?.displayName || "Unknown";
                      const initials = author.split(" ").map((w: string) => w[0] || "").join("").toUpperCase().slice(0, 2);
                      const clean = (msg.body?.content || "").replace(/<[^>]+>/g, "").trim();
                      const time = msg.createdDateTime ? new Date(msg.createdDateTime).toLocaleString() : "";
                      return (
                        <div key={msg.id} style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 10, padding: "12px 16px" }}>
                          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                            <div style={{ width: 32, height: 32, borderRadius: "50%", background: `${TEAMS_PURPLE}33`, border: `2px solid ${TEAMS_PURPLE}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: TEAMS_PURPLE_LT, flexShrink: 0 }}>{initials}</div>
                            <div style={{ flex: 1 }}>
                              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                                <span style={{ fontSize: 13, fontWeight: 700, color: "#F1F5F9" }}>{author}</span>
                                <span style={{ fontSize: 11, color: "#6B7280" }}>{time}</span>
                              </div>
                              <div style={{ fontSize: 13, color: "#CBD5E1", lineHeight: 1.5, wordBreak: "break-word" }}>{clean || "[Attachment]"}</div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ padding: "12px 20px", borderTop: "1px solid #334155", background: "#1E293B", display: "flex", gap: 10, flexShrink: 0 }}>
                    <input value={dmNewMsg} onChange={e => setDmNewMsg(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendDmReply(); }}}
                      placeholder={`Reply to ${dmRecipientDisplay}…`}
                      style={{ flex: 1, background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit" }} />
                    <button onClick={sendDmReply} disabled={dmSending || !dmNewMsg.trim()}
                      style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "10px 20px", fontSize: 12, fontWeight: 700, cursor: (dmSending || !dmNewMsg.trim()) ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: (dmSending || !dmNewMsg.trim()) ? 0.5 : 1 }}>
                      {dmSending ? "…" : "Send"}
                    </button>
                  </div>
                </div>
                );
              })()
            ) : !teamsSelPO ? (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#6B7280" }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>💬</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: "#94A3B8", marginBottom: 6 }}>Select a PO to open its chat</div>
                <div style={{ fontSize: 13 }}>Each PO gets its own Teams channel in RING OF FIRE</div>
              </div>
            ) : (
              <>
                <div style={{ padding: "14px 90px 14px 20px", borderBottom: "1px solid #334155", background: "#1E293B", flexShrink: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#F1F5F9" }}>PO# {teamsSelPO}</div>
                  <div style={{ fontSize: 12, color: "#6B7280" }}>{selPO?.VendorName ?? ""}{selPO?.StatusName ? " · " + selPO.StatusName : ""}</div>
                </div>
                <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
                  {!teamsToken ? (
                    <div style={{ textAlign: "center", paddingTop: 60 }}>
                      <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "#94A3B8", marginBottom: 8 }}>Sign in to use Teams chat</div>
                      <button onClick={authenticateTeams} disabled={teamsAuthStatus === "loading"} style={{ ...S.btnPrimary, fontSize: 12, padding: "8px 18px", width: "auto" }}>{teamsAuthStatus === "loading" ? "Signing in…" : "Sign in with Microsoft"}</button>
                    </div>
                  ) : !mp ? (
                    <div style={{ textAlign: "center", paddingTop: 60 }}>
                      <div style={{ fontSize: 36, marginBottom: 12 }}>💬</div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "#94A3B8", marginBottom: 6 }}>No Teams channel yet for this PO</div>
                      <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 20 }}>A channel will be created in RING OF FIRE</div>
                      <button onClick={() => teamsStartChat(teamsSelPO!)} disabled={!!isCreating}
                        style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "10px 22px", fontFamily: "inherit", fontSize: 13, fontWeight: 700, cursor: isCreating ? "wait" : "pointer", opacity: isCreating ? 0.7 : 1 }}>
                        {isCreating ? "Creating channel…" : "💬 Start Teams Chat"}
                      </button>
                    </div>
                  ) : isLoadingMsgs ? (
                    <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 40, fontSize: 13 }}>Loading messages…</div>
                  ) : msgs.length === 0 ? (
                    <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 40 }}>
                      <div style={{ fontSize: 28, marginBottom: 8 }}>💬</div>
                      <div style={{ fontSize: 13 }}>No messages yet — start the conversation!</div>
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {msgs.map((msg: any) => {
                        const author = msg.from?.user?.displayName || "Unknown";
                        const initials = author.split(" ").map((w: string) => w[0] || "").join("").toUpperCase().slice(0, 2);
                        const clean = (msg.body?.content || "").replace(/<[^>]+>/g, "").trim();
                        const time = msg.createdDateTime ? new Date(msg.createdDateTime).toLocaleString() : "";
                        return (
                          <div key={msg.id} style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 10, padding: "12px 16px" }}>
                            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                              <div style={{ width: 34, height: 34, borderRadius: "50%", background: `${TEAMS_PURPLE}33`, border: `2px solid ${TEAMS_PURPLE}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: TEAMS_PURPLE_LT, flexShrink: 0 }}>{initials}</div>
                              <div style={{ flex: 1 }}>
                                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                                  <span style={{ fontSize: 13, fontWeight: 700, color: "#F1F5F9" }}>{author}</span>
                                  <span style={{ fontSize: 11, color: "#6B7280" }}>{time}</span>
                                </div>
                                <div style={{ fontSize: 13, color: "#CBD5E1", lineHeight: 1.5, wordBreak: "break-word" }}>{clean || "[Attachment]"}</div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                {mp && teamsToken && (
                  <div style={{ padding: "12px 20px", borderTop: "1px solid #334155", background: "#1E293B", display: "flex", gap: 10, flexShrink: 0 }}>
                    <input value={teamsNewMsg} onChange={e => setTeamsNewMsg(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); teamsSendMessage(teamsSelPO!); }}} placeholder={`Message PO# ${teamsSelPO}…`}
                      style={{ flex: 1, background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit" }} />
                    <button onClick={() => teamsSendMessage(teamsSelPO!)} disabled={!teamsNewMsg.trim()} style={{ ...S.btnPrimary, opacity: teamsNewMsg.trim() ? 1 : 0.5, width: "auto" }}>Send</button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    );
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
  async function loadEmailAttachments(messageId: string) {
    if (emailAttachments[messageId] !== undefined) return;
    setEmailAttachmentsLoading(a => ({ ...a, [messageId]: true }));
    try {
      const tok = await getGraphToken();
      const r = await fetch("https://graph.microsoft.com/v1.0/me/messages/" + messageId + "/attachments", { headers: { Authorization: "Bearer " + tok } });
      const d = await r.json();
      setEmailAttachments(a => ({ ...a, [messageId]: d.value || [] }));
    } catch { setEmailAttachments(a => ({ ...a, [messageId]: [] })); }
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
      await emailGraphDelete("/me/messages/" + messageId);
      setEmailSelectedId(null);
      setEmailSelMsg(null);
      setEmailDeleteConfirm(null);
      setEmailThreadMsgs([]);
      if (emailSelPO) {
        const filterOut = (arr: any[]) => arr.filter((e: any) => e.id !== messageId);
        setEmailsMap(m => ({ ...m, [emailSelPO]: filterOut(m[emailSelPO] || []) }));
        setEmailSentMap(m => ({ ...m, [emailSelPO]: filterOut(m[emailSelPO] || []) }));
        setDtlEmails(m => ({ ...m, [emailSelPO]: filterOut(m[emailSelPO] || []) }));
        setDtlSentEmails(m => ({ ...m, [emailSelPO]: filterOut(m[emailSelPO] || []) }));
      }
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
        message: { subject: dtlComposeSubject, body: { contentType: "HTML", content: dtlComposeBody || " " }, toRecipients: dtlComposeTo.split(",").map(e => ({ emailAddress: { address: e.trim() } })) },
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
    const { data } = await sb.from("tanda_pos").select("*", "order=date_order.desc");
    if (data && data.length > 0) {
      setPos(data.map((r: any) => r.data as XoroPO));
      setLastSync(data[0]?.synced_at ?? "");
    }
    setLoading(false);
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
    // Conflict detection: check if another user modified this milestone since we loaded it
    if (existing) {
      const { data: currentRow } = await sb.from("tanda_milestones").single("id,data", `id=eq.${encodeURIComponent(m.id)}`);
      const serverData = (currentRow as any)?.data as Milestone | undefined;
      if (serverData && serverData.updated_at && serverData.updated_at !== existing.updated_at) {
        // Conflict detected — let user decide
        setConfirmModal({
          title: "Conflict Detected",
          message: `"${m.phase}" was modified by ${serverData.updated_by || "another user"}.\n\nTheir status: ${serverData.status} · Your status: ${m.status}\n\nOverwrite with your changes?`,
          icon: "⚠️",
          confirmText: "Use Mine",
          cancelText: "Keep Theirs",
          confirmColor: "#3B82F6",
          onConfirm: async () => {
            await sb.from("tanda_milestones").upsert({ id: m.id, data: m }, { onConflict: "id" });
            setMilestones(prev => {
              const arr = [...(prev[m.po_number] || [])];
              const idx2 = arr.findIndex(x => x.id === m.id);
              if (idx2 >= 0) arr[idx2] = m; else arr.push(m);
              return { ...prev, [m.po_number]: arr };
            });
          },
          onCancel: async () => { await loadAllMilestones(); },
        });
        return; // Don't save yet — modal callbacks handle it
      }
    }
    await sb.from("tanda_milestones").upsert({ id: m.id, data: m }, { onConflict: "id" });
    setMilestones(prev => {
      const arr = [...(prev[m.po_number] || [])];
      const idx = arr.findIndex(x => x.id === m.id);
      if (idx >= 0) arr[idx] = m; else arr.push(m);
      return { ...prev, [m.po_number]: arr };
    });
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
    setMilestones(prev => {
      const next = { ...prev };
      ms.forEach(m => {
        if (!next[m.po_number]) next[m.po_number] = [];
        const arr = [...next[m.po_number]];
        const idx = arr.findIndex(x => x.id === m.id);
        if (idx >= 0) arr[idx] = m; else arr.push(m);
        next[m.po_number] = arr;
      });
      return next;
    });
  }

  async function deleteMilestonesForPO(poNumber: string) {
    // Load all milestone IDs for this PO, then delete them
    const existing = milestones[poNumber] || [];
    for (const m of existing) {
      await sb.from("tanda_milestones").delete(`id=eq.${encodeURIComponent(m.id)}`);
    }
    setMilestones(prev => { const next = { ...prev }; delete next[poNumber]; return next; });
  }

  function generateMilestones(poNumber: string, ddpDate: string, vendorName?: string): Milestone[] {
    const templates = getVendorTemplates(vendorName);
    const ddp = new Date(ddpDate);
    if (isNaN(ddp.getTime())) return [];

    return templates.map((tpl, i) => {
      const daysB = tpl.daysBeforeDDP;
      const expected = new Date(ddp);
      expected.setDate(expected.getDate() - daysB);
      return {
        id: milestoneUid(),
        po_number: poNumber,
        phase: tpl.phase,
        category: tpl.category,
        sort_order: i,
        days_before_ddp: daysB,
        expected_date: expected.toISOString().slice(0, 10),
        actual_date: null,
        status: "Not Started",
        status_date: null,
        status_dates: null,
        notes: "",
        note_entries: null,
        updated_at: new Date().toISOString(),
        updated_by: user?.name || "",
      };
    });
  }

  function mergeMilestones(existing: Milestone[], fresh: Milestone[]): Milestone[] {
    return fresh.map(f => {
      const old = existing.find(e => e.phase === f.phase);
      if (old && (old.actual_date || old.status !== "Not Started" || old.notes)) {
        return { ...f, id: old.id, actual_date: old.actual_date, status: old.status, notes: old.notes };
      }
      return f;
    });
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
        setMilestones(prev => ({ ...prev, [poNum]: dbExisting }));
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
    const existing = milestones[poNum] || [];
    const fresh = generateMilestones(poNum, ddp, po.VendorName);
    const merged = mergeMilestones(existing, fresh);
    if (existing.length > 0) await deleteMilestonesForPO(poNum);
    await saveMilestones(merged);
    addHistory(poNum, `Milestones regenerated (${merged.length} phases)`);
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
    const next = [entry, ...syncLog].slice(0, 200); // keep last 200 entries
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
      const statusList = filters?.statuses?.length ? filters.statuses : ACTIVE_PO_STATUSES;
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

      let firstError: string | null = null;
      for (const result of statusResults) {
        if (result.status === "fulfilled") {
          all = [...all, ...result.value.pos];
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
      const changedPOs = synced.filter(po => {
        const cached = existingMap.get(po.PoNumber ?? "");
        if (!cached) return false;
        // Check header fields
        const headerChanged = (
          (po.StatusName           ?? "") !== (cached.StatusName           ?? "") ||
          (po.DateExpectedDelivery ?? "") !== (cached.DateExpectedDelivery ?? "") ||
          (po.VendorReqDate        ?? "") !== (cached.VendorReqDate        ?? "") ||
          String(po.TotalAmount    ?? 0)  !== String(cached.TotalAmount    ?? 0)  ||
          (po.VendorName           ?? "") !== (cached.VendorName           ?? "")
        );
        if (headerChanged) return true;
        // Check if line items have new fields (QtyReceived/QtyRemaining) that cached version doesn't
        const newItems = po.Items ?? [];
        const oldItems = cached.Items ?? [];
        if (newItems.length !== oldItems.length) return true;
        // If any line has QtyRemaining but cached doesn't, it's a change
        const hasNewFields = newItems.some((item: any) => item.QtyRemaining != null) && !oldItems.some((item: any) => item.QtyRemaining != null);
        if (hasNewFields) return true;
        // Check if any line item qty changed
        return newItems.some((item: any, i: number) => {
          const old = oldItems[i];
          if (!old) return true;
          return (item.QtyOrder ?? 0) !== (old.QtyOrder ?? 0) || (item.QtyReceived ?? 0) !== (old.QtyReceived ?? 0);
        });
      });
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
        await sb.from("tanda_pos").upsert(
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
      }

      setSyncProgress(88);
      setSyncProgressMsg("Removing closed/received POs…");

      const toDeleteFromSync = all.filter(po => autoDeleteStatuses.includes(po.StatusName ?? "") && !toKeep(po.StatusName ?? ""));
      const toDeleteFromCache = (existingRows ?? []).filter((r: any) => autoDeleteStatuses.includes((r.data as XoroPO)?.StatusName ?? "") && !toKeep((r.data as XoroPO)?.StatusName ?? ""));
      const toDeleteNums = new Set([
        ...toDeleteFromSync.map(po => po.PoNumber ?? ""),
        ...toDeleteFromCache.map((r: any) => r.po_number as string),
      ].filter(Boolean));
      for (const pn of toDeleteNums) {
        await deletePO(pn);
      }
      const deletedCount = toDeleteNums.size;

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

  // ── Realtime sync — poll every 10 seconds for changes from other users ──
  useEffect(() => {
    if (!user) return;

    const pollBusy = { current: false };
    const poll = async () => {
      if (pollBusy.current) return;
      pollBusy.current = true;
      try {
        // Quick check: fetch latest record hint from each table
        const [posRes, msRes, notesRes] = await Promise.all([
          fetch(`${SB_URL}/rest/v1/tanda_pos?select=po_number,synced_at&order=synced_at.desc&limit=1`, { headers: SB_HEADERS }),
          fetch(`${SB_URL}/rest/v1/tanda_milestones?select=id&order=id.desc&limit=1`, { headers: SB_HEADERS }),
          fetch(`${SB_URL}/rest/v1/tanda_notes?select=id,created_at&order=created_at.desc&limit=1`, { headers: SB_HEADERS }),
        ]);
        const [posData, msData, notesData] = await Promise.all([posRes.json(), msRes.json(), notesRes.json()]);
        const hash = JSON.stringify({ p: posData, m: msData, n: notesData });

        if (lastDataHashRef.current && hash !== lastDataHashRef.current) {
          await loadCachedPOs();
          await loadAllMilestones();
          await loadNotes();
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
    realtimeIntervalRef.current = setInterval(poll, 10000);

    return () => {
      if (realtimeIntervalRef.current) clearInterval(realtimeIntervalRef.current);
      realtimeIntervalRef.current = null;
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
    const da = a.DateExpectedDelivery ? new Date(a.DateExpectedDelivery).getTime() : Infinity;
    const db = b.DateExpectedDelivery ? new Date(b.DateExpectedDelivery).getTime() : Infinity;
    return da - db;
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
    const allMs = [...(milestones[poNum] || [])].sort((a, b) => a.sort_order - b.sort_order);
    const msIdx = allMs.findIndex(m => m.id === milestone.id);
    // Save the changed milestone — if new date is >= today and status is Delayed, reset to Not Started
    const today = new Date().toISOString().slice(0, 10);
    const resetStatus = (date: string, currentStatus: string) => {
      if (date >= today && currentStatus === "Delayed") return "Not Started";
      return currentStatus;
    };
    const newStatus = resetStatus(newDate, milestone.status);
    await saveMilestone({ ...milestone, expected_date: newDate, status: newStatus, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
    // Shift all subsequent milestones by the same number of days
    let shifted = 0;
    for (let i = msIdx + 1; i < allMs.length; i++) {
      const m = allMs[i];
      if (m.expected_date && m.status !== "Complete") {
        const d = new Date(m.expected_date);
        d.setDate(d.getDate() + diffDays);
        const newDateStr = d.toISOString().slice(0, 10);
        const mStatus = resetStatus(newDateStr, m.status);
        await saveMilestone({ ...m, expected_date: newDateStr, status: mStatus, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
        shifted++;
      }
    }
    if (shifted > 0) {
      addHistory(poNum, `Due date changed for "${milestone.phase}": ${oldDate} → ${newDate} (${diffDays > 0 ? "+" : ""}${diffDays}d). ${shifted} subsequent milestone${shifted > 1 ? "s" : ""} shifted.`);
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
    { keywords: ["bulk", "update", "multiple", "vendor"], answer: "**Bulk Milestone Update**\n\nClick **⚡ Bulk Update** in the nav bar.\n\n1. Select a **vendor**\n2. Optionally filter by **POs** (search + checkboxes)\n3. Optionally filter by **category** and **phases**\n4. Select the **new status**\n5. Preview shows how many milestones will be affected\n6. Click Update\n\nPOs without milestones will have them auto-generated before the update." },
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
    { keywords: ["template", "wip", "production template"], answer: "**Production Templates**\n\nClick **Templates** in the nav bar. Templates define the milestone phases for each vendor:\n• Default template applies to all vendors\n• Vendor-specific templates override the default\n• Each phase has: name, category, days before DDP\n• When a PO is opened for a vendor without a template, you're prompted to create one\n• Templates can be copied from existing vendors" },
    { keywords: ["conflict", "realtime", "sync", "multi-user", "other user"], answer: "**Multi-User & Conflict Handling**\n\nThe app syncs every 10 seconds. When another user makes changes, your view updates automatically.\n\nIf you and another user edit the same milestone simultaneously, a conflict dialog appears:\n• **Use Mine** — saves your version\n• **Keep Theirs** — reloads the server version\n\nNo data is lost — you always choose which version to keep." },
    { keywords: ["search", "find", "filter"], answer: "**Search & Filter**\n\nThe search bar in **All POs** filters by: PO#, vendor, memo, tags, status.\n\nIn **Timeline**, the same search filters the Gantt chart.\n\nIn **Email view**, search filters the PO/collection list.\n\nSearching a PO and opening it auto-clears the search. Closing a PO also clears the search." },
  ];

  function getAskMeAnswer(query: string): string {
    const q = query.toLowerCase();
    let bestMatch = { score: 0, answer: "" };
    for (const item of askMeKnowledge) {
      const score = item.keywords.reduce((s, kw) => s + (q.includes(kw.toLowerCase()) ? 1 : 0), 0);
      if (score > bestMatch.score) bestMatch = { score, answer: item.answer };
    }
    if (bestMatch.score > 0) return bestMatch.answer;
    return "I'm not sure about that. Try asking about:\n• **Syncing POs** from Xoro\n• **Milestones** — status, dependencies, cascade\n• **Timeline** — Gantt chart view\n• **Matrix** — size/color breakdown\n• **Bulk Update** — update multiple POs\n• **Excel Export** — download data\n• **Attachments** — file uploads\n• **Email** — Outlook integration\n• **Vendor Scorecard** — performance tracking\n• **Templates** — production templates\n• **Dashboard** — health score, stats\n• **Search** — filtering POs";
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
    setUploadingAttachment(true);
    try {
      const safeName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const dbxPath = `/Eran Bitton/Apps/design-calendar-app/po-attachments/${poNumber}/${safeName}`;
      const res = await fetch("/api/dropbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Dropbox-Action": "upload", "X-Dropbox-Path": dbxPath },
        body: file,
      });
      if (!res.ok) { console.warn("Upload failed:", res.status); setUploadingAttachment(false); return; }
      const data = await res.json();
      const url = data.shared_url || "";
      const entry = { id: safeName, name: file.name, url, dbxPath: data.path_display || dbxPath, type: file.type, size: file.size, uploaded_by: user?.name || "", uploaded_at: new Date().toISOString() };
      await sb.from("tanda_notes").insert({ po_number: poNumber, note: JSON.stringify(entry), status_override: "__attachment__", user_name: user?.name || "", created_at: new Date().toISOString() });
      setAttachments(prev => ({ ...prev, [poNumber]: [...(prev[poNumber] || []), entry] }));
      addHistory(poNumber, `Attachment uploaded: ${file.name}`);
    } catch (e) { console.error("Upload error:", e); }
    setUploadingAttachment(false);
  }
  async function loadAttachments(poNumber: string) {
    const { data } = await sb.from("tanda_notes").select("*", `po_number=eq.${encodeURIComponent(poNumber)}&status_override=eq.__attachment__`);
    if (data) {
      const entries = data.map((r: any) => { try { return JSON.parse(r.note); } catch { return null; } }).filter(Boolean);
      setAttachments(prev => ({ ...prev, [poNumber]: entries }));
      // Purge any that have been soft-deleted for >24h
      setTimeout(() => purgeExpiredAttachments(poNumber), 500);
    }
  }
  async function deleteAttachment(poNumber: string, attachId: string) {
    const entry = (attachments[poNumber] || []).find(a => a.id === attachId);
    if (!entry) return;
    // Soft delete: mark as deleted with timestamp, don't remove from Dropbox yet
    const updatedEntry = { ...entry, deleted_at: new Date().toISOString() };
    // Update metadata in Supabase
    const { data } = await sb.from("tanda_notes").select("id,note", `po_number=eq.${encodeURIComponent(poNumber)}&status_override=eq.__attachment__`);
    const row = data?.find((r: any) => { try { return JSON.parse(r.note).id === attachId; } catch { return false; } });
    if (row) {
      await sb.from("tanda_notes").upsert({ id: row.id, po_number: poNumber, note: JSON.stringify(updatedEntry), status_override: "__attachment__", user_name: entry.uploaded_by, created_at: entry.uploaded_at }, { onConflict: "id" });
    }
    setAttachments(prev => ({ ...prev, [poNumber]: (prev[poNumber] || []).map(a => a.id === attachId ? updatedEntry : a) }));
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
    setAttachments(prev => ({ ...prev, [poNumber]: (prev[poNumber] || []).map(a => a.id === attachId ? restoredEntry : a) }));
    addHistory(poNumber, `Attachment restored: ${entry.name}`);
  }

  async function purgeExpiredAttachments(poNumber: string) {
    const files = attachments[poNumber] || [];
    const now = Date.now();
    for (const f of files) {
      if ((f as any).deleted_at && now - new Date((f as any).deleted_at).getTime() > 24 * 60 * 60 * 1000) {
        // 24h passed — permanently delete from Dropbox
        const dbxPath = (f as any).dbxPath || `/Eran Bitton/Apps/design-calendar-app/po-attachments/${poNumber}/${f.id}`;
        try { await fetch(`/api/dropbox-proxy?action=delete&path=${encodeURIComponent(dbxPath)}`); } catch (e) { console.warn("Purge failed:", e); }
        const { data } = await sb.from("tanda_notes").select("id,note", `po_number=eq.${encodeURIComponent(poNumber)}&status_override=eq.__attachment__`);
        const row = data?.find((r: any) => { try { return JSON.parse(r.note).id === f.id; } catch { return false; } });
        if (row) await sb.from("tanda_notes").delete(`id=eq.${encodeURIComponent(row.id)}`);
      }
    }
    // Remove purged from state
    setAttachments(prev => ({ ...prev, [poNumber]: (prev[poNumber] || []).filter(a => !(a as any).deleted_at || now - new Date((a as any).deleted_at).getTime() <= 24 * 60 * 60 * 1000) }));
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
    // Remove from local state
    setPos(prev => prev.filter(p => (p.PoNumber ?? "") !== poNumber));
    setMilestones(prev => { const next = { ...prev }; delete next[poNumber]; return next; });
    setNotes(prev => prev.filter(n => n.po_number !== poNumber));
    if (selected?.PoNumber === poNumber) setSelected(null);
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
  const selectedNotes = allPONotes.filter(n => n.status_override !== "__history__");
  const selectedHistory = allPONotes.filter(n => n.status_override === "__history__");

  // ════════════════════════════════════════════════════════════════════════════
  // LOGIN SCREEN
  // ════════════════════════════════════════════════════════════════════════════
  const [showLoginPass, setShowLoginPass] = useState(false);

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
  // PRINT + EXCEL EXPORT HELPERS
  // ════════════════════════════════════════════════════════════════════════════
  function printPODetail() {
    const content = document.getElementById("po-detail-content");
    if (!content) return;
    const win = window.open("", "_blank", "width=900,height=700");
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><title>PO Detail</title><style>
      body { font-family: 'DM Sans','Segoe UI',sans-serif; color: #1a1a1a; padding: 24px; font-size: 13px; }
      table { border-collapse: collapse; width: 100%; margin: 12px 0; }
      th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; font-size: 12px; }
      th { background: #f0f0f0; font-weight: 700; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; }
      h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 14px; color: #666; margin: 0 0 16px; }
      .section { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #888; font-weight: 600; margin: 16px 0 8px; }
      .info-grid { display: grid; grid-template-columns: repeat(5,1fr); gap: 8px; margin-bottom: 16px; }
      .info-cell { border: 1px solid #ddd; border-radius: 6px; padding: 8px; }
      .info-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: #888; margin-bottom: 2px; }
      .info-value { font-size: 13px; font-weight: 600; }
      iframe { display: none; } button { display: none; } input { display: none; } textarea { display: none; } select { display: none; }
      @media print { body { padding: 0; } }
    </style></head><body>`);
    win.document.write(content.innerHTML);
    win.document.write("</body></html>");
    win.document.close();
    setTimeout(() => { win.print(); win.close(); }, 400);
  }

  function exportPOExcel(po: XoroPO, items: any[], mode: string) {
    const XLSX = (window as any).XLSX;
    if (!XLSX) { alert("Excel library still loading — try again in a moment."); return; }
    try { _exportPOExcelInner(XLSX, po, items, mode); } catch (e: any) { console.error("Excel export error:", e); alert("Excel export failed: " + e.message); }
  }
  function _exportPOExcelInner(XLSX: any, po: XoroPO, items: any[], mode: string) {
    const poNum = po.PoNumber ?? "PO";
    const totalVal = items.reduce((s, i) => s + (i.QtyOrder ?? 0) * (i.UnitPrice ?? 0), 0);
    const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

    // ── Style definitions (xlsx-js-style requires patternType:"solid" in fill) ──
    const BRAND = "1E293B"; const BRAND_LT = "334155"; const WHITE = "FFFFFF"; const LIGHT_GRAY = "F1F5F9";
    const bdr = { style: "thin", color: { rgb: "CBD5E0" } };
    const border = { top: bdr, bottom: bdr, left: bdr, right: bdr };
    const fill = (rgb: string) => ({ patternType: "solid", fgColor: { rgb } });
    const titleStyle = { font: { bold: true, sz: 14, color: { rgb: WHITE } }, fill: fill(BRAND), alignment: { horizontal: "left", vertical: "center" }, border };
    const subtitleStyle = { font: { sz: 10, color: { rgb: "94A3B8" }, italic: true }, fill: fill(BRAND), alignment: { horizontal: "left" }, border };
    const colHeaderStyle = { font: { bold: true, sz: 11, color: { rgb: WHITE } }, fill: fill(BRAND_LT), alignment: { horizontal: "center", vertical: "center" }, border };
    const colHeaderLeftStyle = { font: { bold: true, sz: 11, color: { rgb: WHITE } }, fill: fill(BRAND_LT), alignment: { horizontal: "left", vertical: "center" }, border };
    const cellStyle = (isEven: boolean) => ({ font: { sz: 11, color: { rgb: "1A202C" } }, fill: fill(isEven ? LIGHT_GRAY : WHITE), border, alignment: { vertical: "center" } });
    const cellCenterStyle = (isEven: boolean) => ({ font: { sz: 11, color: { rgb: "1A202C" } }, fill: fill(isEven ? LIGHT_GRAY : WHITE), border, alignment: { horizontal: "center", vertical: "center" } });
    const cellRightStyle = (isEven: boolean) => ({ font: { sz: 11, color: { rgb: "1A202C" } }, fill: fill(isEven ? LIGHT_GRAY : WHITE), border, alignment: { horizontal: "right", vertical: "center" } });
    const totalRowStyle = { font: { bold: true, sz: 11, color: { rgb: WHITE } }, fill: fill(BRAND), border, alignment: { horizontal: "right", vertical: "center" } };
    const totalCenterStyle = { font: { bold: true, sz: 11, color: { rgb: WHITE } }, fill: fill(BRAND), border, alignment: { horizontal: "center", vertical: "center" } };
    const labelStyle = (isEven: boolean) => ({ font: { bold: true, sz: 11, color: { rgb: BRAND_LT } }, fill: fill(isEven ? LIGHT_GRAY : WHITE), border, alignment: { vertical: "center" } });
    const valStyle = (isEven: boolean) => ({ font: { sz: 11, color: { rgb: "1A202C" } }, fill: fill(isEven ? LIGHT_GRAY : WHITE), border, alignment: { vertical: "center" } });

    // Number formats: #,##0 for qty, $#,##0.00 for dollars
    const FMT_QTY = "#,##0";
    const FMT_USD = "$#,##0.00";

    // PO Info block (always shown at top of every sheet)
    const poInfoBlock: any[][] = [
      ["PO Number", po.PoNumber ?? "", "Vendor", po.VendorName ?? "", "Status", po.StatusName ?? ""],
      ["Order Date", po.DateOrder ?? "", "Expected Delivery", po.DateExpectedDelivery ?? "", "Currency", po.CurrencyCode ?? "USD"],
      ["Payment Terms", po.PaymentTermsName ?? "", "Ship Method", po.ShipMethodName ?? "", "Buyer", po.BuyerName ?? ""],
    ];
    if (po.Memo) poInfoBlock.push(["Memo", po.Memo, "", "", "", ""]);

    // Helper: build a styled sheet with PO info header + data table
    function styleSheet(tableData: any[][], colWidths: number[], opts?: { totalRow?: boolean; dollarCols?: number[]; qtyCols?: number[] }) {
      const cols = Math.max(tableData[0]?.length || 2, 6);
      // Build full sheet data: title → subtitle → PO info → blank → column headers → data
      const all: any[][] = [];
      // Row 0: Title
      const titleRow = [po.VendorName + " — " + poNum]; for (let i = 1; i < cols; i++) titleRow.push("");
      all.push(titleRow);
      // Row 1: Subtitle
      const subRow = ["Generated: " + today]; for (let i = 1; i < cols; i++) subRow.push("");
      all.push(subRow);
      // Rows 2-4: PO info block
      poInfoBlock.forEach(row => { const r = [...row]; while (r.length < cols) r.push(""); all.push(r); });
      // Row 5: blank separator
      const blankRow: string[] = []; for (let i = 0; i < cols; i++) blankRow.push(""); all.push(blankRow);
      // Rows 6+: table data (header + rows)
      const dataStart = all.length;
      tableData.forEach(row => { const r = [...row]; while (r.length < cols) r.push(""); all.push(r); });

      const sheet = XLSX.utils.aoa_to_sheet(all);
      // Merges: title and subtitle span full width
      sheet["!merges"] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: cols - 1 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: cols - 1 } },
      ];
      // If memo row exists and has 6+ cols, merge the value across
      if (po.Memo) {
        const memoRowIdx = 2 + poInfoBlock.length - 1;
        sheet["!merges"].push({ s: { r: memoRowIdx, c: 1 }, e: { r: memoRowIdx, c: cols - 1 } });
      }
      // Column widths: use max of poInfo needs (6 cols) and table widths
      const finalWidths: number[] = [];
      for (let i = 0; i < cols; i++) finalWidths.push(colWidths[i] || 14);
      sheet["!cols"] = finalWidths.map(w => ({ wch: w }));
      sheet["!rows"] = [{ hpt: 28 }, { hpt: 18 }];

      // Style every cell
      const range = XLSX.utils.decode_range(sheet["!ref"]);
      for (let r = range.s.r; r <= range.e.r; r++) {
        for (let c = range.s.c; c <= range.e.c; c++) {
          const addr = XLSX.utils.encode_cell({ r, c });
          if (!sheet[addr]) sheet[addr] = { v: "", t: "s" };
          const cell = sheet[addr];

          if (r === 0) { cell.s = titleStyle; }
          else if (r === 1) { cell.s = subtitleStyle; }
          else if (r >= 2 && r < dataStart - 1) {
            // PO info rows: label/value pairs in groups of 2 cols
            const isEven = (r - 2) % 2 === 0;
            cell.s = (c % 2 === 0) ? labelStyle(isEven) : valStyle(isEven);
          }
          else if (r === dataStart - 1) { cell.s = { fill: fill(WHITE), border }; } // blank separator
          else if (r === dataStart) {
            // Column header row
            cell.s = c === 0 ? colHeaderLeftStyle : colHeaderStyle;
          }
          else if (opts?.totalRow && r === range.e.r) {
            // Total/summary row
            cell.s = totalCenterStyle;
            // Apply dollar format to dollar cols in total row
            if (opts?.dollarCols?.includes(c) && typeof cell.v === "number") { cell.z = FMT_USD; cell.t = "n"; }
            else if (opts?.qtyCols?.includes(c) && typeof cell.v === "number") { cell.z = FMT_QTY; cell.t = "n"; }
          }
          else {
            // Data rows with alternating colors
            const isEven = (r - dataStart - 1) % 2 === 0;
            if (typeof cell.v === "number") {
              cell.s = cellRightStyle(isEven);
              // Apply number format based on column
              if (opts?.dollarCols?.includes(c)) { cell.z = FMT_USD; cell.t = "n"; }
              else if (opts?.qtyCols?.includes(c)) { cell.z = FMT_QTY; cell.t = "n"; }
              else { cell.z = FMT_QTY; cell.t = "n"; } // default: comma, no decimals
            } else {
              cell.s = c === 0 ? cellStyle(isEven) : cellCenterStyle(isEven);
            }
          }
        }
      }
      return sheet;
    }

    const wb = XLSX.utils.book_new();

    if (mode === "po" || mode === "header" || mode === "matrix") {
      // Matrix sheet
      const parsed = items.map(item => {
        const sku = item.ItemNumber ?? ""; const parts = sku.split("-");
        const color = parts.length === 4 ? `${parts[1]}-${parts[2]}` : (parts.length >= 2 ? parts[1] : "");
        const sz = normalizeSize(parts.length === 4 ? parts[3] : parts.length >= 3 ? parts.slice(2).join("-") : "");
        return { base: parts[0] || sku, color, size: sz, qty: item.QtyOrder ?? 0, price: item.UnitPrice ?? 0, desc: item.Description ?? "" };
      });
      const sizeSet = new Set<string>();
      parsed.forEach(p => { if (p.size) sizeSet.add(p.size); });
      const sizeOrder = [...sizeSet].sort(sizeSort);
      const mxRows: any[][] = [["Base Part", "Description", "Color", ...sizeOrder, "Total", "PO Cost", "Total Cost"]];
      const bases: string[] = [];
      const byBase: Record<string, { color: string; desc: string; sizes: Record<string, number>; price: number }[]> = {};
      parsed.forEach(p => {
        if (!byBase[p.base]) { byBase[p.base] = []; bases.push(p.base); }
        let row = byBase[p.base].find(r => r.color === p.color);
        if (!row) { row = { color: p.color, desc: p.desc, sizes: {}, price: p.price }; byBase[p.base].push(row); }
        row.sizes[p.size] = (row.sizes[p.size] || 0) + p.qty;
      });
      bases.forEach(base => { byBase[base].forEach(row => {
        const rt = Object.values(row.sizes).reduce((s, q) => s + q, 0);
        mxRows.push([base, row.desc, row.color, ...sizeOrder.map(sz => row.sizes[sz] || 0), rt, row.price, rt * row.price]);
      }); });
      mxRows.push(["", "", "GRAND TOTAL", ...sizeOrder.map(sz => parsed.filter(p => p.size === sz).reduce((s, p) => s + p.qty, 0)), items.reduce((s, i) => s + (i.QtyOrder ?? 0), 0), "", totalVal]);
      const nSz = sizeOrder.length;
      const mxDollar = [3 + nSz + 1, 3 + nSz + 2];
      const mxQty = [...sizeOrder.map((_, i) => 3 + i), 3 + nSz];
      const mxW = [18, 26, 14, ...sizeOrder.map(() => 10), 10, 12, 14];
      XLSX.utils.book_append_sheet(wb, styleSheet(mxRows, mxW, { totalRow: true, dollarCols: mxDollar, qtyCols: mxQty }), "Matrix");
      // Line Items sheet
      const lineData: any[][] = [["SKU", "Description", "Qty", "Unit Price", "Total"]];
      items.forEach(item => { lineData.push([item.ItemNumber ?? "", item.Description ?? "", item.QtyOrder ?? 0, item.UnitPrice ?? 0, (item.QtyOrder ?? 0) * (item.UnitPrice ?? 0)]); });
      lineData.push(["TOTAL", "", items.reduce((s, i) => s + (i.QtyOrder ?? 0), 0), "", totalVal]);
      XLSX.utils.book_append_sheet(wb, styleSheet(lineData, [22, 32, 12, 14, 16], { totalRow: true, dollarCols: [3, 4], qtyCols: [2] }), "Line Items");
      XLSX.writeFile(wb, `${poNum}_PO_Details.xlsx`);

    } else if (mode === "milestones") {
      const poMs = milestones[poNum] || [];
      const rows: any[][] = [["Category", "Milestone", "Expected Date", "Status", "Status Date", "Notes"]];
      poMs.forEach(m => { rows.push([m.category, m.phase, m.expected_date ?? "", m.status, m.status_date ?? "", m.notes ?? ""]); });
      XLSX.utils.book_append_sheet(wb, styleSheet(rows, [20, 26, 14, 14, 14, 30]), "Milestones");
      XLSX.writeFile(wb, `${poNum}_Milestones.xlsx`);

    } else if (mode === "notes") {
      const poNotes = notes.filter(n => n.poNumber === poNum);
      const rows: any[][] = [["Date", "User", "Note"]];
      poNotes.forEach(n => { rows.push([n.date ?? "", n.user ?? "", n.text ?? ""]); });
      XLSX.utils.book_append_sheet(wb, styleSheet(rows, [22, 18, 52]), "Notes");
      XLSX.writeFile(wb, `${poNum}_Notes.xlsx`);

    } else if (mode === "all") {
      const lineData: any[][] = [["SKU", "Description", "Qty", "Unit Price", "Total"]];
      items.forEach(item => { lineData.push([item.ItemNumber ?? "", item.Description ?? "", item.QtyOrder ?? 0, item.UnitPrice ?? 0, (item.QtyOrder ?? 0) * (item.UnitPrice ?? 0)]); });
      lineData.push(["TOTAL", "", items.reduce((s, i) => s + (i.QtyOrder ?? 0), 0), "", totalVal]);
      XLSX.utils.book_append_sheet(wb, styleSheet(lineData, [22, 32, 12, 14, 16], { totalRow: true, dollarCols: [3, 4], qtyCols: [2] }), "Line Items");
      const poMs = milestones[poNum] || [];
      if (poMs.length > 0) {
        const msRows: any[][] = [["Category", "Milestone", "Expected Date", "Status", "Status Date", "Notes"]];
        poMs.forEach(m => { msRows.push([m.category, m.phase, m.expected_date ?? "", m.status, m.status_date ?? "", m.notes ?? ""]); });
        XLSX.utils.book_append_sheet(wb, styleSheet(msRows, [20, 26, 14, 14, 14, 30]), "Milestones");
      }
      XLSX.writeFile(wb, `${poNum}_All.xlsx`);
    } else {
      alert("Excel export not available for this tab.");
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PO DETAIL PANEL
  // ════════════════════════════════════════════════════════════════════════════
  const DetailPanel = () => {
    if (!selected) return null;
    const items = selected.Items ?? selected.PoLineArr ?? [];
    const days  = daysUntil(selected.DateExpectedDelivery);
    const total = poTotal(selected);
    const statusColor = STATUS_COLORS[selected.StatusName ?? ""] ?? "#6B7280";

    // Lazy-generate milestones on first view
    const poNum = selected.PoNumber ?? "";
    if (poNum && selected.DateExpectedDelivery && !milestones[poNum]) {
      const vendorN = selected.VendorName ?? "";
      if (vendorN && !vendorHasTemplate(vendorN)) {
        // Show create-template modal instead of detail panel
        if (!showCreateTpl) setShowCreateTpl(vendorN);
      } else {
        ensureMilestones(selected);
      }
    }

    // Block detail panel — show create-template modal first
    if (showCreateTpl) {
      const vendorN = showCreateTpl;
      return (
        <div style={S.modalOverlay} onClick={() => { setShowCreateTpl(null); setSelected(null); }}>
          <div style={{ ...S.modal, width: 500 }} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h2 style={S.modalTitle}>Create Production Template</h2>
              <button style={S.closeBtn} onClick={() => { setShowCreateTpl(null); setSelected(null); }}>✕</button>
            </div>
            <div style={S.modalBody}>
              <p style={{ color: "#D1D5DB", fontSize: 14, marginTop: 0, marginBottom: 16 }}>
                No production template exists for <strong style={{ color: "#60A5FA" }}>{vendorN}</strong>. Create one to generate milestones for this PO.
              </p>
              <div style={{ marginBottom: 16 }}>
                <label style={S.label}>Copy from</label>
                <select style={{ ...S.select, width: "100%" }} id="modalCopyFrom">
                  <option value="__default__">Default Template</option>
                  {templateVendorList().map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button style={{ ...S.btnSecondary, flex: 1 }} onClick={() => { setShowCreateTpl(null); setSelected(null); }}>
                  Cancel
                </button>
                <button style={{ ...S.btnPrimary, flex: 2 }} onClick={async () => {
                  const copyEl = document.getElementById("modalCopyFrom") as HTMLSelectElement;
                  const copyFrom = copyEl?.value || "__default__";
                  const source = getVendorTemplates(copyFrom === "__default__" ? undefined : copyFrom);
                  const newTpls = source.map(t => ({ ...t, id: milestoneUid() }));
                  await saveVendorTemplates(vendorN, newTpls);
                  setShowCreateTpl(null);
                  const poNum = selected?.PoNumber ?? "";
                  addHistory(poNum, `Template created for ${vendorN} (copied from ${copyFrom === "__default__" ? "Default" : copyFrom})`);
                  // Generate milestones now that template exists
                  if (selected && selected.DateExpectedDelivery) {
                    const ms = generateMilestones(poNum, selected.DateExpectedDelivery, vendorN);
                    if (ms.length > 0) {
                      await saveMilestones(ms);
                      addHistory(poNum, `Milestones generated (${ms.length} phases) using ${vendorN} template`);
                    }
                  }
                }}>
                  Create Template & Generate Milestones
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    const showPO = detailMode === "po" || detailMode === "all";
    const showMilestones = detailMode === "milestones" || detailMode === "all";
    const showNotes = detailMode === "notes" || detailMode === "all";
    const showHistory = detailMode === "history" || detailMode === "all";
    const totalQty = items.reduce((s, i) => s + (i.QtyOrder ?? 0), 0);

    // Matrix rows (base+color combos) — shared by Item Matrix table and variant panel
    const matrixRows = (() => {
      const byKey: Record<string, { base: string; color: string; desc: string; qty: number; price: number }> = {};
      const rows: { base: string; color: string; desc: string; qty: number; price: number }[] = [];
      items.forEach((item: any) => {
        const sku = item.ItemNumber ?? "";
        const parts = sku.split("-");
        const color = parts.length === 4 ? `${parts[1]}-${parts[2]}` : (parts.length >= 2 ? parts[1] : "");
        const base = parts[0] || sku;
        const key = `${base}-${color}`;
        if (!byKey[key]) {
          byKey[key] = { base, color, desc: item.Description ?? "", qty: 0, price: item.UnitPrice ?? 0 };
          rows.push(byKey[key]);
        }
        byKey[key].qty += (item.QtyOrder ?? 0);
      });
      return rows;
    })();

    const tabStyle = (mode: string): React.CSSProperties => ({
      flex: 1, padding: "12px 20px", fontSize: 16, cursor: "pointer", fontWeight: 700,
      border: "1px solid #334155", borderBottom: detailMode === mode ? "none" : "1px solid #334155",
      background: detailMode === mode ? "#1E293B" : "#0F172A",
      color: detailMode === mode ? "#60A5FA" : "#6B7280",
      borderRadius: "10px 10px 0 0",
      marginBottom: detailMode === mode ? -1 : 0,
      position: "relative" as const,
      zIndex: detailMode === mode ? 1 : 0,
    });

    return (
      <div style={{ position: "fixed", inset: 0, top: 56, background: "#0F172A", zIndex: 90, overflowY: "auto", display: "flex", flexDirection: "column", fontSize: "120%" }}>
        <div id="po-detail-content" style={{ maxWidth: "90%", margin: "0 auto", width: "100%", padding: "24px 20px", flex: 1 }}>
          {/* Header — sticky, includes all PO info */}
          <div style={{ ...S.detailHeader, borderLeft: `4px solid ${statusColor}`, borderRadius: 12, marginBottom: 16, position: "sticky", top: 0, zIndex: 10, background: "#0F172A", flexDirection: "column", gap: 10 }}>
            {/* Row 1: PO# / Vendor + buttons */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", width: "100%" }}>
              <div>
                <div style={{ ...S.detailPONum, fontSize: 24 }}>{selected.PoNumber ?? "—"}</div>
                <div style={{ ...S.detailVendor, fontSize: 18 }}>{selected.VendorName ?? "Unknown Vendor"}</div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ ...S.badge, background: statusColor + "33", color: statusColor, border: `1px solid ${statusColor}66`, fontSize: 14, padding: "4px 12px" }}>
                  {selected.StatusName ?? "Unknown"}
                </span>
                <button onClick={() => exportPOExcel(selected, items, detailMode)}
                  style={{ background: "#1D6F42", border: "none", borderRadius: 6, padding: "6px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit", transition: "background 0.15s" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#155734"}
                  onMouseLeave={e => e.currentTarget.style.background = "#1D6F42"}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" fill="#fff" fillOpacity=".2" stroke="#fff" strokeWidth="1.5"/><path d="M14 2v6h6" stroke="#fff" strokeWidth="1.5"/><path d="M8 13l2.5 4M8 17l2.5-4M13 13v4M15.5 13v4M13 15h2.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  Excel
                </button>
                <button style={{ ...S.btnSecondary, fontSize: 12, padding: "6px 14px", display: "flex", alignItems: "center", gap: 4 }} onClick={() => printPODetail()}>🖨️ Print</button>
                <button onClick={() => setConfirmModal({ title: "Delete PO", message: `Delete PO ${selected.PoNumber}? This will permanently remove the PO, all milestones, notes, and history.`, icon: "🗑", confirmText: "Delete", confirmColor: "#EF4444", onConfirm: () => deletePO(selected.PoNumber ?? "") })}
                  style={{ background: "none", border: "1px solid #EF4444", color: "#EF4444", borderRadius: 6, padding: "4px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}
                  onMouseEnter={e => { e.currentTarget.style.background = "#EF4444"; e.currentTarget.style.color = "#fff"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "#EF4444"; }}>🗑 Delete PO</button>
                <button style={{ ...S.closeBtn, fontSize: 16, padding: "4px 10px" }} onClick={() => { setSelected(null); setSearch(""); }}>✕ Close</button>
              </div>
            </div>
            {/* Row 2: PO info pills */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(() => {
                const ddpColor = days !== null && days < 0 ? "#EF4444" : days !== null && days <= 7 ? "#F59E0B" : "#10B981";
                const ddpSuffix = days === null ? "" : days < 0 ? ` (${Math.abs(days)}d late)` : days === 0 ? " (Today!)" : ` (${days}d)`;
                const origin = (() => { const v = dcVendors.find(v => v.name === selected.VendorName); return (v as any)?.country || null; })();
                const pills: [string, string, string?][] = [
                  ["Order", fmtDate(selected.DateOrder) || "—"],
                  ["DDP", (fmtDate(selected.DateExpectedDelivery) || "—") + ddpSuffix, ddpColor],
                  ...(selected.VendorReqDate ? [["Vendor Req", fmtDate(selected.VendorReqDate)] as [string, string]] : []),
                  ["Value", fmtCurrency(total, selected.CurrencyCode)],
                  ["Qty", totalQty.toLocaleString()],
                  ...(selected.PaymentTermsName ? [["Payment", selected.PaymentTermsName] as [string, string]] : []),
                  ...(selected.ShipMethodName ? [["Ship", selected.ShipMethodName] as [string, string]] : []),
                  ...(selected.CarrierName ? [["Carrier", selected.CarrierName] as [string, string]] : []),
                  ...(selected.BuyerName ? [["Buyer", selected.BuyerName] as [string, string]] : []),
                  ...(selected.BrandName ? [["Brand", selected.BrandName] as [string, string]] : []),
                  ...(origin ? [["Origin", origin] as [string, string]] : []),
                  ...(selected.Memo ? [["Memo", selected.Memo] as [string, string]] : []),
                  ...(selected.Tags ? [["Tags", selected.Tags] as [string, string]] : []),
                ];
                return pills.map(([label, val, color]) => (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", background: "#1E293B", borderRadius: 6, border: "1px solid #334155" }}>
                    <span style={{ fontSize: 11, color: "#6B7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}:</span>
                    <span style={{ fontSize: 13, color: color || "#D1D5DB", fontWeight: 600 }}>{val}</span>
                  </div>
                ));
              })()}
            </div>
          </div>

          {/* Milestone Progress Bar + Quick Status */}
          {(() => {
            const poMs = milestones[selected.PoNumber ?? ""] || [];
            if (poMs.length === 0) return null;
            const complete = poMs.filter(m => m.status === "Complete").length;
            const inProg = poMs.filter(m => m.status === "In Progress").length;
            const delayed = poMs.filter(m => m.status === "Delayed").length;
            const na = poMs.filter(m => m.status === "N/A").length;
            const active = poMs.length - na;
            const pct = active > 0 ? Math.round((complete / active) * 100) : 0;
            const delayedPct = active > 0 ? Math.round((delayed / active) * 100) : 0;
            const inProgPct = active > 0 ? Math.round((inProg / active) * 100) : 0;
            // Category summary
            const cats = WIP_CATEGORIES.filter(cat => poMs.some(m => m.category === cat));
            return (
              <div style={{ marginBottom: 12 }}>
                <div onClick={() => setProgressCollapsed(!progressCollapsed)}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#0F172A", borderRadius: progressCollapsed ? 8 : "8px 8px 0 0", cursor: "pointer", userSelect: "none" }}>
                  <span style={{ color: "#6B7280", fontSize: 12 }}>{progressCollapsed ? "▶" : "▼"}</span>
                  <span style={{ color: "#94A3B8", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Production Progress</span>
                  <span style={{ color: "#10B981", fontSize: 14, fontWeight: 800, fontFamily: "monospace" }}>{pct}%</span>
                  <span style={{ color: "#6B7280", fontSize: 11 }}>{complete}/{active} milestones</span>
                  {delayed > 0 && <span style={{ color: "#EF4444", fontSize: 11, fontWeight: 600 }}>⚠ {delayed} delayed</span>}
                </div>
                {!progressCollapsed && <div style={{ background: "#0F172A", borderRadius: "0 0 8px 8px", padding: "12px 14px" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                  {([
                    ["Complete", complete, "#10B981", "#6EE7B7", "#047857"],
                    ["In Progress", inProg, "#3B82F6", "#93C5FD", "#1D4ED8"],
                    ["Delayed", delayed, "#EF4444", "#FCA5A5", "#7F1D1D"],
                    ["Not Started", active - complete - inProg - delayed, "#6B7280", "#6B7280", "#1F2937"],
                  ] as [string, number, string, string, string][]).filter(([, count]) => (count as number) > 0).map(([label, count, labelColor, gradLight, gradDark]) => {
                    const statusPct = active > 0 ? Math.round(((count as number) / active) * 100) : 0;
                    return (
                      <div key={label as string} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ width: 90, fontSize: 11, color: labelColor as string, fontWeight: 600, textAlign: "right", flexShrink: 0 }}>{label as string}</span>
                        <div style={{ flex: 1, height: 10, borderRadius: 5, background: "#0F172A", overflow: "hidden" }}>
                          <div style={{ width: `${statusPct}%`, height: "100%", background: `linear-gradient(90deg, ${gradLight}, ${gradDark})`, borderRadius: 5, transition: "width 0.3s", minWidth: (count as number) > 0 ? 4 : 0 }} />
                        </div>
                        <span style={{ width: 55, fontSize: 11, color: "#94A3B8", fontFamily: "monospace", flexShrink: 0 }}>{count} ({statusPct}%)</span>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {cats.map(cat => {
                    const catMs = poMs.filter(m => m.category === cat);
                    const catDone = catMs.filter(m => m.status === "Complete").length;
                    const catNA = catMs.filter(m => m.status === "N/A").length;
                    const catActive = catMs.length - catNA;
                    const allDone = catActive > 0 && catDone === catActive;
                    const hasDelayed = catMs.some(m => m.status === "Delayed");
                    const hasInProg = catMs.some(m => m.status === "In Progress");
                    const dotColor = allDone ? "#10B981" : hasDelayed ? "#EF4444" : hasInProg ? "#3B82F6" : "#6B7280";
                    return (
                      <div key={cat} onClick={() => openCategoryWithCheck(selected.PoNumber ?? "", cat)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 6, background: "#0F172A", border: "1px solid #334155", cursor: "pointer", transition: "border-color 0.15s" }}
                        onMouseEnter={e => e.currentTarget.style.borderColor = dotColor}
                        onMouseLeave={e => e.currentTarget.style.borderColor = "#334155"}>
                        <div style={{ width: 7, height: 7, borderRadius: "50%", background: dotColor }} />
                        <span style={{ fontSize: 11, color: "#D1D5DB" }}>{cat}</span>
                        <span style={{ fontSize: 10, color: "#6B7280", fontFamily: "monospace" }}>{catDone}/{catActive}</span>
                      </div>
                    );
                  })}
                </div>
                </div>}
              </div>
            );
          })()}

          {/* Tabs */}
          <div style={{ display: "flex", gap: 2, marginBottom: 0 }}>
            <button style={tabStyle("po")} onClick={() => setDetailMode("po")}>PO / Matrix</button>
            <button style={tabStyle("milestones")} onClick={() => setDetailMode("milestones")}>Milestones</button>
            <button style={tabStyle("notes")} onClick={() => setDetailMode("notes")}>Notes</button>
            <button style={tabStyle("attachments")} onClick={() => { setDetailMode("attachments"); const pn = selected.PoNumber ?? ""; if (pn && !attachments[pn]) loadAttachments(pn); }}>📎 Files</button>
            <button style={tabStyle("email")} onClick={() => { setDetailMode("email"); setDtlEmailTab("inbox"); const pn = selected.PoNumber ?? ""; if (pn && emailToken && !dtlEmails[pn]?.length) loadDtlEmails(pn); }}>📧 Email/Teams</button>
            <button style={tabStyle("history")} onClick={() => setDetailMode("history")}>History</button>
            <button style={tabStyle("all")} onClick={() => setDetailMode("all")}>All</button>
          </div>
          <div style={{ border: "1px solid #334155", borderTop: "none", borderRadius: "0 0 10px 10px", background: "#1E293B", padding: 20, marginBottom: 20 }}>

          {/* PO / Matrix combined section */}
          {showPO && items.length > 0 && (() => {
            // Matrix data
            const parsed = items.map((item: any) => {
              const sku = item.ItemNumber ?? ""; const parts = sku.split("-");
              const color = parts.length === 4 ? `${parts[1]}-${parts[2]}` : (parts.length >= 2 ? parts[1] : "");
              const sz = normalizeSize(parts.length === 4 ? parts[3] : parts.length >= 3 ? parts.slice(2).join("-") : "");
              return { base: parts[0] || sku, color, size: sz, qty: item.QtyOrder ?? 0, price: item.UnitPrice ?? 0, desc: item.Description ?? "" };
            });
            const sizeSet2 = new Set<string>();
            parsed.forEach((p: any) => { if (p.size) sizeSet2.add(p.size); });
            const sizeOrder = [...sizeSet2].sort(sizeSort);
            const bases: string[] = [];
            const byBase: Record<string, { color: string; desc: string; sizes: Record<string, number>; price: number }[]> = {};
            parsed.forEach((p: any) => {
              if (!byBase[p.base]) { byBase[p.base] = []; bases.push(p.base); }
              let row = byBase[p.base].find((r: any) => r.color === p.color);
              if (!row) { row = { color: p.color, desc: p.desc, sizes: {}, price: p.price }; byBase[p.base].push(row); }
              row.sizes[p.size] = (row.sizes[p.size] || 0) + p.qty;
            });

            return (
              <>
                {/* Matrix — collapsible, milestone-tab style */}
                <div style={{ marginBottom: 8 }}>
                  <div onClick={() => setMatrixCollapsed(!matrixCollapsed)}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#0F172A", borderRadius: matrixCollapsed ? 8 : "8px 8px 0 0", cursor: "pointer", userSelect: "none" }}>
                    <span style={{ color: "#6B7280", fontSize: 12 }}>{matrixCollapsed ? "▶" : "▼"}</span>
                    <span style={{ color: "#94A3B8", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Item Matrix</span>
                    <span style={{ color: "#6B7280", fontSize: 11, marginLeft: "auto" }}>{bases.length} base parts · {sizeOrder.length} sizes</span>
                  </div>
                  {!matrixCollapsed && (
                    <div style={{ overflowX: "auto", background: "#0F172A", borderRadius: "0 0 8px 8px" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr style={{ background: "#0F172A" }}>
                            <th style={{ padding: "10px 14px", textAlign: "left", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Base Part</th>
                            <th style={{ padding: "10px 14px", textAlign: "left", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Description</th>
                            <th style={{ padding: "10px 14px", textAlign: "left", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Color</th>
                            {sizeOrder.map(sz => (
                              <th key={sz} style={{ padding: "10px 14px", textAlign: "center", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155", minWidth: 60 }}>{sz}</th>
                            ))}
                            <th style={{ padding: "10px 14px", textAlign: "center", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Total</th>
                            <th style={{ padding: "10px 14px", textAlign: "right", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>PO Cost</th>
                            <th style={{ padding: "10px 14px", textAlign: "right", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Total Cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bases.map((base, bi) => {
                            const rows = byBase[base];
                            return rows.map((row, ri) => {
                              const rowTotal = Object.values(row.sizes).reduce((s: number, q: any) => s + q, 0);
                              const rowCost = rowTotal * row.price;
                              const isLast = ri === rows.length - 1;
                              return (
                                <tr key={base + "-" + row.color} style={{ borderBottom: isLast && bi < bases.length - 1 ? "2px solid #334155" : "1px solid #1E293B" }}>
                                  <td style={{ padding: "8px 14px", color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, borderRight: "1px solid #334155" }}>{base}</td>
                                  <td style={{ padding: "8px 14px", color: "#9CA3AF", fontSize: 12 }}>{row.desc || "—"}</td>
                                  <td style={{ padding: "8px 14px", color: "#D1D5DB" }}>{row.color || "—"}</td>
                                  {sizeOrder.map(sz => (
                                    <td key={sz} style={{ padding: "8px 14px", textAlign: "center", color: row.sizes[sz] ? "#E5E7EB" : "#334155", fontFamily: "monospace" }}>{row.sizes[sz] || "—"}</td>
                                  ))}
                                  <td style={{ padding: "8px 14px", textAlign: "center", color: "#F59E0B", fontWeight: 700, fontFamily: "monospace" }}>{rowTotal}</td>
                                  <td style={{ padding: "8px 14px", textAlign: "right", color: "#9CA3AF", fontFamily: "monospace" }}>{fmtCurrency(row.price, selected.CurrencyCode)}</td>
                                  <td style={{ padding: "8px 14px", textAlign: "right", color: "#10B981", fontWeight: 600, fontFamily: "monospace" }}>{fmtCurrency(rowCost, selected.CurrencyCode)}</td>
                                </tr>
                              );
                            });
                          })}
                        </tbody>
                        <tfoot>
                          <tr style={{ borderTop: "2px solid #334155", background: "#0F172A" }}>
                            <td colSpan={3} style={{ padding: "12px 14px", color: "#9CA3AF", fontWeight: 700, textAlign: "right" }}>Grand Total</td>
                            {sizeOrder.map(sz => {
                              const colTotal = parsed.filter((p: any) => p.size === sz).reduce((s: number, p: any) => s + p.qty, 0);
                              return <td key={sz} style={{ padding: "12px 14px", textAlign: "center", color: "#F59E0B", fontWeight: 700, fontFamily: "monospace" }}>{colTotal}</td>;
                            })}
                            <td style={{ padding: "12px 14px", textAlign: "center", color: "#F59E0B", fontWeight: 800, fontFamily: "monospace" }}>{totalQty}</td>
                            <td style={{ padding: "12px 14px" }} />
                            <td style={{ padding: "12px 14px", textAlign: "right", color: "#10B981", fontWeight: 800, fontFamily: "monospace" }}>{fmtCurrency(total, selected.CurrencyCode)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                </div>

                {/* Line Items — collapsible, milestone-tab style */}
                <div style={{ marginBottom: 20 }}>
                  <div onClick={() => setLineItemsCollapsed(!lineItemsCollapsed)}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#0F172A", borderRadius: lineItemsCollapsed ? 8 : "8px 8px 0 0", cursor: "pointer", userSelect: "none" }}>
                    <span style={{ color: "#6B7280", fontSize: 12 }}>{lineItemsCollapsed ? "▶" : "▼"}</span>
                    <span style={{ color: "#94A3B8", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Line Items</span>
                    <span style={{ color: "#6B7280", fontSize: 11, marginLeft: "auto" }}>{items.length} items</span>
                  </div>
                  {!lineItemsCollapsed && (
                    <div style={{ ...S.itemsTable, borderRadius: "0 0 8px 8px" }}>
                      <div style={S.itemsHeader}>
                        <span>SKU</span><span>Description</span><span>Qty</span><span>Unit Price</span><span>Total</span>
                      </div>
                      {items.map((item, i) => (
                        <div key={i} style={S.itemRow}>
                          <span style={{ color: "#60A5FA", fontFamily: "monospace" }}>{item.ItemNumber ?? "—"}</span>
                          <span style={{ color: "#D1D5DB" }}>{item.Description ?? "—"}</span>
                          <span style={{ color: "#E5E7EB", textAlign: "right" }}>{item.QtyOrder ?? 0}</span>
                          <span style={{ color: "#E5E7EB", textAlign: "right" }}>{fmtCurrency(item.UnitPrice, selected.CurrencyCode)}</span>
                          <span style={{ color: "#10B981", textAlign: "right", fontWeight: 600 }}>
                            {fmtCurrency((item.QtyOrder ?? 0) * (item.UnitPrice ?? 0), selected.CurrencyCode)}
                          </span>
                        </div>
                      ))}
                      <div style={S.itemsTotal}>
                        <span style={{ gridColumn: "1/5", textAlign: "right", color: "#9CA3AF" }}>Total</span>
                        <span style={{ color: "#10B981", fontWeight: 700 }}>{fmtCurrency(total, selected.CurrencyCode)}</span>
                      </div>
                    </div>
                  )}
                </div>
              </>
            );
          })()}

            {/* Attachments Tab */}
            {(detailMode === "attachments" || detailMode === "all") && (() => {
              const pn = selected.PoNumber ?? "";
              const files = attachments[pn] || [];
              const fmtSize = (b: number) => b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : (b / 1048576).toFixed(1) + " MB";
              const getIcon = (type: string) => type.startsWith("image/") ? "🖼️" : type.includes("pdf") ? "📄" : type.includes("sheet") || type.includes("excel") || type.includes("csv") ? "📊" : type.includes("word") || type.includes("doc") ? "📝" : "📎";
              return (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <div style={S.sectionLabel}>Attachments ({files.filter(f => !(f as any).deleted_at).length})</div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {uploadingAttachment && <span style={{ fontSize: 12, color: "#F59E0B" }}>Uploading…</span>}
                      <input ref={attachInputRef} type="file" multiple style={{ display: "none" }} onChange={async e => {
                        const fileList = e.target.files; if (!fileList) return;
                        for (let i = 0; i < fileList.length; i++) await uploadAttachment(pn, fileList[i]);
                        e.target.value = "";
                      }} />
                      <button onClick={() => attachInputRef.current?.click()} disabled={uploadingAttachment} style={{ ...S.btnPrimary, fontSize: 11, padding: "6px 14px", width: "auto", opacity: uploadingAttachment ? 0.5 : 1 }}>+ Upload Files</button>
                    </div>
                  </div>
                  {files.length === 0 ? (
                    <div style={{ background: "#0F172A", borderRadius: 8, padding: 30, textAlign: "center" }}>
                      <div style={{ fontSize: 32, marginBottom: 8 }}>📎</div>
                      <div style={{ color: "#6B7280", fontSize: 13, marginBottom: 12 }}>No attachments yet</div>
                      <button onClick={() => attachInputRef.current?.click()} style={{ ...S.btnSecondary, fontSize: 12 }}>Upload your first file</button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {files.map(f => {
                        const isDeleted = !!(f as any).deleted_at;
                        const timeAgo = f.uploaded_at ? (() => { const ms = Date.now() - new Date(f.uploaded_at).getTime(); const m = Math.floor(ms / 60000); if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`; return `${Math.floor(h / 24)}d ago`; })() : "";
                        const deleteTimeLeft = isDeleted ? (() => { const ms = 24 * 60 * 60 * 1000 - (Date.now() - new Date((f as any).deleted_at).getTime()); if (ms <= 0) return ""; const h = Math.floor(ms / 3600000); return `${h}h left to undo`; })() : "";
                        if (isDeleted) {
                          const msLeft = 24 * 60 * 60 * 1000 - (Date.now() - new Date((f as any).deleted_at).getTime());
                          if (msLeft <= 0) return null;
                          const h = Math.floor(msLeft / 3600000); const m = Math.floor((msLeft % 3600000) / 60000); const s = Math.floor((msLeft % 60000) / 1000);
                          const countdown = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
                          return (
                          <div key={f.id} style={{ position: "relative", display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "#0F172A", borderRadius: 8, border: "1px dashed #EF444444", overflow: "hidden" }}>
                            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1 }}>
                              <span style={{ fontSize: 28, fontWeight: 800, fontFamily: "monospace", color: "#10B981", textShadow: "0 0 12px #10B98166, 0 0 24px #10B98133", letterSpacing: 2 }}>{countdown}</span>
                            </div>
                            <div style={{ position: "relative", zIndex: 2, flex: 1, display: "flex", alignItems: "center", gap: 12, opacity: 0.5 }}>
                              <span style={{ fontSize: 24, flexShrink: 0 }}>🗑</span>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 13, color: "#EF4444", fontWeight: 600, textDecoration: "line-through" }}>{f.name}</div>
                              </div>
                            </div>
                            <button onClick={() => undoDeleteAttachment(pn, f.id)}
                              style={{ position: "relative", zIndex: 2, padding: "8px 18px", borderRadius: 8, border: "none", background: "linear-gradient(135deg, #F59E0B, #D97706)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", flexShrink: 0, boxShadow: "0 2px 8px rgba(245,158,11,0.3)" }}>↩ Undo</button>
                          </div>
                          );
                        }
                        return (
                          <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "#0F172A", borderRadius: 8, border: "1px solid #334155" }}>
                            <span style={{ fontSize: 24, flexShrink: 0 }}>{getIcon(f.type)}</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <a href={f.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: "#60A5FA", fontWeight: 600, textDecoration: "none", display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                                onMouseEnter={e => e.currentTarget.style.textDecoration = "underline"} onMouseLeave={e => e.currentTarget.style.textDecoration = "none"}>{f.name}</a>
                              <div style={{ fontSize: 11, color: "#6B7280" }}>{fmtSize(f.size)} · {f.uploaded_by} · {timeAgo}</div>
                            </div>
                            {f.type.startsWith("image/") && f.url && <img src={f.url} alt="" style={{ width: 40, height: 40, borderRadius: 6, objectFit: "cover", flexShrink: 0 }} />}
                            <button onClick={e => { e.stopPropagation(); setConfirmModal({ title: "Delete Attachment", message: `Delete "${f.name}"? You'll have 24 hours to undo.`, icon: "🗑", confirmText: "Delete", confirmColor: "#EF4444", onConfirm: () => deleteAttachment(pn, f.id) }); }}
                              style={{ background: "none", border: "1px solid #EF444444", color: "#EF4444", borderRadius: 6, padding: "4px 8px", fontSize: 10, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>✕</button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Email Tab */}
            {(detailMode === "email" || detailMode === "all") && (() => {
              const OUTLOOK_BLUE = "#0078D4";
              const pn = selected.PoNumber ?? "";
              const prefix = "[PO-" + pn + "]";
              const dtlList = dtlEmails[pn] || [];
              const isLoading = !!dtlEmailLoading[pn];
              const err = dtlEmailErr[pn];

              return (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <div style={S.sectionLabel}>Emails for {prefix}</div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {emailToken && <button onClick={() => loadDtlEmails(pn)} style={{ ...S.btnSecondary, fontSize: 11, padding: "4px 10px" }}>↻ Refresh</button>}
                    </div>
                  </div>

                  {!emailToken ? (
                    <div style={{ textAlign: "center", padding: "30px 0" }}>
                      <div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div>
                      <div style={{ color: "#6B7280", fontSize: 13, marginBottom: 12 }}>Sign in with Microsoft to view emails</div>
                      {(!MS_CLIENT_ID || !MS_TENANT_ID) ? (
                        <div style={{ color: "#D97706", fontSize: 12 }}>Azure credentials not configured — check Vercel env vars</div>
                      ) : (
                        <button onClick={authenticateEmail} style={{ ...S.btnPrimary, width: "auto", fontSize: 12, padding: "8px 18px" }}>Sign in with Microsoft</button>
                      )}
                    </div>
                  ) : (
                    <>
                      <div style={{ display: "flex", gap: 2, marginBottom: 12, flexWrap: "wrap" as const }}>
                        {(["inbox", "sent", "thread", "compose", "teams"] as const).map(tab => (
                          <button key={tab} onClick={() => { setDtlEmailTab(tab); if (tab === "compose") setDtlComposeSubject(prefix + " "); if (tab === "sent") loadDtlSentEmails(poNum); if (tab === "teams" && teamsToken && teamsChannelMap[poNum] && !teamsMessages[poNum]?.length) teamsLoadPOMessages(poNum); }}
                            style={{ padding: "8px 14px", border: "1px solid #334155", borderBottom: dtlEmailTab === tab ? "none" : "1px solid #334155", background: dtlEmailTab === tab ? "#1E293B" : "#0F172A", color: dtlEmailTab === tab ? (tab === "teams" ? TEAMS_PURPLE_LT : OUTLOOK_BLUE) : "#6B7280", fontWeight: dtlEmailTab === tab ? 700 : 500, cursor: "pointer", fontFamily: "inherit", fontSize: 12, borderRadius: "8px 8px 0 0" }}>
                            {tab === "teams" ? "💬 Teams" : tab.charAt(0).toUpperCase() + tab.slice(1)}
                          </button>
                        ))}
                      </div>

                      {dtlEmailTab === "inbox" && (
                        <>
                          {isLoading ? (
                            <div style={{ textAlign: "center", color: "#6B7280", padding: "24px 0", fontSize: 13 }}>Loading emails…</div>
                          ) : err ? (
                            <div style={{ background: "#7F1D1D", border: "1px solid #EF4444", borderRadius: 8, padding: "12px 16px", color: "#FCA5A5", fontSize: 13 }}>⚠ {err}</div>
                          ) : dtlList.length === 0 ? (
                            <div style={{ textAlign: "center", color: "#6B7280", padding: "24px 0" }}>
                              <div style={{ fontSize: 24, marginBottom: 6 }}>📧</div>
                              <div style={{ fontSize: 13 }}>No emails matching "{prefix}"</div>
                            </div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              {dtlList.map((em: any) => {
                                const sender = em.from?.emailAddress ? em.from.emailAddress.name || em.from.emailAddress.address : "Unknown";
                                const initials = sender.split(" ").map((w: string) => w[0] || "").join("").toUpperCase().slice(0, 2);
                                const time = em.receivedDateTime ? new Date(em.receivedDateTime).toLocaleString() : "";
                                return (
                                  <div key={em.id} onClick={() => { loadDtlFullEmail(em.id); if (em.conversationId) loadDtlThread(em.conversationId); }}
                                    style={{ background: em.isRead ? "#0F172A" : OUTLOOK_BLUE + "15", border: "1px solid " + (em.isRead ? "#334155" : OUTLOOK_BLUE + "44"), borderRadius: 8, padding: "10px 14px", cursor: "pointer", transition: "all 0.12s" }}>
                                    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                                      <div style={{ width: 30, height: 30, borderRadius: "50%", background: OUTLOOK_BLUE + "22", border: "2px solid " + OUTLOOK_BLUE, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: OUTLOOK_BLUE, flexShrink: 0 }}>{initials}</div>
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
                                          <span style={{ fontSize: 12, fontWeight: em.isRead ? 500 : 700, color: "#F1F5F9" }}>{sender}</span>
                                          <span style={{ fontSize: 10, color: "#6B7280" }}>{time}</span>
                                          {em.hasAttachments && <span style={{ fontSize: 10, color: "#6B7280" }}>📎</span>}
                                          {!em.isRead && <span style={{ width: 7, height: 7, borderRadius: "50%", background: OUTLOOK_BLUE, flexShrink: 0 }} />}
                                        </div>
                                        <div style={{ fontSize: 12, fontWeight: em.isRead ? 400 : 600, color: "#E2E8F0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{em.subject}</div>
                                        <div style={{ fontSize: 11, color: "#6B7280", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 1 }}>{em.bodyPreview || ""}</div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                              {dtlNextLink[pn] && (
                                <button onClick={() => loadDtlEmails(pn, dtlNextLink[pn]!)} disabled={dtlLoadingOlder} style={{ ...S.btnPrimary, opacity: dtlLoadingOlder ? 0.6 : 1, fontSize: 12 }}>{dtlLoadingOlder ? "Loading…" : "Load older emails"}</button>
                              )}
                            </div>
                          )}
                          <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
                            <button onClick={() => { setDtlEmailTab("compose"); setDtlComposeSubject(prefix + " "); }} style={{ ...S.btnPrimary, width: "auto", fontSize: 11, padding: "7px 14px" }}>+ New Email</button>
                            <span style={{ fontSize: 11, color: "#6B7280" }}>{dtlList.length} email{dtlList.length !== 1 ? "s" : ""}</span>
                          </div>
                        </>
                      )}

                      {dtlEmailTab === "sent" && (
                        <div>
                          {dtlSentLoading[pn] ? (
                            <div style={{ textAlign: "center", color: "#6B7280", padding: "24px 0", fontSize: 13 }}>Loading sent emails…</div>
                          ) : (dtlSentEmails[pn] || []).length === 0 ? (
                            <div style={{ textAlign: "center", color: "#6B7280", padding: "24px 0" }}><div style={{ fontSize: 24, marginBottom: 6 }}>📤</div><div style={{ fontSize: 13 }}>No sent emails for "{prefix}"</div></div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              {(dtlSentEmails[pn] || []).map((em: any) => {
                                const toList = (em.toRecipients || []).map((r: any) => r.emailAddress?.name || r.emailAddress?.address || "").filter(Boolean).join(", ") || "—";
                                const time = em.sentDateTime ? new Date(em.sentDateTime).toLocaleString() : "";
                                return (
                                  <div key={em.id} onClick={() => { loadDtlFullEmail(em.id); if (em.conversationId) loadDtlThread(em.conversationId); }}
                                    style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", cursor: "pointer" }}>
                                    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                                      <div style={{ width: 30, height: 30, borderRadius: "50%", background: OUTLOOK_BLUE + "22", border: "2px solid " + OUTLOOK_BLUE, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: OUTLOOK_BLUE, flexShrink: 0 }}>→</div>
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
                                          <span style={{ fontSize: 11, color: "#94A3B8" }}>To: {toList}</span>
                                          <span style={{ fontSize: 10, color: "#6B7280" }}>{time}</span>
                                          {em.hasAttachments && <span style={{ fontSize: 10, color: "#6B7280" }}>📎</span>}
                                        </div>
                                        <div style={{ fontSize: 12, fontWeight: 500, color: "#E2E8F0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{em.subject}</div>
                                        <div style={{ fontSize: 11, color: "#6B7280", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 1 }}>{em.bodyPreview || ""}</div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}

                      {dtlEmailTab === "thread" && (
                        <div>
                          {dtlThreadLoading ? (
                            <div style={{ textAlign: "center", color: "#6B7280", padding: "24px 0", fontSize: 13 }}>Loading thread…</div>
                          ) : dtlEmailThread.length === 0 ? (
                            <div style={{ textAlign: "center", color: "#6B7280", padding: "24px 0", fontSize: 13 }}>Click an email to view its thread</div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                              {dtlEmailThread.map((msg: any) => {
                                const sender = msg.from?.emailAddress ? msg.from.emailAddress.name || msg.from.emailAddress.address : "Unknown";
                                const initials = sender.split(" ").map((w: string) => w[0] || "").join("").toUpperCase().slice(0, 2);
                                const time = msg.receivedDateTime ? new Date(msg.receivedDateTime).toLocaleString() : "";
                                const htmlBody = msg.body?.content || "";
                                return (
                                  <div key={msg.id} style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "12px 16px" }}>
                                    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 8 }}>
                                      <div style={{ width: 28, height: 28, borderRadius: "50%", background: OUTLOOK_BLUE + "22", border: "2px solid " + OUTLOOK_BLUE, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: OUTLOOK_BLUE, flexShrink: 0 }}>{initials}</div>
                                      <div style={{ flex: 1 }}>
                                        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                                          <span style={{ fontSize: 12, fontWeight: 700, color: "#F1F5F9" }}>{sender}</span>
                                          <span style={{ fontSize: 10, color: "#6B7280" }}>{time}</span>
                                        </div>
                                        <div style={{ fontSize: 11, color: "#6B7280" }}>{msg.subject}</div>
                                      </div>
                                    </div>
                                    <iframe sandbox="allow-same-origin" srcDoc={styledEmailHtml(htmlBody)} style={{ width: "100%", border: "none", minHeight: 80, borderRadius: 6, background: "#F8FAFC" }}
                                      onLoad={e => { try { const h = (e.target as HTMLIFrameElement).contentDocument!.body.scrollHeight; (e.target as HTMLIFrameElement).style.height = Math.min(h + 20, 400) + "px"; } catch (_) {} }} />
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {dtlEmailSel && (
                            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                              <input value={dtlReply} onChange={e => setDtlReply(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); dtlReplyToEmail(dtlEmailSel.id); } }} placeholder="Write a reply…" style={{ ...S.input, flex: 1 }} />
                              <button onClick={() => dtlReplyToEmail(dtlEmailSel.id)} style={{ ...S.btnPrimary, width: "auto", padding: "10px 20px" }}>Reply</button>
                            </div>
                          )}
                        </div>
                      )}

                      {dtlEmailTab === "compose" && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                          <div>
                            <label style={S.label}>To (comma-separated)</label>
                            <input value={dtlComposeTo} onChange={e => setDtlComposeTo(e.target.value)} placeholder="email@example.com" style={S.input} />
                          </div>
                          <div>
                            <label style={S.label}>Subject</label>
                            <input value={dtlComposeSubject} onChange={e => setDtlComposeSubject(e.target.value)} style={S.input} />
                          </div>
                          <div>
                            <label style={S.label}>Body</label>
                            <textarea value={dtlComposeBody} onChange={e => setDtlComposeBody(e.target.value)} rows={8} style={{ ...S.textarea, minHeight: 120 }} placeholder="Type your message…" />
                          </div>
                          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                            <button onClick={() => setDtlEmailTab("inbox")} style={S.btnSecondary}>Cancel</button>
                            <button onClick={() => dtlSendEmail(pn)} disabled={!dtlComposeTo.trim() || !dtlComposeSubject.trim()} style={{ ...S.btnPrimary, width: "auto", opacity: (!dtlComposeTo.trim() || !dtlComposeSubject.trim()) ? 0.5 : 1 }}>Send Email</button>
                          </div>
                        </div>
                      )}

                      {dtlSendErr && (
                        <div style={{ marginTop: 8, background: "#7F1D1D", border: "1px solid #EF4444", borderRadius: 8, padding: "8px 14px", display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 12, color: "#FCA5A5", flex: 1 }}>⚠ {dtlSendErr}</span>
                          <button onClick={() => setDtlSendErr(null)} style={{ border: "none", background: "none", color: "#FCA5A5", cursor: "pointer", fontFamily: "inherit", fontWeight: 700, fontSize: 11 }}>✕</button>
                        </div>
                      )}

                      {dtlEmailTab === "teams" && (
                        <div>
                          {!teamsToken ? (
                            <div style={{ textAlign: "center", padding: "30px 0" }}>
                              <div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div>
                              <div style={{ color: "#6B7280", fontSize: 13, marginBottom: 12 }}>Sign in with Microsoft to use Teams</div>
                              {(!MS_CLIENT_ID || !MS_TENANT_ID) ? (
                                <div style={{ color: "#D97706", fontSize: 12 }}>Azure credentials not configured</div>
                              ) : (
                                <button onClick={authenticateTeams} style={{ ...S.btnPrimary, width: "auto", fontSize: 12, padding: "8px 18px" }}>Sign in with Microsoft</button>
                              )}
                            </div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                              {/* Channel Messages */}
                              <div style={{ background: "#0F172A", border: `1px solid ${TEAMS_PURPLE}44`, borderRadius: 10, overflow: "hidden" }}>
                                <div style={{ padding: "10px 14px", background: `${TEAMS_PURPLE}22`, borderBottom: `1px solid ${TEAMS_PURPLE}44`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                  <span style={{ fontSize: 12, fontWeight: 700, color: TEAMS_PURPLE_LT }}>💬 Channel: {pn}</span>
                                  <div style={{ display: "flex", gap: 6 }}>
                                    {teamsChannelMap[poNum] && <button onClick={() => teamsLoadPOMessages(poNum)} style={{ fontSize: 11, padding: "3px 9px", borderRadius: 6, border: `1px solid ${TEAMS_PURPLE}44`, background: "none", color: TEAMS_PURPLE_LT, cursor: "pointer", fontFamily: "inherit" }}>↻ Refresh</button>}
                                    <button onClick={() => { setSelected(null); setView("teams"); setTeamsSelPO(poNum); setTeamsTab("channels"); }} style={{ fontSize: 11, padding: "3px 9px", borderRadius: 6, border: `1px solid ${TEAMS_PURPLE}44`, background: `${TEAMS_PURPLE}22`, color: TEAMS_PURPLE_LT, cursor: "pointer", fontFamily: "inherit" }}>Open Teams ↗</button>
                                  </div>
                                </div>
                                {!teamsChannelMap[poNum] ? (
                                  <div style={{ padding: "14px 16px", fontSize: 12, color: "#6B7280", textAlign: "center" }}>
                                    No Teams channel for this PO.{" "}
                                    <button onClick={() => { setSelected(null); setView("teams"); setTeamsSelPO(poNum); }} style={{ color: TEAMS_PURPLE_LT, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600, textDecoration: "underline" }}>Go to Teams to create one</button>
                                  </div>
                                ) : teamsLoading[poNum] ? (
                                  <div style={{ padding: "14px 16px", fontSize: 12, color: "#6B7280", textAlign: "center" }}>Loading messages…</div>
                                ) : (teamsMessages[poNum] || []).length === 0 ? (
                                  <div style={{ padding: "14px 16px", fontSize: 12, color: "#6B7280", textAlign: "center" }}>No messages yet in this channel</div>
                                ) : (
                                  <div style={{ maxHeight: 200, overflowY: "auto" as const, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                                    {(teamsMessages[poNum] || []).slice(-5).map((msg: any) => {
                                      const author = msg.from?.user?.displayName || "Unknown";
                                      const clean = (msg.body?.content || "").replace(/<[^>]+>/g, "").trim();
                                      const time = msg.createdDateTime ? new Date(msg.createdDateTime).toLocaleString() : "";
                                      return (
                                        <div key={msg.id} style={{ background: "#1E293B", borderRadius: 8, padding: "8px 12px" }}>
                                          <div style={{ display: "flex", gap: 6, alignItems: "baseline", marginBottom: 3 }}>
                                            <span style={{ fontSize: 12, fontWeight: 700, color: TEAMS_PURPLE_LT }}>{author}</span>
                                            <span style={{ fontSize: 10, color: "#6B7280" }}>{time}</span>
                                          </div>
                                          <div style={{ fontSize: 12, color: "#CBD5E1", wordBreak: "break-word" as const }}>{clean || "[Attachment]"}</div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                                {teamsChannelMap[poNum] && (
                                  <div style={{ padding: "10px 12px", borderTop: `1px solid ${TEAMS_PURPLE}33`, display: "flex", gap: 8 }}>
                                    <input value={teamsNewMsg} onChange={e => setTeamsNewMsg(e.target.value)}
                                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); (async () => { const mp = teamsChannelMap[poNum]; if (!mp || !teamsNewMsg.trim() || !teamsToken) return; try { const sent = await teamsGraphPost(`/teams/${mp.teamId}/channels/${mp.channelId}/messages`, { body: { content: teamsNewMsg.trim(), contentType: "text" } }); setTeamsMessages(m => ({ ...m, [poNum]: [...(m[poNum] || []), sent] })); setTeamsNewMsg(""); } catch(e: any) {} })(); } }}
                                      placeholder="Message channel… (Enter to send)"
                                      style={{ flex: 1, background: "#0F172A", border: `1px solid ${TEAMS_PURPLE}44`, borderRadius: 7, padding: "8px 12px", color: "#F1F5F9", fontSize: 12, outline: "none", fontFamily: "inherit" }} />
                                  </div>
                                )}
                              </div>

                              {/* Quick DM */}
                              <div style={{ background: "#0F172A", border: `1px solid ${TEAMS_PURPLE}44`, borderRadius: 10, overflow: "visible" as const }}>
                                <div style={{ padding: "10px 14px", background: `${TEAMS_PURPLE}22`, borderBottom: `1px solid ${TEAMS_PURPLE}44` }}>
                                  <span style={{ fontSize: 12, fontWeight: 700, color: TEAMS_PURPLE_LT }}>↗ Quick Direct Message</span>
                                </div>
                                <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                                  <div style={{ position: "relative" as const }}>
                                    <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 4 }}>
                                      {teamsContactsLoading
                                        ? "Loading contacts…"
                                        : teamsContactsError
                                          ? <span style={{ color: "#F87171" }}>⚠ Failed — <button onClick={loadTeamsContacts} style={{ background: "none", border: "none", color: TEAMS_PURPLE_LT, cursor: "pointer", fontFamily: "inherit", fontSize: 11, padding: 0, textDecoration: "underline" }}>retry</button></span>
                                          : teamsContacts.length > 0
                                            ? `To (${teamsContacts.length} contacts)`
                                            : "To"}
                                    </div>
                                    <input value={dtlDMTo}
                                      onChange={e => handleTeamsContactInput(e.target.value, "dtl")}
                                      onFocus={() => { setDtlDMContactSearch(dtlDMTo); setDtlDMContactDropdown(true); }}
                                      onBlur={() => setTimeout(() => setDtlDMContactDropdown(false), 150)}
                                      placeholder="Search name or type email…"
                                      style={{ width: "100%", background: "#1E293B", border: `1px solid ${TEAMS_PURPLE}44`, borderRadius: 7, padding: "8px 12px", color: "#F1F5F9", fontSize: 12, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const }} />
                                    {dtlDMContactDropdown && (() => {
                                      const q = (dtlDMContactSearch || "").toLowerCase();
                                      const list = dtlDMContactSearchResults.length > 0
                                        ? dtlDMContactSearchResults
                                        : teamsContacts.filter((c: any) => !q || (c.displayName || "").toLowerCase().includes(q) || (c.userPrincipalName || "").toLowerCase().includes(q) || (c.scoredEmailAddresses?.[0]?.address || "").toLowerCase().includes(q) || (c.mail || "").toLowerCase().includes(q));
                                      if (list.length === 0 && !dtlDMContactSearchLoading) return null;
                                      return (
                                        <div style={{ position: "absolute" as const, top: "100%", left: 0, right: 0, zIndex: 200, background: "#1E293B", border: `1px solid ${TEAMS_PURPLE}66`, borderRadius: 8, maxHeight: 160, overflowY: "auto" as const, boxShadow: "0 8px 24px rgba(0,0,0,0.5)", marginTop: 2 }}>
                                          {dtlDMContactSearchLoading && <div style={{ padding: "6px 12px", fontSize: 11, color: "#6B7280" }}>Searching…</div>}
                                          {list.slice(0, 10).map((c: any) => {
                                            const email = c.userPrincipalName || c.mail || c.scoredEmailAddresses?.[0]?.address || "";
                                            return (
                                              <div key={email || c.displayName} onMouseDown={() => { setDtlDMTo(email); setDtlDMContactDropdown(false); setDtlDMContactSearch(""); setDtlDMContactSearchResults([]); }}
                                                style={{ padding: "8px 12px", cursor: "pointer", borderBottom: `1px solid ${TEAMS_PURPLE}33` }}>
                                                <div style={{ fontSize: 12, fontWeight: 600, color: "#F1F5F9" }}>{c.displayName}</div>
                                                <div style={{ fontSize: 11, color: "#6B7280" }}>{email}</div>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      );
                                    })()}
                                  </div>
                                  <textarea value={dtlDMMsg} onChange={e => { setDtlDMMsg(e.target.value); setDtlDMErr(null); }} rows={3}
                                    placeholder="Type your message…"
                                    style={{ width: "100%", background: "#1E293B", border: `1px solid ${TEAMS_PURPLE}44`, borderRadius: 7, padding: "8px 12px", color: "#F1F5F9", fontSize: 12, outline: "none", fontFamily: "inherit", resize: "vertical" as const, boxSizing: "border-box" as const }} />
                                  {dtlDMErr && <div style={{ fontSize: 11, color: "#EF4444" }}>⚠ {dtlDMErr}</div>}
                                  <button disabled={dtlDMSending || !dtlDMTo.trim() || !dtlDMMsg.trim()}
                                    onClick={async () => {
                                      if (!dtlDMTo.trim() || !dtlDMMsg.trim()) return;
                                      setDtlDMSending(true); setDtlDMErr(null);
                                      try {
                                        const me = await teamsGraph("/me");
                                        const chat = await teamsGraphPost("/chats", { chatType: "oneOnOne", members: [
                                          { "@odata.type": "#microsoft.graph.aadUserConversationMember", roles: ["owner"], "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${me.id}')` },
                                          { "@odata.type": "#microsoft.graph.aadUserConversationMember", roles: ["owner"], "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${dtlDMTo.trim()}')` },
                                        ]});
                                        await teamsGraphPost(`/chats/${chat.id}/messages`, { body: { content: dtlDMMsg.trim(), contentType: "text" } });
                                        setDtlDMMsg(""); setDtlDMTo("");
                                      } catch(e: any) { setDtlDMErr("Failed: " + e.message); }
                                      setDtlDMSending(false);
                                    }}
                                    style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px", fontSize: 12, fontWeight: 700, cursor: (dtlDMSending || !dtlDMTo.trim() || !dtlDMMsg.trim()) ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: (dtlDMSending || !dtlDMTo.trim() || !dtlDMMsg.trim()) ? 0.5 : 1, alignSelf: "flex-end" as const }}>
                                    {dtlDMSending ? "Sending…" : "Send DM ↗"}
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })()}

            {/* Production Milestones */}
            {showMilestones && (() => {
              const poNum = selected.PoNumber ?? "";
              const poMs = milestones[poNum] || [];
              const ddp = selected.DateExpectedDelivery;
              const vendorN = selected.VendorName ?? "";
              const hasVendorTpl = vendorHasTemplate(vendorN);
              const isAdmin = user?.role === "admin";
              const grouped: Record<string, Milestone[]> = {};
              poMs.forEach(m => { if (!grouped[m.category]) grouped[m.category] = []; grouped[m.category].push(m); });

              return (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <div style={S.sectionLabel}>Production Milestones</div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {poMs.length === 0 && ddp && hasVendorTpl && (
                        <button style={{ ...S.btnSecondary, fontSize: 11, padding: "4px 10px" }} onClick={() => ensureMilestones(selected)}>
                          Generate Milestones
                        </button>
                      )}
                      {poMs.length > 0 && (
                        <button style={{ ...S.btnSecondary, fontSize: 11, padding: "4px 10px" }} onClick={() => {
                          setConfirmModal({ title: "Regenerate Milestones", message: "Regenerate milestones? Your statuses, dates, and notes will be preserved.", icon: "🔄", confirmText: "Regenerate", confirmColor: "#3B82F6", onConfirm: () => regenerateMilestones(selected) });
                        }}>
                          Regenerate
                        </button>
                      )}
                    </div>
                  </div>
                  {poMs.length === 0 && !ddp && <p style={{ color: "#6B7280", fontSize: 13 }}>No expected delivery date — cannot generate milestones.</p>}
                  {poMs.length === 0 && ddp && hasVendorTpl && <p style={{ color: "#6B7280", fontSize: 13 }}>No milestones yet. Click "Generate Milestones" to create them.</p>}
                  {(() => {
                    // Dependency & cascade logic
                    const activeCats = WIP_CATEGORIES.filter(cat => grouped[cat]?.length);
                    const firstIncompleteCat = activeCats.find(cat => grouped[cat].some(m => m.status !== "Complete" && m.status !== "N/A"));

                    // Calculate cascade delays: for each category, check if any predecessor is late
                    const cascadeInfo: Record<string, { blocked: boolean; upstreamDelay: number; delayedCat: string }> = {};
                    activeCats.forEach((cat, idx) => {
                      cascadeInfo[cat] = { blocked: false, upstreamDelay: 0, delayedCat: "" };
                      // Check all preceding categories
                      for (let p = 0; p < idx; p++) {
                        const prevCat = activeCats[p];
                        const prevMs = grouped[prevCat] || [];
                        const prevDone = prevMs.every(m => m.status === "Complete" || m.status === "N/A");
                        if (!prevDone) {
                          cascadeInfo[cat].blocked = true;
                          // Calculate max days late from predecessor's overdue milestones
                          const maxLate = prevMs.reduce((max, m) => {
                            if (m.status === "Complete" || m.status === "N/A" || !m.expected_date) return max;
                            const daysLate = Math.ceil((Date.now() - new Date(m.expected_date).getTime()) / 86400000);
                            return daysLate > 0 ? Math.max(max, daysLate) : max;
                          }, 0);
                          if (maxLate > cascadeInfo[cat].upstreamDelay) {
                            cascadeInfo[cat].upstreamDelay = maxLate;
                            cascadeInfo[cat].delayedCat = prevCat;
                          }
                        }
                      }
                    });

                    return activeCats;
                  })().map(cat => {
                    const catMs = (grouped[cat] || []).sort((a, b) => {
                      // Sort by expected_date first (chronological), then sort_order as tiebreaker
                      if (a.expected_date && b.expected_date) { const d = a.expected_date.localeCompare(b.expected_date); if (d !== 0) return d; }
                      if (a.expected_date && !b.expected_date) return -1;
                      if (!a.expected_date && b.expected_date) return 1;
                      return a.sort_order - b.sort_order;
                    });
                    const catComplete = catMs.filter(m => m.status === "Complete").length;
                    const activeCats = WIP_CATEGORIES.filter(c => grouped[c]?.length);
                    const firstIncompleteCat = activeCats.find(c => grouped[c].some(m => m.status !== "Complete" && m.status !== "N/A"));
                    const defaultCollapsed = cat !== firstIncompleteCat;
                    const key = cat + poNum;
                    const collapsed = collapsedCats[key] !== undefined ? collapsedCats[key] : defaultCollapsed;

                    // Cascade info for this category
                    const cascade = (() => {
                      const info = { blocked: false, upstreamDelay: 0, delayedCat: "" };
                      const catIdx = activeCats.indexOf(cat);
                      for (let p = 0; p < catIdx; p++) {
                        const prevCat = activeCats[p];
                        const prevMs = grouped[prevCat] || [];
                        const prevDone = prevMs.every(m => m.status === "Complete" || m.status === "N/A");
                        if (!prevDone) {
                          info.blocked = true;
                          const maxLate = prevMs.reduce((max, m) => {
                            if (m.status === "Complete" || m.status === "N/A" || !m.expected_date) return max;
                            const daysLate = Math.ceil((Date.now() - new Date(m.expected_date).getTime()) / 86400000);
                            return daysLate > 0 ? Math.max(max, daysLate) : max;
                          }, 0);
                          if (maxLate > info.upstreamDelay) { info.upstreamDelay = maxLate; info.delayedCat = prevCat; }
                        }
                      }
                      return info;
                    })();

                    return (
                      <div key={cat} style={{ marginBottom: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: cascade.blocked ? "#1A1520" : "#0F172A", borderRadius: collapsed ? 8 : "8px 8px 0 0", cursor: "pointer", userSelect: "none", borderLeft: cascade.blocked ? "3px solid #F59E0B" : "3px solid transparent" }}
                          onClick={() => {
                            const catKey = cat + poNum;
                            if (collapsed && cascade.blocked && !acceptedBlocked.has(catKey)) {
                              setBlockedModal({ cat, delayedCat: cascade.delayedCat, daysLate: cascade.upstreamDelay, onConfirm: () => {
                                setAcceptedBlocked(prev => new Set(prev).add(catKey));
                                setCollapsedCats(prev => ({ ...prev, [catKey]: false }));
                              }});
                              return;
                            }
                            setCollapsedCats(prev => ({ ...prev, [catKey]: !collapsed }));
                          }}>
                          <span style={{ color: "#6B7280", fontSize: 12 }}>{collapsed ? "▶" : "▼"}</span>
                          <span style={{ color: catComplete === catMs.length ? "#10B981" : "#94A3B8", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, transition: "color 0.5s" }}>{cat}{catComplete === catMs.length ? " ✓" : ""}</span>
                          {cascade.blocked && (
                            <span style={{ fontSize: 10, color: "#F59E0B", fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "#F59E0B18", border: "1px solid #F59E0B33" }}>
                              ⚠ Blocked by {cascade.delayedCat}{cascade.upstreamDelay > 0 ? ` (${cascade.upstreamDelay}d late)` : ""}
                            </span>
                          )}
                          <span style={{ color: "#6B7280", fontSize: 11, marginLeft: "auto" }}>{catComplete}/{catMs.length}</span>
                        </div>
                        {!collapsed && (
                          <div style={{ background: "#0F172A", borderRadius: "0 0 8px 8px", overflow: "hidden" }}>
                            <div style={{ display: "grid", gridTemplateColumns: "1.5fr 130px 26px 120px 120px 55px 32px", gap: 6, padding: "5px 14px", background: "#1E293B" }}>
                              <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>Milestone</span>
                              <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "center" }}>Due Date</span>
                              <span />
                              <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "center" }}>Status</span>
                              <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "center" }}>Status Date</span>
                              <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "right" }}>Days</span>
                              <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "center" }}>📝</span>
                            </div>
                            {catMs.map(m => {
                              const daysRem = m.expected_date ? Math.ceil((new Date(m.expected_date).getTime() - Date.now()) / 86400000) : null;
                              const daysColor = m.status === "Complete" ? "#10B981" : m.status === "N/A" ? "#6B7280" : daysRem === null ? "#6B7280" : daysRem < 0 ? "#EF4444" : daysRem <= 7 ? "#F59E0B" : "#10B981";
                              // Cascade: if blocked, show projected date shifted by upstream delay
                              const projectedDate = cascade.upstreamDelay > 0 && m.expected_date && m.status !== "Complete" && m.status !== "N/A"
                                ? new Date(new Date(m.expected_date).getTime() + cascade.upstreamDelay * 86400000).toISOString().slice(0, 10) : null;
                              // Delay warning: status date later than due date
                              const statusDateVal = (m.status_dates || {})[m.status] || m.status_date || null;
                              const delayDays = statusDateVal && m.expected_date
                                ? Math.ceil((new Date(statusDateVal).getTime() - new Date(m.expected_date).getTime()) / 86400000)
                                : 0;
                              // Variant panel
                              const variantOpen = expandedVariants.has(m.id);
                              const variantStatuses = m.variant_statuses || {};
                              const hasMismatch = Object.values(variantStatuses).some(v => v.status !== m.status);
                              return (
                                <div key={m.id} style={{ display: "contents" }}>
                                <div style={{ display: "grid", gridTemplateColumns: "1.5fr 130px 26px 120px 120px 55px 32px", gap: 6, padding: "8px 14px", borderTop: "1px solid #1E293B", alignItems: "center", background: cascade.blocked && m.status !== "Complete" && m.status !== "N/A" ? "#F59E0B08" : "transparent" }}>
                                  <span style={{ color: "#D1D5DB", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                    {m.phase}
                                    {delayDays > 0 && (
                                      <span style={{ fontSize: 10, background: "#7F1D1D", color: "#FCA5A5", borderRadius: 4, padding: "1px 5px", fontWeight: 600, whiteSpace: "nowrap" }}>
                                        ⚠ {delayDays}d delayed
                                      </span>
                                    )}
                                    {hasMismatch && (
                                      <span style={{ fontSize: 10, background: "#78350F", color: "#FDE68A", borderRadius: 4, padding: "1px 5px", fontWeight: 600, whiteSpace: "nowrap" }}>
                                        ⚠ Color mismatch
                                      </span>
                                    )}
                                  </span>
                                  <div style={{ textAlign: "center" }}>
                                    <input type="date" value={m.expected_date || ""} onChange={e => cascadeDueDateChange(m, e.target.value)}
                                      style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 6, color: projectedDate ? "#F59E0B" : "#9CA3AF", fontSize: 12, padding: "4px 6px", width: "100%", boxSizing: "border-box", outline: "none" }} />
                                    {projectedDate && <div style={{ fontSize: 9, color: "#F59E0B", marginTop: 1 }}>→ {fmtDate(projectedDate)}</div>}
                                  </div>
                                  {/* ⊕ Variant expand button */}
                                  <button
                                    title="Color/variant statuses"
                                    onClick={() => setExpandedVariants(prev => { const next = new Set(prev); variantOpen ? next.delete(m.id) : next.add(m.id); return next; })}
                                    style={{ width: 22, height: 22, borderRadius: "50%", border: `1px solid ${variantOpen ? "#60A5FA" : hasMismatch ? "#FDE68A" : "#334155"}`, background: variantOpen ? "#1D4ED8" : hasMismatch ? "#78350F" : "#0F172A", color: variantOpen ? "#fff" : hasMismatch ? "#FDE68A" : "#6B7280", fontSize: 14, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1, padding: 0, flexShrink: 0 }}
                                  >{variantOpen ? "−" : "+"}</button>
                                  <select style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 6, color: MILESTONE_STATUS_COLORS[m.status] || "#6B7280", fontSize: 12, padding: "5px 6px", width: "100%", boxSizing: "border-box" }}
                                    value={m.status}
                                    onChange={e => {
                                      const newStatus = e.target.value;
                                      const oldStatus = m.status;
                                      const dates = { ...(m.status_dates || {}) };
                                      const doSave = (d: Record<string, string>) => {
                                        const today2 = new Date().toISOString().split("T")[0];
                                        if (newStatus !== "Not Started" && !d[newStatus]) d[newStatus] = today2;
                                        const statusDate = d[newStatus] || null;
                                        // Sync all variants to the new main status (unless they have been individually overridden to something different)
                                        const existingVariants = { ...(m.variant_statuses || {}) };
                                        const syncedVariants: Record<string, { status: string; status_date: string | null }> = {};
                                        Object.keys(existingVariants).forEach(key => {
                                          syncedVariants[key] = { status: newStatus, status_date: statusDate };
                                        });
                                        saveMilestone({ ...m, status: newStatus, status_date: statusDate, status_dates: Object.keys(d).length > 0 ? d : null, variant_statuses: Object.keys(syncedVariants).length > 0 ? syncedVariants : m.variant_statuses, updated_at: new Date().toISOString(), updated_by: user?.name || "" });
                                      };
                                      if (oldStatus === "Complete" && dates[oldStatus]) {
                                        setConfirmModal({ title: "Clear Complete Date", message: `Clear the "Complete" date (${dates[oldStatus]})?`, icon: "📅", confirmText: "Clear Date", confirmColor: "#F59E0B", cancelText: "Keep Date", onConfirm: () => { delete dates[oldStatus]; doSave(dates); }, onCancel: () => doSave(dates) });
                                        return;
                                      }
                                      doSave(dates);
                                    }}>
                                    {MILESTONE_STATUSES.map(s => <option key={s} value={s} style={{ color: MILESTONE_STATUS_COLORS[s] }}>{s}</option>)}
                                  </select>
                                  <input type="date" style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 6, color: (m.status_dates || {})[m.status] ? "#60A5FA" : "#334155", fontSize: 12, padding: "5px 6px", width: "100%", boxSizing: "border-box" }}
                                    title={`Date for "${m.status}" status`}
                                    value={(m.status_dates || {})[m.status] || m.status_date || ""}
                                    onChange={e => {
                                      const val = e.target.value || null;
                                      const dates = { ...(m.status_dates || {}) };
                                      if (val) dates[m.status] = val; else delete dates[m.status];
                                      // Sync variant status dates too
                                      const existingVariants = { ...(m.variant_statuses || {}) };
                                      const syncedVariants: Record<string, { status: string; status_date: string | null }> = {};
                                      Object.keys(existingVariants).forEach(key => {
                                        if (existingVariants[key].status === m.status) {
                                          syncedVariants[key] = { status: m.status, status_date: val };
                                        } else {
                                          syncedVariants[key] = existingVariants[key];
                                        }
                                      });
                                      saveMilestone({ ...m, status_date: val, status_dates: Object.keys(dates).length > 0 ? dates : null, variant_statuses: Object.keys(syncedVariants).length > 0 ? syncedVariants : m.variant_statuses, updated_at: new Date().toISOString(), updated_by: user?.name || "" });
                                    }} />
                                  <span style={{ color: daysColor, fontWeight: 600, textAlign: "right", fontSize: 12 }}>
                                    {m.status === "Complete" ? "Done" : m.status === "N/A" ? "—" : daysRem === null ? "—" : daysRem < 0 ? `${Math.abs(daysRem)}d late` : daysRem === 0 ? "Today" : `${daysRem}d`}
                                  </span>
                                  <span style={{ textAlign: "center", cursor: "pointer", fontSize: 14, opacity: (m.note_entries?.length || m.notes) ? 1 : 0.4, position: "relative" }} title={m.notes || "Add note"} onClick={e => { e.stopPropagation(); setEditingNote(editingNote === m.id ? null : m.id); setMsNoteText(""); }}>📝{(m.note_entries?.length ?? 0) > 0 && <span style={{ position: "absolute", top: -4, right: -6, fontSize: 8, background: "#3B82F6", color: "#fff", borderRadius: "50%", width: 14, height: 14, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{m.note_entries!.length}</span>}</span>
                                </div>
                                {/* Variant/color status panel */}
                                {variantOpen && (
                                  <div style={{ padding: "8px 14px 10px 14px", borderTop: "1px solid #1E293B", background: "#0A1220" }}>
                                    <div style={{ fontSize: 10, color: "#60A5FA", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Color / Variant Statuses</div>
                                    {matrixRows.length === 0 ? (
                                      <div style={{ fontSize: 12, color: "#4B5563", fontStyle: "italic" }}>No line items on this PO</div>
                                    ) : (
                                      <div style={{ overflowX: "auto" }}>
                                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                                          <thead>
                                            <tr>
                                              {["Base Part","Description","Color","Status","Status Date","Qty","PO Cost","Total Cost"].map(h => (
                                                <th key={h} style={{ padding: "6px 10px", textAlign: h === "Qty" || h === "PO Cost" || h === "Total Cost" ? "right" : "left", color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 1, borderBottom: "1px solid #334155", whiteSpace: "nowrap" }}>{h}</th>
                                              ))}
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {matrixRows.map((row) => {
                                              const key = `${row.base}-${row.color}`;
                                              const vEntry = variantStatuses[key] || { status: m.status, status_date: statusDateVal };
                                              const vMismatch = vEntry.status !== m.status;
                                              return (
                                                <tr key={key} style={{ borderBottom: "1px solid #1E293B", background: vMismatch ? "#78350F22" : "transparent" }}>
                                                  <td style={{ padding: "5px 10px", color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, whiteSpace: "nowrap" }}>{row.base}</td>
                                                  <td style={{ padding: "5px 10px", color: "#9CA3AF", fontSize: 11 }}>{row.desc || "—"}</td>
                                                  <td style={{ padding: "5px 10px", color: vMismatch ? "#FDE68A" : "#D1D5DB", whiteSpace: "nowrap" }}>
                                                    {row.color || "—"}
                                                    {vMismatch && <span style={{ fontSize: 10, color: "#F59E0B", marginLeft: 6 }}>⚠</span>}
                                                  </td>
                                                  <td style={{ padding: "5px 10px" }}>
                                                    <select
                                                      value={vEntry.status}
                                                      style={{ background: "#1E293B", border: `1px solid ${vMismatch ? "#F59E0B44" : "#334155"}`, borderRadius: 6, color: MILESTONE_STATUS_COLORS[vEntry.status] || "#6B7280", fontSize: 11, padding: "3px 5px", width: "100%", boxSizing: "border-box" as const }}
                                                      onChange={e => {
                                                        const today2 = new Date().toISOString().split("T")[0];
                                                        const newV = { ...variantStatuses, [key]: { status: e.target.value, status_date: vEntry.status_date || today2 } };
                                                        saveMilestone({ ...m, variant_statuses: newV, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
                                                      }}
                                                    >
                                                      {MILESTONE_STATUSES.map(s => <option key={s} value={s} style={{ color: MILESTONE_STATUS_COLORS[s] }}>{s}</option>)}
                                                    </select>
                                                  </td>
                                                  <td style={{ padding: "5px 10px" }}>
                                                    <input
                                                      type="date"
                                                      value={vEntry.status_date || ""}
                                                      style={{ background: "#1E293B", border: `1px solid ${vEntry.status_date ? "#60A5FA44" : "#334155"}`, borderRadius: 6, color: vEntry.status_date ? "#60A5FA" : "#334155", fontSize: 11, padding: "3px 5px", width: "100%", boxSizing: "border-box" as const }}
                                                      onChange={e => {
                                                        const newV = { ...variantStatuses, [key]: { status: vEntry.status, status_date: e.target.value || null } };
                                                        saveMilestone({ ...m, variant_statuses: newV, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
                                                      }}
                                                    />
                                                  </td>
                                                  <td style={{ padding: "5px 10px", textAlign: "right", color: "#F59E0B", fontWeight: 700, fontFamily: "monospace" }}>{row.qty}</td>
                                                  <td style={{ padding: "5px 10px", textAlign: "right", color: "#9CA3AF", fontFamily: "monospace" }}>{fmtCurrency(row.price, selected.CurrencyCode)}</td>
                                                  <td style={{ padding: "5px 10px", textAlign: "right", color: "#10B981", fontWeight: 600, fontFamily: "monospace" }}>{fmtCurrency(row.qty * row.price, selected.CurrencyCode)}</td>
                                                </tr>
                                              );
                                            })}
                                          </tbody>
                                          <tfoot>
                                            <tr style={{ borderTop: "2px solid #334155" }}>
                                              <td colSpan={5} style={{ padding: "8px 10px", color: "#9CA3AF", fontWeight: 700, textAlign: "right" }}>Grand Total</td>
                                              <td style={{ padding: "8px 10px", textAlign: "right", color: "#F59E0B", fontWeight: 800, fontFamily: "monospace" }}>{matrixRows.reduce((s, r) => s + r.qty, 0)}</td>
                                              <td style={{ padding: "8px 10px" }} />
                                              <td style={{ padding: "8px 10px", textAlign: "right", color: "#10B981", fontWeight: 800, fontFamily: "monospace" }}>{fmtCurrency(matrixRows.reduce((s, r) => s + r.qty * r.price, 0), selected.CurrencyCode)}</td>
                                            </tr>
                                          </tfoot>
                                        </table>
                                      </div>
                                    )}
                                  </div>
                                )}
                                {editingNote === m.id && (() => {
                                  const entries = m.note_entries || [];
                                  // Show legacy note as first entry if exists and no entries yet
                                  const legacy = m.notes && entries.length === 0 ? [{ text: m.notes, user: m.updated_by || "—", date: m.updated_at || "" }] : [];
                                  const allNotes = [...legacy, ...entries];
                                  return (
                                    <div style={{ padding: "8px 14px 10px", borderTop: "1px solid #1E293B", background: "#1A2332" }}>
                                      {allNotes.length > 0 && (
                                        <div style={{ marginBottom: 8, maxHeight: 120, overflowY: "auto" }}>
                                          {allNotes.map((n, i) => {
                                            const timeAgo = n.date ? (() => { const ms = Date.now() - new Date(n.date).getTime(); const mins = Math.floor(ms / 60000); if (mins < 60) return `${mins}m ago`; const hrs = Math.floor(mins / 60); if (hrs < 24) return `${hrs}h ago`; return `${Math.floor(hrs / 24)}d ago`; })() : "";
                                            return (
                                              <div key={i} style={{ display: "flex", gap: 8, padding: "4px 0", borderBottom: i < allNotes.length - 1 ? "1px solid #0F172A" : "none" }}>
                                                <div style={{ flex: 1, fontSize: 12, color: "#D1D5DB", lineHeight: 1.4 }}>{n.text}</div>
                                                <div style={{ flexShrink: 0, textAlign: "right" }}>
                                                  <div style={{ fontSize: 10, color: "#60A5FA", fontWeight: 600 }}>{n.user}</div>
                                                  <div style={{ fontSize: 9, color: "#4B5563" }}>{timeAgo}</div>
                                                </div>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      )}
                                      <div style={{ display: "flex", gap: 6 }}>
                                        <input value={msNoteText} onChange={e => setMsNoteText(e.target.value)} placeholder="Add a note..." onKeyDown={e => {
                                          if (e.key === "Enter" && msNoteText.trim()) {
                                            const newEntry = { text: msNoteText.trim(), user: user?.name || "—", date: new Date().toISOString() };
                                            saveMilestone({ ...m, note_entries: [...entries, newEntry], notes: [...allNotes.map(n => n.text), msNoteText.trim()].join(" | "), updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
                                            setMsNoteText("");
                                          }
                                        }} style={{ flex: 1, background: "#0F172A", border: "1px solid #334155", borderRadius: 6, color: "#D1D5DB", fontSize: 12, padding: "6px 10px", fontFamily: "inherit", outline: "none" }} />
                                        <button onClick={() => {
                                          if (!msNoteText.trim()) return;
                                          const newEntry = { text: msNoteText.trim(), user: user?.name || "—", date: new Date().toISOString() };
                                          saveMilestone({ ...m, note_entries: [...entries, newEntry], notes: [...allNotes.map(n => n.text), msNoteText.trim()].join(" | "), updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
                                          setMsNoteText("");
                                        }} style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#3B82F6", color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Add</button>
                                      </div>
                                    </div>
                                  );
                                })()}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {poMs.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      {!addingPhase ? (
                        <button onClick={() => setAddingPhase(true)} style={{ ...S.btnSecondary, fontSize: 11, padding: "5px 12px" }}>+ Add Custom Phase</button>
                      ) : (() => {
                        // Build list of phases in the selected category for "Insert After" dropdown
                        const catPhases = poMs.filter(m => m.category === newPhaseForm.category).sort((a, b) => a.sort_order - b.sort_order);
                        return (
                        <div style={{ background: "#0F172A", borderRadius: 8, padding: 12 }}>
                          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                            <div style={{ flex: 1, minWidth: 140 }}>
                              <label style={{ color: "#6B7280", fontSize: 10, display: "block", marginBottom: 3, textTransform: "uppercase" }}>Phase Name</label>
                              <input value={newPhaseForm.name} onChange={e => setNewPhaseForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Client Approval" style={{ ...S.input, marginBottom: 0, fontSize: 12, padding: "6px 10px" }} />
                            </div>
                            <div style={{ width: 150 }}>
                              <label style={{ color: "#6B7280", fontSize: 10, display: "block", marginBottom: 3, textTransform: "uppercase" }}>Category</label>
                              <select value={newPhaseForm.category} onChange={e => setNewPhaseForm(f => ({ ...f, category: e.target.value, afterPhase: "" }))} style={{ ...S.select, width: "100%", fontSize: 12, padding: "6px 8px" }}>
                                {WIP_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                              </select>
                            </div>
                            <div style={{ width: 140 }}>
                              <label style={{ color: "#6B7280", fontSize: 10, display: "block", marginBottom: 3, textTransform: "uppercase" }}>Due Date</label>
                              <input type="date" value={newPhaseForm.dueDate} onChange={e => setNewPhaseForm(f => ({ ...f, dueDate: e.target.value }))} style={{ ...S.input, marginBottom: 0, fontSize: 12, padding: "5px 8px" }} />
                            </div>
                            <div style={{ width: 180 }}>
                              <label style={{ color: "#6B7280", fontSize: 10, display: "block", marginBottom: 3, textTransform: "uppercase" }}>Insert After</label>
                              <select value={newPhaseForm.afterPhase} onChange={e => setNewPhaseForm(f => ({ ...f, afterPhase: e.target.value }))} style={{ ...S.select, width: "100%", fontSize: 12, padding: "6px 8px" }}>
                                <option value="">— At beginning —</option>
                                {catPhases.map(p => <option key={p.id} value={p.id}>{p.phase}</option>)}
                              </select>
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                            <button onClick={() => { setAddingPhase(false); setNewPhaseForm({ name: "", category: "Pre-Production", dueDate: "", afterPhase: "" }); }} style={{ ...S.btnSecondary, fontSize: 11, padding: "7px 12px" }}>Cancel</button>
                            <button onClick={() => {
                              if (!newPhaseForm.name.trim()) return;
                              const allCatMs = poMs.filter(m => m.category === newPhaseForm.category).sort((a, b) => a.sort_order - b.sort_order);
                              let sortOrder: number;
                              let insertRef = "";
                              let autoDueDate = newPhaseForm.dueDate || "";

                              if (newPhaseForm.afterPhase) {
                                // Explicit position: insert after selected phase
                                const afterIdx = allCatMs.findIndex(m => m.id === newPhaseForm.afterPhase);
                                if (afterIdx >= 0) {
                                  const afterSort = allCatMs[afterIdx].sort_order;
                                  const nextSort = afterIdx + 1 < allCatMs.length ? allCatMs[afterIdx + 1].sort_order : afterSort + 100;
                                  sortOrder = afterSort + (nextSort - afterSort) / 2;
                                  insertRef = " (after " + allCatMs[afterIdx].phase + ")";
                                  // Auto-calculate midpoint due date if not provided
                                  if (!autoDueDate) {
                                    const afterDate = allCatMs[afterIdx].expected_date;
                                    const nextM = afterIdx + 1 < allCatMs.length ? allCatMs[afterIdx + 1] : null;
                                    const nextDate = nextM?.expected_date;
                                    if (afterDate && nextDate) {
                                      const mid = new Date((new Date(afterDate).getTime() + new Date(nextDate).getTime()) / 2);
                                      autoDueDate = mid.toISOString().slice(0, 10);
                                    } else if (afterDate) {
                                      // No next phase — add 7 days after
                                      const d = new Date(afterDate); d.setDate(d.getDate() + 7);
                                      autoDueDate = d.toISOString().slice(0, 10);
                                    }
                                  }
                                } else { sortOrder = (allCatMs.length + 1) * 100; }
                              } else if (newPhaseForm.dueDate && allCatMs.length > 0) {
                                // Auto-position by due date: find where it fits chronologically
                                const dueMs = allCatMs.filter(m => m.expected_date);
                                const insertAfterIdx = dueMs.reduce((best, m, i) => m.expected_date && m.expected_date <= newPhaseForm.dueDate ? i : best, -1);
                                if (insertAfterIdx >= 0) {
                                  const afterM = dueMs[insertAfterIdx];
                                  const afterIdx = allCatMs.indexOf(afterM);
                                  const afterSort = afterM.sort_order;
                                  const nextSort = afterIdx + 1 < allCatMs.length ? allCatMs[afterIdx + 1].sort_order : afterSort + 100;
                                  sortOrder = afterSort + (nextSort - afterSort) / 2;
                                  insertRef = " (by date, after " + afterM.phase + ")";
                                } else {
                                  // Due date is before all existing — put first
                                  sortOrder = allCatMs[0].sort_order - 100;
                                  insertRef = " (by date, at beginning)";
                                }
                              } else {
                                // No position info — add at end
                                sortOrder = allCatMs.length > 0 ? allCatMs[allCatMs.length - 1].sort_order + 100 : 0;
                              }

                              const newM: Milestone = { id: milestoneUid(), po_number: poNum, phase: newPhaseForm.name.trim(), category: newPhaseForm.category, sort_order: sortOrder, days_before_ddp: 0, expected_date: autoDueDate || null, actual_date: null, status: "Not Started", status_date: null, status_dates: null, notes: "", note_entries: null, updated_at: new Date().toISOString(), updated_by: user?.name || "" };
                              saveMilestone(newM, true);
                              addHistory(poNum, `Custom phase added: "${newPhaseForm.name.trim()}" in ${newPhaseForm.category}${insertRef}`);
                              setNewPhaseForm({ name: "", category: "Pre-Production", dueDate: "", afterPhase: "" });
                              setAddingPhase(false);
                            }} style={{ ...S.btnPrimary, fontSize: 11, padding: "7px 14px", width: "auto", whiteSpace: "nowrap" }}>Add Phase</button>
                          </div>
                        </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Notes Tab */}
            {showNotes && <div>
              <div style={S.sectionLabel}>Notes</div>
              {selectedNotes.length === 0 && <p style={{ color: "#6B7280", fontSize: 13 }}>No notes yet.</p>}
              {selectedNotes.map(n => (
                <div key={n.id} style={S.noteCard}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ color: "#60A5FA", fontWeight: 700, fontSize: 14 }}>{n.user_name}</span>
                    <span style={{ color: "#9CA3AF", fontSize: 13 }}>{fmtDate(n.created_at)} {new Date(n.created_at).toLocaleTimeString()}</span>
                  </div>
                  <p style={{ color: "#D1D5DB", fontSize: 15, margin: 0 }}>{n.note}</p>
                </div>
              ))}
              <div style={{ marginTop: 12, display: "flex", gap: 8, flexDirection: "column" }}>
                <textarea style={S.textarea} rows={3} placeholder="Add a note..."
                  value={newNote} onChange={e => setNewNote(e.target.value)} />
                <button style={S.btnPrimary} onClick={addNote}>Add Note</button>
              </div>
            </div>}

            {/* History Tab */}
            {showHistory && <div>
              <div style={S.sectionLabel}>Change History</div>
              {selectedHistory.length === 0 && <p style={{ color: "#6B7280", fontSize: 13 }}>No history recorded yet.</p>}
              {selectedHistory.map(h => (
                <div key={h.id} style={{ display: "flex", gap: 12, padding: "10px 14px", borderBottom: "1px solid #334155", alignItems: "flex-start" }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#3B82F6", marginTop: 6, flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <p style={{ color: "#D1D5DB", fontSize: 14, margin: 0 }}>{h.note}</p>
                    <div style={{ display: "flex", gap: 12, marginTop: 4, fontSize: 11, color: "#6B7280" }}>
                      <span>{h.user_name}</span>
                      <span>{fmtDate(h.created_at)} {new Date(h.created_at).toLocaleTimeString()}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>}
          </div>
        </div>
      </div>
    );
  };

  function InfoCell({ label, value }: { label: string; value: React.ReactNode }) {
    return (
      <div style={S.infoCell}>
        <div style={S.infoCellLabel}>{label}</div>
        <div style={S.infoCellValue}>{value}</div>
      </div>
    );
  }

  function WipTemplateEditor({ templates, onSave }: { templates: WipTemplate[]; onSave: (t: WipTemplate[]) => void }) {
    const [adding, setAdding] = useState(false);
    const [form, setForm] = useState<WipTemplate>({ id: "", phase: "", category: "Pre-Production", daysBeforeDDP: 0, status: "Not Started", notes: "" });

    if (!adding) return (
      <button style={{ ...S.btnSecondary, marginTop: 12 }} onClick={() => { setForm({ id: milestoneUid(), phase: "", category: "Pre-Production", daysBeforeDDP: 0, status: "Not Started", notes: "" }); setAdding(true); }}>
        + Add Phase
      </button>
    );

    return (
      <div style={{ marginTop: 12, background: "#0F172A", borderRadius: 8, padding: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
          <div>
            <label style={{ color: "#94A3B8", fontSize: 11, display: "block", marginBottom: 3 }}>Phase Name</label>
            <input style={{ ...S.input, fontSize: 13 }} value={form.phase} onChange={e => setForm(f => ({ ...f, phase: e.target.value }))} placeholder="e.g. Lab Dip" />
          </div>
          <div>
            <label style={{ color: "#94A3B8", fontSize: 11, display: "block", marginBottom: 3 }}>Category</label>
            <select style={{ ...S.select, width: "100%" }} value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
              {WIP_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
          <div>
            <label style={{ color: "#94A3B8", fontSize: 11, display: "block", marginBottom: 3 }}>Days Before DDP</label>
            <input type="number" style={{ ...S.input, fontSize: 13 }} value={form.daysBeforeDDP} onChange={e => setForm(f => ({ ...f, daysBeforeDDP: parseInt(e.target.value) || 0 }))} />
          </div>
          <div>
            <label style={{ color: "#94A3B8", fontSize: 11, display: "block", marginBottom: 3 }}>Default Status</label>
            <select style={{ ...S.select, width: "100%" }} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
              {MILESTONE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button style={S.btnSecondary} onClick={() => setAdding(false)}>Cancel</button>
          <button style={{ ...S.btnPrimary, width: "auto", padding: "8px 16px" }} onClick={() => {
            if (!form.phase.trim()) return;
            onSave([...templates, form]);
            setAdding(false);
          }}>Add Phase</button>
        </div>
      </div>
    );
  }

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

  function emailViewPanel() {
    const C = {
      bg0: "#0F172A", bg1: "#1E293B", bg2: "#253347", bg3: "#2D3D52",
      border: "#334155", border2: "#3E4F66",
      text1: "#F1F5F9", text2: "#94A3B8", text3: "#6B7280",
      outlook: "#0078D4", outlookLt: "#106EBE", outlookDim: "rgba(0,120,212,0.15)",
      error: "#EF4444", errorDim: "rgba(239,68,68,0.15)",
      success: "#34D399", info: "#60A5FA", warning: "#FBBF24",
    };
    const poList = pos;

    function FolderIcon({ size = 14, color = "currentColor" }: { size?: number; color?: string }) {
      return (
        <svg width={size} height={size} viewBox="0 0 16 14" fill="none" style={{ flexShrink: 0 }}>
          <path d="M1 2.5C1 1.67 1.67 1 2.5 1H5.5L7 2.5H13.5C14.33 2.5 15 3.17 15 4V11.5C15 12.33 14.33 13 13.5 13H2.5C1.67 13 1 12.33 1 11.5V2.5Z" stroke={color} strokeWidth="1.2" fill="none"/>
        </svg>
      );
    }

    const iconBtn: React.CSSProperties = { width: 28, height: 28, borderRadius: 6, border: "none", background: "transparent", color: C.text3, cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" };

    async function loadPOSentEmails(poNum: string) {
      if (!emailToken) return;
      const prefix = emailGetPrefix(poNum);
      setEmailSentLoading(l => ({ ...l, [poNum]: true }));
      try {
        const searchTerm = prefix.replace(/[\[\]{}()*?]/g, "").trim();
        const d = await emailGraph("/me/mailFolders/SentItems/messages?$search=" + encodeURIComponent('"' + searchTerm + '"') + "&$top=25&$select=id,subject,from,toRecipients,sentDateTime,bodyPreview,conversationId,hasAttachments");
        setEmailSentMap(m => ({ ...m, [poNum]: d.value || [] }));
        setDtlSentEmails(m => ({ ...m, [poNum]: d.value || [] }));
      } catch (e: any) { setEmailSentErrMap(err => ({ ...err, [poNum]: e.message })); }
      setEmailSentLoading(l => ({ ...l, [poNum]: false }));
    }

    async function doSendEmail() {
      if (!emailComposeTo.trim() || !emailComposeSubject.trim()) return;
      setEmailSendErr(null);
      try {
        await emailGraphPost("/me/sendMail", {
          message: {
            subject: emailComposeSubject,
            body: { contentType: "HTML", content: emailComposeBody || " " },
            toRecipients: emailComposeTo.split(",").map(e => ({ emailAddress: { address: e.trim() } })),
          },
        });
        setEmailComposeTo(""); setEmailComposeSubject(""); setEmailComposeBody("");
        setEmailComposeOpen(false);
        if (emailSelPO) setTimeout(() => loadPOEmails(emailSelPO), 2000);
      } catch (e: any) { setEmailSendErr("Failed to send: " + e.message); }
    }

    async function doReply(messageId: string, comment: string) {
      if (!comment.trim()) return;
      setEmailSendErr(null);
      try {
        await emailGraphPost("/me/messages/" + messageId + "/reply", { comment });
        if (emailSelMsg?.conversationId) loadEmailThread(emailSelMsg.conversationId);
        setEmailReplyText("");
      } catch (e: any) { setEmailSendErr("Failed to reply: " + e.message); }
    }

    const inboxEmails = emailSelPO ? (emailsMap[emailSelPO] || []) : [];
    const sentEmailList = emailSelPO ? (emailSentMap[emailSelPO] || []) : [];
    const activeList = emailActiveFolder === "inbox" ? inboxEmails : sentEmailList;
    const isLoadingE = emailSelPO ? !!emailLoadingMap[emailSelPO] : false;
    const eError = emailSelPO ? emailErrorsMap[emailSelPO] : null;

    const visibleEmails = [...activeList]
      .filter((em: any) => {
        if (emailFilterUnread && em.isRead) return false;
        if (emailFilterFlagged && !emailFlaggedSet.has(em.id)) return false;
        if (emailSearchQuery) {
          const q = emailSearchQuery.toLowerCase();
          const sender = em.from?.emailAddress?.name || em.from?.emailAddress?.address || "";
          if (!(em.subject || "").toLowerCase().includes(q) && !sender.toLowerCase().includes(q) && !(em.bodyPreview || "").toLowerCase().includes(q)) return false;
        }
        return true;
      })
      .sort((a: any, b: any) => {
        // Unread first, then newest
        if (!a.isRead && b.isRead) return -1;
        if (a.isRead && !b.isRead) return 1;
        const ta = new Date(a.receivedDateTime || a.sentDateTime || 0).getTime();
        const tb = new Date(b.receivedDateTime || b.sentDateTime || 0).getTime();
        return tb - ta;
      });

    const selEmailObj = emailSelectedId ? (activeList.find((e: any) => e.id === emailSelectedId) || emailSelMsg) : emailSelMsg;

    // Config view
    if (showEmailConfig) return (
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "24px 0" }}>
        <h2 style={{ color: C.text1, fontSize: 18, fontWeight: 700, marginBottom: 18 }}>Outlook Email</h2>
        <div style={{ background: "#1E3A5F", border: "1px solid #2563EB44", borderRadius: 10, padding: "12px 16px", marginBottom: 18, fontSize: 12, color: "#93C5FD", lineHeight: 1.6 }}>
          Azure AD credentials are configured automatically via Vercel environment variables.
          Redirect URI: <b>{window.location.origin}/auth-callback</b>.{" "}
          {MS_CLIENT_ID ? <span style={{ color: C.success, fontWeight: 700 }}>✓ Credentials configured</span> : <span style={{ color: C.error, fontWeight: 700 }}>✗ Credentials missing — check Vercel env vars</span>}
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={() => setShowEmailConfig(false)} style={S.btnSecondary}>Close</button>
        </div>
      </div>
    );

    return (
      <div style={{ position: "relative" }} onClick={() => emailCtxMenu && setEmailCtxMenu(null)}>
        <button onClick={() => setView("dashboard")} title="Close Email"
          style={{ position: "absolute", top: 10, right: 14, zIndex: 10, width: 28, height: 28, borderRadius: "50%", border: `1px solid ${C.outlook}44`, background: `${C.outlook}15`, color: C.outlook, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>✕</button>

        <div style={{ display: "flex", height: "calc(100vh - 140px)", minHeight: 500, background: C.bg0, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden", position: "relative", fontFamily: "'Segoe UI', system-ui, sans-serif", fontSize: 13, color: C.text1 }}>

          {/* ── SIDEBAR (220px) ──────────────────────────────────────────────────── */}
          <div style={{ width: 220, minWidth: 220, background: C.bg1, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>

            {/* Compose button */}
            <div style={{ padding: "14px 12px 10px", borderBottom: `1px solid ${C.border}` }}>
              <button
                onClick={() => { setEmailComposeOpen(true); setEmailComposeSubject(emailSelPO ? emailGetPrefix(emailSelPO) + " " : ""); setEmailSendErr(null); }}
                disabled={!emailToken}
                style={{ width: "100%", padding: "8px 12px", background: emailToken ? `linear-gradient(135deg, ${C.outlook}, ${C.outlookLt})` : C.bg2, border: "none", borderRadius: 8, color: emailToken ? "#fff" : C.text3, fontSize: 13, fontWeight: 500, cursor: emailToken ? "pointer" : "default", display: "flex", alignItems: "center", gap: 8, justifyContent: "center", fontFamily: "inherit" }}>
                ✎ New Message
              </button>
            </div>

            {/* PO label + search */}
            <div style={{ padding: "10px 12px 4px", fontSize: 10, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: C.text3, fontWeight: 600 }}>
              POs ({poList.length})
            </div>
            <div style={{ padding: "4px 8px 6px" }}>
              <input value={emailPOSearch} onChange={e => setEmailPOSearch(e.target.value)} placeholder="🔍 Search…"
                style={{ width: "100%", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", color: C.text1, fontSize: 11, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const }} />
            </div>

            {/* PO list */}
            <div style={{ flex: 1, overflowY: "auto" }}>
              {(() => {
                const s = emailPOSearch.toLowerCase();
                return poList.filter((p: any) => !s || (p.PoNumber ?? "").toLowerCase().includes(s) || (p.VendorName ?? "").toLowerCase().includes(s) || (p.Memo ?? "").toLowerCase().includes(s) || (p.Tags ?? "").toLowerCase().includes(s) || (p.StatusName ?? "").toLowerCase().includes(s))
                  .sort((a: any, b: any) => {
                    const ua = (emailsMap[a.PoNumber ?? ""] || []).filter((e: any) => !e.isRead).length;
                    const ub = (emailsMap[b.PoNumber ?? ""] || []).filter((e: any) => !e.isRead).length;
                    return ub - ua;
                  });
              })().map((po: any) => {
                const poNum = po.PoNumber ?? "";
                const isSelected = emailSelPO === poNum;
                const unread = (emailsMap[poNum] || []).filter((e: any) => !e.isRead).length;
                const color = STATUS_COLORS[po.StatusName ?? ""] ?? "#6B7280";
                return (
                  <div key={poNum}
                    onClick={() => { setEmailSelPO(poNum === emailSelPO ? null : poNum); setEmailSelectedId(null); setEmailSelMsg(null); setEmailThreadMsgs([]); setEmailDeleteConfirm(null); setEmailActiveFolder("inbox"); if (poNum !== emailSelPO && emailToken) loadPOEmails(poNum, undefined, true); }}
                    style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 10px", borderRadius: 7, margin: "1px 6px", cursor: "pointer", fontSize: 12, background: isSelected ? C.outlookDim : "transparent", color: isSelected ? C.info : C.text2, border: isSelected ? "1px solid rgba(96,165,250,0.2)" : "1px solid transparent", transition: "all 0.1s" }}>
                    <div style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: "monospace" }}>{poNum}</span>
                    {unread > 0 && <span style={{ background: C.outlook, color: "#fff", fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 10, minWidth: 16, textAlign: "center" as const }}>{unread}</span>}
                  </div>
                );
              })}
              {poList.length === 0 && <div style={{ padding: 16, fontSize: 12, color: C.text3, textAlign: "center" }}>No POs loaded — sync first</div>}
            </div>

            {/* Divider */}
            <div style={{ height: 1, background: C.border, margin: "4px 10px" }} />

            {/* Folders */}
            <div style={{ padding: "6px 12px 2px", fontSize: 10, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: C.text3, fontWeight: 600 }}>Folders</div>
            {(["inbox", "sent"] as const).map(f => {
              const label = f === "inbox" ? "Inbox" : "Sent";
              const count = f === "inbox" ? inboxEmails.filter((e: any) => !e.isRead).length : 0;
              return (
                <div key={f} onClick={() => { setEmailActiveFolder(f); setEmailSelectedId(null); setEmailSelMsg(null); setEmailThreadMsgs([]); if (f === "sent" && emailSelPO && emailToken) loadPOSentEmails(emailSelPO); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 7, margin: "1px 6px", cursor: "pointer", fontSize: 12, background: emailActiveFolder === f ? "rgba(200,33,10,0.15)" : "transparent", color: emailActiveFolder === f ? "#E87060" : C.text2, transition: "all 0.1s" }}>
                  <FolderIcon size={14} color={emailActiveFolder === f ? "#E87060" : C.text3} />
                  <span style={{ flex: 1 }}>{label}</span>
                  {count > 0 && <span style={{ background: C.bg3, color: C.text2, fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 10, minWidth: 18, textAlign: "center" as const }}>{count}</span>}
                </div>
              );
            })}

            {/* Account footer */}
            <div style={{ borderTop: `1px solid ${C.border}`, padding: "10px 12px", display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
              {emailToken ? (
                <>
                  <div style={{ width: 26, height: 26, borderRadius: "50%", background: C.outlook + "33", border: "2px solid " + C.outlook, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: C.outlook, flexShrink: 0 }}>{(msDisplayName || "Me").slice(0, 2).toUpperCase()}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 500, color: C.text1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{msDisplayName || "Microsoft Account"}</div>
                  </div>
                  <div style={{ background: "#064E3B", border: "1px solid #34D39944", borderRadius: 5, padding: "2px 6px", fontSize: 9, color: C.success, whiteSpace: "nowrap", cursor: "pointer" }}
                    onClick={msSignOut} title="Click to sign out">● Live</div>
                </>
              ) : (
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: C.warning, fontWeight: 600, marginBottom: 5 }}>Sign in to load emails</div>
                  {(!MS_CLIENT_ID || !MS_TENANT_ID) ? (
                    <div style={{ fontSize: 10, color: "#D97706" }}>Azure credentials not configured</div>
                  ) : (
                    <button onClick={authenticateEmail}
                      style={{ background: `linear-gradient(135deg,${C.outlook},${C.outlookLt})`, color: "#fff", border: "none", borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", width: "100%" }}>
                      Sign in with Microsoft
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── EMAIL LIST (295px) ───────────────────────────────────────────────── */}
          <div style={{ width: 295, minWidth: 295, background: C.bg1, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column" }}>

            {/* List header */}
            <div style={{ padding: "12px 12px 8px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: C.text1 }}>
                {emailActiveFolder === "inbox" ? "Inbox" : "Sent"}
                {emailSelPO && <span style={{ fontSize: 11, color: C.text3, marginLeft: 6, fontWeight: 400 }}>· PO {emailSelPO}</span>}
              </span>
              <button style={iconBtn} title="Refresh"
                onClick={() => { if (emailSelPO) { if (emailActiveFolder === "inbox") loadPOEmails(emailSelPO); else loadPOSentEmails(emailSelPO); } }}>↻</button>
            </div>

            {/* Search */}
            <div style={{ position: "relative" as const, margin: "8px 10px" }}>
              <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: C.text3, fontSize: 13, pointerEvents: "none" }}>⌕</span>
              <input style={{ width: "100%", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 7, padding: "6px 10px 6px 28px", color: C.text1, fontSize: 12, outline: "none", boxSizing: "border-box" as const, fontFamily: "inherit" }}
                placeholder="Search…" value={emailSearchQuery} onChange={e => setEmailSearchQuery(e.target.value)} />
            </div>

            {/* Filter pills */}
            <div style={{ display: "flex", gap: 4, padding: "6px 8px", borderBottom: `1px solid ${C.border}` }}>
              {(["All", "Unread", "Flagged"] as const).map(label => {
                const isActive = label === "All" ? (!emailFilterUnread && !emailFilterFlagged) : label === "Unread" ? emailFilterUnread : emailFilterFlagged;
                return (
                  <div key={label} onClick={() => { if (label === "All") { setEmailFilterUnread(false); setEmailFilterFlagged(false); } else if (label === "Unread") { setEmailFilterUnread(v => !v); setEmailFilterFlagged(false); } else { setEmailFilterFlagged(v => !v); setEmailFilterUnread(false); } }}
                    style={{ padding: "3px 9px", borderRadius: 20, fontSize: 11, fontWeight: 500, cursor: "pointer", background: isActive ? C.outlookDim : "transparent", color: isActive ? C.info : C.text3, border: isActive ? "1px solid rgba(96,165,250,0.3)" : "1px solid transparent" }}>
                    {label}
                  </div>
                );
              })}
            </div>

            {/* Email rows */}
            <div style={{ flex: 1, overflowY: "auto" }}>
              {!emailToken ? (
                <div style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 12 }}>Sign in to load emails</div>
              ) : !emailSelPO ? (
                <div style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 12 }}>Select a PO from the left</div>
              ) : (isLoadingE && emailActiveFolder === "inbox") ? (
                <div style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 13 }}>Loading emails…</div>
              ) : (emailSentLoading[emailSelPO] && emailActiveFolder === "sent") ? (
                <div style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 13 }}>Loading sent emails…</div>
              ) : (eError && emailActiveFolder === "inbox") ? (
                <div style={{ margin: 10, background: C.bg0, border: `1px solid ${C.error}44`, borderRadius: 8, padding: "10px 14px", color: C.error, fontSize: 12 }}>⚠ {eError}</div>
              ) : visibleEmails.length === 0 ? (
                <div style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 13 }}>No messages</div>
              ) : (
                <>
                  {visibleEmails.map((em: any) => {
                    const sender = emailActiveFolder === "inbox"
                      ? (em.from?.emailAddress?.name || em.from?.emailAddress?.address || "Unknown")
                      : "To: " + ((em.toRecipients || []).map((r: any) => r.emailAddress?.name || r.emailAddress?.address || "").filter(Boolean).join(", ") || "—");
                    const time = em.receivedDateTime
                      ? new Date(em.receivedDateTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                      : em.sentDateTime
                      ? new Date(em.sentDateTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                      : "";
                    const isFlagged = emailFlaggedSet.has(em.id);
                    const isUnread = !em.isRead && emailActiveFolder === "inbox";
                    return (
                      <div key={em.id}
                        onClick={() => { setEmailSelectedId(em.id); setEmailDeleteConfirm(null); setEmailReplyText(""); if (emailActiveFolder === "inbox" && !em.isRead) { emailMarkAsRead(em.id); const markRead = (arr: any[]) => arr.map((e: any) => e.id === em.id ? { ...e, isRead: true } : e); setEmailsMap(m => ({ ...m, [emailSelPO!]: markRead(m[emailSelPO!] || []) })); setDtlEmails(m => ({ ...m, [emailSelPO!]: markRead(m[emailSelPO!] || []) })); } loadFullEmail(em.id); if (em.conversationId) loadEmailThread(em.conversationId); if (em.hasAttachments) loadEmailAttachments(em.id); }}
                        onContextMenu={e => { e.preventDefault(); setEmailCtxMenu({ x: e.clientX, y: e.clientY, em }); }}
                        style={{ padding: "11px 12px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", position: "relative" as const, background: emailSelectedId === em.id ? C.bg3 : "transparent", transition: "background 0.1s" }}>
                        {isUnread && <div style={{ position: "absolute", left: 4, top: "50%", transform: "translateY(-50%)", width: 5, height: 5, borderRadius: "50%", background: C.outlook }} />}
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                          <span style={{ fontSize: 12, fontWeight: isUnread ? 600 : 400, color: isUnread ? C.text1 : C.text2, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {sender}
                            {isFlagged && <span style={{ color: C.warning, marginLeft: 4, fontSize: 11 }}>★</span>}
                          </span>
                          <span style={{ fontSize: 11, color: C.text3, flexShrink: 0, marginLeft: 6 }}>{time}</span>
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 500, color: C.text1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 2 }}>{em.subject}</div>
                        <div style={{ fontSize: 11, color: C.text3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {em.hasAttachments && <span style={{ marginRight: 4 }}>📎</span>}
                          {em.bodyPreview || ""}
                        </div>
                      </div>
                    );
                  })}
                  {emailActiveFolder === "inbox" && emailNextLinks[emailSelPO!] && (
                    <button onClick={() => loadPOEmails(emailSelPO!, emailNextLinks[emailSelPO!]!)} disabled={emailLoadingOlder}
                      style={{ background: `linear-gradient(135deg,${C.outlook},${C.outlookLt})`, color: "#fff", border: "none", borderRadius: 0, padding: "10px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", width: "100%", opacity: emailLoadingOlder ? 0.6 : 1 }}>
                      {emailLoadingOlder ? "Loading…" : "Load older"}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* ── EMAIL DETAIL (flex-1) ─────────────────────────────────────────────── */}
          <div style={{ flex: 1, background: C.bg0, display: "flex", flexDirection: "column", minWidth: 0 }}>
            {!emailSelectedId ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 12, color: C.text3 }}>
                <span style={{ fontSize: 48, opacity: 0.25 }}>✉</span>
                <span style={{ fontSize: 14 }}>{emailSelPO ? "Select a message to read" : "Select a PO from the left"}</span>
              </div>
            ) : (
              <>
                {/* Detail header */}
                <div style={{ padding: "12px 50px 10px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600, color: C.text1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {selEmailObj?.subject || "Loading…"}
                  </div>
                  <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                    <button style={iconBtn} title="Flag"
                      onClick={() => setEmailFlaggedSet(prev => { const s = new Set(prev); if (s.has(emailSelectedId)) s.delete(emailSelectedId); else s.add(emailSelectedId); return s; })}>
                      <span style={{ color: emailFlaggedSet.has(emailSelectedId) ? C.warning : C.text3 }}>{emailFlaggedSet.has(emailSelectedId) ? "★" : "☆"}</span>
                    </button>
                    <button style={{ ...iconBtn, color: C.error }} title="Delete" onClick={() => setEmailDeleteConfirm(emailSelectedId)}>🗑️</button>
                  </div>
                </div>

                {/* Delete confirm bar */}
                {emailDeleteConfirm === emailSelectedId && (
                  <div style={{ background: C.errorDim, borderBottom: `1px solid rgba(239,68,68,0.3)`, padding: "8px 18px", display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 13, color: C.error, flex: 1 }}>Permanently delete this message? This cannot be undone.</span>
                    <button onClick={() => deleteMainEmail(emailSelectedId)}
                      style={{ padding: "7px 14px", background: C.errorDim, border: `1px solid rgba(239,68,68,0.3)`, borderRadius: 7, color: C.error, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" }}>
                      Delete
                    </button>
                    <button style={{ ...iconBtn, color: C.text2 }} onClick={() => setEmailDeleteConfirm(null)}>✕</button>
                  </div>
                )}

                {/* Error bar */}
                {emailSendErr && (
                  <div style={{ background: C.bg1, borderBottom: `1px solid ${C.error}44`, padding: "8px 18px", display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 13, color: C.error, flex: 1 }}>⚠ {emailSendErr}</span>
                    <button style={{ ...iconBtn, color: C.text2 }} onClick={() => setEmailSendErr(null)}>✕</button>
                  </div>
                )}

                {/* Thread */}
                <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px" }}>
                  {emailThreadLoading ? (
                    <div style={{ textAlign: "center", color: C.text3, paddingTop: 40, fontSize: 13 }}>Loading conversation…</div>
                  ) : emailThreadMsgs.length > 0 ? (
                    emailThreadMsgs.map((msg: any, i: number) => {
                      const isLast = i === emailThreadMsgs.length - 1;
                      const collapsed = !isLast && emailCollapsedMsgs.has(msg.id);
                      const sender = msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || "Unknown";
                      const initials = sender.split(" ").map((w: string) => w[0] || "").join("").toUpperCase().slice(0, 2) || "??";
                      const time = msg.receivedDateTime ? new Date(msg.receivedDateTime).toLocaleString() : "";
                      const htmlBody = msg.body?.content || "";
                      return (
                        <div key={msg.id} style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 10, overflow: "hidden" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", cursor: !isLast ? "pointer" : "default" }}
                            onClick={() => { if (!isLast) setEmailCollapsedMsgs(prev => { const s = new Set(prev); if (s.has(msg.id)) s.delete(msg.id); else s.add(msg.id); return s; }); }}>
                            <div style={{ width: 32, height: 32, borderRadius: "50%", background: C.outlook + "33", border: "2px solid " + C.outlook, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: C.outlook, flexShrink: 0 }}>{initials}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 500, color: C.text1 }}>{sender}</div>
                              <div style={{ fontSize: 11, color: C.text3 }}>{msg.from?.emailAddress?.address || ""}</div>
                            </div>
                            <div style={{ fontSize: 11, color: C.text3, flexShrink: 0 }}>{time}</div>
                            {!isLast && <span style={{ color: C.text3, fontSize: 12, marginLeft: 8 }}>{collapsed ? "▼" : "▲"}</span>}
                          </div>
                          {!collapsed && (
                            <div style={{ padding: "0 14px 14px" }}>
                              <iframe sandbox="allow-same-origin" srcDoc={styledEmailHtml(htmlBody)}
                                style={{ width: "100%", border: "none", minHeight: 80, borderRadius: 6, background: "#F8FAFC" }}
                                onLoad={e => { try { const h = (e.target as HTMLIFrameElement).contentDocument?.body.scrollHeight || 0; (e.target as HTMLIFrameElement).style.height = Math.min(h + 20, 400) + "px"; } catch {} }} />
                            </div>
                          )}
                        </div>
                      );
                    })
                  ) : selEmailObj ? (
                    <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
                      <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}`, fontSize: 12, color: C.text3 }}>
                        From: {selEmailObj.from?.emailAddress?.name || selEmailObj.from?.emailAddress?.address || "Unknown"}
                      </div>
                      <div style={{ padding: "0 14px 14px" }}>
                        <iframe sandbox="allow-same-origin" srcDoc={styledEmailHtml(selEmailObj.body?.content || selEmailObj.bodyPreview || "")}
                          style={{ width: "100%", border: "none", minHeight: 100, borderRadius: 6, background: "#F8FAFC" }}
                          onLoad={e => { try { const h = (e.target as HTMLIFrameElement).contentDocument?.body.scrollHeight || 0; (e.target as HTMLIFrameElement).style.height = Math.min(h + 20, 400) + "px"; } catch {} }} />
                      </div>
                    </div>
                  ) : null}
                </div>

                {/* Attachments */}
                {emailSelectedId && (emailAttachments[emailSelectedId] || []).length > 0 && (
                  <div style={{ borderTop: `1px solid ${C.border}`, padding: "8px 18px", background: C.bg1, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: C.text3, marginRight: 4 }}>📎 Attachments:</span>
                    {emailAttachments[emailSelectedId].map((att: any) => {
                      const href = att.contentBytes ? `data:${att.contentType || "application/octet-stream"};base64,${att.contentBytes}` : "#";
                      return (
                        <a key={att.id} href={href} download={att.name}
                          style={{ display: "inline-flex", alignItems: "center", gap: 4, background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 9px", fontSize: 11, color: C.info, textDecoration: "none", cursor: "pointer", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          📄 {att.name}{att.size ? ` (${(att.size / 1024).toFixed(0)}KB)` : ""}
                        </a>
                      );
                    })}
                    {emailAttachmentsLoading[emailSelectedId] && <span style={{ fontSize: 11, color: C.text3 }}>Loading…</span>}
                  </div>
                )}

                {/* Reply area */}
                <div style={{ borderTop: `1px solid ${C.border}`, padding: "10px 18px", background: C.bg1 }}>
                  <div style={{ fontSize: 12, color: C.text3, marginBottom: 6 }}>
                    Reply to <span style={{ color: C.info }}>{emailThreadMsgs.length > 0 ? (emailThreadMsgs[emailThreadMsgs.length - 1].from?.emailAddress?.address || "") : (selEmailObj?.from?.emailAddress?.address || "")}</span>
                  </div>
                  <textarea
                    style={{ width: "100%", minHeight: 72, background: "transparent", border: "none", color: C.text1, fontSize: 13, fontFamily: "inherit", resize: "none" as const, outline: "none", lineHeight: 1.6, boxSizing: "border-box" as const }}
                    placeholder="Write a reply…"
                    value={emailReplyText}
                    onChange={e => setEmailReplyText(e.target.value)}
                  />
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
                    <button onClick={() => setEmailReplyText("")} style={{ padding: "7px 14px", borderRadius: 7, border: `1px solid ${C.border}`, background: "none", color: C.text3, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>Discard</button>
                    <button onClick={() => { if (selEmailObj) doReply(selEmailObj.id, emailReplyText); }}
                      disabled={!emailReplyText.trim() || !selEmailObj}
                      style={{ padding: "7px 16px", background: `linear-gradient(135deg, ${C.outlook}, ${C.outlookLt})`, border: "none", borderRadius: 7, color: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", opacity: (!emailReplyText.trim() || !selEmailObj) ? 0.5 : 1 }}>
                      Send ↗
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* ── COMPOSE MODAL (floating bottom-right) ────────────────────────────── */}
          {emailComposeOpen && (
            <div style={{ position: "absolute", inset: 0, zIndex: 100, pointerEvents: "none" }}>
              <div style={{ position: "absolute", bottom: 0, right: 0, width: 520, background: C.bg1, border: `1px solid ${C.border2}`, borderRadius: "12px 12px 0 0", boxShadow: "0 -8px 32px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", pointerEvents: "all" }}>
                <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", background: C.bg2, borderRadius: "12px 12px 0 0" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: C.text1 }}>New Message</span>
                  <button onClick={() => { setEmailComposeOpen(false); setEmailSendErr(null); }} style={{ ...iconBtn, color: C.text2 }}>✕</button>
                </div>
                <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
                  {emailSendErr && (
                    <div style={{ background: C.bg0, border: `1px solid ${C.error}44`, borderRadius: 7, padding: "8px 12px", color: C.error, fontSize: 12 }}>
                      ⚠ {emailSendErr}
                      <button onClick={() => setEmailSendErr(null)} style={{ marginLeft: 8, border: "none", background: "none", color: C.error, cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>✕</button>
                    </div>
                  )}
                  <div>
                    <div style={{ fontSize: 11, color: C.text3, marginBottom: 3 }}>To (comma-separated)</div>
                    <input value={emailComposeTo} onChange={e => setEmailComposeTo(e.target.value)} placeholder="name@domain.com"
                      style={{ width: "100%", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 10px", color: C.text1, fontSize: 13, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.text3, marginBottom: 3 }}>Subject</div>
                    <input value={emailComposeSubject} onChange={e => setEmailComposeSubject(e.target.value)}
                      style={{ width: "100%", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 10px", color: C.text1, fontSize: 13, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.text3, marginBottom: 3 }}>Body</div>
                    <textarea value={emailComposeBody} onChange={e => setEmailComposeBody(e.target.value)} rows={8}
                      style={{ width: "100%", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 10px", color: C.text1, fontSize: 13, outline: "none", fontFamily: "inherit", resize: "vertical" as const, minHeight: 140, boxSizing: "border-box" as const }}
                      placeholder="Type your message…" />
                  </div>
                </div>
                <div style={{ padding: "10px 16px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <button onClick={() => { setEmailComposeOpen(false); setEmailSendErr(null); setEmailComposeTo(""); setEmailComposeSubject(""); setEmailComposeBody(""); }}
                    style={{ padding: "7px 16px", borderRadius: 7, border: `1px solid ${C.border}`, background: "none", color: C.text3, cursor: "pointer", fontFamily: "inherit" }}>Discard</button>
                  <button onClick={doSendEmail} disabled={!emailComposeTo.trim() || !emailComposeSubject.trim()}
                    style={{ padding: "7px 18px", background: `linear-gradient(135deg, ${C.outlook}, ${C.outlookLt})`, border: "none", borderRadius: 7, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: (!emailComposeTo.trim() || !emailComposeSubject.trim()) ? 0.5 : 1 }}>
                    Send ↗
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── CONTEXT MENU ─────────────────────────────────────────────── */}
          {emailCtxMenu && (
            <div style={{ position: "fixed", top: emailCtxMenu.y, left: emailCtxMenu.x, zIndex: 2000, background: C.bg2, border: `1px solid ${C.border2}`, borderRadius: 8, padding: "4px 0", boxShadow: "0 8px 24px rgba(0,0,0,0.5)", minWidth: 170 }}
              onClick={e => e.stopPropagation()}>
              <div style={{ padding: "8px 16px", fontSize: 12, color: C.text1, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
                onClick={() => { setEmailSelectedId(emailCtxMenu.em.id); loadFullEmail(emailCtxMenu.em.id); if (emailCtxMenu.em.conversationId) loadEmailThread(emailCtxMenu.em.conversationId); setEmailCtxMenu(null); }}>
                ↩ Reply
              </div>
              <div style={{ padding: "8px 16px", fontSize: 12, color: C.text1, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
                onClick={() => { setEmailSelectedId(emailCtxMenu.em.id); loadFullEmail(emailCtxMenu.em.id); if (emailCtxMenu.em.conversationId) loadEmailThread(emailCtxMenu.em.conversationId); setEmailCtxMenu(null); }}>
                ↩↩ Reply All
              </div>
              <div style={{ height: 1, background: C.border, margin: "3px 0" }} />
              <div style={{ padding: "8px 16px", fontSize: 12, color: C.error, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
                onClick={() => { setEmailDeleteConfirm(emailCtxMenu.em.id); setEmailSelectedId(emailCtxMenu.em.id); setEmailCtxMenu(null); }}>
                🗑️ Delete
              </div>
            </div>
          )}
        </div>
      </div>
    );
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
          <button style={view === "list"      ? S.navBtnActive : S.navBtn} onClick={() => setView("list")}>All POs</button>
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
          <button style={view === "vendors" ? S.navBtnActive : S.navBtn} onClick={() => { setSelected(null); setView("vendors"); }}>🏆 Vendors</button>
          <button style={view === "timeline" ? S.navBtnActive : S.navBtn} onClick={() => { if (selected) setSearch(selected.PoNumber ?? ""); setView("timeline"); }}>📊 Timeline</button>
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
                <option value="All">All Statuses</option>
                {STATUS_OPTIONS.map(s => <option key={s}>{s}</option>)}
              </select>
              <select style={{ ...S.select, width: 180 }} value={filterVendor} onChange={e => setFilterVendor(e.target.value)}>
                {vendors.map(v => <option key={v}>{v}</option>)}
              </select>
              <button style={S.btnSecondary} onClick={() => { setSearch(""); setFilterStatus("All"); setFilterVendor("All"); }}>
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
                <div style={{ border: "1px solid #334155", borderRadius: 8, overflow: "hidden" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "40px 1fr 140px 120px 90px" + (isAdmin ? " 80px" : ""), padding: "8px 14px", background: "#0F172A", color: "#6B7280", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>
                    <span>#</span><span>Phase</span><span>Category</span><span style={{ textAlign: "center" }}>Days Before DDP</span><span style={{ textAlign: "center" }}>Status</span>
                    {isAdmin && <span style={{ textAlign: "center" }}>Actions</span>}
                  </div>
                  {currentTemplates.map((tpl, i) => {
                    const updateField = (field: string, value: any) => {
                      const arr = [...currentTemplates];
                      arr[i] = { ...arr[i], [field]: value };
                      saveVendorTemplates(tplVendor, arr);
                    };
                    return (
                    <div key={tpl.id} style={{ display: "grid", gridTemplateColumns: "40px 1fr 140px 120px 90px" + (isAdmin ? " 80px" : ""), padding: "8px 14px", borderTop: "1px solid #1E293B", fontSize: 13, alignItems: "center" }}>
                      <span style={{ color: "#6B7280", fontSize: 11 }}>{i + 1}</span>
                      {isAdmin ? (
                        <input style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 4, color: "#D1D5DB", fontSize: 13, padding: "3px 8px", width: "100%", outline: "none", boxSizing: "border-box" }}
                          value={tpl.phase} onChange={e => updateField("phase", e.target.value)} />
                      ) : <span style={{ color: "#D1D5DB" }}>{tpl.phase}</span>}
                      {isAdmin ? (
                        <select style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 4, color: "#9CA3AF", fontSize: 12, padding: "3px 4px" }}
                          value={tpl.category} onChange={e => updateField("category", e.target.value)}>
                          {WIP_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      ) : <span style={{ color: "#9CA3AF", fontSize: 12 }}>{tpl.category}</span>}
                      {isAdmin ? (
                        <input type="number" style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 4, color: "#9CA3AF", fontSize: 13, padding: "3px 8px", textAlign: "center", width: "100%", outline: "none", boxSizing: "border-box" }}
                          value={tpl.daysBeforeDDP} onChange={e => updateField("daysBeforeDDP", parseInt(e.target.value) || 0)} />
                      ) : <span style={{ color: "#9CA3AF", textAlign: "center" }}>{tpl.daysBeforeDDP}</span>}
                      {isAdmin ? (
                        <select style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 4, color: MILESTONE_STATUS_COLORS[tpl.status] || "#6B7280", fontSize: 11, padding: "3px 4px" }}
                          value={tpl.status} onChange={e => updateField("status", e.target.value)}>
                          {MILESTONE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      ) : <span style={{ color: MILESTONE_STATUS_COLORS[tpl.status] || "#6B7280", textAlign: "center", fontSize: 11 }}>{tpl.status}</span>}
                      {isAdmin && (
                        <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                          {i > 0 && <button style={{ background: "none", border: "1px solid #334155", color: "#6B7280", borderRadius: 4, cursor: "pointer", padding: "2px 6px", fontSize: 10 }}
                            onClick={() => { const arr = [...currentTemplates]; [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; saveVendorTemplates(tplVendor, arr); }}>↑</button>}
                          {i < currentTemplates.length - 1 && <button style={{ background: "none", border: "1px solid #334155", color: "#6B7280", borderRadius: 4, cursor: "pointer", padding: "2px 6px", fontSize: 10 }}
                            onClick={() => { const arr = [...currentTemplates]; [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]]; saveVendorTemplates(tplVendor, arr); }}>↓</button>}
                          <button style={{ background: "none", border: "1px solid #EF4444", color: "#EF4444", borderRadius: 4, cursor: "pointer", padding: "2px 6px", fontSize: 10 }}
                            onClick={() => setConfirmModal({ title: "Delete Phase", message: `Delete "${tpl.phase}" from this template?`, icon: "🗑", confirmText: "Delete", confirmColor: "#EF4444", onConfirm: () => saveVendorTemplates(tplVendor, currentTemplates.filter(t => t.id !== tpl.id)) })}>✕</button>
                        </div>
                      )}
                    </div>
                    );
                  })}
                  {currentTemplates.length === 0 && <div style={{ padding: 20, textAlign: "center", color: "#6B7280", fontSize: 13 }}>No phases defined.</div>}
                </div>
                {isAdmin && (
                  <WipTemplateEditor templates={currentTemplates} onSave={(t) => saveVendorTemplates(tplVendor, t)} />
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
            <>
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
                    <div key={entry.id || i} style={{ display: "flex", gap: 12, padding: "12px 16px", borderBottom: "1px solid #0F172A", background: i % 2 === 0 ? "#1E293B" : "#1A2332", cursor: "pointer" }}
                      onClick={() => { const p = pos.find(x => x.PoNumber === entry.po_number); if (p) { setDetailMode("milestones"); setNewNote(""); setSearch(""); setSelected(p); setView("list"); } }}>
                      <div style={{ fontSize: 18, flexShrink: 0, width: 32, textAlign: "center" }}>{icon}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: "#60A5FA", fontFamily: "monospace" }}>{entry.po_number}</span>
                          <span style={{ fontSize: 11, color: "#6B7280" }}>{entry.user_name}</span>
                          <span style={{ fontSize: 10, color: "#4B5563", marginLeft: "auto", flexShrink: 0 }}>{timeAgo} · {time}</span>
                        </div>
                        <div style={{ fontSize: 13, color: "#D1D5DB", lineHeight: 1.4 }}>{entry.note}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          );
        })()}

        {/* ── VENDORS ── */}
        {view === "vendors" && (() => {
          const vendorStats: { vendor: string; totalMs: number; completed: number; onTime: number; late: number; avgDaysLate: number; poCount: number }[] = [];
          const vendorNames = [...new Set(pos.map(p => p.VendorName ?? "").filter(Boolean))].sort();
          vendorNames.forEach(vendor => {
            const vPOs = pos.filter(p => (p.VendorName ?? "") === vendor);
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
        {view === "timeline" && (() => {
          const posWithMs = pos.filter(po => (milestones[po.PoNumber ?? ""] || []).length > 0);
          const s = search.toLowerCase();
          const filteredPOs = posWithMs.filter(p => !s
            || (p.PoNumber ?? "").toLowerCase().includes(s)
            || (p.VendorName ?? "").toLowerCase().includes(s)
            || (p.Memo ?? "").toLowerCase().includes(s)
            || (p.Tags ?? "").toLowerCase().includes(s)
            || (p.StatusName ?? "").toLowerCase().includes(s)
          ).sort((a, b) => {
            const da = a.DateExpectedDelivery ? new Date(a.DateExpectedDelivery).getTime() : Infinity;
            const db = b.DateExpectedDelivery ? new Date(b.DateExpectedDelivery).getTime() : Infinity;
            return da - db;
          });

          // Date range
          let minD = Infinity, maxD = -Infinity;
          filteredPOs.forEach(po => {
            (milestones[po.PoNumber ?? ""] || []).forEach(m => {
              if (m.expected_date) { const d = new Date(m.expected_date).getTime(); if (d < minD) minD = d; if (d > maxD) maxD = d; }
            });
          });
          if (!isFinite(minD)) { minD = Date.now(); maxD = Date.now() + 120 * 86400000; }
          // Snap to week boundaries with padding
          const DAY = 86400000;
          const startDate = new Date(minD - 21 * DAY); startDate.setDate(startDate.getDate() - startDate.getDay()); // snap to Sunday
          const endDate = new Date(maxD + 21 * DAY);
          const totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / DAY);
          const dayWidth = Math.max(6, Math.min(20, 1200 / totalDays)); // 6-20px per day
          const chartWidth = totalDays * dayWidth;
          const today = new Date();
          const todayOffset = Math.floor((today.getTime() - startDate.getTime()) / DAY) * dayWidth;
          const LEFT_W = 380;
          const ROW_H = 140;

          // Build week columns
          const weeks: { date: Date; offset: number }[] = [];
          const cur = new Date(startDate);
          while (cur.getTime() < endDate.getTime()) {
            weeks.push({ date: new Date(cur), offset: Math.floor((cur.getTime() - startDate.getTime()) / DAY) * dayWidth });
            cur.setDate(cur.getDate() + 7);
          }
          // Month spans for top header
          const monthSpans: { label: string; left: number; width: number }[] = [];
          let prevMonth = -1;
          weeks.forEach((w, i) => {
            const m = w.date.getMonth();
            if (m !== prevMonth) {
              const nextMonthIdx = weeks.findIndex((ww, j) => j > i && ww.date.getMonth() !== m);
              const endOff = nextMonthIdx >= 0 ? weeks[nextMonthIdx].offset : chartWidth;
              monthSpans.push({ label: w.date.toLocaleDateString("en-US", { month: "long", year: "numeric" }), left: w.offset, width: endOff - w.offset });
              prevMonth = m;
            }
          });

          const toX = (d: string) => Math.floor((new Date(d).getTime() - startDate.getTime()) / DAY) * dayWidth;

          return (
            <>
              {/* Header bar */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div>
                  <h2 style={{ margin: "0 0 2px", color: "#F1F5F9", fontSize: 20, fontWeight: 700 }}>Production Timeline</h2>
                  <div style={{ color: "#6B7280", fontSize: 12 }}>{filteredPOs.length} POs · {filteredPOs.reduce((s, p) => s + (milestones[p.PoNumber ?? ""] || []).filter(m => m.status !== "N/A").length, 0)} milestones</div>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Search PO#, vendor, brand, style #…" style={{ ...S.input, width: 280, marginBottom: 0, fontSize: 14 }} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", gap: 12, fontSize: 12, color: "#94A3B8", alignItems: "center" }}>
                      <span style={{ fontSize: 10, color: "#6B7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, width: 80, flexShrink: 0 }}>Milestones:</span>
                      {[["linear-gradient(90deg,#6EE7B7,#047857)","Complete"],["linear-gradient(90deg,#93C5FD,#1D4ED8)","In Progress"],["linear-gradient(90deg,#FCA5A5,#7F1D1D)","Delayed"],["linear-gradient(90deg,#6B7280,#1F2937)","Not Started"]].map(([c,l]) => (
                        <span key={l} style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 24, height: 14, borderRadius: 7, background: c }} />{l}</span>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 12, fontSize: 12, color: "#94A3B8", alignItems: "center" }}>
                      <span style={{ fontSize: 10, color: "#6B7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, width: 80, flexShrink: 0 }}>PO Status:</span>
                      {[["#3B82F6","Open"],["#8B5CF6","Released"],["#F59E0B","Pending"],["#9CA3AF","Draft"]].map(([c,l]) => (
                        <span key={l} style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 10, height: 10, borderRadius: "50%", background: c }} />{l}</span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Scrollbar styles */}
              <style>{`
                .tl-scroll::-webkit-scrollbar { height: 14px; width: 14px; }
                .tl-scroll::-webkit-scrollbar-track { background: #0F172A; border-radius: 7px; margin: 0 4px; }
                .tl-scroll::-webkit-scrollbar-thumb { background: #475569; border-radius: 7px; border: 2px solid #0F172A; }
                .tl-scroll::-webkit-scrollbar-thumb:hover { background: #64748B; }
                .tl-left::-webkit-scrollbar { width: 0; display: none; }
              `}</style>
              {/* Chart container */}
              <div style={{ background: "#1E293B", borderRadius: 12, border: "1px solid #334155", overflow: "hidden", maxHeight: "calc(100vh - 180px)" }}>
                <div style={{ display: "flex", maxHeight: "calc(100vh - 180px)" }}>
                  {/* Frozen left column */}
                  <div style={{ width: LEFT_W, flexShrink: 0, zIndex: 5, background: "#1E293B", paddingBottom: 18, overflowY: "auto", overflowX: "hidden" }} className="tl-left"
                    onScroll={e => { const chart = e.currentTarget.nextElementSibling; if (chart) chart.scrollTop = e.currentTarget.scrollTop; }}>
                    {/* Header cells */}
                    <div style={{ height: 44, background: "#0F172A", borderBottom: "1px solid #334155", display: "flex", alignItems: "center", padding: "0 16px", position: "sticky", top: 0, zIndex: 4 }}>
                      <span style={{ fontSize: 16, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: 1 }}>PO / Vendor</span>
                    </div>
                    <div style={{ height: 40, background: "#0F172A", borderBottom: "1px solid #334155", display: "flex", alignItems: "center", padding: "0 16px", position: "sticky", top: 44, zIndex: 4 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "#6B7280" }}>{filteredPOs.length} POs</span>
                    </div>
                    {/* PO labels */}
                    {filteredPOs.map((po, idx) => {
                      const poNum = po.PoNumber ?? "";
                      const poMs = milestones[poNum] || [];
                      const complete = poMs.filter(m => m.status === "Complete").length;
                      const active = poMs.filter(m => m.status !== "N/A").length;
                      const pct = active > 0 ? Math.round((complete / active) * 100) : 0;
                      const inProg = poMs.filter(m => m.status === "In Progress").length;
                      const delayed = poMs.filter(m => m.status === "Delayed").length;
                      const notStarted = active - complete - inProg - delayed;
                      const statusColor = STATUS_COLORS[po.StatusName ?? ""] ?? "#6B7280";
                      const isSelected = selected?.PoNumber === poNum;
                      const statusBars = [
                        [complete, "#047857", "#6EE7B7"],
                        [inProg, "#1D4ED8", "#93C5FD"],
                        [delayed, "#7F1D1D", "#FCA5A5"],
                        [notStarted, "#374151", "#9CA3AF"],
                      ].filter(([c]) => (c as number) > 0) as [number, string, string][];
                      return (
                        <div key={poNum}
                          onClick={() => { setDetailMode("milestones"); setNewNote(""); setSearch(""); setSelected(po); setView("list"); }}
                          style={{ height: ROW_H, display: "flex", alignItems: "center", gap: 8, padding: "0 12px", borderBottom: "1px solid #0F172A", background: isSelected ? "#334155" : idx % 2 === 0 ? "#1E293B" : "#1A2332", cursor: "pointer", borderLeft: isSelected ? "3px solid #60A5FA" : "3px solid transparent" }}
                          onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "#334155"; }}
                          onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = idx % 2 === 0 ? "#1E293B" : "#1A2332"; }}>
                          <div style={{ width: 12, height: 12, borderRadius: "50%", background: statusColor, flexShrink: 0 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 18, fontWeight: 700, color: "#60A5FA", fontFamily: "monospace" }}>{poNum}</div>
                            <div style={{ fontSize: 15, color: "#94A3B8", lineHeight: 1.3 }}>{po.VendorName ?? ""}</div>
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, flexShrink: 0, width: 110 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontSize: 11, color: "#9CA3AF", fontFamily: "monospace" }}>{complete}/{active}</span>
                              <span style={{ fontSize: 12, color: "#10B981", fontWeight: 700, fontFamily: "monospace" }}>{pct}%</span>
                            </div>
                            {statusBars.map(([count, dark, light], i) => {
                              const sPct = active > 0 ? Math.round(((count as number) / active) * 100) : 0;
                              return (
                                <div key={i} style={{ width: 110, height: 6, borderRadius: 3, background: "#0F172A", overflow: "hidden" }}>
                                  <div style={{ width: `${sPct}%`, height: "100%", background: `linear-gradient(90deg, ${light}, ${dark})`, borderRadius: 3, minWidth: (count as number) > 0 ? 3 : 0 }} />
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Scrollable chart area */}
                  <div className="tl-scroll" style={{ flex: 1, overflowX: "auto", overflowY: "auto", borderLeft: "2px solid #334155", paddingBottom: 4 }}
                    onScroll={e => { const left = e.currentTarget.previousElementSibling; if (left) left.scrollTop = e.currentTarget.scrollTop; }}>
                    <div style={{ width: chartWidth, minWidth: "100%" }}>
                      {/* Month header row — sticky */}
                      <div style={{ height: 44, position: "sticky", top: 0, zIndex: 4, background: "#0F172A", borderBottom: "1px solid #334155" }}>
                        {monthSpans.map((ms, i) => (
                          <div key={i} style={{ position: "absolute", left: ms.left, width: ms.width, height: "100%", display: "flex", alignItems: "center", justifyContent: "center", borderRight: "1px solid #334155" }}>
                            <span style={{ fontSize: 17, fontWeight: 700, color: "#D1D5DB", letterSpacing: 0.5 }}>{ms.label}</span>
                          </div>
                        ))}
                      </div>
                      {/* Week header row — sticky */}
                      <div style={{ height: 40, position: "sticky", top: 44, zIndex: 4, background: "#0F172A", borderBottom: "1px solid #334155" }}>
                        {weeks.map((w, i) => {
                          const wWidth = i < weeks.length - 1 ? weeks[i + 1].offset - w.offset : 7 * dayWidth;
                          const isThisWeek = today.getTime() >= w.date.getTime() && today.getTime() < w.date.getTime() + 7 * DAY;
                          return (
                            <div key={i} style={{ position: "absolute", left: w.offset, width: wWidth, height: "100%", display: "flex", alignItems: "center", justifyContent: "center", borderRight: "1px solid #1E293B", background: isThisWeek ? "#F59E0B15" : "transparent" }}>
                              <span style={{ fontSize: 15, color: isThisWeek ? "#F59E0B" : "#6B7280", fontWeight: isThisWeek ? 700 : 500 }}>
                                {w.date.toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      {/* PO Gantt rows */}
                      {filteredPOs.length === 0 ? (
                        <div style={{ padding: 40, textAlign: "center", color: "#6B7280" }}>No POs with milestones</div>
                      ) : filteredPOs.map((po, idx) => {
                        const poNum = po.PoNumber ?? "";
                        const poMs = milestones[poNum] || [];
                        return (
                          <div key={poNum} style={{ height: ROW_H, position: "relative", borderBottom: "1px solid #0F172A", background: selected?.PoNumber === poNum ? "#334155" : idx % 2 === 0 ? "#1E293B" : "#1A2332", cursor: "pointer" }}
                            onClick={() => { setDetailMode("milestones"); setNewNote(""); setSearch(""); setSelected(po); setView("list"); }}>
                            {/* Week grid lines */}
                            {weeks.map((w, i) => (
                              <div key={i} style={{ position: "absolute", left: w.offset, top: 0, bottom: 0, borderLeft: "1px solid #0F172A33" }} />
                            ))}
                            {/* Today line */}
                            <div style={{ position: "absolute", left: todayOffset, top: 0, bottom: 0, width: 2, background: "#F59E0B", zIndex: 2, opacity: 0.7 }} />
                            {/* Category bars */}
                            {WIP_CATEGORIES.map((cat, catIdx) => {
                              const catMs = poMs.filter(m => m.category === cat);
                              if (catMs.length === 0) return null;
                              const dates = catMs.map(m => m.expected_date).filter(Boolean) as string[];
                              if (dates.length === 0) return null;
                              const catStart = dates.reduce((min, d) => d < min ? d : min, dates[0]);
                              const catEnd = dates.reduce((max, d) => d > max ? d : max, dates[0]);
                              const x1 = toX(catStart);
                              const x2 = toX(catEnd);
                              const barW = Math.max(x2 - x1, dayWidth);
                              const allDone = catMs.every(m => m.status === "Complete" || m.status === "N/A");
                              const hasDelayed = catMs.some(m => m.status === "Delayed");
                              const hasInProg = catMs.some(m => m.status === "In Progress");
                              const barGradient = allDone ? "linear-gradient(90deg, #6EE7B7, #047857)" : hasDelayed ? "linear-gradient(90deg, #FCA5A5, #7F1D1D)" : hasInProg ? "linear-gradient(90deg, #93C5FD, #1D4ED8)" : "linear-gradient(90deg, #6B7280, #1F2937)";
                              const barH = 24;
                              const barY = 6 + catIdx * (barH + 3);
                              const catDone = catMs.filter(m => m.status === "Complete").length;
                              const catActive = catMs.filter(m => m.status !== "N/A").length;
                              return (
                                <div key={cat} title={`${cat}: ${catDone}/${catActive} complete\n${catStart} → ${catEnd}`}
                                  onClick={e => { e.stopPropagation(); openCategoryWithCheck(poNum, cat, po, true); }}
                                  style={{ position: "absolute", left: x1, width: barW, top: barY, height: barH, borderRadius: barH / 2, background: barGradient, minWidth: 6, zIndex: 3, display: "flex", alignItems: "center", overflow: "hidden", boxShadow: "0 2px 6px rgba(0,0,0,0.35)", cursor: "pointer", transition: "filter 0.15s" }}
                                  onMouseEnter={e => e.currentTarget.style.filter = "brightness(1.2)"}
                                  onMouseLeave={e => e.currentTarget.style.filter = "none"}>
                                  <span style={{ fontSize: 13, color: "#fff", fontWeight: 700, paddingLeft: 6, whiteSpace: "nowrap", opacity: 0.95 }}>{cat}</span>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </>
          );
        })()}
      </div>

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

// ── Styles ────────────────────────────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  app:        { minHeight: "100vh", background: "#0F172A", color: "#F1F5F9", fontFamily: "'DM Sans', 'Segoe UI', sans-serif" },
  loginBg:    { minHeight: "100vh", background: "#0F172A", display: "flex", alignItems: "center", justifyContent: "center" },
  loginCard:  { background: "#1E293B", borderRadius: 16, padding: 40, width: 360, boxShadow: "0 24px 64px rgba(0,0,0,.5)", display: "flex", flexDirection: "column", gap: 14 },
  loginLogo:  { width: 56, height: 56, borderRadius: 14, background: "linear-gradient(135deg,#3B82F6,#8B5CF6)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 22, alignSelf: "center" },
  loginTitle: { margin: 0, textAlign: "center", fontSize: 22, fontWeight: 700, color: "#F1F5F9" },
  loginSub:   { margin: 0, textAlign: "center", fontSize: 13, color: "#6B7280" },

  nav:        { background: "#1E293B", borderBottom: "1px solid #334155", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56, position: "sticky", top: 0, zIndex: 100 },
  navLeft:    { display: "flex", alignItems: "center", gap: 12 },
  navLogo:    { width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg,#3B82F6,#8B5CF6)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 13 },
  navTitle:   { fontWeight: 700, fontSize: 16, color: "#F1F5F9" },
  navSub:     { fontSize: 12, color: "#6B7280" },
  navRight:   { display: "flex", alignItems: "center", gap: 8 },
  navBtn:     { background: "none", border: "1px solid #334155", color: "#94A3B8", borderRadius: 6, padding: "5px 12px", fontSize: 13, cursor: "pointer" },
  navBtnActive:{ background: "#3B82F620", border: "1px solid #3B82F6", color: "#60A5FA", borderRadius: 6, padding: "5px 12px", fontSize: 13, cursor: "pointer", fontWeight: 600 },
  navBtnDanger:{ background: "none", border: "1px solid #EF4444", color: "#EF4444", borderRadius: 6, padding: "5px 12px", fontSize: 13, cursor: "pointer" },
  userPill:   { background: "#334155", color: "#94A3B8", borderRadius: 20, padding: "4px 12px", fontSize: 12 },

  content:    { maxWidth: "90%", margin: "0 auto", padding: "24px 20px" },
  statsRow:   { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 20 },
  statCard:   { background: "#1E293B", borderRadius: 12, padding: 20, display: "flex", flexDirection: "column", gap: 6 },
  card:       { background: "#1E293B", borderRadius: 12, padding: 20, marginBottom: 20 },
  cardTitle:  { margin: "0 0 16px", fontSize: 16, fontWeight: 700, color: "#F1F5F9" },

  filters:    { display: "flex", gap: 10, marginBottom: 16, alignItems: "center" },

  poRow:      { display: "flex", alignItems: "center", gap: 16, padding: "14px 16px", borderRadius: 8, marginBottom: 8, background: "#0F172A", cursor: "pointer", transition: "background .15s" },
  poNumber:   { fontFamily: "monospace", color: "#60A5FA", fontWeight: 700, fontSize: 15 },
  badge:      { fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20 },
  tagChip:    { background: "#334155", color: "#94A3B8", borderRadius: 20, padding: "3px 10px", fontSize: 12 },
  statusChip: { display: "flex", alignItems: "center", gap: 6, borderRadius: 20, padding: "6px 14px", fontSize: 13 },

  emptyState: { textAlign: "center", padding: 40, color: "#6B7280", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" },

  input:      { width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", color: "#F1F5F9", fontSize: 14, outline: "none", boxSizing: "border-box" },
  select:     { background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "9px 12px", color: "#F1F5F9", fontSize: 13, outline: "none" },
  textarea:   { width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", color: "#F1F5F9", fontSize: 14, resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" },
  label:      { color: "#94A3B8", fontSize: 13, display: "block", marginBottom: 4 },
  err:        { color: "#EF4444", fontSize: 13, margin: 0 },
  errBanner:  { background: "#7F1D1D", color: "#FCA5A5", padding: "10px 24px", fontSize: 14, display: "flex", alignItems: "center" },

  btnPrimary: { background: "linear-gradient(135deg,#3B82F6,#8B5CF6)", color: "#fff", border: "none", borderRadius: 8, padding: "10px 20px", fontWeight: 600, fontSize: 14, cursor: "pointer", width: "100%" },
  btnSecondary:{ background: "none", border: "1px solid #334155", color: "#94A3B8", borderRadius: 8, padding: "8px 16px", fontSize: 13, cursor: "pointer" },

  // Modal
  modalOverlay:{ position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" },
  modal:       { background: "#1E293B", borderRadius: 16, width: 480, maxHeight: "80vh", overflow: "hidden", display: "flex", flexDirection: "column" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid #334155" },
  modalTitle:  { margin: 0, fontSize: 18, fontWeight: 700, color: "#F1F5F9" },
  modalBody:   { padding: 20, overflowY: "auto" },
  closeBtn:    { background: "none", border: "none", color: "#6B7280", fontSize: 18, cursor: "pointer", lineHeight: 1 },
  settingSection:{ color: "#F1F5F9", fontSize: 15, fontWeight: 700, margin: "0 0 10px" },

  // Detail panel
  detailOverlay:{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 200, display: "flex", justifyContent: "flex-end" },
  detailPanel:  { background: "#1E293B", width: 600, maxWidth: "90vw", height: "100%", overflowY: "auto", display: "flex", flexDirection: "column" },
  detailHeader: { padding: "20px 24px", borderBottom: "1px solid #334155", display: "flex", justifyContent: "space-between", alignItems: "flex-start", background: "#0F172A" },
  detailPONum:  { fontFamily: "monospace", color: "#60A5FA", fontWeight: 800, fontSize: 20 },
  detailVendor: { color: "#D1D5DB", fontWeight: 600, fontSize: 15, marginTop: 4 },
  detailBody:   { padding: 24, flex: 1 },

  infoGrid:     { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 20 },
  infoCell:     { background: "#0F172A", borderRadius: 8, padding: 12 },
  infoCellLabel:{ color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 },
  infoCellValue:{ color: "#F1F5F9", fontSize: 14, fontWeight: 600 },

  memoBox:      { background: "#0F172A", borderRadius: 8, padding: 14, marginBottom: 16 },
  sectionLabel: { color: "#6B7280", fontSize: 12, textTransform: "uppercase", letterSpacing: 1, marginBottom: 10, fontWeight: 600 },

  itemsTable:   { background: "#0F172A", borderRadius: 8, overflow: "hidden" },
  itemsHeader:  { display: "grid", gridTemplateColumns: "1fr 2fr 80px 100px 100px", padding: "10px 14px", background: "#1E293B", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, gap: 8 },
  itemRow:      { display: "grid", gridTemplateColumns: "1fr 2fr 80px 100px 100px", padding: "10px 14px", borderTop: "1px solid #1E293B", gap: 8, fontSize: 13 },
  itemsTotal:   { display: "grid", gridTemplateColumns: "1fr 2fr 80px 100px 100px", padding: "12px 14px", borderTop: "2px solid #334155", gap: 8, background: "#1A2332" },

  noteCard:     { background: "#0F172A", borderRadius: 8, padding: 14, marginBottom: 10 },
};
