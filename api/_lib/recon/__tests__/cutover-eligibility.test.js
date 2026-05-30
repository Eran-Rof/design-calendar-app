// Tangerine P9-9 — tests for the cutover-eligibility computation.
//
// Covers:
//   - daysAgoISO + todayISO pure helpers
//   - computeCutoverEligibility happy path, threshold + recent-window
//     boundaries, mixed-status rejection, error path, missing source_tag
//   - verifyAllDomainsEligible bulk check
//   - input validation (bad entity_id / domain / source_tag)

import { describe, it, expect } from "vitest";
import {
  computeCutoverEligibility,
  verifyAllDomainsEligible,
  daysAgoISO,
  todayISO,
  CLEAN_RUN_FLOOR,
  CLEAN_WINDOW_DAYS,
  RECENT_RUN_HORIZON_DAYS,
  RECON_DOMAINS,
} from "../cutover-eligibility.js";

const ENTITY = "00000000-0000-0000-0000-0000000000a1";
const BAD_UUID = "not-a-uuid";

// ────────────────────────────────────────────────────────────────────────
// Supabase double: returns the canned recon_runs rows for the matching
// (entity, domain, run_date BETWEEN start AND end) query.
// ────────────────────────────────────────────────────────────────────────
function makeAdmin({ rows = [], error = null } = {}) {
  return {
    from(table) {
      if (table !== "recon_runs") throw new Error(`unexpected table: ${table}`);
      const state = { filters: [] };
      const chain = {
        select() { return chain; },
        eq(col, val) { state.filters.push(["eq", col, val]); return chain; },
        gte(col, val) { state.filters.push(["gte", col, val]); return chain; },
        lte(col, val) { state.filters.push(["lte", col, val]); return chain; },
        order() { return chain; },
        then(resolve) {
          if (error) return resolve({ data: null, error });
          // Filter rows according to applied filters so each domain call
          // returns only matching rows. We skip entity_id since the test
          // fixtures don't stamp it (the chain still pretends it was
          // honored — every row in the fixture belongs to the test
          // entity by construction).
          let out = rows;
          for (const [op, col, val] of state.filters) {
            if (col === "entity_id") continue;
            out = out.filter((r) => {
              const cell = r[col];
              if (op === "eq") return cell === val;
              if (op === "gte") return cell >= val;
              if (op === "lte") return cell <= val;
              return true;
            });
          }
          return resolve({ data: out, error: null });
        },
      };
      return chain;
    },
  };
}

// Build N clean runs evenly spaced from `daysAgo` (oldest) to today.
function buildCleanRuns(domain, n, opts = {}) {
  const now = opts.now || new Date("2026-05-29T00:00:00Z");
  const spreadDays = opts.spreadDays ?? 56; // 8 weeks
  const out = [];
  for (let i = 0; i < n; i++) {
    const offset = spreadDays - Math.floor((i * spreadDays) / Math.max(n - 1, 1));
    out.push({
      id: `r-${domain}-${i}`,
      domain,
      status: "clean",
      run_date: daysAgoISO(offset, now),
      period_start: daysAgoISO(offset + 7, now),
      period_end: daysAgoISO(offset, now),
      completed_at: new Date(now.getTime() - offset * 86400000).toISOString(),
    });
  }
  return out;
}

const FIXED_NOW = new Date("2026-05-29T00:00:00Z");

// ────────────────────────────────────────────────────────────────────────
describe("daysAgoISO / todayISO", () => {
  it("today is YYYY-MM-DD", () => {
    expect(todayISO(FIXED_NOW)).toBe("2026-05-29");
  });

  it("days ago math", () => {
    expect(daysAgoISO(60, FIXED_NOW)).toBe("2026-03-30");
    expect(daysAgoISO(0, FIXED_NOW)).toBe("2026-05-29");
    expect(daysAgoISO(1, FIXED_NOW)).toBe("2026-05-28");
  });

  it("RECON_DOMAINS frozen list", () => {
    expect(RECON_DOMAINS).toEqual(["ap", "ar", "cash", "gl", "inventory"]);
  });

  it("constants are non-zero", () => {
    expect(CLEAN_RUN_FLOOR).toBeGreaterThan(0);
    expect(CLEAN_WINDOW_DAYS).toBeGreaterThan(0);
    expect(RECENT_RUN_HORIZON_DAYS).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
describe("computeCutoverEligibility input validation", () => {
  it("rejects missing adminClient", async () => {
    const v = await computeCutoverEligibility({
      adminClient: null, entity_id: ENTITY, domain: "ap",
    });
    expect(v.eligible).toBe(false);
    expect(v.reason).toMatch(/adminClient/);
  });

  it("rejects bad entity_id", async () => {
    const admin = makeAdmin({ rows: [] });
    const v = await computeCutoverEligibility({
      adminClient: admin, entity_id: BAD_UUID, domain: "ap",
    });
    expect(v.eligible).toBe(false);
    expect(v.reason).toMatch(/entity_id/);
  });

  it("rejects bad domain", async () => {
    const admin = makeAdmin({ rows: [] });
    const v = await computeCutoverEligibility({
      adminClient: admin, entity_id: ENTITY, domain: "bogus",
    });
    expect(v.eligible).toBe(false);
    expect(v.reason).toMatch(/domain must be one of/);
  });

  it("rejects non-string source_tag", async () => {
    const admin = makeAdmin({ rows: [] });
    const v = await computeCutoverEligibility({
      adminClient: admin, entity_id: ENTITY, domain: "ar", source_tag: 42,
    });
    expect(v.eligible).toBe(false);
    expect(v.reason).toMatch(/source_tag must be a string/);
  });
});

// ────────────────────────────────────────────────────────────────────────
describe("computeCutoverEligibility — clean-window boundary", () => {
  it("eligible when ≥ floor clean runs cover the window with a recent run", async () => {
    const admin = makeAdmin({
      rows: buildCleanRuns("ap", CLEAN_RUN_FLOOR, { now: FIXED_NOW, spreadDays: 56 }),
    });
    const v = await computeCutoverEligibility({
      adminClient: admin, entity_id: ENTITY, domain: "ap", now: FIXED_NOW,
    });
    expect(v.eligible).toBe(true);
    expect(v.clean_runs_count).toBe(CLEAN_RUN_FLOOR);
    expect(v.has_recent_clean_run).toBe(true);
    expect(v.has_unresolved_variances).toBe(false);
  });

  it("ineligible at floor - 1 clean runs", async () => {
    const admin = makeAdmin({
      rows: buildCleanRuns("ap", CLEAN_RUN_FLOOR - 1, { now: FIXED_NOW }),
    });
    const v = await computeCutoverEligibility({
      adminClient: admin, entity_id: ENTITY, domain: "ap", now: FIXED_NOW,
    });
    expect(v.eligible).toBe(false);
    expect(v.reason).toMatch(/Need at least/);
    expect(v.clean_runs_count).toBe(CLEAN_RUN_FLOOR - 1);
  });

  it("returns the computed clean_window_start + clean_window_end on every verdict", async () => {
    const admin = makeAdmin({ rows: [] });
    const v = await computeCutoverEligibility({
      adminClient: admin, entity_id: ENTITY, domain: "ap", now: FIXED_NOW,
    });
    expect(v.clean_window_start).toBe(daysAgoISO(CLEAN_WINDOW_DAYS, FIXED_NOW));
    expect(v.clean_window_end).toBe("2026-05-29");
  });
});

// ────────────────────────────────────────────────────────────────────────
describe("computeCutoverEligibility — recent-run boundary", () => {
  it("ineligible if most recent clean run is older than RECENT_RUN_HORIZON_DAYS", async () => {
    // Spread runs from day 60 back to day 30 — newest is day 30 which is
    // older than 8 days.
    const rows = buildCleanRuns("ar", CLEAN_RUN_FLOOR, { now: FIXED_NOW, spreadDays: 30 })
      .map((r, i) => ({ ...r, run_date: daysAgoISO(30 + (CLEAN_RUN_FLOOR - i) * 3, FIXED_NOW) }));
    const admin = makeAdmin({ rows });
    const v = await computeCutoverEligibility({
      adminClient: admin, entity_id: ENTITY, domain: "ar", now: FIXED_NOW,
    });
    expect(v.eligible).toBe(false);
    expect(v.reason).toMatch(/Most recent clean recon run/);
    expect(v.has_recent_clean_run).toBe(false);
  });

  it("eligible exactly at the horizon boundary (latest = horizon days ago)", async () => {
    const rows = buildCleanRuns("ar", CLEAN_RUN_FLOOR, { now: FIXED_NOW });
    // Force the latest run to be exactly RECENT_RUN_HORIZON_DAYS days ago.
    rows.sort((a, b) => a.run_date.localeCompare(b.run_date));
    rows[rows.length - 1].run_date = daysAgoISO(RECENT_RUN_HORIZON_DAYS, FIXED_NOW);
    const admin = makeAdmin({ rows });
    const v = await computeCutoverEligibility({
      adminClient: admin, entity_id: ENTITY, domain: "ar", now: FIXED_NOW,
    });
    expect(v.eligible).toBe(true);
    expect(v.has_recent_clean_run).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
describe("computeCutoverEligibility — unresolved variances reject signoff", () => {
  it("variance status in window → ineligible", async () => {
    const rows = buildCleanRuns("cash", CLEAN_RUN_FLOOR + 2, { now: FIXED_NOW });
    rows[3].status = "variance";
    const admin = makeAdmin({ rows });
    const v = await computeCutoverEligibility({
      adminClient: admin, entity_id: ENTITY, domain: "cash", now: FIXED_NOW,
    });
    expect(v.eligible).toBe(false);
    expect(v.has_unresolved_variances).toBe(true);
    expect(v.reason).toMatch(/non-clean recon run/);
  });

  it("error status in window → ineligible", async () => {
    const rows = buildCleanRuns("gl", CLEAN_RUN_FLOOR + 2, { now: FIXED_NOW });
    rows[5].status = "error";
    const admin = makeAdmin({ rows });
    const v = await computeCutoverEligibility({
      adminClient: admin, entity_id: ENTITY, domain: "gl", now: FIXED_NOW,
    });
    expect(v.eligible).toBe(false);
    expect(v.has_unresolved_variances).toBe(true);
  });

  it("running status in window → ineligible", async () => {
    const rows = buildCleanRuns("ap", CLEAN_RUN_FLOOR + 2, { now: FIXED_NOW });
    rows[2].status = "running";
    const admin = makeAdmin({ rows });
    const v = await computeCutoverEligibility({
      adminClient: admin, entity_id: ENTITY, domain: "ap", now: FIXED_NOW,
    });
    expect(v.eligible).toBe(false);
    expect(v.has_unresolved_variances).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
describe("computeCutoverEligibility — source_tag pass-through", () => {
  it("source_tag null is treated as whole-domain", async () => {
    const admin = makeAdmin({
      rows: buildCleanRuns("ar", CLEAN_RUN_FLOOR, { now: FIXED_NOW }),
    });
    const v = await computeCutoverEligibility({
      adminClient: admin, entity_id: ENTITY, domain: "ar", now: FIXED_NOW,
    });
    expect(v.eligible).toBe(true);
    expect(v.reason).not.toMatch(/\(/);
  });

  it("source_tag is reflected in the reason text", async () => {
    const admin = makeAdmin({
      rows: buildCleanRuns("ar", CLEAN_RUN_FLOOR, { now: FIXED_NOW }),
    });
    const v = await computeCutoverEligibility({
      adminClient: admin, entity_id: ENTITY, domain: "ar",
      source_tag: "shopify", now: FIXED_NOW,
    });
    expect(v.eligible).toBe(true);
    expect(v.reason).toMatch(/shopify/);
  });
});

// ────────────────────────────────────────────────────────────────────────
describe("computeCutoverEligibility — error paths", () => {
  it("db error becomes ineligible with reason carrying the message", async () => {
    const admin = makeAdmin({ error: { message: "kaboom" } });
    const v = await computeCutoverEligibility({
      adminClient: admin, entity_id: ENTITY, domain: "ap", now: FIXED_NOW,
    });
    expect(v.eligible).toBe(false);
    expect(v.reason).toMatch(/recon_runs read failed: kaboom/);
  });

  it("thrown error becomes ineligible with reason carrying the throw", async () => {
    const admin = {
      from() {
        throw new Error("conn closed");
      },
    };
    const v = await computeCutoverEligibility({
      adminClient: admin, entity_id: ENTITY, domain: "ap", now: FIXED_NOW,
    });
    expect(v.eligible).toBe(false);
    expect(v.reason).toMatch(/conn closed/);
  });

  it("zero runs in window is ineligible", async () => {
    const admin = makeAdmin({ rows: [] });
    const v = await computeCutoverEligibility({
      adminClient: admin, entity_id: ENTITY, domain: "inventory", now: FIXED_NOW,
    });
    expect(v.eligible).toBe(false);
    expect(v.clean_runs_count).toBe(0);
    expect(v.latest_clean_run_date).toBeNull();
    expect(v.oldest_clean_run_date).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
describe("verifyAllDomainsEligible — bulk check", () => {
  it("all 5 domains eligible → all_eligible true", async () => {
    const rows = [
      ...buildCleanRuns("ap", CLEAN_RUN_FLOOR, { now: FIXED_NOW }),
      ...buildCleanRuns("ar", CLEAN_RUN_FLOOR, { now: FIXED_NOW }),
      ...buildCleanRuns("cash", CLEAN_RUN_FLOOR, { now: FIXED_NOW }),
      ...buildCleanRuns("gl", CLEAN_RUN_FLOOR, { now: FIXED_NOW }),
      ...buildCleanRuns("inventory", CLEAN_RUN_FLOOR, { now: FIXED_NOW }),
    ];
    const admin = makeAdmin({ rows });
    const v = await verifyAllDomainsEligible({
      adminClient: admin, entity_id: ENTITY, now: FIXED_NOW,
    });
    expect(v.all_eligible).toBe(true);
    expect(v.eligible_domains).toEqual(RECON_DOMAINS);
    expect(v.ineligible_domains).toEqual([]);
    for (const d of RECON_DOMAINS) {
      expect(v.per_domain[d].eligible).toBe(true);
    }
  });

  it("one domain shy → all_eligible false + the rest still eligible", async () => {
    const rows = [
      ...buildCleanRuns("ap", CLEAN_RUN_FLOOR, { now: FIXED_NOW }),
      ...buildCleanRuns("ar", CLEAN_RUN_FLOOR - 3, { now: FIXED_NOW }), // shy
      ...buildCleanRuns("cash", CLEAN_RUN_FLOOR, { now: FIXED_NOW }),
      ...buildCleanRuns("gl", CLEAN_RUN_FLOOR, { now: FIXED_NOW }),
      ...buildCleanRuns("inventory", CLEAN_RUN_FLOOR, { now: FIXED_NOW }),
    ];
    const admin = makeAdmin({ rows });
    const v = await verifyAllDomainsEligible({
      adminClient: admin, entity_id: ENTITY, now: FIXED_NOW,
    });
    expect(v.all_eligible).toBe(false);
    expect(v.ineligible_domains).toContain("ar");
    expect(v.eligible_domains).toContain("ap");
    expect(v.eligible_domains).toContain("cash");
    expect(v.eligible_domains).toContain("gl");
    expect(v.eligible_domains).toContain("inventory");
  });

  it("empty DB → no domains eligible", async () => {
    const admin = makeAdmin({ rows: [] });
    const v = await verifyAllDomainsEligible({
      adminClient: admin, entity_id: ENTITY, now: FIXED_NOW,
    });
    expect(v.all_eligible).toBe(false);
    expect(v.eligible_domains).toEqual([]);
    expect(v.ineligible_domains).toEqual(RECON_DOMAINS);
  });
});
