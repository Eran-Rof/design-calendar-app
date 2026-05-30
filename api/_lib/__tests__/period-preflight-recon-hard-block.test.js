// Tangerine P9-9 — preflight hard-block extension tests.
//
// Covers the P9-9 flip of the unresolved-recon-variances preflight check
// from soft-block (advisory) to hard-block when one or more cut-over
// domains have unresolved variances:
//
//   - parallel mode → blocking=false  (P9-8 behavior preserved)
//   - solo mode (cut over) with variance → blocking=true (NEW)
//   - mixed (one solo + one parallel, both with variances) → blocking=true
//     because at least one cut-over domain has variances
//   - fetchSoloDomains helper (parses entities.parallel_run_status jsonb)

import { describe, it, expect } from "vitest";
import {
  buildUnresolvedReconRow,
  fetchSoloDomains,
  runPreflight,
} from "../../_handlers/internal/gl-periods/preflight.js";

// ────────────────────────────────────────────────────────────────────────
// buildUnresolvedReconRow with soloDomains parameter
// ────────────────────────────────────────────────────────────────────────
describe("buildUnresolvedReconRow with soloDomains", () => {
  it("pass: no variances → blocking false, status pass (irrespective of solo list)", () => {
    const row = buildUnresolvedReconRow(
      { total: 0, perDomain: { ap: 0, ar: 0, cash: 0, gl: 0, inventory: 0 } },
      ["ap", "ar"],
    );
    expect(row.status).toBe("pass");
    expect(row.blocking).toBe(false);
  });

  it("parallel mode (no solo domains) → blocking false (soft-block)", () => {
    const row = buildUnresolvedReconRow(
      { total: 2, perDomain: { ap: 1, ar: 0, cash: 0, gl: 1, inventory: 0 } },
      [],
    );
    expect(row.status).toBe("fail");
    expect(row.blocking).toBe(false);
    expect(row.detail).toMatch(/Advisory until per-domain cutover sign-off/);
  });

  it("parallel mode (no soloDomains arg) → blocking false", () => {
    const row = buildUnresolvedReconRow(
      { total: 1, perDomain: { ap: 1, ar: 0, cash: 0, gl: 0, inventory: 0 } },
    );
    expect(row.status).toBe("fail");
    expect(row.blocking).toBe(false);
  });

  it("solo mode + variance on cut-over domain → blocking true (hard-block)", () => {
    const row = buildUnresolvedReconRow(
      { total: 1, perDomain: { ap: 1, ar: 0, cash: 0, gl: 0, inventory: 0 } },
      ["ap"],
    );
    expect(row.status).toBe("fail");
    expect(row.blocking).toBe(true);
    expect(row.detail).toMatch(/post-cutover/);
    expect(row.detail).toMatch(/AP/);
  });

  it("solo mode but variance on a non-cutover domain → blocking false", () => {
    // ap is solo but variance is on ar (still parallel) → soft-block.
    const row = buildUnresolvedReconRow(
      { total: 1, perDomain: { ap: 0, ar: 1, cash: 0, gl: 0, inventory: 0 } },
      ["ap"],
    );
    expect(row.status).toBe("fail");
    expect(row.blocking).toBe(false);
  });

  it("mixed: solo cash + variance on cash, variance on ar parallel → hard-block", () => {
    const row = buildUnresolvedReconRow(
      { total: 2, perDomain: { ap: 0, ar: 1, cash: 1, gl: 0, inventory: 0 } },
      ["cash"],
    );
    expect(row.status).toBe("fail");
    expect(row.blocking).toBe(true);
    expect(row.detail).toMatch(/CASH/);
    expect(row.detail).toMatch(/AR/);
  });

  it("multiple solo domains with variances → mentions both", () => {
    const row = buildUnresolvedReconRow(
      { total: 4, perDomain: { ap: 2, ar: 0, cash: 1, gl: 1, inventory: 0 } },
      ["ap", "cash", "gl"],
    );
    expect(row.blocking).toBe(true);
    expect(row.detail).toMatch(/AP/);
    expect(row.detail).toMatch(/CASH/);
    expect(row.detail).toMatch(/GL/);
  });

  it("non-array soloDomains is tolerated (defensive)", () => {
    const row = buildUnresolvedReconRow(
      { total: 1, perDomain: { ap: 1, ar: 0, cash: 0, gl: 0, inventory: 0 } },
      null,
    );
    expect(row.blocking).toBe(false);
  });

  it("detail includes the per-domain count breakdown", () => {
    const row = buildUnresolvedReconRow(
      { total: 3, perDomain: { ap: 1, ar: 2, cash: 0, gl: 0, inventory: 0 } },
      [],
    );
    expect(row.detail).toMatch(/AP: 1/);
    expect(row.detail).toMatch(/AR: 2/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// fetchSoloDomains
// ────────────────────────────────────────────────────────────────────────
function makeEntitiesClient({ parallel_run_status = {}, error = null } = {}) {
  return {
    from(table) {
      if (table !== "entities") throw new Error(`unexpected table ${table}`);
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() {
          if (error) return Promise.resolve({ data: null, error });
          return Promise.resolve({ data: { parallel_run_status }, error: null });
        },
      };
    },
  };
}

describe("fetchSoloDomains", () => {
  it("returns empty when parallel_run_status is empty", async () => {
    const admin = makeEntitiesClient({ parallel_run_status: {} });
    expect(await fetchSoloDomains(admin, "ent-1")).toEqual([]);
  });

  it("returns the list of domains with status='solo'", async () => {
    const admin = makeEntitiesClient({
      parallel_run_status: {
        ap: { status: "solo" },
        ar: { status: "parallel" },
        cash: { status: "solo" },
        gl: { status: "parallel" },
        inventory: { status: "solo" },
      },
    });
    expect((await fetchSoloDomains(admin, "ent-1")).sort()).toEqual(["ap", "cash", "inventory"]);
  });

  it("ignores non-recon-domain keys (defensive)", async () => {
    const admin = makeEntitiesClient({
      parallel_run_status: {
        bogus: { status: "solo" },
        ap: { status: "solo" },
      },
    });
    expect(await fetchSoloDomains(admin, "ent-1")).toEqual(["ap"]);
  });

  it("returns empty when no entity_id provided", async () => {
    const admin = makeEntitiesClient({ parallel_run_status: { ap: { status: "solo" } } });
    expect(await fetchSoloDomains(admin, null)).toEqual([]);
  });

  it("returns empty on DB error (don't false-hard-block)", async () => {
    const admin = makeEntitiesClient({ error: { message: "boom" } });
    expect(await fetchSoloDomains(admin, "ent-1")).toEqual([]);
  });

  it("returns empty on bad jsonb shape", async () => {
    const admin = makeEntitiesClient({ parallel_run_status: "not an object" });
    expect(await fetchSoloDomains(admin, "ent-1")).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// runPreflight integration: the soloDomains list reaches the recon row
// ────────────────────────────────────────────────────────────────────────
function makeFullClient({
  reconRuns = [],
  parallel_run_status = {},
  rpcResult = { data: [], error: null },
  counts = {},
}) {
  return {
    rpc(_name, _args) { return Promise.resolve(rpcResult); },
    from(table) {
      const state = { table, filters: [], head: false };
      const builder = {
        select(_cols, opts) { state.head = !!opts?.head; return builder; },
        eq(c, v) { state.filters.push(["eq", c, v]); return builder; },
        is(c, v) { state.filters.push(["is", c, v]); return builder; },
        lte(c, v) { state.filters.push(["lte", c, v]); return builder; },
        gte(c, v) { state.filters.push(["gte", c, v]); return builder; },
        order() { return builder; },
        maybeSingle() {
          if (table === "entities") {
            return Promise.resolve({ data: { parallel_run_status }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve) {
          if (table === "recon_runs") {
            const periodEnd = state.filters.find((f) => f[0] === "lte" && f[1] === "period_end")?.[2];
            const rows = (reconRuns || []).filter((r) =>
              !periodEnd || r.period_end <= periodEnd,
            );
            return resolve({ data: rows, error: null });
          }
          // deposit tables — return zero count.
          return resolve({ count: counts[table] || 0, error: null });
        },
      };
      return builder;
    },
  };
}

const period = {
  id: "p1",
  entity_id: "ent-1",
  ends_on: "2026-05-31",
};

describe("runPreflight integration — solo hard-block flip", () => {
  it("solo cash + variance → recon row blocks the close", async () => {
    const admin = makeFullClient({
      reconRuns: [
        {
          id: "r1",
          domain: "cash",
          status: "variance",
          period_start: "2026-05-25",
          period_end: "2026-05-31",
          completed_at: "2026-05-31T12:00:00Z",
        },
      ],
      parallel_run_status: { cash: { status: "solo" } },
    });
    const out = await runPreflight(admin, period);
    const reconRow = out.rows.find((r) => r.check_name === "unresolved_recon_variances");
    expect(reconRow).toBeTruthy();
    expect(reconRow.blocking).toBe(true);
    expect(out.summary.can_close).toBe(false);
  });

  it("parallel cash + variance → soft-block, close still possible", async () => {
    const admin = makeFullClient({
      reconRuns: [
        {
          id: "r1",
          domain: "cash",
          status: "variance",
          period_start: "2026-05-25",
          period_end: "2026-05-31",
          completed_at: "2026-05-31T12:00:00Z",
        },
      ],
      parallel_run_status: { cash: { status: "parallel" } },
    });
    const out = await runPreflight(admin, period);
    const reconRow = out.rows.find((r) => r.check_name === "unresolved_recon_variances");
    expect(reconRow.blocking).toBe(false);
  });

  it("solo ap, variance only on ar (parallel) → soft-block (ap variance not present)", async () => {
    const admin = makeFullClient({
      reconRuns: [
        {
          id: "r1",
          domain: "ar",
          status: "variance",
          period_start: "2026-05-25",
          period_end: "2026-05-31",
          completed_at: "2026-05-31T12:00:00Z",
        },
      ],
      parallel_run_status: { ap: { status: "solo" } },
    });
    const out = await runPreflight(admin, period);
    const reconRow = out.rows.find((r) => r.check_name === "unresolved_recon_variances");
    expect(reconRow.blocking).toBe(false);
  });

  it("no variances regardless of solo state → pass row", async () => {
    const admin = makeFullClient({
      reconRuns: [
        {
          id: "r1",
          domain: "cash",
          status: "clean",
          period_start: "2026-05-25",
          period_end: "2026-05-31",
          completed_at: "2026-05-31T12:00:00Z",
        },
      ],
      parallel_run_status: { cash: { status: "solo" } },
    });
    const out = await runPreflight(admin, period);
    const reconRow = out.rows.find((r) => r.check_name === "unresolved_recon_variances");
    expect(reconRow.status).toBe("pass");
    expect(reconRow.blocking).toBe(false);
  });
});
