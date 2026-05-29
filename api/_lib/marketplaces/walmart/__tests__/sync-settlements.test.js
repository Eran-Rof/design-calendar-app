// Tangerine P12b-4 — tests for the Walmart Marketplace settlement
// reconciliation service.
//
// Coverage:
//   - BigInt cents helpers (toBigInt / centsToDecimal / toCents)
//   - computeRequestedFromDate: lookback floor, sinceOverride, lastSync clamp
//   - buildSettlementRow: id/period/currency fallback, gross/net waterfall
//   - buildSettlementJePayload: 2-line bank-deposit shape, balance check,
//     missing-account guards, zero-net guard
//   - resolveSettlementAccounts: code map by entity
//   - matchBankTransaction: single-hit match, multi-hit deferral, window
//   - syncWalmartSettlements end-to-end:
//       * zero-account summary
//       * happy-path single account: upsert + JE + cursor + bank match
//       * multi-account isolation (one bad acct, the other still runs)
//       * nextCursor page walk
//       * idempotent je_id skip
//       * zero-net settlement skip
//       * onlyAccountId scopes
//       * sinceOverride passed through
//       * RPC error doesn't halt the page walk
//       * non-Bearer bank-match outside the ±5 day window misses

import { describe, it, expect } from "vitest";
import {
  syncWalmartSettlements,
  buildSettlementJePayload,
  buildSettlementRow,
  resolveSettlementAccounts,
  computeRequestedFromDate,
  matchBankTransaction,
  toCents,
  toBigInt,
  centsToDecimal,
  DEFAULT_LOOKBACK_DAYS,
} from "../sync-settlements.js";

const ENTITY     = "11111111-1111-1111-1111-111111111111";
const ACCT       = "22222222-2222-2222-2222-222222222222";
const ACCT2      = "33333333-3333-3333-3333-333333333333";
const SETTLEMENT = "44444444-4444-4444-4444-444444444444";
const BANK       = "55555555-5555-5555-5555-555555555555";
const CLEARING   = "66666666-6666-6666-6666-666666666666";
const JE_ID      = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BANK_TXN   = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function buf(s) { return Buffer.from(s); }

const DEFAULT_ACCOUNT = {
  id: ACCT,
  entity_id: ENTITY,
  partner_id: "10000xxxxx",
  account_name: "ROF Walmart NA",
  client_id_ciphertext: buf("ci"),
  client_id_iv: buf("ii"),
  client_id_tag: buf("ti"),
  client_secret_ciphertext: buf("cs"),
  client_secret_iv: buf("is"),
  client_secret_tag: buf("ts"),
  is_active: true,
  last_settlement_sync_at: null,
};

const DEFAULT_GL_ROWS = [
  { entity_id: ENTITY, code: "1100", id: BANK },
  { entity_id: ENTITY, code: "1115", id: CLEARING },
];

function makeSettlement(overrides = {}) {
  return {
    id: SETTLEMENT,
    entity_id: ENTITY,
    walmart_seller_account_id: ACCT,
    settlement_id: "WM-SET-1",
    period_start: "2026-05-01",
    period_end:   "2026-05-07",
    gross_amount_cents: 10000,
    fees_amount_cents: 0,
    refunds_amount_cents: 0,
    net_amount_cents: 10000,
    currency: "USD",
    je_id: null,
    bank_transaction_id: null,
    ...overrides,
  };
}

function makeAccounts(overrides = {}) {
  return {
    bankId: BANK,
    clearingId: CLEARING,
    ...overrides,
  };
}

// In-memory Supabase mock. Subset used by sync-settlements:
//   .from(name).select().eq().in().not().gte().lte()
//   .from(name).upsert(row, {onConflict}).select(...).single()
//   .from(name).update(patch).eq()
//   .rpc("gl_post_journal_entry", {payload})
function makeStore(initial = {}, opts = {}) {
  const tables = {
    walmart_seller_accounts: [...(initial.walmart_seller_accounts || [])],
    walmart_settlements:     [...(initial.walmart_settlements || [])],
    gl_accounts:             [...(initial.gl_accounts || [])],
    bank_transactions:       [...(initial.bank_transactions || [])],
  };
  const calls = { rpc: [], updates: [], upserts: [] };

  function builder(name) {
    const rows = tables[name];
    if (!rows) throw new Error(`unknown table: ${name}`);
    const filters = [];
    return {
      select() { return this; },
      eq(col, val) { filters.push((r) => r[col] === val); return this; },
      not(col, op, val) {
        if (op === "is" && val === null) filters.push((r) => r[col] != null);
        return this;
      },
      gte(col, val) { filters.push((r) => r[col] >= val); return this; },
      lte(col, val) { filters.push((r) => r[col] <= val); return this; },
      in(col, vals) {
        const matched = rows.filter((r) => filters.every((f) => f(r)) && vals.includes(r[col]));
        return Promise.resolve({ data: matched, error: null });
      },
      maybeSingle() {
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: matched[0] || null, error: null });
      },
      single() {
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

function makeWmClient(pages) {
  let i = 0;
  const calls = { listSettlementReports: [] };
  return {
    calls,
    listSettlementReports(args) {
      calls.listSettlementReports.push(args);
      const p = pages[i++] || { data: [], nextCursor: null };
      return Promise.resolve(p);
    },
  };
}

function fakeDecrypt(ciphertext) {
  return `decrypted:${ciphertext?.toString?.()}`;
}

function fakeGetAccessToken() {
  return Promise.resolve({ access_token: "eyJraWQi.fake", token_type: "Bearer", expires_in: 900 });
}

// ──────────────────────────────────────────────────────────────────────
// Pure helpers
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
  it("accepts string integers (incl. negative)", () => {
    expect(toBigInt("12345")).toBe(12345n);
    expect(toBigInt("-99")).toBe(-99n);
  });
  it("rejects non-integer strings", () => {
    expect(() => toBigInt("1.5")).toThrow(/integer-cents/);
  });
});

describe("centsToDecimal", () => {
  it("formats whole dollars", () => {
    expect(centsToDecimal(10000n)).toBe("100.00");
  });
  it("pads single digit cents", () => {
    expect(centsToDecimal(10005n)).toBe("100.05");
  });
  it("handles negatives", () => {
    expect(centsToDecimal(-2050n)).toBe("-20.50");
  });
});

describe("toCents", () => {
  it("converts dollar floats to cents (always × 100)", () => {
    expect(toCents(12.34)).toBe(1234);
    expect(toCents(1000.00)).toBe(100000);   // round dollars => 100k cents
    expect(toCents(100)).toBe(10000);        // bare int = $100, not 100¢
  });
  it("handles decimal strings", () => {
    expect(toCents("12.34")).toBe(1234);
    expect(toCents("100.00")).toBe(10000);
    expect(toCents("100")).toBe(10000);
  });
  it("returns 0 for null/garbage", () => {
    expect(toCents(null)).toBe(0);
    expect(toCents(undefined)).toBe(0);
    expect(toCents("garbage")).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// computeRequestedFromDate
// ──────────────────────────────────────────────────────────────────────

describe("computeRequestedFromDate", () => {
  it("returns sinceOverride verbatim when present", () => {
    expect(
      computeRequestedFromDate(null, 30, "2026-04-01T00:00:00Z", Date.now()),
    ).toBe("2026-04-01T00:00:00Z");
  });
  it("falls back to now - sinceDaysAgo days when lastSync is null", () => {
    const now = new Date("2026-05-28T00:00:00Z").getTime();
    expect(computeRequestedFromDate(null, 30, null, now)).toBe(
      new Date(now - 30 * 86400000).toISOString(),
    );
  });
  it("uses DEFAULT_LOOKBACK_DAYS when sinceDaysAgo is invalid", () => {
    const now = new Date("2026-05-28T00:00:00Z").getTime();
    expect(computeRequestedFromDate(null, 0, null, now)).toBe(
      new Date(now - DEFAULT_LOOKBACK_DAYS * 86400000).toISOString(),
    );
  });
  it("uses lastSync when more recent than the floor", () => {
    const now = new Date("2026-05-28T00:00:00Z").getTime();
    const recent = new Date(now - 5 * 86400000).toISOString();
    expect(computeRequestedFromDate(recent, 30, null, now)).toBe(recent);
  });
  it("clamps an ancient lastSync back to the floor", () => {
    const now = new Date("2026-05-28T00:00:00Z").getTime();
    const ancient = "2020-01-01T00:00:00Z";
    expect(computeRequestedFromDate(ancient, 30, null, now)).toBe(
      new Date(now - 30 * 86400000).toISOString(),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildSettlementRow
// ──────────────────────────────────────────────────────────────────────

describe("buildSettlementRow", () => {
  it("maps a Walmart settlement report payload (camelCase)", () => {
    const row = buildSettlementRow({
      account: DEFAULT_ACCOUNT,
      settlement: {
        settlementId: "WM-S-42",
        periodStart: "2026-05-01",
        periodEnd:   "2026-05-07",
        grossAmount: 1000.00,
        feesAmount:  50.00,
        refundsAmount: 25.00,
        netAmount:   925.00,
        currency: "USD",
      },
    });
    expect(row.settlement_id).toBe("WM-S-42");
    expect(row.period_start).toBe("2026-05-01");
    expect(row.period_end).toBe("2026-05-07");
    expect(row.gross_amount_cents).toBe(100000);
    expect(row.fees_amount_cents).toBe(5000);
    expect(row.refunds_amount_cents).toBe(2500);
    expect(row.net_amount_cents).toBe(92500);
    expect(row.currency).toBe("USD");
    expect(row.walmart_seller_account_id).toBe(ACCT);
    expect(row.entity_id).toBe(ENTITY);
  });

  it("accepts snake_case alias keys", () => {
    const row = buildSettlementRow({
      account: DEFAULT_ACCOUNT,
      settlement: {
        settlement_id: "WM-S-snake",
        period_start: "2026-04-01",
        period_end:   "2026-04-07",
        gross_amount: 500,
        fees_amount: 10,
        refunds_amount: 0,
        net_amount: 490,
      },
    });
    expect(row.settlement_id).toBe("WM-S-snake");
    expect(row.gross_amount_cents).toBe(50000);
    expect(row.net_amount_cents).toBe(49000);
  });

  it("accepts reportId as a settlement-id alias", () => {
    const row = buildSettlementRow({
      account: DEFAULT_ACCOUNT,
      settlement: {
        reportId: "RPT-7",
        requestedFromDate: "2026-04-01",
        requestedToDate:   "2026-04-07",
      },
    });
    expect(row.settlement_id).toBe("RPT-7");
    expect(row.period_start).toBe("2026-04-01");
    expect(row.period_end).toBe("2026-04-07");
  });

  it("computes net from gross - fees - refunds when net not present", () => {
    const row = buildSettlementRow({
      account: DEFAULT_ACCOUNT,
      settlement: {
        settlementId: "WM-S-derive",
        gross: 1000,
        fees: 100,
        refunds: 50,
      },
    });
    expect(row.gross_amount_cents).toBe(100000);
    expect(row.fees_amount_cents).toBe(10000);
    expect(row.refunds_amount_cents).toBe(5000);
    expect(row.net_amount_cents).toBe(85000);
  });

  it("throws when no settlement_id-shaped key present", () => {
    expect(() =>
      buildSettlementRow({ account: DEFAULT_ACCOUNT, settlement: { grossAmount: 1 } }),
    ).toThrow(/settlement_id/);
  });

  it("defaults currency to USD", () => {
    const row = buildSettlementRow({
      account: DEFAULT_ACCOUNT,
      settlement: { settlementId: "WM-S-cur" },
    });
    expect(row.currency).toBe("USD");
  });

  it("stashes the raw payload verbatim", () => {
    const raw = { settlementId: "WM-S-raw", anything: "else" };
    const row = buildSettlementRow({ account: DEFAULT_ACCOUNT, settlement: raw });
    expect(row.raw_payload).toBe(raw);
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildSettlementJePayload
// ──────────────────────────────────────────────────────────────────────

describe("buildSettlementJePayload", () => {
  it("emits a balanced 2-line JE (DR Bank, CR Clearing)", () => {
    const payload = buildSettlementJePayload({
      settlement: makeSettlement({ net_amount_cents: 10000 }),
      accounts: makeAccounts(),
    });
    expect(payload.lines).toHaveLength(2);
    expect(payload.lines[0]).toMatchObject({ account_id: BANK, debit: "100.00", credit: "0" });
    expect(payload.lines[1]).toMatchObject({ account_id: CLEARING, debit: "0", credit: "100.00" });
    expect(payload.journal_type).toBe("bank_deposit");
    expect(payload.source_module).toBe("walmart");
    expect(payload.source_table).toBe("walmart_settlements");
    expect(payload.source_id).toBe(SETTLEMENT);
    expect(payload.entity_id).toBe(ENTITY);
    expect(payload.posting_date).toBe("2026-05-07");
  });

  it("debits + credits balance", () => {
    const payload = buildSettlementJePayload({
      settlement: makeSettlement({ net_amount_cents: 12345 }),
      accounts: makeAccounts(),
    });
    let dr = 0n;
    let cr = 0n;
    for (const l of payload.lines) {
      const [w, f = "0"] = String(l.debit).split(".");
      const [w2, f2 = "0"] = String(l.credit).split(".");
      dr += BigInt(w) * 100n + BigInt((f + "00").slice(0, 2));
      cr += BigInt(w2) * 100n + BigInt((f2 + "00").slice(0, 2));
    }
    expect(dr).toBe(cr);
  });

  it("throws when missing 1100 Bank", () => {
    expect(() => buildSettlementJePayload({
      settlement: makeSettlement(),
      accounts: makeAccounts({ bankId: null }),
    })).toThrow(/Bank/);
  });

  it("throws when missing 1115 Clearing", () => {
    expect(() => buildSettlementJePayload({
      settlement: makeSettlement(),
      accounts: makeAccounts({ clearingId: null }),
    })).toThrow(/Clearing/);
  });

  it("throws when net <= 0", () => {
    expect(() => buildSettlementJePayload({
      settlement: makeSettlement({ net_amount_cents: 0 }),
      accounts: makeAccounts(),
    })).toThrow(/nothing to post/);
  });

  it("posts on period_end date when present", () => {
    const payload = buildSettlementJePayload({
      settlement: makeSettlement({ period_end: "2026-06-15" }),
      accounts: makeAccounts(),
    });
    expect(payload.posting_date).toBe("2026-06-15");
  });

  it("falls back to period_start when period_end missing", () => {
    const payload = buildSettlementJePayload({
      settlement: makeSettlement({ period_end: null, period_start: "2026-03-10" }),
      accounts: makeAccounts(),
    });
    expect(payload.posting_date).toBe("2026-03-10");
  });
});

// ──────────────────────────────────────────────────────────────────────
// resolveSettlementAccounts
// ──────────────────────────────────────────────────────────────────────

describe("resolveSettlementAccounts", () => {
  it("returns Bank + Clearing id by code", async () => {
    const sb = makeStore({ gl_accounts: DEFAULT_GL_ROWS });
    const accts = await resolveSettlementAccounts(sb, ENTITY);
    expect(accts.bankId).toBe(BANK);
    expect(accts.clearingId).toBe(CLEARING);
  });

  it("returns null for missing codes", async () => {
    const sb = makeStore({ gl_accounts: [{ entity_id: ENTITY, code: "1100", id: BANK }] });
    const accts = await resolveSettlementAccounts(sb, ENTITY);
    expect(accts.bankId).toBe(BANK);
    expect(accts.clearingId).toBe(null);
  });

  it("scopes by entity_id (no leak across entities)", async () => {
    const sb = makeStore({
      gl_accounts: [
        { entity_id: ENTITY, code: "1100", id: BANK },
        { entity_id: "other-entity", code: "1115", id: "leak" },
      ],
    });
    const accts = await resolveSettlementAccounts(sb, ENTITY);
    expect(accts.bankId).toBe(BANK);
    expect(accts.clearingId).toBe(null);
  });
});

// ──────────────────────────────────────────────────────────────────────
// matchBankTransaction
// ──────────────────────────────────────────────────────────────────────

describe("matchBankTransaction", () => {
  it("matches a single hit and stamps both sides", async () => {
    const sb = makeStore({
      walmart_settlements: [makeSettlement({ net_amount_cents: 10000 })],
      bank_transactions: [{
        id: BANK_TXN,
        entity_id: ENTITY,
        status: "unmatched",
        amount_cents: 10000,
        posted_date: "2026-05-07",
      }],
    });
    const settlement = sb.tables.walmart_settlements[0];
    const ok = await matchBankTransaction(sb, DEFAULT_ACCOUNT, settlement, JE_ID);
    expect(ok).toBe(true);
    expect(sb.tables.walmart_settlements[0].bank_transaction_id).toBe(BANK_TXN);
    expect(sb.tables.bank_transactions[0].status).toBe("matched");
  });

  it("returns false on multi-hit (operator must choose)", async () => {
    const sb = makeStore({
      walmart_settlements: [makeSettlement()],
      bank_transactions: [
        { id: BANK_TXN, entity_id: ENTITY, status: "unmatched", amount_cents: 10000, posted_date: "2026-05-06" },
        { id: "other-txn", entity_id: ENTITY, status: "unmatched", amount_cents: 10000, posted_date: "2026-05-07" },
      ],
    });
    const settlement = sb.tables.walmart_settlements[0];
    const ok = await matchBankTransaction(sb, DEFAULT_ACCOUNT, settlement, JE_ID);
    expect(ok).toBe(false);
    // No mutation.
    expect(sb.tables.walmart_settlements[0].bank_transaction_id).toBeFalsy();
  });

  it("returns false when amount differs", async () => {
    const sb = makeStore({
      walmart_settlements: [makeSettlement({ net_amount_cents: 10000 })],
      bank_transactions: [{
        id: BANK_TXN, entity_id: ENTITY, status: "unmatched",
        amount_cents: 9999, posted_date: "2026-05-07",
      }],
    });
    const settlement = sb.tables.walmart_settlements[0];
    const ok = await matchBankTransaction(sb, DEFAULT_ACCOUNT, settlement, JE_ID);
    expect(ok).toBe(false);
  });

  it("returns false outside the ±5 day window", async () => {
    const sb = makeStore({
      walmart_settlements: [makeSettlement({ net_amount_cents: 10000 })],
      bank_transactions: [{
        id: BANK_TXN, entity_id: ENTITY, status: "unmatched",
        amount_cents: 10000, posted_date: "2026-05-20",   // > 5 days after period_end 2026-05-07
      }],
    });
    const settlement = sb.tables.walmart_settlements[0];
    const ok = await matchBankTransaction(sb, DEFAULT_ACCOUNT, settlement, JE_ID);
    expect(ok).toBe(false);
  });

  it("returns false on zero-net settlements (degenerate)", async () => {
    const sb = makeStore({ walmart_settlements: [makeSettlement({ net_amount_cents: 0 })], bank_transactions: [] });
    const ok = await matchBankTransaction(sb, DEFAULT_ACCOUNT, sb.tables.walmart_settlements[0], JE_ID);
    expect(ok).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// syncWalmartSettlements end-to-end
// ──────────────────────────────────────────────────────────────────────

describe("syncWalmartSettlements", () => {
  it("returns zero summary when no active accounts", async () => {
    const sb = makeStore({ walmart_seller_accounts: [] });
    const out = await syncWalmartSettlements({
      adminClient: sb,
      deps: {
        decryptToken: fakeDecrypt,
        getAccessToken: fakeGetAccessToken,
        makeClient: () => makeWmClient([]),
        now: () => new Date("2026-05-28T00:00:00Z").getTime(),
      },
    });
    expect(out.accounts_scanned).toBe(0);
    expect(out.settlements_upserted_total).toBe(0);
    expect(out.settlements_posted_total).toBe(0);
  });

  it("upserts settlements, posts JE, stamps je_id, updates cursor", async () => {
    const sb = makeStore({
      walmart_seller_accounts: [DEFAULT_ACCOUNT],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeWmClient([{
      data: [
        {
          settlementId: "WM-A",
          periodStart: "2026-05-01",
          periodEnd:   "2026-05-07",
          grossAmount: 1000.00,
          netAmount:   950.00,
        },
        {
          settlementId: "WM-B",
          periodStart: "2026-04-24",
          periodEnd:   "2026-04-30",
          grossAmount: 500.00,
          netAmount:   475.00,
        },
      ],
      nextCursor: null,
    }]);
    const now = new Date("2026-05-28T06:30:00Z").getTime();
    const out = await syncWalmartSettlements({
      adminClient: sb,
      deps: {
        decryptToken: fakeDecrypt,
        getAccessToken: fakeGetAccessToken,
        makeClient: () => stub,
        now: () => now,
      },
    });
    expect(out.accounts_scanned).toBe(1);
    expect(out.settlements_upserted_total).toBe(2);
    expect(out.settlements_posted_total).toBe(2);
    expect(out.errors).toEqual([]);
    expect(sb.calls.rpc.length).toBe(2);
    for (const s of sb.tables.walmart_settlements) {
      expect(s.je_id).toBe(JE_ID);
    }
    // Cursor advanced.
    expect(sb.tables.walmart_seller_accounts[0].last_settlement_sync_at).toBe(new Date(now).toISOString());
  });

  it("skips already-posted settlements (idempotent je_id)", async () => {
    const sb = makeStore({
      walmart_seller_accounts: [DEFAULT_ACCOUNT],
      walmart_settlements: [{
        id: SETTLEMENT,
        entity_id: ENTITY,
        walmart_seller_account_id: ACCT,
        settlement_id: "WM-DUP",
        je_id: "preexisting-je",
        period_start: "2026-05-01",
        period_end:   "2026-05-07",
        gross_amount_cents: 10000,
        fees_amount_cents: 0,
        refunds_amount_cents: 0,
        net_amount_cents: 10000,
        currency: "USD",
      }],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeWmClient([{
      data: [{
        settlementId: "WM-DUP",
        periodStart: "2026-05-01",
        periodEnd:   "2026-05-07",
        grossAmount: 100.00,
        netAmount:   100.00,
      }],
      nextCursor: null,
    }]);
    const out = await syncWalmartSettlements({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, getAccessToken: fakeGetAccessToken, makeClient: () => stub, now: () => Date.now() },
    });
    expect(out.settlements_upserted_total).toBe(1);
    expect(out.settlements_posted_total).toBe(0);
    expect(out.settlements_skipped_total).toBe(1);
    expect(sb.calls.rpc.length).toBe(0);
  });

  it("skips zero-net settlements", async () => {
    const sb = makeStore({
      walmart_seller_accounts: [DEFAULT_ACCOUNT],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeWmClient([{
      data: [{
        settlementId: "WM-ZERO",
        periodStart: "2026-05-01",
        periodEnd:   "2026-05-07",
        grossAmount: 0,
        netAmount:   0,
      }],
      nextCursor: null,
    }]);
    const out = await syncWalmartSettlements({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, getAccessToken: fakeGetAccessToken, makeClient: () => stub, now: () => Date.now() },
    });
    expect(out.settlements_upserted_total).toBe(1);
    expect(out.settlements_posted_total).toBe(0);
    expect(out.settlements_skipped_total).toBe(1);
    expect(sb.calls.rpc.length).toBe(0);
  });

  it("walks nextCursor until null", async () => {
    const sb = makeStore({
      walmart_seller_accounts: [DEFAULT_ACCOUNT],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeWmClient([
      {
        data: [{ settlementId: "WM-P1", periodStart: "2026-04-01", periodEnd: "2026-04-07", grossAmount: 100, netAmount: 97 }],
        nextCursor: "CURSOR2",
      },
      {
        data: [{ settlementId: "WM-P2", periodStart: "2026-04-08", periodEnd: "2026-04-14", grossAmount: 200, netAmount: 194 }],
        nextCursor: null,
      },
    ]);
    const out = await syncWalmartSettlements({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, getAccessToken: fakeGetAccessToken, makeClient: () => stub, now: () => Date.now() },
    });
    expect(stub.calls.listSettlementReports.length).toBe(2);
    expect(stub.calls.listSettlementReports[0].requestedFromDate).toBeDefined();
    expect(stub.calls.listSettlementReports[1].nextCursor).toBe("CURSOR2");
    expect(out.settlements_upserted_total).toBe(2);
  });

  it("isolates a failing account from a healthy one (multi-account)", async () => {
    const sb = makeStore({
      walmart_seller_accounts: [
        { ...DEFAULT_ACCOUNT, id: ACCT,  account_name: "BAD" },
        { ...DEFAULT_ACCOUNT, id: ACCT2, account_name: "GOOD" },
      ],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    let count = 0;
    const makeClient = () => ({
      listSettlementReports() {
        count += 1;
        if (count === 1) throw new Error("bad creds");
        return Promise.resolve({ data: [], nextCursor: null });
      },
    });
    const out = await syncWalmartSettlements({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, getAccessToken: fakeGetAccessToken, makeClient, now: () => Date.now() },
    });
    expect(out.accounts_scanned).toBe(2);
    expect(out.errors.length).toBe(1);
    expect(out.errors[0]).toMatch(/bad creds/);
    expect(out.per_account.find((a) => a.walmart_seller_account_id === ACCT).error).toMatch(/bad creds/);
    expect(out.per_account.find((a) => a.walmart_seller_account_id === ACCT2).error).toBe(null);
  });

  it("scopes to onlyAccountId when provided", async () => {
    const sb = makeStore({
      walmart_seller_accounts: [
        { ...DEFAULT_ACCOUNT, id: ACCT,  account_name: "A" },
        { ...DEFAULT_ACCOUNT, id: ACCT2, account_name: "B" },
      ],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeWmClient([{ data: [], nextCursor: null }]);
    const out = await syncWalmartSettlements({
      adminClient: sb,
      onlyAccountId: ACCT2,
      deps: { decryptToken: fakeDecrypt, getAccessToken: fakeGetAccessToken, makeClient: () => stub, now: () => Date.now() },
    });
    expect(out.accounts_scanned).toBe(1);
    expect(out.per_account[0].walmart_seller_account_id).toBe(ACCT2);
  });

  it("passes sinceOverride through to listSettlementReports", async () => {
    const sb = makeStore({
      walmart_seller_accounts: [DEFAULT_ACCOUNT],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeWmClient([{ data: [], nextCursor: null }]);
    await syncWalmartSettlements({
      adminClient: sb,
      sinceOverride: "2026-01-15T00:00:00Z",
      deps: { decryptToken: fakeDecrypt, getAccessToken: fakeGetAccessToken, makeClient: () => stub, now: () => Date.now() },
    });
    expect(stub.calls.listSettlementReports[0].requestedFromDate).toBe("2026-01-15T00:00:00Z");
  });

  it("matches a bank transaction within the ±5 day window and stamps it", async () => {
    const sb = makeStore({
      walmart_seller_accounts: [DEFAULT_ACCOUNT],
      gl_accounts: DEFAULT_GL_ROWS,
      bank_transactions: [{
        id: BANK_TXN,
        entity_id: ENTITY,
        status: "unmatched",
        amount_cents: 95000,
        posted_date: "2026-05-08",
      }],
    });
    const stub = makeWmClient([{
      data: [{
        settlementId: "WM-MATCH",
        periodStart: "2026-05-01",
        periodEnd:   "2026-05-07",
        grossAmount: 1000.00,
        netAmount:   950.00,
      }],
      nextCursor: null,
    }]);
    const out = await syncWalmartSettlements({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, getAccessToken: fakeGetAccessToken, makeClient: () => stub, now: () => Date.now() },
    });
    expect(out.bank_matches_total).toBe(1);
    expect(sb.tables.walmart_settlements[0].bank_transaction_id).toBe(BANK_TXN);
    expect(sb.tables.bank_transactions[0].status).toBe("matched");
  });

  it("posts JE without bank match when no bank_transactions row hits", async () => {
    const sb = makeStore({
      walmart_seller_accounts: [DEFAULT_ACCOUNT],
      gl_accounts: DEFAULT_GL_ROWS,
      bank_transactions: [],
    });
    const stub = makeWmClient([{
      data: [{
        settlementId: "WM-NOMATCH",
        periodStart: "2026-05-01",
        periodEnd:   "2026-05-07",
        grossAmount: 1000.00,
        netAmount:   950.00,
      }],
      nextCursor: null,
    }]);
    const out = await syncWalmartSettlements({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, getAccessToken: fakeGetAccessToken, makeClient: () => stub, now: () => Date.now() },
    });
    expect(out.settlements_posted_total).toBe(1);
    expect(out.bank_matches_total).toBe(0);
  });

  it("does not halt the page walk on a single RPC error", async () => {
    const sb = makeStore({
      walmart_seller_accounts: [DEFAULT_ACCOUNT],
      gl_accounts: DEFAULT_GL_ROWS,
    }, { rpcError: { message: "intentional test error" } });
    const stub = makeWmClient([{
      data: [
        { settlementId: "WM-Q1", periodStart: "2026-04-01", periodEnd: "2026-04-07", grossAmount: 100, netAmount: 97 },
        { settlementId: "WM-Q2", periodStart: "2026-04-08", periodEnd: "2026-04-14", grossAmount: 200, netAmount: 194 },
      ],
      nextCursor: null,
    }]);
    const out = await syncWalmartSettlements({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, getAccessToken: fakeGetAccessToken, makeClient: () => stub, now: () => Date.now() },
    });
    expect(out.settlements_upserted_total).toBe(2);
    expect(out.settlements_posted_total).toBe(0);
    expect(out.per_account[0].error).toMatch(/intentional test error/);
  });

  it("throws when adminClient missing", async () => {
    await expect(syncWalmartSettlements({})).rejects.toThrow(/adminClient/);
  });

  it("throws when account is missing encryption triple", async () => {
    const sb = makeStore({
      walmart_seller_accounts: [{ ...DEFAULT_ACCOUNT, client_secret_tag: null }],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeWmClient([{ data: [], nextCursor: null }]);
    const out = await syncWalmartSettlements({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, getAccessToken: fakeGetAccessToken, makeClient: () => stub, now: () => Date.now() },
    });
    // Per-account error is captured in summary; one entry in errors[].
    expect(out.errors.length).toBe(1);
    expect(out.errors[0]).toMatch(/ciphertext triple/);
  });

  it("calls getAccessToken with decrypted creds", async () => {
    const sb = makeStore({
      walmart_seller_accounts: [DEFAULT_ACCOUNT],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeWmClient([{ data: [], nextCursor: null }]);
    const calls = [];
    await syncWalmartSettlements({
      adminClient: sb,
      deps: {
        decryptToken: fakeDecrypt,
        getAccessToken: (args) => { calls.push(args); return fakeGetAccessToken(); },
        makeClient: () => stub,
        now: () => Date.now(),
      },
    });
    expect(calls.length).toBe(1);
    expect(calls[0].clientId).toMatch(/^decrypted:/);
    expect(calls[0].clientSecret).toMatch(/^decrypted:/);
  });

  it("builds the WalmartClient with partnerId + accessToken", async () => {
    const sb = makeStore({
      walmart_seller_accounts: [DEFAULT_ACCOUNT],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeWmClient([{ data: [], nextCursor: null }]);
    const captured = [];
    await syncWalmartSettlements({
      adminClient: sb,
      deps: {
        decryptToken: fakeDecrypt,
        getAccessToken: fakeGetAccessToken,
        makeClient: (cfg) => { captured.push(cfg); return stub; },
        now: () => Date.now(),
      },
    });
    expect(captured.length).toBe(1);
    expect(captured[0].partnerId).toBe("10000xxxxx");
    expect(captured[0].accessToken).toBe("eyJraWQi.fake");
  });
});
