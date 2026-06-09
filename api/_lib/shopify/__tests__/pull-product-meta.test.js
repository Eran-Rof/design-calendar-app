import { describe, it, expect } from "vitest";
import { htmlToText, tagsToArray, buildImageColorMap } from "../pull-product-meta.js";

describe("htmlToText", () => {
  it("strips tags + decodes entities + collapses whitespace", () => {
    expect(htmlToText("<p>Hello&nbsp;<b>World</b></p>\n<p>Two</p>")).toBe("Hello World Two");
    expect(htmlToText("a &amp; b")).toBe("a & b");
    expect(htmlToText("")).toBe("");
    expect(htmlToText(null)).toBe("");
  });
});

describe("tagsToArray", () => {
  it("splits comma string", () => {
    expect(tagsToArray("a, b ,c")).toEqual(["a", "b", "c"]);
  });
  it("passes arrays / handles empty", () => {
    expect(tagsToArray(["x", "y"])).toEqual(["x", "y"]);
    expect(tagsToArray("")).toEqual([]);
    expect(tagsToArray(null)).toEqual([]);
  });
});

describe("buildImageColorMap", () => {
  const product = {
    options: [{ name: "Color", values: ["Charcoal", "Khaki"] }, { name: "Size", values: ["SML", "MED"] }],
    variants: [
      { sku: "X-Charcoal-SML", option1: "Charcoal", option2: "SML", image_id: 111 },
      { sku: "X-Charcoal-MED", option1: "Charcoal", option2: "MED", image_id: 111 },
      { sku: "X-Khaki-SML", option1: "Khaki", option2: "SML", image_id: 222 },
      { sku: "X-Khaki-MED", option1: "Khaki", option2: "MED", image_id: null },
    ],
  };
  it("maps image_id → color via the Color option position", () => {
    const m = buildImageColorMap(product);
    expect(m.get("111")).toBe("Charcoal");
    expect(m.get("222")).toBe("Khaki");
    expect(m.size).toBe(2);
  });
  it("uses option2 when Color is the second option", () => {
    const p2 = { options: [{ name: "Size" }, { name: "Color" }], variants: [{ option1: "SML", option2: "Navy", image_id: 9 }] };
    expect(buildImageColorMap(p2).get("9")).toBe("Navy");
  });
  it("empty when there is no Color option", () => {
    expect(buildImageColorMap({ options: [{ name: "Size" }], variants: [{ option1: "SML", image_id: 1 }] }).size).toBe(0);
  });
});
