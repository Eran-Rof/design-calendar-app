import "../../store/__tests__/setup";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock React's useRef to work without a rendering environment
vi.mock("react", () => ({
  useRef: (initial: any) => ({ current: initial }),
}));

import { useMilestoneOps } from "../useMilestoneOps";
import { useTandaStore } from "../../store/index";
import type { Milestone, WipTemplate } from "../../../utils/tandaTypes";
import { DEFAULT_WIP_TEMPLATES } from "../../../utils/tandaTypes";

// ── Helpers ────────────────────────────────────────────────────────────────

const initialState = useTandaStore.getState();

function makeMilestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: "ms_test1",
    po_number: "PO-001",
    phase: "Lab Dip / Strike Off",
    category: "Pre-Production",
    sort_order: 0,
    days_before_ddp: 120,
    expected_date: "2026-04-01",
    actual_date: null,
    status: "Not Started",
    status_date: null,
    status_dates: null,
    notes: "",
    note_entries: null,
    variant_statuses: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    updated_by: "tester",
    ...overrides,
  };
}

function createMockSb() {
  const selectFn = vi.fn().mockResolvedValue({ data: [], error: null });
  const insertFn = vi.fn().mockResolvedValue({ data: [], error: null });
  const upsertFn = vi.fn().mockResolvedValue({ data: [], error: null });
  const deleteFn = vi.fn().mockResolvedValue({ error: null });
  const singleFn = vi.fn().mockResolvedValue({ data: null, error: null });

  const sb = {
    from: vi.fn().mockReturnValue({
      select: selectFn,
      insert: insertFn,
      upsert: upsertFn,
      delete: deleteFn,
      single: singleFn,
    }),
    // Expose inner mocks for easy assertion
    _select: selectFn,
    _insert: insertFn,
    _upsert: upsertFn,
    _delete: deleteFn,
    _single: singleFn,
  };
  return sb;
}

function createDeps(sbOverride?: ReturnType<typeof createMockSb>) {
  const sb = sbOverride ?? createMockSb();
  return {
    sb: sb as any,
    addHistory: vi.fn(),
    setConfirmModal: vi.fn(),
    setCollapsedCats: vi.fn(),
    acceptedBlocked: new Set<string>(),
    _sb: sb,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("useMilestoneOps", () => {
  beforeEach(() => {
    useTandaStore.setState(initialState, true);
  });

  // ── loadAllMilestones ──────────────────────────────────────────────────

  describe("loadAllMilestones", () => {
    it("fetches milestones from Supabase and populates store grouped by PO", async () => {
      const deps = createDeps();
      const ms1 = makeMilestone({ id: "ms_a", po_number: "PO-001", sort_order: 1 });
      const ms2 = makeMilestone({ id: "ms_b", po_number: "PO-001", sort_order: 0 });
      const ms3 = makeMilestone({ id: "ms_c", po_number: "PO-002", sort_order: 0 });

      deps._sb._select.mockResolvedValueOnce({
        data: [
          { id: "ms_a", data: ms1 },
          { id: "ms_b", data: ms2 },
          { id: "ms_c", data: ms3 },
        ],
        error: null,
      });

      const ops = useMilestoneOps(deps);
      await ops.loadAllMilestones();

      const state = useTandaStore.getState();
      expect(state.milestones["PO-001"]).toHaveLength(2);
      // Should be sorted by sort_order (0 before 1)
      expect(state.milestones["PO-001"][0].id).toBe("ms_b");
      expect(state.milestones["PO-001"][1].id).toBe("ms_a");
      expect(state.milestones["PO-002"]).toHaveLength(1);
      expect(deps._sb.from).toHaveBeenCalledWith("tanda_milestones");
    });

    it("handles empty data gracefully", async () => {
      const deps = createDeps();
      deps._sb._select.mockResolvedValueOnce({ data: [], error: null });

      const ops = useMilestoneOps(deps);
      await ops.loadAllMilestones();

      const state = useTandaStore.getState();
      expect(state.milestones).toEqual({});
    });
  });

  // ── loadMilestones ─────────────────────────────────────────────────────

  describe("loadMilestones", () => {
    it("fetches and returns milestones for a single PO", async () => {
      const deps = createDeps();
      const ms1 = makeMilestone({ id: "ms_a", po_number: "PO-001", sort_order: 1 });
      const ms2 = makeMilestone({ id: "ms_b", po_number: "PO-001", sort_order: 0 });
      const msOther = makeMilestone({ id: "ms_c", po_number: "PO-002" });

      deps._sb._select.mockResolvedValueOnce({
        data: [
          { id: "ms_a", data: ms1 },
          { id: "ms_b", data: ms2 },
          { id: "ms_c", data: msOther },
        ],
        error: null,
      });

      const ops = useMilestoneOps(deps);
      const result = await ops.loadMilestones("PO-001");

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("ms_b"); // sorted by sort_order
      expect(result[1].id).toBe("ms_a");
    });

    it("returns empty array when no data", async () => {
      const deps = createDeps();
      deps._sb._select.mockResolvedValueOnce({ data: null, error: "err" });

      const ops = useMilestoneOps(deps);
      const result = await ops.loadMilestones("PO-001");
      expect(result).toEqual([]);
    });
  });

  // ── saveMilestone ──────────────────────────────────────────────────────

  describe("saveMilestone", () => {
    it("saves milestone to Supabase and updates store", async () => {
      const deps = createDeps();
      // No conflict — single returns null (new milestone)
      deps._sb._single.mockResolvedValueOnce({ data: null, error: null });

      const ms = makeMilestone();
      // Pre-populate store with existing milestone
      useTandaStore.getState().setMilestonesForPo("PO-001", [ms]);

      const ops = useMilestoneOps(deps);
      const updated = { ...ms, status: "In Progress" };
      await ops.saveMilestone(updated);

      expect(deps._sb._upsert).toHaveBeenCalled();
      const storeMs = useTandaStore.getState().milestones["PO-001"];
      expect(storeMs.find(m => m.id === "ms_test1")?.status).toBe("In Progress");
    });

    it("tracks status change in history", async () => {
      const deps = createDeps();
      deps._sb._single.mockResolvedValueOnce({ data: null, error: null });

      const ms = makeMilestone({ status: "Not Started" });
      useTandaStore.getState().setMilestonesForPo("PO-001", [ms]);

      const ops = useMilestoneOps(deps);
      await ops.saveMilestone({ ...ms, status: "Complete" });

      expect(deps.addHistory).toHaveBeenCalledWith(
        "PO-001",
        expect.stringContaining("Not Started"),
      );
    });

    it("skips history when skipHistory=true", async () => {
      const deps = createDeps();
      deps._sb._single.mockResolvedValueOnce({ data: null, error: null });

      const ms = makeMilestone();
      useTandaStore.getState().setMilestonesForPo("PO-001", [ms]);

      const ops = useMilestoneOps(deps);
      await ops.saveMilestone({ ...ms, status: "In Progress" }, true);

      expect(deps.addHistory).not.toHaveBeenCalled();
    });
  });

  // ── saveMilestone conflict detection ───────────────────────────────────

  describe("saveMilestone conflict detection", () => {
    it("calls setConfirmModal when updated_at mismatch from another user", async () => {
      const deps = createDeps();
      // Set up user
      useTandaStore.setState({ user: { id: "u1", name: "Alice", password: "" } });

      const ms = makeMilestone({ updated_at: "2026-01-01T00:00:00.000Z", updated_by: "Alice" });
      useTandaStore.getState().setMilestonesForPo("PO-001", [ms]);

      // Server has a newer version from a different user
      deps._sb._single.mockResolvedValueOnce({
        data: {
          id: ms.id,
          data: { ...ms, updated_at: "2026-02-01T00:00:00.000Z", updated_by: "Bob", status: "Delayed" },
        },
        error: null,
      });

      const ops = useMilestoneOps(deps);
      await ops.saveMilestone({ ...ms, status: "In Progress" });

      // Should show conflict modal, NOT upsert
      expect(deps.setConfirmModal).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Conflict Detected",
          confirmText: "Use Mine",
        }),
      );
      // The upsert should NOT have been called (save is deferred to modal callbacks)
      expect(deps._sb._upsert).not.toHaveBeenCalled();
    });
  });

  // ── saveMilestones (batch) ─────────────────────────────────────────────

  describe("saveMilestones", () => {
    it("batch upserts multiple milestones and updates store", async () => {
      const deps = createDeps();

      const ms1 = makeMilestone({ id: "ms_1", po_number: "PO-001" });
      const ms2 = makeMilestone({ id: "ms_2", po_number: "PO-001" });

      const ops = useMilestoneOps(deps);
      await ops.saveMilestones([ms1, ms2]);

      expect(deps._sb._upsert).toHaveBeenCalledWith(
        [
          { id: "ms_1", data: ms1 },
          { id: "ms_2", data: ms2 },
        ],
        { onConflict: "id" },
      );
      const storeMs = useTandaStore.getState().milestones["PO-001"];
      expect(storeMs).toHaveLength(2);
    });

    it("does nothing for empty array", async () => {
      const deps = createDeps();
      const ops = useMilestoneOps(deps);
      await ops.saveMilestones([]);
      expect(deps._sb._upsert).not.toHaveBeenCalled();
    });
  });

  // ── generateMilestones ─────────────────────────────────────────────────

  describe("generateMilestones", () => {
    it("creates milestones from default template and DDP date", () => {
      const deps = createDeps();
      const ops = useMilestoneOps(deps);

      const ms = ops.generateMilestones("PO-001", "2026-08-01");
      expect(ms.length).toBe(DEFAULT_WIP_TEMPLATES.length);
      expect(ms[0].po_number).toBe("PO-001");
      expect(ms[0].status).toBe("Not Started");
      expect(ms[0].expected_date).toBeTruthy();
    });

    it("uses vendor-specific template when available", () => {
      const deps = createDeps();
      const vendorTemplates: WipTemplate[] = [
        { id: "vt1", phase: "Custom Phase", category: "Pre-Production", daysBeforeDDP: 30, status: "Not Started", notes: "" },
      ];
      useTandaStore.setState({ wipTemplates: { MyVendor: vendorTemplates } });

      const ops = useMilestoneOps(deps);
      const ms = ops.generateMilestones("PO-001", "2026-08-01", "MyVendor");
      expect(ms).toHaveLength(1);
      expect(ms[0].phase).toBe("Custom Phase");
    });
  });

  // ── ensureMilestones ───────────────────────────────────────────────────

  describe("ensureMilestones", () => {
    it("returns existing milestones from store without fetching", async () => {
      const deps = createDeps();
      const ms = makeMilestone();
      useTandaStore.getState().setMilestonesForPo("PO-001", [ms]);

      const ops = useMilestoneOps(deps);
      const result = await ops.ensureMilestones({
        PoNumber: "PO-001",
        DateExpectedDelivery: "2026-08-01",
      });

      expect(result).toEqual([ms]);
      // Should not have fetched from DB
      expect(deps._sb._select).not.toHaveBeenCalled();
    });

    it("returns 'needs_template' when vendor has no template", async () => {
      const deps = createDeps();
      // No milestones in store, no milestones in DB
      deps._sb._select.mockResolvedValueOnce({ data: [], error: null });

      // Store has no vendor template for "UnknownVendor"
      useTandaStore.setState({ wipTemplates: {} });

      const ops = useMilestoneOps(deps);
      const result = await ops.ensureMilestones({
        PoNumber: "PO-099",
        VendorName: "UnknownVendor",
        DateExpectedDelivery: "2026-08-01",
      });

      expect(result).toBe("needs_template");
    });

    it("generates and saves milestones when none exist and template is available", async () => {
      const deps = createDeps();
      deps._sb._select.mockResolvedValueOnce({ data: [], error: null });

      // Use default template (no vendor name)
      const ops = useMilestoneOps(deps);
      const result = await ops.ensureMilestones({
        PoNumber: "PO-NEW",
        DateExpectedDelivery: "2026-08-01",
      });

      expect(Array.isArray(result)).toBe(true);
      expect((result as Milestone[]).length).toBe(DEFAULT_WIP_TEMPLATES.length);
      expect(deps._sb._upsert).toHaveBeenCalled();
      expect(deps.addHistory).toHaveBeenCalledWith(
        "PO-NEW",
        expect.stringContaining("Milestones generated"),
      );
    });
  });

  // ── regenerateMilestones ───────────────────────────────────────────────

  describe("regenerateMilestones", () => {
    it("preserves existing statuses via merge", async () => {
      const deps = createDeps();

      // Existing milestone with progress
      const existing = makeMilestone({
        id: "ms_old",
        phase: "Lab Dip / Strike Off",
        status: "Complete",
        actual_date: "2026-03-15",
        notes: "Done early",
      });
      useTandaStore.getState().setMilestonesForPo("PO-001", [existing]);

      const ops = useMilestoneOps(deps);
      await ops.regenerateMilestones({
        PoNumber: "PO-001",
        DateExpectedDelivery: "2026-08-01",
      });

      // Store should have merged milestones
      const storeMs = useTandaStore.getState().milestones["PO-001"];
      expect(storeMs).toBeTruthy();
      expect(storeMs.length).toBeGreaterThan(0);

      // The "Lab Dip / Strike Off" milestone should keep its status
      const labDip = storeMs.find(m => m.phase === "Lab Dip / Strike Off");
      expect(labDip).toBeTruthy();
      expect(labDip!.status).toBe("Complete");
      expect(labDip!.actual_date).toBe("2026-03-15");
      expect(labDip!.notes).toBe("Done early");
      // Its ID should be preserved from the old milestone
      expect(labDip!.id).toBe("ms_old");

      expect(deps.addHistory).toHaveBeenCalledWith(
        "PO-001",
        expect.stringContaining("regenerated"),
      );
    });

    it("deletes straggler milestones not in merged set", async () => {
      const deps = createDeps();

      // Existing milestone with a phase that won't be in the new template
      const straggler = makeMilestone({
        id: "ms_straggler",
        phase: "Obsolete Phase",
        status: "Not Started",
      });
      useTandaStore.getState().setMilestonesForPo("PO-001", [straggler]);

      const ops = useMilestoneOps(deps);
      await ops.regenerateMilestones({
        PoNumber: "PO-001",
        DateExpectedDelivery: "2026-08-01",
      });

      // Straggler should have been deleted
      expect(deps._sb._delete).toHaveBeenCalledWith(
        expect.stringContaining("ms_straggler"),
      );
    });
  });

  // ── deleteMilestonesForPO ──────────────────────────────────────────────

  describe("deleteMilestonesForPO", () => {
    it("removes milestones from Supabase and store", async () => {
      const deps = createDeps();

      const ms1 = makeMilestone({ id: "ms_del1" });
      const ms2 = makeMilestone({ id: "ms_del2" });
      useTandaStore.getState().setMilestonesForPo("PO-001", [ms1, ms2]);

      const ops = useMilestoneOps(deps);
      await ops.deleteMilestonesForPO("PO-001");

      // Should have called delete for each milestone
      expect(deps._sb._delete).toHaveBeenCalledTimes(2);
      expect(deps._sb._delete).toHaveBeenCalledWith(expect.stringContaining("ms_del1"));
      expect(deps._sb._delete).toHaveBeenCalledWith(expect.stringContaining("ms_del2"));

      // Store should be cleared
      expect(useTandaStore.getState().milestones["PO-001"]).toBeUndefined();
    });

    it("handles PO with no existing milestones", async () => {
      const deps = createDeps();
      const ops = useMilestoneOps(deps);
      await ops.deleteMilestonesForPO("PO-NONE");
      expect(deps._sb._delete).not.toHaveBeenCalled();
    });
  });
});
