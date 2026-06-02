// Static-shape sanity checks on the P6-1 migration file.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(__dirname, "../../../supabase/migrations/20260607000000_p6_chunk1_bank_recon_schema.sql"),
  "utf8",
);

describe("P6-1 migration — static shape", () => {
  describe("bank_accounts", () => {
    it("creates the table with gl_account_id FK and standard audit fields", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS bank_accounts/);
      expect(SQL).toMatch(/gl_account_id\s+uuid NOT NULL REFERENCES gl_accounts\(id\)/);
      expect(SQL).toMatch(/entity_id\s+uuid NOT NULL REFERENCES entities\(id\)/);
    });
    it("includes Plaid linkage columns (item_id, account_id, ciphertext, cursor)", () => {
      expect(SQL).toMatch(/plaid_item_id\s+text/);
      expect(SQL).toMatch(/plaid_account_id\s+text/);
      expect(SQL).toMatch(/plaid_access_token_ciphertext bytea/);
      expect(SQL).toMatch(/plaid_cursor\s+text/);
    });
    it("includes feed_source enum check", () => {
      expect(SQL).toMatch(/feed_source\s+text NOT NULL DEFAULT 'manual'/);
      expect(SQL).toMatch(/CHECK \(feed_source IN \('plaid','csv_upload','manual'\)\)/);
    });
    it("includes account_kind enum check", () => {
      expect(SQL).toMatch(/account_kind\s+text NOT NULL DEFAULT 'checking'/);
      expect(SQL).toMatch(/CHECK \(account_kind IN \('checking','savings','credit_card','line_of_credit','other'\)\)/);
    });
    it("includes csv_column_mapping and auto_post_fee_rules JSONB", () => {
      expect(SQL).toMatch(/csv_column_mapping\s+jsonb/);
      expect(SQL).toMatch(/auto_post_fee_rules jsonb NOT NULL DEFAULT '\[\]'::jsonb/);
    });
    it("has UNIQUE on plaid_account_id (partial; only when set)", () => {
      expect(SQL).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_accounts_plaid/);
      expect(SQL).toMatch(/WHERE plaid_account_id IS NOT NULL/);
    });
    it("has UNIQUE (entity_id, name)", () => {
      expect(SQL).toMatch(/UNIQUE \(entity_id, name\)/);
    });
  });

  describe("bank_transactions", () => {
    it("creates the table with FK to bank_accounts", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS bank_transactions/);
      expect(SQL).toMatch(/bank_account_id\s+uuid NOT NULL REFERENCES bank_accounts\(id\)/);
    });
    it("includes signed amount_cents bigint", () => {
      expect(SQL).toMatch(/amount_cents\s+bigint NOT NULL/);
    });
    it("includes status state machine", () => {
      expect(SQL).toMatch(/status\s+text NOT NULL DEFAULT 'unmatched'/);
      expect(SQL).toMatch(/CHECK \(status IN \('unmatched','matched','manual_je_created','ignored','reversed'\)\)/);
    });
    it("links matched_je_line_id to journal_entry_lines", () => {
      expect(SQL).toMatch(/matched_je_line_id\s+uuid REFERENCES journal_entry_lines\(id\)/);
    });
    it("has source enum check (plaid|csv_upload|manual)", () => {
      expect(SQL).toMatch(/source\s+text NOT NULL CHECK \(source IN \('plaid','csv_upload','manual'\)\)/);
    });
    it("has UNIQUE (bank_account_id, external_txn_id) for dedup", () => {
      expect(SQL).toMatch(/UNIQUE \(bank_account_id, external_txn_id\)/);
    });
    it("has partial index for unmatched lookup", () => {
      expect(SQL).toMatch(/idx_bank_txns_unmatched/);
      expect(SQL).toMatch(/WHERE status = 'unmatched'/);
    });
    it("has match-candidate lookup index (entity, amount, date)", () => {
      expect(SQL).toMatch(/idx_bank_txns_amount_date/);
      expect(SQL).toMatch(/\(entity_id, amount_cents, posted_date\)/);
    });
  });

  describe("bank_recon_runs", () => {
    it("creates the table with FKs to bank_accounts and gl_periods", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS bank_recon_runs/);
      expect(SQL).toMatch(/period_id\s+uuid NOT NULL REFERENCES gl_periods\(id\)/);
    });
    it("captures bank_statement / gl / uncleared / diff cents columns", () => {
      expect(SQL).toMatch(/bank_statement_balance_cents bigint/);
      expect(SQL).toMatch(/gl_balance_cents\s+bigint/);
      expect(SQL).toMatch(/uncleared_txn_cents\s+bigint/);
      expect(SQL).toMatch(/reconciled_diff_cents\s+bigint/);
    });
    it("has UNIQUE (bank_account_id, period_id)", () => {
      expect(SQL).toMatch(/UNIQUE \(bank_account_id, period_id\)/);
    });
    it("has status enum (in_progress|reconciled|flagged)", () => {
      expect(SQL).toMatch(/status\s+text NOT NULL DEFAULT 'in_progress'/);
      expect(SQL).toMatch(/CHECK \(status IN \('in_progress','reconciled','flagged'\)\)/);
    });
  });

  describe("bank_match_audit (append-only)", () => {
    it("creates the table with FK to bank_transactions", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS bank_match_audit/);
      expect(SQL).toMatch(/bank_transaction_id uuid NOT NULL REFERENCES bank_transactions\(id\)/);
    });
    it("has action enum", () => {
      expect(SQL).toMatch(/action\s+text NOT NULL/);
      expect(SQL).toMatch(/CHECK \(action IN \('match','unmatch','create_je','ignore','manual_override','auto_post'\)\)/);
    });
    it("RLS has SELECT + INSERT but NOT UPDATE/DELETE", () => {
      expect(SQL).toMatch(/anon_all_bank_match_audit_select_insert.*FOR SELECT/s);
      expect(SQL).toMatch(/anon_insert_bank_match_audit.*FOR INSERT/s);
      expect(SQL).not.toMatch(/FOR UPDATE.*bank_match_audit/);
      expect(SQL).not.toMatch(/FOR DELETE.*bank_match_audit/);
      // Sanity: no "FOR ALL" on bank_match_audit (would allow UPDATE+DELETE)
      expect(SQL).not.toMatch(/anon_all_bank_match_audit\b.*FOR ALL/);
    });
  });

  describe("triggers + RLS + footer", () => {
    it("attaches touch triggers on all three writable tables", () => {
      expect(SQL).toMatch(/CREATE TRIGGER bank_accounts_touch_trg/);
      expect(SQL).toMatch(/CREATE TRIGGER bank_transactions_touch_trg/);
      expect(SQL).toMatch(/CREATE TRIGGER bank_recon_runs_touch_trg/);
    });
    it("enables RLS on all four new tables", () => {
      expect(SQL).toMatch(/ALTER TABLE bank_accounts\s+ENABLE ROW LEVEL SECURITY/);
      expect(SQL).toMatch(/ALTER TABLE bank_transactions\s+ENABLE ROW LEVEL SECURITY/);
      expect(SQL).toMatch(/ALTER TABLE bank_recon_runs\s+ENABLE ROW LEVEL SECURITY/);
      expect(SQL).toMatch(/ALTER TABLE bank_match_audit\s+ENABLE ROW LEVEL SECURITY/);
    });
    it("uses P1 auth_internal_* RLS template", () => {
      expect(SQL).toMatch(/auth_internal_bank_accounts/);
      expect(SQL).toMatch(/SELECT eu\.entity_id FROM entity_users eu WHERE eu\.auth_id = auth\.uid\(\)/);
    });
    it("ends with NOTIFY pgrst reload schema", () => {
      expect(SQL).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
    });
    it("is idempotent (IF NOT EXISTS + DO $$ guards on policies)", () => {
      expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS bank_accounts/);
      expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS/);
      expect(SQL).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL/);
    });
  });
});
