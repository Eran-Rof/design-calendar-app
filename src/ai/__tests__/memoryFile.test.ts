// Tests for the memory-file generator (Tier 3L).

import { describe, it, expect } from "vitest";
import {
  slugify,
  normaliseBody,
  summariseForDescription,
  generateMemoryFile,
} from "../memoryFile";

describe("slugify", () => {
  it("lowercases + replaces whitespace with underscore", () => {
    expect(slugify("Burlington Coat Factory")).toBe("burlington_coat_factory");
  });
  it("strips non-alnum punctuation", () => {
    expect(slugify("RYB0412PPK24 (top seller!)")).toBe("ryb0412ppk24_top_seller");
  });
  it("falls back to 'fact' on empty input", () => {
    expect(slugify("")).toBe("fact");
    expect(slugify("___")).toBe("fact");
  });
  it("caps length", () => {
    const s = slugify("a".repeat(200));
    expect(s.length).toBeLessThanOrEqual(60);
  });
});

describe("normaliseBody", () => {
  it("trims trailing spaces from each line", () => {
    expect(normaliseBody("hello   \nworld   ")).toBe("hello\nworld");
  });
  it("collapses 3+ blank lines into 2", () => {
    expect(normaliseBody("a\n\n\n\nb")).toBe("a\n\nb");
  });
  it("trims overall whitespace", () => {
    expect(normaliseBody("\n\n  hi\n\n")).toBe("hi");
  });
});

describe("summariseForDescription", () => {
  it("returns the first sentence when present", () => {
    expect(summariseForDescription("First sentence here. Second one follows.")).toBe("First sentence here.");
  });
  it("falls back to a truncated chunk when no sentence terminator", () => {
    const long = "a".repeat(200);
    const out = summariseForDescription(long, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith("…")).toBe(true);
  });
  it("collapses internal whitespace", () => {
    expect(summariseForDescription("multi\nline\nfact")).toBe("multi line fact");
  });
});

describe("generateMemoryFile", () => {
  it("builds frontmatter + body with the standard memory-file shape", () => {
    const out = generateMemoryFile({
      topic: "RYB0412",
      fact: "RYB0412 is the top-selling jogger family. Surface the PPK24 variant alongside unit SKUs.",
      scope: "global",
      app: "ats",
      createdBy: "u-eran",
    });
    expect(out.filename).toBe("project_ai_fact_ryb0412.md");
    expect(out.content).toContain("---");
    expect(out.content).toContain("name: RYB0412");
    expect(out.content).toContain("type: project");
    expect(out.content).toContain("description: RYB0412 is the top-selling jogger family.");
    expect(out.content).toContain("**Topic:** RYB0412");
    expect(out.content).toContain("Visible to every operator (global).");
    expect(out.content).toContain("Scoped to app: ats");
    expect(out.content).toContain("Captured from Ask AI by u-eran");
  });

  it("defaults to scope=self when omitted", () => {
    const out = generateMemoryFile({ topic: "x", fact: "x." });
    expect(out.content).toContain("Operator-private (just-me scope).");
  });

  it("throws on empty topic or fact", () => {
    expect(() => generateMemoryFile({ topic: "", fact: "x" })).toThrow(/topic/);
    expect(() => generateMemoryFile({ topic: "x", fact: "" })).toThrow(/fact/);
    expect(() => generateMemoryFile({ topic: "x", fact: "   \n  " })).toThrow(/fact/);
  });

  it("filename slug truncates long topics", () => {
    const out = generateMemoryFile({ topic: "this is a really really long topic ".repeat(10), fact: "ok." });
    const slugPart = out.filename.replace(/^project_ai_fact_|\.md$/g, "");
    expect(slugPart.length).toBeLessThanOrEqual(60);
  });
});
