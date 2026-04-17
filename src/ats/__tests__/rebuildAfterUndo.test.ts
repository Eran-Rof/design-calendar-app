import { describe, it, expect, vi } from "vitest";
import { rebuildAfterUndo } from "../hooks/useMergeHistory";
import type { ExcelData } from "../types";

function makeData(overrides: Partial<ExcelData> = {}): ExcelData {
  return {
    syncedAt: "2026-04-01T00:00:00Z",
    skus: [],
    pos: [],
    sos: [],
    ...overrides,
  };
}

const passthrough = async (d: ExcelData) => d;

describe("rebuildAfterUndo", () => {
  it("zeroes onPO + clears pos before calling applyPOWIPData", async () => {
    const input = makeData({
      skus: [{ sku: "A", description: "", store: "ROF", onHand: 5, onPO: 99 }],
      pos: [{ sku: "A", date: "2026-05-01", qty: 10, poNumber: "PO1", vendor: "V", store: "ROF", unitCost: 1 }],
    });
    const spy = vi.fn(passthrough);
    await rebuildAfterUndo([], input, spy);
    const seen = spy.mock.calls[0][0];
    // The caller should see a zeroed base, not the merged-state input
    expect(seen.pos).toHaveLength(0);
    expect(seen.skus[0].onPO).toBe(0);
    expect(seen.skus[0].onHand).toBe(5);
  });

  it("replays the remaining merge ops in original order", async () => {
    // Start with 3 separate skus. Merge A→B, then B→C. History = [{A→B}, {B→C}].
    // After undoing the last merge (B→C), we should see A merged into B, but B still separate from C.
    const input = makeData({
      skus: [
        { sku: "A", description: "A", store: "ROF", onHand: 1, onPO: 0 },
        { sku: "B", description: "B", store: "ROF", onHand: 2, onPO: 0 },
        { sku: "C", description: "C", store: "ROF", onHand: 4, onPO: 0 },
      ],
    });
    const out = await rebuildAfterUndo(
      [{ fromSku: "A", toSku: "B" }],
      input,
      passthrough,
    );
    const skus = Object.fromEntries(out.skus.map(s => [s.sku, s.onHand]));
    expect(skus).toEqual({ B: 3, C: 4 }); // A merged into B, C still its own row
  });

  it("returns base unchanged when history is empty after undo", async () => {
    const input = makeData({
      skus: [{ sku: "X", description: "", store: "ROF", onHand: 10, onPO: 0 }],
    });
    const out = await rebuildAfterUndo([], input, passthrough);
    expect(out.skus).toHaveLength(1);
    expect(out.skus[0].sku).toBe("X");
  });

  it("falls back to bare base when applyPOWIPData throws", async () => {
    const input = makeData({
      skus: [{ sku: "X", description: "", store: "ROF", onHand: 10, onPO: 0 }],
    });
    const broken = vi.fn(async () => { throw new Error("tanda_pos fetch failed"); });
    const out = await rebuildAfterUndo([], input, broken);
    // Should still get a result — the bare (zeroed) base, not throw.
    expect(out.skus).toHaveLength(1);
    expect(out.skus[0].onPO).toBe(0);
  });

  it("no-ops merges that reference skus not in base (stale history is harmless)", async () => {
    const input = makeData({
      skus: [
        { sku: "A", description: "", store: "ROF", onHand: 1, onPO: 0 },
        { sku: "B", description: "", store: "ROF", onHand: 2, onPO: 0 },
      ],
    });
    const out = await rebuildAfterUndo(
      [{ fromSku: "GONE", toSku: "ALSO-GONE" }, { fromSku: "A", toSku: "B" }],
      input,
      passthrough,
    );
    const skus = Object.fromEntries(out.skus.map(s => [s.sku, s.onHand]));
    expect(skus).toEqual({ B: 3 }); // stale op no-ops, A→B still applies
  });
});
