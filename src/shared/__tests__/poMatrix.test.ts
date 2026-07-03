import { describe, it, expect } from "vitest";
import { buildPoMatrix } from "../poMatrix";

const line = (ItemNumber: string, QtyOrder = 10) => ({
  ItemNumber, QtyOrder, QtyReceived: 0, QtyRemaining: QtyOrder, UnitPrice: 5, Description: "d", StatusName: "Released",
});

describe("buildPoMatrix — ItemNumber parsing", () => {
  it("parses a trailing-dash ItemNumber into color+size (not empty size)", () => {
    // "PTYT0023C-Glacier-SML-" used to mis-parse as color "Glacier-SML" / size "" ->
    // fell out of the size matrix (non-matrix row). Trailing dash is now stripped.
    const m = buildPoMatrix([line("PTYT0023C-Glacier-SML-"), line("PTYT0023C-Falcon-LRG-")]);
    const row = m.byBase["PTYT0023C"].find((r) => r.color === "Glacier");
    expect(row).toBeTruthy();
    expect(Object.keys(row!.sizes)).not.toContain(""); // no empty-size bucket
    // the qty landed on a real size column (SML→normalized), and SML is in sizeOrder
    expect(m.sizeOrder.length).toBeGreaterThan(0);
    expect(m.byBase["PTYT0023C"].some((r) => r.color === "Falcon")).toBe(true);
  });

  it("still parses normal 3-part and space-in-color ItemNumbers", () => {
    const m = buildPoMatrix([line("PTYT0023C-Black-SML"), line("PTYT0091C-Blue Fog Topography-MED")]);
    expect(m.byBase["PTYT0023C"].some((r) => r.color === "Black")).toBe(true);
    expect(m.byBase["PTYT0091C"].some((r) => r.color === "Blue Fog Topography")).toBe(true);
  });

  it("preserves genuine dashed two-word colors (no trailing dash)", () => {
    const m = buildPoMatrix([line("STYLE-Blue-Green-30")]);
    expect(m.byBase["STYLE"][0].color).toBe("Blue-Green");
    expect(m.byBase["STYLE"][0].sizes["30"]).toBe(10);
  });
});
