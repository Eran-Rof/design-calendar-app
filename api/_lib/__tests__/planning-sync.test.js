import { describe, it, expect, vi } from "vitest";
import { syncOnHandFromAtsSnapshot, syncOpenPosFromTandaPos, buildDdpDateMap, extractReceiptLines, syncReceiptsFromTandaPos } from "../planning-sync.js";

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
    eq(k, v)    { state.filters.push(["eq",    k, v]); return chain; },
    in(k, v)    { state.filters.push(["in",    k, v]); return chain; },
    lt(k, v)    { state.filters.push(["lt",    k, v]); return chain; },
    ilike(k, v) { state.filters.push(["ilike", k, v]); return chain; },
    limit(n)    { state.limit = n; return chain; },
    order()     { return chain; },
    range(a, b) { state.range = [a, b]; return chain; },
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

  it("dates the snapshot to the feed's latest Last Receipt Date (Xoro date), not today", async () => {
    const upserts = [];
    const admin = makeAdmin({
      app_data: {
        async maybeSingle() {
          return {
            data: {
              value: JSON.stringify({
                skus: [
                  { sku: "STY01-RED-S", onHand: 10, onPO: 0, onSO: 0, lastReceiptDate: "2026-04-10" },
                  { sku: "STY01-RED-M", onHand:  5, onPO: 0, onSO: 0, lastReceiptDate: "2026-06-22" }, // max
                  { sku: "STY02-BLU-S", onHand:  3, onPO: 0, onSO: 0, lastReceiptDate: "2026-05-01" },
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
          if (state.filters.some(([op]) => op === "in")) {
            return { data: [{ id: "sku-1", sku_code: "STY01-RED" }, { id: "sku-2", sku_code: "STY02-BLU" }], error: null };
          }
          return { data: [], error: null };
        },
      },
      ip_inventory_snapshot: {
        async upsert(state) { upserts.push(...state.upsertRows); return { data: null, error: null }; },
      },
    });

    const r = await syncOnHandFromAtsSnapshot(admin);
    expect(r.error).toBeNull();
    expect(upserts).toHaveLength(2);
    // Every snapshot row is dated to the LATEST receipt date across the feed.
    expect(upserts.every((u) => u.snapshot_date === "2026-06-22")).toBe(true);
  });

  it("clamps the snapshot date at today — a FUTURE Last Receipt Date can't push it forward", async () => {
    const upserts = [];
    const admin = makeAdmin({
      app_data: {
        async maybeSingle() {
          return {
            data: {
              value: JSON.stringify({
                skus: [
                  { sku: "STY01-RED-S", onHand: 10, onPO: 0, onSO: 0, lastReceiptDate: "2020-06-01" }, // real max ≤ today
                  { sku: "STY01-RED-M", onHand:  5, onPO: 0, onSO: 0, lastReceiptDate: "2099-12-31" }, // future incoming PO — must be ignored
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
          if (state.filters.some(([op]) => op === "in")) {
            return { data: [{ id: "sku-1", sku_code: "STY01-RED" }], error: null };
          }
          return { data: [], error: null };
        },
      },
      ip_inventory_snapshot: {
        async upsert(state) { upserts.push(...state.upsertRows); return { data: null, error: null }; },
      },
    });

    const r = await syncOnHandFromAtsSnapshot(admin);
    expect(r.error).toBeNull();
    // The 2099 date is a future incoming receipt → ignored; snapshot dates to the
    // latest date that is not in the future.
    expect(upserts.every((u) => u.snapshot_date === "2020-06-01")).toBe(true);
    expect(upserts.every((u) => u.snapshot_date <= new Date().toISOString().slice(0, 10))).toBe(true);
  });

  it("resolves color-grain candidate to size-grain master row via ilike fallback", async () => {
    // Repro for the 2026-05-29 finding: post_master_data loads master
    // at size-grain (RYB1469OB-Black-SML/-MED/...) from CurrentProducts,
    // but planning sync aggregates inventory at color-grain
    // (RYB1469OB-BLACK). The .in() lookup misses, the PPK strip doesn't
    // apply (no "-PPKn" suffix), and without the size-grain fallback
    // the code falls through to buildItemRow → apparel_dims_required
    // CHECK violation → silent drop. Fallback should ilike("RYB1469OB-
    // BLACK-%") and reuse the size-grain item id.
    const upserts = [];
    const ilikePatterns = [];
    let upsertCalled = false;
    const admin = makeAdmin({
      app_data: {
        async maybeSingle() {
          return {
            data: {
              value: JSON.stringify({
                skus: [
                  { sku: "RYB1469OB-Black-SML", onHand: 100, onPO: 0, onSO: 0 },
                  { sku: "RYB1469OB-Black-MED", onHand: 200, onPO: 0, onSO: 0 },
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
          // Bulk .in() lookup misses (master keyed at size-grain).
          if (state.filters.some(([op]) => op === "in")) {
            return { data: [], error: null };
          }
          // Size-grain fallback .ilike() should find an existing row.
          const ilike = state.filters.find(([op]) => op === "ilike");
          if (ilike) {
            ilikePatterns.push(ilike[2]);
            return { data: [{ id: "size-grain-1", sku_code: "RYB1469OB-Black-SML" }], error: null };
          }
          return { data: [], error: null };
        },
        async upsert() {
          upsertCalled = true;
          throw new Error("size-grain fallback should have avoided ip_item_master stub upsert");
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
    expect(upsertCalled).toBe(false);
    expect(ilikePatterns).toEqual(["RYB1469OB-BLACK-%"]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      sku_id: "size-grain-1",
      qty_on_hand: 300, // 100 + 200 aggregated to (style, color)
    });
    expect(r.new_skus).toBe(0); // no stub created
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

describe("buildDdpDateMap — WIP timing from Tanda milestones", () => {
  const ms = (po, dbd, exp, act = null) => ({ data: { po_number: po, days_before_ddp: dbd, expected_date: exp, actual_date: act } });

  it("maps each PO to its In-House/DDP (days_before_ddp=0) expected date", () => {
    const m = buildDdpDateMap([
      ms("ROF-P1", 120, "2026-08-03"),
      ms("ROF-P1", 0, "2026-12-01"),
      ms("ROF-P2", 0, "2026-09-15"),
    ]);
    expect(m.get("ROF-P1")).toBe("2026-12-01");
    expect(m.get("ROF-P2")).toBe("2026-09-15");
  });

  it("ignores non-DDP milestones (days_before_ddp != 0)", () => {
    const m = buildDdpDateMap([ms("ROF-P1", 30, "2026-11-01"), ms("ROF-P1", 10, "2026-11-20")]);
    expect(m.has("ROF-P1")).toBe(false);
  });

  it("prefers actual_date over expected_date once set", () => {
    const m = buildDdpDateMap([ms("ROF-P1", 0, "2026-12-01", "2026-12-10")]);
    expect(m.get("ROF-P1")).toBe("2026-12-10");
  });

  it("takes the latest date when a PO has several DDP rows (variants)", () => {
    const m = buildDdpDateMap([ms("ROF-P1", 0, "2026-12-01"), ms("ROF-P1", 0, "2026-12-20")]);
    expect(m.get("ROF-P1")).toBe("2026-12-20");
  });

  it("tolerates string days_before_ddp, missing data, and blank dates", () => {
    const m = buildDdpDateMap([
      { data: { po_number: "ROF-P1", days_before_ddp: "0", expected_date: "2026-12-01" } },
      { data: null },
      { data: { po_number: "ROF-P2", days_before_ddp: 0, expected_date: "" } },
      {},
    ]);
    expect(m.get("ROF-P1")).toBe("2026-12-01");
    expect(m.has("ROF-P2")).toBe(false);
    expect(m.size).toBe(1);
  });

  it("returns an empty map for empty/nullish input", () => {
    expect(buildDdpDateMap([]).size).toBe(0);
    expect(buildDdpDateMap(null).size).toBe(0);
  });
});

describe("extractReceiptLines — received PO lines from a tanda_pos payload", () => {
  const po = {
    PoNumber: "PO-2001",
    DateExpectedDelivery: "2026-03-01",
    PoLineArr: [
      { ItemNumber: "STY01-RED-M", QtyOrder: 10, QtyReceived: 6 },
      { ItemNumber: "STY01-RED-L", QtyOrder: 8, QtyReceived: 0 },   // nothing received → skipped
      { ItemNumber: "STY02-BLUE-S", QtyOrder: 4, QtyReceived: 4 },
    ],
  };

  it("keeps only lines with QtyReceived > 0, rolled to style+color grain", () => {
    const out = extractReceiptLines(po, "PO-2001", new Map());
    expect(out).toEqual([
      { sku: "STY01-RED", qty: 6, received_date: "2026-03-01", po_number: "PO-2001" },
      { sku: "STY02-BLUE", qty: 4, received_date: "2026-03-01", po_number: "PO-2001" },
    ]);
  });

  it("prefers the milestone DDP date over the Xoro expected date", () => {
    const ddp = new Map([["PO-2001", "2026-04-15"]]);
    const out = extractReceiptLines(po, "PO-2001", ddp);
    expect(out.every((l) => l.received_date === "2026-04-15")).toBe(true);
  });

  it("returns received_date null when the PO carries no expected date", () => {
    const undated = { PoNumber: "PO-3", PoLineArr: [{ ItemNumber: "S-C-M", QtyReceived: 5 }] };
    const out = extractReceiptLines(undated, "PO-3", new Map());
    expect(out).toEqual([{ sku: "S-C", qty: 5, received_date: null, po_number: "PO-3" }]);
  });

  it("falls through an empty PoLineArr to the Items array (historical/closed POs)", () => {
    // Fully-received POs carry lines under Items while PoLineArr is an empty [].
    const received = {
      PoNumber: "PT-P000143",
      DateExpectedDelivery: "12/30/2024",
      PoLineArr: [],
      Items: [
        { ItemNumber: "PTYB0214-Moonless Nights-28", QtyOrder: 16, QtyReceived: 16 },
        { ItemNumber: "PTYB0214-Moonless Nights-30", QtyOrder: 10, QtyReceived: 10 },
      ],
    };
    const out = extractReceiptLines(received, "PT-P000143", new Map());
    expect(out).toEqual([
      { sku: "PTYB0214-MOONLESSNIGHTS", qty: 16, received_date: "2024-12-30", po_number: "PT-P000143" },
      { sku: "PTYB0214-MOONLESSNIGHTS", qty: 10, received_date: "2024-12-30", po_number: "PT-P000143" },
    ]);
  });

  it("prefers each line's own expected date over the PO header date", () => {
    const multi = {
      PoNumber: "PT-P9",
      DateExpectedDelivery: "01/01/2025",
      Items: [
        { ItemNumber: "S-C-M", QtyReceived: 3, DateExpectedDelivery: "02/15/2025" },
        { ItemNumber: "S-C-L", QtyReceived: 2 }, // no line date → header
      ],
    };
    const out = extractReceiptLines(multi, "PT-P9", new Map());
    expect(out).toEqual([
      { sku: "S-C", qty: 3, received_date: "2025-02-15", po_number: "PT-P9" },
      { sku: "S-C", qty: 2, received_date: "2025-01-01", po_number: "PT-P9" },
    ]);
  });

  it("INCLUDES archived POs (they are the Received/Closed receipt history)", () => {
    const out = extractReceiptLines(
      { _archived: true, PoNumber: "PO-9", DateExpectedDelivery: "01/05/2025", Items: [{ ItemNumber: "A-B-M", QtyReceived: 7 }] },
      null, new Map());
    expect(out).toEqual([{ sku: "A-B", qty: 7, received_date: "2025-01-05", po_number: "PO-9" }]);
  });

  it("skips EOM, no-number and empty-line POs", () => {
    expect(extractReceiptLines({ PoNumber: "EOM-BALANCE", PoLineArr: [{ ItemNumber: "A-B-M", QtyReceived: 1 }] }, null, new Map())).toEqual([]);
    expect(extractReceiptLines({ PoNumber: "", PoLineArr: [] }, null, new Map())).toEqual([]);
    expect(extractReceiptLines({ PoNumber: "PO-4", DateExpectedDelivery: "2026-01-01", PoLineArr: [] }, null, new Map())).toEqual([]);
  });
});

describe("syncReceiptsFromTandaPos — happy path", () => {
  it("flattens received PO lines into ip_receipts_history rows (no-date skipped)", async () => {
    const upserts = [];
    let pageOne = true;
    const admin = makeAdmin({
      tanda_pos: {
        async select() {
          if (pageOne) {
            pageOne = false;
            return {
              data: [{
                po_number: "PO-2001",
                data: {
                  PoNumber: "PO-2001",
                  DateExpectedDelivery: "2026-03-01",
                  StatusName: "Received",
                  PoLineArr: [
                    { ItemNumber: "STY01-RED-M", QtyOrder: 10, QtyReceived: 6 },
                    { ItemNumber: "STY01-RED-L", QtyOrder: 8, QtyReceived: 4 }, // same style+color → collapses
                    { ItemNumber: "STY01-RED-XL", QtyOrder: 5, QtyReceived: 0 }, // nothing received → skipped
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
      ip_receipts_history: {
        async upsert(state) {
          upserts.push(...state.upsertRows);
          return { data: null, error: null };
        },
        async select() {
          return { data: [], error: null }; // no stale rows
        },
      },
    });

    const r = await syncReceiptsFromTandaPos(admin);

    expect(r.error).toBeUndefined();
    expect(r.errors).toEqual([]);
    expect(r.inserted).toBe(1); // two received size lines collapse into one style+color receipt
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      sku_id: "sku-1",
      po_number: "PO-2001",
      received_date: "2026-03-01",
      qty: 10, // 6 + 4
      source: "tanda",
      source_line_key: "tanda:PO-2001:STY01-RED",
    });
  });
});
