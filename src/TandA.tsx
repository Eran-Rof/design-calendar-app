import { useState, useEffect, useCallback, useRef } from "react";

// ── Supabase ─────────────────────────────────────────────────────────────────
const SB_URL = "https://qcvqvxxoperiurauoxmp.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFjdnF2eHhvcGVyaXVyYXVveG1wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2ODU4MjksImV4cCI6MjA4OTI2MTgyOX0.YoBmIdlqqPYt9roTsDPGSBegNnoupCYSsnyCHMo24Zw";
const SB_HEADERS = { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json", "Prefer": "return=representation" };

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
  poNumber: string;
  dateFrom: string;
  dateTo: string;
  vendors: string[];
  statuses: string[];
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
      TotalAmount:           h.TotalAmount ?? 0,
      Items: lines.map((l: any) => ({
        ItemNumber:  l.PoItemNumber ?? l.ItemNumber ?? "",
        Description: l.Description ?? l.Title ?? "",
        QtyOrder:    l.QtyOrder ?? 0,
        UnitPrice:   l.UnitPrice ?? l.EffectiveUnitPrice ?? 0,
      })),
    } as XoroPO;
  });
}

// All PO statuses — Xoro only returns "Open" by default, so we must request all explicitly
const ALL_PO_STATUSES = ["Open", "Released", "Received", "Closed", "Cancelled", "Pending", "Draft"];

interface XoroFetchOpts {
  page?: number;
  signal?: AbortSignal;
  statuses?: string[];
  vendors?: string[];
  poNumber?: string;
  dateFrom?: string;
  dateTo?: string;
}

async function fetchXoroPOs(opts: XoroFetchOpts = {}): Promise<{ pos: XoroPO[]; totalPages: number }> {
  const { page = 1, signal, statuses, vendors, poNumber, dateFrom, dateTo } = opts;
  const params = new URLSearchParams({ path: "purchaseorder/getpurchaseorder", page: String(page) });

  // Pass status filter — default to all statuses so Xoro doesn't just return "Open"
  const statusList = statuses?.length ? statuses : ALL_PO_STATUSES;
  params.set("status", statusList.join(","));

  // Pass vendor filter if specified
  if (vendors?.length) params.set("vendor_name", vendors.join(","));

  // Pass PO number filter if specified
  if (poNumber) params.set("order_number", poNumber);

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
  if (!json.Result) throw new Error(json.Message ?? "Unknown Xoro error");
  const raw = Array.isArray(json.Data) ? json.Data : [];
  return { pos: mapXoroRaw(raw), totalPages: json.TotalPages ?? 1 };
}

// Client-side fallback filter (in case API-side filters are incomplete)
function applyFilters(pos: XoroPO[], filters?: SyncFilters): XoroPO[] {
  if (!filters) return pos;
  return pos.filter(po => {
    if (filters.poNumber && !(po.PoNumber ?? "").toLowerCase().includes(filters.poNumber.toLowerCase())) return false;
    if (filters.statuses?.length && !filters.statuses.includes(po.StatusName ?? "")) return false;
    if (filters.vendors?.length && !filters.vendors.includes(po.VendorName ?? "")) return false;
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
}

type View = "dashboard" | "list" | "detail" | "templates" | "email";

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
  notes: string;
  updated_at: string;
  updated_by: string;
}

interface DCVendor {
  id: string;
  name: string;
  wipLeadOverrides?: Record<string, number>;
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
  if (po.TotalAmount != null) return po.TotalAmount;
  const items = po.Items ?? po.PoLineArr ?? [];
  return items.reduce((s, i) => s + (i.QtyOrder ?? 0) * (i.UnitPrice ?? 0), 0);
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function TandAApp() {
  const [user, setUser]         = useState<User | null>(null);
  const [view, setView]         = useState<View>("dashboard");
  const [pos, setPos]           = useState<XoroPO[]>([]);
  const [notes, setNotes]       = useState<LocalNote[]>([]);
  const [selected, setSelected] = useState<XoroPO | null>(null);
  const [detailMode, setDetailMode] = useState<"header" | "po" | "milestones" | "notes" | "history" | "matrix" | "email" | "all">("header");
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
    poNumber: "", dateFrom: "", dateTo: "", vendors: [], statuses: []
  });
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
  const [emailToken, setEmailToken] = useState<string | null>(null);
  const [emailTokenExpiry, setEmailTokenExpiry] = useState<number | null>(null);
  const [showEmailConfig, setShowEmailConfig] = useState(false);
  const [emailSelPO, setEmailSelPO] = useState<string | null>(null);
  const [emailsMap, setEmailsMap] = useState<Record<string, any[]>>({});
  const [emailLoadingMap, setEmailLoadingMap] = useState<Record<string, boolean>>({});
  const [emailErrorsMap, setEmailErrorsMap] = useState<Record<string, string | null>>({});
  const [emailSelMsg, setEmailSelMsg] = useState<any>(null);
  const [emailThreadMsgs, setEmailThreadMsgs] = useState<any[]>([]);
  const [emailThreadLoading, setEmailThreadLoading] = useState(false);
  const [emailTabCur, setEmailTabCur] = useState<"inbox" | "thread" | "compose">("inbox");
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
  // Detail-panel email tab state (separate from main email view)
  const [dtlEmails, setDtlEmails] = useState<Record<string, any[]>>({});
  const [dtlEmailLoading, setDtlEmailLoading] = useState<Record<string, boolean>>({});
  const [dtlEmailErr, setDtlEmailErr] = useState<Record<string, string | null>>({});
  const [dtlEmailSel, setDtlEmailSel] = useState<any>(null);
  const [dtlEmailThread, setDtlEmailThread] = useState<any[]>([]);
  const [dtlThreadLoading, setDtlThreadLoading] = useState(false);
  const [dtlEmailTab, setDtlEmailTab] = useState<"inbox" | "thread" | "compose">("inbox");
  const [dtlComposeTo, setDtlComposeTo] = useState("");
  const [dtlComposeSubject, setDtlComposeSubject] = useState("");
  const [dtlComposeBody, setDtlComposeBody] = useState("");
  const [dtlSendErr, setDtlSendErr] = useState<string | null>(null);
  const [dtlReply, setDtlReply] = useState("");
  const [dtlNextLink, setDtlNextLink] = useState<Record<string, string | null>>({});
  const [dtlLoadingOlder, setDtlLoadingOlder] = useState(false);

  // ── Email auth + Graph helpers ──────────────────────────────────────────
  function emailTokenIsValid() {
    return !!emailToken && (!emailTokenExpiry || Date.now() < emailTokenExpiry);
  }
  function handleEmailTokenExpired() {
    setEmailToken(null);
    setEmailTokenExpiry(null);
  }
  async function authenticateEmail() {
    if (!emailConfig.clientId || !emailConfig.tenantId) return;
    try {
      const authUrl = "https://login.microsoftonline.com/" + emailConfig.tenantId + "/oauth2/v2.0/authorize?" +
        "client_id=" + emailConfig.clientId + "&response_type=token&redirect_uri=" + encodeURIComponent(window.location.origin + "/auth-callback") +
        "&scope=" + encodeURIComponent("https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send") +
        "&response_mode=fragment&prompt=select_account";
      const popup = window.open(authUrl, "msauth", "width=500,height=700,left=400,top=100");
      const { accessToken, expiresIn } = await new Promise<{ accessToken: string; expiresIn: number }>((resolve, reject) => {
        const timer = setInterval(() => {
          try {
            if (popup!.closed) { clearInterval(timer); reject(new Error("Popup closed")); return; }
            const hash = popup!.location.hash;
            if (hash && hash.includes("access_token")) {
              clearInterval(timer); popup!.close();
              const params = new URLSearchParams(hash.substring(1));
              resolve({ accessToken: params.get("access_token")!, expiresIn: parseInt(params.get("expires_in") || "3600", 10) });
            }
          } catch (_) {}
        }, 300);
        setTimeout(() => { clearInterval(timer); if (!popup!.closed) popup!.close(); reject(new Error("Timeout")); }, 120000);
      });
      setEmailToken(accessToken);
      setEmailTokenExpiry(Date.now() + expiresIn * 1000);
    } catch (e) { console.error("Email auth failed:", e); }
  }
  async function emailGraph(path: string) {
    if (!emailTokenIsValid()) { handleEmailTokenExpired(); throw new Error("Token expired"); }
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { headers: { Authorization: "Bearer " + emailToken!, "Content-Type": "application/json" } });
    if (r.status === 401) { handleEmailTokenExpired(); throw new Error("Session expired"); }
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  }
  async function emailGraphPost(path: string, body: any) {
    if (!emailTokenIsValid()) { handleEmailTokenExpired(); throw new Error("Token expired"); }
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { method: "POST", headers: { Authorization: "Bearer " + emailToken!, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 401) { handleEmailTokenExpired(); throw new Error("Session expired"); }
    if (r.status === 202 || r.status === 200) return r.status === 202 ? {} : r.json();
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  }

  // ── Detail panel email helpers ───────────────────────────────────────────
  async function loadDtlEmails(poNum: string, olderUrl?: string) {
    if (!emailToken) return;
    const prefix = "[PO-" + poNum + "]";
    if (olderUrl) { setDtlLoadingOlder(true); } else { setDtlEmailLoading(l => ({ ...l, [poNum]: true })); }
    setDtlEmailErr(e => ({ ...e, [poNum]: null }));
    try {
      const url = olderUrl || ("/me/messages?$filter=" + encodeURIComponent("contains(subject,'" + prefix + "')") + "&$top=25&$orderby=receivedDateTime%20desc&$select=id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead,hasAttachments");
      const d = await emailGraph(url);
      const items = d.value || [];
      if (olderUrl) { setDtlEmails(m => ({ ...m, [poNum]: [...(m[poNum] || []), ...items] })); }
      else { setDtlEmails(m => ({ ...m, [poNum]: items })); }
      setDtlNextLink(nl => ({ ...nl, [poNum]: d["@odata.nextLink"] ? d["@odata.nextLink"].replace("https://graph.microsoft.com/v1.0", "") : null }));
    } catch (e: any) { setDtlEmailErr(err => ({ ...err, [poNum]: e.message })); }
    setDtlEmailLoading(l => ({ ...l, [poNum]: false }));
    setDtlLoadingOlder(false);
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
      setTimeout(() => loadDtlEmails(poNum), 2000);
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
    // Track changes for history
    if (!skipHistory) {
      const existing = (milestones[m.po_number] || []).find(x => x.id === m.id);
      if (existing) {
        const changes: string[] = [];
        if (existing.status !== m.status) changes.push(`Status: ${existing.status} → ${m.status}`);
        if (existing.actual_date !== m.actual_date) changes.push(`Actual Date: ${existing.actual_date || "—"} → ${m.actual_date || "—"}`);
        if (existing.notes !== m.notes) changes.push(`Notes updated`);
        if (changes.length > 0) {
          addHistory(m.po_number, `${m.phase}: ${changes.join(", ")}`);
        }
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
      setCollapsedCats(prev => {
        const next = { ...prev };
        WIP_CATEGORIES.forEach(cat => { delete next[cat + m.po_number]; });
        return next;
      });
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
        notes: "",
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

  // ── Sync from Xoro with filters ───────────────────────────────────────────
  async function syncFromXoro(filters?: SyncFilters) {
    // Abort any previous sync
    syncAbortRef.current?.abort();
    const controller = new AbortController();
    syncAbortRef.current = controller;

    setSyncing(true);
    setSyncErr("");
    setShowSyncModal(false);
    try {
      // Fetch POs from Xoro — pass filters to API for server-side filtering
      let all: XoroPO[] = [];
      let page = 1;
      let totalPages = 1;
      do {
        if (controller.signal.aborted) throw new Error("Sync cancelled.");
        const { pos: batch, totalPages: tp } = await fetchXoroPOs({
          page,
          signal: controller.signal,
          statuses: filters?.statuses,
          vendors: filters?.vendors,
          poNumber: filters?.poNumber,
          dateFrom: filters?.dateFrom,
          dateTo: filters?.dateTo,
        });
        all = [...all, ...batch];
        totalPages = tp;
        page++;
      } while (page <= totalPages && page <= 20);

      // Client-side fallback filter (in case API missed some)
      all = applyFilters(all, filters);

      // MERGE — upsert each PO by po_number
      const now = new Date().toISOString();
      if (all.length > 0) {
        await sb.from("tanda_pos").upsert(
          all.map(po => ({
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
      // Auto-delete POs with status Closed or Received
      const autoDeleteStatuses = ["Closed", "Received", "Cancelled"];
      const toDelete = all.filter(po => autoDeleteStatuses.includes(po.StatusName ?? ""));
      for (const po of toDelete) {
        const pn = po.PoNumber ?? "";
        if (pn) await deletePO(pn);
      }
      const deletedCount = toDelete.length;

      // reload full cache
      await loadCachedPOs();
      setLastSync(now);
      // Log sync to history for each synced PO
      const synced = all.filter(po => !autoDeleteStatuses.includes(po.StatusName ?? ""));
      for (const po of synced.slice(0, 5)) {
        addHistory(po.PoNumber ?? "", `PO synced from Xoro (${synced.length} POs in batch${deletedCount > 0 ? `, ${deletedCount} closed/received POs removed` : ""})`);
      }
      if (synced.length > 5) addHistory(synced[0]?.PoNumber ?? "", `... and ${synced.length - 5} more POs synced`);
    } catch (e: any) {
      if (e.name === "AbortError") setSyncErr("Sync timed out or was cancelled. Check your Xoro API credentials and try again.");
      else setSyncErr(e.message ?? "Sync failed");
    } finally {
      syncAbortRef.current = null;
      setSyncing(false);
    }
  }

  useEffect(() => {
    if (user) { loadCachedPOs(); loadNotes(); loadVendors(); loadWipTemplates(); loadAllMilestones(); loadDCVendors(); loadDesignTemplates(); }
  }, [user, loadCachedPOs, loadNotes, loadVendors]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const vendors = ["All", ...Array.from(new Set(pos.map(p => p.VendorName ?? "Unknown"))).sort()];

  const filtered = pos.filter(p => {
    const s = search.toLowerCase();
    const matchSearch = !s
      || (p.PoNumber ?? "").toLowerCase().includes(s)
      || (p.VendorName ?? "").toLowerCase().includes(s)
      || (p.Memo ?? "").toLowerCase().includes(s)
      || (p.Tags ?? "").toLowerCase().includes(s);
    const matchStatus = filterStatus === "All" || (p.StatusName ?? "") === filterStatus;
    const matchVendor = filterVendor === "All" || (p.VendorName ?? "") === filterVendor;
    return matchSearch && matchStatus && matchVendor;
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
  const allVendors = Array.from(new Set([...xoroVendors, ...manualVendors])).sort();
  const filteredVendorList = allVendors.filter(v =>
    !vendorSearch || v.toLowerCase().includes(vendorSearch.toLowerCase())
  );

  const SyncModal = () => (
    <div style={S.modalOverlay} onClick={() => setShowSyncModal(false)}>
      <div style={{ ...S.modal, width: 540 }} onClick={e => e.stopPropagation()}>
        <div style={S.modalHeader}>
          <h2 style={S.modalTitle}>🔄 Sync from Xoro</h2>
          <button style={S.closeBtn} onClick={() => setShowSyncModal(false)}>✕</button>
        </div>
        <div style={S.modalBody}>
          <p style={{ color: "#9CA3AF", fontSize: 13, marginTop: 0, marginBottom: 20 }}>
            Filter which POs to pull from Xoro. Leave all blank to sync everything. New POs will be added; existing ones updated.
          </p>

          {/* PO Number */}
          <label style={S.label}>PO Number</label>
          <input style={{ ...S.input, marginBottom: 16 }}
            placeholder="e.g. PO-1234 (leave blank for all)"
            value={syncFilters.poNumber}
            onChange={e => setSyncFilters(p => ({ ...p, poNumber: e.target.value }))} />

          {/* Date range */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            <div>
              <label style={S.label}>Date Created — From</label>
              <div style={{ position: "relative" }}>
                <input style={{ ...S.input, paddingRight: 36 }}
                  placeholder="MM/DD/YYYY"
                  value={syncFilters.dateFrom}
                  onChange={e => {
                    let v = e.target.value.replace(/[^\d/]/g, "");
                    setSyncFilters(p => ({ ...p, dateFrom: v }));
                  }} />
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
                <input style={{ ...S.input, paddingRight: 36 }}
                  placeholder="MM/DD/YYYY"
                  value={syncFilters.dateTo}
                  onChange={e => {
                    let v = e.target.value.replace(/[^\d/]/g, "");
                    setSyncFilters(p => ({ ...p, dateTo: v }));
                  }} />
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
            {filteredVendorList.length === 0 && (
              <div style={{ padding: 12, color: "#6B7280", fontSize: 13 }}>
                {allVendors.length === 0 ? "No vendors loaded yet — sync will fetch all." : "No vendors match your search."}
              </div>
            )}
            {filteredVendorList.map(v => {
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
                      onClick={e => { e.stopPropagation(); if (window.confirm(`Are you sure you want to remove vendor "${v}"?`)) removeManualVendor(v); }}>✕</button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Add manual vendor */}
          <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
            <input style={{ ...S.input, marginBottom: 0 }} placeholder="Add vendor manually…"
              value={newManualVendor} onChange={e => setNewManualVendor(e.target.value)}
              onKeyDown={e => e.key === "Enter" && saveManualVendor()} />
            <button style={{ ...S.btnSecondary, whiteSpace: "nowrap" }} onClick={saveManualVendor}>+ Add</button>
          </div>

          {/* Selected summary */}
          {(syncFilters.vendors.length > 0 || syncFilters.statuses.length > 0 || syncFilters.poNumber || syncFilters.dateFrom || syncFilters.dateTo) && (
            <div style={{ background: "#0F172A", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 12, color: "#9CA3AF" }}>
              <strong style={{ color: "#60A5FA" }}>Will sync:</strong>
              {syncFilters.poNumber && <span style={{ marginLeft: 8 }}>PO# <b style={{ color: "#F1F5F9" }}>{syncFilters.poNumber}</b></span>}
              {syncFilters.dateFrom && <span style={{ marginLeft: 8 }}>From <b style={{ color: "#F1F5F9" }}>{syncFilters.dateFrom}</b></span>}
              {syncFilters.dateTo   && <span style={{ marginLeft: 8 }}>To <b style={{ color: "#F1F5F9" }}>{syncFilters.dateTo}</b></span>}
              {syncFilters.statuses.length > 0 && <span style={{ marginLeft: 8 }}>Status: <b style={{ color: "#F1F5F9" }}>{syncFilters.statuses.join(", ")}</b></span>}
              {syncFilters.vendors.length  > 0 && <span style={{ marginLeft: 8 }}>Vendors: <b style={{ color: "#F1F5F9" }}>{syncFilters.vendors.join(", ")}</b></span>}
            </div>
          )}

          <div style={{ display: "flex", gap: 10 }}>
            <button style={{ ...S.btnSecondary, flex: 1 }} onClick={() => setSyncFilters({ poNumber: "", dateFrom: "", dateTo: "", vendors: [], statuses: [] })}>
              Clear Filters
            </button>
            <button style={{ ...S.btnPrimary, flex: 2 }} onClick={() => syncFromXoro(syncFilters)}>
              🔄 {syncFilters.vendors.length === 0 && syncFilters.statuses.length === 0 && !syncFilters.poNumber && !syncFilters.dateFrom ? "Sync All POs" : "Sync Filtered POs"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

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

    if (mode === "po" || mode === "header") {
      const lineData: any[][] = [["SKU", "Description", "Qty", "Unit Price", "Total"]];
      items.forEach(item => { lineData.push([item.ItemNumber ?? "", item.Description ?? "", item.QtyOrder ?? 0, item.UnitPrice ?? 0, (item.QtyOrder ?? 0) * (item.UnitPrice ?? 0)]); });
      lineData.push(["TOTAL", "", items.reduce((s, i) => s + (i.QtyOrder ?? 0), 0), "", totalVal]);
      XLSX.utils.book_append_sheet(wb, styleSheet(lineData, [22, 32, 12, 14, 16], { totalRow: true, dollarCols: [3, 4], qtyCols: [2] }), "PO Details");
      XLSX.writeFile(wb, `${poNum}_PO_Details.xlsx`);

    } else if (mode === "matrix") {
      const parsed = items.map(item => {
        const sku = item.ItemNumber ?? ""; const parts = sku.split("-");
        return { base: parts[0] || sku, color: parts.length >= 2 ? parts[1] : "", size: parts.length >= 3 ? parts.slice(2).join("-") : "", qty: item.QtyOrder ?? 0, price: item.UnitPrice ?? 0, desc: item.Description ?? "" };
      });
      const sizeOrder: string[] = [];
      parsed.forEach(p => { if (p.size && !sizeOrder.includes(p.size)) sizeOrder.push(p.size); });
      const rows: any[][] = [["Base Part", "Description", "Color", ...sizeOrder, "Total", "PO Cost", "Total Cost"]];
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
        rows.push([base, row.desc, row.color, ...sizeOrder.map(sz => row.sizes[sz] || 0), rt, row.price, rt * row.price]);
      }); });
      rows.push(["", "", "GRAND TOTAL", ...sizeOrder.map(sz => parsed.filter(p => p.size === sz).reduce((s, p) => s + p.qty, 0)), items.reduce((s, i) => s + (i.QtyOrder ?? 0), 0), "", totalVal]);
      const nSz = sizeOrder.length;
      const dollarCols = [3 + nSz + 1, 3 + nSz + 2]; // PO Cost, Total Cost
      const qtyCols = [...sizeOrder.map((_, i) => 3 + i), 3 + nSz]; // size cols + Total col
      const colW = [18, 26, 14, ...sizeOrder.map(() => 10), 10, 12, 14];
      XLSX.utils.book_append_sheet(wb, styleSheet(rows, colW, { totalRow: true, dollarCols, qtyCols }), "Matrix");
      XLSX.writeFile(wb, `${poNum}_Matrix.xlsx`);

    } else if (mode === "milestones") {
      const poMs = milestones[poNum] || [];
      const rows: any[][] = [["Category", "Milestone", "Expected Date", "Actual Date", "Status", "Notes"]];
      poMs.forEach(m => { rows.push([m.category, m.name, m.expected_date ?? "", m.actual_date ?? "", m.status, m.notes ?? ""]); });
      XLSX.utils.book_append_sheet(wb, styleSheet(rows, [20, 26, 16, 16, 16, 32]), "Milestones");
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
        const msRows: any[][] = [["Category", "Milestone", "Expected Date", "Actual Date", "Status", "Notes"]];
        poMs.forEach(m => { msRows.push([m.category, m.name, m.expected_date ?? "", m.actual_date ?? "", m.status, m.notes ?? ""]); });
        XLSX.utils.book_append_sheet(wb, styleSheet(msRows, [20, 26, 16, 16, 16, 32]), "Milestones");
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
        <div id="po-detail-content" style={{ maxWidth: 1200, margin: "0 auto", width: "100%", padding: "24px 20px", flex: 1 }}>
          {/* Header */}
          <div style={{ ...S.detailHeader, borderLeft: `4px solid ${statusColor}`, borderRadius: 12, marginBottom: 16 }}>
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
              <button onClick={() => { if (window.confirm(`Delete PO ${selected.PoNumber}? This will permanently remove the PO, all milestones, notes, and history.`)) deletePO(selected.PoNumber ?? ""); }}
                style={{ background: "none", border: "1px solid #EF4444", color: "#EF4444", borderRadius: 6, padding: "4px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}
                onMouseEnter={e => { e.currentTarget.style.background = "#EF4444"; e.currentTarget.style.color = "#fff"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "#EF4444"; }}>🗑 Delete PO</button>
              <button style={{ ...S.closeBtn, fontSize: 16, padding: "4px 10px" }} onClick={() => setSelected(null)}>✕ Close</button>
            </div>
          </div>

          {/* Key info grid — always visible */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 14, marginBottom: 20 }}>
            <InfoCell label="Order Date" value={fmtDate(selected.DateOrder)} />
            <InfoCell label="Expected Delivery" value={
              <span style={{ color: days !== null && days < 0 ? "#EF4444" : days !== null && days <= 7 ? "#F59E0B" : "#10B981" }}>
                {fmtDate(selected.DateExpectedDelivery)}
                {days !== null && <span style={{ fontSize: 13, marginLeft: 6 }}>
                  {days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? "Today!" : `in ${days}d`}
                </span>}
              </span>
            } />
            <InfoCell label="Country of Origin" value={(() => {
              const vendor = dcVendors.find(v => v.name === selected.VendorName);
              return (vendor as any)?.country || "—";
            })()} />
            <InfoCell label="Total Value" value={fmtCurrency(total, selected.CurrencyCode)} />
            <InfoCell label="Total Qty" value={totalQty.toLocaleString()} />
          </div>

          {/* Tabs */}
          <div style={{ display: "flex", gap: 2, marginBottom: 0 }}>
            <button style={tabStyle("po")} onClick={() => setDetailMode("po")}>PO Details</button>
            <button style={tabStyle("matrix")} onClick={() => setDetailMode("matrix")}>Matrix</button>
            <button style={tabStyle("milestones")} onClick={() => setDetailMode("milestones")}>Milestones</button>
            <button style={tabStyle("notes")} onClick={() => setDetailMode("notes")}>Notes</button>
            <button style={tabStyle("email")} onClick={() => { setDetailMode("email"); setDtlEmailTab("inbox"); const pn = selected.PoNumber ?? ""; if (pn && emailToken && !dtlEmails[pn]?.length) loadDtlEmails(pn); }}>📧 Email</button>
            <button style={tabStyle("history")} onClick={() => setDetailMode("history")}>History</button>
            <button style={tabStyle("all")} onClick={() => setDetailMode("all")}>All</button>
          </div>
          <div style={{ border: "1px solid #334155", borderTop: "none", borderRadius: "0 0 10px 10px", background: "#1E293B", padding: 20, marginBottom: 20 }}>

          {/* PO Details section */}
          {showPO && selected.Memo && (
              <div style={S.memoBox}>
                <div style={S.sectionLabel}>Memo</div>
                <p style={{ color: "#D1D5DB", fontSize: 14, margin: 0 }}>{selected.Memo}</p>
              </div>
            )}

            {showPO && selected.Tags && (
              <div style={{ marginBottom: 16 }}>
                <div style={S.sectionLabel}>Tags</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {selected.Tags.split(",").map(t => (
                    <span key={t} style={S.tagChip}>{t.trim()}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Line items */}
            {showPO && items.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={S.sectionLabel}>Line Items ({items.length})</div>
                <div style={S.itemsTable}>
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
              </div>
            )}

            {/* Matrix View */}
            {(detailMode === "matrix" || detailMode === "all") && items.length > 0 && (() => {
              // Parse items: chars before first "-" = base, before second "-" = color, after third "-" = size
              const parsed = items.map(item => {
                const sku = item.ItemNumber ?? "";
                const parts = sku.split("-");
                const base = parts[0] || sku;
                const color = parts.length >= 2 ? parts[1] : "";
                const size = parts.length >= 3 ? parts.slice(2).join("-") : "";
                return { base, color, size, qty: item.QtyOrder ?? 0, price: item.UnitPrice ?? 0, desc: item.Description ?? "", raw: sku };
              });
              // Collect all unique sizes in order of appearance
              const sizeOrder: string[] = [];
              parsed.forEach(p => { if (p.size && !sizeOrder.includes(p.size)) sizeOrder.push(p.size); });
              // Group by base part
              const bases: string[] = [];
              const byBase: Record<string, { color: string; desc: string; sizes: Record<string, number>; price: number }[]> = {};
              parsed.forEach(p => {
                if (!byBase[p.base]) { byBase[p.base] = []; bases.push(p.base); }
                let row = byBase[p.base].find(r => r.color === p.color);
                if (!row) { row = { color: p.color, desc: p.desc, sizes: {}, price: p.price }; byBase[p.base].push(row); }
                row.sizes[p.size] = (row.sizes[p.size] || 0) + p.qty;
              });

              return (
                <div style={{ marginBottom: 20 }}>
                  <div style={S.sectionLabel}>Item Matrix</div>
                  <div style={{ overflowX: "auto" }}>
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
                          const baseTotal: Record<string, number> = {};
                          let baseTotalQty = 0;
                          let baseTotalCost = 0;
                          rows.forEach(r => {
                            Object.entries(r.sizes).forEach(([sz, qty]) => { baseTotal[sz] = (baseTotal[sz] || 0) + qty; });
                          });
                          return rows.map((row, ri) => {
                            const rowTotal = Object.values(row.sizes).reduce((s, q) => s + q, 0);
                            const rowCost = rowTotal * row.price;
                            baseTotalQty += rowTotal;
                            baseTotalCost += rowCost;
                            const isLast = ri === rows.length - 1;
                            return (
                              <tr key={base + "-" + row.color} style={{ borderBottom: isLast && bi < bases.length - 1 ? "2px solid #334155" : "1px solid #1E293B" }}>
                                {ri === 0 ? (
                                  <td rowSpan={rows.length} style={{ padding: "10px 14px", color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, verticalAlign: "top", borderRight: "1px solid #334155" }}>{base}</td>
                                ) : null}
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
                            const colTotal = parsed.filter(p => p.size === sz).reduce((s, p) => s + p.qty, 0);
                            return <td key={sz} style={{ padding: "12px 14px", textAlign: "center", color: "#F59E0B", fontWeight: 700, fontFamily: "monospace" }}>{colTotal}</td>;
                          })}
                          <td style={{ padding: "12px 14px", textAlign: "center", color: "#F59E0B", fontWeight: 800, fontFamily: "monospace" }}>{totalQty}</td>
                          <td style={{ padding: "12px 14px" }} />
                          <td style={{ padding: "12px 14px", textAlign: "right", color: "#10B981", fontWeight: 800, fontFamily: "monospace" }}>{fmtCurrency(total, selected.CurrencyCode)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
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
                      {(!emailConfig.clientId || !emailConfig.tenantId) ? (
                        <div style={{ color: "#D97706", fontSize: 12 }}>Configure Azure AD credentials in the main Email view first</div>
                      ) : (
                        <button onClick={authenticateEmail} style={{ ...S.btnPrimary, width: "auto", fontSize: 12, padding: "8px 18px" }}>Sign in with Microsoft</button>
                      )}
                    </div>
                  ) : (
                    <>
                      <div style={{ display: "flex", gap: 2, marginBottom: 12 }}>
                        {(["inbox", "thread", "compose"] as const).map(tab => (
                          <button key={tab} onClick={() => { setDtlEmailTab(tab); if (tab === "compose") setDtlComposeSubject(prefix + " "); }}
                            style={{ padding: "8px 16px", border: "1px solid #334155", borderBottom: dtlEmailTab === tab ? "none" : "1px solid #334155", background: dtlEmailTab === tab ? "#1E293B" : "#0F172A", color: dtlEmailTab === tab ? OUTLOOK_BLUE : "#6B7280", fontWeight: dtlEmailTab === tab ? 700 : 500, cursor: "pointer", fontFamily: "inherit", fontSize: 12, borderRadius: "8px 8px 0 0", textTransform: "capitalize" }}>{tab}</button>
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
                                    <iframe sandbox="allow-same-origin" srcDoc={htmlBody} style={{ width: "100%", border: "none", minHeight: 80, borderRadius: 6, background: "#F8FAFC" }}
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
                          if (window.confirm("Regenerate milestones? Your actual dates, statuses, and notes will be preserved.")) regenerateMilestones(selected);
                        }}>
                          Regenerate
                        </button>
                      )}
                    </div>
                  </div>
                  {poMs.length === 0 && !ddp && <p style={{ color: "#6B7280", fontSize: 13 }}>No expected delivery date — cannot generate milestones.</p>}
                  {poMs.length === 0 && ddp && hasVendorTpl && <p style={{ color: "#6B7280", fontSize: 13 }}>No milestones yet. Click "Generate Milestones" to create them.</p>}
                  {(() => {
                    // Find the first category that is not fully complete
                    const activeCats = WIP_CATEGORIES.filter(cat => grouped[cat]?.length);
                    const firstIncompleteCat = activeCats.find(cat => {
                      const ms = grouped[cat];
                      return ms.some(m => m.status !== "Complete" && m.status !== "N/A");
                    });
                    return activeCats;
                  })().map(cat => {
                    const catMs = grouped[cat];
                    const catComplete = catMs.filter(m => m.status === "Complete").length;
                    const allDone = catComplete === catMs.length;
                    // Default: collapsed unless it's the first incomplete category
                    const activeCats = WIP_CATEGORIES.filter(c => grouped[c]?.length);
                    const firstIncompleteCat = activeCats.find(c => grouped[c].some(m => m.status !== "Complete" && m.status !== "N/A"));
                    const defaultCollapsed = cat !== firstIncompleteCat;
                    const key = cat + poNum;
                    const collapsed = collapsedCats[key] !== undefined ? collapsedCats[key] : defaultCollapsed;
                    return (
                      <div key={cat} style={{ marginBottom: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#0F172A", borderRadius: collapsed ? 8 : "8px 8px 0 0", cursor: "pointer", userSelect: "none" }}
                          onClick={() => setCollapsedCats(prev => ({ ...prev, [cat + poNum]: !collapsed }))}>
                          <span style={{ color: "#6B7280", fontSize: 12 }}>{collapsed ? "▶" : "▼"}</span>
                          <span style={{ color: "#94A3B8", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>{cat}</span>
                          <span style={{ color: "#6B7280", fontSize: 11, marginLeft: "auto" }}>{catComplete}/{catMs.length}</span>
                        </div>
                        {!collapsed && (
                          <div style={{ background: "#0F172A", borderRadius: "0 0 8px 8px", overflow: "hidden" }}>
                            {catMs.map(m => {
                              const daysRem = m.expected_date ? Math.ceil((new Date(m.expected_date).getTime() - Date.now()) / 86400000) : null;
                              const daysColor = m.status === "Complete" ? "#10B981" : m.status === "N/A" ? "#6B7280" : daysRem === null ? "#6B7280" : daysRem < 0 ? "#EF4444" : daysRem <= 7 ? "#F59E0B" : "#10B981";
                              return (
                                <div key={m.id} style={{ display: "grid", gridTemplateColumns: "1.5fr 100px 140px 110px 65px", gap: 8, padding: "8px 14px", borderTop: "1px solid #1E293B", alignItems: "center" }}>
                                  <span style={{ color: "#D1D5DB" }}>{m.phase}</span>
                                  <span style={{ color: "#9CA3AF", textAlign: "center" }}>{fmtDate(m.expected_date ?? undefined)}</span>
                                  <input type="date" style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 6, color: "#F1F5F9", fontSize: 13, padding: "5px 6px", width: "100%", boxSizing: "border-box" }}
                                    value={m.actual_date || ""}
                                    onChange={e => {
                                      const val = e.target.value || null;
                                      saveMilestone({ ...m, actual_date: val, status: val ? "Complete" : "Not Started", updated_at: new Date().toISOString(), updated_by: user?.name || "" });
                                    }} />
                                  <select style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 6, color: MILESTONE_STATUS_COLORS[m.status] || "#6B7280", fontSize: 13, padding: "5px 6px", width: "100%", boxSizing: "border-box" }}
                                    value={m.status}
                                    onChange={e => saveMilestone({ ...m, status: e.target.value, updated_at: new Date().toISOString(), updated_by: user?.name || "" })}>
                                    {MILESTONE_STATUSES.map(s => <option key={s} value={s} style={{ color: MILESTONE_STATUS_COLORS[s] }}>{s}</option>)}
                                  </select>
                                  <span style={{ color: daysColor, fontWeight: 600, textAlign: "right" }}>
                                    {m.status === "Complete" ? "Done" : m.status === "N/A" ? "—" : daysRem === null ? "—" : daysRem < 0 ? `${Math.abs(daysRem)}d late` : daysRem === 0 ? "Today" : `${daysRem}d`}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
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
  function emailViewPanel() {
    const OUTLOOK_BLUE = "#0078D4";
    const poList = pos;
    const cfg = emailConfig;

    function getPrefix(poNum: string) { return "[PO-" + poNum + "]"; }

    async function loadPOEmails(poNum: string, olderUrl?: string) {
      if (!emailToken) return;
      const prefix = getPrefix(poNum);
      if (olderUrl) { setEmailLoadingOlder(true); } else { setEmailLoadingMap(l => ({ ...l, [poNum]: true })); }
      setEmailErrorsMap(e => ({ ...e, [poNum]: null }));
      try {
        const url = olderUrl || ("/me/messages?$filter=" + encodeURIComponent("contains(subject,'" + prefix + "')") + "&$top=25&$orderby=receivedDateTime%20desc&$select=id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead,hasAttachments");
        const d = await emailGraph(url);
        const items = d.value || [];
        if (olderUrl) {
          setEmailsMap(m => ({ ...m, [poNum]: [...(m[poNum] || []), ...items] }));
        } else {
          setEmailsMap(m => ({ ...m, [poNum]: items }));
        }
        setEmailNextLinks(nl => ({ ...nl, [poNum]: d["@odata.nextLink"] ? d["@odata.nextLink"].replace("https://graph.microsoft.com/v1.0", "") : null }));
        setEmailLastRefresh(lr => ({ ...lr, [poNum]: Date.now() }));
      } catch (e: any) { setEmailErrorsMap(err => ({ ...err, [poNum]: e.message })); }
      setEmailLoadingMap(l => ({ ...l, [poNum]: false }));
      setEmailLoadingOlder(false);
    }

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
      setEmailTabCur("thread");
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
        setEmailTabCur("inbox");
        if (emailSelPO) setTimeout(() => loadPOEmails(emailSelPO), 2000);
      } catch (e: any) { setEmailSendErr("Failed to send: " + e.message); }
    }

    async function doReply(messageId: string, comment: string) {
      if (!comment.trim()) return;
      setEmailSendErr(null);
      try {
        await emailGraphPost("/me/messages/" + messageId + "/reply", { comment });
        if (emailSelMsg?.conversationId) loadEmailThread(emailSelMsg.conversationId);
      } catch (e: any) { setEmailSendErr("Failed to reply: " + e.message); }
    }

    function saveEmailConfig() {
      setEmailConfig(emailConfigForm);
      try { localStorage.setItem("tandaEmailConfig", JSON.stringify(emailConfigForm)); } catch (_) {}
      setShowEmailConfig(false);
    }

    const selEmails = emailSelPO ? (emailsMap[emailSelPO] || []) : [];
    const isLoadingE = emailSelPO ? !!emailLoadingMap[emailSelPO] : false;
    const eError = emailSelPO ? emailErrorsMap[emailSelPO] : null;

    // Config view
    if (showEmailConfig) return (
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "24px 0" }}>
        <h2 style={{ color: "#F1F5F9", fontSize: 18, fontWeight: 700, marginBottom: 18 }}>Outlook Email Configuration</h2>
        <div style={{ background: "#1E3A5F", border: "1px solid #2563EB44", borderRadius: 10, padding: "12px 16px", marginBottom: 18, fontSize: 12, color: "#93C5FD", lineHeight: 1.6 }}>
          <b>Azure AD Setup:</b> Register an app, enable implicit grant, add <b>Mail.Read</b> and <b>Mail.Send</b> delegated permissions, grant admin consent.
          Redirect URI: <b>{window.location.origin}/auth-callback</b>.
        </div>
        <label style={S.label}>Azure AD Client ID</label>
        <input style={S.input} value={emailConfigForm.clientId} onChange={e => setEmailConfigForm(f => ({ ...f, clientId: e.target.value }))} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
        <div style={{ height: 12 }} />
        <label style={S.label}>Tenant ID</label>
        <input style={S.input} value={emailConfigForm.tenantId} onChange={e => setEmailConfigForm(f => ({ ...f, tenantId: e.target.value }))} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={() => setShowEmailConfig(false)} style={S.btnSecondary}>Cancel</button>
          <button onClick={saveEmailConfig} style={S.btnPrimary}>Save Configuration</button>
        </div>
      </div>
    );

    return (
      <div style={{ position: "relative" }}>
        <button onClick={() => setView("dashboard")} title="Close Email"
          style={{ position: "absolute", top: 10, right: 10, zIndex: 10, width: 28, height: 28, borderRadius: "50%", border: "1px solid " + OUTLOOK_BLUE + "44", background: OUTLOOK_BLUE + "15", color: OUTLOOK_BLUE, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1, transition: "all 0.15s" }}>✕</button>
        <div style={{ display: "flex", height: "calc(100vh - 140px)", minHeight: 500, background: "#1E293B", borderRadius: 12, border: "1px solid #334155", overflow: "hidden" }}>

          {/* LEFT: PO list */}
          <div style={{ width: 280, flexShrink: 0, borderRight: "1px solid #334155", overflowY: "auto", background: "#0F172A", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid #334155", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
              <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6B7280" }}>POs ({poList.length})</span>
              <button onClick={() => { setEmailConfigForm({ ...cfg }); setShowEmailConfig(true); }} style={{ fontSize: 11, padding: "3px 9px", borderRadius: 6, border: "1px solid #334155", background: "none", color: "#6B7280", cursor: "pointer", fontFamily: "inherit" }}>⚙ Config</button>
            </div>
            <div style={{ padding: "8px 16px", borderBottom: "1px solid #334155", flexShrink: 0 }}>
              <input value={emailPOSearch} onChange={e => setEmailPOSearch(e.target.value)} placeholder="🔍 Search PO#, vendor, memo, tags…" style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 6, padding: "7px 10px", color: "#F1F5F9", fontSize: 12, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
            </div>
            <div style={{ padding: "10px 16px", borderBottom: "1px solid #334155", background: emailToken ? "#064E3B44" : "#78350F44", flexShrink: 0 }}>
              {emailToken ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, color: "#34D399", fontWeight: 600 }}>✓ Connected to Outlook</span>
                  <button onClick={() => { setEmailToken(null); setEmailTokenExpiry(null); }} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, border: "1px solid #34D39944", background: "none", color: "#34D399", cursor: "pointer", fontFamily: "inherit" }}>Sign out</button>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 11, color: "#FBBF24", fontWeight: 600, marginBottom: 6 }}>Sign in to load emails</div>
                  {(!cfg.clientId || !cfg.tenantId) ? (
                    <div style={{ fontSize: 11, color: "#D97706" }}>Click "⚙ Config" to enter Azure AD credentials</div>
                  ) : (
                    <button onClick={authenticateEmail} style={{ ...S.btnPrimary, fontSize: 11, padding: "5px 12px", width: "auto" }}>Sign in with Microsoft</button>
                  )}
                </div>
              )}
            </div>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {(() => { const s = emailPOSearch.toLowerCase(); return poList.filter(p => !s || (p.PoNumber ?? "").toLowerCase().includes(s) || (p.VendorName ?? "").toLowerCase().includes(s) || (p.Memo ?? "").toLowerCase().includes(s) || (p.Tags ?? "").toLowerCase().includes(s) || (p.StatusName ?? "").toLowerCase().includes(s)); })().map(po => {
                const poNum = po.PoNumber ?? "";
                const isSelected = emailSelPO === poNum;
                const unread = (emailsMap[poNum] || []).filter((e: any) => !e.isRead).length;
                const color = STATUS_COLORS[po.StatusName ?? ""] ?? "#6B7280";
                return (
                  <div key={poNum} onClick={() => { setEmailSelPO(poNum === emailSelPO ? null : poNum); setEmailTabCur("inbox"); setEmailSelMsg(null); setEmailThreadMsgs([]); if (poNum !== emailSelPO && emailToken) loadPOEmails(poNum); }}
                    style={{ padding: "11px 16px", borderBottom: "1px solid #334155", cursor: "pointer", background: isSelected ? OUTLOOK_BLUE + "18" : "transparent", borderLeft: isSelected ? "3px solid " + OUTLOOK_BLUE : "3px solid transparent", transition: "all 0.12s" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: isSelected ? OUTLOOK_BLUE : "#F1F5F9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: "monospace" }}>{poNum}</div>
                        <div style={{ fontSize: 11, color: "#6B7280" }}>{po.VendorName ?? "Unknown"}</div>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                        {unread > 0 && <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 10, background: OUTLOOK_BLUE, color: "#fff", fontWeight: 700 }}>{unread}</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
              {poList.length === 0 && <div style={{ padding: 24, fontSize: 13, color: "#6B7280", textAlign: "center" }}>No POs loaded — sync first</div>}
            </div>
          </div>

          {/* RIGHT: email panel */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {!emailSelPO ? (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#6B7280" }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>📧</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: "#D1D5DB", marginBottom: 6 }}>Select a PO to view emails</div>
                <div style={{ fontSize: 13 }}>Emails are filtered by subject prefix [PO-{"{number}"}]</div>
              </div>
            ) : (
              <>
                <div style={{ padding: "14px 20px", borderBottom: "1px solid #334155", background: "#1E293B", display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#F1F5F9", fontFamily: "monospace" }}>PO {emailSelPO}</div>
                    <div style={{ fontSize: 12, color: "#6B7280" }}>{pos.find(p => p.PoNumber === emailSelPO)?.VendorName ?? ""} · Prefix: {getPrefix(emailSelPO)}</div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                    {emailLastRefresh[emailSelPO] && <span style={{ fontSize: 10, color: "#6B7280" }}>Updated {Math.round((Date.now() - emailLastRefresh[emailSelPO]) / 1000)}s ago</span>}
                    <button onClick={() => loadPOEmails(emailSelPO)} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #334155", background: "none", color: "#94A3B8", cursor: "pointer", fontFamily: "inherit" }}>↻ Refresh</button>
                  </div>
                </div>

                <div style={{ display: "flex", borderBottom: "1px solid #334155", background: "#1E293B", flexShrink: 0 }}>
                  {(["inbox", "thread", "compose"] as const).map(tab => (
                    <button key={tab} onClick={() => { setEmailTabCur(tab); if (tab === "compose") { setEmailComposeSubject(getPrefix(emailSelPO) + " "); } }}
                      style={{ padding: "9px 18px", border: "none", borderBottom: emailTabCur === tab ? "2px solid " + OUTLOOK_BLUE : "2px solid transparent", background: "none", color: emailTabCur === tab ? OUTLOOK_BLUE : "#6B7280", fontWeight: emailTabCur === tab ? 700 : 500, cursor: "pointer", fontFamily: "inherit", fontSize: 12, textTransform: "capitalize" }}>{tab}</button>
                  ))}
                </div>

                <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
                  {!emailToken ? (
                    <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 40 }}><div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div><div style={{ fontSize: 13 }}>Sign in with Microsoft to view emails</div></div>
                  ) : isLoadingE && emailTabCur === "inbox" ? (
                    <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 40, fontSize: 13 }}>Loading emails…</div>
                  ) : eError && emailTabCur === "inbox" ? (
                    <div style={{ background: "#7F1D1D", border: "1px solid #EF4444", borderRadius: 8, padding: "12px 16px", color: "#FCA5A5", fontSize: 13 }}>⚠ {eError}</div>
                  ) : emailTabCur === "inbox" ? (
                    selEmails.length === 0 ? (
                      <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 40 }}><div style={{ fontSize: 28, marginBottom: 8 }}>📧</div><div style={{ fontSize: 13 }}>No emails matching "{getPrefix(emailSelPO)}"</div></div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {selEmails.map((em: any) => {
                          const sender = (em.from?.emailAddress) ? em.from.emailAddress.name || em.from.emailAddress.address : "Unknown";
                          const initials = sender.split(" ").map((w: string) => w[0] || "").join("").toUpperCase().slice(0, 2);
                          const time = em.receivedDateTime ? new Date(em.receivedDateTime).toLocaleString() : "";
                          return (
                            <div key={em.id} onClick={() => { loadFullEmail(em.id); if (em.conversationId) loadEmailThread(em.conversationId); }}
                              style={{ background: em.isRead ? "#0F172A" : OUTLOOK_BLUE + "15", border: "1px solid " + (em.isRead ? "#334155" : OUTLOOK_BLUE + "44"), borderRadius: 10, padding: "12px 16px", cursor: "pointer", transition: "all 0.12s" }}>
                              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                                <div style={{ width: 34, height: 34, borderRadius: "50%", background: OUTLOOK_BLUE + "22", border: "2px solid " + OUTLOOK_BLUE, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: OUTLOOK_BLUE, flexShrink: 0 }}>{initials}</div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
                                    <span style={{ fontSize: 13, fontWeight: em.isRead ? 500 : 700, color: "#F1F5F9" }}>{sender}</span>
                                    <span style={{ fontSize: 11, color: "#6B7280" }}>{time}</span>
                                    {em.hasAttachments && <span style={{ fontSize: 11, color: "#6B7280" }}>📎</span>}
                                    {!em.isRead && <span style={{ width: 8, height: 8, borderRadius: "50%", background: OUTLOOK_BLUE, flexShrink: 0 }} />}
                                  </div>
                                  <div style={{ fontSize: 13, fontWeight: em.isRead ? 400 : 600, color: "#E2E8F0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{em.subject}</div>
                                  <div style={{ fontSize: 12, color: "#6B7280", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>{em.bodyPreview || ""}</div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                        {emailNextLinks[emailSelPO] && (
                          <button onClick={() => loadPOEmails(emailSelPO, emailNextLinks[emailSelPO]!)} disabled={emailLoadingOlder} style={{ ...S.btnPrimary, opacity: emailLoadingOlder ? 0.6 : 1, fontSize: 12 }}>{emailLoadingOlder ? "Loading…" : "Load older emails"}</button>
                        )}
                      </div>
                    )
                  ) : emailTabCur === "thread" ? (
                    <div>
                      {emailThreadLoading ? (
                        <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 24, fontSize: 13 }}>Loading thread…</div>
                      ) : emailThreadMsgs.length === 0 ? (
                        <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 40, fontSize: 13 }}>Click an email to view its conversation thread</div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
                          {emailThreadMsgs.map((msg: any) => {
                            const sender = (msg.from?.emailAddress) ? msg.from.emailAddress.name || msg.from.emailAddress.address : "Unknown";
                            const initials = sender.split(" ").map((w: string) => w[0] || "").join("").toUpperCase().slice(0, 2);
                            const time = msg.receivedDateTime ? new Date(msg.receivedDateTime).toLocaleString() : "";
                            const htmlBody = (msg.body?.content) || "";
                            return (
                              <div key={msg.id} style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 10, padding: "14px 18px" }}>
                                <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 10 }}>
                                  <div style={{ width: 30, height: 30, borderRadius: "50%", background: OUTLOOK_BLUE + "22", border: "2px solid " + OUTLOOK_BLUE, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: OUTLOOK_BLUE, flexShrink: 0 }}>{initials}</div>
                                  <div style={{ flex: 1 }}>
                                    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                                      <span style={{ fontSize: 13, fontWeight: 700, color: "#F1F5F9" }}>{sender}</span>
                                      <span style={{ fontSize: 11, color: "#6B7280" }}>{time}</span>
                                    </div>
                                    <div style={{ fontSize: 12, color: "#6B7280" }}>{msg.subject}</div>
                                  </div>
                                </div>
                                <iframe sandbox="allow-same-origin" srcDoc={htmlBody} style={{ width: "100%", border: "none", minHeight: 100, borderRadius: 6, background: "#F8FAFC" }}
                                  onLoad={e => { try { const h = (e.target as HTMLIFrameElement).contentDocument!.body.scrollHeight; (e.target as HTMLIFrameElement).style.height = Math.min(h + 20, 400) + "px"; } catch (_) {} }} />
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {emailSelMsg && (
                        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                          <input value={emailReply} onChange={e => setEmailReply(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doReply(emailSelMsg.id, emailReply); setEmailReply(""); } }} placeholder="Write a reply…" style={{ ...S.input, flex: 1 }} />
                          <button onClick={() => { doReply(emailSelMsg.id, emailReply); setEmailReply(""); }} style={{ ...S.btnPrimary, width: "auto", padding: "10px 20px" }}>Reply</button>
                        </div>
                      )}
                    </div>
                  ) : emailTabCur === "compose" ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      <div>
                        <label style={S.label}>To (comma-separated)</label>
                        <input value={emailComposeTo} onChange={e => setEmailComposeTo(e.target.value)} placeholder="email@example.com" style={S.input} />
                      </div>
                      <div>
                        <label style={S.label}>Subject</label>
                        <input value={emailComposeSubject} onChange={e => setEmailComposeSubject(e.target.value)} style={S.input} />
                      </div>
                      <div>
                        <label style={S.label}>Body</label>
                        <textarea value={emailComposeBody} onChange={e => setEmailComposeBody(e.target.value)} rows={10} style={{ ...S.textarea, minHeight: 150 }} placeholder="Type your message…" />
                      </div>
                      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                        <button onClick={() => setEmailTabCur("inbox")} style={S.btnSecondary}>Cancel</button>
                        <button onClick={doSendEmail} disabled={!emailComposeTo.trim() || !emailComposeSubject.trim()} style={{ ...S.btnPrimary, width: "auto", opacity: (!emailComposeTo.trim() || !emailComposeSubject.trim()) ? 0.5 : 1 }}>Send Email</button>
                      </div>
                    </div>
                  ) : null}
                </div>

                {emailToken && emailSelPO && emailTabCur === "inbox" && (
                  <div style={{ borderTop: "1px solid #334155", background: "#1E293B", flexShrink: 0 }}>
                    {emailSendErr && (
                      <div style={{ padding: "6px 20px", background: "#7F1D1D", borderBottom: "1px solid #EF4444", display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 12, color: "#FCA5A5", flex: 1 }}>⚠ {emailSendErr}</span>
                        <button onClick={() => setEmailSendErr(null)} style={{ fontSize: 11, border: "none", background: "none", color: "#FCA5A5", cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>✕</button>
                      </div>
                    )}
                    <div style={{ padding: "10px 20px", display: "flex", gap: 8, alignItems: "center" }}>
                      <button onClick={() => { setEmailTabCur("compose"); setEmailComposeSubject(getPrefix(emailSelPO) + " "); }} style={{ ...S.btnPrimary, width: "auto", fontSize: 11, padding: "7px 14px" }}>+ New Email</button>
                      <span style={{ fontSize: 11, color: "#6B7280" }}>{selEmails.length} email{selEmails.length !== 1 ? "s" : ""}</span>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
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
          <button style={view === "list"      ? S.navBtnActive : S.navBtn} onClick={() => { setSelected(null); setView("list"); }}>All POs</button>
          <button style={view === "templates" ? S.navBtnActive : S.navBtn} onClick={() => { setSelected(null); setView("templates"); }}>Templates</button>
          <button style={view === "email" ? S.navBtnActive : S.navBtn} onClick={() => { setSelected(null); setView("email"); }}>📧 Email</button>
          <button style={S.navBtn} onClick={() => { setShowSyncModal(true); loadVendors(); }} disabled={syncing} title="Sync POs from Xoro">
            {syncing ? "⏳ Syncing…" : "🔄 Sync"}
          </button>
          {syncing && (
            <button style={{ ...S.navBtn, color: "#EF4444", borderColor: "#EF4444" }} onClick={cancelSync} title="Cancel sync">
              ✕ Cancel
            </button>
          )}
          <button style={S.navBtn} onClick={() => setShowSettings(true)}>⚙️ Settings</button>
          <div style={S.userPill}>{user.name || user.username}</div>
          <button style={S.navBtn} onClick={() => window.location.href = "/"}>← PLM</button>
          <button style={S.navBtnDanger} onClick={() => { sessionStorage.removeItem("plm_user"); window.location.href = "/"; }}>Sign Out</button>
        </div>
      </nav>

      {/* SYNC ERROR */}
      {syncErr && (
        <div style={S.errBanner}>
          ⚠️ Xoro sync error: {syncErr}
          <button style={{ marginLeft: 12, color: "#FCA5A5", background: "none", border: "none", cursor: "pointer" }} onClick={() => setSyncErr("")}>✕</button>
        </div>
      )}

      <div style={S.content}>
        {/* ── DASHBOARD ── */}
        {view === "dashboard" && (
          <>
            {/* Stats */}
            <div style={S.statsRow}>
              <StatCard label="Total POs"       value={pos.length}                        color="#3B82F6" icon="📋" />
              <StatCard label="Total Value"     value={fmtCurrency(totalValue)}            color="#10B981" icon="💰" />
              <StatCard label="Overdue"         value={overdue}                            color="#EF4444" icon="⚠️" />
              <StatCard label="Due This Week"   value={dueThisWeek}                        color="#F59E0B" icon="📅" />
            </div>

            {/* Milestone Stats */}
            <div style={S.statsRow}>
              <StatCard label="Overdue Milestones"  value={overdueMilestones.length}      color="#EF4444" icon="🚨" />
              <StatCard label="Due This Week"       value={dueThisWeekMilestones.length}   color="#F59E0B" icon="📌" />
              <StatCard label="Completion Rate"     value={`${milestoneCompletionRate}%`}   color="#10B981" icon="📊" />
              <StatCard label="Total Milestones"    value={allMilestonesList.length}        color="#8B5CF6" icon="🏭" />
            </div>

            {/* Upcoming Milestones */}
            {upcomingMilestones.length > 0 && (
              <div style={S.card}>
                <h3 style={S.cardTitle}>Upcoming Milestones</h3>
                <div style={{ fontSize: 12 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 100px 80px 70px", padding: "8px 12px", color: "#6B7280", fontWeight: 600, borderBottom: "1px solid #334155", textTransform: "uppercase", letterSpacing: 1, fontSize: 10 }}>
                    <span>PO #</span><span>Phase</span><span>Expected</span><span>Status</span><span>Days</span>
                  </div>
                  {upcomingMilestones.map(m => {
                    const daysRem = m.expected_date ? Math.ceil((new Date(m.expected_date).getTime() - Date.now()) / 86400000) : null;
                    return (
                      <div key={m.id} style={{ display: "grid", gridTemplateColumns: "120px 1fr 100px 80px 70px", padding: "8px 12px", borderBottom: "1px solid #1E293B", cursor: "pointer", alignItems: "center" }}
                        onClick={() => { const p = pos.find(x => x.PoNumber === m.po_number); if (p) { setDetailMode("milestones"); setNewNote(""); setSelected(p); } }}>
                        <span style={{ color: "#60A5FA", fontFamily: "monospace", fontSize: 11 }}>{m.po_number}</span>
                        <span style={{ color: "#D1D5DB" }}>{m.phase}</span>
                        <span style={{ color: "#9CA3AF" }}>{fmtDate(m.expected_date ?? undefined)}</span>
                        <span style={{ color: MILESTONE_STATUS_COLORS[m.status] || "#6B7280", fontSize: 11 }}>{m.status}</span>
                        <span style={{ color: daysRem !== null && daysRem <= 7 ? "#F59E0B" : "#10B981", fontWeight: 600, textAlign: "right" }}>
                          {daysRem !== null ? `${daysRem}d` : "—"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Overdue Milestones */}
            {overdueMilestones.length > 0 && (
              <div style={S.card}>
                <h3 style={{ ...S.cardTitle, color: "#EF4444" }}>Overdue Milestones</h3>
                <div style={{ fontSize: 12 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 100px 80px 70px", padding: "8px 12px", color: "#6B7280", fontWeight: 600, borderBottom: "1px solid #334155", textTransform: "uppercase", letterSpacing: 1, fontSize: 10 }}>
                    <span>PO #</span><span>Phase</span><span>Expected</span><span>Status</span><span>Days Late</span>
                  </div>
                  {overdueMilestones.sort((a, b) => (a.expected_date ?? "").localeCompare(b.expected_date ?? "")).slice(0, 15).map(m => {
                    const daysLate = m.expected_date ? Math.abs(Math.ceil((new Date(m.expected_date).getTime() - Date.now()) / 86400000)) : 0;
                    return (
                      <div key={m.id} style={{ display: "grid", gridTemplateColumns: "120px 1fr 100px 80px 70px", padding: "8px 12px", borderBottom: "1px solid #1E293B", cursor: "pointer", alignItems: "center" }}
                        onClick={() => { const p = pos.find(x => x.PoNumber === m.po_number); if (p) { setDetailMode("milestones"); setNewNote(""); setSelected(p); } }}>
                        <span style={{ color: "#60A5FA", fontFamily: "monospace", fontSize: 11 }}>{m.po_number}</span>
                        <span style={{ color: "#D1D5DB" }}>{m.phase}</span>
                        <span style={{ color: "#9CA3AF" }}>{fmtDate(m.expected_date ?? undefined)}</span>
                        <span style={{ color: MILESTONE_STATUS_COLORS[m.status] || "#6B7280", fontSize: 11 }}>{m.status}</span>
                        <span style={{ color: "#EF4444", fontWeight: 600, textAlign: "right" }}>{daysLate}d</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Status breakdown */}
            <div style={S.card}>
              <h3 style={S.cardTitle}>POs by Status</h3>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {STATUS_OPTIONS.map(s => {
                  const count = pos.filter(p => p.StatusName === s).length;
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

            {/* Recent POs */}
            <div style={S.card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h3 style={S.cardTitle}>Recent Purchase Orders</h3>
                <button style={S.btnSecondary} onClick={() => setView("list")}>View All →</button>
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
              {pos.slice(0, 8).map((po, i) => <PORow key={i} po={po} onClick={() => { setDetailMode("milestones"); setNewNote(""); setSelected(po); }} />)}
            </div>
          </>
        )}

        {/* ── ALL POs ── */}
        {view === "list" && (
          <>
            <div style={S.filters}>
              <input style={{ ...S.input, flex: 1, marginBottom: 0 }} placeholder="🔍 Search PO#, vendor, memo, tags…"
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
              {filtered.map((po, i) => <PORow key={i} po={po} onClick={() => { setDetailMode("milestones"); setNewNote(""); setSelected(po); }} detailed />)}
            </div>
          </>
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
                      onClick={() => { if (window.confirm(`Delete template for "${tplVendor}"? POs will fall back to default.`)) { deleteVendorTemplate(tplVendor); setTplVendor("__default__"); } }}>
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
                            onClick={() => { if (window.confirm(`Delete "${tpl.phase}"?`)) saveVendorTemplates(tplVendor, currentTemplates.filter(t => t.id !== tpl.id)); }}>✕</button>
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

        {/* ── EMAIL ── */}
        {view === "email" && emailViewPanel()}
      </div>

      {selected      && DetailPanel()}
      {showSettings  && <SettingsModal />}
      {showSyncModal && <SyncModal />}
    </div>
  );

  function StatCard({ label, value, color, icon }: { label: string; value: string | number; color: string; icon: string }) {
    return (
      <div style={{ ...S.statCard, borderTop: `3px solid ${color}` }}>
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
    const msTotal = poMs.length;
    const msOverdue = poMs.some(m => m.expected_date && m.expected_date < today && m.status !== "Complete" && m.status !== "N/A");
    const msApproaching = poMs.some(m => m.expected_date && m.expected_date >= today && m.expected_date <= weekFromNow && m.status !== "Complete" && m.status !== "N/A");
    const msDotColor = msTotal === 0 ? "#6B7280" : msOverdue ? "#EF4444" : msApproaching ? "#F59E0B" : "#10B981";
    const msPercent = msTotal > 0 ? Math.round((msComplete / msTotal) * 100) : 0;
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
        {/* Milestone mini-progress */}
        {msTotal > 0 && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, minWidth: 60 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: msDotColor }} />
              <span style={{ color: "#9CA3AF", fontSize: 11, fontFamily: "monospace" }}>{msComplete}/{msTotal}</span>
            </div>
            <div style={{ width: 48, height: 4, background: "#334155", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ width: `${msPercent}%`, height: "100%", background: msDotColor, borderRadius: 2, transition: "width 0.3s" }} />
            </div>
          </div>
        )}
        <div style={{ textAlign: "right", minWidth: 160 }}>
          <div style={{ color: "#10B981", fontWeight: 700, fontSize: 16 }}>{fmtCurrency(total, po.CurrencyCode)}</div>
          {detailed && <div style={{ color: "#6B7280", fontSize: 12 }}>{items.length} line items</div>}
          <div style={{ color: "#9CA3AF", fontSize: 12, marginTop: 4 }}>
            Exp: {fmtDate(po.DateExpectedDelivery)}
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

  content:    { maxWidth: 1200, margin: "0 auto", padding: "24px 20px" },
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
