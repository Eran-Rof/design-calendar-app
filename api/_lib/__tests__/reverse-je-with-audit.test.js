// Unit tests for reverseJeWithAudit — the T11-safe JE reversal used by build
// cancel: posts a negated compensating entry WITH an audit reason, then flips
// the original to 'reversed' via the audit-aware RPC.

import { describe, it, expect } from "vitest";
import { reverseJeWithAudit } from "../accounting/reverseJeWithAudit.js";

function mockAdmin({ original, lines, newJeId }) {
  const calls = { glPost: null, reverseRpc: null, backlink: null };
  function from() {
    let isUpdate = false, payload = null;
    const chain = {
      select: () => chain,
      update: (p) => { isUpdate = true; payload = p; return chain; },
      eq: () => { if (isUpdate) { calls.backlink = payload; return Promise.resolve({ error: null }); } return chain; },
      maybeSingle: async () => ({ data: original, error: null }),
      order: async () => ({ data: lines, error: null }),
    };
    return chain;
  }
  const rpc = async (name, params) => {
    if (name === "gl_post_journal_entry") { calls.glPost = params; return { data: newJeId, error: null }; }
    if (name === "reverse_journal_entry_with_audit") { calls.reverseRpc = params; return { data: { status: "reversed" }, error: null }; }
    return { data: null, error: null };
  };
  return { from, rpc, _calls: calls };
}

const POSTED = {
  id: "je1", entity_id: "e1", basis: "ACCRUAL", journal_type: "manufacture_issue",
  posting_date: "2026-07-01", source_module: "inventory", source_table: "mfg_build_issue",
  source_id: "b1", description: "Build issue BUILD-1", status: "posted",
};
const LINES = [
  { line_number: 1, account_id: "wip", debit: "12.00", credit: "0", memo: "wip", subledger_type: "build_order", subledger_id: "b1" },
  { line_number: 2, account_id: "inv", debit: "0", credit: "12.00", memo: "inv", subledger_type: "part", subledger_id: "p1" },
];

describe("reverseJeWithAudit", () => {
  it("throws when no reason (T11)", async () => {
    const admin = mockAdmin({ original: POSTED, lines: LINES, newJeId: "rev1" });
    await expect(reverseJeWithAudit(admin, "je1", {})).rejects.toThrow(/reason is required/i);
  });

  it("returns null when the JE is not posted (already reversed)", async () => {
    const admin = mockAdmin({ original: { ...POSTED, status: "reversed" }, lines: LINES, newJeId: "rev1" });
    const out = await reverseJeWithAudit(admin, "je1", { reason: "cancel" });
    expect(out).toBeNull();
    expect(admin._calls.glPost).toBeNull();
  });

  it("posts a negated compensating entry WITH audit_reason and flips the original", async () => {
    const admin = mockAdmin({ original: POSTED, lines: LINES, newJeId: "rev1" });
    const out = await reverseJeWithAudit(admin, "je1", { reason: "operator cancelled build", source: "manual" });
    expect(out).toBe("rev1");

    // gl_post_journal_entry got the reason + negated lines + preserved source.
    const payload = admin._calls.glPost.payload;
    expect(payload.audit_reason).toBe("operator cancelled build");
    expect(payload.source_table).toBe("mfg_build_issue");
    expect(payload.source_id).toBe("b1");
    // Reversal is dated into the ORIGINAL entry's period, not today.
    expect(payload.posting_date).toBe("2026-07-01");
    // debit ↔ credit swapped on each line.
    expect(payload.lines[0]).toMatchObject({ account_id: "wip", debit: "0", credit: "12.00" });
    expect(payload.lines[1]).toMatchObject({ account_id: "inv", debit: "12.00", credit: "0" });

    // The original was flipped to reversed via the audit RPC, linked both ways.
    expect(admin._calls.reverseRpc).toMatchObject({ je_id: "je1", reversal_je_id: "rev1", audit_reason: "operator cancelled build" });
    expect(admin._calls.backlink).toEqual({ reverses_je_id: "je1" });
  });
});
