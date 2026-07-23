// Positioning math for the MultiSelectDropdown popover. The regression this
// guards: a trigger near the viewport BOTTOM with a short option list (the
// gender filter) must open bottom-anchored just above the trigger — the old
// top = trigger.top − maxHeight put a 2-option panel ~250px away, mid-page,
// which read as "the dropdown didn't populate".

import { describe, it, expect } from "vitest";
import { computePopoverAnchor } from "../components/MultiSelectDropdown";

describe("computePopoverAnchor", () => {
  it("opens below the trigger when there is room", () => {
    const a = computePopoverAnchor({ top: 100, bottom: 130, left: 40, width: 150 }, 1600, 900);
    expect(a.top).toBe(134);          // trigger bottom + gap
    expect(a.bottom).toBeUndefined();
    expect(a.maxHeight).toBe(380);
  });

  it("flips ABOVE bottom-anchored when the trigger is near the viewport bottom", () => {
    // Trigger at y=881..905 in a 950px viewport (the gender filter row).
    const a = computePopoverAnchor({ top: 881, bottom: 905, left: 1200, width: 130 }, 1700, 950);
    expect(a.top).toBeUndefined();
    // Popover bottom sits just above the trigger: vh - trigger.top + gap.
    expect(a.bottom).toBe(950 - 881 + 4);
    expect(a.maxHeight).toBe(380);    // grows upward, capped
  });

  it("shifts left instead of overflowing the right edge", () => {
    const a = computePopoverAnchor({ top: 100, bottom: 130, left: 1500, width: 150 }, 1600, 900);
    expect(a.left).toBe(1600 - 260 - 8); // vw - popover width - pad
  });

  it("caps the min-width on tiny viewports", () => {
    const a = computePopoverAnchor({ top: 10, bottom: 40, left: 0, width: 100 }, 240, 400);
    expect(a.minWidth).toBe(240 - 16);
  });
});
