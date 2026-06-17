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
  it("matches XXS, one-size and full-word alpha", () => {
    expect(isSizeToken("XXS")).toBe(true);
    expect(isSizeToken("OS")).toBe(true);
    expect(isSizeToken("OSFA")).toBe(true);
    expect(isSizeToken("ONE SIZE")).toBe(true); // spaces stripped
    expect(isSizeToken("Medium")).toBe(true);
  });
  it("matches kids / plus / youth sizes", () => {
    expect(isSizeToken("2T")).toBe(true);   // toddler
    expect(isSizeToken("12M")).toBe(true);  // infant months
    expect(isSizeToken("0-3M")).toBe(true); // month range
    expect(isSizeToken("1X")).toBe(true);   // women's plus
    expect(isSizeToken("3X")).toBe(true);
    expect(isSizeToken("YL")).toBe(true);   // youth
    expect(isSizeToken("10.5")).toBe(true); // half size
  });
  it("rejects non-size tokens", () => {
    expect(isSizeToken("RED")).toBe(false);
    expect(isSizeToken("ABC")).toBe(false);
    expect(isSizeToken("")).toBe(false);
    expect(isSizeToken("1234")).toBe(false); // > 3 digits
    expect(isSizeToken("NAVY")).toBe(false);
    expect(isSizeToken("7X")).toBe(false);   // out of plus range
  });
});

describe("styleColorKey", () => {
  it("strips trailing size token", () => {
    expect(styleColorKey("RYB059430-BLUE-32W", "")).toBe("RYB059430-BLUE");
    expect(styleColorKey("RYB059430-RED-XL", "")).toBe("RYB059430-RED");
    expect(styleColorKey("RYB0412-NAVY-2T", "")).toBe("RYB0412-NAVY");   // toddler
    expect(styleColorKey("RYB0412-BLACK-1X", "")).toBe("RYB0412-BLACK"); // plus
    expect(styleColorKey("RYB0412-WHITE-OS", "")).toBe("RYB0412-WHITE"); // one-size
  });
  it("strips parenthesised sizes that embed a dash", () => {
    // Real PO-WIP format: "S(7-8)" contains a dash, so a naive split shatters it.
    // All sizes of a style+color must collapse to the SAME group.
    expect(styleColorKey("100206796GK-Millie Wash-S(7-8)", "")).toBe("100206796GK-Millie Wash");
    expect(styleColorKey("100206796GK-Millie Wash-M(10-12)", "")).toBe("100206796GK-Millie Wash");
    expect(styleColorKey("100206796GK-Millie Wash-XL(18-20)", "")).toBe("100206796GK-Millie Wash");
    expect(styleColorKey("100221820BK-DRESS BLUES-L(14-16)", "")).toBe("100221820BK-DRESS BLUES");
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
  it("extracts a parenthesised size whole (dash and all)", () => {
    expect(itemSizeLabel("100206796GK-Millie Wash-S(7-8)")).toBe("S(7-8)");
    expect(itemSizeLabel("100206796GK-Millie Wash-XL(18-20)")).toBe("XL(18-20)");
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
