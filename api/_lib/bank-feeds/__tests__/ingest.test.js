// Plaid-seam ingestion contract tests (bank reconciliation mirror).
// Pure normalize + fake-admin upsert shape — no network, no DB.
import { describe, it, expect } from "vitest";
import { normalizeExternalTxn, ingestBankTransactions, INGEST_SOURCES } from "../ingest.js";

const ACCT = { id: "ba-1", entity_id: "ent-1" };

function fakeAdmin(capture) {
  return {
    from(table) {
      return {
        upsert(rows, opts) {
          capture.push({ table, rows, opts });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

describe("normalizeExternalTxn", () => {
  it("normalizes a full record", () => {
    const t = normalizeExternalTxn({
      external_txn_id: "PMT-001",
      posted_date: "2026-05-15",
      amount_cents: -123456,
      description: "wire out",
      merchant_name: "ACME",
      category: ["xoro_payment"],
      pending: false,
      raw_payload: { a: 1 },
    });
    expect(t).toEqual({
      external_txn_id: "PMT-001",
      posted_date: "2026-05-15",
      amount_cents: -123456,
      description: "wire out",
      merchant_name: "ACME",
      category: ["xoro_payment"],
      pending: false,
      raw_payload: { a: 1 },
    });
  });

  it("defaults optional fields", () => {
    const t = normalizeExternalTxn({ external_txn_id: "x", posted_date: "2026-01-01", amount_cents: 100 });
    expect(t.description).toBeNull();
    expect(t.merchant_name).toBeNull();
    expect(t.category).toBeNull();
    expect(t.pending).toBe(false);
    expect(t.raw_payload).toEqual({});
  });

  it("rejects missing id, bad date, non-integer cents", () => {
    expect(() => normalizeExternalTxn({ posted_date: "2026-01-01", amount_cents: 1 })).toThrow(/external_txn_id/);
    expect(() => normalizeExternalTxn({ external_txn_id: "x", posted_date: "01/01/2026", amount_cents: 1 })).toThrow(/posted_date/);
    expect(() => normalizeExternalTxn({ external_txn_id: "x", posted_date: "2026-01-01", amount_cents: 1.5 })).toThrow(/amount_cents/);
  });
});

describe("ingestBankTransactions", () => {
  it("upserts feed columns only, keyed for idempotency, and reports rejects", async () => {
    const calls = [];
    const admin = fakeAdmin(calls);
    const out = await ingestBankTransactions(admin, ACCT, [
      { external_txn_id: "PLAID-1", posted_date: "2026-06-01", amount_cents: 50000 },
      { external_txn_id: "", posted_date: "2026-06-01", amount_cents: 1 }, // bad id
    ], "plaid");
    expect(out.upserted).toBe(1);
    expect(out.rejected).toEqual([{ index: 1, error: expect.stringMatching(/external_txn_id/) }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("bank_transactions");
    expect(calls[0].opts).toEqual({ onConflict: "bank_account_id,external_txn_id" });
    const row = calls[0].rows[0];
    expect(row).toMatchObject({
      entity_id: "ent-1",
      bank_account_id: "ba-1",
      source: "plaid",
      external_txn_id: "PLAID-1",
      amount_cents: 50000,
    });
    // Match state must never ride an ingest upsert.
    expect(row).not.toHaveProperty("status");
    expect(row).not.toHaveProperty("matched_je_line_id");
  });

  it("rejects unknown sources", async () => {
    await expect(ingestBankTransactions(fakeAdmin([]), ACCT, [], "ftp_drop")).rejects.toThrow(/source/);
    expect(INGEST_SOURCES).toContain("xoro_mirror");
  });
});
