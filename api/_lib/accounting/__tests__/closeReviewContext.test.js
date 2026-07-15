import { describe, it, expect } from "vitest";
import {
  monthLabel,
  nextMonthStart,
  chargebacksContext,
  bankContext,
  factorContext,
  payrollContext,
  depreciationContext,
  controllerContext,
  buildManualReviewContext,
  glBalancedContext,
  arTieContext,
  apTieContext,
  bankReconContext,
  draftJesContext,
  uncat8007Context,
  factorReconContext,
  revenuePostedContext,
  resolve8007AccountId,
  buildAutoReviewContext,
} from "../closeReviewContext.js";

// ── A chainable supabase double ──────────────────────────────────────────────
// Records the filter chain so we can assert the query SHAPE (head:true counts,
// the columns / equalities used), and resolves to a queued response. Every
// filter returns the builder; awaiting it (or reading .count) yields `next`.
function makeAdmin(responses) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, select: null, opts: null, eq: {}, gte: null, lt: null, maybeSingle: false, limit: null };
      calls.push(call);
      const next = (responses[table] || []).shift() || { data: [], count: 0, error: null };
      const chain = {
        select: (cols, opts) => { call.select = cols; call.opts = opts || null; return chain; },
        eq: (col, val) => { call.eq[col] = val; return chain; },
        gte: (col, val) => { call.gte = { col, val }; return chain; },
        lt: (col, val) => { call.lt = { col, val }; return chain; },
        limit: (n) => { call.limit = n; return chain; },
        maybeSingle: () => { call.maybeSingle = true; return Promise.resolve(next); },
        then: (resolve) => resolve(next),
      };
      return chain;
    },
  };
}

describe("date helpers", () => {
  it("monthLabel → US MM/YYYY", () => {
    expect(monthLabel("2026-05")).toBe("05/2026");
  });
  it("nextMonthStart → first of the following month, rolling the year", () => {
    expect(nextMonthStart("2026-05")).toBe("2026-06-01");
    expect(nextMonthStart("2026-12")).toBe("2027-01-01");
  });
});

describe("chargebacksContext", () => {
  it("uses a head:true count scoped by entity + report_month + open disposition", async () => {
    const admin = makeAdmin({ factor_chargebacks: [{ count: 3, error: null }] });
    const ctx = await chargebacksContext(admin, "ent-1", "2026-05-01", "05/2026");
    expect(ctx.panel).toBe("chargebacks");
    expect(ctx.count).toBe(3);
    expect(ctx.severity).toBe("warn");
    expect(ctx.summary).toBe("3 open chargebacks to review for 05/2026");
    expect(ctx.drill).toEqual({ cb_disposition: "open", cb_month: "2026-05" });

    const call = admin.calls[0];
    expect(call.table).toBe("factor_chargebacks");
    expect(call.opts).toEqual({ count: "exact", head: true });
    expect(call.eq).toEqual({ entity_id: "ent-1", report_month: "2026-05-01", disposition: "open" });
  });

  it("zero open → info, singular grammar handled", async () => {
    const admin = makeAdmin({ factor_chargebacks: [{ count: 0, error: null }] });
    const ctx = await chargebacksContext(admin, "ent-1", "2026-05-01", "05/2026");
    expect(ctx.severity).toBe("info");
    expect(ctx.summary).toBe("No open chargebacks for 05/2026");
  });

  it("one open → singular noun", async () => {
    const admin = makeAdmin({ factor_chargebacks: [{ count: 1, error: null }] });
    const ctx = await chargebacksContext(admin, "ent-1", "2026-05-01", "05/2026");
    expect(ctx.summary).toBe("1 open chargeback to review for 05/2026");
  });

  it("db error → graceful summary, never throws", async () => {
    const admin = makeAdmin({ factor_chargebacks: [{ count: null, error: { message: "boom" } }] });
    const ctx = await chargebacksContext(admin, "ent-1", "2026-05-01", "05/2026");
    expect(ctx.panel).toBe("chargebacks");
    expect(ctx.summary).toMatch(/unavailable/i);
  });
});

describe("bankContext", () => {
  it("head:true count of unmatched txns scoped by posted_date range", async () => {
    const admin = makeAdmin({ bank_transactions: [{ count: 4, error: null }] });
    const ctx = await bankContext(admin, "ent-1", "2026-05-01", "2026-06-01", "05/2026");
    expect(ctx.panel).toBe("bank_reconciliation");
    expect(ctx.count).toBe(4);
    expect(ctx.severity).toBe("warn");
    expect(ctx.summary).toBe("4 unreconciled bank transactions in 05/2026");

    const call = admin.calls[0];
    expect(call.opts).toEqual({ count: "exact", head: true });
    expect(call.eq).toEqual({ entity_id: "ent-1", status: "unmatched" });
    expect(call.gte).toEqual({ col: "posted_date", val: "2026-05-01" });
    expect(call.lt).toEqual({ col: "posted_date", val: "2026-06-01" });
  });

  it("zero unmatched → info", async () => {
    const admin = makeAdmin({ bank_transactions: [{ count: 0, error: null }] });
    const ctx = await bankContext(admin, "ent-1", "2026-05-01", "2026-06-01", "05/2026");
    expect(ctx.severity).toBe("info");
    expect(ctx.summary).toBe("All bank transactions reconciled in 05/2026");
  });
});

describe("factorContext", () => {
  it("statement present → info, ties to GL 1107", async () => {
    const admin = makeAdmin({ factor_statements: [{ data: { id: "s1", ending_net_oar_cents: 12345678 }, error: null }] });
    const ctx = await factorContext(admin, "ent-1", "2026-05-01", "05/2026");
    expect(ctx.panel).toBe("factor_recon");
    expect(ctx.count).toBe(1);
    expect(ctx.severity).toBe("info");
    expect(ctx.summary).toContain("Factor statement for 05/2026 imported");
    expect(ctx.summary).toContain("$123,456.78");

    const call = admin.calls[0];
    expect(call.maybeSingle).toBe(true);
    expect(call.eq).toEqual({ entity_id: "ent-1", statement_month: "2026-05-01" });
  });

  it("no statement → warn", async () => {
    const admin = makeAdmin({ factor_statements: [{ data: null, error: null }] });
    const ctx = await factorContext(admin, "ent-1", "2026-05-01", "05/2026");
    expect(ctx.count).toBe(0);
    expect(ctx.severity).toBe("warn");
    expect(ctx.summary).toBe("No factor statement imported for 05/2026 yet");
  });
});

describe("payrollContext", () => {
  it("head:true count of posted payroll JEs scoped by posting_date", async () => {
    const admin = makeAdmin({ journal_entries: [{ count: 2, error: null }] });
    const ctx = await payrollContext(admin, "ent-1", "2026-05-01", "2026-06-01", "05/2026");
    expect(ctx.panel).toBe("journal_entries");
    expect(ctx.count).toBe(2);
    expect(ctx.severity).toBe("info");
    expect(ctx.summary).toBe("2 payroll JEs posted in 05/2026");

    const call = admin.calls[0];
    expect(call.opts).toEqual({ count: "exact", head: true });
    expect(call.eq).toEqual({ entity_id: "ent-1", source_module: "payroll", status: "posted" });
    expect(call.gte).toEqual({ col: "posting_date", val: "2026-05-01" });
    expect(call.lt).toEqual({ col: "posting_date", val: "2026-06-01" });
  });

  it("no payroll JE → warn", async () => {
    const admin = makeAdmin({ journal_entries: [{ count: 0, error: null }] });
    const ctx = await payrollContext(admin, "ent-1", "2026-05-01", "2026-06-01", "05/2026");
    expect(ctx.severity).toBe("warn");
    expect(ctx.summary).toBe("No payroll JE booked for 05/2026");
  });
});

describe("depreciationContext", () => {
  it("schedule rows → totals the amount and counts assets, entity-scoped via join", async () => {
    const admin = makeAdmin({
      fixed_asset_depreciation: [{
        data: [
          { amount_cents: 10000, fixed_assets: { entity_id: "ent-1" } },
          { amount_cents: 5000, fixed_assets: { entity_id: "ent-1" } },
        ],
        error: null,
      }],
    });
    const ctx = await depreciationContext(admin, "ent-1", "2026-05-01", "2026-06-01", "05/2026");
    expect(ctx.panel).toBe("fixed_assets");
    expect(ctx.count).toBe(2);
    expect(ctx.summary).toContain("$150.00");
    expect(ctx.summary).toContain("2 assets");

    const call = admin.calls[0];
    expect(call.eq).toEqual({ "fixed_assets.entity_id": "ent-1" });
    expect(call.gte).toEqual({ col: "period_date", val: "2026-05-01" });
    expect(call.lt).toEqual({ col: "period_date", val: "2026-06-01" });
    expect(call.limit).toBe(1000);
  });

  it("no schedule → info 'no depreciation'", async () => {
    const admin = makeAdmin({ fixed_asset_depreciation: [{ data: [], error: null }] });
    const ctx = await depreciationContext(admin, "ent-1", "2026-05-01", "2026-06-01", "05/2026");
    expect(ctx.count).toBe(0);
    expect(ctx.summary).toBe("No depreciation scheduled for 05/2026");
  });
});

describe("controllerContext", () => {
  it("no items → generic final-attestation summary, no panel", () => {
    const ctx = controllerContext([]);
    expect(ctx.panel).toBeNull();
    expect(ctx.severity).toBe("info");
    expect(ctx.summary).toMatch(/final attestation/i);
  });

  it("all clear → ready to certify", () => {
    const items = [
      { kind: "auto", item_key: "gl_balanced", status: "pass" },
      { kind: "manual", item_key: "payroll_booked", status: "signed_off" },
      { kind: "manual", item_key: "controller_signoff", status: "pending" },
    ];
    const ctx = controllerContext(items);
    expect(ctx.count).toBe(0);
    expect(ctx.severity).toBe("info");
    expect(ctx.summary).toMatch(/ready to certify/i);
  });

  it("counts auto blockers + unsigned prior manual items (excludes itself)", () => {
    const items = [
      { kind: "auto", item_key: "gl_balanced", status: "fail" },
      { kind: "auto", item_key: "bank_recon", status: "pass" },
      { kind: "manual", item_key: "payroll_booked", status: "pending" },
      { kind: "manual", item_key: "chargebacks_reviewed", status: "signed_off" },
      { kind: "manual", item_key: "controller_signoff", status: "pending" },
    ];
    const ctx = controllerContext(items);
    expect(ctx.count).toBe(2); // 1 blocker + 1 unsigned manual
    expect(ctx.severity).toBe("warn");
    expect(ctx.summary).toContain("Resolve 2 outstanding items");
  });
});

describe("buildManualReviewContext", () => {
  it("returns a context for every manual key, defaulting starts_on from month", async () => {
    const admin = makeAdmin({
      factor_chargebacks: [{ count: 0, error: null }],
      bank_transactions: [{ count: 0, error: null }],
      factor_statements: [{ data: null, error: null }],
      journal_entries: [{ count: 1, error: null }],
      fixed_asset_depreciation: [{ data: [], error: null }],
    });
    const map = await buildManualReviewContext(admin, "ent-1", { starts_on: "2026-05-01" }, "2026-05", []);
    expect(Object.keys(map).sort()).toEqual([
      "bank_statements_reviewed",
      "chargebacks_reviewed",
      "controller_signoff",
      "depreciation_booked",
      "factor_statement_reconciled",
      "payroll_booked",
    ]);
    expect(map.chargebacks_reviewed.panel).toBe("chargebacks");
    expect(map.bank_statements_reviewed.panel).toBe("bank_reconciliation");
    expect(map.factor_statement_reconciled.panel).toBe("factor_recon");
    expect(map.payroll_booked.panel).toBe("journal_entries");
    expect(map.depreciation_booked.panel).toBe("fixed_assets");
    expect(map.controller_signoff.panel).toBeNull();
  });
});

// ── AUTO-check review context ────────────────────────────────────────────────

describe("glBalancedContext", () => {
  it("balanced → Journal Entries panel, info severity", () => {
    const ctx = glBalancedContext(
      { accrual_imbalance_cents: 0, cash_imbalance_cents: 0, posted_je_count: 12, classification: "pass" },
      "05/2026",
    );
    expect(ctx.panel).toBe("journal_entries");
    expect(ctx.count).toBe(12);
    expect(ctx.severity).toBe("info");
    expect(ctx.summary).toBe("Debits equal credits across 12 posted JEs in 05/2026");
  });

  it("imbalance + fail classification → critical, shows both figures", () => {
    const ctx = glBalancedContext(
      { accrual_imbalance_cents: 250, cash_imbalance_cents: -100, posted_je_count: 1, classification: "fail" },
      "05/2026",
    );
    expect(ctx.severity).toBe("critical");
    expect(ctx.summary).toContain("ACCRUAL off $2.50");
    expect(ctx.summary).toContain("CASH off -$1.00");
    expect(ctx.summary).toContain("1 posted JE ");
  });

  it("missing detail → graceful, panel still set", () => {
    const ctx = glBalancedContext(null, "05/2026");
    expect(ctx.panel).toBe("journal_entries");
    expect(ctx.summary).toBe("Debits equal credits across 0 posted JEs in 05/2026");
  });
});

describe("arTieContext", () => {
  it("off accounts → AR Aging panel, lists offenders, counts them", () => {
    const ctx = arTieContext(
      {
        classification: "warn",
        accounts: [
          { account_code: "1105", diff_cents: 5000, ok: false },
          { account_code: "1107", diff_cents: 0, ok: true },
          { account_code: "1108", diff_cents: -300, ok: false },
        ],
      },
      "05/2026",
    );
    expect(ctx.panel).toBe("ar_aging");
    expect(ctx.count).toBe(2);
    expect(ctx.severity).toBe("warn");
    expect(ctx.summary).toContain("1105 off $50.00");
    expect(ctx.summary).toContain("1108 off -$3.00");
    expect(ctx.summary).not.toContain("1107");
  });

  it("all tie → ties summary, count 0", () => {
    const ctx = arTieContext(
      { classification: "pass", accounts: [{ account_code: "1105", diff_cents: 0, ok: true }] },
      "05/2026",
    );
    expect(ctx.count).toBe(0);
    expect(ctx.summary).toBe("AR subledger ties to GL (1105 / 1107 / 1108) as of 05/2026");
  });
});

describe("apTieContext", () => {
  it("waived → AP Aging panel, notes waiver", () => {
    const ctx = apTieContext(
      { classification: "waived", gl_cents: 100000, subledger_cents: 100000, diff_cents: 0, waived: true },
      "05/2026",
    );
    expect(ctx.panel).toBe("ap_aging");
    expect(ctx.severity).toBe("info");
    expect(ctx.summary).toContain("payments ledger not live");
  });

  it("in tie → ties summary, count 0", () => {
    const ctx = apTieContext(
      { classification: "pass", gl_cents: 5000, subledger_cents: 5000, diff_cents: 0 },
      "05/2026",
    );
    expect(ctx.count).toBe(0);
    expect(ctx.summary).toBe("AP subledger ties to GL 2000 for 05/2026");
  });
});

describe("bankReconContext", () => {
  it("partial → Bank Reconciliation panel, unreconciled count", () => {
    const ctx = bankReconContext({ classification: "fail", runs: 3, reconciled: 1 }, "05/2026");
    expect(ctx.panel).toBe("bank_reconciliation");
    expect(ctx.count).toBe(2);
    expect(ctx.severity).toBe("critical");
    expect(ctx.summary).toBe("1/3 bank/CC account-months reconciled for 05/2026");
  });

  it("waived (not operated) → notes Xoro", () => {
    const ctx = bankReconContext({ classification: "waived", runs: 0, reconciled: 0, waiver: "not_operated" }, "05/2026");
    expect(ctx.count).toBe(0);
    expect(ctx.summary).toContain("not yet operated in Tangerine");
  });
});

describe("draftJesContext", () => {
  it("drafts present → filtered drill include_drafts", () => {
    const ctx = draftJesContext({ classification: "fail", draft_je_count: 4 }, "05/2026");
    expect(ctx.panel).toBe("journal_entries");
    expect(ctx.count).toBe(4);
    expect(ctx.drill).toEqual({ include_drafts: "true" });
    expect(ctx.summary).toBe("4 draft/unposted JEs to post or delete in 05/2026");
  });

  it("no drafts → no drill", () => {
    const ctx = draftJesContext({ classification: "pass", draft_je_count: 0 }, "05/2026");
    expect(ctx.drill).toBeUndefined();
    expect(ctx.summary).toBe("No draft/unposted JEs in 05/2026");
  });
});

describe("uncat8007Context", () => {
  it("activity + resolved account → GL Detail drill", () => {
    const drill = { account_id: "acct-8007", from: "2026-05-01", to: "2026-05-31" };
    const ctx = uncat8007Context({ classification: "warn", accrual_net_cents: 123400, line_count: 7 }, "05/2026", drill);
    expect(ctx.panel).toBe("gl_detail");
    expect(ctx.count).toBe(7);
    expect(ctx.drill).toEqual(drill);
    expect(ctx.summary).toContain("8007 activity $1,234.00 across 7 lines");
  });

  it("no activity → no drill even if one is offered", () => {
    const ctx = uncat8007Context({ classification: "pass", accrual_net_cents: 0, line_count: 0 }, "05/2026", { account_id: "x" });
    expect(ctx.drill).toBeUndefined();
    expect(ctx.summary).toBe("No Uncategorized Expense (8007) activity in 05/2026");
  });
});

describe("factorReconContext", () => {
  it("not covered → Factor panel, no coverage", () => {
    const ctx = factorReconContext({ classification: "pass", covered: false }, "05/2026");
    expect(ctx.panel).toBe("factor_recon");
    expect(ctx.count).toBe(0);
    expect(ctx.summary).toBe("No factor statement covers 05/2026");
  });

  it("diff → shows OAR vs GL 1107", () => {
    const ctx = factorReconContext(
      { classification: "warn", covered: true, ending_net_oar_cents: 500000, gl_1107_asof_cents: 490000, diff_cents: 10000 },
      "05/2026",
    );
    expect(ctx.count).toBe(1);
    expect(ctx.severity).toBe("warn");
    expect(ctx.summary).toContain("Factor Net OAR $5,000.00 vs GL 1107 $4,900.00 → off $100.00");
  });
});

describe("revenuePostedContext", () => {
  it("Income Statement panel, revenue figure", () => {
    const ctx = revenuePostedContext({ classification: "pass", revenue_cents: 987654 }, "05/2026");
    expect(ctx.panel).toBe("income_statement");
    expect(ctx.summary).toBe("Revenue posted $9,876.54 for 05/2026");
  });
});

describe("resolve8007AccountId", () => {
  it("returns the account id for code 8007, entity-scoped", async () => {
    const admin = makeAdmin({ gl_accounts: [{ data: { id: "acct-8007" }, error: null }] });
    const id = await resolve8007AccountId(admin, "ent-1");
    expect(id).toBe("acct-8007");
    const call = admin.calls[0];
    expect(call.table).toBe("gl_accounts");
    expect(call.eq).toEqual({ entity_id: "ent-1", code: "8007" });
    expect(call.maybeSingle).toBe(true);
  });

  it("missing / error → null (drill just opens unfiltered)", async () => {
    const admin = makeAdmin({ gl_accounts: [{ data: null, error: null }] });
    expect(await resolve8007AccountId(admin, "ent-1")).toBeNull();
  });
});

describe("buildAutoReviewContext", () => {
  const autoItems = [
    { item_key: "gl_balanced", detail: { classification: "pass", posted_je_count: 5, accrual_imbalance_cents: 0, cash_imbalance_cents: 0 } },
    { item_key: "ar_subledger_tie", detail: { classification: "pass", accounts: [] } },
    { item_key: "ap_subledger_tie", detail: { classification: "pass", diff_cents: 0 } },
    { item_key: "bank_recon", detail: { classification: "pass", runs: 2, reconciled: 2 } },
    { item_key: "no_draft_jes", detail: { classification: "pass", draft_je_count: 0 } },
    { item_key: "uncategorized_8007", detail: { classification: "warn", line_count: 3, accrual_net_cents: 5000 } },
    { item_key: "factor_recon", detail: { classification: "pass", covered: false } },
    { item_key: "revenue_posted", detail: { classification: "pass", revenue_cents: 100000 } },
  ];

  it("maps every auto key to its panel and resolves the 8007 drill when there is activity", async () => {
    const admin = makeAdmin({ gl_accounts: [{ data: { id: "acct-8007" }, error: null }] });
    const map = await buildAutoReviewContext(admin, "ent-1", { starts_on: "2026-05-01", ends_on: "2026-05-31" }, "2026-05", autoItems);
    expect(Object.keys(map).sort()).toEqual([
      "ap_subledger_tie",
      "ar_subledger_tie",
      "bank_recon",
      "factor_recon",
      "gl_balanced",
      "no_draft_jes",
      "revenue_posted",
      "uncategorized_8007",
    ]);
    expect(map.gl_balanced.panel).toBe("journal_entries");
    expect(map.ar_subledger_tie.panel).toBe("ar_aging");
    expect(map.ap_subledger_tie.panel).toBe("ap_aging");
    expect(map.bank_recon.panel).toBe("bank_reconciliation");
    expect(map.no_draft_jes.panel).toBe("journal_entries");
    expect(map.uncategorized_8007.panel).toBe("gl_detail");
    expect(map.factor_recon.panel).toBe("factor_recon");
    expect(map.revenue_posted.panel).toBe("income_statement");
    // 8007 has activity → account id was looked up and drill seeded with period range.
    expect(admin.calls[0].table).toBe("gl_accounts");
    expect(map.uncategorized_8007.drill).toEqual({ account_id: "acct-8007", from: "2026-05-01", to: "2026-05-31" });
  });

  it("skips the 8007 account lookup entirely when there is no 8007 activity", async () => {
    const admin = makeAdmin({ gl_accounts: [{ data: { id: "acct-8007" }, error: null }] });
    const noActivity = autoItems.map((i) =>
      i.item_key === "uncategorized_8007" ? { ...i, detail: { classification: "pass", line_count: 0, accrual_net_cents: 0 } } : i,
    );
    const map = await buildAutoReviewContext(admin, "ent-1", { starts_on: "2026-05-01", ends_on: "2026-05-31" }, "2026-05", noActivity);
    expect(admin.calls.length).toBe(0); // no DB touch at all
    expect(map.uncategorized_8007.drill).toBeUndefined();
  });

  it("missing items → every key still present with a graceful summary", async () => {
    const admin = makeAdmin({});
    const map = await buildAutoReviewContext(admin, "ent-1", { starts_on: "2026-05-01", ends_on: "2026-05-31" }, "2026-05", []);
    expect(Object.keys(map).length).toBe(8);
    expect(map.gl_balanced.panel).toBe("journal_entries");
    expect(map.revenue_posted.summary).toContain("Revenue posted $0.00");
  });
});
