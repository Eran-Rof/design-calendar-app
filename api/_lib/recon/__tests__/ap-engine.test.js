// Tests for the Tangerine P9-2 AP reconciliation engine.
//
// Architecture: docs/tangerine/P9-parallel-run-architecture.md §3.2 + §4.1.
// Schema:       supabase/migrations/20260629800000_p9_chunk1_recon_schema.sql
//
// All tests run against an in-memory supabase double — no live DB.

import { describe, it, expect } from "vitest";
import {
  runApReconciliation,
  dollarsToCents,
  normalizePoRef,
  buildGroupKey,
  validateArgs,
  bucketByGroup,
  matchGroups,
  applyThresholds,
  __test_only__,
} from "../ap-engine.js";

const ENTITY = "11111111-1111-1111-1111-111111111111";
const PERIOD_START = "2026-05-01";
const PERIOD_END = "2026-05-31";

// ──────────────────────────────────────────────────────────────────────────
// In-memory supabase double
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build a supabase admin double parameterized by:
 *   tangerineInvoices  rows in `invoices` (Tangerine side; any source)
 *                      Rows must include {entity_id, gl_status, posting_date,
 *                                          vendor_id, invoice_number, total_amount_cents, source}
 *   reconRunsInsertError  optional string → injected on recon_runs.insert
 *   reconVariancesInsertError  optional string → injected on recon_variances.insert
 *   reconRunsUpdateError  optional string → injected on recon_runs.update
 *   invoicesReadError  optional string → injected on the invoices SELECT
 *   reconRunId  uuid the recon_runs INSERT returns (defaults to a stable value)
 */
function makeSupabase({
  tangerineInvoices = [],
  reconRunsInsertError = null,
  reconVariancesInsertError = null,
  reconRunsUpdateError = null,
  invoicesReadError = null,
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
      if (table === "recon_runs") return makeReconRunsBuilder(captured, reconRunsInsertError, reconRunsUpdateError, reconRunId);
      if (table === "recon_variances") return makeReconVariancesBuilder(captured, reconVariancesInsertError);
      if (table === "invoices") return makeInvoicesBuilder(tangerineInvoices, invoicesReadError);
      throw new Error(`unexpected table ${table}`);
    },
  };
  return sb;
}

function makeReconRunsBuilder(captured, insertError, updateError, fakeId) {
  let pendingInsert = null;
  let updatePayload = null;
  let idFilter = null;
  const builder = {
    insert(payload) {
      pendingInsert = payload;
      return {
        select() { return this; },
        single() {
          if (insertError) return Promise.resolve({ data: null, error: { message: insertError } });
          captured.runsInserts.push(payload);
          return Promise.resolve({ data: { id: fakeId }, error: null });
        },
      };
    },
    update(payload) {
      updatePayload = payload;
      return {
        eq(col, val) {
          if (col === "id") idFilter = val;
          return this;
        },
        then(resolve) {
          if (updateError) return resolve({ data: null, error: { message: updateError } });
          captured.runsUpdates.push({ id: idFilter, payload: updatePayload });
          return resolve({ data: null, error: null });
        },
      };
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

function makeInvoicesBuilder(rows, readError) {
  const filters = { entity_id: null, gl_status: null, source: null, gte_posting_date: null, lte_posting_date: null };
  const builder = {
    select() { return builder; },
    eq(col, val) { filters[col] = val; return builder; },
    gte(col, val) { if (col === "posting_date") filters.gte_posting_date = val; return builder; },
    lte(col, val) { if (col === "posting_date") filters.lte_posting_date = val; return builder; },
    then(resolve) {
      if (readError) return resolve({ data: null, error: { message: readError } });
      let out = rows;
      if (filters.entity_id != null) out = out.filter((r) => r.entity_id === filters.entity_id);
      if (filters.gl_status != null) out = out.filter((r) => r.gl_status === filters.gl_status);
      if (filters.source != null) out = out.filter((r) => r.source === filters.source);
      if (filters.gte_posting_date != null) out = out.filter((r) => r.posting_date >= filters.gte_posting_date);
      if (filters.lte_posting_date != null) out = out.filter((r) => r.posting_date <= filters.lte_posting_date);
      return resolve({ data: out, error: null });
    },
  };
  return builder;
}

// Helpers to build fixtures.
function inv({ id, vendor_id, invoice_number, total_amount_cents, source = "manual", posting_date = "2026-05-15", entity_id = ENTITY, gl_status = "posted" }) {
  return { id, vendor_id, invoice_number, total: total_amount_cents / 100, total_amount_cents, source, posting_date, entity_id, gl_status };
}

// ──────────────────────────────────────────────────────────────────────────
// Pure helper tests
// ──────────────────────────────────────────────────────────────────────────

describe("dollarsToCents", () => {
  it("converts a number to cents", () => {
    expect(dollarsToCents(12.34)).toBe(1234);
  });
  it("handles string with $ sign", () => {
    expect(dollarsToCents("$100.00")).toBe(10000);
  });
  it("handles thousands separator", () => {
    expect(dollarsToCents("$1,234.56")).toBe(123456);
  });
  it("returns 0 for null/undefined", () => {
    expect(dollarsToCents(null)).toBe(0);
    expect(dollarsToCents(undefined)).toBe(0);
  });
  it("returns 0 for empty string", () => {
    expect(dollarsToCents("")).toBe(0);
  });
  it("returns 0 for garbage strings", () => {
    expect(dollarsToCents("not money")).toBe(0);
  });
  it("returns 0 for NaN/Infinity", () => {
    expect(dollarsToCents(NaN)).toBe(0);
    expect(dollarsToCents(Infinity)).toBe(0);
  });
  it("rounds to nearest cent", () => {
    // We round, not truncate. Below-half rounds down, above-half rounds up.
    expect(dollarsToCents(1.006)).toBe(101);
    expect(dollarsToCents(1.004)).toBe(100);
  });
  it("handles negative amounts", () => {
    expect(dollarsToCents(-50)).toBe(-5000);
  });
});

describe("normalizePoRef", () => {
  it("uppercases + trims", () => {
    expect(normalizePoRef("  po-1234  ")).toBe("PO-1234");
  });
  it("strips XORO- prefix", () => {
    expect(normalizePoRef("XORO-PO-99")).toBe("PO-99");
  });
  it("preserves non-XORO prefix", () => {
    expect(normalizePoRef("VENDOR-INV-7")).toBe("VENDOR-INV-7");
  });
  it("handles null/undefined", () => {
    expect(normalizePoRef(null)).toBe("");
    expect(normalizePoRef(undefined)).toBe("");
  });
});

describe("buildGroupKey", () => {
  it("composes vendor + source + po", () => {
    expect(buildGroupKey("v1", "shopify", "PO-1")).toBe("v1::shopify::PO-1");
  });
  it("maps null source_tag to manual_or_legacy", () => {
    expect(buildGroupKey("v1", null, "PO-1")).toBe("v1::manual_or_legacy::PO-1");
  });
  it("strips XORO- in po segment", () => {
    expect(buildGroupKey("v1", "xoro_mirror", "XORO-PO-1")).toBe("v1::xoro_mirror::PO-1");
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
// bucketByGroup
// ──────────────────────────────────────────────────────────────────────────

describe("bucketByGroup", () => {
  it("groups rows by (vendor, source, po)", () => {
    const rows = [
      { vendor_id: "v1", source: "manual", invoice_number: "PO-1", total_amount_cents: 1000, total: 10 },
      { vendor_id: "v1", source: "manual", invoice_number: "PO-1", total_amount_cents: 500, total: 5 },
      { vendor_id: "v1", source: "manual", invoice_number: "PO-2", total_amount_cents: 200, total: 2 },
    ];
    const m = bucketByGroup(rows);
    expect(m.size).toBe(2);
    expect(m.get("v1::manual::PO-1").amount_cents).toBe(1500);
    expect(m.get("v1::manual::PO-2").amount_cents).toBe(200);
  });
  it("uses total*100 fallback when total_amount_cents missing", () => {
    const rows = [
      { vendor_id: "v1", source: "manual", invoice_number: "PO-1", total: 12.34 },
    ];
    const m = bucketByGroup(rows);
    expect([...m.values()][0].amount_cents).toBe(1234);
  });
  it("captures per-row source_tag", () => {
    const rows = [
      { vendor_id: "v1", source: "shopify", invoice_number: "PO-1", total_amount_cents: 100 },
    ];
    const b = [...bucketByGroup(rows).values()][0];
    expect(b.source_tag).toBe("shopify");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// matchGroups
// ──────────────────────────────────────────────────────────────────────────

describe("matchGroups", () => {
  it("emits zero variance when sides match", () => {
    const tang = bucketByGroup([
      { vendor_id: "v1", source: "manual", invoice_number: "PO-1", total_amount_cents: 1000 },
    ]);
    const xoro = bucketByGroup([
      { vendor_id: "v1", source: "xoro_mirror", invoice_number: "PO-1", total_amount_cents: 1000 },
    ]);
    const v = matchGroups(tang, xoro);
    expect(v).toHaveLength(1);
    expect(v[0].variance_amount_cents).toBe(0);
  });
  it("emits positive variance when Tangerine > Xoro", () => {
    const tang = bucketByGroup([
      { vendor_id: "v1", source: "manual", invoice_number: "PO-1", total_amount_cents: 1200 },
    ]);
    const xoro = bucketByGroup([
      { vendor_id: "v1", source: "xoro_mirror", invoice_number: "PO-1", total_amount_cents: 1000 },
    ]);
    const v = matchGroups(tang, xoro);
    expect(v[0].variance_amount_cents).toBe(200);
  });
  it("emits negative variance when Tangerine < Xoro", () => {
    const tang = bucketByGroup([
      { vendor_id: "v1", source: "manual", invoice_number: "PO-1", total_amount_cents: 900 },
    ]);
    const xoro = bucketByGroup([
      { vendor_id: "v1", source: "xoro_mirror", invoice_number: "PO-1", total_amount_cents: 1000 },
    ]);
    const v = matchGroups(tang, xoro);
    expect(v[0].variance_amount_cents).toBe(-100);
  });
  it("emits Tangerine-only row when Xoro is missing", () => {
    const tang = bucketByGroup([
      { vendor_id: "v1", source: "manual", invoice_number: "PO-1", total_amount_cents: 1000 },
    ]);
    const xoro = bucketByGroup([]);
    const v = matchGroups(tang, xoro);
    expect(v).toHaveLength(1);
    expect(v[0].variance_amount_cents).toBe(1000);
    expect(v[0].xoro_amount_cents).toBe(0);
  });
  it("emits Xoro-only row when Tangerine is missing", () => {
    const tang = bucketByGroup([]);
    const xoro = bucketByGroup([
      { vendor_id: "v1", source: "xoro_mirror", invoice_number: "PO-9", total_amount_cents: 800 },
    ]);
    const v = matchGroups(tang, xoro);
    expect(v).toHaveLength(1);
    expect(v[0].variance_amount_cents).toBe(-800);
    expect(v[0].tangerine_amount_cents).toBe(0);
    expect(v[0].source_tag).toBe("xoro_mirror");
  });
  it("collapses (vendor, po) across different source tags on Tangerine side", () => {
    // Two Tangerine rows for same PO under different sources should sum
    // and compare as one PO bucket vs Xoro.
    const tang = bucketByGroup([
      { vendor_id: "v1", source: "shopify",  invoice_number: "PO-1", total_amount_cents: 300 },
      { vendor_id: "v1", source: "manual",   invoice_number: "PO-1", total_amount_cents: 200 },
    ]);
    const xoro = bucketByGroup([
      { vendor_id: "v1", source: "xoro_mirror", invoice_number: "PO-1", total_amount_cents: 500 },
    ]);
    const v = matchGroups(tang, xoro);
    expect(v).toHaveLength(1);
    expect(v[0].variance_amount_cents).toBe(0);
  });
  it("prefers non-xoro_mirror source_tag for display", () => {
    const tang = bucketByGroup([
      { vendor_id: "v1", source: "fba", invoice_number: "PO-1", total_amount_cents: 100 },
    ]);
    const xoro = bucketByGroup([]);
    const v = matchGroups(tang, xoro);
    expect(v[0].source_tag).toBe("fba");
  });
  it("treats different vendors as separate rows", () => {
    const tang = bucketByGroup([
      { vendor_id: "v1", source: "manual", invoice_number: "PO-1", total_amount_cents: 100 },
      { vendor_id: "v2", source: "manual", invoice_number: "PO-1", total_amount_cents: 100 },
    ]);
    const xoro = bucketByGroup([]);
    const v = matchGroups(tang, xoro);
    expect(v).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// applyThresholds
// ──────────────────────────────────────────────────────────────────────────

describe("applyThresholds", () => {
  it("classifies sub-$1 variance as 'within'", () => {
    const r = applyThresholds([
      { variance_amount_cents: 50, vendor_id: "v1", po_reference: "PO-1", source_tag: "manual", tangerine_amount_cents: 50, xoro_amount_cents: 0 },
    ]);
    expect(r.variances_with_status[0].status).toBe("within");
    expect(r.summary.variances_found).toBe(0);
    expect(r.summary.run_status).toBe("clean");
  });
  it("classifies $1 variance as 'over' (>= threshold)", () => {
    const r = applyThresholds([
      { variance_amount_cents: 100, vendor_id: "v1", po_reference: "PO-1", source_tag: "manual", tangerine_amount_cents: 100, xoro_amount_cents: 0 },
    ]);
    expect(r.variances_with_status[0].status).toBe("over");
    expect(r.summary.variances_found).toBe(1);
  });
  it("uses absolute value for threshold comparison (negative variance)", () => {
    const r = applyThresholds([
      { variance_amount_cents: -150, vendor_id: "v1", po_reference: "PO-1", source_tag: "manual", tangerine_amount_cents: 0, xoro_amount_cents: 150 },
    ]);
    expect(r.variances_with_status[0].status).toBe("over");
  });
  it("marks run 'clean' when total |over-variances| <= $100", () => {
    const r = applyThresholds([
      { variance_amount_cents: 500, vendor_id: "v1", po_reference: "P1", source_tag: "manual", tangerine_amount_cents: 500, xoro_amount_cents: 0 },
      { variance_amount_cents: 500, vendor_id: "v2", po_reference: "P2", source_tag: "manual", tangerine_amount_cents: 500, xoro_amount_cents: 0 },
    ]);
    // 500 + 500 = 1000 cents = $10 — under $100 domain threshold
    expect(r.summary.run_status).toBe("clean");
  });
  it("marks run 'variance' when total |over-variances| > $100", () => {
    const r = applyThresholds([
      { variance_amount_cents: 6000, vendor_id: "v1", po_reference: "P1", source_tag: "manual", tangerine_amount_cents: 6000, xoro_amount_cents: 0 },
      { variance_amount_cents: 5000, vendor_id: "v2", po_reference: "P2", source_tag: "manual", tangerine_amount_cents: 5000, xoro_amount_cents: 0 },
    ]);
    // 6000 + 5000 = 11000 cents = $110
    expect(r.summary.run_status).toBe("variance");
    expect(r.summary.variances_found).toBe(2);
    expect(r.summary.total_variance_cents).toBe(11000);
  });
  it("does not count within-threshold rows toward domain total", () => {
    const r = applyThresholds([
      { variance_amount_cents: 50, vendor_id: "v1", po_reference: "P1", source_tag: "manual", tangerine_amount_cents: 50, xoro_amount_cents: 0 },
      { variance_amount_cents: 99, vendor_id: "v2", po_reference: "P2", source_tag: "manual", tangerine_amount_cents: 99, xoro_amount_cents: 0 },
    ]);
    expect(r.summary.total_variance_cents).toBe(0);
    expect(r.summary.run_status).toBe("clean");
  });
  it("exposes per-row + per-domain threshold values in summary", () => {
    const r = applyThresholds([]);
    expect(r.summary.per_row_threshold_cents).toBe(100);
    expect(r.summary.per_domain_threshold_cents).toBe(10000);
  });
  it("rows_compared reflects total input rows (including within)", () => {
    const r = applyThresholds([
      { variance_amount_cents: 50, vendor_id: "v1", po_reference: "P1", source_tag: "manual", tangerine_amount_cents: 50, xoro_amount_cents: 0 },
      { variance_amount_cents: 200, vendor_id: "v2", po_reference: "P2", source_tag: "manual", tangerine_amount_cents: 200, xoro_amount_cents: 0 },
    ]);
    expect(r.summary.rows_compared).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// runApReconciliation — end-to-end
// ──────────────────────────────────────────────────────────────────────────

describe("runApReconciliation", () => {
  it("returns 'clean' on empty period (no invoices either side)", async () => {
    const admin = makeSupabase({ tangerineInvoices: [] });
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("clean");
    expect(r.rows_compared).toBe(0);
    expect(r.variances_found).toBe(0);
    expect(r.total_variance_cents).toBe(0);
    expect(r.errors).toEqual([]);
    expect(admin.captured.runsInserts).toHaveLength(1);
    expect(admin.captured.runsInserts[0].domain).toBe("ap");
    expect(admin.captured.runsInserts[0].status).toBe("running");
    expect(admin.captured.runsUpdates).toHaveLength(1);
    expect(admin.captured.runsUpdates[0].payload.status).toBe("clean");
    expect(admin.captured.variancesInserts).toHaveLength(0);
  });

  it("returns 'clean' when matched sides agree exactly", async () => {
    const admin = makeSupabase({
      tangerineInvoices: [
        inv({ id: "t1", vendor_id: "v1", invoice_number: "PO-1", total_amount_cents: 1000, source: "manual" }),
        inv({ id: "x1", vendor_id: "v1", invoice_number: "XORO-PO-1", total_amount_cents: 1000, source: "xoro_mirror" }),
      ],
    });
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("clean");
    expect(r.variances_found).toBe(0);
    expect(admin.captured.variancesInserts).toHaveLength(0);
  });

  it("emits one variance row when Tangerine over-states by $5", async () => {
    const admin = makeSupabase({
      tangerineInvoices: [
        inv({ id: "t1", vendor_id: "v1", invoice_number: "PO-1", total_amount_cents: 1500, source: "manual" }),
        inv({ id: "x1", vendor_id: "v1", invoice_number: "XORO-PO-1", total_amount_cents: 1000, source: "xoro_mirror" }),
      ],
    });
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    // $5 > $1/row but $5 < $100/domain → run 'clean', row 'over'
    expect(r.status).toBe("clean");
    expect(r.variances_found).toBe(1);
    expect(r.total_variance_cents).toBe(500);
    expect(admin.captured.variancesInserts).toHaveLength(1);
    const vRow = admin.captured.variancesInserts[0][0];
    expect(vRow.source_table).toBe("invoices");
    expect(vRow.variance_amount_cents).toBe(500);
    expect(vRow.status).toBe("over");
    expect(vRow.source_tag).toBe("manual");
  });

  it("marks run 'variance' when domain total exceeds $100", async () => {
    const admin = makeSupabase({
      tangerineInvoices: [
        inv({ id: "t1", vendor_id: "v1", invoice_number: "PO-1", total_amount_cents: 7000, source: "manual" }),
        inv({ id: "x1", vendor_id: "v1", invoice_number: "XORO-PO-1", total_amount_cents: 0, source: "xoro_mirror" }),
        inv({ id: "t2", vendor_id: "v2", invoice_number: "PO-2", total_amount_cents: 5000, source: "manual" }),
        inv({ id: "x2", vendor_id: "v2", invoice_number: "XORO-PO-2", total_amount_cents: 0, source: "xoro_mirror" }),
      ],
    });
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("variance");
    expect(r.variances_found).toBe(2);
    expect(r.total_variance_cents).toBe(12000); // $120
  });

  it("respects per-row threshold ($0.99 variance = within, no variances_found bump)", async () => {
    const admin = makeSupabase({
      tangerineInvoices: [
        inv({ id: "t1", vendor_id: "v1", invoice_number: "PO-1", total_amount_cents: 99, source: "manual" }),
        inv({ id: "x1", vendor_id: "v1", invoice_number: "XORO-PO-1", total_amount_cents: 0, source: "xoro_mirror" }),
      ],
    });
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("clean");
    expect(r.variances_found).toBe(0);
    // Below-threshold row with non-zero variance is still persisted (so
    // the dashboard can render it as informational), but with status 'within'.
    expect(admin.captured.variancesInserts).toHaveLength(1);
    expect(admin.captured.variancesInserts[0][0].status).toBe("within");
  });

  it("emits Xoro-only row when Tangerine never posted the bill", async () => {
    const admin = makeSupabase({
      tangerineInvoices: [
        inv({ id: "x1", vendor_id: "v1", invoice_number: "XORO-PO-99", total_amount_cents: 5000, source: "xoro_mirror" }),
      ],
    });
    const r = await runApReconciliation({
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

  it("preserves source_tag from Tangerine side per (D7)", async () => {
    const admin = makeSupabase({
      tangerineInvoices: [
        inv({ id: "t1", vendor_id: "v1", invoice_number: "PO-1", total_amount_cents: 1500, source: "shopify" }),
        inv({ id: "x1", vendor_id: "v1", invoice_number: "XORO-PO-1", total_amount_cents: 1000, source: "xoro_mirror" }),
      ],
    });
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.variances_found).toBe(1);
    expect(admin.captured.variancesInserts[0][0].source_tag).toBe("shopify");
  });

  it("groups multiple channel rows separately when PO refs differ", async () => {
    const admin = makeSupabase({
      tangerineInvoices: [
        inv({ id: "t1", vendor_id: "v1", invoice_number: "PO-A", total_amount_cents: 2000, source: "fba" }),
        inv({ id: "t2", vendor_id: "v1", invoice_number: "PO-B", total_amount_cents: 3000, source: "walmart" }),
        inv({ id: "x1", vendor_id: "v1", invoice_number: "XORO-PO-A", total_amount_cents: 1500, source: "xoro_mirror" }),
        inv({ id: "x2", vendor_id: "v1", invoice_number: "XORO-PO-B", total_amount_cents: 3000, source: "xoro_mirror" }),
      ],
    });
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    // PO-A: $5 variance (over), PO-B: $0 (no variance row persisted)
    expect(r.variances_found).toBe(1);
    expect(admin.captured.variancesInserts[0]).toHaveLength(1);
    expect(admin.captured.variancesInserts[0][0].source_tag).toBe("fba");
  });

  it("filters out posting_date outside period bounds", async () => {
    const admin = makeSupabase({
      tangerineInvoices: [
        inv({ id: "out1", vendor_id: "v1", invoice_number: "PO-OLD", total_amount_cents: 9999, source: "manual", posting_date: "2026-04-15" }),
        inv({ id: "out2", vendor_id: "v1", invoice_number: "PO-NEW", total_amount_cents: 9999, source: "manual", posting_date: "2026-06-15" }),
        inv({ id: "in1",  vendor_id: "v1", invoice_number: "PO-IN",  total_amount_cents: 100, source: "manual", posting_date: "2026-05-15" }),
        inv({ id: "x_in", vendor_id: "v1", invoice_number: "XORO-PO-IN", total_amount_cents: 100, source: "xoro_mirror", posting_date: "2026-05-15" }),
      ],
    });
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("clean");
    expect(r.totals_jsonb.tangerine_rows_pulled).toBe(2); // PO-IN + XORO-PO-IN
  });

  it("filters out gl_status != 'posted'", async () => {
    const admin = makeSupabase({
      tangerineInvoices: [
        inv({ id: "draft", vendor_id: "v1", invoice_number: "PO-DRAFT", total_amount_cents: 5000, source: "manual", gl_status: "unposted" }),
        inv({ id: "void", vendor_id: "v1", invoice_number: "PO-VOID", total_amount_cents: 5000, source: "manual", gl_status: "void" }),
      ],
    });
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.totals_jsonb.tangerine_rows_pulled).toBe(0);
  });

  it("filters by entity_id", async () => {
    const admin = makeSupabase({
      tangerineInvoices: [
        inv({ id: "wrong-ent", vendor_id: "v1", invoice_number: "PO-1", total_amount_cents: 5000, source: "manual", entity_id: "other-ent" }),
      ],
    });
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.totals_jsonb.tangerine_rows_pulled).toBe(0);
  });

  it("supports cadence='manual'", async () => {
    const admin = makeSupabase({});
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END, cadence: "manual",
    });
    expect(r.status).toBe("clean");
    expect(admin.captured.runsInserts[0].cadence).toBe("manual");
  });

  it("supports cadence='replay' with replay_of_id (D11)", async () => {
    const admin = makeSupabase({});
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
      cadence: "replay", replay_of_id: "00000000-0000-0000-0000-000000000123",
    });
    expect(admin.captured.runsInserts[0].cadence).toBe("replay");
    expect(admin.captured.runsInserts[0].replay_of_id).toBe("00000000-0000-0000-0000-000000000123");
  });

  it("returns error+errors on bad args (rejects without DB insert)", async () => {
    const admin = makeSupabase({});
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: "bad", period_end: PERIOD_END,
    });
    expect(r.status).toBe("error");
    expect(r.errors[0].scope).toBe("args");
    expect(admin.captured.runsInserts).toHaveLength(0);
  });

  it("propagates recon_runs.insert error as status='error'", async () => {
    const admin = makeSupabase({ reconRunsInsertError: "db boom" });
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("error");
    expect(r.errors[0].scope).toBe("recon_runs_insert");
    expect(r.errors[0].reason).toMatch(/db boom/);
    expect(r.recon_run_id).toBeNull();
  });

  it("propagates invoices.read error and marks the run errored", async () => {
    const admin = makeSupabase({ invoicesReadError: "read boom" });
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("error");
    expect(r.recon_run_id).toBe("rrr-1");
    expect(r.errors.some((e) => e.scope === "tangerine_fetch")).toBe(true);
    // The errored run should also have an UPDATE marking it status='error'.
    const errorUpdate = admin.captured.runsUpdates.find((u) => u.payload.status === "error");
    expect(errorUpdate).toBeDefined();
  });

  it("propagates recon_variances.insert error and marks the run errored", async () => {
    const admin = makeSupabase({
      tangerineInvoices: [
        inv({ id: "t1", vendor_id: "v1", invoice_number: "PO-1", total_amount_cents: 5000, source: "manual" }),
      ],
      reconVariancesInsertError: "variance boom",
    });
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("error");
    expect(r.errors.some((e) => e.scope === "recon_variances_insert")).toBe(true);
  });

  it("captures recon_runs.update error without overwriting comparison results", async () => {
    const admin = makeSupabase({
      tangerineInvoices: [
        inv({ id: "t1", vendor_id: "v1", invoice_number: "PO-1", total_amount_cents: 5000, source: "manual" }),
      ],
      reconRunsUpdateError: "update boom",
    });
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    // Engine still returns the comparison result; the update error is in errors[].
    expect(r.errors.some((e) => e.scope === "recon_runs_update")).toBe(true);
    expect(r.variances_found).toBe(1);
  });

  it("writes totals_jsonb with the expected shape", async () => {
    const admin = makeSupabase({
      tangerineInvoices: [
        inv({ id: "t1", vendor_id: "v1", invoice_number: "PO-1", total_amount_cents: 5000, source: "manual" }),
      ],
    });
    await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    const finalUpdate = admin.captured.runsUpdates[admin.captured.runsUpdates.length - 1];
    expect(finalUpdate.payload.totals_jsonb).toMatchObject({
      rows_compared: expect.any(Number),
      variances_found: 1,
      total_variance_cents: 5000,
      per_row_threshold_cents: 100,
      per_domain_threshold_cents: 10000,
      tangerine_rows_pulled: expect.any(Number),
      xoro_rows_pulled: expect.any(Number),
    });
  });

  it("idempotency via replay_of_id: second run links to first via replay_of_id", async () => {
    // Run 1
    const admin1 = makeSupabase({
      tangerineInvoices: [
        inv({ id: "t1", vendor_id: "v1", invoice_number: "PO-1", total_amount_cents: 5000, source: "manual" }),
      ],
      reconRunId: "first-run-id",
    });
    const r1 = await runApReconciliation({
      admin: admin1, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END, cadence: "manual",
    });
    expect(r1.recon_run_id).toBe("first-run-id");

    // Run 2 — replay of run 1
    const admin2 = makeSupabase({
      tangerineInvoices: [
        inv({ id: "t1", vendor_id: "v1", invoice_number: "PO-1", total_amount_cents: 5000, source: "manual" }),
      ],
      reconRunId: "replay-run-id",
    });
    const r2 = await runApReconciliation({
      admin: admin2, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
      cadence: "replay", replay_of_id: r1.recon_run_id,
    });
    expect(r2.recon_run_id).toBe("replay-run-id");
    expect(admin2.captured.runsInserts[0].replay_of_id).toBe("first-run-id");
    // Both runs produce the same comparison result (idempotent).
    expect(r2.variances_found).toBe(r1.variances_found);
    expect(r2.total_variance_cents).toBe(r1.total_variance_cents);
  });

  it("multi-PO multi-vendor sums variances correctly", async () => {
    const admin = makeSupabase({
      tangerineInvoices: [
        // PO-1 / v1: $20 over
        inv({ id: "t1", vendor_id: "v1", invoice_number: "PO-1", total_amount_cents: 5000, source: "manual" }),
        inv({ id: "x1", vendor_id: "v1", invoice_number: "XORO-PO-1", total_amount_cents: 3000, source: "xoro_mirror" }),
        // PO-2 / v2: $30 under
        inv({ id: "t2", vendor_id: "v2", invoice_number: "PO-2", total_amount_cents: 7000, source: "manual" }),
        inv({ id: "x2", vendor_id: "v2", invoice_number: "XORO-PO-2", total_amount_cents: 10000, source: "xoro_mirror" }),
        // PO-3 / v3: clean
        inv({ id: "t3", vendor_id: "v3", invoice_number: "PO-3", total_amount_cents: 1000, source: "manual" }),
        inv({ id: "x3", vendor_id: "v3", invoice_number: "XORO-PO-3", total_amount_cents: 1000, source: "xoro_mirror" }),
      ],
    });
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    // 2 over-rows (each |variance|=2000 + 3000), total = 5000 cents = $50 → 'clean' (under $100 domain)
    expect(r.variances_found).toBe(2);
    expect(r.total_variance_cents).toBe(5000);
    expect(r.status).toBe("clean");
  });

  it("two-row variance over the domain threshold flips status to 'variance'", async () => {
    const admin = makeSupabase({
      tangerineInvoices: [
        inv({ id: "t1", vendor_id: "v1", invoice_number: "PO-1", total_amount_cents: 8000, source: "manual" }),
        inv({ id: "x1", vendor_id: "v1", invoice_number: "XORO-PO-1", total_amount_cents: 0, source: "xoro_mirror" }),
        inv({ id: "t2", vendor_id: "v2", invoice_number: "PO-2", total_amount_cents: 4000, source: "manual" }),
        inv({ id: "x2", vendor_id: "v2", invoice_number: "XORO-PO-2", total_amount_cents: 0, source: "xoro_mirror" }),
      ],
    });
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.total_variance_cents).toBe(12000); // $120
    expect(r.status).toBe("variance");
  });

  it("rows with zero variance are NOT persisted as variance rows", async () => {
    const admin = makeSupabase({
      tangerineInvoices: [
        inv({ id: "t1", vendor_id: "v1", invoice_number: "PO-1", total_amount_cents: 1000, source: "manual" }),
        inv({ id: "x1", vendor_id: "v1", invoice_number: "XORO-PO-1", total_amount_cents: 1000, source: "xoro_mirror" }),
      ],
    });
    await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(admin.captured.variancesInserts).toHaveLength(0);
  });

  it("AP_THRESHOLDS frozen + correct constants ($1/row, $100/domain)", () => {
    expect(__test_only__.AP_THRESHOLDS.per_row_cents).toBe(100);
    expect(__test_only__.AP_THRESHOLDS.per_domain_cents).toBe(10000);
    expect(Object.isFrozen(__test_only__.AP_THRESHOLDS)).toBe(true);
  });

  it("default cadence is 'weekly' when omitted", async () => {
    const admin = makeSupabase({});
    await runApReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(admin.captured.runsInserts[0].cadence).toBe("weekly");
  });

  it("single-day period (period_start == period_end) is accepted", async () => {
    const admin = makeSupabase({
      tangerineInvoices: [
        inv({ id: "t1", vendor_id: "v1", invoice_number: "PO-1", total_amount_cents: 100, source: "manual", posting_date: "2026-05-15" }),
      ],
    });
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-15", period_end: "2026-05-15",
    });
    expect(r.status).toBe("clean");
    expect(r.totals_jsonb.tangerine_rows_pulled).toBe(1);
  });

  it("reverses period (period_end < period_start) rejected as args error", async () => {
    const admin = makeSupabase({});
    const r = await runApReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-31", period_end: "2026-05-01",
    });
    expect(r.status).toBe("error");
    expect(admin.captured.runsInserts).toHaveLength(0);
  });
});
