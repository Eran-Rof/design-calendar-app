import React, { useState, useEffect, useRef, useCallback } from "react";
import { msSignIn, loadMsTokens, saveMsTokens, clearMsTokens, getMsAccessToken, MS_CLIENT_ID, MS_TENANT_ID } from "./utils/msAuth";
import { styledEmailHtml } from "./utils/emailHtml";
// v2026-03-24b

// ── Supabase ─────────────────────────────────────────────────────────────────
import { SB_URL, SB_KEY, SB_HEADERS, supabaseClient } from "./utils/supabase";
import NotificationsShell from "./components/notifications/NotificationsShell";
import NotificationsPage from "./components/notifications/NotificationsPage";
import { useAppUnreadCount } from "./components/notifications/useAppUnreadCount";
import { GlobalSearchPaletteAuto } from "./components/GlobalSearchPalette";
// Cross-cutter T4-5 — Personalization: favorites drawer + click telemetry.
// Shared left navigation drawer (de-iconed, collapsible) — mirrors GS1.
import { NavDrawer, DRAWER_W_OPEN, DRAWER_W_CLOSED } from "./tanda/NavDrawer";
import SearchableSelect from "./tanda/components/SearchableSelect";
import { TECHPACK_MODULES, TECHPACK_SECTIONS } from "./techpackModules";
// Tangerine P10-5 — Top-bar entity switcher.
import EntitySwitcher from "./components/EntitySwitcher";
import { usePersonalization } from "./hooks/usePersonalization";
import { techpackViewToMenuKey } from "./lib/techpackViewToMenuKey";
import { useDocumentTitle, humanizeView } from "./shared/useDocumentTitle";
import { sb, appDataSave } from "./techpack/supabase";
import { graphGet, graphPost, type GraphSession } from "./techpack/msGraph";
import { EMAIL_COLORS, FolderIcon } from "./techpack/emailStyles";
import {
  filterTechPacks,
  computeDashboardStats,
  flattenAllSamples,
  uniqueBrands,
  uniqueSeasons,
  filterMaterials,
  filterSpecSheets,
  subCategoriesFor,
} from "./techpack/listLogic";
// Types + constants + factories live in src/techpack/. Phase 1 of the
// TechPack architecture split — see project_plm_cleanup_backlog.md.
import type {
  User, Measurement, ConstructionDetail, Colorway, BOMColorSpec,
  SketchCallout, FlatSketch, BOMItem, Costing, Approval, Sample,
  TPImage, TechPack, Material, SpecSheetRow, SpecSheet, SpecTemplate,
  View, DetailTab,
} from "./techpack/types";
import {
  STATUSES, STATUS_COLORS, APPROVAL_STAGES, APPROVAL_STATUS_COLORS,
  SAMPLE_TYPES, SAMPLE_STATUS_COLORS, MATERIAL_TYPES, CW_COLORS,
  CATEGORIES, SEASONS, DEFAULT_SIZES, SIZE_PRESETS,
} from "./techpack/constants";
import { uid, today, fmtDate, fmtCurrency, initials, stripHtml } from "./techpack/utils";
import {
  emptyCosting, emptyApprovals, emptyTechPack,
  materialFromForm, EMPTY_MATERIAL_FORM,
  EMPTY_CREATE_FORM, createFormForUser, EMPTY_SPEC_SHEET_FORM,
} from "./techpack/factories";
import { BUILTIN_TEMPLATES } from "./techpack/builtinTemplates";
import S from "./techpack/styles";
import {
  buildSpecSheetWb as tpBuildSpecSheetWb,
  xlsxDownload as tpXlsxDownload,
  downloadSpecSheetExcel as tpDownloadSpecSheetExcel,
  downloadSpecSheetTemplate as tpDownloadSpecSheetTemplate,
  downloadMaterialsExcel as tpDownloadMaterialsExcel,
  parseSpecSheetExcel as tpParseSpecSheetExcel,
  extractStyleInfoFromAoa,
  detectSpecSheetHeader,
} from "./techpack/xlsx";
import {
  recomputeCosting,
  marginTierColor,
  recomputeBomItemTotal,
  bomTotal,
  isApprovalStageUnlocked,
} from "./techpack/calc";
import {
  createColorway,
  addColorwayToBOM,
  removeColorwayFromBOM,
  createBOMItem,
  updateColorSpecOnBOM,
  addSketchCallout,
  updateSketchCallout,
  removeSketchCallout,
  sortCalloutsByNumber,
} from "./techpack/bomOps";
import {
  createMeasurementRow,
  addSizeToMeasurements,
  removeSizeFromMeasurements,
  createSpecSheetRow,
  addSizeToSpecSheet,
  removeSizeFromSpecSheet,
} from "./techpack/specOps";
import {
  createEmptySample,
  updateSampleStatus,
} from "./techpack/sampleOps";
import {
  tpEmailPrefix as tpEmailPrefixHelper,
  buildInboxSearchUrl,
  buildThreadUrl,
  buildSentFolderSearchUrl,
  buildSendMailPayload,
  buildAbsoluteMessageUrl,
  buildAttachmentsUrl,
  buildReplyUrl,
  buildMarkAsReadPayload,
  buildReplyPayload,
} from "./techpack/tpEmail";
import {
  slugifyTPName,
  findRofTeam,
  keepRealMessages,
  buildChannelsListUrl,
  buildChannelMessagesUrl,
  buildChatMessagesUrl,
  buildChannelCreatePayload,
  buildChannelMessagePayload,
  buildOneOnOneChatPayload,
} from "./techpack/tpTeams";
import { CostingTab } from "./techpack/tabs/CostingTab";
import { ApprovalsTab } from "./techpack/tabs/ApprovalsTab";
import { ConstructionTab } from "./techpack/tabs/ConstructionTab";
import { SamplesTab } from "./techpack/tabs/SamplesTab";
import { ImagesTab } from "./techpack/tabs/ImagesTab";
import { BOMTab } from "./techpack/tabs/BOMTab";
import { SketchTab } from "./techpack/tabs/SketchTab";
import { SpecTab } from "./techpack/tabs/SpecTab";
import { MaterialsView } from "./techpack/views/MaterialsView";
import { LibrariesView } from "./techpack/views/LibrariesView";
import { SpecSheetsView } from "./techpack/views/SpecSheetsView";
import { SpecSheetDetail } from "./techpack/views/SpecSheetDetail";
import { SamplesOverview } from "./techpack/views/SamplesOverview";
import { CreateModal } from "./techpack/modals/CreateModal";
import { MaterialModal } from "./techpack/modals/MaterialModal";
import { SpecSheetModal } from "./techpack/modals/SpecSheetModal";
import { TemplatesModal } from "./techpack/modals/TemplatesModal";

// sb helper moved to ./techpack/supabase

// Costing tab gate lives in src/permissions.ts (canSeeCostingTabFromSession).
// Local alias keeps the call sites short.
import { canSeeCostingTabFromSession as canSeeCostingTab } from "./permissions";

// Browser-tab labels for the Tech Pack views; humanizeView() handles the rest.
const TECHPACK_VIEW_LABELS: Record<string, string> = {
  list:   "All Packs",
  detail: "Pack Detail",
};

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
  const [view, setViewRaw] = useState<View>("dashboard");
  // Reflect the active view in the browser tab.
  useDocumentTitle(`${TECHPACK_VIEW_LABELS[view] ?? humanizeView(view)} · Tech Packs`);
  // Cross-cutter T4-5 — personalization. Pull logClick once; the hook
  // is cheap and shares a module-level cache so re-mounts don't refetch.
  // setView wraps the raw setter with fire-and-forget menu-click telemetry.
  // Mapped views (top nav) hit /api/internal/users/me/menu-click; unmapped
  // views (e.g. "detail" — instance route reached by row click) silently
  // skip via the null-returning mapper.
  const { logClick: logTechpackMenuClick } = usePersonalization();
  const setView = (v: View) => {
    const mk = techpackViewToMenuKey(v);
    if (mk) logTechpackMenuClick(mk);
    setViewRaw(v);
  };
  const unreadTechpackNotifs = useAppUnreadCount({
    supabase: supabaseClient,
    userId: (() => { try { const u = sessionStorage.getItem("plm_user"); return u ? (JSON.parse(u) as { id?: string }).id || null : null; } catch { return null; } })(),
    recipientColumn: "recipient_internal_id",
    app: "techpack",
  });
  // ── Left drawer collapse — local + localStorage, mirroring GS1 / Tangerine. ──
  const [navCollapsed, setNavCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("techpack:nav:collapsed:v1") === "1"; } catch { return false; }
  });
  const toggleNavCollapsed = () => setNavCollapsed(v => {
    const next = !v;
    try { localStorage.setItem("techpack:nav:collapsed:v1", next ? "1" : "0"); } catch {}
    return next;
  });
  const onSignOut = () => { try { sessionStorage.removeItem("plm_user"); } catch {} window.location.href = "/"; };
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
  const [ssForm, setSsForm] = useState(EMPTY_SPEC_SHEET_FORM);
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
  const [createForm, setCreateForm] = useState(EMPTY_CREATE_FORM);

  // ── Material form state ───────────────────────────────────────────────────
  const [matForm, setMatForm] = useState(EMPTY_MATERIAL_FORM);

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
    setCreateForm(EMPTY_CREATE_FORM);
    setSelected(tp);
    setDetailTab("spec");
    setView("detail");
  }, [createForm, user, saveTechPack]);

  // ── Save / edit material ──────────────────────────────────────────────────
  const handleSaveMaterial = useCallback(async () => {
    if (!matForm.name) return;
    const mat = materialFromForm(matForm, editingMaterial, today);
    const updated = editingMaterial ? materials.map(m => m.id === mat.id ? mat : m) : [...materials, mat];
    await saveMaterials(updated);
    setShowMaterialModal(false);
    setEditingMaterial(null);
    setMatForm(EMPTY_MATERIAL_FORM);
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
  // Alias the extracted helper so existing call sites stay churn-free.
  const tpSbSave = appDataSave;
  const tpGetToken = async (): Promise<string> => {
    const tok = await getMsAccessToken();
    if (tok) { if (tok !== msToken) setMsToken(tok); return tok; }
    if (msToken) return msToken;
    throw new Error("Not signed in to Microsoft");
  };
  // MS Graph helpers moved to ./techpack/msGraph (tested). The session
  // shape gives Graph the token refresh + 401-handling callback without
  // letting the helper touch React state directly.
  const graphSession: GraphSession = {
    getToken: tpGetToken,
    onSessionExpired: () => { clearMsTokens(); setMsToken(null); setMsDisplayName(""); },
  };
  const tpGraph     = (path: string, _tok?: string) => graphGet(path, graphSession);
  const tpGraphPost = (path: string, body: any, _tok?: string) => graphPost(path, body, graphSession);

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
          <p style={{ color: "#F1F5F9", fontSize: 18 }}>Please log in from the PLM launcher</p>
          <a href="/" style={{ color: "#3B82F6", fontSize: 14, textDecoration: "underline" }}>Go to PLM Launcher</a>
        </div>
      </div>
    );
  }

  // ── Filters ───────────────────────────────────────────────────────────────
  // List filter + dashboard stats + sample flatten moved to
  // ./techpack/listLogic (tested).
  const brands  = uniqueBrands(techPacks);
  const seasons = uniqueSeasons(techPacks);
  const filtered = filterTechPacks(techPacks, {
    status: filterStatus, brand: filterBrand, season: filterSeason, search,
  });
  const dashboardStats = computeDashboardStats(techPacks);
  const statTotal    = dashboardStats.total;
  const statDraft    = dashboardStats.draft;
  const statReview   = dashboardStats.review;
  const statApproved = dashboardStats.approved;
  const allSamples = flattenAllSamples(techPacks);

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
    const rofTeam = findRofTeam(data.value || []);
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
      const chName = slugifyTPName(tpName);
      let channelId = "";
      try {
        const chs = await tpGraph(buildChannelsListUrl(tid), teamsToken);
        const ex = (chs.value || []).find((c: any) => c.displayName === chName);
        if (ex) channelId = ex.id;
      } catch(_) {}
      if (!channelId) {
        const ch = await tpGraphPost(
          buildChannelsListUrl(tid),
          buildChannelCreatePayload(chName, `Tech Pack — ${tpName}`),
          teamsToken,
        );
        channelId = ch.id;
      }
      const newMap = { ...teamsChannelMap, [tpId]: { channelId, teamId: tid } };
      setTeamsChannelMap(newMap);
      await tpSbSave("tp_teams_channel_map", newMap);
      const d = await tpGraph(buildChannelMessagesUrl(tid, channelId), teamsToken);
      setTeamsMessages(m => ({ ...m, [tpId]: keepRealMessages(d.value || []) }));
    } catch(e: any) { alert("Could not start Teams chat: " + e.message); }
    setTeamsCreating(null);
  }
  async function tpSendMsg(tpId: string) {
    const mp = teamsChannelMap[tpId];
    if (!mp || !teamsNewMsg.trim() || !teamsToken) return;
    try {
      const sent = await tpGraphPost(
        buildChannelMessagesUrl(mp.teamId, mp.channelId),
        buildChannelMessagePayload(teamsNewMsg),
      );
      setTeamsMessages(m => ({ ...m, [tpId]: [sent, ...(m[tpId] || [])] }));
      setTeamsNewMsg("");
    } catch(e: any) { alert("Failed to send: " + e.message); }
  }
  async function tpLoadDmMessages(chatId: string) {
    setDmLoading(true);
    setDmError(null);
    try {
      const d = await tpGraph(buildChatMessagesUrl(chatId), teamsToken!);
      const msgs = keepRealMessages((d.value || []) as any[]).reverse();
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
      const chat = await tpGraphPost(
        "/chats",
        buildOneOnOneChatPayload(me.id, teamsDirectTo.trim()),
        teamsToken!,
      );
      await tpGraphPost(
        `/chats/${chat.id}/messages`,
        buildChannelMessagePayload(teamsDirectMsg),
        teamsToken!,
      );
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
      const sent = await tpGraphPost(
        `/chats/${dmChatId}/messages`,
        buildChannelMessagePayload(dmNewMsg),
        teamsToken!,
      );
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
              <input value={teamsSearch} onChange={e => setTeamsSearch(e.target.value)} placeholder="Search…" style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 6, padding: "7px 10px", color: "#F1F5F9", fontSize: 12, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
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
                      <div style={{ background: "#1E293B", border: "1px solid #EF444444", borderRadius: 8, padding: "10px 14px", color: "#EF4444", fontSize: 12, marginBottom: 12 }}>{teamsDirectErr}</div>
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
                      <span style={{ fontSize: 12, color: "#EF4444", flex: 1 }}>{dmError}</span>
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
                      const inits = initials(author);
                      const clean = stripHtml(msg.body?.content);
                      const time = msg.createdDateTime ? new Date(msg.createdDateTime).toLocaleString() : "";
                      return (
                        <div key={msg.id} style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 10, padding: "12px 16px" }}>
                          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                            <div style={{ width: 32, height: 32, borderRadius: "50%", background: `${TEAMS_PURPLE}33`, border: `2px solid ${TEAMS_PURPLE}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: TEAMS_PURPLE_LT, flexShrink: 0 }}>{inits}</div>
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
                      <div style={{ fontSize: 14, fontWeight: 600, color: "#94A3B8", marginBottom: 8 }}>Sign in to use Teams chat</div>
                      <button onClick={tpAuthTeams} style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "10px 22px", fontFamily: "inherit", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Sign in with Microsoft</button>
                    </div>
                  ) : !mp ? (
                    <div style={{ textAlign: "center", paddingTop: 60 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "#94A3B8", marginBottom: 6 }}>No Teams channel yet</div>
                      <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 20 }}>A channel will be created in RING OF FIRE</div>
                      <button onClick={() => selTP && tpStartChat(selTP.id, selTP.styleName || selTP.styleNumber || selTP.id)} disabled={teamsCreating === teamsSelTP}
                        style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "10px 22px", fontFamily: "inherit", fontSize: 13, fontWeight: 700, cursor: teamsCreating ? "wait" : "pointer", opacity: teamsCreating ? 0.7 : 1 }}>
                        {teamsCreating === teamsSelTP ? "Creating channel…" : "Start Teams Chat"}
                      </button>
                    </div>
                  ) : isLoadingMsgs ? (
                    <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 40, fontSize: 13 }}>Loading messages…</div>
                  ) : msgs.length === 0 ? (
                    <div style={{ textAlign: "center", color: "#6B7280", paddingTop: 40 }}><div style={{ fontSize: 13 }}>No messages yet — start the conversation!</div></div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {msgs.map((msg: any) => {
                        const author = msg.from?.user?.displayName || "Unknown";
                        const inits = initials(author);
                        const clean = stripHtml(msg.body?.content);
                        const time = msg.createdDateTime ? new Date(msg.createdDateTime).toLocaleString() : "";
                        return (
                          <div key={msg.id} style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 10, padding: "12px 16px" }}>
                            <div style={{ display: "flex", gap: 10 }}>
                              <div style={{ width: 34, height: 34, borderRadius: "50%", background: `${TEAMS_PURPLE}33`, border: `2px solid ${TEAMS_PURPLE}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: TEAMS_PURPLE_LT, flexShrink: 0 }}>{inits}</div>
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
  // Pure prefix/url/payload builders live in ./techpack/tpEmail.
  const tpEmailPrefix = tpEmailPrefixHelper;
  async function tpLoadEmails(tpId: string, olderUrl?: string) {
    const tp = techPacks.find(t => t.id === tpId);
    if (!tp) return;
    const prefix = tpEmailPrefix(tp);
    if (!olderUrl) setEmailLoadingMap(m => ({ ...m, [tpId]: true }));
    else setEmailLoadingOlder(true);
    try {
      const url = olderUrl || buildInboxSearchUrl(prefix);
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
      const d = await tpGraph(buildThreadUrl(convId));
      setEmailThreadMsgs(d.value || []);
    } catch { setEmailThreadMsgs([]); }
    setEmailThreadLoading(false);
  }
  async function tpSendEmail(tpId: string) {
    const tp = techPacks.find(t => t.id === tpId);
    if (!tp || !emailComposeTo.trim()) return;
    setEmailSendErr(null);
    try {
      await tpGraphPost("/me/sendMail", buildSendMailPayload({
        prefix: tpEmailPrefix(tp),
        subject: emailComposeSubject,
        fallback: tp.styleName || tp.styleNumber,
        bodyHtml: emailComposeBody,
        to: emailComposeTo,
      }));
      setEmailComposeTo(""); setEmailComposeSubject(""); setEmailComposeBody("");
      setEmailTabCur("inbox");
      setTimeout(() => tpLoadEmails(tpId), 2000);
    } catch(e: any) { setEmailSendErr("Failed to send: " + e.message); }
  }
  async function tpLoadEmailAttachments(messageId: string) {
    if (tpEmailAttachments[messageId] !== undefined) return;
    setTpEmailAttachmentsLoading(a => ({ ...a, [messageId]: true }));
    try {
      const d = await tpGraph(buildAttachmentsUrl(messageId));
      setTpEmailAttachments(a => ({ ...a, [messageId]: d.value || [] }));
    } catch { setTpEmailAttachments(a => ({ ...a, [messageId]: [] })); }
    setTpEmailAttachmentsLoading(a => ({ ...a, [messageId]: false }));
  }

  async function tpMarkAsRead(id: string) {
    try {
      const tok = emailToken || msToken;
      if (!tok) return;
      await fetch(buildAbsoluteMessageUrl(id), {
        method: "PATCH",
        headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
        body: JSON.stringify(buildMarkAsReadPayload()),
      });
    } catch {}
  }

  async function tpReply(messageId: string, comment: string) {
    if (!comment.trim()) return;
    setEmailSendErr(null);
    try {
      await tpGraphPost(buildReplyUrl(messageId), buildReplyPayload(comment));
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
      const d = await tpGraph(buildSentFolderSearchUrl(prefix));
      setTpSentEmails(m => ({ ...m, [tpId]: d.value || [] }));
    } catch(e) { console.error("Sent email load error", e); }
    setTpSentLoading(m => ({ ...m, [tpId]: false }));
  }
  async function tpDeleteEmail(messageId: string) {
    try {
      const tok = await (async () => { const t = await getMsAccessToken(); if (t) return t; if (msToken) return msToken; throw new Error("Not signed in"); })();
      await fetch(buildAbsoluteMessageUrl(messageId), { method: "DELETE", headers: { Authorization: "Bearer " + tok } });
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
    // EMAIL_COLORS + FolderIcon live in ./techpack/emailStyles.
    // Locally alias to keep the existing `C.xxx` usage churn-free.
    const C = EMAIL_COLORS;

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
              <input value={emailSearch} onChange={e => setEmailSearch(e.target.value)} placeholder="Search…"
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
                          {em.hasAttachments && <span style={{ marginRight: 4 }}>Attachment</span>}
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
                    <button style={{ ...iconBtn, color: C.error }} title="Delete" onClick={() => setTpDeleteConfirm(tpSelectedEmailId)}>Delete</button>
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
                    <span style={{ fontSize: 13, color: C.error, flex: 1 }}>{emailSendErr}</span>
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
                      const inits = initials(sender) || "??";
                      const time = msg.receivedDateTime ? new Date(msg.receivedDateTime).toLocaleString() : "";
                      const htmlBody = msg.body?.content || "";
                      return (
                        <div key={msg.id} style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 10, overflow: "hidden" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", cursor: !isLast ? "pointer" : "default" }}
                            onClick={() => { if (!isLast) setTpCollapsedMsgs(prev => { const s = new Set(prev); if (s.has(msg.id)) s.delete(msg.id); else s.add(msg.id); return s; }); }}>
                            <div style={{ width: 32, height: 32, borderRadius: "50%", background: C.outlook + "33", border: "2px solid " + C.outlook, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: C.outlook, flexShrink: 0 }}>{inits}</div>
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
                    <span style={{ fontSize: 11, color: C.text3, marginRight: 4 }}>Attachments:</span>
                    {tpEmailAttachments[tpSelectedEmailId].map((att: any) => {
                      const href = att.contentBytes ? `data:${att.contentType || "application/octet-stream"};base64,${att.contentBytes}` : "#";
                      return (
                        <a key={att.id} href={href} download={att.name}
                          style={{ display: "inline-flex", alignItems: "center", gap: 4, background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 9px", fontSize: 11, color: C.info, textDecoration: "none", cursor: "pointer", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {att.name}{att.size ? ` (${(att.size / 1024).toFixed(0)}KB)` : ""}
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
                      {emailSendErr}
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
                Delete
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
      {/* ── Shared left navigation drawer (de-iconed, collapsible) — GS1 pattern. ── */}
      <NavDrawer
        appKey="techpack"
        appLabel="Tech Packs"
        logoText="TP"
        moduleParam="view"
        modules={TECHPACK_MODULES}
        sections={TECHPACK_SECTIONS}
        activeModule={view === "detail" ? "list" : view}
        onSelectModule={(k) => { if (k) { setSelected(null); setView(k as View); } }}
        userEmail={null}
        userName={user.name || user.username || null}
        userPhotoUrl={user.avatar ?? null}
        onSignOut={onSignOut}
        collapsed={navCollapsed}
        onToggleCollapsed={toggleNavCollapsed}
      />

      {/* Slim top bar — anchored right of the drawer; back-to-PLM + notifications
          bell + entity switcher (mirrors the GS1 / Tangerine shell). */}
      <div style={{
        position: "fixed", top: 0, right: 0,
        left: navCollapsed ? DRAWER_W_CLOSED : DRAWER_W_OPEN,
        height: 40, zIndex: 150,
        display: "flex", alignItems: "center", justifyContent: "flex-end",
        gap: 8, padding: "0 16px",
        background: "#1E293B", color: "#fff",
        borderBottom: "1px solid #334155",
        transition: "left 0.2s ease",
      }}>
        {/* ← PLM moved into the shared NavDrawer footer (backToPlmHome). */}
        <button
          onClick={() => { setSelected(null); setView("notifications"); }}
          title="Notifications"
          style={{
            ...(view === "notifications" ? S.navBtnActive : S.navBtn),
            display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px",
          }}
        >
          Notifications
          {unreadTechpackNotifs > 0 && (
            <span style={{
              minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999,
              background: "#EF4444", color: "#fff", fontSize: 10, fontWeight: 700,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
            }}>{unreadTechpackNotifs > 9 ? "9+" : unreadTechpackNotifs}</span>
          )}
        </button>
        <EntitySwitcher inline />
      </div>

      {/* TOAST */}
      {toast && (
        <div style={{ position: "fixed", top: 70, right: 24, background: "#10B981", color: "#fff", padding: "10px 20px", borderRadius: 8, fontSize: 14, fontWeight: 600, zIndex: 999, boxShadow: "0 4px 12px rgba(0,0,0,0.3)" }}>
          {toast}
        </div>
      )}

      <main style={{
        marginLeft: navCollapsed ? DRAWER_W_CLOSED : DRAWER_W_OPEN,
        transition: "margin-left 0.2s ease",
        paddingTop: 40,
      }}>
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
                  <button style={S.btnPrimarySmall} onClick={() => { setCreateForm(createFormForUser(user)); setShowCreateModal(true); }}>+ New Tech Pack</button>
                </div>

                {/* Stat Cards */}
                <div style={S.statsRow}>
                  {renderStatCard("Total Packs", statTotal, "#3B82F6", "")}
                  {renderStatCard("Draft", statDraft, "#6B7280", "")}
                  {renderStatCard("In Review", statReview, "#F59E0B", "")}
                  {renderStatCard("Approved", statApproved, "#10B981", "")}
                </div>

                {/* Recent Tech Packs */}
                <div style={S.card}>
                  <h3 style={S.cardTitle}>Recent Tech Packs</h3>
                  {techPacks.length === 0 ? (
                    <div style={S.emptyState}>
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
                  <button style={S.btnPrimarySmall} onClick={() => { setCreateForm(createFormForUser(user)); setShowCreateModal(true); }}>+ New Tech Pack</button>
                </div>

                {/* Filters */}
                <div style={S.filters}>
                  <input style={{ ...S.input, maxWidth: 260 }} placeholder="Search style name, number, brand..." value={search} onChange={e => setSearch(e.target.value)} />
                  <SearchableSelect
                    value={filterStatus || null}
                    onChange={v => setFilterStatus(v)}
                    options={[{ value: "", label: "All Statuses" }, ...STATUSES.map(s => ({ value: s, label: s }))]}
                    placeholder="All Statuses"
                    inputStyle={S.select}
                  />
                  <SearchableSelect
                    value={filterBrand || null}
                    onChange={v => setFilterBrand(v)}
                    options={[{ value: "", label: "All Brands" }, ...brands.map(b => ({ value: b, label: b }))]}
                    placeholder="All Brands"
                    inputStyle={S.select}
                  />
                  <SearchableSelect
                    value={filterSeason || null}
                    onChange={v => setFilterSeason(v)}
                    options={[{ value: "", label: "All Seasons" }, ...seasons.map(s => ({ value: s, label: s }))]}
                    placeholder="All Seasons"
                    inputStyle={S.select}
                  />
                  <span style={{ color: "#6B7280", fontSize: 13 }}>{filtered.length} packs</span>
                </div>

                {/* Grid of cards */}
                {filtered.length === 0 ? (
                  <div style={S.emptyState}>
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

            {/* ═══════════ NOTIFICATIONS ═══════════ */}
            {view === "notifications" && supabaseClient && (user as any)?.id && (
              <NotificationsPage
                embed
                kind="internal"
                supabase={supabaseClient}
                userId={(user as any).id}
                title="Notifications"
                appFilter="techpack"
              />
            )}
          </>
        )}
      </div>
      </main>

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

      {supabaseClient && (user as any)?.id && (
        <NotificationsShell
          kind="internal"
          supabase={supabaseClient}
          userId={(user as any).id}
          notificationsUrl="/notifications?from=techpack"
          currentPath={typeof window !== "undefined" ? window.location.pathname : undefined}
          isViewingNotifications={view === "notifications"}
          sessionKey="rof_notif_dismissed_internal"
          autoOpen={false}
          appFilter="techpack"
        />
      )}
      {/* Cross-cutter T6-3 — ⌘K / Ctrl-K global search palette. */}
      <GlobalSearchPaletteAuto />
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
  const renderMaterialsView = () => (
    <MaterialsView
      materials={materials}
      matSearch={matSearch}
      setMatSearch={setMatSearch}
      matTypeFilter={matTypeFilter}
      setMatTypeFilter={setMatTypeFilter}
      setEditingMaterial={setEditingMaterial}
      setMatForm={setMatForm}
      setShowMaterialModal={setShowMaterialModal}
      setConfirmDialog={setConfirmDialog}
      saveMaterials={saveMaterials}
      downloadMaterialsExcel={downloadMaterialsExcel}
    />
  );

  // ── Excel helpers — implementations live in ./techpack/xlsx; these
  //    thin wrappers bind showToast so the call sites stay unchanged.
  const buildSpecSheetWb        = (sheet: SpecSheet, isTemplate: boolean) => tpBuildSpecSheetWb(sheet, isTemplate, showToast);
  const xlsxDownload            = (wb: any, filename: string)             => tpXlsxDownload(wb, filename, showToast);
  const downloadSpecSheetExcel  = (sheet: SpecSheet)                      => tpDownloadSpecSheetExcel(sheet, showToast);
  const downloadSpecSheetTemplate = (sizes: string[])                     => tpDownloadSpecSheetTemplate(sizes, showToast);
  const downloadMaterialsExcel  = (mats: Material[])                      => tpDownloadMaterialsExcel(mats, showToast);
  const parseSpecSheetExcel     = (file: File)                            => tpParseSpecSheetExcel(file);

  // ── Libraries View ────────────────────────────────────────────────────────
  const renderLibrariesView = () => (
    <LibrariesView
      libTab={libTab}
      setLibTab={setLibTab}
      materialsView={renderMaterialsView()}
      specSheetsView={renderSpecSheetsView()}
    />
  );

  // ── Spec Sheets View ──────────────────────────────────────────────────────
  const handleSpecSheetImport = async (file: File) => {
    try {
      showToast("Parsing file...");
      const XLSX = (window as any).XLSX;
      if (!XLSX) { showToast("Excel library loading — try again"); return; }
      const reader = new FileReader();
      reader.onload = (ev: any) => {
        try {
          const wb = XLSX.read(ev.target?.result, { type: "binary" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
          const hdr = detectSpecSheetHeader(aoa);
          if (!hdr) { showToast("Could not find spec sheet header row"); return; }
          const { headerRowIdx, sizes, newFmt } = hdr;
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
          const styleInfo = extractStyleInfoFromAoa(aoa);
          const newSheet: SpecSheet = {
            id: uid(),
            styleName:   styleInfo.styleName || file.name.replace(/\.[^.]+$/, ""),
            styleNumber: styleInfo.styleNumber,
            brand:       styleInfo.brand,
            season:      styleInfo.season,
            category: "", description: "", sizes, rows,
            createdAt: today(), updatedAt: today(),
          };
          saveSpecSheets([...specSheets, newSheet]);
          setSelectedSpecSheet(newSheet);
          showToast(`Imported ${rows.length} measurements`);
        } catch (err) { showToast("Parse failed — check file format"); console.error(err); }
      };
      reader.readAsBinaryString(file);
    } catch (err) { showToast("Import failed"); console.error(err); }
  };
  const renderSpecSheetsView = () => (
    <SpecSheetsView
      specSheets={specSheets}
      ssSearch={ssSearch}
      setSsSearch={setSsSearch}
      setShowTemplatesModal={setShowTemplatesModal}
      setSsForm={setSsForm}
      setEditingSpecSheet={setEditingSpecSheet}
      setShowSpecSheetModal={setShowSpecSheetModal}
      setSelectedSpecSheet={setSelectedSpecSheet}
      downloadSpecSheetExcel={downloadSpecSheetExcel}
      saveSpecSheets={saveSpecSheets}
      setConfirmDialog={setConfirmDialog}
      onImportFile={handleSpecSheetImport}
    />
  );

  // ── Spec Sheet Detail Panel ───────────────────────────────────────────────
  const renderSpecSheetDetail = () => selectedSpecSheet ? (
    <SpecSheetDetail
      ss={selectedSpecSheet}
      onSave={(updated) => {
        setSelectedSpecSheet(updated);
        saveSpecSheets(specSheets.map(x => x.id === updated.id ? updated : x));
      }}
      onClose={() => setSelectedSpecSheet(null)}
      dcBrands={dcBrands}
      dcSeasons={dcSeasons}
      dcCategories={dcCategories}
      dcGenders={dcGenders}
      dcVendors={dcVendors}
      downloadSpecSheetExcel={downloadSpecSheetExcel}
      parseSpecSheetExcel={parseSpecSheetExcel}
      showToast={showToast}
    />
  ) : null;

  // ── Spec Sheet Create Modal ───────────────────────────────────────────────

  // ── Templates Modal ───────────────────────────────────────────────────────

  // ── Samples Overview ──────────────────────────────────────────────────────
  const renderSamplesOverview = () => <SamplesOverview allSamples={allSamples} />;

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
              <SearchableSelect
                value={tp.status}
                onChange={v => updateSelected({ status: v as TechPack["status"] })}
                options={STATUSES.map(s => ({ value: s, label: s }))}
                inputStyle={{ ...S.select, fontSize: 12 }}
              />
              <button style={{ ...S.iconBtn, color: "#EF4444", fontSize: 14 }} onClick={() => setConfirmDialog({ title: "Delete Tech Pack", message: `Delete "${tp.styleName || tp.styleNumber}"? All specs, BOM, samples, and approvals will be permanently removed.`, onConfirm: () => deleteTechPack(tp.id) })}>Delete</button>
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
            {(() => {
              // Costing tab is gated by the per-user permission set in
              // PLM.tsx (permissions.costing.access). Default-true when the
              // session blob has no costing permission (matches the
              // pre-existing behavior for users that pre-date this gate).
              // Admins always see it.
              const allTabs: [DetailTab, string][] = [["sketch", "Sketch"], ["spec", "Spec Sheet"], ["construction", "Construction"], ["bom", "BOM"], ["costing", "Costing"], ["approvals", "Approvals"], ["samples", "Samples"], ["images", "Images"]];
              return allTabs.filter(([key]) => key !== "costing" || canSeeCostingTab());
            })().map(([key, label]) => (
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
            {detailTab === "costing" && canSeeCostingTab() && renderCostingTab(tp)}
            {detailTab === "approvals" && renderApprovalsTab(tp)}
            {detailTab === "samples" && renderSamplesTab(tp)}
            {detailTab === "images" && renderImagesTab(tp)}
          </div>
        </div>
      </div>
    );
  }


  // ── Tab aliases — all 6 extracted tabs live in ./techpack/tabs/.
  //    Local aliases keep the renderDetailPanel call sites unchanged.
  const renderSketchTab       = (tp: TechPack) => <SketchTab       tp={tp} updateSelected={updateSelected} uploadImage={uploadImage} setLightboxImg={setLightboxImg} showToast={showToast} />;
  const renderSpecTab         = (tp: TechPack) => <SpecTab         tp={tp} updateSelected={updateSelected} showAddSize={showAddSize} setShowAddSize={setShowAddSize} newSize={newSize} setNewSize={setNewSize} />;
  const renderConstructionTab = (tp: TechPack) => <ConstructionTab tp={tp} updateSelected={updateSelected} uploadImage={uploadImage} setLightboxImg={setLightboxImg} />;
  const renderBOMTab          = (tp: TechPack) => <BOMTab          tp={tp} updateSelected={updateSelected} uploadImage={uploadImage} setLightboxImg={setLightboxImg} showToast={showToast} materials={materials} setConfirmDialog={setConfirmDialog} />;
  const renderCostingTab      = (tp: TechPack) => <CostingTab      tp={tp} updateSelected={updateSelected} />;
  const renderApprovalsTab    = (tp: TechPack) => <ApprovalsTab    tp={tp} updateSelected={updateSelected} />;
  const renderSamplesTab      = (tp: TechPack) => <SamplesTab      tp={tp} updateSelected={updateSelected} uploadImage={uploadImage} setLightboxImg={setLightboxImg} showToast={showToast} />;
  const renderImagesTab       = (tp: TechPack) => <ImagesTab       tp={tp} updateSelected={updateSelected} uploadImage={uploadImage} setLightboxImg={setLightboxImg} />;

  // ── Modal aliases — all 4 modals now live in ./techpack/modals/.
  //    Local handlers (addBrand, addSeason, create-spec-sheet,
  //    template up/download/delete) stay in the parent because they
  //    close over dcSave + setters that don't make sense to push
  //    down to a presentational modal.
  const handleAddBrand = async () => {
    const name = prompt("New brand name:");
    if (!name?.trim()) return;
    const nb = { id: Math.random().toString(36).slice(2), name: name.trim(), short: name.trim().slice(0, 5).toUpperCase(), color: "#3498DB", isPrivateLabel: false };
    const updated = [...dcBrands, nb];
    setDcBrands(updated);
    await dcSave("brands", updated);
    setCreateForm(f => ({ ...f, brand: nb.name }));
    showToast(`Brand "${nb.name}" added`);
  };
  const handleAddSeason = async () => {
    const name = prompt("New season name (e.g. Fall 2026):");
    if (!name?.trim()) return;
    const updated = [...dcSeasons, name.trim()];
    setDcSeasons(updated);
    await dcSave("seasons", updated);
    setCreateForm(f => ({ ...f, season: name.trim() }));
    showToast(`Season "${name.trim()}" added`);
  };
  const handleCreateSpecSheet = (): SpecSheet => {
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
      styleName:   ssForm.styleName,
      styleNumber: ssForm.styleNumber,
      brand:       ssForm.brand,
      season:      ssForm.season,
      category:    ssForm.category,
      subCategory: ssForm.subCategory,
      gender:      ssForm.gender,
      vendor:      ssForm.vendor,
      description: ssForm.description,
      sizes,
      rows,
      createdAt: today(),
      updatedAt: today(),
    };
    saveSpecSheets([...specSheets, newSS]);
    setShowSpecSheetModal(false);
    setActiveTemplate(null);
    setSsForm(EMPTY_SPEC_SHEET_FORM);
    setSelectedSpecSheet(newSS);
    return newSS;
  };
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
          const hdr = detectSpecSheetHeader(aoa);
          if (!hdr) { showToast("Could not find spec sheet header row"); return; }
          const { headerRowIdx, sizes, newFmt } = hdr;
          const rows: SpecSheetRow[] = [];
          for (let i = headerRowIdx + 1; i < aoa.length; i++) {
            const row = aoa[i];
            const desc = newFmt ? String(row[1] || "").trim() : String(row[0] || "").trim();
            if (!desc) continue;
            const tol = newFmt ? String(row[5] || "").trim() : String(row[1] || "").trim();
            const values: Record<string, string> = {};
            sizes.forEach(s => { values[s] = ""; });
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
  const renderCreateModal     = () => <CreateModal      createForm={createForm} setCreateForm={setCreateForm} dcBrands={dcBrands} dcSeasons={dcSeasons} dcGenders={dcGenders} dcVendors={dcVendors} dcCategories={dcCategories} dcTeam={dcTeam} onAddBrand={handleAddBrand} onAddSeason={handleAddSeason} onClose={() => setShowCreateModal(false)} onCreate={handleCreate} />;
  const renderMaterialModal   = () => <MaterialModal    matForm={matForm} setMatForm={setMatForm} editingMaterial={editingMaterial} onClose={() => { setShowMaterialModal(false); setEditingMaterial(null); }} onSave={handleSaveMaterial} />;
  const renderSpecSheetModal  = () => <SpecSheetModal   ssForm={ssForm} setSsForm={setSsForm} activeTemplate={activeTemplate} setActiveTemplate={setActiveTemplate} dcBrands={dcBrands} dcSeasons={dcSeasons} dcCategories={dcCategories} dcGenders={dcGenders} dcVendors={dcVendors} onClose={() => setShowSpecSheetModal(false)} onCreate={handleCreateSpecSheet} />;
  const renderTemplatesModal  = () => <TemplatesModal   allTemplates={[...BUILTIN_TEMPLATES, ...specTemplates]} onClose={() => setShowTemplatesModal(false)} onUse={handleUseTemplate} onDownload={handleDownloadTemplate} onUpload={handleUploadTemplate} onDelete={(t) => setConfirmDialog({ title: "Delete Template", message: `Delete "${t.name}"? This cannot be undone.`, onConfirm: () => saveSpecTemplates(specTemplates.filter(x => x.id !== t.id)) })} />;
  // ── Create Modal ──────────────────────────────────────────────────────────

  // ── Material Modal ────────────────────────────────────────────────────────
}
