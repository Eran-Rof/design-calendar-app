/**
 * Tanda store — teams slice.
 *
 * Mirrors the TeamsContext + teamsReducer state shape, including the two
 * reset actions for the channel-DM and detail-panel-DM compose forms.
 */
import type { StateCreator } from "zustand";
import type { TeamsState } from "../state/teams/teamsTypes";
import { initialTeamsState } from "../state/teams/teamsTypes";
import type { TandaStore } from "./index";

export interface TeamsSlice extends TeamsState {
  setTeamsField: <K extends keyof TeamsState>(field: K, value: TeamsState[K]) => void;
  teamsResetDm: () => void;
  teamsResetDtlDm: () => void;
}

export const createTeamsSlice: StateCreator<TandaStore, [], [], TeamsSlice> = (set) => ({
  ...initialTeamsState,

  setTeamsField: (field, value) => set({ [field]: value } as any),

  teamsResetDm: () => set({
    teamsDirectTo: "",
    teamsDirectMsg: "",
    teamsDirectSending: false,
    teamsDirectErr: null,
  }),

  teamsResetDtlDm: () => set({
    dtlDMTo: "",
    dtlDMMsg: "",
    dtlDMSending: false,
    dtlDMErr: null,
    dtlDMContactSearch: "",
    dtlDMContactDropdown: false,
    dtlDMContactSearchResults: [],
    dtlDMContactSearchLoading: false,
  }),
});
