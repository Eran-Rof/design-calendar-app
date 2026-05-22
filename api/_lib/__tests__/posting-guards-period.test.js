// Tests for periodOpen guard.
//
// Mock Supabase client returns gl_periods + entities rows on demand. We don't
// hit a real DB.

import { describe, it, expect } from "vitest";
import { checkPeriodOpen } from "../accounting/posting/guards/periodOpen.js";

function mockSupabase({ period = null, entity = null, periodError = null, entityError = null } = {}) {
  return {
    from(table) {
      if (table === "gl_periods") {
        return {
          select() { return this; },
          eq() { return this; },
          lte() { return this; },
          gte() { return this; },
          limit() { return this; },
          async maybeSingle() {
            return { data: period, error: periodError };
          },
        };
      }
      if (table === "entities") {
        return {
          select() { return this; },
          eq() { return this; },
          async maybeSingle() {
            return { data: entity, error: entityError };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

const candidate = {
  entity_id: "00000000-0000-0000-0000-000000000001",
  basis: "ACCRUAL",
  journal_type: "manual",
  posting_date: "2026-05-21",
  source_module: "manual",
  description: "test",
  lines: [{ line_number: 1, account_id: "a", debit: "1", credit: "0" }],
};

describe("checkPeriodOpen", () => {
  it("passes when period is open and no entity lock", async () => {
    const r = await checkPeriodOpen(candidate, {
      supabase: mockSupabase({
        period: { id: "p1", status: "open", starts_on: "2026-05-01", ends_on: "2026-05-31" },
        entity: { posting_locked_through: null },
      }),
      entity_id: candidate.entity_id,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects when no period covers the date", async () => {
    const r = await checkPeriodOpen(candidate, {
      supabase: mockSupabase({ period: null }),
      entity_id: candidate.entity_id,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("no_period");
  });

  it("rejects when period is closed", async () => {
    const r = await checkPeriodOpen(candidate, {
      supabase: mockSupabase({
        period: { id: "p1", status: "closed", starts_on: "2026-05-01", ends_on: "2026-05-31" },
        entity: { posting_locked_through: null },
      }),
      entity_id: candidate.entity_id,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("period_closed");
  });

  it("rejects manual JE when period is soft_close", async () => {
    const r = await checkPeriodOpen(candidate, {
      supabase: mockSupabase({
        period: { id: "p1", status: "soft_close", starts_on: "2026-05-01", ends_on: "2026-05-31" },
        entity: { posting_locked_through: null },
      }),
      entity_id: candidate.entity_id,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("period_soft_closed");
  });

  it("allows adjustment JE when period is soft_close", async () => {
    const adjCandidate = { ...candidate, journal_type: "adjustment" };
    const r = await checkPeriodOpen(adjCandidate, {
      supabase: mockSupabase({
        period: { id: "p1", status: "soft_close", starts_on: "2026-05-01", ends_on: "2026-05-31" },
        entity: { posting_locked_through: null },
      }),
      entity_id: adjCandidate.entity_id,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects when entity hard-lock covers the date", async () => {
    const r = await checkPeriodOpen(candidate, {
      supabase: mockSupabase({
        period: { id: "p1", status: "open", starts_on: "2026-05-01", ends_on: "2026-05-31" },
        entity: { posting_locked_through: "2026-05-31" },
      }),
      entity_id: candidate.entity_id,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("entity_locked");
  });
});
