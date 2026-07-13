// Tests for the AP AmountPaid delta-watcher (api/_lib/ap-paid-watcher.js).
//
// Focus: the 2026-07-12 hardening — a corrupted frozen invoice header
// (register total unchanged, invoices.total_amount_cents rewritten by
// another process) is AUTO-REPAIRED from the register with NO JE, while a
// genuine register-side total change stays a report-only anomaly.

import { describe, it, expect } from "vitest";
import { runApPaidWatcher, __test_only__ } from "../ap-paid-watcher.js";

const { clampDate, dollars, addSigned } = __test_only__;

// ── pure helpers ─────────────────────────────────────────────────────────────
describe("ap-paid-watcher helpers", () => {
  it("clampDate floors pre-cutover dates to 2024-08-31", () => {
    expect(clampDate("2024-01-15")).toBe("2024-08-31");
    expect(clampDate("2025-03-02")).toBe("2025-03-02");
    expect(clampDate(null)).toBe(null);
  });
  it("dollars renders signed cents", () => {
    expect(dollars(123456)).toBe("1234.56");
    expect(dollars(-5)).toBe("-0.05");
    expect(dollars(0)).toBe("0.00");
  });
  it("addSigned debits on positive, credits on negative, skips zero", () => {
    const lines = [];
    addSigned(lines, "acct", 100, "m", "vend");
    addSigned(lines, "acct", -100, "m");
    addSigned(lines, "acct", 0, "m");
    expect(lines).toHaveLength(2);
    expect(lines[0].debit).toBe("1.00");
    expect(lines[0].subledger_id).toBe("vend");
    expect(lines[1].credit).toBe("1.00");
  });
});

// ── fake supabase admin ──────────────────────────────────────────────────────
// Minimal chainable stub: records table writes, serves canned rows.
function makeAdmin(tables) {
  const writes = [];
  const rpcCalls = [];
  function from(table) {
    const state = { table, filters: [] };
    const api = {
      select() { return api; },
      order() { return api; },
      in() { return api; },
      like() { return api; },
      not() { return api; },
      eq(col, val) { state.filters.push([col, val]); return api; },
      range() { return api; }, // chainable; rows served via then()
      update(patch) {
        return { eq: (col, val) => { writes.push({ table, patch, where: [col, val] }); return Promise.resolve({ error: null }); } };
      },
      insert(row) { writes.push({ table, insert: row }); return { select: () => ({ single: () => Promise.resolve({ data: { id: "new" }, error: null }) }) }; },
      maybeSingle() {
        const rows = tables[table] || [];
        const row = rows.find((r) => state.filters.every(([c, v]) => r[c] === v)) || null;
        return Promise.resolve({ data: row, error: null });
      },
      // Awaiting the builder directly (loadContext's gl_accounts read) yields
      // the filtered rows.
      then(resolve) {
        const rows = (tables[table] || []).filter((r) =>
          state.filters.every(([c, v]) => r[c] === v));
        resolve({ data: rows, error: null });
      },
    };
    return api;
  }
  return {
    from,
    rpc: (name, args) => { rpcCalls.push({ name, args }); return Promise.resolve({ data: "je-new", error: null }); },
    __writes: writes,
    __rpc: rpcCalls,
  };
}

const ENTITY = { id: "ent-1", code: "ROF" };
const ACCTS = [
  { code: "2000", id: "a2000", entity_id: "ent-1" },
  { code: "5005", id: "a5005", entity_id: "ent-1" },
  { code: "1308", id: "a1308", entity_id: "ent-1" },
];

describe("runApPaidWatcher — header-drift repair (2026-07-12 incident)", () => {
  it("auto-repairs a corrupted frozen invoice header from the register, posts NO JE", async () => {
    const invId = "inv-1";
    const admin = makeAdmin({
      entities: [ENTITY],
      gl_accounts: ACCTS,
      ap_payment_import: [],
      ap_bill_register_import: [{
        id: "b1", bill_number: "ROF-B1", vendor_id: "v1", vendor_name: "V", invoice_id: invId,
        accrual_je_id: "je1", relief_je_id: null, skip_reason: null,
        total_cents: 100000, paid_cents: 0, due_cents: 100000,
        discounts_cents: 0, credits_cents: 0, vendor_credits_cents: 0, prepayments_cents: 0,
        paid_processed_cents: 0, total_processed_cents: 100000,
        relief_5005_processed_cents: 0, relief_1308_processed_cents: 0,
        bill_date: "2025-01-01", modified_date: "2025-01-01", status: "Open",
      }],
      // header was corrupted to 0 by another process; register still says 100000
      invoices: [{ id: invId, invoice_number: "ROF-B1", source: "xoro_bills_register", gl_status: "posted", total_amount_cents: 0, paid_amount_cents: 0 }],
      journal_entries: [],
      journal_entry_lines: [],
      vendors: [],
    });
    const out = await runApPaidWatcher(admin, { dryRun: false });
    expect(out.headers_repaired).toBe(1);
    expect(out.anomalies.some((a) => a.type === "header_drift_repaired")).toBe(true);
    // NO relief/payment JE posted for a pure header repair
    expect(admin.__rpc.filter((c) => c.name === "gl_post_journal_entry")).toHaveLength(0);
    // header restored to the register total
    const hdrWrite = admin.__writes.find((w) => w.table === "invoices" && w.patch?.total_amount_cents === 100000);
    expect(hdrWrite).toBeTruthy();
  });

  it("register-side total change stays a report-only total_changed anomaly (no repair, no JE)", async () => {
    const invId = "inv-2";
    const admin = makeAdmin({
      entities: [ENTITY],
      gl_accounts: ACCTS,
      ap_payment_import: [],
      ap_bill_register_import: [{
        id: "b2", bill_number: "ROF-B2", vendor_id: "v1", vendor_name: "V", invoice_id: invId,
        accrual_je_id: "je2", relief_je_id: null, skip_reason: null,
        total_cents: 120000, paid_cents: 0, due_cents: 120000, // register moved 100000 -> 120000
        discounts_cents: 0, credits_cents: 0, vendor_credits_cents: 0, prepayments_cents: 0,
        paid_processed_cents: 0, total_processed_cents: 100000, // baseline is the old total
        relief_5005_processed_cents: 0, relief_1308_processed_cents: 0,
        bill_date: "2025-01-01", modified_date: "2025-01-01", status: "Open",
      }],
      invoices: [{ id: invId, invoice_number: "ROF-B2", source: "xoro_bills_register", gl_status: "posted", total_amount_cents: 100000, paid_amount_cents: 0 }],
      journal_entries: [],
      journal_entry_lines: [],
      vendors: [],
    });
    const out = await runApPaidWatcher(admin, { dryRun: false });
    expect(out.headers_repaired).toBe(0);
    expect(out.anomalies.some((a) => a.type === "total_changed")).toBe(true);
    expect(admin.__writes.some((w) => w.table === "invoices" && w.patch?.total_amount_cents)).toBe(false);
  });
});
