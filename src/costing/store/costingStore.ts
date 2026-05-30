// Costing Module — Zustand store
//
// Owns the saved-projects list + the currently-loaded project (header + lines
// + vendor quotes + compliance keyed by line id). Actions delegate to
// services/costingApi.ts.

import { create } from "zustand";
import * as api from "../services/costingApi";
import { fetchLyComp, fetchT3Comp } from "../services/compService";
import { sbLoad as sbLoadSvc, sbSave as sbSaveSvc } from "../../store/supabaseService";
import type {
  CostingProject,
  CostingLine,
  CostingLineVendor,
  CostingLineCompliance,
  CostingProjectDraft,
  CostingProjectPatch,
} from "../types";

export type MasterKind = "fit" | "closure" | "waist" | "comment" | "compliance" | "fabric";
export interface MasterEntry { id: string; name: string }

const MASTER_KEY: Record<MasterKind, string> = {
  fit:        "costing_fits",
  closure:    "costing_closures",
  waist:      "costing_waists",
  comment:    "costing_comments",
  compliance: "costing_compliance_codes",
  // Fabric master is owned by costing for now (app_data JSON blob). When
  // Tangerine's fabric_codes table is fully populated, a one-time backfill
  // will merge costing_fabrics → fabric_codes and we can drop this master.
  // The FabricPickerCell already shows the union of fabric_codes (DB) +
  // costing_fabrics (this master) so operators see everything available.
  fabric:     "costing_fabrics",
};

// Default compliance codes seeded the first time the master is loaded empty.
// Matches the CompliancePanel "Seed defaults" set so the operator doesn't
// have to type these in by hand. They can edit/delete from Settings later.
const DEFAULT_COMPLIANCE_CODES = ["CPSIA", "PROP65", "FLAMMABILITY", "LABEL_FIBER_CONTENT", "COO"];

const newId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `m_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);

type State = {
  projects: CostingProject[];
  project: CostingProject | null;
  lines: CostingLine[];
  vendorQuotes: Record<string, CostingLineVendor[]>;
  compliance: Record<string, CostingLineCompliance[]>;
  selectedLineId: string | null;
  // Chunk 6 — Plan Flow widget filters the grid by per-line stage.
  // Null = no filter (show all lines). Stage names are derived in usePlanFlow.
  stageFilter: string | null;
  setStageFilter: (stage: string | null) => void;
  // In-app toast notice (replaces window.alert across the costing UI; same
  // visual language as App.tsx's saveErr toast).
  notice: { message: string; level: "error" | "info" } | null;
  setNotice: (message: string, level?: "error" | "info") => void;
  clearNotice: () => void;
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

  // Compliance actions (Chunk 7)
  loadCompliance: (lineId: string) => Promise<void>;
  addCompliance: (lineId: string, draft: api.ComplianceDraft) => Promise<CostingLineCompliance | null>;
  updateCompliance: (lineId: string, reqId: string, patch: Partial<api.ComplianceDraft>) => Promise<void>;
  deleteCompliance: (lineId: string, reqId: string) => Promise<void>;

  // Masters (Fit / Closure / Waist / Comment lists, stored as JSON blobs in
  // app_data — same pattern as brands/seasons/customers used by the other
  // apps in the suite). Color is intentionally NOT a master — autocomplete
  // sources from ip_item_master.color via /api/internal/costing/search/colors
  // and operator-added extras (costing_extra_colors).
  masters: Record<MasterKind, MasterEntry[]>;
  loadMasters: () => Promise<void>;
  addMaster: (kind: MasterKind, name: string) => Promise<void>;
  deleteMaster: (kind: MasterKind, id: string) => Promise<void>;

  // Operator-added extra colors (saved to app_data.costing_extra_colors so
  // /search/colors will pick them up next reload).
  extraColors: string[];
  addExtraColor: (name: string) => Promise<void>;

  // Pre-loaded vendor list for the grid's vendor picker. Loaded once on
  // grid mount (small, <100 active vendors typically). Same pattern the
  // planning grid uses for its color picker — pre-load the options so
  // the popover renders immediately without an async wait.
  vendorsForPicker: api.VendorHit[];
  loadVendorsForPicker: () => Promise<void>;
};

export const useCostingStore = create<State>((set, get) => ({
  projects: [],
  project: null,
  lines: [],
  vendorQuotes: {},
  compliance: {},
  selectedLineId: null,
  stageFilter: null,
  setStageFilter(stage) { set({ stageFilter: stage }); },
  notice: null,
  setNotice(message, level = "error") { set({ notice: { message, level } }); },
  clearNotice() { set({ notice: null }); },
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
      // Surface the cost-write outcome so the operator gets explicit feedback
      // instead of a silent "did it work?" — matches the toast pattern in
      // ColorPickerCell + VendorPickerCell add-flows.
      const picked = (get().vendorQuotes[lineId] || []).find((q) => q.id === quoteId);
      const vendorLabel = picked?.vendor?.legal_name || picked?.vendor?.code || "vendor";
      if (result.cost_write_error) {
        get().setNotice(
          `Awarded ${vendorLabel}, but the cost-write to ip_item_avg_cost failed: ${result.cost_write_error}. Re-select the quote to retry.`,
          "error",
        );
      } else if (result.cost_write_reason === "no_skus_for_style") {
        get().setNotice(
          `Awarded ${vendorLabel}. Skipped cost-write — no SKUs under this style in ip_item_master yet (cost will land once Xoro seeds the master).`,
          "info",
        );
      } else if (result.cost_write_reason === "no_style_code") {
        get().setNotice(`Awarded ${vendorLabel}. Skipped cost-write — line has no style code.`, "info");
      } else if (result.cost_write_reason === "non_usd_currency") {
        get().setNotice(`Awarded ${vendorLabel}. Skipped cost-write — quote is in a non-USD currency.`, "info");
      } else if (result.cost_write_count > 0) {
        const missing = result.cost_write_missing_count;
        const tail = missing > 0 ? ` (${missing} SKU${missing === 1 ? "" : "s"} skipped — not yet in cost master)` : "";
        get().setNotice(
          `Awarded ${vendorLabel} — wrote cost to ${result.cost_write_count} SKU${result.cost_write_count === 1 ? "" : "s"}${tail}.`,
          "info",
        );
      } else {
        get().setNotice(`Awarded ${vendorLabel}.`, "info");
      }
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  async refreshComp(lineIds) {
    const state = get();
    const targetLines = lineIds === "all"
      ? state.lines
      : state.lines.filter((l) => lineIds.includes(l.id));
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

  // ── Compliance (Chunk 7) ──────────────────────────────────────────────────

  async loadCompliance(lineId) {
    try {
      const rows = await api.listCompliance(lineId);
      set((s) => ({ compliance: { ...s.compliance, [lineId]: rows } }));
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  async addCompliance(lineId, draft) {
    try {
      const created = await api.createCompliance(lineId, draft);
      set((s) => ({
        compliance: {
          ...s.compliance,
          [lineId]: [...(s.compliance[lineId] || []), created],
        },
      }));
      return created;
    } catch (e) {
      set({ error: (e as Error).message });
      return null;
    }
  },

  async updateCompliance(lineId, reqId, patch) {
    try {
      const updated = await api.updateCompliance(lineId, reqId, patch);
      set((s) => ({
        compliance: {
          ...s.compliance,
          [lineId]: (s.compliance[lineId] || []).map((r) => (r.id === reqId ? updated : r)),
        },
      }));
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  async deleteCompliance(lineId, reqId) {
    try {
      await api.deleteCompliance(lineId, reqId);
      set((s) => ({
        compliance: {
          ...s.compliance,
          [lineId]: (s.compliance[lineId] || []).filter((r) => r.id !== reqId),
        },
      }));
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  // ── Masters (app_data JSON blobs) ─────────────────────────────────────────

  masters: { fit: [], closure: [], waist: [], comment: [], compliance: [], fabric: [] },
  extraColors: [],

  async loadMasters() {
    try {
      const [fit, closure, waist, comment, compliance, fabric, extras] = await Promise.all([
        sbLoadSvc(MASTER_KEY.fit),
        sbLoadSvc(MASTER_KEY.closure),
        sbLoadSvc(MASTER_KEY.waist),
        sbLoadSvc(MASTER_KEY.comment),
        sbLoadSvc(MASTER_KEY.compliance),
        sbLoadSvc(MASTER_KEY.fabric),
        sbLoadSvc("costing_extra_colors"),
      ]);
      // Compliance is auto-seeded the first time it loads empty so the
      // grid dropdown isn't blank for new operators. Persisted immediately
      // so this only happens once per entity.
      let complianceList: MasterEntry[] = Array.isArray(compliance) ? (compliance as MasterEntry[]) : [];
      if (complianceList.length === 0) {
        complianceList = DEFAULT_COMPLIANCE_CODES.map((name) => ({ id: newId(), name }));
        try { await sbSaveSvc(MASTER_KEY.compliance, complianceList); } catch { /* non-blocking */ }
      }
      set({
        masters: {
          fit:        Array.isArray(fit)     ? (fit as MasterEntry[])     : [],
          closure:    Array.isArray(closure) ? (closure as MasterEntry[]) : [],
          waist:      Array.isArray(waist)   ? (waist as MasterEntry[])   : [],
          comment:    Array.isArray(comment) ? (comment as MasterEntry[]) : [],
          compliance: complianceList,
          fabric:     Array.isArray(fabric)  ? (fabric as MasterEntry[])  : [],
        },
        extraColors: Array.isArray(extras) ? (extras as string[]) : [],
      });
    } catch (e) {
      set({ error: `loadMasters: ${(e as Error).message}` });
    }
  },

  async addMaster(kind, name) {
    const clean = name.trim();
    if (!clean) return;
    const current = get().masters[kind] || [];
    if (current.some((m) => m.name.toLowerCase() === clean.toLowerCase())) return;
    const next = [...current, { id: newId(), name: clean }];
    set((s) => ({ masters: { ...s.masters, [kind]: next } }));
    try { await sbSaveSvc(MASTER_KEY[kind], next); }
    catch (e) { set({ error: `addMaster: ${(e as Error).message}` }); }
  },

  async deleteMaster(kind, id) {
    const next = (get().masters[kind] || []).filter((m) => m.id !== id);
    set((s) => ({ masters: { ...s.masters, [kind]: next } }));
    try { await sbSaveSvc(MASTER_KEY[kind], next); }
    catch (e) { set({ error: `deleteMaster: ${(e as Error).message}` }); }
  },

  async addExtraColor(name) {
    const clean = name.trim();
    if (!clean) return;
    const current = get().extraColors;
    if (current.some((c) => c.toLowerCase() === clean.toLowerCase())) return;
    const next = [...current, clean].sort();
    set({ extraColors: next });
    try { await sbSaveSvc("costing_extra_colors", next); }
    catch (e) { set({ error: `addExtraColor: ${(e as Error).message}` }); }
  },

  // ── Vendor picker pre-load ────────────────────────────────────────────────

  vendorsForPicker: [],

  async loadVendorsForPicker() {
    try {
      const rows = await api.searchVendors("", { limit: 500 });
      set({ vendorsForPicker: rows });
    } catch (e) {
      set({ error: `loadVendorsForPicker: ${(e as Error).message}` });
    }
  },
}));

// Selectors-as-hooks (for component readability).
export const useCostingLoading = () => useCostingStore((s) => s.loading);
export const useCostingError   = () => useCostingStore((s) => s.error);
