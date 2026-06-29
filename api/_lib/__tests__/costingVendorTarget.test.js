import { describe, it, expect } from "vitest";
import { vendorTargetForMode } from "../costingVendorTarget.js";

describe("vendorTargetForMode", () => {
  it("DDP project → Tgt DDP cost (target_cost)", () => {
    expect(vendorTargetForMode(true, 12.5, 9.0)).toBe(12.5);
  });

  it("FOB project → FOB cost (fob_cost), not target_cost", () => {
    expect(vendorTargetForMode(false, 12.5, 9.0)).toBe(9.0);
  });

  it("FOB project with no fob_cost → falls back to target_cost", () => {
    expect(vendorTargetForMode(false, 12.5, null)).toBe(12.5);
    expect(vendorTargetForMode(false, 12.5, 0)).toBe(12.5);
  });

  it("DDP with no target_cost → null (does not borrow fob)", () => {
    expect(vendorTargetForMode(true, null, 9.0)).toBeNull();
  });

  it("nothing usable → null", () => {
    expect(vendorTargetForMode(false, null, null)).toBeNull();
    expect(vendorTargetForMode(false, 0, -1)).toBeNull();
  });
});
