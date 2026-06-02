// Tangerine P9-3 — tests for the AR reconciliation engine.
//
// Coverage:
//   - BigInt helpers (toBigInt, centsToDecimal, absBig, dollarsToCents)
//   - isISODate validator
//   - deriveXoroSourceTag — shopify / fba / walmart / faire / fallback
//   - xoroRowToCents — net → gross → qty*price fallback
//   - groupTangerineByCustomerSource — per-channel separation (D7)
//   - groupXoroByCustomerSource — lookup resolution + per-channel grouping
//   - buildVarianceRows — union of keys, status threshold, percent calc
//   - composeTotals — per_source_tag, domain ceiling, BigInt serialization
//   - decideRunStatus — clean / variance branches
//   - runArReconciliation orchestrator:
//       * bad inputs (admin / entity_id / dates / cadence / replay_of_id)
//       * happy-path clean
//       * happy-path variance with domain ceiling crossed
//       * source_tag-aware variance surfaces per channel separately
//       * empty period → clean run
//       * replay records replay_of_id
//       * Tangerine read error
//       * Xoro read error
//       * customer lookup partial failure (non-fatal)
//       * variances insert error
//       * finalize error
//       * engine throws (catch path)

import { describe, it, expect } from "vitest";
import {
  AR_SOURCE_TAGS,
  DEFAULT_PER_ROW_THRESHOLD_CENTS,
  DEFAULT_PER_DOMAIN_THRESHOLD_CENTS,
  toBigInt,
  centsToDecimal,
  absBig,
  isISODate,
  dollarsToCents,
  deriveXoroSourceTag,
  xoroRowToCents,
  groupTangerineByCustomerSource,
  groupXoroByCustomerSource,
  buildVarianceRows,
  composeTotals,
  decideRunStatus,
  runArReconciliation,
} from "../ar-engine.js";

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

const ENTITY = "11111111-1111-1111-1111-111111111111";
const RUN_ID = "22222222-2222-2222-2222-222222222222";
const REPLAY_OF = "33333333-3333-3333-3333-333333333333";
const CUST_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CUST_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const LEGACY_A = "44444444-4444-4444-4444-444444444444";
const LEGACY_B = "55555555-5555-5555-5555-555555555555";
const NOW = "2026-05-29T12:00:00.000Z";

function tanInv({ customer_id, source, total_amount_cents, invoice_number }) {
  return {
    id: `inv-${invoice_number}`,
    customer_id,
    source,
    total_amount_cents,
    invoice_date: "2026-05-15",
    gl_status: "sent",
    invoice_number,
  };
}

function xoroInv({ customer_id, invoice_number, net_amount }) {
  return {
    id: `xoro-${invoice_number}`,
    customer_id,
    invoice_number,
    txn_date: "2026-05-15",
    qty: 1,
    unit_price: net_amount,
    gross_amount: net_amount,
    discount_amount: 0,
    net_amount,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Mock supabase — table-aware micro-builder. Each test seeds the rows
// it needs and we capture every insert/update for assertions.
// ──────────────────────────────────────────────────────────────────────

function makeMockSupabase({
  tanRows = [],
  xoroRows = [],
  customerMasterRows = [],
  customersRows = [],
  insertedRunId = RUN_ID,
  runInsertError = null,
  tanReadError = null,
  xoroReadError = null,
  customerMasterError = null,
  customersError = null,
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
        if (table === "ar_invoices") {
          if (tanReadError) return resolveFn({ data: null, error: tanReadError });
          return resolveFn({ data: tanRows, error: null });
        }
        if (table === "ip_sales_history_wholesale") {
          if (xoroReadError) return resolveFn({ data: null, error: xoroReadError });
          return resolveFn({ data: xoroRows, error: null });
        }
        if (table === "ip_customer_master") {
          if (customerMasterError) return resolveFn({ data: null, error: customerMasterError });
          return resolveFn({ data: customerMasterRows, error: null });
        }
        if (table === "customers") {
          if (customersError) return resolveFn({ data: null, error: customersError });
          return resolveFn({ data: customersRows, error: null });
        }
        return resolveFn({ data: [], error: null });
      },
      insert(row) {
        state.inserts = state.inserts || [];
        state.inserts.push({ table, row });
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
// Constants exposed
// ──────────────────────────────────────────────────────────────────────

describe("constants", () => {
  it("AR_SOURCE_TAGS includes the T10 channel set", () => {
    expect(AR_SOURCE_TAGS).toEqual(
      expect.arrayContaining(["shopify", "fba", "walmart", "faire", "xoro_mirror", "manual"]),
    );
  });
  it("default per-row threshold is $1.00 (100 cents) per D2", () => {
    expect(DEFAULT_PER_ROW_THRESHOLD_CENTS).toBe(100n);
  });
  it("default per-domain threshold is $100.00 (10_000 cents) per D2", () => {
    expect(DEFAULT_PER_DOMAIN_THRESHOLD_CENTS).toBe(10_000n);
  });
});

// ──────────────────────────────────────────────────────────────────────
// BigInt helpers
// ──────────────────────────────────────────────────────────────────────

describe("toBigInt", () => {
  it("accepts integers, strings, bigints, null", () => {
    expect(toBigInt(0)).toBe(0n);
    expect(toBigInt(100)).toBe(100n);
    expect(toBigInt("-50")).toBe(-50n);
    expect(toBigInt(456n)).toBe(456n);
    expect(toBigInt(null)).toBe(0n);
    expect(toBigInt("")).toBe(0n);
  });
  it("rejects floats and non-integer strings", () => {
    expect(() => toBigInt(1.5)).toThrow();
    expect(() => toBigInt("1.5")).toThrow();
    expect(() => toBigInt("abc")).toThrow();
  });
});

describe("centsToDecimal", () => {
  it("formats positive cents", () => {
    expect(centsToDecimal(0n)).toBe("0.00");
    expect(centsToDecimal(100n)).toBe("1.00");
    expect(centsToDecimal(12345n)).toBe("123.45");
    expect(centsToDecimal(9n)).toBe("0.09");
  });
  it("formats negative cents", () => {
    expect(centsToDecimal(-500n)).toBe("-5.00");
    expect(centsToDecimal(-1n)).toBe("-0.01");
  });
});

describe("absBig", () => {
  it("returns absolute value for BigInt", () => {
    expect(absBig(0n)).toBe(0n);
    expect(absBig(50n)).toBe(50n);
    expect(absBig(-50n)).toBe(50n);
  });
});

describe("isISODate", () => {
  it("accepts valid YYYY-MM-DD", () => {
    expect(isISODate("2026-05-29")).toBe(true);
    expect(isISODate("2024-02-29")).toBe(true);
  });
  it("rejects malformed dates", () => {
    expect(isISODate("2026-5-29")).toBe(false);
    expect(isISODate("2026-05-32")).toBe(false);
    expect(isISODate("2025-02-29")).toBe(false); // non-leap
    expect(isISODate(null)).toBe(false);
    expect(isISODate(20260529)).toBe(false);
  });
});

describe("dollarsToCents", () => {
  it("rounds dollars to cents", () => {
    expect(dollarsToCents(1)).toBe(100n);
    expect(dollarsToCents(1.23)).toBe(123n);
    expect(dollarsToCents("4.5")).toBe(450n);
  });
  it("handles null / Infinity / NaN", () => {
    expect(dollarsToCents(null)).toBe(0n);
    expect(dollarsToCents(undefined)).toBe(0n);
    expect(dollarsToCents(Infinity)).toBe(0n);
    expect(dollarsToCents("not a number")).toBe(0n);
  });
});

// ──────────────────────────────────────────────────────────────────────
// deriveXoroSourceTag — D7 per-channel grouping
// ──────────────────────────────────────────────────────────────────────

describe("deriveXoroSourceTag", () => {
  it("maps SHOP prefix to shopify", () => {
    expect(deriveXoroSourceTag("SHOP-12345")).toBe("shopify");
    expect(deriveXoroSourceTag("shop-12345")).toBe("shopify");
  });
  it("maps AMZ and FBA prefixes to fba", () => {
    expect(deriveXoroSourceTag("AMZ-001")).toBe("fba");
    expect(deriveXoroSourceTag("FBA-002")).toBe("fba");
  });
  it("maps WMT and WM- prefixes to walmart", () => {
    expect(deriveXoroSourceTag("WMT-9001")).toBe("walmart");
    expect(deriveXoroSourceTag("WM-9001")).toBe("walmart");
  });
  it("maps FAIRE and FE- prefixes to faire", () => {
    expect(deriveXoroSourceTag("FAIRE-700")).toBe("faire");
    expect(deriveXoroSourceTag("FE-700")).toBe("faire");
  });
  it("falls back to xoro_mirror for everything else", () => {
    expect(deriveXoroSourceTag("INV-1001")).toBe("xoro_mirror");
    expect(deriveXoroSourceTag("R-2026-001")).toBe("xoro_mirror");
    expect(deriveXoroSourceTag(null)).toBe("xoro_mirror");
    expect(deriveXoroSourceTag("")).toBe("xoro_mirror");
    expect(deriveXoroSourceTag("   ")).toBe("xoro_mirror");
  });
});

// ──────────────────────────────────────────────────────────────────────
// xoroRowToCents — waterfall preference
// ──────────────────────────────────────────────────────────────────────

describe("xoroRowToCents", () => {
  it("prefers net_amount", () => {
    expect(xoroRowToCents({ net_amount: 10, gross_amount: 20, qty: 5, unit_price: 4 })).toBe(1000n);
  });
  it("falls back to gross_amount when net is null", () => {
    expect(xoroRowToCents({ net_amount: null, gross_amount: 20, qty: 5, unit_price: 4 })).toBe(2000n);
  });
  it("falls back to qty * unit_price when net + gross are null", () => {
    expect(xoroRowToCents({ qty: 5, unit_price: 4 })).toBe(2000n);
  });
  it("returns 0n when nothing usable", () => {
    expect(xoroRowToCents({})).toBe(0n);
    expect(xoroRowToCents(null)).toBe(0n);
  });
});

// ──────────────────────────────────────────────────────────────────────
// groupTangerineByCustomerSource — D7 per-channel groupings
// ──────────────────────────────────────────────────────────────────────

describe("groupTangerineByCustomerSource", () => {
  it("groups invoices by (customer, source)", () => {
    const rows = [
      tanInv({ customer_id: CUST_A, source: "shopify", total_amount_cents: 1000, invoice_number: "SHOP-1" }),
      tanInv({ customer_id: CUST_A, source: "shopify", total_amount_cents: 2000, invoice_number: "SHOP-2" }),
      tanInv({ customer_id: CUST_A, source: "manual",  total_amount_cents: 500,  invoice_number: "M-1" }),
    ];
    const g = groupTangerineByCustomerSource(rows);
    expect(g.size).toBe(2);
    const shopify = g.get(`${CUST_A}|shopify`);
    expect(shopify.cents).toBe(3000n);
    expect(shopify.rows).toHaveLength(2);
    const manual = g.get(`${CUST_A}|manual`);
    expect(manual.cents).toBe(500n);
  });
  it("D7 — keeps shopify and walmart variance decideable per channel", () => {
    const rows = [
      tanInv({ customer_id: CUST_A, source: "shopify", total_amount_cents: 1000, invoice_number: "SHOP-1" }),
      tanInv({ customer_id: CUST_A, source: "walmart", total_amount_cents: 1000, invoice_number: "WMT-1" }),
    ];
    const g = groupTangerineByCustomerSource(rows);
    expect(g.size).toBe(2);
    expect(g.has(`${CUST_A}|shopify`)).toBe(true);
    expect(g.has(`${CUST_A}|walmart`)).toBe(true);
  });
  it("treats missing source as manual", () => {
    const rows = [{ customer_id: CUST_A, total_amount_cents: 100 }];
    const g = groupTangerineByCustomerSource(rows);
    expect(g.get(`${CUST_A}|manual`).cents).toBe(100n);
  });
  it("handles empty input", () => {
    expect(groupTangerineByCustomerSource([]).size).toBe(0);
    expect(groupTangerineByCustomerSource(null).size).toBe(0);
  });
  it("handles missing customer_id by grouping under empty slot", () => {
    const rows = [{ customer_id: null, source: "manual", total_amount_cents: 50 }];
    const g = groupTangerineByCustomerSource(rows);
    expect(g.get(`|manual`).cents).toBe(50n);
  });
});

// ──────────────────────────────────────────────────────────────────────
// groupXoroByCustomerSource — derives source_tag + resolves lookup
// ──────────────────────────────────────────────────────────────────────

describe("groupXoroByCustomerSource", () => {
  it("derives source_tag from invoice_number and groups by resolved id", () => {
    const lookup = new Map([[LEGACY_A, CUST_A]]);
    const rows = [
      xoroInv({ customer_id: LEGACY_A, invoice_number: "SHOP-1", net_amount: 10 }),
      xoroInv({ customer_id: LEGACY_A, invoice_number: "SHOP-2", net_amount: 20 }),
      xoroInv({ customer_id: LEGACY_A, invoice_number: "WMT-1",  net_amount: 30 }),
    ];
    const g = groupXoroByCustomerSource(rows, lookup);
    expect(g.size).toBe(2);
    expect(g.get(`${CUST_A}|shopify`).cents).toBe(3000n);
    expect(g.get(`${CUST_A}|walmart`).cents).toBe(3000n);
  });
  it("falls back to xoro_mirror tag for non-marketplace prefixes", () => {
    const lookup = new Map([[LEGACY_A, CUST_A]]);
    const rows = [xoroInv({ customer_id: LEGACY_A, invoice_number: "INV-1", net_amount: 5 })];
    const g = groupXoroByCustomerSource(rows, lookup);
    expect(g.get(`${CUST_A}|xoro_mirror`).cents).toBe(500n);
  });
  it("unresolved legacy ids fall through with empty customer slot", () => {
    const lookup = new Map(); // no resolution
    const rows = [xoroInv({ customer_id: LEGACY_A, invoice_number: "SHOP-1", net_amount: 10 })];
    const g = groupXoroByCustomerSource(rows, lookup);
    expect(g.get(`|shopify`).cents).toBe(1000n);
  });
  it("handles empty input", () => {
    expect(groupXoroByCustomerSource([], new Map()).size).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildVarianceRows — union + status + percent
// ──────────────────────────────────────────────────────────────────────

describe("buildVarianceRows", () => {
  it("union of keys, status=within when |variance| <= threshold", () => {
    const tanG = new Map([
      [`${CUST_A}|shopify`, { customer_id: CUST_A, source_tag: "shopify", cents: 10_000n, rows: [] }],
    ]);
    const xorG = new Map([
      [`${CUST_A}|shopify`, { customer_id: CUST_A, source_tag: "shopify", cents: 10_050n, rows: [] }],
    ]);
    const rows = buildVarianceRows({ tangerineGroups: tanG, xoroGroups: xorG, perRowThresholdCents: 100n });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("within");
    expect(rows[0].variance_amount_cents).toBe(-50n);
  });
  it("status=over when |variance| > threshold", () => {
    const tanG = new Map([
      [`${CUST_A}|shopify`, { customer_id: CUST_A, source_tag: "shopify", cents: 10_000n, rows: [] }],
    ]);
    const xorG = new Map([
      [`${CUST_A}|shopify`, { customer_id: CUST_A, source_tag: "shopify", cents: 9_500n, rows: [] }],
    ]);
    const rows = buildVarianceRows({ tangerineGroups: tanG, xoroGroups: xorG, perRowThresholdCents: 100n });
    expect(rows[0].status).toBe("over");
    expect(rows[0].variance_amount_cents).toBe(500n);
  });
  it("union includes keys missing from one side (zero on absent side)", () => {
    const tanG = new Map([
      [`${CUST_A}|shopify`, { customer_id: CUST_A, source_tag: "shopify", cents: 1000n, rows: [] }],
    ]);
    const xorG = new Map([
      [`${CUST_B}|walmart`, { customer_id: CUST_B, source_tag: "walmart", cents: 2000n, rows: [] }],
    ]);
    const rows = buildVarianceRows({ tangerineGroups: tanG, xoroGroups: xorG, perRowThresholdCents: 100n });
    expect(rows).toHaveLength(2);
    const shopify = rows.find((r) => r.source_tag === "shopify");
    expect(shopify.tangerine_amount_cents).toBe(1000n);
    expect(shopify.xoro_amount_cents).toBe(0n);
    expect(shopify.status).toBe("over");
    const walmart = rows.find((r) => r.source_tag === "walmart");
    expect(walmart.tangerine_amount_cents).toBe(0n);
    expect(walmart.xoro_amount_cents).toBe(2000n);
  });
  it("computes variance_percent against the sum-abs denominator", () => {
    const tanG = new Map([
      [`${CUST_A}|shopify`, { customer_id: CUST_A, source_tag: "shopify", cents: 10_000n, rows: [] }],
    ]);
    const xorG = new Map([
      [`${CUST_A}|shopify`, { customer_id: CUST_A, source_tag: "shopify", cents: 10_000n, rows: [] }],
    ]);
    const rows = buildVarianceRows({ tangerineGroups: tanG, xoroGroups: xorG, perRowThresholdCents: 100n });
    expect(rows[0].variance_percent).toBe(0);
  });
  it("variance_percent is null when both sides are zero", () => {
    const tanG = new Map([
      [`${CUST_A}|shopify`, { customer_id: CUST_A, source_tag: "shopify", cents: 0n, rows: [] }],
    ]);
    const rows = buildVarianceRows({ tangerineGroups: tanG, xoroGroups: new Map(), perRowThresholdCents: 100n });
    expect(rows[0].variance_percent).toBeNull();
  });
  it("sorts rows deterministically by key", () => {
    const tanG = new Map([
      [`${CUST_B}|walmart`, { customer_id: CUST_B, source_tag: "walmart", cents: 100n, rows: [] }],
      [`${CUST_A}|shopify`, { customer_id: CUST_A, source_tag: "shopify", cents: 100n, rows: [] }],
    ]);
    const rows = buildVarianceRows({ tangerineGroups: tanG, xoroGroups: new Map(), perRowThresholdCents: 100n });
    expect(rows.map((r) => r.key)).toEqual([
      `${CUST_A}|shopify`,
      `${CUST_B}|walmart`,
    ]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// composeTotals — schemaless summary written to recon_runs.totals_jsonb
// ──────────────────────────────────────────────────────────────────────

describe("composeTotals", () => {
  it("aggregates rows_compared, variances_found, abs totals", () => {
    const varianceRows = [
      { source_tag: "shopify", tangerine_amount_cents: 1000n, xoro_amount_cents: 950n,  variance_amount_cents: 50n,  status: "within" },
      { source_tag: "shopify", tangerine_amount_cents: 2000n, xoro_amount_cents: 1000n, variance_amount_cents: 1000n, status: "over" },
      { source_tag: "walmart", tangerine_amount_cents: 500n,  xoro_amount_cents: 1500n, variance_amount_cents: -1000n, status: "over" },
    ];
    const t = composeTotals({
      varianceRows,
      perRowThresholdCents: 100n,
      perDomainThresholdCents: 10_000n,
    });
    expect(t.rows_compared).toBe(3);
    expect(t.variances_found).toBe(2);
    expect(t.total_abs_variance_cents).toBe("2000");
    expect(t.total_tangerine_cents).toBe("3500");
    expect(t.total_xoro_cents).toBe("3450");
    expect(t.domain_threshold_crossed).toBe(false);
  });
  it("flips domain_threshold_crossed when total abs > ceiling", () => {
    const varianceRows = [
      { source_tag: "shopify", tangerine_amount_cents: 50_000n, xoro_amount_cents: 0n, variance_amount_cents: 50_000n, status: "over" },
    ];
    const t = composeTotals({
      varianceRows,
      perRowThresholdCents: 100n,
      perDomainThresholdCents: 10_000n,
    });
    expect(t.domain_threshold_crossed).toBe(true);
    expect(t.total_abs_variance_cents).toBe("50000");
  });
  it("per_source_tag aggregates separately for D7 dashboards", () => {
    const varianceRows = [
      { source_tag: "shopify", tangerine_amount_cents: 1000n, xoro_amount_cents: 0n, variance_amount_cents: 1000n, status: "over" },
      { source_tag: "walmart", tangerine_amount_cents: 0n,    xoro_amount_cents: 500n, variance_amount_cents: -500n, status: "over" },
      { source_tag: "shopify", tangerine_amount_cents: 200n,  xoro_amount_cents: 250n, variance_amount_cents: -50n,  status: "within" },
    ];
    const t = composeTotals({
      varianceRows,
      perRowThresholdCents: 100n,
      perDomainThresholdCents: 10_000n,
    });
    expect(t.per_source_tag.shopify.rows_compared).toBe(2);
    expect(t.per_source_tag.shopify.variances_found).toBe(1);
    expect(t.per_source_tag.shopify.total_abs_variance_cents).toBe("1000");
    expect(t.per_source_tag.walmart.rows_compared).toBe(1);
    expect(t.per_source_tag.walmart.variances_found).toBe(1);
    expect(t.per_source_tag.walmart.total_abs_variance_cents).toBe("500");
  });
  it("empty list → all zeros, clean status downstream", () => {
    const t = composeTotals({
      varianceRows: [],
      perRowThresholdCents: 100n,
      perDomainThresholdCents: 10_000n,
    });
    expect(t.rows_compared).toBe(0);
    expect(t.variances_found).toBe(0);
    expect(t.total_abs_variance_cents).toBe("0");
    expect(t.domain_threshold_crossed).toBe(false);
  });
});

describe("decideRunStatus", () => {
  it("'clean' when no variances", () => {
    expect(decideRunStatus({ variances_found: 0 })).toBe("clean");
    expect(decideRunStatus({})).toBe("clean");
    expect(decideRunStatus(null)).toBe("clean");
  });
  it("'variance' when any over-threshold row exists", () => {
    expect(decideRunStatus({ variances_found: 1 })).toBe("variance");
    expect(decideRunStatus({ variances_found: 99 })).toBe("variance");
  });
});

// ──────────────────────────────────────────────────────────────────────
// runArReconciliation — input validation
// ──────────────────────────────────────────────────────────────────────

describe("runArReconciliation — input validation", () => {
  const baseGood = {
    entity_id: ENTITY,
    period_start: "2026-05-01",
    period_end: "2026-05-31",
    now: NOW,
  };

  it("rejects missing admin", async () => {
    const out = await runArReconciliation({ ...baseGood, admin: null });
    expect(out.ok).toBe(false);
    expect(out.errors[0].kind).toBe("bad_admin");
  });
  it("rejects bad entity_id", async () => {
    const out = await runArReconciliation({ ...baseGood, admin: makeMockSupabase(), entity_id: "not-a-uuid" });
    expect(out.errors[0].kind).toBe("bad_entity");
  });
  it("rejects bad period_start", async () => {
    const out = await runArReconciliation({ ...baseGood, admin: makeMockSupabase(), period_start: "2026-5-1" });
    expect(out.errors[0].kind).toBe("bad_period_start");
  });
  it("rejects bad period_end", async () => {
    const out = await runArReconciliation({ ...baseGood, admin: makeMockSupabase(), period_end: "not-a-date" });
    expect(out.errors[0].kind).toBe("bad_period_end");
  });
  it("rejects inverted period", async () => {
    const out = await runArReconciliation({
      ...baseGood,
      admin: makeMockSupabase(),
      period_start: "2026-05-31",
      period_end: "2026-05-01",
    });
    expect(out.errors[0].kind).toBe("bad_period_order");
  });
  it("rejects bad cadence", async () => {
    const out = await runArReconciliation({ ...baseGood, admin: makeMockSupabase(), cadence: "hourly" });
    expect(out.errors[0].kind).toBe("bad_cadence");
  });
  it("rejects bad replay_of_id", async () => {
    const out = await runArReconciliation({ ...baseGood, admin: makeMockSupabase(), replay_of_id: "abc" });
    expect(out.errors[0].kind).toBe("bad_replay_of_id");
  });
});

// ──────────────────────────────────────────────────────────────────────
// runArReconciliation — happy paths
// ──────────────────────────────────────────────────────────────────────

describe("runArReconciliation — happy paths", () => {
  it("empty period → clean run, recon_runs inserted + finalized", async () => {
    const admin = makeMockSupabase({});
    const out = await runArReconciliation({
      admin,
      entity_id: ENTITY,
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      now: NOW,
    });
    expect(out.ok).toBe(true);
    expect(out.recon_run_id).toBe(RUN_ID);
    expect(out.status).toBe("clean");
    expect(out.summary.rows_compared).toBe(0);
    // recon_runs INSERT happened with status='running'
    expect(admin.state.runInserts[0].row.status).toBe("running");
    expect(admin.state.runInserts[0].row.domain).toBe("ar");
    // finalize UPDATE with clean status
    expect(admin.state.runUpdates[0].patch.status).toBe("clean");
    expect(admin.state.runUpdates[0].patch.completed_at).toBe(NOW);
  });

  it("matched groups within threshold → clean", async () => {
    const tanRows = [
      tanInv({ customer_id: CUST_A, source: "shopify", total_amount_cents: 10_000, invoice_number: "SHOP-1" }),
    ];
    const xoroRows = [
      xoroInv({ customer_id: LEGACY_A, invoice_number: "SHOP-1", net_amount: 100 }),
    ];
    const admin = makeMockSupabase({
      tanRows,
      xoroRows,
      customerMasterRows: [{ id: LEGACY_A, customer_code: "CA" }],
      customersRows: [{ id: CUST_A, code: "CA" }],
    });
    const out = await runArReconciliation({
      admin,
      entity_id: ENTITY,
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      now: NOW,
    });
    expect(out.ok).toBe(true);
    expect(out.status).toBe("clean");
    expect(out.summary.rows_compared).toBe(1);
    expect(out.summary.variances_found).toBe(0);
  });

  it("variance above per-row threshold → 'variance' status + inserted variance row", async () => {
    const tanRows = [
      tanInv({ customer_id: CUST_A, source: "shopify", total_amount_cents: 10_000, invoice_number: "SHOP-1" }),
    ];
    const xoroRows = [
      xoroInv({ customer_id: LEGACY_A, invoice_number: "SHOP-1", net_amount: 95 }), // $5 short
    ];
    const admin = makeMockSupabase({
      tanRows,
      xoroRows,
      customerMasterRows: [{ id: LEGACY_A, customer_code: "CA" }],
      customersRows: [{ id: CUST_A, code: "CA" }],
    });
    const out = await runArReconciliation({
      admin,
      entity_id: ENTITY,
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      now: NOW,
    });
    expect(out.ok).toBe(true);
    expect(out.status).toBe("variance");
    expect(out.summary.variances_found).toBe(1);
    expect(out.summary.total_abs_variance_cents).toBe("500");
    expect(admin.state.varianceInserts).toHaveLength(1);
    expect(admin.state.varianceInserts[0].rows[0].status).toBe("over");
    expect(admin.state.varianceInserts[0].rows[0].source_tag).toBe("shopify");
  });

  it("variance above domain ceiling sets domain_threshold_crossed", async () => {
    const tanRows = [
      tanInv({ customer_id: CUST_A, source: "shopify", total_amount_cents: 1_000_000, invoice_number: "SHOP-1" }),
    ];
    const xoroRows = []; // entire Tangerine amount is the variance
    const admin = makeMockSupabase({ tanRows, xoroRows });
    const out = await runArReconciliation({
      admin,
      entity_id: ENTITY,
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      now: NOW,
    });
    expect(out.status).toBe("variance");
    expect(out.summary.domain_threshold_crossed).toBe(true);
  });

  it("D7 — shopify and walmart variances surface as SEPARATE rows", async () => {
    const tanRows = [
      tanInv({ customer_id: CUST_A, source: "shopify", total_amount_cents: 10_000, invoice_number: "SHOP-1" }),
      tanInv({ customer_id: CUST_A, source: "walmart", total_amount_cents: 5_000,  invoice_number: "WMT-1" }),
    ];
    const xoroRows = [
      xoroInv({ customer_id: LEGACY_A, invoice_number: "SHOP-1", net_amount: 100 }),
      xoroInv({ customer_id: LEGACY_A, invoice_number: "WMT-1",  net_amount: 25 }), // $25 short
    ];
    const admin = makeMockSupabase({
      tanRows,
      xoroRows,
      customerMasterRows: [{ id: LEGACY_A, customer_code: "CA" }],
      customersRows: [{ id: CUST_A, code: "CA" }],
    });
    const out = await runArReconciliation({
      admin,
      entity_id: ENTITY,
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      now: NOW,
    });
    expect(out.summary.per_source_tag.shopify.variances_found).toBe(0);
    expect(out.summary.per_source_tag.walmart.variances_found).toBe(1);
    expect(out.summary.per_source_tag.walmart.total_abs_variance_cents).toBe("2500");
  });

  it("idempotent invocation — second run produces a fresh recon_runs row (append-only)", async () => {
    const admin = makeMockSupabase({});
    const out1 = await runArReconciliation({
      admin,
      entity_id: ENTITY,
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      now: NOW,
    });
    const out2 = await runArReconciliation({
      admin,
      entity_id: ENTITY,
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      now: NOW,
    });
    expect(out1.ok).toBe(true);
    expect(out2.ok).toBe(true);
    expect(admin.state.runInserts).toHaveLength(2);
  });

  it("replay run records replay_of_id on the new recon_runs row (D11)", async () => {
    const admin = makeMockSupabase({});
    const out = await runArReconciliation({
      admin,
      entity_id: ENTITY,
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      cadence: "replay",
      replay_of_id: REPLAY_OF,
      now: NOW,
    });
    expect(out.ok).toBe(true);
    expect(admin.state.runInserts[0].row.replay_of_id).toBe(REPLAY_OF);
    expect(admin.state.runInserts[0].row.cadence).toBe("replay");
  });

  it("threshold overrides are honored (looser per-row threshold absorbs a variance)", async () => {
    const tanRows = [
      tanInv({ customer_id: CUST_A, source: "shopify", total_amount_cents: 10_000, invoice_number: "SHOP-1" }),
    ];
    const xoroRows = [
      xoroInv({ customer_id: LEGACY_A, invoice_number: "SHOP-1", net_amount: 95 }), // $5 variance
    ];
    const admin = makeMockSupabase({
      tanRows,
      xoroRows,
      customerMasterRows: [{ id: LEGACY_A, customer_code: "CA" }],
      customersRows: [{ id: CUST_A, code: "CA" }],
    });
    const out = await runArReconciliation({
      admin,
      entity_id: ENTITY,
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      now: NOW,
      per_row_threshold_cents: 10_000n, // $100/row — absorbs the $5 variance
    });
    expect(out.status).toBe("clean");
  });
});

// ──────────────────────────────────────────────────────────────────────
// runArReconciliation — error paths
// ──────────────────────────────────────────────────────────────────────

describe("runArReconciliation — error paths", () => {
  it("recon_runs INSERT error → error result without engine work", async () => {
    const admin = makeMockSupabase({ runInsertError: { message: "RLS denied" } });
    const out = await runArReconciliation({
      admin,
      entity_id: ENTITY,
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      now: NOW,
    });
    expect(out.ok).toBe(false);
    expect(out.errors[0].kind).toBe("recon_run_insert_failed");
    expect(admin.state.varianceInserts).toHaveLength(0);
  });

  it("Tangerine read error → status=error + run finalized", async () => {
    const admin = makeMockSupabase({ tanReadError: { message: "boom" } });
    const out = await runArReconciliation({
      admin,
      entity_id: ENTITY,
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      now: NOW,
    });
    expect(out.ok).toBe(false);
    expect(out.status).toBe("error");
    expect(out.errors[0].kind).toBe("tangerine_read_failed");
    expect(admin.state.runUpdates[0].patch.status).toBe("error");
  });

  it("Xoro read error → status=error", async () => {
    const admin = makeMockSupabase({ xoroReadError: { message: "fetch died" } });
    const out = await runArReconciliation({
      admin,
      entity_id: ENTITY,
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      now: NOW,
    });
    expect(out.ok).toBe(false);
    expect(out.errors[0].kind).toBe("xoro_read_failed");
  });

  it("customer lookup error is non-fatal, captured in totals.errors", async () => {
    const tanRows = [];
    const xoroRows = [
      xoroInv({ customer_id: LEGACY_A, invoice_number: "SHOP-1", net_amount: 100 }),
    ];
    const admin = makeMockSupabase({
      tanRows,
      xoroRows,
      customerMasterError: { message: "lookup timeout" },
    });
    const out = await runArReconciliation({
      admin,
      entity_id: ENTITY,
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      now: NOW,
    });
    // Non-fatal: run continues. Unresolved id falls through as empty
    // customer slot in the variance row.
    expect(out.ok).toBe(true);
    expect(out.errors.some((e) => e.kind === "customer_lookup_partial_failure")).toBe(true);
  });

  it("recon_variances INSERT error → run finalized as error", async () => {
    const tanRows = [
      tanInv({ customer_id: CUST_A, source: "shopify", total_amount_cents: 10_000, invoice_number: "SHOP-1" }),
    ];
    const admin = makeMockSupabase({
      tanRows,
      variancesInsertError: { message: "constraint violation" },
    });
    const out = await runArReconciliation({
      admin,
      entity_id: ENTITY,
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      now: NOW,
    });
    expect(out.ok).toBe(false);
    expect(out.errors[0].kind).toBe("variances_insert_failed");
    expect(admin.state.runUpdates[0].patch.status).toBe("error");
  });

  it("finalize error → status=error returned", async () => {
    const admin = makeMockSupabase({ runFinalizeError: { message: "no row" } });
    const out = await runArReconciliation({
      admin,
      entity_id: ENTITY,
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      now: NOW,
    });
    expect(out.ok).toBe(false);
    expect(out.errors.some((e) => e.kind === "recon_run_finalize_failed")).toBe(true);
  });

  it("unexpected throw inside the engine is captured into errors[]", async () => {
    // Construct a supabase that THROWS on the third .from() call.
    let n = 0;
    const baseAdmin = makeMockSupabase({});
    const wrappedAdmin = {
      state: baseAdmin.state,
      from(table) {
        n += 1;
        if (n === 3) throw new Error("kaboom");
        return baseAdmin.from(table);
      },
    };
    const out = await runArReconciliation({
      admin: wrappedAdmin,
      entity_id: ENTITY,
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      now: NOW,
    });
    expect(out.ok).toBe(false);
    expect(out.errors.some((e) => e.kind === "engine_threw")).toBe(true);
  });
});
