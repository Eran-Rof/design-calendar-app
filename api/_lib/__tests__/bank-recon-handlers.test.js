// Tests for the P6-5 bank-reconciliation handler validators.

import { describe, it, expect } from "vitest";
import { parseListQuery as parseAccountsQuery } from "../../_handlers/internal/bank-accounts/index.js";
import {
  parseListQuery as parseTxnsQuery,
  isUuid,
  isISODate,
} from "../../_handlers/internal/bank-transactions/index.js";
import { validateBody as validateApplyMatch } from "../../_handlers/internal/bank-transactions/apply-match.js";
import { validateBody as validateUnmatch } from "../../_handlers/internal/bank-transactions/unmatch.js";
import { validateBody as validateCreateJe } from "../../_handlers/internal/bank-transactions/create-je.js";
import { validateBody as validateIgnore } from "../../_handlers/internal/bank-transactions/ignore.js";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

function P(o) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) sp.set(k, String(v));
  return sp;
}

describe("bank-accounts parseListQuery", () => {
  it("defaults to is_active=true, feed_source=null", () => {
    expect(parseAccountsQuery(P({})).data).toEqual({ is_active: true, feed_source: null });
  });
  it("accepts is_active=false", () => {
    expect(parseAccountsQuery(P({ is_active: "false" })).data.is_active).toBe(false);
  });
  it("rejects invalid is_active", () => {
    expect(parseAccountsQuery(P({ is_active: "maybe" })).error).toMatch(/is_active/);
  });
  it("filters feed_source enum", () => {
    expect(parseAccountsQuery(P({ feed_source: "plaid" })).data.feed_source).toBe("plaid");
    expect(parseAccountsQuery(P({ feed_source: "ach" })).error).toMatch(/feed_source/);
  });
});

describe("bank-transactions isUuid / isISODate", () => {
  it("isUuid", () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid("abc")).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
  it("isISODate", () => {
    expect(isISODate("2026-05-28")).toBe(true);
    expect(isISODate("2026/05/28")).toBe(false);
    expect(isISODate("2026-02-30")).toBe(false);
  });
});

describe("bank-transactions parseListQuery", () => {
  it("defaults to status=unmatched, limit=200", () => {
    const v = parseTxnsQuery(P({}));
    expect(v.data).toEqual({ bank_account_id: null, status: "unmatched", from: null, to: null, limit: 200 });
  });
  it("accepts status=all", () => {
    expect(parseTxnsQuery(P({ status: "all" })).data.status).toBe("all");
  });
  it("validates bank_account_id UUID", () => {
    expect(parseTxnsQuery(P({ bank_account_id: "x" })).error).toMatch(/bank_account_id/);
    expect(parseTxnsQuery(P({ bank_account_id: UUID })).data.bank_account_id).toBe(UUID);
  });
  it("validates from/to ISO", () => {
    expect(parseTxnsQuery(P({ from: "bad" })).error).toMatch(/from/);
    expect(parseTxnsQuery(P({ to: "2026-13-01" })).error).toMatch(/to/);
    expect(parseTxnsQuery(P({ from: "2026-01-01", to: "2026-12-31" })).data.from).toBe("2026-01-01");
  });
  it("clamps limit to 1000", () => {
    expect(parseTxnsQuery(P({ limit: "5000" })).data.limit).toBe(1000);
    expect(parseTxnsQuery(P({ limit: "-5" })).error).toMatch(/limit/);
  });
});

describe("apply-match validateBody", () => {
  it("rejects missing je_line_id", () => {
    expect(validateApplyMatch({}).error).toMatch(/je_line_id/);
  });
  it("rejects malformed je_line_id", () => {
    expect(validateApplyMatch({ je_line_id: "abc" }).error).toMatch(/je_line_id/);
  });
  it("accepts valid je_line_id alone", () => {
    expect(validateApplyMatch({ je_line_id: UUID }).data).toEqual({ je_line_id: UUID, actor_user_id: null, notes: null });
  });
  it("validates actor_user_id UUID", () => {
    expect(validateApplyMatch({ je_line_id: UUID, actor_user_id: "x" }).error).toMatch(/actor/);
  });
  it("trims notes + rejects > 500 chars", () => {
    expect(validateApplyMatch({ je_line_id: UUID, notes: "  hi  " }).data.notes).toBe("hi");
    expect(validateApplyMatch({ je_line_id: UUID, notes: "x".repeat(501) }).error).toMatch(/500/);
  });
});

describe("unmatch validateBody", () => {
  it("accepts empty body", () => {
    expect(validateUnmatch({}).data).toEqual({ actor_user_id: null, notes: null });
  });
  it("validates actor_user_id", () => {
    expect(validateUnmatch({ actor_user_id: "x" }).error).toMatch(/actor/);
  });
});

describe("create-je validateBody", () => {
  it("rejects missing target_gl_account_id", () => {
    expect(validateCreateJe({}).error).toMatch(/target_gl_account_id/);
  });
  it("accepts minimum valid body", () => {
    const v = validateCreateJe({ target_gl_account_id: UUID });
    expect(v.error).toBeUndefined();
    expect(v.data.target_gl_account_id).toBe(UUID);
    expect(v.data.actor_user_id).toBeNull();
    expect(v.data.memo).toBeNull();
  });
  it("trims memo + rejects too-long", () => {
    expect(validateCreateJe({ target_gl_account_id: UUID, memo: "  hi  " }).data.memo).toBe("hi");
    expect(validateCreateJe({ target_gl_account_id: UUID, memo: "x".repeat(501) }).error).toMatch(/500/);
  });
});

describe("ignore validateBody", () => {
  it("accepts empty body", () => {
    expect(validateIgnore({}).data).toEqual({ actor_user_id: null, reason: null });
  });
  it("trims reason", () => {
    expect(validateIgnore({ reason: "  duplicate  " }).data.reason).toBe("duplicate");
  });
  it("rejects > 500-char reason", () => {
    expect(validateIgnore({ reason: "x".repeat(501) }).error).toMatch(/500/);
  });
});
