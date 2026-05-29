// Costing Module — Zustand store
//
// Owns the saved-projects list + the currently-loaded project (header + lines
// + vendor quotes + compliance keyed by line id). Actions delegate to
// services/costingApi.ts.

import { create } from "zustand";
import * as api from "../services/costingApi";
import type {
  CostingProject,
  CostingLine,
  CostingLineVendor,
  CostingLineCompliance,
  CostingProjectDraft,
  CostingProjectPatch,
} from "../types";

type State = {
  projects: CostingProject[];
  project: CostingProject | null;
  lines: CostingLine[];
  vendorQuotes: Record<string, CostingLineVendor[]>;
  compliance: Record<string, CostingLineCompliance[]>;
  loading: boolean;
  error: string | null;

  listProjects: () => Promise<void>;
  loadProject: (id: string) => Promise<void>;
  createProject: (draft: CostingProjectDraft) => Promise<CostingProject>;
  updateProject: (id: string, patch: CostingProjectPatch) => Promise<CostingProject>;
  deleteProject: (id: string) => Promise<void>;
  clearActive: () => void;
};

export const useCostingStore = create<State>((set, get) => ({
  projects: [],
  project: null,
  lines: [],
  vendorQuotes: {},
  compliance: {},
  loading: false,
  error: null,

  async listProjects() {
    set({ loading: true, error: null });
    try {
      const projects = await api.listProjects();
      set({ projects, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  async loadProject(id) {
    set({ loading: true, error: null });
    try {
      const detail = await api.getProject(id);
      set({
        project: detail.project,
        lines: detail.lines,
        vendorQuotes: detail.vendor_quotes_by_line_id,
        compliance: detail.compliance_by_line_id,
        loading: false,
      });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  async createProject(draft) {
    set({ loading: true, error: null });
    try {
      const project = await api.createProject(draft);
      set((s) => ({
        projects: [project, ...s.projects],
        project,
        lines: [],
        vendorQuotes: {},
        compliance: {},
        loading: false,
      }));
      return project;
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
      throw e;
    }
  },

  async updateProject(id, patch) {
    set({ loading: true, error: null });
    try {
      const updated = await api.updateProject(id, patch);
      set((s) => ({
        project: s.project?.id === id ? updated : s.project,
        projects: s.projects.map((p) => (p.id === id ? updated : p)),
        loading: false,
      }));
      return updated;
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
      throw e;
    }
  },

  async deleteProject(id) {
    set({ loading: true, error: null });
    try {
      await api.deleteProject(id);
      set((s) => ({
        projects: s.projects.filter((p) => p.id !== id),
        project: s.project?.id === id ? null : s.project,
        lines: s.project?.id === id ? [] : s.lines,
        vendorQuotes: s.project?.id === id ? {} : s.vendorQuotes,
        compliance: s.project?.id === id ? {} : s.compliance,
        loading: false,
      }));
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
      throw e;
    }
  },

  clearActive() {
    set({ project: null, lines: [], vendorQuotes: {}, compliance: {} });
  },
}));

// Selectors-as-hooks (for component readability).
export const useCostingLoading = () => useCostingStore((s) => s.loading);
export const useCostingError   = () => useCostingStore((s) => s.error);
