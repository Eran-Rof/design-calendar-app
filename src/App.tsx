import { useState, useRef, useEffect, Fragment } from "react";
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
import ActivityPanel from "./components/ActivityPanel";
import SettingsDropdown from "./components/SettingsDropdown";
import CollectionWizard from "./components/CollectionWizard";
import TaskEditModal from "./components/TaskEditModal";
import AddTaskModal from "./components/AddTaskModal";
import EditCollectionModal from "./components/EditCollectionModal";
import FilterBar from "./components/FilterBar";
import TeamsView from "./components/TeamsView";
import OutlookView from "./components/OutlookView";
import CategoryManager from "./components/CategoryManager";
import SizeLibrary from "./components/SizeLibrary";
import TaskManager from "./components/TaskManager";
import TeamManager from "./components/TeamManager";
import UserManager from "./components/UserManager";
import VendorManager from "./components/VendorManager";
import BrandManager from "./components/BrandManager";
import SeasonManager from "./components/SeasonManager";
import CustomerManager from "./components/CustomerManager";
import OrderTypeManager from "./components/OrderTypeManager";
import RoleManager from "./components/RoleManager";
import GenderManager from "./components/GenderManager";
import { DCProvider, useDCState, useDCDispatch } from "./dc/state/DCContext";
import type { DCState } from "./dc/state/dcTypes";
import { dashboardPanel as dashboardPanelExtracted } from "./dc/dashboardPanel";
import { timelinePanel as timelinePanelExtracted } from "./dc/timelinePanel";
import { calendarPanel as calendarPanelExtracted } from "./dc/calendarPanel";

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

// usePersistSb must be defined outside App so React hooks rules are satisfied
// It references sbSave which is passed as a parameter
function usePersistSb(initial, sbKey, sbSaveFn) {
  const [val, setVal] = useState(initial);
  // Pass skipSave=true when hydrating from DB to avoid writing data straight back
  const setter = (updater, skipSave = false) => {
    setVal((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (sbSaveFn && !skipSave) sbSaveFn(sbKey, next);
      return next;
    });
  };
  return [val, setter];
}

export default function AppWrapper() {
  return <DCProvider><App /></DCProvider>;
}

function App() {
  const dc = useDCState();
  const dcD = useDCDispatch();
  const dcSet = <K extends keyof DCState>(field: K, value: DCState[K]) => dcD({ type: "SET", field, value });
  // ── Confirm modal state ────────────────────────────────────────────────
  const [confirmState, setConfirmState] = useState<{ message: string; action: string; onConfirm: () => void } | null>(null);
  setConfirmHandler((opts) => setConfirmState(opts));

  // ── Supabase persistence ─────────────────────────────────────────────────
  const saveErr = dc.saveErr;
  const setSaveErr = (v: string) => dcSet("saveErr", v);
  const saveErrTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showSaveErr(msg: string) {
    setSaveErr(msg);
    if (saveErrTimer.current) clearTimeout(saveErrTimer.current);
    saveErrTimer.current = setTimeout(() => setSaveErr(""), 5000);
  }

  // ── Key-value store for reference data (users, brands, vendors etc) ───────
  async function sbSave(key, value) {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/app_data`, {
        method: "POST",
        headers: {
          "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({ key, value: JSON.stringify(value) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch(e: any) {
      console.error("[SB] save error:", key, e);
      showSaveErr(`Failed to save "${key}": ${e?.message ?? e}`);
    }
  }

  async function sbLoad(key) {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.${key}&select=value`, {
        headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` },
      });
      if (!res.ok) return null;
      const rows = await res.json();
      return rows.length ? JSON.parse(rows[0].value) : null;
    } catch(e) { return null; }
  }

  // ── Individual row operations for tasks (fast upsert/delete) ─────────────
  async function sbSaveTask(task) {
    try {
      // Conflict check: fetch current server version
      const checkRes = await fetch(`${SB_URL}/rest/v1/tasks?id=eq.${task.id}&select=data`, {
        headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` },
      });
      if (checkRes.ok) {
        const rows = await checkRes.json();
        if (rows.length > 0) {
          const serverTask = rows[0].data;
          if (serverTask && serverTask.updatedAt && task.updatedAt && serverTask.updatedAt !== task.updatedAt && serverTask.updatedBy !== currentUser?.name) {
            console.warn(`[SB] Conflict on task ${task.id}: server=${serverTask.updatedAt} local=${task.updatedAt}`);
            // Last write wins but log it — the 10s poll will sync the latest version
          }
        }
      }
      // Save
      await fetch(`${SB_URL}/rest/v1/tasks`, {
        method: "POST",
        headers: {
          "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({ id: task.id, data: { ...task, updatedAt: new Date().toISOString(), updatedBy: currentUser?.name || "" } }),
      });
    } catch(e: any) { console.error("[SB] save task error:", e); showSaveErr(`Failed to save task: ${e?.message ?? e}`); }
  }

  async function sbDeleteTask(id) {
    try {
      await fetch(`${SB_URL}/rest/v1/tasks?id=eq.${id}`, {
        method: "DELETE",
        headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` },
      });
    } catch(e: any) { console.error("[SB] delete task error:", e); showSaveErr(`Failed to delete task: ${e?.message ?? e}`); }
  }

  async function sbLoadTasks() {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/tasks?select=data`, {
        headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` },
      });
      if (!res.ok) return null;
      const rows = await res.json();
      return rows.map(r => r.data);
    } catch(e) { return null; }
  }

  // ── Individual row operations for collections ─────────────────────────────
  async function sbSaveCollection(key, data) {
    try {
      await fetch(`${SB_URL}/rest/v1/collections`, {
        method: "POST",
        headers: {
          "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({ id: key, data: { ...data, _updatedAt: new Date().toISOString(), _updatedBy: currentUser?.name || "" } }),
      });
    } catch(e) { console.error("[SB] save collection error:", e); }
  }

  async function sbLoadCollections() {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/collections?select=id,data`, {
        headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` },
      });
      if (!res.ok) return null;
      const rows = await res.json();
      const obj = {};
      rows.forEach(r => { obj[r.id] = r.data; });
      return obj;
    } catch(e) { return null; }
  }

  const dbxLoaded = dc.dbxLoaded;
  const setDbxLoaded = (v: boolean) => dcSet("dbxLoaded", v);

  // usePersistSb defined outside App component below

  const [users, setUsers] = usePersistSb([], "users", sbSave);
  const [currentUser, setCurrentUser] = useState(() => {
    // Read PLM session synchronously so there's never a login-screen flash
    try {
      const plmUser = sessionStorage.getItem("plm_user");
      return plmUser ? JSON.parse(plmUser) : null;
    } catch { return null; }
  });
  const [brands, setBrands] = usePersistSb([], "brands", sbSave);
  const [seasons, setSeasons] = usePersistSb([], "seasons", sbSave);
  const [customers, setCustomers] = usePersistSb([], "customers", sbSave);
  const [vendors, setVendors] = usePersistSb([], "vendors", sbSave);
  const [team, setTeam] = usePersistSb([], "team", sbSave);
  const [tasks, _setTasksRaw] = useState([]);
  const setTasks = (updater) => {
    _setTasksRaw((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      // Save all changed/new tasks to Supabase individually
      if (Array.isArray(next) && Array.isArray(prev)) {
        next.forEach(t => {
          const old = prev.find(p => p.id === t.id);
          if (!old || JSON.stringify(old) !== JSON.stringify(t)) {
            sbSaveTask(t);
          }
        });
        // Delete removed tasks
        prev.forEach(t => {
          if (!next.find(n => n.id === t.id)) sbDeleteTask(t.id);
        });
      }
      return next;
    });
  };
  const [collections, _setCollRaw] = useState({});
  const setCollections = (updater) => {
    _setCollRaw((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      // Save each new/changed collection to Supabase
      Object.entries(next).forEach(([key, val]) => {
        const prevStr = JSON.stringify(prev[key] || {});
        const nextStr = JSON.stringify(val);
        if (prevStr !== nextStr) {
          sbSaveCollection(key, val);
        }
      });
      return next;
    });
  };
  // ── View/UI state → useDCState() + useDCDispatch() (see dc/state/) ──
  const view = dc.view;
  const listView = dc.listView;
  const expandedColl = dc.expandedColl;
  const filterBrand = dc.filterBrand;
  const filterSeason = dc.filterSeason;
  const filterCustomer = dc.filterCustomer;
  const filterVendor = dc.filterVendor;
  const focusCollKey = dc.focusCollKey;
  const pendingDeleteColl = dc.pendingDeleteColl;
  const timelineBackFilter = dc.timelineBackFilter;
  const globalLog = dc.globalLog;
  const showNav = dc.showNav;
  const showWizard = dc.showWizard;
  const showVendors = dc.showVendors;
  const showTeam = dc.showTeam;
  const showUsers = dc.showUsers;
  const showSizeLib = dc.showSizeLib;
  const showCatLib = dc.showCatLib;
  const setView = (v: string) => dcSet("view", v);
  const setListView = (v: boolean) => dcSet("listView", v);
  const setExpandedColl = (v: string | null) => dcSet("expandedColl", v);
  const setFilterBrand = (v: any) => { if (typeof v === "function") dcSet("filterBrand", v(dc.filterBrand)); else dcSet("filterBrand", v); };
  const setFilterSeason = (v: any) => { if (typeof v === "function") dcSet("filterSeason", v(dc.filterSeason)); else dcSet("filterSeason", v); };
  const setFilterCustomer = (v: any) => { if (typeof v === "function") dcSet("filterCustomer", v(dc.filterCustomer)); else dcSet("filterCustomer", v); };
  const setFilterVendor = (v: any) => { if (typeof v === "function") dcSet("filterVendor", v(dc.filterVendor)); else dcSet("filterVendor", v); };
  const setFocusCollKey = (v: any) => dcSet("focusCollKey", v);
  const setPendingDeleteColl = (v: string | null) => dcSet("pendingDeleteColl", v);
  const setTimelineBackFilter = (v: string | null) => dcSet("timelineBackFilter", v);
  const setGlobalLog = (v: any) => { if (typeof v === "function") dcSet("globalLog", v(dc.globalLog)); else dcSet("globalLog", v); };
  const setShowNav = (v: boolean) => dcSet("showNav", v);
  const setShowWizard = (v: boolean) => dcSet("showWizard", v);
  const setShowVendors = (v: boolean) => dcSet("showVendors", v);
  const setShowTeam = (v: boolean) => dcSet("showTeam", v);
  const setShowUsers = (v: boolean) => dcSet("showUsers", v);
  const setShowSizeLib = (v: boolean) => dcSet("showSizeLib", v);
  const setShowCatLib = (v: boolean) => dcSet("showCatLib", v);
  const [sizeLibrary, setSizeLibrary] = usePersistSb([], "size_library", sbSave);
  const [categoryLib, setCategoryLib] = usePersistSb([], "categories", sbSave);
  const editTask = dc.editTask;
  const dragId = dc.dragId;
  const dragOverId = dc.dragOverId;
  const ctxMenu = dc.ctxMenu;
  const editCollKey = dc.editCollKey;
  const statFilter = dc.statFilter;
  const showAddTask = dc.showAddTask;
  const showBrands = dc.showBrands;
  const showSeasons = dc.showSeasons;
  const showCustomers = dc.showCustomers;
  const showOrderTypes = dc.showOrderTypes;
  const showRoles = dc.showRoles;
  const showGenders = dc.showGenders;
  const showActivity = dc.showActivity;
  const showTaskManager = dc.showTaskManager;
  const setEditTask = (v: any) => dcSet("editTask", v);
  const setDragId = (v: any) => dcSet("dragId", v);
  const setDragOverId = (v: any) => dcSet("dragOverId", v);
  const setCtxMenu = (v: any) => dcSet("ctxMenu", v);
  const setEditCollKey = (v: any) => dcSet("editCollKey", v);
  const setStatFilter = (v: any) => dcSet("statFilter", v);
  const setShowAddTask = (v: boolean) => dcSet("showAddTask", v);
  const setShowBrands = (v: boolean) => dcSet("showBrands", v);
  const setShowSeasons = (v: boolean) => dcSet("showSeasons", v);
  const setShowCustomers = (v: boolean) => dcSet("showCustomers", v);
  const setShowOrderTypes = (v: boolean) => dcSet("showOrderTypes", v);
  const setShowRoles = (v: boolean) => dcSet("showRoles", v);
  const setShowGenders = (v: boolean) => dcSet("showGenders", v);
  const setShowActivity = (v: boolean) => dcSet("showActivity", v);
  const setShowTaskManager = (v: boolean) => dcSet("showTaskManager", v);
  const [orderTypes, setOrderTypes] = usePersistSb([], "order_types", sbSave);
  const [roles, setRoles] = usePersistSb([], "roles", sbSave);
  const [genders, setGenders] = usePersistSb(GENDERS, "genders", sbSave);
  const [genderSizes, setGenderSizes] = usePersistSb({}, "gender_sizes", sbSave);
  const [taskTemplates, setTaskTemplates] = usePersistSb([], "task_templates", sbSave);
  // ─── Undo stack (up to 4 entries) ───────────────────────────────────────────
  const undoStack = dc.undoStack;
  const undoConfirm = dc.undoConfirm;
  const miniCalDragOver = dc.miniCalDragOver;
  const calViewYear = dc.calViewYear;
  const calViewMonth = dc.calViewMonth;
  const calDragOver = dc.calDragOver;
  const teamsConfig = dc.teamsConfig;
  const teamsToken = dc.teamsToken;
  const showTeamsConfig = dc.showTeamsConfig;
  const teamsTokenExpiry = dc.teamsTokenExpiry;
  const showEmailConfig = dc.showEmailConfig;
  const setUndoStack = (v: any) => { if (typeof v === "function") dcSet("undoStack", v(dc.undoStack)); else dcSet("undoStack", v); };
  const setUndoConfirm = (v: any) => dcSet("undoConfirm", v);
  const setMiniCalDragOver = (v: any) => dcSet("miniCalDragOver", v);
  const setCalViewYear = (v: any) => { if (typeof v === "function") dcSet("calViewYear", v(dc.calViewYear)); else dcSet("calViewYear", v); };
  const setCalViewMonth = (v: any) => { if (typeof v === "function") dcSet("calViewMonth", v(dc.calViewMonth)); else dcSet("calViewMonth", v); };
  const setCalDragOver = (v: string | null) => dcSet("calDragOver", v);
  const setTeamsConfig = (v: any) => dcSet("teamsConfig", v);
  const setTeamsToken = (v: any) => dcSet("teamsToken", v);
  const setShowTeamsConfig = (v: boolean) => dcSet("showTeamsConfig", v);
  const setTeamsTokenExpiry = (v: any) => dcSet("teamsTokenExpiry", v);
  const setShowEmailConfig = (v: boolean) => dcSet("showEmailConfig", v);

  // Auto-restore Microsoft token from localStorage on startup (like PO WIP / Tech Pack)
  useEffect(() => {
    getMsAccessToken().then(t => {
      if (t) {
        const stored = loadMsTokens();
        setTeamsToken(t);
        if (stored?.expiresAt) setTeamsTokenExpiry(stored.expiresAt);
      }
    }).catch(() => {});
  }, []);

  // Override getBrand to use stateful brands
  const getBrandDyn = (id) =>
    brands.find((b) => b.id === id) || brands[0] || BRANDS[0];
  // Shadow the global getBrand with the stateful version for all inner components
  const getBrand = getBrandDyn;

  // ── Load all data from Supabase on startup ───────────────────────────────
  useEffect(() => {
    async function loadAll() {
      console.log("[SB] loadAll starting...");
      try {
        // Load reference data from key-value store + tasks/collections from individual rows
        const [
          users, brands, seasons, customers, vendors, team,
          sizes, categories, orderTypes, rolesData, taskTemplatesData,
          tasks, collections
        ] = await Promise.all([
          sbLoad("users"),
          sbLoad("brands"),
          sbLoad("seasons"),
          sbLoad("customers"),
          sbLoad("vendors"),
          sbLoad("team"),
          sbLoad("size_library"),
          sbLoad("categories"),
          sbLoad("order_types"),
          sbLoad("roles"),
          sbLoad("task_templates"),
          sbLoadTasks(),
          sbLoadCollections(),
        ]);

        if (users) setUsers(users, true);
        if (brands) setBrands(brands, true);
        if (seasons) setSeasons(seasons, true);
        if (customers) setCustomers(customers, true);
        if (vendors) setVendors(vendors, true);
        if (team) setTeam(team, true);
        if (sizes) setSizeLibrary(sizes, true);
        if (categories) setCategoryLib(categories, true);
        if (orderTypes) setOrderTypes(orderTypes, true);
        if (rolesData) setRoles(rolesData, true);
        if (taskTemplatesData) setTaskTemplates(taskTemplatesData, true);
        if (tasks?.length) _setTasksRaw(tasks);
        if (collections && Object.keys(collections).length) _setCollRaw(collections);

        console.log("[SB] loadAll complete");
      } catch(e) {
        console.error("[SB] loadAll error:", e);
      }
      setDbxLoaded(true);
    }
    loadAll();
  }, []);

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
        const vals = await Promise.all(refs.map(r => sbLoad(r)));
        vals.forEach((val, i) => { if (val) (setters[i] as any)(val, true); });
      }, 300);
    };

    const channel = supabaseClient
      .channel("dc-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, async () => {
        const newTasks = await sbLoadTasks();
        if (newTasks?.length) _setTasksRaw(newTasks);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "collections" }, async () => {
        const newColls = await sbLoadCollections();
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
  const IDLE_MS = 90 * 60 * 1000; // 90 minutes
  const idleWarning = dc.idleWarning;
  const setIdleWarning = (v: boolean) => dcSet("idleWarning", v);
  useEffect(() => {
    if (!currentUser) return;
    let warnTimer = null;
    let logoutTimer = null;

    function resetTimers() {
      setIdleWarning(false);
      clearTimeout(warnTimer);
      clearTimeout(logoutTimer);
      // Warn 5 minutes before logout (at 85 minutes)
      warnTimer = setTimeout(() => setIdleWarning(true), IDLE_MS - 5 * 60 * 1000);
      // Log out at 90 minutes
      logoutTimer = setTimeout(() => {
        sessionStorage.removeItem("plm_user");
        setCurrentUser(null);
        setIdleWarning(false);
        setTeamsToken(null);
        setView("dashboard");
      }, IDLE_MS);
    }

    const EVENTS = ["mousemove","mousedown","keydown","touchstart","scroll","click","wheel"];
    EVENTS.forEach(ev => window.addEventListener(ev, resetTimers, { passive: true }));
    resetTimers();

    return () => {
      clearTimeout(warnTimer);
      clearTimeout(logoutTimer);
      EVENTS.forEach(ev => window.removeEventListener(ev, resetTimers));
    };
  }, [currentUser]);



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

  function addCollection(newTasks, meta) {
    const key = `${newTasks[0].brand}||${newTasks[0].collection}`;
    // Each task keeps its own images — no spreading
    const conceptTask = newTasks.find((t) => t.phase === "Concept");
    const conceptImages = conceptTask?.images || [];
    const tasksWithImages = newTasks;
    setCollections((c) => ({
      ...c,
      [key]: {
        skus: [],
        conceptImages,
        customerShipDate: meta?.customerShipDate,
        cancelDate: meta?.cancelDate,
        customer: meta?.customer,
        orderType: meta?.orderType,
        channelType: meta?.channelType,
        gender: meta?.gender,
        year: meta?.year,
        sampleDueDate: meta?.sampleDueDate,
        availableSizes: meta?.availableSizes || sizeLibrary,
      },
    }));
    setTasks((ts) => [...ts, ...tasksWithImages]);
    setGlobalLog(gl => [...gl, {
      id: `${Date.now()}-coll-create`,
      field: "collection created",
      from: null,
      to: newTasks[0].collection,
      changedBy: currentUser?.name || "Unknown",
      at: new Date().toISOString(),
      taskCollection: newTasks[0].collection,
      taskBrand: newTasks[0].brand,
    }]);
    setShowWizard(false);
    setView("timeline");
  }

  // ─── Undo helpers ────────────────────────────────────────────────────────────
  function buildUndoDescription(oldTask: any, newTask: any): string {
    if (!oldTask || !newTask) return "";
    const parts: string[] = [];
    if (oldTask.status !== newTask.status) parts.push(`status: "${oldTask.status}" → "${newTask.status}"`);
    if (oldTask.assigneeId !== newTask.assigneeId) {
      const oldName = oldTask.assigneeName || oldTask.assigneeId || "unassigned";
      const newName = newTask.assigneeName || newTask.assigneeId || "unassigned";
      parts.push(`assignee: "${oldName}" → "${newName}"`);
    }
    if (oldTask.due !== newTask.due) parts.push(`due date: ${formatDate(oldTask.due)} → ${formatDate(newTask.due)}`);
    if (oldTask.vendorName !== newTask.vendorName) parts.push(`vendor: "${oldTask.vendorName}" → "${newTask.vendorName}"`);
    if (oldTask.category !== newTask.category) parts.push(`category: "${oldTask.category}" → "${newTask.category}"`);
    return parts.length > 0 ? parts.join(", ") : "card edited";
  }

  function pushUndo(prevTasksSnapshot: any[], type: 'card' | 'drag', taskId?: string, newTask?: any) {
    let description = "";
    if (type === 'card' && taskId && newTask) {
      const oldTask = prevTasksSnapshot.find((t: any) => t.id === taskId);
      description = buildUndoDescription(oldTask, newTask);
    } else if (type === 'drag') {
      description = "card position moved";
    }
    setUndoStack(prev => [{ prevTasks: prevTasksSnapshot, type, taskId, description }, ...prev].slice(0, 4));
  }

  function handleUndo() {
    if (undoStack.length === 0) return;
    const [entry, ...rest] = undoStack;
    setUndoStack(rest);
    if (entry.type === 'drag') {
      setTasks(entry.prevTasks);
      entry.prevTasks.forEach((t: any) => sbSaveTask(t));
    } else {
      // Card change: open the card and show confirm dialog
      setUndoConfirm({ prevTasks: entry.prevTasks, taskId: entry.taskId!, description: entry.description });
      const task = tasks.find((t: any) => t.id === entry.taskId);
      if (task) setEditTask(task);
    }
  }

  function saveTask(f) {
    pushUndo(tasks, 'card', f.id, f);
    const clean = { ...f };
    setTasks((ts) => ts.map((t) => (t.id === clean.id ? clean : t)));
    sbSaveTask(clean); // Fast individual row upsert
    setEditTask(null);
    setUndoConfirm(null);
  }
  function quietSaveTask(f) {
    // Save without closing modal (used by SKU and note auto-saves)
    const clean = { ...f };
    setTasks((ts) => ts.map((t) => (t.id === clean.id ? clean : t)));
    sbSaveTask(clean);
  }

  function saveCascade(updatedTasks) {
    pushUndo(tasks, 'drag');
    setTasks(updatedTasks);
    updatedTasks.forEach(t => sbSaveTask(t));
  }
  function deleteTask(id) {
    const dying = tasks.find(t => t.id === id);
    if (dying) {
      setGlobalLog(gl => [...gl, {
        id: `${Date.now()}-task-del`,
        field: "task deleted",
        from: dying.phase,
        to: null,
        changedBy: currentUser?.name || "Unknown",
        at: new Date().toISOString(),
        taskPhase: dying.phase,
        taskCollection: dying.collection,
        taskBrand: dying.brand,
      }]);
    }
    setTasks((ts) => ts.filter((t) => t.id !== id));
    sbDeleteTask(id); // Fast individual row delete
    setEditTask(null);
  }

  // Timeline drag: place dragged card at midpoint between its two neighbors
  function handleTimelineDrop(targetId, sortedCollTasks) {
    if (!dragId || dragId === targetId) return;
    pushUndo(tasks, 'drag');
    setTasks((ts) => {
      const dragged = ts.find((t) => t.id === dragId);
      if (!dragged) return ts;
      const targetIdx = sortedCollTasks.findIndex((t) => t.id === targetId);
      if (targetIdx < 0) return ts;
      const prev = sortedCollTasks[targetIdx - 1];
      const next = sortedCollTasks[targetIdx];
      let newDue;
      if (prev && next) {
        const prevMs = parseLocalDate(prev.due).getTime();
        const nextMs = parseLocalDate(next.due).getTime();
        const midMs = Math.round((prevMs + nextMs) / 2);
        const mid = new Date(midMs);
        const mm = String(mid.getMonth() + 1).padStart(2, "0");
        const dd = String(mid.getDate()).padStart(2, "0");
        newDue = `${mid.getFullYear()}-${mm}-${dd}`;
      } else if (!prev && next) {
        newDue = addDays(next.due, -1);
      } else if (prev && !next) {
        newDue = addDays(prev.due, 1);
      } else {
        newDue = dragged.due;
      }
      return ts.map((t) => (t.id === dragId ? { ...t, due: newDue } : t));
    });
    setDragId(null);
    setDragOverId(null);
  }

  // Dashboard card drag: swap dates
  function handleDrop(targetId) {
    if (!dragId || dragId === targetId) return;
    pushUndo(tasks, 'drag');
    setTasks((ts) => {
      const a = ts.find((t) => t.id === dragId),
        b = ts.find((t) => t.id === targetId);
      if (!a || !b) return ts;
      return ts.map((t) =>
        t.id === dragId
          ? { ...t, due: b.due }
          : t.id === targetId
          ? { ...t, due: a.due }
          : t
      );
    });
    setDragId(null);
    setDragOverId(null);
  }

  const collMap = {};
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

  const DAYS_OF_WEEK = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  const TaskCard = ({ task, showDayDate }) => {
    const brand = getBrand(task.brand) || { id: "unknown", name: "Unknown", color: "#6B7280" },
      days = getDaysUntil(task.due),
      sc = STATUS_CONFIG[task.status] || STATUS_CONFIG["Not Started"],
      isOver = days < 0 && task.status !== "Complete",
      assignee = team.find((m) => m.id === task.assigneeId) || null;
    const dueDate = parseLocalDate(task.due);
    const dayOfWeek = DAYS_OF_WEEK[dueDate.getDay()];
    const formattedDue = formatDate(task.due);
    return (
      <div
        draggable
        onDragStart={() => setDragId(task.id)}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOverId(task.id);
        }}
        onDrop={() => handleDrop(task.id)}
        onDragEnd={() => {
          setDragId(null);
          setDragOverId(null);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter") setEditTask(task); }}
        onClick={(e) => { e.stopPropagation(); setEditTask(task); }}
        style={{
          background: dragOverId === task.id ? TH.surfaceHi : TH.surface,
          border: `1px solid ${
            dragOverId === task.id ? brand.color + "88" : TH.border
          }`,
          borderLeft: `3px solid ${brand.color}`,
          borderRadius: 9,
          padding: "12px 14px",
          cursor: "pointer",
          transition: "all 0.15s",
          opacity: dragId === task.id ? 0.4 : 1,
          boxShadow: `0 1px 4px ${TH.shadow}`,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 5,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: TH.text }}>
            {task.phase}
          </span>
          <span
            style={{
              fontSize: 10,
              padding: "2px 8px",
              borderRadius: 10,
              background: sc.bg,
              color: sc.color,
              fontWeight: 600,
            }}
          >
            {task.status}
          </span>
        </div>
        <div style={{ fontSize: 11, color: TH.textMuted, marginBottom: 2 }}>
          {task.collection}
        </div>
        <div style={{ fontSize: 11, color: TH.textSub2, marginBottom: 6 }}>
          {task.category}
          {task.vendorName ? ` · ${task.vendorName}` : ""}
        </div>
        {task.customer && (
          <div
            style={{
              fontSize: 11,
              color: TH.primary,
              fontWeight: 600,
              marginBottom: 5,
            }}
          >
            {task.customer}
            {task.orderType ? ` · ${task.orderType}` : ""}
          </div>
        )}
        {showDayDate && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              marginBottom: 6,
              padding: "6px 10px",
              background: isOver
                ? "#FEF2F2"
                : days === 0
                ? "#FFFBEB"
                : "#F0FDF4",
              borderRadius: 7,
              border: `1px solid ${
                isOver ? "#FCA5A5" : days === 0 ? "#FCD34D" : "#BBF7D0"
              }`,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: TH.textMuted,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                Due
              </span>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: isOver
                    ? "#B91C1C"
                    : days === 0
                    ? "#B45309"
                    : "#065F46",
                }}
              >
                {isOver
                  ? `${Math.abs(days)}d overdue`
                  : days === 0
                  ? "Today"
                  : `In ${days}d`}
              </span>
            </div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: isOver ? "#B91C1C" : TH.text,
              }}
            >
              {dayOfWeek}, {formattedDue}
            </div>
          </div>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, color: brand.color, fontWeight: 700 }}>
              {brand.short}
            </span>
            {assignee && (
              <>
                <Avatar member={assignee} size={18} />
                <span style={{ fontSize: 10, color: TH.textMuted }}>
                  {assignee.name.split(" ")[0]}
                </span>
              </>
            )}
          </div>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: isOver ? "#B91C1C" : days <= 7 ? "#B45309" : "#047857",
            }}
          >
            {isOver
              ? `${Math.abs(days)}d over`
              : days === 0
              ? "Today"
              : `${days}d`}
          </span>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              console.log("[View Card] clicked:", task.id, task.phase);
              setEditTask(task);
            }}
            style={{ flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 600, color: TH.textSub, background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 6, cursor: "pointer", fontFamily: "inherit" }}
          >
            View Card
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              console.log("[View Timeline] clicked:", task.id, task.phase);
              setTimelineBackFilter(statFilter);
              setFocusCollKey(`${task.brand}||${task.collection}`);
              setView("timeline");
              setStatFilter(null);
            }}
            style={{ flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 600, color: TH.primary, background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6, cursor: "pointer", fontFamily: "inherit" }}
          >
            View Timeline →
          </button>
        </div>
      </div>
    );
  };

  const Dashboard = () => dashboardPanelExtracted({
    tasks, collections, view, setView, listView, expandedColl, setExpandedColl,
    focusCollKey, setFocusCollKey, statFilter, setStatFilter, setShowWizard,
    setEditTask, setCtxMenu, setDragId, dragId, miniCalDragOver, setMiniCalDragOver,
    isAdmin, team, TaskCard, setTasks, handleDrop, handleTimelineDrop, pushUndo,
    saveCascade, deleteTask, pendingDeleteColl, setPendingDeleteColl, addCollection,
    filterBrand, filterSeason, filterCustomer, filterVendor, brands, seasons,
    currentUser, canViewAll, showAddTask, setShowAddTask, editCollKey, setEditCollKey,
    globalLog, timelineBackFilter, setTimelineBackFilter,
    overdue, dueThisWeek, due30, collList, collMap, getBrand,
  });

  const Timeline = () => timelinePanelExtracted({
    tasks, collections, setView, focusCollKey, setFocusCollKey, setEditTask,
    timelineBackFilter, setTimelineBackFilter, expandedColl, setExpandedColl,
    dragId, setDragId, dragOverId, setDragOverId, setStatFilter, pushUndo, team,
    filtered, overdue, sbSaveTask, saveCascade, setTasks, isAdmin, canViewAll,
    currentUser, filterBrand, filterSeason, filterCustomer, filterVendor, collMap, collList, listView, getBrand,
  });

  // ── CALENDAR VIEW ──────────────────────────────────────────────────────────
  const CalendarView = () => calendarPanelExtracted({
    tasks, collections, setEditTask, calViewYear, setCalViewYear, calViewMonth,
    setCalViewMonth, calDragOver, setCalDragOver, focusCollKey, team,
    filtered, isAdmin, canViewAll, currentUser, filterBrand, filterSeason,
    filterCustomer, filterVendor, collMap, collList, dragId, setDragId, setFocusCollKey, setTasks, getBrand,
  });

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
          {currentUser?.apps?.tanda?.access && (
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
            onClick={handleUndo}
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
            onClick={() => setShowActivity(v => !v)}
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
            onOrderTypes={() => setShowOrderTypes(true)}
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
        style={{ padding: "26px 22px 100px", maxWidth: 1440, margin: "0 auto", position: "relative", zIndex: 1 }}
        onPointerDown={() => console.log("[CONTENT-WRAPPER] pointerdown")}
      >
        <button onClick={() => alert("Content wrapper click works!")} style={{ background: "red", color: "white", padding: "10px 20px", fontSize: 16, cursor: "pointer", marginBottom: 10, zIndex: 999, position: "relative" }}>DEBUG: Click me</button>
        {view === "dashboard" && Dashboard()}
        {view === "timeline" && Timeline()}
        {view === "calendar" && CalendarView()}
        {view === "teams" && (
          <TeamsView
            collList={collList}
            collMap={collMap}
            isAdmin={isAdmin}
            teamsToken={teamsToken}
            setTeamsToken={setTeamsToken}
            getBrand={getBrand}
            currentUser={currentUser}
          />
        )}
        {view === "email" && (
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
          <CollectionWizard
            orderTypes={orderTypes}
            vendors={vendors}
            team={team}
            customers={customers}
            seasons={seasons}
            taskTemplates={taskTemplates}
            genders={genders}
            genderSizes={genderSizes}
            onSave={addCollection}
            onClose={() => setShowWizard(false)}
          />
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
        <ActivityPanel
          tasks={tasks}
          globalLog={globalLog}
          currentUser={currentUser}
          isAdmin={isAdmin}
          team={team}
          onClose={() => setShowActivity(false)}
        />
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
          task={editTask}
          team={team}
          collections={collections}
          allTasks={tasks}
          vendors={vendors}
          onSave={saveTask}
          onQuietSave={quietSaveTask}
          onSaveCascade={saveCascade}
          onDelete={deleteTask}
          onClose={() => setEditTask(null)}
          currentUser={currentUser}
          customerList={customers}
          orderTypes={orderTypes}
          genders={genders}
          undoConfirm={undoConfirm}
          onUndoConfirm={(confirmed) => {
            if (confirmed && undoConfirm) {
              setTasks(undoConfirm.prevTasks);
              undoConfirm.prevTasks.forEach((t: any) => sbSaveTask(t));
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
          collKey={editCollKey}
          collMap={collMap}
          collections={collections}
          tasks={tasks}
          setTasks={setTasks}
          setCollections={setCollections}
          seasons={seasons}
          customerList={customers}
          orderTypes={orderTypes}
          brands={brands}
          genders={genders}
          categories={categoryLib}
          currentUser={currentUser}
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
        onClick={() => setShowNav((v) => !v)}
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
    </div>
  );
}
