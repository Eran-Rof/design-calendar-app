// computeSizeCollapse — the shared empty-size-column collapse model used by both
// the editable SO/PO grid and the read-only Inventory Matrix.

import { describe, it, expect } from "vitest";
import { computeSizeCollapse } from "../sizeCollapse";

const sizes = ["XS", "S", "M", "L", "XL"];

describe("computeSizeCollapse", () => {
  it("does not collapse when disabled or when there are no quantities", () => {
    const disabled = computeSizeCollapse(sizes, { M: 5 }, { enabled: false, collapsed: true });
    expect(disabled.visibleSizes).toEqual(sizes);
    expect(disabled.canToggle).toBe(false);

    const noQty = computeSizeCollapse(sizes, {}, { enabled: true, collapsed: true });
    expect(noQty.hasQty).toBe(false);
    expect(noQty.visibleSizes).toEqual(sizes);
    expect(noQty.canToggle).toBe(false);
  });

  it("flags green (hasQty) but is not collapsible when every filled column is at the edges span", () => {
    // Qty on XS and XL only → no leading/trailing empties → nothing to collapse,
    // but hasQty drives the green first-column highlight.
    const m = computeSizeCollapse(sizes, { XS: 1, XL: 1 }, { enabled: true, collapsed: false });
    expect(m.hasQty).toBe(true);
    expect(m.canCollapse).toBe(false);
    expect(m.canToggle).toBe(false);
    expect(m.visibleSizes).toEqual(sizes);
  });

  it("hides leading/trailing all-zero columns while keeping mid-range zeros", () => {
    // Qty on S and XL → leading XS hidden, trailing none; mid M/L kept.
    const collapsible = computeSizeCollapse(sizes, { S: 3, XL: 2 }, { enabled: true, collapsed: false });
    expect(collapsible.canCollapse).toBe(true);
    expect(collapsible.canToggle).toBe(true);
    // Not collapsed yet → all sizes visible.
    expect(collapsible.visibleSizes).toEqual(sizes);

    const collapsed = computeSizeCollapse(sizes, { S: 3, XL: 2 }, { enabled: true, collapsed: true });
    expect(collapsed.collapsedActive).toBe(true);
    expect(collapsed.visibleSizes).toEqual(["S", "M", "L", "XL"]); // XS dropped, mid kept
    expect(collapsed.hiddenLeading).toBe(1);
    expect(collapsed.hiddenTrailing).toBe(0);
  });

  it("hides BOTH leading and trailing empties around the stocked range (mid zeros kept)", () => {
    // Qty on S and L only → leading XS + trailing XL both hidden, mid M kept.
    // This is the common PO / Inventory-matrix case the green header collapses.
    const model = computeSizeCollapse(sizes, { S: 4, L: 6 }, { enabled: true, collapsed: true });
    expect(model.hasQty).toBe(true);
    expect(model.canToggle).toBe(true);
    expect(model.collapsedActive).toBe(true);
    expect(model.visibleSizes).toEqual(["S", "M", "L"]); // XS + XL dropped, mid M kept
    expect(model.hiddenLeading).toBe(1);
    expect(model.hiddenTrailing).toBe(1);
  });
});
