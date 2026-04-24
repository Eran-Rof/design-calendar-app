import { useState, useRef, useEffect, Fragment, lazy, Suspense } from "react";
import NotificationsShell from "./components/notifications/NotificationsShell";
import { supabaseClient } from "./utils/supabase";
import { useIdleLogout } from "./hooks/useIdleLogout";
import { useAppStore } from "./store";
import { sbLoad as sbLoadSvc, sbSaveTask as sbSaveTaskSvc, sbLoadTasks as sbLoadTasksSvc, sbLoadCollections as sbLoadCollectionsSvc } from "./store/supabaseService";
import React from "react";

// ─── Utils ────────────────────────────────────────────────────────────────────
import { TH, TEAMS_PURPLE, TEAMS_PURPLE_LT, OUTLOOK_BLUE, OUTLOOK_BLUE_LT, setConfirmHandler, appConfirm } from "./utils/theme";
import { getMsAccessToken, loadMsTokens } from "./utils/msAuth";
import { STATUS_CONFIG, BRANDS, GENDERS, PHASE_KEYS, MONTHS } from "./utils/constants";
import { getBrand as getBrandStatic, formatDate, addDays, diffDays, parseLocalDate, getDaysUntil, diffDaysForPhase, getDaysUntilForPhase, snapToBusinessDay, toDateStr, isPostPO } from "./utils/dates";
import { fmtDays, ROFLogoFull, S } from "./utils/styles";
import { SB_URL, SB_KEY, supabaseClient } from "./utils/supabase";

// ─── Components ───────────────────────────────────────────────────────────────
import Avatar from "./components/Avatar";
import { Modal, ConfirmModal } from "./components/Modal";
import ContextMenu from "./components/ContextMenu";
const ActivityPanel = lazy(() => import("./components/ActivityPanel"));
import SettingsDropdown from "./components/SettingsDropdown";
import CollectionWizard from "./components/CollectionWizard";
import TaskEditModal from "./components/TaskEditModal";
import AddTaskModal from "./components/AddTaskModal";
import EditCollectionModal from "./components/EditCollectionModal";
import FilterBar from "./components/FilterBar";
const TeamsView = lazy(() => import("./components/TeamsView"));
const OutlookView = lazy(() => import("./components/OutlookView"));
const CategoryManager = lazy(() => import("./components/CategoryManager"));
import SizeLibrary from "./components/SizeLibrary";
const TaskManager = lazy(() => import("./components/TaskManager"));
const TeamManager = lazy(() => import("./components/TeamManager"));
const UserManager = lazy(() => import("./components/UserManager"));
const VendorManager = lazy(() => import("./components/VendorManager"));
const BrandManager = lazy(() => import("./components/BrandManager"));
const SeasonManager = lazy(() => import("./components/SeasonManager"));
const CustomerManager = lazy(() => import("./components/CustomerManager"));
const OrderTypeManager = lazy(() => import("./components/OrderTypeManager"));
const RoleManager = lazy(() => import("./components/RoleManager"));
const GenderManager = lazy(() => import("./components/GenderManager"));
import type { AppStore } from "./store";
import { DashboardPanel } from "./dc/dashboardPanel";
import TaskCard from "./components/TaskCard";
import { TimelinePanel } from "./dc/timelinePanel";
import { CalendarPanel } from "./dc/calendarPanel";

// ─── MAIN APP ─────────────────────────────────────────────────────────────────


export default function AppWrapper() {
  return <App />;
}

function App() {
  const s = useAppStore();
  // dcSet removed — all callers now use useAppStore.getState().setField() directly
  // ── Confirm modal state ────────────────────────────────────────────────
  const [confirmState, setConfirmState] = useState<{ message: string; action: string; onConfirm: () => void } | null>(null);
  setConfirmHandler((opts) => setConfirmState(opts));

  // ── Supabase persistence ─────────────────────────────────────────────────
  const saveErr = s.saveErr;
  const setSaveErr = (v: string) => useAppStore.getState().setField("saveErr", v);


  const dbxLoaded = s.dbxLoaded;
  const setDbxLoaded = (v: boolean) => useAppStore.getState().setField("dbxLoaded", v);

  // ── Data state — backed by Zustand store ─────────────────────────────────
  const users = useAppStore(s => s.users);
  const setUsers = (v: any, skip = false) => { if (skip) useAppStore.setState({ users: typeof v === "function" ? v(useAppStore.getState().users) : v }); else useAppStore.getState().setRefData("users", "users", typeof v === "function" ? v(useAppStore.getState().users) : v); };
  const currentUser = useAppStore(s => s.currentUser);
  const setCurrentUser = (v: any) => useAppStore.setState({ currentUser: v });
  const brands = useAppStore(s => s.brands);
  const setBrands = (v: any, skip = false) => { if (skip) useAppStore.setState({ brands: typeof v === "function" ? v(useAppStore.getState().brands) : v }); else useAppStore.getState().setRefData("brands", "brands", typeof v === "function" ? v(useAppStore.getState().brands) : v); };
  const seasons = useAppStore(s => s.seasons);
  const setSeasons = (v: any, skip = false) => { if (skip) useAppStore.setState({ seasons: typeof v === "function" ? v(useAppStore.getState().seasons) : v }); else useAppStore.getState().setRefData("seasons", "seasons", typeof v === "function" ? v(useAppStore.getState().seasons) : v); };
  const customers = useAppStore(s => s.customers);
  const setCustomers = (v: any, skip = false) => { if (skip) useAppStore.setState({ customers: typeof v === "function" ? v(useAppStore.getState().customers) : v }); else useAppStore.getState().setRefData("customers", "customers", typeof v === "function" ? v(useAppStore.getState().customers) : v); };
  const vendors = useAppStore(s => s.vendors);
  const setVendors = (v: any, skip = false) => { if (skip) useAppStore.setState({ vendors: typeof v === "function" ? v(useAppStore.getState().vendors) : v }); else useAppStore.getState().setRefData("vendors", "vendors", typeof v === "function" ? v(useAppStore.getState().vendors) : v); };
  const team = useAppStore(s => s.team);
  const setTeam = (v: any, skip = false) => { if (skip) useAppStore.setState({ team: typeof v === "function" ? v(useAppStore.getState().team) : v }); else useAppStore.getState().setRefData("team", "team", typeof v === "function" ? v(useAppStore.getState().team) : v); };
  const tasks = useAppStore(s => s.tasks);
  const setTasks = useAppStore.getState().setTasks;
  const _setTasksRaw = useAppStore.getState().setTasksRaw;
  const collections = useAppStore(s => s.collections);
  const setCollections = useAppStore.getState().setCollections;
  const _setCollRaw = useAppStore.getState().setCollectionsRaw;
  // ── View/UI state → useAppStore (see store/index.ts) ──
  const view = s.view;
  const listView = s.listView;
  const expandedColl = s.expandedColl;
  const filterBrand = s.filterBrand;
  const filterSeason = s.filterSeason;
  const filterCustomer = s.filterCustomer;
  const filterVendor = s.filterVendor;
  const focusCollKey = s.focusCollKey;
  const pendingDeleteColl = s.pendingDeleteColl;
  const timelineBackFilter = s.timelineBackFilter;
  const globalLog = s.globalLog;
  const showNav = s.showNav;
  const showWizard = s.showWizard;
  const showVendors = s.showVendors;
  const showTeam = s.showTeam;
  const showUsers = s.showUsers;
  const showSizeLib = s.showSizeLib;
  const showCatLib = s.showCatLib;
  const setView = (v: string) => useAppStore.getState().setField("view", v);
  const setListView = (v: boolean) => useAppStore.getState().setField("listView", v);
  const setExpandedColl = (v: string | null) => useAppStore.getState().setField("expandedColl", v);
  const setFilterBrand = (v: any) => { if (typeof v === "function") useAppStore.getState().setField("filterBrand", v(s.filterBrand)); else useAppStore.getState().setField("filterBrand", v); };
  const setFilterSeason = (v: any) => { if (typeof v === "function") useAppStore.getState().setField("filterSeason", v(s.filterSeason)); else useAppStore.getState().setField("filterSeason", v); };
  const setFilterCustomer = (v: any) => { if (typeof v === "function") useAppStore.getState().setField("filterCustomer", v(s.filterCustomer)); else useAppStore.getState().setField("filterCustomer", v); };
  const setFilterVendor = (v: any) => { if (typeof v === "function") useAppStore.getState().setField("filterVendor", v(s.filterVendor)); else useAppStore.getState().setField("filterVendor", v); };
  const setFocusCollKey = (v: any) => useAppStore.getState().setField("focusCollKey", v);
  const setPendingDeleteColl = (v: string | null) => useAppStore.getState().setField("pendingDeleteColl", v);
  const setTimelineBackFilter = (v: string | null) => useAppStore.getState().setField("timelineBackFilter", v);
  const setGlobalLog = (v: any) => { if (typeof v === "function") useAppStore.getState().setField("globalLog", v(s.globalLog)); else useAppStore.getState().setField("globalLog", v); };
  const setShowNav = (v: boolean) => useAppStore.getState().setField("showNav", v);
  const setShowWizard = (v: boolean) => useAppStore.getState().setField("showWizard", v);
  const setShowVendors = (v: boolean) => useAppStore.getState().setField("showVendors", v);
  const setShowTeam = (v: boolean) => useAppStore.getState().setField("showTeam", v);
  const setShowUsers = (v: boolean) => useAppStore.getState().setField("showUsers", v);
  const setShowSizeLib = (v: boolean) => useAppStore.getState().setField("showSizeLib", v);
  const setShowCatLib = (v: boolean) => useAppStore.getState().setField("showCatLib", v);
  const sizeLibrary = useAppStore(s => s.sizeLibrary);
  const setSizeLibrary = (v: any, skip = false) => { if (skip) useAppStore.setState({ sizeLibrary: typeof v === "function" ? v(useAppStore.getState().sizeLibrary) : v }); else useAppStore.getState().setRefData("size_library", "sizeLibrary", typeof v === "function" ? v(useAppStore.getState().sizeLibrary) : v); };
  const categoryLib = useAppStore(s => s.categoryLib);
  const setCategoryLib = (v: any, skip = false) => { if (skip) useAppStore.setState({ categoryLib: typeof v === "function" ? v(useAppStore.getState().categoryLib) : v }); else useAppStore.getState().setRefData("categories", "categoryLib", typeof v === "function" ? v(useAppStore.getState().categoryLib) : v); };
  const editTask = s.editTask;
  const dragId = s.dragId;
  const dragOverId = s.dragOverId;
  const ctxMenu = s.ctxMenu;
  const editCollKey = s.editCollKey;
  const statFilter = s.statFilter;
  const showAddTask = s.showAddTask;
  const showBrands = s.showBrands;
  const showSeasons = s.showSeasons;
  const showCustomers = s.showCustomers;
  const showOrderTypes = s.showOrderTypes;
  const showRoles = s.showRoles;
  const showGenders = s.showGenders;
  const showActivity = s.showActivity;
  const showTaskManager = s.showTaskManager;
  const setEditTask = (v: any) => useAppStore.getState().setField("editTask", v);
  const setDragId = (v: any) => useAppStore.getState().setField("dragId", v);
  const setDragOverId = (v: any) => useAppStore.getState().setField("dragOverId", v);
  const setCtxMenu = (v: any) => useAppStore.getState().setField("ctxMenu", v);
  const setEditCollKey = (v: any) => useAppStore.getState().setField("editCollKey", v);
  const setStatFilter = (v: any) => useAppStore.getState().setField("statFilter", v);
  const setShowAddTask = (v: boolean) => useAppStore.getState().setField("showAddTask", v);
  const setShowBrands = (v: boolean) => useAppStore.getState().setField("showBrands", v);
  const setShowSeasons = (v: boolean) => useAppStore.getState().setField("showSeasons", v);
  const setShowCustomers = (v: boolean) => useAppStore.getState().setField("showCustomers", v);
  const setShowOrderTypes = (v: boolean) => useAppStore.getState().setField("showOrderTypes", v);
  const setShowRoles = (v: boolean) => useAppStore.getState().setField("showRoles", v);
  const setShowGenders = (v: boolean) => useAppStore.getState().setField("showGenders", v);
  const setShowActivity = (v: boolean) => useAppStore.getState().setField("showActivity", v);
  const setShowTaskManager = (v: boolean) => useAppStore.getState().setField("showTaskManager", v);
  const orderTypes = useAppStore(s => s.orderTypes);
  const setOrderTypes = (v: any, skip = false) => { if (skip) useAppStore.setState({ orderTypes: typeof v === "function" ? v(useAppStore.getState().orderTypes) : v }); else useAppStore.getState().setRefData("order_types", "orderTypes", typeof v === "function" ? v(useAppStore.getState().orderTypes) : v); };
  const roles = useAppStore(s => s.roles);
  const setRoles = (v: any, skip = false) => { if (skip) useAppStore.setState({ roles: typeof v === "function" ? v(useAppStore.getState().roles) : v }); else useAppStore.getState().setRefData("roles", "roles", typeof v === "function" ? v(useAppStore.getState().roles) : v); };
  const genders = useAppStore(s => s.genders);
  const setGenders = (v: any, skip = false) => { if (skip) useAppStore.setState({ genders: typeof v === "function" ? v(useAppStore.getState().genders) : v }); else useAppStore.getState().setRefData("genders", "genders", typeof v === "function" ? v(useAppStore.getState().genders) : v); };
  const genderSizes = useAppStore(s => s.genderSizes);
  const setGenderSizes = (v: any, skip = false) => { if (skip) useAppStore.setState({ genderSizes: typeof v === "function" ? v(useAppStore.getState().genderSizes) : v }); else useAppStore.getState().setRefData("gender_sizes", "genderSizes", typeof v === "function" ? v(useAppStore.getState().genderSizes) : v); };
  const taskTemplates = useAppStore(s => s.taskTemplates);
  const setTaskTemplates = (v: any, skip = false) => { if (skip) useAppStore.setState({ taskTemplates: typeof v === "function" ? v(useAppStore.getState().taskTemplates) : v }); else useAppStore.getState().setRefData("task_templates", "taskTemplates", typeof v === "function" ? v(useAppStore.getState().taskTemplates) : v); };
  // ─── Undo stack (up to 4 entries) ───────────────────────────────────────────
  const undoStack = s.undoStack;
  const undoConfirm = s.undoConfirm;
  const miniCalDragOver = s.miniCalDragOver;
  const calViewYear = s.calViewYear;
  const calViewMonth = s.calViewMonth;
  const calDragOver = s.calDragOver;
  const teamsConfig = s.teamsConfig;
  const teamsToken = s.teamsToken;
  const showTeamsConfig = s.showTeamsConfig;
  const teamsTokenExpiry = s.teamsTokenExpiry;
  const showEmailConfig = s.showEmailConfig;
  const setUndoStack = (v: any) => { if (typeof v === "function") useAppStore.getState().setField("undoStack", v(s.undoStack)); else useAppStore.getState().setField("undoStack", v); };
  const setUndoConfirm = (v: any) => useAppStore.getState().setField("undoConfirm", v);
  const setMiniCalDragOver = (v: any) => useAppStore.getState().setField("miniCalDragOver", v);
  const setCalViewYear = (v: any) => { if (typeof v === "function") useAppStore.getState().setField("calViewYear", v(s.calViewYear)); else useAppStore.getState().setField("calViewYear", v); };
  const setCalViewMonth = (v: any) => { if (typeof v === "function") useAppStore.getState().setField("calViewMonth", v(s.calViewMonth)); else useAppStore.getState().setField("calViewMonth", v); };
  const setCalDragOver = (v: string | null) => useAppStore.getState().setField("calDragOver", v);
  const setTeamsConfig = (v: any) => useAppStore.getState().setField("teamsConfig", v);
  const setTeamsToken = (v: any) => useAppStore.getState().setField("teamsToken", v);
  const setShowTeamsConfig = (v: boolean) => useAppStore.getState().setField("showTeamsConfig", v);
  const setTeamsTokenExpiry = (v: any) => useAppStore.getState().setField("teamsTokenExpiry", v);
  const setShowEmailConfig = (v: boolean) => useAppStore.getState().setField("showEmailConfig", v);

  // Auto-restore Microsoft token from localStorage on startup (like PO WIP / Tech Pack)
  useEffect(() => {
    getMsAccessToken().then(t => {
      if (t) {
        const stored = loadMsTokens();
        setTeamsToken(t);
        if (stored?.expiresAt) setTeamsTokenExpiry(stored.expiresAt);
      }
    }).catch(e => console.error("[App] MS token restore failed:", e));
  }, []);

  // Override getBrand to use stateful brands
  const getBrandDyn = (id) =>
    brands.find((b) => b.id === id) || brands[0] || BRANDS[0];
  // Shadow the global getBrand with the stateful version for all inner components
  const getBrand = getBrandDyn;

  // ── Load all data from Supabase on startup ───────────────────────────────
  useEffect(() => { useAppStore.getState().loadAll(); }, []);

  // ── Realtime sync — Supabase websocket subscriptions for multi-user updates ──
  useEffect(() => {
    if (!currentUser || !dbxLoaded) return;

    // Debounce app_data reloads — multiple rows may change in rapid succession
    let appDataTimer: ReturnType<typeof setTimeout> | null = null;
    const reloadAppData = () => {
      if (appDataTimer) clearTimeout(appDataTimer);
      appDataTimer = setTimeout(async () => {
        const refs = ["users","brands","seasons","customers","vendors","team","size_library","categories","order_types","roles","task_templates"];
        const setters = [setUsers, setBrands, setSeasons, setCustomers, setVendors, setTeam, setSizeLibrary, setCategoryLib, setOrderTypes, setRoles, setTaskTemplates];
        const vals = await Promise.all(refs.map(r => sbLoadSvc(r)));
        vals.forEach((val, i) => { if (val) (setters[i] as any)(val, true); });
      }, 300);
    };

    const channel = supabaseClient
      .channel("dc-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, async () => {
        const newTasks = await sbLoadTasksSvc();
        if (newTasks?.length) _setTasksRaw(newTasks);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "collections" }, async () => {
        const newColls = await sbLoadCollectionsSvc();
        if (newColls && Object.keys(newColls).length) _setCollRaw(newColls);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "app_data" }, reloadAppData)
      .subscribe();

    return () => {
      if (appDataTimer) clearTimeout(appDataTimer);
      supabaseClient.removeChannel(channel);
    };
  }, [currentUser, dbxLoaded]);

  // Load XLSX library dynamically
  useEffect(() => {
    if (window.XLSX) return;
    const s = document.createElement("script");
    s.src =
      "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    document.head.appendChild(s);
    return () => { document.head.removeChild(s); };
  }, []);

  // Close Teams view via X button
  useEffect(() => {
    const handler = () => setView("dashboard");
    window.addEventListener("closeTeamsView", handler);
    return () => window.removeEventListener("closeTeamsView", handler);
  }, []);

  useEffect(() => {
    const handler = () => setView("dashboard");
    window.addEventListener("closeEmailView", handler);
    return () => window.removeEventListener("closeEmailView", handler);
  }, []);

  // ── AUTO LOGOUT after 90 minutes of inactivity ──────────────────────────
  const idleWarning = s.idleWarning;
  const setIdleWarning = (v: boolean) => useAppStore.getState().setField("idleWarning", v);
  useIdleLogout({
    enabled: !!currentUser,
    idleMs: 90 * 60 * 1000,
    onWarning: setIdleWarning,
    onLogout: () => {
      sessionStorage.removeItem("plm_user");
      setCurrentUser(null);
      setIdleWarning(false);
      setTeamsToken(null);
      setView("dashboard");
    },
  });



  // TaskCard extracted to src/components/TaskCard.tsx — reads from Zustand store directly

  if (!dbxLoaded)
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", background: "#0F172A", gap: 16 }}>
        <div style={{ fontSize: 32 }}>🔄</div>
        <div style={{ color: "#fff", fontSize: 16, fontWeight: 600 }}>Loading from Supabase…</div>
        <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 12 }}>Syncing your data</div>
      </div>
    );

  if (!currentUser) {
    // No active session — send back to PLM launcher to log in
    window.location.replace("/");
    return null;
  }

  const isAdmin = currentUser.role === "admin";
  const canViewAll = isAdmin || currentUser.permissions?.view_all;

  // Filter tasks based on permissions
  const visibleTasks = canViewAll
    ? tasks
    : tasks.filter((t) => t.assigneeId === currentUser.teamMemberId);
  const filtered = visibleTasks.filter((t) => {
    const collKey = `${t.brand}||${t.collection}`;
    const coll = collections[collKey] || {};
    return (
      (filterBrand.size === 0 || filterBrand.has(t.brand)) &&
      (filterSeason.size === 0 || filterSeason.has(t.season)) &&
      (filterCustomer.size === 0 || filterCustomer.has(coll.customer || "")) &&
      (filterVendor.size === 0 || filterVendor.has(t.vendorName || ""))
    );
  });
  const overdue = filtered.filter(
    (t) => getDaysUntil(t.due) < 0 && t.status !== "Complete"
  );
  const dueThisWeek = filtered.filter((t) => {
    const d = getDaysUntil(t.due);
    return d >= 0 && d <= 7 && t.status !== "Complete";
  });
  const due30 = filtered.filter((t) => {
    const d = getDaysUntil(t.due);
    return d > 7 && d <= 30 && t.status !== "Complete";
  });


  type CollGroup = { brand: string; collection: string; season: string; category: string; vendorName: string; tasks: any[]; key: string };
  const collMap: Record<string, CollGroup> = {};
  tasks.forEach((t) => {
    const k = `${t.brand}||${t.collection}`;
    if (!collMap[k])
      collMap[k] = {
        brand: t.brand,
        collection: t.collection,
        season: t.season,
        category: t.category,
        vendorName: t.vendorName,
        tasks: [],
        key: k,
      };
    collMap[k].tasks.push(t);
  });
  const collList = Object.values(collMap).filter((c) => {
    const collKey = `${c.brand}||${c.collection}`;
    const coll = collections[collKey] || {};
    return (
      (filterBrand.size === 0 || filterBrand.has(c.brand)) &&
      (filterSeason.size === 0 || filterSeason.has(c.season)) &&
      (filterCustomer.size === 0 || filterCustomer.has(coll.customer || "")) &&
      (filterVendor.size === 0 || filterVendor.has(c.vendorName || ""))
    );
  });
  const allCustomers = [
    ...new Set(
      Object.values(collections)
        .map((c) => c.customer)
        .filter(Boolean)
    ),
  ];

  const navBtn = (id, label) => {
    const isTeams = id === "teams";
    const isActive = view === id;
    const activeBg = isTeams
      ? `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`
      : `linear-gradient(135deg,${TH.primary},${TH.primaryLt})`;
    const activeBorder = isTeams ? "rgba(123,131,235,0.5)" : "rgba(255,255,255,0.35)";
    return (
      <button
        key={id}
        onClick={() => {
          setView(id);
          setStatFilter(null);
          if (id !== "dashboard") setFocusCollKey(null);
        }}
        style={{
          padding: "7px 12px",
          borderRadius: 8,
          border: `1px solid ${isActive ? activeBorder : "rgba(255,255,255,0.15)"}`,
          cursor: "pointer",
          background: isActive ? activeBg : "none",
          color: isActive ? "#fff" : isTeams ? "rgba(123,131,235,0.9)" : "rgba(255,255,255,0.7)",
          fontWeight: isActive ? 700 : 600,
          fontFamily: "inherit",
          fontSize: 12,
          transition: "all 0.2s",
        }}
      >
        {label}
      </button>
    );
  };
  const pill = (cur, setPill, val, label, color) => (
    <button
      key={val}
      onClick={() => setPill(val)}
      style={{
        padding: "5px 12px",
        borderRadius: 20,
        border: `1px solid ${cur === val ? color || TH.primary : TH.border}`,
        background:
          cur === val
            ? color
              ? color + "22"
              : TH.primary + "15"
            : "transparent",
        color: cur === val ? color || TH.primary : TH.textMuted,
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: 12,
        whiteSpace: "nowrap",
        transition: "all 0.15s",
      }}
    >
      {label}
    </button>
  );




  const dashboardCtx = { TaskCard };


  return (
    <div
      style={{
        minHeight: "100vh",
        background: TH.bg,
        fontFamily: "'DM Sans','Helvetica Neue',sans-serif",
        color: TH.text,
      }}
    >
      {confirmState && <ConfirmModal title="Are you sure?" message={confirmState.message} confirmLabel={confirmState.action} danger onConfirm={() => { confirmState.onConfirm(); setConfirmState(null); }} onCancel={() => setConfirmState(null)} />}
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;}::-webkit-scrollbar{width:10px;height:10px;}::-webkit-scrollbar-track{background:#E2E8EE;border-radius:5px;}::-webkit-scrollbar-thumb{background:#CBD5E0;border-radius:5px;}::-webkit-scrollbar-thumb:hover{background:#A0AEC0;}select option{background:#FFFFFF;color:#1A202C;}`}</style>

      {/* ── SAVE ERROR TOAST ── */}
      {saveErr && (
        <div style={{
          position: "fixed", bottom: 24, right: 24, zIndex: 9999,
          background: "#C53030", color: "#fff",
          padding: "12px 18px", borderRadius: 10,
          boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
          fontSize: 14, maxWidth: 360,
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <span>⚠</span>
          <span>{saveErr}</span>
          <button onClick={() => setSaveErr("")} style={{ marginLeft: "auto", background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 16, lineHeight: 1 }}>×</button>
        </div>
      )}

      {/* ── IDLE WARNING BANNER ── */}
      {idleWarning && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 9999,
          background: "linear-gradient(135deg,#B45309,#D97706)",
          color: "#fff",
          padding: "10px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          boxShadow: "0 2px 16px rgba(0,0,0,0.35)",
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: "0.01em",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>⏱</span>
            <span>You've been inactive for 55 minutes. You'll be automatically logged out in 5 minutes.</span>
          </div>
          <button
            onClick={() => setIdleWarning(false)}
            style={{ padding: "6px 16px", borderRadius: 7, border: "1px solid rgba(255,255,255,0.4)", background: "rgba(255,255,255,0.15)", color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}
          >
            I'm still here
          </button>
        </div>
      )}

      {/* Header */}
      <div
        style={{
          background: TH.header,
          padding: "0 22px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 64,
          position: "sticky",
          top: 0,
          zIndex: 100,
          gap: 12,
          boxShadow: "0 2px 16px rgba(0,0,0,0.25)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            flexShrink: 0,
          }}
        >
          <ROFLogoFull height={40} />
          <div
            style={{
              width: 1,
              height: 30,
              background: "rgba(255,255,255,0.15)",
            }}
          />
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "rgba(255,255,255,0.75)",
                letterSpacing: "0.12em",
                textTransform: "uppercase",
              }}
            >
              Design Calendar
            </div>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
          }}
        >
          {[["dashboard","Dashboard"],["timeline","Timeline"],["calendar","Calendar"]].map(([v,label]) =>
            navBtn(v, label)
          )}
          {currentUser && (
            <a
              href="/tanda"
              style={{
                padding: "7px 12px", borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.15)",
                color: "rgba(255,255,255,0.7)", fontWeight: 600,
                fontFamily: "inherit", fontSize: 12,
                textDecoration: "none", whiteSpace: "nowrap",
                transition: "all 0.2s",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.1)")}
              onMouseLeave={e => (e.currentTarget.style.background = "none")}
            >
              T&A
            </a>
          )}
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            flexShrink: 0,
            alignItems: "center",
          }}
        >
          {/* Undo button — always visible, disabled when nothing to undo */}
          <button
            onClick={useAppStore.getState().handleUndo}
            disabled={undoStack.length === 0}
            title={undoStack.length > 0 ? `Undo last change (${undoStack.length} available)` : "Nothing to undo"}
            style={{ padding: "7px 13px", borderRadius: 8, border: `1px solid ${undoStack.length > 0 ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.12)"}`, background: undoStack.length > 0 ? "rgba(255,255,255,0.12)" : "transparent", color: undoStack.length > 0 ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.3)", fontWeight: 600, cursor: undoStack.length > 0 ? "pointer" : "default", fontFamily: "inherit", fontSize: 12, display: "flex", alignItems: "center", gap: 5, transition: "all 0.15s" }}
          >
            ↩ Undo{undoStack.length > 1 ? ` (${undoStack.length})` : ""}
          </button>
          {/* List view toggle — shown for dashboard and timeline */}
          {(view === "dashboard" || view === "timeline") && (
            <div style={{ display: "flex", gap: 2, background: "rgba(255,255,255,0.08)", borderRadius: 8, padding: "3px", border: "1px solid rgba(255,255,255,0.15)" }}>
              {[["⊞", false, "Grid view"], ["☰", true, "List view"]].map(([icon, isListMode, title]) => (
                <button key={String(isListMode)} title={title as string} onClick={() => setListView(isListMode as boolean)}
                  style={{ padding: "4px 10px", borderRadius: 6, border: "none", background: listView === isListMode ? "rgba(255,255,255,0.18)" : "none", color: listView === isListMode ? "#fff" : "rgba(255,255,255,0.55)", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600, transition: "all 0.15s" }}>
                  {icon}
                </button>
              ))}
            </div>
          )}
          {/* Activity log button */}
          <button
            onClick={() => setShowActivity(!showActivity)}
            title="Activity Log"
            style={{ padding: "7px 13px", borderRadius: 8, border: `1px solid ${showActivity ? TH.primary : "rgba(255,255,255,0.15)"}`, background: showActivity ? TH.primary + "33" : "none", color: showActivity ? "#fff" : "rgba(255,255,255,0.8)", fontWeight: 600, cursor: "pointer", fontFamily: "inherit", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
            📋 Activity
          </button>
          {/* Settings master dropdown */}
          <SettingsDropdown
            isAdmin={isAdmin}
            onTeam={() => setShowTeam(true)}
            onVendors={() => setShowVendors(true)}
            onSizes={() => setShowSizeLib(true)}
            onCategories={() => setShowCatLib(true)}
            onUsers={() => setShowUsers(true)}
            onBrands={() => setShowBrands(true)}
            onSeasons={() => setShowSeasons(true)}
            onCustomers={() => setShowCustomers(true)}
            onPOTypes={() => setShowOrderTypes(true)}
            onRoles={() => setShowRoles(true)}
            onTasks={() => setShowTaskManager(true)}
            onGenders={() => setShowGenders(true)}
          />
          <div
            style={{
              width: 1,
              height: 24,
              background: "rgba(255,255,255,0.15)",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Avatar member={currentUser} size={30} />
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span
                style={{
                  fontSize: 12,
                  color: "rgba(255,255,255,0.85)",
                  fontWeight: 600,
                  lineHeight: 1.2,
                }}
              >
                {currentUser.name}
              </span>
              {teamsToken && (
                <span style={{ fontSize: 9, color: "#6EE7B7", fontWeight: 700, display: "flex", alignItems: "center", gap: 3 }}>
                  💬 Teams
                </span>
              )}
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
                {currentUser.role}
              </span>
            </div>
            <button
              onClick={() => window.location.href = "/"}
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.15)",
                background: "none",
                color: "rgba(255,255,255,0.5)",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 11,
              }}
            >
              ← PLM
            </button>
            <button
              onClick={() => { sessionStorage.removeItem("plm_user"); window.location.href = "/"; }}
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.15)",
                background: "none",
                color: "rgba(255,255,255,0.5)",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 11,
              }}
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>

      {/* Filter bar — only on views where it applies */}
      {["dashboard", "timeline", "calendar"].includes(view) && <FilterBar
        brands={brands}
        seasons={seasons}
        customers={customers}
        vendors={vendors}
        filterBrand={filterBrand}
        setFilterBrand={setFilterBrand}
        filterSeason={filterSeason}
        setFilterSeason={setFilterSeason}
        filterCustomer={filterCustomer}
        setFilterCustomer={setFilterCustomer}
        filterVendor={filterVendor}
        setFilterVendor={setFilterVendor}
        canViewAll={canViewAll}
      />}

      <div
        style={{ padding: "26px 22px 100px", maxWidth: 1440, margin: "0 auto" }}
      >
        {view === "dashboard" && <DashboardPanel ctx={dashboardCtx} />}
        {view === "timeline" && <TimelinePanel />}
        {view === "calendar" && <CalendarPanel />}
        {view === "teams" && (
          <Suspense fallback={<div style={{ textAlign: "center", padding: 40, color: "rgba(255,255,255,0.5)" }}>Loading Teams…</div>}>
          <TeamsView
            collList={collList}
            collMap={collMap}
            isAdmin={isAdmin}
            teamsToken={teamsToken}
            setTeamsToken={setTeamsToken}
            getBrand={getBrand}
            currentUser={currentUser}
          />
          </Suspense>
        )}
        {view === "email" && (
          <Suspense fallback={<div style={{ textAlign: "center", padding: 40, color: "rgba(255,255,255,0.5)" }}>Loading Email…</div>}>
          <OutlookView
            collList={collList}
            collMap={collMap}
            collections={collections}
            isAdmin={isAdmin}
            teamsConfig={teamsConfig}
            setTeamsConfig={setTeamsConfig}
            teamsToken={teamsToken}
            setTeamsToken={setTeamsToken}
            teamsTokenExpiry={teamsTokenExpiry}
            setTeamsTokenExpiry={setTeamsTokenExpiry}
            showEmailConfig={showEmailConfig}
            setShowEmailConfig={setShowEmailConfig}
            getBrand={getBrand}
          />
          </Suspense>
        )}
      </div>

      {showAddTask && (
        <AddTaskModal
          tasks={tasks}
          vendors={vendors}
          team={team}
          collections={collections}
          onSave={(newTask) => {
            const taskWithHistory = {
              ...newTask,
              history: [...(newTask.history || []), {
                id: `${Date.now()}-task-create`,
                field: "task created",
                from: null,
                to: newTask.phase,
                changedBy: currentUser?.name || "Unknown",
                at: new Date().toISOString(),
              }],
            };
            setTasks((ts) => [...ts, taskWithHistory]);
            setShowAddTask(false);
          }}
          onClose={() => setShowAddTask(false)}
        />
      )}

      {showWizard && (
        <Modal title="New Collection" onClose={() => setShowWizard(false)} wide>
          <CollectionWizard onClose={() => setShowWizard(false)} />
        </Modal>
      )}
      {showVendors && (
        <Modal
          title="Vendor Manager"
          onClose={() => setShowVendors(false)}
          wide
        >
          <VendorManager vendors={vendors} setVendors={setVendors} isAdmin={isAdmin} taskTemplates={taskTemplates} />
        </Modal>
      )}
      {showTeam && (
        <Modal title="Team Members" onClose={() => setShowTeam(false)} wide>
          <TeamManager team={team} setTeam={setTeam} users={users} setUsers={setUsers} isAdmin={isAdmin} roles={roles} setRoles={setRoles} />
        </Modal>
      )}
      {showUsers && (
        <Modal title="User Management" onClose={() => setShowUsers(false)} wide>
          <UserManager users={users} setUsers={setUsers} team={team} setTeam={setTeam} isAdmin={isAdmin} currentUser={currentUser}  roles={roles} setRoles={setRoles} />
        </Modal>
      )}
      {showCustomers && (
        <Modal title="Customer Manager" onClose={() => setShowCustomers(false)} wide>
          <CustomerManager customers={customers} setCustomers={setCustomers} isAdmin={isAdmin} />
        </Modal>
      )}
      {showOrderTypes && (
        <Modal title="Order Types" onClose={() => setShowOrderTypes(false)} wide>
          <OrderTypeManager orderTypes={orderTypes} setOrderTypes={setOrderTypes} isAdmin={isAdmin} />
        </Modal>
      )}
      {showTaskManager && (
        <Modal title="Task Manager" onClose={() => setShowTaskManager(false)} wide>
          <TaskManager
            taskTemplates={taskTemplates}
            setTaskTemplates={setTaskTemplates}
            isAdmin={isAdmin}
            vendors={vendors}
            setVendors={setVendors}
          />
        </Modal>
      )}
      {showRoles && (
        <Modal title="Role Manager" onClose={() => setShowRoles(false)} wide>
          <RoleManager roles={roles} setRoles={setRoles} isAdmin={isAdmin} />
        </Modal>
      )}
      {showGenders && (
        <Modal title="Gender Manager" onClose={() => setShowGenders(false)} wide>
          <GenderManager genders={genders} setGenders={setGenders} genderSizes={genderSizes} setGenderSizes={setGenderSizes} sizes={sizeLibrary} setSizes={setSizeLibrary} isAdmin={isAdmin} />
        </Modal>
      )}
      {showActivity && (
        <Suspense fallback={null}>
          <ActivityPanel
            tasks={tasks}
            globalLog={globalLog}
            currentUser={currentUser}
            isAdmin={isAdmin}
            team={team}
            onClose={() => setShowActivity(false)}
          />
        </Suspense>
      )}
      {showSeasons && (
        <Modal title="Season Manager" onClose={() => setShowSeasons(false)} wide>
          <SeasonManager seasons={seasons} setSeasons={setSeasons} isAdmin={isAdmin} />
        </Modal>
      )}
      {showBrands && (
        <Modal title="Brand Manager" onClose={() => setShowBrands(false)} wide>
          <BrandManager brands={brands} setBrands={setBrands} isAdmin={isAdmin} />
        </Modal>
      )}
      {showSizeLib && (
        <Modal title="Size Library" onClose={() => setShowSizeLib(false)} wide>
          <SizeLibrary sizes={sizeLibrary} setSizes={setSizeLibrary} isAdmin={isAdmin} genders={genders} genderSizes={genderSizes} setGenderSizes={setGenderSizes} />
        </Modal>
      )}
      {showCatLib && (
        <Modal
          title="Category Manager"
          onClose={() => setShowCatLib(false)}
          wide
        >
          <CategoryManager
            categories={categoryLib}
            setCategories={setCategoryLib}
            isAdmin={isAdmin}
          />
        </Modal>
      )}
      {editTask && (
        <TaskEditModal
          onUndoConfirm={(confirmed) => {
            if (confirmed && undoConfirm) {
              setTasks(undoConfirm.prevTasks);
              undoConfirm.prevTasks.forEach((t: any) => sbSaveTaskSvc(t, currentUser?.name || ""));
            }
            setUndoConfirm(null);
            setEditTask(null);
          }}
          onSkuChange={(key, newSkus) =>
            setCollections((c) => ({
              ...c,
              [key]: { ...(c[key] || {}), skus: newSkus },
            }))
          }
        />
      )}
      {editCollKey && (
        <EditCollectionModal
          onLogActivity={(entries) => setGlobalLog(gl => [...gl, ...entries])}
          onClose={() => setEditCollKey(null)}
        />
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            ...(isAdmin
              ? [
                  {
                    icon: "✏️",
                    label: "Edit Collection",
                    onClick: () => setEditCollKey(ctxMenu.collKey),
                  },
                  "---",
                ]
              : []),
            {
              icon: "📊",
              label: "Open Timeline",
              onClick: () => {
                setFocusCollKey(ctxMenu.collKey);
                setView("timeline");
              },
            },
            {
              icon: "📅",
              label: "Open Calendar",
              onClick: () => {
                setFocusCollKey(ctxMenu.collKey);
                setView("calendar");
              },
            },
            ...(isAdmin
              ? [
                  "---",
                  {
                    icon: "🗑️",
                    label: "Delete Collection",
                    danger: true,
                    onClick: () => {
                      setPendingDeleteColl(ctxMenu.collKey);
                      setCtxMenu(null);
                    },
                  },
                ]
              : []),
          ]}
        />
      )}

      {/* ── DELETE COLLECTION CONFIRMATION ── */}
      {pendingDeleteColl && (
        <ConfirmModal
          title="Delete Collection"
          message={`Are you sure you want to delete "${pendingDeleteColl.split("||")[1]}"? This will permanently remove all tasks in this collection and cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            const [brand, coll] = pendingDeleteColl.split("||");
            setGlobalLog(gl => [...gl, {
              id: `${Date.now()}-coll-del`,
              field: "collection deleted",
              from: coll,
              to: null,
              changedBy: currentUser?.name || "Unknown",
              at: new Date().toISOString(),
              taskCollection: coll,
              taskBrand: brand,
            }]);
            setTasks(ts => ts.filter(t => !(t.brand === brand && t.collection === coll)));
            setCollections(c => { const n = { ...c }; delete n[pendingDeleteColl]; return n; });
            setPendingDeleteColl(null);
          }}
          onCancel={() => setPendingDeleteColl(null)}
        />
      )}

      {/* ── BOTTOM NAV TOGGLE TAB ── */}
      <button
        onClick={() => setShowNav(!showNav)}
        style={{
          position: "fixed",
          bottom: showNav ? 66 : 0,
          right: 24,
          zIndex: 201,
          background: "linear-gradient(135deg,#2D3748,#1A202C)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderBottom: "none",
          borderRadius: "8px 8px 0 0",
          padding: "4px 14px",
          cursor: "pointer",
          fontFamily: "inherit",
          display: "flex",
          alignItems: "center",
          gap: 6,
          transition: "bottom 0.3s ease",
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: "rgba(255,255,255,0.5)",
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          {showNav ? "Hide" : "Show"} Nav
        </span>
        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
          {showNav ? "▼" : "▲"}
        </span>
      </button>

      {/* ── BOTTOM NAV BAR ── */}
      <div
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 200,
          background:
            "linear-gradient(135deg,#1A202C 0%,#2D3748 60%,#1E2A3A 100%)",
          borderTop: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 -4px 24px rgba(0,0,0,0.35)",
          display: "flex",
          alignItems: "stretch",
          height: 66,
          backdropFilter: "blur(12px)",
          transition: "transform 0.3s ease",
          transform: showNav ? "translateY(0)" : "translateY(100%)",
        }}
      >
        {/* Left: New Collection button */}
        {isAdmin && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              paddingLeft: 16,
              paddingRight: 8,
              borderRight: "1px solid rgba(255,255,255,0.06)",
              gap: 8,
            }}
          >
            <button
              onClick={() => setShowWizard(true)}
              style={{
                padding: "7px 14px",
                borderRadius: 8,
                border: "none",
                background: `linear-gradient(135deg,${TH.primary},${TH.primaryLt})`,
                color: "#fff",
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 12,
                whiteSpace: "nowrap",
                boxShadow: `0 2px 10px ${TH.primary}66`,
              }}
            >
              + New Collection
            </button>
            {view === "timeline" && (
              <button
                onClick={() => setShowAddTask(true)}
                title="Add Task to Timeline"
                style={{
                  padding: "7px 14px",
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.18)",
                  background: "rgba(255,255,255,0.07)",
                  color: "rgba(255,255,255,0.8)",
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 12,
                  whiteSpace: "nowrap",
                }}
              >
                + Add Task
              </button>
            )}
          </div>
        )}
        {/* Center: quick stats — clickable */}
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 0,
          }}
        >
          {[
            {
              id: "overdue",
              label: "Overdue",
              count: overdue.length,
              color: "#FC8181",
              bg: "rgba(252,129,129,0.12)",
              activeBg: "rgba(252,129,129,0.22)",
            },
            {
              id: "week",
              label: "This Week",
              count: dueThisWeek.length,
              color: "#F6AD55",
              bg: "rgba(246,173,85,0.12)",
              activeBg: "rgba(246,173,85,0.22)",
            },
            {
              id: "30d",
              label: "Next 30d",
              count: due30.length,
              color: "#63B3ED",
              bg: "rgba(99,179,237,0.12)",
              activeBg: "rgba(99,179,237,0.22)",
            },
            {
              id: "collections",
              label: "Collections",
              count: collList.length,
              color: "#68D391",
              bg: "rgba(104,211,145,0.12)",
              activeBg: "rgba(104,211,145,0.22)",
            },
          ].map((s, i) => {
            const isActive = statFilter === s.id;
            return (
              <button
                key={s.id}
                onClick={() => {
                  setStatFilter(isActive ? null : s.id);
                  setView("dashboard");
                  setFocusCollKey(null);
                }}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  padding: "6px 19px",
                  borderRight:
                    i < 3 ? "1px solid rgba(255,255,255,0.06)" : "none",
                  background: isActive ? s.activeBg : "transparent",
                  cursor: "pointer",
                  border: "none",
                  fontFamily: "inherit",
                  borderRadius: 8,
                  transition: "all 0.15s",
                  transform: isActive ? "translateY(-1px)" : "none",
                  outline: isActive ? `1px solid ${s.color}44` : "none",
                }}
              >
                <div
                  style={{
                    fontSize: 19,
                    fontWeight: 800,
                    color: s.color,
                    lineHeight: 1,
                    background: s.bg,
                    borderRadius: 6,
                    padding: "2px 8px",
                    minWidth: 31,
                    textAlign: "center",
                    boxShadow: isActive ? `0 0 8px ${s.color}55` : "none",
                    transition: "all 0.15s",
                  }}
                >
                  {s.count}
                </div>
                <div
                  style={{
                    fontSize: 8,
                    color: isActive ? s.color : "rgba(255,255,255,0.4)",
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    marginTop: 3,
                    fontWeight: isActive ? 700 : 600,
                  }}
                >
                  {s.label}
                </div>
                {isActive && (
                  <div
                    style={{
                      width: 13,
                      height: 1.5,
                      borderRadius: 1,
                      background: s.color,
                      marginTop: 2,
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>
        {/* Right: Teams button */}
        <div style={{ display: "flex", alignItems: "center", paddingLeft: 8, paddingRight: 16, borderLeft: "1px solid rgba(255,255,255,0.06)" }}>
          <button
            onClick={() => { setView(view === "teams" ? "dashboard" : "teams"); setStatFilter(null); setFocusCollKey(null); }}
            style={{
              padding: "7px 14px",
              borderRadius: 8,
              border: `1px solid ${view === "teams" ? "rgba(123,131,235,0.5)" : "rgba(255,255,255,0.15)"}`,
              cursor: "pointer",
              background: view === "teams" ? `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})` : "none",
              color: view === "teams" ? "#fff" : "rgba(123,131,235,0.9)",
              fontWeight: view === "teams" ? 700 : 600,
              fontFamily: "inherit",
              fontSize: 12,
              whiteSpace: "nowrap",
              transition: "all 0.2s",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ fontSize: 14 }}>💬</span>
            Teams
          </button>
          <button
            onClick={() => { setView(view === "email" ? "dashboard" : "email"); setStatFilter(null); setFocusCollKey(null); }}
            style={{
              padding: "7px 14px",
              borderRadius: 8,
              border: `1px solid ${view === "email" ? "rgba(0,120,212,0.5)" : "rgba(255,255,255,0.15)"}`,
              cursor: "pointer",
              background: view === "email" ? `linear-gradient(135deg,${OUTLOOK_BLUE},${OUTLOOK_BLUE_LT})` : "none",
              color: view === "email" ? "#fff" : "rgba(0,120,212,0.9)",
              fontWeight: view === "email" ? 700 : 600,
              fontFamily: "inherit",
              fontSize: 12,
              whiteSpace: "nowrap",
              transition: "all 0.2s",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ fontSize: 14 }}>📧</span>
            Email
          </button>
        </div>
      </div>
      {supabaseClient && currentUser && (
        <NotificationsShell
          kind="internal"
          supabase={supabaseClient}
          userId={currentUser.id}
          sessionKey="rof_notif_dismissed_internal"
        />
      )}
    </div>
  );
}
