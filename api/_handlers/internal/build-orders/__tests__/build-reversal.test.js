// Unit tests for the build-order reversal helpers (reverse-complete): finding +
// depleting the finished-goods FIFO layers a completed build created, the
// downstream-consumption guard, and the reverseCompletedBuild orchestration.

import { describe, it, expect } from "vitest";
import {
  planFinishedLayerDepletion,
  depleteFinishedLayers,
  reverseCompletedBuild,
  ReversalError,
} from "../_reversal.js";

// Flexible Supabase-shaped mock. Resolves selects by (table + captured filters)
// and records inventory_layers deletes/updates + the outputs delete.
function mkAdmin(spec) {
  const rec = { layerDeletes: [], layerUpdates: [], outputsDeleted: false, jesReversed: [] };

  function from(table) {
    const ctx = { table, mode: "select", payload: null, eqs: {}, isNull: [], ins: {} };

    function resolveSelect() {
      if (table === "inventory_layers") {
        if ("source_adjustment_id" in ctx.eqs) return { data: spec.layersByAdj || [] };
        if (ctx.isNull.includes("source_adjustment_id")) return { data: spec.layersByNote || [] };
        return { data: [] };
      }
      if (table === "inventory_consumption") {
        if (ctx.isNull.includes("reversed_at")) return { data: spec.liveDraws || [] };
        return { data: spec.anyDraws || [] };
      }
      if (table === "journal_entries") return { data: spec.completeJes || [] };
      return { data: [] };
    }

    function applyMutation(id) {
      if (table === "inventory_layers" && ctx.mode === "delete") {
        if (spec.deleteFailsFor && spec.deleteFailsFor.includes(id)) return { error: { message: "FK restrict" } };
        rec.layerDeletes.push(id); return { error: null };
      }
      if (table === "inventory_layers" && ctx.mode === "update") { rec.layerUpdates.push({ id, payload: ctx.payload }); return { error: null }; }
      if (table === "mfg_build_outputs" && ctx.mode === "delete") { rec.outputsDeleted = true; return { error: null }; }
      return { error: null };
    }

    const chain = {
      select: () => chain,
      update: (p) => { ctx.mode = "update"; ctx.payload = p; return chain; },
      delete: () => { ctx.mode = "delete"; return chain; },
      eq: (col, val) => {
        if (ctx.mode !== "select") return Promise.resolve(applyMutation(val));
        ctx.eqs[col] = val; return chain;
      },
      is: (col) => { ctx.isNull.push(col); return chain; },
      in: (col, vals) => { ctx.ins[col] = vals; return chain; },
      maybeSingle: async () => resolveSelect(),
      then: (resolve) => resolve(resolveSelect()),
    };
    return chain;
  }

  return { from, _rec: rec };
}

const BUILD = { id: "b1", build_number: "BUILD-00042" };

describe("planFinishedLayerDepletion", () => {
  it("returns no layers / not blocked when the build made none", async () => {
    const admin = mkAdmin({ layersByAdj: [], layersByNote: [] });
    const plan = await planFinishedLayerDepletion(admin, "e1", BUILD);
    expect(plan.layerIds).toEqual([]);
    expect(plan.blocked).toBe(false);
    expect(plan.depletableQty).toBe(0);
  });

  it("finds linked + legacy(notes) layers, dedupes, sums remaining, not blocked with no live draws", async () => {
    const admin = mkAdmin({
      layersByAdj: [{ id: "L1", item_id: "i1", original_qty: 10, remaining_qty: 10, notes: "x" }],
      layersByNote: [{ id: "L2", item_id: "i2", original_qty: 5, remaining_qty: 5, notes: "Manufacturing build BUILD-00042" }],
      liveDraws: [],
    });
    const plan = await planFinishedLayerDepletion(admin, "e1", BUILD);
    expect(plan.layerIds.sort()).toEqual(["L1", "L2"]);
    expect(plan.depletableQty).toBe(15);
    expect(plan.blocked).toBe(false);
  });

  it("BLOCKS when a finished layer has a live downstream draw", async () => {
    const admin = mkAdmin({
      layersByAdj: [{ id: "L1", item_id: "i1", original_qty: 10, remaining_qty: 3, notes: "x" }],
      layersByNote: [],
      liveDraws: [{ layer_id: "L1" }],
    });
    const plan = await planFinishedLayerDepletion(admin, "e1", BUILD);
    expect(plan.blocked).toBe(true);
    expect(plan.blockedLayerIds).toEqual(["L1"]);
  });
});

describe("depleteFinishedLayers", () => {
  it("hard-deletes a layer with NO consumption rows", async () => {
    const admin = mkAdmin({ anyDraws: [] });
    const plan = { layerIds: ["L1"], layers: [{ id: "L1", remaining_qty: 10, notes: "n" }] };
    const out = await depleteFinishedLayers(admin, plan);
    expect(out).toEqual({ depleted_qty: 10, layers_deleted: 1, layers_zeroed: 0 });
    expect(admin._rec.layerDeletes).toEqual(["L1"]);
    expect(admin._rec.layerUpdates).toEqual([]);
  });

  it("zeroes (does not delete) a layer that carries reversed consumption rows", async () => {
    const admin = mkAdmin({ anyDraws: [{ layer_id: "L1" }] });
    const plan = { layerIds: ["L1"], layers: [{ id: "L1", remaining_qty: 4, notes: "n" }] };
    const out = await depleteFinishedLayers(admin, plan);
    expect(out).toEqual({ depleted_qty: 4, layers_deleted: 0, layers_zeroed: 1 });
    expect(admin._rec.layerUpdates[0].payload.remaining_qty).toBe(0);
    expect(admin._rec.layerDeletes).toEqual([]);
  });

  it("falls back to zeroing when a delete is refused (raced draw)", async () => {
    const admin = mkAdmin({ anyDraws: [], deleteFailsFor: ["L1"] });
    const plan = { layerIds: ["L1"], layers: [{ id: "L1", remaining_qty: 2, notes: "n" }] };
    const out = await depleteFinishedLayers(admin, plan);
    expect(out.layers_zeroed).toBe(1);
    expect(out.layers_deleted).toBe(0);
    expect(admin._rec.layerUpdates[0].payload.remaining_qty).toBe(0);
  });

  it("no-ops on an empty plan", async () => {
    const admin = mkAdmin({});
    expect(await depleteFinishedLayers(admin, { layerIds: [], layers: [] }))
      .toEqual({ depleted_qty: 0, layers_deleted: 0, layers_zeroed: 0 });
  });
});

describe("reverseCompletedBuild", () => {
  it("throws ReversalError(409) when finished units were consumed downstream", async () => {
    const admin = mkAdmin({
      layersByAdj: [{ id: "L1", item_id: "i1", original_qty: 10, remaining_qty: 3, notes: "x" }],
      layersByNote: [],
      liveDraws: [{ layer_id: "L1" }],
    });
    await expect(reverseCompletedBuild(admin, "e1", BUILD, { reason: "r" }))
      .rejects.toBeInstanceOf(ReversalError);
    // No layers touched, no outputs deleted — nothing was mutated.
    expect(admin._rec.layerDeletes).toEqual([]);
    expect(admin._rec.outputsDeleted).toBe(false);
  });

  it("depletes the finished layer + drops outputs when nothing is consumed (no complete JE)", async () => {
    const admin = mkAdmin({
      layersByAdj: [{ id: "L1", item_id: "i1", original_qty: 10, remaining_qty: 10, notes: "x" }],
      layersByNote: [],
      liveDraws: [],
      anyDraws: [],
      completeJes: [], // exercise orchestration without the JE-reversal path (tested separately)
    });
    const out = await reverseCompletedBuild(admin, "e1", BUILD, { reason: "operator reopened" });
    expect(out.reversed_je_ids).toEqual([]);
    expect(out.depleted_qty).toBe(10);
    expect(out.layers_deleted).toBe(1);
    expect(admin._rec.layerDeletes).toEqual(["L1"]);
    expect(admin._rec.outputsDeleted).toBe(true);
  });
});
