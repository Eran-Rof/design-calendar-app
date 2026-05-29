// Tests for the Faire orders ingest cron (P12c-2).
//
// Exercises runFaireOrdersIngest via a tiny in-memory supabase double:
//   - lookback floor (computeUpdatedAtMin) — last-sync vs floor
//   - first-order detection: new buyer → 25% commission, existing → 15%
//   - multi-page walk
//   - multi-shop orchestration with per-shop error isolation
//   - faire_shops.last_orders_sync_at cursor update
//   - line-items upsert
//   - is_first_order_completed flag flip after first successful order

import { describe, it, expect } from "vitest";
import { runFaireOrdersIngest, computeUpdatedAtMin, toCents } from "../faire-orders-nightly.js";

// ── In-memory supabase double ───────────────────────────────────────────────
function makeStore(initial = {}) {
  const tables = {
    faire_shops: [...(initial.faire_shops || [])],
    faire_buyers: [...(initial.faire_buyers || [])],
    faire_orders: [...(initial.faire_orders || [])],
    faire_order_items: [...(initial.faire_order_items || [])],
  };

  function table(name) {
    if (!tables[name]) throw new Error(`unknown table ${name}`);
    return tables[name];
  }

  function makeBuilder(name, state = {}) {
    const rows = table(name);
    const filters = state.filters || [];
    const builder = {
      _rows: rows,
      _filters: filters,
      _pendingUpdate: state.pendingUpdate || null,
      _pendingInsert: state.pendingInsert || null,
      _pendingUpsert: state.pendingUpsert || null,
      select() { return this; },
      eq(col, val) { this._filters.push((r) => r[col] === val); return this; },
      not(col, op, val) {
        if (op === "is" && val === null) {
          this._filters.push((r) => r[col] != null);
        }
        return this;
      },
      maybeSingle() {
        const matched = this._rows.filter((r) => this._filters.every((f) => f(r)));
        return Promise.resolve({ data: matched[0] || null, error: null });
      },
      insert(row) {
        const inserted = { ...row, id: row.id || `row-${name}-${this._rows.length + 1}` };
        this._rows.push(inserted);
        this._pendingInsert = inserted;
        return this;
      },
      upsert(row, opts) {
        const onConflict = (opts && opts.onConflict) || "";
        const keys = onConflict.split(",").map((s) => s.trim()).filter(Boolean);
        let existing = null;
        if (keys.length > 0) {
          existing = this._rows.find((r) => keys.every((k) => r[k] === row[k]));
        }
        if (existing) {
          Object.assign(existing, row);
          this._pendingUpsert = existing;
        } else {
          const id = row.id || `row-${name}-${this._rows.length + 1}`;
          const created = { id, ...row };
          this._rows.push(created);
          this._pendingUpsert = created;
        }
        return this;
      },
      update(row) {
        const matched = this._rows.filter((r) => this._filters.every((f) => f(r)));
        for (const m of matched) Object.assign(m, row);
        this._pendingUpdate = { rows: matched, patch: row };
        return this;
      },
      then(resolve) {
        const matched = this._rows.filter((r) => this._filters.every((f) => f(r)));
        return resolve({ data: matched, error: null });
      },
    };
    return builder;
  }

  return {
    tables,
    from(name) { return makeBuilder(name); },
  };
}

// ── Mock client factory ─────────────────────────────────────────────────────
function makeClientStub(orderPages) {
  let callIdx = 0;
  const calls = [];
  return {
    calls,
    factory: () => ({
      async listOrders(args) {
        const idx = callIdx++;
        calls.push({ method: "listOrders", args, callIndex: idx });
        const page = orderPages[idx] || { data: [], hasNextPage: false, page: args.page };
        return page;
      },
    }),
  };
}

const FAKE_KEY = "decrypted-test-key";

describe("computeUpdatedAtMin", () => {
  it("returns sinceOverride verbatim when provided", () => {
    const v = computeUpdatedAtMin("2026-05-01T00:00:00Z", "2026-04-15T00:00:00Z", new Date("2026-05-28T00:00:00Z").getTime());
    expect(v).toBe("2026-04-15T00:00:00Z");
  });

  it("returns now-30d when last_orders_sync_at is null", () => {
    const now = new Date("2026-05-28T00:00:00Z").getTime();
    const v = computeUpdatedAtMin(null, null, now);
    expect(new Date(v).getTime()).toBe(now - 30 * 24 * 60 * 60 * 1000);
  });

  it("returns last_sync when newer than now-30d", () => {
    const now = new Date("2026-05-28T00:00:00Z").getTime();
    const lastSync = "2026-05-25T00:00:00Z";
    const v = computeUpdatedAtMin(lastSync, null, now);
    expect(v).toBe(new Date(lastSync).toISOString());
  });

  it("returns now-30d when last_sync is older than the floor", () => {
    const now = new Date("2026-05-28T00:00:00Z").getTime();
    const lastSync = "2026-01-01T00:00:00Z";
    const v = computeUpdatedAtMin(lastSync, null, now);
    expect(new Date(v).getTime()).toBe(now - 30 * 24 * 60 * 60 * 1000);
  });
});

describe("toCents", () => {
  it("treats floats as dollars", () => {
    expect(toCents(12.34)).toBe(1234);
    expect(toCents(0.99)).toBe(99);
  });
  it("treats whole numbers as cents", () => {
    expect(toCents(1234)).toBe(1234);
    expect(toCents(0)).toBe(0);
  });
  it("handles null/undefined/NaN gracefully", () => {
    expect(toCents(null)).toBe(0);
    expect(toCents(undefined)).toBe(0);
    expect(toCents("not a number")).toBe(0);
  });
});

describe("runFaireOrdersIngest — empty + skip cases", () => {
  it("returns zero summary when no shops", async () => {
    const sb = makeStore({ faire_shops: [] });
    const out = await runFaireOrdersIngest(sb, {
      deps: {
        decryptToken: () => FAKE_KEY,
        makeClient: makeClientStub([]).factory,
        now: () => new Date("2026-05-28T00:00:00Z").getTime(),
      },
    });
    expect(out.shops_scanned).toBe(0);
    expect(out.orders_upserted_total).toBe(0);
    expect(out.errors).toEqual([]);
  });
});

describe("runFaireOrdersIngest — first-order detection + commission rate", () => {
  it("flags is_first_order_for_buyer=true + commission_rate=0.25 for a new buyer", async () => {
    const sb = makeStore({
      faire_shops: [{
        id: "shop-1", entity_id: "ent-1", shop_name: "Test Shop",
        faire_shop_token: "shop_token_1",
        api_key_ciphertext: Buffer.from("c"),
        api_key_iv: Buffer.from("i"),
        api_key_tag: Buffer.from("t"),
        is_active: true,
        last_orders_sync_at: null,
      }],
    });
    const stub = makeClientStub([
      {
        data: [{
          id: "ord_1",
          brand_token: "brand_A",
          buyer: { name: "Acme Boutique", email: "buy@acme.test" },
          placed_at: "2026-05-25T10:00:00Z",
          state: "PROCESSING",
          subtotal: 100.50,    // float → dollars → 10050 cents
          shipping: 10.75,     // float → dollars → 1075 cents
          items: [
            { id: "item_1", sku: "SKU-A", product_name: "Tee", quantity: 5, unit_price_wholesale: 20.10, line_total: 100.50 },
          ],
        }],
        hasNextPage: false,
        page: 1,
      },
    ]);
    const out = await runFaireOrdersIngest(sb, {
      deps: {
        decryptToken: () => FAKE_KEY,
        makeClient: stub.factory,
        now: () => new Date("2026-05-28T00:00:00Z").getTime(),
      },
    });

    expect(out.orders_upserted_total).toBe(1);
    expect(out.lines_upserted_total).toBe(1);
    expect(out.errors).toEqual([]);

    const order = sb.tables.faire_orders[0];
    expect(order.is_first_order_for_buyer).toBe(true);
    expect(order.commission_rate).toBe(0.25);
    expect(order.subtotal_cents).toBe(10050);
    expect(order.shipping_cents).toBe(1075);
    // commission_cents = round(subtotal_cents * 0.25) = round(10050 * 0.25) = 2513
    expect(order.commission_cents).toBe(2513);
    // net_payout = subtotal + shipping - commission = 10050 + 1075 - 2513 = 8612
    expect(order.net_payout_cents).toBe(8612);

    // Buyer row should now have is_first_order_completed=true.
    const buyer = sb.tables.faire_buyers.find((b) => b.faire_brand_token === "brand_A");
    expect(buyer).toBeDefined();
    expect(buyer.is_first_order_completed).toBe(true);
    expect(buyer.first_order_at).toBe("2026-05-25T10:00:00Z");
  });

  it("uses commission_rate=0.15 for a returning buyer (is_first_order_completed=true pre-existing)", async () => {
    const sb = makeStore({
      faire_shops: [{
        id: "shop-1", entity_id: "ent-1", shop_name: "Test Shop",
        api_key_ciphertext: Buffer.from("c"),
        api_key_iv: Buffer.from("i"),
        api_key_tag: Buffer.from("t"),
        is_active: true,
      }],
      faire_buyers: [{
        id: "buyer-existing", entity_id: "ent-1", faire_shop_id: "shop-1",
        faire_brand_token: "brand_RECUR",
        buyer_name: "Existing Buyer",
        is_first_order_completed: true,
      }],
    });
    const stub = makeClientStub([
      {
        data: [{
          id: "ord_2",
          brand_token: "brand_RECUR",
          buyer: { name: "Existing Buyer" },
          placed_at: "2026-05-26T10:00:00Z",
          state: "PROCESSING",
          subtotal: 200.50,
          shipping: 15.00,
          items: [],
        }],
        hasNextPage: false,
        page: 1,
      },
    ]);
    await runFaireOrdersIngest(sb, {
      deps: {
        decryptToken: () => FAKE_KEY,
        makeClient: stub.factory,
        now: () => new Date("2026-05-28T00:00:00Z").getTime(),
      },
    });
    const order = sb.tables.faire_orders[0];
    expect(order.is_first_order_for_buyer).toBe(false);
    expect(order.commission_rate).toBe(0.15);
    expect(order.subtotal_cents).toBe(20050);
    // commission_cents = round(20050 * 0.15) = 3008 (rounded from 3007.5)
    expect(order.commission_cents).toBe(3008);
  });

  it("honors order-level is_first_order=false even if buyer row is new", async () => {
    const sb = makeStore({
      faire_shops: [{
        id: "shop-1", entity_id: "ent-1",
        api_key_ciphertext: Buffer.from("c"),
        api_key_iv: Buffer.from("i"),
        api_key_tag: Buffer.from("t"),
        is_active: true,
      }],
    });
    const stub = makeClientStub([
      {
        data: [{
          id: "ord_3",
          brand_token: "brand_X",
          buyer: { name: "B" },
          placed_at: "2026-05-26T10:00:00Z",
          state: "NEW",
          subtotal: 50.00,
          shipping: 0,
          is_first_order: false,    // Faire says NOT first order even though buyer is new in our DB
          items: [],
        }],
        hasNextPage: false,
        page: 1,
      },
    ]);
    await runFaireOrdersIngest(sb, {
      deps: {
        decryptToken: () => FAKE_KEY,
        makeClient: stub.factory,
        now: () => new Date("2026-05-28T00:00:00Z").getTime(),
      },
    });
    const order = sb.tables.faire_orders[0];
    expect(order.is_first_order_for_buyer).toBe(false);
    expect(order.commission_rate).toBe(0.15);
  });
});

describe("runFaireOrdersIngest — multi-page walk", () => {
  it("walks pages until hasNextPage=false", async () => {
    const sb = makeStore({
      faire_shops: [{
        id: "shop-1", entity_id: "ent-1",
        api_key_ciphertext: Buffer.from("c"),
        api_key_iv: Buffer.from("i"),
        api_key_tag: Buffer.from("t"),
        is_active: true,
      }],
    });
    const stub = makeClientStub([
      { data: [{ id: "o1", brand_token: "b1", buyer: { name: "B1" }, placed_at: "2026-05-25T00:00:00Z", state: "NEW", subtotal: 50, shipping: 0, items: [] }], hasNextPage: true, page: 1 },
      { data: [{ id: "o2", brand_token: "b2", buyer: { name: "B2" }, placed_at: "2026-05-26T00:00:00Z", state: "NEW", subtotal: 50, shipping: 0, items: [] }], hasNextPage: true, page: 2 },
      { data: [{ id: "o3", brand_token: "b3", buyer: { name: "B3" }, placed_at: "2026-05-27T00:00:00Z", state: "NEW", subtotal: 50, shipping: 0, items: [] }], hasNextPage: false, page: 3 },
    ]);
    const out = await runFaireOrdersIngest(sb, {
      deps: {
        decryptToken: () => FAKE_KEY,
        makeClient: stub.factory,
        now: () => new Date("2026-05-28T00:00:00Z").getTime(),
      },
    });
    expect(stub.calls.length).toBe(3);
    expect(stub.calls.map((c) => c.args.page)).toEqual([1, 2, 3]);
    expect(out.orders_upserted_total).toBe(3);
  });
});

describe("runFaireOrdersIngest — multi-shop + error isolation", () => {
  it("isolates a failing shop and continues with the next", async () => {
    const sb = makeStore({
      faire_shops: [
        { id: "shop-bad", entity_id: "ent-1", shop_name: "Bad", api_key_ciphertext: Buffer.from("c"), api_key_iv: Buffer.from("i"), api_key_tag: Buffer.from("t"), is_active: true },
        { id: "shop-good", entity_id: "ent-1", shop_name: "Good", api_key_ciphertext: Buffer.from("c"), api_key_iv: Buffer.from("i"), api_key_tag: Buffer.from("t"), is_active: true },
      ],
    });

    let callIdx = 0;
    const makeClient = () => ({
      async listOrders() {
        callIdx += 1;
        if (callIdx === 1) {
          throw new Error("network exploded");
        }
        return { data: [{ id: "ok", brand_token: "b", buyer: { name: "B" }, placed_at: "2026-05-25T00:00:00Z", state: "NEW", subtotal: 50, shipping: 0, items: [] }], hasNextPage: false, page: 1 };
      },
    });

    const out = await runFaireOrdersIngest(sb, {
      deps: {
        decryptToken: () => FAKE_KEY,
        makeClient,
        now: () => new Date("2026-05-28T00:00:00Z").getTime(),
      },
    });

    expect(out.shops_scanned).toBe(2);
    expect(out.errors.length).toBe(1);
    expect(out.errors[0]).toMatch(/shop-bad/);
    expect(out.errors[0]).toMatch(/network exploded/);
    expect(out.orders_upserted_total).toBe(1);  // good shop still wrote one order
  });

  it("propagates decryptToken failure into the per-shop error", async () => {
    const sb = makeStore({
      faire_shops: [{
        id: "shop-1", entity_id: "ent-1",
        api_key_ciphertext: Buffer.from("c"),
        api_key_iv: Buffer.from("i"),
        api_key_tag: Buffer.from("t"),
        is_active: true,
      }],
    });
    const out = await runFaireOrdersIngest(sb, {
      deps: {
        decryptToken: () => { throw new Error("key gone"); },
        makeClient: () => { throw new Error("should not be called"); },
        now: () => new Date("2026-05-28T00:00:00Z").getTime(),
      },
    });
    expect(out.errors[0]).toMatch(/key gone/);
    expect(out.shops_scanned).toBe(1);
    expect(out.orders_upserted_total).toBe(0);
  });
});

describe("runFaireOrdersIngest — last_orders_sync_at cursor update", () => {
  it("updates faire_shops.last_orders_sync_at after successful run", async () => {
    const sb = makeStore({
      faire_shops: [{
        id: "shop-1", entity_id: "ent-1",
        api_key_ciphertext: Buffer.from("c"),
        api_key_iv: Buffer.from("i"),
        api_key_tag: Buffer.from("t"),
        is_active: true,
        last_orders_sync_at: null,
      }],
    });
    const stub = makeClientStub([{ data: [], hasNextPage: false, page: 1 }]);
    const nowMs = new Date("2026-05-28T04:00:00Z").getTime();
    await runFaireOrdersIngest(sb, {
      deps: {
        decryptToken: () => FAKE_KEY,
        makeClient: stub.factory,
        now: () => nowMs,
      },
    });
    const shop = sb.tables.faire_shops[0];
    expect(shop.last_orders_sync_at).toBe(new Date(nowMs).toISOString());
  });
});

describe("runFaireOrdersIngest — onlyShopId scoping", () => {
  it("when onlyShopId is set, only that shop is queried", async () => {
    const sb = makeStore({
      faire_shops: [
        { id: "shop-A", entity_id: "ent-1", api_key_ciphertext: Buffer.from("c"), api_key_iv: Buffer.from("i"), api_key_tag: Buffer.from("t"), is_active: true },
        { id: "shop-B", entity_id: "ent-1", api_key_ciphertext: Buffer.from("c"), api_key_iv: Buffer.from("i"), api_key_tag: Buffer.from("t"), is_active: true },
      ],
    });
    const stub = makeClientStub([
      { data: [], hasNextPage: false, page: 1 },
    ]);
    const out = await runFaireOrdersIngest(sb, {
      onlyShopId: "shop-B",
      deps: {
        decryptToken: () => FAKE_KEY,
        makeClient: stub.factory,
        now: () => new Date("2026-05-28T00:00:00Z").getTime(),
      },
    });
    expect(out.shops_scanned).toBe(1);
    expect(out.per_shop[0].faire_shop_id).toBe("shop-B");
  });
});
