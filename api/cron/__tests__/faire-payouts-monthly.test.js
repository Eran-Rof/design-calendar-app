// Tests for the Faire payouts ingest cron (P12c-2).
//
// Faire remits monthly; this cron pulls payouts for the trailing 60d
// per-shop and upserts into faire_payouts. P6 bank-recon does the actual
// match against bank_transactions later.

import { describe, it, expect } from "vitest";
import { runFairePayoutsIngest, computePaidAtMin, toCents } from "../faire-payouts-monthly.js";

function makeStore(initial = {}) {
  const tables = {
    faire_shops: [...(initial.faire_shops || [])],
    faire_payouts: [...(initial.faire_payouts || [])],
  };
  function makeBuilder(name) {
    const rows = tables[name];
    const filters = [];
    return {
      _rows: rows,
      _filters: filters,
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
      upsert(row, opts) {
        const keys = ((opts && opts.onConflict) || "").split(",").map((s) => s.trim()).filter(Boolean);
        let existing = null;
        if (keys.length > 0) {
          existing = this._rows.find((r) => keys.every((k) => r[k] === row[k]));
        }
        if (existing) {
          Object.assign(existing, row);
        } else {
          const id = row.id || `row-${name}-${this._rows.length + 1}`;
          this._rows.push({ id, ...row });
        }
        return this;
      },
      update(row) {
        const matched = this._rows.filter((r) => this._filters.every((f) => f(r)));
        for (const m of matched) Object.assign(m, row);
        return this;
      },
      then(resolve) {
        const matched = this._rows.filter((r) => this._filters.every((f) => f(r)));
        return resolve({ data: matched, error: null });
      },
    };
  }
  return { tables, from(name) { return makeBuilder(name); } };
}

function clientWith(pages) {
  let i = 0;
  const calls = [];
  return {
    calls,
    factory: () => ({
      async listPayouts(args) {
        calls.push({ args });
        const p = pages[i++] || { data: [], hasNextPage: false, page: args.page };
        return p;
      },
    }),
  };
}

const FAKE_KEY = "decrypted-key";

describe("computePaidAtMin", () => {
  it("uses sinceOverride when provided", () => {
    const v = computePaidAtMin("2026-05-01T00:00:00Z", "2026-04-15T00:00:00Z", Date.now());
    expect(v).toBe("2026-04-15T00:00:00Z");
  });
  it("falls back to now-60d when last_sync is null", () => {
    const now = new Date("2026-05-28T00:00:00Z").getTime();
    const v = computePaidAtMin(null, null, now);
    expect(new Date(v).getTime()).toBe(now - 60 * 24 * 60 * 60 * 1000);
  });
});

describe("toCents (payouts)", () => {
  it("treats floats as dollars and whole numbers as cents", () => {
    expect(toCents(123.45)).toBe(12345);
    expect(toCents(12345)).toBe(12345);
  });
});

describe("runFairePayoutsIngest", () => {
  it("returns zero summary when no shops", async () => {
    const sb = makeStore({ faire_shops: [] });
    const out = await runFairePayoutsIngest(sb, {
      deps: {
        decryptToken: () => FAKE_KEY,
        makeClient: clientWith([]).factory,
        now: () => new Date("2026-05-28T00:00:00Z").getTime(),
      },
    });
    expect(out.shops_scanned).toBe(0);
    expect(out.payouts_upserted_total).toBe(0);
  });

  it("upserts payouts and computes net from gross-commission-refunds when not provided", async () => {
    const sb = makeStore({
      faire_shops: [{
        id: "shop-1", entity_id: "ent-1",
        api_key_ciphertext: Buffer.from("c"),
        api_key_iv: Buffer.from("i"),
        api_key_tag: Buffer.from("t"),
        is_active: true,
      }],
    });
    const stub = clientWith([
      {
        data: [{
          id: "po_1",
          paid_at: "2026-05-15T12:00:00Z",
          period_start: "2026-04-01",
          period_end: "2026-04-30",
          gross_amount: 1500.50,
          commission_amount: 300.25,
          refunds_amount: 50.10,
          currency: "USD",
          // no net — should be computed
        }],
        hasNextPage: false,
        page: 1,
      },
    ]);
    await runFairePayoutsIngest(sb, {
      deps: {
        decryptToken: () => FAKE_KEY,
        makeClient: stub.factory,
        now: () => new Date("2026-05-28T00:00:00Z").getTime(),
      },
    });
    const p = sb.tables.faire_payouts[0];
    expect(p.faire_payout_id).toBe("po_1");
    expect(p.gross_amount_cents).toBe(150050);
    expect(p.commission_amount_cents).toBe(30025);
    expect(p.refunds_amount_cents).toBe(5010);
    expect(p.net_amount_cents).toBe(150050 - 30025 - 5010);
    expect(p.payout_date).toBe("2026-05-15");
  });

  it("walks pages until hasNextPage=false and updates last_payouts_sync_at", async () => {
    const sb = makeStore({
      faire_shops: [{
        id: "shop-1", entity_id: "ent-1",
        api_key_ciphertext: Buffer.from("c"),
        api_key_iv: Buffer.from("i"),
        api_key_tag: Buffer.from("t"),
        is_active: true,
        last_payouts_sync_at: null,
      }],
    });
    const stub = clientWith([
      { data: [{ id: "p1", paid_at: "2026-04-15T00:00:00Z", period_start: "2026-04-01", period_end: "2026-04-30", gross_amount: 100, commission_amount: 15, refunds_amount: 0 }], hasNextPage: true, page: 1 },
      { data: [{ id: "p2", paid_at: "2026-05-15T00:00:00Z", period_start: "2026-05-01", period_end: "2026-05-31", gross_amount: 200, commission_amount: 30, refunds_amount: 0 }], hasNextPage: false, page: 2 },
    ]);
    const nowMs = new Date("2026-05-28T05:00:00Z").getTime();
    const out = await runFairePayoutsIngest(sb, {
      deps: {
        decryptToken: () => FAKE_KEY,
        makeClient: stub.factory,
        now: () => nowMs,
      },
    });
    expect(stub.calls.length).toBe(2);
    expect(out.payouts_upserted_total).toBe(2);
    expect(sb.tables.faire_shops[0].last_payouts_sync_at).toBe(new Date(nowMs).toISOString());
  });

  it("isolates a failing shop's error", async () => {
    const sb = makeStore({
      faire_shops: [
        { id: "shop-bad", entity_id: "ent-1", api_key_ciphertext: Buffer.from("c"), api_key_iv: Buffer.from("i"), api_key_tag: Buffer.from("t"), is_active: true },
        { id: "shop-good", entity_id: "ent-1", api_key_ciphertext: Buffer.from("c"), api_key_iv: Buffer.from("i"), api_key_tag: Buffer.from("t"), is_active: true },
      ],
    });
    let cnt = 0;
    const makeClient = () => ({
      async listPayouts() {
        cnt += 1;
        if (cnt === 1) throw new Error("bad shop");
        return { data: [], hasNextPage: false, page: 1 };
      },
    });
    const out = await runFairePayoutsIngest(sb, {
      deps: {
        decryptToken: () => FAKE_KEY,
        makeClient,
        now: () => new Date("2026-05-28T00:00:00Z").getTime(),
      },
    });
    expect(out.shops_scanned).toBe(2);
    expect(out.errors.length).toBe(1);
    expect(out.errors[0]).toMatch(/bad shop/);
  });

  it("scopes to onlyShopId when provided", async () => {
    const sb = makeStore({
      faire_shops: [
        { id: "shop-A", entity_id: "ent-1", api_key_ciphertext: Buffer.from("c"), api_key_iv: Buffer.from("i"), api_key_tag: Buffer.from("t"), is_active: true },
        { id: "shop-B", entity_id: "ent-1", api_key_ciphertext: Buffer.from("c"), api_key_iv: Buffer.from("i"), api_key_tag: Buffer.from("t"), is_active: true },
      ],
    });
    const stub = clientWith([{ data: [], hasNextPage: false, page: 1 }]);
    const out = await runFairePayoutsIngest(sb, {
      onlyShopId: "shop-A",
      deps: {
        decryptToken: () => FAKE_KEY,
        makeClient: stub.factory,
        now: () => new Date("2026-05-28T00:00:00Z").getTime(),
      },
    });
    expect(out.shops_scanned).toBe(1);
    expect(out.per_shop[0].faire_shop_id).toBe("shop-A");
  });
});
