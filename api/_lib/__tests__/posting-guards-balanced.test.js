// Tests for the balanced guard. Pure-JS, no Supabase mocks needed.

import { describe, it, expect } from "vitest";
import { checkBalanced } from "../accounting/posting/guards/balanced.js";

function candidate(lines) {
  return {
    entity_id: "00000000-0000-0000-0000-000000000001",
    basis: "ACCRUAL",
    journal_type: "manual",
    posting_date: "2026-05-21",
    source_module: "manual",
    description: "test",
    lines,
  };
}

describe("checkBalanced", () => {
  it("passes when debits equal credits", () => {
    const r = checkBalanced(candidate([
      { line_number: 1, account_id: "a1", debit: "100.00", credit: "0" },
      { line_number: 2, account_id: "a2", debit: "0", credit: "100.00" },
    ]));
    expect(r.ok).toBe(true);
  });

  it("rejects unbalanced", () => {
    const r = checkBalanced(candidate([
      { line_number: 1, account_id: "a1", debit: "100.00", credit: "0" },
      { line_number: 2, account_id: "a2", debit: "0", credit: "99.99" },
    ]));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("unbalanced");
  });

  it("rejects empty lines", () => {
    const r = checkBalanced(candidate([]));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("no_lines");
  });

  it("rejects all-zero lines", () => {
    const r = checkBalanced(candidate([
      { line_number: 1, account_id: "a1", debit: "0", credit: "0" },
      { line_number: 2, account_id: "a2", debit: "0", credit: "0" },
    ]));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("zero_totals");
  });

  it("rejects line with both debit and credit nonzero", () => {
    const r = checkBalanced(candidate([
      { line_number: 1, account_id: "a1", debit: "100.00", credit: "50.00" },
      { line_number: 2, account_id: "a2", debit: "0", credit: "50.00" },
    ]));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("line_two_sided");
  });

  it("handles 3+ lines that sum correctly", () => {
    const r = checkBalanced(candidate([
      { line_number: 1, account_id: "a1", debit: "100.00", credit: "0" },
      { line_number: 2, account_id: "a2", debit: "50.00", credit: "0" },
      { line_number: 3, account_id: "a3", debit: "0", credit: "150.00" },
    ]));
    expect(r.ok).toBe(true);
  });

  it("rejects negative amounts", () => {
    const r = checkBalanced(candidate([
      { line_number: 1, account_id: "a1", debit: "-100.00", credit: "0" },
      { line_number: 2, account_id: "a2", debit: "0", credit: "100.00" },
    ]));
    expect(r.ok).toBe(false);
    // could be either negative_amount or unbalanced depending on parsing path
    expect(["negative_amount", "unbalanced"]).toContain(r.code);
  });

  it("handles penny-precision without float drift", () => {
    // 0.10 + 0.20 = 0.30 (not 0.30000000000000004 like JS Number math)
    const r = checkBalanced(candidate([
      { line_number: 1, account_id: "a1", debit: "0.10", credit: "0" },
      { line_number: 2, account_id: "a2", debit: "0.20", credit: "0" },
      { line_number: 3, account_id: "a3", debit: "0", credit: "0.30" },
    ]));
    expect(r.ok).toBe(true);
  });

  it("rejects malformed money string", () => {
    expect(() => checkBalanced(candidate([
      { line_number: 1, account_id: "a1", debit: "abc", credit: "0" },
      { line_number: 2, account_id: "a2", debit: "0", credit: "0" },
    ]))).toThrow(/invalid money value/);
  });
});
