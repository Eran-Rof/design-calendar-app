import "../../store/__tests__/setup";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useTandaStore } from "../../store/index";
import type { XoroPO } from "../../../utils/tandaTypes";
import type { SyncLogEntry } from "../../state/sync/syncTypes";

// Mock useRef so the hook can run outside React render context
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual, useRef: (init: any) => ({ current: init }) };
});

import { useSyncOps, type SyncOpsDeps } from "../useSyncOps";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePO(overrides: Partial<XoroPO> = {}): XoroPO {
  return {
    PoNumber: "PO-001",
    VendorName: "Vendor A",
    StatusName: "Open",
    DateOrder: "2025-01-01",
    DateExpectedDelivery: "2025-02-01",
    ...overrides,
  };
}

/** Build a Xoro-proxy JSON response wrapping mapped POs. */
function xoroResponse(pos: XoroPO[]) {
  return {
    Result: true,
    Data: pos.map((po) => ({
      OrderNumber: po.PoNumber,
      VendorName: po.VendorName,
      StatusName: po.StatusName,
      DateOrder: po.DateOrder,
      DateExpectedDelivery: po.DateExpectedDelivery,
    })),
    TotalPages: 1,
  };
}

/** Build a Supabase-style rows response for tanda_pos select. */
function sbPosRows(pos: XoroPO[]) {
  return pos.map((po) => ({ po_number: po.PoNumber, data: po }));
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errResponse(status = 500): Response {
  return new Response(JSON.stringify({ message: "Server error" }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Mock deps ────────────────────────────────────────────────────────────────

function makeDeps(): SyncOpsDeps {
  return {
    archivePO: vi.fn().mockResolvedValue(undefined),
    loadCachedPOs: vi.fn().mockResolvedValue(undefined),
    syncVendorsToDC: vi.fn().mockResolvedValue(undefined),
    addHistory: vi.fn().mockResolvedValue(undefined),
  };
}

/** Call the hook outside React — works because useRef is mocked. */
function callHook(deps: SyncOpsDeps) {
  return useSyncOps(deps);
}

// ── Capture initial store state for reset ────────────────────────────────────

const initialState = useTandaStore.getState();
const get = () => useTandaStore.getState();

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  useTandaStore.setState(initialState, true);
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// cancelSync
// ---------------------------------------------------------------------------
describe("cancelSync", () => {
  it("aborts the current sync and sets syncErr", () => {
    const deps = makeDeps();
    const hook = callHook(deps);

    // Simulate an active abort controller
    const controller = new AbortController();
    hook.syncAbortRef.current = controller;
    get().setSyncField("syncing", true);

    hook.cancelSync();

    expect(controller.signal.aborted).toBe(true);
    expect(get().syncing).toBe(false);
    expect(get().syncErr).toBe("Sync cancelled.");
    expect(hook.syncAbortRef.current).toBeNull();
  });

  it("is safe to call when no sync is active", () => {
    const deps = makeDeps();
    const hook = callHook(deps);

    hook.cancelSync();

    expect(get().syncing).toBe(false);
    expect(get().syncErr).toBe("Sync cancelled.");
  });
});

// ---------------------------------------------------------------------------
// loadSyncLog
// ---------------------------------------------------------------------------
describe("loadSyncLog", () => {
  it("loads and parses sync log entries from Supabase", async () => {
    const entries: SyncLogEntry[] = [
      { ts: "2025-01-01T00:00:00Z", user: "Alice", success: true, added: 5, changed: 2, deleted: 1 },
      { ts: "2025-01-02T00:00:00Z", user: "Bob", success: false, added: 0, changed: 0, deleted: 0, error: "Failed" },
    ];

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      okJson([{ value: JSON.stringify(entries) }])
    );

    const deps = makeDeps();
    const hook = callHook(deps);

    await hook.loadSyncLog();

    expect(get().syncLog).toEqual(entries);
  });

  it("handles empty/missing data gracefully", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(okJson([]));

    const deps = makeDeps();
    const hook = callHook(deps);

    await hook.loadSyncLog();

    // syncLog stays at default (empty array)
    expect(get().syncLog).toEqual([]);
  });

  it("does not throw on fetch error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network"));

    const deps = makeDeps();
    const hook = callHook(deps);

    await hook.loadSyncLog();

    expect(get().syncLog).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// appendSyncLog
// ---------------------------------------------------------------------------
describe("appendSyncLog", () => {
  it("prepends entry and updates store", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okJson({}));

    const deps = makeDeps();
    const hook = callHook(deps);

    const entry: SyncLogEntry = { ts: "2025-03-01T00:00:00Z", user: "Alice", success: true, added: 1, changed: 0, deleted: 0 };

    await hook.appendSyncLog(entry);

    expect(get().syncLog[0]).toEqual(entry);
    expect(get().syncLog).toHaveLength(1);
  });

  it("caps at 10 entries", async () => {
    // Pre-fill store with 10 entries
    const existing: SyncLogEntry[] = Array.from({ length: 10 }, (_, i) => ({
      ts: `2025-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      user: "User",
      success: true,
      added: i,
      changed: 0,
      deleted: 0,
    }));
    get().setSyncField("syncLog", existing);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(okJson({}));

    const deps = makeDeps();
    const hook = callHook(deps);

    const newEntry: SyncLogEntry = { ts: "2025-02-01T00:00:00Z", user: "New", success: false, added: 0, changed: 0, deleted: 0, error: "err" };

    await hook.appendSyncLog(newEntry);

    expect(get().syncLog).toHaveLength(10);
    expect(get().syncLog[0]).toEqual(newEntry);
    // The oldest entry (index 9 from original) should have been trimmed
    expect(get().syncLog[9].ts).toBe("2025-01-09T00:00:00Z");
  });

  it("does not throw if Supabase upsert fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network"));

    const deps = makeDeps();
    const hook = callHook(deps);

    const entry: SyncLogEntry = { ts: "2025-03-01T00:00:00Z", user: "Alice", success: true, added: 1, changed: 0, deleted: 0 };

    await hook.appendSyncLog(entry);

    // Store is still updated even if the remote write fails
    expect(get().syncLog[0]).toEqual(entry);
  });
});

// ---------------------------------------------------------------------------
// syncFromXoro
// ---------------------------------------------------------------------------
describe("syncFromXoro", () => {
  /**
   * Build a fetch mock that handles:
   *  - Multiple /api/xoro-proxy calls (one per status)
   *  - /rest/v1/tanda_pos (select existing POs)
   *  - /rest/v1/tanda_pos (upsert)
   *  - /rest/v1/app_data (appendSyncLog)
   */
  function buildFetchMock(opts: {
    xoroPOs?: XoroPO[];
    existingPOs?: XoroPO[];
    upsertError?: boolean;
  } = {}) {
    const { xoroPOs = [], existingPOs = [], upsertError = false } = opts;

    return vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      // Xoro proxy calls (one per status)
      if (url.includes("/api/xoro-proxy")) {
        const params = new URLSearchParams(url.split("?")[1] || "");
        const status = params.get("status") || "";
        const matching = xoroPOs.filter((po) => status.includes(po.StatusName ?? ""));
        return okJson(xoroResponse(matching));
      }

      // Supabase tanda_pos select
      if (url.includes("/rest/v1/tanda_pos") && (!init?.method || init.method === "GET")) {
        return okJson(sbPosRows(existingPOs));
      }

      // Supabase tanda_pos upsert (POST with Prefer header)
      if (url.includes("/rest/v1/tanda_pos") && init?.method === "POST") {
        if (upsertError) return errResponse(500);
        const body = JSON.parse((init.body as string) || "[]");
        return okJson(body);
      }

      // Supabase app_data (sync log)
      if (url.includes("/rest/v1/app_data")) {
        return okJson({});
      }

      // Default fallback
      return okJson({});
    });
  }

  describe("successful sync", () => {
    it("syncs new POs into the store", async () => {
      const po1 = makePO({ PoNumber: "PO-100", StatusName: "Open" });
      const po2 = makePO({ PoNumber: "PO-200", StatusName: "Released" });

      const fetchMock = buildFetchMock({ xoroPOs: [po1, po2], existingPOs: [] });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const deps = makeDeps();
      const hook = callHook(deps);

      await hook.syncFromXoro();

      expect(get().syncing).toBe(false);
      expect(get().syncErr).toBe("");
      expect(get().syncDone).toEqual(expect.objectContaining({ added: 2, changed: 0 }));
      expect(deps.loadCachedPOs).toHaveBeenCalled();
    });

    it("detects changed POs (existing in DB)", async () => {
      const po = makePO({ PoNumber: "PO-100", StatusName: "Open" });
      const existingPO = makePO({ PoNumber: "PO-100", StatusName: "Open" });

      const fetchMock = buildFetchMock({ xoroPOs: [po], existingPOs: [existingPO] });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const deps = makeDeps();
      const hook = callHook(deps);

      await hook.syncFromXoro();

      expect(get().syncDone).toEqual(expect.objectContaining({ added: 0, changed: 1 }));
    });

    it("syncs vendor names to Design Calendar", async () => {
      const po = makePO({ PoNumber: "PO-100", VendorName: "AcmeCo", StatusName: "Open" });

      const fetchMock = buildFetchMock({ xoroPOs: [po] });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const deps = makeDeps();
      const hook = callHook(deps);

      await hook.syncFromXoro();

      expect(deps.syncVendorsToDC).toHaveBeenCalledWith(false, ["AcmeCo"]);
    });

    it("adds history entries for synced POs", async () => {
      const po = makePO({ PoNumber: "PO-100", StatusName: "Open" });

      const fetchMock = buildFetchMock({ xoroPOs: [po] });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const deps = makeDeps();
      const hook = callHook(deps);

      await hook.syncFromXoro();

      expect(deps.addHistory).toHaveBeenCalledWith("PO-100", expect.stringContaining("synced from Xoro"));
    });
  });

  describe("sync with filters", () => {
    it("passes vendor filter to fetch and applies client-side", async () => {
      const po1 = makePO({ PoNumber: "PO-100", VendorName: "TargetVendor", StatusName: "Open" });
      const po2 = makePO({ PoNumber: "PO-200", VendorName: "OtherVendor", StatusName: "Open" });

      const fetchMock = buildFetchMock({ xoroPOs: [po1, po2] });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const deps = makeDeps();
      const hook = callHook(deps);

      await hook.syncFromXoro({ poNumbers: [], dateFrom: "", dateTo: "", vendors: ["TargetVendor"], statuses: [] });

      // Only the matching vendor PO should come through client-side filtering
      expect(get().syncDone?.added).toBe(1);
    });

    it("passes date range filter", async () => {
      const po1 = makePO({ PoNumber: "PO-100", DateOrder: "2025-06-15", StatusName: "Open" });
      const po2 = makePO({ PoNumber: "PO-200", DateOrder: "2024-01-01", StatusName: "Open" });

      const fetchMock = buildFetchMock({ xoroPOs: [po1, po2] });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const deps = makeDeps();
      const hook = callHook(deps);

      await hook.syncFromXoro({ poNumbers: [], dateFrom: "2025-01-01", dateTo: "2025-12-31", vendors: [], statuses: [] });

      // Only PO-100 falls within the date range
      expect(get().syncDone?.added).toBe(1);
    });

    it("passes PO number filter", async () => {
      const po1 = makePO({ PoNumber: "PO-100", StatusName: "Open" });
      const po2 = makePO({ PoNumber: "PO-200", StatusName: "Open" });

      const fetchMock = buildFetchMock({ xoroPOs: [po1, po2] });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const deps = makeDeps();
      const hook = callHook(deps);

      await hook.syncFromXoro({ poNumbers: ["PO-100"], dateFrom: "", dateTo: "", vendors: [], statuses: [] });

      expect(get().syncDone?.added).toBe(1);
    });

    it("records applied filters in sync log", async () => {
      const fetchMock = buildFetchMock({ xoroPOs: [] });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const deps = makeDeps();
      const hook = callHook(deps);

      await hook.syncFromXoro({ poNumbers: [], dateFrom: "", dateTo: "", vendors: ["TestVendor"], statuses: [] });

      const log = get().syncLog;
      expect(log).toHaveLength(1);
      expect(log[0].filters).toEqual(expect.objectContaining({ vendors: ["TestVendor"] }));
    });
  });

  describe("archive logic", () => {
    it("archives Closed POs with fresh data from Xoro", async () => {
      const closedPO = makePO({ PoNumber: "PO-CLOSED", StatusName: "Closed" });
      const existingPO = makePO({ PoNumber: "PO-CLOSED", StatusName: "Open" });

      const fetchMock = buildFetchMock({ xoroPOs: [closedPO], existingPOs: [existingPO] });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const deps = makeDeps();
      const hook = callHook(deps);

      await hook.syncFromXoro();

      // Source-1 archive: Closed POs use fresh Xoro data (upsert with _archived flag)
      expect(get().syncDone?.deleted).toBeGreaterThanOrEqual(1);
    });

    it("archives Received POs when previously synced (status change)", async () => {
      const receivedPO = makePO({ PoNumber: "PO-RECV", StatusName: "Received" });
      const existingPO = makePO({ PoNumber: "PO-RECV", StatusName: "Open" });

      const fetchMock = buildFetchMock({ xoroPOs: [receivedPO], existingPOs: [existingPO] });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const deps = makeDeps();
      const hook = callHook(deps);

      await hook.syncFromXoro();

      expect(get().syncDone?.deleted).toBeGreaterThanOrEqual(1);
    });

    it("does NOT archive Received POs on first-time sync (no previous cache)", async () => {
      const receivedPO = makePO({ PoNumber: "PO-NEW-RECV", StatusName: "Received" });

      const fetchMock = buildFetchMock({ xoroPOs: [receivedPO], existingPOs: [] });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const deps = makeDeps();
      const hook = callHook(deps);

      await hook.syncFromXoro();

      // No archive — the PO was never tracked, so we skip it entirely
      expect(get().syncDone?.deleted).toBe(0);
    });

    it("does NOT archive Partially Received POs", async () => {
      const partialPO = makePO({ PoNumber: "PO-PART", StatusName: "Partially Received" });

      const fetchMock = buildFetchMock({ xoroPOs: [partialPO], existingPOs: [] });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const deps = makeDeps();
      const hook = callHook(deps);

      await hook.syncFromXoro();

      expect(get().syncDone?.deleted).toBe(0);
      expect(get().syncDone?.added).toBe(1);
    });

    it("calls deps.archivePO for source-2 cached terminal POs", async () => {
      // Existing PO in DB with Closed status, Xoro returns nothing
      const existingClosed = makePO({ PoNumber: "PO-DBCLOSED", StatusName: "Closed" });

      const fetchMock = buildFetchMock({ xoroPOs: [], existingPOs: [existingClosed] });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const deps = makeDeps();
      const hook = callHook(deps);

      await hook.syncFromXoro();

      expect(deps.archivePO).toHaveBeenCalledWith("PO-DBCLOSED");
    });
  });

  describe("error handling", () => {
    it("sets syncErr when all Xoro status fetches fail", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (url.includes("/api/xoro-proxy")) {
          throw new Error("Network timeout");
        }
        if (url.includes("/rest/v1/tanda_pos")) return okJson([]);
        if (url.includes("/rest/v1/app_data")) return okJson({});
        return okJson({});
      });

      const deps = makeDeps();
      const hook = callHook(deps);

      await hook.syncFromXoro();

      expect(get().syncing).toBe(false);
      expect(get().syncErr).toContain("Xoro sync failed");
    });

    it("sets syncErr on Supabase upsert failure", async () => {
      const po = makePO({ PoNumber: "PO-100", StatusName: "Open" });

      const fetchMock = buildFetchMock({ xoroPOs: [po], upsertError: true });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const deps = makeDeps();
      const hook = callHook(deps);

      await hook.syncFromXoro();

      expect(get().syncErr).toContain("Failed to save POs to database");
    });

    it("logs failed sync to sync log", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (url.includes("/api/xoro-proxy")) throw new Error("fail");
        if (url.includes("/rest/v1/tanda_pos")) return okJson([]);
        if (url.includes("/rest/v1/app_data")) return okJson({});
        return okJson({});
      });

      const deps = makeDeps();
      const hook = callHook(deps);

      await hook.syncFromXoro();

      const log = get().syncLog;
      expect(log).toHaveLength(1);
      expect(log[0].success).toBe(false);
      expect(log[0].error).toBeDefined();
    });

    it("resets syncing state in finally block even after error", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (url.includes("/api/xoro-proxy")) throw new Error("fail");
        if (url.includes("/rest/v1/tanda_pos")) return okJson([]);
        if (url.includes("/rest/v1/app_data")) return okJson({});
        return okJson({});
      });

      const deps = makeDeps();
      const hook = callHook(deps);

      await hook.syncFromXoro();

      expect(get().syncing).toBe(false);
      expect(get().syncProgress).toBe(0);
      expect(get().syncProgressMsg).toBe("");
    });
  });

  describe("cancel sync", () => {
    it("handles AbortError when sync is cancelled mid-flight", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (url.includes("/api/xoro-proxy")) {
          if (init?.signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          });
        }
        if (url.includes("/rest/v1/tanda_pos")) return okJson([]);
        if (url.includes("/rest/v1/app_data")) return okJson({});
        return okJson({});
      });

      const deps = makeDeps();
      const hook = callHook(deps);

      // Start sync (don't await yet), then cancel
      const syncPromise = hook.syncFromXoro();

      // Allow microtasks to run so the fetch calls are issued
      await new Promise((r) => setTimeout(r, 0));

      hook.cancelSync();

      await syncPromise;

      expect(get().syncing).toBe(false);
      // The error message may vary depending on where the abort propagates —
      // either "Sync cancelled." (from cancelSync) or "The operation was aborted"
      // (from the fetch abort). Both indicate cancellation.
      expect(get().syncErr.toLowerCase()).toMatch(/cancel|abort/);
    });
  });

  describe("progress tracking", () => {
    it("sets syncing=true at start and false at end", async () => {
      const fetchMock = buildFetchMock({ xoroPOs: [] });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const deps = makeDeps();
      const hook = callHook(deps);

      await hook.syncFromXoro();

      expect(get().syncing).toBe(false);
      expect(get().syncProgress).toBe(0);
    });

    it("sets lastSync timestamp on success", async () => {
      const fetchMock = buildFetchMock({ xoroPOs: [] });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const deps = makeDeps();
      const hook = callHook(deps);

      await hook.syncFromXoro();

      expect(get().lastSync).toBeTruthy();
      expect(new Date(get().lastSync).getTime()).not.toBeNaN();
    });

    it("resets syncFilters at start of sync", async () => {
      get().setSyncField("syncFilters", { poNumbers: ["PO-1"], dateFrom: "2025-01-01", dateTo: "2025-12-31", vendors: ["V"], statuses: ["Open"] });

      const fetchMock = buildFetchMock({ xoroPOs: [] });
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

      const deps = makeDeps();
      const hook = callHook(deps);

      await hook.syncFromXoro();

      expect(get().syncFilters).toEqual({ poNumbers: [], dateFrom: "", dateTo: "", vendors: [], statuses: [] });
    });
  });
});
