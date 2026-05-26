// Tests for the manual JE post validator. The actual atomic posting is done
// via the gl_post_journal_entry RPC (Chunk 3 migration) — these tests verify
// the JS validation layer that fast-fails on obviously-bad payloads before
// hitting the DB.

import { describe, it, expect } from "vitest";
import { validateManualPost } from "../../_handlers/internal/journal-entries/index.js";

const UUID = "00000000-0000-0000-0000-000000000001";

function lines(...rows) {
  return rows.map((r, i) => ({
    line_number: i + 1,
    account_id: r.account_id ?? UUID,
    debit: r.debit ?? "0",
    credit: r.credit ?? "0",
    memo: r.memo ?? null,
    subledger_type: r.subledger_type ?? null,
    subledger_id: r.subledger_id ?? null,
  }));
}

describe("validateManualPost", () => {
  it("rejects missing basis", () => {
    expect(validateManualPost({ posting_date: "2026-05-26", description: "x", lines: lines({}) }).error)
      .toMatch(/basis/);
  });
  it("rejects invalid basis", () => {
    expect(validateManualPost({ basis: "MAYBE", posting_date: "2026-05-26", description: "x", lines: lines({}) }).error)
      .toMatch(/basis/);
  });
  it("accepts BOTH basis", () => {
    const v = validateManualPost({
      basis: "BOTH", posting_date: "2026-05-26", description: "split",
      lines: lines({ debit: "10" }, { credit: "10" }),
    });
    expect(v.error).toBeUndefined();
    expect(v.data.basis).toBe("BOTH");
  });

  it("rejects malformed posting_date", () => {
    expect(validateManualPost({ basis: "ACCRUAL", posting_date: "5/26/2026", description: "x", lines: lines({}) }).error)
      .toMatch(/posting_date/);
  });
  it("rejects missing description", () => {
    expect(validateManualPost({ basis: "ACCRUAL", posting_date: "2026-05-26", lines: lines({ debit: "10" }, { credit: "10" }) }).error)
      .toMatch(/description/);
  });
  it("rejects single-line entries", () => {
    expect(validateManualPost({ basis: "ACCRUAL", posting_date: "2026-05-26", description: "x", lines: lines({ debit: "10" }) }).error)
      .toMatch(/at least 2/);
  });
  it("rejects non-uuid account_id", () => {
    expect(validateManualPost({
      basis: "ACCRUAL", posting_date: "2026-05-26", description: "x",
      lines: [
        { line_number: 1, account_id: "not-a-uuid", debit: "10", credit: "0" },
        { line_number: 2, account_id: UUID, debit: "0", credit: "10" },
      ],
    }).error).toMatch(/uuid/);
  });

  it("rejects line with both debit and credit nonzero", () => {
    expect(validateManualPost({
      basis: "ACCRUAL", posting_date: "2026-05-26", description: "x",
      lines: lines({ debit: "5", credit: "5" }, { credit: "10" }),
    }).error).toMatch(/both debit and credit/);
  });
  it("rejects line with both zero", () => {
    expect(validateManualPost({
      basis: "ACCRUAL", posting_date: "2026-05-26", description: "x",
      lines: lines({ debit: "0", credit: "0" }, { credit: "0", debit: "0" }),
    }).error).toMatch(/at least one of debit\/credit/);
  });
  it("rejects negative amounts", () => {
    expect(validateManualPost({
      basis: "ACCRUAL", posting_date: "2026-05-26", description: "x",
      lines: lines({ debit: "-10" }, { credit: "-10" }),
    }).error).toMatch(/negative amounts not allowed/);
  });
  it("rejects unbalanced", () => {
    expect(validateManualPost({
      basis: "ACCRUAL", posting_date: "2026-05-26", description: "x",
      lines: lines({ debit: "100.00" }, { credit: "99.99" }),
    }).error).toMatch(/Unbalanced/);
  });
  it("rejects subledger_type without subledger_id", () => {
    expect(validateManualPost({
      basis: "ACCRUAL", posting_date: "2026-05-26", description: "x",
      lines: [
        { line_number: 1, account_id: UUID, debit: "10", credit: "0", subledger_type: "vendor", subledger_id: "" },
        { line_number: 2, account_id: UUID, debit: "0", credit: "10" },
      ],
    }).error).toMatch(/subledger_type and subledger_id/);
  });

  it("accepts a balanced 2-line ACCRUAL entry", () => {
    const v = validateManualPost({
      basis: "ACCRUAL", posting_date: "2026-05-26", description: "ok",
      lines: lines({ debit: "100.00" }, { credit: "100.00" }),
    });
    expect(v.error).toBeUndefined();
    expect(v.data.lines).toHaveLength(2);
    expect(v.data.lines[0].debit).toBe("100.00");
    expect(v.data.lines[1].credit).toBe("100.00");
  });

  it("accepts 3-line entries that balance", () => {
    const v = validateManualPost({
      basis: "ACCRUAL", posting_date: "2026-05-26", description: "split",
      lines: lines({ debit: "50.00" }, { debit: "50.00" }, { credit: "100.00" }),
    });
    expect(v.error).toBeUndefined();
  });

  it("handles penny precision without float drift", () => {
    // 0.10 + 0.20 = 0.30 (would fail float math)
    const v = validateManualPost({
      basis: "ACCRUAL", posting_date: "2026-05-26", description: "pennies",
      lines: lines({ debit: "0.10" }, { debit: "0.20" }, { credit: "0.30" }),
    });
    expect(v.error).toBeUndefined();
  });

  it("normalizes empty subledger to null", () => {
    const v = validateManualPost({
      basis: "ACCRUAL", posting_date: "2026-05-26", description: "x",
      lines: [
        { line_number: 1, account_id: UUID, debit: "10", credit: "0", subledger_type: "", subledger_id: "" },
        { line_number: 2, account_id: UUID, debit: "0", credit: "10" },
      ],
    });
    expect(v.error).toBeUndefined();
    expect(v.data.lines[0].subledger_type).toBeNull();
  });
});
