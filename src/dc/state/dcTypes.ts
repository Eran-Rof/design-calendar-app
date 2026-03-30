export interface DCState {
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
  // Core data
  globalLog: any[];
  idleWarning: boolean;
  saveErr: string;
  dbxLoaded: boolean;
}

export type DCAction =
  | { type: "SET"; field: keyof DCState; value: any }
  | { type: "CLOSE_ALL_MODALS" }
  | { type: "PUSH_UNDO"; entry: DCState["undoStack"][0] }
  | { type: "POP_UNDO" };

function loadTeamsConfig() {
  try { return JSON.parse(localStorage.getItem("teamsConfig") || "null") || { clientId: "", tenantId: "", channelMap: {} }; }
  catch { return { clientId: "", tenantId: "", channelMap: {} }; }
}

export const initialDCState: DCState = {
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
};
