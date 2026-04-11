/**
 * Tanda store — core slice.
 *
 * Mirrors the existing CoreContext + coreReducer state shape so that Phase 2
 * can bridge the context to this slice without behavior change. Eventually
 * the context provider goes away and TandA.tsx reads directly from the store.
 */
import type { StateCreator } from "zustand";
import type { XoroPO, Milestone, LocalNote, User, DCVendor, View } from "../../utils/tandaTypes";
import type { DetailMode, AttachmentEntry, CoreState } from "../state/core/coreTypes";
import { initialCoreState } from "../state/core/coreTypes";
import type { TandaStore } from "./index";

export interface CoreSlice extends CoreState {
  setCoreField: <K extends keyof CoreState>(field: K, value: CoreState[K]) => void;
  selectPo: (po: XoroPO | null, mode?: DetailMode) => void;
  setMilestonesForPo: (poNumber: string, milestones: Milestone[]) => void;
  updateMilestone: (poNumber: string, milestoneId: string, milestone: Milestone) => void;
  deleteMilestonesForPo: (poNumber: string) => void;
  setAttachmentsForPo: (poNumber: string, attachments: AttachmentEntry[]) => void;
  updateAttachment: (poNumber: string, attachId: string, entry: AttachmentEntry) => void;
  removePo: (poNumber: string) => void;
}

export const createCoreSlice: StateCreator<TandaStore, [], [], CoreSlice> = (set) => ({
  ...initialCoreState,

  setCoreField: (field, value) => set({ [field]: value } as any),

  selectPo: (po, mode) => set({ selected: po, detailMode: mode ?? "po" }),

  setMilestonesForPo: (poNumber, milestones) => set((s) => ({
    milestones: { ...s.milestones, [poNumber]: milestones },
  })),

  updateMilestone: (poNumber, milestoneId, milestone) => set((s) => {
    const arr = [...(s.milestones[poNumber] || [])];
    const idx = arr.findIndex((x) => x.id === milestoneId);
    if (idx >= 0) arr[idx] = milestone;
    else arr.push(milestone);
    return { milestones: { ...s.milestones, [poNumber]: arr } };
  }),

  deleteMilestonesForPo: (poNumber) => set((s) => {
    const next = { ...s.milestones };
    delete next[poNumber];
    return { milestones: next };
  }),

  setAttachmentsForPo: (poNumber, attachments) => set((s) => ({
    attachments: { ...s.attachments, [poNumber]: attachments },
  })),

  updateAttachment: (poNumber, attachId, entry) => set((s) => {
    const files = (s.attachments[poNumber] || []).map((a) => (a.id === attachId ? entry : a));
    return { attachments: { ...s.attachments, [poNumber]: files } };
  }),

  removePo: (poNumber) => set((s) => ({
    pos: s.pos.filter((p) => (p.PoNumber ?? "") !== poNumber),
    notes: s.notes.filter((n) => n.po_number !== poNumber),
    milestones: (() => { const next = { ...s.milestones }; delete next[poNumber]; return next; })(),
  })),
});
