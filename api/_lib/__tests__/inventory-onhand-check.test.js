// Tests for the inventory on-hand accuracy alert gate
// (api/_handlers/cron/inventory-onhand-check.js).
//
// Focus: the 2026-07-21 change — while the REST by-size baseline
// (tangerine_size_onhand) is frozen (its ingest is paused until the Xoro
// cutover), the recurring $-divergence email is suppressed because it only
// measures live layers against a stale photo; negative on-hand still alerts.

import { describe, it, expect } from "vitest";
import { shouldAlert, isBaselineStale } from "../../_handlers/cron/inventory-onhand-check.js";

// A summary generated "today" against a baseline captured `agoDays` earlier.
function summary(overrides = {}, agoDays = 0) {
  const gen = Date.parse("2026-07-21T07:30:00Z");
  const snap = new Date(gen - agoDays * 86400000).toISOString().slice(0, 10);
  return {
    generated_at: new Date(gen).toISOString(),
    rest_snapshot_date: snap,
    exposure_cents: 0,
    skus_phantom: 0,
    negative_skus: 0,
    ...overrides,
  };
}

describe("isBaselineStale", () => {
  it("fresh baseline (same day) is not stale", () => {
    expect(isBaselineStale(summary({}, 0))).toBe(false);
  });
  it("6-day-old baseline is stale at the 2-day default", () => {
    expect(isBaselineStale(summary({}, 6))).toBe(true);
  });
  it("respects an explicit maxAgeDays", () => {
    expect(isBaselineStale(summary({}, 6), 10)).toBe(false);
  });
  it("uses the server-side generated_at, not the local clock", () => {
    // Baseline 2026-07-15, generated 2026-07-21 → 6 days regardless of when this runs.
    const s = { generated_at: "2026-07-21T07:30:00Z", rest_snapshot_date: "2026-07-15" };
    expect(isBaselineStale(s, 2)).toBe(true);
  });
  it("no baseline at all is never 'stale' (so a missing feed still surfaces)", () => {
    expect(isBaselineStale({ generated_at: "2026-07-21T07:30:00Z" })).toBe(false);
    expect(isBaselineStale({ rest_snapshot_date: null })).toBe(false);
  });
});

describe("shouldAlert with a stale baseline", () => {
  it("suppresses a material $-exposure divergence when the baseline is stale", () => {
    const s = summary({ exposure_cents: 47134206, skus_phantom: 25 }, 6);
    expect(shouldAlert(s)).toBe(false);
  });
  it("still fires the same divergence once the baseline is fresh", () => {
    const s = summary({ exposure_cents: 47134206, skus_phantom: 25 }, 0);
    expect(shouldAlert(s)).toBe(true);
  });
  it("negative on-hand breaks through even with a stale baseline", () => {
    const s = summary({ negative_skus: 3 }, 6);
    expect(shouldAlert(s)).toBe(true);
  });
  it("honours an explicitly-passed baselineStale flag over recomputation", () => {
    const s = summary({ exposure_cents: 99999999 }, 0); // fresh by date…
    expect(shouldAlert(s, undefined, { baselineStale: true })).toBe(false); // …but caller says stale
  });
  it("below-threshold, non-phantom, non-negative never alerts (fresh or stale)", () => {
    expect(shouldAlert(summary({ exposure_cents: 100 }, 0))).toBe(false);
    expect(shouldAlert(summary({ exposure_cents: 100 }, 6))).toBe(false);
  });
});
