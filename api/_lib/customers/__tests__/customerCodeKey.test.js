import { describe, it, expect } from "vitest";
import { canonCodeKey, codeBareKey } from "../customerCodeKey.js";

describe("canonCodeKey", () => {
  it("uppercases and strips ALL whitespace (not just collapse)", () => {
    expect(canonCodeKey("Brig Surf Shop")).toBe("BRIGSURFSHOP");
    expect(canonCodeKey("  sun n sand ")).toBe("SUNNSAND");
  });
  it("preserves punctuation (matches legacy EXCEL: codes)", () => {
    expect(canonCodeKey("CSX Corp.")).toBe("CSXCORP.");
    expect(canonCodeKey("Surf, Wind, and Fir")).toBe("SURF,WIND,ANDFIR");
  });
  it("is null/undefined safe", () => {
    expect(canonCodeKey(null)).toBe("");
    expect(canonCodeKey(undefined)).toBe("");
  });
});

describe("codeBareKey", () => {
  it("drops the source prefix and strips whitespace", () => {
    expect(codeBareKey("EXCEL:BRIGSURFSHOP")).toBe("BRIGSURFSHOP");
    expect(codeBareKey("ATS:PURPLELEOPARDBOUTIQUE")).toBe("PURPLELEOPARDBOUTIQUE");
    expect(codeBareKey("XORO:FOO")).toBe("FOO");
  });
  it("collapses a legacy-forked spaced code to the same key as the clean one", () => {
    // This is the crux: the 2026-06-11 fork ("EXCEL:BRIG SURF SHOP") and the
    // original ("EXCEL:BRIGSURFSHOP") must reduce to one comparison key so the
    // in-memory dedup catches the match.
    expect(codeBareKey("EXCEL:BRIG SURF SHOP")).toBe(codeBareKey("EXCEL:BRIGSURFSHOP"));
    expect(codeBareKey("EXCEL:BRIG SURF SHOP")).toBe("BRIGSURFSHOP");
  });
  it("a Xoro name canon matches its stored legacy code", () => {
    // resolveCustomer flow: name key (canonCodeKey) must equal the stored
    // code's bare key so sales rows link to the existing customer.
    expect(canonCodeKey("BRIG SURF SHOP")).toBe(codeBareKey("EXCEL:BRIGSURFSHOP"));
  });
});
