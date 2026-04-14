import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runSaveUploadData } from "../hooks/useExcelUpload";
import type { ExcelData } from "../types";
import type { NormChange, NormDecisions } from "../normalize";
import type { MergeOp } from "../hooks/useMergeHistory";

// runSaveUploadData hits Supabase via global fetch to POST ats_excel_data.
// Stub fetch to always succeed so tests focus on the orchestration logic
// (merge replay, normalization decisions, modal gating).
const origFetch = global.fetch;
beforeEach(() => {
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as any) as any;
});
afterEach(() => { global.fetch = origFetch; });

function makeData(overrides: Partial<ExcelData> = {}): ExcelData {
  return {
    syncedAt: "2026-04-01T00:00:00Z",
    skus: [],
    pos: [],
    sos: [],
    ...overrides,
  };
}

interface MockOpts {
  mergeHistory: MergeOp[];
  decisions: NormDecisions;
  setNormChanges: ReturnType<typeof vi.fn>;
  setNormPendingData: ReturnType<typeof vi.fn>;
  setExcelData: ReturnType<typeof vi.fn>;
  setRows: ReturnType<typeof vi.fn>;
  saveBaseData: ReturnType<typeof vi.fn>;
}

function buildOpts(overrides: Partial<MockOpts> = {}): { opts: any; mocks: MockOpts } {
  const mocks: MockOpts = {
    mergeHistory: [],
    decisions: {},
    setNormChanges: vi.fn(),
    setNormPendingData: vi.fn(),
    setExcelData: vi.fn(),
    setRows: vi.fn(),
    saveBaseData: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const opts = {
    applyPOWIPData: async (d: ExcelData) => d,
    saveMergeHistory: vi.fn().mockResolvedValue(undefined),
    saveBaseData: mocks.saveBaseData,
    mergeHistory: mocks.mergeHistory,
    loadNormDecisions: async () => mocks.decisions,
    dates: ["2026-04-01", "2026-05-01"],
    setUploadingFile: vi.fn(),
    setShowUpload: vi.fn(),
    setUploadProgress: vi.fn(),
    setUploadError: vi.fn(),
    setUploadSuccess: vi.fn(),
    setUploadWarnings: vi.fn(),
    setPendingUploadData: vi.fn(),
    setExcelData: mocks.setExcelData,
    setRows: mocks.setRows,
    setLastSync: vi.fn(),
    setMockMode: vi.fn(),
    setMergeHistory: vi.fn(),
    setInvFile: vi.fn(),
    setPurFile: vi.fn(),
    setOrdFile: vi.fn(),
    setNormChanges: mocks.setNormChanges,
    setNormPendingData: mocks.setNormPendingData,
    setNormSource: vi.fn(),
  };
  return { opts, mocks };
}

// Most tests need at least one "raw" SKU that normalizes differently, to
// exercise the norm path. normalizeSku title-cases the color portion, so
// "RYB0412 - ESPRESSO" → "RYB0412 - Espresso".
const RAW_SKU = "RYB0412 - ESPRESSO";
const NORM_SKU = "RYB0412 - Espresso";

describe("runSaveUploadData", () => {
  it("does not clear merge history — replays saved ops over fresh data", async () => {
    // Data has "Lt Grey" and "Grey" rows. History says merge Lt Grey → Grey.
    // The saved data should have a single "Grey" row with combined qty.
    const input = makeData({
      skus: [
        { sku: "RCB1258 - Lt Grey", description: "", store: "ROF", onHand: 100, onOrder: 0 },
        { sku: "RCB1258 - Grey",    description: "", store: "ROF", onHand: 50,  onOrder: 0 },
      ],
    });
    const { opts, mocks } = buildOpts({
      mergeHistory: [{ fromSku: "RCB1258 - Lt Grey", toSku: "RCB1258 - Grey" }],
    });
    const out = await runSaveUploadData(input, opts);
    // saveMergeHistory must NOT be called with [] — that was the old bug.
    expect(opts.saveMergeHistory).not.toHaveBeenCalled();
    expect(out.skus).toHaveLength(1);
    expect(out.skus[0].sku).toBe("RCB1258 - Grey");
    expect(out.skus[0].onHand).toBe(150);
    // Base snapshot must be the PRE-merge data so undo works.
    const savedBase = mocks.saveBaseData.mock.calls[0][0] as ExcelData;
    expect(savedBase.skus).toHaveLength(2);
  });

  it("auto-applies known accepts and skips the modal when no unknowns", async () => {
    const input = makeData({
      skus: [{ sku: RAW_SKU, description: "", store: "ROF", onHand: 1, onOrder: 0 }],
    });
    const { opts, mocks } = buildOpts({
      decisions: { [RAW_SKU]: "accept" },
    });
    await runSaveUploadData(input, opts);
    // No modal — setNormChanges not called
    expect(mocks.setNormChanges).not.toHaveBeenCalled();
    expect(mocks.setNormPendingData).not.toHaveBeenCalled();
    // Data committed to setExcelData and it's already normalized
    expect(mocks.setExcelData).toHaveBeenCalledTimes(1);
    const final = mocks.setExcelData.mock.calls[0][0] as ExcelData;
    expect(final.skus[0].sku).toBe(NORM_SKU);
  });

  it("leaves known rejects in raw form and skips the modal", async () => {
    const input = makeData({
      skus: [{ sku: RAW_SKU, description: "", store: "ROF", onHand: 1, onOrder: 0 }],
    });
    const { opts, mocks } = buildOpts({
      decisions: { [RAW_SKU]: "reject" },
    });
    await runSaveUploadData(input, opts);
    expect(mocks.setNormChanges).not.toHaveBeenCalled();
    const final = mocks.setExcelData.mock.calls[0][0] as ExcelData;
    // User rejected normalization — sku stays raw
    expect(final.skus[0].sku).toBe(RAW_SKU);
  });

  it("opens the modal only for unknown SKUs — known decisions auto-applied silently", async () => {
    const input = makeData({
      skus: [
        { sku: RAW_SKU,             description: "", store: "ROF", onHand: 1, onOrder: 0 }, // known accept
        { sku: "RYB0413 - MOCHA",   description: "", store: "ROF", onHand: 1, onOrder: 0 }, // unknown
      ],
    });
    const { opts, mocks } = buildOpts({
      decisions: { [RAW_SKU]: "accept" },
    });
    await runSaveUploadData(input, opts);
    // Modal opens — but only with the one unknown
    expect(mocks.setNormChanges).toHaveBeenCalledTimes(1);
    const modalChanges = mocks.setNormChanges.mock.calls[0][0] as NormChange[];
    expect(modalChanges).toHaveLength(1);
    expect(modalChanges[0].original).toBe("RYB0413 - MOCHA");
    // The pending data the modal operates on already has the known accept applied
    const pending = mocks.setNormPendingData.mock.calls[0][0] as ExcelData;
    const skus = pending.skus.map(s => s.sku);
    expect(skus).toContain(NORM_SKU);
    expect(skus).not.toContain(RAW_SKU);
    // Final state NOT committed yet — user has to confirm the modal
    expect(mocks.setExcelData).not.toHaveBeenCalled();
  });

  it("replays merge history BEFORE detecting normalization changes", async () => {
    // Setup: raw sku exists both in data and as a merge-from target. After
    // replay, only the merged sku remains, and normalization runs on that.
    const input = makeData({
      skus: [
        { sku: "OLD-BASE - BLUE", description: "", store: "ROF", onHand: 5, onOrder: 0 },
        { sku: "NEW-BASE - BLUE", description: "", store: "ROF", onHand: 3, onOrder: 0 },
      ],
    });
    const { opts, mocks } = buildOpts({
      mergeHistory: [{ fromSku: "OLD-BASE - BLUE", toSku: "NEW-BASE - BLUE" }],
      decisions: {}, // empty — everything normalizable will be unknown
    });
    await runSaveUploadData(input, opts);
    // Modal should see the merged SKU's raw form, not both.
    const modalChanges = mocks.setNormChanges.mock.calls[0]?.[0] as NormChange[] | undefined;
    if (modalChanges) {
      const origs = modalChanges.map(c => c.original);
      expect(origs).not.toContain("OLD-BASE - BLUE"); // merged away before detect
    }
  });

  it("persists base data as pre-merge, pre-normalization snapshot", async () => {
    // Base snapshot must be the original upload, not the post-merge /
    // post-norm version — otherwise Undo can't reconstruct the pre-merge
    // state.
    const input = makeData({
      skus: [
        { sku: "A - RED",   description: "", store: "ROF", onHand: 1, onOrder: 0 },
        { sku: "A - BLUE",  description: "", store: "ROF", onHand: 2, onOrder: 0 },
      ],
    });
    const { opts, mocks } = buildOpts({
      mergeHistory: [{ fromSku: "A - RED", toSku: "A - BLUE" }],
      decisions: { "A - RED": "accept", "A - BLUE": "accept" },
    });
    await runSaveUploadData(input, opts);
    const base = mocks.saveBaseData.mock.calls[0][0] as ExcelData;
    const origs = base.skus.map(s => s.sku);
    // Base snapshot must contain BOTH raw skus — merges/norms not applied.
    expect(origs).toContain("A - RED");
    expect(origs).toContain("A - BLUE");
  });

  it("commits normalized data via setExcelData when all decisions are known", async () => {
    const input = makeData({
      skus: [{ sku: RAW_SKU, description: "", store: "ROF", onHand: 1, onOrder: 0 }],
    });
    const { opts, mocks } = buildOpts({
      decisions: { [RAW_SKU]: "accept" },
    });
    await runSaveUploadData(input, opts);
    expect(mocks.setExcelData).toHaveBeenCalledTimes(1);
    expect(mocks.setRows).toHaveBeenCalledTimes(1);
  });
});
