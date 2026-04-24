import React, { useState, useEffect, useRef, useCallback } from "react";
import { msSignIn, loadMsTokens, saveMsTokens, clearMsTokens, getMsAccessToken, MS_CLIENT_ID, MS_TENANT_ID } from "./utils/msAuth";
import { styledEmailHtml } from "./utils/emailHtml";
// v2026-03-24b

// ── Supabase ─────────────────────────────────────────────────────────────────
import { SB_URL, SB_KEY, SB_HEADERS, supabaseClient } from "./utils/supabase";
import NotificationsShell from "./components/notifications/NotificationsShell";

// ── Supabase helpers ──────────────────────────────────────────────────────────
const sb = {
  from: (table: string) => ({
    select: async (cols = "*", filter = "") => {
      const res = await fetch(`${SB_URL}/rest/v1/${table}?select=${cols}${filter ? "&" + filter : ""}`, { headers: SB_HEADERS });
      const data = await res.json();
      return { data, error: res.ok ? null : data };
    },
    upsert: async (rows: any) => {
      const body = Array.isArray(rows) ? rows : [rows];
      const res = await fetch(`${SB_URL}/rest/v1/${table}`, { method: "POST", headers: { ...SB_HEADERS, "Prefer": "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
      const data = await res.json();
      return { data, error: res.ok ? null : data };
    },
    delete: async (filter: string) => {
      const res = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, { method: "DELETE", headers: SB_HEADERS });
      return { error: res.ok ? null : await res.json() };
    },
  }),
};

// ── Types ─────────────────────────────────────────────────────────────────────
interface User { name?: string; username?: string; avatar?: string; color?: string; initials?: string; role?: string; }

interface Measurement { id: string; pointOfMeasure: string; tolerance: string; sizes: Record<string, string>; }
interface ConstructionDetail { id: string; area: string; detail: string; notes: string; refImages: string[]; }

interface Colorway { id: string; name: string; }
interface BOMColorSpec { colorwayId: string; color: string; pantone: string; trialSize: string; }

interface SketchCallout { id: string; number: number; description: string; }
interface FlatSketch { frontImage: string | null; backImage: string | null; callouts: SketchCallout[]; stitchingDetails: string; measurementNote: string; }
interface BOMItem { id: string; materialNo: string; material: string; placement: string; content: string; weight: string; quantity: string; uom: string; supplier: string; unitCost: number; totalCost: number; notes: string; image: string | null; colorSpecs: BOMColorSpec[]; }
interface Costing { fob: number; duty: number; dutyRate: number; freight: number; insurance: number; otherCosts: number; landedCost: number; wholesalePrice: number; retailPrice: number; margin: number; notes: string; }
interface Approval { id: string; stage: string; approver: string; status: "Pending" | "Approved" | "Rejected" | "Revision Required"; date: string | null; comments: string; }
interface Sample { id: string; type: "Proto" | "SMS" | "PP" | "TOP" | "Production"; status: "Requested" | "In Progress" | "Received" | "Approved" | "Rejected"; requestDate: string; receiveDate: string | null; vendor: string; comments: string; images: string[]; }
interface TPImage { id: string; url: string; name: string; type: string; }

interface TechPack {
  id: string; styleName: string; styleNumber: string; brand: string; season: string; category: string; subCategory: string; description: string; designer: string;
  gender: string; vendor: string; techDesigner: string; graphicArtist: string; productDeveloper: string;
  division: string; owner: string; active: boolean; version: number;
  status: "Draft" | "In Review" | "Approved" | "Revised";
  createdAt: string; updatedAt: string; updatedBy: string;
  colorways: Colorway[];
  flatSketch: FlatSketch;
  measurements: Measurement[]; construction: ConstructionDetail[]; bom: BOMItem[];
  costing: Costing; approvals: Approval[]; samples: Sample[]; images: TPImage[];
}

interface Material {
  id: string; name: string; type: string; composition: string; weight: string; width: string; color: string;
  supplier: string; unitPrice: number; moq: string; leadTime: string; certifications: string[]; notes: string; createdAt: string;
}

interface SpecSheetRow { id: string; pointOfMeasure: string; tolerance: string; values: Record<string, string>; isSection?: boolean; }
interface SpecSheet { id: string; styleName: string; styleNumber: string; brand: string; season: string; category: string; subCategory?: string; gender?: string; vendor?: string; description: string; sizes: string[]; rows: SpecSheetRow[]; createdAt: string; updatedAt: string; }
interface SpecTemplate { id: string; name: string; category: string; description: string; sizes: string[]; rows: SpecSheetRow[]; createdAt: string; isBuiltin?: boolean; }

type View = "dashboard" | "list" | "detail" | "libraries" | "samples" | "teams" | "email";
type DetailTab = "sketch" | "spec" | "construction" | "bom" | "costing" | "approvals" | "samples" | "images";

// ── Helpers ───────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const today = () => new Date().toISOString().split("T")[0];
const fmtDate = (d: string | null) => { if (!d) return "—"; try { const dt = new Date(d); return dt.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }); } catch { return d; } };
const fmtCurrency = (n: number) => "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const STATUSES: TechPack["status"][] = ["Draft", "In Review", "Approved", "Revised"];
const STATUS_COLORS: Record<string, string> = { Draft: "#6B7280", "In Review": "#F59E0B", Approved: "#10B981", Revised: "#8B5CF6" };
const APPROVAL_STAGES = ["Design", "Merchandising", "Buying", "Production", "Quality"];
const APPROVAL_STATUS_COLORS: Record<string, string> = { Pending: "#6B7280", Approved: "#10B981", Rejected: "#EF4444", "Revision Required": "#F59E0B" };
const SAMPLE_TYPES: Sample["type"][] = ["Proto", "SMS", "PP", "TOP", "Production"];
const SAMPLE_STATUS_COLORS: Record<string, string> = { Requested: "#6B7280", "In Progress": "#3B82F6", Received: "#F59E0B", Approved: "#10B981", Rejected: "#EF4444" };
const MATERIAL_TYPES = ["Fabric", "Trim", "Label", "Thread", "Zipper", "Button", "Elastic", "Interlining", "Packaging", "Other"];
const CW_COLORS = ["#3B82F6", "#10B981", "#F59E0B", "#8B5CF6", "#EF4444", "#06B6D4", "#F97316", "#EC4899"];
const CATEGORIES = ["Tops", "Bottoms", "Dresses", "Outerwear", "Activewear", "Swimwear", "Accessories", "Other"];
const SEASONS = ["Spring 2025", "Summer 2025", "Fall 2025", "Winter 2025", "Spring 2026", "Summer 2026", "Fall 2026", "Winter 2026", "Resort 2025", "Resort 2026"];
const DEFAULT_SIZES = ["XS", "S", "M", "L", "XL", "XXL"];

function emptyCosting(): Costing {
  return { fob: 0, duty: 0, dutyRate: 0, freight: 0, insurance: 0, otherCosts: 0, landedCost: 0, wholesalePrice: 0, retailPrice: 0, margin: 0, notes: "" };
}

function emptyApprovals(): Approval[] {
  return APPROVAL_STAGES.map(stage => ({ id: uid(), stage, approver: "", status: "Pending" as const, date: null, comments: "" }));
}

function emptyTechPack(user: User): TechPack {
  return {
    id: uid(), styleName: "", styleNumber: "", brand: "", season: "", category: "", subCategory: "", description: "", designer: user.name || user.username || "",
    gender: "", vendor: "", techDesigner: "", graphicArtist: "", productDeveloper: "",
    division: "", owner: "", active: true, version: 1,
    status: "Draft", createdAt: today(), updatedAt: today(), updatedBy: user.name || user.username || "",
    colorways: [], flatSketch: { frontImage: null, backImage: null, callouts: [], stitchingDetails: "", measurementNote: "" },
    measurements: [], construction: [], bom: [], costing: emptyCosting(), approvals: emptyApprovals(), samples: [], images: [],
  };
}

// ── Built-in Templates ────────────────────────────────────────────────────────
const _JS = ["28","29","30","31","32","33","34","35","36","38","40","42","44","46","48"];
const _mkR = (id: string, pom: string, desc: string, tol: string): SpecSheetRow => ({ id, pointOfMeasure: `${pom}  ${desc}`, tolerance: tol, values: Object.fromEntries(_JS.map(s => [s, ""])) });
const _mkS = (id: string, name: string): SpecSheetRow => ({ id, pointOfMeasure: name, tolerance: "", values: {}, isSection: true });
const BUILTIN_TEMPLATES: SpecTemplate[] = [
  {
    id: "builtin-mens-jeans-1",
    name: "Men's Jeans",
    category: "Bottoms",
    description: "Men's Baggy Jeans — 24 POMs across 6 sections (Waist/Rise, Hip/Thigh, Inseam/Leg, Waistband, Front Pockets, Back Pockets/Yoke)",
    sizes: _JS,
    isBuiltin: true,
    createdAt: "2026-01-01",
    rows: [
      _mkS("bt-s1", "① BODY — WAIST & RISE"),
      _mkR("bt-r1",  "A",  "Waist Along Top Edge",                   "1/2\""),
      _mkR("bt-r2",  "H",  "Front Rise Incl. Waistband",             "1/4\""),
      _mkS("bt-s2", "② HIP & THIGH"),
      _mkR("bt-r4",  "B",  "Low Hip — 6\" Below Waistband",          "1/2\""),
      _mkR("bt-r5",  "C",  "Thigh — 1\" Below Crotch",               "1/4\""),
      _mkS("bt-s3", "③ INSEAM & LEG"),
      _mkR("bt-r7",  "E",  "Knee — 15\" Below Crotch",               "1/4\""),
      _mkR("bt-r8",  "F",  "Inseam",                                 "1/4\""),
      _mkS("bt-s4", "④ WAISTBAND DETAILS"),
      _mkR("bt-r10", "J",  "Waistband Height",                       "1/8\""),
      _mkR("bt-r11", "K",  "Fly J-Stitch Length",                    "1/8\""),
      _mkR("bt-r12", "N",  "Zipper Length (Fly)",                    "1/8\""),
      _mkS("bt-s5", "⑤ FRONT POCKETS"),
      _mkR("bt-r14", "O",  "Front Pocket Opening (Horiz @ WB)",      "1/8\""),
      _mkR("bt-r15", "P",  "Front Pocket Opening (Vert @ SS)",       "1/8\""),
      _mkR("bt-r16", "Q",  "Front Pocket Bag Depth",                 "1/8\""),
      _mkR("bt-r17", "Q",  "Front Pocket Bag Width",                 "1/8\""),
      _mkR("bt-r18", "R",  "Coin Pocket Placement from WB Seam",     "1/8\""),
      _mkR("bt-r19", "L",  "Coin Pocket Placement from SS",          "1/8\""),
      _mkS("bt-s6", "⑥ BACK POCKETS & YOKE"),
      _mkR("bt-r21", "U",  "BK Pocket Spread (Apart)",               "1/8\""),
      _mkR("bt-r22", "V",  "Back Yoke Height at CB",                 "1/8\""),
      _mkR("bt-r23", "W",  "Back Yoke Height at SS",                 "1/8\""),
      _mkR("bt-r24", "X",  "BK Pocket Placement from WB — CB",       "1/8\""),
      _mkR("bt-r25", "Y",  "BK Pocket Placement from WB — SS",       "1/8\""),
      _mkR("bt-r26", "Z",  "Back Pocket Height at Center",           "1/8\""),
      _mkR("bt-r27", "AA", "Back Pocket Height at Sides",            "1/8\""),
      _mkR("bt-r28", "BB", "Back Pocket Width at Top",               "1/8\""),
      _mkR("bt-r29", "CC", "Back Pocket Width at Bottom",            "1/8\""),
    ],
  },
];

// ══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════════════════════════════════
export default function TechPackApp() {
  // ── User session ──────────────────────────────────────────────────────────
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    try { const saved = sessionStorage.getItem("plm_user"); if (saved) setUser(JSON.parse(saved)); } catch {}
  }, []);

  // ── Load XLSX library dynamically ─────────────────────────────────────────
  useEffect(() => {
    if ((window as any).XLSX) return;
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.min.js";
    document.head.appendChild(s);
  }, []);

  // ── State ─────────────────────────────────────────────────────────────────
  const [view, setView] = useState<View>("dashboard");
  const [techPacks, setTechPacks] = useState<TechPack[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [selected, setSelected] = useState<TechPack | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("spec");
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterBrand, setFilterBrand] = useState("");
  const [filterSeason, setFilterSeason] = useState("");
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showMaterialModal, setShowMaterialModal] = useState(false);
  const [editingMaterial, setEditingMaterial] = useState<Material | null>(null);
  const [lightboxImg, setLightboxImg] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [matSearch, setMatSearch] = useState("");
  const [matTypeFilter, setMatTypeFilter] = useState("");
  const [specSheets, setSpecSheets] = useState<SpecSheet[]>([]);
  const [libTab, setLibTab] = useState<"materials" | "specsheets">("materials");
  const [showSpecSheetModal, setShowSpecSheetModal] = useState(false);
  const [editingSpecSheet, setEditingSpecSheet] = useState<SpecSheet | null>(null);
  const [selectedSpecSheet, setSelectedSpecSheet] = useState<SpecSheet | null>(null);
  const [ssForm, setSsForm] = useState({ styleName: "", styleNumber: "", brand: "", season: "", category: "", subCategory: "", gender: "", vendor: "", description: "", sizes: "XS, S, M, L, XL, XXL" });
  const [ssSearch, setSsSearch] = useState("");
  const [showAddImportMenu, setShowAddImportMenu] = useState(false);
  const [newSize, setNewSize] = useState("");
  const [showAddSize, setShowAddSize] = useState(false);
  const [newSizeInput, setNewSizeInput] = useState("");
  const [showNewSizeInput, setShowNewSizeInput] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);
  const [specTemplates, setSpecTemplates] = useState<SpecTemplate[]>([]);
  const [showTemplatesModal, setShowTemplatesModal] = useState(false);
  const [activeTemplate, setActiveTemplate] = useState<SpecTemplate | null>(null);

  // ── Teams + Email state ────────────────────────────────────────────────────
  const TEAMS_PURPLE = "#5b5ea6";
  const TEAMS_PURPLE_LT = "#7b83eb";
  const OUTLOOK_BLUE = "#0078D4";
  const [msToken, setMsToken] = useState<string | null>(() => {
    try { const s = JSON.parse(localStorage.getItem("ms_tokens_v1") || "null"); if (s?.accessToken && s.expiresAt > Date.now()) return s.accessToken; } catch (_) {}
    return null;
  });
  const [msDisplayName, setMsDisplayName] = useState<string>("");
  const teamsToken = msToken;
  const emailToken = msToken;
  const [teamsChannelMap, setTeamsChannelMap] = useState<Record<string, { channelId: string; teamId: string }>>({});
  const [teamsTeamId, setTeamsTeamId] = useState("");
  const [teamsSelTP, setTeamsSelTP] = useState<string | null>(null);
  const [teamsMessages, setTeamsMessages] = useState<Record<string, any[]>>({});
  const [teamsLoading, setTeamsLoading] = useState<Record<string, boolean>>({});
  const [teamsCreating, setTeamsCreating] = useState<string | null>(null);
  const [teamsNewMsg, setTeamsNewMsg] = useState("");
  const [teamsAuthStatus, setTeamsAuthStatus] = useState<"idle"|"loading"|"error">("idle");
  const [teamsSearch, setTeamsSearch] = useState("");
  const [teamsDirectTo, setTeamsDirectTo] = useState("");
  const [teamsDirectMsg, setTeamsDirectMsg] = useState("");
  const [teamsDirectSending, setTeamsDirectSending] = useState(false);
  const [teamsDirectErr, setTeamsDirectErr] = useState<string | null>(null);
  const [teamsTab, setTeamsTab] = useState<"channels"|"direct">("channels");
  const [dmChatId, setDmChatId] = useState<string | null>(null);
  const [dmRecipient, setDmRecipient] = useState("");
  const [dmMessages, setDmMessages] = useState<any[]>([]);
  const [dmLoading, setDmLoading] = useState(false);
  const [dmError, setDmError] = useState<string | null>(null);
  const [dmNewMsg, setDmNewMsg] = useState("");
  const [dmSending, setDmSending] = useState(false);
  const dmScrollRef = useRef<HTMLDivElement>(null);
  const [emailAuthStatus, setEmailAuthStatus] = useState<"idle"|"loading"|"error">("idle");
  const [emailSelTP, setEmailSelTP] = useState<string | null>(null);
  const [emailsMap, setEmailsMap] = useState<Record<string, any[]>>({});
  const [emailLoadingMap, setEmailLoadingMap] = useState<Record<string, boolean>>({});
  const [emailNextLinks, setEmailNextLinks] = useState<Record<string, string | null>>({});
  const [emailSelMsg, setEmailSelMsg] = useState<any>(null);
  const [emailThreadMsgs, setEmailThreadMsgs] = useState<any[]>([]);
  const [emailThreadLoading, setEmailThreadLoading] = useState(false);
  const [emailTabCur, setEmailTabCur] = useState<"inbox"|"thread"|"compose">("inbox");
  const [emailComposeTo, setEmailComposeTo] = useState("");
  const [emailComposeSubject, setEmailComposeSubject] = useState("");
  const [emailComposeBody, setEmailComposeBody] = useState("");
  const [emailSendErr, setEmailSendErr] = useState<string | null>(null);
  const [emailReply, setEmailReply] = useState("");
  const [emailSearch, setEmailSearch] = useState("");
  const [emailLoadingOlder, setEmailLoadingOlder] = useState(false);
  // ── New 3-panel email UI state ─────────────────────────────────────────────
  const [tpActiveFolder, setTpActiveFolder] = useState<"inbox" | "sent">("inbox");
  const [tpSearchQuery, setTpSearchQuery] = useState("");
  const [tpFilterUnread, setTpFilterUnread] = useState(false);
  const [tpFilterFlagged, setTpFilterFlagged] = useState(false);
  const [tpFlaggedSet, setTpFlaggedSet] = useState(new Set<string>());
  const [tpCollapsedMsgs, setTpCollapsedMsgs] = useState(new Set<string>());
  const [tpComposeOpen, setTpComposeOpen] = useState(false);
  const [tpDeleteConfirm, setTpDeleteConfirm] = useState<string | null>(null);
  const [tpSelectedEmailId, setTpSelectedEmailId] = useState<string | null>(null);
  const [tpSentEmails, setTpSentEmails] = useState<Record<string, any[]>>({});
  const [tpSentLoading, setTpSentLoading] = useState<Record<string, boolean>>({});
  const [tpReplyText, setTpReplyText] = useState("");
  const [tpCtxMenu, setTpCtxMenu] = useState<{ x: number; y: number; em: any } | null>(null);
  const [tpEmailAttachments, setTpEmailAttachments] = useState<Record<string, any[]>>({});
  const [tpEmailAttachmentsLoading, setTpEmailAttachmentsLoading] = useState<Record<string, boolean>>({});

  // ── Design Calendar reference data ────────────────────────────────────────
  const [dcBrands, setDcBrands] = useState<any[]>([]);
  const [dcSeasons, setDcSeasons] = useState<string[]>([]);
  const [dcTeam, setDcTeam] = useState<any[]>([]);
  const [dcGenders, setDcGenders] = useState<string[]>([]);
  const [dcCategories, setDcCategories] = useState<any[]>([]);
  const [dcVendors, setDcVendors] = useState<any[]>([]);
  const [openTeamDrop, setOpenTeamDrop] = useState<string | null>(null); // which team dropdown is open

  // ── Create form state ─────────────────────────────────────────────────────
  const [createForm, setCreateForm] = useState({ styleNumber: "", styleName: "", brand: "", season: "", category: "", subCategory: "", gender: "", description: "", designer: "", techDesigner: "", graphicArtist: "", productDeveloper: "", vendor: "" });

  // ── Material form state ───────────────────────────────────────────────────
  const [matForm, setMatForm] = useState({ name: "", type: "Fabric", composition: "", weight: "", width: "", color: "", supplier: "", unitPrice: 0, moq: "", leadTime: "", certifications: "", notes: "" });

  // ── Toast helper ──────────────────────────────────────────────────────────
  const showToast = useCallback((msg: string) => { setToast(msg); setTimeout(() => setToast(""), 3000); }, []);

  // ── DC reference data helpers ─────────────────────────────────────────────
  const dcLoad = useCallback(async (key: string) => {
    const res = await sb.from("app_data").select("*", `key=eq.${key}`);
    if (res.data && Array.isArray(res.data) && res.data.length > 0 && res.data[0].value) {
      try { return JSON.parse(res.data[0].value); } catch {}
    }
    return null;
  }, []);

  const dcSave = useCallback(async (key: string, value: any) => {
    await sb.from("app_data").upsert({ key, value: JSON.stringify(value) });
  }, []);

  // ── Load data ─────────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [tpRes, matRes, ssRes, tmplRes, brands, seasons, team, genders, categories, vendors] = await Promise.all([
        sb.from("techpacks").select(),
        sb.from("app_data").select("*", "key=eq.techpack_materials"),
        sb.from("app_data").select("*", "key=eq.techpack_specsheets"),
        sb.from("app_data").select("*", "key=eq.techpack_spec_templates"),
        dcLoad("brands"),
        dcLoad("seasons"),
        dcLoad("team"),
        dcLoad("genders"),
        dcLoad("categories"),
        dcLoad("vendors"),
      ]);
      if (tpRes.data && Array.isArray(tpRes.data)) {
        const packs = tpRes.data.map((row: any) => {
          if (row.data && typeof row.data === "string") try { return JSON.parse(row.data); } catch { return row.data; }
          return row.data || row;
        }).filter(Boolean);
        setTechPacks(packs);
      }
      if (matRes.data && Array.isArray(matRes.data) && matRes.data.length > 0 && matRes.data[0].value) {
        try { setMaterials(JSON.parse(matRes.data[0].value)); } catch {}
      }
      if (ssRes.data && Array.isArray(ssRes.data) && ssRes.data.length > 0 && ssRes.data[0].value) {
        try { setSpecSheets(JSON.parse(ssRes.data[0].value)); } catch {}
      }
      if (tmplRes.data && Array.isArray(tmplRes.data) && tmplRes.data.length > 0 && tmplRes.data[0].value) {
        try { setSpecTemplates(JSON.parse(tmplRes.data[0].value)); } catch {}
      }
      if (brands)     setDcBrands(brands);
      if (seasons)    setDcSeasons(seasons);
      if (team)       setDcTeam(team);
      if (genders)    setDcGenders(genders);
      if (categories) setDcCategories(categories);
      if (vendors)    setDcVendors(vendors);
    } catch (e) { console.error("Load error:", e); }
    setLoading(false);
  }, [dcLoad]);

  useEffect(() => { if (user) loadData(); }, [user, loadData]);

  // ── Save tech pack ────────────────────────────────────────────────────────
  const saveTechPack = useCallback(async (tp: TechPack) => {
    tp.updatedAt = today();
    tp.updatedBy = user?.name || user?.username || "";
    try {
      await sb.from("techpacks").upsert({ id: tp.id, data: tp });
      showToast("Saved ✓");
    } catch (e) { console.error("Save error:", e); showToast("Save failed!"); }
    setTechPacks(prev => { const idx = prev.findIndex(p => p.id === tp.id); if (idx >= 0) { const n = [...prev]; n[idx] = tp; return n; } return [...prev, tp]; });
  }, [user, showToast]);

  // ── Debounced auto-save ───────────────────────────────────────────────────
  const autoSave = useCallback((tp: TechPack) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => saveTechPack(tp), 1500);
    setSelected({ ...tp });
    setTechPacks(prev => { const idx = prev.findIndex(p => p.id === tp.id); if (idx >= 0) { const n = [...prev]; n[idx] = tp; return n; } return [...prev, tp]; });
  }, [saveTechPack]);

  // ── Save materials ────────────────────────────────────────────────────────
  const saveMaterials = useCallback(async (mats: Material[]) => {
    setMaterials(mats);
    await sb.from("app_data").upsert({ key: "techpack_materials", value: JSON.stringify(mats) });
    showToast("Materials saved");
  }, [showToast]);

  // ── Save spec sheets ──────────────────────────────────────────────────────
  const saveSpecSheets = useCallback(async (sheets: SpecSheet[]) => {
    setSpecSheets(sheets);
    await sb.from("app_data").upsert({ key: "techpack_specsheets", value: JSON.stringify(sheets) });
    showToast("Spec sheets saved");
  }, [showToast]);

  // ── Save spec templates ───────────────────────────────────────────────────
  const saveSpecTemplates = useCallback(async (temps: SpecTemplate[]) => {
    setSpecTemplates(temps);
    await sb.from("app_data").upsert({ key: "techpack_spec_templates", value: JSON.stringify(temps) });
    showToast("Template saved");
  }, [showToast]);

  // ── Delete tech pack ──────────────────────────────────────────────────────
  const deleteTechPack = useCallback(async (id: string) => {
    await sb.from("techpacks").delete(`id=eq.${id}`);
    setTechPacks(prev => prev.filter(p => p.id !== id));
    if (selected?.id === id) { setSelected(null); setView("list"); }
    showToast("Tech pack deleted");
  }, [selected, showToast]);

  // ── Create tech pack ──────────────────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    if (!createForm.styleName || !createForm.styleNumber) return;
    const tp = emptyTechPack(user!);
    Object.assign(tp, createForm);
    tp.designer = createForm.designer || user?.name || user?.username || "";
    await saveTechPack(tp);
    setShowCreateModal(false);
    setCreateForm({ styleNumber: "", styleName: "", brand: "", season: "", category: "", subCategory: "", gender: "", description: "", designer: "", techDesigner: "", graphicArtist: "", productDeveloper: "", vendor: "" });
    setSelected(tp);
    setDetailTab("spec");
    setView("detail");
  }, [createForm, user, saveTechPack]);

  // ── Save / edit material ──────────────────────────────────────────────────
  const handleSaveMaterial = useCallback(async () => {
    if (!matForm.name) return;
    const mat: Material = {
      id: editingMaterial?.id || uid(),
      name: matForm.name, type: matForm.type, composition: matForm.composition, weight: matForm.weight,
      width: matForm.width, color: matForm.color, supplier: matForm.supplier, unitPrice: matForm.unitPrice,
      moq: matForm.moq, leadTime: matForm.leadTime, certifications: matForm.certifications.split(",").map(s => s.trim()).filter(Boolean),
      notes: matForm.notes, createdAt: editingMaterial?.createdAt || today(),
    };
    const updated = editingMaterial ? materials.map(m => m.id === mat.id ? mat : m) : [...materials, mat];
    await saveMaterials(updated);
    setShowMaterialModal(false);
    setEditingMaterial(null);
    setMatForm({ name: "", type: "Fabric", composition: "", weight: "", width: "", color: "", supplier: "", unitPrice: 0, moq: "", leadTime: "", certifications: "", notes: "" });
  }, [matForm, editingMaterial, materials, saveMaterials]);

  // ── Image upload via Dropbox proxy ────────────────────────────────────────
  const uploadImage = useCallback(async (file: File, path: string): Promise<string | null> => {
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("path", path);
      const res = await fetch("/api/dropbox-proxy", { method: "POST", body: formData });
      if (!res.ok) return null;
      const json = await res.json();
      return json.url || json.link || null;
    } catch { return null; }
  }, []);

  // ── Teams + Email Graph helpers ──────────────────────────────────────────
  const tpSbSave = async (key: string, value: any) => {
    await fetch(`${SB_URL}/rest/v1/app_data`, { method: "POST", headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, value: JSON.stringify(value) }) });
  };
  const tpGetToken = async (): Promise<string> => {
    const tok = await getMsAccessToken();
    if (tok) { if (tok !== msToken) setMsToken(tok); return tok; }
    if (msToken) return msToken;
    throw new Error("Not signed in to Microsoft");
  };
  const tpGraph = async (path: string, _tok?: string) => {
    const tok = await tpGetToken();
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" } });
    if (r.status === 401) { clearMsTokens(); setMsToken(null); setMsDisplayName(""); throw new Error("Session expired"); }
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  };
  const tpGraphPost = async (path: string, body: any, _tok?: string) => {
    const tok = await tpGetToken();
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 401) { clearMsTokens(); setMsToken(null); setMsDisplayName(""); throw new Error("Session expired"); }
    if (!r.ok) throw new Error("Graph " + r.status + ": " + await r.text());
    return r.json();
  };

  // ── Restore MS token from localStorage on mount ───────────────────────────
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

  // ── Teams channel map + team ID loader ────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const [r1, r2] = await Promise.all([
          fetch(`${SB_URL}/rest/v1/app_data?key=eq.tp_teams_channel_map&select=value`, { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }),
          fetch(`${SB_URL}/rest/v1/app_data?key=eq.teams_team_id&select=value`, { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }),
        ]);
        const [rows1, rows2] = await Promise.all([r1.json(), r2.json()]);
        if (rows1?.length) setTeamsChannelMap(JSON.parse(rows1[0].value) || {});
        if (rows2?.length) setTeamsTeamId(JSON.parse(rows2[0].value) || "");
      } catch(e) {}
    })();
  }, []);

  // ── Thread collapse: collapse all but last message when thread changes ────
  useEffect(() => {
    if (emailThreadMsgs.length > 1) setTpCollapsedMsgs(new Set(emailThreadMsgs.slice(0, -1).map((m: any) => m.id)));
    else setTpCollapsedMsgs(new Set());
  }, [emailThreadMsgs]);

  // ── Load messages when a TP channel is selected ───────────────────────────
  useEffect(() => {
    if (teamsSelTP && teamsToken && teamsChannelMap[teamsSelTP]) {
      (async () => {
        const mp = teamsChannelMap[teamsSelTP];
        setTeamsLoading(l => ({ ...l, [teamsSelTP!]: true }));
        try {
          const d = await tpGraph(`/teams/${mp.teamId}/channels/${mp.channelId}/messages?$top=50`, teamsToken);
          setTeamsMessages(m => ({ ...m, [teamsSelTP!]: (d.value || []).filter((msg: any) => msg.messageType === "message") }));
        } catch(e) {}
        setTeamsLoading(l => ({ ...l, [teamsSelTP!]: false }));
      })();
    }
  }, [teamsSelTP, teamsToken]);

  // ── Not logged in ─────────────────────────────────────────────────────────
  if (!user) {
    return (
      <div style={S.app}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 48 }}>📐</div>
          <p style={{ color: "#F1F5F9", fontSize: 18 }}>Please log in from the PLM launcher</p>
          <a href="/" style={{ color: "#3B82F6", fontSize: 14, textDecoration: "underline" }}>Go to PLM Launcher</a>
        </div>
      </div>
    );
  }

  // ── Filters ───────────────────────────────────────────────────────────────
  const brands = [...new Set(techPacks.map(t => t.brand).filter(Boolean))].sort();
  const seasons = [...new Set(techPacks.map(t => t.season).filter(Boolean))].sort();

  const filtered = techPacks.filter(tp => {
    if (filterStatus && tp.status !== filterStatus) return false;
    if (filterBrand && tp.brand !== filterBrand) return false;
    if (filterSeason && tp.season !== filterSeason) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!tp.styleName.toLowerCase().includes(q) && !tp.styleNumber.toLowerCase().includes(q) && !tp.brand.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // ── Dashboard stats ───────────────────────────────────────────────────────
  const statTotal = techPacks.length;
  const statDraft = techPacks.filter(t => t.status === "Draft").length;
  const statReview = techPacks.filter(t => t.status === "In Review").length;
  const statApproved = techPacks.filter(t => t.status === "Approved").length;

  // All samples across all tech packs
  const allSamples = techPacks.flatMap(tp => tp.samples.map(s => ({ ...s, styleNumber: tp.styleNumber, styleName: tp.styleName })));

  // ── Helpers for detail ────────────────────────────────────────────────────
  const updateSelected = (changes: Partial<TechPack>) => {
    if (!selected) return;
    const updated = { ...selected, ...changes };
    autoSave(updated);
  };

  async function tpAuthMS() {
    setTeamsAuthStatus("loading");
    setEmailAuthStatus("loading");
    try {
      const t = await msSignIn();
      setMsToken(t.accessToken);
      setTeamsAuthStatus("idle");
      setEmailAuthStatus("idle");
      try {
        const me = await fetch("https://graph.microsoft.com/v1.0/me?$select=displayName", { headers: { Authorization: "Bearer " + t.accessToken } });
        const meData = await me.json();
        if (meData.displayName) setMsDisplayName(meData.displayName);
      } catch(_) {}
    } catch(e) { setTeamsAuthStatus("error"); setEmailAuthStatus("error"); }
  }
  function tpSignOut() {
    clearMsTokens();
    setMsToken(null);
    setMsDisplayName("");
    setTeamsAuthStatus("idle");
    setEmailAuthStatus("idle");
  }
  const tpAuthTeams = tpAuthMS;
  const tpAuthEmail = tpAuthMS;
  async function tpFindTeam(token: string): Promise<string> {
    if (teamsTeamId) return teamsTeamId;
    const data = await tpGraph("/me/joinedTeams", token);
    const rofTeam = (data.value || []).find((t: any) => t.displayName?.toLowerCase().replace(/\s+/g, "").includes("ringoffire"));
    if (!rofTeam) throw new Error('Could not find "RING OF FIRE" team');
    await tpSbSave("teams_team_id", rofTeam.id);
    setTeamsTeamId(rofTeam.id);
    return rofTeam.id as string;
  }
  async function tpStartChat(tpId: string, tpName: string) {
    if (!teamsToken) return;
    setTeamsCreating(tpId);
    try {
      const tid = await tpFindTeam(teamsToken);
      const slug = tpName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
      const chName = `tp-${slug}`;
      let channelId = "";
      try { const chs = await tpGraph(`/teams/${tid}/channels`, teamsToken); const ex = (chs.value || []).find((c: any) => c.displayName === chName); if (ex) channelId = ex.id; } catch(_) {}
      if (!channelId) { const ch = await tpGraphPost(`/teams/${tid}/channels`, { displayName: chName, description: `Tech Pack — ${tpName}`, membershipType: "standard" }, teamsToken); channelId = ch.id; }
      const newMap = { ...teamsChannelMap, [tpId]: { channelId, teamId: tid } };
      setTeamsChannelMap(newMap);
      await tpSbSave("tp_teams_channel_map", newMap);
      const d = await tpGraph(`/teams/${tid}/channels/${channelId}/messages?$top=50`, teamsToken);
      setTeamsMessages(m => ({ ...m, [tpId]: (d.value || []).filter((msg: any) => msg.messageType === "message") }));
    } catch(e: any) { alert("Could not start Teams chat: " + e.message); }
    setTeamsCreating(null);
  }
  async function tpSendMsg(tpId: string) {
    const mp = teamsChannelMap[tpId];
    if (!mp || !teamsNewMsg.trim() || !teamsToken) return;
    try {
      const sent = await tpGraphPost(`/teams/${mp.teamId}/channels/${mp.channelId}/messages`, { body: { content: teamsNewMsg.trim(), contentType: "text" } });
      setTeamsMessages(m => ({ ...m, [tpId]: [sent, ...(m[tpId] || [])] }));
      setTeamsNewMsg("");
    } catch(e: any) { alert("Failed to send: " + e.message); }
  }
  async function tpLoadDmMessages(chatId: string) {
    setDmLoading(true);
    setDmError(null);
    try {
      const d = await tpGraph(`/chats/${chatId}/messages?$top=50`, teamsToken!);
      const msgs = ((d.value || []) as any[]).filter((m: any) => m.messageType === "message").reverse();
      setDmMessages(msgs);
      setTimeout(() => { if (dmScrollRef.current) dmScrollRef.current.scrollTop = dmScrollRef.current.scrollHeight; }, 50);
    } catch(e: any) {
      setDmError("Could not load messages: " + e.message);
    }
    setDmLoading(false);
  }

  async function tpSendDirect() {
    if (!teamsDirectTo.trim() || !teamsDirectMsg.trim()) return;
    setTeamsDirectSending(true);
    setTeamsDirectErr(null);
    try {
      const me = await tpGraph("/me", teamsToken!);
      const chat = await tpGraphPost("/chats", {
        chatType: "oneOnOne",
        members: [
          { "@odata.type": "#microsoft.graph.aadUserConversationMember", roles: ["owner"], "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${me.id}')` },
          { "@odata.type": "#microsoft.graph.aadUserConversationMember", roles: ["owner"], "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${teamsDirectTo.trim()}')` },
        ],
      }, teamsToken!);
      await tpGraphPost(`/chats/${chat.id}/messages`, { body: { content: teamsDirectMsg.trim(), contentType: "text" } }, teamsToken!);
      setDmChatId(chat.id);
      setDmRecipient(teamsDirectTo.trim());
      setTeamsDirectMsg("");
      await tpLoadDmMessages(chat.id);
    } catch(e: any) {
      setTeamsDirectErr("Failed to send: " + e.message);
    }
    setTeamsDirectSending(false);
  }

  async function tpSendDmReply() {
    if (!dmChatId || !dmNewMsg.trim()) return;
    setDmSending(true);
    setDmError(null);
    try {
      const sent = await tpGraphPost(`/chats/${dmChatId}/messages`, { body: { content: dmNewMsg.trim(), contentType: "text" } }, teamsToken!);
      setDmMessages(prev => [...prev, sent]);
      setDmNewMsg("");
      setTimeout(() => { if (dmScrollRef.current) dmScrollRef.current.scrollTop = dmScrollRef.current.scrollHeight; }, 50);
    } catch(e: any) {
      setDmError("Failed to send: " + e.message);
    }
    setDmSending(false);
  }

  function tpTeamsPanel() {
    const filtered = techPacks.filter(tp => { const s = teamsSearch.toLowerCase(); return !s || (tp.styleName || "").toLowerCase().includes(s) || (tp.styleNumber || "").toLowerCase().includes(s); });
    const mp = teamsSelTP ? teamsChannelMap[teamsSelTP] : null;
    const msgs = (teamsSelTP ? teamsMessages[teamsSelTP] : null) || [];
    const isLoadingMsgs = teamsSelTP ? !!teamsLoading[teamsSelTP] : false;
    const selTP = teamsSelTP ? techPacks.find(t => t.id === teamsSelTP) : null;
    return (
      <div style={{ position: "relative" }}>
        <button onClick={() => setView("dashboard")} title="Close" style={{ position: "absolute", top: 10, right: 10, zIndex: 10, width: 28, height: 28, borderRadius: "50%", border: `1px solid ${TEAMS_PURPLE}44`, background: `${TEAMS_PURPLE}15`, color: TEAMS_PURPLE_LT, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        <div style={{ display: "flex", height: "calc(100vh - 120px)", minHeight: 500, background: "#1E293B", borderRadius: 12, border: "1px solid #334155", overflow: "hidden" }}>
          <div style={{ width: 280, flexShrink: 0, borderRight: "1px solid #334155", display: "flex", flexDirection: "column", background: "#0F172A" }}>
            <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid #334155" }}>
              <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6B7280" }}>Tech Packs ({techPacks.length})</span>
            </div>
            <div style={{ padding: "8px 16px", borderBottom: "1px solid #334155" }}>
              <input value={teamsSearch} onChange={e => setTeamsSearch(e.target.value)} placeholder="🔍 Search…" style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 6, padding: "7px 10px", color: "#F1F5F9", fontSize: 12, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
            </div>
            <div style={{ padding: "10px 16px", borderBottom: "1px solid #334155", background: teamsToken ? "#064E3B44" : "#78350F44" }}>
              {teamsToken ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, color: "#34D399", fontWeight: 600 }}>✓ {msDisplayName || "Connected to Teams"}</span>
                  <button onClick={tpSignOut} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, border: "1px solid #34D39944", background: "none", color: "#34D399", cursor: "pointer", fontFamily: "inherit" }}>Sign out</button>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 11, color: "#FBBF24", fontWeight: 600, marginBottom: 6 }}>{teamsAuthStatus === "error" ? "Sign-in failed" : "Sign in to use Teams"}</div>
                  <button onClick={tpAuthTeams} disabled={teamsAuthStatus === "loading"} style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>{teamsAuthStatus === "loading" ? "Signing in…" : "Sign in with Microsoft"}</button>
                </div>
              )}
            </div>
            {/* Tabs: Channels | Direct Message */}
            <div style={{ display: "flex", borderBottom: "1px solid #334155", flexShrink: 0 }}>
              {(["channels","direct"] as const).map(t => (
                <button key={t} onClick={() => setTeamsTab(t)} style={{ flex: 1, padding: "9px 0", fontSize: 11, fontWeight: 700, fontFamily: "inherit", border: "none", borderBottom: teamsTab === t ? `2px solid ${TEAMS_PURPLE}` : "2px solid transparent", background: "none", color: teamsTab === t ? TEAMS_PURPLE_LT : "#6B7280", cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  {t === "channels" ? "TP Channels" : "Direct Message"}
                </button>
              ))}
            </div>
            {teamsTab === "channels" && (
            <div style={{ flex: 1, overflowY: "auto" }}>
              {filtered.map(tp => {
                const isSelected = teamsSelTP === tp.id;
                const hasCh = !!teamsChannelMap[tp.id];
                const msgCount = (teamsMessages[tp.id] || []).length;
                return (
                  <div key={tp.id} onClick={() => setTeamsSelTP(tp.id === teamsSelTP ? null : tp.id)}
                    style={{ padding: "11px 16px", borderBottom: "1px solid #1E293B", cursor: "pointer", background: isSelected ? `${TEAMS_PURPLE}22` : "transparent", borderLeft: isSelected ? `3px solid ${TEAMS_PURPLE}` : "3px solid transparent" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: isSelected ? TEAMS_PURPLE_LT : "#F1F5F9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{tp.styleName || tp.styleNumber || "Unnamed"}</div>
                        <div style={{ fontSize: 11, color: "#6B7280" }}>{tp.styleNumber}{tp.brand ? " · " + tp.brand : ""}</div>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                        <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 10, background: hasCh ? "#064E3B" : "#1E293B", color: hasCh ? "#34D399" : "#6B7280", border: hasCh ? "none" : "1px solid #334155", fontWeight: 700 }}>{hasCh ? "ACTIVE" : "NO CHAT"}</span>
                        {msgCount > 0 && <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 10, background: TEAMS_PURPLE, color: "#fff", fontWeight: 700 }}>{msgCount}</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
              {filtered.length === 0 && <div style={{ padding: 24, fontSize: 13, color: "#6B7280", textAlign: "center" }}>No tech packs</div>}
            </div>
            )}
            {teamsTab === "direct" && (
            <div style={{ flex: 1, overflowY: "auto" }}>
              {!teamsToken ? (
                <div style={{ textAlign: "center", padding: "40px 20px" }}>
                  <div style={{ fontSize: 32, marginBottom: 10 }}>🔒</div>
                  <div style={{ fontSize: 13, color: "#94A3B8", marginBottom: 12 }}>Sign in with Microsoft</div>
                  <button onClick={tpAuthTeams} disabled={teamsAuthStatus === "loading"} style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 6, padding: "8px 18px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{teamsAuthStatus === "loading" ? "Signing in…" : "Sign in with Microsoft"}</button>
                </div>
              ) : (
                <>
                  <div style={{ padding: "10px 12px 6px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 10, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: "#6B7280", fontWeight: 600 }}>Direct Messages</span>
                    {dmChatId && (
                      <button onClick={() => { setDmChatId(null); setDmMessages([]); setDmRecipient(""); setDmError(null); setTeamsDirectErr(null); setTeamsDirectTo(""); setTeamsDirectMsg(""); }}
                        style={{ fontSize: 10, padding: "3px 8px", borderRadius: 5, border: `1px solid ${TEAMS_PURPLE}44`, background: `${TEAMS_PURPLE}15`, color: TEAMS_PURPLE_LT, cursor: "pointer", fontFamily: "inherit" }}>
                        ✎ New
                      </button>
                    )}
                  </div>
                  {dmChatId ? (
                    <div style={{ padding: "10px 16px", borderBottom: "1px solid #1E293B", background: `${TEAMS_PURPLE}22`, borderLeft: `3px solid ${TEAMS_PURPLE}` }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ width: 30, height: 30, borderRadius: "50%", background: `${TEAMS_PURPLE}33`, border: `2px solid ${TEAMS_PURPLE}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: TEAMS_PURPLE_LT, flexShrink: 0 }}>{dmRecipient.slice(0, 2).toUpperCase()}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: TEAMS_PURPLE_LT, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{dmRecipient}</div>
                          <div style={{ fontSize: 10, color: "#6B7280" }}>Active conversation</div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div style={{ padding: "12px 14px", fontSize: 12, color: "#6B7280" }}>No active conversations. Type a message on the right to start one.</div>
                  )}
                </>
              )}
            </div>
            )}
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {teamsTab === "direct" ? (
              !teamsToken ? (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#6B7280" }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>🔒</div>
                  <div style={{ fontSize: 14, color: "#94A3B8", marginBottom: 12 }}>Sign in to use Direct Message</div>
                  <button onClick={tpAuthTeams} disabled={teamsAuthStatus === "loading"} style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "9px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{teamsAuthStatus === "loading" ? "Signing in…" : "Sign in with Microsoft"}</button>
                </div>
              ) : !dmChatId ? (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                  <div style={{ padding: "16px 24px 12px", borderBottom: "1px solid #334155", background: "#1E293B", flexShrink: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#F1F5F9" }}>New Direct Message</div>
                    <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>Send a Teams DM to any team member</div>
                  </div>
                  <div style={{ flex: 1, padding: "20px 24px", overflowY: "auto" }}>
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 5 }}>To (email address)</div>
                      <input value={teamsDirectTo} onChange={e => { setTeamsDirectTo(e.target.value); setTeamsDirectErr(null); }}
                        placeholder="colleague@ringoffire.com"
                        style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 7, padding: "9px 12px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const }} />
                    </div>
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 5 }}>Message</div>
                      <textarea value={teamsDirectMsg} onChange={e => { setTeamsDirectMsg(e.target.value); setTeamsDirectErr(null); }}
                        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); tpSendDirect(); } }}
                        placeholder="Type your message… (Enter to send)" rows={6}
                        style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 7, padding: "9px 12px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit", resize: "vertical" as const, boxSizing: "border-box" as const }} />
                    </div>
                    {teamsDirectErr && (
                      <div style={{ background: "#1E293B", border: "1px solid #EF444444", borderRadius: 8, padding: "10px 14px", color: "#EF4444", fontSize: 12, marginBottom: 12 }}>⚠ {teamsDirectErr}</div>
                    )}
                    <button onClick={tpSendDirect} disabled={teamsDirectSending || !teamsDirectTo.trim() || !teamsDirectMsg.trim()}
                      style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "11px 24px", fontSize: 13, fontWeight: 700, cursor: teamsDirectSending ? "wait" : "pointer", fontFamily: "inherit", opacity: (teamsDirectSending || !teamsDirectTo.trim() || !teamsDirectMsg.trim()) ? 0.6 : 1 }}>
                      {teamsDirectSending ? "Sending…" : "Send Direct Message ↗"}
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                  <div style={{ padding: "14px 50px 14px 20px", borderBottom: "1px solid #334155", background: "#1E293B", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                    <div style={{ width: 34, height: 34, borderRadius: "50%", background: `${TEAMS_PURPLE}33`, border: `2px solid ${TEAMS_PURPLE}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: TEAMS_PURPLE_LT, flexShrink: 0 }}>{dmRecipient.slice(0, 2).toUpperCase()}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#F1F5F9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dmRecipient}</div>
                      <div style={{ fontSize: 11, color: "#6B7280" }}>Direct Message · Teams</div>
                    </div>
                    <button onClick={() => tpLoadDmMessages(dmChatId)} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #334155", background: "none", color: "#6B7280", cursor: "pointer", fontFamily: "inherit" }}>↻ Refresh</button>
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
                    ) : dmMessages.length === 0 ? (
                      <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 40, fontSize: 13 }}>No messages yet in this conversation</div>
                    ) : dmMessages.map((msg: any) => {
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
                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); tpSendDmReply(); }}}
                      placeholder={`Reply to ${dmRecipient}…`}
                      style={{ flex: 1, background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit" }} />
                    <button onClick={tpSendDmReply} disabled={dmSending || !dmNewMsg.trim()}
                      style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "10px 20px", fontSize: 12, fontWeight: 700, cursor: (dmSending || !dmNewMsg.trim()) ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: (dmSending || !dmNewMsg.trim()) ? 0.5 : 1 }}>
                      {dmSending ? "…" : "Send"}
                    </button>
                  </div>
                </div>
              )
            ) : !teamsSelTP ? (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#6B7280" }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>💬</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: "#94A3B8", marginBottom: 6 }}>Select a tech pack to open its chat</div>
                <div style={{ fontSize: 13 }}>Each tech pack gets its own Teams channel in RING OF FIRE</div>
              </div>
            ) : (
              <>
                <div style={{ padding: "14px 20px", borderBottom: "1px solid #334155", background: "#1E293B", display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#F1F5F9" }}>{selTP?.styleName || selTP?.styleNumber || "Tech Pack"}</div>
                    <div style={{ fontSize: 12, color: "#6B7280" }}>{selTP?.styleNumber}{selTP?.brand ? " · " + selTP.brand : ""}{selTP?.season ? " · " + selTP.season : ""}</div>
                  </div>
                  {mp && teamsToken && <button onClick={() => { if (teamsSelTP) { setTeamsLoading(l => ({...l, [teamsSelTP]: true})); tpGraph(`/teams/${mp.teamId}/channels/${mp.channelId}/messages?$top=50`, teamsToken).then(d => { setTeamsMessages(m => ({...m, [teamsSelTP!]: (d.value || []).filter((m: any) => m.messageType === "message")})); setTeamsLoading(l => ({...l, [teamsSelTP!]: false})); }).catch(() => setTeamsLoading(l => ({...l, [teamsSelTP!]: false}))); }}} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #334155", background: "none", color: "#6B7280", cursor: "pointer", fontFamily: "inherit" }}>↻ Refresh</button>}
                </div>
                <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
                  {!teamsToken ? (
                    <div style={{ textAlign: "center", paddingTop: 60 }}>
                      <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "#94A3B8", marginBottom: 8 }}>Sign in to use Teams chat</div>
                      <button onClick={tpAuthTeams} style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "10px 22px", fontFamily: "inherit", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Sign in with Microsoft</button>
                    </div>
                  ) : !mp ? (
                    <div style={{ textAlign: "center", paddingTop: 60 }}>
                      <div style={{ fontSize: 36, marginBottom: 12 }}>💬</div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "#94A3B8", marginBottom: 6 }}>No Teams channel yet</div>
                      <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 20 }}>A channel will be created in RING OF FIRE</div>
                      <button onClick={() => selTP && tpStartChat(selTP.id, selTP.styleName || selTP.styleNumber || selTP.id)} disabled={teamsCreating === teamsSelTP}
                        style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "10px 22px", fontFamily: "inherit", fontSize: 13, fontWeight: 700, cursor: teamsCreating ? "wait" : "pointer", opacity: teamsCreating ? 0.7 : 1 }}>
                        {teamsCreating === teamsSelTP ? "Creating channel…" : "💬 Start Teams Chat"}
                      </button>
                    </div>
                  ) : isLoadingMsgs ? (
                    <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 40, fontSize: 13 }}>Loading messages…</div>
                  ) : msgs.length === 0 ? (
                    <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 40 }}><div style={{ fontSize: 28, marginBottom: 8 }}>💬</div><div style={{ fontSize: 13 }}>No messages yet — start the conversation!</div></div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {msgs.map((msg: any) => {
                        const author = msg.from?.user?.displayName || "Unknown";
                        const initials = author.split(" ").map((w: string) => w[0] || "").join("").toUpperCase().slice(0, 2);
                        const clean = (msg.body?.content || "").replace(/<[^>]+>/g, "").trim();
                        const time = msg.createdDateTime ? new Date(msg.createdDateTime).toLocaleString() : "";
                        return (
                          <div key={msg.id} style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 10, padding: "12px 16px" }}>
                            <div style={{ display: "flex", gap: 10 }}>
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
                    <input value={teamsNewMsg} onChange={e => setTeamsNewMsg(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); tpSendMsg(teamsSelTP!); }}} placeholder={`Message ${selTP?.styleName || "this tech pack"}…`}
                      style={{ flex: 1, background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit" }} />
                    <button onClick={() => tpSendMsg(teamsSelTP!)} disabled={!teamsNewMsg.trim()} style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", fontFamily: "inherit", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: teamsNewMsg.trim() ? 1 : 0.5 }}>Send</button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── TechPack email helpers ─────────────────────────────────────────────────
  function tpEmailPrefix(tp: TechPack) {
    return `[TP-${tp.styleNumber || tp.id.slice(0, 8)}]`;
  }
  async function tpLoadEmails(tpId: string, olderUrl?: string) {
    const tp = techPacks.find(t => t.id === tpId);
    if (!tp) return;
    const prefix = tpEmailPrefix(tp);
    if (!olderUrl) setEmailLoadingMap(m => ({ ...m, [tpId]: true }));
    else setEmailLoadingOlder(true);
    try {
      const url = olderUrl || `/me/messages?$search=${encodeURIComponent('"' + prefix + '"')}&$top=25&$select=id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead,hasAttachments`;
      const d = await tpGraph(url);
      const items = d.value || [];
      if (olderUrl) { setEmailsMap(m => ({ ...m, [tpId]: [...(m[tpId] || []), ...items] })); }
      else { setEmailsMap(m => ({ ...m, [tpId]: items })); }
      setEmailNextLinks(m => ({ ...m, [tpId]: d["@odata.nextLink"] || null }));
    } catch(e) { console.error("Email load error", e); }
    if (!olderUrl) setEmailLoadingMap(m => ({ ...m, [tpId]: false }));
    else setEmailLoadingOlder(false);
  }
  async function tpLoadThread(convId: string) {
    setEmailThreadLoading(true);
    try {
      const d = await tpGraph(`/me/messages?$filter=${encodeURIComponent("conversationId eq '" + convId + "'")}&$orderby=receivedDateTime%20asc&$select=id,subject,from,receivedDateTime,body,conversationId,isRead,hasAttachments`);
      setEmailThreadMsgs(d.value || []);
    } catch { setEmailThreadMsgs([]); }
    setEmailThreadLoading(false);
  }
  async function tpSendEmail(tpId: string) {
    const tp = techPacks.find(t => t.id === tpId);
    if (!tp || !emailComposeTo.trim()) return;
    setEmailSendErr(null);
    try {
      const prefix = tpEmailPrefix(tp);
      const subject = emailComposeSubject.trim() || `${prefix} ${tp.styleName || tp.styleNumber}`;
      await tpGraphPost("/me/sendMail", {
        message: { subject: subject.startsWith("[TP-") ? subject : `${prefix} ${subject}`, body: { contentType: "HTML", content: emailComposeBody || " " }, toRecipients: emailComposeTo.split(",").map(e => ({ emailAddress: { address: e.trim() } })) },
      });
      setEmailComposeTo(""); setEmailComposeSubject(""); setEmailComposeBody("");
      setEmailTabCur("inbox");
      setTimeout(() => tpLoadEmails(tpId), 2000);
    } catch(e: any) { setEmailSendErr("Failed to send: " + e.message); }
  }
  async function tpLoadEmailAttachments(messageId: string) {
    if (tpEmailAttachments[messageId] !== undefined) return;
    setTpEmailAttachmentsLoading(a => ({ ...a, [messageId]: true }));
    try {
      const d = await tpGraph("/me/messages/" + messageId + "/attachments");
      setTpEmailAttachments(a => ({ ...a, [messageId]: d.value || [] }));
    } catch { setTpEmailAttachments(a => ({ ...a, [messageId]: [] })); }
    setTpEmailAttachmentsLoading(a => ({ ...a, [messageId]: false }));
  }

  async function tpMarkAsRead(id: string) {
    try {
      const tok = emailToken || msToken;
      if (!tok) return;
      await fetch("https://graph.microsoft.com/v1.0/me/messages/" + id, {
        method: "PATCH",
        headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
        body: JSON.stringify({ isRead: true }),
      });
    } catch {}
  }

  async function tpReply(messageId: string, comment: string) {
    if (!comment.trim()) return;
    setEmailSendErr(null);
    try {
      await tpGraphPost(`/me/messages/${messageId}/reply`, { comment });
      setEmailReply("");
      if (emailSelMsg?.conversationId) tpLoadThread(emailSelMsg.conversationId);
    } catch(e: any) { setEmailSendErr("Failed to reply: " + e.message); }
  }
  async function tpLoadSentEmails(tpId: string) {
    const tp = techPacks.find(t => t.id === tpId);
    if (!tp) return;
    const prefix = tpEmailPrefix(tp);
    setTpSentLoading(m => ({ ...m, [tpId]: true }));
    try {
      const searchTerm = prefix.replace(/[\[\]{}()*?]/g, "").trim();
      const url = `/me/mailFolders/SentItems/messages?$search=${encodeURIComponent('"' + searchTerm + '"')}&$top=25&$select=id,subject,from,toRecipients,sentDateTime,bodyPreview,conversationId,hasAttachments`;
      const d = await tpGraph(url);
      setTpSentEmails(m => ({ ...m, [tpId]: d.value || [] }));
    } catch(e) { console.error("Sent email load error", e); }
    setTpSentLoading(m => ({ ...m, [tpId]: false }));
  }
  async function tpDeleteEmail(messageId: string) {
    try {
      const tok = await (async () => { const t = await getMsAccessToken(); if (t) return t; if (msToken) return msToken; throw new Error("Not signed in"); })();
      await fetch("https://graph.microsoft.com/v1.0/me/messages/" + messageId, { method: "DELETE", headers: { Authorization: "Bearer " + tok } });
      setTpSelectedEmailId(null);
      setEmailSelMsg(null);
      setTpDeleteConfirm(null);
      setEmailThreadMsgs([]);
      if (emailSelTP) {
        setEmailsMap(m => ({ ...m, [emailSelTP]: (m[emailSelTP] || []).filter((e: any) => e.id !== messageId) }));
        setTpSentEmails(m => ({ ...m, [emailSelTP]: (m[emailSelTP] || []).filter((e: any) => e.id !== messageId) }));
      }
    } catch(e) { console.error("Delete email error", e); }
  }

  function tpEmailPanel() {
    const C = {
      bg0: "#0F172A", bg1: "#1E293B", bg2: "#253347", bg3: "#2D3D52",
      border: "#334155", border2: "#3E4F66",
      text1: "#F1F5F9", text2: "#94A3B8", text3: "#6B7280",
      outlook: "#0078D4", outlookLt: "#106EBE", outlookDim: "rgba(0,120,212,0.15)",
      error: "#EF4444", errorDim: "rgba(239,68,68,0.15)",
      success: "#34D399", info: "#60A5FA", warning: "#FBBF24",
    };

    function FolderIcon({ size = 14, color = "currentColor" }: { size?: number; color?: string }) {
      return (
        <svg width={size} height={size} viewBox="0 0 16 14" fill="none" style={{ flexShrink: 0 }}>
          <path d="M1 2.5C1 1.67 1.67 1 2.5 1H5.5L7 2.5H13.5C14.33 2.5 15 3.17 15 4V11.5C15 12.33 14.33 13 13.5 13H2.5C1.67 13 1 12.33 1 11.5V2.5Z" stroke={color} strokeWidth="1.2" fill="none"/>
        </svg>
      );
    }

    const iconBtn: React.CSSProperties = { width: 28, height: 28, borderRadius: 6, border: "none", background: "transparent", color: C.text3, cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" };

    const tpList = techPacks.filter(tp => {
      const s = emailSearch.toLowerCase();
      return !s || (tp.styleName || "").toLowerCase().includes(s) || (tp.styleNumber || "").toLowerCase().includes(s) || (tp.brand || "").toLowerCase().includes(s);
    }).sort((a: any, b: any) => {
      const ua = (emailsMap[a.id] || []).filter((e: any) => !e.isRead).length;
      const ub = (emailsMap[b.id] || []).filter((e: any) => !e.isRead).length;
      return ub - ua;
    });
    const selTP2 = emailSelTP ? techPacks.find(t => t.id === emailSelTP) : null;
    const inboxEmails = emailSelTP ? (emailsMap[emailSelTP] || []) : [];
    const sentEmailList = emailSelTP ? (tpSentEmails[emailSelTP] || []) : [];
    const activeList = tpActiveFolder === "inbox" ? inboxEmails : sentEmailList;
    const isLoadingE = emailSelTP ? !!emailLoadingMap[emailSelTP] : false;
    const nextLink = emailSelTP ? emailNextLinks[emailSelTP] : null;

    const visibleEmails = activeList.filter((em: any) => {
      if (tpFilterUnread && em.isRead) return false;
      if (tpFilterFlagged && !tpFlaggedSet.has(em.id)) return false;
      if (tpSearchQuery) {
        const q = tpSearchQuery.toLowerCase();
        const sender = em.from?.emailAddress?.name || em.from?.emailAddress?.address || "";
        if (!(em.subject || "").toLowerCase().includes(q) && !sender.toLowerCase().includes(q) && !(em.bodyPreview || "").toLowerCase().includes(q)) return false;
      }
      return true;
    });

    const selEmailObj = tpSelectedEmailId ? (activeList.find((e: any) => e.id === tpSelectedEmailId) || emailSelMsg) : emailSelMsg;

    return (
      <div style={{ position: "relative" }} onClick={() => tpCtxMenu && setTpCtxMenu(null)}>
        <button onClick={() => setView("dashboard")} style={{ position: "absolute", top: 10, right: 10, zIndex: 10, width: 28, height: 28, borderRadius: "50%", border: `1px solid ${C.outlook}44`, background: `${C.outlook}15`, color: C.outlook, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>

        <div style={{ display: "flex", height: "calc(100vh - 120px)", minHeight: 500, background: C.bg0, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden", position: "relative", fontFamily: "'Segoe UI', system-ui, sans-serif", fontSize: 13, color: C.text1 }}>

          {/* ── SIDEBAR (220px) ──────────────────────────────────────────────── */}
          <div style={{ width: 220, minWidth: 220, background: C.bg1, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>

            {/* Compose button */}
            <div style={{ padding: "14px 12px 10px", borderBottom: `1px solid ${C.border}` }}>
              <button
                onClick={() => { setTpComposeOpen(true); setEmailComposeSubject(selTP2 ? tpEmailPrefix(selTP2) + " " : ""); setEmailSendErr(null); }}
                disabled={!emailToken}
                style={{ width: "100%", padding: "8px 12px", background: emailToken ? `linear-gradient(135deg, ${C.outlook}, ${C.outlookLt})` : C.bg2, border: "none", borderRadius: 8, color: emailToken ? "#fff" : C.text3, fontSize: 13, fontWeight: 500, cursor: emailToken ? "pointer" : "default", display: "flex", alignItems: "center", gap: 8, justifyContent: "center", fontFamily: "inherit" }}>
                ✎ New Message
              </button>
            </div>

            {/* TP label + search */}
            <div style={{ padding: "10px 12px 4px", fontSize: 10, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: C.text3, fontWeight: 600 }}>
              Tech Packs ({tpList.length})
            </div>
            <div style={{ padding: "4px 8px 6px" }}>
              <input value={emailSearch} onChange={e => setEmailSearch(e.target.value)} placeholder="🔍 Search…"
                style={{ width: "100%", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", color: C.text1, fontSize: 11, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const }} />
            </div>

            {/* TP list */}
            <div style={{ flex: 1, overflowY: "auto" }}>
              {tpList.map(tp => {
                const isSelected = emailSelTP === tp.id;
                const unread = (emailsMap[tp.id] || []).filter((e: any) => !e.isRead).length;
                return (
                  <div key={tp.id}
                    onClick={() => { const wasSelected = emailSelTP === tp.id; setEmailSelTP(wasSelected ? null : tp.id); setTpSelectedEmailId(null); setEmailSelMsg(null); setEmailThreadMsgs([]); setTpDeleteConfirm(null); setTpActiveFolder("inbox"); if (!wasSelected && emailToken && !emailsMap[tp.id]?.length) tpLoadEmails(tp.id); }}
                    style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 10px", borderRadius: 7, margin: "1px 6px", cursor: "pointer", fontSize: 12, background: isSelected ? C.outlookDim : "transparent", color: isSelected ? C.info : C.text2, border: isSelected ? "1px solid rgba(96,165,250,0.2)" : "1px solid transparent", transition: "all 0.1s" }}>
                    <div style={{ width: 7, height: 7, borderRadius: "50%", background: C.outlook, flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{tp.styleName || tp.styleNumber || "Unnamed"}</span>
                    {unread > 0 && <span style={{ background: C.outlook, color: "#fff", fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 10, minWidth: 16, textAlign: "center" as const }}>{unread}</span>}
                  </div>
                );
              })}
              {tpList.length === 0 && <div style={{ padding: 16, fontSize: 12, color: C.text3, textAlign: "center" }}>No tech packs</div>}
            </div>

            {/* Divider */}
            <div style={{ height: 1, background: C.border, margin: "4px 10px" }} />

            {/* Folders */}
            <div style={{ padding: "6px 12px 2px", fontSize: 10, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: C.text3, fontWeight: 600 }}>Folders</div>
            {(["inbox", "sent"] as const).map(f => {
              const label = f === "inbox" ? "Inbox" : "Sent";
              const count = f === "inbox" ? inboxEmails.filter((e: any) => !e.isRead).length : 0;
              return (
                <div key={f} onClick={() => { setTpActiveFolder(f); setTpSelectedEmailId(null); setEmailSelMsg(null); setEmailThreadMsgs([]); if (f === "sent" && emailSelTP && emailToken) tpLoadSentEmails(emailSelTP); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 7, margin: "1px 6px", cursor: "pointer", fontSize: 12, background: tpActiveFolder === f ? "rgba(200,33,10,0.15)" : "transparent", color: tpActiveFolder === f ? "#E87060" : C.text2, transition: "all 0.1s" }}>
                  <FolderIcon size={14} color={tpActiveFolder === f ? "#E87060" : C.text3} />
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
                    onClick={tpSignOut} title="Click to sign out">● Live</div>
                </>
              ) : (
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: C.warning, fontWeight: 600, marginBottom: 5 }}>{emailAuthStatus === "error" ? "Auth failed — check config" : "Sign in to load emails"}</div>
                  {(!MS_CLIENT_ID || !MS_TENANT_ID) ? (
                    <div style={{ fontSize: 10, color: "#D97706" }}>Azure credentials not configured</div>
                  ) : (
                    <button onClick={tpAuthEmail} disabled={emailAuthStatus === "loading"}
                      style={{ background: `linear-gradient(135deg,${C.outlook},${C.outlookLt})`, color: "#fff", border: "none", borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: emailAuthStatus === "loading" ? 0.6 : 1, width: "100%" }}>
                      {emailAuthStatus === "loading" ? "Signing in…" : "Sign in with Microsoft"}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── EMAIL LIST (295px) ───────────────────────────────────────────── */}
          <div style={{ width: 295, minWidth: 295, background: C.bg1, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column" }}>

            {/* List header */}
            <div style={{ padding: "12px 12px 8px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: C.text1 }}>
                {tpActiveFolder === "inbox" ? "Inbox" : "Sent"}
                {selTP2 && <span style={{ fontSize: 11, color: C.text3, marginLeft: 6, fontWeight: 400 }}>· {selTP2.styleName || selTP2.styleNumber}</span>}
              </span>
              <button style={iconBtn} title="Refresh"
                onClick={() => { if (emailSelTP) { if (tpActiveFolder === "inbox") tpLoadEmails(emailSelTP); else tpLoadSentEmails(emailSelTP); } }}>↻</button>
            </div>

            {/* Search */}
            <div style={{ position: "relative" as const, margin: "8px 10px" }}>
              <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: C.text3, fontSize: 13, pointerEvents: "none" }}>⌕</span>
              <input style={{ width: "100%", background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 7, padding: "6px 10px 6px 28px", color: C.text1, fontSize: 12, outline: "none", boxSizing: "border-box" as const, fontFamily: "inherit" }}
                placeholder="Search…" value={tpSearchQuery} onChange={e => setTpSearchQuery(e.target.value)} />
            </div>

            {/* Filter pills */}
            <div style={{ display: "flex", gap: 4, padding: "6px 8px", borderBottom: `1px solid ${C.border}` }}>
              {(["All", "Unread", "Flagged"] as const).map(label => {
                const isActive = label === "All" ? (!tpFilterUnread && !tpFilterFlagged) : label === "Unread" ? tpFilterUnread : tpFilterFlagged;
                return (
                  <div key={label} onClick={() => { if (label === "All") { setTpFilterUnread(false); setTpFilterFlagged(false); } else if (label === "Unread") { setTpFilterUnread(v => !v); setTpFilterFlagged(false); } else { setTpFilterFlagged(v => !v); setTpFilterUnread(false); } }}
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
              ) : !emailSelTP ? (
                <div style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 12 }}>Select a tech pack from the left</div>
              ) : isLoadingE && tpActiveFolder === "inbox" ? (
                <div style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 13 }}>Loading emails…</div>
              ) : tpSentLoading[emailSelTP] && tpActiveFolder === "sent" ? (
                <div style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 13 }}>Loading sent emails…</div>
              ) : visibleEmails.length === 0 ? (
                <div style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 13 }}>No messages</div>
              ) : (
                <>
                  {visibleEmails.map((em: any) => {
                    const sender = tpActiveFolder === "inbox"
                      ? (em.from?.emailAddress?.name || em.from?.emailAddress?.address || "Unknown")
                      : "To: " + ((em.toRecipients || []).map((r: any) => r.emailAddress?.name || r.emailAddress?.address || "").filter(Boolean).join(", ") || "—");
                    const time = em.receivedDateTime
                      ? new Date(em.receivedDateTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                      : em.sentDateTime
                      ? new Date(em.sentDateTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                      : "";
                    const isFlagged = tpFlaggedSet.has(em.id);
                    const isUnread = !em.isRead && tpActiveFolder === "inbox";
                    return (
                      <div key={em.id}
                        onClick={() => { setTpSelectedEmailId(em.id); setTpDeleteConfirm(null); setTpReplyText(""); if (tpActiveFolder === "inbox" && !em.isRead) { tpMarkAsRead(em.id); setEmailsMap(m => ({ ...m, [emailSelTP!]: (m[emailSelTP!] || []).map((e: any) => e.id === em.id ? { ...e, isRead: true } : e) })); } setEmailSelMsg(em); setEmailThreadMsgs([]); if (em.conversationId) tpLoadThread(em.conversationId); if (em.hasAttachments) tpLoadEmailAttachments(em.id); }}
                        onContextMenu={e => { e.preventDefault(); setTpCtxMenu({ x: e.clientX, y: e.clientY, em }); }}
                        style={{ padding: "11px 12px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", position: "relative" as const, background: tpSelectedEmailId === em.id ? C.bg3 : "transparent", transition: "background 0.1s" }}>
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
                  {tpActiveFolder === "inbox" && nextLink && (
                    <button onClick={() => tpLoadEmails(emailSelTP!, nextLink!)} disabled={emailLoadingOlder}
                      style={{ background: `linear-gradient(135deg,${C.outlook},${C.outlookLt})`, color: "#fff", border: "none", borderRadius: 0, padding: "10px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", width: "100%", opacity: emailLoadingOlder ? 0.6 : 1 }}>
                      {emailLoadingOlder ? "Loading…" : "Load older"}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* ── EMAIL DETAIL (flex-1) ─────────────────────────────────────── */}
          <div style={{ flex: 1, background: C.bg0, display: "flex", flexDirection: "column", minWidth: 0 }}>
            {!tpSelectedEmailId ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 12, color: C.text3 }}>
                <span style={{ fontSize: 48, opacity: 0.25 }}>✉</span>
                <span style={{ fontSize: 14 }}>{emailSelTP ? "Select a message to read" : "Select a tech pack from the left"}</span>
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
                      onClick={() => setTpFlaggedSet(prev => { const s = new Set(prev); if (s.has(tpSelectedEmailId)) s.delete(tpSelectedEmailId); else s.add(tpSelectedEmailId); return s; })}>
                      <span style={{ color: tpFlaggedSet.has(tpSelectedEmailId) ? C.warning : C.text3 }}>{tpFlaggedSet.has(tpSelectedEmailId) ? "★" : "☆"}</span>
                    </button>
                    <button style={{ ...iconBtn, color: C.error }} title="Delete" onClick={() => setTpDeleteConfirm(tpSelectedEmailId)}>🗑️</button>
                  </div>
                </div>

                {/* Delete confirm bar */}
                {tpDeleteConfirm === tpSelectedEmailId && (
                  <div style={{ background: C.errorDim, borderBottom: `1px solid rgba(239,68,68,0.3)`, padding: "8px 18px", display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 13, color: C.error, flex: 1 }}>Permanently delete this message? This cannot be undone.</span>
                    <button onClick={() => tpDeleteEmail(tpSelectedEmailId)}
                      style={{ padding: "7px 14px", background: C.errorDim, border: `1px solid rgba(239,68,68,0.3)`, borderRadius: 7, color: C.error, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" }}>
                      Delete
                    </button>
                    <button style={{ ...iconBtn, color: C.text2 }} onClick={() => setTpDeleteConfirm(null)}>✕</button>
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
                      const collapsed = !isLast && tpCollapsedMsgs.has(msg.id);
                      const sender = msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || "Unknown";
                      const initials = sender.split(" ").map((w: string) => w[0] || "").join("").toUpperCase().slice(0, 2) || "??";
                      const time = msg.receivedDateTime ? new Date(msg.receivedDateTime).toLocaleString() : "";
                      const htmlBody = msg.body?.content || "";
                      return (
                        <div key={msg.id} style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 10, overflow: "hidden" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", cursor: !isLast ? "pointer" : "default" }}
                            onClick={() => { if (!isLast) setTpCollapsedMsgs(prev => { const s = new Set(prev); if (s.has(msg.id)) s.delete(msg.id); else s.add(msg.id); return s; }); }}>
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
                {tpSelectedEmailId && (tpEmailAttachments[tpSelectedEmailId] || []).length > 0 && (
                  <div style={{ borderTop: `1px solid ${C.border}`, padding: "8px 18px", background: C.bg1, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: C.text3, marginRight: 4 }}>📎 Attachments:</span>
                    {tpEmailAttachments[tpSelectedEmailId].map((att: any) => {
                      const href = att.contentBytes ? `data:${att.contentType || "application/octet-stream"};base64,${att.contentBytes}` : "#";
                      return (
                        <a key={att.id} href={href} download={att.name}
                          style={{ display: "inline-flex", alignItems: "center", gap: 4, background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 9px", fontSize: 11, color: C.info, textDecoration: "none", cursor: "pointer", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          📄 {att.name}{att.size ? ` (${(att.size / 1024).toFixed(0)}KB)` : ""}
                        </a>
                      );
                    })}
                    {tpEmailAttachmentsLoading[tpSelectedEmailId] && <span style={{ fontSize: 11, color: C.text3 }}>Loading…</span>}
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
                    value={tpReplyText}
                    onChange={e => setTpReplyText(e.target.value)}
                  />
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
                    <button onClick={() => setTpReplyText("")} style={{ padding: "7px 14px", borderRadius: 7, border: `1px solid ${C.border}`, background: "none", color: C.text3, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>Discard</button>
                    <button onClick={() => { if (selEmailObj) tpReply(selEmailObj.id, tpReplyText); }}
                      disabled={!tpReplyText.trim() || !selEmailObj}
                      style={{ padding: "7px 16px", background: `linear-gradient(135deg, ${C.outlook}, ${C.outlookLt})`, border: "none", borderRadius: 7, color: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", opacity: (!tpReplyText.trim() || !selEmailObj) ? 0.5 : 1 }}>
                      Send ↗
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* ── COMPOSE MODAL (floating bottom-right) ────────────────────── */}
          {tpComposeOpen && (
            <div style={{ position: "absolute", inset: 0, zIndex: 100, pointerEvents: "none" }}>
              <div style={{ position: "absolute", bottom: 0, right: 0, width: 520, background: C.bg1, border: `1px solid ${C.border2}`, borderRadius: "12px 12px 0 0", boxShadow: "0 -8px 32px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", pointerEvents: "all" }}>
                <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", background: C.bg2, borderRadius: "12px 12px 0 0" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: C.text1 }}>New Message</span>
                  <button onClick={() => { setTpComposeOpen(false); setEmailSendErr(null); }} style={{ ...iconBtn, color: C.text2 }}>✕</button>
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
                  <button onClick={() => { setTpComposeOpen(false); setEmailSendErr(null); setEmailComposeTo(""); setEmailComposeSubject(""); setEmailComposeBody(""); }}
                    style={{ padding: "7px 16px", borderRadius: 7, border: `1px solid ${C.border}`, background: "none", color: C.text3, cursor: "pointer", fontFamily: "inherit" }}>Discard</button>
                  <button onClick={() => emailSelTP && tpSendEmail(emailSelTP)} disabled={!emailComposeTo.trim() || !emailComposeSubject.trim()}
                    style={{ padding: "7px 18px", background: `linear-gradient(135deg, ${C.outlook}, ${C.outlookLt})`, border: "none", borderRadius: 7, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: (!emailComposeTo.trim() || !emailComposeSubject.trim()) ? 0.5 : 1 }}>
                    Send ↗
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── CONTEXT MENU ─────────────────────────────────────────────── */}
          {tpCtxMenu && (
            <div style={{ position: "fixed", top: tpCtxMenu.y, left: tpCtxMenu.x, zIndex: 2000, background: C.bg2, border: `1px solid ${C.border2}`, borderRadius: 8, padding: "4px 0", boxShadow: "0 8px 24px rgba(0,0,0,0.5)", minWidth: 170 }}
              onClick={e => e.stopPropagation()}>
              <div style={{ padding: "8px 16px", fontSize: 12, color: C.text1, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
                onClick={() => { setTpSelectedEmailId(tpCtxMenu.em.id); setEmailSelMsg(tpCtxMenu.em); setEmailThreadMsgs([]); if (tpCtxMenu.em.conversationId) tpLoadThread(tpCtxMenu.em.conversationId); setTpCtxMenu(null); }}>
                ↩ Reply
              </div>
              <div style={{ padding: "8px 16px", fontSize: 12, color: C.text1, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
                onClick={() => { setTpSelectedEmailId(tpCtxMenu.em.id); setEmailSelMsg(tpCtxMenu.em); setEmailThreadMsgs([]); if (tpCtxMenu.em.conversationId) tpLoadThread(tpCtxMenu.em.conversationId); setTpCtxMenu(null); }}>
                ↩↩ Reply All
              </div>
              <div style={{ height: 1, background: C.border, margin: "3px 0" }} />
              <div style={{ padding: "8px 16px", fontSize: 12, color: C.error, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
                onClick={() => { setTpDeleteConfirm(tpCtxMenu.em.id); setTpSelectedEmailId(tpCtxMenu.em.id); setTpCtxMenu(null); }}>
                🗑️ Delete
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={S.app}>
      {/* NAV */}
      <nav style={S.nav}>
        <div style={S.navLeft}>
          <div style={S.navLogo}>📐</div>
          <span style={S.navTitle}>Tech Packs</span>
          <span style={S.navSub}>Product Specs & BOM</span>
        </div>
        <div style={S.navRight}>
          <button style={view === "dashboard" ? S.navBtnActive : S.navBtn} onClick={() => { setSelected(null); setView("dashboard"); }}>Dashboard</button>
          <button style={view === "list" ? S.navBtnActive : S.navBtn} onClick={() => { setSelected(null); setView("list"); }}>All Packs</button>
          <button style={view === "libraries" ? S.navBtnActive : S.navBtn} onClick={() => { setSelected(null); setView("libraries"); }}>Libraries</button>
          <button style={view === "samples" ? S.navBtnActive : S.navBtn} onClick={() => { setSelected(null); setView("samples"); }}>Samples</button>
          <button style={view === "teams" ? { ...S.navBtnActive, borderColor: TEAMS_PURPLE, color: TEAMS_PURPLE_LT } : { ...S.navBtn, color: TEAMS_PURPLE_LT }} onClick={() => { setSelected(null); setView("teams"); }}>💬 Teams</button>
          <button style={view === "email" ? { ...S.navBtnActive, borderColor: "#0078D4", color: "#60A5FA" } : S.navBtn} onClick={() => { setSelected(null); setView("email"); }}>📧 Email</button>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 8 }}>
            {user.avatar ? (
              <img src={user.avatar} alt={user.name || ""} style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
            ) : (
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: user.color ?? "#3B82F6", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                {user.initials || (user.name || user.username || "?").split(" ").map((w: string) => w[0]).join("").toUpperCase().slice(0, 2)}
              </div>
            )}
            <span style={{ color: "#94A3B8", fontSize: 12, fontWeight: 600 }}>{user.name || user.username}</span>
          </div>
          <button style={S.navBtn} onClick={() => window.location.href = "/"}>← PLM</button>
          <button style={S.navBtnDanger} onClick={() => { sessionStorage.removeItem("plm_user"); window.location.href = "/"; }}>Sign Out</button>
        </div>
      </nav>

      {/* TOAST */}
      {toast && (
        <div style={{ position: "fixed", top: 70, right: 24, background: "#10B981", color: "#fff", padding: "10px 20px", borderRadius: 8, fontSize: 14, fontWeight: 600, zIndex: 999, boxShadow: "0 4px 12px rgba(0,0,0,0.3)" }}>
          {toast}
        </div>
      )}

      <div style={S.content}>
        {loading ? (
          <div style={{ textAlign: "center", padding: 60, color: "#6B7280" }}>Loading tech packs...</div>
        ) : (
          <>
            {/* ═══════════ DASHBOARD ═══════════ */}
            {view === "dashboard" && (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                  <h2 style={{ margin: 0, color: "#F1F5F9", fontSize: 22 }}>Dashboard</h2>
                  <button style={S.btnPrimarySmall} onClick={() => { setCreateForm({ styleNumber: "", styleName: "", brand: "", season: "", category: "", subCategory: "", gender: "", description: "", designer: user.name || user.username || "", techDesigner: "", graphicArtist: "", productDeveloper: "", vendor: "" }); setShowCreateModal(true); }}>+ New Tech Pack</button>
                </div>

                {/* Stat Cards */}
                <div style={S.statsRow}>
                  {renderStatCard("Total Packs", statTotal, "#3B82F6", "📦")}
                  {renderStatCard("Draft", statDraft, "#6B7280", "📝")}
                  {renderStatCard("In Review", statReview, "#F59E0B", "🔍")}
                  {renderStatCard("Approved", statApproved, "#10B981", "✅")}
                </div>

                {/* Recent Tech Packs */}
                <div style={S.card}>
                  <h3 style={S.cardTitle}>Recent Tech Packs</h3>
                  {techPacks.length === 0 ? (
                    <div style={S.emptyState}>
                      <div style={{ fontSize: 40 }}>📐</div>
                      <p>No tech packs yet. Create your first one!</p>
                    </div>
                  ) : (
                    [...techPacks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5).map(tp => renderTPRow(tp))
                  )}
                </div>

                {/* Approval Summary */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                  <div style={S.card}>
                    <h3 style={S.cardTitle}>Approval Status</h3>
                    {(() => {
                      const allApprovals = techPacks.flatMap(tp => tp.approvals);
                      const pending = allApprovals.filter(a => a.status === "Pending").length;
                      const approved = allApprovals.filter(a => a.status === "Approved").length;
                      const rejected = allApprovals.filter(a => a.status === "Rejected").length;
                      const revision = allApprovals.filter(a => a.status === "Revision Required").length;
                      const total = allApprovals.length || 1;
                      return (
                        <div>
                          {[["Pending", pending, "#6B7280"], ["Approved", approved, "#10B981"], ["Rejected", rejected, "#EF4444"], ["Revision Required", revision, "#F59E0B"]].map(([label, count, color]) => (
                            <div key={label as string} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                              <span style={{ color: color as string, fontSize: 13, width: 130, fontWeight: 600 }}>{label}</span>
                              <div style={{ flex: 1, height: 8, background: "#0F172A", borderRadius: 4, overflow: "hidden" }}>
                                <div style={{ width: `${((count as number) / total) * 100}%`, height: "100%", background: color as string, borderRadius: 4 }} />
                              </div>
                              <span style={{ color: "#94A3B8", fontSize: 13, fontFamily: "monospace", width: 30, textAlign: "right" }}>{count as number}</span>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>

                  <div style={S.card}>
                    <h3 style={S.cardTitle}>Sample Tracking</h3>
                    {allSamples.length === 0 ? (
                      <div style={{ color: "#6B7280", fontSize: 13, textAlign: "center", padding: 20 }}>No samples tracked yet</div>
                    ) : (
                      <div>
                        {SAMPLE_TYPES.map(type => {
                          const count = allSamples.filter(s => s.type === type).length;
                          const approved = allSamples.filter(s => s.type === type && s.status === "Approved").length;
                          return count > 0 ? (
                            <div key={type} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                              <span style={{ color: "#D1D5DB", fontSize: 13, width: 100, fontWeight: 600 }}>{type}</span>
                              <div style={{ flex: 1, height: 6, background: "#0F172A", borderRadius: 3, overflow: "hidden" }}>
                                <div style={{ width: `${(approved / count) * 100}%`, height: "100%", background: "#10B981", borderRadius: 3 }} />
                              </div>
                              <span style={{ color: "#94A3B8", fontSize: 12, fontFamily: "monospace" }}>{approved}/{count}</span>
                            </div>
                          ) : null;
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}

            {/* ═══════════ ALL PACKS LIST ═══════════ */}
            {view === "list" && (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <h2 style={{ margin: 0, color: "#F1F5F9", fontSize: 22 }}>All Tech Packs</h2>
                  <button style={S.btnPrimarySmall} onClick={() => { setCreateForm({ styleNumber: "", styleName: "", brand: "", season: "", category: "", subCategory: "", gender: "", description: "", designer: user.name || user.username || "", techDesigner: "", graphicArtist: "", productDeveloper: "", vendor: "" }); setShowCreateModal(true); }}>+ New Tech Pack</button>
                </div>

                {/* Filters */}
                <div style={S.filters}>
                  <input style={{ ...S.input, maxWidth: 260 }} placeholder="Search style name, number, brand..." value={search} onChange={e => setSearch(e.target.value)} />
                  <select style={S.select} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                    <option value="">All Statuses</option>
                    {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <select style={S.select} value={filterBrand} onChange={e => setFilterBrand(e.target.value)}>
                    <option value="">All Brands</option>
                    {brands.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                  <select style={S.select} value={filterSeason} onChange={e => setFilterSeason(e.target.value)}>
                    <option value="">All Seasons</option>
                    {seasons.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <span style={{ color: "#6B7280", fontSize: 13 }}>{filtered.length} packs</span>
                </div>

                {/* Grid of cards */}
                {filtered.length === 0 ? (
                  <div style={S.emptyState}>
                    <div style={{ fontSize: 40 }}>📐</div>
                    <p>No tech packs match your filters</p>
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
                    {filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(tp => (
                      <div key={tp.id} style={S.tpCard} onClick={() => { setSelected(tp); setDetailTab("spec"); setView("detail"); }}
                        onMouseEnter={e => e.currentTarget.style.borderColor = "#3B82F6"}
                        onMouseLeave={e => e.currentTarget.style.borderColor = "#334155"}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                          <span style={{ fontFamily: "monospace", color: "#60A5FA", fontWeight: 700, fontSize: 15 }}>{tp.styleNumber || "—"}</span>
                          <span style={{ ...S.badge, background: STATUS_COLORS[tp.status] + "22", color: STATUS_COLORS[tp.status], border: `1px solid ${STATUS_COLORS[tp.status]}44` }}>{tp.status}</span>
                        </div>
                        <div style={{ color: "#F1F5F9", fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{tp.styleName}</div>
                        <div style={{ color: "#94A3B8", fontSize: 13, marginBottom: 8 }}>{tp.brand}{tp.season ? ` · ${tp.season}` : ""}</div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ color: "#6B7280", fontSize: 12 }}>{tp.category}</span>
                          <span style={{ color: "#6B7280", fontSize: 11 }}>Updated {fmtDate(tp.updatedAt)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* ═══════════ LIBRARIES ═══════════ */}
            {view === "libraries" && renderLibrariesView()}

            {/* ═══════════ SAMPLES OVERVIEW ═══════════ */}
            {view === "samples" && renderSamplesOverview()}

            {/* ═══════════ TEAMS ═══════════ */}
            {view === "teams" && tpTeamsPanel()}

            {/* ═══════════ EMAIL ═══════════ */}
            {view === "email" && tpEmailPanel()}
          </>
        )}
      </div>

      {/* ═══════════ DETAIL PANEL ═══════════ */}
      {view === "detail" && selected && renderDetailPanel()}

      {/* ═══════════ CREATE MODAL ═══════════ */}
      {showCreateModal && renderCreateModal()}

      {/* ═══════════ MATERIAL MODAL ═══════════ */}
      {showMaterialModal && renderMaterialModal()}

      {/* ═══════════ SPEC SHEET DETAIL PANEL ═══════════ */}
      {selectedSpecSheet && renderSpecSheetDetail()}

      {/* ═══════════ SPEC SHEET CREATE MODAL ═══════════ */}
      {showSpecSheetModal && renderSpecSheetModal()}

      {/* ═══════════ TEMPLATES MODAL ═══════════ */}
      {showTemplatesModal && renderTemplatesModal()}

      {/* ═══════════ CONFIRM DIALOG ═══════════ */}
      {confirmDialog && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setConfirmDialog(null)}>
          <div style={{ background: "#1E293B", borderRadius: 16, width: 420, padding: 0, overflow: "hidden", boxShadow: "0 24px 64px rgba(0,0,0,0.5)", border: "1px solid #334155" }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: "24px 24px 0", display: "flex", alignItems: "flex-start", gap: 16 }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: "#EF444422", border: "1px solid #EF444444", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>🗑️</div>
              <div>
                <div style={{ color: "#F1F5F9", fontWeight: 700, fontSize: 17, marginBottom: 6 }}>{confirmDialog.title}</div>
                <div style={{ color: "#94A3B8", fontSize: 14, lineHeight: 1.5 }}>{confirmDialog.message}</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, padding: 24, paddingTop: 20 }}>
              <button style={{ ...S.btnSecondary, flex: 1, padding: "10px 0", fontSize: 14 }} onClick={() => setConfirmDialog(null)}>Cancel</button>
              <button style={{ flex: 1, padding: "10px 0", background: "linear-gradient(135deg,#EF4444,#DC2626)", color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}
                onClick={() => { confirmDialog.onConfirm(); setConfirmDialog(null); }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════ LIGHTBOX ═══════════ */}
      {lightboxImg && (
        <div style={S.modalOverlay} onClick={() => setLightboxImg(null)}>
          <div style={{ maxWidth: "90vw", maxHeight: "90vh" }} onClick={e => e.stopPropagation()}>
            <img src={lightboxImg} alt="" style={{ maxWidth: "90vw", maxHeight: "85vh", borderRadius: 12, objectFit: "contain" }} />
            <div style={{ textAlign: "center", marginTop: 12 }}>
              <button style={S.btnSecondary} onClick={() => setLightboxImg(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {supabaseClient && user && (
        <NotificationsShell
          kind="internal"
          supabase={supabaseClient}
          userId={user.id}
          sessionKey="rof_notif_dismissed_internal"
        />
      )}
    </div>
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SUB-RENDER FUNCTIONS
  // ══════════════════════════════════════════════════════════════════════════

  function renderStatCard(label: string, value: number, color: string, icon: string) {
    return (
      <div style={{ ...S.statCard, borderTop: `3px solid ${color}` }}>
        <div style={{ fontSize: 24 }}>{icon}</div>
        <div style={{ fontSize: 28, fontWeight: 700, color, fontFamily: "monospace" }}>{value}</div>
        <div style={{ color: "#9CA3AF", fontSize: 13 }}>{label}</div>
      </div>
    );
  }

  function renderTPRow(tp: TechPack) {
    return (
      <div key={tp.id} style={S.poRow} onClick={() => { setSelected(tp); setDetailTab("spec"); setView("detail"); }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <span style={{ fontFamily: "monospace", color: "#60A5FA", fontWeight: 700, fontSize: 15 }}>{tp.styleNumber || "—"}</span>
            <span style={{ ...S.badge, background: STATUS_COLORS[tp.status] + "22", color: STATUS_COLORS[tp.status], border: `1px solid ${STATUS_COLORS[tp.status]}44` }}>{tp.status}</span>
          </div>
          <div style={{ color: "#D1D5DB", fontWeight: 600 }}>{tp.styleName}</div>
          <div style={{ color: "#6B7280", fontSize: 12, marginTop: 2 }}>{tp.brand}{tp.season ? ` · ${tp.season}` : ""}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ color: "#94A3B8", fontSize: 13 }}>{tp.category}</div>
          <div style={{ color: "#6B7280", fontSize: 12, marginTop: 4 }}>Updated {fmtDate(tp.updatedAt)}</div>
        </div>
      </div>
    );
  }

  // ── Materials View ────────────────────────────────────────────────────────
  function renderMaterialsView() {
    const filteredMats = materials.filter(m => {
      if (matTypeFilter && m.type !== matTypeFilter) return false;
      if (matSearch) {
        const q = matSearch.toLowerCase();
        return m.name.toLowerCase().includes(q) || m.supplier.toLowerCase().includes(q) || m.composition.toLowerCase().includes(q);
      }
      return true;
    });

    return (
      <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ margin: 0, color: "#F1F5F9", fontSize: 22 }}>Materials Library</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => downloadMaterialsExcel(materials)}
              style={{ background: "#1D6F42", border: "none", borderRadius: 6, padding: "6px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit", transition: "background 0.15s" }}
              onMouseEnter={e => e.currentTarget.style.background = "#155734"}
              onMouseLeave={e => e.currentTarget.style.background = "#1D6F42"}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" fill="#fff" fillOpacity=".2" stroke="#fff" strokeWidth="1.5"/><path d="M14 2v6h6" stroke="#fff" strokeWidth="1.5"/><path d="M8 13l2.5 4M8 17l2.5-4M13 13v4M15.5 13v4M13 15h2.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Excel
            </button>
            <button style={S.btnPrimarySmall} onClick={() => {
              setEditingMaterial(null);
              setMatForm({ name: "", type: "Fabric", composition: "", weight: "", width: "", color: "", supplier: "", unitPrice: 0, moq: "", leadTime: "", certifications: "", notes: "" });
              setShowMaterialModal(true);
            }}>+ Add Material</button>
          </div>
        </div>

        <div style={S.filters}>
          <input style={{ ...S.input, maxWidth: 300 }} placeholder="Search materials..." value={matSearch} onChange={e => setMatSearch(e.target.value)} />
          <select style={S.select} value={matTypeFilter} onChange={e => setMatTypeFilter(e.target.value)}>
            <option value="">All Types</option>
            {MATERIAL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <span style={{ color: "#6B7280", fontSize: 13 }}>{filteredMats.length} materials</span>
        </div>

        {filteredMats.length === 0 ? (
          <div style={S.emptyState}>
            <div style={{ fontSize: 40 }}>🧵</div>
            <p>No materials found. Add your first material!</p>
          </div>
        ) : (
          <div style={S.tableWrap}>
            <div style={S.tableHeader}>
              <span style={{ flex: 2 }}>Name</span>
              <span style={{ flex: 1 }}>Type</span>
              <span style={{ flex: 2 }}>Composition</span>
              <span style={{ flex: 1 }}>Weight</span>
              <span style={{ flex: 1 }}>Supplier</span>
              <span style={{ flex: 1 }}>Price</span>
              <span style={{ flex: 1 }}>Certs</span>
              <span style={{ width: 60 }}>Actions</span>
            </div>
            {filteredMats.map((m, i) => (
              <div key={m.id} style={{ ...S.tableRow, background: i % 2 === 0 ? "#0F172A" : "#1A2332" }}>
                <span style={{ flex: 2, color: "#60A5FA", fontWeight: 600 }}>{m.name}</span>
                <span style={{ flex: 1, color: "#94A3B8" }}>{m.type}</span>
                <span style={{ flex: 2, color: "#D1D5DB" }}>{m.composition}</span>
                <span style={{ flex: 1, color: "#94A3B8" }}>{m.weight}</span>
                <span style={{ flex: 1, color: "#94A3B8" }}>{m.supplier}</span>
                <span style={{ flex: 1, color: "#10B981", fontWeight: 600 }}>{fmtCurrency(m.unitPrice)}</span>
                <span style={{ flex: 1 }}>
                  {m.certifications.map(c => <span key={c} style={{ ...S.badge, background: "#10B98122", color: "#10B981", border: "1px solid #10B98144", marginRight: 4 }}>{c}</span>)}
                </span>
                <span style={{ width: 60, display: "flex", gap: 4 }}>
                  <button style={S.iconBtn} onClick={() => {
                    setEditingMaterial(m);
                    setMatForm({ name: m.name, type: m.type, composition: m.composition, weight: m.weight, width: m.width, color: m.color, supplier: m.supplier, unitPrice: m.unitPrice, moq: m.moq, leadTime: m.leadTime, certifications: m.certifications.join(", "), notes: m.notes });
                    setShowMaterialModal(true);
                  }}>✏️</button>
                  <button style={S.iconBtn} onClick={() => setConfirmDialog({ title: "Delete Material", message: `Delete "${m.name}"? This cannot be undone.`, onConfirm: () => saveMaterials(materials.filter(x => x.id !== m.id)) })}>🗑️</button>
                </span>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  // ── Excel: spec sheet builder (matches Mens_Jeans_Template format) ─────────
  function buildSpecSheetWb(sheet: SpecSheet, isTemplate: boolean): any {
    const XLSX = (window as any).XLSX;
    if (!XLSX) { showToast("Excel library loading — try again in a moment"); return null; }

    const sizes = sheet.sizes;
    const n = sizes.length;
    // Col layout: 0=spacer  1=POM letter  2=Description  3=TOL  4..4+n-1=sizes
    const C_SPC = 0, C_POM = 1, C_DESC = 2, C_TOL = 3, C_SZ = 4;
    const totalCols = C_SZ + n;
    const baseSzIdx = Math.floor(n / 2);

    // ── Cell helpers ─────────────────────────────────────────────────────────
    const ws: any = {};
    const merges: any[] = [];
    const ec = (r: number, c: number) => XLSX.utils.encode_cell({ r, c });
    const thin = (rgb = "BBCBD9") => ({ style: "thin" as const, color: { rgb } });
    const bdr  = (rgb = "BBCBD9") => ({ top: thin(rgb), bottom: thin(rgb), left: thin(rgb), right: thin(rgb) });

    const cell = (r: number, c: number, v: any, s: any) => {
      const a = ec(r, c);
      const t = v === null || v === "" || v === undefined ? "z" : typeof v === "number" ? "n" : "s";
      ws[a] = { v: v ?? "", t, s };
    };
    const blankCell = (r: number, c: number, fill: string) =>
      cell(r, c, "", { fill: { fgColor: { rgb: fill } } });
    const merge = (r1: number, c1: number, r2: number, c2: number) =>
      merges.push({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } });

    // ── Colors ───────────────────────────────────────────────────────────────
    const NAVY  = "1B2A4A", GOLD = "C9A84C", LTBLUE = "EEF4FC";
    const SECBL = "4A6FA5", BASEBG = "1A5276", BASEFG = "FFD700";
    const WHITE = "FFFFFF", DARK  = "3C3C3C", RED    = "C0392B";
    const FILLS = ["EEF4FC", "FFFFFF"];
    const DBLU  = "D6E4F7"; // base size cell bg in data rows

    let r = 0;

    // ── Row 0: spacer ────────────────────────────────────────────────────────
    r++; // start writing at r=1

    // ── Row 1: Title (navy, bold, white) ─────────────────────────────────────
    const titleTxt = sheet.styleName
      ? `TECHNICAL SPECIFICATION  ·  ${sheet.styleName.toUpperCase()}`
      : "TECHNICAL SPECIFICATION  ·  SPEC SHEET";
    cell(r, C_POM, titleTxt, {
      fill: { fgColor: { rgb: NAVY } }, font: { bold: true, sz: 14, name: "Arial", color: { rgb: WHITE } },
      alignment: { horizontal: "center", vertical: "center" },
    });
    merge(r, C_POM, r, totalCols - 1);
    for (let c = C_DESC; c < totalCols; c++) blankCell(r, c, NAVY);
    blankCell(r, C_SPC, NAVY);
    r++;

    // ── Row 2: Subtitle (gold, small, white) ──────────────────────────────────
    const baseSize = sizes[baseSzIdx] || sizes[0] || "—";
    cell(r, C_POM, `GRADE RULE MEASUREMENT CHART  |  BASE SIZE: ${baseSize}  |  UNIT: INCHES  |  MEASUREMENTS ARE TOTAL (DOUBLED)`, {
      fill: { fgColor: { rgb: GOLD } }, font: { sz: 8, name: "Arial", color: { rgb: WHITE } },
      alignment: { horizontal: "center", vertical: "center" },
    });
    merge(r, C_POM, r, totalCols - 1);
    for (let c = C_DESC; c < totalCols; c++) blankCell(r, c, GOLD);
    blankCell(r, C_SPC, GOLD);
    r++;

    // ── Rows 3–5: Metadata (3 rows, 3 label/value pairs each) ────────────────
    const lblSty = { fill: { fgColor: { rgb: LTBLUE } }, font: { bold: true, sz: 9, name: "Arial", color: { rgb: NAVY } }, alignment: { horizontal: "right", vertical: "center" }, border: bdr("C0C8D4") };
    const valSty = { fill: { fgColor: { rgb: WHITE } }, font: { sz: 9, name: "Arial", color: { rgb: DARK } }, alignment: { horizontal: "left", vertical: "center" }, border: bdr("C0C8D4") };
    const meta = [
      ["Style #:", isTemplate ? "" : sheet.styleNumber,  "Season:", isTemplate ? "" : sheet.season,   "Vendor:", ""],
      ["Style Name / Fit:", isTemplate ? "" : sheet.styleName, "Issue Date:", "", "Customer:", isTemplate ? "" : sheet.brand],
      ["Brand:", isTemplate ? "" : (sheet.brand || ""),  "Category:", isTemplate ? "" : sheet.category, "Sub Category:", isTemplate ? "" : ((sheet as any).subCategory || "")],
    ];
    // Split available cols (1..totalCols-1) into 3 bands; label=2 cols, value=rest
    const bandW = Math.floor((totalCols - 1) / 3);
    for (const [l1, v1, l2, v2, l3, v3] of meta) {
      const bands = [[1, l1, v1], [1 + bandW, l2, v2], [1 + bandW * 2, l3, v3]] as [number, string, string][];
      for (const [start, lbl, val] of bands) {
        const lblEnd = start + 1, valEnd = Math.min(start + bandW - 1, totalCols - 1);
        cell(r, start, lbl, lblSty); blankCell(r, start + 1, LTBLUE); merge(r, start, r, lblEnd);
        cell(r, start + 2, val, valSty);
        for (let c = start + 3; c <= valEnd; c++) blankCell(r, c, WHITE);
        merge(r, start + 2, r, valEnd);
      }
      blankCell(r, C_SPC, LTBLUE);
      r++;
    }

    // ── Row 6: Column headers ─────────────────────────────────────────────────
    const hdr = (bg: string, fg: string, bold = true) => ({
      fill: { fgColor: { rgb: bg } }, font: { bold, sz: 8, name: "Arial", color: { rgb: fg } },
      alignment: { horizontal: "center", vertical: "center", wrapText: true }, border: bdr("0F2840"),
    });
    blankCell(r, C_SPC, NAVY);
    cell(r, C_POM,  "POM",         hdr(NAVY, WHITE));
    cell(r, C_DESC, "DESCRIPTION", hdr(NAVY, WHITE));
    cell(r, C_TOL,  "TOL",         hdr(NAVY, WHITE));
    for (let i = 0; i < n; i++) {
      const isBase = i === baseSzIdx;
      cell(r, C_SZ + i, sizes[i], hdr(isBase ? BASEBG : NAVY, isBase ? BASEFG : WHITE));
    }
    r++;

    // ── Data rows ─────────────────────────────────────────────────────────────
    let fillIdx = 0;
    for (const row of sheet.rows) {
      if (row.isSection) {
        // Section header: full-width medium blue
        blankCell(r, C_SPC, SECBL);
        cell(r, C_POM, row.pointOfMeasure, {
          fill: { fgColor: { rgb: SECBL } }, font: { bold: true, sz: 9, name: "Arial", color: { rgb: WHITE } },
          alignment: { horizontal: "left", vertical: "center" }, border: bdr("2D4A6A"),
        });
        merge(r, C_POM, r, totalCols - 1);
        for (let c = C_DESC; c < totalCols; c++) cell(r, c, "", { fill: { fgColor: { rgb: SECBL } }, border: bdr("2D4A6A") });
        fillIdx = 0;
        r++;
      } else {
        const fh = FILLS[fillIdx % 2]; fillIdx++;
        // Parse POM letter (pattern: "A  Description" or "AA  Description")
        const m = row.pointOfMeasure.match(/^([A-Z]{1,2})\s{2,}(.+)/);
        const letter = m ? m[1] : "";
        const desc   = m ? m[2] : row.pointOfMeasure;
        blankCell(r, C_SPC, fh);
        cell(r, C_POM,  letter,        { fill: { fgColor: { rgb: fh } }, font: { bold: true, sz: 8, name: "Arial", color: { rgb: "6B6B6B" } }, alignment: { horizontal: "center", vertical: "center" }, border: bdr() });
        cell(r, C_DESC, desc,          { fill: { fgColor: { rgb: fh } }, font: { bold: true, sz: 9, name: "Arial", color: { rgb: DARK } },    alignment: { horizontal: "left",   vertical: "center", wrapText: true }, border: bdr() });
        cell(r, C_TOL,  row.tolerance, { fill: { fgColor: { rgb: fh } }, font: { bold: true, sz: 9, name: "Arial", color: { rgb: RED } },     alignment: { horizontal: "center", vertical: "center" }, border: bdr() });
        for (let i = 0; i < n; i++) {
          const isBase = i === baseSzIdx;
          const bg = isBase ? DBLU : fh;
          const rawVal = row.values[sizes[i]] ?? "";
          const val = rawVal === "" ? "" : (isNaN(Number(rawVal)) ? rawVal : Number(rawVal));
          cell(r, C_SZ + i, val, {
            fill: { fgColor: { rgb: bg } },
            font: { bold: isBase, sz: 9, name: "Arial", color: { rgb: NAVY } },
            alignment: { horizontal: "center", vertical: "center" },
            border: bdr(),
          });
        }
        r++;
      }
    }

    // If template with no rows, add empty POM rows
    if (sheet.rows.length === 0) {
      for (let i = 0; i < 8; i++) {
        const fh = FILLS[i % 2];
        blankCell(r, C_SPC, fh);
        cell(r, C_POM,  "", { fill: { fgColor: { rgb: fh } }, border: bdr() });
        cell(r, C_DESC, "", { fill: { fgColor: { rgb: fh } }, border: bdr(), alignment: { horizontal: "left", vertical: "center" } });
        cell(r, C_TOL,  "", { fill: { fgColor: { rgb: fh } }, border: bdr() });
        for (let j = 0; j < n; j++) {
          cell(r, C_SZ + j, "", { fill: { fgColor: { rgb: j === baseSzIdx ? DBLU : fh } }, border: bdr() });
        }
        r++;
      }
    }

    // ── Finalize ──────────────────────────────────────────────────────────────
    ws["!ref"]    = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: r - 1, c: totalCols - 1 } });
    ws["!merges"] = merges;
    ws["!cols"]   = [
      { wch: 2.5 }, { wch: 6 }, { wch: 34 }, { wch: 8 },
      ...sizes.map((_: any, i: number) => ({ wch: i === baseSzIdx ? 9 : 7.5 })),
    ];
    const rowH: any[] = [
      { hpt: 6 }, { hpt: 22 }, { hpt: 16 },
      { hpt: 18 }, { hpt: 18 }, { hpt: 18 }, // meta rows
      { hpt: 22 }, // col headers
    ];
    for (const row of sheet.rows) rowH.push({ hpt: row.isSection ? 18 : 17 });
    if (sheet.rows.length === 0) for (let i = 0; i < 8; i++) rowH.push({ hpt: 18 });
    ws["!rows"] = rowH;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Spec Sheet");
    return wb;
  }

  function xlsxDownload(wb: any, filename: string) {
    const XLSX = (window as any).XLSX;
    if (!XLSX) { showToast("Excel library loading — try again in a moment"); return; }
    try {
      const out = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
      const blob = new Blob([out], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Excel download error:", e);
      showToast("Excel download failed — see console");
    }
  }

  function downloadSpecSheetExcel(sheet: SpecSheet) {
    const wb = buildSpecSheetWb(sheet, false);
    if (wb) xlsxDownload(wb, `SpecSheet_${sheet.styleNumber || sheet.styleName}.xlsx`);
  }

  function downloadSpecSheetTemplate(sizes: string[]) {
    const dummy: SpecSheet = { id: "", styleName: "", styleNumber: "", brand: "", season: "", category: "", description: "", sizes, rows: [], createdAt: today(), updatedAt: today() };
    const wb = buildSpecSheetWb(dummy, true);
    if (wb) xlsxDownload(wb, "SpecSheet_Template.xlsx");
  }

  function downloadMaterialsExcel(mats: Material[]) {
    const XLSX = (window as any).XLSX;
    if (!XLSX) { showToast("Excel library loading — try again in a moment"); return; }
    const makeBorder = () => { const bdr = { style: "thin", color: { rgb: "CBD5E0" } }; return { top: bdr, bottom: bdr, left: bdr, right: bdr }; };
    const wb = XLSX.utils.book_new();
    const headers = ["Name", "Type", "Composition", "Weight", "Width", "Color", "Supplier", "Unit Price", "MOQ", "Lead Time", "Certifications", "Notes"];
    const aoa: any[][] = [];

    // Title row
    const titleRow = ["MATERIALS LIBRARY"];
    for (let i = 1; i < headers.length; i++) titleRow.push(null);
    aoa.push(titleRow);

    // Header row
    aoa.push([...headers]);

    // Data rows
    mats.forEach(m => {
      aoa.push([m.name, m.type, m.composition, m.weight, m.width, m.color, m.supplier, m.unitPrice, m.moq, m.leadTime, m.certifications.join(", "), m.notes]);
    });

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const totalCols = headers.length;

    ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: totalCols - 1 } }];

    // Auto column widths
    const colWidths = headers.map((h: string) => ({ wch: Math.max(h.length + 2, 14) }));
    mats.forEach(m => {
      const row = [m.name, m.type, m.composition, m.weight, m.width, m.color, m.supplier, String(m.unitPrice), m.moq, m.leadTime, m.certifications.join(", "), m.notes];
      row.forEach((val, i) => { if (val && val.length + 2 > (colWidths[i]?.wch || 0)) colWidths[i] = { wch: Math.min(val.length + 2, 40) }; });
    });
    ws["!cols"] = colWidths;

    const navyBg = { fgColor: { rgb: "1E3A8A" } };
    const blueBg = { fgColor: { rgb: "2563EB" } };
    const whiteFg = { rgb: "FFFFFF" };

    // Title
    const titleAddr = XLSX.utils.encode_cell({ r: 0, c: 0 });
    ws[titleAddr].s = { fill: navyBg, font: { bold: true, color: whiteFg, sz: 14 }, alignment: { horizontal: "center" }, border: makeBorder() };

    // Headers
    for (let c = 0; c < totalCols; c++) {
      const addr = XLSX.utils.encode_cell({ r: 1, c });
      if (!ws[addr]) ws[addr] = { t: "z" };
      ws[addr].s = { fill: blueBg, font: { bold: true, color: whiteFg, sz: 11 }, alignment: { horizontal: "center" }, border: makeBorder() };
    }

    // Data rows
    mats.forEach((_m, idx) => {
      const rowIdx = idx + 2;
      const bg = idx % 2 === 0 ? { fgColor: { rgb: "0F172A" } } : { fgColor: { rgb: "1A2332" } };
      for (let c = 0; c < totalCols; c++) {
        const addr = XLSX.utils.encode_cell({ r: rowIdx, c });
        if (!ws[addr]) ws[addr] = { t: "z" };
        ws[addr].s = {
          fill: bg,
          font: { bold: c === 0, color: c === 0 ? { rgb: "60A5FA" } : whiteFg, sz: 11 },
          border: makeBorder(),
        };
      }
    });

    XLSX.utils.book_append_sheet(wb, ws, "Materials");
    xlsxDownload(wb, "Materials_Library.xlsx");
  }

  async function parseSpecSheetExcel(file: File): Promise<{ rows: SpecSheetRow[]; sizes: string[] }> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const XLSX = (window as any).XLSX;
          if (!XLSX) { reject(new Error("Excel library not loaded")); return; }
          const data = e.target?.result;
          const wb = XLSX.read(data, { type: "binary" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

          // Detect format:
          // New format: row with col[0]="POM", col[1]="BLOCK SPECS", col[5]="TOL. +/-"
          //             sizes row above it has size values at cols 6,8,10,...
          // Legacy flat format: row with col[0]="Point of Measure" or "POM", sizes in col 2+
          let sizesRowIdx = -1;
          let headerRowIdx = -1;
          let sizes: string[] = [];
          let newFormat = false;

          for (let i = 0; i < aoa.length; i++) {
            const row = aoa[i];
            const c0 = String(row[0] || "").trim().toUpperCase();
            const c1 = String(row[1] || "").trim().toUpperCase();
            if (c0 === "POM" && c1.includes("BLOCK")) {
              // New format: sizes are in the row above at cols 6,8,10,...
              headerRowIdx = i;
              sizesRowIdx = i - 1;
              newFormat = true;
              const sizeRow = aoa[sizesRowIdx] || [];
              for (let c = 6; c < sizeRow.length; c += 2) {
                const s = String(sizeRow[c] || "").trim();
                if (s) sizes.push(s);
              }
              break;
            }
            if (c0 === "POINT OF MEASURE" || c0 === "POM") {
              headerRowIdx = i;
              sizes = row.slice(2).map((s: any) => String(s).trim()).filter(Boolean);
              break;
            }
          }

          if (headerRowIdx === -1) {
            reject(new Error("Could not find spec sheet header row"));
            return;
          }

          const rows: SpecSheetRow[] = [];
          for (let i = headerRowIdx + 1; i < aoa.length; i++) {
            const row = aoa[i];
            if (newFormat) {
              const letter = String(row[0] || "").trim();
              const desc = String(row[1] || "").trim();
              if (!desc && !letter) continue;
              const pom = desc || letter;
              const tolerance = String(row[5] || "").trim();
              const values: Record<string, string> = {};
              sizes.forEach((s, si) => {
                const v = row[6 + si * 2];
                values[s] = v !== undefined && v !== "" ? String(v) : "";
              });
              rows.push({ id: uid(), pointOfMeasure: pom, tolerance, values });
            } else {
              const pom = String(row[0] || "").trim();
              if (!pom) continue;
              const tolerance = String(row[1] || "").trim();
              const values: Record<string, string> = {};
              sizes.forEach((s, idx) => { values[s] = String(row[2 + idx] || "").trim(); });
              rows.push({ id: uid(), pointOfMeasure: pom, tolerance, values });
            }
          }

          resolve({ rows, sizes });
        } catch (err) { reject(err); }
      };
      reader.onerror = reject;
      reader.readAsBinaryString(file);
    });
  }

  // ── Libraries View ────────────────────────────────────────────────────────
  function renderLibrariesView() {
    return (
      <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ margin: 0, color: "#F1F5F9", fontSize: 22 }}>Libraries</h2>
        </div>
        {/* Sub-nav tabs */}
        <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #334155", marginBottom: 20 }}>
          {([["materials", "🧵 Materials"], ["specsheets", "📏 Spec Sheets"]] as const).map(([key, label]) => (
            <button key={key} onClick={() => setLibTab(key)}
              style={{ padding: "10px 20px", background: "none", border: "none", borderBottom: libTab === key ? "2px solid #3B82F6" : "2px solid transparent", color: libTab === key ? "#60A5FA" : "#6B7280", fontSize: 14, fontWeight: libTab === key ? 700 : 500, cursor: "pointer", fontFamily: "inherit" }}>
              {label}
            </button>
          ))}
        </div>
        {libTab === "materials" && renderMaterialsView()}
        {libTab === "specsheets" && renderSpecSheetsView()}
      </>
    );
  }

  // ── Spec Sheets View ──────────────────────────────────────────────────────
  function renderSpecSheetsView() {
    const filteredSS = specSheets.filter(ss => {
      if (!ssSearch) return true;
      const q = ssSearch.toLowerCase();
      return ss.styleName.toLowerCase().includes(q) || ss.styleNumber.toLowerCase().includes(q) || ss.brand.toLowerCase().includes(q);
    });

    return (
      <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flex: 1 }}>
            <input style={{ ...S.input, maxWidth: 300 }} placeholder="Search spec sheets..." value={ssSearch} onChange={e => setSsSearch(e.target.value)} />
            <span style={{ color: "#6B7280", fontSize: 13 }}>{filteredSS.length} spec sheets</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setShowTemplatesModal(true)}
              style={{ background: "#334155", border: "1px solid #475569", borderRadius: 6, padding: "6px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, color: "#F1F5F9", fontSize: 12, fontWeight: 600, fontFamily: "inherit", transition: "background 0.15s" }}
              onMouseEnter={e => e.currentTarget.style.background = "#475569"}
              onMouseLeave={e => e.currentTarget.style.background = "#334155"}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1.5" stroke="#F1F5F9" strokeWidth="1.7"/><rect x="14" y="3" width="7" height="7" rx="1.5" stroke="#F1F5F9" strokeWidth="1.7"/><rect x="3" y="14" width="7" height="7" rx="1.5" stroke="#F1F5F9" strokeWidth="1.7"/><rect x="14" y="14" width="7" height="7" rx="1.5" stroke="#F1F5F9" strokeWidth="1.7"/></svg>
              Templates ▾
            </button>
            <div style={{ position: "relative" }}>
              <button style={S.btnPrimarySmall} onClick={() => setShowAddImportMenu(v => !v)}>
                + Add / Import ▾
              </button>
              {showAddImportMenu && (
                <>
                  <div style={{ position: "fixed", inset: 0, zIndex: 299 }} onClick={() => setShowAddImportMenu(false)} />
                  <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", background: "#1E293B", border: "1px solid #334155", borderRadius: 10, padding: 6, zIndex: 300, minWidth: 200, boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
                    <button style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 14px", background: "none", border: "none", color: "#F1F5F9", fontSize: 13, fontWeight: 600, cursor: "pointer", borderRadius: 6, fontFamily: "inherit", textAlign: "left" }}
                      onMouseEnter={e => e.currentTarget.style.background = "#334155"}
                      onMouseLeave={e => e.currentTarget.style.background = "none"}
                      onClick={() => {
                        setShowAddImportMenu(false);
                        setSsForm({ styleName: "", styleNumber: "", brand: "", season: "", category: "", subCategory: "", gender: "", vendor: "", description: "", sizes: "XS, S, M, L, XL, XXL" });
                        setEditingSpecSheet(null);
                        setShowSpecSheetModal(true);
                      }}>
                      <span style={{ fontSize: 16 }}>📏</span>
                      <div>
                        <div>Add New Spec Sheet</div>
                        <div style={{ fontSize: 11, color: "#6B7280", fontWeight: 400 }}>Create from scratch</div>
                      </div>
                    </button>
                    <div style={{ height: 1, background: "#334155", margin: "4px 0" }} />
                    <label style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 14px", background: "none", border: "none", color: "#F1F5F9", fontSize: 13, fontWeight: 600, cursor: "pointer", borderRadius: 6, fontFamily: "inherit" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "#334155")}
                      onMouseLeave={e => (e.currentTarget.style.background = "none")}>
                      <span style={{ fontSize: 16 }}>📤</span>
                      <div>
                        <div>Import from Excel</div>
                        <div style={{ fontSize: 11, color: "#6B7280", fontWeight: 400 }}>Upload .xlsx file</div>
                      </div>
                      <input type="file" accept=".xlsx,.csv" style={{ display: "none" }} onChange={async e => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        setShowAddImportMenu(false);
                        try {
                          showToast("Parsing file...");
                          const XLSX = (window as any).XLSX;
                          if (!XLSX) { showToast("Excel library loading — try again"); return; }
                          const reader = new FileReader();
                          reader.onload = ev => {
                            try {
                              const wb = XLSX.read(ev.target?.result, { type: "binary" });
                              const ws = wb.Sheets[wb.SheetNames[0]];
                              const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
                              // Detect header row
                              let headerRowIdx = -1; let sizes: string[] = []; let newFmt = false;
                              for (let i = 0; i < aoa.length; i++) {
                                const c0 = String(aoa[i][0] || "").trim().toUpperCase();
                                const c1 = String(aoa[i][1] || "").trim().toUpperCase();
                                if (c0 === "POM" && c1.includes("BLOCK")) { headerRowIdx = i; newFmt = true; const sr = aoa[i - 1] || []; for (let c = 6; c < sr.length; c += 2) { const s = String(sr[c] || "").trim(); if (s) sizes.push(s); } break; }
                                if (c0 === "POINT OF MEASURE" || c0 === "POM") { headerRowIdx = i; sizes = aoa[i].slice(2).map((s: any) => String(s).trim()).filter(Boolean); break; }
                              }
                              if (headerRowIdx === -1) { showToast("Could not find spec sheet header row"); return; }
                              const rows: any[] = [];
                              for (let i = headerRowIdx + 1; i < aoa.length; i++) {
                                const row = aoa[i];
                                const desc = newFmt ? String(row[1] || "").trim() : String(row[0] || "").trim();
                                if (!desc) continue;
                                const tol = newFmt ? String(row[5] || "").trim() : String(row[1] || "").trim();
                                const values: Record<string, string> = {};
                                sizes.forEach((s, si) => { values[s] = newFmt ? String(row[6 + si * 2] ?? "") : String(row[2 + si] ?? ""); });
                                rows.push({ id: uid(), pointOfMeasure: desc, tolerance: tol, values });
                              }
                              // Extract style info from header rows
                              let styleName = "", styleNumber = "", brand = "", season = "";
                              for (const row of aoa.slice(0, 6)) {
                                for (let c = 0; c < row.length; c++) {
                                  const v = String(row[c] || "").toUpperCase().trim();
                                  if (v === "STYLE #:" || v === "STYLE #") styleNumber = String(row[c + 1] || "").trim();
                                  if (v === "STYLE NAME / FIT:" || v === "STYLE NAME:") styleName = String(row[c + 1] || "").trim();
                                  if (v === "CUSTOMER:") brand = String(row[c + 1] || "").trim();
                                  if (v === "SEASON:") season = String(row[c + 1] || "").trim();
                                }
                              }
                              const newSheet: SpecSheet = { id: uid(), styleName: styleName || file.name.replace(/\.[^.]+$/, ""), styleNumber, brand, season, category: "", description: "", sizes, rows, createdAt: today(), updatedAt: today() };
                              saveSpecSheets([...specSheets, newSheet]);
                              setSelectedSpecSheet(newSheet);
                              showToast(`Imported ${rows.length} measurements`);
                            } catch (err) { showToast("Parse failed — check file format"); console.error(err); }
                          };
                          reader.readAsBinaryString(file);
                        } catch (err) { showToast("Import failed"); console.error(err); }
                        e.target.value = "";
                      }} />
                    </label>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {filteredSS.length === 0 ? (
          <div style={S.emptyState}>
            <div style={{ fontSize: 40 }}>📏</div>
            <p>No spec sheets yet. Create your first one or upload from Excel.</p>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
            {filteredSS.map(ss => (
              <div key={ss.id} style={{ ...S.tpCard, cursor: "pointer" }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = "#3B82F6")}
                onMouseLeave={e => (e.currentTarget.style.borderColor = "#334155")}
                onClick={() => setSelectedSpecSheet(ss)}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                  <span style={{ fontFamily: "monospace", color: "#60A5FA", fontWeight: 700, fontSize: 15 }}>{ss.styleNumber || "—"}</span>
                  <span style={{ color: "#6B7280", fontSize: 11 }}>{ss.rows.length} measurements</span>
                </div>
                <div style={{ color: "#F1F5F9", fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{ss.styleName}</div>
                <div style={{ color: "#94A3B8", fontSize: 13, marginBottom: 8 }}>{ss.brand}{ss.season ? ` · ${ss.season}` : ""}</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ color: "#6B7280", fontSize: 12 }}>{ss.category}</span>
                  <div style={{ display: "flex", gap: 4 }} onClick={e => e.stopPropagation()}>
                    <button title="Download Excel" onClick={() => downloadSpecSheetExcel(ss)}
                      style={{ background: "#1D6F42", border: "none", borderRadius: 5, padding: "3px 7px", cursor: "pointer", display: "flex", alignItems: "center", gap: 3, color: "#fff", fontSize: 11, fontWeight: 600, fontFamily: "inherit" }}
                      onMouseEnter={e => e.currentTarget.style.background = "#155734"}
                      onMouseLeave={e => e.currentTarget.style.background = "#1D6F42"}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" fill="#fff" fillOpacity=".2" stroke="#fff" strokeWidth="1.5"/><path d="M14 2v6h6" stroke="#fff" strokeWidth="1.5"/><path d="M8 13l2.5 4M8 17l2.5-4M13 13v4M15.5 13v4M13 15h2.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </button>
                    <button style={S.iconBtnTiny} title="Edit" onClick={() => { setSelectedSpecSheet(ss); }}>✏️</button>
                    <button style={{ ...S.iconBtnTiny, color: "#EF4444" }} title="Delete" onClick={() => {
                      setConfirmDialog({ title: "Delete Spec Sheet", message: `Delete "${ss.styleName || ss.styleNumber || "this spec sheet"}"? This cannot be undone.`, onConfirm: () => saveSpecSheets(specSheets.filter(x => x.id !== ss.id)) });
                    }}>🗑️</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  // ── Spec Sheet Detail Panel ───────────────────────────────────────────────
  function renderSpecSheetDetail() {
    const ss = selectedSpecSheet!;
    const sizes = ss.sizes;

    const updateSS = (changes: Partial<SpecSheet>) => {
      const updated = { ...ss, ...changes, updatedAt: today() };
      setSelectedSpecSheet(updated);
      saveSpecSheets(specSheets.map(x => x.id === updated.id ? updated : x));
    };

    const addRow = () => {
      const sizeObj: Record<string, string> = {};
      sizes.forEach(s => { sizeObj[s] = ""; });
      updateSS({ rows: [...ss.rows, { id: uid(), pointOfMeasure: "", tolerance: "±0.5", values: sizeObj }] });
    };

    const addSizeCol = (sizeName: string) => {
      if (!sizeName.trim()) return;
      const newSizes = [...sizes, sizeName.trim()];
      const newRows = ss.rows.map(r => ({ ...r, values: { ...r.values, [sizeName.trim()]: "" } }));
      updateSS({ sizes: newSizes, rows: newRows });
    };

    const removeSizeCol = (sizeName: string) => {
      const newSizes = sizes.filter(s => s !== sizeName);
      const newRows = ss.rows.map(r => {
        const v = { ...r.values };
        delete v[sizeName];
        return { ...r, values: v };
      });
      updateSS({ sizes: newSizes, rows: newRows });
    };

    return (
      <div style={S.detailOverlay} onClick={() => setSelectedSpecSheet(null)}>
        <div style={S.detailPanel} onClick={e => e.stopPropagation()}>
          {/* Header */}
          <div style={S.detailHeader}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={S.detailPONum}>{ss.styleNumber || "—"}</span>
              </div>
              <div style={S.detailVendor}>{ss.styleName}</div>
              <div style={{ color: "#6B7280", fontSize: 13, marginTop: 4 }}>{ss.brand}{ss.season ? ` · ${ss.season}` : ""}{ss.category ? ` · ${ss.category}` : ""}</div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <button onClick={() => downloadSpecSheetExcel(ss)}
                style={{ background: "#1D6F42", border: "none", borderRadius: 6, padding: "6px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit", transition: "background 0.15s" }}
                onMouseEnter={e => e.currentTarget.style.background = "#155734"}
                onMouseLeave={e => e.currentTarget.style.background = "#1D6F42"}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" fill="#fff" fillOpacity=".2" stroke="#fff" strokeWidth="1.5"/><path d="M14 2v6h6" stroke="#fff" strokeWidth="1.5"/><path d="M8 13l2.5 4M8 17l2.5-4M13 13v4M15.5 13v4M13 15h2.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Excel
              </button>
              <label style={S.btnSmall} title="Upload from Excel">
                📤 Upload Excel
                <input type="file" accept=".xlsx,.csv" style={{ display: "none" }} onChange={async e => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    showToast("Parsing file...");
                    const result = await parseSpecSheetExcel(file);
                    updateSS({ rows: result.rows, sizes: result.sizes });
                    showToast("Spec sheet imported!");
                  } catch (err) {
                    showToast("Failed to parse file");
                    console.error(err);
                  }
                }} />
              </label>
              <button style={S.closeBtn} onClick={() => setSelectedSpecSheet(null)}>✕</button>
            </div>
          </div>

          {/* Content */}
          <div style={{ padding: 24, flex: 1, overflowY: "auto" }}>
            {/* Style Info */}
            {(() => {
              const selStyle = { ...S.input, appearance: "none" as const };
              const ssPres = [
                { label: "XS–XXL", sizes: ["XS", "S", "M", "L", "XL", "XXL"] },
                { label: "28–40 (even)", sizes: ["28", "30", "32", "34", "36", "38", "40"] },
                { label: "28–48 (all)", sizes: ["28", "29", "30", "31", "32", "33", "34", "35", "36", "38", "40", "42", "44", "46", "48"] },
                { label: "0–16 (kids)", sizes: ["0", "2", "4", "6", "8", "10", "12", "14", "16"] },
              ];
              const detCatObj = dcCategories.find((c: any) => c.name === ss.category);
              const detSubCats: string[] = detCatObj?.subCategories || [];
              return (
                <div style={{ background: "#0F172A", borderRadius: 10, padding: 16, marginBottom: 20, border: "1px solid #334155" }}>
                  <div style={{ color: "#94A3B8", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600, marginBottom: 12 }}>Style Info</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
                    <div>
                      <label style={S.label}>Style Name</label>
                      <input style={S.input} value={ss.styleName} onChange={e => updateSS({ styleName: e.target.value })} />
                    </div>
                    <div>
                      <label style={S.label}>Style Number</label>
                      <input style={S.input} value={ss.styleNumber} onChange={e => updateSS({ styleNumber: e.target.value })} />
                    </div>
                    <div>
                      <label style={S.label}>Brand</label>
                      {dcBrands.length > 0 ? (
                        <select style={selStyle} value={ss.brand} onChange={e => updateSS({ brand: e.target.value })}>
                          <option value="">— select —</option>
                          {dcBrands.map((b: any) => <option key={b.name} value={b.name}>{b.name}</option>)}
                        </select>
                      ) : (
                        <input style={S.input} value={ss.brand} onChange={e => updateSS({ brand: e.target.value })} />
                      )}
                    </div>
                    <div>
                      <label style={S.label}>Season</label>
                      {dcSeasons.length > 0 ? (
                        <select style={selStyle} value={ss.season} onChange={e => updateSS({ season: e.target.value })}>
                          <option value="">— select —</option>
                          {dcSeasons.map((s: string) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      ) : (
                        <input style={S.input} value={ss.season} onChange={e => updateSS({ season: e.target.value })} />
                      )}
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
                    <div>
                      <label style={S.label}>Category</label>
                      {dcCategories.length > 0 ? (
                        <select style={selStyle} value={ss.category} onChange={e => updateSS({ category: e.target.value, subCategory: "" })}>
                          <option value="">— select —</option>
                          {dcCategories.map((c: any) => <option key={c.name} value={c.name}>{c.name}</option>)}
                        </select>
                      ) : (
                        <input style={S.input} value={ss.category} onChange={e => updateSS({ category: e.target.value })} />
                      )}
                    </div>
                    {detSubCats.length > 0 && (
                      <div>
                        <label style={S.label}>Sub-Category</label>
                        <select style={selStyle} value={ss.subCategory || ""} onChange={e => updateSS({ subCategory: e.target.value })}>
                          <option value="">— select —</option>
                          {detSubCats.map((sc: string) => <option key={sc} value={sc}>{sc}</option>)}
                        </select>
                      </div>
                    )}
                    <div>
                      <label style={S.label}>Gender</label>
                      {dcGenders.length > 0 ? (
                        <select style={selStyle} value={ss.gender || ""} onChange={e => updateSS({ gender: e.target.value })}>
                          <option value="">— select —</option>
                          {dcGenders.map((g: string) => <option key={g} value={g}>{g}</option>)}
                        </select>
                      ) : (
                        <input style={S.input} value={ss.gender || ""} onChange={e => updateSS({ gender: e.target.value })} />
                      )}
                    </div>
                    <div>
                      <label style={S.label}>Vendor</label>
                      {dcVendors.length > 0 ? (
                        <select style={selStyle} value={ss.vendor || ""} onChange={e => updateSS({ vendor: e.target.value })}>
                          <option value="">— select —</option>
                          {dcVendors.map((v: any) => <option key={v.name} value={v.name}>{v.name}</option>)}
                        </select>
                      ) : (
                        <input style={S.input} value={ss.vendor || ""} onChange={e => updateSS({ vendor: e.target.value })} />
                      )}
                    </div>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <label style={S.label}>Description</label>
                    <input style={S.input} value={ss.description} onChange={e => updateSS({ description: e.target.value })} />
                  </div>
                  <div>
                    <label style={S.label}>Sizes</label>
                    <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6, marginBottom: 8 }}>
                      {ssPres.map(p => (
                        <button key={p.label} style={{ ...S.btnSmall, fontSize: 11 }} onClick={() => {
                          const newRows = ss.rows.map(r => {
                            const v: Record<string, string> = {};
                            p.sizes.forEach(s => { v[s] = r.values[s] || ""; });
                            return { ...r, values: v };
                          });
                          updateSS({ sizes: p.sizes, rows: newRows });
                        }}>{p.label}</button>
                      ))}
                    </div>
                    <input style={S.input} value={ss.sizes.join(", ")} onChange={e => {
                      const newSizes = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
                      const newRows = ss.rows.map(r => {
                        const v: Record<string, string> = {};
                        newSizes.forEach(s => { v[s] = r.values[s] || ""; });
                        return { ...r, values: v };
                      });
                      updateSS({ sizes: newSizes, rows: newRows });
                    }} />
                  </div>
                </div>
              );
            })()}

            {/* Measurements Table */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h3 style={{ margin: 0, color: "#F1F5F9", fontSize: 16 }}>Measurements</h3>
              <div style={{ display: "flex", gap: 8 }}>
                {showNewSizeInput ? (
                  <>
                    <input style={{ ...S.input, width: 80, padding: "4px 8px", fontSize: 12 }} placeholder="Size" value={newSizeInput} onChange={e => setNewSizeInput(e.target.value)} />
                    <button style={S.btnSmall} onClick={() => { addSizeCol(newSizeInput); setNewSizeInput(""); setShowNewSizeInput(false); }}>Add</button>
                    <button style={{ ...S.btnSmall, background: "none", color: "#6B7280" }} onClick={() => setShowNewSizeInput(false)}>Cancel</button>
                  </>
                ) : (
                  <button style={S.btnSmall} onClick={() => setShowNewSizeInput(true)}>+ Size Column</button>
                )}
                <button style={{ ...S.btnSmall, background: "#1E3A5F", color: "#93C5FD", border: "1px solid #2D5A8E" }} onClick={() => updateSS({ rows: [...ss.rows, { id: uid(), pointOfMeasure: "New Section", tolerance: "", values: {}, isSection: true }] })}>+ Section</button>
                <button style={S.btnSmall} onClick={addRow}>+ Measurement</button>
              </div>
            </div>

            {ss.rows.length === 0 ? (
              <div style={{ ...S.emptyState, padding: 30 }}>
                <p style={{ color: "#6B7280", fontSize: 13 }}>No measurements yet. Add rows or upload from Excel.</p>
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={S.table}>
                  <thead>
                    <tr>
                      <th style={S.th}>Point of Measure</th>
                      <th style={S.th}>Tolerance</th>
                      {sizes.map(s => (
                        <th key={s} style={S.th}>
                          {s}
                          <button style={{ ...S.iconBtnTiny, marginLeft: 4 }} onClick={() => removeSizeCol(s)}>✕</button>
                        </th>
                      ))}
                      <th style={S.th}>Del</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ss.rows.map((row, idx) => (
                      row.isSection ? (
                        <tr key={row.id}>
                          <td colSpan={3 + sizes.length} style={{ background: "#1E3A5F", color: "#93C5FD", fontWeight: 700, fontSize: 12, padding: "6px 10px", letterSpacing: 0.5, borderTop: "1px solid #334155", borderBottom: "1px solid #334155" }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                              <input style={{ background: "none", border: "none", color: "#93C5FD", fontWeight: 700, fontSize: 12, width: "100%", fontFamily: "inherit", cursor: "text", letterSpacing: 0.5 }} value={row.pointOfMeasure} onChange={e => { const updated = [...ss.rows]; updated[idx] = { ...row, pointOfMeasure: e.target.value }; updateSS({ rows: updated }); }} />
                              <button style={{ ...S.iconBtnTiny, flexShrink: 0, marginLeft: 4 }} onClick={() => updateSS({ rows: ss.rows.filter(x => x.id !== row.id) })}>🗑️</button>
                            </div>
                          </td>
                        </tr>
                      ) : (
                      <tr key={row.id} style={{ background: idx % 2 === 0 ? "#0F172A" : "#1A2332" }}>
                        <td style={S.td}>
                          <input style={S.cellInput} value={row.pointOfMeasure} onChange={e => {
                            const updated = [...ss.rows];
                            updated[idx] = { ...row, pointOfMeasure: e.target.value };
                            updateSS({ rows: updated });
                          }} placeholder="e.g. Chest" />
                        </td>
                        <td style={S.td}>
                          <input style={{ ...S.cellInput, width: 70 }} value={row.tolerance} onChange={e => {
                            const updated = [...ss.rows];
                            updated[idx] = { ...row, tolerance: e.target.value };
                            updateSS({ rows: updated });
                          }} />
                        </td>
                        {sizes.map(s => (
                          <td key={s} style={S.td}>
                            <input style={{ ...S.cellInput, width: 60, textAlign: "center" }} value={row.values[s] || ""} onChange={e => {
                              const updated = [...ss.rows];
                              updated[idx] = { ...row, values: { ...row.values, [s]: e.target.value } };
                              updateSS({ rows: updated });
                            }} />
                          </td>
                        ))}
                        <td style={S.td}>
                          <button style={S.iconBtnTiny} onClick={() => updateSS({ rows: ss.rows.filter(x => x.id !== row.id) })}>🗑️</button>
                        </td>
                      </tr>
                      )
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Spec Sheet Create Modal ───────────────────────────────────────────────
  function renderSpecSheetModal() {
    const selectStyle = { ...S.input, appearance: "none" as const };
    const sizePresets = [
      { label: "XS–XXL", sizes: ["XS", "S", "M", "L", "XL", "XXL"] },
      { label: "28–40 (even)", sizes: ["28", "30", "32", "34", "36", "38", "40"] },
      { label: "28–48 (all)", sizes: ["28", "29", "30", "31", "32", "33", "34", "35", "36", "38", "40", "42", "44", "46", "48"] },
      { label: "0–16 (kids)", sizes: ["0", "2", "4", "6", "8", "10", "12", "14", "16"] },
    ];
    const selectedCatObj = dcCategories.find((c: any) => c.name === ssForm.category);
    const subCats: string[] = selectedCatObj?.subCategories || [];
    return (
      <div style={S.modalOverlay} onClick={() => setShowSpecSheetModal(false)}>
        <div style={{ ...S.modal, width: 560 }} onClick={e => e.stopPropagation()}>
          <div style={S.modalHeader}>
            <div>
              <h2 style={{ ...S.modalTitle, margin: 0 }}>New Spec Sheet</h2>
              {activeTemplate && (
                <div style={{ fontSize: 12, color: "#60A5FA", marginTop: 4, display: "flex", alignItems: "center", gap: 6 }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1.5" stroke="#60A5FA" strokeWidth="2"/><rect x="14" y="3" width="7" height="7" rx="1.5" stroke="#60A5FA" strokeWidth="2"/><rect x="3" y="14" width="7" height="7" rx="1.5" stroke="#60A5FA" strokeWidth="2"/><rect x="14" y="14" width="7" height="7" rx="1.5" stroke="#60A5FA" strokeWidth="2"/></svg>
                  Using template: <strong>{activeTemplate.name}</strong>
                  <button style={{ background: "none", border: "none", color: "#EF4444", cursor: "pointer", fontSize: 11, padding: "0 2px" }} onClick={() => setActiveTemplate(null)}>✕ Clear</button>
                </div>
              )}
            </div>
            <button style={S.closeBtn} onClick={() => { setShowSpecSheetModal(false); setActiveTemplate(null); }}>✕</button>
          </div>
          <div style={S.modalBody}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Style Name *</label>
                <input style={S.input} value={ssForm.styleName} onChange={e => setSsForm(f => ({ ...f, styleName: e.target.value }))} placeholder="e.g. Classic Oxford" autoFocus />
              </div>
              <div>
                <label style={S.label}>Style Number</label>
                <input style={S.input} value={ssForm.styleNumber} onChange={e => setSsForm(f => ({ ...f, styleNumber: e.target.value }))} placeholder="e.g. OXF-001" />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Brand</label>
                {dcBrands.length > 0 ? (
                  <select style={selectStyle} value={ssForm.brand} onChange={e => setSsForm(f => ({ ...f, brand: e.target.value }))}>
                    <option value="">— select brand —</option>
                    {dcBrands.map((b: any) => <option key={b.name} value={b.name}>{b.name}</option>)}
                  </select>
                ) : (
                  <input style={S.input} value={ssForm.brand} onChange={e => setSsForm(f => ({ ...f, brand: e.target.value }))} />
                )}
              </div>
              <div>
                <label style={S.label}>Season</label>
                {dcSeasons.length > 0 ? (
                  <select style={selectStyle} value={ssForm.season} onChange={e => setSsForm(f => ({ ...f, season: e.target.value }))}>
                    <option value="">— select season —</option>
                    {dcSeasons.map((s: string) => <option key={s} value={s}>{s}</option>)}
                  </select>
                ) : (
                  <input style={S.input} value={ssForm.season} onChange={e => setSsForm(f => ({ ...f, season: e.target.value }))} />
                )}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Category</label>
                {dcCategories.length > 0 ? (
                  <select style={selectStyle} value={ssForm.category} onChange={e => setSsForm(f => ({ ...f, category: e.target.value, subCategory: "" }))}>
                    <option value="">— select category —</option>
                    {dcCategories.map((c: any) => <option key={c.name} value={c.name}>{c.name}</option>)}
                  </select>
                ) : (
                  <input style={S.input} value={ssForm.category} onChange={e => setSsForm(f => ({ ...f, category: e.target.value }))} />
                )}
              </div>
              {subCats.length > 0 && (
                <div>
                  <label style={S.label}>Sub-Category</label>
                  <select style={selectStyle} value={ssForm.subCategory} onChange={e => setSsForm(f => ({ ...f, subCategory: e.target.value }))}>
                    <option value="">— select sub-category —</option>
                    {subCats.map((sc: string) => <option key={sc} value={sc}>{sc}</option>)}
                  </select>
                </div>
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Gender</label>
                {dcGenders.length > 0 ? (
                  <select style={selectStyle} value={ssForm.gender} onChange={e => setSsForm(f => ({ ...f, gender: e.target.value }))}>
                    <option value="">— select gender —</option>
                    {dcGenders.map((g: string) => <option key={g} value={g}>{g}</option>)}
                  </select>
                ) : (
                  <input style={S.input} value={ssForm.gender} onChange={e => setSsForm(f => ({ ...f, gender: e.target.value }))} />
                )}
              </div>
              <div>
                <label style={S.label}>Vendor</label>
                {dcVendors.length > 0 ? (
                  <select style={selectStyle} value={ssForm.vendor} onChange={e => setSsForm(f => ({ ...f, vendor: e.target.value }))}>
                    <option value="">— select vendor —</option>
                    {dcVendors.map((v: any) => <option key={v.name} value={v.name}>{v.name}</option>)}
                  </select>
                ) : (
                  <input style={S.input} value={ssForm.vendor} onChange={e => setSsForm(f => ({ ...f, vendor: e.target.value }))} />
                )}
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={S.label}>Description</label>
              <input style={S.input} value={ssForm.description} onChange={e => setSsForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div style={{ marginBottom: 8 }}>
              <label style={S.label}>Sizes</label>
              <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6, marginBottom: 8 }}>
                {sizePresets.map(p => (
                  <button key={p.label} style={{ ...S.btnSmall, fontSize: 11 }} onClick={() => setSsForm(f => ({ ...f, sizes: p.sizes.join(", ") }))}>
                    {p.label}
                  </button>
                ))}
              </div>
              <input style={S.input} value={ssForm.sizes} onChange={e => setSsForm(f => ({ ...f, sizes: e.target.value }))} placeholder="XS, S, M, L, XL, XXL" />
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button style={{ ...S.btnSecondary, flex: 1 }} onClick={() => setShowSpecSheetModal(false)}>Cancel</button>
              <button style={{ ...S.btnPrimary, flex: 2, opacity: !ssForm.styleName ? 0.5 : 1 }}
                disabled={!ssForm.styleName}
                onClick={() => {
                  const sizes = ssForm.sizes.split(",").map(s => s.trim()).filter(Boolean);
                  let rows: SpecSheetRow[] = [];
                  if (activeTemplate) {
                    rows = activeTemplate.rows.map(r => ({
                      ...r,
                      id: uid(),
                      values: r.isSection ? {} : Object.fromEntries(sizes.map(s => [s, r.values[s] || ""])),
                    }));
                  }
                  const newSS: SpecSheet = {
                    id: uid(),
                    styleName: ssForm.styleName,
                    styleNumber: ssForm.styleNumber,
                    brand: ssForm.brand,
                    season: ssForm.season,
                    category: ssForm.category,
                    subCategory: ssForm.subCategory,
                    gender: ssForm.gender,
                    vendor: ssForm.vendor,
                    description: ssForm.description,
                    sizes,
                    rows,
                    createdAt: today(),
                    updatedAt: today(),
                  };
                  saveSpecSheets([...specSheets, newSS]);
                  setShowSpecSheetModal(false);
                  setActiveTemplate(null);
                  setSsForm({ styleName: "", styleNumber: "", brand: "", season: "", category: "", subCategory: "", gender: "", vendor: "", description: "", sizes: "XS, S, M, L, XL, XXL" });
                  setSelectedSpecSheet(newSS);
                }}>
                {activeTemplate ? `Create from "${activeTemplate.name}"` : "Create Spec Sheet"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Templates Modal ───────────────────────────────────────────────────────
  function renderTemplatesModal() {
    const allTemplates = [...BUILTIN_TEMPLATES, ...specTemplates];
    const pomCount = (t: SpecTemplate) => t.rows.filter(r => !r.isSection).length;
    const sizeSummary = (t: SpecTemplate) => t.sizes.length <= 6 ? t.sizes.join(", ") : `${t.sizes[0]}–${t.sizes[t.sizes.length - 1]} (${t.sizes.length} sizes)`;

    const handleUseTemplate = (t: SpecTemplate) => {
      setActiveTemplate(t);
      setSsForm(f => ({ ...f, sizes: t.sizes.join(", "), category: t.category || f.category }));
      setShowTemplatesModal(false);
      setShowSpecSheetModal(true);
    };

    const handleDownloadTemplate = (t: SpecTemplate) => {
      const dummy: SpecSheet = { id: "", styleName: "", styleNumber: "", brand: "", season: "", category: t.category, description: t.description, sizes: t.sizes, rows: t.rows, createdAt: today(), updatedAt: today() };
      const wb = buildSpecSheetWb(dummy, true);
      if (wb) xlsxDownload(wb, `Template_${t.name.replace(/\s+/g, "_")}.xlsx`);
    };

    const handleUploadTemplate = async (file: File) => {
      try {
        showToast("Parsing template...");
        const XLSX = (window as any).XLSX;
        if (!XLSX) { showToast("Excel library loading — try again"); return; }
        const reader = new FileReader();
        reader.onload = ev => {
          try {
            const wb = XLSX.read(ev.target?.result, { type: "binary" });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
            let headerRowIdx = -1; let sizes: string[] = []; let newFmt = false;
            for (let i = 0; i < aoa.length; i++) {
              const c0 = String(aoa[i][0] || "").trim().toUpperCase();
              const c1 = String(aoa[i][1] || "").trim().toUpperCase();
              if (c0 === "POM" && c1.includes("BLOCK")) { headerRowIdx = i; newFmt = true; const sr = aoa[i - 1] || []; for (let c = 6; c < sr.length; c += 2) { const s = String(sr[c] || "").trim(); if (s) sizes.push(s); } break; }
              if (c0 === "POINT OF MEASURE" || c0 === "POM") { headerRowIdx = i; sizes = aoa[i].slice(2).map((s: any) => String(s).trim()).filter(Boolean); break; }
            }
            if (headerRowIdx === -1) { showToast("Could not find spec sheet header row"); return; }
            const rows: SpecSheetRow[] = [];
            for (let i = headerRowIdx + 1; i < aoa.length; i++) {
              const row = aoa[i];
              const desc = newFmt ? String(row[1] || "").trim() : String(row[0] || "").trim();
              if (!desc) continue;
              const tol = newFmt ? String(row[5] || "").trim() : String(row[1] || "").trim();
              const values: Record<string, string> = {};
              sizes.forEach(s => { values[s] = ""; }); // blank values for templates
              rows.push({ id: uid(), pointOfMeasure: desc, tolerance: tol, values });
            }
            const newTemplate: SpecTemplate = {
              id: uid(),
              name: file.name.replace(/\.[^.]+$/, "").replace(/_/g, " "),
              category: "",
              description: `Uploaded from ${file.name}`,
              sizes,
              rows,
              createdAt: today(),
            };
            saveSpecTemplates([...specTemplates, newTemplate]);
            showToast(`Template "${newTemplate.name}" added (${rows.length} POMs)`);
          } catch (err) { showToast("Parse failed — check file format"); console.error(err); }
        };
        reader.readAsBinaryString(file);
      } catch (err) { showToast("Upload failed"); console.error(err); }
    };

    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 450, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 20px", overflowY: "auto" }} onClick={() => setShowTemplatesModal(false)}>
        <div style={{ background: "#1E293B", borderRadius: 16, width: "100%", maxWidth: 900, border: "1px solid #334155", boxShadow: "0 24px 64px rgba(0,0,0,0.5)" }} onClick={e => e.stopPropagation()}>
          {/* Header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "20px 24px", borderBottom: "1px solid #334155" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1.5" stroke="#60A5FA" strokeWidth="2"/><rect x="14" y="3" width="7" height="7" rx="1.5" stroke="#60A5FA" strokeWidth="2"/><rect x="3" y="14" width="7" height="7" rx="1.5" stroke="#60A5FA" strokeWidth="2"/><rect x="14" y="14" width="7" height="7" rx="1.5" stroke="#60A5FA" strokeWidth="2"/></svg>
              <h2 style={{ margin: 0, color: "#F1F5F9", fontSize: 20, fontWeight: 700 }}>Spec Sheet Templates</h2>
              <span style={{ fontSize: 12, color: "#6B7280" }}>{allTemplates.length} template{allTemplates.length !== 1 ? "s" : ""}</span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <label style={{ background: "#334155", border: "1px solid #475569", borderRadius: 6, padding: "7px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, color: "#F1F5F9", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}
                onMouseEnter={e => e.currentTarget.style.background = "#475569"}
                onMouseLeave={e => e.currentTarget.style.background = "#334155"}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 4v12M8 12l4 4 4-4" stroke="#F1F5F9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 20h16" stroke="#F1F5F9" strokeWidth="2" strokeLinecap="round"/></svg>
                Upload Template
                <input type="file" accept=".xlsx" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) handleUploadTemplate(f); e.target.value = ""; }} />
              </label>
              <button style={S.closeBtn} onClick={() => setShowTemplatesModal(false)}>✕</button>
            </div>
          </div>
          {/* Template Grid */}
          <div style={{ padding: 24, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
            {allTemplates.map(t => (
              <div key={t.id} style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ color: "#F1F5F9", fontWeight: 700, fontSize: 15 }}>{t.name}</div>
                    {t.isBuiltin && (
                      <span style={{ fontSize: 10, background: "#3B82F622", color: "#60A5FA", border: "1px solid #3B82F644", borderRadius: 4, padding: "1px 6px", fontWeight: 600 }}>Built-in</span>
                    )}
                  </div>
                  {!t.isBuiltin && (
                    <button style={{ background: "none", border: "none", cursor: "pointer", color: "#6B7280", fontSize: 14, padding: 2 }}
                      title="Delete template"
                      onMouseEnter={e => e.currentTarget.style.color = "#EF4444"}
                      onMouseLeave={e => e.currentTarget.style.color = "#6B7280"}
                      onClick={() => setConfirmDialog({ title: "Delete Template", message: `Delete "${t.name}"? This cannot be undone.`, onConfirm: () => saveSpecTemplates(specTemplates.filter(x => x.id !== t.id)) })}>
                      🗑️
                    </button>
                  )}
                </div>
                <div style={{ color: "#94A3B8", fontSize: 12, lineHeight: 1.5 }}>{t.description}</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
                  {t.category && <span style={{ fontSize: 11, background: "#1E293B", color: "#94A3B8", border: "1px solid #334155", borderRadius: 4, padding: "2px 8px" }}>{t.category}</span>}
                  <span style={{ fontSize: 11, background: "#1E293B", color: "#94A3B8", border: "1px solid #334155", borderRadius: 4, padding: "2px 8px" }}>{pomCount(t)} POMs</span>
                  <span style={{ fontSize: 11, background: "#1E293B", color: "#94A3B8", border: "1px solid #334155", borderRadius: 4, padding: "2px 8px", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{sizeSummary(t)}</span>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button style={{ flex: 1, background: "linear-gradient(135deg,#3B82F6,#2563EB)", border: "none", borderRadius: 6, padding: "7px 0", cursor: "pointer", color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}
                    onMouseEnter={e => e.currentTarget.style.opacity = "0.85"}
                    onMouseLeave={e => e.currentTarget.style.opacity = "1"}
                    onClick={() => handleUseTemplate(t)}>
                    Use Template
                  </button>
                  <button title="Download blank Excel" onClick={() => handleDownloadTemplate(t)}
                    style={{ background: "#1D6F42", border: "none", borderRadius: 6, padding: "7px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}
                    onMouseEnter={e => e.currentTarget.style.background = "#155734"}
                    onMouseLeave={e => e.currentTarget.style.background = "#1D6F42"}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" fill="#fff" fillOpacity=".2" stroke="#fff" strokeWidth="1.5"/><path d="M14 2v6h6" stroke="#fff" strokeWidth="1.5"/><path d="M8 13l2.5 4M8 17l2.5-4M13 13v4M15.5 13v4M13 15h2.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </button>
                </div>
              </div>
            ))}
            {allTemplates.length === 0 && (
              <div style={{ gridColumn: "1/-1", textAlign: "center", padding: 40, color: "#6B7280" }}>
                <div style={{ fontSize: 36, marginBottom: 8 }}>📋</div>
                <p>No templates yet. Upload an Excel file to create one.</p>
              </div>
            )}
          </div>
          <div style={{ padding: "0 24px 24px", color: "#6B7280", fontSize: 12 }}>
            Click <strong style={{ color: "#60A5FA" }}>Use Template</strong> to create a new spec sheet pre-filled with the template's measurements. Click the Excel button to download a blank template.
          </div>
        </div>
      </div>
    );
  }

  // ── Samples Overview ──────────────────────────────────────────────────────
  function renderSamplesOverview() {
    return (
      <>
        <h2 style={{ margin: "0 0 16px", color: "#F1F5F9", fontSize: 22 }}>All Samples</h2>
        {allSamples.length === 0 ? (
          <div style={S.emptyState}>
            <div style={{ fontSize: 40 }}>🧪</div>
            <p>No samples tracked across any tech packs</p>
          </div>
        ) : (
          <div style={S.tableWrap}>
            <div style={S.tableHeader}>
              <span style={{ flex: 1 }}>Style #</span>
              <span style={{ flex: 2 }}>Style Name</span>
              <span style={{ flex: 1 }}>Type</span>
              <span style={{ flex: 1 }}>Status</span>
              <span style={{ flex: 1 }}>Vendor</span>
              <span style={{ flex: 1 }}>Requested</span>
              <span style={{ flex: 1 }}>Received</span>
            </div>
            {allSamples.map((s, i) => (
              <div key={s.id} style={{ ...S.tableRow, background: i % 2 === 0 ? "#0F172A" : "#1A2332" }}>
                <span style={{ flex: 1, color: "#60A5FA", fontFamily: "monospace", fontWeight: 600 }}>{(s as any).styleNumber}</span>
                <span style={{ flex: 2, color: "#D1D5DB" }}>{(s as any).styleName}</span>
                <span style={{ flex: 1 }}>
                  <span style={{ ...S.badge, background: "#3B82F622", color: "#3B82F6", border: "1px solid #3B82F644" }}>{s.type}</span>
                </span>
                <span style={{ flex: 1 }}>
                  <span style={{ ...S.badge, background: (SAMPLE_STATUS_COLORS[s.status] || "#6B7280") + "22", color: SAMPLE_STATUS_COLORS[s.status] || "#6B7280", border: `1px solid ${SAMPLE_STATUS_COLORS[s.status] || "#6B7280"}44` }}>{s.status}</span>
                </span>
                <span style={{ flex: 1, color: "#94A3B8" }}>{s.vendor}</span>
                <span style={{ flex: 1, color: "#94A3B8", fontSize: 12 }}>{fmtDate(s.requestDate)}</span>
                <span style={{ flex: 1, color: "#94A3B8", fontSize: 12 }}>{fmtDate(s.receiveDate)}</span>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DETAIL PANEL
  // ══════════════════════════════════════════════════════════════════════════
  function renderDetailPanel() {
    if (!selected) return null;
    const tp = selected;

    return (
      <div style={S.detailOverlay} onClick={() => { setSelected(null); setView("list"); }}>
        <div style={S.detailPanel} onClick={e => e.stopPropagation()}>
          {/* Header */}
          <div style={S.detailHeader}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={S.detailPONum}>{tp.styleNumber || "—"}</span>
                <span style={{ ...S.badge, background: STATUS_COLORS[tp.status] + "22", color: STATUS_COLORS[tp.status], border: `1px solid ${STATUS_COLORS[tp.status]}44`, fontSize: 13 }}>{tp.status}</span>
              </div>
              <div style={S.detailVendor}>{tp.styleName}</div>
              <div style={{ color: "#6B7280", fontSize: 13, marginTop: 4 }}>{tp.brand}{tp.season ? ` · ${tp.season}` : ""}{tp.category ? ` · ${tp.category}` : ""}</div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <select style={{ ...S.select, fontSize: 12 }} value={tp.status} onChange={e => updateSelected({ status: e.target.value as TechPack["status"] })}>
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <button style={{ ...S.iconBtn, color: "#EF4444", fontSize: 14 }} onClick={() => setConfirmDialog({ title: "Delete Tech Pack", message: `Delete "${tp.styleName || tp.styleNumber}"? All specs, BOM, samples, and approvals will be permanently removed.`, onConfirm: () => deleteTechPack(tp.id) })}>🗑️</button>
              <button style={S.closeBtn} onClick={() => { setSelected(null); setView("list"); }}>✕</button>
            </div>
          </div>

          {/* Info Grid */}
          <div style={{ padding: "16px 24px 0" }}>
            <div style={{ ...S.infoGrid, gridTemplateColumns: "repeat(6, 1fr)", marginBottom: 12 }}>
              <div style={S.infoCell}><div style={S.infoCellLabel}>Designer</div><div style={S.infoCellValue}>{tp.designer || "—"}</div></div>
              <div style={S.infoCell}><div style={S.infoCellLabel}>Division</div><div style={S.infoCellValue}>{tp.division || "—"}</div></div>
              <div style={S.infoCell}><div style={S.infoCellLabel}>Owner</div><div style={S.infoCellValue}>{tp.owner || "—"}</div></div>
              <div style={S.infoCell}><div style={S.infoCellLabel}>Active</div><div style={S.infoCellValue}>{tp.active !== false ? "Yes" : "No"}</div></div>
              <div style={S.infoCell}><div style={S.infoCellLabel}>Version</div><div style={S.infoCellValue}>v{tp.version || 1}</div></div>
              <div style={S.infoCell}><div style={S.infoCellLabel}>Updated</div><div style={S.infoCellValue}>{fmtDate(tp.updatedAt)}</div></div>
            </div>
            {tp.description && (
              <div style={{ background: "#0F172A", borderRadius: 8, padding: 12, marginBottom: 12, color: "#94A3B8", fontSize: 13 }}>{tp.description}</div>
            )}
          </div>

          {/* Tabs */}
          <div style={{ display: "flex", gap: 0, padding: "0 24px", borderBottom: "1px solid #334155" }}>
            {([["sketch", "Sketch"], ["spec", "Spec Sheet"], ["construction", "Construction"], ["bom", "BOM"], ["costing", "Costing"], ["approvals", "Approvals"], ["samples", "Samples"], ["images", "Images"]] as [DetailTab, string][]).map(([key, label]) => (
              <button key={key} onClick={() => setDetailTab(key)}
                style={{ padding: "10px 16px", background: "none", border: "none", borderBottom: detailTab === key ? "2px solid #3B82F6" : "2px solid transparent", color: detailTab === key ? "#60A5FA" : "#6B7280", fontSize: 13, fontWeight: detailTab === key ? 700 : 500, cursor: "pointer", fontFamily: "inherit" }}>
                {label}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div style={{ padding: 24, flex: 1, overflowY: "auto" }}>
            {detailTab === "sketch" && renderSketchTab(tp)}
            {detailTab === "spec" && renderSpecTab(tp)}
            {detailTab === "construction" && renderConstructionTab(tp)}
            {detailTab === "bom" && renderBOMTab(tp)}
            {detailTab === "costing" && renderCostingTab(tp)}
            {detailTab === "approvals" && renderApprovalsTab(tp)}
            {detailTab === "samples" && renderSamplesTab(tp)}
            {detailTab === "images" && renderImagesTab(tp)}
          </div>
        </div>
      </div>
    );
  }

  // ── Sketch Tab ────────────────────────────────────────────────────────────
  function renderSketchTab(tp: TechPack) {
    const sk: FlatSketch = tp.flatSketch || { frontImage: null, backImage: null, callouts: [], stitchingDetails: "", measurementNote: "" };

    const updateSketch = (changes: Partial<FlatSketch>) => updateSelected({ flatSketch: { ...sk, ...changes } });

    const addCallout = () => {
      const nextNum = sk.callouts.length > 0 ? Math.max(...sk.callouts.map(c => c.number)) + 1 : 1;
      updateSketch({ callouts: [...sk.callouts, { id: uid(), number: nextNum, description: "" }] });
    };

    const updateCallout = (id: string, changes: Partial<SketchCallout>) => {
      updateSketch({ callouts: sk.callouts.map(c => c.id === id ? { ...c, ...changes } : c) });
    };

    const removeCallout = (id: string) => updateSketch({ callouts: sk.callouts.filter(c => c.id !== id) });

    const uploadSketchImage = async (file: File, side: "frontImage" | "backImage") => {
      const url = await uploadImage(file, `/techpacks/${tp.id}/sketch/${side}-${file.name}`);
      if (url) updateSketch({ [side]: url });
      else showToast("Upload failed");
    };

    const SketchImageSlot = ({ side, label }: { side: "frontImage" | "backImage"; label: string }) => {
      const img = sk[side];
      return (
        <div style={{ flex: 1 }}>
          <div style={{ color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, fontWeight: 600 }}>{label}</div>
          <label style={{ display: "block", cursor: "pointer" }}>
            <input type="file" accept="image/*" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) uploadSketchImage(f, side); }} />
            {img ? (
              <div style={{ position: "relative", border: "1px solid #334155", borderRadius: 10, overflow: "hidden", background: "#fff" }}>
                <img src={img} alt={label} style={{ width: "100%", maxHeight: 400, objectFit: "contain", display: "block" }} onClick={e => { e.preventDefault(); setLightboxImg(img); }} />
                <button style={{ position: "absolute", top: 8, right: 8, background: "#EF444488", border: "none", borderRadius: 6, color: "#fff", fontSize: 12, padding: "4px 8px", cursor: "pointer" }}
                  onClick={e => { e.preventDefault(); updateSketch({ [side]: null }); }}>Remove</button>
              </div>
            ) : (
              <div style={{ border: "2px dashed #334155", borderRadius: 10, height: 280, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "#4B5563", background: "#0F172A", transition: "border-color .15s" }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = "#3B82F6")}
                onMouseLeave={e => (e.currentTarget.style.borderColor = "#334155")}>
                <div style={{ fontSize: 36 }}>👔</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#6B7280" }}>Upload {label}</div>
                <div style={{ fontSize: 11, color: "#4B5563" }}>Click to browse</div>
              </div>
            )}
          </label>
        </div>
      );
    };

    const sortedCallouts = [...sk.callouts].sort((a, b) => a.number - b.number);

    return (
      <>
        {/* Header row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ margin: 0, color: "#F1F5F9", fontSize: 16 }}>Style Design Detail</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ color: "#94A3B8", fontSize: 12 }}>Measurements based on size</label>
              <input style={{ ...S.input, width: 70, padding: "5px 10px", fontSize: 13 }} value={sk.measurementNote} onChange={e => updateSketch({ measurementNote: e.target.value })} placeholder="32" />
            </div>
            <button style={S.btnSmall} onClick={addCallout}>+ Callout</button>
          </div>
        </div>

        {/* Two-column layout: sketches left, callouts right */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 20 }}>
          {/* Left: front + back sketch images */}
          <div style={{ display: "flex", gap: 12 }}>
            <SketchImageSlot side="frontImage" label="Front View" />
            <SketchImageSlot side="backImage" label="Back View" />
          </div>

          {/* Right: callout list + stitching details */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Callouts */}
            <div style={{ background: "#0F172A", borderRadius: 10, padding: 14, border: "1px solid #334155" }}>
              <div style={{ color: "#94A3B8", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600, marginBottom: 10 }}>Details</div>
              {sortedCallouts.length === 0 ? (
                <div style={{ color: "#4B5563", fontSize: 12, textAlign: "center", padding: "16px 0" }}>No callouts yet.<br />Click "+ Callout" to add.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {sortedCallouts.map(c => (
                    <div key={c.id} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <div style={{ width: 24, height: 24, borderRadius: "50%", background: "#3B82F6", color: "#fff", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2 }}>
                        {c.number}
                      </div>
                      <input
                        style={{ ...S.cellInput, flex: 1, border: "1px solid #334155", borderRadius: 6, padding: "5px 8px", fontSize: 12 }}
                        value={c.description}
                        onChange={e => updateCallout(c.id, { description: e.target.value })}
                        placeholder={`Detail ${c.number}...`}
                      />
                      <button style={{ ...S.iconBtnTiny, marginTop: 4, flexShrink: 0 }} onClick={() => removeCallout(c.id)}>🗑️</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Stitching Details */}
            <div style={{ background: "#0F172A", borderRadius: 10, padding: 14, border: "1px solid #334155", flex: 1 }}>
              <div style={{ color: "#94A3B8", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600, marginBottom: 10 }}>Stitching Detail</div>
              <textarea
                style={{ ...S.textarea, minHeight: 120, fontSize: 12, lineHeight: 1.6 }}
                value={sk.stitchingDetails}
                onChange={e => updateSketch({ stitchingDetails: e.target.value })}
                placeholder={"e.g.\n- CHAINSTITCH @ INSEAM\n- SPI 8 @ OUTSEAM\n- BARTACK @ POCKET CORNERS\n- FLAT FELLED @ CROTCH SEAM"}
              />
            </div>

            {/* Measurement note display */}
            {sk.measurementNote && (
              <div style={{ color: "#EF4444", fontSize: 11, fontWeight: 700, textAlign: "center", fontStyle: "italic" }}>
                *MEASUREMENTS BASED ON SIZE {sk.measurementNote}
              </div>
            )}
          </div>
        </div>
      </>
    );
  }

  // ── Spec Sheet Tab ────────────────────────────────────────────────────────
  function renderSpecTab(tp: TechPack) {
    const sizes = tp.measurements.length > 0 ? Object.keys(tp.measurements[0].sizes) : [...DEFAULT_SIZES];

    return (
      <>
        {/* Style metadata editable fields */}
        <div style={{ background: "#0F172A", borderRadius: 10, padding: 16, marginBottom: 20, border: "1px solid #334155" }}>
          <div style={{ color: "#94A3B8", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600, marginBottom: 12 }}>Style Info</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={S.label}>Designer</label>
              <input style={S.input} value={tp.designer || ""} onChange={e => updateSelected({ designer: e.target.value })} placeholder="Designer name" />
            </div>
            <div>
              <label style={S.label}>Division</label>
              <input style={S.input} value={tp.division || ""} onChange={e => updateSelected({ division: e.target.value })} placeholder="e.g. Young Mens" />
            </div>
            <div>
              <label style={S.label}>Owner</label>
              <input style={S.input} value={tp.owner || ""} onChange={e => updateSelected({ owner: e.target.value })} placeholder="e.g. ROF" />
            </div>
            <div>
              <label style={S.label}>Version</label>
              <input style={S.input} type="number" value={tp.version || 1} onChange={e => updateSelected({ version: parseInt(e.target.value) || 1 })} />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 60px", gap: 12 }}>
            <div>
              <label style={S.label}>Description</label>
              <input style={S.input} value={tp.description || ""} onChange={e => updateSelected({ description: e.target.value })} placeholder="Style description..." />
            </div>
            <div>
              <label style={S.label}>Brand</label>
              <input style={S.input} value={tp.brand || ""} onChange={e => updateSelected({ brand: e.target.value })} />
            </div>
            <div>
              <label style={S.label}>Season</label>
              <select style={{ ...S.select, width: "100%" }} value={tp.season || ""} onChange={e => updateSelected({ season: e.target.value })}>
                <option value="">Select...</option>
                {SEASONS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label style={S.label}>Active</label>
              <button style={{ ...S.btnSmall, background: tp.active !== false ? "#10B98122" : "#EF444422", color: tp.active !== false ? "#10B981" : "#EF4444", border: `1px solid ${tp.active !== false ? "#10B981" : "#EF4444"}44`, width: "100%", padding: "9px 0" }}
                onClick={() => updateSelected({ active: tp.active === false ? true : false })}>
                {tp.active !== false ? "Yes" : "No"}
              </button>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0, color: "#F1F5F9", fontSize: 16 }}>Measurements</h3>
          <div style={{ display: "flex", gap: 8 }}>
            {showAddSize ? (
              <>
                <input style={{ ...S.input, width: 80, padding: "4px 8px", fontSize: 12 }} placeholder="Size" value={newSize} onChange={e => setNewSize(e.target.value)} />
                <button style={S.btnSmall} onClick={() => {
                  if (!newSize.trim()) return;
                  const updated = tp.measurements.map(m => ({ ...m, sizes: { ...m.sizes, [newSize.trim()]: "" } }));
                  updateSelected({ measurements: updated });
                  setNewSize("");
                  setShowAddSize(false);
                }}>Add</button>
                <button style={{ ...S.btnSmall, background: "none", color: "#6B7280" }} onClick={() => setShowAddSize(false)}>Cancel</button>
              </>
            ) : (
              <button style={S.btnSmall} onClick={() => setShowAddSize(true)}>+ Size Column</button>
            )}
            <button style={S.btnSmall} onClick={() => {
              const sizeObj: Record<string, string> = {};
              sizes.forEach(s => sizeObj[s] = "");
              updateSelected({ measurements: [...tp.measurements, { id: uid(), pointOfMeasure: "", tolerance: "±0.5", sizes: sizeObj }] });
            }}>+ Measurement</button>
          </div>
        </div>

        {tp.measurements.length === 0 ? (
          <div style={{ ...S.emptyState, padding: 30 }}>
            <p style={{ color: "#6B7280", fontSize: 13 }}>No measurements yet. Add size columns and measurement points.</p>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Point of Measure</th>
                  <th style={S.th}>Tolerance</th>
                  {sizes.map(s => (
                    <th key={s} style={S.th}>
                      {s}
                      <button style={{ ...S.iconBtnTiny, marginLeft: 4 }} onClick={() => {
                        const updated = tp.measurements.map(m => {
                          const ns = { ...m.sizes };
                          delete ns[s];
                          return { ...m, sizes: ns };
                        });
                        updateSelected({ measurements: updated });
                      }}>✕</button>
                    </th>
                  ))}
                  <th style={S.th}>Del</th>
                </tr>
              </thead>
              <tbody>
                {tp.measurements.map((m, idx) => (
                  <tr key={m.id} style={{ background: idx % 2 === 0 ? "#0F172A" : "#1A2332" }}>
                    <td style={S.td}>
                      <input style={S.cellInput} value={m.pointOfMeasure} onChange={e => {
                        const updated = [...tp.measurements];
                        updated[idx] = { ...m, pointOfMeasure: e.target.value };
                        updateSelected({ measurements: updated });
                      }} placeholder="e.g. Chest" />
                    </td>
                    <td style={S.td}>
                      <input style={{ ...S.cellInput, width: 70 }} value={m.tolerance} onChange={e => {
                        const updated = [...tp.measurements];
                        updated[idx] = { ...m, tolerance: e.target.value };
                        updateSelected({ measurements: updated });
                      }} />
                    </td>
                    {sizes.map(s => (
                      <td key={s} style={S.td}>
                        <input style={{ ...S.cellInput, width: 60, textAlign: "center" }} value={m.sizes[s] || ""} onChange={e => {
                          const updated = [...tp.measurements];
                          updated[idx] = { ...m, sizes: { ...m.sizes, [s]: e.target.value } };
                          updateSelected({ measurements: updated });
                        }} />
                      </td>
                    ))}
                    <td style={S.td}>
                      <button style={S.iconBtnTiny} onClick={() => updateSelected({ measurements: tp.measurements.filter(x => x.id !== m.id) })}>🗑️</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>
    );
  }

  // ── Construction Tab ──────────────────────────────────────────────────────
  function renderConstructionTab(tp: TechPack) {
    return (
      <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0, color: "#F1F5F9", fontSize: 16 }}>Construction Details</h3>
          <button style={S.btnSmall} onClick={() => {
            updateSelected({ construction: [...tp.construction, { id: uid(), area: "", detail: "", notes: "", refImages: [] }] });
          }}>+ Add Detail</button>
        </div>

        {tp.construction.length === 0 ? (
          <div style={{ ...S.emptyState, padding: 30 }}><p style={{ color: "#6B7280" }}>No construction details yet.</p></div>
        ) : (
          tp.construction.map((c, idx) => (
            <div key={c.id} style={{ background: idx % 2 === 0 ? "#0F172A" : "#1A2332", borderRadius: 8, padding: 14, marginBottom: 10, border: "1px solid #334155" }}>
              <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={S.label}>Area</label>
                  <input style={S.input} value={c.area} placeholder="e.g. Front Body, Collar, Sleeve" onChange={e => {
                    const updated = [...tp.construction];
                    updated[idx] = { ...c, area: e.target.value };
                    updateSelected({ construction: updated });
                  }} />
                </div>
                <button style={{ ...S.iconBtn, alignSelf: "flex-end", color: "#EF4444" }} onClick={() => updateSelected({ construction: tp.construction.filter(x => x.id !== c.id) })}>🗑️</button>
              </div>
              <label style={S.label}>Detail</label>
              <textarea style={{ ...S.textarea, minHeight: 60, marginBottom: 8 }} value={c.detail} onChange={e => {
                const updated = [...tp.construction];
                updated[idx] = { ...c, detail: e.target.value };
                updateSelected({ construction: updated });
              }} placeholder="Construction detail..." />
              <label style={S.label}>Notes</label>
              <input style={S.input} value={c.notes} onChange={e => {
                const updated = [...tp.construction];
                updated[idx] = { ...c, notes: e.target.value };
                updateSelected({ construction: updated });
              }} placeholder="Additional notes..." />

              {/* Reference photos */}
              <label style={{ ...S.label, marginTop: 10 }}>Reference Photos</label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as any, marginTop: 4 }}>
                {(c.refImages || []).map((img, imgIdx) => (
                  <div key={imgIdx} style={{ position: "relative", width: 72, height: 72 }}>
                    <img src={img} alt="" style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: "1px solid #334155", cursor: "pointer" }} onClick={() => setLightboxImg(img)} />
                    <button style={{ position: "absolute", top: -4, right: -4, width: 18, height: 18, borderRadius: "50%", background: "#EF4444", color: "#fff", border: "none", fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                      onClick={() => {
                        const updated = [...tp.construction];
                        updated[idx] = { ...c, refImages: c.refImages.filter((_, i) => i !== imgIdx) };
                        updateSelected({ construction: updated });
                      }}>✕</button>
                  </div>
                ))}
                <label style={{ width: 72, height: 72, border: "2px dashed #334155", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#6B7280", fontSize: 22 }}>
                  +
                  <input type="file" accept="image/*" multiple style={{ display: "none" }} onChange={async e => {
                    const files = e.target.files; if (!files) return;
                    const urls: string[] = [];
                    for (let i = 0; i < files.length; i++) {
                      const url = await uploadImage(files[i], `/techpacks/${tp.id}/construction/${c.id}/${files[i].name}`);
                      if (url) urls.push(url);
                    }
                    if (urls.length) {
                      const updated = [...tp.construction];
                      updated[idx] = { ...c, refImages: [...(c.refImages || []), ...urls] };
                      updateSelected({ construction: updated });
                    }
                  }} />
                </label>
              </div>
            </div>
          ))
        )}
      </>
    );
  }

  // ── BOM Tab ───────────────────────────────────────────────────────────────
  function renderBOMTab(tp: TechPack) {
    const bomTotal = tp.bom.reduce((sum, b) => sum + b.totalCost, 0);
    const colorways: Colorway[] = tp.colorways || [];

    const addColorway = () => {
      const name = prompt("Colorway name (e.g. BLACKSANDS):");
      if (!name?.trim()) return;
      const cw: Colorway = { id: uid(), name: name.trim().toUpperCase() };
      const newBom = tp.bom.map(b => ({
        ...b,
        colorSpecs: [...(b.colorSpecs || []), { colorwayId: cw.id, color: "", pantone: "", trialSize: "" }],
      }));
      updateSelected({ colorways: [...colorways, cw], bom: newBom });
    };

    const removeColorway = (cwId: string) => {
      const newBom = tp.bom.map(b => ({ ...b, colorSpecs: (b.colorSpecs || []).filter(cs => cs.colorwayId !== cwId) }));
      updateSelected({ colorways: colorways.filter(cw => cw.id !== cwId), bom: newBom });
    };

    const addBOMItem = () => {
      const newItem: BOMItem = {
        id: uid(), materialNo: "", material: "", placement: "", content: "", weight: "",
        quantity: "", uom: "YDS", supplier: "", unitCost: 0, totalCost: 0, notes: "", image: null,
        colorSpecs: colorways.map(cw => ({ colorwayId: cw.id, color: "", pantone: "", trialSize: "" })),
      };
      updateSelected({ bom: [...tp.bom, newItem] });
    };

    const updateBOMItem = (idx: number, changes: Partial<BOMItem>) => {
      const updated = [...tp.bom];
      const merged = { ...updated[idx], ...changes };
      if ("unitCost" in changes || "quantity" in changes) {
        merged.totalCost = Math.round(parseFloat(merged.quantity || "0") * merged.unitCost * 100) / 100;
      }
      updated[idx] = merged;
      updateSelected({ bom: updated });
    };

    const updateColorSpec = (bomIdx: number, cwId: string, changes: Partial<BOMColorSpec>) => {
      const updated = [...tp.bom];
      const specs = [...(updated[bomIdx].colorSpecs || [])];
      const si = specs.findIndex(cs => cs.colorwayId === cwId);
      if (si >= 0) specs[si] = { ...specs[si], ...changes };
      else specs.push({ colorwayId: cwId, color: "", pantone: "", trialSize: "", ...changes });
      updated[bomIdx] = { ...updated[bomIdx], colorSpecs: specs };
      updateSelected({ bom: updated });
    };

    const FIXED_COLS = 10; // image, mat no, material, placement, content, weight, qty, uom, unit$, total
    const CW_COL_W = 260; // px per colorway

    return (
      <>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0, color: "#F1F5F9", fontSize: 16 }}>Bill of Materials</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={S.btnSmall} onClick={addColorway}>+ Colorway</button>
            <button style={S.btnSmall} onClick={addBOMItem}>+ Add Item</button>
          </div>
        </div>

        {/* Colorway chips */}
        {colorways.length > 0 && (
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" as any }}>
            {colorways.map((cw, i) => (
              <div key={cw.id} style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 20, padding: "4px 10px 4px 14px", display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: CW_COLORS[i % CW_COLORS.length] }} />
                <span style={{ color: "#D1D5DB", fontSize: 12, fontWeight: 600 }}>{cw.name}</span>
                <button style={{ background: "none", border: "none", color: "#6B7280", cursor: "pointer", fontSize: 11, padding: 0, lineHeight: 1 }}
                  onClick={() => setConfirmDialog({ title: "Remove Colorway", message: `Remove colorway "${cw.name}"?`, onConfirm: () => removeColorway(cw.id) })}>✕</button>
              </div>
            ))}
          </div>
        )}

        {tp.bom.length === 0 ? (
          <div style={{ ...S.emptyState, padding: 30 }}><p style={{ color: "#6B7280" }}>No BOM items yet. Add a colorway and items to get started.</p></div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ ...S.table, minWidth: 780 + colorways.length * CW_COL_W }}>
              <thead>
                {/* Row 1: fixed col headers + colorway group headers */}
                <tr>
                  <th style={{ ...S.th, width: 52 }}>Image</th>
                  <th style={{ ...S.th, width: 80 }}>Mat No</th>
                  <th style={{ ...S.th, width: 140 }}>Material</th>
                  <th style={{ ...S.th, width: 180 }}>Placement</th>
                  <th style={{ ...S.th, width: 110 }}>Content</th>
                  <th style={{ ...S.th, width: 68 }}>Weight</th>
                  <th style={{ ...S.th, width: 54 }}>Qty</th>
                  <th style={{ ...S.th, width: 50 }}>UOM</th>
                  <th style={{ ...S.th, width: 68 }}>Unit $</th>
                  <th style={{ ...S.th, width: 70 }}>Total</th>
                  {colorways.map((cw, i) => (
                    <th key={cw.id} colSpan={2} style={{ ...S.th, textAlign: "center", borderLeft: "2px solid #334155", color: CW_COLORS[i % CW_COLORS.length], background: "#0A1628", width: CW_COL_W }}>
                      {cw.name}
                    </th>
                  ))}
                  <th style={{ ...S.th, width: 32 }}></th>
                </tr>
                {/* Row 2: sub-headers for colorway columns */}
                {colorways.length > 0 && (
                  <tr>
                    <th colSpan={FIXED_COLS} style={{ ...S.th, background: "#0F172A", padding: 0 }} />
                    {colorways.map(cw => [
                      <th key={cw.id + "-a"} style={{ ...S.th, borderLeft: "2px solid #334155", background: "#0A1628", width: 170, fontSize: 10 }}>Color / Pantone</th>,
                      <th key={cw.id + "-b"} style={{ ...S.th, background: "#0A1628", width: 90, fontSize: 10 }}>Trl / Sz</th>,
                    ])}
                    <th style={{ ...S.th, background: "#0F172A" }} />
                  </tr>
                )}
              </thead>
              <tbody>
                {tp.bom.map((b, idx) => {
                  const rowBg = idx % 2 === 0 ? "#0F172A" : "#1A2332";
                  const cwBg  = idx % 2 === 0 ? "#0A1628" : "#0F1E35";
                  return (
                    <tr key={b.id} style={{ background: rowBg }}>
                      <td style={{ ...S.td, width: 52 }}>
                        <label style={{ cursor: "pointer", display: "block" }}>
                          <input type="file" accept="image/*" style={{ display: "none" }} onChange={async e => {
                            const file = e.target.files?.[0]; if (!file) return;
                            const url = await uploadImage(file, `/techpacks/${tp.id}/bom/${b.id}/${file.name}`);
                            if (url) updateBOMItem(idx, { image: url }); else showToast("Upload failed");
                          }} />
                          {b.image ? (
                            <img src={b.image} alt="" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 6, border: "1px solid #334155", display: "block" }} onClick={e => { e.preventDefault(); setLightboxImg(b.image!); }} />
                          ) : (
                            <div style={{ width: 44, height: 44, border: "2px dashed #334155", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: "#4B5563", fontSize: 18 }}>+</div>
                          )}
                        </label>
                        {b.image && <button style={{ ...S.iconBtnTiny, display: "block", margin: "2px auto 0", color: "#EF4444" }} onClick={() => updateBOMItem(idx, { image: null })}>✕</button>}
                      </td>
                      <td style={S.td}><input style={{ ...S.cellInput, width: 72 }} value={b.materialNo || ""} onChange={e => updateBOMItem(idx, { materialNo: e.target.value })} placeholder="TRM001" /></td>
                      <td style={S.td}>
                        <select style={{ ...S.cellInput, width: "100%" }} value={b.material} onChange={e => {
                          const mat = materials.find(m => m.name === e.target.value);
                          updateBOMItem(idx, { material: e.target.value, supplier: mat?.supplier || b.supplier, unitCost: mat?.unitPrice || b.unitCost, content: mat?.composition || b.content, weight: mat?.weight || b.weight });
                        }}>
                          <option value="">Select...</option>
                          {materials.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
                          {b.material && !materials.find(m => m.name === b.material) && <option value={b.material}>{b.material}</option>}
                        </select>
                        <input style={{ ...S.cellInput, fontSize: 11, marginTop: 3, color: "#94A3B8" }} value={b.material} onChange={e => updateBOMItem(idx, { material: e.target.value })} placeholder="or type name..." />
                      </td>
                      <td style={S.td}><textarea style={{ ...S.cellInput, minHeight: 48, resize: "vertical" as any, fontSize: 12, lineHeight: 1.4 }} value={b.placement} onChange={e => updateBOMItem(idx, { placement: e.target.value })} placeholder="Placement details..." /></td>
                      <td style={S.td}><input style={{ ...S.cellInput, width: 104 }} value={b.content || ""} onChange={e => updateBOMItem(idx, { content: e.target.value })} placeholder="100% Cotton" /></td>
                      <td style={S.td}><input style={{ ...S.cellInput, width: 62 }} value={b.weight || ""} onChange={e => updateBOMItem(idx, { weight: e.target.value })} placeholder="180g" /></td>
                      <td style={S.td}><input style={{ ...S.cellInput, width: 48, textAlign: "center" }} value={b.quantity} onChange={e => updateBOMItem(idx, { quantity: e.target.value })} /></td>
                      <td style={S.td}>
                        <select style={{ ...S.cellInput, width: 48 }} value={b.uom || "YDS"} onChange={e => updateBOMItem(idx, { uom: e.target.value })}>
                          {["YDS", "MTR", "PCS", "KG", "LB", "DOZ", "SET"].map(u => <option key={u} value={u}>{u}</option>)}
                        </select>
                      </td>
                      <td style={S.td}><input style={{ ...S.cellInput, width: 62, textAlign: "right" }} type="number" step="0.01" value={b.unitCost || ""} onChange={e => updateBOMItem(idx, { unitCost: parseFloat(e.target.value) || 0 })} /></td>
                      <td style={{ ...S.td, color: "#10B981", fontWeight: 600, fontFamily: "monospace", whiteSpace: "nowrap" as any }}>{fmtCurrency(b.totalCost)}</td>
                      {colorways.flatMap(cw => {
                        const spec = (b.colorSpecs || []).find(cs => cs.colorwayId === cw.id) || { colorwayId: cw.id, color: "", pantone: "", trialSize: "" };
                        return [
                          <td key={cw.id + "-c"} style={{ ...S.td, borderLeft: "2px solid #1E3A5F", background: cwBg }}>
                            <input style={{ ...S.cellInput, width: "100%", marginBottom: 3 }} value={spec.color} onChange={e => updateColorSpec(idx, cw.id, { color: e.target.value })} placeholder="Color name" />
                            <input style={{ ...S.cellInput, fontSize: 11, color: "#94A3B8" }} value={spec.pantone} onChange={e => updateColorSpec(idx, cw.id, { pantone: e.target.value })} placeholder="Pantone / code" />
                          </td>,
                          <td key={cw.id + "-d"} style={{ ...S.td, background: cwBg }}>
                            <input style={{ ...S.cellInput, width: 80, textAlign: "center" }} value={spec.trialSize} onChange={e => updateColorSpec(idx, cw.id, { trialSize: e.target.value })} placeholder="32" />
                          </td>,
                        ];
                      })}
                      <td style={S.td}><button style={S.iconBtnTiny} onClick={() => updateSelected({ bom: tp.bom.filter(x => x.id !== b.id) })}>🗑️</button></td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: "#1A2332", borderTop: "2px solid #334155" }}>
                  <td colSpan={9} style={{ ...S.td, textAlign: "right", fontWeight: 700, color: "#F1F5F9" }}>Total BOM Cost:</td>
                  <td style={{ ...S.td, color: "#10B981", fontWeight: 700, fontFamily: "monospace", fontSize: 15 }}>{fmtCurrency(bomTotal)}</td>
                  <td colSpan={colorways.length * 2 + 1} style={S.td} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </>
    );
  }

  // ── Costing Tab ───────────────────────────────────────────────────────────
  function renderCostingTab(tp: TechPack) {
    const c = tp.costing;

    const recalc = (updates: Partial<Costing>) => {
      const merged = { ...c, ...updates };
      merged.duty = Math.round(merged.fob * (merged.dutyRate / 100) * 100) / 100;
      merged.landedCost = Math.round((merged.fob + merged.duty + merged.freight + merged.insurance + merged.otherCosts) * 100) / 100;
      merged.margin = merged.retailPrice > 0 ? Math.round(((merged.retailPrice - merged.landedCost) / merged.retailPrice) * 10000) / 100 : 0;
      updateSelected({ costing: merged });
    };

    const marginColor = c.margin >= 50 ? "#10B981" : c.margin >= 30 ? "#F59E0B" : "#EF4444";

    return (
      <>
        <h3 style={{ margin: "0 0 16px", color: "#F1F5F9", fontSize: 16 }}>Costing Breakdown</h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {/* Left: Inputs */}
          <div>
            <div style={{ ...S.card, padding: 16, marginBottom: 0 }}>
              <div style={{ marginBottom: 12 }}>
                <label style={S.label}>FOB Price ($)</label>
                <input style={S.input} type="number" step="0.01" value={c.fob || ""} onChange={e => recalc({ fob: parseFloat(e.target.value) || 0 })} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={S.label}>Duty Rate (%)</label>
                <input style={S.input} type="number" step="0.1" value={c.dutyRate || ""} onChange={e => recalc({ dutyRate: parseFloat(e.target.value) || 0 })} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={S.label}>Duty Amount ($)</label>
                <div style={{ ...S.input, background: "#1E293B", color: "#94A3B8" }}>{fmtCurrency(c.duty)}</div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={S.label}>Freight ($)</label>
                <input style={S.input} type="number" step="0.01" value={c.freight || ""} onChange={e => recalc({ freight: parseFloat(e.target.value) || 0 })} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={S.label}>Insurance ($)</label>
                <input style={S.input} type="number" step="0.01" value={c.insurance || ""} onChange={e => recalc({ insurance: parseFloat(e.target.value) || 0 })} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={S.label}>Other Costs ($)</label>
                <input style={S.input} type="number" step="0.01" value={c.otherCosts || ""} onChange={e => recalc({ otherCosts: parseFloat(e.target.value) || 0 })} />
              </div>
            </div>
          </div>

          {/* Right: Summary */}
          <div>
            <div style={{ ...S.card, padding: 16, marginBottom: 16 }}>
              <div style={{ marginBottom: 16 }}>
                <div style={{ color: "#6B7280", fontSize: 12, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Landed Cost</div>
                <div style={{ color: "#F1F5F9", fontSize: 28, fontWeight: 700, fontFamily: "monospace" }}>{fmtCurrency(c.landedCost)}</div>
                <div style={{ color: "#6B7280", fontSize: 11, marginTop: 4 }}>FOB + Duty + Freight + Insurance + Other</div>
              </div>

              <div style={{ borderTop: "1px solid #334155", paddingTop: 12, marginBottom: 12 }}>
                <label style={S.label}>Wholesale Price ($)</label>
                <input style={S.input} type="number" step="0.01" value={c.wholesalePrice || ""} onChange={e => recalc({ wholesalePrice: parseFloat(e.target.value) || 0 })} />
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={S.label}>Retail Price ($)</label>
                <input style={S.input} type="number" step="0.01" value={c.retailPrice || ""} onChange={e => recalc({ retailPrice: parseFloat(e.target.value) || 0 })} />
              </div>

              {/* Margin Indicator */}
              <div style={{ background: "#0F172A", borderRadius: 12, padding: 16, textAlign: "center" }}>
                <div style={{ color: "#6B7280", fontSize: 12, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Margin</div>
                <div style={{ fontSize: 36, fontWeight: 800, color: marginColor, fontFamily: "monospace" }}>{c.margin.toFixed(1)}%</div>
                <div style={{ width: "100%", height: 8, background: "#334155", borderRadius: 4, overflow: "hidden", marginTop: 12 }}>
                  <div style={{ width: `${Math.min(c.margin, 100)}%`, height: "100%", background: marginColor, borderRadius: 4, transition: "width 0.3s" }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 10, color: "#6B7280" }}>
                  <span>0%</span>
                  <span style={{ color: "#EF4444" }}>30%</span>
                  <span style={{ color: "#F59E0B" }}>50%</span>
                  <span>100%</span>
                </div>
              </div>
            </div>

            <div>
              <label style={S.label}>Costing Notes</label>
              <textarea style={{ ...S.textarea, minHeight: 60 }} value={c.notes} onChange={e => recalc({ notes: e.target.value })} placeholder="Notes about costing..." />
            </div>
          </div>
        </div>
      </>
    );
  }

  // ── Approvals Tab ─────────────────────────────────────────────────────────
  function renderApprovalsTab(tp: TechPack) {
    const approvals = tp.approvals.length > 0 ? tp.approvals : emptyApprovals();

    // Check if previous stages are approved for sequential unlock
    const isStageUnlocked = (index: number) => {
      if (index === 0) return true;
      return approvals.slice(0, index).every(a => a.status === "Approved");
    };

    return (
      <>
        <h3 style={{ margin: "0 0 16px", color: "#F1F5F9", fontSize: 16 }}>Approval Workflow</h3>

        {/* Progress bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 20, padding: "0 8px" }}>
          {approvals.map((a, i) => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", flex: 1 }}>
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: APPROVAL_STATUS_COLORS[a.status] + "33", border: `2px solid ${APPROVAL_STATUS_COLORS[a.status]}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: APPROVAL_STATUS_COLORS[a.status], fontWeight: 700, flexShrink: 0 }}>
                {a.status === "Approved" ? "✓" : a.status === "Rejected" ? "✕" : i + 1}
              </div>
              {i < approvals.length - 1 && <div style={{ flex: 1, height: 2, background: a.status === "Approved" ? "#10B981" : "#334155", margin: "0 4px" }} />}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20, padding: "0 8px" }}>
          {approvals.map(a => (
            <span key={a.id} style={{ fontSize: 10, color: "#6B7280", textAlign: "center", flex: 1 }}>{a.stage}</span>
          ))}
        </div>

        {/* Approval cards */}
        {approvals.map((a, idx) => {
          const unlocked = isStageUnlocked(idx);
          return (
            <div key={a.id} style={{ background: unlocked ? "#0F172A" : "#0F172A88", borderRadius: 10, padding: 16, marginBottom: 10, border: `1px solid ${APPROVAL_STATUS_COLORS[a.status]}44`, opacity: unlocked ? 1 : 0.5 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ color: "#F1F5F9", fontWeight: 700, fontSize: 15 }}>{a.stage}</span>
                  <span style={{ ...S.badge, background: APPROVAL_STATUS_COLORS[a.status] + "22", color: APPROVAL_STATUS_COLORS[a.status], border: `1px solid ${APPROVAL_STATUS_COLORS[a.status]}44` }}>{a.status}</span>
                </div>
                {a.date && <span style={{ color: "#6B7280", fontSize: 12 }}>{fmtDate(a.date)}</span>}
              </div>

              <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={S.label}>Approver</label>
                  <input style={S.input} value={a.approver} disabled={!unlocked} onChange={e => {
                    const updated = [...approvals];
                    updated[idx] = { ...a, approver: e.target.value };
                    updateSelected({ approvals: updated });
                  }} placeholder="Approver name" />
                </div>
              </div>

              <label style={S.label}>Comments</label>
              <textarea style={{ ...S.textarea, minHeight: 40, marginBottom: 10 }} value={a.comments} disabled={!unlocked} onChange={e => {
                const updated = [...approvals];
                updated[idx] = { ...a, comments: e.target.value };
                updateSelected({ approvals: updated });
              }} placeholder="Add comments..." />

              {unlocked && a.status !== "Approved" && (
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={{ ...S.btnSmall, background: "#10B981", color: "#fff", border: "none" }} onClick={() => {
                    const updated = [...approvals];
                    updated[idx] = { ...a, status: "Approved", date: today() };
                    updateSelected({ approvals: updated });
                  }}>Approve</button>
                  <button style={{ ...S.btnSmall, background: "#EF4444", color: "#fff", border: "none" }} onClick={() => {
                    const updated = [...approvals];
                    updated[idx] = { ...a, status: "Rejected", date: today() };
                    updateSelected({ approvals: updated });
                  }}>Reject</button>
                  <button style={{ ...S.btnSmall, background: "#F59E0B", color: "#fff", border: "none" }} onClick={() => {
                    const updated = [...approvals];
                    updated[idx] = { ...a, status: "Revision Required", date: today() };
                    updateSelected({ approvals: updated });
                  }}>Request Revision</button>
                  {a.status !== "Pending" && (
                    <button style={{ ...S.btnSmall, background: "none", color: "#6B7280", border: "1px solid #334155" }} onClick={() => {
                      const updated = [...approvals];
                      updated[idx] = { ...a, status: "Pending", date: null };
                      updateSelected({ approvals: updated });
                    }}>Reset</button>
                  )}
                </div>
              )}
              {!unlocked && <div style={{ color: "#6B7280", fontSize: 12, fontStyle: "italic" }}>Previous stage must be approved first</div>}
            </div>
          );
        })}
      </>
    );
  }

  // ── Samples Tab ───────────────────────────────────────────────────────────
  function renderSamplesTab(tp: TechPack) {
    const sampleStatuses: Sample["status"][] = ["Requested", "In Progress", "Received", "Approved", "Rejected"];

    return (
      <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0, color: "#F1F5F9", fontSize: 16 }}>Sample Tracking</h3>
          <button style={S.btnSmall} onClick={() => {
            updateSelected({ samples: [...tp.samples, { id: uid(), type: "Proto", status: "Requested", requestDate: today(), receiveDate: null, vendor: "", comments: "", images: [] }] });
          }}>+ Add Sample</button>
        </div>

        {tp.samples.length === 0 ? (
          <div style={{ ...S.emptyState, padding: 30 }}><p style={{ color: "#6B7280" }}>No samples tracked yet.</p></div>
        ) : (
          tp.samples.map((s, idx) => (
            <div key={s.id} style={{ background: "#0F172A", borderRadius: 10, padding: 16, marginBottom: 12, border: `1px solid ${SAMPLE_STATUS_COLORS[s.status]}44` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <select style={S.select} value={s.type} onChange={e => {
                    const updated = [...tp.samples];
                    updated[idx] = { ...s, type: e.target.value as Sample["type"] };
                    updateSelected({ samples: updated });
                  }}>
                    {SAMPLE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <span style={{ ...S.badge, background: (SAMPLE_STATUS_COLORS[s.status] || "#6B7280") + "22", color: SAMPLE_STATUS_COLORS[s.status] || "#6B7280", border: `1px solid ${SAMPLE_STATUS_COLORS[s.status] || "#6B7280"}44` }}>{s.status}</span>
                </div>
                <button style={{ ...S.iconBtn, color: "#EF4444" }} onClick={() => updateSelected({ samples: tp.samples.filter(x => x.id !== s.id) })}>🗑️</button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={S.label}>Status</label>
                  <select style={{ ...S.select, width: "100%" }} value={s.status} onChange={e => {
                    const updated = [...tp.samples];
                    updated[idx] = { ...s, status: e.target.value as Sample["status"], receiveDate: e.target.value === "Received" || e.target.value === "Approved" || e.target.value === "Rejected" ? s.receiveDate || today() : s.receiveDate };
                    updateSelected({ samples: updated });
                  }}>
                    {sampleStatuses.map(st => <option key={st} value={st}>{st}</option>)}
                  </select>
                </div>
                <div>
                  <label style={S.label}>Vendor</label>
                  <input style={S.input} value={s.vendor} onChange={e => {
                    const updated = [...tp.samples];
                    updated[idx] = { ...s, vendor: e.target.value };
                    updateSelected({ samples: updated });
                  }} placeholder="Vendor name" />
                </div>
                <div>
                  <label style={S.label}>Request Date</label>
                  <input style={S.input} type="date" value={s.requestDate} onChange={e => {
                    const updated = [...tp.samples];
                    updated[idx] = { ...s, requestDate: e.target.value };
                    updateSelected({ samples: updated });
                  }} />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={S.label}>Receive Date</label>
                  <input style={S.input} type="date" value={s.receiveDate || ""} onChange={e => {
                    const updated = [...tp.samples];
                    updated[idx] = { ...s, receiveDate: e.target.value || null };
                    updateSelected({ samples: updated });
                  }} />
                </div>
                <div>
                  <label style={S.label}>Comments</label>
                  <input style={S.input} value={s.comments} onChange={e => {
                    const updated = [...tp.samples];
                    updated[idx] = { ...s, comments: e.target.value };
                    updateSelected({ samples: updated });
                  }} placeholder="Comments..." />
                </div>
              </div>

              {/* Sample Images */}
              <div>
                <label style={S.label}>Images</label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {s.images.map((img, imgIdx) => (
                    <div key={imgIdx} style={{ position: "relative", width: 60, height: 60 }}>
                      <img src={img} alt="" style={{ width: 60, height: 60, borderRadius: 6, objectFit: "cover", cursor: "pointer" }} onClick={() => setLightboxImg(img)} />
                      <button style={{ position: "absolute", top: -4, right: -4, width: 18, height: 18, borderRadius: "50%", background: "#EF4444", color: "#fff", border: "none", fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                        onClick={() => {
                          const updated = [...tp.samples];
                          updated[idx] = { ...s, images: s.images.filter((_, i) => i !== imgIdx) };
                          updateSelected({ samples: updated });
                        }}>✕</button>
                    </div>
                  ))}
                  <label style={{ width: 60, height: 60, borderRadius: 6, border: "2px dashed #334155", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#6B7280", fontSize: 20 }}>
                    +
                    <input type="file" accept="image/*" style={{ display: "none" }} onChange={async e => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const url = await uploadImage(file, `/techpacks/${tp.id}/samples/${s.id}/${file.name}`);
                      if (url) {
                        const updated = [...tp.samples];
                        updated[idx] = { ...s, images: [...s.images, url] };
                        updateSelected({ samples: updated });
                      } else {
                        showToast("Image upload failed");
                      }
                    }} />
                  </label>
                </div>
              </div>
            </div>
          ))
        )}
      </>
    );
  }

  // ── Images Tab ────────────────────────────────────────────────────────────
  function renderImagesTab(tp: TechPack) {
    return (
      <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0, color: "#F1F5F9", fontSize: 16 }}>Product Images</h3>
          <label style={S.btnSmall}>
            + Upload Image
            <input type="file" accept="image/*" multiple style={{ display: "none" }} onChange={async e => {
              const files = e.target.files;
              if (!files) return;
              for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const url = await uploadImage(file, `/techpacks/${tp.id}/images/${file.name}`);
                if (url) {
                  const img: TPImage = { id: uid(), url, name: file.name, type: file.type };
                  tp = { ...tp, images: [...tp.images, img] };
                  updateSelected({ images: tp.images });
                }
              }
            }} />
          </label>
        </div>

        {tp.images.length === 0 ? (
          <div style={{ ...S.emptyState, padding: 40 }}>
            <div style={{ fontSize: 48 }}>🖼️</div>
            <p style={{ color: "#6B7280" }}>No images uploaded yet</p>
            <label style={S.btnPrimarySmall}>
              Upload Images
              <input type="file" accept="image/*" multiple style={{ display: "none" }} onChange={async e => {
                const files = e.target.files;
                if (!files) return;
                for (let i = 0; i < files.length; i++) {
                  const file = files[i];
                  const url = await uploadImage(file, `/techpacks/${tp.id}/images/${file.name}`);
                  if (url) {
                    const img: TPImage = { id: uid(), url, name: file.name, type: file.type };
                    tp = { ...tp, images: [...tp.images, img] };
                    updateSelected({ images: tp.images });
                  }
                }
              }} />
            </label>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 }}>
            {tp.images.map(img => (
              <div key={img.id} style={{ position: "relative", borderRadius: 8, overflow: "hidden", border: "1px solid #334155", cursor: "pointer" }}>
                <img src={img.url} alt={img.name} style={{ width: "100%", height: 150, objectFit: "cover" }} onClick={() => setLightboxImg(img.url)} />
                <div style={{ padding: "6px 8px", background: "#0F172A", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ color: "#94A3B8", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{img.name}</span>
                  <button style={{ ...S.iconBtnTiny, flexShrink: 0 }} onClick={() => updateSelected({ images: tp.images.filter(x => x.id !== img.id) })}>🗑️</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  // ── Create Modal ──────────────────────────────────────────────────────────
  function renderCreateModal() {
    const selCat = dcCategories.find(c => c.name === createForm.category);
    const subCats: string[] = selCat?.subCategories || [];

    // Inline quick-add for brand
    const addBrand = async () => {
      const name = prompt("New brand name:");
      if (!name?.trim()) return;
      const nb = { id: Math.random().toString(36).slice(2), name: name.trim(), short: name.trim().slice(0, 5).toUpperCase(), color: "#3498DB", isPrivateLabel: false };
      const updated = [...dcBrands, nb];
      setDcBrands(updated);
      await dcSave("brands", updated);
      setCreateForm(f => ({ ...f, brand: nb.name }));
      showToast(`Brand "${nb.name}" added`);
    };

    // Inline quick-add for season
    const addSeason = async () => {
      const name = prompt("New season name (e.g. Fall 2026):");
      if (!name?.trim()) return;
      const updated = [...dcSeasons, name.trim()];
      setDcSeasons(updated);
      await dcSave("seasons", updated);
      setCreateForm(f => ({ ...f, season: name.trim() }));
      showToast(`Season "${name.trim()}" added`);
    };

    // Team member picker dropdown
    const TeamMemberSelect = ({ field, label }: { field: "techDesigner" | "graphicArtist" | "productDeveloper" | "designer"; label: string }) => {
      const val = createForm[field];
      const member = dcTeam.find(m => m.name === val);
      const isOpen = openTeamDrop === field;
      return (
        <div style={{ position: "relative" }}>
          <label style={S.label}>{label}</label>
          <button type="button" style={{ ...S.input, display: "flex", alignItems: "center", gap: 8, cursor: "pointer", textAlign: "left" as any }}
            onClick={() => setOpenTeamDrop(isOpen ? null : field)}>
            {member ? (
              <>
                {member.avatar
                  ? <img src={member.avatar} style={{ width: 22, height: 22, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
                  : <div style={{ width: 22, height: 22, borderRadius: "50%", background: member.color || "#3B82F6", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#fff", flexShrink: 0 }}>{member.initials || member.name?.[0] || "?"}</div>
                }
                <span style={{ fontSize: 13, color: "#F1F5F9" }}>{member.name}</span>
                <span style={{ fontSize: 11, color: "#6B7280", marginLeft: "auto" }}>{member.role}</span>
              </>
            ) : (
              <span style={{ color: "#4B5563", fontSize: 13 }}>Select {label}...</span>
            )}
            <span style={{ marginLeft: "auto", color: "#6B7280", fontSize: 10 }}>▾</span>
          </button>
          {isOpen && (
            <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: "#1E293B", border: "1px solid #334155", borderRadius: 10, zIndex: 300, maxHeight: 220, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,.5)" }}>
              <div style={{ padding: "6px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, color: "#6B7280", fontSize: 12, borderBottom: "1px solid #334155" }}
                onClick={() => { setCreateForm(f => ({ ...f, [field]: "" })); setOpenTeamDrop(null); }}>
                — None —
              </div>
              {dcTeam.map(m => (
                <div key={m.id} style={{ padding: "8px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, transition: "background .1s" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#334155")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                  onClick={() => { setCreateForm(f => ({ ...f, [field]: m.name })); setOpenTeamDrop(null); }}>
                  {m.avatar
                    ? <img src={m.avatar} style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
                    : <div style={{ width: 28, height: 28, borderRadius: "50%", background: m.color || "#3B82F6", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#fff", flexShrink: 0 }}>{m.initials || m.name?.[0] || "?"}</div>
                  }
                  <div>
                    <div style={{ color: "#F1F5F9", fontSize: 13, fontWeight: 600 }}>{m.name}</div>
                    <div style={{ color: "#6B7280", fontSize: 11 }}>{m.role}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    };

    return (
      <div style={S.modalOverlay} onClick={() => { setShowCreateModal(false); setOpenTeamDrop(null); }}>
        <div style={{ ...S.modal, width: 620, maxWidth: "95vw" }} onClick={e => e.stopPropagation()}>
          <div style={S.modalHeader}>
            <h2 style={S.modalTitle}>Create Tech Pack</h2>
            <button style={S.closeBtn} onClick={() => setShowCreateModal(false)}>✕</button>
          </div>
          <div style={S.modalBody}>

            {/* Row 1: Style Number + Style Name */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Style Number *</label>
                <input style={S.input} value={createForm.styleNumber} onChange={e => setCreateForm(f => ({ ...f, styleNumber: e.target.value }))} placeholder="e.g. OXF-001" autoFocus />
              </div>
              <div>
                <label style={S.label}>Style Name *</label>
                <input style={S.input} value={createForm.styleName} onChange={e => setCreateForm(f => ({ ...f, styleName: e.target.value }))} placeholder="e.g. Classic Oxford Shirt" />
              </div>
            </div>

            {/* Row 2: Brand + Season */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Brand</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <select style={{ ...S.select, flex: 1 }} value={createForm.brand} onChange={e => setCreateForm(f => ({ ...f, brand: e.target.value }))}>
                    <option value="">Select brand...</option>
                    {dcBrands.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
                  </select>
                  <button style={S.btnSmall} title="Add new brand" onClick={addBrand}>+</button>
                </div>
              </div>
              <div>
                <label style={S.label}>Season</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <select style={{ ...S.select, flex: 1 }} value={createForm.season} onChange={e => setCreateForm(f => ({ ...f, season: e.target.value }))}>
                    <option value="">Select season...</option>
                    {dcSeasons.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <button style={S.btnSmall} title="Add new season" onClick={addSeason}>+</button>
                </div>
              </div>
            </div>

            {/* Row 3: Gender + Vendor */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Gender</label>
                <select style={{ ...S.select, width: "100%" }} value={createForm.gender} onChange={e => setCreateForm(f => ({ ...f, gender: e.target.value }))}>
                  <option value="">Select gender...</option>
                  {dcGenders.map(g => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
              <div>
                <label style={S.label}>Vendor</label>
                <select style={{ ...S.select, width: "100%" }} value={createForm.vendor} onChange={e => setCreateForm(f => ({ ...f, vendor: e.target.value }))}>
                  <option value="">Select vendor...</option>
                  {dcVendors.map(v => <option key={v.id} value={v.name}>{v.name}{v.country ? ` (${v.country})` : ""}</option>)}
                </select>
              </div>
            </div>

            {/* Row 4: Category + Sub Category */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Category</label>
                <select style={{ ...S.select, width: "100%" }} value={createForm.category} onChange={e => setCreateForm(f => ({ ...f, category: e.target.value, subCategory: "" }))}>
                  <option value="">Select category...</option>
                  {dcCategories.length > 0
                    ? dcCategories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)
                    : CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)
                  }
                </select>
              </div>
              <div>
                <label style={S.label}>Sub Category</label>
                <select style={{ ...S.select, width: "100%", opacity: subCats.length === 0 ? 0.5 : 1 }} value={createForm.subCategory} onChange={e => setCreateForm(f => ({ ...f, subCategory: e.target.value }))} disabled={subCats.length === 0}>
                  <option value="">{subCats.length === 0 ? "Select category first" : "Select sub category..."}</option>
                  {subCats.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>

            {/* Row 5: Tech Designer + Graphic Artist */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <TeamMemberSelect field="techDesigner" label="Tech Designer" />
              <TeamMemberSelect field="graphicArtist" label="Graphic Artist" />
            </div>

            {/* Row 6: Product Developer + Designer */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <TeamMemberSelect field="productDeveloper" label="Product Developer" />
              <TeamMemberSelect field="designer" label="Designer" />
            </div>

            {/* Description */}
            <div style={{ marginBottom: 16 }}>
              <label style={S.label}>Description</label>
              <textarea style={{ ...S.textarea, minHeight: 56 }} value={createForm.description} onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))} placeholder="Style description..." />
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button style={{ ...S.btnSecondary, flex: 1 }} onClick={() => setShowCreateModal(false)}>Cancel</button>
              <button style={{ ...S.btnPrimary, flex: 2, opacity: (!createForm.styleName || !createForm.styleNumber) ? 0.5 : 1 }}
                disabled={!createForm.styleName || !createForm.styleNumber}
                onClick={handleCreate}>Create Tech Pack</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Material Modal ────────────────────────────────────────────────────────
  function renderMaterialModal() {
    return (
      <div style={S.modalOverlay} onClick={() => { setShowMaterialModal(false); setEditingMaterial(null); }}>
        <div style={{ ...S.modal, width: 520 }} onClick={e => e.stopPropagation()}>
          <div style={S.modalHeader}>
            <h2 style={S.modalTitle}>{editingMaterial ? "Edit Material" : "Add Material"}</h2>
            <button style={S.closeBtn} onClick={() => { setShowMaterialModal(false); setEditingMaterial(null); }}>✕</button>
          </div>
          <div style={S.modalBody}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Name *</label>
                <input style={S.input} value={matForm.name} onChange={e => setMatForm(f => ({ ...f, name: e.target.value }))} placeholder="Material name" />
              </div>
              <div>
                <label style={S.label}>Type</label>
                <select style={{ ...S.select, width: "100%" }} value={matForm.type} onChange={e => setMatForm(f => ({ ...f, type: e.target.value }))}>
                  {MATERIAL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={S.label}>Composition</label>
              <input style={S.input} value={matForm.composition} onChange={e => setMatForm(f => ({ ...f, composition: e.target.value }))} placeholder="e.g. 100% Cotton" />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Weight</label>
                <input style={S.input} value={matForm.weight} onChange={e => setMatForm(f => ({ ...f, weight: e.target.value }))} placeholder="e.g. 180 GSM" />
              </div>
              <div>
                <label style={S.label}>Width</label>
                <input style={S.input} value={matForm.width} onChange={e => setMatForm(f => ({ ...f, width: e.target.value }))} placeholder='e.g. 58"' />
              </div>
              <div>
                <label style={S.label}>Color</label>
                <input style={S.input} value={matForm.color} onChange={e => setMatForm(f => ({ ...f, color: e.target.value }))} placeholder="Color" />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Supplier</label>
                <input style={S.input} value={matForm.supplier} onChange={e => setMatForm(f => ({ ...f, supplier: e.target.value }))} placeholder="Supplier name" />
              </div>
              <div>
                <label style={S.label}>Unit Price ($)</label>
                <input style={S.input} type="number" step="0.01" value={matForm.unitPrice || ""} onChange={e => setMatForm(f => ({ ...f, unitPrice: parseFloat(e.target.value) || 0 }))} />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>MOQ</label>
                <input style={S.input} value={matForm.moq} onChange={e => setMatForm(f => ({ ...f, moq: e.target.value }))} placeholder="Min order qty" />
              </div>
              <div>
                <label style={S.label}>Lead Time</label>
                <input style={S.input} value={matForm.leadTime} onChange={e => setMatForm(f => ({ ...f, leadTime: e.target.value }))} placeholder="e.g. 4 weeks" />
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={S.label}>Certifications (comma separated)</label>
              <input style={S.input} value={matForm.certifications} onChange={e => setMatForm(f => ({ ...f, certifications: e.target.value }))} placeholder="e.g. OEKO-TEX, GOTS, BCI" />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={S.label}>Notes</label>
              <textarea style={{ ...S.textarea, minHeight: 50 }} value={matForm.notes} onChange={e => setMatForm(f => ({ ...f, notes: e.target.value }))} />
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button style={{ ...S.btnSecondary, flex: 1 }} onClick={() => { setShowMaterialModal(false); setEditingMaterial(null); }}>Cancel</button>
              <button style={{ ...S.btnPrimary, flex: 2, opacity: !matForm.name ? 0.5 : 1 }} disabled={!matForm.name} onClick={handleSaveMaterial}>
                {editingMaterial ? "Update Material" : "Add Material"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// STYLES
// ══════════════════════════════════════════════════════════════════════════════
const S: Record<string, React.CSSProperties> = {
  app:          { minHeight: "100vh", background: "#0F172A", color: "#F1F5F9", fontFamily: "'DM Sans', 'Segoe UI', sans-serif" },

  // Nav
  nav:          { background: "#1E293B", borderBottom: "1px solid #334155", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56, position: "sticky", top: 0, zIndex: 100 },
  navLeft:      { display: "flex", alignItems: "center", gap: 12 },
  navLogo:      { width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg,#3B82F6,#8B5CF6)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 16 },
  navTitle:     { fontWeight: 700, fontSize: 16, color: "#F1F5F9" },
  navSub:       { fontSize: 12, color: "#6B7280" },
  navRight:     { display: "flex", alignItems: "center", gap: 8 },
  navBtn:       { background: "none", border: "1px solid #334155", color: "#94A3B8", borderRadius: 6, padding: "5px 12px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" },
  navBtnActive: { background: "#3B82F620", border: "1px solid #3B82F6", color: "#60A5FA", borderRadius: 6, padding: "5px 12px", fontSize: 13, cursor: "pointer", fontWeight: 600, fontFamily: "inherit" },
  navBtnDanger: { background: "none", border: "1px solid #EF4444", color: "#EF4444", borderRadius: 6, padding: "5px 12px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" },

  // Content
  content:      { maxWidth: "90%", margin: "0 auto", padding: "24px 20px" },
  statsRow:     { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 20 },
  statCard:     { background: "#1E293B", borderRadius: 12, padding: 20, display: "flex", flexDirection: "column", gap: 6 },
  card:         { background: "#1E293B", borderRadius: 12, padding: 20, marginBottom: 20 },
  cardTitle:    { margin: "0 0 16px", fontSize: 16, fontWeight: 700, color: "#F1F5F9" },

  // Tech Pack Card
  tpCard:       { background: "#1E293B", borderRadius: 12, padding: 16, border: "1px solid #334155", cursor: "pointer", transition: "border-color 0.15s, transform 0.15s" },

  // Filters
  filters:      { display: "flex", gap: 10, marginBottom: 16, alignItems: "center", flexWrap: "wrap" as any },

  // PO Row / list item
  poRow:        { display: "flex", alignItems: "center", gap: 16, padding: "14px 16px", borderRadius: 8, marginBottom: 8, background: "#0F172A", cursor: "pointer", transition: "background .15s" },
  badge:        { fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20 },

  // Empty state
  emptyState:   { textAlign: "center", padding: 40, color: "#6B7280", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" },

  // Forms
  input:        { width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", color: "#F1F5F9", fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit" },
  select:       { background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "9px 12px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit" },
  textarea:     { width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", color: "#F1F5F9", fontSize: 14, resize: "vertical" as any, outline: "none", fontFamily: "inherit", boxSizing: "border-box" },
  label:        { color: "#94A3B8", fontSize: 13, display: "block", marginBottom: 4 },

  // Buttons
  btnPrimary:   { background: "linear-gradient(135deg,#3B82F6,#8B5CF6)", color: "#fff", border: "none", borderRadius: 8, padding: "10px 20px", fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit" },
  btnPrimarySmall: { background: "linear-gradient(135deg,#3B82F6,#8B5CF6)", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" },
  btnSecondary: { background: "none", border: "1px solid #334155", color: "#94A3B8", borderRadius: 8, padding: "8px 16px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" },
  btnSmall:     { background: "#334155", color: "#D1D5DB", border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 },
  iconBtn:      { background: "none", border: "none", cursor: "pointer", fontSize: 16, padding: 4, lineHeight: 1 },
  iconBtnTiny:  { background: "none", border: "none", cursor: "pointer", fontSize: 12, padding: 2, lineHeight: 1, color: "#6B7280" },

  // Modal
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" },
  modal:        { background: "#1E293B", borderRadius: 16, width: 520, maxHeight: "85vh", overflow: "hidden", display: "flex", flexDirection: "column" },
  modalHeader:  { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid #334155" },
  modalTitle:   { margin: 0, fontSize: 18, fontWeight: 700, color: "#F1F5F9" },
  modalBody:    { padding: 20, overflowY: "auto" },
  closeBtn:     { background: "none", border: "none", color: "#6B7280", fontSize: 18, cursor: "pointer", lineHeight: 1, fontFamily: "inherit" },

  // Detail panel
  detailOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 200, display: "flex", justifyContent: "flex-end" },
  detailPanel:   { background: "#1E293B", width: 780, maxWidth: "95vw", height: "100%", overflowY: "auto", display: "flex", flexDirection: "column" },
  detailHeader:  { padding: "20px 24px", borderBottom: "1px solid #334155", display: "flex", justifyContent: "space-between", alignItems: "flex-start", background: "#0F172A" },
  detailPONum:   { fontFamily: "monospace", color: "#60A5FA", fontWeight: 800, fontSize: 20 },
  detailVendor:  { color: "#D1D5DB", fontWeight: 600, fontSize: 15, marginTop: 4 },

  // Info grid
  infoGrid:      { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 },
  infoCell:      { background: "#0F172A", borderRadius: 8, padding: 12 },
  infoCellLabel: { color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 },
  infoCellValue: { color: "#F1F5F9", fontSize: 14, fontWeight: 600 },

  // Tables
  table:        { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th:           { padding: "10px 8px", textAlign: "left", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155", background: "#1E293B", whiteSpace: "nowrap" },
  td:           { padding: "8px", borderBottom: "1px solid #1E293B", color: "#D1D5DB", verticalAlign: "middle" },
  cellInput:    { background: "transparent", border: "1px solid transparent", borderRadius: 4, padding: "4px 6px", color: "#F1F5F9", fontSize: 13, outline: "none", fontFamily: "inherit", width: "100%", boxSizing: "border-box" },

  // Table wrap for non-HTML tables
  tableWrap:    { background: "#1E293B", borderRadius: 12, overflow: "hidden", border: "1px solid #334155" },
  tableHeader:  { display: "flex", padding: "12px 16px", background: "#0F172A", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, gap: 12, borderBottom: "1px solid #334155", fontWeight: 600 },
  tableRow:     { display: "flex", padding: "10px 16px", gap: 12, fontSize: 13, alignItems: "center", borderBottom: "1px solid #1E293B" },
};
