// Tests for reverseJournalEntry: pulls original + lines, posts negated JE,
// flips original to 'reversed', cross-links via reverses_je_id / reversed_by_je_id.

import { describe, it, expect, vi } from "vitest";
import { reverseJournalEntry } from "../accounting/posting/reverse.js";

function mockSupabase({ original, lines, rpcResult = "new-rev-id" }) {
  const updates = { jeUpdates: [] };
  const rpc = vi.fn().mockResolvedValue({ data: rpcResult, error: null });

  const from = (table) => {
    if (table === "journal_entries") {
      let lastEqId = null;
      const builder = {
        select() { return this; },
        update(payload) { this._update = payload; return this; },
        eq(_col, id) { lastEqId = id; this._lastId = id; return this; },
        async maybeSingle() {
          // SELECT path: return the original
          return { data: lastEqId === original.id ? original : null, error: null };
        },
      };
      // Make update().eq() return a thenable that resolves the update.
      return new Proxy(builder, {
        get(target, prop) {
          if (prop === "then") {
            // Only invoked when chain is awaited (after update().eq())
            return (resolve) => {
              if (target._update && target._lastId) {
                updates.jeUpdates.push({ id: target._lastId, ...target._update });
                resolve({ data: null, error: null });
              } else {
                resolve({ data: null, error: null });
              }
            };
          }
          return target[prop];
        },
      });
    }
    if (table === "journal_entry_lines") {
      const builder = {
        select() { return this; },
        eq() { return this; },
        order() { return this; },
      };
      return new Proxy(builder, {
        get(target, prop) {
          if (prop === "then") {
            return (resolve) => resolve({ data: lines, error: null });
          }
          return target[prop];
        },
      });
    }
    throw new Error(`unexpected table ${table}`);
  };

  return { from, rpc, _updates: updates };
}

describe("reverseJournalEntry", () => {
  const original = {
    id: "orig-je",
    entity_id: "00000000-0000-0000-0000-000000000001",
    basis: "ACCRUAL",
    journal_type: "ap_invoice",
    source_module: "ap",
    source_table: "invoices",
    source_id: "inv-1",
    description: "AP invoice INV-001",
    status: "posted",
    sibling_je_id: null,
  };
  const lines = [
    { line_number: 1, account_id: "exp1", debit: "1000.00", credit: "0",
      memo: "AP invoice INV-001", subledger_type: null, subledger_id: null },
    { line_number: 2, account_id: "ap1",  debit: "0",       credit: "1000.00",
      memo: "AP invoice INV-001", subledger_type: "vendor", subledger_id: "v1" },
  ];

  it("posts a negated JE and flips the original to reversed", async () => {
    const supabase = mockSupabase({ original, lines });
    const newId = await reverseJournalEntry(supabase, "orig-je", { posting_date: "2026-06-01" });
    expect(newId).toBe("new-rev-id");

    // RPC payload has debit/credit swapped from the originals
    const [, args] = supabase.rpc.mock.calls[0];
    expect(args.payload.lines[0]).toMatchObject({
      account_id: "exp1", debit: "0", credit: "1000.00",
    });
    expect(args.payload.lines[1]).toMatchObject({
      account_id: "ap1",  debit: "1000.00", credit: "0",
    });

    // Update calls: original gets status=reversed, new gets reverses_je_id=orig
    const jeUpdates = supabase._updates.jeUpdates;
    expect(jeUpdates.find((u) => u.id === "orig-je" && u.status === "reversed")).toBeTruthy();
    expect(jeUpdates.find((u) => u.id === "new-rev-id" && u.reverses_je_id === "orig-je")).toBeTruthy();
  });

  it("refuses to reverse a JE that isn't posted", async () => {
    const supabase = mockSupabase({
      original: { ...original, status: "draft" },
      lines,
    });
    await expect(reverseJournalEntry(supabase, "orig-je"))
      .rejects.toThrow(/is in status 'draft'/);
  });

  it("refuses when the JE doesn't exist", async () => {
    const supabase = mockSupabase({
      original: { ...original, id: "different-id" },
      lines,
    });
    await expect(reverseJournalEntry(supabase, "ghost"))
      .rejects.toThrow(/not found/);
  });
});
