// Unit tests for restoreInvoiceConsumption — puts a voided AR invoice's FIFO
// draws back on-hand (adds qty to source layers + stamps consumption reversed).

import { describe, it, expect } from "vitest";
import { restoreInvoiceConsumption } from "../inventory/restoreInvoiceConsumption.js";

function mockAdmin({ lines, draws, layers }) {
  const layerUpdates = [];
  const consumptionUpdates = [];
  const layerById = new Map((layers || []).map((l) => [l.id, l]));
  function from(table) {
    const ctx = { table, isUpdate: false, payload: null };
    const chain = {
      select: () => chain,
      update: (payload) => { ctx.isUpdate = true; ctx.payload = payload; return chain; },
      eq: () => chain,
      is: () => chain,
      in: () => chain,
      maybeSingle: async () => {
        // only inventory_layers select→maybeSingle in this helper; id captured via closure below
        return { data: chain._wantLayer ? layerById.get(chain._wantLayer) || null : null };
      },
      then: (resolve) => {
        if (ctx.isUpdate) {
          (table === "inventory_layers" ? layerUpdates : consumptionUpdates).push(ctx.payload);
          return resolve({ error: null });
        }
        if (table === "ar_invoice_lines") return resolve({ data: lines });
        if (table === "inventory_consumption") return resolve({ data: draws });
        return resolve({ data: null });
      },
    };
    return chain;
  }
  // capture the layer id requested via .eq("id", x) before maybeSingle — simplest:
  // wrap from() so inventory_layers select uses the draw's layer_id in order.
  let layerSeq = 0;
  const layerOrder = (draws || []).map((d) => d.layer_id);
  const wrapped = (table) => {
    const c = from(table);
    if (table === "inventory_layers") {
      const origMaybe = c.maybeSingle;
      c.maybeSingle = async () => { const id = layerOrder[layerSeq++]; return { data: layerById.get(id) || null }; };
      void origMaybe;
    }
    return c;
  };
  return { from: wrapped, _layerUpdates: layerUpdates, _consumptionUpdates: consumptionUpdates };
}

describe("restoreInvoiceConsumption", () => {
  it("no-ops when the invoice has no lines (never posted draft)", async () => {
    const admin = mockAdmin({ lines: [] });
    const r = await restoreInvoiceConsumption(admin, "inv1");
    expect(r).toEqual({ restored_qty: 0, rows_reversed: 0 });
  });

  it("no-ops when there are no live draws", async () => {
    const admin = mockAdmin({ lines: [{ id: "il1" }], draws: [] });
    const r = await restoreInvoiceConsumption(admin, "inv1");
    expect(r.rows_reversed).toBe(0);
  });

  it("adds each draw's qty back to its layer and marks it reversed", async () => {
    const admin = mockAdmin({
      lines: [{ id: "il1" }],
      draws: [
        { id: "c1", layer_id: "L1", qty_consumed: 40 },
        { id: "c2", layer_id: "L2", qty_consumed: 10 },
      ],
      layers: [
        { id: "L1", original_qty: 100, remaining_qty: 60 }, // 40 was drawn → back to 100
        { id: "L2", original_qty: 10, remaining_qty: 0 },   // 10 drawn → back to 10
      ],
    });
    const r = await restoreInvoiceConsumption(admin, "inv1", "user1");
    expect(r).toEqual({ restored_qty: 50, rows_reversed: 2 });
    expect(admin._layerUpdates).toEqual([{ remaining_qty: 100 }, { remaining_qty: 10 }]);
    expect(admin._consumptionUpdates.every((u) => u.reversed_at && u.reversed_by_user_id === "user1")).toBe(true);
  });

  it("never inflates a layer past its original_qty", async () => {
    const admin = mockAdmin({
      lines: [{ id: "il1" }],
      draws: [{ id: "c1", layer_id: "L1", qty_consumed: 40 }],
      layers: [{ id: "L1", original_qty: 100, remaining_qty: 80 }], // 80+40=120 → capped 100
    });
    await restoreInvoiceConsumption(admin, "inv1");
    expect(admin._layerUpdates[0]).toEqual({ remaining_qty: 100 });
  });
});
