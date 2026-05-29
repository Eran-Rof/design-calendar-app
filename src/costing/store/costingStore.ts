// Costing Module — Zustand store
//
// Owns the saved-projects list + the currently-loaded project (header + lines
// + vendor quotes + compliance keyed by line id). Actions delegate to
// services/costingApi.ts.

import { create } from "zustand";
import * as api from "../services/costingApi";
import { fetchLyComp, fetchT3Comp } from "../services/compService";
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
  selectedLineId: string | null;
  loading: boolean;
  error: string | null;

  listProjects: () => Promise<void>;
  loadProject: (id: string) => Promise<void>;
  createProject: (draft: CostingProjectDraft) => Promise<CostingProject>;
  updateProject: (id: string, patch: CostingProjectPatch) => Promise<CostingProject>;
  deleteProject: (id: string) => Promise<void>;
  clearActive: () => void;

  // Line actions
  addLine: (seed?: Partial<CostingLine>) => Promise<CostingLine | null>;
  updateLine: (id: string, patch: Partial<CostingLine>) => Promise<void>;
  deleteLine: (id: string) => Promise<void>;
  reorderLines: (idOrder: string[]) => Promise<void>;
  setSelectedLine: (id: string | null) => void;

  // Vendor quote actions
  loadVendorQuotes: (lineId: string) => Promise<void>;
  addQuote: (lineId: string, draft: api.QuoteDraft) => Promise<CostingLineVendor | null>;
  updateQuote: (lineId: string, quoteId: string, patch: Partial<api.QuoteDraft>) => Promise<void>;
  deleteQuote: (lineId: string, quoteId: string) => Promise<void>;
  selectQuote: (lineId: string, quoteId: string) => Promise<void>;

  /**
   * Chunk 5 — Refresh LY + T3 comp snapshots for the given lines (or all
   * lines if "all"). Fires the two comp endpoints in parallel, then PUTs
   * each affected line via the existing /lines/[line_id] handler so the
   * grid reads the new ly_* / t3_* / comp_refreshed_at columns from the
   * row without re-fetching. Lines without a style_code are skipped.
   */
  refreshComp: (lineIds: string[] | "all") => Promise<void>;
};

export const useCostingStore = create<State>((set, get) => ({
  projects: [],
  project: null,
  lines: [],
  vendorQuotes: {},
  compliance: {},
  selectedLineId: null,
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
    set({ project: null, lines: [], vendorQuotes: {}, compliance: {}, selectedLineId: null });
  },

  // ── Lines ─────────────────────────────────────────────────────────────────

  async addLine(seed) {
    const project = get().project;
    if (!project) return null;
    const lines = get().lines;
    const seedRow = {
      ...(seed || {}),
      sort_order: typeof seed?.sort_order === "number" ? seed.sort_order : lines.length,
    };
    try {
      const created = await api.upsertLines(project.id, [seedRow]);
      const newLine = created[0];
      if (newLine) {
        set((s) => ({ lines: [...s.lines, newLine] }));
        return newLine;
      }
      return null;
    } catch (e) {
      set({ error: (e as Error).message });
      return null;
    }
  },

  async updateLine(id, patch) {
    // Optimistic local update so the grid feels responsive.
    set((s) => ({
      lines: s.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    }));
    try {
      const updated = await api.updateLine(id, patch);
      set((s) => ({
        lines: s.lines.map((l) => (l.id === id ? updated : l)),
      }));
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  async deleteLine(id) {
    const prev = get().lines;
    set({ lines: prev.filter((l) => l.id !== id) });
    try {
      await api.deleteLine(id);
      set((s) => {
        const nextQuotes = { ...s.vendorQuotes };
        delete nextQuotes[id];
        const nextCompliance = { ...s.compliance };
        delete nextCompliance[id];
        return {
          vendorQuotes: nextQuotes,
          compliance: nextCompliance,
          selectedLineId: s.selectedLineId === id ? null : s.selectedLineId,
        };
      });
    } catch (e) {
      // Rollback on failure.
      set({ lines: prev, error: (e as Error).message });
    }
  },

  async reorderLines(idOrder) {
    const project = get().project;
    if (!project) return;
    const byId = new Map(get().lines.map((l) => [l.id, l] as const));
    const next = idOrder.map((id, i) => {
      const row = byId.get(id);
      return row ? { ...row, sort_order: i } : null;
    }).filter((r): r is CostingLine => r !== null);
    set({ lines: next });
    try {
      await api.upsertLines(
        project.id,
        next.map((l) => ({ id: l.id, sort_order: l.sort_order })),
      );
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  setSelectedLine(id) {
    set({ selectedLineId: id });
    if (id && !get().vendorQuotes[id]) {
      get().loadVendorQuotes(id);
    }
  },

  // ── Vendor quotes ─────────────────────────────────────────────────────────

  async loadVendorQuotes(lineId) {
    try {
      const quotes = await api.listQuotes(lineId);
      set((s) => ({ vendorQuotes: { ...s.vendorQuotes, [lineId]: quotes } }));
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  async addQuote(lineId, draft) {
    try {
      const created = await api.createQuote(lineId, draft);
      set((s) => ({
        vendorQuotes: {
          ...s.vendorQuotes,
          [lineId]: [created, ...(s.vendorQuotes[lineId] || [])],
        },
      }));
      return created;
    } catch (e) {
      set({ error: (e as Error).message });
      return null;
    }
  },

  async updateQuote(lineId, quoteId, patch) {
    try {
      const updated = await api.updateQuote(lineId, quoteId, patch);
      set((s) => ({
        vendorQuotes: {
          ...s.vendorQuotes,
          [lineId]: (s.vendorQuotes[lineId] || []).map((q) => (q.id === quoteId ? updated : q)),
        },
      }));
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  async deleteQuote(lineId, quoteId) {
    try {
      await api.deleteQuote(lineId, quoteId);
      set((s) => ({
        vendorQuotes: {
          ...s.vendorQuotes,
          [lineId]: (s.vendorQuotes[lineId] || []).filter((q) => q.id !== quoteId),
        },
      }));
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  async selectQuote(lineId, quoteId) {
    try {
      const result = await api.selectQuote(lineId, quoteId);
      set((s) => ({
        lines: s.lines.map((l) => (l.id === lineId ? result.line : l)),
        vendorQuotes: {
          ...s.vendorQuotes,
          [lineId]: (s.vendorQuotes[lineId] || []).map((q) => {
            if (q.id === quoteId) return { ...q, status: "selected" };
            if (q.status === "selected") return { ...q, status: "received" };
            return q;
          }),
        },
      }));
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  async refreshComp(lineIds) {
    const state = get();
    const targetLines = lineIds === "all"
      ? state.lines
      : state.lines.filter((l) => lineIds.includes(l.id));
    // Group target lines by style_code so each style is queried once and the
    // resulting aggregate is fanned out to every line that shares the code.
    const styleToLineIds = new Map<string, string[]>();
    for (const ln of targetLines) {
      if (!ln.style_code) continue;
      const arr = styleToLineIds.get(ln.style_code) || [];
      arr.push(ln.id);
      styleToLineIds.set(ln.style_code, arr);
    }
    const styleCodes = Array.from(styleToLineIds.keys());
    if (styleCodes.length === 0) return;

    set({ loading: true, error: null });
    try {
      const [ly, t3] = await Promise.all([
        fetchLyComp(styleCodes),
        fetchT3Comp(styleCodes),
      ]);
      const refreshedAt = new Date().toISOString();

      // Build per-line patches keyed by line_id, then PUT each one. Persist
      // sequentially so the order of patches matches the visual order of
      // the grid — small N (≤ a few dozen lines per project in practice).
      const updates: CostingLine[] = [];
      for (const [styleCode, ids] of styleToLineIds.entries()) {
        const lyAgg = ly[styleCode];
        const t3Agg = t3[styleCode];
        const patch: Partial<CostingLine> = {
          ly_qty: lyAgg ? lyAgg.qty : null,
          ly_unit_cost: lyAgg ? lyAgg.weighted_unit_cost : null,
          ly_total_margin: lyAgg && typeof lyAgg.total_margin === "number" ? lyAgg.total_margin : null,
          ly_margin_pct: lyAgg ? lyAgg.weighted_margin_pct : null,
          t3_qty: t3Agg ? t3Agg.qty : null,
          t3_unit_cost: t3Agg ? t3Agg.weighted_unit_cost : null,
          t3_total_cost: t3Agg && typeof t3Agg.total_cost === "number" ? t3Agg.total_cost : null,
          t3_margin_pct: t3Agg ? t3Agg.weighted_margin_pct : null,
          comp_refreshed_at: refreshedAt,
        };
        for (const id of ids) {
          // eslint-disable-next-line no-await-in-loop
          const updated = await api.updateLine(id, patch);
          updates.push(updated);
        }
      }

      // Splice the updated lines back into the array in place.
      set((s) => ({
        lines: s.lines.map((existing) => {
          const u = updates.find((x) => x.id === existing.id);
          return u ? u : existing;
        }),
        loading: false,
      }));
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
      throw e;
    }
  },
}));

// Selectors-as-hooks (for component readability).
export const useCostingLoading = () => useCostingStore((s) => s.loading);
export const useCostingError   = () => useCostingStore((s) => s.error);
