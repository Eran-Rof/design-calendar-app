// Tests for the Tangerine P9-5 GL reconciliation engine.
//
// Architecture: docs/tangerine/P9-parallel-run-architecture.md §3.5 + §4.3.
// Schema:       supabase/migrations/20260629800000_p9_chunk1_recon_schema.sql
//
// All tests run against an in-memory supabase double — no live DB.

import { describe, it, expect } from "vitest";
import {
  runGlReconciliation,
  dollarsToCents,
  buildGroupKey,
  validateArgs,
  bucketByAccount,
  splitBuckets,
  matchBuckets,
  applyThresholds,
  readSiblingDomainStatuses,
  shouldFlagMissingStandaloneJe,
  tagMissingStandaloneJe,
  __test_only__,
} from "../gl-engine.js";

const ENTITY = "11111111-1111-1111-1111-111111111111";
const PERIOD_START = "2026-05-01";
const PERIOD_END = "2026-05-31";

const ACCT_AR = "aaaaaaaa-0000-0000-0000-000000000001";
const ACCT_AP = "aaaaaaaa-0000-0000-0000-000000000002";
const ACCT_REV = "aaaaaaaa-0000-0000-0000-000000000003";
const ACCT_COGS = "aaaaaaaa-0000-0000-0000-000000000004";
const ACCT_INV = "aaaaaaaa-0000-0000-0000-000000000005";

// ──────────────────────────────────────────────────────────────────────────
// In-memory supabase double
// ──────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Array}  opts.glLines  rows shaped { account_id, debit, credit, je: { entity_id, status, posting_date, source } }
 * @param {Array}  opts.siblingRuns rows shaped { entity_id, domain, period_start, period_end, status, completed_at }
 */
function makeSupabase({
  glLines = [],
  siblingRuns = [],
  reconRunsInsertError = null,
  reconVariancesInsertError = null,
  reconRunsUpdateError = null,
  glReadError = null,
  siblingReadError = null,
  reconRunId = "rrr-1",
} = {}) {
  const captured = {
    runsInserts: [],
    runsUpdates: [],
    variancesInserts: [],
  };
  const sb = {
    captured,
    from(table) {
      if (table === "recon_runs") return makeReconRunsBuilder(captured, siblingRuns, reconRunsInsertError, reconRunsUpdateError, siblingReadError, reconRunId);
      if (table === "recon_variances") return makeReconVariancesBuilder(captured, reconVariancesInsertError);
      if (table === "journal_entry_lines") return makeJelBuilder(glLines, glReadError);
      throw new Error(`unexpected table ${table}`);
    },
  };
  return sb;
}

function makeReconRunsBuilder(captured, siblingRuns, insertError, updateError, readError, fakeId) {
  // Two paths: (a) insert+select+single for new runs, (b) select+eq...+limit+maybeSingle for sibling lookups
  // (c) update for status flips.
  let mode = null; // 'insert' | 'select' | 'update'
  let pendingInsert = null;
  let updatePayload = null;
  let updateFilter = null;
  const selectFilters = {
    entity_id: null,
    domain: null,
    period_start: null,
    period_end: null,
  };
  const builder = {
    insert(payload) {
      mode = "insert";
      pendingInsert = payload;
      captured.runsInserts.push(payload);
      return builder;
    },
    update(payload) {
      mode = "update";
      updatePayload = payload;
      updateFilter = { col: null, val: null };
      return builder;
    },
    select(_cols) {
      if (mode !== "insert") mode = "select";
      return builder;
    },
    eq(col, val) {
      if (mode === "update") {
        if (col === "id") updateFilter = { col, val };
      } else if (mode === "select") {
        if (col in selectFilters) selectFilters[col] = val;
      }
      return builder;
    },
    order() { return builder; },
    limit() { return builder; },
    gte() { return builder; },
    lte() { return builder; },
    async single() {
      if (mode === "insert") {
        if (insertError) return { data: null, error: { message: insertError } };
        return { data: { id: fakeId }, error: null };
      }
      return { data: null, error: { message: "single only supported for insert path" } };
    },
    async maybeSingle() {
      // Sibling-lookup path.
      if (readError) return { data: null, error: { message: readError } };
      const match = siblingRuns.find((r) =>
        r.entity_id === selectFilters.entity_id &&
        r.domain === selectFilters.domain &&
        r.period_start === selectFilters.period_start &&
        r.period_end === selectFilters.period_end,
      );
      if (!match) return { data: null, error: null };
      return { data: { status: match.status, completed_at: match.completed_at || null }, error: null };
    },
    then(resolve) {
      // Update path resolves the promise directly.
      if (mode === "update") {
        captured.runsUpdates.push({ payload: updatePayload, filter: updateFilter });
        if (updateError) return resolve({ data: null, error: { message: updateError } });
        return resolve({ data: null, error: null });
      }
      // Fallback: shouldn't be hit, but resolve cleanly.
      return resolve({ data: null, error: null });
    },
  };
  return builder;
}

function makeReconVariancesBuilder(captured, insertError) {
  return {
    insert(payload) {
      if (insertError) return Promise.resolve({ data: null, error: { message: insertError } });
      captured.variancesInserts.push(payload);
      return Promise.resolve({ data: null, error: null });
    },
  };
}

function makeJelBuilder(rows, readError) {
  const filters = {
    "journal_entries.entity_id": null,
    "journal_entries.status": null,
    "journal_entries.posting_date_gte": null,
    "journal_entries.posting_date_lte": null,
  };
  const builder = {
    select() { return builder; },
    eq(col, val) { filters[col] = val; return builder; },
    gte(col, val) {
      if (col === "journal_entries.posting_date") filters["journal_entries.posting_date_gte"] = val;
      return builder;
    },
    lte(col, val) {
      if (col === "journal_entries.posting_date") filters["journal_entries.posting_date_lte"] = val;
      return builder;
    },
    then(resolve) {
      if (readError) return resolve({ data: null, error: { message: readError } });
      let out = rows;
      if (filters["journal_entries.entity_id"] != null) {
        out = out.filter((r) => (r.je || {}).entity_id === filters["journal_entries.entity_id"]);
      }
      if (filters["journal_entries.status"] != null) {
        out = out.filter((r) => (r.je || {}).status === filters["journal_entries.status"]);
      }
      if (filters["journal_entries.posting_date_gte"] != null) {
        out = out.filter((r) => (r.je || {}).posting_date >= filters["journal_entries.posting_date_gte"]);
      }
      if (filters["journal_entries.posting_date_lte"] != null) {
        out = out.filter((r) => (r.je || {}).posting_date <= filters["journal_entries.posting_date_lte"]);
      }
      // Reshape to PostgREST embedded-select format the engine expects.
      const reshaped = out.map((r) => ({
        account_id: r.account_id,
        debit: r.debit,
        credit: r.credit,
        journal_entries: r.je,
      }));
      return resolve({ data: reshaped, error: null });
    },
  };
  return builder;
}

// Helper: fabricate a line row in the test-double's input shape.
function line({ account_id, debit = 0, credit = 0, source = "manual", posting_date = "2026-05-15", entity_id = ENTITY, status = "posted" }) {
  return {
    account_id,
    debit,
    credit,
    je: { entity_id, status, posting_date, source },
  };
}

// Helper: fabricate a sibling recon_runs row.
function sibling({ domain, status = "clean", period_start = PERIOD_START, period_end = PERIOD_END, entity_id = ENTITY, completed_at = "2026-05-29T00:00:00Z" }) {
  return { entity_id, domain, period_start, period_end, status, completed_at };
}

// All-clean sibling fixture (used wherever the "5 clean sub-ledgers" branch matters).
function allCleanSiblings() {
  return [
    sibling({ domain: "ap" }),
    sibling({ domain: "ar" }),
    sibling({ domain: "cash" }),
    sibling({ domain: "inventory" }),
  ];
}

// ──────────────────────────────────────────────────────────────────────────
// Pure helper tests
// ──────────────────────────────────────────────────────────────────────────

describe("dollarsToCents", () => {
  it("converts a number to cents", () => {
    expect(dollarsToCents(12.34)).toBe(1234);
  });
  it("handles strings with $ + commas", () => {
    expect(dollarsToCents("$1,234.56")).toBe(123456);
  });
  it("returns 0 for null/undefined/empty", () => {
    expect(dollarsToCents(null)).toBe(0);
    expect(dollarsToCents(undefined)).toBe(0);
    expect(dollarsToCents("")).toBe(0);
  });
  it("returns 0 for NaN/Infinity/garbage", () => {
    expect(dollarsToCents(NaN)).toBe(0);
    expect(dollarsToCents(Infinity)).toBe(0);
    expect(dollarsToCents("blah")).toBe(0);
  });
  it("rounds to nearest cent", () => {
    expect(dollarsToCents(1.006)).toBe(101);
    expect(dollarsToCents(1.004)).toBe(100);
  });
  it("handles negatives", () => {
    expect(dollarsToCents(-7.5)).toBe(-750);
  });
});

describe("buildGroupKey", () => {
  it("composes gl_account + source", () => {
    expect(buildGroupKey(ACCT_AR, "shopify")).toBe(`${ACCT_AR}::shopify`);
  });
  it("maps null source to manual_or_legacy", () => {
    expect(buildGroupKey(ACCT_AR, null)).toBe(`${ACCT_AR}::manual_or_legacy`);
  });
  it("maps undefined source to manual_or_legacy", () => {
    expect(buildGroupKey(ACCT_AR, undefined)).toBe(`${ACCT_AR}::manual_or_legacy`);
  });
  it("preserves xoro_mirror as its own bucket", () => {
    expect(buildGroupKey(ACCT_AR, "xoro_mirror")).toBe(`${ACCT_AR}::xoro_mirror`);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// validateArgs
// ──────────────────────────────────────────────────────────────────────────

describe("validateArgs", () => {
  const ok = { entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END };

  it("accepts a minimal valid arg bag with defaults", () => {
    const r = validateArgs(ok);
    expect(r.error).toBeUndefined();
    expect(r.data.cadence).toBe("weekly");
    expect(r.data.replay_of_id).toBeNull();
  });
  it("rejects missing entity_id", () => {
    expect(validateArgs({ period_start: PERIOD_START, period_end: PERIOD_END }).error).toMatch(/entity_id/);
  });
  it("rejects bad period_start format", () => {
    expect(validateArgs({ ...ok, period_start: "2026/05/01" }).error).toMatch(/period_start/);
  });
  it("rejects bad period_end format", () => {
    expect(validateArgs({ ...ok, period_end: "May 31, 2026" }).error).toMatch(/period_end/);
  });
  it("rejects period_end < period_start", () => {
    expect(validateArgs({ ...ok, period_end: "2026-04-01" }).error).toMatch(/period_end must be >=/);
  });
  it("accepts cadence='manual'", () => {
    expect(validateArgs({ ...ok, cadence: "manual" }).data.cadence).toBe("manual");
  });
  it("accepts cadence='replay'", () => {
    expect(validateArgs({ ...ok, cadence: "replay" }).data.cadence).toBe("replay");
  });
  it("rejects bogus cadence", () => {
    expect(validateArgs({ ...ok, cadence: "yearly" }).error).toMatch(/cadence/);
  });
  it("preserves replay_of_id when provided", () => {
    const r = validateArgs({ ...ok, replay_of_id: "abc" });
    expect(r.data.replay_of_id).toBe("abc");
  });
  it("rejects non-string replay_of_id", () => {
    expect(validateArgs({ ...ok, replay_of_id: 42 }).error).toMatch(/replay_of_id/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// bucketByAccount
// ──────────────────────────────────────────────────────────────────────────

describe("bucketByAccount", () => {
  it("groups movement by (account, source) and computes net debit-credit", () => {
    const rows = [
      { account_id: ACCT_AR, debit: 100, credit: 0, source: "manual" },
      { account_id: ACCT_AR, debit: 50, credit: 0, source: "manual" },
      { account_id: ACCT_AR, debit: 0, credit: 30, source: "manual" },
    ];
    const m = bucketByAccount(rows);
    expect(m.size).toBe(1);
    const b = [...m.values()][0];
    // (100 + 50)*100 - 30*100 = 12000 cents net
    expect(b.movement_cents).toBe(12000);
    expect(b.gl_account_id).toBe(ACCT_AR);
    expect(b.source_tag).toBe("manual");
  });
  it("separates buckets by source within the same account", () => {
    const rows = [
      { account_id: ACCT_AR, debit: 100, credit: 0, source: "manual" },
      { account_id: ACCT_AR, debit: 100, credit: 0, source: "xoro_mirror" },
    ];
    const m = bucketByAccount(rows);
    expect(m.size).toBe(2);
  });
  it("null source tags map to manual_or_legacy bucket", () => {
    const rows = [{ account_id: ACCT_AR, debit: 10, credit: 0, source: null }];
    const m = bucketByAccount(rows);
    const b = [...m.values()][0];
    expect(b.source_tag).toBeNull();
  });
  it("credit-only line yields negative net movement", () => {
    const rows = [{ account_id: ACCT_AR, debit: 0, credit: 50, source: "manual" }];
    const m = bucketByAccount(rows);
    expect([...m.values()][0].movement_cents).toBe(-5000);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// splitBuckets
// ──────────────────────────────────────────────────────────────────────────

describe("splitBuckets", () => {
  it("routes xoro_mirror buckets to xoro and the rest to tang", () => {
    const all = bucketByAccount([
      { account_id: ACCT_AR, debit: 100, credit: 0, source: "manual" },
      { account_id: ACCT_AR, debit: 100, credit: 0, source: "xoro_mirror" },
      { account_id: ACCT_AP, debit: 50, credit: 0, source: "shopify" },
    ]);
    const { tang, xoro } = splitBuckets(all);
    expect(tang.size).toBe(2);  // manual + shopify
    expect(xoro.size).toBe(1);
  });
  it("empty input gives empty maps", () => {
    const { tang, xoro } = splitBuckets(new Map());
    expect(tang.size).toBe(0);
    expect(xoro.size).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// matchBuckets
// ──────────────────────────────────────────────────────────────────────────

describe("matchBuckets", () => {
  it("emits zero variance when sides match", () => {
    const all = bucketByAccount([
      { account_id: ACCT_AR, debit: 100, credit: 0, source: "manual" },
      { account_id: ACCT_AR, debit: 100, credit: 0, source: "xoro_mirror" },
    ]);
    const { tang, xoro } = splitBuckets(all);
    const v = matchBuckets(tang, xoro);
    expect(v).toHaveLength(1);
    expect(v[0].variance_amount_cents).toBe(0);
  });
  it("emits positive variance when Tangerine > Xoro", () => {
    const all = bucketByAccount([
      { account_id: ACCT_AR, debit: 150, credit: 0, source: "manual" },
      { account_id: ACCT_AR, debit: 100, credit: 0, source: "xoro_mirror" },
    ]);
    const { tang, xoro } = splitBuckets(all);
    const v = matchBuckets(tang, xoro);
    expect(v[0].variance_amount_cents).toBe(5000); // $50 diff
  });
  it("emits negative variance when Tangerine < Xoro", () => {
    const all = bucketByAccount([
      { account_id: ACCT_AR, debit: 100, credit: 0, source: "manual" },
      { account_id: ACCT_AR, debit: 150, credit: 0, source: "xoro_mirror" },
    ]);
    const { tang, xoro } = splitBuckets(all);
    const v = matchBuckets(tang, xoro);
    expect(v[0].variance_amount_cents).toBe(-5000);
  });
  it("emits Tangerine-only row when Xoro side missing", () => {
    const all = bucketByAccount([
      { account_id: ACCT_REV, debit: 0, credit: 1000, source: "shopify" },
    ]);
    const { tang, xoro } = splitBuckets(all);
    const v = matchBuckets(tang, xoro);
    expect(v).toHaveLength(1);
    expect(v[0].tangerine_amount_cents).toBe(-100000);
    expect(v[0].xoro_amount_cents).toBe(0);
    expect(v[0].source_tag).toBe("shopify");
  });
  it("emits Xoro-only row when Tangerine side missing", () => {
    const all = bucketByAccount([
      { account_id: ACCT_INV, debit: 500, credit: 0, source: "xoro_mirror" },
    ]);
    const { tang, xoro } = splitBuckets(all);
    const v = matchBuckets(tang, xoro);
    expect(v).toHaveLength(1);
    expect(v[0].tangerine_amount_cents).toBe(0);
    expect(v[0].xoro_amount_cents).toBe(50000);
    expect(v[0].variance_amount_cents).toBe(-50000);
    expect(v[0].source_tag).toBe("xoro_mirror");
  });
  it("collapses multiple Tangerine source tags into one comparison per account", () => {
    const all = bucketByAccount([
      { account_id: ACCT_REV, debit: 0, credit: 300, source: "shopify" },
      { account_id: ACCT_REV, debit: 0, credit: 200, source: "fba" },
      { account_id: ACCT_REV, debit: 0, credit: 500, source: "xoro_mirror" },
    ]);
    const { tang, xoro } = splitBuckets(all);
    const v = matchBuckets(tang, xoro);
    expect(v).toHaveLength(1);
    expect(v[0].variance_amount_cents).toBe(0);
  });
  it("prefers the first non-mirror non-null tag for display", () => {
    const all = bucketByAccount([
      { account_id: ACCT_REV, debit: 0, credit: 100, source: "shopify" },
    ]);
    const { tang, xoro } = splitBuckets(all);
    const v = matchBuckets(tang, xoro);
    expect(v[0].source_tag).toBe("shopify");
  });
  it("treats different accounts as separate variance rows", () => {
    const all = bucketByAccount([
      { account_id: ACCT_AR, debit: 100, credit: 0, source: "manual" },
      { account_id: ACCT_AP, debit: 100, credit: 0, source: "manual" },
    ]);
    const { tang, xoro } = splitBuckets(all);
    const v = matchBuckets(tang, xoro);
    expect(v).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// applyThresholds — $5 row / $25 domain
// ──────────────────────────────────────────────────────────────────────────

describe("applyThresholds", () => {
  it("classifies sub-$5 variance as 'within'", () => {
    const r = applyThresholds([
      { variance_amount_cents: 499, gl_account_id: ACCT_AR, source_tag: "manual", tangerine_amount_cents: 499, xoro_amount_cents: 0 },
    ]);
    expect(r.variances_with_status[0].status).toBe("within");
    expect(r.summary.variances_found).toBe(0);
    expect(r.summary.run_status).toBe("clean");
  });
  it("classifies exactly $5 variance as 'over' (>= threshold)", () => {
    const r = applyThresholds([
      { variance_amount_cents: 500, gl_account_id: ACCT_AR, source_tag: "manual", tangerine_amount_cents: 500, xoro_amount_cents: 0 },
    ]);
    expect(r.variances_with_status[0].status).toBe("over");
    expect(r.summary.variances_found).toBe(1);
  });
  it("uses absolute value for negative variance", () => {
    const r = applyThresholds([
      { variance_amount_cents: -700, gl_account_id: ACCT_AR, source_tag: "manual", tangerine_amount_cents: 0, xoro_amount_cents: 700 },
    ]);
    expect(r.variances_with_status[0].status).toBe("over");
  });
  it("marks run 'clean' when total |over| <= $25", () => {
    const r = applyThresholds([
      { variance_amount_cents: 500, gl_account_id: ACCT_AR, source_tag: "manual", tangerine_amount_cents: 500, xoro_amount_cents: 0 },
      { variance_amount_cents: 700, gl_account_id: ACCT_AP, source_tag: "manual", tangerine_amount_cents: 700, xoro_amount_cents: 0 },
    ]);
    // 500 + 700 = 1200 < 2500 domain
    expect(r.summary.run_status).toBe("clean");
  });
  it("marks run 'variance' when total |over| > $25", () => {
    const r = applyThresholds([
      { variance_amount_cents: 1500, gl_account_id: ACCT_AR, source_tag: "manual", tangerine_amount_cents: 1500, xoro_amount_cents: 0 },
      { variance_amount_cents: 1200, gl_account_id: ACCT_AP, source_tag: "manual", tangerine_amount_cents: 1200, xoro_amount_cents: 0 },
    ]);
    // 1500 + 1200 = 2700 > 2500
    expect(r.summary.run_status).toBe("variance");
    expect(r.summary.total_variance_cents).toBe(2700);
  });
  it("does not count within-threshold rows toward domain total", () => {
    const r = applyThresholds([
      { variance_amount_cents: 100, gl_account_id: ACCT_AR, source_tag: "manual", tangerine_amount_cents: 100, xoro_amount_cents: 0 },
      { variance_amount_cents: 499, gl_account_id: ACCT_AP, source_tag: "manual", tangerine_amount_cents: 499, xoro_amount_cents: 0 },
    ]);
    expect(r.summary.total_variance_cents).toBe(0);
    expect(r.summary.run_status).toBe("clean");
  });
  it("exposes the GL threshold values in summary", () => {
    const r = applyThresholds([]);
    expect(r.summary.per_row_threshold_cents).toBe(500);
    expect(r.summary.per_domain_threshold_cents).toBe(2500);
  });
  it("rows_compared reflects total input rows (incl. within)", () => {
    const r = applyThresholds([
      { variance_amount_cents: 100, gl_account_id: ACCT_AR, source_tag: "manual", tangerine_amount_cents: 100, xoro_amount_cents: 0 },
      { variance_amount_cents: 600, gl_account_id: ACCT_AP, source_tag: "manual", tangerine_amount_cents: 600, xoro_amount_cents: 0 },
    ]);
    expect(r.summary.rows_compared).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Sibling-domain reading + missing_standalone_je auto-cat
// ──────────────────────────────────────────────────────────────────────────

describe("readSiblingDomainStatuses", () => {
  it("returns statuses for the 4 sibling domains when all present", async () => {
    const admin = makeSupabase({ siblingRuns: allCleanSiblings() });
    const m = await readSiblingDomainStatuses({ admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END });
    expect(m.size).toBe(4);
    expect(m.get("ap")).toBe("clean");
    expect(m.get("ar")).toBe("clean");
    expect(m.get("cash")).toBe("clean");
    expect(m.get("inventory")).toBe("clean");
  });
  it("returns partial map when only some siblings present", async () => {
    const admin = makeSupabase({ siblingRuns: [sibling({ domain: "ap" }), sibling({ domain: "ar" })] });
    const m = await readSiblingDomainStatuses({ admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END });
    expect(m.size).toBe(2);
    expect(m.has("cash")).toBe(false);
    expect(m.has("inventory")).toBe(false);
  });
  it("strict period match — different window means no row found", async () => {
    const admin = makeSupabase({
      siblingRuns: [sibling({ domain: "ap", period_start: "2026-04-01", period_end: "2026-04-30" })],
    });
    const m = await readSiblingDomainStatuses({ admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END });
    expect(m.size).toBe(0);
  });
});

describe("shouldFlagMissingStandaloneJe", () => {
  it("true when all 4 statuses are clean", () => {
    const m = new Map([["ap", "clean"], ["ar", "clean"], ["cash", "clean"], ["inventory", "clean"]]);
    expect(shouldFlagMissingStandaloneJe(m)).toBe(true);
  });
  it("false when one domain is missing", () => {
    const m = new Map([["ap", "clean"], ["ar", "clean"], ["cash", "clean"]]);
    expect(shouldFlagMissingStandaloneJe(m)).toBe(false);
  });
  it("false when one domain is in 'variance'", () => {
    const m = new Map([["ap", "clean"], ["ar", "variance"], ["cash", "clean"], ["inventory", "clean"]]);
    expect(shouldFlagMissingStandaloneJe(m)).toBe(false);
  });
  it("false when one domain is in 'error'", () => {
    const m = new Map([["ap", "clean"], ["ar", "clean"], ["cash", "error"], ["inventory", "clean"]]);
    expect(shouldFlagMissingStandaloneJe(m)).toBe(false);
  });
  it("false for empty map", () => {
    expect(shouldFlagMissingStandaloneJe(new Map())).toBe(false);
  });
  it("false for non-Map input", () => {
    expect(shouldFlagMissingStandaloneJe(null)).toBe(false);
    expect(shouldFlagMissingStandaloneJe({})).toBe(false);
  });
});

describe("tagMissingStandaloneJe", () => {
  it("tags only over-status variances when sibling_all_clean=true", () => {
    const input = [
      { status: "over", variance_amount_cents: 1000, gl_account_id: ACCT_AR, source_tag: "manual", tangerine_amount_cents: 1000, xoro_amount_cents: 0 },
      { status: "within", variance_amount_cents: 100, gl_account_id: ACCT_AP, source_tag: "manual", tangerine_amount_cents: 100, xoro_amount_cents: 0 },
    ];
    const out = tagMissingStandaloneJe(input, true);
    expect(out[0].notes).toBe("missing_standalone_je");
    expect(out[1].notes).toBeUndefined();
  });
  it("leaves variances untouched when sibling_all_clean=false", () => {
    const input = [
      { status: "over", variance_amount_cents: 1000, gl_account_id: ACCT_AR, source_tag: "manual", tangerine_amount_cents: 1000, xoro_amount_cents: 0 },
    ];
    const out = tagMissingStandaloneJe(input, false);
    expect(out[0].notes).toBeUndefined();
  });
  it("returns a new array (does not mutate input)", () => {
    const input = [{ status: "over", variance_amount_cents: 1000, gl_account_id: ACCT_AR, source_tag: "manual", tangerine_amount_cents: 1000, xoro_amount_cents: 0 }];
    const out = tagMissingStandaloneJe(input, true);
    expect(out).not.toBe(input);
    expect(input[0].notes).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// runGlReconciliation — end-to-end
// ──────────────────────────────────────────────────────────────────────────

describe("runGlReconciliation", () => {
  it("returns 'clean' on empty period (no lines either side)", async () => {
    const admin = makeSupabase({ glLines: [] });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("clean");
    expect(r.rows_compared).toBe(0);
    expect(r.variances_found).toBe(0);
    expect(r.errors).toEqual([]);
    expect(admin.captured.runsInserts).toHaveLength(1);
    expect(admin.captured.runsInserts[0].domain).toBe("gl");
    expect(admin.captured.runsInserts[0].status).toBe("running");
    expect(admin.captured.variancesInserts).toHaveLength(0);
  });

  it("returns 'clean' when matched sides agree exactly", async () => {
    const admin = makeSupabase({
      glLines: [
        line({ account_id: ACCT_AR, debit: 100, credit: 0, source: "manual" }),
        line({ account_id: ACCT_AR, debit: 100, credit: 0, source: "xoro_mirror" }),
      ],
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("clean");
    expect(r.variances_found).toBe(0);
    expect(admin.captured.variancesInserts).toHaveLength(0);
  });

  it("emits one variance row when Tangerine over-states by $10", async () => {
    const admin = makeSupabase({
      glLines: [
        line({ account_id: ACCT_AR, debit: 110, credit: 0, source: "manual" }),
        line({ account_id: ACCT_AR, debit: 100, credit: 0, source: "xoro_mirror" }),
      ],
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    // $10 over row threshold ($5) but well under $25 domain → row 'over', run 'clean'
    expect(r.status).toBe("clean");
    expect(r.variances_found).toBe(1);
    expect(r.total_variance_cents).toBe(1000);
    expect(admin.captured.variancesInserts).toHaveLength(1);
    const vRow = admin.captured.variancesInserts[0][0];
    expect(vRow.source_table).toBe("journal_entry_lines");
    expect(vRow.variance_amount_cents).toBe(1000);
    expect(vRow.status).toBe("over");
    expect(vRow.source_tag).toBe("manual");
  });

  it("respects per-row threshold ($4.99 = within, no variances_found bump)", async () => {
    const admin = makeSupabase({
      glLines: [
        line({ account_id: ACCT_AR, debit: 4.99, credit: 0, source: "manual" }),
      ],
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("clean");
    expect(r.variances_found).toBe(0);
    // Within-threshold row with non-zero variance still gets persisted
    // for the dashboard's informational view, but with status='within'.
    expect(admin.captured.variancesInserts).toHaveLength(1);
    expect(admin.captured.variancesInserts[0][0].status).toBe("within");
  });

  it("exactly $5 variance is 'over'", async () => {
    const admin = makeSupabase({
      glLines: [
        line({ account_id: ACCT_AR, debit: 5, credit: 0, source: "manual" }),
      ],
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.variances_found).toBe(1);
  });

  it("marks run 'variance' when domain total exceeds $25", async () => {
    const admin = makeSupabase({
      glLines: [
        line({ account_id: ACCT_AR, debit: 20, credit: 0, source: "manual" }),
        line({ account_id: ACCT_AP, debit: 15, credit: 0, source: "manual" }),
      ],
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    // 2000 + 1500 = 3500 > 2500
    expect(r.status).toBe("variance");
    expect(r.total_variance_cents).toBe(3500);
  });

  it("$25 exactly is 'clean' (per-domain is strict >, not >=)", async () => {
    const admin = makeSupabase({
      glLines: [
        line({ account_id: ACCT_AR, debit: 25, credit: 0, source: "manual" }),
      ],
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    // |variance| = 2500, equal to per_domain_cents → status 'clean'
    expect(r.status).toBe("clean");
    expect(r.variances_found).toBe(1);
  });

  it("emits Xoro-only row when Tangerine never posted", async () => {
    const admin = makeSupabase({
      glLines: [
        line({ account_id: ACCT_INV, debit: 50, credit: 0, source: "xoro_mirror" }),
      ],
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.variances_found).toBe(1);
    expect(r.total_variance_cents).toBe(5000);
    const vRow = admin.captured.variancesInserts[0][0];
    expect(vRow.tangerine_amount_cents).toBe(0);
    expect(vRow.xoro_amount_cents).toBe(5000);
    expect(vRow.variance_amount_cents).toBe(-5000);
    expect(vRow.source_tag).toBe("xoro_mirror");
  });

  it("preserves Tangerine-side source_tag on variance (D7)", async () => {
    const admin = makeSupabase({
      glLines: [
        line({ account_id: ACCT_REV, debit: 0, credit: 50, source: "shopify" }),
        line({ account_id: ACCT_REV, debit: 0, credit: 30, source: "xoro_mirror" }),
      ],
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.variances_found).toBe(1);
    expect(admin.captured.variancesInserts[0][0].source_tag).toBe("shopify");
  });

  it("multi-channel Tangerine collapses against single xoro_mirror line", async () => {
    const admin = makeSupabase({
      glLines: [
        line({ account_id: ACCT_REV, debit: 0, credit: 30, source: "shopify" }),
        line({ account_id: ACCT_REV, debit: 0, credit: 20, source: "fba" }),
        line({ account_id: ACCT_REV, debit: 0, credit: 50, source: "xoro_mirror" }),
      ],
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    // -5000 cents Tangerine net vs -5000 Xoro net → 0 variance
    expect(r.variances_found).toBe(0);
    expect(admin.captured.variancesInserts).toHaveLength(0);
  });

  it("filters out posting_date outside period bounds", async () => {
    const admin = makeSupabase({
      glLines: [
        line({ account_id: ACCT_AR, debit: 99, credit: 0, source: "manual", posting_date: "2026-04-15" }),
        line({ account_id: ACCT_AR, debit: 99, credit: 0, source: "manual", posting_date: "2026-06-15" }),
        line({ account_id: ACCT_AR, debit: 1, credit: 0, source: "manual", posting_date: "2026-05-15" }),
        line({ account_id: ACCT_AR, debit: 1, credit: 0, source: "xoro_mirror", posting_date: "2026-05-15" }),
      ],
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("clean");
    expect(r.totals_jsonb.gl_lines_pulled).toBe(2);
  });

  it("filters out status != 'posted'", async () => {
    const admin = makeSupabase({
      glLines: [
        line({ account_id: ACCT_AR, debit: 999, credit: 0, source: "manual", status: "draft" }),
        line({ account_id: ACCT_AP, debit: 999, credit: 0, source: "manual", status: "reversed" }),
      ],
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.totals_jsonb.gl_lines_pulled).toBe(0);
    expect(r.status).toBe("clean");
  });

  it("filters by entity_id (wrong entity rows excluded)", async () => {
    const admin = makeSupabase({
      glLines: [
        line({ account_id: ACCT_AR, debit: 999, credit: 0, source: "manual", entity_id: "other-ent" }),
      ],
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.totals_jsonb.gl_lines_pulled).toBe(0);
  });

  it("supports cadence='manual'", async () => {
    const admin = makeSupabase({});
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END, cadence: "manual",
    });
    expect(r.status).toBe("clean");
    expect(admin.captured.runsInserts[0].cadence).toBe("manual");
  });

  it("supports cadence='replay' with replay_of_id (D11)", async () => {
    const admin = makeSupabase({});
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
      cadence: "replay", replay_of_id: "00000000-0000-0000-0000-000000000123",
    });
    expect(r.status).toBe("clean");
    expect(admin.captured.runsInserts[0].cadence).toBe("replay");
    expect(admin.captured.runsInserts[0].replay_of_id).toBe("00000000-0000-0000-0000-000000000123");
  });

  it("default cadence is 'weekly'", async () => {
    const admin = makeSupabase({});
    await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(admin.captured.runsInserts[0].cadence).toBe("weekly");
  });

  it("single-day period accepted", async () => {
    const admin = makeSupabase({
      glLines: [line({ account_id: ACCT_AR, debit: 1, credit: 0, source: "manual", posting_date: "2026-05-15" })],
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-15", period_end: "2026-05-15",
    });
    expect(r.status).toBe("clean");
    expect(r.totals_jsonb.gl_lines_pulled).toBe(1);
  });

  it("reverse period rejected as args error before any insert", async () => {
    const admin = makeSupabase({});
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-31", period_end: "2026-05-01",
    });
    expect(r.status).toBe("error");
    expect(admin.captured.runsInserts).toHaveLength(0);
  });

  it("returns error+errors on bad args (rejects without DB insert)", async () => {
    const admin = makeSupabase({});
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: "bad", period_end: PERIOD_END,
    });
    expect(r.status).toBe("error");
    expect(r.errors[0].scope).toBe("args");
    expect(admin.captured.runsInserts).toHaveLength(0);
  });

  it("propagates recon_runs.insert error as status='error'", async () => {
    const admin = makeSupabase({ reconRunsInsertError: "db boom" });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("error");
    expect(r.errors[0].scope).toBe("recon_runs_insert");
    expect(r.recon_run_id).toBeNull();
  });

  it("propagates journal_entry_lines.read error and marks the run errored", async () => {
    const admin = makeSupabase({ glReadError: "read boom" });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("error");
    expect(r.recon_run_id).toBe("rrr-1");
    expect(r.errors.some((e) => e.scope === "gl_fetch")).toBe(true);
    const errorUpdate = admin.captured.runsUpdates.find((u) => u.payload.status === "error");
    expect(errorUpdate).toBeDefined();
  });

  it("propagates recon_variances.insert error and marks the run errored", async () => {
    const admin = makeSupabase({
      glLines: [line({ account_id: ACCT_AR, debit: 50, credit: 0, source: "manual" })],
      reconVariancesInsertError: "variance boom",
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("error");
    expect(r.errors.some((e) => e.scope === "recon_variances_insert")).toBe(true);
  });

  it("captures recon_runs.update error without overwriting comparison results", async () => {
    const admin = makeSupabase({
      glLines: [line({ account_id: ACCT_AR, debit: 50, credit: 0, source: "manual" })],
      reconRunsUpdateError: "update boom",
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.errors.some((e) => e.scope === "recon_runs_update")).toBe(true);
    expect(r.variances_found).toBe(1);
  });

  it("totals_jsonb has the expected shape", async () => {
    const admin = makeSupabase({
      glLines: [line({ account_id: ACCT_AR, debit: 50, credit: 0, source: "manual" })],
    });
    await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    const finalUpdate = admin.captured.runsUpdates[admin.captured.runsUpdates.length - 1];
    expect(finalUpdate.payload.totals_jsonb).toMatchObject({
      rows_compared: expect.any(Number),
      variances_found: 1,
      total_variance_cents: 5000,
      per_row_threshold_cents: 500,
      per_domain_threshold_cents: 2500,
      gl_lines_pulled: expect.any(Number),
      missing_standalone_je_count: expect.any(Number),
      sibling_all_clean: expect.any(Boolean),
      sibling_statuses: expect.any(Object),
    });
  });

  it("rows with zero variance are NOT persisted as variance rows", async () => {
    const admin = makeSupabase({
      glLines: [
        line({ account_id: ACCT_AR, debit: 100, credit: 0, source: "manual" }),
        line({ account_id: ACCT_AR, debit: 100, credit: 0, source: "xoro_mirror" }),
      ],
    });
    await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(admin.captured.variancesInserts).toHaveLength(0);
  });

  it("GL_THRESHOLDS frozen + correct constants ($5/row, $25/domain)", () => {
    expect(__test_only__.GL_THRESHOLDS.per_row_cents).toBe(500);
    expect(__test_only__.GL_THRESHOLDS.per_domain_cents).toBe(2500);
    expect(Object.isFrozen(__test_only__.GL_THRESHOLDS)).toBe(true);
  });

  it("SUBLEDGER_DOMAINS frozen list = ap/ar/cash/inventory", () => {
    expect(__test_only__.SUBLEDGER_DOMAINS).toEqual(["ap", "ar", "cash", "inventory"]);
    expect(Object.isFrozen(__test_only__.SUBLEDGER_DOMAINS)).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────
  // Auto-categorization — missing_standalone_je
  // ────────────────────────────────────────────────────────────────────

  it("auto-tags over-variances with missing_standalone_je when 4 siblings all clean", async () => {
    const admin = makeSupabase({
      glLines: [
        line({ account_id: ACCT_AR, debit: 20, credit: 0, source: "manual" }),
      ],
      siblingRuns: allCleanSiblings(),
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.variances_found).toBe(1);
    expect(r.totals_jsonb.missing_standalone_je_count).toBe(1);
    expect(r.totals_jsonb.sibling_all_clean).toBe(true);
    expect(admin.captured.variancesInserts[0][0].notes).toBe("missing_standalone_je");
  });

  it("does NOT tag missing_standalone_je when a sibling is in variance", async () => {
    const admin = makeSupabase({
      glLines: [
        line({ account_id: ACCT_AR, debit: 20, credit: 0, source: "manual" }),
      ],
      siblingRuns: [
        sibling({ domain: "ap" }),
        sibling({ domain: "ar", status: "variance" }),
        sibling({ domain: "cash" }),
        sibling({ domain: "inventory" }),
      ],
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.totals_jsonb.missing_standalone_je_count).toBe(0);
    expect(r.totals_jsonb.sibling_all_clean).toBe(false);
    expect(admin.captured.variancesInserts[0][0].notes).toBeNull();
  });

  it("does NOT tag missing_standalone_je when a sibling domain is missing entirely", async () => {
    const admin = makeSupabase({
      glLines: [line({ account_id: ACCT_AR, debit: 20, credit: 0, source: "manual" })],
      siblingRuns: [sibling({ domain: "ap" }), sibling({ domain: "ar" }), sibling({ domain: "cash" })],
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.totals_jsonb.sibling_all_clean).toBe(false);
    expect(r.totals_jsonb.missing_standalone_je_count).toBe(0);
    expect(admin.captured.variancesInserts[0][0].notes).toBeNull();
  });

  it("only tags over-status variances (not within rows)", async () => {
    const admin = makeSupabase({
      glLines: [
        // Account A: $10 over → tagged
        line({ account_id: ACCT_AR, debit: 10, credit: 0, source: "manual" }),
        // Account B: $1 within
        line({ account_id: ACCT_AP, debit: 1, credit: 0, source: "manual" }),
      ],
      siblingRuns: allCleanSiblings(),
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.totals_jsonb.missing_standalone_je_count).toBe(1);
    // Two persisted (one over, one within — within still has variance != 0)
    const rows = admin.captured.variancesInserts[0];
    expect(rows).toHaveLength(2);
    const overRow = rows.find((x) => x.status === "over");
    const withinRow = rows.find((x) => x.status === "within");
    expect(overRow.notes).toBe("missing_standalone_je");
    expect(withinRow.notes).toBeNull();
  });

  it("sibling_statuses is written to totals_jsonb verbatim", async () => {
    const admin = makeSupabase({
      glLines: [],
      siblingRuns: [sibling({ domain: "ap" }), sibling({ domain: "ar", status: "variance" })],
    });
    await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    const finalUpdate = admin.captured.runsUpdates[admin.captured.runsUpdates.length - 1];
    expect(finalUpdate.payload.totals_jsonb.sibling_statuses).toMatchObject({ ap: "clean", ar: "variance" });
  });

  it("no over-rows + all-clean siblings → missing_standalone_je_count = 0", async () => {
    const admin = makeSupabase({
      glLines: [],
      siblingRuns: allCleanSiblings(),
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("clean");
    expect(r.totals_jsonb.missing_standalone_je_count).toBe(0);
    expect(r.totals_jsonb.sibling_all_clean).toBe(true);
  });

  it("multi-account drift with sibling-clean tags every over-row", async () => {
    const admin = makeSupabase({
      glLines: [
        line({ account_id: ACCT_AR, debit: 10, credit: 0, source: "manual" }),
        line({ account_id: ACCT_AP, debit: 8, credit: 0, source: "manual" }),
      ],
      siblingRuns: allCleanSiblings(),
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    // 2 over rows, |1000| + |800| = 1800 < 2500 → run 'clean', both over rows
    expect(r.variances_found).toBe(2);
    expect(r.totals_jsonb.missing_standalone_je_count).toBe(2);
    const rows = admin.captured.variancesInserts[0];
    expect(rows.every((x) => x.notes === "missing_standalone_je")).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────
  // Multi-row / period
  // ────────────────────────────────────────────────────────────────────

  it("multi-account multi-variance sums correctly", async () => {
    const admin = makeSupabase({
      glLines: [
        // AR: $20 over
        line({ account_id: ACCT_AR, debit: 50, credit: 0, source: "manual" }),
        line({ account_id: ACCT_AR, debit: 30, credit: 0, source: "xoro_mirror" }),
        // AP: $30 under
        line({ account_id: ACCT_AP, debit: 0, credit: 70, source: "manual" }),
        line({ account_id: ACCT_AP, debit: 0, credit: 100, source: "xoro_mirror" }),
        // INV: clean
        line({ account_id: ACCT_INV, debit: 10, credit: 0, source: "manual" }),
        line({ account_id: ACCT_INV, debit: 10, credit: 0, source: "xoro_mirror" }),
      ],
    });
    const r = await runGlReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    // 2 over rows: |2000| + |3000| = 5000 cents = $50 → run 'variance' (> $25)
    expect(r.variances_found).toBe(2);
    expect(r.total_variance_cents).toBe(5000);
    expect(r.status).toBe("variance");
  });

  it("replay points back via replay_of_id (D11)", async () => {
    const admin1 = makeSupabase({
      glLines: [line({ account_id: ACCT_AR, debit: 50, credit: 0, source: "manual" })],
      reconRunId: "first-run-id",
    });
    const r1 = await runGlReconciliation({
      admin: admin1, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END, cadence: "manual",
    });
    expect(r1.recon_run_id).toBe("first-run-id");

    const admin2 = makeSupabase({
      glLines: [line({ account_id: ACCT_AR, debit: 50, credit: 0, source: "manual" })],
      reconRunId: "replay-run-id",
    });
    const r2 = await runGlReconciliation({
      admin: admin2, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
      cadence: "replay", replay_of_id: r1.recon_run_id,
    });
    expect(r2.recon_run_id).toBe("replay-run-id");
    expect(admin2.captured.runsInserts[0].replay_of_id).toBe("first-run-id");
    // Idempotent comparison result
    expect(r2.variances_found).toBe(r1.variances_found);
    expect(r2.total_variance_cents).toBe(r1.total_variance_cents);
  });
});
