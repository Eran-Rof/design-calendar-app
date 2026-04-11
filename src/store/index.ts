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
  undoStack: Array<{ prevTasks: any[]; type: "card" | "drag"; taskId?: string; description?: string }>;
  undoConfirm: { prevTasks: any[]; taskId: string; description?: string } | null;
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
  users: any[];
  currentUser: any;
  brands: any[];
  seasons: any[];
  customers: any[];
  vendors: any[];
  team: any[];
  tasks: any[];
  collections: Record<string, any>;
  sizeLibrary: any[];
  categoryLib: any[];
  orderTypes: any[];
  roles: any[];
  genders: any[];
  genderSizes: Record<string, any>;
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
  setTasksRaw: (tasks: any[]) => void; // skip persistence (for hydration/realtime)
  // Collections with diff-and-persist
  setCollections: (updater: Record<string, any> | ((prev: Record<string, any>) => Record<string, any>)) => void;
  setCollectionsRaw: (collections: Record<string, any>) => void;
  // Hydrate all data from Supabase
  loadAll: () => Promise<void>;
}

export type AppStore = UIState & DataState & UIActions & DataActions;

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
}));
