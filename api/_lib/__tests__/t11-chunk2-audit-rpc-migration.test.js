// Static-shape tests for T11-2 migration: audit-context RPC family.
//
// Asserts the migration file contains:
//   1. set_audit_context — 6-param signature, SECURITY DEFINER, set_config
//      calls for the six T11 session vars, search_path hardening.
//   2. void_ar_invoice_with_audit — 7-param signature (invoice_id +
//      six audit_*), updates ar_invoices.gl_status='void', returns jsonb.
//   3. void_ap_invoice_with_audit — same shape on invoices.
//   4. post_journal_entry_with_audit — flips status='posted'.
//   5. reverse_journal_entry_with_audit — flips status='reversed', stamps
//      reversed_by_je_id.
//   6. Each function has its own COMMENT ON FUNCTION (no comment-concat).
//   7. NOTIFY pgrst at the end.
//   8. Each wrapper PERFORMs set_audit_context inline.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = readFileSync(
  resolve(here, "../../../supabase/migrations/20260629B00000_t11_chunk2_audit_rpc.sql"),
  "utf8",
);

const AUDIT_SESSION_VARS = [
  "app.actor_auth_id",
  "app.actor_employee_id",
  "app.actor_display_name",
  "app.audit_source",
  "app.audit_reason",
  "app.audit_correlation_id",
];

const WRAPPER_RPCS = [
  "void_ar_invoice_with_audit",
  "void_ap_invoice_with_audit",
  "post_journal_entry_with_audit",
  "reverse_journal_entry_with_audit",
];

describe("T11-2 audit-context RPC migration", () => {
  describe("set_audit_context base function", () => {
    it("CREATE OR REPLACE FUNCTION set_audit_context with 6 params", () => {
      expect(MIG).toMatch(/CREATE OR REPLACE FUNCTION set_audit_context\(/);
      // Six p_* params expected
      expect(MIG).toMatch(/p_actor_auth_id\s+uuid/);
      expect(MIG).toMatch(/p_actor_employee_id\s+uuid/);
      expect(MIG).toMatch(/p_actor_display_name\s+text/);
      expect(MIG).toMatch(/p_audit_source\s+text/);
      expect(MIG).toMatch(/p_audit_reason\s+text/);
      expect(MIG).toMatch(/p_audit_correlation_id\s+text/);
    });

    it("returns void", () => {
      expect(MIG).toMatch(/CREATE OR REPLACE FUNCTION set_audit_context[\s\S]*?RETURNS void/);
    });

    it("is LANGUAGE plpgsql SECURITY DEFINER", () => {
      const m = MIG.match(/CREATE OR REPLACE FUNCTION set_audit_context[\s\S]*?\$\$;/);
      expect(m).toBeTruthy();
      expect(m[0]).toMatch(/LANGUAGE plpgsql/);
      expect(m[0]).toMatch(/SECURITY DEFINER/);
      expect(m[0]).toMatch(/SET search_path = public, pg_temp/);
    });

    for (const v of AUDIT_SESSION_VARS) {
      it(`calls set_config('${v}', ...)`, () => {
        const re = new RegExp(
          `set_config\\(\\s*'${v.replace(/\./g, "\\.")}'`,
        );
        expect(MIG).toMatch(re);
      });
    }

    it("uses is_local=true for every set_config in the migration body", () => {
      // Each set_audit_context body has one PERFORM set_config(...) per
      // session var (six total). Each call spans two lines:
      //   PERFORM set_config('app.x',
      //                      coalesce(p_x::text, ''), true);
      // Collapse whitespace and check that we have six calls each ending
      // with ", true);".
      const collapsed = MIG.replace(/\s+/g, " ");
      const calls = collapsed.match(/PERFORM set_config\([^;]+;/g) || [];
      expect(calls.length).toBe(AUDIT_SESSION_VARS.length);
      for (const c of calls) {
        expect(c).toMatch(/,\s*true\s*\)\s*;\s*$/);
      }
    });

    it("coalesces null uuid/text params to empty string", () => {
      // set_config requires text — uuid params must be cast + coalesced
      expect(MIG).toMatch(/coalesce\(p_actor_auth_id::text, ''\)/);
      expect(MIG).toMatch(/coalesce\(p_actor_employee_id::text, ''\)/);
      expect(MIG).toMatch(/coalesce\(p_actor_display_name, ''\)/);
      expect(MIG).toMatch(/coalesce\(p_audit_reason, ''\)/);
    });
  });

  describe("wrapper RPC signatures", () => {
    for (const rpc of WRAPPER_RPCS) {
      it(`defines ${rpc} as CREATE OR REPLACE FUNCTION`, () => {
        const re = new RegExp(`CREATE OR REPLACE FUNCTION ${rpc}\\(`);
        expect(MIG).toMatch(re);
      });

      it(`${rpc} takes six audit_* params`, () => {
        const sliceRe = new RegExp(
          `CREATE OR REPLACE FUNCTION ${rpc}\\(([\\s\\S]*?)\\)`,
        );
        const m = MIG.match(sliceRe);
        expect(m).toBeTruthy();
        const sig = m[1];
        expect(sig).toMatch(/audit_actor_auth_id\s+uuid/);
        expect(sig).toMatch(/audit_actor_employee_id\s+uuid/);
        expect(sig).toMatch(/audit_actor_display_name\s+text/);
        expect(sig).toMatch(/audit_source\s+text/);
        expect(sig).toMatch(/audit_reason\s+text/);
        expect(sig).toMatch(/audit_correlation_id\s+text/);
      });

      it(`${rpc} is SECURITY DEFINER with hardened search_path`, () => {
        const re = new RegExp(
          `CREATE OR REPLACE FUNCTION ${rpc}[\\s\\S]*?\\$\\$;`,
        );
        const m = MIG.match(re);
        expect(m).toBeTruthy();
        expect(m[0]).toMatch(/SECURITY DEFINER/);
        expect(m[0]).toMatch(/SET search_path = public, pg_temp/);
      });

      it(`${rpc} PERFORMs set_audit_context inline (same statement, same conn)`, () => {
        const re = new RegExp(
          `CREATE OR REPLACE FUNCTION ${rpc}[\\s\\S]*?PERFORM set_audit_context\\(`,
        );
        expect(MIG).toMatch(re);
      });

      it(`${rpc} returns jsonb`, () => {
        const re = new RegExp(
          `CREATE OR REPLACE FUNCTION ${rpc}\\([\\s\\S]*?\\)\\s*RETURNS jsonb`,
        );
        expect(MIG).toMatch(re);
      });

      it(`${rpc} has its own COMMENT ON FUNCTION (no concat)`, () => {
        const re = new RegExp(`COMMENT ON FUNCTION ${rpc}\\(`);
        expect(MIG).toMatch(re);
      });
    }
  });

  describe("void_ar_invoice_with_audit business logic", () => {
    it("takes invoice_id uuid as first param", () => {
      expect(MIG).toMatch(/void_ar_invoice_with_audit\(\s*\n?\s*invoice_id\s+uuid/);
    });
    it("locks ar_invoices row FOR UPDATE", () => {
      expect(MIG).toMatch(/SELECT \* INTO v_inv FROM ar_invoices WHERE id = invoice_id FOR UPDATE/);
    });
    it("raises on not-found", () => {
      expect(MIG).toMatch(/RAISE EXCEPTION 'ar_invoice not found:/);
    });
    it("raises on already-void", () => {
      expect(MIG).toMatch(/RAISE EXCEPTION 'ar_invoice % is already void/);
    });
    it("UPDATE ar_invoices SET gl_status = 'void'", () => {
      expect(MIG).toMatch(/UPDATE ar_invoices\s+SET gl_status = 'void'/);
    });
  });

  describe("void_ap_invoice_with_audit business logic", () => {
    it("locks invoices row FOR UPDATE", () => {
      expect(MIG).toMatch(/SELECT \* INTO v_inv FROM invoices WHERE id = invoice_id FOR UPDATE/);
    });
    it("UPDATE invoices SET gl_status = 'void'", () => {
      expect(MIG).toMatch(/UPDATE invoices\s+SET gl_status = 'void'/);
    });
    it("raises on already-void", () => {
      expect(MIG).toMatch(/RAISE EXCEPTION 'ap_invoice % is already void/);
    });
  });

  describe("post_journal_entry_with_audit business logic", () => {
    it("takes je_id uuid as first param", () => {
      expect(MIG).toMatch(/post_journal_entry_with_audit\(\s*\n?\s*je_id\s+uuid/);
    });
    it("locks journal_entries FOR UPDATE", () => {
      expect(MIG).toMatch(/SELECT \* INTO v_je FROM journal_entries WHERE id = je_id FOR UPDATE/);
    });
    it("flips status='posted'", () => {
      expect(MIG).toMatch(/UPDATE journal_entries\s+SET status\s*=\s*'posted'/);
    });
    it("stamps posted_at via COALESCE", () => {
      expect(MIG).toMatch(/posted_at\s*=\s*COALESCE\(posted_at, now\(\)\)/);
    });
    it("rejects re-posting an already-posted JE", () => {
      expect(MIG).toMatch(/RAISE EXCEPTION 'journal_entry % is already posted/);
    });
    it("rejects post from non-draft/non-pending status", () => {
      expect(MIG).toMatch(/RAISE EXCEPTION 'journal_entry % cannot be posted from status %/);
    });
  });

  describe("reverse_journal_entry_with_audit business logic", () => {
    it("takes je_id and reversal_je_id uuids", () => {
      expect(MIG).toMatch(/reverse_journal_entry_with_audit\(\s*\n?\s*je_id\s+uuid,\s*\n?\s*reversal_je_id\s+uuid/);
    });
    it("flips status='reversed'", () => {
      expect(MIG).toMatch(/UPDATE journal_entries\s+SET status\s*=\s*'reversed'/);
    });
    it("stamps reversed_by_je_id via COALESCE", () => {
      expect(MIG).toMatch(/reversed_by_je_id\s*=\s*COALESCE\(reversal_je_id, reversed_by_je_id\)/);
    });
    it("rejects reverse on already-reversed JE", () => {
      expect(MIG).toMatch(/RAISE EXCEPTION 'journal_entry % is already reversed/);
    });
    it("rejects reverse from non-posted status", () => {
      expect(MIG).toMatch(/RAISE EXCEPTION 'journal_entry % cannot be reversed from status %/);
    });
  });

  describe("migration housekeeping", () => {
    it("ends with NOTIFY pgrst, 'reload schema'", () => {
      expect(MIG).toMatch(/NOTIFY pgrst,\s*'reload schema'/);
    });

    it("uses CREATE OR REPLACE (idempotent) for every function", () => {
      const count = (MIG.match(/CREATE OR REPLACE FUNCTION/g) || []).length;
      // set_audit_context + 4 wrappers
      expect(count).toBe(5);
    });

    it("has a COMMENT ON FUNCTION for every function", () => {
      // Filter out the header documentation comment that mentions
      // "COMMENT ON FUNCTION" inside a -- comment line. We only count
      // statement-level COMMENT ON FUNCTION lines.
      const lines = MIG.split("\n");
      const stmtLines = lines.filter(
        (l) => l.trimStart().startsWith("COMMENT ON FUNCTION"),
      );
      expect(stmtLines.length).toBe(5);
    });

    it("does not concat comment strings (T11 hard-rule)", () => {
      // Disallow patterns like 'foo' || 'bar' inside a COMMENT ON FUNCTION.
      const commentBlocks = MIG.match(/COMMENT ON FUNCTION[\s\S]*?;/g) || [];
      for (const block of commentBlocks) {
        // Strip the leading IS '...' opener — we look for string-concat ops in the comment body.
        expect(block).not.toMatch(/'[^']*'\s*\|\|\s*'/);
      }
    });

    it("documents the T11-2 chunk identifier in the header", () => {
      expect(MIG).toMatch(/Tangerine T11-2/);
    });

    it("references row_changes ledger context in the header", () => {
      expect(MIG).toMatch(/row_changes/);
    });
  });
});
