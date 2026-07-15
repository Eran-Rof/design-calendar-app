import { describe, it, expect } from "vitest";
import { evaluateFreshness, FEED_CHECKS } from "../dataFreshness.js";

const H = 3_600_000;
// A fixed "now" so the test is deterministic.
const NOW = Date.parse("2026-07-15T12:00:00Z");

describe("evaluateFreshness", () => {
  it("flags a feed stale when its newest row is older than its threshold", () => {
    const checks = [
      { key: "onhand", label: "On-hand", table: "t", col: "snapshot_date", dateOnly: true, maxAgeHours: 40 },
    ];
    // 2026-07-13 = ~60h before 2026-07-15T12:00Z → stale (>40h).
    const r = evaluateFreshness({ onhand: "2026-07-13" }, NOW, checks);
    expect(r.any_stale).toBe(true);
    expect(r.feeds[0].stale).toBe(true);
    expect(r.feeds[0].age_hours).toBeGreaterThan(40);
  });

  it("passes a fresh feed and computes age from a timestamp", () => {
    const checks = [{ key: "layers", label: "Layers", table: "t", col: "created_at", maxAgeHours: 40 }];
    const r = evaluateFreshness({ layers: "2026-07-15T02:00:00Z" }, NOW, checks); // 10h old
    expect(r.any_stale).toBe(false);
    expect(r.feeds[0].stale).toBe(false);
    expect(r.feeds[0].age_hours).toBeCloseTo(10, 1);
  });

  it("treats a missing feed (no rows) as stale with reason", () => {
    const checks = [{ key: "sales", label: "Sales", table: "t", col: "created_at", maxAgeHours: 48 }];
    const r = evaluateFreshness({ sales: null }, NOW, checks);
    expect(r.feeds[0]).toMatchObject({ stale: true, latest: null, reason: "no rows" });
    expect(r.stale_count).toBe(1);
  });

  it("caught the real bug: a Jul-1 on-hand snapshot is stale on Jul 15", () => {
    // The orphaned tangerine_size_onhand froze at 2026-07-01; against a mid-July
    // now it must read STALE (this is exactly the 'green while stale' gap).
    const r = evaluateFreshness({ onhand_planning: "2026-07-01" }, NOW,
      [FEED_CHECKS.find((c) => c.key === "onhand_planning")]);
    expect(r.feeds[0].stale).toBe(true);
    expect(r.feeds[0].age_hours).toBeGreaterThan(40 * 7); // way past threshold
  });

  it("all-fresh feeds → any_stale false", () => {
    const nowIso = new Date(NOW - 2 * H).toISOString();
    const latest = Object.fromEntries(FEED_CHECKS.map((c) => [c.key, nowIso]));
    expect(evaluateFreshness(latest, NOW).any_stale).toBe(false);
  });
});
