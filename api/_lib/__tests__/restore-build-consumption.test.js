// Unit tests for restoreBuildConsumption — returns an issued build's consumed
// parts/styles to inventory when the build is cancelled (adds qty back to the
// source layers + stamps the consumption row reversed).

import { describe, it, expect } from "vitest";
import {
  restoreBuildStyleConsumption,
  restoreBuildPartConsumption,
} from "../inventory/restoreBuildConsumption.js";

// Mock admin covering: consumption select (draws), per-draw layer maybeSingle,
// layer update, consumption update. `consumptionTable`/`layerTable` name the
// pair the function under test uses.
function mockAdmin({ consumptionTable, layerTable, draws, layers }) {
  const layerUpdates = [];
  const consumptionUpdates = [];
  const layerById = new Map((layers || []).map((l) => [l.id, l]));
  const layerOrder = (draws || []).map((d) => d.layer_id);
  let layerSeq = 0;

  function from(table) {
    const ctx = { table, isUpdate: false, payload: null };
    const chain = {
      select: () => chain,
      update: (payload) => { ctx.isUpdate = true; ctx.payload = payload; return chain; },
      eq: () => chain,
      is: () => chain,
      in: () => chain,
      maybeSingle: async () => {
        if (table === layerTable) { const id = layerOrder[layerSeq++]; return { data: layerById.get(id) || null }; }
        return { data: null };
      },
      then: (resolve) => {
        if (ctx.isUpdate) {
          (table === layerTable ? layerUpdates : consumptionUpdates).push(ctx.payload);
          return resolve({ error: null });
        }
        if (table === consumptionTable) return resolve({ data: draws });
        return resolve({ data: null });
      },
    };
    return chain;
  }
  return { from, _layerUpdates: layerUpdates, _consumptionUpdates: consumptionUpdates };
}

describe("restoreBuildStyleConsumption", () => {
  it("no-ops when there are no live style draws", async () => {
    const admin = mockAdmin({ consumptionTable: "inventory_consumption", layerTable: "inventory_layers", draws: [] });
    expect(await restoreBuildStyleConsumption(admin, "b1")).toEqual({ restored_qty: 0, rows_reversed: 0 });
  });

  it("adds each style draw back to its layer (capped) and marks it reversed", async () => {
    const admin = mockAdmin({
      consumptionTable: "inventory_consumption",
      layerTable: "inventory_layers",
      draws: [
        { id: "c1", layer_id: "L1", qty_consumed: 40 },
        { id: "c2", layer_id: "L2", qty_consumed: 10 },
      ],
      layers: [
        { id: "L1", original_qty: 100, remaining_qty: 60 },
        { id: "L2", original_qty: 10, remaining_qty: 0 },
      ],
    });
    const r = await restoreBuildStyleConsumption(admin, "b1", "u1");
    expect(r).toEqual({ restored_qty: 50, rows_reversed: 2 });
    expect(admin._layerUpdates).toEqual([{ remaining_qty: 100 }, { remaining_qty: 10 }]);
    expect(admin._consumptionUpdates.every((u) => u.reversed_at && u.reversed_by_user_id === "u1")).toBe(true);
  });

  it("never inflates a layer past original_qty", async () => {
    const admin = mockAdmin({
      consumptionTable: "inventory_consumption",
      layerTable: "inventory_layers",
      draws: [{ id: "c1", layer_id: "L1", qty_consumed: 40 }],
      layers: [{ id: "L1", original_qty: 100, remaining_qty: 80 }],
    });
    await restoreBuildStyleConsumption(admin, "b1");
    expect(admin._layerUpdates[0]).toEqual({ remaining_qty: 100 });
  });
});

describe("restoreBuildPartConsumption", () => {
  it("no-ops when there are no live part draws", async () => {
    const admin = mockAdmin({ consumptionTable: "part_inventory_consumption", layerTable: "part_inventory_layers", draws: [] });
    expect(await restoreBuildPartConsumption(admin, "b1")).toEqual({ restored_qty: 0, rows_reversed: 0 });
  });

  it("adds each part draw back to its part layer and marks it reversed", async () => {
    const admin = mockAdmin({
      consumptionTable: "part_inventory_consumption",
      layerTable: "part_inventory_layers",
      draws: [
        { id: "p1", layer_id: "PL1", qty_consumed: 25 },
        { id: "p2", layer_id: "PL2", qty_consumed: 5 },
      ],
      layers: [
        { id: "PL1", original_qty: 50, remaining_qty: 25 },
        { id: "PL2", original_qty: 5, remaining_qty: 0 },
      ],
    });
    const r = await restoreBuildPartConsumption(admin, "b1", "u9");
    expect(r).toEqual({ restored_qty: 30, rows_reversed: 2 });
    expect(admin._layerUpdates).toEqual([{ remaining_qty: 50 }, { remaining_qty: 5 }]);
    expect(admin._consumptionUpdates.every((u) => u.reversed_at && u.reversed_by_user_id === "u9")).toBe(true);
  });
});
