// Tests for the P6-6 bank-recon-runs handler validators.

import { describe, it, expect } from "vitest";
import { validatePost, isUuid } from "../../_handlers/internal/bank-recon-runs/index.js";
import { validatePatch } from "../../_handlers/internal/bank-recon-runs/[id].js";

const UUID  = "550e8400-e29b-41d4-a716-446655440000";
const UUID2 = "11111111-1111-1111-1111-111111111111";

describe("bank-recon-runs validatePost", () => {
  it("rejects non-object body", () => {
    expect(validatePost(null).error).toMatch(/object/);
    expect(validatePost("x").error).toMatch(/object/);
  });
  it("rejects missing bank_account_id", () => {
    expect(validatePost({ period_id: UUID }).error).toMatch(/bank_account_id/);
  });
  it("rejects missing period_id", () => {
    expect(validatePost({ bank_account_id: UUID }).error).toMatch(/period_id/);
  });
  it("rejects malformed UUIDs", () => {
    expect(validatePost({ bank_account_id: "x", period_id: UUID }).error).toMatch(/bank_account_id/);
    expect(validatePost({ bank_account_id: UUID, period_id: "x" }).error).toMatch(/period_id/);
  });
  it("accepts valid", () => {
    const v = validatePost({ bank_account_id: UUID, period_id: UUID2 });
    expect(v.error).toBeUndefined();
    expect(v.data).toEqual({ bank_account_id: UUID, period_id: UUID2 });
  });
});

describe("bank-recon-runs validatePatch", () => {
  it("rejects empty body (no fields)", () => {
    expect(validatePatch({}).error).toMatch(/No fields/);
  });
  it("validates bank_statement_balance_cents integer", () => {
    expect(validatePatch({ bank_statement_balance_cents: 1.5 }).error).toMatch(/integer/);
    expect(validatePatch({ bank_statement_balance_cents: "abc" }).error).toMatch(/integer/);
    expect(validatePatch({ bank_statement_balance_cents: 123456 }).data.bank_statement_balance_cents).toBe(123456);
  });
  it("validates status enum", () => {
    expect(validatePatch({ status: "weird" }).error).toMatch(/status/);
    expect(validatePatch({ status: "reconciled" }).data.status).toBe("reconciled");
    expect(validatePatch({ status: "in_progress" }).data.status).toBe("in_progress");
    expect(validatePatch({ status: "flagged" }).data.status).toBe("flagged");
  });
  it("trims notes; null-empty; rejects >1000 chars", () => {
    expect(validatePatch({ notes: "  hi  " }).data.notes).toBe("hi");
    expect(validatePatch({ notes: "  " }).data.notes).toBeNull();
    expect(validatePatch({ notes: "x".repeat(1001) }).error).toMatch(/1000/);
  });
  it("validates actor_user_id UUID", () => {
    expect(validatePatch({ status: "reconciled", actor_user_id: "x" }).error).toMatch(/actor/);
    expect(validatePatch({ status: "reconciled", actor_user_id: UUID }).data.actor_user_id).toBe(UUID);
  });
  it("accepts mixed updates", () => {
    const v = validatePatch({ bank_statement_balance_cents: 5000, status: "reconciled", notes: "April recon" });
    expect(v.error).toBeUndefined();
    expect(v.data).toEqual({ bank_statement_balance_cents: 5000, status: "reconciled", notes: "April recon" });
  });
});

describe("isUuid helper", () => {
  it("accepts a v4-style UUID", () => {
    expect(isUuid(UUID)).toBe(true);
  });
  it("rejects junk", () => {
    expect(isUuid("not-uuid")).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
