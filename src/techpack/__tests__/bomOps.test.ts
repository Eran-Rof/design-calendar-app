// Tests for the BOM and sketch-callout pure data ops. The renderers
// in TechPack.tsx delegate every list mutation to these helpers, so
// changes to "what fields a fresh BOM item or a fresh color-spec
// gets" need to come through here. Anything that touches state setters
// (updateSelected, prompts) stays in the component.

import { describe, it, expect } from "vitest";
import {
  createColorway,
  addColorwayToBOM,
  removeColorwayFromBOM,
  createBOMItem,
  updateColorSpecOnBOM,
  addSketchCallout,
  updateSketchCallout,
  removeSketchCallout,
  sortCalloutsByNumber,
  nextCalloutNumber,
} from "../bomOps";
import type { BOMItem, Colorway, SketchCallout } from "../types";

function bom(over: Partial<BOMItem> = {}): BOMItem {
  return {
    id: "x", materialNo: "", material: "", placement: "", content: "",
    weight: "", quantity: "", uom: "YDS", supplier: "", unitCost: 0,
    totalCost: 0, notes: "", image: null, colorSpecs: [], ...over,
  };
}

// ────────────────────────────────────────────────────────────────────────

describe("createColorway", () => {
  it("uppercases + trims the name", () => {
    const cw = createColorway("  blacksands  ");
    expect(cw.name).toBe("BLACKSANDS");
  });

  it("assigns a non-empty id", () => {
    expect(createColorway("RED").id).toBeTruthy();
  });
});

describe("addColorwayToBOM", () => {
  it("appends a blank color spec to every BOM item", () => {
    const initial = [bom({ id: "a" }), bom({ id: "b", colorSpecs: [{ colorwayId: "old", color: "Red", pantone: "", trialSize: "" }] })];
    const out = addColorwayToBOM(initial, "cw-1");
    expect(out[0].colorSpecs).toEqual([{ colorwayId: "cw-1", color: "", pantone: "", trialSize: "" }]);
    expect(out[1].colorSpecs).toHaveLength(2);
    expect(out[1].colorSpecs?.[1]).toEqual({ colorwayId: "cw-1", color: "", pantone: "", trialSize: "" });
    // existing specs preserved
    expect(out[1].colorSpecs?.[0]).toEqual({ colorwayId: "old", color: "Red", pantone: "", trialSize: "" });
  });

  it("handles items with undefined colorSpecs", () => {
    const b = bom();
    delete (b as any).colorSpecs;
    const out = addColorwayToBOM([b], "cw-1");
    expect(out[0].colorSpecs).toHaveLength(1);
  });

  it("does not mutate the input array or items", () => {
    const initial = [bom({ id: "a", colorSpecs: [] })];
    const snap = JSON.parse(JSON.stringify(initial));
    addColorwayToBOM(initial, "cw-1");
    expect(initial).toEqual(snap);
  });
});

describe("removeColorwayFromBOM", () => {
  it("drops only the matching colorwayId from every item", () => {
    const initial = [bom({
      colorSpecs: [
        { colorwayId: "a", color: "Red", pantone: "", trialSize: "" },
        { colorwayId: "b", color: "Blue", pantone: "", trialSize: "" },
      ],
    })];
    const out = removeColorwayFromBOM(initial, "a");
    expect(out[0].colorSpecs).toEqual([{ colorwayId: "b", color: "Blue", pantone: "", trialSize: "" }]);
  });

  it("leaves items with no matching spec untouched", () => {
    const initial = [bom({ colorSpecs: [{ colorwayId: "other", color: "x", pantone: "", trialSize: "" }] })];
    const out = removeColorwayFromBOM(initial, "missing");
    expect(out[0].colorSpecs).toEqual(initial[0].colorSpecs);
  });
});

describe("createBOMItem", () => {
  it("seeds one blank color-spec per colorway", () => {
    const cws: Colorway[] = [{ id: "cw1", name: "RED" }, { id: "cw2", name: "BLUE" }];
    const item = createBOMItem(cws);
    expect(item.colorSpecs).toEqual([
      { colorwayId: "cw1", color: "", pantone: "", trialSize: "" },
      { colorwayId: "cw2", color: "", pantone: "", trialSize: "" },
    ]);
  });

  it("returns a fresh BOMItem with default numeric/string fields zeroed", () => {
    const item = createBOMItem([]);
    expect(item.unitCost).toBe(0);
    expect(item.totalCost).toBe(0);
    expect(item.uom).toBe("YDS");
    expect(item.image).toBeNull();
    expect(item.id).toBeTruthy();
  });
});

describe("updateColorSpecOnBOM", () => {
  it("merges changes into an existing spec entry", () => {
    const initial = [bom({ colorSpecs: [{ colorwayId: "cw1", color: "Red", pantone: "18-1763", trialSize: "M" }] })];
    const out = updateColorSpecOnBOM(initial, 0, "cw1", { color: "Crimson" });
    expect(out[0].colorSpecs?.[0]).toEqual({ colorwayId: "cw1", color: "Crimson", pantone: "18-1763", trialSize: "M" });
  });

  it("appends a fresh spec if the colorway didn't exist on that item yet", () => {
    const initial = [bom({ colorSpecs: [] })];
    const out = updateColorSpecOnBOM(initial, 0, "cw1", { color: "Green" });
    expect(out[0].colorSpecs).toEqual([{ colorwayId: "cw1", color: "Green", pantone: "", trialSize: "" }]);
  });

  it("only modifies the targeted bomIdx", () => {
    const initial = [
      bom({ id: "a", colorSpecs: [{ colorwayId: "cw1", color: "Red", pantone: "", trialSize: "" }] }),
      bom({ id: "b", colorSpecs: [{ colorwayId: "cw1", color: "Red", pantone: "", trialSize: "" }] }),
    ];
    const out = updateColorSpecOnBOM(initial, 1, "cw1", { color: "Blue" });
    expect(out[0].colorSpecs?.[0].color).toBe("Red"); // first untouched
    expect(out[1].colorSpecs?.[0].color).toBe("Blue");
  });
});

// ────────────────────────────────────────────────────────────────────────

function co(over: Partial<SketchCallout> = {}): SketchCallout {
  return { id: "x", number: 1, description: "", ...over };
}

describe("nextCalloutNumber", () => {
  it("returns 1 on an empty list", () => {
    expect(nextCalloutNumber([])).toBe(1);
  });

  it("returns max + 1", () => {
    expect(nextCalloutNumber([co({ number: 2 }), co({ number: 7 }), co({ number: 4 })])).toBe(8);
  });
});

describe("addSketchCallout", () => {
  it("appends with the next sequential number", () => {
    const out = addSketchCallout([co({ number: 3 })]);
    expect(out).toHaveLength(2);
    expect(out[1].number).toBe(4);
    expect(out[1].description).toBe("");
  });

  it("starts at 1 when empty", () => {
    const out = addSketchCallout([]);
    expect(out[0].number).toBe(1);
  });
});

describe("updateSketchCallout", () => {
  it("merges changes into the matching callout only", () => {
    const initial = [co({ id: "a", number: 1, description: "hem" }), co({ id: "b", number: 2 })];
    const out = updateSketchCallout(initial, "b", { description: "stitch" });
    expect(out[0].description).toBe("hem");
    expect(out[1].description).toBe("stitch");
  });

  it("returns input as-is when id does not match", () => {
    const initial = [co({ id: "a" })];
    const out = updateSketchCallout(initial, "missing", { description: "x" });
    expect(out[0]).toEqual(initial[0]);
  });
});

describe("removeSketchCallout", () => {
  it("filters out the matching id", () => {
    const initial = [co({ id: "a" }), co({ id: "b" }), co({ id: "c" })];
    expect(removeSketchCallout(initial, "b").map(c => c.id)).toEqual(["a", "c"]);
  });
});

describe("sortCalloutsByNumber", () => {
  it("sorts ascending by number, returns a new array", () => {
    const initial = [co({ number: 5 }), co({ number: 1 }), co({ number: 3 })];
    const out = sortCalloutsByNumber(initial);
    expect(out.map(c => c.number)).toEqual([1, 3, 5]);
    expect(initial.map(c => c.number)).toEqual([5, 1, 3]); // input untouched
  });
});
