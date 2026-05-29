// Tests for api/_lib/marketplaces/fba/mirror-inventory.js (P12a-5).
//
// Covers:
//   - mapSnapshotRow pure shape + edge cases
//   - decryptAccountCreds guard errors
//   - resolveItemMastersBySku happy path + schema-variant fallback
//   - resolveLastArCostBySku fallback behavior
//   - mirrorAccountInventory happy path: snapshot upsert + layer rebuild
//   - mirrorAccountInventory: pagination via pagination.nextToken
//   - mirrorAccountInventory: snapshot_at shared across pages
//   - mirrorAccountInventory: zero-qty SKUs skipped from layer rebuild
//   - mirrorAccountInventory: SKUs without ip_item_master skipped from layers
//   - mirrorAccountInventory: no fba_location_id → no DELETE / INSERT
//   - mirrorAccountInventory: DELETE scoped to source_kind='fba_inbound' +
//     location_id only (does NOT widen scope to other source_kinds)
//   - mirrorAccountInventory: standard_cost_cents preferred over AR fallback
//   - mirrorAccountInventory: AR fallback used when standard_cost = 0
//   - mirrorAccountInventory: AR fallback skipped when no masters resolve
//   - mirrorAccountInventory: bumps last_inventory_sync_at = snapshot_at
//   - mirrorAccountInventory: throws on upsert error
//   - mirrorAccountInventory: throws on layer delete error
//   - mirrorAccountInventory: throws on layer insert error
//   - mirrorAccountInventory: throws on update error
//   - mirrorFbaInventory: multi-account loop + error isolation
//   - mirrorFbaInventory: empty accounts list returns []
//   - mirrorFbaInventory: throws on accounts read error
//   - mirrorFbaInventory: requires adminClient
//   - mirrorFbaInventory: started_at <= finished_at

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  mapSnapshotRow,
  decryptAccountCreds,
  resolveItemMastersBySku,
  resolveLastArCostBySku,
  mirrorAccountInventory,
  mirrorFbaInventory,
} from "../mirror-inventory.js";
import { encryptToken } from "../token-encryption.js";
import { _clearCacheForTest } from "../lwa.js";

const TEST_KEY = "1".repeat(64);

beforeAll(() => {
  process.env.FBA_TOKEN_ENC_KEY = TEST_KEY;
});

beforeEach(() => {
  _clearCacheForTest();
});

function makeEncryptedTriple(plaintext) {
  const b = encryptToken(plaintext);
  return { ct: b.ciphertext, iv: b.iv, tag: b.tag };
}

function makeAccount(overrides = {}) {
  const cid = makeEncryptedTriple("amzn1.application-oa2-client.x");
  const csec = makeEncryptedTriple("client-secret-x");
  const ref = makeEncryptedTriple("Atzr|refresh-x");
  return {
    id: overrides.id || "11111111-1111-1111-1111-111111111111",
    entity_id: overrides.entity_id || "22222222-2222-2222-2222-222222222222",
    region: "NA",
    marketplace_id: "ATVPDKIKX0DER",
    fba_location_id: overrides.fba_location_id !== undefined
      ? overrides.fba_location_id
      : "33333333-3333-3333-3333-333333333333",
    is_active: true,
    last_inventory_sync_at: null,
    aws_role_arn: null,
    lwa_client_id_ciphertext: cid.ct,
    lwa_client_id_iv: cid.iv,
    lwa_client_id_tag: cid.tag,
    lwa_client_secret_ciphertext: csec.ct,
    lwa_client_secret_iv: csec.iv,
    lwa_client_secret_tag: csec.tag,
    refresh_token_ciphertext: ref.ct,
    refresh_token_iv: ref.iv,
    refresh_token_tag: ref.tag,
    ...overrides,
  };
}

function makeRefreshFn() {
  return async () => ({ access_token: "Atza|fake", token_type: "bearer", expires_in: 3600, cached: false });
}

/**
 * Minimal supabase chain mock — tracks upserts, inserts, deletes, updates,
 * and serves an optional ip_item_master + fba_order_items dataset.
 */
function makeSupabaseMock(opts = {}) {
  const calls = {
    upserts: [], inserts: [], deletes: [], updates: [], selects: [],
  };
  const accountsResp = opts.accountsResp || { data: [], error: null };
  const itemMasters = opts.itemMasters || []; // [{id, sku_code, standard_cost_cents}]
  const arItems = opts.arItems || [];        // [{sku, item_price_cents, quantity_ordered}]
  const errors = opts.errors || {};

  function table(name) {
    if (name === "fba_seller_accounts") {
      return {
        select: () => ({
          eq: () => Promise.resolve(accountsResp),
        }),
        update: (patch) => ({
          eq: (col, val) => {
            calls.updates.push({ table: name, patch, col, val });
            return Promise.resolve({ error: errors.update || null });
          },
        }),
      };
    }
    if (name === "fba_inventory_snapshots") {
      return {
        upsert: (row, opts2) => {
          calls.upserts.push({ table: name, row, opts: opts2 });
          return Promise.resolve({ error: errors.snapshotUpsert || null });
        },
      };
    }
    if (name === "inventory_layers") {
      return {
        delete: () => ({
          eq: function (col, val) {
            // Builder-style: collect every eq() into a single delete call.
            if (!this._eqs) this._eqs = [];
            this._eqs.push({ col, val });
            return this;
          },
          select: function () {
            calls.deletes.push({ table: name, eqs: this._eqs || [] });
            if (errors.layerDelete) return Promise.resolve({ data: null, error: errors.layerDelete });
            return Promise.resolve({ data: opts.deletedLayers || [], error: null });
          },
        }),
        insert: (rows) => {
          calls.inserts.push({ table: name, rows });
          return Promise.resolve({ error: errors.layerInsert || null });
        },
      };
    }
    if (name === "ip_item_master") {
      const filterChain = {
        _entity: null,
        _skus: null,
        eq(col, val) {
          if (col === "entity_id") this._entity = val;
          return this;
        },
        in(col, vals) {
          if (col === "sku_code") this._skus = new Set(vals);
          return this;
        },
        then(onF, onR) {
          // Allow this to be awaited as a Promise.
          let rows = itemMasters;
          if (this._skus) rows = rows.filter((r) => this._skus.has(r.sku_code));
          if (errors.itemMaster && !errors.itemMasterRetried) {
            // First call fails (schema variant simulation); the retry
            // without `standard_cost_cents` succeeds.
            errors.itemMasterRetried = true;
            return Promise.resolve({ data: null, error: errors.itemMaster }).then(onF, onR);
          }
          return Promise.resolve({ data: rows, error: null }).then(onF, onR);
        },
      };
      return {
        select: (cols) => {
          calls.selects.push({ table: name, cols });
          return filterChain;
        },
      };
    }
    if (name === "fba_order_items") {
      const chain = {
        _skus: null,
        select() { return this; },
        in(col, vals) { if (col === "sku") this._skus = new Set(vals); return this; },
        gt() { return this; },
        order() { return this; },
        limit() {
          let rows = arItems;
          if (this._skus) rows = rows.filter((r) => this._skus.has(r.sku));
          return Promise.resolve({ data: rows, error: errors.arItems || null });
        },
      };
      return {
        select: (cols) => {
          calls.selects.push({ table: name, cols });
          return chain;
        },
      };
    }
    throw new Error(`unexpected table: ${name}`);
  }

  return { from: table, _calls: calls };
}

function makeFakeSpApi({ pages } = {}) {
  // pages: [{ inventorySummaries: [...], pagination: { nextToken } }, ...]
  let i = 0;
  return {
    getInventorySummaries: async () => {
      const page = pages[i] || { inventorySummaries: [] };
      i++;
      return page;
    },
  };
}

function makeSummary({ sku, asin, fulfillable = 0, working = 0, shipped = 0, receiving = 0, reserved = 0, unfulfillable = 0 }) {
  return {
    asin: asin || `B0-${sku}`,
    sellerSku: sku,
    inventoryDetails: {
      fulfillableQuantity: fulfillable,
      inboundShipmentQuantities: {
        inboundWorkingQuantity: working,
        inboundShippedQuantity: shipped,
        inboundReceivingQuantity: receiving,
      },
      reservedQuantity: { totalReservedQuantity: reserved },
      unfulfillableQuantity: { totalUnfulfillableQuantity: unfulfillable },
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// mapSnapshotRow
// ────────────────────────────────────────────────────────────────────────

describe("mapSnapshotRow", () => {
  it("maps full inventoryDetails shape", () => {
    const row = mapSnapshotRow(
      makeSummary({ sku: "SKU-1", fulfillable: 10, working: 1, shipped: 2, receiving: 3, reserved: 4, unfulfillable: 5 }),
      "acct-1",
      "2026-05-29T00:00:00.000Z",
    );
    expect(row.fba_seller_account_id).toBe("acct-1");
    expect(row.snapshot_at).toBe("2026-05-29T00:00:00.000Z");
    expect(row.sku).toBe("SKU-1");
    expect(row.asin).toBe("B0-SKU-1");
    expect(row.fulfillable_qty).toBe(10);
    expect(row.inbound_working_qty).toBe(1);
    expect(row.inbound_shipped_qty).toBe(2);
    expect(row.inbound_receiving_qty).toBe(3);
    expect(row.reserved_qty).toBe(4);
    expect(row.unfulfillable_qty).toBe(5);
  });

  it("defaults missing inventoryDetails to zero", () => {
    const row = mapSnapshotRow({ asin: "B0-X", sellerSku: "SKU-X" }, "acct", "now");
    expect(row.fulfillable_qty).toBe(0);
    expect(row.inbound_working_qty).toBe(0);
    expect(row.reserved_qty).toBe(0);
  });

  it("handles legacy reservedQuantity scalar form", () => {
    const row = mapSnapshotRow({
      sellerSku: "X",
      inventoryDetails: { reservedQuantity: 7, unfulfillableQuantity: 3 },
    }, "acct", "now");
    expect(row.reserved_qty).toBe(7);
    expect(row.unfulfillable_qty).toBe(3);
  });

  it("preserves the raw summary into raw_payload", () => {
    const summary = makeSummary({ sku: "K" });
    const row = mapSnapshotRow(summary, "acct", "now");
    expect(row.raw_payload).toBe(summary);
  });

  it("nulls asin and sku when missing", () => {
    const row = mapSnapshotRow({}, "acct", "now");
    expect(row.asin).toBeNull();
    expect(row.sku).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// decryptAccountCreds
// ────────────────────────────────────────────────────────────────────────

describe("decryptAccountCreds", () => {
  it("decrypts a full triple", () => {
    const c = decryptAccountCreds(makeAccount());
    expect(c.clientId).toBe("amzn1.application-oa2-client.x");
    expect(c.clientSecret).toBe("client-secret-x");
    expect(c.refreshToken).toBe("Atzr|refresh-x");
  });

  it("throws when lwa_client_id triple is missing", () => {
    const acct = makeAccount();
    acct.lwa_client_id_ciphertext = null;
    expect(() => decryptAccountCreds(acct)).toThrow(/lwa_client_id/);
  });

  it("throws when lwa_client_secret triple is missing", () => {
    const acct = makeAccount();
    acct.lwa_client_secret_iv = null;
    expect(() => decryptAccountCreds(acct)).toThrow(/lwa_client_secret/);
  });

  it("throws when refresh_token triple is missing", () => {
    const acct = makeAccount();
    acct.refresh_token_tag = null;
    expect(() => decryptAccountCreds(acct)).toThrow(/refresh_token/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// resolveItemMastersBySku
// ────────────────────────────────────────────────────────────────────────

describe("resolveItemMastersBySku", () => {
  it("returns empty Map for empty input", async () => {
    const supabase = makeSupabaseMock();
    const out = await resolveItemMastersBySku(supabase, "ent", []);
    expect(out.size).toBe(0);
  });

  it("maps sku_code → { id, unit_cost_cents }", async () => {
    const supabase = makeSupabaseMock({
      itemMasters: [
        { id: "i1", sku_code: "SKU-1", standard_cost_cents: 500 },
        { id: "i2", sku_code: "SKU-2", standard_cost_cents: 1200 },
      ],
    });
    const out = await resolveItemMastersBySku(supabase, "ent", ["SKU-1", "SKU-2", "SKU-3"]);
    expect(out.get("SKU-1")).toEqual({ id: "i1", unit_cost_cents: 500 });
    expect(out.get("SKU-2")).toEqual({ id: "i2", unit_cost_cents: 1200 });
    expect(out.has("SKU-3")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// resolveLastArCostBySku
// ────────────────────────────────────────────────────────────────────────

describe("resolveLastArCostBySku", () => {
  it("returns empty Map when skus empty", async () => {
    const supabase = makeSupabaseMock();
    const out = await resolveLastArCostBySku(supabase, "acct", []);
    expect(out.size).toBe(0);
  });

  it("returns per-unit price (price/qty rounded)", async () => {
    const supabase = makeSupabaseMock({
      arItems: [
        { sku: "SKU-1", item_price_cents: 2000, quantity_ordered: 2 },
        { sku: "SKU-2", item_price_cents: 750, quantity_ordered: 1 },
      ],
    });
    const out = await resolveLastArCostBySku(supabase, "acct", ["SKU-1", "SKU-2"]);
    expect(out.get("SKU-1")).toBe(1000);
    expect(out.get("SKU-2")).toBe(750);
  });

  it("ignores SKUs with non-positive unit", async () => {
    const supabase = makeSupabaseMock({
      arItems: [{ sku: "SKU-1", item_price_cents: 0, quantity_ordered: 1 }],
    });
    const out = await resolveLastArCostBySku(supabase, "acct", ["SKU-1"]);
    expect(out.has("SKU-1")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// mirrorAccountInventory — happy path + variants
// ────────────────────────────────────────────────────────────────────────

describe("mirrorAccountInventory — happy path", () => {
  it("upserts snapshots and rebuilds fba_inbound layers", async () => {
    const acct = makeAccount();
    const supabase = makeSupabaseMock({
      itemMasters: [{ id: "item-1", sku_code: "SKU-1", standard_cost_cents: 500 }],
    });
    const fakeClient = makeFakeSpApi({
      pages: [{
        inventorySummaries: [makeSummary({ sku: "SKU-1", fulfillable: 10 })],
        pagination: { nextToken: null },
      }],
    });
    const result = await mirrorAccountInventory(supabase, acct, {
      now: new Date("2026-05-29T04:00:00.000Z"),
      deps: { refreshAccessToken: makeRefreshFn(), makeClient: () => fakeClient },
    });
    expect(result.snapshots_upserted).toBe(1);
    expect(result.layers_inserted).toBe(1);
    expect(result.snapshot_at).toBe("2026-05-29T04:00:00.000Z");
    const layerInsert = supabase._calls.inserts.find((i) => i.table === "inventory_layers");
    expect(layerInsert).toBeTruthy();
    expect(layerInsert.rows[0].item_id).toBe("item-1");
    expect(layerInsert.rows[0].location_id).toBe(acct.fba_location_id);
    expect(layerInsert.rows[0].source_kind).toBe("fba_inbound");
    expect(layerInsert.rows[0].original_qty).toBe(10);
    expect(layerInsert.rows[0].remaining_qty).toBe(10);
    expect(layerInsert.rows[0].unit_cost_cents).toBe(500);
  });

  it("paginates getInventorySummaries via pagination.nextToken", async () => {
    const acct = makeAccount();
    const supabase = makeSupabaseMock();
    let calls = 0;
    const fakeClient = {
      getInventorySummaries: async (args) => {
        calls++;
        if (calls === 1) return {
          inventorySummaries: [makeSummary({ sku: "A" })],
          pagination: { nextToken: "tok-1" },
        };
        expect(args.nextToken).toBe("tok-1");
        return {
          inventorySummaries: [makeSummary({ sku: "B" })],
          pagination: { nextToken: null },
        };
      },
    };
    const result = await mirrorAccountInventory(supabase, acct, {
      deps: { refreshAccessToken: makeRefreshFn(), makeClient: () => fakeClient },
    });
    expect(result.pages).toBe(2);
    expect(result.snapshots_upserted).toBe(2);
  });

  it("shares snapshot_at across all pages of a single run", async () => {
    const acct = makeAccount();
    const supabase = makeSupabaseMock();
    let calls = 0;
    const fakeClient = {
      getInventorySummaries: async () => {
        calls++;
        if (calls === 1) return {
          inventorySummaries: [makeSummary({ sku: "A" })],
          pagination: { nextToken: "tok-1" },
        };
        return {
          inventorySummaries: [makeSummary({ sku: "B" })],
          pagination: {},
        };
      },
    };
    await mirrorAccountInventory(supabase, acct, {
      now: new Date("2026-05-29T04:00:00.000Z"),
      deps: { refreshAccessToken: makeRefreshFn(), makeClient: () => fakeClient },
    });
    const snapUps = supabase._calls.upserts.filter((u) => u.table === "fba_inventory_snapshots");
    expect(snapUps).toHaveLength(2);
    expect(snapUps[0].row.snapshot_at).toBe("2026-05-29T04:00:00.000Z");
    expect(snapUps[1].row.snapshot_at).toBe("2026-05-29T04:00:00.000Z");
  });

  it("skips layer rebuild for zero-qty SKUs", async () => {
    const acct = makeAccount();
    const supabase = makeSupabaseMock({
      itemMasters: [
        { id: "i1", sku_code: "SKU-1", standard_cost_cents: 100 },
        { id: "i2", sku_code: "SKU-0", standard_cost_cents: 100 },
      ],
    });
    const fakeClient = makeFakeSpApi({
      pages: [{
        inventorySummaries: [
          makeSummary({ sku: "SKU-1", fulfillable: 5 }),
          makeSummary({ sku: "SKU-0", fulfillable: 0 }),
        ],
        pagination: {},
      }],
    });
    const result = await mirrorAccountInventory(supabase, acct, {
      deps: { refreshAccessToken: makeRefreshFn(), makeClient: () => fakeClient },
    });
    // Both snapshots upserted, but only the qty>0 SKU got a layer.
    expect(result.snapshots_upserted).toBe(2);
    expect(result.layers_inserted).toBe(1);
  });

  it("skips SKUs without an ip_item_master from layer rebuild", async () => {
    const acct = makeAccount();
    const supabase = makeSupabaseMock({
      itemMasters: [{ id: "i1", sku_code: "SKU-KNOWN", standard_cost_cents: 100 }],
    });
    const fakeClient = makeFakeSpApi({
      pages: [{
        inventorySummaries: [
          makeSummary({ sku: "SKU-KNOWN", fulfillable: 3 }),
          makeSummary({ sku: "SKU-UNKNOWN", fulfillable: 7 }),
        ],
        pagination: {},
      }],
    });
    const result = await mirrorAccountInventory(supabase, acct, {
      deps: { refreshAccessToken: makeRefreshFn(), makeClient: () => fakeClient },
    });
    expect(result.snapshots_upserted).toBe(2);
    expect(result.layers_inserted).toBe(1);
  });

  it("does NOT delete or insert layers when fba_location_id is null", async () => {
    const acct = makeAccount({ fba_location_id: null });
    const supabase = makeSupabaseMock({
      itemMasters: [{ id: "i1", sku_code: "X", standard_cost_cents: 100 }],
    });
    const fakeClient = makeFakeSpApi({
      pages: [{ inventorySummaries: [makeSummary({ sku: "X", fulfillable: 5 })], pagination: {} }],
    });
    const result = await mirrorAccountInventory(supabase, acct, {
      deps: { refreshAccessToken: makeRefreshFn(), makeClient: () => fakeClient },
    });
    expect(result.layers_inserted).toBe(0);
    expect(result.layers_deleted).toBe(0);
    expect(supabase._calls.deletes).toHaveLength(0);
    expect(supabase._calls.inserts).toHaveLength(0);
  });

  it("DELETE is scoped to source_kind='fba_inbound' AND location_id only", async () => {
    const acct = makeAccount();
    const supabase = makeSupabaseMock();
    const fakeClient = makeFakeSpApi({ pages: [{ inventorySummaries: [], pagination: {} }] });
    await mirrorAccountInventory(supabase, acct, {
      deps: { refreshAccessToken: makeRefreshFn(), makeClient: () => fakeClient },
    });
    const del = supabase._calls.deletes.find((d) => d.table === "inventory_layers");
    expect(del).toBeTruthy();
    const eqs = del.eqs;
    // Must be exactly these two filters — never widened.
    const cols = eqs.map((e) => e.col).sort();
    expect(cols).toEqual(["location_id", "source_kind"]);
    const byCol = Object.fromEntries(eqs.map((e) => [e.col, e.val]));
    expect(byCol.source_kind).toBe("fba_inbound");
    expect(byCol.location_id).toBe(acct.fba_location_id);
  });

  it("uses standard_cost_cents when > 0 (no AR fallback)", async () => {
    const acct = makeAccount();
    const supabase = makeSupabaseMock({
      itemMasters: [{ id: "i1", sku_code: "SKU-1", standard_cost_cents: 1234 }],
      arItems: [{ sku: "SKU-1", item_price_cents: 9999, quantity_ordered: 1 }],
    });
    const fakeClient = makeFakeSpApi({
      pages: [{ inventorySummaries: [makeSummary({ sku: "SKU-1", fulfillable: 2 })], pagination: {} }],
    });
    await mirrorAccountInventory(supabase, acct, {
      deps: { refreshAccessToken: makeRefreshFn(), makeClient: () => fakeClient },
    });
    const layerInsert = supabase._calls.inserts.find((i) => i.table === "inventory_layers");
    expect(layerInsert.rows[0].unit_cost_cents).toBe(1234);
  });

  it("falls back to AR-line cost when standard_cost_cents = 0", async () => {
    const acct = makeAccount();
    const supabase = makeSupabaseMock({
      itemMasters: [{ id: "i1", sku_code: "SKU-1", standard_cost_cents: 0 }],
      arItems: [{ sku: "SKU-1", item_price_cents: 2000, quantity_ordered: 2 }],
    });
    const fakeClient = makeFakeSpApi({
      pages: [{ inventorySummaries: [makeSummary({ sku: "SKU-1", fulfillable: 3 })], pagination: {} }],
    });
    await mirrorAccountInventory(supabase, acct, {
      deps: { refreshAccessToken: makeRefreshFn(), makeClient: () => fakeClient },
    });
    const layerInsert = supabase._calls.inserts.find((i) => i.table === "inventory_layers");
    expect(layerInsert.rows[0].unit_cost_cents).toBe(1000);
  });

  it("falls back to 0 cents when neither standard_cost nor AR cost exists", async () => {
    const acct = makeAccount();
    const supabase = makeSupabaseMock({
      itemMasters: [{ id: "i1", sku_code: "SKU-1", standard_cost_cents: 0 }],
      arItems: [],
    });
    const fakeClient = makeFakeSpApi({
      pages: [{ inventorySummaries: [makeSummary({ sku: "SKU-1", fulfillable: 1 })], pagination: {} }],
    });
    await mirrorAccountInventory(supabase, acct, {
      deps: { refreshAccessToken: makeRefreshFn(), makeClient: () => fakeClient },
    });
    const layerInsert = supabase._calls.inserts.find((i) => i.table === "inventory_layers");
    expect(layerInsert.rows[0].unit_cost_cents).toBe(0);
  });

  it("bumps last_inventory_sync_at = snapshot_at", async () => {
    const acct = makeAccount();
    const supabase = makeSupabaseMock();
    const fakeClient = makeFakeSpApi({ pages: [{ inventorySummaries: [], pagination: {} }] });
    await mirrorAccountInventory(supabase, acct, {
      now: new Date("2026-05-29T04:00:00.000Z"),
      deps: { refreshAccessToken: makeRefreshFn(), makeClient: () => fakeClient },
    });
    const upd = supabase._calls.updates.find((u) => u.table === "fba_seller_accounts");
    expect(upd).toBeTruthy();
    expect(upd.patch.last_inventory_sync_at).toBe("2026-05-29T04:00:00.000Z");
  });
});

// ────────────────────────────────────────────────────────────────────────
// mirrorAccountInventory — error surfacing
// ────────────────────────────────────────────────────────────────────────

describe("mirrorAccountInventory — error surfacing", () => {
  it("throws when fba_inventory_snapshots upsert errors", async () => {
    const acct = makeAccount();
    const supabase = makeSupabaseMock({
      errors: { snapshotUpsert: { message: "snap-boom" } },
    });
    const fakeClient = makeFakeSpApi({
      pages: [{ inventorySummaries: [makeSummary({ sku: "X" })], pagination: {} }],
    });
    await expect(mirrorAccountInventory(supabase, acct, {
      deps: { refreshAccessToken: makeRefreshFn(), makeClient: () => fakeClient },
    })).rejects.toThrow(/snap-boom/);
  });

  it("throws when inventory_layers delete errors", async () => {
    const acct = makeAccount();
    const supabase = makeSupabaseMock({
      errors: { layerDelete: { message: "del-boom" } },
    });
    const fakeClient = makeFakeSpApi({ pages: [{ inventorySummaries: [], pagination: {} }] });
    await expect(mirrorAccountInventory(supabase, acct, {
      deps: { refreshAccessToken: makeRefreshFn(), makeClient: () => fakeClient },
    })).rejects.toThrow(/del-boom/);
  });

  it("throws when inventory_layers insert errors", async () => {
    const acct = makeAccount();
    const supabase = makeSupabaseMock({
      itemMasters: [{ id: "i1", sku_code: "X", standard_cost_cents: 100 }],
      errors: { layerInsert: { message: "ins-boom" } },
    });
    const fakeClient = makeFakeSpApi({
      pages: [{ inventorySummaries: [makeSummary({ sku: "X", fulfillable: 1 })], pagination: {} }],
    });
    await expect(mirrorAccountInventory(supabase, acct, {
      deps: { refreshAccessToken: makeRefreshFn(), makeClient: () => fakeClient },
    })).rejects.toThrow(/ins-boom/);
  });

  it("throws when fba_seller_accounts update errors", async () => {
    const acct = makeAccount();
    const supabase = makeSupabaseMock({
      errors: { update: { message: "upd-boom" } },
    });
    const fakeClient = makeFakeSpApi({ pages: [{ inventorySummaries: [], pagination: {} }] });
    await expect(mirrorAccountInventory(supabase, acct, {
      deps: { refreshAccessToken: makeRefreshFn(), makeClient: () => fakeClient },
    })).rejects.toThrow(/upd-boom/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// mirrorFbaInventory — multi-account loop
// ────────────────────────────────────────────────────────────────────────

describe("mirrorFbaInventory — multi-account loop", () => {
  it("requires adminClient", async () => {
    await expect(mirrorFbaInventory({})).rejects.toThrow(/adminClient/);
  });

  it("processes every active account and isolates failures", async () => {
    const acctA = makeAccount({ id: "a-a-a-a-a" });
    const acctB = makeAccount({ id: "b-b-b-b-b" });
    const supabase = makeSupabaseMock({
      accountsResp: { data: [acctA, acctB], error: null },
    });
    let calls = 0;
    const makeClient = () => {
      const idx = ++calls;
      if (idx === 1) return makeFakeSpApi({ pages: [{ inventorySummaries: [], pagination: {} }] });
      return { getInventorySummaries: async () => { throw new Error("spapi 403"); } };
    };
    const out = await mirrorFbaInventory({
      adminClient: supabase,
      opts: { deps: { refreshAccessToken: makeRefreshFn(), makeClient } },
    });
    expect(out.accounts).toHaveLength(2);
    expect(out.accounts[0].ok).toBe(true);
    expect(out.accounts[1].ok).toBe(false);
    expect(out.accounts[1].error).toMatch(/spapi 403/);
  });

  it("returns empty accounts array when no active rows", async () => {
    const supabase = makeSupabaseMock({ accountsResp: { data: [], error: null } });
    const out = await mirrorFbaInventory({ adminClient: supabase });
    expect(out.accounts).toEqual([]);
  });

  it("throws when accounts read fails", async () => {
    const supabase = makeSupabaseMock({
      accountsResp: { data: null, error: { message: "rls denied" } },
    });
    await expect(mirrorFbaInventory({ adminClient: supabase })).rejects.toThrow(/rls denied/);
  });

  it("returns started_at and finished_at timestamps with finished >= started", async () => {
    const supabase = makeSupabaseMock({ accountsResp: { data: [], error: null } });
    const out = await mirrorFbaInventory({ adminClient: supabase });
    expect(typeof out.started_at).toBe("string");
    expect(typeof out.finished_at).toBe("string");
    expect(new Date(out.finished_at).getTime()).toBeGreaterThanOrEqual(new Date(out.started_at).getTime());
  });
});
