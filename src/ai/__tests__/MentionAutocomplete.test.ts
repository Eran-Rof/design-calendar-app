// Pure-helper tests for the @mention trigger parsers (PR 2/4).
//
// The full React component (network calls + keyboard wiring) is
// integration-tested implicitly via panel manual QA — these tests
// pin the parsing rules that are easy to break silently when
// editing the regex/character logic.

import { describe, it, expect } from "vitest";
import {
  parseTrigger,
  parseStyleTrigger,
  expandMentionsForServer,
} from "../MentionAutocomplete";

describe("parseTrigger (@)", () => {
  it("matches at the start of input", () => {
    const t = parseTrigger("@ross", 5);
    expect(t).toEqual({ startIdx: 0, query: "ross", type: "customer" });
  });
  it("matches after a space", () => {
    const t = parseTrigger("show @bur", 9);
    expect(t).toEqual({ startIdx: 5, query: "bur", type: "customer" });
  });
  it("matches with no query (just the @)", () => {
    const t = parseTrigger("show @", 6);
    expect(t).toEqual({ startIdx: 5, query: "", type: "customer" });
  });
  it("returns null when @ is mid-word (e.g. an email)", () => {
    expect(parseTrigger("eran@ringoffire.com", 7)).toBeNull();
  });
  it("returns null when caret is past a closed token (whitespace inside breaks the token)", () => {
    // "show @ross stores" — caret at end is INSIDE "stores", token has no @.
    expect(parseTrigger("show @ross stores", 17)).toBeNull();
  });
  it("returns null with no @ at all", () => {
    expect(parseTrigger("how is burlington doing", 23)).toBeNull();
  });
  it("trims to the caret, ignoring text after it", () => {
    const t = parseTrigger("show @ross compared to last year", 10);
    expect(t).toEqual({ startIdx: 5, query: "ross", type: "customer" });
  });
});

describe("expandMentionsForServer", () => {
  function mapOf(entries: Array<[string, { id: string; type: "customer" | "style"; label: string }]>) {
    return new Map(entries);
  }

  it("expands an @customer mention to the id parenthetical form", () => {
    const m = mapOf([["Burlington_Coat_Factory", { id: "abc123", type: "customer", label: "Burlington Coat Factory" }]]);
    const out = expandMentionsForServer("Show @Burlington_Coat_Factory for last month", m);
    expect(out).toBe("Show Burlington Coat Factory (customer_id=abc123) for last month");
  });

  it("expands a #style mention to the style_code parenthetical form", () => {
    const m = mapOf([["RYB0412", { id: "RYB0412", type: "style", label: "RYB0412" }]]);
    const out = expandMentionsForServer("Margin on #RYB0412 LY", m);
    expect(out).toBe("Margin on RYB0412 (style_code=RYB0412) LY");
  });

  it("leaves tokens without a map entry untouched", () => {
    const out = expandMentionsForServer("Hi @unknown_thing", new Map());
    expect(out).toBe("Hi @unknown_thing");
  });

  it("does not cross-apply sigils — @ won't pick up a style entry and vice versa", () => {
    const m = mapOf([["RYB0412", { id: "RYB0412", type: "style", label: "RYB0412" }]]);
    expect(expandMentionsForServer("Show @RYB0412 now", m)).toBe("Show @RYB0412 now");
  });

  it("expands multiple tokens in one pass", () => {
    const m = mapOf([
      ["Burlington_Coat_Factory", { id: "abc", type: "customer", label: "Burlington Coat Factory" }],
      ["RYB0412",                  { id: "RYB0412", type: "style",    label: "RYB0412" }],
    ]);
    const out = expandMentionsForServer("@Burlington_Coat_Factory bought #RYB0412 in May", m);
    expect(out).toBe("Burlington Coat Factory (customer_id=abc) bought RYB0412 (style_code=RYB0412) in May");
  });
});

describe("parseStyleTrigger (#)", () => {
  it("matches a #style token", () => {
    const t = parseStyleTrigger("show #RYB0412", 13);
    expect(t).toEqual({ startIdx: 5, query: "RYB0412", type: "style" });
  });
  it("returns null when there's no #", () => {
    expect(parseStyleTrigger("show RYB0412", 12)).toBeNull();
  });
  it("returns null when # is mid-word", () => {
    expect(parseStyleTrigger("foo#bar", 7)).toBeNull();
  });
});
