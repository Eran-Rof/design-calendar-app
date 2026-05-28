// Shape tests for the P5-5 cash flow migration.
// Loads the SQL file and asserts the function signature, STABLE marker, the
// presence of the three indirect-method sections, the cash-account heuristic,
// the entity-default + code-prefix fallback for AR/AP/Inventory accounts,
// and the schema-reload notify.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(__dirname, "../../../supabase/migrations/20260603300000_p5_chunk5_cash_flow.sql");
const sql = readFileSync(sqlPath, "utf8");

describe("P5-5 cash_flow migration", () => {
  it("creates the cash_flow_indirect function with correct signature", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION cash_flow_indirect\s*\(/);
    expect(sql).toMatch(/p_entity_id\s+uuid/);
    expect(sql).toMatch(/p_basis\s+text/);
    expect(sql).toMatch(/p_from_date\s+date/);
    expect(sql).toMatch(/p_to_date\s+date/);
  });

  it("returns a TABLE with (section, line_item, amount_cents)", () => {
    expect(sql).toMatch(/RETURNS TABLE/);
    expect(sql).toMatch(/section\s+text/);
    expect(sql).toMatch(/line_item\s+text/);
    expect(sql).toMatch(/amount_cents\s+bigint/);
  });

  it("is declared STABLE in PL/pgSQL", () => {
    expect(sql).toMatch(/LANGUAGE\s+plpgsql\s+STABLE/);
  });

  it("validates basis (ACCRUAL or CASH) and raises on invalid", () => {
    expect(sql).toMatch(/ACCRUAL/);
    expect(sql).toMatch(/CASH/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/invalid basis/i);
  });

  it("emits Operating, Investing, and Financing sections", () => {
    expect(sql).toMatch(/'operating'/);
    expect(sql).toMatch(/'investing'/);
    expect(sql).toMatch(/'financing'/);
  });

  it("operating section includes Net Income + ΔAR + ΔInventory + ΔAP", () => {
    expect(sql).toMatch(/Net Income/);
    expect(sql).toMatch(/Accounts Receivable/);
    expect(sql).toMatch(/Inventory/);
    expect(sql).toMatch(/Accounts Payable/);
  });

  it("investing + financing emit P22+ placeholder line", () => {
    expect(sql).toMatch(/configure in P22\+/i);
  });

  it("prefers entity defaults and falls back to code-prefix heuristic", () => {
    expect(sql).toMatch(/default_ar_account_id/);
    expect(sql).toMatch(/default_ap_account_id/);
    expect(sql).toMatch(/default_inventory_account_id/);
    // Code-prefix fallbacks: 1200 AR / 2010 AP / 1300 inventory
    expect(sql).toMatch(/'1200'/);
    expect(sql).toMatch(/'2010'/);
    expect(sql).toMatch(/'1300'/);
  });

  it("cash-account heuristic uses asset + code LIKE '1%' + name ILIKE cash/bank", () => {
    expect(sql).toMatch(/account_type\s*=\s*'asset'/);
    expect(sql).toMatch(/code\s+LIKE\s+'1%'/);
    expect(sql).toMatch(/ILIKE\s+'%cash%'/i);
    expect(sql).toMatch(/ILIKE\s+'%bank%'/i);
  });

  it("emits _cash_reference rows for Beginning + Ending Cash", () => {
    expect(sql).toMatch(/_cash_reference/);
    expect(sql).toMatch(/Beginning Cash/);
    expect(sql).toMatch(/Ending Cash/);
  });

  it("filters to posted JEs only", () => {
    expect(sql).toMatch(/status\s*=\s*'posted'/);
  });

  it("reloads PostgREST schema at end", () => {
    expect(sql).toMatch(/NOTIFY pgrst/);
  });
});
