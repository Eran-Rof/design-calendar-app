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

export interface UIActions {
  /** Generic field setter — replaces dcReducer's SET action */
  setField: <K extends keyof UIState>(field: K, value: UIState[K]) => void;
  /** Close all modals at once */
  closeAllModals: () => void;
  /** Push an undo entry */
  pushUndo: (entry: UIState["undoStack"][0]) => void;
  /** Pop the most recent undo entry */
  popUndo: () => void;
}

export type AppStore = UIState & UIActions;

// ── Store ──────────────────────────────────────────────────────────────────

export const useAppStore = create<AppStore>()((set) => ({
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

  // ── Actions ──
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
}));
