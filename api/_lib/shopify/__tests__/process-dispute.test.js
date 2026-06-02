// Tests for Tangerine P11-8 Shopify dispute processing service.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  processShopifyDispute,
  buildDisputeRow,
  buildChargebackJePayload,
  buildCaseBody,
  resolveDisputeGlAccounts,
  nextCaseNumber,
  toBigInt,
  centsToDecimal,
  dollarsToCents,
} from "../process-dispute.js";

const STORE_UUID   = "11111111-1111-1111-1111-111111111111";
const ENTITY_UUID  = "22222222-2222-2222-2222-222222222222";
const ORDER_UUID   = "33333333-3333-3333-3333-333333333333";
const CUSTOMER_UUID = "44444444-4444-4444-4444-444444444444";
const CASE_UUID    = "55555555-5555-5555-5555-555555555555";
const JE_UUID      = "66666666-6666-6666-6666-666666666666";
const DISPUTE_UUID = "77777777-7777-7777-7777-777777777777";
const CHARGEBACK_ACC = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BANK_ACC       = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function samplePayload() {
  return {
    id: 90001,
    order_id: 5001,
    type: "chargeback",
    amount: "129.99",
    currency: "USD",
    reason: "fraudulent",
    status: "needs_response",
    evidence_due_by: "2026-06-10T00:00:00Z",
  };
}

/**
 * Build a chainable Supabase mock. Captures inserts/rpcs per-table.
 *
 * Options:
 *  - store              shopify_stores row or null
 *  - parentOrder        shopify_orders row or null
 *  - existingDispute    shopify_disputes row or null (dedup hit)
 *  - accounts           { '6610': id, '1100': id } map for gl_accounts.in()
 *  - rpcReturn          gl_post_journal_entry RPC return value (default JE_UUID)
 *  - rpcError           gl_post_journal_entry RPC error
 *  - caseInsertReturn   cases insert single() return
 *  - caseInsertError    cases insert single() error
 *  - disputeInsertReturn
 *  - disputeInsertError
 *  - existingCaseNumbers list of existing case_number rows for nextCaseNumber
 */
function makeSupabase({
  store = { id: STORE_UUID, entity_id: ENTITY_UUID },
  parentOrder = { id: ORDER_UUID, customer_id: CUSTOMER_UUID },
  existingDispute = null,
  accounts = { "6610": CHARGEBACK_ACC, "1100": BANK_ACC },
  rpcReturn = JE_UUID,
  rpcError = null,
  caseInsertReturn = { id: CASE_UUID },
  caseInsertError = null,
  disputeInsertReturn = { id: DISPUTE_UUID },
  disputeInsertError = null,
  existingCaseNumbers = [],
} = {}) {
  const calls = {
    rpcCalls: [],
    caseInserts: [],
    disputeInserts: [],
    glAccountIn: [],
  };

  return {
    __calls: calls,
    from(table) {
      if (table === "shopify_stores") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: store, error: null }),
            }),
          }),
        };
      }
      if (table === "shopify_orders") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: parentOrder, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "shopify_disputes") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: existingDispute, error: null }),
              }),
            }),
          }),
          insert: (row) => {
            calls.disputeInserts.push(row);
            return {
              select: () => ({
                single: async () => ({
                  data: disputeInsertError ? null : disputeInsertReturn,
                  error: disputeInsertError,
                }),
              }),
            };
          },
        };
      }
      if (table === "gl_accounts") {
        return {
          select: () => ({
            eq: () => ({
              in: (col, codes) => {
                calls.glAccountIn.push({ col, codes });
                const data = codes
                  .filter((c) => accounts[c])
                  .map((c) => ({ id: accounts[c], code: c }));
                return Promise.resolve({ data, error: null });
              },
            }),
          }),
        };
      }
      if (table === "cases") {
        return {
          select: () => ({
            eq: () => ({
              like: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: existingCaseNumbers, error: null }),
                }),
              }),
            }),
          }),
          insert: (row) => {
            calls.caseInserts.push(row);
            return {
              select: () => ({
                single: async () => ({
                  data: caseInsertError ? null : caseInsertReturn,
                  error: caseInsertError,
                }),
              }),
            };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc(name, params) {
      calls.rpcCalls.push({ name, params });
      return Promise.resolve({ data: rpcReturn, error: rpcError });
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────

describe("toBigInt", () => {
  it("coerces null/undefined/empty to 0n", () => {
    expect(toBigInt(null)).toBe(0n);
    expect(toBigInt(undefined)).toBe(0n);
    expect(toBigInt("")).toBe(0n);
  });
  it("passes through bigint", () => {
    expect(toBigInt(42n)).toBe(42n);
  });
  it("converts safe-integer number", () => {
    expect(toBigInt(12999)).toBe(12999n);
  });
  it("converts integer-cents string", () => {
    expect(toBigInt("12999")).toBe(12999n);
    expect(toBigInt("-500")).toBe(-500n);
  });
  it("throws on non-integer number", () => {
    expect(() => toBigInt(1.5)).toThrow();
  });
  it("throws on non-numeric string", () => {
    expect(() => toBigInt("abc")).toThrow();
  });
});

describe("centsToDecimal", () => {
  it("formats positive cents", () => {
    expect(centsToDecimal(12999n)).toBe("129.99");
    expect(centsToDecimal(1n)).toBe("0.01");
    expect(centsToDecimal(100n)).toBe("1.00");
  });
  it("formats negative cents", () => {
    expect(centsToDecimal(-12999n)).toBe("-129.99");
  });
  it("accepts coercible inputs", () => {
    expect(centsToDecimal("12999")).toBe("129.99");
    expect(centsToDecimal(12999)).toBe("129.99");
  });
});

describe("dollarsToCents", () => {
  it("rounds string dollars", () => {
    expect(dollarsToCents("12.99")).toBe(1299);
    expect(dollarsToCents("0.01")).toBe(1);
  });
  it("returns 0 for null/empty/non-numeric", () => {
    expect(dollarsToCents(null)).toBe(0);
    expect(dollarsToCents("")).toBe(0);
    expect(dollarsToCents("abc")).toBe(0);
  });
});

describe("buildDisputeRow", () => {
  it("maps a typical payload onto the shopify_disputes shape", () => {
    const row = buildDisputeRow({
      payload: samplePayload(),
      store: { id: STORE_UUID, entity_id: ENTITY_UUID },
      parentOrderId: ORDER_UUID,
    });
    expect(row.entity_id).toBe(ENTITY_UUID);
    expect(row.shopify_store_id).toBe(STORE_UUID);
    expect(row.shopify_order_id).toBe(ORDER_UUID);
    expect(row.shopify_dispute_id).toBe("90001");
    expect(row.dispute_type).toBe("chargeback");
    expect(row.dispute_amount_cents).toBe(12999);
    expect(row.status).toBe("needs_response");
    expect(row.reason).toBe("fraudulent");
    expect(row.evidence_due_by).toBe("2026-06-10T00:00:00Z");
    expect(row.raw_payload).toEqual(samplePayload());
  });

  it("defaults dispute_type to 'chargeback' when missing", () => {
    const p = samplePayload();
    delete p.type;
    const row = buildDisputeRow({ payload: p, store: { id: STORE_UUID, entity_id: ENTITY_UUID } });
    expect(row.dispute_type).toBe("chargeback");
  });

  it("allows parent_order_id to be null", () => {
    const row = buildDisputeRow({
      payload: samplePayload(),
      store: { id: STORE_UUID, entity_id: ENTITY_UUID },
      parentOrderId: null,
    });
    expect(row.shopify_order_id).toBe(null);
  });
});

describe("buildChargebackJePayload", () => {
  it("builds a balanced DR 6610 / CR 1100 JE", () => {
    const payload = buildChargebackJePayload({
      disputeRow: {
        entity_id: ENTITY_UUID,
        shopify_dispute_id: "90001",
        dispute_amount_cents: 12999,
      },
      accounts: { chargebackId: CHARGEBACK_ACC, bankId: BANK_ACC },
    });
    expect(payload.entity_id).toBe(ENTITY_UUID);
    expect(payload.journal_type).toBe("chargeback");
    expect(payload.source_module).toBe("shopify");
    expect(payload.source_table).toBe("shopify_disputes");
    expect(payload.lines).toHaveLength(2);
    expect(payload.lines[0].account_id).toBe(CHARGEBACK_ACC);
    expect(payload.lines[0].debit).toBe("129.99");
    expect(payload.lines[0].credit).toBe("0");
    expect(payload.lines[1].account_id).toBe(BANK_ACC);
    expect(payload.lines[1].debit).toBe("0");
    expect(payload.lines[1].credit).toBe("129.99");
  });

  it("throws when dispute_amount_cents is zero or negative", () => {
    expect(() =>
      buildChargebackJePayload({
        disputeRow: { entity_id: ENTITY_UUID, shopify_dispute_id: "x", dispute_amount_cents: 0 },
        accounts: { chargebackId: CHARGEBACK_ACC, bankId: BANK_ACC },
      }),
    ).toThrow(/must be > 0/);
  });

  it("throws when 6610 chargeback account missing", () => {
    expect(() =>
      buildChargebackJePayload({
        disputeRow: { entity_id: ENTITY_UUID, shopify_dispute_id: "x", dispute_amount_cents: 100 },
        accounts: { chargebackId: null, bankId: BANK_ACC },
      }),
    ).toThrow(/6610/);
  });

  it("throws when 1100 bank account missing", () => {
    expect(() =>
      buildChargebackJePayload({
        disputeRow: { entity_id: ENTITY_UUID, shopify_dispute_id: "x", dispute_amount_cents: 100 },
        accounts: { chargebackId: CHARGEBACK_ACC, bankId: null },
      }),
    ).toThrow(/1100/);
  });
});

describe("buildCaseBody", () => {
  it("produces a high-severity open case with chargeback subject", () => {
    const disputeRow = {
      shopify_dispute_id: "90001",
      dispute_type: "chargeback",
      dispute_amount_cents: 12999,
      reason: "fraudulent",
      evidence_due_by: "2026-06-10T00:00:00Z",
    };
    const body = buildCaseBody({ disputeRow, customerId: CUSTOMER_UUID });
    expect(body.subject).toBe("Shopify chargeback #90001");
    expect(body.status).toBe("open");
    expect(body.severity).toBe("high");
    expect(body.customer_id).toBe(CUSTOMER_UUID);
    expect(body.body).toMatch(/Type: chargeback/);
    expect(body.body).toMatch(/Amount: 129\.99/);
    expect(body.body).toMatch(/Reason: fraudulent/);
    expect(body.body).toMatch(/Evidence due by: 2026-06-10T00:00:00Z/);
  });

  it("omits customer_id when null", () => {
    const body = buildCaseBody({
      disputeRow: { shopify_dispute_id: "1", dispute_type: "inquiry", dispute_amount_cents: 100 },
      customerId: null,
    });
    expect(body.customer_id).toBeUndefined();
  });
});

describe("resolveDisputeGlAccounts", () => {
  it("returns {chargebackId, bankId} keyed by code", async () => {
    const admin = makeSupabase();
    const out = await resolveDisputeGlAccounts(admin, ENTITY_UUID);
    expect(out.chargebackId).toBe(CHARGEBACK_ACC);
    expect(out.bankId).toBe(BANK_ACC);
  });

  it("returns nulls when codes not found", async () => {
    const admin = makeSupabase({ accounts: {} });
    const out = await resolveDisputeGlAccounts(admin, ENTITY_UUID);
    expect(out.chargebackId).toBe(null);
    expect(out.bankId).toBe(null);
  });
});

describe("nextCaseNumber", () => {
  it("starts at 00001 when no rows exist", async () => {
    const admin = makeSupabase({ existingCaseNumbers: [] });
    const cn = await nextCaseNumber(admin, ENTITY_UUID, 2026);
    expect(cn).toBe("CASE-2026-00001");
  });

  it("increments past the highest existing case_number", async () => {
    const admin = makeSupabase({
      existingCaseNumbers: [{ case_number: "CASE-2026-00042" }],
    });
    const cn = await nextCaseNumber(admin, ENTITY_UUID, 2026);
    expect(cn).toBe("CASE-2026-00043");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Integration — processShopifyDispute end-to-end
// ────────────────────────────────────────────────────────────────────────

describe("processShopifyDispute", () => {
  it("opens case + posts JE + inserts dispute row end-to-end", async () => {
    const admin = makeSupabase();
    const result = await processShopifyDispute({
      payload: samplePayload(),
      shopDomain: "rof.myshopify.com",
      adminClient: admin,
    });
    expect(result.status).toBe("processed");
    expect(result.dispute_id).toBe(DISPUTE_UUID);
    expect(result.case_id).toBe(CASE_UUID);
    expect(result.je_id).toBe(JE_UUID);

    // RPC was called with the chargeback JE payload.
    expect(admin.__calls.rpcCalls).toHaveLength(1);
    expect(admin.__calls.rpcCalls[0].name).toBe("gl_post_journal_entry");
    const jePayload = admin.__calls.rpcCalls[0].params.payload;
    expect(jePayload.lines[0].debit).toBe("129.99");
    expect(jePayload.lines[1].credit).toBe("129.99");

    // Case was created with the right subject + customer_id.
    expect(admin.__calls.caseInserts).toHaveLength(1);
    expect(admin.__calls.caseInserts[0].subject).toBe("Shopify chargeback #90001");
    expect(admin.__calls.caseInserts[0].customer_id).toBe(CUSTOMER_UUID);

    // Dispute row stamped with case_id + je_id.
    expect(admin.__calls.disputeInserts).toHaveLength(1);
    expect(admin.__calls.disputeInserts[0].case_id).toBe(CASE_UUID);
    expect(admin.__calls.disputeInserts[0].je_id).toBe(JE_UUID);
  });

  it("returns ignored when shop_domain unknown", async () => {
    const admin = makeSupabase({ store: null });
    const result = await processShopifyDispute({
      payload: samplePayload(),
      shopDomain: "ghost.myshopify.com",
      adminClient: admin,
    });
    expect(result.status).toBe("ignored");
    expect(result.reason).toBe("unknown_shop");
    expect(admin.__calls.rpcCalls).toHaveLength(0);
    expect(admin.__calls.caseInserts).toHaveLength(0);
    expect(admin.__calls.disputeInserts).toHaveLength(0);
  });

  it("short-circuits when dispute already processed (dedup)", async () => {
    const admin = makeSupabase({
      existingDispute: { id: "old-dispute-id", shopify_dispute_id: "90001" },
    });
    const result = await processShopifyDispute({
      payload: samplePayload(),
      shopDomain: "rof.myshopify.com",
      adminClient: admin,
    });
    expect(result.status).toBe("already_processed");
    expect(result.dispute_id).toBe("old-dispute-id");
    expect(admin.__calls.rpcCalls).toHaveLength(0);
    expect(admin.__calls.caseInserts).toHaveLength(0);
    expect(admin.__calls.disputeInserts).toHaveLength(0);
  });

  it("works when there is no parent shopify_order (order_id missing)", async () => {
    const admin = makeSupabase({ parentOrder: null });
    const payload = samplePayload();
    delete payload.order_id;
    const result = await processShopifyDispute({
      payload,
      shopDomain: "rof.myshopify.com",
      adminClient: admin,
    });
    expect(result.status).toBe("processed");
    expect(admin.__calls.disputeInserts[0].shopify_order_id).toBe(null);
    // No customer linkage either.
    expect(admin.__calls.caseInserts[0].customer_id).toBe(null);
  });

  it("throws gl_accounts_missing when 6610 is not seeded", async () => {
    const admin = makeSupabase({ accounts: { "1100": BANK_ACC } });
    await expect(
      processShopifyDispute({
        payload: samplePayload(),
        shopDomain: "rof.myshopify.com",
        adminClient: admin,
      }),
    ).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("throws gl_accounts_missing when 1100 is not seeded", async () => {
    const admin = makeSupabase({ accounts: { "6610": CHARGEBACK_ACC } });
    await expect(
      processShopifyDispute({
        payload: samplePayload(),
        shopDomain: "rof.myshopify.com",
        adminClient: admin,
      }),
    ).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("surfaces rpc_failed when gl_post_journal_entry RPC errors", async () => {
    const admin = makeSupabase({ rpcError: { message: "RPC went boom" } });
    await expect(
      processShopifyDispute({
        payload: samplePayload(),
        shopDomain: "rof.myshopify.com",
        adminClient: admin,
      }),
    ).rejects.toMatchObject({ code: "rpc_failed" });
  });

  it("surfaces case_insert_failed when cases insert fails after JE", async () => {
    const admin = makeSupabase({ caseInsertError: { message: "cases denied" } });
    await expect(
      processShopifyDispute({
        payload: samplePayload(),
        shopDomain: "rof.myshopify.com",
        adminClient: admin,
      }),
    ).rejects.toMatchObject({ code: "case_insert_failed", je_id: JE_UUID });
  });

  it("races to already_processed when dispute insert hits a duplicate", async () => {
    let lookups = 0;
    const admin = {
      __calls: { rpcCalls: [], caseInserts: [], disputeInserts: [], glAccountIn: [] },
      from(table) {
        if (table === "shopify_stores") {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: STORE_UUID, entity_id: ENTITY_UUID }, error: null }) }) }) };
        }
        if (table === "shopify_orders") {
          return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: ORDER_UUID, customer_id: CUSTOMER_UUID }, error: null }) }) }) }) };
        }
        if (table === "shopify_disputes") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => {
                    lookups += 1;
                    if (lookups === 1) return { data: null, error: null };
                    return { data: { id: "race-winner", shopify_dispute_id: "90001" }, error: null };
                  },
                }),
              }),
            }),
            insert: (row) => {
              this.__calls.disputeInserts.push(row);
              return { select: () => ({ single: async () => ({ data: null, error: { message: "duplicate key" } }) }) };
            },
          };
        }
        if (table === "gl_accounts") {
          return { select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: [{ id: CHARGEBACK_ACC, code: "6610" }, { id: BANK_ACC, code: "1100" }], error: null }) }) }) };
        }
        if (table === "cases") {
          return {
            select: () => ({ eq: () => ({ like: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) }) }),
            insert: (row) => {
              this.__calls.caseInserts.push(row);
              return { select: () => ({ single: async () => ({ data: { id: CASE_UUID }, error: null }) }) };
            },
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
      rpc(name, params) {
        this.__calls.rpcCalls.push({ name, params });
        return Promise.resolve({ data: JE_UUID, error: null });
      },
    };
    // Bind makers' `this` to admin so __calls is accessible.
    const result = await processShopifyDispute({
      payload: samplePayload(),
      shopDomain: "rof.myshopify.com",
      adminClient: admin,
    });
    expect(result.status).toBe("already_processed");
    expect(result.dispute_id).toBe("race-winner");
  });

  it("throws shopify_disputes_insert_failed when insert fails without race winner", async () => {
    const admin = makeSupabase({
      disputeInsertError: { message: "not-null violation" },
    });
    await expect(
      processShopifyDispute({
        payload: samplePayload(),
        shopDomain: "rof.myshopify.com",
        adminClient: admin,
      }),
    ).rejects.toMatchObject({
      code: "shopify_disputes_insert_failed",
      je_id: JE_UUID,
      case_id: CASE_UUID,
    });
  });

  it("requires a payload", async () => {
    const admin = makeSupabase();
    await expect(
      processShopifyDispute({ payload: null, shopDomain: "rof.myshopify.com", adminClient: admin }),
    ).rejects.toThrow(/payload/);
  });

  it("requires shopDomain", async () => {
    const admin = makeSupabase();
    await expect(
      processShopifyDispute({ payload: samplePayload(), shopDomain: "", adminClient: admin }),
    ).rejects.toThrow(/shopDomain/);
  });

  it("requires adminClient", async () => {
    await expect(
      processShopifyDispute({ payload: samplePayload(), shopDomain: "x", adminClient: null }),
    ).rejects.toThrow(/adminClient/);
  });

  it("uses 'chargeback' as journal_type", async () => {
    const admin = makeSupabase();
    await processShopifyDispute({
      payload: samplePayload(),
      shopDomain: "rof.myshopify.com",
      adminClient: admin,
    });
    expect(admin.__calls.rpcCalls[0].params.payload.journal_type).toBe("chargeback");
  });

  it("stamps source='shopify' on the disputes insert (via default — row not present means DB default takes over)", async () => {
    const admin = makeSupabase();
    await processShopifyDispute({
      payload: samplePayload(),
      shopDomain: "rof.myshopify.com",
      adminClient: admin,
    });
    // We do not include source explicitly — the DB DEFAULT 'shopify' applies.
    const row = admin.__calls.disputeInserts[0];
    expect(row.source).toBeUndefined();
  });
});
