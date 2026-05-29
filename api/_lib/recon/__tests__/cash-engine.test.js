// Tangerine P9-4 — tests for the Cash reconciliation engine.
//
// Coverage:
//   - constants frozen ($0.50 / $3 — D2)
//   - BigInt helpers (toBigInt, absBig)
//   - ISO-date helpers (isISODate, addDaysISO, daysBetween)
//   - mapBankSourceToTag — plaid / csv_upload / manual / unknown
//   - classifyBankRow + partitionRows — side classification
//   - buildMatchKey — sign preservation
//   - matchWithinTolerance — same-day, ±1 day, no-match, multi-bucket,
//     greedy 1-to-1, sign-aware (deposit vs withdrawal)
//   - buildVarianceRows — Tangerine-only, Xoro-only, source_tag carried,
//     threshold boundaries
//   - composeTotals — per_source_tag, BigInt serialization, ceiling flip
//   - decideRunStatus — clean / variance
//   - runCashReconciliation orchestrator:
//       * bad inputs (admin / entity_id / dates / cadence /
//         replay_of_id / tolerance_days)
//       * happy-path clean (all matched)
//       * happy-path variance with domain ceiling crossed
//       * threshold boundary (49c within, 50c within, 51c over) — D2 LOCK
//       * domain ceiling boundary (300c within, 301c over)
//       * ±1 day match success + ±2 day no-match
//       * sign-aware: deposit doesn't match withdrawal of same |amount|
//       * source_tag preserved on variance row (D7)
//       * period bounds: rows just outside period_start/period_end
//         (within widened window) are not surfaced as variances
//       * replay records replay_of_id, cadence='replay'
//       * empty period → clean
//       * bank_transactions read error → 'error' status
//       * variances insert error → 'error' status
//       * finalize error → ok:false
//       * sanity-totals warnings don't fail the run
//       * recon_runs insert error → ok:false, no run_id
//       * engine throws → catch path

import { describe, it, expect } from "vitest";
import {
  CASH_THRESHOLDS,
  DEFAULT_PER_ROW_THRESHOLD_CENTS,
  DEFAULT_PER_DOMAIN_THRESHOLD_CENTS,
  mapBankSourceToTag,
  classifyBankRow,
  toBigInt,
  absBig,
  isISODate,
  addDaysISO,
  daysBetween,
  buildMatchKey,
  partitionRows,
  matchWithinTolerance,
  buildVarianceRows,
  composeTotals,
  decideRunStatus,
  runCashReconciliation,
} from "../cash-engine.js";

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

const ENTITY = "11111111-1111-1111-1111-111111111111";
const RUN_ID = "22222222-2222-2222-2222-222222222222";
const REPLAY_OF = "33333333-3333-3333-3333-333333333333";
const ACCT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ACCT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const NOW = "2026-05-29T12:00:00.000Z";

function bankRow({ id, bank_account_id = ACCT_A, source, posted_date, amount_cents }) {
  return {
    id,
    entity_id: ENTITY,
    bank_account_id,
    source,
    posted_date,
    amount_cents,
    external_txn_id: null,
    status: "unmatched",
  };
}

// ──────────────────────────────────────────────────────────────────────
// Mock supabase — table-aware micro-builder. Each test seeds rows
// per-table and we capture every insert/update.
// ──────────────────────────────────────────────────────────────────────

function makeMockSupabase({
  bankRows = [],
  arRows = [],
  posRows = [],
  insertedRunId = RUN_ID,
  runInsertError = null,
  bankReadError = null,
  arReadError = null,
  posReadError = null,
  variancesInsertError = null,
  runFinalizeError = null,
  state = {},
} = {}) {
  state.runInserts = state.runInserts || [];
  state.runUpdates = state.runUpdates || [];
  state.varianceInserts = state.varianceInserts || [];
  state.reads = state.reads || [];

  function builder(table) {
    const ctx = { table, filters: {}, mode: null, insertRow: null, updatePatch: null };
    const b = {
      select() { return b; },
      eq(col, val) { ctx.filters[col] = val; return b; },
      gte(col, val) { ctx.filters[`${col}>=`] = val; return b; },
      lte(col, val) { ctx.filters[`${col}<=`] = val; return b; },
      gt() { return b; },
      lt() { return b; },
      in(col, vals) { ctx.filters[col] = { in: vals }; return b; },
      order() { return b; },
      limit() { return b; },
      async single() {
        if (ctx.mode === "insert" && table === "recon_runs") {
          state.runInserts.push({ row: ctx.insertRow });
          if (runInsertError) return { data: null, error: runInsertError };
          return { data: { id: insertedRunId }, error: null };
        }
        return { data: null, error: null };
      },
      async maybeSingle() {
        return { data: null, error: null };
      },
      then(resolveFn) {
        if (ctx.mode === "update" && table === "recon_runs") {
          state.runUpdates.push({ patch: ctx.updatePatch, filters: { ...ctx.filters } });
          return resolveFn({ data: null, error: runFinalizeError });
        }
        if (ctx.mode === "insert" && table === "recon_variances") {
          state.varianceInserts.push({ rows: ctx.insertRow });
          return resolveFn({ data: null, error: variancesInsertError });
        }
        // selects
        state.reads.push({ table, filters: { ...ctx.filters } });
        if (table === "bank_transactions") {
          if (bankReadError) return resolveFn({ data: null, error: bankReadError });
          // simulate gte/lte posted_date filter
          let out = bankRows;
          const gte = ctx.filters["posted_date>="];
          const lte = ctx.filters["posted_date<="];
          const eid = ctx.filters.entity_id;
          if (eid != null) out = out.filter((r) => r.entity_id === eid);
          if (gte != null) out = out.filter((r) => r.posted_date >= gte);
          if (lte != null) out = out.filter((r) => r.posted_date <= lte);
          return resolveFn({ data: out, error: null });
        }
        if (table === "ip_sales_history_wholesale") {
          if (arReadError) return resolveFn({ data: null, error: arReadError });
          return resolveFn({ data: arRows, error: null });
        }
        if (table === "tanda_pos") {
          if (posReadError) return resolveFn({ data: null, error: posReadError });
          return resolveFn({ data: posRows, error: null });
        }
        return resolveFn({ data: [], error: null });
      },
      insert(row) {
        ctx.insertRow = row;
        ctx.mode = "insert";
        return b;
      },
      update(patch) {
        ctx.mode = "update";
        ctx.updatePatch = patch;
        return b;
      },
    };
    return b;
  }

  return {
    state,
    from(table) { return builder(table); },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────

describe("constants — operator-locked D2 thresholds", () => {
  it("CASH_THRESHOLDS.per_row_cents is 50 ($0.50)", () => {
    expect(CASH_THRESHOLDS.per_row_cents).toBe(50);
  });
  it("CASH_THRESHOLDS.per_domain_cents is 300 ($3)", () => {
    expect(CASH_THRESHOLDS.per_domain_cents).toBe(300);
  });
  it("CASH_THRESHOLDS is frozen", () => {
    expect(Object.isFrozen(CASH_THRESHOLDS)).toBe(true);
  });
  it("DEFAULT_PER_ROW_THRESHOLD_CENTS is 50n", () => {
    expect(DEFAULT_PER_ROW_THRESHOLD_CENTS).toBe(50n);
  });
  it("DEFAULT_PER_DOMAIN_THRESHOLD_CENTS is 300n", () => {
    expect(DEFAULT_PER_DOMAIN_THRESHOLD_CENTS).toBe(300n);
  });
});

// ──────────────────────────────────────────────────────────────────────
// BigInt + date helpers
// ──────────────────────────────────────────────────────────────────────

describe("toBigInt", () => {
  it("null → 0n", () => expect(toBigInt(null)).toBe(0n));
  it("'' → 0n", () => expect(toBigInt("")).toBe(0n));
  it("integer number → BigInt", () => expect(toBigInt(123)).toBe(123n));
  it("integer string → BigInt", () => expect(toBigInt("-42")).toBe(-42n));
  it("BigInt passthrough", () => expect(toBigInt(7n)).toBe(7n));
  it("float number throws", () => {
    expect(() => toBigInt(1.5)).toThrow();
  });
  it("non-integer string throws", () => {
    expect(() => toBigInt("1.5")).toThrow();
  });
});

describe("absBig", () => {
  it("positive passthrough", () => expect(absBig(10n)).toBe(10n));
  it("negative flips", () => expect(absBig(-10n)).toBe(10n));
  it("zero", () => expect(absBig(0n)).toBe(0n));
});

describe("isISODate", () => {
  it("valid", () => expect(isISODate("2026-05-29")).toBe(true));
  it("invalid format", () => expect(isISODate("05/29/2026")).toBe(false));
  it("non-string", () => expect(isISODate(20260529)).toBe(false));
  it("impossible date", () => expect(isISODate("2026-02-30")).toBe(false));
});

describe("addDaysISO", () => {
  it("+1 day", () => expect(addDaysISO("2026-05-29", 1)).toBe("2026-05-30"));
  it("-1 day", () => expect(addDaysISO("2026-05-29", -1)).toBe("2026-05-28"));
  it("month rollover", () => expect(addDaysISO("2026-05-31", 1)).toBe("2026-06-01"));
  it("year rollover", () => expect(addDaysISO("2026-12-31", 1)).toBe("2027-01-01"));
  it("bad iso throws", () => expect(() => addDaysISO("bad", 1)).toThrow());
});

describe("daysBetween", () => {
  it("same day = 0", () => expect(daysBetween("2026-05-29", "2026-05-29")).toBe(0));
  it("+1 day", () => expect(daysBetween("2026-05-29", "2026-05-30")).toBe(1));
  it("-1 day", () => expect(daysBetween("2026-05-30", "2026-05-29")).toBe(-1));
});

// ──────────────────────────────────────────────────────────────────────
// source-tag mapping + side classification
// ──────────────────────────────────────────────────────────────────────

describe("mapBankSourceToTag", () => {
  it("plaid → plaid_sync", () => expect(mapBankSourceToTag("plaid")).toBe("plaid_sync"));
  it("csv_upload → xoro_mirror", () =>
    expect(mapBankSourceToTag("csv_upload")).toBe("xoro_mirror"));
  it("manual → manual", () => expect(mapBankSourceToTag("manual")).toBe("manual"));
  it("unknown → manual_or_legacy", () =>
    expect(mapBankSourceToTag("other")).toBe("manual_or_legacy"));
  it("null → manual_or_legacy", () =>
    expect(mapBankSourceToTag(null)).toBe("manual_or_legacy"));
});

describe("classifyBankRow", () => {
  it("plaid → tangerine", () =>
    expect(classifyBankRow({ source: "plaid" })).toBe("tangerine"));
  it("manual → tangerine", () =>
    expect(classifyBankRow({ source: "manual" })).toBe("tangerine"));
  it("csv_upload → xoro", () =>
    expect(classifyBankRow({ source: "csv_upload" })).toBe("xoro"));
  it("unknown → tangerine (defensive)", () =>
    expect(classifyBankRow({ source: "weird" })).toBe("tangerine"));
  it("null row → null", () => expect(classifyBankRow(null)).toBe(null));
});

describe("partitionRows", () => {
  it("splits by source", () => {
    const rows = [
      bankRow({ id: "p1", source: "plaid", posted_date: "2026-05-15", amount_cents: 1000 }),
      bankRow({ id: "c1", source: "csv_upload", posted_date: "2026-05-15", amount_cents: 1000 }),
      bankRow({ id: "m1", source: "manual", posted_date: "2026-05-15", amount_cents: 1000 }),
    ];
    const { tangerine, xoro } = partitionRows(rows);
    expect(tangerine.map((r) => r.id)).toEqual(["p1", "m1"]);
    expect(xoro.map((r) => r.id)).toEqual(["c1"]);
  });
  it("empty input", () => {
    const out = partitionRows([]);
    expect(out.tangerine).toEqual([]);
    expect(out.xoro).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildMatchKey — sign preservation
// ──────────────────────────────────────────────────────────────────────

describe("buildMatchKey", () => {
  it("includes signed amount", () => {
    const dep = buildMatchKey(ACCT_A, 10000n);
    const wd = buildMatchKey(ACCT_A, -10000n);
    expect(dep).not.toBe(wd);
  });
  it("includes bank_account", () => {
    const a = buildMatchKey(ACCT_A, 100n);
    const b = buildMatchKey(ACCT_B, 100n);
    expect(a).not.toBe(b);
  });
});

// ──────────────────────────────────────────────────────────────────────
// matchWithinTolerance
// ──────────────────────────────────────────────────────────────────────

describe("matchWithinTolerance — same day", () => {
  it("matches deposit ↔ deposit", () => {
    const t = [bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-15", amount_cents: 10000 })];
    const x = [bankRow({ id: "x1", source: "csv_upload", posted_date: "2026-05-15", amount_cents: 10000 })];
    const r = matchWithinTolerance(t, x, 1);
    expect(r.matches.length).toBe(1);
    expect(r.matches[0].day_delta).toBe(0);
    expect(r.unmatchedTangerine).toEqual([]);
    expect(r.unmatchedXoro).toEqual([]);
  });
});

describe("matchWithinTolerance — ±1 day tolerance", () => {
  it("+1 day matches", () => {
    const t = [bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-16", amount_cents: 10000 })];
    const x = [bankRow({ id: "x1", source: "csv_upload", posted_date: "2026-05-15", amount_cents: 10000 })];
    const r = matchWithinTolerance(t, x, 1);
    expect(r.matches.length).toBe(1);
    expect(r.matches[0].day_delta).toBe(1);
  });
  it("-1 day matches", () => {
    const t = [bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-14", amount_cents: 10000 })];
    const x = [bankRow({ id: "x1", source: "csv_upload", posted_date: "2026-05-15", amount_cents: 10000 })];
    const r = matchWithinTolerance(t, x, 1);
    expect(r.matches.length).toBe(1);
    expect(r.matches[0].day_delta).toBe(-1);
  });
  it("±2 days does NOT match at tolerance=1", () => {
    const t = [bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-17", amount_cents: 10000 })];
    const x = [bankRow({ id: "x1", source: "csv_upload", posted_date: "2026-05-15", amount_cents: 10000 })];
    const r = matchWithinTolerance(t, x, 1);
    expect(r.matches.length).toBe(0);
    expect(r.unmatchedTangerine.length).toBe(1);
    expect(r.unmatchedXoro.length).toBe(1);
  });
  it("±2 days matches at tolerance=2", () => {
    const t = [bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-17", amount_cents: 10000 })];
    const x = [bankRow({ id: "x1", source: "csv_upload", posted_date: "2026-05-15", amount_cents: 10000 })];
    const r = matchWithinTolerance(t, x, 2);
    expect(r.matches.length).toBe(1);
  });
});

describe("matchWithinTolerance — sign-aware (deposit vs withdrawal)", () => {
  it("$100 deposit does NOT match $100 withdrawal", () => {
    const t = [bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-15", amount_cents: 10000 })];
    const x = [bankRow({ id: "x1", source: "csv_upload", posted_date: "2026-05-15", amount_cents: -10000 })];
    const r = matchWithinTolerance(t, x, 1);
    expect(r.matches.length).toBe(0);
    expect(r.unmatchedTangerine.length).toBe(1);
    expect(r.unmatchedXoro.length).toBe(1);
  });
  it("withdrawal matches withdrawal of same signed amount", () => {
    const t = [bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-15", amount_cents: -10000 })];
    const x = [bankRow({ id: "x1", source: "csv_upload", posted_date: "2026-05-15", amount_cents: -10000 })];
    const r = matchWithinTolerance(t, x, 1);
    expect(r.matches.length).toBe(1);
  });
});

describe("matchWithinTolerance — greedy 1-to-1", () => {
  it("each Xoro row consumes at most one Tangerine row", () => {
    // 2 Tangerine deposits of $100 same day, 1 Xoro deposit of $100.
    const t = [
      bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-15", amount_cents: 10000 }),
      bankRow({ id: "t2", source: "plaid", posted_date: "2026-05-15", amount_cents: 10000 }),
    ];
    const x = [
      bankRow({ id: "x1", source: "csv_upload", posted_date: "2026-05-15", amount_cents: 10000 }),
    ];
    const r = matchWithinTolerance(t, x, 1);
    expect(r.matches.length).toBe(1);
    expect(r.unmatchedTangerine.length).toBe(1);
  });
  it("2 matching pairs pair off correctly", () => {
    const t = [
      bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-15", amount_cents: 10000 }),
      bankRow({ id: "t2", source: "plaid", posted_date: "2026-05-15", amount_cents: 10000 }),
    ];
    const x = [
      bankRow({ id: "x1", source: "csv_upload", posted_date: "2026-05-15", amount_cents: 10000 }),
      bankRow({ id: "x2", source: "csv_upload", posted_date: "2026-05-15", amount_cents: 10000 }),
    ];
    const r = matchWithinTolerance(t, x, 1);
    expect(r.matches.length).toBe(2);
    expect(r.unmatchedTangerine.length).toBe(0);
    expect(r.unmatchedXoro.length).toBe(0);
  });
});

describe("matchWithinTolerance — multi-bucket separation", () => {
  it("different bank_account_ids do not collide", () => {
    const t = [bankRow({ id: "t1", bank_account_id: ACCT_A, source: "plaid", posted_date: "2026-05-15", amount_cents: 10000 })];
    const x = [bankRow({ id: "x1", bank_account_id: ACCT_B, source: "csv_upload", posted_date: "2026-05-15", amount_cents: 10000 })];
    const r = matchWithinTolerance(t, x, 1);
    expect(r.matches.length).toBe(0);
  });
  it("closest-date wins when multiple eligible", () => {
    // t1 posted 5-15. Two Xoro rows: x1 on 5-14 (delta 1), x2 on 5-15 (delta 0).
    // Greedy should prefer x2 (closer).
    const t = [bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-15", amount_cents: 10000 })];
    const x = [
      bankRow({ id: "x1", source: "csv_upload", posted_date: "2026-05-14", amount_cents: 10000 }),
      bankRow({ id: "x2", source: "csv_upload", posted_date: "2026-05-15", amount_cents: 10000 }),
    ];
    const r = matchWithinTolerance(t, x, 1);
    expect(r.matches.length).toBe(1);
    expect(r.matches[0].xoro.id).toBe("x2");
    expect(r.unmatchedXoro.map((r) => r.id)).toEqual(["x1"]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildVarianceRows — source_tag carried + threshold boundaries
// ──────────────────────────────────────────────────────────────────────

describe("buildVarianceRows — Tangerine-only", () => {
  it("emits +amount variance with plaid_sync tag", () => {
    const rows = buildVarianceRows({
      unmatchedTangerine: [
        bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-15", amount_cents: 10000 }),
      ],
      unmatchedXoro: [],
      perRowThresholdCents: 50n,
    });
    expect(rows.length).toBe(1);
    expect(rows[0].source_tag).toBe("plaid_sync");
    expect(rows[0].tangerine_amount_cents).toBe(10000n);
    expect(rows[0].xoro_amount_cents).toBe(0n);
    expect(rows[0].variance_amount_cents).toBe(10000n);
    expect(rows[0].status).toBe("over");
    expect(rows[0].side).toBe("tangerine_only");
  });
  it("manual source maps to 'manual' tag", () => {
    const rows = buildVarianceRows({
      unmatchedTangerine: [
        bankRow({ id: "m1", source: "manual", posted_date: "2026-05-15", amount_cents: 10000 }),
      ],
      unmatchedXoro: [],
      perRowThresholdCents: 50n,
    });
    expect(rows[0].source_tag).toBe("manual");
  });
});

describe("buildVarianceRows — Xoro-only", () => {
  it("emits -amount variance with xoro_mirror tag", () => {
    const rows = buildVarianceRows({
      unmatchedTangerine: [],
      unmatchedXoro: [
        bankRow({ id: "x1", source: "csv_upload", posted_date: "2026-05-15", amount_cents: 10000 }),
      ],
      perRowThresholdCents: 50n,
    });
    expect(rows[0].source_tag).toBe("xoro_mirror");
    expect(rows[0].tangerine_amount_cents).toBe(0n);
    expect(rows[0].xoro_amount_cents).toBe(10000n);
    expect(rows[0].variance_amount_cents).toBe(-10000n);
    expect(rows[0].side).toBe("xoro_only");
  });
});

describe("buildVarianceRows — threshold boundary (D2 LOCKED $0.50)", () => {
  it("49c → within", () => {
    const rows = buildVarianceRows({
      unmatchedTangerine: [bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-15", amount_cents: 49 })],
      unmatchedXoro: [],
      perRowThresholdCents: 50n,
    });
    expect(rows[0].status).toBe("within");
  });
  it("50c → within (boundary inclusive)", () => {
    const rows = buildVarianceRows({
      unmatchedTangerine: [bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-15", amount_cents: 50 })],
      unmatchedXoro: [],
      perRowThresholdCents: 50n,
    });
    expect(rows[0].status).toBe("within");
  });
  it("51c → over", () => {
    const rows = buildVarianceRows({
      unmatchedTangerine: [bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-15", amount_cents: 51 })],
      unmatchedXoro: [],
      perRowThresholdCents: 50n,
    });
    expect(rows[0].status).toBe("over");
  });
  it("-51c (withdrawal variance) → over (abs check)", () => {
    const rows = buildVarianceRows({
      unmatchedTangerine: [bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-15", amount_cents: -51 })],
      unmatchedXoro: [],
      perRowThresholdCents: 50n,
    });
    expect(rows[0].status).toBe("over");
  });
});

describe("buildVarianceRows — deterministic ordering", () => {
  it("sorts by posted_date then bank_transaction_id", () => {
    const rows = buildVarianceRows({
      unmatchedTangerine: [
        bankRow({ id: "t2", source: "plaid", posted_date: "2026-05-15", amount_cents: 100 }),
        bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-15", amount_cents: 100 }),
        bankRow({ id: "t3", source: "plaid", posted_date: "2026-05-14", amount_cents: 100 }),
      ],
      unmatchedXoro: [],
      perRowThresholdCents: 50n,
    });
    expect(rows.map((r) => r.bank_transaction_id)).toEqual(["t3", "t1", "t2"]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// composeTotals + decideRunStatus
// ──────────────────────────────────────────────────────────────────────

describe("composeTotals", () => {
  it("aggregates per_source_tag with BigInt serialization", () => {
    const totals = composeTotals({
      varianceRows: [
        {
          bank_transaction_id: "t1",
          source_tag: "plaid_sync",
          tangerine_amount_cents: 10000n,
          xoro_amount_cents: 0n,
          variance_amount_cents: 10000n,
          status: "over",
        },
        {
          bank_transaction_id: "x1",
          source_tag: "xoro_mirror",
          tangerine_amount_cents: 0n,
          xoro_amount_cents: 5000n,
          variance_amount_cents: -5000n,
          status: "over",
        },
        {
          bank_transaction_id: "t2",
          source_tag: "plaid_sync",
          tangerine_amount_cents: 30n,
          xoro_amount_cents: 0n,
          variance_amount_cents: 30n,
          status: "within",
        },
      ],
      matchCount: 5,
      tangerinePulledCount: 10,
      xoroPulledCount: 6,
      perRowThresholdCents: 50n,
      perDomainThresholdCents: 300n,
    });
    expect(totals.rows_compared).toBe(3);
    expect(totals.variances_found).toBe(2);
    expect(totals.total_abs_variance_cents).toBe("15000");
    expect(totals.matches_found).toBe(5);
    expect(totals.tangerine_rows_pulled).toBe(10);
    expect(totals.xoro_rows_pulled).toBe(6);
    expect(totals.per_source_tag.plaid_sync.rows_compared).toBe(2);
    expect(totals.per_source_tag.plaid_sync.variances_found).toBe(1);
    expect(totals.per_source_tag.xoro_mirror.variances_found).toBe(1);
    expect(totals.domain_threshold_crossed).toBe(true); // 15000 > 300
  });

  it("under domain ceiling → not crossed", () => {
    const totals = composeTotals({
      varianceRows: [
        {
          bank_transaction_id: "t1",
          source_tag: "plaid_sync",
          tangerine_amount_cents: 100n,
          xoro_amount_cents: 0n,
          variance_amount_cents: 100n,
          status: "over",
        },
      ],
      matchCount: 0,
      tangerinePulledCount: 1,
      xoroPulledCount: 0,
      perRowThresholdCents: 50n,
      perDomainThresholdCents: 300n,
    });
    expect(totals.domain_threshold_crossed).toBe(false); // 100 < 300
  });

  it("at domain ceiling (300c) → not crossed (strictly >)", () => {
    const totals = composeTotals({
      varianceRows: [
        { bank_transaction_id: "t1", source_tag: "plaid_sync", tangerine_amount_cents: 300n, xoro_amount_cents: 0n, variance_amount_cents: 300n, status: "over" },
      ],
      matchCount: 0,
      tangerinePulledCount: 1,
      xoroPulledCount: 0,
      perRowThresholdCents: 50n,
      perDomainThresholdCents: 300n,
    });
    expect(totals.domain_threshold_crossed).toBe(false);
  });

  it("above domain ceiling (301c) → crossed", () => {
    const totals = composeTotals({
      varianceRows: [
        { bank_transaction_id: "t1", source_tag: "plaid_sync", tangerine_amount_cents: 301n, xoro_amount_cents: 0n, variance_amount_cents: 301n, status: "over" },
      ],
      matchCount: 0,
      tangerinePulledCount: 1,
      xoroPulledCount: 0,
      perRowThresholdCents: 50n,
      perDomainThresholdCents: 300n,
    });
    expect(totals.domain_threshold_crossed).toBe(true);
  });
});

describe("decideRunStatus", () => {
  it("0 variances → clean", () =>
    expect(decideRunStatus({ variances_found: 0 })).toBe("clean"));
  it("1 variance → variance", () =>
    expect(decideRunStatus({ variances_found: 1 })).toBe("variance"));
  it("missing → clean", () =>
    expect(decideRunStatus({})).toBe("clean"));
});

// ──────────────────────────────────────────────────────────────────────
// runCashReconciliation — input validation
// ──────────────────────────────────────────────────────────────────────

describe("runCashReconciliation — bad inputs", () => {
  it("missing admin", async () => {
    const r = await runCashReconciliation({
      entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31",
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("error");
    expect(r.errors[0].kind).toBe("bad_admin");
  });
  it("missing entity_id", async () => {
    const r = await runCashReconciliation({
      admin: makeMockSupabase(), period_start: "2026-05-01", period_end: "2026-05-31",
    });
    expect(r.errors[0].kind).toBe("bad_entity");
  });
  it("non-uuid entity_id", async () => {
    const r = await runCashReconciliation({
      admin: makeMockSupabase(), entity_id: "not-uuid", period_start: "2026-05-01", period_end: "2026-05-31",
    });
    expect(r.errors[0].kind).toBe("bad_entity");
  });
  it("bad period_start", async () => {
    const r = await runCashReconciliation({
      admin: makeMockSupabase(), entity_id: ENTITY, period_start: "bad", period_end: "2026-05-31",
    });
    expect(r.errors[0].kind).toBe("bad_period_start");
  });
  it("bad period_end", async () => {
    const r = await runCashReconciliation({
      admin: makeMockSupabase(), entity_id: ENTITY, period_start: "2026-05-01", period_end: "bad",
    });
    expect(r.errors[0].kind).toBe("bad_period_end");
  });
  it("period_end < period_start", async () => {
    const r = await runCashReconciliation({
      admin: makeMockSupabase(), entity_id: ENTITY, period_start: "2026-05-31", period_end: "2026-05-01",
    });
    expect(r.errors[0].kind).toBe("bad_period_order");
  });
  it("bad cadence", async () => {
    const r = await runCashReconciliation({
      admin: makeMockSupabase(), entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", cadence: "daily",
    });
    expect(r.errors[0].kind).toBe("bad_cadence");
  });
  it("bad replay_of_id", async () => {
    const r = await runCashReconciliation({
      admin: makeMockSupabase(), entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", replay_of_id: "not-uuid",
    });
    expect(r.errors[0].kind).toBe("bad_replay_of_id");
  });
  it("bad tolerance_days (negative)", async () => {
    const r = await runCashReconciliation({
      admin: makeMockSupabase(), entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", tolerance_days: -1,
    });
    expect(r.errors[0].kind).toBe("bad_tolerance_days");
  });
  it("bad tolerance_days (too large)", async () => {
    const r = await runCashReconciliation({
      admin: makeMockSupabase(), entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", tolerance_days: 99,
    });
    expect(r.errors[0].kind).toBe("bad_tolerance_days");
  });
});

// ──────────────────────────────────────────────────────────────────────
// runCashReconciliation — happy paths
// ──────────────────────────────────────────────────────────────────────

describe("runCashReconciliation — happy path (clean)", () => {
  it("all bank txns paired → clean run with zero variances", async () => {
    const admin = makeMockSupabase({
      bankRows: [
        bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-15", amount_cents: 10000 }),
        bankRow({ id: "x1", source: "csv_upload", posted_date: "2026-05-15", amount_cents: 10000 }),
      ],
    });
    const r = await runCashReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", now: NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("clean");
    expect(r.recon_run_id).toBe(RUN_ID);
    expect(r.summary.rows_compared).toBe(0);
    expect(r.summary.variances_found).toBe(0);
    expect(r.summary.matches_found).toBe(1);
    // run was finalized
    expect(admin.state.runUpdates.length).toBe(1);
    expect(admin.state.runUpdates[0].patch.status).toBe("clean");
  });

  it("empty period → clean run", async () => {
    const admin = makeMockSupabase({ bankRows: [] });
    const r = await runCashReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", now: NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("clean");
    expect(r.summary.rows_compared).toBe(0);
  });
});

describe("runCashReconciliation — happy path (variance)", () => {
  it("Tangerine-only $100 deposit → variance run with ceiling crossed", async () => {
    const admin = makeMockSupabase({
      bankRows: [
        bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-15", amount_cents: 10000 }),
      ],
    });
    const r = await runCashReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", now: NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("variance");
    expect(r.summary.variances_found).toBe(1);
    expect(r.summary.domain_threshold_crossed).toBe(true);
    expect(admin.state.varianceInserts.length).toBe(1);
    expect(admin.state.varianceInserts[0].rows[0].source_tag).toBe("plaid_sync");
    expect(admin.state.varianceInserts[0].rows[0].source_table).toBe("bank_transactions");
    expect(admin.state.varianceInserts[0].rows[0].source_id).toBe("t1");
  });

  it("$0.51 unmatched → over threshold, variance run", async () => {
    const admin = makeMockSupabase({
      bankRows: [
        bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-15", amount_cents: 51 }),
      ],
    });
    const r = await runCashReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", now: NOW,
    });
    expect(r.status).toBe("variance");
    expect(r.summary.variances_found).toBe(1);
  });

  it("$0.50 unmatched → within (boundary inclusive); 0 variances → still clean status", async () => {
    const admin = makeMockSupabase({
      bankRows: [
        bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-15", amount_cents: 50 }),
      ],
    });
    const r = await runCashReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", now: NOW,
    });
    // Row recorded (status='within' on variance row), but variances_found=0 so run = clean.
    expect(r.summary.rows_compared).toBe(1);
    expect(r.summary.variances_found).toBe(0);
    expect(r.status).toBe("clean");
  });
});

describe("runCashReconciliation — ±1 day match across period boundary", () => {
  it("Xoro on period_end+1 still matches Tangerine on period_end", async () => {
    const admin = makeMockSupabase({
      bankRows: [
        bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-31", amount_cents: 10000 }),
        bankRow({ id: "x1", source: "csv_upload", posted_date: "2026-06-01", amount_cents: 10000 }),
      ],
    });
    const r = await runCashReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", now: NOW,
    });
    // x1 is outside period but within widened window; should pair off t1.
    expect(r.status).toBe("clean");
    expect(r.summary.matches_found).toBe(1);
    expect(r.summary.variances_found).toBe(0);
  });

  it("Xoro inside period unmatched by Tangerine outside period (widened) does not pair", async () => {
    // Tangerine row 2026-06-03 is OUTSIDE the widened (period_end+1 = 06-01) window,
    // so it won't appear in the read at all. Xoro row 5-31 is inside period.
    const admin = makeMockSupabase({
      bankRows: [
        bankRow({ id: "x1", source: "csv_upload", posted_date: "2026-05-31", amount_cents: 10000 }),
        bankRow({ id: "t1", source: "plaid", posted_date: "2026-06-03", amount_cents: 10000 }),
      ],
    });
    const r = await runCashReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", now: NOW,
    });
    expect(r.status).toBe("variance");
    expect(r.summary.variances_found).toBe(1);
    // The unmatched Xoro row IS in-period so it surfaces.
    expect(admin.state.varianceInserts[0].rows[0].source_id).toBe("x1");
  });
});

describe("runCashReconciliation — source_tag preservation (D7)", () => {
  it("mixed-source variances carry their mapped tag", async () => {
    const admin = makeMockSupabase({
      bankRows: [
        bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-15", amount_cents: 10000 }),
        bankRow({ id: "t2", source: "manual", posted_date: "2026-05-16", amount_cents: 20000 }),
        bankRow({ id: "x1", source: "csv_upload", posted_date: "2026-05-17", amount_cents: 5000 }),
      ],
    });
    const r = await runCashReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", now: NOW,
    });
    expect(r.summary.per_source_tag.plaid_sync).toBeDefined();
    expect(r.summary.per_source_tag.manual).toBeDefined();
    expect(r.summary.per_source_tag.xoro_mirror).toBeDefined();
  });
});

describe("runCashReconciliation — replay (D11)", () => {
  it("replay_of_id recorded on recon_runs insert", async () => {
    const admin = makeMockSupabase({ bankRows: [] });
    const r = await runCashReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31",
      cadence: "replay", replay_of_id: REPLAY_OF, now: NOW,
    });
    expect(r.ok).toBe(true);
    expect(admin.state.runInserts[0].row.cadence).toBe("replay");
    expect(admin.state.runInserts[0].row.replay_of_id).toBe(REPLAY_OF);
  });

  it("default cadence is 'weekly' (cron path)", async () => {
    const admin = makeMockSupabase({ bankRows: [] });
    await runCashReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", now: NOW,
    });
    expect(admin.state.runInserts[0].row.cadence).toBe("weekly");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Engine error branches
// ──────────────────────────────────────────────────────────────────────

describe("runCashReconciliation — error branches", () => {
  it("recon_runs insert error → ok:false with no run_id", async () => {
    const admin = makeMockSupabase({
      runInsertError: { message: "constraint" },
    });
    const r = await runCashReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.recon_run_id).toBe(null);
    expect(r.errors[0].kind).toBe("recon_run_insert_failed");
  });

  it("bank_transactions read error → run finalized 'error'", async () => {
    const admin = makeMockSupabase({
      bankReadError: { message: "perm denied" },
    });
    const r = await runCashReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("error");
    expect(r.errors[0].kind).toBe("bank_transactions_read_failed");
    expect(admin.state.runUpdates[0].patch.status).toBe("error");
  });

  it("variances insert error → ok:false 'error'", async () => {
    const admin = makeMockSupabase({
      bankRows: [
        bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-15", amount_cents: 10000 }),
      ],
      variancesInsertError: { message: "fk" },
    });
    const r = await runCashReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].kind).toBe("variances_insert_failed");
  });

  it("finalize error → ok:false", async () => {
    const admin = makeMockSupabase({
      bankRows: [],
      runFinalizeError: { message: "timeout" },
    });
    const r = await runCashReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.errors[r.errors.length - 1].kind).toBe("recon_run_finalize_failed");
  });

  it("sanity reads erroring → warnings recorded; run still completes", async () => {
    const admin = makeMockSupabase({
      bankRows: [],
      arReadError: { message: "ar boom" },
      posReadError: { message: "pos boom" },
    });
    const r = await runCashReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", now: NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.summary.sanity.warnings.length).toBe(2);
  });

  it("engine throws after run inserted → catch path finalizes 'error'", async () => {
    // Build an admin that lets the recon_runs insert succeed, then
    // throws on the next .from() call (bank_transactions read). This
    // exercises the outer try/catch in runCashReconciliation.
    let calls = 0;
    const admin = {
      state: { runUpdates: [] },
      from(table) {
        calls += 1;
        if (table === "recon_runs" && calls === 1) {
          // first call: succeed insert
          return {
            insert() { return this; },
            select() { return this; },
            single() { return Promise.resolve({ data: { id: RUN_ID }, error: null }); },
            update() { return this; },
            eq() { return this; },
            then(resolve) {
              admin.state.runUpdates.push({ patch: "finalize" });
              return resolve({ data: null, error: null });
            },
          };
        }
        if (table === "bank_transactions") {
          throw new Error("kaboom");
        }
        // subsequent recon_runs (finalize)
        return {
          update() { return this; },
          eq() { return this; },
          then(resolve) {
            admin.state.runUpdates.push({ patch: "finalize" });
            return resolve({ data: null, error: null });
          },
        };
      },
    };
    const r = await runCashReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("error");
    expect(r.recon_run_id).toBe(RUN_ID);
    expect(r.errors[0].kind).toBe("engine_threw");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Period bounds: variances are only emitted for in-period rows
// ──────────────────────────────────────────────────────────────────────

describe("runCashReconciliation — period bounds", () => {
  it("rows just BEFORE period_start (within widened window) don't surface as variances", async () => {
    const admin = makeMockSupabase({
      bankRows: [
        // Tangerine row inside period — should pair with the Xoro row outside
        // (within widened window).
        bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-01", amount_cents: 10000 }),
        bankRow({ id: "x1", source: "csv_upload", posted_date: "2026-04-30", amount_cents: 10000 }),
      ],
    });
    const r = await runCashReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", now: NOW,
    });
    expect(r.status).toBe("clean");
    expect(r.summary.matches_found).toBe(1);
  });

  it("Tangerine pulled count reflects widened window", async () => {
    const admin = makeMockSupabase({
      bankRows: [
        // Inside period
        bankRow({ id: "t1", source: "plaid", posted_date: "2026-05-15", amount_cents: 10000 }),
        // Outside period but inside widened window
        bankRow({ id: "t2", source: "plaid", posted_date: "2026-04-30", amount_cents: 20000 }),
      ],
    });
    const r = await runCashReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-01", period_end: "2026-05-31", now: NOW,
    });
    expect(r.summary.tangerine_rows_pulled).toBe(2); // both inside widened window
    expect(r.summary.variances_found).toBe(1); // only t1 in-period
  });
});
