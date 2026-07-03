// Tests for persist.js + index.js (postEvent end-to-end). Supabase is mocked
// — we only verify call sequence, payload shape, and sibling linking.

import { describe, it, expect, vi } from "vitest";
import { candidateToPayload, persistRuleOutput, persistCandidate } from "../accounting/posting/persist.js";
import { postEvent, PostingError } from "../accounting/posting/index.js";

function mockSupabase({
  rpcImpl = async () => ({ data: "new-je-id", error: null }),
  glAccounts = [],
  period = { id: "p1", status: "open", starts_on: "2026-05-01", ends_on: "2026-05-31" },
  entity = { posting_locked_through: null },
} = {}) {
  const rpc = vi.fn().mockImplementation(async (fnName, args) => rpcImpl(fnName, args));

  const from = (table) => {
    if (table === "gl_accounts") {
      const filter = { ids: null };
      const builder = {
        select() { return this; },
        in(_col, ids) { filter.ids = ids; return this; },
      };
      return new Proxy(builder, {
        get(target, prop) {
          if (prop === "then") {
            return (resolve) => resolve({
              data: glAccounts.filter((a) => filter.ids == null || filter.ids.includes(a.id)),
              error: null,
            });
          }
          return target[prop];
        },
      });
    }
    if (table === "gl_periods") {
      return {
        select() { return this; },
        eq() { return this; },
        lte() { return this; },
        gte() { return this; },
        limit() { return this; },
        async maybeSingle() { return { data: period, error: null }; },
      };
    }
    if (table === "entities") {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: entity, error: null }; },
      };
    }
    throw new Error(`unexpected table ${table}`);
  };

  return { from, rpc };
}

const ENTITY = "00000000-0000-0000-0000-000000000001";
const goodAccounts = [
  { id: "exp1", entity_id: ENTITY, status: "active", is_postable: true, is_control: false, code: "5000", name: "COGS" },
  { id: "ap1",  entity_id: ENTITY, status: "active", is_postable: true, is_control: true,  code: "2000", name: "AP" },
  { id: "cash1",entity_id: ENTITY, status: "active", is_postable: true, is_control: false, code: "1000", name: "Cash" },
];

describe("candidateToPayload", () => {
  it("serializes lines with default sentinel values", () => {
    const payload = candidateToPayload({
      entity_id: ENTITY, basis: "ACCRUAL", journal_type: "manual",
      posting_date: "2026-05-21", source_module: "manual", description: "t",
      lines: [{ line_number: 1, account_id: "a", debit: "10", credit: "0" }],
    }, null);

    expect(payload.basis).toBe("ACCRUAL");
    expect(payload.sibling_je_id).toBeNull();
    expect(payload.lines[0]).toEqual({
      line_number: 1, account_id: "a", debit: "10", credit: "0",
      memo: null, subledger_type: null, subledger_id: null,
    });
  });
});

describe("persistCandidate", () => {
  it("calls gl_post_journal_entry RPC and returns the new id", async () => {
    const supabase = mockSupabase();
    const id = await persistCandidate(supabase, {
      entity_id: ENTITY, basis: "ACCRUAL", journal_type: "manual",
      posting_date: "2026-05-21", source_module: "manual", description: "t",
      lines: [
        { line_number: 1, account_id: "exp1", debit: "10", credit: "0" },
        { line_number: 2, account_id: "ap1",  debit: "0",  credit: "10",
          subledger_type: "vendor", subledger_id: "v1" },
      ],
    });
    expect(id).toBe("new-je-id");
    expect(supabase.rpc).toHaveBeenCalledWith("gl_post_journal_entry", expect.objectContaining({
      payload: expect.objectContaining({ basis: "ACCRUAL" }),
    }));
  });

  it("surfaces RPC errors as PostingError", async () => {
    const supabase = mockSupabase({
      rpcImpl: async () => ({ data: null, error: { message: "Unbalanced journal_entry" } }),
    });
    await expect(persistCandidate(supabase, {
      entity_id: ENTITY, basis: "ACCRUAL", journal_type: "manual",
      posting_date: "2026-05-21", source_module: "manual", description: "t",
      lines: [{ line_number: 1, account_id: "a", debit: "10", credit: "0" }],
    })).rejects.toThrow(/RPC failed/);
  });
});

describe("persistRuleOutput dual-basis", () => {
  it("posts both twins and links them via gl_link_sibling_je", async () => {
    let callIndex = 0;
    const supabase = mockSupabase({
      rpcImpl: async (fnName) => {
        if (fnName === "gl_post_journal_entry") {
          return { data: callIndex++ === 0 ? "accrual-je" : "cash-je", error: null };
        }
        if (fnName === "gl_link_sibling_je") {
          return { data: null, error: null };
        }
        throw new Error(`unexpected rpc ${fnName}`);
      },
    });

    const baseCandidate = {
      entity_id: ENTITY, journal_type: "ap_payment",
      posting_date: "2026-05-21", source_module: "ap",
      source_table: "payments", source_id: "pay-1",
      description: "test", lines: [
        { line_number: 1, account_id: "ap1", debit: "10", credit: "0",
          subledger_type: "vendor", subledger_id: "v1" },
        { line_number: 2, account_id: "cash1", debit: "0", credit: "10" },
      ],
    };

    const result = await persistRuleOutput(supabase, {
      accrual: { ...baseCandidate, basis: "ACCRUAL" },
      cash:    { ...baseCandidate, basis: "CASH" },
    });

    expect(result.accrual_je_id).toBe("accrual-je");
    expect(result.cash_je_id).toBe("cash-je");

    // First call posts accrual; second posts cash with sibling_je_id=accrual-je.
    const calls = supabase.rpc.mock.calls;
    expect(calls[0][0]).toBe("gl_post_journal_entry");
    expect(calls[0][1].payload.sibling_je_id).toBeNull();
    expect(calls[1][0]).toBe("gl_post_journal_entry");
    expect(calls[1][1].payload.sibling_je_id).toBe("accrual-je");
    expect(calls[2][0]).toBe("gl_link_sibling_je");
    expect(calls[2][1]).toEqual({ je_a: "accrual-je", je_b: "cash-je" });
  });

  it("posts only accrual when rule output has no cash side", async () => {
    const supabase = mockSupabase();
    const result = await persistRuleOutput(supabase, {
      accrual: {
        entity_id: ENTITY, basis: "ACCRUAL", journal_type: "ap_invoice",
        posting_date: "2026-05-21", source_module: "ap",
        source_table: "invoices", source_id: "inv-1",
        description: "test",
        lines: [
          { line_number: 1, account_id: "exp1", debit: "10", credit: "0" },
          { line_number: 2, account_id: "ap1",  debit: "0",  credit: "10",
            subledger_type: "vendor", subledger_id: "v1" },
        ],
      },
      cash: null,
    });

    expect(result.accrual_je_id).toBe("new-je-id");
    expect(result.cash_je_id).toBeNull();
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });
});

describe("postEvent integration", () => {
  it("ap_invoice_received: guards pass, RPC fires once, accrual JE returned", async () => {
    const accounts = [
      ...goodAccounts,
      // exp1 + ap1 cover the rule's account references
    ];
    const supabase = mockSupabase({ glAccounts: accounts });

    const result = await postEvent(supabase, {
      kind: "ap_invoice_received", entity_id: ENTITY,
      created_by_user_id: "user-1",
      data: {
        invoice_id: "inv-1", vendor_id: "v-1",
        invoice_number: "INV-001", invoice_date: "2026-05-21",
        amount: "1000.00",
        ap_account_id: "ap1", expense_account_id: "exp1",
      },
    });

    expect(result.accrual_je_id).toBe("new-je-id");
    expect(result.cash_je_id).toBeNull();
  });

  it("threads event.reason into the RPC payload as audit_reason (T11 D3)", async () => {
    const supabase = mockSupabase({ glAccounts: goodAccounts });
    await postEvent(supabase, {
      kind: "ap_invoice_received", entity_id: ENTITY,
      created_by_user_id: "user-1",
      reason: "Manufacturing build issue BLD-001",
      data: {
        invoice_id: "inv-1", vendor_id: "v-1",
        invoice_number: "INV-001", invoice_date: "2026-05-21",
        amount: "1000.00",
        ap_account_id: "ap1", expense_account_id: "exp1",
      },
    });
    const post = supabase.rpc.mock.calls.find((c) => c[0] === "gl_post_journal_entry");
    expect(post[1].payload.audit_reason).toBe("Manufacturing build issue BLD-001");
  });

  it("omits audit_reason from the payload when no reason supplied (back-compat)", async () => {
    const supabase = mockSupabase({ glAccounts: goodAccounts });
    await postEvent(supabase, {
      kind: "ap_invoice_received", entity_id: ENTITY,
      created_by_user_id: "user-1",
      data: {
        invoice_id: "inv-1", vendor_id: "v-1",
        invoice_number: "INV-001", invoice_date: "2026-05-21",
        amount: "1000.00",
        ap_account_id: "ap1", expense_account_id: "exp1",
      },
    });
    const post = supabase.rpc.mock.calls.find((c) => c[0] === "gl_post_journal_entry");
    expect("audit_reason" in post[1].payload).toBe(false);
  });

  it("throws PostingError on unknown event kind", async () => {
    const supabase = mockSupabase();
    await expect(postEvent(supabase, { kind: "nonexistent", entity_id: ENTITY, data: {} }))
      .rejects.toBeInstanceOf(PostingError);
  });

  it("throws when entity_id is missing", async () => {
    const supabase = mockSupabase();
    await expect(postEvent(supabase, { kind: "manual", data: {} }))
      .rejects.toThrow(/entity_id/);
  });

  it("rejects unbalanced manual entry pre-RPC", async () => {
    const supabase = mockSupabase({ glAccounts: goodAccounts });
    await expect(postEvent(supabase, {
      kind: "manual", entity_id: ENTITY,
      data: {
        basis: "ACCRUAL", posting_date: "2026-05-21", description: "bad",
        lines: [
          { line_number: 1, account_id: "exp1", debit: "10", credit: "0" },
          { line_number: 2, account_id: "ap1",  debit: "0",  credit: "5",
            subledger_type: "vendor", subledger_id: "v1" },
        ],
      },
    })).rejects.toThrow(/unbalanced|do not equal/i);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});
