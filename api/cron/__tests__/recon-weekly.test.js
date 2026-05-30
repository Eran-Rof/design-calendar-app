// Tangerine P9-8 — tests for /api/cron/recon-weekly.
//
// Covers:
//   - HTTP gate (405 on non-GET/POST, 500 on missing env, query param validation)
//   - computeWeekRange (Monday-of-week math, edge days, returns prior Mon-Sun)
//   - resolveEntities (entity_id override vs all entities)
//   - runEntityRecon (multi-engine sequential, GL-last ordering, per-engine
//     error isolation, parallel_run_status update, notification fanout)
//   - runReconWeekly (multi-entity loop, period override, summary shape)

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  computeWeekRange,
  resolveEntities,
  runEntityRecon,
  runReconWeekly,
  updateParallelRunStatus,
  ENGINE_ORDER,
} from "../recon-weekly.js";

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
function makeRes() {
  const headers = {};
  const res = {
    statusCode: 0,
    body: null,
    setHeader(k, v) { headers[k] = v; },
    headers,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
    end() { return res; },
  };
  return res;
}

function makeEntityAdmin({
  entities = [],
  entityFetchError = null,
  parallelRunUpdate = vi.fn(async () => ({ ok: true, error: null })),
  entityLookup = null,
} = {}) {
  const calls = { reads: [], updates: [] };
  return {
    __calls: calls,
    from(table) {
      if (table !== "entities") throw new Error(`unexpected table: ${table}`);
      const state = { filters: [], updateData: null };
      const chain = {
        select(_cols) { state.op = "select"; return chain; },
        update(data) { state.op = "update"; state.updateData = data; return chain; },
        eq(col, val) { state.filters.push(["eq", col, val]); return chain; },
        maybeSingle() {
          calls.reads.push({ ...state });
          if (entityFetchError) return Promise.resolve({ data: null, error: entityFetchError });
          if (state.op === "select") {
            const eqId = state.filters.find((f) => f[1] === "id")?.[2];
            if (eqId) {
              if (entityLookup) return Promise.resolve(entityLookup);
              const e = entities.find((x) => x.id === eqId);
              return Promise.resolve({ data: e || null, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve, reject) {
          calls.reads.push({ ...state });
          if (state.op === "select") {
            if (entityFetchError) return Promise.resolve({ data: null, error: entityFetchError }).then(resolve, reject);
            return Promise.resolve({ data: entities, error: null }).then(resolve, reject);
          }
          if (state.op === "update") {
            calls.updates.push({ ...state });
            // parallelRunUpdate is a stub the test can use to inspect what was written
            return parallelRunUpdate(state.updateData, state.filters).then(
              (r) => ({ data: null, error: r.error ? { message: r.error } : null }),
            ).then(resolve, reject);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

const ENT_A = { id: "00000000-0000-0000-0000-0000000000aa", code: "ROF" };
const ENT_B = { id: "00000000-0000-0000-0000-0000000000bb", code: "DEMO" };

// ─────────────────────────────────────────────────────────────────────────
// ENGINE_ORDER sanity — GL is LAST per arch §4.3.
// ─────────────────────────────────────────────────────────────────────────
describe("ENGINE_ORDER", () => {
  it("places GL last so it can read sibling recon_runs", () => {
    expect(ENGINE_ORDER[ENGINE_ORDER.length - 1]).toBe("gl");
  });
  it("covers all 5 domains", () => {
    expect([...ENGINE_ORDER].sort()).toEqual(["ap", "ar", "cash", "gl", "inventory"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// computeWeekRange
// ─────────────────────────────────────────────────────────────────────────
describe("computeWeekRange", () => {
  it("Monday 06:00 UTC → prior Mon-Sun week", () => {
    // Mon 2026-06-08 06:00 UTC → period 2026-06-01 .. 2026-06-07
    const now = new Date(Date.UTC(2026, 5, 8, 6, 0, 0));
    expect(computeWeekRange(now)).toEqual({
      period_start: "2026-06-01",
      period_end: "2026-06-07",
    });
  });
  it("Tuesday firing still walks back to prior full Mon-Sun", () => {
    // Tue 2026-06-09 → most recent Monday = 2026-06-08, so period
    // = 2026-06-01 .. 2026-06-07.
    const now = new Date(Date.UTC(2026, 5, 9, 12, 0, 0));
    expect(computeWeekRange(now)).toEqual({
      period_start: "2026-06-01",
      period_end: "2026-06-07",
    });
  });
  it("Sunday firing produces the prior Mon-Sun (Sunday is the END of the week being closed)", () => {
    // Sun 2026-06-07 → daysBack=6 → last_monday=2026-06-01,
    // period_end=2026-05-31, period_start=2026-05-25.
    const now = new Date(Date.UTC(2026, 5, 7, 12, 0, 0));
    expect(computeWeekRange(now)).toEqual({
      period_start: "2026-05-25",
      period_end: "2026-05-31",
    });
  });
  it("handles month/year boundary", () => {
    // Mon 2027-01-04 → period = 2026-12-28 .. 2027-01-03
    const now = new Date(Date.UTC(2027, 0, 4, 6, 0, 0));
    expect(computeWeekRange(now)).toEqual({
      period_start: "2026-12-28",
      period_end: "2027-01-03",
    });
  });
  it("period_end is always 6 days after period_start", () => {
    for (let d = 1; d <= 28; d++) {
      const now = new Date(Date.UTC(2026, 5, d, 6, 0, 0));
      const r = computeWeekRange(now);
      const start = new Date(r.period_start + "T00:00:00Z");
      const end = new Date(r.period_end + "T00:00:00Z");
      const diffDays = (end - start) / 86400000;
      expect(diffDays).toBe(6);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resolveEntities
// ─────────────────────────────────────────────────────────────────────────
describe("resolveEntities", () => {
  it("returns all entities by default", async () => {
    const admin = makeEntityAdmin({ entities: [ENT_A, ENT_B] });
    const r = await resolveEntities(admin);
    expect(r.entities).toEqual([ENT_A, ENT_B]);
  });
  it("returns single entity when override is provided", async () => {
    const admin = makeEntityAdmin({ entities: [ENT_A, ENT_B] });
    const r = await resolveEntities(admin, { entity_id_override: ENT_A.id });
    expect(r.entities).toEqual([ENT_A]);
  });
  it("returns error when override id is unknown", async () => {
    const admin = makeEntityAdmin({ entities: [ENT_A] });
    const r = await resolveEntities(admin, { entity_id_override: ENT_B.id });
    expect(r.error).toMatch(/not found/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// updateParallelRunStatus
// ─────────────────────────────────────────────────────────────────────────
describe("updateParallelRunStatus", () => {
  it("merges into existing parallel_run_status preserving other domains", async () => {
    const updated = vi.fn(async () => ({ ok: true }));
    const admin = makeEntityAdmin({
      entities: [{ ...ENT_A, parallel_run_status: { ar: { status: "parallel", last_status: "clean" } } }],
      parallelRunUpdate: updated,
      entityLookup: { data: { parallel_run_status: { ar: { status: "parallel", last_status: "clean" } } }, error: null },
    });
    const r = await updateParallelRunStatus(admin, {
      entity_id: ENT_A.id,
      domain: "ap",
      recon_run_id: "run-1",
      last_status: "variance",
    });
    expect(r.ok).toBe(true);
    expect(updated).toHaveBeenCalled();
    const [data] = updated.mock.calls[0];
    expect(data.parallel_run_status.ar).toEqual({ status: "parallel", last_status: "clean" });
    expect(data.parallel_run_status.ap.last_recon).toBe("run-1");
    expect(data.parallel_run_status.ap.last_status).toBe("variance");
  });
  it("creates the domain key when parallel_run_status is empty", async () => {
    const updated = vi.fn(async () => ({ ok: true }));
    const admin = makeEntityAdmin({
      entities: [ENT_A],
      parallelRunUpdate: updated,
      entityLookup: { data: { parallel_run_status: {} }, error: null },
    });
    const r = await updateParallelRunStatus(admin, {
      entity_id: ENT_A.id,
      domain: "gl",
      recon_run_id: "run-2",
      last_status: "clean",
    });
    expect(r.ok).toBe(true);
    const [data] = updated.mock.calls[0];
    expect(data.parallel_run_status.gl).toMatchObject({
      status: "parallel",
      last_recon: "run-2",
      last_status: "clean",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runEntityRecon — per-engine ordering + isolation + notifications
// ─────────────────────────────────────────────────────────────────────────
describe("runEntityRecon", () => {
  function buildDeps({ glStatus = "clean", apThrows = false, varianceDomain = null, notify } = {}) {
    const calls = [];
    const makeStub = (domain, status, recon_run_id) => async (args) => {
      calls.push({ domain, period_start: args.period_start, period_end: args.period_end });
      return {
        recon_run_id,
        status,
        rows_compared: 10,
        variances_found: status === "variance" ? 2 : 0,
        total_variance_cents: status === "variance" ? 12345 : 0,
        totals_jsonb: { rows_compared: 10 },
        errors: [],
      };
    };
    return {
      calls,
      deps: {
        ap: apThrows ? async () => { throw new Error("ap exploded"); } : makeStub("ap", varianceDomain === "ap" ? "variance" : "clean", "run-ap"),
        ar: makeStub("ar", varianceDomain === "ar" ? "variance" : "clean", "run-ar"),
        cash: makeStub("cash", varianceDomain === "cash" ? "variance" : "clean", "run-cash"),
        inventory: makeStub("inventory", varianceDomain === "inventory" ? "variance" : "clean", "run-inv"),
        gl: makeStub("gl", glStatus, "run-gl"),
        notify: notify || (async () => ({ emitted: true, event_id: "ev-x" })),
      },
    };
  }

  it("invokes engines in AP→AR→Cash→Inventory→GL order (GL last)", async () => {
    const admin = makeEntityAdmin({
      entities: [ENT_A],
      entityLookup: { data: { parallel_run_status: {} }, error: null },
    });
    const { calls, deps } = buildDeps();
    const out = await runEntityRecon(admin, {
      entity: ENT_A,
      period_start: "2026-06-01",
      period_end: "2026-06-07",
      deps,
    });
    expect(calls.map((c) => c.domain)).toEqual(["ap", "ar", "cash", "inventory", "gl"]);
    expect(out.domains_run).toEqual(["ap", "ar", "cash", "inventory", "gl"]);
  });

  it("continues after an engine throws — one failing engine doesn't abort the others", async () => {
    const admin = makeEntityAdmin({
      entities: [ENT_A],
      entityLookup: { data: { parallel_run_status: {} }, error: null },
    });
    const { deps, calls } = buildDeps({ apThrows: true });
    const out = await runEntityRecon(admin, {
      entity: ENT_A,
      period_start: "2026-06-01",
      period_end: "2026-06-07",
      deps,
    });
    expect(calls.map((c) => c.domain)).toEqual(["ar", "cash", "inventory", "gl"]);
    expect(out.errors[0]).toMatchObject({ domain: "ap", scope: "engine_throw" });
    expect(out.results.ap.status).toBe("error");
    expect(out.domains_run).toEqual(["ar", "cash", "inventory", "gl"]);
  });

  it("fires notifications only for engines with status=variance or error", async () => {
    const admin = makeEntityAdmin({
      entities: [ENT_A],
      entityLookup: { data: { parallel_run_status: {} }, error: null },
    });
    const notify = vi.fn(async () => ({ emitted: true, event_id: "ev" }));
    const { deps } = buildDeps({ varianceDomain: "ap", notify });
    const out = await runEntityRecon(admin, {
      entity: ENT_A,
      period_start: "2026-06-01",
      period_end: "2026-06-07",
      deps,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].reconRunId).toBe("run-ap");
    expect(out.notifications_emitted).toBe(1);
    expect(out.domains_with_overages).toEqual(["ap"]);
  });

  it("fires notifications for each variance domain when multiple drift", async () => {
    const admin = makeEntityAdmin({
      entities: [ENT_A],
      entityLookup: { data: { parallel_run_status: {} }, error: null },
    });
    const notify = vi.fn(async () => ({ emitted: true, event_id: "ev" }));
    // Make AP + GL both variance.
    const calls = [];
    const deps = {
      ap: async () => { calls.push("ap"); return { recon_run_id: "run-ap", status: "variance", variances_found: 1, total_variance_cents: 100 }; },
      ar: async () => { calls.push("ar"); return { recon_run_id: "run-ar", status: "clean", variances_found: 0 }; },
      cash: async () => { calls.push("cash"); return { recon_run_id: "run-cash", status: "clean", variances_found: 0 }; },
      inventory: async () => { calls.push("inv"); return { recon_run_id: "run-inv", status: "clean", variances_found: 0 }; },
      gl: async () => { calls.push("gl"); return { recon_run_id: "run-gl", status: "variance", variances_found: 1, total_variance_cents: 50 }; },
      notify,
    };
    const out = await runEntityRecon(admin, {
      entity: ENT_A,
      period_start: "2026-06-01",
      period_end: "2026-06-07",
      deps,
    });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(out.domains_with_overages).toEqual(["ap", "gl"]);
    expect(out.notifications_emitted).toBe(2);
  });

  it("captures notify throws as errors without sinking the run", async () => {
    const admin = makeEntityAdmin({
      entities: [ENT_A],
      entityLookup: { data: { parallel_run_status: {} }, error: null },
    });
    const notify = vi.fn(async () => { throw new Error("M28 transient"); });
    const { deps } = buildDeps({ varianceDomain: "ap", notify });
    const out = await runEntityRecon(admin, {
      entity: ENT_A,
      period_start: "2026-06-01",
      period_end: "2026-06-07",
      deps,
    });
    const notifyErr = out.errors.find((e) => e.scope === "notify_throw");
    expect(notifyErr).toBeTruthy();
    expect(out.notifications_emitted).toBe(0);
  });

  it("passes period_start/period_end through to each engine verbatim", async () => {
    const admin = makeEntityAdmin({
      entities: [ENT_A],
      entityLookup: { data: { parallel_run_status: {} }, error: null },
    });
    const { calls, deps } = buildDeps();
    await runEntityRecon(admin, {
      entity: ENT_A,
      period_start: "2026-05-18",
      period_end: "2026-05-24",
      deps,
    });
    for (const c of calls) {
      expect(c.period_start).toBe("2026-05-18");
      expect(c.period_end).toBe("2026-05-24");
    }
  });

  it("sums total_variances_found across engines", async () => {
    const admin = makeEntityAdmin({
      entities: [ENT_A],
      entityLookup: { data: { parallel_run_status: {} }, error: null },
    });
    const deps = {
      ap: async () => ({ recon_run_id: "1", status: "variance", variances_found: 3 }),
      ar: async () => ({ recon_run_id: "2", status: "clean", variances_found: 0 }),
      cash: async () => ({ recon_run_id: "3", status: "clean", variances_found: 0 }),
      inventory: async () => ({ recon_run_id: "4", status: "variance", variances_found: 2 }),
      gl: async () => ({ recon_run_id: "5", status: "clean", variances_found: 0 }),
      notify: async () => ({ emitted: true }),
    };
    const out = await runEntityRecon(admin, {
      entity: ENT_A,
      period_start: "2026-06-01",
      period_end: "2026-06-07",
      deps,
    });
    expect(out.total_variances_found).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runReconWeekly — full orchestrator
// ─────────────────────────────────────────────────────────────────────────
describe("runReconWeekly", () => {
  function buildAllCleanDeps() {
    return {
      ap: async () => ({ recon_run_id: "ap", status: "clean", variances_found: 0 }),
      ar: async () => ({ recon_run_id: "ar", status: "clean", variances_found: 0 }),
      cash: async () => ({ recon_run_id: "cash", status: "clean", variances_found: 0 }),
      inventory: async () => ({ recon_run_id: "inv", status: "clean", variances_found: 0 }),
      gl: async () => ({ recon_run_id: "gl", status: "clean", variances_found: 0 }),
      notify: async () => ({ emitted: true }),
    };
  }

  it("loops over all resolved entities", async () => {
    const admin = makeEntityAdmin({
      entities: [ENT_A, ENT_B],
      entityLookup: { data: { parallel_run_status: {} }, error: null },
    });
    const r = await runReconWeekly(admin, {
      period_start: "2026-06-01",
      period_end: "2026-06-07",
      deps: buildAllCleanDeps(),
    });
    expect(r.total_entities).toBe(2);
    expect(r.entities.map((e) => e.entity_id)).toEqual([ENT_A.id, ENT_B.id]);
    expect(r.period_start).toBe("2026-06-01");
    expect(r.period_end).toBe("2026-06-07");
  });

  it("uses computed period when none provided", async () => {
    const admin = makeEntityAdmin({
      entities: [ENT_A],
      entityLookup: { data: { parallel_run_status: {} }, error: null },
    });
    const r = await runReconWeekly(admin, {
      now: new Date(Date.UTC(2026, 5, 8, 6, 0, 0)),
      deps: buildAllCleanDeps(),
    });
    expect(r.period_start).toBe("2026-06-01");
    expect(r.period_end).toBe("2026-06-07");
  });

  it("scopes to a single entity when entity_id_override is set", async () => {
    const admin = makeEntityAdmin({
      entities: [ENT_A, ENT_B],
      entityLookup: { data: { id: ENT_B.id, code: ENT_B.code, parallel_run_status: {} }, error: null },
    });
    const r = await runReconWeekly(admin, {
      period_start: "2026-06-01",
      period_end: "2026-06-07",
      entity_id_override: ENT_B.id,
      deps: buildAllCleanDeps(),
    });
    expect(r.total_entities).toBe(1);
    expect(r.entities[0].entity_id).toBe(ENT_B.id);
  });

  it("rejects invalid date format", async () => {
    const admin = makeEntityAdmin({ entities: [] });
    await expect(runReconWeekly(admin, {
      period_start: "bad-date",
      period_end: "2026-06-07",
    })).rejects.toThrow(/period_start/);
  });

  it("rejects period_end < period_start", async () => {
    const admin = makeEntityAdmin({ entities: [] });
    await expect(runReconWeekly(admin, {
      period_start: "2026-06-08",
      period_end: "2026-06-01",
    })).rejects.toThrow(/period_end/);
  });

  it("aggregates total_notifications across entities", async () => {
    const admin = makeEntityAdmin({
      entities: [ENT_A, ENT_B],
      entityLookup: { data: { parallel_run_status: {} }, error: null },
    });
    const notify = vi.fn(async () => ({ emitted: true, event_id: "ev" }));
    const deps = {
      ap: async () => ({ recon_run_id: "ap", status: "variance", variances_found: 1, total_variance_cents: 100 }),
      ar: async () => ({ recon_run_id: "ar", status: "clean", variances_found: 0 }),
      cash: async () => ({ recon_run_id: "cash", status: "clean", variances_found: 0 }),
      inventory: async () => ({ recon_run_id: "inv", status: "clean", variances_found: 0 }),
      gl: async () => ({ recon_run_id: "gl", status: "clean", variances_found: 0 }),
      notify,
    };
    const r = await runReconWeekly(admin, {
      period_start: "2026-06-01",
      period_end: "2026-06-07",
      deps,
    });
    expect(r.total_notifications).toBe(2); // one per entity
  });
});

// ─────────────────────────────────────────────────────────────────────────
// HTTP handler
// ─────────────────────────────────────────────────────────────────────────
const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("HTTP handler", () => {
  it("returns 405 on PUT", async () => {
    const mod = await import("../recon-weekly.js");
    const req = { method: "PUT", headers: {}, url: "/api/cron/recon-weekly" };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toMatch(/GET/);
  });

  it("returns 500 when env is missing", async () => {
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const mod = await import("../recon-weekly.js");
    const req = { method: "GET", headers: {}, url: "/api/cron/recon-weekly" };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/configured/);
  });

  it("rejects bad period_start format with 400", async () => {
    process.env.VITE_SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
    const mod = await import("../recon-weekly.js");
    const req = { method: "GET", headers: { host: "localhost" }, url: "/api/cron/recon-weekly?period_start=bad" };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("rejects period_start-without-period_end with 400", async () => {
    process.env.VITE_SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
    const mod = await import("../recon-weekly.js");
    const req = { method: "GET", headers: { host: "localhost" }, url: "/api/cron/recon-weekly?period_start=2026-06-01" };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/both/);
  });

  it("rejects period_end < period_start at the query level", async () => {
    process.env.VITE_SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
    const mod = await import("../recon-weekly.js");
    const req = { method: "GET", headers: { host: "localhost" }, url: "/api/cron/recon-weekly?period_start=2026-06-08&period_end=2026-06-01" };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(400);
  });
});
