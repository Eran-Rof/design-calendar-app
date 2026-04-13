import "../../store/__tests__/setup";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// useArchiveOps builds its own `sb` via fetch() against SB_URL.
// We mock fetch globally to intercept all Supabase REST calls.
const mockFetch = vi.fn();
(globalThis as any).fetch = mockFetch;

import { useArchiveOps } from "../useArchiveOps";
import { useTandaStore } from "../../store/index";
import type { XoroPO, Milestone } from "../../../utils/tandaTypes";

// ── Helpers ────────────────────────────────────────────────────────────────

const initialState = useTandaStore.getState();

function makePO(overrides: Partial<XoroPO> = {}): XoroPO {
  return {
    PoNumber: "PO-001",
    VendorName: "TestVendor",
    StatusName: "Open",
    ...overrides,
  };
}

function createOpts() {
  return {
    addHistory: vi.fn().mockResolvedValue(undefined),
    loadCachedPOs: vi.fn().mockResolvedValue(undefined),
    ensureMilestones: vi.fn().mockResolvedValue([]),
    saveMilestone: vi.fn().mockResolvedValue(undefined),
    getSelected: vi.fn().mockReturnValue(null),
    setSelected: vi.fn(),
    setArchivedPos: vi.fn(),
    setArchiveLoading: vi.fn(),
    getBulkState: vi.fn().mockReturnValue({
      bulkVendor: "",
      bulkStatus: "",
      bulkPhases: [],
      bulkCategory: "",
      bulkPOs: [],
    }),
    setBulkUpdating: vi.fn(),
    setShowBulkUpdate: vi.fn(),
    setBulkPhase: vi.fn(),
    setBulkPhases: vi.fn(),
    setBulkCategory: vi.fn(),
    setBulkPOs: vi.fn(),
    setBulkPOSearch: vi.fn(),
    setConfirmModal: vi.fn(),
  };
}

/**
 * Helper to set up fetch mock responses for a sequence of calls.
 * Each entry is { ok, json } — fetch returns a Response-like object.
 */
function mockFetchSequence(responses: Array<{ ok: boolean; json: any }>) {
  for (const resp of responses) {
    mockFetch.mockResolvedValueOnce({
      ok: resp.ok,
      json: async () => resp.json,
    });
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("useArchiveOps", () => {
  beforeEach(() => {
    useTandaStore.setState(initialState, true);
    mockFetch.mockReset();
  });

  // ── archivePO ──────────────────────────────────────────────────────────

  describe("archivePO", () => {
    it("marks PO as archived in Supabase and removes from local state", async () => {
      const opts = createOpts();
      const po = makePO({ PoNumber: "PO-ARCH" });

      // Pre-populate store with the PO
      useTandaStore.setState({ pos: [po] });

      // 1st fetch: select PO data
      mockFetchSequence([
        { ok: true, json: [{ data: po }] },
        // 2nd fetch: upsert archived PO
        { ok: true, json: [{ data: { ...po, _archived: true } }] },
      ]);

      const ops = useArchiveOps(opts);
      await ops.archivePO("PO-ARCH");

      // PO should be removed from local store
      expect(useTandaStore.getState().pos).toHaveLength(0);

      // fetch should have been called (select then upsert)
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // The upsert call should include _archived: true in the body
      const upsertCall = mockFetch.mock.calls[1];
      const body = JSON.parse(upsertCall[1].body);
      expect(body[0].data._archived).toBe(true);
    });

    it("clears selected PO if it matches the archived one", async () => {
      const opts = createOpts();
      const po = makePO({ PoNumber: "PO-SEL" });
      opts.getSelected.mockReturnValue(po);

      mockFetchSequence([
        { ok: true, json: [{ data: po }] },
        { ok: true, json: [{ data: { ...po, _archived: true } }] },
      ]);

      const ops = useArchiveOps(opts);
      await ops.archivePO("PO-SEL");

      expect(opts.setSelected).toHaveBeenCalledWith(null);
    });

    it("does nothing for empty poNumber", async () => {
      const opts = createOpts();
      const ops = useArchiveOps(opts);
      await ops.archivePO("");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── loadArchivedPOs ────────────────────────────────────────────────────

  describe("loadArchivedPOs", () => {
    it("fetches all POs and filters to archived ones", async () => {
      const opts = createOpts();
      const archived = makePO({ PoNumber: "PO-A1", _archived: true, _archivedAt: "2026-01-01" });
      const active = makePO({ PoNumber: "PO-A2" });

      mockFetchSequence([
        { ok: true, json: [{ data: archived }, { data: active }] },
      ]);

      const ops = useArchiveOps(opts);
      await ops.loadArchivedPOs();

      expect(opts.setArchiveLoading).toHaveBeenCalledWith(true);
      expect(opts.setArchivedPos).toHaveBeenCalledWith([archived]);
      expect(opts.setArchiveLoading).toHaveBeenCalledWith(false);
    });

    it("handles empty response", async () => {
      const opts = createOpts();
      mockFetchSequence([{ ok: true, json: [] }]);

      const ops = useArchiveOps(opts);
      await ops.loadArchivedPOs();

      expect(opts.setArchivedPos).toHaveBeenCalledWith([]);
    });

    it("handles fetch error gracefully", async () => {
      const opts = createOpts();
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const ops = useArchiveOps(opts);
      await ops.loadArchivedPOs();

      // Should still set loading to false even on error
      expect(opts.setArchiveLoading).toHaveBeenCalledWith(false);
    });
  });

  // ── unarchivePO ────────────────────────────────────────────────────────

  describe("unarchivePO", () => {
    it("restores PO by removing _archived flag and reloads", async () => {
      const opts = createOpts();
      const po = makePO({ PoNumber: "PO-UN", _archived: true, _archivedAt: "2026-01-01" });

      mockFetchSequence([
        // 1st: select PO data
        { ok: true, json: [{ data: po }] },
        // 2nd: upsert restored PO
        { ok: true, json: [{ data: { ...po, _archived: undefined } }] },
        // 3rd: loadCachedPOs triggers (mocked)
        // 4th: loadArchivedPOs — select all POs
        { ok: true, json: [] },
      ]);

      const ops = useArchiveOps(opts);
      await ops.unarchivePO("PO-UN");

      // Should have recorded history
      expect(opts.addHistory).toHaveBeenCalledWith("PO-UN", "PO restored from archive");
      // Should have reloaded cached POs
      expect(opts.loadCachedPOs).toHaveBeenCalled();

      // The upsert body should not have _archived
      const upsertCall = mockFetch.mock.calls[1];
      const body = JSON.parse(upsertCall[1].body);
      expect(body[0].data._archived).toBeUndefined();
      expect(body[0].data._archivedAt).toBeUndefined();
    });

    it("does nothing for empty poNumber", async () => {
      const opts = createOpts();
      const ops = useArchiveOps(opts);
      await ops.unarchivePO("");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── permanentDeleteArchived ────────────────────────────────────────────

  describe("permanentDeleteArchived", () => {
    it("deletes PO record, milestones, and notes from Supabase", async () => {
      const opts = createOpts();

      mockFetchSequence([
        // 1st: delete PO record
        { ok: true, json: null },
        // 2nd: select milestones
        { ok: true, json: [{ id: "ms_1", data: { po_number: "PO-DEL" } }] },
        // 3rd: delete milestone
        { ok: true, json: null },
        // 4th: select notes
        { ok: true, json: [{ id: "note_1" }] },
        // 5th: delete note
        { ok: true, json: null },
        // 6th: loadArchivedPOs reload
        { ok: true, json: [] },
      ]);

      const ops = useArchiveOps(opts);
      await ops.permanentDeleteArchived(["PO-DEL"]);

      // Should have made multiple fetch calls (delete PO, select+delete milestones, select+delete notes, reload)
      expect(mockFetch).toHaveBeenCalledTimes(6);

      // Verify delete calls
      const deleteCall1 = mockFetch.mock.calls[0];
      expect(deleteCall1[1].method).toBe("DELETE");
      expect(deleteCall1[0]).toContain("tanda_pos");
    });

    it("handles multiple PO numbers", async () => {
      const opts = createOpts();

      // For each PO: delete PO, select milestones (empty), select notes (empty)
      mockFetchSequence([
        // PO-1
        { ok: true, json: null }, // delete PO
        { ok: true, json: [] },   // select milestones
        { ok: true, json: [] },   // select notes
        // PO-2
        { ok: true, json: null }, // delete PO
        { ok: true, json: [] },   // select milestones
        { ok: true, json: [] },   // select notes
        // reload
        { ok: true, json: [] },
      ]);

      const ops = useArchiveOps(opts);
      await ops.permanentDeleteArchived(["PO-1", "PO-2"]);

      // 3 calls per PO + 1 reload = 7
      expect(mockFetch).toHaveBeenCalledTimes(7);
    });

    it("reloads archived POs after deletion", async () => {
      const opts = createOpts();

      mockFetchSequence([
        { ok: true, json: null }, // delete PO
        { ok: true, json: [] },   // select milestones
        { ok: true, json: [] },   // select notes
        // reload - still has one archived PO
        { ok: true, json: [{ data: { PoNumber: "PO-REMAIN", _archived: true } }] },
      ]);

      const ops = useArchiveOps(opts);
      await ops.permanentDeleteArchived(["PO-GONE"]);

      // setArchivedPos should be called with the remaining archived PO
      expect(opts.setArchivedPos).toHaveBeenCalledWith([
        expect.objectContaining({ PoNumber: "PO-REMAIN" }),
      ]);
    });
  });
});
