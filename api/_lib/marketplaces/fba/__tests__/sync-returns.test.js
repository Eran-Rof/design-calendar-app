// Tangerine P12a-6 — tests for the FBA returns sync service.
//
// Coverage:
//   - toBigInt / centsToDecimal helpers
//   - computeSinceTime: null / fresh / clamped / invalid
//   - mapReturnRow: ASIN / SKU / refund amount rounding / defaults
//   - resolveGlAccounts: code map + 1201/1301/5001 fallbacks + missing → null
//   - buildRestockJePayload: balanced DR 1300 / CR 5000 + throws on missing
//   - buildWriteoffJePayload: balanced DR 6525 / CR 1300 + throws on missing
//   - buildCreditMemoJePayload: balanced DR 4000 / CR 1200 + subledger
//   - buildCreditMemoArRow: source='fba', invoice_kind='customer_credit_memo',
//     reverses_invoice_id link, JE link
//   - resolveParentOrder: lookup by amazon_order_id; null when not found
//   - resolveItemMasterId: ASIN first, then SKU, then null
//   - resolveUnitCostCents: layer first, then ip_item_master.cost_cents, then 0
//   - decryptAccountCreds: throws on missing triples
//   - processReturn:
//       * no parent order → upserts without JE
//       * Resellable → restock JE posted + inventory_layer inserted
//       * Defective → writeoff JE posted
//       * Disposed → writeoff JE posted
//       * Unknown status → no JE
//       * refund_amount_cents > 0 + parent.ar_invoice_id → credit memo
//         posted (JE + ar_invoices)
//       * refund > 0 but parent.ar_invoice_id null → no credit memo
//       * idempotency: existing je_id / ar_credit_memo_id short-circuit
//       * stamps pointers back to fba_returns
//   - syncAccountReturns:
//       * happy path: paginates, upserts, bumps last_returns_sync_at
//       * per-return errors do NOT abort loop
//       * NextToken paginates
//   - syncAllAccountsReturns:
//       * per-account error isolation
//       * empty accounts → empty result

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import {
  toBigInt,
  centsToDecimal,
  computeSinceTime,
  mapReturnRow,
  resolveGlAccounts,
  buildRestockJePayload,
  buildWriteoffJePayload,
  buildCreditMemoJePayload,
  buildCreditMemoArRow,
  resolveParentOrder,
  resolveItemMasterId,
  resolveUnitCostCents,
  decryptAccountCreds,
  processReturn,
  syncAccountReturns,
  syncAllAccountsReturns,
} from "../sync-returns.js";
import { encryptToken } from "../token-encryption.js";
import { _clearCacheForTest } from "../lwa.js";

const TEST_KEY = "1".repeat(64);

beforeAll(() => {
  process.env.FBA_TOKEN_ENC_KEY = TEST_KEY;
});

beforeEach(() => {
  _clearCacheForTest();
});

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

const ENTITY    = "11111111-1111-1111-1111-111111111111";
const ACCT      = "22222222-2222-2222-2222-222222222222";
const ORDER     = "33333333-3333-3333-3333-333333333333";
const CUSTOMER  = "44444444-4444-4444-4444-444444444444";
const AR_INV    = "55555555-5555-5555-5555-555555555555";
const RET       = "66666666-6666-6666-6666-666666666666";
const ITEM      = "77777777-7777-7777-7777-777777777777";

const INV_ACCT  = "aa111111-1111-1111-1111-111111111111";
const COGS_ACCT = "aa222222-2222-2222-2222-222222222222";
const RMV_ACCT  = "aa333333-3333-3333-3333-333333333333";
const AR_ACCT   = "aa444444-4444-4444-4444-444444444444";
const REV_ACCT  = "aa555555-5555-5555-5555-555555555555";

const JE_RESTOCK = "be111111-1111-1111-1111-111111111111";
const JE_WRITEOFF = "be222222-2222-2222-2222-222222222222";
const JE_CM = "be333333-3333-3333-3333-333333333333";
const CM_ID = "be444444-4444-4444-4444-444444444444";

function makeAccount(overrides = {}) {
  const cid = encryptToken("amzn1.application-oa2-client.x");
  const csec = encryptToken("client-secret-x");
  const ref = encryptToken("Atzr|refresh-x");
  return {
    id: ACCT,
    entity_id: ENTITY,
    region: "NA",
    marketplace_id: "ATVPDKIKX0DER",
    is_active: true,
    last_returns_sync_at: null,
    aws_role_arn: null,
    lwa_client_id_ciphertext: cid.ciphertext,
    lwa_client_id_iv: cid.iv,
    lwa_client_id_tag: cid.tag,
    lwa_client_secret_ciphertext: csec.ciphertext,
    lwa_client_secret_iv: csec.iv,
    lwa_client_secret_tag: csec.tag,
    refresh_token_ciphertext: ref.ciphertext,
    refresh_token_iv: ref.iv,
    refresh_token_tag: ref.tag,
    ...overrides,
  };
}

function makeParentOrder(overrides = {}) {
  return {
    id: ORDER,
    entity_id: ENTITY,
    amazon_order_id: "111-2222222-3333333",
    customer_id: CUSTOMER,
    ar_invoice_id: AR_INV,
    ...overrides,
  };
}

function makeAccounts(overrides = {}) {
  return {
    inventoryId: INV_ACCT,
    cogsId: COGS_ACCT,
    removalId: RMV_ACCT,
    arId: AR_ACCT,
    revenueId: REV_ACCT,
    ...overrides,
  };
}

function makeRefreshFn() {
  return async () => ({ access_token: "Atza|fake", token_type: "bearer", expires_in: 3600, cached: false });
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

describe("toBigInt", () => {
  it("returns 0n on null / empty", () => {
    expect(toBigInt(null)).toBe(0n);
    expect(toBigInt("")).toBe(0n);
  });
  it("passes bigint through", () => {
    expect(toBigInt(123n)).toBe(123n);
  });
  it("converts safe integers", () => {
    expect(toBigInt(500)).toBe(500n);
  });
  it("converts integer strings", () => {
    expect(toBigInt("750")).toBe(750n);
  });
  it("throws on float", () => {
    expect(() => toBigInt(1.5)).toThrow(/integer/);
  });
});

describe("centsToDecimal", () => {
  it("formats whole dollars", () => {
    expect(centsToDecimal(10000n)).toBe("100.00");
  });
  it("pads single-digit cents", () => {
    expect(centsToDecimal(10005n)).toBe("100.05");
  });
});

describe("computeSinceTime", () => {
  it("clamps to now - 30d when null", () => {
    const now = new Date("2026-05-30T00:00:00Z");
    expect(computeSinceTime(null, now)).toBe("2026-04-30T00:00:00.000Z");
  });
  it("returns lastSyncAt when within 30d", () => {
    const now = new Date("2026-05-30T00:00:00Z");
    expect(computeSinceTime("2026-05-25T00:00:00Z", now)).toBe("2026-05-25T00:00:00.000Z");
  });
  it("clamps to 30d ago when older", () => {
    const now = new Date("2026-05-30T00:00:00Z");
    expect(computeSinceTime("2025-01-01T00:00:00Z", now)).toBe("2026-04-30T00:00:00.000Z");
  });
  it("handles invalid input", () => {
    const now = new Date("2026-05-30T00:00:00Z");
    expect(computeSinceTime("garbage", now)).toBe("2026-04-30T00:00:00.000Z");
  });
});

// ──────────────────────────────────────────────────────────────────────
// mapReturnRow
// ──────────────────────────────────────────────────────────────────────

describe("mapReturnRow", () => {
  it("maps PascalCase SP-API payload", () => {
    const row = mapReturnRow({
      ReturnRequestId: "ret-1",
      AmazonOrderId: "111-1-1",
      ASIN: "B0XXX",
      SellerSKU: "SKU-1",
      Quantity: 2,
      Reason: "Defective",
      ReturnStatus: "Resellable",
      RefundAmount: { Amount: "12.34", CurrencyCode: "USD" },
    }, ORDER);
    expect(row.return_request_id).toBe("ret-1");
    expect(row.asin).toBe("B0XXX");
    expect(row.sku).toBe("SKU-1");
    expect(row.quantity).toBe(2);
    expect(row.return_status).toBe("Resellable");
    expect(row.refund_amount_cents).toBe(1234);
    expect(row.fba_order_id).toBe(ORDER);
  });
  it("accepts camelCase aliases", () => {
    const row = mapReturnRow({
      returnRequestId: "ret-2",
      amazonOrderId: "111-2-2",
      asin: "B0YYY",
      sellerSku: "SKU-2",
      quantity: 1,
      returnStatus: "Defective",
      refundAmount: { Amount: "0.50" },
    }, null);
    expect(row.return_request_id).toBe("ret-2");
    expect(row.refund_amount_cents).toBe(50);
    expect(row.fba_order_id).toBeNull();
  });
  it("defaults missing fields safely", () => {
    const row = mapReturnRow({ ReturnRequestId: "ret-3" }, null);
    expect(row.quantity).toBe(1);
    expect(row.refund_amount_cents).toBe(0);
    expect(row.return_status).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// resolveGlAccounts
// ──────────────────────────────────────────────────────────────────────

function makeAccountsSb(rows) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return { in: () => Promise.resolve({ data: rows, error: null }) };
            },
          };
        },
      };
    },
  };
}

describe("resolveGlAccounts", () => {
  it("maps codes to ids", async () => {
    const sb = makeAccountsSb([
      { code: "1300", id: INV_ACCT },
      { code: "5000", id: COGS_ACCT },
      { code: "6525", id: RMV_ACCT },
      { code: "1200", id: AR_ACCT },
      { code: "4000", id: REV_ACCT },
    ]);
    const out = await resolveGlAccounts(sb, ENTITY);
    expect(out).toEqual({
      inventoryId: INV_ACCT,
      cogsId: COGS_ACCT,
      removalId: RMV_ACCT,
      arId: AR_ACCT,
      revenueId: REV_ACCT,
    });
  });
  it("falls back to 1201 / 1301 / 5001", async () => {
    const sb = makeAccountsSb([
      { code: "1301", id: INV_ACCT },
      { code: "5001", id: COGS_ACCT },
      { code: "1201", id: AR_ACCT },
      { code: "4000", id: REV_ACCT },
    ]);
    const out = await resolveGlAccounts(sb, ENTITY);
    expect(out.inventoryId).toBe(INV_ACCT);
    expect(out.cogsId).toBe(COGS_ACCT);
    expect(out.arId).toBe(AR_ACCT);
    expect(out.removalId).toBeNull();
  });
  it("returns nulls when no rows", async () => {
    const sb = makeAccountsSb([]);
    const out = await resolveGlAccounts(sb, ENTITY);
    expect(out.inventoryId).toBeNull();
    expect(out.cogsId).toBeNull();
    expect(out.removalId).toBeNull();
    expect(out.arId).toBeNull();
    expect(out.revenueId).toBeNull();
  });
  it("throws on db error", async () => {
    const sb = {
      from() {
        return {
          select() {
            return {
              eq() {
                return { in: () => Promise.resolve({ data: null, error: { message: "boom" } }) };
              },
            };
          },
        };
      },
    };
    await expect(resolveGlAccounts(sb, ENTITY)).rejects.toThrow(/boom/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// JE builders
// ──────────────────────────────────────────────────────────────────────

describe("buildRestockJePayload", () => {
  it("emits balanced DR 1300 / CR 5000", () => {
    const payload = buildRestockJePayload({
      ret: { id: RET, return_request_id: "ret-1" },
      parentOrder: makeParentOrder(),
      amountCents: 5000n,
      accounts: makeAccounts(),
    });
    expect(payload.lines).toHaveLength(2);
    expect(payload.lines[0]).toMatchObject({ account_id: INV_ACCT, debit: "50.00", credit: "0" });
    expect(payload.lines[1]).toMatchObject({ account_id: COGS_ACCT, debit: "0", credit: "50.00" });
    expect(payload.journal_type).toBe("adjustment");
    expect(payload.source_module).toBe("fba");
    expect(payload.source_table).toBe("fba_returns");
    expect(payload.source_id).toBe(RET);
  });
  it("throws when amount is zero or negative", () => {
    expect(() => buildRestockJePayload({
      ret: { id: RET, return_request_id: "ret-1" },
      parentOrder: makeParentOrder(),
      amountCents: 0n,
      accounts: makeAccounts(),
    })).toThrow(/positive/);
  });
  it("throws when inventory account missing", () => {
    expect(() => buildRestockJePayload({
      ret: { id: RET, return_request_id: "ret-1" },
      parentOrder: makeParentOrder(),
      amountCents: 100n,
      accounts: makeAccounts({ inventoryId: null }),
    })).toThrow(/1300 Inventory/);
  });
  it("throws when cogs account missing", () => {
    expect(() => buildRestockJePayload({
      ret: { id: RET, return_request_id: "ret-1" },
      parentOrder: makeParentOrder(),
      amountCents: 100n,
      accounts: makeAccounts({ cogsId: null }),
    })).toThrow(/5000 COGS/);
  });
});

describe("buildWriteoffJePayload", () => {
  it("emits balanced DR 6525 / CR 1300", () => {
    const payload = buildWriteoffJePayload({
      ret: { id: RET, return_request_id: "ret-1", return_status: "Defective" },
      parentOrder: makeParentOrder(),
      amountCents: 2500n,
      accounts: makeAccounts(),
    });
    expect(payload.lines[0]).toMatchObject({ account_id: RMV_ACCT, debit: "25.00", credit: "0" });
    expect(payload.lines[1]).toMatchObject({ account_id: INV_ACCT, debit: "0", credit: "25.00" });
    expect(payload.description).toMatch(/Defective/);
  });
  it("throws when removal account missing", () => {
    expect(() => buildWriteoffJePayload({
      ret: { id: RET, return_request_id: "ret-1", return_status: "Defective" },
      parentOrder: makeParentOrder(),
      amountCents: 100n,
      accounts: makeAccounts({ removalId: null }),
    })).toThrow(/6525/);
  });
});

describe("buildCreditMemoJePayload", () => {
  it("emits balanced DR 4000 / CR 1200 with customer subledger", () => {
    const payload = buildCreditMemoJePayload({
      ret: { id: RET, return_request_id: "ret-1" },
      parentOrder: makeParentOrder(),
      refundCents: 1234n,
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    expect(payload.lines[0]).toMatchObject({ account_id: REV_ACCT, debit: "12.34", credit: "0" });
    expect(payload.lines[1]).toMatchObject({
      account_id: AR_ACCT,
      debit: "0",
      credit: "12.34",
      subledger_type: "customer",
      subledger_id: CUSTOMER,
    });
    expect(payload.journal_type).toBe("ar_credit_memo");
  });
  it("omits subledger when customer is null", () => {
    const payload = buildCreditMemoJePayload({
      ret: { id: RET, return_request_id: "ret-1" },
      parentOrder: makeParentOrder({ customer_id: null }),
      refundCents: 500n,
      accounts: makeAccounts(),
      customerId: null,
    });
    expect(payload.lines[1].subledger_type).toBeNull();
    expect(payload.lines[1].subledger_id).toBeNull();
  });
  it("throws on zero refund", () => {
    expect(() => buildCreditMemoJePayload({
      ret: { id: RET, return_request_id: "ret-1" },
      parentOrder: makeParentOrder(),
      refundCents: 0n,
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    })).toThrow(/positive/);
  });
});

describe("buildCreditMemoArRow", () => {
  it("emits source=fba customer_credit_memo with reverses_invoice_id", () => {
    const row = buildCreditMemoArRow({
      ret: { id: RET, return_request_id: "ret-1" },
      parentOrder: makeParentOrder(),
      refundCents: 1234n,
      accounts: makeAccounts(),
      customerId: CUSTOMER,
      jeId: JE_CM,
    });
    expect(row.source).toBe("fba");
    expect(row.invoice_kind).toBe("customer_credit_memo");
    expect(row.reverses_invoice_id).toBe(AR_INV);
    expect(row.accrual_je_id).toBe(JE_CM);
    expect(row.total_amount_cents).toBe("1234");
    expect(row.invoice_number).toMatch(/^FBA-CM-/);
    expect(row.gl_status).toBe("sent");
  });
});

// ──────────────────────────────────────────────────────────────────────
// resolveParentOrder / resolveItemMasterId / resolveUnitCostCents
// ──────────────────────────────────────────────────────────────────────

describe("resolveParentOrder", () => {
  it("returns null when no amazon_order_id", async () => {
    const sb = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) };
    const r = await resolveParentOrder(sb, { amazon_order_id: null }, ACCT);
    expect(r).toBeNull();
  });
  it("returns the parent order when found", async () => {
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: makeParentOrder(), error: null }) }) }),
        }),
      }),
    };
    const r = await resolveParentOrder(sb, { amazon_order_id: "111-2222222-3333333" }, ACCT);
    expect(r?.id).toBe(ORDER);
  });
});

describe("resolveItemMasterId", () => {
  it("returns null when no asin or sku", async () => {
    const sb = { from: vi.fn() };
    expect(await resolveItemMasterId(sb, { entityId: ENTITY })).toBeNull();
  });
  it("returns id when ASIN matches", async () => {
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: ITEM }, error: null }) }) }),
        }),
      }),
    };
    const r = await resolveItemMasterId(sb, { entityId: ENTITY, asin: "B0XXX" });
    expect(r).toBe(ITEM);
  });
});

describe("resolveUnitCostCents", () => {
  it("returns 0n when itemId is null", async () => {
    const sb = { from: vi.fn() };
    expect(await resolveUnitCostCents(sb, { entityId: ENTITY, itemId: null })).toBe(0n);
  });
  it("returns the layer unit_cost_cents when present", async () => {
    const sb = {
      from: (name) => {
        if (name === "inventory_layers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => ({ maybeSingle: async () => ({ data: { unit_cost_cents: 250 }, error: null }) }),
                  }),
                }),
              }),
            }),
          };
        }
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      },
    };
    expect(await resolveUnitCostCents(sb, { entityId: ENTITY, itemId: ITEM })).toBe(250n);
  });
  it("falls back to ip_item_master.cost_cents when no layer", async () => {
    const sb = {
      from: (name) => {
        if (name === "inventory_layers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
                  }),
                }),
              }),
            }),
          };
        }
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { cost_cents: 99 }, error: null }) }) }) };
      },
    };
    expect(await resolveUnitCostCents(sb, { entityId: ENTITY, itemId: ITEM })).toBe(99n);
  });
});

// ──────────────────────────────────────────────────────────────────────
// decryptAccountCreds
// ──────────────────────────────────────────────────────────────────────

describe("decryptAccountCreds", () => {
  it("throws when client_id triple is missing", () => {
    expect(() => decryptAccountCreds({})).toThrow(/lwa_client_id/);
  });
  it("throws when client_secret triple missing", () => {
    const cid = encryptToken("x");
    expect(() => decryptAccountCreds({
      lwa_client_id_ciphertext: cid.ciphertext,
      lwa_client_id_iv: cid.iv,
      lwa_client_id_tag: cid.tag,
    })).toThrow(/lwa_client_secret/);
  });
  it("decrypts all three triples", () => {
    const acct = makeAccount();
    const creds = decryptAccountCreds(acct);
    expect(creds.clientId).toBe("amzn1.application-oa2-client.x");
    expect(creds.clientSecret).toBe("client-secret-x");
    expect(creds.refreshToken).toBe("Atzr|refresh-x");
  });
});

// ──────────────────────────────────────────────────────────────────────
// processReturn — heavy supabase mock
// ──────────────────────────────────────────────────────────────────────

function makeProcessSb({
  parentOrder = makeParentOrder(),
  upserted = null,
  itemMasterRow = null,
  layerRow = null,
  rpcResult = JE_RESTOCK,
  rpcError = null,
  arInsResult = { id: CM_ID },
  arInsError = null,
  upsertError = null,
  updateError = null,
  layerInsertError = null,
} = {}) {
  const calls = {
    upserts: [], updates: [], rpc: [], arInserts: [], layerInserts: [],
  };
  const sb = {
    from(name) {
      if (name === "fba_orders") {
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
      if (name === "ip_item_master") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: itemMasterRow, error: null }) }),
              maybeSingle: async () => ({ data: itemMasterRow, error: null }),
            }),
          }),
        };
      }
      if (name === "inventory_layers") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({ maybeSingle: async () => ({ data: layerRow, error: null }) }),
                }),
              }),
            }),
          }),
          insert: (row) => {
            calls.layerInserts.push(row);
            return Promise.resolve({ error: layerInsertError });
          },
        };
      }
      if (name === "fba_returns") {
        return {
          upsert: (row) => {
            calls.upserts.push(row);
            return {
              select: () => ({
                maybeSingle: async () => ({
                  data: upserted || {
                    id: RET,
                    je_id: null,
                    ar_credit_memo_id: null,
                    return_status: row.return_status,
                    refund_amount_cents: row.refund_amount_cents,
                    entity_id: parentOrder?.entity_id || ENTITY,
                    ip_item_master_id: row.ip_item_master_id || null,
                    fba_order_id: row.fba_order_id || null,
                    quantity: row.quantity,
                  },
                  error: upsertError,
                }),
              }),
            };
          },
          update: (patch) => ({
            eq: (col, val) => {
              calls.updates.push({ patch, col, val });
              return Promise.resolve({ error: updateError });
            },
          }),
        };
      }
      if (name === "ar_invoices") {
        return {
          insert: (row) => {
            calls.arInserts.push(row);
            return {
              select: () => ({ single: async () => ({ data: arInsResult, error: arInsError }) }),
            };
          },
        };
      }
      throw new Error(`unexpected table ${name}`);
    },
    rpc: vi.fn(async (name, args) => {
      calls.rpc.push({ name, args });
      return { data: rpcResult, error: rpcError };
    }),
  };
  return { sb, calls };
}

describe("processReturn", () => {
  it("skips upsert when return_request_id is missing", async () => {
    const { sb, calls } = makeProcessSb();
    const r = await processReturn(sb, {
      rawReturn: { Quantity: 1 },
      fbaSellerAccountId: ACCT,
      accounts: makeAccounts(),
    });
    expect(r.action).toBe("skip");
    expect(calls.upserts).toHaveLength(0);
  });

  it("upserts but skips JE when no parent order is found", async () => {
    const { sb, calls } = makeProcessSb({
      parentOrder: null,
    });
    const r = await processReturn(sb, {
      rawReturn: { ReturnRequestId: "ret-x", AmazonOrderId: "nope-not-found" },
      fbaSellerAccountId: ACCT,
      accounts: makeAccounts(),
    });
    expect(r.action).toBe("no_parent_order");
    expect(calls.rpc).toHaveLength(0);
  });

  it("posts restock JE + inventory_layer for Resellable", async () => {
    const { sb, calls } = makeProcessSb({
      upserted: {
        id: RET,
        je_id: null,
        ar_credit_memo_id: null,
        return_status: "Resellable",
        refund_amount_cents: 0,
        entity_id: ENTITY,
        ip_item_master_id: ITEM,
        fba_order_id: ORDER,
        quantity: 2,
      },
      itemMasterRow: { id: ITEM, cost_cents: 1500 },
      layerRow: { unit_cost_cents: 1500 },
      rpcResult: JE_RESTOCK,
    });
    const r = await processReturn(sb, {
      rawReturn: {
        ReturnRequestId: "ret-1",
        AmazonOrderId: "111-2222222-3333333",
        Quantity: 2,
        ASIN: "B0XXX",
        ReturnStatus: "Resellable",
      },
      fbaSellerAccountId: ACCT,
      accounts: makeAccounts(),
    });
    expect(r.action).toBe("restock");
    expect(r.je_id).toBe(JE_RESTOCK);
    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].args.payload.lines[0].debit).toBe("30.00"); // 1500c * 2 = 3000c
    expect(calls.layerInserts).toHaveLength(1);
    expect(calls.layerInserts[0].source_kind).toBe("fba_return_restock");
    expect(calls.updates[0].patch.je_id).toBe(JE_RESTOCK);
  });

  it("posts writeoff JE for Defective", async () => {
    const { sb, calls } = makeProcessSb({
      upserted: {
        id: RET,
        je_id: null,
        ar_credit_memo_id: null,
        return_status: "Defective",
        refund_amount_cents: 0,
        entity_id: ENTITY,
        ip_item_master_id: ITEM,
        fba_order_id: ORDER,
        quantity: 1,
      },
      itemMasterRow: { id: ITEM, cost_cents: 800 },
      layerRow: { unit_cost_cents: 800 },
      rpcResult: JE_WRITEOFF,
    });
    const r = await processReturn(sb, {
      rawReturn: {
        ReturnRequestId: "ret-2",
        AmazonOrderId: "111-2222222-3333333",
        Quantity: 1,
        SellerSKU: "SKU-2",
        ReturnStatus: "Defective",
      },
      fbaSellerAccountId: ACCT,
      accounts: makeAccounts(),
    });
    expect(r.action).toBe("writeoff");
    expect(r.je_id).toBe(JE_WRITEOFF);
    expect(calls.rpc[0].args.payload.lines[0].account_id).toBe(RMV_ACCT);
    expect(calls.layerInserts).toHaveLength(0);
  });

  it("posts writeoff JE for Disposed", async () => {
    const { sb, calls } = makeProcessSb({
      upserted: {
        id: RET,
        je_id: null,
        ar_credit_memo_id: null,
        return_status: "Disposed",
        refund_amount_cents: 0,
        entity_id: ENTITY,
        ip_item_master_id: ITEM,
        fba_order_id: ORDER,
        quantity: 1,
      },
      itemMasterRow: { id: ITEM, cost_cents: 500 },
      layerRow: { unit_cost_cents: 500 },
      rpcResult: JE_WRITEOFF,
    });
    const r = await processReturn(sb, {
      rawReturn: {
        ReturnRequestId: "ret-3",
        AmazonOrderId: "111-2222222-3333333",
        Quantity: 1,
        SellerSKU: "SKU-3",
        ReturnStatus: "Disposed",
      },
      fbaSellerAccountId: ACCT,
      accounts: makeAccounts(),
    });
    expect(r.action).toBe("writeoff");
    expect(calls.rpc).toHaveLength(1);
  });

  it("does NOT post JE for unknown status", async () => {
    const { sb, calls } = makeProcessSb({
      upserted: {
        id: RET,
        je_id: null,
        ar_credit_memo_id: null,
        return_status: "CarrierDamaged",
        refund_amount_cents: 0,
        entity_id: ENTITY,
        ip_item_master_id: ITEM,
        fba_order_id: ORDER,
        quantity: 1,
      },
    });
    const r = await processReturn(sb, {
      rawReturn: {
        ReturnRequestId: "ret-4",
        AmazonOrderId: "111-2222222-3333333",
        ReturnStatus: "CarrierDamaged",
      },
      fbaSellerAccountId: ACCT,
      accounts: makeAccounts(),
    });
    expect(r.action).toBe("none");
    expect(calls.rpc).toHaveLength(0);
  });

  it("posts credit memo JE + ar_invoices when refund > 0 and parent has ar_invoice_id", async () => {
    let rpcCount = 0;
    const { sb, calls } = makeProcessSb({
      upserted: {
        id: RET,
        je_id: null,
        ar_credit_memo_id: null,
        return_status: "Resellable",
        refund_amount_cents: 1500,
        entity_id: ENTITY,
        ip_item_master_id: ITEM,
        fba_order_id: ORDER,
        quantity: 1,
      },
      itemMasterRow: { id: ITEM, cost_cents: 100 },
      layerRow: { unit_cost_cents: 100 },
    });
    sb.rpc = vi.fn(async () => {
      rpcCount++;
      return { data: rpcCount === 1 ? JE_RESTOCK : JE_CM, error: null };
    });
    const r = await processReturn(sb, {
      rawReturn: {
        ReturnRequestId: "ret-5",
        AmazonOrderId: "111-2222222-3333333",
        Quantity: 1,
        ReturnStatus: "Resellable",
        RefundAmount: { Amount: "15.00" },
      },
      fbaSellerAccountId: ACCT,
      accounts: makeAccounts(),
    });
    expect(r.ar_credit_memo_id).toBe(CM_ID);
    expect(calls.arInserts).toHaveLength(1);
    expect(calls.arInserts[0].source).toBe("fba");
    expect(calls.arInserts[0].invoice_kind).toBe("customer_credit_memo");
    expect(calls.arInserts[0].reverses_invoice_id).toBe(AR_INV);
  });

  it("does NOT post credit memo when parent has no ar_invoice_id", async () => {
    const { sb, calls } = makeProcessSb({
      parentOrder: makeParentOrder({ ar_invoice_id: null }),
      upserted: {
        id: RET,
        je_id: null,
        ar_credit_memo_id: null,
        return_status: "Resellable",
        refund_amount_cents: 1000,
        entity_id: ENTITY,
        ip_item_master_id: ITEM,
        fba_order_id: ORDER,
        quantity: 1,
      },
      itemMasterRow: { id: ITEM, cost_cents: 100 },
      layerRow: { unit_cost_cents: 100 },
    });
    await processReturn(sb, {
      rawReturn: {
        ReturnRequestId: "ret-6",
        AmazonOrderId: "111-2222222-3333333",
        Quantity: 1,
        ReturnStatus: "Resellable",
        RefundAmount: { Amount: "10.00" },
      },
      fbaSellerAccountId: ACCT,
      accounts: makeAccounts(),
    });
    expect(calls.arInserts).toHaveLength(0);
  });

  it("short-circuits when je_id already stamped (idempotent)", async () => {
    const { sb, calls } = makeProcessSb({
      upserted: {
        id: RET,
        je_id: JE_RESTOCK,
        ar_credit_memo_id: null,
        return_status: "Resellable",
        refund_amount_cents: 0,
        entity_id: ENTITY,
        ip_item_master_id: ITEM,
        fba_order_id: ORDER,
        quantity: 1,
      },
    });
    const r = await processReturn(sb, {
      rawReturn: {
        ReturnRequestId: "ret-7",
        AmazonOrderId: "111-2222222-3333333",
        Quantity: 1,
        ReturnStatus: "Resellable",
      },
      fbaSellerAccountId: ACCT,
      accounts: makeAccounts(),
    });
    expect(r.action).toBe("je_already_posted");
    expect(calls.rpc).toHaveLength(0);
  });

  it("emits action restock_zero_cost when unit cost is 0", async () => {
    const { sb, calls } = makeProcessSb({
      upserted: {
        id: RET,
        je_id: null,
        ar_credit_memo_id: null,
        return_status: "Resellable",
        refund_amount_cents: 0,
        entity_id: ENTITY,
        ip_item_master_id: null,
        fba_order_id: ORDER,
        quantity: 1,
      },
    });
    const r = await processReturn(sb, {
      rawReturn: {
        ReturnRequestId: "ret-8",
        AmazonOrderId: "111-2222222-3333333",
        Quantity: 1,
        ReturnStatus: "Resellable",
      },
      fbaSellerAccountId: ACCT,
      accounts: makeAccounts(),
    });
    expect(r.action).toBe("restock_zero_cost");
    expect(calls.rpc).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// syncAccountReturns
// ──────────────────────────────────────────────────────────────────────

function makeSyncSb({ accounts = [], updErr = null, accountRows = [
  { code: "1300", id: INV_ACCT },
  { code: "5000", id: COGS_ACCT },
  { code: "6525", id: RMV_ACCT },
  { code: "1200", id: AR_ACCT },
  { code: "4000", id: REV_ACCT },
]} = {}) {
  const calls = { updates: [] };
  return {
    from(name) {
      if (name === "fba_seller_accounts") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: accounts, error: null }),
          }),
          update: (patch) => ({
            eq: (col, val) => {
              calls.updates.push({ patch, col, val });
              return Promise.resolve({ error: updErr });
            },
          }),
        };
      }
      if (name === "gl_accounts") {
        return {
          select: () => ({
            eq: () => ({
              in: () => Promise.resolve({ data: accountRows, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${name}`);
    },
    _calls: calls,
  };
}

describe("syncAccountReturns", () => {
  it("bumps last_returns_sync_at on success", async () => {
    const sb = makeSyncSb();
    const fakeClient = {
      listReturnRequests: async () => ({ returnRequests: [] }),
    };
    const now = new Date("2026-05-29T00:00:00Z");
    const summary = await syncAccountReturns(sb, makeAccount(), {
      now,
      deps: {
        refreshAccessToken: makeRefreshFn(),
        makeClient: () => fakeClient,
        processReturn: async () => ({ action: "none" }),
      },
    });
    expect(summary.pages).toBe(1);
    expect(summary.returns_upserted).toBe(0);
    expect(sb._calls.updates).toHaveLength(1);
    expect(sb._calls.updates[0].patch.last_returns_sync_at).toBe(now.toISOString());
  });

  it("isolates per-return errors and keeps going", async () => {
    const sb = makeSyncSb();
    let call = 0;
    const processReturnFn = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error("processReturn boom");
      return { je_id: "je-x" };
    });
    const fakeClient = {
      listReturnRequests: async () => ({
        returnRequests: [
          { ReturnRequestId: "ret-A" },
          { ReturnRequestId: "ret-B" },
        ],
      }),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const summary = await syncAccountReturns(sb, makeAccount(), {
        deps: {
          refreshAccessToken: makeRefreshFn(),
          makeClient: () => fakeClient,
          processReturn: processReturnFn,
        },
      });
      expect(summary.returns_upserted).toBe(1); // only the second one succeeded
      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0].return_request_id).toBe("ret-A");
    } finally {
      warn.mockRestore();
    }
  });

  it("paginates via nextToken", async () => {
    const sb = makeSyncSb();
    let pages = 0;
    const fakeClient = {
      listReturnRequests: async (args) => {
        pages++;
        if (pages === 1) {
          return { returnRequests: [{ ReturnRequestId: "ret-A" }], pagination: { nextToken: "n-1" } };
        }
        if (pages === 2) {
          expect(args.nextToken).toBe("n-1");
          return { returnRequests: [{ ReturnRequestId: "ret-B" }], pagination: {} };
        }
        throw new Error("over-paginated");
      },
    };
    const summary = await syncAccountReturns(sb, makeAccount(), {
      deps: {
        refreshAccessToken: makeRefreshFn(),
        makeClient: () => fakeClient,
        processReturn: async () => ({ action: "none" }),
      },
    });
    expect(summary.pages).toBe(2);
    expect(summary.returns_upserted).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────
// syncAllAccountsReturns
// ──────────────────────────────────────────────────────────────────────

describe("syncAllAccountsReturns", () => {
  it("returns empty when no active accounts", async () => {
    const sb = makeSyncSb({ accounts: [] });
    const out = await syncAllAccountsReturns(sb);
    expect(out.accounts).toEqual([]);
    expect(typeof out.started_at).toBe("string");
    expect(typeof out.finished_at).toBe("string");
  });

  it("isolates per-account failures", async () => {
    const acctA = makeAccount({ id: "aaaaaaaa-1111-1111-1111-111111111111" });
    const acctB = makeAccount({ id: "bbbbbbbb-2222-2222-2222-222222222222" });
    const sb = makeSyncSb({ accounts: [acctA, acctB] });
    let calls = 0;
    const out = await syncAllAccountsReturns(sb, {
      deps: {
        refreshAccessToken: makeRefreshFn(),
        makeClient: () => {
          calls++;
          if (calls === 1) {
            return { listReturnRequests: async () => ({ returnRequests: [] }) };
          }
          return { listReturnRequests: async () => { throw new Error("spapi 403"); } };
        },
        processReturn: async () => ({ action: "none" }),
      },
    });
    expect(out.accounts).toHaveLength(2);
    expect(out.accounts[0].ok).toBe(true);
    expect(out.accounts[1].ok).toBe(false);
    expect(out.accounts[1].error).toMatch(/spapi 403/);
  });

  it("throws when accounts read fails", async () => {
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => Promise.resolve({ data: null, error: { message: "rls denied" } }),
        }),
      }),
    };
    await expect(syncAllAccountsReturns(sb)).rejects.toThrow(/rls denied/);
  });
});
