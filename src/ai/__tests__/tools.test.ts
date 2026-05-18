// Tests for the pure helpers in src/ai/tools.ts. The
// applySuggestion / applyAction / describeAction functions touch
// React setters and are exercised indirectly through the panel
// integration tests; here we focus on the data-shaping helpers
// (dedupePopular, fetchPopularPrompts) that have non-trivial logic
// + boundary cases worth pinning.

import { describe, it, expect, vi } from "vitest";
import { dedupePopular, fetchPopularPrompts } from "../tools";

// ────────────────────────────────────────────────────────────────────────
// dedupePopular
// ────────────────────────────────────────────────────────────────────────

describe("dedupePopular", () => {
  it("preserves order — first occurrence wins (highest hit_count)", () => {
    const out = dedupePopular([
      { question: "Open AR by status", hit_count: 50 },
      { question: "open ar by status", hit_count: 30 }, // lowercase dup
      { question: "Which Edge sold most?", hit_count: 20 },
    ], 10);
    expect(out).toEqual(["Open AR by status", "Which Edge sold most?"]);
  });

  it("deduplicates case + whitespace-insensitively", () => {
    const out = dedupePopular([
      { question: "  Question A  ", hit_count: 10 },
      { question: "QUESTION A",      hit_count: 5  },
      { question: "Question B",      hit_count: 3  },
    ], 10);
    expect(out).toEqual(["Question A", "Question B"]);
  });

  it("respects the limit", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      question: `Q${i}`,
      hit_count: 20 - i,
    }));
    expect(dedupePopular(rows, 3)).toEqual(["Q0", "Q1", "Q2"]);
  });

  it("drops empty / null / whitespace-only questions", () => {
    const out = dedupePopular([
      { question: null,    hit_count: 99 },
      { question: "",      hit_count: 50 },
      { question: "   ",   hit_count: 40 },
      { question: "Good",  hit_count: 10 },
    ], 10);
    expect(out).toEqual(["Good"]);
  });

  it("returns [] on empty input", () => {
    expect(dedupePopular([], 10)).toEqual([]);
  });

  it("handles missing hit_count gracefully", () => {
    const out = dedupePopular([
      { question: "A" },
      { question: "B", hit_count: null },
    ], 10);
    expect(out).toEqual(["A", "B"]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// fetchPopularPrompts
// ────────────────────────────────────────────────────────────────────────

describe("fetchPopularPrompts", () => {
  const fakeHeaders = { apikey: "k", Authorization: "Bearer k" };
  const fakeUrl     = "https://stub.supabase.co";

  it("returns [] when sbUrl is missing", async () => {
    const out = await fetchPopularPrompts({
      sbUrl: "",
      sbHeaders: fakeHeaders,
      fetchImpl: vi.fn(),
    });
    expect(out).toEqual([]);
  });

  it("requests the cache table sorted by hit_count desc with 3× limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { question: "A", hit_count: 5 },
        { question: "B", hit_count: 4 },
        { question: "C", hit_count: 3 },
      ],
    });
    await fetchPopularPrompts({
      limit: 5,
      sbUrl: fakeUrl,
      sbHeaders: fakeHeaders,
      fetchImpl: fetchMock,
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/rest/v1/ip_ai_answer_cache");
    expect(url).toContain("select=question,hit_count");
    expect(url).toContain("order=hit_count.desc");
    expect(url).toContain("limit=15"); // 5 × 3
  });

  it("returns the deduped + trimmed list on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { question: "Open AR by status", hit_count: 50 },
        { question: "OPEN AR BY STATUS", hit_count: 30 },
        { question: "Which Edge sold most?", hit_count: 20 },
      ],
    });
    const out = await fetchPopularPrompts({
      limit: 10,
      sbUrl: fakeUrl,
      sbHeaders: fakeHeaders,
      fetchImpl: fetchMock,
    });
    expect(out).toEqual(["Open AR by status", "Which Edge sold most?"]);
  });

  it("returns [] when the response is non-OK (so panel falls back to static)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => [] });
    const out = await fetchPopularPrompts({
      sbUrl: fakeUrl, sbHeaders: fakeHeaders, fetchImpl: fetchMock,
    });
    expect(out).toEqual([]);
  });

  it("returns [] when fetch throws (network errors are swallowed)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network"));
    const out = await fetchPopularPrompts({
      sbUrl: fakeUrl, sbHeaders: fakeHeaders, fetchImpl: fetchMock,
    });
    expect(out).toEqual([]);
  });

  it("clamps the limit to [1, 20]", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });

    // Test upper clamp (over 20 → 20 → limit*3 = 60 in URL)
    await fetchPopularPrompts({
      limit: 999, sbUrl: fakeUrl, sbHeaders: fakeHeaders, fetchImpl: fetchMock,
    });
    expect((fetchMock.mock.calls[0][0] as string)).toContain("limit=60");

    // Test lower clamp (0 → 1 → limit*3 = 3 in URL)
    await fetchPopularPrompts({
      limit: 0, sbUrl: fakeUrl, sbHeaders: fakeHeaders, fetchImpl: fetchMock,
    });
    expect((fetchMock.mock.calls[1][0] as string)).toContain("limit=3");
  });

  it("sends apikey + bearer headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    await fetchPopularPrompts({
      sbUrl: fakeUrl,
      sbHeaders: { apikey: "AKEY", Authorization: "Bearer AKEY" },
      fetchImpl: fetchMock,
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({ apikey: "AKEY", Authorization: "Bearer AKEY" });
  });
});
