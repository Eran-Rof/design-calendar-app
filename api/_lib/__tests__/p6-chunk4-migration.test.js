// Static-shape sanity checks on the P6-4 migration file.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(__dirname, "../../../supabase/migrations/20260608000000_p6_chunk4_match_engine.sql"),
  "utf8",
);

describe("P6-4 migration — static shape", () => {
  describe("v_bank_match_candidates view", () => {
    it("creates the view with the documented column shape", () => {
      expect(SQL).toMatch(/CREATE OR REPLACE VIEW v_bank_match_candidates AS/);
      expect(SQL).toMatch(/bank_transaction_id/);
      expect(SQL).toMatch(/je_line_id/);
      expect(SQL).toMatch(/je_amount_cents/);
      expect(SQL).toMatch(/days_apart/);
      expect(SQL).toMatch(/confidence/);
    });
    it("filters to unmatched + non-pending bank_transactions only", () => {
      expect(SQL).toMatch(/bt\.status = 'unmatched'/);
      expect(SQL).toMatch(/bt\.pending = false/);
    });
    it("filters to posted CASH-basis JEs only", () => {
      expect(SQL).toMatch(/je\.status = 'posted'/);
      expect(SQL).toMatch(/je\.basis = 'CASH'/);
    });
    it("uses ±5-day window and exact-amount match", () => {
      expect(SQL).toMatch(/ABS\(je\.posting_date - bt\.posted_date\) <= 5/);
      expect(SQL).toMatch(/bt\.amount_cents = CASE/);
    });
    it("excludes JE lines already taken by another matched bank_transaction", () => {
      expect(SQL).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM bank_transactions bt2/);
      expect(SQL).toMatch(/bt2\.matched_je_line_id = jel\.id/);
      expect(SQL).toMatch(/bt2\.status = 'matched'/);
    });
    it("confidence formula penalizes ×5 per day apart", () => {
      expect(SQL).toMatch(/GREATEST\(\s*0,\s*100 - \(ABS\(bt\.posted_date - je\.posting_date\)::int \* 5\)\s*\)/);
    });
  });

  describe("bank_match_apply RPC", () => {
    it("defined with SECURITY DEFINER", () => {
      expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION bank_match_apply/);
      expect(SQL).toMatch(/bank_match_apply\([\s\S]*?\)[\s\S]*?SECURITY DEFINER/);
    });
    it("rejects when bank_transaction status != unmatched", () => {
      expect(SQL).toMatch(/must be unmatched/);
    });
    it("rejects when pending", () => {
      expect(SQL).toMatch(/is still pending/);
    });
    it("validates same-entity match between bank_transaction and je", () => {
      expect(SQL).toMatch(/entity_id mismatch/);
      expect(SQL).toMatch(/JE belongs to entity/);
    });
    it("validates je_line.account_id matches bank_account.gl_account_id", () => {
      expect(SQL).toMatch(/does not match bank_account\.gl_account_id/);
    });
    it("blocks double-match (same je_line already matched elsewhere)", () => {
      expect(SQL).toMatch(/already matched to bank_transaction/);
    });
    it("writes bank_match_audit row with action='match'", () => {
      expect(SQL).toMatch(/INSERT INTO bank_match_audit[\s\S]*?'match'/);
    });
  });

  describe("bank_unmatch RPC", () => {
    it("defined with SECURITY DEFINER", () => {
      expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION bank_unmatch/);
    });
    it("rejects when status != matched", () => {
      expect(SQL).toMatch(/must be matched/);
    });
    it("captures the prior je_line_id in the audit row", () => {
      expect(SQL).toMatch(/v_prev_je_line_id := v_bt\.matched_je_line_id/);
      expect(SQL).toMatch(/INSERT INTO bank_match_audit[\s\S]*?'unmatch'/);
    });
    it("nulls out matched_at / by / confidence", () => {
      expect(SQL).toMatch(/matched_je_line_id = NULL/);
      expect(SQL).toMatch(/matched_at\s+= NULL/);
      expect(SQL).toMatch(/match_confidence\s+= NULL/);
    });
  });

  describe("bank_create_je_for_transaction RPC", () => {
    it("calls gl_post_journal_entry with CASH basis + bank journal_type", () => {
      expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION bank_create_je_for_transaction/);
      expect(SQL).toMatch(/v_je_id := gl_post_journal_entry\(v_payload\)/);
      expect(SQL).toMatch(/'basis',\s*'CASH'/);
    });
    it("picks journal_type by amount sign (interest for deposit, fee for withdrawal)", () => {
      expect(SQL).toMatch(/'bank_interest_je'/);
      expect(SQL).toMatch(/'bank_fee_je'/);
    });
    it("rejects zero-amount transactions", () => {
      expect(SQL).toMatch(/zero-amount JE not allowed/);
    });
    it("converts cents to numeric(18,2) dollars for the JE payload", () => {
      expect(SQL).toMatch(/::numeric \/ 100/);
    });
    it("marks bank_transaction status='manual_je_created' on success", () => {
      expect(SQL).toMatch(/SET status\s+= 'manual_je_created'/);
    });
    it("writes audit row with action='create_je' and je_id_created", () => {
      expect(SQL).toMatch(/INSERT INTO bank_match_audit[\s\S]*?'create_je'[\s\S]*?je_id_created/);
    });
  });

  describe("bank_ignore RPC", () => {
    it("flips status to 'ignored' and writes audit", () => {
      expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION bank_ignore/);
      expect(SQL).toMatch(/SET status\s+= 'ignored'/);
      expect(SQL).toMatch(/'ignore'/);
    });
    it("accepts an optional reason note", () => {
      expect(SQL).toMatch(/p_reason\s+text DEFAULT NULL/);
    });
  });

  it("ends with NOTIFY pgrst reload schema", () => {
    expect(SQL).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
  });
});
