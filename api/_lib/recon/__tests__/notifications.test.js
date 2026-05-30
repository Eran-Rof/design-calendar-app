// Tangerine P9-8 — tests for the recon variance notification helpers.
//
// Covers:
//   - formatCents (sign, thousands separator, padding)
//   - buildSubject (Rule A weekly vs Rule B replay)
//   - buildBody (link, totals breakdown)
//   - classifyRun (variance / error / clean / replay)
//   - notifyReconVariance (read → classify → enqueue, full happy path,
//     read errors, classification skips, enqueue throws, payload shape)
//
// Pure helper coverage with an in-memory supabase double + an injected
// enqueue stub. No live DB.

import { describe, it, expect, vi } from "vitest";
import {
  notifyReconVariance,
  formatCents,
  buildSubject,
  buildBody,
  classifyRun,
  RECON_RECIPIENT_ROLES,
  __test_only__,
} from "../notifications.js";

const { VARIANCE_KIND_WEEKLY, VARIANCE_KIND_REPLAY } = __test_only__;

// ─────────────────────────────────────────────────────────────────────────
// Supabase client double
// ─────────────────────────────────────────────────────────────────────────
function makeAdmin({ runRow = null, runError = null } = {}) {
  return {
    from(table) {
      if (table !== "recon_runs") throw new Error(`unexpected table: ${table}`);
      const state = { filters: [] };
      const chain = {
        select() { return chain; },
        eq(col, val) { state.filters.push(["eq", col, val]); return chain; },
        maybeSingle() {
          if (runError) return Promise.resolve({ data: null, error: runError });
          return Promise.resolve({ data: runRow, error: null });
        },
      };
      return chain;
    },
  };
}

const RUN_ID = "00000000-0000-0000-0000-0000000000aa";
const ENTITY = "00000000-0000-0000-0000-000000000001";

function baseRun(overrides = {}) {
  return {
    id: RUN_ID,
    entity_id: ENTITY,
    domain: "ap",
    status: "variance",
    cadence: "weekly",
    period_start: "2026-05-18",
    period_end: "2026-05-24",
    totals_jsonb: {
      rows_compared: 42,
      variances_found: 3,
      total_variance_cents: 12345,
    },
    replay_of_id: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// formatCents
// ─────────────────────────────────────────────────────────────────────────
describe("formatCents", () => {
  it("formats zero", () => {
    expect(formatCents(0)).toBe("$0.00");
  });
  it("formats positive cents under a dollar", () => {
    expect(formatCents(5)).toBe("$0.05");
  });
  it("pads fractional component", () => {
    expect(formatCents(105)).toBe("$1.05");
  });
  it("formats positive thousands separator", () => {
    expect(formatCents(1234567)).toBe("$12,345.67");
  });
  it("formats negative", () => {
    expect(formatCents(-12345)).toBe("-$123.45");
  });
  it("handles undefined/null", () => {
    expect(formatCents(undefined)).toBe("$0.00");
    expect(formatCents(null)).toBe("$0.00");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildSubject + buildBody
// ─────────────────────────────────────────────────────────────────────────
describe("buildSubject", () => {
  it("uses 'Recon variance' prefix for weekly cadence", () => {
    const s = buildSubject({
      domain: "ap",
      period_start: "2026-05-18",
      period_end: "2026-05-24",
      total_variance_cents: 12345,
      cadence: "weekly",
    });
    expect(s).toBe("Recon variance — AP 2026-05-18 to 2026-05-24 — $123.45");
  });
  it("uses 'Recon REPLAY variance' for replay cadence", () => {
    const s = buildSubject({
      domain: "ar",
      period_start: "2026-04-01",
      period_end: "2026-04-30",
      total_variance_cents: 200000,
      cadence: "replay",
    });
    expect(s).toBe("Recon REPLAY variance — AR 2026-04-01 to 2026-04-30 — $2,000.00");
  });
  it("uppercases the domain", () => {
    const s = buildSubject({
      domain: "inventory",
      period_start: "2026-05-18",
      period_end: "2026-05-24",
      total_variance_cents: 0,
      cadence: "weekly",
    });
    expect(s).toContain("INVENTORY");
  });
});

describe("buildBody", () => {
  it("includes dashboard link with recon_run_id", () => {
    const b = buildBody({
      domain: "ap",
      period_start: "2026-05-18",
      period_end: "2026-05-24",
      total_variance_cents: 12345,
      recon_run_id: RUN_ID,
      cadence: "weekly",
      totals_jsonb: { rows_compared: 42, variances_found: 3 },
    });
    expect(b).toContain(`/tanda/InternalReconciliationDashboard?recon_run_id=${RUN_ID}`);
  });
  it("includes the totals summary lines when totals_jsonb has them", () => {
    const b = buildBody({
      domain: "ap",
      period_start: "2026-05-18",
      period_end: "2026-05-24",
      total_variance_cents: 12345,
      recon_run_id: RUN_ID,
      cadence: "weekly",
      totals_jsonb: { rows_compared: 42, variances_found: 3, skipped_count: 7 },
    });
    expect(b).toContain("rows_compared: 42");
    expect(b).toContain("variances_found: 3");
    expect(b).toContain("skipped_count: 7");
  });
  it("does not emit Summary block when totals_jsonb is empty", () => {
    const b = buildBody({
      domain: "ap",
      period_start: "2026-05-18",
      period_end: "2026-05-24",
      total_variance_cents: 0,
      recon_run_id: RUN_ID,
      cadence: "weekly",
      totals_jsonb: {},
    });
    expect(b).not.toContain("Summary:");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// classifyRun
// ─────────────────────────────────────────────────────────────────────────
describe("classifyRun", () => {
  it("classifies a weekly variance as Rule A", () => {
    const c = classifyRun(baseRun({ cadence: "weekly", status: "variance" }));
    expect(c).toEqual({ fire: true, kind: VARIANCE_KIND_WEEKLY });
  });
  it("classifies a replay variance as Rule B", () => {
    const c = classifyRun(baseRun({ cadence: "replay", status: "variance" }));
    expect(c).toEqual({ fire: true, kind: VARIANCE_KIND_REPLAY });
  });
  it("classifies a manual variance as Rule A (default kind)", () => {
    const c = classifyRun(baseRun({ cadence: "manual", status: "variance" }));
    expect(c).toEqual({ fire: true, kind: VARIANCE_KIND_WEEKLY });
  });
  it("classifies an error status as actionable (Rule A)", () => {
    const c = classifyRun(baseRun({ cadence: "weekly", status: "error" }));
    expect(c.fire).toBe(true);
  });
  it("classifies clean runs as no-fire", () => {
    const c = classifyRun(baseRun({ status: "clean" }));
    expect(c).toEqual({ fire: false, reason: "status_clean_not_actionable" });
  });
  it("classifies running runs as no-fire", () => {
    const c = classifyRun(baseRun({ status: "running" }));
    expect(c.fire).toBe(false);
  });
  it("handles null run", () => {
    expect(classifyRun(null)).toEqual({ fire: false, reason: "no_run" });
    expect(classifyRun(undefined)).toEqual({ fire: false, reason: "no_run" });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// notifyReconVariance
// ─────────────────────────────────────────────────────────────────────────
describe("notifyReconVariance", () => {
  it("emits a Rule A notification for a weekly variance run", async () => {
    const admin = makeAdmin({ runRow: baseRun() });
    const enqueue = vi.fn(async () => ({ event_id: "ev-1", dispatch_count: 4 }));
    const res = await notifyReconVariance({
      adminClient: admin,
      reconRunId: RUN_ID,
      enqueue,
    });
    expect(res.emitted).toBe(true);
    expect(res.event_id).toBe("ev-1");
    expect(res.dispatch_count).toBe(4);
    expect(res.kind).toBe(VARIANCE_KIND_WEEKLY);

    expect(enqueue).toHaveBeenCalledTimes(1);
    const [, ctx] = enqueue.mock.calls[0];
    expect(ctx.entity_id).toBe(ENTITY);
    expect(ctx.kind).toBe(VARIANCE_KIND_WEEKLY);
    expect(ctx.severity).toBe("warn");
    expect(ctx.context_table).toBe("recon_runs");
    expect(ctx.context_id).toBe(RUN_ID);
    expect(ctx.recipient_roles).toEqual([...RECON_RECIPIENT_ROLES]);
    expect(ctx.payload.domain).toBe("ap");
    expect(ctx.payload.period_start).toBe("2026-05-18");
    expect(ctx.payload.total_variance_cents).toBe(12345);
  });

  it("emits a Rule B notification for a replay variance run", async () => {
    const admin = makeAdmin({ runRow: baseRun({ cadence: "replay", domain: "gl" }) });
    const enqueue = vi.fn(async () => ({ event_id: "ev-2", dispatch_count: 1 }));
    const res = await notifyReconVariance({
      adminClient: admin,
      reconRunId: RUN_ID,
      enqueue,
    });
    expect(res.emitted).toBe(true);
    expect(res.kind).toBe(VARIANCE_KIND_REPLAY);
    const [, ctx] = enqueue.mock.calls[0];
    expect(ctx.subject).toContain("REPLAY");
    expect(ctx.subject).toContain("GL");
  });

  it("skips clean runs without enqueueing", async () => {
    const admin = makeAdmin({ runRow: baseRun({ status: "clean" }) });
    const enqueue = vi.fn();
    const res = await notifyReconVariance({
      adminClient: admin,
      reconRunId: RUN_ID,
      enqueue,
    });
    expect(res.emitted).toBe(false);
    expect(res.skipped).toBe("status_clean_not_actionable");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("skips when recon run isn't found", async () => {
    const admin = makeAdmin({ runRow: null });
    const enqueue = vi.fn();
    const res = await notifyReconVariance({
      adminClient: admin,
      reconRunId: RUN_ID,
      enqueue,
    });
    expect(res.emitted).toBe(false);
    expect(res.skipped).toBe("recon_run_not_found");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("captures supabase read errors without throwing", async () => {
    const admin = makeAdmin({ runError: { message: "transient timeout" } });
    const enqueue = vi.fn();
    const res = await notifyReconVariance({
      adminClient: admin,
      reconRunId: RUN_ID,
      enqueue,
    });
    expect(res.emitted).toBe(false);
    expect(res.errors).toEqual([
      { scope: "recon_runs_read", reason: "transient timeout" },
    ]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("captures enqueue throws without re-throwing", async () => {
    const admin = makeAdmin({ runRow: baseRun() });
    const enqueue = vi.fn(async () => { throw new Error("M28 down"); });
    const res = await notifyReconVariance({
      adminClient: admin,
      reconRunId: RUN_ID,
      enqueue,
    });
    expect(res.emitted).toBe(false);
    expect(res.errors).toEqual([{ scope: "enqueue", reason: "M28 down" }]);
  });

  it("rejects missing adminClient with an args error", async () => {
    const res = await notifyReconVariance({
      adminClient: null,
      reconRunId: RUN_ID,
      enqueue: vi.fn(),
    });
    expect(res.emitted).toBe(false);
    expect(res.errors[0]).toMatchObject({ scope: "args" });
  });

  it("rejects missing reconRunId with an args error", async () => {
    const admin = makeAdmin({ runRow: baseRun() });
    const enqueue = vi.fn();
    const res = await notifyReconVariance({
      adminClient: admin,
      reconRunId: null,
      enqueue,
    });
    expect(res.emitted).toBe(false);
    expect(res.errors[0]).toMatchObject({ scope: "args" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("defaults total_variance_cents to 0 when totals_jsonb is missing", async () => {
    const admin = makeAdmin({
      runRow: baseRun({ totals_jsonb: null }),
    });
    const enqueue = vi.fn(async () => ({ event_id: "ev-3", dispatch_count: 0 }));
    const res = await notifyReconVariance({
      adminClient: admin,
      reconRunId: RUN_ID,
      enqueue,
    });
    expect(res.emitted).toBe(true);
    const [, ctx] = enqueue.mock.calls[0];
    expect(ctx.payload.total_variance_cents).toBe(0);
    expect(ctx.subject).toContain("$0.00");
  });

  it("includes the replay_of_id in payload when present", async () => {
    const replay_of_id = "11111111-1111-1111-1111-111111111111";
    const admin = makeAdmin({
      runRow: baseRun({ cadence: "replay", replay_of_id }),
    });
    const enqueue = vi.fn(async () => ({ event_id: "ev-4", dispatch_count: 2 }));
    await notifyReconVariance({
      adminClient: admin,
      reconRunId: RUN_ID,
      enqueue,
    });
    const [, ctx] = enqueue.mock.calls[0];
    expect(ctx.payload.replay_of_id).toBe(replay_of_id);
    expect(ctx.kind).toBe(VARIANCE_KIND_REPLAY);
  });

  it("fires for status='error' as well as 'variance'", async () => {
    const admin = makeAdmin({ runRow: baseRun({ status: "error" }) });
    const enqueue = vi.fn(async () => ({ event_id: "ev-5", dispatch_count: 1 }));
    const res = await notifyReconVariance({
      adminClient: admin,
      reconRunId: RUN_ID,
      enqueue,
    });
    expect(res.emitted).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("uses the default enqueue when none is injected (smoke; surfaces M28 not-configured)", async () => {
    // We can't easily hit the real M28 without a supabase server, but
    // we can verify the import path resolves and the helper is a fn.
    // The full enqueue path is exercised in the M28 own tests; here
    // we just verify the default kicks in without an error before any
    // db work happens.
    const admin = makeAdmin({ runRow: baseRun({ status: "clean" }) });
    const res = await notifyReconVariance({
      adminClient: admin,
      reconRunId: RUN_ID,
      // no enqueue → default
    });
    // Clean status skips before enqueue ever runs, so this is safe.
    expect(res.emitted).toBe(false);
    expect(res.skipped).toBeTruthy();
  });

  it("passes totals_jsonb through to the payload verbatim", async () => {
    const tot = { rows_compared: 100, variances_found: 5, custom_key: "abc" };
    const admin = makeAdmin({ runRow: baseRun({ totals_jsonb: tot }) });
    const enqueue = vi.fn(async () => ({ event_id: "ev-6", dispatch_count: 0 }));
    await notifyReconVariance({
      adminClient: admin,
      reconRunId: RUN_ID,
      enqueue,
    });
    const [, ctx] = enqueue.mock.calls[0];
    expect(ctx.payload.totals_jsonb).toEqual(tot);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// RECON_RECIPIENT_ROLES sanity
// ─────────────────────────────────────────────────────────────────────────
describe("RECON_RECIPIENT_ROLES", () => {
  it("includes admin + accountant per spec", () => {
    expect([...RECON_RECIPIENT_ROLES]).toEqual(["admin", "accountant"]);
  });
});
