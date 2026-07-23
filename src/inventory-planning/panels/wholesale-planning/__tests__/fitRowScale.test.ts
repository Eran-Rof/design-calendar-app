import { describe, it, expect } from "vitest";
import { nextFitScale, clampScale, scaled, MIN_FIT_SCALE, FIT_SCALE_DEADBAND } from "../fitRowScale";

describe("clampScale", () => {
  it("never exceeds 1 (fields don't grow past natural size)", () => {
    expect(clampScale(1.4)).toBe(1);
  });
  it("never goes below the CEO's 15% floor", () => {
    expect(clampScale(0.2)).toBe(MIN_FIT_SCALE);
    expect(MIN_FIT_SCALE).toBe(0.85);
  });
  it("passes through values inside the band", () => {
    expect(clampScale(0.92)).toBeCloseTo(0.92);
  });
  it("guards non-finite input", () => {
    expect(clampScale(NaN)).toBe(1);
  });
});

describe("nextFitScale", () => {
  it("shrinks when the row overflows", () => {
    // occupying 1200 in 1000 of space → needs ~0.833, floored to 0.85
    expect(nextFitScale({ occupied: 1200, available: 1000, currentScale: 1 })).toBe(MIN_FIT_SCALE);
  });

  it("shrinks proportionally when a mild overflow stays above the floor", () => {
    // 1050 in 1000 → 0.952
    const s = nextFitScale({ occupied: 1050, available: 1000, currentScale: 1 });
    expect(s).toBeCloseTo(0.952, 2);
  });

  it("grows back toward 1 when the window widens", () => {
    // currently shrunk to 0.85, now only occupying 900 of 1400 available
    const s = nextFitScale({ occupied: 900, available: 1400, currentScale: 0.85 });
    expect(s).toBe(1); // clamped — never past natural size
  });

  it("returns null inside the dead-band (prevents oscillation)", () => {
    // occupied ~= available → ideal ~= currentScale
    expect(nextFitScale({ occupied: 1000, available: 1005, currentScale: 1 })).toBeNull();
  });

  it("dead-band is respected symmetrically when already shrunk", () => {
    // 0.90 * (1000/1000) = 0.90 → no change
    expect(nextFitScale({ occupied: 1000, available: 1000, currentScale: 0.9 })).toBeNull();
  });

  it("a change just beyond the dead-band is applied", () => {
    const s = nextFitScale({ occupied: 1000, available: 940, currentScale: 1 });
    expect(s).not.toBeNull();
    expect(1 - (s as number)).toBeGreaterThan(FIT_SCALE_DEADBAND);
  });

  it("iterating converges (measure → shrink → re-measure)", () => {
    // Simulate: natural width 1200, available 1000. Occupied scales with the
    // applied scale. Should settle at/above the floor and stop changing.
    const NATURAL = 1200, AVAIL = 1000;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      const occupied = NATURAL * scale;
      const next = nextFitScale({ occupied, available: AVAIL, currentScale: scale });
      if (next === null) break;
      scale = next;
    }
    expect(scale).toBe(MIN_FIT_SCALE); // can't fit 1200 in 1000 within 15%
    // and it is stable — one more pass makes no change
    expect(nextFitScale({ occupied: NATURAL * scale, available: AVAIL, currentScale: scale })).toBeNull();
  });

  it("converges to an exact fit when the overflow is within 15%", () => {
    const NATURAL = 1080, AVAIL = 1000;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      const occupied = NATURAL * scale;
      const next = nextFitScale({ occupied, available: AVAIL, currentScale: scale });
      if (next === null) break;
      scale = next;
    }
    expect(NATURAL * scale).toBeLessThanOrEqual(AVAIL + 1);
    expect(scale).toBeGreaterThan(MIN_FIT_SCALE);
  });

  it("guards zero / negative measurements", () => {
    expect(nextFitScale({ occupied: 0, available: 1000, currentScale: 1 })).toBeNull();
    expect(nextFitScale({ occupied: 1000, available: 0, currentScale: 1 })).toBeNull();
  });
});

describe("scaled", () => {
  it("scales and rounds, flooring at 1px", () => {
    expect(scaled(130, 0.85)).toBe(111);
    expect(scaled(130, 1)).toBe(130);
    expect(scaled(0.2, 0.85)).toBe(1);
  });
});
