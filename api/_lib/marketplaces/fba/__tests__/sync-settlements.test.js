// Tangerine P12a-4 — tests for the FBA settlement reconciliation
// service.
//
// Coverage:
//   - BigInt cents helpers (toBigInt / centsToDecimal / parseAmount)
//   - computeSettlementSince: lookback floor, sinceOverride, lastSync clamp
//   - extractSettlementFees: nested SP-API shape + flat keys
//   - buildSettlementRow: status passthrough, currency fallback, gross/net
//   - buildSettlementJePayload: 2-line bank-deposit shape, multi-fee shape,
//     balance check, missing-account guards, zero-net guard
//   - resolveSettlementAccounts: code map by entity
//   - matchBankTransaction: single-hit match, multi-hit deferral, window
//   - syncFbaSettlements end-to-end:
//       * zero-account summary
//       * happy-path single account: upsert + JE + cursor + bank match
//       * multi-account isolation (one bad acct, the other still runs)
//       * NextToken page walk
//       * idempotent je_id skip
//       * Open status skip (no JE)
//       * zero-net settlement skip
//       * onlyFbaSellerAccountId scopes
//       * sinceOverride passed through
//       * per-event-type fee mapping (storage / sponsored ads / other)
//       * variance warning when ar_clearing ≠ net
//       * RPC error doesn't halt the page walk

import { describe, it, expect } from "vitest";
import {
  syncFbaSettlements,
  buildSettlementJePayload,
  buildSettlementRow,
  resolveSettlementAccounts,
  computeSettlementSince,
  extractSettlementFees,
  matchBankTransaction,
  computeClearingVariance,
  parseAmount,
  toBigInt,
  centsToDecimal,
  decryptAccountCreds,
  DEFAULT_LOOKBACK_DAYS,
} from "../sync-settlements.js";

const ENTITY     = "11111111-1111-1111-1111-111111111111";
const ACCT       = "22222222-2222-2222-2222-222222222222";
const ACCT2      = "33333333-3333-3333-3333-333333333333";
const SETTLEMENT = "44444444-4444-4444-4444-444444444444";
const BANK       = "55555555-5555-5555-5555-555555555555";
const CLEARING   = "66666666-6666-6666-6666-666666666666";
const SPONSORED  = "77777777-7777-7777-7777-777777777777";
const STORAGE    = "88888888-8888-8888-8888-888888888888";
const OTHER      = "99999999-9999-9999-9999-999999999999";
const JE_ID      = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BANK_TXN   = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function buf(s) { return Buffer.from(s); }

const DEFAULT_ACCOUNT = {
  id: ACCT,
  entity_id: ENTITY,
  seller_id: "A1XXXXXXXXXXXX",
  marketplace_id: "ATVPDKIKX0DER",
  account_name: "ROF US Amazon",
  region: "NA",
  lwa_client_id_ciphertext: buf("c1"),
  lwa_client_id_iv: buf("i1"),
  lwa_client_id_tag: buf("t1"),
  lwa_client_secret_ciphertext: buf("c2"),
  lwa_client_secret_iv: buf("i2"),
  lwa_client_secret_tag: buf("t2"),
  refresh_token_ciphertext: buf("c3"),
  refresh_token_iv: buf("i3"),
  refresh_token_tag: buf("t3"),
  aws_role_arn: null,
  is_active: true,
  last_settlement_sync_at: null,
};

const DEFAULT_GL_ROWS = [
  { entity_id: ENTITY, code: "1100", id: BANK },
  { entity_id: ENTITY, code: "1115", id: CLEARING },
  { entity_id: ENTITY, code: "6520", id: OTHER },
  { entity_id: ENTITY, code: "6521", id: SPONSORED },
  { entity_id: ENTITY, code: "6522", id: STORAGE },
];

function makeSettlement(overrides = {}) {
  return {
    id: SETTLEMENT,
    entity_id: ENTITY,
    fba_seller_account_id: ACCT,
    financial_event_group_id: "FEG_1",
    posted_after: "2026-05-01T00:00:00Z",
    posted_before: "2026-05-14T00:00:00Z",
    gross_amount_cents: 10000,
    fees_amount_cents: 0,
    refunds_amount_cents: 0,
    net_amount_cents: 10000,
    currency: "USD",
    processing_status: "Closed",
    je_id: null,
    bank_transaction_id: null,
    raw_payload: {},
    ...overrides,
  };
}

function makeAccounts(overrides = {}) {
  return {
    bankId: BANK,
    clearingId: CLEARING,
    sponsoredAdsId: SPONSORED,
    storageFeesId: STORAGE,
    marketplaceFeesId: OTHER,
    ...overrides,
  };
}

// In-memory Supabase mock. Subset used by sync-settlements:
//   .from(name).select().eq().in().not().gte().lte()
//   .from(name).upsert(row, {onConflict}).select().single()
//   .from(name).update(patch).eq()
//   .rpc("gl_post_journal_entry", {payload})
function makeStore(initial = {}, opts = {}) {
  const tables = {
    fba_seller_accounts: [...(initial.fba_seller_accounts || [])],
    fba_settlements:     [...(initial.fba_settlements || [])],
    fba_orders:          [...(initial.fba_orders || [])],
    fba_order_items:     [...(initial.fba_order_items || [])],
    gl_accounts:         [...(initial.gl_accounts || [])],
    bank_transactions:   [...(initial.bank_transactions || [])],
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
          // Mirror prod: entity-scoped FBA tables have entity_id DEFAULT
          // rof_entity_id(), so an insert that omits entity_id gets ROF's id
          // back from .select(). Without this the e2e bank-match (.eq entity_id)
          // sees undefined and matches nothing.
          const dflt = (name === "fba_settlements" && row.entity_id == null) ? { entity_id: ENTITY } : {};
          const inserted = { id, ...dflt, ...row };
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

function makeSpClient(pages, getOrderItemsReturn = { OrderItems: [] }) {
  let i = 0;
  const calls = { listFinancialEventGroups: [], getOrderItems: [] };
  return {
    calls,
    listFinancialEventGroups(args) {
      calls.listFinancialEventGroups.push(args);
      const p = pages[i++] || { FinancialEventGroupList: [], NextToken: null };
      return Promise.resolve(p);
    },
    getOrderItems(...args) {
      calls.getOrderItems.push(args);
      return Promise.resolve(getOrderItemsReturn);
    },
  };
}

function fakeDecrypt(ciphertext) {
  return `decrypted:${ciphertext?.toString?.()}`;
}

function fakeRefresh() {
  return Promise.resolve({ access_token: "Atza|test", token_type: "bearer", expires_in: 3600, cached: false });
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
  it("accepts string integers", () => {
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

describe("parseAmount", () => {
  it("parses SP-API Amount strings to cents", () => {
    expect(parseAmount({ Amount: "12.34", CurrencyCode: "USD" })).toBe(1234);
    expect(parseAmount({ Amount: "100.00" })).toBe(10000);
  });
  it("returns 0 on missing input", () => {
    expect(parseAmount(null)).toBe(0);
    expect(parseAmount({})).toBe(0);
    expect(parseAmount({ Amount: null })).toBe(0);
  });
  it("returns 0 on garbage", () => {
    expect(parseAmount({ Amount: "garbage" })).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// computeSettlementSince
// ──────────────────────────────────────────────────────────────────────

describe("computeSettlementSince", () => {
  it("returns sinceOverride verbatim when present", () => {
    expect(
      computeSettlementSince(null, 60, "2026-04-01T00:00:00Z", Date.now()),
    ).toBe("2026-04-01T00:00:00Z");
  });
  it("falls back to now - sinceDaysAgo days when lastSync is null", () => {
    const now = new Date("2026-05-28T00:00:00Z").getTime();
    expect(computeSettlementSince(null, 30, null, now)).toBe(
      new Date(now - 30 * 86400000).toISOString(),
    );
  });
  it("uses DEFAULT_LOOKBACK_DAYS when sinceDaysAgo is invalid", () => {
    const now = new Date("2026-05-28T00:00:00Z").getTime();
    expect(computeSettlementSince(null, 0, null, now)).toBe(
      new Date(now - DEFAULT_LOOKBACK_DAYS * 86400000).toISOString(),
    );
  });
  it("uses lastSync when more recent than the floor", () => {
    const now = new Date("2026-05-28T00:00:00Z").getTime();
    const recent = new Date(now - 5 * 86400000).toISOString();
    expect(computeSettlementSince(recent, 60, null, now)).toBe(recent);
  });
  it("clamps an ancient lastSync back to the floor", () => {
    const now = new Date("2026-05-28T00:00:00Z").getTime();
    const ancient = "2020-01-01T00:00:00Z";
    expect(computeSettlementSince(ancient, 60, null, now)).toBe(
      new Date(now - 60 * 86400000).toISOString(),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// extractSettlementFees
// ──────────────────────────────────────────────────────────────────────

describe("extractSettlementFees", () => {
  it("returns all-zero for empty payload", () => {
    const f = extractSettlementFees({});
    expect(f.sponsoredAds).toBe(0n);
    expect(f.storageFees).toBe(0n);
    expect(f.otherFees).toBe(0n);
  });
  it("reads flat integer-cents keys (snake_case)", () => {
    const f = extractSettlementFees({
      sponsored_ads_cents: 1234,
      storage_fees_cents: 5678,
      other_fees_cents: 99,
    });
    expect(f.sponsoredAds).toBe(1234n);
    expect(f.storageFees).toBe(5678n);
    expect(f.otherFees).toBe(99n);
  });
  it("reads PascalCase keys", () => {
    const f = extractSettlementFees({
      SponsoredAdsCents: 1000,
    });
    expect(f.sponsoredAds).toBe(1000n);
  });
  it("falls back to nested SP-API .Amount strings", () => {
    const f = extractSettlementFees({
      AdvertisingFee: { Amount: "12.50", CurrencyCode: "USD" },
      StorageFee:     { Amount: "5.00",  CurrencyCode: "USD" },
    });
    expect(f.sponsoredAds).toBe(1250n);
    expect(f.storageFees).toBe(500n);
  });
  it("handles null payload safely", () => {
    const f = extractSettlementFees(null);
    expect(f.sponsoredAds).toBe(0n);
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildSettlementRow
// ──────────────────────────────────────────────────────────────────────

describe("buildSettlementRow", () => {
  it("maps an SP-API FinancialEventGroup payload", () => {
    const row = buildSettlementRow({
      account: DEFAULT_ACCOUNT,
      group: {
        FinancialEventGroupId: "FEG_42",
        FinancialEventGroupStart: "2026-05-01T00:00:00Z",
        FinancialEventGroupEnd:   "2026-05-14T00:00:00Z",
        OriginalTotal:  { Amount: "1000.00", CurrencyCode: "USD" },
        ConvertedTotal: { Amount: "950.00",  CurrencyCode: "USD" },
        ProcessingStatus: "Closed",
      },
    });
    expect(row.financial_event_group_id).toBe("FEG_42");
    expect(row.gross_amount_cents).toBe(100000);
    expect(row.net_amount_cents).toBe(95000);
    expect(row.fees_amount_cents).toBe(5000);
    expect(row.processing_status).toBe("Closed");
    expect(row.currency).toBe("USD");
    expect(row.fba_seller_account_id).toBe(ACCT);
  });

  it("defaults processing_status to Open for unclosed groups", () => {
    const row = buildSettlementRow({
      account: DEFAULT_ACCOUNT,
      group: {
        FinancialEventGroupId: "FEG_open",
        FinancialEventGroupStart: "2026-05-15T00:00:00Z",
        OriginalTotal: { Amount: "50.00" },
      },
    });
    expect(row.processing_status).toBe("Open");
  });

  it("falls back to OriginalTotal for net when ConvertedTotal missing", () => {
    const row = buildSettlementRow({
      account: DEFAULT_ACCOUNT,
      group: {
        FinancialEventGroupId: "FEG_x",
        OriginalTotal: { Amount: "200.00" },
      },
    });
    expect(row.gross_amount_cents).toBe(20000);
    expect(row.net_amount_cents).toBe(20000);
    expect(row.fees_amount_cents).toBe(0);
  });

  it("stashes the raw payload", () => {
    const group = { FinancialEventGroupId: "FEG_y", OriginalTotal: { Amount: "1.00" } };
    const row = buildSettlementRow({ account: DEFAULT_ACCOUNT, group });
    expect(row.raw_payload).toBe(group);
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildSettlementJePayload
// ──────────────────────────────────────────────────────────────────────

describe("buildSettlementJePayload", () => {
  it("emits a balanced 2-line JE (DR Bank, CR Clearing) when no extra fees", () => {
    const payload = buildSettlementJePayload({
      settlement: makeSettlement({ net_amount_cents: 10000 }),
      accounts: makeAccounts(),
    });
    expect(payload.lines).toHaveLength(2);
    expect(payload.lines[0]).toMatchObject({ account_id: BANK, debit: "100.00", credit: "0" });
    expect(payload.lines[1]).toMatchObject({ account_id: CLEARING, debit: "0", credit: "100.00" });
    expect(payload.journal_type).toBe("bank_deposit");
    expect(payload.source_module).toBe("fba");
    expect(payload.source_table).toBe("fba_settlements");
    expect(payload.source_id).toBe(SETTLEMENT);
    expect(payload.entity_id).toBe(ENTITY);
    expect(payload.posting_date).toBe("2026-05-14");
  });

  it("adds DR/CR pair per fee category present in the raw payload", () => {
    const payload = buildSettlementJePayload({
      settlement: makeSettlement({
        net_amount_cents: 10000,
        raw_payload: {
          sponsored_ads_cents: 500,
          storage_fees_cents: 200,
        },
      }),
      accounts: makeAccounts(),
    });
    // 2 base lines + 2 sponsored ads + 2 storage = 6
    expect(payload.lines).toHaveLength(6);
    const sponsoredDr = payload.lines.find((l) => l.account_id === SPONSORED && l.debit === "5.00");
    const storageDr   = payload.lines.find((l) => l.account_id === STORAGE && l.debit === "2.00");
    expect(sponsoredDr).toBeTruthy();
    expect(storageDr).toBeTruthy();
  });

  it("maps other_fees to 6520 Marketplace Fees", () => {
    const payload = buildSettlementJePayload({
      settlement: makeSettlement({
        net_amount_cents: 10000,
        raw_payload: { other_fees_cents: 100 },
      }),
      accounts: makeAccounts(),
    });
    expect(payload.lines.some((l) => l.account_id === OTHER && l.debit === "1.00")).toBe(true);
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

  it("throws when sponsored ads > 0 but 6521 not configured", () => {
    expect(() => buildSettlementJePayload({
      settlement: makeSettlement({
        raw_payload: { sponsored_ads_cents: 100 },
      }),
      accounts: makeAccounts({ sponsoredAdsId: null }),
    })).toThrow(/6521|Sponsored Ads/);
  });

  it("throws when storage fees > 0 but 6522 not configured", () => {
    expect(() => buildSettlementJePayload({
      settlement: makeSettlement({
        raw_payload: { storage_fees_cents: 100 },
      }),
      accounts: makeAccounts({ storageFeesId: null }),
    })).toThrow(/6522|Storage Fees/);
  });

  it("throws when net <= 0", () => {
    expect(() => buildSettlementJePayload({
      settlement: makeSettlement({ net_amount_cents: 0 }),
      accounts: makeAccounts(),
    })).toThrow(/nothing to post/);
  });

  it("debits + credits balance after every fee combination", () => {
    const payload = buildSettlementJePayload({
      settlement: makeSettlement({
        net_amount_cents: 50000,
        raw_payload: {
          sponsored_ads_cents: 1234,
          storage_fees_cents: 567,
          other_fees_cents: 89,
        },
      }),
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
});

// ──────────────────────────────────────────────────────────────────────
// resolveSettlementAccounts
// ──────────────────────────────────────────────────────────────────────

describe("resolveSettlementAccounts", () => {
  it("returns the full code → id map for the entity", async () => {
    const sb = makeStore({ gl_accounts: DEFAULT_GL_ROWS });
    const accts = await resolveSettlementAccounts(sb, ENTITY);
    expect(accts.bankId).toBe(BANK);
    expect(accts.clearingId).toBe(CLEARING);
    expect(accts.sponsoredAdsId).toBe(SPONSORED);
    expect(accts.storageFeesId).toBe(STORAGE);
    expect(accts.marketplaceFeesId).toBe(OTHER);
  });

  it("returns null for missing optional codes", async () => {
    const sb = makeStore({
      gl_accounts: [
        { entity_id: ENTITY, code: "1100", id: BANK },
        { entity_id: ENTITY, code: "1115", id: CLEARING },
      ],
    });
    const accts = await resolveSettlementAccounts(sb, ENTITY);
    expect(accts.bankId).toBe(BANK);
    expect(accts.clearingId).toBe(CLEARING);
    expect(accts.sponsoredAdsId).toBe(null);
    expect(accts.storageFeesId).toBe(null);
  });
});

// ──────────────────────────────────────────────────────────────────────
// matchBankTransaction
// ──────────────────────────────────────────────────────────────────────

describe("matchBankTransaction", () => {
  it("returns the bank_transactions.id on a single hit", async () => {
    const sb = makeStore({
      bank_transactions: [{
        id: BANK_TXN,
        entity_id: ENTITY,
        status: "unmatched",
        amount_cents: "10000",
        posted_date: "2026-05-14",
      }],
    });
    const hit = await matchBankTransaction(sb, makeSettlement({ net_amount_cents: 10000 }));
    expect(hit).toBe(BANK_TXN);
  });

  it("returns null on multi-hit (operator must choose)", async () => {
    const sb = makeStore({
      bank_transactions: [
        {
          id: BANK_TXN, entity_id: ENTITY, status: "unmatched",
          amount_cents: "10000", posted_date: "2026-05-13",
        },
        {
          id: "other-txn", entity_id: ENTITY, status: "unmatched",
          amount_cents: "10000", posted_date: "2026-05-14",
        },
      ],
    });
    const hit = await matchBankTransaction(sb, makeSettlement({ net_amount_cents: 10000 }));
    expect(hit).toBe(null);
  });

  it("returns null when amount differs", async () => {
    const sb = makeStore({
      bank_transactions: [{
        id: BANK_TXN, entity_id: ENTITY, status: "unmatched",
        amount_cents: "9999", posted_date: "2026-05-14",
      }],
    });
    const hit = await matchBankTransaction(sb, makeSettlement({ net_amount_cents: 10000 }));
    expect(hit).toBe(null);
  });

  it("returns null outside the ±5 day window", async () => {
    const sb = makeStore({
      bank_transactions: [{
        id: BANK_TXN, entity_id: ENTITY, status: "unmatched",
        amount_cents: "10000", posted_date: "2026-05-25",
      }],
    });
    const hit = await matchBankTransaction(sb, makeSettlement({
      net_amount_cents: 10000,
      posted_before: "2026-05-14T00:00:00Z",
    }));
    expect(hit).toBe(null);
  });

  it("returns null on zero-net settlements (degenerate)", async () => {
    const sb = makeStore({ bank_transactions: [] });
    expect(await matchBankTransaction(sb, makeSettlement({ net_amount_cents: 0 }))).toBe(null);
  });
});

// ──────────────────────────────────────────────────────────────────────
// decryptAccountCreds
// ──────────────────────────────────────────────────────────────────────

describe("decryptAccountCreds", () => {
  it("decrypts all three triples", () => {
    const creds = decryptAccountCreds(DEFAULT_ACCOUNT, fakeDecrypt);
    expect(creds.clientId).toBe("decrypted:c1");
    expect(creds.clientSecret).toBe("decrypted:c2");
    expect(creds.refreshToken).toBe("decrypted:c3");
  });
  it("throws when client_id triple incomplete", () => {
    expect(() => decryptAccountCreds(
      { ...DEFAULT_ACCOUNT, lwa_client_id_ciphertext: null },
      fakeDecrypt,
    )).toThrow(/lwa_client_id/);
  });
  it("throws when refresh_token triple incomplete", () => {
    expect(() => decryptAccountCreds(
      { ...DEFAULT_ACCOUNT, refresh_token_iv: null },
      fakeDecrypt,
    )).toThrow(/refresh_token/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// syncFbaSettlements end-to-end
// ──────────────────────────────────────────────────────────────────────

describe("syncFbaSettlements", () => {
  it("returns zero summary when no active accounts", async () => {
    const sb = makeStore({ fba_seller_accounts: [] });
    const out = await syncFbaSettlements({
      adminClient: sb,
      deps: {
        decryptToken: fakeDecrypt,
        refreshAccessToken: fakeRefresh,
        makeClient: () => makeSpClient([]),
        now: () => new Date("2026-05-28T00:00:00Z").getTime(),
      },
    });
    expect(out.accounts_scanned).toBe(0);
    expect(out.settlements_upserted_total).toBe(0);
    expect(out.settlements_posted_total).toBe(0);
  });

  it("upserts settlements, posts JE for Closed rows, stamps je_id, updates cursor", async () => {
    const sb = makeStore({
      fba_seller_accounts: [DEFAULT_ACCOUNT],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeSpClient([{
      FinancialEventGroupList: [
        {
          FinancialEventGroupId: "FEG_A",
          FinancialEventGroupStart: "2026-05-01T00:00:00Z",
          FinancialEventGroupEnd:   "2026-05-14T00:00:00Z",
          OriginalTotal:  { Amount: "1000.00" },
          ConvertedTotal: { Amount: "950.00" },
          ProcessingStatus: "Closed",
        },
        {
          FinancialEventGroupId: "FEG_B",
          FinancialEventGroupStart: "2026-04-15T00:00:00Z",
          FinancialEventGroupEnd:   "2026-04-28T00:00:00Z",
          OriginalTotal:  { Amount: "500.00" },
          ConvertedTotal: { Amount: "475.00" },
          ProcessingStatus: "Closed",
        },
      ],
      NextToken: null,
    }]);

    const now = new Date("2026-05-28T06:00:00Z").getTime();
    const out = await syncFbaSettlements({
      adminClient: sb,
      deps: {
        decryptToken: fakeDecrypt,
        refreshAccessToken: fakeRefresh,
        makeClient: () => stub,
        now: () => now,
      },
    });
    expect(out.accounts_scanned).toBe(1);
    expect(out.settlements_upserted_total).toBe(2);
    expect(out.settlements_posted_total).toBe(2);
    expect(out.errors).toEqual([]);
    expect(sb.calls.rpc.length).toBe(2);
    for (const s of sb.tables.fba_settlements) {
      expect(s.je_id).toBe(JE_ID);
    }
    // Cursor (last_settlement_sync_at) advanced.
    expect(sb.tables.fba_seller_accounts[0].last_settlement_sync_at).toBe(new Date(now).toISOString());
  });

  it("skips Open settlements (no JE posted)", async () => {
    const sb = makeStore({
      fba_seller_accounts: [DEFAULT_ACCOUNT],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeSpClient([{
      FinancialEventGroupList: [{
        FinancialEventGroupId: "FEG_OPEN",
        FinancialEventGroupStart: "2026-05-20T00:00:00Z",
        OriginalTotal: { Amount: "200.00" },
        ProcessingStatus: "Open",
      }],
      NextToken: null,
    }]);
    const out = await syncFbaSettlements({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, refreshAccessToken: fakeRefresh, makeClient: () => stub, now: () => Date.now() },
    });
    expect(out.settlements_upserted_total).toBe(1);
    expect(out.settlements_posted_total).toBe(0);
    expect(out.settlements_skipped_total).toBe(1);
    expect(sb.calls.rpc.length).toBe(0);
  });

  it("skips already-posted settlements (idempotent je_id)", async () => {
    const sb = makeStore({
      fba_seller_accounts: [DEFAULT_ACCOUNT],
      fba_settlements: [{
        id: SETTLEMENT,
        entity_id: ENTITY,
        fba_seller_account_id: ACCT,
        financial_event_group_id: "FEG_DUP",
        je_id: "preexisting-je",
        posted_after: "2026-05-01T00:00:00Z",
        posted_before: "2026-05-14T00:00:00Z",
        gross_amount_cents: 10000,
        fees_amount_cents: 0,
        refunds_amount_cents: 0,
        net_amount_cents: 10000,
        currency: "USD",
        processing_status: "Closed",
        raw_payload: {},
      }],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeSpClient([{
      FinancialEventGroupList: [{
        FinancialEventGroupId: "FEG_DUP",
        FinancialEventGroupStart: "2026-05-01T00:00:00Z",
        FinancialEventGroupEnd:   "2026-05-14T00:00:00Z",
        OriginalTotal: { Amount: "100.00" },
        ConvertedTotal: { Amount: "100.00" },
        ProcessingStatus: "Closed",
      }],
      NextToken: null,
    }]);
    const out = await syncFbaSettlements({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, refreshAccessToken: fakeRefresh, makeClient: () => stub, now: () => Date.now() },
    });
    expect(out.settlements_upserted_total).toBe(1);
    expect(out.settlements_posted_total).toBe(0);
    expect(out.settlements_skipped_total).toBe(1);
    expect(sb.calls.rpc.length).toBe(0);
  });

  it("walks NextToken until null", async () => {
    const sb = makeStore({
      fba_seller_accounts: [DEFAULT_ACCOUNT],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeSpClient([
      {
        FinancialEventGroupList: [{
          FinancialEventGroupId: "FEG_p1",
          FinancialEventGroupStart: "2026-04-01T00:00:00Z",
          FinancialEventGroupEnd:   "2026-04-14T00:00:00Z",
          OriginalTotal:  { Amount: "100.00" },
          ConvertedTotal: { Amount: "97.00"  },
          ProcessingStatus: "Closed",
        }],
        NextToken: "PAGE2",
      },
      {
        FinancialEventGroupList: [{
          FinancialEventGroupId: "FEG_p2",
          FinancialEventGroupStart: "2026-04-15T00:00:00Z",
          FinancialEventGroupEnd:   "2026-04-28T00:00:00Z",
          OriginalTotal:  { Amount: "200.00" },
          ConvertedTotal: { Amount: "194.00" },
          ProcessingStatus: "Closed",
        }],
        NextToken: null,
      },
    ]);
    const out = await syncFbaSettlements({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, refreshAccessToken: fakeRefresh, makeClient: () => stub, now: () => Date.now() },
    });
    expect(stub.calls.listFinancialEventGroups.length).toBe(2);
    expect(stub.calls.listFinancialEventGroups[0].postedAfter).toBeDefined();
    expect(stub.calls.listFinancialEventGroups[1].nextToken).toBe("PAGE2");
    expect(out.settlements_upserted_total).toBe(2);
  });

  it("isolates a failing account from a healthy one (multi-account)", async () => {
    const sb = makeStore({
      fba_seller_accounts: [
        { ...DEFAULT_ACCOUNT, id: ACCT,  account_name: "BAD" },
        { ...DEFAULT_ACCOUNT, id: ACCT2, account_name: "GOOD" },
      ],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    let count = 0;
    const makeClient = () => ({
      listFinancialEventGroups() {
        count += 1;
        if (count === 1) throw new Error("bad creds");
        return Promise.resolve({ FinancialEventGroupList: [], NextToken: null });
      },
    });
    const out = await syncFbaSettlements({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, refreshAccessToken: fakeRefresh, makeClient, now: () => Date.now() },
    });
    expect(out.accounts_scanned).toBe(2);
    expect(out.errors.length).toBe(1);
    expect(out.errors[0]).toMatch(/bad creds/);
    expect(out.per_account.find((a) => a.fba_seller_account_id === ACCT).error).toMatch(/bad creds/);
    expect(out.per_account.find((a) => a.fba_seller_account_id === ACCT2).error).toBe(null);
  });

  it("scopes to onlyFbaSellerAccountId when provided", async () => {
    const sb = makeStore({
      fba_seller_accounts: [
        { ...DEFAULT_ACCOUNT, id: ACCT,  account_name: "A" },
        { ...DEFAULT_ACCOUNT, id: ACCT2, account_name: "B" },
      ],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeSpClient([{ FinancialEventGroupList: [], NextToken: null }]);
    const out = await syncFbaSettlements({
      adminClient: sb,
      onlyFbaSellerAccountId: ACCT2,
      deps: { decryptToken: fakeDecrypt, refreshAccessToken: fakeRefresh, makeClient: () => stub, now: () => Date.now() },
    });
    expect(out.accounts_scanned).toBe(1);
    expect(out.per_account[0].fba_seller_account_id).toBe(ACCT2);
  });

  it("passes sinceOverride through to listFinancialEventGroups", async () => {
    const sb = makeStore({
      fba_seller_accounts: [DEFAULT_ACCOUNT],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeSpClient([{ FinancialEventGroupList: [], NextToken: null }]);
    await syncFbaSettlements({
      adminClient: sb,
      sinceOverride: "2026-01-15T00:00:00Z",
      deps: { decryptToken: fakeDecrypt, refreshAccessToken: fakeRefresh, makeClient: () => stub, now: () => Date.now() },
    });
    expect(stub.calls.listFinancialEventGroups[0].postedAfter).toBe("2026-01-15T00:00:00Z");
  });

  it("matches a bank transaction within the ±5 day window and stamps it", async () => {
    const sb = makeStore({
      fba_seller_accounts: [DEFAULT_ACCOUNT],
      gl_accounts: DEFAULT_GL_ROWS,
      bank_transactions: [{
        id: BANK_TXN,
        entity_id: ENTITY,
        status: "unmatched",
        amount_cents: "95000",
        posted_date: "2026-05-15",
      }],
    });
    const stub = makeSpClient([{
      FinancialEventGroupList: [{
        FinancialEventGroupId: "FEG_match",
        FinancialEventGroupStart: "2026-05-01T00:00:00Z",
        FinancialEventGroupEnd:   "2026-05-14T00:00:00Z",
        OriginalTotal:  { Amount: "1000.00" },
        ConvertedTotal: { Amount: "950.00" },
        ProcessingStatus: "Closed",
      }],
      NextToken: null,
    }]);
    const out = await syncFbaSettlements({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, refreshAccessToken: fakeRefresh, makeClient: () => stub, now: () => Date.now() },
    });
    expect(out.bank_matches_total).toBe(1);
    expect(sb.tables.fba_settlements[0].bank_transaction_id).toBe(BANK_TXN);
    expect(sb.tables.bank_transactions[0].status).toBe("matched");
    expect(sb.tables.bank_transactions[0].je_id).toBe(JE_ID);
  });

  it("posts JE without bank match when no bank_transactions row hits", async () => {
    const sb = makeStore({
      fba_seller_accounts: [DEFAULT_ACCOUNT],
      gl_accounts: DEFAULT_GL_ROWS,
      bank_transactions: [],
    });
    const stub = makeSpClient([{
      FinancialEventGroupList: [{
        FinancialEventGroupId: "FEG_nomatch",
        FinancialEventGroupStart: "2026-05-01T00:00:00Z",
        FinancialEventGroupEnd:   "2026-05-14T00:00:00Z",
        OriginalTotal:  { Amount: "1000.00" },
        ConvertedTotal: { Amount: "950.00" },
        ProcessingStatus: "Closed",
      }],
      NextToken: null,
    }]);
    const out = await syncFbaSettlements({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, refreshAccessToken: fakeRefresh, makeClient: () => stub, now: () => Date.now() },
    });
    expect(out.settlements_posted_total).toBe(1);
    expect(out.bank_matches_total).toBe(0);
    expect(sb.tables.fba_settlements[0].bank_transaction_id).toBeUndefined();
  });

  it("does not halt the page walk on a single RPC error", async () => {
    const sb = makeStore({
      fba_seller_accounts: [DEFAULT_ACCOUNT],
      gl_accounts: DEFAULT_GL_ROWS,
    }, { rpcError: { message: "intentional test error" } });
    const stub = makeSpClient([{
      FinancialEventGroupList: [
        {
          FinancialEventGroupId: "FEG_a",
          FinancialEventGroupStart: "2026-04-01T00:00:00Z",
          FinancialEventGroupEnd:   "2026-04-14T00:00:00Z",
          OriginalTotal:  { Amount: "100.00" },
          ConvertedTotal: { Amount: "97.00" },
          ProcessingStatus: "Closed",
        },
        {
          FinancialEventGroupId: "FEG_b",
          FinancialEventGroupStart: "2026-04-15T00:00:00Z",
          FinancialEventGroupEnd:   "2026-04-28T00:00:00Z",
          OriginalTotal:  { Amount: "200.00" },
          ConvertedTotal: { Amount: "194.00" },
          ProcessingStatus: "Closed",
        },
      ],
      NextToken: null,
    }]);
    const out = await syncFbaSettlements({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, refreshAccessToken: fakeRefresh, makeClient: () => stub, now: () => Date.now() },
    });
    expect(out.settlements_upserted_total).toBe(2);
    expect(out.settlements_posted_total).toBe(0);
    expect(out.per_account[0].error).toMatch(/intentional test error/);
  });

  it("posts a multi-line JE when payload reports storage + sponsored ads fees", async () => {
    const sb = makeStore({
      fba_seller_accounts: [DEFAULT_ACCOUNT],
      gl_accounts: DEFAULT_GL_ROWS,
    });
    const stub = makeSpClient([{
      FinancialEventGroupList: [{
        FinancialEventGroupId: "FEG_fees",
        FinancialEventGroupStart: "2026-05-01T00:00:00Z",
        FinancialEventGroupEnd:   "2026-05-14T00:00:00Z",
        OriginalTotal:  { Amount: "1000.00" },
        ConvertedTotal: { Amount: "950.00" },
        ProcessingStatus: "Closed",
        sponsored_ads_cents: 500,
        storage_fees_cents: 200,
      }],
      NextToken: null,
    }]);
    const out = await syncFbaSettlements({
      adminClient: sb,
      deps: { decryptToken: fakeDecrypt, refreshAccessToken: fakeRefresh, makeClient: () => stub, now: () => Date.now() },
    });
    expect(out.settlements_posted_total).toBe(1);
    const payload = sb.calls.rpc[0].args.payload;
    // 2 base + 2 sponsored + 2 storage = 6 lines
    expect(payload.lines.length).toBe(6);
  });
});

// ──────────────────────────────────────────────────────────────────────
// computeClearingVariance
// ──────────────────────────────────────────────────────────────────────

describe("computeClearingVariance", () => {
  it("returns null when posted_after / posted_before missing", async () => {
    const sb = makeStore({});
    expect(await computeClearingVariance(
      sb, DEFAULT_ACCOUNT,
      { ...makeSettlement(), posted_after: null },
    )).toBe(null);
  });

  it("sums fees across all in-window order items", async () => {
    const sb = makeStore({
      fba_orders: [{
        id: "o1",
        fba_seller_account_id: ACCT,
        purchase_date: "2026-05-05T00:00:00Z",
      }],
      fba_order_items: [
        { fba_order_id: "o1", fulfillment_fee_cents: 100, referral_fee_cents: 200 },
        { fba_order_id: "o1", fulfillment_fee_cents: 50,  referral_fee_cents: 75  },
      ],
    });
    const variance = await computeClearingVariance(sb, DEFAULT_ACCOUNT, makeSettlement({
      net_amount_cents: 9000,
      gross_amount_cents: 9425,
    }));
    expect(variance.ar_clearing_cents).toBe(425n);
    expect(variance.net_amount_cents).toBe(9000n);
    expect(variance.diff_cents).toBe(425n - 9000n);
  });
});
