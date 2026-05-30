// Tangerine P9-8 — preflight unresolved-recon augmentation tests.
//
// Covers the JS-side extension to the P5-7 close pre-flight:
//   - countUnresolvedReconVariances (recon_runs read + (domain, period)
//     dedupe so a clean re-run cancels a prior variance)
//   - buildUnresolvedReconRow (pass / fail row + always-soft block per
//     pre-cutover D4)
//   - runPreflight integration (the new row is appended after the
//     marketplace-deposits row)
//
// All supabase calls are stubbed; no live DB.

import { describe, it, expect } from "vitest";
import {
  RECON_DOMAINS,
  countUnresolvedReconVariances,
  buildUnresolvedReconRow,
  runPreflight,
} from "../../_handlers/internal/gl-periods/preflight.js";

// ─────────────────────────────────────────────────────────────────────────
// Mini Supabase double — extends the marketplace-deposits double to
// also handle recon_runs reads.
// ─────────────────────────────────────────────────────────────────────────
function makeMockClient(opts = {}) {
  const reconRuns = opts.reconRuns || [];
  const reconError = opts.reconError || null;
  const counts = opts.counts || {};
  const rpcResult = opts.rpcResult || { data: [], error: null };
  const calls = [];

  function chain(table) {
    const state = { table, filters: [], op: "select" };
    const c = {
      select(_cols, _opts) {
        state.head = !!_opts?.head;
        state.countExact = _opts?.count === "exact";
        state.op = "select";
        return c;
      },
      eq(col, val) { state.filters.push(["eq", col, val]); return c; },
      is(col, val) { state.filters.push(["is", col, val]); return c; },
      lte(col, val) { state.filters.push(["lte", col, val]); return c; },
      gte(col, val) { state.filters.push(["gte", col, val]); return c; },
      order(col, _o) { state.order = col; return c; },
      then(resolve) {
        calls.push(state);
        if (state.table === "recon_runs") {
          if (reconError) return resolve({ data: null, error: reconError });
          // Filter by period_end <= filter value
          const entityId = state.filters.find((f) => f[1] === "entity_id")?.[2];
          const periodEnd = state.filters.find((f) => f[0] === "lte" && f[1] === "period_end")?.[2];
          let rows = reconRuns.filter((r) => {
            if (entityId && r.entity_id !== entityId) return false;
            if (periodEnd && r.period_end > periodEnd) return false;
            return true;
          });
          // Sort DESC by completed_at (mirror the actual handler).
          rows = [...rows].sort((a, b) => (b.completed_at || "").localeCompare(a.completed_at || ""));
          return resolve({ data: rows, error: null });
        }
        // marketplace deposit tables — count-only.
        const c2 = counts[state.table];
        return resolve({ count: typeof c2 === "number" ? c2 : 0, error: null });
      },
    };
    return c;
  }

  return {
    from(t) { return chain(t); },
    rpc(_n, _a) { return Promise.resolve(rpcResult); },
    __calls: calls,
  };
}

const periodFixture = {
  id:        "11111111-1111-1111-1111-111111111111",
  entity_id: "22222222-2222-2222-2222-222222222222",
  ends_on:   "2026-05-31",
};

// ─────────────────────────────────────────────────────────────────────────
// RECON_DOMAINS sanity
// ─────────────────────────────────────────────────────────────────────────
describe("RECON_DOMAINS", () => {
  it("covers all 5 reconciliation domains", () => {
    expect([...RECON_DOMAINS].sort()).toEqual(["ap", "ar", "cash", "gl", "inventory"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// countUnresolvedReconVariances
// ─────────────────────────────────────────────────────────────────────────
describe("countUnresolvedReconVariances", () => {
  it("returns zero when no recon_runs exist", async () => {
    const admin = makeMockClient({ reconRuns: [] });
    const r = await countUnresolvedReconVariances(admin, periodFixture);
    expect(r.total).toBe(0);
    expect(r.perDomain).toEqual({ ap: 0, ar: 0, cash: 0, gl: 0, inventory: 0 });
  });

  it("counts a single variance run as unresolved", async () => {
    const admin = makeMockClient({
      reconRuns: [
        { id: "r1", entity_id: periodFixture.entity_id, domain: "ap", status: "variance", period_start: "2026-05-18", period_end: "2026-05-24", completed_at: "2026-05-25T12:00:00Z" },
      ],
    });
    const r = await countUnresolvedReconVariances(admin, periodFixture);
    expect(r.total).toBe(1);
    expect(r.perDomain.ap).toBe(1);
    expect(r.sampleRuns[0]).toMatchObject({ recon_run_id: "r1", domain: "ap" });
  });

  it("dedups by (domain, period_start, period_end) — a later clean run resolves a variance", async () => {
    const admin = makeMockClient({
      reconRuns: [
        // Variance on Mon.
        { id: "r1", entity_id: periodFixture.entity_id, domain: "ap", status: "variance", period_start: "2026-05-18", period_end: "2026-05-24", completed_at: "2026-05-25T12:00:00Z" },
        // Clean re-run on Tue for the SAME period (replay or manual).
        { id: "r2", entity_id: periodFixture.entity_id, domain: "ap", status: "clean", period_start: "2026-05-18", period_end: "2026-05-24", completed_at: "2026-05-26T12:00:00Z" },
      ],
    });
    const r = await countUnresolvedReconVariances(admin, periodFixture);
    expect(r.total).toBe(0);
    expect(r.perDomain.ap).toBe(0);
  });

  it("counts variances across multiple domains", async () => {
    const admin = makeMockClient({
      reconRuns: [
        { id: "r1", entity_id: periodFixture.entity_id, domain: "ap", status: "variance", period_start: "2026-05-18", period_end: "2026-05-24", completed_at: "2026-05-25T12:00:00Z" },
        { id: "r2", entity_id: periodFixture.entity_id, domain: "gl", status: "variance", period_start: "2026-05-18", period_end: "2026-05-24", completed_at: "2026-05-25T13:00:00Z" },
        { id: "r3", entity_id: periodFixture.entity_id, domain: "ar", status: "clean", period_start: "2026-05-18", period_end: "2026-05-24", completed_at: "2026-05-25T11:00:00Z" },
      ],
    });
    const r = await countUnresolvedReconVariances(admin, periodFixture);
    expect(r.total).toBe(2);
    expect(r.perDomain.ap).toBe(1);
    expect(r.perDomain.gl).toBe(1);
    expect(r.perDomain.ar).toBe(0);
  });

  it("ignores runs from another entity_id", async () => {
    const admin = makeMockClient({
      reconRuns: [
        { id: "r1", entity_id: "other-entity", domain: "ap", status: "variance", period_start: "2026-05-18", period_end: "2026-05-24", completed_at: "2026-05-25T12:00:00Z" },
      ],
    });
    const r = await countUnresolvedReconVariances(admin, periodFixture);
    expect(r.total).toBe(0);
  });

  it("ignores runs whose period_end is after preflight.ends_on", async () => {
    const admin = makeMockClient({
      reconRuns: [
        // period_end after period.ends_on=2026-05-31
        { id: "r1", entity_id: periodFixture.entity_id, domain: "ap", status: "variance", period_start: "2026-06-01", period_end: "2026-06-07", completed_at: "2026-06-08T12:00:00Z" },
      ],
    });
    const r = await countUnresolvedReconVariances(admin, periodFixture);
    expect(r.total).toBe(0);
  });

  it("treats undefined_table errors as zero (migration not applied)", async () => {
    const admin = makeMockClient({
      reconError: { message: 'relation "recon_runs" does not exist' },
    });
    const r = await countUnresolvedReconVariances(admin, periodFixture);
    expect(r.total).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it("captures a generic read error in errors[]", async () => {
    const admin = makeMockClient({
      reconError: { message: "permission denied" },
    });
    const r = await countUnresolvedReconVariances(admin, periodFixture);
    expect(r.total).toBe(0);
    expect(r.errors[0]).toMatchObject({ scope: "recon_runs_read" });
  });

  it("caps sampleRuns at 10", async () => {
    const runs = [];
    for (let i = 0; i < 15; i++) {
      runs.push({
        id: `r${i}`,
        entity_id: periodFixture.entity_id,
        domain: "ap",
        status: "variance",
        period_start: `2026-05-${String(i + 1).padStart(2, "0")}`,
        period_end: `2026-05-${String(i + 1).padStart(2, "0")}`,
        completed_at: `2026-05-${String(i + 1).padStart(2, "0")}T12:00:00Z`,
      });
    }
    const admin = makeMockClient({ reconRuns: runs });
    const r = await countUnresolvedReconVariances(admin, periodFixture);
    expect(r.total).toBe(15);
    expect(r.sampleRuns.length).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildUnresolvedReconRow
// ─────────────────────────────────────────────────────────────────────────
describe("buildUnresolvedReconRow", () => {
  it("emits a pass row when zero variances (always soft-block per pre-cutover D4)", () => {
    const row = buildUnresolvedReconRow({ perDomain: { ap: 0, ar: 0, cash: 0, gl: 0, inventory: 0 }, total: 0 });
    expect(row.check_name).toBe("unresolved_recon_variances");
    expect(row.status).toBe("pass");
    expect(row.blocking).toBe(false);
  });

  it("emits a fail row with per-domain breakdown", () => {
    const row = buildUnresolvedReconRow({ perDomain: { ap: 2, ar: 0, cash: 0, gl: 1, inventory: 0 }, total: 3 });
    expect(row.status).toBe("fail");
    expect(row.blocking).toBe(false);
    expect(row.detail).toContain("AP: 2");
    expect(row.detail).toContain("GL: 1");
    expect(row.detail).not.toContain("AR:");
  });

  it("uses singular wording for total=1", () => {
    const row = buildUnresolvedReconRow({ perDomain: { ap: 1, ar: 0, cash: 0, gl: 0, inventory: 0 }, total: 1 });
    expect(row.detail).toMatch(/1 unresolved.*variance /);
    expect(row.detail).not.toMatch(/variances /);
  });

  it("flags the warning as advisory (pre-cutover)", () => {
    const row = buildUnresolvedReconRow({ perDomain: { ap: 1, ar: 0, cash: 0, gl: 0, inventory: 0 }, total: 1 });
    expect(row.detail).toMatch(/Advisory until per-domain cutover sign-off/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runPreflight integration
// ─────────────────────────────────────────────────────────────────────────
describe("runPreflight (with unresolved-recon augmentation)", () => {
  it("appends the unresolved_recon_variances row to the RPC output", async () => {
    const admin = makeMockClient({
      rpcResult: {
        data: [{ check_name: "balanced_trial_balance", status: "pass", detail: "ok", blocking: true }],
        error: null,
      },
      reconRuns: [
        { id: "r1", entity_id: periodFixture.entity_id, domain: "ap", status: "variance", period_start: "2026-05-18", period_end: "2026-05-24", completed_at: "2026-05-25T12:00:00Z" },
      ],
    });
    const r = await runPreflight(admin, periodFixture);
    const reconRow = r.rows.find((x) => x.check_name === "unresolved_recon_variances");
    expect(reconRow).toBeTruthy();
    expect(reconRow.status).toBe("fail");
    expect(reconRow.blocking).toBe(false);
  });

  it("appends a pass row when no variances exist", async () => {
    const admin = makeMockClient({
      rpcResult: { data: [], error: null },
      reconRuns: [],
    });
    const r = await runPreflight(admin, periodFixture);
    const reconRow = r.rows.find((x) => x.check_name === "unresolved_recon_variances");
    expect(reconRow.status).toBe("pass");
  });

  it("the soft-block row does NOT cause can_close=false on its own (advisory)", async () => {
    const admin = makeMockClient({
      rpcResult: { data: [], error: null },
      reconRuns: [
        { id: "r1", entity_id: periodFixture.entity_id, domain: "ap", status: "variance", period_start: "2026-05-18", period_end: "2026-05-24", completed_at: "2026-05-25T12:00:00Z" },
      ],
    });
    const r = await runPreflight(admin, periodFixture);
    // unresolved_recon_variances is fail but blocking=false → does not flip can_close
    // (marketplace deposits row is also present and is blocking — but with zero
    // counts it passes, so can_close should stay true)
    expect(r.summary.can_close).toBe(true);
    expect(r.summary.failed_warnings).toBeGreaterThanOrEqual(1);
  });
});
