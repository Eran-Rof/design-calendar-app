// Tests for the year-end-close runner handler (P5-6).
// Pure validator coverage — RPC behavior tested via deploy smoke.

import { describe, it, expect } from "vitest";
import { validateBody } from "../../_handlers/internal/year-end-close/run.js";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("year-end-close validateBody", () => {
  it("rejects non-object body", () => {
    expect(validateBody(null).error).toMatch(/object/);
    expect(validateBody("hello").error).toMatch(/object/);
  });
  it("rejects missing fiscal_year", () => {
    expect(validateBody({}).error).toMatch(/fiscal_year is required/);
  });
  it("rejects non-integer fiscal_year", () => {
    expect(validateBody({ fiscal_year: 2024.5 }).error).toMatch(/integer/);
    expect(validateBody({ fiscal_year: "abc" }).error).toMatch(/integer/);
  });
  it("rejects fiscal_year < 2024 (pre-Xoro era per P4-8 hard lock)", () => {
    expect(validateBody({ fiscal_year: 2023 }).error).toMatch(/2024/);
    expect(validateBody({ fiscal_year: 1900 }).error).toMatch(/2024/);
  });
  it("rejects fiscal_year > 2099", () => {
    expect(validateBody({ fiscal_year: 2100 }).error).toMatch(/2099/);
    expect(validateBody({ fiscal_year: 9999 }).error).toMatch(/2099/);
  });
  it("accepts string fiscal_year (integer-parseable)", () => {
    const v = validateBody({ fiscal_year: "2024" });
    expect(v.error).toBeUndefined();
    expect(v.data.fiscal_year).toBe(2024);
  });
  it("accepts minimum valid fiscal_year (2024)", () => {
    const v = validateBody({ fiscal_year: 2024 });
    expect(v.error).toBeUndefined();
  });
  it("default dry_run is true (safety)", () => {
    expect(validateBody({ fiscal_year: 2024 }).data.dry_run).toBe(true);
  });
  it("explicit dry_run=false is honored", () => {
    expect(validateBody({ fiscal_year: 2024, dry_run: false }).data.dry_run).toBe(false);
  });
  it("rejects non-boolean dry_run", () => {
    expect(validateBody({ fiscal_year: 2024, dry_run: "yes" }).error).toMatch(/dry_run/);
    expect(validateBody({ fiscal_year: 2024, dry_run: 1 }).error).toMatch(/dry_run/);
  });
  it("accepts valid actor_user_id UUID", () => {
    const v = validateBody({ fiscal_year: 2024, actor_user_id: UUID });
    expect(v.error).toBeUndefined();
    expect(v.data.actor_user_id).toBe(UUID);
  });
  it("rejects malformed actor_user_id", () => {
    expect(validateBody({ fiscal_year: 2024, actor_user_id: "not-a-uuid" }).error).toMatch(/actor_user_id/);
  });
  it("treats empty-string actor_user_id as null", () => {
    expect(validateBody({ fiscal_year: 2024, actor_user_id: "" }).data.actor_user_id).toBeNull();
  });
});
