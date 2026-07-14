// Tests for the Month-End Close checks scoping + clarity work (#NNNN /
// migration 20260998000000):
//   1. isBlockingStatus — only rich status 'fail' hard-blocks a close.
//   2. upsertAutoItems — persists the rich verdict/severity/explanation/
//      recommendation into detail while mapping the stored status column to
//      pass/fail (blocking semantics) so warn + waived never block.
//   3. Static shape of the migration — as-of scoping on both tie sides,
//      pre-AR-history / non-cash-relief / not-operated classifications,
//      true-statement-account bank predicate, and the rich JSONB fields.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isBlockingStatus, upsertAutoItems } from "../closeChecklist.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(
  __dirname,
  "../../../../supabase/migrations/20260998000000_close_checks_scoping_and_clarity.sql",
);
const SQL = readFileSync(MIGRATION_PATH, "utf8");

describe("isBlockingStatus", () => {
  it("only 'fail' blocks; pass/warn/waived are non-blocking", () => {
    expect(isBlockingStatus("fail")).toBe(true);
    expect(isBlockingStatus("pass")).toBe(false);
    expect(isBlockingStatus("warn")).toBe(false);
    expect(isBlockingStatus("waived")).toBe(false);
    expect(isBlockingStatus(undefined)).toBe(false);
  });
});

describe("upsertAutoItems — rich verdict persistence + blocking map", () => {
  function fakeAdmin() {
    const captured = { rows: null };
    return {
      captured,
      from() {
        return {
          async upsert(rows) {
            captured.rows = rows;
            return { error: null };
          },
        };
      },
    };
  }

  const rpcResult = {
    ran_at: "2026-07-14T00:00:00.000Z",
    checks: [
      { item_key: "gl_balanced", title: "GL balanced", status: "pass", severity: "informational",
        explanation: "balances", recommendation: "No action needed.", detail: { accrual_imbalance_cents: 0 } },
      { item_key: "ar_subledger_tie", title: "AR subledger ties to GL (1105 / 1107 / 1108)", status: "waived",
        severity: "advisory", explanation: "pre-history", recommendation: "close with exception", detail: { as_of: "2024-08-31" } },
      { item_key: "ap_subledger_tie", title: "AP subledger ties to GL (2000)", status: "warn",
        severity: "advisory", explanation: "residual", recommendation: "review", detail: { diff_cents: -1 } },
      { item_key: "no_draft_jes", title: "No draft / unposted journal entries", status: "fail",
        severity: "blocker", explanation: "2 drafts", recommendation: "post them", detail: { draft_je_count: 2 } },
    ],
  };

  it("maps only 'fail' to stored 'fail'; waived/warn/pass → stored 'pass'", async () => {
    const admin = fakeAdmin();
    const n = await upsertAutoItems(admin, "ent", "cp", rpcResult);
    expect(n).toBe(4);
    const byKey = Object.fromEntries(admin.captured.rows.map((r) => [r.item_key, r]));
    expect(byKey.gl_balanced.status).toBe("pass");
    expect(byKey.ar_subledger_tie.status).toBe("pass"); // waived → non-blocking
    expect(byKey.ap_subledger_tie.status).toBe("pass"); // warn → non-blocking
    expect(byKey.no_draft_jes.status).toBe("fail"); // real blocker
  });

  it("carries the rich classification + plain-language prose into detail", async () => {
    const admin = fakeAdmin();
    await upsertAutoItems(admin, "ent", "cp", rpcResult);
    const ar = admin.captured.rows.find((r) => r.item_key === "ar_subledger_tie");
    expect(ar.detail.classification).toBe("waived");
    expect(ar.detail.severity).toBe("advisory");
    expect(ar.detail.explanation).toBe("pre-history");
    expect(ar.detail.recommendation).toBe("close with exception");
    expect(ar.detail.as_of).toBe("2024-08-31"); // original detail preserved
    expect(ar.label).toBe("AR subledger ties to GL (1105 / 1107 / 1108)");
  });
});

describe("migration 20260998000000 — static shape", () => {
  it("recreates the RPC idempotently, STABLE, same signature", () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION public\.close_run_auto_checks\(p_entity_id uuid, p_period_id uuid\)/);
    expect(SQL).toMatch(/\bSTABLE\b/);
  });

  it("scopes BOTH tie sides to period-end (posting_date / receipt_date / payment_date <= ends_on)", () => {
    expect(SQL).toMatch(/je\.posting_date <= v_ends/);
    expect(SQL).toMatch(/r\.receipt_date <= v_ends/);
    expect(SQL).toMatch(/ip\.payment_date <= v_ends/);
    expect(SQL).toMatch(/ai\.posting_date <= v_ends/);
    expect(SQL).toMatch(/inv\.posting_date <= v_ends/);
  });

  it("classifies pre-AR-history, non-cash AP relief, and not-operated bank rec", () => {
    expect(SQL).toContain("pre_ar_history");
    expect(SQL).toContain("ap_noncash_gl_relief_residual");
    expect(SQL).toContain("not_operated");
  });

  it("restricts bank rec to true statement accounts and uses the human-operated signal", () => {
    expect(SQL).toMatch(/account_kind IN \('checking','credit_card'\)/);
    expect(SQL).toMatch(/reconciled_by_user_id IS NOT NULL/);
  });

  it("emits the rich JSONB clarity fields on the checks", () => {
    for (const field of ["'title'", "'severity'", "'explanation'", "'recommendation'", "'classification'"]) {
      expect(SQL).toContain(field);
    }
    // rich statuses reachable
    expect(SQL).toContain("'waived'");
    expect(SQL).toContain("'warn'");
  });

  it("keeps a one-cent tolerance and a money formatter for prose", () => {
    expect(SQL).toMatch(/close_fmt_usd/);
    expect(SQL).toMatch(/<= 1/);
  });
});
