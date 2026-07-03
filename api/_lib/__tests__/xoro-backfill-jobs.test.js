// Unit tests for the unattended Xoro backfill job queue (backfillJobs.js):
// enqueue, claim (optimistic lock + crash-recovery), and advanceJob (chunked,
// budget-aware, resume-safe). runMirrorRange is injected so no DB/mirror is hit.

import { describe, it, expect } from "vitest";
import { enqueueBackfillJob, claimNextJob, advanceJob } from "../xoro-mirror/backfillJobs.js";

function daysInclusive(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000) + 1;
}
// Injected runMirrorRange stand-in: 1 of each per chunk, days = span.
function fakeRange() {
  return async (_admin, { from, to }) => ({
    days: daysInclusive(from, to),
    totals: { ar_upserted: 1, ap_upserted: 1, inventory_upserted: 1, summary_jes_posted: 1 },
    je_ids: ["je"],
    errors: [],
  });
}

// Admin double that records every update patch (advanceJob reads the job object
// it's handed, not the DB, so we only model writes).
function writeAdmin() {
  const patches = [];
  return {
    patches,
    from() {
      let patch = null;
      const chain = {
        update(p) { patch = p; return chain; },
        eq() { patches.push(patch); return Promise.resolve({ error: null }); },
      };
      return chain;
    },
  };
}

const baseJob = {
  id: "j1", entity_id: "e1", from_date: "2026-01-01", to_date: "2026-01-03",
  cursor_date: "2026-01-01", chunk_days: 2, totals: {}, je_count: 0, days_done: 0, errors: [],
};

describe("advanceJob", () => {
  it("processes the whole range in one budget and completes with aggregated totals", async () => {
    const admin = writeAdmin();
    const out = await advanceJob(admin, { ...baseJob }, { runRange: fakeRange(), nowMs: () => 1000, budgetMs: 999999 });
    expect(out.status).toBe("complete");
    expect(out.days_done).toBe(3); // 2026-01-01..03 inclusive
    const last = admin.patches[admin.patches.length - 1];
    expect(last.status).toBe("complete");
    expect(last.cursor_date).toBe("2026-01-03");
    expect(last.totals.ar_upserted).toBe(2);   // two chunks (2 + 1 days)
    expect(last.je_count).toBe(2);
    expect(last.completed_at).toBeTruthy();
  });

  it("releases the job back to pending when the time budget is spent", async () => {
    const admin = writeAdmin();
    // nowMs: calls 1-2 = 0 (start + first loop check pass), then large → loop exits after one chunk.
    let n = 0;
    const nowMs = () => { n += 1; return n <= 2 ? 0 : 10_000; };
    const job = { ...baseJob, from_date: "2026-01-01", to_date: "2026-01-31", cursor_date: "2026-01-01", chunk_days: 2 };
    const out = await advanceJob(admin, job, { runRange: fakeRange(), nowMs, budgetMs: 5000 });
    expect(out.status).toBe("pending");
    const last = admin.patches[admin.patches.length - 1];
    expect(last.status).toBe("pending"); // released for the next worker tick
  });

  it("marks the job failed when a chunk throws", async () => {
    const admin = writeAdmin();
    const boom = async () => { throw new Error("missing GL account 1200"); };
    const out = await advanceJob(admin, { ...baseJob }, { runRange: boom, nowMs: () => 0, budgetMs: 999999 });
    expect(out.status).toBe("failed");
    const last = admin.patches[admin.patches.length - 1];
    expect(last.status).toBe("failed");
    expect(last.last_error).toMatch(/missing GL account/);
  });
});

describe("enqueueBackfillJob", () => {
  it("inserts a pending job with cursor=from and the right day count", async () => {
    let inserted = null;
    const admin = { from() { return {
      insert(row) { inserted = row; return this; },
      select() { return this; },
      single() { return Promise.resolve({ data: { id: "new", ...inserted }, error: null }); },
    }; } };
    const job = await enqueueBackfillJob(admin, { entity_id: "e1", from: "2026-02-01", to: "2026-02-10" });
    expect(job.status).toBe("pending");
    expect(job.cursor_date).toBe("2026-02-01");
    expect(job.days_total).toBe(10);
    expect(job.chunk_days).toBe(30);
  });

  it("rejects from > to", async () => {
    await expect(enqueueBackfillJob({}, { entity_id: "e1", from: "2026-02-10", to: "2026-02-01" }))
      .rejects.toThrow(/on or before/);
  });
});

describe("claimNextJob", () => {
  function claimAdmin(candidates, claimedRow) {
    return {
      from() {
        const chain = {
          _isUpdate: false,
          select() { return chain; },
          in() { return chain; },
          order() { return chain; },
          limit() { return Promise.resolve({ data: candidates, error: null }); },
          update() { chain._isUpdate = true; return chain; },
          eq() { return chain; },
          maybeSingle() { return Promise.resolve({ data: claimedRow, error: null }); },
        };
        return chain;
      },
    };
  }

  it("claims the oldest pending job (flips to running)", async () => {
    const pending = { id: "j1", status: "pending", updated_at: "2026-01-01T00:00:00Z", started_at: null };
    const claimed = { ...pending, status: "running" };
    const job = await claimNextJob(claimAdmin([pending], claimed), { now: () => new Date("2026-02-01T00:00:00Z") });
    expect(job).not.toBeNull();
    expect(job.status).toBe("running");
  });

  it("skips a 'running' job whose heartbeat is still fresh", async () => {
    const nowD = new Date("2026-02-01T00:00:00Z");
    const freshRunning = { id: "j2", status: "running", updated_at: "2026-02-01T00:00:00Z", started_at: "2026-02-01T00:00:00Z" };
    const job = await claimNextJob(claimAdmin([freshRunning], null), { now: () => nowD, staleMs: 15 * 60 * 1000 });
    expect(job).toBeNull();
  });
});
