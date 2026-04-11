/**
 * Zustand store for the PO WIP (Tanda) app.
 *
 * Phase 0+1: scaffolding only. The store mirrors the existing context-based
 * state shape (CoreContext / SyncContext / EmailContext / TeamsContext) so
 * that Phase 2 can bridge the contexts to this store without changing
 * behavior. Phases 3-5 will switch reads, move actions in, and remove the
 * provider trees.
 *
 * Usage (post-bridge):
 *   const selected = useTandaStore(s => s.selected);
 *   const setSelected = useTandaStore(s => s.setCoreField);
 *   setSelected("selected", po);
 */
import { create } from "zustand";
import { createCoreSlice, type CoreSlice } from "./coreSlice";
import { createSyncSlice, type SyncSlice } from "./syncSlice";
import { createEmailSlice, type EmailSlice } from "./emailSlice";
import { createTeamsSlice, type TeamsSlice } from "./teamsSlice";

export type TandaStore = CoreSlice & SyncSlice & EmailSlice & TeamsSlice;

export const useTandaStore = create<TandaStore>()((...a) => ({
  ...createCoreSlice(...a),
  ...createSyncSlice(...a),
  ...createEmailSlice(...a),
  ...createTeamsSlice(...a),
}));
