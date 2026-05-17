// Unit tests for the pure helpers extracted from GridView.tsx.
// Covers date normalisation across Xoro's inconsistent date strings,
// size-token detection (matters for grouping line items by style+color),
// and size sorting (XS / S / M / 32W / 34W etc).

import { describe, it, expect } from "vitest";
import {
  normDateISO,
  buildFixedColsTpl,
  buildColTpl,
  isSizeToken,
  styleColorKey,
  itemSizeLabel,
  sizeSort,
} from "../gridUtils";

describe("normDateISO", () => {
  it("passes through YYYY-MM-DD", () => {
    expect(normDateISO("2026-05-16")).toBe("2026-05-16");
  });
  it("strips time from ISO timestamps", () => {
    expect(normDateISO("2026-05-16T08:30:00")).toBe("2026-05-16");
    expect(normDateISO("2026-05-16T08:30:00Z")).toBe("2026-05-16");
  });
  it("parses MM/DD/YYYY", () => {
    expect(normDateISO("5/16/2026")).toBe("2026-05-16");
    expect(normDateISO("12/01/2026")).toBe("2026-12-01");
  });
  it("returns empty for missing or unparseable", () => {
    expect(normDateISO()).toBe("");
    expect(normDateISO("")).toBe("");
    expect(normDateISO("nonsense")).toBe("");
  });
});

describe("buildFixedColsTpl + buildColTpl", () => {
  it("returns all visible widths when nothing hidden", () => {
    const tpl = buildFixedColsTpl(new Set());
    expect(tpl).toContain("130px"); // poNum
    expect(tpl).toContain("160px"); // vendor
    expect(tpl).toContain("90px");  // ddp
  });
  it("zeros out hidden columns", () => {
    const tpl = buildFixedColsTpl(new Set(["poNum", "vendor"]));
    // 32 + 32 + 0 (poNum hidden) + 0 (vendor hidden) + 140 + 110 + 90 + 72
    expect(tpl).toBe("32px 32px 0px 0px 140px 110px 90px 72px");
  });
  it("appends N phase strips when phaseCount > 0", () => {
    const tpl = buildColTpl(2, new Set());
    // ends with two repeats of the phase template
    expect(tpl.split("88px 90px 82px 56px 26px").length).toBe(3);
  });
  it("returns just fixed cols when phaseCount = 0", () => {
    expect(buildColTpl(0, new Set())).toBe(buildFixedColsTpl(new Set()));
  });
});

describe("isSizeToken", () => {
  it("matches standard alpha sizes", () => {
    expect(isSizeToken("XS")).toBe(true);
    expect(isSizeToken("xs")).toBe(true);
    expect(isSizeToken("Small")).toBe(true);
    expect(isSizeToken("XL")).toBe(true);
    expect(isSizeToken("XXL")).toBe(true);
    expect(isSizeToken("2XL")).toBe(true);
    expect(isSizeToken("6XL")).toBe(true);
  });
  it("matches numeric sizes", () => {
    expect(isSizeToken("8")).toBe(true);
    expect(isSizeToken("32")).toBe(true);
    expect(isSizeToken("999")).toBe(true);
  });
  it("matches W/L/R suffixed sizes", () => {
    expect(isSizeToken("32W")).toBe(true);
    expect(isSizeToken("34L")).toBe(true);
    expect(isSizeToken("30R")).toBe(true);
  });
  it("rejects non-size tokens", () => {
    expect(isSizeToken("RED")).toBe(false);
    expect(isSizeToken("ABC")).toBe(false);
    expect(isSizeToken("")).toBe(false);
    expect(isSizeToken("1234")).toBe(false); // > 3 digits
  });
});

describe("styleColorKey", () => {
  it("strips trailing size token", () => {
    expect(styleColorKey("RYB059430-BLUE-32W", "")).toBe("RYB059430-BLUE");
    expect(styleColorKey("RYB059430-RED-XL", "")).toBe("RYB059430-RED");
  });
  it("leaves item number alone if no trailing size", () => {
    expect(styleColorKey("RYB059430-BLUE-FOO", "")).toBe("RYB059430-BLUE-FOO");
    expect(styleColorKey("STANDALONE", "")).toBe("STANDALONE");
  });
  it("falls back to description when no item number", () => {
    expect(styleColorKey("", "Blue Shirt")).toBe("Blue Shirt");
    expect(styleColorKey("", "")).toBe("");
  });
});

describe("itemSizeLabel", () => {
  it("extracts the trailing size token", () => {
    expect(itemSizeLabel("RYB-BLUE-32W")).toBe("32W");
    expect(itemSizeLabel("RYB-RED-XL")).toBe("XL");
  });
  it("returns empty when no trailing size", () => {
    expect(itemSizeLabel("RYB-BLUE-FOO")).toBe("");
    expect(itemSizeLabel("STANDALONE")).toBe("");
    expect(itemSizeLabel("")).toBe("");
  });
});

describe("sizeSort", () => {
  it("sorts numeric sizes ascending", () => {
    const out = ["32", "8", "12", "34"].sort(sizeSort);
    expect(out).toEqual(["8", "12", "32", "34"]);
  });
  it("sorts alpha sizes in standard order", () => {
    const out = ["XL", "S", "M", "XS", "L"].sort(sizeSort);
    expect(out).toEqual(["XS", "S", "M", "L", "XL"]);
  });
  it("alpha before unknown labels", () => {
    const out = ["FOO", "L", "BAR"].sort(sizeSort);
    expect(out[0]).toBe("L");
  });
  it("falls back to locale compare for unknowns", () => {
    expect(sizeSort("APPLE", "BANANA")).toBeLessThan(0);
  });
});
