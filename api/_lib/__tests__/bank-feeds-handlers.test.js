// Tests for the Plaid handler validators (P6-2).

import { describe, it, expect } from "vitest";
import { validateBody as validateLinkBody } from "../../_handlers/internal/bank-feeds/link-token.js";
import { validateBody as validateExchangeBody } from "../../_handlers/internal/bank-feeds/exchange.js";
import { mapPlaidTxn } from "../../cron/bank-feed-sync.js";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("link-token.validateBody", () => {
  it("accepts empty body (defaults)", () => {
    const v = validateLinkBody({});
    expect(v.error).toBeUndefined();
    expect(v.data).toEqual({ client_user_id: null, webhook: null });
  });
  it("accepts a valid UUID client_user_id", () => {
    expect(validateLinkBody({ client_user_id: UUID }).data.client_user_id).toBe(UUID);
  });
  it("rejects malformed client_user_id", () => {
    expect(validateLinkBody({ client_user_id: "abc" }).error).toMatch(/client_user_id/);
  });
  it("treats empty-string client_user_id as null", () => {
    expect(validateLinkBody({ client_user_id: "" }).data.client_user_id).toBeNull();
  });
  it("rejects non-https webhook", () => {
    expect(validateLinkBody({ webhook: "http://example.com" }).error).toMatch(/https/);
    expect(validateLinkBody({ webhook: "ftp://example.com" }).error).toMatch(/https/);
  });
  it("rejects too-long webhook", () => {
    expect(validateLinkBody({ webhook: "https://" + "a".repeat(500) }).error).toMatch(/too long/);
  });
  it("accepts valid webhook URL", () => {
    expect(validateLinkBody({ webhook: "https://example.com/api/webhooks/plaid" }).data.webhook)
      .toBe("https://example.com/api/webhooks/plaid");
  });
});

describe("exchange.validateBody", () => {
  it("rejects missing public_token", () => {
    expect(validateExchangeBody({ gl_account_id: UUID }).error).toMatch(/public_token/);
  });
  it("rejects implausibly long public_token", () => {
    expect(validateExchangeBody({ public_token: "x".repeat(300), gl_account_id: UUID }).error).toMatch(/implausibly/);
  });
  it("rejects missing gl_account_id", () => {
    expect(validateExchangeBody({ public_token: "pt-xxx" }).error).toMatch(/gl_account_id/);
  });
  it("rejects malformed gl_account_id", () => {
    expect(validateExchangeBody({ public_token: "pt-xxx", gl_account_id: "not-uuid" }).error).toMatch(/gl_account_id/);
  });
  it("rejects invalid account_kind", () => {
    expect(validateExchangeBody({ public_token: "pt-xxx", gl_account_id: UUID, account_kind: "crypto" }).error)
      .toMatch(/account_kind/);
  });
  it("accepts a valid minimum payload (defaults account_kind=checking)", () => {
    const v = validateExchangeBody({ public_token: "pt-xxx", gl_account_id: UUID });
    expect(v.error).toBeUndefined();
    expect(v.data.account_kind).toBe("checking");
    expect(v.data.name).toBeNull();
  });
  it("trims and validates name length", () => {
    expect(validateExchangeBody({ public_token: "pt", gl_account_id: UUID, name: "x".repeat(200) }).error)
      .toMatch(/120 chars/);
    expect(validateExchangeBody({ public_token: "pt", gl_account_id: UUID, name: "  My Bank  " }).data.name)
      .toBe("My Bank");
  });
  it("accepts each valid account_kind value", () => {
    for (const k of ["checking","savings","credit_card","line_of_credit","other"]) {
      expect(validateExchangeBody({ public_token: "pt", gl_account_id: UUID, account_kind: k }).error).toBeUndefined();
    }
  });
});

describe("mapPlaidTxn", () => {
  const acct = { id: "ba-1", entity_id: "ent-1" };

  it("inverts Plaid's sign convention (positive Plaid = withdrawal in GL)", () => {
    // Plaid: amount=50 means $50 was charged TO the account
    // GL convention: positive = deposit, negative = withdrawal
    const t = { transaction_id: "t1", date: "2026-05-28", amount: 50 };
    const row = mapPlaidTxn(acct, t);
    expect(row.amount_cents).toBe(-5000);
  });

  it("inverts deposits (Plaid negative → GL positive)", () => {
    const t = { transaction_id: "t1", date: "2026-05-28", amount: -100 };
    expect(mapPlaidTxn(acct, t).amount_cents).toBe(10000);
  });

  it("rounds amount to cents", () => {
    expect(mapPlaidTxn(acct, { transaction_id: "t1", date: "2026-05-28", amount: 12.345 }).amount_cents).toBe(-1235);
  });

  it("preserves transaction metadata", () => {
    const t = {
      transaction_id: "txn-1",
      date: "2026-05-28",
      amount: 1.23,
      name: "Coffee",
      original_description: "STARBUCKS NYC",
      merchant_name: "Starbucks",
      pending: true,
      category: ["Food and Drink", "Coffee"],
    };
    const row = mapPlaidTxn(acct, t);
    expect(row.external_txn_id).toBe("txn-1");
    expect(row.posted_date).toBe("2026-05-28");
    expect(row.merchant_name).toBe("Starbucks");
    expect(row.description).toBe("STARBUCKS NYC");
    expect(row.pending).toBe(true);
    expect(row.category).toEqual(["Food and Drink", "Coffee"]);
    expect(row.source).toBe("plaid");
    expect(row.bank_account_id).toBe("ba-1");
    expect(row.entity_id).toBe("ent-1");
  });

  it("falls back to personal_finance_category when category array is missing", () => {
    const t = {
      transaction_id: "txn-1",
      date: "2026-05-28",
      amount: 1,
      personal_finance_category: { primary: "INCOME" },
    };
    expect(mapPlaidTxn(acct, t).category).toEqual(["INCOME"]);
  });

  it("handles null amount as 0", () => {
    expect(mapPlaidTxn(acct, { transaction_id: "t", date: "2026-05-28", amount: null }).amount_cents).toBe(0);
  });

  it("falls back to name when original_description is missing", () => {
    const t = { transaction_id: "t", date: "2026-05-28", amount: 1, name: "fallback" };
    expect(mapPlaidTxn(acct, t).description).toBe("fallback");
  });
});
