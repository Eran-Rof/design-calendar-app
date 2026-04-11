/**
 * Tanda store — sync slice.
 *
 * Mirrors the SyncContext + syncReducer state shape. Provides individual
 * setters for every field plus the batch actions (syncStart, syncComplete,
 * etc.) that the reducer used to coalesce renders.
 */
import type { StateCreator } from "zustand";
import type { SyncFilters } from "../../utils/tandaTypes";
import type { SyncState, SyncLogEntry } from "../state/sync/syncTypes";
import { initialSyncState } from "../state/sync/syncTypes";
import type { TandaStore } from "./index";

export interface SyncSlice extends SyncState {
  setSyncField: <K extends keyof SyncState>(field: K, value: SyncState[K]) => void;
  // Batch actions
  syncStart: () => void;
  syncProgressUpdate: (progress: number, msg: string) => void;
  syncComplete: (added: number, changed: number, deleted: number, lastSync: string) => void;
  syncFail: (err: string) => void;
  syncReset: () => void;
  appendSyncLog: (entry: SyncLogEntry) => void;
}

export const createSyncSlice: StateCreator<TandaStore, [], [], SyncSlice> = (set) => ({
  ...initialSyncState,

  setSyncField: (field, value) => set({ [field]: value } as any),

  syncStart: () => set({
    syncing: true,
    syncErr: "",
    syncDone: null,
    syncProgress: 0,
    syncProgressMsg: "Connecting to Xoro…",
  }),

  syncProgressUpdate: (progress, msg) => set({ syncProgress: progress, syncProgressMsg: msg }),

  syncComplete: (added, changed, deleted, lastSync) => set({
    syncing: false,
    syncDone: { added, changed, deleted },
    syncProgress: 100,
    syncProgressMsg: "Complete",
    lastSync,
  }),

  syncFail: (err) => set({
    syncing: false,
    syncErr: err,
    syncProgress: 0,
    syncProgressMsg: "",
  }),

  syncReset: () => set({
    syncing: false,
    syncProgress: 0,
    syncProgressMsg: "",
    syncDone: null,
  }),

  appendSyncLog: (entry) => set((s) => ({
    syncLog: [entry, ...s.syncLog].slice(0, 10),
  })),
});
