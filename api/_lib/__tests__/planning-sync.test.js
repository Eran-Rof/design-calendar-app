import { describe, it, expect, vi } from "vitest";
import { syncOnHandFromAtsSnapshot, syncOpenPosFromTandaPos } from "../planning-sync.js";

// Minimal Supabase admin stub. Each test wires up only the table
// methods it actually needs; the rest fall through to a generic empty
// chain so unrelated calls don't crash. Mirrors the chainable shape of
// @supabase/supabase-js so the system under test sees the real API.
function makeAdmin(tables) {
  return {
    from(table) {
      const handler = tables[table] ?? {};
      return makeChain(handler, table);
    },
  };
}

function makeChain(handler, table) {
  const state = {
    op: null,        // "select" | "upsert" | "delete"
    selectArgs: null,
    upsertRows: null,
    upsertOpts: null,
    deleteOpts: null,
    filters: [],
    range: null,
  };
  const chain = {
    select(args) {
      // .upsert(...).select(...) and standalone .select(...) both land here.
      if (state.op === null) state.op = "select";
      state.selectArgs = args;
      return chain;
    },
    upsert(rows, opts) {
      state.op = "upsert";
      state.upsertRows = rows;
      state.upsertOpts = opts;
      return chain;
    },
    delete(opts) {
      state.op = "delete";
      state.deleteOpts = opts;
      return chain;
    },
    eq(k, v)   { state.filters.push(["eq",  k, v]); return chain; },
    in(k, v)   { state.filters.push(["in",  k, v]); return chain; },
    lt(k, v)   { state.filters.push(["lt",  k, v]); return chain; },
    order()    { return chain; },
    range(a, b){ state.range = [a, b]; return chain; },
    async maybeSingle() {
      const r = handler.maybeSingle ? await handler.maybeSingle(state) : { data: null, error: null };
      return r;
    },
    then(onFulfilled, onRejected) {
      const promise = (async () => {
        if (state.op === "upsert" && handler.upsert) return handler.upsert(state);
        if (state.op === "delete" && handler.delete) return handler.delete(state);
        if (state.op === "select" && handler.select) return handler.select(state);
        // Sensible defaults for chains the test didn't wire: empty result.
        if (state.op === "select") return { data: [], error: null };
        return { data: null, error: null, count: 0 };
      })();
      return promise.then(onFulfilled, onRejected);
    },
  };
  return chain;
}

describe("syncOnHandFromAtsSnapshot — happy path", () => {
  it("upserts one snapshot row per (style+color) and reports totals", async () => {
    const upserts = [];
    const admin = makeAdmin({
      app_data: {
        async maybeSingle() {
          return {
            data: {
              value: JSON.stringify({
                skus: [
                  { sku: "STY01-RED-S", onHand: 10, onPO: 0, onSO: 2 },
                  { sku: "STY01-RED-M", onHand:  5, onPO: 3, onSO: 1 },
                ],
                sos: [],
              }),
            },
            error: null,
          };
        },
      },
      ip_item_master: {
        async select(state) {
          // Initial `.in("sku_code", chunk)` lookup returns the existing
          // master row so the sync skips stub-creation entirely.
          if (state.filters.some(([op]) => op === "in")) {
            return { data: [{ id: "sku-1", sku_code: "STY01-RED" }], error: null };
          }
          return { data: [], error: null };
        },
        async upsert() {
          // Style+color is already in master — no stub create expected.
          throw new Error("did not expect ip_item_master.upsert");
        },
      },
      ip_inventory_snapshot: {
        async upsert(state) {
          upserts.push(...state.upsertRows);
          return { data: null, error: null };
        },
      },
    });

    const r = await syncOnHandFromAtsSnapshot(admin);

    expect(r.error).toBeNull();
    expect(r.upserted).toBe(1);
    expect(r.new_skus).toBe(0);
    expect(r.scanned).toBe(2);
    expect(r.chunks).toBe(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      sku_id: "sku-1",
      qty_on_hand: 15, // 10 + 5 aggregated to style+color
      qty_committed: 3,
      qty_on_order: 3,
      source: "manual",
    });
  });

  it("returns error when no ATS snapshot is uploaded", async () => {
    const admin = makeAdmin({
      app_data: { async maybeSingle() { return { data: null, error: null }; } },
    });
    const r = await syncOnHandFromAtsSnapshot(admin);
    expect(r.error).toMatch(/No ATS Excel snapshot/);
    expect(r.upserted).toBe(0);
  });
});

describe("syncOpenPosFromTandaPos — happy path", () => {
  it("flattens a tanda PO into ip_open_purchase_orders rows", async () => {
    const upserts = [];
    let pageOne = true;
    const admin = makeAdmin({
      tanda_pos: {
        async select() {
          if (pageOne) {
            pageOne = false;
            return {
              data: [{
                po_number: "PO-1001",
                data: {
                  PoNumber: "PO-1001",
                  DateOrder: "2026-01-15",
                  DateExpectedDelivery: "2026-03-01",
                  CurrencyCode: "USD",
                  StatusName: "open",
                  BuyerName: "ACME WHOLESALE",
                  PoLineArr: [
                    { ItemNumber: "STY01-RED-M", QtyOrder: 10, QtyReceived: 2, UnitPrice: 12.5 },
                    { ItemNumber: "STY01-RED-L", QtyOrder: 8,  QtyReceived: 0, UnitPrice: 12.5 },
                  ],
                },
              }],
              error: null,
            };
          }
          return { data: [], error: null };
        },
      },
      ip_item_master: {
        async select() {
          return { data: [{ id: "sku-1", sku_code: "STY01-RED" }], error: null };
        },
      },
      ip_customer_master: {
        async select() {
          return { data: [{ id: "cust-acme", customer_code: "ACME", name: "ACME WHOLESALE" }], error: null };
        },
        async maybeSingle() {
          return { data: { id: "supply-only-id" }, error: null };
        },
      },
      ip_open_purchase_orders: {
        async upsert(state) {
          upserts.push(...state.upsertRows);
          return { data: null, error: null };
        },
        async select() {
          // No stale rows to prune.
          return { data: [], error: null };
        },
      },
    });

    const r = await syncOpenPosFromTandaPos(admin);

    expect(r.error).toBeUndefined();
    expect(r.inserted).toBe(1); // two size lines collapse into one style+color row
    expect(r.errors).toEqual([]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      sku_id: "sku-1",
      po_number: "PO-1001",
      qty_ordered: 18,   // 10 + 8
      qty_received: 2,
      qty_open: 16,      // (10-2) + 8
      currency: "USD",
      customer_id: "cust-acme",
      source: "xoro",
    });
  });
});
