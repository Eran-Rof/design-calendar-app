import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { msSignIn, loadMsTokens, saveMsTokens, clearMsTokens, getMsAccessToken, MS_CLIENT_ID, MS_TENANT_ID } from "./utils/msAuth";
import { useMSAuth, friendlyContactError } from "./tanda/hooks/useMSAuth";
import { useDashboardData } from "./tanda/hooks/useDashboardData";
import { useEmailOps } from "./tanda/hooks/useEmailOps";
import { useTeamsOps } from "./tanda/hooks/useTeamsOps";
import { useMilestoneOps } from "./tanda/hooks/useMilestoneOps";
import { useSyncOps, fetchXoroPOs } from "./tanda/hooks/useSyncOps";
import { useTemplateOps } from "./tanda/hooks/useTemplateOps";
import { useNotesOps } from "./tanda/hooks/useNotesOps";
import { useArchiveOps } from "./tanda/hooks/useArchiveOps";
import { useEmailData } from "./tanda/hooks/useEmailData";
import { DashboardView } from "./tanda/views/DashboardView";
import { ListView } from "./tanda/views/ListView";
import { GridView } from "./tanda/views/GridView";
import { TemplatesView } from "./tanda/views/TemplatesView";
import { ActivityView } from "./tanda/views/ActivityView";
import { VendorsView } from "./tanda/views/VendorsView";
import { ArchiveView } from "./tanda/views/ArchiveView";
import ShipmentsView from "./tanda/ShipmentsView";
import MatchView from "./tanda/MatchView";
import ComplianceReview from "./tanda/ComplianceReview";
import MessagesView from "./tanda/MessagesView";
import VendorLeaderboard from "./tanda/VendorLeaderboard";
import SpendReport from "./tanda/SpendReport";
import InternalOnboarding from "./tanda/InternalOnboarding";
import InternalAnomalies from "./tanda/InternalAnomalies";
import InternalAnalytics from "./tanda/InternalAnalytics";
import InternalHealthScores from "./tanda/InternalHealthScores";
import InternalPreferred from "./tanda/InternalPreferred";
import InternalRfqs from "./tanda/InternalRfqs";
import InternalWorkflowRules from "./tanda/InternalWorkflowRules";
import InternalWorkflowExecutions from "./tanda/InternalWorkflowExecutions";
import InternalEntities from "./tanda/InternalEntities";
import InternalInsights from "./tanda/InternalInsights";
import InternalWorkspaces from "./tanda/InternalWorkspaces";
import InternalSustainability from "./tanda/InternalSustainability";
import InternalEsgScores from "./tanda/InternalEsgScores";
import InternalDiversity from "./tanda/InternalDiversity";
import InternalComplianceAutomation from "./tanda/InternalComplianceAutomation";
import InternalComplianceAudit from "./tanda/InternalComplianceAudit";
import InternalMarketplace from "./tanda/InternalMarketplace";
import InternalMarketplaceInquiries from "./tanda/InternalMarketplaceInquiries";
import InternalBenchmark from "./tanda/InternalBenchmark";
import InternalDiscountOffers from "./tanda/InternalDiscountOffers";
import InternalPayments from "./tanda/InternalPayments";
import InternalScf from "./tanda/InternalScf";
import InternalFx from "./tanda/InternalFx";
import InternalVirtualCards from "./tanda/InternalVirtualCards";
import InternalTax from "./tanda/InternalTax";
import { SyncModals } from "./tanda/views/SyncModal";
import { SettingsModal } from "./tanda/views/SettingsModal";

import { SB_URL, SB_KEY, SB_HEADERS, supabaseClient } from "./utils/supabase";
import NotificationsShell from "./components/notifications/NotificationsShell";
import NotificationsPage from "./components/notifications/NotificationsPage";
import { useAppUnreadCount } from "./components/notifications/useAppUnreadCount";
import { type XoroPO, type Milestone, type WipTemplate, type LocalNote, type User, type DCVendor, type DmConversation, type SyncFilters, type View, ALL_PO_STATUSES, ACTIVE_PO_STATUSES, STATUS_COLORS, STATUS_OPTIONS, WIP_CATEGORIES, MILESTONE_STATUSES, MILESTONE_STATUS_COLORS, DEFAULT_WIP_TEMPLATES, milestoneUid, itemQty, poTotal, normalizeSize, sizeSort, mapXoroRaw, fmtDate, fmtCurrency } from "./utils/tandaTypes";
import S from "./tanda/styles";
// generateMilestones and mergeMilestones moved to useMilestoneOps
import { exportPOExcel } from "./tanda/exportHelpers";
import { emailViewPanel as emailViewPanelExtracted, type EmailPanelCtx } from "./tanda/emailPanel";
import { buildEmailHtml } from "./tanda/richTextEditor";
import { teamsViewPanel as teamsViewPanelExtracted, type TeamsPanelCtx } from "./tanda/teamsPanel";
import { timelinePanel as timelinePanelExtracted, type TimelinePanelCtx } from "./tanda/timelinePanel";
import { detailPanel as detailPanelExtracted, WipTemplateEditor } from "./tanda/detailPanel";
import type { SyncLogEntry } from "./tanda/state/sync/syncTypes";
import type { EmailState } from "./tanda/state/email/emailTypes";
import type { TeamsState } from "./tanda/state/teams/teamsTypes";
import type { CoreState } from "./tanda/state/core/coreTypes";
import { useTandaStore } from "./tanda/store/index";

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
async function fetchXoroVendors(): Promise<string[]> {
  try {
    // Pass an explicit status — Xoro's endpoint returns 0 records when the
    // status param is omitted. Open is fine for a vendor-name dropdown
    // since active vendors all have at least one Open PO.
    const { pos } = await fetchXoroPOs({ page: 1, statuses: ["Open"] });
    return [...new Set(pos.map(p => p.VendorName ?? "").filter(Boolean))].sort();
  } catch { return []; }
}

function daysUntil(d?: string) {
  if (!d) return null;
  return Math.ceil((new Date(d).getTime() - Date.now()) / 86400000);
}

// ── Vendors nav dropdown ─────────────────────────────────────────────────────
type MenuItem = { view: View; label: string; emoji: string };
const VENDOR_MENU_GROUPS: { group: string; items: MenuItem[] }[] = [
  { group: "Vendors", items: [
    { view: "vendors",            label: "Directory",       emoji: "🏢" },
    { view: "onboarding",         label: "Onboarding",      emoji: "🚀" },
    { view: "preferred_vendors",  label: "Preferred",       emoji: "⭐" },
    { view: "scorecards",         label: "Scorecards",      emoji: "🏆" },
    { view: "health_scores",      label: "Health Scores",   emoji: "❤️" },
    { view: "diversity",          label: "Diversity",       emoji: "🤝" },
    { view: "sustainability",     label: "Sustainability",  emoji: "🌱" },
    { view: "esg_scores",         label: "ESG Scores",      emoji: "🌍" },
  ]},
  { group: "Operations", items: [
    { view: "shipments",          label: "Shipments",       emoji: "🚢" },
    { view: "match",              label: "3-Way Match",     emoji: "🔍" },
    { view: "messages",           label: "Messages",        emoji: "💬" },
    { view: "phase_reviews",      label: "Phase reviews",   emoji: "🧭" },
    { view: "anomalies",          label: "Anomalies",       emoji: "🚨" },
    { view: "workspaces",         label: "Workspaces",      emoji: "🗂️" },
  ]},
  { group: "Compliance", items: [
    { view: "compliance",         label: "Documents",       emoji: "📋" },
    { view: "compliance_automation", label: "Automation",   emoji: "🤖" },
    { view: "compliance_audit",   label: "Audit trail",     emoji: "📜" },
  ]},
  { group: "Sourcing", items: [
    { view: "rfqs",               label: "RFQs",            emoji: "📨" },
    { view: "marketplace",        label: "Marketplace",     emoji: "🛍️" },
    { view: "marketplace_inquiries", label: "Inquiries",    emoji: "💬" },
    { view: "benchmark",          label: "Benchmark",       emoji: "📈" },
    { view: "insights",           label: "Insights",        emoji: "💡" },
  ]},
  { group: "Finance", items: [
    { view: "payments",           label: "Payments",        emoji: "💸" },
    { view: "discount_offers",    label: "Discount offers", emoji: "⚡" },
    { view: "scf",                label: "SCF",             emoji: "🏦" },
    { view: "virtual_cards",      label: "Virtual cards",   emoji: "💳" },
    { view: "fx",                 label: "FX",              emoji: "🌐" },
    { view: "tax",                label: "Tax",             emoji: "🧾" },
  ]},
  { group: "Analytics & Admin", items: [
    { view: "analytics",          label: "Analytics",       emoji: "📊" },
    { view: "spend",              label: "Spend",           emoji: "💰" },
    { view: "workflow_rules",     label: "Workflow Rules",  emoji: "⚙️" },
    { view: "workflow_executions",label: "Approvals",       emoji: "✅" },
    { view: "entities",           label: "Entities",        emoji: "🏛️" },
  ]},
];
const VENDOR_MENU: MenuItem[] = VENDOR_MENU_GROUPS.flatMap((g) => g.items);

function VendorsFlyout({ view, onSelect }: { view: View; onSelect: (v: View) => void }) {
  const currentGroup = VENDOR_MENU_GROUPS.find((g) => g.items.some((i) => i.view === view))?.group;
  const [hovered, setHovered] = useState<string | null>(currentGroup || VENDOR_MENU_GROUPS[0].group);
  const active = VENDOR_MENU_GROUPS.find((g) => g.group === hovered) || VENDOR_MENU_GROUPS[0];

  return (
    <div
      role="menu"
      style={{
        position: "absolute", top: "100%", left: 0, paddingTop: 4,
        display: "flex", gap: 4,
        zIndex: 100,
      }}
    >
      <div style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 8, padding: 4, minWidth: 200, boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
        {VENDOR_MENU_GROUPS.map((g) => {
          const isActive = g.group === hovered;
          const hasSelected = g.items.some((i) => i.view === view);
          return (
            <button
              key={g.group}
              onMouseEnter={() => setHovered(g.group)}
              onFocus={() => setHovered(g.group)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
                background: isActive ? "#334155" : "transparent",
                border: "none", color: hasSelected ? "#60A5FA" : "#F1F5F9",
                borderRadius: 6, padding: "9px 10px", fontSize: 13, cursor: "default",
                textAlign: "left", fontFamily: "inherit", fontWeight: hasSelected ? 700 : 500,
              }}
            >
              <span>{g.group}</span>
              <span style={{ fontSize: 10, opacity: 0.6 }}>▸</span>
            </button>
          );
        })}
      </div>
      <div style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 8, padding: 4, minWidth: 220, boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
        <div style={{ padding: "6px 10px 4px", fontSize: 10, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.8 }}>{active.group}</div>
        {active.items.map((m) => (
          <button
            key={m.view}
            role="menuitem"
            onClick={() => onSelect(m.view)}
            style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%",
              background: m.view === view ? "#3B82F620" : "transparent",
              border: "none", color: m.view === view ? "#60A5FA" : "#CBD5E1",
              borderRadius: 6, padding: "8px 10px", fontSize: 13, cursor: "pointer",
              textAlign: "left", fontFamily: "inherit",
            }}
            onMouseEnter={(e) => { if (m.view !== view) (e.currentTarget as HTMLButtonElement).style.background = "#334155"; }}
            onMouseLeave={(e) => { if (m.view !== view) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
          >
            <span style={{ width: 18, textAlign: "center" }}>{m.emoji}</span>
            <span>{m.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function VendorsMenu({ view, onSelect }: { view: View; onSelect: (v: View) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", click); document.removeEventListener("keydown", esc); };
  }, [open]);
  useEffect(() => () => { if (leaveTimer.current) clearTimeout(leaveTimer.current); }, []);

  const active = VENDOR_MENU.some((m) => m.view === view);
  const current = VENDOR_MENU.find((m) => m.view === view);
  const label = current ? `${current.emoji} ${current.label}` : "🏢 Vendors";

  return (
    <div
      ref={ref}
      style={{ position: "relative" }}
      onMouseEnter={() => { if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; } }}
      onMouseLeave={() => { leaveTimer.current = setTimeout(() => setOpen(false), 200); }}
    >
      <button
        style={active ? S.navBtnActive : S.navBtn}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {label} <span style={{ fontSize: 10, marginLeft: 4, opacity: 0.8 }}>▾</span>
      </button>
      {open && (
        <VendorsFlyout
          view={view}
          onSelect={(v) => { setOpen(false); onSelect(v); }}
        />
      )}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function TandAAppWrapper() {
  return <TandAApp />;
}

function TandAApp() {
  const [, rerender] = useState(0);
  const rafRef = useRef(0);
  useEffect(() => {
    const unsub = useTandaStore.subscribe(() => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => rerender(c => c + 1));
    });
    return () => { unsub(); cancelAnimationFrame(rafRef.current); };
  }, []);
  const store = useTandaStore.getState();
  const core = store;
  const sync = store;
  const em = store;
  const tm = store;
  const coreSet = store.setCoreField;
  const emSet = store.setEmailField;
  const tmSet = store.setTeamsField;
  // ── Core PO state (from useTandaStore) ──
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
  const setPos = (v: any) => { if (typeof v === "function") coreSet("pos", v(useTandaStore.getState().pos)); else coreSet("pos", v); };
  const setNotes = (v: any) => { if (typeof v === "function") coreSet("notes", v(useTandaStore.getState().notes)); else coreSet("notes", v); };
  const setSelected = (v: XoroPO | null) => coreSet("selected", v);
  const setDetailMode = (v: "header" | "po" | "milestones" | "notes" | "history" | "matrix" | "email" | "attachments" | "all") => coreSet("detailMode", v);
  const setAttachments = (v: any) => { if (typeof v === "function") coreSet("attachments", v(useTandaStore.getState().attachments)); else coreSet("attachments", v); };
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
  // ── Sync state (from useTandaStore) ──
  const loading = sync.loading;
  const syncing = sync.syncing;
  const syncErr = sync.syncErr;
  const lastSync = sync.lastSync;
  const showSyncModal = sync.showSyncModal;
  const setLoading = (v: boolean) => store.setSyncField("loading", v);
  const setSyncing = (v: boolean) => store.setSyncField("syncing", v);
  const setSyncErr = (v: string) => store.setSyncField("syncErr", v);
  const setLastSync = (v: string) => store.setSyncField("lastSync", v);
  const setShowSyncModal = (v: boolean) => store.setSyncField("showSyncModal", v);
  const [search, setSearch]     = useState("");
  const [filterStatus, setFilterStatus] = useState("All");
  const [filterVendor, setFilterVendor] = useState("All");
  const [sortBy, setSortBy] = useState<"ddp" | "po_date" | "status">("ddp");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [showSettings, setShowSettings] = useState(false);
  const [newNote, setNewNote]   = useState("");
  // generatingRef and conflictPendingRef moved to useMilestoneOps

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
  const setSyncFilters = (v: any) => { if (typeof v === "function") store.setSyncField("syncFilters", v(useTandaStore.getState().syncFilters)); else store.setSyncField("syncFilters", v); };
  const setSyncProgress = (v: number) => store.setSyncField("syncProgress", v);
  const setSyncProgressMsg = (v: string) => store.setSyncField("syncProgressMsg", v);
  const setSyncDone = (v: { added: number; changed: number; deleted: number } | null) => store.setSyncField("syncDone", v);
  const setSyncLog = (v: SyncLogEntry[]) => store.setSyncField("syncLog", v);
  const setShowSyncLog = (v: boolean) => store.setSyncField("showSyncLog", v);
  const setPoSearch = (v: string) => store.setSyncField("poSearch", v);
  const setPoDropdownOpen = (v: boolean) => store.setSyncField("poDropdownOpen", v);
  const setXoroVendors = (v: string[]) => store.setSyncField("xoroVendors", v);
  const setManualVendors = (v: string[]) => store.setSyncField("manualVendors", v);
  const setVendorSearch = (v: string) => store.setSyncField("vendorSearch", v);
  const setLoadingVendors = (v: boolean) => store.setSyncField("loadingVendors", v);
  const setNewManualVendor = (v: string) => store.setSyncField("newManualVendor", v);

  // ── WIP Milestone state → core reducer ──
  const wipTemplates = core.wipTemplates;
  const milestones = core.milestones;
  const dcVendors = core.dcVendors;
  const designTemplates = core.designTemplates;
  const setWipTemplates = (v: any) => { if (typeof v === "function") coreSet("wipTemplates", v(useTandaStore.getState().wipTemplates)); else coreSet("wipTemplates", v); };
  const setMilestones = (v: any) => { if (typeof v === "function") coreSet("milestones", v(useTandaStore.getState().milestones)); else coreSet("milestones", v); };
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
  const [tplMovedIds, setTplMovedIds] = useState<Set<string>>(new Set());

  // ── Outlook Email state (from useTandaStore) ──
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
  const setEmailsMap = (v: any) => { if (typeof v === "function") emSet("emailsMap", v(useTandaStore.getState().emailsMap)); else emSet("emailsMap", v); };
  const setEmailLoadingMap = (v: any) => { if (typeof v === "function") emSet("emailLoadingMap", v(useTandaStore.getState().emailLoadingMap)); else emSet("emailLoadingMap", v); };
  const setEmailErrorsMap = (v: any) => { if (typeof v === "function") emSet("emailErrorsMap", v(useTandaStore.getState().emailErrorsMap)); else emSet("emailErrorsMap", v); };
  const setEmailSelMsg = (v: any) => emSet("emailSelMsg", v);
  const setEmailThreadMsgs = (v: any) => emSet("emailThreadMsgs", v);
  const setEmailThreadLoading = (v: boolean) => emSet("emailThreadLoading", v);
  const setEmailTabCur = (v: "inbox" | "sent" | "thread" | "compose") => emSet("emailTabCur", v);
  const setEmailSentMap = (v: any) => { if (typeof v === "function") emSet("emailSentMap", v(useTandaStore.getState().emailSentMap)); else emSet("emailSentMap", v); };
  const setEmailSentLoading = (v: any) => { if (typeof v === "function") emSet("emailSentLoading", v(useTandaStore.getState().emailSentLoading)); else emSet("emailSentLoading", v); };
  const setEmailSentErrMap = (v: any) => { if (typeof v === "function") emSet("emailSentErr", v(useTandaStore.getState().emailSentErr)); else emSet("emailSentErr", v); };
  const setEmailComposeTo = (v: string) => emSet("emailComposeTo", v);
  const setEmailComposeSubject = (v: string) => emSet("emailComposeSubject", v);
  const setEmailComposeBody = (v: string) => emSet("emailComposeBody", v);
  const setEmailSendErr = (v: string | null) => emSet("emailSendErr", v);
  const setEmailNextLinks = (v: any) => { if (typeof v === "function") emSet("emailNextLinks", v(useTandaStore.getState().emailNextLinks)); else emSet("emailNextLinks", v); };
  const setEmailLoadingOlder = (v: boolean) => emSet("emailLoadingOlder", v);
  const setEmailLastRefresh = (v: any) => { if (typeof v === "function") emSet("emailLastRefresh", v(useTandaStore.getState().emailLastRefresh)); else emSet("emailLastRefresh", v); };
  const setEmailReply = (v: string) => emSet("emailReply", v);
  const setEmailConfigForm = (v: any) => emSet("emailConfigForm", v);
  const setEmailPOSearch = (v: string) => emSet("emailPOSearch", v);
  // ── Teams state (from useTandaStore) ──
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
  const setTeamsMessages = (v: any) => { if (typeof v === "function") tmSet("teamsMessages", v(useTandaStore.getState().teamsMessages)); else tmSet("teamsMessages", v); };
  const setTeamsLoading = (v: any) => { if (typeof v === "function") tmSet("teamsLoading", v(useTandaStore.getState().teamsLoading)); else tmSet("teamsLoading", v); };
  const setTeamsCreating = (v: string | null) => tmSet("teamsCreating", v);
  const setTeamsNewMsg = (v: string) => tmSet("teamsNewMsg", v);
  const setTeamsAuthStatus = (v: "idle" | "loading" | "error") => tmSet("teamsAuthStatus", v);
  const setTeamsSearchPO = (v: string) => tmSet("teamsSearchPO", v);
  const setTeamsDirectTo = (v: string) => tmSet("teamsDirectTo", v);
  const setTeamsDirectMsg = (v: string) => tmSet("teamsDirectMsg", v);
  const setTeamsDirectSending = (v: boolean) => tmSet("teamsDirectSending", v);
  const setTeamsDirectErr = (v: string | null) => tmSet("teamsDirectErr", v);
  const setTeamsTab = (v: "channels" | "direct") => tmSet("teamsTab", v);
  const setDmConversations = (v: any) => { if (typeof v === "function") tmSet("dmConversations", v(useTandaStore.getState().dmConversations)); else tmSet("dmConversations", v); };
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
  const setEmailAllMessages = (v: any) => { if (typeof v === "function") emSet("emailAllMessages" as any, v((useTandaStore.getState() as any).emailAllMessages)); else emSet("emailAllMessages" as any, v); };
  const setEmailDeletedMessages = (v: any) => { if (typeof v === "function") emSet("emailDeletedMessages" as any, v((useTandaStore.getState() as any).emailDeletedMessages)); else emSet("emailDeletedMessages" as any, v); };
  const setDtlEmails = (v: any) => { if (typeof v === "function") emSet("dtlEmails", v(useTandaStore.getState().dtlEmails)); else emSet("dtlEmails", v); };
  const setDtlEmailLoading = (v: any) => { if (typeof v === "function") emSet("dtlEmailLoading", v(useTandaStore.getState().dtlEmailLoading)); else emSet("dtlEmailLoading", v); };
  const setDtlEmailErr = (v: any) => { if (typeof v === "function") emSet("dtlEmailErr", v(useTandaStore.getState().dtlEmailErr)); else emSet("dtlEmailErr", v); };
  const setDtlEmailSel = (v: any) => emSet("dtlEmailSel", v);
  const setDtlEmailThread = (v: any) => emSet("dtlEmailThread", v);
  const setDtlThreadLoading = (v: boolean) => emSet("dtlThreadLoading", v);
  const setDtlEmailTab = (v: "inbox" | "sent" | "thread" | "compose" | "teams") => emSet("dtlEmailTab", v);
  const setDtlSentEmails = (v: any) => { if (typeof v === "function") emSet("dtlSentEmails", v(useTandaStore.getState().dtlSentEmails)); else emSet("dtlSentEmails", v); };
  const setDtlSentLoading = (v: any) => { if (typeof v === "function") emSet("dtlSentLoading", v(useTandaStore.getState().dtlSentLoading)); else emSet("dtlSentLoading", v); };
  const setDtlComposeTo = (v: string) => emSet("dtlComposeTo", v);
  const setDtlComposeSubject = (v: string) => emSet("dtlComposeSubject", v);
  const setDtlComposeBody = (v: string) => emSet("dtlComposeBody", v);
  const setDtlSendErr = (v: string | null) => emSet("dtlSendErr", v);
  const setDtlReply = (v: string) => emSet("dtlReply", v);
  const setDtlNextLink = (v: any) => { if (typeof v === "function") emSet("dtlNextLink", v(useTandaStore.getState().dtlNextLink)); else emSet("dtlNextLink", v); };
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
  const setEmailAttachments = (v: any) => { if (typeof v === "function") emSet("emailAttachments", v(useTandaStore.getState().emailAttachments)); else emSet("emailAttachments", v); };
  const setEmailAttachmentsLoading = (v: any) => { if (typeof v === "function") emSet("emailAttachmentsLoading", v(useTandaStore.getState().emailAttachmentsLoading)); else emSet("emailAttachmentsLoading", v); };

  // ── Microsoft auth — shared token for Email + Teams (see tanda/hooks/useMSAuth) ──
  const {
    authenticateMS, authenticateEmail, authenticateTeams,
    emailTokenIsValid, handleEmailTokenExpired,
    getGraphToken,
    graphGet: teamsGraph,
    graphPost: teamsGraphPost,
    msSignOut,
  } = useMSAuth({
    msToken, setMsToken, msDisplayName, setMsDisplayName,
    teamsAuthStatus, setTeamsAuthStatus,
  });

  const {
    loadTeamsContacts, searchTeamsContacts, handleTeamsContactInput,
    teamsLoadChannelMap, teamsSbSave, teamsFindRofTeam,
    teamsStartChat, teamsLoadPOMessages, teamsSendMessage,
    loadDmMessages, teamsSendDirect, sendDmReply,
  } = useTeamsOps({
    teamsGraph, teamsGraphPost,
    teamsToken, teamsTeamId, teamsChannelMap, teamsContacts, teamsContactsLoading,
    teamsNewMsg, teamsDirectTo, teamsDirectMsg, dmSelectedName, dmActiveChatId, dmNewMsg, dmScrollRef,
    setTeamsTeamId, setTeamsChannelMap, setTeamsContacts, setTeamsContactsLoading, setTeamsContactsError,
    setTeamsContactSearchResults, setTeamsContactSearch, setTeamsContactDropdown,
    setTeamsCreating, setTeamsLoading, setTeamsMessages, setTeamsNewMsg,
    setTeamsDirectTo, setTeamsDirectMsg, setTeamsDirectSending, setTeamsDirectErr,
    setDmConversations, setDmActiveChatId, setDmComposing, setDmSelectedName,
    setDmLoading, setDmError, setDmNewMsg, setDmSending,
    setDtlDMTo, setDtlDMContactSearch, setDtlDMContactDropdown, setDtlDMContactSearchResults,
    setToast,
  });
  // msSignOut now provided by useMSAuth hook above.
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
      msToken, msDisplayName, pos, setView, dmScrollRef,
      teamsLoadPOMessages, teamsStartChat, teamsSendMessage, teamsSendDirect,
      sendDmReply, loadDmMessages, handleTeamsContactInput, loadTeamsContacts,
      authenticateTeams, msSignOut,
    });
  }

  // ── Email operations (see tanda/hooks/useEmailOps) ─────────────────────
  const loadPOEmailsRef = useRef<((poNum: string) => void) | undefined>();
  const {
    emailGraph, emailGraphPost, emailGraphDelete,
    loadEmailAttachments, emailMarkAsRead, deleteMainEmail,
    loadDtlEmails, loadDtlSentEmails, loadDtlFullEmail, loadDtlThread,
    dtlSendEmail, dtlReplyToEmail,
  } = useEmailOps({
    getGraphToken, handleEmailTokenExpired, msToken,
    emailAttachments, setEmailAttachments, setEmailAttachmentsLoading,
    emailSelPO, setEmailSelectedId, setEmailSelMsg, setEmailDeleteConfirm,
    setEmailThreadMsgs, setEmailsMap, setEmailSentMap, setEmailAllMessages,
    setEmailNextLinks, setEmailLastRefresh,
    setDtlEmails, setDtlSentEmails, setDtlEmailLoading, setDtlEmailErr,
    setDtlLoadingOlder, setDtlSentLoading, setDtlNextLink,
    setDtlEmailSel, setDtlEmailThread, setDtlThreadLoading, setDtlEmailTab,
    dtlComposeTo, setDtlComposeTo, dtlComposeSubject, setDtlComposeSubject,
    dtlComposeBody, setDtlComposeBody, setDtlSendErr,
    dtlReply, setDtlReply, dtlEmailSel,
    loadPOEmailsRef,
  });

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

  // ── Unread notifications count (drives the nav bell badge) ──────────────
  // Filtered to PO WIP-relevant events only.
  const unreadNotifs = useAppUnreadCount({
    supabase: supabaseClient,
    userId: user?.id,
    recipientColumn: "recipient_internal_id",
    app: "tanda",
  });
  // First-load-of-session auto-open. Switches the in-app view instead
  // of redirecting to a separate page. sessionStorage flag prevents
  // bouncing the user back after they click into a target item.
  const autoOpenChecked = useRef(false);
  useEffect(() => {
    if (!user?.id || autoOpenChecked.current) return;
    if (unreadNotifs <= 0) return;
    autoOpenChecked.current = true;
    let dismissed = false;
    try { dismissed = sessionStorage.getItem("rof_notif_dismissed_internal") === "1"; } catch { /* noop */ }
    if (!dismissed && useTandaStore.getState().view !== "notifications") {
      try { sessionStorage.setItem("rof_notif_dismissed_internal", "1"); } catch { /* noop */ }
      coreSet("selected", null);
      coreSet("view", "notifications");
    }
  }, [user?.id, unreadNotifs]);

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
    const { data } = await sb.from("tanda_notes").select("*").order("created_at", { ascending: false });
    setNotes(Array.isArray(data) ? (data as LocalNote[]) : []);
  }, []);

  // ── Template operations (extracted to useTemplateOps) ──────────────────────
  const {
    loadWipTemplates, saveVendorTemplates, deleteVendorTemplate,
    getVendorTemplates, vendorHasTemplate, templateVendorList,
    loadDesignTemplates, loadDCVendors, syncVendorsToDC,
  } = useTemplateOps();

  // ── Notes / Attachments / DeletePO operations (extracted to useNotesOps) ──
  const {
    addNote, editNote, deleteNote, addHistory,
    uploadAttachment, loadAttachments, deleteAttachment,
    undoDeleteAttachment, purgeExpiredAttachments, deletePO,
  } = useNotesOps({
    loadNotes,
    getNewNote: () => newNote,
    setNewNote,
    getSelected: () => selected,
    setSelected,
  });

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
        // Fold the buyer_po column into the in-memory PO so loaders that
        // predate the column or rows synced before the feature still surface it.
        setPos(active.map((r: any) => ({
          ...(r.data as XoroPO),
          BuyerPo: r.buyer_po || (r.data as XoroPO)?.BuyerPo || "",
          // Fold user-edited columns on top of Xoro JSONB so grid edits persist across reloads
          ...(r.buyer_name ? { BuyerName: r.buyer_name } : {}),
          ...(r.date_expected_delivery ? { DateExpectedDelivery: r.date_expected_delivery } : {}),
        })));
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

  // ── WIP Template data layer → extracted to useTemplateOps ─────────────────

  // ── Milestone data layer (extracted to useMilestoneOps) ───────
  const {
    loadAllMilestones, loadMilestones, saveMilestone, saveMilestones,
    deleteMilestonesForPO, generateMilestones, ensureMilestones, regenerateMilestones,
    getVendorTemplates: _msGetVendorTemplates, vendorHasTemplate: _msVendorHasTemplate,
  } = useMilestoneOps({ sb, addHistory, setConfirmModal, setCollapsedCats, acceptedBlocked });

  // ── Archive / Bulk-update operations (extracted to useArchiveOps) ─────────
  const {
    archivePO, loadArchivedPOs, unarchivePO,
    permanentDeleteArchived, bulkUpdateMilestones,
  } = useArchiveOps({
    addHistory, loadCachedPOs, ensureMilestones, saveMilestone,
    getSelected: () => selected,
    setSelected,
    setArchivedPos, setArchiveLoading,
    getBulkState: () => ({ bulkVendor, bulkStatus, bulkPhases, bulkCategory, bulkPOs }),
    setBulkUpdating, setShowBulkUpdate,
    setBulkPhase, setBulkPhases, setBulkCategory, setBulkPOs, setBulkPOSearch,
    setConfirmModal,
  });

  // ── Sync ops (extracted to useSyncOps hook) ──────────────────────────────
  const { cancelSync, syncFromXoro, loadSyncLog, appendSyncLog, syncAbortRef } = useSyncOps({
    archivePO, loadCachedPOs, syncVendorsToDC, addHistory,
  });

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
    // Pending-save guard: useMilestoneOps.saveMilestone bumps
    // window.__tandaPendingSaves around each save, so we know when to
    // wait. Without this guard, the 15s realtime poll would clobber
    // an in-flight optimistic edit by reloading server state on top
    // of it.
    const hasPendingSave = () => {
      const w = window as typeof window & { __tandaPendingSaves?: number };
      return (w.__tandaPendingSaves ?? 0) > 0;
    };
    const doReload = async () => {
      reloadDebounceId = null;
      // Defer when the user is mid-edit (focused input/textarea/select)
      // OR when a save is in flight. Either case would lose unfinished
      // local state on re-render. The poll keeps trying; once both
      // clear, the next tick picks up the change.
      if (isUserEditing() || hasPendingSave()) return;
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
  const autoDelayRanRef = useRef(false);
  useEffect(() => {
    if (autoDelayRanRef.current || pos.length === 0) return;
    autoDelayRanRef.current = true; // set FIRST to prevent re-entry from saveMilestone's store updates
    const ms = useTandaStore.getState().milestones;
    const today = new Date().toISOString().slice(0, 10);
    Object.values(ms).flat().forEach(m => {
      if (m.expected_date && m.expected_date <= today && m.status === "Not Started" && !autoDelayedRef.current.has(m.id)) {
        autoDelayedRef.current.add(m.id);
        const dates = { ...(m.status_dates || {}) };
        if (!dates["Delayed"]) dates["Delayed"] = today;
        saveMilestone({ ...m, status: "Delayed", status_date: dates["Delayed"], status_dates: dates, updated_at: new Date().toISOString(), updated_by: "System" }, true);
      }
    });
  }, [pos.length]);

  // ── Derived (memoized to avoid recompute on every store tick) ──────────────
  const vendors = useMemo(
    () => ["All", ...Array.from(new Set(pos.map(p => p.VendorName ?? "Unknown"))).sort()],
    [pos]
  );

  // Distinct, non-empty BuyerName values across loaded POs — used by the Grid
  // view's buyer filter so the user can isolate a single buyer's milestones.
  const buyers = useMemo(
    () => Array.from(new Set(pos.map(p => p.BuyerName ?? "").filter(Boolean))).sort(),
    [pos]
  );

  const filtered = useMemo(() => pos.filter(p => {
    const s = search.toLowerCase();
    const matchSearch = !s
      || (p.PoNumber ?? "").toLowerCase().includes(s)
      || (p.VendorName ?? "").toLowerCase().includes(s)
      || (p.BuyerName ?? "").toLowerCase().includes(s)
      || (p.BuyerPo ?? "").toLowerCase().includes(s)
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
      cmp = tsOr(a.DateExpectedDelivery, Infinity) - tsOr(b.DateExpectedDelivery, Infinity);
    } else if (sortBy === "po_date") {
      cmp = tsOr(a.DateOrder, Infinity) - tsOr(b.DateOrder, Infinity);
    } else {
      cmp = statusPriority(a) - statusPriority(b);
      if (cmp === 0) {
        cmp = tsOr(a.DateExpectedDelivery, Infinity) - tsOr(b.DateExpectedDelivery, Infinity);
      }
    }
    return sortDir === "asc" ? cmp : -cmp;
  }), [pos, search, filterStatus, filterVendor, sortBy, sortDir]);

  const overdue = useMemo(() => pos.filter(p => {
    const d = daysUntil(p.DateExpectedDelivery);
    return d !== null && d < 0 && p.StatusName !== "Received" && p.StatusName !== "Closed";
  }).length, [pos]);
  const dueThisWeek = useMemo(() => pos.filter(p => {
    const d = daysUntil(p.DateExpectedDelivery);
    return d !== null && d >= 0 && d <= 7;
  }).length, [pos]);
  const totalValue = useMemo(() => pos.reduce((s, p) => s + poTotal(p), 0), [pos]);

  // ── Dashboard data + milestone aggregates (see tanda/hooks/useDashboardData) ──
  const {
    dashPOs, dashPoNums, today, weekFromNow,
    allMilestonesList, overdueMilestones, dueThisWeekMilestones,
    completedMilestones, milestoneCompletionRate, upcomingMilestones,
    dashMs, dashOverdueMilestones, dashDueThisWeekMilestones,
    dashUpcomingMilestones, dashMsCompleted, dashMilestoneCompletionRate,
    dashTotalValue, dashOverduePOs, dashDueThisWeekPOs,
    cascadeAlerts,
  } = useDashboardData({ pos, filtered, search, milestones });

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
    const allMs = [...(useTandaStore.getState().milestones[poNum] || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
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

  // ── Notes / Attachments / DeletePO → extracted to useNotesOps ────────────
  // ── Archive / Bulk-update → extracted to useArchiveOps ─────────────────

  const allPONotes = (Array.isArray(notes) ? notes : []).filter(n => n.po_number === selected?.PoNumber);
  const selectedNotes = allPONotes.filter(n => n.status_override !== "__history__" && n.status_override !== "__attachment__");
  const selectedHistory = allPONotes.filter(n => n.status_override === "__history__");

  // ════════════════════════════════════════════════════════════════════════════
  // LOGIN SCREEN
  // ════════════════════════════════════════════════════════════════════════════
  const [showLoginPass, setShowLoginPass] = useState(false);

  // Auto-load email stats once after MS auth, then refresh every 2 minutes.
  // MUST be declared before any early returns below to keep hook order stable.
  // Indirected through a ref because `loadAllPOEmailStats` is declared further
  // below (from useEmailData); direct forward reference from a useEffect closure
  // is allowed by JS semantics but tripped Terser's minification in production.
  const loadAllPOEmailStatsRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!msToken) return;
    loadAllPOEmailStatsRef.current?.();
    const id = setInterval(() => loadAllPOEmailStatsRef.current?.(), 120000);
    return () => clearInterval(id);
  }, [msToken]);

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
  // NAVIGATION GUARDS
  // ════════════════════════════════════════════════════════════════════════════
  const tplDirtyGlobal = tplLocalEdits !== null;
  function guardedNav(action: () => void) {
    if (tplDirtyGlobal) {
      setConfirmModal({ title: "Unsaved Template Changes", message: "You have unsaved changes to the production template. Would you like to save or discard?", icon: "⚠️", confirmText: "💾 Save Changes", confirmColor: "#2563EB", cancelText: "🗑 Discard", onConfirm: () => { saveVendorTemplates(tplLocalEdits!.vendor, tplLocalEdits!.edits); setTplLocalEdits(null); setTplUndoStack([]); setTplMovedIds(new Set()); action(); }, onCancel: () => { setTplLocalEdits(null); setTplUndoStack([]); setTplMovedIds(new Set()); action(); } });
    } else {
      action();
    }
  }
  function closeSettingsGuarded() {
    if (tplDirtyGlobal) {
      setConfirmModal({ title: "Unsaved Template Changes", message: "You have unsaved changes to the production template. Would you like to save or discard?", icon: "⚠️", confirmText: "💾 Save Changes", confirmColor: "#2563EB", cancelText: "🗑 Discard", onConfirm: () => { saveVendorTemplates(tplLocalEdits!.vendor, tplLocalEdits!.edits); setTplLocalEdits(null); setTplUndoStack([]); setTplMovedIds(new Set()); setShowSettings(false); }, onCancel: () => { setTplLocalEdits(null); setTplUndoStack([]); setTplMovedIds(new Set()); setShowSettings(false); } });
    } else {
      setShowSettings(false);
    }
  }

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
  // OUTLOOK EMAIL VIEW — data-fetching via useEmailData hook
  // ════════════════════════════════════════════════════════════════════════════
  const {
    emailGetPrefix, loadFullEmail, loadEmailThread, loadPOEmails,
    loadDeletedFolder, emptyDeletedFolder, loadAllPOEmailStats,
  } = useEmailData({
    emailGraph, getGraphToken, msToken,
    setEmailSelMsg, setEmailThreadLoading, setEmailThreadMsgs,
    setEmailLoadingOlder, setEmailLoadingMap, setEmailErrorsMap,
    setEmailsMap, setDtlEmails, setEmailSelectedId,
    setEmailNextLinks, setDtlNextLink, setEmailLastRefresh,
    loadEmailAttachments, loadPOEmailsRef,
  });
  // Publish to the ref the early useEffect at top of the component uses.
  loadAllPOEmailStatsRef.current = loadAllPOEmailStats;

  function emailViewPanel() {
    return emailViewPanelExtracted({
      pos, setView,
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
          <button
            style={{
              ...(view === "notifications" ? S.navBtnActive : S.navBtn),
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              position: "relative",
            }}
            onClick={() => guardedNav(() => { setSelected(null); setView("notifications"); })}
            title="Notifications"
          >
            🔔 Notifications
            {unreadNotifs > 0 && (
              <span style={{
                minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999,
                background: "#EF4444", color: "#fff", fontSize: 10, fontWeight: 700,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
              }}>{unreadNotifs > 9 ? "9+" : unreadNotifs}</span>
            )}
          </button>
          <button style={view === "dashboard" ? S.navBtnActive : S.navBtn} onClick={() => guardedNav(() => { setSelected(null); setView("dashboard"); })}>🏠 Dashboard</button>
          <button style={view === "list"      ? S.navBtnActive : S.navBtn} onClick={() => guardedNav(() => { setSelected(null); setView("list"); })}>All POs</button>
          <button style={view === "grid"      ? S.navBtnActive : S.navBtn} onClick={() => guardedNav(() => { setSelected(null); setView("grid"); })}>🗂 Grid</button>
          <button style={view === "templates" ? S.navBtnActive : S.navBtn} onClick={() => guardedNav(() => { setSelected(null); setView("templates"); })}>📐 Templates</button>
          <button style={view === "teams" ? { ...S.navBtnActive, borderColor: TEAMS_PURPLE, color: TEAMS_PURPLE_LT } : { ...S.navBtn, color: TEAMS_PURPLE_LT }} onClick={() => guardedNav(() => { setSelected(null); setView("teams"); })}>💬 Teams</button>
          <button style={view === "email" ? S.navBtnActive : S.navBtn} onClick={() => guardedNav(() => {
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
          })}>📧 Email</button>
          <button style={view === "activity" ? S.navBtnActive : S.navBtn} onClick={() => guardedNav(() => { setSelected(null); setView("activity"); })}>📋 Activity</button>
          <VendorsMenu view={view} onSelect={(v) => guardedNav(() => {
            // "phase_reviews" is the ROF approval page — it lives at
            // a top-level route outside TandA, so we navigate hard
            // instead of changing the in-app view.
            if (v === "phase_reviews") {
              window.location.href = "/rof/phase-reviews";
              return;
            }
            setSelected(null);
            setView(v);
            if (v === "vendors") loadArchivedPOs();
          })} />
          <button style={view === "timeline" ? S.navBtnActive : S.navBtn} onClick={() => guardedNav(() => { if (selected) setSearch(selected.PoNumber ?? ""); setView("timeline"); })}>📊 Timeline</button>
          <button style={view === "archive" ? S.navBtnActive : S.navBtn} onClick={() => guardedNav(() => { setSelected(null); setView("archive"); loadArchivedPOs(); })}>📦 Archive{archivedPos.length > 0 ? ` (${archivedPos.length})` : ""}</button>
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
        {view === "dashboard" && <DashboardView
          pos={pos} filtered={filtered} search={search} setSearch={setSearch}
          milestones={milestones} loading={loading} syncing={syncing} lastSync={lastSync}
          setView={setView} setFilterStatus={setFilterStatus} setDetailMode={setDetailMode}
          setNewNote={setNewNote} setSelected={setSelected} setShowSyncModal={setShowSyncModal}
          loadVendors={loadVendors} openCategoryWithCheck={openCategoryWithCheck}
        />}

        {/* ── ALL POs ── */}
        {view === "list" && <ListView
          pos={pos} filtered={filtered} search={search} setSearch={setSearch}
          filterStatus={filterStatus} setFilterStatus={setFilterStatus}
          filterVendor={filterVendor} setFilterVendor={setFilterVendor}
          vendors={vendors} sortBy={sortBy} setSortBy={setSortBy} sortDir={sortDir} setSortDir={setSortDir}
          loading={loading} syncing={syncing} lastSync={lastSync}
          setView={setView} setDetailMode={setDetailMode} setNewNote={setNewNote} setSelected={setSelected}
          setShowSyncModal={setShowSyncModal} loadVendors={loadVendors} milestones={milestones}
        />}

        {/* ── GRID (cross-PO milestones) ── */}
        {view === "grid" && <GridView
          pos={pos}
          milestones={milestones}
          buyers={buyers}
          vendors={vendors.filter(v => v !== "All")}
          setView={setView}
          setSelected={setSelected}
          setDetailMode={setDetailMode}
          saveMilestone={saveMilestone}
          saveMilestones={saveMilestones}
          ensureMilestones={ensureMilestones}
          generateMilestones={generateMilestones}
          regenerateMilestones={regenerateMilestones}
          vendorHasTemplate={vendorHasTemplate}
          templateVendorList={templateVendorList}
          getVendorTemplates={getVendorTemplates}
          saveVendorTemplates={saveVendorTemplates}
          user={user}
        />}


        {/* ── TEMPLATES ── */}
        {view === "templates" && <TemplatesView
          user={user} pos={pos} wipTemplates={wipTemplates} setWipTemplates={setWipTemplates}
          tplVendor={tplVendor} setTplVendor={setTplVendor}
          tplLocalEdits={tplLocalEdits} setTplLocalEdits={setTplLocalEdits}
          tplUndoStack={tplUndoStack} setTplUndoStack={setTplUndoStack}
          tplDragIdx={tplDragIdx} setTplDragIdx={setTplDragIdx}
          tplDragOverIdx={tplDragOverIdx} setTplDragOverIdx={setTplDragOverIdx}
          tplMovedIds={tplMovedIds} setTplMovedIds={setTplMovedIds}
          templateVendorList={templateVendorList} vendorHasTemplate={vendorHasTemplate}
          getVendorTemplates={getVendorTemplates} saveVendorTemplates={saveVendorTemplates}
          deleteVendorTemplate={deleteVendorTemplate} setConfirmModal={setConfirmModal}
        />}

        {/* ── TEAMS ── */}
        {view === "teams" && teamsViewPanel()}

        {/* ── EMAIL ── */}
        {view === "email" && emailViewPanel()}

        {/* ── ACTIVITY ── */}
        {view === "activity" && <ActivityView
          notes={notes} pos={pos}
          setDetailMode={setDetailMode as any} setNewNote={setNewNote} setSearch={setSearch}
          setSelected={setSelected} setView={setView}
        />}

        {/* ── VENDORS ── */}
        {view === "vendors" && <VendorsView
          pos={pos} archivedPos={archivedPos} milestones={milestones}
          setSearch={setSearch} setView={setView}
        />}

        {/* ── TIMELINE ── */}
        {view === "timeline" && timelinePanelExtracted({
          pos, milestones, search, setSearch, selected, setSelected,
          setDetailMode: setDetailMode as any, setView, setNewNote, openCategoryWithCheck,
        })}

        {/* ── 3-WAY MATCH VIEW ── */}
        {view === "match" && <MatchView />}

        {/* ── COMPLIANCE REVIEW ── */}
        {view === "compliance" && <ComplianceReview />}

        {/* ── NOTIFICATIONS (in-app) ── */}
        {view === "notifications" && supabaseClient && user && (
          <NotificationsPage
            embed
            kind="internal"
            supabase={supabaseClient}
            userId={user.id}
            title="Notifications"
            appFilter="tanda"
          />
        )}

        {/* ── MESSAGES ── */}
        {view === "messages" && <MessagesView />}

        {/* ── VENDOR LEADERBOARD ── */}
        {view === "scorecards" && <VendorLeaderboard />}

        {/* ── SPEND REPORT ── */}
        {view === "spend" && <SpendReport />}

        {/* ── SHIPMENTS VIEW ── */}
        {view === "shipments" && <ShipmentsView />}

        {/* ── ONBOARDING REVIEW ── */}
        {view === "onboarding" && <InternalOnboarding />}

        {/* ── ANOMALIES ── */}
        {view === "anomalies" && <InternalAnomalies />}

        {/* ── ANALYTICS ── */}
        {view === "analytics" && <InternalAnalytics />}

        {/* ── HEALTH SCORES ── */}
        {view === "health_scores" && <InternalHealthScores />}

        {/* ── PREFERRED VENDORS ── */}
        {view === "preferred_vendors" && <InternalPreferred />}

        {/* ── RFQs ── */}
        {view === "rfqs" && <InternalRfqs />}

        {/* ── WORKFLOW RULES ── */}
        {view === "workflow_rules" && <InternalWorkflowRules />}

        {/* ── WORKFLOW EXECUTIONS (APPROVALS) ── */}
        {view === "workflow_executions" && <InternalWorkflowExecutions />}

        {/* ── ENTITIES ── */}
        {view === "entities" && <InternalEntities />}

        {/* ── INSIGHTS ── */}
        {view === "insights" && <InternalInsights />}

        {/* ── WORKSPACES ── */}
        {view === "workspaces" && <InternalWorkspaces />}

        {/* ── SUSTAINABILITY ── */}
        {view === "sustainability" && <InternalSustainability />}

        {/* ── ESG SCORES ── */}
        {view === "esg_scores" && <InternalEsgScores />}

        {/* ── DIVERSITY ── */}
        {view === "diversity" && <InternalDiversity />}

        {/* ── COMPLIANCE AUTOMATION ── */}
        {view === "compliance_automation" && <InternalComplianceAutomation />}

        {/* ── COMPLIANCE AUDIT ── */}
        {view === "compliance_audit" && <InternalComplianceAudit />}

        {/* ── MARKETPLACE ── */}
        {view === "marketplace" && <InternalMarketplace />}

        {/* ── MARKETPLACE INQUIRIES ── */}
        {view === "marketplace_inquiries" && <InternalMarketplaceInquiries />}

        {/* ── BENCHMARK ── */}
        {view === "benchmark" && <InternalBenchmark />}

        {/* ── DISCOUNT OFFERS ── */}
        {view === "discount_offers" && <InternalDiscountOffers />}

        {/* ── PAYMENTS ── */}
        {view === "payments" && <InternalPayments />}

        {/* ── SCF ── */}
        {view === "scf" && <InternalScf />}

        {/* ── FX ── */}
        {view === "fx" && <InternalFx />}

        {/* ── VIRTUAL CARDS ── */}
        {view === "virtual_cards" && <InternalVirtualCards />}

        {/* ── TAX ── */}
        {view === "tax" && <InternalTax />}

        {/* ── ARCHIVE VIEW ── */}
        {view === "archive" && <ArchiveView
          archivedPos={archivedPos} archiveSearch={archiveSearch} setArchiveSearch={setArchiveSearch}
          archiveFilterVendor={archiveFilterVendor} setArchiveFilterVendor={setArchiveFilterVendor}
          archiveFilterStatus={archiveFilterStatus} setArchiveFilterStatus={setArchiveFilterStatus}
          archiveSelected={archiveSelected} setArchiveSelected={setArchiveSelected}
          archiveLoading={archiveLoading} unarchivePO={unarchivePO}
          permanentDeleteArchived={permanentDeleteArchived} setConfirmModal={setConfirmModal}
        />}
      </div>

      {selected && view !== "timeline" && DetailPanel()}
      {showSettings && <SettingsModal lastSync={lastSync} pos={pos} closeSettingsGuarded={closeSettingsGuarded} setShowSettings={setShowSettings} setShowSyncModal={setShowSyncModal} />}
      <SyncModals
        showSyncModal={showSyncModal} syncing={syncing} syncDone={syncDone} showSyncLog={showSyncLog}
        syncFilters={syncFilters} setSyncFilters={setSyncFilters}
        poSearch={poSearch} setPoSearch={setPoSearch} poDropdownOpen={poDropdownOpen} setPoDropdownOpen={setPoDropdownOpen}
        xoroVendors={xoroVendors} manualVendors={manualVendors} vendorSearch={vendorSearch} setVendorSearch={setVendorSearch}
        loadingVendors={loadingVendors} newManualVendor={newManualVendor} setNewManualVendor={setNewManualVendor}
        saveManualVendor={saveManualVendor} removeManualVendor={removeManualVendor}
        syncProgress={syncProgress} syncProgressMsg={syncProgressMsg} syncErr={syncErr}
        syncLog={syncLog} pos={pos}
        setShowSyncModal={setShowSyncModal} setShowSyncLog={setShowSyncLog} setSyncDone={setSyncDone}
        cancelSync={cancelSync} syncFromXoro={syncFromXoro} syncVendorsToDC={syncVendorsToDC} setConfirmModal={setConfirmModal}
      />
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

      {supabaseClient && user && (
        <NotificationsShell
          kind="internal"
          supabase={supabaseClient}
          userId={user.id}
          notificationsUrl="/notifications?from=tanda"
          currentPath={typeof window !== "undefined" ? window.location.pathname : undefined}
          isViewingNotifications={view === "notifications"}
          sessionKey="rof_notif_dismissed_internal"
          onOpen={() => { setSelected(null); setView("notifications"); }}
          autoOpen={false}
          appFilter="tanda"
        />
      )}
    </div>
  );

  // StatCard and PORow extracted to tanda/components/
}

