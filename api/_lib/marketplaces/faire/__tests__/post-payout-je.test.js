// Tangerine P12c-3 — tests for the Faire payout JE posting service.
//
// Coverage:
//   - BigInt cents + shiftDate helpers
//   - buildJournalEntryPayload: 2-line DR 1100 / CR 1115 balance
//   - resolveGlAccounts: bank_accounts priority, gl_accounts code='1100'
//     fallback, missing-code handling
//   - findMatchingBankTransaction: amount + ±5 day window match
//   - postFairePayoutJe end-to-end:
//       * idempotent already_posted
//       * not_found
//       * gl_accounts_missing
//       * happy path
//       * RPC error
//       * faire_payouts_update_failed
//       * auto-match stamps bank_transaction_id

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  postFairePayoutJe,
  buildJournalEntryPayload,
  resolveGlAccounts,
  findMatchingBankTransaction,
  toBigInt,
  centsToDecimal,
  shiftDate,
} from "../post-payout-je.js";

const ENTITY     = "11111111-1111-1111-1111-111111111111";
const PAYOUT     = "22222222-2222-2222-2222-222222222222";
const SHOP       = "33333333-3333-3333-3333-333333333333";
const BANK_ACCT  = "55555555-5555-5555-5555-555555555555";
const RECV_ACCT  = "66666666-6666-6666-6666-666666666666";
const BANK_GL    = "77777777-7777-7777-7777-777777777777";
const BANK_TXN   = "88888888-8888-8888-8888-888888888888";
const JE_ID      = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function makePayout(overrides = {}) {
  return {
    id: PAYOUT,
    entity_id: ENTITY,
    faire_shop_id: SHOP,
    faire_payout_id: "FAIRE-PAY-9001",
    payout_date: "2026-05-28",
    period_start: "2026-04-28",
    period_end: "2026-05-27",
    gross_amount_cents: 100000,
    commission_amount_cents: 15000,
    refunds_amount_cents: 0,
    net_amount_cents: 85000,
    currency: "USD",
    bank_transaction_id: null,
    je_id: null,
    ...overrides,
  };
}

function makeAccounts(overrides = {}) {
  return {
    bankId: BANK_GL,
    receivableId: RECV_ACCT,
    bankAccountId: BANK_ACCT,
    ...overrides,
  };
}

function makeSupabaseMock({
  payout = makePayout(),
  glAcctRows = [
    { code: "1115", id: RECV_ACCT },
    { code: "1100", id: BANK_GL },
  ],
  bankAcctRows = [
    { id: BANK_ACCT, gl_account_id: BANK_GL, is_active: true, created_at: "2026-01-01" },
  ],
  bankTxnRows = [],
  rpcResult = JE_ID,
  rpcError = null,
  payoutUpdateError = null,
} = {}) {
  const calls = {
    rpc: [],
    payoutUpdate: [],
    bankTxnSearch: [],
  };

  const sb = {
    from(table) {
      if (table === "faire_payouts") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({ data: payout, error: null }),
                };
              },
            };
          },
          update(patch) {
            return {
              eq: async (col, val) => {
                calls.payoutUpdate.push({ patch, col, val });
                return { error: payoutUpdateError };
              },
            };
          },
        };
      }
      if (table === "gl_accounts") {
        return {
          select: () => ({
            eq: () => ({
              in: () => Promise.resolve({ data: glAcctRows, error: null }),
            }),
          }),
        };
      }
      if (table === "bank_accounts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => Promise.resolve({ data: bankAcctRows, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "bank_transactions") {
        return {
          select: () => {
            const builder = {
              eq: () => builder,
              gte: () => builder,
              lte: () => builder,
              order: () => builder,
              limit: () => {
                calls.bankTxnSearch.push(true);
                return Promise.resolve({ data: bankTxnRows, error: null });
              },
            };
            return builder;
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc: vi.fn(async (name, args) => {
      calls.rpc.push({ name, args });
      return { data: rpcResult, error: rpcError };
    }),
  };
  return { sb, calls };
}

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────

describe("toBigInt + centsToDecimal", () => {
  it("toBigInt handles strings + numbers + null", () => {
    expect(toBigInt(null)).toBe(0n);
    expect(toBigInt(85000)).toBe(85000n);
    expect(toBigInt("85000")).toBe(85000n);
  });
  it("centsToDecimal formats with 2 fraction digits", () => {
    expect(centsToDecimal(85000n)).toBe("850.00");
    expect(centsToDecimal(0n)).toBe("0.00");
  });
});

describe("shiftDate", () => {
  it("subtracts days", () => {
    expect(shiftDate("2026-05-28", -5)).toBe("2026-05-23");
  });
  it("adds days", () => {
    expect(shiftDate("2026-05-28", 5)).toBe("2026-06-02");
  });
  it("accepts ISO timestamp", () => {
    expect(shiftDate("2026-05-28T14:00:00Z", 0)).toBe("2026-05-28");
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildJournalEntryPayload
// ──────────────────────────────────────────────────────────────────────

describe("buildJournalEntryPayload", () => {
  it("builds a balanced 2-line JE (DR 1100 / CR 1115)", () => {
    const payload = buildJournalEntryPayload({
      payout: makePayout(),
      accounts: makeAccounts(),
    });
    expect(payload.lines).toHaveLength(2);
    expect(payload.lines[0]).toMatchObject({
      line_number: 1,
      account_id: BANK_GL,
      debit: "850.00",
      credit: "0",
    });
    expect(payload.lines[1]).toMatchObject({
      line_number: 2,
      account_id: RECV_ACCT,
      debit: "0",
      credit: "850.00",
    });
  });

  it("balances debits and credits", () => {
    const payload = buildJournalEntryPayload({
      payout: makePayout(),
      accounts: makeAccounts(),
    });
    let dr = 0n, cr = 0n;
    for (const ln of payload.lines) {
      dr += BigInt(ln.debit.replace(".", ""));
      cr += BigInt(ln.credit.replace(".", ""));
    }
    expect(dr).toBe(cr);
  });

  it("throws when net_amount_cents <= 0", () => {
    expect(() => buildJournalEntryPayload({
      payout: makePayout({ net_amount_cents: 0 }),
      accounts: makeAccounts(),
    })).toThrow(/positive/);
    expect(() => buildJournalEntryPayload({
      payout: makePayout({ net_amount_cents: -1 }),
      accounts: makeAccounts(),
    })).toThrow(/positive/);
  });

  it("sets source_module='faire' + journal_type='bank_deposit'", () => {
    const payload = buildJournalEntryPayload({
      payout: makePayout(),
      accounts: makeAccounts(),
    });
    expect(payload.source_module).toBe("faire");
    expect(payload.source_table).toBe("faire_payouts");
    expect(payload.source_id).toBe(PAYOUT);
    expect(payload.journal_type).toBe("bank_deposit");
    expect(payload.basis).toBe("ACCRUAL");
  });

  it("derives posting_date from payout_date", () => {
    const payload = buildJournalEntryPayload({
      payout: makePayout({ payout_date: "2026-05-28" }),
      accounts: makeAccounts(),
    });
    expect(payload.posting_date).toBe("2026-05-28");
  });

  it("entity_id propagates", () => {
    const payload = buildJournalEntryPayload({
      payout: makePayout(),
      accounts: makeAccounts(),
    });
    expect(payload.entity_id).toBe(ENTITY);
  });

  it("description encodes faire_payout_id", () => {
    const payload = buildJournalEntryPayload({
      payout: makePayout({ faire_payout_id: "PAY-42" }),
      accounts: makeAccounts(),
    });
    expect(payload.description).toContain("PAY-42");
  });
});

// ──────────────────────────────────────────────────────────────────────
// resolveGlAccounts
// ──────────────────────────────────────────────────────────────────────

describe("resolveGlAccounts", () => {
  it("prefers bank_accounts.gl_account_id over 1100", async () => {
    const sb = makeSupabaseMock().sb;
    const out = await resolveGlAccounts(sb, ENTITY);
    expect(out.receivableId).toBe(RECV_ACCT);
    expect(out.bankId).toBe(BANK_GL);
    expect(out.bankAccountId).toBe(BANK_ACCT);
  });

  it("falls back to 1100 when no bank_accounts row exists", async () => {
    const { sb } = makeSupabaseMock({ bankAcctRows: [] });
    const out = await resolveGlAccounts(sb, ENTITY);
    expect(out.bankId).toBe(BANK_GL); // 1100 fallback
    expect(out.bankAccountId).toBeNull();
  });

  it("returns null for missing codes", async () => {
    const { sb } = makeSupabaseMock({
      glAcctRows: [],
      bankAcctRows: [],
    });
    const out = await resolveGlAccounts(sb, ENTITY);
    expect(out.receivableId).toBeNull();
    expect(out.bankId).toBeNull();
    expect(out.bankAccountId).toBeNull();
  });

  it("uses first active bank_account ordered by created_at", async () => {
    const { sb } = makeSupabaseMock({
      bankAcctRows: [
        { id: "first-bank", gl_account_id: "first-gl", is_active: true, created_at: "2026-01-01" },
        { id: "second-bank", gl_account_id: "second-gl", is_active: true, created_at: "2026-02-01" },
      ],
    });
    const out = await resolveGlAccounts(sb, ENTITY);
    expect(out.bankId).toBe("first-gl");
    expect(out.bankAccountId).toBe("first-bank");
  });
});

// ──────────────────────────────────────────────────────────────────────
// findMatchingBankTransaction
// ──────────────────────────────────────────────────────────────────────

describe("findMatchingBankTransaction", () => {
  it("returns id when an unmatched txn matches amount + window", async () => {
    const { sb } = makeSupabaseMock({
      bankTxnRows: [
        { id: BANK_TXN, amount_cents: 85000, posted_date: "2026-05-30", status: "unmatched" },
      ],
    });
    const id = await findMatchingBankTransaction(sb, makePayout());
    expect(id).toBe(BANK_TXN);
  });

  it("returns null when no rows", async () => {
    const { sb } = makeSupabaseMock({ bankTxnRows: [] });
    const id = await findMatchingBankTransaction(sb, makePayout());
    expect(id).toBeNull();
  });

  it("returns null when net amount is zero", async () => {
    const { sb } = makeSupabaseMock();
    const id = await findMatchingBankTransaction(sb, makePayout({ net_amount_cents: 0 }));
    expect(id).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// postFairePayoutJe — end-to-end
// ──────────────────────────────────────────────────────────────────────

describe("postFairePayoutJe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid uuid", async () => {
    await expect(postFairePayoutJe({
      fairePayoutId: "not-a-uuid",
      adminClient: { from: () => ({}) },
    })).rejects.toThrow(/uuid/);
  });

  it("rejects null adminClient", async () => {
    await expect(postFairePayoutJe({
      fairePayoutId: PAYOUT,
      adminClient: null,
    })).rejects.toThrow(/Supabase/);
  });

  it("returns already_posted when je_id set", async () => {
    const { sb, calls } = makeSupabaseMock({
      payout: makePayout({ je_id: "existing-je-id" }),
    });
    const result = await postFairePayoutJe({
      fairePayoutId: PAYOUT,
      adminClient: sb,
    });
    expect(result).toEqual({ status: "already_posted", je_id: "existing-je-id" });
    expect(calls.rpc).toHaveLength(0);
  });

  it("returns not_found when row missing", async () => {
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      }),
      rpc: vi.fn(),
    };
    await expect(postFairePayoutJe({
      fairePayoutId: PAYOUT,
      adminClient: sb,
    })).rejects.toMatchObject({ code: "not_found" });
  });

  it("surfaces gl_accounts_missing when 1115 missing", async () => {
    const { sb } = makeSupabaseMock({
      glAcctRows: [{ code: "1100", id: BANK_GL }],
      bankAcctRows: [],
    });
    await expect(postFairePayoutJe({
      fairePayoutId: PAYOUT,
      adminClient: sb,
    })).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("surfaces gl_accounts_missing when no bank account resolvable", async () => {
    const { sb } = makeSupabaseMock({
      glAcctRows: [{ code: "1115", id: RECV_ACCT }],
      bankAcctRows: [],
    });
    await expect(postFairePayoutJe({
      fairePayoutId: PAYOUT,
      adminClient: sb,
    })).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("happy path: posts JE + stamps faire_payouts.je_id", async () => {
    const { sb, calls } = makeSupabaseMock();
    const result = await postFairePayoutJe({
      fairePayoutId: PAYOUT,
      adminClient: sb,
    });
    expect(result.status).toBe("posted");
    expect(result.je_id).toBe(JE_ID);
    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].name).toBe("gl_post_journal_entry");
    const stamp = calls.payoutUpdate[0];
    expect(stamp.patch.je_id).toBe(JE_ID);
  });

  it("RPC error surfaces as rpc_failed", async () => {
    const { sb } = makeSupabaseMock({
      rpcError: { message: "period locked" },
      rpcResult: null,
    });
    await expect(postFairePayoutJe({
      fairePayoutId: PAYOUT,
      adminClient: sb,
    })).rejects.toMatchObject({ code: "rpc_failed" });
  });

  it("faire_payouts update error → faire_payouts_update_failed", async () => {
    const { sb } = makeSupabaseMock({
      payoutUpdateError: { message: "rls" },
    });
    await expect(postFairePayoutJe({
      fairePayoutId: PAYOUT,
      adminClient: sb,
    })).rejects.toMatchObject({
      code: "faire_payouts_update_failed",
      je_id: JE_ID,
    });
  });

  it("auto-match stamps bank_transaction_id when amount matches", async () => {
    const { sb, calls } = makeSupabaseMock({
      bankTxnRows: [
        { id: BANK_TXN, amount_cents: 85000, posted_date: "2026-05-28", status: "unmatched" },
      ],
    });
    const result = await postFairePayoutJe({
      fairePayoutId: PAYOUT,
      adminClient: sb,
    });
    expect(result.bank_transaction_id).toBe(BANK_TXN);
    expect(calls.payoutUpdate[0].patch.bank_transaction_id).toBe(BANK_TXN);
  });

  it("does not auto-match when bank_transaction_id already set", async () => {
    const { sb, calls } = makeSupabaseMock({
      payout: makePayout({ bank_transaction_id: "pre-set-bt" }),
      bankTxnRows: [],
    });
    const result = await postFairePayoutJe({
      fairePayoutId: PAYOUT,
      adminClient: sb,
    });
    expect(result.bank_transaction_id).toBe("pre-set-bt");
    expect(calls.bankTxnSearch).toHaveLength(0);
  });

  it("balanced payload passes to RPC", async () => {
    const { sb, calls } = makeSupabaseMock();
    await postFairePayoutJe({ fairePayoutId: PAYOUT, adminClient: sb });
    const payload = calls.rpc[0].args.payload;
    let dr = 0n, cr = 0n;
    for (const ln of payload.lines) {
      dr += BigInt(ln.debit.replace(".", ""));
      cr += BigInt(ln.credit.replace(".", ""));
    }
    expect(dr).toBe(cr);
  });

  it("entity_id propagates from payout to JE payload", async () => {
    const { sb, calls } = makeSupabaseMock();
    await postFairePayoutJe({ fairePayoutId: PAYOUT, adminClient: sb });
    expect(calls.rpc[0].args.payload.entity_id).toBe(ENTITY);
  });
});
