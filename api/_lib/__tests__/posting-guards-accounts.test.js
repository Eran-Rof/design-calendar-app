// Tests for the three gl_accounts-touching guards:
//   accountPostable, accountExistsInEntity, controlAccountSubledger

import { describe, it, expect } from "vitest";
import { checkAccountPostable } from "../accounting/posting/guards/accountPostable.js";
import { checkAccountExistsInEntity } from "../accounting/posting/guards/accountExistsInEntity.js";
import { checkControlAccountSubledger } from "../accounting/posting/guards/controlAccountSubledger.js";

function mockSupabase({ accounts = [], error = null } = {}) {
  return {
    from(table) {
      if (table !== "gl_accounts") throw new Error(`unexpected table ${table}`);
      let filter = null;
      const builder = {
        select() { return this; },
        in(_col, ids) { filter = ids; return this; },
        async then() { /* not used */ },
      };
      // Patterns in the source code do .select().in().then-or-await — return a thenable.
      const finalRows = () => accounts.filter((a) => filter == null || filter.includes(a.id));
      return new Proxy(builder, {
        get(target, prop) {
          if (prop === "then") {
            return (resolve) => resolve({ data: finalRows(), error });
          }
          return target[prop];
        },
      });
    },
  };
}

const candidate = (lines) => ({
  entity_id: "00000000-0000-0000-0000-000000000001",
  basis: "ACCRUAL",
  journal_type: "manual",
  posting_date: "2026-05-21",
  source_module: "manual",
  description: "test",
  lines,
});

describe("checkAccountPostable", () => {
  it("passes when accounts are active + postable", async () => {
    const r = await checkAccountPostable(candidate([
      { line_number: 1, account_id: "a1", debit: "1", credit: "0" },
    ]), { supabase: mockSupabase({ accounts: [
      { id: "a1", status: "active", is_postable: true, code: "1000" },
    ] }), entity_id: candidate([]).entity_id });
    expect(r.ok).toBe(true);
  });

  it("rejects unknown account", async () => {
    const r = await checkAccountPostable(candidate([
      { line_number: 1, account_id: "ghost", debit: "1", credit: "0" },
    ]), { supabase: mockSupabase({ accounts: [] }), entity_id: candidate([]).entity_id });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("account_not_found");
  });

  it("rejects inactive account", async () => {
    const r = await checkAccountPostable(candidate([
      { line_number: 1, account_id: "a1", debit: "1", credit: "0" },
    ]), { supabase: mockSupabase({ accounts: [
      { id: "a1", status: "inactive", is_postable: true, code: "1000" },
    ] }), entity_id: candidate([]).entity_id });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("account_inactive");
  });

  it("rejects roll-up (non-postable) account", async () => {
    const r = await checkAccountPostable(candidate([
      { line_number: 1, account_id: "a1", debit: "1", credit: "0" },
    ]), { supabase: mockSupabase({ accounts: [
      { id: "a1", status: "active", is_postable: false, code: "1000" },
    ] }), entity_id: candidate([]).entity_id });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("account_not_postable");
  });
});

describe("checkAccountExistsInEntity", () => {
  it("passes when accounts belong to the same entity", async () => {
    const r = await checkAccountExistsInEntity(candidate([
      { line_number: 1, account_id: "a1", debit: "1", credit: "0" },
    ]), { supabase: mockSupabase({ accounts: [
      { id: "a1", entity_id: "00000000-0000-0000-0000-000000000001", code: "1000" },
    ] }), entity_id: "00000000-0000-0000-0000-000000000001" });
    expect(r.ok).toBe(true);
  });

  it("rejects when account belongs to a different entity", async () => {
    const r = await checkAccountExistsInEntity(candidate([
      { line_number: 1, account_id: "a1", debit: "1", credit: "0" },
    ]), { supabase: mockSupabase({ accounts: [
      { id: "a1", entity_id: "00000000-0000-0000-0000-000000000099", code: "1000" },
    ] }), entity_id: "00000000-0000-0000-0000-000000000001" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("account_wrong_entity");
  });
});

describe("checkControlAccountSubledger", () => {
  it("passes when control account line includes subledger", async () => {
    const r = await checkControlAccountSubledger(candidate([
      { line_number: 1, account_id: "ap1", debit: "0", credit: "100",
        subledger_type: "vendor", subledger_id: "v1" },
    ]), { supabase: mockSupabase({ accounts: [
      { id: "ap1", is_control: true, code: "2000", name: "AP" },
    ] }), entity_id: candidate([]).entity_id });
    expect(r.ok).toBe(true);
  });

  it("rejects when control account line is missing subledger", async () => {
    const r = await checkControlAccountSubledger(candidate([
      { line_number: 1, account_id: "ap1", debit: "0", credit: "100" },
    ]), { supabase: mockSupabase({ accounts: [
      { id: "ap1", is_control: true, code: "2000", name: "AP" },
    ] }), entity_id: candidate([]).entity_id });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("control_account_missing_subledger");
  });

  it("ignores subledger absence on non-control accounts", async () => {
    const r = await checkControlAccountSubledger(candidate([
      { line_number: 1, account_id: "rev1", debit: "0", credit: "100" },
    ]), { supabase: mockSupabase({ accounts: [
      { id: "rev1", is_control: false, code: "4000", name: "Revenue" },
    ] }), entity_id: candidate([]).entity_id });
    expect(r.ok).toBe(true);
  });
});
