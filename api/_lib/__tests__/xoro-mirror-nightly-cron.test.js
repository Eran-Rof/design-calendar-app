// Cross-cutter T10-6 — Tests for the nightly Xoro mirror orchestrator.
//
// Exercises runNightlyMirror with a tiny in-memory supabase double + injected
// mock mirror functions. Coverage:
//
//   - happy path: 3 domains succeed → summary JE posts → complete notification
//   - stale-Xoro guard: MAX(completed_at) > 25h old → all 3 domains marked
//     skipped_stale_xoro, no mirror calls, stale-fetch notification
//   - missing-Xoro guard: no successful rows at all → same skip behavior
//   - one-domain-fails: AR ok, AP throws → summary JE NOT posted, partial
//     notification, AP run row recorded with kind='uncaught'
//   - inventory fails: same partial behavior, summary skipped
//   - all-fail: 3 throws, summary skipped, partial notification
//   - mirror_date defaults to yesterday-UTC when not passed
//   - mirror_date passes through query override
//   - bad mirror_date throws synchronously
//   - bad entity_id_override throws
//   - row-open failure handled per-domain
//   - notification payload shape (mirror_date + per-domain summary)
//   - successful kind === 'xoro_mirror_complete'
//   - partial kind === 'xoro_mirror_partial_failure'
//   - stale kind === 'xoro_mirror_stale_fetch_skip'
//   - notification enqueue failure doesn't crash orchestrator
//
// We use vi.hoisted state to swap mirror function bodies per-test, identical
// to the FIFO-AR integration test pattern.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runNightlyMirror, defaultMirrorDate, isXoroFetchStale, enumerateDates, runMirrorRange, MAX_RANGE_DAYS } from "../../cron/xoro-mirror-nightly.js";

// ─────────────────────────────────────────────────────────────────────────────
// In-memory supabase double
// ─────────────────────────────────────────────────────────────────────────────

function makeSupabase(opts = {}) {
  const {
    entities = [{ id: "ent-1", code: "ROF" }],
    xoroSyncLogs = [{ completed_at: new Date().toISOString() }],
    syncLogReadError = null,
    insertFailDomains = new Set(),  // domain names that should throw on row insert
  } = opts;

  const state = {
    runRowsInserted: [],   // every xoro_mirror_runs INSERT
    runRowsUpdated: [],    // every xoro_mirror_runs UPDATE
    notificationEvents: [],
    notificationDispatches: [],
  };

  const sb = {
    state,
    from(table) {
      if (table === "entities") {
        return {
          select() { return this; },
          eq(_col, val) { this._val = val; this._col = _col; return this; },
          maybeSingle() {
            const match = entities.find((e) => e[this._col] === this._val);
            return Promise.resolve({ data: match || null, error: null });
          },
        };
      }
      if (table === "xoro_sync_logs") {
        return {
          select() { return this; },
          eq() { return this; },
          not() { return this; },
          order() { return this; },
          limit() {
            if (syncLogReadError) {
              return Promise.resolve({ data: null, error: syncLogReadError });
            }
            return Promise.resolve({ data: xoroSyncLogs, error: null });
          },
        };
      }
      if (table === "xoro_mirror_runs") {
        const builder = {
          _insertRow: null,
          _updateRow: null,
          _whereId: null,
          insert(row) {
            this._insertRow = row;
            const domain = row.domain;
            if (insertFailDomains.has(domain)) {
              return {
                select() { return this; },
                maybeSingle() {
                  return Promise.resolve({ data: null, error: { message: `mock-insert-fail-${domain}` } });
                },
              };
            }
            const id = "run-" + (state.runRowsInserted.length + 1);
            state.runRowsInserted.push({ id, ...row });
            return {
              select() { return this; },
              maybeSingle() { return Promise.resolve({ data: { id }, error: null }); },
            };
          },
          update(row) {
            this._updateRow = row;
            return this;
          },
          eq(col, val) {
            if (col === "id") {
              this._whereId = val;
              state.runRowsUpdated.push({ id: val, update: this._updateRow });
            }
            return Promise.resolve({ error: null });
          },
        };
        return builder;
      }
      if (table === "notification_events") {
        return {
          insert(row) {
            return {
              select() { return this; },
              single() {
                const id = "ev-" + (state.notificationEvents.length + 1);
                state.notificationEvents.push({ id, ...row });
                return Promise.resolve({ data: { id }, error: null });
              },
            };
          },
        };
      }
      if (table === "notification_preferences") {
        return {
          select() { return this; },
          in() { return this; },
          eq() { return Promise.resolve({ data: [], error: null }); },
        };
      }
      if (table === "notification_dispatches") {
        return {
          insert(rows) {
            for (const r of rows) state.notificationDispatches.push(r);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "entity_users") {
        return {
          select() { return this; },
          eq() { return this; },
          in() { return Promise.resolve({ data: [{ user_id: "u-admin" }], error: null }); },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return sb;
}

function okSummary({ rows_upserted = 1, rows_unchanged = 0, rows_deleted = 0, errors = [] } = {}) {
  return { rows_upserted, rows_unchanged, rows_deleted, errors };
}

function makeDeps({
  arSummary = okSummary({ rows_upserted: 3 }),
  apSummary = okSummary({ rows_upserted: 2 }),
  invSummary = okSummary({ rows_upserted: 100, rows_deleted: 99 }),
  summaryResult = { posted: 3, je_ids: ["je-1", "je-2", "je-3"], errors: [] },
  failDomain = null,
  enqueueImpl = null,
} = {}) {
  const mirrorAr        = vi.fn(async () => arSummary);
  const mirrorAp        = vi.fn(async () => apSummary);
  const rebuildInventory = vi.fn(async () => invSummary);
  const postSummary     = vi.fn(async () => summaryResult);
  if (failDomain === "ar") mirrorAr.mockRejectedValue(new Error("ar-boom"));
  if (failDomain === "ap") mirrorAp.mockRejectedValue(new Error("ap-boom"));
  if (failDomain === "inventory") rebuildInventory.mockRejectedValue(new Error("inv-boom"));
  if (failDomain === "summary") postSummary.mockRejectedValue(new Error("summary-boom"));
  const enqueue = enqueueImpl || vi.fn(async () => ({ event_id: "ev-mock" }));
  return { mirrorAr, mirrorAp, rebuildInventory, postSummary, enqueue };
}

const MD = "2026-05-27";

// ─────────────────────────────────────────────────────────────────────────────
// defaultMirrorDate
// ─────────────────────────────────────────────────────────────────────────────

describe("defaultMirrorDate", () => {
  it("returns YYYY-MM-DD", () => {
    const v = defaultMirrorDate(new Date("2026-05-28T02:30:00Z"));
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("subtracts one day (yesterday-UTC at cron time)", () => {
    // 01:30 UTC on May 28 → mirror_date = May 27
    const v = defaultMirrorDate(new Date("2026-05-28T01:30:00Z"));
    expect(v).toBe("2026-05-27");
  });
  it("handles month rollover", () => {
    const v = defaultMirrorDate(new Date("2026-06-01T01:30:00Z"));
    expect(v).toBe("2026-05-31");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// enumerateDates + runMirrorRange (one-shot range backfill)
// ─────────────────────────────────────────────────────────────────────────────

describe("enumerateDates", () => {
  it("returns an inclusive list", () => {
    expect(enumerateDates("2026-05-27", "2026-05-29")).toEqual(["2026-05-27", "2026-05-28", "2026-05-29"]);
  });
  it("single day → one entry", () => {
    expect(enumerateDates("2026-05-27", "2026-05-27")).toEqual(["2026-05-27"]);
  });
  it("crosses a month boundary (DST-safe UTC)", () => {
    expect(enumerateDates("2026-05-31", "2026-06-02")).toEqual(["2026-05-31", "2026-06-01", "2026-06-02"]);
  });
});

describe("runMirrorRange", () => {
  it("mirrors every date in the range and aggregates totals + JE ids", async () => {
    const sb = makeSupabase();
    const deps = makeDeps(); // ar=3, ap=2, inv=100 per date; summary posts 3 JEs per date
    const out = await runMirrorRange(sb, { from: "2026-05-27", to: "2026-05-29", deps });
    expect(out.status).toBe("complete");
    expect(out.days).toBe(3);
    expect(out.per_date).toHaveLength(3);
    expect(out.per_date.every((d) => d.status === "complete")).toBe(true);
    expect(out.totals.ar_upserted).toBe(9);   // 3 × 3 days
    expect(out.totals.ap_upserted).toBe(6);    // 2 × 3
    expect(out.totals.inventory_upserted).toBe(300); // 100 × 3
    expect(out.totals.summary_jes_posted).toBe(9);   // 3 × 3
    expect(out.je_ids).toHaveLength(9);
  });

  it("bypasses the stale-fetch guard (backfill mirrors historical data)", async () => {
    // Fetch last completed 100h ago → the nightly would skip; the range must NOT.
    const stale = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    const sb = makeSupabase({ xoroSyncLogs: [{ completed_at: stale }] });
    const deps = makeDeps();
    const out = await runMirrorRange(sb, { from: "2026-05-27", to: "2026-05-28", deps });
    expect(out.per_date.every((d) => d.status === "complete")).toBe(true);
    expect(deps.mirrorAr).toHaveBeenCalledTimes(2); // ran both dates, not skipped
  });

  it("emits no per-date notification (range would emit one)", async () => {
    const sb = makeSupabase();
    await runMirrorRange(sb, { from: "2026-05-27", to: "2026-05-28", deps: makeDeps() });
    expect(sb.state.notificationEvents).toHaveLength(0);
  });

  it("rejects from > to", async () => {
    await expect(runMirrorRange(makeSupabase(), { from: "2026-05-29", to: "2026-05-27" }))
      .rejects.toThrow(/on or before/i);
  });

  it("rejects a range larger than the cap", async () => {
    const from = "2026-01-01";
    const to = "2026-12-31"; // way over MAX_RANGE_DAYS
    await expect(runMirrorRange(makeSupabase(), { from, to })).rejects.toThrow(new RegExp(`max ${MAX_RANGE_DAYS}`));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isXoroFetchStale
// ─────────────────────────────────────────────────────────────────────────────

describe("isXoroFetchStale", () => {
  it("returns stale=false when last fetch was 1h ago", async () => {
    const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const sb = makeSupabase({ xoroSyncLogs: [{ completed_at: recent }] });
    const r = await isXoroFetchStale(sb);
    expect(r.stale).toBe(false);
    expect(r.hours_since).toBeLessThan(2);
  });
  it("returns stale=true when last fetch was 26h ago", async () => {
    const old = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    const sb = makeSupabase({ xoroSyncLogs: [{ completed_at: old }] });
    const r = await isXoroFetchStale(sb);
    expect(r.stale).toBe(true);
    expect(r.hours_since).toBeGreaterThan(25);
  });
  it("returns stale=true when no rows exist", async () => {
    const sb = makeSupabase({ xoroSyncLogs: [] });
    const r = await isXoroFetchStale(sb);
    expect(r.stale).toBe(true);
    expect(r.last_completed_at).toBe(null);
  });
  it("returns stale=true on read error", async () => {
    const sb = makeSupabase({
      xoroSyncLogs: [],
      syncLogReadError: { message: "permission denied" },
    });
    const r = await isXoroFetchStale(sb);
    expect(r.stale).toBe(true);
    expect(r.read_error).toBe("permission denied");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runNightlyMirror — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("runNightlyMirror — happy path", () => {
  it("runs all 3 mirrors + summary JE + complete notification", async () => {
    const sb = makeSupabase();
    const deps = makeDeps();
    const out = await runNightlyMirror(sb, { mirror_date: MD, deps });

    expect(out.status).toBe("complete");
    expect(out.mirror_date).toBe(MD);
    expect(out.ar.status).toBe("complete");
    expect(out.ap.status).toBe("complete");
    expect(out.inventory.status).toBe("complete");
    expect(out.summary_jes.status).toBe("complete");
    expect(out.summary_jes.posted).toBe(3);
    expect(out.notification_emitted).toBe(true);

    // All three mirrors were called once with the right args.
    expect(deps.mirrorAr).toHaveBeenCalledWith(sb, "ent-1", MD);
    expect(deps.mirrorAp).toHaveBeenCalledWith(sb, "ent-1", MD);
    expect(deps.rebuildInventory).toHaveBeenCalledWith(sb, "ent-1", MD);
    expect(deps.postSummary).toHaveBeenCalledWith(sb, "ent-1", MD);
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
  });

  it("inserts a xoro_mirror_runs row for each domain + summary_je", async () => {
    const sb = makeSupabase();
    const deps = makeDeps();
    await runNightlyMirror(sb, { mirror_date: MD, deps });
    const domains = sb.state.runRowsInserted.map((r) => r.domain).sort();
    expect(domains).toEqual(["ap", "ar", "inventory", "summary_je"]);
  });

  it("propagates row counts from each summary into the run row update", async () => {
    const sb = makeSupabase();
    const deps = makeDeps();
    await runNightlyMirror(sb, { mirror_date: MD, deps });
    const arUpdate = sb.state.runRowsUpdated.find((u) =>
      sb.state.runRowsInserted.find((i) => i.id === u.id && i.domain === "ar"));
    expect(arUpdate.update.rows_upserted).toBe(3);
    expect(arUpdate.update.status).toBe("complete");
  });

  it("emits notification with kind=xoro_mirror_complete and severity=info", async () => {
    const sb = makeSupabase();
    const deps = makeDeps();
    await runNightlyMirror(sb, { mirror_date: MD, deps });
    const ev = deps.enqueue.mock.calls[0][1];
    expect(ev.kind).toBe("xoro_mirror_complete");
    expect(ev.severity).toBe("info");
    expect(ev.subject).toMatch(/Xoro mirror complete/);
    expect(ev.context_table).toBe("xoro_mirror_runs");
  });

  it("notification payload carries mirror_date + per-domain summary", async () => {
    const sb = makeSupabase();
    const deps = makeDeps();
    await runNightlyMirror(sb, { mirror_date: MD, deps });
    const ev = deps.enqueue.mock.calls[0][1];
    expect(ev.payload.mirror_date).toBe(MD);
    expect(ev.payload.status).toBe("complete");
    expect(ev.payload.ar.rows_upserted).toBe(3);
    expect(ev.payload.ap.rows_upserted).toBe(2);
    expect(ev.payload.inventory.rows_deleted).toBe(99);
    expect(ev.payload.summary_jes.posted).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runNightlyMirror — stale-Xoro guard
// ─────────────────────────────────────────────────────────────────────────────

describe("runNightlyMirror — stale-Xoro guard", () => {
  it("skips all domains when last fetch > 25h old", async () => {
    const old = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    const sb = makeSupabase({ xoroSyncLogs: [{ completed_at: old }] });
    const deps = makeDeps();
    const out = await runNightlyMirror(sb, { mirror_date: MD, deps });

    expect(out.status).toBe("skipped_stale_xoro");
    expect(out.ar.status).toBe("skipped_stale_xoro");
    expect(out.ap.status).toBe("skipped_stale_xoro");
    expect(out.inventory.status).toBe("skipped_stale_xoro");
    expect(out.last_xoro_fetch_at).toBe(old);
    expect(out.hours_since_last_fetch).toBeGreaterThan(25);

    // No mirror function was invoked.
    expect(deps.mirrorAr).not.toHaveBeenCalled();
    expect(deps.mirrorAp).not.toHaveBeenCalled();
    expect(deps.rebuildInventory).not.toHaveBeenCalled();
    expect(deps.postSummary).not.toHaveBeenCalled();
  });

  it("inserts 3 skip rows in xoro_mirror_runs", async () => {
    const old = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    const sb = makeSupabase({ xoroSyncLogs: [{ completed_at: old }] });
    const out = await runNightlyMirror(sb, { mirror_date: MD, deps: makeDeps() });
    const skipped = sb.state.runRowsInserted.filter((r) => r.status === "skipped_stale_xoro");
    expect(skipped).toHaveLength(3);
    expect(skipped.map((r) => r.domain).sort()).toEqual(["ap", "ar", "inventory"]);
    expect(out.notification_emitted).toBe(true);
  });

  it("emits notification with kind=xoro_mirror_stale_fetch_skip + severity=warn", async () => {
    const old = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
    const sb = makeSupabase({ xoroSyncLogs: [{ completed_at: old }] });
    const deps = makeDeps();
    await runNightlyMirror(sb, { mirror_date: MD, deps });
    const ev = deps.enqueue.mock.calls[0][1];
    expect(ev.kind).toBe("xoro_mirror_stale_fetch_skip");
    expect(ev.severity).toBe("warn");
    expect(ev.payload.last_xoro_fetch_at).toBe(old);
    expect(ev.payload.threshold_hours).toBe(25);
  });

  it("handles 'no successful Xoro fetch ever' gracefully", async () => {
    const sb = makeSupabase({ xoroSyncLogs: [] });
    const deps = makeDeps();
    const out = await runNightlyMirror(sb, { mirror_date: MD, deps });
    expect(out.status).toBe("skipped_stale_xoro");
    expect(out.last_xoro_fetch_at).toBe(null);
    const ev = deps.enqueue.mock.calls[0][1];
    expect(ev.body).toMatch(/No successful Xoro fetch/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runNightlyMirror — partial failures
// ─────────────────────────────────────────────────────────────────────────────

describe("runNightlyMirror — partial failures", () => {
  it("AP throws → status='partial', summary JE NOT posted", async () => {
    const sb = makeSupabase();
    const deps = makeDeps({ failDomain: "ap" });
    const out = await runNightlyMirror(sb, { mirror_date: MD, deps });

    expect(out.status).toBe("partial");
    expect(out.ar.status).toBe("complete");
    expect(out.ap.status).toBe("failed");
    expect(out.inventory.status).toBe("complete");
    expect(out.summary_jes.skipped).toBe("one_or_more_domains_failed");
    expect(deps.postSummary).not.toHaveBeenCalled();
  });

  it("AP throw is recorded on its run row with kind='uncaught'", async () => {
    const sb = makeSupabase();
    const deps = makeDeps({ failDomain: "ap" });
    await runNightlyMirror(sb, { mirror_date: MD, deps });
    const apRow = sb.state.runRowsInserted.find((r) => r.domain === "ap");
    const apUpdate = sb.state.runRowsUpdated.find((u) => u.id === apRow.id);
    expect(apUpdate.update.status).toBe("failed");
    expect(apUpdate.update.errors[0].kind).toBe("uncaught");
    expect(apUpdate.update.errors[0].message).toBe("ap-boom");
  });

  it("partial failure emits notification kind=xoro_mirror_partial_failure + warn", async () => {
    const sb = makeSupabase();
    const deps = makeDeps({ failDomain: "inventory" });
    await runNightlyMirror(sb, { mirror_date: MD, deps });
    const ev = deps.enqueue.mock.calls[0][1];
    expect(ev.kind).toBe("xoro_mirror_partial_failure");
    expect(ev.severity).toBe("warn");
    expect(ev.subject).toMatch(/PARTIAL/);
  });

  it("all three domains fail → still attempts notification", async () => {
    const sb = makeSupabase();
    const deps = makeDeps();
    deps.mirrorAr.mockRejectedValue(new Error("ar-boom"));
    deps.mirrorAp.mockRejectedValue(new Error("ap-boom"));
    deps.rebuildInventory.mockRejectedValue(new Error("inv-boom"));
    const out = await runNightlyMirror(sb, { mirror_date: MD, deps });
    expect(out.status).toBe("partial");
    expect(out.ar.status).toBe("failed");
    expect(out.ap.status).toBe("failed");
    expect(out.inventory.status).toBe("failed");
    expect(deps.postSummary).not.toHaveBeenCalled();
    expect(out.notification_emitted).toBe(true);
  });

  it("summary JE failure flips status to partial but doesn't undo mirrors", async () => {
    const sb = makeSupabase();
    const deps = makeDeps({ failDomain: "summary" });
    const out = await runNightlyMirror(sb, { mirror_date: MD, deps });
    // All 3 mirrors succeeded.
    expect(out.ar.status).toBe("complete");
    expect(out.ap.status).toBe("complete");
    expect(out.inventory.status).toBe("complete");
    // But summary failed → overall partial.
    expect(out.summary_jes.status).toBe("failed");
    expect(out.status).toBe("partial");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mirror_date handling
// ─────────────────────────────────────────────────────────────────────────────

describe("runNightlyMirror — mirror_date", () => {
  it("uses provided mirror_date verbatim", async () => {
    const sb = makeSupabase();
    const deps = makeDeps();
    await runNightlyMirror(sb, { mirror_date: "2026-01-15", deps });
    expect(deps.mirrorAr).toHaveBeenCalledWith(sb, "ent-1", "2026-01-15");
  });

  it("defaults to yesterday-UTC when omitted", async () => {
    const sb = makeSupabase();
    const deps = makeDeps();
    const expected = defaultMirrorDate();
    const out = await runNightlyMirror(sb, { deps });
    expect(out.mirror_date).toBe(expected);
  });

  it("rejects malformed mirror_date", async () => {
    const sb = makeSupabase();
    const deps = makeDeps();
    await expect(
      runNightlyMirror(sb, { mirror_date: "yesterday", deps })
    ).rejects.toThrow(/YYYY-MM-DD/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Entity handling + row-insert failures + enqueue robustness
// ─────────────────────────────────────────────────────────────────────────────

describe("runNightlyMirror — entity + row-insert + enqueue", () => {
  it("throws when default ROF entity is missing", async () => {
    const sb = makeSupabase({ entities: [] });
    const deps = makeDeps();
    await expect(
      runNightlyMirror(sb, { mirror_date: MD, deps })
    ).rejects.toThrow(/ROF.*not found/);
  });

  it("throws when entity_id_override doesn't match", async () => {
    const sb = makeSupabase({ entities: [{ id: "ent-1", code: "ROF" }] });
    const deps = makeDeps();
    await expect(
      runNightlyMirror(sb, { mirror_date: MD, entity_id_override: "ent-bogus", deps })
    ).rejects.toThrow(/not found/);
  });

  it("records run_row_open_failed when xoro_mirror_runs insert fails for a domain", async () => {
    const sb = makeSupabase({ insertFailDomains: new Set(["ap"]) });
    const deps = makeDeps();
    const out = await runNightlyMirror(sb, { mirror_date: MD, deps });
    expect(out.ap.status).toBe("failed");
    expect(out.ap.errors[0].kind).toBe("run_row_open_failed");
    // ar+inventory still ran.
    expect(out.ar.status).toBe("complete");
    expect(out.inventory.status).toBe("complete");
    // Summary skipped because AP failed.
    expect(out.summary_jes.skipped).toBeTruthy();
  });

  it("enqueue throwing doesn't crash the orchestrator", async () => {
    const sb = makeSupabase();
    const deps = makeDeps({
      enqueueImpl: vi.fn().mockRejectedValue(new Error("notif-bus-down")),
    });
    const out = await runNightlyMirror(sb, { mirror_date: MD, deps });
    expect(out.status).toBe("complete");
    expect(out.notification_emitted).toBe(false);
    expect(out.notification_error).toBe("notif-bus-down");
  });
});
