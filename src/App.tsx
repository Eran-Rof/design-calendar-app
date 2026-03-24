import { useState, useRef, useEffect, Fragment } from "react";
import React from "react";

// ─── Utils ────────────────────────────────────────────────────────────────────
import { TH, TEAMS_PURPLE, OUTLOOK_BLUE, setConfirmHandler, appConfirm } from "./utils/theme";
import { STATUS_CONFIG, BRANDS, GENDERS, PHASE_KEYS } from "./utils/constants";
import { getBrand, formatDate, addDays, diffDays, parseLocalDate, getDaysUntil, diffDaysForPhase, getDaysUntilForPhase, snapToBusinessDay, toDateStr } from "./utils/dates";
import { fmtDays, ROFLogoFull, S } from "./utils/styles";

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

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

// usePersistSb must be defined outside App so React hooks rules are satisfied
// It references sbSave which is passed as a parameter
function usePersistSb(initial, sbKey, sbSaveFn) {
  const [val, setVal] = useState(initial);
  const setter = (updater) => {
    setVal((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (sbSaveFn) sbSaveFn(sbKey, next);
      return next;
    });
  };
  return [val, setter];
}

export default function App() {
  // ── Confirm modal state ────────────────────────────────────────────────
  const [confirmState, setConfirmState] = useState<{ message: string; action: string; onConfirm: () => void } | null>(null);
  setConfirmHandler((opts) => setConfirmState(opts));

  // ── Supabase persistence ─────────────────────────────────────────────────
  const SB_URL = "https://qcvqvxxoperiurauoxmp.supabase.co";
  const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFjdnF2eHhvcGVyaXVyYXVveG1wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2ODU4MjksImV4cCI6MjA4OTI2MTgyOX0.YoBmIdlqqPYt9roTsDPGSBegNnoupCYSsnyCHMo24Zw";

  // ── Key-value store for reference data (users, brands, vendors etc) ───────
  async function sbSave(key, value) {
    try {
      await fetch(`${SB_URL}/rest/v1/app_data`, {
        method: "POST",
        headers: {
          "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({ key, value: JSON.stringify(value) }),
      });
    } catch(e) { console.error("[SB] save error:", key, e); }
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
    } catch(e) { console.error("[SB] save task error:", e); }
  }

  async function sbDeleteTask(id) {
    try {
      await fetch(`${SB_URL}/rest/v1/tasks?id=eq.${id}`, {
        method: "DELETE",
        headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` },
      });
    } catch(e) { console.error("[SB] delete task error:", e); }
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

  const [dbxLoaded, setDbxLoaded] = useState(false);

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
  const [view, setView] = useState("dashboard");
  const [listView, setListView] = useState(false);
  const [expandedColl, setExpandedColl] = useState<string | null>(null);
  const [filterBrand, setFilterBrand] = useState<Set<string>>(new Set());
  const [filterSeason, setFilterSeason] = useState<Set<string>>(new Set());
  const [filterCustomer, setFilterCustomer] = useState<Set<string>>(new Set());
  const [filterVendor, setFilterVendor] = useState<Set<string>>(new Set());
  const [focusCollKey, setFocusCollKey] = useState(null);
  const [pendingDeleteColl, setPendingDeleteColl] = useState<string | null>(null);
  const [showNav, setShowNav] = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const [showVendors, setShowVendors] = useState(false);
  const [showTeam, setShowTeam] = useState(false);
  const [showUsers, setShowUsers] = useState(false);
  const [showSizeLib, setShowSizeLib] = useState(false);
  const [showCatLib, setShowCatLib] = useState(false);
  const [sizeLibrary, setSizeLibrary] = usePersistSb([], "size_library", sbSave);
  const [categoryLib, setCategoryLib] = usePersistSb([], "categories", sbSave);
  const [editTask, setEditTask] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [editCollKey, setEditCollKey] = useState(null);
  const [statFilter, setStatFilter] = useState(null); // "overdue"|"week"|"30d"|"collections"
  const [showAddTask, setShowAddTask] = useState(false);
  const [showBrands, setShowBrands] = useState(false);
  const [showSeasons, setShowSeasons] = useState(false);
  const [showCustomers, setShowCustomers] = useState(false);
  const [showOrderTypes, setShowOrderTypes] = useState(false);
  const [showRoles, setShowRoles] = useState(false);
  const [showGenders, setShowGenders] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [showTaskManager, setShowTaskManager] = useState(false);
  const [orderTypes, setOrderTypes] = usePersistSb([], "order_types", sbSave);
  const [roles, setRoles] = usePersistSb([], "roles", sbSave);
  const [genders, setGenders] = usePersistSb(GENDERS, "genders", sbSave);
  const [genderSizes, setGenderSizes] = usePersistSb({}, "gender_sizes", sbSave);
  const [taskTemplates, setTaskTemplates] = usePersistSb([], "task_templates", sbSave);
  // ─── Undo stack (up to 4 entries) ───────────────────────────────────────────
  const [undoStack, setUndoStack] = useState<Array<{prevTasks: any[], type: 'card' | 'drag', taskId?: string, description?: string}>>([]);
  const [undoConfirm, setUndoConfirm] = useState<{prevTasks: any[], taskId: string, description?: string} | null>(null);
  const [miniCalDragOver, setMiniCalDragOver] = useState(null);
  // ─── Calendar view persistent month/year (lifted out of CalendarView to survive re-renders) ─
  const [calViewYear, setCalViewYear] = useState(() => new Date().getFullYear());
  const [calViewMonth, setCalViewMonth] = useState(() => new Date().getMonth());
  const [teamsConfig, setTeamsConfig] = useState(() => {
    try { return JSON.parse(localStorage.getItem("teamsConfig") || "null") || { clientId: "", tenantId: "", channelMap: {} }; }
    catch { return { clientId: "", tenantId: "", channelMap: {} }; }
  });
  const [teamsToken, setTeamsToken] = useState(null);
  const [showTeamsConfig, setShowTeamsConfig] = useState(false);
  const [teamsTokenExpiry, setTeamsTokenExpiry] = useState(null);
  const [showEmailConfig, setShowEmailConfig] = useState(false);

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

        if (users) setUsers(users);
        if (brands) setBrands(brands);
        if (seasons) setSeasons(seasons);
        if (customers) setCustomers(customers);
        if (vendors) setVendors(vendors);
        if (team) setTeam(team);
        if (sizes) setSizeLibrary(sizes);
        if (categories) setCategoryLib(categories);
        if (orderTypes) setOrderTypes(orderTypes);
        if (rolesData) setRoles(rolesData);
        if (taskTemplatesData) setTaskTemplates(taskTemplatesData);
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

  // ── Realtime sync — poll every 10 seconds for changes from other users ──
  const dcHashRef = useRef("");
  useEffect(() => {
    if (!currentUser || !dbxLoaded) return;
    const poll = async () => {
      try {
        const [tasksRes, collRes, appRes] = await Promise.all([
          fetch(`${SB_URL}/rest/v1/tasks?select=id&order=id.desc&limit=1`, { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }),
          fetch(`${SB_URL}/rest/v1/collections?select=id&order=id.desc&limit=1`, { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }),
          fetch(`${SB_URL}/rest/v1/app_data?select=key,value&order=key.asc&limit=3`, { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }),
        ]);
        const [t, c, a] = await Promise.all([tasksRes.json(), collRes.json(), appRes.json()]);
        const hash = JSON.stringify({ t, c, a: a?.map?.((r: any) => r.key) });
        if (dcHashRef.current && hash !== dcHashRef.current) {
          console.log("[DC Realtime] Change detected, reloading...");
          const [newTasks, newColls] = await Promise.all([sbLoadTasks(), sbLoadCollections()]);
          if (newTasks?.length) _setTasksRaw(newTasks);
          if (newColls && Object.keys(newColls).length) _setCollRaw(newColls);
          // Reload reference data
          const refs = ["users","brands","seasons","customers","vendors","team","size_library","categories","order_types","roles","task_templates"];
          const setters = [setUsers, setBrands, setSeasons, setCustomers, setVendors, setTeam, setSizeLibrary, setCategoryLib, setOrderTypes, setRoles, setTaskTemplates];
          for (let i = 0; i < refs.length; i++) {
            const val = await sbLoad(refs[i]);
            if (val) (setters[i] as any)(val);
          }
        }
        dcHashRef.current = hash;
      } catch (e) { /* silent */ }
    };
    poll();
    const interval = setInterval(poll, 10000);
    return () => clearInterval(interval);
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

  // ── AUTO LOGOUT after 60 minutes of inactivity ──────────────────────────
  const IDLE_MS = 60 * 60 * 1000; // 60 minutes
  const [idleWarning, setIdleWarning] = useState(false);
  useEffect(() => {
    if (!currentUser) return;
    let warnTimer = null;
    let logoutTimer = null;

    function resetTimers() {
      setIdleWarning(false);
      clearTimeout(warnTimer);
      clearTimeout(logoutTimer);
      // Warn at 55 minutes
      warnTimer = setTimeout(() => setIdleWarning(true), IDLE_MS - 5 * 60 * 1000);
      // Log out at 60 minutes
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
    const brand = getBrand(task.brand),
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
        onClick={() => setEditTask(task)}
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
      </div>
    );
  };

  const Dashboard = () => {
    const collListView = listView;
    // Stat filter config
    const STAT_META = {
      overdue: {
        label: "Overdue Tasks",
        color: "#B91C1C",
        bg: "#FEF2F2",
        bdr: "#FCA5A5",
        accent: "#FC8181",
        tasks: overdue,
      },
      week: {
        label: "Due This Week",
        color: "#B45309",
        bg: "#FFFBEB",
        bdr: "#FCD34D",
        accent: "#F6AD55",
        tasks: dueThisWeek,
      },
      "30d": {
        label: "Due in Next 30 Days",
        color: "#1D4ED8",
        bg: "#EFF6FF",
        bdr: "#BFDBFE",
        accent: "#63B3ED",
        tasks: due30,
      },
      collections: {
        label: "All Collections",
        color: TH.primary,
        bg: TH.accent,
        bdr: TH.accentBdr,
        accent: TH.primary,
        tasks: [],
      },
    };
    const activeMeta = statFilter ? STAT_META[statFilter] : null;
    const showTaskList = statFilter && statFilter !== "collections";
    const showCollections = !statFilter || statFilter === "collections";

    return (
      <div onClick={() => setCtxMenu(null)}>
        {overdue.length > 0 && !statFilter && (
          <div
            style={{
              background: "#FFF5F5",
              border: "1px solid #FEB2B2",
              borderLeft: `4px solid ${TH.primary}`,
              borderRadius: 10,
              padding: "12px 20px",
              marginBottom: 22,
              display: "flex",
              gap: 12,
              alignItems: "center",
            }}
          >
            <span>⚠️</span>
            <span style={{ color: "#B91C1C", fontSize: 13 }}>
              <strong>{overdue.length} overdue</strong> —{" "}
              {overdue
                .map((t) => `${getBrand(t.brand).short} ${t.phase}`)
                .join(", ")}
            </span>
          </div>
        )}
        {tasks.length === 0 && (
          <div style={{ textAlign: "center", padding: "80px 0" }}>
            <div style={{ fontSize: 52, marginBottom: 16 }}>📅</div>
            <div
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: TH.text,
                marginBottom: 8,
              }}
            >
              No collections yet
            </div>
            <div
              style={{ fontSize: 14, color: TH.textMuted, marginBottom: 28 }}
            >
              Create your first collection to auto-generate a full timeline.
            </div>
            {isAdmin && (
              <button
                onClick={() => setShowWizard(true)}
                style={{ ...S.btn, padding: "14px 32px", fontSize: 15 }}
              >
                + New Collection
              </button>
            )}
          </div>
        )}
        {tasks.length > 0 && (
          <>
            {/* Stat filter banner */}
            {statFilter && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 22,
                  padding: "12px 18px",
                  background: activeMeta.bg,
                  border: `1px solid ${activeMeta.bdr}`,
                  borderLeft: `4px solid ${activeMeta.accent}`,
                  borderRadius: 10,
                }}
              >
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: activeMeta.color,
                  }}
                >
                  {activeMeta.tasks?.length ?? collList.length}{" "}
                  {activeMeta.label}
                </span>
                <button
                  onClick={() => setStatFilter(null)}
                  style={{
                    marginLeft: "auto",
                    padding: "4px 12px",
                    borderRadius: 6,
                    border: `1px solid ${activeMeta.bdr}`,
                    background: "none",
                    color: activeMeta.color,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  ✕ Clear Filter
                </button>
              </div>
            )}

            {/* Stat summary cards — only when no filter active */}
            {!statFilter && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3,1fr)",
                  gap: 16,
                  marginBottom: 28,
                }}
              >
                {[
                  {
                    id: "overdue",
                    label: "Overdue",
                    count: overdue.length,
                    c: "#B91C1C",
                    bg: "#FEF2F2",
                    bdr: "#FCA5A5",
                  },
                  {
                    id: "week",
                    label: "Due This Week",
                    count: dueThisWeek.length,
                    c: "#B45309",
                    bg: "#FFFBEB",
                    bdr: "#FCD34D",
                  },
                  {
                    id: "30d",
                    label: "Next 30 Days",
                    count: due30.length,
                    c: "#1D4ED8",
                    bg: "#EFF6FF",
                    bdr: "#BFDBFE",
                  },
                ].map((s) => (
                  <div
                    key={s.label}
                    onClick={() => setStatFilter(s.id)}
                    style={{
                      background: s.bg,
                      border: `1px solid ${s.bdr}`,
                      borderTop: `4px solid ${s.c}`,
                      borderRadius: 12,
                      padding: "20px 24px",
                      boxShadow: `0 2px 8px ${TH.shadow}`,
                      cursor: "pointer",
                      transition: "transform 0.15s,box-shadow 0.15s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = "translateY(-2px)";
                      e.currentTarget.style.boxShadow = `0 6px 16px ${TH.shadowMd}`;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = "none";
                      e.currentTarget.style.boxShadow = `0 2px 8px ${TH.shadow}`;
                    }}
                  >
                    <div
                      style={{
                        fontSize: 40,
                        fontWeight: 800,
                        color: s.c,
                        lineHeight: 1,
                      }}
                    >
                      {s.count}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: TH.textMuted,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        marginTop: 6,
                      }}
                    >
                      {s.label}
                    </div>
                    {s.count > 0 && (
                      <div
                        style={{
                          fontSize: 11,
                          color: s.c,
                          marginTop: 4,
                          fontWeight: 600,
                        }}
                      >
                        Click to view →
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Filtered task list view */}
            {showTaskList && (
              <>
                {activeMeta.tasks.length === 0 ? (
                  <div
                    style={{
                      textAlign: "center",
                      color: TH.textMuted,
                      padding: "48px 0",
                      fontSize: 14,
                    }}
                  >
                    No tasks in this category 🎉
                  </div>
                ) : (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fill,minmax(240px,1fr))",
                      gap: 10,
                      marginBottom: 28,
                    }}
                  >
                    {[...activeMeta.tasks]
                      .sort((a, b) => new Date(a.due) - new Date(b.due))
                      .map((t) => (
                        <TaskCard key={t.id} task={t} showDayDate={true} />
                      ))}
                  </div>
                )}

                {/* Mini calendar for "This Week" */}
                {statFilter === "week" &&
                  (() => {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const days = Array.from({ length: 8 }, (_, i) => {
                      const d = new Date(today);
                      d.setDate(today.getDate() + i);
                      return d;
                    });
                    const DAY_NAMES_FULL = [
                      "Sun",
                      "Mon",
                      "Tue",
                      "Wed",
                      "Thu",
                      "Fri",
                      "Sat",
                    ];
                    return (
                      <div style={{ marginBottom: 28 }}>
                        {/* Dark gradient header */}
                        <div
                          style={{
                            background: `linear-gradient(135deg, ${TH.header} 0%, #2D3748 100%)`,
                            borderRadius: 14,
                            padding: "12px 16px 0",
                            marginBottom: 4,
                            boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              marginBottom: 12,
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 13,
                                  fontWeight: 800,
                                  color: "#fff",
                                  letterSpacing: "-0.01em",
                                }}
                              >
                                This Week
                              </span>
                              <span
                                style={{
                                  fontSize: 10,
                                  color: "rgba(255,255,255,0.4)",
                                  background: "rgba(255,255,255,0.07)",
                                  padding: "1px 8px",
                                  borderRadius: 20,
                                }}
                              >
                                {days[0].toLocaleDateString("en-US", {
                                  month: "short",
                                  day: "numeric",
                                })}{" "}
                                –{" "}
                                {days[7].toLocaleDateString("en-US", {
                                  month: "short",
                                  day: "numeric",
                                })}
                              </span>
                            </div>
                            {dragId && (
                              <span
                                style={{
                                  fontSize: 10,
                                  color: "#93C5FD",
                                  fontWeight: 600,
                                }}
                              >
                                ✋ Drop to reschedule
                              </span>
                            )}
                          </div>
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(8,1fr)",
                              gap: 4,
                            }}
                          >
                            {days.map((day, i) => {
                              const isWeekend =
                                day.getDay() === 0 || day.getDay() === 6;
                              return (
                                <div
                                  key={i}
                                  style={{
                                    textAlign: "center",
                                    padding: "5px 0 7px",
                                    fontSize: 9,
                                    color: isWeekend
                                      ? "rgba(255,255,255,0.3)"
                                      : "rgba(255,255,255,0.5)",
                                    letterSpacing: "0.1em",
                                    textTransform: "uppercase",
                                    fontWeight: 700,
                                  }}
                                >
                                  {DAY_NAMES_FULL[day.getDay()]}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(8,1fr)",
                            gap: 4,
                          }}
                        >
                          {days.map((day, i) => {
                            const ds = `${day.getFullYear()}-${String(
                              day.getMonth() + 1
                            ).padStart(2, "0")}-${String(
                              day.getDate()
                            ).padStart(2, "0")}`;
                            const dayTasks = activeMeta.tasks.filter(
                              (t) => t.due === ds
                            );
                            const isToday =
                              day.toDateString() === today.toDateString();
                            const isDragTarget =
                              miniCalDragOver === ds && dragId;
                            return (
                              <div
                                key={i}
                                onDragOver={(e) => {
                                  if (!dragId) return;
                                  e.preventDefault();
                                  if (miniCalDragOver !== ds)
                                    setMiniCalDragOver(ds);
                                }}
                                onDragEnter={(e) => {
                                  if (!dragId) return;
                                  e.preventDefault();
                                  setMiniCalDragOver(ds);
                                }}
                                onDragLeave={(e) => {
                                  if (
                                    !e.currentTarget.contains(
                                      e.relatedTarget as Node
                                    )
                                  )
                                    setMiniCalDragOver(null);
                                }}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  const id =
                                    e.dataTransfer.getData("text/plain") ||
                                    dragId;
                                  if (!id) return;
                                  setTasks((ts) =>
                                    ts.map((t) =>
                                      t.id === id ? { ...t, due: ds } : t
                                    )
                                  );
                                  setDragId(null);
                                  setMiniCalDragOver(null);
                                }}
                                style={{
                                  borderRadius: "0 0 10px 10px",
                                  overflow: "hidden",
                                  border: `1px solid ${
                                    isDragTarget
                                      ? "#3B82F6"
                                      : isToday
                                      ? TH.primary
                                      : TH.border
                                  }`,
                                  borderTop: `3px solid ${
                                    isDragTarget
                                      ? "#3B82F6"
                                      : isToday
                                      ? TH.primary
                                      : TH.border
                                  }`,
                                  background: isDragTarget
                                    ? "#DBEAFE"
                                    : isToday
                                    ? TH.primary + "06"
                                    : TH.surface,
                                  boxShadow: `0 1px 4px ${TH.shadow}`,
                                  transition:
                                    "background 0.1s, border-color 0.1s",
                                }}
                              >
                                <div
                                  style={{
                                    padding: "6px 8px 3px",
                                    borderBottom: `1px solid ${TH.border}`,
                                  }}
                                >
                                  <div
                                    style={{
                                      fontSize: 16,
                                      fontWeight: 800,
                                      color: isDragTarget
                                        ? "#1D4ED8"
                                        : isToday
                                        ? TH.primary
                                        : TH.text,
                                      lineHeight: 1.1,
                                    }}
                                  >
                                    {day.getDate()}
                                    {isDragTarget && " 📅"}
                                  </div>
                                </div>
                                <div style={{ padding: "5px 5px" }}>
                                  {dayTasks.length === 0 && !isDragTarget ? (
                                    <div
                                      style={{
                                        fontSize: 10,
                                        color: TH.textMuted,
                                        textAlign: "center",
                                        padding: "4px 0",
                                      }}
                                    >
                                      —
                                    </div>
                                  ) : (
                                    dayTasks.map((t) => {
                                      const b = getBrand(t.brand);
                                      const sc =
                                        STATUS_CONFIG[t.status] ||
                                        STATUS_CONFIG["Not Started"];
                                      const isBeingDragged = dragId === t.id;
                                      return (
                                        <div
                                          key={t.id}
                                          draggable
                                          onDragStart={(e) => {
                                            e.dataTransfer.setData(
                                              "text/plain",
                                              t.id
                                            );
                                            setTimeout(
                                              () => setDragId(t.id),
                                              0
                                            );
                                          }}
                                          onDragEnd={() => {
                                            setDragId(null);
                                            setMiniCalDragOver(null);
                                          }}
                                          onClick={() => {
                                            if (!dragId) setEditTask(t);
                                          }}
                                          style={{
                                            fontSize: 10.5,
                                            background: isBeingDragged
                                              ? "#F3F4F6"
                                              : "#FFFFFF",
                                            borderLeft: `3px solid ${b.color}`,
                                            padding: "3px 5px",
                                            borderRadius: 4,
                                            marginBottom: 3,
                                            cursor: isBeingDragged
                                              ? "grabbing"
                                              : "grab",
                                            boxShadow:
                                              "0 1px 2px rgba(0,0,0,0.08)",
                                            opacity: isBeingDragged ? 0.4 : 1,
                                            userSelect: "none",
                                          }}
                                        >
                                          <div
                                            style={{
                                              fontWeight: 700,
                                              color: TH.text,
                                            }}
                                          >
                                            {b.short} {t.phase}
                                          </div>
                                          <div
                                            style={{
                                              color: sc.color,
                                              fontWeight: 600,
                                              fontSize: 9.5,
                                            }}
                                          >
                                            {t.status}
                                          </div>
                                          <div
                                            style={{
                                              color: TH.textMuted,
                                              fontSize: 9.5,
                                            }}
                                          >
                                            {t.collection}
                                          </div>
                                        </div>
                                      );
                                    })
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}

                {/* Mini calendar for "Next 30 Days" */}
                {statFilter === "30d" &&
                  (() => {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const rangeStart = new Date(today);
                    rangeStart.setDate(today.getDate() + 1);
                    const rangeEnd = new Date(today);
                    rangeEnd.setDate(today.getDate() + 30);
                    const tasksByDate = {};
                    [...dueThisWeek, ...activeMeta.tasks].forEach((t) => {
                      if (!tasksByDate[t.due]) tasksByDate[t.due] = [];
                      if (!tasksByDate[t.due].find((x) => x.id === t.id))
                        tasksByDate[t.due].push(t);
                    });
                    const months = [];
                    let cur = new Date(
                      rangeStart.getFullYear(),
                      rangeStart.getMonth(),
                      1
                    );
                    const endMonthStart = new Date(
                      rangeEnd.getFullYear(),
                      rangeEnd.getMonth(),
                      1
                    );
                    while (cur <= endMonthStart) {
                      months.push({
                        year: cur.getFullYear(),
                        month: cur.getMonth(),
                      });
                      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
                    }
                    const DAY_NAMES = [
                      "Sun",
                      "Mon",
                      "Tue",
                      "Wed",
                      "Thu",
                      "Fri",
                      "Sat",
                    ];
                    return (
                      <div style={{ marginBottom: 28 }}>
                        {months.map(({ year, month }) => {
                          const fd = new Date(year, month, 1).getDay();
                          const dim = new Date(year, month + 1, 0).getDate();
                          const cells = [
                            ...Array(fd).fill(null),
                            ...Array.from({ length: dim }, (_, i) => i + 1),
                          ];
                          return (
                            <div
                              key={`${year}-${month}`}
                              style={{ marginBottom: 16 }}
                            >
                              {/* Dark gradient month header */}
                              <div
                                style={{
                                  background: `linear-gradient(135deg, ${TH.header} 0%, #2D3748 100%)`,
                                  borderRadius: 14,
                                  padding: "12px 16px 0",
                                  marginBottom: 4,
                                  boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
                                }}
                              >
                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    marginBottom: 12,
                                  }}
                                >
                                  <div
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 10,
                                    }}
                                  >
                                    <span
                                      style={{
                                        fontSize: 14,
                                        fontWeight: 800,
                                        color: "#fff",
                                        letterSpacing: "-0.01em",
                                      }}
                                    >
                                      {MONTHS[month]}
                                    </span>
                                    <span
                                      style={{
                                        fontSize: 13,
                                        fontWeight: 400,
                                        color: "rgba(255,255,255,0.45)",
                                      }}
                                    >
                                      {year}
                                    </span>
                                  </div>
                                  {dragId && (
                                    <span
                                      style={{
                                        fontSize: 10,
                                        color: "#93C5FD",
                                        fontWeight: 600,
                                      }}
                                    >
                                      ✋ Drop to reschedule
                                    </span>
                                  )}
                                </div>
                                <div
                                  style={{
                                    display: "grid",
                                    gridTemplateColumns: "repeat(7,1fr)",
                                    gap: 3,
                                  }}
                                >
                                  {DAY_NAMES.map((d, di) => {
                                    const isWeekend = di === 0 || di === 6;
                                    return (
                                      <div
                                        key={d}
                                        style={{
                                          textAlign: "center",
                                          padding: "5px 0 7px",
                                          fontSize: 9,
                                          color: isWeekend
                                            ? "rgba(255,255,255,0.3)"
                                            : "rgba(255,255,255,0.5)",
                                          letterSpacing: "0.1em",
                                          textTransform: "uppercase",
                                          fontWeight: 700,
                                        }}
                                      >
                                        {d}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                              <div
                                style={{
                                  display: "grid",
                                  gridTemplateColumns: "repeat(7,1fr)",
                                  gap: 3,
                                }}
                              >
                                {cells.map((d, i) => {
                                  if (!d)
                                    return (
                                      <div key={i} style={{ minHeight: 58 }} />
                                    );
                                  const ds = `${year}-${String(
                                    month + 1
                                  ).padStart(2, "0")}-${String(d).padStart(
                                    2,
                                    "0"
                                  )}`;
                                  const cellDate = new Date(year, month, d);
                                  const inRange =
                                    cellDate >= rangeStart &&
                                    cellDate <= rangeEnd;
                                  if (!inRange)
                                    return (
                                      <div key={i} style={{ minHeight: 58 }} />
                                    );
                                  const dayTasks = tasksByDate[ds] || [];
                                  const hasTasks = dayTasks.length > 0;
                                  const isDragTarget =
                                    miniCalDragOver === ds && dragId;
                                  return (
                                    <div
                                      key={i}
                                      onDragOver={(e) => {
                                        if (!dragId) return;
                                        e.preventDefault();
                                        if (miniCalDragOver !== ds)
                                          setMiniCalDragOver(ds);
                                      }}
                                      onDragEnter={(e) => {
                                        if (!dragId) return;
                                        e.preventDefault();
                                        setMiniCalDragOver(ds);
                                      }}
                                      onDragLeave={(e) => {
                                        if (
                                          !e.currentTarget.contains(
                                            e.relatedTarget as Node
                                          )
                                        )
                                          setMiniCalDragOver(null);
                                      }}
                                      onDrop={(e) => {
                                        e.preventDefault();
                                        const id =
                                          e.dataTransfer.getData(
                                            "text/plain"
                                          ) || dragId;
                                        if (!id) return;
                                        setTasks((ts) =>
                                          ts.map((t) =>
                                            t.id === id ? { ...t, due: ds } : t
                                          )
                                        );
                                        setDragId(null);
                                        setMiniCalDragOver(null);
                                      }}
                                      style={{
                                        minHeight: 58,
                                        padding: "4px 4px",
                                        borderRadius: 7,
                                        background: isDragTarget
                                          ? "#DBEAFE"
                                          : hasTasks
                                          ? "#EFF6FF"
                                          : "#F7F8FA",
                                        border: `1px solid ${
                                          isDragTarget
                                            ? "#3B82F6"
                                            : hasTasks
                                            ? "#BFDBFE"
                                            : TH.border
                                        }`,
                                        transition:
                                          "background 0.1s, border-color 0.1s",
                                      }}
                                    >
                                      <div
                                        style={{
                                          fontSize: 11,
                                          fontWeight:
                                            hasTasks || isDragTarget
                                              ? 800
                                              : 400,
                                          color: isDragTarget
                                            ? "#1D4ED8"
                                            : hasTasks
                                            ? "#1D4ED8"
                                            : TH.textMuted,
                                          marginBottom: 2,
                                        }}
                                      >
                                        {d}
                                        {isDragTarget && " 📅"}
                                      </div>
                                      {dayTasks.slice(0, 2).map((t) => {
                                        const b = getBrand(t.brand);
                                        const isBeingDragged = dragId === t.id;
                                        return (
                                          <div
                                            key={t.id}
                                            draggable
                                            onDragStart={(e) => {
                                              e.dataTransfer.setData(
                                                "text/plain",
                                                t.id
                                              );
                                              setTimeout(
                                                () => setDragId(t.id),
                                                0
                                              );
                                            }}
                                            onDragEnd={() => {
                                              setDragId(null);
                                              setMiniCalDragOver(null);
                                            }}
                                            onClick={() => {
                                              if (!dragId) setEditTask(t);
                                            }}
                                            style={{
                                              fontSize: 9.5,
                                              background: isBeingDragged
                                                ? "#F3F4F6"
                                                : "#fff",
                                              borderLeft: `2px solid ${b.color}`,
                                              padding: "2px 4px",
                                              borderRadius: 3,
                                              marginBottom: 2,
                                              cursor: isBeingDragged
                                                ? "grabbing"
                                                : "grab",
                                              color: TH.text,
                                              fontWeight: 600,
                                              lineHeight: 1.2,
                                              boxShadow:
                                                "0 1px 2px rgba(0,0,0,0.06)",
                                              opacity: isBeingDragged ? 0.4 : 1,
                                              userSelect: "none",
                                            }}
                                          >
                                            {b.short} {t.phase}
                                          </div>
                                        );
                                      })}
                                      {dayTasks.length > 2 && (
                                        <div
                                          style={{
                                            fontSize: 9,
                                            color: "#1D4ED8",
                                            fontWeight: 700,
                                          }}
                                        >
                                          +{dayTasks.length - 2}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
              </>
            )}

            {/* Collections grid */}
            {showCollections && (
              <>
                <div style={{ marginBottom: 12 }}>
                  <span style={S.sec}>
                    Collections{" "}
                    <span style={{ color: TH.textSub2, fontWeight: 400 }}>
                      — click to focus · right-click for options
                    </span>
                  </span>
                </div>

                {/* LIST VIEW */}
                {collListView && (
                  <div style={{ marginBottom: 28, border: `1px solid ${TH.border}`, borderRadius: 12, overflow: "hidden" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "inherit" }}>
                      <thead>
                        <tr style={{ background: TH.header, borderBottom: `2px solid ${TH.header}` }}>
                          {["Brand", "Collection", "Season", "Vendor", "DDP", "Progress", "Next Task"].map(h => (
                            <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontWeight: 700, color: "rgba(255,255,255,0.75)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {collList.map((c, ri) => {
                          const brand = getBrand(c.brand);
                          const done = c.tasks.filter(t => ["Complete","Approved"].includes(t.status)).length;
                          const pct = Math.round((done / c.tasks.length) * 100);
                          const ddpTask = c.tasks.find(t => t.phase === "DDP");
                          const next = c.tasks.filter(t => !["Complete","Approved"].includes(t.status)).sort((a,b) => new Date(a.due).getTime() - new Date(b.due).getTime())[0];
                          const isExpanded = expandedColl === c.key;
                          const sortedTasks = [...c.tasks].sort((a,b) => new Date(a.due).getTime() - new Date(b.due).getTime());
                          const rowBg = isExpanded ? "#E8EDF5" : ri % 2 === 0 ? "#FFFFFF" : "#F1F5F9";
                          return (
                            <Fragment key={c.key}>
                              <tr onClick={() => setExpandedColl(isExpanded ? null : c.key)}
                                style={{ borderBottom: `1px solid ${TH.border}`, cursor: "pointer", background: rowBg, transition: "background 0.1s" }}
                                onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "#DDE3EE"}
                                onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = rowBg}>
                                <td style={{ padding: "10px 14px" }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <div style={{ width: 10, height: 10, borderRadius: 2, background: brand.color, flexShrink: 0 }} />
                                    <span style={{ fontWeight: 700, color: brand.color }}>{brand.short || brand.name}</span>
                                  </div>
                                </td>
                                <td style={{ padding: "10px 14px", fontWeight: 600, color: TH.text }}>
                                  {isExpanded ? "▼ " : "▶ "}{c.collection}
                                </td>
                                <td style={{ padding: "10px 14px", color: TH.textSub2 }}>{c.season || "—"}</td>
                                <td style={{ padding: "10px 14px", color: TH.textSub2 }}>{c.vendorName || "—"}</td>
                                <td style={{ padding: "10px 14px", color: ddpTask ? TH.text : TH.textSub2, fontWeight: ddpTask ? 600 : 400 }}>{ddpTask ? formatDate(ddpTask.due) : "—"}</td>
                                <td style={{ padding: "10px 14px" }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <div style={{ flex: 1, height: 6, background: "#CBD5E0", borderRadius: 3, minWidth: 60 }}>
                                      <div style={{ width: `${pct}%`, height: "100%", background: pct === 100 ? "#10B981" : brand.color, borderRadius: 3, transition: "width 0.3s" }} />
                                    </div>
                                    <span style={{ fontSize: 11, color: TH.textSub2, flexShrink: 0 }}>{pct}%</span>
                                  </div>
                                </td>
                                <td style={{ padding: "10px 14px", color: next ? TH.text : TH.textSub2 }}>{next ? `${next.phase} · ${formatDate(next.due)}` : "All done"}</td>
                              </tr>
                              {isExpanded && (
                                <tr>
                                  <td colSpan={7} style={{ background: "#EEF2F9", padding: 0, borderBottom: `2px solid ${TH.border}` }}>
                                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "inherit" }}>
                                      <thead>
                                        <tr style={{ background: "#3A4A5C", borderBottom: `1px solid #2D3748` }}>
                                          {["Phase", "Due Date", "Business Days Left", "Status", "Assignee"].map(h => (
                                            <th key={h} style={{ padding: "7px 14px 7px 28px", textAlign: "left", fontWeight: 600, color: "rgba(255,255,255,0.7)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                                          ))}
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {sortedTasks.map((t, ti) => {
                                          const sc = STATUS_CONFIG[t.status] || STATUS_CONFIG["Not Started"];
                                          const assignee = team.find(m => m.id === t.assigneeId);
                                          const bd = getBusinessDaysUntil(t.due);
                                          const innerBg = ti % 2 === 0 ? "#F8FAFC" : "#FFFFFF";
                                          return (
                                            <tr key={t.id} onClick={e => { e.stopPropagation(); setEditTask(t); }}
                                              style={{ borderBottom: `1px solid ${TH.border}`, cursor: "pointer", background: innerBg }}
                                              onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "#E2E8F0"}
                                              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = innerBg}>
                                              <td style={{ padding: "8px 14px 8px 28px", fontWeight: 600, color: TH.text }}>{t.phase}</td>
                                              <td style={{ padding: "8px 14px 8px 28px", color: TH.textSub2 }}>{formatDate(t.due)}</td>
                                              <td style={{ padding: "8px 14px 8px 28px", color: bd < 0 ? "#B91C1C" : bd <= 5 ? "#B45309" : TH.textSub, fontWeight: bd < 0 ? 700 : 400 }}>{t.status === "Complete" ? "Done" : fmtDays(bd)}</td>
                                              <td style={{ padding: "8px 14px 8px 28px" }}>
                                                <span style={{ background: sc.bg, color: sc.color, border: `1px solid ${sc.border}`, padding: "2px 8px", borderRadius: 10, fontSize: 10, fontWeight: 600 }}>{t.status}</span>
                                              </td>
                                              <td style={{ padding: "8px 14px 8px 28px", color: TH.textSub2 }}>{assignee?.name || "—"}</td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* GRID VIEW */}
                {!collListView && <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))",
                    gap: 12,
                    marginBottom: 28,
                  }}
                >
                  {collList.map((c) => {
                    const brand = getBrand(c.brand),
                      done = c.tasks.filter((t) =>
                        ["Complete", "Approved"].includes(t.status)
                      ).length,
                      pct = Math.round((done / c.tasks.length) * 100),
                      hasDelay = c.tasks.some((t) => t.status === "Delayed");
                    const next = c.tasks
                      .filter(
                        (t) => !["Complete", "Approved"].includes(t.status)
                      )
                      .sort((a, b) => new Date(a.due) - new Date(b.due))[0];
                    const collData = collections[c.key] || {},
                      skuCount = collData.skus?.length || 0;
                    const assigneeIds = [
                      ...new Set(
                        c.tasks.map((t) => t.assigneeId).filter(Boolean)
                      ),
                    ];
                    const isFocused = focusCollKey === c.key;
                    const ddpTask = c.tasks.find((t) => t.phase === "DDP");
                    return (
                      <div
                        key={c.key}
                        onClick={(e) => {
                          e.stopPropagation();
                          setFocusCollKey(isFocused ? null : c.key);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setCtxMenu({
                            x: e.clientX,
                            y: e.clientY,
                            collKey: c.key,
                          });
                        }}
                        style={{
                          ...S.card,
                          cursor: "pointer",
                          outline: isFocused
                            ? `2px solid ${brand.color}`
                            : "2px solid transparent",
                          outlineOffset: 2,
                          transition: "all 0.15s",
                          transform: isFocused ? "scale(1.01)" : "scale(1)",
                          position: "relative",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            right: 0,
                            height: 3,
                            background: TH.primary,
                          }}
                        />
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "flex-start",
                            marginBottom: 10,
                            paddingTop: 4,
                          }}
                        >
                          <div>
                            {/* Line 1: Brand · Collection Name · Sample Due */}
                            <div style={{ fontSize: 11, fontWeight: 700, color: TH.primary, marginBottom: 2 }}>
                              {brand.short || brand.name} · {c.collection}{collData.sampleDueDate ? ` · Sample: ${formatDate(collData.sampleDueDate)}` : ""}
                            </div>
                            {/* Line 2: Season Year · Gender · Category */}
                            <div style={{ fontSize: 11, color: TH.textSub2 }}>
                              {c.season}
                              {collData.year ? ` ${collData.year}` : ""}
                              {collData.gender ? ` · ${collData.gender}` : ""}
                              {c.category ? ` · ${c.category}` : ""}
                            </div>
                            {/* Line 3: Vendor · DDP · Exit Factory */}
                            {(() => {
                              const shipTask = c.tasks.find((t) => t.phase === "Ship Date");
                              const parts = [];
                              if (c.vendorName) parts.push(c.vendorName);
                              if (ddpTask) parts.push(`DDP: ${formatDate(ddpTask.due)}`);
                              if (shipTask) parts.push(`Exit Factory: ${formatDate(shipTask.due)}`);
                              return parts.length > 0 ? (
                                <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 2 }}>
                                  {parts.join(" · ")}
                                </div>
                              ) : null;
                            })()}
                            {/* Line 4: Customer · Start Ship · Cancel */}
                            {(() => {
                              const parts = [];
                              if (collData.customer) {
                                parts.push(collData.customer + (collData.orderType ? ` (${collData.orderType})` : ""));
                              }
                              if (collData.customerShipDate) parts.push(`Start Ship: ${formatDate(collData.customerShipDate)}`);
                              if (collData.cancelDate) parts.push(`Cancel: ${formatDate(collData.cancelDate)}`);
                              return parts.length > 0 ? (
                                <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 2 }}>
                                  {parts.join(" · ")}
                                </div>
                              ) : null;
                            })()}
                          </div>
                          <div style={{ textAlign: "right" }}>
                            <div
                              style={{
                                fontSize: 24,
                                fontWeight: 800,
                                color: pct === 100 ? "#047857" : TH.text,
                                lineHeight: 1,
                              }}
                            >
                              {pct}%
                            </div>
                            {hasDelay && (
                              <div
                                style={{
                                  fontSize: 10,
                                  color: "#B91C1C",
                                  fontWeight: 700,
                                }}
                              >
                                ⚠ Delayed
                              </div>
                            )}
                          </div>
                        </div>
                        <div
                          style={{
                            height: 5,
                            background: TH.surfaceHi,
                            border: `1px solid ${TH.border}`,
                            borderRadius: 3,
                            overflow: "hidden",
                            marginBottom: 10,
                          }}
                        >
                          <div
                            style={{
                              height: "100%",
                              width: `${pct}%`,
                              background: `linear-gradient(90deg,${brand.color},${TH.primary})`,
                              borderRadius: 3,
                              transition: "width 0.6s",
                            }}
                          />
                        </div>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: 6,
                          }}
                        >
                          {next && (
                            <div style={{ fontSize: 11, color: TH.textMuted }}>
                              Next:{" "}
                              <span
                                style={{ color: TH.textSub2, fontWeight: 600 }}
                              >
                                {next.phase}
                              </span>{" "}
                              —{" "}
                              <span
                                style={{
                                  color:
                                    getDaysUntil(next.due) < 0
                                      ? "#B91C1C"
                                      : getDaysUntil(next.due) < 7
                                      ? "#B45309"
                                      : TH.primary,
                                  fontWeight: 600,
                                }}
                              >
                                {formatDate(next.due)}
                              </span>
                            </div>
                          )}
                          <div style={{ fontSize: 11, color: TH.textMuted }}>
                            {skuCount} SKU{skuCount !== 1 ? "s" : ""}
                          </div>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              gap: 3,
                              flexWrap: "wrap",
                            }}
                          >
                            {c.tasks
                              .sort((a, b) => new Date(a.due) - new Date(b.due))
                              .map((t) => (
                                <span
                                  key={t.id}
                                  title={`${t.phase}: ${t.status}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditTask(t);
                                  }}
                                  style={{
                                    width: 9,
                                    height: 9,
                                    borderRadius: 2,
                                    background:
                                      STATUS_CONFIG[t.status]?.dot || TH.border,
                                    display: "inline-block",
                                    cursor: "pointer",
                                  }}
                                />
                              ))}
                          </div>
                          <div style={{ display: "flex", gap: 3 }}>
                            {assigneeIds.slice(0, 4).map((id) => {
                              const m = team.find((x) => x.id === id);
                              return m ? (
                                <Avatar key={id} member={m} size={20} />
                              ) : null;
                            })}
                          </div>
                        </div>
                        <div
                          style={{
                            marginTop: 10,
                            paddingTop: 10,
                            borderTop: `1px solid ${TH.border}`,
                            display: "flex",
                            gap: 6,
                          }}
                        >
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setFocusCollKey(c.key);
                              setView("timeline");
                            }}
                            style={{
                              flex: 1,
                              padding: "4px 6px",
                              borderRadius: 6,
                              border: `1px solid ${brand.color}44`,
                              background: brand.color + "12",
                              color: brand.color,
                              cursor: "pointer",
                              fontFamily: "inherit",
                              fontSize: 10,
                              fontWeight: 700,
                            }}
                          >
                            📊 Timeline
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setFocusCollKey(c.key);
                              setView("calendar");
                            }}
                            style={{
                              flex: 1,
                              padding: "4px 6px",
                              borderRadius: 6,
                              border: `1px solid ${brand.color}44`,
                              background: brand.color + "12",
                              color: brand.color,
                              cursor: "pointer",
                              fontFamily: "inherit",
                              fontSize: 10,
                              fontWeight: 700,
                            }}
                          >
                            📅 Calendar
                          </button>
                          {/* Images button with concept/sku submenu */}
                        </div>
                      </div>
                    );
                  })}
                </div>}
                {!statFilter && dueThisWeek.length > 0 && (
                  <>
                    <span style={S.sec}>Due This Week</span>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fill,minmax(220px,1fr))",
                        gap: 10,
                      }}
                    >
                      {dueThisWeek.map((t) => (
                        <TaskCard key={t.id} task={t} />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    );
  };

  const Timeline = () => {
    const g = {};
    const src = focusCollKey
      ? tasks.filter((t) => `${t.brand}||${t.collection}` === focusCollKey)
      : filtered;
    src.forEach((t) => {
      if (!g[t.brand]) g[t.brand] = {};
      if (!g[t.brand][t.collection]) g[t.brand][t.collection] = [];
      g[t.brand][t.collection].push(t);
    });
    if (!Object.keys(g).length)
      return (
        <div
          style={{
            textAlign: "center",
            color: TH.textMuted,
            padding: "60px 0",
          }}
        >
          No collections match.
          {focusCollKey && (
            <>
              <br />
              <button
                onClick={() => setFocusCollKey(null)}
                style={{
                  marginTop: 12,
                  padding: "8px 16px",
                  borderRadius: 8,
                  border: `1px solid ${TH.border}`,
                  background: "none",
                  color: TH.textMuted,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Show All
              </button>
            </>
          )}
        </div>
      );
    if (listView) {
      // Build collection rows from src tasks, sorted by earliest DDP
      const collMap2: Record<string, { key: string; brand: string; collection: string; tasks: typeof src }> = {};
      src.forEach(t => {
        const key = `${t.brand}||${t.collection}`;
        if (!collMap2[key]) collMap2[key] = { key, brand: t.brand, collection: t.collection, tasks: [] };
        collMap2[key].tasks.push(t);
      });
      const collRows = Object.values(collMap2).sort((a, b) => {
        const aDDP = a.tasks.find(t => t.phase === "DDP")?.due || a.tasks[0]?.due || "";
        const bDDP = b.tasks.find(t => t.phase === "DDP")?.due || b.tasks[0]?.due || "";
        return aDDP < bDDP ? -1 : 1;
      });
      return (
        <div style={{ border: `1px solid ${TH.border}`, borderRadius: 12, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "inherit" }}>
            <thead>
              <tr style={{ background: TH.header, borderBottom: `2px solid ${TH.header}` }}>
                {["Brand", "Collection", "Season", "Vendor", "DDP", "Progress", "Next Task"].map(h => (
                  <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontWeight: 700, color: "rgba(255,255,255,0.75)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {collRows.map((c, ri) => {
                const brand = getBrand(c.brand);
                const done = c.tasks.filter(t => ["Complete","Approved"].includes(t.status)).length;
                const pct = Math.round((done / c.tasks.length) * 100);
                const ddpTask = c.tasks.find(t => t.phase === "DDP");
                const next = c.tasks.filter(t => !["Complete","Approved"].includes(t.status)).sort((a,b) => new Date(a.due).getTime() - new Date(b.due).getTime())[0];
                const isExpanded = expandedColl === c.key;
                const sortedTasks = [...c.tasks].sort((a,b) => new Date(a.due).getTime() - new Date(b.due).getTime());
                const rowBg = isExpanded ? "#E8EDF5" : ri % 2 === 0 ? "#FFFFFF" : "#F1F5F9";
                const season = c.tasks[0]?.season || "—";
                const vendorName = c.tasks[0]?.vendorName || "—";
                return (
                  <Fragment key={c.key}>
                    <tr onClick={() => setExpandedColl(isExpanded ? null : c.key)}
                      style={{ borderBottom: `1px solid ${TH.border}`, cursor: "pointer", background: rowBg, transition: "background 0.1s" }}
                      onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "#DDE3EE"}
                      onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = rowBg}>
                      <td style={{ padding: "10px 14px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ width: 10, height: 10, borderRadius: 2, background: brand.color, flexShrink: 0 }} />
                          <span style={{ fontWeight: 700, color: brand.color }}>{brand.short || brand.name}</span>
                        </div>
                      </td>
                      <td style={{ padding: "10px 14px", fontWeight: 600, color: TH.text }}>
                        {isExpanded ? "▼ " : "▶ "}{c.collection}
                      </td>
                      <td style={{ padding: "10px 14px", color: TH.textSub2 }}>{season}</td>
                      <td style={{ padding: "10px 14px", color: TH.textSub2 }}>{vendorName}</td>
                      <td style={{ padding: "10px 14px", color: ddpTask ? TH.text : TH.textSub2, fontWeight: ddpTask ? 600 : 400 }}>{ddpTask ? formatDate(ddpTask.due) : "—"}</td>
                      <td style={{ padding: "10px 14px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ flex: 1, height: 6, background: "#CBD5E0", borderRadius: 3, minWidth: 60 }}>
                            <div style={{ width: `${pct}%`, height: "100%", background: pct === 100 ? "#10B981" : brand.color, borderRadius: 3, transition: "width 0.3s" }} />
                          </div>
                          <span style={{ fontSize: 11, color: TH.textSub2, flexShrink: 0 }}>{pct}%</span>
                        </div>
                      </td>
                      <td style={{ padding: "10px 14px", color: next ? TH.text : TH.textSub2 }}>{next ? `${next.phase} · ${formatDate(next.due)}` : "All done"}</td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={7} style={{ background: "#EEF2F9", padding: 0, borderBottom: `2px solid ${TH.border}` }}>
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "inherit" }}>
                            <thead>
                              <tr style={{ background: "#3A4A5C", borderBottom: `1px solid #2D3748` }}>
                                {["Phase", "Due Date", "Business Days Left", "Status", "Assignee"].map(h => (
                                  <th key={h} style={{ padding: "7px 14px 7px 28px", textAlign: "left", fontWeight: 600, color: "rgba(255,255,255,0.7)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {sortedTasks.map((t, ti) => {
                                const sc = STATUS_CONFIG[t.status] || STATUS_CONFIG["Not Started"];
                                const assignee = team.find(m => m.id === t.assigneeId);
                                const bd = getBusinessDaysUntil(t.due);
                                const innerBg = ti % 2 === 0 ? "#F8FAFC" : "#FFFFFF";
                                return (
                                  <tr key={t.id} onClick={e => { e.stopPropagation(); setEditTask(t); }}
                                    style={{ borderBottom: `1px solid ${TH.border}`, cursor: "pointer", background: innerBg }}
                                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "#E2E8F0"}
                                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = innerBg}>
                                    <td style={{ padding: "8px 14px 8px 28px", fontWeight: 600, color: TH.text }}>{t.phase}</td>
                                    <td style={{ padding: "8px 14px 8px 28px", color: TH.textSub2 }}>{formatDate(t.due)}</td>
                                    <td style={{ padding: "8px 14px 8px 28px", color: bd < 0 ? "#B91C1C" : bd <= 5 ? "#B45309" : TH.textSub, fontWeight: bd < 0 ? 700 : 400 }}>{t.status === "Complete" ? "Done" : fmtDays(bd)}</td>
                                    <td style={{ padding: "8px 14px 8px 28px" }}>
                                      <span style={{ background: sc.bg, color: sc.color, border: `1px solid ${sc.border}`, padding: "2px 8px", borderRadius: 10, fontSize: 10, fontWeight: 600 }}>{t.status}</span>
                                    </td>
                                    <td style={{ padding: "8px 14px 8px 28px", color: TH.textSub2 }}>{assignee?.name || "—"}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      );
    }

    return (
      <div
        style={{
          background: "#EEF1F6",
          borderRadius: 14,
          padding: "22px",
          minHeight: 200,
        }}
      >
        {focusCollKey && (
          <div
            style={{
              marginBottom: 18,
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <span style={{ fontSize: 13, color: TH.textMuted }}>
              Showing:{" "}
              <strong style={{ color: TH.text }}>
                {focusCollKey.split("||")[1]}
              </strong>
            </span>
            <button
              onClick={() => setFocusCollKey(null)}
              style={{
                padding: "4px 12px",
                borderRadius: 6,
                border: `1px solid ${TH.border}`,
                background: "none",
                color: TH.textMuted,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 12,
              }}
            >
              ✕ Show All
            </button>
          </div>
        )}
        {Object.entries(g).map(([bid, colls]) => {
          const brand = getBrand(bid);
          return (
            <div key={bid} style={{ marginBottom: 36 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 16,
                }}
              >
                <div
                  style={{
                    width: 4,
                    height: 28,
                    background: brand.color,
                    borderRadius: 2,
                  }}
                />
                <span style={{ fontSize: 17, fontWeight: 700, color: TH.primary }}>
                  {brand.name.toUpperCase()}
                  {(() => {
                    // Find sampleDueDate from any collection under this brand
                    const sampleDate = Object.keys(colls)
                      .map((cname) => (collections[`${bid}||${cname}`] || {}).sampleDueDate)
                      .find(Boolean);
                    return sampleDate ? (
                      <span style={{ fontSize: 12, fontWeight: 700, color: TH.textMuted, marginLeft: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        · SAMPLES DUE: {formatDate(sampleDate)}
                      </span>
                    ) : null;
                  })()}
                </span>
              </div>
              {Object.entries(colls).map(([cname, ctasks]) => {
                const ALL_PHASES = [
                  ...PHASE_KEYS.slice(0, PHASE_KEYS.indexOf("Purchase Order")),
                  "Line Review",
                  "Compliance/Testing",
                  ...PHASE_KEYS.slice(PHASE_KEYS.indexOf("Purchase Order")),
                ];
                const sorted = [...ctasks].sort((a, b) => {
                  // Primary sort: chronological by due date
                  const dateDiff = new Date(a.due) - new Date(b.due);
                  if (dateDiff !== 0) return dateDiff;
                  // Tiebreaker: use standard phase order when dates are equal
                  const ai = ALL_PHASES.indexOf(a.phase);
                  const bi = ALL_PHASES.indexOf(b.phase);
                  return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
                });
                const collData = collections[`${bid}||${cname}`] || {};
                const ddpTask = sorted.find((t) => t.phase === "DDP");
                return (
                  <div key={cname} style={{ marginBottom: 24, marginLeft: 16 }}>
                    <div
                      style={{
                        fontSize: 12,
                        color: TH.textMuted,
                        letterSpacing: "0.07em",
                        textTransform: "uppercase",
                        marginBottom: 8,
                        display: "flex",
                        alignItems: "center",
                        gap: 16,
                        flexWrap: "wrap",
                      }}
                    >
                      {/* Line 1: Brand · Collection · Sample Due */}
                      <span style={{ fontWeight: 700, color: TH.primary }}>
                        {brand.short || brand.name}
                      </span>
                      <span style={{ fontWeight: 700, color: TH.textMuted }}>
                        {cname}
                      </span>
                      {collData.sampleDueDate && (
                        <span style={{ fontWeight: 600, color: "#B45309" }}>
                          · Sample Due: {formatDate(collData.sampleDueDate)}
                        </span>
                      )}
                      {/* Season · Year · Gender · Category */}
                      <span style={{ fontWeight: 400, color: TH.textMuted }}>
                        {ctasks[0]?.season ? `${ctasks[0].season}` : ""}
                        {collData.year ? ` ${collData.year}` : ""}
                        {collData.gender ? ` · ${collData.gender}` : ""}
                        {ctasks[0]?.category ? ` · ${ctasks[0].category}` : ""}
                      </span>
                      {/* Line 2: Vendor · DDP · Exit Factory */}
                      {(() => {
                        const shipTask = sorted.find((t) => t.phase === "Ship Date");
                        const parts = [];
                        if (ctasks[0]?.vendorName) parts.push(ctasks[0].vendorName);
                        if (ddpTask) parts.push(`DDP: ${formatDate(ddpTask.due)}`);
                        if (shipTask) parts.push(`Exit Factory: ${formatDate(shipTask.due)}`);
                        return parts.length > 0 ? (
                          <span style={{ color: TH.textMuted, fontWeight: 400 }}>
                            {parts.join(" · ")}
                          </span>
                        ) : null;
                      })()}
                      {/* Line 3: Customer · Start Ship · Cancel */}
                      {(() => {
                        const shipDays = collData.customerShipDate ? getDaysUntil(collData.customerShipDate) : null;
                        const parts = [];
                        if (collData.customer) parts.push(collData.customer + (collData.orderType ? ` (${collData.orderType})` : ""));
                        if (collData.customerShipDate) parts.push(`Start Ship: ${formatDate(collData.customerShipDate)}`);
                        if (collData.cancelDate) parts.push(`Cancel: ${formatDate(collData.cancelDate)}`);
                        return parts.length > 0 ? (
                          <span style={{ color: TH.textMuted, fontWeight: 400 }}>
                            {parts.join(" · ")}
                          </span>
                        ) : null;
                      })()}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "stretch",
                        overflowX: "auto",
                        paddingBottom: 16,
                        gap: 0,
                      }}
                    >
                      {/* ── DROP ZONE before first card ── */}
                      {(() => {
                        const beforeKey = `${bid}-${cname}-gap-before`;
                        const isBefore = dragOverId === beforeKey;
                        return (
                          <div
                            onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (dragOverId !== beforeKey) setDragOverId(beforeKey); }}
                            onDragEnter={e => { e.preventDefault(); setDragOverId(beforeKey); }}
                            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverId(null); }}
                            onDrop={e => {
                              e.preventDefault(); e.stopPropagation();
                              const droppedId = e.dataTransfer.getData("text/plain") || dragId;
                              if (!droppedId || !sorted.length) return;
                              const droppedTask = tasks.find(x => x.id === droppedId);
                              // Post-PO phases use calendar days; pre-PO snap to business day
                              const rawDue = addDays(sorted[0].due, -1);
                              const newDue = droppedTask && isPostPO(droppedTask.phase)
                                ? rawDue
                                : snapToBusinessDay(rawDue);
                              if (droppedTask) {
                                pushUndo(tasks, 'drag');
                                const updated = { ...droppedTask, due: newDue };
                                setTasks(ts => ts.map(x => x.id === droppedId ? updated : x));
                                sbSaveTask(updated);
                              }
                              setDragId(null); setDragOverId(null);
                            }}
                            style={{ width: isBefore ? 52 : 28, minHeight: "100%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", cursor: "copy", transition: "width 0.12s", position: "relative", zIndex: 2 }}
                          >
                            {isBefore && (
                              <div style={{ width: 4, height: "100%", minHeight: 80, background: brand.color, borderRadius: 4, boxShadow: `0 0 0 3px ${brand.color}44`, position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                <div style={{ width: 24, height: 24, borderRadius: "50%", background: brand.color, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3, position: "absolute" }}>
                                  <span style={{ color: "#fff", fontSize: 14, fontWeight: 900, lineHeight: 1 }}>+</span>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      {sorted.map((t, i) => {
                        const sc =
                            STATUS_CONFIG[t.status] ||
                            STATUS_CONFIG["Not Started"],
                          days = getDaysUntilForPhase(t.due, t.phase),
                          isOver = days < 0 && t.status !== "Complete",
                          isPL =
                            t.phase === "Line Review" ||
                            t.phase === "Compliance/Testing",
                          isDDP = t.phase === "DDP",
                          isShip = t.phase === "Ship Date";
                        const assignee =
                          team.find((m) => m.id === t.assigneeId) || null;
                        const countdownColor = isOver
                          ? "#B91C1C"
                          : days <= 7
                          ? "#B45309"
                          : days <= 14
                          ? "#D97706"
                          : "#065F46";
                        const countdownLabel =
                          t.status === "Complete"
                            ? "Done"
                            : isOver
                            ? `${fmtDays(Math.abs(days))} over`
                            : days === 0
                            ? "Today"
                            : fmtDays(days);
                        const isDraggingThis = dragId === t.id;
                        const gapKey = `${bid}-${cname}-gap-${i}`;
                        const isGapActive = dragOverId === gapKey;

                        // Days from concept (first task) to this task
                        // Post-PO phases count calendar days; pre-PO count business days
                        const conceptTask = sorted[0];
                        const daysFromConcept = conceptTask
                          ? diffDaysForPhase(t.due, conceptTask.due, t.phase)
                          : 0;

                        // Days from previous task to this task (same logic)
                        const prevTask = sorted[i - 1];
                        const daysFromPrev = prevTask
                          ? diffDaysForPhase(t.due, prevTask.due, t.phase)
                          : null;

                        return (
                          <div
                            key={t.id}
                            style={{
                              display: "flex",
                              alignItems: "stretch",
                              flexShrink: 0,
                            }}
                          >
                            {/* ── CARD ── */}
                            <div
                              draggable={true}
                              onDragStart={(e) => {
                                e.dataTransfer.effectAllowed = "move";
                                e.dataTransfer.setData("text/plain", t.id);
                                setTimeout(() => setDragId(t.id), 0);
                              }}
                              onDragEnd={() => {
                                setDragId(null);
                                setDragOverId(null);
                              }}
                              onClick={() => {
                                if (!dragId) setEditTask(t);
                              }}
                              style={{
                                minWidth: 94,
                                textAlign: "center",
                                background: isDDP
                                  ? "#FFF5F5"
                                  : isShip
                                  ? "#F5FDFB"
                                  : isPL
                                  ? "#F9F8FF"
                                  : `${brand.color}08`,
                                border: `2px solid ${
                                  isDDP
                                    ? TH.primary
                                    : isShip
                                    ? "#10B981"
                                    : isPL
                                    ? "#8B5CF6"
                                    : brand.color + "44"
                                }`,
                                borderRadius: 10,
                                cursor: "pointer",
                                boxShadow: `0 2px 6px ${TH.shadow}`,
                                opacity: isDraggingThis ? 0.3 : 1,
                                transition: "opacity 0.15s",
                                userSelect: "none",
                                overflow: "hidden",
                              }}
                            >
                              {/* Drag handle */}
                              <div
                                style={{
                                  background: isDDP
                                    ? TH.primary + "22"
                                    : isShip
                                    ? "#10B98122"
                                    : isPL
                                    ? "#8B5CF622"
                                    : brand.color + "22",
                                  borderBottom: `1px solid ${brand.color}22`,
                                  padding: "4px 6px 3px",
                                  cursor: "grab",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  gap: 3,
                                }}
                              >
                                {[0, 1, 2, 3, 4].map((d) => (
                                  <div
                                    key={d}
                                    style={{
                                      width: 3,
                                      height: 3,
                                      borderRadius: "50%",
                                      background: brand.color + "99",
                                    }}
                                  />
                                ))}
                              </div>
                              <div style={{ padding: "6px 10px 8px" }}>
                                <div
                                  style={{
                                    fontSize: 13,
                                    color: TH.text,
                                    fontWeight: 700,
                                    marginBottom: 3,
                                  }}
                                >
                                  {t.phase}
                                </div>
                                {isPL && (
                                  <div
                                    style={{
                                      fontSize: 9,
                                      color: "#6D28D9",
                                      marginBottom: 2,
                                      fontWeight: 700,
                                    }}
                                  >
                                    PL REQ
                                  </div>
                                )}
                                <div
                                  style={{
                                    fontSize: 11,
                                    padding: "2px 6px",
                                    borderRadius: 5,
                                    background: sc.bg,
                                    color: sc.color,
                                    display: "inline-block",
                                    marginBottom: 4,
                                    fontWeight: 600,
                                  }}
                                >
                                  {t.status}
                                </div>
                                <div
                                  style={{
                                    fontSize: 10,
                                    color: TH.textMuted,
                                    fontWeight: 500,
                                    marginBottom: 1,
                                  }}
                                >
                                  Due
                                </div>
                                <div
                                  style={{
                                    fontSize: 11,
                                    color: isOver
                                      ? "#B91C1C"
                                      : days <= 7
                                      ? "#B45309"
                                      : TH.textMuted,
                                    fontWeight: 600,
                                    marginBottom: 6,
                                  }}
                                >
                                  {formatDate(t.due)}
                                </div>

                                {/* Days section — matches design */}
                                <div
                                  style={{
                                    borderTop: `1px solid ${brand.color}22`,
                                    paddingTop: 6,
                                  }}
                                >
                                  <div
                                    style={{
                                      fontSize: 8,
                                      color: TH.textMuted,
                                      fontWeight: 600,
                                      textTransform: "uppercase",
                                      letterSpacing: "0.08em",
                                      marginBottom: 4,
                                    }}
                                  >
                                    To Complete
                                  </div>
                                  <div style={{ marginBottom: 6 }}>
                                    <div
                                      style={{
                                        fontSize: 13,
                                        fontWeight: 800,
                                        color: countdownColor,
                                        background: countdownColor + "18",
                                        borderRadius: 6,
                                        padding: "2px 8px",
                                        display: "inline-block",
                                      }}
                                    >
                                      {countdownLabel}
                                    </div>
                                  </div>
                                  <div
                                    style={{
                                      fontSize: 8,
                                      color: TH.textMuted,
                                      fontWeight: 600,
                                      textTransform: "uppercase",
                                      letterSpacing: "0.08em",
                                      marginBottom: 2,
                                    }}
                                  >
                                    From Last Task
                                  </div>
                                  <div
                                    style={{
                                      fontSize: 13,
                                      fontWeight: 700,
                                      color:
                                        daysFromPrev != null && daysFromPrev < 0
                                          ? "#B91C1C"
                                          : TH.textSub2,
                                    }}
                                  >
                                    {daysFromPrev == null
                                      ? "—"
                                      : fmtDays(daysFromPrev)}
                                  </div>
                                </div>

                                {assignee && (
                                  <div
                                    style={{
                                      display: "flex",
                                      justifyContent: "center",
                                      marginTop: 5,
                                    }}
                                  >
                                    <Avatar member={assignee} size={16} />
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* ── DROP ZONE between cards ── */}
                            {i < sorted.length - 1 && (
                              <div
                                onDragOver={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  if (dragOverId !== gapKey)
                                    setDragOverId(gapKey);
                                }}
                                onDragEnter={(e) => {
                                  e.preventDefault();
                                  setDragOverId(gapKey);
                                }}
                                onDragLeave={(e) => {
                                  if (
                                    !e.currentTarget.contains(
                                      e.relatedTarget as Node
                                    )
                                  )
                                    setDragOverId(null);
                                }}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  const droppedId =
                                    e.dataTransfer.getData("text/plain") ||
                                    dragId;
                                  if (!droppedId) return;
                                  const prevTask = sorted[i];
                                  const nextTask = sorted[i + 1];
                                  const prevMs = parseLocalDate(prevTask.due).getTime();
                                  const nextMs = parseLocalDate(nextTask.due).getTime();
                                  const midMs = Math.round((prevMs + nextMs) / 2);
                                  const mid = new Date(midMs);
                                  const droppedTaskMid = tasks.find(x => x.id === droppedId);
                                  // Post-PO phases use calendar days; pre-PO snap to business day
                                  let newDue = droppedTaskMid && isPostPO(droppedTaskMid.phase)
                                    ? toDateStr(mid)
                                    : snapToBusinessDay(toDateStr(mid));
                                  // Enforce minimum 1 calendar day from each neighbor
                                  if (newDue <= prevTask.due) newDue = addDays(prevTask.due, 1);
                                  if (newDue >= nextTask.due) newDue = addDays(nextTask.due, -1);
                                  if (newDue <= prevTask.due) newDue = prevTask.due; // fallback
                                  const droppedTask = tasks.find(x => x.id === droppedId);
                                  if (droppedTask) {
                                    pushUndo(tasks, 'drag');
                                    const updated = { ...droppedTask, due: newDue };
                                    setTasks(ts => ts.map(x => x.id === droppedId ? updated : x));
                                    sbSaveTask(updated);
                                  }
                                  setDragId(null);
                                  setDragOverId(null);
                                }}
                                style={{
                                  width: isGapActive ? 52 : 28,
                                  minHeight: "100%",
                                  flexShrink: 0,
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  cursor: "copy",
                                  transition: "width 0.12s",
                                  position: "relative",
                                  zIndex: 2,
                                }}
                              >
                                {isGapActive ? (
                                  <div
                                    style={{
                                      width: 4,
                                      height: "100%",
                                      minHeight: 80,
                                      background: brand.color,
                                      borderRadius: 4,
                                      boxShadow: `0 0 0 3px ${brand.color}44`,
                                      position: "relative",
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                    }}
                                  >
                                    <div
                                      style={{
                                        width: 24,
                                        height: 24,
                                        borderRadius: "50%",
                                        background: brand.color,
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        boxShadow: `0 0 0 4px ${brand.color}33`,
                                        zIndex: 3,
                                        position: "absolute",
                                      }}
                                    >
                                      <span
                                        style={{
                                          color: "#fff",
                                          fontSize: 14,
                                          fontWeight: 900,
                                          lineHeight: 1,
                                          marginTop: -1,
                                        }}
                                      >
                                        +
                                      </span>
                                    </div>
                                  </div>
                                ) : (
                                  <div
                                    style={{
                                      width: "100%",
                                      height: 4,
                                      background: dragId
                                        ? brand.color + "66"
                                        : brand.color + "33",
                                      borderRadius: 2,
                                      transition: "background 0.15s",
                                    }}
                                  />
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  };

  // ── CALENDAR VIEW ──────────────────────────────────────────────────────────
  const CalendarView = () => {
    const today = new Date();
    // Use parent-level state so month persists when task modal opens/closes
    const cy = calViewYear, setCy = setCalViewYear;
    const cm = calViewMonth, setCm = setCalViewMonth;
    const [calDragOver, setCalDragOver] = useState(null); // dateString being hovered
    const fd = new Date(cy, cm, 1).getDay(),
      dim = new Date(cy, cm + 1, 0).getDate();
    const cells = [
      ...Array(fd).fill(null),
      ...Array.from({ length: dim }, (_, i) => i + 1),
    ];
    const ds = (d) =>
      `${cy}-${String(cm + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const src = focusCollKey
      ? tasks.filter((t) => `${t.brand}||${t.collection}` === focusCollKey)
      : filtered;

    function handleCalDrop(dateStr) {
      if (!dragId || !dateStr) return;
      setTasks((ts) =>
        ts.map((t) => (t.id === dragId ? { ...t, due: dateStr } : t))
      );
      setDragId(null);
      setCalDragOver(null);
    }

    return (
      <div>
        {dragId && (
          <div
            style={{
              marginBottom: 10,
              padding: "7px 14px",
              background: "#EFF6FF",
              border: "1px solid #BFDBFE",
              borderRadius: 8,
              fontSize: 12,
              color: "#1D4ED8",
              fontWeight: 600,
            }}
          >
            ✋ Drag a task to a day to reschedule
          </div>
        )}

        {/* ── Unified calendar header ── */}
        <div
          style={{
            background: `linear-gradient(135deg, ${TH.header} 0%, #2D3748 100%)`,
            borderRadius: 14,
            padding: "14px 20px 0",
            marginBottom: 4,
            boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
          }}
        >
          {/* Top row: collection filter + month nav */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 14,
            }}
          >
            {/* Left: collection label */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {focusCollKey ? (
                <>
                  <span
                    style={{
                      fontSize: 11,
                      color: "rgba(255,255,255,0.45)",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                    }}
                  >
                    Showing
                  </span>
                  <span
                    style={{ fontSize: 13, fontWeight: 800, color: "#fff" }}
                  >
                    {focusCollKey.split("||")[1]}
                  </span>
                  <button
                    onClick={() => setFocusCollKey(null)}
                    style={{
                      padding: "3px 10px",
                      borderRadius: 20,
                      border: "1px solid rgba(255,255,255,0.2)",
                      background: "rgba(255,255,255,0.08)",
                      color: "rgba(255,255,255,0.6)",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 10,
                      fontWeight: 600,
                    }}
                  >
                    ✕ Show All
                  </button>
                </>
              ) : (
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: "rgba(255,255,255,0.5)",
                    letterSpacing: "0.04em",
                  }}
                >
                  All Collections
                </span>
              )}
            </div>

            {/* Center: month navigation */}
            <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
              <button
                onClick={() => {
                  if (cm === 0) {
                    setCm(11);
                    setCy((y) => y - 1);
                  } else setCm((m) => m - 1);
                }}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "8px 0 0 8px",
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderRight: "none",
                  background: "rgba(255,255,255,0.07)",
                  color: "rgba(255,255,255,0.8)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 16,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "rgba(255,255,255,0.14)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "rgba(255,255,255,0.07)")
                }
              >
                ‹
              </button>
              <div
                style={{
                  padding: "0 22px",
                  height: 32,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "1px solid rgba(255,255,255,0.15)",
                  background: "rgba(255,255,255,0.05)",
                  minWidth: 160,
                }}
              >
                <span
                  style={{
                    fontSize: 15,
                    fontWeight: 800,
                    color: "#fff",
                    letterSpacing: "-0.01em",
                  }}
                >
                  {MONTHS[cm]}
                </span>
                <span
                  style={{
                    fontSize: 15,
                    fontWeight: 400,
                    color: "rgba(255,255,255,0.5)",
                    marginLeft: 8,
                  }}
                >
                  {cy}
                </span>
              </div>
              <button
                onClick={() => {
                  if (cm === 11) {
                    setCm(0);
                    setCy((y) => y + 1);
                  } else setCm((m) => m + 1);
                }}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "0 8px 8px 0",
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderLeft: "none",
                  background: "rgba(255,255,255,0.07)",
                  color: "rgba(255,255,255,0.8)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 16,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "rgba(255,255,255,0.14)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "rgba(255,255,255,0.07)")
                }
              >
                ›
              </button>
            </div>

            {/* Right: today button */}
            <button
              onClick={() => {
                setCy(today.getFullYear());
                setCm(today.getMonth());
              }}
              style={{
                padding: "5px 14px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "rgba(255,255,255,0.07)",
                color: "rgba(255,255,255,0.65)",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 11,
                fontWeight: 600,
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "rgba(255,255,255,0.14)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "rgba(255,255,255,0.07)")
              }
            >
              Today
            </button>
          </div>

          {/* Day headers */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7,1fr)",
              gap: 4,
            }}
          >
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => {
              const isWeekend = i === 0 || i === 6;
              return (
                <div
                  key={d}
                  style={{
                    textAlign: "center",
                    padding: "6px 0 8px",
                    fontSize: 10,
                    color: isWeekend
                      ? "rgba(255,255,255,0.3)"
                      : "rgba(255,255,255,0.5)",
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    fontWeight: 700,
                  }}
                >
                  {d}
                </div>
              );
            })}
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(7,1fr)",
            gap: 4,
          }}
        >
          {cells.map((d, i) => {
            const dateStr = d ? ds(d) : null;
            const dt = d ? src.filter((t) => t.due === ds(d)) : [];
            const isToday =
              d && new Date(ds(d)).toDateString() === today.toDateString();
            const isDragTarget = dateStr && calDragOver === dateStr;
            return (
              <div
                key={i}
                onDragOver={(e) => {
                  if (!d || !dragId) return;
                  e.preventDefault();
                  e.stopPropagation();
                  if (calDragOver !== dateStr) setCalDragOver(dateStr);
                }}
                onDragEnter={(e) => {
                  if (!d || !dragId) return;
                  e.preventDefault();
                  setCalDragOver(dateStr);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node))
                    setCalDragOver(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleCalDrop(dateStr);
                }}
                style={{
                  minHeight: 90,
                  padding: 6,
                  background: isDragTarget
                    ? "#DBEAFE"
                    : d
                    ? "#E8ECF0"
                    : "transparent",
                  border: `1px solid ${
                    isDragTarget
                      ? "#3B82F6"
                      : isToday
                      ? TH.primary
                      : d
                      ? "#C8D0DA"
                      : "transparent"
                  }`,
                  borderTop: isDragTarget
                    ? `3px solid #3B82F6`
                    : isToday
                    ? `3px solid ${TH.primary}`
                    : d
                    ? `1px solid #C8D0DA`
                    : "none",
                  borderRadius: 8,
                  boxShadow: d ? `0 1px 3px ${TH.shadow}` : "none",
                  transition: "background 0.1s, border-color 0.1s",
                }}
              >
                {d && (
                  <div
                    style={{
                      fontSize: 13.8,
                      color: isDragTarget
                        ? "#1D4ED8"
                        : isToday
                        ? TH.primary
                        : TH.textMuted,
                      fontWeight: isDragTarget || isToday ? 800 : 400,
                      marginBottom: 4,
                    }}
                  >
                    {d}
                    {isDragTarget && (
                      <span style={{ fontSize: 10, marginLeft: 4 }}>📅</span>
                    )}
                  </div>
                )}
                {dt.slice(0, 3).map((t) => {
                  const b = getBrand(t.brand),
                    assignee = team.find((m) => m.id === t.assigneeId),
                    isDDP = t.phase === "DDP";
                  const collKey = `${t.brand}||${t.collection}`;
                  const collMeta = collections[collKey] || {};
                  const isBeingDragged = dragId === t.id;
                  return (
                    <div
                      key={t.id}
                      draggable
                      onDragStart={(e) => {
                        e.stopPropagation();
                        setDragId(t.id);
                        setCalDragOver(null);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setCalDragOver(null);
                      }}
                      onClick={() => {
                        if (!dragId) setEditTask(t);
                      }}
                      style={{
                        fontSize: 11.5,
                        background: isBeingDragged ? "#F3F4F6" : "#FFFFFF",
                        borderLeft: `3px solid ${b.color}`,
                        padding: "3px 6px",
                        borderRadius: 4,
                        marginBottom: 3,
                        cursor: isBeingDragged ? "grabbing" : "grab",
                        color: "#1A202C",
                        fontWeight: isDDP ? 700 : 500,
                        boxShadow: "0 1px 3px rgba(0,0,0,0.10)",
                        opacity: isBeingDragged ? 0.4 : 1,
                        transition: "opacity 0.12s",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                        }}
                      >
                        <span style={{ fontWeight: 700, color: "#1A202C" }}>
                          {isDDP ? "🎯 " : ""}
                          {b.short} {t.phase}
                        </span>
                        {assignee && <Avatar member={assignee} size={13} />}
                      </div>
                      <div
                        style={{
                          fontSize: 10.5,
                          color: "#4A5568",
                          marginTop: 1,
                          lineHeight: 1.4,
                        }}
                      >
                        {t.collection} · {t.season}
                        {collMeta.year ? ` ${collMeta.year}` : ""} ·{" "}
                        {t.category}
                        {collMeta.customer ? ` · ${collMeta.customer}` : ""}
                        {isDDP ? ` · DDP: ${formatDate(t.due)}` : ""}
                      </div>
                    </div>
                  );
                })}
                {dt.length > 3 && (
                  <div
                    style={{
                      fontSize: 11.5,
                      color: TH.textMuted,
                      fontWeight: 600,
                    }}
                  >
                    +{dt.length - 3} more
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

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

      {/* Filter bar */}
      <FilterBar
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
      />

      <div
        style={{ padding: "26px 22px 100px", maxWidth: 1440, margin: "0 auto" }}
      >
        {view === "dashboard" && <Dashboard />}
        {view === "timeline" && <Timeline />}
        {view === "calendar" && <CalendarView />}
        {view === "teams" && (
          <TeamsView
            collList={collList}
            collMap={collMap}
            isAdmin={isAdmin}
            teamsConfig={teamsConfig}
            setTeamsConfig={setTeamsConfig}
            teamsToken={teamsToken}
            setTeamsToken={setTeamsToken}
            showTeamsConfig={showTeamsConfig}
            setShowTeamsConfig={setShowTeamsConfig}
            getBrand={getBrand}
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
            setTasks((ts) => [...ts, newTask]);
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
