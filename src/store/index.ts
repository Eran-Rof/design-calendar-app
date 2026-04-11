/**
 * Zustand store for the Design Calendar app.
 *
 * Phase 1: UI slice only (absorbs dcReducer). Data state and business
 * logic remain in App.tsx and migrate in subsequent phases.
 *
 * Usage in components:
 *   const view = useAppStore(s => s.view);
 *   const setView = useAppStore(s => s.setField);
 *   setView("view", "timeline");
 */
import { create } from "zustand";
import { sbSave, sbLoad, sbSaveTask, sbDeleteTask, sbLoadTasks, sbSaveCollection, sbLoadCollections } from "./supabaseService";
import { addDays, parseLocalDate, formatDate } from "../utils/dates";
import type { Task, Brand, Vendor, Customer, TeamMember, User, CollectionMeta, UndoEntry } from "./types";

// ── Types ──────────────────────────────────────────────────────────────────

function loadTeamsConfig() {
  try { return JSON.parse(localStorage.getItem("teamsConfig") || "null") || { clientId: "", tenantId: "", channelMap: {} }; }
  catch { return { clientId: "", tenantId: "", channelMap: {} }; }
}

export interface UIState {
  // View
  view: string;
  listView: boolean;
  expandedColl: string | null;
  focusCollKey: any;
  timelineBackFilter: string | null;
  showNav: boolean;
  statFilter: string | null;
  // Filters
  filterBrand: Set<string>;
  filterSeason: Set<string>;
  filterCustomer: Set<string>;
  filterVendor: Set<string>;
  // Modals
  showWizard: boolean;
  showVendors: boolean;
  showTeam: boolean;
  showUsers: boolean;
  showSizeLib: boolean;
  showCatLib: boolean;
  showAddTask: boolean;
  showBrands: boolean;
  showSeasons: boolean;
  showCustomers: boolean;
  showOrderTypes: boolean;
  showRoles: boolean;
  showGenders: boolean;
  showActivity: boolean;
  showTaskManager: boolean;
  showTeamsConfig: boolean;
  showEmailConfig: boolean;
  // Edit/Drag
  editTask: any;
  dragId: any;
  dragOverId: any;
  ctxMenu: any;
  editCollKey: any;
  pendingDeleteColl: string | null;
  // Calendar
  calViewYear: number;
  calViewMonth: number;
  calDragOver: string | null;
  miniCalDragOver: any;
  // Undo
  undoStack: UndoEntry[];
  undoConfirm: { prevTasks: Task[]; taskId: string; description?: string } | null;
  // Teams/Email
  teamsConfig: any;
  teamsToken: any;
  teamsTokenExpiry: any;
  // Core
  globalLog: any[];
  idleWarning: boolean;
  saveErr: string;
  dbxLoaded: boolean;
}

export interface DataState {
  // Reference data (persisted to Supabase key-value store)
  users: User[];
  currentUser: User | null;
  brands: Brand[];
  seasons: string[];
  customers: (Customer | string)[];
  vendors: Vendor[];
  team: TeamMember[];
  tasks: Task[];
  collections: Record<string, CollectionMeta>;
  sizeLibrary: any[];
  categoryLib: any[];
  orderTypes: string[];
  roles: any[];
  genders: string[];
  genderSizes: Record<string, string[]>;
  taskTemplates: any[];
  // Internal
  _hydrating: boolean;
}

export interface UIActions {
  /** Generic field setter — replaces dcReducer's SET action */
  setField: <K extends keyof (UIState & DataState)>(field: K, value: (UIState & DataState)[K]) => void;
  /** Close all modals at once */
  closeAllModals: () => void;
  /** Push an undo entry */
  pushUndo: (entry: UIState["undoStack"][0]) => void;
  /** Pop the most recent undo entry */
  popUndo: () => void;
}

export interface DataActions {
  // Persisted reference data setters (auto-save unless _hydrating)
  setRefData: (key: string, field: keyof DataState, value: any) => void;
  // Tasks with diff-and-persist
  setTasks: (updater: any[] | ((prev: any[]) => any[])) => void;
  setTasksRaw: (tasks: any[]) => void;
  // Collections with diff-and-persist
  setCollections: (updater: Record<string, any> | ((prev: Record<string, any>) => Record<string, any>)) => void;
  setCollectionsRaw: (collections: Record<string, any>) => void;
  // Hydrate all data from Supabase
  loadAll: () => Promise<void>;
}

export interface BusinessActions {
  // Task CRUD
  saveTask: (task: Task) => void;
  quietSaveTask: (task: Task) => void;
  deleteTask: (id: string) => void;
  saveCascade: (updatedTasks: Task[]) => void;
  addCollection: (newTasks: Task[], meta: Record<string, any>) => void;
  // Undo
  pushUndoEntry: (prevTasks: Task[], type: "card" | "drag", taskId?: string, newTask?: Task) => void;
  handleUndo: () => void;
  // Drag
  handleDrop: (targetId: string) => void;
  handleTimelineDrop: (targetId: string, sortedCollTasks: Task[]) => void;
}

export type AppStore = UIState & DataState & UIActions & DataActions & BusinessActions;

// ── Store ──────────────────────────────────────────────────────────────────

export const useAppStore = create<AppStore>()((set, get) => ({
  // ── Initial UI state ──
  view: "dashboard",
  listView: false,
  expandedColl: null,
  focusCollKey: null,
  timelineBackFilter: null,
  showNav: true,
  statFilter: null,
  filterBrand: new Set(),
  filterSeason: new Set(),
  filterCustomer: new Set(),
  filterVendor: new Set(),
  showWizard: false,
  showVendors: false,
  showTeam: false,
  showUsers: false,
  showSizeLib: false,
  showCatLib: false,
  showAddTask: false,
  showBrands: false,
  showSeasons: false,
  showCustomers: false,
  showOrderTypes: false,
  showRoles: false,
  showGenders: false,
  showActivity: false,
  showTaskManager: false,
  showTeamsConfig: false,
  showEmailConfig: false,
  editTask: null,
  dragId: null,
  dragOverId: null,
  ctxMenu: null,
  editCollKey: null,
  pendingDeleteColl: null,
  calViewYear: new Date().getFullYear(),
  calViewMonth: new Date().getMonth(),
  calDragOver: null,
  miniCalDragOver: null,
  undoStack: [],
  undoConfirm: null,
  teamsConfig: loadTeamsConfig(),
  teamsToken: null,
  teamsTokenExpiry: null,
  globalLog: [],
  idleWarning: false,
  saveErr: "",
  dbxLoaded: false,

  // ── Initial data state ──
  users: [],
  currentUser: (() => { try { const p = sessionStorage.getItem("plm_user"); return p ? JSON.parse(p) : null; } catch { return null; } })(),
  brands: [],
  seasons: [],
  customers: [],
  vendors: [],
  team: [],
  tasks: [],
  collections: {},
  sizeLibrary: [],
  categoryLib: [],
  orderTypes: [],
  roles: [],
  genders: [],
  genderSizes: {},
  taskTemplates: [],
  _hydrating: false,

  // ── UI Actions ──
  setField: (field, value) => set({ [field]: value } as any),

  closeAllModals: () => set({
    showWizard: false, showVendors: false, showTeam: false, showUsers: false,
    showSizeLib: false, showCatLib: false, showAddTask: false, showBrands: false,
    showSeasons: false, showCustomers: false, showOrderTypes: false, showRoles: false,
    showGenders: false, showActivity: false, showTaskManager: false,
    showTeamsConfig: false, showEmailConfig: false,
    editTask: null, editCollKey: null, ctxMenu: null,
  }),

  pushUndo: (entry) => set((s) => ({
    undoStack: [entry, ...s.undoStack].slice(0, 4),
  })),

  popUndo: () => set((s) => ({
    undoStack: s.undoStack.slice(1),
  })),

  // ── Data Actions ──
  setRefData: (key, field, value) => {
    set({ [field]: value } as any);
    if (!get()._hydrating) sbSave(key, value).catch(e => console.error("[Store] save error:", key, e));
  },

  setTasks: (updater) => {
    const prev = get().tasks;
    const next = typeof updater === "function" ? updater(prev) : updater;
    set({ tasks: next });
    // Diff and persist
    if (!get()._hydrating && Array.isArray(next) && Array.isArray(prev)) {
      const userName = get().currentUser?.name || "";
      next.forEach(t => {
        const old = prev.find((p: any) => p.id === t.id);
        if (!old || JSON.stringify(old) !== JSON.stringify(t)) {
          sbSaveTask(t, userName).catch(e => console.error("[Store] save task:", e));
        }
      });
      prev.forEach(t => {
        if (!next.find((n: any) => n.id === t.id)) {
          sbDeleteTask(t.id).catch(e => console.error("[Store] delete task:", e));
        }
      });
    }
  },

  setTasksRaw: (tasks) => set({ tasks }),

  setCollections: (updater) => {
    const prev = get().collections;
    const next = typeof updater === "function" ? updater(prev) : updater;
    set({ collections: next });
    if (!get()._hydrating) {
      const userName = get().currentUser?.name || "";
      Object.entries(next).forEach(([key, val]) => {
        if (JSON.stringify(prev[key] || {}) !== JSON.stringify(val)) {
          sbSaveCollection(key, val, userName).catch(e => console.error("[Store] save collection:", e));
        }
      });
    }
  },

  setCollectionsRaw: (collections) => set({ collections }),

  loadAll: async () => {
    set({ _hydrating: true });
    console.log("[SB] loadAll starting...");
    try {
      const [
        users, brands, seasons, customers, vendors, team,
        sizes, categories, orderTypes, rolesData, taskTemplatesData,
        gendersData, genderSizesData,
        tasks, collections,
      ] = await Promise.all([
        sbLoad("users"), sbLoad("brands"), sbLoad("seasons"),
        sbLoad("customers"), sbLoad("vendors"), sbLoad("team"),
        sbLoad("size_library"), sbLoad("categories"), sbLoad("order_types"),
        sbLoad("roles"), sbLoad("task_templates"),
        sbLoad("genders"), sbLoad("gender_sizes"),
        sbLoadTasks(), sbLoadCollections(),
      ]);
      set({
        ...(users ? { users } : {}),
        ...(brands ? { brands } : {}),
        ...(seasons ? { seasons } : {}),
        ...(customers ? { customers } : {}),
        ...(vendors ? { vendors } : {}),
        ...(team ? { team } : {}),
        ...(sizes ? { sizeLibrary: sizes } : {}),
        ...(categories ? { categoryLib: categories } : {}),
        ...(orderTypes ? { orderTypes } : {}),
        ...(rolesData ? { roles: rolesData } : {}),
        ...(taskTemplatesData ? { taskTemplates: taskTemplatesData } : {}),
        ...(gendersData ? { genders: gendersData } : {}),
        ...(genderSizesData ? { genderSizes: genderSizesData } : {}),
        ...(tasks?.length ? { tasks } : {}),
        ...(collections && Object.keys(collections).length ? { collections } : {}),
      });
      console.log("[SB] loadAll complete");
    } catch (e) {
      console.error("[SB] loadAll error:", e);
    }
    set({ _hydrating: false, dbxLoaded: true });
  },

  // ── Business Actions ──

  pushUndoEntry: (prevTasks, type, taskId, newTask) => {
    let description = "";
    if (type === "card" && taskId && newTask) {
      const oldTask = prevTasks.find((t: any) => t.id === taskId);
      if (oldTask && newTask) {
        const parts: string[] = [];
        if (oldTask.status !== newTask.status) parts.push(`status: "${oldTask.status}" → "${newTask.status}"`);
        if (oldTask.due !== newTask.due) parts.push(`due date: ${formatDate(oldTask.due)} → ${formatDate(newTask.due)}`);
        if (oldTask.vendorName !== newTask.vendorName) parts.push(`vendor: "${oldTask.vendorName}" → "${newTask.vendorName}"`);
        description = parts.length > 0 ? parts.join(", ") : "card edited";
      }
    } else if (type === "drag") {
      description = "card position moved";
    }
    set((s) => ({ undoStack: [{ prevTasks, type, taskId, description }, ...s.undoStack].slice(0, 4) }));
  },

  handleUndo: () => {
    const { undoStack, tasks } = get();
    if (undoStack.length === 0) return;
    const [entry, ...rest] = undoStack;
    set({ undoStack: rest });
    const userName = get().currentUser?.name || "";
    if (entry.type === "drag") {
      get().setTasks(entry.prevTasks);
      entry.prevTasks.forEach((t: any) => sbSaveTask(t, userName).catch(() => {}));
    } else {
      set({ undoConfirm: { prevTasks: entry.prevTasks, taskId: entry.taskId!, description: entry.description } });
      const task = tasks.find((t: any) => t.id === entry.taskId);
      if (task) set({ editTask: task });
    }
  },

  saveTask: (task) => {
    const s = get();
    s.pushUndoEntry(s.tasks, "card", task.id, task);
    const clean = { ...task };
    s.setTasks((ts: any[]) => ts.map((t: any) => t.id === clean.id ? clean : t));
    set({ editTask: null, undoConfirm: null });
  },

  quietSaveTask: (task) => {
    const clean = { ...task };
    get().setTasks((ts: any[]) => ts.map((t: any) => t.id === clean.id ? clean : t));
  },

  deleteTask: (id) => {
    const s = get();
    const dying = s.tasks.find((t: any) => t.id === id);
    if (dying) {
      set({ globalLog: [...s.globalLog, {
        id: `${Date.now()}-task-del`, field: "task deleted", from: dying.phase, to: null,
        changedBy: s.currentUser?.name || "Unknown", at: new Date().toISOString(),
        taskPhase: dying.phase, taskCollection: dying.collection, taskBrand: dying.brand,
      }] });
    }
    s.setTasks((ts: any[]) => ts.filter((t: any) => t.id !== id));
    set({ editTask: null });
  },

  saveCascade: (updatedTasks) => {
    const s = get();
    s.pushUndoEntry(s.tasks, "drag");
    s.setTasks(updatedTasks);
  },

  addCollection: (newTasks, meta) => {
    const s = get();
    const key = `${newTasks[0].brand}||${newTasks[0].collection}`;
    const tasksWithImages = newTasks.map((t: any) => ({ ...t, images: t.images || [] }));
    s.setCollections((prev: any) => ({ ...prev, [key]: { ...(prev[key] || {}), ...meta } }));
    s.setTasks((ts: any[]) => [...ts, ...tasksWithImages]);
    set({ globalLog: [...s.globalLog, {
      id: `${Date.now()}-coll-create`, field: "collection created", from: null,
      to: newTasks[0].collection, changedBy: s.currentUser?.name || "Unknown",
      at: new Date().toISOString(), taskCollection: newTasks[0].collection, taskBrand: newTasks[0].brand,
    }], showWizard: false, view: "timeline" });
  },

  handleDrop: (targetId) => {
    const s = get();
    if (!s.dragId || s.dragId === targetId) return;
    s.pushUndoEntry(s.tasks, "drag");
    s.setTasks((ts: any[]) => {
      const a = ts.find((t: any) => t.id === s.dragId);
      const b = ts.find((t: any) => t.id === targetId);
      if (!a || !b) return ts;
      return ts.map((t: any) => t.id === s.dragId ? { ...t, due: b.due } : t.id === targetId ? { ...t, due: a.due } : t);
    });
    set({ dragId: null, dragOverId: null });
  },

  handleTimelineDrop: (targetId, sortedCollTasks) => {
    const s = get();
    if (!s.dragId || s.dragId === targetId) return;
    s.pushUndoEntry(s.tasks, "drag");
    s.setTasks((ts: any[]) => {
      const dragged = ts.find((t: any) => t.id === s.dragId);
      if (!dragged) return ts;
      const targetIdx = sortedCollTasks.findIndex((t: any) => t.id === targetId);
      if (targetIdx < 0) return ts;
      const prev = sortedCollTasks[targetIdx - 1];
      const next = sortedCollTasks[targetIdx];
      let newDue: string;
      if (prev && next) {
        const prevMs = parseLocalDate(prev.due).getTime();
        const nextMs = parseLocalDate(next.due).getTime();
        const mid = new Date(Math.round((prevMs + nextMs) / 2));
        newDue = `${mid.getFullYear()}-${String(mid.getMonth() + 1).padStart(2, "0")}-${String(mid.getDate()).padStart(2, "0")}`;
      } else if (!prev && next) { newDue = addDays(next.due, -1); }
      else if (prev && !next) { newDue = addDays(prev.due, 1); }
      else { newDue = dragged.due; }
      return ts.map((t: any) => t.id === s.dragId ? { ...t, due: newDue } : t);
    });
    set({ dragId: null, dragOverId: null });
  },
}));
