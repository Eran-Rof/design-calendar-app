// Unit tests for api/_lib/marketplaces/faire/sync-returns.js (P12c-4).
//
// Mocks the Supabase client + the FaireClient via the deps injection
// point on runFaireReturnsIngest.

import { describe, it, expect } from "vitest";
import {
  computeReturnsUpdatedAtMin,
  toCents,
  extractFaireReturnId,
  extractFaireOrderRef,
  normaliseStatus,
  sumRefundCents,
  centsToDecimal,
  buildRestockPairs,
  defaultPostCreditMemo,
  runFaireReturnsIngest,
} from "../sync-returns.js";

// ────────────────────────────────────────────────────────────────────────
// Pure helpers — sanity gates first.
// ────────────────────────────────────────────────────────────────────────

describe("computeReturnsUpdatedAtMin", () => {
  it("returns sinceOverride verbatim when supplied", () => {
    const got = computeReturnsUpdatedAtMin(null, "2026-04-01T00:00:00Z");
    expect(got).toBe("2026-04-01T00:00:00Z");
  });

  it("falls back to now - 30 days when last_sync is null", () => {
    const now = new Date("2026-05-15T00:00:00Z").getTime();
    const got = computeReturnsUpdatedAtMin(null, null, now);
    expect(got).toBe("2026-04-15T00:00:00.000Z");
  });

  it("uses lastSync when more recent than 30-day floor", () => {
    const now = new Date("2026-05-15T00:00:00Z").getTime();
    const got = computeReturnsUpdatedAtMin("2026-05-10T00:00:00Z", null, now);
    expect(got).toBe("2026-05-10T00:00:00.000Z");
  });

  it("clamps to 30-day floor when lastSync is older", () => {
    const now = new Date("2026-05-15T00:00:00Z").getTime();
    const got = computeReturnsUpdatedAtMin("2026-01-01T00:00:00Z", null, now);
    expect(got).toBe("2026-04-15T00:00:00.000Z");
  });

  it("treats unparseable lastSync as null", () => {
    const now = new Date("2026-05-15T00:00:00Z").getTime();
    const got = computeReturnsUpdatedAtMin("not-a-date", null, now);
    expect(got).toBe("2026-04-15T00:00:00.000Z");
  });
});

describe("toCents", () => {
  it("returns 0 for null/undefined", () => {
    expect(toCents(null)).toBe(0);
    expect(toCents(undefined)).toBe(0);
  });

  it("rounds float dollars to integer cents", () => {
    expect(toCents(12.34)).toBe(1234);
  });

  it("treats whole-number values as already-cents", () => {
    expect(toCents(1234)).toBe(1234);
  });

  it("returns 0 for non-finite values", () => {
    expect(toCents(NaN)).toBe(0);
    expect(toCents(Infinity)).toBe(0);
  });

  it("coerces a numeric string", () => {
    expect(toCents("9.99")).toBe(999);
  });
});

describe("extractFaireReturnId", () => {
  it("prefers id", () => {
    expect(extractFaireReturnId({ id: "abc" })).toBe("abc");
  });

  it("falls back to return_id", () => {
    expect(extractFaireReturnId({ return_id: "ret_1" })).toBe("ret_1");
  });

  it("falls back to faire_return_id", () => {
    expect(extractFaireReturnId({ faire_return_id: "ret_2" })).toBe("ret_2");
  });

  it("falls back to return_token", () => {
    expect(extractFaireReturnId({ return_token: "tok_3" })).toBe("tok_3");
  });

  it("returns null when no id field present", () => {
    expect(extractFaireReturnId({})).toBeNull();
    expect(extractFaireReturnId(null)).toBeNull();
  });
});

describe("extractFaireOrderRef", () => {
  it("picks order_id first", () => {
    expect(extractFaireOrderRef({ order_id: "o1" })).toBe("o1");
  });

  it("falls back to faire_order_id", () => {
    expect(extractFaireOrderRef({ faire_order_id: "o2" })).toBe("o2");
  });

  it("returns null when missing", () => {
    expect(extractFaireOrderRef({})).toBeNull();
  });
});

describe("normaliseStatus", () => {
  it("upper-cases lower-case values", () => {
    expect(normaliseStatus({ status: "refunded" })).toBe("REFUNDED");
  });

  it("prefers status > state > return_status", () => {
    expect(normaliseStatus({ status: "A", state: "B", return_status: "C" })).toBe("A");
    expect(normaliseStatus({ state: "B", return_status: "C" })).toBe("B");
    expect(normaliseStatus({ return_status: "C" })).toBe("C");
  });

  it("returns UNKNOWN when no status field present", () => {
    expect(normaliseStatus({})).toBe("UNKNOWN");
  });
});

describe("sumRefundCents", () => {
  it("uses refund_amount_cents when present", () => {
    expect(sumRefundCents({ refund_amount_cents: 1500 })).toBe(1500);
  });

  it("falls back to total_refund_cents", () => {
    expect(sumRefundCents({ total_refund_cents: 2500 })).toBe(2500);
  });

  it("converts float refund_amount dollars to cents", () => {
    expect(sumRefundCents({ refund_amount: 12.50 })).toBe(1250);
  });

  it("rolls up line items when no top-level total", () => {
    expect(sumRefundCents({
      items: [
        { refund_amount_cents: 1000 },
        { refund_amount_cents: 500 },
      ],
    })).toBe(1500);
  });

  it("falls back to line_total_cents on line items", () => {
    expect(sumRefundCents({
      return_items: [{ line_total_cents: 2200 }, { line_total_cents: 800 }],
    })).toBe(3000);
  });

  it("returns 0 when payload is empty", () => {
    expect(sumRefundCents({})).toBe(0);
    expect(sumRefundCents(null)).toBe(0);
  });
});

describe("centsToDecimal", () => {
  it("formats whole dollars with .00 fractional", () => {
    expect(centsToDecimal(100)).toBe("1.00");
  });

  it("pads single-digit fractional", () => {
    expect(centsToDecimal(105)).toBe("1.05");
  });

  it("handles 0", () => {
    expect(centsToDecimal(0)).toBe("0.00");
  });

  it("handles negative cents", () => {
    expect(centsToDecimal(-250)).toBe("-2.50");
  });

  it("handles large values", () => {
    expect(centsToDecimal(1234567)).toBe("12345.67");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Supabase mock helper.
// ────────────────────────────────────────────────────────────────────────

function makeSupabaseMock(handlers = {}) {
  const calls = [];
  function from(table) {
    const ctx = { table, filters: {}, op: null, payload: null, selectStr: null, conflict: null };
    const builder = {
      select(s) { ctx.selectStr = s; return builder; },
      eq(col, v) { ctx.filters[col] = v; return builder; },
      gt(col, v) { ctx.filters[`>${col}`] = v; return builder; },
      not(col, _op, _v) { ctx.filters[`not_${col}`] = true; return builder; },
      in(col, v) { ctx.filters[col] = ["in", v]; return builder; },
      order() { return builder; },
      limit() { return builder; },
      maybeSingle() {
        ctx.op = ctx.op || "select_one";
        return resolveCall();
      },
      single() {
        ctx.op = ctx.op || "select_one";
        return resolveCall();
      },
      upsert(payload, opts) {
        ctx.op = "upsert"; ctx.payload = payload; ctx.conflict = opts?.onConflict || null;
        return builder;
      },
      insert(payload) { ctx.op = "insert"; ctx.payload = payload; return builder; },
      update(patch) { ctx.op = "update"; ctx.payload = patch; return builder; },
      then(onResolve, onReject) {
        return resolveCall().then(onResolve, onReject);
      },
    };
    function resolveCall() {
      calls.push({ table, ...ctx });
      const fn = handlers[table];
      if (!fn) return Promise.resolve({ data: null, error: null });
      return Promise.resolve(fn(ctx));
    }
    return builder;
  }
  async function rpc(name, args) {
    calls.push({ table: `rpc:${name}`, op: "rpc", payload: args });
    const fn = handlers[`rpc:${name}`];
    if (!fn) return { data: null, error: null };
    return fn(args);
  }
  return { from, rpc, _calls: calls };
}

// ────────────────────────────────────────────────────────────────────────
// runFaireReturnsIngest orchestration.
// ────────────────────────────────────────────────────────────────────────

describe("runFaireReturnsIngest — orchestration", () => {
  it("returns empty summary when no shops match", async () => {
    const supabase = makeSupabaseMock({
      faire_shops: () => ({ data: [], error: null }),
    });
    const out = await runFaireReturnsIngest(supabase, {
      deps: { decryptToken: () => "k", now: () => 0, makeClient: () => null, postCreditMemo: async () => null },
    });
    expect(out.shops_scanned).toBe(0);
    expect(out.returns_upserted_total).toBe(0);
    expect(out.returns_posted_total).toBe(0);
    expect(out.errors).toEqual([]);
  });

  it("walks one shop + one page + upserts a return", async () => {
    const shop = {
      id: "shop-uuid-1", entity_id: "ent-1", shop_name: "Test",
      api_key_ciphertext: Buffer.from("a"), api_key_iv: Buffer.from("b"),
      api_key_tag: Buffer.from("c"), last_returns_sync_at: null,
    };
    const upserts = [];
    const supabase = makeSupabaseMock({
      faire_shops: (ctx) => {
        if (ctx.op === "update") return { data: null, error: null };
        return { data: [shop], error: null };
      },
      faire_orders: () => ({ data: { id: "order-row-1" }, error: null }),
      faire_returns: (ctx) => {
        if (ctx.op === "upsert") {
          upserts.push(ctx.payload);
          return { data: { id: "fr-row-1", je_id: null, ar_credit_memo_id: null, faire_order_id: "order-row-1" }, error: null };
        }
        return { data: null, error: null };
      },
    });
    const client = {
      listReturns: async () => ({
        data: [{ id: "ret-1", order_id: "ord-1", status: "REQUESTED", refund_amount_cents: 1000 }],
        hasNextPage: false,
        page: 1,
      }),
    };
    const out = await runFaireReturnsIngest(supabase, {
      deps: {
        decryptToken: () => "k",
        now: () => Date.parse("2026-05-15T00:00:00Z"),
        makeClient: () => client,
        postCreditMemo: async () => ({ status: "posted", je_id: "je-1" }),
      },
    });
    expect(out.shops_scanned).toBe(1);
    expect(out.returns_upserted_total).toBe(1);
    expect(out.returns_posted_total).toBe(0); // status was REQUESTED, not postable
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      faire_shop_id: "shop-uuid-1",
      faire_return_id: "ret-1",
      return_status: "REQUESTED",
      refund_amount_cents: 1000,
      source: "faire",
      faire_order_id: "order-row-1",
    });
  });

  it("posts a credit memo when status is REFUNDED + je_id NULL + refund > 0", async () => {
    const shop = {
      id: "shop-uuid-2", entity_id: "ent-2", shop_name: "Two",
      api_key_ciphertext: Buffer.from("a"), api_key_iv: Buffer.from("b"),
      api_key_tag: Buffer.from("c"), last_returns_sync_at: null,
    };
    let postCalls = 0;
    const supabase = makeSupabaseMock({
      faire_shops: (ctx) => {
        if (ctx.op === "update") return { data: null, error: null };
        return { data: [shop], error: null };
      },
      faire_orders: () => ({ data: { id: "order-row-2" }, error: null }),
      faire_returns: (ctx) => {
        if (ctx.op === "upsert") {
          return { data: { id: "fr-row-2", je_id: null, ar_credit_memo_id: null, faire_order_id: "order-row-2" }, error: null };
        }
        return { data: null, error: null };
      },
    });
    const client = {
      listReturns: async () => ({
        data: [{ id: "ret-2", order_id: "ord-2", status: "REFUNDED", refund_amount_cents: 5000 }],
        hasNextPage: false,
        page: 1,
      }),
    };
    const out = await runFaireReturnsIngest(supabase, {
      deps: {
        decryptToken: () => "k",
        now: () => Date.parse("2026-05-15T00:00:00Z"),
        makeClient: () => client,
        postCreditMemo: async () => { postCalls += 1; return { status: "posted", je_id: "je-2" }; },
      },
    });
    expect(postCalls).toBe(1);
    expect(out.returns_posted_total).toBe(1);
  });

  it("skips post when je_id already set (idempotent replay)", async () => {
    const shop = {
      id: "shop-uuid-3", entity_id: "ent-3", shop_name: "Three",
      api_key_ciphertext: Buffer.from("a"), api_key_iv: Buffer.from("b"),
      api_key_tag: Buffer.from("c"), last_returns_sync_at: null,
    };
    let postCalls = 0;
    const supabase = makeSupabaseMock({
      faire_shops: (ctx) => {
        if (ctx.op === "update") return { data: null, error: null };
        return { data: [shop], error: null };
      },
      faire_orders: () => ({ data: { id: "order-row-3" }, error: null }),
      faire_returns: (ctx) => {
        if (ctx.op === "upsert") {
          return { data: { id: "fr-row-3", je_id: "already-posted-je", ar_credit_memo_id: "cm-1", faire_order_id: "order-row-3" }, error: null };
        }
        return { data: null, error: null };
      },
    });
    const client = {
      listReturns: async () => ({
        data: [{ id: "ret-3", order_id: "ord-3", status: "REFUNDED", refund_amount_cents: 5000 }],
        hasNextPage: false, page: 1,
      }),
    };
    const out = await runFaireReturnsIngest(supabase, {
      deps: {
        decryptToken: () => "k",
        now: () => 0,
        makeClient: () => client,
        postCreditMemo: async () => { postCalls += 1; return { status: "posted", je_id: "x" }; },
      },
    });
    expect(postCalls).toBe(0);
    expect(out.returns_posted_total).toBe(0);
  });

  it("skips post when refund_amount_cents is 0", async () => {
    const shop = {
      id: "shop-uuid-4", entity_id: "ent-4", shop_name: "Four",
      api_key_ciphertext: Buffer.from("a"), api_key_iv: Buffer.from("b"),
      api_key_tag: Buffer.from("c"), last_returns_sync_at: null,
    };
    let postCalls = 0;
    const supabase = makeSupabaseMock({
      faire_shops: (ctx) => {
        if (ctx.op === "update") return { data: null, error: null };
        return { data: [shop], error: null };
      },
      faire_orders: () => ({ data: { id: "order-row-4" }, error: null }),
      faire_returns: () => ({ data: { id: "fr-row-4", je_id: null, ar_credit_memo_id: null, faire_order_id: "order-row-4" }, error: null }),
    });
    const client = {
      listReturns: async () => ({
        data: [{ id: "ret-4", order_id: "ord-4", status: "REFUNDED", refund_amount_cents: 0 }],
        hasNextPage: false, page: 1,
      }),
    };
    const out = await runFaireReturnsIngest(supabase, {
      deps: {
        decryptToken: () => "k", now: () => 0,
        makeClient: () => client,
        postCreditMemo: async () => { postCalls += 1; return null; },
      },
    });
    expect(postCalls).toBe(0);
  });

  it("captures per-shop error in summary without throwing", async () => {
    const shop = {
      id: "shop-uuid-bad", entity_id: "ent-bad", shop_name: "Bad",
      api_key_ciphertext: Buffer.from("a"), api_key_iv: Buffer.from("b"),
      api_key_tag: Buffer.from("c"), last_returns_sync_at: null,
    };
    const supabase = makeSupabaseMock({
      faire_shops: (ctx) => {
        if (ctx.op === "update") return { data: null, error: null };
        return { data: [shop], error: null };
      },
    });
    const client = {
      listReturns: async () => { throw new Error("boom"); },
    };
    const out = await runFaireReturnsIngest(supabase, {
      deps: {
        decryptToken: () => "k", now: () => 0,
        makeClient: () => client,
        postCreditMemo: async () => null,
      },
    });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatch(/boom/);
    expect(out.per_shop[0].error).toMatch(/boom/);
  });

  it("rejects malformed onlyShopId", async () => {
    const supabase = makeSupabaseMock({});
    await expect(
      runFaireReturnsIngest(supabase, { onlyShopId: "not-a-uuid" }),
    ).rejects.toThrow(/uuid/);
  });

  it("rolls up returns across multiple pages until hasNextPage=false", async () => {
    const shop = {
      id: "shop-uuid-p", entity_id: "ent-p", shop_name: "Paginated",
      api_key_ciphertext: Buffer.from("a"), api_key_iv: Buffer.from("b"),
      api_key_tag: Buffer.from("c"), last_returns_sync_at: null,
    };
    let upsertCount = 0;
    const supabase = makeSupabaseMock({
      faire_shops: (ctx) => {
        if (ctx.op === "update") return { data: null, error: null };
        return { data: [shop], error: null };
      },
      faire_orders: () => ({ data: { id: "order-x" }, error: null }),
      faire_returns: (ctx) => {
        if (ctx.op === "upsert") {
          upsertCount += 1;
          return { data: { id: `fr-${upsertCount}`, je_id: null, ar_credit_memo_id: null, faire_order_id: "order-x" }, error: null };
        }
        return { data: null, error: null };
      },
    });
    let pageCalls = 0;
    const client = {
      listReturns: async () => {
        pageCalls += 1;
        if (pageCalls === 1) {
          return {
            data: [{ id: "ret-A", order_id: "o", status: "REQUESTED", refund_amount_cents: 100 }],
            hasNextPage: true, page: 1,
          };
        }
        return {
          data: [{ id: "ret-B", order_id: "o", status: "REQUESTED", refund_amount_cents: 200 }],
          hasNextPage: false, page: 2,
        };
      },
    };
    const out = await runFaireReturnsIngest(supabase, {
      deps: { decryptToken: () => "k", now: () => 0, makeClient: () => client, postCreditMemo: async () => null },
    });
    expect(pageCalls).toBe(2);
    expect(out.returns_upserted_total).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────
// defaultPostCreditMemo — happy path + edge cases.
// ────────────────────────────────────────────────────────────────────────

describe("defaultPostCreditMemo", () => {
  function makeStandardSupabase(overrides = {}) {
    return makeSupabaseMock({
      faire_returns: (ctx) => {
        if (ctx.op === "select_one") {
          return overrides.faireReturnRead || {
            data: {
              id: "fr-row", entity_id: "ent-x", faire_shop_id: "shop-x",
              faire_return_id: "ret-99", refund_amount_cents: 4500,
              je_id: null, ar_credit_memo_id: null,
              raw_payload: { items: [] },
            },
            error: null,
          };
        }
        if (ctx.op === "update") return { data: null, error: null };
        return { data: null, error: null };
      },
      faire_orders: () => overrides.faireOrderRead || ({
        data: {
          id: "order-row", entity_id: "ent-x", faire_order_id: "ord-99",
          customer_id: "cust-1", ar_invoice_id: "inv-1",
          placed_at: "2026-05-01T00:00:00Z",
        },
        error: null,
      }),
      gl_accounts: () => overrides.glAccounts || ({
        data: [
          { id: "gl-1115", code: "1115" },
          { id: "gl-4000", code: "4000" },
          { id: "gl-1300", code: "1300" },
          { id: "gl-5000", code: "5000" },
        ],
        error: null,
      }),
      "rpc:gl_post_journal_entry": () => ({ data: "je-new-1", error: null }),
      ar_invoices: () => ({ data: { id: "cm-new-1" }, error: null }),
      ...(overrides.extraHandlers || {}),
    });
  }

  it("returns already_posted when je_id is set", async () => {
    const supabase = makeSupabaseMock({
      faire_returns: () => ({ data: { id: "x", je_id: "prev-je" }, error: null }),
    });
    const out = await defaultPostCreditMemo({
      supabase, faireReturnsRow: { id: "x" }, faireOrderRowId: "ord",
    });
    expect(out).toEqual({ status: "already_posted", je_id: "prev-je" });
  });

  it("posts the JE + inserts the credit memo + stamps the row (happy path)", async () => {
    const supabase = makeStandardSupabase();
    const out = await defaultPostCreditMemo({
      supabase, faireReturnsRow: { id: "fr-row" }, faireOrderRowId: "order-row",
    });
    expect(out.status).toBe("posted");
    expect(out.je_id).toBe("je-new-1");
    expect(out.ar_credit_memo_id).toBe("cm-new-1");
    const rpcCall = supabase._calls.find((c) => c.table === "rpc:gl_post_journal_entry");
    expect(rpcCall).toBeDefined();
    expect(rpcCall.payload.payload.journal_type).toBe("ar_credit_memo");
    expect(rpcCall.payload.payload.source_module).toBe("faire");
    expect(rpcCall.payload.payload.source_table).toBe("faire_returns");
    // Lines: CR 1115 (4500) + DR 4000 (4500) — balanced.
    const lines = rpcCall.payload.payload.lines;
    const crSum = lines.reduce((s, l) => s + parseFloat(l.credit || "0"), 0);
    const drSum = lines.reduce((s, l) => s + parseFloat(l.debit || "0"), 0);
    expect(Math.round(drSum * 100)).toBe(Math.round(crSum * 100));
  });

  it("uses ar_credit_memo journal_type + customer_credit_memo invoice_kind", async () => {
    const supabase = makeStandardSupabase();
    await defaultPostCreditMemo({
      supabase, faireReturnsRow: { id: "fr-row" }, faireOrderRowId: "order-row",
    });
    const arInsert = supabase._calls.find((c) => c.table === "ar_invoices" && c.op === "insert");
    expect(arInsert).toBeDefined();
    expect(arInsert.payload.invoice_kind).toBe("customer_credit_memo");
    expect(arInsert.payload.source).toBe("faire");
    expect(arInsert.payload.gl_status).toBe("posted");
    expect(arInsert.payload.reverses_invoice_id).toBe("inv-1");
  });

  it("uses faire-side return id in invoice_number prefix", async () => {
    const supabase = makeStandardSupabase();
    await defaultPostCreditMemo({
      supabase, faireReturnsRow: { id: "fr-row" }, faireOrderRowId: "order-row",
    });
    const arInsert = supabase._calls.find((c) => c.table === "ar_invoices" && c.op === "insert");
    expect(arInsert.payload.invoice_number).toMatch(/^FAIRE-CM-/);
  });

  it("throws when faire_orders has no customer_id", async () => {
    const supabase = makeStandardSupabase({
      faireOrderRead: {
        data: { id: "order-row", entity_id: "ent-x", faire_order_id: "ord-99", customer_id: null, placed_at: "2026-05-01" },
        error: null,
      },
    });
    await expect(
      defaultPostCreditMemo({
        supabase, faireReturnsRow: { id: "fr-row" }, faireOrderRowId: "order-row",
      }),
    ).rejects.toThrow(/customer_id/);
  });

  it("throws when GL 1115 missing", async () => {
    const supabase = makeStandardSupabase({
      glAccounts: { data: [{ id: "gl-4000", code: "4000" }], error: null },
    });
    await expect(
      defaultPostCreditMemo({
        supabase, faireReturnsRow: { id: "fr-row" }, faireOrderRowId: "order-row",
      }),
    ).rejects.toThrow(/1115/);
  });

  it("throws when GL 4000 missing", async () => {
    const supabase = makeStandardSupabase({
      glAccounts: { data: [{ id: "gl-1115", code: "1115" }], error: null },
    });
    await expect(
      defaultPostCreditMemo({
        supabase, faireReturnsRow: { id: "fr-row" }, faireOrderRowId: "order-row",
      }),
    ).rejects.toThrow(/4000/);
  });

  it("throws when refund_amount_cents is 0", async () => {
    const supabase = makeStandardSupabase({
      faireReturnRead: {
        data: { id: "fr-row", entity_id: "ent-x", faire_shop_id: "shop-x",
                faire_return_id: "ret-99", refund_amount_cents: 0,
                je_id: null, raw_payload: {} },
        error: null,
      },
    });
    await expect(
      defaultPostCreditMemo({
        supabase, faireReturnsRow: { id: "fr-row" }, faireOrderRowId: "order-row",
      }),
    ).rejects.toThrow(/> 0/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// buildRestockPairs — best-effort inventory pair builder.
// ────────────────────────────────────────────────────────────────────────

describe("buildRestockPairs", () => {
  it("returns empty when no inventory/cogs GL ids", async () => {
    const supabase = makeSupabaseMock({});
    const out = await buildRestockPairs({
      supabase, entityId: "ent", payload: { items: [{ sku: "X", quantity: 1 }] },
      inventoryId: null, cogsId: null, desc: "x",
    });
    expect(out).toEqual({ lines: [], layers: [] });
  });

  it("returns empty when payload has no items", async () => {
    const supabase = makeSupabaseMock({});
    const out = await buildRestockPairs({
      supabase, entityId: "ent", payload: {},
      inventoryId: "inv", cogsId: "cogs", desc: "x",
    });
    expect(out).toEqual({ lines: [], layers: [] });
  });

  it("skips lines with missing sku", async () => {
    const supabase = makeSupabaseMock({});
    const out = await buildRestockPairs({
      supabase, entityId: "ent",
      payload: { items: [{ quantity: 1 }] },
      inventoryId: "inv", cogsId: "cogs", desc: "x",
    });
    expect(out.lines).toHaveLength(0);
  });

  it("skips lines with qty <= 0", async () => {
    const supabase = makeSupabaseMock({});
    const out = await buildRestockPairs({
      supabase, entityId: "ent",
      payload: { items: [{ sku: "A", quantity: 0 }] },
      inventoryId: "inv", cogsId: "cogs", desc: "x",
    });
    expect(out.lines).toHaveLength(0);
  });

  it("emits DR inventory + CR cogs pair when sku → item + layer resolved", async () => {
    const supabase = makeSupabaseMock({
      ip_item_master: () => ({ data: { id: "item-1" }, error: null }),
      inventory_layers: () => ({ data: { unit_cost_cents: 500 }, error: null }),
    });
    const out = await buildRestockPairs({
      supabase, entityId: "ent",
      payload: { items: [{ sku: "SKU-1", quantity: 2 }] },
      inventoryId: "gl-1300", cogsId: "gl-5000", desc: "Return X",
    });
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toMatchObject({ account_id: "gl-1300", debit: "10.00", credit: "0" });
    expect(out.lines[1]).toMatchObject({ account_id: "gl-5000", debit: "0", credit: "10.00" });
    expect(out.layers).toHaveLength(1);
    expect(out.layers[0]).toEqual({ item_id: "item-1", qty: 2, unit_cost_cents: 500 });
  });

  it("skips line when ip_item_master lookup misses", async () => {
    const supabase = makeSupabaseMock({
      ip_item_master: () => ({ data: null, error: null }),
    });
    const out = await buildRestockPairs({
      supabase, entityId: "ent",
      payload: { items: [{ sku: "UNK", quantity: 1 }] },
      inventoryId: "inv", cogsId: "cogs", desc: "x",
    });
    expect(out.lines).toHaveLength(0);
  });

  it("skips line when no open layer for item", async () => {
    const supabase = makeSupabaseMock({
      ip_item_master: () => ({ data: { id: "item-1" }, error: null }),
      inventory_layers: () => ({ data: null, error: null }),
    });
    const out = await buildRestockPairs({
      supabase, entityId: "ent",
      payload: { items: [{ sku: "SKU-1", quantity: 1 }] },
      inventoryId: "inv", cogsId: "cogs", desc: "x",
    });
    expect(out.lines).toHaveLength(0);
  });
});
