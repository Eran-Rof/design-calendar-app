/**
 * Core data model types for the Design Calendar app.
 * Used by the Zustand store, panels, and components.
 */

export interface Task {
  id: string;
  brand: string;
  collection: string;
  season: string;
  category: string;
  phase: string;
  due: string; // YYYY-MM-DD
  status: string;
  assigneeId?: string;
  assigneeName?: string;
  vendorName?: string;
  customer?: string;
  orderType?: string;
  channelType?: string;
  history?: HistoryEntry[];
  images?: string[];
  notes?: string;
  updatedAt?: string;
  updatedBy?: string;
  ddpDate?: string;
  [key: string]: any; // allow additional dynamic fields
}

export interface HistoryEntry {
  id: string;
  field: string;
  from: any;
  to: any;
  changedBy: string;
  at: string;
  taskPhase?: string;
  taskCollection?: string;
  taskBrand?: string;
}

export interface Brand {
  id: string;
  name: string;
  short?: string;
  color: string;
  isPrivateLabel?: boolean;
}

export interface Vendor {
  id: string;
  name: string;
  country?: string;
  transitDays?: number;
  categories?: string[];
  contact?: string;
  email?: string;
  moq?: string;
  leadOverrides?: Record<string, number>;
  wipLeadOverrides?: Record<string, number>;
}

export interface Customer {
  name: string;
  channel?: string;
}

export interface TeamMember {
  id: string;
  name: string;
  role?: string;
  email?: string;
  avatar?: string;
}

export interface User {
  name: string;
  role?: string;
  permissions?: {
    view_all?: boolean;
  };
  teamMemberId?: string;
}

export interface CollectionMeta {
  skus?: any[];
  customer?: string;
  orderType?: string;
  channelType?: string;
  customerShipDate?: string;
  cancelDate?: string;
  ddpDate?: string;
  gender?: string;
  year?: number;
  sampleDueDate?: string;
  conceptImages?: string[];
  [key: string]: any;
}

export interface CollectionGroup {
  brand: string;
  collection: string;
  season: string;
  category: string;
  vendorName: string;
  tasks: Task[];
  key: string;
}

export interface UndoEntry {
  prevTasks: Task[];
  type: "card" | "drag";
  taskId?: string;
  description?: string;
}

/** Fallback brand used when getBrand() returns null */
export const UNKNOWN_BRAND: Brand = {
  id: "unknown",
  name: "Unknown",
  short: "?",
  color: "#6B7280",
};
