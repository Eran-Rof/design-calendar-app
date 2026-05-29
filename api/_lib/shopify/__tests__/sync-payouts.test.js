// Tangerine P11-9 — tests for the Shopify Payments payout reconciliation
// service.
//
// Coverage:
//   - BigInt cents helpers (toBigInt / centsToDecimal / toCents)
//   - computeSince: defaults to now-30d, sinceOverride wins
//   - buildPayoutRow: gross/fees/net math, summary fallback, payout_date
//   - buildPayoutJePayload: 2-line shape (DR Bank, CR Clearing), 4-line
//     shape with fees, balance check, missing-account guards
//   - resolvePayoutAccounts: code map by entity
//   - syncShopifyPayouts end-to-end:
//       * zero-store summary
//       * happy-path single store: upsert + JE post + cursor update
//       * multi-store isolation (one bad store, the other still runs)
//       * page_info walk through multiple pages
//       * idempotent je_id skip on second run
//       * $0 payout skip
//       * onlyShopifyStoreId scopes to one store
//       * sinceOverride passed through to listPayouts

import { describe, it, expect } from "vitest";
import {
  syncShopifyPayouts,
  buildPayoutJePayload,
  buildPayoutRow,
  resolvePayoutAccounts,
  computeSince,
  toBigInt,
  centsToDecimal,
  toCents,
  DEFAULT_LOOKBACK_DAYS,
} from "../sync-payouts.js";

const ENTITY    = "11111111-1111-1111-1111-111111111111";
const STORE     = "22222222-2222-2222-2222-222222222222";
const STORE2    = "33333333-3333-3333-3333-333333333333";
const PAYOUT_ID = "44444444-4444-4444-4444-444444444444";
const BANK      = "55555555-5555-5555-5555-555555555555";
const CLEARING  = "66666666-6666-6666-6666-666666666666";
const FEE       = "77777777-7777-7777-7777-777777777777";
const JE_ID     = "88888888-8888-8888-8888-888888888888";

function makePayoutRow(overrides = {}) {
  return {
    id: PAYOUT_ID,
    entity_id: ENTITY,
    shopify_store_id: STORE,
    shopify_payout_id: "po_1001",
    payout_date: "2026-05-27",
    gross_amount_cents: 10000,
    fees_amount_cents: 0,
    net_amount_cents: 10000,
    currency: "USD",
    je_id: null,
    ...overrides,
  };
}

function makeAccounts(overrides = {}) {
  return { bankId: BANK, clearingId: CLEARING, feeId: FEE, ...overrides };
}

/**
 * Lightweight in-memory Supabase mock. Supports the subset of the
 * supabase-js builder API used by sync-payouts:
 *   .from(name).select().eq().not().in()
 *   .from(name).upsert(row, {onConflict}).select().single()
 *   .from(name).update(patch).eq(col, val)
 *   .rpc("gl_post_journal_entry", {payload}) — returns whatever the
 *     constructor was given via rpcResult/rpcError.
 */
function makeStore(initial = {}, opts = {}) {
  const tables = {
    shopify_stores:    [...(initial.shopify_stores || [])],
    shopify_payouts:   [...(initial.shopify_payouts || [])],
    gl_accounts:       [...(initial.gl_accounts || [])],
  };
  const calls = { rpc: [], updates: [], upserts: [] };

  function builder(name) {
    const rows = tables[name];
    if (!rows) throw new Error(`unknown table: ${name}`);
    const filters = [];
    let inFilter = null;
    return {
      select() { return this; },
      eq(col, val) { filters.push((r) => r[col] === val); return this; },
      not(col, op, val) {
        if (op === "is" && val === null) filters.push((r) => r[col] != null);
        return this;
      },
      in(col, vals) {
        inFilter = { col, vals };
        return Promise.resolve({
          data: rows.filter((r) => filters.every((f) => f(r)) && vals.includes(r[col])),
          error: null,
        });
      },
      maybeSingle() {
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: matched[0] || null, error: null });
      },
      single() {
        // If an upsert just happened on this chain, the pending row wins.
        if (this._pendingUpsert) {
          const p = this._pendingUpsert;
          this._pendingUpsert = null;
          return Promise.resolve({ data: p, error: null });
        }
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({
          data: matched[0] || null,
          error: matched.length === 0 ? { message: "no rows" } : null,
        });
      },
      upsert(row, upOpts) {
        calls.upserts.push({ name, row, opts: upOpts });
        const keys = ((upOpts && upOpts.onConflict) || "").split(",").map((s) => s.trim()).filter(Boolean);
        let existing = null;
        if (keys.length > 0) {
          existing = rows.find((r) => keys.every((k) => r[k] === row[k]));
        }
        if (existing) {
          Object.assign(existing, row);
          this._pendingUpsert = existing;
        } else {
          const id = row.id || `row-${name}-${rows.length + 1}`;
          const inserted = { id, ...row };
          rows.push(inserted);
          this._pendingUpsert = inserted;
        }
        return this;
      },
      update(patch) {
        calls.updates.push({ name, patch });
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        for (const m of matched) Object.assign(m, patch);
        return {
          eq(col, val) {
            const m2 = rows.filter((r) => filters.every((f) => f(r)) && r[col] === val);
            for (const m of m2) Object.assign(m, patch);
            return Promise.resolve({ error: null });
          },
        };
      },
      then(resolve) {
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        return resolve({ data: matched, error: null });
      },
    };
  }

  const rpcResult = opts.rpcResult !== undefined ? opts.rpcResult : JE_ID;
  const rpcError = opts.rpcError || null;

  return {
    tables,
    calls,
    from(name) { return builder(name); },
    async rpc(name, args) {
      calls.rpc.push({ name, args });
      return { data: rpcResult, error: rpcError };
    },
  };
}

function makeShopifyClient(pages) {
  let i = 0;
  const calls = [];
  return {
    calls,
    listPayouts(args) {
      calls.push(args);
      const p = pages[i++] || { data: [], nextPageInfo: null };
      return Promise.resolve(p);
    },
  };
}

const FAKE_TOKEN = "shpat_decrypted_token";
function fakeDecrypt() { return FAKE_TOKEN; }

const DEFAULT_STORE = {
  id: STORE,
  entity_id: ENTITY,
  shopify_domain: "rof.myshopify.com",
  store_name: "ROF DTC",
  api_version: "2025-01",
  access_token_ciphertext: Buffer.from("c"),
  access_token_iv: Buffer.from("i"),
  access_token_tag: Buffer.from("t"),
  is_active: true,
};

const DEFAULT_GL_ROWS = [
  { entity_id: ENTITY, code: "1100", id: BANK },
  { entity_id: ENTITY, code: "1110", id: CLEARING },
  { entity_id: ENTITY, code: "6510", id: FEE },
];

// ──────────────────────────────────────────────────────────────────────
// Helpers — pure
// ──────────────────────────────────────────────────────────────────────

describe("toBigInt", () => {
  it("returns 0n for null/empty/undefined", () => {
    expect(toBigInt(null)).toBe(0n);
    expect(toBigInt(undefined)).toBe(0n);
    expect(toBigInt("")).toBe(0n);
  });
  it("converts integer number", () => {
    expect(toBigInt(12345)).toBe(12345n);
  });
  it("throws on float", () => {
    expect(() => toBigInt(1.5)).toThrow(/integer/);
  });
  it("converts integer string", () => {
    expect(toBigInt("12345")).toBe(12345n);
  });
});

describe("centsToDecimal", () => {
  it("formats whole dollars", () => {
    expect(centsToDecimal(10000n)).toBe("100.00");
  });
  it("pads single digit cents", () => {
    expect(centsToDecimal(10005n)).toBe("100.05");
  });
  it("handles negative", () => {
    expect(centsToDecimal(-10050n)).toBe("-100.50");
  });
});

describe("toCents", () => {
  it("treats whole numbers as cents, floats as dollars", () => {
    expect(toCents(12345)).toBe(12345);
    expect(toCents(123.45)).toBe(12345);
  });
  it("returns 0 for null / NaN", () => {
    expect(toCents(null)).toBe(0);
    expect(toCents("garbage")).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// computeSince
// ──────────────────────────────────────────────────────────────────────

describe("computeSince", () => {
  it("returns sinceOverride verbatim when present", () => {
    expect(computeSince(30, "2026-04-01T00:00:00Z", Date.now())).toBe("2026-04-01T00:00:00Z");
  });
  it("falls back to now - sinceDaysAgo days", () => {
    const now = new Date("2026-05-28T00:00:00Z").getTime();
    expect(computeSince(30, null, now)).toBe(new Date(now - 30 * 86400000).toISOString());
  });
  it("uses DEFAULT_LOOKBACK_DAYS when sinceDaysAgo is invalid", () => {
    const now = new Date("2026-05-28T00:00:00Z").getTime();
    expect(computeSince(0, null, now)).toBe(new Date(now - DEFAULT_LOOKBACK_DAYS * 86400000).toISOString());
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildPayoutRow
// ──────────────────────────────────────────────────────────────────────

describe("buildPayoutRow", () => {
  it("reads top-level gross/fees/net when present", () => {
    const row = buildPayoutRow({
      store: DEFAULT_STORE,
      payout: { id: "po_1", date: "2026-05-27", amount: 100.50, fees: 2.95, net: 97.55 },
    });
    expect(row.gross_amount_cents).toBe(10050);
    expect(row.fees_amount_cents).toBe(295);
    expect(row.net_amount_cents).toBe(9755);
    expect(row.payout_date).toBe("2026-05-27");
    expect(row.shopify_payout_id).toBe("po_1");
    expect(row.shopify_store_id).toBe(STORE);
    expect(row.entity_id).toBe(ENTITY);
  });
  it("computes net from gross - fees when net is not provided", () => {
    const row = buildPayoutRow({
      store: DEFAULT_STORE,
      payout: { id: "po_2", date: "2026-05-27", amount: 100, fees: 3 },
    });
    expect(row.net_amount_cents).toBe(100 - 3);
  });
  it("falls back to summary.charges_fee_amount + net_amount", () => {
    const row = buildPayoutRow({
      store: DEFAULT_STORE,
      payout: {
        id: "po_3",
        date: "2026-05-27",
        amount: 1000.00,
        summary: { charges_fee_amount: 29.50, net_amount: 970.50 },
      },
    });
    expect(row.fees_amount_cents).toBe(2950);
    expect(row.net_amount_cents).toBe(97050);
  });
  it("uses 'date' field for payout_date and stashes raw payload", () => {
    const raw = { id: "po_x", date: "2026-05-15T08:00:00Z", amount: 50 };
    const row = buildPayoutRow({ store: DEFAULT_STORE, payout: raw });
    expect(row.payout_date).toBe("2026-05-15");
    expect(row.raw_payload).toBe(raw);
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildPayoutJePayload
// ──────────────────────────────────────────────────────────────────────

describe("buildPayoutJePayload", () => {
  it("emits a balanced 2-line JE (DR Bank, CR Clearing) when fees=0", () => {
    const payload = buildPayoutJePayload({
      payout: makePayoutRow({ net_amount_cents: 10000, fees_amount_cents: 0 }),
      accounts: makeAccounts(),
    });
    expect(payload.lines).toHaveLength(2);
    expect(payload.lines[0]).toMatchObject({
      account_id: BANK, debit: "100.00", credit: "0",
    });
    expect(payload.lines[1]).toMatchObject({
      account_id: CLEARING, debit: "0", credit: "100.00",
    });
    expect(payload.journal_type).toBe("bank_deposit");
    expect(payload.source_module).toBe("shopify");
    expect(payload.source_table).toBe("shopify_payouts");
    expect(payload.source_id).toBe(PAYOUT_ID);
    expect(payload.entity_id).toBe(ENTITY);
    expect(payload.posting_date).toBe("2026-05-27");
  });

  it("emits 4 lines when fees > 0 (adds DR Fee + CR Clearing)", () => {
    const payload = buildPayoutJePayload({
      payout: makePayoutRow({ net_amount_cents: 9705, fees_amount_cents: 295 }),
      accounts: makeAccounts(),
    });
    expect(payload.lines).toHaveLength(4);
    expect(payload.lines[2]).toMatchObject({ account_id: FEE, debit: "2.95" });
    expect(payload.lines[3]).toMatchObject({ account_id: CLEARING, credit: "2.95" });
  });

  it("throws when missing 1100 Bank account", () => {
    expect(() => buildPayoutJePayload({
      payout: makePayoutRow(),
      accounts: makeAccounts({ bankId: null }),
    })).toThrow(/Bank/);
  });

  it("throws when missing 1110 Clearing account", () => {
    expect(() => buildPayoutJePayload({
      payout: makePayoutRow(),
      accounts: makeAccounts({ clearingId: null }),
    })).toThrow(/Clearing/);
  });

  it("throws when fees>0 but 6510 not configured", () => {
    expect(() => buildPayoutJePayload({
      payout: makePayoutRow({ fees_amount_cents: 295, net_amount_cents: 9705 }),
      accounts: makeAccounts({ feeId: null }),
    })).toThrow(/6510|Merchant Fees/);
  });

  it("throws when both net and fees are zero", () => {
    expect(() => buildPayoutJePayload({
      payout: makePayoutRow({ net_amount_cents: 0, fees_amount_cents: 0 }),
      accounts: makeAccounts(),
    })).toThrow(/nothing to post/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// resolvePayoutAccounts
// ──────────────────────────────────────────────────────────────────────

describe("resolvePayoutAccounts", () => {
  it("returns the code → id map keyed for the entity", async () => {
    const sb = makeStore({ gl_accounts: DEFAULT_GL_ROWS });
    const accts = await resolvePayoutAccounts(sb, ENTITY);
    expect(accts.bankId).toBe(BANK);
    expect(accts.clearingId).toBe(CLEARING);
    expect(accts.feeId).toBe(FEE);
  });

  it("returns null for missing codes", async () => {
    const sb = makeStore({
      gl_accounts: [{ entity_id: ENTITY, code: "1100", id: BANK }],
    });
    const accts = await resolvePayoutAccounts(sb, ENTITY);
    expect(accts.bankId).toBe(BANK);
    expect(accts.clearingId).toBe(null);
    expect(accts.feeId).toBe(null);
  });
});

// ──────────────────────────────────────────────────────────────────────
// syncShopifyPayouts end-to-end
// ──────────────────────────────────────────────────────────────────────

describe("syncShopifyPayouts", () => {
  it("returns zero summary when no active stores", async () => {
    const sb = makeStore({ shopify_stores: [] });
    const out = await syncShopifyPayouts({
      adminClient: sb,
      deps: {
        decryptToken: fakeDecrypt,
        makeClient: () => makeShopifyClient([]),
        now: () => new Date("2026-05-28T00:00:00Z").getTime(),
      },
    });
    expect(out.stores_scanned).toBe(0);
    expect(out.payouts_upserted_total).toBe(0);
    expect(out.payouts_posted_total).toBe(0);
  });

  it("upserts payouts, posts JE for new rows, stamps je_id, updates cursor", async () => {
    const sb = makeStore({
      shopify_stores: [DEFAULT_STORE],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeShopifyClient([
      {
        data: [
          { id: "po_1001", date: "2026-05-27", amount: 100.00, summary: { charges_fee_amount: 2.95, net_amount: 97.05 } },
          { id: "po_1002", date: "2026-05-26", amount: 200.00, summary: { charges_fee_amount: 5.90, net_amount: 194.10 } },
        ],
        nextPageInfo: null,
      },
    ]);

    const now = new Date("2026-05-28T06:00:00Z").getTime();
    const out = await syncShopifyPayouts({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, makeClient: () => stub, now: () => now },
    });
    expect(out.stores_scanned).toBe(1);
    expect(out.payouts_upserted_total).toBe(2);
    expect(out.payouts_posted_total).toBe(2);
    expect(out.payouts_skipped_total).toBe(0);
    expect(out.errors).toEqual([]);

    // Two RPC calls, one per payout.
    expect(sb.calls.rpc.length).toBe(2);
    expect(sb.calls.rpc[0].name).toBe("gl_post_journal_entry");
    // shopify_payouts rows have je_id stamped.
    expect(sb.tables.shopify_payouts.length).toBe(2);
    for (const p of sb.tables.shopify_payouts) {
      expect(p.je_id).toBe(JE_ID);
    }
    // Cursor (updated_at) refreshed on the store.
    expect(sb.tables.shopify_stores[0].updated_at).toBe(new Date(now).toISOString());
  });

  it("skips JE post on subsequent run (idempotent je_id)", async () => {
    const sb = makeStore({
      shopify_stores: [DEFAULT_STORE],
      shopify_payouts: [{
        id: PAYOUT_ID,
        entity_id: ENTITY,
        shopify_store_id: STORE,
        shopify_payout_id: "po_1001",
        je_id: "preexisting-je-id",     // already posted
        payout_date: "2026-05-27",
        gross_amount_cents: 10000,
        fees_amount_cents: 295,
        net_amount_cents: 9705,
      }],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeShopifyClient([{
      data: [
        { id: "po_1001", date: "2026-05-27", amount: 100, summary: { charges_fee_amount: 2.95, net_amount: 97.05 } },
      ],
      nextPageInfo: null,
    }]);
    const out = await syncShopifyPayouts({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, makeClient: () => stub, now: () => Date.now() },
    });
    expect(out.payouts_upserted_total).toBe(1);
    expect(out.payouts_posted_total).toBe(0);
    expect(out.payouts_skipped_total).toBe(1);
    expect(sb.calls.rpc.length).toBe(0);   // no JE posted
  });

  it("skips $0 payouts without RPC", async () => {
    const sb = makeStore({
      shopify_stores: [DEFAULT_STORE],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeShopifyClient([{
      data: [{ id: "po_zero", date: "2026-05-27", amount: 0, fees: 0, net: 0 }],
      nextPageInfo: null,
    }]);
    const out = await syncShopifyPayouts({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, makeClient: () => stub, now: () => Date.now() },
    });
    expect(out.payouts_upserted_total).toBe(1);
    expect(out.payouts_posted_total).toBe(0);
    expect(out.payouts_skipped_total).toBe(1);
    expect(sb.calls.rpc.length).toBe(0);
  });

  it("walks page_info cursor until null", async () => {
    const sb = makeStore({
      shopify_stores: [DEFAULT_STORE],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeShopifyClient([
      { data: [{ id: "po_p1", date: "2026-05-27", amount: 100, fees: 3, net: 97 }], nextPageInfo: "PAGE2" },
      { data: [{ id: "po_p2", date: "2026-05-26", amount: 200, fees: 6, net: 194 }], nextPageInfo: null },
    ]);
    const out = await syncShopifyPayouts({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, makeClient: () => stub, now: () => Date.now() },
    });
    expect(stub.calls.length).toBe(2);
    // First call uses since, second uses page_info.
    expect(stub.calls[0].since).toBeDefined();
    expect(stub.calls[1].page_info).toBe("PAGE2");
    expect(out.payouts_upserted_total).toBe(2);
  });

  it("isolates a failing store's error (multi-store)", async () => {
    const sb = makeStore({
      shopify_stores: [
        { ...DEFAULT_STORE, id: STORE,  store_name: "BAD" },
        { ...DEFAULT_STORE, id: STORE2, store_name: "GOOD", entity_id: ENTITY },
      ],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    let count = 0;
    const makeClient = () => ({
      listPayouts() {
        count += 1;
        if (count === 1) throw new Error("bad creds");
        return Promise.resolve({ data: [], nextPageInfo: null });
      },
    });
    const out = await syncShopifyPayouts({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, makeClient, now: () => Date.now() },
    });
    expect(out.stores_scanned).toBe(2);
    expect(out.errors.length).toBe(1);
    expect(out.errors[0]).toMatch(/bad creds/);
    // Per-store entries reflect: one error, one clean.
    expect(out.per_store.find((s) => s.shopify_store_id === STORE).error).toMatch(/bad creds/);
    expect(out.per_store.find((s) => s.shopify_store_id === STORE2).error).toBe(null);
  });

  it("scopes to onlyShopifyStoreId when provided", async () => {
    const sb = makeStore({
      shopify_stores: [
        { ...DEFAULT_STORE, id: STORE,  store_name: "A" },
        { ...DEFAULT_STORE, id: STORE2, store_name: "B" },
      ],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeShopifyClient([{ data: [], nextPageInfo: null }]);
    const out = await syncShopifyPayouts({
      adminClient: sb,
      onlyShopifyStoreId: STORE2,
      deps: { decryptToken: fakeDecrypt, makeClient: () => stub, now: () => Date.now() },
    });
    expect(out.stores_scanned).toBe(1);
    expect(out.per_store[0].shopify_store_id).toBe(STORE2);
  });

  it("passes sinceOverride through to listPayouts", async () => {
    const sb = makeStore({
      shopify_stores: [DEFAULT_STORE],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeShopifyClient([{ data: [], nextPageInfo: null }]);
    await syncShopifyPayouts({
      adminClient: sb,
      sinceOverride: "2026-01-15T00:00:00Z",
      deps: { decryptToken: fakeDecrypt, makeClient: () => stub, now: () => Date.now() },
    });
    expect(stub.calls[0].since).toBe("2026-01-15T00:00:00Z");
  });

  it("does not abort the page walk on a single broken payout", async () => {
    // First payout will trigger RPC error path; second will succeed —
    // both should be upserted and the error captured per-payout.
    const sb = makeStore({
      shopify_stores: [DEFAULT_STORE],
      gl_accounts: DEFAULT_GL_ROWS,
    }, { rpcError: { message: "intentional test error" } });

    const stub = makeShopifyClient([{
      data: [
        { id: "po_a", date: "2026-05-27", amount: 100, fees: 3, net: 97 },
        { id: "po_b", date: "2026-05-26", amount: 200, fees: 6, net: 194 },
      ],
      nextPageInfo: null,
    }]);

    const out = await syncShopifyPayouts({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, makeClient: () => stub, now: () => Date.now() },
    });
    // Both rows upserted; both fail to post (RPC errors); zero posted.
    expect(out.payouts_upserted_total).toBe(2);
    expect(out.payouts_posted_total).toBe(0);
    expect(out.per_store[0].error).toMatch(/intentional test error/);
  });
});
